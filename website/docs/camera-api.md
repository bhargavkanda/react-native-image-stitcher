---
id: camera-api
title: "<Camera> API"
sidebar_position: 4
---

# `<Camera>` — full prop reference

Every prop is optional. `<Camera>` works with no props — it captures, and
you wire `onCapture` to receive the result. The props fall into the groups
below, followed by deep-dives on panorama guidance, the JSON settings
objects, the `guidanceCopy` keys, and the allowed enum values.

:::note Defaults are the resolved runtime values
The defaults in these tables are the values the component actually
resolves at mount — cross-checked against the component destructure and
`DEFAULT_PANORAMA_SETTINGS` / `DEFAULT_FLOW_GATE_SETTINGS` — not the prop
JSDoc, which is stale in a few places. Where a JSDoc claim disagrees, the
table here is authoritative.
:::

## Capture source & lens

Uncontrolled — read once at mount.

| Prop | Type | Default | Description |
|---|---|---|---|
| `defaultCaptureSource` | `CaptureSource` (`'ar' \| 'non-ar'`) | `'non-ar'` | Initial capture source, read once at mount (uncontrolled). **Consider `'ar'`**: AR feeds the engine natively, so it is immune to the frame-processor build failure described in [Host integration](./host-integration.md#frame-processors--the-non-ar-capture-prerequisite) (caveats: on Android a device without Google Play Services for AR shows a blank AR preview with no automatic downgrade today; AR tap-photos use the AR video stream, no flash, no iOS depth sidecar). Clamped by `captureSources`. |
| `defaultLens` | `CameraLens` (`'1x' \| '0.5x'`) | `'1x'` | Initial physical lens. When `captureSources='ar'` the lens is forced to `'1x'` — the ultra-wide isn't usable in AR. |
| `captureSources` | `CaptureSourcesMode` (`'ar' \| 'non-ar' \| 'both'`) | `'both'` | Which capture sources the host allows. `'both'` shows the AR toggle; `'ar'` is AR-only (toggle **and** 0.5× chooser hidden); `'non-ar'` hides the toggle. A single source overrides a conflicting `defaultCaptureSource`. **Use `'ar'` to lock captures to AR and hide the AR pill so users can't flip modes.** |
| `engine` | `'batch-keyframe'` | `'batch-keyframe'` | Which stitcher engine to drive. Only `'batch-keyframe'` is supported and is the default. |

See [Flash & lenses](./flash-and-lenses.md) for how lens selection, device
capability, and flash interact.

## Stitcher tunables

Uncontrolled internal-tester knobs; most apps never set these. Each flat
`default*` prop seeds the matching field in the settings tree at mount.
v0.16 adds the [`stitcher`](#settings-json-objects) and
[`frameSelection`](#settings-json-objects) JSON-object props, which take
precedence over the flat props below.

| Prop | Type | Default | Description |
|---|---|---|---|
| `defaultStitchMode` | `StitchMode` (`'auto' \| 'panorama' \| 'scans'`) | `'auto'` | Initial `cv::Stitcher` pipeline mode seed. Resolves through `DEFAULT_PANORAMA_SETTINGS.stitcher.stitchMode`. |
| `defaultBlender` | `Blender` (`'multiband' \| 'feather'`) | `'multiband'` | Initial pixel blender seed (`DEFAULT_PANORAMA_SETTINGS.stitcher.blenderType`). |
| `defaultWarper` | `Warper` (`'plane' \| 'cylindrical' \| 'spherical'`) | `'plane'` | Initial output projection seed (PANORAMA mode only; SCANS hard-wires `plane`). Resolves to `DEFAULT_PANORAMA_SETTINGS.stitcher.warperType` — v0.16 reverted this from `'spherical'` back to `'plane'`. |
| `maxInscribedRectCrop` | `boolean` | `false` | Crop-strategy seed. `false` keeps the non-black bounding rect; `true` crops to the max inscribed rectangle (no black corners, more CPU). Forced **off** internally when [`rectCrop`](#panorama-capture--guidance-v016) is on. Maps to `stitcher.enableMaxInscribedRectCrop`. See [Inscribed-rect crop](#inscribed-rect-crop). |
| `defaultFlowNoveltyPercentile` | `number` | `0.85` | Flow-gate novelty percentile seed (flow-based mode). `DEFAULT_FLOW_GATE_SETTINGS.noveltyPercentile`. Clamped natively to `[0.50, 0.99]`. |
| `defaultFlowEvalEveryNFrames` | `number` | `5` | Flow-gate eval throttle seed. `DEFAULT_FLOW_GATE_SETTINGS.evalEveryNFrames`. Clamped natively to `[1, 10]`. |
| `defaultFlowMaxTranslationCm` | `number` | `50` | Flow-gate translation budget (cm) seed. `DEFAULT_FLOW_GATE_SETTINGS.maxTranslationCm`. `0` disables; clamped natively to `[0, 100]`. |
| `defaultKeyframeMaxCount` | `number` | `6` | Hard cap on accepted keyframes seed. Resolves to `DEFAULT_PANORAMA_SETTINGS.frameSelection.maxKeyframes`. Clamped natively to `[3, 10]`. Maps to `frameSelection.maxKeyframes`. |
| `defaultKeyframeOverlapThreshold` | `number` | `0.20` | Required new-content fraction seed. Resolves to `DEFAULT_PANORAMA_SETTINGS.frameSelection.overlapThreshold = 0.20` (the `FrameSelectionSettings` docstring's `0.15` is stale). Clamped natively to `[0.10, 0.80]`. |
| `defaultMaxKeyframeIntervalMs` | `number` | `1500` | Time-budget force-accept (ms) for the keyframe gate seed. Resolves to `DEFAULT_PANORAMA_SETTINGS.frameSelection.maxKeyframeIntervalMs = 1500` (the prop JSDoc's `2000` is stale). `0` disables. Applies to AR + non-AR. |
| `defaultCompositingResolMP` | `number` | — | Forward-looking; accepted for API stability but currently a **no-op**. Will wire to `cv::Stitcher` compositing resolution later. |
| `defaultRegistrationResolMP` | `number` | — | Forward-looking; accepted but currently a **no-op**. |
| `defaultSeamEstimationResolMP` | `number` | — | Forward-looking; accepted but currently a **no-op**. |
| `stitcher` | `Partial<Omit<BatchStitcherSettings, perf keys>>` | — | The stitch **recipe** object: `stitchMode` / `warperType` / `blenderType` / `enableMaxInscribedRectCrop` / `debugPack`. Wins over the flat `default*` props. **v0.24** — the speed levers moved to [`perf`](#anti-blur--perf-groups-v024). |
| `frameSelection` | `Partial<...gate fields>` | — | The keyframe **gate** object: `mode` / `maxKeyframes` / `overlapThreshold` / `maxKeyframeIntervalMs` / `flow` (deep-merged). **v0.24** — the anti-blur controls moved to [`blur`](#anti-blur--perf-groups-v024). |
| `blur` | `BlurPropOverrides` | — | **v0.24** anti-blur group. See [below](#anti-blur--perf-groups-v024). |
| `perf` | `PerfPropOverrides` | — | **v0.24** perf-lever group. See [below](#anti-blur--perf-groups-v024). |

:::tip Runtime gear panel
The in-app settings modal (gear, shown via `showSettingsButton`) can edit
the stitcher and frame-gate fields at runtime; those edits override these
seed props at capture time.
:::

## Anti-blur & perf groups (v0.24)

v0.24 groups the anti-blur and stitch-speed knobs into two dedicated prop
objects. Both are partial + deep-merged over the SDK defaults, so set only what
you want. Upgrading from v0.23? See the
[migration guide](https://github.com/bhargavkanda/react-native-image-stitcher/blob/main/docs/migrations/v0.24.0-to-v0.24.1.md).

### `blur` — motion-blur defenses

```tsx
<Camera blur={{ sharpnessWindow: 4, maxExposureMs: 8, preferHighFpsFormat: true }} />
```

| Field | Type | Default | How to flip / what it does |
|---|---|---|---|
| `sharpnessWindow` | `number` | `4` | Pick the sharpest of K gate-evaluated frames. **`1` disables** (immediate save). |
| `maxExposureMs` | `number` | `8` | Exposure-cap target (ms) shared with the host capture session. **`0` = don't cap.** |
| `maxCommitPanRateRadPerSec` | `number` | `1.0` | Hold keyframe commit while slewing faster than this (rad/s). **`0` = no motion gate.** |
| `minScoreFractionOfMedian` | `number` | `0.6` | Hold commit while the best candidate is below this fraction of the session sharpness median. **`0` = off.** |
| `maxConsecutiveHolds` | `number` | `12` | Forward-progress guard: never hold the same pending keyframe more than this many evaluated frames. |
| `preferHighFpsFormat` | `boolean` | `true` | Prefer the highest-fps capture format (bounds exposure + doubles candidates). **`false` = smallest format.** The only exposure lever on the iOS AR path. |

### `perf` — stitch-speed levers

```tsx
<Camera perf={{ seamFinderType: 'voronoi', numThreads: 0 }} />
```

| Field | Type | Default (v0.24) | How to flip / what it does |
|---|---|---|---|
| `seamFinderType` | `'voronoi' \| 'graphcut' \| 'skip'` | **`'voronoi'`** | The dominant speed lever. `voronoi` is ~1.6–1.9× faster than `graphcut` with no visible quality loss on-device. Use `'graphcut'` for high near-field-parallax corpora; `'skip'` for the lowest-memory config (pair with `blenderType:'feather'`). |
| `rangeMatcherWidth` | `number` | `3` | PANORAMA feature-matcher window (2/2/3 ladder). **`0` = legacy full-pairwise.** Android/high-level only. |
| `numThreads` | `number` | **`0`** | OpenCV intra-stitch threads. `0` = auto multi-core (fastest on-device at 8–10 keyframes). **`1` = single-thread kill-switch** (lower peak RAM). Android only (iOS is always multi-core). |
| `adaptiveStitchMode` | `'measured' \| 'off' \| 'always'` | `'measured'` | Compose-resolution adaptation. `'measured'` shrinks the output to `adaptiveMinOutputMP` only on devices proven slow. **`'off'` = never shrink.** Android only. |
| `adaptiveMinOutputMP` | `number` | `0.6` | Compose-resolution floor (MP) when adapting. Native clamps `[0.6, 1.0]`. |
| `adaptiveSlowStitchMsPerFrame` | `number` | `1000` | Per-keyframe wall-time (ms) above which `'measured'` fires. |

### Inscribed-rect crop

When `cv::Stitcher` warps the keyframes onto the output canvas, the filled
region is rarely a perfect rectangle — the edges curve and the corners are
often empty (black), especially on a wide pan or a `plane` / `cylindrical`
warp. `maxInscribedRectCrop` chooses how that canvas is cropped at finalize:

- **`false` (default)** — crop to the **bounding rectangle** of the non-black
  pixels: keeps every stitched pixel, but can leave black corners where the
  projection didn't fill.
- **`true`** — crop to the **largest axis-aligned rectangle that fits entirely
  inside the stitched region**: clean, straight edges, no black corners, at the
  cost of more CPU at finalize and a potentially much smaller output on
  lopsided or ultra-wide pans — which is why it's **opt-in**.

```tsx
// Default (false) — bounding-box crop, keeps every stitched pixel:
<Camera onCapture={handleCapture} />

// Opt in — clean inscribed rectangle, no black corners (may shrink the output):
<Camera onCapture={handleCapture} maxInscribedRectCrop={true} />
```

:::caution `rectCrop` forces this off
When the [`rectCrop`](#panorama-capture--guidance-v016) draggable-quad editor
is enabled, the native auto-crop (`maxInscribedRectCrop`) is forced off — the
manual crop is the source of truth.
:::

## Panorama capture & guidance (v0.16)

These props govern the non-AR panorama capture flow: which device hold is
accepted, the live guidance surfaces during the pan, the auto-stop budgets,
and what UI (if any) the user sees after the stitch finalizes.

### `panMode`

`PanMode` (`'vertical' | 'horizontal' | 'both'`), default **`'vertical'`**.

Which device hold the non-AR pano accepts:

- **`'vertical'`** — landscape-only, top → bottom. **Breaking** new default.
- **`'horizontal'`** — portrait-only, left → right.
- **`'both'`** — no rotate gate; any hold is accepted.

Starting in the wrong hold is blocked behind the rotate prompt (see
`rotateToLandscape` / `rotateToPortrait` in [guidanceCopy keys](#guidancecopy-keys)).

### `panGuidance`

`boolean`, default **`true`**.

:::note `panGuidance` is a current prop
Earlier drafts of this page claimed `panGuidance` was removed. That was
wrong — it is a live prop and defaults to `true`.
:::

Master switch for the in-capture pan-guidance surfaces: the rotate prompt,
the pan how-to animation/hint, the "too fast" pill, and the blinking
countdown. Set `false` to suppress **all** of them. Note that the lateral-drift
stop ([`lateralBudgetCm`](#lateralbudgetcm) /
[`lateralStopFinalizeMinFrames`](#lateralstopfinalizeminframes)) and the
post-stitch review surface ([`rectCrop`](#rectcrop) /
[`showPreview`](#showpreview)) have their own props and are **not** governed
by `panGuidance`. They are not independent of each other, though: a review
surface **suppresses** the popup a finalized lateral stop would otherwise
show — see [what shows after a lateral-drift stop](#what-shows-after-a-lateral-drift-stop).

### `maxPanDurationMs`

`number`, default **`0`** (disabled).

A hard recording-time ceiling (ms) that acts as a **safety cap** alongside
the primary keyframe-count auto-stop. v0.16 changed the default from `9000`
to `0` — the keyframe-count auto-stop is now the default UX, and the time cap
is opt-in. When `> 0`, a blinking countdown is shown and capture
auto-finalizes when it reaches 0.

### `panTooFastThreshold`

`number`, default **`0.6`** rad/s (resolved fallback).

Gyro rate (rad/s) above which the pan is flagged "too fast" (the amber pill).
There is no component-level default; the prop is passed through as
`usePanMotion`'s `warnMaxRadPerSec`, so when omitted it resolves to
`DEFAULT_WARN_RAD_PER_SEC = 0.6`.

:::caution Stale JSDoc
The prop JSDoc claims a default of `1.0 rad/s`. The real fallback literal is
**`0.6`**.
:::

### `lateralBudgetCm`

`number`, default **`8`** (v0.25.3 — was `4`).

Cross-pan (lateral / sideways) drift budget in cm. Once integrated sideways
translation exceeds this for the grace window, the capture is **stopped**. Set
`0` to disable the lateral-drift stop entirely.

This is the **sensitivity** knob — how much drift is tolerated before a stop
happens at all. What happens *at* that stop (finalize the partial sweep, or
discard it) is a separate decision, controlled by
[`lateralStopFinalizeMinFrames`](#lateralstopfinalizeminframes). If operators
report the stop firing too eagerly, raise this; if they report stopped captures
being thrown away, lower that one.

v0.25.3 raised the default after field reports of the stop firing on minor
drift: 4 cm of integrated sideways translation is comfortably inside the
natural arc of a hand-held sweep. The detector is unchanged — only the budget
it is measured against.

Whether that stop KEEPS what was captured (finalize + stitch, carrying the
`LATERAL_DRIFT_FINALIZE` warning) or throws it away is a separate decision —
see [`lateralStopFinalizeMinFrames`](#lateralstopfinalizeminframes) below. At
its default the capture is kept only when at least 5 keyframes were accepted
— a change from the 2 this budget used to imply.

:::caution Stale JSDoc
The prop JSDoc claims a default of `5`. The real component default is **`4`**
(`usePanMotion`'s own `DEFAULT_LATERAL_BUDGET_CM` is also `4`).
:::

### `lateralStopFinalizeMinFrames`

`number`, default **`5`**.

The accepted-keyframe count at or above which a lateral-drift stop
**finalizes** the capture: the partial sweep is stitched and delivered to
`onCapture` with a `LATERAL_DRIFT_FINALIZE` warning. Below the threshold the
capture is **discarded** instead — the engine is cancelled, nothing is
stitched, and [`onCaptureAbandoned('lateral-drift')`](./capture-result.md#oncaptureabandoned--no-output-at-all)
fires.

| Value | Behaviour |
|---|---|
| `0` | **ALWAYS DISCARD** — a laterally-drifted sweep is never kept, whatever was captured. |
| `N >= 1` | Finalize iff `acceptedKeyframeCount >= N`, otherwise discard. |
| `2` | Reproduces the previously hardcoded behaviour exactly (keep anything stitchable). |
| `5` (default) | Keep only a real sweep; 2-4 keyframes discard. |

:::danger Behaviour change
The default of `5` is **not** the `2` the SDK used to hardcode. A capture that
accepted 2, 3 or 4 keyframes before drifting used to finalize and reach
`onCapture`; it now abandons and fires
[`onCaptureAbandoned('lateral-drift')`](./capture-result.md#oncaptureabandoned--no-output-at-all)
instead. For shelf capture that remnant is not a usable panorama — it is waste
that still costs a stitch, a file, and an operator's attention on output that
has to be rejected downstream.

**Pass `lateralStopFinalizeMinFrames={2}` to restore the previous behaviour.**
:::

:::warning `0` is a special case, not arithmetic
`0` means *always discard*. It has to be guarded explicitly, because the
natural `acceptedKeyframeCount >= minFrames` comparison is unconditionally
**true** at `0` — which would silently mean the exact opposite, "always
finalize".
:::

Negative, `NaN` and infinite values normalise back to the default, so a broken
host config degrades to the standard behaviour rather than to "throw every
capture away". Fractional values round **up** (`2.5` needs 3 frames) — the prop
counts whole frames.

Why it exists: a hardcoded threshold is a product judgement the SDK is not
entitled to make. A shelf-audit host wants the 3-frame partial panorama; a host
feeding a downstream vision pipeline treats any laterally-drifted sweep as
garbage, and keeping it only costs a stitch, a file, and an operator's
attention on output they will bin.

The discard path shows its own popup state, whose copy does not promise a
stitch — [`lateralStopDiscardedTitle` / `lateralStopDiscardedBody`](#guidancecopy-keys).
Below 2 accepted keyframes nothing stitchable existed in the first place, so
the popup keeps the pre-existing "follow the arrow" wrong-direction copy
regardless of this threshold.

A discarded capture **always** shows its popup: nothing was kept, no review
surface follows, and the popup is the only feedback there is. A *finalized*
stop is the asymmetric case — it shows no popup at all when a review surface
follows. See [what shows after a lateral-drift
stop](#what-shows-after-a-lateral-drift-stop).

```tsx
// Never keep a drifted sweep — the pipeline downstream would reject it anyway.
<Camera lateralStopFinalizeMinFrames={0} onCaptureAbandoned={handleAbandon} />
```

### `rectCrop`

`boolean`, default **`false`**.

Show the draggable-quad crop editor after a pano finalizes, **before**
`onCapture` fires. With `true`, the user drags four corners and confirming
perspective-rectifies the stitch to a rectangle.

### `showPreview`

`boolean`, default **`false`**.

Show a plain review screen (Retake / Confirm, no crop box) after a pano
finalizes. Ignored when `rectCrop` is on.

### How `rectCrop` and `showPreview` interact

Both props control the post-finalize UI, and **`rectCrop` takes precedence**:

| `rectCrop` | `showPreview` | What the user sees after finalize |
|---|---|---|
| `false` | `false` | **Nothing** — `onCapture` fires immediately, no review UI. |
| `false` | `true` | Plain review screen (Retake / Confirm), no crop box. |
| `true` | `false` | Draggable-quad crop editor (drag 4 corners, confirm rectifies). |
| `true` | `true` | Crop editor wins — `showPreview` is ignored. |

These two props are also what decides whether a **finalized** lateral-drift
stop shows its popup: the first row is the only configuration in which it
does, because it is the only one where no review surface follows. See [what
shows after a lateral-drift stop](#what-shows-after-a-lateral-drift-stop).

When `rectCrop` is on, the native auto-crop (`maxInscribedRectCrop`) is forced
off so the manual crop is the single source of truth. The crop editor's button
labels and the preview's confirm label are all overridable via
[`guidanceCopy`](#guidancecopy-keys) (`cropConfirm`, `cropReset`,
`cropUseOriginal`, `cropRetake`, `previewConfirm`).

### What shows after a lateral-drift stop

Only **one** of `<Camera>`'s capture-flow modals is ever on screen at a time.
On iOS each one is a real `UIViewController` presentation, and a controller can
present only one child: a second present is refused and leaves an invisible
window in the hierarchy that swallows every touch. That was the 0.25.1
dead-shutter bug, and the rule below is what prevents it.

So a host can predict exactly what the operator sees:

| Stop outcome | `rectCrop` / `showPreview` | What appears |
|---|---|---|
| **Finalized** | either is on | **Review surface only.** No popup — the surface's own banner already carries the same `LATERAL_DRIFT_FINALIZE` warning. |
| **Finalized** | both off | **Popup only** — [`lateralStopTitle` / `lateralStopBody`](#guidancecopy-keys). No review surface follows, so the popup is the only feedback. |
| **Discarded** by [`lateralStopFinalizeMinFrames`](#lateralstopfinalizeminframes) | any | **Popup only** — [`lateralStopDiscardedTitle` / `lateralStopDiscardedBody`](#guidancecopy-keys). Nothing was kept, so there is nothing to review. |
| **Too few frames** to stitch anything | any | **Popup only** — [`lateralWrongDirectionTitle` / `lateralWrongDirectionBody`](#guidancecopy-keys). |

The review surface additionally **waits** while any guidance popup is up
(including the orientation-drift popup) and mounts when that popup is
dismissed. The pending result is held in state meanwhile, so nothing is lost —
it costs a beat, not a capture.

:::note Changed in 0.25.1
Before 0.25.1 a finalized stop showed the popup **and** then tried to open the
review surface over it, which is the clash described above. If your host
relied on the popup appearing after a *finalized* lateral stop, it is now
suppressed whenever a review surface follows — the warning is in that
surface's banner instead. Discard outcomes are unaffected and still show
their popup.
:::

### `guidanceCopy`

`Partial<GuidanceCopy>`, default falls back to `DEFAULT_GUIDANCE_COPY`.

Copy overrides for every guidance string — the rotate prompt, the pan hint,
the "too fast" warning, the lateral-stop popup, the crop/preview buttons, the
status banner, and the warning banners. It's a `Partial`: any key you omit
falls back to `DEFAULT_GUIDANCE_COPY`. See [guidanceCopy keys](#guidancecopy-keys)
for the full key list and defaults.

```tsx
<Camera
  panMode="vertical"
  panGuidance
  lateralBudgetCm={8}
  rectCrop
  guidanceCopy={{
    rotateToLandscape: 'Turn your phone sideways',
    panHint: 'Sweep slowly, top to bottom',
    cropConfirm: 'Looks good',
  }}
  onCapture={handleCapture}
/>
```

## UI toggles

| Prop | Type | Default | Description |
|---|---|---|---|
| `enablePhotoMode` | `boolean` | `true` | Enable tap-shutter single-photo capture. |
| `enablePanoramaMode` | `boolean` | `true` | Enable hold-pan-release panorama capture. |
| `showSettingsButton` | `boolean` | `false` | Show the gear button that opens the internal settings modal. Off by default so public consumers don't see it (absorbed into the header's right side when `headerTitle` is set). |
| `style` | `StyleProp<ViewStyle>` | — | Style applied to the `Camera` root container. |

## Photo depth sidecar (iOS)

| Prop | Type | Default | Description |
|---|---|---|---|
| `captureDepthData` | `boolean` | `false` | **iOS, non-AR photo path.** Save each tap photo's `AVDepthData` as a `<photo>.depth.bin` sidecar (float32 metres + JSON header) and return its path as `depthPath` on the photo result. Stereo depth on dual-camera iPhones, LiDAR-backed absolute depth on Pro models. Silently yields no sidecar on Android, in AR capture, and on single-lens hardware. Adds per-shot latency while depth delivery runs. |

See [Photo depth sidecar](./photo-depth.md) for the sidecar file format,
device requirements, and consumption notes.

## Flash

Controlled or uncontrolled. See [Flash & lenses](./flash-and-lenses.md).

| Prop | Type | Default | Description |
|---|---|---|---|
| `flash` | `'on' \| 'off'` | — (uncontrolled; internal `'off'`) | Controlled-or-uncontrolled torch state. Omit to let `<Camera>` own it internally; supply it to take ownership in the parent. Forced to `'off'` in AR mode (ARKit/ARCore own the torch). |
| `onFlashChange` | `(next: 'on' \| 'off') => void` | — | Fires when the user taps the built-in flash button. In uncontrolled mode the internal state has already flipped; in controlled mode the parent must update `flash` or the toggle is a no-op. |
| `showFlashButton` | `boolean` | `true` | Show the built-in flash button in the bottom-left slot. Set `false` to render your own flash chrome and drive the torch via the controlled `flash` prop. |

## Header chrome (opt-in)

Setting `headerTitle` renders a built-in top header; the settings gear is
absorbed into it.

| Prop | Type | Default | Description |
|---|---|---|---|
| `headerTitle` | `string` | — (header not rendered) | Built-in `CaptureHeader` title (centred). When undefined the header is not rendered. |
| `onHeaderBack` | `() => void` | — (no back button) | Header back-button callback. When supplied (and `headerTitle` set) the header renders a back affordance on the left. |
| `headerBackLabel` | `string` | `'‹ Back'` | Header back-button label. No effect unless `headerTitle` and `onHeaderBack` are both set. |
| `headerGuidance` | `string` | — (renders nothing) | Optional second-line subtitle below the header title. No effect unless `headerTitle` is set. |
| `headerColors` | `CaptureHeaderProps['colors']` | — (white-on-black) | Colour overrides for the built-in header. No effect unless `headerTitle` is set. |

## Capture history (thumbnails)

| Prop | Type | Default | Description |
|---|---|---|---|
| `thumbnails` | `CaptureThumbnailItem[]` (`{ id, uri, width?, height? }`) | — (strip skipped) | When provided (even as `[]`), `Camera` renders a built-in `CaptureThumbnailStrip` above the bottom controls. `onCapture` results are **not** auto-added; the host owns the canonical list. |
| `thumbnailsMin` | `number` | — | Minimum-photos hint for the count line (`'n / min'`); success colour when reached, warning otherwise. |
| `thumbnailsMax` | `number` | — | Maximum-photos hint for the count line (`'· max'` suffix). No enforcement. |
| `onThumbnailPress` | `(item: CaptureThumbnailItem) => void` | — (built-in preview) | Tap handler for thumbnails. When set, replaces the strip's built-in tap-to-preview modal with the host's own UI. |

## Post-stitch preview modal

| Prop | Type | Default | Description |
|---|---|---|---|
| `capturePreview` | `{ imageUri: string; imageWidth?: number; imageHeight?: number; title?: string }` | — (modal hidden) | When set, `Camera` renders a built-in `CapturePreview` modal as visible (post-stitch confirmation). `undefined` hides it. |
| `capturePreviewActions` | `CapturePreviewAction[]` | — / `[]` (only close affordance) | Action buttons along the bottom of the `CapturePreview` modal. Empty/undefined renders no buttons, only the close affordance. |
| `onCapturePreviewClose` | `() => void` | — | Fires when the user dismisses the `capturePreview` modal (close tap, backdrop tap, Android hardware back). Host clears the `capturePreview` prop in response. |

## Frame processor (advanced)

| Prop | Type | Default | Description |
|---|---|---|---|
| `frameProcessor` | `ReadonlyFrameProcessor \| DrawableFrameProcessor` | — (lib's internal driver) | Optional host-supplied vision-camera frame processor (non-AR mode). Replaces the lib's default processor; compose first-party stitching back via `useStitcherWorklet`. No effect in AR mode (the vision-camera `Camera` isn't mounted; host worklets fire via AR dispatch). |

## Callbacks

| Prop | Type | Fires / purpose |
|---|---|---|
| `onCapture` | `(result: CameraCaptureResult) => void` | **Always** fires once per capture attempt (v0.16). Carries `ok: true` (output present, with `warnings[]`) or `ok: false` (carrying the `CameraError`). Gate on `ok` before reading `uri` / `width` / `height`. See [Capture result & errors](./capture-result.md). |
| `onCaptureSourceChange` | `(source: CaptureSource) => void` | The effective capture source changes (AR ↔ non-AR). |
| `onLensChange` | `(lens: CameraLens) => void` | The selected physical lens changes (1× ↔ 0.5×). |
| `onFramesDropped` | `(info: FramesDroppedInfo) => void` | Fires once per panorama capture if `cv::Stitcher`'s confidence filtering (inside the winning retry-ladder rung, v0.25) dropped one or more input frames. `info` is `{ requested: number; included: number }`. |
| `onError` | `(err: CameraError) => void` | Fires on failure — an unchanged mirror of the `ok: false` `onCapture` result, so existing error handling keeps working. See [Capture result & errors](./capture-result.md). |
| `onCaptureAbandoned` | `(reason: 'orientation-drift' \| 'lateral-drift') => void` | Fires when the SDK auto-abandons an in-progress capture **without** producing output. `'orientation-drift'` = cross-mode rotation mid-capture; `'lateral-drift'` (v0.16) = a sideways drift that [`lateralStopFinalizeMinFrames`](#lateralstopfinalizeminframes) declined to finalize (by default, fewer than 5 accepted keyframes). No `onCapture` fires for an abandoned capture. |

## Output

| Prop | Type | Default | Description |
|---|---|---|---|
| `outputDir` | `string` (bare path or `file://` URI) | — (vision-camera tmp dir) | Destination directory for captures. When set, photos land at `${outputDir}/photo-${ts}.jpg` and panoramas at `${outputDir}/panorama-${ts}.jpg`. The host owns dir choice / existence / visibility. Disk failure rejects via `onError` with `OUTPUT_WRITE_FAILED`. Requires `expo-file-system` (optional peer dep). |

## Settings JSON objects

The flat `default*` props each seed a single field. v0.16 adds two
JSON-object props — `stitcher` and `frameSelection` — that let you pass the
whole sub-config at once. They are `Partial`: set only the fields you care
about, and any field you set wins over the matching flat `default*` prop.
(The `frameSelection.flow` object is deep-merged.) Runtime gear-panel edits
still override these at capture time.

```tsx
<Camera
  stitcher={{
    stitchMode: 'panorama',
    warperType: 'spherical',
    blenderType: 'feather',
    seamFinderType: 'skip',
  }}
  frameSelection={{
    mode: 'flow-based',
    maxKeyframes: 8,
    overlapThreshold: 0.25,
    maxKeyframeIntervalMs: 1500,
    flow: { noveltyPercentile: 0.9, maxTranslationCm: 60 },
  }}
  onCapture={handleCapture}
/>
```

### `stitcher` — `BatchStitcherSettings`

Plus two `CaptureBaseSettings` fields (`captureSource`, `debug`) that live on
the settings tree these fields sit under.

| Field | Type | Default | Description |
|---|---|---|---|
| `captureSource` | `'ar' \| 'non-ar'` | `'ar'` | Which camera + tracking source feeds the engine. `'ar'` = ARKit/ARCore pose (real translation); `'non-ar'` = vision-camera gyro yaw+pitch only, with the JS IMU gate filling translation. (Settings-tree default; the component prop default for `defaultCaptureSource` is `'non-ar'` — the component's runtime-derived source always wins.) |
| `debug` | `boolean` | `false` | Show the lib's built-in diagnostic overlay (memory / keyframe / orientation pills, stitch-stats toast, metrics block). |
| `stitchMode` | `'auto' \| 'panorama' \| 'scans'` | `'auto'` | `cv::Stitcher` pipeline mode. `'auto'` picks panorama/scans at finalize from the translation/rotation ratio; `'panorama'` = rotation-only (ORB + BA-Ray + Spherical); `'scans'` = affine (Affine + BA-Affine + Plane). On failure the flat retry ladder (v0.25) falls back to the opposite mode automatically on both platforms. |
| `warperType` | `'plane' \| 'cylindrical' \| 'spherical'` | `'plane'` | Output projection. PANORAMA mode uses it directly; SCANS hard-wires `PlaneWarper` and ignores it. v0.16 reverted from `'spherical'` to `'plane'`. |
| `blenderType` | `'multiband' \| 'feather'` | `'multiband'` | Pixel blender. `'multiband'` = cleaner seams, holds all warped frames in memory; `'feather'` = streams, lower peak memory. |
| `seamFinderType` | `'graphcut' \| 'skip'` | `'graphcut'` | Seam-finder strategy. `'graphcut'` finds optimal seams (pair with `multiband`); `'skip'` streams warp+feed (pair with `feather`, lowest memory). |
| `enableMaxInscribedRectCrop` | `boolean` | `false` | Output crop strategy. `false` crops to the non-black bounding rect; `true` runs max-inscribed-rect + morph-close (no black corners, more CPU at finalize). |

### `frameSelection` — `FrameSelectionSettings`

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `'time-based' \| 'pose-based' \| 'flow-based'` | `'flow-based'` | Frame-selection strategy. `'time-based'` = gate disabled (every frame up to `maxKeyframes`); `'pose-based'` = plane-overlap / angular-delta; `'flow-based'` = Shi-Tomasi corners + KLT (more expensive, accurate for translation; default since v0.3). |
| `maxKeyframes` | `number` | `6` | Hard cap on accepted keyframes per capture. Clamped natively to `[3, 10]`. `cv::Stitcher` convergence degrades past ~8–10 frames. |
| `overlapThreshold` | `number` | `0.20` | Required NEW-content fraction (0..1) for a candidate to be accepted. (The field docstring's `0.15` is stale; the literal is `0.20`.) Lower = more frames / denser overlap. Clamped natively to `[0.10, 0.80]`. |
| `maxKeyframeIntervalMs` | `number` | `1500` | Time-budget force-accept (ms) for both AR + non-AR. When `> 0`, accepts a keyframe whenever this many ms elapsed since the last, even if novelty is unmet. Counts toward `maxKeyframes`. `0` disables. |
| `flow` | `FlowGateSettings` (optional) | `DEFAULT_FLOW_GATE_SETTINGS` | Sparse-optical-flow tunables. Consulted only when `mode === 'flow-based'`. See below. |

### `frameSelection.flow` — `FlowGateSettings`

Consulted only when `frameSelection.mode === 'flow-based'`.

| Field | Type | Default | Description |
|---|---|---|---|
| `noveltyPercentile` | `number` | `0.85` | Percentile aggregating per-feature absolute displacements into a per-axis novelty estimate (V16 change from the pre-V16 median `0.50`). Higher picks up leading-edge motion sooner. Clamped to `[0.50, 0.99]`. |
| `evalEveryNFrames` | `number` | `5` | Caller-side throttle — evaluate the flow strategy every Nth frame (~6 Hz at 30 Hz ARCore). Pure CPU savings; doesn't change which frames are accepted. Clamped to `[1, 10]`. |
| `maxTranslationCm` | `number` | `50` | Translation budget (cm). When `> 0`, force-accepts the next frame after translating more than this since the last keyframe, even below `overlapThreshold`. `0` disables. Clamped to `[0, 100]`. |
| `maxCorners` | `number` | `150` | Shi-Tomasi corner count. Higher = more robust median, slower detect (~15–25 ms at 150 on a Galaxy A35). Clamped to `[50, 300]`. |
| `qualityLevel` | `number` | `0.01` | Shi-Tomasi quality level. Lower lets weaker corners in (more KLT noise); higher demands stronger corners. Clamped to `[0.005, 0.05]`. |
| `minDistance` | `number` | `10` | Shi-Tomasi minimum distance between detected corners, in working-resolution px (input downscaled to 720-px-longest-side). Higher = more spatially spread features. Clamped to `[1, 50]`. |

## `guidanceCopy` keys

Every key is a string; pass a `Partial<GuidanceCopy>` and unspecified keys
fall back to `DEFAULT_GUIDANCE_COPY` (the defaults shown here).

| Key | Default | Description |
|---|---|---|
| `rotateToLandscape` | `Rotate to landscape` | Caption pill while waiting for the user to rotate to landscape (`panMode: 'vertical'`). |
| `rotateToPortrait` | `Rotate to portrait` | Caption pill while waiting for the user to rotate to portrait (`panMode: 'horizontal'`). |
| `panHint` | `Pan slowly top to bottom` | Short hint shown with the how-to-pan animation. |
| `tooFast` | `Moving too fast — slow down` | Transient warning when the pan is too fast. |
| `lateralStopTitle` | `Keep the pan straight` | Popup title for a lateral stop that was **finalized** (capture kept + stitched). Reachable only when **no** review surface follows — with `rectCrop` or `showPreview` on, no popup is shown and the warning appears in that surface's banner instead. See [what shows after a lateral-drift stop](#what-shows-after-a-lateral-drift-stop). |
| `lateralStopBody` | `You moved sideways. Pan in one direction only — we stitched what you captured.` | Popup body for the **finalized** lateral stop. Shown only when output actually exists **and** no review surface follows — see the discarded pair below, and See [what shows after a lateral-drift stop](#what-shows-after-a-lateral-drift-stop). |
| `lateralStopDismiss` | `Got it` | Popup dismiss button label — used by whichever popup state is showing. |
| `lateralWrongDirectionTitle` | `Follow the arrow` | Popup title when lateral drift stopped the capture before enough frames to stitch anything (nothing produced). |
| `lateralWrongDirectionBody` | `You moved the phone the wrong way. Pan slowly in the direction the arrow shows, in one straight line.` | Popup body for the too-few-frames wrong-direction stop. |
| `lateralStopDiscardedTitle` | `Capture discarded` | Popup title for the third state: enough frames to stitch, but [`lateralStopFinalizeMinFrames`](#lateralstopfinalizeminframes) discarded the capture. At the default threshold this is the 2-to-4-keyframe band, so it is reachable out of the box. |
| `lateralStopDiscardedBody` | `You moved sideways, so this capture was discarded. Shoot it again, panning in one straight line.` | Popup body for the discarded-by-policy stop. Deliberately does **not** promise a stitch — no output was produced. |
| `cropConfirm` | `Crop` | Confirm button on the crop editor. |
| `cropReset` | `Reset` | Reset-corners button on the crop editor. |
| `cropUseOriginal` | `Use original` | "Emit the stitch un-cropped" button on the crop editor. |
| `cropRetake` | `Retake` | Discard this capture and return to the camera. |
| `previewConfirm` | `Confirm` | Accept button in preview-only mode (`showPreview` without `rectCrop`): confirms the stitched image as-is. |
| `statusRecording` | `Hold steady — pan slowly` | `CaptureStatusOverlay` banner while a capture is recording (calm green state). |
| `statusStitching` | `Stitching panorama…` | `CaptureStatusOverlay` banner while the panorama is being stitched after release. |
| `warnLowFrameUtilization` | `Only {included} of {requested} captured frames ({percent}%) could be used — the panorama may be incomplete. Pan more slowly and steadily next time.` | `LOW_FRAME_UTILIZATION` warning. **Template** — keep the `{included}` / `{requested}` / `{percent}` placeholders. |
| `warnLateralDriftFinalize` | `Capture stopped early because the phone drifted sideways — only the part captured before the drift was stitched.` | `LATERAL_DRIFT_FINALIZE` warning. |
| `warnHighPanSpeed` | `The capture was taken faster than the recommended pace — the result may not be the best. Pan more slowly next time.` | `HIGH_PAN_SPEED` warning. |

:::tip Localizing copy
The same strings can be localized centrally. See [i18n](./i18n.md) for the
full workflow.
:::

## Enums / allowed values

| Type | Allowed values | Notes |
|---|---|---|
| `CameraLens` | `'1x'`, `'0.5x'` | Physical lens selector. `0.5x` forces non-AR (AR sessions don't expose the ultra-wide). |
| `CaptureSource` | `'ar'`, `'non-ar'` | Effective capture source. `'ar'` = ARKit/ARCore; `'non-ar'` = vision-camera + IMU. |
| `CaptureSourcesMode` | `'ar'`, `'non-ar'`, `'both'` | Host constraint on allowed capture sources. `'both'` shows the AR toggle; a single value hides it (and `'ar'` also hides the 0.5× chooser). |
| `StitchMode` | `'auto'`, `'panorama'`, `'scans'` | `cv::Stitcher` pipeline mode. `'auto'` resolves at finalize; `'panorama'` = rotation-only; `'scans'` = affine/plane. |
| `Blender` | `'multiband'`, `'feather'` | Pixel blender. `'multiband'` = cleaner seams / more memory; `'feather'` = streaming / lower peak memory. |
| `SeamFinder` | `'graphcut'`, `'skip'` | Seam-finder strategy. `'graphcut'` = optimal seams; `'skip'` = stream warp+feed. |
| `Warper` | `'plane'`, `'cylindrical'`, `'spherical'` | Output projection. Used by PANORAMA mode; SCANS hard-wires `plane`. |
| `PanMode` | `'vertical'`, `'horizontal'`, `'both'` | Device hold the non-AR pano accepts. `'vertical'` = landscape-only top→bottom (default); `'horizontal'` = portrait-only left→right; `'both'` = no rotate gate. |
| `DeviceOrientation` | `'portrait'`, `'portrait-upside-down'`, `'landscape-left'`, `'landscape-right'` | Device orientation reported by `useDeviceOrientation` (works under iOS portrait-lock). |

## See also

- [Capture result & errors](./capture-result.md) — the full `CameraCaptureResult`
  union (`ok: true` photo / panorama and `ok: false` variants), `CaptureWarning`
  codes, and the `CameraError` taxonomy.
- [Complete example (all options)](./full-example.md) — a full, copy-pasteable
  host screen exercising the props on this page: permission, thumbnails, the
  preview modal, panorama guidance, and `onCaptureAbandoned`.
- [Recipes](./recipes.md) — common configurations, copy-paste ready.
- [i18n](./i18n.md) — localizing `guidanceCopy` and the recoverable-error copy.
