// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `pickCaptureFormat`.  The fixture is the REAL iPhone 16 Pro
 * ultra-wide 4:3 format list (captured on-device), so these assert the exact
 * behaviour we're shipping: bound the photo while keeping the video sharp.
 *
 * Pure-TS (structural FormatLike, no vision-camera import).
 */
import {
  exposureCapToFps,
  pickCaptureFormat,
  pickCaptureFormatDetailed,
  type FormatLike,
} from '../pickCaptureFormat';

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

describe('exposureCapToFps (anti-blur exposure cap → session fps)', () => {
  it('is DISABLED (0) for the default and all non-positive/degenerate inputs', () => {
    // The whole feature is off by default; disabled must be an unambiguous 0
    // so the caller floors it against 60 and leaves today's behaviour intact.
    expect(exposureCapToFps(0)).toBe(0);
    expect(exposureCapToFps(-5)).toBe(0);
    expect(exposureCapToFps(NaN)).toBe(0);
    expect(exposureCapToFps(Infinity)).toBe(0);
  });

  it('maps a millisecond ceiling to the fps that enforces it (fps = 1000/ms)', () => {
    expect(exposureCapToFps(8)).toBe(125);   // 1/125 s  (shelf default)
    expect(exposureCapToFps(20)).toBe(50);   // 1/50 s
    expect(exposureCapToFps(10)).toBe(100);  // 1/100 s
  });

  it('rounds UP so the exposure never exceeds the requested ceiling', () => {
    // 1000/16.6 = 60.2 → 61: a fractional requirement must round toward a
    // SHORTER exposure, not a longer one, or the cap could be silently missed.
    expect(exposureCapToFps(16.6)).toBe(61);
  });

  it('clamps to 240 so a sub-ms misconfig cannot demand an absurd rate', () => {
    expect(exposureCapToFps(0.1)).toBe(240); // 10000 unclamped
    expect(exposureCapToFps(2)).toBe(240);   // 500 unclamped → clamped
    expect(exposureCapToFps(4)).toBe(240);   // 250 unclamped → clamped
  });
});

describe('exposure cap picks a fast format AND the caller floors the ceiling', () => {
  it('an 8 ms cap steers the picker to 120 fps when a 120 fps format exists', () => {
    // Models CameraView passing fpsTarget = max(60, exposureCapToFps(8)) = 125.
    const formats: FormatLike[] = [
      f(2016, 1512, 640, 480, 120),
      f(2016, 1512, 1920, 1440, 60),
    ];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 2048,
      preferHighFps: true,
      fpsTarget: Math.max(60, exposureCapToFps(8)),
    });
    expect(chosen!.maxFps).toBe(120);
  });

  it('degrades gracefully when no format reaches the requested rate', () => {
    // Device tops out at 60 fps: the picker returns the 60 fps format, and the
    // caller's min(maxFps, ceiling) yields 60 — a shortened-but-not-8ms
    // exposure, never slower than today.
    const formats: FormatLike[] = [f(2016, 1512, 1920, 1440, 60)];
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 2048,
      preferHighFps: true,
      fpsTarget: Math.max(60, exposureCapToFps(8)),
    });
    expect(chosen!.maxFps).toBe(60);
    const sessionFps = Math.min(chosen!.maxFps, Math.max(60, exposureCapToFps(8)));
    expect(sessionFps).toBe(60);
  });

  it('default (cap off) leaves the session ceiling at 60 — byte-identical', () => {
    const formats: FormatLike[] = [
      f(2016, 1512, 640, 480, 120),
      f(2016, 1512, 1920, 1440, 60),
    ];
    // fpsTarget = max(60, 0) = 60 → the 120 fps format is NOT preferred over
    // the higher-resolution 60 fps one (today's behaviour).
    const chosen = pickCaptureFormat(formats, {
      maxPhotoLongEdge: 2048,
      preferHighFps: true,
      fpsTarget: Math.max(60, exposureCapToFps(0)),
    });
    expect(chosen!.maxFps).toBe(60);
    const sessionFps = Math.min(chosen!.maxFps, Math.max(60, exposureCapToFps(0)));
    expect(sessionFps).toBe(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE ANDROID FIXTURE, AND WHY IT LOOKS LIKE THIS
//
// Measured on a Galaxy A35 (SM-A356U1) on 2026-09-21, not invented.
//
// vision-camera builds an Android device's format list as the CROSS PRODUCT
// of the JPEG photo sizes with `qualities.flatMap { it.typicalSizes }` over
// CameraX's quality ladder (`CameraDeviceDetails.kt:123`).  Those typical
// sizes are hard-coded in `androidx.camera.video.Quality` — read out of the
// camera-video AAR's bytecode:
//
//     SD  = [720x480, 640x480]     HD  = [1280x720]
//     FHD = [1920x1080]            UHD = [3840x2160]
//
// 720x480 is 1.5 and fails the 0.05 tolerance, so **640x480 is the only
// video size on the whole ladder that can ever satisfy a 4:3 match** — on
// every Android device, not just this one.  The phone's own hardware list
// advertises 4:3 YUV at 1920x1440 and 1440x1080 (its Camera2 arm uses them
// and gets 1440x1080); vision-camera never offers them.
//
// Every rung on this device is 30 fps, and 640x480 has no CamcorderProfile
// at all so it inherits the device max — also 30.  So `preferHighFps` is a
// dead tie here and the size term decides everything.  That is exactly why
// the sweep policy must take the SMALLEST format above the floor: with the
// default largest-wins sort it would ask for 3840x2160.
const A35_PHOTO: Array<[number, number]> = [
  [4080, 3060], [4080, 2296], [3056, 3056], [3840, 2160], [4080, 1884],
  [2560, 1440], [1920, 1440], [2336, 1080], [1920, 1080], [1920, 886],
  [1440, 1080], [1088, 1088], [1280, 720], [960, 720], [720, 480],
  [640, 480], [640, 360], [352, 288], [320, 240], [256, 144], [176, 144],
];
const A35_VIDEO: Array<[number, number]> = [
  [720, 480], [640, 480], [1280, 720], [1920, 1080], [3840, 2160],
];
const A35: FormatLike[] = A35_VIDEO.flatMap(([vw, vh]) =>
  A35_PHOTO.map(([pw, ph]) => f(pw, ph, vw, vh, 30)),
);

/** What `CameraView` sends for a non-sweep consumer. */
const SHARED = {
  maxPhotoLongEdge: 4032,
  aspect: 4 / 3,
  preferHighFps: true,
  fpsTarget: 60,
} as const;

describe('minVideoLongEdge on Android — the floor that was inert', () => {
  // CHARACTERIZATION (passes before AND after). The shared picker's default
  // path must not move: this is the executable proof, stronger than an
  // argument about option defaults.
  it('CHARACTERIZATION: default policy still picks 640x480 with no floor', () => {
    const r = pickCaptureFormatDetailed(A35, { ...SHARED, minVideoLongEdge: 0 });
    expect(r.format!.videoWidth).toBe(640);
    expect(r.format!.videoHeight).toBe(480);
    expect(r.policy).toBe('aspect-first');
  });

  // THE DEFECT ITSELF, pinned. Asking for the floor changes NOTHING under
  // the default policy, because the aspect filter already collapsed the set
  // to the single 4:3 entry CameraX publishes.
  it('CHARACTERIZATION: a 1280 floor is INERT under the default policy', () => {
    const r = pickCaptureFormatDetailed(A35, { ...SHARED, minVideoLongEdge: 1280 });
    expect(r.format!.videoWidth).toBe(640);
    expect(r.floorRequested).toBe(1280);
    expect(r.floorCleared).toBe(false); // <- the whole bug, in one field
  });

  // FAILS BEFORE: there was no floor-first policy, and the pick was 640x480.
  it('FAILS BEFORE: floor-first lifts the A35 sweep stream to 1280x720', () => {
    const r = pickCaptureFormatDetailed(A35, {
      ...SHARED,
      minVideoLongEdge: 1280,
      videoFloorOutranksAspect: true,
    });
    expect(r.format!.videoWidth).toBe(1280);
    expect(r.format!.videoHeight).toBe(720);
    expect(r.floorCleared).toBe(true);
    expect(r.policy).toBe('floor-first');
    expect(r.videoAspectMatched).toBe(false); // honestly reported: 16:9
  });

  // GUARD (passes before, against a plausible WRONG fix). Simply deleting the
  // aspect stage would leave largest-video-wins and ask for 4K — 27x the
  // pixels per frame on a phone already near its per-frame budget.
  it('GUARD: floor-first takes the SMALLEST clearing format, never 3840x2160', () => {
    const r = pickCaptureFormatDetailed(A35, {
      ...SHARED,
      minVideoLongEdge: 1280,
      videoFloorOutranksAspect: true,
    });
    expect(r.format!.videoWidth).not.toBe(3840);
    expect(r.format!.videoWidth * r.format!.videoHeight)
      .toBeLessThan(1920 * 1080);
  });

  it('the floor is the knob: raising it to 1920 asks for 1920x1080', () => {
    const r = pickCaptureFormatDetailed(A35, {
      ...SHARED,
      minVideoLongEdge: 1920,
      videoFloorOutranksAspect: true,
    });
    expect(r.format!.videoWidth).toBe(1920);
    expect(r.format!.videoHeight).toBe(1080);
  });

  // G2: the still must not silently change shape. `CameraHandle.takePhoto()`
  // is NOT engine-gated, so a host can fire a still through this session.
  it('keeps the STILL at 4:3 even when the video goes 16:9', () => {
    const r = pickCaptureFormatDetailed(A35, {
      ...SHARED,
      minVideoLongEdge: 1280,
      videoFloorOutranksAspect: true,
    });
    expect(r.format!.photoWidth / r.format!.photoHeight).toBeCloseTo(4 / 3, 2);
  });

  it('degrades instead of failing when NOTHING clears the floor', () => {
    const r = pickCaptureFormatDetailed(A35, {
      ...SHARED,
      minVideoLongEdge: 9999,
      videoFloorOutranksAspect: true,
    });
    expect(r.format).toBeDefined();
    expect(r.format!.videoWidth).toBe(640); // the unfloored answer
    expect(r.floorCleared).toBe(false);
  });

  // GUARD (passes before; the default path agrees on this fixture). The rule
  // must be "4:3 WITHIN the floored set", not "16:9 always" — a device that
  // does have a big 4:3 format must still get it. A smallest-wins sort with
  // the aspect stage simply DELETED would take the 1280x720 here.
  it('GUARD: prefers 4:3 INSIDE the floored set over a smaller 16:9', () => {
    const formats = [
      f(4032, 3024, 1600, 1200, 30), // 4:3, larger
      f(4032, 2268, 1280, 720, 30), // 16:9, smaller
    ];
    const r = pickCaptureFormatDetailed(formats, {
      ...SHARED,
      minVideoLongEdge: 1280,
      videoFloorOutranksAspect: true,
    });
    expect(r.format!.videoWidth).toBe(1600);
    expect(r.videoAspectMatched).toBe(true);
  });

  // GUARD (passes before; the default sort also ranks fps first). A sweep is
  // a moving capture and frame rate is the motion-blur defence — the iOS
  // sibling refuses to START rather than trade it — so the smallest-wins
  // term must never be allowed above fps. Inert on the A35 (every rung is
  // 30 fps) and load-bearing on any device that is not the A35.
  it('GUARD: ranks FPS above size — a 60 fps format beats a bigger 30 fps one', () => {
    const formats = [
      f(4032, 3024, 1920, 1080, 30),
      f(4032, 3024, 1280, 720, 60),
    ];
    const r = pickCaptureFormatDetailed(formats, {
      ...SHARED,
      minVideoLongEdge: 1280,
      videoFloorOutranksAspect: true,
    });
    expect(r.format!.maxFps).toBe(60);
    expect(r.format!.videoWidth).toBe(1280);
  });

  it('the new option is inert without a floor (both halves required)', () => {
    const withPolicy = pickCaptureFormat(A35, {
      ...SHARED,
      minVideoLongEdge: 0,
      videoFloorOutranksAspect: true,
    });
    expect(withPolicy!.videoWidth).toBe(640);
  });

  it('pickCaptureFormat stays a thin wrapper over the detailed form', () => {
    const opts = { ...SHARED, minVideoLongEdge: 1280, videoFloorOutranksAspect: true };
    expect(pickCaptureFormat(A35, opts)).toBe(pickCaptureFormatDetailed(A35, opts).format);
  });

  it('reports the floor for the DEFAULT path too (the keyframe consumer)', () => {
    // The keyframe/photo path evaporates its floor on the same devices, and
    // that has to be visible to its caller as well.
    const r = pickCaptureFormatDetailed(A35, { ...SHARED, minVideoLongEdge: 1280 });
    expect(r.policy).toBe('aspect-first');
    expect(r.floorRequested).toBe(1280);
    expect(r.floorCleared).toBe(false);
  });

  it('an empty list answers undefined without claiming the floor cleared', () => {
    const r = pickCaptureFormatDetailed([], {
      ...SHARED,
      minVideoLongEdge: 1280,
      videoFloorOutranksAspect: true,
    });
    expect(r.format).toBeUndefined();
    expect(r.floorCleared).toBe(false);
  });
});
