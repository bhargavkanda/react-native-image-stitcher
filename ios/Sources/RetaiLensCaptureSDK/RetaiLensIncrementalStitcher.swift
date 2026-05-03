// SPDX-License-Identifier: UNLICENSED
//
// RetaiLensIncrementalStitcher — Swift-side engine for the live
// panorama-stitching pipeline introduced in
// docs/site-content/design/2026-04-30-realtime-incremental-stitching.md.
//
// What this file does:
//   - Owns a single `OpenCVIncrementalStitcher` instance
//   - Subscribes to `RetaiLensARSession`'s per-frame ARFrame delivery
//   - Converts ARKit pose → yaw/pitch + horizontal FoV
//   - Dispatches addPixelBuffer onto a serial queue
//   - Posts state updates as Notifications so the RN bridge can fan
//     them out to JS as device events
//
// What this file deliberately does NOT do:
//   - Touch OpenCV / cv::* — that's confined to the .mm impl behind
//     the ObjC interface.
//   - Manage UIKit views — the live preview is rendered via a separate
//     ViewManager that watches the snapshot file and re-loads it.
//   - Emit RN events directly — that's the bridge's job.  This class
//     stays free of any React.framework dependency so it can be
//     swift-tested in isolation.
//
// Threading:
//   ARSession delegates fire on an Apple-owned queue (~60 Hz).  Inside
//   the delegate we synchronously convert NV12 → BGR Mat (~5 ms) and
//   compute pose-delta gating; CHEAP rejects (overlap < min, > max)
//   short-circuit before any feature work runs.  Heavy candidate
//   processing (ORB + match + RANSAC + warp + blend) hops onto a
//   dedicated serial queue so the AR delegate isn't blocked.
//
// Pixel-buffer lifetime:
//   Apple guarantees ARFrame.capturedImage stays valid only within
//   the delegate callback (see the comment on RetaiLensARSession's
//   recording-append path).  We therefore consume the buffer
//   inside the delegate (the .mm copies pixels into a cv::Mat — the
//   Mat owns its own heap memory) before returning, even when the
//   actual heavy work is dispatched to the serial queue.

import Foundation
import ARKit
import simd
import UIKit

/// Public outcome enum mirroring the ObjC `RLISFrameOutcome` so JS
/// callers can inspect what happened to each frame without crossing
/// the ObjC++ boundary themselves.
@objc public enum RetaiLensIncrementalOutcome: Int {
    case acceptedHigh = 0
    case acceptedMedium = 1
    case skippedTooClose = 2
    case rejectedTooFar = 3
    case rejectedSceneUniform = 4
    case rejectedAlignmentLost = 5
    case skippedTrackingPoor = 6
}

/// State snapshot the bridge re-emits to JS on every accepted frame
/// (and on rejects when there's a hint to surface).
@objc(RetaiLensIncrementalState)
public final class RetaiLensIncrementalState: NSObject {
    @objc public let panoramaPath: String?
    @objc public let width: Int
    @objc public let height: Int
    @objc public let acceptedCount: Int
    @objc public let outcome: RetaiLensIncrementalOutcome
    @objc public let confidence: Double
    @objc public let overlapPercent: Double
    @objc public let processingMs: Double

    @objc public init(
        panoramaPath: String?,
        width: Int,
        height: Int,
        acceptedCount: Int,
        outcome: RetaiLensIncrementalOutcome,
        confidence: Double,
        overlapPercent: Double,
        processingMs: Double
    ) {
        self.panoramaPath = panoramaPath
        self.width = width
        self.height = height
        self.acceptedCount = acceptedCount
        self.outcome = outcome
        self.confidence = confidence
        self.overlapPercent = overlapPercent
        self.processingMs = processingMs
    }

    @objc public func asDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "width": width,
            "height": height,
            "acceptedCount": acceptedCount,
            "outcome": outcome.rawValue,
            "confidence": confidence,
            "overlapPercent": overlapPercent,
            "processingMs": processingMs,
        ]
        if let p = panoramaPath { dict["panoramaPath"] = p }
        return dict
    }
}

/// Notification names — bridge subscribes to these and re-emits as
/// React Native device events.  Keeping the engine framework-free
/// keeps Swift unit tests viable.
public extension Notification.Name {
    static let retailensIncrementalStateUpdate =
        Notification.Name("RetaiLensIncrementalStateUpdate")
}


@objc(RetaiLensIncrementalStitcher)
public final class RetaiLensIncrementalStitcher: NSObject {

    @objc public static let shared = RetaiLensIncrementalStitcher()

    /// Underlying OpenCV engine.  Created on `start`, torn down on
    /// `finalize`/`reset`.  Holding it across captures would keep the
    /// 24 MB canvas allocated in idle.
    ///
    /// V10: two engine variants exist behind one Swift wrapper.
    /// `hybridEngine` (Samsung-style, full-frame cylindrical + OF) is
    /// the default.  `firstwinsEngine` (Apple-style, per-strip painting)
    /// is opt-in via the JS `engine: 'slitscan'` start option.  Only
    /// one is non-nil at a time.
    private var hybridEngine: OpenCVIncrementalStitcher?
    private var firstwinsEngine: OpenCVFirstWinsCylindricalStitcher?

    /// Convenience: read the active engine's accepted count.  Used by
    /// the per-frame state event.
    private var engineAcceptedCount: Int {
        return hybridEngine?.acceptedCount ?? firstwinsEngine?.acceptedCount ?? 0
    }
    private var anyEngineActive: Bool {
        return hybridEngine != nil || firstwinsEngine != nil
    }

    /// Serial queue for the heavy per-frame work.  ARSession delegate
    /// only dispatches a pre-allocated cv::Mat onto this queue — the
    /// pixel buffer itself is consumed before return.
    private let workQueue = DispatchQueue(
        label: "com.retailens.incremental.stitcher",
        qos: .userInitiated
    )

    /// Lock guarding `engine`/`isRunning` reads/writes.  ARSession
    /// delegate uses `try` to avoid blocking ARKit; if start/stop is
    /// mid-flight the frame is dropped.
    private let stateLock = NSLock()

    /// Whether the engine is currently active.  Set by start/stop.
    @objc public private(set) var isRunning: Bool = false

    /// The most recent state snapshot — readable by JS via the
    /// bridge's `getState`.
    private var lastState: RetaiLensIncrementalState?

    /// Cumulative drop counter — frames the work queue couldn't keep
    /// up with.  Diagnostic only; not surfaced to JS.
    private var droppedBackpressure: Int = 0

    /// V11 Gap #27: true when an ingest is in flight on the work
    /// queue.  Subsequent AR delegate frames are dropped (rather
    /// than queued) so latency between AR time and canvas state
    /// stays bounded.
    private var workInFlight: Bool = false

    /// Snapshot quality — host can pass on start.
    private var snapshotJpegQuality: Int = 75

    /// Periodic snapshot cadence — emit a panoramaPath update at most
    /// every N accepts.  Default 1 (every accept) gives the freshest
    /// preview; field testing may show batching is friendlier on
    /// the JS image-cache.
    private var snapshotEveryNAccepts: Int = 1

    /// Internal counter used with snapshotEveryNAccepts.
    private var acceptsSinceSnapshot: Int = 0

    private override init() {
        super.init()
    }

    // ── Public lifecycle ────────────────────────────────────────────

    /// Begin a new incremental capture.  Hooks the ARSession's
    /// per-frame stream into the engine.  Caller must already have
    /// the AR session running (start/stop is the host app's job).
    @objc public func start(
        composeWidth: Int,
        composeHeight: Int,
        canvasWidth: Int,
        canvasHeight: Int,
        featherPx: Int,
        snapshotJpegQuality: Int,
        snapshotEveryNAccepts: Int,
        frameRotationDegrees: Int,
        engineMode: String
    ) {
        stateLock.lock()
        if isRunning {
            stateLock.unlock()
            return
        }
        if engineMode == "firstwins" {
            self.firstwinsEngine = OpenCVFirstWinsCylindricalStitcher(
                composeWidth: composeWidth,
                composeHeight: composeHeight,
                canvasWidth: canvasWidth,
                canvasHeight: canvasHeight,
                featherPx: featherPx,
                frameRotationDegrees: frameRotationDegrees
            )
            self.hybridEngine = nil
        } else {
            self.hybridEngine = OpenCVIncrementalStitcher(
                composeWidth: composeWidth,
                composeHeight: composeHeight,
                canvasWidth: canvasWidth,
                canvasHeight: canvasHeight,
                featherPx: featherPx,
                frameRotationDegrees: frameRotationDegrees
            )
            self.firstwinsEngine = nil
        }
        self.isRunning = true
        self.snapshotJpegQuality = max(1, min(100, snapshotJpegQuality))
        self.snapshotEveryNAccepts = max(1, snapshotEveryNAccepts)
        self.acceptsSinceSnapshot = 0
        self.droppedBackpressure = 0
        self.lastState = nil
        stateLock.unlock()

        // Register with the AR session.  Weak so the singleton is the
        // owner of lifetime; we de-register on stop.
        RetaiLensARSession.shared.incrementalConsumer = self
    }

    /// Stop ingestion + write the final panorama to `outputPath`.
    /// Returns the result on the main thread via completion.
    @objc public func finalize(
        toPath outputPath: String,
        jpegQuality: Int,
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        // Detach from AR session first so no new frames slip in
        // between our finalize call and the engine teardown.
        RetaiLensARSession.shared.incrementalConsumer = nil

        // Hop to the work queue so any in-flight frame finishes
        // before we serialize the canvas.
        workQueue.async { [weak self] in
            guard let self = self else {
                completion(nil, NSError(
                    domain: "RetaiLensIncremental",
                    code: 9001,
                    userInfo: [NSLocalizedDescriptionKey: "Stitcher gone."]
                ))
                return
            }
            self.stateLock.lock()
            let hybrid = self.hybridEngine
            let slit = self.firstwinsEngine
            self.hybridEngine = nil
            self.firstwinsEngine = nil
            self.isRunning = false
            self.stateLock.unlock()

            let cleaned = (outputPath.hasPrefix("file://"))
                ? String(outputPath.dropFirst(7))
                : outputPath
            let q = max(1, min(100, jpegQuality))
            do {
                if let hybrid = hybrid {
                    let snap = try hybrid.finalize(atPath: cleaned, jpegQuality: q)
                    completion([
                        "panoramaPath": snap.panoramaPath,
                        "width": snap.width,
                        "height": snap.height,
                        "acceptedCount": snap.acceptedCount,
                        "droppedBackpressure": self.droppedBackpressure,
                    ], nil)
                } else if let slit = slit {
                    let snap = try slit.finalize(atPath: cleaned, jpegQuality: q)
                    completion([
                        "panoramaPath": snap.panoramaPath,
                        "width": snap.width,
                        "height": snap.height,
                        "acceptedCount": snap.acceptedCount,
                        "droppedBackpressure": self.droppedBackpressure,
                    ], nil)
                } else {
                    completion(nil, NSError(
                        domain: "RetaiLensIncremental",
                        code: 9002,
                        userInfo: [NSLocalizedDescriptionKey:
                            "No active capture — call start() first."]
                    ))
                }
            } catch let err as NSError {
                completion(nil, err)
            }
        }
    }

    /// Cancel an in-progress capture without producing output.
    @objc public func cancel() {
        RetaiLensARSession.shared.incrementalConsumer = nil
        stateLock.lock()
        hybridEngine?.reset()
        firstwinsEngine?.reset()
        hybridEngine = nil
        firstwinsEngine = nil
        isRunning = false
        lastState = nil
        stateLock.unlock()
    }

    /// Read the most recent state snapshot (JS pulls this on demand).
    @objc public func currentStateDictionary() -> [String: Any]? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return lastState?.asDictionary()
    }

    // ── ARSession frame consumer hook ───────────────────────────────

    /// Called from the ARSession delegate while the engine is active.
    /// MUST consume the pixel buffer before returning (Apple's pool
    /// reuse contract — see comments in RetaiLensARSession).
    @objc public func consumeFrame(
        pixelBuffer: CVPixelBuffer,
        pose: RetaiLensARFramePose
    ) {
        guard stateLock.try() else {
            // start/stop in flight — drop this frame.
            return
        }
        let hybrid = self.hybridEngine
        let slit = self.firstwinsEngine
        let isRunning = self.isRunning
        stateLock.unlock()
        guard isRunning, (hybrid != nil || slit != nil) else { return }

        // Compute yaw + pitch from the quaternion.  Convention:
        // yaw   = rotation about world Y (camera turning left/right)
        // pitch = rotation about camera X (camera tilting up/down)
        let q = simd_quatf(
            ix: Float(pose.qx), iy: Float(pose.qy),
            iz: Float(pose.qz), r: Float(pose.qw)
        )
        let (yaw, pitch) = Self.yawPitch(from: q)

        // Both FoVs from physical camera intrinsics.  Passing the
        // PHYSICAL vertical FoV (vs deriving it from compose aspect
        // inside the engine) is what fixes the v1/v2 "only left-to-
        // right portrait pan responds" bug — the engine's overlap
        // gate compared world-pitch against a compose-aspect-derived
        // vertical FoV that didn't match the actual camera, so most
        // top-to-bottom pans fell outside the 30-70% window.
        let fovHRad = 2.0 * atan(Double(pose.imageWidth)  / (2.0 * pose.fx))
        let fovVRad = 2.0 * atan(Double(pose.imageHeight) / (2.0 * pose.fy))
        let fovHDeg = fovHRad * 180.0 / .pi
        let fovVDeg = fovVRad * 180.0 / .pi

        let trackingPoor = (pose.trackingState != .tracking)

        // V11 Gap #27: dispatch the heavy pipeline (engine.ingest +
        // optional snapshot) to the work queue.  Earlier versions
        // ran the full ~70 ms accept inside the AR delegate thread,
        // blocking ARKit's 16 ms inter-frame budget and causing
        // ~4-5 frames to be dropped during each accept.
        //
        // Backpressure: if the work queue is already busy with a
        // previous frame, drop this one (don't queue up — that'd
        // produce an ever-growing latency between AR-time and
        // canvas-state).  CVPixelBuffer auto-retains via Swift's
        // ARC; the closure capture extends its lifetime past the
        // delegate return.
        if self.workInFlight {
            self.droppedBackpressure += 1
            return
        }
        self.workInFlight = true

        let pbCopy = pixelBuffer  // ARC retain across the dispatch
        workQueue.async { [weak self] in
            defer { self?.workInFlight = false }
            guard let self = self else { return }

            let telemetry: RLISFrameTelemetry
            if let hybrid = hybrid {
                telemetry = hybrid.ingest(
                    pixelBuffer: pbCopy, qx: pose.qx, qy: pose.qy, qz: pose.qz, qw: pose.qw,
                    fx: pose.fx, fy: pose.fy, cx: pose.cx, cy: pose.cy,
                    imageWidth: pose.imageWidth, imageHeight: pose.imageHeight,
                    yaw: yaw, pitch: pitch,
                    fovHorizDegrees: fovHDeg, fovVertDegrees: fovVDeg,
                    trackingPoor: trackingPoor
                )
            } else if let slit = slit {
                telemetry = slit.ingest(
                    pixelBuffer: pbCopy, qx: pose.qx, qy: pose.qy, qz: pose.qz, qw: pose.qw,
                    fx: pose.fx, fy: pose.fy, cx: pose.cx, cy: pose.cy,
                    imageWidth: pose.imageWidth, imageHeight: pose.imageHeight,
                    yaw: yaw, pitch: pitch,
                    fovHorizDegrees: fovHDeg, fovVertDegrees: fovVDeg,
                    trackingPoor: trackingPoor
                )
            } else {
                return
            }

            self.processIngestResult(
                telemetry: telemetry, hybrid: hybrid, slit: slit)
        }
    }

    /// Pulled out of consumeFrame so the work-queue closure stays
    /// readable.  Same flow: build state, optionally snapshot, post
    /// notification.
    private func processIngestResult(
        telemetry: RLISFrameTelemetry,
        hybrid: OpenCVIncrementalStitcher?,
        slit: OpenCVFirstWinsCylindricalStitcher?
    ) {
        var snapshotPath: String?
        var snapW = 0, snapH = 0
        let outcome = RetaiLensIncrementalOutcome(rawValue: telemetry.outcome.rawValue)
            ?? .skippedTrackingPoor

        let isAccept = (telemetry.outcome == .acceptedHigh ||
                        telemetry.outcome == .acceptedMedium)

        if isAccept {
            self.acceptsSinceSnapshot += 1
            if self.acceptsSinceSnapshot >= self.snapshotEveryNAccepts {
                self.acceptsSinceSnapshot = 0
                do {
                    let snap: RLISSnapshot
                    if let hybrid = hybrid {
                        snap = try hybrid.snapshot(
                            withJpegQuality: self.snapshotJpegQuality)
                    } else {
                        snap = try slit!.snapshot(
                            withJpegQuality: self.snapshotJpegQuality)
                    }
                    snapshotPath = snap.panoramaPath
                    snapW = snap.width
                    snapH = snap.height
                } catch {
                    // Silently dropping a snapshot is fine — next
                    // accept will retry.
                }
            }
        }

        let state = RetaiLensIncrementalState(
            panoramaPath: snapshotPath,
            width: snapW,
            height: snapH,
            acceptedCount: hybrid?.acceptedCount ?? slit?.acceptedCount ?? 0,
            outcome: outcome,
            confidence: telemetry.confidence,
            overlapPercent: telemetry.overlapPercent,
            processingMs: telemetry.processingMs
        )
        stateLock.lock()
        self.lastState = state
        stateLock.unlock()

        // Emit always — JS may want to drive UX on rejects too.
        // NotificationCenter is thread-agnostic; the bridge converts
        // it to a main-thread RN event.
        NotificationCenter.default.post(
            name: .retailensIncrementalStateUpdate,
            object: nil,
            userInfo: state.asDictionary()
        )
    }

    // ── Debug log file ──────────────────────────────────────────────
    //
    // iOS Console rate-limits Swift NSLog at 60 Hz, dropping most
    // output silently.  File-based log captures everything, and we
    // can pull it from Xcode's device-container browser.  Path:
    // <Documents>/rlis-debug.log
    private static let debugLogQueue = DispatchQueue(label: "rlis.debuglog")
    private static var debugLogPath: String = {
        let docs = NSSearchPathForDirectoriesInDomains(
            .documentDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
        return (docs as NSString).appendingPathComponent("rlis-debug.log")
    }()
    static func fileLog(_ msg: String) {
        let line = "\(Date().timeIntervalSince1970): \(msg)\n"
        debugLogQueue.async {
            let data = line.data(using: .utf8) ?? Data()
            if let fh = FileHandle(forWritingAtPath: debugLogPath) {
                fh.seekToEndOfFile()
                fh.write(data)
                fh.closeFile()
            } else {
                try? data.write(to: URL(fileURLWithPath: debugLogPath),
                                options: .atomicWrite)
            }
        }
        // Also try NSLog in case it does work occasionally
        NSLog("[RLIS-PIP] %@", msg)
    }

    // ── Helpers ─────────────────────────────────────────────────────

    /// Extract yaw (rotation about world Y) and pitch (rotation about
    /// camera X) from an ARKit camera quaternion.  Numerically stable
    /// for camera orientations the user holds in practice — straight
    /// up/down is gimbal-locked but a shelf-audit user is never there.
    private static func yawPitch(from q: simd_quatf) -> (Double, Double) {
        // Apply the quaternion to ARKit's camera-forward vector
        // (-Z in camera frame) to get the camera-forward in world.
        // Yaw is the angle of the projection onto the X-Z plane;
        // pitch is the elevation angle.
        let forward = simd_act(q, simd_float3(0, 0, -1))
        let yaw = Double(atan2(forward.x, -forward.z))
        let pitch = Double(asin(forward.y))
        return (yaw, pitch)
    }
}

// ── Bridge contract for ARSession ───────────────────────────────────
//
// The AR session calls into us via an @objc protocol so the dependency
// arrow points the right way: ARSession (low-level) delivers frames
// to a consumer it knows nothing about.  The Stitcher implements the
// protocol and registers itself.

@objc public protocol RetaiLensARFrameConsumer: AnyObject {
    /// Called on the ARSession delegate's queue.  The pixel buffer is
    /// only valid for the duration of this call (Apple's ARKit pool
    /// reuse contract); consumers must copy out before returning.
    func consumeFrame(pixelBuffer: CVPixelBuffer, pose: RetaiLensARFramePose)
}

extension RetaiLensIncrementalStitcher: RetaiLensARFrameConsumer {}
