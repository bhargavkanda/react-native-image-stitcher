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
using retailens::StitchErrorCode;
using retailens::StitchMode;
using retailens::collapsedCheckArmed;
using retailens::kMaxLadderRungs;
using retailens::kStitchLadderRungs;
using retailens::ladderErrorIsTerminal;
using retailens::ladderRungAcceptable;
using retailens::ladderRungBeatsBest;
using retailens::planStitchLadder;
using retailens::rungCannotImproveBest;
using retailens::sphericalExtraRungWarranted;
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

// 2026-08-17 review — the collapsed check is armed ONLY on flattened-ladder
// SCANS rungs.  Ladder-only preserves the manual opt-in's byte-identical
// contract (its high-level SCANS dispatch still runs the legacy schedule);
// SCANS-only avoids false-rejecting PANORAMA pan-back / stationary-hold
// captures whose coverage grows with span, not frame count.
TEST(CollapsedPlacement, ArmedOnlyOnLadderScansRungs) {
  EXPECT_TRUE(collapsedCheckArmed(true, StitchMode::Scans));
  EXPECT_FALSE(collapsedCheckArmed(true, StitchMode::Panorama));
  EXPECT_FALSE(collapsedCheckArmed(false, StitchMode::Scans));      // legacy path
  EXPECT_FALSE(collapsedCheckArmed(false, StitchMode::Panorama));
}

// 2026-08-17 review — terminal rung failures stop the ladder outright.
// UnknownCvException is load-bearing: it is the caught-native-OOM bucket,
// and the jetsam RCA's whole point was that relaunching a full stitch
// after an OOM re-peaks the process (the per-rung headroom re-gate reads a
// post-RAII-free rss and admits the relaunch, or runs uncapped when rss is
// unmeasurable).
TEST(LadderTerminal, OomBucketAndInputInvariantCodesAreTerminal) {
  EXPECT_TRUE(ladderErrorIsTerminal(StitchErrorCode::UnknownCvException));
  EXPECT_TRUE(ladderErrorIsTerminal(StitchErrorCode::InvalidArgument));
  EXPECT_TRUE(ladderErrorIsTerminal(StitchErrorCode::ImageReadFailed));
  EXPECT_TRUE(ladderErrorIsTerminal(StitchErrorCode::ImageWriteFailed));
  EXPECT_TRUE(ladderErrorIsTerminal(StitchErrorCode::PreStitchMemoryAbort));
}

TEST(LadderTerminal, RetryableCodesAreNotTerminal) {
  // These are the codes the ladder exists to rescue — a different
  // mode/threshold/warper can legitimately fix them.
  EXPECT_FALSE(ladderErrorIsTerminal(StitchErrorCode::NeedMoreImages));
  EXPECT_FALSE(ladderErrorIsTerminal(StitchErrorCode::HomographyEstimationFailed));
  EXPECT_FALSE(ladderErrorIsTerminal(StitchErrorCode::CameraParamsAdjustFailed));
  EXPECT_FALSE(ladderErrorIsTerminal(StitchErrorCode::WarpFailed));
  EXPECT_FALSE(ladderErrorIsTerminal(StitchErrorCode::EmptyPanorama));
  EXPECT_FALSE(ladderErrorIsTerminal(StitchErrorCode::LowQualityStitch));
  EXPECT_FALSE(ladderErrorIsTerminal(
      StitchErrorCode::AllFramesDroppedByConfidence));  // cannot-improve code
  EXPECT_FALSE(ladderErrorIsTerminal(StitchErrorCode::Ok));
}

// 2026-08-17 review — the dynamic spherical extra rung: at most one per
// ladder, PANORAMA rungs only, only for the two warper-fixable failure
// shapes, and never when the rung already composed with spherical.
TEST(SphericalExtraRung, WarrantedOnlyForFixablePanoramaFailures) {
  // The two trigger codes on a non-spherical PANORAMA rung.
  EXPECT_TRUE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::LowQualityStitch, false, false));
  EXPECT_TRUE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::WarpFailed, false, false));
  // Other failure codes never warrant it.
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::NeedMoreImages, false, false));
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::HomographyEstimationFailed,
      false, false));
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::UnknownCvException, false,
      false));
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::Ok, false, false));
}

TEST(SphericalExtraRung, NeverForScansAlreadySphericalOrSecondTime) {
  // SCANS hard-wires its affine warper — a spherical override is
  // meaningless there.
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Scans, StitchErrorCode::LowQualityStitch, false, false));
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Scans, StitchErrorCode::WarpFailed, false, false));
  // A rung that already ran spherical (extra rung, or caller-pinned
  // spherical warper) gains nothing from a spherical relaunch.
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::LowQualityStitch, true, false));
  // Hard cap: one spherical extra rung per ladder.
  EXPECT_FALSE(sphericalExtraRungWarranted(
      StitchMode::Panorama, StitchErrorCode::LowQualityStitch, false, true));
}

TEST(SphericalExtraRung, PlanGrowthIsBoundedByMaxRungs) {
  // The plan holds 4 planned rungs and at most ONE dynamic insertion.
  EXPECT_EQ(kMaxLadderRungs, kStitchLadderRungs + 1);
}

// 2026-08-17 review — N-1 short-circuit: an all-but-one partial promotes
// immediately (the dominant blur-tail shape); anything less keeps walking
// the ladder.
TEST(LadderShortCircuit, AllButOneFramePromotes) {
  EXPECT_TRUE(ladderRungAcceptable(10, 10));   // complete
  EXPECT_TRUE(ladderRungAcceptable(9, 10));    // N-1 — promote, stop ladder
  EXPECT_FALSE(ladderRungAcceptable(8, 10));   // 2+ dropped — keep trying
  EXPECT_TRUE(ladderRungAcceptable(1, 1));     // single-frame capture
  EXPECT_TRUE(ladderRungAcceptable(2, 3));
  // Degenerate zero-frame "success" never promotes, whatever N is.
  EXPECT_FALSE(ladderRungAcceptable(0, 1));
  EXPECT_FALSE(ladderRungAcceptable(0, 0));
}

// 2026-08-17 review — cannot-improve early-out feeds the impl's
// compose-skip: with a best of M frames banked, a rung retaining <= M can
// never win the strict-> tie rule, so its compose is pure waste.
TEST(LadderShortCircuit, CannotImproveBestSkipsCompose) {
  EXPECT_TRUE(rungCannotImproveBest(9, 9));    // tie — compose skipped
  EXPECT_TRUE(rungCannotImproveBest(8, 9));    // worse — compose skipped
  EXPECT_FALSE(rungCannotImproveBest(10, 9));  // improvement — compose runs
  // -1 sentinel = no best yet: never skip (rung 1 always composes).
  EXPECT_FALSE(rungCannotImproveBest(2, -1));
  EXPECT_FALSE(rungCannotImproveBest(0, -1));
}
