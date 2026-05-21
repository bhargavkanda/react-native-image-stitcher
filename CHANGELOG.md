# Changelog

All notable changes to `react-native-image-stitcher` will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> [!IMPORTANT]
> **0.x → 1.0 stability gate.** Per non-functional requirement NF2 of
> the design doc, the 0.x line is API-unstable.  We intentionally ship
> a small, focused public surface here so the v1.0 contract can be
> stabilised without churning a sprawling API.  Breaking changes
> during 0.x are bumped to a new MINOR (e.g., 0.1 → 0.2), and the
> upgrade path is documented in this CHANGELOG.

## [Unreleased]

## [0.2.1] — 2026-05-21

### Changed

- **Example app no longer wires Expo modules.**  The deferred v0.2
  follow-up landed: the example app now uses the standard React
  Native 0.84 host wiring throughout — `RCTReactNativeFactory` in
  `AppDelegate.swift`, `DefaultReactHost.getDefaultReactHost` in
  `MainApplication.kt`, no `use_expo_modules!` macro in `Podfile`,
  no `expo-root-project` plugin or `expoAutolinking.useExpoModules()`
  call in the gradle files, and no `expo`/`expo-modules-core`/
  `expo-modules-autolinking` packages in `example/package.json`.
  The two inline `patch-package`-style Podfile patches for Expo
  SDK 55 on RN 0.84 are also gone — they were only needed because
  we were dragging Expo in.  Verified by clean build + install on
  iPhone 16 Pro and Galaxy A35 (with `LANG=en_US.UTF-8 pod install`
  + `JAVA_HOME` set to OpenJDK 17, both required workarounds for
  unrelated tooling bugs we now document in the troubleshooting
  table).
- **`docs/host-app-integration.md` rewritten** for the post-Expo
  posture.  Dropped ~340 lines describing Podfile macros,
  AppDelegate Expo factory wiring, MainApplication Expo factory
  wiring, gradle `expo-root-project` plugin, and the
  `expo-modules-core+55.0.14.patch` patch-package patch.  The
  remaining content (vision-camera permission strings, ARCore
  manifest entries, the one `react-native-sensors+7.3.6.patch`
  patch for the jcenter→mavenCentral swap, network access from
  devices to Metro, troubleshooting) is preserved.  The README's
  IMPORTANT block at [README.md:53-66](README.md:53) and the
  pre-existing setup walkthrough still apply.

### Migration from 0.2.0

Hosts upgrading from 0.2.0 with their existing Expo modules host
wiring **don't have to change anything** — Expo modules are
additive, so the wiring keeps working even though the SDK no
longer requires it.  But the wiring is now strictly optional, and
[`docs/host-app-integration.md`](docs/host-app-integration.md)
describes the simpler post-Expo path.  If you want to follow the
simpler path: drop the four Expo packages from your
`package.json`, revert your `AppDelegate.swift` /
`MainApplication.kt` / Podfile / gradle / patches to the standard
RN 0.84 templates documented in that file, run
`pod deintegrate && pod install` (the CocoaPods 1.16 bug needs
`LANG=en_US.UTF-8`), and rebuild.

## [0.2.0] — 2026-05-21

> [!IMPORTANT]
> This release changes the peer-dependency contract in a
> backward-incompatible way (semver-minor in 0.x).  The public hook
> surface is preserved — no JS code changes are required for any
> host that doesn't directly import `expo-sensors`.  Verified end-
> to-end on iPhone 16 Pro (iOS 26.4.2) + Samsung Galaxy A35
> (Android, SM_A356U1).

### Removed

- **`expo-sensors` is no longer a peer dependency.**  The SDK used to
  pull in the entire Expo modules runtime (`expo`, `expo-modules-core`,
  `expo-modules-autolinking`, `expo-sensors`) just for two hooks —
  `useDeviceOrientation` and `useIMUTranslationGate`.  That tax was
  disproportionate to the value (see the host-integration burden in
  [`docs/host-app-integration.md`](docs/host-app-integration.md)).
  Both hooks have been re-homed onto `react-native-sensors` (already
  a peer dep), so the SDK now works on bare React Native with no
  Expo modules infrastructure.

### Changed

- **`useDeviceOrientation` rewritten on `react-native-sensors`
  accelerometer.**  Same `DeviceOrientation` return type, same
  threshold-based dominant-axis classifier, same public signature.
  The internal-only change is the source: instead of
  `expo-sensors`' `DeviceMotion` (which normalised Android signs to
  iOS convention for us), we now subscribe to
  `react-native-sensors`' accelerometer and do the platform sign-
  flip explicitly in JS (`Platform.OS === 'android' ? -value : value`).
  Threshold is now platform-dependent because iOS reports in G's
  and Android in m/s² — see the file header for the per-platform
  numbers and the Issue #3 history that motivated keeping iOS as
  the reference convention.
- **`useIMUTranslationGate` rewritten on `react-native-sensors`
  accelerometer + JS-side IIR gravity subtraction.**  Same public
  signature, same options, same return shape, same on-budget-
  exceeded callback semantics, same anchor-reset behaviour.  The
  internal change: in 0.1.x the hook consumed `DeviceMotion.accel-
  eration` (gravity-subtracted via CoreMotion's native fusion on iOS
  / Android's `TYPE_LINEAR_ACCELERATION` on Android — both produced
  by hardware sensor fusion).  v0.2 consumes raw accelerometer and
  estimates the gravity vector with a JS IIR low-pass (alpha = 0.9
  at 50 Hz → ~200 ms time constant), then subtracts.  **Noise
  trade-off**: the JS IIR is measurably noisier than CoreMotion's
  native fusion — expect a few extra cm of apparent drift on a
  stationary phone over several seconds.  With the per-sample
  velocity damping (5 %) and the anchor reset on every accepted
  keyframe, the drift stays bounded inside a 0.3-2 s integration
  window, which is comfortably under the default 8 cm budget.  If
  the IIR floor becomes a problem in practice, we'll consider
  moving the fusion into a small native module rather than re-
  introducing the Expo modules dependency.

### Migration from 0.1.x

No JS code changes are required for any host — the public surface
that survives 0.1.x → 0.2.0 is source-compatible.

Native-side, you can now optionally rip out the entire Expo modules
host wiring (Podfile `use_expo_modules!` macro, `AppDelegate.swift`
Expo factory, `MainApplication.kt` `ExpoReactHostFactory`, the gradle
`expo-root-project` plugin, the two `patch-package` patches for Expo
SDK 55 on RN 0.84) — that whole section of
[`docs/host-app-integration.md`](docs/host-app-integration.md) is
optional from 0.2.0 onward and will be removed from the doc in a
follow-up commit.

## [0.1.3] — 2026-05-21

### Changed

- **Docs / source-comment cleanup.** Removed the leftover
  pre-extraction RetaiLens-monorepo framing from the README — this repo
  is now the canonical, self-contained source of `react-native-image-
  stitcher`, not a downstream subtree of anything.  Source-file path
  comments and iOS GCD queue labels now use the canonical
  `io.imagestitcher.*` namespace and `react-native-image-stitcher/`
  repo path instead of the leftover `com.retailens.*` /
  `retailens-capture-sdk/` references that survived the 0.1.0 rename.
  GCD label change affects: `RNSARSession.poseLogQueue`,
  `IncrementalStitcher.workQueue`, `IncrementalStitcher.refineQueue` —
  labels are diagnostic-only (Instruments / crash-report symbolication),
  no public-API or behaviour impact.  The CHANGELOG.md migration table
  for [0.1.0] retains the historical `com.retailens.capturesdk` name
  intentionally — it documents the rename that shipped, not the
  current state.
- **CHANGELOG.** Added compare-links for [0.1.1] and [0.1.2] and fixed
  the [Unreleased] compare base.  Annotated the [0.1.0] "Deliberately
  NOT exported" section with a header note explaining that most of
  those entries were promoted to public in [0.1.1] — see the 0.1.1
  *Added* list for the current public surface.

## [0.1.2] — 2026-05-20

### Added

- **`outputDir` prop on `<Camera>`** + **`outputPath` per-call
  option on `useCapture.takePhoto`** — captures (both tap-photos
  and hold-panoramas) can now land at a host-controlled file
  location instead of vision-camera's tmp dir.  Filename is
  composed internally as `${outputDir}/photo-${ts}.jpg` /
  `${outputDir}/panorama-${ts}.jpg` for `<Camera>`; per-call
  `outputPath` on `useCapture` lets layer-2 hosts compose their
  own filenames.
  - On disk failure the capture rejects with
    `CameraError('OUTPUT_WRITE_FAILED', ...)`.  **No silent
    fallback** to a different path — that hides bugs.
  - Host owns *picking* the path.  The lib treats the value as an
    opaque writable filesystem path; it does not know about iOS
    `UIFileSharingEnabled`, Android MediaStore, SAF, or any other
    platform-specific shared-storage mechanism.  That's the host's
    domain.
  - **No peer deps required** — the move is handled by a small
    native bridge (`RNImageStitcherFileUtils`) that ships with
    the lib.
- **Canonical default capture directory** — when neither
  `outputDir` nor `outputPath` is set, the lib now writes captures
  to a predictable per-platform location instead of vision-camera's
  auto-generated tmp paths:
  - iOS: `<NSCachesDirectory>/react-native-image-stitcher/photo-<ms>.jpg`
    (and `panorama-<ms>.jpg`).
  - Android: `<context.cacheDir>/react-native-image-stitcher/...`.
  - Both are app-private, evictable by the OS under storage
    pressure, not backed up.  Captures live here until the host
    moves them somewhere durable — the lib doesn't promise
    persistence beyond the immediate capture flow.
  - This applies to BOTH tap-photo and panorama, so call-sites can
    rely on a single naming + parent-dir convention regardless of
    capture type.
- **`RNImageStitcherFileUtils` native module** (internal) —
  small Swift + Kotlin bridge exposing `moveFile(from, to)` and
  `defaultCaptureDir()`.  Used by the lib's own JS layer to relocate
  vision-camera's auto-named output into the canonical default dir
  / `outputDir` without forcing a peer dep on `expo-file-system`
  for every consumer.  Not re-exported from `src/index.ts`.

### Fixed

- **Android `cv::imwrite` rejected `file://`-scheme output paths.**
  `IncrementalStitcher.finalize` (Kotlin) was passing the host-
  provided `outputPath` straight to `cv::imwrite` without
  normalisation, so consumers using `expo-file-system`'s
  `documentDirectory` (which always prefixes `file://`) hit
  "Stitch failed: cv::imwrite returned false (code=101)" on every
  panorama capture.  iOS already stripped at the same boundary
  (`IncrementalStitcher.swift:1215`); now Android does too via
  `stripFileScheme()`, which already exists in the same file and
  is used by `refinePanorama`.  The fix has zero behaviour impact
  on hosts that were already passing bare paths.
- **iOS modular-header build under `use_frameworks!`** — host apps
  that opt into modular framework linkage (Expo + `use_frameworks!`,
  RetaiLens-mobile is the immediate example) hit
  ``'cstdint' file not found / could not build Objective-C module
  'RNImageStitcher'`` because CocoaPods defaulted EVERY header in
  `source_files` (including the shared `cpp/*.hpp` C++ headers) to
  public.  The auto-generated `RNImageStitcher-umbrella.h` then
  `#import`ed `keyframe_gate.hpp` / `stitcher.hpp` from a pure
  Obj-C context and tripped on the C++ stdlib.  Pin
  `s.public_header_files = ['ios/Sources/**/*.h']` so the umbrella
  exposes only the iOS-side Obj-C `.h` files; the `.mm` source files
  still locate the C++ headers via `HEADER_SEARCH_PATHS` set in
  `pod_target_xcconfig`, so behaviour is unchanged for non-modular
  hosts.  The umbrella now contains: `KeyframeGateBridge.h`,
  `OpenCVIncrementalStitcher.h`, `OpenCVKeyframeCollector.h`,
  `OpenCVSlitScanStitcher.h`, `OpenCVStitcher.h` — all Foundation /
  CoreVideo-only declarations (the OpenCV C++ types stay inside the
  `.mm` implementations).

## [0.1.1] — 2026-05-20

### Added

- **Layer 2 building blocks now public.**  The lower-level views,
  hooks, and stitching-engine bindings that previously lived behind
  the `<Camera>` wrapper are now exported from the package root.
  Use these when `<Camera>` doesn't give you enough control — e.g.,
  when you're hand-composing your own capture screen on top of the
  same proven primitives.  Full list:
  - Views: `ARCameraView`, `CameraView` (+ their handle/prop types).
  - UI components: `CaptureHeader`, `CaptureControlsBar`,
    `CapturePreview`, `CaptureStatusOverlay`, `CaptureThumbnailStrip`,
    `IncrementalPanGuide`, `PanoramaBandOverlay`, `PanoramaGuidance`,
    `PanoramaSettingsModal` (+ `DEFAULT_PANORAMA_SETTINGS` constant +
    `PanoramaSettings` type), `ViewportCropOverlay`.
  - Hooks: `useCapture`, `useVideoCapture`, `useDeviceOrientation`,
    `useIncrementalStitcher`, `useIncrementalJSDriver`.
  - Engine: `IncrementalOutcome`, `incrementalStitcherIsAvailable`,
    `subscribeIncrementalState`, `getIncrementalNativeModule`,
    `cleanupOldKeyframes`, `IncrementalState` (type).
  - Batch stitching: `stitchVideo`.
- The 0.1.0 → 1.0 stability gate still applies — the goal of
  surfacing layer 2 is to support advanced consumers (e.g.,
  `retailens-camera-sdk`) without forcing them to deep-import
  package internals.  These are likely to keep their shape through
  1.0, but the contract is not formally stable until then.

### Changed

- README now documents both layers and recommends `<Camera>` as the
  default starting point.

### Fixed

(No bug fixes in this release — see 0.1.0 for the device-verified
camera lifecycle fixes that shipped with the initial release.)

## [0.1.0] — 2026-05-20

First public release.

### Added

- `<Camera>` — props-based RN component combining tap-to-photo and
  hold-to-pan-and-stitch panorama capture in one surface.  Switches
  internally between ARKit/ARCore (AR mode) and vision-camera + IMU
  (non-AR mode); the host doesn't manage the modes directly.
- `useARSession()` — hook exposing the underlying ARKit/ARCore session
  (availability, tracking state, pose log).  For hosts that want to
  build AR-driven UIs on top of the public lib's foundation.
- `useIMUTranslationGate()` — hook exposing the same IMU-fused
  translation-budget gate that `<Camera>` uses internally on the non-AR
  capture path.  Useful if you're building your own non-AR capture
  pipeline.
- Native binaries (OpenCV `cv::Stitcher` xcframework for iOS, `.so`
  for Android) fetched from GitHub Releases on `npm install` via the
  package's postinstall script.  Android ships `arm64-v8a` only —
  covers all production Android phones; x86/x86_64 emulator support
  is on the v0.2 roadmap.
- Apache 2.0 license.

### Deliberately NOT exported in v0.1.0

The following are intentionally internal so the public surface stays
small.  If you have a real use-case for any of these, please open an
issue describing it.

> [!NOTE]
> **This list reflects the v0.1.0 surface as shipped.**  Most of the
> entries below — the layer-2 hooks, views, UI components, and
> incremental-engine primitives — were subsequently promoted to public
> in [0.1.1].  See the 0.1.1 *Added* section for the current public
> surface; only a few items below remain internal in later releases
> (`CameraShutter`, `PanoramaConfirmModal`, `IncrementalStitcherView`,
> `stitchFrames`, `StitchNotImplementedError`, `runQualityCheck`,
> `normaliseOrientation`).

- `useCapture`, `useDeviceOrientation` — internal hooks `<Camera>`
  composes; expose these only after we have a story for what their
  separate-from-`<Camera>` use-case looks like.
- `CameraView`, `ARCameraView` — underlying preview surfaces.  Hosts
  that need both modes should use `<Camera>` (which switches between
  them); hosts that need only one path should still go through
  `<Camera>` (a future prop `mode="ar-only"` / `"non-ar-only"` is on
  the v0.2 roadmap).
- `CameraShutter`, `CaptureStatusOverlay`, `CaptureHeader`,
  `CaptureControlsBar`, `PanoramaGuidance`, `IncrementalPanGuide`,
  `PanoramaBandOverlay`, `ViewportCropOverlay`, `CapturePreview`,
  `PanoramaConfirmModal`, `CaptureThumbnailStrip`,
  `PanoramaSettingsModal`, `DEFAULT_PANORAMA_SETTINGS` — sub-pieces of
  `<Camera>`.
- `useIncrementalStitcher`, `useIncrementalJSDriver`,
  `IncrementalStitcherView`, `incrementalStitcherIsAvailable`,
  `getIncrementalNativeModule`, `cleanupOldKeyframes`,
  `subscribeIncrementalState`, `IncrementalOutcome` — internal driver
  primitives for the incremental engine.
- `stitchFrames`, `stitchVideo`, `StitchNotImplementedError` —
  batch-stitching primitives.  A candidate for graduating to public
  in v0.2 once we've decided whether they should be a parallel API
  to `<Camera>` or a hidden orchestrator.
- `runQualityCheck`, `normaliseOrientation` — image-quality helpers.
  Same status as batch-stitching.
- `useVideoCapture` — sweep-video capture, currently iOS-only with no
  shipping Android port.

### Migration from pre-publication ad-hoc usage

If you imported from `@retailens/capture-sdk` or directly from a
subtree-checkout of the monorepo, the migration to the published
`react-native-image-stitcher` package is:

| Old import (`@retailens/capture-sdk`) | New import (`react-native-image-stitcher`) |
|---|---|
| `Camera`, `CameraError`, … | unchanged |
| `useARSession`, `useIMUTranslationGate` | unchanged |
| Any other deep export (e.g. `stitchFrames`, `measureRegion`) | retired or moved — see "Deliberately NOT exported" above; retail-specific features are now in `retailens-camera-sdk` (private) |

Native module names also changed:
- `NativeModules.RetaiLensQualityChecker` → `NativeModules.RNImageStitcherQualityChecker`
- Java package: `com.retailens.capturesdk` → `io.imagestitcher.rn`
- iOS pod: `RetaiLensCaptureSDK` → `RNImageStitcher`
- iOS xcframework: shipped as `opencv2.xcframework` (linked from `RNImageStitcher.podspec`)

[Unreleased]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bhargavkanda/react-native-image-stitcher/releases/tag/v0.1.0
