// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_basis.hpp — DERIVE the IMU→camera basis `C` on Android
// instead of measuring it (pano+ Android port).
//
// ── Why this file exists at all ──────────────────────────────────────────
//
// The engine applies `R_engine = R_imu · C`, with `C` one of the 24 signed
// axis permutations enumerated in rnis_pano_attitude.{hpp,cpp}.  On iOS `C`
// could not be derived: CoreMotion does not document its device frame against
// the camera frame, so `selectBasis()` MEASURED it from a concurrent ARKit log
// and got index 8 (`-y+x+z`) on iPhone17,1.
//
// On Android both halves ARE documented, so the search is replaced by
// arithmetic:
//
//   · SensorManager's device frame: +X right along the screen, +Y up the
//     screen, +Z out of the screen toward the user — all in the device's
//     NATURAL orientation, which is what `TYPE_GAME_ROTATION_VECTOR` reports
//     against.  (The gravity-aligned reference frame on the other side of that
//     rotation is irrelevant here: `B` cancels exactly — see the header of
//     rnis_pano_attitude.hpp.)
//   · `CameraCharacteristics.SENSOR_ORIENTATION`: the CLOCKWISE angle through
//     which the camera's output image must be rotated to be upright on the
//     screen in that same natural orientation.  0/90/180/270 by contract.
//
// Two documented frames and one documented angle between them is a derivation,
// not a search.  What it is NOT is a measurement — see "FALSIFICATION" below.
//
// ── THE ENGINE'S CAMERA CONVENTION IS **GL**, NOT CV ─────────────────────
//
// This is the single easiest thing in the whole port to get backwards, and
// getting it backwards produces a valid-looking basis index that is wrong by a
// 180° roll.  rnis_pano.hpp:41-49 is explicit:
//
//     ARKit `camera.transform`  : camera→world, GL convention (+X right,
//                                 +Y UP, −Z forward).
//     ARKit `camera.intrinsics` : CV convention (+X right, +Y DOWN,
//                                 +Z forward) …
//     R_i = quat(FrameInput::q) → 3×3, world←cam_i, GL convention
//
// So `FrameInput::q` — the ONLY thing `C` feeds — is GL.  The CV convention in
// that same block belongs to the INTRINSICS, which travel a different path
// (`K_i`) and never touch `C`.  A port that reads "the camera convention is CV"
// out of that block and builds `C` on `+Y down, +Z forward` lands on basis 11
// where the truth is basis 8: the two differ by exactly `diag(1,−1,−1)`, a 180°
// roll about the optical axis, which on a horizontal sweep flips the canvas
// upside down while every scalar diagnostic stays plausible.
//
// The derivation below is written in GL and it REPRODUCES iOS's measured index
// 8 for the iPhone's configuration — see
// `AndroidBasis.ReproducesTheMeasurediOSBasis`.  That agreement between an
// independent derivation and a field-validated measurement is the strongest
// evidence available without an Android device, and it is the reason to trust
// the machinery even before Samsung confirms the Samsung-specific half.
//
// ⚠ WHAT THAT CROSS-CHECK RESTS ON, stated so it can be attacked: iOS has no
// `SENSOR_ORIENTATION` constant, so the check feeds the derivation the
// PHYSICAL equivalent — back lens, a native raster that needs a 90° CLOCKWISE
// rotation to be upright in the device's natural (portrait) orientation, and
// an engine handed that raster unrotated.  The middle claim is the standard
// iOS fact (a portrait-held rear-camera capture carries
// `CGImagePropertyOrientation.right`, i.e. "rotate 90° CW to display"), and
// the third is rnis_pano.hpp:56-59.  If the first two are wrong the agreement
// is a coincidence and this paragraph is the thing to delete.
//
// ── The derivation, in three factors ─────────────────────────────────────
//
//   C = C_upright(facing) · G(sensorOrientation − appliedRotation)
//
//   · `C_upright(facing)` — `R_device←cam` for an image that is ALREADY upright
//     on the screen in the natural orientation.  For the BACK lens: image-right
//     is device +X, image-up is device +Y, and GL's +Z (BACKWARD, toward the
//     viewer) is device +Z because the lens looks out the back.  That is the
//     IDENTITY.  For the FRONT lens the optical axis reverses, so GL +Z becomes
//     device −Z, and right-handedness then FORCES image-right onto device −X —
//     which is also the physical truth of an unmirrored selfie (the subject's
//     right hand lands on the viewer's left).  That is `diag(−1, +1, −1)`.
//
//   · `G(θ)` — the roll about the optical axis contributed by the fact that the
//     buffer the engine receives may not be upright.  Rotating an image
//     CLOCKWISE by θ sends its right-pointing axis to its down-pointing axis;
//     in the GL camera frame (where +Y is image UP, i.e. −v) that is a rotation
//     about +Z by −θ.  `G` is therefore exact for multiples of 90° and is built
//     from integer sin/cos, never from `std::cos`, so every derived `C` has
//     entries in {−1, 0, +1} EXACTLY and the table lookup below is an equality
//     test rather than a tolerance.
//
//   · `appliedRotation` — the clockwise rotation the RECORDER already applied
//     before `ingest()`.  It is an input and not an assumption because it is a
//     free choice of the Android capture code, and choosing wrong is invisible.
//     **The iOS arm hands the engine the NATIVE, UNROTATED sensor raster**
//     (rnis_pano.hpp:56-59: "Everything stays in the AR sensor/landscape raster
//     the intrinsics are expressed against and is NEVER rotated mid-pipeline"),
//     so `RawSensorBuffer` is the matching Android choice and the default here.
//     If the recorder rotates, it MUST say so — and it must rotate the
//     intrinsics with the pixels, which is a separate trap this file cannot see.
//
// ── What is REFUSED, and why refusal beats rounding ──────────────────────
//
// Every combination that does not correspond to a signed axis permutation is
// refused BY NAME rather than rounded to the nearest candidate:
//
//   · a sensor orientation / display rotation / explicit rotation that is not a
//     multiple of 90 (the value is out of contract; something upstream is wrong
//     and a nearest-90 snap would bury it),
//   · a MIRRORED buffer — a horizontal flip is a REFLECTION, det −1.  There is
//     no rotation that equals it, so the 24-candidate model does not merely fit
//     badly, it cannot express it at all.  Rounding here would silently mirror
//     the canvas,
//   · `LENS_FACING_EXTERNAL` — a USB camera's mounting relative to the phone's
//     IMU is by construction unknown; there is nothing to derive,
//   · the front lens under the "upright for the current display rotation"
//     convention, because the standard AOSP formula for that case folds a
//     mirror compensation into the angle and the two are not separable from
//     outside the recorder.  `Explicit` is the escape hatch: state the angle
//     you actually applied and whether you mirrored.
//
// ── Namespace / dependencies ─────────────────────────────────────────────
//
// `rnis::pano::android`, beside the attitude seam it extends.  HAND-WRITTEN —
// it has no generated ancestor and is not produced by any codegen step.
//
// STL ONLY.  No OpenCV, no JNI, no Android header.  It consumes
// rnis_pano_attitude.hpp for the 24-candidate table and the quaternion
// helpers, and the host test target for both deliberately withholds OpenCV so
// a stray include fails HERE rather than as an NDK link error later.
//
// Every function is PURE: no I/O, no globals, no clock, no allocation beyond
// the returned struct.  The same request always yields the same answer, which
// is what makes a host test speak for a device nobody has plugged in.
//
// ── FALSIFICATION — read this before trusting the number ─────────────────
//
// This is a HYPOTHESIS about how Samsung mounts the A35's sensor, not a
// measurement of it.  It rests on two claims that hold for every compliant
// device and are nevertheless worth naming:
//
//   1. `SENSOR_ORIENTATION` really describes the buffer the recorder hands us.
//      A recorder that goes through an intermediate surface (SurfaceTexture,
//      a GL transform, MediaCodec) may have rotated the pixels without saying
//      so.  Then `appliedRotation` is wrong and `C` is off by a 90° roll.
//   2. `TYPE_GAME_ROTATION_VECTOR` really reports against the natural-
//      orientation device frame.  It does on every device that passes CTS.
//
// WHAT WOULD FALSIFY IT, in one sweep, without a second field trip: run
// `selectBasis()` on a concurrent log — Android's rotation vector logged beside
// ARCore's `Frame.getAndroidSensorPose()`/camera pose — and compare the winner
// with `deriveBasis()`'s answer.  If they agree, the derivation is confirmed on
// that device and the recorder can skip the calibration gesture forever.  If
// they disagree, the DERIVED index is wrong and the MEASURED one wins; the
// disagreement itself then localises the fault, because the difference between
// the two indices is a specific rotation (a 90° roll ⇒ claim 1 is false; a 180°
// roll ⇒ someone rebuilt this file in CV; anything else ⇒ claim 2 or the lens
// facing).
//
// WHAT THE RECORDER MUST LOG so the operator can check it in one sweep — all
// of it is free, all of it is per-session, and without any one of them the
// comparison above cannot be made after the fact:
//
//     sensorOrientationDeg, lensFacing, lensPoseReference,
//     lensPoseRotation[4] (when present), appliedRotationCwDeg, mirrored,
//     displayRotationDeg, the DERIVED basis index + label + refusal string,
//     and — when a reference log exists — selectBasis()'s ranked[0..1] with
//     its `unique` flag and `marginDeg`.

#ifndef RNIS_PANO_ANDROID_BASIS_HPP
#define RNIS_PANO_ANDROID_BASIS_HPP

namespace rnis {
namespace pano {
namespace android {

// ── Inputs, named after the Android constants they mirror ───────────────────

/// `CameraCharacteristics.LENS_FACING`.  Values match the CAMERA2 constants so
/// a JNI shim can pass the raw int through without a translation table that
/// could drift.
///
/// ⚠ CAMERA2 AND THE LEGACY API DISAGREE, AND THE DISAGREEMENT IS A SWAP.
/// `CameraCharacteristics.LENS_FACING_FRONT` is 0 and `LENS_FACING_BACK` is 1;
/// the deprecated `Camera.CameraInfo.CAMERA_FACING_BACK` is 0 and
/// `CAMERA_FACING_FRONT` is 1 — the exact opposite.  A shim that reads the
/// legacy constant and passes the int here silently derives the FRONT basis for
/// a BACK sweep, which is a valid det-+1 permutation and therefore refuses
/// nothing.  `AndroidBasisNames.TheEnumValuesMatchTheAndroidConstants` pins the
/// Camera2 numbering; the shim must read `CameraCharacteristics`, not
/// `Camera.CameraInfo`.
enum class LensFacing : int {
    Front    = 0,   ///< LENS_FACING_FRONT
    Back     = 1,   ///< LENS_FACING_BACK
    External = 2,   ///< LENS_FACING_EXTERNAL — mounting unknown, always refused
};

/// What the recorder did to the sensor buffer before `ingest()` saw it.
///
/// This is an INPUT because it is a free choice of the capture code and a wrong
/// guess is invisible in every scalar diagnostic the pack carries.
enum class RecorderRotation : int {
    /// The engine gets the sensor's native raster, untouched.  **This is what
    /// the iOS arm does** and therefore the default: the intrinsics are
    /// expressed against that raster and the engine never rotates mid-pipeline.
    RawSensorBuffer = 0,

    /// The recorder rotated by exactly `SENSOR_ORIENTATION`, so the buffer is
    /// upright on the screen in the device's NATURAL orientation.
    UprightInNaturalOrientation = 1,

    /// The recorder rotated so the buffer is upright for the CURRENT display
    /// rotation, by the standard AOSP formula.  Back lens only — see
    /// `refusal` `front-display-rotation-convention-ambiguous`.
    UprightForDisplayRotation = 2,

    /// The recorder states the clockwise angle it applied, in
    /// `BasisRequest::explicitRotationCwDeg`.  The escape hatch for anything
    /// the three named conventions do not describe.
    Explicit = 3,
};

const char* lensFacingName(LensFacing f);
const char* recorderRotationName(RecorderRotation r);

/// Everything the derivation needs, and nothing it can infer.
struct BasisRequest {
    /// `CameraCharacteristics.SENSOR_ORIENTATION`.  Must be 0/90/180/270.
    /// Negative or non-multiple-of-90 values are REFUSED, not normalised: they
    /// mean the characteristic was never read, and a default of 0 would be a
    /// plausible-looking lie.
    int sensorOrientationDeg = -1;

    LensFacing facing = LensFacing::Back;

    RecorderRotation recorder = RecorderRotation::RawSensorBuffer;

    /// `Display.getRotation()` expressed in DEGREES (ROTATION_0 → 0,
    /// ROTATION_90 → 90, …).  Read only when `recorder ==
    /// UprightForDisplayRotation`; ignored otherwise, and echoed either way.
    int displayRotationDeg = 0;

    /// Read only when `recorder == Explicit`.
    int explicitRotationCwDeg = 0;

    /// The recorder horizontally flipped the pixels (the usual front-camera
    /// preview mirror).  ALWAYS a refusal: a flip is a reflection, det −1, and
    /// no member of the 24-candidate set equals it.
    bool mirrored = false;
};

/// The answer, plus everything needed to audit it.
///
/// `m` and the two angles are populated whenever the arithmetic RAN, including
/// on a refusal that came after it — reporting what was observed is the point,
/// and a caller comparing a refused derivation against a measured basis needs
/// the matrix that was rejected.
struct BasisDerivation {
    bool ok = false;

    /// Index into the ENGINE's own 24-candidate enumeration
    /// (`rnis::pano::basisMatrix`), ready for
    /// `AttitudeAligner::Config::basisIndex`.  −1 on refusal.
    int index = -1;

    /// The engine's own label for `index` (`+x+y+z`, `-y+x+z`, …), or
    /// `"invalid"`.  Never a locally invented string.
    const char* label = "invalid";

    /// Stable, greppable, lowercase-hyphen.  `"none"` on success.
    const char* refusal = "not-attempted";

    /// The clockwise rotation the recorder was UNDERSTOOD to have applied,
    /// after resolving `RecorderRotation`.  −1 when it could not be resolved.
    int appliedRotationCwDeg = -1;

    /// `(sensorOrientationDeg − appliedRotationCwDeg) mod 360` — the roll the
    /// derivation actually modelled.  0 means the buffer reaching the engine is
    /// upright in the natural orientation.  −1 when unresolved.
    int residualRotationCwDeg = -1;

    /// The derived `C = R_device←cam`, row-major.  Identity until the
    /// arithmetic runs; `matrixValid` says which.
    double m[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};

    /// False means `m` is the placeholder identity, NOT a derived answer.  The
    /// two must never be confusable: `+x+y+z` is itself a legal basis (index 0,
    /// the back lens at sensor orientation 0), so a bare identity in `m` says
    /// nothing on its own.
    bool matrixValid = false;
};

/// Derive `C` for one (sensor orientation, lens, recorder convention).
///
/// PURE.  Deterministic.  Refuses by name rather than rounding — see the header.
BasisDerivation deriveBasis(const BasisRequest& req);

// ── WHAT A PACK MUST CALL THIS, AND WHAT IT MUST NOT ───────────────────────
//
// `rnis::pano::BasisProvenance` has three values — `not-measured`, `measured`,
// `caller-supplied` — and A DERIVED BASIS IS NONE OF THEM.
//
// The temptation is `measured`: the number is right, it came from the device's
// own characteristics, and a pack that said `measured` would read cleanly.  It
// would also be false in the precise way rnis_pano_attitude.hpp's whole τ
// section exists to prevent — it would certify a calibration nobody ran.
// Nothing on this device was measured against anything; two documented frames
// were multiplied together.  If the mounting assumption is wrong (see
// FALSIFICATION in this file's header), a pack stamped `measured` gives a
// reader no way to find that out, while one stamped `derived` tells them
// exactly which claim to go and check.
//
// `caller-supplied` is closer but still wrong: it means "this build measured
// nothing AND cannot say where the number came from", and here we can say
// precisely where it came from.
//
// So the host writes THIS string into the pack's basis-provenance field, beside
// the derived index, its label, and the whole `BasisRequest` that produced it.
// It is a function rather than a comment so the rule is callable rather than
// remembered.
//
// When a device HAS run the concurrent-log falsification sweep and
// `selectBasis()` agreed, the pack may then say `measured` — because at that
// point something was.
const char* derivedBasisProvenanceName();

// ── The other route: an exact sensor→camera rotation from the driver ────────
//
// `CameraCharacteristics.LENS_POSE_ROTATION` is a quaternion the HAL may
// publish for the rotation between the Android sensor coordinate system and a
// camera-aligned frame.  When it is present AND its reference frame is the
// right one it is AUTHORITATIVE — it is the device's own measurement of its own
// mounting, and no derivation can beat it.
//
// It is also the place where a silent, plausible wrong answer is easiest to
// produce, because THREE conventions sit between it and `C` and none of them
// can be verified from here:
//
//   1. WHICH DIRECTION the quaternion rotates (`device←camera` or its inverse).
//   2. WHAT the "camera-aligned" frame's axes are — Android defines them
//      against the SENSOR's long/short side and optical axis, which is not the
//      engine's GL image frame, and the difference depends on how the sensor's
//      long side maps to the raster.
//   3. WHAT `LENS_POSE_REFERENCE` says the pose is relative to.  Only
//      `GYROSCOPE` places it in the frame the rotation vector reports in;
//      `PRIMARY_CAMERA` measures against ANOTHER CAMERA and is a different
//      quantity wearing the same name.
//
// So (3) is GATED here — refused unless it is `GYROSCOPE` — and (1) and (2) are
// CALLER DECLARATIONS that are echoed back in the result rather than assumed.
// The caller states what it believes; this file does the arithmetic and reports
// the residual; the residual is what catches a wrong declaration, because a
// wrong (1) or (2) still lands on an axis permutation (the wrong one) while a
// wrong model lands off-axis and is refused.
//
// ⚠ THE GAP THIS CANNOT CLOSE.  A wrong declaration of (1) or (2) yields a
// residual of ~0 on the WRONG index.  Only the falsification sweep in the
// header (derived vs `selectBasis()` on a concurrent log) separates them.

/// `CameraCharacteristics.LENS_POSE_REFERENCE`.  Values match the Android
/// constants.
enum class LensPoseReference : int {
    PrimaryCamera        = 0,  ///< relative to ANOTHER CAMERA — refused
    Gyroscope            = 1,  ///< relative to the sensor frame — the usable one
    Undefined            = 2,  ///< the HAL published nothing meaningful — refused
    Automotive           = 3,  ///< a vehicle frame — refused
};

const char* lensPoseReferenceName(LensPoseReference r);

/// WHICH WAY the caller believes `LENS_POSE_ROTATION` rotates.  Declared, never
/// guessed: both readings of Android's "rotation from the sensor coordinate
/// system to a camera-aligned coordinate system" are defensible English, and
/// picking one silently is how a 90°-wrong basis ships looking correct.
enum class PoseQuatSense : int {
    DeviceFromCamera = 0,  ///< `quatToMat(q)` IS `R_device←camera`
    CameraFromDevice = 1,  ///< `quatToMat(q)` is its transpose
};

const char* poseQuatSenseName(PoseQuatSense s);

/// The fit of an ARBITRARY rotation to the 24-candidate set.
///
/// THE ACCEPTED ANSWER AND THE OBSERVATION ARE SEPARATE FIELDS, on purpose.
/// `index` is −1 unless `ok`, so a caller that forgets the check gets an
/// invalid basis index (which the aligner refuses with `BasisNotValidated`)
/// rather than a plausible one it never earned.  `nearestIndex` carries what
/// was actually observed, refused or not, because a refusal that does not say
/// what it refused is unactionable.
struct PoseRotationFit {
    bool ok = false;

    /// The ACCEPTED basis index, or −1.  Never populated on a refusal.
    int         index        = -1;
    const char* label        = "invalid";

    /// THE OBSERVATION: nearest candidate and its angular residual, degrees.
    /// Populated whenever the arithmetic ran, INCLUDING on a refusal.
    int         nearestIndex = -1;
    const char* nearestLabel = "invalid";
    double      residualDeg  = 0.0;

    /// The SECOND-nearest candidate and its residual.  `marginDeg` is the
    /// discrimination: for an exact axis permutation it is exactly 90° (the
    /// smallest rotation in the cube group), and a margin near 0 means the
    /// input sits equidistant between two candidates, where "nearest" is a coin
    /// toss rather than an answer.
    int         runnerUpIndex = -1;
    const char* runnerUpLabel = "invalid";
    double      runnerUpDeg   = 0.0;
    double      marginDeg     = 0.0;

    double      thresholdDeg = 0.0;   ///< what `residualDeg` was compared against
    const char* refusal      = "not-attempted";

    /// The INPUT rotation as a matrix, row-major — not the candidate's.  Filled
    /// whenever the quaternion was usable, so a refused fit can still be read.
    double m[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    bool   matrixValid = false;
};

/// The largest residual at which snapping to an axis permutation is still
/// defensible, degrees.
///
/// It is deliberately SMALL.  The engine's own currency is 11.7 canvas px per
/// degree, so 2° of residual is ~23 canvas px of systematic rectification error
/// — already past every integrity gate the programme runs.  A device whose true
/// mounting sits further off-axis than this does not have a "nearly
/// permutation" basis; it has a basis the 24-candidate model cannot express,
/// and the honest output is a refusal that says so.
///
/// (It is a NAMED CONSTANT and not a default argument: `nearestBasis` takes the
/// threshold explicitly so that every call site states the bar it used, and so
/// that a test can sweep it.)
extern const double kDefaultPoseResidualDegThreshold;

/// Nearest of the 24 candidates to an arbitrary rotation, with the residual and
/// the margin to the runner-up.  Refuses above `thresholdDeg`.
///
/// PURE.  Ties break to the LOWEST index so the answer is deterministic; the
/// margin is what tells the caller a tie happened.
///
/// `q` is `[x, y, z, w]`, the same convention as everything else in this
/// programme.  It is normalised internally; a non-finite or ~zero quaternion is
/// refused by name.
PoseRotationFit nearestBasis(const double q[4], double thresholdDeg);

/// Everything the LENS_POSE route needs, with all three conventions declared.
struct LensPoseRequest {
    double q[4] = {0, 0, 0, 1};   ///< LENS_POSE_ROTATION, [x, y, z, w]

    LensPoseReference reference = LensPoseReference::Undefined;
    PoseQuatSense     sense     = PoseQuatSense::DeviceFromCamera;

    /// `R_lensPoseCameraFrame←engineCameraFrame`, declared as an index into the
    /// engine's own 24-candidate table (0 = identity = "the two frames already
    /// agree").  This is convention (2) above: Android's camera-aligned frame
    /// is defined by the sensor's long/short side and optical axis, the
    /// engine's is GL image right/up/backward, and the map between them is
    /// itself a signed axis permutation that depends on the device's raster
    /// layout.  Declared, echoed, never inferred.
    int cameraFrameAdjustIndex = 0;

    double thresholdDeg = 2.0;    ///< see kDefaultPoseResidualDegThreshold
};

/// The fit, plus the declarations it was computed under — so a pack can be
/// re-read years later without the caller's source beside it.
struct LensPoseFit {
    PoseRotationFit fit;

    LensPoseReference reference              = LensPoseReference::Undefined;
    PoseQuatSense     sense                  = PoseQuatSense::DeviceFromCamera;
    int               cameraFrameAdjustIndex = -1;
    const char*       cameraFrameAdjustLabel = "invalid";
};

/// Compose the declared conventions and fit the result to the 24 candidates.
///
/// PURE.  Refuses on a non-`GYROSCOPE` reference, an out-of-range adjust index,
/// an unusable quaternion, or a residual past `thresholdDeg` — each by name.
LensPoseFit basisFromLensPoseRotation(const LensPoseRequest& req);

// ── Small exported pieces, host-tested directly ────────────────────────────
namespace detail {

/// Reduce an angle in degrees to `[0, 360)` with EXACT integer arithmetic.
/// `std::fmod` on a negative input returns a negative remainder, which is the
/// classic way a −90 becomes a −90 instead of a 270.
int normalizeDeg360(int deg);

/// True for exactly 0/90/180/270 after normalisation.
bool isQuarterTurn(int deg);

/// `G(θ)`, row-major: the rotation about the GL camera's +Z axis induced by
/// rotating the IMAGE clockwise by `θ`.  EXACT — built from an integer sin/cos
/// table, so the result's entries are exactly {−1, 0, +1} and the basis-table
/// lookup can be an equality test.  Returns false (and leaves `m` untouched)
/// for anything that is not a quarter turn.
bool imageRollMatrix(int cwDeg, double m[9]);

/// `C_upright(facing)`, row-major: `R_device←cam` for an already-upright image
/// in the device's natural orientation.  Back → identity; front →
/// `diag(−1, +1, −1)`.  Returns false for `External`.
bool uprightBasisMatrix(LensFacing facing, double m[9]);

/// Find `m` in the ENGINE's 24-candidate table, or −1.
///
/// A SEARCH and not a formula ON PURPOSE: it is the only thing standing between
/// this file and a hardcoded index table that would silently disagree with the
/// engine if the enumeration in rnis_pano_attitude.cpp were ever reordered.
/// Comparison is exact-to-1e-9 because every matrix on both sides is built from
/// integers.
int basisIndexForMatrix(const double m[9]);

/// The AOSP display-orientation formula for the BACK lens:
/// `(sensorOrientation − displayRotation + 360) % 360`.  Exposed so a test can
/// pin the formula itself rather than only its consequences.
int backLensUprightRotationForDisplay(int sensorOrientationDeg,
                                      int displayRotationDeg);

}  // namespace detail

}  // namespace android
}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_ANDROID_BASIS_HPP
