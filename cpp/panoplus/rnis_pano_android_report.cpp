// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_report.cpp — see the header for why this is not in the JNI
// shim.

#include "rnis_pano_android_report.hpp"

#include "rnis_pano_attitude.hpp"

#include <cmath>
#include <cstdio>
#include <string>

namespace rnis {
namespace pano {
namespace android {

namespace {

// ── JSON primitives, mirroring rnis_pano_replay.cpp's writers exactly ───────
// Same precisions (%.9g / %lld) and the same non-finite rule, so a basis block
// and a replay block in the same log are textually comparable rather than
// merely both "JSON".

void appendNum(std::string& s, double v) {
    if (!std::isfinite(v)) { s += "null"; return; }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    s += buf;
}

void appendInt(std::string& s, long long v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", v);
    s += buf;
}

void appendJsonString(std::string& s, const char* v) {
    s += '"';
    if (v != nullptr) {
        for (const char* p = v; *p != '\0'; ++p) {
            const unsigned char c = (unsigned char)*p;
            switch (c) {
                case '"':  s += "\\\""; break;
                case '\\': s += "\\\\"; break;
                case '\n': s += "\\n";  break;
                case '\r': s += "\\r";  break;
                case '\t': s += "\\t";  break;
                default:
                    if (c < 0x20) {
                        char b[8];
                        std::snprintf(b, sizeof(b), "\\u%04x", c);
                        s += b;
                    } else {
                        s += (char)c;
                    }
            }
        }
    }
    s += '"';
}

/// Row-major 3×3 multiply: `out = a^T · b`.
void mulTransposeLeft(const double a[9], const double b[9], double out[9]) {
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            double acc = 0.0;
            // a^T[r][k] == a[k][r] == a[k*3 + r]
            for (int k = 0; k < 3; ++k) acc += a[k * 3 + r] * b[k * 3 + c];
            out[r * 3 + c] = acc;
        }
    }
}

/// Axis-angle of a rotation matrix, row-major.  `axis` is unit-length on
/// return, or (0,0,0) when the angle is ~0 (where the axis is undefined and
/// inventing one would be a lie the caller cannot see).
///
/// The 180° branch is separate BECAUSE the usual skew-symmetric extraction
/// divides by `sin θ`, which is exactly 0 there — and 180° is the single most
/// likely disagreement this function will ever be handed (the CV-vs-GL
/// misreading the basis header warns about is exactly a 180° roll).  Getting
/// the common case wrong by dividing by zero would produce a NaN axis and an
/// "off-axis" diagnosis for the one fault the diagnosis exists to name.
void axisAngle(const double m[9], double* angleDeg, double axis[3]) {
    axis[0] = axis[1] = axis[2] = 0.0;
    const double trace = m[0] + m[4] + m[8];
    double c = (trace - 1.0) * 0.5;
    if (c > 1.0) c = 1.0;
    if (c < -1.0) c = -1.0;
    const double theta = std::acos(c);
    *angleDeg = theta * 180.0 / 3.14159265358979323846;

    const double sinTheta = std::sin(theta);
    if (sinTheta > 1e-9) {
        const double k = 1.0 / (2.0 * sinTheta);
        axis[0] = (m[7] - m[5]) * k;
        axis[1] = (m[2] - m[6]) * k;
        axis[2] = (m[3] - m[1]) * k;
    } else if (c < 0.0) {
        // θ ≈ 180°: R = 2·a·aᵀ − I, so the diagonal gives |aᵢ|.  Take the
        // LARGEST component positive (the axis sign is arbitrary at 180°) and
        // let its row fix the other two signs exactly.
        const double d[3] = {(m[0] + 1.0) * 0.5, (m[4] + 1.0) * 0.5, (m[8] + 1.0) * 0.5};
        int best = 0;
        for (int i = 1; i < 3; ++i) if (d[i] > d[best]) best = i;
        const double ab = (d[best] > 0.0) ? std::sqrt(d[best]) : 0.0;
        if (ab > 1e-9) {
            axis[best] = ab;
            for (int i = 0; i < 3; ++i) {
                if (i == best) continue;
                axis[i] = m[best * 3 + i] / (2.0 * ab);
            }
        }
    }
    // θ ≈ 0 leaves the axis at (0,0,0) on purpose.

    double n = std::sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
    if (n > 1e-9) { axis[0] /= n; axis[1] /= n; axis[2] /= n; }
}

}  // namespace


BasisAgreement compareDerivedWithReference(int derivedIndex, int referenceIndex) {
    BasisAgreement a;
    double cd[9];
    double cr[9];
    // basisMatrix() range-checks and leaves the buffer untouched out of range,
    // so an invalid index cannot reach the arithmetic as stale stack.
    if (!basisMatrix(derivedIndex, cd) || !basisMatrix(referenceIndex, cr)) {
        a.diagnosis = "not-comparable-index-out-of-range";
        a.derivedIndex = derivedIndex;
        a.referenceIndex = referenceIndex;
        return a;
    }

    a.comparable = true;
    a.derivedIndex = derivedIndex;
    a.referenceIndex = referenceIndex;
    a.derivedLabel = basisLabel(derivedIndex);
    a.referenceLabel = basisLabel(referenceIndex);

    if (derivedIndex == referenceIndex) {
        a.agree = true;
        a.relativeAngleDeg = 0.0;
        a.diagnosis = "agree";
        return a;
    }

    // C_derived^T · C_reference maps the reference camera frame onto the
    // derived one, so its axis is expressed in CAMERA coordinates and "+Z" is
    // the optical axis.
    double rel[9];
    mulTransposeLeft(cd, cr, rel);
    axisAngle(rel, &a.relativeAngleDeg, a.relativeAxis);

    a.aboutOpticalAxis = std::fabs(a.relativeAxis[2]) > 0.999
        && std::fabs(a.relativeAxis[0]) < 0.03
        && std::fabs(a.relativeAxis[1]) < 0.03;

    // ── The GL-vs-CV signature is diag(1,−1,−1), and its axis is X, not Z ───
    //
    // rnis_pano_android_basis.hpp calls this difference "a 180° roll about the
    // optical axis".  The MATRIX it names is right and the axis is not, and the
    // distinction matters here because it is what the diagnosis keys on: going
    // from GL (+Y up, +Z backward) to CV (+Y down, +Z forward) flips Y and Z
    // and fixes X, which is a 180° rotation ABOUT X.  A roll about the optical
    // axis would be diag(−1,−1,+1) — a different mistake with a different fix.
    //
    // Measured, not assumed: basis 8 (the field-measured iPhone answer) against
    // basis 11 (what the CV misreading produces) comes out axis (1,0,0) at
    // 180.0°, which is what `TheCvMisreadingIsAOneEightyAboutX` pins.  So the
    // test is an equality against the exact matrix rather than an axis
    // heuristic — every entry on both sides is an integer.
    const double kFlipYZ[9] = {1, 0, 0, 0, -1, 0, 0, 0, -1};
    bool isGlCvFlip = true;
    for (int i = 0; i < 9; ++i) {
        if (std::fabs(rel[i] - kFlipYZ[i]) > 1e-9) { isGlCvFlip = false; break; }
    }

    if (isGlCvFlip) {
        a.diagnosis = "flip-yz-check-gl-vs-cv-camera-convention";
    } else if (a.aboutOpticalAxis && std::fabs(a.relativeAngleDeg - 180.0) < 1.0) {
        a.diagnosis = "roll-180-check-recorder-applied-rotation";
    } else if (a.aboutOpticalAxis && std::fabs(a.relativeAngleDeg - 90.0) < 1.0) {
        a.diagnosis = "roll-90-check-recorder-applied-rotation";
    } else if (a.aboutOpticalAxis) {
        a.diagnosis = "roll-other-check-recorder-applied-rotation";
    } else {
        a.diagnosis = "off-axis-check-lens-facing-or-sensor-frame";
    }
    return a;
}

BasisReport buildBasisReport(const BasisReportRequest& req) {
    BasisReport out;
    out.request = req.basis;
    out.derivation = deriveBasis(req.basis);
    out.provenance = derivedBasisProvenanceName();

    if (req.haveLensPose) {
        out.haveLensPose = true;
        out.lensPose = basisFromLensPoseRotation(req.lensPose);
    }

    // The agreement is computed against whichever index the DERIVATION
    // produced — so a refused derivation (index −1) yields "not comparable"
    // rather than a comparison against a number it never earned.
    if (req.haveReferenceIndex) {
        out.haveAgreement = true;
        out.agreement =
            compareDerivedWithReference(out.derivation.index, req.referenceBasisIndex);
    }
    return out;
}

std::string basisReportToJson(const BasisReport& r) {
    std::string s;
    s.reserve(2048);

    bool first = true;
    const auto key = [&](const char* k) {
        if (!first) s += ",";
        first = false;
        s += "\""; s += k; s += "\":";
    };
    const auto strField = [&](const char* k, const char* v) {
        key(k); appendJsonString(s, v);
    };
    const auto intField = [&](const char* k, long long v) { key(k); appendInt(s, v); };
    const auto numField = [&](const char* k, double v) { key(k); appendNum(s, v); };
    const auto boolField = [&](const char* k, bool v) {
        key(k); s += (v ? "true" : "false");
    };
    const auto mat9 = [&](const char* k, const double* m) {
        key(k); s += "[";
        for (int i = 0; i < 9; ++i) { if (i) s += ","; appendNum(s, m[i]); }
        s += "]";
    };
    const auto vec = [&](const char* k, const double* v, int n) {
        key(k); s += "[";
        for (int i = 0; i < n; ++i) { if (i) s += ","; appendNum(s, v[i]); }
        s += "]";
    };

    s += "{";

    // ── THE FALSIFICATION CHECKLIST, verbatim from the basis header ─────────
    // Every field named under "WHAT THE RECORDER MUST LOG" is here, echoed
    // whether or not it was read, because the comparison it enables happens
    // after the phone is back on a desk.
    intField("sensorOrientationDeg", r.request.sensorOrientationDeg);
    strField("lensFacing", lensFacingName(r.request.facing));
    intField("lensFacingValue", (long long)(int)r.request.facing);
    strField("recorderConvention", recorderRotationName(r.request.recorder));
    intField("displayRotationDeg", r.request.displayRotationDeg);
    intField("explicitRotationCwDeg", r.request.explicitRotationCwDeg);
    boolField("mirrored", r.request.mirrored);

    boolField("ok", r.derivation.ok);
    intField("basisIndex", r.derivation.index);
    strField("basisLabel", r.derivation.label);
    strField("refusal", r.derivation.refusal);
    intField("appliedRotationCwDeg", r.derivation.appliedRotationCwDeg);
    intField("residualRotationCwDeg", r.derivation.residualRotationCwDeg);
    boolField("matrixValid", r.derivation.matrixValid);
    mat9("basisMatrix", r.derivation.m);

    // A DERIVED basis is not `measured` and not `caller-supplied`.  The pack
    // writer reads this string from here rather than choosing one.
    strField("basisProvenance", r.provenance);

    // ── LENS_POSE_ROTATION route ───────────────────────────────────────────
    boolField("haveLensPose", r.haveLensPose);
    if (r.haveLensPose) {
        key("lensPose"); s += "{";
        first = true;   // nested scope: the first inner field emits no comma
        strField("reference", lensPoseReferenceName(r.lensPose.reference));
        strField("quatSense", poseQuatSenseName(r.lensPose.sense));
        intField("cameraFrameAdjustIndex", r.lensPose.cameraFrameAdjustIndex);
        strField("cameraFrameAdjustLabel", r.lensPose.cameraFrameAdjustLabel);
        boolField("ok", r.lensPose.fit.ok);
        intField("index", r.lensPose.fit.index);
        strField("label", r.lensPose.fit.label);
        strField("refusal", r.lensPose.fit.refusal);
        intField("nearestIndex", r.lensPose.fit.nearestIndex);
        strField("nearestLabel", r.lensPose.fit.nearestLabel);
        numField("residualDeg", r.lensPose.fit.residualDeg);
        intField("runnerUpIndex", r.lensPose.fit.runnerUpIndex);
        strField("runnerUpLabel", r.lensPose.fit.runnerUpLabel);
        numField("runnerUpDeg", r.lensPose.fit.runnerUpDeg);
        numField("marginDeg", r.lensPose.fit.marginDeg);
        numField("thresholdDeg", r.lensPose.fit.thresholdDeg);
        boolField("matrixValid", r.lensPose.fit.matrixValid);
        mat9("matrix", r.lensPose.fit.m);
        s += "}";
        first = false;  // back in the outer object, which is non-empty by now
    }

    // ── derived vs measured ────────────────────────────────────────────────
    boolField("haveAgreement", r.haveAgreement);
    if (r.haveAgreement) {
        key("agreement"); s += "{";
        first = true;   // nested scope: the first inner field emits no comma
        boolField("comparable", r.agreement.comparable);
        boolField("agree", r.agreement.agree);
        intField("derivedIndex", r.agreement.derivedIndex);
        strField("derivedLabel", r.agreement.derivedLabel);
        intField("referenceIndex", r.agreement.referenceIndex);
        strField("referenceLabel", r.agreement.referenceLabel);
        numField("relativeAngleDeg", r.agreement.relativeAngleDeg);
        vec("relativeAxis", r.agreement.relativeAxis, 3);
        boolField("aboutOpticalAxis", r.agreement.aboutOpticalAxis);
        strField("diagnosis", r.agreement.diagnosis);
        s += "}";
        first = false;  // back in the outer object, which is non-empty by now
    }

    s += "}";
    return s;
}

}  // namespace android
}  // namespace pano
}  // namespace rnis
