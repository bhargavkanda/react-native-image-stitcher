// SPDX-License-Identifier: Apache-2.0
/**
 * The sweep engine's orientation, for the RENDER project (M7).
 *
 * `useSweepEngine` imports `useDeviceOrientation` from its module directly —
 * it must not import the package barrel — while the render suites drive the
 * hold through the barrel seam (`sweep-host-components.render.js`,
 * `__setOrientation`). This forwards the direct import to the SAME seam, so
 * one `__setOrientation` still moves the hold the surface and its engine see.
 * Everything else is the real module.
 */
const seam = require('./sweep-host-components.render.js');
const actual = jest.requireActual('../src/camera/useDeviceOrientation');

module.exports = {
  ...actual,
  useDeviceOrientation: (...args) => seam.useDeviceOrientation(...args),
};
