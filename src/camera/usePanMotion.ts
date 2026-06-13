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
   * `lateralExceeded` latches true.  Default 5 cm.
   */
  lateralBudgetCm?: number;
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


// ── Speed-bucket constants (mirror PanoramaGuidance) ──────────────
const DEFAULT_GOOD_RAD_PER_SEC = 0.5;
const DEFAULT_WARN_RAD_PER_SEC = 1.0;

// ── Lateral-drift constants ───────────────────────────────────────
const DEFAULT_LATERAL_BUDGET_CM = 5;

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
  return s;
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
 * @param nowMs     monotonic clock for this sample, ms
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
): LateralState {
  const a = rawAxis * scale; // cross-pan acceleration, m/s²

  // First sample seeds the gravity estimate from itself.
  if (Number.isNaN(s.gravity)) {
    s.gravity = a;
    return s;
  }

  // IIR low-pass to track the gravity component on the cross-pan axis.
  s.gravity = GRAVITY_IIR_ALPHA * s.gravity + (1 - GRAVITY_IIR_ALPHA) * a;

  // Linear acceleration = raw - gravity estimate.
  const lin = a - s.gravity;

  // Single integration with per-sample velocity damping.
  s.vel = (s.vel + lin * dt) * (1 - VELOCITY_DAMPING_PER_SAMPLE);
  s.pos += s.vel * dt;

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


export function usePanMotion({
  active,
  axis,
  goodMaxRadPerSec = DEFAULT_GOOD_RAD_PER_SEC,
  warnMaxRadPerSec = DEFAULT_WARN_RAD_PER_SEC,
  lateralBudgetCm = DEFAULT_LATERAL_BUDGET_CM,
}: UsePanMotionOptions): UsePanMotionReturn {
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

  // The throttled, render-visible lateral magnitude (cm) + the latched
  // exceeded flag.  These DO go through state because consumers render
  // them, but they update at most ~10 Hz / once respectively.
  const [lateralCm, setLateralCm] = useState(0);
  const [lateralExceeded, setLateralExceeded] = useState(false);

  // ── Gyroscope → pan-speed bucket ───────────────────────────────
  useEffect(() => {
    if (!active) {
      lastBucketRef.current = 'good';
      setPanSpeedBucket('good');
      return;
    }

    setUpdateIntervalForType(SensorTypes.gyroscope, GYRO_SAMPLE_INTERVAL_MS);

    let sub: Subscription | null = gyroscope.subscribe({
      next: ({ x, y }) => {
        const rate = _gyroRateForAxis(resolvedAxis, { x, y });
        const next = _bucketForRate(rate, goodMaxRadPerSec, warnMaxRadPerSec);
        if (next !== lastBucketRef.current) {
          lastBucketRef.current = next;
          setPanSpeedBucket(next);
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
  }, [active, resolvedAxis, goodMaxRadPerSec, warnMaxRadPerSec]);

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
      return;
    }

    // Capture start (false → true): zero the persistent accumulator.
    // This is the ONLY place `pos` resets — NOT per keyframe.
    _resetLateralState(lateralRef.current);
    setLateralCm(0);
    setLateralExceeded(false);

    setUpdateIntervalForType(
      SensorTypes.accelerometer,
      ACCEL_SAMPLE_INTERVAL_MS,
    );
    const scale = Platform.OS === 'ios' ? G_TO_MPS2 : 1;
    const dt = ACCEL_SAMPLE_INTERVAL_MS / 1000.0;
    const budgetM = lateralBudgetCm / M_TO_CM;

    let lastEmitMs = 0;

    // Integrate device-Y — the cross-pan axis (orthogonal to the
    // gate's device-X pan axis).
    const sub: Subscription = accelerometer.subscribe(({ y }) => {
      const now = Date.now();
      const s = _integrateLateralSample(
        lateralRef.current,
        y,
        scale,
        dt,
        budgetM,
        LATERAL_GRACE_MS,
        now,
      );

      // Latch the exceeded flag once (state write only on the edge).
      if (s.exceeded) {
        setLateralExceeded((prev) => (prev ? prev : true));
      }

      // Throttle the cosmetic cm readout to ~10 Hz.
      if (now - lastEmitMs >= LATERAL_EMIT_INTERVAL_MS) {
        lastEmitMs = now;
        setLateralCm(s.pos * M_TO_CM);
      }
    });

    return () => sub.unsubscribe();
  }, [active, lateralBudgetCm]);

  return { panSpeedBucket, lateralCm, lateralExceeded, resolvedAxis };
}
