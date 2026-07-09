// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal `react-native-worklets-core` stub for the pure-TS jest env
 * (same posture as react-native.js next door).  Tests never execute
 * worklets; this exists because importing `src/camera/Camera.tsx`
 * transitively evaluates MODULE-SCOPE worklets-core calls (e.g.
 * `exposureBurst.ts`'s `Worklets.createSharedValue(0)` armed flag),
 * and the real package needs its native JSI runtime installed.
 *
 * Shared values only need to be `.value`-shaped for data-layer tests.
 */
const makeSharedValue = (initial) => ({ value: initial });

module.exports = {
  Worklets: {
    createSharedValue: makeSharedValue,
    createRunOnJS: (fn) => fn,
  },
  useSharedValue: makeSharedValue,
};
