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
/**
 * A partial map of recoverable-error code → copy, for the `overrides`
 * argument of {@link userFacingStitchError}.  Hosts localising the SDK pass
 * their translated strings here (typically built from their i18n catalogue,
 * keyed by the same `CameraErrorCode`s exposed by {@link RECOVERABLE_STITCH_CODES}).
 */
export type UserFacingStitchErrorOverrides = Partial<
  Record<CameraErrorCode, UserFacingStitchError>
>;

export const RECOVERABLE_STITCH_GUIDANCE: Partial<
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
  // v0.16 — the post-stitch validator rejected the output as disjoint /
  // fragmented: the frames stitched but didn't form one coherent panorama
  // (usually a too-fast or jerky sweep that broke alignment partway).
  STITCH_LOW_QUALITY: {
    title: "That didn't come out right",
    message:
      "The panorama didn't stitch into one clean image — try again, panning "
      + 'slowly and steadily in one direction so each frame overlaps the last.',
  },
  // Ran out of memory finishing the stitch — usually an over-long sweep.
  STITCH_OOM: {
    title: 'Try a shorter sweep',
    message:
      'This panorama needs more memory than the device can spare to finish '
      + '— a shorter, narrower sweep (or 1x for wide scenes) will fit.',
  },
  // v0.25 — the hold ended before enough of the scene was captured.  The
  // copy deliberately says what to DO differently rather than naming
  // keyframes, which means nothing to an operator.
  CAPTURE_TOO_SHORT: {
    title: 'Hold and pan a little longer',
    message:
      'The capture ended before enough of the scene was covered. Keep '
      + 'holding the shutter and pan steadily across the shelf.',
  },
};

/**
 * The recoverable stitch-error codes this module has built-in copy for.
 * A host wiring i18n iterates these to know exactly which codes need a
 * translation (every other `CameraErrorCode` maps to `null` and uses the
 * host's generic error UI).
 */
export const RECOVERABLE_STITCH_CODES = Object.keys(
  RECOVERABLE_STITCH_GUIDANCE,
) as CameraErrorCode[];

/**
 * Maps a `CameraErrorCode` to friendly, action-guiding alert copy.
 *
 * Localisation: pass `overrides` (a partial code→copy map, typically from
 * your i18n catalogue) and any code present there wins over the built-in
 * English; codes you omit fall back to the bundled copy.  This is the
 * host-side mirror of the `guidanceCopy` prop — the recoverable-error alert
 * is rendered by the HOST (in its `onError` handler), so it is localised
 * here rather than through `<Camera>`.
 *
 * @returns the title+message for a recoverable stitch failure, or `null`
 *   if `code` has no single user-recoverable action (the host should
 *   then show its generic error UI).
 */
export function userFacingStitchError(
  code: CameraErrorCode,
  overrides?: UserFacingStitchErrorOverrides,
): UserFacingStitchError | null {
  return overrides?.[code] ?? RECOVERABLE_STITCH_GUIDANCE[code] ?? null;
}
