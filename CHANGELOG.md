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

[Unreleased]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bhargavkanda/react-native-image-stitcher/releases/tag/v0.1.0
