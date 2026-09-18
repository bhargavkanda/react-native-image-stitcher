// SPDX-License-Identifier: Apache-2.0
//
// panoPlusCalibration — the bridge boundary and the SENTENCES.
//
// The sentences matter as much as the parsing here. The field build has no
// console: what this file phrases is the ONLY thing the operator will ever see
// about why a calibration was kept or refused, and a refusal he cannot act on
// is a wasted field trip. So several tests assert the WORDS, not just the tone.

import {
  CALIB_GESTURE,
  basisIsPersistable,
  basisVerdict,
  driftVerdict,
  excitationVerdict,
  gestureCoaching,
  parseBasisSolve,
  parseExcitation,
  parseLiveStatus,
  parseSnapshot,
  parseTauFit,
  storedCalibrationVerdict,
  tauFitVerdict,
} from '../panoPlusCalibration';

describe('parsing — a missing field is null, never a plausible number', () => {
  it('survives null, a string, an array and an empty object', () => {
    for (const junk of [null, undefined, 'nope', [1, 2], {}]) {
      const e = parseExcitation(junk);
      expect(e.ok).toBe(false);
      expect(e.sweptDeg).toBeNull();
      expect(e.perAxisDeg.pan).toBeNull();
    }
  });

  it('defaults needMore to TRUE for an axis nobody reported', () => {
    // Defaulting to false would render a GREEN meter for an axis that was
    // never measured — the single most dangerous default on this panel.
    const e = parseExcitation({ needMore: { pan: false } });
    expect(e.needMore.pan).toBe(false);
    expect(e.needMore.tilt).toBe(true);
    expect(e.needMore.roll).toBe(true);
  });

  it('keeps drift.biasedHigh true unless the native side says otherwise', () => {
    const s = parseBasisSolve({ drift: { measured: true, degPerS: 0.01 } });
    expect(s.drift?.biasedHigh).toBe(true);
  });

  it('parses a live status without losing the tracking-reject count', () => {
    const l = parseLiveStatus({
      recording: true, refRejectedTracking: 42, refSamples: 300,
      perAxisDeg: { tilt: 10, pan: 90, roll: 0 },
    });
    expect(l.recording).toBe(true);
    expect(l.refRejectedTracking).toBe(42);
    expect(l.perAxisDeg.pan).toBe(90);
  });
});

describe('τ — graded on the UNCERTAINTY, never on |τ|', () => {
  const fit = (o: Record<string, unknown>) => parseTauFit({
    ok: true, reason: 'ok', runs: 3, resolvedRuns: 3,
    tauMs: -4.2, tauS: -0.0042, meanMs: -4.2, sdMs: 0.15, spreadMs: 0.3,
    stdErrMs: 0.087, worstPeakR: 0.94, budgetMs: 3.08,
    budgetFractionUsed: 0.028, smallSample: true, ...o,
  });

  it('is unknown before anything ran, and says what to do', () => {
    const v = tauFitVerdict(null);
    expect(v.tone).toBe('unknown');
    expect(v.detail).toMatch(/three times/);
    expect(v.detail).toMatch(/AR session down/);
  });

  // THE HEADLINE TEST. This is the defect the shipped single-run verdict had.
  it('a LARGE but repeatable τ is a PASS', () => {
    const v = tauFitVerdict(fit({ tauMs: -11.3, tauS: -0.0113, stdErrMs: 0.07 }));
    expect(v.tone).toBe('yes');
    expect(v.headline).toMatch(/τ = -11\.30 ms/);
    expect(v.headline).toMatch(/± 0\.07 ms/);
    expect(v.detail).toMatch(/MAGNITUDE of τ is not graded/);
  });

  it('a SMALL but scattered τ is a refusal, with the reason in words', () => {
    const v = tauFitVerdict(fit({
      ok: false, reason: 'spread-too-wide', tauMs: 0.4, spreadMs: 6.0,
    }));
    expect(v.tone).toBe('no');
    expect(v.headline).toMatch(/NOT PERSISTABLE — spread-too-wide/);
    expect(v.detail).toMatch(/disagree by more than 2 ms/);
    expect(v.detail).toMatch(/Nothing was written/);
    // The evidence still shows, so the operator can see how far off he is.
    expect(v.detail).toMatch(/spread 6\.00 ms/);
  });

  it('states the sign convention, because backwards DOUBLES the error', () => {
    const v = tauFitVerdict(fit({}));
    expect(v.detail).toMatch(/POSITIVE τ/);
    expect(v.detail).toMatch(/pts \+ τ/);
  });

  it('admits that n = 3 leaves the SD itself uncertain', () => {
    expect(tauFitVerdict(fit({})).detail).toMatch(/±40 %/);
    expect(tauFitVerdict(fit({ smallSample: false })).detail).not.toMatch(/±40 %/);
  });

  it('reports how much of the residual budget the calibration itself spent', () => {
    const v = tauFitVerdict(fit({ budgetFractionUsed: 0.31 }));
    expect(v.detail).toMatch(/31 % of the 3\.08 ms residual budget/);
  });

  it('names each refusal in terms the operator can act on', () => {
    const cases: Array<[string, RegExp]> = [
      ['no-runs', /No measurements/],
      ['too-few-resolved-runs', /RESOLVED/],
      ['weak-peak', /0\.80 bar/],
      ['std-err-too-wide', /over 1 ms/],
    ];
    for (const [reason, re] of cases) {
      expect(tauFitVerdict(fit({ ok: false, reason })).detail).toMatch(re);
    }
  });
});

describe('the gesture — coached per NAMED axis, never "insufficient"', () => {
  it('leads with the counter-intuitive rule before anything is recorded', () => {
    const v = excitationVerdict(null);
    expect(v.tone).toBe('unknown');
    // The operator has been trained by every other capture in this app to sweep
    // smoothly. That instinct is exactly wrong here, and he must read it first.
    expect(v.detail).toMatch(/CAREFUL STRAIGHT SWEEP IS THE WORST/);
    expect(v.detail).toMatch(/four candidates matching EXACTLY/);
  });

  it('tells a pan-only operator to NOD, by name', () => {
    const e = parseExcitation({
      ok: true, sufficient: false, reason: 'single-axis',
      perAxisDeg: { tilt: 2, pan: 240, roll: 1 },
      needMore: { tilt: true, pan: false, roll: true },
      exercisedAxes: 1, rank2: 0.004, sweptDeg: 245,
    });
    const coach = gestureCoaching(e);
    expect(coach).toMatch(/NOD it up and down/);
    const v = excitationVerdict(e);
    expect(v.tone).toBe('no');
    expect(v.detail).toMatch(/NOD it up and down/);
    // …and the numbers he is being graded on are on screen with it.
    expect(v.detail).toMatch(/pan 240°/);
    expect(v.detail).toMatch(/0\.25/);
  });

  it('distinguishes a still phone from a short log', () => {
    expect(gestureCoaching(parseExcitation({ ok: true, reason: 'stationary' })))
      .toMatch(/barely moved/);
    expect(gestureCoaching(parseExcitation({ ok: true, reason: 'too-few-samples' })))
      .toMatch(/AR camera mounted/);
  });

  it('calls out two motions that are really one axis', () => {
    expect(gestureCoaching(parseExcitation({ ok: true, reason: 'axes-too-close' })))
      .toMatch(/too close to the same axis/);
  });

  it('passes a two-axis gesture and says why two is enough', () => {
    const v = excitationVerdict(parseExcitation({
      ok: true, sufficient: true, exercisedAxes: 2, sweptDeg: 300, rank2: 0.55,
      perAxisDeg: { tilt: 90, pan: 200, roll: 10 },
      needMore: { tilt: false, pan: false, roll: true },
    }));
    expect(v.tone).toBe('yes');
    expect(v.detail).toMatch(/generate all of SO\(3\)/);
    expect(gestureCoaching(parseExcitation({ ok: true, sufficient: true }))).toBeNull();
  });

  it('scripts three segments, pan first and roll marked optional', () => {
    expect(CALIB_GESTURE.map((s) => s.axis)).toEqual(['pan', 'tilt', 'roll']);
    expect(CALIB_GESTURE[1].why).toMatch(/breaks the tie/);
    expect(CALIB_GESTURE[2].why).toMatch(/Not required/);
  });
});

describe('the basis verdict', () => {
  const solve = (o: Record<string, unknown>) => parseBasisSolve({
    ran: true,
    basis: {
      ok: true, reason: 'ok', index: 7, label: '+y+x-z', pairs: 240,
      rmsDeg: 0.31, marginDeg: 42.1, unique: true,
      runnerUpIndex: 20, runnerUpLabel: '-z+x+y', runnerUpRmsDeg: 42.4,
    },
    stability: { ok: true, winnerStable: true, winnerIndex: 7, reason: 'ok' },
    ...o,
  });

  it('reports the winner WITH the runner-up it beat', () => {
    const v = basisVerdict(solve({}));
    expect(v.tone).toBe('yes');
    expect(v.headline).toMatch(/C = #7 \+y\+x-z/);
    expect(v.detail).toMatch(/#20 -z\+x\+y/);
    expect(v.detail).toMatch(/chosen by the geometry and not by the clock/);
  });

  // ⚠ REWRITTEN 2026-08-31. This asserted the copy said "provisional", which
  // was the honest word for a state the store would then have SAVED. It no
  // longer will: `RNISPanoCalibStore.saveBasis` refuses an unstable winner,
  // because a winner that moves under a 5 ms clock offset was chosen by the
  // clock and not by the geometry — direct evidence the permutation is not
  // identified, which is exactly what the persist gate is for, and which the
  // single-τ margin structurally cannot see. "Provisional" would now describe
  // a basis the operator cannot keep, and would send him looking for the Save
  // button instead of back to the gesture.
  it('refuses, in the HEADLINE, a winner that did not survive the ±10 ms sweep', () => {
    const v = basisVerdict(solve({
      stability: { ok: true, winnerStable: false, reason: 'winner-changed' },
    }));
    // The headline is the half that used to lie: it read `BASIS C = #7 …` with
    // tone `yes`, and only the tail of the detail said "provisional".
    expect(v.tone).toBe('no');
    expect(v.headline).toMatch(/REFUSED/);
    expect(v.detail).toMatch(/did not survive/);
    expect(v.detail).toMatch(/Nothing will be saved/);
    // …and it names the fix, which is a gesture and not a retry.
    expect(v.detail).toMatch(/OFF-AXIS/);
    // …and the rejected candidate is still SHOWN, so the refusal has evidence.
    expect(v.detail).toMatch(/#7 \+y\+x-z/);
  });

  // The SCREEN's mirror of the native persist gate. Both halves must agree, or
  // the button leads into a native rejection that reads as broken.
  describe('basisIsPersistable mirrors the store gate', () => {
    it('accepts a unique fit whose winner is stable', () => {
      expect(basisIsPersistable(solve({}))).toEqual({ ok: true, reason: 'ok' });
    });

    it('refuses an unstable winner even though the fit itself passed', () => {
      const r = basisIsPersistable(solve({
        stability: { ok: true, winnerStable: false, reason: 'winner-changed' },
      }));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('winner-changed');
    });

    it('refuses when the stability sweep did not run at all', () => {
      const r = basisIsPersistable(solve({
        stability: { ok: false, winnerStable: false, reason: 'no-offsets' },
      }));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('no-offsets');
    });

    it('refuses a refused fit before it ever looks at the stability', () => {
      const r = basisIsPersistable(solve({
        basis: { ok: false, reason: 'ambiguous-axis' },
      }));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('ambiguous-axis');
    });

    it('refuses a null solve rather than throwing', () => {
      expect(basisIsPersistable(null)).toEqual({ ok: false, reason: 'not-solved' });
    });
  });

  // The prototype's own defect, phrased for a person.
  it('blames the GESTURE, not the maths, when the log cannot decide', () => {
    const v = basisVerdict(solve({
      basis: { ok: false, reason: 'excitation-insufficient', index: 20,
               label: '-z+x+y', rmsDeg: 0.0, marginDeg: 0.0,
               runnerUpIndex: 2, runnerUpLabel: '+z+x-y', runnerUpRmsDeg: 0.0 },
      excitationRef: { ok: true, reason: 'single-axis',
                       needMore: { tilt: true, pan: false, roll: true } },
    }));
    expect(v.tone).toBe('no');
    expect(v.headline).toMatch(/BASIS REFUSED — excitation-insufficient/);
    expect(v.detail).toMatch(/THE GESTURE, not the maths/);
    expect(v.detail).toMatch(/NOD it up and down/);
    // The rejected candidate is SHOWN — and explicitly marked unusable.
    expect(v.detail).toMatch(/NOT because it may be used/);
  });

  it('explains the exact tie when the fit itself refuses', () => {
    const v = basisVerdict(solve({
      basis: { ok: false, reason: 'ambiguous-axis', index: 20, label: '-z+x+y',
               runnerUpIndex: 2, runnerUpLabel: '+z+x-y' },
    }));
    expect(v.detail).toMatch(/exact four-way tie/);
  });
});

describe('drift — an ARCHITECTURE verdict that never gates the basis', () => {
  it('says so in the sentence, on both sides of the bar', () => {
    for (const within of [true, false]) {
      const v = driftVerdict({
        measured: true, degPerS: within ? 0.005 : 0.05,
        canvasPxOverSweep: within ? 0.47 : 4.68, sweepSeconds: 8,
        canvasPxPerDeg: 11.7, budgetPx: 0.68, withinBudget: within,
        rmsDetrendedDeg: 0.12, biasedHigh: true,
      });
      expect(v.tone).toBe(within ? 'yes' : 'no');
      expect(v.detail).toMatch(/does NOT gate the basis/);
      expect(v.detail).toMatch(/reads HIGH/);
    }
  });

  it('does not pretend an unmeasured drift passed', () => {
    const v = driftVerdict(null);
    expect(v.tone).toBe('unknown');
    expect(v.detail).toMatch(/veto the decoupled arm/);
  });
});

describe('the store verdict — what a sweep would do RIGHT NOW', () => {
  it('is a NO with the missing half named', () => {
    const v = storedCalibrationVerdict(parseSnapshot({
      deviceModel: 'iPhone17,1', tauKey: 'k', basisKey: 'iPhone17,1',
      resolved: { haveTau: true, haveBasis: false, complete: false, missing: 'basis',
                  tauS: -0.0042 },
      storedTauKeys: ['k'], storedBasisKeys: [],
    }));
    expect(v.tone).toBe('no');
    expect(v.headline).toMatch(/missing basis/);
    expect(v.detail).toMatch(/run the gesture/);
    // The refusal itself is defended, so nobody "fixes" it with a default.
    expect(v.detail).toMatch(/no default τ/);
  });

  it('points at a τ stored under a DIFFERENT key rather than looking empty', () => {
    const v = storedCalibrationVerdict(parseSnapshot({
      resolved: { haveTau: false, haveBasis: true, complete: false, missing: 'tau' },
      storedTauKeys: ['iPhone17,1|wide|1920x1440|60'],
    }));
    expect(v.detail).toMatch(/under other keys/);
    expect(v.detail).toMatch(/readout constant/);
  });

  it('is a YES with both keys and both dates once complete', () => {
    const v = storedCalibrationVerdict(parseSnapshot({
      tauKey: 'iPhone17,1|ultra|1920x1440|60', basisKey: 'iPhone17,1',
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: -0.0113, basisIndex: 7, basisLabel: '+y+x-z',
        tauMeasuredAt: '2026-08-31T09:00:00Z', basisMeasuredAt: '2026-08-31T09:05:00Z',
      },
    }));
    expect(v.tone).toBe('yes');
    expect(v.headline).toMatch(/τ -11\.30 ms/);
    expect(v.headline).toMatch(/C #7 \+y\+x-z/);
    expect(v.detail).toMatch(/without asking again/);
  });
});
