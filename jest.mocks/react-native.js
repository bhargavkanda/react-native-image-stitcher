// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal `react-native` mock used by Jest when a test reaches the
 * RN module via a transitive import.  We deliberately keep this tiny:
 * the library's tested code paths are pure TS and should never touch
 * RN.  When they do (e.g. NativeModules.BatchStitcher.physicalMemoryBytes
 * in the modal's _isLowMem check), the test should pass an explicit
 * value to the pure helper instead of relying on this mock — keeping
 * the test inputs explicit and the mock surface trivially small.
 *
 * Any future RN feature a test needs (Animated, StyleSheet, etc.)
 * goes here as an explicit `module.exports.<feature> = ...` add-on.
 */
module.exports = {
  NativeModules: {},
  Platform: { OS: 'ios', select: (spec) => spec.ios ?? spec.default },
};
