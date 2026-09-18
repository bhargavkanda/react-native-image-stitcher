// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_attitude_test.cpp — host tests for the decoupled capture path's
// attitude seam (S2 of the 2026-08-30 decoupled-capture architecture).
//
// These land BEFORE either platform has a frame source, which is the design's
// single anti-duplication measure: the piece where an iOS and an Android
// implementation would silently diverge is written once and pinned once.
//
// The tests are organised around the FAILURE MODES named in the design, not
// around the methods:
//
//   PanoAttitudeBasis      — the 24 candidates, and the B-cancellation the
//                            whole "arbitrary yaw datum is irrelevant" claim
//                            rests on
//   PanoAttitudeRefusal    — every refusal, especially the extrapolation one
//   PanoAttitudeInterp     — SLERP vs the snap it replaces, in the currency of
//                            the operator's own budget
//   PanoAttitudeTau        — the sign, and the cost of getting it backwards
//   PanoAttitudeRing       — the buffer under wrap and out-of-order delivery
//   PanoAttitudeTracking   — derived, never hardcoded
//   PanoAttitudeLurch      — the cage that replaces one `t` can never fire
//   PanoAttitudeSelectBasis— S1: pick C from data, and MEASURE the drift term
//                            that can veto the whole architecture

#include "rnis_pano_attitude.hpp"

#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <string>
#include <vector>

using namespace rnis::pano;
namespace d = rnis::pano::detail;

namespace {

constexpr double kDeg = M_PI / 180.0;

// Unit quaternion for a rotation of `deg` about (ax, ay, az).
void axisAngle(double ax, double ay, double az, double deg, double q[4]) {
    const double n = std::sqrt(ax * ax + ay * ay + az * az);
    ax /= n; ay /= n; az /= n;
    const double h = 0.5 * deg * kDeg;
    const double s = std::sin(h);
    q[0] = ax * s; q[1] = ay * s; q[2] = az * s; q[3] = std::cos(h);
}

void quatMul(const double a[4], const double b[4], double o[4]) {
    o[3] = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
    o[0] = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
    o[1] = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
    o[2] = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
}

void quatConj(const double a[4], double o[4]) {
    o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; o[3] = a[3];
}

double det3(const double m[9]) {
    return m[0] * (m[4] * m[8] - m[5] * m[7])
         - m[1] * (m[3] * m[8] - m[5] * m[6])
         + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/// A constant-angular-rate series about a fixed axis, sampled at `hz` from
/// `t0`.  The ground truth is then closed-form at ANY instant, which is what
/// lets the interpolation tests assert an absolute error rather than a
/// self-consistency.
std::vector<AttitudeSample> constantRate(double t0, double hz, int n,
                                         double degPerS,
                                         double ax = 0, double ay = 1, double az = 0) {
    std::vector<AttitudeSample> v;
    v.reserve(n);
    for (int i = 0; i < n; ++i) {
        AttitudeSample s;
        s.tS = t0 + (double)i / hz;
        axisAngle(ax, ay, az, degPerS * (s.tS - t0), s.q);
        v.push_back(s);
    }
    return v;
}

AttitudeAligner::Config usableCfg(double tauS = 0.0, int basis = 0) {
    AttitudeAligner::Config c;
    c.tauS = tauS;
    c.tauMeasured = true;
    c.basisIndex = basis;
    return c;
}

}  // namespace

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeBasis
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeBasis, ThereAreExactlyTwentyFourAndEveryOneIsARotation) {
    // 48 signed permutations exist; the 24 with determinant −1 are
    // REFLECTIONS.  Shipping one would mirror the canvas, and a mirrored
    // canvas of a shelf is not obviously wrong to the eye.
    ASSERT_EQ(24, basisCandidateCount());
    for (int i = 0; i < 24; ++i) {
        double m[9];
        ASSERT_TRUE(basisMatrix(i, m)) << "index " << i;
        EXPECT_NEAR(+1.0, det3(m), 1e-12) << "index " << i << " is not a rotation";
        // Orthonormal columns.
        for (int c1 = 0; c1 < 3; ++c1)
            for (int c2 = 0; c2 < 3; ++c2) {
                double dp = 0;
                for (int r = 0; r < 3; ++r) dp += m[r * 3 + c1] * m[r * 3 + c2];
                EXPECT_NEAR(c1 == c2 ? 1.0 : 0.0, dp, 1e-12);
            }
    }
}

TEST(PanoAttitudeBasis, IndexZeroIsTheIdentityAndTheLabelsAreStableAndUnique) {
    double m[9];
    ASSERT_TRUE(basisMatrix(0, m));
    const double id[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    for (int i = 0; i < 9; ++i) EXPECT_DOUBLE_EQ(id[i], m[i]);
    // The label is what a bug report will actually carry; a bare integer is
    // unreadable and a reordered enumeration would silently re-point every
    // index already written into a pack.
    EXPECT_STREQ("+x+y+z", basisLabel(0));

    std::vector<std::string> seen;
    for (int i = 0; i < 24; ++i) {
        const std::string s = basisLabel(i);
        EXPECT_EQ(6u, s.size()) << i;
        for (const std::string& t : seen) EXPECT_NE(t, s);
        seen.push_back(s);
    }
}

TEST(PanoAttitudeBasis, OutOfRangeIsRefusedNotClamped) {
    double m[9] = {9, 9, 9, 9, 9, 9, 9, 9, 9};
    EXPECT_FALSE(basisMatrix(-1, m));
    EXPECT_FALSE(basisMatrix(24, m));
    for (int i = 0; i < 9; ++i) EXPECT_DOUBLE_EQ(9.0, m[i]) << "m was touched";
    EXPECT_STREQ("invalid", basisLabel(-1));
    EXPECT_STREQ("invalid", basisLabel(24));
}

TEST(PanoAttitudeBasis, MatQuatRoundTripsOnEveryCandidateIncludingThe180DegOnes) {
    // Several candidates are exact 180° rotations, which is precisely where a
    // trace-only mat→quat loses all its significant figures.
    for (int i = 0; i < 24; ++i) {
        double m[9], q[4], back[9];
        ASSERT_TRUE(basisMatrix(i, m));
        d::matToQuat(m, q);
        d::quatToMat(q, back);
        for (int k = 0; k < 9; ++k)
            EXPECT_NEAR(m[k], back[k], 1e-12) << "candidate " << i << " element " << k;
    }
}

TEST(PanoAttitudeBasis, TheReferenceFrameCancelsExactlyWhichIsWhyTheYawDatumDoesNotMatter) {
    // THE STRUCTURAL CLAIM OF THE WHOLE ARCHITECTURE.
    //
    //   R_world←cam = B · R_ref←dev · C   and   dR = R₀ᵀ Rᵢ
    //   ⇒ (B R₀ C)ᵀ (B Rᵢ C) = Cᵀ (R₀ᵀ Rᵢ) C
    //
    // So `.xArbitraryZVertical`'s arbitrary yaw datum (and Android's
    // GAME_ROTATION_VECTOR's) cannot reach the geometry.  Tested by feeding
    // the SAME motion through two aligners whose sample streams differ by an
    // arbitrary fixed left-multiplication, and asserting the RELATIVE
    // rotations they hand the engine are bit-comparable.
    const std::vector<AttitudeSample> imu = constantRate(100.0, 200.0, 60, 30.0, 0.3, 0.9, -0.2);

    double B[4];
    axisAngle(0.2, -0.7, 0.4, 137.0, B);   // deliberately not small, not axis-aligned

    for (int basis : {0, 5, 13, 23}) {
        AttitudeAligner a(usableCfg(0.0, basis));
        AttitudeAligner b(usableCfg(0.0, basis));
        for (const AttitudeSample& s : imu) {
            a.push(s);
            AttitudeSample r = s;
            quatMul(B, s.q, r.q);          // B · R_ref←dev
            b.push(r);
        }
        AlignedAttitude a0 = a.align(100.02), b0 = b.align(100.02);
        ASSERT_TRUE(a0.ok); ASSERT_TRUE(b0.ok);
        for (double t = 100.03; t < 100.28; t += 0.017) {
            AlignedAttitude ai = a.align(t), bi = b.align(t);
            ASSERT_TRUE(ai.ok) << t;
            ASSERT_TRUE(bi.ok) << t;
            // relative rotation each aligner would hand the engine
            double ca[4], cb[4], da[4], db[4];
            quatConj(a0.q, ca); quatMul(ca, ai.q, da);
            quatConj(b0.q, cb); quatMul(cb, bi.q, db);
            EXPECT_NEAR(0.0, d::quatDeltaDeg(da, db), 1e-10)
                << "basis " << basis << " t " << t;
        }
    }
}

TEST(PanoAttitudeBasis, TheBasisIsAppliedOnTheRightWhichIsNotTheSameAsOnTheLeft) {
    // A right-multiplication is a change of the DEVICE→CAMERA frame; a
    // left-multiplication is a change of the reference frame and cancels.  Get
    // them backwards and the engine receives a rotation about the wrong axis
    // — which reads as a plausible sweep in the wrong direction, not as a
    // crash.  Pinned against the closed form.
    double q[4];
    axisAngle(0, 1, 0, 40.0, q);
    AttitudeAligner al(usableCfg(0.0, 7));
    al.push(10.0, q);
    al.push(10.005, q);
    AlignedAttitude a = al.align(10.002);
    ASSERT_TRUE(a.ok);

    double C[9], R[9], want[9], got[9];
    ASSERT_TRUE(basisMatrix(7, C));
    d::quatToMat(q, R);
    d::matMul(R, C, want);            // R · C, the correct order
    d::quatToMat(a.q, got);
    for (int i = 0; i < 9; ++i) EXPECT_NEAR(want[i], got[i], 1e-12) << i;

    double wrong[9];
    d::matMul(C, R, wrong);           // C · R — and it IS different
    double diff = 0;
    for (int i = 0; i < 9; ++i) diff += std::fabs(wrong[i] - want[i]);
    EXPECT_GT(diff, 1e-3) << "candidate 7 commutes; pick another for this test";
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeRefusal
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeRefusal, NoMeasuredTauMeansTheArmDoesNotSweepEvenWithPerfectData) {
    AttitudeAligner::Config c;
    c.tauMeasured = false;            // the shipped default
    c.basisIndex = 0;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);

    EXPECT_FALSE(al.configurationIsUsable());
    AlignedAttitude a = al.alignAndCount(0.10, std::nan(""));
    EXPECT_FALSE(a.ok);
    EXPECT_EQ(AlignRefusal::TauNotMeasured, a.refusal);
    EXPECT_TRUE(refusalIsFatal(a.refusal));
    EXPECT_EQ(0, a.tracking);
    EXPECT_EQ(1, al.counters().refusedTau);
}

TEST(PanoAttitudeRefusal, AnUnvalidatedBasisIsNeverShipped) {
    AttitudeAligner::Config c;
    c.tauMeasured = true;
    c.basisIndex = -1;                // the shipped default
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);
    EXPECT_FALSE(al.configurationIsUsable());
    AlignedAttitude a = al.alignAndCount(0.10, std::nan(""));
    EXPECT_EQ(AlignRefusal::BasisNotValidated, a.refusal);
    EXPECT_TRUE(refusalIsFatal(a.refusal));
    EXPECT_EQ(1, al.counters().refusedBasis);
}

TEST(PanoAttitudeRefusal, TheConfigurationRefusalsOutrankEverythingElse) {
    // Ordering matters: a build with no τ must report "no τ", not "buffer
    // empty" — the second reads as a start-up transient somebody waits out.
    AttitudeAligner::Config c;
    c.tauMeasured = false;
    c.basisIndex = -1;
    AttitudeAligner al(c);            // empty buffer AND both faults
    EXPECT_EQ(AlignRefusal::TauNotMeasured, al.align(std::nan("")).refusal);
}

TEST(PanoAttitudeRefusal, ExtrapolationIsRefusedNotPerformed) {
    // THE ONE UNBOUNDED ERROR TERM.  The IMU is behind by an amount set by
    // scheduling, not by physics, so "just extend the last sample" has no
    // bound on how wrong it can be.
    AttitudeAligner al(usableCfg());
    std::vector<AttitudeSample> imu = constantRate(50.0, 200.0, 20, 45.0);
    for (const AttitudeSample& s : imu) al.push(s);
    const double newest = imu.back().tS;

    AlignedAttitude in = al.alignAndCount(newest - 1e-6, std::nan(""));
    EXPECT_TRUE(in.ok);

    AlignedAttitude out = al.alignAndCount(newest + 1e-3, std::nan(""));
    EXPECT_FALSE(out.ok);
    EXPECT_EQ(AlignRefusal::AfterLastSample, out.refusal);
    EXPECT_FALSE(refusalIsFatal(out.refusal));   // one frame, not the sweep
    EXPECT_EQ(0, out.tracking);
    EXPECT_EQ(1, al.counters().refusedAfter);

    // Exactly ON the last sample is INSIDE, not outside — an off-by-one here
    // would refuse one frame in every burst for no reason.
    EXPECT_TRUE(al.align(newest).ok);
}

TEST(PanoAttitudeRefusal, BeforeTheOldestRetainedSampleIsAlsoRefused) {
    AttitudeAligner al(usableCfg());
    for (const AttitudeSample& s : constantRate(50.0, 200.0, 20, 45.0)) al.push(s);
    AlignedAttitude a = al.alignAndCount(49.9, std::nan(""));
    EXPECT_EQ(AlignRefusal::BeforeFirstSample, a.refusal);
    EXPECT_EQ(1, al.counters().refusedBefore);
    EXPECT_TRUE(al.align(50.0).ok);
}

TEST(PanoAttitudeRefusal, AnEmptyBufferAndANonFinitePtsAreDistinguished) {
    AttitudeAligner al(usableCfg());
    EXPECT_EQ(AlignRefusal::BufferEmpty, al.alignAndCount(1.0, std::nan("")).refusal);
    double q[4] = {0, 0, 0, 1};
    al.push(1.0, q);
    al.push(1.01, q);
    EXPECT_EQ(AlignRefusal::NonFiniteInput,
              al.alignAndCount(std::nan(""), std::nan("")).refusal);
    EXPECT_EQ(AlignRefusal::NonFiniteInput,
              al.alignAndCount(std::numeric_limits<double>::infinity(), std::nan("")).refusal);
    EXPECT_EQ(1, al.counters().refusedEmpty);
    EXPECT_EQ(2, al.counters().refusedNonFinite);
}

TEST(PanoAttitudeRefusal, TheNamesAreStableBecauseAnOfflineHarnessGrepsThem) {
    EXPECT_STREQ("none",                refusalName(AlignRefusal::None));
    EXPECT_STREQ("tau-not-measured",    refusalName(AlignRefusal::TauNotMeasured));
    EXPECT_STREQ("basis-not-validated", refusalName(AlignRefusal::BasisNotValidated));
    EXPECT_STREQ("buffer-empty",        refusalName(AlignRefusal::BufferEmpty));
    EXPECT_STREQ("before-first-sample", refusalName(AlignRefusal::BeforeFirstSample));
    EXPECT_STREQ("after-last-sample",   refusalName(AlignRefusal::AfterLastSample));
    EXPECT_STREQ("non-finite-input",    refusalName(AlignRefusal::NonFiniteInput));
    EXPECT_STREQ("lurch",               refusalName(AlignRefusal::Lurch));
    EXPECT_STREQ("tau-mode-conflict",   refusalName(AlignRefusal::TauModeConflict));
    EXPECT_TRUE(refusalIsFatal(AlignRefusal::TauNotMeasured));
    EXPECT_TRUE(refusalIsFatal(AlignRefusal::BasisNotValidated));
    EXPECT_TRUE(refusalIsFatal(AlignRefusal::TauModeConflict));
    EXPECT_FALSE(refusalIsFatal(AlignRefusal::AfterLastSample));
    EXPECT_FALSE(refusalIsFatal(AlignRefusal::Lurch));
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeInterp
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeInterp, SlerpHitsTheClosedFormAtEveryFractionNotJustTheMidpoint) {
    double q0[4], q1[4];
    axisAngle(0, 0, 1, 0.0, q0);
    axisAngle(0, 0, 1, 84.0, q1);
    for (double a = 0.0; a <= 1.0001; a += 0.05) {
        double got[4], want[4];
        d::slerp(q0, q1, a, got);
        axisAngle(0, 0, 1, 84.0 * a, want);
        EXPECT_NEAR(0.0, d::quatDeltaDeg(got, want), 1e-11) << "alpha " << a;
    }
}

TEST(PanoAttitudeInterp, SlerpTakesTheShortWayAcrossAnAntipodalRepresentation) {
    // `q` and `−q` are the SAME rotation.  A sensor is free to hand back
    // either, and without the shortest-path flip the interpolation crosses
    // ~340° inside a 20° bracket — still a unit quaternion, still no error,
    // just a canvas with a spin in it.
    double q0[4], q1[4];
    axisAngle(0, 1, 0, 0.0, q0);
    axisAngle(0, 1, 0, 20.0, q1);
    double neg[4] = {-q1[0], -q1[1], -q1[2], -q1[3]};
    double mid[4], midNeg[4];
    d::slerp(q0, q1, 0.5, mid);
    d::slerp(q0, neg, 0.5, midNeg);
    EXPECT_NEAR(10.0, d::quatAngleDeg(mid), 1e-11);
    EXPECT_NEAR(0.0, d::quatDeltaDeg(mid, midNeg), 1e-11);
}

TEST(PanoAttitudeInterp, DegenerateAndIdenticalBracketsDoNotDivideByZero) {
    double q[4];
    axisAngle(1, 0, 0, 12.0, q);
    double out[4];
    d::slerp(q, q, 0.37, out);
    EXPECT_NEAR(0.0, d::quatDeltaDeg(q, out), 1e-12);

    // A bracket where both samples carry the same attitude: alpha is
    // well-defined but the rotation is zero-width.
    AttitudeAligner al(usableCfg());
    al.push(3.0, q);
    al.push(3.005, q);
    AlignedAttitude a = al.align(3.002);
    ASSERT_TRUE(a.ok);
    EXPECT_NEAR(0.0, a.slerpAngleDeg, 1e-12);
    EXPECT_NEAR(0.0, d::quatDeltaDeg(q, a.q), 1e-12);   // basis 0 = identity
}

TEST(PanoAttitudeInterp, TheSnapItReplacesCostsFourTimesTheWholeErrorBudget) {
    // The design's rule-2 in the currency it is written in.  Configuration:
    // 60 fps frames against a 200 Hz IMU, at 30 °/s — an unhurried shelf
    // sweep.  The budget is 3.08–3.91 ms at p95 for the whole 0.50 px band
    // gate, i.e. ~0.117 deg at this rate (11.7 canvas px/deg ⇒ 0.043 deg for
    // 0.50 px; use the ms budget directly here).
    //
    // A nearest-sample snap is bounded by HALF an IMU period = 2.5 ms at
    // 200 Hz, and averages ~1.25 ms — a third to four fifths of the entire
    // p95 budget, spent on nothing.  SLERP against a constant rate is exact.
    const double hz = 200.0, rate = 30.0;
    std::vector<AttitudeSample> imu = constantRate(0.0, hz, 400, rate);
    AttitudeAligner al(usableCfg());
    for (const AttitudeSample& s : imu) al.push(s);

    double worstSlerpDeg = 0.0, worstSnapDeg = 0.0;
    int n = 0;
    for (double pts = 0.30; pts < 1.20; pts += 1.0 / 60.0) {
        AlignedAttitude a = al.align(pts);
        ASSERT_TRUE(a.ok) << pts;
        double truth[4];
        axisAngle(0, 1, 0, rate * pts, truth);
        worstSlerpDeg = std::max(worstSlerpDeg, d::quatDeltaDeg(a.q, truth));

        // What a nearest-sample snap would have produced.
        const double k = std::round(pts * hz);
        double snapped[4];
        axisAngle(0, 1, 0, rate * (k / hz), snapped);
        worstSnapDeg = std::max(worstSnapDeg, d::quatDeltaDeg(snapped, truth));
        ++n;
    }
    ASSERT_GT(n, 40);
    EXPECT_LT(worstSlerpDeg, 1e-9) << "SLERP is exact against a constant rate";
    // Half a period at 30 °/s = 0.075 deg.  Assert the snap really is that bad
    // rather than asserting only that ours is good — the comparison is the
    // point.
    EXPECT_GT(worstSnapDeg, 0.05);
    EXPECT_GT(worstSnapDeg / std::max(worstSlerpDeg, 1e-15), 1e6);
}

TEST(PanoAttitudeInterp, TheBracketChosenIsTheTightestOneAvailable) {
    AttitudeAligner al(usableCfg());
    std::vector<AttitudeSample> imu = constantRate(20.0, 100.0, 50, 10.0);
    for (const AttitudeSample& s : imu) al.push(s);
    for (double pts = 20.005; pts < 20.48; pts += 0.0031) {
        AlignedAttitude a = al.align(pts);
        ASSERT_TRUE(a.ok) << pts;
        EXPECT_NEAR(0.01, a.bracketGapS, 1e-9);
        EXPECT_GE(a.alpha, 0.0);
        EXPECT_LE(a.alpha, 1.0);
        EXPECT_NEAR(pts, a.targetS, 1e-12);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeTau
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeTau, PositiveTauSamplesAheadOfThePresentationTimestamp) {
    const double rate = 40.0, tau = 0.004;
    AttitudeAligner al(usableCfg(tau));
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 400, rate)) al.push(s);
    AlignedAttitude a = al.align(0.500);
    ASSERT_TRUE(a.ok);
    EXPECT_NEAR(0.504, a.targetS, 1e-12);
    double want[4];
    axisAngle(0, 1, 0, rate * 0.504, want);
    EXPECT_NEAR(0.0, d::quatDeltaDeg(a.q, want), 1e-9);
}

TEST(PanoAttitudeTau, AppliedBackwardsTheOffsetDoublesTheErrorItWasMeantToRemove) {
    // Stated in the header and worth pinning, because a sign error here is
    // invisible: both builds produce a canvas, and the wrong one is merely
    // slightly worse in a way the operator would attribute to the sweep.
    const double rate = 40.0, tau = 0.004;
    AttitudeAligner good(usableCfg(+tau));
    AttitudeAligner bad(usableCfg(-tau));
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 400, rate)) {
        good.push(s);
        bad.push(s);
    }
    double truth[4];
    axisAngle(0, 1, 0, rate * 0.504, truth);   // the instant the frame recorded

    AlignedAttitude g = good.align(0.500), b = bad.align(0.500);
    ASSERT_TRUE(g.ok); ASSERT_TRUE(b.ok);
    const double eGood = d::quatDeltaDeg(g.q, truth);
    const double eBad  = d::quatDeltaDeg(b.q, truth);
    EXPECT_LT(eGood, 1e-9);
    // Uncorrected would be rate·τ = 0.16°; backwards is 2·rate·τ = 0.32°.
    EXPECT_NEAR(2.0 * rate * tau, eBad, 1e-6);
}

TEST(PanoAttitudeTau, TauShiftsTheCoverageWindowSoTheRefusalsMoveWithIt) {
    // A positive τ eats into the newest end of the buffer: frames whose
    // pts+τ has not been sampled yet are refused, which is exactly the
    // condition the source's HOLD exists for.
    std::vector<AttitudeSample> imu = constantRate(10.0, 200.0, 20, 10.0);
    const double newest = imu.back().tS;
    AttitudeAligner al(usableCfg(0.010));
    for (const AttitudeSample& s : imu) al.push(s);
    EXPECT_TRUE(al.align(newest - 0.010).ok);
    EXPECT_EQ(AlignRefusal::AfterLastSample, al.align(newest - 0.009).refusal);
    EXPECT_NEAR(newest, al.newestSampleS(), 1e-12);
    EXPECT_NEAR(imu.front().tS, al.oldestSampleS(), 1e-12);
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeRing
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeRing, OutOfOrderAndDuplicateSamplesAreDroppedAndCounted) {
    // The bracket search is a binary search, and a binary search over an
    // unsorted array does not fail loudly — it returns a plausible neighbour.
    AttitudeAligner al(usableCfg());
    double q[4] = {0, 0, 0, 1};
    al.push(1.000, q);
    al.push(1.005, q);
    al.push(1.005, q);      // duplicate ⇒ zero-width bracket ⇒ dropped
    al.push(1.002, q);      // backwards ⇒ dropped
    al.push(1.010, q);
    EXPECT_EQ(3u, al.size());
    EXPECT_EQ(3, al.counters().pushed);
    EXPECT_EQ(2, al.counters().droppedNonMonotonic);
}

TEST(PanoAttitudeRing, NonFiniteSamplesNeverEnterTheBuffer) {
    AttitudeAligner al(usableCfg());
    double bad[4] = {0, 0, std::nan(""), 1};
    double ok[4] = {0, 0, 0, 1};
    al.push(std::nan(""), ok);
    al.push(1.0, bad);
    al.push(std::numeric_limits<double>::infinity(), ok);
    EXPECT_EQ(0u, al.size());
    EXPECT_EQ(3, al.counters().droppedNonFinite);
}

TEST(PanoAttitudeRing, WrapAroundKeepsOrderingAndTheBracketSearchStillWorks) {
    AttitudeAligner::Config c = usableCfg();
    c.capacity = 16;
    AttitudeAligner al(c);
    std::vector<AttitudeSample> imu = constantRate(0.0, 100.0, 200, 25.0);
    for (const AttitudeSample& s : imu) al.push(s);
    EXPECT_EQ(16u, al.size());
    EXPECT_NEAR(imu.back().tS, al.newestSampleS(), 1e-12);
    EXPECT_NEAR(imu[imu.size() - 16].tS, al.oldestSampleS(), 1e-12);

    // Everything older than the retained window is refused, not silently
    // clamped onto the oldest survivor.
    EXPECT_EQ(AlignRefusal::BeforeFirstSample, al.align(imu[0].tS).refusal);

    for (double pts = al.oldestSampleS(); pts <= al.newestSampleS(); pts += 0.0017) {
        AlignedAttitude a = al.align(pts);
        ASSERT_TRUE(a.ok) << pts;
        double want[4];
        axisAngle(0, 1, 0, 25.0 * pts, want);
        EXPECT_NEAR(0.0, d::quatDeltaDeg(a.q, want), 1e-9) << pts;
    }
}

TEST(PanoAttitudeRing, ADegenerateCapacityIsRaisedNotHonoured) {
    AttitudeAligner::Config c = usableCfg();
    c.capacity = 0;                 // a 0-slot ring would divide by zero
    AttitudeAligner al(c);
    double q[4] = {0, 0, 0, 1};
    al.push(1.0, q);
    al.push(1.01, q);
    EXPECT_EQ(2u, al.size());
    EXPECT_TRUE(al.align(1.005).ok);
}

TEST(PanoAttitudeRing, TheConstAlignIsPureSoATauSweepDoesNotPolluteThePack) {
    AttitudeAligner al(usableCfg());
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);
    const int64_t pushed = al.counters().pushed;
    for (int i = 0; i < 50; ++i) (void)al.align(0.25);
    EXPECT_EQ(0, al.counters().aligned);
    EXPECT_EQ(0, al.counters().accepted);
    EXPECT_EQ(pushed, al.counters().pushed);

    AlignedAttitude a = al.align(0.25), b = al.align(0.25);
    for (int k = 0; k < 4; ++k) EXPECT_DOUBLE_EQ(a.q[k], b.q[k]);
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeTracking
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeTracking, NormalMeansABracketWasFoundAndItWasTight) {
    AttitudeAligner al(usableCfg());
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);
    AlignedAttitude a = al.alignAndCount(0.25, std::nan(""));
    EXPECT_TRUE(a.ok);
    EXPECT_EQ(2, a.tracking);
    EXPECT_EQ(1, al.counters().acceptedNormal);
    EXPECT_EQ(0, al.counters().acceptedLimited);
}

TEST(PanoAttitudeTracking, ASensorHoleDegradesToLimitedInsteadOfBeingAveragedOver) {
    // Derived, never hardcoded: a hole in the IMU is a REAL condition the engine's ladder should
    // see.  Interpolating across 120 ms and calling it `normal` would hide it.
    AttitudeAligner::Config c = usableCfg();
    c.maxBracketGapS = 0.025;
    AttitudeAligner al(c);
    double q0[4], q1[4];
    axisAngle(0, 1, 0, 0.0, q0);
    axisAngle(0, 1, 0, 14.0, q1);
    al.push(5.000, q0);
    al.push(5.120, q1);              // 120 ms hole
    AlignedAttitude a = al.alignAndCount(5.060, std::nan(""));
    EXPECT_TRUE(a.ok);
    EXPECT_EQ(1, a.tracking) << "a 120 ms bracket must not report `normal`";
    EXPECT_NEAR(0.120, a.bracketGapS, 1e-12);
    EXPECT_EQ(1, al.counters().acceptedLimited);
    EXPECT_NEAR(0.120, al.counters().maxBracketGapS, 1e-12);
}

TEST(PanoAttitudeTracking, EveryRefusalReportsNotAvailableAndNeverNormal) {
    AttitudeAligner al(usableCfg());
    EXPECT_EQ(0, al.align(1.0).tracking);              // empty
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 10, 20.0)) al.push(s);
    EXPECT_EQ(0, al.align(-1.0).tracking);             // before
    EXPECT_EQ(0, al.align(99.0).tracking);             // after
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeLurch
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeLurch, AnUnconfiguredCageIsCountedAsUnconfiguredNotAsPassed) {
    // The whole point of derive-never-hardcode.  With `t ≡ 0` the engine's `rejectedPoseSpeed`
    // reads 0 and a reader concludes the cage passed.  It did not run.
    AttitudeAligner al(usableCfg());                   // lurchAccelMps2 == 0
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);
    AlignedAttitude a = al.alignAndCount(0.25, 900.0); // absurd acceleration
    EXPECT_TRUE(a.ok) << "an unconfigured cage must not fire";
    EXPECT_FALSE(a.lurchEvaluated);
    EXPECT_EQ(1, al.counters().lurchNotConfigured);
    EXPECT_EQ(0, al.counters().lurchEvaluated);
    EXPECT_EQ(0, al.counters().refusedLurch);
}

TEST(PanoAttitudeLurch, AConfiguredCageWithNoAccelerationAbstainsAndSaysSo) {
    AttitudeAligner::Config c = usableCfg();
    c.lurchAccelMps2 = 25.0;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);
    AlignedAttitude a = al.alignAndCount(0.25, std::nan(""));
    EXPECT_TRUE(a.ok);
    EXPECT_FALSE(a.lurchEvaluated);
    EXPECT_EQ(1, al.counters().lurchNotEvaluated);
    EXPECT_EQ(0, al.counters().lurchEvaluated);
}

// ── 2026-08-31: THE CAGE'S LEDGER MUST COUNT THE CAGE, NOT THE ARGUMENTS ──
//
// The cage sits AFTER the bracket search.  Every frame that refused upstream
// of it — and `after-last-sample` is the COMMON runtime refusal on the
// decoupled arm, because the IMU is routinely a sample behind the camera —
// never reached the cage at all.  Counting from `alignAndCount`'s arguments
// tallied all of them as EVALUATED, so a pack could read
// `evaluatedFrames: 1200, refusals.lurch: 0` and be read as "the cage examined
// 1200 frames and passed them" when it had examined none.

TEST(PanoAttitudeLurch, AFrameRefusedBeforeTheCageIsNotCountedAsEvaluated) {
    AttitudeAligner::Config c = usableCfg();
    c.lurchAccelMps2 = 25.0;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);

    // Past the newest sample: the extrapolation refusal, which returns long
    // before the cage.  The acceleration is finite AND over the threshold, so
    // the old argument-driven tally would have counted it as evaluated-and-
    // passed (it never even fired the cage).
    const AlignedAttitude a = al.alignAndCount(99.0, 900.0);
    EXPECT_FALSE(a.ok);
    EXPECT_EQ(AlignRefusal::AfterLastSample, a.refusal);
    EXPECT_FALSE(a.lurchEvaluated);

    EXPECT_EQ(0, al.counters().lurchEvaluated) << "the cage never saw this frame";
    EXPECT_EQ(1, al.counters().lurchNotReached);
    EXPECT_EQ(0, al.counters().lurchNotEvaluated);
    EXPECT_EQ(0, al.counters().lurchNotConfigured);
    EXPECT_EQ(0, al.counters().refusedLurch);
}

TEST(PanoAttitudeLurch, TheFourLedgerStatesPartitionEveryAlignedFrame) {
    AttitudeAligner::Config c = usableCfg();
    c.lurchAccelMps2 = 25.0;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);

    al.alignAndCount(0.25, 10.0);            // reached the cage, passed
    al.alignAndCount(0.26, std::nan(""));    // reached the cage, no accel
    al.alignAndCount(99.0, 10.0);            // refused upstream
    al.alignAndCount(0.27, 900.0);           // reached the cage, refused

    const AlignerCounters& k = al.counters();
    EXPECT_EQ(4, k.aligned);
    EXPECT_EQ(2, k.lurchEvaluated);      // the pass and the lurch refusal
    EXPECT_EQ(1, k.lurchNotEvaluated);
    EXPECT_EQ(1, k.lurchNotReached);
    EXPECT_EQ(0, k.lurchNotConfigured);
    EXPECT_EQ(k.aligned, k.lurchEvaluated + k.lurchNotEvaluated
                       + k.lurchNotReached + k.lurchNotConfigured)
        << "the four states must partition the aligned frames exactly";
}

// ── THE UNCAGED SWEEP IS THE EVIDENCE THAT TUNES THE FIRST CAGED ONE ──────
//
// `maxLurchAccelMps2` used to update only inside the configured branch, which
// made the threshold unknowable by construction: it can only be chosen from
// the distribution, and the distribution was recorded only once the cage was
// already armed with an untuned number.  The arm ships UNCAGED, so this is the
// field's only route to a real threshold.

TEST(PanoAttitudeLurch, AnUncagedSweepStillRecordsTheAccelerationItSaw) {
    AttitudeAligner al(usableCfg());                   // lurchAccelMps2 == 0
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);

    al.alignAndCount(0.25, 3.0);
    al.alignAndCount(0.26, 11.5);
    al.alignAndCount(0.27, std::nan(""));
    al.alignAndCount(0.28, 7.25);

    EXPECT_EQ(4, al.counters().lurchNotConfigured);
    EXPECT_EQ(0, al.counters().lurchEvaluated);
    EXPECT_EQ(3, al.counters().accelSamples) << "the denominator, not just the max";
    EXPECT_NEAR(11.5, al.counters().maxLurchAccelMps2, 1e-12);
}

TEST(PanoAttitudeLurch, TheAccelerationLedgerIsIndependentOfWhetherTheFrameAligned) {
    // A frame refused upstream of the cage still CARRIED an acceleration, and
    // that reading is exactly as valid a sample of the operator's hand as one
    // from a frame that painted.  Dropping it would bias the distribution the
    // threshold is chosen from towards the quiet frames.
    AttitudeAligner al(usableCfg());
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);
    al.alignAndCount(99.0, 42.0);   // after-last-sample
    EXPECT_EQ(1, al.counters().accelSamples);
    EXPECT_NEAR(42.0, al.counters().maxLurchAccelMps2, 1e-12);
}

TEST(PanoAttitudeLurch, OverThresholdHoldsTheChainTheWayThePoseCageUsedTo) {
    AttitudeAligner::Config c = usableCfg();
    c.lurchAccelMps2 = 25.0;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);

    AlignedAttitude ok = al.alignAndCount(0.25, 24.9);
    EXPECT_TRUE(ok.ok);
    EXPECT_TRUE(ok.lurchEvaluated);
    EXPECT_EQ(2, ok.tracking);

    AlignedAttitude bad = al.alignAndCount(0.26, 25.1);
    EXPECT_FALSE(bad.ok);
    EXPECT_EQ(AlignRefusal::Lurch, bad.refusal);
    // notAvailable, so the engine's OWN hold/abort ladder runs on it and the
    // frame still gets a ledger row — a silent drop would leave no trace.
    EXPECT_EQ(0, bad.tracking);
    EXPECT_EQ(1, al.counters().refusedLurch);
    EXPECT_EQ(2, al.counters().lurchEvaluated);
    EXPECT_NEAR(25.1, al.counters().maxLurchAccelMps2, 1e-12);
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeSelectBasis  (S1 — and the term that can veto S3)
// ═══════════════════════════════════════════════════════════════════════════

namespace {

/// Build a REFERENCE series (think: ARKit) from an IMU series through a known
/// basis `C` and an arbitrary reference-frame rotation `B`, optionally
/// injecting a constant gyro bias about `biasAxis`.
std::vector<AttitudeSample> referenceFrom(const std::vector<AttitudeSample>& imu,
                                          int basisIndex,
                                          const double B[4],
                                          double biasDegPerS,
                                          double refHz) {
    double C[9], qC[4];
    basisMatrix(basisIndex, C);
    d::matToQuat(C, qC);

    std::vector<AttitudeSample> ref;
    const double t0 = imu.front().tS, t1 = imu.back().tS;

    // One identity-basis aligner supplies the IMU truth at arbitrary instants,
    // so the fixture is built with the SAME interpolation the code under test
    // uses rather than with a second, subtly different one.
    AttitudeAligner::Config c;
    c.tauMeasured = true; c.basisIndex = 0; c.capacity = imu.size() + 2;
    c.maxBracketGapS = 1e9;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : imu) al.push(s);

    for (double t = t0 + 0.05; t < t1 - 0.05; t += 1.0 / refHz) {
        AlignedAttitude a = al.align(t);
        if (!a.ok) continue;

        double eng[4], tmp[4];
        quatMul(a.q, qC, tmp);       // R_imu · C
        quatMul(B, tmp, eng);        // B · R_imu · C

        if (biasDegPerS != 0.0) {
            // The IMU is the one that drifts, not the reference — so the
            // reference is the CLEAN series and the IMU carries the bias.
            // Model it the other way round here by rotating the reference
            // BACKWARDS by the accumulated bias, which is the same residual.
            double bias[4], biased[4];
            axisAngle(0, 0, 1, -biasDegPerS * (t - t0), bias);
            quatMul(eng, bias, biased);
            for (int k = 0; k < 4; ++k) eng[k] = biased[k];
        }
        AttitudeSample s;
        s.tS = t;
        for (int k = 0; k < 4; ++k) s.q[k] = eng[k];
        ref.push_back(s);
    }
    return ref;
}

}  // namespace

TEST(PanoAttitudeSelectBasis, TheDataPicksTheBasisAndTheWinnerIsUnambiguous) {
    // A GENERIC rotation axis — see the degeneracy test below for why a pure
    // pan is the one thing that must NOT be used for this.
    const std::vector<AttitudeSample> imu =
        constantRate(0.0, 200.0, 2000, 25.0, 0.4, 0.8, 0.45);
    double B[4];
    axisAngle(0.1, 0.2, -0.9, 61.0, B);
    for (int truth : {0, 3, 11, 19, 23}) {
        const std::vector<AttitudeSample> ref = referenceFrom(imu, truth, B, 0.0, 30.0);
        ASSERT_GT(ref.size(), 100u);
        BasisSelection sel = selectBasis(imu, ref, 0.0);
        ASSERT_STREQ("ok", sel.refusal);
        ASSERT_TRUE(sel.unique);
        ASSERT_FALSE(sel.ranked.empty());
        EXPECT_EQ(truth, sel.ranked[0].index) << "wanted " << basisLabel(truth)
                                              << " got " << sel.ranked[0].label;
        EXPECT_LT(sel.ranked[0].rmsDeg, 1e-9);
        EXPECT_STREQ(basisLabel(truth), sel.ranked[0].label);
        // The runner-up is far enough away that the choice is not a coin-flip
        // the operator has to adjudicate.
        ASSERT_GE(sel.ranked.size(), 2u);
        EXPECT_GT(sel.ranked[1].rmsDeg, 1.0);
        EXPECT_GT(sel.marginDeg, 1.0);
    }
}

TEST(PanoAttitudeSelectBasis, APurePanCannotIdentifyCAndTheToolSaysSoInsteadOfGuessing) {
    // FOUND BY THIS TEST, NOT PREDICTED.  `C` is recovered from
    // `dR ↦ Cᵀ·dR·C`.  When every rotation in the log is about one axis `n`,
    // any two candidates agreeing on `Cᵀn` give IDENTICAL residuals — so a
    // careful single-axis pan, which is exactly what a disciplined operator
    // would capture, leaves an exact 4-way tie and the sort's tie-break would
    // hand back a plausible index chosen by enumeration order.
    //
    // This is why the design's "a minute of HAND-WAVING" is load-bearing and
    // not a figure of speech.
    const std::vector<AttitudeSample> pan =
        constantRate(0.0, 200.0, 2000, 25.0, 0, 1, 0);   // pure y
    double B[4] = {0, 0, 0, 1};
    const std::vector<AttitudeSample> ref = referenceFrom(pan, 2, B, 0.0, 30.0);

    BasisSelection sel = selectBasis(pan, ref, 0.0);
    EXPECT_FALSE(sel.unique);
    EXPECT_STREQ("ambiguous-axis", sel.refusal);
    // The evidence is still handed back, because SEEING the tie is what tells
    // the operator to re-capture rather than to re-run the same log.
    ASSERT_GE(sel.ranked.size(), 4u);
    int tied = 0;
    for (const BasisFit& f : sel.ranked)
        if (f.rmsDeg < sel.ranked[0].rmsDeg + 1e-6) ++tied;
    EXPECT_EQ(4, tied) << "a one-axis log fixes exactly one column of C";

    // And the same motion with a second axis in it is decided immediately.
    const std::vector<AttitudeSample> waved =
        constantRate(0.0, 200.0, 2000, 25.0, 0.4, 0.8, 0.45);
    BasisSelection ok = selectBasis(waved, referenceFrom(waved, 2, B, 0.0, 30.0), 0.0);
    EXPECT_TRUE(ok.unique);
    EXPECT_STREQ("ok", ok.refusal);
    EXPECT_EQ(2, ok.ranked[0].index);
}

TEST(PanoAttitudeSelectBasis, TheDriftTermIsRecoveredBecauseItIsTheOneThatCanVetoS3) {
    // ARKit corrects gyro bias against the image every frame; CoreMotion does
    // not.  At 11.7 canvas px/deg a 0.01 °/s in-run bias costs ≈ 0.94 canvas
    // px over an 8 s sweep — the same order as the 0.68–0.85 px jog these
    // packs already fail integrity on.  If this is measurable from the S1 log
    // then S1 really can gate S3; if it is not, the gate is decorative.
    const std::vector<AttitudeSample> imu =
        constantRate(0.0, 200.0, 2000, 25.0, 0.4, 0.8, 0.45);
    double B[4];
    axisAngle(0.1, 0.2, -0.9, 61.0, B);
    for (double bias : {0.01, 0.05, 0.2}) {
        const std::vector<AttitudeSample> ref = referenceFrom(imu, 5, B, bias, 30.0);
        BasisSelection sel = selectBasis(imu, ref, 0.0);
        ASSERT_STREQ("ok", sel.refusal) << "bias " << bias;
        ASSERT_TRUE(sel.unique);
        const BasisFit& f = sel.ranked[0];
        EXPECT_EQ(5, f.index);
        EXPECT_NEAR(bias, f.driftDegPerS, bias * 0.05)
            << "bias " << bias << " recovered as " << f.driftDegPerS;

        // A body-frame bias detrends ALMOST to nothing — not exactly, and the
        // residue is real rather than numerical: the bias enters as a
        // right-multiplication that the device's own (large) rotation
        // conjugates, so the residual angle is only approximately linear in
        // time.  Asserting exact zero here would be asserting a physics that
        // is not true.  What IS true is that the ramp dominates:
        EXPECT_LT(f.rmsDetrendedDeg, 0.05 * f.rmsDeg)
            << "bias " << bias << " rms " << f.rmsDeg
            << " detrended " << f.rmsDetrendedDeg;
        EXPECT_GT(f.rmsDeg, f.rmsDetrendedDeg);
        EXPECT_GT(f.finalDeg, 0.0);
    }
}

TEST(PanoAttitudeSelectBasis, AStationaryPhoneAndAShortLogAreRefusedNotFitted) {
    // Every candidate reproduces the identity perfectly on a phone that never
    // moved, so the "winner" would be enumeration order — a plausible number
    // with no information in it.
    std::vector<AttitudeSample> still = constantRate(0.0, 200.0, 400, 0.0);
    std::vector<AttitudeSample> stillRef = constantRate(0.0, 30.0, 60, 0.0);
    BasisSelection s1 = selectBasis(still, stillRef, 0.0);
    EXPECT_TRUE(s1.ranked.empty());
    EXPECT_STREQ("stationary", s1.refusal);

    std::vector<AttitudeSample> imu = constantRate(0.0, 200.0, 400, 25.0, 0.4, 0.8, 0.45);
    std::vector<AttitudeSample> tiny(imu.begin(), imu.begin() + 2);

    // A 2-sample REFERENCE cannot span 3 pairs at all.
    EXPECT_STREQ("too-few-samples", selectBasis(imu, tiny, 0.0).refusal);
    // A 2-sample IMU is a DIFFERENT failure and reports as one: the reference
    // is long, but only the 5 ms the IMU covers can be bracketed, so the fit
    // starves on pairs.  Keeping the two apart is what makes the refusal
    // actionable — one says "log for longer", the other says "the IMU stopped".
    EXPECT_STREQ("too-few-pairs", selectBasis(tiny, imu, 0.0).refusal);
    EXPECT_TRUE(selectBasis(tiny, imu, 0.0).ranked.empty());
    EXPECT_STREQ("too-few-samples", selectBasis(imu, imu, std::nan("")).refusal);
}

TEST(PanoAttitudeSelectBasis, PairsItCannotBracketAreSkippedNeverExtrapolated) {
    const std::vector<AttitudeSample> imu =
        constantRate(10.0, 200.0, 400, 25.0, 0.4, 0.8, 0.45);
    double B[4] = {0, 0, 0, 1};
    std::vector<AttitudeSample> ref = referenceFrom(imu, 2, B, 0.0, 30.0);
    const std::size_t good = ref.size();
    // Append reference samples an hour past the end of the IMU log.  An
    // extrapolating implementation would fold a 3590-second lever arm into
    // the fit; a refusing one drops them.
    for (int i = 0; i < 20; ++i) {
        AttitudeSample s = ref.back();
        s.tS = 3600.0 + i;
        ref.push_back(s);
    }
    BasisSelection sel = selectBasis(imu, ref, 0.0);
    ASSERT_STREQ("ok", sel.refusal);
    EXPECT_EQ(2, sel.ranked[0].index);
    EXPECT_LT(sel.ranked[0].rmsDeg, 1e-9) << "an extrapolated pair would blow this up";
    EXPECT_LE(sel.ranked[0].pairs, (int)good);
    EXPECT_NEAR(0.0, sel.ranked[0].driftDegPerS, 1e-9);
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeTauUncorrected — THE DELIBERATE τ = 0 SWEEP (2026-08-31)
//
// WHY THIS EXISTS, in the operator's own numbers: twelve τ calibration runs on
// the device produced 4 outright failures and 8 resolutions scattered over
// 5.03 ms — wider than the 3.08 ms the correction is meant to buy back — so
// the persist gate refused to write a τ, which is the gate working.  The panel
// also showed the RAW lag on the resolved runs mostly INSIDE the budget, so
// the open question is whether τ binds at all, and the experiment that answers
// it is a sweep with NO timing correction.
//
// THE RULE THESE TESTS PIN: a pack must never claim a calibration it does not
// have.  `tauS = 0, tauMeasured = true` would have run the experiment today
// and is exactly the forbidden shape, so the uncorrected state is carried in
// its own field, reported through its own three-valued provenance, and
// claiming BOTH is a fatal refusal with its own name.
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeTauUncorrected, TheThreeProvenanceStatesAreDistinctAndNoneIsABoolean) {
    // NOT MEASURED — the shipped default, and it must not have moved.
    {
        AttitudeAligner::Config c;
        c.basisIndex = 0;
        AttitudeAligner al(c);
        EXPECT_EQ(TauProvenance::NotMeasured, al.tauProvenance());
        EXPECT_STREQ("not-measured", tauProvenanceName(al.tauProvenance()));
        EXPECT_FALSE(al.configurationIsUsable());
        EXPECT_STREQ("", al.tauConflictReason());
    }
    // MEASURED.
    {
        AttitudeAligner::Config c;
        c.tauMeasured = true;
        c.tauS = 0.0029;            // the operator's own 3-run agreement
        c.basisIndex = 8;
        AttitudeAligner al(c);
        EXPECT_EQ(TauProvenance::Measured, al.tauProvenance());
        EXPECT_STREQ("measured", tauProvenanceName(al.tauProvenance()));
        EXPECT_TRUE(al.configurationIsUsable());
    }
    // UNCORRECTED — a THIRD state, not "measured with a zero".
    {
        AttitudeAligner::Config c;
        c.tauUncorrected = true;
        c.tauS = 0.0;
        c.basisIndex = 8;
        AttitudeAligner al(c);
        EXPECT_EQ(TauProvenance::Uncorrected, al.tauProvenance());
        EXPECT_STREQ("uncorrected", tauProvenanceName(al.tauProvenance()));
        EXPECT_TRUE(al.configurationIsUsable());
        // AND THE FIELD THAT WOULD LIE IS STILL FALSE.  This is the whole
        // point: a reader asking "was τ measured?" must get NO from a sweep
        // that measured nothing, whatever else the pack says about it.
        EXPECT_FALSE(al.config().tauMeasured);
    }
    // Every name is distinct — a pack that cannot distinguish them is a pack
    // that cannot be read.
    EXPECT_STRNE(tauProvenanceName(TauProvenance::Measured),
                 tauProvenanceName(TauProvenance::Uncorrected));
    EXPECT_STRNE(tauProvenanceName(TauProvenance::NotMeasured),
                 tauProvenanceName(TauProvenance::Uncorrected));
    EXPECT_STRNE(tauProvenanceName(TauProvenance::Conflict),
                 tauProvenanceName(TauProvenance::Uncorrected));
}

TEST(PanoAttitudeTauUncorrected, AnUncorrectedSweepAlignsAndSamplesExactlyAtThePts) {
    AttitudeAligner::Config c;
    c.tauUncorrected = true;
    c.basisIndex = 0;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 200, 20.0)) al.push(s);

    const AlignedAttitude a = al.alignAndCount(0.30, std::nan(""));
    ASSERT_TRUE(a.ok);
    EXPECT_EQ(AlignRefusal::None, a.refusal);
    EXPECT_EQ(2, a.tracking);
    // τ = 0 means the target instant IS the presentation timestamp — no offset
    // is applied, which is the experiment.
    EXPECT_DOUBLE_EQ(0.30, a.targetS);
    EXPECT_EQ(1, al.counters().accepted);
    EXPECT_EQ(0, al.counters().refusedTau);
    EXPECT_EQ(0, al.counters().refusedTauConflict);
}

TEST(PanoAttitudeTauUncorrected, TheUncorrectedAnswerReallyDiffersFromTheCorrectedOne) {
    // If this were not true the experiment would be untestable: an uncorrected
    // sweep has to be capable of producing DIFFERENT pixels from a corrected
    // one, or "does τ bind?" cannot be answered by running it.
    //
    // 20 °/s and the operator's 2.89 ms candidate τ ⇒ 0.058° of rotation, and
    // at the design's 11.7 canvas px per degree that is 0.68 canvas px — the
    // same order as the jog these packs already fail integrity on.
    const std::vector<AttitudeSample> imu = constantRate(0.0, 200.0, 400, 20.0);

    AttitudeAligner::Config unc;
    unc.tauUncorrected = true;
    unc.basisIndex = 0;
    AttitudeAligner a0(unc);

    AttitudeAligner::Config cor;
    cor.tauMeasured = true;
    cor.tauS = 0.00289;
    cor.basisIndex = 0;
    AttitudeAligner a1(cor);

    for (const AttitudeSample& s : imu) { a0.push(s); a1.push(s); }

    const AlignedAttitude r0 = a0.align(0.50);
    const AlignedAttitude r1 = a1.align(0.50);
    ASSERT_TRUE(r0.ok);
    ASSERT_TRUE(r1.ok);
    const double sepDeg = d::quatDeltaDeg(r0.q, r1.q);
    EXPECT_NEAR(20.0 * 0.00289, sepDeg, 1e-6);
    EXPECT_GT(sepDeg, 0.0);
    // And the two are labelled differently, so a pack can never confuse them.
    EXPECT_EQ(TauProvenance::Uncorrected, a0.tauProvenance());
    EXPECT_EQ(TauProvenance::Measured,    a1.tauProvenance());
}

TEST(PanoAttitudeTauUncorrected, ClaimingMeasuredAndUncorrectedIsAFatalRefusalOfItsOwn) {
    // THE FORBIDDEN SHAPE, refused at the seam rather than trusted to a
    // convention one layer up.  A run that says it both measured τ and applied
    // none has no honest pack, so it does not start.
    AttitudeAligner::Config c;
    c.tauMeasured = true;
    c.tauUncorrected = true;
    c.tauS = 0.0;
    c.basisIndex = 8;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);

    EXPECT_EQ(TauProvenance::Conflict, al.tauProvenance());
    EXPECT_STREQ("measured-and-uncorrected", al.tauConflictReason());
    EXPECT_FALSE(al.configurationIsUsable());

    const AlignedAttitude a = al.alignAndCount(0.10, std::nan(""));
    EXPECT_FALSE(a.ok);
    EXPECT_EQ(AlignRefusal::TauModeConflict, a.refusal);
    EXPECT_TRUE(refusalIsFatal(a.refusal));
    EXPECT_EQ(0, a.tracking);
    EXPECT_EQ(1, al.counters().refusedTauConflict);
    // NOT counted as "no measured τ": that refusal tells an operator to go and
    // run a calibration, which is the wrong instruction for this fault.
    EXPECT_EQ(0, al.counters().refusedTau);
}

TEST(PanoAttitudeTauUncorrected, UncorrectedWithANonZeroTauIsRefusedNotSilentlyZeroed) {
    // The other shape of the same lie: a sweep that calls itself uncorrected
    // while a correction is applied.  Zeroing it here would be the silent fix
    // that makes the two states indistinguishable again.
    AttitudeAligner::Config c;
    c.tauUncorrected = true;
    c.tauS = 0.00289;
    c.basisIndex = 8;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);

    EXPECT_EQ(TauProvenance::Conflict, al.tauProvenance());
    EXPECT_STREQ("uncorrected-with-nonzero-tau", al.tauConflictReason());
    EXPECT_FALSE(al.configurationIsUsable());
    EXPECT_EQ(AlignRefusal::TauModeConflict, al.align(0.10).refusal);
    // The τ it was handed is UNCHANGED — nothing overwrote the caller's number
    // on the way to refusing it.
    EXPECT_DOUBLE_EQ(0.00289, al.config().tauS);
}

TEST(PanoAttitudeTauUncorrected, TheOriginalGateIsNotWeakenedByTheNewState) {
    // THE REGRESSION THIS FEATURE COULD HAVE CAUSED.  "No τ, and nothing said
    // about it" must still refuse every frame exactly as it did before — the
    // uncorrected arm is an ADDED admissible state, never a relaxed gate.
    AttitudeAligner::Config c;
    c.tauMeasured = false;
    c.tauUncorrected = false;       // the shipped default, spelled out
    c.basisIndex = 0;
    AttitudeAligner al(c);
    for (const AttitudeSample& s : constantRate(0.0, 200.0, 100, 20.0)) al.push(s);
    EXPECT_FALSE(al.configurationIsUsable());
    EXPECT_EQ(AlignRefusal::TauNotMeasured, al.alignAndCount(0.10, std::nan("")).refusal);
    EXPECT_EQ(1, al.counters().refusedTau);

    // And an uncorrected sweep still needs the BASIS.  It is a different
    // number with a different scope, it really was measured (0.234° over 777
    // pairs on this device), and skipping it would rotate the whole canvas.
    AttitudeAligner::Config u;
    u.tauUncorrected = true;
    u.basisIndex = -1;
    AttitudeAligner al2(u);
    EXPECT_FALSE(al2.configurationIsUsable());
    EXPECT_EQ(AlignRefusal::BasisNotValidated, al2.align(0.10).refusal);
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeTauSource — THE STORE-OVERRIDE RULE
//
// The host keeps a calibration store on disk so a calibrated device does not
// re-measure before every sweep, and its natural behaviour is to FILL IN
// whatever the caller omitted.  That is right for a normal sweep and fatal for
// this one: an uncorrected experiment whose τ was quietly supplied from disk is
// NOT the experiment, and nothing in the pack would say so.
//
// The rule lives in the shared C++ rather than in the iOS bridge because
// Android will have its own store and would otherwise re-derive it.
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeTauSource, AnExplicitUncorrectedRequestOutranksAStoredTau) {
    // THE CLAUSE THAT MATTERS.  A calibrated phone (a τ on disk for this exact
    // format) asked for an uncorrected sweep gets an UNCORRECTED sweep.
    EXPECT_EQ(TauSource::Uncorrected,
              resolveTauSource(/*uncorrected=*/true, /*options=*/false, /*store=*/true));
    // Even with BOTH a stored τ and a caller-supplied one.
    EXPECT_EQ(TauSource::Uncorrected,
              resolveTauSource(true, true, true));
    EXPECT_EQ(TauSource::Uncorrected,
              resolveTauSource(true, false, false));
}

TEST(PanoAttitudeTauSource, WithoutAnUncorrectedRequestThePrecedenceIsUnchanged) {
    // OPTIONS WIN OVER THE STORE — a caller that passed τ explicitly is running
    // a deliberate experiment, and overriding it from disk would make that
    // experiment unreproducible.
    EXPECT_EQ(TauSource::Options, resolveTauSource(false, true, true));
    EXPECT_EQ(TauSource::Options, resolveTauSource(false, true, false));
    EXPECT_EQ(TauSource::Store,   resolveTauSource(false, false, true));
    // Nothing anywhere: the arm must refuse to start, which is what `None`
    // tells the host — never a zero it could mistake for a measurement.
    EXPECT_EQ(TauSource::None,    resolveTauSource(false, false, false));
}

TEST(PanoAttitudeTauSource, TheNamesAreStableBecauseTheyRideThePack) {
    EXPECT_STREQ("none",        tauSourceName(TauSource::None));
    EXPECT_STREQ("options",     tauSourceName(TauSource::Options));
    EXPECT_STREQ("store",       tauSourceName(TauSource::Store));
    EXPECT_STREQ("uncorrected", tauSourceName(TauSource::Uncorrected));
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeTauOptions — WHEN THE HOST MAY NOT FORCE THE ZERO (2026-08-31)
//
// The host forces `tauS = 0, tauMeasured = false` on an uncorrected sweep, and
// that forcing is right — it is the experiment, stated.  It is WRONG the
// moment the caller's own bag says something else, because then the forcing is
// no longer "declaring the experiment", it is picking one of two claims the
// caller made and dropping the other where nobody will see it.
//
// The review that found this named two shapes the previous cut swallowed:
//   · `tauUncorrected` + `tauMeasured: true` with NO `tauS` — the host's own
//     "claims measured" test required a finite τ, so this fell through to the
//     forcing branch;
//   · `tauUncorrected` + an explicit non-zero `tauS` with NO `tauMeasured` —
//     the caller's number was silently discarded under a doctrine that
//     elsewhere says OPTIONS WIN.
//
// Both packs would have been TRUTHFUL, which is why this is a rule about the
// caller's claim rather than about the pack — and why it belongs in the shared
// C++, where the Android bridge will read the same one.
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeTauOptions, TheHostMayForceTheZeroOnlyWhenNothingContradictsIt) {
    // NOT the experiment: this predicate has no opinion about a calibrated
    // sweep, whatever else is in the bag.  The pinned zero here is what makes
    // the calibrated path byte-for-byte unchanged.
    EXPECT_EQ(TauOptionConflict::None,
              inspectUncorrectedOptions(/*uncorrected=*/false, /*claim=*/true,
                                        /*haveTau=*/true, 0.00289));

    // ── SHAPE 1: the claim, WITH OR WITHOUT a number behind it ──────────
    // The `haveTau=false` line is the one the previous cut swallowed.
    EXPECT_EQ(TauOptionConflict::MeasuredClaim,
              inspectUncorrectedOptions(true, true, false, 0.0));
    EXPECT_EQ(TauOptionConflict::MeasuredClaim,
              inspectUncorrectedOptions(true, true, true, 0.00289));
    EXPECT_EQ(TauOptionConflict::MeasuredClaim,
              inspectUncorrectedOptions(true, true, true, 0.0));

    // ── SHAPE 2: an explicit τ that is not zero, with no claim beside it ──
    // Also swallowed before: the number was overwritten with 0 and nothing
    // recorded that a caller had asked for something else.
    EXPECT_EQ(TauOptionConflict::ExplicitNonZero,
              inspectUncorrectedOptions(true, false, true, 0.00289));
    EXPECT_EQ(TauOptionConflict::ExplicitNonZero,
              inspectUncorrectedOptions(true, false, true, -0.004));
    // NaN is NOT zero.  `!(x == 0.0)` is load-bearing: `x != 0.0` is false for
    // a NaN and would have let garbage through as "the experiment".
    EXPECT_EQ(TauOptionConflict::ExplicitNonZero,
              inspectUncorrectedOptions(true, false, true, std::nan("")));
    EXPECT_EQ(TauOptionConflict::ExplicitNonZero,
              inspectUncorrectedOptions(true, false, true,
                                        std::numeric_limits<double>::infinity()));

    // ── AND THE SHAPES THAT ARE SIMPLY THE EXPERIMENT ──────────────────
    // The operator's actual sweep: `tauUncorrected` alone, nothing else.
    EXPECT_EQ(TauOptionConflict::None,
              inspectUncorrectedOptions(true, false, false, 0.0));
    // An explicit zero agrees with the request; agreeing is not conflicting.
    EXPECT_EQ(TauOptionConflict::None,
              inspectUncorrectedOptions(true, false, true, 0.0));
    EXPECT_EQ(TauOptionConflict::None,
              inspectUncorrectedOptions(true, false, true, -0.0));
}

TEST(PanoAttitudeTauOptions, EveryShapeItFlagsIsAShapeTheAlignerItselfRefuses) {
    // THE CROSS-CHECK, and it is the point of the test file.  A host predicate
    // that flagged a shape the aligner tolerates would stall a legal sweep for
    // no reason; one that MISSED a shape the aligner refuses would leave the
    // host quietly rewriting a bag it was supposed to forward.  Neither is
    // visible by reading the two rules side by side, so they are executed
    // against each other instead.
    struct Case { bool claim; bool haveTau; double tau; const char* what; };
    const Case cases[] = {
        {true,  false, 0.0,             "claim, no number"},
        {true,  true,  0.00289,         "claim and number"},
        {false, true,  0.00289,         "number, no claim"},
        {false, true,  std::nan(""),    "NaN number"},
        {false, false, 0.0,             "the experiment, bare"},
        {false, true,  0.0,             "the experiment, explicit zero"},
    };
    // BOTH DIRECTIONS.  "flagged ⇒ the aligner refuses it" is only half the
    // guarantee and is satisfied vacuously by a predicate that flags nothing —
    // which is exactly the defect being fixed, since a MISSED shape is one the
    // aligner cannot see (the caller's dropped claim never reaches it).  So the
    // count is pinned too: four of these six contradict, two are the experiment.
    int flagged = 0;
    for (const Case& k : cases) {
        if (inspectUncorrectedOptions(true, k.claim, k.haveTau, k.tau)
            != TauOptionConflict::None) ++flagged;
    }
    EXPECT_EQ(4, flagged);

    for (const Case& k : cases) {
        const TauOptionConflict verdict =
            inspectUncorrectedOptions(true, k.claim, k.haveTau, k.tau);

        AttitudeAligner::Config c;
        c.basisIndex     = 0;
        c.tauUncorrected = true;
        if (verdict == TauOptionConflict::None) {
            // What the host is ALLOWED to send: the forced zero, stated.
            c.tauMeasured = false;
            c.tauS        = 0.0;
            AttitudeAligner al(c);
            EXPECT_TRUE(al.configurationIsUsable()) << k.what;
            EXPECT_EQ(TauProvenance::Uncorrected, al.tauProvenance()) << k.what;
        } else {
            // The bag EXACTLY as it arrived — which is what the host must
            // forward when this predicate names a shape.
            c.tauMeasured = k.claim;
            c.tauS        = k.haveTau ? k.tau : 0.0;
            AttitudeAligner al(c);
            EXPECT_FALSE(al.configurationIsUsable())
                << k.what << " / " << tauOptionConflictName(verdict);
            EXPECT_EQ(TauProvenance::Conflict, al.tauProvenance()) << k.what;
            EXPECT_EQ(AlignRefusal::TauModeConflict,
                      al.align(0.10).refusal) << k.what;
        }
    }
}

TEST(PanoAttitudeTauOptions, TheNamesAreStableBecauseTheyRideTheRefusalMessage) {
    EXPECT_STREQ("none",                 tauOptionConflictName(TauOptionConflict::None));
    EXPECT_STREQ("measured-claim",       tauOptionConflictName(TauOptionConflict::MeasuredClaim));
    EXPECT_STREQ("explicit-nonzero-tau", tauOptionConflictName(TauOptionConflict::ExplicitNonZero));
}

// ═══════════════════════════════════════════════════════════════════════════
// PanoAttitudeBasisProvenance — THE OTHER HALF, DERIVED AND NOT ASSERTED
//
// The τ = 0 pack records `basisProvenance: "measured"`, and it is TRUE: the
// basis really was selected from 777 pairs at 0.234° against a 19.45° runner-up
// and survived every offset in ±10 ms.  It was also, until this cut, an
// UNCONDITIONAL STRING LITERAL sitting one key away from `basisSource`, which
// the bridge can set to `"options"` — so a caller-supplied basis would have
// been certified by a pack as a calibration this build never ran.  That is the
// same defect class the τ side of this file exists to prevent, committed on the
// other number.
// ═══════════════════════════════════════════════════════════════════════════

TEST(PanoAttitudeBasisProvenance, AStoredBasisIsMeasuredAndACallerSuppliedOneIsNot) {
    // The device's own validated store — the real sweep, and the only route
    // that earns the word.
    EXPECT_EQ(BasisProvenance::Measured,       basisProvenanceForSource("store"));
    // Handed in.  This build measured NOTHING; the pack must not say it did.
    EXPECT_EQ(BasisProvenance::CallerSupplied, basisProvenanceForSource("options"));
    // Nothing at all.  Unreachable in a pack (a −1 index is a fatal refusal),
    // reported honestly rather than collapsed into one of the other two.
    EXPECT_EQ(BasisProvenance::NotMeasured,    basisProvenanceForSource("none"));
}

TEST(PanoAttitudeBasisProvenance, AnUnrecognisedSourceIsNeverFlatteredIntoMeasured) {
    EXPECT_EQ(BasisProvenance::NotMeasured, basisProvenanceForSource(""));
    EXPECT_EQ(BasisProvenance::NotMeasured, basisProvenanceForSource(nullptr));
    // Case matters, and that is deliberate: a near-miss read generously is
    // exactly how `measured` gets claimed by accident.
    EXPECT_EQ(BasisProvenance::NotMeasured, basisProvenanceForSource("Store"));
    EXPECT_EQ(BasisProvenance::NotMeasured, basisProvenanceForSource("store "));
    EXPECT_EQ(BasisProvenance::NotMeasured, basisProvenanceForSource("from-store"));
    EXPECT_EQ(BasisProvenance::NotMeasured, basisProvenanceForSource("whatever"));
}

TEST(PanoAttitudeBasisProvenance, TheNamesAreStableBecauseTheyRideThePack) {
    EXPECT_STREQ("not-measured",    basisProvenanceName(BasisProvenance::NotMeasured));
    EXPECT_STREQ("measured",        basisProvenanceName(BasisProvenance::Measured));
    EXPECT_STREQ("caller-supplied", basisProvenanceName(BasisProvenance::CallerSupplied));
}
