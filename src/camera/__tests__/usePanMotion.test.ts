// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `usePanMotion` — exercises the pure helpers the hook
 * is built from directly:
 *
 *   - `_bucketForRate`           speed-bucket thresholds (Item 4)
 *   - `_gyroRateForAxis` /       dominant-axis selection
 *     `_resolvePanAxis`
 *   - `_integrateLateralSample`  the cross-pan accel integrator (Item 6)
 *   - `_resetLateralState`       the capture-start reset
 *
 * Why pure-helper tests rather than render-the-hook: the lib's jest
 * config is `preset: 'ts-jest'` + `testEnvironment: 'node'` — no RN
 * preset, no `@testing-library/react-native` (see jest.config.js
 * header).  Same approach `useOrientationDrift.test.ts` takes: the
 * pure functions carry the behavioural contract, and the thin
 * useEffect wrapper around them is verified by the on-device flow.
 *
 * The lateral-integrator tests are written as small "drive N samples"
 * loops because the integrator is, by design, stateful across samples
 * (that is the whole point of the persistent accumulator).  A helper
 * `drive()` feeds a constant cross-pan acceleration for a number of
 * samples at the real 20 ms / 50 Hz cadence and advances a fake
 * clock, so the grace window is exercised in real (simulated) time.
 */

// Mock `react-native-sensors` BEFORE importing the SUT — the module
// transitively pulls in `useDeviceOrientation`, which imports
// `accelerometer` from `react-native-sensors` (an ES module jest
// can't parse without the RN preset the config intentionally avoids).
// We only call pure functions below, so a stub silences the chain.
jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: 'accelerometer', gyroscope: 'gyroscope' },
}));

// eslint-disable-next-line import/first
import {
  _bucketForRate,
  _gyroRateForAxis,
  _resolvePanAxis,
  _integrateLateralSample,
  _evalGraceLatch,
  _resetLateralState,
  _freshLateralState,
  type LateralState,
} from '../usePanMotion';


// ── Speed bucket (Item 4) ─────────────────────────────────────────

describe('_bucketForRate (pan-speed thresholds)', () => {
  const GOOD = 0.5;
  const WARN = 1.0;

  it('maps |rate| <= good to "good" (inclusive of the boundary)', () => {
    expect(_bucketForRate(0, GOOD, WARN)).toBe('good');
    expect(_bucketForRate(0.25, GOOD, WARN)).toBe('good');
    expect(_bucketForRate(0.5, GOOD, WARN)).toBe('good'); // boundary
  });

  it('maps good < |rate| <= warn to "warn" (inclusive of the boundary)', () => {
    expect(_bucketForRate(0.51, GOOD, WARN)).toBe('warn');
    expect(_bucketForRate(0.75, GOOD, WARN)).toBe('warn');
    expect(_bucketForRate(1.0, GOOD, WARN)).toBe('warn'); // boundary
  });

  it('maps |rate| > warn to "bad"', () => {
    expect(_bucketForRate(1.01, GOOD, WARN)).toBe('bad');
    expect(_bucketForRate(5, GOOD, WARN)).toBe('bad');
  });

  it('is sign-agnostic — uses |rate|', () => {
    expect(_bucketForRate(-0.25, GOOD, WARN)).toBe('good');
    expect(_bucketForRate(-0.75, GOOD, WARN)).toBe('warn');
    expect(_bucketForRate(-2, GOOD, WARN)).toBe('bad');
  });

  it('honours custom thresholds', () => {
    // Tighter budget: 0.2 / 0.4.
    expect(_bucketForRate(0.2, 0.2, 0.4)).toBe('good');
    expect(_bucketForRate(0.3, 0.2, 0.4)).toBe('warn');
    expect(_bucketForRate(0.5, 0.2, 0.4)).toBe('bad');
  });
});


// ── Dominant-axis selection ───────────────────────────────────────

describe('_gyroRateForAxis (dominant gyro axis per pan direction)', () => {
  it('horizontal pan (portrait) reads gyro Y', () => {
    expect(_gyroRateForAxis('horizontal', { x: 1, y: 2 })).toBe(2);
  });

  it('vertical pan (landscape) reads gyro X', () => {
    expect(_gyroRateForAxis('vertical', { x: 1, y: 2 })).toBe(1);
  });
});


describe('_resolvePanAxis (orientation → pan axis)', () => {
  it('auto-detects horizontal in both portrait orientations', () => {
    expect(_resolvePanAxis('portrait')).toBe('horizontal');
    expect(_resolvePanAxis('portrait-upside-down')).toBe('horizontal');
  });

  it('auto-detects vertical in both landscape orientations (Mode A)', () => {
    // Both landscape-left AND landscape-right are valid Mode A.
    expect(_resolvePanAxis('landscape-left')).toBe('vertical');
    expect(_resolvePanAxis('landscape-right')).toBe('vertical');
  });

  it('an explicit override wins over orientation', () => {
    expect(_resolvePanAxis('portrait', 'vertical')).toBe('vertical');
    expect(_resolvePanAxis('landscape-left', 'horizontal')).toBe('horizontal');
  });
});


// ── Lateral integrator (Item 6) ───────────────────────────────────

const DT = 0.02; // 20 ms / 50 Hz, matches ACCEL_SAMPLE_INTERVAL_MS.
const SCALE = 1; // Android m/s² path (no G conversion) keeps math obvious.
const GRACE_MS = 500;

/**
 * Feed `count` samples of constant raw acceleration `accel` (m/s²,
 * SCALE=1) into the integrator at the real 20 ms cadence, advancing a
 * fake monotonic clock so the grace window is exercised in simulated
 * time.  Returns the (mutated) state and the final clock value.
 *
 * IMPORTANT modelling note — why pushes here are TRANSIENT, not DC:
 *   The integrator subtracts an IIR-tracked gravity estimate (alpha
 *   0.9, ~200 ms time constant).  A CONSTANT acceleration is therefore
 *   absorbed into the gravity estimate within a few hundred ms and
 *   produces ~zero net displacement — by design, identical to
 *   `useIMUTranslationGate`.  A real lateral SLIDE is a transient: the
 *   operator accelerates the phone sideways for a moment, then it
 *   coasts/settles.  So tests that want real displacement push for a
 *   short burst (e.g. `drive(s, 1.0, 5, …)`) and then let it coast
 *   (`drive(s, 0, …)`).  All the magnitudes/timings below were
 *   validated empirically against the integrator.
 */
function drive(
  s: LateralState,
  accel: number,
  count: number,
  startMs: number,
  budgetM: number,
): { state: LateralState; nowMs: number } {
  let now = startMs;
  for (let i = 0; i < count; i++) {
    _integrateLateralSample(s, accel, SCALE, DT, budgetM, GRACE_MS, now);
    now += DT * 1000;
  }
  return { state: s, nowMs: now };
}

describe('_integrateLateralSample (cross-pan drift accumulator)', () => {
  it('first sample only seeds gravity — position stays at zero', () => {
    const s = _freshLateralState();
    _integrateLateralSample(s, 0.3, SCALE, DT, 0.05, GRACE_MS, 0);
    expect(s.pos).toBe(0);
    expect(s.vel).toBe(0);
    expect(Number.isNaN(s.gravity)).toBe(false); // gravity now seeded
  });

  it('a constant (DC) acceleration is absorbed by the gravity IIR — ~zero net drift', () => {
    // Documents the deliberate parity with useIMUTranslationGate: a
    // steady offset reads as gravity, not translation.  This is WHY
    // the displacement tests below use transient pushes.
    const s = _freshLateralState();
    const { state } = drive(s, 0.5, 200, 0, /* huge budget */ 100);
    expect(Math.abs(state.pos)).toBeLessThan(0.001); // < 1 mm
  });

  it('integrates a transient cross-pan push into real displacement', () => {
    // Push for 5 samples (~100 ms), then coast.  Empirically ~6 cm.
    const s = _freshLateralState();
    drive(s, 1.0, 5, 0, /* huge budget */ 100);
    const { state } = drive(s, 0, 55, 100, 100);
    expect(Math.abs(state.pos)).toBeGreaterThan(0.03); // > 3 cm
  });

  it('does NOT latch before the grace window elapses', () => {
    // push 1.0 x5 crosses a 2 cm budget at ~380 ms; at ~500 ms total
    // (only ~120 ms over budget) the grace dwell isn't satisfied yet.
    const s = _freshLateralState();
    const budgetM = 0.02;
    drive(s, 1.0, 5, 0, budgetM);
    const { state } = drive(s, 0, 20, 100, budgetM); // up to ~500 ms total
    expect(Math.abs(state.pos)).toBeGreaterThan(budgetM); // over budget…
    expect(state.exceeded).toBe(false); // …but grace not yet satisfied
    expect(state.overBudgetSinceMs).not.toBeNull(); // timer is running
  });

  it('latches once continuously over budget for the full grace window', () => {
    // Same push, run well past first-crossing + 500 ms grace.
    const s = _freshLateralState();
    const budgetM = 0.02;
    drive(s, 1.0, 5, 0, budgetM);
    const { state } = drive(s, 0, 60, 100, budgetM);
    expect(state.exceeded).toBe(true);
  });

  it('stays latched once tripped, even after the phone returns toward rest', () => {
    const s = _freshLateralState();
    const budgetM = 0.02;
    drive(s, 1.0, 5, 0, budgetM);
    const { nowMs } = drive(s, 0, 60, 100, budgetM);
    expect(s.exceeded).toBe(true);
    // One-shot finalize: more rest samples must NOT clear it.
    drive(s, 0, 100, nowMs, budgetM);
    expect(s.exceeded).toBe(true);
  });
});


// ── Grace / debounce state machine (pure, deterministic) ──────────
//
// The integrator physics above make it awkward to hand-craft a
// position that crosses, then cleanly dips back UNDER budget (velocity
// damping + gravity overshoot fight you).  So the debounce logic lives
// in its own pure helper `_evalGraceLatch`, tested here by feeding the
// over/under-budget boolean and the clock directly — no physics.

describe('_evalGraceLatch (grace-window debounce)', () => {
  it('under budget → no latch, timer stays null', () => {
    expect(_evalGraceLatch(false, 1000, null, false, GRACE_MS)).toEqual({
      exceeded: false,
      overBudgetSinceMs: null,
    });
  });

  it('first over-budget sample starts the timer but does NOT latch', () => {
    expect(_evalGraceLatch(true, 1000, null, false, GRACE_MS)).toEqual({
      exceeded: false,
      overBudgetSinceMs: 1000,
    });
  });

  it('still over budget but within grace → no latch, timer preserved', () => {
    // started at 1000, now 1499 → 499 ms < 500 ms grace.
    expect(_evalGraceLatch(true, 1499, 1000, false, GRACE_MS)).toEqual({
      exceeded: false,
      overBudgetSinceMs: 1000,
    });
  });

  it('latches exactly at the grace boundary (>= graceMs)', () => {
    // started at 1000, now 1500 → 500 ms == grace → latch.
    expect(_evalGraceLatch(true, 1500, 1000, false, GRACE_MS)).toEqual({
      exceeded: true,
      overBudgetSinceMs: 1000,
    });
  });

  it('a dip back under budget resets the timer (debounces a wobble)', () => {
    // Was over budget since 1000; a sample dips under at 1200 → timer
    // clears, so the next over-budget run must accumulate grace afresh.
    const dipped = _evalGraceLatch(false, 1200, 1000, false, GRACE_MS);
    expect(dipped).toEqual({ exceeded: false, overBudgetSinceMs: null });

    // Re-cross at 1300 → timer restarts from 1300, NOT 1000…
    const recrossed = _evalGraceLatch(true, 1300, null, false, GRACE_MS);
    expect(recrossed).toEqual({ exceeded: false, overBudgetSinceMs: 1300 });

    // …so at 1700 (only 400 ms into the NEW run) it still hasn't latched.
    const stillWaiting = _evalGraceLatch(true, 1700, 1300, false, GRACE_MS);
    expect(stillWaiting.exceeded).toBe(false);

    // It finally latches at 1800 (1300 + 500).
    const finallyLatched = _evalGraceLatch(true, 1800, 1300, false, GRACE_MS);
    expect(finallyLatched.exceeded).toBe(true);
  });

  it('once latched it stays latched, even if |pos| later dips under budget', () => {
    // exceeded=true going in; a subsequent under-budget sample must
    // NOT un-latch (one-shot finalize semantics).
    expect(_evalGraceLatch(false, 9999, 1000, true, GRACE_MS)).toEqual({
      exceeded: true,
      overBudgetSinceMs: 1000,
    });
  });
});


// ── The persistence contract: NO reset across keyframes ───────────

describe('lateral accumulator persistence (CRITICAL — Item 6)', () => {
  it('does NOT reset across simulated keyframe accepts — only _resetLateralState clears it', () => {
    const s = _freshLateralState();
    const budgetM = 100; // huge so nothing latches; we only watch pos
    let now = 0;

    // Three "keyframe segments".  The IMU PAN gate (device-X,
    // useIMUTranslationGate) would reset ITS own integrator at each of
    // these boundaries.  Our CROSS-pan accumulator must IGNORE keyframe
    // boundaries entirely — there is no per-keyframe hook here.  We
    // assert that by giving each segment a transient push and showing
    // |pos| keeps GROWING across the boundaries (never snaps to zero).
    drive(s, 0.6, 4, now, budgetM); // burst
    ({ nowMs: now } = drive(s, 0, 16, now + 4 * DT * 1000, budgetM)); // coast
    const posAfterSeg1 = Math.abs(s.pos);
    expect(posAfterSeg1).toBeGreaterThan(0);

    // --- simulated keyframe accept boundary 1 (NO reset call) ---
    drive(s, 0.6, 4, now, budgetM);
    ({ nowMs: now } = drive(s, 0, 16, now + 4 * DT * 1000, budgetM));
    const posAfterSeg2 = Math.abs(s.pos);
    expect(posAfterSeg2).toBeGreaterThan(posAfterSeg1);

    // --- simulated keyframe accept boundary 2 (NO reset call) ---
    drive(s, 0.6, 4, now, budgetM);
    drive(s, 0, 16, now + 4 * DT * 1000, budgetM);
    const posAfterSeg3 = Math.abs(s.pos);
    expect(posAfterSeg3).toBeGreaterThan(posAfterSeg2);
  });

  it('contrasts persistence vs. a per-keyframe reset: same nudges, very different totals', () => {
    // This is the crux of Item 6's design.  The IMU PAN gate resets
    // its device-X integrator at every keyframe accept, so a sequence
    // of small same-direction nudges — each individually under budget —
    // never accumulates there.  Our cross-pan accumulator must NOT
    // reset, so the SAME nudge sequence sums to a meaningfully larger
    // total.  We prove it by running the identical drive sequence twice:
    // once persistent (this hook's behaviour) and once with a
    // `_resetLateralState` at each "keyframe" boundary (the gate's
    // behaviour), and asserting persistent ends up strictly larger.
    const budgetM = 100; // huge: isolate the accumulation, no latch noise
    const REPS = 6;

    const runNudges = (resetEachKeyframe: boolean): number => {
      const s = _freshLateralState();
      let now = 0;
      // Seed gravity once up front so the first real nudge integrates.
      ({ nowMs: now } = drive(s, 0, 1, now, budgetM));
      for (let k = 0; k < REPS; k++) {
        drive(s, 0.6, 3, now, budgetM); // small same-direction nudge
        ({ nowMs: now } = drive(s, 0, 12, now + 3 * DT * 1000, budgetM));
        if (resetEachKeyframe) {
          // Mimic the pan gate zeroing at every keyframe accept.
          _resetLateralState(s);
          // Re-seed gravity so the next segment integrates (matches the
          // hook's first-sample-after-reset behaviour).
          ({ nowMs: now } = drive(s, 0, 1, now, budgetM));
        }
      }
      return Math.abs(s.pos);
    };

    const persistentTotal = runNudges(false);
    const perKeyframeTotal = runNudges(true);

    // The per-keyframe-reset path discards each segment's residual at
    // the boundary (and re-seeds gravity from the post-coast level), so
    // the same-direction nudges never accumulate — it ends at ~zero.
    expect(perKeyframeTotal).toBeLessThan(0.001); // ~0 (gate behaviour)
    // The persistent accumulator banks every nudge, so it ends up with
    // a real, strictly-positive running total — the whole point of the
    // never-reset-per-keyframe design.
    expect(persistentTotal).toBeGreaterThan(0.005); // > 5 mm of real drift
    expect(persistentTotal).toBeGreaterThan(perKeyframeTotal);
  });

  it('_resetLateralState zeroes position, velocity, latch AND grace timer', () => {
    const s = _freshLateralState();
    drive(s, 1.0, 5, 0, 0.02);
    drive(s, 0, 60, 100, 0.02); // get it latched + drifted
    expect(s.exceeded).toBe(true);
    expect(s.pos).not.toBe(0);

    _resetLateralState(s);
    expect(s.pos).toBe(0);
    expect(s.vel).toBe(0);
    expect(s.exceeded).toBe(false);
    expect(s.overBudgetSinceMs).toBeNull();
    expect(Number.isNaN(s.gravity)).toBe(true); // re-armed for re-seed
  });

  it('after reset, a re-seeded first sample again leaves position at zero', () => {
    const s = _freshLateralState();
    drive(s, 1.0, 5, 0, 0.02);
    drive(s, 0, 60, 100, 0.02);
    _resetLateralState(s);
    // First post-reset sample re-seeds gravity, pos stays 0.
    _integrateLateralSample(s, 0.7, SCALE, DT, 0.02, GRACE_MS, 9999);
    expect(s.pos).toBe(0);
  });
});
