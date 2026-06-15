// SPDX-License-Identifier: Apache-2.0
//
// RNSARSession — iOS ARKit wrapper that drives the SDK's
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
import AVFoundation
import simd
import UIKit
import os.log

// V15.0c.4 — FAULT-level os_log on the same subsystem/category the
// slit-scan engine uses, so Console.app's filter for `category =
// slitscan` shows ARKit plane events alongside engine events.
// FAULT survives os_log's default-level rate limiting; NSLog is
// "default" level and gets coalesced/dropped under burst.
fileprivate let arSessionDiagLog = OSLog(
    subsystem: "com.tiger.retailens.sdk",
    category: "slitscan"
)


/// Track state mirrors `ARCamera.TrackingState`.  We mirror it
/// rather than re-export the ARKit enum so the JS bridge sees a
/// stable shape that doesn't drift with iOS SDK updates.
@objc public enum RNSARTrackingState: Int {
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
@objc(RNSARFramePose)
public final class RNSARFramePose: NSObject {
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
    @objc public let trackingState: RNSARTrackingState

    @objc public init(
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        timestampMs: Double,
        trackingState: RNSARTrackingState
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
@objc(RNSARSession)
public final class RNSARSession: NSObject, ARSessionDelegate {

    /// Shared instance.  All callers MUST go through this.
    @objc public static let shared = RNSARSession()

    /// The underlying ARKit session.  Module-internal (not `private`)
    /// so RNSARCameraView (same module) can bind its ARSCNView
    /// to this exact session — sharing is critical so the pose log
    /// (driven by this object's `ARSessionDelegate` callbacks) stays
    /// populated while the view renders frames.  Lifecycle is still
    /// controlled exclusively via `start()` / `stop()`.
    let arSession = ARSession()

    /// Rolling log of poses, keyed by ARFrame timestamp (TimeInterval).
    /// Capped at MAX_POSE_LOG entries to bound memory under long
    /// recordings.  Phase 5 stitching will query by timestamp.
    private var poseLog: [(TimeInterval, RNSARFramePose)] = []
    private let poseLogQueue = DispatchQueue(
        label: "io.imagestitcher.arsession.poselog",
        attributes: .concurrent
    )
    private static let MAX_POSE_LOG = 600  // ~10 s @ 60Hz
    /// AR keyframe long-edge budget (px) — downscale every device's frame to
    /// this before encoding so stitch memory is consistent cross-device.
    /// Mirrors Android's AR_KEYFRAME_MAX_LONG_EDGE.
    private static let arKeyframeMaxLongEdge: CGFloat = 640

    /// Latest tracking state.  Read by JS for UI feedback.
    @objc public private(set) var currentTrackingState: RNSARTrackingState = .notAvailable

    /// Whether the session is currently running.
    @objc public private(set) var isRunning: Bool = false

    // ──────────────────────────────────────────────────────────────
    // V15.0b — vertical plane detection
    // ──────────────────────────────────────────────────────────────
    /// First detected vertical plane anchor's transform (4x4, column-
    /// major, world coords).  Nil until ARKit detects a vertical
    /// plane.  Once latched, NOT updated — canvas geometry needs to
    /// be stable across the capture.
    private var detectedPlaneTransformInternal: simd_float4x4? = nil
    private let planeLatchLock = NSLock()

    /// V15.0d — minimum dot product between a candidate plane's
    /// surface normal and the camera's FACING direction (i.e. the
    /// negative of camera-forward) at detection time.  Planes whose
    /// alignment is below this threshold are REJECTED — the user is
    /// scanning a wall in front of them, not a side wall or a
    /// doorframe.  Ranges 0.0 (accept any vertical plane) – 1.0
    /// (only accept perfectly camera-facing planes).  Default 0.6
    /// ≈ 53° max angle off-camera.  Set by the bridge via
    /// `setPlaneAlignmentThreshold` from the engine config.
    @objc public var planeAlignmentThreshold: Float = 0.6

    /// V15.0e — best alignment score seen on any candidate plane
    /// rejected by the alignment filter.  -1 = no candidate seen
    /// yet.  When > 0 but a plane hasn't been latched, the JS UI
    /// shows "found plane but off-axis (best 0.45)" so the operator
    /// knows to face the wall more directly to clear the threshold.
    /// Reset on -stop.
    @objc public private(set) var bestRejectedAlignment: Float = -1.0

    /// Whether a vertical plane has been detected and latched.
    @objc public var hasPlaneDetected: Bool {
        planeLatchLock.lock()
        defer { planeLatchLock.unlock() }
        return detectedPlaneTransformInternal != nil
    }

    /// V15.0g — clear the latched plane and re-evaluate ALL currently-
    /// tracked vertical ARPlaneAnchors against the camera's CURRENT
    /// aim, picking the BEST candidate.
    ///
    /// V15.0g.3 scoring (replaces V15.0g area-weighted):
    ///   1. Reject planes whose alignment is below
    ///      `planeAlignmentThreshold`.
    ///   2. Reject planes smaller than `kMinPlaneArea` (0.20 m²) —
    ///      filters out micro-planes from artifacts (sign edges, etc.)
    ///      that might happen to be very close.
    ///   3. Among the rest, pick the **closest** plane (smallest
    ///      perpendicular distance from camera).
    ///
    /// Why closest, not largest:
    /// Field testing on a Pepsi cooler (2026-05-08) showed the area-
    /// weighted heuristic picking the WALL behind the cooler (3.5 m²,
    /// 1.5m away) over the cooler face itself (0.85 m², 0.85m away).
    /// Wall normal isn't perpendicular to the camera view → projecting
    /// onto wall plane caused horizontal anchor drift as user tilted
    /// down ("everything moves to the right as I pan down").
    ///
    /// The user is almost always aimed at the FOREGROUND object they
    /// want to scan — that's why they're aimed at it.  Closest plane
    /// = foreground = scan target.  Min-area filter prevents tiny
    /// nearby artifacts (a sign's edge, a small reflection) from
    /// winning by being super close.
    ///
    /// Returns YES if a plane was latched, NO if no candidate passed
    /// both filters.
    @objc public func relatchPlaneFromCurrentAnchors() -> Bool {
        planeLatchLock.lock()
        defer { planeLatchLock.unlock() }

        // Clear any existing latch; we're picking fresh.
        detectedPlaneTransformInternal = nil
        bestRejectedAlignment = -1.0

        guard let frame = arSession.currentFrame else {
            os_log(.fault, log: arSessionDiagLog,
                   "[V15.0g-relatch] no current frame; deferred until next session tick")
            return false
        }
        let cameraTransform = frame.camera.transform
        let cameraFacingWorld = simd_float3(
            -cameraTransform.columns.2.x,
            -cameraTransform.columns.2.y,
            -cameraTransform.columns.2.z
        )
        let cameraPosWorld = simd_float3(
            cameraTransform.columns.3.x,
            cameraTransform.columns.3.y,
            cameraTransform.columns.3.z
        )

        // V15.0g.3 — minimum plane area to be considered a real scan
        // target.  Tiny planes are usually artifacts (a small reflective
        // surface, a sign's edge) that ARKit briefly fits.
        let kMinPlaneArea: Float = 0.20  // 0.45m × 0.45m

        var bestPlane: ARPlaneAnchor? = nil
        var bestPerpDist: Float = .greatestFiniteMagnitude
        var bestAlignment: Float = -1.0
        var bestArea: Float = 0.0

        for anchor in frame.anchors {
            guard let plane = anchor as? ARPlaneAnchor else { continue }
            if plane.alignment != .vertical { continue }

            let planeNormalWorld = simd_float3(
                plane.transform.columns.1.x,
                plane.transform.columns.1.y,
                plane.transform.columns.1.z
            )
            let planeOriginWorld = simd_float3(
                plane.transform.columns.3.x,
                plane.transform.columns.3.y,
                plane.transform.columns.3.z
            )
            let dotPos = simd_dot(planeNormalWorld, cameraFacingWorld)
            let alignment = max(dotPos, -dotPos)

            if alignment < planeAlignmentThreshold {
                if alignment > bestRejectedAlignment {
                    bestRejectedAlignment = alignment
                }
                continue
            }

            // Area = extent.x × extent.z (using deprecated extent for
            // iOS 15 compat; iOS 16+ has planeExtent which is more
            // accurate but we don't depend on absolute precision here).
            let area = plane.extent.x * plane.extent.z

            // V15.0g.3 — reject micro-planes.
            if area < kMinPlaneArea {
                os_log(.fault, log: arSessionDiagLog,
                       "[V15.0g-relatch] candidate REJECTED (area too small): alignment=%f area=%fm² (extent %fx%f) < min=%f",
                       alignment, area, plane.extent.x, plane.extent.z, kMinPlaneArea)
                continue
            }

            // V15.0g.3 — perpendicular distance from camera to plane.
            // Closer = more likely the foreground scan target.
            let diff = planeOriginWorld - cameraPosWorld
            let perpDist = abs(simd_dot(diff, planeNormalWorld))
            // Score is inverse-distance for diagnostic clarity; lower
            // perpDist = higher score.
            let score = (perpDist > 0.001) ? (1.0 / perpDist) : 1000.0

            os_log(.fault, log: arSessionDiagLog,
                   "[V15.0g-relatch] candidate plane: alignment=%f area=%fm² (extent %fx%f) perpDist=%fm score=%f",
                   alignment, area, plane.extent.x, plane.extent.z, perpDist, score)

            // V15.0g.3 — closer wins.
            if perpDist < bestPerpDist {
                bestPlane = plane
                bestPerpDist = perpDist
                bestAlignment = alignment
                bestArea = area
            }
        }

        guard let chosen = bestPlane else {
            os_log(.fault, log: arSessionDiagLog,
                   "[V15.0g-relatch] no candidate plane passed alignment+area filters (best rejected alignment=%f, threshold=%f); engine will refuse first frame until lock",
                   bestRejectedAlignment, planeAlignmentThreshold)
            return false
        }

        detectedPlaneTransformInternal = chosen.transform
        os_log(.fault, log: arSessionDiagLog,
               "[V15.0g-relatch] latched best plane: alignment=%f area=%fm² perpDist=%fm extent=%fx%f centre=(%f,%f,%f)",
               bestAlignment, bestArea, bestPerpDist,
               chosen.extent.x, chosen.extent.z,
               chosen.center.x, chosen.center.y, chosen.center.z)
        return true
    }

    /// Returns the latched plane transform as a 16-element [Float]
    /// array (column-major).  `nil` if no plane detected yet.
    @objc public func planeTransformFlat() -> [NSNumber]? {
        planeLatchLock.lock()
        defer { planeLatchLock.unlock() }
        guard let m = detectedPlaneTransformInternal else { return nil }
        let cols = [m.columns.0, m.columns.1, m.columns.2, m.columns.3]
        var out: [NSNumber] = []
        out.reserveCapacity(16)
        for c in cols {
            out.append(NSNumber(value: c.x))
            out.append(NSNumber(value: c.y))
            out.append(NSNumber(value: c.z))
            out.append(NSNumber(value: c.w))
        }
        return out
    }

    /// V16 keyframe-gate accessor — returns the latched plane as a
    /// `simd_float4x4`, the form Swift code (`KeyframeGate`,
    /// `IncrementalStitcher`) needs for in-process polygon
    /// math.  Distinct from `planeTransformFlat()` which exists only
    /// to bridge the same data into ObjC++ as an NSNumber array.
    /// Nil until a plane is latched (via the AR delegate's didAdd
    /// alignment filter or `relatchPlaneFromCurrentAnchors()`).
    public func latchedPlaneTransform() -> simd_float4x4? {
        planeLatchLock.lock()
        defer { planeLatchLock.unlock() }
        return detectedPlaneTransformInternal
    }

    // ──────────────────────────────────────────────────────────────
    // Phase 5 — AR-backed photo + video capture state
    // ──────────────────────────────────────────────────────────────
    //
    // `takePhoto` / `startRecording` / `stopRecording` make the AR
    // session a drop-in replacement for vision-camera's `<Camera>`
    // — same imperative API exposed via ARCameraView's ref, so the
    // host's existing `useCapture` / `useVideoCapture` hooks work
    // transparently when AR mode is on.
    //
    // The asset writer state below is touched from TWO threads:
    //   1. The bridge thread (start/stop calls from JS).
    //   2. The ARSession delegate thread (per-frame callbacks
    //      that append the latest pixelBuffer to the writer).
    // We serialise via `writerLock` (NSLock) — the delegate uses
    // `try()` so it never blocks ARKit; start/stop hold the lock
    // only while swapping state pointers, never across the slow
    // AVFoundation calls.

    /// Active AVAssetWriter while recording; nil when idle.
    private var assetWriter: AVAssetWriter?
    /// AVAssetWriterInput owns the encoded video track.  Held
    /// separately from `assetWriter` so we can call `markAsFinished`
    /// and check `isReadyForMoreMediaData` without re-querying.
    private var videoInput: AVAssetWriterInput?
    /// Adaptor accepts CVPixelBuffer directly — bypasses the
    /// CMSampleBuffer ceremony that would otherwise be needed for
    /// each frame.  ARFrame.capturedImage is already a CVPixelBuffer.
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    /// Timestamp of the first frame appended.  Used as the session
    /// start time so CMTime presentation timestamps remain monotonic
    /// from zero.
    private var recordingStartTime: CMTime?
    /// Lock guarding writer-state reads/writes.  Used with `try()`
    /// from the ARSession delegate so frame-append never blocks the
    /// delegate thread; if start/stop is mid-flight, the frame is
    /// just dropped (graceful).  Held briefly during setup +
    /// teardown only to swap the state pointers — the slow
    /// AVFoundation calls (`startWriting`, `finishWriting`) happen
    /// OUTSIDE the lock.
    private let writerLock = NSLock()

    /// Optional consumer that receives each ARFrame's pixel buffer +
    /// pose for the live incremental-stitching path.  Set by
    /// `IncrementalStitcher.start()` and cleared on
    /// `finalize()` / `cancel()`.
    ///
    /// Weak so the consumer's lifetime is owned by whoever set it
    /// (currently the incremental-stitcher singleton); this just
    /// prevents the AR session from outliving a consumer that's
    /// been torn down.
    @objc public weak var incrementalConsumer: ARFrameConsumer?

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
        // V15.0f — IDEMPOTENT.  Calling start() while the session is
        // already running used to re-run with [.resetTracking,
        // .removeExistingAnchors], which silently WIPED any plane
        // detection that had been accumulating since the camera
        // view first mounted.  Multiple call sites (camera view's
        // didMoveToWindow, JS bridge's start, useARSession hook)
        // could trigger this race.  Guarding here keeps plane
        // detection state stable across redundant start() calls.
        if isRunning {
            os_log(.fault, log: arSessionDiagLog,
                   "[V15.0f-ar-start] start() called while already running — ignored to preserve plane detection state")
            return
        }
        let config = ARWorldTrackingConfiguration()
        // sceneDepth gives us per-pixel depth on LiDAR-equipped
        // devices; gracefully no-ops on non-LiDAR devices.  Used by
        // Phase 6 measurement.
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            config.frameSemantics = .smoothedSceneDepth
        }
        // V15.0b — enable VERTICAL plane detection for the
        // plane-projected stitch mode.  ARKit incrementally builds a
        // model of any vertical surface in view (typical retail
        // fixture wall).  The first-detected vertical plane's
        // transform is latched at capture-start and used as the
        // canvas reference frame: each accepted camera frame is
        // warped onto the plane via a 3×3 homography rather than
        // onto a virtual cylinder/plane at first-frame anchor.
        // CPU cost is negligible (<2 ms/frame).  Detection time:
        // 2–5 s on non-LiDAR devices, sub-second on LiDAR.
        config.planeDetection = [.vertical]
        // Auto-focus on for better feature tracking on shelves with
        // small text and packaging detail.
        config.isAutoFocusEnabled = true

        // Option B — prefer the 4:3 videoFormat for full sensor FOV; the
        // keyframe is downscaled to arKeyframeMaxLongEdge below so memory
        // stays consistent across devices regardless of the format res.
        if let fmt = ARWorldTrackingConfiguration.supportedVideoFormats.min(by: { a, b in
            let da = abs(a.imageResolution.width / a.imageResolution.height - 4.0 / 3.0)
            let db = abs(b.imageResolution.width / b.imageResolution.height - 4.0 / 3.0)
            if abs(da - db) > 0.001 { return da < db }
            return a.imageResolution.width * a.imageResolution.height
                 < b.imageResolution.width * b.imageResolution.height
        }) {
            config.videoFormat = fmt
        }
        arSession.run(config, options: [.resetTracking, .removeExistingAnchors])
        // V16-diag — log the chosen video format so we can correlate
        // batch-keyframe memory with ARFrame resolution.  iPhone Pro
        // models can default to higher-res capture which inflates
        // every downstream cv::Mat allocation 3-5×.
        let vfRes = config.videoFormat.imageResolution
        os_log(.fault, log: arSessionDiagLog,
               "[V16-diag] AR videoFormat: %dx%d @ %d fps",
               Int32(vfRes.width), Int32(vfRes.height),
               Int32(config.videoFormat.framesPerSecond))
        isRunning = true
        currentTrackingState = .initialising

        // Per-frame ingest calls `incrementalConsumer.consumeFrame`
        // directly from `session(_:didUpdate:)` below. (The v0.8
        // worklet-runtime indirection that used to live here was archived
        // in the batch-keyframe cleanup — see archive/.)
    }

    @objc public func stop() {
        guard isRunning else { return }
        arSession.pause()
        isRunning = false
        currentTrackingState = .notAvailable
        clearPoseLog()
        // V15.0b — clear latched plane so the next capture detects
        // afresh.  Plane geometry is per-capture: a different
        // fixture in a different orientation needs a new lock.
        // V15.0e — also reset the rejected-alignment cache so the
        // next capture's UI starts at "Searching" rather than
        // showing a stale alignment from the previous capture.
        planeLatchLock.lock()
        detectedPlaneTransformInternal = nil
        bestRejectedAlignment = -1.0
        planeLatchLock.unlock()
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
    @objc public func snapshotPoseLog() -> [RNSARFramePose] {
        var result: [RNSARFramePose] = []
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
    ) -> RNSARFramePose? {
        var best: (TimeInterval, RNSARFramePose)?
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

        // v0.8.0 Phase 3c — route the per-frame ingest through the
        // worklet runtime instead of calling the consumer directly.
        // The first-party callback (installed in `start()` above)
        // wraps the same `consumer.consumeFrame(pixelBuffer:pose:)`
        // call path, so net behavior is byte-identical to v0.7.x.
        // The indirection sets up the seam where Phase 4 will fan
        // out to host worklets (registered via the v0.8.0
        // `useFrameProcessor` TS hook + a JSI plugin entry point)
        // without changing this first-party path.
        //
        // ARKit pool reuse contract: consumeFrame does the NV12 →
        // cv::Mat sync conversion synchronously on the delegate thread
        // before returning, so the captured pixel buffer is safe for
        // ARKit to recycle after this call.
        incrementalConsumer?.consumeFrame(pixelBuffer: frame.capturedImage,
                                          pose: pose)

        // If recording is in flight, append this frame to the
        // asset writer DIRECTLY — no queue hop.
        //
        // Apple's ARKit docs are explicit: "ARKit holds the captured
        // pixel buffer in a small pool.  The buffer may be reused
        // after the next ARFrame is captured.  To use the pixel
        // buffer beyond the scope of the captured ARFrame, you must
        // make a copy."  Swift's CF retain on capturedImage does NOT
        // protect against ARKit's pool reuse.  Hopping queues with
        // a captured pixelBuffer led to the EXC_BAD_ACCESS crashes
        // we kept seeing (Sentry: "release" at objc_retain) — by
        // the time the closure ran, ARKit had reclaimed the
        // underlying memory.
        //
        // Appending synchronously inside the delegate callback
        // means the pixel buffer is consumed (adaptor.append makes
        // its own internal copy) before the delegate returns —
        // exactly the lifetime ARKit guarantees.
        //
        // Synchronisation with start/stop is via `writerLock.try()`:
        // if start/stop is mid-flight, the frame is dropped (graceful
        // backpressure) rather than blocking ARKit's delegate.  The
        // slow AVFoundation calls (startWriting, finishWriting)
        // happen OUTSIDE the lock so the lock hold time is
        // microseconds, not milliseconds.
        guard writerLock.try() else { return }
        defer { writerLock.unlock() }
        guard let writer = self.assetWriter,
              let input = self.videoInput,
              let adaptor = self.pixelBufferAdaptor,
              writer.status == .writing,
              input.isReadyForMoreMediaData,
              let startTime = self.recordingStartTime else {
            return
        }
        let frameCMTime = CMTime(
            seconds: frame.timestamp,
            preferredTimescale: 1_000_000
        )
        let pts = CMTimeSubtract(frameCMTime, startTime)
        adaptor.append(frame.capturedImage, withPresentationTime: pts)
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
        NSLog("[RNSARSession] failed: \(error.localizedDescription)")
        currentTrackingState = .notAvailable
        isRunning = false
    }

    // V15.0b — latch the first detected vertical plane.  Subsequent
    // ARKit refinements of the same plane (didUpdate) are ignored so
    // canvas geometry stays stable across the capture.
    public func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        planeLatchLock.lock()
        defer { planeLatchLock.unlock() }
        guard detectedPlaneTransformInternal == nil else { return }

        // V15.0d — alignment filter (3A).  ARKit's vertical-plane
        // detection finds whatever vertical surface it can — the
        // wall in front of the user, the wall behind, side walls,
        // doorframes, table edges.  Latching the FIRST one ARKit
        // reports often picks a surface unrelated to the user's
        // scan target, producing a wildly wrong projection in the
        // V15.0b path.
        //
        // Filter: only accept a candidate plane whose surface
        // normal is within `planeAlignmentThreshold` (cosine of
        // angle) of the camera's facing direction.  If no plane
        // in the current `anchors` batch passes the filter, leave
        // `detectedPlaneTransformInternal` nil so a future
        // `didAdd` callback can try again.
        //
        // Camera facing in WORLD = -worldForward = -camera.transform.cols[2]
        //   (ARKit camera looks down its local -Z; column 2 of the
        //    camera transform is local +Z in world, so the camera
        //    is looking in the direction of -columns.2)
        // Plane surface normal in WORLD = plane.transform.cols[1]
        //   (ARPlaneAnchor convention: local Y axis = surface normal)
        guard let cameraTransform = session.currentFrame?.camera.transform else {
            // No camera pose yet — log and bail; next didAdd may
            // succeed once the session warms up.
            os_log(.fault, log: arSessionDiagLog,
                   "[V15.0d-plane-filter] didAdd received but no camera pose yet; deferring latch")
            return
        }
        let cameraFacingWorld = simd_float3(
            -cameraTransform.columns.2.x,
            -cameraTransform.columns.2.y,
            -cameraTransform.columns.2.z
        )

        for anchor in anchors {
            guard let plane = anchor as? ARPlaneAnchor else { continue }
            if plane.alignment != .vertical { continue }

            let planeNormalWorld = simd_float3(
                plane.transform.columns.1.x,
                plane.transform.columns.1.y,
                plane.transform.columns.1.z
            )
            // Two possible orientations for the normal (column 1
            // can point either side of the wall).  Take the
            // larger of the two dot products — i.e. assume the
            // normal that's most aligned with the camera-facing
            // direction is the "outward" surface normal.
            let dotPos = simd_dot(planeNormalWorld, cameraFacingWorld)
            let alignment = max(dotPos, -dotPos)

            if alignment < planeAlignmentThreshold {
                // Reject — not the surface the camera is aimed at.
                // Track the best-rejected score so JS UI can show
                // a progress hint ("found plane but off-axis 0.45").
                if alignment > bestRejectedAlignment {
                    bestRejectedAlignment = alignment
                }
                os_log(.fault, log: arSessionDiagLog,
                       "[V15.0d-plane-filter] REJECTED candidate plane: alignment=%f < threshold=%f extent=%fx%f",
                       alignment, planeAlignmentThreshold,
                       plane.extent.x, plane.extent.z)
                continue
            }

            detectedPlaneTransformInternal = plane.transform
            os_log(.fault, log: arSessionDiagLog,
                   "[V15.0b-plane] latched vertical plane alignment=%f extent=%fx%f centre=(%f,%f,%f)",
                   alignment,
                   plane.extent.x, plane.extent.z,
                   plane.center.x, plane.center.y, plane.center.z)
            break
        }
    }

    public func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        // V15.0d — ARKit refines plane anchors over time via
        // didUpdate.  If our didAdd alignment filter rejected all
        // candidates (e.g. user wasn't aimed at the wall yet when
        // detection fired), we want to give the same anchors
        // another chance once they're refined / the camera is
        // pointed differently.  Same logic as didAdd: consider
        // each updated anchor; latch the first that passes the
        // alignment filter.  Once latched, never re-evaluate.
        planeLatchLock.lock()
        defer { planeLatchLock.unlock() }
        guard detectedPlaneTransformInternal == nil else { return }

        guard let cameraTransform = session.currentFrame?.camera.transform else {
            return
        }
        let cameraFacingWorld = simd_float3(
            -cameraTransform.columns.2.x,
            -cameraTransform.columns.2.y,
            -cameraTransform.columns.2.z
        )

        for anchor in anchors {
            guard let plane = anchor as? ARPlaneAnchor else { continue }
            if plane.alignment != .vertical { continue }
            let planeNormalWorld = simd_float3(
                plane.transform.columns.1.x,
                plane.transform.columns.1.y,
                plane.transform.columns.1.z
            )
            let dotPos = simd_dot(planeNormalWorld, cameraFacingWorld)
            let alignment = max(dotPos, -dotPos)
            if alignment < planeAlignmentThreshold {
                if alignment > bestRejectedAlignment {
                    bestRejectedAlignment = alignment
                }
                continue
            }

            detectedPlaneTransformInternal = plane.transform
            os_log(.fault, log: arSessionDiagLog,
                   "[V15.0b-plane] latched vertical plane (via didUpdate) alignment=%f extent=%fx%f centre=(%f,%f,%f)",
                   alignment,
                   plane.extent.x, plane.extent.z,
                   plane.center.x, plane.center.y, plane.center.z)
            break
        }
    }

    // MARK: - Phase 5: AR-backed photo + video capture

    /// Capture the current camera frame as a JPEG.  If `rawPath` is
    /// empty, generates a fresh path inside `NSTemporaryDirectory()`
    /// — matches vision-camera's API where the path is an OUTPUT,
    /// not an input.  Completion fires with a result dictionary
    /// matching vision-camera's PhotoFile shape.
    @objc public func takePhoto(
        toPath rawPath: String,
        quality: Int,
        orientation: String,
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        let resolvedPath: String
        if rawPath.isEmpty {
            let dir = NSTemporaryDirectory()
            resolvedPath = (dir as NSString).appendingPathComponent(
                "RNImageStitcherAR-\(UUID().uuidString).jpg"
            )
        } else {
            resolvedPath = rawPath
        }
        guard let frame = arSession.currentFrame else {
            completion(nil, NSError(
                domain: "RNImageStitcherARCapture",
                code: 2001,
                userInfo: [NSLocalizedDescriptionKey:
                    "AR session has no current frame — start the session first."]
            ))
            return
        }
        let pixelBuffer = frame.capturedImage

        // v0.12.0 — Pre-v0.12 this method hardcoded `.right` (90° CW)
        // to rotate-to-portrait, assuming the user always held the
        // phone in portrait.  Under R2-lite the device can be in
        // any orientation, so we pick the CIImage orientation per
        // the JS-supplied `orientation` arg (from
        // `useDeviceOrientation()`).
        //
        // Empirical mapping (on-device test 2026-05-28):
        //   portrait              → .right  (90° CW — preserved from pre-v0.12)
        //   landscape-left        → .up     (sensor matches device tilt; no rotation)
        //   landscape-right       → .down   (180° — sensor opposite of device tilt)
        //   portrait-upside-down  → .left   (90° CCW)
        //
        // The landscape mapping (landscape-left → .up) was determined
        // empirically and is the opposite of what Apple's ARKit
        // pixel-buffer-orientation docs would imply.  Likely because
        // `useDeviceOrientation()` reports `landscape-left` via the
        // `UIDeviceOrientation` convention (home indicator on user-
        // right) while iOS's sensor-native orientation matches that
        // tilt direction directly.  Without this fix, AR-mode single
        // photos in landscape come out upside-down.
        // v0.12.0 — Pre-v0.12 this method hardcoded `.right` (90° CW)
        // to rotate-to-portrait, assuming the user always held the
        // phone in portrait.  Under R2-lite the device can be in
        // any orientation, so we pick the CIImage orientation per
        // the JS-supplied `orientation` arg (from
        // `useDeviceOrientation()`).
        //
        // Empirical mapping (on-device test 2026-05-28):
        //   portrait              → .right  (90° CW — preserved from pre-v0.12)
        //   landscape-left        → .up     (sensor matches device tilt; no rotation)
        //   landscape-right       → .down   (180° — sensor opposite of device tilt)
        //   portrait-upside-down  → .left   (90° CCW)
        //
        // The landscape mapping (landscape-left → .up) was determined
        // empirically; the user reported AR landscape photos came out
        // upside-down with .down and correctly upright with .up.
        let exifOrientation: CGImagePropertyOrientation
        switch orientation {
        case "landscape-left":        exifOrientation = .up
        case "landscape-right":       exifOrientation = .down
        case "portrait-upside-down":  exifOrientation = .left
        default:                       exifOrientation = .right  // portrait + unknown
        }
        var ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            .oriented(exifOrientation)
        // AR keyframe downscale guard — normalise long edge to the budget so
        // every device produces a ~0.3 MP keyframe (cross-device-consistent
        // stitch memory).  Mirrors Android's downscale in YuvImageConverter.
        let kfLongEdge = max(ciImage.extent.width, ciImage.extent.height)
        if kfLongEdge > Self.arKeyframeMaxLongEdge {
            let kfScale = Self.arKeyframeMaxLongEdge / kfLongEdge
            ciImage = ciImage.transformed(by: CGAffineTransform(scaleX: kfScale, y: kfScale))
        }
        let context = CIContext(options: nil)
        guard let cgImage = context.createCGImage(
            ciImage,
            from: ciImage.extent
        ) else {
            completion(nil, NSError(
                domain: "RNImageStitcherARCapture",
                code: 2002,
                userInfo: [NSLocalizedDescriptionKey:
                    "Failed to render AR frame to CGImage."]
            ))
            return
        }
        let uiImage = UIImage(cgImage: cgImage)
        let clamped = max(0, min(100, quality))
        guard let jpegData = uiImage.jpegData(
            compressionQuality: CGFloat(clamped) / 100.0
        ) else {
            completion(nil, NSError(
                domain: "RNImageStitcherARCapture",
                code: 2003,
                userInfo: [NSLocalizedDescriptionKey:
                    "Failed to encode AR frame as JPEG."]
            ))
            return
        }

        let cleanedPath = Self.normalisePath(resolvedPath)
        let url = URL(fileURLWithPath: cleanedPath)
        // Best-effort delete an existing file at the same path —
        // vision-camera's takePhoto overwrites; we mirror that.
        try? FileManager.default.removeItem(at: url)
        do {
            try jpegData.write(to: url)
            completion([
                "path": cleanedPath,
                "width": cgImage.width,
                "height": cgImage.height,
                "isMirrored": false,
                "isRawPhoto": false,
            ], nil)
        } catch {
            completion(nil, error as NSError)
        }
    }

    /// Begin recording AR frames to an mp4 at `path`.  Completion
    /// fires once the AVAssetWriter is ready to accept frames; the
    /// per-frame append happens implicitly inside the ARSessionDelegate
    /// callback above.
    ///
    /// No audio: the panorama stitcher only consumes video frames,
    /// and audio adds AVCaptureSession setup that conflicts with
    /// ARKit's exclusive camera access.
    @objc public func startRecording(
        toPath rawPath: String,
        completion: @escaping (String?, NSError?) -> Void
    ) {
        let resolvedPath: String
        if rawPath.isEmpty {
            let dir = NSTemporaryDirectory()
            resolvedPath = (dir as NSString).appendingPathComponent(
                "RNImageStitcherAR-\(UUID().uuidString).mp4"
            )
        } else {
            resolvedPath = rawPath
        }
        // Quick existence check under lock — bail if already recording.
        writerLock.lock()
        let alreadyRecording = (self.assetWriter != nil)
        writerLock.unlock()
        if alreadyRecording {
            completion(nil, NSError(
                domain: "RNImageStitcherARCapture",
                code: 2010,
                userInfo: [NSLocalizedDescriptionKey:
                    "A recording is already in progress."]
            ))
            return
        }

        guard let frame = self.arSession.currentFrame else {
            completion(nil, NSError(
                domain: "RNImageStitcherARCapture",
                code: 2011,
                userInfo: [NSLocalizedDescriptionKey:
                    "AR session has no current frame — start the session first."]
            ))
            return
        }

        // Heavy AVFoundation setup happens OUTSIDE the lock so the
        // ARSession delegate's per-frame `try()` doesn't pile up
        // dropped frames during this ~10-30ms window.
        let pixelBuffer = frame.capturedImage
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let cleanedPath = Self.normalisePath(resolvedPath)
        let url = URL(fileURLWithPath: cleanedPath)
        try? FileManager.default.removeItem(at: url)

        do {
                let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
                // Encode H.264 at sensor dimensions (landscape).
                let videoSettings: [String: Any] = [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: width,
                    AVVideoHeightKey: height,
                ]
                let input = AVAssetWriterInput(
                    mediaType: .video,
                    outputSettings: videoSettings
                )
                input.expectsMediaDataInRealTime = true
                // NO rotation transform on the AR-recorded mp4.
                //
                // Phase 5 pose-driven stitching consumes the
                // ARKit pose's intrinsics (fx, fy, cx, cy) which
                // describe the SENSOR'S NATIVE LANDSCAPE coordinate
                // system.  If we apply a 90° rotation transform on
                // the mp4 and `extractFramesFromVideoAtPath` honours
                // it via `appliesPreferredTrackTransform=YES`, the
                // extracted frames come out PORTRAIT — orthogonal
                // to what the intrinsics describe.  cv::detail::Warper
                // then projects with mismatched geometry and the
                // output panorama is visibly rotated/sheared.
                //
                // Keeping frames in sensor-native landscape:
                //   - Intrinsics match the frame data → warp aligns
                //     correctly.
                //   - Output panorama comes out in landscape, which
                //     IS the natural orientation for a horizontal
                //     pan (wide × short).
                //
                // The feature-matched path (vision-camera mp4s) is
                // unaffected — it estimates intrinsics from features
                // so any orientation works internally.

                // Source-pixel attributes: declare the format the
                // adapter accepts.  ARKit emits NV12 (YpCbCr 4:2:0
                // bi-planar) — the adaptor handles this directly
                // without needing us to convert per frame.
                let attrs: [String: Any] = [
                    kCVPixelBufferPixelFormatTypeKey as String:
                        kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                    kCVPixelBufferWidthKey as String: width,
                    kCVPixelBufferHeightKey as String: height,
                ]
                let adaptor = AVAssetWriterInputPixelBufferAdaptor(
                    assetWriterInput: input,
                    sourcePixelBufferAttributes: attrs
                )

                guard writer.canAdd(input) else {
                    completion(nil, NSError(
                        domain: "RNImageStitcherARCapture",
                        code: 2012,
                        userInfo: [NSLocalizedDescriptionKey:
                            "AVAssetWriter rejected the video input — codec/format mismatch."]
                    ))
                    return
                }
                writer.add(input)

                let startTime = CMTime(
                    seconds: frame.timestamp,
                    preferredTimescale: 1_000_000
                )
                writer.startWriting()
                writer.startSession(atSourceTime: .zero)

                // Briefly hold the lock to swap in the new writer
                // state.  ARSession delegate's per-frame `try()`
                // will see consistent state once we release.
                self.writerLock.lock()
                self.assetWriter = writer
                self.videoInput = input
                self.pixelBufferAdaptor = adaptor
                self.recordingStartTime = startTime
                self.writerLock.unlock()

                // Reset the pose log so this recording's frames
                // correlate with a fresh window of poses; the
                // stitcher matches video frames to poses by
                // timestamp from recording start.
                self.poseLogQueue.async(flags: .barrier) { [weak self] in
                    self?.poseLog.removeAll(keepingCapacity: true)
                }

                NSLog("[RNImageStitcherARCapture] startRecording: %dx%d → %@",
                      width, height, cleanedPath)
                completion(cleanedPath, nil)
        } catch {
            completion(nil, error as NSError)
        }
    }

    /// Finalise the in-progress recording and resolve with the
    /// resulting file's metadata (path, duration, size, width,
    /// height) — shape mirrors vision-camera's VideoFile so JS
    /// consumers don't branch.
    @objc public func stopRecording(
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        // Briefly acquire the lock just to capture + clear the
        // writer state.  Strong locals keep the writer + input
        // alive across the lock release for the slow finalise.
        // Once self.assetWriter is nil, any in-flight delegate
        // `try()` that succeeds finds nil writer state and skips —
        // no further appends can race with finishWriting.
        writerLock.lock()
        let writer = self.assetWriter
        let input = self.videoInput
        self.assetWriter = nil
        self.videoInput = nil
        self.pixelBufferAdaptor = nil
        self.recordingStartTime = nil
        writerLock.unlock()

        guard let writer = writer, let input = input else {
            completion(nil, NSError(
                domain: "RNImageStitcherARCapture",
                code: 2020,
                userInfo: [NSLocalizedDescriptionKey:
                    "No active recording to stop."]
            ))
            return
        }

        input.markAsFinished()
        let outputURL = writer.outputURL
        writer.finishWriting {
            let path = outputURL.path
            let asset = AVAsset(url: outputURL)
            let durationSec = CMTimeGetSeconds(asset.duration)
            let fileSize = (try? FileManager.default
                .attributesOfItem(atPath: path))?[.size] as? Int ?? 0
            let track = asset.tracks(withMediaType: .video).first
            let naturalSize = track?.naturalSize ?? .zero
            NSLog("[RNImageStitcherARCapture] stopRecording: %.2fs, %lld bytes",
                  durationSec, Int64(fileSize))
            completion([
                "path": path,
                "duration": durationSec,
                "size": fileSize,
                "width": Int(naturalSize.width),
                "height": Int(naturalSize.height),
            ], nil)
        }
    }

    // MARK: - Helpers

    /// Strip a `file://` scheme some callers attach — same logic
    /// the OpenCV stitcher uses, kept local here so RNSARSession
    /// stays independent of the OpenCV path.
    private static func normalisePath(_ path: String) -> String {
        if path.hasPrefix("file://") {
            return String(path.dropFirst("file://".count))
        }
        return path
    }

    private func makePose(from frame: ARFrame) -> RNSARFramePose {
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

        let mappedState: RNSARTrackingState
        switch frame.camera.trackingState {
        case .normal:        mappedState = .tracking
        case .limited:       mappedState = .limited
        case .notAvailable:  mappedState = .notAvailable
        }

        return RNSARFramePose(
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
