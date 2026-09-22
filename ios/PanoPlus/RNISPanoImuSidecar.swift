// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoImuSidecar — the SECOND attitude channel, recorded beside a live
// ARKit sweep so the two arms can be compared on THE SAME PIXELS.
//
// ── The confound this exists to remove ───────────────────────────────────
//
// "Which pose arm is better, ARKit or the decoupled IMU?" has never been
// answered, and the naive design — one sweep per arm — cannot answer it. The
// defect under study (band shear, wobble) is a FUNCTION OF HOW THE HAND MOVED,
// and the hand moves differently every time. Two sweeps differ in the arm AND
// in the motion, and nothing in either pack can separate them.
//
// So: record BOTH attitude channels during ONE sweep. ARKit's goes where it
// always went (`track.jsonl`'s `q`, written by RNISPanoCore from
// `RNISARFrameContext.poseRotation`); CoreMotion's comes here, into
// `attitude_imu.jsonl`, at the sensor's own rate and in the sensor's own
// timebase. The offline replay then runs the same frames twice, once per
// channel — same pixels, same timestamps, same hand motion, one variable.
//
// ── WHY THIS CAN RUN BESIDE ARKit, WHICH IS NOT AN ASSUMPTION HERE ───────
//
// ARKit and an `AVCaptureSession` cannot share the camera — that conflict is
// real, it is why `RNISPanoAvfSource` tears ARKit down, and it does NOT apply
// to this file. THE MOTION SENSOR IS NOT THE CAMERA. `CMMotionManager` opens
// no capture device; ARKit consumes the IMU internally through its own client
// and CoreMotion's device-motion service is multi-client by construction.
//
// AND IT IS ALREADY DONE IN THIS POD. `RNISPanoBasisCalibration` runs a
// `CMMotionManager` at 200 Hz WHILE a live ARSession feeds it reference
// attitude through the same plugin registry this file registers into — that is
// the device→camera basis calibration the operator ran on 2026-08-31 (777
// pairs, basis #8, 0.234°). A gesture that produced a usable calibration is a
// gesture in which both services ran. That is a measurement, not an argument.
//
// What is NOT settled by that precedent is the COST during a 60 fps sweep, so
// this file measures its own: the AR-thread nanoseconds it adds per frame
// (`arThreadNs`), the delivered motion rate against the requested one, and the
// pack's existing `droppedQueue` / `droppedBefore` / frame-interval columns are
// the frame-loss witness. Nothing here is claimed; the numbers ride the pack.
//
// ── OFF ⇒ NOT REGISTERED, WHICH IS STRONGER THAN "INERT" ─────────────────
//
// The AR arm is the shipped, field-validated producer and an experiment must
// not change it. So this does not add a branch to `RNISPanoPlusPlugin` — that
// file is UNTOUCHED. This is its OWN `RNISARFramePlugin`, registered by
// `PanoPlusBridge` only when the sweep asked for it, exactly the way
// `RNISPanoBasisCalibration` registers itself. With the flag off nothing is
// registered, the AR thread runs the same one plugin it always ran, and
// `meta.json` has no `imuSidecar` key at all.
//
// ── TWO TIMEBASES, NEVER SILENTLY CONVERTED ──────────────────────────────
//
// Every sample is written in ITS OWN domain and the domain is NAMED in the
// report. `CMDeviceMotion.timestamp` and `ARFrame.timestamp` are both
// documented as seconds since boot, which SHOULD make them one clock — and
// "should" is exactly the word that has no place in an A/B. A conversion
// nobody can check is how a wrong comparison looks right, so this file applies
// none and instead records the evidence that decides it:
//
//   · the once-per-session clock triple (host clock / `CACurrentMediaTime` /
//     the first paired AR-frame + newest-IMU timestamps), and
//   · a per-channel DELIVERY LATENCY series — `now − ts` at the moment each
//     channel hands us a sample. Two channels on one clock give two small,
//     same-signed latencies; two channels on different epochs give one
//     latency of seconds, which is unmissable rather than subtle.
//
// The AVF arm closed the same question for the capture clock by reference
// identity (`CaptureClockProbe`'s `sessionClockIsHostClock`). There is no
// ARKit equivalent to compare against — ARKit publishes no clock object — so
// here it is measured, not asserted.
//
// ── RAW SAMPLES ARE THE POINT ────────────────────────────────────────────
//
// Nothing is aligned, rotated or resampled on the way to disk. τ and the basis
// are the two numbers the decoupled arm needs, and on the operator's phone τ
// never persisted (8 of 12 runs, 5.03 ms spread, the gate correctly refusing
// to write one). A pre-aligned quaternion would bake in whichever τ and basis
// happened to be on disk at capture time and the offline replay could never
// sweep them. Raw samples can be swept; a quaternion cannot be un-rotated back
// into one. What WAS on disk at capture time is recorded in the report block
// beside the samples, as provenance — never as an application.
//
// ── Threading ────────────────────────────────────────────────────────────
//
//   · The motion handler runs on our own serial `OperationQueue` and is the
//     ONLY writer of the file. It formats one line and `fwrite`s it into a
//     64 KB buffered `FILE *` — a memcpy in the common case, a flush every
//     ~700 samples. No dispatch per sample, so the sample path allocates one
//     `String` and nothing else.
//   · `process(_:)` runs on the ARKit delegate thread, once per frame, and
//     touches only counters under `lock`. It never writes the file and never
//     blocks — the plugin contract this pod's other two plugins honour.
//   · `lock` guards every field. `start`/`stop` come from the bridge's work
//     queue, the counters from two other threads.

// ⚠ THIS GUARD COVERS CoreMotion ONLY, AND IT IS NOT THE FILE'S ONLY
// DEPENDENCY.  Everything below also needs RNImageStitcher — the import on the
// next few lines, the `RNISARFramePlugin` conformance, the `RNISARFrameContext`
// parameter and the registry calls — and that dependency is deliberately
// UNGUARDED: it is a hard requirement, so a missing module must be a compile
// error, never a class that silently compiles out.  On iOS `canImport
// (CoreMotion)` is always true, so this condition never actually excludes
// anything; it is kept because the file owns a `CMMotionManager` and the
// package's convention is to name the system framework a file depends on.
#if canImport(CoreMotion)

import CoreMedia
import CoreMotion
import Foundation
import QuartzCore

@objc(RNISPanoImuSidecar)
public final class RNISPanoImuSidecar: NSObject, RNISARFramePlugin {

    @objc public static let shared = RNISPanoImuSidecar()

    /// Registry key.  Deliberately NOT `sweep`: that key is the
    /// live status channel JS reads, and a second plugin answering under it
    /// would overwrite the HUD payload.
    @objc public static let pluginName = "sweepImuSidecar"

    /// The sidecar's file, beside `track.jsonl` in the pack.
    @objc public static let fileName = "attitude_imu.jsonl"

    /// Requested motion rate.  `CMMotionManager` exposes only a REQUESTED
    /// interval and silently clamps it, so we ask for more than exists and
    /// report what actually arrived — the discipline `RNISPanoAvfSource`,
    /// `RNISPanoBasisCalibration` and `CaptureClockProbe` already follow.
    private static let requestedMotionHz = 200.0

    /// The CoreMotion reference frame, NAMED in the pack rather than implied.
    ///
    /// `.xArbitraryZVertical`, matching the capture arm and the basis
    /// calibration EXACTLY. Two reasons, and the second is the load-bearing
    /// one: the magnetometer injects yaw STEPS as it re-converges mid-sweep,
    /// and a basis fitted under one reference frame and replayed under another
    /// differs by precisely the arbitrary yaw datum `B` that is supposed to
    /// cancel in `dR = R₀ᵀ·Rᵢ`.
    private static let referenceFrameName = "xArbitraryZVertical"

    private let motionManager = CMMotionManager()
    private let lock = NSLock()

    // ── Lifecycle ────────────────────────────────────────────────────────
    private var armed = false
    private var fp: UnsafeMutablePointer<FILE>? = nil
    private var filePath: String = ""

    // ── Motion-channel counters ──────────────────────────────────────────
    private var samples: Int64 = 0
    private var samplesDropped: Int64 = 0      // non-finite or out of order
    private var writeFailures: Int64 = 0
    private var firstSampleS: Double = .nan
    private var lastSampleS: Double = .nan
    /// Delivery latency of the motion channel: `CACurrentMediaTime() − ts`.
    private var imuLatSumS: Double = 0
    private var imuLatMinS: Double = .infinity
    private var imuLatMaxS: Double = -.infinity
    private var imuLatCount: Int64 = 0

    // ── AR-channel counters, written on the ARKit delegate thread ────────
    private var arFrames: Int64 = 0
    private var arFramesBeforeFirstSample: Int64 = 0
    private var firstArFrameS: Double = .nan
    private var lastArFrameS: Double = .nan
    /// Delivery latency of the AR channel: `CACurrentMediaTime() − ts`.
    private var arLatSumS: Double = 0
    private var arLatMinS: Double = .infinity
    private var arLatMaxS: Double = -.infinity
    private var arLatCount: Int64 = 0
    /// `arFrameTs − newestImuTs` at the instant the frame was delivered.  The
    /// number that says whether the IMU leads or trails the frames, and by how
    /// much — the offline replay's bracket depends on it being small.
    private var arMinusImuSumS: Double = 0
    private var arMinusImuMinS: Double = .infinity
    private var arMinusImuMaxS: Double = -.infinity
    private var arMinusImuCount: Int64 = 0
    /// THE COST, MEASURED RATHER THAN ARGUED.  Nanoseconds this plugin spent
    /// on the ARKit delegate thread, summed and peak.
    private var arThreadNsSum: Double = 0
    private var arThreadNsMax: Double = 0

    // ── The once-per-session clock observation ───────────────────────────
    private var clockPairing: [String: Any]? = nil

    /// The τ / basis state read off the calibration store AT START, as
    /// PROVENANCE.  Nothing here is applied to anything.
    private var calibrationBlock: [String: Any] = [:]

    private override init() { super.init() }

    // MARK: - Plugin

    public func name() -> String { Self.pluginName }

    public func process(_ context: RNISARFrameContext) -> [String: Any]? {
        let t0 = CACurrentMediaTime()
        let ts = context.timestampNs / 1e9

        lock.lock()
        guard armed else { lock.unlock(); return nil }
        arFrames += 1
        if firstArFrameS.isNaN { firstArFrameS = ts }
        lastArFrameS = ts
        let lat = t0 - ts
        if lat.isFinite {
            arLatSumS += lat
            arLatCount += 1
            if lat < arLatMinS { arLatMinS = lat }
            if lat > arLatMaxS { arLatMaxS = lat }
        }
        if lastSampleS.isNaN {
            // No IMU sample has landed yet.  Counted, never folded into the
            // offset statistic as a zero — a frame the IMU could not describe
            // is a frame the replay must drop, not one that aligned perfectly.
            arFramesBeforeFirstSample += 1
        } else {
            let d = ts - lastSampleS
            arMinusImuSumS += d
            arMinusImuCount += 1
            if d < arMinusImuMinS { arMinusImuMinS = d }
            if d > arMinusImuMaxS { arMinusImuMaxS = d }
            if clockPairing == nil {
                // ── THE ONCE-PER-SESSION PAIRING ──────────────────────
                // Taken on the FIRST frame that has an IMU sample to pair
                // with, so all four numbers describe one instant.  It is the
                // only place a raw cross-channel comparison is recorded, and
                // it is recorded as four independent readings rather than as
                // one derived offset — a difference a reader can re-derive is
                // worth more than one they have to trust.
                clockPairing = [
                    "arFrameTsS": ts,
                    "newestImuTsS": lastSampleS,
                    "caCurrentMediaTimeS": t0,
                    "hostClockS": CMClockGetTime(CMClockGetHostTimeClock()).seconds,
                    "arFrameMinusNewestImuMs": d * 1000.0,
                    "note":
                        "FOUR READINGS AT ONE INSTANT, NOT A CONVERSION. "
                      + "ARFrame.timestamp and CMDeviceMotion.timestamp are both "
                      + "documented as seconds since boot, i.e. the CACurrentMediaTime "
                      + "domain; this pack does not assume it. Compare hostClockS with "
                      + "caCurrentMediaTimeS (one clock ⇒ equal to the read spacing), "
                      + "then read latency.arMs and latency.imuMs: two channels on one "
                      + "clock give two small same-signed delivery latencies, two "
                      + "channels on different epochs give one of seconds. No sample in "
                      + "attitude_imu.jsonl has been converted into any other domain.",
                ]
            }
        }
        let elapsedNs = (CACurrentMediaTime() - t0) * 1e9
        arThreadNsSum += elapsedNs
        if elapsedNs > arThreadNsMax { arThreadNsMax = elapsedNs }
        lock.unlock()
        // nil, deliberately: the sync status channel belongs to
        // `RNISPanoPlusPlugin` and this plugin must not add a key to the
        // `onArFrame` meta the HUD parses.
        return nil
    }

    // MARK: - Start

    /// Arm the recorder for a sweep and register it on the AR thread.
    ///
    /// ALWAYS RETURNS A REPORT, never throws: a sidecar that cannot open its
    /// file must not fail a sweep the operator is standing in an aisle to
    /// take. `armed: false` with a named `reason` is the failure mode, and it
    /// rides `meta.json` exactly like a success does.
    @discardableResult
    @objc public func start(sessionDir: String, arLens: String) -> [String: Any] {
        // The two stateless refusals first, so nothing has to be unwound.
        guard motionManager.isDeviceMotionAvailable else {
            return ["armed": false, "reason": "no-device-motion",
                    "detail": "CoreMotion reports no device-motion support on this "
                            + "hardware, so there is no second attitude channel to "
                            + "record. The sweep runs unchanged on ARKit."]
        }
        guard !sessionDir.isEmpty else {
            return ["armed": false, "reason": "no-session-dir"]
        }

        // ⚠ CLAIM AND CHECK IN ONE ACQUISITION.  A check that releases the
        // lock before the set is a TOCTOU, and the harm is not theoretical:
        // two starts that both passed would both `startDeviceMotionUpdates`
        // and only one would ever be stopped, leaving CoreMotion running at
        // 200 Hz for the life of the process — the exact leak class this pod
        // has already been bitten by on the AVF arm and on the calibration
        // recorder.  `panoplus-busy` normally makes this unreachable; a claim
        // that depends on another layer's guard is not a claim.
        lock.lock()
        if armed { lock.unlock(); return ["armed": false, "reason": "already-recording"] }
        armed = true
        resetCountersLocked()
        lock.unlock()

        let path = (sessionDir as NSString).appendingPathComponent(Self.fileName)
        guard let f = fopen(path, "wb") else {
            // The claim is RELEASED, not left standing: a sweep that could not
            // open its file must leave the next one able to try.
            lock.lock(); armed = false; lock.unlock()
            return ["armed": false, "reason": "file-open-failed", "path": path]
        }
        // 64 KB, matching the pack writers in RNISPanoCore: at 200 Hz and ~90
        // bytes a line that is a flush roughly every 3.5 s, so the motion queue
        // does a memcpy on essentially every sample.
        setvbuf(f, nil, _IOFBF, 1 << 16)

        let calib = Self.calibrationProvenance(arLens: arLens)

        lock.lock()
        fp = f
        filePath = path
        calibrationBlock = calib
        lock.unlock()

        startMotion()
        RNISARPluginRegistry.shared.register(self)

        return [
            "armed": true,
            "file": Self.fileName,
            "path": path,
            "referenceFrame": Self.referenceFrameName,
            "requestedMotionHz": Self.requestedMotionHz,
            "calibration": calib,
        ]
    }

    private func startMotion() {
        motionManager.deviceMotionUpdateInterval = 1.0 / Self.requestedMotionHz
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        motionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: q) {
            [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            let now = CACurrentMediaTime()
            let a = dm.userAcceleration
            // CoreMotion reports `userAcceleration` in G; the decoupled arm's
            // lurch cage is in m/s², and this column has to be the SAME
            // quantity or the offline replay cannot re-run that cage.
            let accelMps2 =
                (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot() * 9.80665
            let quat = dm.attitude.quaternion

            // ⚠ FORMATTED BEFORE THE LOCK IS TAKEN, and the ordering is the
            // point.  Everything this line needs is a local, and `String(
            // format:)` allocates — holding the lock across it would put a
            // few microseconds of allocation between the ARKit delegate
            // thread and a lock it wants 60 times a second.  The hold below
            // is now the counter arithmetic plus one buffered `fputs`, i.e.
            // a memcpy.  The cost is formatting the occasional line for a
            // sample the monotonicity guard then drops, which is rare and
            // cheap; the thing being protected is the one thread in this
            // process whose stall costs tracking for every plugin.
            //
            // %.9f throughout: nanosecond resolution on an uptime-domain
            // timestamp, and 1e-9 on a unit quaternion is three orders below
            // the sensor's own noise floor.
            // `rotationRate` added 2026-09-22: this row is the AR arm's only
            // motion record, and the shipped lateral guard (`usePanMotion.ts`)
            // is an EMA of `|gyro.x|` that runs on iOS too. Without the rate
            // column the guard can only be RECONSTRUCTED from attitude
            // differences — on Android four such reconstructions of one sweep
            // disagreed by 10x (0.046 to 0.533). It costs three floats on a
            // line that is already being formatted.
            let rate = dm.rotationRate
            let line = String(
                format: "{\"tsS\":%.9f,\"qx\":%.9f,\"qy\":%.9f,\"qz\":%.9f,"
                      + "\"qw\":%.9f,\"accelMps2\":%.6f,"
                      + "\"rotationRate\":[%.9f,%.9f,%.9f]}\n",
                dm.timestamp, quat.x, quat.y, quat.z, quat.w, accelMps2,
                rate.x, rate.y, rate.z)

            self.lock.lock()
            guard self.armed, let f = self.fp else { self.lock.unlock(); return }
            // Non-finite or out-of-order samples are DROPPED AND COUNTED, on
            // the same rule the aligner uses. A monotone file is what lets the
            // replay bracket by binary search instead of scanning.
            guard dm.timestamp.isFinite, quat.x.isFinite, quat.y.isFinite,
                  quat.z.isFinite, quat.w.isFinite,
                  self.lastSampleS.isNaN || dm.timestamp > self.lastSampleS
            else {
                self.samplesDropped += 1
                self.lock.unlock()
                return
            }
            if self.firstSampleS.isNaN { self.firstSampleS = dm.timestamp }
            self.lastSampleS = dm.timestamp
            self.samples += 1
            let lat = now - dm.timestamp
            if lat.isFinite {
                self.imuLatSumS += lat
                self.imuLatCount += 1
                if lat < self.imuLatMinS { self.imuLatMinS = lat }
                if lat > self.imuLatMaxS { self.imuLatMaxS = lat }
            }
            // THE WRITE STAYS UNDER THE LOCK: `stop()` closes this `FILE *`,
            // and a write racing that close is a use-after-free on the path
            // that fires every time the operator ends a sweep.
            if fputs(line, f) == EOF { self.writeFailures += 1 }
            self.lock.unlock()
        }
    }

    // MARK: - Stop

    /// Unregister, stop motion, close the file, and return the block that goes
    /// into `meta.json`.  Idempotent — `stop`, `cancel` and `invalidate` all
    /// reach it, and a second call returns `ran: false`.
    @discardableResult
    @objc public func stop() -> [String: Any] {
        lock.lock()
        let was = armed
        armed = false
        lock.unlock()
        guard was else { return ["ran": false] }

        RNISARPluginRegistry.shared.unregister(Self.pluginName)
        motionManager.stopDeviceMotionUpdates()

        lock.lock()
        if let f = fp { fflush(f); fclose(f); fp = nil }
        let report = buildReportLocked()
        lock.unlock()
        return report
    }

    // MARK: - The report

    private func buildReportLocked() -> [String: Any] {
        let span = lastSampleS - firstSampleS
        let arSpan = lastArFrameS - firstArFrameS
        // ⚠ THE NULLABLE FIELDS ARE ASSIGNED AFTER THE LITERAL, not inside
        // it.  A `cond ? Double : NSNull()` inside a dictionary literal makes
        // Swift unify the two branches; the assignment form coerces through
        // the subscript's `Any` instead.  This is the shape RNISPanoAvfSource
        // already uses for `deliveredMotionHz`, kept identical on purpose.
        var out: [String: Any] = [
            "ran": true,
            "file": Self.fileName,
            "path": filePath,
            // ── THE REFERENCE FRAME, NAMED ────────────────────────────
            // Not decoration: a replay that applies the stored basis under a
            // different CoreMotion reference frame is out by exactly the
            // arbitrary yaw datum the basis fit assumed cancels.
            "referenceFrame": Self.referenceFrameName,
            "referenceFrameNote":
                "CMAttitudeReferenceFrame.xArbitraryZVertical — the SAME frame "
              + "RNISPanoAvfSource sweeps in and RNISPanoBasisCalibration fitted the "
              + "device→camera basis in. Magnetometer-referenced frames were rejected: "
              + "yaw re-convergence injects steps mid-sweep. The arbitrary yaw datum B "
              + "cancels in dR = R0^T*Ri, which is the only rotation that reaches the "
              + "geometry — but ONLY if the replay uses this frame too.",
            "requestedMotionHz": Self.requestedMotionHz,
            "samples": samples,
            "samplesDropped": samplesDropped,
            "writeFailures": writeFailures,
            "arFrames": arFrames,
            "arFramesBeforeFirstSample": arFramesBeforeFirstSample,
            "calibration": calibrationBlock,
        ]
        // MEASURED, not requested.  `CMMotionManager` clamps silently, so the
        // requested rate is a request and this is the observation.  NSNull
        // when fewer than two samples arrived: one sample gives no interval,
        // and reporting 0 Hz for it would be a measurement nobody took.
        out["deliveredMotionHz"] =
            (samples > 1 && span > 0) ? Double(samples - 1) / span : NSNull()
        out["deliveredArFps"] =
            (arFrames > 1 && arSpan > 0) ? Double(arFrames - 1) / arSpan : NSNull()
        out["firstSampleTsS"] = firstSampleS.isNaN ? NSNull() : firstSampleS
        out["lastSampleTsS"] = lastSampleS.isNaN ? NSNull() : lastSampleS
        out["firstArFrameTsS"] = firstArFrameS.isNaN ? NSNull() : firstArFrameS
        out["lastArFrameTsS"] = lastArFrameS.isNaN ? NSNull() : lastArFrameS
        // ── THE TIMEBASE EVIDENCE ─────────────────────────────────────
        // Explicit if-let rather than `?? NSNull()`: the coalescing form on a
        // `[String: Any]?` has to be spelled `as Any? ?? NSNull()` to keep its
        // nil-ness, and the double-optional trap that hides behind that spelling
        // is not worth the one saved line on a field that means "the two clocks
        // were never observed together".
        if let pairing = clockPairing {
            out["clockPairing"] = pairing
        } else {
            out["clockPairing"] = NSNull()
        }
        out["latency"] = [
            "arMs": Self.statBlock(sum: arLatSumS, count: arLatCount,
                                   minV: arLatMinS, maxV: arLatMaxS),
            "imuMs": Self.statBlock(sum: imuLatSumS, count: imuLatCount,
                                    minV: imuLatMinS, maxV: imuLatMaxS),
            "arFrameMinusNewestImuMs": Self.statBlock(
                sum: arMinusImuSumS, count: arMinusImuCount,
                minV: arMinusImuMinS, maxV: arMinusImuMaxS),
            "note":
                "DELIVERY latency (CACurrentMediaTime at the callback minus the "
              + "channel's own timestamp), NOT alignment error — a frame that arrives "
              + "late but carries an honest timestamp costs alignment nothing. It is "
              + "here as the timebase evidence: two channels on one clock give two "
              + "small same-signed latencies. arFrameMinusNewestImuMs is a different "
              + "quantity again — how far the newest IMU sample trails the frame at "
              + "delivery — and a positive value means the replay must HOLD, never "
              + "extrapolate, exactly as RNISPanoAttitude does on the decoupled arm.",
        ]
        // ── THE COST, ON THE THREAD THAT CANNOT AFFORD IT ─────────────
        var arThread: [String: Any] = ["totalMs": arThreadNsSum / 1e6]
        arThread["mean"] = arFrames > 0 ? arThreadNsSum / Double(arFrames) : NSNull()
        arThread["max"] = arFrames > 0 ? arThreadNsMax : NSNull()
        arThread["note"] =
                "what THIS plugin added to the ARKit delegate thread, per frame. It "
              + "is the direct cost only; the CoreMotion service itself runs on its "
              + "own queue. Read it against the pack's droppedQueue / droppedBefore "
              + "and the track.jsonl frame intervals — those are the frame-loss "
              + "witness, and this number alone cannot stand in for them."
        out["arThreadNs"] = arThread
        out["armNote"] =
            "AR ARM ONLY, and that is not a limitation but the design: track.jsonl "
          + "carries ARKit's world←cam quaternion for these very frames, and this file "
          + "carries CoreMotion's raw attitude over the same interval. Replaying the "
          + "same frames once per channel is a CONTROLLED A/B — same pixels, same "
          + "timestamps, same hand motion, one variable. On the decoupled arm the "
          + "comparison is impossible in principle: ARKit is torn down and there is no "
          + "second channel to record."
        return out
    }

    /// Min / mean / max in MILLISECONDS, or nulls when nothing was observed.
    /// Never a zero: an unobserved statistic and a measured zero are different
    /// facts, and the whole point of this block is that a reader can tell.
    private static func statBlock(sum: Double, count: Int64,
                                  minV: Double, maxV: Double) -> [String: Any] {
        guard count > 0, minV.isFinite, maxV.isFinite else {
            return ["n": count,
                    "min": NSNull(), "mean": NSNull(), "max": NSNull()]
        }
        return ["n": count,
                "min": minV * 1000.0,
                "mean": (sum / Double(count)) * 1000.0,
                "max": maxV * 1000.0]
    }

    // MARK: - Provenance

    /// WHAT WAS ON DISK AT CAPTURE TIME — read, recorded, and applied to
    /// nothing.
    ///
    /// ⚠ THE TWO HALVES HAVE DIFFERENT ANSWERS ON THIS ARM, and collapsing
    /// them into one "calibrated / not" verdict would throw away the half that
    /// really was measured:
    ///
    ///   · THE BASIS applies, and applies unusually well. `RNISPanoBasis-
    ///     Calibration` fitted `C` against `RNISARFrameContext.poseRotation`
    ///     delivered through this same plugin registry — i.e. against exactly
    ///     the quantity `track.jsonl` records on this arm. It is model-keyed,
    ///     so no format question arises.
    ///   · τ DOES NOT APPLY AT ALL, and not because none was stored. On the
    ///     ARKit arm attitude arrives ON the ARFrame: same object, same
    ///     timestamp, offset zero by construction. There is no camera↔IMU
    ///     offset in the shipped path to correct. Any τ in the store was
    ///     measured on an AVFoundation format under a `model|lens|WxH|fps` key
    ///     that no ARKit sweep can match, so it is reported as evidence of what
    ///     was on disk and explicitly NOT as a number this sweep could use.
    ///
    /// The offset that DOES matter here is a new one — ARKit's frame timestamp
    /// against CoreMotion's sample timestamp — and it is exactly what the raw
    /// samples let the offline replay sweep for.
    private static func calibrationProvenance(arLens: String) -> [String: Any] {
        // The store's basis key is the device model alone, so the lens and
        // format arguments cannot affect the half we read.  They are passed
        // honestly anyway (the AR arm's own lens, and zeros for a format this
        // arm does not choose) so the recorded `tauKey` shows plainly that it
        // is not a key any stored τ could sit under.
        let r = RNISPanoCalibStore.shared.resolve(
            lens: arLens, width: 0, height: 0, fps: 0)
        return [
            "basis": [
                "have": r["haveBasis"] ?? false,
                "key": r["basisKey"] ?? NSNull(),
                "index": r["basisIndex"] ?? NSNull(),
                "label": r["basisLabel"] ?? NSNull(),
                "measuredAt": r["basisMeasuredAt"] ?? NSNull(),
                "applied": false,
                "note":
                    "READ AND RECORDED, APPLIED TO NOTHING — the samples on disk are "
                  + "raw. It is here because it is the basis the offline replay should "
                  + "start from, and because this pack can FALSIFY it: both channels "
                  + "describe the same frames, so C can be re-fitted from the pack "
                  + "itself and checked against this stored index.",
            ],
            "tau": [
                "applied": false,
                "applicable": false,
                "storeKeyProbed": r["tauKey"] ?? NSNull(),
                "reason": "arkit-attitude-is-on-the-frame",
                "note":
                    "NO τ APPLIES ON THIS ARM. ARKit delivers attitude on the ARFrame "
                  + "itself — same object, same timestamp — so there is no camera↔IMU "
                  + "offset in the path track.jsonl records. Any τ in the on-device "
                  + "store was measured on an AVFoundation format and is keyed "
                  + "model|lens|WxH|fps, which no ARKit sweep matches; the key probed "
                  + "above is shown so that is checkable rather than asserted. The "
                  + "offset that DOES exist here — ARKit's frame clock against "
                  + "CoreMotion's sample clock — is unmeasured at capture time, which "
                  + "is why the samples are raw: the replay sweeps τ and basis, and a "
                  + "pre-aligned quaternion cannot be swept.",
            ],
        ]
    }

    private func resetCountersLocked() {
        samples = 0; samplesDropped = 0; writeFailures = 0
        firstSampleS = .nan; lastSampleS = .nan
        imuLatSumS = 0; imuLatMinS = .infinity; imuLatMaxS = -.infinity
        imuLatCount = 0
        arFrames = 0; arFramesBeforeFirstSample = 0
        firstArFrameS = .nan; lastArFrameS = .nan
        arLatSumS = 0; arLatMinS = .infinity; arLatMaxS = -.infinity
        arLatCount = 0
        arMinusImuSumS = 0; arMinusImuCount = 0
        arMinusImuMinS = .infinity; arMinusImuMaxS = -.infinity
        arThreadNsSum = 0; arThreadNsMax = 0
        clockPairing = nil
        calibrationBlock = [:]
    }
}

#endif
