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
 *
 * ⚠ THE SEAM IS REQUIRED AT CALL TIME, NOT AT LOAD (M8). Since `<Camera>`
 * mounts the sweep engine, loading the seam loads the real barrel, which loads
 * `<Camera>`, which loads the engine, which loads THIS file — a cycle. A
 * load-time `require` here receives the seam's half-built exports object, which
 * the seam then replaces wholesale, and every call fails "is not a function".
 */
const actual = jest.requireActual('../src/camera/useDeviceOrientation');

module.exports = {
  ...actual,
  useDeviceOrientation: (...args) =>
    require('./sweep-host-components.render.js').useDeviceOrientation(...args),
};
