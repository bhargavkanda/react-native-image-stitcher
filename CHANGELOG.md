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

## [0.1.2] — 2026-05-20

### Fixed

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

[Unreleased]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bhargavkanda/react-native-image-stitcher/releases/tag/v0.1.0
