// SPDX-License-Identifier: Apache-2.0
//
// panoPlusBasisAcquisition — THE LADDER, AND THE WORD THE PACK GETS TO USE.
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// Every rung of this ladder is a state that cannot be produced on this machine:
// a phone with a basis on file, a phone that can derive one, a phone that can
// only measure one, a binary with no calibration module at all. None of them is
// reachable by a render test and none by the C++ host suite. So the ORDER of
// the rungs and the PROVENANCE each one is allowed to claim are the only parts
// that can be pinned here — and they are also the two parts whose failure is
// silent: a wrong order costs a re-measurement nobody notices, and a wrong word
// puts `measured` on a pack that measured nothing.
//
// The property that matters most is the last block: a derived basis is NEVER
// labelled measured. `rnis_pano_android_basis.hpp` argues that at length, and
// this is the assertion that makes the argument enforceable.

import {
  panoPlusBasisCapability,
  resolvePanoPlusBasis,
} from '../panoPlusBasisAcquisition';

const IOS = panoPlusBasisCapability('ios');
const ANDROID = panoPlusBasisCapability('android');
const OK_PLAN = { ok: true, reason: null, detail: null };

describe('the platform capability — the asymmetry, as data', () => {
  it('Android CAN derive, and says why', () => {
    expect(ANDROID.canDerive).toBe(true);
    expect(ANDROID.reason).toBe('documented-sensor-frame');
    expect(ANDROID.detail).toMatch(/SENSOR_ORIENTATION/);
  });

  it('iOS CANNOT, and names the undocumented seam rather than shrugging', () => {
    expect(IOS.canDerive).toBe(false);
    expect(IOS.reason).toBe('undocumented-imu-frame');
    // The reason the measurement exists at all must be IN the sentence — an
    // operator reading "cannot derive" with no cause has been told nothing.
    expect(IOS.detail).toMatch(/CoreMotion/);
  });

  it('an unrecognised platform answers NO — the conservative answer', () => {
    // A guessed C rotates the whole canvas by one of 24 permutations and
    // nothing in the pixels contradicts it. "We have not read the docs" must
    // never resolve to "so derive it anyway".
    const other = panoPlusBasisCapability('web');
    expect(other.canDerive).toBe(false);
    expect(other.reason).toBe('unknown-platform');
  });
});

describe('the ladder — stored ▸ derived ▸ gesture ▸ blocked', () => {
  it('a STORED basis wins, on both platforms, and claims `measured`', () => {
    for (const capability of [IOS, ANDROID]) {
      const r = resolvePanoPlusBasis({
        capability, plan: OK_PLAN, basisIndex: 8, basisLabel: '+Y+Z+X',
      });
      expect(r.route).toBe('stored');
      expect(r.needsGesture).toBe(false);
      expect(r.basisIndex).toBe(8);
      expect(r.provenance).toBe('measured');
    }
  });

  it('the store OUTRANKS the derivation — the falsification must be able to win', () => {
    // rnis_pano_android_basis.hpp: the derivation is a HYPOTHESIS about the
    // sensor mounting; a selectBasis() measurement against a concurrent
    // reference log is EVIDENCE. The Android recorder's own authority ladder
    // ranks them that way. Inverting it here would let the derivation
    // overwrite the very sweep that was run to check it.
    const r = resolvePanoPlusBasis({
      capability: ANDROID, plan: OK_PLAN, basisIndex: 8, basisLabel: '+Y+Z+X',
    });
    expect(r.route).toBe('stored');
    expect(r.provenance).toBe('measured');
  });

  it('Android with NOTHING on file derives, and never asks for a gesture', () => {
    const r = resolvePanoPlusBasis({
      capability: ANDROID, plan: OK_PLAN, basisIndex: null, basisLabel: null,
    });
    expect(r.route).toBe('derived');
    expect(r.needsGesture).toBe(false);
  });

  it('iOS with nothing on file needs the GESTURE', () => {
    const r = resolvePanoPlusBasis({
      capability: IOS, plan: OK_PLAN, basisIndex: null, basisLabel: null,
    });
    expect(r.route).toBe('gesture');
    expect(r.needsGesture).toBe(true);
    expect(r.reason).toBe('gesture-required');
  });
});

describe('the two dead ends — and neither of them offers a gesture', () => {
  it('a binary with no calibration module blames the BUILD', () => {
    const r = resolvePanoPlusBasis({
      capability: IOS,
      plan: { ok: false, reason: 'calib-unavailable', detail: 'no pod' },
      basisIndex: null, basisLabel: null,
    });
    expect(r.route).toBe('blocked');
    expect(r.needsGesture).toBe(false);
    expect(r.reason).toBe('no-calibration-module');
    expect(r.detail).toMatch(/app-build fact/);
  });

  it('a null plan is the same finding — never treated as "hardware is fine"', () => {
    const r = resolvePanoPlusBasis({
      capability: IOS, plan: null, basisIndex: null, basisLabel: null,
    });
    expect(r.reason).toBe('no-calibration-module');
  });

  it('a phone with no usable lens is REFUSED, not sent to do a gesture', () => {
    // Telling an operator holding a phone with no physical ultra-wide to
    // perform a calibration is sending him to do work that cannot fix the
    // fault. The hardware question is asked before the gesture is offered.
    const r = resolvePanoPlusBasis({
      capability: IOS,
      plan: {
        ok: false,
        reason: 'panoplus-no-ultrawide',
        detail: 'This body publishes no physical ultra-wide.',
      },
      basisIndex: null, basisLabel: null,
    });
    expect(r.route).toBe('blocked');
    expect(r.needsGesture).toBe(false);
    expect(r.reason).toBe('hardware-refused');
    expect(r.detail).toMatch(/cannot change that/);
  });

  it('the BUILD question is asked before the HARDWARE one', () => {
    // A binary that cannot answer must not be reported as a phone that
    // refused: the first is fixed by a pod install and the second cannot be
    // fixed at all.
    const r = resolvePanoPlusBasis({
      capability: IOS,
      plan: { ok: false, reason: 'calib-unavailable', detail: null },
      basisIndex: null, basisLabel: null,
    });
    expect(r.reason).toBe('no-calibration-module');
  });

  it('a DECLINED gesture blocks this capture and says it is not remembered', () => {
    const r = resolvePanoPlusBasis({
      capability: IOS, plan: OK_PLAN, basisIndex: null, basisLabel: null,
      gestureDeclined: true,
    });
    expect(r.route).toBe('blocked');
    expect(r.needsGesture).toBe(false);
    expect(r.reason).toBe('gesture-declined');
    expect(r.detail).toMatch(/not remembered/);
  });

  it('declining CANNOT suppress a stored basis — the store still wins', () => {
    const r = resolvePanoPlusBasis({
      capability: IOS, plan: OK_PLAN, basisIndex: 8, basisLabel: '+Y+Z+X',
      gestureDeclined: true,
    });
    expect(r.route).toBe('stored');
  });
});

describe('PROVENANCE — the word the pack is allowed to use', () => {
  it('a DERIVED basis is never labelled measured', () => {
    // The temptation is `measured`: the number is right and it came off the
    // device's own characteristics. It would also be false in the precise way
    // the attitude seam's whole tau section exists to prevent — it would
    // certify a calibration nobody ran.
    const r = resolvePanoPlusBasis({
      capability: ANDROID, plan: OK_PLAN, basisIndex: null, basisLabel: null,
    });
    expect(r.provenance).toBe('derived');
    expect(r.provenance).not.toBe('measured');
  });

  it('every route with no index at all says `none`', () => {
    const noIndex = [
      resolvePanoPlusBasis({ capability: IOS, plan: OK_PLAN, basisIndex: null, basisLabel: null }),
      resolvePanoPlusBasis({ capability: IOS, plan: null, basisIndex: null, basisLabel: null }),
      resolvePanoPlusBasis({
        capability: IOS,
        plan: { ok: false, reason: 'panoplus-no-ultrawide', detail: null },
        basisIndex: null, basisLabel: null,
      }),
    ];
    for (const r of noIndex) expect(r.provenance).toBe('none');
  });

  it('only the STORE route may claim `measured`', () => {
    const routes = (['stored', 'derived', 'gesture', 'blocked'] as const);
    const claimed = routes.filter((route) => {
      const r = route === 'stored'
        ? resolvePanoPlusBasis({ capability: IOS, plan: OK_PLAN, basisIndex: 3, basisLabel: 'x' })
        : route === 'derived'
          ? resolvePanoPlusBasis({ capability: ANDROID, plan: OK_PLAN, basisIndex: null, basisLabel: null })
          : route === 'gesture'
            ? resolvePanoPlusBasis({ capability: IOS, plan: OK_PLAN, basisIndex: null, basisLabel: null })
            : resolvePanoPlusBasis({ capability: IOS, plan: null, basisIndex: null, basisLabel: null });
      return r.provenance === 'measured';
    });
    expect(claimed).toEqual(['stored']);
  });
});
