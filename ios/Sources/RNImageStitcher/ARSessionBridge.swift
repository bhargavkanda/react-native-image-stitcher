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
import ARKit
import simd

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
    // v0.19.0 — async AR-plugin result channel (RNISARPluginRegistry.emit).
    private static let arPluginResultEvent = "RNImageStitcherARPluginResult"

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
        // v0.19.0 — observe the async AR-plugin result channel (posted by
        // `RNISARPluginRegistry.emit`) and re-emit as a JS device event.
        // Same de-dupe rationale as the onArFrame observer above.
        NotificationCenter.default.removeObserver(
            self,
            name: .retailensARPluginResult,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleArPluginResult(_:)),
            name: .retailensARPluginResult,
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
        return [Self.arFrameEvent, Self.arPluginResultEvent]
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

    /// v0.19.0 — forward a posted async AR-plugin result
    /// (`{ plugin, result }`, from `RNISARPluginRegistry.emit`) to JS as
    /// the `RNImageStitcherARPluginResult` device event.  Dropped when no
    /// JS listener is attached.  Emits via `enqueueJSCall` on the main
    /// queue (same `sendEvent`-avoidance rationale as `handleArFrameMeta`).
    @objc private func handleArPluginResult(_ notification: Notification) {
        guard hasListeners else { return }
        guard let userInfo = notification.userInfo else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let bridge = self.bridge else { return }
            bridge.enqueueJSCall(
                "RCTDeviceEventEmitter",
                method: "emit",
                args: [Self.arPluginResultEvent, userInfo],
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

    // MARK: - v0.20.0 — AR overlay renderer

    /// Replace the ENTIRE JS-set overlay collection.  The JS layer (the
    /// shared `arOverlayController`) does the per-id diff and always sends
    /// the FULL current array here on every mutation (declarative prop +
    /// imperative ref methods both funnel through this one method).
    ///
    /// Native replaces its JS-overlay namespace in `RNISAROverlayStore`
    /// wholesale; the per-frame draw view in the mounted `RNSARCameraView`
    /// reprojects + strokes them every ARFrame.  Plugin-placed overlays
    /// (a SEPARATE namespace, via `RNISARPluginRegistry.setOverlays`) are
    /// untouched — the draw view renders the UNION.
    ///
    /// `overlays` is an array of dictionaries matching the JS `AROverlay`
    /// shape (`id`, `worldPosition?`, `sizeMeters?`, `worldQuad?`, `shape?`,
    /// `label?`, `color?`, `mode?`).  Entries missing an `id` or any
    /// geometry are dropped.  Synchronous (no main-queue hop needed — it
    /// only mutates the thread-safe store; the draw view reads it on the
    /// next render pass).
    @objc(setOverlays:resolver:rejecter:)
    public func setOverlays(
        overlays: NSArray,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        var parsed: [RNISAROverlay] = []
        parsed.reserveCapacity(overlays.count)
        for item in overlays {
            guard let dict = item as? [String: Any],
                  let o = RNISAROverlay.from(dictionary: dict) else { continue }
            parsed.append(o)
        }
        RNISAROverlayStore.shared.setJSOverlays(parsed)
        resolver(nil)
    }

    // MARK: - v0.20.0 — raycast (crosshair → real-world surface)

    /// Raycast from the screen CENTER (the crosshair) along the camera's view
    /// ray and resolve the first real-world surface hit as
    /// `{ worldPosition: [x, y, z] }` (metres, ARKit world frame), or `null`
    /// when nothing is hit (e.g. a featureless wall before any plane is
    /// detected — the caller then falls back to a fixed distance ahead).
    ///
    /// Uses an `.estimatedPlane` target so it works before a plane is fully
    /// detected.  No screen point arg is needed: the crosshair is the centre,
    /// so the ray is exactly the camera's forward (−Z) axis from its position.
    /// Pin the marker on THIS hit (then anchor it) and it sits on the real
    /// surface at the real distance, instead of floating a guessed metre ahead.
    @objc(raycast:rejecter:)
    public func raycast(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            let session = RNSARSession.shared.arSession
            guard let frame = session.currentFrame else {
                resolver(nil)
                return
            }
            let t = frame.camera.transform
            let origin = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
            // ARKit camera looks down its local −Z.
            let forward = -simd_float3(t.columns.2.x, t.columns.2.y, t.columns.2.z)
            let query = ARRaycastQuery(
                origin: origin,
                direction: simd_normalize(forward),
                allowing: .estimatedPlane,
                alignment: .any
            )
            guard let hit = session.raycast(query).first else {
                resolver(nil)
                return
            }
            let p = hit.worldTransform.columns.3
            resolver(["worldPosition": [p.x, p.y, p.z]])
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
