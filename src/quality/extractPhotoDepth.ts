// SPDX-License-Identifier: Apache-2.0
/**
 * extractPhotoDepth — pull the auxiliary AVDepthData out of a captured
 * photo into a `<photo>.depth.bin` sidecar (iOS only).
 *
 * vision-camera's `enableDepthData` makes AVFoundation embed the depth
 * map (stereo disparity on dual-camera iPhones, LiDAR depth on Pro
 * models) as an auxiliary image INSIDE the JPEG.  Nothing surfaces it to
 * JS, and the SDK's `normaliseOrientation` re-encode strips every
 * auxiliary image — so the ONLY window to save the depth is between
 * `takePhoto()` resolving and `normaliseOrientation()` running.
 * `useCapture.takePhoto` enforces that ordering; if you call this
 * yourself, call it FIRST.
 *
 * Sidecar container format (magic `RNISDEP1` + JSON header + float32
 * metres row-major): documented in `PhotoDepthSidecar.swift` and
 * `website/docs/photo-depth.md`.
 */

import { NativeModules } from 'react-native';

import { toBareFilePath } from '../utils/paths';


export interface ExtractPhotoDepthResult {
  /** True when a depth map was found and the sidecar was written. */
  found: boolean;
  /** Why no depth was found (`found: false` only) — e.g. `no-depth-aux`
   *  on single-lens devices / depth-less formats. */
  reason?: string;
  /** Absolute path of the written sidecar (`found: true` only). */
  sidecarPath?: string;
  /** Depth map dimensions (`found: true` only). */
  width?: number;
  height?: number;
  /** Which auxiliary image the photo carried; payload is always metres. */
  source?: 'disparity' | 'depth';
  /** LiDAR-backed captures report `absolute`; stereo may be `relative`. */
  accuracy?: 'absolute' | 'relative';
  quality?: 'high' | 'low';
  /** Whether pinhole intrinsics made it into the sidecar header. */
  hasIntrinsics?: boolean;
  /** Fraction of depth samples that are finite and > 0. */
  validRatio?: number;
  /** Sidecar file size in bytes. */
  bytes?: number;
}


/**
 * Extract the depth of the photo at `imagePath` into `outputPath`.
 *
 * Resolves `null` when the native module isn't available (Android, or an
 * iOS host built against an older native lib) — callers treat that the
 * same as "no depth".  Resolves `{ found: false, reason }` when the photo
 * simply carries no depth.  Never throws for those benign cases; real
 * I/O failures are caught, warned, and collapsed to `null` too, so the
 * capture pipeline can't be failed by an advisory extra.
 */
export async function extractPhotoDepth(
  imagePath: string,
  outputPath: string,
): Promise<ExtractPhotoDepthResult | null> {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['BatchStitcher'];
  const fn =
    native
    && typeof native === 'object'
    && typeof (native as { extractPhotoDepth?: unknown }).extractPhotoDepth === 'function'
      ? (native as {
          extractPhotoDepth: (
            o: { imagePath: string; outputPath: string },
          ) => Promise<ExtractPhotoDepthResult>;
        }).extractPhotoDepth
      : null;

  if (!fn) return null;

  try {
    // Native bridges take BARE paths (src/utils/paths.ts): vision-camera's
    // photo.path can carry the file:// scheme, and CGImageSource treats a
    // scheme-prefixed "path" as an unreadable filename (field 2026-07-10:
    // every extract rejected 'Could not read image: file:///…').
    return await fn({
      imagePath: toBareFilePath(imagePath),
      outputPath: toBareFilePath(outputPath),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[capture-sdk] extractPhotoDepth failed', err);
    // A NATIVE THROW is not "module missing" — report found:false WITH the
    // error as the reason so the result's `depthUnavailableReason` names
    // the real failure ('native-error(…)') instead of the misleading
    // 'native-module-missing' a bare null produces upstream.
    return {
      found: false,
      reason:
        'native-error('
        + String((err as Error)?.message ?? err).slice(0, 100)
        + ')',
    };
  }
}
