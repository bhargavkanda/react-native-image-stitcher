// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoVcArm — the iOS sweep on the camera vision-camera already opened (M5).
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────
//
// Every non-AR iPhone sweep used to open pano+'s OWN `AVCaptureSession`
// (`RNISPanoAvfSource`) — a second camera owner behind `<Camera>`'s preview —
// and when its calibration was missing it fell back to ARKit, a third. Here
// vision-camera owns the camera, the `panoplus_sweep_ingest` frame processor
// (`RNISPanoSweepFrameProcessor.mm`) hands each frame to the engine, and this
// file does the rest of what a start needs WITHOUT opening anything:
//
//   1. resolve the device vision-camera mounted (`vcCameraId` is its
//      `uniqueID`) and refuse, by name, what the sweep cannot run on
//      (`RNISPanoVcRules`: a front camera, a multi-lens virtual device, a
//      zoom other than 1×, a format below 30 fps);
//   2. DERIVE the device-to-camera basis from the camera itself (D3) and
//      refuse anything but the one basis that has been measured;
//   3. start the IMU half (`RNISPanoImuArm`), lock exposure on vision-camera's
//      device (`RNISPanoCameraLock.lockForSweep(device:)`), and ARM the plugin.
//
// τ is 0 by default here (D2): the device's τ calibration scattered wider than
// the correction buys, no τ was ever persisted, and a stored τ keyed to a
// format pano+ chose would not describe vision-camera's format anyway.
//
// ── THE PLUGIN IS REACHED BY NAME, NOT BY SYMBOL ────────────────────────
//
// The plugin file compiles only when vision-camera is present
// (`__has_include`). A symbol reference from here would take this pod's link
// down on a build without it. So the arm/disarm is a NOTIFICATION and the
// report is read through the ObjC runtime (`NSClassFromString`) — present or
// honestly absent, never a crash.

import AVFoundation
import CoreMotion
import Foundation

@objc(RNISPanoVcArm)
public final class RNISPanoVcArm: NSObject {

    @objc public static let shared = RNISPanoVcArm()

    public struct StartFailure: Error {
        public let code: String
        public let detail: String
    }

    static let pluginClassName = "RNISPanoSweepFrameProcessor"
    static let armNotification = Notification.Name("RNISPanoSweepVcArmDidChange")

    /// The vision-camera plugin is compiled into this binary.
    @objc public static var isSupported: Bool { NSClassFromString(pluginClassName) != nil }

    /// The plugin's own counters (`+[RNISPanoSweepFrameProcessor report]`), or
    /// nil on a build without it.
    public static func pluginReport() -> [String: Any]? {
        guard let cls = NSClassFromString(pluginClassName) as? NSObject.Type else { return nil }
        let sel = NSSelectorFromString("report")
        guard cls.responds(to: sel),
              let r = cls.perform(sel)?.takeUnretainedValue() as? [String: Any]
        else { return nil }
        return r
    }

    private let stateLock = NSLock()
    private var running = false
    private var sessionDir = ""
    private var config: [String: Any] = [:]

    private override init() { super.init() }

    public var isRunning: Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return running
    }

    // MARK: - The device and its format

    /// What the start needs to know about the device vision-camera mounted.
    public struct Device {
        public let device: AVCaptureDevice
        /// The colour lens the frames come from (itself, or its one constituent).
        public let colourLens: String
        public let width: Int
        public let height: Int
        public let activeFps: Double
        public let hFovDeg: Double
    }

    /// Resolve the device by id and read its ACTIVE format — the one
    /// vision-camera chose. Opens nothing.
    public static func resolve(cameraId: String) throws -> Device {
        guard !cameraId.isEmpty else {
            throw StartFailure(
                code: "invalid-options",
                detail: "The vision-camera arm needs vcCameraId — the id of the camera "
                      + "<Camera> mounted — to know which device the frames come from.")
        }
        guard let device = AVCaptureDevice(uniqueID: cameraId) else {
            throw StartFailure(
                code: "panoplus-vc-device-unsupported",
                detail: "No camera answers to the id vision-camera reported ('\(cameraId)').")
        }
        let position: String
        switch device.position {
        case .back: position = "back"
        case .front: position = "front"
        default: position = "unspecified"
        }
        let isVirtual = device.isVirtualDevice
        let constituents = isVirtual ? device.constituentDevices.map { $0.deviceType.rawValue } : []
        if let r = RNISPanoVcRules.deviceRefusal(
            position: position, isVirtual: isVirtual, constituentTypes: constituents) {
            throw StartFailure(code: r.code, detail: r.detail)
        }
        let lens = RNISPanoVcRules.colourLens(
            deviceType: device.deviceType.rawValue, isVirtual: isVirtual,
            constituentTypes: constituents) ?? device.deviceType.rawValue
        let fmt = device.activeFormat
        let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
        // The ACTIVE rate: `activeVideoMinFrameDuration` is the shortest frame
        // duration the device is currently allowed, i.e. its top rate.
        var fps = 0.0
        let minDur = device.activeVideoMinFrameDuration
        if minDur.isValid, minDur.seconds > 0 { fps = 1.0 / minDur.seconds }
        if !(fps > 0) {
            fps = fmt.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
        }
        return Device(device: device, colourLens: lens,
                      width: Int(dims.width), height: Int(dims.height),
                      activeFps: fps, hFovDeg: Double(fmt.videoFieldOfView))
    }

    /// The calibration-key facts for a device's ACTIVE format — what
    /// `plannedCaptureFormat({deviceId})` answers (M5 step 3), so a τ lookup
    /// for this arm is keyed by the format vision-camera chose, not by the one
    /// the AVF arm would have planned.
    public static func formatReport(cameraId: String) -> [String: Any] {
        do {
            let d = try resolve(cameraId: cameraId)
            return ["ok": true, "lens": d.colourLens, "width": d.width, "height": d.height,
                    "fps": d.activeFps, "reason": NSNull(), "detail": NSNull(),
                    "source": "vision-camera-active-format"]
        } catch let f as StartFailure {
            return ["ok": false, "reason": f.code, "detail": f.detail, "lens": NSNull(),
                    "width": NSNull(), "height": NSNull(), "fps": NSNull(),
                    "source": "vision-camera-active-format"]
        } catch {
            return ["ok": false, "reason": "panoplus-io", "detail": "\(error)",
                    "source": "vision-camera-active-format"]
        }
    }

    // MARK: - D3: the basis, derived from the camera that is open

    /// Read Apple's statement of this camera's mounting, and derive the basis
    /// from it with the shared C++ derivation Android uses.
    ///
    ///   · iOS 27+: `RotationCoordinator.videoRotationAngleRelative(
    ///     toDeviceOrientation: .portrait)`, a static per-camera answer;
    ///   · iOS 17–26: `RotationCoordinator.videoRotationAngleForHorizonLevelCapture`,
    ///     which tracks the physical hold — read only when gravity CONFIRMS a
    ///     portrait hold, where it equals the portrait mounting;
    ///   · otherwise (older iOS, or no portrait confirmation): the measured
    ///     back-camera mounting, 90°, labelled `constant`.
    public static func deriveBasis(device: AVCaptureDevice) -> [String: Any] {
        var angle: Double? = nil
        var method = "constant"
        var gravity: [Double]? = nil
        if #available(iOS 27.0, *) {
            // The STATIC answer — independent of how the phone is held now.
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
            angle = Double(coordinator.videoRotationAngleRelative(toDeviceOrientation: .portrait))
            method = "RotationCoordinator.videoRotationAngleRelative(toDeviceOrientation: .portrait)"
        } else if #available(iOS 17.0, *) {
            let g = sampleGravity(timeoutS: 0.3)
            gravity = g
            if let g = g, RNISPanoVcRules.portraitHoldConfirmed(gx: g[0], gy: g[1], gz: g[2]) {
                let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
                angle = Double(coordinator.videoRotationAngleForHorizonLevelCapture)
                method = "RotationCoordinator.videoRotationAngleForHorizonLevelCapture (portrait confirmed by gravity)"
                // ⚠ M5 review — the coordinator follows its OWN orientation
                // estimate, which can lag a phone just turned upright. A
                // landscape answer (0/180) while gravity says portrait is a
                // disagreement about the HOLD, not a mounting: read again after
                // a beat, and if they still disagree say so as a hold refusal —
                // never "measure this kind of device".
                if let a = angle, let q = RNISPanoVcRules.quarterTurn(a), q == 0 || q == 180 {
                    usleep(300_000)
                    let g2 = sampleGravity(timeoutS: 0.2)
                    let a2 = Double(coordinator.videoRotationAngleForHorizonLevelCapture)
                    angle = a2
                    gravity = g2 ?? gravity
                    if let q2 = RNISPanoVcRules.quarterTurn(a2), q2 == 0 || q2 == 180 {
                        return [
                            "ok": false, "index": -1, "method": method,
                            "readAngleDeg": a2, "gravityAtStart": (g2 ?? g) as Any,
                            "refusal": "hold-disagrees-with-orientation",
                            "holdRefusal": true,
                            "provenance": RNISPanoAttitude.derivedBasisProvenanceName(),
                        ]
                    }
                }
            } else {
                method = "constant (the hold was not confirmed portrait at start)"
            }
        } else {
            method = "constant (iOS < 17 publishes no mounting angle)"
        }
        let mounting = angle.flatMap { RNISPanoVcRules.quarterTurn($0) } ?? (angle == nil ? 90 : nil)
        var out: [String: Any] = [
            "method": method,
            "readAngleDeg": angle.map { $0 as Any } ?? NSNull(),
            "gravityAtStart": gravity.map { $0 as Any } ?? NSNull(),
            "provenance": RNISPanoAttitude.derivedBasisProvenanceName(),
        ]
        guard let m = mounting else {
            out["ok"] = false
            out["index"] = -1
            out["refusal"] = "mounting-angle-not-a-quarter-turn"
            return out
        }
        let d = RNISPanoAttitude.deriveBackBasis(mountingAngleDeg: m, mirrored: false)
        for (k, v) in d { out[k] = v }
        return out
    }

    /// One CoreMotion gravity sample, pulled from a short-lived manager so the
    /// derivation needs nothing from the IMU arm that starts after it.
    private static func sampleGravity(timeoutS: Double) -> [Double]? {
        let mm = CMMotionManager()
        guard mm.isDeviceMotionAvailable else { return nil }
        mm.deviceMotionUpdateInterval = 1.0 / 100.0
        mm.startDeviceMotionUpdates(using: .xArbitraryZVertical)
        defer { mm.stopDeviceMotionUpdates() }
        let deadline = Date().addingTimeInterval(timeoutS)
        while Date() < deadline {
            if let dm = mm.deviceMotion { return [dm.gravity.x, dm.gravity.y, dm.gravity.z] }
            usleep(5_000)
        }
        return nil
    }

    // MARK: - Start / stop

    /// Start the IMU half, lock the device, arm the plugin. The engine
    /// (`RNISPanoCore.start`) must already be running. Throws a named
    /// `StartFailure`; on a throw nothing is left armed or running.
    public func start(sessionDir: String, device d: Device,
                      options: [String: Any]) throws -> [String: Any] {
        stateLock.lock()
        if running {
            stateLock.unlock()
            throw StartFailure(code: "panoplus-busy", detail: "The vision-camera arm is already running.")
        }
        stateLock.unlock()
        let imu = RNISPanoImuArm.shared
        guard imu.isDeviceMotionAvailable else {
            throw StartFailure(
                code: "panoplus-no-device-motion",
                detail: "CoreMotion reports no device-motion support on this hardware. "
                      + "This arm's attitude comes entirely from CMDeviceMotion, so every "
                      + "frame would refuse behind a live preview that never paints.")
        }
        do {
            try RNISPanoImuArm.configureAlignment(options: options)
        } catch let f as RNISPanoImuArm.Failure {
            throw StartFailure(code: f.code, detail: f.detail)
        }
        imu.resetForSweep(sessionDir: sessionDir)
        imu.startMotion()

        // The lock, on vision-camera's device, BEFORE the plugin is armed, so
        // the reference frame — the photometric datum of the whole sweep — is
        // a settled exposure. Best-effort: a refused lock is reported, never a
        // failed start.
        let lockRequested = (options["lockCamera"] as? Bool) ?? true
        let settleCeilingMs = (options["meteringSettleMs"] as? NSNumber)?.doubleValue ?? 600.0
        var lockReport: [String: Any]
        if lockRequested {
            lockReport = RNISPanoCameraLock.shared.lockForSweep(
                device: d.device, settleCeilingMs: settleCeilingMs)
        } else {
            lockReport = RNISPanoCameraLock.shared.attach(device: d.device)
            lockReport["requested"] = false
            lockReport["locked"] = false
            lockReport["reason"] = "lockCamera=false"
        }
        let lockArmed = (lockReport["locked"] as? Bool) == true

        NotificationCenter.default.post(
            name: Self.armNotification, object: nil,
            userInfo: ["armed": true, "cameraId": d.device.uniqueID,
                       "frameWidth": max(d.width, d.height), "lockArmed": lockArmed])

        stateLock.lock()
        self.sessionDir = sessionDir
        config = [
            "poseSource": "imu-attitude-only",
            "frameSource": "vc-plugin",
            "opensAvCaptureSession": false,
            "lens": d.colourLens,
            "lensRequested": options["lens"] ?? NSNull(),
            "vcDevice": [
                "uniqueId": d.device.uniqueID,
                "deviceType": d.device.deviceType.rawValue,
                "isVirtual": d.device.isVirtualDevice,
                "constituents": d.device.isVirtualDevice
                    ? d.device.constituentDevices.map { $0.deviceType.rawValue } : [],
                "width": d.width,
                "height": d.height,
                "hFovDeg": d.hFovDeg,
                "zoomFactor": Double(d.device.videoZoomFactor),
            ],
            "activeFps": d.activeFps,
            "requestedMotionHz": RNISPanoImuArm.requestedMotionHz,
            "calibrationSource": options["calibrationSource"] ?? NSNull(),
            "tauSource": options["tauSource"] ?? NSNull(),
            "basisSource": options["basisSource"] ?? NSNull(),
            "basisDerivation": options["basisDerivation"] ?? NSNull(),
            "cameraLock": lockReport,
        ]
        running = true
        let out = config
        stateLock.unlock()
        return out
    }

    /// Disarm the plugin (which waits out a frame already inside the engine),
    /// stop the IMU half, and publish the pack's pose block. Idempotent.
    @discardableResult
    public func stop() -> [String: Any] {
        stateLock.lock()
        let was = running
        running = false
        let dir = sessionDir
        var report = config
        stateLock.unlock()
        guard was else { return ["ran": false] }

        // Synchronous: the plugin's observer drains an in-flight frame before
        // it returns, so nothing ingests after this line.
        NotificationCenter.default.post(
            name: Self.armNotification, object: nil, userInfo: ["armed": false])
        let plugin = Self.pluginReport() ?? ["present": false]
        let motion = RNISPanoImuArm.shared.stopMotion()

        report["ran"] = true
        report["vcPlugin"] = plugin
        for (k, v) in motion { report[k] = v }
        report["framesDelivered"] = plugin["seen"] ?? NSNull()
        report["framesIngested"] = plugin["ingested"] ?? NSNull()
        RNISPanoImuArm.publish(&report, sessionDir: dir)
        return report
    }
}
