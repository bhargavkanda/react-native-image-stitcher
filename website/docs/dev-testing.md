---
id: dev-testing
title: Testing the AR frame processor
sidebar_label: AR frame processor
---

# Testing the AR frame processor

The `arFrameProcessor` prop runs a **worklet** once per AR camera frame,
alongside the library's own stitching. The worklet receives a
[`CameraFrame`](#the-cameraframe-shape) carrying world-space pose plus —
when you opt in — per-frame **depth**, **anchors** (detected planes /
images / a reconstructed mesh), and camera **intrinsics**.

This page is a copy-paste recipe for verifying those fields on a real
device, with the exact output to expect on each platform.

:::note Device only
AR capture needs ARKit (iOS) / ARCore (Android) and a real camera. None
of this runs on the iOS Simulator or an Android emulator. Depth and mesh
additionally need depth-capable hardware (iPhone Pro/Max LiDAR; an
[ARCore Depth API](https://developers.google.com/ar/devices)–supported
Android phone).
:::

## Opt-in flags

Every AR-metadata field is **off by default** — extracting depth/anchors/
mesh costs a per-frame copy, so you pay only for what you ask for. Turn
each on with a `<Camera>` prop:

| Prop | Adds to the frame | Cost |
| --- | --- | --- |
| `enableDepth` | `frame.arDepth` | per-frame depth-buffer copy |
| `enableAnchors` | `frame.arAnchors` (planes / images) | cheap (a few transforms) |
| `enableMesh` | `type: 'mesh'` entries in `arAnchors` (`meshGeometry`) | expensive — implies depth on Android |
| `planeDetection` | which plane orientations reach `arAnchors` | none (changes detection/filtering) |

`intrinsics` is always present on AR frames (it's six scalars — too cheap
to gate).

`planeDetection` accepts `'vertical'` (default), `'horizontal'`, or
`'both'`:

- **iOS** changes ARKit's `planeDetection` to match (a live session
  reconfigure).
- **Android** always detects both orientations (ARCore needs horizontal
  planes to bootstrap tracking) and **filters** which ones reach
  `arAnchors`, so the JS-observable set is identical on both platforms.

## The test worklet

`arFrameProcessor` must be a `'worklet'`. Because the underlying camera
buffer is only valid for the duration of the call, copy anything you want
to keep **inside** the worklet, and hop to the JS thread with `runOnJS`
to log or store results. Throttle your logging — this fires at ~60 Hz.

```tsx
import React from 'react';
import { StyleSheet } from 'react-native';
import { runOnJS } from 'react-native-worklets-core';
import { Camera, type CameraFrame } from 'react-native-image-stitcher';

export function ARProbe() {
  const lastLog = React.useRef(0);

  const report = React.useCallback((line: string) => {
    // eslint-disable-next-line no-console
    console.log('[ARProbe]', line);
  }, []);

  const arFrameProcessor = React.useCallback(
    (frame: CameraFrame) => {
      'worklet';
      if (frame.source !== 'ar') return; // vc frames carry no AR metadata

      // ~2 Hz throttle. frame.timestamp is nanoseconds.
      const nowMs = frame.timestamp / 1e6;
      // eslint-disable-next-line react-hooks/rules-of-hooks
      if (nowMs - lastLog.current < 500) return;
      lastLog.current = nowMs;

      const depth = frame.arDepth
        ? `${frame.arDepth.width}x${frame.arDepth.height}` +
          (frame.arDepth.confidenceMap ? '+conf' : '')
        : 'none';

      const planes = (frame.arAnchors ?? []).filter((a) => a.type === 'plane');
      const meshes = (frame.arAnchors ?? []).filter((a) => a.type === 'mesh');
      const alignments = planes.map((p) => p.alignment).join(',');
      const meshBytes = meshes.reduce(
        (n, m) => n + (m.meshGeometry?.vertices.byteLength ?? 0),
        0,
      );

      const k = frame.intrinsics;
      const intr = k
        ? `fx=${k.fx.toFixed(0)} ${k.imageWidth}x${k.imageHeight}`
        : 'none';

      runOnJS(report)(
        `track=${frame.arTrackingState} depth=${depth} ` +
          `planes=${planes.length}[${alignments}] ` +
          `mesh=${meshes.length}/${meshBytes}B intr=${intr}`,
      );
    },
    [report],
  );

  return (
    <Camera
      style={StyleSheet.absoluteFill}
      captureSource="ar"
      arFrameProcessor={arFrameProcessor}
      enableDepth
      enableAnchors
      enableMesh
      planeDetection="both"
    />
  );
}
```

## Expected output

Aim the device at a scene with a wall and a floor/table, move slowly for
2–3 s until tracking settles, then watch the log.

```
[ARProbe] track=normal depth=256x192+conf planes=2[vertical,horizontal] mesh=1/48240B intr=fx=1597 1920x1440
```

### What "good" looks like per field

- **`arTrackingState`** — `limited` for the first second or two, then
  `normal`. Anchors and a stable mesh only appear once it's `normal`.
- **`arDepth`** — on iOS LiDAR, `256x192+conf` (the `+conf` means a
  `confidenceMap` is present; values are `0`/`1`/`2`). On ARCore, roughly
  `160x120` and **no** `confidenceMap` (confidence is packed into the
  depth and dropped during normalisation — `confidenceMap` is
  `undefined`). The library normalises both platforms to **Float32 metres**
  in `depthMap`, so a worklet reads them identically.
- **`arAnchors` planes** — `alignment` is `'vertical'` or `'horizontal'`;
  `extent` is `[x, z]` in metres; `classification` (e.g. `'wall'`,
  `'floor'`) appears **on iOS** classification-capable devices once ARKit
  is confident, and is `undefined` on Android.
- **`mesh`** — non-zero `meshBytes` once meshing kicks in. On iOS this is
  ARKit's `ARMeshAnchor` geometry (and `meshGeometry.classifications` may
  be present); on Android it's a single anchor reconstructed from the
  depth map (camera-local vertices, identity transform, no
  classifications).
- **`intrinsics`** — `fx` typically ~1500–2000 px; `imageWidth` /
  `imageHeight` equal the AR capture resolution (commonly `1920x1440`).

### Reading the buffers

`arDepth.depthMap`, the `confidenceMap`, and `meshGeometry.*` are raw
`ArrayBuffer`s — wrap them in the right typed-array view:

```ts
const depthM = new Float32Array(frame.arDepth!.depthMap); // metres
const conf = frame.arDepth!.confidenceMap
  ? new Uint8Array(frame.arDepth!.confidenceMap) // 0=low,1=med,2=high
  : undefined;
const verts = new Float32Array(meshAnchor.meshGeometry!.vertices); // xyz…
const faces = new Uint32Array(meshAnchor.meshGeometry!.faces); // tri indices
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Worklet never fires | Not on a real device, or running under remote JS debugging (the native JSI install is unavailable — it fails silent, no crash). |
| `frame.arDepth` always `undefined` | `enableDepth` not set, or the device has no depth hardware. |
| `frame.arAnchors` empty but `enableAnchors` on | Tracking still `limited`; or you asked for `planeDetection="horizontal"` in a scene with only walls (and vice-versa). |
| Only vertical planes despite `planeDetection="both"` | The mode is applied when the session (re)starts/reconfigures — remount the camera or confirm the prop value actually changed. |
| `mesh=0` on Android | `enableMesh` reconstructs from depth — it needs `arDepth`, so the device must support the ARCore Depth API. |
| `classification` always `undefined` | Expected on Android (no equivalent) and on iOS devices/scenes where ARKit hasn't classified the plane yet. |

## The `CameraFrame` shape

See the [`CameraFrame` / `ARAnchor` types](https://github.com/bhargavkanda/react-native-image-stitcher/blob/main/src/stitching/CameraFrame.ts)
for the full, documented contract. The AR-only fields (`arDepth`,
`arAnchors`, `arTrackingState`, `intrinsics`) are always `undefined` when
`frame.source === 'vc'` (a non-AR vision-camera frame).
