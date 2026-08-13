---
id: android-abi-support
title: Android ABI support (arm64-v8a only)
sidebar_position: 9.7
---

# Android ABI support

**This SDK ships `arm64-v8a` only.**

Its OpenCV is a custom build compiled with `BUILD_opencv_stitching=ON`
(stock OpenCV drops the stitching module — see
**[Bring your own OpenCV](./bring-your-own-opencv.md)**), and that build
exists for `arm64-v8a` alone. `armeabi-v7a`, `x86` and `x86_64` are not
in the AAR.

For shipping apps this is a non-issue: every Android device Google has
allowed to launch with Play Services since 2021 is arm64, and 32-bit-only
devices can't run 64-bit-only apps regardless. Where it *does* bite is
**development**, and specifically **emulators**.

## Emulators

| Host machine | Recommended AVD image | Works? |
| --- | --- | --- |
| Apple Silicon Mac | `arm64-v8a` system image (the default offered) | ✅ |
| Intel Mac / Windows / Linux | `x86_64` system image | ❌ |
| Any | Physical arm64 device over USB | ✅ |

On Apple Silicon, Android Studio offers arm64-v8a images by default, so
most Mac developers never notice. On an Intel host there is no arm64
emulator worth using — develop against a physical device.

## What it looks like when the ABI is wrong

**Since v0.24.4** the app **still launches**, panorama features are
disabled, and logcat carries one loud message:

```
E RNImageStitcher: react-native-image-stitcher: native library
  'image_stitcher' could not be loaded. Panorama capture, keyframe
  gating and stitching are unavailable; the rest of the app is
  unaffected.
    Device ABIs: x86_64, arm64-v8a
    This SDK ships arm64-v8a ONLY …
```

Filter for it with:

```bash
adb logcat -s RNImageStitcher
```

**Before v0.24.4** the same situation was far worse: seven classes
called `System.loadLibrary` from a **static initialiser**, and four of
those are constructed eagerly by the SDK's `ReactPackage` during bridge
startup. A throwing static initialiser becomes an
`ExceptionInInitializerError` that propagates out of
`createNativeModules()`, so the **entire host app failed to launch** —
on every screen, not just the camera — with a stack trace that named
neither ABIs nor OpenCV. If you are debugging an unexplained startup
crash on an older version, upgrade first; the error message will tell
you what it actually is.

## Check what your build produced

```bash
# ABIs present in an APK
unzip -l app-debug.apk | grep 'lib/'

# ABIs the connected device supports
adb shell getprop ro.product.cpu.abilist
```

If `lib/` has no `arm64-v8a/libimage_stitcher.so`, the native build was
filtered out — check your app module's `ndk { abiFilters … }` and any
`splits { abi { … } }` block.

## Adding another ABI

You need an OpenCV Android SDK for that ABI, built with
`BUILD_opencv_stitching=ON`, and then to point this SDK at it:

```properties
# android/gradle.properties
rnisHostOpenCVSdkDir=/abs/path/to/your/OpenCV-android-sdk/sdk
```

See **[Bring your own OpenCV](./bring-your-own-opencv.md)** for the full
flow, and
[`scripts/build-opencv-android.sh`](https://github.com/bhargavkanda/react-native-image-stitcher/blob/main/scripts/build-opencv-android.sh)
for the reference build (it drives OpenCV's own CMake with the flags this
SDK needs, including the 16 KB page-size alignment Android 15 requires).

Note that the SDK's own `android/build.gradle` also pins
`abiFilters 'arm64-v8a'`; a build with more ABIs needs that widened to
match what your OpenCV provides.

## iOS, for contrast

The iOS framework ships **both** the device (`arm64`) and simulator
(`arm64`) slices as of v0.24.4, so host apps build and run in the iOS
Simulator normally on Apple Silicon. The x86_64 simulator slice (Intel
Macs) is not built — OpenCV's builder cannot configure it on an arm64
machine, and an Intel Mac cannot run an arm64 iOS simulator anyway. (v0.7.1–v0.24.3 stripped the simulator slice
to save ~17 MB, which broke simulator builds of the entire host app with
`building for iOS Simulator, but linking in object file built for iOS`.
That trade has been reversed.)

## See also

- **[Troubleshooting](./troubleshooting.md)** — install and build failures.
- **[Host app integration](./host-integration.md)** — the full native setup.
- **[Bring your own OpenCV](./bring-your-own-opencv.md)** — supplying your
  own build, including for additional ABIs.
