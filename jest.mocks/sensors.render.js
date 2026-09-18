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

module.exports = {
  accelerometer: never,
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
