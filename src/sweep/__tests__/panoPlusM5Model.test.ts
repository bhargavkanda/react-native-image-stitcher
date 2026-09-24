// SPDX-License-Identifier: Apache-2.0
// M5 — the pure pieces of the iOS vision-camera arm on the JS side.
import {
  PANO_PLUS_BASIS_CHECK,
  panoPlusBasisImageCheck,
  panoPlusFailureCopy,
  panoPlusIosVcHostArmNotice,
  panoPlusVcDeviceRefusalFailure,
} from '../panoPlusModel';

describe('panoPlusIosVcHostArmNotice — no calibration, no fallback', () => {
  it('the IMU arm on the host camera can start, runs τ = 0, and never falls back', () => {
    const n = panoPlusIosVcHostArmNotice('imu');
    expect(n.canStart).toBe(true);
    expect(n.effectivePoseSource).toBe('imu');
    expect(n.fallbackToAr).toBe(false);
    expect(n.tauUncorrectedRun).toBe(true);
    expect(n.packOnly).toBe(true);
  });
  it('the AR request stays on AR', () => {
    expect(panoPlusIosVcHostArmNotice('ar').effectivePoseSource).toBe('ar');
  });
});

describe('panoPlusVcDeviceRefusalFailure — every device refusal has a code', () => {
  it.each([
    ['mirrored-buffer', 'panoplus-vc-device-unsupported'],
    ['rotated-buffer', 'panoplus-vc-device-unsupported'],
    ['orientation-changed', 'panoplus-vc-device-unsupported'],
    ['zoom-not-1', 'panoplus-vc-zoom-not-1'],
    ['something-new', 'panoplus-vc-device-unsupported'],
  ])('%s → %s, with operator copy', (refusal, code) => {
    const f = panoPlusVcDeviceRefusalFailure(refusal);
    expect(f.code).toBe(code);
    expect(panoPlusFailureCopy({ code: f.code, message: f.message } as never).length).toBeGreaterThan(20);
  });
});

describe('panoPlusBasisImageCheck — D3, the image-side check', () => {
  const lat = (rot: [number, number], tot: [number, number]) => ({ rotationPx: rot, totalPx: tot });
  it('a rotation sweep whose prediction points where the image moved AGREES', () => {
    expect(panoPlusBasisImageCheck(lat([200, 10], [210, 5])).verdict).toBe('agrees');
  });
  it('a quarter-turned basis (prediction at 90° to the image) DISAGREES', () => {
    const c = panoPlusBasisImageCheck(lat([0, 200], [210, 0]));
    expect(c.verdict).toBe('disagrees');
    expect(c.cos).toBeCloseTo(0, 5);
  });
  it('a sign-flipped basis DISAGREES', () => {
    expect(panoPlusBasisImageCheck(lat([-200, 0], [200, 0])).verdict).toBe('disagrees');
  });
  it('too little image motion, or a walk rotation cannot explain, is NOT MEASURABLE', () => {
    expect(panoPlusBasisImageCheck(lat([10, 0], [PANO_PLUS_BASIS_CHECK.minTotalPx - 1, 0])).verdict)
      .toBe('not-measurable');
    expect(panoPlusBasisImageCheck(lat([20, 0], [400, 0])).verdict).toBe('not-measurable');
    expect(panoPlusBasisImageCheck(null).verdict).toBe('not-measurable');
  });
});
