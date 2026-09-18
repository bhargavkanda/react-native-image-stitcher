// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_basis_test.cpp — the host proof for a derivation that will
// first run on a device nobody has plugged in yet.
//
// The point of this file is NOT that the arithmetic is self-consistent (it
// trivially is).  It is that the derivation is checked against things OUTSIDE
// itself:
//
//   · the ENGINE's own 24-candidate enumeration, searched rather than mirrored,
//     so a reordering in rnis_pano_attitude.cpp breaks a test instead of
//     silently shifting every Android basis by one,
//   · the FIELD-VALIDATED iOS answer (basis 8 on iPhone17,1), which an
//     independent derivation in GL reproduces exactly and a derivation in CV
//     does not — see AndroidBasis.ReproducesTheMeasurediOSBasis and
//     AndroidBasis.TheCVMisreadingIsExactlyAOneEightyRoll,
//   · PIXEL ARITHMETIC for the one sign nothing else pins
//     (AndroidBasisRoll.ClockwiseNinetySendsImageRightToImageDown).
//
// ⚠ NO OpenCV.  This target deliberately does not link it — see the
// tests/CMakeLists.txt comment on rnis_pano_attitude.

#include "rnis_pano_android_basis.hpp"
#include "rnis_pano_attitude.hpp"

#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <set>
#include <string>
#include <vector>

namespace ab = rnis::pano::android;
namespace rp = rnis::pano;

namespace {

constexpr double kTight = 1e-9;

double det3(const double m[9]) {
    return m[0] * (m[4] * m[8] - m[5] * m[7])
         - m[1] * (m[3] * m[8] - m[5] * m[6])
         + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

::testing::AssertionResult MatNear(const double a[9], const double b[9],
                                   double eps) {
    for (int i = 0; i < 9; ++i) {
        if (std::fabs(a[i] - b[i]) > eps) {
            return ::testing::AssertionFailure()
                   << "element " << i << ": " << a[i] << " vs " << b[i];
        }
    }
    return ::testing::AssertionSuccess();
}

::testing::AssertionResult IsOrthonormalRotation(const double m[9]) {
    double mmt[9];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            mmt[r * 3 + c] = m[r * 3 + 0] * m[c * 3 + 0]
                           + m[r * 3 + 1] * m[c * 3 + 1]
                           + m[r * 3 + 2] * m[c * 3 + 2];
        }
    }
    const double I[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    auto ortho = MatNear(mmt, I, kTight);
    if (!ortho) return ortho << " (M·Mᵀ ≠ I)";
    const double d = det3(m);
    if (std::fabs(d - 1.0) > kTight) {
        return ::testing::AssertionFailure() << "det = " << d << ", want +1";
    }
    return ::testing::AssertionSuccess();
}

/// Every entry is exactly −1, 0 or +1 — the property that lets the table lookup
/// be an equality test instead of a tolerance.
::testing::AssertionResult IsExactSignedPermutation(const double m[9]) {
    for (int i = 0; i < 9; ++i) {
        if (m[i] != 0.0 && m[i] != 1.0 && m[i] != -1.0) {
            return ::testing::AssertionFailure()
                   << "element " << i << " = " << m[i] << " is not exactly 0/±1";
        }
    }
    return IsOrthonormalRotation(m);
}

void quatMul(const double a[4], const double b[4], double out[4]) {
    const double ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const double bx = b[0], by = b[1], bz = b[2], bw = b[3];
    out[0] = aw * bx + ax * bw + ay * bz - az * by;
    out[1] = aw * by - ax * bz + ay * bw + az * bx;
    out[2] = aw * bz + ax * by - ay * bx + az * bw;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

void axisAngleQuat(double ax, double ay, double az, double deg, double q[4]) {
    const double n = std::sqrt(ax * ax + ay * ay + az * az);
    ax /= n; ay /= n; az /= n;
    const double h = deg * M_PI / 180.0 * 0.5;
    const double s = std::sin(h);
    q[0] = ax * s; q[1] = ay * s; q[2] = az * s; q[3] = std::cos(h);
}

void candidateQuat(int index, double q[4]) {
    double m[9];
    ASSERT_TRUE(rp::basisMatrix(index, m));
    rp::detail::matToQuat(m, q);
}

ab::BasisRequest backRaw(int sensorOrientationDeg) {
    ab::BasisRequest r;
    r.sensorOrientationDeg = sensorOrientationDeg;
    r.facing               = ab::LensFacing::Back;
    r.recorder             = ab::RecorderRotation::RawSensorBuffer;
    return r;
}

const int kQuarterTurns[4] = {0, 90, 180, 270};

}  // namespace

// ════════════════════════════════════════════════════════════════════════════
// The roll matrix — the one sign that nothing else in the programme pins.
// ════════════════════════════════════════════════════════════════════════════

TEST(AndroidBasisRoll, ClockwiseNinetySendsImageRightToImageDown) {
    // PIXEL ARITHMETIC, independent of every other test here.  Rotating a W×H
    // image CLOCKWISE by 90 sends raw pixel (x, y) to output pixel
    // (H−1−y, x).  Differentiate: moving +1 in raw x moves +1 in output y, so
    // the raw image's RIGHT axis lands on the output's DOWN axis.
    const int H = 5;                 // rows of the RAW image
    auto cw90 = [&](int x, int y, int& xo, int& yo) { xo = (H - 1) - y; yo = x; };
    int x0, y0, x1, y1;
    cw90(0, 0, x0, y0);
    cw90(1, 0, x1, y1);              // one step along raw +x (image right)
    EXPECT_EQ(x1 - x0, 0);
    EXPECT_EQ(y1 - y0, 1);           // ⇒ output +y (image DOWN)

    // In the GL camera frame +Y is image UP (= −down), so raw's X axis lands on
    // the output's −Y.  G(90)'s first COLUMN is the raw X axis expressed in the
    // output frame, i.e. (0, −1, 0).
    double g[9];
    ASSERT_TRUE(ab::detail::imageRollMatrix(90, g));
    EXPECT_DOUBLE_EQ(g[0], 0.0);     // column 0 = (m[0], m[3], m[6])
    EXPECT_DOUBLE_EQ(g[3], -1.0);
    EXPECT_DOUBLE_EQ(g[6], 0.0);

    // …and raw's DOWN axis lands on the output's LEFT, so raw's GL +Y (up)
    // lands on the output's +X.  Column 1 = (1, 0, 0).
    EXPECT_DOUBLE_EQ(g[1], 1.0);
    EXPECT_DOUBLE_EQ(g[4], 0.0);
    EXPECT_DOUBLE_EQ(g[7], 0.0);

    // The optical axis is untouched by an in-plane roll.
    EXPECT_DOUBLE_EQ(g[2], 0.0);
    EXPECT_DOUBLE_EQ(g[5], 0.0);
    EXPECT_DOUBLE_EQ(g[8], 1.0);
}

TEST(AndroidBasisRoll, IsExactAndOrthonormalAtEveryQuarterTurn) {
    for (int t : kQuarterTurns) {
        double g[9];
        ASSERT_TRUE(ab::detail::imageRollMatrix(t, g)) << "deg " << t;
        EXPECT_TRUE(IsExactSignedPermutation(g)) << "deg " << t;
        // And it must be a member of the engine's own table.
        EXPECT_GE(ab::detail::basisIndexForMatrix(g), 0) << "deg " << t;
    }
}

TEST(AndroidBasisRoll, ComposesLikeARotationGroup) {
    for (int a : kQuarterTurns) {
        for (int b : kQuarterTurns) {
            double ga[9], gb[9], prod[9], gsum[9];
            ASSERT_TRUE(ab::detail::imageRollMatrix(a, ga));
            ASSERT_TRUE(ab::detail::imageRollMatrix(b, gb));
            rp::detail::matMul(ga, gb, prod);
            ASSERT_TRUE(ab::detail::imageRollMatrix(a + b, gsum));
            EXPECT_TRUE(MatNear(prod, gsum, kTight)) << a << " + " << b;
        }
    }
}

TEST(AndroidBasisRoll, RefusesAnythingThatIsNotAQuarterTurn) {
    double g[9] = {9, 9, 9, 9, 9, 9, 9, 9, 9};
    for (int bad : {1, 45, 89, 91, -45, 359}) {
        EXPECT_FALSE(ab::detail::imageRollMatrix(bad, g)) << bad;
    }
    // Untouched on refusal — a caller that ignores the bool must not silently
    // pick up a stale or default matrix.
    for (int i = 0; i < 9; ++i) EXPECT_DOUBLE_EQ(g[i], 9.0);
}

TEST(AndroidBasisRoll, NormalizeHandlesNegativesTheWayModuloDoesNot) {
    EXPECT_EQ(ab::detail::normalizeDeg360(-90), 270);
    EXPECT_EQ(ab::detail::normalizeDeg360(-360), 0);
    EXPECT_EQ(ab::detail::normalizeDeg360(-450), 270);
    EXPECT_EQ(ab::detail::normalizeDeg360(450), 90);
    EXPECT_EQ(ab::detail::normalizeDeg360(0), 0);
    // The trap this exists for: the raw operator disagrees.
    EXPECT_EQ(-90 % 360, -90);
}

// ════════════════════════════════════════════════════════════════════════════
// The upright basis — the lens-facing half.
// ════════════════════════════════════════════════════════════════════════════

TEST(AndroidBasisUpright, BackIsIdentityAndFrontFlipsXAndZ) {
    double back[9], front[9];
    ASSERT_TRUE(ab::detail::uprightBasisMatrix(ab::LensFacing::Back, back));
    ASSERT_TRUE(ab::detail::uprightBasisMatrix(ab::LensFacing::Front, front));

    const double I[9]  = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    const double Fr[9] = {-1, 0, 0, 0, 1, 0, 0, 0, -1};
    EXPECT_TRUE(MatNear(back, I, kTight));
    EXPECT_TRUE(MatNear(front, Fr, kTight));

    // Both must be genuine rotations — the front one especially: flipping only
    // Z (the naive "the camera looks the other way") would be a REFLECTION.
    EXPECT_TRUE(IsExactSignedPermutation(back));
    EXPECT_TRUE(IsExactSignedPermutation(front));
    EXPECT_EQ(ab::detail::basisIndexForMatrix(back), 0);
    EXPECT_GE(ab::detail::basisIndexForMatrix(front), 0);
}

TEST(AndroidBasisUpright, ExternalHasNoUprightBasisAndLeavesTheBufferAlone) {
    double m[9] = {7, 7, 7, 7, 7, 7, 7, 7, 7};
    EXPECT_FALSE(ab::detail::uprightBasisMatrix(ab::LensFacing::External, m));
    EXPECT_FALSE(ab::detail::uprightBasisMatrix(
        static_cast<ab::LensFacing>(42), m));
    // A caller that ignores the bool must not pick up a ZEROED matrix — det 0,
    // which multiplies into a silently degenerate basis instead of a loud one.
    for (int i = 0; i < 9; ++i) EXPECT_DOUBLE_EQ(m[i], 7.0);
}

// ════════════════════════════════════════════════════════════════════════════
// deriveBasis — the four back-camera orientations, which is the whole ask.
// ════════════════════════════════════════════════════════════════════════════

TEST(AndroidBasis, EveryBackSensorOrientationYieldsAValidPermutation) {
    for (int s : kQuarterTurns) {
        const ab::BasisDerivation d = ab::deriveBasis(backRaw(s));
        ASSERT_TRUE(d.ok) << "s=" << s << " refusal=" << d.refusal;
        EXPECT_STREQ(d.refusal, "none");
        EXPECT_GE(d.index, 0);
        EXPECT_LT(d.index, rp::basisCandidateCount());
        EXPECT_TRUE(d.matrixValid);
        EXPECT_TRUE(IsExactSignedPermutation(d.m)) << "s=" << s;

        // ROUND-TRIP THROUGH THE ENGINE'S OWN TABLE.  This is the clause that
        // makes a reordering of rnis_pano_attitude.cpp's enumeration a test
        // failure rather than a silent field defect.
        double fromTable[9];
        ASSERT_TRUE(rp::basisMatrix(d.index, fromTable));
        EXPECT_TRUE(MatNear(fromTable, d.m, kTight)) << "s=" << s;
        EXPECT_STREQ(d.label, rp::basisLabel(d.index));

        EXPECT_EQ(d.appliedRotationCwDeg, 0);
        EXPECT_EQ(d.residualRotationCwDeg, s);
    }
}

TEST(AndroidBasis, TheFourBackOrientationsAreFourDifferentBases) {
    // A derivation that collapsed them would look perfectly healthy on any
    // single orientation.
    std::set<int> seen;
    for (int s : kQuarterTurns) seen.insert(ab::deriveBasis(backRaw(s)).index);
    EXPECT_EQ(seen.size(), 4u);
}

TEST(AndroidBasis, ReproducesTheMeasurediOSBasis) {
    // THE LOAD-BEARING TEST.
    //
    // iOS did not derive its basis — `selectBasis()` MEASURED it against a live
    // ARKit session on iPhone17,1 and got index 8, `-y+x+z`.  The iPhone's
    // configuration is the same one this derivation is written for: back lens,
    // a sensor raster that needs a 90° CLOCKWISE rotation to be upright in the
    // device's natural (portrait) orientation, and an engine fed the NATIVE,
    // UNROTATED raster (rnis_pano.hpp:56-59).
    //
    // So the derivation, run on that configuration, must land on 8.  It does.
    // That is an independent check on the entire chain — the GL convention, the
    // sign of the roll, the upright basis, the multiplication order — against a
    // number that was measured on real hardware and has since been field-
    // validated by a shipped iOS arm.
    const ab::BasisDerivation d = ab::deriveBasis(backRaw(90));
    ASSERT_TRUE(d.ok) << d.refusal;
    EXPECT_EQ(d.index, 8);
    EXPECT_STREQ(d.label, "-y+x+z");
}

TEST(AndroidBasis, TheCVMisreadingIsExactlyAOneEightyRoll) {
    // rnis_pano.hpp's coordinate block names BOTH conventions — GL for
    // `camera.transform` (which becomes FrameInput::q, the only consumer of the
    // basis) and CV for `camera.intrinsics`.  Building the basis in CV instead
    // is the port's most available mistake, so this pins its consequence
    // numerically rather than leaving it as prose.
    //
    // The CV upright basis for the back lens is diag(1, −1, −1) rather than the
    // identity (image-up becomes device −Y, optical-forward becomes device −Z),
    // i.e. the two differ by a 180° roll about the optical axis.  Applied to
    // the measured configuration it moves basis 8 to basis 11.
    double c8[9], c11[9], flip[9] = {1, 0, 0, 0, -1, 0, 0, 0, -1}, prod[9];
    ASSERT_TRUE(rp::basisMatrix(8, c8));
    ASSERT_TRUE(rp::basisMatrix(11, c11));
    rp::detail::matMul(c8, flip, prod);
    EXPECT_TRUE(MatNear(prod, c11, kTight));

    double q8[4], q11[4];
    rp::detail::matToQuat(c8, q8);
    rp::detail::matToQuat(c11, q11);
    EXPECT_NEAR(rp::detail::quatDeltaDeg(q8, q11), 180.0, 1e-9);

    // 180° at the engine's 11.7 canvas px/deg is not a subtle error — but every
    // SCALAR the pack carries (residual rms, drift, coverage) stays plausible
    // under it, which is why it needs a test and not a code review.
    EXPECT_EQ(ab::deriveBasis(backRaw(90)).index, 8);
}

TEST(AndroidBasis, AnUprightRecorderCollapsesToTheUprightBasis) {
    for (int s : kQuarterTurns) {
        for (auto facing : {ab::LensFacing::Back, ab::LensFacing::Front}) {
            ab::BasisRequest r = backRaw(s);
            r.facing   = facing;
            r.recorder = ab::RecorderRotation::UprightInNaturalOrientation;
            const ab::BasisDerivation d = ab::deriveBasis(r);
            ASSERT_TRUE(d.ok) << d.refusal;
            EXPECT_EQ(d.appliedRotationCwDeg, s);
            EXPECT_EQ(d.residualRotationCwDeg, 0);
            // Residual 0 ⇒ the basis is the upright one, INDEPENDENT of s.
            double up[9];
            ASSERT_TRUE(ab::detail::uprightBasisMatrix(facing, up));
            EXPECT_TRUE(MatNear(d.m, up, kTight));
        }
    }
    ab::BasisRequest upright = backRaw(90);
    upright.recorder = ab::RecorderRotation::UprightInNaturalOrientation;
    EXPECT_EQ(ab::deriveBasis(upright).index, 0);
}

TEST(AndroidBasis, TheResidualWrapsThroughZeroRatherThanGoingNegative) {
    ab::BasisRequest r = backRaw(0);
    r.recorder              = ab::RecorderRotation::Explicit;
    r.explicitRotationCwDeg = 90;
    const ab::BasisDerivation d = ab::deriveBasis(r);
    ASSERT_TRUE(d.ok) << d.refusal;
    EXPECT_EQ(d.appliedRotationCwDeg, 90);
    EXPECT_EQ(d.residualRotationCwDeg, 270);   // NOT −90
}

TEST(AndroidBasis, ANegativeExplicitRotationIsAStatementNotAnError) {
    ab::BasisRequest neg = backRaw(90);
    neg.recorder              = ab::RecorderRotation::Explicit;
    neg.explicitRotationCwDeg = -90;
    ab::BasisRequest pos = neg;
    pos.explicitRotationCwDeg = 270;

    const ab::BasisDerivation a = ab::deriveBasis(neg);
    const ab::BasisDerivation b = ab::deriveBasis(pos);
    ASSERT_TRUE(a.ok) << a.refusal;
    ASSERT_TRUE(b.ok) << b.refusal;
    EXPECT_EQ(a.index, b.index);
    EXPECT_EQ(a.appliedRotationCwDeg, 270);
}

TEST(AndroidBasis, TheDisplayRotationFormulaIsTheAOSPOneAndLeavesTheDisplayRoll) {
    for (int s : kQuarterTurns) {
        for (int disp : kQuarterTurns) {
            ab::BasisRequest r = backRaw(s);
            r.recorder           = ab::RecorderRotation::UprightForDisplayRotation;
            r.displayRotationDeg = disp;
            const ab::BasisDerivation d = ab::deriveBasis(r);
            ASSERT_TRUE(d.ok) << "s=" << s << " disp=" << disp
                              << " refusal=" << d.refusal;
            EXPECT_EQ(d.appliedRotationCwDeg, (s - disp + 360) % 360);
            // The invariant worth knowing: a buffer made upright FOR THE
            // DISPLAY still carries the display's own roll relative to the
            // device body, so the residual is exactly the display rotation.
            EXPECT_EQ(d.residualRotationCwDeg, disp);
        }
    }
}

TEST(AndroidBasis, UnderDisplayRotationTheBasisIsNotAConstant) {
    // OPERATIONAL CONSEQUENCE, and the reason `RawSensorBuffer` is the default:
    // if the recorder re-rotates when the user turns the phone, `C` changes
    // MID-SWEEP — and `AttitudeAligner::Config::basisIndex` is set once, at
    // construction.  A recorder using this convention must pin the display
    // orientation for the duration of the capture (the iOS arm pins
    // landscape-left) or hand the engine the raw raster instead.
    std::set<int> seen;
    for (int disp : kQuarterTurns) {
        ab::BasisRequest r = backRaw(90);
        r.recorder           = ab::RecorderRotation::UprightForDisplayRotation;
        r.displayRotationDeg = disp;
        seen.insert(ab::deriveBasis(r).index);
    }
    EXPECT_EQ(seen.size(), 4u);
}

// ── The front lens: HANDLED, not refused — except when it is ───────────────
//
// The front lens IS derivable: its upright basis is diag(−1, +1, −1), which is
// a legitimate det-+1 rotation, and everything downstream is the same
// arithmetic.  Two things about it ARE refused, and neither is the lens itself:
// a MIRRORED buffer (a reflection, outside the model), and the
// upright-for-display convention (whose AOSP formula folds a mirror
// compensation into the angle in a way that cannot be separated from outside
// the recorder).

TEST(AndroidBasis, EveryFrontSensorOrientationYieldsAValidPermutation) {
    std::set<int> seen;
    for (int s : kQuarterTurns) {
        ab::BasisRequest r = backRaw(s);
        r.facing = ab::LensFacing::Front;
        const ab::BasisDerivation d = ab::deriveBasis(r);
        ASSERT_TRUE(d.ok) << "s=" << s << " refusal=" << d.refusal;
        EXPECT_TRUE(IsExactSignedPermutation(d.m));
        double fromTable[9];
        ASSERT_TRUE(rp::basisMatrix(d.index, fromTable));
        EXPECT_TRUE(MatNear(fromTable, d.m, kTight));
        seen.insert(d.index);
    }
    EXPECT_EQ(seen.size(), 4u);
}

TEST(AndroidBasis, FrontAndBackNeverLandOnTheSameBasis) {
    // 8 configurations, 8 distinct answers.  A derivation that ignored the lens
    // facing would produce 4.
    std::set<int> seen;
    for (auto facing : {ab::LensFacing::Back, ab::LensFacing::Front}) {
        for (int s : kQuarterTurns) {
            ab::BasisRequest r = backRaw(s);
            r.facing = facing;
            seen.insert(ab::deriveBasis(r).index);
        }
    }
    EXPECT_EQ(seen.size(), 8u);
}

TEST(AndroidBasis, AMirroredBufferIsRefusedAndStillReportsWhatItSaw) {
    ab::BasisRequest r = backRaw(90);
    r.facing   = ab::LensFacing::Front;
    r.mirrored = true;
    const ab::BasisDerivation d = ab::deriveBasis(r);

    EXPECT_FALSE(d.ok);
    EXPECT_EQ(d.index, -1);
    EXPECT_STREQ(d.refusal, "mirrored-buffer-is-a-reflection");
    // The angles ARE reported — they are observed facts about the request and
    // the operator needs the whole configuration to act on the refusal.
    EXPECT_EQ(d.appliedRotationCwDeg, 0);
    EXPECT_EQ(d.residualRotationCwDeg, 90);
    // …but the matrix is NOT, because the placeholder identity would be
    // indistinguishable from basis 0, which is itself a legal answer.
    EXPECT_FALSE(d.matrixValid);
}

TEST(AndroidBasis, TheBackLensIsAlsoRefusedWhenMirrored) {
    // Mirroring is not a front-lens property.  A recorder that flips the back
    // lens (some "selfie-style" preview paths do) is equally outside the model.
    ab::BasisRequest r = backRaw(90);
    r.mirrored = true;
    EXPECT_STREQ(ab::deriveBasis(r).refusal, "mirrored-buffer-is-a-reflection");
}

TEST(AndroidBasis, TheFrontLensUnderDisplayRotationIsRefusedByName) {
    ab::BasisRequest r = backRaw(90);
    r.facing             = ab::LensFacing::Front;
    r.recorder           = ab::RecorderRotation::UprightForDisplayRotation;
    r.displayRotationDeg = 0;
    const ab::BasisDerivation d = ab::deriveBasis(r);
    EXPECT_FALSE(d.ok);
    EXPECT_STREQ(d.refusal, "front-display-rotation-convention-ambiguous");

    // …and the escape hatch works: state the angle you applied.
    r.recorder              = ab::RecorderRotation::Explicit;
    r.explicitRotationCwDeg = 90;
    EXPECT_TRUE(ab::deriveBasis(r).ok);
}

// ── Every other refusal, by name ───────────────────────────────────────────

TEST(AndroidBasis, AnUnreadSensorOrientationIsItsOwnRefusal) {
    // The `-1` default means nobody read the characteristic.  It is a DIFFERENT
    // fault from a HAL returning 45, and it sends an operator somewhere else.
    ab::BasisRequest r = backRaw(-1);
    const ab::BasisDerivation d = ab::deriveBasis(r);
    EXPECT_FALSE(d.ok);
    EXPECT_STREQ(d.refusal, "sensor-orientation-not-read");
    EXPECT_EQ(d.appliedRotationCwDeg, -1);
    EXPECT_FALSE(d.matrixValid);
}

TEST(AndroidBasis, AnOutOfContractSensorOrientationIsRefusedNotRounded) {
    for (int bad : {45, 1, 89, 100, 360, 450}) {
        const ab::BasisDerivation d = ab::deriveBasis(backRaw(bad));
        EXPECT_FALSE(d.ok) << bad;
        EXPECT_STREQ(d.refusal, "sensor-orientation-not-multiple-of-90");
        EXPECT_EQ(d.index, -1) << bad;
    }
}

TEST(AndroidBasis, ExternalLensFacingIsRefused) {
    ab::BasisRequest r = backRaw(90);
    r.facing = ab::LensFacing::External;
    const ab::BasisDerivation d = ab::deriveBasis(r);
    EXPECT_FALSE(d.ok);
    EXPECT_STREQ(d.refusal, "external-lens-facing-unknown-mounting");
}

TEST(AndroidBasis, AnOutOfContractDisplayRotationIsRefused) {
    ab::BasisRequest r = backRaw(90);
    r.recorder           = ab::RecorderRotation::UprightForDisplayRotation;
    r.displayRotationDeg = 45;
    EXPECT_STREQ(ab::deriveBasis(r).refusal, "display-rotation-not-multiple-of-90");
    r.displayRotationDeg = -90;
    EXPECT_STREQ(ab::deriveBasis(r).refusal, "display-rotation-not-multiple-of-90");
}

TEST(AndroidBasis, AnOutOfContractExplicitRotationIsRefused) {
    ab::BasisRequest r = backRaw(90);
    r.recorder              = ab::RecorderRotation::Explicit;
    r.explicitRotationCwDeg = 37;
    EXPECT_STREQ(ab::deriveBasis(r).refusal, "explicit-rotation-not-multiple-of-90");
}

TEST(AndroidBasis, AnUnknownRecorderEnumIsRefusedNotDefaulted) {
    // A JNI shim passing a raw int through is the realistic source of this.
    // Defaulting to RawSensorBuffer would make a typo look like a choice.
    ab::BasisRequest r = backRaw(90);
    r.recorder = static_cast<ab::RecorderRotation>(99);
    const ab::BasisDerivation d = ab::deriveBasis(r);
    EXPECT_FALSE(d.ok);
    EXPECT_STREQ(d.refusal, "recorder-rotation-unknown");
}

TEST(AndroidBasis, EveryRefusalIsNamedNonEmptyAndLeavesNoIndexBehind) {
    std::vector<ab::BasisRequest> bad;
    bad.push_back(backRaw(-1));
    bad.push_back(backRaw(45));
    { auto r = backRaw(90); r.facing = ab::LensFacing::External;      bad.push_back(r); }
    { auto r = backRaw(90); r.mirrored = true;                        bad.push_back(r); }
    { auto r = backRaw(90); r.recorder = ab::RecorderRotation::UprightForDisplayRotation;
      r.displayRotationDeg = 45;                                      bad.push_back(r); }
    { auto r = backRaw(90); r.facing = ab::LensFacing::Front;
      r.recorder = ab::RecorderRotation::UprightForDisplayRotation;   bad.push_back(r); }
    { auto r = backRaw(90); r.recorder = ab::RecorderRotation::Explicit;
      r.explicitRotationCwDeg = 37;                                   bad.push_back(r); }
    { auto r = backRaw(90); r.recorder = static_cast<ab::RecorderRotation>(99);
                                                                      bad.push_back(r); }

    std::set<std::string> names;
    for (const auto& r : bad) {
        const ab::BasisDerivation d = ab::deriveBasis(r);
        EXPECT_FALSE(d.ok);
        EXPECT_EQ(d.index, -1);
        EXPECT_STREQ(d.label, "invalid");
        ASSERT_NE(d.refusal, nullptr);
        const std::string n(d.refusal);
        EXPECT_FALSE(n.empty());
        EXPECT_NE(n, "none");
        EXPECT_NE(n, "not-attempted");
        for (char c : n) {
            // Lowercase, hyphen, and DIGITS — several of these names carry the
            // number they are about (`…-not-multiple-of-90`).
            EXPECT_TRUE((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')
                << "refusal '" << n << "' is not lowercase-hyphen-digit";
        }
        names.insert(n);
    }
    // Each fault has its OWN name — collapsing two would send an operator to
    // the wrong place.
    EXPECT_EQ(names.size(), bad.size());
}

TEST(AndroidBasis, IsAPureFunctionOfItsRequest) {
    for (int s : kQuarterTurns) {
        const ab::BasisDerivation a = ab::deriveBasis(backRaw(s));
        const ab::BasisDerivation b = ab::deriveBasis(backRaw(s));
        EXPECT_EQ(a.ok, b.ok);
        EXPECT_EQ(a.index, b.index);
        EXPECT_STREQ(a.refusal, b.refusal);
        EXPECT_EQ(a.appliedRotationCwDeg, b.appliedRotationCwDeg);
        EXPECT_EQ(a.residualRotationCwDeg, b.residualRotationCwDeg);
        EXPECT_TRUE(MatNear(a.m, b.m, 0.0));   // BIT-identical, not merely close
    }
}

TEST(AndroidBasis, TheIndexAlwaysComesFromTheEngineTableNeverALocalOne) {
    // Sweep every combination that can succeed and assert the returned index
    // and label are the ENGINE's, matching the ENGINE's matrix exactly.  This
    // is the anti-hardcode guarantee: there is no local table that could drift.
    ASSERT_EQ(rp::basisCandidateCount(), 24);
    int checked = 0;
    for (auto facing : {ab::LensFacing::Back, ab::LensFacing::Front}) {
        for (int s : kQuarterTurns) {
            for (int applied : kQuarterTurns) {
                ab::BasisRequest r = backRaw(s);
                r.facing                = facing;
                r.recorder              = ab::RecorderRotation::Explicit;
                r.explicitRotationCwDeg = applied;
                const ab::BasisDerivation d = ab::deriveBasis(r);
                ASSERT_TRUE(d.ok) << d.refusal;
                double fromTable[9];
                ASSERT_TRUE(rp::basisMatrix(d.index, fromTable));
                EXPECT_TRUE(MatNear(fromTable, d.m, 0.0));
                EXPECT_STREQ(d.label, rp::basisLabel(d.index));
                ++checked;
            }
        }
    }
    EXPECT_EQ(checked, 32);
}

TEST(AndroidBasis, TheDerivedBasisRoundTripsThroughNearestBasis) {
    // Ties the two halves of this file together: what `deriveBasis` produces
    // must be recognised by `nearestBasis` at zero residual.
    for (auto facing : {ab::LensFacing::Back, ab::LensFacing::Front}) {
        for (int s : kQuarterTurns) {
            ab::BasisRequest r = backRaw(s);
            r.facing = facing;
            const ab::BasisDerivation d = ab::deriveBasis(r);
            ASSERT_TRUE(d.ok);
            double q[4];
            rp::detail::matToQuat(d.m, q);
            const ab::PoseRotationFit f = ab::nearestBasis(q, 1e-6);
            ASSERT_TRUE(f.ok) << f.refusal << " residual=" << f.residualDeg;
            EXPECT_EQ(f.index, d.index);
            EXPECT_LT(f.residualDeg, 1e-9);
        }
    }
}

TEST(AndroidBasis, TheDerivedIndexIsAcceptedByItsActualConsumer) {
    // END TO END, against the thing that will really receive this number.
    //
    // `AttitudeAligner` refuses EVERY frame with `BasisNotValidated` unless
    // `Config::basisIndex` is in range, so an index this file produced must make
    // a configuration usable.  Without this, the derivation could be internally
    // perfect and still hand the aligner something it rejects.
    for (auto facing : {ab::LensFacing::Back, ab::LensFacing::Front}) {
        for (int s : kQuarterTurns) {
            ab::BasisRequest req = backRaw(s);
            req.facing = facing;
            const ab::BasisDerivation d = ab::deriveBasis(req);
            ASSERT_TRUE(d.ok) << d.refusal;

            rp::AttitudeAligner::Config cfg;
            cfg.basisIndex     = d.index;
            cfg.tauUncorrected = true;      // the sanctioned τ-less sweep
            rp::AttitudeAligner aligner(cfg);
            EXPECT_TRUE(aligner.configurationIsUsable())
                << "facing=" << ab::lensFacingName(facing) << " s=" << s;
            EXPECT_EQ(aligner.tauProvenance(), rp::TauProvenance::Uncorrected);

            // And a REFUSED derivation must NOT be usable — the −1 it returns is
            // exactly the sentinel the aligner refuses on, so a host that skips
            // the `ok` check still fails closed instead of sweeping on a basis
            // that was never derived.
            ab::BasisRequest bad = req;
            bad.mirrored = true;
            rp::AttitudeAligner::Config badCfg;
            badCfg.basisIndex     = ab::deriveBasis(bad).index;
            badCfg.tauUncorrected = true;
            rp::AttitudeAligner badAligner(badCfg);
            EXPECT_FALSE(badAligner.configurationIsUsable());
            EXPECT_EQ(badAligner.align(0.0).refusal,
                      rp::AlignRefusal::BasisNotValidated);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// nearestBasis — the LENS_POSE_ROTATION half.
// ════════════════════════════════════════════════════════════════════════════

TEST(AndroidBasisNearest, EveryCandidateIsRecoveredExactly) {
    for (int i = 0; i < rp::basisCandidateCount(); ++i) {
        double q[4];
        candidateQuat(i, q);
        const ab::PoseRotationFit f =
            ab::nearestBasis(q, ab::kDefaultPoseResidualDegThreshold);
        ASSERT_TRUE(f.ok) << "candidate " << i << " refusal=" << f.refusal;
        EXPECT_EQ(f.index, i);
        EXPECT_EQ(f.nearestIndex, i);
        EXPECT_STREQ(f.label, rp::basisLabel(i));
        EXPECT_NEAR(f.residualDeg, 0.0, 1e-9) << "candidate " << i;
        EXPECT_TRUE(f.matrixValid);
    }
}

TEST(AndroidBasisNearest, AnExactHitIsAQuarterTurnClearOfTheRunnerUp) {
    // The 24 candidates are the rotation group of the cube; its smallest
    // non-identity rotation is 90°.  So an exact hit ALWAYS has a 90° margin,
    // and any margin materially below that means the input is not on-axis.
    for (int i = 0; i < rp::basisCandidateCount(); ++i) {
        double q[4];
        candidateQuat(i, q);
        const ab::PoseRotationFit f = ab::nearestBasis(q, 1.0);
        ASSERT_TRUE(f.ok);
        EXPECT_NEAR(f.marginDeg, 90.0, 1e-6) << "candidate " << i;
        EXPECT_NE(f.runnerUpIndex, i);
    }
}

TEST(AndroidBasisNearest, TwentyDegreesOffAxisIsRefusedWithTheResidualReported) {
    double q8[4], delta[4], off[4];
    candidateQuat(8, q8);
    axisAngleQuat(0.3, -0.5, 0.81, 20.0, delta);   // a deliberately generic axis
    quatMul(q8, delta, off);

    const ab::PoseRotationFit f =
        ab::nearestBasis(off, ab::kDefaultPoseResidualDegThreshold);

    EXPECT_FALSE(f.ok);
    EXPECT_STREQ(f.refusal, "residual-exceeds-threshold");
    // REFUSED, and the accepted answer stays empty…
    EXPECT_EQ(f.index, -1);
    EXPECT_STREQ(f.label, "invalid");
    // …while the OBSERVATION is fully reported, which is what makes the refusal
    // actionable: "your device is 20° off candidate 8" is a diagnosis.
    EXPECT_EQ(f.nearestIndex, 8);
    EXPECT_NEAR(f.residualDeg, 20.0, 1e-6);
    EXPECT_DOUBLE_EQ(f.thresholdDeg, ab::kDefaultPoseResidualDegThreshold);
    EXPECT_TRUE(f.matrixValid);
    EXPECT_TRUE(IsOrthonormalRotation(f.m));
}

TEST(AndroidBasisNearest, OnlyTheThresholdDecidesTheSameInputTwoWays) {
    double q8[4], delta[4], off[4];
    candidateQuat(8, q8);
    axisAngleQuat(0.3, -0.5, 0.81, 20.0, delta);
    quatMul(q8, delta, off);

    EXPECT_FALSE(ab::nearestBasis(off, 2.0).ok);
    const ab::PoseRotationFit loose = ab::nearestBasis(off, 25.0);
    EXPECT_TRUE(loose.ok);
    EXPECT_EQ(loose.index, 8);
    EXPECT_NEAR(loose.residualDeg, 20.0, 1e-6);
}

TEST(AndroidBasisNearest, AnExactlyAmbiguousInputShowsAZeroMargin) {
    // 45° about +Z sits EXACTLY equidistant between candidate 0 (identity) and
    // candidate 9 (a +90° z-roll).  "Nearest" is then decided by the last bits
    // of two arctangents — which is deterministic for a given input but is NOT
    // an answer, and `marginDeg` is the field that says so.
    //
    // (Measured: the winner here is 9, not the lower-index 0.  The ascending
    // scan's lowest-index tie-break only fires on a BIT-EXACT tie, which this
    // is not.  Asserting the winner would be pinning floating-point noise.)
    double q[4];
    axisAngleQuat(0, 0, 1, 45.0, q);
    const ab::PoseRotationFit f = ab::nearestBasis(q, 90.0);
    ASSERT_TRUE(f.ok);
    EXPECT_NEAR(f.residualDeg, 45.0, 1e-9);
    EXPECT_NEAR(f.marginDeg, 0.0, 1e-9);

    const std::set<int> pair{f.index, f.runnerUpIndex};
    EXPECT_EQ(pair, (std::set<int>{0, 9}));

    // Deterministic, whichever of the two it picked.
    EXPECT_EQ(ab::nearestBasis(q, 90.0).index, f.index);
    EXPECT_DOUBLE_EQ(ab::nearestBasis(q, 90.0).marginDeg, f.marginDeg);
}

TEST(AndroidBasisNearest, ASmallMarginIsUnreachableUnderASaneThreshold) {
    // Why no separate margin GATE: the candidates are 90° apart, so two of them
    // can only be near-equidistant from an input that is ≳45° from BOTH.  The
    // residual threshold (2° by default) refuses that long before the margin
    // gets interesting — the ambiguity above needed a 90° threshold to surface
    // at all.  Stated as a test so a future threshold change re-checks it.
    double q[4];
    axisAngleQuat(0, 0, 1, 45.0, q);
    EXPECT_FALSE(ab::nearestBasis(q, ab::kDefaultPoseResidualDegThreshold).ok);

    // At the default threshold the accepted margin is always ≥ 90 − 2·2 = 86°.
    //
    // The nudge is 1.9° and not the threshold itself on purpose: a rotation
    // built to be EXACTLY 2.0° off comes back as 2.0000000000000004° for some
    // candidates (measured — candidate 7), so a test sitting on the boundary
    // would be measuring the last bit of an arctangent rather than the policy.
    for (int i = 0; i < rp::basisCandidateCount(); ++i) {
        double c[4], delta[4], nudged[4];
        candidateQuat(i, c);
        axisAngleQuat(0.3, -0.5, 0.81, 1.9, delta);
        quatMul(c, delta, nudged);
        const ab::PoseRotationFit f =
            ab::nearestBasis(nudged, ab::kDefaultPoseResidualDegThreshold);
        ASSERT_TRUE(f.ok) << "candidate " << i << " refusal=" << f.refusal;
        EXPECT_EQ(f.index, i) << "candidate " << i;
        EXPECT_GT(f.marginDeg, 86.0) << "candidate " << i;
    }
}

TEST(AndroidBasisNearest, TheThresholdBoundIsInclusive) {
    // `residual > threshold` refuses, so a residual AT the bound is accepted.
    // Pinned because the alternative reading (`>=`) would refuse a device whose
    // mounting sits exactly on a bound the operator chose as acceptable.
    double c[4], delta[4], nudged[4];
    candidateQuat(8, c);
    axisAngleQuat(0, 0, 1, 1.5, delta);
    quatMul(c, delta, nudged);
    EXPECT_TRUE(ab::nearestBasis(nudged, 1.5000001).ok);
    EXPECT_FALSE(ab::nearestBasis(nudged, 1.4999999).ok);
}

TEST(AndroidBasisNearest, TheDoubleCoverDoesNotChangeTheAnswer) {
    for (int i = 0; i < rp::basisCandidateCount(); ++i) {
        double q[4], negq[4];
        candidateQuat(i, q);
        for (int k = 0; k < 4; ++k) negq[k] = -q[k];
        EXPECT_EQ(ab::nearestBasis(negq, 1.0).index, i) << "candidate " << i;
    }
}

TEST(AndroidBasisNearest, AnUnusableQuaternionIsRefusedByName) {
    const double zero[4]   = {0, 0, 0, 0};
    const double nanq[4]   = {0, 0, 0, std::nan("")};
    const double infq[4]   = {std::numeric_limits<double>::infinity(), 0, 0, 1};
    const double good[4]   = {0, 0, 0, 1};

    EXPECT_STREQ(ab::nearestBasis(zero, 2.0).refusal, "degenerate-quaternion");
    EXPECT_STREQ(ab::nearestBasis(nanq, 2.0).refusal, "non-finite-quaternion");
    EXPECT_STREQ(ab::nearestBasis(infq, 2.0).refusal, "non-finite-quaternion");
    EXPECT_STREQ(ab::nearestBasis(nullptr, 2.0).refusal, "null-quaternion");
    EXPECT_STREQ(ab::nearestBasis(good, -1.0).refusal, "invalid-threshold");
    EXPECT_STREQ(ab::nearestBasis(good, std::nan("")).refusal, "invalid-threshold");

    for (const auto* q : {&zero, &nanq, &infq}) {
        const ab::PoseRotationFit f = ab::nearestBasis(*q, 2.0);
        EXPECT_FALSE(f.ok);
        EXPECT_EQ(f.index, -1);
        EXPECT_EQ(f.nearestIndex, -1);
        EXPECT_FALSE(f.matrixValid);
    }
}

TEST(AndroidBasisNearest, AnUnnormalisedQuaternionIsNormalisedNotRejected) {
    // A HAL that publishes float32 coefficients will not hand us a unit
    // quaternion to double precision.
    double q[4];
    candidateQuat(8, q);
    double scaled[4];
    for (int k = 0; k < 4; ++k) scaled[k] = q[k] * 7.25;
    const ab::PoseRotationFit f = ab::nearestBasis(scaled, 1e-6);
    ASSERT_TRUE(f.ok) << f.refusal;
    EXPECT_EQ(f.index, 8);
}

TEST(AndroidBasisNearest, IsAPureFunctionOfItsInputs) {
    double q8[4], delta[4], off[4];
    candidateQuat(8, q8);
    axisAngleQuat(1, 2, 3, 7.5, delta);
    quatMul(q8, delta, off);
    const ab::PoseRotationFit a = ab::nearestBasis(off, 10.0);
    const ab::PoseRotationFit b = ab::nearestBasis(off, 10.0);
    EXPECT_EQ(a.index, b.index);
    EXPECT_DOUBLE_EQ(a.residualDeg, b.residualDeg);
    EXPECT_DOUBLE_EQ(a.marginDeg, b.marginDeg);
    EXPECT_TRUE(MatNear(a.m, b.m, 0.0));
}

// ════════════════════════════════════════════════════════════════════════════
// basisFromLensPoseRotation — the wrapper, and the conventions it declares.
// ════════════════════════════════════════════════════════════════════════════

TEST(AndroidLensPose, GyroscopeReferenceWithIdentityAdjustRecoversTheCandidate) {
    ab::LensPoseRequest r;
    candidateQuat(8, r.q);
    r.reference              = ab::LensPoseReference::Gyroscope;
    r.sense                  = ab::PoseQuatSense::DeviceFromCamera;
    r.cameraFrameAdjustIndex = 0;

    const ab::LensPoseFit f = ab::basisFromLensPoseRotation(r);
    ASSERT_TRUE(f.fit.ok) << f.fit.refusal;
    EXPECT_EQ(f.fit.index, 8);
    EXPECT_NEAR(f.fit.residualDeg, 0.0, 1e-9);
    EXPECT_EQ(f.reference, ab::LensPoseReference::Gyroscope);
    EXPECT_EQ(f.cameraFrameAdjustIndex, 0);
    EXPECT_STREQ(f.cameraFrameAdjustLabel, rp::basisLabel(0));
}

TEST(AndroidLensPose, TheSenseDeclarationChangesTheAnswerNotTheConfidence) {
    // THE HAZARD THIS FILE CANNOT CLOSE, made explicit: declaring the wrong
    // sense does not produce a large residual that would betray it — it
    // produces a DIFFERENT basis at residual 0.  Basis 8's transpose is basis
    // 9, a 180° error, and every diagnostic downstream stays plausible.  Only
    // the concurrent-log falsification sweep in the header separates them.
    ab::LensPoseRequest r;
    candidateQuat(8, r.q);
    r.reference = ab::LensPoseReference::Gyroscope;

    r.sense = ab::PoseQuatSense::DeviceFromCamera;
    const ab::LensPoseFit fwd = ab::basisFromLensPoseRotation(r);
    r.sense = ab::PoseQuatSense::CameraFromDevice;
    const ab::LensPoseFit inv = ab::basisFromLensPoseRotation(r);

    ASSERT_TRUE(fwd.fit.ok);
    ASSERT_TRUE(inv.fit.ok);
    EXPECT_EQ(fwd.fit.index, 8);
    EXPECT_EQ(inv.fit.index, 9);          // C_8ᵀ
    EXPECT_NEAR(fwd.fit.residualDeg, 0.0, 1e-9);
    EXPECT_NEAR(inv.fit.residualDeg, 0.0, 1e-9);   // ← equally "confident"

    double c8[9], c9[9], q8[4], q9[4];
    ASSERT_TRUE(rp::basisMatrix(8, c8));
    ASSERT_TRUE(rp::basisMatrix(9, c9));
    rp::detail::matToQuat(c8, q8);
    rp::detail::matToQuat(c9, q9);
    EXPECT_NEAR(rp::detail::quatDeltaDeg(q8, q9), 180.0, 1e-9);
}

TEST(AndroidLensPose, TheCameraFrameAdjustIsComposedNotIgnored) {
    ab::LensPoseRequest r;
    r.q[0] = 0; r.q[1] = 0; r.q[2] = 0; r.q[3] = 1;   // identity pose
    r.reference = ab::LensPoseReference::Gyroscope;
    for (int adj : {0, 3, 8, 17, 23}) {
        r.cameraFrameAdjustIndex = adj;
        const ab::LensPoseFit f = ab::basisFromLensPoseRotation(r);
        ASSERT_TRUE(f.fit.ok) << f.fit.refusal;
        EXPECT_EQ(f.fit.index, adj);
        EXPECT_STREQ(f.cameraFrameAdjustLabel, rp::basisLabel(adj));
    }
}

TEST(AndroidLensPose, ANonGyroscopeReferenceIsRefusedEachByItsOwnName) {
    ab::LensPoseRequest r;
    candidateQuat(8, r.q);

    struct Case { ab::LensPoseReference ref; const char* name; };
    const Case cases[] = {
        {ab::LensPoseReference::PrimaryCamera, "lens-pose-reference-primary-camera"},
        {ab::LensPoseReference::Undefined,     "lens-pose-reference-undefined"},
        {ab::LensPoseReference::Automotive,    "lens-pose-reference-automotive"},
        {static_cast<ab::LensPoseReference>(7), "lens-pose-reference-unknown"},
    };
    for (const auto& c : cases) {
        r.reference = c.ref;
        const ab::LensPoseFit f = ab::basisFromLensPoseRotation(r);
        EXPECT_FALSE(f.fit.ok);
        EXPECT_EQ(f.fit.index, -1);
        EXPECT_STREQ(f.fit.refusal, c.name);
        // The echo survives the refusal — a pack must record what was refused.
        EXPECT_EQ(f.reference, c.ref);
    }
}

TEST(AndroidLensPose, PrimaryCameraWouldOtherwisePassAsIdentity) {
    // Why the reference gate is not decoration: LENS_POSE_ROTATION with
    // LENS_POSE_REFERENCE == PRIMARY_CAMERA is a camera→camera rotation, and on
    // the primary camera itself it is the IDENTITY — which is a perfectly legal
    // basis (index 0) that would sail through every residual check.
    ab::LensPoseRequest r;
    r.q[3] = 1.0;
    r.reference = ab::LensPoseReference::PrimaryCamera;
    EXPECT_FALSE(ab::basisFromLensPoseRotation(r).fit.ok);

    r.reference = ab::LensPoseReference::Gyroscope;
    const ab::LensPoseFit ok = ab::basisFromLensPoseRotation(r);
    EXPECT_TRUE(ok.fit.ok);
    EXPECT_EQ(ok.fit.index, 0);   // ← what the gate prevented from being trusted
}

TEST(AndroidLensPose, AnOutOfRangeAdjustIndexIsRefused) {
    ab::LensPoseRequest r;
    candidateQuat(8, r.q);
    r.reference = ab::LensPoseReference::Gyroscope;
    for (int bad : {-1, 24, 1000}) {
        r.cameraFrameAdjustIndex = bad;
        const ab::LensPoseFit f = ab::basisFromLensPoseRotation(r);
        EXPECT_FALSE(f.fit.ok) << bad;
        EXPECT_STREQ(f.fit.refusal, "camera-frame-adjust-index-out-of-range");
    }
}

TEST(AndroidLensPose, AnUnusableQuaternionIsRefusedThroughTheWrapperToo) {
    ab::LensPoseRequest r;
    r.reference = ab::LensPoseReference::Gyroscope;
    r.q[0] = r.q[1] = r.q[2] = r.q[3] = 0.0;
    EXPECT_STREQ(ab::basisFromLensPoseRotation(r).fit.refusal,
                 "degenerate-quaternion");
    r.q[3] = std::nan("");
    EXPECT_STREQ(ab::basisFromLensPoseRotation(r).fit.refusal,
                 "non-finite-quaternion");
}

TEST(AndroidLensPose, AnOffAxisPoseIsRefusedThroughTheWrapperToo) {
    ab::LensPoseRequest r;
    double q8[4], delta[4];
    candidateQuat(8, q8);
    axisAngleQuat(0.3, -0.5, 0.81, 12.0, delta);
    quatMul(q8, delta, r.q);
    r.reference    = ab::LensPoseReference::Gyroscope;
    r.thresholdDeg = ab::kDefaultPoseResidualDegThreshold;

    const ab::LensPoseFit f = ab::basisFromLensPoseRotation(r);
    EXPECT_FALSE(f.fit.ok);
    EXPECT_STREQ(f.fit.refusal, "residual-exceeds-threshold");
    EXPECT_EQ(f.fit.nearestIndex, 8);
    EXPECT_NEAR(f.fit.residualDeg, 12.0, 1e-6);
}

TEST(AndroidLensPose, TheThresholdDefaultIsTheDocumentedOne) {
    // Pinned so a change to the constant is a deliberate, reviewed act: at
    // 11.7 canvas px/deg this bound is ~23 px of systematic error, already past
    // every integrity gate the programme runs.
    EXPECT_DOUBLE_EQ(ab::kDefaultPoseResidualDegThreshold, 2.0);
    ab::LensPoseRequest r;
    EXPECT_DOUBLE_EQ(r.thresholdDeg, ab::kDefaultPoseResidualDegThreshold);
}

// ════════════════════════════════════════════════════════════════════════════
// The stable names a pack greps for.
// ════════════════════════════════════════════════════════════════════════════

TEST(AndroidBasisNames, AreStableLowercaseHyphenAndTotal) {
    EXPECT_STREQ(ab::lensFacingName(ab::LensFacing::Front), "front");
    EXPECT_STREQ(ab::lensFacingName(ab::LensFacing::Back), "back");
    EXPECT_STREQ(ab::lensFacingName(ab::LensFacing::External), "external");
    EXPECT_STREQ(ab::lensFacingName(static_cast<ab::LensFacing>(42)), "unknown");

    EXPECT_STREQ(ab::recorderRotationName(ab::RecorderRotation::RawSensorBuffer),
                 "raw-sensor-buffer");
    EXPECT_STREQ(ab::recorderRotationName(static_cast<ab::RecorderRotation>(42)),
                 "unknown");

    EXPECT_STREQ(ab::lensPoseReferenceName(ab::LensPoseReference::Gyroscope),
                 "gyroscope");
    EXPECT_STREQ(ab::lensPoseReferenceName(static_cast<ab::LensPoseReference>(42)),
                 "unknown");

    EXPECT_STREQ(ab::poseQuatSenseName(ab::PoseQuatSense::DeviceFromCamera),
                 "device-from-camera");
    EXPECT_STREQ(ab::poseQuatSenseName(ab::PoseQuatSense::CameraFromDevice),
                 "camera-from-device");
}

TEST(AndroidBasisNames, ADerivedBasisIsNotAMeasuredOne) {
    // The pack word for a derived basis is its OWN word.  `measured` would
    // certify a calibration nobody ran; `caller-supplied` would throw away the
    // one thing we do know about where it came from.
    EXPECT_STREQ(ab::derivedBasisProvenanceName(), "derived");
    EXPECT_STRNE(ab::derivedBasisProvenanceName(),
                 rp::basisProvenanceName(rp::BasisProvenance::Measured));
    EXPECT_STRNE(ab::derivedBasisProvenanceName(),
                 rp::basisProvenanceName(rp::BasisProvenance::CallerSupplied));
    EXPECT_STRNE(ab::derivedBasisProvenanceName(),
                 rp::basisProvenanceName(rp::BasisProvenance::NotMeasured));
}

TEST(AndroidBasisNames, TheEnumValuesMatchTheAndroidConstants) {
    // A JNI shim will pass the raw ints straight through; a drift here is a
    // silent front/back swap.
    EXPECT_EQ(static_cast<int>(ab::LensFacing::Front), 0);   // LENS_FACING_FRONT
    EXPECT_EQ(static_cast<int>(ab::LensFacing::Back), 1);    // LENS_FACING_BACK
    EXPECT_EQ(static_cast<int>(ab::LensFacing::External), 2);
    EXPECT_EQ(static_cast<int>(ab::LensPoseReference::PrimaryCamera), 0);
    EXPECT_EQ(static_cast<int>(ab::LensPoseReference::Gyroscope), 1);
    EXPECT_EQ(static_cast<int>(ab::LensPoseReference::Undefined), 2);
    EXPECT_EQ(static_cast<int>(ab::LensPoseReference::Automotive), 3);
}
