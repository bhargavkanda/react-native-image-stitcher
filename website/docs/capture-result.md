---
id: capture-result
title: Capture result & errors
sidebar_position: 8
---

# Capture result & errors

## `CameraCaptureResult`

`onCapture` receives a discriminated union — branch on `type`.

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
      framesRequested: number;
      framesIncluded: number;
      framesDropped: number;
      finalConfidenceThresh: number;
      durationMs: number;
      /** Which cv::Stitcher pipeline the batch finalize actually ran
       *  (after auto-resolution). Useful for a "Stitched as: scans" pill. */
      stitchModeResolved?: 'panorama' | 'scans';
    };
```

```tsx
onCapture={(r) => {
  if (r.type === 'photo') {
    save(r.uri);
  } else {
    console.log(
      `panorama ${r.framesIncluded}/${r.framesRequested} frames, ` +
        `${r.framesDropped} dropped, ${r.durationMs}ms, ` +
        `mode=${r.stitchModeResolved ?? 'n/a'}`,
    );
  }
}}
```

## `CameraError` codes

`onError` receives a `CameraError` whose `code` is one of a fixed
taxonomy, so you can branch deterministically (toast vs retry vs report):

| Code | Meaning |
|---|---|
| `CAMERA_PERMISSION_DENIED` | Camera permission not granted. |
| `CAMERA_DEVICE_UNAVAILABLE` | No usable camera device. |
| `PHOTO_CAPTURE_FAILED` | Single-photo capture failed. |
| `PANORAMA_START_FAILED` | Couldn't start a panorama session. |
| `PANORAMA_FINALIZE_FAILED` | Stitch finalize failed (generic). |
| `STITCH_NEED_MORE_IMGS` | Too few usable keyframes — pan more. |
| `STITCH_HOMOGRAPHY_FAIL` | Couldn't align frames (low overlap/texture). |
| `STITCH_CAMERA_PARAMS_FAIL` | cv::Stitcher couldn't estimate camera params. |
| `STITCH_OOM` | Ran out of memory during stitch. |
| `OUTPUT_WRITE_FAILED` | Couldn't write the output JPEG (check `outputDir`). |
| `VISION_CAMERA_RUNTIME` | Underlying vision-camera runtime error. |

```tsx
onError={(err) => {
  if (err.code === 'STITCH_NEED_MORE_IMGS') retryWithGuidance();
  else report(err.code, err.message);
}}
```

## Friendly copy for recoverable failures — `userFacingStitchError`

The four `STITCH_*` codes are *recoverable* — the user can usually fix them by
re-capturing. The SDK exports `userFacingStitchError(code)`, which returns
ready-to-show `{ title, message }` copy for a host `Alert`/toast instead of the
raw `cv::Stitcher` diagnostic, and returns `null` for every non-recoverable code
(permission denied, device unavailable, generic finalize failure, unknown, …) so
you fall back to your generic error UI.

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
| `STITCH_NEED_MORE_IMGS` | "Couldn't create the panorama" — not enough overlap; pan slowly and steadily. |
| `STITCH_CAMERA_PARAMS_FAIL` | "Couldn't create the panorama" — the view shifted too much; pivot in one spot, the 0.5× lens is especially sensitive (try 1×). |
| `STITCH_HOMOGRAPHY_FAIL` | "Couldn't create the panorama" — frames couldn't be aligned; keep the phone level with more overlap. |
| `STITCH_OOM` | "Panorama too large" — try a shorter, narrower sweep (or 1× for wide scenes). |
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

The mapping lives in the SDK so every consumer shows the same vetted guidance for
the same failure. See [Recipes → Friendly recoverable-stitch alerts](./recipes.md#friendly-recoverable-stitch-alerts-userfacingstitcherror).
