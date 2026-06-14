// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `pickCaptureFormat`.  The fixture is the REAL iPhone 16 Pro
 * ultra-wide 4:3 format list (captured on-device), so these assert the exact
 * behaviour we're shipping: bound the photo while keeping the video sharp.
 *
 * Pure-TS (structural FormatLike, no vision-camera import).
 */
import { pickCaptureFormat, type FormatLike } from '../pickCaptureFormat';

const f = (
  photoWidth: number,
  photoHeight: number,
  videoWidth: number,
  videoHeight: number,
  maxFps: number,
  supportsVideoHdr = false,
): FormatLike => ({
  photoWidth,
  photoHeight,
  videoWidth,
  videoHeight,
  maxFps,
  supportsVideoHdr,
});

// Real iPhone 16 Pro ultra-wide 4:3 formats (deduped).
const ULTRA_WIDE: FormatLike[] = [
  f(8064, 6048, 4032, 3024, 30), // 48 MP photo @ MAX video — the culprit
  f(4032, 3024, 3264, 2448, 30), // 12 MP photo @ 8 MP video
  f(4032, 3024, 2592, 1944, 30),
  f(4032, 3024, 1920, 1440, 30),
  f(4032, 3024, 1920, 1440, 60),
  f(4032, 3024, 1920, 1440, 60, true), // hdr variant
  f(2016, 1512, 1920, 1440, 60), // 3 MP photo
  f(2016, 1512, 1440, 1080, 60),
  f(4032, 3024, 1024, 768, 60),
  f(4032, 3024, 640, 480, 60),
  f(2016, 1512, 640, 480, 60),
  f(4032, 3024, 480, 360, 60),
  f(4032, 3024, 192, 144, 60),
];

describe('pickCaptureFormat (iPhone 16 Pro ultra-wide fixture)', () => {
  it('4K cap (4032) → 12 MP photo + sharpest video under cap (3264×2448)', () => {
    const chosen = pickCaptureFormat(ULTRA_WIDE, { maxPhotoLongEdge: 4032 });
    expect(chosen).toBeDefined();
    expect(chosen!.photoWidth).toBe(4032);
    expect(chosen!.photoHeight).toBe(3024);
    expect(chosen!.videoWidth).toBe(3264); // NOT 4032 (which carries 48 MP)
    expect(chosen!.videoHeight).toBe(2448);
  });

  it('2K cap (2048) → 3 MP photo + sharpest video under cap (1920×1440)', () => {
    const chosen = pickCaptureFormat(ULTRA_WIDE, { maxPhotoLongEdge: 2048 });
    expect(chosen!.photoWidth).toBe(2016);
    expect(chosen!.photoHeight).toBe(1512);
    expect(chosen!.videoWidth).toBe(1920);
    expect(chosen!.videoHeight).toBe(1440);
  });

  it('cap 0 (disabled) → max-video format (the old behaviour = 48 MP photo)', () => {
    const chosen = pickCaptureFormat(ULTRA_WIDE, { maxPhotoLongEdge: 0 });
    expect(chosen!.photoWidth).toBe(8064);
    expect(chosen!.videoWidth).toBe(4032);
  });

  it('prefers the non-HDR format on a video-res + fps + photo tie', () => {
    // Cap excludes 4032-photo formats, leaving the 1920×1440@60 trio with
    // equal video + fps + photo; the non-HDR one wins (8-bit hedge).
    const tie: FormatLike[] = [
      f(2016, 1512, 1920, 1440, 60, true),
      f(2016, 1512, 1920, 1440, 60, false),
    ];
    const chosen = pickCaptureFormat(tie, { maxPhotoLongEdge: 2048 });
    expect(chosen!.supportsVideoHdr).toBe(false);
  });

  it('falls back to max-video when NO format fits the cap', () => {
    // Absurdly small cap — nothing qualifies, so don't return nothing; pick
    // the overall max-video format instead.
    const chosen = pickCaptureFormat(ULTRA_WIDE, { maxPhotoLongEdge: 100 });
    expect(chosen!.videoWidth).toBe(4032); // max video
  });

  it('returns undefined for an empty format list', () => {
    expect(pickCaptureFormat([], { maxPhotoLongEdge: 4032 })).toBeUndefined();
  });
});
