# RNImageStitcherExample

Minimal React Native host app that demonstrates the `<Camera>`
component from the parent `react-native-image-stitcher` library.

## What it does

- Mounts `<Camera>` full-screen.
- Tap shutter → photo.
- Hold + pan + release → panorama.
- All callback props are wired to `Alert` / `console.log` so the
  event flow is visible on-device.

## Build + run

The example consumes the parent library via `file:..`.  Metro is
configured (in `metro.config.js`) to watch the parent dir, so edits
to `src/camera/Camera.tsx` upstream propagate without reinstalling.

```sh
# from this directory
npm install               # installs deps + symlinks parent SDK
cd ios && pod install     # iOS only
cd ..

# iPhone (with a device connected):
npx react-native run-ios

# Android (with an emulator or device):
npx react-native run-android
```

## SDK source resolution

- npm install creates a symlink at `node_modules/react-native-image-stitcher → ..`
- iOS: autolinking picks up `RNImageStitcher.podspec` at the parent
  package root; `pod install` runs the postinstall fetcher that
  downloads the OpenCV xcframework.
- Android: gradle autolinking picks up `android/` of the parent
  package; the OpenCV Android SDK is fetched via the npm postinstall.

## Notes

This is a development convenience — for production consumers,
`npm install react-native-image-stitcher` (no `file:` resolution
needed) is what they'd run.  Everything else stays identical.
