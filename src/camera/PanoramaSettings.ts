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
    flow: {
      noveltyPercentile: 0.85,
      evalEveryNFrames: 5,
      maxTranslationCm: 50,
      maxCorners: 150,
      qualityLevel: 0.01,
      minDistance: 10,
    },
  },
};


// ═════════════════════════════════════════════════════════════════════
// SlitscanSettings — Layer 2 hosts using the slit-scan engine.
// ═════════════════════════════════════════════════════════════════════

/**
 * Settings for slit-scan stitching engines (`slitscan-rotate`,
 * `slitscan-both`, `firstwins-rectilinear`).  Reached via
 * `incremental.start({ engine: '<variant>', config: { ... } })`,
 * NOT via <Camera> (which always uses batch-keyframe).  Each
 * sub-tree corresponds to a section of the native `RLISStitcherConfig`
 * the slit-scan engine reads at start.
 *
 * Field-by-field native consumer references are documented in
 * `OpenCVSlitScanStitcher.mm` / `OpenCVIncrementalStitcher.h`.
 */
export interface SlitscanSettings extends CaptureBaseSettings {
  /**
   * Which slit-scan variant the engine runs.  All three share the
   * same painting + registration + plane configuration; they differ
   * in their internal motion model (rotation-only vs combined
   * translation+rotation, and slit position).
   *
   *   • `'slitscan-rotate'`         — preferred name; rotation-only
   *     motion model.
   *   • `'slitscan-both'`           — combined translation + rotation
   *     motion model.
   *   • `'firstwins-rectilinear'`   — legacy alias of
   *     `'slitscan-rotate'` (V13.0a naming).  Accepted natively
   *     but new code should prefer the canonical name.
   */
  variant: 'slitscan-rotate' | 'slitscan-both' | 'firstwins-rectilinear';

  /** Where the per-accept slit is taken from + how it's blended. */
  painting: SlitscanPaintingSettings;

  /** Frame-to-frame registration (NCC + RANSAC + triangulation). */
  registration: SlitscanRegistrationSettings;

  /** Plane projection (ARKit-detected, virtual, or disabled). */
  plane: PlaneProjectionSettings;

  /**
   * Advanced motion-tuning knobs that the v0.3 modal never exposed.
   * Both are read by the native side
   * (`IncrementalStitcher.swift:1074, 1077`) and have sensible
   * defaults; most consumers can leave this field undefined.
   */
  advanced?: SlitscanAdvancedSettings;
}


export interface SlitscanAdvancedSettings {
  /**
   * Fraction of the pan-axis sensor extent used to compute the
   * per-frame slit width.  Range `[0.05, 0.90]`, default 0.70
   * (engine internal).  Higher = wider slits = fewer accepts per
   * pan.  Set this only if you know what the slit-scan motion
   * model needs for your specific capture geometry.
   * Native key: `kPanAxisFractionRect`.
   */
  panAxisFractionRect?: number;

  /**
   * Minimum pan-axis delta (in canvas pixels) between consecutive
   * accepted strips.  Acts as a hard floor below which subsequent
   * frames are rejected regardless of NCC scores.  Range
   * `[0, 500]`, default 0 (no floor).  Native key:
   * `kMinAcceptDeltaPx`.
   */
  minAcceptDeltaPx?: number;
}


export interface SlitscanPaintingSettings {
  /**
   * How new strips are blended into already-painted canvas pixels.
   *
   *   • `'FirstPaintedWins'` (default) — preserve the first frame's
   *     content at any pixel; later strips don't overwrite.
   *   • `'FeatherBlend'`               — alpha-blend new strips into
   *     already-painted areas at slit boundaries.  Smooths visible
   *     seams when many narrow slits stack.
   */
  paintMode: 'FirstPaintedWins' | 'FeatherBlend';

  /**
   * Where on the camera frame the per-accept slit is sampled from.
   * For a typical landscape vertical pan tilting DOWN, the leading
   * edge (new content) is at the BOTTOM of the camera frame; for
   * upward tilt, it's at the TOP.  `'Center'` is the V13.x default.
   */
  sliverPosition: 'Center' | 'Bottom' | 'Top';

  /**
   * When `true`, the very first frame's FULL frame is painted onto
   * the canvas (not just the configured slit clip).  Default
   * `true` — gives the panorama a wider initial anchor that
   * subsequent slits extend from.  Set false if you want strict
   * slit-only behaviour even on the first frame.
   */
  firstFrameFullFrame: boolean;
}


export interface SlitscanRegistrationSettings {
  /**
   * 3D triangulation step.  Cross-references features across
   * multiple frames to estimate scene depth.  Default `false` (off);
   * adds latency, useful for parallax-heavy captures.
   */
  enableTriangulation: boolean;

  /**
   * Triangulation accumulator — when `enableTriangulation` is on,
   * keeps a running pose graph across the whole capture.  Default
   * `false` (off); needed for multi-shot fusion.
   */
  enableTriAccumulator: boolean;

  /**
   * RANSAC homography fit per pair.  Adds robustness to feature
   * matching at the cost of a few ms per frame.  Default `false`.
   */
  enableRansacHomography: boolean;

  /**
   * 1D NCC strip alignment.  Present iff enabled.  Default
   * undefined (disabled); engine uses pure feature matching.
   */
  ncc1d?: Ncc1dSettings;

  /**
   * 2D NCC strip alignment.  Present iff enabled.  More expensive
   * than 1D NCC; needed for shelf-scan captures with vertical
   * misalignment.  Default undefined (disabled).
   */
  ncc2d?: Ncc2dSettings;
}


export interface Ncc1dSettings {
  /**
   * Search radius in working-resolution pixels (along the pan axis).
   * Clamped to `[5, 60]`.  Default 15 when the field is set.
   */
  searchRadius: number;
}


export interface Ncc2dSettings {
  /**
   * 2D search margin in pixels (rectangular region around the
   * predicted strip position).  Clamped to `[4, 60]`.  Default 12.
   */
  searchMargin: number;

  /**
   * Minimum NCC score to accept a match.  Below this the engine
   * falls back to the predicted (pose-only) position.  Clamped
   * to `[0.30, 0.99]`.  Default 0.99 (only accept very strong
   * matches; the canvas falls back to pose-only quickly).
   */
  confidenceThreshold: number;

  /**
   * EMA smoothing of the NCC-derived offset across consecutive
   * strips.  Present iff enabled.  Default undefined.  Useful
   * for jittery captures.
   */
  emaSmoothing?: { alpha: number };

  /**
   * Pan-axis-lock — when enabled, the NCC offset is constrained
   * to the dominant pan axis (cross-axis movement bounded by
   * `crossAxisLockPx`).  Useful when the operator's hand wobble
   * introduces unwanted cross-axis motion.  Present iff enabled.
   */
  panAxisLock?: { crossAxisLockPx: number };
}


export interface PlaneProjectionSettings {
  /**
   * Where the plane the slit-scan projects onto comes from.
   *
   *   • `'Disabled'`       — no plane projection; engine runs
   *                          its baseline slit-scan path.
   *   • `'ARKitDetected'`  — use the first vertical plane that
   *                          ARKit/ARCore finds AND whose normal
   *                          aligns with the camera (filtered by
   *                          `alignmentThreshold`).  Requires
   *                          `captureSource === 'ar'`.
   *   • `'Virtual'`        — synthesise a plane at a fixed depth
   *                          (`virtualDepthMeters`) in front of the
   *                          camera at first-frame pose.  No
   *                          ARKit dependency.
   */
  source: 'Disabled' | 'ARKitDetected' | 'Virtual';

  /**
   * How frames are warped onto the plane.  Only consulted when
   * `source !== 'Disabled'`.  Default `'Rectified'` for slit-scan.
   */
  projectionStyle?: 'Trapezoidal' | 'Rectified';

  /**
   * Depth in metres for `source === 'Virtual'`.  Range `[0.3, 5.0]`,
   * default 1.5.  Set close to the actual shelf distance for the
   * cleanest projection.
   */
  virtualDepthMeters?: number;

  /**
   * Minimum `|planeNormal · cameraForward|` for an ARKit-detected
   * plane to be accepted (when `source === 'ARKitDetected'`).
   * Range `[0, 1]`, default 0.6 (≈ 53° max off-axis).  Higher =
   * stricter, only accept very-on-axis planes.
   */
  alignmentThreshold?: number;
}


export const DEFAULT_SLITSCAN_SETTINGS: SlitscanSettings = {
  captureSource: 'ar',
  debug: false,
  variant: 'slitscan-rotate',
  painting: {
    paintMode: 'FirstPaintedWins',
    sliverPosition: 'Bottom',
    firstFrameFullFrame: true,
  },
  registration: {
    enableTriangulation: false,
    enableTriAccumulator: false,
    enableRansacHomography: false,
    // ncc1d / ncc2d omitted — both disabled by default.
  },
  plane: {
    source: 'ARKitDetected',
    projectionStyle: 'Rectified',
    virtualDepthMeters: 1.5,
    alignmentThreshold: 0.6,
  },
};


// ═════════════════════════════════════════════════════════════════════
// HybridSettings — RetaiLens-specific live engine.
// ═════════════════════════════════════════════════════════════════════

/**
 * Settings for the hybrid live-compositing engine
 * (`incremental.start({ engine: 'hybrid', ... })`).  Most consumers
 * won't touch this — the hybrid engine is RetaiLens-specific and
 * the public lib's batch-keyframe pipeline is a better fit for
 * general-purpose captures.  Exported here for completeness.
 *
 * Important: the hybrid engine has internal preset paths
 * (`OpenCVIncrementalStitcher.mm:139-180`) that hard-set
 * `enableTriangulation`, `enable2dNcc`, `enableRansacHomography`,
 * `planeSource = Disabled`, etc.  Code-reviewer flagged that
 * exposing those fields would be misleading — the engine clobbers
 * any overrides.  So this type is intentionally minimal: only
 * `projection` is reliably operator-tunable.  Hosts that need to
 * reach deeper-level hybrid knobs can pass a raw config dict to
 * `incremental.start()` directly (Layer 2 escape hatch).
 */
export interface HybridSettings extends CaptureBaseSettings {
  /**
   * Internal projection during real-time compositing.  Independent
   * from the panorama-stitcher's warperType (which doesn't apply
   * to the hybrid engine — its output is the live canvas directly).
   *
   * Note: only effective in the rotation-only preset path (hybrid
   * preset 1).  In the other hybrid presets the engine forces
   * Planar internally regardless of this setting.  Native source:
   * `OpenCVIncrementalStitcher.mm:146,161,180`.
   */
  projection: 'Cylindrical' | 'Planar';
}


export const DEFAULT_HYBRID_SETTINGS: HybridSettings = {
  captureSource: 'ar',
  debug: false,
  projection: 'Planar',
};
