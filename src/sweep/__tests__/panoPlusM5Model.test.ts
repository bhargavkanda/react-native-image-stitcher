// SPDX-License-Identifier: Apache-2.0
// M5 — the pure pieces of the iOS vision-camera arm on the JS side.
import {
  PANO_PLUS_BASIS_CHECK,
  panoPlusBasisImageCheck,
  panoPlusBasisTravelCheck,
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

  // ⚑ REAL LATCHES, not synthetic 200-px vectors: the latch freezes its
  // vectors at ~24 px, and a floor above that answered nothing (M5 review).
  // Rows from tools/d3-basis-proof/results.md and one device pack.
  it.each([
    ['PP4 15-51-02, device latch', [0.67, 23.94], [0.81, 24.35]],
    ['T14-225636, replay on #8', [4.3, -19.9], [5.4, -24.9]],
    ['PP6-225431, replay on #8', [-7.9, 25.3], [-5.8, 24.2]],
    ['T15-225457, replay on #8', [-9.1, 13.4], [-3.5, 24.5]],
  ] as const)('the true basis AGREES on a real latch — %s', (_n, rot, tot) => {
    expect(panoPlusBasisImageCheck(lat([...rot], [...tot])).verdict).toBe('agrees');
  });
  it.each([
    ['PP4 15-51-02, quarter-turned', [23.94, -0.67], [0.81, 24.35]],
    ['T14-225636, replay on #0', [19.9, 4.2], [5.3, -25.0]],
    ['T14-225636, replay on #9', [-4.2, 19.9], [5.3, -25.1]],
    ['PP6-225431, replay on #10', [-8.1, -26.5], [-5.8, 24.5]],
  ] as const)('⚑ NEGATIVE CONTROL: a wrong basis DISAGREES on the same real motion — %s', (_n, rot, tot) => {
    expect(panoPlusBasisImageCheck(lat([...rot], [...tot])).verdict).toBe('disagrees');
  });
  it('the floor sits below the latch trigger (24 px), or the check can never answer', () => {
    expect(PANO_PLUS_BASIS_CHECK.minTotalPx).toBeLessThan(24);
  });
});

describe('panoPlusBasisTravelCheck — D3, the sign of the rotation travel', () => {
  const reg = (rotTravelPx: number, resTravelPx: number) => ({ rotTravelPx, resTravelPx });
  it.each([
    ['T14-225004 #8', 475, 304],
    ['PP3-124737 #8', 919, 231],
    ['PP6-195035 #8 (relatched: the latch check reads nothing)', 560, -51],
  ] as const)('the true basis AGREES — %s', (_n, rot, res) => {
    expect(panoPlusBasisTravelCheck(reg(rot, res)).verdict).toBe('agrees');
  });
  it.each([
    ['T14-225004 #9', -475, 1254],
    ['PP3-124737 #10', -919, 2066],
    ['PP6-195035 #9 (relatched)', -560, 1072],
  ] as const)('⚑ NEGATIVE CONTROL: a sign-flipped basis DISAGREES — %s', (_n, rot, res) => {
    expect(panoPlusBasisTravelCheck(reg(rot, res)).verdict).toBe('disagrees');
  });
  it('a walk (rotation a small share of the travel) and a short sweep are NOT MEASURABLE', () => {
    expect(panoPlusBasisTravelCheck(reg(249, 1983)).verdict).toBe('not-measurable');   // T14-225636
    expect(panoPlusBasisTravelCheck(reg(-150, 1200)).verdict).toBe('not-measurable');  // counter-rotating walk
    expect(panoPlusBasisTravelCheck(reg(60, 20)).verdict).toBe('not-measurable');
    expect(panoPlusBasisTravelCheck(null).verdict).toBe('not-measurable');
  });
  it('is blind to a quarter turn by construction — the latch check owns that one', () => {
    expect(panoPlusBasisTravelCheck(reg(-60, 788)).verdict).toBe('not-measurable');   // T14-225004 #0
  });
});
