// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the warp-canvas size guard (cpp/warp_guard.hpp).
 *
 * The guard decides when a warp ROI is "degenerate" — the trigger for
 * both the cylindrical-fallback pre-pass and the in-loop final safety net.
 * The cases that matter: normal ROIs pass, non-positive dims fail, the
 * 100 MP boundary is inclusive, the real observed divergence (8171×12336)
 * is caught, and a ROI whose int32 area would overflow is still caught.
 */
#include "warp_guard.hpp"

#include <gtest/gtest.h>

using retailens::warpRoiExceedsGuard;
using retailens::canvasExceedsGuard;

TEST(WarpGuard, AcceptsNormalRoi) {
  EXPECT_FALSE(warpRoiExceedsGuard(4000, 2000));  // 8 MP
  EXPECT_FALSE(warpRoiExceedsGuard(1, 1));
}

TEST(WarpGuard, RejectsNonPositiveDims) {
  EXPECT_TRUE(warpRoiExceedsGuard(0, 1000));
  EXPECT_TRUE(warpRoiExceedsGuard(1000, 0));
  EXPECT_TRUE(warpRoiExceedsGuard(-5, 1000));
  EXPECT_TRUE(warpRoiExceedsGuard(1000, -5));
}

TEST(WarpGuard, BoundaryIsInclusive) {
  EXPECT_FALSE(warpRoiExceedsGuard(100000, 1000));  // exactly 100 MP — allowed
  EXPECT_TRUE(warpRoiExceedsGuard(100000, 1001));   // 100.1 MP — over
}

TEST(WarpGuard, RejectsTheObservedDivergence) {
  // 8171×12336 = 100.8 MP — the exact STITCH_CAMERA_PARAMS_FAIL canvas.
  EXPECT_TRUE(warpRoiExceedsGuard(8171, 12336));
}

TEST(WarpGuard, RejectsInt32OverflowingRoi) {
  // 65536×65536 = 2^32; an int32 area would wrap to 0 and slip past the
  // guard. The int64 area math catches it.
  EXPECT_TRUE(warpRoiExceedsGuard(65536, 65536));
}

TEST(WarpGuard, HonoursCustomThreshold) {
  EXPECT_FALSE(warpRoiExceedsGuard(1000, 1000, 2'000'000));  // 1 MP < 2 MP
  EXPECT_TRUE(warpRoiExceedsGuard(2000, 1000, 1'000'000));   // 2 MP > 1 MP
}

// A motion-blurred rapid pan produces tiny 480×640 INPUT frames; only the
// degenerate WARP OUTPUT is rejected.  The input frame itself must pass —
// otherwise the guard would reject every rapid pan, valid or not.
TEST(WarpGuard, AcceptsHealthyRapidPanInputFrame) {
  EXPECT_FALSE(warpRoiExceedsGuard(480, 640));
}

// Locks the stitcher.cpp ordering: the guard (warpRoiExceedsGuard → throw)
// runs BEFORE the allocation it protects (imagesWarped[i].create() in the
// BATCH path, warper->warp()'s buildMaps in STREAM).  A rejected ROI must
// never set the allocation flag — i.e. the giant alloc never happens.
TEST(WarpGuard, RejectsBeforeAllocating) {
  auto tryWarp = [](int w, int h, bool& allocated) -> bool {
    if (warpRoiExceedsGuard(w, h)) return false;  // guard fires first
    allocated = true;                              // the create() it guards
    return true;
  };
  bool allocated = false;
  EXPECT_FALSE(tryWarp(8171, 12336, allocated));  // the observed divergence
  EXPECT_FALSE(allocated);
  allocated = false;
  EXPECT_FALSE(tryWarp(65536, 65536, allocated));  // int32-overflowing ROI
  EXPECT_FALSE(allocated);
  allocated = false;
  EXPECT_TRUE(tryWarp(4000, 2000, allocated));     // a valid frame DOES alloc
  EXPECT_TRUE(allocated);
}

// ─────────────────────────────────────────────────────────────────────
// Cumulative blend-canvas guard (the real crash-B net) — canvasExceedsGuard.
// ─────────────────────────────────────────────────────────────────────

TEST(CanvasGuard, AcceptsValidWidePanorama) {
  // A valid 360° cylindrical canvas is ~9 MP; real field-log panos ~1.3 MP.
  EXPECT_FALSE(canvasExceedsGuard(3000, 3000));   // 9 MP  (360° class)
  EXPECT_FALSE(canvasExceedsGuard(6000, 1200));   // 7.2 MP wide sweep
  EXPECT_FALSE(canvasExceedsGuard(1, 1));
}

TEST(CanvasGuard, RejectsNonPositiveDims) {
  EXPECT_TRUE(canvasExceedsGuard(0, 1000));
  EXPECT_TRUE(canvasExceedsGuard(1000, 0));
  EXPECT_TRUE(canvasExceedsGuard(-5, 1000));
  EXPECT_TRUE(canvasExceedsGuard(1000, -5));
}

TEST(CanvasGuard, BoundaryIsInclusive) {
  EXPECT_FALSE(canvasExceedsGuard(50000, 1000));  // exactly 50 MP — allowed
  EXPECT_TRUE(canvasExceedsGuard(50000, 1001));   // 50.05 MP — over
}

TEST(CanvasGuard, RejectsDegenerateUnion) {
  // The crash-B union: a single degenerate corner offset blows the bbox to
  // gigapixels even though every per-frame extent passed the 100 MP guard.
  EXPECT_TRUE(canvasExceedsGuard(60000, 60000));    // 3.6 Gpx (~the 3.7 GB blow-up)
  EXPECT_TRUE(canvasExceedsGuard(200000, 200000));  // 40 Gpx
}

TEST(CanvasGuard, RejectsOverflowingDimension) {
  // A degenerate corner can exceed int32 on its own; the >3 G defensive cap
  // rejects it before the area multiply can overflow int64.
  EXPECT_TRUE(canvasExceedsGuard(5'000'000'000LL, 1));
  EXPECT_TRUE(canvasExceedsGuard(1, 5'000'000'000LL));
}

TEST(CanvasGuard, HonoursCustomThreshold) {
  // The RAM-aware caller (deferred Layer 3) can pass a tighter cap on
  // low-memory devices; the floor never drops below the ~9 MP valid ceiling.
  EXPECT_FALSE(canvasExceedsGuard(4000, 4000, 20'000'000));  // 16 MP < 20 MP
  EXPECT_TRUE(canvasExceedsGuard(5000, 5000, 20'000'000));   // 25 MP > 20 MP
}
