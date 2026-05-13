// SPDX-License-Identifier: UNLICENSED
//
// RetaiLensIncrementalStitcher — Swift-side engine for the live
// panorama-stitching pipeline introduced in
// docs/site-content/design/2026-04-30-realtime-incremental-stitching.md.
//
// What this file does:
//   - Owns a single `OpenCVIncrementalStitcher` instance
//   - Subscribes to `RetaiLensARSession`'s per-frame ARFrame delivery
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
//   the delegate callback (see the comment on RetaiLensARSession's
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
@objc public enum RetaiLensIncrementalOutcome: Int {
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
@objc(RetaiLensIncrementalState)
public final class RetaiLensIncrementalState: NSObject {
    @objc public let panoramaPath: String?
    @objc public let width: Int
    @objc public let height: Int
    @objc public let acceptedCount: Int
    @objc public let outcome: RetaiLensIncrementalOutcome
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
        outcome: RetaiLensIncrementalOutcome,
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
        Notification.Name("RetaiLensIncrementalStateUpdate")
}


@objc(RetaiLensIncrementalStitcher)
public final class RetaiLensIncrementalStitcher: NSObject {

    /// V13.0c.1.1 — same os_log subsystem as the slit-scan engine's
    /// SlitDiagLog so Console.app sees both V13.0b-gate and V13.0c-trans
    /// under one filter.  FAULT-level survives NSLog's burst rate-limit
    /// (~10/sec) — diagnostic logs at 50fps would otherwise be dropped.
    fileprivate static let diagLog = OSLog(
        subsystem: "com.tiger.retailens.sdk",
        category: "slitscan"
    )


    @objc public static let shared = RetaiLensIncrementalStitcher()

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
    /// from RetaiLensARSession to the slit-scan engine.  Reset on
    /// every start() so the next capture re-propagates.  We only
    /// forward once per capture: the plane transform is latched
    /// (RetaiLensARSession ignores subsequent ARKit refinements),
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
    private let workQueue = DispatchQueue(
        label: "com.retailens.incremental.stitcher",
        qos: .userInitiated
    )

    /// Lock guarding `engine`/`isRunning` reads/writes.  ARSession
    /// delegate uses `try` to avoid blocking ARKit; if start/stop is
    /// mid-flight the frame is dropped.
    private let stateLock = NSLock()

    /// Whether the engine is currently active.  Set by start/stop.
    @objc public private(set) var isRunning: Bool = false

    /// The most recent state snapshot — readable by JS via the
    /// bridge's `getState`.
    private var lastState: RetaiLensIncrementalState?

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
    /// Each entry is `RetaiLensARFramePose.asDictionary()`.  Reset
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
        guard let frame = RetaiLensARSession.shared.arSession.currentFrame else {
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
        configOverrides: [String: Any] = [:]
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
            // V16 Phase 1.fix2 — encode the user's perceived
            // orientation as EXIF Orientation in the saved JPEG.
            // cv::imread (with IMREAD_IGNORE_ORIENTATION, set in
            // stitchKeyframePaths) ignores it for the stitcher, but
            // RN's <Image>, Files.app, etc. honour it for display.
            // Mapping (frameRotationDegrees → EXIF tag):
            //   0   = landscape-left      → 1 (no rotation)
            //   90  = portrait            → 6 (rotate 90° CW for view)
            //   180 = landscape-right     → 3 (rotate 180°)
            //   270 = portrait-up-down    → 8 (rotate 90° CCW)
            switch frameRotationDegrees {
            case 90:  self.keyframeExifOrientation = 6
            case 180: self.keyframeExifOrientation = 3
            case 270: self.keyframeExifOrientation = 8
            default:  self.keyframeExifOrientation = 1
            }
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
        self.keyframeGate.enabled = (frameMode == "pose-based")
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
        self.keyframeGate.reset()
        os_log(.fault, log: Self.diagLog,
               "[V16-keyframe] start gate enabled=%d thr=%.2f max=%d",
               self.keyframeGate.enabled ? 1 : 0,
               self.keyframeGate.overlapThreshold,
               self.keyframeGate.maxCount)

        stateLock.unlock()

        // Register with the AR session.  Weak so the singleton is the
        // owner of lifetime; we de-register on stop.
        RetaiLensARSession.shared.incrementalConsumer = self
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
        RetaiLensARSession.shared.planeAlignmentThreshold =
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

        // Then detach the AR consumer.  Any in-flight delegate that
        // already captured the consumer reference will reach
        // consumeFrame, see isRunning=false, and bail.
        RetaiLensARSession.shared.incrementalConsumer = nil

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
        let arWasRunning = inBatchKeyframeMode
            && RetaiLensARSession.shared.isRunning
        if arWasRunning {
            os_log(.fault, log: Self.diagLog,
                   "[V16-batch-keyframe] pausing AR session for stitch (memory drop)")
            RetaiLensARSession.shared.stop()
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
        // Other RetaiLensIncrementalStitcher bridge calls queue up
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
        workQueue.sync {
            // V16 Phase 1b.fix1 — defer-restart AR session.  Fires
            // on every exit path (success, error, early return).
            // Restart is dispatched to main because ARSession.run()
            // expects main-thread invocation to set up its rendering
            // hooks; happens AFTER the stitch completes so it doesn't
            // contend for the memory budget.
            defer {
                if arWasRunning {
                    DispatchQueue.main.async {
                        os_log(.fault, log: Self.diagLog,
                               "[V16-batch-keyframe] restarting AR session post-stitch")
                        RetaiLensARSession.shared.start()
                    }
                }
            }
            let cleaned = (outputPath.hasPrefix("file://"))
                ? String(outputPath.dropFirst(7))
                : outputPath
            let q = max(1, min(100, jpegQuality))
            do {
                if inBatchKeyframeMode {
                    // V16 Phase 1 — hand collected keyframes + poses
                    // to OpenCVStitcher's full BA + GraphCut +
                    // ExposureComp + MultiBand pipeline.  ≤6 frames
                    // means BA stays bounded and MultiBand fits.
                    os_log(.fault, log: Self.diagLog,
                           "[V16-batch-keyframe] finalize ENTRY frames=%d",
                           paths.count)
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
                    if paths.count < 2 {
                        if paths.count == 1 {
                            let src = paths[0]
                            do {
                                // Remove any pre-existing file at the
                                // output path — copyItem refuses to
                                // overwrite, and a stale tmp file from
                                // a prior auto-finalize attempt is the
                                // common case.
                                let fm = FileManager.default
                                if fm.fileExists(atPath: cleaned) {
                                    try fm.removeItem(atPath: cleaned)
                                }
                                try fm.copyItem(atPath: src, toPath: cleaned)
                                // Read back the JPEG dimensions for
                                // the result dictionary — match
                                // OpenCVStitcher.stitchFramePaths'
                                // {width, height} contract so JS
                                // doesn't have to special-case a
                                // single-frame result.
                                var width: Int = 0
                                var height: Int = 0
                                if let provider = CGDataProvider(filename: cleaned),
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
                                       src, cleaned,
                                       Int32(width), Int32(height))
                                completion([
                                    "panoramaPath": cleaned,
                                    "width": width,
                                    "height": height,
                                    "acceptedCount": 1,
                                    "droppedBackpressure": drops,
                                    "batchKeyframeSessionDir":
                                        collector?.sessionDir ?? "",
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
                        collector?.cleanup()
                        completion(nil, NSError(
                            domain: "RetaiLensIncremental",
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
                        // tag derived from `frameRotationDegrees` (see
                        // `start(...)` switch).  cv::Stitcher writes
                        // wide pixels regardless of capture orientation
                        // (lens is fixed); without a baked tag, iOS
                        // image renderers display the panorama
                        // sideways when the user holds the phone in
                        // portrait.  The tag is metadata-only — pixels
                        // are unchanged — so it costs nothing.
                        // V16 Phase 1b.fix4 — read knobs from the
                        // closure-local snapshots (taken under
                        // stateLock in finalize's prologue), NOT
                        // self.batch*, to avoid a torn-pointer race
                        // against a concurrent start().  See RCA
                        // comment at the top of finalize().
                        // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
                        // Pass the capture-time hold orientation to
                        // the native side; .mm uses it to bake-rotate
                        // the output Mat per the two-modes rotation
                        // table (portrait → 0°, portrait-upside-down
                        // → 180°, landscape-left → 90° CCW,
                        // landscape-right → 90° CW).
                        // `keyframeExifOrientation` (still snapshotted
                        // above) is kept for any future per-keyframe
                        // EXIF needs; unused on this call now.
                        _ = keyframeExifOrientation
                        os_log(.fault, log: Self.diagLog,
                               "[V16-batch-keyframe] stitch (feature-matched): warper=%{public}@ blender=%{public}@ seam=%{public}@ captureOrientation=%{public}@",
                               batchWarperType,
                               batchBlenderType,
                               batchSeamFinderType,
                               captureOrientation)
                        let r = try OpenCVStitcher.stitchFramePaths(
                            paths,
                            outputPath: cleaned,
                            jpegQuality: q,
                            warperType: batchWarperType,
                            blenderType: batchBlenderType,
                            seamFinderType: batchSeamFinderType,
                            captureOrientation: captureOrientation,
                            useInscribedRectCrop: batchEnableInscribedRectCrop
                        )
                        // Keep saved keyframes on disk for post-hoc
                        // re-processing (Ram's request).  Cleanup is
                        // a follow-up debug-menu task.
                        completion([
                            "panoramaPath": r.outputPath,
                            "width": Int(r.width),
                            "height": Int(r.height),
                            "acceptedCount": paths.count,
                            "droppedBackpressure": drops,
                            "batchKeyframeSessionDir":
                                collector?.sessionDir ?? "",
                            "batchKeyframeCount": paths.count,
                        ], nil)
                    } catch let stitchErr as NSError {
                        completion(nil, stitchErr)
                    }
                } else if let hybrid = hybrid {
                    let snap = try hybrid.finalize(atPath: cleaned, jpegQuality: q)
                    completion([
                        "panoramaPath": snap.panoramaPath,
                        "width": snap.width,
                        "height": snap.height,
                        "acceptedCount": snap.acceptedCount,
                        "droppedBackpressure": drops,
                    ], nil)
                } else if let slit = slit {
                    let snap = try slit.finalize(atPath: cleaned, jpegQuality: q)
                    completion([
                        "panoramaPath": snap.panoramaPath,
                        "width": snap.width,
                        "height": snap.height,
                        "acceptedCount": snap.acceptedCount,
                        "droppedBackpressure": drops,
                    ], nil)
                } else {
                    completion(nil, NSError(
                        domain: "RetaiLensIncremental",
                        code: 9002,
                        userInfo: [NSLocalizedDescriptionKey:
                            "No active capture — call start() first."]
                    ))
                }
            } catch let err as NSError {
                completion(nil, err)
            }
        }
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
        RetaiLensARSession.shared.incrementalConsumer = nil
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
        let state = RetaiLensIncrementalState(
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
        let outcome: RetaiLensIncrementalOutcome
        switch decision.reason {
        case "max-reached":      outcome = .skippedKeyframeMaxReached
        case "overlap-too-high": outcome = .skippedKeyframeOverlap
        default:                 outcome = .skippedKeyframeOverlap
        }
        // Re-use the previous state's pan-extent / orientation fields
        // so the band overlay doesn't flicker when a reject lands.
        let prev = self.lastState
        let acceptedCount = self.engineAcceptedCount
        let overlapPercent = (decision.newContentFraction >= 0)
            ? (1.0 - decision.newContentFraction) * 100.0
            : (prev?.overlapPercent ?? -1.0)
        let state = RetaiLensIncrementalState(
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
    /// reuse contract — see comments in RetaiLensARSession).
    @objc public func consumeFrame(
        pixelBuffer: CVPixelBuffer,
        pose: RetaiLensARFramePose
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
        let shouldEvaluateGate =
            isRunning
            && (hybrid != nil || slit != nil || inBatchKeyframeMode)
            && self.keyframeGate.enabled
        if shouldEvaluateGate {
            let plane = RetaiLensARSession.shared.latchedPlaneTransform()
            gateDecision = self.keyframeGate.evaluate(
                pose: pose, latchedPlane: plane
            )
        }
        stateLock.unlock()

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
            // RetaiLensARSession resets on stop().
            if !self.havePropagatedPlane,
               let plane = RetaiLensARSession.shared.planeTransformFlat() {
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
        let outcome = RetaiLensIncrementalOutcome(rawValue: telemetry.outcome.rawValue)
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
        let state = RetaiLensIncrementalState(
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

@objc public protocol RetaiLensARFrameConsumer: AnyObject {
    /// Called on the ARSession delegate's queue.  The pixel buffer is
    /// only valid for the duration of this call (Apple's ARKit pool
    /// reuse contract); consumers must copy out before returning.
    func consumeFrame(pixelBuffer: CVPixelBuffer, pose: RetaiLensARFramePose)
}

extension RetaiLensIncrementalStitcher: RetaiLensARFrameConsumer {}
