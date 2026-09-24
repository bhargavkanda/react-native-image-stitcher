// SPDX-License-Identifier: Apache-2.0
/**
 * The package barrel for the RENDER project, with ONE override: the device
 * orientation, settable per test.
 *
 * M10 — this file used to stand in for the components the sweep's own screen
 * mounted (`ARCameraView`, `CameraShutter`, `RotateToLandscapePrompt`,
 * `PanHowToOverlay`), handing each test the props that screen passed down.
 * The screen is deleted and nothing in `src` imports the barrel any more
 * (`SweepHatchScreen` imports `../camera/ARCameraView` by module path), so
 * those overrides were reached by nothing and are gone with it. Every render
 * suite mounts the REAL components and finds them by TYPE.
 *
 * What is left is orientation. `useSweepEngine` imports `useDeviceOrientation`
 * from its module directly, and the render project forwards that import here
 * (`sweep-device-orientation.render.js`), so one `__setOrientation` says which
 * hold the operator is in. A test reaches it through
 * `require('react-native-image-stitcher')`, the one specifier still mapped to
 * this file.
 *
 * ⚠ DO NOT ADD A COMPONENT OVERRIDE BACK. A stand-in that renders instead of
 * the real component makes every absence assertion pass whatever the code
 * does, and a test that drives its props drives nothing the product runs.
 */

/** Device orientation, overridable per test: the engine's hold follows it. */
let orientation = 'landscape-left';
const useDeviceOrientation = () => orientation;

// ⚠ EVERYTHING NOT NAMED BELOW IS THE REAL THING. The seam shadows the bare
// package specifier, so it re-exports the genuine barrel first and overrides
// exactly one hook. Without this spread, a render test importing anything
// else from `react-native-image-stitcher` would get `undefined`, and the
// failure would point at the wrong place.
const actual = jest.requireActual('../src/index');

module.exports = {
  ...actual,
  useDeviceOrientation,
  /** Set the orientation `useDeviceOrientation` reports. */
  __setOrientation: (o) => {
    orientation = o;
  },
};
