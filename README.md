# react-native-image-stitcher

**Pose-aware panorama capture + stitching for React Native (iOS + Android).**
One `<Camera>` component, both tap-to-photo and hold-to-pan modes, both
AR-backed and IMU-fallback capture paths.

## What it does

| Feature | Behaviour |
|---|---|
| **Tap shutter** | Single photo via vision-camera's `takePhoto` (non-AR) or `ARFrame.capturedImage` (AR). |
| **Hold shutter** | Panorama capture — pan and release.  Engine accumulates keyframes; stitches via `cv::Stitcher::PANORAMA` (or `SCANS` if the pose suggests a flat-translation scan). |
| **Lens chip** | 1× / 0.5× toggle above the shutter.  Selecting 0.5× forces non-AR (AR sessions can't switch physical lenses mid-session). |
| **AR toggle** | Bottom-right corner, conditional on the 1× lens.  Toggles between AR-pose-driven and IMU-driven capture paths. |
| **Internal settings panel** | Opt-in gear icon (top-right) via `showSettingsButton` prop.  Exposes blender, seam finder, warper, flow-gate tunables — useful for internal testers; hidden from public consumers by default. |

## Installation

```sh
npm install react-native-image-stitcher
# or
yarn add react-native-image-stitcher
```

Peer dependencies (the host app provides these):

```jsonc
{
  "react": ">=18.0.0",
  "react-native": ">=0.72.0",
  "react-native-vision-camera": ">=4.7.0",
  "react-native-sensors": ">=7.0.0",
  "expo-sensors": ">=14.0.0",
  "react-native-safe-area-context": ">=4.0.0"
}
```

On install, a `postinstall` script downloads the matching custom
OpenCV build (`opencv2.xcframework` for iOS + per-ABI `.so`
files for Android) from the package's GitHub Releases — about 100 MB
of binaries fetched once and cached locally.  Set
`SKIP_OPENCV_FETCH=1` to bypass the download (e.g., in CI where the
binaries are pre-staged).

After install run the standard React Native native-build steps:

```sh
cd ios && pod install   # iOS
cd android && ./gradlew :app:assembleDebug   # Android
```

> [!IMPORTANT]
> **The host app needs several pieces of native configuration on top of
> the standard `pod install` / `gradlew assembleDebug` steps** — most
> notably: switching `AppDelegate.swift` and `MainApplication.kt` to
> Expo's factory classes, adding several `Info.plist` permission strings
> (otherwise iOS SIGABRTs the app on launch), and applying two
> `patch-package` patches for React Native 0.84 compatibility.
>
> **Read [`docs/host-app-integration.md`](docs/host-app-integration.md)
> before your first run** — it covers every required step plus a
> troubleshooting table mapping every common runtime crash to its
> missing-config cause.  The [`example/`](example/) directory is the
> canonical reference implementation.

## Quick start

```tsx
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
} from 'react-native-image-stitcher';

export function CaptureScreen() {
  const handleCapture = (result: CameraCaptureResult) => {
    if (result.type === 'photo') {
      console.log('Photo:', result.uri, result.width, result.height);
    } else {
      console.log(
        'Panorama:',
        result.uri,
        `${result.framesIncluded}/${result.framesRequested} frames`,
      );
    }
  };

  const handleError = (err: CameraError) => {
    console.warn(err.code, err.message);
  };

  return (
    <Camera
      defaultCaptureSource="ar"
      defaultLens="1x"
      enablePhotoMode
      enablePanoramaMode
      onCapture={handleCapture}
      onError={handleError}
    />
  );
}
```

## `<Camera>` props (summary)

See `src/camera/Camera.tsx` for the full TSDoc.  Highlights:

### Initial values (uncontrolled — read once at mount)

| Prop | Default | Notes |
|---|---|---|
| `defaultCaptureSource` | `'ar'` | `'ar'` ↔ `'non-ar'` |
| `defaultLens` | `'1x'` | `'1x'` ↔ `'0.5x'` |
| `defaultStitchMode` | `'auto'` | `'auto'`, `'panorama'`, `'scans'` |
| `defaultBlender` | `'multiband'` | `'multiband'`, `'feather'` |
| `defaultSeamFinder` | `'graphcut'` | `'graphcut'`, `'skip'` |
| `defaultWarper` | `'plane'` | `'plane'`, `'cylindrical'`, `'spherical'` |
| `defaultFlowNoveltyPercentile` | `0.85` | Range 0.50 – 0.99 |
| `defaultFlowEvalEveryNFrames` | `5` | Range 1 – 10 |
| `defaultFlowMaxTranslationCm` | `50` | 0 = disabled |
| `defaultKeyframeMaxCount` | `6` | Range 3 – 10 |
| `defaultKeyframeOverlapThreshold` | `0.20` | Range 0.20 – 0.60 |

### UI toggles

| Prop | Default | Notes |
|---|---|---|
| `enablePhotoMode` | `true` | Tap-to-photo |
| `enablePanoramaMode` | `true` | Hold-to-pan |
| `showSettingsButton` | `false` | Internal-tester only; OFF for public consumers |

### Callbacks

| Prop | Fires when |
|---|---|
| `onCapture(result)` | Photo OR panorama capture completes successfully.  `result.type` discriminates. |
| `onCaptureSourceChange(source)` | Effective capture source changes (e.g., user toggles AR, or selecting 0.5× forces non-AR). |
| `onLensChange(lens)` | User taps the 1×/0.5× chip. |
| `onFramesDropped(info)` | cv::Stitcher's confidence retry loop dropped one or more input frames. |
| `onError(err)` | Classified error.  `err.code` from a known taxonomy (`STITCH_NEED_MORE_IMGS`, `STITCH_HOMOGRAPHY_FAIL`, `STITCH_CAMERA_PARAMS_FAIL`, `STITCH_OOM`, `CAMERA_PERMISSION_DENIED`, etc.). |

## Orientation support

`<Camera>` works in any device orientation regardless of host
configuration.  No host setup required — the SDK adapts at runtime.

**Portrait-locked host** (Info.plist `UISupportedInterfaceOrientations`
restricted to Portrait — recommended for kiosks / single-task apps):
the screen stays portrait; the SDK uses sensor-derived orientation
for capture-mode selection and overlay layout.  This is the simpler
configuration and the historical default.

**Non-locked host** (Info.plist supports all 4 orientations — recommended
for apps with other landscape-friendly screens): the screen rotates
with the device.  `<Camera>`'s controls (shutter, lens chip, AR toggle)
anchor to the home-indicator edge so they stay within thumb reach
regardless of tilt — matching iOS Camera's behaviour.  The
orientation-aware logic combines `useWindowDimensions()` (JS-layout)
with `useDeviceOrientation()` (sensor) to compute the correct anchor.

**Mid-capture rotation safety** — the incremental engine doesn't
support cross-orientation captures (a portrait capture's keyframes
can't be mixed with landscape-pan frames).  If the user rotates
mid-capture, `<Camera>` auto-abandons via `incremental.cancel()`,
fires `onCaptureAbandoned('orientation-drift')` if the host wired
the callback, and shows the `OrientationDriftModal` to explain why.
Host opt-in via the `onCaptureAbandoned` prop — the default UX is
the modal alone.

## Lens ↔ AR interaction

| Action | `arPreference` | `lens` | UI |
|---|---|---|---|
| Initial mount with defaults | `true` | `1x` | AR toggle ON |
| User switches to 0.5× | unchanged (`true`) | `0.5x` | AR toggle HIDDEN, forced non-AR |
| User switches back to 1× | unchanged (`true`) | `1x` | AR toggle visible at its previous state |
| User taps AR toggle off (on 1×) | `false` | `1x` | AR toggle OFF |

The component owns the runtime state; the parent persists across launches via the `on*Change` callbacks if desired.

## Architecture notes

| Concern | Approach |
|---|---|
| **OpenCV** | Custom build (modules: `core`, `imgproc`, `features2d`, `calib3d`, `flann`, `stitching`, `video`, `photo`).  Hosted as GitHub Release assets; fetched at install time.  ~75 MB iOS, ~40 MB Android. |
| **iOS framework** | `opencv2.xcframework` (arm64 device + arm64+x86_64 simulator). |
| **Android namespace** | `io.imagestitcher.rn`. |
| **Stitching pipeline** | Shared C++ under `cpp/stitcher.cpp` invoked from both iOS Obj-C++ and Android JNI.  PANORAMA + SCANS modes; C+D progressive-confidence retry over keyframes. |
| **Two capture-source paths** | AR uses ARKit (iOS) / ARCore (Android) pose stream.  Non-AR uses vision-camera + IMU integration via `useIMUTranslationGate`. |
| **Frame Processor driver (v0.5+)** | Non-AR captures evaluate the keyframe gate on the camera producer thread at native frame rate via a vision-camera Frame Processor (`cv_flow_gate_process_frame`).  iOS passes `CVPixelBuffer` end-to-end; Android writes a Y-plane-derived JPEG on accept.  Opt-out via `<Camera legacyDriver />` for one minor cycle.  See `docs/f8-frame-processor-plan.md` for the design. |
| **Two supported pan modes** | Landscape phone + vertical pan; portrait phone + horizontal pan.  Any other combination is a user deviation, not a supported mode. |

## License

Apache License 2.0.  See [LICENSE](LICENSE) for the full text and
[NOTICE](NOTICE) for the third-party attribution required by § 4(d).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).  All contributors sign a CLA
(automated on first PR) so the project retains the right to relicense
future versions.

## Related design documents

- [`2026-05-15-react-native-image-stitcher-publication.md`](https://github.com/bhargav-kanda/RetaiLens/blob/main/docs/site-content/design/2026-05-15-react-native-image-stitcher-publication.md) — publication plan + public/private split.
- [`2026-05-14-realtime-batch-fusion.md`](https://github.com/bhargav-kanda/RetaiLens/blob/main/docs/site-content/design/2026-05-14-realtime-batch-fusion.md) — realtime + batch convergence design.
- [`2026-05-13-stitch-pipeline-mode-selection.md`](https://github.com/bhargav-kanda/RetaiLens/blob/main/docs/site-content/design/2026-05-13-stitch-pipeline-mode-selection.md) — PANORAMA vs SCANS auto-routing.
