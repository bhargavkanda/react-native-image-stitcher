// SPDX-License-Identifier: UNLICENSED
//
// IncrementalStitcherBridge — RN bridge for the live panorama engine.
//
// Why this is an RCTEventEmitter (not a plain NSObject like the
// other bridges):
//   The engine emits a state update for every ARFrame the AR session
//   delivers (~60 Hz, mostly skipped before any work runs).  JS
//   needs to receive these as device events so the live preview UI
//   can update without polling.  RCTEventEmitter is the standard
//   React Native pattern; subclassing it is a one-time investment
//   that buys clean event-driven UX with no polling overhead.
//
// JS-visible module name: `RetaiLensIncrementalStitcher`.  Mapped via
// `RCT_EXTERN_REMAP_MODULE` in IncrementalStitcherBridge.m so the
// JS-facing name stays stable while the bridge class itself can be
// renamed without touching JS.

#if canImport(React)
import Foundation
import React
import os.log
import ImageIO        // CGImageSource + kCGImagePropertyOrientation for EXIF read in processFrameAtPath

@objc(RetaiLensIncrementalStitcherBridge)
public final class RetaiLensIncrementalStitcherBridge: RCTEventEmitter {

    /// Whether at least one JS listener is attached.  RN's
    /// EventEmitter contract: don't emit when no listeners are
    /// registered (the events would be dropped with a console warning).
    private var hasListeners: Bool = false

    private static let stateUpdateEvent = "RetaiLensIncrementalStateUpdate"

    public override init() {
        super.init()
        // Subscribe once at construction.  The handler self-checks
        // `hasListeners` before forwarding, so we don't have to
        // unsubscribe / resubscribe on every JS listener attach/detach.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleStateUpdate(_:)),
            name: .retailensIncrementalStateUpdate,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - RCTEventEmitter protocol

    public override class func requiresMainQueueSetup() -> Bool {
        return false
    }

    public override func supportedEvents() -> [String]! {
        return [Self.stateUpdateEvent]
    }

    // (startObserving / stopObserving moved next to handleStateUpdate
    //  for the PiP investigation; remove this comment after.)

    // MARK: - Module methods

    /// `options` (all optional, sensible defaults documented in
    /// the .h file):
    ///   - composeWidth, composeHeight (Int)
    ///   - canvasWidth, canvasHeight (Int)
    ///   - featherPx (Int)
    ///   - snapshotJpegQuality (Int, default 75)
    ///   - snapshotEveryNAccepts (Int, default 1)
    ///
    /// Resolves with `{ ok: true }`.  Rejects when `frameSourceMode`
    /// (options dict) is 'arSession' (the default) AND the AR session
    /// isn't running — that path needs ARKit to deliver frames.
    /// When `frameSourceMode` is 'jsDriver' the AR-session check is
    /// skipped and the engine expects JS to feed frames via
    /// `processFrameAtPath` (used by iOS non-AR captures since
    /// 2026-05-18 / Issue #2 regression fix).
    @objc(start:resolver:rejecter:)
    public func start(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let frameSourceMode =
            (options["frameSourceMode"] as? String) ?? "arSession"
        if frameSourceMode == "arSession" {
            guard RetaiLensARSession.shared.isRunning else {
                rejecter(
                    "ar-session-not-running",
                    "RetaiLensARSession.start() must be called before "
                    + "the incremental stitcher.",
                    nil
                )
                return
            }
        }
        let composeW = (options["composeWidth"] as? Int) ?? 0
        let composeH = (options["composeHeight"] as? Int) ?? 0
        let canvasW  = (options["canvasWidth"]  as? Int) ?? 0
        let canvasH  = (options["canvasHeight"] as? Int) ?? 0
        let feather  = (options["featherPx"] as? Int) ?? 0
        let snapQ    = (options["snapshotJpegQuality"] as? Int) ?? 75
        let snapN    = (options["snapshotEveryNAccepts"] as? Int) ?? 1
        let rotation = (options["frameRotationDegrees"] as? Int) ?? 90
        // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
        //
        // Capture orientation classifies the user's phone-hold at
        // start() time, sourced from the JS-side accelerometer hook
        // `useDeviceOrientation`.  Drives the OUTPUT bake-rotation in
        // OpenCVStitcher.stitchFramePaths.  Distinct from `rotation`
        // (frameRotationDegrees) above: rotation collapses both
        // landscape variants to 0°, losing the left/right
        // distinction we need to mirror-rotate the output correctly.
        //
        // Default 'portrait' matches the historical Mode B start
        // state.  Unknown values are passed through verbatim; the
        // .mm side falls back to no rotation on anything outside the
        // four supported labels.
        let captureOrientation =
            (options["captureOrientation"] as? String) ?? "portrait"
        // Diagnostic: trace the value as received from JS, before
        // any downstream layer touches it.  os_log %{public}@ to
        // bypass iOS log redaction.  Logs BOTH captureOrientation
        // (the new field) and frameRotationDegrees (the legacy one)
        // so we can spot a mismatch — frameRotationDegrees=0 with
        // captureOrientation="portrait" means JS is passing stale
        // accelerometer state.
        os_log(.fault, log: OSLog(subsystem: "com.tiger.retailens",
                                  category: "stitcher.diag"),
               "[V16-bridge] start: captureOrientation=%{public}@ frameRotationDegrees=%d (raw_options_value=%{public}@)",
               captureOrientation,
               Int32(rotation),
               String(describing: options["captureOrientation"]))
        // V15 — engine selection.  Three modes:
        //   'hybrid'           — planar projection + feature matching
        //   'slitscan-rotate'  — V13.0a + 1D NCC for rotation wobble
        //   'slitscan-both'    — DEFAULT — V13.0a + no gate + feather
        //                         blend; iterate via per-stage toggles
        //                         in the config dict.
        // Backward compat: 'firstwins-rectilinear' → 'slitscan-rotate'.
        // Legacy 'firstwins' / 'firstwins-zoomed' / 'slitscan' fall
        // back to 'slitscan-both' with a deprecation warning.
        let engineMode = (options["engine"] as? String) ?? "slitscan-both"

        // V15 — per-stage config overrides.  All optional; missing
        // fields use mode defaults from +[RLISStitcherConfig configForMode:].
        let configOverrides = options["config"] as? [String: Any] ?? [:]

        RetaiLensIncrementalStitcher.shared.start(
            composeWidth: composeW,
            composeHeight: composeH,
            canvasWidth: canvasW,
            canvasHeight: canvasH,
            featherPx: feather,
            snapshotJpegQuality: snapQ,
            snapshotEveryNAccepts: snapN,
            frameRotationDegrees: rotation,
            engineMode: engineMode,
            captureOrientation: captureOrientation,
            configOverrides: configOverrides,
            frameSourceMode: frameSourceMode
        )
        resolver(["ok": true])
    }

    /// `options` keys: `outputPath` (optional — when empty/missing
    /// the native side generates a path under NSTemporaryDirectory),
    /// `quality` (optional, default 90).  Resolves with
    /// `{ panoramaPath, width, height, acceptedCount,
    /// droppedBackpressure }`.
    @objc(finalize:resolver:rejecter:)
    public func finalize(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let outputPathRaw = (options["outputPath"] as? String) ?? ""
        let outputPath: String
        if outputPathRaw.isEmpty {
            // Mirror RetaiLensARSession's path-generation behaviour
            // — host code can call finalize() with no path and a
            // tmp file is created in the app's sandbox tmp dir.
            let dir = NSTemporaryDirectory()
            outputPath = (dir as NSString).appendingPathComponent(
                "RetaiLensIncremental-\(UUID().uuidString).jpg"
            )
        } else {
            outputPath = outputPathRaw
        }
        let quality = (options["quality"] as? Int) ?? 90
        // 2026-05-18 (iOS cross-orientation fix) — JS may pass a
        // fresh deviceOrientation at finalize time; if so, override
        // the engine's start-time snapshot before the stitch + bake.
        // Empty / missing → keep legacy behaviour (start-time value).
        let freshOrientation = (options["captureOrientation"] as? String) ?? ""
        if !freshOrientation.isEmpty {
            RetaiLensIncrementalStitcher.shared.updateCaptureOrientation(
                freshOrientation
            )
        }
        RetaiLensIncrementalStitcher.shared.finalize(
            toPath: outputPath,
            jpegQuality: quality
        ) { result, error in
            if let error = error {
                rejecter(
                    "incremental-finalize-failed",
                    error.localizedDescription,
                    error
                )
            } else {
                resolver(result ?? [:])
            }
        }
    }

    @objc(cancel:rejecter:)
    public func cancel(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RetaiLensIncrementalStitcher.shared.cancel()
        resolver(["ok": true])
    }

    /// V16 — JS-side hook for shutter-release in pose-based frame
    /// selection mode.  Arms the keyframe gate so the next ARFrame
    /// delivered is force-accepted regardless of overlap, ensuring
    /// the trailing edge of the scan isn't truncated when the user
    /// releases the shutter mid-pan.  No-op when the gate is
    /// disabled (frameSelectionMode = "time-based") or no capture
    /// is in flight.  Always resolves with `{ ok: true }`.
    @objc(markNextFrameAsLastKeyframe:rejecter:)
    public func markNextFrameAsLastKeyframe(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RetaiLensIncrementalStitcher.shared.markNextFrameAsLastKeyframe()
        resolver(["ok": true])
    }

    /// 2026-05-18 (Issue #2 v2) — JS-driven frame ingestion for iOS
    /// non-AR mode.  Mirrors Android's `processFrameAtPath` exactly:
    /// the JPEG at `path` is already saved on disk by vision-camera
    /// in its native EXIF-correct orientation.  We DO NOT decode the
    /// image here.  Instead:
    ///
    ///   - Build a synthetic `RetaiLensARFramePose` from the
    ///     JS-supplied quaternion + intrinsics (no translation;
    ///     non-AR captures don't have it).
    ///   - Hand the path + pose to
    ///     `RetaiLensIncrementalStitcher.addBatchKeyframePath`, which
    ///     evaluates the shared-C++ KeyframeGate and (if accepted)
    ///     records the path in the finalize-time keyframe list +
    ///     emits the same state event the AR-delegate path emits.
    ///   - `cv::imread` at finalize handles EXIF orientation
    ///     natively, so the output panorama reads upright with no
    ///     iOS-specific orientation handling needed in this bridge.
    ///
    /// History: Issue #2 v1 (commit 0e40f17) tried to decode the
    /// JPEG into a CVPixelBuffer and reuse the existing AR
    /// `consumeFrame(pixelBuffer:pose:)` path.  That introduced two
    /// orientation bugs (CGContext Y-flip + UIImage.size vs
    /// cgImage.width dim swap) → upside-down output AND canvas-
    /// dimension overflow → OOM crashes (user-reported 2026-05-18).
    /// Architecturally Android never decoded the image either, so
    /// the right fix was to mirror that.
    ///
    /// `options` keys:
    ///   - path (NSString, required) — local file path (no file://)
    ///   - qx, qy, qz, qw (Double, required) — quaternion, JS-side
    ///     gyro-integrated
    ///   - fx, fy, cx, cy (Double, required) — intrinsics in sensor px
    ///   - imageWidth, imageHeight (Int, required)
    ///   - trackingPoor (Bool, optional, default false)
    ///   - timestampMs (Double, optional, default = now)
    ///
    /// Only batch-keyframe captures are supported on this path right
    /// now — other engines (hybrid / firstwins) need real pixel data
    /// during the live phase, which isn't trivially derivable from a
    /// JPEG path.  Reject with `E_NOT_BATCH_KEYFRAME` so the JS host
    /// can fall back to the legacy stitchVideo path if needed.
    @objc(processFrameAtPath:resolver:rejecter:)
    public func processFrameAtPath(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let pathRaw = options["path"] as? String, !pathRaw.isEmpty else {
            rejecter("E_NO_PATH", "processFrameAtPath: missing 'path'", nil)
            return
        }
        // Strip optional file:// prefix — JS callers sometimes send
        // file URIs, native APIs want filesystem paths.
        let cleanPath = pathRaw.hasPrefix("file://")
            ? String(pathRaw.dropFirst("file://".count))
            : pathRaw

        let engine = RetaiLensIncrementalStitcher.shared
        guard engine.isBatchKeyframeMode else {
            rejecter("E_NOT_BATCH_KEYFRAME",
                     "processFrameAtPath only supports batch-keyframe "
                     + "engine mode on iOS.  Configure "
                     + "incrementalEngine='batch-keyframe' in start() "
                     + "options, or fall back to the stitchVideo path.",
                     nil)
            return
        }

        let qx = (options["qx"] as? Double) ?? 0
        let qy = (options["qy"] as? Double) ?? 0
        let qz = (options["qz"] as? Double) ?? 0
        let qw = (options["qw"] as? Double) ?? 1   // identity quat default
        let fx = (options["fx"] as? Double) ?? 1000.0
        let fy = (options["fy"] as? Double) ?? 1000.0
        let cx = (options["cx"] as? Double) ?? 540.0
        let cy = (options["cy"] as? Double) ?? 960.0
        let imageWidth = (options["imageWidth"] as? Int) ?? 1080
        let imageHeight = (options["imageHeight"] as? Int) ?? 1920
        let trackingPoor = (options["trackingPoor"] as? Bool) ?? false
        let timestampMs = (options["timestampMs"] as? Double)
            ?? (Date().timeIntervalSince1970 * 1000.0)
        let trackingState: RetaiLensARTrackingState =
            trackingPoor ? .limited : .tracking

        let pose = RetaiLensARFramePose(
            tx: 0, ty: 0, tz: 0,           // no translation in non-AR
            qx: qx, qy: qy, qz: qz, qw: qw,
            fx: fx, fy: fy, cx: cx, cy: cy,
            imageWidth: imageWidth, imageHeight: imageHeight,
            timestampMs: timestampMs,
            trackingState: trackingState
        )

        // 2026-05-18 (Iss #1 diag) — read EXIF Orientation tag from the
        // keyframe JPEG before handing it to the engine.  vision-camera
        // writes a JPEG with an EXIF tag matching the physical capture
        // orientation (1=no rotation, 3=180°, 6=90°CW, 8=90°CCW).  The
        // bake-rotation table in cpp/stitcher.cpp assumes the post-imread
        // Mat is in user-view orientation (post-EXIF apply).  If the EXIF
        // tag isn't what we expect for a given physical orientation, the
        // input Mat to cv::Stitcher will be a different shape than the AR
        // path produces (AR keyframes hardcode EXIF=6, commit 7b828f1) —
        // which would explain why iOS non-AR landscape captures stitch
        // but bake the wrong way.  CGImageSource is cheap (metadata-only;
        // no decode).
        var exifOrientation: Int = -1
        if let src = CGImageSourceCreateWithURL(
            URL(fileURLWithPath: cleanPath) as CFURL, nil
        ),
           let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
           let o = props[kCGImagePropertyOrientation] as? Int {
            exifOrientation = o
        }
        os_log(.fault, log: OSLog(subsystem: "com.tiger.retailens",
                                  category: "stitcher.diag"),
               "[V16-batch-keyframe.js] processFrameAtPath EXIF=%d imageW=%d imageH=%d path=%{public}@",
               Int32(exifOrientation), Int32(imageWidth), Int32(imageHeight), cleanPath)

        let accepted = engine.addBatchKeyframePath(path: cleanPath, pose: pose)
        resolver(["ok": true, "accepted": accepted])
    }

    /// 2026-05-18 (Iss 3) — bridge for `cleanupKeyframes`.  See the
    /// Swift method's docstring for behaviour.  Options dict keys:
    ///   - olderThanMs (Double / NSNumber, optional, default 24h):
    ///       cutoff staleness in ms.
    /// Resolves with { sessionsDeleted, bytesFreed }.  Never rejects.
    @objc(cleanupKeyframes:resolver:rejecter:)
    public func cleanupKeyframes(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let olderThanMs = (options["olderThanMs"] as? Double)
            ?? Double(24 * 3600 * 1000)
        let result = RetaiLensIncrementalStitcher.shared
            .cleanupKeyframes(olderThanMs: olderThanMs)
        resolver(result)
    }

    /// 2026-05-18 (Iss 3) — bridge for `getKeyframeDir`.  Returns the
    /// session dir of the currently-running batch-keyframe capture,
    /// or empty string if no capture is in flight / engine isn't in
    /// batch-keyframe mode.
    @objc(getKeyframeDir:rejecter:)
    public func getKeyframeDir(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let path = RetaiLensIncrementalStitcher.shared.currentKeyframeDir() ?? ""
        resolver(["path": path])
    }

    /// V16 Phase 1b.fix2 — JS-callable poll for the process'
    /// phys_footprint in MB.  This is the SAME metric iOS jetsam
    /// evaluates against, so it's the right number for an on-screen
    /// debug overlay correlating capture activity with memory pressure.
    /// Returns -1 on task_info failure.
    @objc(getMemoryFootprintMB:rejecter:)
    public func getMemoryFootprintMB(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size
                / MemoryLayout<integer_t>.size
        )
        let kr = withUnsafeMutablePointer(to: &info) { ptr in
            ptr.withMemoryRebound(
                to: integer_t.self, capacity: Int(count)
            ) { reboundPtr in
                task_info(
                    mach_task_self_,
                    task_flavor_t(TASK_VM_INFO),
                    reboundPtr,
                    &count
                )
            }
        }
        if kr != KERN_SUCCESS {
            resolver(-1.0)
            return
        }
        let mb = Double(info.phys_footprint) / (1024.0 * 1024.0)
        resolver(mb)
    }

    /// 2026-05-16 — realtime+batch fusion (Option A) bridge.  Marshal
    /// the options dictionary into the engine layer, dispatch the
    /// refinement off the bridge thread so the JS Promise doesn't block
    /// the bridge queue for the 2-5 s the stitcher takes, and surface
    /// the result/error back to JS.  The actual cv::Stitcher invocation
    /// lives on the engine layer so the auto-trigger path (called from
    /// inside `finalize()`) and the explicit JS path share one
    /// implementation.
    ///
    /// `options` keys:
    ///   - framePaths (NSArray<NSString *>, required, >= 2 entries)
    ///   - outputPath (NSString, required, non-empty)
    ///   - config (NSDictionary, optional) — warperType, blenderType,
    ///       seamFinderType, captureOrientation, useInscribedRectCrop,
    ///       jpegQuality.  Missing fields fall back to spherical /
    ///       multiband / graphcut / portrait / false / 90.
    @objc(refinePanorama:resolver:rejecter:)
    public func refinePanorama(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let framePathsAny = options["framePaths"]
        guard let framePaths = framePathsAny as? [String], framePaths.count >= 2 else {
            rejecter(
                "incremental-refine-invalid-input",
                "refinePanorama requires at least 2 framePaths (got "
                    + "\(((framePathsAny as? [String])?.count) ?? 0)).",
                nil
            )
            return
        }
        let outputPathRaw = (options["outputPath"] as? String) ?? ""
        guard !outputPathRaw.isEmpty else {
            rejecter(
                "incremental-refine-invalid-input",
                "refinePanorama requires a non-empty outputPath.",
                nil
            )
            return
        }
        let outputPath = outputPathRaw.hasPrefix("file://")
            ? String(outputPathRaw.dropFirst(7))
            : outputPathRaw
        let config = options["config"] as? [String: Any] ?? [:]
        RetaiLensIncrementalStitcher.shared.refinePanorama(
            framePaths: framePaths,
            outputPath: outputPath,
            config: config
        ) { result, error in
            if let error = error {
                rejecter(
                    "incremental-refine-failed",
                    error.localizedDescription,
                    error
                )
            } else {
                resolver(result ?? [:])
            }
        }
    }

    /// PiP investigation: write a JS-supplied message into the same
    /// rlis-debug.log file the Swift side uses, so we get a single
    /// timeline across native and JS.  Remove once PiP is fixed.
    @objc(appendDebugLog:resolver:rejecter:)
    public func appendDebugLog(
        message: NSString,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RetaiLensIncrementalStitcher.fileLog("JS: \(message)")
        resolver(["ok": true])
    }

    @objc(getState:rejecter:)
    public func getState(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let dict = RetaiLensIncrementalStitcher.shared.currentStateDictionary()
        resolver(dict ?? NSNull())
    }

    /// V15.0e — JS-callable poll for ARKit plane detection state.
    /// Used by the capture screen to render a status pill when
    /// planeSource=ARKitDetected so the operator knows whether
    /// they're waiting for a plane lock, the plane is detected
    /// but off-axis, or the plane is ready.
    ///
    /// Returns a dictionary:
    ///   `status`           — one of "searching" / "evaluating" / "ready"
    ///   `hasPlane`         — true if a plane is latched
    ///   `bestAlignment`    — best rejected-alignment score seen so
    ///                        far (range [-1, 1]; -1 = no candidate
    ///                        seen yet); when status="evaluating",
    ///                        UI shows this so the operator knows
    ///                        how close they are to clearing the
    ///                        threshold
    ///   `threshold`        — current alignment threshold for
    ///                        comparison/UI display
    /// V15.0g — clear the latched ARKit plane and re-evaluate ALL
    /// currently-tracked vertical planes against the camera's CURRENT
    /// aim.  Picks the BEST candidate by area-weighted alignment
    /// score (largest plane that passes the alignment threshold).
    /// Use this on hold-to-scan press so the plane reflects what the
    /// operator is aiming at right now, not whichever plane ARKit
    /// noticed first.
    ///
    /// Returns:
    ///   `latched` — true if a plane was latched; false if no
    ///               candidate passed the alignment threshold (the
    ///               status pill will keep showing 'searching' /
    ///               'evaluating' and the engine will refuse the
    ///               first capture frame until a plane locks)
    @objc(relatchARPlane:rejecter:)
    public func relatchARPlane(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            let latched = RetaiLensARSession.shared.relatchPlaneFromCurrentAnchors()
            resolver(["latched": latched])
        }
    }

    @objc(getARPlaneStatus:rejecter:)
    public func getARPlaneStatus(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let session = RetaiLensARSession.shared
        let hasPlane = session.hasPlaneDetected
        let best = Double(session.bestRejectedAlignment)
        let threshold = Double(session.planeAlignmentThreshold)
        let status: String
        if hasPlane {
            status = "ready"
        } else if best > 0 {
            // ARKit found a plane but the alignment filter rejected
            // it — operator is in the right ballpark but needs to
            // face the wall more directly.
            status = "evaluating"
        } else {
            status = "searching"
        }
        resolver([
            "status": status,
            "hasPlane": hasPlane,
            "bestAlignment": best,
            "threshold": threshold,
        ])
    }

    // MARK: - Notification → device event

    @objc private func handleStateUpdate(_ notification: Notification) {
        let hasPath = (notification.userInfo?["panoramaPath"] != nil)
        if hasPath {
            RetaiLensIncrementalStitcher.fileLog(
                "bridge handleStateUpdate hasListeners=\(hasListeners) hasPath=\(hasPath) thread=\(Thread.isMainThread ? "main" : "bg")"
            )
        }
        guard hasListeners else { return }
        guard let userInfo = notification.userInfo else { return }
        // FIX: RCTEventEmitter.sendEvent is documented to be called
        // from any thread, but in practice events from background
        // threads can be dropped silently if the bridge is in
        // certain states.  Dispatch to main queue to guarantee
        // delivery.  See e.g. RN issues #19518, #28250.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if hasPath {
                RetaiLensIncrementalStitcher.fileLog(
                    "bridge sendEvent (main queue) body.panoramaPath=\(userInfo["panoramaPath"] ?? "MISSING")"
                )
            }
            self.sendEvent(withName: Self.stateUpdateEvent, body: userInfo)
        }
    }

    public override func startObserving() {
        hasListeners = true
        RetaiLensIncrementalStitcher.fileLog("bridge startObserving (hasListeners=true)")
    }

    public override func stopObserving() {
        hasListeners = false
        RetaiLensIncrementalStitcher.fileLog("bridge stopObserving (hasListeners=false)")
    }
}
#endif
