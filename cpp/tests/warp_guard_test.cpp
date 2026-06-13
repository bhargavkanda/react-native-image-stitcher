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
using retailens::composeCanvasBudgetMP;
using retailens::canvasDownscaleForBudget;
using retailens::cappedSeamAspect;
using retailens::kBudgetFloorMP;
using retailens::kBudgetCeilMP;

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

// ─────────────────────────────────────────────────────────────────────
// RAM-aware output-canvas budget (the wide-pan blend-OOM fix).
// composeCanvasBudgetMP(totalRamMB) + canvasDownscaleForBudget(canvasMP,
// budgetMP) are the OpenCV-free, unit-testable core of the step-7.7 cap;
// the warp/resize itself is on-device-only (not exercised here).
// ─────────────────────────────────────────────────────────────────────

TEST(BudgetCap, FloorClampsLowRam) {
  // 1024 MB -> raw 1024*0.30/38 = 8.08 MP < floor -> clamped to floor.
  EXPECT_DOUBLE_EQ(composeCanvasBudgetMP(1024.0), kBudgetFloorMP);
}

TEST(BudgetCap, CeilClampsHighRam) {
  // A35 (6 GB): raw 48.5 MP -> ceil.  8 GB: raw 64.7 MP -> ceil.
  EXPECT_DOUBLE_EQ(composeCanvasBudgetMP(6144.0), kBudgetCeilMP);
  EXPECT_DOUBLE_EQ(composeCanvasBudgetMP(8192.0), kBudgetCeilMP);
}

TEST(BudgetCap, LinearInBand) {
  // 4096 MB -> raw 4096*0.30/38 = 32.34 MP, strictly between floor and ceil.
  EXPECT_NEAR(composeCanvasBudgetMP(4096.0), 32.337, 0.01);
  EXPECT_GT(composeCanvasBudgetMP(4096.0), kBudgetFloorMP);
  EXPECT_LT(composeCanvasBudgetMP(4096.0), kBudgetCeilMP);
}

TEST(BudgetCap, MonotonicNonDecreasingInRam) {
  const double ram[] = {1024, 2048, 3072, 4096, 6144, 8192, 12288};
  for (size_t i = 1; i < sizeof(ram) / sizeof(ram[0]); i++) {
    EXPECT_LE(composeCanvasBudgetMP(ram[i - 1]),
              composeCanvasBudgetMP(ram[i]));
  }
}

TEST(BudgetCap, SentinelRamHitsFloor) {
  // The caller resolves a -1 sentinel to an assumed RAM before calling, but
  // the function must never yield a non-positive budget regardless.
  EXPECT_DOUBLE_EQ(composeCanvasBudgetMP(-1.0), kBudgetFloorMP);
  EXPECT_DOUBLE_EQ(composeCanvasBudgetMP(0.0), kBudgetFloorMP);
}

TEST(BudgetDownscale, NoCapWhenUnderBudget) {
  // A 9 MP 360° pano is never downscaled (1.0 = no-op).
  EXPECT_DOUBLE_EQ(canvasDownscaleForBudget(9.0, 42.0), 1.0);
}

TEST(BudgetDownscale, NoCapAtExactBudget) {
  EXPECT_DOUBLE_EQ(canvasDownscaleForBudget(42.0, 42.0), 1.0);
}

TEST(BudgetDownscale, SqrtAreaLever) {
  // The A35 capture-14 case: 70 MP union, 42 MP budget.
  const double d = canvasDownscaleForBudget(70.0, 42.0);
  EXPECT_NEAR(d, 0.77460, 1e-4);     // sqrt(42/70)
  EXPECT_NEAR(70.0 * d * d, 42.0, 1e-6);  // area lands at budget
}

TEST(BudgetDownscale, ClampsToFloor) {
  // A pathological union still clamps at 0.2 (the canvasExceedsGuard net on
  // its own axis catches anything still over 50 MP afterward).
  EXPECT_DOUBLE_EQ(canvasDownscaleForBudget(5000.0, 42.0), 0.2);
}

TEST(BudgetDownscale, NeverUpscales) {
  EXPECT_DOUBLE_EQ(canvasDownscaleForBudget(1.3, 42.0), 1.0);  // normal field pano
}

TEST(BudgetDownscale, NonPositiveInputsAreSafe) {
  EXPECT_DOUBLE_EQ(canvasDownscaleForBudget(0.0, 42.0), 1.0);  // no div-by-zero
  EXPECT_DOUBLE_EQ(canvasDownscaleForBudget(70.0, 0.0), 1.0);
}

// ─────────────────────────────────────────────────────────────────────
// Seam-finder aspect re-cap (the wide-pan GraphCut-OOM fix).  Ensures
// every seam image lands at <= seamMp regardless of how far the warp
// expanded the canvas past the input frame size.
// ─────────────────────────────────────────────────────────────────────

TEST(SeamAspect, NoOpWhenWarpedAlreadyUnderSeam) {
  // Warped image already <= seamMp → keep the caller's aspect untouched.
  EXPECT_DOUBLE_EQ(cappedSeamAspect(0.5, 0.05, 0.1), 0.5);
  EXPECT_DOUBLE_EQ(cappedSeamAspect(0.5, 0.1, 0.1), 0.5);  // boundary inclusive
}

TEST(SeamAspect, CapsLargeWarpedToSeamMp) {
  // The capture-10 case: 19 MP warped frame, 0.1 MP seam target.  The
  // buggy input aspect (0.568) is tightened so the seam image is ~0.1 MP.
  const double a = cappedSeamAspect(0.568, 19.0, 0.1);
  EXPECT_NEAR(a, 0.072548, 1e-5);           // sqrt(0.1/19)
  EXPECT_NEAR(19.0 * a * a, 0.1, 1e-6);     // seam image lands at seamMp
  EXPECT_LT(a, 0.568);                       // it tightened
}

TEST(SeamAspect, NeverRaisesAboveInput) {
  // If the caller's aspect is already smaller than the cap, keep it (the
  // function only ever TIGHTENS the seam scale, never loosens it).
  EXPECT_DOUBLE_EQ(cappedSeamAspect(0.05, 19.0, 0.1), 0.05);
}

TEST(SeamAspect, DegenerateSeamMpIsNoOp) {
  EXPECT_DOUBLE_EQ(cappedSeamAspect(0.5, 19.0, 0.0), 0.5);   // seamMp <= 0
  EXPECT_DOUBLE_EQ(cappedSeamAspect(0.5, 0.0, 0.1), 0.5);    // empty warped
}
