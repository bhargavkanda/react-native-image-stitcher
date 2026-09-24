// SPDX-License-Identifier: Apache-2.0
/**
 * `react-native-worklets-core` — render-project mock.
 *
 * Worklets are a native runtime. Off-device there is none, and the real
 * package's module-scope initializer reflects that. Nothing in the render
 * suite crosses into a worklet: the frame-processor fan-out is covered by
 * the pure-data tests that drive the registry directly.
 *
 * `useSharedValue` returns a plain mutable box that is STABLE ACROSS
 * RENDERS, as the real hook's is. It used to return a fresh box every render,
 * which made every worklet built over one (`useCallback(…, [shared])`) change
 * identity per render — invisible until a test asserted that the frame
 * processor handed to vision-camera keeps its identity (M3).
 */
const React = require('react');

module.exports = {
  useSharedValue: (initial) => {
    const ref = React.useRef(null);
    if (ref.current == null) ref.current = { value: initial };
    return ref.current;
  },
  Worklets: {
    createRunOnJS: (fn) => fn,
    createSharedValue: (initial) => ({ value: initial }),
    defaultContext: { runAsync: (fn) => fn() },
  },
};
