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
   * be accepted.  Default 0.20 = 20% novel content per accept.
   * Lower = more frames accepted, larger panoramas.  Higher = fewer
   * frames, faster captures but more conservative about coverage.
   * Clamped to `[0.10, 0.80]` natively
   * (`IncrementalStitcher.swift:962`).
   */
  overlapThreshold: number;

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
    stitchMode: 'auto',
    warperType: 'plane',
    blenderType: 'multiband',
    seamFinderType: 'graphcut',
    enableMaxInscribedRectCrop: false,
  },
  frameSelection: {
    mode: 'flow-based',
    maxKeyframes: 6,
    overlapThreshold: 0.20,
    flow: DEFAULT_FLOW_GATE_SETTINGS,
  },
};
