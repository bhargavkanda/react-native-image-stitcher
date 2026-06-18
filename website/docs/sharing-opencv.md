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

## Android — reuse the bundled OpenCV (including `cv::Stitcher`)

On Android the build ships the fat shared library **`libopencv_java4.so`**
inside the AAR's `jniLibs`, plus the `stitching` module as a static archive
**`libopencv_stitching.a`** in the vendored SDK. Your host native code can
reuse **both** — so unlike a stock-OpenCV reuse, you get `cv::Stitcher` too,
with no second copy of OpenCV in the APK.

### From Java / Kotlin

Nothing to do — the `org.opencv.*` classes are on your classpath through the
AAR, and the library loads `libopencv_java4.so` at runtime.

### From native (C++/NDK) code

The library publishes the location of its bundled OpenCV Android SDK via a
Gradle `rootProject.ext` property, so you don't hard-code any `node_modules`
path. Consume it through OpenCV's own first-class CMake package
(`find_package(OpenCV)`) — the idiomatic Android way.

1. Point your app module's `externalNativeBuild` at the published dir and
   match the STL:

```groovy
// android/app/build.gradle
android {
  defaultConfig {
    ndk { abiFilters 'arm64-v8a' }   // the bundled OpenCV is arm64-v8a only
    externalNativeBuild {
      cmake {
        // rnisOpenCVDir is published by react-native-image-stitcher's
        // android/build.gradle → .../sdk/native/jni (holds OpenCVConfig.cmake)
        arguments "-DOpenCV_DIR=${rootProject.ext.rnisOpenCVDir}",
                  "-DANDROID_STL=c++_shared"   // match the library's C++ ABI
        cppFlags "-std=c++17"
      }
    }
  }
  externalNativeBuild { cmake { path file("src/main/cpp/CMakeLists.txt") } }

  // The .so is already in the APK via the library's AAR — don't double-package.
  packagingOptions { jniLibs { pickFirsts += ['**/libopencv_java4.so', '**/libc++_shared.so'] } }
}
```

2. In your `CMakeLists.txt`, `find_package(OpenCV)` and link the **shared**
   `opencv_java` (core/imgproc/calib3d/…) plus the **whole-archived static**
   `opencv_stitching` (`cv::Stitcher`):

```cmake
find_package(OpenCV REQUIRED)

add_library(my_cv SHARED my_cv.cpp)
target_include_directories(my_cv PRIVATE ${OpenCV_INCLUDE_DIRS})
target_link_libraries(my_cv
    -Wl,--whole-archive opencv_stitching -Wl,--no-whole-archive  # cv::Stitcher (static)
    opencv_java                                                   # cv::Mat & friends (shared, runtime)
    log)
```

At runtime, load `opencv_java4` before your own library so its `cv::*`
symbols resolve:

```kotlin
System.loadLibrary("opencv_java4")
System.loadLibrary("my_cv")
```

:::tip Link those two targets — not `${OpenCV_LIBS}`
Linking the full `${OpenCV_LIBS}` pulls in the **static**
`opencv_core`/`imgproc`/… archives and bakes a **second copy** of core OpenCV
into your `.so`. Link only the **shared** `opencv_java` (resolved at runtime
from the single `libopencv_java4.so` the AAR already ships) and the **static**
`opencv_stitching` (a small private copy — it genuinely isn't in the fat
`.so`).
:::

A complete, build-verified consumer lives in the example app —
`example/android/app/src/main/cpp/` (`CMakeLists.txt` + `opencv_self_test.cpp`)
plus the `build.gradle` wiring — as a copy-paste reference.

:::caution Do not add a second OpenCV dependency
A second OpenCV (Gradle artifact, AAR, or extra `.so`) brings another
`libopencv_java4.so` that **collides at the `jniLibs` merge**, plus a second
copy of core OpenCV. Reuse the one this library provides.
:::

## Constraints recap

| Constraint | Value |
|---|---|
| OpenCV version | Pinned to **4.10.0** |
| Modules | `core`, `imgproc`, `imgcodecs`, `features2d`, `calib3d`, `flann`, `stitching`, `video`, `videoio`, `photo` |
| Not included | `dnn`, `ml`, `objdetect`, `gapi` |
| iOS | One vendored `opencv2.xcframework`; symbols already in the app binary; add `Headers` to `HEADER_SEARCH_PATHS`; no second pod |
| Android | `find_package(OpenCV)` via `rootProject.ext.rnisOpenCVDir`; link shared `opencv_java` + static `opencv_stitching` (**`cv::Stitcher` reusable**); `org.opencv.*` on classpath; STL `c++_shared`; arm64-v8a; no second OpenCV dependency |

:::note Stability
On **Android**, the `rootProject.ext.rnisOpenCVDir` property is a
**deliberate reuse hook** — use it rather than hard-coding the vendored
path. On **iOS**, reuse relies on the `opencv2.xcframework` location, which
is more incidental layout. Either way the reused OpenCV is tied to the
**bundled version (4.10.0) and module set**, so pin the library version and
re-verify your native build after upgrades.
:::

## When Option A can't fit

Option A only works while your app stays inside the pinned version and
module set above. If you need a **different OpenCV version**, or a
module this build doesn't include (`dnn`, `ml`, `objdetect`, `gapi`),
reuse isn't possible — and you must avoid the two-copies trap a
different way.

See **[Bring your own OpenCV](./bring-your-own-opencv.md)** for that
path.
