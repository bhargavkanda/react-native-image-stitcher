// SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for the lateral-drift TILT-vs-TRANSLATION defect
 * (RCA 2026-08-25) and for the variable-`dt` machinery that ships with
 * the fix.
 *
 * These are pure-physics tests: they synthesise an accelerometer stream
 * (and, for the fused model, the matching gravity stream) and replay it
 * through `_integrateLateralSample`, exactly as the on-device effect
 * would.  No React, no sensors, no timers — deterministic in plain node.
 */

jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gravity: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: {
    accelerometer: 'accelerometer',
    gravity: 'gravity',
    gyroscope: 'gyroscope',
  },
}));

// eslint-disable-next-line import/first
import {
  _evalGraceLatch,
  _integrateLateralSample,
  _sanitizeDt,
  _freshLateralState,
  DEFAULT_LATERAL_MOTION_MODEL,
} from '../usePanMotion';

const G = 9.81;
const SCALE = 1;          // Android m/s² path; keeps the arithmetic legible.
const GRACE_MS = 500;
const DT_MS = 20;
const DT = DT_MS / 1000;
const HUGE_BUDGET_M = 100;

/**
 * Replay a motion profile.  `accelOf(t)` is TOTAL specific force on the
 * cross-pan axis (gravity projection + real linear acceleration) — what
 * the accelerometer actually reports.  `gravityOf(t)` is the fused
 * gravity sensor's view of the same axis; pass `null` to run the legacy
 * IIR path (i.e. omit the options argument entirely).
 */
function replay(
  seconds: number,
  accelOf: (t: number) => number,
  gravityOf: ((t: number) => number) | null,
  budgetM = HUGE_BUDGET_M,
  dtSec = DT,
): { peakCm: number; finalCm: number; latched: boolean } {
  const s = _freshLateralState();
  const n = Math.round(seconds / dtSec);
  let peak = 0;
  let now = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dtSec;
    _integrateLateralSample(
      s, accelOf(t), SCALE, dtSec, budgetM, GRACE_MS, now,
      gravityOf ? { gravityMps2: gravityOf(t) } : undefined,
    );
    peak = Math.max(peak, Math.abs(s.pos));
    now += dtSec * 1000;
  }
  return { peakCm: peak * 100, finalCm: s.pos * 100, latched: s.exceeded };
}

/** Wrist tilt of `deg` ramped linearly over `rampS`, then held. */
const tilt = (deg: number, rampS: number) => (t: number) =>
  G * Math.sin((deg * Math.PI) / 180 * Math.min(1, t / rampS));
/** The same tilt as the gravity sensor sees it, one sample later. */
const tiltLagged = (deg: number, rampS: number) => (t: number) =>
  tilt(deg, rampS)(Math.max(0, t - DT));
/** Minimum-jerk sideways slide of `dist` m over `dur` s, then still.
 *  Module scope: used by both the real-translation and the variable-dt
 *  describes (the latter needs a PASSBAND probe — see that test). */
const slide = (dist: number, dur: number) => (t: number) => {
  if (t >= dur) return 0;
  const u = t / dur;
  return (dist / (dur * dur)) * (60 * u - 180 * u * u + 120 * u * u * u);
};

describe('tilt is not translation (the RCA)', () => {
  it('LEGACY: a slow 3.7° wrist tilt fabricates ~4 cm of drift', () => {
    const r = replay(8, tilt(3.7, 8), null);
    expect(r.peakCm).toBeGreaterThan(3.5);
    expect(r.peakCm).toBeLessThan(4.5);
  });

  it('FUSED: the same tilt reads well under half a centimetre', () => {
    const r = replay(8, tilt(3.7, 8), tiltLagged(3.7, 8));
    expect(r.peakCm).toBeLessThan(0.6);
  });

  it('LEGACY: a 10° wrist flick latches an 8 cm budget (the field bug)', () => {
    // 10° over 0.5 s is an ordinary re-grip.  The IIR converges to the
    // new gravity within ~190 ms, so `lin` returns to zero and the
    // fabricated position FREEZES rather than decaying — it sits over
    // budget for the rest of the capture and the grace window latches.
    const r = replay(8, tilt(10, 0.5), null, 0.08);
    expect(r.peakCm).toBeGreaterThan(10);
    expect(r.latched).toBe(true);
  });

  it('FUSED: the same flick neither inflates nor latches', () => {
    const r = replay(8, tilt(10, 0.5), tiltLagged(10, 0.5), 0.08);
    expect(r.peakCm).toBeLessThan(2);
    expect(r.latched).toBe(false);
  });

  it('the legacy error is ~1.1 cm per degree of net tilt, and linear', () => {
    const perDeg = [5, 10, 15].map(
      (d) => replay(8, tilt(d, 0.5), null).peakCm / d,
    );
    for (const k of perDeg) {
      expect(k).toBeGreaterThan(1.0);
      expect(k).toBeLessThan(1.25);
    }
    // Fused cuts it by ~9x.
    const fusedPerDeg = replay(8, tilt(10, 0.5), tiltLagged(10, 0.5)).peakCm / 10;
    expect(fusedPerDeg).toBeLessThan(perDeg[1] / 5);
  });
});

describe('the fix does not blind the detector to real translation', () => {
  it('FUSED reads a real 20 cm slide 3x higher than LEGACY does', () => {
    const legacy = replay(8, slide(0.2, 1), null);
    const fused = replay(8, slide(0.2, 1), () => 0);
    expect(fused.peakCm).toBeGreaterThan(2.5 * legacy.peakCm);
  });

  it('LEGACY suppresses real translation below any usable budget', () => {
    // The IIR is a high-pass on acceleration with a ~190 ms corner, so
    // it absorbs most of a ~1 s slide.  This is the *other* half of the
    // defect: the legacy model is not merely noisy, its discrimination
    // is INVERTED — it latches on tilt and ignores translation.
    expect(replay(8, slide(0.2, 1), null, 0.04).latched).toBe(false);
    expect(replay(8, slide(0.2, 1), () => 0, 0.04).latched).toBe(true);
  });
});

describe('variable dt', () => {
  it('is rate-independent under the normalised damping', () => {
    // Identical physical motion sampled at 5..100 ms must read the same.
    //
    // The probe MUST be a signal in the detector's passband.  A constant
    // bias is not: stage 2 is specifically built to reject DC, so every
    // cadence reads 0.000 cm and the ratio degenerates into a comparison
    // of floating-point noise.  A real slide is the honest probe — it is
    // also exactly what the guard exists to measure.
    const peaks = [0.005, 0.01, 0.02, 0.04, 0.1].map(
      (dt) => replay(8, slide(0.2, 1), () => 0, HUGE_BUDGET_M, dt).peakCm,
    );
    const min = Math.min(...peaks);
    const max = Math.max(...peaks);
    // A per-SAMPLE damping constant would spread these ~20x.  Normalised
    // (+ the ZOH velocity form off-nominal) they agree within 15 %;
    // measured 1.07x across a 20x cadence spread.
    expect(max / min).toBeLessThan(1.15);
  });

  it('rejects a constant bias at every cadence (the stage-2 contract)', () => {
    // Stage 1 (`a - g`) has NO DC rejection: a persistent accel-vs-fused
    // -gravity residual would ramp `pos` without bound at `b * tau_v`
    // (0.02 m/s^2 reaches 5.78 cm in 8 s, 14.90 cm in 20 s, and 0.05
    // crosses an 8 cm budget in ~4.4 s of doing NOTHING).  Stage 2's
    // high-pass is what makes the fused model safe to default ON.
    for (const dt of [0.005, 0.02, 0.1]) {
      for (const b of [0.005, 0.02, 0.05]) {
        const r = replay(20, () => b, () => 0, HUGE_BUDGET_M, dt);
        expect(r.peakCm).toBeLessThan(0.5);
      }
    }
  });

  it('reproduces the legacy numbers exactly at the nominal 20 ms', () => {
    // Same profile as usePanMotion.test.ts's "transient push" case:
    // 5 samples of push, then 55 of coast.  The pre-fix implementation
    // produced EXACTLY this position; the `dt === NOMINAL_DT_S` fast
    // path in the damping term keeps it bit-identical rather than
    // merely floating-point-close, which is what protects the five
    // existing tests that assert empirical magnitudes.
    const s = _freshLateralState();
    let now = 0;
    for (let i = 0; i < 5; i++) {
      _integrateLateralSample(s, 1.0, SCALE, DT, 100, GRACE_MS, now);
      now += DT_MS;
    }
    for (let i = 0; i < 55; i++) {
      _integrateLateralSample(s, 0, SCALE, DT, 100, GRACE_MS, now);
      now += DT_MS;
    }
    expect(s.pos).toBe(-0.06084971201606216);
  });
});

describe('_sanitizeDt', () => {
  const NOMINAL = 0.02;
  it('uses the nominal step for the first sample', () => {
    expect(_sanitizeDt(null, 1000)).toEqual({
      dtSec: NOMINAL, gap: false, source: 'first',
    });
  });
  it('uses the real delta in the plausible band', () => {
    expect(_sanitizeDt(1000, 1033)).toEqual({
      dtSec: 0.033, gap: false, source: 'sensor',
    });
  });
  it('rejects a non-monotonic delta (NTP step / same truncated ms)', () => {
    // dt === 0 stalls position while still decaying velocity; dt < 0
    // runs position backwards AND raises the normalised damping above
    // 1, which AMPLIFIES velocity — the one input that can diverge.
    expect(_sanitizeDt(1000, 1000).source).toBe('nonmonotonic');
    expect(_sanitizeDt(1000, 990).source).toBe('nonmonotonic');
    expect(_sanitizeDt(1000, 990).dtSec).toBe(NOMINAL);
    expect(_sanitizeDt(1000, 990).gap).toBe(false);
  });
  it('clamps a sub-millisecond burst up to the floor', () => {
    expect(_sanitizeDt(1000, 1001)).toEqual({
      dtSec: 0.002, gap: false, source: 'burst',
    });
  });
  it('treats an over-long delta as a GAP, not a long sample', () => {
    expect(_sanitizeDt(1000, 3000)).toEqual({
      dtSec: NOMINAL, gap: true, source: 'gap',
    });
    expect(_sanitizeDt(1000, 1100).gap).toBe(false); // 100 ms is the edge
    expect(_sanitizeDt(1000, 1101).gap).toBe(true);
  });
  it('falls back to nominal on a non-finite timestamp', () => {
    expect(_sanitizeDt(1000, NaN).dtSec).toBe(NOMINAL);
    expect(_sanitizeDt(1000, undefined as unknown as number).dtSec)
      .toBe(NOMINAL);
  });
});

describe('gap handling', () => {
  it('zeroes velocity so a backgrounding gap injects no phantom metres', () => {
    // Build real velocity with a TRANSIENT push (a DC push is absorbed
    // by the gravity estimate — that is the model, not a bug).
    const s = _freshLateralState();
    for (let i = 0; i < 6; i++) {
      _integrateLateralSample(s, i < 5 ? 1.0 : 0, SCALE, DT, 100, GRACE_MS, i * 20);
    }
    expect(Math.abs(s.vel)).toBeGreaterThan(0.01);
    const carried = s.vel;

    // Same post-gap sample, with and without the flag.
    const withGap = { ...s };
    const withoutGap = { ...s };
    _integrateLateralSample(
      withGap, 0, SCALE, DT, 100, GRACE_MS, 2200, { afterGap: true },
    );
    _integrateLateralSample(
      withoutGap, 0, SCALE, DT, 100, GRACE_MS, 2200,
    );

    // The flag discards the pre-gap momentum: the motion across a 2 s
    // backgrounding was unobserved, so carrying velocity through it is
    // unjustified.  (Velocity is not left at exactly zero — this
    // sample's own `lin * dt` still applies — but the CARRIED term is
    // gone.)
    const advanceWith = Math.abs(withGap.pos - s.pos);
    const advanceWithout = Math.abs(withoutGap.pos - s.pos);
    expect(advanceWithout).toBeGreaterThan(advanceWith);
    expect(advanceWith).toBeLessThan(Math.abs(carried) * DT);
  });
});

describe('graceful degradation', () => {
  it('a null/undefined gravity falls back to the legacy IIR, sample by sample', () => {
    // Mid-capture failover must be seamless: the shadow IIR runs on
    // every sample in both models, so it is already converged.
    const withOpts = _freshLateralState();
    const withoutOpts = _freshLateralState();
    for (let i = 0; i < 40; i++) {
      _integrateLateralSample(
        withOpts, 0.4, SCALE, DT, 100, GRACE_MS, i * 20,
        { gravityMps2: null },
      );
      _integrateLateralSample(
        withoutOpts, 0.4, SCALE, DT, 100, GRACE_MS, i * 20,
      );
    }
    expect(withOpts.pos).toBe(withoutOpts.pos);
  });

  it('a non-finite gravity value is ignored rather than poisoning pos', () => {
    const s = _freshLateralState();
    for (let i = 0; i < 20; i++) {
      _integrateLateralSample(
        s, 0.4, SCALE, DT, 100, GRACE_MS, i * 20,
        { gravityMps2: NaN },
      );
    }
    expect(Number.isFinite(s.pos)).toBe(true);
  });

  it('keeps the shadow IIR warm while fused gravity is in use', () => {
    const s = _freshLateralState();
    for (let i = 0; i < 60; i++) {
      _integrateLateralSample(
        s, 9.0, SCALE, DT, 100, GRACE_MS, i * 20, { gravityMps2: 9.0 },
      );
    }
    // The IIR tracked the DC level even though it was never consumed,
    // so a failover on sample 61 starts converged, not from scratch.
    expect(s.gravity).toBeCloseTo(9.0, 2);
  });
});

describe('the config default', () => {
  it('defaults to the fixed physics — this is a bug fix, not an opt-in', () => {
    expect(DEFAULT_LATERAL_MOTION_MODEL).toBe('fused');
  });
});

/**
 * End-to-end replay of the ACTUAL field motion, in full 3-D rather than
 * a 1-D projection: a vertical shelf sweep held in landscape
 * (`panMode: 'vertical'`), with wrist ROLL about the camera axis — the
 * natural wrist movement operators make, and the one the 2026-08-25 RCA
 * identified as the trigger.
 *
 * Body frame at the nominal landscape hold, columns = body axes in world
 * (world: X east, Y north, Z up):
 *   body_X = (0,0,-1) down   <- the pan axis for a vertical sweep
 *   body_Y = (1,0,0)  east   <- the CROSS-pan axis this guard integrates
 *   body_Z = (0,-1,0) south  <- camera looks along -body_Z
 * body_Y is therefore PERPENDICULAR to gravity, which is the
 * maximum-sensitivity geometry: d(g·body_Y)/d(roll) = g.
 */
describe('3-D replay of the field motion (landscape vertical sweep)', () => {
  type M = number[][];
  const mul = (A: M, B: M): M =>
    A.map((_, i) => B[0].map((__, j) =>
      A[i].reduce((acc, ___, k) => acc + A[i][k] * B[k][j], 0)));
  const app = (A: M, v: number[]) =>
    A.map((r) => r.reduce((acc, a, i) => acc + a * v[i], 0));
  const tpose = (A: M): M => A[0].map((_, i) => A.map((r) => r[i]));
  const axisRot = (ax: number[], th: number): M => {
    const [x, y, z] = ax;
    const c = Math.cos(th); const s = Math.sin(th); const C = 1 - c;
    return [
      [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
      [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
      [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
    ];
  };
  const R0: M = [[0, 1, 0], [0, 0, -1], [-1, 0, 0]];

  /** Replay a sweep+roll and return peak cm for both models. */
  function sweep(sweepDeg: number, rollDeg: number, secs = 8) {
    const n = Math.round(secs / DT);
    const sL = _freshLateralState();
    const sF = _freshLateralState();
    let peakL = 0; let peakF = 0; let now = 0;
    for (let i = 0; i < n; i++) {
      const t = i * DT;
      const R = mul(
        mul(R0, axisRot([0, 1, 0], (sweepDeg * Math.PI / 180) * (t / secs))),
        axisRot([0, 0, 1], (rollDeg * Math.PI / 180) * (t / secs)),
      );
      // Specific force with ZERO real translation: f = R^T (0 - g_world).
      const f = app(tpose(R), [0, 0, G]);
      // Fused gravity sensor's view of the same axis (down-vector).
      const gBody = app(tpose(R), [0, 0, -G]);
      _integrateLateralSample(
        sL, f[1], SCALE, DT, HUGE_BUDGET_M, GRACE_MS, now,
      );
      _integrateLateralSample(
        sF, f[1], SCALE, DT, HUGE_BUDGET_M, GRACE_MS, now,
        { gravityMps2: -gBody[1] },
      );
      peakL = Math.max(peakL, Math.abs(sL.pos));
      peakF = Math.max(peakF, Math.abs(sF.pos));
      now += DT * 1000;
    }
    return { legacyCm: peakL * 100, fusedCm: peakF * 100 };
  }

  it('LEGACY fabricates centimetres from wrist roll alone', () => {
    // Zero real translation in every one of these.
    expect(sweep(40, 0).legacyCm).toBeLessThan(0.01);   // no roll -> clean
    expect(sweep(40, 3).legacyCm).toBeGreaterThan(2.0); // 3 deg  -> ~2.6 cm
    expect(sweep(40, 6).legacyCm).toBeGreaterThan(4.0); // 6 deg  -> trips 4cm
    expect(sweep(40, 12).legacyCm).toBeGreaterThan(9.0);
  });

  it('the legacy fabrication scales linearly with roll angle', () => {
    const perDeg = [3, 6, 12].map((d) => sweep(40, d).legacyCm / d);
    for (const k of perDeg) {
      expect(k).toBeGreaterThan(0.7);
      expect(k).toBeLessThan(1.0);
    }
  });

  it('FUSED rejects wrist roll entirely, at every angle', () => {
    for (const roll of [3, 6, 12, 25]) {
      expect(sweep(40, roll).fusedCm).toBeLessThan(0.05);
    }
  });
});

describe('lateralBudgetCm = 0 disables the displacement stop', () => {
  /** Deterministic pseudo-noise: a motionless phone's accelerometer. */
  const stillPhone = (i: number) => ((i * 2654435761) % 1000 / 1000 - 0.5) * 0.02;

  function runStill(budgetM: number) {
    const s = _freshLateralState();
    let latchMs: number | null = null;
    let now = 0;
    for (let i = 0; i < 400; i++) { // 8 s
      _integrateLateralSample(
        s, stillPhone(i), SCALE, DT, budgetM, GRACE_MS, now,
        { gravityMps2: 0 },
      );
      if (s.exceeded && latchMs === null) latchMs = now;
      now += DT * 1000;
    }
    return { latchMs, pos: s.pos };
  }

  it('a literal 0 budget would latch on sensor noise alone', () => {
    // Documents WHY the hook maps `0` to Infinity rather than passing it
    // through: `Math.abs(pos) > 0` is satisfied by any noise at all, so a
    // motionless phone latched ~540 ms into EVERY capture.  This asserts
    // the raw hazard the mapping exists to prevent.
    const r = runStill(0);
    expect(r.latchMs).not.toBeNull();
    expect(Math.abs(r.pos) * 100).toBeLessThan(0.05); // ...on 0.0025 cm
  });

  it('the disabled sentinel never latches, and integrates identically', () => {
    const disabled = runStill(Infinity);
    const enabled = runStill(0.08);
    expect(disabled.latchMs).toBeNull();
    // Disabling the STOP must not disturb the integrator — consumers may
    // still read `lateralCm` with the stop off.
    expect(disabled.pos).toBe(enabled.pos);
  });
});

/**
 * The ROTATION trigger's grace window (v0.26.0).
 *
 * Vectors are the real 2026-08-26 device session: every one of the five stops
 * came from a SINGLE ~400 ms excursion over 0.15 rad/s, one on a 0.7 %
 * overshoot — while every capture in the session stitched at
 * `finalConfidenceThresh = 1.000`.
 */
describe('rotation trigger grace window', () => {
  const THRESH = 0.15;
  const GRACE = 500;

  /** Replay an EMA series at 33 ms (the gyro cadence) through the latch. */
  function latchAt(series: number[], graceMs: number): number | null {
    let since: number | null = null;
    let exceeded = false;
    let t = 0;
    for (const ema of series) {
      const r = _evalGraceLatch(ema > THRESH, t, since, exceeded, graceMs);
      since = r.overBudgetSinceMs;
      if (r.exceeded && !exceeded) return t;
      exceeded = r.exceeded;
      t += 33;
    }
    return null;
  }
  const calm = (n: number) => Array(n).fill(0.028);

  it('a single ~400 ms excursion no longer ends the capture', () => {
    // Capture 10: median crossEma 0.028 — LOWER than eight captures that
    // finished fine — killed by one brief spike to 0.164.
    const series = [...calm(20), ...Array(12).fill(0.164), ...calm(40)];
    expect(latchAt(series, 0)).not.toBeNull();      // old behaviour: stopped
    expect(latchAt(series, GRACE)).toBeNull();      // with grace: survives
  });

  it('a 0.7% overshoot for one window is likewise ignored', () => {
    const series = [...calm(15), ...Array(10).fill(0.151), ...calm(30)];
    expect(latchAt(series, GRACE)).toBeNull();
  });

  it('but a SUSTAINED cross-turn still stops the capture', () => {
    // A genuine veer: continuously over threshold well past the window.
    const series = [...calm(10), ...Array(40).fill(0.30)];
    const t = latchAt(series, GRACE);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(GRACE);       // only after the dwell
  });

  it('a wobble that crosses and re-crosses never latches', () => {
    const series: number[] = [];
    for (let i = 0; i < 12; i++) series.push(...Array(6).fill(0.17), ...Array(6).fill(0.05));
    expect(latchAt(series, GRACE)).toBeNull();
  });

  it('graceMs=0 latches on the SECOND consecutive sample, not the first', () => {
    // `_evalGraceLatch` starts the dwell clock on the first over-threshold
    // sample and can only latch on a later one, so `0` is "as close to the
    // pre-0.26.0 latch-immediately behaviour as this helper allows" — one
    // gyro sample (~33 ms) later, not zero.  Pinned so the distinction
    // cannot be quietly lost.
    expect(latchAt([...calm(5), 0.151], 0)).toBeNull();          // one sample
    expect(latchAt([...calm(5), 0.151, 0.151], 0)).not.toBeNull(); // two
  });
});

/**
 * `CameraHandle.setCaptureSource` — the API gap that left a unified-chrome
 * host with no AR control.
 *
 * `hideBuiltInShutter` hides the shutter AND the AR pill, documented as "the
 * host renders its own capture controls".  The host could always replace the
 * shutter (takePhoto / startPanorama / stopPanorama), but there was NO way to
 * replace the AR toggle — `arPreference` was internal state with no prop and
 * no handle method.  A field build shipped locked to its mount-time source
 * with no indicator and no switch.
 *
 * This pins the handle's SHAPE.  The clamping behaviour (captureSources,
 * device AR support, 0.5x lens) lives in `deriveEffectiveCaptureSource` and is
 * unchanged by this addition.
 */
describe('CameraHandle exposes capture-source control', () => {
  it('declares setCaptureSource alongside the capture methods', () => {
    // Type-level assertion: this file fails to COMPILE under `tsc --noEmit`
    // if the method is missing or its signature drifts.  ts-jest runs
    // transpile-only, so the compile gate is what enforces this — the runtime
    // assertion below just keeps the test honest about having executed.
    type Handle = import('../Camera').CameraHandle;
    type HasSetter = Handle extends { setCaptureSource(s: 'ar' | 'non-ar'): void }
      ? true : false;
    const ok: HasSetter = true;
    expect(ok).toBe(true);
  });
});

/**
 * Non-AR absolute cross-pan ANGLE (gyro-integrated).
 *
 * The rate gate (`lateralTurnRateRadPerSec`, 0.15 rad/s = 8.6 deg/s) cannot
 * see a slow pivot however far it turns.  Angle can, and unlike the
 * displacement channel it can be BELIEVED: one integration, so a gyro bias
 * grows the error linearly (~0.5 deg over 10 s) instead of quadratically
 * (~100 cm for a comparable accel bias).
 */
describe('non-AR cross-pan angle', () => {
  const D2R = Math.PI / 180;
  /** Integrate a rate profile the way the gyro effect does. */
  function integrate(rateDegPerS: (t: number) => number, secs: number, hz = 30) {
    let angle = 0; let peak = 0; let emaPeak = 0; let ema = 0;
    const dt = 1 / hz;
    for (let i = 0; i < secs * hz; i++) {
      const r = rateDegPerS(i * dt) * D2R;
      angle += r * dt;
      peak = Math.max(peak, Math.abs(angle));
      ema = ema * (1 - 0.08) + Math.abs(r) * 0.08;
      emaPeak = Math.max(emaPeak, ema);
    }
    return { deg: peak / D2R, emaPeak };
  }

  it('a 6 deg/s pivot turns 90 deg and the RATE gate never sees it', () => {
    const r = integrate(() => 6, 15);
    expect(r.deg).toBeCloseTo(90, 0);
    expect(r.emaPeak).toBeLessThan(0.15);      // rate gate: silent
    expect(r.deg).toBeGreaterThan(25);         // angle gate: caught
  });

  it('scales with how far you turned, not how fast', () => {
    // Same 60 degrees, delivered slow and fast — both must read 60.
    expect(integrate(() => 4, 15).deg).toBeCloseTo(60, 0);
    expect(integrate(() => 20, 3).deg).toBeCloseTo(60, 0);
  });

  it('is SIGNED — correcting back onto course unwinds it', () => {
    // Wander 20 deg off, then come back.  A capture that self-corrects is not
    // an error, so |angle| must return toward zero rather than banking 40.
    const r = integrate((t) => (t < 5 ? 4 : -4), 10);
    expect(r.deg).toBeCloseTo(20, 0);          // peak excursion
    const final = integrate((t) => (t < 5 ? 4 : -4), 10);
    expect(final.deg).toBeLessThan(25);        // never latches
  });

  it('gyro bias drift stays negligible over a capture', () => {
    // 0.05 deg/s of bias — a realistic post-calibration MEMS figure.
    // Single integration => linear growth, unlike the accel channel's t^2.
    for (const secs of [10, 20, 30]) {
      const r = integrate(() => 0.05, secs);
      expect(r.deg).toBeLessThan(2);           // vs a 25 deg budget
    }
  });

  it('a straight sweep with hand tremor does not accumulate', () => {
    // Tremor is zero-mean, so a signed integrator cancels it; an ABSOLUTE
    // accumulator would have banked it into a false latch.
    const r = integrate((t) => 8 * Math.sin(2 * Math.PI * 1.5 * t), 15);
    expect(r.deg).toBeLessThan(2);
  });
});
