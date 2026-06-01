---
id: getting-started
title: Getting started
sidebar_position: 2
---

# Getting started

## Install

```bash
npm install react-native-image-stitcher
# or
yarn add react-native-image-stitcher
```

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

### OpenCV binaries (fetched on install)

A `postinstall` script downloads the matching custom OpenCV build
(`opencv2.xcframework` for iOS + per-ABI `.so` files for Android) from
the package's GitHub Releases — ~100 MB, fetched once and cached. Set
`SKIP_OPENCV_FETCH=1` to bypass (e.g. in CI where binaries are
pre-staged).

Then the standard native build:

```bash
cd ios && pod install
cd android && ./gradlew :app:assembleDebug
```

:::warning Read host integration first
The host needs extra native configuration beyond `pod install` /
`gradlew` — Expo factory classes in `AppDelegate`/`MainApplication`,
several `Info.plist` permission strings (iOS SIGABRTs without them), and
two `patch-package` patches for RN 0.84. See
**[Host app integration](./host-integration.md)** before your first run.
:::

## Minimal usage

```tsx
import { Camera, type CameraCaptureResult } from 'react-native-image-stitcher';

export function CaptureScreen() {
  return (
    <Camera
      onCapture={(r: CameraCaptureResult) =>
        console.log(r.type, r.uri, r.width, r.height)
      }
    />
  );
}
```

:::tip Use portrait
`<Camera>` is designed for portrait capture. Android self-locks to
portrait; on iOS, a portrait-only host is recommended. See
[Orientation](./orientation.md).
:::

## A complete capture screen

Requests permission up front, shows a capture-history strip, and opens a
post-stitch preview modal. The SDK does **not** request camera permission
for you — the host owns that.

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useCameraPermission } from 'react-native-vision-camera';
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
  type CaptureThumbnailItem,
} from 'react-native-image-stitcher';

export function CaptureScreen() {
  // 1. Resolve camera permission BEFORE mounting <Camera>.
  const { hasPermission, requestPermission } = useCameraPermission();
  useEffect(() => {
    if (!hasPermission) requestPermission().catch(() => undefined);
  }, [hasPermission, requestPermission]);

  // 2. Capture history → drives the built-in thumbnail strip.
  const [thumbnails, setThumbnails] = useState<CaptureThumbnailItem[]>([]);

  // 3. Post-stitch preview modal (controlled).
  const [preview, setPreview] = useState<CameraCaptureResult | null>(null);

  const onCapture = useCallback((result: CameraCaptureResult) => {
    setPreview(result);
    setThumbnails((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        uri: result.uri,
        width: result.width,
        height: result.height,
      },
    ]);
  }, []);

  if (!hasPermission) return <View style={styles.fill} />;

  return (
    <SafeAreaProvider>
      <View style={styles.fill}>
        <Camera
          defaultCaptureSource="ar"
          captureSources="both"
          enablePhotoMode
          enablePanoramaMode
          outputDir={`${/* your app dir */ ''}/captures`}
          headerTitle="Capture"
          headerGuidance="Tap for a photo. Hold + pan + release for a panorama."
          thumbnails={thumbnails}
          capturePreview={preview ? { imageUri: preview.uri } : undefined}
          onCapturePreviewClose={() => setPreview(null)}
          onCapture={onCapture}
          onError={(err: CameraError) => console.warn(err.code, err.message)}
          onCaptureAbandoned={(reason) => console.log('abandoned:', reason)}
        />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: '#000' } });
```

The [`example/`](https://github.com/bhargavkanda/react-native-image-stitcher/tree/main/example)
directory is the canonical reference host.
