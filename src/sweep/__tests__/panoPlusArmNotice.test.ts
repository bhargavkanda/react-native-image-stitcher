// SPDX-License-Identifier: Apache-2.0
//
// panoPlusArmNotice — WHAT THE OPERATOR IS TOLD ABOUT THE SELECTED ARM, BEFORE
// HE PRESSES ANYTHING.
//
// ── Why this table is worth a test file of its own ────────────────────────
//
// Every branch below is a DEVICE STATE that cannot be produced on this machine:
// a phone with no physical ultra-wide, a phone whose ultra-wide publishes no
// 4:3 format at 60 fps, a phone nobody has calibrated, an app binary built
// before the calibration pod was installed. None of them can be reached by a
// render test, none by the C++ host tests, and none by anything short of
// holding the specific handset. So the mapping from those states to the
// sentence and the BUTTON LABEL is the only part that can be pinned here — and
// it is also the part that decides whether the arm reads as "unconfigured" or
// as "broken", which is the entire deliverable.
//
// The property that matters most is the last one in the file: the ARKit default
// must render NOTHING new. That is what makes "the shipped path is unchanged" a
// checked fact rather than a claim in a comment.

import { panoPlusArmNotice } from '../panoPlusModel';

const OK_PLAN = { ok: true, reason: null, detail: null };

function calib(over: Partial<Parameters<typeof panoPlusArmNotice>[2] & object> = {}) {
  return {
    complete: false,
    missing: 'tau+basis' as string | null,
    tauS: null as number | null,
    tauStdErrMs: null as number | null,
    basisIndex: null as number | null,
    basisLabel: null as string | null,
    tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
    storedTauKeys: [] as string[],
    ...over,
  };
}

describe('panoPlusArmNotice', () => {
  describe("the ARKit arm — the default, and it must stay invisible", () => {
    it('renders no banner and the shipped button label', () => {
      const n = panoPlusArmNotice('ar', null, null);
      // An empty headline is what the surface gates the whole banner on, so
      // this is the assertion that keeps the default screen pixel-identical.
      expect(n.headline).toBe('');
      expect(n.detail).toBe('');
      expect(n.startLabel).toBe('Start sweep');
      expect(n.canStart).toBe(true);
      expect(n.effectivePoseSource).toBe('ar');
      expect(n.fallbackToAr).toBe(false);
    });

    it('ignores the calibration entirely — it is not the ARKit arm\'s business', () => {
      // A device with no calibration at all must not change one pixel of the
      // ARKit path. If this ever fails, the IMU work has leaked into the arm
      // that is carrying the programme.
      expect(panoPlusArmNotice('ar', { ok: false, reason: 'panoplus-no-ultrawide', detail: 'x' }, calib()))
        .toEqual(panoPlusArmNotice('ar', OK_PLAN, calib({ complete: true })));
    });
  });

  describe('the IMU arm — the precondition, stated before the tap', () => {
    it('an un-repodded binary blames the BUILD, not the phone', () => {
      // `plannedCaptureFormat` answers `calib-unavailable` when the native
      // method is missing — which happens on an app built before the pod
      // install, and `git status` can never catch that because every pano+
      // native file is untracked. Telling the operator to go and calibrate
      // would send him to run a panel that is not in the binary either.
      const n = panoPlusArmNotice('imu', { ok: false, reason: 'calib-unavailable', detail: 'no module' }, null);
      expect(n.headline).toContain('THIS BUILD CANNOT ANSWER');
      expect(n.detail).toContain('pod install');
      expect(n.fallbackToAr).toBe(true);
      expect(n.effectivePoseSource).toBe('ar');
    });

    it('NO ULTRA-WIDE is a hardware verdict and must NOT say "calibrate"', () => {
      // THE DISTINCTION THIS FILE EXISTS FOR. On a body with no physical
      // ultra-wide there is nothing to measure a tau on, so a "run the
      // calibration" sentence sends the operator to do work that cannot fix
      // the fault — and he would conclude the calibration is broken.
      const n = panoPlusArmNotice(
        'imu',
        { ok: false, reason: 'panoplus-no-ultrawide', detail: 'This device publishes no builtInUltraWideCamera.' },
        calib({ complete: true, missing: null }),
      );
      expect(n.headline).toContain('NO PHYSICAL ULTRA-WIDE');
      expect(n.detail).toContain('hardware finding');
      expect(n.detail.toLowerCase()).not.toContain('run 🧭');
      expect(n.fallbackToAr).toBe(true);
    });

    it('NO 60 fps FORMAT is also hardware, and is a different sentence', () => {
      const n = panoPlusArmNotice(
        'imu',
        { ok: false, reason: 'panoplus-no-60fps-format', detail: 'no 4:3 at 60.' },
        calib({ complete: true }),
      );
      expect(n.headline).toContain('60 fps');
      expect(n.fallbackToAr).toBe(true);
    });

    it('the hardware question is asked BEFORE the calibration question', () => {
      // Order, pinned: an uncalibrated phone that ALSO has no ultra-wide must
      // report the hardware. The reverse order is what the native start path
      // used to do, and it produced exactly the misleading instruction above.
      const n = panoPlusArmNotice(
        'imu',
        { ok: false, reason: 'panoplus-no-ultrawide', detail: 'none.' },
        calib({ complete: false, missing: 'tau+basis' }),
      );
      expect(n.headline).toContain('ULTRA-WIDE');
      expect(n.headline).not.toContain('NEEDS CALIBRATION');
    });

    it('uncalibrated names WHICH half is missing, and what to run', () => {
      const both = panoPlusArmNotice('imu', OK_PLAN, calib({ missing: 'tau+basis' }));
      expect(both.headline).toContain('NEEDS CALIBRATION');
      expect(both.headline).toContain('tau+basis');
      expect(both.detail).toContain('both stages');

      const tau = panoPlusArmNotice('imu', OK_PLAN, calib({ missing: 'tau' }));
      expect(tau.detail).toContain('stage 1');
      expect(tau.detail).toContain('three clock runs');

      const basis = panoPlusArmNotice('imu', OK_PLAN, calib({ missing: 'basis' }));
      expect(basis.detail).toContain('stage 2');
      // The counter-instinct, carried into the sweep screen rather than living
      // only on the calibration panel: a straight pan is the WORST capture for
      // the basis and leaves an exact four-way tie.
      expect(basis.detail).toContain('TWO axes');
    });

    it('an ORPHANED tau under another key is named, with the key it would use', () => {
      // The failure this is the readout for: tau is keyed by format, and a
      // record measured on another format is not a fallback. Saying only "no
      // tau" while the store holds one is what makes an operator conclude the
      // save silently failed.
      const n = panoPlusArmNotice(
        'imu',
        OK_PLAN,
        calib({
          missing: 'tau',
          storedTauKeys: ['iPhone17,1|AVCaptureDeviceTypeBuiltInWideAngleCamera|1920x1440|60'],
        }),
      );
      expect(n.detail).toContain('BuiltInWideAngleCamera');
      expect(n.detail).toContain('1920x1440');
      expect(n.detail).toContain('rolling-shutter');
    });

    it('a null snapshot is treated as uncalibrated, never as calibrated', () => {
      // Fail-safe direction. A read that failed must not read as a pass.
      const n = panoPlusArmNotice('imu', OK_PLAN, null);
      expect(n.headline).toContain('NEEDS CALIBRATION');
      expect(n.effectivePoseSource).toBe('ar');
    });

    it('calibrated quotes the NUMBERS and the sign convention', () => {
      const n = panoPlusArmNotice(
        'imu',
        OK_PLAN,
        calib({
          complete: true, missing: null,
          tauS: -0.01142, tauStdErrMs: 0.61, basisIndex: 9, basisLabel: '+y+z+x',
        }),
      );
      expect(n.tone).toBe('ok');
      expect(n.headline).toBe('IMU ARM — CALIBRATED');
      expect(n.detail).toContain('-11.42 ms');
      expect(n.detail).toContain('±0.61 ms');
      // The sign travels WITH the number everywhere: applied backwards an
      // offset doubles the error rather than halving it.
      expect(n.detail).toContain('pts+τ');
      expect(n.detail).toContain('#9');
      // And the arm's own honesty note: `t` is identically zero here, so the
      // pose-speed cage does not run. A pack must never read `rejectedPoseSpeed: 0`
      // as a cage that passed.
      expect(n.detail).toContain('pose-speed cage does not');
      expect(n.effectivePoseSource).toBe('imu');
      expect(n.fallbackToAr).toBe(false);
      expect(n.startLabel).toBe('Start sweep (IMU)');
    });
  });

  describe('the button label always names the arm that will actually run', () => {
    it('never offers "Start sweep (IMU)" on a state that cannot start it', () => {
      const unusable = [
        panoPlusArmNotice('imu', { ok: false, reason: 'panoplus-no-ultrawide', detail: '' }, calib({ complete: true })),
        panoPlusArmNotice('imu', { ok: false, reason: 'calib-unavailable', detail: '' }, null),
        panoPlusArmNotice('imu', OK_PLAN, calib()),
        panoPlusArmNotice('imu', OK_PLAN, null),
      ];
      for (const n of unusable) {
        expect(n.startLabel).toBe('Sweep on ARKit instead');
        expect(n.effectivePoseSource).toBe('ar');
        expect(n.fallbackToAr).toBe(true);
        // AND IT STILL STARTS. A dead button at a shelf is a wasted trip; the
        // point is that the downgrade is announced and recorded, not that the
        // operator is blocked.
        expect(n.canStart).toBe(true);
      }
    });

    it('effectivePoseSource is imu ONLY when everything checks out', () => {
      expect(
        panoPlusArmNotice('imu', OK_PLAN, calib({ complete: true, missing: null }))
          .effectivePoseSource,
      ).toBe('imu');
    });
  });
  // ═══════════════════════════════════════════════════════════════════════
  // THE τ = 0 EXPERIMENT (2026-08-31)
  //
  // The device calibrated its BASIS and not its τ: stage 2 gave C #8 at 0.234°
  // over 777 pairs, stable under every offset in ±10 ms; stage 1 resolved 8 of
  // 12 times and scattered 5.03 ms against a 3.08 ms budget, so the persist
  // gate refused to write one — correctly, and this must not weaken it.
  //
  // What it DOES change is that "no τ" is no longer the end of the road: a
  // sweep can DECLARE itself uncorrected. The two properties below are the
  // whole deliverable — the arm becomes startable, and the screen says
  // EXPERIMENT rather than looking like a calibrated run.
  // ═══════════════════════════════════════════════════════════════════════
  describe('the τ = 0 experiment', () => {
    const BASIS_ONLY = calib({
      // EXACTLY the operator's device after 2026-08-31: basis persisted, τ did
      // not, so `complete` is false and `missing` is 'tau'.
      complete: false,
      missing: 'tau',
      basisIndex: 8,
      basisLabel: '-y+x+z',
    });

    it('MAKES THE ARM STARTABLE on a phone with a basis and no τ', () => {
      // Without the experiment this exact state falls back to ARKit — which is
      // right when the sweep claims to be corrected, and is why the arm could
      // not be run at all before this flag existed.
      const off = panoPlusArmNotice('imu', OK_PLAN, BASIS_ONLY, false);
      expect(off.effectivePoseSource).toBe('ar');
      expect(off.fallbackToAr).toBe(true);

      const on = panoPlusArmNotice('imu', OK_PLAN, BASIS_ONLY, true);
      expect(on.effectivePoseSource).toBe('imu');
      expect(on.fallbackToAr).toBe(false);
      expect(on.canStart).toBe(true);
    });

    it('READS AS AN EXPERIMENT, not as a calibrated run', () => {
      const n = panoPlusArmNotice('imu', OK_PLAN, BASIS_ONLY, true);
      // The headline is the one string an operator actually reads, and it must
      // carry both facts: this is an experiment, and τ is zero.
      expect(n.headline).toContain('EXPERIMENT');
      expect(n.headline).toContain('τ = 0');
      // The button names what it will do. A button reading "Start sweep (IMU)"
      // on an uncorrected run is how a pack gets believed to be corrected.
      expect(n.startLabel).toContain('τ=0');
      expect(n.startLabel).toContain('EXPERIMENT');
      // AMBER, not the ordinary tone: it starts, so it is not a refusal, and
      // it is not a normal run either.
      expect(n.tone).toBe('warn');
      // And it must NEVER claim a measured τ.
      expect(n.detail).not.toContain('CALIBRATED');
      expect(n.detail).toContain('NO camera↔IMU timing correction');
      // The basis DID calibrate, and the notice says so — recording the pair
      // under one "uncalibrated" banner would throw away a real measurement.
      expect(n.detail).toContain('C #8');
      expect(n.detail).toContain('-y+x+z');
    });

    // ── THE BANNER IS PACK-ONLY NOW (2026-09-07) ─────────────────────────
    // The operator, on the capture screen: "what do you mean by tau=0
    // experiment? Why should the user know this and what do they have to do
    // about it?" Nothing — it is a declaration he already made in the gear,
    // not a precondition he can act on. So the STRING stays (the pack is how
    // an uncorrected pack is told apart later) and the SCREEN loses it, and
    // `packOnly` is the split between the two.
    it('is PACK-ONLY — the string survives, the banner does not', () => {
      const n = panoPlusArmNotice('imu', OK_PLAN, BASIS_ONLY, true);
      expect(n.packOnly).toBe(true);
      // …and the prose is untouched, because the pack is the only reader now.
      expect(n.headline).toBe('IMU ARM — EXPERIMENT: τ = 0, NO TIMING CORRECTION');
      expect(n.detail).toContain('tauProvenance: uncorrected');
    });

    it('leaves every REAL refusal on the screen', () => {
      // A refusal is the opposite case: the arm will not run, the operator has
      // something to do about it, and hiding it would turn UNCONFIGURED into
      // BROKEN — the exact failure this notice was written for.
      const cases = [
        panoPlusArmNotice('imu', OK_PLAN, null, true),
        panoPlusArmNotice('imu', OK_PLAN, calib({ missing: 'tau+basis' }), true),
        panoPlusArmNotice('imu', null, BASIS_ONLY, true),
        panoPlusArmNotice(
          'imu',
          { ok: false, reason: 'panoplus-no-ultrawide', detail: 'none published' },
          BASIS_ONLY,
          true,
        ),
        panoPlusArmNotice('imu', OK_PLAN, calib(), false),
        panoPlusArmNotice(
          'imu',
          OK_PLAN,
          calib({ complete: true, missing: null, tauS: 0.00289, basisIndex: 8 }),
          false,
        ),
      ];
      for (const n of cases) {
        expect(n.packOnly ?? false).toBe(false);
        expect(n.headline).not.toBe('');
      }
    });

    it('STILL REQUIRES THE BASIS — it drops the timing correction, not C', () => {
      // An uncorrected sweep without a basis would rotate the entire canvas by
      // one of 24 signed permutations, and no τ would fix that.
      const noBasis = panoPlusArmNotice('imu', OK_PLAN, calib({ missing: 'tau+basis' }), true);
      expect(noBasis.effectivePoseSource).toBe('ar');
      expect(noBasis.fallbackToAr).toBe(true);
      expect(noBasis.headline).toContain('BASIS');
      // And a null snapshot is the same verdict, not a crash.
      expect(panoPlusArmNotice('imu', OK_PLAN, null, true).effectivePoseSource).toBe('ar');
    });

    it('does NOT outrank the HARDWARE verdict', () => {
      // No ultra-wide means there is no lens to sweep on. Declaring the timing
      // uncorrected cannot conjure one, and telling the operator otherwise
      // sends him to do work that cannot fix the fault.
      const n = panoPlusArmNotice(
        'imu',
        { ok: false, reason: 'panoplus-no-ultrawide', detail: 'none published' },
        BASIS_ONLY,
        true,
      );
      expect(n.effectivePoseSource).toBe('ar');
      expect(n.headline).toContain('NO PHYSICAL ULTRA-WIDE');
    });

    it('leaves the ARKit arm byte-identical whatever the flag says', () => {
      // There is no camera↔IMU offset on the ARKit path at all, so the flag
      // must be invisible there — including on a phone that has a basis.
      expect(panoPlusArmNotice('ar', OK_PLAN, BASIS_ONLY, true))
        .toEqual(panoPlusArmNotice('ar', OK_PLAN, BASIS_ONLY, false));
      expect(panoPlusArmNotice('ar', OK_PLAN, BASIS_ONLY, true).headline).toBe('');
    });

    it('a FULLY calibrated phone is unaffected when the flag is off', () => {
      // The regression this could have caused: the experiment branch must not
      // capture the ordinary calibrated case.
      const full = calib({ complete: true, missing: null, tauS: 0.00289, basisIndex: 8 });
      const n = panoPlusArmNotice('imu', OK_PLAN, full, false);
      expect(n.headline).toContain('CALIBRATED');
      expect(n.startLabel).toBe('Start sweep (IMU)');
      expect(n.tone).toBe('ok');
    });

    it('and the experiment WINS over a stored τ when it is on', () => {
      // THE STORE-OVERRIDE RULE, at the screen. A calibrated phone asked for
      // the experiment runs the experiment — if the notice said CALIBRATED
      // here, the surface would send no `tauUncorrected` and the store would
      // supply a measured τ, so the experiment would silently never run.
      const full = calib({ complete: true, missing: null, tauS: 0.00289, basisIndex: 8 });
      const n = panoPlusArmNotice('imu', OK_PLAN, full, true);
      expect(n.headline).toContain('EXPERIMENT');
      expect(n.effectivePoseSource).toBe('imu');
      expect(n.startLabel).toContain('τ=0');
    });
  });
});

// ── THE DROPPED LENS, SAID OUT LOUD ────────────────────────────────────────
//
// Field report, 2026-09-19: "0.5x lens does not go to that camera — shows the
// same view as 1x." The fallback was doing the right thing and saying the
// wrong thing: the operator tapped a LENS and the banner answered about IMU
// calibration, a subject he had not touched.
describe('panoPlusArmNotice — a fallback names the lens it dropped', () => {
  /** The shipped iPhone state: IMU asked for, no τ/basis for that key. */
  const fellBack = (lens: 'wide' | 'ultraWide') =>
    panoPlusArmNotice('imu', OK_PLAN, calib(), false, false, lens);

  it('⚑ the HEADLINE carries it — the detail is collapsed behind ▸', () => {
    // The banner renders the headline with "tap for why"; the detail is
    // folded. A dropped 0.5× explained only inside the fold is a dropped
    // 0.5× the operator never reads, which is exactly how this shipped.
    expect(fellBack('ultraWide').headline).toMatch(/^0\.5× UNAVAILABLE — /);
  });

  it('⚑ …and the detail says WHICH camera is actually running', () => {
    const d = fellBack('ultraWide').detail;
    expect(d).toContain('1× WIDE CAMERA');
    // The arm's own explanation is KEPT, not replaced — the operator still
    // needs to know how to fix it. Asserted as a suffix rather than by
    // keyword, so rewording the arm copy cannot make this vacuous.
    expect(d.endsWith(fellBack('wide').detail)).toBe(true);
  });

  it('⚑ NEGATIVE CONTROL: a 1× request says nothing about lenses', () => {
    // Without this the change passes for a notice that shouts about the
    // ultra-wide on every fallback, including ones nobody asked a lens for.
    const n = fellBack('wide');
    expect(n.headline).not.toContain('0.5×');
    expect(n.detail).not.toContain('1× WIDE CAMERA');
  });

  it('⚑ the default is silent, so every existing caller is byte-identical', () => {
    // The parameter is trailing and optional. A caller that never passes it
    // must render exactly what it rendered before.
    expect(panoPlusArmNotice('imu', OK_PLAN, calib(), false, false))
      .toEqual(fellBack('wide'));
  });

  it('⚑ a lens cannot be dropped by an arm that RAN — the AR request is untouched', () => {
    // `poseSource: 'ar'` is not a fallback, it is a choice, and it returns
    // the empty notice. The lens parameter must not resurrect a banner there.
    const n = panoPlusArmNotice('ar', OK_PLAN, calib(), false, false, 'ultraWide');
    expect(n.headline).toBe('');
    expect(n.fallbackToAr).toBe(false);
  });
});

// ── THE ONE PATH THAT ACTUALLY DELIVERS 0.5× ON iOS ────────────────────────
//
// ARKit publishes no ultra-wide format, so 0.5× needs the DECOUPLED arm, and
// the decoupled arm needs a calibration. τ cannot be measured through this
// package at all — the copy points at "the gear: 🧭 IMU cal stage 1", and that
// UI lives in the private shell, not here. The BASIS can be: the first-run
// acquisition overlay is in this package and measures it once per phone.
//
// Branch 3 is therefore the only reachable route to a working 0.5× on iOS
// today, and it is reachable: `tauUncorrected` is NOT omitted from
// `SweepOptions`, so a host can pass it. These pin that chain end to end so a
// future edit cannot quietly close the only door that is open.
describe('panoPlusArmNotice — the τ=0 route to a working 0.5×', () => {
  const withBasis = () => calib({ basisIndex: 3, basisLabel: 'C#3' });

  it('⚑ basis + tauUncorrected RUNS the decoupled arm at 0.5×', () => {
    const n = panoPlusArmNotice('imu', OK_PLAN, withBasis(), true, false, 'ultraWide');
    expect(n.effectivePoseSource).toBe('imu');
    expect(n.fallbackToAr).toBe(false);
    expect(n.canStart).toBe(true);
  });

  it('⚑ …so the lens is NOT reported as dropped on that route', () => {
    // The 0.5× decoration keys on `fallbackToAr`. A route that really opens
    // the ultra-wide must not tell the operator his lens was dropped.
    const n = panoPlusArmNotice('imu', OK_PLAN, withBasis(), true, false, 'ultraWide');
    expect(n.headline).not.toContain('0.5× UNAVAILABLE');
  });

  it('⚑ NEGATIVE CONTROL: tauUncorrected WITHOUT a basis still falls back', () => {
    // τ=0 drops the TIMING correction, not the device→camera basis: without
    // C the whole canvas is rotated by one of 24 signed permutations.
    const n = panoPlusArmNotice('imu', OK_PLAN, calib(), true, false, 'ultraWide');
    expect(n.effectivePoseSource).toBe('ar');
    expect(n.fallbackToAr).toBe(true);
    expect(n.headline).toContain('0.5× UNAVAILABLE');
  });

  it('⚑ NEGATIVE CONTROL: a basis WITHOUT tauUncorrected still falls back', () => {
    // Which is the operator's shipped state, and why 0.5× does nothing today.
    const n = panoPlusArmNotice('imu', OK_PLAN, withBasis(), false, false, 'ultraWide');
    expect(n.effectivePoseSource).toBe('ar');
    expect(n.fallbackToAr).toBe(true);
  });
});
