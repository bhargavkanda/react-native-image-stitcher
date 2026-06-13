// SPDX-License-Identifier: Apache-2.0
/**
 * classifyStitchError — map a raw native stitch-failure message to a
 * `CameraErrorCode`.
 *
 * This is the load-bearing C++↔JS contract: the native pipeline reports
 * failures only as exception strings (see cpp/stitcher.cpp — the warp /
 * cumulative-canvas guards throw "warpRoi too large … degenerate camera
 * params", cv::Stitcher reports "need more images", etc.), and this
 * function is the single place that turns those strings into the typed
 * codes `<Camera onError>` surfaces.  The code then drives the friendly
 * copy in {@link userFacingStitchError} (cameraErrorMessages.ts) — e.g.
 * STITCH_CAMERA_PARAMS_FAIL → "Please pan more slowly".
 *
 * Extracted from the inline chain in Camera.tsx so the contract is
 * unit-testable against the actual native strings (the lib's jest config
 * is pure-TS and can't mount <Camera>).
 *
 * Ordering matters — the branches are checked top-to-bottom and the first
 * match wins:
 *   1. need-more-images (insufficient overlap) — most specific.
 *   2. homography estimation.
 *   3. degenerate camera params / warp-canvas guard (the divergent-warp
 *      OOM path, now converted to a clean throw by the canvas guard).
 *   4. out-of-memory.
 *   5. fallback — an unclassified finalize failure.
 */
import type { CameraErrorCode } from './Camera';

export function classifyStitchError(message: string): CameraErrorCode {
  // Insufficient overlap surfaces two ways: cv::Stitcher's
  // ERR_NEED_MORE_IMGS ("need more images") and the manual pipeline's
  // "0 valid pairwise matches / frames may not overlap enough" — both are
  // the same recoverable "pan more slowly" case.
  if (/need more images|pairwise match|overlap enough/i.test(message)) {
    return 'STITCH_NEED_MORE_IMGS';
  }
  if (/homography/i.test(message)) {
    return 'STITCH_HOMOGRAPHY_FAIL';
  }
  // Degenerate camera params — the rapid/wide-pan divergent-warp path.
  // Broadened beyond the original "camera params" so a future reword of
  // the native throw can't silently drop the "pan more slowly" copy: the
  // per-frame warp guard and the cumulative-canvas guard carry "warpRoi"
  // / "canvas too large" / "degenerate" respectively (see cpp/stitcher.cpp
  // degenerateFrameException / degenerateCanvasException).  Kept AFTER the
  // homography branch and BEFORE the OOM branch so a true OOM string still
  // routes to STITCH_OOM.
  if (/camera params|warpRoi|degenerate|canvas too large/i.test(message)) {
    return 'STITCH_CAMERA_PARAMS_FAIL';
  }
  if (/out of memory|oom/i.test(message)) {
    return 'STITCH_OOM';
  }
  return 'PANORAMA_FINALIZE_FAILED';
}
