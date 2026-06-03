// SPDX-License-Identifier: Apache-2.0
/**
 * stitchVideo — end-to-end "video → panorama" API.
 *
 * The host app records video while the user holds the shutter; on
 * release we hand the video file path to this function and it
 * returns a single stitched panoramic JPEG.  Internally:
 *
 *   1. Native side extracts N evenly-spaced frames from the video
 *      (AVAssetImageGenerator on iOS, MediaMetadataRetriever on
 *      Android once Phase 3 lands).
 *   2. Native side feeds the frames into `cv::Stitcher::SCANS`.
 *   3. Frames are deleted; only the final panorama remains.
 *
 * The single bridge call keeps the JS thread out of the
 * extract→stitch dance entirely; nothing has to round-trip frame
 * paths back to JS just to hand them to a sibling native call.
 */

import { NativeModules, Platform } from 'react-native';

import type { StitchFramesResult } from './stitchFrames';
import { StitchNotImplementedError } from './stitchFrames';


export interface StitchVideoOptions {
  /**
   * Absolute path to the recorded video file.  Accepts paths with
   * or without the `file://` prefix — the native module strips it.
   */
  videoPath: string;
  /**
   * Where the resulting panoramic JPEG should be written.
   */
  outputPath: string;
  /**
   * Number of frames to sample from the video.  Default 10 — the
   * empirical sweet spot for shelf scans on iPhone hardware: enough
   * overlap that homography stays robust, few enough that stitching
   * stays under 4 seconds.  Increase only if the user pans further
   * than ~1 m of shelf in a single hold.
   */
  maxFrames?: number;
  /**
   * JPEG quality [0..100].  Applied to BOTH the intermediate frames
   * (extracted from video) AND the final panorama.  Default 85.
   */
  quality?: number;
  /**
   * Projection used during the warp step.  See native side for
   * details.  Default `'plane'` — straight verticals/horizontals,
   * good for shelf scans + close-up subjects.  Hourglass shape on
   * partial arcs is handled by the rectangular-crop step.
   *   - `'plane'`: flat projection.  Best for ≤30° pans.
   *   - `'cylindrical'`: handles rotational mid-arc pans.
   *   - `'spherical'`: full 90°+ panoramic captures.
   */
  warperType?: 'plane' | 'cylindrical' | 'spherical';
  /**
   * Blending strategy across stitched seams.
   *   - `'multiband'` (default): high-quality seams when alignment
   *     is good; can produce visible halos when adjacent frames
   *     have inconsistent exposure.
   *   - `'feather'`: simple alpha-weighted blend; faster + no
   *     halo artifacts; slightly more visible seam edge.
   */
  blenderType?: 'multiband' | 'feather';
  /**
   * Seam finding strategy.
   *   - `'graphcut'` (default): cv::detail::GraphCutSeamFinder
   *     finds optimal cuts before blending — pairs beautifully
   *     with `multiband`, but holds all warped frames in memory
   *     simultaneously (higher peak).
   *   - `'skip'`: streams warp+feed in a single pass, never
   *     holding more than one warped frame.  Lower peak memory.
   *     Right choice on low-RAM devices or with `feather`.
   */
  seamFinderType?: 'graphcut' | 'skip';
}


/**
 * Stitch a recorded video file into a single panoramic JPEG.
 *
 * Throws `StitchNotImplementedError` on platforms where the native
 * stitcher hasn't shipped yet (Android until Phase 3).  Throws an
 * Error with a code-like message on stitcher failures the JS layer
 * may want to recover from (see `StitcherError` cases on the native
 * side: `insufficient-frames`, `read-failed`, `write-failed`,
 * `opencv-failed-<code>`).
 */
export async function stitchVideo(
  options: StitchVideoOptions,
): Promise<StitchFramesResult> {
  const native: unknown =
    (NativeModules as Record<string, unknown>)['BatchStitcher'];
  if (
    native
    && typeof native === 'object'
    && typeof (native as { stitchVideo?: unknown }).stitchVideo === 'function'
  ) {
    const fn = (native as {
      stitchVideo: (o: StitchVideoOptions) => Promise<StitchFramesResult>;
    }).stitchVideo;
    // 60-second hard deadline.  cv::Stitcher::stitch can occasionally
    // grind for minutes inside bundle adjustment on hard inputs (low
    // texture, extreme parallax).  A timeout converts those into a
    // clear UI error rather than letting the stitching banner sit
    // forever.  Real stitches finish in 2-8 seconds on iPhone with
    // the tuned PANORAMA settings; 60 s is comfortably above that.
    return Promise.race([
      fn(options),
      new Promise<StitchFramesResult>((_, reject) => {
        setTimeout(
          () => reject(new Error('stitch-timeout: stitching took longer than 30 s')),
          30_000,
        );
      }),
    ]);
  }

  throw new StitchNotImplementedError(
    `stitchVideo is not yet implemented on ${Platform.OS}. `
    + 'The react-native-image-stitcher native stitcher module is expected '
    + 'but not registered (or the build predates Phase 2.5 of #8).',
  );
}
