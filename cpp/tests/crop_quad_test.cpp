// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the free-quad crop geometry (cpp/crop_quad.hpp).
 *
 * These are the OpenCV-FREE, unit-testable core of item-7's perspective
 * crop (`cropToQuad`): the destination-rectangle sizing (quadDstRect) and
 * the convex / min-area / in-bounds acceptability gate (isQuadAcceptable).
 * The cv::warpPerspective itself is on-device-only and not exercised here.
 *
 * The cases that matter:
 *   - an AXIS-ALIGNED quad rectifies to a rect == its bounding box;
 *   - a SKEWED quad gets the AVERAGED opposite-edge dimensions;
 *   - DEGENERATE (zero-area, collinear) and NON-CONVEX (bowtie) quads are
 *     rejected; out-of-bounds corners are rejected; the bounds check is
 *     skipped when image size is unknown.
 * These mirror the JS-side cropGeometry tests so all three surfaces agree.
 */
#include "crop_quad.hpp"

#include <gtest/gtest.h>

using retailens::CropQuad;
using retailens::QuadDstSize;
using retailens::isQuadAcceptable;
using retailens::quadDstRect;
using retailens::quadIsConvex;
using retailens::quadSignedArea2;

namespace {

// Build a quad from 8 doubles in [TL, TR, BR, BL] order.
CropQuad makeQuad(double tlx, double tly, double trx, double try_,
                  double brx, double bry, double blx, double bly) {
  CropQuad q;
  q.tl = {tlx, tly};
  q.tr = {trx, try_};
  q.br = {brx, bry};
  q.bl = {blx, bly};
  return q;
}

}  // namespace

// ─────────────────────────────────────────────────────────────────────
// quadDstRect — destination rectangle sizing.
// ─────────────────────────────────────────────────────────────────────

TEST(QuadDstRect, AxisAlignedRectEqualsBoundingBox) {
  // A 200×100 axis-aligned rectangle rectifies to exactly 200×100 — the
  // averaged edges are equal, so the mean is the edge itself.
  const CropQuad q = makeQuad(0, 0, 200, 0, 200, 100, 0, 100);
  const QuadDstSize s = quadDstRect(q);
  EXPECT_EQ(s.width, 200);
  EXPECT_EQ(s.height, 100);
}

TEST(QuadDstRect, OffsetAxisAlignedRectUsesEdgeLengths) {
  // Same 200×100 size but translated away from the origin — dst size is
  // edge-length-based, not corner-coordinate-based.
  const CropQuad q = makeQuad(50, 30, 250, 30, 250, 130, 50, 130);
  const QuadDstSize s = quadDstRect(q);
  EXPECT_EQ(s.width, 200);
  EXPECT_EQ(s.height, 100);
}

TEST(QuadDstRect, SkewedQuadAveragesOppositeEdges) {
  // Top edge 100 px, bottom edge 200 px → width = mean(100, 200) = 150.
  // Left/right edges are both 100 px tall (vertical) → height = 100.
  //   TL(0,0) TR(100,0) BR(200,100) BL(0,100)
  //   top   = |TR-TL| = 100
  //   bottom= |BR-BL| = 200
  //   left  = |BL-TL| = 100
  //   right = |BR-TR| = sqrt(100^2 + 100^2) = 141.42
  // height = mean(100, 141.42) = 120.71 → rounds to 121.
  const CropQuad q = makeQuad(0, 0, 100, 0, 200, 100, 0, 100);
  const QuadDstSize s = quadDstRect(q);
  EXPECT_EQ(s.width, 150);   // mean(100, 200)
  EXPECT_EQ(s.height, 121);  // round(mean(100, 141.42))
}

TEST(QuadDstRect, RoundsToWholePixels) {
  // Top/bottom edges 101 and 100 → mean 100.5 → rounds to 101 (lround
  // rounds half away from zero).
  const CropQuad q = makeQuad(0, 0, 101, 0, 100, 50, 0, 50);
  const QuadDstSize s = quadDstRect(q);
  EXPECT_EQ(s.width, 101);  // round(mean(101, 100)) = round(100.5)
  EXPECT_EQ(s.height, 50);
}

// ─────────────────────────────────────────────────────────────────────
// isQuadAcceptable — convex + min-area + in-bounds gate.
// ─────────────────────────────────────────────────────────────────────

TEST(QuadAcceptable, AcceptsAxisAlignedRect) {
  const CropQuad q = makeQuad(0, 0, 200, 0, 200, 100, 0, 100);
  EXPECT_TRUE(isQuadAcceptable(q));
}

TEST(QuadAcceptable, AcceptsConvexSkewedQuad) {
  const CropQuad q = makeQuad(10, 5, 190, 0, 200, 100, 0, 95);
  EXPECT_TRUE(isQuadAcceptable(q));
}

TEST(QuadAcceptable, RejectsZeroAreaCollinear) {
  // All four corners on one horizontal line — zero area.
  const CropQuad q = makeQuad(0, 50, 100, 50, 200, 50, 300, 50);
  EXPECT_FALSE(isQuadAcceptable(q));
}

TEST(QuadAcceptable, RejectsDegeneratePoint) {
  // All four corners coincident.
  const CropQuad q = makeQuad(10, 10, 10, 10, 10, 10, 10, 10);
  EXPECT_FALSE(isQuadAcceptable(q));
}

TEST(QuadAcceptable, RejectsBelowMinArea) {
  // A 1×1 quad has area 1 px²; with minArea = 4 it's rejected, with the
  // default minArea = 1 it's accepted (boundary inclusive).
  const CropQuad q = makeQuad(0, 0, 1, 0, 1, 1, 0, 1);
  EXPECT_TRUE(isQuadAcceptable(q));               // default minArea = 1
  EXPECT_FALSE(isQuadAcceptable(q, 0, 0, 4.0));   // minArea = 4 → rejected
}

TEST(QuadAcceptable, RejectsNonConvexBowtie) {
  // Swapping BR and BL produces a self-intersecting "bowtie" — convex
  // gate must reject it (a perspective warp can't rectify it).
  //   TL(0,0) TR(100,0) BR(0,100) BL(100,100)  ← BR/BL swapped
  const CropQuad q = makeQuad(0, 0, 100, 0, 0, 100, 100, 100);
  EXPECT_FALSE(quadIsConvex(q));
  EXPECT_FALSE(isQuadAcceptable(q));
}

TEST(QuadAcceptable, RejectsReflexNonConvex) {
  // BR dragged INSIDE the triangle of the other three → one reflex
  // interior angle, non-convex.
  const CropQuad q = makeQuad(0, 0, 200, 0, 100, 30, 0, 200);
  EXPECT_FALSE(isQuadAcceptable(q));
}

TEST(QuadAcceptable, RejectsOutOfBoundsCorner) {
  // A corner past the right image edge (image is 200×100).
  const CropQuad q = makeQuad(0, 0, 250, 0, 200, 100, 0, 100);
  EXPECT_FALSE(isQuadAcceptable(q, 200.0, 100.0));
}

TEST(QuadAcceptable, AcceptsCornerOnExactBound) {
  // Corners exactly on the image edge are in-bounds (½-px epsilon).
  const CropQuad q = makeQuad(0, 0, 200, 0, 200, 100, 0, 100);
  EXPECT_TRUE(isQuadAcceptable(q, 200.0, 100.0));
}

TEST(QuadAcceptable, SkipsBoundsCheckWhenImageSizeUnknown) {
  // imageW/imageH <= 0 → bounds check skipped; only convex + area apply.
  const CropQuad q = makeQuad(-50, -50, 250, 0, 200, 100, 0, 100);
  EXPECT_TRUE(isQuadAcceptable(q, 0.0, 0.0));    // bounds skipped
  EXPECT_FALSE(isQuadAcceptable(q, 200.0, 100.0));  // bounds enforced
}

// ─────────────────────────────────────────────────────────────────────
// Supporting predicates (exported for direct coverage).
// ─────────────────────────────────────────────────────────────────────

TEST(QuadSignedArea, SignFlipsWithWinding) {
  // [TL, TR, BR, BL] clockwise in image coords (y-down) gives a positive
  // shoelace sum; reversing the winding flips the sign.  Magnitude is
  // 2× the 200×100 = 20000 px² area regardless.
  const CropQuad cw = makeQuad(0, 0, 200, 0, 200, 100, 0, 100);
  const CropQuad ccw = makeQuad(0, 0, 0, 100, 200, 100, 200, 0);
  EXPECT_NEAR(quadSignedArea2(cw), -quadSignedArea2(ccw), 1e-9);
  EXPECT_NEAR(std::fabs(quadSignedArea2(cw)), 40000.0, 1e-9);  // 2 × 20000
}

TEST(QuadConvex, AllowsStraightCollinearCorner) {
  // A corner lying on the straight edge between its neighbours (cross = 0)
  // doesn't break convexity — a valid degenerate-but-convex pentagon edge.
  const CropQuad q = makeQuad(0, 0, 100, 0, 200, 100, 0, 100);
  EXPECT_TRUE(quadIsConvex(q));
}
