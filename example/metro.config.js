const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro config for the example app.
 *
 * Two notable customisations vs the stock template:
 *
 *  1. `watchFolders` — Metro normally only watches files inside the
 *     project root (`example/`).  We add the parent SDK directory
 *     (`..`) so that when you edit `src/camera/Camera.tsx` upstream
 *     and Metro re-bundles, the change is picked up.  Without this,
 *     edits to the SDK appear stale to the example until you
 *     `npm install` again.
 *
 *  2. `resolver.extraNodeModules.react-native-image-stitcher` →
 *     points at the parent directory.  Combined with the
 *     `"react-native-image-stitcher": "file:.."` entry in
 *     `package.json`, ensures Metro resolves the import to the
 *     in-development source.
 */
const sdkRoot = path.resolve(__dirname, '..');

const config = {
  watchFolders: [sdkRoot],
  resolver: {
    extraNodeModules: {
      'react-native-image-stitcher': sdkRoot,
    },
    // Pin React + React Native to the example's own copy so the
    // sibling SDK doesn't pull in nested duplicates that confuse
    // RN's bridge (duplicate-TurboModule errors).
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
