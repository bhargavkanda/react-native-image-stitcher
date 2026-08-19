---
id: capture-result
title: Capture result & errors
sidebar_position: 8
---

# Capture result & errors

## `onCapture` always fires once per attempt

As of **v0.16**, `onCapture` fires **exactly once for every capture
attempt** — success *or* failure. The result is a discriminated union
keyed first on `ok`, then on `type`:

- `ok: true` — the output is present (an `uri`/`width`/`height` to read).
- `ok: false` — the attempt failed; the `error` is the same
  [`CameraError`](#cameraerror) object handed to `onError`.

Every variant also carries a [`warnings`](#capturewarning) array — a
successful stitch can still come back with `warnings` worth surfacing.

:::caution Breaking change in v0.16
Before v0.16, `onCapture` fired on **success only**. Now it fires on
failure too. **Gate on `ok` before reading `uri`/`width`/`height`:**

```tsx
onCapture={(result) => {
  if (!result.ok) {
    handle(result.error); // CameraError
    return;
  }
  save(result.uri); // narrowed to ok:true here
}}
```

[`onError`](#cameraerror) **still fires on failure** as an unchanged
mirror of the `ok: false` result, so existing error handling keeps
working — you can adopt the new `ok: false` branch at your own pace.
:::

## `CameraCaptureResult`

```ts
type CameraCaptureResult =
  // VARIANT 1 — single photo succeeded
  | {
      ok: true;
      type: 'photo';
      uri: string;
      width: number;
      height: number;
      depthPath?: string; // iOS-only, captureDepthData opt-in
      warnings: CaptureWarning[];
    }
  // VARIANT 2 — panorama succeeded
  | {
      ok: true;
      type: 'panorama';
      uri: string;
      width: number;
      height: number;
      framesRequested: number;
      framesIncluded: number;
      framesDropped: number;
      finalConfidenceThresh: number;
      durationMs: number;
      /** Which cv::Stitcher pipeline the batch finalize actually ran
       *  (after auto-resolution). Useful for a "Stitched as: scans" pill. */
      stitchModeResolved?: 'panorama' | 'scans';
      rRadians?: number; // DEV-only
      tMeters?: number; // DEV-only
      decisionRatio?: number; // DEV-only
      debugSummary?: string; // DEV-only
      keyframePaths?: string[]; // iOS-only
      captureOrientation?: string; // iOS-only
      warnings: CaptureWarning[];
    }
  // VARIANT 3 — the attempt failed (photo or panorama)
  | {
      ok: false;
      type: 'photo' | 'panorama';
      error: CameraError;
      warnings: CaptureWarning[];
    };
```

:::note `PanoramaCaptureResult`
The success-panorama variant is also exported on its own:

```ts
import type { PanoramaCaptureResult } from 'react-native-image-stitcher';
// = Extract<CameraCaptureResult, { ok: true; type: 'panorama' }>
```
:::

### Field notes

- `framesRequested` / `framesIncluded` / `framesDropped` — how many
  candidate frames the engine took in, how many survived the confidence
  filter, and how many it dropped. A large gap usually pairs with a
  [`LOW_FRAME_UTILIZATION`](#capturewarning) warning.
- `finalConfidenceThresh` — the confidence threshold the winning rung
  of the flat retry ladder (v0.25) ran at.
- `durationMs` — wall-clock time from start to finalize.
- `stitchModeResolved` — present once `defaultStitchMode` was `'auto'`
  and the engine picked `'panorama'` vs `'scans'` at finalize.
- `rRadians` / `tMeters` / `decisionRatio` / `debugSummary` — **DEV-only**
  diagnostics (the rotation/translation pose and the mode-decision
  ratio). Don't depend on them in production.
- `keyframePaths` / `captureOrientation` — **iOS-only**. The on-disk
  keyframe paths and the device orientation at capture.
- `depthPath` — **iOS-only**, present when the [`captureDepthData`
  prop](./photo-depth.md) is on, the capture was **non-AR**, and the
  device delivered a depth map. Points at the `<photo>.depth.bin`
  sidecar saved next to `uri` (float32 metres + JSON header — see
  [Photo depth sidecar](./photo-depth.md) for the format). Never
  present on Android or for AR captures.

## Recommended `onCapture` handler

Branch on `ok` first, then on `type`. Surface any `warnings` regardless
of which success branch you land in.

```tsx
import {
  Camera,
  type CameraCaptureResult,
} from 'react-native-image-stitcher';

function onCapture(result: CameraCaptureResult) {
  // 1. Failure path — `error` mirrors what onError received.
  if (!result.ok) {
    reportFailure(result.error); // result.error: CameraError
    return;
  }

  // 2. Success — surface any warnings (a clean stitch can still warn).
  if (result.warnings.length > 0) {
    showWarnings(result.warnings); // CaptureWarning[]
  }

  // 3. Branch on the output type.
  if (result.type === 'photo') {
    save(result.uri, result.width, result.height);
    return;
  }

  // result.type === 'panorama' here
  console.log(
    `panorama ${result.framesIncluded}/${result.framesRequested} frames, ` +
      `${result.framesDropped} dropped, ${result.durationMs}ms, ` +
      `mode=${result.stitchModeResolved ?? 'n/a'}`,
  );
  save(result.uri, result.width, result.height);
}

<Camera onCapture={onCapture} />;
```

## `CaptureWarning`

A warning means the capture **succeeded** but something about it is worth
telling the user. Warnings ride on every `CameraCaptureResult` (including
`ok: false`) as `warnings: CaptureWarning[]`.

```ts
interface CaptureWarning {
  code: CaptureWarningCode;
  message: string;
  // The three below appear only on LOW_FRAME_UTILIZATION:
  framesRequested?: number;
  framesIncluded?: number;
  utilization?: number;
}
```

| `code` | When it fires |
|---|---|
| `LOW_FRAME_UTILIZATION` | Fewer than the threshold (default **70%**) of captured frames survived the confidence filter — the panorama may be incomplete. Carries `framesRequested` / `framesIncluded` / `utilization`; the `message` is a filled-in template. |
| `LATERAL_DRIFT_FINALIZE` | The capture was auto-finalized early because the phone drifted sideways — only the pre-drift portion was stitched. Only fires when the [`lateralStopFinalizeMinFrames`](./camera-api.md#lateralstopfinalizeminframes) policy kept the capture; a discarded lateral stop produces no result to carry a warning. |
| `HIGH_PAN_SPEED` | The pan exceeded the recommended pace at some point (the live "too fast" cue fired); motion blur / thin overlap may have hurt the result. |

:::tip Customising warning copy
The default warning strings live in `DEFAULT_CAPTURE_WARNING_COPY` and
can be localised. See [Internationalisation](./i18n.md).
:::

## `CameraError`

`onError` receives a `CameraError`, and the `ok: false` `CameraCaptureResult`
carries the *same* object on `error`. It's a `class` extending `Error`:

```ts
class CameraError extends Error {
  code: CameraErrorCode;
  cause?: unknown;
  name: 'CameraError';
  message: string;
}
```

Branch deterministically on `code` (toast vs retry vs report):

| Code | Meaning |
|---|---|
| `CAMERA_PERMISSION_DENIED` | Camera permission was denied by the user. |
| `CAMERA_DEVICE_UNAVAILABLE` | No usable camera device is available. |
| `PHOTO_CAPTURE_FAILED` | A tap-shutter single-photo capture failed. |
| `PANORAMA_START_FAILED` | The panorama capture failed to start. |
| `PANORAMA_FINALIZE_FAILED` | The panorama finalize step failed. |
| `STITCH_NEED_MORE_IMGS` | cv::Stitcher needs more input images to stitch. |
| `STITCH_HOMOGRAPHY_FAIL` | Homography estimation failed during stitching. |
| `STITCH_CAMERA_PARAMS_FAIL` | Camera parameter estimation/adjustment failed during stitching. |
| `STITCH_LOW_QUALITY` | **v0.16** — the native post-stitch validator rejected the output as disjoint / fragmented / mis-proportioned. Recoverable by re-capturing (carries "try again" copy). |
| `STITCH_OOM` | Out of memory during stitching. |
| `OUTPUT_WRITE_FAILED` | Writing the output file to disk failed (e.g. a bad `outputDir`). |
| `VISION_CAMERA_RUNTIME` | vision-camera surfaced a non-transient runtime error (e.g. invalid format, recording cancelled, microphone-permission denied). The full underlying error is on `.cause`. |
| `UNKNOWN` | An unclassified failure. |

```tsx
onError={(err) => {
  if (err.code === 'STITCH_NEED_MORE_IMGS') retryWithGuidance();
  else report(err.code, err.message);
}}
```

## `onCaptureAbandoned` — no output at all

Some in-progress captures are auto-abandoned by the SDK **without
producing output**. When that happens, `onCaptureAbandoned(reason)` fires
and **`onCapture` does NOT fire** for that attempt.

```tsx
onCaptureAbandoned={(reason) => {
  // reason: 'orientation-drift' | 'lateral-drift'
  switch (reason) {
    case 'orientation-drift':
      // The device rotated across the accepted hold mid-capture.
      return toast('Keep the phone in one orientation while panning.');
    case 'lateral-drift':
      // v0.16 — the phone moved sideways and the capture was not kept
      // (see lateralStopFinalizeMinFrames).
      return toast('Pan in one straight line — try again.');
  }
}}
```

| Reason | Meaning |
|---|---|
| `'orientation-drift'` | A cross-mode rotation happened mid-capture (the device left the accepted hold). |
| `'lateral-drift'` | **v0.16** — the phone moved sideways and the [`lateralStopFinalizeMinFrames`](./camera-api.md#lateralstopfinalizeminframes) policy declined to keep the capture (by default: fewer than 5 accepted keyframes). |

:::note Abandon vs lateral-drift *finalize*
A lateral-drift stop has two possible outcomes, and
[`lateralStopFinalizeMinFrames`](./camera-api.md#lateralstopfinalizeminframes)
(default `5`) decides which:

- **At or above the threshold** the capture is *finalized early* — you get a
  normal `ok: true` result with a [`LATERAL_DRIFT_FINALIZE`](#capturewarning)
  warning.
- **Below it** the capture is *abandoned* — you get
  `onCaptureAbandoned('lateral-drift')` and no `onCapture`.

At the default the split is "did at least 5 keyframes land?". That is a
**behaviour change**: the SDK used to keep anything with 2 or more, so
2-to-4-keyframe captures that previously arrived via `onCapture` now arrive
here instead. Pass `lateralStopFinalizeMinFrames={2}` to restore the old
split, or `0` to make **every** laterally drifted capture abandon so a drifted
sweep never reaches your pipeline at all.
:::

## Friendly copy for recoverable failures — `userFacingStitchError`

The `STITCH_*` codes are *recoverable* — the user can usually fix them by
re-capturing. The SDK exports `userFacingStitchError(code)`, which returns
ready-to-show `{ title, message }` copy for a host `Alert`/toast instead of
the raw `cv::Stitcher` diagnostic, and returns `null` for every
non-recoverable code (permission denied, device unavailable, generic
finalize failure, unknown, …) so you fall back to your generic error UI.

```ts
import {
  userFacingStitchError,
  type UserFacingStitchError,
} from 'react-native-image-stitcher';

// UserFacingStitchError = { title: string; message: string }
function userFacingStitchError(
  code: CameraErrorCode,
): UserFacingStitchError | null;
```

| `err.code` | `userFacingStitchError(code)` |
|---|---|
| `STITCH_NEED_MORE_IMGS` | "Please pan more slowly" — not enough overlap; each frame needs to overlap the one before it. |
| `STITCH_CAMERA_PARAMS_FAIL` | "Please pan more slowly" — the view moved too much; pivot in one spot, the 0.5× lens is especially sensitive (try 1×). |
| `STITCH_HOMOGRAPHY_FAIL` | "Please pan more slowly" — frames couldn't be aligned; keep the phone level with more overlap. |
| `STITCH_LOW_QUALITY` | "That didn't come out right" — the frames stitched but didn't form one clean image; try again, panning slowly in one direction. |
| `STITCH_OOM` | "Try a shorter sweep" — try a shorter, narrower sweep (or 1× for wide scenes). |
| any non-recoverable code | `null` (show your own generic error UI) |

```tsx
import { userFacingStitchError } from 'react-native-image-stitcher';
import { Alert } from 'react-native';

onError={(err) => {
  const friendly = userFacingStitchError(err.code);
  if (friendly) Alert.alert(friendly.title, friendly.message);
  else report(err.code, err.message);
}}
```

The mapping lives in the SDK so every consumer shows the same vetted
guidance for the same failure. See
[Recipes → Friendly recoverable-stitch alerts](./recipes.md#friendly-recoverable-stitch-alerts-userfacingstitcherror).
