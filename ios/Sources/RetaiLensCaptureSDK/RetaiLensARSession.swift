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
import AVFoundation
import simd
import UIKit


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

    /// The underlying ARKit session.  Module-internal (not `private`)
    /// so RetaiLensARCameraView (same module) can bind its ARSCNView
    /// to this exact session — sharing is critical so the pose log
    /// (driven by this object's `ARSessionDelegate` callbacks) stays
    /// populated while the view renders frames.  Lifecycle is still
    /// controlled exclusively via `start()` / `stop()`.
    let arSession = ARSession()

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
    // We serialise via `captureStateQueue` to prevent the delegate
    // appending after `finishWriting` has been called.

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
    /// Serial queue guarding all asset-writer state mutations.
    /// Must be serial — concurrent finishWriting + append crashes
    /// AVAssetWriter.
    private let captureStateQueue = DispatchQueue(
        label: "com.retailens.arsession.capture",
        qos: .userInitiated
    )

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

        // If recording is in flight, append this frame to the
        // asset writer.
        //
        // Async dispatch onto captureStateQueue.  Swift's closure
        // capture retains the CVPixelBuffer (CF type with toll-free
        // bridging), so it stays alive until the closure runs.
        // adaptor.append() makes its own internal copy before
        // returning.
        //
        // We tried `.sync` previously to side-step a suspected
        // pixel-buffer lifetime issue — but sync from ARKit's
        // delegate queue blocks the delegate until the encoder
        // returns.  When the encoder ran slow (or the captureStateQueue
        // had any prior work in flight), ARKit silently dropped
        // frames; in the worst case, ZERO frames made it to the mp4,
        // the resulting file had no valid duration, and stitchVideo
        // failed with the "Could not read video duration" error
        // ~50% of the time.  Async restores frame flow.
        //
        // Safety against the over-release crash (Sentry: "release"
        // at 0x16adb7e10) is now provided by the early-clear in
        // stopRecording — concurrent delegate closures find
        // assetWriter=nil and skip cleanly.
        let pixelBuffer = frame.capturedImage
        let frameTimestamp = frame.timestamp
        captureStateQueue.async { [weak self] in
            guard let self = self,
                  let writer = self.assetWriter,
                  let input = self.videoInput,
                  let adaptor = self.pixelBufferAdaptor,
                  writer.status == .writing,
                  input.isReadyForMoreMediaData,
                  let startTime = self.recordingStartTime else {
                return
            }
            // Compute presentation timestamp relative to recording
            // start so the resulting mp4's timeline begins at 0.
            let frameCMTime = CMTime(
                seconds: frameTimestamp,
                preferredTimescale: 1_000_000
            )
            let pts = CMTimeSubtract(frameCMTime, startTime)
            adaptor.append(pixelBuffer, withPresentationTime: pts)
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

    // MARK: - Phase 5: AR-backed photo + video capture

    /// Capture the current camera frame as a JPEG.  If `rawPath` is
    /// empty, generates a fresh path inside `NSTemporaryDirectory()`
    /// — matches vision-camera's API where the path is an OUTPUT,
    /// not an input.  Completion fires with a result dictionary
    /// matching vision-camera's PhotoFile shape.
    @objc public func takePhoto(
        toPath rawPath: String,
        quality: Int,
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        let resolvedPath: String
        if rawPath.isEmpty {
            let dir = NSTemporaryDirectory()
            resolvedPath = (dir as NSString).appendingPathComponent(
                "RetaiLensAR-\(UUID().uuidString).jpg"
            )
        } else {
            resolvedPath = rawPath
        }
        guard let frame = arSession.currentFrame else {
            completion(nil, NSError(
                domain: "RetaiLensARCapture",
                code: 2001,
                userInfo: [NSLocalizedDescriptionKey:
                    "AR session has no current frame — start the session first."]
            ))
            return
        }
        let pixelBuffer = frame.capturedImage

        // ARKit's capturedImage is in landscape sensor orientation
        // regardless of how the device is held.  Rotate to portrait
        // (the way the user is holding the phone for shelf audits)
        // by applying a 90° clockwise CIImage orientation.  Without
        // this, photos appear sideways in any consumer that doesn't
        // honour EXIF (RN's <Image>, the OpenCV stitcher).
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            .oriented(.right)
        let context = CIContext(options: nil)
        guard let cgImage = context.createCGImage(
            ciImage,
            from: ciImage.extent
        ) else {
            completion(nil, NSError(
                domain: "RetaiLensARCapture",
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
                domain: "RetaiLensARCapture",
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
                "RetaiLensAR-\(UUID().uuidString).mp4"
            )
        } else {
            resolvedPath = rawPath
        }
        captureStateQueue.async { [weak self] in
            guard let self = self else { return }
            if self.assetWriter != nil {
                completion(nil, NSError(
                    domain: "RetaiLensARCapture",
                    code: 2010,
                    userInfo: [NSLocalizedDescriptionKey:
                        "A recording is already in progress."]
                ))
                return
            }
            guard let frame = self.arSession.currentFrame else {
                completion(nil, NSError(
                    domain: "RetaiLensARCapture",
                    code: 2011,
                    userInfo: [NSLocalizedDescriptionKey:
                        "AR session has no current frame — start the session first."]
                ))
                return
            }

            let pixelBuffer = frame.capturedImage
            let width = CVPixelBufferGetWidth(pixelBuffer)
            let height = CVPixelBufferGetHeight(pixelBuffer)
            let cleanedPath = Self.normalisePath(resolvedPath)
            let url = URL(fileURLWithPath: cleanedPath)
            try? FileManager.default.removeItem(at: url)

            do {
                let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
                // Encode H.264 at sensor dimensions (landscape).
                // The 90° rotation transform below tells the player
                // (and AVAssetImageGenerator inside our stitcher's
                // extractFrames step) to display in portrait without
                // re-encoding.
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
                        domain: "RetaiLensARCapture",
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

                self.assetWriter = writer
                self.videoInput = input
                self.pixelBufferAdaptor = adaptor
                self.recordingStartTime = startTime

                // Reset the pose log so this recording's frames
                // correlate with a fresh window of poses; the
                // stitcher matches video frames to poses by
                // timestamp from recording start.
                self.poseLogQueue.async(flags: .barrier) { [weak self] in
                    self?.poseLog.removeAll(keepingCapacity: true)
                }

                NSLog("[RetaiLensARCapture] startRecording: %dx%d → %@",
                      width, height, cleanedPath)
                completion(cleanedPath, nil)
            } catch {
                completion(nil, error as NSError)
            }
        }
    }

    /// Finalise the in-progress recording and resolve with the
    /// resulting file's metadata (path, duration, size, width,
    /// height) — shape mirrors vision-camera's VideoFile so JS
    /// consumers don't branch.
    @objc public func stopRecording(
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        captureStateQueue.async { [weak self] in
            guard let self = self,
                  let writer = self.assetWriter,
                  let input = self.videoInput else {
                completion(nil, NSError(
                    domain: "RetaiLensARCapture",
                    code: 2020,
                    userInfo: [NSLocalizedDescriptionKey:
                        "No active recording to stop."]
                ))
                return
            }

            // CRITICAL: clear the in-flight writer state BEFORE
            // markAsFinished/finishWriting.  Any concurrent delegate
            // sync block (queued + waiting on captureStateQueue
            // behind us) will then find assetWriter=nil and skip
            // its append, instead of trying to feed a marked-as-
            // finished input.  The strong references we keep below
            // (`writer`, `input`) keep the objects alive long enough
            // to finalise.
            self.assetWriter = nil
            self.videoInput = nil
            self.pixelBufferAdaptor = nil
            self.recordingStartTime = nil

            input.markAsFinished()
            let outputURL = writer.outputURL
            writer.finishWriting { [weak self] in
                guard let self = self else { return }
                self.captureStateQueue.async {
                    let path = outputURL.path
                    let asset = AVAsset(url: outputURL)
                    let durationSec = CMTimeGetSeconds(asset.duration)
                    let fileSize = (try? FileManager.default
                        .attributesOfItem(atPath: path))?[.size] as? Int ?? 0
                    let track = asset.tracks(withMediaType: .video).first
                    let naturalSize = track?.naturalSize ?? .zero
                    NSLog("[RetaiLensARCapture] stopRecording: %.2fs, %lld bytes",
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
        }
    }

    // MARK: - Helpers

    /// Strip a `file://` scheme some callers attach — same logic
    /// the OpenCV stitcher uses, kept local here so RetaiLensARSession
    /// stays independent of the OpenCV path.
    private static func normalisePath(_ path: String) -> String {
        if path.hasPrefix("file://") {
            return String(path.dropFirst("file://".count))
        }
        return path
    }

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
