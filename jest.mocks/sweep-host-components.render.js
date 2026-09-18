// SPDX-License-Identifier: Apache-2.0
/**
 * The five components the sweep surface mounts — as an OBSERVATION SEAM for
 * the render project, not as a stand-in for the package.
 *
 * ⚠ READ THIS BEFORE EXTENDING IT.
 *
 * These components now live in the SAME package as the sweep surface that
 * mounts them; before the move they were an external dependency and mocking
 * the whole package was the obvious thing. It is no longer obvious, and this
 * file is a deliberate compromise with a shelf life:
 *
 *   · What it BUYS is 127 render assertions about the sweep's own HUD — the
 *     layer where both 2026-07-22 field bugs lived and where no pure test can
 *     reach. `__lastProps` hands the test the props the surface passed DOWN,
 *     so a case can drive `onArFrame` itself and read the HUD at each step.
 *   · What it COSTS is that those assertions no longer see the real
 *     `ARCameraView`/`CameraShutter`. A change to either that breaks the
 *     sweep will not be caught here.
 *
 * The right end state is tree assertions against the real components. That is
 * a rewrite of ten files and it is not a rider on a package move, so the seam
 * stays and this paragraph is the marker. Do not widen it: if a new test
 * needs a sixth component mocked, that is the signal to do the rewrite
 * instead.
 *
 * Mapped per MODULE PATH rather than by package name, so everything else in
 * the package stays real.
 *
 * The T2 surface mounts an `ARCameraView` and then does everything through its
 * PROPS — `onArFrame` is how AR poses arrive, and the imperative handle is how
 * a shutter takes a photo. A render test therefore does not need a camera; it
 * needs a component that (a) mounts without touching native and (b) hands the
 * test the props it was given, so the test can drive `onArFrame` itself.
 *
 * `__lastProps` is that hand-off. It is the whole reason this mock exists: with
 * it, a test can feed a sequence of AR frames — the operator walking the shelf —
 * and read what the HUD says at each step, which is precisely the layer both
 * 2026-07-22 field bugs lived in and no pure test could see.
 */

const React = require('react');

/** Props of the most recently rendered ARCameraView, for the test to drive. */
let lastProps = null;

const ARCameraView = React.forwardRef((props, ref) => {
  lastProps = props;
  // The surface calls `cameraRef.current.takePhoto(...)`. Hand it a handle the
  // test can stub per-case; the default REJECTS, so a test that accidentally
  // reaches the camera fails loudly instead of silently capturing nothing.
  React.useImperativeHandle(ref, () => ARCameraView.__handle, [
    ARCameraView.__handle,
  ]);
  return React.createElement('ARCameraView', { testID: 'ar-camera' }, props.children ?? null);
});
ARCameraView.displayName = 'ARCameraView';

/** Replaced per-test when a case needs the shutter to land a photo. */
ARCameraView.__handle = {
  takePhoto: () =>
    Promise.reject(new Error('ARCameraView.__handle.takePhoto not stubbed for this test')),
};

/**
 * The three guidance affordances the pano+ surface reuses verbatim from the
 * library. They render nothing a HUD assertion cares about, but they must EXIST
 * as components or the surface cannot mount at all — and a mock that made the
 * surface unmountable would quietly delete its render coverage. Each renders a
 * named host node so a test can still assert that the rotate prompt is (or is
 * not) offered.
 */
const RotateToLandscapePrompt = (props) =>
  props.visible
    ? React.createElement('RotateToLandscapePrompt', {
        testID: 'rotate-prompt',
        // Passed through so a test can assert WHICH rotation is being asked
        // for. pano+ now asks for PORTRAIT, and only from upside-down.
        target: props.target ?? 'landscape',
        copy: props.copy ?? '',
      })
    : null;
const PanHowToOverlay = (props) =>
  props.visible
    ? React.createElement('PanHowToOverlay', {
        testID: 'pan-howto',
        // The library picks the arrow direction from this (landscape → DOWN,
        // portrait → RIGHT). Passing it through is what lets a test prove the
        // pan guide points along the right axis in a portrait hold without
        // reaching into the public package's internals.
        orientation: props.orientation ?? 'portrait',
      })
    : null;

/**
 * Pano's SHUTTER — the one piece of Pano's chrome the stitcher exports, and the
 * one pano+ uses verbatim (2026-09-03 parity: hold starts the sweep, release
 * finishes it). The real component owns a 250 ms hold timer and three ring
 * colours; none of that is what a surface test needs to prove. What it needs
 * is the PROPS the surface handed it — `onHoldStart` / `onHoldComplete` /
 * `onTap` are how a test presses and releases, and `disabled` / `isProcessing`
 * / `holdEnabled` are what the surface's control state actually paints. So
 * this renders a named host node carrying every prop, like `ARCameraView`.
 */
const CameraShutter = React.forwardRef((props, ref) => {
  React.useImperativeHandle(ref, () => ({ cancelHold: () => undefined }), []);
  return React.createElement('CameraShutter', { testID: 'camera-shutter', ...props });
});
CameraShutter.displayName = 'CameraShutter';

/** Device orientation, overridable per-test: pano+'s idle state offers the
 *  rotate prompt in portrait and the coach mark in landscape, so a test needs
 *  to be able to say which hold the operator is in. */
let orientation = 'landscape-left';
const useDeviceOrientation = () => orientation;

// ⚠ EVERYTHING NOT NAMED BELOW IS THE REAL THING. The seam shadows the
// package barrel, so it re-exports the genuine module first and overrides
// exactly five components. Without this spread, mapping the barrel would
// silently blank every other export the sweep imports — `containFit`,
// `CameraLens`, the guidance tokens — and the failures would point at the
// wrong place.
const actual = jest.requireActual('../src/index');

module.exports = {
  ...actual,
  ARCameraView,
  CameraShutter,
  RotateToLandscapePrompt,
  PanHowToOverlay,
  useDeviceOrientation,
  /** Set the orientation `useDeviceOrientation` reports. */
  __setOrientation: (o) => {
    orientation = o;
  },
  /** The last props ARCameraView rendered with — `onArFrame`, `overlays`, … */
  __getLastProps: () => lastProps,
  __resetLastProps: () => {
    lastProps = null;
  },
};

