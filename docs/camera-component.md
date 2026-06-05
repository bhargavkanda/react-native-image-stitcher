# `<Camera>` — Component reference

`<Camera>` is the flagship public component of
`react-native-image-stitcher`.  One component handles both
**tap-to-photo** and **hold-to-pan-panorama** modes, automatically
picks the right capture path (ARKit/ARCore vs. vision-camera +
IMU), and — from v0.13 onwards — ships every UX chrome piece
(flash button, pan guides, header, thumbnail strip, post-stitch
preview) as built-in opt-out defaults so a host can render a
complete capture surface with a single component.

This document is the canonical prop reference.  For native
side wiring (Info.plist, Gradle, peer deps) read
[`host-app-integration.md`](host-app-integration.md) first.

## Contents

- [Quick start](#quick-start)
- [How the component is wired](#how-the-component-is-wired)
- [Prop reference](#prop-reference)
  - [Capture defaults (uncontrolled)](#capture-defaults-uncontrolled)
  - [Mode toggles](#mode-toggles)
  - [Output destination](#output-destination)
  - [Flash control (v0.13)](#flash-control-v013)
  - [Pan guidance (v0.13)](#pan-guidance-v013)
  - [Header (v0.13)](#header-v013)
  - [Thumbnails + post-stitch preview (v0.13)](#thumbnails--post-stitch-preview-v013)
  - [Engine + frame processor](#engine--frame-processor)
  - [Callbacks](#callbacks)
  - [Layout / style](#layout--style)
- [`CameraCaptureResult` shape](#cameracaptureresult-shape)
- [`CameraError` shape](#cameraerror-shape)
- [Orientation behaviour](#orientation-behaviour)
- [Common compositions](#common-compositions)
- [Opting out of built-ins](#opting-out-of-built-ins)

## Quick start

```tsx
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
} from 'react-native-image-stitcher';

export function CaptureScreen() {
  return (
    <Camera
      defaultCaptureSource="ar"
      defaultLens="1x"
      onCapture={(result: CameraCaptureResult) => {
        if (result.type === 'photo') {
          // Tap-to-photo result.
          console.log(result.uri, result.width, result.height);
        } else {
          // Hold-to-pan panorama result.
          console.log(
            result.uri,
            `${result.framesIncluded}/${result.framesRequested} frames`,
          );
        }
      }}
      onError={(err: CameraError) => console.warn(err.code, err.message)}
    />
  );
}
```

That's a fully functional capture screen — preview, shutter, lens
chip, AR toggle, pan guides, flash button, drift detection.  Every
piece beyond the preview is opt-out (see below).

## How the component is wired

`<Camera>` follows React's `<input>` convention: the component
**owns its runtime state** (capture source, lens, flash, settings)
and notifies the parent via `on*Change` callbacks.  Props prefixed
`default*` are read once at mount as initial values.  This is the
"uncontrolled" model from the original design doc.

A few props are also **controlled** (`flash` / `capturePreview` /
`thumbnails`) — supplying them hands ownership of that piece back
to the parent.  See each prop's section for the rules.

## Prop reference

### Capture defaults (uncontrolled)

Initial values read once at mount.  After mount the component
owns this state; the parent observes changes via the
corresponding `on*Change` callback.

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `defaultCaptureSource` | `'ar' \| 'non-ar'` | `'ar'` | Initial capture-source preference.  Forced to `'non-ar'` on devices without ARKit / ARCore and when `lens === '0.5x'`. |
| `defaultLens` | `'1x' \| '0.5x'` | `'1x'` | Initial physical lens.  Selecting `'0.5x'` always forces non-AR (ARKit / ARCore sessions can't expose ultra-wide). |
| `defaultStitchMode` | `'auto' \| 'panorama' \| 'scans'` | `'auto'` | cv::Stitcher pipeline for batch-keyframe finalize.  `'auto'` lets the native auto-resolver pick PANORAMA vs SCANS from IMU-translation magnitude. |
| `defaultBlender` | `'multiband' \| 'feather'` | `'multiband'` | cv::Stitcher blender.  Multiband is higher quality; feather is faster. |
| `defaultSeamFinder` | `'graphcut' \| 'skip'` | `'graphcut'` | Seam-finder strategy.  `'skip'` is faster but visible seam ghosts. |
| `defaultWarper` | `'plane' \| 'cylindrical' \| 'spherical'` | `'plane'` | cv::Stitcher warper.  Cylindrical/spherical handle wider pans without distortion at the edges. |
| `defaultFlowNoveltyPercentile` | `number` | `0.85` | Flow-novelty threshold for keyframe acceptance.  Range `0.50 – 0.99`.  Higher = stricter (fewer accepts). |
| `defaultFlowEvalEveryNFrames` | `number` | `5` | Evaluate flow novelty every N producer frames.  Range `1 – 10`.  Lower = more CPU. |
| `defaultFlowMaxTranslationCm` | `number` | `50` | IMU-translation budget for force-accept (non-AR).  `0` disables the IMU gate. |
| `defaultKeyframeMaxCount` | `number` | `6` | Hard cap on accepted keyframes.  Engine force-finalises at this count.  Range `3 – 10`. |
| `defaultKeyframeOverlapThreshold` | `number` | `0.20` | Minimum projected overlap between consecutive keyframes (AR mode plane-overlap gate).  Range `0.20 – 0.60`. |
| `defaultCompositingResolMP` | `number` | — | **Forward-looking, no-op in v0.13.**  Wires through to cv::Stitcher's `compositingResol` once PanoramaSettings exposes the field. |
| `defaultRegistrationResolMP` | `number` | — | **Forward-looking, no-op in v0.13.**  Wires through to cv::Stitcher's `registrationResol`. |
| `defaultSeamEstimationResolMP` | `number` | — | **Forward-looking, no-op in v0.13.**  Wires through to cv::Stitcher's `seamEstimationResol`. |

### Mode toggles

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `enablePhotoMode` | `boolean` | `true` | Allow tap-to-photo captures.  When `false`, tapping the shutter is a no-op. |
| `enablePanoramaMode` | `boolean` | `true` | Allow hold-to-pan panorama captures.  When `false`, holding the shutter is a no-op. |
| `showSettingsButton` | `boolean` | `false` | Render the internal settings gear (top-right standalone, or absorbed into `CaptureHeader` if `headerTitle` is set).  Internal-tester surface — public consumers leave this off and ship their own settings UX. |

### Output destination

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `outputDir` | `string` | — | Destination directory for captures.  When set, photos land at `${outputDir}/photo-${ts}.jpg` and panoramas at `${outputDir}/panorama-${ts}.jpg`; the returned `uri` points at the persisted file.  When omitted, captures land in vision-camera's tmp dir (lost on next launch).  Bare path or `file://` URI both accepted.  Host responsibilities: writable directory, exists or createable, user-visibility flags (`UIFileSharingEnabled` / MediaStore).  Requires `expo-file-system` as an optional peer dep. |

### Flash control (v0.13)

The flash button is built into the bottom-left bar slot.  AR mode
auto-disables the button because ARKit / ARCore own the
`AVCaptureDevice` and don't expose the torch through vision-camera's
pipeline — the button greys out with a "Flash unavailable in AR
mode" accessibility label.

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `flash` | `'on' \| 'off'` | — | **Controlled mode.**  When supplied, the parent owns flash state.  The built-in button still renders + fires `onFlashChange` on press, but the visible state only flips when the parent updates this prop.  When omitted, `<Camera>` owns state internally. |
| `onFlashChange` | `(next: 'on' \| 'off') => void` | — | Fires when the user taps the built-in flash button.  In uncontrolled mode, the internal state has already flipped (single render delay).  Useful for telemetry in both modes. |
| `showFlashButton` | `boolean` | `true` | Show the built-in flash button.  Set `false` to render your own flash chrome (drive the torch via the controlled `flash` prop). |

### Pan guidance (v0.13)

Two real-time overlays that help the user pan correctly during a
panorama capture.  Both are gyroscope-driven and **only subscribe to
the sensor while recording** — no idle cost when the screen is up
but no capture is in flight.

| Prop | Type | Default | Purpose |
|---|---|---|---|

### Header (v0.13)

A top-of-screen header with title, optional back affordance, and
optional guidance subtitle.  Renders the existing settings gear in
its right slot (no duplicate gear when both are enabled).

The header is opt-in: it appears only when `headerTitle` is set.
Hosts that want richer header chrome can leave `headerTitle`
undefined and compose their own `<CaptureHeader>` above `<Camera>`.

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `headerTitle` | `string` | — | Title shown centred in the header.  Setting this opts in to the built-in header. |
| `onHeaderBack` | `() => void` | — | Back-button callback.  When supplied, the header renders `‹ Back` (or `headerBackLabel`) on the left.  Omit to hide back. |
| `headerBackLabel` | `string` | `'‹ Back'` | Custom label for the back button. |
| `headerGuidance` | `string` | — | Second-line subtitle shown below the title row.  E.g. `"Photograph the promotional cola end cap."` |
| `headerColors` | `{ background?, title?, accent?, guidanceBackground?, guidanceText? }` | white-on-black | Colour overrides for the header.  Defaults are tuned for legibility over the camera preview. |

### Thumbnails + post-stitch preview (v0.13)

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `thumbnails` | `CaptureThumbnailItem[]` | — | Captures to render in the built-in thumbnail strip above the bottom controls.  Items are plain `{ id, uri, width?, height? }`.  Supplying `[]` shows an empty strip with the count line; supplying `undefined` skips the strip entirely.  **Hidden during recording** so it doesn't overlap the panorama band overlay.  Captures emitted by `<Camera>`'s `onCapture` are NOT added to this array automatically — the host owns the canonical list (typically persisted to its own DB) and updates the prop. |
| `thumbnailsMin` | `number` | — | Minimum-photos hint for the count line.  Below this, the count text uses the warning colour; at or above, success colour. |
| `thumbnailsMax` | `number` | — | Maximum-photos hint for the count line.  Renders `· N max` suffix.  No enforcement — the host decides what to do at the cap. |
| `onThumbnailPress` | `(item: CaptureThumbnailItem) => void` | — | Tap handler for thumbnails.  When set, replaces the strip's built-in tap-to-preview modal with a host handler.  Omit to use the built-in preview. |
| `capturePreview` | `{ imageUri, imageWidth?, imageHeight?, title? }` | — | Show the built-in full-screen `CapturePreview` modal.  Use for post-stitch confirmation: after `onCapture` fires, set this to the new image with `capturePreviewActions` = `[Discard, Save]` (or similar).  Setting `undefined` hides the modal. |
| `capturePreviewActions` | `CapturePreviewAction[]` | — | Action buttons along the bottom of the preview modal.  Each is `{ label, icon?, variant?, disabled?, onPress }`.  Up to 3 display cleanly across typical phone widths. |
| `onCapturePreviewClose` | `() => void` | — | Fires when the user dismisses the preview (close button, backdrop tap, hardware back).  Host is expected to clear the `capturePreview` prop in response. |

### Engine + frame processor

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `engine` | `'batch-keyframe'` | `'batch-keyframe'` | Which stitcher engine to drive.  `'batch-keyframe'` collects accepted JPEGs and runs cv::Stitcher once at finalize.  (The live/incremental engines — hybrid, slit-scan, firstwins — were archived in v0.15.0; only batch-keyframe ships.) |
| `frameProcessor` | `ReadonlyFrameProcessor \| DrawableFrameProcessor` | — | **Host-supplied vision-camera frame processor.**  Build it with `react-native-vision-camera`'s own `useFrameProcessor` (the lib's wrapper hook was removed in v0.15.0) and compose first-party stitching via `useStitcherWorklet().call(frame)`.  Composes through to BOTH AR mode (auto-registered via the AR-session dispatch path) and non-AR mode.  See the JSDoc on `CameraProps.frameProcessor` in `src/camera/Camera.tsx`. |

### Callbacks

| Prop | Signature | Fires when |
|---|---|---|
| `onCapture` | `(result: CameraCaptureResult) => void` | Photo or panorama capture completes successfully.  `result.type` discriminates `'photo'` vs `'panorama'`.  See [`CameraCaptureResult` shape](#cameracaptureresult-shape). |
| `onCaptureSourceChange` | `(source: 'ar' \| 'non-ar') => void` | Effective capture source changes — e.g. the user toggles AR, switches lens, or the AR-support probe resolves to `false` post-mount.  Fires the derived effective source, not the raw `arPreference`. |
| `onLensChange` | `(lens: '1x' \| '0.5x') => void` | User taps the lens chip. |
| `onFramesDropped` | `(info: { requested, included }) => void` | Fires once per panorama capture if cv::Stitcher's C+D progressive-confidence retry loop dropped one or more input frames. |
| `onError` | `(err: CameraError) => void` | Classified error — code from a known taxonomy (`STITCH_*`, `CAMERA_*`, `PHOTO_CAPTURE_FAILED`, `PANORAMA_*`, `OUTPUT_WRITE_FAILED`, `VISION_CAMERA_RUNTIME`).  See [`CameraError` shape](#cameraerror-shape). |
| `onCaptureAbandoned` | `(reason: 'orientation-drift') => void` | SDK auto-cancelled an in-progress capture without producing output.  Currently the only reason in v0.13 is `'orientation-drift'` (user rotated between Mode A and Mode B mid-capture).  Host typically uses this to clean up wizard state or log telemetry; the SDK already surfaces `OrientationDriftModal` for the user-facing explanation. |

### Layout / style

| Prop | Type | Default | Purpose |
|---|---|---|---|
| `style` | `StyleProp<ViewStyle>` | — | Outer container style.  Defaults to `flex: 1` on a black background.  Override `flex` / `width` / `height` to embed `<Camera>` inside a sized container. |

## `CameraCaptureResult` shape

Discriminated union emitted via `onCapture`.

```ts
type CameraCaptureResult =
  | {
      type: 'photo';
      uri: string;
      width: number;
      height: number;
    }
  | {
      type: 'panorama';
      uri: string;
      width: number;
      height: number;
      framesRequested: number;     // Total ingested
      framesIncluded: number;       // Made it through cv::Stitcher
      framesDropped: number;        // requested - included
      finalConfidenceThresh: number;
      durationMs: number;           // Hold-start to finalize
      stitchModeResolved?: 'panorama' | 'scans';  // Which pipeline ran
    };
```

`uri` is always a `file://`-prefixed URI (Android `<Image>` requires
the scheme; iOS is lenient).

## `CameraError` shape

```ts
class CameraError extends Error {
  code: CameraErrorCode;
  cause?: unknown;
}

type CameraErrorCode =
  | 'CAMERA_PERMISSION_DENIED'
  | 'CAMERA_DEVICE_UNAVAILABLE'
  | 'PHOTO_CAPTURE_FAILED'
  | 'PANORAMA_START_FAILED'
  | 'PANORAMA_FINALIZE_FAILED'
  | 'STITCH_NEED_MORE_IMGS'
  | 'STITCH_HOMOGRAPHY_FAIL'
  | 'STITCH_CAMERA_PARAMS_FAIL'
  | 'STITCH_OOM'
  | 'OUTPUT_WRITE_FAILED'
  | 'VISION_CAMERA_RUNTIME'
  | 'UNKNOWN';
```

Branch on `err.code` to decide retry / toast / report behaviour.
`err.cause` carries the original error (vision-camera, cv::Stitcher,
filesystem) for inspection.

## Orientation behaviour

> **Recommended: portrait.**  `<Camera>` is designed and tuned for
> portrait capture — use portrait on both platforms unless you have a
> specific reason not to.  Landscape is supported on iOS only (via the
> host `Info.plist`); Android is always portrait.

**Android — always portrait (SDK-enforced).**  While `<Camera>` is
mounted it locks the host Activity to portrait via
`Activity.setRequestedOrientation(SCREEN_ORIENTATION_PORTRAIT)`,
**regardless of the host app's `AndroidManifest` `screenOrientation`**.
A landscape or unlocked host still gets a portrait camera screen.  The
Activity's prior `requestedOrientation` is captured on mount and
restored on unmount, so other screens in the host app keep their own
orientation.  This is enforced in the SDK (native `RNSARSession`
module + a `<Camera>` mount effect) and covers both the AR (ARCore)
and non-AR (vision-camera) capture paths.  There is no opt-out.

**iOS — host-controlled (`Info.plist`).**  The SDK does not override
iOS orientation; it follows the host's
`UISupportedInterfaceOrientations`.

- *Portrait-only* (`= Portrait` — **recommended**):  Screen stays
  portrait.  The SDK reads physical device orientation from the
  accelerometer for capture-mode selection and overlay layout.
- *Non-locked* (supports all 4 — supported):  OS rotates the
  framebuffer with the device.  `<Camera>`'s bottom controls and the
  thumbnail strip/band anchor to the home-indicator edge — JS-bottom
  in portrait, JS-right in landscape-left, JS-left in landscape-right
  — so the shutter stays within thumb reach.  This matches iOS Camera.
  Built-in modals (`CapturePreview`, `PanoramaConfirmModal`,
  `OrientationDriftModal`, `PanoramaSettingsModal`) declare all four
  `supportedOrientations` so they rotate with the interface.

**Mid-capture rotation safety**:  The incremental engine doesn't
support cross-orientation captures (the engine doc string at
`src/stitching/incremental.ts:373-403` is explicit).  If the user
rotates between Mode A (landscape + vertical pan) and Mode B
(portrait + horizontal pan) during a capture, `<Camera>`:

1. Calls `incremental.cancel()` to drop accumulated state.
2. Resets status to idle.
3. Fires `onCaptureAbandoned('orientation-drift')` (if wired).
4. Shows `OrientationDriftModal` with an OK button to explain.

No "Continue" affordance — continuing past drift produces malformed
output.

## Common compositions

### Minimal — just preview + capture

```tsx
<Camera onCapture={handleCapture} />
```

### With output directory and error handling

```tsx
<Camera
  outputDir={`${FileSystem.documentDirectory}captures/`}
  onCapture={handleCapture}
  onError={(err) => toast.error(err.code)}
/>
```

### Audit screen — header + thumbnails + post-stitch preview

```tsx
const [items, setItems] = useState<CaptureThumbnailItem[]>([]);
const [preview, setPreview] = useState<CapturePreviewPayload>();

return (
  <Camera
    headerTitle="Cola Promo End Cap"
    headerGuidance="Photograph the promotional cola end cap."
    onHeaderBack={() => navigation.goBack()}
    thumbnails={items}
    thumbnailsMin={3}
    thumbnailsMax={10}
    capturePreview={preview}
    capturePreviewActions={preview ? [
      { label: 'Discard', variant: 'destructive', onPress: discard },
      { label: 'Save',    variant: 'primary',     onPress: save    },
    ] : undefined}
    onCapturePreviewClose={() => setPreview(undefined)}
    onCapture={(result) => {
      setItems((prev) => [...prev, toThumbnailItem(result)]);
      setPreview(toPreviewPayload(result));
    }}
  />
);
```

### Controlled flash

```tsx
const [flash, setFlash] = useState<'on' | 'off'>('off');

return (
  <Camera
    flash={flash}
    onFlashChange={setFlash}
    onCapture={handleCapture}
  />
);
```

## Opting out of built-ins

Every v0.13 built-in is opt-out.  The matrix:

| Built-in | How to disable |
|---|---|
| Flash button | `showFlashButton={false}` |
| Header | omit `headerTitle` (or don't pass any header props) |
| Thumbnail strip | omit `thumbnails` (passing `undefined` skips; passing `[]` shows empty) |
| Post-stitch preview modal | omit `capturePreview` |
| Settings gear | `showSettingsButton={false}` (the default) |
| Lens chip | not opt-outable in v0.13 (always rendered when more than one physical lens is available — fixed `true` for now) |
| AR toggle | not opt-outable in v0.13 (rendered when `lens === '1x'` AND device supports AR) |
| Photo mode | `enablePhotoMode={false}` — tap is no-op |
| Panorama mode | `enablePanoramaMode={false}` — hold is no-op |
| Drift modal | not opt-outable — required for engine safety |

Hosts that disable all built-ins effectively get back the v0.12-era
"bare preview + shutter + lens + AR toggle" surface, with their own
chrome layered on top.  The Layer-2 components
(`CaptureHeader`, `IncrementalPanGuide`, `PanoramaGuidance`,
`CaptureThumbnailStrip`, `CapturePreview`, `CaptureControlsBar`)
remain exported in v0.13 for that use case; deprecation is
targeted for v0.14.
