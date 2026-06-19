// SPDX-License-Identifier: Apache-2.0
//
// ARSessionBridge — RN bridge for RNSARSession.
//
// JS surface (mirrored on Android via the analogous ARCore bridge):
//
//   isSupported() → Promise<boolean>
//   start() → Promise<void>
//   stop() → Promise<void>
//   getState() → Promise<{ isRunning, trackingState }>
//   snapshotPoseLog() → Promise<FramePose[]>
//
// Phase 5+ APIs (stitchVideoWithPoses) are added on the existing
// BatchStitcher bridge, not here — keeps each module focused on
// one ARKit/OpenCV concern.

import Foundation
import React

// v0.18.0 — `RNSARSessionBridge` is now an `RCTEventEmitter` (was a
// plain `NSObject`) so it can deliver the `onArFrame` LIGHT-metadata
// channel as the JS `RNImageStitcherARFrame` device event.  The JS side
// subscribes via `new NativeEventEmitter(NativeModules.RNSARSession)` —
// the same module name this bridge is remapped to (see ARSessionBridge.m).
//
// Pattern mirrors `IncrementalStitcherBridge`: observe a NotificationCenter
// post from the framework-free `RNSARSession` engine, then re-emit on the
// main queue via `bridge.enqueueJSCall("RCTDeviceEventEmitter", "emit", …)`
// rather than `RCTEventEmitter.sendEvent(…)`, because under RN bridgeless
// interop `sendEvent` silently no-ops for some event-body shapes (see the
// IncrementalStitcherBridge.handleStateUpdate docstring).
@objc(RNSARSessionBridge)
public final class RNSARSessionBridge: RCTEventEmitter {

    /// Whether at least one JS listener is attached to the AR-frame event.
    /// RN's EventEmitter contract: don't emit when no listeners are
    /// registered.  Toggled by `startObserving` / `stopObserving`.
    private var hasListeners: Bool = false

    private static let arFrameEvent = "RNImageStitcherARFrame"

    public override init() {
        super.init()
        // Defensively de-dupe the observer: under RN bridgeless interop a
        // bridge's init() can run twice on the same instance.  Remove any
        // prior registration for this notification before adding, so the
        // observer fires at most once per post regardless.
        NotificationCenter.default.removeObserver(
            self,
            name: .retailensARFrameMeta,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleArFrameMeta(_:)),
            name: .retailensARFrameMeta,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - RCTEventEmitter protocol

    public override static func requiresMainQueueSetup() -> Bool {
        // ARSession.start() must be called on the main thread —
        // ARKit needs to attach to the active CVDisplayLink.
        return true
    }

    public override func supportedEvents() -> [String]! {
        return [Self.arFrameEvent]
    }

    public override func startObserving() {
        hasListeners = true
    }

    public override func stopObserving() {
        hasListeners = false
    }

    /// Forward a posted `ARFrameMeta` dictionary to JS as the
    /// `RNImageStitcherARFrame` device event.  Dropped when no JS listener
    /// is attached.  Emits via `enqueueJSCall` on the main queue (see the
    /// class docstring for why not `sendEvent`).
    @objc private func handleArFrameMeta(_ notification: Notification) {
        guard hasListeners else { return }
        guard let userInfo = notification.userInfo else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let bridge = self.bridge else { return }
            bridge.enqueueJSCall(
                "RCTDeviceEventEmitter",
                method: "emit",
                args: [Self.arFrameEvent, userInfo],
                completion: nil
            )
        }
    }

    // MARK: - Module methods

    /// v0.18.0 — toggle the `onArFrame` LIGHT-metadata channel.  Called
    /// from JS with `true` + the throttle interval (ms) when a host
    /// supplies `<Camera onArFrame={...}>`, and `false` on
    /// unmount / prop-removal.  Resolves with no value.
    @objc(setArFrameMetaEnabled:intervalMs:resolver:rejecter:)
    public func setArFrameMetaEnabled(
        enabled: NSNumber,
        intervalMs: NSNumber,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RNSARSession.shared.setArFrameMetaEnabled(
            enabled.boolValue,
            intervalMs: intervalMs.doubleValue
        )
        resolver(nil)
    }

    @objc(isSupported:rejecter:)
    public func isSupported(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        resolver(RNSARSession.isSupported)
    }

    @objc(start:rejecter:)
    public func start(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            RNSARSession.shared.start()
            resolver(nil)
        }
    }

    @objc(stop:rejecter:)
    public func stop(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            RNSARSession.shared.stop()
            resolver(nil)
        }
    }

    @objc(getState:rejecter:)
    public func getState(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let s = RNSARSession.shared
        resolver([
            "isRunning": s.isRunning,
            "trackingState": s.currentTrackingState.rawValue,
        ])
    }

    /// Toggle ARKit scene reconstruction (LiDAR mesh / `ARMeshAnchor`s).
    /// Driven by the <Camera> `enableMesh` prop; gates the
    /// StitcherFrame `meshGeometry` extraction at the SESSION level
    /// (the per-frame `__stitcherProxy.setExtractionConfig(...mesh)`
    /// gates the marshaling — both must be on for a host to receive
    /// mesh).  Resolves with no value.
    ///
    /// Hops to the main queue: `setSceneReconstructionEnabled` may call
    /// `arSession.run(config)` to reconfigure a live session, and
    /// ARKit session lifecycle must run on the main thread (same
    /// constraint as `start`).
    @objc(setSceneReconstructionEnabled:resolver:rejecter:)
    public func setSceneReconstructionEnabled(
        enabled: NSNumber,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let on = enabled.boolValue
        DispatchQueue.main.async {
            RNSARSession.shared.setSceneReconstructionEnabled(on)
            resolver(nil)
        }
    }

    /// Hops to the main queue: `setPlaneDetection` may call
    /// `arSession.run(config)` to reconfigure a live session, and ARKit
    /// session lifecycle must run on the main thread (same constraint as
    /// `start` / `setSceneReconstructionEnabled`).
    @objc(setPlaneDetection:resolver:rejecter:)
    public func setPlaneDetection(
        mode: NSString,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let m = mode as String
        DispatchQueue.main.async {
            RNSARSession.shared.setPlaneDetection(m)
            resolver(nil)
        }
    }

    @objc(snapshotPoseLog:rejecter:)
    public func snapshotPoseLog(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let poses = RNSARSession.shared.snapshotPoseLog()
        resolver(poses.map { $0.asDictionary() })
    }

    @objc(clearPoseLog:rejecter:)
    public func clearPoseLog(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RNSARSession.shared.clearPoseLog()
        resolver(nil)
    }

    // MARK: - Phase 5: AR-backed photo + video capture

    /// `options` keys: `path` (required), `quality` (optional, 0-100,
    /// default 90).  Resolves with `{ path, width, height, isMirrored,
    /// isRawPhoto }` matching vision-camera's PhotoFile shape.
    @objc(takePhoto:resolver:rejecter:)
    public func takePhoto(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let path = (options["path"] as? String) ?? ""
        let quality = (options["quality"] as? Int) ?? 90
        // v0.12.0 — host passes the actual device orientation so
        // the saved JPEG matches the user's view.  Defaults to
        // "portrait" if absent, preserving pre-v0.12 behavior for
        // any caller that hasn't been updated.
        let orientation = (options["orientation"] as? String) ?? "portrait"
        RNSARSession.shared.takePhoto(
            toPath: path,
            quality: quality,
            orientation: orientation
        ) { result, error in
            if let error = error {
                rejecter("ar-photo-failed", error.localizedDescription, error)
            } else {
                resolver(result)
            }
        }
    }

    /// `options` keys: `path` (optional, native generates one in
    /// NSTemporaryDirectory when omitted).  Resolves with `{ path }`
    /// once recording is set up (frames begin flowing automatically
    /// from the ARSession delegate).
    @objc(startRecording:resolver:rejecter:)
    public func startRecording(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let path = (options["path"] as? String) ?? ""
        RNSARSession.shared.startRecording(toPath: path) { resolvedPath, error in
            if let error = error {
                rejecter("ar-recording-failed", error.localizedDescription, error)
            } else {
                resolver(["path": resolvedPath ?? ""])
            }
        }
    }

    /// Resolves with `{ path, duration, size, width, height }`
    /// matching vision-camera's VideoFile shape.
    @objc(stopRecording:rejecter:)
    public func stopRecording(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RNSARSession.shared.stopRecording { result, error in
            if let error = error {
                rejecter("ar-stop-failed", error.localizedDescription, error)
            } else {
                resolver(result)
            }
        }
    }
}
