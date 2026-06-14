# react-native-image-stitcher

**Pose-aware panorama capture + stitching for React Native (iOS + Android).**
One `<Camera>` component, both tap-to-photo and hold-to-pan modes, both
AR-backed and IMU-fallback capture paths.

## What it does

| Feature | Behaviour |
|---|---|
| **Tap shutter** | Single photo via vision-camera's `takePhoto` (non-AR) or ARCore/ARKit `capturedImage` (AR). |
| **Hold shutter** | Panorama capture — pan and release.  Engine accumulates keyframes; stitches via `cv::Stitcher::PANORAMA` (or `SCANS` if the pose suggests a flat-translation scan). |
| **Lens chip** | 1× / 0.5× toggle next to the shutter.  Shown only when the device actually has a usable ultra-wide (real capability detection, v0.14).  Hidden entirely in AR-only mode (`captureSources="ar"`). |
| **Flash & AR pills** | Top-right pill stack, under the settings gear.  Flash toggles the torch (hidden on torchless lenses, e.g. a standalone ultra-wide).  AR pill toggles AR ↔ non-AR — shown only when `captureSources="both"` and the device supports AR. |
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

> **Orientation: use portrait.** `<Camera>` is designed and tuned for
> portrait capture. On Android it self-locks to portrait; on iOS,
> portrait-only is the recommended host `Info.plist` configuration.
> See [Orientation support](#orientation-support) for the full story
> (landscape *is* supported on iOS if you need it).

The minimum: resolve camera permission, then mount `<Camera>` with an
`onCapture` handler.

```tsx
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
} from 'react-native-image-stitcher';

export function CaptureScreen() {
  const handleCapture = (result: CameraCaptureResult) => {
    // `onCapture` fires on success AND failure — gate on `ok` first.
    if (!result.ok) {
      console.warn('capture failed:', result.error.code, result.error.message);
      return;
    }
    // Non-fatal quality signals (e.g. <70% of frames used). Always present.
    if (result.warnings.length > 0) {
      console.warn('warnings:', result.warnings.map((w) => w.code));
    }
    if (result.type === 'photo') {
      console.log('Photo:', result.uri, result.width, result.height);
    } else {
      console.log(
        'Panorama:',
        result.uri,
        `${result.framesIncluded}/${result.framesRequested} frames`,
        `stitched as ${result.stitchModeResolved ?? 'n/a'}`,
      );
    }
  };

  return (
    <Camera
      onCapture={handleCapture}
      // onError still fires on failure too (an unchanged mirror of the
      // ok:false result above).
      onError={(err: CameraError) => console.warn(err.code, err.message)}
    />
  );
}
```

### A complete capture screen

A realistic screen: requests permission up front, shows a capture
history strip, opens a post-stitch preview modal, and persists the
output to a directory you control. (The SDK does **not** request camera
permission for you — the host owns that.)

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useCameraPermission } from 'react-native-vision-camera';
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
  type CaptureThumbnailItem,
} from 'react-native-image-stitcher';

export function CaptureScreen() {
  // 1. Camera permission is a HOST concern — resolve it BEFORE mounting
  //    <Camera>. (Android treats unrequested permissions as denied even
  //    when declared in the manifest, so the explicit call is required.)
  const { hasPermission, requestPermission } = useCameraPermission();
  useEffect(() => {
    if (!hasPermission) requestPermission().catch(() => undefined);
  }, [hasPermission, requestPermission]);

  // 2. Capture history (drives the built-in thumbnail strip).
  const [thumbnails, setThumbnails] = useState<CaptureThumbnailItem[]>([]);

  // 3. Post-stitch preview modal — set on success, cleared on close.
  const [preview, setPreview] = useState<
    Extract<CameraCaptureResult, { ok: true }> | null
  >(null);

  const onCapture = useCallback((result: CameraCaptureResult) => {
    if (!result.ok) return; // failures go to onError; nothing to preview
    setPreview(result);
    setThumbnails((prev) => [
      ...prev,
      { id: String(Date.now()), uri: result.uri, width: result.width, height: result.height },
    ]);
  }, []);

  if (!hasPermission) return <View style={styles.fill} />; // or your own "grant access" UI

  return (
    <SafeAreaProvider>
      <View style={styles.fill}>
        <Camera
          // Capture-mode controls
          defaultCaptureSource="ar"   // start in AR mode (pose-driven)
          captureSources="both"       // allow AR + non-AR; show the AR toggle
          enablePhotoMode             // tap = photo
          enablePanoramaMode          // hold + pan = panorama
          // Output
          outputDir={`${/* your app dir */ ''}/captures`}
          // Header chrome (optional)
          headerTitle="Capture"
          headerGuidance="Tap for a photo. Hold + pan + release for a panorama."
          // Capture history strip
          thumbnails={thumbnails}
          // Post-stitch preview modal (controlled — clear it on close)
          capturePreview={preview ? { imageUri: preview.uri } : undefined}
          onCapturePreviewClose={() => setPreview(null)}
          // Events
          onCapture={onCapture}
          onError={(err: CameraError) => console.warn(err.code, err.message)}
          onCaptureAbandoned={(reason) => console.log('abandoned:', reason)}
        />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: '#000' } });
```

## `<Camera>` props (full reference)

Every prop is optional. `<Camera>` works with no props at all (it just
captures and you wire `onCapture`). Props fall into seven groups.

> A deeper companion reference with composition recipes lives in
> [`docs/camera-component.md`](docs/camera-component.md). The tables
> below are the authoritative prop list.

### Capture-source & lens (uncontrolled — read once at mount)

| Prop | Type | Default | Notes |
|---|---|---|---|
| `defaultCaptureSource` | `'ar' \| 'non-ar'` | `'ar'` | Initial capture path. Clamped to `captureSources` (below). |
| `captureSources` | `'ar' \| 'non-ar' \| 'both'` | `'both'` | **(v0.14)** Which sources are allowed. `'both'` shows the AR toggle. `'ar'` hides the AR toggle **and** the lens chooser (ARKit/ARCore can't use the ultra-wide). `'non-ar'` hides the AR toggle, keeps the lens chooser. A single-source value overrides a conflicting `defaultCaptureSource`. |
| `defaultLens` | `'1x' \| '0.5x'` | `'1x'` | Initial lens. The 0.5× chooser only appears if the device actually has a usable ultra-wide (real capability detection, v0.14). |

### Panorama / stitcher tunables (uncontrolled — internal-tester knobs)

These mirror the in-app settings panel; most apps never set them.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `defaultStitchMode` | `'auto' \| 'panorama' \| 'scans'` | `'auto'` | `'auto'` picks PANORAMA vs SCANS from the pose at finalize. |
| `defaultBlender` | `'multiband' \| 'feather'` | `'multiband'` | cv::Stitcher blender. |
| `defaultSeamFinder` | `'graphcut' \| 'skip'` | `'graphcut'` | Seam finder. |
| `defaultWarper` | `'plane' \| 'cylindrical' \| 'spherical'` | `'plane'` | Projection surface. |
| `defaultFlowNoveltyPercentile` | `number` | `0.85` | Keyframe-gate novelty threshold (0.50–0.99). |
| `defaultFlowEvalEveryNFrames` | `number` | `5` | Flow-gate eval cadence (1–10). |
| `defaultFlowMaxTranslationCm` | `number` | `50` | Max IMU translation between keyframes; 0 = disabled. |
| `defaultKeyframeMaxCount` | `number` | `6` | Keyframe cap per capture (3–10). |
| `defaultKeyframeOverlapThreshold` | `number` | `0.20` | Min overlap to accept a keyframe (0.20–0.60). |
| `defaultMaxKeyframeIntervalMs` | `number` | `2000` | Time-budget force-accept: take a keyframe at least every N ms during a pan even if the overlap/novelty threshold isn't met, so a slow or static pan never leaves a temporal gap. Force-accepted keyframes still count toward the keyframe cap. `0` = disabled. AR + non-AR. Also exposed as the `FrameSelectionSettings.maxKeyframeIntervalMs` settings field and in the in-app settings panel. |
| `defaultCompositingResolMP` / `defaultRegistrationResolMP` / `defaultSeamEstimationResolMP` | `number` | — | Forward-looking cv::Stitcher resolution knobs (currently no-ops). |
| `maxInscribedRectCrop` | `boolean` | `false` | Opt in with `true` to crop the panorama to the largest inscribed rectangle (clean edges, no black corners) instead of the bounding box. Default keeps the bounding-box crop (all stitched content; may show black corners). Inscribed-rect can shrink the output on lopsided / ultra-wide masks. |

### UI toggles

| Prop | Type | Default | Notes |
|---|---|---|---|
| `enablePhotoMode` | `boolean` | `true` | Tap = photo. When false, tap is a no-op. |
| `enablePanoramaMode` | `boolean` | `true` | Hold + pan = panorama. When false, hold is a no-op. |
| `showSettingsButton` | `boolean` | `false` | Gear icon → internal settings panel. Internal-tester only; leave off for public consumers. |
| `style` | `StyleProp<ViewStyle>` | — | Outer container style. |

### Flash (controlled or uncontrolled)

| Prop | Type | Default | Notes |
|---|---|---|---|
| `flash` | `'on' \| 'off'` | — | Controlled torch state. Omit to let `<Camera>` own it internally. |
| `onFlashChange` | `(next: 'on' \| 'off') => void` | — | Fires on flash-button tap (controlled and uncontrolled). |
| `showFlashButton` | `boolean` | `true` | Built-in flash pill (top-right). Auto-hidden when the mounted device has no torch (e.g. a standalone ultra-wide) and in AR mode. |

### Header chrome (opt-in)

Setting `headerTitle` renders a built-in top header; the settings gear is absorbed into it.

| Prop | Type | Notes |
|---|---|---|
| `headerTitle` | `string` | Shows the header when set. |
| `headerGuidance` | `string` | Subtitle / guidance pill under the title. |
| `onHeaderBack` | `() => void` | Renders a back affordance when provided. |
| `headerBackLabel` | `string` | Custom back-button label. |
| `headerColors` | `object` | Override header colours. |

### Capture history + post-stitch preview

| Prop | Type | Notes |
|---|---|---|
| `thumbnails` | `CaptureThumbnailItem[]` | When supplied (even `[]`), renders the built-in thumbnail strip. Hidden during recording. |
| `thumbnailsMin` / `thumbnailsMax` | `number` | Optional count-line hints (e.g. quota guidance). |
| `onThumbnailPress` | `(item) => void` | Replaces the strip's built-in tap-to-preview with your handler. |
| `capturePreview` | `{ imageUri; imageWidth?; imageHeight?; title? }` | When set, renders the built-in preview modal. Controlled — clear it via `onCapturePreviewClose`. |
| `capturePreviewActions` | `CapturePreviewAction[]` | Action buttons for the preview modal (e.g. Save / Retake). |
| `onCapturePreviewClose` | `() => void` | Fires when the preview modal is dismissed. |

### Callbacks & advanced

| Prop | Type | Fires / purpose |
|---|---|---|
| `onCapture` | `(result: CameraCaptureResult) => void` | Fires once per capture attempt. **Gate on `result.ok` first** (`true` = output present, discriminated further by `result.type`; `false` carries `result.error`). Both carry `result.warnings: CaptureWarning[]` (e.g. `LOW_FRAME_UTILIZATION`). |
| `onCaptureSourceChange` | `(source: CaptureSource) => void` | Effective source changes (AR toggle, or 0.5× forcing non-AR). |
| `onLensChange` | `(lens: CameraLens) => void` | User taps the 1×/0.5× chip. |
| `onFramesDropped` | `(info: FramesDroppedInfo) => void` | cv::Stitcher's confidence retry dropped input frame(s). |
| `onCaptureAbandoned` | `(reason: 'orientation-drift') => void` | SDK auto-cancelled an in-flight capture (currently only mid-capture rotation). |
| `onError` | `(err: CameraError) => void` | Classified error — fires on failure as an unchanged mirror of the `ok:false` `onCapture` result. See codes below. |
| `outputDir` | `string` | Directory for saved JPEGs. The lib creates it if missing. |
| `engine` | `'batch-keyframe' \| …` | Stitching engine. Default `'batch-keyframe'`; most apps leave it. |
| `frameProcessor` | vision-camera frame processor | Host worklet composed with first-party stitching (see [`useStitcherWorklet`](docs/camera-component.md)). Advanced. |

### `CameraCaptureResult`

```ts
type CameraCaptureResult =
  | { type: 'photo'; uri: string; width: number; height: number }
  | { type: 'panorama'; uri: string; width: number; height: number;
      framesRequested: number; framesIncluded: number; framesDropped: number;
      finalConfidenceThresh: number; durationMs: number;
      stitchModeResolved?: 'panorama' | 'scans' };
```

### `CameraError` codes

`err.code` is one of a fixed taxonomy so you can branch (toast vs retry vs report):
`CAMERA_PERMISSION_DENIED`, `CAMERA_DEVICE_UNAVAILABLE`, `PHOTO_CAPTURE_FAILED`,
`PANORAMA_START_FAILED`, `PANORAMA_FINALIZE_FAILED`, `STITCH_NEED_MORE_IMGS`,
`STITCH_HOMOGRAPHY_FAIL`, `STITCH_CAMERA_PARAMS_FAIL`, `STITCH_OOM`,
`OUTPUT_WRITE_FAILED`, plus `VISION_CAMERA_RUNTIME`.

#### Friendly copy for recoverable stitch failures — `userFacingStitchError`

The four `STITCH_*` codes are *recoverable*: the user can usually fix them by
re-capturing (pan more slowly, pivot in place, shorten the sweep). For those,
the SDK exports `userFacingStitchError(code)` — it returns
`{ title, message }` of vetted, action-guiding copy you can drop straight into a
host `Alert`/toast (instead of surfacing the raw `cv::Stitcher` diagnostic), and
returns `null` for every non-recoverable code so you fall back to your generic
error UI:

```tsx
import {
  Camera,
  userFacingStitchError,
  type UserFacingStitchError,
} from 'react-native-image-stitcher';
import { Alert } from 'react-native';

<Camera
  onError={(err) => {
    const friendly: UserFacingStitchError | null = userFacingStitchError(err.code);
    if (friendly) {
      Alert.alert(friendly.title, friendly.message); // "pan more slowly", "pivot in place", …
    } else {
      reportGenericError(err); // permission denied, device unavailable, etc.
    }
  }}
/>;
```

It lives in the SDK (not per-host) so every consumer shows the same guidance for
the same failure. The `example/` app uses it end-to-end. To localise this copy,
pass an `overrides` map as the second argument — see
[Internationalization](#internationalization-i18n) below.

## Internationalization (i18n)

Every user-facing string the SDK can show is **overridable** — there is no
bundled `locale` prop. By design you supply the translated strings from your
own i18n catalogue (i18next, FormatJS, etc.); the SDK never ships translations
it can't keep in sync with your wording. There are exactly **two** surfaces, and
together they cover **100 %** of what a user reads:

### 1. `guidanceCopy` — everything the SDK renders on screen

A single `Partial<GuidanceCopy>` prop. Pass the keys you want to translate;
omitted keys fall back to the English default. This covers the rotate prompt,
the pan hint, the live "too fast" cue, the lateral-drift popups, the crop-editor
buttons, the **capture-status banner**, and the **crop-editor warning banners**:

| Key | Group | English default |
| --- | --- | --- |
| `rotateToLandscape` | rotate prompt | `Rotate to landscape` |
| `rotateToPortrait` | rotate prompt | `Rotate to portrait` |
| `panHint` | pan how-to | `Pan slowly top to bottom` |
| `tooFast` | speed cue | `Moving too fast — slow down` |
| `lateralStopTitle` / `lateralStopBody` / `lateralStopDismiss` | lateral popup (stitched) | `Keep the pan straight` / … / `Got it` |
| `lateralWrongDirectionTitle` / `lateralWrongDirectionBody` | lateral popup (too few frames) | `Follow the arrow` / … |
| `cropConfirm` / `cropReset` / `cropUseOriginal` / `cropRetake` | crop buttons | `Crop` / `Reset` / `Use original` / `Retake` |
| `previewConfirm` | preview-only accept button (`showPreview`) | `Confirm` |
| `statusRecording` | status banner | `Hold steady — pan slowly` |
| `statusStitching` | status banner | `Stitching panorama…` |
| `warnLowFrameUtilization` | crop warning **(template)** | `Only {included} of {requested} captured frames ({percent}%) could be used — …` |
| `warnLateralDriftFinalize` | crop warning | `Capture stopped early because the phone drifted sideways — …` |
| `warnHighPanSpeed` | crop warning | `The capture was taken faster than the recommended pace — …` |

> **Templates:** `warnLowFrameUtilization` is interpolated at runtime — your
> translation must keep the `{included}`, `{requested}` and `{percent}`
> placeholders (an unknown placeholder is left verbatim rather than throwing).
> Overriding a `warn*` key re-words **both** the on-screen banner **and** the
> `message` carried on `onCapture(...).warnings[]`. The matching machine-readable
> `code` (e.g. `HIGH_PAN_SPEED`) is always present regardless of wording, so you
> can also branch on the code instead of the string.

### 2. `userFacingStitchError(code, overrides?)` — the host-rendered error alert

The recoverable-stitch-error copy is rendered by **you** (in `onError`), so it's
localised at the call site: pass an `overrides` map (keyed by the codes in the
exported `RECOVERABLE_STITCH_CODES`) and any match wins over the bundled English;
omitted codes keep the default.

```tsx
import {
  Camera,
  userFacingStitchError,
  RECOVERABLE_STITCH_CODES,
  DEFAULT_GUIDANCE_COPY,
  type GuidanceCopy,
  type UserFacingStitchErrorOverrides,
} from 'react-native-image-stitcher';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';

function CaptureScreen() {
  const { t } = useTranslation();

  // (1) SDK-rendered copy — translate the keys you care about.
  const guidanceCopy: Partial<GuidanceCopy> = {
    rotateToLandscape: t('pano.rotateToLandscape'),
    statusRecording: t('pano.statusRecording'),
    // keep the placeholders in the template translation:
    warnLowFrameUtilization: t('pano.warnLowFrames'), // "{included}/{requested} ({percent}%) …"
    // …any subset; the rest stay English via DEFAULT_GUIDANCE_COPY
  };

  // (2) Host-rendered error alerts — translate by code.
  const errorCopy: UserFacingStitchErrorOverrides = Object.fromEntries(
    RECOVERABLE_STITCH_CODES.map((code) => [
      code,
      { title: t(`pano.err.${code}.title`), message: t(`pano.err.${code}.msg`) },
    ]),
  );

  return (
    <Camera
      guidanceCopy={guidanceCopy}
      onError={(err) => {
        const friendly = userFacingStitchError(err.code, errorCopy);
        if (friendly) Alert.alert(friendly.title, friendly.message);
        else reportGenericError(err);
      }}
    />
  );
}
```

`DEFAULT_GUIDANCE_COPY` and `DEFAULT_CAPTURE_WARNING_COPY` are exported so you can
seed your translation catalogue from the source strings, and
`RECOVERABLE_STITCH_GUIDANCE` exposes the built-in error copy for the same reason.

### Migration from 0.13.x

- **Removed:** the `panGuide` and `panoramaGuidance` props (the
  drift-marker overlay + pan-speed pill). They are no longer part of the
  public API and `<Camera>` no longer renders them. Remove these props
  if you were passing them — they're now a no-op type error.
- **Added:** `captureSources` (above).
- **Behaviour:** flash + AR controls moved to a top-right pill stack; the
  0.5× chooser now reflects real device capability; Android self-locks to
  portrait. No code change required for any of these.

## Orientation support

> **Recommended: portrait.**  `<Camera>` is designed and tuned for
> portrait capture, and that is the recommended way to use it on both
> platforms.  Landscape is supported on iOS for hosts that need it
> (see below); on Android the camera is always portrait.

**Android — always portrait (SDK-enforced).**  On Android `<Camera>`
locks its host Activity to portrait while mounted (via
`Activity.setRequestedOrientation`), **regardless of the host app's
manifest** — even a fully landscape or unlocked host gets a portrait
camera screen.  The prior orientation is restored when `<Camera>`
unmounts.  No host setup is required and there is no opt-out: Android
capture is portrait-only by design.

**iOS — portrait recommended, landscape supported.**  iOS supported
orientations are owned by the host's `Info.plist`
(`UISupportedInterfaceOrientations`); the SDK does not override them.

- *Portrait-only host* (Info.plist = Portrait — **recommended**): the
  screen stays portrait; the SDK uses sensor-derived orientation for
  capture-mode selection and overlay layout.  Simplest configuration.
- *Non-locked host* (Info.plist supports all 4 — supported for apps
  with other landscape-friendly screens): the screen rotates with the
  device.  `<Camera>`'s controls (shutter, lens chip, AR toggle) and
  the live thumbnail strip/band anchor to the home-indicator edge so
  they stay within thumb reach regardless of tilt — matching iOS
  Camera's behaviour.  The orientation-aware logic combines
  `useWindowDimensions()` (JS-layout) with `useDeviceOrientation()`
  (sensor) to compute the correct anchor.

**Mid-capture rotation safety** — the incremental engine doesn't
support cross-orientation captures (a portrait capture's keyframes
can't be mixed with landscape-pan frames).  If the user rotates
mid-capture, `<Camera>` auto-abandons via `incremental.cancel()`,
fires `onCaptureAbandoned('orientation-drift')` if the host wired
the callback, and shows the `OrientationDriftModal` to explain why.
Host opt-in via the `onCaptureAbandoned` prop — the default UX is
the modal alone.

## Lens ↔ AR interaction

The lens chooser and AR toggle interact, because ARKit/ARCore sessions
can't switch to the ultra-wide. With `captureSources="both"` (default):

| Action | AR preference | Lens | UI |
|---|---|---|---|
| Initial mount (defaults) | on | `1×` | AR pill ON |
| Switch to 0.5× | unchanged | `0.5×` | AR pill HIDDEN; capture forced non-AR |
| Switch back to 1× | unchanged | `1×` | AR pill visible at its previous state |
| Tap AR pill off (on 1×) | off | `1×` | AR pill OFF |

When `captureSources` is `'ar'` or `'non-ar'`, the AR pill never shows
(nothing to toggle), and `'ar'` additionally hides the lens chooser. The
component owns this runtime state; persist across launches via the
`on*Change` callbacks if desired.

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
