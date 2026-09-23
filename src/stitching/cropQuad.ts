// SPDX-License-Identifier: Apache-2.0
/**
 * cropQuad — item-7 perspective crop: rectify a user-dragged
 * quadrilateral to an upright rectangle.
 *
 * The post-capture crop editor (`src/camera/RectCropPreview.tsx`) lets the
 * user drag 4 independent corners over the stitched result.  When that
 * quad isn't ~axis-aligned, the host calls THIS wrapper instead of the
 * cheap `cropToRect`: it hands the 4 IMAGE-PIXEL corners to the native
 * `BatchStitcher.cropToQuad`, which runs
 * `cv::getPerspectiveTransform` + `cv::warpPerspective` to produce an
 * upright rectangle (averaged opposite-edge dimensions).
 *
 * ⚠ IT NO LONGER ALWAYS OVERWRITES IN PLACE. `outPath` sends the result
 * somewhere else, because one deliverable must not be overwritten: a pano+
 * canvas is referenced by its pack, so cropping it in place desyncs the pack
 * from the image it describes. Omitted ⇒ in place, which is every caller
 * before 2026-09 and is byte-identical for them. See {@link cropQuad} for
 * the preflight that makes a destination safe against a native build that
 * predates the option.
 *
 * This is the typed twin of the `cropToRect` call in
 * `example/InscribedRectDebug.tsx` — same native module (`BatchStitcher`),
 * same `{ width, height }` result contract, same platform-availability
 * fallback posture as `src/quality/normaliseOrientation.ts`.
 *
 * Corner-order contract: `quadImagePoints` MUST be in canonical
 * [TL, TR, BR, BL] (clockwise from top-left) order — exactly what
 * `cropGeometry.ts:orderQuadCorners` produces and `RectCropResult.quad`
 * carries.  The native side rectifies into a rectangle whose corners map
 * TL→(0,0), TR→(w,0), BR→(w,h), BL→(0,h); pass un-ordered points and the
 * output is mirrored / rotated.
 */

import { NativeModules, Platform } from 'react-native';

import type { Point, Quad } from '../camera/cropGeometry';
import { stripCropCacheBuster } from '../utils/paths';


/** Options for {@link cropQuad}. */
export interface CropQuadOptions {
  /**
   * JPEG quality for the re-encoded output, 1–100.  Defaults to 90 (the
   * native default, matching `cropToRect`).
   */
  quality?: number;
}

/** Resolved result of a successful {@link cropQuad}. */
export interface CropQuadResult {
  /**
   * The file the rectified image was actually written to — READ IT rather
   * than assuming, which is why it is here.
   *
   * ⚠ IT NO LONGER ALWAYS EQUALS `imagePath`. This said "Equals the input
   * `imagePath` (the native crop overwrites in place)" while {@link cropQuad}
   * sixty lines down had already gained a destination, and a host that took
   * the IDE tooltip at face value and ran `uploadAndDelete(imagePath)` after
   * a crop to a sibling would delete the source and leak the crop.
   *
   * With no `outPath`, or one equal to `imagePath`, it IS `imagePath` — the
   * in-place contract every caller before 2026-09 had.
   */
  outputPath: string;
  /** Width of the rectified rectangle, in pixels. */
  width: number;
  /** Height of the rectified rectangle, in pixels. */
  height: number;
}


/** The shape of the native module method we call. */
interface CropQuadNativeModule {
  cropToQuad: (options: {
    imagePath: string;
    quad: number[];
    quality: number;
    /** Absent ⇒ in place. Both platforms honour it; see {@link cropQuad}. */
    outputPath?: string;
  }) => Promise<{
    width: number;
    height: number;
    /** Where it landed. Absent on a native build older than this option. */
    outputPath?: string;
  }>;
}


/**
 * Resolve the native `cropToQuad` function off `NativeModules.BatchStitcher`,
 * or `null` when the module / method isn't registered (e.g. an older native
 * build).  Same defensive lookup as `normaliseOrientation`.
 */
/**
 * Does the linked NATIVE build honour `outputPath`?
 *
 * ⚠ THE PRESENCE OF A MARKER METHOD, CHECKED BEFORE ANYTHING IS WRITTEN. A
 * native build that predates the option ignores the unknown key and rewrites
 * `imagePath` IN PLACE. Reading that back from the RESULT — which this module
 * also does, as a belt — is too late: on the sweep path the file it just
 * destroyed is the pack's `canvas.jpg`, and JS newer than native is the
 * routine state in this project (a Metro reload without a rebuild).
 *
 * A react-native module's methods are enumerable from JS, so this is a
 * synchronous answer with no bridge round trip and nothing to get wrong.
 */
export function cropQuadSupportsOutputPath(): boolean {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['BatchStitcher'];
  return (
    native != null
    && typeof native === 'object'
    && typeof (native as { cropToQuadAcceptsOutputPath?: unknown })
      .cropToQuadAcceptsOutputPath === 'function'
  );
}

function resolveCropToQuad(): CropQuadNativeModule['cropToQuad'] | null {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['BatchStitcher'];
  if (
    native
    && typeof native === 'object'
    && typeof (native as { cropToQuad?: unknown }).cropToQuad === 'function'
  ) {
    return (native as CropQuadNativeModule).cropToQuad;
  }
  return null;
}


/**
 * Flatten the 4 ordered ([TL, TR, BR, BL]) image-pixel corners into the
 * `[tlX, tlY, trX, trY, brX, brY, blX, blY]` array the native module
 * expects.  Exported for unit tests + reuse.
 */
export function flattenQuad(quad: Quad): number[] {
  const out: number[] = [];
  for (const p of quad as ReadonlyArray<Point>) {
    out.push(p.x, p.y);
  }
  return out;
}


/**
 * Perspective-rectify `quadImagePoints` out of `imagePath` into an upright
 * rectangle and resolve the output path + rectified dimensions.
 *
 * @param imagePath        file:// URI (or bare path) of the image to crop.
 * @param quadImagePoints  the 4 corners in IMAGE-PIXEL space, canonically
 *                         ordered [TL, TR, BR, BL] (use
 *                         `orderQuadCorners`).  This is exactly
 *                         `RectCropResult.quad`.
 * @param outPath          where to write the result.  Omitted ⇒ IN PLACE,
 *                         which is what every caller before 2026-09 did and
 *                         is byte-identical for them.
 *
 *                         ⚠ IT USED TO THROW ON ANY OTHER VALUE, and that
 *                         limitation had a cost the note recording it did
 *                         not anticipate: the crop editor was disabled
 *                         outright on the SWEEP engine, because a pano+
 *                         canvas is referenced by its pack
 *                         (`sessionDir/canvas.jpg`) and cropping it in
 *                         place desyncs the two — every offline harness
 *                         then reads a pack whose image is not the image
 *                         that was measured.  So the operator got a crop
 *                         preview on one engine and a bare image on the
 *                         other, which he reported as a defect.  Both
 *                         natives now take an `outputPath`.
 * @param opts             optional `{ quality }`.
 *
 * @throws if the native module isn't registered, or if the native crop
 *         rejects (degenerate quad, canvas guard, write failure).
 */
export async function cropQuad(
  imagePath: string,
  quadImagePoints: Quad,
  outPath?: string,
  opts?: CropQuadOptions,
): Promise<CropQuadResult> {
  const fn = resolveCropToQuad();
  if (!fn) {
    throw new Error(
      `[capture-sdk] cropQuad: native module BatchStitcher.cropToQuad not `
      + `available on ${Platform.OS}.  Ensure the native module is registered.`,
    );
  }

  // The crop editor's `?t=<ms>` cache-buster is not part of the file: native
  // strips only `file://`, so kept it looked for `…jpg?t=…` and refused with
  // "Image not found" — the uri a default host now gets from every Crop.
  imagePath = stripCropCacheBuster(imagePath);
  if (outPath !== undefined) outPath = stripCropCacheBuster(outPath);
  const quality = clampQuality(opts?.quality);
  const wantsElsewhere = outPath !== undefined && outPath !== imagePath;
  // ⚠ REFUSE BEFORE NATIVE TOUCHES THE FILE, not after. The post-hoc echo
  // check below is a belt; this is the braces, and it is the one that runs
  // in time. Without it a stale native rewrote the source in place and JS
  // only noticed from the missing echo — by which point, on the sweep path,
  // the pack's `canvas.jpg` was already gone.
  if (wantsElsewhere && !cropQuadSupportsOutputPath()) {
    throw new Error(
      `[capture-sdk] cropQuad: this native build does not honour outputPath `
      + `(${String(outPath)}) and would overwrite ${imagePath} in place. `
      + `Rebuild the native module, or pass no outPath.`,
    );
  }
  const dims = await fn({
    imagePath,
    quad: flattenQuad(quadImagePoints),
    quality,
    // Only sent when it differs, so a native build that predates the option
    // sees the exact bag it has always seen.
    ...(wantsElsewhere ? { outputPath: outPath } : {}),
  });
  // ⚠ TRUST NATIVE'S ANSWER OVER OUR REQUEST WHEN IT GIVES ONE. A build that
  // predates `outputPath` ignores the key and writes IN PLACE — and would
  // then have this function report a path with no file at it, which is the
  // silent failure the old throw existed to prevent. Both current natives
  // echo where they wrote.
  const landed = typeof dims.outputPath === 'string' && dims.outputPath !== ''
    ? dims.outputPath
    : imagePath;
  if (wantsElsewhere && landed === imagePath) {
    throw new Error(
      `[capture-sdk] cropQuad: this native build wrote IN PLACE and ignored `
      + `outputPath (${String(outPath)}). Update the native module, or pass `
      + `no outPath.`,
    );
  }
  return {
    outputPath: landed,
    width: dims.width,
    height: dims.height,
  };
}


/** Clamp the requested JPEG quality into [1, 100]; default 90. */
function clampQuality(quality?: number): number {
  if (quality === undefined || Number.isNaN(quality)) return 90;
  if (quality < 1) return 1;
  if (quality > 100) return 100;
  return Math.round(quality);
}
