// SPDX-License-Identifier: Apache-2.0
//
// IncrementalStitcher — Swift-side engine for the live
// panorama-stitching pipeline introduced in
// docs/site-content/design/2026-04-30-realtime-incremental-stitching.md.
//
// What this file does:
//   - Owns a single `OpenCVIncrementalStitcher` instance
//   - Subscribes to `RNSARSession`'s per-frame ARFrame delivery
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
//   the delegate callback (see the comment on RNSARSession's
//   recording-append path).  We therefore consume the buffer
//   inside the delegate (the .mm copies pixels into a cv::Mat — the
//   Mat owns its own heap memory) before returning, even when the
//   actual heavy work is dispatched to the serial queue.

import Foundation
import ARKit
import simd
import UIKit
import os.log

/// Public outcome enum mirroring the ObjC `RLISFrameOutcome` so JS
/// callers can inspect what happened to each frame without crossing
/// the ObjC++ boundary themselves.
///
/// Values 7+ are emitted from the Swift gate layer (KeyframeGate),
/// not from the native engine.  Keep numeric values in lockstep with
/// `IncrementalOutcome` in incremental.ts.
@objc public enum IncrementalOutcome: Int {
    case acceptedHigh = 0
    case acceptedMedium = 1
    case skippedTooClose = 2
    case rejectedTooFar = 3
    case rejectedSceneUniform = 4
    case rejectedAlignmentLost = 5
    case skippedTrackingPoor = 6
    /// V12.11 — engine refused a frame because pan reversed past the
    /// running max along the pan axis.  Mirrors the JS-side enum value
    /// that's been there since V12.11.  Was missing on the Swift side
    /// previously; the bridge fell back to `.skippedTrackingPoor` for
    /// any rawValue >= 7.
    case rejectedReverseDirection = 7
    /// V16 — KeyframeGate rejected the frame: not enough new content
    /// vs the last accepted keyframe (overlap > 1 - overlapThreshold).
    case skippedKeyframeOverlap = 8
    /// V16 — KeyframeGate rejected the frame: hit `keyframeMaxCount`
    /// for the capture.  Host should auto-finalize.
    case skippedKeyframeMaxReached = 9
}

/// State snapshot the bridge re-emits to JS on every accepted frame
/// (and on rejects when there's a hint to surface).
@objc(IncrementalStateObject)
public final class IncrementalStateObject: NSObject {
    @objc public let panoramaPath: String?
    @objc public let width: Int
    @objc public let height: Int
    @objc public let acceptedCount: Int
    @objc public let outcome: IncrementalOutcome
    @objc public let confidence: Double
    @objc public let overlapPercent: Double
    @objc public let processingMs: Double
    /// V12.12 — engine-detected physical orientation, plumbed up
    /// from `RLISFrameTelemetry.isLandscape`.  See incremental.ts
    /// for the full rationale (single source of truth across SDK
    /// + host).
    @objc public let isLandscape: Bool
    /// V12.14.9 — running painted extent along the pan axis, in
    /// canvas pixels.  Combined with `panExtent`, lets the JS band
    /// overlay size the thumbnail proportionally on every state
    /// event (not just snapshot frames).
    @objc public let paintedExtent: Int
    /// V12.14.9 — total canvas pan-axis extent (engine config).
    /// Constant for the lifetime of a capture.  fillRatio =
    /// `paintedExtent / panExtent`.
    @objc public let panExtent: Int
    /// V16 — KeyframeGate's max-keyframes cap for this capture.  0
    /// when the gate is disabled (frameSelectionMode = "time-based"),
    /// in which case `acceptedCount` should be displayed as a raw
    /// counter rather than a "n / max" pill.  When > 0, the JS
    /// status pill renders "Keyframes: acceptedCount / keyframeMax".
    @objc public let keyframeMax: Int

    @objc public init(
        panoramaPath: String?,
        width: Int,
        height: Int,
        acceptedCount: Int,
        outcome: IncrementalOutcome,
        confidence: Double,
        overlapPercent: Double,
        processingMs: Double,
        isLandscape: Bool,
        paintedExtent: Int,
        panExtent: Int,
        keyframeMax: Int = 0
    ) {
        self.panoramaPath = panoramaPath
        self.width = width
        self.height = height
        self.acceptedCount = acceptedCount
        self.outcome = outcome
        self.confidence = confidence
        self.overlapPercent = overlapPercent
        self.processingMs = processingMs
        self.isLandscape = isLandscape
        self.paintedExtent = paintedExtent
        self.panExtent = panExtent
        self.keyframeMax = keyframeMax
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
            "isLandscape": isLandscape,
            "paintedExtent": paintedExtent,
            "panExtent": panExtent,
            "keyframeMax": keyframeMax,
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
        Notification.Name("IncrementalStateUpdate")
}


// MARK: - FinalizePayload (C2 — stateless finalize, fix-attempt 8)
//
// Value-typed snapshot of every input the finalize closures need.
// Built in `finalize()`'s prologue under `stateLock` and passed BY
// VALUE into the workQueue closure so the closure can capture
// `[payload, completion]` ONLY — zero `self` references — closing
// the entire class of `objc_retain`-on-torn-pointer crashes that
// fix-attempts 1-7 chased symptom-by-symptom on the same code path.
//
// Per design doc 2026-05-12-finalize-crash-investigation.md (C2
// escalation): all prior fixes attacked specific symptoms (which
// ivar's read raced, which lock's discipline was lax).  This is the
// architectural escalation: by construction the closure has no
// access to mutable stitcher state, so no race in this code path is
// even possible.
//
// File-scope `internal` (not private) so future ports (Design 2
// actor, Design 3 C++) can adopt the same payload as their input.
//
// MAINTENANCE INVARIANT: every ivar finalize closures currently
// read (or might read in future edits) MUST live here.  If you add
// a new finalize-relevant ivar to IncrementalStitcher,
// thread it through this struct.  The CI test at
// scripts/check_c2_invariant.sh prevents accidental `self.*`
// reintroduction inside the closure body.
struct FinalizePayload {
    // ── Output destination + quality ─────────────────────────────
    /// The caller-supplied panorama output path, normalized
    /// (file:// stripped if present).
    let cleaned: String
    /// JPEG quality, clamped to 1...100.
    let q: Int

    // ── Stitcher mode selection ─────────────────────────────────
    /// True if this finalize is the V16 batch-keyframe pipeline.
    let inBatchKeyframeMode: Bool
    /// Hybrid engine ref (V14/V15 path).  nil if batch mode.
    let hybrid: OpenCVIncrementalStitcher?
    /// First-wins cylindrical engine ref (V13 path).  nil if batch mode.
    let slit: OpenCVFirstWinsCylindricalStitcher?
    /// V16 keyframe collector — owns the per-session JPEG sidecar
    /// directory the post-stitch result references.
    let collector: OpenCVKeyframeCollector?

    // ── Frame inputs ─────────────────────────────────────────────
    /// Absolute paths to keyframe JPEGs.  Value-copied; the
    /// underlying String storage is COW and immutable.
    let paths: [String]

    // ── cv::Stitcher tuning snapshots (fix4 lineage) ─────────────
    let batchWarperType: String
    let batchBlenderType: String
    let batchSeamFinderType: String
    let batchEnableInscribedRectCrop: Bool
    let keyframeExifOrientation: Int
    /// AR-STITCHING-TWO-MODES (memory/ar-stitching-two-modes.md):
    /// capture-time hold orientation for the bake-rotation pass.
    let captureOrientation: String

    // ── Result metadata ──────────────────────────────────────────
    /// Backpressure drops accumulated this capture, surfaced to JS.
    let drops: Int
    /// Whether the AR session was running at finalize-entry — drives
    /// the AR restart in the closure's defer.
    let arWasRunning: Bool
}


@objc(IncrementalStitcher)
public final class IncrementalStitcher: NSObject {

    /// V13.0c.1.1 — same os_log subsystem as the slit-scan engine's
    /// SlitDiagLog so Console.app sees both V13.0b-gate and V13.0c-trans
    /// under one filter.  FAULT-level survives NSLog's burst rate-limit
    /// (~10/sec) — diagnostic logs at 50fps would otherwise be dropped.
    fileprivate static let diagLog = OSLog(
        subsystem: "com.tiger.retailens.sdk",
        category: "slitscan"
    )


    @objc public static let shared = IncrementalStitcher()

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

    /// V15.0b — true once we've forwarded the latched plane transform
    /// from RNSARSession to the slit-scan engine.  Reset on
    /// every start() so the next capture re-propagates.  We only
    /// forward once per capture: the plane transform is latched
    /// (RNSARSession ignores subsequent ARKit refinements),
    /// so re-propagating each frame is wasted work.
    private var havePropagatedPlane: Bool = false

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
    ///
    /// 2026-05-15 (C3 deferral) — investigated splitting the batch-
    /// keyframe stitch onto its own DispatchQueue so a slow stitch
    /// doesn't block ARSession frame ingestion on this workQueue.
    /// Backed out: the existing `workQueue.sync` finalize boundary
    /// (V16 Phase 1b.fix6) is INTENTIONAL — it serialises finalize
    /// against in-flight frame work to prevent state-event races.
    /// Moving the stitch to a separate queue requires reworking the
    /// completion handler + stateLock contract to provide the same
    /// ordering guarantees the sync barrier currently gives.  Real
    /// fix is non-trivial; deferred until pose-driven stitch work
    /// lands (which will rework the queue topology anyway).
    private let workQueue = DispatchQueue(
        label: "com.retailens.incremental.stitcher",
        qos: .userInitiated
    )

    /// 2026-05-16 — realtime+batch fusion (Option A "Replace on
    /// completion").  Dedicated queue for the async refinement run
    /// that follows a hybrid-engine finalize().  Kept SEPARATE from
    /// `workQueue` so the next capture's start/consumeFrame path
    /// isn't gated on the prior capture's 2-5 s cv::Stitcher run —
    /// the design doc explicitly calls out "operator can continue
    /// browsing / starting another capture during refinement".
    ///
    /// Serial: at most one refinement runs at a time (the design's
    /// "cancellation semantics if a new capture starts mid-refine"
    /// is out of scope for this MVP — see prompt's "deliberately out
    /// of scope" list).
    private let refineQueue = DispatchQueue(
        label: "com.retailens.incremental.refine",
        qos: .utility
    )

    /// Lock guarding `engine`/`isRunning` reads/writes.  ARSession
    /// delegate uses `try` to avoid blocking ARKit; if start/stop is
    /// mid-flight the frame is dropped.
    private let stateLock = NSLock()

    /// Whether the engine is currently active.  Set by start/stop.
    @objc public private(set) var isRunning: Bool = false

    /// The most recent state snapshot — readable by JS via the
    /// bridge's `getState`.
    private var lastState: IncrementalStateObject?

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

    /// V13.0c.1 — diagnostic state: first-frame world translation.
    /// Used to compute Δtranslation per frame for the
    /// [V13.0c-trans] log.  We need to know how much users actually
    /// translate during typical captures before committing to the
    /// per-pixel depth correction architecture (V13.0c.2-.4).
    /// Reset on each new capture (handled in `start()` below).
    private var firstFrameTx: Double = 0
    private var firstFrameTy: Double = 0
    private var firstFrameTz: Double = 0
    private var hasFirstFrameTranslation: Bool = false
    private var consumeFrameCounter: Int = 0

    /// V16 — pose-driven keyframe gate.  When `enabled` (set from the
    /// JS `frameSelectionMode = "pose-based"` config), each ARFrame is
    /// projected onto the latched ARKit plane and accepted only when
    /// it has ≥ `overlapThreshold` of NEW content vs the last
    /// accepted keyframe.  Bounded to `maxCount` keyframes per
    /// capture.  See KeyframeGate.swift for the full rationale.
    private let keyframeGate = KeyframeGate()

    /// V16 Phase 1 — when `engineMode == "batch-keyframe"`, no
    /// incremental engine runs; we accumulate the gate-accepted
    /// frames as on-disk JPEGs + their poses, then on `finalize` hand
    /// them to `OpenCVStitcher.stitchKeyframePaths:withPoses:` (the
    /// full BA + ExposureCompensator + GraphCutSeamFinder +
    /// MultiBandBlender pipeline) for one-shot stitching.  Why this
    /// is structurally different from the slit-scan / hybrid engines:
    /// they ingest into a streaming canvas, whereas batch-keyframe
    /// defers all stitching until shutter release so the global-
    /// stage quality wins (BA, multi-band) become available.
    private var batchKeyframeMode: Bool = false
    private var keyframeCollector: OpenCVKeyframeCollector?
    /// Poses recorded 1:1 with `keyframeCollector`'s saved JPEGs.
    /// Each entry is `RNSARFramePose.asDictionary()`.  Reset
    /// on every `start()`.
    private var keyframePoses: [[String: Any]] = []
    /// Saved JPEG paths in capture order.  Tracked separately from
    /// the collector so finalize doesn't have to reach back into ObjC.
    private var keyframePaths: [String] = []
    /// Frame rotation degrees passed at `start()` — needed when
    /// saving keyframes so the JPEGs land in user-pan orientation
    /// (the stitcher reads them in that orientation).
    private var keyframeRotationDegrees: Int = 90
    /// V16 Phase 1.fix2 — EXIF Orientation tag (1..8) baked into
    /// each saved keyframe JPEG so iOS image renderers display
    /// correctly while the stitcher (with IMREAD_IGNORE_ORIENTATION)
    /// gets raw landscape pixels matching the pose's intrinsics.
    private var keyframeExifOrientation: Int = 1
    /// V16 Phase 1.fix4 — cv::Stitcher knobs.  Defaults match the
    /// modal's defaults and the legacy batch path defaults
    /// (PlaneWarper + MultiBandBlender + GraphCutSeamFinder) since
    /// fix4 routes through cv::Stitcher's feature-matched pipeline
    /// where these defaults are the production-tested combo.  User
    /// can override via the modal Projection / Blender / Seam-finder
    /// sections — those values flow through configOverrides at
    /// start().
    private var batchWarperType: String = "plane"
    private var batchBlenderType: String = "multiband"
    private var batchSeamFinderType: String = "graphcut"
    // V16 Phase 1b.fix5c — operator-visible toggle for the
    // max-inscribed-rectangle crop in the batch-keyframe finalize.
    // Default OFF.  When OFF, native crops to bbox only; when ON,
    // the inscribed-rect + morph-close + col-projection pipeline
    // runs.
    private var batchEnableInscribedRectCrop: Bool = false
    /// AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
    ///
    /// Physical phone orientation at start() time, sourced from the
    /// JS accelerometer hook.  Used to drive the OUTPUT panorama's
    /// bake-rotation in OpenCVStitcher.stitchFramePaths.  Held for
    /// the lifetime of the capture so finalize() doesn't need to
    /// re-sample (the user may have rotated the phone mid-pan and
    /// we want the rotation that was correct WHEN they started).
    ///
    /// Valid values mirror IncrementalStartOptions.captureOrientation
    /// in the JS API: "portrait", "portrait-upside-down",
    /// "landscape-left", "landscape-right".  Any other string is
    /// treated as "portrait" (no rotation) by the .mm side.
    private var captureOrientation: String = "portrait"

    private override init() {
        super.init()
    }

    /// 2026-05-18 (iOS cross-orientation fix) — bridge entry-point
    /// that the bridge calls in finalize() when JS supplies a fresh
    /// orientation.  Overrides whatever start() snapshotted
    /// (native ARKit query OR JS fallback).  Used to close the bug
    /// where the user opens the screen in orientation A, captures
    /// in orientation B, and the bake_rotation table runs against
    /// orientation A (the start-time value).
    ///
    /// Caller responsibility: this should only be called BEFORE
    /// finalize() begins the stitch.  Calling concurrently with an
    /// in-flight stitch is a race on `self.captureOrientation`
    /// (which the stitcher reads through the payload snapshot at
    /// finalize() prologue).  The bridge enforces "update then
    /// finalize" sequentially on the workQueue.
    @objc public func updateCaptureOrientation(_ orientation: String) {
        stateLock.lock()
        let prev = self.captureOrientation
        self.captureOrientation = orientation
        stateLock.unlock()
        os_log(.fault, log: Self.diagLog,
               "[V16-orchestrator] updateCaptureOrientation: %{public}@ → %{public}@",
               prev, orientation)
    }

    /// 2026-05-18 (Iss 3) — return the current capture's keyframe
    /// session directory, or nil if no capture is in flight / engine
    /// isn't using a per-session keyframe collector.
    @objc public func currentKeyframeDir() -> String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard self.isRunning, self.batchKeyframeMode else { return nil }
        return self.keyframeCollector?.sessionDir
    }

    /// 2026-05-18 (Iss 3) — GC stale keyframe-session directories.
    ///
    /// Scans `Library/Application Support/Captures/` for subdirectories
    /// whose newest file mtime is older than `cutoffMs` (ms past epoch).
    /// Each stale subdirectory is removed in full (it's a session UUID
    /// dir with N keyframe JPEGs).  Sessions whose newest file is newer
    /// than the cutoff are LEFT ALONE — even if they look stale by some
    /// other heuristic — because they might belong to a capture that's
    /// still in flight (the engine writes incremental frames to the
    /// same dir).
    ///
    /// Returns a tuple of (sessionsDeleted, bytesFreed) so the bridge
    /// can surface those numbers to JS for an optional UX toast.  All
    /// filesystem errors are swallowed and counted as "not deleted";
    /// host should NEVER see a thrown error from this — at worst it
    /// gets back zero counts and can investigate Console.app logs.
    @objc public func cleanupKeyframes(
        olderThanMs: Double
    ) -> [String: NSNumber] {
        let cutoff = Date().timeIntervalSince1970 - (olderThanMs / 1000.0)
        let fm = FileManager.default
        guard let appSupport = try? fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: false  // don't create if missing — that means nothing to clean
        ) else {
            return ["sessionsDeleted": 0, "bytesFreed": 0]
        }
        let capturesURL = appSupport.appendingPathComponent("Captures", isDirectory: true)
        guard fm.fileExists(atPath: capturesURL.path) else {
            return ["sessionsDeleted": 0, "bytesFreed": 0]
        }
        guard let sessions = try? fm.contentsOfDirectory(
            at: capturesURL,
            includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else {
            return ["sessionsDeleted": 0, "bytesFreed": 0]
        }

        var sessionsDeleted = 0
        var bytesFreed: UInt64 = 0
        for sessionURL in sessions {
            // Only dirs are real sessions; skip stray files.
            let isDir = (try? sessionURL.resourceValues(
                forKeys: [.isDirectoryKey]
            ))?.isDirectory ?? false
            if !isDir { continue }
            // Newest mtime across the session's files (recursive — though
            // the collector writes a flat dir today, future-proof).
            var newestMtime: TimeInterval = 0
            var sessionBytes: UInt64 = 0
            if let enumerator = fm.enumerator(
                at: sessionURL,
                includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
                options: [.skipsHiddenFiles]
            ) {
                for case let fileURL as URL in enumerator {
                    let r = try? fileURL.resourceValues(
                        forKeys: [.contentModificationDateKey, .fileSizeKey]
                    )
                    if let mtime = r?.contentModificationDate?.timeIntervalSince1970 {
                        if mtime > newestMtime { newestMtime = mtime }
                    }
                    if let bytes = r?.fileSize {
                        sessionBytes += UInt64(bytes)
                    }
                }
            }
            // Use the directory's own mtime as a fallback if no files
            // matched (an empty session dir is also stale).
            if newestMtime == 0 {
                if let dirMtime = (try? sessionURL.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ))?.contentModificationDate?.timeIntervalSince1970 {
                    newestMtime = dirMtime
                }
            }
            if newestMtime > 0 && newestMtime < cutoff {
                if (try? fm.removeItem(at: sessionURL)) != nil {
                    sessionsDeleted += 1
                    bytesFreed += sessionBytes
                }
            }
        }
        os_log(.fault, log: Self.diagLog,
               "[V16-orchestrator] cleanupKeyframes olderThanMs=%.0f sessions=%d bytes=%llu",
               olderThanMs, Int32(sessionsDeleted), bytesFreed)
        return [
            "sessionsDeleted": NSNumber(value: sessionsDeleted),
            "bytesFreed": NSNumber(value: bytesFreed),
        ]
    }

    /// 2026-05-16 — realtime+batch fusion (Option A) path derivation.
    /// Given the live panorama path (which finalize() wrote inside
    /// the app sandbox tmp or a host-supplied location), pick a path
    /// for the refined output.  Pattern:
    ///
    ///   /…/RNImageStitcherIncremental-<uuid>.jpg
    ///       → /…/RNImageStitcherIncremental-<uuid>-refined.jpg
    ///
    /// Same directory keeps cleanup discoverable (delete both when
    /// the audit is discarded).  Different name avoids racing the
    /// host UI that may still be reading the live file as the
    /// refinement is writing.
    fileprivate static func refinedPathFromLive(livePath: String) -> String {
        let ns = livePath as NSString
        let dir = ns.deletingLastPathComponent
        let base = (ns.lastPathComponent as NSString).deletingPathExtension
        let ext = (ns.lastPathComponent as NSString).pathExtension
        let refinedName = ext.isEmpty
            ? "\(base)-refined"
            : "\(base)-refined.\(ext)"
        return (dir as NSString).appendingPathComponent(refinedName)
    }

    // ── Native orientation classifier ────────────────────────────────
    //
    // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
    //
    // Why this exists: JS's useDeviceOrientation hook ships React
    // state that's stale at the moment incremental.start() is invoked
    // (the hook samples accelerometer at 10 Hz and renders through
    // React's normal update cycle — by the time the start() callback
    // runs, the closure has captured the previous-state value).
    // Field test on 2026-05-11 confirmed: 3/3 captures (Mode B,
    // Mode A landscape-left, Mode A landscape-right) all arrived at
    // the bridge with captureOrientation="portrait" even though the
    // user explicitly rotated to landscape for two of them.
    //
    // ARKit gives us the answer directly: `frame.camera.eulerAngles.z`
    // is the camera's roll (rotation around its optical axis) — the
    // exact value that distinguishes portrait / landscape-left /
    // landscape-right / portrait-upside-down regardless of any UI
    // lock or JS state staleness.  Read it synchronously at start()
    // time and use it as the source of truth.
    //
    // Convention (verified against ARKit docs + iOS device axes):
    //   • Camera local axes: +X right, +Y up (along phone length
    //     when held portrait), +Z back (toward user's face).
    //   • Roll = rotation around camera's +Z (right-hand rule).
    //   • Portrait                  → roll ≈ 0
    //   • Landscape-left (CCW)      → roll ≈ +π/2 (verified empirically;
    //                                 swap with -right if first test
    //                                 shows landscape-right hitting
    //                                 this branch instead)
    //   • Portrait-upside-down      → roll ≈ ±π
    //   • Landscape-right (CW)      → roll ≈ -π/2
    //
    // ±45° tolerance per quadrant keeps classification stable under
    // small hand wobble.
    private static func nativeCaptureOrientation() -> (
        orientation: String,
        rollDegrees: Double,
        hadFrame: Bool
    ) {
        guard let frame = RNSARSession.shared.arSession.currentFrame else {
            // No AR frame yet — falls back to "portrait" (Mode B start
            // state).  Should be rare: incremental.start() requires
            // ARSession to be running, which means frames are flowing.
            return ("portrait", 0.0, false)
        }
        let rollRadians = Double(frame.camera.eulerAngles.z)
        let rollDegrees = rollRadians * 180.0 / .pi
        let classified: String
        // Empirically calibrated against Ram's 2026-05-11 3-capture
        // test (1st=L-left, 2nd=portrait, 3rd=L-right):
        //   Ram's "landscape-left"  →  roll ≈ 0°    (NOT -90° as I assumed)
        //   Ram's "portrait"        →  roll ≈ -90°
        //   Ram's "landscape-right" →  roll ≈ ±180°
        //   Ram's "portrait-upside-down" →  roll ≈ +90° (by symmetry, untested)
        //
        // Why this differs from the device-orientation intuition:
        // ARKit's `camera.eulerAngles.z` is the camera's roll around
        // its optical axis, measured against world-up.  The iPhone's
        // image sensor is mounted such that its long axis aligns
        // with the phone's WIDTH (not length), so the camera's +Y
        // is naturally aligned with world-UP when the phone is in
        // landscape — roll = 0 means the phone is landscape.
        // Holding the phone in portrait rotates the camera +Y to
        // horizontal in world → roll = ±90°.
        //
        // The rotation table in OpenCVStitcher.mm (landscape-left →
        // 90° CCW, portrait → none, etc.) is unchanged — only the
        // classifier mapping is shifted by 90°.
        if abs(rollDegrees) < 45 {
            classified = "landscape-left"
        } else if rollDegrees >= 45 && rollDegrees < 135 {
            classified = "portrait-upside-down"
        } else if rollDegrees <= -45 && rollDegrees > -135 {
            classified = "portrait"
        } else {
            classified = "landscape-right"
        }
        return (classified, rollDegrees, true)
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
        engineMode: String,
        captureOrientation: String = "portrait",
        configOverrides: [String: Any] = [:],
        // 2026-05-18 (Issue #2 regression fix): "arSession" (default,
        // legacy) registers as the ARSession's frame consumer.
        // "jsDriver" skips that registration — frames will come in
        // via processFrameAtPath instead.  Used by iOS non-AR
        // captures (the vision-camera + gyro driver path).
        frameSourceMode: String = "arSession"
    ) {
        stateLock.lock()
        if isRunning {
            stateLock.unlock()
            return
        }
        // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
        // Override the JS-supplied captureOrientation with a native
        // ARKit reading.  Field test on 2026-05-11 confirmed JS state
        // is consistently stale at start() time (always "portrait"
        // regardless of physical orientation); native AR frame data
        // is real-time and unambiguous.  See nativeCaptureOrientation
        // for the full RCA.  JS-supplied value retained in the log
        // for diagnostic purposes.
        let nativeResult = Self.nativeCaptureOrientation()
        let resolvedOrientation = nativeResult.hadFrame
            ? nativeResult.orientation
            : captureOrientation   // no AR frame yet — fall back to JS
        self.captureOrientation = resolvedOrientation
        os_log(.fault, log: Self.diagLog,
               "[V16-orchestrator] start: JS sent=%{public}@ native roll=%.1f° → resolved=%{public}@ (native_used=%d) engineMode=%{public}@",
               captureOrientation,
               nativeResult.rollDegrees,
               resolvedOrientation,
               nativeResult.hadFrame ? Int32(1) : Int32(0),
               engineMode)
        // V15 — engine modes:
        //   'hybrid'           → hybrid engine, planar projection by default
        //   'slitscan-rotate'  → slit-scan, rectilinear, V13.0a + 1D NCC
        //   'slitscan-both'    → slit-scan, rectilinear, V13.0a + no gate
        //                        + feather blend (iterate via overrides)
        // Backward compat in -[RLISStitcherConfig configForMode:] handles
        // 'firstwins-rectilinear' → 'slitscan-rotate' and warns on
        // legacy 'firstwins' / 'firstwins-zoomed' / 'slitscan' modes.
        let normalisedMode: String
        switch engineMode {
        case "hybrid": normalisedMode = "hybrid"
        case "batch-keyframe":
            // V16 Phase 1 — new mode.  Skips the live incremental
            // engines entirely; KeyframeGate accumulates accepted
            // frames as JPEGs, on finalize OpenCVStitcher does the
            // full-pipeline stitch.
            normalisedMode = "batch-keyframe"
        case "slitscan-rotate", "firstwins-rectilinear":
            normalisedMode = "slitscan-rotate"
        case "slitscan-both":
            normalisedMode = "slitscan-both"
        case "firstwins", "firstwins-zoomed", "slitscan":
            NSLog("[V15-bridge] DEPRECATED engine '\(engineMode)' — using slitscan-both")
            normalisedMode = "slitscan-both"
        default:
            NSLog("[V15-bridge] unknown engine '\(engineMode)' — using slitscan-both")
            normalisedMode = "slitscan-both"
        }

        let useBatchKeyframe = (normalisedMode == "batch-keyframe")
        let useFirstwinsClass = normalisedMode.hasPrefix("slitscan")

        // Build the V15 config: factory default for the mode, then apply
        // JS-side overrides.
        let config = RLISStitcherConfig(forMode: normalisedMode)
        Self.applyConfigOverrides(configOverrides, to: config)

        if useBatchKeyframe {
            // V16 Phase 1 — no live engine; spin up a keyframe
            // collector that saves accepted frames to disk under
            // Library/AppSupport/Captures/{uuid}/.  On finalize
            // these are handed to OpenCVStitcher's full pipeline
            // (BA + GraphCut + ExposureComp + MultiBand) — the
            // actually-quality path.  Memory is bounded because
            // KeyframeGate caps input at `keyframeMaxCount` (≤6).
            do {
                self.keyframeCollector = try OpenCVKeyframeCollector()
            } catch {
                NSLog("[V16-batch-keyframe] collector init failed: \(error.localizedDescription)")
                self.keyframeCollector = nil
            }
            self.keyframePaths = []
            self.keyframePoses = []
            // V16 Phase 1.fix1 — keep frames in native landscape
            // sensor orientation for the batch-keyframe path so the
            // pose's intrinsics (which describe the unrotated
            // 1920×1440 sensor) match the saved-image dimensions.
            // The slit-scan and hybrid engines continue to receive
            // `frameRotationDegrees` unchanged.
            self.keyframeRotationDegrees = 0
            // 2026-05-18 (Issue #1a fix) — keyframe EXIF Orientation
            // is hardcoded to 6 ("rotate 90° CW for display") regardless
            // of physical capture orientation.
            //
            // RCA: the earlier V16 Phase 1.fix2 mapping branched on
            // `frameRotationDegrees` to "encode the user's perceived
            // orientation".  That was written for a hypothetical
            // app whose orientation locks WITH the user's hold.  Our
            // host app is PORTRAIT-LOCKED: the rendering surface
            // never rotates, regardless of how the operator holds
            // the phone.
            //
            // RN's <Image> + Files.app honour EXIF when rendering.
            // Sensor-native pixels are landscape-aspect (long axis =
            // phone-Y).  In a portrait-locked UI, displaying with
            // EXIF=1 leaves the JPEG in landscape pixels rendered
            // INTO portrait UI — the operator, head tilted to view
            // their landscape capture, then sees the band thumbnails
            // rotated 90° from their world view ("sideways").  Pre-
            // bug-fix, the broken useDeviceOrientation hook always
            // reported 'portrait' so `frameRotationDegrees=90` was
            // always selected and EXIF=6 was always written — the
            // operator never saw the misalignment because EXIF=6's
            // 90° CW display rotation cancelled their physical 90°
            // CCW head tilt in landscape-left view.  Fixing the hook
            // exposed the underlying portrait-lock mismatch.
            //
            // EXIF=6 (always) keeps the band thumbnails consistent
            // with the portrait-locked UI in every hold.  The FINAL
            // panorama bake is independent — it consumes
            // `config.captureOrientation` in cpp/stitcher.cpp's
            // bake_rotation pass and is unaffected by this constant.
            //
            // If we ever unlock the host app's orientation (so the
            // UI rotates with the user), this should revert to the
            // 4-way switch.  Tracked as a follow-up in the design
            // doc.
            self.keyframeExifOrientation = 6
            // V16 Phase 1.fix4 — read cv::Stitcher knobs from JS config.
            // Defaults to "plane" / "multiband" / "graphcut" — the
            // proven combo cv::Stitcher::PANORAMA uses internally.
            // Operator can A/B different warpers from the modal's
            // Projection / Blender / Seam-finder sections.
            self.batchWarperType =
                (configOverrides["warperType"] as? String) ?? "plane"
            self.batchBlenderType =
                (configOverrides["blenderType"] as? String) ?? "multiband"
            self.batchSeamFinderType =
                (configOverrides["seamFinderType"] as? String) ?? "graphcut"
            // V16 Phase 1b.fix5c — read inscribed-rect toggle.  Defaults
            // to FALSE if not provided by JS.
            self.batchEnableInscribedRectCrop =
                (configOverrides["enableMaxInscribedRectCrop"] as? Bool) ?? false
            self.batchKeyframeMode = true
            self.hybridEngine = nil
            self.firstwinsEngine = nil
            os_log(.fault, log: Self.diagLog,
                   "[V16-batch-keyframe] start mode=batch-keyframe rotation=0 (was %d, forced to 0 to match pose intrinsics) sessionDir=%{public}@",
                   frameRotationDegrees,
                   self.keyframeCollector?.sessionDir ?? "(nil)")
        } else if useFirstwinsClass {
            // Slit-scan engine always uses rectilinear in V15
            // (firstwins-cylindrical and firstwins-zoomed modes were
            // removed; their behaviour is unused).
            self.firstwinsEngine = OpenCVFirstWinsCylindricalStitcher(
                composeWidth: composeWidth,
                composeHeight: composeHeight,
                canvasWidth: canvasWidth,
                canvasHeight: canvasHeight,
                featherPx: featherPx,
                frameRotationDegrees: frameRotationDegrees,
                useRectilinear: true
            )
            self.firstwinsEngine?.setConfig(config)
            self.hybridEngine = nil
            self.batchKeyframeMode = false
        } else {
            self.hybridEngine = OpenCVIncrementalStitcher(
                composeWidth: composeWidth,
                composeHeight: composeHeight,
                canvasWidth: canvasWidth,
                canvasHeight: canvasHeight,
                featherPx: featherPx,
                frameRotationDegrees: frameRotationDegrees
            )
            self.hybridEngine?.setConfig(config)
            self.firstwinsEngine = nil
            self.batchKeyframeMode = false
        }
        self.isRunning = true
        self.snapshotJpegQuality = max(1, min(100, snapshotJpegQuality))
        self.snapshotEveryNAccepts = max(1, snapshotEveryNAccepts)
        self.acceptsSinceSnapshot = 0
        self.droppedBackpressure = 0
        self.lastState = nil
        // V15.0b — re-arm plane propagation for the new capture.
        self.havePropagatedPlane = false
        // V13.0c.1 — reset translation diagnostic state for the
        // new capture.  First-frame translation will be captured
        // on the next consumeFrame call.
        self.hasFirstFrameTranslation = false
        self.consumeFrameCounter = 0

        // V16 — configure the pose-driven keyframe gate from JS
        // config overrides.  Defaults match the field-tested values
        // for a 90° landscape pan over a retail shelf: 40% required
        // new content per keyframe, capped at 6 keyframes per
        // capture.  Values out of range are clamped silently.
        let frameMode = (configOverrides["frameSelectionMode"] as? String)
                        ?? "time-based"
        // V16 A2 — both 'pose-based' and 'flow-based' enable the gate;
        // they differ only in the novelty metric (plane-overlap vs
        // sparse-flow).  'time-based' = passthrough.
        self.keyframeGate.enabled =
            (frameMode == "pose-based" || frameMode == "flow-based")
        self.keyframeGate.strategy =
            (frameMode == "flow-based") ? .flow : .pose
        if let v = configOverrides["keyframeOverlapThreshold"] as? Double {
            self.keyframeGate.overlapThreshold = max(0.10, min(0.80, v))
        } else {
            self.keyframeGate.overlapThreshold = 0.4
        }
        if let v = configOverrides["keyframeMaxCount"] as? Int {
            self.keyframeGate.maxCount = max(3, min(10, v))
        } else {
            self.keyframeGate.maxCount = 6
        }
        // V16 A2 — flow tuning.  C++ side also clamps defensively
        // (setFlowMaxCorners ≥ 30, setFlowQualityLevel ∈ (0, 1],
        // setFlowMinDistance ≥ 1.0) so we layer the JS-side modal
        // ranges over those minimum invariants.  Reading these
        // unconditionally — they're cheap and the gate ignores them
        // when strategy != .flow.
        if let v = configOverrides["flowMaxCorners"] as? Int {
            self.keyframeGate.flowMaxCorners = max(50, min(300, v))
        } else {
            self.keyframeGate.flowMaxCorners = 150
        }
        if let v = configOverrides["flowQualityLevel"] as? Double {
            self.keyframeGate.flowQualityLevel = max(0.005, min(0.05, v))
        } else {
            self.keyframeGate.flowQualityLevel = 0.01
        }
        if let v = configOverrides["flowMinDistance"] as? Double {
            self.keyframeGate.flowMinDistance = max(1.0, min(50.0, v))
        } else if let v = configOverrides["flowMinDistance"] as? Int {
            // JS sometimes ships Ints when the value happens to be
            // an integer (SegmentedControl options are strings that
            // parseInt into Ints).  Accept either shape.
            self.keyframeGate.flowMinDistance = max(1.0, min(50.0, Double(v)))
        } else {
            self.keyframeGate.flowMinDistance = 10.0
        }
        // V16 — translation-budget force-accept (Flow strategy).  cm
        // on the JS side (UI-friendly), converted to metres by the
        // KeyframeGate.swift setter.  Clamp to [0, 100] cm at start so
        // a stray JS default can't put the gate in an unworkable
        // state.  Default 0 = disabled (preserves pre-V16 behaviour
        // for callers that don't opt in).
        if let v = configOverrides["flowMaxTranslationCm"] as? Double {
            self.keyframeGate.flowMaxTranslationCm = max(0.0, min(100.0, v))
        } else if let v = configOverrides["flowMaxTranslationCm"] as? Int {
            self.keyframeGate.flowMaxTranslationCm = max(0.0, min(100.0, Double(v)))
        } else {
            self.keyframeGate.flowMaxTranslationCm = 0.0
        }
        // V16 — novelty aggregation percentile.  Clamp at start to
        // [0.5, 0.99]; the bridge re-clamps but matching it here
        // means our state stays in-range for logging.  Default 0.85
        // — picks up leading-edge motion sooner than the pre-V16
        // median (0.5).
        if let v = configOverrides["flowNoveltyPercentile"] as? Double {
            self.keyframeGate.flowNoveltyPercentile = max(0.5, min(0.99, v))
        } else {
            self.keyframeGate.flowNoveltyPercentile = 0.85
        }
        // V16 — Swift-side eval throttle.  Default 1 (every consumeFrame
        // runs evaluate).  Range 1-10.  At 1, identical to pre-V16
        // behaviour; at higher N, evaluate runs every Nth frame to
        // save CPU/battery on long captures.  Doesn't change WHICH
        // frames are accepted (still subject to overlapThreshold +
        // translation budget) — just samples less frequently.
        if let v = configOverrides["flowEvalEveryNFrames"] as? Int {
            self.keyframeGate.flowEvalEveryNFrames = max(1, min(10, v))
        } else {
            self.keyframeGate.flowEvalEveryNFrames = 1
        }
        self.keyframeGate.reset()
        os_log(.fault, log: Self.diagLog,
               "[V16-keyframe] start gate enabled=%d strategy=%{public}@ thr=%.2f max=%d flow(maxCorners=%d quality=%.3f minDist=%.1f maxTransCm=%.1f pctile=%.2f evalEveryN=%d)",
               self.keyframeGate.enabled ? 1 : 0,
               self.keyframeGate.strategy == .flow ? "flow" : "pose",
               self.keyframeGate.overlapThreshold,
               self.keyframeGate.maxCount,
               self.keyframeGate.flowMaxCorners,
               self.keyframeGate.flowQualityLevel,
               self.keyframeGate.flowMinDistance,
               self.keyframeGate.flowMaxTranslationCm,
               self.keyframeGate.flowNoveltyPercentile,
               Int32(self.keyframeGate.flowEvalEveryNFrames))

        stateLock.unlock()

        // Register with the AR session — only when running in the
        // AR-frame-stream-driven mode.  In jsDriver mode (iOS non-AR
        // captures) the AR session is intentionally stopped so the
        // vision-camera holds the camera; frames arrive via
        // processFrameAtPath from JS instead.  Registering as the
        // consumer here would either crash (no running session) or
        // mis-route frames once an AR session somewhere else came up.
        if frameSourceMode != "jsDriver" {
            RNSARSession.shared.incrementalConsumer = self
        }
    }

    /// Stop ingestion + write the final panorama to `outputPath`.
    /// Returns the result on the main thread via completion.
    ///
    /// V12.1 frame-leak fix: the previous version waited until the
    /// finalize block ran on the work queue to set isRunning=false.
    /// Between the JS shutter-release and that block running, the
    /// AR delegate could deliver several more frames — each one
    /// passed consumeFrame's `isRunning == true` check and got
    /// ingested into the canvas, producing visible "phantom" frames
    /// V15 — apply per-stage JS overrides on top of a mode default.
    /// Keys recognised in `overrides`: any non-readonly RLISStitcherConfig
    /// field.  Unrecognised keys are ignored.  Values out of range are
    /// clamped silently (e.g. kPanAxisFractionRect outside [0.05, 0.90]).
    private static func applyConfigOverrides(_ overrides: [String: Any],
                                             to config: RLISStitcherConfig) {
        if let v = overrides["kPanAxisFractionRect"] as? Double {
            config.kPanAxisFractionRect = max(0.05, min(0.90, v))
        }
        if let v = overrides["kMinAcceptDeltaPx"] as? Int {
            config.kMinAcceptDeltaPx = max(0, min(500, v))
        }
        if let v = overrides["enableTriangulation"] as? Bool {
            config.enableTriangulation = v
        }
        if let v = overrides["enableTriAccumulator"] as? Bool {
            config.enableTriAccumulator = v
        }
        if let v = overrides["enable1dNcc"] as? Bool {
            config.enable1dNcc = v
        }
        if let v = overrides["nccSearchRadius1d"] as? Int {
            config.nccSearchRadius1d = max(5, min(60, v))
        }
        if let v = overrides["enable2dNcc"] as? Bool {
            config.enable2dNcc = v
        }
        if let v = overrides["enableRansacHomography"] as? Bool {
            config.enableRansacHomography = v
        }
        if let v = overrides["paintMode"] as? String {
            switch v {
            case "FirstPaintedWins": config.paintMode = .firstPaintedWins
            case "FeatherBlend":     config.paintMode = .featherBlend
            default: break
            }
        }
        if let v = overrides["hybridProjection"] as? String {
            switch v {
            case "Cylindrical": config.hybridProjection = .cylindrical
            case "Planar":      config.hybridProjection = .planar
            default: break
            }
        }
        if let v = overrides["useDetectedPlane"] as? Bool {
            config.useDetectedPlane = v
        }
        if let v = overrides["sliverPosition"] as? String {
            switch v {
            case "Center": config.sliverPosition = .center
            case "Bottom": config.sliverPosition = .bottom
            case "Top":    config.sliverPosition = .top
            default: break
            }
        }
        if let v = overrides["firstFrameFullFrame"] as? Bool {
            config.firstFrameFullFrame = v
        }
        // V15.0d new overrides.
        if let v = overrides["planeSource"] as? String {
            switch v {
            case "Disabled":      config.planeSource = .disabled
            case "ARKitDetected": config.planeSource = .arKitDetected
            case "Virtual":       config.planeSource = .virtual
            default: break
            }
        }
        if let v = overrides["virtualPlaneDepthMeters"] as? Double {
            config.virtualPlaneDepthMeters = max(0.3, min(5.0, v))
        }
        if let v = overrides["arkitPlaneAlignmentThreshold"] as? Double {
            config.arkitPlaneAlignmentThreshold = max(0.0, min(1.0, v))
        }
        if let v = overrides["planeProjectionStyle"] as? String {
            switch v {
            case "Trapezoidal": config.planeProjectionStyle = .trapezoidal
            case "Rectified":   config.planeProjectionStyle = .rectified
            default: break
            }
        }
        if let v = overrides["nccSearchMargin2d"] as? Int {
            config.nccSearchMargin2d = max(4, min(60, v))
        }
        if let v = overrides["nccConfidenceThreshold2d"] as? Double {
            config.nccConfidenceThreshold2d = max(0.30, min(0.99, v))
        }
        if let v = overrides["enableNcc2dEmaSmoothing"] as? Bool {
            config.enableNcc2dEmaSmoothing = v
        }
        if let v = overrides["ncc2dEmaAlpha"] as? Double {
            config.ncc2dEmaAlpha = max(0.05, min(0.95, v))
        }
        if let v = overrides["enableNcc2dPanAxisLock"] as? Bool {
            config.enableNcc2dPanAxisLock = v
        }
        if let v = overrides["ncc2dCrossAxisLockPx"] as? Int {
            config.ncc2dCrossAxisLockPx = max(0, min(30, v))
        }
        // Propagate the alignment threshold to the AR session so its
        // didAdd / didUpdate filter uses the operator-chosen value.
        // (planeAlignmentThreshold is a Float on the AR session.)
        RNSARSession.shared.planeAlignmentThreshold =
            Float(config.arkitPlaneAlignmentThreshold)
    }

    /// after the user thought they had released.  The engine refs
    /// and isRunning flag are now flipped SYNCHRONOUSLY here so the
    /// AR delegate's very next consumeFrame sees isRunning=false.
    /// The work-queue body just runs the engine's own finalize.
    @objc public func finalize(
        toPath outputPath: String,
        jpegQuality: Int,
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        // V12.9 fix #3 — flip isRunning=false BEFORE nulling the AR
        // consumer.  The previous order had a race window: AR
        // delegate captures `incrementalConsumer` (non-nil), the
        // delegate is briefly suspended, finalize runs and sets
        // consumer=nil + isRunning=false, then the suspended delegate
        // resumes and calls consumer.consumeFrame().  consumeFrame
        // saw isRunning=false at its first guard and bailed in MOST
        // cases, but the in-flight workQueue task (if any) had
        // already captured non-nil engine refs at consumeFrame
        // entry — by re-checking inside the workQueue async we
        // catch it, but only just.  Flipping isRunning first
        // collapses the race: any consumeFrame entered after this
        // line sees isRunning=false at its very first guard.
        stateLock.lock()
        let hybrid = self.hybridEngine
        let slit = self.firstwinsEngine
        let inBatchKeyframeMode = self.batchKeyframeMode
        let collector = self.keyframeCollector
        let paths = self.keyframePaths
        // V16 Phase 1b.fix4 — snapshot the cv::Stitcher knobs and
        // EXIF orientation under stateLock so the workQueue closure
        // has a stable view of these values, independent of any
        // concurrent start() that may begin a new capture before
        // this closure finishes.
        //
        // Why this matters (RCA from Sentry crashes 2026-05-09
        // 21:59-22:03, all 3 .ips traces):
        //   EXC_BAD_ACCESS at objc_retain+16, frame 1 = closure #1
        //   in finalize+2648, queue = com.retailens.incremental.
        //   stitcher.  +2648 lands inside the os_log call that
        //   bridges self.batchWarperType → NSString via
        //   swift_bridgeObjectRetain → objc_retain.  The retain
        //   loaded a torn buffer pointer because:
        //
        //     T0: finalize releases stateLock, dispatches workQueue
        //         async closure (long stitch ahead).
        //     T1: User sees fix2's "9002 No active capture" popup
        //         (race between shutter-release + auto-finalize
        //         useEffect, fixed in fix3 but pre-existing in
        //         fix2).
        //     T2: User dismisses popup, starts a new capture.
        //     T3: start() acquires stateLock, sees isRunning==false,
        //         WRITES self.batchWarperType = newValue.  ARC
        //         releases the old String buffer.
        //     T4: workQueue closure (still mid-finalize from
        //         capture N) loads self.batchWarperType for os_log.
        //         Read interleaved with T3's write → torn String
        //         buffer pointer → swift_bridgeObjectRetain →
        //         objc_retain on freed memory → KERN_INVALID_ADDRESS.
        //
        // Fix3's JS dedupe closes the practical trigger (no popup,
        // no operator-confusion-driven new capture).  Fix4 closes
        // the underlying race regardless of UI flow correctness.
        let batchWarperType = self.batchWarperType
        let batchBlenderType = self.batchBlenderType
        let batchSeamFinderType = self.batchSeamFinderType
        let batchEnableInscribedRectCrop = self.batchEnableInscribedRectCrop
        let keyframeExifOrientation = self.keyframeExifOrientation
        // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
        // Snapshot the capture-time hold orientation for the bake-
        // rotation pass.  Reasons same as the other snapshots above:
        // stateLock-protected against a concurrent start() rewriting
        // self.captureOrientation while the workQueue closure is mid-
        // flight.
        let captureOrientation = self.captureOrientation
        // V16 Phase 1.fix4 — pose array still held on self ivar (and
        // queued for persistent sidecar storage in a future debug-menu
        // feature) but NOT passed to the stitcher in this drop.  fix4
        // uses feature-matched stitchFramePaths which doesn't take
        // poses; cv::Stitcher's BA derives camera placement from
        // features.  Drop the closure-capture to avoid a compile
        // warning; ARKit pose data is preserved on the ivar regardless.
        _ = self.keyframePoses
        self.hybridEngine = nil
        self.firstwinsEngine = nil
        self.batchKeyframeMode = false
        self.keyframeCollector = nil
        self.keyframePaths = []
        self.keyframePoses = []
        self.isRunning = false
        let drops = self.droppedBackpressure
        stateLock.unlock()

        // V16 Phase 1b.fix8 (C2 — stateless finalize):
        //   The prior 7 fix attempts all individually snapshotted the
        //   batch* ivars + paths/collector/engines/drops above into
        //   closure-locals.  This worked at the source level but the
        //   `objc_retain` family of crashes kept moving from one
        //   closure to the next (closure #1 → closure #2, offset
        //   +2648 → +5176) — the compiler still had implicit-capture
        //   latitude.  C2 closes the entire class:
        //     1. Bundle every snapshot into a value-typed
        //        FinalizePayload (defined at file scope above the
        //        class declaration).
        //     2. Pass the payload BY VALUE into the workQueue closure
        //        via an explicit capture list `[payload, completion]`.
        //     3. Bracket the closure with `C2-INVARIANT` marker
        //        comments and enforce "no `self.*` inside" via the
        //        CI test at scripts/check_c2_invariant.sh.
        //   Net effect: the closure literally cannot read any
        //   stitcher ivar.  Any future edit that re-introduces a
        //   `self.` reference inside the closure is caught at CI.
        let arWasRunning = inBatchKeyframeMode
            && RNSARSession.shared.isRunning
        let cleaned = (outputPath.hasPrefix("file://"))
            ? String(outputPath.dropFirst(7))
            : outputPath
        let q = max(1, min(100, jpegQuality))
        let payload = FinalizePayload(
            cleaned: cleaned,
            q: q,
            inBatchKeyframeMode: inBatchKeyframeMode,
            hybrid: hybrid,
            slit: slit,
            collector: collector,
            paths: paths,
            batchWarperType: batchWarperType,
            batchBlenderType: batchBlenderType,
            batchSeamFinderType: batchSeamFinderType,
            batchEnableInscribedRectCrop: batchEnableInscribedRectCrop,
            keyframeExifOrientation: keyframeExifOrientation,
            captureOrientation: captureOrientation,
            drops: drops,
            arWasRunning: arWasRunning
        )

        // Then detach the AR consumer.  Any in-flight delegate that
        // already captured the consumer reference will reach
        // consumeFrame, see isRunning=false, and bail.
        RNSARSession.shared.incrementalConsumer = nil

        // V16 Phase 1b.fix1 — pause the AR session for the duration
        // of the stitch (batch-keyframe path only).  ARSession holds
        // a pixel-buffer pool, world map, and plane geometry that
        // collectively contribute ~200-300 MB to baseline.  Dropping
        // them while cv::Stitcher's BA + GraphCut + MultiBand runs
        // gives the stitcher more headroom under the per-process
        // limit.  Restart on the main thread after the stitch
        // completes so the next capture has AR ready (next plane
        // detection + tracking re-initialise will take 2-3 s, which
        // matches Ram's chosen "Option C" trade-off).
        //
        // `arWasRunning` was computed above into FinalizePayload — read
        // from `payload.arWasRunning` here so we have one source of
        // truth (the value the closure's defer also reads).
        if payload.arWasRunning {
            os_log(.fault, log: Self.diagLog,
                   "[V16-batch-keyframe] pausing AR session for stitch (memory drop)")
            RNSARSession.shared.stop()
        }

        // V16 Phase 1b.fix6 — ARCHITECTURAL: workQueue.sync (not async)
        // for finalize.
        //
        // Background: finalize ran 5 prior fixes targeting an
        // EXC_BAD_ACCESS in objc_retain inside this closure.  fix4
        // snapshotted every self.batch*, self.captureOrientation,
        // self.keyframePoses, and the engine refs into closure-locals
        // under stateLock, closing the visible torn-pointer race.
        // Three Sentry traces post-fix4 still showed the same crash
        // signature (frame 1 = closure #1 in finalize+N, queue =
        // com.retailens.incremental.stitcher), which per the
        // systematic-debugging skill (3+ fixes failed on the same
        // symptom = wrong architecture) means the workQueue.async
        // pattern itself is the problem, not any specific captured
        // ivar.
        //
        // Why .sync fixes the entire class of issues:
        //   1. Serializes finalize with start(): the bridge thread
        //      can't return to JS until the stitch + completion fire.
        //      JS can't trigger a new start() during the in-flight
        //      stitch because the JS side awaits the finalize promise.
        //   2. Eliminates the "1-frame crash" race: with .async, when
        //      paths.count==1 the closure rejected via completion +
        //      returned synchronously, but the auto-finalize useEffect
        //      on JS occasionally fired a SECOND finalize before the
        //      first one's completion had landed.  With .sync, the
        //      second finalize is blocked until the first one returns.
        //   3. Removes the "what if completion's captured resolver/
        //      rejecter get released by the bridge before the closure
        //      runs" failure mode entirely — there's no longer any
        //      window between dispatch and execution.
        //
        // Cost: bridge thread blocks for the stitch duration (2-5 s
        // on 4-6 keyframes at iPhone 16 Pro).  The bridge thread is
        // NOT main (RCTEventEmitter.requiresMainQueueSetup() is false
        // and we don't override methodQueue) so UI stays responsive.
        // Other IncrementalStitcher bridge calls queue up
        // for ~3 s — acceptable since the JS side is awaiting the
        // finalize promise anyway and isn't issuing other calls
        // during that interval.
        //
        // Deadlock check: workQueue is consumed by consumeFrame
        // (AR delegate, line ~1424) and finalize.  If the AR delegate
        // is currently mid-frame on workQueue when we call .sync, the
        // .sync waits for it (~50-100 ms JPEG encode) — not a
        // deadlock, just brief serialization.  No other queue
        // dispatches synchronously TO workQueue, so .sync is safe.
        // MARK: C2-INVARIANT-START — no `self.` access below this line until C2-INVARIANT-END
        //
        // Enforced by scripts/check_c2_invariant.sh: any `self.` token
        // (non-comment) inside this region is a CI failure.  Every
        // value the closure needs is plumbed through `payload`.
        //
        // Capture list is EXPLICIT — `[payload, completion]` ONLY.
        // The compiler will refuse any reference here that isn't
        // satisfied by these two captures, value-typed members of
        // `payload`, static types (`Self.diagLog`, `OpenCVStitcher`,
        // `FileManager`, `CGDataProvider`, `CGImage`, `NSError`,
        // `RNSARSession`), or local lets/declarations made
        // inside the closure.
        workQueue.sync { [payload, completion] in
            // V16 Phase 1b.fix1 — defer-restart AR session.  Fires
            // on every exit path (success, error, early return).
            // Restart is dispatched to main because ARSession.run()
            // expects main-thread invocation to set up its rendering
            // hooks; happens AFTER the stitch completes so it doesn't
            // contend for the memory budget.
            defer {
                if payload.arWasRunning {
                    // Inner closure body references only `Self.diagLog`
                    // (static type) and `RNSARSession.shared`
                    // (singleton) — both name-resolve without
                    // capturing self.  No explicit capture list
                    // required; the C2 invariant script grep-checks
                    // for `self.*` tokens which this body has none of.
                    DispatchQueue.main.async {
                        os_log(.fault, log: Self.diagLog,
                               "[V16-batch-keyframe] restarting AR session post-stitch")
                        RNSARSession.shared.start()
                    }
                }
            }
            do {
                if payload.inBatchKeyframeMode {
                    // V16 Phase 1 — hand collected keyframes + poses
                    // to OpenCVStitcher's full BA + GraphCut +
                    // ExposureComp + MultiBand pipeline.  ≤6 frames
                    // means BA stays bounded and MultiBand fits.
                    os_log(.fault, log: Self.diagLog,
                           "[V16-batch-keyframe] finalize ENTRY frames=%d",
                           payload.paths.count)
                    // V16 Phase 1b.fix7 — single-keyframe UX:
                    // accept a 1-frame finalize by copying the lone
                    // keyframe JPEG to outputPath (preserving the JPEG
                    // bytes as-is, no re-encode).  Previously this path
                    // rejected with code 9003, and an auto-finalize
                    // useEffect on JS could fire it during a quick
                    // tap-and-release.  The user-visible failure
                    // ("9003 only 1 keyframe saved") was both
                    // confusing AND occasionally racing with a second
                    // finalize call into the EXC_BAD_ACCESS path that
                    // fix4/fix6 closed.  Returning the single frame as
                    // the output is the right UX: a single keyframe IS
                    // a valid panorama capture (just one shot).
                    if payload.paths.count < 2 {
                        if payload.paths.count == 1 {
                            let src = payload.paths[0]
                            do {
                                // Remove any pre-existing file at the
                                // output path — copyItem refuses to
                                // overwrite, and a stale tmp file from
                                // a prior auto-finalize attempt is the
                                // common case.
                                let fm = FileManager.default
                                if fm.fileExists(atPath: payload.cleaned) {
                                    try fm.removeItem(atPath: payload.cleaned)
                                }
                                try fm.copyItem(atPath: src, toPath: payload.cleaned)
                                // Read back the JPEG dimensions for
                                // the result dictionary — match
                                // OpenCVStitcher.stitchFramePaths'
                                // {width, height} contract so JS
                                // doesn't have to special-case a
                                // single-frame result.
                                var width: Int = 0
                                var height: Int = 0
                                if let provider = CGDataProvider(filename: payload.cleaned),
                                   let img = CGImage(
                                    jpegDataProviderSource: provider,
                                    decode: nil,
                                    shouldInterpolate: false,
                                    intent: .defaultIntent) {
                                    width = img.width
                                    height = img.height
                                }
                                os_log(.fault, log: Self.diagLog,
                                       "[V16-batch-keyframe.fix7] single-keyframe finalize: copied %{public}@ → %{public}@ (%dx%d)",
                                       src, payload.cleaned,
                                       Int32(width), Int32(height))
                                completion([
                                    "panoramaPath": payload.cleaned,
                                    "width": width,
                                    "height": height,
                                    "acceptedCount": 1,
                                    "droppedBackpressure": payload.drops,
                                    "batchKeyframeSessionDir":
                                        payload.collector?.sessionDir ?? "",
                                    "batchKeyframeCount": 1,
                                    "singleKeyframe": true,
                                ], nil)
                                return
                            } catch let copyErr as NSError {
                                // Fall through to the legacy "not
                                // enough keyframes" rejection so the
                                // user at least gets a discoverable
                                // error rather than a silent hang.
                                os_log(.fault, log: Self.diagLog,
                                       "[V16-batch-keyframe.fix7] single-keyframe copy failed: %{public}@",
                                       copyErr.localizedDescription)
                            }
                        }
                        payload.collector?.cleanup()
                        completion(nil, NSError(
                            domain: "RNImageStitcherIncremental",
                            code: 9003,
                            userInfo: [NSLocalizedDescriptionKey:
                                "Batch-keyframe finalize: 0 keyframes saved — capture didn't accept any frames."]
                        ))
                        return
                    }
                    // Swift bridges `(NSError**)error` as `throws`,
                    // so we use a do/catch instead of an inout error
                    // pointer.  Result is non-optional inside the
                    // try block (or we wouldn't reach the success
                    // branch).
                    do {
                        // V16 Phase 1.fix4 — ARCHITECTURAL PIVOT.
                        // Three iterations of pose-driven (fix1/2/3)
                        // produced different failure modes (UMat
                        // bbox blowup, sideways output, frames out of
                        // order, same physical object placed twice).
                        // Per the systematic-debugging skill: 3+ failed
                        // fixes on the same approach = wrong
                        // architecture.
                        //
                        // Switching to cv::Stitcher's feature-matched
                        // pipeline (stitchFramePaths) — same warper /
                        // blender / seam settings, but uses ORB +
                        // BFMatcher + RANSAC + BundleAdjusterRay +
                        // waveCorrect for camera placement instead of
                        // ARKit poses.  Battle-tested for years in
                        // cv::Stitcher::PANORAMA / SCANS modes.
                        //
                        // The 4-6 keyframes (with ≥40% new content
                        // each, guaranteed by the Phase 0 gate) have
                        // 60% overlap on retail content — features
                        // are abundant and BA converges in <500 ms.
                        // Output orientation, frame ordering, and
                        // canvas bounds are all determined BY THE
                        // FEATURES, not by pose-convention assumptions.
                        //
                        // ARKit poses are still saved alongside each
                        // keyframe (`keyframePoses`) for future
                        // pose-driven investigation as a separate
                        // workstream — that path stays in the codebase
                        // (stitchKeyframePaths method) but isn't on
                        // the hot path.
                        // V16 Phase 1b.fix3 — pass the EXIF Orientation
                        // tag derived from `frameRotationDegrees`.
                        // V16 Phase 1b.fix8 (C2) — read knobs from
                        // `payload` (value-snapshot built under
                        // stateLock in finalize's prologue).  No
                        // `self.*` access here; closure cannot race
                        // with a concurrent `start()`.
                        // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
                        // `payload.captureOrientation` drives the .mm
                        // bake-rotation; `payload.keyframeExifOrientation`
                        // kept for any future per-keyframe EXIF needs.
                        _ = payload.keyframeExifOrientation
                        os_log(.fault, log: Self.diagLog,
                               "[V16-batch-keyframe] stitch (feature-matched): warper=%{public}@ blender=%{public}@ seam=%{public}@ captureOrientation=%{public}@",
                               payload.batchWarperType,
                               payload.batchBlenderType,
                               payload.batchSeamFinderType,
                               payload.captureOrientation)
                        let r = try OpenCVStitcher.stitchFramePaths(
                            payload.paths,
                            outputPath: payload.cleaned,
                            jpegQuality: payload.q,
                            warperType: payload.batchWarperType,
                            blenderType: payload.batchBlenderType,
                            seamFinderType: payload.batchSeamFinderType,
                            captureOrientation: payload.captureOrientation,
                            useInscribedRectCrop: payload.batchEnableInscribedRectCrop
                        )
                        // V16 fix-attempt 9 (verified on device,
                        // 2026-05-13) — sentinel-result detection.
                        //
                        // Background: 8 prior fix attempts (fix1-fix8)
                        // chased a deterministic SEGV in Swift's
                        // try-bridge over OpenCVStitcher's NSError-
                        // out-parameter return.  ASan with Sentry
                        // disabled (.ips 172125) localised the SEGV to
                        // an objc_retain on a wild pointer in unmapped
                        // VM (0x60007a530, ReportDeadlySignal — no
                        // shadow-memory match) immediately after the
                        // .mm `return nil`.  The fix-9 NULL TEST
                        // (2026-05-13 17:21) replaced the two
                        // immediate-repro `*error+return nil` sites
                        // with non-nil sentinel returns; the crash
                        // went away cleanly.  After the test passed
                        // we extended the sentinel pattern to ALL six
                        // failure-return sites in stitchFramePaths
                        // (pre-stitch memory abort, frames<2,
                        // loadFramesOrFail, validPairs<1, workFrames<2,
                        // estimator failure) so a production trigger of
                        // any of them produces a clean error surface
                        // instead of crashing the same way.
                        //
                        // We can't tell which underlying cause produced
                        // a given sentinel from Swift (the .mm logs the
                        // specific reason via NSLog so Console.app
                        // shows it).  JS gets one generic error code
                        // (9007); refining the JS-facing taxonomy is
                        // a follow-up if/when product needs differ-
                        // entiated UX per cause.
                        //
                        // See: docs/site-content/design/2026-05-12-finalize-crash-investigation.md
                        if r.width == 0 && r.height == 0 {
                            os_log(.fault, log: Self.diagLog,
                                   "[V16-batch-keyframe.fix9] sentinel result from stitchFramePaths — see preceding [BatchStitcher] NSLog for cause; emitting clean error to JS")
                            completion(nil, NSError(
                                domain: "RNImageStitcherIncremental",
                                code: 9007,
                                userInfo: [NSLocalizedDescriptionKey:
                                    "Could not stitch the captured frames into a panorama. Please try recapturing with a slower, more deliberate pan that overlaps each section by at least 50%."]
                            ))
                            return
                        }
                        // Keep saved keyframes on disk for post-hoc
                        // re-processing (Ram's request).  Cleanup is
                        // a follow-up debug-menu task.
                        // 2026-05-16 (Issue 5) — surface C+D
                        // progressive-confidence retry telemetry to JS
                        // so the host can render a debug toast.  -1
                        // sentinels = "no retry data" (early-return
                        // success paths bypass the retry loop).
                        var batchDict: [String: Any] = [
                            "panoramaPath": r.outputPath,
                            "width": Int(r.width),
                            "height": Int(r.height),
                            "acceptedCount": payload.paths.count,
                            "droppedBackpressure": payload.drops,
                            "batchKeyframeSessionDir":
                                payload.collector?.sessionDir ?? "",
                            "batchKeyframeCount": payload.paths.count,
                        ]
                        if r.framesRequested >= 0 {
                            batchDict["framesRequested"] = Int(r.framesRequested)
                        }
                        if r.framesIncluded >= 0 {
                            batchDict["framesIncluded"] = Int(r.framesIncluded)
                            if r.framesRequested >= 0 {
                                batchDict["framesDropped"] =
                                    Int(r.framesRequested - r.framesIncluded)
                            }
                        }
                        if r.finalConfidenceThresh >= 0 {
                            batchDict["finalConfidenceThresh"] = r.finalConfidenceThresh
                        }
                        completion(batchDict, nil)
                    } catch let stitchErr as NSError {
                        completion(nil, stitchErr)
                    }
                } else if let hybrid = payload.hybrid {
                    let snap = try hybrid.finalize(atPath: payload.cleaned, jpegQuality: payload.q)
                    completion([
                        "panoramaPath": snap.panoramaPath,
                        "width": snap.width,
                        "height": snap.height,
                        "acceptedCount": snap.acceptedCount,
                        "droppedBackpressure": payload.drops,
                    ], nil)
                    // 2026-05-16 — realtime+batch fusion (Option A
                    // "Replace on completion") hook.  The live
                    // panorama has been written and the JS finalize
                    // promise has resolved; now fire-and-forget an
                    // async refinement over the hybrid engine's
                    // accepted keyframes.
                    //
                    // Constraints honoured here (per the design doc
                    // and the prompt's "Constraints" list):
                    //   1. Hybrid realtime engine is NOT modified —
                    //      `OpenCVIncrementalStitcher.mm` stays
                    //      untouched; we only consult the existing
                    //      keyframe-path ivar that finalize() already
                    //      snapshotted into `payload.paths`.
                    //   2. NO-OP when keyframes are not on disk.
                    //      Today's hybrid engine does NOT save per-
                    //      frame JPEGs (only batch-keyframe mode does
                    //      via OpenCVKeyframeCollector), so
                    //      `payload.paths` is empty for the hybrid
                    //      branch.  `runHybridAutoRefine` detects
                    //      that and emits `isRefining=false` without
                    //      running cv::Stitcher.  When a future change
                    //      hooks the hybrid engine up to a keyframe
                    //      collector, the same code path lights up
                    //      automatically.
                    //   3. Refinement is fire-and-forget — finalize's
                    //      promise has ALREADY been resolved above.
                    //
                    // Capture-list discipline (C2 invariant — see the
                    // file-top markers).  No `self.*` references allowed
                    // here; we route the dispatch through the type
                    // (IncrementalStitcher.shared) so the
                    // closure captures only value-typed locals + the
                    // class type itself.  shared is a process-wide
                    // singleton (initialised once at module load),
                    // so this is lifecycle-safe.
                    let refinedOut = Self.refinedPathFromLive(
                        livePath: snap.panoramaPath
                    )
                    let pathsForRefine = payload.paths   // empty for hybrid today
                    let capOri = payload.captureOrientation
                    let warper = payload.batchWarperType
                    let blender = payload.batchBlenderType
                    let seam = payload.batchSeamFinderType
                    let inscribed = payload.batchEnableInscribedRectCrop
                    IncrementalStitcher.shared.refineQueue.async {
                        IncrementalStitcher.shared.runHybridAutoRefine(
                            framePaths: pathsForRefine,
                            refinedOutputPath: refinedOut,
                            captureOrientation: capOri,
                            warperType: warper,
                            blenderType: blender,
                            seamFinderType: seam,
                            useInscribedRectCrop: inscribed
                        )
                    }
                } else if let slit = payload.slit {
                    let snap = try slit.finalize(atPath: payload.cleaned, jpegQuality: payload.q)
                    completion([
                        "panoramaPath": snap.panoramaPath,
                        "width": snap.width,
                        "height": snap.height,
                        "acceptedCount": snap.acceptedCount,
                        "droppedBackpressure": payload.drops,
                    ], nil)
                } else {
                    completion(nil, NSError(
                        domain: "RNImageStitcherIncremental",
                        code: 9002,
                        userInfo: [NSLocalizedDescriptionKey:
                            "No active capture — call start() first."]
                    ))
                }
            } catch let err as NSError {
                completion(nil, err)
            }
        }
        // MARK: C2-INVARIANT-END
    }

    /// 2026-05-16 — realtime+batch fusion (Option A) entry point.
    /// Runs the shared C++ stitcher over the supplied keyframe JPEGs
    /// and writes a refined panorama to `outputPath`.
    ///
    /// Called by:
    ///   1. The bridge layer (explicit JS `refinePanorama(...)` API).
    ///   2. `runHybridAutoRefine(...)` below, the fire-and-forget hook
    ///      from `finalize()` for the hybrid-engine path.
    ///
    /// Threading: the work itself dispatches onto `refineQueue` (NOT
    /// `workQueue`).  That keeps the per-capture path completely
    /// independent — a refinement in flight does not delay a fresh
    /// start()/consumeFrame() pair the operator may have initiated
    /// while the refinement runs.  Completion fires on `refineQueue`;
    /// callers that need main-thread delivery (e.g. the bridge
    /// promise resolver) re-dispatch as needed.
    ///
    /// Configuration: same option set the bridge sees from JS plus
    /// production-tested defaults that match the existing
    /// batch-keyframe finalize path:
    ///   warperType         = "spherical"
    ///   blenderType        = "multiband"
    ///   seamFinderType     = "graphcut"
    ///   captureOrientation = "portrait"
    ///   useInscribedRectCrop = false
    ///   jpegQuality        = 90
    ///
    /// Pre-conditions enforced here (in addition to bridge-level
    /// validation): every input path must exist on disk; if any is
    /// missing the call resolves with an NSError so the caller can
    /// surface a clean error rather than letting cv::imread crash
    /// inside the manual pipeline.
    @objc public func refinePanorama(
        framePaths: [String],
        outputPath: String,
        config: [String: Any],
        completion: @escaping ([String: Any]?, NSError?) -> Void
    ) {
        guard framePaths.count >= 2 else {
            completion(nil, NSError(
                domain: "RNImageStitcherIncremental",
                code: 9101,
                userInfo: [NSLocalizedDescriptionKey:
                    "refinePanorama requires at least 2 framePaths (got \(framePaths.count))."]
            ))
            return
        }
        let fm = FileManager.default
        for p in framePaths {
            let cleaned = p.hasPrefix("file://") ? String(p.dropFirst(7)) : p
            if !fm.fileExists(atPath: cleaned) {
                completion(nil, NSError(
                    domain: "RNImageStitcherIncremental",
                    code: 9102,
                    userInfo: [NSLocalizedDescriptionKey:
                        "refinePanorama: keyframe missing on disk — \(cleaned)"]
                ))
                return
            }
        }
        let warper      = (config["warperType"] as? String) ?? "spherical"
        let blender     = (config["blenderType"] as? String) ?? "multiband"
        let seam        = (config["seamFinderType"] as? String) ?? "graphcut"
        let orientation = (config["captureOrientation"] as? String) ?? "portrait"
        let useInscribed = (config["useInscribedRectCrop"] as? Bool) ?? false
        let quality     = max(1, min(100, (config["jpegQuality"] as? Int) ?? 90))
        let cleanedOutput = outputPath.hasPrefix("file://")
            ? String(outputPath.dropFirst(7))
            : outputPath

        os_log(.fault, log: Self.diagLog,
               "[refine] dispatch frames=%d output=%{public}@ warper=%{public}@ blender=%{public}@ seam=%{public}@",
               framePaths.count,
               cleanedOutput,
               warper, blender, seam)

        refineQueue.async {
            // C2-style: closure captures only value-typed locals
            // (paths, output path, config strings).  No `self` access
            // is needed for the cv::Stitcher call — OpenCVStitcher is
            // a class method, not an instance method, so we can call
            // it directly via the type.
            do {
                let r = try OpenCVStitcher.stitchFramePaths(
                    framePaths,
                    outputPath: cleanedOutput,
                    jpegQuality: quality,
                    warperType: warper,
                    blenderType: blender,
                    seamFinderType: seam,
                    captureOrientation: orientation,
                    useInscribedRectCrop: useInscribed
                )
                // fix-9 sentinel detection — see the finalize() path
                // for the full rationale.  A 0×0 result means
                // OpenCVStitcher hit one of its six guarded failure
                // returns; surface as a clean NSError.
                if r.width == 0 && r.height == 0 {
                    completion(nil, NSError(
                        domain: "RNImageStitcherIncremental",
                        code: 9107,
                        userInfo: [NSLocalizedDescriptionKey:
                            "refinePanorama: stitcher returned sentinel — see preceding [BatchStitcher] log for cause."]
                    ))
                    return
                }
                completion([
                    "panoramaPath": r.outputPath,
                    "width": Int(r.width),
                    "height": Int(r.height),
                    "framesRequested": framePaths.count,
                    "framesIncluded": framePaths.count,
                    "framesDropped": 0,
                    "finalConfidenceThresh": -1.0,
                ], nil)
            } catch let err as NSError {
                completion(nil, err)
            }
        }
    }

    /// 2026-05-16 — realtime+batch fusion (Option A) auto-trigger.
    /// Called from `finalize()` immediately after the hybrid engine
    /// wrote its live panorama; fire-and-forget from finalize()'s
    /// perspective so the JS-side finalize promise resolves with the
    /// live result first.  Then this method:
    ///
    ///   1. Emits a state event with `isRefining = true` so the host
    ///      can render its "Refining…" pill.
    ///   2. Runs `refinePanorama(framePaths, refinedOutputPath, ...)`.
    ///   3. On success: emits a state event with `isRefining = false`
    ///      AND `refinedPanoramaPath = <path>` so the host swaps in
    ///      the higher-quality output.
    ///   4. On failure: emits a state event with `isRefining = false`
    ///      AND NO refined path.  Host keeps showing the live
    ///      panorama; the design doc's "Couldn't refine" toast UX is
    ///      a follow-up.
    ///
    /// No-op when `framePaths.count < 2` or any framePath is missing
    /// on disk.  Hybrid-engine captures DO NOT today save per-frame
    /// JPEGs, so this method's most common call site (from finalize's
    /// hybrid branch) currently produces a no-op + isRefining=false
    /// emit — which is intentional (the design doc says "if
    /// keyframes are NOT on disk, the auto-trigger is a no-op").
    private func runHybridAutoRefine(
        framePaths: [String],
        refinedOutputPath: String,
        captureOrientation: String,
        warperType: String,
        blenderType: String,
        seamFinderType: String,
        useInscribedRectCrop: Bool
    ) {
        if framePaths.count < 2 {
            os_log(.info, log: Self.diagLog,
                   "[refine.auto] skipped: framePaths.count=%d (< 2 — hybrid engine retains no per-frame JPEGs)",
                   framePaths.count)
            // Emit isRefining=false so any host that pre-seeded a
            // pill on finalize doesn't get stuck.
            self.emitRefinementState(isRefining: false, refinedPanoramaPath: nil)
            return
        }
        // Pre-flight existence check so we degrade gracefully when
        // a JPEG was unlinked between finalize and the dispatch
        // landing on refineQueue.
        let fm = FileManager.default
        for p in framePaths {
            let cleaned = p.hasPrefix("file://") ? String(p.dropFirst(7)) : p
            if !fm.fileExists(atPath: cleaned) {
                os_log(.info, log: Self.diagLog,
                       "[refine.auto] skipped: missing keyframe %{public}@",
                       cleaned)
                self.emitRefinementState(isRefining: false, refinedPanoramaPath: nil)
                return
            }
        }
        // Signal the pill on before the stitcher work begins.  The
        // emit goes through the same notification channel as every
        // other state update; JS sees it asynchronously, which is
        // fine — operator UX wants the pill within a few hundred ms,
        // not synchronously with finalize's promise resolution.
        self.emitRefinementState(isRefining: true, refinedPanoramaPath: nil)
        let config: [String: Any] = [
            "warperType": warperType,
            "blenderType": blenderType,
            "seamFinderType": seamFinderType,
            "captureOrientation": captureOrientation,
            "useInscribedRectCrop": useInscribedRectCrop,
            "jpegQuality": 90,
        ]
        self.refinePanorama(
            framePaths: framePaths,
            outputPath: refinedOutputPath,
            config: config
        ) { [weak self] result, error in
            guard let self = self else { return }
            if let error = error {
                os_log(.fault, log: Self.diagLog,
                       "[refine.auto] refinement failed: %{public}@ — leaving live output in place",
                       error.localizedDescription)
                self.emitRefinementState(isRefining: false, refinedPanoramaPath: nil)
                return
            }
            let path = (result?["panoramaPath"] as? String) ?? refinedOutputPath
            os_log(.fault, log: Self.diagLog,
                   "[refine.auto] success path=%{public}@",
                   path)
            self.emitRefinementState(isRefining: false, refinedPanoramaPath: path)
        }
    }

    /// 2026-05-16 — emit a minimal state event carrying only the
    /// refinement-related fields.  Mirrors the existing
    /// `emitBatchKeyframeAcceptedState` pattern: build a fresh
    /// IncrementalStateObject, then add the new optional fields
    /// directly to the userInfo dict so JS (which reads from the
    /// raw event payload) picks them up without a schema change in
    /// the Obj-C class.
    private func emitRefinementState(
        isRefining: Bool,
        refinedPanoramaPath: String?
    ) {
        // Preserve the most-recent panoramaPath / dims / accepted
        // count so the JS subscriber's sticky-snapshot merge keeps
        // showing the live preview between the finalize and the
        // refined swap.  All other fields default to "no-op" values.
        stateLock.lock()
        let prev = self.lastState
        stateLock.unlock()
        let state = IncrementalStateObject(
            panoramaPath: prev?.panoramaPath,
            width: prev?.width ?? 0,
            height: prev?.height ?? 0,
            acceptedCount: prev?.acceptedCount ?? 0,
            outcome: prev?.outcome ?? .acceptedHigh,
            confidence: prev?.confidence ?? 1.0,
            overlapPercent: prev?.overlapPercent ?? -1.0,
            processingMs: 0,
            isLandscape: prev?.isLandscape ?? false,
            paintedExtent: prev?.paintedExtent ?? 0,
            panExtent: prev?.panExtent ?? 0,
            keyframeMax: prev?.keyframeMax ?? 0
        )
        var dict = state.asDictionary()
        dict["isRefining"] = isRefining
        if let p = refinedPanoramaPath {
            dict["refinedPanoramaPath"] = p
        }
        NotificationCenter.default.post(
            name: .retailensIncrementalStateUpdate,
            object: nil,
            userInfo: dict
        )
    }

    /// Cancel an in-progress capture without producing output.
    /// Same V12.1 synchronous-stop pattern as finalize.
    @objc public func cancel() {
        // V12.9 fix #3 — same ordering as finalize: flip isRunning
        // FIRST so any in-flight consumeFrame bails at its first
        // guard.  Then detach the AR consumer.
        stateLock.lock()
        let hybrid = self.hybridEngine
        let slit = self.firstwinsEngine
        let collector = self.keyframeCollector
        self.hybridEngine = nil
        self.firstwinsEngine = nil
        self.keyframeCollector = nil
        self.batchKeyframeMode = false
        self.keyframePaths = []
        self.keyframePoses = []
        self.isRunning = false
        self.lastState = nil
        // V16 — reset the keyframe gate so the next start() begins
        // with a clean polygon state and counter.  Safe to do under
        // stateLock because the gate is only mutated from the AR
        // delegate (consumeFrame) and the JS thread (start/cancel
        // /markNextFrameAsLastKeyframe), all serialized via this lock.
        self.keyframeGate.reset()
        stateLock.unlock()
        RNSARSession.shared.incrementalConsumer = nil
        // Reset on the work queue so we don't race with an in-flight
        // ingest that's still touching the engine's canvas.  Cancel
        // ALSO removes the collector's session directory — the
        // operator explicitly aborted, so the saved JPEGs aren't
        // worth keeping for re-processing.
        workQueue.async {
            hybrid?.reset()
            slit?.reset()
            collector?.cleanup()
        }
    }

    /// V16 — JS-side hook for shutter-release: arm the gate so the
    /// NEXT delivered ARFrame is force-accepted regardless of overlap.
    /// Without this, the user releasing mid-pan (between two natural
    /// keyframe boundaries) would leave the trailing edge of the
    /// scene unrepresented in the panorama.
    ///
    /// Idempotent: setting the flag while it's already set is a no-op.
    /// Safe to call from any thread (NSLock-guarded).  No-op when the
    /// gate is disabled (frameSelectionMode = "time-based").
    @objc public func markNextFrameAsLastKeyframe() {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard self.isRunning, self.keyframeGate.enabled else { return }
        self.keyframeGate.forceAcceptNext = true
        os_log(.fault, log: Self.diagLog,
               "[V16-keyframe] markNextFrameAsLastKeyframe armed (count=%d max=%d)",
               self.keyframeGate.acceptedCount, self.keyframeGate.maxCount)
    }

    /// Whether the engine is currently in batch-keyframe mode.
    /// Bridge reads this to decide whether the JS-driven
    /// `processFrameAtPath` path can use the lightweight
    /// `addBatchKeyframePath` (path-only) entry below.
    @objc public var isBatchKeyframeMode: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return batchKeyframeMode
    }

    /// 2026-05-18 (Issue #2 v2) — JS-driver entry-point for
    /// batch-keyframe captures.  Mirrors Android's behaviour: the
    /// caller (JS side via the IncrementalStitcherBridge) hands us a
    /// JPEG file path that already exists on disk (saved by
    /// vision-camera's takeSnapshot), plus a synthetic pose derived
    /// from gyro integration.  We:
    ///
    ///   1. Validate state (running + batchKeyframeMode).
    ///   2. Ask the shared C++ KeyframeGate whether to accept this
    ///      frame.  Pass `latchedPlane: nil` — non-AR captures have
    ///      no plane; the C++ gate falls back to a pose-only
    ///      angular-delta strategy.  We do NOT pass a pixel buffer:
    ///      the Pose strategy doesn't need one, and avoiding the
    ///      JPEG → CVPixelBuffer round-trip dodges the iOS
    ///      orientation bugs that broke Issue 2 v1
    ///      (UIImage/CGContext Y-flip + EXIF-vs-CGImage dimension
    ///      mismatch — see the symptom in 2026-05-18 user report).
    ///   3. If accepted, append the existing path + pose to the
    ///      finalize-time lists.  No JPEG re-encode — the file on
    ///      disk IS the keyframe.  `retailens::stitchFramePaths()`
    ///      at finalize uses `cv::imread` which natively handles
    ///      EXIF orientation, so the output panorama reads upright.
    ///   4. Emit the same state-event the AR delegate path emits so
    ///      the JS live band populates identically.
    ///
    /// Architecture note: this is structurally parallel to Android's
    /// `IncrementalStitcher.kt::processFrameAtPath`
    /// `batchKeyframeMode` branch (lines 573-627).  A follow-up
    /// should extract the dispatch (gate-eval + path-append + emit)
    /// into shared cpp/ so both platforms become 5-line wrappers
    /// around a single C++ entry point.
    @objc public func addBatchKeyframePath(
        path: String,
        pose: RNSARFramePose
    ) -> Bool {
        stateLock.lock()
        guard self.isRunning, self.batchKeyframeMode else {
            stateLock.unlock()
            return false
        }
        stateLock.unlock()

        // Pose-only gate evaluation — no pixel buffer, no plane.
        let decision = self.keyframeGate.evaluate(
            pose: pose,
            latchedPlane: nil
        )
        if !decision.accept {
            self.emitKeyframeRejectState(decision: decision)
            return false
        }

        // Append path + pose to the finalize lists.  Take the lock
        // briefly — these mutate state read by `finalize()`.
        stateLock.lock()
        self.keyframePaths.append(path)
        self.keyframePoses.append(pose.asDictionary())
        let count = self.keyframePaths.count
        stateLock.unlock()
        os_log(.fault, log: Self.diagLog,
               "[V16-batch-keyframe.js] accepted path #%d → %{public}@",
               Int32(count), path)
        self.emitBatchKeyframeAcceptedState(
            thumbnailPath: path,
            keyframeIndex: count - 1,
            keyframeCount: count,
            keyframeMax: self.keyframeGate.maxCount,
            isLandscape: pose.imageWidth >= pose.imageHeight
        )
        return true
    }

    /// V16 Phase 1 — emit a state event when a batch-keyframe is
    /// saved.  Carries the on-disk thumbnail path so JS can render it
    /// in LiveFrameStrip + advance the "Keyframes: N/M" pill.
    private func emitBatchKeyframeAcceptedState(
        thumbnailPath: String,
        keyframeIndex: Int,
        keyframeCount: Int,
        keyframeMax: Int,
        isLandscape: Bool
    ) {
        let state = IncrementalStateObject(
            panoramaPath: nil,
            width: 0,
            height: 0,
            acceptedCount: keyframeCount,
            outcome: .acceptedHigh,
            confidence: 1.0,
            overlapPercent: -1.0,
            processingMs: 0,
            isLandscape: isLandscape,
            paintedExtent: 0,
            panExtent: 0,
            keyframeMax: keyframeMax
        )
        stateLock.lock()
        self.lastState = state
        stateLock.unlock()
        var dict = state.asDictionary()
        // Extra fields the existing IncrementalState schema doesn't
        // carry — JS reads these directly from the userInfo blob.
        dict["batchKeyframeThumbnailPath"] = thumbnailPath
        dict["batchKeyframeIndex"] = keyframeIndex
        NotificationCenter.default.post(
            name: .retailensIncrementalStateUpdate,
            object: nil,
            userInfo: dict
        )
    }

    /// V16 Phase 1b.fix2 — deep-copy a CVPixelBuffer so it survives
    /// past ARKit's pool reuse window.  Apple's contract is that
    /// ARFrame.capturedImage is only valid inside the delegate
    /// scope; CFRetain alone doesn't extend the underlying
    /// IOSurface's lifetime.  This is the documented fix.
    ///
    /// Handles both planar (NV12 — ARKit default) and packed
    /// (BGRA) formats.  Returns nil on allocation failure.
    private static func deepCopyPixelBuffer(
        _ src: CVPixelBuffer
    ) -> CVPixelBuffer? {
        let format = CVPixelBufferGetPixelFormatType(src)
        let width = CVPixelBufferGetWidth(src)
        let height = CVPixelBufferGetHeight(src)

        // IOSurface-backed copy so cv::imread / Vision frameworks
        // can read the buffer without re-uploading.  Empty dict =
        // use default IOSurface attributes.
        let attrs: NSDictionary = [
            kCVPixelBufferIOSurfacePropertiesKey: NSDictionary(),
        ]
        var dst: CVPixelBuffer?
        let createStatus = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, format, attrs, &dst
        )
        guard createStatus == kCVReturnSuccess, let copy = dst else {
            return nil
        }

        let srcLock = CVPixelBufferLockBaseAddress(src, .readOnly)
        let dstLock = CVPixelBufferLockBaseAddress(copy, [])
        defer {
            CVPixelBufferUnlockBaseAddress(src, .readOnly)
            CVPixelBufferUnlockBaseAddress(copy, [])
        }
        guard srcLock == kCVReturnSuccess,
              dstLock == kCVReturnSuccess else {
            return nil
        }

        if CVPixelBufferIsPlanar(src) {
            let nPlanes = CVPixelBufferGetPlaneCount(src)
            for plane in 0..<nPlanes {
                guard
                    let srcBase =
                        CVPixelBufferGetBaseAddressOfPlane(src, plane),
                    let dstBase =
                        CVPixelBufferGetBaseAddressOfPlane(copy, plane)
                else { return nil }
                let srcStride =
                    CVPixelBufferGetBytesPerRowOfPlane(src, plane)
                let dstStride =
                    CVPixelBufferGetBytesPerRowOfPlane(copy, plane)
                let planeH =
                    CVPixelBufferGetHeightOfPlane(src, plane)
                if srcStride == dstStride {
                    memcpy(dstBase, srcBase, srcStride * planeH)
                } else {
                    let rowBytes = min(srcStride, dstStride)
                    for r in 0..<planeH {
                        memcpy(
                            dstBase.advanced(by: r * dstStride),
                            srcBase.advanced(by: r * srcStride),
                            rowBytes
                        )
                    }
                }
            }
        } else {
            // Packed (e.g. BGRA).
            guard let srcBase = CVPixelBufferGetBaseAddress(src),
                  let dstBase = CVPixelBufferGetBaseAddress(copy)
            else { return nil }
            let srcStride = CVPixelBufferGetBytesPerRow(src)
            let dstStride = CVPixelBufferGetBytesPerRow(copy)
            if srcStride == dstStride {
                memcpy(dstBase, srcBase, srcStride * height)
            } else {
                let rowBytes = min(srcStride, dstStride)
                for r in 0..<height {
                    memcpy(
                        dstBase.advanced(by: r * dstStride),
                        srcBase.advanced(by: r * srcStride),
                        rowBytes
                    )
                }
            }
        }
        return copy
    }

    /// Synthesise + emit a state event for a frame the keyframe gate
    /// rejected.  The native engine never sees the frame, so its own
    /// state machinery isn't invoked — but JS still wants the event
    /// so the status pill can update ("frame skipped, still 3/6").
    private func emitKeyframeRejectState(decision: KeyframeGateDecision) {
        // Pick the right outcome value for JS; defaults match the
        // intent (overlap-too-high vs cap-reached).
        let outcome: IncrementalOutcome
        switch decision.reason {
        case "max-reached":      outcome = .skippedKeyframeMaxReached
        case "overlap-too-high": outcome = .skippedKeyframeOverlap
        default:                 outcome = .skippedKeyframeOverlap
        }
        // Re-use the previous state's pan-extent / orientation fields
        // so the band overlay doesn't flicker when a reject lands.
        //
        // V16 A2 (post-2026-05-13-14:41:57 .ips):
        //   `self.lastState` is written from BOTH this method (main
        //   thread, reject path) AND the engine accept-path
        //   (workQueue, ~line 1908) — both under stateLock at the
        //   write site, but these reads were unprotected.  Pre-A2
        //   the reject rate was a few per second and the race was
        //   latent; A2's flow-based default raised it to ~50/s.  At
        //   that frequency the torn-pointer-on-class-ref race fires:
        //     T0  workQueue prepares new state, about to replace
        //         self.lastState
        //     T1  main thread loads self.lastState — sees OLD ref
        //     T2  workQueue writes new ref; ARC releases OLD
        //         (refcount → 0 → freed)
        //     T3  main thread's load completes; ARC tries to retain
        //         OLD ref → objc_retain on freed memory →
        //         EXC_BAD_ACCESS at frame 0 of emitKeyframeRejectState.
        //   Fix: hold stateLock for the read.  Cheap (microseconds);
        //   tighter scope than wrapping the whole function so we
        //   don't hold during the NotificationCenter post that
        //   follows.
        let prev: IncrementalStateObject?
        let acceptedCount: Int
        stateLock.lock()
        prev = self.lastState
        acceptedCount = self.engineAcceptedCount
        stateLock.unlock()
        let overlapPercent = (decision.newContentFraction >= 0)
            ? (1.0 - decision.newContentFraction) * 100.0
            : (prev?.overlapPercent ?? -1.0)
        let state = IncrementalStateObject(
            panoramaPath: nil,
            width: 0,
            height: 0,
            acceptedCount: acceptedCount,
            outcome: outcome,
            confidence: 0,
            overlapPercent: overlapPercent,
            processingMs: 0,
            isLandscape: prev?.isLandscape ?? false,
            paintedExtent: prev?.paintedExtent ?? 0,
            panExtent: prev?.panExtent ?? 0,
            keyframeMax: decision.maxCount
        )
        stateLock.lock()
        self.lastState = state
        stateLock.unlock()
        NotificationCenter.default.post(
            name: .retailensIncrementalStateUpdate,
            object: nil,
            userInfo: state.asDictionary()
        )
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
    /// reuse contract — see comments in RNSARSession).
    @objc public func consumeFrame(
        pixelBuffer: CVPixelBuffer,
        pose: RNSARFramePose
    ) {
        guard stateLock.try() else {
            // start/stop in flight — drop this frame.
            return
        }
        let hybrid = self.hybridEngine
        let slit = self.firstwinsEngine
        let isRunning = self.isRunning
        // V16 Phase 1 — capture batch-keyframe state under the lock so
        // the work-queue closure (or the synchronous reject below)
        // sees consistent ivars even if start/cancel races.
        let inBatchKeyframeMode = self.batchKeyframeMode
        let collector = self.keyframeCollector
        let rotationDegreesForBatch = self.keyframeRotationDegrees
        let exifOrientationForBatch = self.keyframeExifOrientation

        // V13.0c.1 — diagnostic translation logging.  Captures the
        // FIRST frame's world position, then logs delta from first
        // on every subsequent frame.  Throttled to every 5th call
        // to keep Console.app readable.  This data tells us how
        // much users physically translate during typical captures
        // before we commit to per-pixel depth correction (V13.0c.2+).
        //
        // Notes:
        //   • tx,ty,tz are in ARKit world coords (metres).
        //   • magnitudeM = √(Δtx² + Δty² + Δtz²) — total camera
        //     displacement from first frame.
        //   • If typical magnitudeM < 0.05 m (5 cm) → minimal
        //     translation, NCC alone may suffice.
        //   • If typical magnitudeM > 0.30 m (30 cm) → significant
        //     translation, per-depth correction essential.
        if isRunning {
            self.consumeFrameCounter += 1
            if !self.hasFirstFrameTranslation {
                self.firstFrameTx = pose.tx
                self.firstFrameTy = pose.ty
                self.firstFrameTz = pose.tz
                self.hasFirstFrameTranslation = true
                // V13.0c.1.1 — FAULT-level os_log under same subsystem
                // as V13.0b-gate so logs appear under either Console.app
                // filter (process-only or subsystem).
                os_log(.fault, log: Self.diagLog,
                       "[V13.0c-trans] first-frame world position tx=%.4f ty=%.4f tz=%.4f",
                       pose.tx, pose.ty, pose.tz)
            } else if self.consumeFrameCounter % 5 == 0 {
                let dx = pose.tx - self.firstFrameTx
                let dy = pose.ty - self.firstFrameTy
                let dz = pose.tz - self.firstFrameTz
                let mag = sqrt(dx * dx + dy * dy + dz * dz)
                os_log(.fault, log: Self.diagLog,
                       "[V13.0c-trans] #%d delta_t_world=(%+.4f,%+.4f,%+.4f) magnitude=%.4f m",
                       self.consumeFrameCounter, dx, dy, dz, mag)
            }
        }

        // V16 Phase 2 (C1 fix) — evaluate the pose-driven keyframe gate
        // BEFORE releasing stateLock.
        //
        // RCA: KeyframeGate is documented thread-unsafe (its C++ pImpl
        // holds std::optional<std::vector<Vec2>>, etc.; caller must
        // serialise).  Every OTHER access already runs under stateLock —
        // `start`'s configure-gate path, `cancel`'s `keyframeGate.reset()`,
        // `markNextFrameAsLastKeyframe`'s `forceAcceptNext = true` write.
        // ONLY this read site (the AR-delegate hot path) used to run
        // OUTSIDE stateLock, which is a thread-safety hole — concurrent
        // mutation from the JS-bridge thread could corrupt the gate's
        // internal vectors mid-evaluate().
        //
        // We compute the decision under the lock, then unlock BEFORE the
        // heavier work (emitKeyframeRejectState fires a JS event; the
        // workQueue dispatch + JPEG encode + path-append happen below).
        // Holding the lock for the ~50–200 µs evaluate is negligible vs
        // the alternative (latent corruption that produced the V16
        // Phase 1b finalize crashes).
        //
        // We evaluate BEFORE the workInFlight check so a rejected frame
        // doesn't burn workQueue slots — the gate is the cheap filter,
        // the engine is the expensive one.
        var gateDecision: KeyframeGateDecision? = nil
        // V16 — eval-throttle.  When flowEvalEveryNFrames > 1, run the
        // gate every Nth consumeFrame instead of every frame.  Cuts
        // CPU on the AR delegate path linearly with N at the cost of
        // up to N-1 frames of acceptance latency.  Doesn't change
        // WHICH frames are accepted — just when we check.
        //
        // `consumeFrameCounter` was already incremented above (line
        // ~1596) so the first frame (counter=1) is always evaluated
        // regardless of N: (1-1) % N == 0 for any N ≥ 1.  Subsequent
        // evals land on counter = 1+N, 1+2N, ... — first frame
        // triggers immediately, then every Nth one after.
        let evalCadence = max(1, self.keyframeGate.flowEvalEveryNFrames)
        let cadenceFires = ((self.consumeFrameCounter - 1) % evalCadence == 0)
        let gateActive =
            isRunning
            && (hybrid != nil || slit != nil || inBatchKeyframeMode)
            && self.keyframeGate.enabled
        let shouldEvaluateGate = gateActive && cadenceFires
        // True iff the gate is active for this capture but we're
        // skipping THIS specific frame due to the throttle.  In that
        // case we must also skip the workQueue save path below —
        // otherwise non-Nth frames would be unconditionally saved as
        // keyframes, which would defeat the gate entirely.
        let throttledThisFrame = gateActive && !cadenceFires
        if shouldEvaluateGate {
            let plane = RNSARSession.shared.latchedPlaneTransform()
            // V16 A2 — call the pixel-buffer-aware overload so Flow
            // strategy gets the image content.  Pose strategy is
            // routed to the fast pose-only path inside the bridge,
            // so we don't pay the buffer-lock cost for Pose frames.
            gateDecision = self.keyframeGate.evaluate(
                pose: pose,
                latchedPlane: plane,
                pixelBuffer: pixelBuffer
            )
        }
        stateLock.unlock()

        // V16 eval-throttle bail.  If the gate is active but we
        // skipped evaluation for this frame, drop the entire save
        // pipeline.  We emit no event and don't burn the workQueue
        // slot — the next AR-delegate frame that lands on the
        // cadence will go through normally.
        if throttledThisFrame {
            return
        }

        // 2026-05-15 — `[V16-keyframe-decision]` per-decision diag log
        // removed.  Original commit 9dd0ae9 (formerly 7664d5a pre-
        // author-rewrite) added a fault-level os_log on every gate
        // decision (accept + reject) to investigate the post-fix-7
        // bursting.  Root cause was identified + fixed in fix-9/10/11
        // (see 2026-05-12-finalize-crash-investigation.md, Round 3).
        // The log was noise after that; removing it keeps the
        // fault-level Console output clean.  Reject-path decisions
        // still emit via emitKeyframeRejectState() below for UI pill
        // text; accept-path decisions emit via the keyframeAccepted
        // path and the JS state subscriber.

        // V16 Phase 1 — batch-keyframe is also a valid running mode
        // (no engine pointer, but the collector and gate are active).
        guard isRunning,
              (hybrid != nil || slit != nil || inBatchKeyframeMode)
        else { return }

        // Surface the gate's reject decision (if any) outside the lock.
        // emitKeyframeRejectState dispatches a JS bridge event which
        // could itself acquire other locks; keeping it outside stateLock
        // is the safe call.
        if let decision = gateDecision, !decision.accept {
            self.emitKeyframeRejectState(decision: decision)
            return
        }

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

        // V16 Phase 1b.fix2 — DEEP COPY of the pixel buffer.
        //
        // Apple's contract on ARFrame.capturedImage: "valid only
        // within the scope of the captured ARFrame.  To use beyond
        // that scope you must make a copy."  Swift's `let pbCopy =
        // pixelBuffer` is JUST an ARC retain on the CVPixelBufferRef;
        // it does NOT extend the lifetime of the underlying IOSurface.
        // ARKit's pixel-buffer pool (~3–4 buffers) recycles slots
        // aggressively under load — long pans race the workQueue's
        // 50–100 ms JPEG encode against pool churn and randomly hit
        // a freed slot, producing the EXC_BAD_ACCESS in objc_retain
        // we saw mid-pan ("when I pan the device more").
        //
        // CVPixelBufferCreate + memcpy gives us a fully-owned copy
        // that ARC alone governs.  ~1-2 ms cost on iPhone 16 Pro
        // (10 MB memcpy at memory bandwidth ~10 GB/s).  Fixes the
        // crash for ALL engine paths (slit-scan / hybrid / batch-
        // keyframe) since they all dispatch via consumeFrame.
        guard let pbCopy = Self.deepCopyPixelBuffer(pixelBuffer) else {
            // Allocation failure — drop the frame.  Extremely rare;
            // would only happen under genuine OOM.
            os_log(.fault, log: Self.diagLog,
                   "[V16-pbcopy] CVPixelBufferCreate failed; dropping frame")
            self.workInFlight = false
            return
        }
        workQueue.async { [weak self] in
            defer { self?.workInFlight = false }
            guard let self = self else { return }

            // V12.1 frame-leak fix: finalize/cancel may have run on
            // the JS thread between consumeFrame's isRunning check
            // and now.  If isRunning is now false, this frame would
            // have been dispatched a few ms BEFORE the user released
            // the shutter — ingesting it now is exactly the
            // "phantom frame after release" the user observed.  Bail
            // before touching the engine.
            self.stateLock.lock()
            let stillRunning = self.isRunning
            self.stateLock.unlock()
            guard stillRunning else { return }

            // V16 Phase 1 — batch-keyframe path: save the buffer as
            // a JPEG via the collector, append the pose, emit a
            // notification so JS can render the thumbnail in
            // LiveFrameStrip.  No incremental engine to call.
            if inBatchKeyframeMode {
                guard let coll = collector else { return }
                do {
                    let record = try coll.saveKeyframe(
                        pbCopy,
                        rotationDegrees: rotationDegreesForBatch,
                        exifOrientation: exifOrientationForBatch,
                        jpegQuality: 80
                    )
                    self.stateLock.lock()
                    self.keyframePaths.append(record.path)
                    self.keyframePoses.append(pose.asDictionary())
                    let count = self.keyframePaths.count
                    self.stateLock.unlock()
                    os_log(.fault, log: Self.diagLog,
                           "[V16-batch-keyframe] saved keyframe %d → %{public}@ (%dx%d)",
                           Int32(count),
                           record.path,
                           Int32(record.width), Int32(record.height))
                    self.emitBatchKeyframeAcceptedState(
                        thumbnailPath: record.path,
                        keyframeIndex: Int(record.index),
                        keyframeCount: count,
                        keyframeMax: self.keyframeGate.maxCount,
                        isLandscape: pose.imageWidth >= pose.imageHeight
                    )
                } catch let err as NSError {
                    os_log(.fault, log: Self.diagLog,
                           "[V16-batch-keyframe] saveKeyframe failed: %{public}@",
                           err.localizedDescription)
                }
                return
            }

            // V15.0b — if a vertical plane has just been detected and
            // we haven't propagated it to the slit-scan engine yet,
            // do so now.  Propagated only once per latched plane;
            // RNSARSession resets on stop().
            if !self.havePropagatedPlane,
               let plane = RNSARSession.shared.planeTransformFlat() {
                slit?.setPlaneTransformFlat(plane)
                self.havePropagatedPlane = true
                // V15.0c.4 — fault log so we can see the propagation
                // moment without rate-limit drops.
                os_log(.fault, log: Self.diagLog,
                       "[V15.0b-plane] bridge propagated plane to slit-scan engine (one-shot per capture)")
            }

            let telemetry: RLISFrameTelemetry
            if let hybrid = hybrid {
                telemetry = hybrid.ingest(
                    pixelBuffer: pbCopy, qx: pose.qx, qy: pose.qy, qz: pose.qz, qw: pose.qw,
                    tx: pose.tx, ty: pose.ty, tz: pose.tz,
                    fx: pose.fx, fy: pose.fy, cx: pose.cx, cy: pose.cy,
                    imageWidth: pose.imageWidth, imageHeight: pose.imageHeight,
                    yaw: yaw, pitch: pitch,
                    fovHorizDegrees: fovHDeg, fovVertDegrees: fovVDeg,
                    trackingPoor: trackingPoor
                )
            } else if let slit = slit {
                // V13.0e — slit-scan engine consumes tx/ty/tz for
                // ORB-triangulation-based depth estimation and per-frame
                // translation parallax correction.  Hybrid passes them
                // for API symmetry; only the slit engine uses them.
                telemetry = slit.ingest(
                    pixelBuffer: pbCopy, qx: pose.qx, qy: pose.qy, qz: pose.qz, qw: pose.qw,
                    tx: pose.tx, ty: pose.ty, tz: pose.tz,
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
        let outcome = IncrementalOutcome(rawValue: telemetry.outcome.rawValue)
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

        // V16 — pass the gate's max keyframe count when the gate is
        // active so JS can render "Keyframes: n/max".  Zero signals
        // "gate disabled" to the JS pill.
        let kfMax = self.keyframeGate.enabled ? self.keyframeGate.maxCount : 0
        let state = IncrementalStateObject(
            panoramaPath: snapshotPath,
            width: snapW,
            height: snapH,
            acceptedCount: hybrid?.acceptedCount ?? slit?.acceptedCount ?? 0,
            outcome: outcome,
            confidence: telemetry.confidence,
            overlapPercent: telemetry.overlapPercent,
            processingMs: telemetry.processingMs,
            isLandscape: telemetry.isLandscape,
            paintedExtent: telemetry.paintedExtent,
            panExtent: telemetry.panExtent,
            keyframeMax: kfMax
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

@objc public protocol ARFrameConsumer: AnyObject {
    /// Called on the ARSession delegate's queue.  The pixel buffer is
    /// only valid for the duration of this call (Apple's ARKit pool
    /// reuse contract); consumers must copy out before returning.
    func consumeFrame(pixelBuffer: CVPixelBuffer, pose: RNSARFramePose)
}

extension IncrementalStitcher: ARFrameConsumer {}
