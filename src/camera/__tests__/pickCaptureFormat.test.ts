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

describe('pickCaptureFormat — preferHighFps (smooth-preview opt-in)', () => {
  it('default (off) keeps the sharper 30 fps format — the jitter source', () => {
    const chosen = pickCaptureFormat(ULTRA_WIDE, { maxPhotoLongEdge: 4032 });
    expect(chosen!.videoWidth).toBe(3264); // 8 MP video …
    expect(chosen!.maxFps).toBe(30); // … but only 30 fps
  });

  it('on → picks a 60 fps format over the sharper 30 fps one (same cap)', () => {
    const chosen = pickCaptureFormat(ULTRA_WIDE, {
      maxPhotoLongEdge: 4032,
      preferHighFps: true,
    });
    expect(chosen!.maxFps).toBe(60); // smooth wins
    expect(chosen!.photoWidth).toBe(4032); // still within the photo cap
    expect(chosen!.videoWidth).toBe(1920); // highest-res 60 fps format
    expect(chosen!.supportsVideoHdr).toBe(false); // non-HDR breaks the final tie
  });

  it('treats ≥target fps as equally smooth → resolution breaks the tie', () => {
    // 120 fps low-res vs 60 fps high-res: with the default target (60) both are
    // "smooth", so the higher-resolution 60 fps format wins (no 120 fps chase).
    const formats: FormatLike[] = [
      f(2016, 1512, 640, 480, 120),
      f(2016, 1512, 1920, 1440, 60),
    ];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 2048,
      preferHighFps: true,
    });
    expect(chosen!.videoWidth).toBe(1920);
    expect(chosen!.maxFps).toBe(60);
  });

  it('honours a raised fpsTarget (prefers 120 fps when explicitly asked)', () => {
    const formats: FormatLike[] = [
      f(2016, 1512, 640, 480, 120),
      f(2016, 1512, 1920, 1440, 60),
    ];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 2048,
      preferHighFps: true,
      fpsTarget: 120,
    });
    expect(chosen!.maxFps).toBe(120);
  });
});

describe('preferDepthCapture (captureDepthData format bias)', () => {
  const withDepth = (fmt: FormatLike, supportsDepthCapture: boolean): FormatLike => ({
    ...fmt,
    supportsDepthCapture,
  });

  it('off → depth support is ignored (back-compat)', () => {
    const formats = [
      withDepth(f(4032, 3024, 3264, 2448, 30), false),
      withDepth(f(4032, 3024, 1920, 1440, 30), true),
    ];
    const chosen = pickCaptureFormat(formats, { maxPhotoLongEdge: 4032 });
    expect(chosen!.videoWidth).toBe(3264); // sharpest video wins as before
  });

  it('on → restricts to depth-capable formats when any exist', () => {
    const formats = [
      withDepth(f(4032, 3024, 3264, 2448, 30), false), // sharper video, no depth
      withDepth(f(4032, 3024, 1920, 1440, 30), true),
    ];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 4032,
      preferDepthCapture: true,
    });
    expect(chosen!.supportsDepthCapture).toBe(true);
    expect(chosen!.videoWidth).toBe(1920);
  });

  it('on + no depth format on the device → falls back unchanged (no capture break)', () => {
    const formats = [
      withDepth(f(4032, 3024, 3264, 2448, 30), false),
      f(4032, 3024, 1920, 1440, 60), // field absent entirely (Android shape)
    ];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 4032,
      preferDepthCapture: true,
    });
    expect(chosen!.videoWidth).toBe(3264); // same pick as with the flag off
  });

  it('on → aspect still outranks depth (WYSIWYG 4:3 first)', () => {
    const formats = [
      // 16:9 depth-capable vs 4:3 depth-less: 4:3 wins, depth is dropped.
      withDepth(f(4032, 2268, 3840, 2160, 30), true),
      withDepth(f(4032, 3024, 3264, 2448, 30), false),
    ];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 4032,
      preferDepthCapture: true,
    });
    expect(chosen!.photoHeight).toBe(3024);
    expect(chosen!.supportsDepthCapture).toBe(false);
  });

  it('on → the photo cap fallback keeps the depth restriction', () => {
    const formats = [
      withDepth(f(8064, 6048, 4032, 3024, 30), true), // depth but over cap
      withDepth(f(4032, 3024, 3264, 2448, 30), false), // under cap, no depth
    ];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 4032,
      preferDepthCapture: true,
    });
    // No depth format fits the cap → cap falls back WITHIN the depth set
    // (depth capture is the caller's explicit intent; the cap is a memory
    // guard with an existing "never returns nothing" fallback).
    expect(chosen!.supportsDepthCapture).toBe(true);
    expect(chosen!.photoWidth).toBe(8064);
  });
});
