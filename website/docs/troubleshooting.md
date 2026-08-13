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
`cv_flow_gate_process_frame` plugin never registered, so zero frames
ever reached the stitching engine. Photos are unaffected because
`takePhoto()` doesn't use frame processors.

There are **three** distinct ways the plugin fails to register, all with
this identical symptom and none of which produce a build error:

1. **Frame processors compiled out of vision-camera itself** — disabled
   at the time the native build ran, or vision-camera < 4.7.
2. **Header invisible on iOS under `use_frameworks!`** — the plugin's
   body is wrapped in
   `#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)`. Without a
   declared pod dependency that header is visible only in the default
   CocoaPods layout, where public headers are flattened into
   `Pods/Headers/Public`. Under `use_frameworks!` (static *or* dynamic)
   the guard evaluates false and the plugin compiles to an **empty
   translation unit**. **Fixed in v0.24.4** — the podspec now declares
   `VisionCamera` conditionally.
3. **Dead-stripped on iOS** — the plugin registers from `+ (void)load`
   and nothing references its class by symbol, so a static link is free
   to drop the object file: it compiles correctly and *still* never
   registers. **Fixed in v0.24.4** — the podspec now sets `-ObjC` on the
   consuming target. If you carry a custom xcconfig that overrides
   `OTHER_LDFLAGS` without `$(inherited)`, you will reintroduce this.

On **v0.24.3 and earlier** the usual workaround was a hand-written `sed`
patch on the podspec. Upgrade instead — the patch is no longer needed and
will conflict.

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
| **`'opencv2/core.hpp' file not found`** | The xcframework was never downloaded. See below. |
| **`building for iOS Simulator, but linking in object file built for iOS`** | You're on v0.7.1–v0.24.3, which shipped a device-only framework. Upgrade to v0.24.4+ (both slices are back), or build for a device. |
| **App won't launch at all on an emulator (Android)** | The AAR is `arm64-v8a` only. Use an arm64 AVD or a physical device — see [Android ABI support](./android-abi-support.md). v0.24.4+ degrades gracefully instead of crashing. |
| **`FatalException: Application manifest must contain meta-data com.google.ar.core`** | Add the ARCore `<meta-data>` to your app's manifest — see below. |
| **`Could not find method jcenter()`** (via `react-native-sensors`) | `react-native-sensors@7.3.6`'s `build.gradle` still calls the removed `jcenter()`. Patch it to `mavenCentral()` with `patch-package`, or pin a newer version. |

### `'opencv2/core.hpp' file not found`

The OpenCV xcframework is **not** in the npm tarball — `postinstall`
downloads it from the matching GitHub Release. When that download is
skipped or blocked, `pod install` used to succeed and the failure landed
hundreds of lines into the Xcode build with this message, which points
nowhere near the cause.

**v0.24.4+** fails fast: `pod install` itself raises, names the likely
cause, and gives you the fix. The causes are:

- `npm install --ignore-scripts` (common in locked-down CI, and the
  default for some monorepo tooling)
- a restored CI cache that predates the dependency
- a proxy or firewall blocking `objects.githubusercontent.com`
- `SKIP_OPENCV_FETCH=1` left set from an earlier experiment

Recover with any of:

```bash
# Re-run the fetch
npm rebuild react-native-image-stitcher   # or: npm install --force

# Point at an internal mirror
OPENCV_BINARY_BASE_URL=https://mirror.internal/rnis npm install

# Or: your app already ships OpenCV — don't download ours at all
RNIS_HOST_OPENCV=1 npm install
```

The last one is **[Bring your own OpenCV](./bring-your-own-opencv.md)**.

### Installing offline / in an air-gapped CI

Stage the binaries yourself and tell `postinstall` to stand down:

```bash
# On a machine with network access, from the matching release:
#   RNImageStitcher-v<version>-ios.zip     → node_modules/react-native-image-stitcher/ios/Frameworks/
#   RNImageStitcher-v<version>-android.zip → node_modules/react-native-image-stitcher/android/vendor/
SKIP_OPENCV_FETCH=1 npm ci
```

The version in the asset name **must** match the installed package
version exactly — the postinstall URL is derived from
`package.json.version`.

### ARCore meta-data (you must declare it)

This AAR pulls in `com.google.ar:core`, and ARCore throws
`FatalException: Application manifest must contain meta-data
com.google.ar.core` on its **first call** — before any availability
check, so there is nothing the SDK can do to defend against it at
runtime. Add it inside `<application>` in your app's manifest:

```xml
<application …>
    <meta-data android:name="com.google.ar.core" android:value="optional" />
</application>
```

Use `optional` unless your product is AR-only: `required` makes the Play
Store filter your app to AR-capable devices. The SDK degrades on its own
when ARCore is unavailable, falling back to the vision-camera +
gyroscope non-AR capture path.

:::note Why the SDK doesn't declare this for you
It could — manifest merging would propagate it automatically — but an
app that already declares the key with a *different* value would then
have its build stopped by the merger, needing a `tools:replace`. Shipping
a build break to integrators who already did the right thing is worse
than the one manifest line.
:::

Still stuck? Open an issue:
[github.com/bhargavkanda/react-native-image-stitcher/issues](https://github.com/bhargavkanda/react-native-image-stitcher/issues).
