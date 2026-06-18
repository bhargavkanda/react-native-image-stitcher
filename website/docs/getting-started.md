---
id: getting-started
title: Getting started
sidebar_position: 2
---

# Getting started

Capture and stitch a panorama in three steps: install, drop in
`<Camera>`, and branch on the result. This page is the fastest path to a
working screen — the deeper guides are linked at the bottom.

## Install

```bash
npm install react-native-image-stitcher
# or
yarn add react-native-image-stitcher
```

A `postinstall` script fetches the matching custom OpenCV binaries
(`opencv2.xcframework` for iOS + per-ABI `.so` files for Android) from
the package's GitHub Releases — about 100 MB, downloaded once and cached.

### Peer dependencies

The host app provides these:

```jsonc
{
  "react": ">=18.0.0",
  "react-native": ">=0.72.0",
  "react-native-vision-camera": ">=4.7.0",
  "react-native-worklets-core": ">=1.3.0",
  "react-native-sensors": ">=7.0.0",
  "react-native-safe-area-context": ">=4.0.0"
}
```

:::caution Native setup is required
The host needs native configuration beyond `npm install` — Expo factory
classes, iOS `Info.plist` permission strings, and a couple of
`patch-package` patches. Walk through
**[Host app integration](./host-integration.md)** before your first run.
:::

## The shortest working example

Mount `<Camera>` and handle `onCapture`. It fires once per capture
attempt — gate on `result.ok` before reading the output.

```tsx
import { Camera, type CameraCaptureResult } from 'react-native-image-stitcher';

export function CaptureScreen() {
  return (
    <Camera
      onCapture={(result: CameraCaptureResult) => {
        if (!result.ok) {
          console.warn('capture failed:', result.error.code);
          return;
        }
        // result.type is 'photo' or 'panorama'; both carry uri/width/height.
        console.log(result.type, result.uri, result.width, result.height);
      }}
    />
  );
}
```

That's the whole API surface you need to get a capture on screen. Tap the
shutter for a photo; hold, pan, and release for a panorama.

:::note Camera permission is the host's job
The SDK never requests camera permission for you. Resolve it (e.g. with
vision-camera's `useCameraPermission`) before mounting `<Camera>`.
:::

:::tip Use portrait
`<Camera>` is designed for portrait capture. Android self-locks to
portrait; on iOS a portrait-only host is recommended. See
[Orientation](./orientation.md).
:::

## What next

- **[`<Camera>` API reference](./camera-api.md)** — every prop, typed,
  grouped, with defaults.
- **[Full example](./full-example.md)** — a complete, fully-loaded
  capture screen: permission, thumbnail history, preview modal, and
  output directory.
- **[Capture result & errors](./capture-result.md)** — the
  `CameraCaptureResult` union, warnings, and the `CameraError` taxonomy.
- **[Sharing OpenCV](./sharing-opencv.md)** — reuse the fetched OpenCV
  binaries with other native modules instead of bundling a second copy.
