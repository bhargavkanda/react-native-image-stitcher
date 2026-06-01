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
| `defaultCompositingResolMP`<br/>`defaultRegistrationResolMP`<br/>`defaultSeamEstimationResolMP` | `number` | — | Forward-looking cv::Stitcher resolution knobs (currently no-ops). |

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
