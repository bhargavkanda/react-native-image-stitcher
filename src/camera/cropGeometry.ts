// SPDX-License-Identifier: Apache-2.0
/**
 * cropGeometry — pure coordinate + quad helpers behind the item-7
 * draggable-corner crop editor (`RectCropPreview`).
 *
 * The editor shows the full result image with a `resizeMode="contain"`
 * letterbox: the image is centred and uniformly scaled to fit the layout
 * box, leaving symmetric bars on one axis.  The 4 draggable corners live in
 * ON-SCREEN coordinates (the touch space PanResponder reports), but the
 * native crop needs IMAGE-PIXEL coordinates.  These helpers are the
 * letterbox transform and its inverse — extracted verbatim from
 * `example/InscribedRectDebug.tsx` (~lines 178-204), which mapped an
 * inscribed-rect from image px → screen the same way.
 *
 * Everything here is pure (no React, no native) so it's unit-testable
 * without booting a render — same posture as `contentRotationDeg` and
 * `buildPanoramaInitialSettings`.
 *
 * Coordinate conventions:
 *   - A `Point` is `{ x, y }`.  Screen points are in the layout box's
 *     local space (origin = box top-left); image points are in pixel
 *     space (origin = image top-left, range [0..imageW] × [0..imageH]).
 *   - A `Quad` is exactly 4 points.  `orderQuadCorners` canonicalises
 *     winding to [TL, TR, BR, BL] so downstream native perspective
 *     rectify gets corners in the order it expects.
 */

/** A 2-D point in either screen-local or image-pixel space. */
export interface Point {
  x: number;
  y: number;
}

/** The contain-fit letterbox layout of the image inside its box. */
export interface ContainLayout {
  /** Layout box width (on-screen px). */
  width: number;
  /** Layout box height (on-screen px). */
  height: number;
}

/** Exactly four points (corners of a crop quad). */
export type Quad = [Point, Point, Point, Point];


/**
 * The contain-fit transform: uniform scale + centring offsets that map
 * image-pixel space into the on-screen layout box.  Returns `null` when
 * any dimension is non-positive (nothing to lay out).
 *
 * `scale` is `min(box.w / imageW, box.h / imageH)` — the same
 * `resizeMode="contain"` math RN's <Image> applies — and `offX`/`offY`
 * centre the scaled image, producing the letterbox bars.
 */
export function containFit(
  layout: ContainLayout,
  imageW: number,
  imageH: number,
): { scale: number; offX: number; offY: number } | null {
  if (
    layout.width <= 0
    || layout.height <= 0
    || imageW <= 0
    || imageH <= 0
  ) {
    return null;
  }
  const scale = Math.min(layout.width / imageW, layout.height / imageH);
  const dispW = imageW * scale;
  const dispH = imageH * scale;
  const offX = (layout.width - dispW) / 2;
  const offY = (layout.height - dispH) / 2;
  return { scale, offX, offY };
}


/**
 * Map an on-screen point (layout-box local coords) → image-pixel coords.
 * Inverse of {@link imageToScreen}.  The result is clamped to
 * `[0..imageW] × [0..imageH]` so a corner dragged onto / past the
 * letterbox bar still yields a valid in-bounds pixel for the native crop
 * (the user can't pick pixels that don't exist).
 *
 * Returns the un-mapped point unchanged when the layout is degenerate
 * (see {@link containFit}) — the caller has no valid letterbox yet.
 */
export function screenToImage(
  point: Point,
  layout: ContainLayout,
  imageW: number,
  imageH: number,
): Point {
  const fit = containFit(layout, imageW, imageH);
  if (!fit) return point;
  const x = (point.x - fit.offX) / fit.scale;
  const y = (point.y - fit.offY) / fit.scale;
  return {
    x: clamp(x, 0, imageW),
    y: clamp(y, 0, imageH),
  };
}


/**
 * Map an image-pixel point → on-screen point (layout-box local coords).
 * Inverse of {@link screenToImage}.  Used to seed the draggable corners
 * from an image-space initial rect and to keep the overlay aligned to the
 * letterboxed image.
 *
 * Returns the un-mapped point unchanged when the layout is degenerate.
 */
export function imageToScreen(
  point: Point,
  layout: ContainLayout,
  imageW: number,
  imageH: number,
): Point {
  const fit = containFit(layout, imageW, imageH);
  if (!fit) return point;
  return {
    x: fit.offX + point.x * fit.scale,
    y: fit.offY + point.y * fit.scale,
  };
}


/**
 * Re-order 4 arbitrary corner points into canonical
 * [TL, TR, BR, BL] (clockwise from top-left) winding.
 *
 * Strategy (robust to slight perspective skew, no trig):
 *   - Top two = the two points with the smallest `y`; bottom two = the
 *     largest `y`.  Within each pair, the smaller `x` is left.
 * Ties on `y` (a perfectly axis-aligned rect) resolve deterministically
 * because the sort is stable and we then split by `x`.
 *
 * This matches the corner order the native `cropToQuad` perspective
 * rectify expects (dst rect: TL→TR→BR→BL).
 */
export function orderQuadCorners(pts: Quad): Quad {
  // Sort a copy by y ascending so [0,1] are the top pair, [2,3] bottom.
  const byY = [...pts].sort((a, b) => a.y - b.y);
  const [t0, t1, b0, b1] = byY;
  // Within each horizontal pair, smaller x is the left corner.
  const [tl, tr] = t0.x <= t1.x ? [t0, t1] : [t1, t0];
  const [bl, br] = b0.x <= b1.x ? [b0, b1] : [b1, b0];
  return [tl, tr, br, bl];
}


/**
 * 2× the signed area of a polygon via the shoelace formula.  Positive for
 * counter-clockwise winding, negative for clockwise, ~0 for degenerate.
 * Exported for tests + reused by {@link isQuadValid}.
 */
export function signedArea2(pts: Quad): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}


/**
 * True when the 4 points form a usable crop quad:
 *   1. **Non-degenerate area** — `|signed area|` ≥ `minArea` (default
 *      `1`, i.e. at least 1 px²).  Rejects all-collinear / zero-size.
 *   2. **Convex** — every cross-product of consecutive edges shares one
 *      sign (allowing zero for a straight, axis-aligned corner).  Rejects
 *      self-intersecting / "bowtie" quads, which the native perspective
 *      warp can't rectify.
 *
 * Operates on the points in their given winding (call `orderQuadCorners`
 * first if you need canonical order); convexity is winding-agnostic.
 */
export function isQuadValid(pts: Quad, minArea = 1): boolean {
  if (Math.abs(signedArea2(pts)) < minArea * 2) return false;
  return isConvex(pts);
}


/**
 * Target rectangle size for the perspective `dst` quad, derived from the
 * 4 ORDERED ([TL, TR, BR, BL]) image-pixel corners:
 *   - `w` = average of the top edge (TL→TR) and bottom edge (BL→BR)
 *     lengths.
 *   - `h` = average of the left edge (TL→BL) and right edge (TR→BR)
 *     lengths.
 * Averaging opposite edges gives a stable output size for a skewed quad
 * (each pair of opposite edges differs under perspective; the mean is the
 * least-distorting target).  Rounds to whole pixels — the native crop
 * allocates an integer-sized bitmap.
 *
 * Caller must pass corners already in [TL, TR, BR, BL] order (use
 * {@link orderQuadCorners}); the math assumes that winding.
 */
export function rectSizeForQuad(orderedImagePts: Quad): {
  w: number;
  h: number;
} {
  const [tl, tr, br, bl] = orderedImagePts;
  const top = dist(tl, tr);
  const bottom = dist(bl, br);
  const left = dist(tl, bl);
  const right = dist(tr, br);
  return {
    w: Math.round((top + bottom) / 2),
    h: Math.round((left + right) / 2),
  };
}


/**
 * True when an ORDERED ([TL, TR, BR, BL]) image-pixel quad is, within
 * `tolerancePx`, an axis-aligned rectangle — i.e. the cheap axis-aligned
 * `cropToRect` path applies and no perspective warp is needed.  The parent
 * uses this to choose `cropToRect` vs `cropToQuad`.
 *
 * Checks the two top/bottom corners share a `y` and the two left/right
 * corners share an `x`, all within tolerance.
 */
export function isAxisAlignedRect(
  orderedImagePts: Quad,
  tolerancePx = 1,
): boolean {
  const [tl, tr, br, bl] = orderedImagePts;
  return (
    Math.abs(tl.y - tr.y) <= tolerancePx
    && Math.abs(bl.y - br.y) <= tolerancePx
    && Math.abs(tl.x - bl.x) <= tolerancePx
    && Math.abs(tr.x - br.x) <= tolerancePx
  );
}


/** Convexity test: all consecutive edge cross-products share a sign. */
function isConvex(pts: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}


/** Euclidean distance between two points. */
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}


/** Clamp `v` into the inclusive `[lo, hi]` range. */
function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
