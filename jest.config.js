// SPDX-License-Identifier: Apache-2.0
/**
 * Jest config for `react-native-image-stitcher` library tests.
 *
 * Scope: pure-TypeScript unit tests only — we don't mount React
 * components or exercise React Native modules in CI.  Tests cover
 * the data layer (PanoramaSettings bridge, buildPanoramaInitialSettings
 * helper) which is pure TS; the integration check is the on-device
 * run after every module merge per the project's Production-Grade
 * Mandate.
 *
 * Why no `preset: 'react-native'`?
 *   - The RN preset pulls in @react-native/babel-preset + jest-react-
 *     native + a metro module mapping, which we don't need for pure
 *     data-layer tests.  The fewer moving parts in test infra, the
 *     less likely tests rot.  If we ever add component-render tests
 *     (e.g. mounting <PanoramaSettingsModal>) we'd flip to the RN
 *     preset then.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.(ts|tsx)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  // Strip any accidental RN imports.  Pure-data tests should never
  // reach for `react-native`, but if a helper module pulls it in via
  // a transitive import we don't want a hard error.
  moduleNameMapper: {
    '^react-native$': '<rootDir>/jest.mocks/react-native.js',
    // Worklets-core needs its native JSI runtime; Camera.tsx's import
    // chain now evaluates module-scope worklets calls (exposureBurst
    // armed flag), so map it to a `.value`-shaped stub.
    '^react-native-worklets-core$':
      '<rootDir>/jest.mocks/react-native-worklets-core.js',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
        // `isolatedModules` is set inside tsconfig.test.json (which
        // inherits it from the root tsconfig.json), so ts-jest reads
        // it from the compiler-options block.  Putting it here too
        // emits a deprecation warning under ts-jest 29+.
      },
    ],
  },
};
