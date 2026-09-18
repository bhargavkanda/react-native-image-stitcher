// SPDX-License-Identifier: Apache-2.0
//
// RNISArExposureProbe — ARKit's OWN per-frame exposure, so the AE-lock
// evidence stops being circular.
//
// ── The defect this exists for ───────────────────────────────────────────
//
// `RNISPanoCameraLock` asserts the sweep's AE/AWB/AF lock on an
// `AVCaptureDevice` THIS POD resolves — `AVCaptureDevice.default(.builtIn-
// WideAngleCamera, .video, .back)` — and then verifies it by reading that
// SAME object back.  The pack's `exposure.rangeRatio = 1.00`,
// `locked: true`, `observedUnlockedFrames: 0` therefore prove exactly one
// thing: the object we touched did not move.  They are CIRCULAR with respect
// to the two questions that matter:
//
//   1. Is that the device ARKit is streaming?  The lock file's own header
//      argues it must be (world tracking uses the back wide-angle) — an
//      argument, not a measurement.
//   2. Does the lock reach the pixels ARKit hands us?  The same header
//      explicitly declines to claim it does, and says "the pack carries the
//      EVIDENCE instead of the claim".  This is the piece of evidence it is
//      missing.
//
// `ARCamera.exposureDuration` (seconds) and `ARCamera.exposureOffset` (EV)
// come off the ARFrame itself.  Recorded beside the device reading they
// settle BOTH: agreement on the same frame is device identity, and a flat
// ARKit trace is the lock landing where it was meant to.
//
// ── Why this is a view-hierarchy walk, which needs justifying ────────────
//
// `RNISARFrameContext` — the only per-frame surface the public stitcher
// hands a native plugin — carries pixels, pose, intrinsics, depth, anchors
// and feature points, and NO exposure.  `RNSARSession.arSession` is
// `internal` to the public module.  `ARFrameConsumer` and the worklet
// runtime's `setFirstPartyCallback` are single-slot and already claimed, and
// neither carries an `ARFrame` anyway.  And widening the shared plugin ABI
// for one engine's benefit is a breaking change for every other host.
//
// What IS reachable, through public API only: `RNSARCameraView` binds
// `arSCNView.session = RNSARSession.shared.arSession` and adds that
// `ARSCNView` as a subview.  `ARSCNView` is a public ARKit class and
// `UIView.subviews` is public, so the session is findable by walking the
// window hierarchy for one.  That is what this does.
//
// REJECTED ALTERNATIVE, recorded so it is not re-proposed: reading the
// `arSession` ivar off `RNSARSession.shared` through the ObjC runtime.  It
// would work today and needs no view, but it depends on Swift's stored-
// property ivar layout for a type in another module — an implementation
// detail with no contract, which would fail silently and invisibly on a
// stitcher rebuild.  A public-API walk that reports what it found is worth
// more than a private read that cannot.
//
// ── What this does NOT claim ─────────────────────────────────────────────
//
// It is EVIDENCE, not a control input.  Nothing here changes the sweep: the
// engine records these two floats and normalises radiometry off the
// AVCaptureDevice pair exactly as v6 left it.  A build where discovery fails
// produces a byte-identical canvas and a pack that says
// `exposure.ar.frames: 0` with a `probe.outcome` explaining why — which is
// the whole point of reporting the outcome rather than only the numbers.
//
// ── Threading ────────────────────────────────────────────────────────────
//
//   * DISCOVERY touches UIKit and therefore runs on the MAIN queue, always
//     dispatched ASYNC.  The AR thread never blocks on it — it schedules a
//     retry and returns nil for that frame.  A synchronous hop would put a
//     main-thread stall inside ARKit's delegate callback, which stalls
//     tracking for every sibling plugin.
//   * SAMPLING runs on the ARKit delegate thread, once per frame, from
//     inside `RNISPanoPlusPlugin.process(_:)` — i.e. from inside ARKit's own
//     `session(_:didUpdate:)`, which is where `currentFrame` is the frame
//     being delivered.  The returned `ARFrame` is released before the call
//     returns (an explicit `autoreleasepool`), because ARKit stops
//     delivering frames to an app that retains them.
//   * `state` is an NSLock held for FIELD ACCESS ONLY — never across the
//     `currentFrame` read, and never across a dispatch.

#if canImport(ARKit) && canImport(UIKit)

import ARKit
import Foundation
import QuartzCore
import SceneKit
import UIKit

@objc(RNISArExposureProbe)
public final class RNISArExposureProbe: NSObject {

    @objc public static let shared = RNISArExposureProbe()

    /// Guards every field below.  FIELD ACCESS ONLY — see the header.
    private let state = NSLock()

    /// The session we found, held WEAKLY.  `RNSARSession.shared` owns it for
    /// the life of the process; a weak reference here means a probe that
    /// outlives a teardown can never keep an ARSession alive.
    private weak var session: ARSession?

    /// Why the last discovery ended the way it did.  This is the field that
    /// turns an empty result into evidence: "0 frames" alone cannot
    /// distinguish a build that cannot reach ARKit's camera from a sweep that
    /// ingested nothing.
    private var outcome: String = "not-attempted"
    private var discoveryAttempts: Int = 0
    private var discoveryInFlight = false
    private var lastAttemptAtUptime: CFTimeInterval = 0

    /// Sampling counters, all reported.
    private var samples: Int = 0
    private var nilFrames: Int = 0          // session found, currentFrame nil
    private var nonFiniteSamples: Int = 0   // frame found, values unusable
    private var frameMatched: Int = 0       // ARFrame ts == the plugin's ts
    private var frameMismatched: Int = 0
    private var maxFrameDeltaMs: Double = 0

    /// Minimum gap between two discovery attempts.  The view mounts once and
    /// the walk is cheap, but an un-rate-limited retry would schedule a main-
    /// queue block on EVERY ARFrame of a sweep that never finds one.
    private static let retryGapSec: CFTimeInterval = 0.5

    private override init() { super.init() }

    // MARK: - Lifecycle

    /// Reset the counters and kick off discovery.  Called from
    /// `PanoPlusBridge.start` on its own work queue, BEFORE the frame plugin
    /// registers — so the common case is that the session is already cached
    /// by the time the first frame arrives.
    @objc public func attach() {
        state.lock()
        session = nil
        outcome = "searching"
        discoveryAttempts = 0
        discoveryInFlight = false
        lastAttemptAtUptime = 0
        samples = 0
        nilFrames = 0
        nonFiniteSamples = 0
        frameMatched = 0
        frameMismatched = 0
        maxFrameDeltaMs = 0
        state.unlock()
        scheduleDiscovery()
    }

    /// Drop the session reference.  The counters are DELIBERATELY left
    /// intact.  `PanoPlusBridge.teardownPlugin` calls `report()` immediately
    /// BEFORE this, so the order alone would be enough — but teardown runs on
    /// several exit paths (stop, cancel, RN invalidate) and a detach that
    /// zeroed the counters would make ONE future re-ordering silently erase
    /// the evidence the sweep just produced.  Nothing here needs zeroing:
    /// `attach()` resets everything at the start of the next sweep.
    @objc public func detach() {
        state.lock()
        session = nil
        state.unlock()
    }

    // MARK: - Per-frame read-out (AR thread)

    /// ARKit's own exposure for the frame being delivered, as
    /// `[durationSeconds, offsetEV]`, or nil.
    ///
    /// `frameTimestampNs` is the plugin's own `RNISARFrameContext.timestampNs`
    /// (which the public SDK builds as `frame.timestamp * 1e9`).  It is not
    /// used to select anything — it is compared against the `ARFrame` we read,
    /// and the agreement is counted.  Without that check "we read ARKit's
    /// exposure" would mean "we read SOME frame's exposure", and a one-frame
    /// skew would be invisible.
    ///
    /// Returns nil rather than a placeholder on every failure path, and the
    /// caller records the absence as absence.  A zero exposure is not a legal
    /// substitute for an unread one.
    @objc public func sample(frameTimestampNs: Double) -> [NSNumber]? {
        state.lock()
        let s = session
        state.unlock()

        guard let s = s else {
            scheduleDiscovery()   // rate-limited internally; never blocks
            return nil
        }

        // The ARFrame is released before this returns.  ARKit stops
        // delivering frames to an app that holds them, so nothing here may
        // outlive the pool.
        var durationS = 0.0
        var offsetEV = 0.0
        var frameTs = 0.0
        var haveFrame = false
        autoreleasepool {
            guard let f = s.currentFrame else { return }
            haveFrame = true
            durationS = f.camera.exposureDuration
            offsetEV = Double(f.camera.exposureOffset)
            frameTs = f.timestamp
        }

        state.lock()
        defer { state.unlock() }

        guard haveFrame else {
            nilFrames += 1
            return nil
        }
        // FRAME CORRESPONDENCE, measured rather than assumed.  Inside
        // `session(_:didUpdate:)` `currentFrame` IS the delivered frame, so
        // the expected delta is exactly 0 — but "expected" is what this
        // whole file exists to stop relying on.
        if frameTimestampNs > 0 {
            let deltaMs = abs(frameTs * 1000.0 - frameTimestampNs * 1e-6)
            if deltaMs > maxFrameDeltaMs { maxFrameDeltaMs = deltaMs }
            // 1 ns, not 0. The SDK builds `timestampNs` as `frame.timestamp *
            // 1e9` and this undoes it as `* 1e-6`, so the SAME frame comes
            // back through a double round-trip: at a boot-relative timestamp
            // of ~8e4 s that is ~1e-8 ms of representation error, and an exact
            // comparison would report a mismatch on every frame. A frame
            // interval is 16.7 ms, so this is four orders of magnitude below
            // the smallest real disagreement, and `maxFrameDeltaMs` carries
            // the truth either way.
            if deltaMs < 1e-6 { frameMatched += 1 } else { frameMismatched += 1 }
        }
        guard durationS.isFinite, durationS > 0, offsetEV.isFinite else {
            nonFiniteSamples += 1
            return nil
        }
        samples += 1
        return [NSNumber(value: durationS), NSNumber(value: offsetEV)]
    }

    // MARK: - The report

    /// Everything the probe knows about ITSELF, for `meta.json →
    /// exposure.ar.probe`.  One shape on every path, so a pack reader never
    /// has to branch on which fields exist.
    @objc public func report() -> [String: Any] {
        state.lock()
        defer { state.unlock() }
        return [
            // "found" / "no-arscnview" / "no-window" / "searching" /
            // "not-attempted".  The field that makes an empty result
            // interpretable.
            "outcome": outcome,
            "attempts": discoveryAttempts,
            "sessionResolved": session != nil,
            "samples": samples,
            "currentFrameNil": nilFrames,
            "unusableValues": nonFiniteSamples,
            // Frames where the ARFrame we read was EXACTLY the frame the
            // plugin was handed.  matched == samples is the clean case.
            "frameMatched": frameMatched,
            "frameMismatched": frameMismatched,
            "maxFrameDeltaMs": maxFrameDeltaMs,
            // How the session was reached, spelled out, because the route is
            // a public-API walk rather than an API the SDK offers.
            "route": "arscnview-in-window-hierarchy",
        ]
    }

    // MARK: - Discovery (main queue)

    /// Schedule a main-queue view-hierarchy walk, rate-limited, never
    /// blocking the caller.  Safe to call from the AR thread on every frame.
    private func scheduleDiscovery() {
        let now = CACurrentMediaTime()
        state.lock()
        if session != nil || discoveryInFlight ||
            (lastAttemptAtUptime > 0 &&
             now - lastAttemptAtUptime < Self.retryGapSec) {
            state.unlock()
            return
        }
        discoveryInFlight = true
        lastAttemptAtUptime = now
        discoveryAttempts += 1
        state.unlock()

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let (found, why) = Self.findSessionOnMain()
            self.state.lock()
            self.discoveryInFlight = false
            if let found = found {
                self.session = found
                self.outcome = "found"
            } else {
                self.outcome = why
            }
            self.state.unlock()
        }
    }

    /// MAIN QUEUE ONLY.  Walk every window of every foreground scene looking
    /// for an `ARSCNView`, and return its session.
    ///
    /// `RNSARCameraView` keeps its `ARSCNView` private, but adds it as a
    /// subview and binds it to `RNSARSession.shared.arSession` — so the
    /// session is reachable without touching anything the public package
    /// declares private, and without this pod importing its internals.
    private static func findSessionOnMain() -> (ARSession?, String) {
        var sawWindow = false
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            for window in ws.windows {
                sawWindow = true
                if let v = firstARSCNView(in: window) { return (v.session, "found") }
            }
        }
        return (nil, sawWindow ? "no-arscnview" : "no-window")
    }

    /// Depth-first search for the first `ARSCNView` under `view`.  Bounded by
    /// the real hierarchy (an RN screen is tens of views deep at worst) and
    /// runs at most twice per second while a sweep has no session.
    private static func firstARSCNView(in view: UIView) -> ARSCNView? {
        if let v = view as? ARSCNView { return v }
        for sub in view.subviews {
            if let found = firstARSCNView(in: sub) { return found }
        }
        return nil
    }
}

#endif
