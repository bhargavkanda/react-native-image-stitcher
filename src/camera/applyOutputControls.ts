// SPDX-License-Identifier: Apache-2.0
/**
 * applyOutputControls — single-photo output-controls post-process (v0.15).
 *
 * The stitched panorama applies quality + max-dimensions inside the
 * native finalize. Single photos (AR + non-AR) instead route through a
 * dedicated native method, `BatchStitcher.applyOutputControls`, which
 * decodes the JPEG, optionally downscales it (aspect preserved) to fit
 * the caps, and re-encodes at the requested quality — overwriting the
 * file in place and returning the final pixel dimensions.
 *
 * Why guarded (`shouldApplyOutputControls`):
 *   - The AR takePhoto path already encodes at the requested quality, so
 *     a quality-only request needs no extra work there.
 *   - The non-AR path (vision-camera v4 dropped `quality`) has no
 *     encode hook, so any non-default quality OR any dimension cap must
 *     go through this post-process.
 *   - When neither a cap nor a quality re-encode is needed, we skip the
 *     native call entirely — keeping the no-controls path byte-identical
 *     to pre-v0.15 (no decode/re-encode cost or generation loss).
 *
 * Graceful absence: if the native method isn't registered (before the
 * native phase ships, or on a platform that lacks it), this returns
 * `{ applied: false }` and the caller keeps the original file untouched
 * — mirroring `normaliseOrientation`'s degrade-to-no-op contract.
 */
import { NativeModules } from 'react-native';

import { toBareFilePath } from '../utils/paths';
import { DEFAULT_JPEG_QUALITY } from './outputImage';

export interface ApplyOutputControlsOptions {
  /** Resolved JPEG quality in [1, 100]. */
  quality: number;
  /** Resolved max width (px, > 0) or undefined for unbounded. */
  maxWidth?: number;
  /** Resolved max height (px, > 0) or undefined for unbounded. */
  maxHeight?: number;
}

export interface ApplyOutputControlsResult {
  /** The image path/URI to use downstream (unchanged — native edits in place). */
  path: string;
  /** Final width after the post-process (undefined when not applied). */
  width?: number;
  /** Final height after the post-process (undefined when not applied). */
  height?: number;
  /** True iff the native post-process actually ran. */
  applied: boolean;
}

/**
 * Whether a freshly-captured single photo needs the native
 * resize/re-encode post-process. See the module header for the rules.
 *
 * @param qualityAppliedAtCapture true when the capture API already
 *   encoded at the requested quality (the AR takePhoto path); false for
 *   the non-AR path, which has no quality control of its own.
 */
export function shouldApplyOutputControls(opts: {
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
  qualityAppliedAtCapture: boolean;
}): boolean {
  if (opts.maxWidth != null || opts.maxHeight != null) {
    return true;
  }
  if (!opts.qualityAppliedAtCapture && opts.quality !== DEFAULT_JPEG_QUALITY) {
    return true;
  }
  return false;
}

interface NativeApplyOutputControls {
  (options: {
    imagePath: string;
    maxWidth?: number;
    maxHeight?: number;
    quality: number;
  }): Promise<{ width: number; height: number }>;
}

/**
 * Run the native post-process on `imagePath`. The native side edits the
 * file in place, so the returned `path` equals the input (preserving its
 * URI scheme); only the dimensions change. No-ops gracefully when the
 * native method is unavailable.
 */
export async function applyOutputControls(
  imagePath: string,
  opts: ApplyOutputControlsOptions,
): Promise<ApplyOutputControlsResult> {
  const mod = (NativeModules as Record<string, unknown>)['BatchStitcher'];
  const fn =
    mod
    && typeof mod === 'object'
    && typeof (mod as { applyOutputControls?: unknown }).applyOutputControls
      === 'function'
      ? (mod as { applyOutputControls: NativeApplyOutputControls })
          .applyOutputControls
      : null;

  if (!fn) {
    return { path: imagePath, applied: false };
  }

  const res = await fn({
    imagePath: toBareFilePath(imagePath),
    maxWidth: opts.maxWidth,
    maxHeight: opts.maxHeight,
    quality: opts.quality,
  });

  return {
    path: imagePath,
    width: res?.width,
    height: res?.height,
    applied: true,
  };
}
