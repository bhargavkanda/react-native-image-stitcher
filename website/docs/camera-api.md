---
id: camera-api
title: "<Camera> API"
sidebar_position: 4
---

# `<Camera>` — full prop reference

Every prop is optional. `<Camera>` works with no props (it captures and
you wire `onCapture`). Props fall into seven groups.

## Capture-source & lens

Uncontrolled — read once at mount.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `defaultCaptureSource` | `'ar' \| 'non-ar'` | `'ar'` | Initial capture path. Clamped to `captureSources`. |
| `captureSources` | `'ar' \| 'non-ar' \| 'both'` | `'both'` | Which sources are allowed. `'both'` shows the AR toggle. `'ar'` hides the AR toggle **and** the lens chooser (ARKit/ARCore can't use the ultra-wide). `'non-ar'` hides the AR toggle, keeps the lens chooser. A single-source value overrides a conflicting `defaultCaptureSource`. |
| `defaultLens` | `'1x' \| '0.5x'` | `'1x'` | Initial lens. The 0.5× chooser appears only if the device has a usable ultra-wide. |

See [Flash & lenses](./flash-and-lenses.md) for how lens selection,
device capability, and flash interact.

## Panorama / stitcher tunables

Uncontrolled internal-tester knobs; most apps never set these.

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
| `defaultMaxKeyframeIntervalMs` | `number` | `2000` | Time-budget force-accept: take a keyframe at least every N ms during a pan even if novelty is low, so slow/static pans don't leave gaps. Counts toward the keyframe cap. `0` = disabled. AR + non-AR. |
| `defaultCompositingResolMP`<br/>`defaultRegistrationResolMP`<br/>`defaultSeamEstimationResolMP` | `number` | — | Forward-looking cv::Stitcher resolution knobs (currently no-ops). |
| `maxInscribedRectCrop` | `boolean` | `false` | Opt in with `true` to crop the finished panorama to the largest inscribed rectangle (clean edges, no black corners) instead of the bounding box. See [Inscribed-rect crop](#inscribed-rect-crop) below. |

### Inscribed-rect crop

When `cv::Stitcher` warps the keyframes onto the output canvas, the filled
region is rarely a perfect rectangle — the edges curve and the corners are
often empty (black), especially on a wide pan or a `plane` / `cylindrical`
warp. `maxInscribedRectCrop` chooses how that canvas is cropped at finalize:

- **`false` (default)** — crop to the **bounding rectangle** of the non-black
  pixels (`cv::boundingRect`): keeps every stitched pixel, but can leave black
  corners where the projection didn't fill.
- **`true`** — crop to the **largest axis-aligned rectangle that fits entirely
  inside the stitched (coverage) region**: clean, straight edges and no black
  corners. The rectangle is computed from the stitch's coverage mask
  (`cv::Stitcher::resultMask`), morphologically closed to fill small holes, with
  a 50%-area safety floor — if the inscribed rectangle would be degenerate or
  smaller than half the bounding box (a lopsided mask), it falls back to the
  bounding-box crop. Because it shrinks the output to fit inside the filled
  region, it can crop away a lot on lopsided or ultra-wide pans — which is why
  it's **opt-in**.

Because the default is `false`, you only pass the prop when you want to **opt
in** to the inscribed-rect crop:

```tsx
// Default (false) — bounding-box crop, keeps every stitched pixel:
<Camera onCapture={handleCapture} />

// Opt in — clean inscribed rectangle, no black corners (may shrink the output):
<Camera onCapture={handleCapture} maxInscribedRectCrop={true} />
```

The prop seeds the initial value at mount; the in-app settings modal (gear) can
toggle it at runtime. It changes the output geometry, not the encoding.

## UI toggles

| Prop | Type | Default | Notes |
|---|---|---|---|
| `enablePhotoMode` | `boolean` | `true` | Tap = photo; no-op when false. |
| `enablePanoramaMode` | `boolean` | `true` | Hold + pan = panorama; no-op when false. |
| `showSettingsButton` | `boolean` | `false` | Gear → internal settings panel. Leave off for public consumers. |
| `style` | `StyleProp<ViewStyle>` | — | Outer container style. |

## Flash

Controlled or uncontrolled. See [Flash & lenses](./flash-and-lenses.md).

| Prop | Type | Default | Notes |
|---|---|---|---|
| `flash` | `'on' \| 'off'` | — | Controlled torch state. Omit to let `<Camera>` own it. |
| `onFlashChange` | `(next: 'on' \| 'off') => void` | — | Fires on flash-button tap. |
| `showFlashButton` | `boolean` | `true` | Built-in flash pill. Auto-hidden when the mounted device has no torch (e.g. a standalone ultra-wide) and in AR mode. |

## Header chrome (opt-in)

Setting `headerTitle` renders a built-in top header; the settings gear is
absorbed into it.

| Prop | Type | Notes |
|---|---|---|
| `headerTitle` | `string` | Shows the header when set. |
| `headerGuidance` | `string` | Guidance pill under the title. |
| `onHeaderBack` | `() => void` | Renders a back affordance when provided. |
| `headerBackLabel` | `string` | Custom back-button label. |
| `headerColors` | `object` | Override header colours. |

## Capture history + post-stitch preview

| Prop | Type | Notes |
|---|---|---|
| `thumbnails` | `CaptureThumbnailItem[]` | When supplied (even `[]`), renders the thumbnail strip. Hidden during recording. |
| `thumbnailsMin` / `thumbnailsMax` | `number` | Optional count-line hints. |
| `onThumbnailPress` | `(item) => void` | Replaces the strip's built-in tap-to-preview. |
| `capturePreview` | `{ imageUri; imageWidth?; imageHeight?; title? }` | Renders the built-in preview modal. Controlled — clear via `onCapturePreviewClose`. |
| `capturePreviewActions` | `CapturePreviewAction[]` | Action buttons for the preview modal. |
| `onCapturePreviewClose` | `() => void` | Fires when the preview modal is dismissed. |

## Callbacks & advanced

| Prop | Type | Fires / purpose |
|---|---|---|
| `onCapture` | `(result: CameraCaptureResult) => void` | Photo OR panorama completes. `result.type` discriminates. |
| `onCaptureSourceChange` | `(source: CaptureSource) => void` | Effective source changes. |
| `onLensChange` | `(lens: CameraLens) => void` | User taps the 1×/0.5× chip. |
| `onFramesDropped` | `(info: FramesDroppedInfo) => void` | cv::Stitcher's confidence retry dropped frame(s). |
| `onCaptureAbandoned` | `(reason: 'orientation-drift') => void` | SDK auto-cancelled an in-flight capture (mid-capture rotation). |
| `onError` | `(err: CameraError) => void` | Classified error — see [Capture result & errors](./capture-result.md). |
| `outputDir` | `string` | Directory for saved JPEGs (created if missing). |
| `engine` | `'batch-keyframe' \| …` | Stitching engine; default `'batch-keyframe'`. |
| `frameProcessor` | vision-camera processor | Host worklet composed with first-party stitching. Advanced. |

## Migration from 0.13.x

- **Removed:** `panGuide` and `panoramaGuidance` props (drift-marker +
  pan-speed pill). No longer public; `<Camera>` doesn't render them.
  Remove these props — they're now a no-op type error.
- **Added:** `captureSources`.
- **Behaviour (no code change needed):** flash + AR controls moved to a
  top-right pill stack; the 0.5× chooser reflects real device
  capability; Android self-locks to portrait.
