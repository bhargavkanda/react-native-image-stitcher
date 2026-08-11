// SPDX-License-Identifier: Apache-2.0
//
// RNSPhotoCapturePlugin — the photo-capture plugin hook (iOS).
//
// `RNSARSession.takePhoto` owns the AR photo pipeline (frame grab → JPEG
// encode → result promise).  Host apps that need native per-photo work —
// extracting extra per-frame data into sidecar files, stamping custom
// metadata, feeding an ML pipeline — register a plugin here instead of
// forking the capture path.  The library ships ONLY this generic plumbing;
// no concrete plugin.
//
// The ergonomics mirror the per-frame `RNISARFramePlugin` registry: the
// host conforms a class to `RNSPhotoCapturePlugin`, registers it once at
// startup, and the session calls `photoCaptured(frame:photoPath:options:)`
// for every AR photo while the registry is non-empty.
//
// CONTRACT (all four clauses are load-bearing):
//
//   * SYNCHRONOUS, AFTER THE JPEG.  The callback runs inside takePhoto's
//     encode path, after the JPEG is on disk and before the promise
//     resolves.  The plugin may read the photo file and may write sidecar
//     files next to `photoPath`; anything it reports is guaranteed to
//     describe files that already exist when JS sees the result.
//
//   * THE EXACT ARFrame.  `frame` is the very ARFrame whose pixels became
//     the photo (the hi-res capture frame when iOS 16's
//     `captureHighResolutionFrame` succeeded, otherwise the live frame).
//     It is valid for the DURATION OF THE CALL ONLY — copy any buffer
//     contents (sceneDepth, capturedImage, …) before returning.  Retaining
//     an ARFrame past the callback stalls ARKit's frame pool and the
//     capture pipeline with it.
//
//   * BUDGET.  The call runs on takePhoto's background encode thread (never
//     the main thread, never the AR render callback), but its cost adds to
//     the takePhoto promise latency 1:1 and extends the one-frame retention
//     window.  Stay in the tens-of-milliseconds range; offload heavier work
//     to your own queue AFTER copying what you need.
//
//   * ERRORS ARE REPORTED, NEVER THROWN.  The method does not throw; a
//     failing plugin returns nil (or a payload describing the failure, e.g.
//     `["mySidecarUnavailable": "write-failed"]`).  A plugin must never be
//     able to fail the photo itself.
//
// Result merge: the returned dictionary is merged into the takePhoto result
// via `RNSPhotoCapturePayload.merge` — the library's own keys always win,
// and between plugins the first to claim a key wins.  With NO plugin
// registered the library's behaviour (and its result payload) is
// byte-identical to a build without this hook.

#if canImport(ARKit)
import ARKit
import Foundation

// MARK: - Plugin protocol

/// A native photo-capture plugin.  Host apps conform a class to this and
/// register it once via `RNSPhotoCapturePluginRegistry.register(photoPlugin:)`.
/// See the file header for the full contract (synchronous, frame lifetime,
/// budget, error handling).
@objc public protocol RNSPhotoCapturePlugin: AnyObject {
    /// Called synchronously inside takePhoto with the EXACT ARFrame whose
    /// pixels became the photo (hi-res or live path), after the JPEG is
    /// written.  May write sidecar files next to `photoPath`; returned
    /// fields are merged into the takePhoto result payload.  `options` is
    /// the full takePhoto options dictionary as JS sent it, so a host can
    /// route per-call flags to its plugin without a library change.
    /// Errors are reported (via the returned payload), never thrown.
    func photoCaptured(
        frame: ARFrame,
        photoPath: String,
        options: [String: Any]
    ) -> [String: Any]?
}


// MARK: - Registry

/// Process-wide registry of photo-capture plugins.
///
/// THREAD SAFETY: registration (host/startup thread) and reads (takePhoto's
/// encode thread) are serialised by an internal lock; `plugins()` returns a
/// snapshot array so the capture path iterates without holding the lock —
/// the same discipline as the per-frame plugin registry.
@objc(RNSPhotoCapturePluginRegistry)
public final class RNSPhotoCapturePluginRegistry: NSObject {

    /// Shared instance — the only registry the capture path consults.
    @objc public static let shared = RNSPhotoCapturePluginRegistry()

    /// Registered plugins in registration order.  Identity-keyed: the same
    /// instance registers once however many times `register` is called.
    private var registered: [RNSPhotoCapturePlugin] = []
    private let lock = NSLock()

    private override init() { super.init() }

    /// Register a plugin (static convenience — the documented entry point).
    @objc public static func register(photoPlugin: RNSPhotoCapturePlugin) {
        shared.register(photoPlugin)
    }

    /// Remove a previously registered plugin (static convenience).
    @objc public static func unregister(photoPlugin: RNSPhotoCapturePlugin) {
        shared.unregister(photoPlugin)
    }

    /// Register a plugin.  Idempotent for the same instance (registering
    /// twice keeps one entry at its original position).
    @objc public func register(_ plugin: RNSPhotoCapturePlugin) {
        lock.lock()
        defer { lock.unlock() }
        guard !registered.contains(where: { $0 === plugin }) else { return }
        registered.append(plugin)
    }

    /// Remove a plugin by identity.  No-op if it was never registered.
    @objc public func unregister(_ plugin: RNSPhotoCapturePlugin) {
        lock.lock()
        defer { lock.unlock() }
        registered.removeAll { $0 === plugin }
    }

    /// Whether any plugin is registered.  Cheap gate `takePhoto` checks
    /// BEFORE deciding to forward the ARFrame into the encode path — a
    /// zero-plugin app never retains the frame past the grab and its result
    /// payload is byte-identical to the pre-hook library.
    @objc public var isEmpty: Bool {
        lock.lock()
        defer { lock.unlock() }
        return registered.isEmpty
    }

    /// Snapshot of registered plugins in registration order.
    @objc public func plugins() -> [RNSPhotoCapturePlugin] {
        lock.lock()
        defer { lock.unlock() }
        return registered
    }

    /// Capture-path entry point: run every plugin against the captured
    /// frame and fold their payloads into `result` (library keys win; see
    /// `RNSPhotoCapturePayload.merge`).  Called by
    /// `RNSARSession.encodeArPhoto` after the JPEG write.
    func invoke(
        frame: ARFrame,
        photoPath: String,
        options: [String: Any],
        result: [String: Any]
    ) -> [String: Any] {
        var payloads: [[String: Any]] = []
        for plugin in plugins() {
            if let payload = plugin.photoCaptured(
                frame: frame, photoPath: photoPath, options: options
            ) {
                payloads.append(payload)
            }
        }
        return RNSPhotoCapturePayload.merge(result: result, payloads: payloads)
    }
}
#endif
