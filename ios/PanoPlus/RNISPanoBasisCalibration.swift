// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoBasisCalibration — the GESTURE half of the calibration step.
//
// It logs CoreMotion attitude BESIDE a live ARKit session and lets
// `rnis::pano::selectBasis` pick the device→camera basis `C` from data.  That
// is possible for one structural reason, stated in the attitude seam's header
// and worth repeating here: THE MOTION SENSOR DOES NOT TOUCH THE CAMERA.  τ has
// to fight AVFoundation for the camera; this does not fight anybody.
//
// ── WHY THE REFERENCE IS A FRAME PLUGIN AND NOT A PRIVATE ARSession ──────
//
// `RNISPanoPlusPlugin` feeds the engine `RNISARFrameContext.poseRotation`.  `C`
// is DEFINED by what the engine consumes, so the reference must be that exact
// quantity through that exact path.  A private `ARSession` would (a) introduce
// a convention that has to be argued instead of observed, and (b) not be able
// to run beside the app's own AR session anyway.  Registering into
// `RNISARPluginRegistry` costs the AR thread one array append per frame.
//
// ── THE GESTURE, AND WHY A CAREFUL PAN IS THE WORST ONE ──────────────────
//
// The prototype run proved a pure pan CANNOT identify `C`: a one-axis log
// leaves an EXACT 4-way tie (margin 9.86e-15 deg) and the tie-break silently
// returned the wrong candidate.  That is not a numerical near-miss; it is a
// theorem.  Writing the truth as `C₀` and a candidate as `C₀·A`, the residual
// vanishes for every observed increment iff `A` COMMUTES with all of them —
// and the rotations about a single axis `n` have a centraliser containing the
// quarter-turns about `n`, which are signed permutations.  Two independent axes
// generate all of SO(3), whose centraliser is {I}.
//
// So the calibration gesture is DELIBERATELY OFF-AXIS, it is COACHED ON SCREEN
// per named axis, and an insufficient gesture is REPORTED as insufficient with
// the axis named.  The operator is never silently fitted.
//
// ── WHAT IS REFUSED, AND WHY EACH REFUSAL IS A REFUSAL ───────────────────
//
//  * A pano+ sweep already running — the engine owns the frame path, and a
//    second recorder on the AR thread during a capture is a cost the sweep did
//    not agree to pay.
//  * No device motion — there is nothing to calibrate.
//  * ARKit not tracking NORMALLY — a `limited` pose is a guess, and averaging
//    guesses into the datum the whole basis is measured against is exactly how
//    a calibration comes back confident and wrong.  Those frames are DROPPED
//    AND COUNTED, never quietly used.
//
// ── Threading ────────────────────────────────────────────────────────────
//
// `process(_:)` runs on the ARKit delegate thread; the motion handler on its
// own `OperationQueue`.  Both do nothing but push into `RNISPanoCalibCore`,
// which owns the one lock.  The live excitation reduction is O(n) and would
// grow with the recording, so it runs on OUR OWN queue at 4 Hz and the AR
// thread only ever reads the cached dictionary — the plugin contract's
// "offload anything heavier than a few hundred microseconds", honoured rather
// than assumed.

// ⚠ THIS FILE IS DELIBERATELY UNCONDITIONAL — DO NOT WRAP IT IN A `#if`.
// PanoPlusCalibBridge.swift references `RNISPanoBasisCalibration` from six
// unguarded call sites.  Re-adding a condition here (for symmetry with
// RNISPanoImuSidecar.swift's CoreMotion guard, say) compiles this class out on
// the false branch and breaks that file with six "cannot find in scope"
// errors.  Both dependencies below are hard requirements; a missing module
// should be a compile error, not a silently absent class.

import CoreMotion
import Foundation
import QuartzCore

@objc(RNISPanoBasisCalibration)
public final class RNISPanoBasisCalibration: NSObject, RNISARFramePlugin {

    @objc public static let shared = RNISPanoBasisCalibration()

    @objc public static let pluginName = "sweepBasisCal"

    public struct StartFailure: Error {
        public let code: String
        public let detail: String
    }

    // MARK: - State

    private let motionManager = CMMotionManager()
    private let workQueue = DispatchQueue(label: "io.imagestitcher.rn.panoplus.basiscal")
    private let lock = NSLock()

    /// ⚠ EVERY FIELD BELOW IS GUARDED BY `lock`, INCLUDING THE TIMER.
    ///
    /// `liveTimer`, `startedAt` and `maxDurationS` were touched outside it
    /// until 2026-08-31: `startLiveTimer()` assigned the timer on the caller's
    /// queue, `stop()` and `stopWithoutSolving()` did `cancel(); = nil` on
    /// theirs, and the timer's own handler read `startedAt` and `maxDurationS`
    /// on `workQueue`.  The hard cap calls `stop()` from INSIDE that handler,
    /// so an operator pressing Finish at the 90 s mark put two paths through an
    /// unsynchronised read-modify-write on a `DispatchSourceTimer` reference —
    /// an over-release, on the one path (a dismissed panel) the cap exists for.
    ///
    /// The timer is now TAKEN under the lock, so exactly one caller can ever
    /// hold a non-nil reference to cancel, and the loser sees `armed == false`
    /// and returns.
    private var armed = false
    private var startedAt: CFTimeInterval = 0
    private var maxDurationS: Double = 90.0
    private var autoStopped = false
    private var cachedLive: [String: Any] = [:]
    private var liveTimer: DispatchSourceTimer?
    private var solved: [String: Any]? = nil

    /// Requested motion rate.  `CMMotionManager` exposes only a REQUESTED
    /// interval and silently clamps it, so we ask for more than exists and
    /// report what actually arrived — the same discipline `RNISPanoAvfSource`
    /// and `CaptureClockProbe` already follow.
    private static let requestedMotionHz = 200.0

    private override init() { super.init() }

    @objc public var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return armed
    }

    // MARK: - Plugin

    public func name() -> String { Self.pluginName }

    public func process(_ context: RNISARFrameContext) -> [String: Any]? {
        lock.lock()
        let live = armed
        let cached = cachedLive
        lock.unlock()
        guard live else { return nil }

        // A `limited` or `notAvailable` pose is not a reference.  Counted, not
        // used — and the count rides the record, so a calibration taken in a
        // featureless aisle cannot look like one taken in a good one.
        guard context.trackingState == "normal" else {
            RNISPanoCalibCore.noteRefRejectedForTracking()
            return cached.isEmpty ? nil : cached
        }
        let q = context.poseRotation
        guard q.count >= 4 else { return cached.isEmpty ? nil : cached }
        RNISPanoCalibCore.pushRef(atTimeS: context.timestampNs / 1e9,
                                  qx: q[0], qy: q[1], qz: q[2], qw: q[3])
        // The AR thread returns a CACHED dictionary.  Reducing here would put
        // an O(recording-length) pass on the one thread whose stall costs
        // tracking for every plugin in the registry.
        return cached.isEmpty ? nil : cached
    }

    // MARK: - Start

    /// Begin recording.  `options`:
    ///   maxDurationS  Double — hard cap, default 90.  A recorder left armed by
    ///                          a dismissed panel must stop on its own.
    ///   imuCap/refCap Int    — buffer caps, 0 ⇒ defaults.
    @discardableResult
    public func start(options: [String: Any]) throws -> [String: Any] {
        if isRunning {
            throw StartFailure(code: "basiscal-busy",
                               detail: "A basis calibration is already recording.")
        }
        // The engine owns the AR frame path during a sweep.
        if RNISPanoCore.isRunning() {
            throw StartFailure(
                code: "basiscal-sweep-running",
                detail: "A pano+ sweep is running. Finish or cancel it first — the "
                      + "calibration recorder must not add work to the AR thread "
                      + "during a capture.")
        }
        guard motionManager.isDeviceMotionAvailable else {
            throw StartFailure(
                code: "basiscal-no-device-motion",
                detail: "CoreMotion reports no device-motion support on this "
                      + "hardware, so there is no attitude to calibrate against.")
        }

        let requestedMaxDurationS =
            (options["maxDurationS"] as? NSNumber)?.doubleValue ?? 90.0
        let imuCap = (options["imuCap"] as? NSNumber)?.uintValue ?? 0
        let refCap = (options["refCap"] as? NSNumber)?.uintValue ?? 0
        RNISPanoCalibCore.beginRecording(imuCap: imuCap, refCap: refCap)

        lock.lock()
        armed = true
        autoStopped = false
        maxDurationS = requestedMaxDurationS
        startedAt = CACurrentMediaTime()
        cachedLive = [:]
        solved = nil
        lock.unlock()

        startMotion()
        startLiveTimer()
        RNISARPluginRegistry.shared.register(self)

        return [
            "started": true,
            "maxDurationS": requestedMaxDurationS,
            "requestedMotionHz": Self.requestedMotionHz,
            "plugin": Self.pluginName,
        ]
    }

    private func startMotion() {
        motionManager.deviceMotionUpdateInterval = 1.0 / Self.requestedMotionHz
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        // `.xArbitraryZVertical`, matching the capture arm exactly.  The
        // magnetometer's yaw re-convergence would inject steps into the very
        // series the basis is fitted from, and the arbitrary yaw datum costs
        // nothing: `B` cancels in `dR = R₀ᵀ·Rᵢ`, which is the only rotation the
        // fit — and the engine — ever sees.
        //
        // ⚠ IT MUST BE THE SAME REFERENCE FRAME THE SWEEP USES.  A basis fitted
        // under one reference frame and applied under another would differ by
        // exactly the `B` this argument says cancels.
        motionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: q) {
            [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            guard self.isRunning else { return }
            let a = dm.attitude.quaternion
            RNISPanoCalibCore.pushImu(atTimeS: dm.timestamp,
                                      qx: a.x, qy: a.y, qz: a.z, qw: a.w)
        }
    }

    private func startLiveTimer() {
        let t = DispatchSource.makeTimerSource(queue: workQueue)
        t.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            // ONE locked read of everything the handler needs.  `startedAt` and
            // `maxDurationS` were read unlocked here; `armed` was read through
            // `isRunning`, i.e. a SECOND lock acquisition that could see a
            // different state from the one the rest of the handler assumed.
            self.lock.lock()
            let live0 = self.armed
            let started = self.startedAt
            let maxDur = self.maxDurationS
            self.lock.unlock()
            guard live0 else { return }

            var live = RNISPanoCalibCore.liveExcitation()
            let elapsed = CACurrentMediaTime() - started
            live["elapsedS"] = elapsed
            live["maxDurationS"] = maxDur
            self.lock.lock()
            self.cachedLive = live
            self.lock.unlock()
            // The hard cap. A panel dismissed without pressing Finish must not
            // leave a plugin on the AR thread and CoreMotion running for the
            // rest of the process.
            if elapsed > maxDur {
                self.lock.lock(); self.autoStopped = true; self.lock.unlock()
                _ = self.stop()
            }
        }
        lock.lock(); liveTimer = t; lock.unlock()
        t.resume()
    }

    // MARK: - Live

    /// The coaching read, for the panel.  Safe from any queue.
    @objc public func liveStatus() -> [String: Any] {
        lock.lock()
        let live = armed
        var cached = cachedLive
        let auto = autoStopped
        lock.unlock()
        cached["recording"] = live
        cached["autoStopped"] = auto
        return cached
    }

    // MARK: - Stop

    /// Stop recording and SOLVE.  Always returns a payload; a recording too
    /// poor to fit comes back with its reason and its evidence, never silently.
    ///
    /// `tauS` is the offset between the ARKit and CoreMotion timebases used for
    /// the fit.  Both run on the system uptime clock, so 0 is the physical
    /// answer and the solve's own stability sweep is what turns that from an
    /// assumption into an observation.
    @discardableResult
    public func stop(tauS: Double = 0.0) -> [String: Any] {
        // ONE atomic take: the flag AND the timer, so exactly one caller can
        // ever cancel it.  Two concurrent stops (the 90 s auto-stop firing on
        // `workQueue` while the operator presses Finish on another queue) used
        // to race a `DispatchSourceTimer` reference here.
        lock.lock()
        let was = armed
        armed = false
        let auto = autoStopped
        let maxDur = maxDurationS
        let timer = liveTimer
        liveTimer = nil
        lock.unlock()

        timer?.cancel()
        // Only the winner tears down. The loser already found `was == false`
        // and must not unregister a plugin the winner is mid-way through
        // unregistering, nor stop motion updates a fresh `start()` just began.
        guard was else { return ["ran": false, "reason": "not-recording"] }
        RNISARPluginRegistry.shared.unregister(Self.pluginName)
        motionManager.stopDeviceMotionUpdates()

        // SOLVE BEFORE FREEING.  `endRecording()` is deliberately not called
        // here: the recording stays resident so the panel can re-solve at a
        // different τ without asking the operator to perform the gesture again.
        // `discard()` frees it, and `start()` frees it implicitly.
        var out = RNISPanoCalibCore.solveBasis(tauS: tauS, stabilityOffsetsS: nil)
        out["autoStopped"] = auto
        if auto {
            out["autoStopNote"] =
                "the recorder hit its \(Int(maxDur)) s cap and stopped itself"
        }
        lock.lock(); solved = out; lock.unlock()
        return out
    }

    /// Re-run the reduction on the SAME recording at a different τ.  Returns
    /// nil when nothing has been recorded.
    @objc public func resolve(tauS: Double) -> [String: Any] {
        return RNISPanoCalibCore.solveBasis(tauS: tauS, stabilityOffsetsS: nil)
    }

    /// Drop the recording and free its memory.
    @objc public func discard() {
        _ = stopWithoutSolving()
        RNISPanoCalibCore.endRecording()
        lock.lock(); solved = nil; cachedLive = [:]; lock.unlock()
    }

    /// The teardown half of `stop()` with no reduction — used by `discard()`
    /// and by the bridge's `invalidate()`, where a JS reload has already made
    /// the answer unreachable and computing it would only cost time.
    @discardableResult
    public func stopWithoutSolving() -> Bool {
        lock.lock()
        let was = armed
        armed = false
        let timer = liveTimer
        liveTimer = nil
        lock.unlock()
        timer?.cancel()
        if was {
            RNISARPluginRegistry.shared.unregister(Self.pluginName)
            motionManager.stopDeviceMotionUpdates()
        }
        return was
    }
}

