/**
 * normaliseOrientation — bake EXIF rotation into a JPEG's pixels.
 *
 * vision-camera writes photos with the camera sensor's native
 * landscape pixels and an EXIF Orientation tag describing how to
 * rotate them for display.  Most consumers (iOS UIImage, RN's
 * `<Image>`) honour the tag — but enough don't (Sentry breadcrumbs,
 * share sheets, the cv::Stitcher itself, third-party image
 * pipelines) that "what's on disk" diverges from "what the user
 * sees" unless we eagerly normalise.
 *
 * This helper round-trips the file through the SDK's native
 * stitcher module, which decodes the JPEG with EXIF rotation
 * applied and re-encodes a clean JPEG with no orientation
 * metadata.  Idempotent on already-normalised files.
 */

import { NativeModules, Platform } from 'react-native';


export interface NormaliseOrientationResult {
  /** Image width in pixels AFTER rotation has been applied. */
  width: number;
  /** Image height in pixels AFTER rotation. */
  height: number;
}


/**
 * Bake the EXIF rotation of `imagePath` into pixels in-place.
 *
 * Returns the post-rotation dimensions so the caller can update
 * its own width/height fields.  No-op on platforms that don't
 * have the native module yet (Android until Phase 3) — falls back
 * to the input shape so callers don't have to special-case
 * platform availability.
 */
export async function normaliseOrientation(
  imagePath: string,
  fallback?: { width: number; height: number },
): Promise<NormaliseOrientationResult> {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['BatchStitcher'];
  const fn =
    native
    && typeof native === 'object'
    && typeof (native as { normaliseOrientation?: unknown }).normaliseOrientation === 'function'
      ? (native as {
          normaliseOrientation: (
            o: { imagePath: string },
          ) => Promise<NormaliseOrientationResult>;
        }).normaliseOrientation
      : null;

  if (!fn) {
    // Native module not registered (typically Android in current
    // builds).  Skip normalisation and report the caller's
    // fallback dimensions if provided, otherwise zeroes — keeps
    // the API total without forcing every caller to wrap a
    // try/catch.
    if (fallback) return fallback;
    // eslint-disable-next-line no-console
    console.warn(
      `[capture-sdk] normaliseOrientation: native module not available on ${Platform.OS}.  `
      + 'Photo orientation may render incorrectly until the native module is registered.',
    );
    return { width: 0, height: 0 };
  }

  try {
    return await fn({ imagePath });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[capture-sdk] normaliseOrientation failed', err);
    if (fallback) return fallback;
    throw err;
  }
}
