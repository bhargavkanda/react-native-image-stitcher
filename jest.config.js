// SPDX-License-Identifier: Apache-2.0
/**
 * Jest config for `react-native-image-stitcher`.
 *
 * TWO PROJECTS, and the split is not cosmetic.
 *
 *   `pure`   — data-layer tests in a node environment against a 12-line
 *              `react-native` stub. Fast, no React, no renderer.
 *   `render` — component tests that MOUNT through react-test-renderer
 *              against a hand-written RN mock. They arrived with the sweep
 *              engine, whose HUD is where its defects have historically
 *              hidden.
 *
 * Why no `preset: 'react-native'` for either: the RN preset pulls in
 * @react-native/babel-preset, jest-react-native and a metro module mapping.
 * The render project needs 19 RN symbols, which a 141-line mock supplies
 * exactly and legibly; the preset supplies hundreds and a maintenance
 * surface. The fewer moving parts in test infra, the less likely tests rot.
 *
 * ⚠ THE `render` PROJECT MUST CLAIM ITS FILES, AND `pure` MUST DISCLAIM
 * THEM. Without the `testPathIgnorePatterns` below, every `.render.test.tsx`
 * would ALSO run under `pure` — against a react stub with no renderer — and
 * fail on the first hook, for a reason that has nothing to do with the test.
 */
/**
 * Trees jest must not walk.
 *
 * ⚠ `.claude/worktrees` HOLDS FULL CHECKOUTS OF THIS PACKAGE. Each carries
 * its own package.json with the same `name`, so jest's haste map finds three
 * packages claiming `react-native-image-stitcher` and refuses to resolve any
 * of them — reported as "Test suite failed to run", which takes every case
 * in the file with it.
 *
 * `example/` is a second app with its own node_modules (including a symlink
 * back to this package) and `archive/` holds retired source.
 */
const modulePathIgnorePatterns = [
  '<rootDir>/.claude/worktrees/',
  '<rootDir>/example/',
  '<rootDir>/archive/',
];

const transform = {
  '^.+\\.tsx?$': [
    'ts-jest',
    {
      tsconfig: 'tsconfig.test.json',
      // `isolatedModules` is set inside tsconfig.test.json (which inherits it
      // from the root tsconfig.json), so ts-jest reads it from the
      // compiler-options block. Putting it here too emits a deprecation
      // warning under ts-jest 29+.
    },
  ],
};

/** The pure-data suite: everything that does not mount. */
const pure = {
  displayName: 'pure',
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.(ts|tsx)'],
  testPathIgnorePatterns: ['/node_modules/', '\\.render\\.test\\.tsx?$'],
  modulePathIgnorePatterns,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  // Strip any accidental RN imports. Pure-data tests should never reach for
  // `react-native`, but if a helper module pulls it in via a transitive
  // import we don't want a hard error.
  moduleNameMapper: {
    '^react-native$': '<rootDir>/jest.mocks/react-native.js',
  },
  transform,
};

/** The render suite: mounts components, drives their props, reads the HUD. */
const render = {
  displayName: 'render',
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.render.test.(ts|tsx)'],
  testPathIgnorePatterns: ['/node_modules/'],
  modulePathIgnorePatterns,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  setupFiles: ['<rootDir>/jest.mocks/render-setup.js'],
  moduleNameMapper: {
    // A FULLER react-native than the pure project's: these tests mount real
    // components, so View/Text/Pressable/Animated/StyleSheet and friends all
    // have to exist and behave.
    '^react-native$': '<rootDir>/jest.mocks/react-native.render.js',
    '^react-native-safe-area-context$':
      '<rootDir>/jest.mocks/safe-area-context.render.js',
    // ⚠ NOT OPTIONAL. The real package throws `system/camera-module-not-found`
    // at MODULE SCOPE off-device, which fails the whole suite before a single
    // case runs. See the mock's header.
    '^react-native-vision-camera$':
      '<rootDir>/jest.mocks/vision-camera.render.js',
    // ⚠ ALSO NOT OPTIONAL: react-native-sensors ships untranspiled ESM, which
    // jest will not transform inside node_modules. See the mock's header.
    '^react-native-sensors$': '<rootDir>/jest.mocks/sensors.render.js',
    '^react-native-worklets-core$':
      '<rootDir>/jest.mocks/worklets-core.render.js',
    // M7 — the engine hook's direct import of the orientation hook, forwarded
    // to the orientation seam below (see the mock's header). Only
    // src/sweep/useSweepEngine.ts imports it by this relative path.
    '^\\.\\./camera/useDeviceOrientation$':
      '<rootDir>/jest.mocks/sweep-device-orientation.render.js',
    // ⚠ THE ORIENTATION SEAM. Shadows the bare package specifier for the
    // render project ONLY: the real barrel, plus a `useDeviceOrientation` a
    // test sets with `__setOrientation`. A render test reaches it through
    // `require('react-native-image-stitcher')`; no source file imports that
    // specifier. The relative barrel spellings (`../index`, `../../index`) are
    // NOT mapped: the sweep's own screen imported its components that way,
    // and M10 deleted it with the component stand-ins this seam used to carry.
    // Nothing in `src` imports the barrel relatively now, and a file that
    // did would get the real package.
    '^react-native-image-stitcher$':
      '<rootDir>/jest.mocks/sweep-host-components.render.js',
  },
  transform,
};

module.exports = { projects: [pure, render] };
