// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_basis.cpp — implementation.  See the header for the WHY
// (the GL-vs-CV trap, the three-factor derivation, the falsification plan);
// this file carries the arithmetic and the handful of places where the
// arithmetic has a trap in it.

#include "rnis_pano_android_basis.hpp"

#include "rnis_pano_attitude.hpp"

#include <cmath>

namespace rnis {
namespace pano {
namespace android {

namespace {

// Every matrix that reaches `basisIndexForMatrix` is built from integers by
// construction (integer sin/cos, ±1 entries, integer matrix products), so this
// is an EQUALITY test with slack for nothing but a rounding mode.  It is
// deliberately far tighter than any physical tolerance: a "close enough" match
// here would be the one place a wrong basis could enter without a residual to
// report it.
constexpr double kExactEps = 1e-9;

void mat3Mul(const double a[9], const double b[9], double out[9]) {
    rnis::pano::detail::matMul(a, b, out);
}

bool finite4(const double q[4]) {
    return std::isfinite(q[0]) && std::isfinite(q[1])
        && std::isfinite(q[2]) && std::isfinite(q[3]);
}

}  // namespace

const double kDefaultPoseResidualDegThreshold = 2.0;

const char* derivedBasisProvenanceName() {
    // A FOURTH value beside rnis::pano::BasisProvenance's three, deliberately
    // NOT added to that enum: the enum is compiled into the shipped, field-
    // validated iOS arm, and widening it there to describe a state only Android
    // can be in would be a change to the wrong file.  The string is what rides
    // the pack, and the pack is where the distinction has to survive.
    return "derived";
}

const char* lensFacingName(LensFacing f) {
    switch (f) {
        case LensFacing::Front:    return "front";
        case LensFacing::Back:     return "back";
        case LensFacing::External: return "external";
    }
    return "unknown";
}

const char* recorderRotationName(RecorderRotation r) {
    switch (r) {
        case RecorderRotation::RawSensorBuffer:             return "raw-sensor-buffer";
        case RecorderRotation::UprightInNaturalOrientation: return "upright-in-natural-orientation";
        case RecorderRotation::UprightForDisplayRotation:   return "upright-for-display-rotation";
        case RecorderRotation::Explicit:                    return "explicit";
    }
    return "unknown";
}

const char* lensPoseReferenceName(LensPoseReference r) {
    switch (r) {
        case LensPoseReference::PrimaryCamera: return "primary-camera";
        case LensPoseReference::Gyroscope:     return "gyroscope";
        case LensPoseReference::Undefined:     return "undefined";
        case LensPoseReference::Automotive:    return "automotive";
    }
    return "unknown";
}

const char* poseQuatSenseName(PoseQuatSense s) {
    switch (s) {
        case PoseQuatSense::DeviceFromCamera: return "device-from-camera";
        case PoseQuatSense::CameraFromDevice: return "camera-from-device";
    }
    return "unknown";
}

namespace detail {

int normalizeDeg360(int deg) {
    // `%` on a negative left operand is implementation-defined before C++11 and
    // truncates toward zero after it — either way `-90 % 360` is `-90`, not
    // `270`.  A basis derived from a negative "clockwise" angle would be a 180°
    // roll away from the truth, which is the exact defect this file's header
    // warns about, arrived at from the other direction.
    int r = deg % 360;
    if (r < 0) r += 360;
    return r;
}

bool isQuarterTurn(int deg) {
    return normalizeDeg360(deg) % 90 == 0;
}

bool imageRollMatrix(int cwDeg, double m[9]) {
    if (m == nullptr || !isQuarterTurn(cwDeg)) return false;
    const int q = normalizeDeg360(cwDeg) / 90;   // 0..3

    // EXACT, from a table rather than std::cos/std::sin.  cos(M_PI/2) is
    // 6.1e-17, not 0, and a 6e-17 in a matrix that is then compared for
    // membership in the basis table would either need a tolerance (which hides
    // real errors) or fail outright.
    static const int kCos[4] = {1, 0, -1, 0};
    static const int kSin[4] = {0, 1, 0, -1};
    const double c = (double)kCos[q];
    const double s = (double)kSin[q];

    // G(θ) = R_z(−θ) in the GL camera frame.  The sign is the whole subtlety:
    // rotating the IMAGE clockwise sends image-right toward image-DOWN, and GL
    // +Y is image-UP, so the induced rotation about +Z is NEGATIVE.  Verified
    // against pixel arithmetic in the test file
    // (AndroidBasisRoll.ClockwiseNinetySendsImageRightToImageDown).
    m[0] =  c;  m[1] =  s;  m[2] = 0.0;
    m[3] = -s;  m[4] =  c;  m[5] = 0.0;
    m[6] = 0.0; m[7] = 0.0; m[8] = 1.0;
    return true;
}

bool uprightBasisMatrix(LensFacing facing, double m[9]) {
    if (m == nullptr) return false;
    // `m` is written ONLY on success, matching imageRollMatrix: a caller that
    // ignores the bool must not pick up a zeroed matrix (det 0) and carry it
    // into a multiplication that then produces a silently degenerate basis.
    if (facing != LensFacing::Back && facing != LensFacing::Front) return false;
    for (int i = 0; i < 9; ++i) m[i] = 0.0;
    switch (facing) {
        case LensFacing::Back:
            // Image-right → device +X, image-up → device +Y, and GL's +Z
            // (BACKWARD, toward the viewer) → device +Z because the lens looks
            // out the back of the phone.  Identity.
            m[0] = 1.0; m[4] = 1.0; m[8] = 1.0;
            return true;
        case LensFacing::Front:
            // The optical axis reverses, so GL +Z → device −Z.  Right-handedness
            // (X × Y = Z) then FORCES image-right onto device −X once image-up
            // is device +Y — which is also the physical truth of an UNMIRRORED
            // selfie raster: the subject's right hand lands on the viewer's
            // left.  A recorder that mirrors the buffer breaks this, which is
            // why `mirrored` is a refusal and not a fifth case.
            m[0] = -1.0; m[4] = 1.0; m[8] = -1.0;
            return true;
        case LensFacing::External:
            return false;
    }
    return false;
}

int basisIndexForMatrix(const double m[9]) {
    if (m == nullptr) return -1;
    const int n = rnis::pano::basisCandidateCount();
    for (int i = 0; i < n; ++i) {
        double c[9];
        if (!rnis::pano::basisMatrix(i, c)) continue;
        bool same = true;
        for (int k = 0; k < 9; ++k) {
            if (std::fabs(c[k] - m[k]) > kExactEps) { same = false; break; }
        }
        if (same) return i;
    }
    return -1;
}

int backLensUprightRotationForDisplay(int sensorOrientationDeg,
                                      int displayRotationDeg) {
    return normalizeDeg360(sensorOrientationDeg - displayRotationDeg);
}

}  // namespace detail

BasisDerivation deriveBasis(const BasisRequest& req) {
    BasisDerivation out;

    // ── The characteristic itself, before anything is derived from it ───────
    //
    // Two distinct refusals because they send an operator to two different
    // places: a negative value is the `-1` sentinel, i.e. nobody read
    // SENSOR_ORIENTATION at all; a non-quarter-turn value means the
    // characteristic was read and returned something outside its own contract,
    // which is a HAL bug worth a bug report.  Collapsing them into one string
    // would hide the first case behind the second's diagnosis.
    if (req.sensorOrientationDeg < 0) {
        out.refusal = "sensor-orientation-not-read";
        return out;
    }
    if (req.sensorOrientationDeg >= 360 || req.sensorOrientationDeg % 90 != 0) {
        out.refusal = "sensor-orientation-not-multiple-of-90";
        return out;
    }

    if (req.facing == LensFacing::External) {
        // LENS_FACING_EXTERNAL: a USB camera's mounting relative to THIS phone's
        // IMU is not a property of either device.  There is nothing to derive
        // and no default that is not a guess.
        out.refusal = "external-lens-facing-unknown-mounting";
        return out;
    }

    // ── What the recorder did to the pixels ────────────────────────────────
    int applied = -1;
    switch (req.recorder) {
        case RecorderRotation::RawSensorBuffer:
            applied = 0;
            break;

        case RecorderRotation::UprightInNaturalOrientation:
            applied = req.sensorOrientationDeg;
            break;

        case RecorderRotation::UprightForDisplayRotation:
            if (req.facing == LensFacing::Front) {
                // The AOSP formula for the front lens is
                //     r = (360 − ((sensorOrientation + display) % 360)) % 360
                // and that final subtraction exists to COMPENSATE A MIRROR the
                // preview applies.  From outside the recorder the rotation and
                // the mirror are not separable, and a rotation-only model of a
                // rotate-then-mirror pipeline is a reflection wearing a
                // rotation's clothes.  `Explicit` is the way through: state the
                // angle applied and whether the pixels were flipped.
                out.refusal = "front-display-rotation-convention-ambiguous";
                return out;
            }
            if (req.displayRotationDeg < 0 || req.displayRotationDeg >= 360
                || req.displayRotationDeg % 90 != 0) {
                out.refusal = "display-rotation-not-multiple-of-90";
                return out;
            }
            applied = detail::backLensUprightRotationForDisplay(
                req.sensorOrientationDeg, req.displayRotationDeg);
            break;

        case RecorderRotation::Explicit:
            // Negatives ARE accepted here, unlike SENSOR_ORIENTATION: an
            // explicit −90 is an unambiguous statement by the recorder about
            // what it did, not a missing read.
            if (!detail::isQuarterTurn(req.explicitRotationCwDeg)) {
                out.refusal = "explicit-rotation-not-multiple-of-90";
                return out;
            }
            applied = detail::normalizeDeg360(req.explicitRotationCwDeg);
            break;

        default:
            // An enum value from outside the enumeration — a JNI shim passing a
            // raw int through, most likely.  Refused rather than defaulted to
            // `RawSensorBuffer`, because defaulting would make a typo look like
            // a deliberate choice.
            out.refusal = "recorder-rotation-unknown";
            return out;
    }

    out.appliedRotationCwDeg  = applied;
    out.residualRotationCwDeg =
        detail::normalizeDeg360(req.sensorOrientationDeg - applied);

    if (req.mirrored) {
        // A horizontal flip has determinant −1.  It is not a poor fit to the 24
        // candidates, it is OUTSIDE the group they generate: no rotation equals
        // a reflection.  Rounding to the nearest candidate would mirror the
        // canvas and every scalar in the pack would stay plausible.
        //
        // The two angles above are still reported: they are observed facts
        // about the request and the operator needs them to see the whole
        // configuration.  `matrixValid` stays false because the placeholder
        // identity in `m` is NOT the answer.
        out.refusal = "mirrored-buffer-is-a-reflection";
        return out;
    }

    double up[9];
    if (!detail::uprightBasisMatrix(req.facing, up)) {
        // Unreachable given the External check above; kept because a new
        // LensFacing value must fail loudly here rather than silently reuse the
        // back lens's identity.
        out.refusal = "lens-facing-unknown";
        return out;
    }

    double roll[9];
    if (!detail::imageRollMatrix(out.residualRotationCwDeg, roll)) {
        out.refusal = "residual-rotation-not-multiple-of-90";
        return out;
    }

    mat3Mul(up, roll, out.m);
    out.matrixValid = true;

    const int idx = detail::basisIndexForMatrix(out.m);
    if (idx < 0) {
        // IMPOSSIBLE BY CONSTRUCTION: a product of two det-+1 signed
        // permutations is a det-+1 signed permutation, and the engine's table
        // holds all 24 of them.  If this ever fires, the engine's enumeration
        // changed under this file — which is exactly why the index comes from a
        // SEARCH of that table and not from a local lookup table that would
        // have kept returning stale indices without a word.
        out.refusal = "derived-matrix-not-in-basis-table";
        return out;
    }

    out.ok      = true;
    out.index   = idx;
    out.label   = rnis::pano::basisLabel(idx);
    out.refusal = "none";
    return out;
}

PoseRotationFit nearestBasis(const double q[4], double thresholdDeg) {
    PoseRotationFit out;
    out.thresholdDeg = thresholdDeg;

    if (q == nullptr) {
        out.refusal = "null-quaternion";
        return out;
    }
    if (!std::isfinite(thresholdDeg) || thresholdDeg < 0.0) {
        out.refusal = "invalid-threshold";
        return out;
    }
    if (!finite4(q)) {
        out.refusal = "non-finite-quaternion";
        return out;
    }

    double qn[4] = {q[0], q[1], q[2], q[3]};
    const double norm = std::sqrt(qn[0] * qn[0] + qn[1] * qn[1]
                                + qn[2] * qn[2] + qn[3] * qn[3]);
    if (!(norm > 1e-12)) {
        // A zero quaternion is what a default-constructed float[4] that nobody
        // filled looks like.  Normalising it produces NaN and the nearest-basis
        // search would then return index 0 with a NaN residual — a plausible
        // answer built from nothing.
        out.refusal = "degenerate-quaternion";
        return out;
    }
    for (int i = 0; i < 4; ++i) qn[i] /= norm;

    rnis::pano::detail::quatToMat(qn, out.m);
    out.matrixValid = true;

    int    bestIdx = -1,  secondIdx = -1;
    double bestDeg = 0.0, secondDeg = 0.0;

    const int n = rnis::pano::basisCandidateCount();
    for (int i = 0; i < n; ++i) {
        double c[9];
        if (!rnis::pano::basisMatrix(i, c)) continue;
        double cq[4];
        rnis::pano::detail::matToQuat(c, cq);
        const double d = rnis::pano::detail::quatDeltaDeg(qn, cq);

        // STRICT `<` with an ascending scan: the answer is a deterministic
        // function of the input, and a BIT-EXACT tie keeps the lower index.
        //
        // ⚠ THAT IS A WEAKER GUARANTEE THAN IT LOOKS, and the test file measured
        // it: an input 45° about +Z is MATHEMATICALLY equidistant from
        // candidates 0 and 9, yet the two residuals differ in their last bits
        // and candidate 9 wins.  So the tie-break decides nothing an operator
        // should rely on — `marginDeg` is the field that says an answer was
        // arbitrary, and it must be read before believing `nearestIndex`.
        //
        // There is no separate margin GATE because the residual threshold
        // subsumes it: the candidates are 90° apart, so a small margin requires
        // a residual near 45°, which any sane threshold has already refused.
        if (bestIdx < 0 || d < bestDeg) {
            secondIdx = bestIdx;  secondDeg = bestDeg;
            bestIdx   = i;        bestDeg   = d;
        } else if (secondIdx < 0 || d < secondDeg) {
            secondIdx = i;        secondDeg = d;
        }
    }

    if (bestIdx < 0) {
        out.refusal = "basis-table-empty";
        return out;
    }

    out.nearestIndex  = bestIdx;
    out.nearestLabel  = rnis::pano::basisLabel(bestIdx);
    out.residualDeg   = bestDeg;
    out.runnerUpIndex = secondIdx;
    out.runnerUpLabel = rnis::pano::basisLabel(secondIdx);
    out.runnerUpDeg   = secondDeg;
    out.marginDeg     = secondDeg - bestDeg;

    if (bestDeg > thresholdDeg) {
        // A real rotation this far from every axis permutation means the
        // 24-candidate model does not fit this device.  Snapping to the nearest
        // would apply `bestDeg` degrees of systematic error to every frame —
        // ~11.7 canvas px per degree — while reporting a validated basis.
        // `index` stays −1; `nearestIndex` carries what was refused.
        out.refusal = "residual-exceeds-threshold";
        return out;
    }

    out.ok      = true;
    out.index   = bestIdx;
    out.label   = out.nearestLabel;
    out.refusal = "none";
    return out;
}

LensPoseFit basisFromLensPoseRotation(const LensPoseRequest& req) {
    LensPoseFit out;
    out.reference              = req.reference;
    out.sense                  = req.sense;
    out.cameraFrameAdjustIndex = req.cameraFrameAdjustIndex;
    out.fit.thresholdDeg       = req.thresholdDeg;
    // Set up front so the echo is complete on EVERY refusal path, not only the
    // ones that got as far as validating it.  `basisLabel` already answers
    // "invalid" for an out-of-range index, so this cannot manufacture a label.
    out.cameraFrameAdjustLabel =
        rnis::pano::basisLabel(req.cameraFrameAdjustIndex);

    // ── The gate that stops a different quantity wearing this one's name ────
    //
    // LENS_POSE_REFERENCE is not decoration.  `PRIMARY_CAMERA` means the pose
    // is measured against ANOTHER CAMERA, so it is a camera→camera rotation and
    // has nothing to do with the IMU frame; feeding it in would produce a
    // confident, exactly-on-axis, completely wrong basis (it is typically the
    // identity, i.e. index 0, which is also a perfectly legal answer).
    // `UNDEFINED` means the HAL published nothing.
    switch (req.reference) {
        case LensPoseReference::Gyroscope:
            break;
        case LensPoseReference::PrimaryCamera:
            out.fit.refusal = "lens-pose-reference-primary-camera";
            return out;
        case LensPoseReference::Undefined:
            out.fit.refusal = "lens-pose-reference-undefined";
            return out;
        case LensPoseReference::Automotive:
            out.fit.refusal = "lens-pose-reference-automotive";
            return out;
        default:
            out.fit.refusal = "lens-pose-reference-unknown";
            return out;
    }

    double adjust[9];
    if (!rnis::pano::basisMatrix(req.cameraFrameAdjustIndex, adjust)) {
        out.fit.refusal = "camera-frame-adjust-index-out-of-range";
        return out;
    }

    if (!finite4(req.q)) {
        out.fit.refusal = "non-finite-quaternion";
        return out;
    }
    double qn[4] = {req.q[0], req.q[1], req.q[2], req.q[3]};
    const double norm = std::sqrt(qn[0] * qn[0] + qn[1] * qn[1]
                                + qn[2] * qn[2] + qn[3] * qn[3]);
    if (!(norm > 1e-12)) {
        out.fit.refusal = "degenerate-quaternion";
        return out;
    }
    for (int i = 0; i < 4; ++i) qn[i] /= norm;

    double r[9];
    rnis::pano::detail::quatToMat(qn, r);
    if (req.sense == PoseQuatSense::CameraFromDevice) {
        // Transpose in place — for a rotation this IS the inverse, and doing it
        // by transpose rather than by conjugating the quaternion keeps the two
        // senses byte-identical in the arithmetic that follows.
        double t[9];
        for (int row = 0; row < 3; ++row)
            for (int col = 0; col < 3; ++col) t[row * 3 + col] = r[col * 3 + row];
        for (int i = 0; i < 9; ++i) r[i] = t[i];
    }

    // C = R_device←lensPoseCam · R_lensPoseCam←engineCam
    double c[9];
    mat3Mul(r, adjust, c);

    double cq[4];
    rnis::pano::detail::matToQuat(c, cq);

    const PoseRotationFit fit = nearestBasis(cq, req.thresholdDeg);
    // Preserve the echo fields already set; take the whole fit otherwise.
    out.fit = fit;
    return out;
}

}  // namespace android
}  // namespace pano
}  // namespace rnis
