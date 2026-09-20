// SPDX-License-Identifier: Apache-2.0
/**
 * `react-native-sensors` — render-project mock.
 *
 * ⚠ THE REAL PACKAGE SHIPS UNTRANSPILED ESM (`node_modules/
 * react-native-sensors/index.js` starts with a bare `import`), and jest does
 * not transform node_modules by default. The result is "Jest encountered an
 * unexpected token" — a TEST SUITE FAILED TO RUN, which takes every case in
 * the file with it and says nothing about the code.
 *
 * Widening `transformIgnorePatterns` to transpile it would work and is the
 * usual advice; this is cheaper and more honest. Nothing under test here
 * reads a sensor: the components subscribe at mount and unsubscribe at
 * unmount, and what the render tests assert is the SUBSCRIPTION LIFECYCLE and
 * the HUD, not sample values.
 *
 * So each observable is a subscribable that never emits. `unsubscribe` is a
 * real jest-visible call, because "did it unsubscribe on unmount" is exactly
 * the kind of leak these tests exist to catch.
 */
const never = {
  subscribe: () => ({ unsubscribe: () => undefined }),
  pipe: () => never,
};

/**
 * THE ACCELEROMETER IS DRIVABLE, because two guard rails hang off it.
 *
 * `useDeviceOrientation` subscribes here, and `useOrientationDrift` is built
 * on that — the mid-capture rotation guard. A `never` stream means no test
 * can make the phone turn, so the guard is unfalsifiable by construction,
 * which is how it came to be silently dead on the sweep engine.
 *
 * `__emitAccelerometer({x, y, z})` pushes one sample to every live
 * subscriber. `__resetAccelerometer()` drops them between cases.
 */
const accelSubs = new Set();
const accelerometer = {
  subscribe: (fn) => {
    const cb = typeof fn === 'function' ? fn : (fn && fn.next);
    if (cb) accelSubs.add(cb);
    return { unsubscribe: () => { if (cb) accelSubs.delete(cb); } };
  },
  pipe: () => accelerometer,
};

module.exports = {
  accelerometer,
  __emitAccelerometer: (s) => { accelSubs.forEach((f) => f(s)); },
  __resetAccelerometer: () => { accelSubs.clear(); },
  gyroscope: never,
  magnetometer: never,
  barometer: never,
  orientation: never,
  setUpdateIntervalForType: () => undefined,
  SensorTypes: {
    accelerometer: 'accelerometer',
    gyroscope: 'gyroscope',
    magnetometer: 'magnetometer',
    barometer: 'barometer',
    orientation: 'orientation',
  },
};
