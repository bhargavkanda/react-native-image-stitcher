// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cmath>
#include <cstdint>

// ─────────────────────────────────────────────────────────────────────
// Free-quad crop geometry — the OpenCV-FREE, unit-testable core of the
// item-7 draggable-corner crop (`cropToQuad`).  The actual perspective
// warp (cv::getPerspectiveTransform + cv::warpPerspective) lives next to
// the existing axis-aligned crop in the platform bridges; this header is
// JUST the two pure predicates worth testing in isolation:
//
//   - quadDstRect(quad)       → the {w,h} of the upright destination
//                               rectangle the quad rectifies INTO.
//   - isQuadAcceptable(quad)  → convex + min-area + within-bounds gate
//                               the warp must pass before allocating.
//
// Header-only + zero cv:: dependency on purpose — same posture as
// warp_guard.hpp.  These are the C++ twins of the JS-side helpers in
// src/camera/cropGeometry.ts (rectSizeForQuad / isQuadValid); the math
// is duplicated per the repo's "duplicate stage code, DRY when proven"
// convention so a native caller never has to round-trip through JS to
// validate a quad.
//
// Corner-order contract: every function below assumes the 4 points are
// in canonical [TL, TR, BR, BL] (clockwise from top-left) winding — the
// order src/camera/cropGeometry.ts:orderQuadCorners produces and the
// order RectCropResult.quad carries.  Pass un-ordered points and the
// edge-length / convexity math is meaningless.
// ─────────────────────────────────────────────────────────────────────

namespace retailens {

// A single corner in image-pixel space (origin = image top-left).
struct QuadPoint {
  double x = 0.0;
  double y = 0.0;
};

// Exactly four corners, in [TL, TR, BR, BL] order.
struct CropQuad {
  QuadPoint tl;
  QuadPoint tr;
  QuadPoint br;
  QuadPoint bl;
};

// Integer destination-rectangle size the quad rectifies into.
struct QuadDstSize {
  int width = 0;
  int height = 0;
};

// Euclidean distance between two corners.
inline double quadPointDistance(const QuadPoint& a, const QuadPoint& b) {
  const double dx = a.x - b.x;
  const double dy = a.y - b.y;
  return std::sqrt(dx * dx + dy * dy);
}

// Target rectangle size for the perspective `dst` quad, derived from the
// 4 ORDERED ([TL, TR, BR, BL]) image-pixel corners:
//   - width  = average of the top edge (TL→TR) and bottom edge (BL→BR).
//   - height = average of the left edge (TL→BL) and right edge (TR→BR).
//
// Averaging opposite edges gives a stable output size for a skewed quad
// (each pair of opposite edges differs under perspective; the mean is the
// least-distorting target).  Rounds to whole pixels — the warp allocates
// an integer-sized output Mat.  Mirrors cropGeometry.ts:rectSizeForQuad
// so iOS / Android / JS agree on the output dimensions bit-for-bit.
//
// A degenerate quad (all-collinear, zero-size) yields a 0×0 or 1×N size;
// the caller GUARDS this with isQuadAcceptable + canvasExceedsGuard before
// allocating, so this function never has to reject — it only measures.
inline QuadDstSize quadDstRect(const CropQuad& q) {
  const double top = quadPointDistance(q.tl, q.tr);
  const double bottom = quadPointDistance(q.bl, q.br);
  const double left = quadPointDistance(q.tl, q.bl);
  const double right = quadPointDistance(q.tr, q.br);
  QuadDstSize size;
  size.width = static_cast<int>(std::lround((top + bottom) / 2.0));
  size.height = static_cast<int>(std::lround((left + right) / 2.0));
  return size;
}

// 2× the signed area of the quad via the shoelace formula.  Positive for
// one winding, negative for the other, ~0 for a degenerate (collinear)
// quad.  Sign is winding-dependent; callers that care about magnitude
// (min-area) take the absolute value.
inline double quadSignedArea2(const CropQuad& q) {
  const QuadPoint p[4] = {q.tl, q.tr, q.br, q.bl};
  double sum = 0.0;
  for (int i = 0; i < 4; ++i) {
    const QuadPoint& a = p[i];
    const QuadPoint& b = p[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

// Convexity test: all four consecutive edge cross-products share one sign
// (zero allowed for a straight, axis-aligned corner).  Rejects the self-
// intersecting "bowtie" quads a free-drag editor can produce, which a
// perspective warp can't rectify.  Winding-agnostic.  Mirrors the
// `isConvex` helper in cropGeometry.ts.
inline bool quadIsConvex(const CropQuad& q) {
  const QuadPoint p[4] = {q.tl, q.tr, q.br, q.bl};
  int sign = 0;
  for (int i = 0; i < 4; ++i) {
    const QuadPoint& a = p[i];
    const QuadPoint& b = p[(i + 1) % 4];
    const QuadPoint& c = p[(i + 2) % 4];
    const double cross =
        (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross != 0.0) {
      const int s = (cross > 0.0) ? 1 : -1;
      if (sign == 0) {
        sign = s;
      } else if (s != sign) {
        return false;
      }
    }
  }
  return true;
}

// True when the 4 ordered ([TL, TR, BR, BL]) corners form a quad the
// perspective warp can safely rectify:
//   1. **Convex** — no self-intersection (quadIsConvex).
//   2. **Non-degenerate area** — |signed area| ≥ `minArea` (default 1 px²);
//      rejects all-collinear / zero-size quads.
//   3. **Within bounds** — every corner lies inside [0..imageW]×[0..imageH]
//      (a half-pixel epsilon absorbs the lround in the JS letterbox
//      inverse).  Pass imageW <= 0 OR imageH <= 0 to SKIP the bounds
//      check (the caller doesn't know the image size yet).
//
// The companion to warp_guard.hpp:canvasExceedsGuard — that guards the
// OUTPUT canvas against an OOM; this guards the INPUT quad against being
// geometrically unwarpable.  Both must pass before warpPerspective runs.
inline bool isQuadAcceptable(const CropQuad& q,
                             double imageW = 0.0,
                             double imageH = 0.0,
                             double minArea = 1.0) {
  if (!quadIsConvex(q)) {
    return false;
  }
  if (std::fabs(quadSignedArea2(q)) < minArea * 2.0) {
    return false;
  }
  if (imageW > 0.0 && imageH > 0.0) {
    const QuadPoint p[4] = {q.tl, q.tr, q.br, q.bl};
    const double eps = 0.5;
    for (int i = 0; i < 4; ++i) {
      if (p[i].x < -eps || p[i].x > imageW + eps ||
          p[i].y < -eps || p[i].y > imageH + eps) {
        return false;
      }
    }
  }
  return true;
}

}  // namespace retailens
