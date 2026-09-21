// SPDX-License-Identifier: Apache-2.0
/**
 * pickCaptureFormat — choose the vision-camera format for the capture stream.
 *
 * Replaces a plain `useCameraFormat([{ videoResolution: 'max' }, …])`, which
 * picks the device's MAX-video format and lets the PHOTO resolution ride
 * along — on the iPhone 16 Pro ultra-wide that pairs a **48 MP** still
 * (8064×6048) with the 4032×3024 max-video format, so a tap photo came out
 * ~6000 px.  vision-camera 4.x exposes each format's photo/video resolution
 * but NOT its pixel format / bit-depth, so we can't filter for 8-bit; the
 * empirical rule is that the device's MAX 4:3 video format is 8-bit (the
 * frame processor needs 8-bit for non-AR stitching), and lower video
 * resolutions risk 10-bit.
 *
 * Strategy: among the ~4:3 formats whose photo long-edge is within
 * `maxPhotoLongEdge`, pick the one with the HIGHEST video resolution (keeps
 * the preview/stitch stream as sharp as possible while bounding the still),
 * tie-breaking on higher fps, then the largest photo under the cap, then
 * non-HDR (a hedge toward 8-bit).  If NO format fits the cap, fall back to
 * the overall max-video format (never returns nothing for a non-empty list).
 *
 * Verified against the real iPhone 16 Pro ultra-wide format list (see the
 * unit test): cap 4032 → 4032×3024 photo (12 MP) + 3264×2448 video (was
 * 8064×6048 photo); cap 2048 → 2016×1512 photo (3 MP) + 1920×1440 video.
 *
 * Pure + structurally-typed (no vision-camera import) so it unit-tests in the
 * node jest env; `CameraDeviceFormat` is structurally assignable to
 * `FormatLike`.
 */

/** The CameraDeviceFormat fields this picker reads. */
export interface FormatLike {
  photoWidth: number;
  photoHeight: number;
  videoWidth: number;
  videoHeight: number;
  maxFps: number;
  supportsVideoHdr: boolean;
  /**
   * iOS: whether AVFoundation can deliver an AVDepthData alongside stills
   * on this format (`!supportedDepthDataFormats.isEmpty`).  Optional so
   * plain fixtures / Android formats (always depth-less) stay assignable.
   */
  supportsDepthCapture?: boolean;
}

export interface PickFormatOptions {
  /**
   * Cap on the chosen format's photo LONG edge, in px.  The picker prefers
   * the sharpest-video format whose photo fits this.  `0` disables the cap
   * (reverts to pure max-video).  Default 4032 (≈12 MP at 4:3, "4K"-ish).
   */
  maxPhotoLongEdge?: number;
  /** Target capture aspect (W/H in landscape). Default 4/3. */
  aspect?: number;
  /** Aspect match tolerance. Default 0.05. */
  aspectTolerance?: number;
  /**
   * Prefer a SMOOTH (high-fps) preview over the sharpest video format.  Off by
   * default → max-video-resolution-first (back-compat).  On (the panorama
   * camera opts in) → rank by frame rate up to `fpsTarget` first, THEN video
   * resolution.  The default video-first sort picks e.g. a 3264×2448 **@30 fps**
   * format over a 1920×1440 **@60 fps** one, halving the preview frame rate —
   * visible as jitter while panning.  The stitch clamps keyframes to 640/1280 px
   * anyway, so the higher video resolution buys nothing for the panorama; a
   * 60 fps stream just looks smooth.
   */
  preferHighFps?: boolean;
  /**
   * Ceiling for the fps preference when `preferHighFps` is on.  Formats at or
   * above this are treated as equally smooth (so resolution breaks the tie
   * instead of chasing 120 fps at a lower resolution).  Default 60.
   */
  fpsTarget?: number;
  /**
   * Restrict to formats with `supportsDepthCapture` when any exist (the
   * `captureDepthData` path — depth delivery silently produces nothing on a
   * depth-less format).  Falls back to the full set when the device offers
   * no depth format at all, so opting in never breaks capture on
   * single-lens hardware.  Applied AFTER the aspect filter (WYSIWYG 4:3
   * still wins) and BEFORE the photo cap.  Default off.
   */
  preferDepthCapture?: boolean;
  /**
   * VIDEO long-edge floor (`keyframeQualityCapture`): restrict to formats
   * whose video long edge is at least this, when any exist — the non-AR
   * panorama keyframes come from the VIDEO stream, and on devices whose
   * fps-preferred pick lands 640×480 the pano is assembled from 0.3 MP
   * tiles.  The fps preference still ranks WITHIN the floored set (a
   * 1920×1080@60 beats a 1920×1440@30 where both exist).  Falls back to
   * the unfloored set when nothing qualifies, so opting in never breaks
   * capture.  Applied after the aspect/depth filters, before the photo
   * cap.  Default off (0).
   */
  minVideoLongEdge?: number;
  /**
   * SWEEP INGEST POLICY (`<Camera engine="sweep">`'s host preview).  Off by
   * default; every other consumer keeps the aspect-first rule above.
   *
   * ⚠ WHY THIS EXISTS, MEASURED.  The `minVideoLongEdge` floor is applied
   * AFTER the aspect filter and is SOFT, and on Android that makes it inert
   * on every device, not just one.  vision-camera enumerates Android video
   * sizes as `qualities.flatMap { it.typicalSizes }` over CameraX's quality
   * ladder (`CameraDeviceDetails.kt:123`), and `androidx.camera.video.Quality`
   * hard-codes those lists:
   *
   *     SD  = [720x480 (3:2), 640x480 (4:3)]      <- two entries
   *     HD  = [1280x720]   FHD = [1920x1080]   UHD = [3840x2160]   (16:9)
   *
   * so `640x480` is the ONLY enumerated video size that can ever satisfy a
   * 4:3 `matchesAspect`.  The hard aspect filter collapses `base` to it, the
   * floor then finds nothing at/above 1280 within that set, and the soft
   * fallback silently un-floors.  Measured on a Galaxy A35: the sweep's
   * vision-camera arm was fed 640x480 and produced ~500x300 panoramas, while
   * the SAME phone's Camera2 arm — which enumerates the real hardware list,
   * including 4:3 at 1920x1440 and 1440x1080 — got 1440x1080.
   *
   * On this path the VIDEO stream IS the stitch source, so:
   *
   *  1. the floor is applied FIRST and outranks aspect;
   *  2. 4:3 is still preferred, but only WITHIN the floored set (so a device
   *     that does have a big 4:3 format still gets it — this must not become
   *     "16:9 always");
   *  3. aspect is matched on the VIDEO dims alone, because the video is what
   *     is ingested; the photo aspect is demoted to a tie-break;
   *  4. the sort takes the SMALLEST format clearing the floor, not the
   *     largest.  Without that, fps ties (every CamcorderProfile rung on the
   *     A35 is 30) and the existing `videoPixels` DESC sort asks for
   *     3840x2160 — 27x the pixels per frame, on a phone already near its
   *     per-frame budget.  The floor is the knob; raise it to ask for more.
   *
   * Still SOFT at every stage: a device with nothing above the floor, or no
   * 4:3 above it, degrades instead of failing.  Read `floorCleared` from
   * {@link pickCaptureFormatDetailed} to find out which happened.
   */
  videoFloorOutranksAspect?: boolean;
}

const DEFAULT_MAX_PHOTO_LONG_EDGE = 4032;
const DEFAULT_FPS_TARGET = 60;

/**
 * Anti-blur exposure cap → the session fps that enforces it.
 *
 * Exposure is physically bounded by the frame interval (auto-exposure
 * can never expose longer than one frame), and vision-camera maps its
 * `fps` prop to `activeVideoMaxFrameDuration = 1/fps`.  So capping
 * exposure at `maxExposureMs` means running at ≥ 1000/maxExposureMs fps.
 *
 * @returns the required fps, or 0 when the cap is disabled
 *          (`maxExposureMs <= 0` / non-finite).  Clamped to 240 so a
 *          mis-set sub-millisecond value can't demand an absurd rate; no
 *          phone exceeds ~240 fps at capture resolutions, and the caller
 *          floors this against 60 and against the device's real max
 *          anyway, so an unreachable cap degrades gracefully.
 */
export function exposureCapToFps(maxExposureMs: number): number {
  if (!Number.isFinite(maxExposureMs) || maxExposureMs <= 0) return 0;
  return Math.min(240, Math.ceil(1000 / maxExposureMs));
}

const longEdge = (f: FormatLike): number =>
  Math.max(f.photoWidth, f.photoHeight);
const videoPixels = (f: FormatLike): number => f.videoWidth * f.videoHeight;

/** What {@link pickCaptureFormatDetailed} answers, beyond the format itself. */
export interface PickFormatResult<F extends FormatLike> {
  /** The chosen format, or `undefined` for an empty input list. */
  format: F | undefined;
  /** The video long-edge floor that was ASKED for, in px.  0 when none. */
  floorRequested: number;
  /**
   * Did any candidate actually clear `floorRequested`?
   *
   * ⚠ `floorRequested > 0 && !floorCleared` is the INERT case: the caller
   * asked for a resolution floor and the device answered with nothing above
   * it, so the floor silently did nothing.  That state shipped undetected on
   * every Android device — the option had no test and no runtime signal — so
   * it is reported rather than inferred.  A flag is wired only when an
   * outcome proves it, and this is the outcome.
   */
  floorCleared: boolean;
  /** Does the CHOSEN format's VIDEO stream match the requested aspect? */
  videoAspectMatched: boolean;
  /** Which pipeline ran.  See `videoFloorOutranksAspect`. */
  policy: 'aspect-first' | 'floor-first';
}

/**
 * Pick the best capture format, or `undefined` for an empty list.
 *
 * Thin wrapper over {@link pickCaptureFormatDetailed} — kept so the signature
 * every existing caller and test uses is unchanged.
 */
export function pickCaptureFormat<F extends FormatLike>(
  formats: readonly F[],
  opts: PickFormatOptions = {},
): F | undefined {
  return pickCaptureFormatDetailed(formats, opts).format;
}

/**
 * {@link pickCaptureFormat}, plus what it had to compromise on.
 */
export function pickCaptureFormatDetailed<F extends FormatLike>(
  formats: readonly F[],
  opts: PickFormatOptions = {},
): PickFormatResult<F> {
  const videoFloor = opts.minVideoLongEdge ?? 0;
  const floorFirst = opts.videoFloorOutranksAspect === true && videoFloor > 0;

  if (!formats || formats.length === 0) {
    return {
      format: undefined,
      floorRequested: videoFloor,
      floorCleared: false,
      videoAspectMatched: false,
      policy: floorFirst ? 'floor-first' : 'aspect-first',
    };
  }

  const aspect = opts.aspect ?? 4 / 3;
  const tol = opts.aspectTolerance ?? 0.05;
  const cap = opts.maxPhotoLongEdge ?? DEFAULT_MAX_PHOTO_LONG_EDGE;
  const preferHighFps = opts.preferHighFps ?? false;
  const fpsTarget = opts.fpsTarget ?? DEFAULT_FPS_TARGET;
  // Treat everything at/above the target as equally smooth so resolution, not
  // a chase for 120 fps, breaks the tie.
  const smoothness = (f: FormatLike): number => Math.min(f.maxFps, fpsTarget);

  const videoLongEdge = (f: FormatLike): number =>
    Math.max(f.videoWidth, f.videoHeight);
  const matchesVideoAspect = (f: FormatLike): boolean =>
    f.videoHeight > 0 && Math.abs(f.videoWidth / f.videoHeight - aspect) < tol;
  const matchesAspect = (f: FormatLike): boolean =>
    f.photoHeight > 0
    && Math.abs(f.photoWidth / f.photoHeight - aspect) < tol
    && matchesVideoAspect(f);

  if (floorFirst) {
    // ── SWEEP INGEST PIPELINE.  See `videoFloorOutranksAspect` for why the
    //    stage order is inverted here and nowhere else. ──────────────────

    // 1. THE FLOOR, FIRST — and still soft, so a device with nothing above
    //    it degrades to its best rather than refusing to open a camera.
    const cleared = formats.filter((f) => videoLongEdge(f) >= videoFloor);
    const floorCleared = cleared.length > 0;
    let base: F[] = floorCleared ? cleared : formats.slice();

    // 2. 4:3 WITHIN the floored set, matched on the VIDEO dims alone — the
    //    video is what gets ingested, and requiring the photo to agree is
    //    what made the whole Android ladder unreachable.  Soft: a device
    //    whose only big formats are 16:9 takes 16:9.
    const fourThreeVideo = base.filter(matchesVideoAspect);
    if (fourThreeVideo.length > 0) base = fourThreeVideo;

    // 3. Depth, unchanged in meaning from the default path.
    if (opts.preferDepthCapture) {
      const withDepth = base.filter((f) => f.supportsDepthCapture === true);
      if (withDepth.length > 0) base = withDepth;
    }

    // 4. Photo cap, soft as ever.
    const withinCap =
      cap > 0 ? base.filter((f) => longEdge(f) <= cap) : base.slice();
    const candidates = withinCap.length > 0 ? withinCap : base;

    // 5. fps FIRST (a sweep is a moving capture; frame rate is the motion-
    //    blur defence, and the iOS sibling refuses to start rather than
    //    trade it), then the SMALLEST stream that cleared the floor, then
    //    the photo closest to `aspect` so the still this session can also
    //    take does not silently change shape.
    const photoAspectErr = (f: FormatLike): number =>
      f.photoHeight > 0
        ? Math.abs(f.photoWidth / f.photoHeight - aspect)
        : Number.POSITIVE_INFINITY;

    const format = candidates.slice().sort((a, b) => {
      if (preferHighFps) {
        const sa = smoothness(a);
        const sb = smoothness(b);
        if (sb !== sa) return sb - sa;
      }
      const va = videoPixels(a);
      const vb = videoPixels(b);
      if (va !== vb) return va - vb; // SMALLEST clearing the floor
      const pa = photoAspectErr(a);
      const pb = photoAspectErr(b);
      if (pa !== pb) return pa - pb; // keep the still at `aspect`
      if (longEdge(b) !== longEdge(a)) return longEdge(b) - longEdge(a);
      return (a.supportsVideoHdr ? 1 : 0) - (b.supportsVideoHdr ? 1 : 0);
    })[0];

    return {
      format,
      floorRequested: videoFloor,
      floorCleared,
      videoAspectMatched: format ? matchesVideoAspect(format) : false,
      policy: 'floor-first',
    };
  }

  // ── DEFAULT PIPELINE — byte-for-byte the behaviour every non-sweep
  //    consumer has always had.  Left structurally intact so it can be read
  //    rather than re-derived. ────────────────────────────────────────────

  // Prefer 4:3 formats; if the device has none, consider all.
  const fourThree = formats.filter(matchesAspect);
  const base = fourThree.length > 0 ? fourThree : formats.slice();

  // captureDepthData: among the aspect-matched formats, keep only the
  // depth-capable ones when any exist — a depth-less format makes iOS
  // depth delivery silently produce nothing.  No depth format on this
  // device → fall through unchanged (graceful no-depth capture).
  let depthBase = base;
  if (opts.preferDepthCapture) {
    const withDepth = base.filter((f) => f.supportsDepthCapture === true);
    if (withDepth.length > 0) depthBase = withDepth;
  }

  // keyframeQualityCapture: video long-edge floor (see the option doc) —
  // keeps the fps preference from landing a tiny 640×480 video stream that
  // becomes 0.3 MP pano keyframes.  Soft: no qualifying format → unfloored.
  //
  // ⚠ ON ANDROID THIS IS ALWAYS THE UNFLOORED BRANCH, because `base` above
  // has already collapsed to the single 4:3 entry CameraX publishes
  // (640×480) and nothing in it clears 1280.  `floorCleared` says so.
  let sizedBase = depthBase;
  let floorCleared = false;
  if (videoFloor > 0) {
    const bigEnough = depthBase.filter(
      (f) => videoLongEdge(f) >= videoFloor,
    );
    floorCleared = bigEnough.length > 0;
    if (floorCleared) sizedBase = bigEnough;
  }

  // Among those within the photo cap; if none fit, fall back to all (which
  // then resolves to the max-video format — never worse than today).
  const withinCap =
    cap > 0 ? sizedBase.filter((f) => longEdge(f) <= cap) : sizedBase.slice();
  const candidates = withinCap.length > 0 ? withinCap : sizedBase;

  const format = candidates.slice().sort((a, b) => {
    if (preferHighFps) {
      // Smooth-preview priority: frame rate (up to the target) before video
      // resolution.  Keeps the panorama preview at ~60 fps instead of dropping
      // to a sharper-but-30fps format.
      const sa = smoothness(a);
      const sb = smoothness(b);
      if (sb !== sa) return sb - sa;
    }
    const va = videoPixels(a);
    const vb = videoPixels(b);
    if (vb !== va) return vb - va; // highest video resolution first
    if (b.maxFps !== a.maxFps) return b.maxFps - a.maxFps; // then higher fps
    if (longEdge(b) !== longEdge(a)) return longEdge(b) - longEdge(a); // largest photo under cap
    // Prefer non-HDR — a hedge toward an 8-bit pixel format (the stitch
    // frame processor needs 8-bit; vision-camera doesn't expose bit-depth).
    return (a.supportsVideoHdr ? 1 : 0) - (b.supportsVideoHdr ? 1 : 0);
  })[0];

  return {
    format,
    floorRequested: videoFloor,
    floorCleared,
    videoAspectMatched: format ? matchesVideoAspect(format) : false,
    policy: 'aspect-first',
  };
}
