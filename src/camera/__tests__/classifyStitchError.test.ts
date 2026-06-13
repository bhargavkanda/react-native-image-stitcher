// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `classifyStitchError` — the load-bearing C++↔JS contract
 * that turns a raw native stitch-failure string into a typed
 * `CameraErrorCode` (which then drives the friendly copy in
 * `userFacingStitchError`).
 *
 * The strings below are the ACTUAL shapes the native side emits (see
 * cpp/stitcher.cpp `degenerateFrameException` / `degenerateCanvasException`,
 * the JNI/promise wrapping, and cv::Stitcher's own diagnostics).  If a cpp
 * throw is reworded such that one of these no longer matches its branch,
 * this file fails — which is the point: the "Please pan more slowly" path
 * must not silently regress.
 *
 * Pure-TS: classifyStitchError only type-imports CameraErrorCode from
 * Camera.tsx (erased at runtime), so no native-dep mocking is needed.
 */
import { classifyStitchError } from '../classifyStitchError';

describe('classifyStitchError', () => {
  describe('degenerate camera params → STITCH_CAMERA_PARAMS_FAIL (the rapid-pan path)', () => {
    it('classifies the per-frame warp-guard throw', () => {
      // cpp degenerateFrameException, wrapped by the JNI RuntimeException.
      const msg =
        'Stitch failed: Warp stage failed: warpRoi too large (9581x12332) — ' +
        'estimator produced degenerate camera params on this frame ' +
        '(stitchMode=panorama, frameIdx=12) (code=12)';
      expect(classifyStitchError(msg)).toBe('STITCH_CAMERA_PARAMS_FAIL');
    });

    it('classifies the NEW cumulative-canvas guard throw', () => {
      // cpp degenerateCanvasException → top-level catch → "OpenCV exception
      // during stitch: ...".  This is the message that only exists once the
      // canvas guard converts the OOM into a clean throw.
      const msg =
        'OpenCV exception during stitch: panorama canvas too large ' +
        '(53000x41000) — estimator produced degenerate camera params across ' +
        'the frame set (stitchMode=panorama, frames=7)';
      expect(classifyStitchError(msg)).toBe('STITCH_CAMERA_PARAMS_FAIL');
    });

    it('still matches on the broadened "warpRoi" / "degenerate" substrings alone', () => {
      expect(classifyStitchError('warpRoi too large (60000x60000)')).toBe(
        'STITCH_CAMERA_PARAMS_FAIL',
      );
      expect(classifyStitchError('canvas too large (200000x200000)')).toBe(
        'STITCH_CAMERA_PARAMS_FAIL',
      );
    });
  });

  describe('insufficient overlap → STITCH_NEED_MORE_IMGS', () => {
    it('classifies cv::Stitcher ERR_NEED_MORE_IMGS', () => {
      expect(classifyStitchError('Stitch failed: need more images')).toBe(
        'STITCH_NEED_MORE_IMGS',
      );
    });
    it('classifies the manual pipeline no-overlap message', () => {
      expect(
        classifyStitchError('0 valid pairwise matches; frames may not overlap enough'),
      ).toBe('STITCH_NEED_MORE_IMGS');
    });
  });

  it('classifies homography failures → STITCH_HOMOGRAPHY_FAIL', () => {
    expect(classifyStitchError('homography estimation failed')).toBe(
      'STITCH_HOMOGRAPHY_FAIL',
    );
  });

  it('classifies OOM strings → STITCH_OOM', () => {
    expect(classifyStitchError('terminating with uncaught exception: out of memory')).toBe(
      'STITCH_OOM',
    );
    expect(classifyStitchError('cv::OutOfMemoryError / OOM')).toBe('STITCH_OOM');
  });

  it('falls back to PANORAMA_FINALIZE_FAILED for anything unclassified', () => {
    expect(classifyStitchError('ENOSPC: no space left on device')).toBe(
      'PANORAMA_FINALIZE_FAILED',
    );
    expect(classifyStitchError('')).toBe('PANORAMA_FINALIZE_FAILED');
  });

  describe('branch ordering (first match wins)', () => {
    it('prefers need-more-images over a co-occurring camera-params token', () => {
      // Insufficient overlap is the more specific/actionable diagnosis.
      expect(
        classifyStitchError('need more images — degenerate camera params downstream'),
      ).toBe('STITCH_NEED_MORE_IMGS');
    });
    it('prefers homography over a co-occurring camera-params token', () => {
      expect(classifyStitchError('homography failed; camera params degenerate')).toBe(
        'STITCH_HOMOGRAPHY_FAIL',
      );
    });
    it('routes a real OOM to STITCH_OOM, not camera-params', () => {
      // No degenerate-warp substring present → must NOT be camera-params.
      expect(classifyStitchError('Stitcher aborted: out of memory during blend')).toBe(
        'STITCH_OOM',
      );
    });
  });
});
