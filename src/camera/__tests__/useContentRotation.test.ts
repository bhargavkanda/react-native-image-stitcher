// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `contentRotationDeg` — the pure rotation computation
 * behind `useContentRotation`, which keeps control content (AR toggle,
 * lens/zoom pill, flash, thumbnails) upright relative to gravity
 * regardless of host portrait-lock state.
 *
 * Covers the full truth table from the hook's docstring plus the
 * mid-rotation transients (jsLandscape=true with a non-landscape device
 * reading, which can briefly happen while the OS catches up).
 *
 * Pure-TS test per jest.config.js.  `useContentRotation` transitively
 * imports `useDeviceOrientation` → `react-native-sensors` (an ES module
 * the no-RN-preset jest infra can't parse), so stub it before importing
 * the SUT.  We only call the pure `contentRotationDeg` export.
 */

jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: 'accelerometer', gyroscope: 'gyroscope' },
}));

import { contentRotationDeg } from '../useContentRotation';

describe('contentRotationDeg', () => {
  // Locked-portrait host: jsLandscape is ALWAYS false (window dims stay
  // portrait regardless of device tilt).  The OS doesn't rotate the
  // framebuffer, so content rotation must match device-physical for
  // labels to read upright.  THIS is the case task #5b targets.

  it('locked-portrait + device-portrait → 0° (no-op)', () => {
    expect(contentRotationDeg(false, 'portrait')).toBe(0);
  });

  it('locked-portrait + device-landscape-left → 90° (CW)', () => {
    expect(contentRotationDeg(false, 'landscape-left')).toBe(90);
  });

  it('locked-portrait + device-landscape-right → -90° (CCW)', () => {
    expect(contentRotationDeg(false, 'landscape-right')).toBe(-90);
  });

  it('locked-portrait + device-upside-down → 180°', () => {
    expect(contentRotationDeg(false, 'portrait-upside-down')).toBe(180);
  });

  // Non-locked host + device-landscape: OS rotated the framebuffer for
  // us; we must NOT double-rotate.  Net rotation must be 0.

  it('non-locked + device-landscape-left (jsLandscape=true) → 0°', () => {
    expect(contentRotationDeg(true, 'landscape-left')).toBe(0);
  });

  it('non-locked + device-landscape-right (jsLandscape=true) → 0°', () => {
    expect(contentRotationDeg(true, 'landscape-right')).toBe(0);
  });

  it('non-locked + device-portrait (jsLandscape=false) → 0°', () => {
    expect(contentRotationDeg(false, 'portrait')).toBe(0);
  });

  // Mid-rotation transients: jsLandscape=true with a non-landscape
  // device reading.  Falls through to 0 framebuffer rotation and
  // applies device rotation directly; settles once the transient clears.

  it('jsLandscape=true mid-rotation with device-portrait → 0°', () => {
    expect(contentRotationDeg(true, 'portrait')).toBe(0);
  });

  it('jsLandscape=true mid-rotation with device-upside-down → 180°', () => {
    expect(contentRotationDeg(true, 'portrait-upside-down')).toBe(180);
  });

  it('all returned values are in {0, 90, -90, 180} (no off-by-360°)', () => {
    const orientations = [
      'portrait',
      'portrait-upside-down',
      'landscape-left',
      'landscape-right',
    ] as const;
    for (const o of orientations) {
      for (const jsl of [true, false]) {
        expect([0, 90, -90, 180]).toContain(contentRotationDeg(jsl, o));
      }
    }
  });
});
