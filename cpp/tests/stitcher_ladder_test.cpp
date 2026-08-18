// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the flattened stitch ladder (cpp/stitcher_ladder.hpp) and
 * the collapsed-placement validator predicate (cpp/warp_guard.hpp).
 *
 * The 2026-08-17 field RCA (Galaxy A35, 10-frame lateral pan: 4m41s of
 * rescue chains, a 30-min bundle-adjust wedge, and a scans@0.3 output that
 * collapsed 10 frames into a 722×718 canvas yet PASSED both existing
 * validators) pinned three invariants this file locks down:
 *
 *   1. the rung plan is threshold-only and primary-model-first, for both
 *      primaries;
 *   2. scans@0.3 — the garbage regime — appears in NO plan;
 *   3. best-rung selection prefers more retained frames, ties going to the
 *      earlier (higher-preference) rung;
 *   4. the collapsed-placement predicate rejects the real observed collapse
 *      and passes legitimate coverage, with its documented disable/single-
 *      frame edges.
 */
#include "stitcher_ladder.hpp"
#include "warp_guard.hpp"

#include <gtest/gtest.h>

using retailens::LadderRung;
using retailens::StitchMode;
using retailens::kStitchLadderRungs;
using retailens::ladderRungBeatsBest;
using retailens::planStitchLadder;
using retailens::stitchOutputCollapsed;

TEST(StitchLadder, PanoramaPrimaryRungOrder) {
  const auto plan = planStitchLadder(StitchMode::Panorama);
  ASSERT_EQ(static_cast<int>(plan.size()), kStitchLadderRungs);
  EXPECT_EQ(plan[0].mode, StitchMode::Panorama);
  EXPECT_DOUBLE_EQ(plan[0].confidenceThresh, 1.00);
  EXPECT_EQ(plan[1].mode, StitchMode::Panorama);
  EXPECT_DOUBLE_EQ(plan[1].confidenceThresh, 0.30);
  EXPECT_EQ(plan[2].mode, StitchMode::Scans);
  EXPECT_DOUBLE_EQ(plan[2].confidenceThresh, 1.00);
  EXPECT_EQ(plan[3].mode, StitchMode::Scans);
  EXPECT_DOUBLE_EQ(plan[3].confidenceThresh, 0.50);
}

TEST(StitchLadder, ScansPrimaryRungOrder) {
  const auto plan = planStitchLadder(StitchMode::Scans);
  ASSERT_EQ(static_cast<int>(plan.size()), kStitchLadderRungs);
  EXPECT_EQ(plan[0].mode, StitchMode::Scans);
  EXPECT_DOUBLE_EQ(plan[0].confidenceThresh, 1.00);
  EXPECT_EQ(plan[1].mode, StitchMode::Scans);
  EXPECT_DOUBLE_EQ(plan[1].confidenceThresh, 0.50);
  EXPECT_EQ(plan[2].mode, StitchMode::Panorama);
  EXPECT_DOUBLE_EQ(plan[2].confidenceThresh, 1.00);
  EXPECT_EQ(plan[3].mode, StitchMode::Panorama);
  EXPECT_DOUBLE_EQ(plan[3].confidenceThresh, 0.30);
}

// The scans@0.3 regime produced the collapsed 722×718 garbage on-device and
// scattered islands offline — it is banned from EVERY plan.  SCANS rungs
// must floor at 0.50; only PANORAMA may go to 0.30.
TEST(StitchLadder, NoScansAtPointThreeAnywhere) {
  for (const StitchMode primary : { StitchMode::Panorama, StitchMode::Scans }) {
    const auto plan = planStitchLadder(primary);
    for (const LadderRung& rung : plan) {
      if (rung.mode == StitchMode::Scans) {
        EXPECT_GE(rung.confidenceThresh, 0.50)
            << "scans rung below the 0.50 floor in "
            << (primary == StitchMode::Scans ? "scans" : "panorama")
            << "-primary plan";
      }
    }
  }
}

// More retained frames wins; a tie must NOT displace the earlier rung (the
// earlier rung ran the higher-preference model/threshold).
TEST(StitchLadder, BestRungSelectionPrefersMoreFramesThenEarlier) {
  EXPECT_TRUE(ladderRungBeatsBest(10, 9));    // strictly more → displace
  EXPECT_FALSE(ladderRungBeatsBest(9, 9));    // tie → keep earlier rung
  EXPECT_FALSE(ladderRungBeatsBest(8, 9));    // fewer → keep earlier rung
  // Degenerate-but-total: a first partial always beats the "no best yet"
  // sentinel the orchestration seeds comparisons with.
  EXPECT_TRUE(ladderRungBeatsBest(2, -1));
}

// The real numbers from the on-device collapse: 10 frames of 480×640
// (307 200 px each).  Minimum legitimate coverage at 10 % growth per extra
// frame = 307 200 × 1.9 = 583 680 px.
TEST(CollapsedPlacement, RejectsTheObservedCollapse) {
  // 460 000 px of coverage < 583 680 minimum → collapsed.
  EXPECT_TRUE(stitchOutputCollapsed(460000.0, 307200.0, 10));
}

TEST(CollapsedPlacement, PassesLegitimateCoverage) {
  // 800 000 px ≥ 583 680 minimum → a heavy-overlap but real pan passes.
  EXPECT_FALSE(stitchOutputCollapsed(800000.0, 307200.0, 10));
}

TEST(CollapsedPlacement, SingleFrameNeverRejects) {
  // One frame trivially covers exactly one frame's area — no growth to
  // demand.  Even absurdly small coverage must pass (the crop handles it).
  EXPECT_FALSE(stitchOutputCollapsed(1000.0, 307200.0, 1));
}

TEST(CollapsedPlacement, ZeroFrameAreaDisablesTheCheck) {
  // Callers without compose-scale frame dims pass 0 → check disabled, never
  // rejects regardless of how collapsed the coverage looks.
  EXPECT_FALSE(stitchOutputCollapsed(460000.0, 0.0, 10));
  EXPECT_FALSE(stitchOutputCollapsed(1.0, 0.0, 10));
}

TEST(CollapsedPlacement, BoundaryIsExclusive) {
  // Exactly the minimum area is NOT collapsed (strict <): 583 680 px for
  // 10 × 307 200 px frames.
  EXPECT_FALSE(stitchOutputCollapsed(583680.0, 307200.0, 10));
  EXPECT_TRUE(stitchOutputCollapsed(583679.0, 307200.0, 10));
}
