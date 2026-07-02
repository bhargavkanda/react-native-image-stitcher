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
import QuartzCore  // CACurrentMediaTime (monotonic clock for onArFrame throttle)

// V15.0c.4 — FAULT-level os_log on the same subsystem/category the
// slit-scan engine uses, so Console.app's filter for `category =
// slitscan` shows ARKit plane events alongside engine events.
// FAULT survives os_log's default-level rate limiting; NSLog is
// "default" level and gets coalesced/dropped under burst.
fileprivate let arSessionDiagLog = OSLog(
    subsystem: "com.tiger.retailens.sdk",
    category: "slitscan"
)


// v0.18.0 — `onArFrame` LIGHT-metadata channel.  The AR session posts
// this notification (carrying the `ARFrameMeta`-shaped dictionary) per
// throttled frame; `RNSARSessionBridge` (an RCTEventEmitter) observes it
// and re-emits as the JS `RNImageStitcherARFrame` device event.  We go
// via NotificationCenter — rather than the bridge holding a reference to
// the session singleton — so the framework-free engine pattern (used by
// IncrementalStitcher) is preserved.
public extension Notification.Name {
    static let retailensARFrameMeta =
        Notification.Name("RNImageStitcherARFrame")
}


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
    // NOTE: the AR keyframe long-edge budget lives in the keyframe collector
    // (`kKeyframeMaxLongEdge = 1280` in OpenCVKeyframeCollector.mm), applied
    // in `saveKeyframe` before the JPEG is written — so the stitch keyframe
    // size is independent of the AR video format / `highResCapture`.

    /// Latest tracking state.  Read by JS for UI feedback.
    @objc public private(set) var currentTrackingState: RNSARTrackingState = .notAvailable

    /// Whether the session is currently running.
    @objc public private(set) var isRunning: Bool = false

    // ──────────────────────────────────────────────────────────────
    // Scene reconstruction (ARKit mesh) — opt-in
    // ──────────────────────────────────────────────────────────────
    /// Whether ARKit scene reconstruction (the LiDAR mesh,
    /// `ARMeshAnchor`s) should be enabled.  Off by default — meshing
    /// is costly (extra LiDAR processing + per-frame ARMeshAnchor
    /// churn) and only the StitcherFrame `meshGeometry` consumer wants
    /// it.  Driven from JS via
    /// `NativeModules.RNSARSession.setSceneReconstructionEnabled(bool)`
    /// (the <Camera> `enableMesh` prop).  When toggled while a session
    /// is live, the session is reconfigured + re-run in place.
    ///
    /// Honored both at session creation (`start()`) and on live toggle
    /// (`setSceneReconstructionEnabled`).  Independent of the depth
    /// `frameSemantics`/planeDetection config — those are left
    /// untouched.  No-ops on devices without
    /// `supportsSceneReconstruction` (the flag is stored but produces
    /// no mesh).
    @objc public private(set) var isSceneReconstructionEnabled: Bool = false

    // ──────────────────────────────────────────────────────────────
    // Feature-point cloud — opt-in
    // ──────────────────────────────────────────────────────────────
    /// Whether the ARKit SLAM raw feature-point cloud
    /// (`ARFrame.rawFeaturePoints`) should be exposed to AR plugins via
    /// `RNISARFrameContext.featurePoints`.  Off by default — building the
    /// `[simd_float3]` value copy per frame has a small but non-zero
    /// cost, and most apps don't need it.  Driven from JS via
    /// `NativeModules.RNSARSession.setFeaturePointsEnabled(bool)`
    /// (the `<Camera>` `enableFeaturePoints` prop).  Available on ALL
    /// ARKit-capable devices — no LiDAR required.
    @objc public private(set) var isFeaturePointsEnabled: Bool = false

    // ──────────────────────────────────────────────────────────────
    // v0.20.3 — opt-in high-resolution photo capture (highResCapture prop)
    // ──────────────────────────────────────────────────────────────
    /// When true, `pickVideoFormat` selects the smallest video format that
    /// supports `captureHighResolutionFrame` (so `takePhoto` returns a true
    /// full-resolution still — for document OCR / detail capture).  When
    /// false (default), it selects the absolute smallest 4:3 format — the
    /// long-standing behaviour, cheapest for the panorama-stitch path (whose
    /// keyframes are downscaled to a fixed budget regardless).  Driven from
    /// JS via `NativeModules.RNSARSession.setHighResCaptureEnabled(bool)`
    /// (the `<Camera>` `highResCapture` prop / DocumentScanCamera opts in).
    /// Stored so `start()` and the live-reconfigure path read one source of
    /// truth.  iOS-only effect; Android has no equivalent high-res capture.
    @objc public private(set) var prefersHighResCapture: Bool = false

    // ──────────────────────────────────────────────────────────────
    // v0.18.0 — configurable plane detection (planeDetection prop)
    // ──────────────────────────────────────────────────────────────
    /// Which plane orientations ARKit should detect, driven from JS via
    /// `NativeModules.RNSARSession.setPlaneDetection(mode)` (the
    /// `<Camera>` `planeDetection` prop).  Default `[.vertical]` preserves
    /// the plane-projected stitch path's long-standing behaviour.  Stored
    /// as the raw ARKit OptionSet so `start()` and the live-reconfigure
    /// paths (`setSceneReconstructionEnabled` / `setPlaneDetection`) read
    /// one source of truth.
    private var planeDetectionOptions:
        ARWorldTrackingConfiguration.PlaneDetection = [.vertical]

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

    // ──────────────────────────────────────────────────────────────
    // v0.18.0 — `onArFrame` LIGHT-metadata channel
    // ──────────────────────────────────────────────────────────────
    //
    // When a host supplies the `<Camera onArFrame={...}>` prop, the TS
    // layer calls `setArFrameMetaEnabled(true, intervalMs)`; on
    // unmount / prop-removal it calls `(false, _)`.  While enabled, each
    // ARFrame's per-frame path builds the LIGHT `ARFrameMeta` dictionary
    // (no pixel / vertex / face bytes — see
    // `CameraFrameHostObject.lightArFrameMetaFromARFrame:pose:`) and
    // posts it on `.retailensARFrameMeta` for the bridge to re-emit.
    //
    // Throttle: emit at most one meta per `arFrameMetaIntervalSec`
    // (default 0.1s ≈ 10Hz) using `CACurrentMediaTime()` (monotonic,
    // unaffected by wall-clock changes).  Both flags are touched only on
    // the ARSession delegate thread (the per-frame path) + the bridge
    // thread (the setter); guarded by `arFrameMetaLock`.
    private var arFrameMetaEnabled: Bool = false
    private var arFrameMetaIntervalSec: TimeInterval = 0.1
    private var lastArFrameMetaEmit: TimeInterval = 0
    private let arFrameMetaLock = NSLock()

    // ──────────────────────────────────────────────────────────────
    // v0.19.0 — native AR plugin framework (RNISARPluginRegistry)
    // ──────────────────────────────────────────────────────────────
    //
    // While the plugin registry is NON-EMPTY, the per-frame path builds a
    // `RNISARFrameContext` once and calls each registered plugin's
    // `process(_:)` on the AR (delegate) thread (see `invokeArPlugins`).
    // Non-nil SYNC results are cached here so the throttled `onArFrame`
    // meta build can fold them in under `plugins: { [name]: result }`
    // without re-running plugins.  Zero-plugin apps skip the whole path
    // (the registry's `isEmpty` gate), so they pay nothing.
    //
    // Written on the AR thread (per-frame) and read on the same thread
    // (the meta build runs inline in `session(_:didUpdate:)`), but guarded
    // anyway for defensiveness against any future off-thread reader.
    private var latestPluginSyncResults: [String: Any] = [:]
    private let pluginSyncResultsLock = NSLock()

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
        // Build the shared base config (depth semantics + plane detection
        // + autofocus + scene reconstruction + 4:3 video format).  See
        // `makeBaseConfiguration()` — centralised so `start()` and the
        // live-reconfigure paths can't drift.  `start()` is the only path
        // that resets tracking + removes existing anchors.
        let config = makeBaseConfiguration()
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

        // v0.8.0 Phase 3c/4b — wire the AR worklet runtime.  The
        // per-frame ingest is routed through `RNSARWorkletRuntime`
        // (see `session(_:didUpdate:)` below) instead of calling the
        // incremental consumer directly.  Two steps here:
        //
        //   1. `installIfNeeded()` lazily constructs the worklet
        //      runtime's `JsiWorkletContext` + its serial dispatch
        //      queue (idempotent; safe across redundant start() calls
        //      and multiple <Camera> mounts).
        //   2. `setFirstPartyCallback:` installs the EXISTING first-
        //      party stitching behaviour as a closure.  The runtime
        //      invokes this synchronously on the delegate (caller)
        //      thread per frame — byte-identical to the old direct
        //      `consumeFrame(...)` call — and then fans the frame out
        //      to any host-registered worklets asynchronously on its
        //      own queue.
        //
        // The callback captures `self` weakly so the runtime singleton
        // (process-lifetime) never keeps this session alive.  It reads
        // `incrementalConsumer` (itself weak) at call time, so a torn-
        // down consumer simply no-ops — same semantics as the prior
        // `incrementalConsumer?.consumeFrame(...)` optional-chain.
        let workletRuntime = RNSARWorkletRuntime.shared()
        workletRuntime.installIfNeeded()
        workletRuntime.setFirstPartyCallback { [weak self] arFrame, pose in
            self?.incrementalConsumer?.consumeFrame(
                pixelBuffer: arFrame.capturedImage, pose: pose)
        }
    }

    @objc public func stop() {
        guard isRunning else { return }
        arSession.pause()
        isRunning = false
        currentTrackingState = .notAvailable
        clearPoseLog()
        // v0.8.0 Phase 3c — clear the worklet runtime's first-party
        // callback so the (process-lifetime) runtime singleton doesn't
        // hold the closure (and transitively the consumer reference)
        // between captures.  `start()` reinstalls it on the next run.
        // Idempotent; safe even if start() never ran the install path.
        RNSARWorkletRuntime.shared().setFirstPartyCallback(nil)
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
        // v0.19.0 — drop any cached SYNC plugin results so the next
        // capture's `onArFrame` meta doesn't surface stale plugin output
        // before the first frame of the new session runs the plugins.
        pluginSyncResultsLock.lock()
        latestPluginSyncResults = [:]
        pluginSyncResultsLock.unlock()
    }

    /// Build the `ARWorldTrackingConfiguration` shared by `start()` and
    /// the live-reconfigure paths (`setSceneReconstructionEnabled`,
    /// `setPlaneDetection`).  Single source of truth so the call sites
    /// can't drift — every reconfigure preserves the SAME depth
    /// frameSemantics, current plane-detection mode, autofocus, scene
    /// reconstruction, and 4:3 video-format preference.  Only the `run`
    /// OPTIONS differ at the call site (`start()` resets tracking; the
    /// live toggles do not).
    ///
    /// - sceneDepth + smoothedSceneDepth: enable both when supported so
    ///   `ARFrame.sceneDepth` populates the StitcherFrame `arDepth` field;
    ///   each is gated by `supportsFrameSemantics` so this no-ops on
    ///   non-LiDAR devices instead of throwing at `run()`.
    /// - planeDetection: from `planeDetectionOptions` (default `[.vertical]`
    ///   for the plane-projected stitch path; set via `setPlaneDetection`).
    /// - autofocus: on, for feature tracking on shelves with small text.
    /// - sceneReconstruction: from the stored `isSceneReconstructionEnabled`
    ///   flag (no-ops on non-LiDAR devices).
    /// - videoFormat: from `pickVideoFormat(preferHighRes:)` — smallest 4:3
    ///   by default (cheap live stream; stitch keyframes are downscaled to a
    ///   fixed budget regardless), or the smallest high-res-capable format
    ///   when the `highResCapture` prop is on (for full-res `takePhoto`).
    private func makeBaseConfiguration() -> ARWorldTrackingConfiguration {
        let config = ARWorldTrackingConfiguration()
        var depthSemantics: ARConfiguration.FrameSemantics = []
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            depthSemantics.insert(.sceneDepth)
        }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            depthSemantics.insert(.smoothedSceneDepth)
        }
        config.frameSemantics = depthSemantics
        config.planeDetection = planeDetectionOptions
        config.isAutoFocusEnabled = true
        Self.applySceneReconstruction(to: config,
                                      enabled: isSceneReconstructionEnabled)
        if let fmt = Self.pickVideoFormat(preferHighRes: prefersHighResCapture) {
            config.videoFormat = fmt
        }
        return config
    }

    /// Choose the AR video format.
    ///
    /// - When `preferHighRes` is true (the `highResCapture` prop — document
    ///   OCR / detail capture): among formats that support high-resolution
    ///   one-off capture (`isRecommendedForHighResolutionFrameCapturing`,
    ///   iOS 16+), pick the most-4:3 + smallest LIVE resolution.  This keeps
    ///   the live stream as small as the high-res feature allows while making
    ///   `captureHighResolutionFrame` return a true full-res still in
    ///   `takePhoto`.  The high-res capture is a separate one-off photo — it
    ///   does not raise the live frame rate.  (On some devices the smallest
    ///   high-res-capable live format is a notch larger than the absolute
    ///   smallest 4:3, so the live frame can be bigger when this is on.)
    /// - When `preferHighRes` is false (default — panorama stitching / plain
    ///   AR): pick the absolute smallest 4:3 format.  Cheapest live stream;
    ///   stitch keyframes are downscaled to a fixed budget
    ///   (`kKeyframeMaxLongEdge` in OpenCVKeyframeCollector) regardless, so
    ///   the format never affects stitch quality/memory.
    private static func pickVideoFormat(preferHighRes: Bool) -> ARConfiguration.VideoFormat? {
        let formats = ARWorldTrackingConfiguration.supportedVideoFormats
        func aspectErr(_ f: ARConfiguration.VideoFormat) -> CGFloat {
            abs(f.imageResolution.width / f.imageResolution.height - 4.0 / 3.0)
        }
        // most-4:3, then smallest live area.
        func smaller(_ a: ARConfiguration.VideoFormat, _ b: ARConfiguration.VideoFormat) -> Bool {
            let da = aspectErr(a), db = aspectErr(b)
            if abs(da - db) > 0.001 { return da < db }
            return a.imageResolution.width * a.imageResolution.height
                 < b.imageResolution.width * b.imageResolution.height
        }
        if preferHighRes, #available(iOS 16.0, *) {
            let hiRes = formats.filter { $0.isRecommendedForHighResolutionFrameCapturing }
            if let fmt = hiRes.min(by: smaller) {
                NSLog("[RNIS] AR videoFormat %.0fx%.0f (high-res capture: YES)",
                      fmt.imageResolution.width, fmt.imageResolution.height)
                return fmt
            }
        }
        let fmt = formats.min(by: smaller)
        if let fmt = fmt {
            NSLog("[RNIS] AR videoFormat %.0fx%.0f (high-res capture: %@)",
                  fmt.imageResolution.width, fmt.imageResolution.height,
                  preferHighRes ? "NO — none high-res-capable" : "OFF — smallest 4:3")
        }
        return fmt
    }

    /// Set the ARWorldTrackingConfiguration's `sceneReconstruction`
    /// from a desired-enabled flag, gated on device support.  Prefers
    /// `.meshWithClassification` (per-face semantic labels — what the
    /// StitcherFrame `meshGeometry.classifications` consumer wants),
    /// falling back to plain `.mesh`, and `.none` when disabled or
    /// unsupported.  Centralised so `start()` and the live-toggle path
    /// stay consistent.
    private static func applySceneReconstruction(
        to config: ARWorldTrackingConfiguration,
        enabled: Bool
    ) {
        guard enabled else {
            // `ARWorldTrackingConfiguration.SceneReconstruction` is an
            // OptionSet — the empty set `[]` means "no meshing"
            // (`.none` is unavailable on OptionSets).
            config.sceneReconstruction = []
            return
        }
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(
            .meshWithClassification) {
            config.sceneReconstruction = .meshWithClassification
        } else if ARWorldTrackingConfiguration.supportsSceneReconstruction(
            .mesh) {
            config.sceneReconstruction = .mesh
        } else {
            // No LiDAR / unsupported — leave meshing off (empty set).
            config.sceneReconstruction = []
        }
    }

    /// Toggle ARKit scene reconstruction (LiDAR mesh / `ARMeshAnchor`s).
    /// Stores the flag so it's honored by the next `start()`, and — if a
    /// session is ALREADY running — reconfigures + re-runs the live
    /// session in place so the toggle takes effect immediately.
    ///
    /// Reconfiguration rebuilds the SAME config `start()` builds (depth
    /// frameSemantics + vertical planeDetection + autofocus + 4:3 video
    /// format) so we don't accidentally drop those when flipping the
    /// mesh flag.  We re-run WITHOUT `[.resetTracking,
    /// .removeExistingAnchors]` so the existing world map, pose log, and
    /// any latched plane survive the toggle (only the mesh option
    /// changes).
    ///
    /// No-op on devices without scene-reconstruction support: the flag
    /// is still stored (cheap, harmless) but `applySceneReconstruction`
    /// leaves the config `.none`.
    @objc public func setSceneReconstructionEnabled(_ enabled: Bool) {
        isSceneReconstructionEnabled = enabled
        os_log(.fault, log: arSessionDiagLog,
               "[scene-mesh] setSceneReconstructionEnabled(%{public}@) running=%{public}@ supported=%{public}@",
               enabled ? "true" : "false",
               isRunning ? "true" : "false",
               ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
                   ? "true" : "false")

        guard isRunning else { return }

        // Rebuild the live config from the shared builder — picks up the
        // new mesh flag (just stored) along with the current depth
        // semantics + plane-detection mode, so a mesh toggle never
        // silently drops those.  Re-run in place — NO reset/removeAnchors
        // so existing tracking, pose log, and latched plane survive.
        let config = makeBaseConfiguration()
        arSession.run(config)
    }

    /// Toggle opt-in ARKit feature-point cloud exposure to AR plugins
    /// (the `<Camera>` `enableFeaturePoints` prop, routed via
    /// `NativeModules.RNSARSession.setFeaturePointsEnabled(bool)`).  Stores
    /// the flag; takes effect on the very next frame `invokeArPlugins`
    /// processes.  No ARKit session reconfiguration needed —
    /// `rawFeaturePoints` is populated by the SLAM tracker on every ARFrame
    /// on all ARKit-capable devices regardless of the session config.
    @objc public func setFeaturePointsEnabled(_ enabled: Bool) {
        isFeaturePointsEnabled = enabled
    }

    /// Toggle opt-in high-resolution photo capture (the `<Camera>`
    /// `highResCapture` prop, routed via
    /// `NativeModules.RNSARSession.setHighResCaptureEnabled(bool)`).  Stores
    /// the flag (honored by the next `start()`) and, if a session is live,
    /// rebuilds the config — which re-runs `pickVideoFormat` with the new
    /// flag — and re-runs in place (no reset; tracking / pose log / latched
    /// plane survive).  Mirrors `setSceneReconstructionEnabled`.
    @objc public func setHighResCaptureEnabled(_ enabled: Bool) {
        prefersHighResCapture = enabled
        guard isRunning else { return }
        let config = makeBaseConfiguration()
        arSession.run(config)
    }

    /// Set which plane orientations ARKit detects — the JS `<Camera>`
    /// `planeDetection` prop, routed via
    /// `NativeModules.RNSARSession.setPlaneDetection(mode)`.  Stores the
    /// mode (honored by the next `start()`) and, if a session is live,
    /// reconfigures + re-runs in place (no reset — tracking / pose log /
    /// latched plane survive).
    ///
    /// `mode`: `"vertical"` (default), `"horizontal"`, or `"both"`.
    /// Anything else falls back to `"vertical"`.
    ///
    /// NOTE on the legacy vertical-plane latch: the V15 plane-projected
    /// stitch latches the first camera-facing VERTICAL plane.  Choosing
    /// `"horizontal"` drops vertical detection, so that latch won't fire
    /// — an explicit opt-out (the caller asked for horizontal-only).
    /// `"vertical"` and `"both"` keep it working.
    @objc public func setPlaneDetection(_ mode: String) {
        switch mode {
        case "horizontal": planeDetectionOptions = [.horizontal]
        case "both":       planeDetectionOptions = [.horizontal, .vertical]
        default:           planeDetectionOptions = [.vertical]  // "vertical" + fallback
        }
        os_log(.fault, log: arSessionDiagLog,
               "[plane-detect] setPlaneDetection(%{public}@) running=%{public}@",
               mode, isRunning ? "true" : "false")
        guard isRunning else { return }
        // Reconfigure in place — NO reset/removeAnchors so existing
        // tracking + pose log survive the plane-mode change.
        let config = makeBaseConfiguration()
        arSession.run(config)
    }

    /// v0.18.0 — toggle the `onArFrame` LIGHT-metadata channel.  Called
    /// from JS (via the bridge) with `true` + the throttle interval when a
    /// host supplies `<Camera onArFrame={...}>`, and `false` on
    /// unmount / prop-removal.  Idempotent.
    ///
    /// `intervalMs` clamps to a 16ms floor (≈60Hz, ARKit's max delivery
    /// rate) — a smaller value can't produce more frames, and 0 would
    /// disable throttling entirely (one emit per ARFrame).  Resetting the
    /// `lastArFrameMetaEmit` clock on enable means the first frame after
    /// `onArFrame` mounts emits immediately rather than waiting out a
    /// stale interval from a previous session.
    @objc public func setArFrameMetaEnabled(_ enabled: Bool, intervalMs: Double) {
        arFrameMetaLock.lock()
        arFrameMetaEnabled = enabled
        arFrameMetaIntervalSec = max(0.016, intervalMs / 1000.0)
        if enabled {
            // Emit the next frame immediately (don't carry a stale clock).
            lastArFrameMetaEmit = 0
        }
        arFrameMetaLock.unlock()
        os_log(.fault, log: arSessionDiagLog,
               "[onArFrame] setArFrameMetaEnabled(%{public}@) interval=%.0fms",
               enabled ? "true" : "false", intervalMs)
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
        //
        // `dispatchFrame(_:pose:)` runs the first-party callback
        // (installed in `start()`, which wraps the same
        // `incrementalConsumer.consumeFrame(...)` path) SYNCHRONOUSLY on
        // this delegate thread — preserving the pool-reuse contract —
        // and THEN fans the frame out to any host-registered worklets
        // ASYNCHRONOUSLY on the runtime's own queue.  Do NOT also call
        // `consumeFrame` here: dispatchFrame already drives it, and
        // double-consuming would ingest each frame twice.
        RNSARWorkletRuntime.shared().dispatchFrame(frame, pose: pose)

        // v0.19.0 — native AR plugin framework.  When the registry is
        // non-empty, build the per-frame `RNISARFrameContext` once and run
        // every registered plugin's `process(_:)` SYNCHRONOUSLY on this AR
        // thread (so the live pixel/depth buffers are valid for the call).
        // Caches non-nil SYNC results for the meta build below.  Cheap
        // no-op when no plugins are registered (the common case).  Runs
        // BEFORE `maybeEmitArFrameMeta` so the throttled `onArFrame` meta
        // can fold in this frame's freshest plugin results.
        invokeArPlugins(frame, pose: pose)

        // v0.18.0 — `onArFrame` LIGHT-metadata channel.  Gated +
        // throttled; builds the ARFrameMeta dictionary and posts it for
        // the bridge to re-emit.  Cheap no-op when disabled (the common
        // case — most hosts don't supply `onArFrame`).
        maybeEmitArFrameMeta(frame, pose: pose)

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
        // Capture a HIGH-RESOLUTION still.  ARKit's live `capturedImage` is the
        // small AR video format (and the SDK picks the SMALLEST 4:3 format), far
        // too low-res for document OCR / detail capture.
        // `captureHighResolutionFrame` (iOS 16+) grabs a full-resolution photo
        // WITHOUT leaving the AR session.  Fall back to the live frame on older
        // OS or if the high-res grab fails.
        let encode: (CVPixelBuffer) -> Void = { [weak self] pixelBuffer in
            self?.encodeArPhoto(
                pixelBuffer: pixelBuffer,
                toPath: resolvedPath,
                quality: quality,
                orientation: orientation,
                completion: completion
            )
        }
        if #available(iOS 16.0, *) {
            arSession.captureHighResolutionFrame { [weak self] hiResFrame, error in
                if let hiResFrame = hiResFrame {
                    encode(hiResFrame.capturedImage)
                } else if let live = self?.arSession.currentFrame {
                    encode(live.capturedImage)
                } else {
                    completion(nil, NSError(
                        domain: "RNImageStitcherARCapture",
                        code: 2001,
                        userInfo: [NSLocalizedDescriptionKey:
                            "AR high-res capture failed: \(error?.localizedDescription ?? "no current frame")."]
                    ))
                }
            }
        } else {
            guard let frame = arSession.currentFrame else {
                completion(nil, NSError(
                    domain: "RNImageStitcherARCapture",
                    code: 2001,
                    userInfo: [NSLocalizedDescriptionKey:
                        "AR session has no current frame — start the session first."]
                ))
                return
            }
            encode(frame.capturedImage)
        }
    }

    /// Encode an AR pixel buffer → an oriented, FULL-RESOLUTION JPEG at `path`.
    /// Unlike stitch keyframes, a user / document photo is NOT downscaled — OCR
    /// and detail capture need the full resolution that
    /// `captureHighResolutionFrame` provides.
    ///
    /// Orientation maps the JS `useDeviceOrientation()` value → CIImage
    /// orientation (empirical, on-device 2026-05-28): portrait → .right,
    /// landscape-left → .up, landscape-right → .down,
    /// portrait-upside-down → .left.  Without this, AR-mode landscape photos
    /// come out upside-down.
    private func encodeArPhoto(
        pixelBuffer: CVPixelBuffer,
        toPath resolvedPath: String,
        quality: Int,
        orientation: String,
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        let exifOrientation: CGImagePropertyOrientation
        switch orientation {
        case "landscape-left":        exifOrientation = .up
        case "landscape-right":       exifOrientation = .down
        case "portrait-upside-down":  exifOrientation = .left
        default:                       exifOrientation = .right  // portrait + unknown
        }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer).oriented(exifOrientation)
        let context = CIContext(options: nil)
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else {
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

    /// v0.18.0 — build + post the LIGHT `onArFrame` metadata for this
    /// frame, gated on `arFrameMetaEnabled` and throttled to
    /// `arFrameMetaIntervalSec`.  Runs on the ARSession delegate thread
    /// (the per-frame `didUpdate` path).
    ///
    /// The gate + throttle check is taken under `arFrameMetaLock` (a
    /// microsecond hold); the actual meta build (the slightly more
    /// expensive part — anchor transpose, depth/mesh probes) happens
    /// OUTSIDE the lock so the bridge's `setArFrameMetaEnabled` never
    /// blocks behind a frame build.  Posting on NotificationCenter is
    /// synchronous but the observer (`RNSARSessionBridge.handle…`) just
    /// hops to the main queue for the actual JS emit, so this returns
    /// quickly and never blocks ARKit's delegate.
    ///
    /// `CACurrentMediaTime()` is the monotonic media clock (same unit as
    /// the throttle interval); immune to wall-clock adjustments.
    private func maybeEmitArFrameMeta(_ frame: ARFrame, pose: RNSARFramePose) {
        arFrameMetaLock.lock()
        let enabled = arFrameMetaEnabled
        let interval = arFrameMetaIntervalSec
        let last = lastArFrameMetaEmit
        let now = CACurrentMediaTime()
        let due = enabled && (last == 0 || (now - last) >= interval)
        if due {
            // Reserve this slot before releasing the lock so a burst of
            // delegate callbacks can't all pass the throttle gate.
            lastArFrameMetaEmit = now
        }
        arFrameMetaLock.unlock()

        guard due else { return }

        // Build the LIGHT meta (no pixel/vertex/face bytes).  Reuses the
        // Obj-C++ extraction helpers + the shared C++ extraction-config
        // gating (depth/anchors/mesh ⇐ enableDepth/enableAnchors/enableMesh).
        let meta = CameraFrameHostObject.lightArFrameMeta(from: frame, pose: pose)

        // v0.19.0 — fold in any SYNC plugin results captured by
        // `invokeArPlugins` for the freshest frames.  Only attach the
        // `plugins` key when there's at least one result, so the common
        // (no-plugin) meta shape is unchanged.  Snapshot under the lock,
        // then bridge into a fresh dictionary copy.
        pluginSyncResultsLock.lock()
        let pluginResults = latestPluginSyncResults
        pluginSyncResultsLock.unlock()
        let userInfo: [AnyHashable: Any]
        if pluginResults.isEmpty {
            userInfo = meta
        } else {
            var withPlugins = meta
            withPlugins["plugins"] = pluginResults
            userInfo = withPlugins
        }

        NotificationCenter.default.post(
            name: .retailensARFrameMeta,
            object: nil,
            userInfo: userInfo
        )
    }

    /// v0.19.0 — run all registered native AR plugins for this frame.
    /// Gated on the registry being NON-EMPTY (the cheap `isEmpty` check) so
    /// zero-plugin apps skip the context build entirely.  When plugins are
    /// present, builds ONE `RNISARFrameContext` (zero-copy view of the
    /// frame's live buffers + the already-built anchor dicts) and calls
    /// each plugin's `process(_:)` SYNCHRONOUSLY on this AR (delegate)
    /// thread — so the live `pixelBuffer` / `depthBuffer` are valid for the
    /// call (the plugin must copy before offloading; see the protocol
    /// docstring).  Non-nil SYNC results are cached in
    /// `latestPluginSyncResults` for the throttled `onArFrame` meta to fold
    /// in; ASYNC results arrive later via `RNISARPluginRegistry.emit`.
    private func invokeArPlugins(_ frame: ARFrame, pose: RNSARFramePose) {
        let registry = RNISARPluginRegistry.shared
        guard !registry.isEmpty else { return }
        let plugins = registry.plugins()
        guard !plugins.isEmpty else { return }

        // depthBuffer: expose the live sceneDepth map ONLY when the
        // `<Camera enableDepth>` prop is on (gating read in Obj-C++ so the
        // C++ extraction-config header stays out of Swift).  Prefer
        // `sceneDepth`, fall back to `smoothedSceneDepth` — same precedence
        // as the full extraction path.
        var depthBuffer: CVPixelBuffer? = nil
        if CameraFrameHostObject.arExtractionDepthEnabled() {
            if let dd = frame.sceneDepth ?? frame.smoothedSceneDepth {
                depthBuffer = dd.depthMap
            }
        }

        // anchors: reuse the EXACT light dicts the `onArFrame` meta builds
        // (gated on `enableAnchors`; empty otherwise) — DRY single source.
        let anchorDicts = CameraFrameHostObject.arAnchorDicts(from: frame)
        let anchors = anchorDicts as? [[String: Any]] ?? []

        // featurePoints: expose the ARKit SLAM raw feature-point cloud ONLY
        // when the `<Camera enableFeaturePoints>` prop is on.  No LiDAR
        // required — rawFeaturePoints is populated by the SLAM visual tracker
        // on all ARKit devices.  `points` is a `[simd_float3]` in world
        // space (ARKit right-handed Y-up, metres).  This is a value copy, so
        // unlike pixelBuffer/depthBuffer the array is safe to retain beyond
        // process(_:) — but the protocol comment still warns to copy before
        // offloading to keep the semantics consistent across all fields.
        let featurePoints: [simd_float3]? = isFeaturePointsEnabled
            ? frame.rawFeaturePoints?.points
            : nil

        let context = RNISARFrameContext(
            pixelBuffer: frame.capturedImage,
            timestampNs: frame.timestamp * 1e9,
            fx: pose.fx, fy: pose.fy, cx: pose.cx, cy: pose.cy,
            imageWidth: pose.imageWidth, imageHeight: pose.imageHeight,
            poseRotation: [pose.qx, pose.qy, pose.qz, pose.qw],
            poseTranslation: [pose.tx, pose.ty, pose.tz],
            trackingState: Self.trackingStateString(pose.trackingState),
            depthBuffer: depthBuffer,
            anchors: anchors,
            featurePoints: featurePoints
        )

        var syncResults: [String: Any] = [:]
        for plugin in plugins {
            // Defensive: a plugin throwing/crashing in `process` would take
            // down the AR thread, but Swift has no try/catch for non-Error
            // crashes — the contract is that plugins are well-behaved.  We
            // simply collect non-nil results keyed by the plugin's name.
            if let result = plugin.process(context) {
                syncResults[plugin.name()] = result
            }
        }

        pluginSyncResultsLock.lock()
        latestPluginSyncResults = syncResults
        pluginSyncResultsLock.unlock()
    }

    /// Map the SDK's `RNSARTrackingState` to the same string the
    /// `onArFrame` meta + `CameraFrame.trackingState` use, so plugins see a
    /// consistent vocabulary.
    private static func trackingStateString(_ s: RNSARTrackingState) -> String {
        switch s {
        case .tracking:     return "normal"
        case .limited:      return "limited"
        case .initialising: return "limited"
        case .notAvailable: return "notAvailable"
        }
    }

    private func makePose(from frame: ARFrame) -> RNSARFramePose {
        // ARKit's transform is a 4x4 matrix; extract translation
        // (last column) and rotation (top-left 3x3 → quaternion).
        let t = frame.camera.transform
        let translation = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        // simd_quatf from a 4x4 matrix uses the rotational part.
        let q = simd_quatf(t)

        // Camera intrinsics.  `simd_float3x3` subscripts as k[column][row]
        // (COLUMN-MAJOR).  ARKit's K is:
        //   column 0 = (fx, 0, 0), column 1 = (0, fy, 0), column 2 = (cx, cy, 1)
        // so fx = k[0][0], fy = k[1][1], cx = k[2][0], cy = k[2][1].
        // (Pre-0.20.1 bug: read cx/cy as k[0][2]/k[1][2] = 0 — fx/fy survived
        // because they're on the diagonal, so the principal point came through
        // as 0,0 and broke any pixel↔world unprojection.)
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
            cx: Double(k[2][0]),
            cy: Double(k[2][1]),
            imageWidth: Int(imageRes.width),
            imageHeight: Int(imageRes.height),
            timestampMs: frame.timestamp * 1000.0,
            trackingState: mappedState,
        )
    }
}
