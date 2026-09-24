---
id: bring-your-own-opencv
title: Bring your own OpenCV (advanced)
sidebar_position: 9.6
---

# Bring your own OpenCV (advanced)

:::info Supported since v0.24.4
This was a design sketch through v0.24.3. It is now implemented on
**both platforms** — opt in with `$RNISHostOpenCV` (iOS) and
`rnisHostOpenCVSdkDir` (Android), documented below.
:::

An app must contain **exactly one** OpenCV. By default this SDK vendors
its own pinned, stitching-enabled build — the right choice for almost
every host. If your app *already* ships OpenCV, start with
**[Sharing OpenCV](./sharing-opencv.md)** (Option A): it deduplicates
the copies when both sides can agree on the SDK's pinned version.

This page is **Option B**, for the two cases Option A can't cover:

- **You need a different OpenCV version.** Your app is pinned to a newer
  (or older) OpenCV than the SDK's, and neither side can move.
- **You need a module this build excludes.** The SDK's build is trimmed
  for stitching — `dnn`, `ml`, `objdetect`, `gapi`, `videoio` and
  `highgui` are not in it. If your app links one of those, you'd carry
  *two* OpenCV binaries.

## The hard constraint: stitching must be in the build

There is one requirement you cannot negotiate away, and it's why
off-the-shelf OpenCV will **not** work:

:::caution Your OpenCV must be a custom build with `BUILD_opencv_stitching=ON`
This library is built on `cv::Stitcher`, and the stitching module is
absent from the stock mobile distributions:

- **iOS** — the stock CocoaPods `OpenCV` pod (and the `opencv-mobile`
  flow it descends from) **drops the stitching module.**
- **Android** — the stock Maven `org.opencv` artifacts ship a
  `libopencv_java4.so` without the `cv::Stitcher::create` symbols. The
  module is dropped from the *binary*, not merely from the Java
  bindings.

Both platforms now **check this at configure time** rather than letting
you discover it as a linker error an hour later. See
[Verifying your build](#verifying-your-build).
:::

The SDK's own binaries are built by
[`scripts/build-opencv-ios.sh`](https://github.com/bhargavkanda/react-native-image-stitcher/blob/main/scripts/build-opencv-ios.sh)
and
[`scripts/build-opencv-android.sh`](https://github.com/bhargavkanda/react-native-image-stitcher/blob/main/scripts/build-opencv-android.sh).
If you need to produce a stitching-enabled build of your own, those two
scripts are the reference — copy them and change the version pin.

## iOS

Two things to switch off the vendored framework: tell the **podspec** to
depend on your pod instead of vendoring, and tell the **npm postinstall**
to skip the ~27 MB download it no longer needs.

### 1. Podfile

```ruby
# ios/Podfile

# Consume the host app's OpenCV instead of the one this SDK vendors.
# MUST be set before `use_react_native!` / the target block, because
# RNImageStitcher.podspec reads it while CocoaPods evaluates specs.
$RNISHostOpenCV = true

# Optional — the name of YOUR OpenCV pod. Defaults to 'opencv2'.
$RNISHostOpenCVPod = 'opencv2'

target 'YourApp' do
  # …the standard RN target body…

  # Your stitching-enabled OpenCV, vendored once by the app:
  pod 'opencv2', :path => './vendor/opencv2'
end
```

The SDK's `OpenCV` subspec then declares `dependency $RNISHostOpenCVPod`
in place of `vendored_frameworks`, so CocoaPods links your framework and
puts its headers on the SDK's search path.

### 2. Skip the download

```bash
RNIS_HOST_OPENCV=1 npm install
cd ios && RNIS_HOST_OPENCV=1 pod install
```

`RNIS_HOST_OPENCV=1` is honoured in both places — the postinstall
script skips the fetch, and the podspec reads it as an alternative to
the `$RNISHostOpenCV` global (handy in CI, where the Podfile may be
generated).

:::tip Your pod must expose `opencv2/…` headers
The SDK's sources `#include <opencv2/stitching.hpp>` and friends. A pod
built from an `opencv2.xcframework` does this automatically. A pod that
installs headers under a different root will need a
`header_dir`/`HEADER_SEARCH_PATHS` adjustment on your side.
:::

## Android

One property points the Gradle module at your OpenCV Android SDK. Set it
on `rootProject.ext` (from `android/build.gradle`) or as a Gradle
property (`gradle.properties` / `-P`).

### Mode 1 — your SDK, packaged by us (simplest)

Use this when your app's OpenCV is a **SDK directory on disk** rather
than something already packaged into your APK. We build against your
copy and package it, so there is still exactly one OpenCV — yours.

```gradle
// android/build.gradle (host app)
ext {
    // The `sdk` directory: the one containing java/, native/libs/ and
    // native/jni/.
    rnisHostOpenCVSdkDir = "/abs/path/to/OpenCV-android-sdk/sdk"
}
```

or

```properties
# android/gradle.properties
rnisHostOpenCVSdkDir=/abs/path/to/OpenCV-android-sdk/sdk
```

This also skips the SDK's own ~90 MB Android download — pair it with
`SKIP_OPENCV_FETCH=1 npm install`.

### Mode 2 — you package OpenCV yourself

Use this when your own AAR / Gradle module **already puts** `org.opencv.*`
classes and `libopencv_java4.so` into the APK. Shipping a second copy is
a hard build failure (`Duplicate class org.opencv.core.Mat`, or the
jniLibs merge conflict on `lib/arm64-v8a/libopencv_java4.so`), so in this
mode we contribute **no** Java sources, **no** jniLibs and **no**
resources — we only compile against your dependency and link the JNI
shim against your headers.

```gradle
ext {
    rnisHostOpenCVSdkDir         = "/abs/path/to/OpenCV-android-sdk/sdk"
    rnisHostOpenCVPackagedByHost = true
    // Maven coordinate or project handle that puts org.opencv.* on the
    // compile classpath:
    rnisHostOpenCVDependency     = "com.yourco:opencv-stitching:4.10.0"
    // …or: rnisHostOpenCVDependency = project(':opencv')
}
```

`rnisHostOpenCVSdkDir` is still required here — CMake needs real headers
and a real `.so` to link `libimage_stitcher.so` against.

:::caution Both halves must come from the same build
The runtime OpenCV and the stitching archive must be the **same custom
build**: same version, same `__ndk1` (`c++_shared`) STL,
`BUILD_opencv_stitching=ON`, and arm64-v8a present. The SDK builds its
shim with `-DANDROID_STL=c++_shared`; your archive must be ABI-compatible
with that. Mixing a stock runtime `.so` with a stitching archive from
elsewhere is the fast path to a load-time crash.
:::

## Verifying your build

Both platforms fail **at configure time, with a message that names the
cause**, rather than at link time:

| What's wrong | Where you find out |
| --- | --- |
| Android SDK path doesn't exist | Gradle configure — names the path and what it should point at |
| No arm64-v8a `libopencv_stitching.a` | Gradle configure — "stock OpenCV Android releases are built WITHOUT the stitching module" |
| `rnisHostOpenCVPackagedByHost` without `rnisHostOpenCVDependency` | Gradle configure — explains why the classpath would be empty |
| iOS: vendored mode but the xcframework never downloaded | `pod install` raises, naming `--ignore-scripts` / CI cache / blocked download as causes |

To check a build yourself before wiring it in:

```bash
# Android — the stitching archive must exist for arm64-v8a
ls /path/to/OpenCV-android-sdk/sdk/native/staticlibs/arm64-v8a/libopencv_stitching.a

# iOS — the framework must export cv::Stitcher
nm -gU /path/to/opencv2.xcframework/ios-arm64/opencv2.framework/opencv2 \
  | grep -c 'Stitcher.*create'   # expect > 0
```

## Going back

Unset the flags and reinstall — the SDK returns to its vendored build:

```bash
npm install --force        # re-runs postinstall, re-downloads the binaries
cd ios && pod install
```

## See also

- **[Sharing OpenCV](./sharing-opencv.md)** — Option A: deduplicate the
  SDK's pinned OpenCV when your app uses the *same* version. Start here.
- **[Getting started](./getting-started.md)** — how the OpenCV binaries
  are fetched on install (and the `SKIP_OPENCV_FETCH=1` escape hatch).
- **[Host app integration](./host-integration.md)** — the full native
  setup, including the `framework not found 'opencv2'` recovery.
- **[Troubleshooting](./troubleshooting.md)** — `'opencv2/core.hpp' file
  not found` and the other install-time failures.
