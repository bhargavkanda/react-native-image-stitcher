// SPDX-License-Identifier: Apache-2.0
/**
 * computeInscribedRect — resolve the largest axis-aligned rectangle that
 * fits entirely inside the non-black (coverage) region of a stitched
 * panorama, via native `BatchStitcher.computeInscribedRect`.
 *
 * Used to SEED the post-capture crop editor (`RectCropPreview`): instead of
 * a blind 8 %-inset rectangle, the editor opens on the max-inscribed rect —
 * the tightest clean rectangle with no black corners — which the user then
 * fine-tunes.  Best-effort: callers fall back to the default inset seed if
 * the native module is absent or the call rejects.
 *
 * Same native module + defensive-availability posture as
 * `src/stitching/cropQuad.ts` and `src/quality/normaliseOrientation.ts`.
 * The native side (Android `BatchStitcher.computeInscribedRect`, iOS
 * `OpenCVStitcher.computeInscribedRect`) is the exact `maxInscribedRectFromMask`
 * port used by the opt-in auto-crop, so the seed matches what that crop would
 * pick — only here the user can then drag outward to keep more content.
 */

import { NativeModules } from 'react-native';


/** Resolved max-inscribed rectangle, in image-pixel coords. */
export interface InscribedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Intrinsic dimensions of the source image the rect was computed on. */
  imageWidth: number;
  imageHeight: number;
}

/** The shape of the native module method we call. */
interface InscribedRectNativeModule {
  computeInscribedRect: (options: {
    imagePath: string;
  }) => Promise<InscribedRect>;
}


/**
 * Resolve the native `computeInscribedRect` function off
 * `NativeModules.BatchStitcher`, or `null` when the module / method isn't
 * registered (e.g. an older native build).
 */
function resolveComputeInscribedRect():
  | InscribedRectNativeModule['computeInscribedRect']
  | null {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['BatchStitcher'];
  if (
    native
    && typeof native === 'object'
    && typeof (native as { computeInscribedRect?: unknown })
      .computeInscribedRect === 'function'
  ) {
    return (native as InscribedRectNativeModule).computeInscribedRect;
  }
  return null;
}


/**
 * Compute the max-inscribed rectangle of `imagePath`'s coverage mask.
 *
 * @param imagePath  file:// URI or bare path of the stitched image (the
 *                   native side strips the scheme).
 * @returns the inscribed rect, or `null` when the native module isn't
 *   registered (older native build) — callers then fall back to the default
 *   seed.  REJECTS only if the native call itself errors (decode / read
 *   failure); callers should catch and treat the rejection as "no seed".
 */
export async function computeInscribedRect(
  imagePath: string,
): Promise<InscribedRect | null> {
  const fn = resolveComputeInscribedRect();
  if (!fn) return null;
  return fn({ imagePath });
}
