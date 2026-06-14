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
}

const DEFAULT_MAX_PHOTO_LONG_EDGE = 4032;

const longEdge = (f: FormatLike): number =>
  Math.max(f.photoWidth, f.photoHeight);
const videoPixels = (f: FormatLike): number => f.videoWidth * f.videoHeight;

/**
 * Pick the best capture format, or `undefined` for an empty list.
 */
export function pickCaptureFormat<F extends FormatLike>(
  formats: readonly F[],
  opts: PickFormatOptions = {},
): F | undefined {
  if (!formats || formats.length === 0) return undefined;

  const aspect = opts.aspect ?? 4 / 3;
  const tol = opts.aspectTolerance ?? 0.05;
  const cap = opts.maxPhotoLongEdge ?? DEFAULT_MAX_PHOTO_LONG_EDGE;

  const matchesAspect = (f: FormatLike): boolean =>
    f.photoHeight > 0
    && f.videoHeight > 0
    && Math.abs(f.photoWidth / f.photoHeight - aspect) < tol
    && Math.abs(f.videoWidth / f.videoHeight - aspect) < tol;

  // Prefer 4:3 formats; if the device has none, consider all.
  const fourThree = formats.filter(matchesAspect);
  const base = fourThree.length > 0 ? fourThree : formats.slice();

  // Among those within the photo cap; if none fit, fall back to all (which
  // then resolves to the max-video format — never worse than today).
  const withinCap =
    cap > 0 ? base.filter((f) => longEdge(f) <= cap) : base.slice();
  const candidates = withinCap.length > 0 ? withinCap : base;

  return candidates.slice().sort((a, b) => {
    const va = videoPixels(a);
    const vb = videoPixels(b);
    if (vb !== va) return vb - va; // highest video resolution first
    if (b.maxFps !== a.maxFps) return b.maxFps - a.maxFps; // then higher fps
    if (longEdge(b) !== longEdge(a)) return longEdge(b) - longEdge(a); // largest photo under cap
    // Prefer non-HDR — a hedge toward an 8-bit pixel format (the stitch
    // frame processor needs 8-bit; vision-camera doesn't expose bit-depth).
    return (a.supportsVideoHdr ? 1 : 0) - (b.supportsVideoHdr ? 1 : 0);
  })[0];
}
