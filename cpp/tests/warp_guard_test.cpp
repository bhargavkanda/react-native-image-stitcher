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
