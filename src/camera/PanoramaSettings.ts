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
   * Seam-finder strategy.
   *   `'graphcut'` (default) — optimal min-cost seams (COST_COLOR_GRAD)
   *     before blending (pair with multiband). Highest quality, but
   *     STRICTLY SERIAL and, per on-device profiling (fable review), ~41%
   *     of total stitch wall-time at fleet keyframe counts — the single
   *     biggest phase.
   *   `'voronoi'` — distance-based seams. Much cheaper than graphcut
   *     (potential ~1.7x end-to-end), but seams follow geometry not image
   *     content, so exposure/parallax mismatches can show as visible seams
   *     or ghosting. This is the real speed lever identified by profiling,
   *     but flipping the default to it REQUIRES on-device output-quality
   *     validation (SSIM + visual, per the range-matcher gate) because it
   *     changes pixels — see docs/perf-3b. Exposed here as opt-in; default
   *     stays graphcut until that gate passes.
   *   `'skip'` — no seam optimization (NoSeamFinder); streams warp+feed
   *     (pair with feather for the lowest-memory configuration). Cheapest,
   *     lowest quality.
   */
  seamFinderType: 'graphcut' | 'voronoi' | 'skip';

  /**
   * Output crop strategy.  `false` (default) crops to the bounding
   * rectangle of non-black pixels.  `true` runs the
   * max-inscribed-rectangle + morph-close pipeline — cleaner output
   * with no black corners, more CPU at finalize.
   */
  enableMaxInscribedRectCrop: boolean;

  /**
   * perf-3b — PANORAMA feature-matcher range.  `0`/undefined (default)
   * = OFF: the stock full-pairwise `BestOf2NearestMatcher`
   * (byte-identical to before this knob existed).  `> 0` enables the
   * `BestOf2NearestRangeMatcher`, which matches only keyframes
   * within `|i − j| < width` — keyframes are strictly capture-ordered,
   * so on a linear shelf pan the skipped non-adjacent pairs share ~no
   * overlap and their O(N²) matching is wasted work.  Since the
   * 2026-08-17 flattened stitch ladder, every high-level rung runs the
   * **consecutive-only window (2)** — the wider-window escalation was
   * one of the levers behind a 30-minute bundle-adjust wedge and was
   * removed; the widening 2/2/width schedule survives only on the
   * legacy manual-opt-in fallback path.  This replaces the
   * full-pairwise matcher; pan-back captures (distant overlap) are
   * handled at capture time (perf-5), not by a rescue here.
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

  /**
   * perf-4a — compositing-resolution adaptation MODE (Android). Shrinking the
   * final panorama to `adaptiveMinOutputMP` makes the stitch faster on slow
   * devices at the cost of output pixels (a downstream OD/OCR trade-off to
   * field-test). Three positions:
   *
   *   `'off'` (default) — never shrink; compose stays 1.0 MP. Byte-identical
   *      (no SharedPreferences or header touch).
   *   `'always'` — DETERMINISTIC: cut every finalize to `adaptiveMinOutputMP`,
   *      unconditionally. No measurement, no persistence. This is the clean A/B
   *      TREATMENT — every capture is shrunk the same way, so `off` vs `always`
   *      is a controlled comparison of "does shrinking hurt detection?".
   *   `'measured'` — SELF-TUNING (the "thermostat"): shrink only on devices a
   *      persisted rolling median of per-keyframe stitch wall time
   *      (`stitchWallMs / acceptedCount`) proves slow (> `adaptiveSlowStitchMs
   *      PerFrame`), with hysteresis. Two invariants keep it honest: (1) it
   *      never cuts before it has measured THIS device (≥3 real samples), so
   *      the first cut is never a cold-start/thermal fluke or a core-count
   *      guess; (2) while cutting, every 4th finalize is a default-budget PROBE
   *      that re-measures, so a recovered device un-fires — the regime never
   *      latches permanently. This is the mode you'd SHIP once the A/B confirms
   *      shrinking is safe; it only helps the devices that need it.
   *
   * `appliedBudgets.source` on the result reports which path ran
   * (`default`|`seeded`|`probe`|`adapted`|`always`|`decode-failed`). See
   * docs/perf-4a.
   */
  adaptiveStitchMode?: 'off' | 'always' | 'measured';
  /**
   * perf-4a — floor (megapixels) the compositing resolution is cut to. Default
   * `0.6` (the downstream OD/OCR minimum). Native clamps to `[0.6, 1.0]`: `0.6`
   * is the hard OD/OCR floor, `1.0` (the default budget) makes a "cut" a no-op —
   * a value above the default would RAISE resolution and pollute the measured
   * history. Consulted by `adaptiveStitchMode` `'always'` and `'measured'`.
   */
  adaptiveMinOutputMP?: number;
  /**
   * perf-4a — the per-keyframe stitch-wall-time median (ms) above which a
   * device is considered slow and compose adaptation fires. Default `1000`
   * (estimated; calibrate against Phase 0 `stitchWallMs`). Only consulted when
   * `adaptiveStitchMode` is `'measured'` (`'always'` ignores it).
   */
  adaptiveSlowStitchMsPerFrame?: number;
  /**
   * RCA / diagnostics — when `true` (Android), a successful finalize writes a
   * self-describing `pack.json` next to the (already-persisted) keyframe JPEGs
   * in the capture session dir under `cacheDir`. The pack records the device,
   * the full stitch recipe, the result dims/frame counts, and the timing
   * decomposition (`stitchWallMs` = RN-version-invariant native cost;
   * `queueDelayMs` = bridge/JS) — so a field capture can be pulled and replayed
   * OFFLINE instead of eyeballed. `false`/undefined (default) = OFF, no write.
   * Pure diagnostic; never alters the stitch. See the offline compare tool.
   */
  debugPack?: boolean;
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
   * longer than this without a keyframe.  `0` disables it.  Default
   * `1500` (1.5 s).  Maps to the native gate's
   * `setMaxKeyframeIntervalMs`.
   *
   * These accepts count toward `maxKeyframes`.  Whether one may be the
   * accept that REACHES the cap — and so end the capture, since the cap
   * is the primary auto-stop — is controlled by
   * `timeIntervalCanFinalize` below.  Before v0.25 they always could,
   * which meant a perfectly stationary hold self-finalised on the clock
   * alone: at these defaults, ~7.5 s having captured nothing new.
   */
  maxKeyframeIntervalMs: number;

  /**
   * v0.25 — may a keep-alive accept (one made by
   * `maxKeyframeIntervalMs` rather than by novelty) be the accept that
   * REACHES `maxKeyframes` and therefore auto-finalises the capture?
   *
   * `true` (default) is the pre-v0.25 behaviour, bit-for-bit.
   *
   * `false` stops a stationary hold ending itself on the clock:
   * keep-alive accepts still happen and still count, but the gate
   * stalls at `maxKeyframes - 1` rather than tripping the auto-stop, so
   * only genuinely NEW content can finish a capture.
   *
   * Deliberately not implemented as "don't count them".  The host
   * auto-finalises on the number of keyframes SAVED, which no gate
   * counter can influence on Android; and exempting them would leave a
   * stationary capture with no bound at all (`maxPanDurationMs`
   * defaults to `0`, and the drift finalisers are motion-triggered), so
   * it would fill the disk and then fail in `cv::Stitcher`.
   *
   * CAUTION: with this `false` — and especially alongside the v0.25 AR
   * pose-trust gating — a capture that never pans has no count-based
   * auto-stop left, only shutter release.  Set `maxPanDurationMs > 0`
   * as a wall-clock backstop unless that is genuinely intended.
   */
  timeIntervalCanFinalize: boolean;

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
    // perf-3b — DEFAULT stays 'graphcut'. A default flip to voronoi (~1.7x)
    // was tried and REVERTED: an adversarial seam-quality review (fable) with
    // a seam-isolated probe on a synthetic SHELF corpus showed voronoi's
    // content-blind seams TEAR product labels at parallax (graphcut routes
    // around them through inter-facing gaps) — worst exactly on repetitive
    // v0.24 — DEFAULT flipped to voronoi.  The on-device A/B the earlier note
    // asked for ran (2026-08-11/12, A35 + iPhone, 5 and 8-10 keyframes, same
    // frames re-stitched): voronoi is 1.6-1.9x faster and VISUALLY IDENTICAL to
    // graphcut (no ghosting/seam tears; SSIM ~0.95 where output dims match), on
    // both devices, at both frame counts.  It is the single dominant stitch-
    // speed lever.  graphcut remains available (perf.seamFinderType='graphcut')
    // for corpora where near-field parallax makes seam placement matter; re-
    // validate there before assuming parity.  See docs/perf-3b.
    seamFinderType: 'voronoi',
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
    // v0.24 — DEFAULT flipped to 0 (auto-multi).  A prior fleet note claimed
    // single-threaded was fastest, but the 2026-08-12 same-frames ablation at
    // 8-10 keyframes on the A35 measured single-threading CONSISTENTLY SLOWER
    // than multi (-12..-23% in both captures); it also matches iOS, which is
    // always multi-core (GCD, ignores this field).  `1` remains the single-
    // thread kill-switch — note multi uses higher PEAK RAM (the original reason
    // for the `1` default), now mitigated by running the stitch on a stable
    // dedicated thread; revert to `1` if a device regresses on the memory gate.
    numThreads: 0,
    // perf-4a — measured compose-resolution adaptation ON by default (0.23):
    // 'measured' downscales the final compose to adaptiveMinOutputMP ONLY when
    // a stitch is measured to be slow.  Set 'off' to disable, 'always' to force.
    adaptiveStitchMode: 'measured',
    adaptiveMinOutputMP: 0.6,
    adaptiveSlowStitchMsPerFrame: 1000,
    debugPack: false,
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
    timeIntervalCanFinalize: true,
    // v0.21 — anti-blur keyframe selection ON by default (K=4).
    sharpnessWindow: DEFAULT_SHARPNESS_WINDOW,
    flow: DEFAULT_FLOW_GATE_SETTINGS,
    // v0.23 — anti-blur CAPTURE controls ON by default (the recommended
    // starting values: 8 ms exposure cap, 1.0 rad/s motion gate, 0.6 softness
    // floor, high-fps format).  Each knob is independently opt-OUT via
    // frameSelection.antiBlur (set a value to 0 / false to disable it); the
    // all-off baseline is DEFAULT_ANTI_BLUR_SETTINGS.
    antiBlur: { ...DEFAULT_ANTI_BLUR_SETTINGS, ...SUGGESTED_ANTI_BLUR_SETTINGS },
  },
};
