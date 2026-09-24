// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoImuArm — the CAMERA-INDEPENDENT half of pano+'s IMU pose arm (M5).
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────
//
// The IMU arm has two halves that were one class: a camera (an
// `AVCaptureSession` pano+ opened itself, in `RNISPanoAvfSource`) and an
// attitude source (CoreMotion at 200 Hz, the shared C++ aligner, the raw
// `sensors.jsonl` series, and the τ/basis provenance the pack must state).
// The vision-camera arm needs the SECOND half and must not have the first:
// vision-camera already owns the camera, and a second `AVCaptureSession` on
// the same device is the defect the whole unify-camera program retires.
//
// So the attitude half lives here, MOVED rather than rewritten — the motion
// callback, the sensor log, the alignment configuration, and the report
// composition are the code the AVF arm shipped, and the AVF arm now calls
// them. When the AVF camera is deleted (M6a), this file is what remains.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────
//
// It never ingests. A frame and its attitude meet in whichever producer holds
// the frame — `RNISPanoAvfSource.captureOutput` or the vision-camera plugin
// (`RNISPanoSweepFrameProcessor.mm`) — through `RNISPanoAttitude`, whose lock
// is the one place the two queues meet.

import CoreMotion
import Foundation

@objc(RNISPanoImuArm)
public final class RNISPanoImuArm: NSObject {

    @objc public static let shared = RNISPanoImuArm()

    /// A refusal before anything is opened. The code is the bridge's rejection
    /// code, the detail its message.
    public struct Failure: Error {
        public let code: String
        public let detail: String
    }

    /// Requested motion rate.  CMMotionManager exposes only a REQUESTED
    /// interval and silently clamps it, so we ask for more than exists and
    /// report what actually arrives (`deliveredMotionHz` below).
    public static let requestedMotionHz = 200.0

    private let motionManager = CMMotionManager()
    /// The queue the motion callback runs on — kept so `stopMotion` can wait
    /// for a callback already in flight before it closes the file.
    private var motionQueue: OperationQueue?

    /// Guards EVERY field written from the CoreMotion queue and read at stop:
    /// the acceleration magnitude, gravity, the motion counters and the file.
    /// One lock, because they are written in the same callback.
    private let motionLock = NSLock()
    private var lastAccelMagMps2: Double = .nan
    private var lastGravity: (x: Double, y: Double, z: Double)?
    private var motionSamples: Int64 = 0
    private var firstMotionS: Double = .nan
    private var lastMotionS: Double = .nan
    private var sessionDir: String = ""

    /// ── THE RAW MOTION SERIES, WRITTEN TO `sensors.jsonl` ────────────────
    ///
    /// Android has written `sensors.jsonl` on every sweep for months; this arm
    /// wrote NOTHING, so an iOS pack could not answer a question about its own
    /// motion. The specific casualty: the shipped lateral guard
    /// (`usePanMotion.ts`) is an EMA of `|gyro.x|` and it runs on iOS too, but
    /// no iOS pack carried a gyro trace — so what the guard actually saw on a
    /// capture was not measurable, only reconstructed. On Android four
    /// independent reconstructions of ONE sweep spanned 0.046 to 0.533.
    ///
    /// `dm.rotationRate` is the quantity that guard consumes and it was
    /// already in hand in the callback below, discarded every sample at 200 Hz.
    ///
    /// ⚠ NOT the magnetometer question. This arm is `.xArbitraryZVertical`
    /// and ARKit's default is `.gravity`, so BOTH iOS arms are mag-free and
    /// the compass contamination that makes Android's `crossRectifyDeg` ~90%
    /// heading correction cannot occur here.
    private var sensorsFp: UnsafeMutablePointer<FILE>?
    private var sensorRows: Int64 = 0
    private var sensorWriteFailed = false

    private override init() { super.init() }

    public var isDeviceMotionAvailable: Bool { motionManager.isDeviceMotionAvailable }

    /// The newest `|userAcceleration|` in m/s², or NaN before the first sample.
    public var latestAccelMagMps2: Double {
        motionLock.lock(); defer { motionLock.unlock() }
        return lastAccelMagMps2
    }

    /// The newest gravity vector in the DEVICE frame, in g — or nil before the
    /// first sample. Portrait upright reads ≈ (0, −1, 0).
    public var latestGravity: (x: Double, y: Double, z: Double)? {
        motionLock.lock(); defer { motionLock.unlock() }
        return lastGravity
    }

    /// Block until the first motion sample has arrived, or `timeoutS` passes.
    /// For a caller that must read gravity before it can configure anything.
    public func waitForFirstSample(timeoutS: Double) -> Bool {
        let deadline = Date().addingTimeInterval(timeoutS)
        while Date() < deadline {
            motionLock.lock()
            let have = motionSamples > 0
            motionLock.unlock()
            if have { return true }
            usleep(2_000)
        }
        motionLock.lock(); defer { motionLock.unlock() }
        return motionSamples > 0
    }

    // MARK: - The alignment configuration

    /// ── THE ALIGNMENT CONFIGURATION (moved from `RNISPanoAvfSource`) ─────
    ///
    /// ── AND THE ONE CONFIGURATION THAT STARTS WITHOUT A τ ────────────────
    /// `tauUncorrected` is the DELIBERATE τ = 0, UNMEASURED sweep
    /// (2026-08-31).  The BELT is here as well as in the bridge because this
    /// entry point is reachable from more than one producer, and an
    /// uncorrected sweep that sampled at a non-zero offset would be a run
    /// whose pack says the opposite of what it did.
    ///
    /// FORCED ONLY WHERE NOTHING CONTRADICTS IT.  When the caller ALSO
    /// supplied a real measured τ it is left exactly as it arrived, so
    /// `configure` refuses with `tau-mode-conflict` — overwriting one of two
    /// contradictory claims here is how the two states become
    /// indistinguishable in the pack, which is the whole defect class.
    ///
    /// ⚠ THE TEST IS THE SHARED C++ ONE, on the RAW bag, so this belt and the
    /// bridge's cannot drift apart.
    public static func configureAlignment(options: [String: Any]) throws {
        var alignOptions = options
        let uncorrectedTau =
            (options["tauUncorrected"] as? NSNumber)?.boolValue == true
        let rawTauNum = options["tauS"] as? NSNumber
        if uncorrectedTau,
           RNISPanoAttitude.uncorrectedOptionConflict(
               uncorrected: true,
               claimsMeasuredTau:
                   (options["tauMeasured"] as? NSNumber)?.boolValue ?? false,
               hasExplicitTau: rawTauNum != nil,
               tauS: rawTauNum?.doubleValue ?? 0.0) == "none" {
            alignOptions["tauS"] = 0.0
            alignOptions["tauMeasured"] = false
        }
        do {
            try RNISPanoAttitude.configure(options: alignOptions)
        } catch let e as NSError {
            throw Failure(code: "panoplus-alignment-unconfigured",
                          detail: e.localizedDescription)
        }
    }

    // MARK: - Motion

    /// Zero this arm's per-sweep state and the aligner's ring.  Called by the
    /// producer at start, BEFORE `startMotion`.
    public func resetForSweep(sessionDir: String) {
        motionLock.lock()
        self.sessionDir = sessionDir
        lastAccelMagMps2 = .nan
        lastGravity = nil
        motionSamples = 0; firstMotionS = .nan; lastMotionS = .nan
        motionLock.unlock()
        RNISPanoAttitude.clearAccelMagMps2()
        RNISPanoAttitude.reset()
    }

    public func startMotion() {
        // Availability is refused by every producer at start, before anything
        // is opened.  This guard stays as a belt: a silent return here was
        // what produced a live preview that could never paint.
        guard motionManager.isDeviceMotionAvailable else { return }
        motionManager.deviceMotionUpdateInterval = 1.0 / Self.requestedMotionHz
        // A FAILURE TO OPEN IS NEVER A FAILED SWEEP. The row is diagnostic;
        // an operator in an aisle must not lose a capture because a log file
        // could not be created. The refusal is recorded and the sweep runs.
        // ⚠ RESET THE COUNTERS WITH THE FILE, NOT JUST THE FILE.  This object
        // outlives a sweep, so a counter that is only ever incremented
        // accumulates across captures while `fopen(..., "w")` truncates — and
        // the pack then reports a row count larger than its own file. Measured
        // on three consecutive iPhone sweeps before this line: reported
        // 861 / 1298 / 1727 against 525 / 437 / 429 on disk.
        motionLock.lock()
        sensorRows = 0
        sensorWriteFailed = false
        if !sessionDir.isEmpty {
            let path = (sessionDir as NSString).appendingPathComponent("sensors.jsonl")
            sensorsFp = fopen(path, "w")
            if sensorsFp == nil { sensorWriteFailed = true }
        } else {
            sensorWriteFailed = true
        }
        motionLock.unlock()
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        motionQueue = q
        // `.xArbitraryZVertical`, NOT `.xTrueNorthZVertical`: the magnetometer
        // injects yaw STEPS mid-sweep as it re-converges, and a step in the
        // attitude is a step in the rectification.  The arbitrary yaw datum
        // costs nothing — it cancels exactly in `dR = R₀ᵀ·Rᵢ`, which is the
        // only rotation that reaches the geometry.
        motionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: q) {
            [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            let a = dm.userAcceleration
            // CoreMotion reports userAcceleration in G; the cage is in m/s².
            let magMps2 = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot() * 9.80665
            let g = dm.gravity
            self.motionLock.lock()
            self.lastAccelMagMps2 = magMps2
            self.lastGravity = (g.x, g.y, g.z)
            self.motionSamples += 1
            if self.firstMotionS.isNaN { self.firstMotionS = dm.timestamp }
            self.lastMotionS = dm.timestamp
            self.motionLock.unlock()
            // The vision-camera plugin's lurch cage reads this; the AVF arm
            // reads its own copy above.  Same number either way.
            RNISPanoAttitude.noteAccelMag(mps2: magMps2)

            let q = dm.attitude.quaternion
            RNISPanoAttitude.pushSample(atTimeS: dm.timestamp,
                                        qx: q.x, qy: q.y, qz: q.z, qw: q.w)

            // ── THE RAW ROW ──────────────────────────────────────────────
            // FORMATTED BEFORE THE LOCK: `String(format:)` allocates, and
            // holding the motion lock across an allocation puts microseconds
            // between this queue and a lock it wants 200 times a second. The
            // hold below is one buffered `fputs`, i.e. a memcpy.
            //
            // `rotationRate` is the whole point — it is what `usePanMotion`
            // consumes. `userAccel` in m/s² to match `accelMps2` above, so the
            // lurch cage can be re-run offline against the same quantity it
            // uses live, rather than against CoreMotion's G-units.
            let r = dm.rotationRate
            let line = String(
                format: "{\"type\":\"device-motion\",\"tsS\":%.9f,"
                      + "\"q\":[%.9f,%.9f,%.9f,%.9f],"
                      + "\"rotationRate\":[%.9f,%.9f,%.9f],"
                      + "\"userAccelMps2\":[%.6f,%.6f,%.6f],"
                      + "\"accelMagMps2\":%.6f}\n",
                dm.timestamp, q.x, q.y, q.z, q.w,
                r.x, r.y, r.z,
                a.x * 9.80665, a.y * 9.80665, a.z * 9.80665, magMps2)
            self.motionLock.lock()
            if let f = self.sensorsFp {
                fputs(line, f)
                self.sensorRows += 1
                // Flush on a cadence, not per row: a crash mid-sweep should
                // still leave a readable file, but fsync at 200 Hz would be
                // the most expensive thing on this queue.
                if self.sensorRows % 200 == 0 { fflush(f) }
            }
            self.motionLock.unlock()
        }
    }

    /// Stop CoreMotion, wait out a callback already in flight, close
    /// `sensors.jsonl`, and return the motion half of the arm's report:
    /// `motionSamples`, `sensorsJsonl`, `deliveredMotionHz`.
    public func stopMotion() -> [String: Any] {
        motionManager.stopDeviceMotionUpdates()
        // A callback already dispatched when the stop landed can still be
        // running; the file is closed only after it has finished.
        motionQueue?.waitUntilAllOperationsAreFinished()
        motionQueue = nil
        RNISPanoAttitude.clearAccelMagMps2()

        motionLock.lock()
        if let f = sensorsFp { fflush(f); fclose(f); sensorsFp = nil }
        let sensorRowsSnapshot = sensorRows
        let sensorWriteFailedSnapshot = sensorWriteFailed
        let motionSamplesSnapshot = motionSamples
        let motionSpan = lastMotionS - firstMotionS
        motionLock.unlock()

        var out: [String: Any] = [:]
        out["motionSamples"] = motionSamplesSnapshot
        // ── THE SENSOR LOG, AS A COUNT NOT A CLAIM ─────────────────────
        // A `present: true` says a file was opened; only a non-zero count says
        // rows were WRITTEN.
        out["sensorsJsonl"] = [
            "rows": sensorRowsSnapshot,
            "openFailed": sensorWriteFailedSnapshot,
            "fields": "tsS, q[xyzw], rotationRate[xyz] rad/s, "
                + "userAccelMps2[xyz], accelMagMps2",
            "referenceFrame": "xArbitraryZVertical",
            "note": "CoreMotion device-motion at the requested 200 Hz. "
                + "rotationRate is the quantity usePanMotion's lateral guard "
                + "consumes; before this it was discarded every sample and no "
                + "iOS pack could say what that guard saw.",
        ]
        // MEASURED, not the requested rate: CMMotionManager exposes only a
        // requested interval and silently clamps it, so the only honest number
        // is the one derived from the delivered timestamps.
        out["deliveredMotionHz"] =
            (motionSamplesSnapshot > 1 && motionSpan > 0)
                ? Double(motionSamplesSnapshot - 1) / motionSpan : NSNull()
        return out
    }

    // MARK: - The report

    /// Add the aligner's report and the composed τ/basis provenance to
    /// `report`, write `pose_source.json`, and record the compact block into
    /// `meta.json` through the engine. Called by the producer at stop, BEFORE
    /// the engine is finalized.
    public static func publish(_ report: inout [String: Any], sessionDir: String) {
        report["alignment"] = RNISPanoAttitude.report()

        // ── THE THREE-WAY τ PROVENANCE, COMPOSED EXACTLY ONCE ──────────
        // The seam knows `measured` vs `uncorrected`; only the producer knows
        // whether a measured τ came from the caller or off the calibration
        // store.  Composed here and read from `report` by `metaBlock`, so the
        // sidecar and `meta.json` cannot disagree.
        let prov = tauProvenance(report: report)
        report["tauProvenance"] = prov
        report["tauCorrectionApplied"] = (prov == "measured" || prov == "from-store")
        report["tauNote"] = tauNote(provenance: prov)
        // ── AND THE BASIS HALF, COMPOSED THE SAME WAY AND ONCE ─────────
        // `derived` (M5/D3) comes from the shared C++ like the other three
        // words, so the Android and iOS packs spell it identically.
        let basisSource = report["basisSource"] as? String
        let basisProv = basisSource == "derived"
            ? RNISPanoAttitude.derivedBasisProvenanceName()
            : RNISPanoAttitude.basisProvenance(source: basisSource)
        report["basisProvenance"] = basisProv
        // M5 review — a derivation that READ nothing from the device (iOS < 17,
        // or a hold not confirmed portrait) is the assumed 90° mounting, and
        // the note must say so rather than credit Apple's angle.
        let derivation = report["basisDerivation"] as? [String: Any]
        let angleWasRead = derivation?["readAngleDeg"] is NSNumber
        report["basisNote"] = basisNote(
            provenance: basisProv, derivedFromReadAngle: angleWasRead)

        writeSidecar(report, sessionDir: sessionDir)
        // ── M7: THE MARKER GOES IN meta.json TOO ───────────────────────
        // `meta.json` is the file every offline harness reads, and it carries
        // `rejectedPoseSpeed: 0` and `maxTranslationJump: 0` from cages that
        // NEVER RAN on this arm.  Recorded through the engine so it lands
        // inside the pack the engine is about to finalize.
        RNISPanoCore.recordPoseSource(metaBlock(from: report))
    }

    /// WHERE THIS SWEEP'S τ CAME FROM — `measured` / `from-store` /
    /// `uncorrected`, plus `not-measured` for a configuration that could never
    /// have started.  **THREE VALUES, NEVER A BOOLEAN.**
    static func tauProvenance(report: [String: Any]) -> String {
        let alignment = report["alignment"] as? [String: Any] ?? [:]
        // The SEAM's answer outranks everything: it is the layer that either
        // applied an offset or did not.
        if (alignment["tauMode"] as? String) == "uncorrected"
            || (alignment["tauUncorrected"] as? NSNumber)?.boolValue == true {
            return "uncorrected"
        }
        guard (alignment["tauMeasured"] as? NSNumber)?.boolValue == true else {
            return "not-measured"
        }
        return (report["tauSource"] as? String) == "store" ? "from-store" : "measured"
    }

    /// THE PLAIN SENTENCE, so a reader six weeks from now cannot mistake an
    /// experiment for a calibrated run without reading a single other field.
    static func tauNote(provenance: String) -> String {
        switch provenance {
        case "uncorrected":
            return "THIS SWEEP APPLIED NO TIMING CORRECTION. tau was held at 0 and "
                 + "was NOT measured for this device, lens or format — attitude was "
                 + "sampled at each frame's presentation timestamp exactly, with no "
                 + "camera-to-IMU offset of any kind. tau = 0 is the library default "
                 + "on the vision-camera arm (D2) and a declared experiment on the "
                 + "AVF arm. The default rests on a calibration on iPhone17,1 that "
                 + "resolved on 8 of 12 runs and scattered 5.03 ms, wider than the "
                 + "3.08 ms the correction would buy back. Do not compare this pack's "
                 + "residuals with a corrected pack's without saying which is which. "
                 + "See basisProvenance for the basis half."
        case "from-store":
            return "tau was MEASURED for this (device, lens, format) and read from the "
                 + "on-device calibration store, then applied: attitude was sampled at "
                 + "pts + tau."
        case "measured":
            return "tau was supplied by the caller as a measured offset and applied: "
                 + "attitude was sampled at pts + tau."
        default:
            return "tau provenance could not be established, which should be "
                 + "unreachable: the arm refuses to start without either a measured "
                 + "tau or an explicit uncorrected request."
        }
    }

    /// THE BASIS HALF'S SENTENCE, chosen by where the basis came from.
    static func basisNote(provenance: String, derivedFromReadAngle: Bool = true) -> String {
        switch provenance {
        case "measured":
            return "the device→camera basis C was MEASURED and validated on this "
                 + "device (selectBasis against a live ARKit reference, plus the "
                 + "±10 ms tau-stability gate) and read from the on-device "
                 + "calibration store. It is a real calibration, whatever "
                 + "tauProvenance says: the two numbers have different scopes and do "
                 + "not expire together."
        case "derived" where !derivedFromReadAngle:
            return "the device→camera basis C is the ASSUMED back-camera mounting "
                 + "(90°), NOT read from this device: iOS published no mounting angle "
                 + "here, or the hold was not confirmed portrait when the sweep "
                 + "started (see basisDerivation.method). It gives basis #8, measured "
                 + "on iPhone17,1; nothing on this phone measured or read it. Read "
                 + "basisImageCheck in host_verdict.json before trusting the geometry."
        case "derived":
            return "the device→camera basis C was DERIVED at the start of this sweep "
                 + "from Apple's mounting angle for the camera that was actually open "
                 + "(see basisDerivation) through the same shared derivation the "
                 + "Android recorder runs on SENSOR_ORIENTATION. Nothing on this phone "
                 + "MEASURED it. The frame checks confirm the buffer was unmirrored, "
                 + "landscape and constant in orientation for the whole sweep — not "
                 + "that its rotation matches the derivation (firstOrientation is "
                 + "recorded for that). It agrees with basis #8, measured on "
                 + "iPhone17,1; any other derived value is refused."
        case "caller-supplied":
            return "the device→camera basis C was HANDED IN BY THE CALLER. This build "
                 + "did NOT measure or validate it — nothing here certifies it, and it "
                 + "must not be read as a calibration this device ran. Compare it "
                 + "against attitudeBasisIndex in a pack whose basisProvenance is "
                 + "'measured' before trusting any geometry derived from it."
        default:
            return "no device→camera basis was resolved, which should be unreachable: "
                 + "a -1 basis index is a fatal refusal and the sweep would not have "
                 + "started. Treat this pack's orientation as unattributable."
        }
    }

    /// The compact `meta.json` block — a POINTER plus the facts a reader must
    /// not have to open the sidecar to learn.  Deliberately not the whole
    /// report: duplicating it would create two copies that can disagree.
    static func metaBlock(from report: [String: Any]) -> [String: Any] {
        let alignment = report["alignment"] as? [String: Any] ?? [:]
        // READ, never re-derived — see the composition site in `publish`.
        let basisProv = (report["basisProvenance"] as? String) ?? "not-measured"
        var block: [String: Any] = [
            "poseSource": "imu-attitude-only",
            "translation": "none",
            // The sentence that stops the misreading. Both of these counters
            // are structurally zero here and neither is a cage that passed.
            "posesSpeedCageNote":
                "counts.rejectedPoseSpeed and the translation-jump cage did NOT run "
              + "on this sweep: t is identically zero on this arm, so both are "
              + "structurally 0 and neither is evidence of anything.",
            // L16 — `referenceQuat` is exported on BOTH arms under one key and
            // denotes a DIFFERENT frame on each.
            "referenceQuatFrame":
                "R_imu(t0)*C in CoreMotion .xArbitraryZVertical — NOT the ARKit "
              + "world frame the ARKit arm's referenceQuat is expressed in. The "
              + "arbitrary yaw datum B cancels in dR = R0^T*Ri, which is the only "
              + "rotation that reaches the geometry.",
            "tauS": alignment["tauS"] ?? NSNull(),
            "tauMeasured": alignment["tauMeasured"] ?? NSNull(),
            "tauProvenance": report["tauProvenance"] ?? NSNull(),
            "tauCorrectionApplied": report["tauCorrectionApplied"] ?? NSNull(),
            "tauNote": report["tauNote"] ?? NSNull(),
            "tauSource": report["tauSource"] ?? NSNull(),
            "basisSource": report["basisSource"] ?? NSNull(),
            "basisProvenance": basisProv,
            "basisNote": report["basisNote"] ?? NSNull(),
            "tauSign": alignment["tauSign"] ?? NSNull(),
            "attitudeBasisIndex": alignment["attitudeBasisIndex"] ?? NSNull(),
            "attitudeBasisLabel": alignment["attitudeBasisLabel"] ?? NSNull(),
            "lurchCage": alignment["lurchCage"] ?? NSNull(),
            "calibrationSource": report["calibrationSource"] ?? NSNull(),
            "lens": report["lens"] ?? NSNull(),
            "lensRequested": report["lensRequested"] ?? NSNull(),
            "lensLabel": report["lensLabel"] ?? NSNull(),
            "session": report["session"] ?? NSNull(),
            "sidecar": "pose_source.json",
        ]
        // ── M5: WHICH CAMERA FED THE FRAMES ─────────────────────────────
        // Two producers now share this arm. `frameSource` says which one ran
        // (`avf-own` = pano+'s own AVCaptureSession, `vc-plugin` = the camera
        // vision-camera opened), so a DR-1a same-scene A/B is readable from
        // meta.json alone. Present only when the producer set it.
        for key in ["frameSource", "opensAvCaptureSession", "basisDerivation",
                    "activeFps", "vcDevice"] {
            if let v = report[key] { block[key] = v }
        }
        return block
    }

    static func writeSidecar(_ report: [String: Any], sessionDir: String) {
        guard !sessionDir.isEmpty else { return }
        let path = (sessionDir as NSString).appendingPathComponent("pose_source.json")
        guard JSONSerialization.isValidJSONObject(report),
              let data = try? JSONSerialization.data(
                withJSONObject: report,
                options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}
