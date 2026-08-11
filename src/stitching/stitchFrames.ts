// SPDX-License-Identifier: Apache-2.0
/**
 * stitchFrames — video / frame stitching API.
 *
 * Implementation status (Phase 2 of #8):
 *   - iOS: Swift native module that vendors upstream OpenCV's iOS
 *     framework and calls `cv::Stitcher::SCANS` mode (designed for
 *     translational shelf captures).  Lives in
 *     `react-native-image-stitcher/ios/Sources/RNImageStitcher/`.
 *   - Android: deferred to Phase 3 — same OpenCV surface, different
 *     build (NDK + Gradle).  Until that lands, Android calls hit the
 *     `StitchNotImplementedError` path below.
 *
 * Why fail loudly instead of falling back to JS?
 *   The cloud-sync pipeline depends on a stitched panorama being
 *   present.  Silently producing a broken or single-frame "panorama"
 *   would corrupt downstream SOS computation.  Hard-failing here lets
 *   the host app surface the unsupported-platform error to the user
 *   immediately rather than discovering it on the server hours later.
 */

import { NativeModules, Platform } from 'react-native';


export interface StitchFramesOptions {
  /**
   * Absolute paths to the input image files in capture order.
   * Must share a camera + focal length (we don't blend across sources).
   */
  framePaths: string[];
  /**
   * Output path for the stitched image (JPEG).  Host app chooses the
   * location (tmp vs. cache vs. Documents).
   */
  outputPath: string;
  /** JPEG quality [0-100].  Default 85. */
  quality?: number;
  /**
   * cv::Stitcher registration model.  `'scans'` = the affine SCANS model
   * (suited to translational captures with a bounded canvas); `'panorama'` =
   * the rotational Panorama model.  ABSENT = each platform's historical
   * default (iOS: Panorama; Android: scans) — passing nothing changes
   * nothing.
   */
  stitchMode?: 'panorama' | 'scans';
  /**
   * Per-frame compose budget in MEGAPIXELS.  > 0 overrides the platform's
   * compose pin (1.0 MP); the native canvas-budget guard still downscales
   * when the total canvas exceeds the RAM budget, so a large value stays
   * memory-safe.  Absent / <= 0 = historical behaviour.
   */
  compositingResolMP?: number;
  /**
   * Feature-registration budget in MEGAPIXELS.  > 0 overrides the platform's
   * registration resolution (cv::Stitcher default 0.6 MP).  Absent / <= 0 =
   * historical behaviour.
   */
  registrationResolMP?: number;
  /**
   * Pipeline selector.  `true` = the manual cv::detail pipeline (graphcut
   * seams + multiband blend, with the full memory-guard machinery); `false` =
   * the stock high-level cv::Stitcher.  ABSENT = each platform's historical
   * default for this entry point (iOS: high-level; Android: manual).
   */
  useManualPipeline?: boolean;
}


export interface StitchFramesResult {
  /** Absolute path to the stitched image on disk. */
  outputPath: string;
  /** Pixel dimensions of the stitched image. */
  width: number;
  height: number;
  /** Wall-clock ms the stitcher took (host apps log this for perf tracking). */
  durationMs: number;
}


/**
 * Stitch ``framePaths`` into a single panoramic image.
 *
 * Throws ``StitchNotImplementedError`` until the native module ships.
 * Callers should catch that specific error and fall back gracefully
 * (e.g. surface a "single-frame mode only" banner in the UI).
 */
export async function stitchFrames(
  options: StitchFramesOptions,
): Promise<StitchFramesResult> {
  // Look for the native module by its canonical name so we can flip
  // this function to "implemented" simply by registering the module
  // in AppDelegate / MainApplication.
  const native: unknown =
    (NativeModules as Record<string, unknown>)['BatchStitcher'];
  if (native && typeof native === 'object' && 'stitch' in (native as object)) {
    const fn = (native as { stitch: (o: StitchFramesOptions) => Promise<StitchFramesResult> }).stitch;
    return fn(options);
  }

  throw new StitchNotImplementedError(
    `stitchFrames is not yet implemented on ${Platform.OS}. `
    + 'The react-native-image-stitcher native stitcher module is expected '
    + 'but not registered — the JS shim is throwing by design so the '
    + 'host app can fall back to single-frame mode rather than ship '
    + 'broken panoramas.',
  );
}


export class StitchNotImplementedError extends Error {
  public readonly code = 'STITCH_NOT_IMPLEMENTED';
  constructor(message: string) {
    super(message);
    this.name = 'StitchNotImplementedError';
  }
}
