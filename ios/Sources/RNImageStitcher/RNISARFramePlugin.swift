// SPDX-License-Identifier: Apache-2.0
//
// RNISARFramePlugin — v0.19.0 native AR plugin framework (iOS).
//
// The SDK owns the ARSession and drives one per-frame callback path
// (`RNSARSession.session(_:didUpdate:)`).  Host apps that need to run
// heavier native per-frame analysis (OCR, barcode reading, ML
// inference, …) register a *native* plugin against this framework — the
// SDK ships ONLY the generic plumbing; no OCR or other concrete plugin.
//
// The ergonomics mirror vision-camera's FrameProcessorPlugin
// registration: the host conforms a class to `RNISARFramePlugin`,
// registers it once at startup via `RNISARPluginRegistry.shared`, and
// the SDK calls `process(_:)` on the AR thread for every ARFrame while
// the registry is non-empty.
//
// Two result channels:
//   1. SYNC — `process(_:)` returns a light `[String: Any]?`.  Non-nil
//      results are folded into the throttled `onArFrame` `ARFrameMeta`
//      under `plugins: { [name]: result }`, riding the existing
//      `RNImageStitcherARFrame` device event.  Use for cheap, per-frame
//      scalars (brightness, a quick blur score, …).
//   2. ASYNC — the plugin offloads heavy work to its own queue and later
//      calls `RNISARPluginRegistry.shared.emit(name, result)`, which the
//      SDK re-emits as the `RNImageStitcherARPluginResult` device event
//      `{ plugin, result }`.  Use for OCR / ML whose latency exceeds a
//      frame interval.
//
// PERFORMANCE CONTRACT: the SDK only builds the `RNISARFrameContext` and
// calls plugins when the registry is NON-EMPTY, so a zero-plugin app
// pays nothing on the AR hot path.  Plugins MUST self-throttle (the SDK
// calls `process(_:)` on every ARFrame) and MUST offload anything
// heavier than a few hundred microseconds.

import Foundation
import ARKit
import CoreVideo
import simd

// MARK: - Async result event channel

/// v0.19.0 — async AR-plugin result channel.  `RNISARPluginRegistry.emit`
/// posts this notification (carrying `{ plugin, result }`); the
/// `RNSARSessionBridge` (an RCTEventEmitter) observes it and re-emits as
/// the JS `RNImageStitcherARPluginResult` device event.  We route via
/// NotificationCenter — rather than the registry holding a bridge
/// reference — mirroring the `.retailensARFrameMeta` (`onArFrame`)
/// channel, so the framework-free engine pattern is preserved.
public extension Notification.Name {
    static let retailensARPluginResult =
        Notification.Name("RNImageStitcherARPluginResult")
}


// MARK: - Plugin protocol

/// A native AR frame plugin.  Host apps conform a class to this and
/// register it once via `RNISARPluginRegistry.shared.register(_:)`.
///
/// The SDK calls `process(_:)` once per ARFrame on the AR (ARSession
/// delegate) thread while the registry is non-empty.  Return a light
/// `[String: Any]?` for the SYNC channel, or `nil`; for heavy work,
/// offload to your own queue and later call
/// `RNISARPluginRegistry.shared.emit(name(), result)` for the ASYNC
/// channel.
@objc public protocol RNISARFramePlugin: AnyObject {
    /// Stable identifier for this plugin.  Used as the key in the
    /// `onArFrame` meta's `plugins` map AND as the `plugin` field of the
    /// async `RNImageStitcherARPluginResult` event.  Keep it constant for
    /// the plugin's lifetime; the registry stores plugins keyed by name
    /// (a second `register` with the same name replaces the first).
    func name() -> String

    /// Called on the AR thread once per ARFrame while the registry is
    /// non-empty.  Return a light JSON-safe result for the SYNC channel
    /// (NSNumber / NSString / NSArray / NSDictionary leaves) or `nil`.
    ///
    /// LIFETIME: `context.pixelBuffer` (and `context.depthBuffer`) are the
    /// live ARFrame buffers — VALID ONLY for the duration of this call.
    /// ARKit recycles them once `process(_:)` returns.  If you offload
    /// work to another thread/queue, you MUST copy the bytes you need
    /// BEFORE returning.  Do NOT retain the CVPixelBuffer expecting the
    /// pixels to survive — a CF retain does not protect against ARKit's
    /// pool reuse.
    func process(_ context: RNISARFrameContext) -> [String: Any]?
}


// MARK: - Per-frame context

/// Zero-copy native view of one ARFrame, handed to each plugin's
/// `process(_:)`.  Exposes the live capture buffer + pose + intrinsics +
/// (opt-in) depth + (opt-in) anchors.  Nothing here is copied for the
/// plugin's benefit; the buffers belong to ARKit and are valid only
/// during the synchronous `process(_:)` call (see the lifetime note on
/// `RNISARFramePlugin.process(_:)`).
@objc(RNISARFrameContext)
public final class RNISARFrameContext: NSObject {

    /// The ARFrame's `capturedImage` (BGRA/YUV `CVPixelBuffer`).  VALID
    /// ONLY during `process(_:)` — copy before offloading (see the
    /// lifetime note on `RNISARFramePlugin.process(_:)`).
    @objc public let pixelBuffer: CVPixelBuffer

    /// Frame timestamp in NANOSECONDS (AR-framework monotonic clock) —
    /// matches `CameraFrame.timestampNs` and the `ARFrameMeta.timestamp`
    /// contract.
    @objc public let timestampNs: Double

    /// Camera intrinsics (pixels).  `imageWidth`/`imageHeight` are the
    /// capture resolution the intrinsics are expressed against.
    @objc public let fx: Double
    @objc public let fy: Double
    @objc public let cx: Double
    @objc public let cy: Double
    @objc public let imageWidth: Int
    @objc public let imageHeight: Int

    /// World-space camera pose: rotation as a unit quaternion
    /// `[x, y, z, w]` and translation `[x, y, z]` in metres (ARKit's
    /// right-handed, Y-up, -Z-forward world frame).
    @objc public let poseRotation: [Double]
    @objc public let poseTranslation: [Double]

    /// Tracking quality: `"notAvailable"` / `"limited"` / `"normal"`.
    @objc public let trackingState: String

    /// The ARFrame's `sceneDepth` (or `smoothedSceneDepth`) depth map
    /// `CVPixelBuffer` — `nil` unless the `<Camera enableDepth>` prop is
    /// on AND the device produced depth this frame.  VALID ONLY during
    /// `process(_:)`; copy before offloading.
    @objc public let depthBuffer: CVPixelBuffer?

    /// Tracking anchors as the same light dicts the `onArFrame` meta
    /// surfaces (`{ id, type, alignment?, extent?, classification?,
    /// transform }`; mesh anchors excluded).  EMPTY unless the
    /// `<Camera enableAnchors>` prop is on.
    @objc public let anchors: [[String: Any]]

    /// ARKit SLAM feature-point cloud in world space — each element is
    /// a `simd_float3` (x, y, z) in metres in ARKit's right-handed Y-up
    /// world frame.  `nil` unless the `<Camera enableFeaturePoints>` prop
    /// is on.  Available on ALL ARKit-capable devices — no LiDAR required.
    /// Unlike `pixelBuffer` / `depthBuffer`, this array is a VALUE copy from
    /// ARKit and is safe to retain beyond the `process(_:)` call.
    public let featurePoints: [simd_float3]?

    // NOTE: @objc is intentionally dropped from this init.  Swift refuses to
    // expose an @objc init whose parameter list includes a type that is not
    // ObjC-bridgeable ([simd_float3]? is a Swift-only value type).  The class
    // itself remains @objc(RNISARFrameContext) for ObjC visibility; only the
    // designated init is Swift-only.  All existing callers are Swift
    // (invokeArPlugins in RNSARSession.swift), so nothing breaks.
    public init(
        pixelBuffer: CVPixelBuffer,
        timestampNs: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        poseRotation: [Double],
        poseTranslation: [Double],
        trackingState: String,
        depthBuffer: CVPixelBuffer?,
        anchors: [[String: Any]],
        featurePoints: [simd_float3]?
    ) {
        self.pixelBuffer = pixelBuffer
        self.timestampNs = timestampNs
        self.fx = fx; self.fy = fy; self.cx = cx; self.cy = cy
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.poseRotation = poseRotation
        self.poseTranslation = poseTranslation
        self.trackingState = trackingState
        self.depthBuffer = depthBuffer
        self.anchors = anchors
        self.featurePoints = featurePoints
    }
}


// MARK: - Registry

/// Process-wide registry of native AR plugins + the async result router.
///
/// The host registers plugins at startup (e.g. in the AppDelegate); the
/// SDK reads `plugins()` on the AR thread each frame.  Also the entry
/// point for the ASYNC channel: a plugin calls `emit(name, result)` from
/// its own queue and the SDK re-emits a `RNImageStitcherARPluginResult`
/// JS event.
///
/// THREAD SAFETY: registration (host/startup thread) and reads (AR
/// thread) are serialised by an internal lock.  `plugins()` returns a
/// snapshot array so the AR thread can iterate without holding the lock.
@objc(RNISARPluginRegistry)
public final class RNISARPluginRegistry: NSObject {

    /// Shared instance — the only way hosts register plugins.
    @objc public static let shared = RNISARPluginRegistry()

    /// Registered plugins, keyed by `name()` for O(1) replace/unregister.
    /// Insertion order is preserved for deterministic `process(_:)`
    /// ordering via a parallel ordered key list.
    private var pluginsByName: [String: RNISARFramePlugin] = [:]
    private var order: [String] = []
    private let lock = NSLock()

    private override init() { super.init() }

    /// Register (or replace) a plugin.  Keyed by `plugin.name()`: a
    /// second register with the same name replaces the first (and keeps
    /// its position in the ordering).  Idempotent for the same instance.
    @objc public func register(_ plugin: RNISARFramePlugin) {
        let key = plugin.name()
        lock.lock()
        defer { lock.unlock() }
        if pluginsByName[key] == nil {
            order.append(key)
        }
        pluginsByName[key] = plugin
    }

    /// Remove the plugin registered under `name`.  No-op if absent.
    @objc public func unregister(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        pluginsByName.removeValue(forKey: name)
        order.removeAll { $0 == name }
    }

    /// Snapshot of registered plugins in registration order.  Returns a
    /// copy so the AR thread can iterate without holding the lock.
    @objc public func plugins() -> [RNISARFramePlugin] {
        lock.lock()
        defer { lock.unlock() }
        return order.compactMap { pluginsByName[$0] }
    }

    /// Whether any plugin is registered.  Cheap gate the SDK checks per
    /// ARFrame before building the (per-frame) `RNISARFrameContext`.
    @objc public var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return order.isEmpty
    }

    /// ASYNC channel — route a plugin's later-computed result to JS as the
    /// `RNImageStitcherARPluginResult` device event `{ plugin, result }`.
    /// Safe to call from any thread (the plugin's own queue); posts on
    /// NotificationCenter, which the bridge observes + re-emits on the
    /// main queue.
    ///
    /// `pluginName` should match the plugin's `name()` so JS can correlate
    /// the result with its source.
    @objc public func emit(_ pluginName: String, _ result: [String: Any]) {
        NotificationCenter.default.post(
            name: .retailensARPluginResult,
            object: nil,
            userInfo: [
                "plugin": pluginName,
                "result": result,
            ]
        )
    }

    // MARK: - v0.20.0 — native-plugin overlay placement

    // A native plugin can place AR overlays DIRECTLY (native→native, zero
    // JS latency) via the methods below.  Plugin overlays live in their
    // OWN namespace in `RNISAROverlayStore`, separate from JS-set overlays
    // — the draw view renders the UNION, so a plugin placing overlays
    // never clobbers `<Camera overlays={...}>` / the imperative ref, and
    // vice-versa.  Safe to call from any thread (the store is internally
    // locked); the per-frame draw view picks the change up on its next
    // redraw.

    /// Replace the ENTIRE plugin overlay set.  Pass the same dictionary
    /// shape the JS `AROverlay` interface uses (`id`, `worldPosition`,
    /// `sizeMeters`, `worldQuad`, `shape`, `label`, `color`, `mode`).
    /// Entries missing an `id` or any geometry are dropped.
    @objc public func setOverlays(_ overlays: [[String: Any]]) {
        let parsed = overlays.compactMap { RNISAROverlay.from(dictionary: $0) }
        RNISAROverlayStore.shared.setPluginOverlays(parsed)
    }

    /// Add or replace a single plugin overlay (same dictionary shape as
    /// `setOverlays`).  No-op if the dict has no `id` / no geometry.
    @objc public func addOverlay(_ overlay: [String: Any]) {
        guard let parsed = RNISAROverlay.from(dictionary: overlay) else { return }
        RNISAROverlayStore.shared.addPluginOverlay(parsed)
    }

    /// Remove a single plugin overlay by id.  No-op if absent.
    @objc public func removeOverlay(_ id: String) {
        RNISAROverlayStore.shared.removePluginOverlay(id)
    }

    /// Clear ALL plugin overlays.  JS-set overlays are untouched.
    @objc public func clearOverlays() {
        RNISAROverlayStore.shared.clearPluginOverlays()
    }
}
