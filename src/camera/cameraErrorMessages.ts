// SPDX-License-Identifier: Apache-2.0
/**
 * Friendly, action-guiding copy for the *recoverable* stitch-failure
 * `CameraErrorCode`s — the ones a user can fix by simply re-capturing.
 * Hosts map these onto an Alert/toast instead of surfacing the raw
 * cv::Stitcher diagnostic (e.g. "warpRoi too large (8171x12336) —
 * estimator produced degenerate camera params").
 *
 * Returns `null` for every non-recoverable / non-stitch code (permission
 * denied, device unavailable, generic finalize failure, unknown, ...):
 * those have no single corrective action to suggest, so the host should
 * fall back to its generic error display.
 *
 * Lives in the SDK (not per-host) so every consumer shows the same
 * vetted guidance for the same failure — and so the mapping is
 * unit-testable in isolation.
 */
import type { CameraErrorCode } from './Camera';

export interface UserFacingStitchError {
  /** Short, friendly alert title. */
  title: string;
  /** One-paragraph, plain-language corrective guidance. */
  message: string;
}

/**
 * The four recoverable stitch outcomes, each with copy tuned to its
 * actual root cause.  `Partial<Record<...>>` keeps the keys
 * compile-checked against the `CameraErrorCode` union — a renamed or
 * dropped code breaks the build here rather than silently going
 * unhandled.
 */
const RECOVERABLE_STITCH_GUIDANCE: Partial<
  Record<CameraErrorCode, UserFacingStitchError>
> = {
  // cv::Stitcher ERR_NEED_MORE_IMGS / the manual pipeline's "0 valid
  // pairwise matches" — the frames simply don't overlap enough to chain.
  STITCH_NEED_MORE_IMGS: {
    title: 'Please pan more slowly',
    message:
      "There wasn't enough overlap between the frames to stitch them "
      + 'together — each frame needs to overlap the one before it.',
  },
  // Bundle adjuster produced degenerate camera params (the warp canvas
  // blew past the size guard) — almost always real camera *translation*
  // breaking PANORAMA mode's pure-rotation assumption, amplified hugely
  // on the ultra-wide lens.
  STITCH_CAMERA_PARAMS_FAIL: {
    title: 'Please pan more slowly',
    message:
      'The view moved too much between frames to line them up — usually '
      + 'because the phone moved through space rather than just turning. '
      + 'The ultra-wide (0.5x) lens is especially sensitive to this, so '
      + 'try 1x for wide scenes.',
  },
  // Pairwise homography estimation failed — frames couldn't be aligned.
  STITCH_HOMOGRAPHY_FAIL: {
    title: 'Please pan more slowly',
    message:
      "The frames couldn't be aligned — keep the phone level and steady so "
      + 'each frame overlaps the one before it.',
  },
  // Ran out of memory finishing the stitch — usually an over-long sweep.
  STITCH_OOM: {
    title: 'Try a shorter sweep',
    message:
      'This panorama needs more memory than the device can spare to finish '
      + '— a shorter, narrower sweep (or 1x for wide scenes) will fit.',
  },
};

/**
 * Maps a `CameraErrorCode` to friendly, action-guiding alert copy.
 *
 * @returns the title+message for a recoverable stitch failure, or `null`
 *   if `code` has no single user-recoverable action (the host should
 *   then show its generic error UI).
 */
export function userFacingStitchError(
  code: CameraErrorCode,
): UserFacingStitchError | null {
  return RECOVERABLE_STITCH_GUIDANCE[code] ?? null;
}
