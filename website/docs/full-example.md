---
id: full-example
title: Complete example (all options)
sidebar_position: 4.5
---

# Complete example (all options)

Every prop below is optional — this single `<Camera>` exists only to show
the full surface in one place, with each prop set to its spec default
value (the settings JSONs are fully expanded so nothing is hidden) plus a
representative `guidanceCopy` override.

:::caution Not a copy-paste starter
This is a reference, not a recommended config. You almost never set most
of these — `<Camera>` works with no props at all. For a realistic
starting point use [Getting started](./getting-started.md), then reach for
the [`<Camera>` API](./camera-api.md) tables when you need a specific knob.
:::

```tsx
import React from 'react';
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type FramesDroppedInfo,
  type GuidanceCopy,
  type CaptureThumbnailItem,
} from 'react-native-image-stitcher';

export function FullyLoadedCamera() {
  return (
    <Camera
      // ── Capture source & lens ───────────────────────────────────────
      defaultCaptureSource="non-ar"
      defaultLens="1x"
      captureSources="both"
      engine="batch-keyframe"

      // ── Stitcher / frame-gate tunables (flat seeds) ─────────────────
      defaultStitchMode="auto"
      defaultBlender="multiband"
      defaultSeamFinder="graphcut"
      defaultWarper="plane"
      maxInscribedRectCrop={false}
      defaultFlowNoveltyPercentile={0.85}
      defaultFlowEvalEveryNFrames={5}
      defaultFlowMaxTranslationCm={50}
      defaultKeyframeMaxCount={6}
      defaultKeyframeOverlapThreshold={0.2}
      defaultMaxKeyframeIntervalMs={1500}
      // defaultCompositingResolMP / defaultRegistrationResolMP /
      // defaultSeamEstimationResolMP are forward-looking no-ops — omitted.

      // ── Stitcher config as a JSON object (wins over the flat seeds) ──
      stitcher={{
        warperType: 'plane',
        blenderType: 'multiband',
        seamFinderType: 'graphcut',
        stitchMode: 'auto',
        enableMaxInscribedRectCrop: false,
      }}

      // ── Frame-selection config as a JSON object (deep-merged flow) ──
      frameSelection={{
        mode: 'flow-based',
        maxKeyframes: 6,
        overlapThreshold: 0.2,
        maxKeyframeIntervalMs: 1500,
        flow: {
          noveltyPercentile: 0.85,
          evalEveryNFrames: 5,
          maxTranslationCm: 50,
          maxCorners: 150,
          qualityLevel: 0.01,
          minDistance: 10,
        },
      }}

      // ── Panorama guidance ───────────────────────────────────────────
      panMode="vertical"
      panGuidance={true}
      maxPanDurationMs={0}
      panTooFastThreshold={0.6}
      lateralBudgetCm={8}
      lateralStopFinalizeMinFrames={5}
      rectCrop={false}
      showPreview={false}
      guidanceCopy={{
        rotateToLandscape: 'Turn your phone sideways',
        panHint: 'Pan slowly, top to bottom',
        tooFast: 'Too fast — ease off',
        statusRecording: 'Hold steady — pan slowly',
        statusStitching: 'Building your panorama…',
      }}

      // ── UI toggles ──────────────────────────────────────────────────
      enablePhotoMode={true}
      enablePanoramaMode={true}
      showSettingsButton={false}
      style={{ flex: 1, backgroundColor: '#000' }}

      // ── Output ──────────────────────────────────────────────────────
      // outputDir requires the expo-file-system optional peer dep:
      // outputDir="file:///…/captures"

      // ── Flash (uncontrolled here; omit `flash` to let Camera own it) ─
      showFlashButton={true}
      onFlashChange={(next) => console.log('flash:', next)}

      // ── Header chrome ───────────────────────────────────────────────
      headerTitle="Capture"
      headerGuidance="Tap for a photo · hold + pan for a panorama"
      headerBackLabel="‹ Back"
      onHeaderBack={() => console.log('back')}
      headerColors={{}}

      // ── Capture history (thumbnail strip) ───────────────────────────
      thumbnails={[] as CaptureThumbnailItem[]}
      thumbnailsMin={3}
      thumbnailsMax={12}
      onThumbnailPress={(item) => console.log('thumb:', item.id)}

      // ── Post-stitch preview modal (controlled — omitted when hidden) ─
      // capturePreview={{ imageUri }}
      capturePreviewActions={[]}
      onCapturePreviewClose={() => console.log('preview closed')}

      // ── Callbacks ───────────────────────────────────────────────────
      onCapture={(result: CameraCaptureResult) => {
        if (!result.ok) {
          console.warn(result.error.code, result.error.message);
          return;
        }
        console.log(result.type, result.uri, result.width, result.height);
      }}
      onCaptureSourceChange={(source: CaptureSource) =>
        console.log('source:', source)
      }
      onLensChange={(lens: CameraLens) => console.log('lens:', lens)}
      onFramesDropped={(info: FramesDroppedInfo) =>
        console.log('dropped:', info.included, '/', info.requested)
      }
      onCaptureAbandoned={(reason) => console.log('abandoned:', reason)}
      onError={(err: CameraError) => console.warn(err.code, err.message)}

      // ── Frame processor (advanced; host-supplied vision-camera worklet) ─
      // Omitted by default — supply your own only if you compose extra
      // per-frame work. See the "Frame processor" group below.
      // frameProcessor={frameProcessor}
    />
  );
}
```

The rest of this page walks through each prop **group** so you know which
knobs matter and when to touch them. The exhaustive type/default tables
live in the [`<Camera>` API](./camera-api.md) — this is the tour, not the
catalogue.

## Capture source & lens

`defaultCaptureSource`, `defaultLens`, `captureSources`, and `engine` are
read once at mount (uncontrolled). The one to think about is
`captureSources`: `'both'` shows the AR toggle, `'ar'` is AR-only (it
hides the toggle **and** the 0.5× chooser, since ARKit/ARCore can't drive
the ultra-wide), and `'non-ar'` hides the toggle. A single-source value
overrides a conflicting `defaultCaptureSource`. `engine` only accepts
`'batch-keyframe'`. See the
[Capture-source & lens table](./camera-api.md#capture-source--lens).

:::note Component default vs settings default
The component default for `defaultCaptureSource` is `'non-ar'`, even though
the underlying `DEFAULT_PANORAMA_SETTINGS.captureSource` is `'ar'`. The
component's prop default wins.
:::

## Stitcher & frame-gate tunables

These are internal-tester knobs; most apps never set them. There are two
ways to pass them, and both are shown above:

- **Flat seeds** — `defaultStitchMode`, `defaultBlender`,
  `defaultSeamFinder`, `defaultWarper`, `maxInscribedRectCrop`, the four
  `defaultFlow*` / `defaultKeyframe*` values, and `defaultMaxKeyframeIntervalMs`.
- **JSON objects** (v0.16) — `stitcher` (a `Partial<BatchStitcherSettings>`)
  and `frameSelection` (a `Partial<FrameSelectionSettings>`, with `flow`
  deep-merged). **Any field set in the JSON object wins over the matching
  flat `default*` prop**, and the in-app gear panel still overrides both at
  capture time.

Notable knobs: `stitchMode: 'auto'` resolves PANORAMA vs SCANS from the
pose at finalize; `blenderType`/`seamFinderType` trade seam quality for
peak memory (`multiband` + `graphcut` = cleaner, more memory; `feather` +
`skip` = streaming, lowest memory); `frameSelection.mode: 'flow-based'`
(the default) runs Shi-Tomasi + KLT for translation-aware keyframing.
`defaultCompositingResolMP` / `defaultRegistrationResolMP` /
`defaultSeamEstimationResolMP` are accepted for API stability but are
currently no-ops, so they're commented out above. All the numeric fields
are clamped natively (e.g. `maxKeyframes` to `[3, 10]`,
`overlapThreshold` to `[0.10, 0.80]`). Full ranges in the
[Stitcher tunables table](./camera-api.md#stitcher-tunables).

:::tip Prefer the JSON objects
For new code, set `stitcher={{…}}` and `frameSelection={{…}}` rather than
the flat `default*` props — they're the v0.16 surface, they group related
fields, and they win over the flat seeds anyway.
:::

## Panorama guidance

`panMode` chooses the device hold the non-AR pano accepts — `'vertical'`
(the default) is landscape-only, top-to-bottom; `'horizontal'` is
portrait-only, left-to-right; `'both'` drops the rotate gate. `panGuidance`
is the master switch for the in-capture coaching surfaces (rotate prompt,
pan how-to, too-fast pill, blinking countdown).

The auto-stop levers are worth understanding: `maxPanDurationMs` defaults
to `0` (disabled) — the keyframe-count cap is the primary auto-stop, and
the time ceiling is opt-in. `lateralBudgetCm` (default `8`) stops the
capture once sideways drift exceeds the budget; `0` disables it, and
`lateralStopFinalizeMinFrames` (default `5`) decides whether that stop keeps
and stitches the partial sweep or discards it outright. The default discards
anything under 5 keyframes — a behaviour change from the previously hardcoded
2 — so pass `2` for the old rule, or `0` so a drifted capture is never kept.
`panTooFastThreshold` (resolves to `0.6` rad/s) flags an over-fast pan.
`rectCrop` shows the draggable-quad perspective-crop editor after finalize
and takes precedence over `showPreview` (a plain Retake/Confirm screen);
with both off, `onCapture` fires immediately with no review UI. See the
[Panorama capture & guidance](./camera-api.md#panorama-capture--guidance-v016) section.

For `guidanceCopy`, pass a `Partial<GuidanceCopy>` — only the keys you
override change; everything else falls back to `DEFAULT_GUIDANCE_COPY`. The
example overrides a representative handful; the warning-template keys keep
their `{included}`/`{requested}`/`{percent}` placeholders. The full key
list and translation workflow are in [Internationalization](./i18n.md).

## UI toggles

`enablePhotoMode` and `enablePanoramaMode` gate the two capture gestures
(both `true` by default). `showSettingsButton` exposes the internal gear
panel — leave it `false` for public consumers. `style` is applied to the
`<Camera>` root container.

## Output

`outputDir` (bare path or `file://` URI) redirects saved captures —
photos to `${outputDir}/photo-${ts}.jpg`, panoramas to
`${outputDir}/panorama-${ts}.jpg`. It requires the optional
`expo-file-system` peer dep, and a disk failure rejects via `onError` with
`OUTPUT_WRITE_FAILED`. Omit it to use vision-camera's tmp dir. It's left
commented out above because the path is host-specific.

## Flash

`flash` is controlled-or-uncontrolled: omit it (as above) and `<Camera>`
owns the torch internally (button toggles, internal default `'off'`);
supply it and the parent owns it. `onFlashChange` fires on the built-in
button tap, and `showFlashButton` (default `true`) renders that button.
AR mode forces the torch off. See [Flash & lenses](./flash-and-lenses.md).

## Header chrome

The header is opt-in: it renders only when `headerTitle` is set, and the
settings gear is absorbed into its right side. `onHeaderBack` adds a back
affordance (labelled by `headerBackLabel`), `headerGuidance` adds a
second-line subtitle, and `headerColors` overrides the default
white-on-black palette. All four are no-ops without `headerTitle`. See the
[Header chrome](./camera-api.md#header-chrome-opt-in) table.

## Capture history (thumbnails)

Pass `thumbnails` (even an empty `[]`) to render the built-in thumbnail
strip above the bottom controls. The SDK does **not** auto-add capture
results — the host owns the canonical list. `thumbnailsMin` / `thumbnailsMax`
drive the count-line hint, and `onThumbnailPress` replaces the strip's
built-in tap-to-preview modal with your own UI.

## Post-stitch preview modal

`capturePreview` (controlled) renders the built-in confirmation modal when
set and hides it when `undefined` — clear it in response to
`onCapturePreviewClose`. It's omitted above because it's driven by capture
state; see the
[Post-stitch preview modal](./camera-api.md#post-stitch-preview-modal)
section. `capturePreviewActions` adds buttons along the bottom of that modal.

## Callbacks

`onCapture` **always fires once per capture attempt** (v0.16) — gate on
`result.ok` before reading `uri`/`width`/`height`, and read `result.error`
when `ok` is `false`. `onError` still fires on failure as an unchanged
mirror. The rest are notifications: `onCaptureSourceChange` /
`onLensChange` for the AR-toggle and lens-chip; `onFramesDropped` when
cv::Stitcher's confidence filtering dropped input frames; and
`onCaptureAbandoned` when the SDK auto-cancels an in-flight capture
without producing output (`'orientation-drift'` or `'lateral-drift'` — no
`onCapture` fires for an abandoned capture). The full result union and
error codes are in [Capture result & errors](./capture-result.md).

## Frame processor

`frameProcessor` (advanced, non-AR only) lets you supply your own
vision-camera frame processor in place of the lib's internal driver;
compose first-party stitching back in via `useStitcherWorklet`. It's not
set above — most hosts never touch it. See the
[Frame processor](./camera-api.md#frame-processor-advanced) section.
