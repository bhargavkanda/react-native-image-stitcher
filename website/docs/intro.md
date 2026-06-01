---
id: intro
title: Overview
slug: /intro
sidebar_position: 1
---

# react-native-image-stitcher

**Pose-aware panorama capture + stitching for React Native (iOS + Android).**

One `<Camera>` component gives you both tap-to-photo and hold-to-pan
panorama modes, across two capture paths (AR-pose-driven and IMU
fallback), with a complete built-in capture UI — shutter, lens chooser,
flash, header, thumbnail history, and a post-stitch preview modal.

```tsx
import { Camera } from 'react-native-image-stitcher';

<Camera onCapture={(r) => console.log(r.type, r.uri)} />
```

## What it does

| Feature | Behaviour |
|---|---|
| **Tap shutter** | Single photo via vision-camera's `takePhoto` (non-AR) or ARCore/ARKit `capturedImage` (AR). |
| **Hold shutter** | Panorama — pan and release. Accumulates keyframes and stitches via `cv::Stitcher` (`PANORAMA`, or `SCANS` for flat-translation sweeps). |
| **Lens chip** | 1× / 0.5× toggle next to the shutter. Shown only when the device has a real, usable ultra-wide. |
| **Flash & AR pills** | Top-right pill stack. Flash toggles the torch; the AR pill switches AR ↔ non-AR. |
| **Capture history + preview** | Optional thumbnail strip and a post-stitch preview modal, both built in. |

## Highlights in v0.14

- **Portrait-first, on purpose.** Android self-locks `<Camera>` to
  portrait; iOS recommends a portrait host. Landscape is supported on
  iOS. See [Orientation](./orientation.md).
- **`captureSources` constraint** — restrict to `'ar'`, `'non-ar'`, or
  `'both'`; the AR toggle and lens chooser adapt automatically.
- **Real ultra-wide detection** — the 0.5× chooser appears only when the
  device actually has a usable ultra-wide, and flash works on 0.5× on
  multi-camera devices.

## Where to go next

- **[Getting started](./getting-started.md)** — install, peer deps, a
  full capture screen.
- **[Host app integration](./host-integration.md)** — the native config
  the host must do (read before your first run).
- **[`<Camera>` API](./camera-api.md)** — every prop, typed.
- **[Orientation](./orientation.md)** — the portrait recommendation and
  how each platform behaves.

> **Apache-2.0 licensed.** Uses a custom OpenCV build fetched at install
> time. See [Getting started](./getting-started.md) for details.
