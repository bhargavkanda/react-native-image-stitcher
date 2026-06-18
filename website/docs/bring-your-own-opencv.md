---
id: bring-your-own-opencv
title: Bring your own OpenCV (advanced)
sidebar_position: 9.6
---

# Bring your own OpenCV (advanced)

:::caution Proposal — not implemented yet
This page is a **design sketch**, not a feature you can switch on today.
`react-native-image-stitcher` currently always vendors its **own**
custom OpenCV build (the xcframework on iOS, the per-ABI `.so` files on
Android). There is **no supported way to point the SDK at an OpenCV the
host app already ships.** The text below describes what that change
*would* look like — and what makes it non-trivial — so that if you hit
the wall Option A leaves you at, you have a concrete starting point for
an issue or PR.
:::

## Why you might want this

The SDK ships a **pinned custom OpenCV build**, deliberately trimmed to
the modules stitching needs. That is the right default for almost every
host — see **[Sharing OpenCV](./sharing-opencv.md)** (Option A) for how
to deduplicate it when your app *also* uses OpenCV at the same version.

Option A only works when the SDK's pinned version and module set are
also acceptable to you. The two cases it can't cover:

- **You need a different OpenCV version.** Your app is pinned to a newer
  (or older) OpenCV than the SDK's, and you can't move either side to
  meet in the middle.
- **You need a module this build excludes.** The SDK's build is trimmed
  for stitching, so heavyweight modules like `dnn`, `ml`, `objdetect`,
  and `gapi` are not present. If your app links one of those, you'd be
  carrying *two* OpenCV binaries — the SDK's trimmed one plus your full
  one — which is exactly the bloat Option A exists to avoid.

In both cases the only way out is for the SDK to stop vendoring OpenCV
and instead **consume an OpenCV the host provides**. That's "bring your
own OpenCV" (Option B).

## The hard constraint: stitching must be in the build

There is one requirement you cannot negotiate away, and it's the reason
off-the-shelf OpenCV will **not** work here:

:::caution The shared OpenCV must be a custom build with `BUILD_opencv_stitching=ON`
This library is built on `cv::Stitcher`. The stitching module is not in
the stock mobile distributions:

- **iOS** — the stock CocoaPods `OpenCV` pod (and the common
  `opencv-mobile` flow it descends from) **drops the stitching module.**
- **Android** — the stock Maven `org.opencv` artifacts ship a
  `libopencv_java4.so` that does **not** contain the
  `cv::Stitcher::create` symbols. The stitching module is dropped from
  the *binary*, not merely from the Java bindings.

So an off-the-shelf OpenCV will **not** satisfy this library. Any
"bring your own OpenCV" you supply has to be a **custom build compiled
with `BUILD_opencv_stitching=ON`** — the same flag the SDK's own
vendored binaries are built with. The Android build deliberately
**refuses to fall back to stock OpenCV** for exactly this reason: a
silent stock fetch would link, then fail at the worst possible moment
with a confusing "static archive not found" / missing-symbol error.
:::

This is also why "just depend on the public OpenCV pod / Maven artifact"
is not the design. The shared binary has to be *your own* stitching-
enabled build; the packaging change below only removes the SDK's copy so
yours is the one that gets linked.

## What would change — iOS

Today the podspec vendors the framework directly:

```ruby
# RNImageStitcher.podspec (today)
s.vendored_frameworks = 'ios/Frameworks/opencv2.xcframework'
```

The postinstall fetcher downloads `opencv2.xcframework` into
`ios/Frameworks/`, and `pod install` links it. Under Option B the SDK
would **stop vendoring that framework** and instead depend on an
`opencv2` framework the **host app** provides — the same shape Option A
already uses, except the host supplies the binary rather than the SDK.

Concretely, the proposal is:

- Drop `s.vendored_frameworks = 'ios/Frameworks/opencv2.xcframework'`
  (and skip the postinstall fetch for iOS, e.g. via the existing
  `SKIP_OPENCV_FETCH=1`).
- The host's `Podfile` vendors **its** `opencv2.xcframework` (the
  stitching-enabled custom build), so there's exactly one copy in the
  app and the SDK's `.mm`/C++ sources link against it through the normal
  framework + `HEADER_SEARCH_PATHS` resolution the podspec already sets
  up.

```ruby
# Host Podfile (sketch) — host owns the single opencv2 framework
target 'YourApp' do
  # …the standard RN 0.84 target body…

  # Your stitching-enabled custom OpenCV, vendored once by the app:
  pod 'OpenCV2-Stitching', :path => './vendor/opencv2'
end
```

:::note Names are illustrative
`OpenCV2-Stitching` above is a placeholder — there's no published pod
that ships a stitching-enabled iOS build. The point is *where* the
binary comes from (the host), not the pod name. You'd be vendoring a
framework you built yourself.
:::

## What would change — Android

The Android side bundles two things today: OpenCV's per-ABI
`libopencv_java4.so` (rides along as `jniLibs`) **and** the static
stitching archive `libopencv_stitching.a`, which the JNI shim
(`libimage_stitcher.so`) links against to reach `cv::Stitcher`. Both
come from the custom SDK the postinstall script extracts into
`android/vendor/OpenCV-android-sdk/`.

Under Option B the SDK would **stop bundling the runtime `.so`** and
instead consume a shared OpenCV the **host app** supplies — while still
needing the **stitching archive** to link the shim.

Concretely, the proposal is:

- Stop shipping `libopencv_java4.so` from the SDK's `jniLibs` so the
  app's single OpenCV runtime is the one that loads at runtime.
- Keep linking the JNI shim against a **stitching-enabled**
  `libopencv_stitching.a` — except sourced from the host's custom
  OpenCV SDK rather than the SDK's vendored copy. (You can't drop the
  archive: without it the shim has no `cv::Stitcher::create` to link.)
- Surface the host's OpenCV SDK location to the build, e.g. an override
  for the path the build already reads:

```bash
# Sketch — point the Android build at the host's custom OpenCV SDK
# (must be built with BUILD_opencv_stitching=ON), instead of the
# SDK's vendored android/vendor/OpenCV-android-sdk/.
SKIP_OPENCV_FETCH=1 npm install
export OPENCV_ANDROID_SDK=/abs/path/to/your/OpenCV-android-sdk
./gradlew :app:assembleDebug
```

:::caution Both halves have to match
The shared runtime OpenCV and the stitching archive you link must come
from the **same custom build** — same version, same `__ndk1`
(`c++_shared`) STL, and `BUILD_opencv_stitching=ON`. Mixing a stock
runtime `.so` with the SDK's stitching archive (or vice versa) is the
fast path to a load-time crash or a missing-symbol link error. The
SDK builds the shim with `-DANDROID_STL=c++_shared`; your archive must
be ABI-compatible with that.
:::

## Honest status

This is a **non-trivial repackaging on both platforms**, and it is
**not currently supported.** Wiring it up means: making the vendoring
conditional in the podspec and the Gradle module, threading a host-
supplied path/override through the iOS framework search and the Android
CMake `-DOPENCV_ANDROID_SDK` argument, and documenting how a host
produces a stitching-enabled custom build in the first place — plus the
matrix of "did the host's version/STL/module set actually match" failure
modes, each of which currently surfaces as a cryptic linker error.

Treat Option B as the path you reach for **only when Option A's
constraints genuinely block you** — a version you can't reconcile, or a
module the trimmed build excludes. For everyone else, Option A
(**[Sharing OpenCV](./sharing-opencv.md)**) is the supported, far
simpler route.

:::tip Want this? Open an issue or PR
If you're blocked on Option A and need bring-your-own-OpenCV, please
[open an issue](https://github.com/bhargavkanda/react-native-image-stitcher/issues)
describing your version / module requirement (and ideally how you build
your stitching-enabled OpenCV). It helps scope the change — and a PR
that makes the vendoring conditional is very welcome.
:::

## See also

- **[Sharing OpenCV](./sharing-opencv.md)** — Option A: deduplicate the
  SDK's pinned OpenCV when your app uses the *same* version. Start here.
- **[Getting started](./getting-started.md)** — how the OpenCV binaries
  are fetched on install (and the `SKIP_OPENCV_FETCH=1` escape hatch).
- **[Host app integration](./host-integration.md)** — the full native
  setup, including the `framework not found 'opencv2'` recovery.
