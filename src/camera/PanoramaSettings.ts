// SPDX-License-Identifier: Apache-2.0
/**
 * PanoramaSettings (v0.4) — engine-discriminated, hierarchical
 * settings types.
 *
 * Background
 * ──────────
 *
 * Pre-v0.4 the lib exported a single flat `PanoramaSettings`
 * interface with 45+ fields covering three unrelated stitching
 * engines (batch-keyframe, hybrid, slit-scan).  The 2026-05-22
 * audit (CHANGELOG entry for v0.3.0) traced every field's actual
 * native consumer and proved:
 *
 *   • batch-keyframe and the live engines (hybrid + slit-scan)
 *     share **zero** settings — they read disjoint subsets of
 *     the flat interface.
 *   • ~10 fields had no native consumer at all (dead surface).
 *   • The <Camera> public component hardcodes `engine:
 *     'batch-keyframe'` and never reaches the slit-scan / hybrid
 *     branches.
 *
 * v0.4 splits the flat interface into three engine-specific types:
 *
 *   • `PanoramaSettings`  — what <Camera> consumes (batch-keyframe).
 *   • `SlitscanSettings`  — for Layer 2 hosts using the slit-scan
 *                            engine (incremental.start({ engine:
 *                            'slitscan-*', ... })).
 *   • `HybridSettings`    — for the RetaiLens-specific hybrid live
 *                            engine.  Exported for completeness;
 *                            most consumers won't touch it.
 *
 * Each type carries only the fields its target engine actually
 * reads.  Sub-objects (`stitcher`, `frameSelection`, `flow`,
 * `painting`, `registration`, `plane`, `ncc2d`, `emaSmoothing`,
 * `panAxisLock`) group related knobs so the modal can render
 * collapsible sections that match the type tree.
 *
 * Migration
 * ─────────
 *
 * No automated migration helper.  v0.4 is a clean break; the
 * v0.3 `PanoramaSettings` type is deleted.  Consumers (notably
 * `retailens-camera-sdk`) update their settings literals to match
 * the new shape.  See the v0.4.0 CHANGELOG entry for the field-
 * by-field mapping.
 */


// ═════════════════════════════════════════════════════════════════════
// CaptureBaseSettings — fields common to ALL engine-specific types.
// Extracted in response to a code-reviewer DRY flag (3-way duplication
// across PanoramaSettings / SlitscanSettings / HybridSettings).
// ═════════════════════════════════════════════════════════════════════

export interface CaptureBaseSettings {
  /**
   * Which camera + tracking source feeds the engine:
   *
   *   • `'ar'`     — ARKit (iOS) / ARCore (Android) session.  Rich
   *                   pose with real translation.  Required for
   *                   plane-projected slit-scan; recommended for
   *                   batch-keyframe whenever the device supports
   *                   it (the auto-resolver's translation signal
   *                   comes from AR pose).
   *   • `'non-ar'` — vision-camera fallback.  Gyro-integrated yaw
   *                   + pitch only; no translation from pose.  The
   *                   JS-side IMU translation gate fills in the
   *                   translation signal.  Required on devices
   *                   without ARKit/ARCore support.
   */
  captureSource: 'ar' | 'non-ar';

  /**
   * Show the lib's built-in diagnostic overlay (memory pill,
   * keyframe pill, orientation pill, stitch-stats toast, detailed
   * metrics block).  Default `false` so end-users don't see them.
   * Hosts that compose their own debug surface can leave this off
   * and mount the individual `Capture*Pill` components themselves.
   */
  debug: boolean;
}


// ═════════════════════════════════════════════════════════════════════
// PanoramaSettings — what <Camera> uses (batch-keyframe engine).
// ═════════════════════════════════════════════════════════════════════

/**
 * Top-level settings for the standard panorama capture flow
 * exposed by <Camera>.  Engine is fixed to batch-keyframe internally;
 * the only mode choice exposed at this level is `captureSource`
 * (AR-backed vs vision-camera fallback) and the `stitcher` /
 * `frameSelection` sub-trees.
 */
export interface PanoramaSettings extends CaptureBaseSettings {
  /** cv::Stitcher pipeline configuration (applied at finalize). */
  stitcher: BatchStitcherSettings;

  /** Per-frame keyframe-selection gate configuration. */
  frameSelection: FrameSelectionSettings;
}


/**
 * cv::Stitcher tuning — these knobs reach the C++ stitcher at
 * `finalize()` time, after all keyframes are collected.  They have
 * no effect on per-frame selection.
 */
export interface BatchStitcherSettings {
  /**
   * cv::Stitcher pipeline mode.
   *
   *   • `'auto'` (default) — engine looks at the
   *     translation/rotation ratio between first + last accepted
   *     keyframe poses (and, in non-AR mode, the IMU translation
   *     accumulator) and picks `'panorama'` or `'scans'` at
   *     finalize.
   *   • `'panorama'` — rotation-only pipeline (ORB + BA-Ray +
   *     SphericalWarper).  Best for "rotate phone in place" pans.
   *     Diverges on translation-heavy input.
   *   • `'scans'` — affine pipeline (Affine matcher + BA-Affine +
   *     PlaneWarper).  Best for "walk past a shelf" captures.
   *     Slight quality drop on pure rotation, never diverges.
   *
   * Both platforms now honour this and the auto-resolver.  Both
   * also retry with the OPPOSITE mode if the configured mode
   * produces degenerate camera params (warpRoi too large).
   */
  stitchMode: 'auto' | 'panorama' | 'scans';

  /**
   * Output projection.  PANORAMA mode uses this directly; SCANS
   * hard-wires PlaneWarper internally and ignores this field.
   */
  warperType: 'plane' | 'cylindrical' | 'spherical';

  /**
   * Pixel blender for the warped frames.  `'multiband'` produces
   * cleaner seams but holds all warped frames in memory; `'feather'`
   * streams and uses less peak memory.
   */
  blenderType: 'multiband' | 'feather';

  /**
   * Seam-finder strategy.  `'graphcut'` finds optimal seams before
   * blending (pair with multiband); `'skip'` streams warp+feed (pair
   * with feather for the lowest-memory configuration).
   */
  seamFinderType: 'graphcut' | 'skip';

  /**
   * Output crop strategy.  `false` (default) crops to the bounding
   * rectangle of non-black pixels.  `true` runs the
   * max-inscribed-rectangle + morph-close pipeline — cleaner output
   * with no black corners, more CPU at finalize.
   */
  enableMaxInscribedRectCrop: boolean;

  /**
   * perf-3b — PANORAMA feature-matcher range.  `0`/undefined (default)
   * = OFF: the stock full-pairwise `BestOf2NearestMatcher` ladder
   * (byte-identical to before this knob existed).  `> 0` enables the
   * `BestOf2NearestRangeMatcher` ladder, which matches only keyframes
   * within `|i − j| < width` — keyframes are strictly capture-ordered,
   * so on a linear shelf pan the skipped non-adjacent pairs share ~no
   * overlap and their O(N²) matching is wasted work.  The window widens
   * across the finalize retry ladder: **consecutive-only (width 2) on
   * attempts 1–2, then out to THIS value on the final, lowest-threshold
   * attempt** — so `3` gives a 2/2/3 schedule, bridging a chain broken
   * at a weak consecutive link only as a last resort.  This replaces the
   * full-pairwise matcher on every attempt; pan-back captures (distant
   * overlap) are handled at capture time (perf-5), not by a rescue here.
   * Recommended `3`.  PANORAMA/high-level only; ignored by SCANS and the
   * manual pipeline.
   */
  rangeMatcherWidth?: number;

  /**
   * perf-3b item 1 — OpenCV intra-stitch thread count (Android only).
   * `0`/undefined (default) = AUTO (`min(4, max(2, cores/2))`), restoring
   * the multi-core warp/blend/feature parallelism that `setNumThreads(1)`
   * removed to work around a native-heap creep — now safe because the
   * stitch runs on a stable dedicated thread. `1` = single-threaded
   * kill-switch (revert here if a device regresses on the memory gate).
   * `N` = explicit. iOS ignores this (its GCD backend is already multi-core).
   */
  numThreads?: number;
}


/**
 * KeyframeGate tuning — these knobs control which incoming frames
 * become keyframes.  The mode selects the strategy (passthrough,
 * plane-overlap, or sparse optical flow); the `flow` sub-tree is
 * only consulted when `mode === 'flow-based'`.
 */
export interface FrameSelectionSettings {
  /**
   * Frame selection strategy:
   *
   *   • `'time-based'`  — gate disabled.  Every JS-driver / AR
   *                        frame becomes a keyframe up to
   *                        `maxKeyframes`.  Useful for testing or
   *                        when the host wants to do its own
   *                        keyframe selection upstream.
   *   • `'pose-based'`  — plane-overlap novelty (when a plane is
   *                        latched) or angular-delta fallback (no
   *                        plane).  Cheap to evaluate but conservative
   *                        about pure-rotation motion.
   *   • `'flow-based'`  — sparse Shi-Tomasi corners + KLT tracking.
   *                        More expensive (~3–5 ms per AR frame on
   *                        a Galaxy A35) but accurate for translation.
   *                        The default for v0.3+.
   */
  mode: 'time-based' | 'pose-based' | 'flow-based';

  /**
   * Hard cap on accepted keyframes per capture.  Clamped to
   * `[3, 10]` natively.  Higher is rarely useful: cv::Stitcher
   * convergence degrades past ~8-10 frames, and the per-keyframe
   * disk + memory cost adds up fast at 4K+ resolutions.
   */
  maxKeyframes: number;

  /**
   * Required NEW-content fraction (0..1) for a candidate frame to
   * be accepted.  Default 0.15 = 15% novel content per accept (v0.16;
   * was 0.20).  Lower = more frames accepted, denser overlap, more
   * robust registration.  Higher = fewer frames, faster captures but
   * more conservative about coverage.  Clamped to `[0.10, 0.80]`
   * natively (`IncrementalStitcher.swift:962`) — 0.10 is the floor.
   */
  overlapThreshold: number;

  /**
   * Time-budget force-accept (BOTH strategies, AR + non-AR).  When > 0,
   * the gate accepts a keyframe whenever this many milliseconds have
   * elapsed since the last accepted keyframe — even if the novelty /
   * overlap threshold wasn't met — so a slow or static pan never goes
   * longer than this without a keyframe.  Counts toward `maxKeyframes`
   * (the cap still finalises the capture).  `0` disables it.  Default
   * `1500` (1.5 s) — with `maxKeyframes` 8 this bounds a static/slow
   * capture to ~8×1.5 ≈ 12 s before the keyframe-count auto-finalize.
   * Maps to the native gate's `setMaxKeyframeIntervalMs`.
   */
  maxKeyframeIntervalMs: number;

  /**
   * v0.21 — pick-sharpest-in-window anti-blur keyframe selection.
   * When the gate ACCEPTS a frame, the engine does not save it
   * immediately: it scores the accepted frame plus up to K−1
   * subsequent gate-evaluated frames with a variance-of-Laplacian
   * sharpness metric (shared C++, scored on the downscaled gray
   * frame, ~1–3 ms) and saves the SHARPEST of the K.  Fixes
   * motion-blurred keyframes slipping into the stitch — the gate
   * itself selects purely by overlap/novelty/time.
   *
   * K = this value.  Clamped natively to `[1, 10]`.  `1` disables
   * the window (immediate save — the pre-v0.21 behaviour).  Default
   * `4` — NOTE this means the feature is ON by default; omitting
   * the field opts you IN, at the cost of up to K−1 evaluated
   * frames of extra latency between gate-accept and the keyframe
   * thumbnail appearing.  Memory cost: at most ONE extra buffered
   * frame (streaming max), regardless of K.
   *
   * Interaction with `overlapThreshold` and `flow.evalEveryNFrames`:
   * candidates are only the frames the gate actually evaluates, so a
   * raw window spans up to `sharpnessWindow × evalEveryNFrames`
   * camera frames of motion after the accepted pose.  To bound that
   * drift the engine closes the window EARLY (saving the best-so-far
   * and excluding the drifted frame) as soon as a candidate's own
   * gate novelty exceeds `0.5 × overlapThreshold` — i.e. once the
   * camera is half-way to the next keyframe boundary.  Raising K or
   * the eval cadence therefore only widens the selection pool on
   * SLOW pans; on fast pans the overlap guard closes the window
   * first.
   */
  sharpnessWindow?: number;

  /**
   * Sparse-optical-flow strategy tunables.  Consulted only when
   * `mode === 'flow-based'`; safe to omit otherwise.  Defaults
   * track [DEFAULT_PANORAMA_SETTINGS.frameSelection.flow].
   */
  flow?: FlowGateSettings;
}


/**
 * Sparse-flow KLT tuning for the gate.  All ranges are enforced
 * (clamped silently) at the native boundary.
 */
export interface FlowGateSettings {
  /**
   * Percentile used to aggregate the per-feature absolute
   * displacements into a single per-axis novelty estimate.  Default
   * 0.85 (V16 change from the pre-V16 median of 0.50).  Higher
   * percentile picks up leading-edge motion sooner; lower is more
   * conservative.  Clamped to `[0.50, 0.99]`.
   */
  noveltyPercentile: number;

  /**
   * Caller-side throttle: evaluate the Flow strategy every Nth
   * frame instead of every frame.  Default 5 (≈ 6 Hz at 30 Hz
   * ARCore).  Pure CPU savings; doesn't change WHICH frames are
   * accepted.  Clamped to `[1, 10]`.
   */
  evalEveryNFrames: number;

  /**
   * Translation budget in centimetres.  When > 0, the gate
   * force-accepts the next frame after the operator has translated
   * more than this distance since the last accepted keyframe — even
   * when novelty is below `overlapThreshold`.  Bounds parallax
   * between adjacent keyframes so the stitcher's matcher sees
   * inputs it can handle.  Default 50.  `0` disables.  Clamped
   * to `[0, 100]`.
   */
  maxTranslationCm: number;

  /**
   * Shi-Tomasi corner count.  Default 150; clamped to `[50, 300]`.
   * Higher = more robust median, slower detect (~15-25 ms at 150
   * on Galaxy A35).
   */
  maxCorners: number;

  /**
   * Shi-Tomasi quality level.  Default 0.01; clamped to
   * `[0.005, 0.05]`.  Lower lets weaker corners in (more candidate
   * points, more KLT noise); higher demands stronger corners.
   */
  qualityLevel: number;

  /**
   * Shi-Tomasi minimum distance between detected corners, in
   * working-resolution pixels (the gate downscales the input
   * internally to a 720-px-longest-side working frame).  Default
   * 10; clamped to `[1, 50]`.  Higher = more spatially-spread
   * features = more representative median.
   */
  minDistance: number;
}


/**
 * Canonical FlowGateSettings defaults, exported as a standalone
 * constant so consumers (the bridge, the modal, prop translators)
 * can reach the values WITHOUT typing
 * `DEFAULT_PANORAMA_SETTINGS.frameSelection.flow!.X` — the
 * non-null-assertion form is brittle (will start crashing at
 * runtime the moment someone "cleans up" the default tree and
 * makes `flow` undefined in `DEFAULT_PANORAMA_SETTINGS`).  Lifted
 * out 2026-05-22 in the F10 Phase 2 review (NIT-4).
 *
 * Numerical values mirror the v0.3 defaults; they're verified
 * against the native engine's compiled-in fallback values
 * (`IncrementalStitcher.swift:1003-1029`, `IncrementalStitcher.kt:419-445`)
 * — discrepancies are flagged in the v0.3.0 audit and resolved by
 * the bridge always-emitting these on the wire (see
 * `PanoramaSettingsBridge.ts:panoramaSettingsToNativeConfig`).
 */
/**
 * v0.21 — canonical default for `frameSelection.sharpnessWindow` (the
 * pick-sharpest-in-window anti-blur selection; see the field's JSDoc).
 * Exported standalone for the same reason as
 * [DEFAULT_FLOW_GATE_SETTINGS]: the bridge and prop translators need
 * the value without reaching through the default tree's optional
 * fields.
 */
export const DEFAULT_SHARPNESS_WINDOW = 4;


export const DEFAULT_FLOW_GATE_SETTINGS: FlowGateSettings = {
  noveltyPercentile: 0.85,
  evalEveryNFrames: 5,
  maxTranslationCm: 50,
  maxCorners: 150,
  qualityLevel: 0.01,
  minDistance: 10,
};


export const DEFAULT_PANORAMA_SETTINGS: PanoramaSettings = {
  captureSource: 'ar',
  debug: false,
  stitcher: {
    // v0.16 — AUTO by default.  Reverted from the brief 'panorama' default after
    // on-device comparison (matches the v0.15.2 behaviour, which produced better
    // results for these captures).  The auto-resolver now carries the
    // low-rotation guard (rRadians>0.35 && t<0.25 → force PANORAMA), so the old
    // IMU-gravity-leak SCANS misclassification on rotational pans is fixed; auto
    // can again safely pick SCANS (high-level affine) for genuine flat scans.
    stitchMode: 'auto',
    // v0.16 — PLANE by default.  Reverted from 'spherical' after on-device
    // comparison (matches v0.15.2 — flatter, more natural for the common 1x
    // pan).  Plane is unbounded, so this re-arms the manual pipeline's dynamic
    // plane→SPHERICAL divergence/quality fallback (it fires only when
    // warperType != 'spherical'), keeping wide/off-axis pans safe.
    warperType: 'plane',
    blenderType: 'multiband',
    seamFinderType: 'graphcut',
    // v0.15 — inscribed-rect crop is OFF by default (bbox crop keeps all
    // stitched content).  Opt in with `maxInscribedRectCrop={true}` (or toggle
    // it on in settings) for a clean-cornered rectangle — but it can shrink the
    // output a lot on lopsided / ultra-wide masks, which is why it's opt-in.
    enableMaxInscribedRectCrop: false,
    // perf-3b — range-matcher ladder ON by default (2/2/3 schedule):
    // consecutive-only matching on the fast attempts, widening to 3 only on
    // the final minimum-threshold attempt.  Validated on-device (parity:
    // identical framesIncluded, no ghosting; ~5-6% faster on small corpora,
    // more at higher keyframe counts).  Set to 0 to fall back to the legacy
    // full-pairwise ladder.  See docs/perf-3b.
    rangeMatcherWidth: 3,
    // perf-3b item 1 — OpenCV threads: 1 = single-threaded (DEFAULT).
    // On-device measurement (incl. an independent adversarial re-review)
    // proved multi-threading is a NET REGRESSION of -7..-18% at the fleet's
    // 4-15 keyframe / 0.3-1.2MP captures: cv::Stitcher is dominated by
    // strictly-serial phases (graphcut seam ~41%, ORB/bundle-adjust), and
    // its nominally-parallel pixel work is too small to scale at 1MP compose
    // while TBB worker overhead makes it a net loss. Single-threaded is BOTH
    // the fastest AND the most memory-safe config here. Set 0 for auto-multi
    // or N to experiment, but it will not help at these sizes — the real
    // lever is the seam finder (see docs/perf-3b).
    numThreads: 1,
  },
  frameSelection: {
    mode: 'flow-based',
    // v0.16 — keyframe gate: a 20% novelty gate, up to 6 frames, plus a 1.5 s
    // time-budget force-accept (so a slow/static pan still lands a keyframe every
    // 1.5 s even when novelty is low).  These match the leaner v0.15.2 cadence (6
    // frames / 20% overlap) — fewer, more-novel keyframes = lighter memory + less
    // redundant overlap.  With 6 frames this bounds a static/slow capture to
    // ~6×1.5 ≈ 9 s before the keyframe-count auto-finalize.  Overlap selectable in
    // the settings panel {10,15,20,30}% (native clamp floor 10%); cap clamps [3,10].
    maxKeyframes: 6,
    overlapThreshold: 0.20,
    maxKeyframeIntervalMs: 1500,
    // v0.21 — anti-blur keyframe selection ON by default (K=4).
    sharpnessWindow: DEFAULT_SHARPNESS_WINDOW,
    flow: DEFAULT_FLOW_GATE_SETTINGS,
  },
};
