// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_s1_test.cpp — the S1 basis run over a recorded pack.
//
// Two halves, and the first one is the reason this file exists.
//
// THE READER.  `runS1` is a thin shell over `selectBasis` / `gradeBasis`,
// which have their own suites.  What is NEW here is a JSON reader, and a
// reader's characteristic failure is not a crash: it is a plausible answer
// from a mis-read quaternion.  A basis measured from a series whose `q` was
// picked up out of `"trackingFailureReason"` would be a number nobody could
// tell from a real one.  So every branch is pinned: the key that also appears
// inside a string VALUE, the key inside a NESTED object, the truncated last
// line a killed writer leaves, the non-unit quaternion, the out-of-order row.
//
// THE PIPELINE.  A synthetic pack whose ground truth is known exactly: the
// reference series is the IMU series pushed through a KNOWN basis, so the
// measured index must come back as that basis, and the derived-vs-measured
// comparison must say `agree`.  Then the same construction with a SINGLE-AXIS
// gesture, which must NOT come back as a plausible winner — the 4-way
// degeneracy is the documented trap and the one an operator can walk into by
// doing a careful pan.

#include <sys/stat.h>
#include <unistd.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "gtest/gtest.h"
#include "rnis_pano_android_s1.hpp"

using rnis::pano::AttitudeSample;
using rnis::pano::basisLabel;
using rnis::pano::basisMatrix;
using rnis::pano::android::S1Report;
using rnis::pano::android::S1Request;
using rnis::pano::android::SeriesParse;
using rnis::pano::android::parseArCoreJsonl;
using rnis::pano::android::parseSensorsJsonl;
using rnis::pano::android::runS1;
using rnis::pano::android::s1ReportToJson;
namespace d = rnis::pano::android::detail;
namespace qd = rnis::pano::detail;

namespace {

// ════════════════════════════════════════════════════════════════════════
//  Synthesis helpers
// ════════════════════════════════════════════════════════════════════════

void axisAngleToMat(int axis, double deg, double m[9]) {
    const double r = deg * M_PI / 180.0;
    const double c = std::cos(r), s = std::sin(r);
    for (int i = 0; i < 9; ++i) m[i] = 0.0;
    if (axis == 0) {
        m[0] = 1; m[4] = c; m[5] = -s; m[7] = s; m[8] = c;
    } else if (axis == 1) {
        m[4] = 1; m[0] = c; m[2] = s; m[6] = -s; m[8] = c;
    } else {
        m[8] = 1; m[0] = c; m[1] = -s; m[3] = s; m[4] = c;
    }
}

/// `Rz(roll)·Rx(pitch)·Ry(yaw)`, row-major.
void eulerMat(double yawDeg, double pitchDeg, double rollDeg, double out[9]) {
    double ry[9], rx[9], rz[9], t[9];
    axisAngleToMat(1, yawDeg, ry);
    axisAngleToMat(0, pitchDeg, rx);
    axisAngleToMat(2, rollDeg, rz);
    qd::matMul(rx, ry, t);
    qd::matMul(rz, t, out);
}

std::string quatJson(const double q[4]) {
    char buf[160];
    std::snprintf(buf, sizeof(buf), "[%.12g,%.12g,%.12g,%.12g]", q[0], q[1], q[2], q[3]);
    return std::string(buf);
}

std::string numStr(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.12g", v);
    return std::string(buf);
}

/// A synthetic sweep: the IMU series, and the reference series obtained by
/// pushing the SAME motion through `basisIndex`.
///
/// `B` (the reference-frame change) is deliberately left as identity: the
/// header proves it cancels in `dR`, and putting a non-identity B in here
/// would test the proof rather than the code.
struct Sweep {
    std::string sensorsJsonl;
    std::string arcoreJsonl;
};

Sweep synthesize(int basisIndex,
                 bool singleAxis,
                 double seconds = 6.0,
                 double imuHz = 100.0,
                 double refHz = 30.0) {
    double C[9];
    EXPECT_TRUE(basisMatrix(basisIndex, C));

    Sweep out;
    const int nImu = (int)(seconds * imuHz);
    for (int i = 0; i <= nImu; ++i) {
        const double t = i / imuHz;
        const double yaw = 40.0 * std::sin(2.0 * M_PI * 0.5 * t);
        const double pitch = singleAxis ? 0.0
            : 25.0 * std::sin(2.0 * M_PI * 0.31 * t + 1.1);
        const double roll = singleAxis ? 0.0
            : 15.0 * std::sin(2.0 * M_PI * 0.7 * t + 2.2);
        double m[9], q[4];
        eulerMat(yaw, pitch, roll, m);
        qd::matToQuat(m, q);
        out.sensorsJsonl += "{\"type\":\"rotation-vector\",\"tsNs\":" +
            numStr(t * 1e9) + ",\"q\":" + quatJson(q) + ",\"tS\":" + numStr(t) +
            ",\"accuracy\":3,\"elapsedRealtimeNsAtDelivery\":" + numStr(t * 1e9) + "}\n";
    }

    // The reference starts a tick INSIDE the IMU window so every reference
    // sample can be bracketed — `selectBasis` refuses to extrapolate and an
    // unbracketable first sample would just shrink `pairs`.
    const int nRef = (int)(seconds * refHz);
    for (int i = 1; i < nRef; ++i) {
        const double t = i / refHz;
        const double yaw = 40.0 * std::sin(2.0 * M_PI * 0.5 * t);
        const double pitch = singleAxis ? 0.0
            : 25.0 * std::sin(2.0 * M_PI * 0.31 * t + 1.1);
        const double roll = singleAxis ? 0.0
            : 15.0 * std::sin(2.0 * M_PI * 0.7 * t + 2.2);
        double m[9], mc[9], q[4];
        eulerMat(yaw, pitch, roll, m);
        qd::matMul(m, C, mc);
        qd::matToQuat(mc, q);
        out.arcoreJsonl += "{\"kind\":\"arcore-frame\",\"tsNs\":" + numStr(t * 1e9) +
            ",\"tS\":" + numStr(t) + ",\"q\":" + quatJson(q) +
            ",\"trackingState\":\"TRACKING\",\"trackingFailureReason\":\"NONE\"," +
            "\"match\":\"exact-sensor-timestamp\",\"matchSeq\":" + numStr(i) + "}\n";
    }
    return out;
}

}  // namespace

// ════════════════════════════════════════════════════════════════════════
//  THE READER
// ════════════════════════════════════════════════════════════════════════

TEST(S1Reader, AKeyOccurringInsideAStringValueIsNotMistakenForTheMember) {
    // The failure a `find("\"q\":")` would have. `trackingFailureReason` here
    // literally contains the text `"q":[9,9,9,9]`, which a naive scan would
    // read as the quaternion — and the basis measured from it would look like
    // a real measurement.
    const std::string line =
        "{\"kind\":\"arcore-frame\",\"note\":\"contains \\\"q\\\":[9,9,9,9] inside\","
        "\"q\":[0,0,0,1],\"trackingState\":\"TRACKING\"}";
    size_t b = 0, e = 0;
    ASSERT_TRUE(d::memberSpan(line, "q", &b, &e));
    double q[4];
    ASSERT_TRUE(d::spanNumberArray(line, b, e, q, 4));
    EXPECT_DOUBLE_EQ(q[0], 0.0);
    EXPECT_DOUBLE_EQ(q[3], 1.0);
}

TEST(S1Reader, AKeyInsideANestedObjectIsNotATopLevelMember) {
    const std::string line = "{\"outer\":{\"q\":[9,9,9,9]},\"tS\":1.5}";
    size_t b = 0, e = 0;
    EXPECT_FALSE(d::memberSpan(line, "q", &b, &e));
    ASSERT_TRUE(d::memberSpan(line, "tS", &b, &e));
    double v = 0.0;
    ASSERT_TRUE(d::spanNumber(line, b, e, &v));
    EXPECT_DOUBLE_EQ(v, 1.5);
}

TEST(S1Reader, NullAndBooleansAreNotNumbers) {
    const std::string line = "{\"a\":null,\"b\":true,\"c\":-2.5e-3}";
    size_t b = 0, e = 0;
    double v = 0.0;
    ASSERT_TRUE(d::memberSpan(line, "a", &b, &e));
    EXPECT_FALSE(d::spanNumber(line, b, e, &v));
    ASSERT_TRUE(d::memberSpan(line, "b", &b, &e));
    EXPECT_FALSE(d::spanNumber(line, b, e, &v));
    ASSERT_TRUE(d::memberSpan(line, "c", &b, &e));
    ASSERT_TRUE(d::spanNumber(line, b, e, &v));
    EXPECT_DOUBLE_EQ(v, -2.5e-3);
}

TEST(S1Reader, AnArrayOfTheWrongLengthIsRefusedRatherThanTruncated) {
    const std::string line = "{\"q\":[1,0,0,0,0],\"r\":[1,0,0]}";
    size_t b = 0, e = 0;
    double q[4];
    ASSERT_TRUE(d::memberSpan(line, "q", &b, &e));
    EXPECT_FALSE(d::spanNumberArray(line, b, e, q, 4));
    ASSERT_TRUE(d::memberSpan(line, "r", &b, &e));
    EXPECT_FALSE(d::spanNumberArray(line, b, e, q, 4));
}

TEST(S1Reader, SensorsRowsAreFilteredByTypeAndTheOthersAreCounted) {
    const std::string text =
        "{\"type\":\"rotation-vector\",\"tS\":0,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"game-rotation-vector\",\"tS\":0.001,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.01,\"q\":[0,0,0,1]}\n";
    const SeriesParse p = parseSensorsJsonl(text, "rotation-vector");
    EXPECT_EQ(p.linesTotal, 3);
    EXPECT_EQ(p.rowsAccepted, 2);
    EXPECT_EQ(p.rowsWrongType, 1);
    EXPECT_EQ(p.rowsMalformed, 0);

    const SeriesParse g = parseSensorsJsonl(text, "game-rotation-vector");
    EXPECT_EQ(g.rowsAccepted, 1);
    EXPECT_EQ(g.rowsWrongType, 2);
}

TEST(S1Reader, ANonUnitQuaternionIsDroppedAndCountedNeverRenormalised) {
    const std::string text =
        "{\"type\":\"rotation-vector\",\"tS\":0,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.01,\"q\":[0,0,0,0.5]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.02,\"q\":[0,0,0,0]}\n";
    const SeriesParse p = parseSensorsJsonl(text, "rotation-vector");
    EXPECT_EQ(p.rowsAccepted, 1);
    EXPECT_EQ(p.rowsNonUnitQuat, 2);
}

TEST(S1Reader, RowsOutOfTimeOrderAreDroppedAndCountedNeverSorted) {
    const std::string text =
        "{\"type\":\"rotation-vector\",\"tS\":0.00,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.02,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.01,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.02,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.03,\"q\":[0,0,0,1]}\n";
    const SeriesParse p = parseSensorsJsonl(text, "rotation-vector");
    EXPECT_EQ(p.rowsAccepted, 3);
    EXPECT_EQ(p.rowsOutOfOrder, 2);      // the 0.01 rewind AND the 0.02 repeat
    ASSERT_EQ(p.samples.size(), 3u);
    EXPECT_LT(p.samples[0].tS, p.samples[1].tS);
    EXPECT_LT(p.samples[1].tS, p.samples[2].tS);
}

TEST(S1Reader, ATruncatedLastLineIsCountedMalformedNotCrashed) {
    // What a writer killed mid-flush leaves behind.
    const std::string text =
        "{\"type\":\"rotation-vector\",\"tS\":0,\"q\":[0,0,0,1]}\n"
        "{\"type\":\"rotation-vector\",\"tS\":0.01,\"q\":[0,0,";
    const SeriesParse p = parseSensorsJsonl(text, "rotation-vector");
    EXPECT_EQ(p.rowsAccepted, 1);
    EXPECT_EQ(p.rowsMalformed, 1);
}

TEST(S1Reader, ARowWithNoTsButATsNsStillCarriesATimestamp) {
    const std::string text =
        "{\"type\":\"rotation-vector\",\"tsNs\":2500000000,\"q\":[0,0,0,1]}\n";
    const SeriesParse p = parseSensorsJsonl(text, "rotation-vector");
    ASSERT_EQ(p.samples.size(), 1u);
    EXPECT_DOUBLE_EQ(p.samples[0].tS, 2.5);
}

TEST(S1Reader, AnArCoreRowThatWasNotTrackingIsNotAReferenceSample) {
    const std::string text =
        "{\"kind\":\"arcore-frame\",\"tS\":0.0,\"q\":[0,0,0,1],\"trackingState\":\"TRACKING\"}\n"
        "{\"kind\":\"arcore-frame\",\"tS\":0.1,\"q\":[0,0,0,1],\"trackingState\":\"PAUSED\"}\n"
        "{\"kind\":\"arcore-frame\",\"tS\":0.2,\"q\":[0,0,0,1],\"trackingState\":\"STOPPED\"}\n"
        "{\"kind\":\"arcore-session\",\"tS\":0.3,\"q\":[0,0,0,1],\"trackingState\":\"TRACKING\"}\n";
    const SeriesParse p = parseArCoreJsonl(text, "q");
    EXPECT_EQ(p.rowsAccepted, 1);
    EXPECT_EQ(p.rowsWrongType, 3);
}

TEST(S1Reader, TheDisplayOrientedPoseIsAvailableButIsNotTheDefault) {
    const std::string text =
        "{\"kind\":\"arcore-frame\",\"tS\":0.0,\"q\":[0,0,0,1],"
        "\"qDisplayOriented\":[0,0,0.7071067811865476,0.7071067811865476],"
        "\"trackingState\":\"TRACKING\"}\n";
    const SeriesParse raw = parseArCoreJsonl(text, "q");
    ASSERT_EQ(raw.samples.size(), 1u);
    EXPECT_DOUBLE_EQ(raw.samples[0].q[2], 0.0);

    const SeriesParse disp = parseArCoreJsonl(text, "qDisplayOriented");
    ASSERT_EQ(disp.samples.size(), 1u);
    EXPECT_NEAR(disp.samples[0].q[2], 0.70710678, 1e-6);
}

// ════════════════════════════════════════════════════════════════════════
//  THE PIPELINE
// ════════════════════════════════════════════════════════════════════════

TEST(S1Run, AMultiAxisSweepRecoversTheBasisItWasBuiltFrom) {
    for (int truth : {0, 8, 17}) {
        const Sweep sw = synthesize(truth, /*singleAxis=*/false);
        const SeriesParse imu = parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector");
        const SeriesParse ref = parseArCoreJsonl(sw.arcoreJsonl, "q");
        ASSERT_GT(imu.rowsAccepted, 500) << "basis " << truth;
        ASSERT_GT(ref.rowsAccepted, 100) << "basis " << truth;

        S1Request req;
        req.derivedBasisIndex = truth;
        const S1Report r = runS1(imu, ref, req);

        EXPECT_TRUE(r.ok) << "basis " << truth << " reason=" << r.reason;
        EXPECT_STREQ(r.reason, "ok") << "basis " << truth;
        EXPECT_TRUE(r.selection.unique);
        ASSERT_FALSE(r.selection.ranked.empty());
        EXPECT_EQ(r.selection.ranked[0].index, truth);
        // NOT zero, and the residual floor is a real quantity rather than
        // slack: the reference is sampled at 30 Hz against a 100 Hz IMU, and
        // the aligner SLERPs between the two BRACKETING samples. A great
        // circle through a smoothly-varying rotation is not the rotation, so
        // a 10 ms bracket leaves ~4e-3° even on an exact construction. It is
        // measured here (0.00406° on all three bases) rather than asserted
        // away, because a jump in it would mean the aligner changed.
        EXPECT_LT(r.verdict.rmsDeg, 0.02) << "basis " << truth;
        EXPECT_GT(r.verdict.rmsDeg, 0.0) << "basis " << truth;
        EXPECT_TRUE(r.haveAgreement);
        EXPECT_TRUE(r.agreement.agree);
        EXPECT_EQ(r.agreement.derivedIndex, truth);
        EXPECT_EQ(r.agreement.referenceIndex, truth);
    }
}

TEST(S1Run, ADerivationThatDisagreesWithTheMeasurementIsReportedAsDisagreement) {
    // The whole point of the falsification: the pack was built on basis 8 and
    // the derivation claims 11. The measurement must win, and the SIZE of the
    // difference must be reported so it localises the fault.
    const Sweep sw = synthesize(8, /*singleAxis=*/false);
    const SeriesParse imu = parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector");
    const SeriesParse ref = parseArCoreJsonl(sw.arcoreJsonl, "q");

    S1Request req;
    req.derivedBasisIndex = 11;
    const S1Report r = runS1(imu, ref, req);

    ASSERT_TRUE(r.haveAgreement);
    EXPECT_TRUE(r.agreement.comparable);
    EXPECT_FALSE(r.agreement.agree);
    EXPECT_EQ(r.agreement.referenceIndex, 8);
    EXPECT_GT(r.agreement.relativeAngleDeg, 1.0);
    EXPECT_STRNE(r.agreement.diagnosis, "not-compared");
}

TEST(S1Run, ASingleAxisGestureRefusesRatherThanReturningAPlausibleIndex) {
    // The documented 4-way exact tie. A careful pan is the WORST S1 capture,
    // and the failure mode being defended against is a panel that shows a
    // confident index measured from a log that cannot identify one.
    const Sweep sw = synthesize(8, /*singleAxis=*/true);
    const SeriesParse imu = parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector");
    const SeriesParse ref = parseArCoreJsonl(sw.arcoreJsonl, "q");

    S1Request req;
    req.derivedBasisIndex = 8;
    const S1Report r = runS1(imu, ref, req);

    EXPECT_FALSE(r.ok);
    EXPECT_FALSE(r.selection.unique);
    // No comparison is offered at all — an "agree" here would be luck.
    EXPECT_FALSE(r.haveAgreement);
    EXPECT_STREQ(r.agreementWithheld, "measured-winner-not-unique");
    // And the coaching the panel renders must name a missing axis.
    EXPECT_FALSE(r.refExcitationVerdict.sufficient);
    int needing = 0;
    for (int i = 0; i < 3; ++i) if (r.refExcitationVerdict.needMore[i]) ++needing;
    EXPECT_GE(needing, 1);
}

TEST(S1Run, NoDerivedIndexMeansNoComparisonRatherThanAnAgreementWithIndexZero) {
    const Sweep sw = synthesize(8, /*singleAxis=*/false);
    const SeriesParse imu = parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector");
    const SeriesParse ref = parseArCoreJsonl(sw.arcoreJsonl, "q");

    S1Request req;   // derivedBasisIndex stays -1
    const S1Report r = runS1(imu, ref, req);
    EXPECT_TRUE(r.ok);
    EXPECT_FALSE(r.haveAgreement);
    EXPECT_STREQ(r.agreementWithheld, "no-derived-index-supplied");
}

TEST(S1Run, AnEmptySeriesNamesWhichSideWasEmpty) {
    const Sweep sw = synthesize(8, false);
    const SeriesParse imu = parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector");
    const SeriesParse ref = parseArCoreJsonl(sw.arcoreJsonl, "q");
    const SeriesParse empty;

    EXPECT_STREQ(runS1(empty, ref, S1Request()).reason, "no-imu-samples");
    EXPECT_STREQ(runS1(imu, empty, S1Request()).reason, "no-reference-samples");
}

TEST(S1Run, TheStabilityCheckIsReportedAsNotRunWhenNoOffsetsWereGiven) {
    const Sweep sw = synthesize(8, false);
    const SeriesParse imu = parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector");
    const SeriesParse ref = parseArCoreJsonl(sw.arcoreJsonl, "q");

    S1Request req;
    const S1Report a = runS1(imu, ref, req);
    EXPECT_FALSE(a.stabilityRun);
    EXPECT_FALSE(a.stability.ok);

    req.tauCandidatesS = {-0.010, -0.005, 0.0, 0.005, 0.010};
    const S1Report b = runS1(imu, ref, req);
    EXPECT_TRUE(b.stabilityRun);
    EXPECT_TRUE(b.stability.winnerStable);
    EXPECT_EQ(b.stability.winnerIndex, 8);
    EXPECT_EQ(b.stability.triedOffsets, 5);
}

// ════════════════════════════════════════════════════════════════════════
//  THE JSON
// ════════════════════════════════════════════════════════════════════════

TEST(S1Json, NoNonFiniteLiteralEverReachesTheString) {
    // `nan` / `inf` make JSON.parse throw in JS, and the rejection surfaces
    // with no trace of which native field produced it.
    const Sweep sw = synthesize(8, /*singleAxis=*/true);   // the degenerate arm
    const SeriesParse imu = parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector");
    const SeriesParse ref = parseArCoreJsonl(sw.arcoreJsonl, "q");
    S1Request req;
    req.derivedBasisIndex = 8;
    req.tauCandidatesS = {0.0};
    const std::string js = s1ReportToJson(runS1(imu, ref, req));

    EXPECT_EQ(js.find("nan"), std::string::npos);
    EXPECT_EQ(js.find("NaN"), std::string::npos);
    EXPECT_EQ(js.find("inf"), std::string::npos);
    EXPECT_EQ(js.find("Inf"), std::string::npos);

    // And on the empty-series path, where every number is a default.
    const std::string js2 = s1ReportToJson(runS1(SeriesParse(), SeriesParse(), S1Request()));
    EXPECT_EQ(js2.find("nan"), std::string::npos);
    EXPECT_EQ(js2.find("inf"), std::string::npos);
}

TEST(S1Json, TheBracesBalanceOnEveryPath) {
    // A cheap structural check that catches the one defect a hand-rolled
    // writer actually makes: a block emitted on one branch and not closed on
    // another.
    auto balanced = [](const std::string& s) {
        int depth = 0;
        bool inStr = false;
        for (size_t i = 0; i < s.size(); ++i) {
            const char c = s[i];
            if (inStr) {
                if (c == '\\') { ++i; continue; }
                if (c == '"') inStr = false;
                continue;
            }
            if (c == '"') { inStr = true; continue; }
            if (c == '{' || c == '[') ++depth;
            if (c == '}' || c == ']') --depth;
            if (depth < 0) return false;
        }
        return depth == 0 && !inStr;
    };

    const Sweep good = synthesize(8, false);
    S1Request req;
    req.derivedBasisIndex = 8;
    req.tauCandidatesS = {-0.005, 0.0, 0.005};
    EXPECT_TRUE(balanced(s1ReportToJson(runS1(
        parseSensorsJsonl(good.sensorsJsonl, "rotation-vector"),
        parseArCoreJsonl(good.arcoreJsonl, "q"), req))));

    EXPECT_TRUE(balanced(s1ReportToJson(runS1(SeriesParse(), SeriesParse(), S1Request()))));

    const Sweep bad = synthesize(8, true);
    EXPECT_TRUE(balanced(s1ReportToJson(runS1(
        parseSensorsJsonl(bad.sensorsJsonl, "rotation-vector"),
        parseArCoreJsonl(bad.arcoreJsonl, "q"), req))));
}

TEST(S1Json, TheReportCarriesTheWinnerTheRunnerUpAndTheMargin) {
    const Sweep sw = synthesize(8, false);
    S1Request req;
    req.derivedBasisIndex = 8;
    const S1Report r = runS1(parseSensorsJsonl(sw.sensorsJsonl, "rotation-vector"),
                             parseArCoreJsonl(sw.arcoreJsonl, "q"), req);
    const std::string js = s1ReportToJson(r);

    EXPECT_NE(js.find("\"runnerUpIndex\":"), std::string::npos);
    EXPECT_NE(js.find("\"marginDeg\":"), std::string::npos);
    EXPECT_NE(js.find("\"unique\":true"), std::string::npos);
    EXPECT_NE(js.find(std::string("\"measuredLabel\":\"") + basisLabel(8) + "\""),
              std::string::npos);
    // The ranked list is capped at five: the 4-way tie plus the first
    // candidate outside it, never all 24.
    ASSERT_GE(r.selection.ranked.size(), 5u);
    size_t rows = 0, p = 0;
    while ((p = js.find("\"driftDegPerS\":", p)) != std::string::npos) { ++rows; ++p; }
    EXPECT_EQ(rows, 5u);
}

// ════════════════════════════════════════════════════════════════════════
//  THE PACK PATH
// ════════════════════════════════════════════════════════════════════════

namespace {

/// A throwaway directory under the system temp dir.  `mkdtemp` rather than a
/// fixed name: two runners in parallel (ctest -j) would otherwise write each
/// other's fixtures and the failure would look like a parser bug.
std::string makeTempDir() {
    char tmpl[] = "/tmp/rnis_s1_XXXXXX";
    const char* d = ::mkdtemp(tmpl);
    return d != nullptr ? std::string(d) : std::string();
}

void writeFileOrDie(const std::string& path, const std::string& body) {
    std::FILE* f = std::fopen(path.c_str(), "wb");
    ASSERT_NE(f, nullptr) << path;
    if (!body.empty()) {
        ASSERT_EQ(std::fwrite(body.data(), 1, body.size(), f), body.size());
    }
    std::fclose(f);
}

}  // namespace

TEST(S1Pack, APackWithBothLedgersMeasuresTheBasis) {
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    const std::string pp = root + "/panoplus";
    ASSERT_EQ(::mkdir(pp.c_str(), 0777), 0);

    const Sweep sw = synthesize(8, /*singleAxis=*/false);
    writeFileOrDie(pp + "/sensors.jsonl", sw.sensorsJsonl);
    writeFileOrDie(pp + "/attitude_arcore.jsonl", sw.arcoreJsonl);

    rnis::pano::android::S1PackRequest req;
    req.run.derivedBasisIndex = 8;

    // BOTH addressing conventions must work: `stopRecording()` reports the
    // `panoplus/` directory, an operator types the session root.
    for (const std::string& addr : {root, pp, root + "/"}) {
        req.packDir = addr;
        const rnis::pano::android::S1PackResult r =
            rnis::pano::android::runS1OnPack(req);
        EXPECT_TRUE(r.sensorsFound) << addr;
        EXPECT_TRUE(r.arcoreFound) << addr;
        EXPECT_TRUE(r.ok) << addr << " reason=" << r.reason;
        ASSERT_FALSE(r.report.selection.ranked.empty());
        EXPECT_EQ(r.report.selection.ranked[0].index, 8) << addr;
        EXPECT_TRUE(r.report.agreement.agree) << addr;
    }
}

TEST(S1Pack, APackWithNoArCoreSidecarIsAPackWithoutAMeasurementNotAFailure) {
    // The COMMON case — the reference channel is off by default. The IMU side
    // must still be counted, so the panel can say what the pack DOES have
    // rather than reporting a broken port.
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    const std::string pp = root + "/panoplus";
    ASSERT_EQ(::mkdir(pp.c_str(), 0777), 0);

    const Sweep sw = synthesize(8, false);
    writeFileOrDie(pp + "/sensors.jsonl", sw.sensorsJsonl);

    rnis::pano::android::S1PackRequest req;
    req.packDir = root;
    const rnis::pano::android::S1PackResult r = rnis::pano::android::runS1OnPack(req);

    EXPECT_FALSE(r.ok);
    EXPECT_STREQ(r.reason, "arcore-jsonl-missing");
    EXPECT_TRUE(r.sensorsFound);
    EXPECT_FALSE(r.arcoreFound);
    EXPECT_GT(r.report.imu.rowsAccepted, 500);
    EXPECT_NE(r.arcorePath.find("attitude_arcore.jsonl"), std::string::npos);
}

TEST(S1Pack, AMissingPackNamesWhatItLookedForRatherThanReturningNothing) {
    rnis::pano::android::S1PackRequest req;
    req.packDir = "/definitely/not/a/pack";
    const rnis::pano::android::S1PackResult r = rnis::pano::android::runS1OnPack(req);
    EXPECT_FALSE(r.ok);
    EXPECT_STREQ(r.reason, "sensors-jsonl-missing");
    EXPECT_EQ(r.sensorsPath, "/definitely/not/a/pack/sensors.jsonl");

    rnis::pano::android::S1PackRequest empty;
    EXPECT_STREQ(rnis::pano::android::runS1OnPack(empty).reason, "no-pack-dir");
}

TEST(S1Pack, TheGameRotationVectorArmIsSelectableFromTheSameLedger) {
    // The magnetometer-free series rides in the SAME sensors.jsonl. Running S1
    // on both is how the port finds out whether the compass contributes
    // anything — and it must not need a second sweep.
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    const std::string pp = root + "/panoplus";
    ASSERT_EQ(::mkdir(pp.c_str(), 0777), 0);

    Sweep sw = synthesize(8, false);
    // Re-label a copy of every row as the game vector, interleaved, exactly as
    // the recorder's single writer emits them.
    std::string both;
    size_t i = 0;
    while (i < sw.sensorsJsonl.size()) {
        const size_t j = sw.sensorsJsonl.find('\n', i);
        if (j == std::string::npos) break;
        const std::string row = sw.sensorsJsonl.substr(i, j - i);
        both += row + "\n";
        std::string alt = row;
        const size_t k = alt.find("\"rotation-vector\"");
        if (k != std::string::npos) {
            alt = alt.substr(0, k) + "\"game-rotation-vector\"" +
                alt.substr(k + std::strlen("\"rotation-vector\""));
        }
        both += alt + "\n";
        i = j + 1;
    }
    writeFileOrDie(pp + "/sensors.jsonl", both);
    writeFileOrDie(pp + "/attitude_arcore.jsonl", sw.arcoreJsonl);

    rnis::pano::android::S1PackRequest req;
    req.packDir = pp;
    req.run.derivedBasisIndex = 8;

    req.imuType = "rotation-vector";
    const rnis::pano::android::S1PackResult a = rnis::pano::android::runS1OnPack(req);
    EXPECT_TRUE(a.ok) << a.reason;
    EXPECT_GT(a.report.imu.rowsWrongType, 500);

    req.imuType = "game-rotation-vector";
    const rnis::pano::android::S1PackResult b = rnis::pano::android::runS1OnPack(req);
    EXPECT_TRUE(b.ok) << b.reason;
    ASSERT_FALSE(b.report.selection.ranked.empty());
    EXPECT_EQ(b.report.selection.ranked[0].index, 8);
}

TEST(S1Pack, ThePackJsonCarriesWhereItLookedAndStaysBalanced) {
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    rnis::pano::android::S1PackRequest req;
    req.packDir = root;
    const std::string js =
        rnis::pano::android::s1PackResultToJson(rnis::pano::android::runS1OnPack(req));
    EXPECT_NE(js.find("\"sensorsPath\":"), std::string::npos);
    EXPECT_NE(js.find("\"arcoreFound\":false"), std::string::npos);
    EXPECT_EQ(js.find("nan"), std::string::npos);
    EXPECT_EQ(js.find("inf"), std::string::npos);
    int depth = 0;
    bool inStr = false;
    for (size_t i = 0; i < js.size(); ++i) {
        const char c = js[i];
        if (inStr) {
            if (c == '\\') { ++i; continue; }
            if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') { inStr = true; continue; }
        if (c == '{' || c == '[') ++depth;
        if (c == '}' || c == ']') --depth;
    }
    EXPECT_EQ(depth, 0);
    EXPECT_FALSE(inStr);
}

// ════════════════════════════════════════════════════════════════════════
//  THE CLOCK THE MEASUREMENT WAS FITTED UNDER
//
// `S1Request::tauS` defaults to 0, the JNI entry passes whatever it is given,
// the Kotlin default is 0.0 and the panel passes none — so every S1 run on the
// programme today joins `sensors.jsonl` (`SensorEvent.timestamp`) to
// `attitude_arcore.jsonl` (ARCore's frame timestamp, i.e. the Camera2
// `SENSOR_TIMESTAMP` domain) at ZERO OFFSET.  That is correct only when
// `SENSOR_INFO_TIMESTAMP_SOURCE` is `REALTIME`, which the recorder writes into
// `device.json` — and which this reader used to ignore entirely.
//
// The measured index is documented to WIN over the derived one.  A winner
// fitted across two epochs, in a report that names neither the epoch nor the
// assumption, is exactly the provenance a pack may not claim.
// ════════════════════════════════════════════════════════════════════════

TEST(S1Clock, TheTimestampSourceIsReadOutOfTheNestedClocksBlock) {
    std::string out;
    const std::string dj =
        "{\"schema\":\"x\",\"selection\":{\"cameraTimestampSource\":\"DECOY\"},"
        "\"clocks\":{\"cameraDomain\":\"CaptureResult.SENSOR_TIMESTAMP\","
        "\"cameraTimestampSource\":\"REALTIME\",\"imuDomain\":\"SensorEvent\"}}";
    EXPECT_TRUE(rnis::pano::android::detail::cameraTimestampSource(dj, &out));
    EXPECT_EQ(out, "REALTIME");
}

TEST(S1Clock, ADeviceJsonWithoutTheFieldIsNotReadAsRealtime) {
    std::string out;
    EXPECT_FALSE(rnis::pano::android::detail::cameraTimestampSource(
        "{\"clocks\":{\"imuDomain\":\"SensorEvent\"}}", &out));
    EXPECT_FALSE(rnis::pano::android::detail::cameraTimestampSource("{}", &out));
    EXPECT_FALSE(rnis::pano::android::detail::cameraTimestampSource("not json", &out));
}

TEST(S1Clock, APackWhoseCameraIsOnTheRealtimeClockSaysTheAssumptionHolds) {
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    const std::string pp = root + "/panoplus";
    ASSERT_EQ(::mkdir(pp.c_str(), 0777), 0);

    const Sweep sw = synthesize(8, /*singleAxis=*/false);
    writeFileOrDie(pp + "/sensors.jsonl", sw.sensorsJsonl);
    writeFileOrDie(pp + "/attitude_arcore.jsonl", sw.arcoreJsonl);
    writeFileOrDie(pp + "/device.json",
                   "{\"clocks\":{\"cameraTimestampSource\":\"REALTIME\"}}");

    rnis::pano::android::S1PackRequest req;
    req.packDir = root;
    const rnis::pano::android::S1PackResult r = rnis::pano::android::runS1OnPack(req);
    EXPECT_TRUE(r.deviceJsonFound);
    EXPECT_EQ(r.cameraTimestampSource, "REALTIME");
    EXPECT_STREQ(r.clockAssumption, "confirmed-realtime");

    const std::string js = rnis::pano::android::s1PackResultToJson(r);
    EXPECT_NE(js.find("\"cameraTimestampSource\":\"REALTIME\""), std::string::npos);
    EXPECT_NE(js.find("\"clockAssumption\":\"confirmed-realtime\""), std::string::npos);
}

TEST(S1Clock, ANonRealtimeCameraClockIsNAMEDRatherThanSilentlyFittedAtTauZero) {
    // `UNKNOWN` means the boot/uptime clock, which STOPS in suspend. The two
    // series are then offset by the accumulated suspend time — a value that is
    // small enough to fit and far outside the +-10 ms stability sweep, so the
    // run would report a stable, unique, plausible winner with nothing anywhere
    // saying which clock the camera was on.
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    const std::string pp = root + "/panoplus";
    ASSERT_EQ(::mkdir(pp.c_str(), 0777), 0);

    const Sweep sw = synthesize(8, false);
    writeFileOrDie(pp + "/sensors.jsonl", sw.sensorsJsonl);
    writeFileOrDie(pp + "/attitude_arcore.jsonl", sw.arcoreJsonl);
    writeFileOrDie(pp + "/device.json",
                   "{\"clocks\":{\"cameraTimestampSource\":\"UNKNOWN\"}}");

    rnis::pano::android::S1PackRequest req;
    req.packDir = root;
    const rnis::pano::android::S1PackResult r = rnis::pano::android::runS1OnPack(req);
    EXPECT_TRUE(r.deviceJsonFound);
    EXPECT_EQ(r.cameraTimestampSource, "UNKNOWN");
    EXPECT_STREQ(r.clockAssumption, "not-realtime");
    // The fit still RUNS and still reports its winner — the caveat is
    // provenance, not a refusal. Withholding the number would lose the one
    // measurement the pack contains.
    EXPECT_TRUE(r.report.selection.ranked.size() > 0);
}

TEST(S1Clock, AMissingDeviceJsonIsUnconfirmedNeverAssumedRealtime) {
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    const std::string pp = root + "/panoplus";
    ASSERT_EQ(::mkdir(pp.c_str(), 0777), 0);

    const Sweep sw = synthesize(8, false);
    writeFileOrDie(pp + "/sensors.jsonl", sw.sensorsJsonl);
    writeFileOrDie(pp + "/attitude_arcore.jsonl", sw.arcoreJsonl);

    rnis::pano::android::S1PackRequest req;
    req.packDir = root;
    const rnis::pano::android::S1PackResult r = rnis::pano::android::runS1OnPack(req);
    EXPECT_FALSE(r.deviceJsonFound);
    EXPECT_TRUE(r.cameraTimestampSource.empty());
    EXPECT_STREQ(r.clockAssumption, "unconfirmed");
}

TEST(S1Clock, ANonZeroTauIsReportedAsTheCallersOwnOffsetNotAsAConfirmedClock) {
    // A caller who supplies tau has taken the decision themselves; the pack
    // must not then read as if the REALTIME check had passed.
    const std::string root = makeTempDir();
    ASSERT_FALSE(root.empty());
    const std::string pp = root + "/panoplus";
    ASSERT_EQ(::mkdir(pp.c_str(), 0777), 0);

    const Sweep sw = synthesize(8, false);
    writeFileOrDie(pp + "/sensors.jsonl", sw.sensorsJsonl);
    writeFileOrDie(pp + "/attitude_arcore.jsonl", sw.arcoreJsonl);

    rnis::pano::android::S1PackRequest req;
    req.packDir = root;
    req.run.tauS = 0.004;
    const rnis::pano::android::S1PackResult r = rnis::pano::android::runS1OnPack(req);
    EXPECT_STREQ(r.clockAssumption, "caller-supplied-tau");
}
