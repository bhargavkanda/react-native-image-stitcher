// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_calib_test.cpp — host tests for the calibration step.
//
// Every fixture here is SYNTHETIC and EXACT: the truth basis is chosen, the
// motion is generated from a closed-form attitude function, and the reference
// series is built as `R(t)·C_truth` — so a correct implementation returns the
// index it was given, at a residual of round-off, and a wrong one cannot be
// rescued by a lenient tolerance.
//
// The two tests that matter most are the ones that make the file worth having:
//
//   * `APureP anIsRefusedWithAnActionableReason` — the prototype's own defect,
//     turned into a regression test. A one-axis log must come back
//     "excitation-insufficient", NOT a plausible index.
//   * `ALargeButRepeatableTauIsAcceptedNotRejected` — the category error. τ is
//     graded on its UNCERTAINTY, never on its magnitude; a −11 ms offset
//     measured to ±0.2 ms is a good calibration and must be persisted.

#include <cmath>
#include <cstdio>
#include <limits>
#include <vector>

#include "gtest/gtest.h"

#include "rnis_pano_calib.hpp"

using rnis::pano::AttitudeSample;
using rnis::pano::AxisExcitation;
using rnis::pano::BasisPolicy;
using rnis::pano::BasisSelection;
using rnis::pano::BasisVerdict;
using rnis::pano::ExcitationPolicy;
using rnis::pano::ExcitationVerdict;
using rnis::pano::TauFit;
using rnis::pano::TauPolicy;
using rnis::pano::TauRun;

namespace {

constexpr double kDeg = M_PI / 180.0;

void axisQuat(int axis, double deg, double q[4]) {
    const double h = 0.5 * deg * kDeg;
    q[0] = q[1] = q[2] = 0.0;
    q[3] = std::cos(h);
    q[axis] = std::sin(h);
}

void quatMul(const double a[4], const double b[4], double o[4]) {
    o[3] = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
    o[0] = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
    o[1] = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
    o[2] = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
}

/// Closed-form attitude: Rz(c·sin ω₃t) · Ry(a·sin ω₁t) · Rx(b·sin ω₂t).
/// Amplitudes in degrees; any of them may be zero to make the motion
/// degenerate on purpose.
struct Motion {
    double aPanDeg = 0, bTiltDeg = 0, cRollDeg = 0;
    double w1 = 2.1, w2 = 3.3, w3 = 1.4;

    void at(double t, double q[4]) const {
        double qz[4], qy[4], qx[4], t1[4];
        axisQuat(2, cRollDeg * std::sin(w3 * t), qz);
        axisQuat(1, aPanDeg * std::sin(w1 * t), qy);
        axisQuat(0, bTiltDeg * std::sin(w2 * t), qx);
        quatMul(qz, qy, t1);
        quatMul(t1, qx, q);
    }
};

std::vector<AttitudeSample> sampleMotion(const Motion& m, double t0, double t1,
                                         double hz) {
    std::vector<AttitudeSample> out;
    const double dt = 1.0 / hz;
    for (double t = t0; t <= t1 + 1e-12; t += dt) {
        AttitudeSample s;
        s.tS = t;
        m.at(t, s.q);
        out.push_back(s);
    }
    return out;
}

/// The reference series: the SAME physical motion, seen through the truth
/// basis. `ref = imu · C` — exactly the relation `align()` inverts.
std::vector<AttitudeSample> referenceThrough(const Motion& m, int basisIndex,
                                             double t0, double t1, double hz,
                                             double biasDegPerS = 0.0) {
    double C[9];
    EXPECT_TRUE(rnis::pano::basisMatrix(basisIndex, C));
    std::vector<AttitudeSample> out;
    const double dt = 1.0 / hz;
    for (double t = t0; t <= t1 + 1e-12; t += dt) {
        double q[4];
        m.at(t, q);
        // An in-run gyro bias lives in the DEVICE body frame, so it enters as a
        // right-multiplication on the IMU side. Here the reference is the
        // truth, so the equivalent is to REMOVE it from the reference — the
        // residual grows linearly either way, which is what the drift fit sees.
        if (biasDegPerS != 0.0) {
            double bq[4], t2[4];
            axisQuat(2, -biasDegPerS * (t - t0), bq);
            quatMul(q, bq, t2);
            for (int k = 0; k < 4; ++k) q[k] = t2[k];
        }
        double Rq[9], Rout[9];
        rnis::pano::detail::quatToMat(q, Rq);
        rnis::pano::detail::matMul(Rq, C, Rout);
        AttitudeSample s;
        s.tS = t;
        rnis::pano::detail::matToQuat(Rout, s.q);
        out.push_back(s);
    }
    return out;
}

TauRun run(double tau, double r = 0.95, bool resolved = true, double band = 0.5) {
    TauRun x;
    x.resolved = resolved;
    x.tauMs = tau;
    x.peakR = r;
    x.bandWidthMs = band;
    return x;
}

}  // namespace

// ══════════════════════════════════════════════════════════════════════════
//  EXCITATION
// ══════════════════════════════════════════════════════════════════════════

TEST(Excitation, APurePanExercisesExactlyOneAxisAndRank2IsZero) {
    Motion m;
    m.aPanDeg = 30.0;
    const auto s = sampleMotion(m, 0.0, 6.0, 100.0);
    const AxisExcitation e = rnis::pano::excitation(s);
    ASSERT_TRUE(e.ok);
    EXPECT_GT(e.sweptDeg, 200.0);
    // Index 1 is pan.
    EXPECT_GT(e.perAxisDeg[1], 200.0);
    EXPECT_LT(e.perAxisDeg[0], 1e-6);
    EXPECT_LT(e.perAxisDeg[2], 1e-6);
    EXPECT_LT(e.rank2, 1e-6) << "a one-axis log must have NO second eigen-axis";

    const ExcitationVerdict v = rnis::pano::gradeExcitation(e, ExcitationPolicy{});
    EXPECT_FALSE(v.sufficient);
    EXPECT_STREQ(v.reason, "single-axis");
    EXPECT_EQ(v.exercisedAxes, 1);
    EXPECT_TRUE(v.needMore[0]);
    EXPECT_FALSE(v.needMore[1]);
    EXPECT_TRUE(v.needMore[2]);
    EXPECT_STREQ(rnis::pano::axisName(1), "pan");
}

TEST(Excitation, PanPlusTiltIsSufficient) {
    Motion m;
    m.aPanDeg = 30.0;
    m.bTiltDeg = 22.0;
    const auto s = sampleMotion(m, 0.0, 6.0, 100.0);
    const ExcitationVerdict v =
        rnis::pano::gradeExcitation(rnis::pano::excitation(s), ExcitationPolicy{});
    EXPECT_TRUE(v.sufficient) << "reason was " << v.reason;
    EXPECT_STREQ(v.reason, "ok");
    EXPECT_GE(v.exercisedAxes, 2);
    EXPECT_DOUBLE_EQ(v.progress, 1.0);
}

TEST(Excitation, AllThreeAxesIsAlsoSufficientAndFillsRank3) {
    Motion m;
    m.aPanDeg = 30.0;
    m.bTiltDeg = 22.0;
    m.cRollDeg = 20.0;
    const AxisExcitation e = rnis::pano::excitation(sampleMotion(m, 0.0, 6.0, 100.0));
    EXPECT_GT(e.rank3, 0.05);
    EXPECT_TRUE(rnis::pano::gradeExcitation(e, ExcitationPolicy{}).sufficient);
}

// THE FALSE-PASS DEFENCE. Gyro noise is isotropic, so without the step floor a
// still phone would report rank2 ≈ rank3 ≈ 1 — PERFECT three-axis excitation
// from a phone lying on a table.
TEST(Excitation, IsotropicNoiseOnAStillPhoneIsNotMistakenForThreeAxisMotion) {
    std::vector<AttitudeSample> s;
    unsigned int seed = 12345u;
    auto rnd = [&seed]() {
        seed = seed * 1103515245u + 12345u;
        return ((double)((seed >> 16) & 0x7fff) / 16383.5) - 1.0;  // [-1, 1]
    };
    double q[4] = {0, 0, 0, 1};
    for (int i = 0; i < 600; ++i) {
        double d[4], nq[4];
        // ~0.004° per step, isotropic: an order of magnitude under the floor.
        const double n[3] = {rnd() * 0.004, rnd() * 0.004, rnd() * 0.004};
        const double a = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        if (a > 0) {
            const double h = 0.5 * a * kDeg;
            const double sn = std::sin(h) / a;
            d[0] = n[0] * sn; d[1] = n[1] * sn; d[2] = n[2] * sn; d[3] = std::cos(h);
        } else {
            d[0] = d[1] = d[2] = 0; d[3] = 1;
        }
        quatMul(q, d, nq);
        for (int k = 0; k < 4; ++k) q[k] = nq[k];
        AttitudeSample x;
        x.tS = i * 0.01;
        for (int k = 0; k < 4; ++k) x.q[k] = q[k];
        s.push_back(x);
    }
    const AxisExcitation e = rnis::pano::excitation(s);
    EXPECT_GT(e.stepsBelowFloor, 500) << "the floor must remove the noise";
    EXPECT_EQ(e.steps, 0);
    const ExcitationVerdict v = rnis::pano::gradeExcitation(e, ExcitationPolicy{});
    EXPECT_FALSE(v.sufficient);
    EXPECT_STREQ(v.reason, "stationary")
        << "a still phone is STATIONARY, never 'too-few-samples' — the operator "
           "must be sent to his hands, not to the sensor rate";
}

TEST(Excitation, TwoNearlyParallelAxesAreCaughtByRank2) {
    // Pan, plus a tiny tilt that still clears the per-axis bar in L1 but leaves
    // the motion effectively one-axis. Both axes "exercised", rank2 small.
    Motion m;
    m.aPanDeg = 40.0;
    m.bTiltDeg = 2.4;
    m.w2 = 2.1;   // same frequency ⇒ the two rotations stay locked together
    const AxisExcitation e = rnis::pano::excitation(sampleMotion(m, 0.0, 8.0, 100.0));
    const ExcitationVerdict v = rnis::pano::gradeExcitation(e, ExcitationPolicy{});
    if (v.exercisedAxes >= 2) {
        EXPECT_FALSE(v.sufficient);
        EXPECT_STREQ(v.reason, "axes-too-close");
    } else {
        EXPECT_STREQ(v.reason, "single-axis");
    }
    EXPECT_LT(e.rank2, 0.25);
}

TEST(Excitation, ASmallGestureIsNotEnoughTurning) {
    Motion m;
    m.aPanDeg = 4.0;
    m.bTiltDeg = 4.0;
    const AxisExcitation e = rnis::pano::excitation(sampleMotion(m, 0.0, 1.2, 100.0));
    const ExcitationVerdict v = rnis::pano::gradeExcitation(e, ExcitationPolicy{});
    EXPECT_FALSE(v.sufficient);
    EXPECT_TRUE(std::string(v.reason) == "not-enough-turning"
                || std::string(v.reason) == "single-axis"
                || std::string(v.reason) == "stationary")
        << "reason was " << v.reason;
    EXPECT_LT(v.progress, 1.0);
}

// The eigen statistics must not depend on which frame the log is expressed in —
// that is the property that lets the SAME number be compared between the IMU
// series (whose frame is the unknown) and the reference series.
TEST(Excitation, TheEigenRatiosAreFrameInvariantWhileThePerAxisNamesAreNot) {
    Motion m;
    m.aPanDeg = 30.0;
    m.bTiltDeg = 22.0;
    m.cRollDeg = 12.0;
    const auto a = sampleMotion(m, 0.0, 6.0, 100.0);
    const auto b = referenceThrough(m, 7, 0.0, 6.0, 100.0);   // conjugated by C₇
    const AxisExcitation ea = rnis::pano::excitation(a);
    const AxisExcitation eb = rnis::pano::excitation(b);
    EXPECT_NEAR(ea.rank2, eb.rank2, 1e-9);
    EXPECT_NEAR(ea.rank3, eb.rank3, 1e-9);
    EXPECT_NEAR(ea.sweptDeg, eb.sweptDeg, 1e-6);
    // …and the per-axis split is a PERMUTATION of the same numbers, which is
    // exactly why it may only be read off a series whose frame is known.
    double sa[3] = {ea.perAxisDeg[0], ea.perAxisDeg[1], ea.perAxisDeg[2]};
    double sb[3] = {eb.perAxisDeg[0], eb.perAxisDeg[1], eb.perAxisDeg[2]};
    std::sort(sa, sa + 3);
    std::sort(sb, sb + 3);
    for (int i = 0; i < 3; ++i) EXPECT_NEAR(sa[i], sb[i], 1e-6);
}

TEST(Excitation, AnEmptyOrOneSampleLogIsTooFewSamplesNotStationary) {
    std::vector<AttitudeSample> s;
    ExcitationVerdict v = rnis::pano::gradeExcitation(rnis::pano::excitation(s),
                                                      ExcitationPolicy{});
    EXPECT_STREQ(v.reason, "too-few-samples");
    s.push_back(AttitudeSample{});
    v = rnis::pano::gradeExcitation(rnis::pano::excitation(s), ExcitationPolicy{});
    EXPECT_STREQ(v.reason, "too-few-samples");
}

// ══════════════════════════════════════════════════════════════════════════
//  τ
// ══════════════════════════════════════════════════════════════════════════

TEST(TauCombine, ThreeTightRunsResolveToTheirMedian) {
    const std::vector<TauRun> r = {run(-4.20), run(-4.05), run(-4.35)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_TRUE(f.ok) << f.reason;
    EXPECT_STREQ(f.reason, "ok");
    EXPECT_EQ(f.runs, 3);
    EXPECT_EQ(f.resolvedRuns, 3);
    EXPECT_NEAR(f.tauMs, -4.20, 1e-12);
    EXPECT_NEAR(f.spreadMs, 0.30, 1e-12);
    EXPECT_LT(f.stdErrMs, 1.0);
    EXPECT_TRUE(f.smallSample) << "n = 3 makes the SD itself uncertain; say so";
    EXPECT_NEAR(f.budgetFractionUsed, f.stdErrMs / 3.08, 1e-12);
}

// ── THE CATEGORY ERROR, AS A TEST ─────────────────────────────────────────
// The shipped `withinTightestBudget` graded |τ| against the 3.08 ms budget —
// the budget for the error that SURVIVES the correction. A large, repeatable τ
// is a good calibration: the whole point of measuring it is to remove it.
TEST(TauCombine, ALargeButRepeatableTauIsAcceptedNotRejected) {
    const std::vector<TauRun> r = {run(-11.30), run(-11.42), run(-11.21)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_TRUE(f.ok) << "an 11 ms offset measured to ±0.1 ms is EXCELLENT; "
                         "grading its magnitude is grading the disease against "
                         "the tolerance for the cure";
    EXPECT_NEAR(f.tauMs, -11.30, 1e-12);
    EXPECT_LT(f.stdErrMs, 0.2);
}

// …and its mirror: a tiny τ recovered from three runs that disagree is NOT a
// calibration, however small the number looks.
TEST(TauCombine, ASmallButScatteredTauIsRefused) {
    const std::vector<TauRun> r = {run(0.4), run(-3.1), run(2.9)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_FALSE(f.ok);
    EXPECT_STREQ(f.reason, "spread-too-wide");
    // The evidence is still populated — a refusal that hides its numbers is
    // one the operator cannot act on.
    EXPECT_EQ(f.resolvedRuns, 3);
    EXPECT_NEAR(f.spreadMs, 6.0, 1e-12);
    EXPECT_GT(f.sdMs, 0.0);
}

TEST(TauCombine, AnUnresolvedRunIsNotCountedAndCanStarveTheSet) {
    const std::vector<TauRun> r = {run(-4.2), run(-4.1), run(-4.3, 0.31, false)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_FALSE(f.ok);
    EXPECT_STREQ(f.reason, "too-few-resolved-runs");
    EXPECT_EQ(f.runs, 3);
    EXPECT_EQ(f.resolvedRuns, 2);
}

// ── 2026-08-31: THE GATE THAT COULD NOT FAIL ──────────────────────────────
//
// `worstPeakR` starts at an impossible 2.0 and is only ever LOWERED by a
// finite peak.  A resolved run carrying a non-finite `peakR` therefore left
// the sentinel standing, and `minPeakR 0.80` was compared against a
// correlation of 2.0 — a gate that structurally cannot fail.  Unreachable
// through the iOS marshaller (it defaults a bad peak to 0.0 and so fails
// closed), but `combineTau` is the SHARED contract the Android leg calls
// directly and its own `fin()` guard says it expects non-finite input.

TEST(TauCombine, ANonFinitePeakIsUnresolvedAndCanNeverPublishAnImpossibleR) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    const std::vector<TauRun> r = {run(-4.2, nan), run(-4.1, nan), run(-4.3, nan)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_FALSE(f.ok) << "three malformed runs must never persist a tau";
    EXPECT_STREQ(f.reason, "too-few-resolved-runs");
    EXPECT_EQ(f.resolvedRuns, 0);
    EXPECT_EQ(f.malformedRuns, 3) << "and the refusal must say WHY they vanished";
    EXPECT_NEAR(f.worstPeakR, 0.0, 1e-12) << "never the 2.0 sentinel";
}

TEST(TauCombine, OneMalformedRunStarvesTheSetRatherThanRidingAlong) {
    const double inf = std::numeric_limits<double>::infinity();
    const std::vector<TauRun> r = {run(-4.2), run(-4.1), run(-4.3, inf)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_FALSE(f.ok);
    EXPECT_STREQ(f.reason, "too-few-resolved-runs");
    EXPECT_EQ(f.runs, 3);
    EXPECT_EQ(f.resolvedRuns, 2);
    EXPECT_EQ(f.malformedRuns, 1);
    // The two good runs' evidence still stands — a refusal shows its work.
    EXPECT_NEAR(f.worstPeakR, 0.95, 1e-12);
}

TEST(TauCombine, ANonFiniteTauIsMalformedNotSilentlySkipped) {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    const std::vector<TauRun> r = {run(nan), run(-4.1), run(-4.3), run(-4.2)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_TRUE(f.ok) << f.reason;
    EXPECT_EQ(f.resolvedRuns, 3);
    EXPECT_EQ(f.malformedRuns, 1);
}

TEST(TauCombine, AWeakPeakIsRefusedEvenWhenTheRunsAgree) {
    const std::vector<TauRun> r = {run(-4.2, 0.72), run(-4.1, 0.93), run(-4.3, 0.91)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_FALSE(f.ok);
    EXPECT_STREQ(f.reason, "weak-peak");
    EXPECT_NEAR(f.worstPeakR, 0.72, 1e-12);
}

TEST(TauCombine, TheStandardErrorGateFiresOnItsOwnTerms) {
    TauPolicy p;
    p.maxSpreadMs = 100.0;   // disable the spread gate to reach the next one
    p.maxStdErrMs = 0.30;
    const std::vector<TauRun> r = {run(-4.0), run(-5.0), run(-3.0)};
    const TauFit f = rnis::pano::combineTau(r, p);
    EXPECT_FALSE(f.ok);
    EXPECT_STREQ(f.reason, "std-err-too-wide");
    EXPECT_NEAR(f.sdMs, 1.0, 1e-12);
    EXPECT_NEAR(f.stdErrMs, 1.0 / std::sqrt(3.0), 1e-12);
}

TEST(TauCombine, NoRunsIsNoRunsAndNeverATauOfZero) {
    const TauFit f = rnis::pano::combineTau({}, TauPolicy{});
    EXPECT_FALSE(f.ok);
    EXPECT_STREQ(f.reason, "no-runs");
    EXPECT_EQ(f.resolvedRuns, 0);
}

TEST(TauCombine, MoreRunsClearTheSmallSampleFlag) {
    const std::vector<TauRun> r = {run(-4.2), run(-4.1), run(-4.3),
                                   run(-4.15), run(-4.25)};
    const TauFit f = rnis::pano::combineTau(r, TauPolicy{});
    EXPECT_TRUE(f.ok);
    EXPECT_FALSE(f.smallSample);
}

// ══════════════════════════════════════════════════════════════════════════
//  THE BASIS PERSIST DECISION
// ══════════════════════════════════════════════════════════════════════════

TEST(BasisGrade, AMultiAxisGestureRecoversTheTruthBasisAndPersists) {
    for (int truth : {0, 2, 7, 13, 20, 23}) {
        Motion m;
        m.aPanDeg = 30.0;
        m.bTiltDeg = 22.0;
        m.cRollDeg = 15.0;
        const auto imu = sampleMotion(m, 0.0, 6.0, 100.0);
        const auto ref = referenceThrough(m, truth, 0.05, 5.95, 60.0);
        const BasisSelection sel = rnis::pano::selectBasis(imu, ref, 0.0);
        const AxisExcitation exc = rnis::pano::excitation(ref);
        const BasisVerdict v =
            rnis::pano::gradeBasis(sel, exc, ExcitationPolicy{}, BasisPolicy{});
        EXPECT_TRUE(v.ok) << "truth " << truth << " reason " << v.reason;
        EXPECT_EQ(v.index, truth);
        EXPECT_STREQ(v.label, rnis::pano::basisLabel(truth));
        // NOT zero, and the reason is worth stating: the reference is sampled
        // off the IMU's 100 Hz grid, so every pair carries the SLERP
        // interpolation residual — a geodesic chord across a 10 ms arc of a
        // motion that is not itself a constant-rate geodesic. Measured here at
        // 1.8e-3 deg, which at 11.7 canvas px/deg is 0.02 px: two orders under
        // the 0.50 px band gate, and the FLOOR below which this fixture cannot
        // see. Asserting exactness here would be asserting that interpolation
        // is free.
        EXPECT_LT(v.rmsDeg, 0.02);
        EXPECT_GT(v.rmsDeg, 0.0);
        EXPECT_GT(v.marginDeg, 1.0);
        EXPECT_GE(v.pairs, 60);
        EXPECT_NE(v.runnerUpIndex, truth);
    }
}

// THE PROTOTYPE'S OWN DEFECT, AS A REGRESSION TEST.
TEST(BasisGrade, APurePanIsRefusedWithAnActionableReason) {
    Motion m;
    m.aPanDeg = 30.0;
    const int truth = 2;
    const auto imu = sampleMotion(m, 0.0, 6.0, 100.0);
    const auto ref = referenceThrough(m, truth, 0.05, 5.95, 60.0);
    const BasisSelection sel = rnis::pano::selectBasis(imu, ref, 0.0);
    EXPECT_FALSE(sel.unique);
    EXPECT_STREQ(sel.refusal, "ambiguous-axis");

    const BasisVerdict v = rnis::pano::gradeBasis(
        sel, rnis::pano::excitation(ref), ExcitationPolicy{}, BasisPolicy{});
    EXPECT_FALSE(v.ok);
    EXPECT_STREQ(v.reason, "excitation-insufficient")
        << "the gesture is the thing the operator can fix; say THAT, not "
           "'ambiguous-axis'";
    // The ranked list still ships, so the four tied candidates are visible.
    EXPECT_GE((int)sel.ranked.size(), 4);
    EXPECT_NEAR(sel.marginDeg, 0.0, 1e-9);
}

// A CORRECT BASIS MUST STILL PERSIST WHEN THE GYRO IS DRIFTING. The basis is a
// discrete choice among 24 permutations; a drifting gyro does not make a
// different permutation correct. Conflating the two would refuse a measurement
// that is exactly right and send the operator to redo a gesture that cannot
// fix it.
TEST(BasisGrade, DriftIsReportedAsAnArchitectureVerdictAndDoesNotBlockThePersist) {
    Motion m;
    m.aPanDeg = 30.0;
    m.bTiltDeg = 22.0;
    m.cRollDeg = 15.0;
    const int truth = 7;
    const auto imu = sampleMotion(m, 0.0, 6.0, 100.0);
    const auto ref = referenceThrough(m, truth, 0.05, 5.95, 60.0, /*bias*/ 0.5);
    const BasisSelection sel = rnis::pano::selectBasis(imu, ref, 0.0);
    const BasisVerdict v = rnis::pano::gradeBasis(
        sel, rnis::pano::excitation(ref), ExcitationPolicy{}, BasisPolicy{});
    EXPECT_TRUE(v.ok) << v.reason;
    EXPECT_EQ(v.index, truth);
    EXPECT_TRUE(v.drift.measured);
    EXPECT_GT(v.drift.degPerS, 0.05);
    EXPECT_FALSE(v.drift.withinBudget);
    EXPECT_GT(v.drift.canvasPxOverSweep, v.drift.budgetPx);
    EXPECT_TRUE(v.drift.biasedHigh)
        << "the slope is fitted to |residual|, so it is an upper-ish bound";
}

TEST(BasisGrade, AnEmptySelectionPassesItsOwnReasonThrough) {
    BasisSelection sel;              // default: ranked empty, refusal too-few-samples
    const BasisVerdict v = rnis::pano::gradeBasis(
        sel, AxisExcitation{}, ExcitationPolicy{}, BasisPolicy{});
    EXPECT_FALSE(v.ok);
    EXPECT_STREQ(v.reason, "too-few-samples");
    EXPECT_EQ(v.index, -1);
    EXPECT_FALSE(v.drift.measured);
}

TEST(BasisGrade, AShortLogIsRefusedForTooFewPairsNotForItsResidual) {
    Motion m;
    m.aPanDeg = 30.0;
    m.bTiltDeg = 25.0;
    m.cRollDeg = 15.0;
    m.w1 = 9.0; m.w2 = 13.0; m.w3 = 7.0;   // fast, so a short log still turns
    const auto imu = sampleMotion(m, 0.0, 1.0, 100.0);
    const auto ref = referenceThrough(m, 13, 0.05, 0.95, 30.0);   // ~28 pairs
    const BasisSelection sel = rnis::pano::selectBasis(imu, ref, 0.0);
    const BasisVerdict v = rnis::pano::gradeBasis(
        sel, rnis::pano::excitation(ref), ExcitationPolicy{}, BasisPolicy{});
    EXPECT_FALSE(v.ok);
    EXPECT_STREQ(v.reason, "too-few-pairs");
    EXPECT_EQ(v.index, 13) << "the index is still REPORTED; it is just not kept";
}

// ══════════════════════════════════════════════════════════════════════════
//  τ-SENSITIVITY OF THE BASIS
// ══════════════════════════════════════════════════════════════════════════

TEST(BasisStability, AGoodGestureGivesTheSameWinnerAcrossPlusMinusTenMs) {
    Motion m;
    m.aPanDeg = 30.0;
    m.bTiltDeg = 22.0;
    m.cRollDeg = 15.0;
    const int truth = 20;
    const auto imu = sampleMotion(m, 0.0, 6.0, 100.0);
    const auto ref = referenceThrough(m, truth, 0.10, 5.90, 60.0);
    const auto st = rnis::pano::basisStability(
        imu, ref, {-0.010, -0.005, 0.0, 0.005, 0.010});
    EXPECT_TRUE(st.ok);
    EXPECT_TRUE(st.winnerStable) << st.reason;
    EXPECT_EQ(st.winnerIndex, truth);
    EXPECT_EQ(st.triedOffsets, 5);
    EXPECT_EQ(st.agreeingOffsets, 5);
    EXPECT_GT(st.minMarginDeg, 1.0);
}

TEST(BasisStability, APurePanIsNotStableBecauseItIsNotUniqueAnywhere) {
    Motion m;
    m.aPanDeg = 30.0;
    const auto imu = sampleMotion(m, 0.0, 6.0, 100.0);
    const auto ref = referenceThrough(m, 2, 0.10, 5.90, 60.0);
    const auto st = rnis::pano::basisStability(imu, ref, {-0.005, 0.0, 0.005});
    EXPECT_FALSE(st.winnerStable);
    EXPECT_STREQ(st.reason, "not-unique-at-some-offset");
}

TEST(BasisStability, NoOffsetsIsARefusalNotAPass) {
    const auto st = rnis::pano::basisStability({}, {}, {});
    EXPECT_FALSE(st.ok);
    EXPECT_FALSE(st.winnerStable);
    EXPECT_STREQ(st.reason, "no-offsets");
}
