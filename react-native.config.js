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
        // RELATIVE path on purpose.  RN's autolinking computes
        // `path.join(root, sourceDir)` where `root` is the package
        // root in node_modules (a symlink in our case).  An ABSOLUTE
        // sourceDir gets concatenated by path.join rather than
        // treated as already-resolved, producing a broken double
        // path and silently failing detection.  Relative `'android'`
        // joins cleanly and resolves through the symlink to the
        // real Android module folder.
        sourceDir: 'android',
      },
    },
  },
};
