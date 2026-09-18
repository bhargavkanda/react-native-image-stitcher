// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_report_test — the JSON the Android panel reads, and the
// derived-vs-measured comparison, asserted on THIS Mac.
//
// WHY THESE TESTS AND NOT OTHERS.  Everything here is a rule that, if broken,
// fails on a phone in an aisle with the failure three layers from its cause:
//
//   · a bare `nan` in the payload → `JSON.parse` throws in JS, and the panel
//     shows "probe failed" with no field named,
//   · a dropped checklist field → the derived-vs-measured comparison the basis
//     header's FALSIFICATION section depends on cannot be made after the trip,
//   · a comparison that reads "agree" when nothing was compared → the port
//     ships believing a number nobody checked,
//   · a 180° disagreement diagnosed as "off-axis" → the ONE fault the
//     diagnosis exists to name (the CV-vs-GL rebuild) is the one it misses.
//
// ⚠ NO OpenCV.  This target deliberately does not link it — see the
// tests/CMakeLists.txt comment on rnis_pano_attitude.

#include "rnis_pano_android_report.hpp"
// The sanitiser moved to a half-neutral TU; this suite keeps only the
// INTEGRATION assertion (a real generated report survives it untouched),
// because that one needs pano types. The unit assertions live in
// rnis_jni_utf8_test.cpp.
#include "rnis_jni_utf8.hpp"
#include "rnis_pano_android_basis.hpp"
#include "rnis_pano_attitude.hpp"

#include <gtest/gtest.h>

#include <cmath>
#include <string>
#include <vector>

namespace ab = rnis::pano::android;

namespace {

/// The iPhone17,1 configuration `selectBasis()` MEASURED as index 8: back
/// lens, a native raster needing a 90° clockwise turn to be upright in the
/// natural orientation, engine fed that raster unrotated.
ab::BasisRequest iphoneLikeRequest() {
    ab::BasisRequest req;
    req.sensorOrientationDeg = 90;
    req.facing = ab::LensFacing::Back;
    req.recorder = ab::RecorderRotation::RawSensorBuffer;
    return req;
}

bool contains(const std::string& hay, const char* needle) {
    return hay.find(needle) != std::string::npos;
}

/// A key is PRESENT as an object member, not merely as a substring of some
/// value — `"k":` is the only form that proves the field was emitted.
bool hasKey(const std::string& json, const char* key) {
    return json.find(std::string("\"") + key + "\":") != std::string::npos;
}

}  // namespace

// ── the comparison ─────────────────────────────────────────────────────────

TEST(AndroidReportAgreement, IdenticalIndicesAgreeAtZeroDegrees) {
    const ab::BasisAgreement a = ab::compareDerivedWithReference(8, 8);
    EXPECT_TRUE(a.comparable);
    EXPECT_TRUE(a.agree);
    EXPECT_NEAR(a.relativeAngleDeg, 0.0, 1e-9);
    EXPECT_STREQ(a.diagnosis, "agree");
    EXPECT_STREQ(a.derivedLabel, rnis::pano::basisLabel(8));
}

TEST(AndroidReportAgreement, TheCvMisreadingIsAOneEightyAboutXAndIsNamedAsTheConvention) {
    // THE LOAD-BEARING CASE.  rnis_pano_android_basis.hpp warns that building
    // the derivation in the CV convention lands on basis 11 where the truth is
    // basis 8, and that the two differ by exactly `diag(1,−1,−1)` — a
    // disagreement that "flips the canvas upside down while every scalar
    // diagnostic stays plausible".
    //
    // ⚠ THE AXIS IS X, NOT Z, and this test was written asserting Z first and
    // FAILED, which is how the mistake was caught.  That header calls
    // `diag(1,−1,−1)` "a 180° roll about the optical axis"; the matrix is right
    // and the phrase is not.  GL→CV flips Y (up→down) and Z (backward→forward)
    // and FIXES X, so the axis is X.  A roll about the optical axis is
    // `diag(−1,−1,+1)` — a different mistake, from a different cause (an
    // unannounced recorder rotation), needing a different fix.  Conflating the
    // two is exactly what sends a reader to the wrong file.
    const ab::BasisAgreement a = ab::compareDerivedWithReference(8, 11);
    ASSERT_TRUE(a.comparable);
    EXPECT_FALSE(a.agree);
    EXPECT_NEAR(a.relativeAngleDeg, 180.0, 1e-6);
    EXPECT_NEAR(std::fabs(a.relativeAxis[0]), 1.0, 1e-9);
    EXPECT_NEAR(a.relativeAxis[1], 0.0, 1e-9);
    EXPECT_NEAR(a.relativeAxis[2], 0.0, 1e-9);
    EXPECT_FALSE(a.aboutOpticalAxis);
    EXPECT_STREQ(a.diagnosis, "flip-yz-check-gl-vs-cv-camera-convention");
}

TEST(AndroidReportAgreement, AnUnannouncedNinetyDegreeRecorderRotationIsNamedAsSuch) {
    // Two derivations that differ ONLY in how much the recorder rotated: the
    // engine fed a raw raster vs one already turned upright.  The relative
    // rotation must come out as a 90° roll, which is claim 1 of the basis
    // header's falsification list ("SENSOR_ORIENTATION really describes the
    // buffer the recorder hands us").
    ab::BasisRequest raw = iphoneLikeRequest();
    ab::BasisRequest upright = iphoneLikeRequest();
    upright.recorder = ab::RecorderRotation::UprightInNaturalOrientation;

    const ab::BasisDerivation dRaw = ab::deriveBasis(raw);
    const ab::BasisDerivation dUp = ab::deriveBasis(upright);
    ASSERT_TRUE(dRaw.ok);
    ASSERT_TRUE(dUp.ok);
    ASSERT_NE(dRaw.index, dUp.index);

    const ab::BasisAgreement a = ab::compareDerivedWithReference(dRaw.index, dUp.index);
    ASSERT_TRUE(a.comparable);
    EXPECT_FALSE(a.agree);
    EXPECT_TRUE(a.aboutOpticalAxis);
    EXPECT_NEAR(a.relativeAngleDeg, 90.0, 1e-6);
    EXPECT_STREQ(a.diagnosis, "roll-90-check-recorder-applied-rotation");
}

TEST(AndroidReportAgreement, EveryOneOfThe576PairsProducesAFiniteAxisAndACubeGroupAngle) {
    // EXHAUSTIVE, because the spot checks above only exercise the handful of
    // pairs I thought of, and the axis extraction has a SEPARATE branch for
    // θ ≈ 180° (where the usual skew-symmetric formula divides by sin θ = 0).
    // A pair that lands in that branch wrong yields a NaN axis, which would
    // then be reported as "off-axis" — a confident wrong diagnosis, which is
    // this file's stated failure mode.
    //
    // The angle assertion is the strong one: the 24 candidates are the proper
    // rotation group of the cube, whose elements have order 1, 2, 3 or 4. So
    // the angle between ANY two of them is exactly 0°, 90°, 120° or 180° —
    // nothing else is possible, and any other value means the relative
    // rotation was computed wrong (a transposed multiply, say, would still
    // land in the group, but a non-multiply would not).
    const int n = rnis::pano::basisCandidateCount();
    ASSERT_EQ(n, 24);
    for (int a = 0; a < n; ++a) {
        for (int b = 0; b < n; ++b) {
            const ab::BasisAgreement g = ab::compareDerivedWithReference(a, b);
            ASSERT_TRUE(g.comparable) << a << " vs " << b;
            EXPECT_EQ(g.agree, a == b) << a << " vs " << b;

            ASSERT_TRUE(std::isfinite(g.relativeAngleDeg)) << a << " vs " << b;
            for (int k = 0; k < 3; ++k) {
                ASSERT_TRUE(std::isfinite(g.relativeAxis[k]))
                    << "NaN axis component " << k << " for " << a << " vs " << b;
            }

            const double deg = g.relativeAngleDeg;
            const bool cubeAngle =
                std::fabs(deg - 0.0) < 1e-6 || std::fabs(deg - 90.0) < 1e-6
                || std::fabs(deg - 120.0) < 1e-6 || std::fabs(deg - 180.0) < 1e-6;
            EXPECT_TRUE(cubeAngle)
                << a << " vs " << b << " gave " << deg
                << "°, which is not in the cube rotation group {0,90,120,180}";

            // The axis is a UNIT vector whenever there is a rotation, and
            // exactly zero when there is not (an undefined axis must not be
            // invented — see the comment in axisAngle).
            const double norm = std::sqrt(
                g.relativeAxis[0] * g.relativeAxis[0]
                + g.relativeAxis[1] * g.relativeAxis[1]
                + g.relativeAxis[2] * g.relativeAxis[2]);
            if (a == b) {
                EXPECT_NEAR(norm, 0.0, 1e-9) << a << " vs " << b;
            } else {
                EXPECT_NEAR(norm, 1.0, 1e-6) << a << " vs " << b;
            }

            // A diagnosis is always produced, and never the not-compared
            // placeholder, for an in-range pair.
            EXPECT_STRNE(g.diagnosis, "not-compared") << a << " vs " << b;
            EXPECT_STRNE(g.diagnosis, "not-comparable-index-out-of-range")
                << a << " vs " << b;
        }
    }
}

TEST(AndroidReportAgreement, TheComparisonIsSymmetricInAngleAndOpposedInAxis) {
    // C_a^T·C_b and C_b^T·C_a are inverses, so the ANGLE must match and the
    // axis must flip. A multiply that silently transposed one side would pass
    // every single-pair test above and fail here.
    const int n = rnis::pano::basisCandidateCount();
    for (int a = 0; a < n; ++a) {
        for (int b = a + 1; b < n; ++b) {
            const ab::BasisAgreement ab1 = ab::compareDerivedWithReference(a, b);
            const ab::BasisAgreement ba = ab::compareDerivedWithReference(b, a);
            ASSERT_NEAR(ab1.relativeAngleDeg, ba.relativeAngleDeg, 1e-6)
                << a << " vs " << b;
            // At exactly 180° the axis sign is arbitrary (R and its inverse are
            // the same matrix), so only the LINE is well defined there.
            const bool halfTurn = std::fabs(ab1.relativeAngleDeg - 180.0) < 1e-6;
            double dot = 0.0;
            for (int k = 0; k < 3; ++k) dot += ab1.relativeAxis[k] * ba.relativeAxis[k];
            if (halfTurn) {
                EXPECT_NEAR(std::fabs(dot), 1.0, 1e-6) << a << " vs " << b;
            } else {
                EXPECT_NEAR(dot, -1.0, 1e-6) << a << " vs " << b;
            }
            EXPECT_EQ(ab1.aboutOpticalAxis, ba.aboutOpticalAxis) << a << " vs " << b;
        }
    }
}

TEST(AndroidReportAgreement, AnOutOfRangeIndexIsNotComparableAndNeverReadsAsAgreement) {
    // A refused derivation carries index −1.  Comparing it must not produce
    // `agree` (the default-constructed value of a bool is the trap here), and
    // must not silently compare against basis 0.
    for (const int bad : {-1, 24, 999}) {
        const ab::BasisAgreement a = ab::compareDerivedWithReference(bad, 8);
        EXPECT_FALSE(a.comparable) << "derived=" << bad;
        EXPECT_FALSE(a.agree) << "derived=" << bad;
        EXPECT_STREQ(a.diagnosis, "not-comparable-index-out-of-range");

        const ab::BasisAgreement b = ab::compareDerivedWithReference(8, bad);
        EXPECT_FALSE(b.comparable) << "reference=" << bad;
        EXPECT_FALSE(b.agree) << "reference=" << bad;
    }
}

// ── the report ─────────────────────────────────────────────────────────────

TEST(AndroidReport, CarriesEveryFieldTheFalsificationChecklistDemands) {
    // rnis_pano_android_basis.hpp: "WHAT THE RECORDER MUST LOG so the operator
    // can check it in one sweep — … without any one of them the comparison
    // above cannot be made after the fact."  This test is that checklist, made
    // executable.  A future edit that drops a field fails here, not in an
    // aisle.
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    req.basis.displayRotationDeg = 270;
    const std::string json = ab::basisReportToJson(ab::buildBasisReport(req));

    for (const char* k : {"sensorOrientationDeg", "lensFacing", "recorderConvention",
                          "appliedRotationCwDeg", "residualRotationCwDeg", "mirrored",
                          "displayRotationDeg", "basisIndex", "basisLabel", "refusal",
                          "basisMatrix", "basisProvenance", "matrixValid", "ok"}) {
        EXPECT_TRUE(hasKey(json, k)) << "missing checklist field: " << k
                                     << "\njson: " << json;
    }
    // The echo must be the value that was ASKED for, not a normalised one.
    EXPECT_TRUE(contains(json, "\"displayRotationDeg\":270"));
}

TEST(AndroidReport, TheIphoneConfigurationSerialisesTheMeasuredIndexEight) {
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    const ab::BasisReport r = ab::buildBasisReport(req);
    ASSERT_TRUE(r.derivation.ok) << r.derivation.refusal;
    EXPECT_EQ(r.derivation.index, 8);

    const std::string json = ab::basisReportToJson(r);
    EXPECT_TRUE(contains(json, "\"basisIndex\":8")) << json;
    EXPECT_TRUE(contains(json, "\"ok\":true")) << json;
    EXPECT_TRUE(contains(json, "\"refusal\":\"none\"")) << json;
}

TEST(AndroidReport, ADerivedBasisNeverSerialisesAsMeasured) {
    // The provenance rule is the whole reason `derivedBasisProvenanceName()`
    // is a function rather than a comment: a pack stamped `measured` certifies
    // a calibration nobody ran and gives a later reader no way to find out.
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    const std::string json = ab::basisReportToJson(ab::buildBasisReport(req));
    EXPECT_TRUE(contains(json, "\"basisProvenance\":\"derived\"")) << json;
    EXPECT_FALSE(contains(json, "\"basisProvenance\":\"measured\"")) << json;
}

TEST(AndroidReport, ARefusalStillCarriesTheObservationAndNamesItself) {
    // A refused derivation that reported nothing would be indistinguishable
    // from a probe that never ran.  `sensorOrientationDeg` is deliberately
    // left at its −1 sentinel here: that is the "the characteristic was never
    // read" case the derivation refuses rather than defaulting to 0.
    ab::BasisReportRequest req;   // sensorOrientationDeg == -1
    const ab::BasisReport r = ab::buildBasisReport(req);
    ASSERT_FALSE(r.derivation.ok);

    const std::string json = ab::basisReportToJson(r);
    EXPECT_TRUE(contains(json, "\"ok\":false")) << json;
    EXPECT_TRUE(contains(json, "\"basisIndex\":-1")) << json;
    EXPECT_FALSE(contains(json, "\"refusal\":\"none\"")) << json;
    // The placeholder identity must be flagged as such — `+x+y+z` is itself a
    // legal basis, so a bare identity in the matrix says nothing on its own.
    EXPECT_TRUE(contains(json, "\"matrixValid\":false")) << json;
}

TEST(AndroidReport, AMirroredBufferIsRefusedRatherThanMirroringTheCanvas) {
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    req.basis.mirrored = true;
    const ab::BasisReport r = ab::buildBasisReport(req);
    EXPECT_FALSE(r.derivation.ok);
    EXPECT_EQ(r.derivation.index, -1);

    const std::string json = ab::basisReportToJson(r);
    EXPECT_TRUE(contains(json, "\"mirrored\":true")) << json;
    EXPECT_TRUE(contains(json, "\"ok\":false")) << json;
}

TEST(AndroidReport, TheOptionalBlocksAreAbsentUntilAskedFor) {
    // An unrequested cross-check reported as a fit against a zero quaternion,
    // or as agreement with basis 0, is a plausible-looking answer to a
    // question nobody asked.
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    const std::string json = ab::basisReportToJson(ab::buildBasisReport(req));
    EXPECT_TRUE(contains(json, "\"haveLensPose\":false")) << json;
    EXPECT_TRUE(contains(json, "\"haveAgreement\":false")) << json;
    EXPECT_FALSE(hasKey(json, "lensPose")) << json;
    EXPECT_FALSE(hasKey(json, "agreement")) << json;
}

TEST(AndroidReport, ARefusedLensPoseStillSerialisesWhatItObserved) {
    // LENS_POSE_REFERENCE == PRIMARY_CAMERA is refused by name (it measures
    // against ANOTHER CAMERA — a different quantity wearing the same name),
    // and the refusal must still carry the nearest candidate and residual or
    // it is unactionable.
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    req.haveLensPose = true;
    req.lensPose.q[0] = 0.0; req.lensPose.q[1] = 0.0;
    req.lensPose.q[2] = 0.0; req.lensPose.q[3] = 1.0;
    req.lensPose.reference = ab::LensPoseReference::PrimaryCamera;

    const ab::BasisReport r = ab::buildBasisReport(req);
    ASSERT_TRUE(r.haveLensPose);
    EXPECT_FALSE(r.lensPose.fit.ok);
    EXPECT_EQ(r.lensPose.fit.index, -1);

    const std::string json = ab::basisReportToJson(r);
    EXPECT_TRUE(contains(json, "\"haveLensPose\":true")) << json;
    EXPECT_TRUE(hasKey(json, "lensPose")) << json;
    for (const char* k : {"reference", "quatSense", "nearestIndex", "residualDeg",
                          "marginDeg", "thresholdDeg", "refusal"}) {
        EXPECT_TRUE(hasKey(json, k)) << "lensPose missing " << k << "\n" << json;
    }
}

TEST(AndroidReport, AGyroscopeLensPoseThatMatchesIsAcceptedAndSerialised) {
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    req.haveLensPose = true;
    req.lensPose.q[0] = 0.0; req.lensPose.q[1] = 0.0;
    req.lensPose.q[2] = 0.0; req.lensPose.q[3] = 1.0;   // identity
    req.lensPose.reference = ab::LensPoseReference::Gyroscope;
    req.lensPose.sense = ab::PoseQuatSense::DeviceFromCamera;
    req.lensPose.cameraFrameAdjustIndex = 0;

    const ab::BasisReport r = ab::buildBasisReport(req);
    ASSERT_TRUE(r.lensPose.fit.ok) << r.lensPose.fit.refusal;
    EXPECT_GE(r.lensPose.fit.index, 0);

    const std::string json = ab::basisReportToJson(r);
    EXPECT_TRUE(contains(json, "\"reference\":\"gyroscope\"")
                || contains(json, "\"reference\":\"GYROSCOPE\"")) << json;
}

TEST(AndroidReport, TheAgreementBlockSerialisesTheDiagnosis) {
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();          // derives to 8
    req.haveReferenceIndex = true;
    req.referenceBasisIndex = 11;             // the CV misreading
    const ab::BasisReport r = ab::buildBasisReport(req);
    ASSERT_TRUE(r.haveAgreement);

    const std::string json = ab::basisReportToJson(r);
    EXPECT_TRUE(contains(json, "\"diagnosis\":\"flip-yz-check-gl-vs-cv-camera-convention\""))
        << json;
    EXPECT_TRUE(contains(json, "\"agree\":false")) << json;
    EXPECT_TRUE(contains(json, "\"relativeAngleDeg\":180")) << json;
}

TEST(AndroidReport, ARefusedDerivationIsNotCompared) {
    // Comparing a refused derivation (index −1) against a reference must not
    // manufacture a comparison — the refusal is the answer.
    ab::BasisReportRequest req;               // sensorOrientationDeg == -1 → refused
    req.haveReferenceIndex = true;
    req.referenceBasisIndex = 8;
    const ab::BasisReport r = ab::buildBasisReport(req);
    ASSERT_TRUE(r.haveAgreement);
    EXPECT_FALSE(r.agreement.comparable);
    EXPECT_FALSE(r.agreement.agree);
}

TEST(AndroidReportUtf8, LeavesARealReportUntouched) {
    // The whole point is that the guard costs nothing on the normal path.
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    const std::string json = ab::basisReportToJson(ab::buildBasisReport(req));
    EXPECT_EQ(rnis::jniutil::sanitizeForModifiedUtf8(json), json);
}

// ── the bytes ──────────────────────────────────────────────────────────────

/// Every unquoted alphabetic run in `json` that is not `true`/`false`/`null`,
/// which is the complete set of bare literals JSON permits.
///
/// ⚠ WHY A SCANNER AND NOT `contains(json, "nan")`.  That was the first
/// version of this test and it FAILED — on the word `basisProve`**nan**`ce`.
/// A substring grep for a three-letter token inside a document full of English
/// field names is a check that fails for the wrong reason, and would equally
/// have PASSED a document whose only bad literal was `Infinity`.  Scanning
/// outside strings catches every bad literal, including ones nobody listed.
std::vector<std::string> badLiteralsOutsideStrings(const std::string& json) {
    std::vector<std::string> bad;
    bool inStr = false;
    bool esc = false;
    std::string run;
    const auto flush = [&]() {
        if (run.empty()) return;
        if (run != "true" && run != "false" && run != "null") bad.push_back(run);
        run.clear();
    };
    for (const char c : json) {
        if (inStr) {
            if (esc) { esc = false; continue; }
            if (c == '\\') { esc = true; continue; }
            if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') { flush(); inStr = true; continue; }
        // `e`/`E` are exponent markers inside numbers, never the start of an
        // unquoted run here (%.9g emits `1e-09`), so they are collected and
        // would show up as a bad literal only if they stood alone.
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
            if (!run.empty() || !(c == 'e' || c == 'E')) run += c;
            continue;
        }
        if (c == '+' || c == '-') { if (!run.empty()) run += c; continue; }
        flush();
    }
    flush();
    return bad;
}

TEST(AndroidReportJson, EmitsNoBareLiteralOtherThanTrueFalseNull) {
    // Every double in the report goes through the replay driver's non-finite
    // rule (`null`, never `nan`).  A bare `nan`/`inf` reaches JS as a
    // `JSON.parse` throw with no field named — three layers from the mistake.
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    req.haveLensPose = true;
    // A zero quaternion: unusable, and exactly the input most likely to leave
    // a residual/margin unset.
    req.lensPose.q[0] = 0.0; req.lensPose.q[1] = 0.0;
    req.lensPose.q[2] = 0.0; req.lensPose.q[3] = 0.0;
    req.lensPose.reference = ab::LensPoseReference::Gyroscope;
    req.haveReferenceIndex = true;
    req.referenceBasisIndex = 3;

    const std::string json = ab::basisReportToJson(ab::buildBasisReport(req));
    const std::vector<std::string> bad = badLiteralsOutsideStrings(json);
    std::string joined;
    for (const std::string& b : bad) { joined += b; joined += " "; }
    EXPECT_TRUE(bad.empty()) << "bare literals: " << joined << "\n" << json;
}

TEST(AndroidReportJson, TheScannerItselfCatchesABareNan) {
    // A test whose assertion can only pass is not a test.  This pins that
    // `badLiteralsOutsideStrings` reports a real `nan` and ignores one that is
    // merely spelled inside a field name — the exact pair the first version of
    // the test above got backwards.
    EXPECT_FALSE(badLiteralsOutsideStrings("{\"a\":nan}").empty());
    EXPECT_FALSE(badLiteralsOutsideStrings("{\"a\":[1,-inf,2]}").empty());
    EXPECT_FALSE(badLiteralsOutsideStrings("{\"a\":Infinity}").empty());
    EXPECT_TRUE(badLiteralsOutsideStrings("{\"basisProvenance\":\"derived\"}").empty());
    EXPECT_TRUE(badLiteralsOutsideStrings("{\"a\":true,\"b\":false,\"c\":null}").empty());
    EXPECT_TRUE(badLiteralsOutsideStrings("{\"a\":1e-09,\"b\":-2.5E+3}").empty());
}

TEST(AndroidReportJson, IsBalancedAndHasNoDanglingOrDoubledCommas) {
    // A hand-rolled writer's characteristic failure is a comma before the first
    // member of a nested object, or two in a row after one.  Both are invalid
    // JSON and both survive every EXPECT that only greps for keys.
    ab::BasisReportRequest req;
    req.basis = iphoneLikeRequest();
    req.haveLensPose = true;
    req.lensPose.q[3] = 1.0;
    req.lensPose.reference = ab::LensPoseReference::Gyroscope;
    req.haveReferenceIndex = true;
    req.referenceBasisIndex = 8;

    const std::string json = ab::basisReportToJson(ab::buildBasisReport(req));

    ASSERT_FALSE(json.empty());
    EXPECT_EQ(json.front(), '{');
    EXPECT_EQ(json.back(), '}');
    EXPECT_FALSE(contains(json, ",,")) << json;
    EXPECT_FALSE(contains(json, "{,")) << json;
    EXPECT_FALSE(contains(json, ",}")) << json;
    EXPECT_FALSE(contains(json, "[,")) << json;
    EXPECT_FALSE(contains(json, ",]")) << json;
    EXPECT_FALSE(contains(json, ":,")) << json;

    int depth = 0;
    int brackets = 0;
    bool inStr = false;
    bool esc = false;
    for (const char c : json) {
        if (inStr) {
            if (esc) { esc = false; continue; }
            if (c == '\\') { esc = true; continue; }
            if (c == '"') inStr = false;
            continue;
        }
        if (c == '"') { inStr = true; continue; }
        if (c == '{') ++depth;
        if (c == '}') --depth;
        if (c == '[') ++brackets;
        if (c == ']') --brackets;
        ASSERT_GE(depth, 0) << json;
        ASSERT_GE(brackets, 0) << json;
    }
    EXPECT_EQ(depth, 0) << json;
    EXPECT_EQ(brackets, 0) << json;
    EXPECT_FALSE(inStr) << json;
}
