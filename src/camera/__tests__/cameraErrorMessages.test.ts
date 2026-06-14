// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the recoverable-stitch-failure guidance map.
 *
 * Guarantees: (1) every recoverable code yields non-empty, plain-language
 * copy with no raw cv::Stitcher diagnostic leaking through; (2) the
 * cause-specific guidance actually names its corrective action; (3) every
 * non-recoverable code returns null so the host falls back to its generic
 * error UI.
 */
import {
  userFacingStitchError,
  RECOVERABLE_STITCH_CODES,
  RECOVERABLE_STITCH_GUIDANCE,
} from '../cameraErrorMessages';
import type { CameraErrorCode } from '../Camera';

describe('userFacingStitchError', () => {
  const RECOVERABLE: CameraErrorCode[] = [
    'STITCH_NEED_MORE_IMGS',
    'STITCH_HOMOGRAPHY_FAIL',
    'STITCH_CAMERA_PARAMS_FAIL',
    'STITCH_OOM',
  ];

  it.each(RECOVERABLE)(
    'returns non-empty, jargon-free title+message for %s',
    (code) => {
      const r = userFacingStitchError(code);
      expect(r).not.toBeNull();
      expect(r!.title.length).toBeGreaterThan(0);
      expect(r!.message.length).toBeGreaterThan(0);
      // No raw stitcher diagnostics should ever reach the user.
      expect(r!.message).not.toMatch(/warpRoi|cv::|OpenCV|ERR_|StsOutOfRange|estimator/i);
      expect(r!.title).not.toMatch(/cv::|OpenCV|ERR_/i);
      // The title is the corrective ASK (e.g. "Please pan more slowly"),
      // not a generic failure headline.
      expect(r!.title).not.toMatch(/couldn't|can't|error|failed|too large/i);
    },
  );

  it('camera-params guidance names the 0.5x sensitivity and the 1x fix', () => {
    const r = userFacingStitchError('STITCH_CAMERA_PARAMS_FAIL');
    expect(r).not.toBeNull();
    // The actual root cause (translation) + the actionable lens advice.
    expect(r!.message).toMatch(/0\.5x|ultra-wide/i);
    expect(r!.message).toMatch(/\b1x\b/i);
    expect(r!.message).toMatch(/pivot|turning|one spot|moved|shifted/i);
  });

  it('need-more-images guidance is about overlap', () => {
    expect(userFacingStitchError('STITCH_NEED_MORE_IMGS')!.message).toMatch(
      /overlap/i,
    );
  });

  it('oom guidance suggests a shorter sweep', () => {
    expect(userFacingStitchError('STITCH_OOM')!.message).toMatch(
      /shorter|narrower|memory/i,
    );
  });

  const NON_RECOVERABLE: CameraErrorCode[] = [
    'CAMERA_PERMISSION_DENIED',
    'CAMERA_DEVICE_UNAVAILABLE',
    'PHOTO_CAPTURE_FAILED',
    'PANORAMA_START_FAILED',
    'PANORAMA_FINALIZE_FAILED',
    'OUTPUT_WRITE_FAILED',
    'VISION_CAMERA_RUNTIME',
    'UNKNOWN',
  ];

  it.each(NON_RECOVERABLE)(
    'returns null for non-recoverable code %s',
    (code) => {
      expect(userFacingStitchError(code)).toBeNull();
    },
  );

  describe('i18n — overrides + exposed codes', () => {
    it('RECOVERABLE_STITCH_CODES matches the built-in guidance keys', () => {
      expect(RECOVERABLE_STITCH_CODES.sort()).toEqual(
        Object.keys(RECOVERABLE_STITCH_GUIDANCE).sort(),
      );
      // Includes the v0.16 low-quality code so hosts know to translate it.
      expect(RECOVERABLE_STITCH_CODES).toContain('STITCH_LOW_QUALITY');
    });

    it('a matching override wins over the built-in English', () => {
      const r = userFacingStitchError('STITCH_OOM', {
        STITCH_OOM: { title: 'Balayage plus court', message: 'Mémoire insuffisante.' },
      });
      expect(r).toEqual({
        title: 'Balayage plus court',
        message: 'Mémoire insuffisante.',
      });
    });

    it('falls back to the built-in copy for codes the override omits', () => {
      const r = userFacingStitchError('STITCH_NEED_MORE_IMGS', {
        STITCH_OOM: { title: 'x', message: 'y' },
      });
      expect(r).toEqual(RECOVERABLE_STITCH_GUIDANCE.STITCH_NEED_MORE_IMGS);
    });

    it('still returns null for a non-recoverable code even with overrides', () => {
      expect(
        userFacingStitchError('UNKNOWN', {
          STITCH_OOM: { title: 'x', message: 'y' },
        }),
      ).toBeNull();
    });
  });
});
