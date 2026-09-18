// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_report — the basis derivation AS A REPORT: JSON out, plus
// the derived-vs-measured comparison the derivation's own falsification plan
// asks for.
//
// ── Why this is a separate file and not four lines inside the JNI shim ──────
//
// The obvious place to build this JSON is the JNI translation unit, because
// that is the only caller.  It is also the one place in the repo where NOTHING
// can be tested: the JNI shim needs `<jni.h>`, so it compiles under the NDK and
// nowhere else, and a serialiser that drops a field or emits a bare `nan` would
// reach the operator as an empty panel on a phone in an aisle with no way to
// find out why.  `JSON.parse` on `NaN` throws, and the throw happens in JS,
// three layers from the mistake.
//
// So the marshalling lives HERE, in the same platform-free C++17 the engine and
// the derivation are written in, and the host gtest suite asserts on the exact
// bytes today.  The JNI entry is then a string hand-off with no logic in it —
// which is the only kind of JNI code that is safe to not be able to test.
//
// ── What the report is FOR ──────────────────────────────────────────────────
//
// rnis_pano_android_basis.hpp's header ends with a checklist titled "WHAT THE
// RECORDER MUST LOG so the operator can check it in one sweep", and warns that
// without any one of those fields the derived-vs-measured comparison cannot be
// made after the fact.  A checklist in a comment is a checklist nobody runs.
// `basisReportToJson` emits every field on it, and
// `Report.CarriesEveryFieldTheFalsificationChecklistDemands` fails if a future
// edit drops one.
//
// ── The comparison, and why it is arithmetic rather than a bug report ───────
//
// The same header explains that when the DERIVED index disagrees with a
// MEASURED one, the disagreement itself localises the fault: a 90° roll means
// the recorder rotated pixels without saying so, a 180° roll means someone
// rebuilt the derivation in the CV convention, anything else points at the lens
// facing or the sensor frame.  `compareDerivedWithReference` computes that
// instead of leaving it to whoever reads two integers on a phone screen at the
// end of a field trip — the relative rotation `C_derived^T · C_reference` is a
// rotation IN THE CAMERA FRAME, so "is it a roll about the optical axis" is a
// question about its axis, and the answer is exact for permutation matrices.
//
// ⚠ WHAT THE DIAGNOSIS IS NOT: evidence about which of the two is RIGHT.  It
// names the KIND of disagreement, and the derivation's own header is explicit
// that on a disagreement the MEASURED index wins.  The strings are worded to
// say what to go and check, never "the derivation is correct".
//
// STL ONLY.  No OpenCV, no JNI, no Android header — the host test target for
// this file withholds OpenCV on purpose, so a stray include fails HERE rather
// than as an NDK link error on the Android leg months later.

#ifndef RNIS_PANO_ANDROID_REPORT_HPP
#define RNIS_PANO_ANDROID_REPORT_HPP

#include <string>

#include "rnis_pano_android_basis.hpp"

namespace rnis {
namespace pano {
namespace android {

/// How a DERIVED basis index relates to a REFERENCE one (a `selectBasis()`
/// winner from a concurrent log, or an index carried by an earlier pack).
///
/// `comparable` is false when either index is outside `[0, 24)`.  On that path
/// every other field stays at its "nothing observed" value rather than
/// defaulting to agreement — the failure this guards is a panel that reads
/// "agree" because both sides were absent.
struct BasisAgreement {
    bool comparable = false;
    bool agree = false;

    int         derivedIndex   = -1;
    int         referenceIndex = -1;
    const char* derivedLabel   = "invalid";
    const char* referenceLabel = "invalid";

    /// The rotation taking the reference camera frame onto the derived one,
    /// as axis-angle.  Degrees, in `[0, 180]`.  Exact for permutation matrices.
    double relativeAngleDeg = 0.0;
    double relativeAxis[3]  = {0.0, 0.0, 0.0};

    /// True when `relativeAxis` is ±Z, i.e. the disagreement is a pure roll
    /// about the optical axis — the signature of a recorder that rotated the
    /// buffer without saying so.
    ///
    /// ⚠ THIS IS **NOT** THE GL-vs-CV SIGNATURE, despite what the basis
    /// header's prose says.  That one is `diag(1, −1, −1)`, whose axis is X:
    /// GL→CV flips Y and Z and fixes X.  Measured, not argued — basis 8 vs
    /// basis 11 comes out axis (1,0,0) at 180°.  `diagnosis` tests for it by
    /// exact matrix equality rather than through this flag.
    bool aboutOpticalAxis = false;

    /// Stable, greppable, lowercase-hyphen.  Names the KIND of disagreement
    /// and what to go and check — never which side is right.
    const char* diagnosis = "not-compared";
};

/// Compare two basis indices.  PURE.  Never throws, never allocates.
BasisAgreement compareDerivedWithReference(int derivedIndex, int referenceIndex);

/// One report request: the derivation, plus the two OPTIONAL cross-checks.
///
/// Both cross-checks are opt-in and are reported as absent when not asked for,
/// rather than as a fit against a zero quaternion or an agreement with index 0
/// — either of which would be a plausible-looking answer to a question nobody
/// asked.
struct BasisReportRequest {
    BasisRequest basis;

    /// `CameraCharacteristics.LENS_POSE_ROTATION` route — the device's own
    /// measurement of its own mounting, when the HAL publishes one.
    bool            haveLensPose = false;
    LensPoseRequest lensPose;

    /// A `selectBasis()` winner (or a previously recorded index) to compare
    /// the derivation against — the falsification sweep's other half.
    bool haveReferenceIndex   = false;
    int  referenceBasisIndex  = -1;
};

/// Everything the request produced.  Nothing here is inferred.
struct BasisReport {
    BasisRequest    request;
    BasisDerivation derivation;

    bool        haveLensPose = false;
    LensPoseFit lensPose;

    bool           haveAgreement = false;
    BasisAgreement agreement;

    /// `derivedBasisProvenanceName()` — the string a pack must carry beside a
    /// derived index.  Carried in the report so the writer cannot forget it.
    const char* provenance = "derived";
};

/// Run the derivation and whichever cross-checks were asked for.  PURE.
BasisReport buildBasisReport(const BasisReportRequest& req);

/// The report as one JSON object.
///
/// Hand-rolled in the same style as the pack's own writers (no JSON library is
/// in this dependency set), and with the same non-finite rule the replay
/// driver's `reportToJson` uses: a value that is not finite is emitted as
/// `null`, NEVER as `nan`/`inf`.  `JSON.parse` rejects those, and the rejection
/// surfaces in JS with no trace of which native field produced it.
std::string basisReportToJson(const BasisReport& r);

}  // namespace android
}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_ANDROID_REPORT_HPP
