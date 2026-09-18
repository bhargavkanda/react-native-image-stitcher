// SPDX-License-Identifier: Apache-2.0
/**
 * `react-native-worklets-core` — render-project mock.
 *
 * Worklets are a native runtime. Off-device there is none, and the real
 * package's module-scope initializer reflects that. Nothing in the render
 * suite crosses into a worklet: the frame-processor fan-out is covered by
 * the pure-data tests that drive the registry directly.
 *
 * `useSharedValue` returns a plain mutable box, which is enough for the
 * components that hold one across renders.
 */
module.exports = {
  useSharedValue: (initial) => ({ value: initial }),
  Worklets: {
    createRunOnJS: (fn) => fn,
    createSharedValue: (initial) => ({ value: initial }),
    defaultContext: { runAsync: (fn) => fn() },
  },
};
