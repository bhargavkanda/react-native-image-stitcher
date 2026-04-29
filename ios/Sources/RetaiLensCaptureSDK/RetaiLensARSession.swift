// SPDX-License-Identifier: UNLICENSED
//
// RetaiLensARSession — iOS ARKit wrapper that drives the SDK's
// pose-aware capture path.
//
// Phase 4 of the AR measurement plan
// (docs/site-content/design/2026-04-29-ar-measurement-and-detection.md).
// This is the foundation: it owns an ARSession, streams 6DoF
// camera poses + intrinsics + timestamps to JS, and stores a
// rolling pose log keyed by frame timestamp that the stitcher
// (Phase 5) and measurement APIs (Phase 6) read from.
//
// Why we own the ARSession instead of letting the host app:
//   1. ARKit and AVCaptureSession can't coexist on the same camera.
//      The SDK's vision-camera-backed CameraView and an ARSession
//      both want exclusive control.  Centralising AR session
//      lifecycle in the SDK lets us coordinate the handoff: when
//      AR is active, vision-camera releases the camera; when AR
//      stops, vision-camera resumes.
//   2. The pose log lives in native memory.  Marshalling every
//      frame (60Hz × 4×4 matrix × N frames) to JS via the bridge
//      would be wasteful.  Instead the JS side gets a session
//      handle + occasional state updates, while the stitcher and
//      measurement code read poses directly from native land.

import Foundation
import ARKit
import simd


/// Track state mirrors `ARCamera.TrackingState`.  We mirror it
/// rather than re-export the ARKit enum so the JS bridge sees a
/// stable shape that doesn't drift with iOS SDK updates.
@objc public enum RetaiLensARTrackingState: Int {
    /// AR isn't running on this device or session was never started.
    case notAvailable = 0
    /// Session is running but tracking quality is too low to use.
    /// Equivalent to ARKit's .limited.
    case initialising = 1
    /// Session is tracking with normal quality.  Poses are usable.
    case tracking = 2
    /// Tracking was lost mid-session (e.g. user covered the camera).
    /// Poses captured during this period have low confidence.
    case limited = 3
}


/// One frame's pose as a plain-old struct, ready to flatten into
/// JSON for the JS bridge.  Values are in ARKit's right-handed
/// world coordinate frame (Y-up, -Z forward), translation in
/// metres.
@objc(RetaiLensARFramePose)
public final class RetaiLensARFramePose: NSObject {
    /// Translation in world coordinates, metres.
    @objc public let tx: Double
    @objc public let ty: Double
    @objc public let tz: Double

    /// Rotation as a unit quaternion.  qw is the real component.
    @objc public let qx: Double
    @objc public let qy: Double
    @objc public let qz: Double
    @objc public let qw: Double

    /// Camera intrinsic parameters at this frame.
    /// fx/fy: focal length in pixels.
    /// cx/cy: principal point in pixels.
    @objc public let fx: Double
    @objc public let fy: Double
    @objc public let cx: Double
    @objc public let cy: Double

    /// Image dimensions of the captured frame in pixels.
    /// Useful for scaling intrinsics if the consumer downsamples.
    @objc public let imageWidth: Int
    @objc public let imageHeight: Int

    /// Frame timestamp in milliseconds since session start.
    /// Stitcher uses this to correlate pose data with video frames.
    @objc public let timestampMs: Double

    /// Tracking quality at the time of this frame.
    @objc public let trackingState: RetaiLensARTrackingState

    @objc public init(
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        timestampMs: Double,
        trackingState: RetaiLensARTrackingState
    ) {
        self.tx = tx; self.ty = ty; self.tz = tz
        self.qx = qx; self.qy = qy; self.qz = qz; self.qw = qw
        self.fx = fx; self.fy = fy; self.cx = cx; self.cy = cy
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.timestampMs = timestampMs
        self.trackingState = trackingState
    }

    /// Convenience: serialise to NSDictionary for the RN bridge.
    @objc public func asDictionary() -> [String: Any] {
        return [
            "tx": tx, "ty": ty, "tz": tz,
            "qx": qx, "qy": qy, "qz": qz, "qw": qw,
            "fx": fx, "fy": fy, "cx": cx, "cy": cy,
            "imageWidth": imageWidth, "imageHeight": imageHeight,
            "timestampMs": timestampMs,
            "trackingState": trackingState.rawValue,
        ]
    }
}


/// Singleton owner of the ARSession + pose log.
///
/// We use a singleton because the iOS hardware constraint is global:
/// only one ARSession can be active per process.  A singleton avoids
/// accidentally starting two sessions from different SDK call sites.
@objc(RetaiLensARSession)
public final class RetaiLensARSession: NSObject, ARSessionDelegate {

    /// Shared instance.  All callers MUST go through this.
    @objc public static let shared = RetaiLensARSession()

    private let arSession = ARSession()

    /// Rolling log of poses, keyed by ARFrame timestamp (TimeInterval).
    /// Capped at MAX_POSE_LOG entries to bound memory under long
    /// recordings.  Phase 5 stitching will query by timestamp.
    private var poseLog: [(TimeInterval, RetaiLensARFramePose)] = []
    private let poseLogQueue = DispatchQueue(
        label: "com.retailens.arsession.poselog",
        attributes: .concurrent
    )
    private static let MAX_POSE_LOG = 600  // ~10 s @ 60Hz

    /// Latest tracking state.  Read by JS for UI feedback.
    @objc public private(set) var currentTrackingState: RetaiLensARTrackingState = .notAvailable

    /// Whether the session is currently running.
    @objc public private(set) var isRunning: Bool = false

    private override init() {
        super.init()
        arSession.delegate = self
    }

    /// Whether ARKit's WorldTrackingConfiguration is supported on this
    /// device.  All iPhones since the 6s support it; the check is
    /// defensive against the SDK being run on the simulator or an
    /// unusual deployment.
    @objc public static var isSupported: Bool {
        return ARWorldTrackingConfiguration.isSupported
    }

    @objc public func start() {
        guard Self.isSupported else {
            currentTrackingState = .notAvailable
            return
        }
        let config = ARWorldTrackingConfiguration()
        // sceneDepth gives us per-pixel depth on LiDAR-equipped
        // devices; gracefully no-ops on non-LiDAR devices.  Used by
        // Phase 6 measurement.
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            config.frameSemantics = .smoothedSceneDepth
        }
        // Disable plane detection for now — we don't need it for
        // pose tracking, and turning it off frees CPU.  Phase 6
        // measurement may re-enable horizontal/vertical plane
        // tracking for better hit-testing.
        config.planeDetection = []
        // Auto-focus on for better feature tracking on shelves with
        // small text and packaging detail.
        config.isAutoFocusEnabled = true

        arSession.run(config, options: [.resetTracking, .removeExistingAnchors])
        isRunning = true
        currentTrackingState = .initialising
    }

    @objc public func stop() {
        guard isRunning else { return }
        arSession.pause()
        isRunning = false
        currentTrackingState = .notAvailable
        clearPoseLog()
    }

    /// Empty the pose log — call between captures so the next
    /// panorama starts fresh.
    @objc public func clearPoseLog() {
        poseLogQueue.async(flags: .barrier) { [weak self] in
            self?.poseLog.removeAll(keepingCapacity: true)
        }
    }

    /// Get all poses in the log, in capture order.
    /// Phase 5 stitcher calls this after recording stops.
    @objc public func snapshotPoseLog() -> [RetaiLensARFramePose] {
        var result: [RetaiLensARFramePose] = []
        poseLogQueue.sync {
            result = poseLog.map { $0.1 }
        }
        return result
    }

    /// Find the pose closest to the given timestamp (in ms).
    /// Used by the stitcher to match each video frame to a pose.
    /// Returns nil if the log is empty or the closest is farther
    /// than `maxToleranceMs` away.
    @objc public func poseClosestToTimestamp(
        _ targetMs: Double,
        maxToleranceMs: Double = 50
    ) -> RetaiLensARFramePose? {
        var best: (TimeInterval, RetaiLensARFramePose)?
        var bestDelta: Double = .infinity
        poseLogQueue.sync {
            for entry in poseLog {
                let delta = abs(entry.1.timestampMs - targetMs)
                if delta < bestDelta {
                    bestDelta = delta
                    best = entry
                }
            }
        }
        if bestDelta > maxToleranceMs { return nil }
        return best?.1
    }

    // MARK: - ARSessionDelegate

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        // ARKit fires this ~60Hz.  Capture the pose into our log.
        let pose = makePose(from: frame)
        let ts = frame.timestamp
        poseLogQueue.async(flags: .barrier) { [weak self] in
            guard let self = self else { return }
            self.poseLog.append((ts, pose))
            // Trim to bound memory.  Drop oldest first.
            if self.poseLog.count > Self.MAX_POSE_LOG {
                let drop = self.poseLog.count - Self.MAX_POSE_LOG
                self.poseLog.removeFirst(drop)
            }
        }
    }

    public func session(
        _ session: ARSession,
        cameraDidChangeTrackingState camera: ARCamera
    ) {
        switch camera.trackingState {
        case .normal:
            currentTrackingState = .tracking
        case .notAvailable:
            currentTrackingState = .notAvailable
        case .limited:
            currentTrackingState = .limited
        }
    }

    public func session(_ session: ARSession, didFailWithError error: Error) {
        NSLog("[RetaiLensARSession] failed: \(error.localizedDescription)")
        currentTrackingState = .notAvailable
        isRunning = false
    }

    // MARK: - Helpers

    private func makePose(from frame: ARFrame) -> RetaiLensARFramePose {
        // ARKit's transform is a 4x4 matrix; extract translation
        // (last column) and rotation (top-left 3x3 → quaternion).
        let t = frame.camera.transform
        let translation = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        // simd_quatf from a 4x4 matrix uses the rotational part.
        let q = simd_quatf(t)

        // Camera intrinsics.  Apple gives us a 3x3 matrix where
        // [0][0] = fx, [1][1] = fy, [0][2] = cx, [1][2] = cy.
        let k = frame.camera.intrinsics
        let imageRes = frame.camera.imageResolution

        let mappedState: RetaiLensARTrackingState
        switch frame.camera.trackingState {
        case .normal:        mappedState = .tracking
        case .limited:       mappedState = .limited
        case .notAvailable:  mappedState = .notAvailable
        }

        return RetaiLensARFramePose(
            tx: Double(translation.x),
            ty: Double(translation.y),
            tz: Double(translation.z),
            qx: Double(q.imag.x),
            qy: Double(q.imag.y),
            qz: Double(q.imag.z),
            qw: Double(q.real),
            fx: Double(k[0][0]),
            fy: Double(k[1][1]),
            cx: Double(k[0][2]),
            cy: Double(k[1][2]),
            imageWidth: Int(imageRes.width),
            imageHeight: Int(imageRes.height),
            timestampMs: frame.timestamp * 1000.0,
            trackingState: mappedState,
        )
    }
}
