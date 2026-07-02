// SPDX-License-Identifier: Apache-2.0
//
// IncrementalStitcher — Swift-side engine for the live
// panorama-stitching pipeline introduced in
// docs/site-content/design/2026-04-30-realtime-incremental-stitching.md.
//
// What this file does:
//   - Orchestrates the batch-keyframe capture pipeline: a pose/flow
//     keyframe gate selects frames, an OpenCVKeyframeCollector saves
//     them as JPEGs, and finalize() hands the set to
//     `OpenCVStitcher.stitchFramePaths` for one-shot stitching.
//   - Subscribes to `RNSARSession`'s per-frame ARFrame delivery
//   - Converts ARKit pose → yaw/pitch + horizontal FoV
//   - Posts state updates as Notifications so the RN bridge can fan
//     them out to JS as device events
//
// History: the live incremental engines (`OpenCVIncrementalStitcher`
// hybrid + `OpenCVFirstWinsCylindricalStitcher` slit-scan) were
// archived; only the batch-keyframe path remains.
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

/// Public outcome enum so JS callers can inspect what happened to
/// each frame.  Values 0-6 historically mirrored the (now-archived)
/// live-engine outcome codes; values 7+ are emitted from the Swift
/// gate layer (KeyframeGate).  Keep numeric values in lockstep with
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
    /// V12.12 — detected physical orientation.  In the batch-keyframe
    /// path it's derived from the saved keyframe's pixel dimensions
    /// (imageWidth >= imageHeight).  See incremental.ts for the full
    /// rationale (single source of truth across SDK + host).
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
    /// Always true now that the live engines are archived; retained
    /// so the finalize closure's branch structure stays explicit.
    let inBatchKeyframeMode: Bool
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
    /// 2026-05-22 (audit F2) — resolved stitcher mode for this finalize
    /// pass.  String form ("panorama" / "scans") matches Android's
    /// JNI string and the Obj-C++ method signature.  'auto' is
    /// resolved upstream by `resolveStitchModeAuto` before this snapshot
    /// is captured; this field never carries 'auto'.
    let batchStitchModeResolved: String
    /// Gyro rotation magnitude (radians) of the capture — surfaced to JS for the
    /// dev 3-tab preview's rRadians readout (threshold tuning).  0.0 when there
    /// is no pose-derived rotation signal (non-AR with no poses).
    let rRadians: Double
    /// Translation magnitude (metres) + the auto decision ratio
    /// (tScore/(tScore+rScore), >=0.55 → SCANS) that drove the panorama-vs-SCANS
    /// choice — surfaced to JS for the dev tuning readout alongside rRadians.
    let tMeters: Double
    let decisionRatio: Double
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
        label: "io.imagestitcher.incremental.stitcher",
        qos: .userInitiated
    )

    /// 2026-05-16 — dedicated queue for the async refinement run
    /// driven by the explicit JS `refinePanorama(...)` API.  Kept
    /// SEPARATE from `workQueue` so the next capture's start/
    /// consumeFrame path isn't gated on a prior 2-5 s cv::Stitcher
    /// run — the design doc explicitly calls out "operator can
    /// continue browsing / starting another capture during
    /// refinement".
    ///
    /// Serial: at most one refinement runs at a time (the design's
    /// "cancellation semantics if a new capture starts mid-refine"
    /// is out of scope for this MVP — see prompt's "deliberately out
    /// of scope" list).
    private let refineQueue = DispatchQueue(
        label: "io.imagestitcher.incremental.refine",
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

    /// F8.3 — gate for `consumeFrameFromPlugin` (the vision-camera
    /// Frame Processor producer-thread entry point).  TRUE only when
    /// the current capture was started with
    /// `frameSourceMode == "frameProcessor"`.  In AR mode
    /// (`frameSourceMode == "arSession"`) the plugin would double-feed
    /// the engine alongside ARKit's `consumeFrame` delegate path —
    /// pixel buffers from the producer thread + pixel buffers from the
    /// ARSession delegate, racing on the same workQueue — so we drop
    /// the producer-thread call.
    ///
    /// Set under `stateLock` in `start()`, cleared under `stateLock`
    /// in `cancel()` and `finalize()`, ALSO read under `stateLock`
    /// from `consumeFrameFromPlugin`.  The lock-protected read is
    /// the simplest correctness story under Swift's
    /// implementation-defined memory model — an earlier draft did an
    /// unlocked read on the assumption "Bool loads are atomic on
    /// arm64", but that's only true for the *instruction*, not for
    /// compiler reordering / CSE if the property dispatch ever
    /// changes from `@objc` (Obj-C dynamic, opaque to the optimiser)
    /// to a Swift-only call (where the load could be hoisted).
    /// Adversarial-review H1.
    @objc public private(set) var frameProcessorIngestEnabled: Bool = false

    /// V16 — pose-driven keyframe gate.  When `enabled` (set from the
    /// JS `frameSelectionMode = "pose-based"` config), each ARFrame is
    /// projected onto the latched ARKit plane and accepted only when
    /// it has ≥ `overlapThreshold` of NEW content vs the last
    /// accepted keyframe.  Bounded to `maxCount` keyframes per
    /// capture.  See KeyframeGate.swift for the full rationale.
    private let keyframeGate = KeyframeGate()

    /// V16 Phase 1 — the batch-keyframe pipeline (the only surviving
    /// engine mode): we accumulate the gate-accepted frames as on-disk
    /// JPEGs + their poses, then on `finalize` hand them to
    /// `OpenCVStitcher.stitchFramePaths` (the full feature-matched
    /// BA + ExposureCompensator + GraphCutSeamFinder + MultiBandBlender
    /// pipeline) for one-shot stitching.  This defers all stitching
    /// until shutter release so the global-stage quality wins (BA,
    /// multi-band) become available.
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
    /// 2026-05-22 (audit F2) — cv::Stitcher pipeline mode for the
    /// batch finalize.  Mirrors Android's `batchStitchMode` (kt:187).
    /// Valid values: 'auto' / 'panorama' / 'scans'.  'auto' is
    /// resolved at finalize time via [resolveStitchModeAuto] using
    /// the translation/rotation magnitudes between first + last
    /// accepted keyframe poses.  Default 'auto'.
    private var batchStitchMode: String = "auto"
    /// 2026-05-22 (audit F2) — first + last accepted keyframe poses
    /// in the current batch capture.  7 doubles each: [tx, ty, tz,
    /// qx, qy, qz, qw].  Both nil until at least one keyframe has
    /// been accepted.  Reset on every start().  Used only by the
    /// auto-resolver; the keyframe-gate's own pose tracking lives
    /// separately in cpp/keyframe_gate.cpp.
    private var batchFirstAcceptedPose: [Double]? = nil
    private var batchLastAcceptedPose: [Double]? = nil
    /// 2026-05-22 (audit F2b) — JS-measured cumulative IMU translation
    /// magnitude in METRES, set by the bridge at finalize time.  Used
    /// by the auto-resolver as a fallback translation signal in non-
    /// AR mode (where pose-derived tx/ty/tz is always 0).  Set to 0
    /// at start() and overwritten at finalize() entry.
    private var batchImuTranslationMetres: Double = 0.0
    /// 2026-06-16 — the explicit lens the user selected ('1x' | '0.5x'), set at
    /// finalize() entry from JS.  The zoom signal for the high-level warper tree
    /// (0.5x ultra-wide → spherical).  Defaults to '1x'.
    private var batchLens: String = "1x"
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

    // ── v0.21 — pick-sharpest-in-window anti-blur selection state ──
    /// K — total candidate frames per accepted keyframe (the gate-
    /// accepted frame itself + up to K−1 subsequent gate-EVALUATED
    /// frames).  From JS config `sharpnessWindow`; clamped [1, 10].
    /// Default 4.  1 = feature off (immediate save, pre-v0.21
    /// behaviour byte-for-byte).  Only consulted when the keyframe
    /// gate is enabled — the time-based passthrough saves every frame
    /// and has no meaningful "window" to select within.
    private var sharpnessWindowK: Int = 4
    /// Candidate slots left in the currently-open window.  0 = closed.
    private var sharpnessWindowRemaining: Int = 0
    /// Streaming max — ONLY the best candidate so far is buffered
    /// (deep-copied CVPixelBuffer + its pose + its score), never all K
    /// frames.  Bound: one extra frame of memory per capture.
    private var sharpnessBestBuffer: CVPixelBuffer? = nil
    private var sharpnessBestPose: RNSARFramePose? = nil
    private var sharpnessBestScore: Double = -1.0

    private override init() {
        super.init()
        // F8.3.H2 — runtime check that Swift's auto-bridged ObjC
        // selector for `consumeFrameFromPlugin(...)` matches the
        // selector string the plugin's .mm dispatches.  Asserts in
        // dev builds; no-ops in release.  See the
        // `_consumeFrameFromPluginSelectorPin` declaration below for
        // the full rationale.
        IncrementalStitcher._verifyConsumeFrameFromPluginSelector()
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

    /// 2026-05-22 (audit F2b) — JS calls this at finalize() entry to
    /// hand over the cumulative IMU translation magnitude in METRES.
    /// Stored in batchImuTranslationMetres for the auto-resolver to
    /// consume in non-AR mode (where pose-derived translation is 0).
    /// 0.0 is the back-compat default (resolver falls back to pose
    /// translation; PANORAMA when both are 0).
    @objc public func updateImuTranslationMetres(_ metres: Double) {
        stateLock.lock()
        self.batchImuTranslationMetres = max(0.0, metres)
        stateLock.unlock()
    }

    /// 2026-06-16 — store the explicit lens ('1x' | '0.5x') JS supplies at
    /// finalize() entry; the high-level warper tree reads it (0.5x → spherical).
    @objc public func updateLens(_ lens: String) {
        stateLock.lock()
        self.batchLens = lens
        stateLock.unlock()
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
        // 2026-05-18 (Issue #2 regression fix): "arSession" (default)
        // registers as the ARSession's frame consumer.
        // "frameProcessor" skips that registration — frames come in
        // via the vision-camera Frame Processor plugin's
        // `consumeFrameFromPlugin` path instead.  The pre-v0.6
        // "jsDriver" mode (push frames in from JS via
        // processFrameAtPath) has been removed.
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
        // Engine mode: only the batch-keyframe pipeline survives.  The
        // live incremental engines ('hybrid', 'slitscan-*', and the
        // legacy 'firstwins*' aliases) were archived — any non-batch
        // `engineMode` now falls back to batch-keyframe so existing JS
        // callers keep working.
        if engineMode != "batch-keyframe" {
            NSLog("[bridge] DEPRECATED engine '\(engineMode)' — live engines archived, using batch-keyframe")
        }

        do {
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
            // 2026-05-22 (audit F2) — read stitchMode from JS.  Pre-
            // audit, iOS hardcoded Panorama at OpenCVStitcher.mm:436
            // regardless of the JS setting.  Now mirrors Android's
            // batchStitchMode + auto-resolver heuristic.  Validate
            // against the closed set; unknown values fall back to 'auto'.
            let rawMode = (configOverrides["stitchMode"] as? String) ?? "auto"
            self.batchStitchMode =
                (["auto", "panorama", "scans"].contains(rawMode))
                ? rawMode : "auto"
            // Reset accumulated-pose state for the new capture so
            // finalize() picks a fresh mode.
            self.batchFirstAcceptedPose = nil
            self.batchLastAcceptedPose = nil
            // 2026-05-22 (audit F2b) — reset IMU translation snapshot
            // too.  Updated at finalize() entry from JS-supplied
            // option value.
            self.batchImuTranslationMetres = 0.0
            self.batchLens = "1x"  // overwritten at finalize() from JS (updateLens)
            self.batchKeyframeMode = true
            os_log(.fault, log: Self.diagLog,
                   "[V16-batch-keyframe] start mode=batch-keyframe rotation=0 (was %d, forced to 0 to match pose intrinsics) sessionDir=%{public}@",
                   frameRotationDegrees,
                   self.keyframeCollector?.sessionDir ?? "(nil)")
        }
        self.isRunning = true
        // F8.3 — enable the Frame Processor plugin's producer-thread
        // ingest only for the new "frameProcessor" mode.  AR mode
        // ("arSession") keeps it OFF; see the ivar's declaration
        // comment for why.
        self.frameProcessorIngestEnabled = (frameSourceMode == "frameProcessor")
        self.snapshotJpegQuality = max(1, min(100, snapshotJpegQuality))
        self.snapshotEveryNAccepts = max(1, snapshotEveryNAccepts)
        self.acceptsSinceSnapshot = 0
        self.droppedBackpressure = 0
        self.lastState = nil
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
        // 2026-05-22 (audit F1b) — non-AR-mode opt-out for the angular-
        // delta fallback.  iOS parity with Android IncrementalStitcher.kt:461.
        // captureSource = 'non-ar' means the host is using vision-camera
        // (no ARKit pose) — disable the gate's angular fallback so it
        // doesn't compute on gyro-drift-driven garbage pose.  Without
        // this opt-out, gyro drift accumulates past the overlap
        // threshold even on a stationary camera → near-identical
        // frames get accepted → cv::Stitcher's camera-param estimator
        // goes degenerate → "warpRoi too large (9581×12332) — estimator
        // produced degenerate camera params" crash on finalize.
        // Pre-audit iOS had this bug because the Swift facade had no
        // disableAngularFallback property at all — the C++ setter
        // existed but nothing on iOS ever called it.
        let captureSource = (configOverrides["captureSource"] as? String) ?? "ar"
        self.keyframeGate.disableAngularFallback = (captureSource == "non-ar")
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
        // v0.21 — pick-sharpest-in-window anti-blur keyframe selection.
        // K = total candidates per gate-accept (the accepted frame + up
        // to K−1 subsequent evaluated frames); the SHARPEST of the K is
        // the frame that actually gets saved.  1 = off (immediate save,
        // pre-v0.21 behaviour).  Default 4 when the key is ABSENT — a
        // deliberate behaviour change: existing callers gain anti-blur
        // selection without opting in (accepting up to K−1 evaluated
        // frames of extra save latency per keyframe).  Clamp [1, 10].
        if let v = configOverrides["sharpnessWindow"] as? Int {
            self.sharpnessWindowK = max(1, min(10, v))
        } else if let v = configOverrides["sharpnessWindow"] as? Double {
            self.sharpnessWindowK = max(1, min(10, Int(v)))
        } else {
            self.sharpnessWindowK = 4
        }
        // Drop any window state a previous capture left behind.
        self.sharpnessWindowRemaining = 0
        self.sharpnessBestBuffer = nil
        self.sharpnessBestPose = nil
        self.sharpnessBestScore = -1.0
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
        // Wall-clock keyframe-interval budget, in MILLISECONDS.  When
        // > 0, the gate force-accepts a frame once this much time has
        // elapsed since the last accepted keyframe (applies to BOTH
        // Pose and Flow strategies).  Passed straight through — the JS
        // value is already in ms (no cm→m style conversion).  Clamp to
        // ≥ 0 (the bridge/C++ re-clamps too).  Default 2000 ms when the
        // key is absent (NOT 0 — time-budget acceptance is on by
        // default so a stalled scan still advances).
        if let v = configOverrides["maxKeyframeIntervalMs"] as? Double {
            self.keyframeGate.maxKeyframeIntervalMs = max(0.0, v)
        } else if let v = configOverrides["maxKeyframeIntervalMs"] as? Int {
            self.keyframeGate.maxKeyframeIntervalMs = max(0.0, Double(v))
        } else {
            self.keyframeGate.maxKeyframeIntervalMs = 1500.0
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
               "[V16-keyframe] start gate enabled=%d strategy=%{public}@ thr=%.2f max=%d maxKfIntervalMs=%.0f flow(maxCorners=%d quality=%.3f minDist=%.1f maxTransCm=%.1f pctile=%.2f evalEveryN=%d)",
               self.keyframeGate.enabled ? 1 : 0,
               self.keyframeGate.strategy == .flow ? "flow" : "pose",
               self.keyframeGate.overlapThreshold,
               self.keyframeGate.maxCount,
               self.keyframeGate.maxKeyframeIntervalMs,
               self.keyframeGate.flowMaxCorners,
               self.keyframeGate.flowQualityLevel,
               self.keyframeGate.flowMinDistance,
               self.keyframeGate.flowMaxTranslationCm,
               self.keyframeGate.flowNoveltyPercentile,
               Int32(self.keyframeGate.flowEvalEveryNFrames))

        stateLock.unlock()

        // Register with the AR session's consumer registry — ONLY
        // for AR mode.  Other modes don't need it:
        //
        //   * `arSession`      — REGISTER.  ARKit's frame delegate
        //                        (RNSARSession.swift:572) calls
        //                        `consumer.consumeFrame(...)`.
        //   * `frameProcessor` — DO NOT register.  The vision-
        //                        camera plugin calls us directly via
        //                        `consumeFrameFromPlugin`; we own
        //                        the camera, ARKit is intentionally
        //                        stopped.  Registering here would
        //                        let any sibling code that briefly
        //                        starts an `ARSession` mid-capture
        //                        (analytics SDK, future "AR preview"
        //                        toggle, etc.) silently feed frames
        //                        in parallel with our producer-
        //                        thread plugin, racing on
        //                        `stateLock.try()` and corrupting
        //                        the gate's novelty math.
        //                        (Adversarial-review C1.)
        //
        // The pre-v0.6 `jsDriver` mode (which pushed frames via
        // `processFrameAtPath` and also skipped registration) has
        // been removed.
        if frameSourceMode == "arSession" {
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
    /// after the user thought they had released.  The batch-keyframe
    /// state and isRunning flag are flipped SYNCHRONOUSLY here so the
    /// AR delegate's very next consumeFrame sees isRunning=false.
    /// The work-queue body just runs the one-shot stitch.
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
        let inBatchKeyframeMode = self.batchKeyframeMode
        let collector = self.keyframeCollector
        var paths = self.keyframePaths
        // v0.21 — sharpness-window snapshot: if a window is still open
        // (the LAST accepted keyframe is typically waiting in it),
        // take its buffered best under this same lock and clear the
        // window state.  Saved synchronously right after unlock (the
        // async flush path can't run here: isRunning flips false in
        // this section, which makes the workQueue save body bail).
        let sharpnessFlushBuffer = self.sharpnessBestBuffer
        let sharpnessFlushPose = self.sharpnessBestPose
        self.sharpnessBestBuffer = nil
        self.sharpnessBestPose = nil
        self.sharpnessBestScore = -1.0
        self.sharpnessWindowRemaining = 0
        let rotationDegreesForFlush = self.keyframeRotationDegrees
        // V16 Phase 1b.fix4 — snapshot the cv::Stitcher knobs and
        // EXIF orientation under stateLock so the workQueue closure
        // has a stable view of these values, independent of any
        // concurrent start() that may begin a new capture before
        // this closure finishes.
        //
        // Why this matters (RCA from Sentry crashes 2026-05-09
        // 21:59-22:03, all 3 .ips traces):
        //   EXC_BAD_ACCESS at objc_retain+16, frame 1 = closure #1
        //   in finalize+2648, queue = io.imagestitcher.incremental.
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
        self.batchKeyframeMode = false
        self.keyframeCollector = nil
        self.keyframePaths = []
        self.keyframePoses = []
        self.isRunning = false
        // F8.3 — disable the Frame Processor plugin's producer-thread
        // ingest at the SAME lock-protected moment we flip isRunning,
        // so any in-flight producer-thread frame either sees both
        // (and proceeds with a now-doomed call that consumeFrame
        // drops via its own !isRunning guard) or sees neither (and
        // skips entirely).
        self.frameProcessorIngestEnabled = false
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
        // v0.21 — synchronous sharpness-window flush (snapshot taken
        // under stateLock above).  One JPEG encode (~50-100 ms), once
        // per capture, ahead of the multi-second stitch.  The recorded
        // pose is the BEST frame's pose — it matches the saved pixels,
        // so the stitch-mode auto-resolver sees consistent data.  No
        // accepted-state event is emitted this late; the JS side is
        // already tearing down the capture UI, and the finalize result
        // carries the authoritative acceptedCount.
        if inBatchKeyframeMode,
           let flushBuffer = sharpnessFlushBuffer,
           let flushPose = sharpnessFlushPose,
           let coll = collector {
            // workQueue.sync — NOT a direct call: a window-full flush
            // dispatched moments ago could still be mid-JPEG-encode on
            // the work queue.  saveKeyframe on the same collector from
            // this thread would race its acceptedCount/filename
            // increment.  Serialising through the (serial) work queue
            // makes the in-flight save finish first; its own
            // stillRunning re-check happens at task START, so a task
            // already past it simply completes normally before ours
            // runs.  Same sync-on-workQueue pattern the stitch itself
            // uses below (V16 Phase 1b.fix6).
            workQueue.sync {
                do {
                    let record = try coll.saveKeyframe(
                        flushBuffer,
                        rotationDegrees: rotationDegreesForFlush,
                        exifOrientation: keyframeExifOrientation,
                        jpegQuality: 80
                    )
                    paths.append(record.path)
                    let poseArr = [flushPose.tx, flushPose.ty, flushPose.tz,
                                   flushPose.qx, flushPose.qy, flushPose.qz,
                                   flushPose.qw]
                    if batchFirstAcceptedPose == nil { batchFirstAcceptedPose = poseArr }
                    batchLastAcceptedPose = poseArr
                    os_log(.fault, log: Self.diagLog,
                           "[v0.21-sharpness] finalize flush saved keyframe → %{public}@",
                           record.path)
                } catch let err as NSError {
                    os_log(.fault, log: Self.diagLog,
                           "[v0.21-sharpness] finalize flush saveKeyframe failed: %{public}@",
                           err.localizedDescription)
                }
            }
        }

        let arWasRunning = inBatchKeyframeMode
            && RNSARSession.shared.isRunning
        let cleaned = (outputPath.hasPrefix("file://"))
            ? String(outputPath.dropFirst(7))
            : outputPath
        let q = max(1, min(100, jpegQuality))
        // 2026-05-22 (audit F2) — resolve 'auto' stitchMode now, while
        // we still have access to first/last pose ivars.  The resolver
        // mirrors Android's resolveStitchModeAuto (IncrementalStitcher.kt:1727):
        // translation/rotation magnitude ratio between first + last
        // accepted keyframe poses → SCANS (translation-heavy) or
        // PANORAMA (rotation-heavy).  Non-auto values pass through.
        // Resolve once so the dev readout gets the SAME tMeters / ratio / rRadians
        // that drove the decision — and gets them even when the mode is forced
        // (informative: shows what auto WOULD have picked).  Captured into the
        // payload here so the C2-invariant finalize closure can read them via
        // payload (no self/ivar access inside the closure).
        let autoResolution = resolveStitchModeAuto(
            first: batchFirstAcceptedPose,
            last:  batchLastAcceptedPose,
            imuTranslationMetres: batchImuTranslationMetres)
        let stitchModeResolved: String
        switch batchStitchMode {
        case "panorama": stitchModeResolved = "panorama"
        case "scans":    stitchModeResolved = "scans"
        default:         stitchModeResolved = autoResolution.mode
        }
        let rRadiansResolved = autoResolution.rRadians
        // 2026-06-16 — HIGH-LEVEL ACROSS THE BOARD (mirrors Android).  Pick the
        // warper from the (motion, Mode A/B, lens) tree; the dispatch below now
        // forces useManualPipeline=false + stitchMode="panorama".  batchWarperType
        // (settings) is superseded by the tree.
        let highLevelWarper = pickHighLevelWarper(
            orientation: captureOrientation,
            lens: batchLens)
        os_log(.fault, log: Self.diagLog,
               "[V16-batch-keyframe.stitchMode] configured=%{public}@ resolved=%{public}@ warper=%{public}@ lens=%{public}@ paths=%d imuT=%.3fm",
               batchStitchMode, stitchModeResolved, highLevelWarper, batchLens,
               Int32(paths.count), batchImuTranslationMetres)

        let payload = FinalizePayload(
            cleaned: cleaned,
            q: q,
            inBatchKeyframeMode: inBatchKeyframeMode,
            collector: collector,
            paths: paths,
            batchWarperType: highLevelWarper,
            batchBlenderType: batchBlenderType,
            batchSeamFinderType: batchSeamFinderType,
            batchEnableInscribedRectCrop: batchEnableInscribedRectCrop,
            batchStitchModeResolved: stitchModeResolved,
            rRadians: rRadiansResolved,
            tMeters: autoResolution.tMeters,
            decisionRatio: autoResolution.ratio,
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
        // io.imagestitcher.incremental.stitcher), which per the
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
                        // workstream, but the pose-driven stitch method
                        // has since been archived; the feature-matched
                        // path is the only one on the hot path.
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
                            useInscribedRectCrop: payload.batchEnableInscribedRectCrop,
                            // 2026-06-16 — HIGH-LEVEL ACROSS THE BOARD (mirrors
                            // Android): always cv::Stitcher PANORAMA with the
                            // tree-chosen warper (payload.batchWarperType is now
                            // highLevelWarper).  The manual path's OOM hardening
                            // was ported to high-level (catch ladder + two-phase
                            // canvas guard + RAM-aware compositingResol + spherical
                            // rescue), so this is now memory-safe.
                            stitchMode: "panorama",
                            useManualPipeline: false
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
                            // 2026-06-15 — the exact keyframe JPEG paths used for
                            // this stitch, so JS can re-stitch them ON DEMAND via
                            // refinePanorama (the high-level tab) without listing
                            // the session dir itself.
                            "batchKeyframePaths": payload.paths,
                            // The orientation this stitch baked into the output.
                            // The on-demand high-level re-stitch MUST pass the
                            // same value or it comes out in the raw sensor
                            // landscape (sideways) — refinePanorama otherwise
                            // defaults to "portrait" (no bake-rotation).
                            "captureOrientation": payload.captureOrientation,
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
                        // 2026-05-22 (audit F2g) — surface the
                        // auto-resolver's choice (or the operator's
                        // explicit setting) so JS can show "scans"/
                        // "panorama" on the output preview + debug
                        // toast.  Always set on the batch path —
                        // helps the operator understand why the
                        // panorama looks the way it does.
                        batchDict["stitchModeResolved"] = payload.batchStitchModeResolved
                        batchDict["rRadians"] = payload.rRadians
                        // Dev tuning readout — translation magnitude + the auto
                        // decision ratio that drove panorama-vs-SCANS.
                        batchDict["tMeters"] = payload.tMeters
                        batchDict["decisionRatio"] = payload.decisionRatio
                        // 2026-06-14 (DEV overlay) — the stitcher's runtime
                        // choices (pipeline/warper/route/seam/blend) for this
                        // output, shown on the preview in __DEV__.
                        if !r.debugSummary.isEmpty {
                            batchDict["debugSummary"] = r.debugSummary
                        }
                        completion(batchDict, nil)
                    } catch let stitchErr as NSError {
                        completion(nil, stitchErr)
                    }
                } else {
                    // Defensive: batch-keyframe is the only pipeline,
                    // so a non-batch finalize means no capture was
                    // active (start() was never called or already torn
                    // down).
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

    /// 2026-05-16 — refine entry point.  Runs the shared C++ stitcher
    /// over the supplied keyframe JPEGs and writes a refined panorama
    /// to `outputPath`.
    ///
    /// Called by the bridge layer (explicit JS `refinePanorama(...)`
    /// API) to re-stitch a saved keyframe set at higher quality.
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
        // v0.10.0 #15A — emit `validating` at the very top so JS sees
        // refine activity even when validation fails fast.  Frames may
        // be empty here; report whatever the caller asked for.
        emitRefineProgress(
            stage: "validating",
            fraction: 0.05,
            frames: framePaths.count,
            errorMessage: nil
        )
        guard framePaths.count >= 2 else {
            let msg = "refinePanorama requires at least 2 framePaths (got \(framePaths.count))."
            emitRefineProgress(
                stage: "error",
                fraction: 1.0,
                frames: framePaths.count,
                errorMessage: msg
            )
            completion(nil, NSError(
                domain: "RNImageStitcherIncremental",
                code: 9101,
                userInfo: [NSLocalizedDescriptionKey: msg]
            ))
            return
        }
        let fm = FileManager.default
        for p in framePaths {
            let cleaned = p.hasPrefix("file://") ? String(p.dropFirst(7)) : p
            if !fm.fileExists(atPath: cleaned) {
                let msg = "refinePanorama: keyframe missing on disk — \(cleaned)"
                emitRefineProgress(
                    stage: "error",
                    fraction: 1.0,
                    frames: framePaths.count,
                    errorMessage: msg
                )
                completion(nil, NSError(
                    domain: "RNImageStitcherIncremental",
                    code: 9102,
                    userInfo: [NSLocalizedDescriptionKey: msg]
                ))
                return
            }
        }
        let warper      = (config["warperType"] as? String) ?? "spherical"
        let blender     = (config["blenderType"] as? String) ?? "multiband"
        let seam        = (config["seamFinderType"] as? String) ?? "graphcut"
        let orientation = (config["captureOrientation"] as? String) ?? "portrait"
        let useInscribed = (config["useInscribedRectCrop"] as? Bool) ?? false
        // 2026-05-22 (audit F2) — refine path reads stitchMode too.
        // The refine flow doesn't have access to first/last accepted
        // pose ivars (this is a separate JS-driven entry point that
        // may be called against a saved keyframe set), so we accept
        // an explicit 'panorama' / 'scans' value here.  Default
        // 'scans' for the refine path since it's typically called on
        // shelf-scan captures (the slow-path quality bake where SCANS'
        // translation tolerance gives best results — see docstring
        // at line 738 of src/stitching/incremental.ts).  JS callers
        // can override by passing config["stitchMode"].
        let refineStitchMode = (config["stitchMode"] as? String) ?? "scans"
        // 2026-06-15 — pipeline is caller-selectable.  The on-demand high-level
        // tab calls refinePanorama with useManualPipeline:false to re-stitch the
        // captured keyframes via stock cv::Stitcher.  Default false (high-level)
        // preserves the refine path's historical cv::Stitcher behaviour.
        let refineManual = (config["useManualPipeline"] as? Bool) ?? false
        let quality     = max(1, min(100, (config["jpegQuality"] as? Int) ?? 90))
        let cleanedOutput = outputPath.hasPrefix("file://")
            ? String(outputPath.dropFirst(7))
            : outputPath

        os_log(.fault, log: Self.diagLog,
               "[refine] dispatch frames=%d output=%{public}@ warper=%{public}@ blender=%{public}@ seam=%{public}@",
               framePaths.count,
               cleanedOutput,
               warper, blender, seam)

        // v0.10.0 #15A — capture for the inner closure; `self` is
        // captured weakly so the progress emitter survives only as
        // long as the IncrementalStitcher itself does.  An emitter
        // call on a torn instance is a no-op via `?.`.
        let frameCount = framePaths.count
        refineQueue.async { [weak self] in
            self?.emitRefineProgress(
                stage: "stitching",
                fraction: 0.1,
                frames: frameCount,
                errorMessage: nil
            )
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
                    useInscribedRectCrop: useInscribed,
                    stitchMode: refineStitchMode,
                    useManualPipeline: refineManual
                )
                // fix-9 sentinel detection — see the finalize() path
                // for the full rationale.  A 0×0 result means
                // OpenCVStitcher hit one of its six guarded failure
                // returns; surface as a clean NSError.
                if r.width == 0 && r.height == 0 {
                    let msg = "refinePanorama: stitcher returned sentinel — see preceding [BatchStitcher] log for cause."
                    self?.emitRefineProgress(
                        stage: "error",
                        fraction: 1.0,
                        frames: frameCount,
                        errorMessage: msg
                    )
                    completion(nil, NSError(
                        domain: "RNImageStitcherIncremental",
                        code: 9107,
                        userInfo: [NSLocalizedDescriptionKey: msg]
                    ))
                    return
                }
                // Stitch succeeded — OpenCVStitcher writes the JPEG
                // internally before returning, so "writing" really
                // captures the final assembly + file I/O cost.  Emit
                // here so JS can flip its label from "Stitching" to
                // "Writing" before the done event fires.
                self?.emitRefineProgress(
                    stage: "writing",
                    fraction: 0.9,
                    frames: frameCount,
                    errorMessage: nil
                )
                self?.emitRefineProgress(
                    stage: "done",
                    fraction: 1.0,
                    frames: frameCount,
                    errorMessage: nil
                )
                // 2026-06-15 (DEV overlay A/B-aware) — carry the stitcher's
                // own runtime recipe up to JS so the preview's DEV pill shows
                // the HIGH-LEVEL recipe (pipe=highlevel;warp=spherical;…) while
                // the user views the high-level tab, instead of the manual
                // primary's recipe.  Mirrors the batch finalize's batchDict
                // (guard empty — empty string means unavailable).
                var refineDict: [String: Any] = [
                    "panoramaPath": r.outputPath,
                    "width": Int(r.width),
                    "height": Int(r.height),
                    "framesRequested": frameCount,
                    "framesIncluded": frameCount,
                    "framesDropped": 0,
                    "finalConfidenceThresh": -1.0,
                ]
                if !r.debugSummary.isEmpty {
                    refineDict["debugSummary"] = r.debugSummary
                }
                completion(refineDict, nil)
            } catch let err as NSError {
                self?.emitRefineProgress(
                    stage: "error",
                    fraction: 1.0,
                    frames: frameCount,
                    errorMessage: err.localizedDescription
                )
                completion(nil, err)
            }
        }
    }

    /// v0.10.0 #15A — emit a refine-pipeline phase update on the same
    /// `IncrementalStateUpdate` channel that carries `isRefining` /
    /// `refinedPanoramaPath`.  Five `stage` values fire across the
    /// lifetime of one `refinePanorama` call:
    ///
    ///   - `validating` (fraction 0.05) — synchronous input checks
    ///   - `stitching`  (fraction 0.10) — start of the OpenCV stitch
    ///   - `writing`    (fraction 0.90) — stitch returned, JPEG written
    ///   - `done`       (fraction 1.00) — completion handler invoked
    ///   - `error`      (fraction 1.00) — failure path (`errorMessage`
    ///                                    is non-nil)
    ///
    /// `fraction` is intentionally coarse: OpenCV's `Stitcher` doesn't
    /// expose stage-by-stage callbacks, so the 0.10 → 0.90 jump is a
    /// single opaque step.  JS uses the `stage` string for the UI
    /// label and `fraction` purely for spinner progress.
    ///
    /// Reuses the existing channel (rather than introducing a new
    /// device-event name) so the JS subscriber doesn't need to wire
    /// a second listener.  The payload preserves the lastState fields
    /// so the `isRefining` / `refinedPanoramaPath` sticky-merge logic
    /// on the JS side keeps working untouched.
    private func emitRefineProgress(
        stage: String,
        fraction: Double,
        frames: Int?,
        errorMessage: String?
    ) {
        // Disk-trail breadcrumb — every refine emit lands here so a
        // future regression can be diagnosed by pulling the bridge's
        // debug file without needing live Console.app access.
        IncrementalStitcher.fileLog(
            "[refine.progress] stage=\(stage) frac=\(fraction) frames=\(frames ?? -1) hasError=\(errorMessage != nil)"
        )
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
        dict["refineStage"] = stage
        dict["refineProgress"] = fraction
        if let f = frames {
            dict["refineFrames"] = f
        }
        if let e = errorMessage {
            dict["refineError"] = e
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
        let collector = self.keyframeCollector
        self.keyframeCollector = nil
        self.batchKeyframeMode = false
        self.keyframePaths = []
        self.keyframePoses = []
        self.isRunning = false
        // F8.3 — mirror the finalize() flip: cut producer-thread
        // ingest the moment we go !isRunning.
        self.frameProcessorIngestEnabled = false
        self.lastState = nil
        // V16 — reset the keyframe gate so the next start() begins
        // with a clean polygon state and counter.  Safe to do under
        // stateLock because the gate is only mutated from the AR
        // delegate (consumeFrame) and the JS thread (start/cancel
        // /markNextFrameAsLastKeyframe), all serialized via this lock.
        self.keyframeGate.reset()
        // v0.21 — discard any open sharpness window; the operator
        // aborted, so its buffered best belongs to a dead capture.
        self.sharpnessBestBuffer = nil
        self.sharpnessBestPose = nil
        self.sharpnessBestScore = -1.0
        self.sharpnessWindowRemaining = 0
        stateLock.unlock()
        RNSARSession.shared.incrementalConsumer = nil
        // Clean up on the work queue so we don't race with an in-flight
        // ingest that's still saving a keyframe.  Cancel removes the
        // collector's session directory — the operator explicitly
        // aborted, so the saved JPEGs aren't worth keeping for
        // re-processing.
        workQueue.async {
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

    /// V16 Phase 1 — emit a state event when a batch-keyframe is
    /// saved.  Carries the on-disk thumbnail path so JS can render it
    /// in LiveFrameStrip + advance the "Keyframes: N/M" pill.
    private func emitBatchKeyframeAcceptedState(
        thumbnailPath: String,
        keyframeIndex: Int,
        keyframeCount: Int,
        keyframeMax: Int,
        isLandscape: Bool,
        // v0.7.0 — Tier 1 hook fields.  `pose` is the AR pose at the
        // accept moment (gyro-synthesised in non-AR mode — translation
        // will read as ~zeros).  `acceptedAtMs` is wall-clock ms since
        // Unix epoch; matches `Date.now()` on the JS side.
        pose: RNSARFramePose,
        acceptedAtMs: Double
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
        // v0.7.0 — Tier 1 hook (useKeyframeStream) reads these.  See
        // `AcceptedKeyframe` in src/stitching/incremental.ts.  Translation
        // is always emitted; AR mode populates it from the camera
        // transform, non-AR mode reads ~zeros (gyro-only, no spatial
        // anchor).
        dict["batchKeyframePose"] = [
            "rotation": [pose.qx, pose.qy, pose.qz, pose.qw],
            "translation": [pose.tx, pose.ty, pose.tz],
        ] as [String: Any]
        dict["batchKeyframeAcceptedAtMs"] = acceptedAtMs
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
        // Batch-keyframe is the only running mode: the accepted count is
        // the gate's running keyframe tally (the live engines that used
        // to back `engineAcceptedCount` have been archived).
        acceptedCount = self.keyframeGate.acceptedCount
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
            && inBatchKeyframeMode
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

        // V16 Phase 1 — batch-keyframe is the only running mode now
        // (no engine pointer; the collector and gate are active).
        guard isRunning, inBatchKeyframeMode
        else { return }

        // Surface the gate's reject decision (if any) outside the lock.
        // emitKeyframeRejectState dispatches a JS bridge event which
        // could itself acquire other locks; keeping it outside stateLock
        // is the safe call.
        if let decision = gateDecision, !decision.accept {
            // v0.21 — pick-sharpest-in-window: a gate-rejected frame
            // that arrives while a window is open is a CANDIDATE for
            // the pending keyframe (the gate necessarily rejects the
            // frames right after an accept — novelty resets there, so
            // the window's candidates all flow through this branch).
            // Score it, keep it when it beats the buffered best, and
            // close the window (save the best) once the K−1 candidate
            // slots are used up.  No-op when no window is open.
            self.sharpnessWindowIngestCandidate(
                pixelBuffer: pixelBuffer,
                pose: pose,
                collector: collector
            )
            self.emitKeyframeRejectState(decision: decision)
            return
        }

        // v0.21 — gate-ACCEPTED frame with the sharpness window active
        // (gate enabled + K > 1): do NOT save immediately.  Open a
        // K-frame window seeded with this frame; the sharpest of the K
        // candidates is the one that gets saved (streaming max — only
        // the best candidate is ever buffered).  K == 1, and the
        // gate-disabled time-based passthrough (gateDecision == nil),
        // fall through to the pre-v0.21 immediate-save path below,
        // byte-for-byte.
        if let decision = gateDecision, decision.accept,
           self.sharpnessWindowK > 1 {
            self.sharpnessWindowOpen(
                pixelBuffer: pixelBuffer,
                pose: pose,
                collector: collector
            )
            return
        }

        // V11 Gap #27: dispatch the heavy keyframe-save work to the
        // work queue.  Earlier versions ran the full ~70 ms accept
        // inside the AR delegate thread, blocking ARKit's 16 ms
        // inter-frame budget and causing ~4-5 frames to be dropped
        // during each accept.
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
        // crash for the batch-keyframe save path, which dispatches
        // via consumeFrame.
        guard let pbCopy = Self.deepCopyPixelBuffer(pixelBuffer) else {
            // Allocation failure — drop the frame.  Extremely rare;
            // would only happen under genuine OOM.
            os_log(.fault, log: Self.diagLog,
                   "[V16-pbcopy] CVPixelBufferCreate failed; dropping frame")
            self.workInFlight = false
            return
        }
        self.dispatchKeyframeSave(
            pbCopy: pbCopy,
            pose: pose,
            collector: collector,
            inBatchKeyframeMode: inBatchKeyframeMode,
            rotationDegrees: rotationDegreesForBatch,
            exifOrientation: exifOrientationForBatch
        )
    }

    /// Shared keyframe-save pipeline: JPEG-encode + persist `pbCopy`
    /// via the collector on the work queue, append path + pose, track
    /// first/last accepted pose for the stitch-mode auto-resolver, and
    /// emit the accepted-state event JS renders in LiveFrameStrip.
    ///
    /// Used by BOTH the immediate accept path (sharpness window off /
    /// K == 1 / gate-disabled passthrough) and the sharpness-window
    /// flush — the body is the V16 batch-keyframe save, extracted
    /// verbatim so the two callers can’t drift.
    ///
    /// Contract: caller has already set `workInFlight = true` (cleared
    /// here via defer) and `pbCopy` is a DEEP COPY the pixel-buffer
    /// pool can’t recycle.
    private func dispatchKeyframeSave(
        pbCopy: CVPixelBuffer,
        pose: RNSARFramePose,
        collector: OpenCVKeyframeCollector?,
        inBatchKeyframeMode: Bool,
        rotationDegrees: Int,
        exifOrientation: Int
    ) {
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
                        rotationDegrees: rotationDegrees,
                        exifOrientation: exifOrientation,
                        jpegQuality: 80
                    )
                    self.stateLock.lock()
                    self.keyframePaths.append(record.path)
                    self.keyframePoses.append(pose.asDictionary())
                    // 2026-05-22 (audit F2) — track first + last pose
                    // for the stitchMode auto-resolver.  Same as the
                    // non-AR JS-driver site above.
                    let poseArr = [pose.tx, pose.ty, pose.tz,
                                   pose.qx, pose.qy, pose.qz, pose.qw]
                    if self.batchFirstAcceptedPose == nil { self.batchFirstAcceptedPose = poseArr }
                    self.batchLastAcceptedPose = poseArr
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
                        isLandscape: pose.imageWidth >= pose.imageHeight,
                        // v0.7.0 — Tier 1 hook: pose snapshot + accept
                        // timestamp threaded through to JS via the
                        // existing state-update channel.
                        pose: pose,
                        acceptedAtMs: Date().timeIntervalSince1970 * 1000
                    )
                } catch let err as NSError {
                    os_log(.fault, log: Self.diagLog,
                           "[V16-batch-keyframe] saveKeyframe failed: %{public}@",
                           err.localizedDescription)
                }
            }
        }
    }

    // ── v0.21 — pick-sharpest-in-window anti-blur selection ────────
    //
    // When the keyframe gate ACCEPTS a frame, the frame is NOT saved
    // immediately: a K-frame window opens (K = `sharpnessWindow`
    // config, default 4, clamp [1, 10]).  The accepted frame plus up
    // to K−1 subsequent gate-EVALUATED frames are scored with the
    // shared variance-of-Laplacian metric (cpp/sharpness.{hpp,cpp} —
    // scored on the downscaled Y plane, ~1-3 ms) and the SHARPEST one
    // is saved.  Rationale: the gate selects by overlap/novelty/time
    // only, so a motion-blurred frame crossing the threshold used to
    // be stitched as-is — panos showed blur even on slow pans.
    //
    // Candidate cadence: candidates are the frames the gate actually
    // EVALUATES (the eval-throttle's cadence).  Throttle-skipped
    // frames are dropped before any window bookkeeping, exactly like
    // they are dropped before gate evaluation.
    //
    // Memory: streaming max — at most ONE deep-copied candidate (the
    // best so far) is buffered, never all K frames.
    //
    // Pose pairing: the pose buffered alongside the best candidate is
    // the pose of THAT frame, so the saved keyframe's recorded pose
    // (keyframePoses / first-last auto-resolver tracking / the
    // accepted-state event) always matches the saved pixels.
    //
    // Threading: window state is mutated on the AR-delegate /
    // frame-processor producer thread (consumeFrame — serial) and
    // cleared by start()/cancel()/finalize() on the JS thread; every
    // mutation is under stateLock.  Scoring + deep copy (the expensive
    // parts) run OUTSIDE the lock.

    /// Open a fresh window seeded with the gate-accepted frame.  If a
    /// window is somehow still open (force-last / time-budget accepts
    /// can re-accept before the previous window filled), flush it
    /// first so its best frame isn't lost.
    private func sharpnessWindowOpen(
        pixelBuffer: CVPixelBuffer,
        pose: RNSARFramePose,
        collector: OpenCVKeyframeCollector?
    ) {
        stateLock.lock()
        let windowAlreadyOpen = (self.sharpnessBestBuffer != nil)
        stateLock.unlock()
        if windowAlreadyOpen {
            self.flushSharpnessWindow(reason: "new-accept")
        }

        let score = collector?.sharpnessScore(for: pixelBuffer) ?? 0.0
        guard let pbCopy = Self.deepCopyPixelBuffer(pixelBuffer) else {
            // Allocation failure — drop the frame, same as the
            // immediate-save path's pbCopy failure.
            os_log(.fault, log: Self.diagLog,
                   "[v0.21-sharpness] deepCopy failed; dropping accepted frame")
            return
        }
        stateLock.lock()
        guard self.isRunning, self.batchKeyframeMode else {
            // cancel()/finalize() raced us while scoring — the capture
            // is over, the buffer belongs to a dead session.
            stateLock.unlock()
            return
        }
        self.sharpnessBestBuffer = pbCopy
        self.sharpnessBestPose = pose
        self.sharpnessBestScore = score
        self.sharpnessWindowRemaining = self.sharpnessWindowK - 1
        let k = self.sharpnessWindowK
        stateLock.unlock()
        os_log(.fault, log: Self.diagLog,
               "[v0.21-sharpness] window OPEN k=%d seedScore=%.1f",
               Int32(k), score)
    }

    /// Score one gate-rejected frame against the open window's best
    /// (streaming max).  No-op when no window is open.
    private func sharpnessWindowIngestCandidate(
        pixelBuffer: CVPixelBuffer,
        pose: RNSARFramePose,
        collector: OpenCVKeyframeCollector?
    ) {
        stateLock.lock()
        let windowOpen = (self.sharpnessBestBuffer != nil
                          && self.sharpnessWindowRemaining > 0)
        let bestScore = self.sharpnessBestScore
        stateLock.unlock()
        guard windowOpen else { return }

        // Scoring + (conditional) deep copy outside the lock — only
        // the pointer swap needs mutual exclusion.  consumeFrame is
        // the sole mid-capture mutator (serial producer thread), so
        // bestScore can't move between the read above and the swap
        // below; cancel()/finalize() can only CLEAR the window, which
        // the re-check catches.
        let score = collector?.sharpnessScore(for: pixelBuffer) ?? 0.0
        var challenger: CVPixelBuffer? = nil
        if score > bestScore {
            // Deep-copy ONLY when this frame actually beats the best —
            // losing candidates cost one score (~1-3 ms), no memcpy.
            challenger = Self.deepCopyPixelBuffer(pixelBuffer)
            // nil (allocation failure) → keep the current best.
        }

        stateLock.lock()
        guard self.sharpnessBestBuffer != nil,
              self.sharpnessWindowRemaining > 0 else {
            stateLock.unlock()
            return
        }
        if let newBest = challenger {
            self.sharpnessBestBuffer = newBest   // old best released by ARC
            self.sharpnessBestPose = pose
            self.sharpnessBestScore = score
        }
        self.sharpnessWindowRemaining -= 1
        let shouldFlush = (self.sharpnessWindowRemaining == 0)
        stateLock.unlock()
        if shouldFlush {
            self.flushSharpnessWindow(reason: "window-full")
        }
    }

    /// Close the window: hand its best candidate to the same save
    /// pipeline the immediate accept path uses (workInFlight
    /// backpressure + workQueue JPEG encode + accepted-state event).
    /// Reasons: "window-full" (K candidates seen) and "new-accept"
    /// (gate re-accepted while a window was still open).  finalize()
    /// does NOT come through here — it flushes synchronously in its
    /// prologue because isRunning flips false there, which makes this
    /// async path bail by design.
    private func flushSharpnessWindow(reason: String) {
        stateLock.lock()
        guard let bestBuffer = self.sharpnessBestBuffer,
              let bestPose = self.sharpnessBestPose else {
            self.sharpnessWindowRemaining = 0
            stateLock.unlock()
            return
        }
        let bestScore = self.sharpnessBestScore
        self.sharpnessBestBuffer = nil
        self.sharpnessBestPose = nil
        self.sharpnessBestScore = -1.0
        self.sharpnessWindowRemaining = 0
        let stillActive = self.isRunning && self.batchKeyframeMode
        let collector = self.keyframeCollector
        let rotationDegrees = self.keyframeRotationDegrees
        let exifOrientation = self.keyframeExifOrientation
        stateLock.unlock()
        guard stillActive else { return }
        // Same backpressure semantics as the immediate accept path: if
        // the previous save is still encoding, this keyframe is
        // dropped (pre-window behaviour dropped the ACCEPT in exactly
        // this situation).
        if self.workInFlight {
            self.droppedBackpressure += 1
            return
        }
        self.workInFlight = true
        os_log(.fault, log: Self.diagLog,
               "[v0.21-sharpness] window FLUSH (%{public}@) bestScore=%.1f",
               reason, bestScore)
        self.dispatchKeyframeSave(
            pbCopy: bestBuffer,
            pose: bestPose,
            collector: collector,
            inBatchKeyframeMode: true,
            rotationDegrees: rotationDegrees,
            exifOrientation: exifOrientation
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

    /// 2026-05-22 (audit F2) — stitchMode auto-resolver.  Port of
    /// Android's `resolveStitchModeAuto` (IncrementalStitcher.kt:1727).
    /// Picks PANORAMA vs SCANS based on the magnitude ratio of
    /// translation to rotation between first and last accepted
    /// keyframe poses:
    ///
    ///   translation_score = ‖t_last - t_first‖ / 0.10          (10cm ≈ 1.0)
    ///   rotation_score    = angle(fwd_last, fwd_first) / 1.00  (1 rad ≈ 1.0)
    ///   ratio = translation_score / (translation_score + rotation_score)
    ///   ratio ≥ 0.55 → "scans"   (biased toward SCANS for safety)
    ///   ratio  < 0.55 → "panorama"
    ///
    /// 2026-05-22 (audit F2b) — non-AR mode has no pose-derived
    /// translation (JS driver only sends yaw/pitch/quaternion), so
    /// the pose-only resolver always picked `panorama` even for
    /// shelf scans.  Fold the JS-measured IMU translation magnitude
    /// into the resolver: use the LARGER of pose-translation and
    /// IMU-translation as `tMeters`.  In AR mode pose-translation
    /// will dominate (accurate); in non-AR mode pose-translation is
    /// 0 and IMU translation provides the signal.
    ///
    /// Returns "panorama" or "scans" — never "auto".  Degenerate
    /// inputs (nil poses, no motion either source) default to
    /// "panorama" (safer for pure-rotation captures; SCANS on a
    /// translation-free input produces unbounded canvas growth).
    private func resolveStitchModeAuto(
        first: [Double]?,
        last:  [Double]?,
        imuTranslationMetres: Double
    ) -> (mode: String, rRadians: Double, tMeters: Double, ratio: Double) {
        guard let firstPose = first, firstPose.count == 7,
              let lastPose  = last,  lastPose.count == 7  else {
            // No pose data at all — fall back on whichever signal we
            // do have.  imuTranslationMetres > 0 hints "scans"; 0
            // hints "panorama".  rRadians 0.0 — no gyro signal.
            return (imuTranslationMetres > 0.05 ? "scans" : "panorama", 0.0, 0.0, 0.0)
        }
        // Translation magnitude (Euclidean, in metres).
        let dtx = lastPose[0] - firstPose[0]
        let dty = lastPose[1] - firstPose[1]
        let dtz = lastPose[2] - firstPose[2]
        let tPose = (dtx*dtx + dty*dty + dtz*dtz).squareRoot()
        // Take the larger of pose-derived and IMU-measured.  In AR
        // mode pose is accurate; in non-AR mode pose is 0 and IMU is
        // the only signal we have.
        let tMeters = max(tPose, imuTranslationMetres)
        // Rotation magnitude — angle between camera-forward vectors.
        let rRadians = rotationRadians(first: firstPose, last: lastPose)
        // Normalisation: 10 cm of translation ≈ 1 rad of rotation as
        // "equivalent magnitude" for the ratio.  Shelf scans cover
        // ~30 cm translation with ~10° (0.17 rad) rotation:
        //   ratio = (0.30/0.10) / (3.0 + 0.17) = 0.95 → SCANS.
        // Pure 90° rotation panorama: 0 translation, 1.57 rad rotation:
        //   ratio = 0 / (0 + 1.57) = 0.0 → PANORAMA.
        let tScore = tMeters / 0.10
        let rScore = rRadians / 1.00
        let denom = tScore + rScore
        if denom <= 1e-9 { return ("panorama", rRadians, tMeters, 0.0) }  // no motion either way
        let ratio = tScore / denom

        // 2026-06-15 — LOW-ROTATION GUARD.  The gyro rotation (rRadians) is
        // trustworthy; the IMU translation (tMeters, in non-AR) is NOT — a
        // continuous rotation leaks gravity into the double-integrated accel and
        // inflates it, which can falsely push `ratio` over 0.55 → SCANS, whose
        // affine warper can't represent the rotation.  When the gyro shows a
        // clear pan (> ~20°) with only modest translation, force PANORAMA
        // regardless of the (possibly-inflated) translation.  Genuine shelf
        // scans (low rotation, large real translation) skip this and still
        // reach SCANS via the ratio.
        let lowRotationGuard = rRadians > 0.35 && tMeters < 0.25
        let mode = (!lowRotationGuard && ratio >= 0.55) ? "scans" : "panorama"
        os_log(.fault, log: Self.diagLog,
               "[stitchMode.auto] tPose=%.3fm tImu=%.3fm r=%.3frad ratio=%.3f rotGuard=%d → %{public}@",
               tPose, imuTranslationMetres, rRadians, ratio,
               lowRotationGuard ? 1 : 0, mode)
        return (mode, rRadians, tMeters, ratio)
    }

    /// 2026-06-16 — high-level warper decision tree (mirrors Android's
    /// pickHighLevelWarper).  The pipeline is now ALWAYS high-level cv::Stitcher
    /// PANORAMA.  Warper is a pure function of (lens, pan direction); the
    /// rotation-vs-translation (ex-SCANS) distinction was DROPPED as redundant —
    /// at 1x the same direction-based warpers serve both, and 0.5x is always
    /// spherical.  orientation = capture hold ("landscape*" = Mode A vertical
    /// pan; else Mode B horizontal); lens = the EXPLICIT lens ("0.5x" | "1x").
    ///
    ///     0.5x ultra-wide          → spherical   (bounded both axes; any pan)
    ///     1x + Mode A (vertical)   → plane
    ///     1x + Mode B (horizontal) → cylindrical
    ///
    /// Quality-preferred warper; the C++ memory ladder force-falls to spherical
    /// (and downscales compositingResol) under pressure.
    private func pickHighLevelWarper(
        orientation: String,
        lens: String
    ) -> String {
        if lens == "0.5x" { return "spherical" }           // ultra-wide → always spherical
        let verticalPanModeA = orientation.hasPrefix("landscape")
        return verticalPanModeA ? "plane" : "cylindrical"  // 1x: A→plane, B→cylindrical
    }

    /// Gyro rotation magnitude (radians) between two 7-element poses
    /// `[tx,ty,tz,qx,qy,qz,qw]` — angle between camera-forward vectors.
    /// Returns 0.0 if either pose is missing/malformed (non-AR, no pose).
    /// Shared by `resolveStitchModeAuto` + the finalize `rRadians` readout (DRY).
    private func rotationRadians(first: [Double]?, last: [Double]?) -> Double {
        guard let f = first, f.count == 7, let l = last, l.count == 7 else { return 0.0 }
        let fwdFirst = qrotForwardZneg(f[3], f[4], f[5], f[6])
        let fwdLast  = qrotForwardZneg(l[3], l[4], l[5], l[6])
        let dot = max(-1.0, min(1.0,
            fwdFirst.0 * fwdLast.0 + fwdFirst.1 * fwdLast.1 + fwdFirst.2 * fwdLast.2))
        return acos(dot)
    }

    /// Closed-form q · (0,0,-1) · q⁻¹ — rotates the camera-forward
    /// unit vector by a unit quaternion (qx, qy, qz, qw).  Same
    /// convention as `qrot` in cpp/keyframe_gate.cpp and
    /// `qrotForward` in IncrementalStitcher.kt.
    private func qrotForwardZneg(
        _ qx: Double, _ qy: Double, _ qz: Double, _ qw: Double
    ) -> (Double, Double, Double) {
        // v = (0, 0, -1).  Expansion:
        //   v' = (-2(qx*qz + qw*qy),
        //         -2(qy*qz - qw*qx),
        //         -1 + 2(qx*qx + qy*qy))
        let x = -2.0 * (qx * qz + qw * qy)
        let y = -2.0 * (qy * qz - qw * qx)
        let z = -1.0 + 2.0 * (qx * qx + qy * qy)
        return (x, y, z)
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

// MARK: - F8.3 — Frame Processor entry point
//
// `consumeFrameFromPlugin` is a thin @objc-compatible wrapper around
// `consumeFrame(pixelBuffer:pose:)` that takes primitive args instead
// of a `RNSARFramePose` instance.  It exists so the
// `KeyframeGateFrameProcessor.mm` plugin (ObjC++ producer-thread code)
// can submit a frame without needing to construct a Swift class
// across the bridging header.
//
// Threading: the worklet runs on vision-camera's producer thread
// (NOT ARKit's delegate queue).  Both threads ultimately serialise on
// `consumeFrame`'s `stateLock.try()`, which is the documented
// reentrancy boundary.
//
// In non-AR (Frame Processor) mode the caller supplies:
//   * `pixelBuffer` from `frame.buffer` (vision-camera YUV biplanar)
//   * `tx`/`ty`/`tz` = 0 (no AR translation; gyro only gives rotation)
//   * `qx,qy,qz,qw` from JS-thread gyro-integrated yaw+pitch (synthesised
//     as `q = q_yaw * q_pitch`).  `useFrameProcessorDriver` and (pre-v0.6)
//     `useIncrementalJSDriver` both produced quaternions with this layout.
//   * `fx`/`fy` from frame dims + assumed FoV
//   * `cx`/`cy` at image centre
//   * `trackingStateRaw = 2` (= `.tracking`) — non-AR captures don't have
//     a real ARKit tracking-quality signal; reporting `.tracking` keeps
//     the engine's `trackingPoor` path inactive.  Both the v0.6+
//     `useFrameProcessorDriver` and the pre-v0.6 `useIncrementalJSDriver`
//     follow(ed) this contract.
extension IncrementalStitcher {
    @objc public func consumeFrameFromPlugin(
        pixelBuffer: CVPixelBuffer,
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        timestampMs: Double,
        trackingStateRaw: Int
    ) {
        // F8.3 — drop the call unless this capture was started in
        // frameProcessor mode.  Read under stateLock so the producer
        // thread can't observe a stale TRUE during a cancel/finalize
        // teardown (adversarial-review H1).  The lock-protected
        // read costs ~1 µs at producer-thread rate; negligible vs
        // the deep-copy that follows on accepts.
        stateLock.lock()
        let enabled = self.frameProcessorIngestEnabled
        stateLock.unlock()
        guard enabled else { return }

        // Map the raw enum integer.  Unknown values fall back to
        // `.notAvailable` so the engine's existing tracking-poor
        // branches catch them — failing CLOSED is safer than
        // silently claiming healthy tracking when the JS side sent
        // garbage (adversarial-review C2).
        let trackingState =
            RNSARTrackingState(rawValue: trackingStateRaw) ?? .notAvailable
        let pose = RNSARFramePose(
            tx: tx, ty: ty, tz: tz,
            qx: qx, qy: qy, qz: qz, qw: qw,
            fx: fx, fy: fy, cx: cx, cy: cy,
            imageWidth: imageWidth, imageHeight: imageHeight,
            timestampMs: timestampMs,
            trackingState: trackingState
        )
        consumeFrame(pixelBuffer: pixelBuffer, pose: pose)
    }

    // F8.3.H2 — compile-time + runtime guard for the Swift⇄ObjC
    // selector contract that `KeyframeGateFrameProcessor.mm`
    // depends on.
    //
    // The .mm file forward-declares `IncrementalStitcher` and
    // dispatches `[shared consumeFrameFromPluginWithPixelBuffer:tx:
    // …:trackingStateRaw:]` by NAME — ObjC's late-binding means
    // signature drift would silently link but crash at runtime
    // with `NSInvalidArgumentException: unrecognized selector`
    // on the first non-AR frame.
    //
    // This `#selector(...)` reference forces the Swift compiler
    // to resolve the exact method signature.  If anyone renames a
    // parameter label or adds/removes an argument, the
    // `_consumeFrameFromPluginSelectorPin` expression fails to
    // compile — the SDK won't build until the .mm's forward
    // declaration is updated to match.  Stronger guarantee than a
    // test that needs iOS-Simulator infrastructure to run.
    //
    // The runtime check below additionally pins the exact
    // SELECTOR STRING the .mm dispatches.  In dev/debug builds it
    // asserts; in release builds it's a no-op (the static let is
    // initialised lazily and never read otherwise, so the runtime
    // cost is one-time + tiny).  Drift between Swift's auto-
    // generated selector name and the .mm's expected string
    // (e.g., if Swift's bridging rules change) trips the assert.
    private static let _consumeFrameFromPluginSelectorPin: Selector =
        #selector(IncrementalStitcher.consumeFrameFromPlugin(
            pixelBuffer:
            tx: ty: tz:
            qx: qy: qz: qw:
            fx: fy: cx: cy:
            imageWidth: imageHeight:
            timestampMs:
            trackingStateRaw:))

    @inline(never)
    private static func _verifyConsumeFrameFromPluginSelector() {
        let expected =
            "consumeFrameFromPluginWithPixelBuffer:tx:ty:tz:"
            + "qx:qy:qz:qw:fx:fy:cx:cy:"
            + "imageWidth:imageHeight:timestampMs:trackingStateRaw:"
        let actual = NSStringFromSelector(_consumeFrameFromPluginSelectorPin)
        assert(
            actual == expected,
            "Frame Processor selector drift — Swift's auto-bridged "
            + "ObjC selector for consumeFrameFromPlugin is "
            + "\(actual) but KeyframeGateFrameProcessor.mm's "
            + "forward declaration expects \(expected).  Update the "
            + ".mm to match (or fix the assumption here).",
        )
    }
}
