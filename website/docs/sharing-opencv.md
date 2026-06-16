---
id: sharing-opencv
title: Sharing OpenCV with your app
sidebar_position: 9.5
---

# Sharing OpenCV with your app

This library ships its own OpenCV. If your app *also* needs OpenCV —
for your own native image processing, computer-vision code, or the
`org.opencv.*` Java API — you usually don't need to add a second copy.
This page covers **Option A: reuse this library's OpenCV as your app's
single OpenCV provider.**

:::caution The golden rule: exactly one OpenCV per app
An app must contain **exactly one OpenCV (one version)**. Two copies
means a bigger binary **and** symbol collisions — duplicate C++ symbols
violate the One Definition Rule (ODR) and produce undefined behaviour at
best, a duplicate-symbol **link error** at worst. The whole point of
Option A is to keep that count at one.
:::

## What this library bundles

The library does **not** vendor stock OpenCV. It ships a **custom OpenCV
4.10.0 build** containing exactly this module set:

- `core`
- `imgproc`
- `imgcodecs`
- `features2d`
- `calib3d`
- `flann`
- `stitching`
- `video`
- `videoio`
- `photo`

The headline difference from a stock OpenCV: the **`stitching`** module
is included. Stock prebuilt OpenCV packages typically omit `stitching`,
which is exactly what panorama stitching needs.

:::note This build is pinned
The build is locked to **OpenCV 4.10.0** and **this module set**. There
is no `dnn`, `ml`, `objdetect`, or `gapi`. If your app needs any of
those, Option A can't cover them — see
[the alternative](#when-option-a-cant-fit) at the bottom.
:::

## iOS — reuse the vendored `opencv2.xcframework`

On iOS the build is vendored as a **separate static framework** with the
full C++ API exposed through a `module.modulemap`:

```
node_modules/react-native-image-stitcher/ios/Frameworks/opencv2.xcframework
```

Because it's a real framework with a module map, your host native code
can import the umbrella header directly:

```objc
#import <opencv2/opencv2.h>
```

The OpenCV symbols are **already linked into your app binary** by the
library's pod — you do not link anything extra. To compile your own
`.mm` / `.cpp` against the C++ API, point your target at the framework's
`Headers`:

1. Open your app target's **Build Settings**.
2. Add the framework's `Headers` directory to **`HEADER_SEARCH_PATHS`**,
   for example:

```bash
node_modules/react-native-image-stitcher/ios/Frameworks/opencv2.xcframework/ios-arm64/opencv2.framework/Headers
```

That's the entire setup: search path for headers, and the symbols come
for free from the framework that's already in the binary.

:::caution Do not add a second OpenCV pod
Do **not** add another OpenCV pod (e.g. `OpenCV`, `OpenCV2`, or a custom
OpenCV podspec) to your `Podfile`. A second pod brings its own static
archives — and two static OpenCV archives in one binary produce a
**duplicate-symbol link error**. Reuse the vendored framework instead.
:::

## Android — reuse `libopencv_java4.so`

On Android the build ships as the fat shared library
**`libopencv_java4.so`** inside the AAR's `jniLibs`. That `.so` is
reusable by your host NDK code, and the `org.opencv.*` Java API is
already on your classpath.

### From native (NDK) code

Link against the shared library and add its headers. The headers live
under the vendored SDK:

```
android/vendor/OpenCV-android-sdk/sdk/native/jni/include
```

Add that as an include directory in your `CMakeLists.txt`, and link the
already-present `libopencv_java4.so` rather than bringing your own.

### From Java / Kotlin

Nothing to do — the `org.opencv.*` classes are on the classpath through
the AAR.

:::caution The `stitching` module is the one exception
`libopencv_java4.so` does **not** contain the `stitching` module. The
stitching code is **whole-archive static-linked** into the library's own
`libimage_stitcher.so`, not into the shared `libopencv_java4.so`. So on
Android, reuse covers **everything except stitching** — for stitching
you go through this library's `<Camera>` / engine, not through a raw
OpenCV call against the shared `.so`.
:::

:::caution Do not add a second OpenCV dependency
Two same-named `libopencv_java4.so` files **collide at the `jniLibs`
merge** step of the Android build. Don't add a second OpenCV
dependency (Gradle artifact, AAR, or extra `.so`) — keep the single
copy this library already provides.
:::

## Constraints recap

| Constraint | Value |
|---|---|
| OpenCV version | Pinned to **4.10.0** |
| Modules | `core`, `imgproc`, `imgcodecs`, `features2d`, `calib3d`, `flann`, `stitching`, `video`, `videoio`, `photo` |
| Not included | `dnn`, `ml`, `objdetect`, `gapi` |
| iOS | One vendored `opencv2.xcframework`; symbols already in the app binary; add `Headers` to `HEADER_SEARCH_PATHS`; no second pod |
| Android | One `libopencv_java4.so`; `org.opencv.*` on classpath; **no** `stitching` in the `.so`; no second OpenCV dependency |

:::note This is internal layout, not a public contract
The reuse described here relies on **internal packaging layout** (the
`opencv2.xcframework` location, the `jniLibs` shared library, the
vendored header paths). It is **not a stability-guaranteed contract** —
these paths can change between releases. If you depend on them, pin the
library version and re-verify after upgrades.
:::

## When Option A can't fit

Option A only works while your app stays inside the pinned version and
module set above. If you need a **different OpenCV version**, or a
module this build doesn't include (`dnn`, `ml`, `objdetect`, `gapi`),
reuse isn't possible — and you must avoid the two-copies trap a
different way.

See **[Bring your own OpenCV](./bring-your-own-opencv.md)** for that
path.
