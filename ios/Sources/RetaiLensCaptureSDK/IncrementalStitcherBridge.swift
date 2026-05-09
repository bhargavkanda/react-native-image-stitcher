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
    /// Resolves with `{ ok: true }`.  Rejects only if AR session is
    /// not running — the engine needs an active session to receive
    /// frames from.
    @objc(start:resolver:rejecter:)
    public func start(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard RetaiLensARSession.shared.isRunning else {
            rejecter(
                "ar-session-not-running",
                "RetaiLensARSession.start() must be called before "
                + "the incremental stitcher.",
                nil
            )
            return
        }
        let composeW = (options["composeWidth"] as? Int) ?? 0
        let composeH = (options["composeHeight"] as? Int) ?? 0
        let canvasW  = (options["canvasWidth"]  as? Int) ?? 0
        let canvasH  = (options["canvasHeight"] as? Int) ?? 0
        let feather  = (options["featherPx"] as? Int) ?? 0
        let snapQ    = (options["snapshotJpegQuality"] as? Int) ?? 75
        let snapN    = (options["snapshotEveryNAccepts"] as? Int) ?? 1
        let rotation = (options["frameRotationDegrees"] as? Int) ?? 90
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
            configOverrides: configOverrides
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
