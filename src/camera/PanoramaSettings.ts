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

  /**
   * Anti-blur capture controls (v0.23).  ALL OFF BY DEFAULT — omitting
   * this sub-tree reproduces today's behaviour exactly.  See
   * [AntiBlurSettings] for what each knob attacks.
   */
  antiBlur?: AntiBlurSettings;
}


/**
 * Anti-blur capture controls — the mechanisms that attack motion blur
 * at its SOURCE, complementing `sharpnessWindow` (which only picks the
 * sharpest of the frames it is given).
 *
 * Motion blur extent ≈ angular-velocity × exposure-time.  A smooth
 * continuous pan blurs EVERY frame in a selection window by the same
 * amount, so best-of-K has nothing better to pick — the selector only
 * wins on the operator's natural micro-pauses.  These knobs shorten the
 * exposure term, gate on the velocity term, and refuse frames that are
 * anomalously soft for the scene.
 *
 * Every field is optional and defaults to "off / today's behaviour":
 * a host that never sets `antiBlur` is byte-identical to v0.22.
 */
export interface AntiBlurSettings {
  /**
   * (1) EXPOSURE CAP — the root-cause fix.  Maximum exposure time, in
   * milliseconds, requested from the camera while a panorama sweep is
   * running; the driver raises ISO to compensate and the cap is
   * released when the sweep ends.
   *
   * Why trade noise for speed: sensor noise is recoverable (denoise,
   * and multi-band blending averages the overlap region across frames),
   * while motion blur is NOT — deconvolution isn't viable on-device,
   * and smeared frames also degrade feature matching, so blur corrupts
   * the stitch GEOMETRY, not just the look.
   *
   * Suggested 8 ms (1/125 s) for shelf work; 4 ms (1/250 s) for fast
   * operators in good light.  0 / omitted = don't touch exposure.
   *
   * ⚠ HOST-APPLIED ON EVERY PLATFORM TODAY.  This library never owns the
   * capture session: the non-AR path is react-native-vision-camera's
   * (AVCaptureSession / CameraX), and the AR paths are ARKit's and
   * ARCore's, neither of which exposes an exposure API at all.  The
   * value is therefore parsed, clamped and logged, but the LIBRARY does
   * not apply it — fighting the session owner for device configuration
   * would race its reconfigures and could not hold the cap as an
   * invariant.  It is carried so hosts and diagnostics share one number.
   *
   * What actually caps exposure, per path:
   *   • iOS / Android non-AR — the HOST sets it on vision-camera.  The
   *     reachable lever is `minFps` (+ a high-fps `format`): vision-
   *     camera maps it to `activeVideoMaxFrameDuration`, and AE cannot
   *     expose longer than a frame interval, so `minFps: 60` ⇒ ≲1/60 s.
   *     On Android the stronger option is Camera2 interop
   *     (`Camera2CameraControl`: CONTROL_AE_MODE_OFF +
   *     SENSOR_EXPOSURE_TIME + a compensating SENSOR_SENSITIVITY).
   *     NOTE: vision-camera's `exposure` prop is NOT this — it maps to
   *     `setExposureTargetBias` (EV bias only).
   *   • iOS AR (ARKit) / Android AR (ARCore) — no exposure API exists.
   *     Use {@link preferHighFpsFormat}, which the library DOES apply:
   *     a ≥60 fps capture format bounds exposure by construction.
   */
  maxExposureMs?: number;

  /**
   * (2) MOTION GATE — hold keyframe commit while the device is slewing
   * faster than this (rad/s, magnitude about the pan axis).  Converts
   * "commit a blurred keyframe" into "wait a beat"; the selection
   * window stays open meanwhile, so the wait costs nothing and the
   * frames that arrive once the operator steadies are simply better
   * candidates.
   *
   * Reference points: the JS pan coach buckets at 0.5 rad/s (good) and
   * 1.0 rad/s (warn), so ~1.0 gates only genuinely-too-fast sweeps.
   * 0 / omitted = no motion gating.
   */
  maxCommitPanRateRadPerSec?: number;

  /**
   * (3) RELATIVE SHARPNESS FLOOR — hold commit while the best candidate
   * scores below this FRACTION of the running median of the keyframes
   * already accepted this capture.
   *
   * Variance-of-Laplacian is content-dependent (a blank wall scores ~0
   * however sharp), which is why the selection window never uses an
   * absolute threshold.  A ratio against the session's own median keeps
   * that self-calibrating property while adding the one judgement the
   * window structurally cannot make: "ALL of these candidates are
   * anomalously soft".
   *
   * ~0.6 flags clearly-softer-than-usual frames.  0 / omitted = off.
   */
  minScoreFractionOfMedian?: number;

  /**
   * Forward-progress guarantee for (2) and (3): never hold the same
   * pending keyframe more than this many consecutive evaluated frames.
   * Protects against an operator who simply cannot steady (moving
   * vehicle, tremor) — after this many holds the frame is committed
   * regardless.  Default 12; 0 disables the cap (not recommended).
   */
  maxConsecutiveHolds?: number;

  /**
   * (5) HIGH-FRAME-RATE CAPTURE FORMAT — prefer the highest-fps camera
   * format available instead of the smallest.  Two compounding wins:
   * a shorter frame interval bounds exposure time by construction
   * (60 fps ⇒ ≤ 1/60 s), and twice the frames per second means twice
   * the candidates in each selection window.
   *
   * This is the ONLY exposure lever available on the iOS AR path, where
   * ARKit owns the capture device.  Costs more live-stream throughput,
   * so it is opt-in.  Default false.
   */
  preferHighFpsFormat?: boolean;
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


/**
 * v0.23 — canonical default for `frameSelection.antiBlur`: every
 * source-side anti-blur control OFF, so the release is byte-identical
 * to v0.22 for hosts that don't opt in.
 *
 * Why off rather than a "sensible" default: the right exposure cap and
 * pan-rate gate depend on the deployment's light levels and how fast
 * its operators actually sweep. A global default would either be too
 * aggressive (noisy frames, stalled captures in dim aisles) or too weak
 * to matter. `maxConsecutiveHolds` is the exception — it is a SAFETY
 * cap, so it carries a real value that only takes effect once one of
 * the hold-producing knobs is enabled.
 */
export const DEFAULT_ANTI_BLUR_SETTINGS: Required<AntiBlurSettings> = {
  maxExposureMs: 0,
  maxCommitPanRateRadPerSec: 0,
  minScoreFractionOfMedian: 0,
  maxConsecutiveHolds: 12,
  preferHighFpsFormat: false,
};


/**
 * Recommended STARTING values for a retail-shelf deployment, for hosts
 * that want the anti-blur controls on without tuning from scratch:
 * a 1/125 s exposure ceiling, a motion gate just above the pan coach's
 * "warn" bucket, a 0.6 softness floor, and the high-fps format (the
 * only exposure lever that reaches the iOS AR path).
 *
 * NOT applied automatically — spread it into `frameSelection.antiBlur`
 * to adopt it, then tune per deployment.
 */
export const SUGGESTED_ANTI_BLUR_SETTINGS: AntiBlurSettings = {
  maxExposureMs: 8,
  maxCommitPanRateRadPerSec: 1.0,
  minScoreFractionOfMedian: 0.6,
  maxConsecutiveHolds: 12,
  preferHighFpsFormat: true,
};


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
    // v0.23 — anti-blur CAPTURE controls, all OFF by default so this
    // release is byte-identical to v0.22 for every existing host. The
    // selection window (above) keeps working exactly as before; these
    // add the source-side levers a host opts into per-deployment (light
    // levels and operator pace differ too much for a safe global
    // default). See AntiBlurSettings for the recommended starting
    // values (8 ms exposure cap, 1.0 rad/s motion gate, 0.6 floor).
    antiBlur: DEFAULT_ANTI_BLUR_SETTINGS,
  },
};
