// SPDX-License-Identifier: Apache-2.0
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
// JS-visible module name: `IncrementalStitcher`.  Mapped via
// `RCT_EXTERN_REMAP_MODULE` in IncrementalStitcherBridge.m so the
// JS-facing name stays stable while the bridge class itself can be
// renamed without touching JS.

#if canImport(React)
import Foundation
import React
import os.log

@objc(IncrementalStitcherBridge)
public final class IncrementalStitcherBridge: RCTEventEmitter {

    /// Whether at least one JS listener is attached.  RN's
    /// EventEmitter contract: don't emit when no listeners are
    /// registered (the events would be dropped with a console warning).
    private var hasListeners: Bool = false

    private static let stateUpdateEvent = "IncrementalStateUpdate"

    public override init() {
        super.init()
        // Under RN bridgeless interop the bridge's init() can be
        // invoked twice on the same instance (observed via identical
        // instance pointers firing the observer selector twice per
        // notification).  Defensively remove any prior registration
        // for this notification name before adding one, so the
        // observer can only fire once per post regardless of how
        // many times init runs.
        NotificationCenter.default.removeObserver(
            self,
            name: .retailensIncrementalStateUpdate,
            object: nil
        )
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
    /// When `frameSourceMode` is 'frameProcessor' the AR-session check
    /// is skipped and the engine expects the vision-camera Frame
    /// Processor plugin (`CvFlowGateFrameProcessor`) to feed frames
    /// via `consumeFrameFromPlugin`.  The pre-v0.6 'jsDriver' mode
    /// (push frames in from JS via `processFrameAtPath`) has been
    /// removed.
    @objc(start:resolver:rejecter:)
    public func start(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let frameSourceMode =
            (options["frameSourceMode"] as? String) ?? "arSession"
        if frameSourceMode == "arSession" {
            guard RNSARSession.shared.isRunning else {
                rejecter(
                    "ar-session-not-running",
                    "RNSARSession.start() must be called before "
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
        // Engine selection.  The live incremental engines (hybrid,
        // slitscan-*, and the legacy firstwins* aliases) were archived
        // in the 2026-06 batch-keyframe cleanup — the SDK now ships
        // only 'batch-keyframe'.  Any other value is still accepted for
        // backward compatibility but falls back to batch-keyframe with
        // a deprecation log inside IncrementalStitcher.start().
        let engineMode = (options["engine"] as? String) ?? "batch-keyframe"

        // Per-stage config overrides.  All optional; keys not consumed
        // by the batch-keyframe pipeline are ignored.
        let configOverrides = options["config"] as? [String: Any] ?? [:]

        IncrementalStitcher.shared.start(
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
            // Mirror RNSARSession's path-generation behaviour
            // — host code can call finalize() with no path and a
            // tmp file is created in the app's sandbox tmp dir.
            let dir = NSTemporaryDirectory()
            outputPath = (dir as NSString).appendingPathComponent(
                "RNImageStitcherIncremental-\(UUID().uuidString).jpg"
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
            IncrementalStitcher.shared.updateCaptureOrientation(
                freshOrientation
            )
        }
        // 2026-05-22 (audit F2b) — JS may pass cumulative IMU
        // translation in METRES so the stitchMode auto-resolver has a
        // translation signal in non-AR mode (where the JS-driver path
        // doesn't carry pose tx/ty/tz).  Always ≥ 0; defaults to 0 if
        // unset (back-compat — auto-resolver falls back to pose data
        // and to PANORAMA when both are 0).
        let imuT = (options["imuTranslationMetres"] as? Double) ?? 0.0
        IncrementalStitcher.shared.updateImuTranslationMetres(imuT)
        IncrementalStitcher.shared.finalize(
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
        IncrementalStitcher.shared.cancel()
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
        IncrementalStitcher.shared.markNextFrameAsLastKeyframe()
        resolver(["ok": true])
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
        let result = IncrementalStitcher.shared
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
        let path = IncrementalStitcher.shared.currentKeyframeDir() ?? ""
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

    /// Total physical RAM in MB.  Lets the DEV memory pill derive RAM-aware
    /// pressure bands (iOS jetsam scales with device RAM) instead of fixed
    /// thresholds.  NSProcessInfo.physicalMemory is exact + cheap.
    @objc(getDeviceTotalRamMB:rejecter:)
    public func getDeviceTotalRamMB(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        resolver(Double(ProcessInfo.processInfo.physicalMemory) / (1024.0 * 1024.0))
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
        IncrementalStitcher.shared.refinePanorama(
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
        IncrementalStitcher.fileLog("JS: \(message)")
        resolver(["ok": true])
    }

    @objc(getState:rejecter:)
    public func getState(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let dict = IncrementalStitcher.shared.currentStateDictionary()
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
            let latched = RNSARSession.shared.relatchPlaneFromCurrentAnchors()
            resolver(["latched": latched])
        }
    }

    @objc(getARPlaneStatus:rejecter:)
    public func getARPlaneStatus(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let session = RNSARSession.shared
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
        let refineStage = notification.userInfo?["refineStage"] as? String
        if hasPath || refineStage != nil {
            IncrementalStitcher.fileLog(
                "bridge handleStateUpdate hasListeners=\(hasListeners) hasPath=\(hasPath) refineStage=\(refineStage ?? "nil") thread=\(Thread.isMainThread ? "main" : "bg")"
            )
        }
        guard hasListeners else {
            if let stage = refineStage {
                IncrementalStitcher.fileLog(
                    "bridge handleStateUpdate DROPPED refineStage=\(stage) — hasListeners=false"
                )
            }
            return
        }
        guard let userInfo = notification.userInfo else { return }
        // We deliver via `bridge.enqueueJSCall("RCTDeviceEventEmitter", "emit", ...)`
        // rather than `RCTEventEmitter.sendEvent(...)` because under RN
        // bridgeless interop `sendEvent` silently no-ops for some
        // event-body shapes even when `_bridge` is non-nil and
        // `_listenerCount > 0` (confirmed via os_log instrumentation
        // during v0.10.0 PR B development — refine events with
        // refineStage/refineProgress/refineFrames were not reaching
        // any JS subscriber while live state events with a smaller
        // body shape on the same channel were).  enqueueJSCall is
        // the underlying mechanism sendEvent uses in Paper mode, so
        // it is strictly at least as well-supported.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if hasPath || refineStage != nil {
                IncrementalStitcher.fileLog(
                    "bridge enqueueJSCall (main queue) body.panoramaPath=\(userInfo["panoramaPath"] ?? "MISSING") refineStage=\(refineStage ?? "nil")"
                )
            }
            guard let bridge = self.bridge else {
                if hasPath || refineStage != nil {
                    IncrementalStitcher.fileLog(
                        "bridge enqueueJSCall DROPPED — self.bridge is nil"
                    )
                }
                return
            }
            bridge.enqueueJSCall(
                "RCTDeviceEventEmitter",
                method: "emit",
                args: [Self.stateUpdateEvent, userInfo],
                completion: nil
            )
        }
    }

    public override func startObserving() {
        hasListeners = true
        IncrementalStitcher.fileLog("bridge startObserving (hasListeners=true)")
    }

    public override func stopObserving() {
        hasListeners = false
        IncrementalStitcher.fileLog("bridge stopObserving (hasListeners=false)")
    }
}
#endif
