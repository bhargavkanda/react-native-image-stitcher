// SPDX-License-Identifier: Apache-2.0
/**
 * usePanMotion — one sensor-fed hook that exposes the three motion
 * signals the first-time-user GUIDANCE surfaces share, so the screen
 * spins up ONE gyroscope + ONE accelerometer subscription instead of
 * three independent ones.
 *
 * Consumers
 *   - Item 3 (pan how-to / direction arrow) wants `resolvedAxis` to
 *     know whether the user is panning horizontally or vertically.
 *   - Item 4 ("Moving too fast, slow down") wants `panSpeedBucket`.
 *   - Item 6 (lateral-drift → finalize + popup) wants `lateralCm` /
 *     `lateralExceeded`.
 *
 * Why one hook (and not three components each subscribing)
 *   `react-native-sensors` is global: every `gyroscope.subscribe` /
 *   `accelerometer.subscribe` adds a listener to the same underlying
 *   native sensor, and `setUpdateIntervalForType` is process-wide.
 *   Three subscribers means three JS callbacks per native sample +
 *   three teardown paths to get right.  Funnelling the shared signals
 *   through one hook keeps the sensor wiring in a single place.
 *
 * ── Speed bucket (Item 4) ────────────────────────────────────────
 * Reuses `PanoramaGuidance`'s gyro logic verbatim (see `bucketFor`
 * below, lifted from that file): take the dominant rotation axis for
 * the current pan direction and map |rad/s| onto good / warn / bad.
 *   horizontal pan (portrait, Mode B)  → gyro Y dominates.
 *   vertical   pan (landscape, Mode A) → gyro X dominates.
 * Defaults 0.5 / 1.0 rad/s match `PanoramaGuidance`'s SCANS tuning.
 *
 * ── Lateral drift (Item 6) ───────────────────────────────────────
 * This is the subtle part.  `useIMUTranslationGate` integrates the
 * accelerometer along **device-X**, because in BOTH pan modes the
 * pan axis maps to device-X (portrait: user left/right; landscape:
 * device-X has rotated 90° into user up/down).  That gate's X
 * integrator RESETS at every accepted keyframe (and auto-rearms on
 * each budget fire) — see its header — because it measures
 * translation-*along*-the-pan between keyframes.
 *
 * Lateral drift is the ORTHOGONAL motion: the operator sliding the
 * phone sideways out of the pan plane.  Orthogonal to device-X is
 * **device-Y**, in both modes.  So we integrate device-Y here.
 *
 * Crucially this accumulator must measure drift over the WHOLE
 * capture, not per-keyframe — a slow continuous sideways creep would
 * never trip a per-keyframe-reset budget.  So unlike the gate's
 * `posX`, our `posY` resets ONLY on `active` false → true (capture
 * start).  It is never reset by keyframe accepts (this hook doesn't
 * even know about them).
 *
 * We borrow the gate's drift-mitigation recipe (per-axis IIR gravity
 * estimate + per-sample velocity damping + iOS G→m/s² scaling) so the
 * lateral integrator has the same noise floor characteristics.
 *
 * Grace window
 *   A short slide as the operator settles their grip at capture start
 *   shouldn't fire the "you drifted" popup.  `lateralExceeded` only
 *   latches once the budget has been *continuously* exceeded for
 *   `LATERAL_GRACE_MS` (default 500 ms).  A dip back under budget
 *   resets the grace timer, so a single wobble that crosses and
 *   immediately recrosses the threshold never latches.  Once latched
 *   it STAYS latched until the next capture (matches Item 6's
 *   product decision: finalize what's captured, then show the popup —
 *   we don't un-finalize if the phone wobbles back).
 *
 * Performance
 *   Gyro at ~30 Hz, accel at ~50 Hz, all integrator state in refs.
 *   `setState` fires only on a *qualitative* change (bucket flips, or
 *   the exceeded latch trips) — never per sample.  `lateralCm` is the
 *   one exception consumers may want live; it's exposed via the
 *   returned object but only re-rendered on the throttled tick (see
 *   `LATERAL_EMIT_INTERVAL_MS`) so a debug/HUD readout updates without
 *   a 50 Hz re-render storm.
 */

import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  accelerometer,
  gravity as gravitySensor,
  gyroscope,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';

import { useDeviceOrientation } from './useDeviceOrientation';


export type PanSpeedBucket = 'good' | 'warn' | 'bad';

/**
 * Pan axis in user-perceived terms:
 *   'horizontal' → portrait, pan left↔right  (Mode B).
 *   'vertical'   → landscape, pan up↕down     (Mode A).
 * Same vocabulary as `PanoramaGuidance`'s `PanAxis`.
 */
export type PanAxis = 'horizontal' | 'vertical';


export interface UsePanMotionOptions {
  /**
   * Subscribe to the sensors only while this is true.  Typically the
   * host's `statusPhase === 'recording'`.  Teardown on inactive so
   * the gyro/accel aren't running the rest of the time the screen is
   * up.  The lateral accumulator zeroes on every false → true edge.
   */
  active: boolean;

  /**
   * Force the pan axis instead of auto-detecting from device
   * orientation.  Matches `PanoramaGuidance`'s `axis` prop: hosts
   * that lock orientation but want the user to pan the orthogonal
   * axis pass this.  Default: auto-detect — 'horizontal' in portrait,
   * 'vertical' in landscape.
   */
  axis?: PanAxis;

  /**
   * Gyro rate (rad/s) at/below which the pan is 'good'.  Default 0.5,
   * same as `PanoramaGuidance`'s SCANS tuning.
   */
  goodMaxRadPerSec?: number;

  /**
   * Gyro rate (rad/s) at/below which the pan is 'warn' (above 'good').
   * Above it is 'bad'.  Default 1.0.
   */
  warnMaxRadPerSec?: number;

  /**
   * Lateral (cross-pan) translation budget in CENTIMETRES.  Once the
   * integrated |lateral| exceeds this for `LATERAL_GRACE_MS`,
   * `lateralExceeded` latches true.  Defaults to
   * {@link DEFAULT_LATERAL_BUDGET_CM}.
   *
   * NOTE this governs the ACCELEROMETER (displacement) trigger only.
   * `lateralExceeded` has a SECOND, independent trigger — the cross-pan
   * gyro EMA, see {@link lateralTurnRateRadPerSec} — which this budget
   * does not affect.  `0` disables BOTH.
   */
  lateralBudgetCm?: number;

  /**
   * Cross-pan ROTATION rate, rad/s, above which `lateralExceeded`
   * latches.  Defaults to {@link DEFAULT_LATERAL_TURN_RAD_PER_SEC}
   * (0.15 rad/s ≈ 8.6 °/s), i.e. unset reproduces today's behaviour.
   *
   * This is the OTHER, historically PRIMARY lateral trigger: an EMA
   * (τ ≈ 0.4 s) of |gyro cross-axis rate|, entirely independent of the
   * displacement integrator and of `lateralBudgetCm`.  It was tuned
   * against one field trace (a straight pan smoothed to ~0.04; two
   * deliberate cross-turns to ~0.3 and ~0.7).  Exposed because a stop
   * attributed to "lateral drift" may in fact be THIS trigger, and
   * until now there was no way to tune it or tell the two apart — read
   * `latch=gyro|accel` in the `[panMotion]` telemetry to find out which
   * one is firing before changing either number.
   *
   * `0` (or negative) disables THIS trigger only; `lateralBudgetCm: 0`
   * disables both.
   */
  lateralTurnRateRadPerSec?: number;

  /**
   * Which lateral-drift physics to run.  Default `'fused'`.
   *
   *   'fused'  — subtract the FUSED GRAVITY SENSOR per sample
   *              (`lin = accel - gravity`, i.e. CoreMotion's
   *              `userAcceleration` / Android `TYPE_LINEAR_ACCELERATION`
   *              reconstructed in JS), derive `dt` from each sample's
   *              own `timestamp`, and time-normalise the filter
   *              constants so the detector behaves identically at any
   *              sensor cadence.
   *   'legacy' — the pre-0.25.4 behaviour, bit-for-bit: a per-sample
   *              IIR gravity estimate and a hardcoded 20 ms `dt`.
   *
   * ESCAPE HATCH, not a rollout gate.  `'legacy'` cannot tell a wrist
   * TILT from a sideways SLIDE (a re-projection of gravity onto the
   * cross-pan axis is arithmetically identical to real acceleration),
   * so it reads ~1.1 cm of phantom drift per degree of net tilt and
   * latches on ordinary hand movement.  Pass `'legacy'` only to
   * reproduce an old capture or to back out a device-specific
   * regression without pinning an old version.
   */
  lateralMotionModel?: LateralMotionModel;

  /**
   * Emit the throttled `[panMotion]` diagnostic logs.  Default
   * `__DEV__` — i.e. unset reproduces today's behaviour exactly.
   * Pass `true` to keep them in a release build while diagnosing a
   * field report; pass `false` to silence them in development.
   */
  panMotionDebug?: boolean;
}


export interface UsePanMotionReturn {
  /** Qualitative pan speed for the dominant gyro axis. */
  panSpeedBucket: PanSpeedBucket;
  /**
   * Signed lateral (cross-pan) translation since capture start, in
   * centimetres.  Updates on a throttled tick (~10 Hz), not per
   * sample.  Useful for a debug/HUD readout; the latch decision uses
   * the un-throttled internal value.
   */
  lateralCm: number;
  /**
   * `true` once |lateralCm| has exceeded `lateralBudgetCm`
   * continuously for the grace window.  Latching — stays true until
   * the next capture (`active` false → true).
   */
  lateralExceeded: boolean;
  /** Resolved pan axis (after auto-detect / `axis` override). */
  resolvedAxis: PanAxis;
}


// ── Speed-bucket constants ────────────────────────────────────────
// v0.16: lowered from 0.5 / 1.0.  On-device the old 1.0 rad/s (~57°/s)
// "bad" trip point almost never fired for a hand pan that's genuinely too
// fast for good keyframe overlap — a brisk-but-too-fast sweep sits around
// 0.5–0.8 rad/s.  0.6 rad/s (~34°/s) is the new "too fast" line; tune via
// the `panTooFastThreshold` prop (or the __DEV__ [panMotion] gyro logs).
const DEFAULT_GOOD_RAD_PER_SEC = 0.4;
const DEFAULT_WARN_RAD_PER_SEC = 0.6;

/**
 * Lateral-drift physics selector.  See `UsePanMotionOptions.lateralMotionModel`.
 */
export type LateralMotionModel = 'fused' | 'legacy';


// ── Lateral-drift constants ───────────────────────────────────────
// v0.16: lowered 5 → 4 cm so a deliberate sideways slide trips sooner.
// NOTE: the cm budget now only feeds the (secondary) accel readout; the
// PRIMARY lateral trigger is the gyro cross-axis below.
/**
 * Cross-pan drift budget, in centimetres, used when the caller does not
 * supply one.  SINGLE SOURCE OF TRUTH — `<Camera>`'s `lateralBudgetCm`
 * prop default imports this rather than repeating the literal, because
 * two independent copies of a tuning value silently diverge the moment
 * one is changed (and this one HAS been changed, in v0.25.3).
 *
 * v0.25.3: `4` -> `8`, after field reports of the lateral stop firing on
 * minor drift.  Only the budget moved; the detector is unchanged.
 */
export const DEFAULT_LATERAL_BUDGET_CM = 8;

/**
 * Default lateral-drift physics.  SINGLE SOURCE OF TRUTH — `<Camera>`'s
 * `lateralMotionModel` prop default imports this rather than repeating
 * the literal (same discipline as `DEFAULT_LATERAL_BUDGET_CM`, enforced
 * by `__tests__/lateralBudgetDefault.test.ts`).
 *
 * v0.25.4: `'fused'`.  This is a DEFECT FIX, not a feature — the legacy
 * integrator double-integrates raw device-Y with an IIR gravity
 * estimate and therefore cannot distinguish a change in how gravity
 * PROJECTS onto that axis from real lateral acceleration.  Replayed
 * numerically, a 10° wrist flick over 0.5 s (an ordinary re-grip)
 * reads 11.65 cm and sits over an 8 cm budget for 7 s — a guaranteed
 * false latch — while a REAL 20 cm sideways slide reads only 3.05 cm
 * and never latches.  The old model's discrimination is inverted, so
 * there is no consumer for whom it is preferable.
 */
export const DEFAULT_LATERAL_MOTION_MODEL: LateralMotionModel = 'fused';

/**
 * Lateral-drift trip point on the SMOOTHED cross-pan gyro rate (EMA of
 * `|gyro.x|`), in rad/s.
 *
 * v0.16 — on-device traces showed a user "moving perpendicular to the arrow"
 * is really a ROTATION about the cross-pan axis (gyro X), not a sideways
 * translation — so the old accel double-integration never saw it.  But the
 * raw cross rate is NOISY (dips between samples), so a continuous-over-
 * threshold dwell reset on every dip and never latched.  We instead smooth
 * `|gyro.x|` with an EMA (rides the dips, gives a ~0.4 s natural dwell) and
 * latch when the SMOOTHED rate stays above this line.  A clean pan smooths
 * to ~0.04; the user's two cross-turns smoothed to ~0.3 and ~0.7 — so 0.15
 * separates them with a comfortable margin.
 */
export const DEFAULT_LATERAL_TURN_RAD_PER_SEC = 0.15;

/**
 * EMA smoothing factor for the cross-pan gyro rate (per ~33 ms gyro sample).
 * ~0.08 gives a time constant of ~12 samples (~0.4 s) — enough to ride
 * through the inter-sample noise yet still respond within ~0.4 s of a
 * sustained cross-turn.
 */
const LATERAL_CROSS_EMA_ALPHA = 0.08;

/**
 * Continuous-over-budget dwell before `lateralExceeded` latches.
 * Filters out a settle-the-grip slide at capture start + single
 * wobbles that cross and recross the threshold.  Documented in the
 * task as a permitted design decision.
 */
const LATERAL_GRACE_MS = 500;

/**
 * Accelerometer sample interval (≈50 Hz).  Matches
 * `useIMUTranslationGate` so the integration math + drift profile are
 * identical.
 */
const ACCEL_SAMPLE_INTERVAL_MS = 20;

/**
 * Gyro sample interval (≈30 Hz).  Matches `PanoramaGuidance` so each
 * sample maps to roughly one recording frame's pan.
 */
const GYRO_SAMPLE_INTERVAL_MS = 33;

/**
 * How often the throttled `lateralCm` React value is emitted.  The
 * integrator runs at 50 Hz but we don't want 50 re-renders/sec for a
 * cosmetic readout, so we coalesce to ~10 Hz.
 */
const LATERAL_EMIT_INTERVAL_MS = 100;

// ── Drift-mitigation constants (lifted from useIMUTranslationGate) ─
/// Per-sample multiplicative damping on the velocity integrator.
const VELOCITY_DAMPING_PER_SAMPLE = 0.05;
/// IIR low-pass coefficient for the per-axis gravity estimate.
const GRAVITY_IIR_ALPHA = 0.9;
/// 1 G in m/s².  `react-native-sensors` reports iOS accel in G's,
/// Android in m/s²; we scale iOS into m/s² so the integrator is in
/// standard units.
const G_TO_MPS2 = 9.81;
/// 1 metre = 100 centimetres.  The integrator works in metres; the
/// public API is centimetres (matches the design copy + budget unit).
const M_TO_CM = 100;

// ── Variable-dt + fused-gravity constants (v0.25.4) ───────────────
/**
 * The cadence the legacy per-sample filter constants were tuned at.
 * `VELOCITY_DAMPING_PER_SAMPLE` and `GRAVITY_IIR_ALPHA` are per-SAMPLE
 * coefficients, so their time constants are only 390 ms / 190 ms at
 * THIS interval.  Every use of a real `dt` re-expresses them as
 * `k ** (dt / NOMINAL_DT_S)` so the time constant is what's fixed, not
 * the per-sample coefficient.  At `dt === NOMINAL_DT_S` the exponent is
 * 1 and the arithmetic collapses to the legacy constants EXACTLY.
 */
const NOMINAL_DT_S = ACCEL_SAMPLE_INTERVAL_MS / 1000.0;
/** Same idea for the gyro cross-axis EMA, which was tuned at 33 ms. */
const NOMINAL_GYRO_DT_S = GYRO_SAMPLE_INTERVAL_MS / 1000.0;
/**
 * Plausible bounds on a sensor-derived `dt`, seconds.  Below the floor
 * is a same-millisecond burst (both platforms truncate `timestamp` to
 * whole ms); above the ceiling is a GAP — a backgrounded app, a stalled
 * JS thread, a dropped sample — not a long sample.
 */
const DT_MIN_S = 0.002;
const DT_MAX_S = 0.100;
/**
 * A gravity sample older than this is stale: the two observables run at
 * independent cadences, so we hold the last gravity vector between
 * accel samples, but only for about one nominal gravity period.
 */
const GRAVITY_STALE_MS = 250;
/**
 * If no gravity sample has arrived this long after subscribing, give up
 * on it for THIS capture and run the legacy IIR.  Covers the silent
 * failures `error` never reports: Android OEMs with no fused
 * `TYPE_GRAVITY`, and RN bridgeless event delivery that never wires up.
 */
const GRAVITY_WARMUP_MS = 500;
/**
 * Plausibility band on |gravity| AFTER unit scaling, m/s².  The ONLY
 * thing that catches iOS's nil-`deviceMotion` path, where the handler
 * dereferences a nil object and the stream emits `{0,0,0}` forever with
 * no error — which would silently disable compensation entirely
 * (`lin = a - 0 = a`), i.e. WORSE than the legacy IIR.  Also catches a
 * unit slip (unscaled iOS G's read ~1.0).
 */
const GRAVITY_MIN_MPS2 = 8.5;
const GRAVITY_MAX_MPS2 = 11.0;
/**
 * DC gain of the leaky velocity integrator, seconds — the `v_ss / a` of
 * the legacy per-sample form at the nominal cadence, by construction:
 *   dt·d/(1−d) = 0.02 · 0.95 / 0.05 = 0.38 s
 * Used as the zero-order-hold input gain on the OFF-NOMINAL branch so
 * `v_ss` is independent of the delivery cadence.  The legacy form still
 * drifts by −dt/(2·τ_v): v_ss(a=1) is 0.3874 @5 ms, 0.3800 @20 ms,
 * 0.3420 @100 ms.
 */
const VELOCITY_TAU_EFF_S =
  (NOMINAL_DT_S * (1 - VELOCITY_DAMPING_PER_SAMPLE))
  / VELOCITY_DAMPING_PER_SAMPLE; // 0.38
/**
 * STAGE-2 residual-bias high-pass time constant, seconds.
 *
 * Stage 1 (`a − g`, true gravity subtraction) has NO DC rejection, so
 * any persistent accel-vs-fused-gravity residual ramps `pos` without
 * bound at `b · τ_v`.  Measured on a perfectly still phone: b = 0.02
 * m/s² reaches 5.78 cm in 8 s and 14.90 cm in 20 s; b = 0.05 crosses an
 * 8 cm budget in ~4.4 s, INSIDE a normal capture.  The legacy 190 ms
 * IIR made that arithmetically impossible, so deleting it without a
 * replacement high-pass would trade a bounded tilt false-positive for an
 * unbounded bias one.
 *
 * WHY 0.5 s.  The binding constraint is an Android OEM whose
 * `TYPE_GRAVITY` is a low-passed accelerometer (the AOSP no-gyro
 * fallback, τ ≈ 0.5 s).  Such a device passes the |g| plausibility band
 * cleanly and gets ZERO tilt rejection from stage 1, so stage 2 is the
 * only thing between it and a false latch.  Measured peak on a 10°
 * wrist flick with that gravity source:
 *     τ_b = 0.4 → 5.69 cm   0.5 → 7.79   0.6 → 10.15
 *           0.7 → 12.67     1.0 → 20.32   (legacy reads 11.74)
 * 0.5 s is the LARGEST τ_b for which the worst-case device still reads
 * below legacy.  At τ_b ≥ 0.6 this "fix" would make that device worse
 * than the bug.
 *
 * COUPLING TO WATCH IF YOU RETUNE.  The two-stage DC gain is
 * `τ_b · VELOCITY_TAU_EFF_S` metres per m/s².  A residual that STEPS or
 * drifts after convergence parks a permanent offset of `τ_b · 0.38 · b`
 * — 0.38 cm at b = 0.02, 0.95 cm at b = 0.05 (12 % of an 8 cm budget).
 * Raising τ_b raises that pedestal linearly.
 */
const RESIDUAL_BIAS_TAU_S = 0.5;


/**
 * Map a signed rotation rate (rad/s) onto the qualitative speed
 * bucket.  Pure — exported for tests.  Lifted verbatim from
 * `PanoramaGuidance.bucketFor` so the two surfaces never diverge.
 *
 * Thresholds are INCLUSIVE of the lower band: `|rate| <= good` is
 * 'good', `|rate| <= warn` is 'warn', otherwise 'bad'.
 */
export function _bucketForRate(
  rate: number,
  good: number,
  warn: number,
): PanSpeedBucket {
  const abs = Math.abs(rate);
  if (abs <= good) return 'good';
  if (abs <= warn) return 'warn';
  return 'bad';
}


/**
 * Pick the dominant gyro axis value for a pan direction.  Mirrors
 * `PanoramaGuidance`'s `resolvedAxis === 'horizontal' ? y : x`:
 *   horizontal pan (portrait)  → gyro Y dominates.
 *   vertical   pan (landscape) → gyro X dominates.
 * Pure — exported for tests.
 */
export function _gyroRateForAxis(
  axis: PanAxis,
  gyro: { x: number; y: number },
): number {
  return axis === 'horizontal' ? gyro.y : gyro.x;
}


/**
 * Resolve the pan axis the same way `PanoramaGuidance` does:
 *   explicit `axis` override wins; otherwise portrait → 'horizontal',
 *   landscape → 'vertical'.  Pure — exported for tests.
 */
export function _resolvePanAxis(
  orientation:
    | 'portrait'
    | 'portrait-upside-down'
    | 'landscape-left'
    | 'landscape-right',
  override?: PanAxis,
): PanAxis {
  if (override) return override;
  const isPortrait =
    orientation === 'portrait' || orientation === 'portrait-upside-down';
  return isPortrait ? 'horizontal' : 'vertical';
}


/**
 * Internal lateral-integrator state.  One device axis (device-Y, the
 * cross-pan axis) integrated to a position, with the same IIR-gravity
 * + velocity-damping recipe as `useIMUTranslationGate`'s X gate.
 *
 * Unlike that gate, `pos` is NEVER reset by keyframe accepts — only by
 * `resetLateralState` at capture start — so it accumulates total
 * cross-pan drift across the whole capture.
 */
/** Which estimator produced the last sample's linear acceleration. */
export type LateralLinSource = 'fused' | 'legacy-iir';


export interface LateralState {
  /** Integrated cross-pan position, METRES. */
  pos: number;
  /** Integrated cross-pan velocity, m/s. */
  vel: number;
  /** IIR-estimated gravity component on the cross-pan axis (m/s²). */
  gravity: number;
  /**
   * `true` once the latch has tripped; stays true for the capture.
   * Mirrors `useIMUTranslationGate`'s `fired`, but here it never
   * auto-rearms (drift is a one-shot finalize, not a re-trigger).
   */
  exceeded: boolean;
  /**
   * Timestamp (ms, performance.now-style) at which |pos| first went
   * over budget in the current continuous over-budget run, or `null`
   * if currently under budget.  Drives the grace window.
   */
  overBudgetSinceMs: number | null;
  /**
   * `timestamp` (epoch ms, as reported by the sensor) of the previous
   * accelerometer sample, or `null` before the first one.  Drives the
   * real per-sample `dt`.  Separate from `overBudgetSinceMs`, which is
   * a `Date.now()` wall-clock value — the two clocks are deliberately
   * NOT mixed (see `_sanitizeDt`).
   */
  lastTsMs: number | null;

  // ── stage-2 residual-bias high-pass ──────────────────────────────
  /** Zero-initialised EMA accumulator for the stage-2 bias, m/s². */
  biasRaw: number;
  /**
   * Fused samples since the fused path was (re-)entered.  Drives the
   * Adam-style de-bias correction `1/(1−(1−k)^n)`, which makes the
   * zero-seeded EMA behave as a RUNNING MEAN for its first samples
   * instead of ramping up from zero.
   */
  biasN: number;
  /**
   * De-biased stage-2 estimate actually subtracted, m/s².  `NaN` on the
   * legacy path.  Telemetry + tests only; never re-read as an input.
   */
  bias: number;
  /**
   * Was the last sample integrated with a fused gravity vector?  A
   * false→true edge restarts the stage-2 estimator so re-entry is
   * stepless (`lin === 0` on the first fused sample).
   */
  usedFused: boolean;

  // ── telemetry (inert; never feeds the physics) ────────────────────
  /** `dt` actually integrated with on the last sample, seconds. */
  lastDtS: number;
  /** Linear acceleration used on the last sample, m/s². */
  lastLin: number;
  /** Which estimator produced `lastLin`. */
  lastSource: LateralLinSource;
  /** Samples whose `dt` was a GAP and therefore had velocity dropped. */
  gapCount: number;
}


/**
 * Outcome of one `dt` derivation: the seconds to integrate with, plus
 * whether this sample followed a GAP (in which case the motion across
 * the gap was unobserved and carrying velocity through it is
 * unjustified), plus a slug naming which rule fired — the single most
 * useful field in the debug telemetry, because it answers "is this
 * device actually delivering at the rate we asked for?".
 */
export interface DtSample {
  dtSec: number;
  gap: boolean;
  source: 'first' | 'sensor' | 'burst' | 'nonmonotonic' | 'gap';
}


/**
 * Result of one grace-window latch evaluation: the (possibly latched)
 * exceeded flag + the (possibly cleared/started) continuous-over-budget
 * timer.  See `_evalGraceLatch`.
 */
export interface GraceLatchResult {
  exceeded: boolean;
  overBudgetSinceMs: number | null;
}


/**
 * Pure grace-window latch decision, factored out of the integrator so
 * the debounce is testable without constructing a physical
 * acceleration profile.  Given whether |pos| is currently over budget,
 * the clock, and the prior latch/timer state, decide the next state:
 *
 *   - under budget          → clear the timer; never un-latch.
 *   - over budget, no timer  → start the timer (note: NOT yet latched).
 *   - over budget, timer old  → latch once `now - since >= graceMs`.
 *   - already latched        → stays latched forever (one-shot
 *                              finalize; see header).
 *
 * @param overBudget  is |pos| currently over the budget?
 * @param nowMs       monotonic clock, ms
 * @param prevSinceMs timestamp |pos| first went over in the current
 *                    continuous run, or `null` if previously under
 * @param prevExceeded already-latched flag from the prior sample
 * @param graceMs     continuous dwell required before latching
 */
export function _evalGraceLatch(
  overBudget: boolean,
  nowMs: number,
  prevSinceMs: number | null,
  prevExceeded: boolean,
  graceMs: number,
): GraceLatchResult {
  // One-shot: once latched, stay latched (don't even touch the timer).
  if (prevExceeded) {
    return { exceeded: true, overBudgetSinceMs: prevSinceMs };
  }
  if (!overBudget) {
    // Dipped back under budget — reset the dwell timer so a wobble
    // that crosses and recrosses never accumulates grace.
    return { exceeded: false, overBudgetSinceMs: null };
  }
  // Over budget, not yet latched.
  if (prevSinceMs === null) {
    // First sample of a new over-budget run — start the clock.
    return { exceeded: false, overBudgetSinceMs: nowMs };
  }
  // Continuous over-budget run in progress — latch once it's old
  // enough.
  if (nowMs - prevSinceMs >= graceMs) {
    return { exceeded: true, overBudgetSinceMs: prevSinceMs };
  }
  return { exceeded: false, overBudgetSinceMs: prevSinceMs };
}


/** A fresh integrator, as seeded at every capture start. */
export function _freshLateralState(): LateralState {
  return {
    pos: 0,
    vel: 0,
    // NaN = uninitialised; the first sample seeds gravity from itself
    // (same convention as useIMUTranslationGate).
    gravity: NaN,
    exceeded: false,
    overBudgetSinceMs: null,
    lastTsMs: null,
    biasRaw: 0,
    biasN: 0,
    bias: NaN,
    usedFused: false,
    lastDtS: NOMINAL_DT_S,
    lastLin: 0,
    lastSource: 'legacy-iir',
    gapCount: 0,
  };
}


/**
 * Reset the integrator in place for a new capture.  Zeroes position,
 * velocity, the latch, and the grace timer, and re-arms gravity
 * seeding.  Pure (mutates the passed object, returns it) — exported so
 * tests can assert the "resets only at capture start" contract.
 */
export function _resetLateralState(s: LateralState): LateralState {
  s.pos = 0;
  s.vel = 0;
  s.gravity = NaN;
  s.exceeded = false;
  s.overBudgetSinceMs = null;
  s.lastTsMs = null;
  s.biasRaw = 0;
  s.biasN = 0;
  s.bias = NaN;
  s.usedFused = false;
  s.lastDtS = NOMINAL_DT_S;
  s.lastLin = 0;
  s.lastSource = 'legacy-iir';
  s.gapCount = 0;
  return s;
}


/**
 * Derive a trustworthy integration step from two consecutive sensor
 * `timestamp`s.  Pure — exported for tests.
 *
 * CLOCK CHOICE.  `dt` comes from the sensor's own `timestamp`; the
 * grace window and the emit throttle keep using `Date.now()`.  They are
 * deliberately never mixed.  Both platforms build `timestamp` as
 * "wall clock now MINUS the age of this sample", sampled inside the
 * delivery handler:
 *
 *   iOS      floor((NSDate.now + (item.timestamp - systemUptime)) * 1000)
 *   Android  currentTimeMillis() + (event.timestamp - elapsedRealtimeNanos()) / 1e6
 *
 * Both terms are read at handler time, so a LATE handler shifts both
 * equally and they cancel: bunched deliveries still yield the correct
 * dt.  That is exactly the case a hardcoded 20 ms gets wrong — a
 * main-thread stall during a pan — which is why the real timestamp is
 * worth taking.  What the construction does NOT give you is a
 * trustworthy ABSOLUTE value: it is wall-clock based (an NTP step moves
 * it, possibly backwards), it is truncated to whole milliseconds on
 * both platforms, and on Android OEMs whose `event.timestamp` is not in
 * the `elapsedRealtimeNanos` base the absolute value is garbage while
 * the DELTA stays correct.
 *
 * Hence the rule: DELTAS ONLY, and clamp them.
 *
 *   - no predecessor, or a non-finite timestamp → nominal dt.
 *   - delta <= 0 (clock step, or two events in one truncated ms)
 *     → nominal dt.  `dt === 0` stalls position while still decaying
 *       velocity; `dt < 0` runs position BACKWARDS and, with the
 *       time-normalised damping, raises `damp` above 1 and AMPLIFIES
 *       velocity — the one input that can make the integrator diverge.
 *   - delta below the floor → a same-millisecond burst; clamp up.
 *   - delta above the ceiling → a GAP, not a long sample.  Integrating
 *     a stale velocity across a 2 s backgrounding injects a phantom
 *     displacement in a single line, so we substitute the nominal dt
 *     AND flag `gap` so the caller can zero velocity.
 */
export function _sanitizeDt(
  prevTsMs: number | null,
  tsMs: number,
  nominalDtSec: number = NOMINAL_DT_S,
): DtSample {
  if (
    prevTsMs === null
    || !Number.isFinite(prevTsMs)
    || !Number.isFinite(tsMs)
  ) {
    return { dtSec: nominalDtSec, gap: false, source: 'first' };
  }
  const rawSec = (tsMs - prevTsMs) / 1000;
  if (rawSec <= 0) {
    return { dtSec: nominalDtSec, gap: false, source: 'nonmonotonic' };
  }
  if (rawSec < DT_MIN_S) {
    return { dtSec: DT_MIN_S, gap: false, source: 'burst' };
  }
  if (rawSec > DT_MAX_S) {
    return { dtSec: nominalDtSec, gap: true, source: 'gap' };
  }
  return { dtSec: rawSec, gap: false, source: 'sensor' };
}


/**
 * Extra, OPTIONAL inputs to `_integrateLateralSample`.  Deliberately an
 * 8th trailing optional parameter rather than an options-object
 * refactor: 12 existing call sites pass 7 positional arguments, and
 * `ts-jest` runs TRANSPILE-ONLY (`isolatedModules`), so a broken
 * signature migration would leave `npx jest` GREEN while silently
 * feeding `budgetM` into `graceMs`.  Omitting this parameter yields
 * the legacy path, bit-for-bit.
 */
export interface LateralSampleOptions {
  /**
   * Cross-pan component of the FUSED GRAVITY vector for this sample,
   * already unit-scaled to m/s².  `null`/`undefined` selects the legacy
   * per-sample IIR estimate — which is what happens during gravity
   * warm-up, when the last gravity sample is stale, and forever on a
   * device that has no fused gravity sensor.
   */
  gravityMps2?: number | null;
  /**
   * This sample followed a `dt` gap.  Zero velocity: the motion across
   * the gap was unobserved, so carrying momentum through it is
   * unjustified.
   */
  afterGap?: boolean;
}


/**
 * Advance the lateral integrator by one accelerometer sample.  Pure
 * (mutates + returns the passed state) so the integration math is
 * unit-testable without a sensor or a React render.
 *
 * @param s         running integrator state (mutated in place)
 * @param rawAxis   raw cross-pan accel reading for this sample, in the
 *                  platform's native unit (G's on iOS, m/s² on
 *                  Android) — caller has NOT yet applied `scale`
 * @param scale     unit scale (G_TO_MPS2 on iOS, 1 on Android)
 * @param dt        sample period, seconds
 * @param budgetM   lateral budget, METRES
 * @param graceMs   continuous-over-budget dwell before latching, ms
 * @param nowMs     WALL CLOCK (`Date.now()`) for this sample, ms —
 *                  drives the grace window ONLY.  Never the sensor
 *                  timestamp; see `_sanitizeDt` on why the two clocks
 *                  are kept apart.
 * @param opts      optional fused-gravity / gap inputs.  OMIT for the
 *                  legacy path (bit-for-bit pre-0.25.4 behaviour).
 * @returns the same `s` (mutated): `pos` is the new cross-pan position
 *          in metres; `exceeded` is the latched flag.
 *
 * NOTE the first call only seeds gravity and returns with `pos`
 * unchanged (matches `useIMUTranslationGate`'s first-sample handling)
 * — the first reading is assumed to be ~stationary at capture start.
 */
export function _integrateLateralSample(
  s: LateralState,
  rawAxis: number,
  scale: number,
  dt: number,
  budgetM: number,
  graceMs: number,
  nowMs: number,
  opts?: LateralSampleOptions,
): LateralState {
  const a = rawAxis * scale; // cross-pan acceleration, m/s²

  // First sample seeds the gravity estimate from itself.
  if (Number.isNaN(s.gravity)) {
    s.gravity = a;
    s.lastDtS = dt;
    s.lastLin = 0;
    s.lastSource = 'legacy-iir';
    return s;
  }

  const atNominal = dt === NOMINAL_DT_S;
  const nSteps = dt / NOMINAL_DT_S;

  // The IIR runs on EVERY sample, in both models.  In 'fused' it is a
  // SHADOW estimate we do not consume — but keeping it warm is what
  // makes failover seamless: gravity can die mid-capture (stale
  // delivery, a backgrounded app), and on the very next sample the
  // fallback is already converged instead of re-seeding from scratch.
  // It also costs two multiply-adds and gives the telemetry an
  // independent second opinion to diff against.
  //
  // Time-normalised for the same reason the damping is: the fallback is
  // the path gyro-less Android devices live on PERMANENTLY, so leaving
  // it rate-dependent would preserve the dt defect exactly where it is
  // least observable.  Bit-exact at nominal.
  const alphaG = atNominal
    ? GRAVITY_IIR_ALPHA
    : Math.pow(GRAVITY_IIR_ALPHA, nSteps);
  s.gravity = alphaG * s.gravity + (1 - alphaG) * a;

  const gExt = opts?.gravityMps2;
  const useFused = gExt !== undefined && gExt !== null && Number.isFinite(gExt);

  let lin: number;
  if (useFused) {
    // Re-entering the fused path (warm-up done, staleness cleared, gap
    // recovered) restarts stage 2 so the transition is stepless: with
    // `biasN === 1` the de-bias correction makes `bias === linRaw`,
    // hence `lin === 0` on the first fused sample.
    if (!s.usedFused) {
      s.biasRaw = 0;
      s.biasN = 0;
    }

    // ── STAGE 1: true gravity subtraction.  This is the tilt fix —
    // tilting the phone changes `a` and `gExt` by the SAME amount and
    // they cancel.  With the IIR estimate they cancel only after
    // ~190 ms, and the residual during a tilt is indistinguishable from
    // real translation (that residual IS the 4 cm field bug).
    const linRaw = a - gExt;

    // ── STAGE 2: slow high-pass on the RESIDUAL only, removing
    // accelerometer bias + gravity-fusion error (both ~DC over a
    // capture).  Without it `pos` ramps without bound — see
    // RESIDUAL_BIAS_TAU_S.  τ_b = 500 ms is ~2.6x slower than the
    // legacy 190 ms IIR, which is where the retained sensitivity to a
    // real slide comes from.
    //
    // Zero-init EMA + Adam-style de-bias correction: behaves as a
    // RUNNING MEAN over its first samples and settles into the
    // exponential filter.  Measured on a still phone carrying a
    // 0.05 m/s² residual: de-biased 0.12 cm, plain EMA from zero
    // 0.93 cm, seed-from-first-sample 0.13 cm but 0.63 cm on noise
    // alone (one sample of accel noise banked as bias).
    const kB = 1 - Math.exp(-dt / RESIDUAL_BIAS_TAU_S);
    s.biasRaw = (1 - kB) * s.biasRaw + kB * linRaw;
    s.biasN += 1;
    const corr = 1 - Math.pow(1 - kB, s.biasN);
    s.bias = corr > 0 ? s.biasRaw / corr : linRaw;
    lin = linRaw - s.bias;
    s.lastSource = 'fused';
  } else {
    lin = a - s.gravity;
    s.bias = NaN;
    s.lastSource = 'legacy-iir';
  }
  s.usedFused = useFused;

  // A gap means the motion in between was unobserved — do not carry
  // momentum across it.
  if (opts?.afterGap) {
    s.vel = 0;
    s.gapCount += 1;
  }

  // Time-normalised damping.  `VELOCITY_DAMPING_PER_SAMPLE` is a
  // per-SAMPLE coefficient, so feeding a real (variable) `dt` into the
  // integrator while leaving `0.95` fixed would make the detector's
  // sensitivity LINEAR IN THE DEVICE'S SENSOR CADENCE: for a sustained
  // acceleration the damped steady state is `v = a·dt·d/(1−d)`, i.e.
  // `19·a·dt` with `d` fixed, so a 40 ms device would report exactly
  // TWICE the centimetres of a 20 ms one for identical physical motion
  // (measured: 5.79 cm at 20 ms → 11.00 cm at 40 ms → 23.30 cm at
  // 100 ms).  That would be worse than the bug being fixed.
  //
  // Re-expressing it as `k ** (dt / NOMINAL_DT_S)` fixes the TIME
  // constant (τ = −NOMINAL_DT_S / ln k = 390 ms) instead of the
  // coefficient, so `1 − d ≈ dt/τ` and `v_ss ≈ a·τ` — independent of dt
  // to first order (measured: 5.90 / 5.86 / 5.79 / 5.65 / 5.24 cm
  // across 5→100 ms).  At `dt === NOMINAL_DT_S` the exponent is exactly
  // 1, so every existing tuning number and every existing test
  // magnitude is preserved BIT-FOR-BIT; the fast path below makes that
  // exact rather than merely floating-point-close.
  const damp = atNominal
    ? 1 - VELOCITY_DAMPING_PER_SAMPLE
    : Math.pow(1 - VELOCITY_DAMPING_PER_SAMPLE, nSteps);

  // Velocity update — TWO BRANCHES, deliberately.
  //
  // The nominal branch is the LITERAL legacy expression.  IEEE-754 is
  // not distributive, so `damp*v + (dt*damp)*lin` is NOT bit-identical
  // to `(v + lin*dt)*damp`; only re-using the same expression is.  That
  // exactness is what lets the frozen integrator assertions — one of
  // which pins `overBudgetSinceMs === 380`, a discrete crossing —
  // survive untouched.
  //
  // The off-nominal branch is the zero-order-hold form, whose steady
  // state is `VELOCITY_TAU_EFF_S · lin` INDEPENDENT of dt.  The legacy
  // form still drifts −dt/(2·τ_v): v_ss(a=1) is 0.3874 @5 ms, 0.3800
  // @20 ms, 0.3420 @100 ms.  Near nominal the two agree to ~1.5e-6
  // relative, so the branch is a numerical detail, not a discontinuity.
  s.vel = atNominal
    ? (s.vel + lin * dt) * damp
    : damp * s.vel + VELOCITY_TAU_EFF_S * (1 - damp) * lin;
  s.pos += s.vel * dt;

  s.lastDtS = dt;
  s.lastLin = lin;

  // Grace-windowed latch — delegated to the pure decision helper so
  // the debounce is unit-testable independently of the integrator
  // physics.
  const latch = _evalGraceLatch(
    Math.abs(s.pos) > budgetM,
    nowMs,
    s.overBudgetSinceMs,
    s.exceeded,
    graceMs,
  );
  s.exceeded = latch.exceeded;
  s.overBudgetSinceMs = latch.overBudgetSinceMs;

  return s;
}


/**
 * Latest fused-gravity reading, held between accelerometer samples.
 *
 * PAIRING STRATEGY — hold-last, no interpolation.  `gravity` and
 * `accelerometer` are INDEPENDENT observables at independent cadences,
 * so pairing "latest gravity" with "current accel" carries up to one
 * gravity period of skew.  That skew is bounded and tiny compared to
 * what it replaces: at a 20 ms gravity cadence and a brisk 5°/s tilt
 * the pairing error is `9.81 · sin(0.1°)` ≈ 0.017 m/s², versus the
 * legacy 190 ms-lagged IIR whose residual is what produces the 4 cm
 * false reading in the first place.  Measured end to end: a 3.7° / 8 s
 * tilt ramp reads 4.02 cm under the IIR and 0.46 cm with hold-last
 * pairing at a full 20 ms of skew — an 8.8× improvement.  Interpolating
 * between two gravity samples would buy back most of that 0.46 cm, but
 * it costs a one-sample delay on the OUTPUT (you cannot interpolate to
 * a time you have not yet bracketed) and the residual is already an
 * order of magnitude under the budget.  Not worth it.
 *
 * A pure yaw pan — the motion this hook exists to measure — rotates
 * ABOUT the gravity vector, so `dg/dt ≈ 0` and the pairing error
 * vanishes entirely.  The skew only appears during the pitch/roll tilt
 * we are cancelling, which is precisely where it is affordable.
 */
interface GravityFeed {
  /** Cross-pan (device-Y) gravity component, SCALED to m/s². */
  y: number | null;
  /** `Date.now()` at which `y` was received — for staleness. */
  tsMs: number;
  /** `Date.now()` at which the subscription was opened — for warm-up. */
  startedMs: number;
  /** Accepted samples (passed the plausibility band). */
  accepted: number;
  /** Samples rejected by the plausibility band. */
  rejected: number;
  /** Terminal error slug, if the observable errored. */
  error: string | null;
}


/**
 * One error on a `react-native-sensors` observable poisons it for the
 * lifetime of the JS context: `sensors.js` builds the stream with
 * `publish()`, i.e. `multicast` over a CONCRETE `Subject` instance, so
 * the subject factory returns the SAME subject every time.  Once
 * `Subject.error()` sets `hasError`, every later `subscribe` is failed
 * SYNCHRONOUSLY from `_checkFinalizedStatuses`, forever.  `rnsensors.js`
 * additionally caches the rejected `isAvailable()` promise in
 * `availableSensors[type]`, so the native module is never asked twice.
 *
 * Therefore: remember the verdict process-wide and never resubscribe.
 * Retrying cannot succeed and only costs a synchronous throw per
 * capture.
 */
let gravitySensorDeadForProcess = false;


/**
 * Is a usable `gravity` observable present at all?
 *
 * This guard is doing THREE jobs at once, which is why it is a runtime
 * check rather than a peer-dependency bump:
 *
 *  1. `package.json` declares `react-native-sensors: >=7.0.0`, but
 *     `gravity` only appears in 7.3.0 (7.0.0 has neither `orientation`
 *     nor `gravity`; 7.1–7.2 have `orientation` only).  On 7.0–7.2 the
 *     import is a silent `undefined` under Metro's CJS interop, and
 *     `setUpdateIntervalForType(undefined, 20)` dies inside
 *     `nativeApis.get(undefined)` with "Cannot read property
 *     'setUpdateInterval' of undefined".  Raising the peer range would
 *     be a BREAKING change for consumers; this is not.
 *  2. The library's own jest mocks (8 files across `src/`) stub
 *     `react-native-sensors` as an object literal with only
 *     `accelerometer`/`gyroscope`, so `gravity` is `undefined` there.
 *     The guard makes every one of them keep passing untouched.
 *  3. It is the natural place to honour the process-wide dead flag.
 *
 * Optional chaining is load-bearing: `gravitySensor` is `undefined` on
 * an old peer version, and `typeof undefined?.subscribe` short-circuits
 * instead of throwing.
 */
function _gravitySensorUsable(): boolean {
  return (
    !gravitySensorDeadForProcess
    && typeof gravitySensor?.subscribe === 'function'
    && typeof SensorTypes?.gravity === 'string'
  );
}


/**
 * Open the fused-gravity subscription and stream the scaled cross-pan
 * component into `feed`.  Returns an unsubscribe thunk (a no-op when
 * the sensor is unusable).
 *
 * NOTE the `{ next, error }` OBJECT form.  The bare-function overload
 * that `accelerometer` uses today is a latent bug: rxjs routes an
 * unhandled observable error to `reportUnhandledError`, which
 * `setTimeout`s a throw — a redbox.  And because the failure originates
 * in a PROMISE rejection (`isAvailable`), it is always asynchronous, so
 * a `try`/`catch` around `subscribe()` cannot catch it.  A device with
 * no fused `TYPE_GRAVITY` (it is a virtual sensor and needs a
 * gyroscope, so gyro-less budget Androids lack it) would redbox the
 * app.  Never clone that pattern here.
 */
function _subscribeGravity(
  feed: GravityFeed,
  scale: number,
  intervalMs: number,
): () => void {
  if (!_gravitySensorUsable()) {
    feed.error = 'unavailable';
    return () => {};
  }
  // ORDER IS LOAD-BEARING on Android.  `RNSensor.interval` is an
  // uninitialised `int` (0), and `startUpdates()` does
  // `registerListener(this, sensor, this.interval * 1000)` — so if the
  // interval is still 0 at subscribe time we register at
  // SENSOR_DELAY_FASTEST *and* the JS throttle
  // (`tempMs - lastReading >= interval`) passes every event: a
  // 200–400 Hz bridge flood for the life of the process, because
  // `registerListener` is never called again.  This call is safe to
  // make first: `RNSensors.start()` runs inside the async
  // `isAvailable().then(...)`, so a synchronous interval write always
  // lands ahead of it.
  try {
    setUpdateIntervalForType(SensorTypes.gravity, intervalMs);
  } catch {
    // A missing/half-linked native module throws synchronously here.
    feed.error = 'set-interval-threw';
    return () => {};
  }

  let sub: Subscription | null = gravitySensor.subscribe({
    next: ({ x, y, z }) => {
      // PLAUSIBILITY BAND — the only defence against iOS's nil
      // `deviceMotion`.  `RNSensorsGravity.m` dereferences the handler
      // argument unconditionally (`deviceMotion.gravity.x`); when motion
      // access is denied or CoreMotion hands back an NSError, that
      // object is nil, ARM64 nil-messaging zeroes the struct return, and
      // the stream emits `{0,0,0}` FOREVER with no error at all.
      // Subtracting a zero "gravity" would leave `lin = a`, i.e.
      // gravity compensation silently OFF — strictly worse than the
      // legacy IIR.  Requiring |g| ≈ 1 g also catches a unit slip
      // (unscaled iOS G's read 1.0, Android m/s² read 9.81).
      const mag = Math.hypot(x, y, z) * scale;
      if (
        !Number.isFinite(mag)
        || mag < GRAVITY_MIN_MPS2
        || mag > GRAVITY_MAX_MPS2
      ) {
        feed.rejected += 1;
        return;
      }
      // Cross-pan axis is device-Y, same axis the accelerometer path
      // integrates.  NO per-platform sign flip: both platforms define
      // `acceleration = gravity + userAcceleration`, so accel and
      // gravity share a convention WITHIN a platform (iOS face-up:
      // both z ≈ −1 G; Android face-up: both z ≈ +9.81) and `a − g` is
      // linear acceleration on both.  `useDeviceOrientation`'s
      // `isAndroid ? -x : x` flip normalises the two platforms against
      // each other for CLASSIFICATION; applying it here would flip only
      // one of the two terms and DOUBLE gravity instead of cancelling
      // it.
      feed.y = y * scale;
      feed.tsMs = Date.now();
      feed.accepted += 1;
    },
    error: (err) => {
      feed.error = 'errored';
      gravitySensorDeadForProcess = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[usePanMotion] gravity sensor unavailable — falling back to the '
        + 'legacy IIR gravity estimate for the rest of this process',
        err,
      );
    },
  });

  return () => {
    sub?.unsubscribe();
    sub = null;
  };
}


export function usePanMotion({
  active,
  axis,
  goodMaxRadPerSec = DEFAULT_GOOD_RAD_PER_SEC,
  warnMaxRadPerSec = DEFAULT_WARN_RAD_PER_SEC,
  lateralBudgetCm = DEFAULT_LATERAL_BUDGET_CM,
  lateralTurnRateRadPerSec = DEFAULT_LATERAL_TURN_RAD_PER_SEC,
  lateralMotionModel = DEFAULT_LATERAL_MOTION_MODEL,
  panMotionDebug,
}: UsePanMotionOptions): UsePanMotionReturn {
  // Unset reproduces today's behaviour EXACTLY (both existing logs are
  // already `__DEV__`-gated at a 400 ms throttle).  `?? __DEV__` rather
  // than `|| __DEV__` so an explicit `false` can silence them in dev.
  const debugEnabled = panMotionDebug ?? __DEV__;
  // Physical orientation (sensor-based — works under portrait-lock),
  // same source `PanoramaGuidance` uses to pick the pan axis.
  const deviceOrientation = useDeviceOrientation();
  const resolvedAxis = _resolvePanAxis(deviceOrientation, axis);

  // Qualitative pan speed — state so a bucket *flip* re-renders, but
  // per-sample updates don't.
  const [panSpeedBucket, setPanSpeedBucket] = useState<PanSpeedBucket>('good');
  const lastBucketRef = useRef<PanSpeedBucket>('good');

  // Lateral integrator state lives in a ref so the 50 Hz accelerometer
  // callback never forces a re-render.
  const lateralRef = useRef<LateralState>(_freshLateralState());

  // PRIMARY lateral-drift signal (v0.16): an EMA of the CROSS-pan GYRO rate
  // (`|gyro.x|`), updated in the gyro handler.  Smoothing rides through the
  // raw rate's inter-sample noise (which defeated a binary dwell latch).
  // Reset to 0 at capture start.
  const crossEmaRef = useRef(0);

  // The throttled, render-visible lateral magnitude (cm) + the latched
  // exceeded flag.  These DO go through state because consumers render
  // them, but they update at most ~10 Hz / once respectively.
  const [lateralCm, setLateralCm] = useState(0);
  const [lateralExceeded, setLateralExceeded] = useState(false);

  /**
   * WHICH path latched — `'gyro'` (cross-pan rotation EMA) or `'accel'`
   * (the integrated cross-pan displacement).  Diagnostics only; never
   * feeds the physics.
   *
   * This is the single most important field in the telemetry.  BOTH
   * paths set the same `lateralExceeded` flag, so without it a field
   * log cannot tell you whether a stop came from the rotation trigger
   * or the displacement trigger — and therefore cannot tell you whether
   * a change to the displacement physics altered anything a user feels.
   * The 2026-08-25 RCA needed exactly this field and did not have it.
   */
  const latchSourceRef = useRef<'gyro' | 'accel' | null>(null);

  // ── Gyroscope → pan-speed bucket + lateral-drift latch ─────────
  // One gyro subscription drives BOTH item-4 (too fast) and item-6
  // (lateral drift).  Item 6 keys on the CROSS-pan axis (gyro X): a user
  // veering perpendicular to the arrow rotates about it (on-device traces
  // showed |gyro.x| → 1.27 on a cross-turn vs < 0.1 on a clean pan).
  const lateralEnabled = lateralBudgetCm > 0;
  useEffect(() => {
    if (!active) {
      lastBucketRef.current = 'good';
      setPanSpeedBucket('good');
      return;
    }
    // Capture start: clear the cross-axis EMA.
    crossEmaRef.current = 0;

    setUpdateIntervalForType(SensorTypes.gyroscope, GYRO_SAMPLE_INTERVAL_MS);

    // Throttle for the optional dev diagnostic log (raw axes + rate).
    let lastGyroLogMs = 0;
    // Previous gyro sample's own `timestamp`, for the real EMA step.
    let prevGyroTsMs: number | null = null;
    let gyroDtSumMs = 0;
    let gyroDtCount = 0;

    let sub: Subscription | null = gyroscope.subscribe({
      next: ({ x, y, timestamp }) => {
        const now = Date.now();

        // The cross-axis EMA has the SAME rate-dependence defect as the
        // accelerometer integrator, and per this file's own header it is
        // the PRIMARY lateral trigger — the cm budget is a secondary
        // readout.  `LATERAL_CROSS_EMA_ALPHA = 0.08` is a per-SAMPLE
        // coefficient whose 396 ms time constant only holds at 33 ms; at
        // a 10 ms delivery cadence τ collapses to 120 ms and the fixed
        // 0.15 rad/s line trips ~3× sooner (measured: a 10°-over-1 s
        // wrist tilt latches at 0.76 s on a 33 ms device and at 0.23 s
        // on a 10 ms one).  Fixing only the accelerometer would leave
        // the user-visible behaviour unchanged, because THIS is the path
        // that fires.  Normalise it the same way.
        const gdt = _sanitizeDt(prevGyroTsMs, timestamp, NOMINAL_GYRO_DT_S);
        if (Number.isFinite(timestamp)) prevGyroTsMs = timestamp;
        gyroDtSumMs += gdt.dtSec * 1000;
        gyroDtCount += 1;
        const crossAlpha = lateralMotionModel === 'legacy'
          || gdt.dtSec === NOMINAL_GYRO_DT_S
          ? LATERAL_CROSS_EMA_ALPHA
          : 1 - Math.pow(
            1 - LATERAL_CROSS_EMA_ALPHA,
            gdt.dtSec / NOMINAL_GYRO_DT_S,
          );
        // Item 4 — axis-AGNOSTIC pan rate: the magnitude of rotation in the
        // x–y (tilt) plane, ignoring roll about Z.  v0.16 — replaces the
        // single-axis pick (`gyro.x` in landscape / `gyro.y` in portrait),
        // which read ~0 and never tripped when the device's dominant pan
        // rotation landed on the OTHER axis for the user's actual hold.
        const rate = Math.hypot(x, y);
        const next = _bucketForRate(rate, goodMaxRadPerSec, warnMaxRadPerSec);
        if (next !== lastBucketRef.current) {
          lastBucketRef.current = next;
          setPanSpeedBucket(next);
        }

        // Item 6 — lateral drift via the CROSS-pan gyro axis (device X).
        // Smooth |gyro.x| with an EMA so the noisy raw rate's dips don't
        // reset the trigger; latch once the SMOOTHED rate stays over the
        // threshold (the EMA's time constant IS the dwell).
        let crossEma = crossEmaRef.current;
        // `<= 0` DISABLES the rotation trigger, mirroring `lateralBudgetCm`.
        // Without this, `crossEma > 0` is satisfied by the first non-zero
        // gyro sample, so the value a reader most naturally interprets as
        // "turn this off" would instead stop EVERY capture immediately —
        // the same inversion `lateralBudgetCm: 0` had.  `lateralBudgetCm: 0`
        // still disables BOTH triggers (via `lateralEnabled`); this
        // disables only the rotation one.
        const turnLatchEnabled = lateralTurnRateRadPerSec > 0;
        if (lateralEnabled) {
          crossEma = crossEma * (1 - crossAlpha) + Math.abs(x) * crossAlpha;
          crossEmaRef.current = crossEma;
          if (turnLatchEnabled && crossEma > lateralTurnRateRadPerSec) {
            if (latchSourceRef.current === null) {
              latchSourceRef.current = 'gyro';
              if (debugEnabled) {
                // eslint-disable-next-line no-console
                console.log(
                  `[panMotion] LATCH source=gyro `
                  + `crossEma=${crossEma.toFixed(3)}rad/s `
                  + `thresh=${lateralTurnRateRadPerSec}rad/s`,
                );
              }
            }
            setLateralExceeded((prev) => (prev ? prev : true));
          }
        }

        if (debugEnabled && now - lastGyroLogMs >= 400) {
          lastGyroLogMs = now;
          const meanDt = gyroDtCount > 0 ? gyroDtSumMs / gyroDtCount : 0;
          gyroDtSumMs = 0;
          gyroDtCount = 0;
          // eslint-disable-next-line no-console
          console.log(
            `[panMotion.gyro] x=${x.toFixed(2)}rad/s y=${y.toFixed(2)}rad/s `
            + `rate=${rate.toFixed(2)}rad/s bucket=${next} `
            + `crossEma=${crossEma.toFixed(3)}rad/s `
            + `thresh=${lateralTurnRateRadPerSec}rad/s `
            + `dtMean=${meanDt.toFixed(1)}ms dtSrc=${gdt.source} `
            + `alpha=${crossAlpha.toFixed(4)} model=${lateralMotionModel} `
            + `latch=${latchSourceRef.current ?? 'none'}`,
          );
        }
      },
      error: (err) => {
        // eslint-disable-next-line no-console
        console.warn('[usePanMotion] gyroscope error', err);
      },
    });

    return () => {
      sub?.unsubscribe();
      sub = null;
    };
    // resolvedAxis intentionally NOT a dep: the rate is now axis-agnostic
    // (hypot), so an orientation flip must not needlessly re-subscribe the
    // gyro mid-capture.
  }, [active, goodMaxRadPerSec, warnMaxRadPerSec, lateralEnabled,
    lateralTurnRateRadPerSec, lateralMotionModel, debugEnabled]);

  // ── Accelerometer → lateral-drift integrator ───────────────────
  // NOTE: this effect intentionally does NOT depend on `resolvedAxis`.
  // The cross-pan device axis is device-Y in BOTH pan modes (it is
  // always orthogonal to the gate's device-X pan axis — see header),
  // so re-subscribing on a portrait↔landscape flip would only reset
  // the accumulator mid-capture for no benefit.  We do depend on
  // `lateralBudgetCm` because the latch threshold changes with it.
  useEffect(() => {
    if (!active) {
      // Reflect a clean slate while idle.
      setLateralCm(0);
      setLateralExceeded(false);
      latchSourceRef.current = null;
      return;
    }

    // Capture start (false → true): zero the persistent accumulator.
    // This is the ONLY place `pos` resets — NOT per keyframe.
    _resetLateralState(lateralRef.current);
    setLateralCm(0);
    setLateralExceeded(false);
    latchSourceRef.current = null;

    setUpdateIntervalForType(
      SensorTypes.accelerometer,
      ACCEL_SAMPLE_INTERVAL_MS,
    );
    const scale = Platform.OS === 'ios' ? G_TO_MPS2 : 1;
    // `0` (or negative) DISABLES the lateral-drift stop — the contract
    // the README, the `<Camera>` prop and `lateralBudgetDefault.test.ts`
    // all state.  The accel path never implemented it: with `budgetM`
    // literally 0 the latch predicate `Math.abs(s.pos) > budgetM` is
    // satisfied by ANY non-zero position, so sensor noise alone latched
    // ~540 ms into every capture on a MOTIONLESS phone (measured:
    // 0.0025 cm of drift trips it).  `<Camera>` masked this because its
    // finalize effect has its own `lateralBudgetCm <= 0` guard, but the
    // hook is exported, and `lateralExceeded` still flipped for anyone
    // driving it directly or rendering guidance off it.
    //
    // `Infinity` rather than an early return: consumers who disable the
    // STOP may still want the live `lateralCm` readout, and an early
    // return would also change the sensor-subscription lifecycle.
    // Verified to reproduce the enabled path's integration bit-for-bit.
    const budgetM = lateralBudgetCm > 0 ? lateralBudgetCm / M_TO_CM : Infinity;

    // Fused-gravity feed, paired hold-last against the accel stream.
    // Requested at the ACCELEROMETER's interval so neither CoreMotion
    // manager pushes the shared hardware above the other's rate (Apple
    // documents that multiple CMMotionManager instances can affect the
    // delivery rate, and `react-native-sensors` allocates one manager
    // PER MODULE — accelerometer, gravity and orientation each get
    // their own).  Opened and closed with the capture, on the same
    // lifecycle as the accelerometer, so nothing runs while idle.
    const gravityFeed: GravityFeed = {
      y: null,
      tsMs: 0,
      startedMs: Date.now(),
      accepted: 0,
      rejected: 0,
      error: null,
    };
    const stopGravity = lateralMotionModel === 'fused'
      ? _subscribeGravity(gravityFeed, scale, ACCEL_SAMPLE_INTERVAL_MS)
      : () => {};

    let lastEmitMs = 0;
    let lastAccelLogMs = 0;
    // Rolling dt census for the telemetry line.
    let dtSumMs = 0;
    let dtCount = 0;
    let dtMinMs = Number.POSITIVE_INFINITY;
    let dtMaxMs = 0;
    let gapCount = 0;
    // One-shot: has the warm-up watchdog already given up?
    let warmupGaveUp = false;

    // Integrate device-Y — the cross-pan axis (orthogonal to the
    // gate's device-X pan axis).  We read X too, only to log it for the
    // on-device axis-verification (does a sideways slide spike X or Y?).
    const sub: Subscription = accelerometer.subscribe(
      ({ x, y, timestamp }) => {
        const now = Date.now();
        const s = lateralRef.current;

        // ── dt from the sample's OWN timestamp ────────────────────
        const dtInfo = _sanitizeDt(s.lastTsMs, timestamp, NOMINAL_DT_S);
        if (Number.isFinite(timestamp)) s.lastTsMs = timestamp;
        dtSumMs += dtInfo.dtSec * 1000;
        dtCount += 1;
        const dtMs = dtInfo.dtSec * 1000;
        if (dtMs < dtMinMs) dtMinMs = dtMs;
        if (dtMs > dtMaxMs) dtMaxMs = dtMs;
        if (dtInfo.gap) gapCount += 1;

        // ── gravity source resolution ─────────────────────────────
        // Four ways to end up on the legacy IIR, and the telemetry
        // distinguishes all of them because they need different fixes:
        //   warmup      — normal, first few hundred ms of a capture
        //   stale       — gravity delivered, then stopped
        //   unavailable — no fused sensor / errored / old peer dep
        //   model       — the caller asked for 'legacy'
        let gravitySource:
          | 'fused' | 'warmup' | 'stale' | 'unavailable' | 'model';
        let gravityMps2: number | null = null;
        if (lateralMotionModel === 'legacy') {
          gravitySource = 'model';
        } else if (gravityFeed.error !== null) {
          gravitySource = 'unavailable';
        } else if (gravityFeed.y === null) {
          // WARM-UP.  `gravity` cannot deliver instantly: the observable
          // waits on an async `isAvailable()` promise, then adds a
          // listener, then starts CoreMotion / registers the Android
          // listener.  Until the first sample lands we run the legacy
          // IIR — deliberately, rather than dropping accel samples:
          //   (a) it is EXACTLY today's behaviour, so warm-up is never
          //       worse than the status quo;
          //   (b) the shadow IIR is running anyway for failover;
          //   (c) dropping samples would break the "first sample only
          //       seeds gravity, pos stays 0" contract two tests pin.
          // The window is short (a few hundred ms of an ~8 s capture)
          // and it coincides with the 500 ms grace window, during which
          // no latch can fire regardless.
          gravitySource = 'warmup';
          if (
            !warmupGaveUp
            && now - gravityFeed.startedMs > GRAVITY_WARMUP_MS
          ) {
            // WATCHDOG.  `error` does NOT cover every failure: an
            // Android device can register the listener successfully and
            // simply never have the fusion fire, and a throw inside the
            // library's `.then()` fulfilled handler becomes an unhandled
            // promise rejection that never reaches `observer.error`.
            // Without this the hook would limp on the IIR forever while
            // the logs still claimed 'warmup'.
            warmupGaveUp = true;
            gravityFeed.error = 'no-first-sample';
            // eslint-disable-next-line no-console
            console.warn(
              '[usePanMotion] no gravity sample within '
              + `${GRAVITY_WARMUP_MS}ms — lateral drift will use the `
              + 'legacy IIR estimate for this capture',
            );
          }
        } else if (now - gravityFeed.tsMs > GRAVITY_STALE_MS) {
          gravitySource = 'stale';
        } else {
          gravitySource = 'fused';
          gravityMps2 = gravityFeed.y;
        }

        _integrateLateralSample(
          s,
          y,
          scale,
          dtInfo.dtSec,
          budgetM,
          LATERAL_GRACE_MS,
          now,
          { gravityMps2, afterGap: dtInfo.gap },
        );

        if (debugEnabled && now - lastAccelLogMs >= 400) {
          lastAccelLogMs = now;
          const meanDt = dtCount > 0 ? dtSumMs / dtCount : 0;
          // `linFused` vs `linIir` is the single most diagnostic pair in
          // this log: they are two independent estimates of the SAME
          // quantity, so a large persistent gap between them IS the bug
          // this release fixes, visible live from Metro.
          const a = y * scale;
          const linIir = a - s.gravity;
          const linUsed = gravityMps2 !== null ? a - gravityMps2 : linIir;
          // eslint-disable-next-line no-console
          console.log(
            `[panMotion.lat] model=${lateralMotionModel} `
            + `gSrc=${gravitySource} `
            + `accelY=${a.toFixed(3)}m/s2 `
            + `gY=${gravityMps2 === null ? 'n/a' : gravityMps2.toFixed(3)}`
            + `m/s2 gIir=${s.gravity.toFixed(3)}m/s2 `
            + `linUsed=${linUsed.toFixed(4)}m/s2 `
            + `linIir=${linIir.toFixed(4)}m/s2 `
            + `bias=${Number.isNaN(s.bias) ? 'n/a' : s.bias.toFixed(4)}m/s2 `
            + `vel=${s.vel.toFixed(4)}m/s `
            + `lat=${(s.pos * M_TO_CM).toFixed(2)}cm `
            + `budget=${lateralBudgetCm}cm exceeded=${s.exceeded} `
            + `dt[mean=${meanDt.toFixed(1)} min=${
              Number.isFinite(dtMinMs) ? dtMinMs.toFixed(1) : '-'
            } max=${dtMaxMs.toFixed(1)}]ms src=${dtInfo.source} `
            + `gaps=${gapCount} `
            + `gRx=${gravityFeed.accepted} gRej=${gravityFeed.rejected} `
            + `accelX=${(x * scale).toFixed(3)}m/s2 `
            + `latch=${latchSourceRef.current ?? 'none'}`,
          );
          dtSumMs = 0;
          dtCount = 0;
          dtMinMs = Number.POSITIVE_INFINITY;
          dtMaxMs = 0;
        }

        // Latch the exceeded flag once (state write only on the edge).
        if (s.exceeded) {
          if (latchSourceRef.current === null) {
            latchSourceRef.current = 'accel';
            if (debugEnabled) {
              // eslint-disable-next-line no-console
              console.log(
                `[panMotion] LATCH source=accel `
                + `lat=${(s.pos * M_TO_CM).toFixed(2)}cm `
                + `budget=${lateralBudgetCm}cm `
                + `gSrc=${gravitySource} model=${lateralMotionModel}`,
              );
            }
          }
          setLateralExceeded((prev) => (prev ? prev : true));
        }

        // Throttle the cosmetic cm readout to ~10 Hz.
        if (now - lastEmitMs >= LATERAL_EMIT_INTERVAL_MS) {
          lastEmitMs = now;
          setLateralCm(s.pos * M_TO_CM);
        }
      },
    );

    return () => {
      sub.unsubscribe();
      stopGravity();
    };
  }, [active, lateralBudgetCm, lateralMotionModel, debugEnabled]);

  return { panSpeedBucket, lateralCm, lateralExceeded, resolvedAxis };
}
