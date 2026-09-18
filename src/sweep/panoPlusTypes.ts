// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusTypes — the JS-side spelling of the `RNSSweepSession` native
 * contract (`ios/PanoPlus/PanoPlusBridge.{swift,m}` →
 * `ios/RNISPanoCore.{h,mm}` → `cpp/rnis_pano.{hpp,cpp}`).
 *
 * ⚠️ THIS FILE IS A MIRROR, NOT A DESIGN. Every field below is a key native
 * actually emits; every option is a key `RNISPanoCore.startWithOptions:`
 * actually reads. A field that exists here and not there is silently
 * `undefined` at runtime, and an option that exists here and not there is
 * silently ignored — neither fails loudly, which is exactly why the mapping is
 * written out key-by-key with the native source named beside it rather than
 * inferred from a doc.
 *
 * PURE: no `react-native` import, so the model layer that consumes these types
 * stays node-testable (the SDK's jest `pure` project runs with React and RN
 * stubbed — anything that reaches for a native module is untestable there by
 * construction).
 *
 * ── WHY pano+ EXISTS AT ALL, in one paragraph, because the types below only
 * make sense against it ────────────────────────────────────────────────────
 * The offline replay of three operator-shot 30 fps sweeps validated the strip
 * mechanics (zero breaks, advance-computed width tracking a 2× speed change,
 * the high-water rule holding 142/350 backtrack frames with zero duplication)
 * and left ONE residual: a lateral wobble with slat compression — the signature
 * of unmodeled pitch/yaw, which image-only registration cannot observe at
 * 1-frame baselines. The iPhone pano is straight because the gyro measures all
 * three rotation DOFs in hardware. So pano+ consumes real per-frame ARKit
 * attitude + intrinsics and rectifies each strip before painting, and
 * {@link PanoPlusEngineOptions.rectify} is the A/B arm that TESTS that
 * hypothesis rather than assuming it. See
 * the slit-scan revival approved 2026-08-19.
 */

/** Per-frame engine decision — `rnis::pano::outcomeName` (rnis_pano.cpp:43). */
export type PanoPlusOutcome =
  | 'painted'
  | 'held-backtrack'
  | 'held-frontier'
  | 'skipped-no-advance'
  | 'rejected-low-response'
  | 'rejected-out-of-cage'
  | 'rejected-pose-speed'
  | 'rejected-rectify'
  | 'rejected-tracking'
  | 'rejected-input'
  | 'warming-up'
  | 'bootstrap'
  | 'gap-extended'
  | 'gap-break'
  | 'gap-backfilled'
  | 'tail-flush'
  | 'aborted'
  | 'canvas-full'
  | 'unknown';

/**
 * Why a sweep was ABANDONED. Null on a healthy sweep. Every one of these is a
 * VISIBLE stop by design (NF3: "a silently wrong facing count is worse than
 * any visible artifact") — the engine never widens a search to recover.
 *
 *  - `tracking-lost`     ARKit tracking went `notAvailable` and stayed there
 *                        for `maxRejectRunFrames`; there is no attitude to
 *                        rectify with. NOTE a `.limited` blink is NOT this —
 *                        it is counted (`counts.limitedFrames`) and the sweep
 *                        continues, because `.limited(.excessiveMotion)` fires
 *                        during exactly the pan pano+ asks for.
 *  - `tracking-limited`  only when {@link PanoPlusEngineOptions.abortOnLimitedTracking}
 *                        was explicitly turned on.
 *  - `session-restart`   a translation discontinuity ⇒ ARKit re-ran with a NEW
 *                        world origin (an `ARCameraView` unmount does exactly
 *                        this, and plugin registration SURVIVES it — so the
 *                        engine has to detect it itself or it would fuse two
 *                        coordinate frames into one canvas).
 *  - `chain-lost`        the bounded correlation search could not find a
 *                        confident match for `maxRejectRunFrames` (~2 s).
 *  - `canvas-full`       the sweep exceeded `canvasMaxWidthPx`.
 *  - the rest are engine-internal degeneracies, kept as literals so a pack
 *    reader never has to guess.
 */
/** The three physical holds, named here rather than in `panoPlusModel` so a
 *  start option can reference them without the types module depending on the
 *  decision module. {@link PanoPlusHold} is an alias of this. */
export type PanoPlusHoldName = 'landscape' | 'portrait' | 'portrait-upside-down';

/**
 * WHICH PRODUCER FEEDS THE ENGINE.
 *
 * `'ar'` is the shipped path and the default on BOTH flag baselines: ARKit
 * frames + ARKit attitude, exactly as every pano+ pack to date was recorded.
 * `'imu'` is the decoupled arm — an `AVCaptureSession` on the physical
 * ultra-wide at 60 fps with attitude from `CMDeviceMotion` sampled at `pts + τ`.
 *
 * THE TWO ARE MUTUALLY EXCLUSIVE AT THE HARDWARE. ARKit and an
 * `AVCaptureSession` cannot hold the camera at the same time, so this is a
 * selection and never a blend — which is also why it is a string and not a
 * boolean pair that could be set to an impossible combination.
 */
export type PanoPlusPoseSource = 'ar' | 'imu';

export type PanoPlusAbort =
  | 'tracking-lost'
  | 'tracking-limited'
  | 'session-restart'
  | 'chain-lost'
  | 'canvas-full'
  | 'format-change'
  | 'nonmonotonic-timestamp'
  | 'reference-footprint-degenerate'
  | 'canvas-alloc-failed'
  | (string & {});

/** Which frames the pack keeps. `'all'` is the default and the field value —
 *  the pack IS the experiment, and a frame not written is a residual that can
 *  never be recomputed offline. */
export type PanoPlusPackFrames = 'all' | 'painted' | 'none';

/**
 * Every `rnis::pano::Config` knob, 1:1 with
 * `RNISPanoCore.startWithOptions:` (RNISPanoCore.mm:318-346). Defaults live in
 * NATIVE (`cpp/rnis_pano.hpp`) and are re-emitted, fully resolved, into the
 * pack's `meta.json` — so this layer deliberately declares them all optional
 * and passes only what the host actually chose. Duplicating the numeric
 * defaults here would create a second source of truth that drifts silently.
 */
export interface PanoPlusEngineOptions {
  /** Canvas resolution as a fraction of the source raster (native 0.5). */
  canvasScale?: number;
  /** Strip width = |advance| × this (native 1.25). */
  stripMargin?: number;
  /** |Δu| at or below this ⇒ `skipped-no-advance` (native 0.5 canvas px). */
  minAdvancePx?: number;
  /** ALIASING CAGE, absolute. 0 ⇒ derived from {@link maxAdvanceFrac}. */
  maxAdvancePx?: number;
  /** Cage as a fraction of the frame width (native 0.10). */
  maxAdvanceFrac?: number;
  /** Pose-side lurch gate, m/s (native 1.2). Image-independent — this is what
   *  consuming ARKit translation buys: a jump big enough to WRAP the
   *  correlation window comes back measured SMALL and would sail through a
   *  measured-advance cage alone. */
  maxSweepSpeedMps?: number;
  /** Slack added to the pose-speed bound, metres (native 0.01). */
  poseSlackM?: number;
  /** THE HYPOTHESIS ARM. `true` (native default, and what the field build
   *  ships) rectifies every frame by its attitude delta to the sweep's
   *  reference before registering and painting. `false` is the CONTROL — the
   *  image-only arm the offline replay already ran, kept so the operator can
   *  shoot the same shelf twice and compare the residual wobble directly. */
  rectify?: boolean;
  /** Chained per-strip exposure match over the true overlap (native true). */
  gainMatch?: boolean;
  gainStepClamp?: number;
  gainCumClamp?: number;
  gainSampleMinPx?: number;
  /** Registration works on a downscaled grey window; this is the scale
   *  (native 0.5).  0.75 was MEASURED on 2026-08-24 and NOT adopted: it makes
   *  the estimator 0.64x quieter on triangle closure (4/4 packs) and does not
   *  measurably move the delivered wobble (0.945x, 95% CI [0.871, 1.034] over
   *  40 chain realisations), because the correlation residual is only ~26% of
   *  the local placement variance — the attitude channel carries the rest.
   *  Raising it also widens `corrCentroidBoxPx` automatically. */
  workScale?: number;
  /** Central correlation window width in source px (native 384). */
  phaseWindowPx?: number;
  /** Sub-pixel centroid support in WORK px; 0 (native) derives it from
   *  `workScale` so it always spans ~10 SOURCE px. */
  corrCentroidBoxPx?: number;
  /** Phase-correlation response floor (native 0.05). */
  minPhaseResponse?: number;
  /** Higher bar to RESUME from a hold — a held chain ages its reference
   *  window, and eventually a wrapped correlation would pass the ordinary
   *  floor (native 0.30). */
  stallResumeResponse?: number;
  /** Consecutive rejections before the sweep aborts `chain-lost` (native 60). */
  maxRejectRunFrames?: number;
  canvasInitWidthPx?: number;
  canvasMaxWidthPx?: number;
  /** Perpendicular slack applied ONCE at the axis latch (native 128 canvas
   *  px ≈ ±11 cm of hand drift at 0.6 m). Not the answer on its own — see
   *  {@link canvasGrowVertical}. */
  canvasPadPx?: number;
  /** Grow the canvas ACROSS the sweep axis when the hand drifts out of the
   *  band (native true). Off ⇒ the drifted content is discarded by the warp,
   *  which is exactly the failure that used to be invisible: the sweep-axis
   *  hole gate reports zero holes while the panorama loses shelf height.
   *  Whatever is still outside after growth is REPORTED either way — see
   *  {@link PanoPlusSummary.clipping}. */
  canvasGrowVertical?: boolean;
  /** Hard cap on the perpendicular dimension (native 2048 canvas px). */
  canvasMaxHeightPx?: number;
  /** THE memory cap, applied to both growth axes (native 18e6 px ⇒ ~72 MB
   *  steady across canvas + coverage). Growth past this is refused, which
   *  surfaces as `canvas-full` along the sweep and as reported clipping
   *  across it. */
  canvasMaxPixels?: number;
  /** Fill an interior gap from the PREVIOUS painted frame before declaring a
   *  hole (native true). Defence in depth: the clamped aliasing cage already
   *  makes an interior sweep-axis gap unreachable, and native's own test
   *  fails loudly if a knob change ever breaks that. */
  backfillGaps?: boolean;
  /** End the sweep on a single ARKit `.limited` frame (native FALSE). Leave
   *  it off: `.limited(.excessiveMotion)` fires routinely during the
   *  deliberate pan pano+ asks for, while the attitude the engine consumes
   *  stays gyro-driven and good. */
  abortOnLimitedTracking?: boolean;
  trackingWarmupFrames?: number;
  /** Consecutive cage rejections before the HUD shows a hard stall (native 30). */
  cageStallFrames?: number;
  /** MINIMUM accepted frames before the axis/sign latch may fire (native 6).
   *  A minimum, not the rule — see {@link latchTotalPx}. */
  axisLatchFrames?: number;
  /** Total-position motion, in CANVAS px, that decides the latch (native 24 —
   *  1.5× the worst early reversal measured on the first device pack). The
   *  TOTAL (attitude + residual) is the only quantity the latch votes on: the
   *  residual alone is ≈ −(attitude) on a pivot, and the attitude alone is
   *  perpendicular to a shelf walk. */
  latchTotalPx?: number;
  /** RELATCH — the latch re-checks its own decision and corrects it if the
   *  canvas is not growing. Over a short horizon a rising hand transient and a
   *  real sweep are the same signal, so no threshold can separate them at the
   *  moment of the vote; the engine verifies instead. Motion, in CANVAS px,
   *  that a correction requires (native 24, ESCALATING per correction). */
  relatchMotionPx?: number;
  /** Panorama growth, as a fraction of ONE FRAME'S footprint along the sweep,
   *  past which the latch is self-evidently right and the re-check is disarmed
   *  for good (native 0.15). This is what stops a correction ever discarding a
   *  working panorama. */
  relatchCommitFrac?: number;
  /** How much the winning axis must beat the other before a correction is
   *  believed (native 1.5). Below it the evidence is called ambiguous — which
   *  is what a half-returned transient looks like — and the engine waits. */
  relatchDominance?: number;
  /** Accepted frames between re-checks (native 20 ≈ 0.33 s at 60 fps). Must
   *  span longer than a hand transient or the correction is decided by the
   *  same wobble that caused the mis-latch. Costs nothing when the latch was
   *  right: the check disarms before it ever fires. */
  relatchMinFrames?: number;
  /** Maximum corrections per session (native 3; 0 disables the mechanism). */
  relatchMaxCount?: number;
  /** Frames after which the latch decides on the best evidence available
   *  rather than waiting forever (native 240). Reaching it means NOTHING moved
   *  decisively; the pack records that the decision was weak. */
  axisLatchMaxFrames?: number;
  maxTranslationJumpM?: number;
  rectifyYawLimitDeg?: number;
  /** 0 auto · 1 horizontal · 2 vertical. */
  axisOverride?: number;
  /** 0 auto · ±1 forced sweep sign. */
  signOverride?: number;
  /** Crop the ragged top/bottom rectification leaves. Native default FALSE:
   *  the envelope is REPORTED instead, because a crop hides the very artifact
   *  the first packs exist to measure. */
  cropVertical?: boolean;

  // ── v5 (engineVersion 5) ────────────────────────────────────────────────
  /** The canvas surface. `0` planar — every frame rectified into FRAME 0's
   *  image plane, which is v4's canvas and whose area magnification grows as
   *  sec³θ off the reference axis without bound (measured 13.0× on the
   *  operator's 30.5° pivot pack). `1` sweep-cylindrical (native default,
   *  ships ON) — the along-sweep attitude is carried as ARC LENGTH and
   *  everything else stays on the tangent plane, so lines running ACROSS the
   *  sweep stay exactly straight.
   *
   *  NOT a regime selector: ψ ≡ 0 on a pure walk and the two arms are then
   *  byte-identical. Keep `1` unless running the A/B. */
  projection?: number;
  /** Bounds the ALONG-SWEEP excursion (native 120°). `rectifyYawLimitDeg` no
   *  longer does — it bounds the CROSS excursion, which is the part the
   *  homography actually carries. */
  sweepMaxDeg?: number;
  /** Give the placement one extra degree of freedom across the sweep (native
   *  true). v4 fits ONE translation in a window covering 20% of the cross
   *  extent and extrapolates it across the other 80%, so two strips meet
   *  correctly in the middle and diverge at the edges — which IS the visible
   *  cut. `false` reproduces v4's chain element for element. */
  crossSweepFit?: boolean;
  /** `1` per-frame image-fitted gradient — MEASURED AND NOT DEFAULTED,
   *  because its residual is scored against its own fit. `2` plane at
   *  {@link subjectDistanceM} (native default): the cross magnification is
   *  PREDICTED from the ARKit pose, so it cannot random-walk and the metric
   *  that scores it is independent of it. */
  crossFitMode?: number;
  /**
   * Integrate `(g − running mean of g)` instead of `g`. 1 = on, 0 = off.
   *
   * Mode 1 has no absolute anchor and random-walks: measured crossScale at
   * sweep end 0.8155 / 0.7776 / 0.6337 on three packs against 1.000000 on the
   * shipped path. Removing the steady part is what makes it usable.
   */
  crossFitDcRemove?: number;
  /**
   * Per-frame leak on log(cross scale) — bounds the mode-1 runaway directly.
   * 0 = off. Measured: the wobbling pack needs ~0.005 alongside the DC removal
   * to land at crossScaleEnd 0.9976 with no squash.
   */
  crossScaleLeak?: number;
  /**
   * Refuse the mode-1 gradient when the straight line through the cross windows
   * does not explain them. 0 = ungated.
   *
   * ⚠ INERT ON THE SHIPPED WINDOW COUNT. It needs ≥ 3 bands to have a residual
   * and the default configuration produces 2, so a line through them is exact
   * and R² reads 1.000 on every frame. Raising `crossWindows` to 5 is what
   * would make it bite; until then this knob is present and does nothing, which
   * is recorded here rather than left for someone to rediscover.
   */
  crossFitMinBandR2?: number;
  /** Correlation windows across the sweep (native 3, odd). Slot (K−1)/2 is
   *  v4's window verbatim, so the value driving the chain is unchanged. */
  crossWindows?: number;
  /** v8 — DRIVE THE CHAIN FROM THE RESPONSE-WEIGHTED, GRADIENT-CORRECTED MEAN
   *  of all K windows instead of the centre one. Native `false`, and that is a
   *  MEASUREMENT, not caution: it improves `seam.worstBand*` by 22-35% on all
   *  four operator packs, but `seam.worstBand*` IS the residual of the very
   *  measurements it averages — a least-squares centre must win on its own
   *  fit. Re-scored on the one seam instrument that cannot be fitted
   *  (`seam.canvasJog*`, committed pixels through the painting matrix) the
   *  same arm is 2 packs worse, 1 flat, 1 better. Turning it on sets
   *  `seam.bandSelfScored`; the pack, the live HUD (`⚠fit` beside the seam
   *  percentile) and the review screen all say the band numbers stopped being
   *  evidence, and the engine appends the same sentence to `integrityReason`
   *  AFTER deciding the verdict — never as a clause, which is what v8 first
   *  shipped and what pinned this arm to FAILED.
   *
   *  ⚠ REACHING IT ON DEVICE STILL NEEDS A REBUILD, and the claim that it does
   *  not was wrong: `PanoPlusCaptureSurface` spreads `packOptions` into the
   *  start call, but `DebugCameraScreen` — the only host that mounts pano+ —
   *  passes none, and there is no capture flag for it. A knob the field build
   *  cannot set is a knob only the offline twin can A/B. */
  crossAvgWindows?: boolean;
  crossSpanFrac?: number;
  crossGradMaxPerFrame?: number;
  /** |log(cross scale)| bound (native 0.50). A real search bound, not a
   *  post-hoc filter: breaches are clamped AND counted. */
  crossScaleCageFrac?: number;
  /** THE VIRTUAL PLANE, in metres (native 1.5). Answering the operator's own
   *  question with a measurement: moving this plane nearer or further does NOT
   *  change the warping — a virtual plane at any distance is the same
   *  projection surface, the `d` cancels — but it IS what sets the
   *  translation → canvas cross scale, which is where the cuts live. */
  subjectDistanceM?: number;
  /** Refine the plane distance online from the correlation windows (native
   *  true). Measured 0.69-1.14 m on the four device packs, and it beats every
   *  fixed distance tried (1.0 / 1.5 / 2.5 m) on every pack. */
  subjectDistanceAuto?: boolean;
  /** Measure the cut metric (native true). `false` makes the engine blind
   *  again and exists only so the cost can be measured. */
  seamMetrics?: boolean;
  /** Per-strip pull of the chained exposure back toward unity. Native 0 (OFF)
   *  — BUILT AND MEASURED, awaiting the operator's approval because it changes
   *  committed pixels on every pack. At 0.15 on the four device packs the
   *  end-to-end gain goes 0.72-0.76 → 0.93-0.96 (85% of a 24-28% monotone
   *  darkening removed) for a seam DC step p95 of 4.0 → 4.4 DN. */
  gainLeak?: number;
  /** v6 — EXACT radiometric normalisation from the camera's own per-frame
   *  exposure (native true). Strictly better than estimating gain from image
   *  overlap because it is not estimated at all: scene radiance is linear in
   *  `exposureDuration x ISO`, so every frame is scaled to the REFERENCE
   *  frame's exposure before any overlap fit runs, in LINEAR LIGHT via an
   *  sRGB LUT. IDENTITY when the metadata is absent — which is every pack
   *  captured before v6, so those replay byte-identically. */
  exposureNormalize?: boolean;
  /** Bound on the exposure ratio, native 4.0 (±2 stops). Outside it the
   *  metadata is not an exposure change, it is bad metadata: clamped AND
   *  counted, never trusted. */
  exposureGainClamp?: number;
  /** Shared LOW-GRADIENT pixels needed before a boundary's photometric step is
   *  measured at all (native 1500). */
  photoMinSamples?: number;
  /** "Low gradient" in DN per pixel (native 8). Photometry is only measurable
   *  where the scene has no structure of its own: on a textured pixel a
   *  quarter-pixel of misregistration moves the value more than any exposure
   *  step. */
  photoGradMaxDN?: number;
  /** Reporting floor for a boundary's uniformity (native 0.60). A boundary
   *  below it is COUNTED as a diagnostic, never excluded — excluding it would
   *  condition the percentiles on the boundaries that happened to look flat. */
  photoUniformMinFrac?: number;
  /** Window for the band metrics, in canvas columns along the sweep (native
   *  40). A per-boundary step of 0.2 DN is invisible; the same chain drifting
   *  over 40 columns is what the eye integrates. */
  photoLocalWindowPx?: number;

  // ── v10 (engineVersion 10) ──────────────────────────────────────────────
  /**
   * LENS UNDISTORTION — a GEOMETRIC-FIDELITY correction, native default TRUE.
   *
   * Not a wobble fix: that hypothesis was measured and refused (the
   * correlation window never leaves the raw frame centre, where the radial
   * field is zero). What it fixes is straightness — the lens puts 3.7-4.5
   * canvas px of cross displacement into the delivered panorama, of which
   * 0.67-0.78 px is affine-irreducible, the same curve on all four operator
   * packs.
   *
   * ON is safe on every device because the GATE decides, not the flag: the
   * coefficients are per (body, lens) and an unknown body paints exactly the
   * uncorrected pixels. The decision and what it was decided on land in the
   * pack's `meta.lens` and in the stop summary — an uncorrected pack SAYS it
   * was uncorrected.
   *
   * The device identity is NOT settable from here on purpose: native reads
   * the body from `uname` and the lens from AVFoundation, because a host that
   * could claim a body it is not would defeat the gate.
   */
  lensUndistort?: boolean;
  /** Fractional tolerance on fx ÷ imageWidth against the calibrated value
   *  (native 0.04). ARKit's own focus breathing moves it 0.5 % across a sweep;
   *  the ultra-wide sits at ≈0.37·W and the tele at ≈1.4·W. */
  lensFocalTolFrac?: number;
  /** Radius→scale LUT resolution (native 1024 — worst sampling error ~1e-4 px). */
  lensLutNodes?: number;

  // ── THE ELBOW FIX (2026-09-06) ──────────────────────────────────────────
  // The bend in the 09-05 packs is a HINGE where the flat seed and tail
  // blocks meet the tilted pose-chain strips. Four knobs, read by name on both
  // platforms (`RNISPanoCore.startWithOptions` / `engineKnobKeys`), and the
  // reason they are here is that the operator flips them on the phone without
  // a rebuild. Three of the four default OFF in the engine; `leadOutTraj`
  // defaults TRUE there but is only read while `crossTraj != 0`, so a host
  // that sends none of the four is byte-identical. This host always sends
  // all four (DebugCameraScreen.panoPlusOptions).
  /** TRAJECTORY CONTINUATION — may the seed and tail blocks continue the
   *  strips' cross-axis tilt instead of sitting flat? `0` off (as shipped);
   *  `1` chain; `2` overlap (the arm the offline twin measured: hinge +0.241
   *  → −0.028, preview lines x12 → x1.7). The far end of a block that keeps
   *  the tilt to its edge stretches ~1.2x — see {@link crossTrajRelaxPx}. */
  crossTraj?: number;
  /** How far past the join the tilt EASES OFF, in canvas px (native 0 = it
   *  does not; the block keeps the tilt to the far edge — the operator's FAN
   *  flavour). 100 is his RELAX flavour: the fan decays as exp(−Δu/100) so
   *  the far end stops stretching. Read only when {@link crossTraj} is on. */
  crossTrajRelaxPx?: number;
  /** Anchor the provisional lead-out on the COMMIT FRONTIER rather than the
   *  band's end (native false). With {@link crossTraj} on as well, the
   *  lead-out is placed under the tail's trajectory — which is what makes the
   *  growing edge agree with the strips it will become. */
  leadOutFromFrontier?: boolean;
  /** PREVIEW FOLLOWS TRAJECTORY — the live preview's growing edge is placed
   *  under the same trajectory the committed tail will take (native true):
   *  WYSIWYG, at a per-tick cost. `false` is cheap placement — the preview
   *  edge sits flat while the canvas does not. Preview only; the canvas and
   *  every parity surface are untouched by this knob. */
  leadOutTraj?: boolean;
  /* ⚠ THERE IS DELIBERATELY NO `lensModelOverride` / `lensK1` / `lensK2` HERE.
   * Native carries them, and native does NOT read them from this dictionary:
   * they are the one path that applies arbitrary radial coefficients to an
   * arbitrary body, which is exactly what the gate exists to prevent. Exposing
   * them to JS would make the safety gate advisory. They stay a C++ surface for
   * the host fixtures and the offline twin. */
}

/** Pack-writer knobs (RNISPanoCore.mm:356-364). */
export interface PanoPlusPackOptions {
  packFrames?: PanoPlusPackFrames;
  packFrameEveryN?: number;
  packFrameQuality?: number;
  packMaxFrames?: number;
  canvasQuality?: number;
  previewIntervalMs?: number;
  /** The live preview's fit box, in SWEEP terms: `Along` caps the extent the
   *  sweep is growing along, `Cross` the perpendicular one (native 2000 / 800
   *  — v9 raised them from 1400 / 360, and this doc still said the old pair
   *  until 2026-09-02). Given in sweep terms because the box has to TURN with
   *  the sweep — the operator pans top-to-bottom in landscape, so his panoramas
   *  are TALL, and the oriented 1400x220 box these replaced collapsed the
   *  preview to a 201x220 thumbnail that shrank as the sweep grew.
   *
   *  ⚠️ ANDROID SENDS A SMALLER BOX BY DEFAULT (1200 / 480) and it is a MEMORY
   *  decision, not a visual one — Fresco keys its bitmap cache by the full uri
   *  including this preview's `?v=<seq>` cache-bust, so every publish retains a
   *  new entry. See `PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG`. Anything set here
   *  still overrides it. */
  previewMaxAlong?: number;
  previewMaxCross?: number;
  /**
   * THE FRONTIER WINDOW — how much of the panorama the live preview shows,
   * as an along ÷ cross RATIO. 0 = the whole thing (what shipped before
   * 2026-08-30). Native default 1.44; the surface computes a per-phone value
   * with {@link panoPlusPreviewWindowMultiple} and passes it, and anything set
   * here overrides that.
   *
   * A ratio rather than a pixel count because the canvas is not sized until
   * the axis latches, while the KNEE — the ratio past which fitting the whole
   * panorama into a fixed panel stops gaining on-screen size and starts losing
   * it — is a property of the phone's chrome and is knowable at start().
   * Measured on a 390x844 portrait-locked window in the landscape hold: the
   * inked panel peaks at along ≈ 2000 canvas px and then collapses — 3.9 m of
   * shelf draws a 114x374 pt sliver at 7.1 source px per device px, 5.8 m
   * draws 76x374 pt at 10.7.
   *
   * Below the knee the window is longer than the band and native's path is
   * byte-identical to the whole-canvas one.
   */
  previewWindowCrossMult?: number;
  /** An EXPLICIT window in canvas px along the sweep. Overrides
   *  {@link previewWindowCrossMult} when > 0. For fixtures and A/B arms — a
   *  host cannot generally know the canvas scale, so the ratio is the knob
   *  that belongs to it. */
  previewWindowAlongPx?: number;
  /** The live preview JPEG's quality. Native 60 -> 82 on 2026-08-30: measured
   *  on pack 1's real canvas at true preview scale, q60 is 29.95 dB PSNR and
   *  q82 ~32.9 dB, for +0.2 ms of encode on the PREVIEW queue (never the
   *  ingest queue) and +57 kB per write. The preview is drawn at ~1.03 JPEG px
   *  per device px, so q60's blocking is being looked at directly rather than
   *  hidden by a downscale. */
  previewQuality?: number;
  /** Trim the UNPAINTED canvas pad off the live preview's cross axis (native
   *  default `true`). The canvas is one frame footprint plus TWO pads — 1920 x
   *  0.5 + 2 x 128 = 1216 rows on all three of the operator's packs — so 256
   *  rows (21%) are pad nothing ever paints. The preview took every one of
   *  them, which put black bars over a fifth of his panel and, because the
   *  panel hugs the preview's aspect, drew the shelf 21% smaller than the
   *  phone was willing to. It is the row UNION, so it can never cut a
   *  committed pixel and the ragged rectified edge stays visible — a different
   *  question from `cropVertical`, which cuts to the per-column intersection
   *  and stays finalize-only. `false` restores the previous bytes exactly. */
  previewCropPad?: boolean;
  /** v12 — composite the PROVISIONAL lead-out (commit frontier → the live
   *  frame's leading edge) into the preview, dimmed 18% so it cannot be
   *  mistaken for committed output. Without it the preview trails where the
   *  phone points by half the along-sweep field of view (42.8° on the
   *  ultra-wide), because strips commit only up to the frame's projected
   *  CENTRE — the operator's "the image is behind where my phone is
   *  pointing", verbatim. Preview only: the canvas and every parity surface
   *  are untouched. Native default true. */
  previewLeadOut?: boolean;


  /** v12 — apply the preview's row-union pad trim to the FINAL canvas too, so
   *  canvas.jpg and the last preview agree on aspect instead of differing by
   *  the two unpainted 128 px pads (18.6% black bars on the 2026-08-31
   *  packs). Union, never intersection: no committed pixel can be lost, and a
   *  degenerate band declines the trim. Changes deliverable DIMS — recorded
   *  by the engine-version bump to 12. Native default true. */
  canvasCropPad?: boolean;
  /** The share of wall time on the ingest queue the live preview may cost,
   *  percent (native 8). `previewIntervalMs` is a FLOOR: after each render
   *  native holds the next tick off until an EWMA of its own measured render
   *  cost fits this budget, so a dearer render slows the REFRESH RATE and
   *  never the sweep. 0 disables the throttle. */
  previewMaxDutyPct?: number;
  /** @deprecated The oriented box. Still accepted by native (mapped onto
   *  along/cross, which is what they meant for the horizontal sweep they were
   *  written for) — but a host that sets them is asserting an orientation it
   *  cannot know. Use {@link previewMaxAlong} / {@link previewMaxCross}. */
  previewMaxW?: number;
  /** @deprecated See {@link previewMaxW}. */
  previewMaxH?: number;
  packQueueMax?: number;
}

/** The full `start()` options bag. */
export interface PanoPlusStartOptions
  extends PanoPlusEngineOptions,
    PanoPlusPackOptions {
  /**
   * REQUIRED, absolute, and a PLAIN PATH — not a `file://` URI. Native calls
   * `NSFileManager createDirectoryAtPath:` which would happily create a
   * literal directory named `file:` under the CWD from a URI. The host owns
   * pack placement; native creates the tree.
   */
  sessionDir: string;
  /**
   * THE PHYSICAL HOLD, RECORDED INTO THE PACK — `'landscape'`, `'portrait'`
   * or `'portrait-upside-down'`, i.e. `panoPlusHoldOf(orientation)`.
   *
   * It reaches no config and no transform: native stores the string and
   * writes it to `meta.json`, and nothing reads it back. It exists because
   * the packs recorded `axis`, `sweepSign` and `axisOverride` but NOT how the
   * phone was held, so establishing which hold a pack came from meant
   * deriving it from `referenceQuat` — sound, and still a derivation. Every
   * claim about the sweep direction, the coach arrow and the preview panel
   * hangs off that hold, and portrait is precisely the case it has never been
   * checked against.
   *
   * Optional, so an older host omitting it changes nothing; the field is then
   * an empty string rather than a guess.
   */
  hold?: PanoPlusHoldName;
  /**
   * v14 — THE UPRIGHT BAKE: the clockwise quarter turn native bakes into
   * `canvas.jpg` so the deliverable stands upright in the world instead of in
   * the camera raster. `0 | 90 | 180 | 270`; native refuses anything else by
   * name at start.
   *
   * Unlike {@link hold} this one DOES reach a transform — it is
   * `rnis::pano::Config::outputRotationCwDeg`. Send
   * `panoPlusUprightRotationDeg(orientation)`; the derivation, the four-hold
   * table and the identity that ties it to the live preview's own rotation are
   * documented there.
   *
   * ⚠ It needs the FULL orientation, not {@link hold}: `panoPlusHoldOf`
   * collapses landscape-left and landscape-right into `'landscape'`, and those
   * two differ by a half turn.
   *
   * Optional, and ABSENT MEANS ZERO — the pre-v14 raster-frame output,
   * byte-identical. A host that omits it gets exactly the deliverable it got
   * before, which is what keeps every existing pack, fixture and replay valid.
   */
  outputRotationCwDeg?: 0 | 90 | 180 | 270;
  /**
   * Ask `RNSARSession` for the fastest 4:3 AR format (native default true, and
   * restored to whatever it found on stop/cancel). It matters twice for a
   * slit-scan sweep: the frame interval is a hard exposure ceiling AND it sets
   * the strip density.
   */
  preferHighFps?: boolean;
  /**
   * v6 — LOCK THE CAMERA FOR THE SWEEP: exposure, white balance and focus,
   * locked after a metering settle and restored on stop/cancel/error. Native
   * default TRUE. Standard panorama practice, and the answer to the banding
   * the operator rejected twice: the offline owner map measured auto-exposure
   * brightening by 50-79% across a sweep, which is the forcing function the
   * chained overlap fit was failing to track.
   *
   * BEST-EFFORT, and the pack says so rather than the flag claiming it: ARKit
   * owns the capture session, so the lock report carries what the DEVICE
   * reported after the write, and `exposure.rangeRatio` in the pack carries
   * what the exposure actually did (1.00 ⇔ it held).
   */
  lockCamera?: boolean;
  /**
   * Milliseconds to let AE/AWB re-converge after the video-format switch,
   * before locking (native 600). Not a cargo-cult sleep: `preferHighFps`
   * re-runs `arSession.run`, and locking into the middle of that convergence
   * would pin the whole sweep to a half-metered exposure.
   */
  meteringSettleMs?: number;

  /**
   * WHICH PRODUCER FEEDS THE ENGINE. Native default `'ar'` — ARKit, exactly
   * as shipped, and nothing in this SDK sets anything else.
   *
   * `'imu'` selects the DECOUPLED capture path (S3 of the 2026-08-30
   * decoupled-capture architecture): an `AVCaptureSession` on the PHYSICAL
   * ultra-wide at 60 fps, with attitude from `CMDeviceMotion` time-aligned to
   * each frame's presentation timestamp at `pts + τ`. It exists because ARKit
   * publishes no ultra-wide video format at all (0 of 22, measured on
   * iPhone17,1) and because low-end Android has no guaranteed ARCore — 0.5×
   * and the Android port are the same piece of work.
   *
   * IT REFUSES RATHER THAN DEGRADES. Without {@link tauS} + {@link tauMeasured}
   * and a validated {@link basisIndex} for this device, `start()` rejects with
   * `panoplus-alignment-unconfigured` instead of sweeping on a guessed offset.
   * The same is true of the hardware: no ultra-wide, or no 4:3 format reaching
   * 60 fps, is reported as a refusal and never downgraded to 30.
   */
  poseSource?: PanoPlusPoseSource;

  /**
   * The MEASURED camera→motion timebase offset for this (device, lens,
   * format), in SECONDS, signed. Only read when `poseSource === 'imu'`.
   *
   * SIGN TRAVELS WITH THE NUMBER: positive means the motion a frame recorded
   * is LATER in the CoreMotion timebase, so attitude is sampled at `pts + τ`.
   * Applied backwards it does not halve the error — it doubles it.
   *
   * There is no default and there is no fallback: τ folds the epoch
   * difference, the exposure-timestamp convention (8.3 ms at 60 fps on its
   * own, ~3× the whole alignment budget) and the rolling-shutter constant into
   * one number, and none of the three can be modelled. Measure it with the
   * capture-clock probe.
   */
  tauS?: number;
  /** Must be `true` for `poseSource: 'imu'` to start, unless
   *  {@link tauUncorrected} declares the sweep uncorrected instead. There is
   *  no default τ. */
  tauMeasured?: boolean;
  /**
   * THE DELIBERATE τ = 0, UNMEASURED SWEEP. Only read when
   * `poseSource === 'imu'`, and it REPLACES the τ half of the precondition —
   * the basis is still required.
   *
   * WHY IT EXISTS (2026-08-31). The device's own τ calibration resolved on 8
   * of 12 runs and scattered 0.12–5.15 ms: a 5.03 ms spread, WIDER than the
   * 3.08 ms budget the correction is meant to buy back, so the persist gate
   * refused to write one — correctly. But the raw lag on the resolved runs sat
   * mostly INSIDE that budget, i.e. τ may not be the binding constraint at
   * all. The experiment that settles it is a sweep with no timing correction,
   * and that question — "does this arm produce a good panorama?" — outranks
   * perfecting an input we may not need.
   *
   * ⚠ IT IS NOT `tauS: 0, tauMeasured: true`, AND THAT IS THE POINT. That
   * shape works and is forbidden: it writes a measurement claim into the pack
   * for a sweep that measured nothing, which is the defect class this arm's
   * whole calibration step exists to prevent. Native refuses a configuration
   * that claims both (`tau-mode-conflict`), and the pack records
   * `tauProvenance: 'uncorrected'` — a THREE-valued field
   * (`measured` | `from-store` | `uncorrected`), never a boolean — plus a
   * plain sentence saying no correction was applied.
   *
   * ⚠ IT OUTRANKS THE ON-DEVICE CALIBRATION STORE. A calibrated phone still
   * runs the experiment; the store may not fill τ in over the top of it, or
   * the experiment silently never ran.
   */
  tauUncorrected?: boolean;
  /**
   * P5 — which back camera the decoupled arm opens: `'ultraWide'` (0.5×,
   * default) or `'wide'` (1×). Read by `planFormat` on the IMU arm only; the
   * calibration store keys (τ per `model|lens|WxH|fps`) and the pack's
   * `lens.deviceLens` stamp both follow it automatically. Absent = ultraWide.
   */
  lens?: 'ultraWide' | 'wide';
  /**
   * 2026-09-01 — RECORD THE SECOND ATTITUDE CHANNEL. Native default FALSE,
   * and read on the **ARKit arm only**.
   *
   * WHY IT EXISTS. "ARKit or the decoupled IMU — which pose arm is better?"
   * has never been answered, and the obvious design (one sweep per arm) cannot
   * answer it: the defect under study is band shear and wobble, which is a
   * FUNCTION OF HOW THE HAND MOVED, and the hand moves differently every time.
   * Two sweeps differ in the arm AND in the motion, and no pack can separate
   * them afterwards.
   *
   * So this records BOTH channels during ONE sweep. ARKit's attitude goes
   * where it always went (`track.jsonl`'s `q`); CoreMotion's goes to
   * `attitude_imu.jsonl` beside it, at 200 Hz in `xArbitraryZVertical`, with
   * `meta.json → imuSidecar` naming the reference frame, the requested AND
   * DELIVERED rates, the two channels' delivery latencies and this plugin's
   * own AR-thread cost. The offline replay then runs the same frames twice,
   * once per channel — same pixels, same timestamps, same hand motion, one
   * variable.
   *
   * ⚠ THE SAMPLES ARE RAW AND UNALIGNED, DELIBERATELY. No τ is applied, and
   * the pack says so in a sentence rather than leaving it to be inferred: on
   * this arm ARKit's attitude arrives ON the ARFrame, so there is no camera↔IMU
   * offset in the shipped path at all, and any τ in the on-device store was
   * measured under a `model|lens|WxH|fps` key no ARKit sweep matches. Raw
   * samples let the replay SWEEP τ and basis; a pre-aligned quaternion cannot
   * be un-rotated back into one.
   *
   * ⚠ ARKit-ARM ONLY, and native refuses it BY NAME on the decoupled arm
   * rather than silently. There ARKit is torn down before the camera opens, so
   * both files would carry the same CoreMotion channel — a pack that looks
   * like an A/B and is not.
   *
   * COST: it is a SECOND `RNISARFramePlugin`, so with this absent nothing is
   * registered, `RNISPanoPlusPlugin` is untouched, and the pack has no
   * `imuSidecar` key. CoreMotion is not the camera and does not fight ARKit
   * for it (`RNISPanoBasisCalibration` already runs one beside a live
   * ARSession); the AR-thread cost it does add is measured into the block
   * rather than argued.
   */
  imuSidecar?: boolean;
  /**
   * v13 / D-008(3) — the jog guard: refuse (never re-place) a strip whose
   * pre-commit canvas jog exceeds `d8JogBarPx` canvas px, for at most
   * `d8JogMaxRun` consecutive strips before accepting anyway (counted as
   * forced). Engine default OFF = byte-identical; the IR field baseline
   * ships it ON per D-004. Requires seamMetrics (native refuses to arm a
   * blind guard). Twin-validated: the one committed >8 px cut it was aimed
   * at went 18.4 -> 1.9 px at zero coverage cost; a persistent parallax
   * divergence is deferred, not fixed.
   */
  d8JogGuard?: boolean;
  d8JogBarPx?: number;
  d8JogMaxRun?: number;
  /**
   * The device→camera basis, 0..23, chosen FROM DATA by the shared C++
   * `selectBasis` (log CoreMotion beside a live ARKit session and take the
   * candidate whose relative-rotation series matches). −1, the default, makes
   * every frame a fatal refusal.
   *
   * ⚠ The validation log must rotate about MORE THAN ONE AXIS. A pure pan
   * fixes only one column of the basis and leaves an EXACT 4-way tie, which
   * `selectBasis` reports as `ambiguous-axis` rather than resolving by
   * enumeration order.
   */
  basisIndex?: number;
  /** Bracket gaps wider than this (seconds, native 0.025) report the frame as
   *  `limited` rather than `normal`. Derived, never hardcoded. */
  maxBracketGapS?: number;
  /** How long the source may WAIT for the IMU to catch up before refusing a
   *  frame (seconds, native 0.006 ≈ one IMU period). A wait, never an
   *  extrapolation: attitude is never invented past the last sample. */
  holdBudgetS?: number;
  /**
   * The acceleration cage, m/s², replacing the engine's pose-side speed cage —
   * which cannot fire on this arm because there is no translation at all. It
   * catches a lurch big enough to WRAP the phase-correlation window, which
   * comes back MEASURED SMALL and which the image side therefore cannot see.
   *
   * 0 (native default) means NOT CONFIGURED, and the pack counts it as such —
   * never as a cage that ran and passed. The threshold is a new number in a
   * new currency (acceleration, not displacement) and has not been tuned
   * against a real lurch.
   */
  lurchAccelMps2?: number;
}

/**
 * What the capture-side camera lock reported. A REPORT, never a claim: every
 * field is what the device said AFTER the write. Whether ARKit honoured it is
 * answered by the pack's own exposure trace ({@link PanoPlusExposure.rangeRatio}).
 */
export interface PanoPlusCameraLock {
  available: boolean;
  requested?: boolean;
  locked?: boolean;
  exposureLocked?: boolean;
  whiteBalanceLocked?: boolean;
  focusLocked?: boolean;
  exposureModeSupported?: boolean;
  whiteBalanceModeSupported?: boolean;
  focusModeSupported?: boolean;
  deviceId?: string;
  deviceName?: string;
  exposureDurationS?: number;
  iso?: number;
  lensPosition?: number;
  /** The CEILING asked for, not the wait taken. */
  settleCeilingMs?: number;
  /** What the metering settle actually cost, measured. */
  settleMs?: number;
  /** True when the device's own `isAdjusting*` flags all went quiet before the
   *  ceiling. False means the lock was taken over a still-converging camera —
   *  a uniformly mis-metered sweep, which is a different (and much less
   *  visible) defect than the band, but the pack must still say so. */
  settleConverged?: boolean;
  adjustingExposureAtLock?: boolean;
  adjustingWhiteBalanceAtLock?: boolean;
  adjustingFocusAtLock?: boolean;
  /** The lens was still hunting at lock time, so focus was DELIBERATELY left
   *  on continuous AF. Pinning an unconverged lens would trade the banding
   *  defect for a defocused sweep, and no downstream photometry can recover
   *  detail that was never resolved. */
  focusLockDeclined?: boolean;
  /** Frames observed with `exposureMode != .locked` while we believed we owned
   *  the lock — i.e. ARKit took it back (any `<Camera>` prop change re-runs
   *  `arSession.run`, and so does an interruption resume). */
  observedUnlockedFrames?: number;
  reassertAttempts?: number;
  reassertSucceeded?: number;
  /** 'restored' | 'restored-on-retry' | 'refused-camera-still-locked' | ''.
   *  The refusal case leaves AE/AWB/AF pinned for every OTHER capture surface
   *  in the app, so it is in the pack rather than only in the log. */
  restoreOutcome?: string;
  restorePending?: boolean;
  /** '' when the lock took; otherwise why it did not. */
  reason?: string;
}

/** `start()`'s resolution. */
export interface PanoPlusStarted {
  sessionDir: string;
  startedAtMs: number;
  pluginAvailable: boolean;
  /** v6 — surfaced at START so the surface can warn the operator immediately
   *  that a sweep is running unlocked, instead of the pack saying so after. */
  cameraLock?: PanoPlusCameraLock;
  /**
   * WHICH ARM NATIVE ACTUALLY STARTED — stated by native on BOTH branches, so
   * JS never infers it from the absence of a key.
   *
   * It matters because the two arms are selected by an option and the failure
   * everyone should fear here is a SILENT one: a sweep the operator believes
   * ran on the IMU arm, running on ARKit, producing a perfectly ordinary pack.
   * Nothing in the canvas would look different. Reading it back from the
   * starter closes that: `arms.poseSource` on the result is this value, not the
   * value that was requested.
   */
  poseSource?: PanoPlusPoseSource;
  /**
   * The decoupled source's own report — lens, format, requested rate, whether
   * the ultra-wide was the physical device, and the calibration it started
   * with. Present ONLY on the `'imu'` arm; absent is not a failure.
   *
   * Deliberately loose: it is native's dictionary, it is echoed verbatim into
   * `pose_source.json`, and typing each key here would create a second
   * source of truth that drifts silently against the file that matters.
   */
  avfSource?: Record<string, unknown>;
}

/**
 * The per-outcome tallies. EVERY ingested frame lands in exactly one bucket —
 * that is the ledger's own invariant, and it is what makes these counts a
 * residual analysis rather than a progress bar.
 */
export interface PanoPlusCounts {
  seen: number;
  painted: number;
  /** The sweep REVERSED. Kept apart from {@link heldFrontier} deliberately:
   *  conflating "the operator went backwards" with "the frontier is
   *  transiently ahead" would corrupt the reversal statistic. */
  heldBacktrack: number;
  heldFrontier: number;
  skippedNoAdvance: number;
  rejectedLowResponse: number;
  rejectedOutOfCage: number;
  rejectedPoseSpeed: number;
  /** ARKit tracking was `notAvailable`: no attitude, so the chain was HELD.
   *  Distinct from `.limited`, which is counted in {@link limitedFrames} and
   *  is processed normally. */
  rejectedTracking: number;
  rejectedRectify: number;
  rejectedInput: number;
  warmingUp: number;
  bootstrap: number;
  gapExtended: number;
  /** > 0 ⇒ G1 (zero breaks along the sweep) FAILED. Never silent. */
  gapBreak: number;
  /** A gap that WAS closed from the previous painted frame's pixels. */
  gapBackfilled: number;
  /** Frames ARKit reported `.limited` and the engine processed anyway. Not a
   *  failure — but "the sweep ran through poor tracking" and "the sweep was
   *  clean" must be distinguishable in the pack. */
  limitedFrames: number;
  canvasGrowths: number;
  canvasHeightGrowths: number;
}

/**
 * PERPENDICULAR TRUNCATION — the integrity signal {@link
 * PanoPlusSummary.unpaintedRuns} structurally cannot carry.
 *
 * The hole gate only looks ALONG the sweep. Hand drift across it walks
 * content out of the canvas band, where `warpPerspective` discards it with no
 * return value and no outcome — so a panorama missing half the shelf height
 * used to report "no holes, clean". pano+ now grows the band to fit and
 * counts whatever is still outside, which is what these fields are.
 *
 * `frames` > 0 means the panorama is vertically truncated on that many
 * strips; `columns` is roughly how much of its width is affected.
 */
export interface PanoPlusClipping {
  frames: number;
  columns: number;
  maxTopPx: number;
  maxBottomPx: number;
  /** The canvas band height actually allocated, after any growth. */
  canvasH: number;
  heightGrowths: number;
}

/** p50/p99/max over a per-frame timing series. */
export interface PanoPlusTimingStats {
  p50: number;
  p99: number;
  max: number;
  n: number;
}

/** The vertical envelope rectification leaves — reported, never cropped away
 *  (unless {@link PanoPlusEngineOptions.cropVertical} was asked for). */
export interface PanoPlusEnvelope {
  columns: number;
  covered: number;
  commonTop: number;
  commonBottom: number;
}

/**
 * The LIVE status the AR plugin returns synchronously each frame. It rides the
 * THROTTLED `onArFrame` meta under `plugins['sweep']` — the SYNC
 * channel. The async `emit`/`onArPluginResult` channel is deliberately unused:
 * the DT plugin's own comment records it as unreliable in a host, so nothing
 * the operator must see rides it.
 */
export interface PanoPlusStatus {
  running: boolean;
  /**
   * The arm the sweep is ACTUALLY running on, as native reports it each poll
   * — `'ar'`, `'imu'`, or `''` on a binary that predates the field.
   *
   * ⚠ NOT THE ARM THAT WAS REQUESTED. Since the recorder can give the ARCore
   * arm up mid-sweep and finish on the IMU ring, the requested arm stops
   * being the truth the moment that happens. Without this the surface's AR
   * pill keeps reading "AR" for the rest of a sweep that ARCore is no longer
   * feeding — the operator reads one arm and gets the other, which is the
   * defect the pill was added to prevent.
   */
  poseSourceRan: string;
  sessionDir: string;
  seq: number;
  framesSeen: number;
  painted: number;
  heldBacktrack: number;
  heldFrontier: number;
  skippedNoAdvance: number;
  rejectedLowResponse: number;
  rejectedOutOfCage: number;
  rejectedPoseSpeed: number;
  rejectedTracking: number;
  rejectedRectify: number;
  gapExtended: number;
  gapBreak: number;
  gapBackfilled: number;
  limitedFrames: number;
  /** Live PERPENDICULAR truncation. The HUD must show this: the hole gate is
   *  blind to it, so a clean-looking sweep can be losing shelf height. */
  clippedFrames: number;
  clippedColumns: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
  paintedWidthPx: number;
  advancePx: number;
  stripPx: number;
  outcome: PanoPlusOutcome;
  /** `'ok' | 'fast' | 'no-motion'` — native's own bucketing of this frame's
   *  advance against the resolved cage. */
  speed: 'ok' | 'fast' | 'no-motion' | (string & {});
  /** 0 notAvailable · 1 limited · 2 normal. */
  tracking: number;
  /**
   * ANDROID AR ARM: ARCore's own reason for not tracking, live. Empty
   * string while tracking is fine.
   *
   * Exists because the panel's 'Waiting for AR tracking' message gave
   * advice — hold steady — that is actively wrong for the reason the
   * operator was actually hitting: ARCore reported INSUFFICIENT_LIGHT on
   * 126 of 186 poses in a dark room across four attempts, and the reason
   * was written into every pack while reaching the screen never.
   */
  arTrackingFailure: string;
  /** The chain is held and has been for `cageStallFrames` — the VISIBLE pause
   *  NF3 demands, never a silent widened search. */
  stalled: boolean;
  axisLatched: boolean;
  /** 0 horizontal · 1 vertical. */
  axis: number;
  /** +1 / −1, latched from the first frames. */
  sweepSign: number;
  maxRectifyDeg: number;
  /** WHICH REGIME IS RUNNING, live: 1 ⇒ a pivot (the attitude carries the
   *  sweep), 0 ⇒ a walk (the correlation residual does). Before the axis
   *  latches this is the only signal that says WHY nothing is painting. */
  rotationFraction: number;
  /** How many times the axis/sign latch has CORRECTED itself. Live, because a
   *  correction DISCARDS the canvas: an operator watching the preview shrink
   *  back to one frame deserves to know it was deliberate. */
  relatchCount: number;
  /** This frame's ATTITUDE-derived advance magnitude, canvas px. Compare with
   *  {@link advancePx} (the post-rectification residual): on a pivot the
   *  residual is ≈0 BY DESIGN and reading it alone tells you nothing. */
  advanceRotPx: number;
  /** THE CUT VERDICT, LIVE. The engine ships these every frame so the HUD can
   *  go red DURING the sweep instead of in the pack afterwards — which is the
   *  point, because the operator's four rejected packs were all recorded
   *  before anyone could see a number. `seamMeasured` false means the three
   *  below describe nothing. */
  seamMeasured: boolean;
  integrityFailed: boolean;
  seamWorstBandP95Px: number;
  seamWorstBandMaxPx: number;
  crossBandDivergenceNormPx: number;
  seamCanvasJogP95Px: number;
  seamCanvasJogMaxPx: number;
  /** THE BANDING VERDICT, LIVE (v6). `photoDriftLocalPct` is the one to put on
   *  the HUD: it is measured on COMMITTED PIXELS over a 40-column window, so
   *  it sees the camera's own drift as well as the engine's. The two
   *  `seamPhotoStep*` numbers are the per-boundary DC step. */
  seamPhotoStepP95DN: number;
  seamPhotoStepMaxDN: number;
  /** v8 — THE SUPPORT BEHIND THE MAX. `seamPhotoStepMaxDN` is a MAX: one
   *  anomalous boundary out of six hundred reads exactly like an end-to-end
   *  band, and the operator said as much ("I am not sure I see the banding
   *  issue you are talking about"). These two say how many of how many
   *  boundaries actually breached the 3.00 DN bar, so the word BAND on the HUD
   *  can carry its own evidence. 0 on a binary that predates them. */
  seamPhotoStepOverBar: number;
  seamPhotoSamples: number;
  /** v8 — TRUE when the chain was driven by the same K band measurements
   *  `seamWorstBand*` scores it against (`crossAvgWindows`). Under it the band
   *  numbers are a FIT QUALITY, not a seam measurement, and
   *  {@link seamCanvasJogP95Px} is the only independent one left. */
  seamBandSelfScored: boolean;
  photoDriftLocalPct: number;
  photoDriftTotalPct: number;
  /** The ENGINE's applied field — read these second; see {@link PanoPlusGain}. */
  photoLocalP2PPct: number;
  photoScaleRangePct: number;
  /** 1.00 with `exposureMetaFrames > 0` is the live proof the AE lock is
   *  holding. 1.00 with `exposureMetaFrames === 0` is UNKNOWN. */
  exposureRangeRatio: number;
  exposureMetaFrames: number;
  /** THE WARPING NUMBER, live. Read against 2.45 — what one photo from this
   *  camera already does at its own corner. */
  maxAreaScale: number;
  previewPath: string;
  /** Cache-bust for {@link previewPath}, and it counts previews that are
   *  ACTUALLY ON DISK — native advances it after the atomic rename, never when
   *  the render is still queued behind the pack writes. 0 ⇒ there is no
   *  preview file yet, and pointing an `<Image>` at one would fail. */
  previewSeq: number;
  /** The published preview JPEG's own pixel dims. THE SHAPE OF THE PANORAMA:
   *  a host must size its on-screen box from these rather than assume a
   *  landscape band — a vertical sweep (the operator's gesture) produces a
   *  TALL preview. 0 on a binary that predates them; `panoPlusPreviewLayout`
   *  then falls back to the oriented canvas dims. */
  previewW: number;
  previewH: number;
  /**
   * THE PREVIEW'S TWO HALVES, COUNTED APART — and the reason they are here.
   *
   * `previewSeq` alone is ambiguous exactly when it matters: a 0 can mean the
   * engine rendered nothing, or that every render FAILED TO REACH DISK, or
   * that no status arrived at all. All three were live hypotheses for eleven
   * days while the operator watched an empty panel, and no pack could tell
   * them apart.
   *
   * `previewRenders` is what the engine produced. `previewFails` is what the
   * publisher could not write, and `previewSkips` is what was dropped because
   * a newer preview was already in flight (which is correct behaviour — a
   * stale panorama is worth nothing — and must not read as a failure).
   *
   * renders > 0 with seq 0 and fails > 0 IS the 2026-08-29 bug's signature,
   * and {@link panoPlusPreviewPlaceholder} now says so in those words.
   *
   * 0 on a binary that predates them, which is indistinguishable from a clean
   * pre-latch sweep — deliberately, so an old engine degrades to the previous
   * (vaguer) message rather than to a false accusation.
   */
  previewRenders: number;
  previewFails: number;
  previewSkips: number;
  /**
   * WHERE THE PUBLISHED PREVIEW SITS IN THE PANORAMA — and why "does not look
   * good as I pan" needed a number rather than a redesign.
   *
   * Replaying the operator's three 2026-08-29 pano+ packs through this file's
   * own layout (`results/2026-08-30-panoplus-portrait/preview/`) measured two
   * separate defects, neither of which is a filter or a resolution problem:
   *
   *  1. THE OPENING STALL. `bootstrap` paints one whole frame footprint
   *     (canvas u 129..847, 718 px on all three packs) and the strip commit
   *     then starts at the frame CENTRE, half a footprint behind it. The
   *     painted band's OUTER EXTENT therefore does not move for the first
   *     2.94 s / 2.39 s / 2.62 s — 40% / 30% / 33% of each sweep — while the
   *     operator is already panning. The panel is not frozen (strips ARE
   *     landing) but it does not GROW, and from behind the phone those are the
   *     same thing. `previewFrontierFrac` is what moves through that window.
   *
   *  2. THE GROWING EDGE. `previewViewPx` vs `previewBandPx` says whether the
   *     frontier window engaged. It does so past the knee where fitting the
   *     WHOLE band starts shrinking the picture without bound — measured on a
   *     390x844 portrait-locked window, the inked panel area peaks at along
   *     ≈ 2000 canvas px and then collapses to a 114x374 pt sliver by 3.9 m of
   *     shelf and 76x374 pt by 5.8 m.
   *
   * `previewFrontierFrac` is 0..1 along the PUBLISHED image's own long axis,
   * already sign-corrected in native (the flip needs `sweepSign`, which is
   * engine knowledge — reimplementing it here is the class of mistake that
   * produced the 154x100 pt preview panel). -1 ⇒ not placeable, and on a
   * binary that predates the field it parses to -1 as well, so the marker
   * simply does not render rather than landing in the wrong place.
   *
   * All three px counts are CANVAS px along the sweep, 0 on an older binary.
   */
  previewFrontierFrac: number;
  previewViewPx: number;
  previewBandPx: number;
  previewViewStartPx: number;
  previewWindowed: boolean;
  /** The DUTY-THROTTLED refresh interval actually in force, ms. Native treats
   *  the configured `previewIntervalMs` as a FLOOR and holds the next tick off
   *  until the preview has cost no more than `previewMaxDutyPct` of wall time,
   *  so a panel refreshing slowly because the render got dear is a different
   *  fact from one configured that way. 0 on a binary that predates it. */
  previewIntervalMs: number;
  /**
   * ── THE VIEWFINDER, WHICH IS A DIFFERENT PICTURE FROM THE PREVIEW ────────
   *
   * `preview*` above is the PANORAMA the engine is growing. These two are
   * about the CAMERA'S OWN LIVE FEED — the thing the operator aims with — and
   * they exist because on Android that feed can fail in a way that looks
   * exactly like success: a black rectangle.
   *
   * On iOS the viewfinder is an `AVCaptureVideoPreviewLayer` that attaches
   * itself to a session that already exists, so it cannot really fail. Camera2
   * has no such thing: a preview is an OUTPUT SURFACE, and outputs are FIXED
   * when `createCaptureSession` runs. A surface offered after that moment
   * cannot join the session, and the sweep then records HEADLESS — correctly,
   * completely, and with nothing on screen.
   *
   * `PanoPlusPreview` (PanoPlusPreviewView.kt) already knows which of those
   * happened and keeps the reason in words. These carry it to the panel.
   * `false` + `''` on iOS and on any binary that predates them, which is why
   * the notice they drive is gated on a NON-EMPTY note rather than on
   * `!attached` — absence of an answer is not a failure.
   */
  viewfinderAttached: boolean;
  viewfinderNote: string;
  droppedQueue: number;
  droppedPack: number;
  engineMs: number;
  abort: PanoPlusAbort | null;
}

/**
 * ROTATION vs TRANSLATION — the question the first device pack could not
 * answer from its own ledger, because the ledger carried only the
 * post-rectification RESIDUAL, which is ≈0 on a pivot BY DESIGN.
 *
 * All five are measured along the LATCHED SWEEP AXIS, in canvas px, over
 * accepted frames. `*TravelPx` are signed net contributions and sum to the
 * panorama's own travel; `*PathPx` are Σ|per-frame step|, so a channel whose
 * path is far longer than its travel is wobbling rather than sweeping.
 */
export interface PanoPlusRegime {
  /** rotPathPx ÷ (rotPathPx + resPathPx). 1 ⇒ a pure pivot, 0 ⇒ a pure walk. */
  rotationFraction: number;
  rotTravelPx: number;
  resTravelPx: number;
  rotPathPx: number;
  resPathPx: number;
}

/**
 * The axis/sign latch's own evidence. The latch decides whether anything
 * paints at all — the first device pack painted 16 of 318 frames because it
 * latched the sweep sign backwards — so the vote is part of the pack rather
 * than something to be inferred later.
 *
 * The latch is no longer irreversible: it re-checks its decision against the
 * sweep it produces and CORRECTS it if the canvas is not growing. See
 * {@link relatchCount}.
 */
export interface PanoPlusLatch {
  /** Accepted frames the latch consumed before deciding. */
  framesUsed: number;
  /** The latch reached {@link PanoPlusOptions.axisLatchMaxFrames} without
   *  anything moving decisively, so it decided on the best evidence there was.
   *  The vote is weak BY CONSTRUCTION and says so rather than hiding it. */
  weak: boolean;
  /** How many times the latch corrected itself. `> 0` means the panorama
   *  starts partway into the sweep: the frames before the correction were
   *  painted on the wrong axis/sign and discarded. A short panorama with
   *  `relatchCount` 0 and one with `relatchCount` 1 are different findings. */
  relatchCount: number;
  /** Both channel vectors, natural (pre-axis-remap) canvas px, `[x, y]`. Only
   *  `totalPx` votes; `rotationPx` is recorded because their DISAGREEMENT is
   *  the diagnostic — a walk reporting a large perpendicular `rotationPx` is
   *  an operator who tilted while walking. */
  rotationPx: [number, number];
  totalPx: [number, number];
  axis: number;
  sweepSign: number;
  latched: boolean;
}

/**
 * THE CUT METRIC — per strip boundary, the disagreement between what the K
 * correlation windows MEASURED across the sweep and what the placement
 * APPLIED, in canvas px.
 *
 * This block exists because v4 reported ALL FOUR of the operator's device
 * packs clean (`unpaintedColumns` 0, `gapBreak` 0, `clipping.frames` 0) while
 * he could see cuts in every one of them. Measured in the frame's OWN
 * rectified coordinates, so the canvas vertical-growth re-base — the benign
 * ~128 px `posV` steps — cannot contaminate it by construction rather than by
 * subtracting `vShiftPx` afterwards.
 */
export interface PanoPlusSeam {
  worstBandP50Px: number;
  worstBandP95Px: number;
  worstBandMaxPx: number;
  bandSpreadP95Px: number;
  /** THE WOBBLE NUMBER. Per-band ACCUMULATED seam residual, max − min. A
   *  per-boundary residual of a few tenths of a px is invisible on its own and
   *  integrates over hundreds of strips into the progressive shear the
   *  operator sees as wobble; a per-boundary metric alone cannot see it. */
  crossBandDivergencePx: number;
  /** ...and THE GATED ONE. The raw sum above is cumulative, so an absolute bar
   *  on it fails a long sweep for being long (measured on 15-58-22, truncated:
   *  1.6 / 3.1 / 19.5 / 52.4 px at 73 / 107 / 192 / 318 boundaries). Dividing
   *  by sqrt(n) is stationary under noise at any length and still grows under
   *  a real systematic bias, which is the defect it exists to catch. */
  crossBandDivergenceNormPx: number;
  /** The photometric seam: the DC step actually committed to the canvas at a
   *  strip boundary. Measured on the CANVAS, not on the gain's own sample
   *  window — the gain is fitted on one region and applied to another, so a
   *  gain that matches its sample exactly can still commit a visible step. */
  lumaStepP50DN: number;
  lumaStepP95DN: number;
  lumaStepMaxDN: number;
  /** v6 — THE PHOTOMETRIC SEAM, and the reason `lumaStep*` above is kept
   *  beside it as the control. That one compares ONE canvas column against
   *  ONE, so it is quantisation-limited at ±1 DN and could not tell a 0.21 DN
   *  median from a 4.68 DN band — which is how 15-58-22 reported a step and
   *  still verdicted clean. These are an interquartile mean over the WHOLE
   *  shared LOW-GRADIENT footprint of the two owners, so a misregistered scene
   *  edge (whose difference field is symmetric) cannot fire them. */
  photoStepP50DN: number;
  photoStepP95DN: number;
  photoStepMaxDN: number;
  photoSamples: number;
  /** DIAGNOSTIC: boundaries whose difference was measured but was not DC-like.
   *  They ARE in the percentiles above; the count is what lets a reader tell a
   *  pack whose steps are clean offsets from one whose steps are a mess. */
  photoNonUniform: number;
  /** v8 — HOW MANY boundaries breached the 3.00 DN max bar. The verdict's max
   *  clause fires identically for one anomalous boundary and for a genuine
   *  end-to-end band; this is the number that tells those two apart from the
   *  pack alone. */
  photoStepOverBar: number;
  /** Boundaries where fewer than two bands could measure, so uniformity is
   *  UNKNOWN — counted apart from {@link photoNonUniform} because putting them
   *  in either bucket would assert something nothing measured. */
  photoUniformUnknown: number;
  /** THE CROSS-CHECK: the same |step| percentiles restricted to the DC-like
   *  boundaries ALONE. If the gate only fires because misregistered scene
   *  edges are in the population, these fall below the bar and the banding
   *  verdict is an artefact. On the operator's four packs they do NOT — the
   *  gate still clears at 1.57 / 1.66 / 0.75 / 1.85 DN. */
  photoUniStepP95DN: number;
  photoUniStepMaxDN: number;
  photoUniSamples: number;
  /** How far the DC step VARIES along one boundary. A large spread beside a
   *  small step is geometry, not exposure. */
  photoSpreadP95DN: number;
  photoSpreadMaxDN: number;
  /** THE BAND, ON COMMITTED PIXELS — as a PERCENTAGE of scene brightness.
   *  Integrating the SIGNED per-boundary step reconstructs what the canvas
   *  actually carries, so unlike the engine's applied field this SEES THE
   *  CAMERA's own drift, which on a pack captured without the exposure lock is
   *  the larger of the two terms and is otherwise unobservable.
   *
   *  Calibration: with the chain's correction removed this reads +51 to +69%
   *  on the operator's four packs, independently reproducing the offline owner
   *  map's measurement of the camera (C = 1.50-1.79) from a different
   *  construction. `local` is the worst 40-column window — THE BAND; `total`
   *  is end-to-end. */
  photoDriftLocalPct: number;
  photoDriftTotalPct: number;
  /** Canvas column along the sweep where the worst local window starts, so the
   *  number can be pointed at a place in the image. */
  photoDriftWorstU: number;
  boundaries: number;
  /** Fraction of committed strips that produced a usable band measurement. A
   *  pack whose boundaries are mostly unmeasured is not a clean pack; it is an
   *  unmeasured one, and the roll-ups describe only the measured part. */
  coverageFrac: number;
  /** THE COMMITTED-PIXEL CUT. Everything above scores the placement the engine
   *  DECIDED; these score the pixels it PAINTED. At every strip boundary the
   *  incoming warp already covers a slab of canvas the high-water clip throws
   *  away; correlating that slab against the canvas underneath it measures the
   *  cross-sweep misregistration in canvas px, through the matrix that did the
   *  painting. It therefore survives a placement error introduced anywhere
   *  after the fit, and every correlation window agreeing on one aliased peak
   *  — neither of which the band numbers can see, because they reconstruct the
   *  intended placement from the same measurement the placement was made of. */
  canvasJogP50Px: number;
  canvasJogP95Px: number;
  canvasJogMaxPx: number;
  canvasJogSamples: number;
  /** ── v8: HOW FAR THE PANORAMA HAS WALKED ────────────────────────────────
   *  Running sum of the SIGNED committed-pixel jog: `jogDriftPx` is its
   *  peak-to-peak range over the sweep, `jogDriftEndPx` where it finished,
   *  `jogDriftSamples` how many boundaries it is made of. The percentiles
   *  above answer "how bad is a boundary"; this answers "how far has the whole
   *  thing drifted", which no per-boundary statistic can reach.
   *
   *  ⚠ NOT THE WOBBLE NUMBER, and this SDK says so rather than letting the
   *  next reader assume it — the field that WAS labelled that way
   *  (`crossBandDivergencePx`) turned out to be blind to it. Validated against
   *  a slat-wall ruler on the rendered canvas of all four operator packs: the
   *  log-log SLOPE tracks (both call the process a random walk on 4 of 4), the
   *  AMPLITUDE is 1-4× high and ranks the packs differently, because a running
   *  sum integrates this measurement's own correlation noise alongside the
   *  defect. REPORTED, NEVER GATED. */
  jogDriftPx: number;
  jogDriftEndPx: number;
  jogDriftSamples: number;
  /** v8 — TRUE when `crossAvgWindows` drove the chain, i.e. when the placement
   *  is the least-squares centre of the same K measurements the `worstBand*`
   *  percentiles score it on. A pack carrying this true has NO independent
   *  band number; `canvasJog*` is the one that survives. Reported, not gated:
   *  the averaged placement may be better, this only stops the band
   *  improvement being quoted as the proof of it. */
  bandSelfScored: boolean;
  /** FALSE means every number in this block describes NOTHING. Deliberately
   *  NOT the same thing as clean. */
  measured: boolean;
  /** The ENGINE's own verdict against its shipped bars. True on all four v4
   *  packs — and true whenever a session painted strips and either instrument
   *  stayed silent. */
  integrityFailed: boolean;
  /** Which clauses fired, '' when none did. */
  integrityReason: string;
}

/**
 * WHAT SURFACE THE PANORAMA WAS PAINTED ON, and how much it distorts.
 *
 * `maxAreaScalePainted` is the operator-facing WARPING number: the worst area
 * magnification over every COMMITTED strip relative to the reference optical
 * axis. 1.0 = none. Read it against 2.45, which is what a single photo from a
 * 1335 px-focal 1920×1440 camera already does at its own corner — v4's pivot
 * pack measured 13.0.
 */
export interface PanoPlusProjection {
  mode: number;
  name: 'planar' | 'sweep-cylindrical';
  maxAreaScalePainted: number;
  /** The excursion the HOMOGRAPHY carries, after the sweep component is
   *  removed. Equals `maxRectifyDeg` in the planar arm. */
  maxCrossRectifyDeg: number;
  /** Total along-sweep attitude travel, degrees. */
  sweepDeg: number;
  crossScaleEnd: number;
  crossScaleCagedFrames: number;
  /** The distance the placement ACTUALLY USED on the last accepted frame —
   *  under the default `subjectDistanceAuto` that is the online fit, not the
   *  configured value. Both are carried, because a field named "used" holding
   *  the value that was not used is worse than no field at all. */
  subjectDistanceUsedM: number;
  subjectDistanceConfiguredM: number;
  /** ψ is gated on the axis latch, so the projection law changes once, at the
   *  latch: the frame before is placed on the tangent (f·tan ψ), the frame
   *  after on the arc (f·ψ). Bounded and self-correcting — and ledgered here,
   *  because a projection that changes mid-sweep must never do it silently.
   *  −1 = never switched (planar arm, or never latched). */
  projectionSwitchSeq: number;
  projectionSwitchStepPx: number;
  /** What the correlation windows measured the subject distance to be, or 0
   *  when there was not enough forward travel to fit it. */
  subjectDistanceFitM: number;
  /** v11 — the fit's own internals, so a reader can GRADE that number instead
   *  of trusting it. Never null: a pack that predates the block parses to a
   *  zeroed record whose `samples` is 0, which reads as "not measured" and
   *  cannot be confused with a graded pack. */
  subjectDistanceFit: PanoPlusSubjectDistanceFit;
}

/**
 * v11 — WHY THE ONLINE SUBJECT-DISTANCE FIT IS ALLOWED TO BE WRONG, IN THE
 * PACK.
 *
 * THE DEFECT THIS EXISTS FOR, measured on the three Test-13 field packs
 * (2026-08-30): `subjectDistanceFitM` returned 1.95 / 6.00 / 5.87 m against a
 * standoff measured two independent ways at 0.6-1.0 m — 2x to 7.5x wrong on
 * every pack, ON the 6.0 m clamp rail on one of them — and nothing in the
 * pack said so, because the estimator self-scores.
 *
 * THE MECHANISM, which is structural rather than unlucky. The estimator has
 * exactly one regressor: FORWARD travel along the reference optical axis.
 * Holding standoff is the POINT of a shelf sweep, so on those packs the
 * forward span was 6.7 / 12.7 / 4.2 cm against 1.06 / 1.16 / 0.73 m of
 * perpendicular travel — leverage 0.064 / 0.109 / 0.057. `den` (Sum fwd^2) is
 * therefore tiny, the normal equation is ill-conditioned, and the ratio runs
 * away.
 *
 * READ `degenerate` FIRST. `saturated` catches only the packs whose ratio was
 * still on a rail at the END of the sweep — one of the three. `degenerate`
 * catches all three, because it grades the INPUT rather than the output.
 *
 * NOTHING HERE IS A GATE. The predictor is benign-degenerate (with fwd ≈ 0 the
 * model predicts s = exp(−fwd/d) ≈ 1 whatever d is), so a wrong `d` costs
 * these packs almost nothing, and failing them for it would be a false alarm.
 * {@link PanoPlusIntegrity.isIntact} deliberately does not move.
 */
export interface PanoPlusSubjectDistanceFit {
  /** The UNCLAMPED ratio, metres. {@link PanoPlusProjection.subjectDistanceFitM}
   *  is this passed through `clamp(clampLoM, clampHiM)`. THE field that makes
   *  saturation provable: a clamped 6.00 and a genuine 6.00 are otherwise the
   *  same number. 0 ⇒ the fit never ran. */
  rawM: number;
  clampLoM: number;
  clampHiM: number;
  /** `true` when the SHIPPED value is a clamp rail rather than a measurement. */
  saturated: boolean;
  /** Fit updates that were clamped, and updates REFUSED for a non-finite or
   *  non-positive ratio. A refusal silently retains the previous value, so a
   *  fit that stopped converging halfway is otherwise indistinguishable from
   *  one that converged. */
  clampedUpdates: number;
  refusedUpdates: number;
  /** Sum fwd^2 (m^2) and Sum fwd·(−Sum log s) (m) — THE regression denominator
   *  and numerator. `den` is the conditioning of the whole estimate. */
  den: number;
  num: number;
  /** Accepted post-latch frames that contributed a sample. 0 ⇒ this pack
   *  predates the block, or the fit never ran. */
  samples: number;
  /** The LEVERAGE: the span of forward travel actually seen, against the
   *  largest perpendicular displacement from the reference pose over the same
   *  frames. Their ratio is what `degenerate` grades. */
  fwdSpanM: number;
  perpSpanM: number;
  leverRatio: number;
  /** The named bars the engine applied, carried so a pack is self-describing
   *  if they ever move (`rnis::pano::kSubjectDistanceFitLeverBar` /
   *  `...PerpFloorM`). */
  leverBar: number;
  perpFloorM: number;
  /** `true` when the regressor had almost no forward travel to regress ON, so
   *  the fit is not evidence about the standoff whatever value it returned. */
  degenerate: boolean;
  /** `true` when `subjectDistanceAuto` was on AND the fit produced a value —
   *  i.e. the placement really ran on the fit rather than on the configured
   *  distance. "The fit was 6.00 m" and "the placement used 6.00 m" are
   *  different facts. */
  inForce: boolean;
}

/**
 * The chained exposure, REPORTED rather than gated. `cumEnd` walks
 * monotonically to 0.70-0.76 on every device pack — a 24-30% end-to-end
 * darkening with the same sign every time, i.e. a BIASED estimator and not
 * noise, which `cumClamp` at 2.0 can never catch. `leak` is the fix and is 0
 * pending the operator's approval, so gating this would fail every pack for a
 * defect the engine is not yet allowed to correct.
 */
export interface PanoPlusGain {
  cumEnd: number;
  leak: number;
  cumClamp: number;
  /** v6 — peak-to-peak of the field the ENGINE APPLIED, over a sliding
   *  `localWindowPx` window, and its end-to-end range.
   *
   *  READ THESE SECOND. They are the engine scoring its own correction, which
   *  is why the measurement that mattered was taken on committed pixels
   *  ({@link PanoPlusSeam.photoDriftLocalPct}) — and the two disagree: the
   *  applied field says `gainLeak` fixes the band, the committed pixels say it
   *  makes the end-to-end drift 3-6x worse. The leak stayed off. */
  localP2PPct: number;
  localWorstU: number;
  localWindowPx: number;
  rangePct: number;
  scaleMin: number;
  scaleMax: number;
  columns: number;
}

/**
 * v6 — RADIOMETRIC NORMALISATION, and the capture-side lock that makes it
 * unnecessary.
 *
 * `rangeRatio` OUTRANKS `lock` entirely. The lock dictionary says what the
 * device reported when we asked; this says what the exposure actually did over
 * the sweep. 1.00 with `metaFrames > 0` ⇒ the lock held. 1.00 with
 * `metaFrames === 0` ⇒ UNKNOWN, not locked — there was no metadata to measure.
 * The operator's v5 packs, captured with no lock at all, ran 1.50-1.79.
 */
export interface PanoPlusExposure {
  normalize: boolean;
  gainClamp: number;
  /** Frames that carried usable exposure metadata. 0 on every pack captured
   *  before v6, and on any path where the metadata is unavailable — which the
   *  pack then STATES rather than implying by a suspiciously flat gain trace. */
  metaFrames: number;
  /** Frames whose reported ratio was outside `gainClamp` and was clamped.
   *  Non-zero means the metadata is not to be trusted. */
  clampedFrames: number;
  /** The reference frame's exposure (duration x ISO) — the datum every other
   *  frame is normalised to. 0 ⇒ never established. */
  refValue: number;
  minValue: number;
  maxValue: number;
  rangeRatio: number;
  lock: PanoPlusCameraLock | null;
  /** v11 — the NON-CIRCULAR half. Never null: a pack that predates the block
   *  parses to a zeroed record whose `frames` is 0, which reads as UNKNOWN. */
  ar: PanoPlusArExposure;
}

/**
 * v11 — ARKit'S OWN EXPOSURE, so the AE-lock evidence stops being circular.
 *
 * Every number in {@link PanoPlusExposure} is measured on the
 * `AVCaptureDevice` this app resolved and locked, then read back off that same
 * object. `rangeRatio === 1` therefore proves only that the object we touched
 * did not move. It cannot answer either of the two questions that matter: is
 * that the device ARKit is streaming, and does the lock reach the pixels ARKit
 * delivers? The camera-lock implementation explicitly declines to claim it
 * does, and says the pack carries the evidence instead of the claim — this is
 * that evidence.
 *
 * HOW TO READ IT:
 *  - `frames === 0` ⇒ UNKNOWN. ARKit's numbers were unreachable on this run —
 *    NOT "the lock failed" and NOT "the lock held". `probe.outcome` says why.
 *  - `rangeRatio === 1.00` with `frames > 0` ⇒ the lock reached ARKit's pixels.
 *  - `pairedFrames > 0` with `maxRelDelta ≈ 0` ⇒ ARKit's camera and the device
 *    we locked report the same exposure, i.e. the same physical device. A
 *    large delta is the finding that the lock was asserted on the wrong one.
 */
export interface PanoPlusArExposure {
  /** Frames carrying a usable `ARCamera.exposureDuration`. */
  frames: number;
  minDurationS: number;
  maxDurationS: number;
  /** max/min over the sweep. 1.00 with `frames === 0` is UNKNOWN, not locked. */
  rangeRatio: number;
  /** `ARCamera.exposureOffset`, EV. Legitimately negative, and 0.0 is a legal
   *  reading — which is why presence is carried by `frames`, never inferred
   *  from these. */
  offsetMinEV: number;
  offsetMaxEV: number;
  /** Frames where BOTH ARKit's and the device's duration were present — the
   *  denominator of the identity check. */
  pairedFrames: number;
  maxAbsDeltaS: number;
  maxRelDelta: number;
  /** How the probe reached (or failed to reach) the ARSession, and how many
   *  frames it sampled. Without it, `frames === 0` cannot be told apart from
   *  "this build cannot read ARKit's camera". `null` when the host wrote no
   *  probe report at all — itself distinguishable from "reported: not found". */
  probe: PanoPlusArExposureProbe | null;
}

/** v11 — the AR-exposure probe's account of ITSELF. */
export interface PanoPlusArExposureProbe {
  /** `found` · `no-arscnview` · `no-window` · `searching` · `not-attempted`. */
  outcome: string;
  attempts: number;
  sessionResolved: boolean;
  samples: number;
  /** Frames where the session was cached but `currentFrame` was nil, and
   *  frames whose values were non-finite. */
  currentFrameNil: number;
  unusableValues: number;
  /** Frames where the ARFrame read WAS the frame the plugin was handed.
   *  `frameMatched === samples` is the clean case; anything else means the
   *  exposure belongs to a neighbouring frame and must be read as such. */
  frameMatched: number;
  frameMismatched: number;
  maxFrameDeltaMs: number;
  /** How the session was reached, spelled out, because the route is a
   *  public-API view-hierarchy walk rather than an API the SDK offers. */
  route: string;
}

/**
 * v10 — WHAT THE LENS-UNDISTORTION GATE DECIDED, and on what.
 *
 * Present on every sweep, including the ones that were NOT corrected: an
 * uncorrected pack has to say it was uncorrected, or a reader cannot tell it
 * from a pack written before the correction existed.
 *
 *  - `gate` — `applied` · `override` · `unknown-device` · `lens-mismatch` ·
 *    `focal-mismatch` · `no-intrinsics` · `lut-failed` · `disabled`. Anything
 *    but the first two means NO correction was made; there is no
 *    half-corrected state. `no-intrinsics` on a calibrated body means the
 *    session never latched a reference frame, so the gate never saw a focal to
 *    check — an honest "not decided", not a refusal. `lut-failed` means the
 *    model was accepted and could not be tabulated on this frame's geometry;
 *    it exists so a pack never reads gate `applied` beside `applied:false`.
 *  - `fxOverWidth` is what the gate MEASURED off ARKit's own per-frame
 *    intrinsics; `expectedFxOverWidth` is what the calibrated table wanted.
 *  - `peakRadialPx` / `peakResidualPx` are what the applied model is worth, in
 *    SOURCE px, over this frame's radius range — a coefficient pair means
 *    nothing to a reader. TWO numbers, named apart, because "peak" alone is
 *    ambiguous: `peakRadialPx` is the TOTAL radial move (≈5.11 px on
 *    iPhone17,1 wide) and `peakResidualPx` is the same with the pure-scale
 *    term removed (≈2.8 px, peaking at the frame corner) — the moustache,
 *    i.e. the only part of the field that can bend a straight line. A pure
 *    scale moves everything and bends nothing. Neither is the "−4.36 px" the
 *    fit round quoted: that is `peakRadialPx` on the single-shot coefficients
 *    rather than the fixpoint pair that ships.
 *  - `correctedStrips` / `skippedStrips` count COMMITTED strips only. A strip
 *    that resampled and then contributed no columns is in neither.
 *    `skippedStrips` > 0 means strips were painted from a frame whose focal
 *    the gate refuses (a lens switch mid-sweep). A finding, not noise.
 */
export interface PanoPlusLens {
  applied: boolean;
  gate: string;
  device: string;
  /** ADVISORY — the AVCaptureDevice type the exposure lock resolved. It can
   *  REFUSE a session, never accept one; the focal check accepts. */
  deviceLens: string;
  k1: number;
  k2: number;
  source: string;
  fxOverWidth: number;
  expectedFxOverWidth: number;
  peakRadialPx: number;
  peakResidualPx: number;
  correctedStrips: number;
  skippedStrips: number;
}

/** What `stop()` resolves — the pack's index plus the residual numbers the
 *  operator's evaluation gate asks for. */
export interface PanoPlusSummary {
  sessionDir: string;
  canvasPath: string;
  previewPath: string;
  metaPath: string;
  ledgerPath: string;
  trackPath: string;
  width: number;
  height: number;
  counts: PanoPlusCounts;
  axis: number;
  sweepSign: number;
  maxRectifyDeg: number;
  /** What KIND of sweep this was. Read it before any other residual. */
  regime: PanoPlusRegime;
  /** What the axis/sign latch decided, and on what evidence. */
  latch: PanoPlusLatch;
  /** v5: the canvas surface and the WARPING number. */
  projection: PanoPlusProjection;
  /** v5: THE CUT METRIC — the defect class v4's verdict was blind to. */
  seam: PanoPlusSeam;
  /** v5: the chained exposure, reported. v6 adds the applied-field band. */
  gain: PanoPlusGain;
  /** v6: what the camera's exposure did, and whether the sweep lock held. */
  exposure: PanoPlusExposure;
  /** v10: what the lens-undistortion gate decided, and on what evidence. */
  lens: PanoPlusLens;
  /** Interior holes as `[start, end)` column runs in FINAL sweep-axis order.
   *  EMPTY ⇒ G1 held. */
  unpaintedRuns: Array<[number, number]>;
  unpaintedColumns: number;
  /** Which output axis {@link unpaintedRuns} indexes. `'x'` for a horizontal
   *  sweep, `'y'` for a vertical one — the finalize bake TRANSPOSES a vertical
   *  sweep, so calling them "columns" unconditionally is wrong half the time. */
  unpaintedRunsAxis: 'x' | 'y';
  /** The perpendicular integrity signal. See {@link PanoPlusClipping}. */
  clipping: PanoPlusClipping;
  verticalEnvelope: PanoPlusEnvelope;
  engineMs: PanoPlusTimingStats;
  arThreadUs: PanoPlusTimingStats;
  /** How long the live preview's downscale took, ON THE INGEST QUEUE. The one
   *  per-tick cost that can plausibly push a frame out of the ring — measured
   *  rather than assumed. */
  previewMs: PanoPlusTimingStats;
  /** THE PREVIEW'S OWN LEDGER, on the finished sweep. `previewRendered` is
   *  what the engine produced, `previewPublished` what reached disk,
   *  `previewFailed` what could not be written and `previewError` the first
   *  reason verbatim from the publisher.
   *
   *  On the three 2026-08-29 packs the honest row would have read
   *  rendered ~30 / published 0 / failed ~30 — and nothing in the pack could
   *  say it, which is why the bug outlived eleven days and six green suites.
   *  Zero on a binary that predates the counters. */
  previewRendered: number;
  /** Publishes that reached disk — a COUNT, not the last published sequence
   *  number. The distinction is load-bearing: `previewSeq` advances on every
   *  RENDER, so the last published seq trails the rendered count by however
   *  many ticks coalesced, ON A HEALTHY SWEEP. A verdict keyed on
   *  `rendered === published` against the seq would cry wolf on every
   *  thermally-loaded sweep, which is how a warning becomes noise.
   *
   *  With a real count the sweep obeys an exact identity, checked once the
   *  publish queue is drained:
   *
   *      rendered === published + failed + skipped
   *
   *  Every render ends in exactly one of the three. A SHORTFALL is a render
   *  that reached none of them — the silent class this whole change exists to
   *  end, and the only one no counter could previously name. */
  previewPublished: number;
  previewFailed: number;
  previewSkipped: number;
  /** The sequence number of the last preview that landed — what the panel
   *  keys its cache-bust off. Not a count; see {@link previewPublished}. */
  previewLastPublishedSeq: number;
  previewError: string | null;
  /** THE LEAD-OUT'S OWN LEDGER. `Engine::finish()` paints a final strip from
   *  the last painted frame, and on the operator's packs that ONE strip is
   *  29-48% of the deliverable. Until 2026-08-30 its body sat inside two empty
   *  `catch` blocks — the same swallow-everything idiom that hid the blank
   *  preview for eleven days — so a throw silently dropped the last third of
   *  the panorama with no field anywhere able to say why.
   *
   *  `tailFlushAttempted && !tailFlushed` is the fault. `tailFlushAttempted`
   *  false is a sweep that never latched and legitimately had no lead-out;
   *  that is not a fault and must not be read as one. Both false on a binary
   *  that predates the counters. */
  tailFlushAttempted: boolean;
  tailFlushed: boolean;
  tailFlushError: string | null;
  droppedQueue: number;
  droppedPack: number;
  framesWritten: number;
  /** Frame JPEGs counted in {@link framesWritten} that did not reach disk.
   *  Non-zero means meta.json OVERSTATES the pack. Zero on every field pack
   *  measured so far; this is instrumentation, not a known defect. */
  frameWriteFailed: number;
  /** Bytes of source-frame JPEG this sweep wrote. `packFrames: 'all'` at
   *  30 fps runs to hundreds of MB — visible, not discovered when the device
   *  fills up. */
  packBytes: number;
  /** Frames whose ARKit intrinsics were declared against a different raster
   *  than the pixel buffer and had to be rescaled. Should be 0; anything else
   *  is a real finding about the AR format. */
  intrinsicsRescaled: number;
  packFrameCapHit: boolean;
  sweepMs: number;
  fpsMeasured: number;
  finalizeMs: number;
  abort: PanoPlusAbort | null;
}

/**
 * The pano+ capture result the host receives — deliberately NOT a
 * a host's own richer capture result (a sweep has no liveness verdict, no
 * object detection, no accept/retake gate).
 *
 * `kind: 'panoplus'` is a CONTRACT: `utils/debugPack.ts` routes the pack name
 * prefix and the sessionDir collection off it, and offline discovery greps for
 * `panoplus-debug-pack-…`. It must never be renamed with a display label.
 */
export interface PanoPlusCaptureResult {
  kind: 'panoplus';
  type: 'panoplus';
  /** The finished panorama — a plain path (see {@link fileUri} at call sites). */
  uri: string;
  /** The pack root. EVERYTHING pano+ recorded is under here; the host copies
   *  the whole tree into the debug pack. */
  sessionDir: string;
  width: number;
  height: number;
  summary: PanoPlusSummary;
  /** The resolved engine arms this sweep ran, echoed onto the result so a pack
   *  reader never has to open meta.json to know which arm produced it.
   *
   *  `poseSource` is the arm NATIVE REPORTED STARTING, not the one the host
   *  asked for. On the AR arm those are always the same; on the IMU arm they
   *  are the same or the start rejected. The distinction is kept because the
   *  one failure that would be invisible in the pixels is a sweep believed to
   *  be decoupled that was not. */
  arms: {
    rectify: boolean;
    gainMatch: boolean;
    packFrames: PanoPlusPackFrames;
    poseSource: PanoPlusPoseSource;
  };
  capturedAt: string;
}

/**
 * A FAILED sweep still hands back its pack. Native passes the original
 * `NSError` to the rejecter, so RN copies its `userInfo` onto the JS error —
 * the D2 pattern this pod already uses for `stitchPassRobust`. Read this, do
 * not discard the rejection: a sweep that painted nothing is precisely the
 * pack the residual analysis wants.
 */
export interface PanoPlusFailure {
  /** `'panoplus-unavailable' | 'panoplus-busy' | 'invalid-options' |
   *  'panoplus-io' | 'panoplus-not-running' | 'panoplus-empty' | 'unknown'` */
  code: string;
  message: string;
  /** Present on `panoplus-empty` — the pack is on disk and worth keeping. */
  sessionDir: string | null;
  counts: PanoPlusCounts | null;
  abort: PanoPlusAbort | null;
}

// ════════════════════════════════════════════════════════════════════════
//  THE HOST-SHUTTER CONTRACT
// ════════════════════════════════════════════════════════════════════════

/**
 * What a host's shutter can ask this surface to do.
 *
 * ⚠ DELIBERATELY NARROWER THAN THE HOST'S OWN HANDLE TYPE, and structurally
 * compatible with it. A host that drives several capture surfaces from one
 * bottom bar has a union handle covering all of them — gallery import, record
 * toggles, crop editors. A sweep implements four of those members and none of
 * the rest, so it declares the four. TypeScript is structural: this satisfies
 * the wider slot without either side importing the other, which is what keeps
 * the sweep buildable outside the host that first drew a shutter for it.
 */
export interface SweepSurfaceHandle {
  /** Fire a capture — the shutter tap. No-ops internally when not ready. */
  capture: () => void;
  /** Finalize the sweep — the Done button. No-ops when there is nothing to finalize. */
  finalize: () => void;
  /**
   * The shutter's HOLD gesture. `CameraShutter` fires `onHoldStart` once a
   * press has been held past its threshold, and `onHoldComplete` on the
   * release that follows — release ALWAYS, which is what makes a sweep
   * terminate even when the finger leaves the button.
   */
  holdStart?: () => void;
  holdEnd?: () => void;
}

/** How that shutter should LOOK, reported up as the sweep changes state. */
export interface SweepSurfaceState {
  /** Shutter looks enabled (a capture would actually do something). */
  canCapture: boolean;
  /** Finalize looks enabled (there is a sweep to finalize). */
  canFinalize: boolean;
  /** A capture or finalize is in flight → the shutter shows its busy visual. */
  busy: boolean;
}
