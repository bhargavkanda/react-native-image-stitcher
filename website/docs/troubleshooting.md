---
id: troubleshooting
title: Troubleshooting
sidebar_position: 10
---

# Troubleshooting

Common runtime symptoms and their causes. For first-run native setup
issues, see [Host app integration](./host-integration.md), which has a
fuller table mapping crashes to missing config.

## Camera / capture

| Symptom | Likely cause / fix |
|---|---|
| **App SIGABRTs on launch (iOS)** | Missing `Info.plist` permission strings (`NSCameraUsageDescription` etc.). See [Host integration → Info.plist](./host-integration.md). |
| **Black camera preview** | AR session never started (no Activity / ARCore install in progress / device unsupported), or permission not granted before mount. Resolve permission first. |
| **`flash-not-available` error** | You forced flash on a device with no torch on the active lens. `<Camera>` normally hides the flash pill in this case — only happens if you drive `flash` controlled. See [Flash & lenses](./flash-and-lenses.md). |
| **0.5× shows the same FOV as 1×** | The device has no usable ultra-wide, or (pre-0.14) the single-lens picker mis-selected. v0.14's capability-aware selection fixes this; the chooser hides when no ultra-wide exists. |
| **AR photo is sideways in landscape** | Pre-0.14 Android bug (window-rotation vs device-orientation). Fixed in 0.14. |

## "0 keyframes saved" — panorama captures zero frames, photos work

**Symptom:** the hold-to-pan capture UI runs normally, but the band
overlay's first thumbnail never fills; on release every attempt fails
with `PANORAMA_FINALIZE_FAILED — Batch-keyframe finalize: 0 keyframes
saved`. Single-photo capture works. 100 % reproducible.

**Cause:** the capture ran in **non-AR mode** and the vision-camera
frame-processor chain that feeds it is dead in your build — the SDK's
`cv_flow_gate_process_frame` plugin was compiled out (frame processors
disabled when the native build ran, vision-camera < 4.7, or on iOS a
`use_frameworks!` header-visibility issue), so zero frames ever reached
the stitching engine. Photos are unaffected because `takePhoto()`
doesn't use frame processors.

**Fix:** work through the
[frame-processor checklist](./host-integration.md#frame-processors--the-non-ar-capture-prerequisite),
then rebuild (iOS: re-run `pod install`; Android: clean Gradle build).
On v0.24.3+ the SDK diagnoses
this itself: a `console.error` (immediately if vision-camera reports
frame processors disabled, else ~3 s after mount) with platform-specific
remediation, plus a fail-fast `PANORAMA_START_FAILED` at capture start
instead of the misleading 0-keyframes error at the end.  Opting into AR
capture (`defaultCaptureSource="ar"`) sidesteps this failure class
entirely — see the caveats in the [`<Camera>` API](./camera-api.md). Also check you're not passing a custom
`frameProcessor` prop without composing `stitcher.call(frame)` — same
symptom, different cause.

## Stitching

| `err.code` | Meaning / fix |
|---|---|
| `STITCH_NEED_MORE_IMGS` | Too few keyframes — pan further / slower. |
| `STITCH_HOMOGRAPHY_FAIL` | Low overlap or texture — pan with more overlap, avoid blank walls. |
| `STITCH_CAMERA_PARAMS_FAIL` | cv::Stitcher couldn't estimate intrinsics — usually same fix as above. |
| `STITCH_OOM` | Out of memory — shorter pan / fewer keyframes (`defaultKeyframeMaxCount`). |
| `OUTPUT_WRITE_FAILED` | `outputDir` not writable / missing — the lib creates it, but check permissions. |

The four `STITCH_*` codes are recoverable by re-capturing. To show the user
friendly, action-guiding copy ("pan more slowly", "pivot in place") instead of
the raw `cv::Stitcher` diagnostic, pass `err.code` to the SDK's
[`userFacingStitchError`](./capture-result.md#friendly-copy-for-recoverable-failures--userfacingstitcherror)
helper in your `onError` handler. Wide / 0.5× ultra-wide panoramas that used to
fail with `STITCH_CAMERA_PARAMS_FAIL` now auto-retry with a cylindrical warp and
usually complete (v0.15).

## Orientation

| Symptom | Cause / fix |
|---|---|
| **Capture cancels when I rotate mid-pan** | Expected — the engine can't mix orientations. Don't rotate during a capture. See [Orientation](./orientation.md). |
| **iOS preview sideways/squished in landscape** | A portrait-locked host held landscape with a stale vision-camera patch. Use pristine vision-camera; prefer portrait. (Resolved for the example as of 0.14.) |
| **Android UI rotates when I don't want it to** | It shouldn't — `<Camera>` self-locks to portrait on Android. If the rest of your app rotates, that's your host config; `<Camera>` restores the prior orientation on unmount. |

## Build / install

| Symptom | Fix |
|---|---|
| **OpenCV binaries missing** | The `postinstall` fetch failed. Re-run `npm install`, or stage binaries and set `SKIP_OPENCV_FETCH=1`. |
| **RN 0.84 build errors** | Apply the required `patch-package` patches — see [Host integration](./host-integration.md). |

Still stuck? Open an issue:
[github.com/bhargavkanda/react-native-image-stitcher/issues](https://github.com/bhargavkanda/react-native-image-stitcher/issues).
