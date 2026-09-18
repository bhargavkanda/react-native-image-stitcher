// SPDX-License-Identifier: Apache-2.0
//
// THE iOS ANSWER TO PANO'S `has0_5x`, AND THE PLANNER'S REQUEST ECHO.
//
// pano+ ⇄ Pano parity (2026-09-03): the lens switcher is Pano's own chip,
// which shows two pills only when a 0.5× exists.  On the decoupled iOS arm the
// only honest source for that fact is the SAME selector the sweep and the idle
// viewfinder open through (`RNISPanoAvfSource.planFormat`), asked once per
// lens.  These tests pin the shell over it: the two questions are asked with
// the flag's spellings, `ok` is the availability, a refusal keeps its native
// code, and the platforms where the question is not ours return `null`
// rather than "no 0.5×".

import { NativeModules, Platform } from 'react-native';
import {
  panoPlusLensAvailability,
  parsePlannedFormat,
} from '../panoPlusCalibration';

const NM = NativeModules as Record<string, unknown>;
const P = Platform as { OS: string };

/** What the fake planner was asked, in order. */
let asked: Array<Record<string, unknown>> = [];
/** Per-lens answers the fake planner gives. */
let answers: Record<string, unknown> = {};

function installCalib(withPlanner = true): void {
  asked = [];
  const mod: Record<string, unknown> = {
    startBasisCalibration: () => Promise.resolve({}),
    getCalibration: () => Promise.resolve({}),
  };
  if (withPlanner) {
    mod.plannedCaptureFormat = (o: Record<string, unknown>) => {
      asked.push(o);
      const lens = String(o.lens);
      const a = answers[lens];
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a);
    };
  }
  NM.RNISPanoCalib = mod;
}

const UW_OK = {
  ok: true,
  lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
  lensRequested: 'ultraWide',
  width: 1920, height: 1440, fps: 60,
  tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
  basisKey: 'iPhone17,1',
};
const WIDE_OK = {
  ok: true,
  lens: 'AVCaptureDeviceTypeBuiltInWideAngleCamera',
  lensRequested: 'wide',
  width: 1920, height: 1440, fps: 60,
  tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInWideAngleCamera|1920x1440|60',
  basisKey: 'iPhone17,1',
};

beforeEach(() => {
  P.OS = 'ios';
  answers = { ultraWide: UW_OK, wide: WIDE_OK };
  installCalib();
});
afterEach(() => {
  P.OS = 'ios';
  delete NM.RNISPanoCalib;
});

describe('parsePlannedFormat carries the request beside the answer', () => {
  it('reads lensRequested when native sends it', () => {
    const p = parsePlannedFormat(UW_OK);
    expect(p.ok).toBe(true);
    expect(p.lens).toBe('AVCaptureDeviceTypeBuiltInUltraWideCamera');
    expect(p.lensRequested).toBe('ultraWide');
  });

  it('is null on a build that predates it, never a guessed default', () => {
    // An older binary answers without the key. Filling in 'ultraWide' here
    // would be the hopeful default this whole arm refuses to make.
    const { lensRequested: _dropped, ...older } = UW_OK;
    void _dropped;
    expect(parsePlannedFormat(older).lensRequested).toBeNull();
    expect(parsePlannedFormat(null).lensRequested).toBeNull();
  });

  it('keeps the request on a refusal, where it matters most', () => {
    const p = parsePlannedFormat({
      ok: false,
      reason: 'panoplus-no-ultrawide',
      detail: 'This device publishes no builtInUltraWideCamera.',
      lens: null,
      lensRequested: 'ultraWide',
      width: null, height: null, fps: 60,
    });
    expect(p.ok).toBe(false);
    expect(p.reason).toBe('panoplus-no-ultrawide');
    expect(p.lensRequested).toBe('ultraWide');
    expect(p.lens).toBeNull();
  });
});

describe('panoPlusLensAvailability — the iOS has0_5x', () => {
  it('asks the planner once per lens, in the flag spelling, and reports both ok', async () => {
    const a = await panoPlusLensAvailability();
    expect(a).toEqual({
      ultraWide: true, wide: true, ultraWideReason: null, wideReason: null,
    });
    // THE SPELLING IS THE FLAG'S. The planner refuses '0.5x' / '1x' by design
    // (`panoplus-bad-lens`), so a chip label leaking through here would turn
    // a two-pill phone into a static 1× and nobody would know why.
    const lenses = asked.map((o) => o.lens).sort();
    expect(lenses).toEqual(['ultraWide', 'wide']);
  });

  it('a body with no physical ultra-wide is a static 1×, with the native code kept', async () => {
    answers.ultraWide = {
      ok: false,
      reason: 'panoplus-no-ultrawide',
      detail: 'This device publishes no builtInUltraWideCamera.',
      lens: null, lensRequested: 'ultraWide', width: null, height: null, fps: 60,
    };
    const a = await panoPlusLensAvailability();
    expect(a).toEqual({
      ultraWide: false, wide: true,
      ultraWideReason: 'panoplus-no-ultrawide', wideReason: null,
    });
  });

  it('a lens the planner would refuse for rate is NOT offered — a pill the sweep refuses lies', async () => {
    answers.wide = {
      ok: false,
      reason: 'panoplus-no-60fps-format',
      detail: 'This lens publishes no 4:3 format reaching 60 fps.',
      lens: null, lensRequested: 'wide', width: null, height: null, fps: 60,
    };
    const a = await panoPlusLensAvailability();
    expect(a?.wide).toBe(false);
    expect(a?.wideReason).toBe('panoplus-no-60fps-format');
    expect(a?.ultraWide).toBe(true);
  });

  it('a planner REJECTION is that lens being unavailable, never a thrown promise', async () => {
    answers.wide = new Error('bridge fell over');
    const a = await panoPlusLensAvailability();
    expect(a?.wide).toBe(false);
    expect(a?.wideReason).toBe('panoplus-io');
    expect(a?.ultraWide).toBe(true);
  });

  it('returns null on Android — the recorder resolves lenses there, not this module', async () => {
    P.OS = 'android';
    // The calibration module is not on Android at all; even if a stub were,
    // the question is not this module's to answer there.
    expect(await panoPlusLensAvailability()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('returns null, not "no 0.5×", on an iOS build without the calibration module', async () => {
    delete NM.RNISPanoCalib;
    expect(await panoPlusLensAvailability()).toBeNull();
  });

  it('returns null on an iOS build whose calibration module predates the planner', async () => {
    installCalib(false);
    expect(await panoPlusLensAvailability()).toBeNull();
  });
});
