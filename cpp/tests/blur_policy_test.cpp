// SPDX-License-Identifier: Apache-2.0
//
// blur_policy_test.cpp — the anti-blur admission policy.
//
// The policy's contract is FAIL-OPEN: it may only ever hold a keyframe
// when it has positive evidence (a configured threshold AND a usable
// measurement). Every disabled knob, missing sensor, degenerate value
// or exhausted hold-budget must yield Commit. Most of these cases test
// exactly that, because a policy that can wedge a capture is far worse
// than one that admits a soft frame.

#include <gtest/gtest.h>

#include <cmath>

#include "blur_policy.hpp"

using retailens::admitKeyframe;
using retailens::BlurAdmission;
using retailens::BlurAdmissionInput;
using retailens::BlurPolicyConfig;
using retailens::RunningScoreMedian;

namespace {

/// Config with both checks live, so individual tests only vary inputs.
BlurPolicyConfig enabledConfig() {
    BlurPolicyConfig c;
    c.maxCommitPanRateRadPerSec = 1.0;
    c.minScoreFractionOfMedian  = 0.6;
    c.maxConsecutiveHolds       = 12;
    return c;
}

/// Input that would COMMIT under enabledConfig(): still device, score
/// comfortably above the floor.
BlurAdmissionInput goodInput() {
    BlurAdmissionInput in;
    in.candidateScore      = 100.0;
    in.sessionMedianScore  = 100.0;
    in.panRateRadPerSec    = 0.1;
    in.consecutiveHolds    = 0;
    return in;
}

}  // namespace

// ── Defaults are inert ──────────────────────────────────────────────

TEST(BlurPolicy, DefaultConfigNeverHolds) {
    // The default-constructed config has both thresholds at 0 =
    // disabled. This is what every existing host gets until it opts in,
    // so it must be byte-identical to "no policy at all" even for
    // inputs that would trip an enabled policy.
    const BlurPolicyConfig off;
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec   = 50.0;  // absurdly fast
    in.candidateScore     = 0.001; // absurdly soft
    in.sessionMedianScore = 1000.0;
    EXPECT_EQ(admitKeyframe(off, in), BlurAdmission::Commit);
}

// ── Motion gate ─────────────────────────────────────────────────────

TEST(BlurPolicy, HoldsWhenPanRateExceedsThreshold) {
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec = 1.5;  // > 1.0
    EXPECT_EQ(admitKeyframe(enabledConfig(), in),
              BlurAdmission::HoldForMotion);
}

TEST(BlurPolicy, CommitsExactlyAtThreshold) {
    // Strictly-greater comparison: a rate exactly AT the threshold is
    // acceptable. Prevents a boundary-jitter stall when the operator
    // holds a steady pace right on the limit.
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec = 1.0;
    EXPECT_EQ(admitKeyframe(enabledConfig(), in), BlurAdmission::Commit);
}

TEST(BlurPolicy, UnknownPanRateFailsOpen) {
    // No gyro / sensor unavailable is signalled by a negative rate.
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec = -1.0;
    EXPECT_EQ(admitKeyframe(enabledConfig(), in), BlurAdmission::Commit);
}

TEST(BlurPolicy, NonFinitePanRateFailsOpen) {
    // A degenerate sensor sample must not be able to block a capture.
    for (double bad : {std::nan(""),
                       std::numeric_limits<double>::infinity()}) {
        BlurAdmissionInput in = goodInput();
        in.panRateRadPerSec = bad;
        EXPECT_EQ(admitKeyframe(enabledConfig(), in),
                  BlurAdmission::Commit);
    }
}

TEST(BlurPolicy, ZeroThresholdDisablesMotionGate) {
    BlurPolicyConfig c = enabledConfig();
    c.maxCommitPanRateRadPerSec = 0.0;
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec = 99.0;
    EXPECT_EQ(admitKeyframe(c, in), BlurAdmission::Commit);
}

// ── Relative sharpness floor ────────────────────────────────────────

TEST(BlurPolicy, HoldsWhenScoreFarBelowSessionMedian) {
    BlurAdmissionInput in = goodInput();
    in.sessionMedianScore = 100.0;
    in.candidateScore     = 50.0;  // < 0.6 × 100
    EXPECT_EQ(admitKeyframe(enabledConfig(), in),
              BlurAdmission::HoldForSoftness);
}

TEST(BlurPolicy, CommitsAtTheFloor) {
    BlurAdmissionInput in = goodInput();
    in.sessionMedianScore = 100.0;
    in.candidateScore     = 60.0;  // exactly 0.6 × 100
    EXPECT_EQ(admitKeyframe(enabledConfig(), in), BlurAdmission::Commit);
}

TEST(BlurPolicy, FirstKeyframeHasNoMedianAndCommits) {
    // The first keyframe of a capture has no history to compare with
    // (median 0.0 = unknown). It must always go in, otherwise a capture
    // could never start.
    BlurAdmissionInput in = goodInput();
    in.sessionMedianScore = 0.0;
    in.candidateScore     = 0.0001;
    EXPECT_EQ(admitKeyframe(enabledConfig(), in), BlurAdmission::Commit);
}

TEST(BlurPolicy, UnknownCandidateScoreFailsOpen) {
    BlurAdmissionInput in = goodInput();
    in.candidateScore = 0.0;  // scoring unavailable
    EXPECT_EQ(admitKeyframe(enabledConfig(), in), BlurAdmission::Commit);
}

TEST(BlurPolicy, BlankWallScenarioDoesNotStall) {
    // A textureless scene scores ~0 for EVERY frame, so the median is
    // ~0 too. The ratio test must not read that as "anomalously soft" —
    // with a non-positive median the check is skipped entirely.
    BlurAdmissionInput in = goodInput();
    in.candidateScore     = 0.0;
    in.sessionMedianScore = 0.0;
    EXPECT_EQ(admitKeyframe(enabledConfig(), in), BlurAdmission::Commit);
}

// ── Precedence + forward progress ───────────────────────────────────

TEST(BlurPolicy, MotionOutranksSoftness) {
    // Both would fire; motion wins because it is the CAUSE and yields
    // the actionable "slow down" coaching.
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec   = 5.0;
    in.sessionMedianScore = 100.0;
    in.candidateScore     = 1.0;
    EXPECT_EQ(admitKeyframe(enabledConfig(), in),
              BlurAdmission::HoldForMotion);
}

TEST(BlurPolicy, HoldCapGuaranteesForwardProgress) {
    // The operator cannot steady (moving vehicle, tremor): after
    // maxConsecutiveHolds the frame is admitted regardless. Without
    // this a capture could hang forever.
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec = 99.0;
    in.consecutiveHolds = 12;  // == cap
    EXPECT_EQ(admitKeyframe(enabledConfig(), in), BlurAdmission::Commit);
}

TEST(BlurPolicy, BelowCapStillHolds) {
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec = 99.0;
    in.consecutiveHolds = 11;  // one short of the cap
    EXPECT_EQ(admitKeyframe(enabledConfig(), in),
              BlurAdmission::HoldForMotion);
}

TEST(BlurPolicy, ZeroCapMeansNoForwardProgressOverride) {
    // <= 0 disables the cap (documented as "no cap"), so a persistent
    // over-threshold motion keeps holding. Hosts opting into this take
    // responsibility for the drift guard / finalize drain ending it.
    BlurPolicyConfig c = enabledConfig();
    c.maxConsecutiveHolds = 0;
    BlurAdmissionInput in = goodInput();
    in.panRateRadPerSec = 99.0;
    in.consecutiveHolds = 1000;
    EXPECT_EQ(admitKeyframe(c, in), BlurAdmission::HoldForMotion);
}

// ── RunningScoreMedian ──────────────────────────────────────────────

TEST(RunningScoreMedian, EmptyReportsUnknown) {
    const RunningScoreMedian m;
    EXPECT_EQ(m.median(), 0.0);
    EXPECT_EQ(m.count(), 0);
}

TEST(RunningScoreMedian, OddAndEvenCounts) {
    RunningScoreMedian m(8);
    m.add(10.0);
    m.add(30.0);
    m.add(20.0);
    EXPECT_DOUBLE_EQ(m.median(), 20.0);  // odd → middle
    m.add(40.0);
    EXPECT_DOUBLE_EQ(m.median(), 25.0);  // even → mean of 20 and 30
}

TEST(RunningScoreMedian, IgnoresNonPositiveAndNonFinite) {
    // Zero/negative/NaN scores carry no information about the scene and
    // would drag the median toward zero, weakening the floor they feed.
    RunningScoreMedian m(8);
    m.add(100.0);
    m.add(0.0);
    m.add(-5.0);
    m.add(std::nan(""));
    EXPECT_EQ(m.count(), 1);
    EXPECT_DOUBLE_EQ(m.median(), 100.0);
}

TEST(RunningScoreMedian, RingEvictsOldestBeyondCapacity) {
    // Only the most recent `capacity` accepted scores define "typical":
    // a pano that moves from a dark aisle into a bright one must be
    // able to re-baseline.
    RunningScoreMedian m(3);
    m.add(1.0);
    m.add(2.0);
    m.add(3.0);
    EXPECT_DOUBLE_EQ(m.median(), 2.0);
    m.add(100.0);  // evicts 1.0 → {2,3,100}
    EXPECT_EQ(m.count(), 3);
    EXPECT_DOUBLE_EQ(m.median(), 3.0);
}

TEST(RunningScoreMedian, MedianResistsSingleOutlier) {
    // The reason this is a median and not a mean: one spectacular frame
    // must not raise the bar for everything that follows.
    RunningScoreMedian m(8);
    for (int i = 0; i < 5; ++i) m.add(100.0);
    m.add(100000.0);
    EXPECT_DOUBLE_EQ(m.median(), 100.0);
}

TEST(RunningScoreMedian, ResetClears) {
    RunningScoreMedian m(4);
    m.add(5.0);
    m.reset();
    EXPECT_EQ(m.count(), 0);
    EXPECT_EQ(m.median(), 0.0);
}

TEST(RunningScoreMedian, CapacityIsClamped) {
    // Degenerate capacities must not index out of the fixed buffer.
    RunningScoreMedian tiny(0);
    tiny.add(7.0);
    EXPECT_DOUBLE_EQ(tiny.median(), 7.0);

    RunningScoreMedian huge(9999);
    for (int i = 0; i < 100; ++i) huge.add(1.0 + i);
    EXPECT_GT(huge.median(), 0.0);
    EXPECT_LE(huge.count(), 32);
}
