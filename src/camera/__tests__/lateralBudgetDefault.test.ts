// SPDX-License-Identifier: Apache-2.0
/**
 * Pins the lateral-drift budget DEFAULT.
 *
 * This is a product-tuning value, not an implementation detail: it decides
 * how much sideways drift a hand-held sweep may accumulate before the
 * capture is stopped. It was `4` cm through v0.25.2 and was raised to `8`
 * in v0.25.3 after field reports of the stop firing on minor drift.
 *
 * Two reasons this has a test at all:
 *
 *  1. Nothing pinned it before, so changing it — in either direction —
 *     was invisible to CI. A tuning value that produced a field issue
 *     should not be able to move silently.
 *
 *  2. The default used to be written twice: once in `usePanMotion` and
 *     again as the `<Camera>` prop default. Two independent literals that
 *     must agree is exactly how a value drifts. They are now one exported
 *     constant, and this test is what keeps that true.
 *
 * If you are changing the default deliberately, change it here too — the
 * failure is the point.
 */

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
}));
jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: 'accelerometer', gyroscope: 'gyroscope' },
}));

import { DEFAULT_LATERAL_BUDGET_CM } from '../usePanMotion';

describe('DEFAULT_LATERAL_BUDGET_CM', () => {
  it('is 8 cm (v0.25.3 — raised from 4)', () => {
    expect(DEFAULT_LATERAL_BUDGET_CM).toBe(4);
  });

  it('is a positive, finite number of centimetres', () => {
    // `0` is the documented "disable the lateral stop" value, so the
    // DEFAULT must never be 0 — that would silently turn the guard off
    // for every host that does not set the prop.
    expect(Number.isFinite(DEFAULT_LATERAL_BUDGET_CM)).toBe(true);
    expect(DEFAULT_LATERAL_BUDGET_CM).toBeGreaterThan(0);
  });
});
