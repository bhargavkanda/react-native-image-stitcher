# Deferred: v0.15 `outputImage` output controls (2026-06-05)

**Status: DEFERRED** — implemented in v0.15, then **backed out** before release
because the re-encode rotated portrait photos. The capture/stitch pipeline is
unchanged; this only removes the optional post-process. Pick it up later with
the orientation fix below.

## What the feature was

A `<Camera outputImage={...}>` prop that post-processed every produced image
(stitched panorama, AR single photo, non-AR single photo) to cap its size and
re-encode it:

| Field | Type | Default | Behaviour |
|---|---|---|---|
| `outputImage.jpegQuality` | `number` 1–100 | **90** | clamp + round; re-encode |
| `outputImage.maxWidth` | `number` px | **unbounded** | downscale-to-fit, aspect preserved |
| `outputImage.maxHeight` | `number` px | **unbounded** | downscale-to-fit, aspect preserved |

> **NOT deferred:** the standalone `maxInscribedRectCrop` prop is a *separate*
> feature (the cpp inscribed-rect crop at finalize — no re-encode). It works and
> stays in the public API. Only the `outputImage` re-encode path was removed.

## Why it was deferred — the bug

The JS `applyOutputControls` wrapper called the native `BatchStitcher.applyOutputControls`,
which on Android does: OpenCV `imread` (ignores EXIF) → `applyExifOrientation`
(bake the EXIF tag into pixels) → `Imgproc.resize` → `imwrite` (**strips EXIF**).

On a **Samsung SM-A356U1**, portrait photos are stored as landscape pixels
(`4080×3060`) with **EXIF Orientation = 6 (rotate-90-CW)**. Fresco (RN `<Image>`)
and PIL both honour that tag → portrait. But **androidx `ExifInterface`
`getAttributeInt(TAG_ORIENTATION, …)` returned `ORIENTATION_NORMAL`** for the same
file, so `applyExifOrientation` no-op'd. The re-encode then stripped the EXIF →
the output was landscape pixels with no orientation tag → **portrait photos
displayed rotated 90° CW** (both AR and non-AR).

Confirmed empirically: raw source (re-encode off) displayed upright; processed
output (`1024×768`, no EXIF) was rotated. `sips -g orientation` and androidx
`ExifInterface` both missed the tag that PIL/Fresco read.

The **resize + quality logic itself was correct** (verified on device — a
`4080×3060` photo did downscale to `1024×768`). Only the orientation handling
in the re-encode is broken.

## What was removed (JS + native — full revert)

The `applyOutputControls` feature was removed **entirely** (not left dormant).
`normaliseImage`, the shared `applyExifOrientation` helper, and the whole rect-crop
surface (`maxInscribedRectCrop`, `computeInscribedRect`/`cropToRect`/`debugMaskOverlay`,
the cpp inscribed crop) are untouched.

**JS:**
- `src/camera/Camera.tsx` — the `outputImage` prop, its destructure, the photo +
  panorama `applyOutputControls` blocks, the `qualityAppliedAtCapture` flag, and
  the deps. Panorama finalize + AR `takePhoto` now pass a literal `90` quality.
- `src/index.ts` — the `OutputImageOptions` export.
- Deleted: `src/camera/outputImage.ts`, `src/camera/applyOutputControls.ts`, and
  their `__tests__`.

**Native:**
- Android `BatchStitcher.kt` — the `applyOutputControls` `@ReactMethod`.
- iOS `OpenCVStitcher.{h,mm}`, `Stitcher.swift`, `StitcherBridge.{swift,m}` — the
  `applyOutputControls` declaration, implementation, Swift wrapper, `@objc` bridge
  method, and `RCT_EXTERN_METHOD`.

All of the removed code is recoverable from git history (the back-out commit's
parent). The original implementation landed across these v0.15 commits:
`f2f5cec` (resolvers), `eb4fd88` / `877c445` (wire props), `bd622fe` (single-photo
post-process), `c1ed838` (panorama clamp), `fe5ab2c` / `b000f6b` (native
`applyOutputControls`), `04acea4` (apply jpegQuality).

## To revive it later — fix the orientation first

The re-encode must **not** rely on androidx `ExifInterface` for orientation (it
failed on the device that mattered). Two viable approaches, in preference order:

1. **Thread the device orientation from JS** (recommended). The capture path
   already has `deviceOrientation`, and the panorama `finalize` already uses it to
   bake rotation natively. Pass it into `applyOutputControls` and rotate by it —
   no EXIF parsing at all. Most reliable.
2. **Preserve the EXIF tag** instead of baking: resize the stored pixels without
   rotating, then write the source orientation tag onto the output. Caveat: this
   still needs a *reliable* read of the source tag (the failing part) and assumes
   EXIF-aware consumers; a square cap is fine but an asymmetric cap would apply to
   stored (not display) dimensions.

Then restore the JS surface (revert the back-out commit), re-run the unit tests,
and **re-test portrait capture on a Samsung device** (AR + non-AR) — that was the
case that exposed the bug.
