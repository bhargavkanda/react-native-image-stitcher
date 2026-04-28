/**
 * react-native.config.js — describe this SDK's native surface to RN
 * autolinking.  Without this file autolinking would look for a
 * podspec named `CaptureSdk.podspec` (the slug of the package name
 * `@retailens/capture-sdk`) and miss our actual file
 * `RetaiLensCaptureSDK.podspec` at the package root.
 *
 * Declaring the explicit paths here also lets autolinking find the
 * Android source directory once Phase 3 lands (currently absent —
 * the `android` block is included now so the iOS-Android shape is
 * symmetric and operators don't have to re-edit this file mid-work).
 */
const path = require('path');

module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: path.join(__dirname, 'RetaiLensCaptureSDK.podspec'),
      },
      android: {
        // Phase 3 adds Android native code.  The `sourceDir` points
        // at the conventional location the Gradle module will live
        // at; until that file ships, RN autolinking treats it as a
        // "no native code on this platform" signal and skips silently.
        sourceDir: path.join(__dirname, 'android'),
      },
    },
  },
};
