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
 * upright rectangle (averaged opposite-edge dimensions) and overwrites the
 * file in place.
 *
 * This is the typed twin of the `cropToRect` call in
 * `example/InscribedRectDebug.tsx` — same native module (`BatchStitcher`),
 * same in-place overwrite + `{ width, height }` result contract, same
 * platform-availability fallback posture as
 * `src/quality/normaliseOrientation.ts`.
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
   * The file the rectified image was written to.  Equals the input
   * `imagePath` (the native crop overwrites in place) — surfaced
   * explicitly so callers don't have to assume the in-place contract.
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
  }) => Promise<{ width: number; height: number }>;
}


/**
 * Resolve the native `cropToQuad` function off `NativeModules.BatchStitcher`,
 * or `null` when the module / method isn't registered (e.g. an older native
 * build).  Same defensive lookup as `normaliseOrientation`.
 */
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
 * rectangle, overwriting the file in place, and resolve the output path +
 * rectified dimensions.
 *
 * @param imagePath        file:// URI (or bare path) of the image to crop.
 * @param quadImagePoints  the 4 corners in IMAGE-PIXEL space, canonically
 *                         ordered [TL, TR, BR, BL] (use
 *                         `orderQuadCorners`).  This is exactly
 *                         `RectCropResult.quad`.
 * @param outPath          where to write the result.  The native crop
 *                         OVERWRITES IN PLACE, so this currently MUST equal
 *                         `imagePath` (or be omitted — defaults to it).
 *                         Passing a different path throws, surfacing the
 *                         limitation rather than silently ignoring it; see
 *                         the integrator note in the item-7 handoff.
 * @param opts             optional `{ quality }`.
 *
 * @throws if the native module isn't registered, if `outPath` differs from
 *         `imagePath`, or if the native crop rejects (degenerate quad,
 *         canvas guard, write failure).
 */
export async function cropQuad(
  imagePath: string,
  quadImagePoints: Quad,
  outPath?: string,
  opts?: CropQuadOptions,
): Promise<CropQuadResult> {
  if (outPath !== undefined && outPath !== imagePath) {
    // The native cropToQuad (like cropToRect) only overwrites in place.
    // Fail loudly rather than silently writing to imagePath and returning
    // a path the file isn't at.
    throw new Error(
      '[capture-sdk] cropQuad: native crop overwrites in place; '
      + 'outPath must equal imagePath (or be omitted).',
    );
  }

  const fn = resolveCropToQuad();
  if (!fn) {
    throw new Error(
      `[capture-sdk] cropQuad: native module BatchStitcher.cropToQuad not `
      + `available on ${Platform.OS}.  Ensure the native module is registered.`,
    );
  }

  const quality = clampQuality(opts?.quality);
  const dims = await fn({
    imagePath,
    quad: flattenQuad(quadImagePoints),
    quality,
  });
  return {
    outputPath: imagePath,
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
