// SPDX-License-Identifier: Apache-2.0
/**
 * outputImage — pure resolvers for the v0.15 `<Camera outputImage>` prop.
 *
 * Host-supplied output controls are forgiving by design (see the v0.15
 * plan): invalid/out-of-range values are normalised rather than thrown.
 * These resolvers are the single source of truth for that normalisation
 * on the JS side; the values they produce are handed to the native
 * finalize / single-photo post-process, which performs the actual
 * pixel resize + JPEG encode.
 *
 *   - `resolveJpegQuality` — clamp to [1, 100], round, default 90.
 *   - `resolveMaxDimensions` — drop non-finite / non-positive axes
 *     (treated as "unbounded"); floor so a cap is never exceeded.
 *
 * Kept pure (no React, no native) so it is exhaustively unit-testable.
 */

/** JPEG quality used when the host supplies none (or an invalid one). */
export const DEFAULT_JPEG_QUALITY = 90;

/** Inclusive JPEG quality bounds honoured by both native encoders. */
const MIN_JPEG_QUALITY = 1;
const MAX_JPEG_QUALITY = 100;

/**
 * Output image encoding + sizing controls (the grouped half of the
 * v0.15 API; `maxInscribedRectCrop` is a separate standalone prop).
 */
export interface OutputImageOptions {
  /**
   * JPEG quality, 1–100 (default 90). Out-of-range values are clamped;
   * fractional values are rounded; non-finite values fall back to the
   * default. Applies to every output: panorama, AR photo, non-AR photo.
   */
  jpegQuality?: number;
  /** Max output width in px. Omitted / ≤ 0 / non-finite ⇒ unbounded. */
  maxWidth?: number;
  /**
   * Max output height in px. Omitted / ≤ 0 / non-finite ⇒ unbounded.
   * Aspect ratio is preserved natively; the result satisfies both caps.
   */
  maxHeight?: number;
}

/**
 * Normalise `outputImage.jpegQuality` into an integer in [1, 100].
 * Missing or non-finite ⇒ {@link DEFAULT_JPEG_QUALITY}.
 */
export function resolveJpegQuality(options?: OutputImageOptions): number {
  const raw = options?.jpegQuality;
  if (raw == null || !Number.isFinite(raw)) {
    return DEFAULT_JPEG_QUALITY;
  }
  const rounded = Math.round(raw);
  return Math.min(MAX_JPEG_QUALITY, Math.max(MIN_JPEG_QUALITY, rounded));
}

/**
 * Normalise the dimension caps. Each axis is independent: a missing,
 * non-positive, or non-finite value becomes `undefined` (unbounded on
 * that axis) so a bad value on one axis never poisons the other.
 * Valid values are floored so the encoded image never exceeds the cap.
 */
export function resolveMaxDimensions(
  options?: OutputImageOptions,
): { maxWidth?: number; maxHeight?: number } {
  return {
    maxWidth: normaliseDimension(options?.maxWidth),
    maxHeight: normaliseDimension(options?.maxHeight),
  };
}

function normaliseDimension(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
