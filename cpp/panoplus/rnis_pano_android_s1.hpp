// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_android_s1.hpp — RUN THE S1 BASIS SELECTION OVER A RECORDED PACK.
//
// ── What this closes ────────────────────────────────────────────────────────
//
// `rnis_pano_android_basis.hpp` DERIVES the device→camera change `C` from two
// Camera2 characteristics (SENSOR_ORIENTATION + LENS_FACING).  On the A35 it
// answers index 8, and that answer is the Android port's one UNPROVEN claim:
// LENS_POSE_ROTATION is not published on that device, so nothing on the phone
// can contradict the derivation.  `derivedBasisProvenanceName()` exists purely
// to stop a pack claiming otherwise.
//
// `selectBasis()` (rnis_pano_attitude.hpp) MEASURES `C` instead, by searching
// all 24 candidates against a REFERENCE `world←camera` series.  iOS gets that
// reference from ARKit.  Android's equivalent is ARCore, and once a recorder
// has logged an ARCore pose series beside the rotation-vector series, the
// derivation becomes FALSIFIABLE.  This translation unit is the arithmetic
// that performs the falsification and states the outcome.
//
// ── Why it is a separate, platform-free translation unit ────────────────────
//
// Everything here is string parsing plus calls into `selectBasis()`,
// `excitation()`, `gradeBasis()`, `basisStability()` and
// `compareDerivedWithReference()`.  None of it needs Android.  Written inside
// the JNI shim it would compile only under the NDK, and its characteristic
// failures — a mis-parsed quaternion order, a series read out of time order, a
// `nan` that makes `JSON.parse` throw in JS — would surface on a phone in an
// aisle with no way to reproduce them.  Here, the host gtest suite reaches
// every branch.
//
// ── THE FOUR THINGS THIS FILE REFUSES TO DO ────────────────────────────────
//
// 1. IT NEVER SORTS.  `selectBasis()` documents that both series must be
//    time-sorted, and a sort here would HIDE a recorder that emitted rows out
//    of order — which on a multi-threaded writer is a real and diagnosable
//    fault, not a formatting quirk.  Out-of-order rows are DROPPED and
//    COUNTED (`rowsOutOfOrder`), so the count is the evidence.
//
// 2. IT NEVER NORMALISES A NON-UNIT QUATERNION INTO THE SERIES.  A row whose
//    quaternion norm is not within `kQuatNormTolerance` of 1 is dropped and
//    counted.  Renormalising would launder a broken writer into a plausible
//    attitude, and the residual it then produced would be measuring the
//    laundering.
//
// 3. IT NEVER PICKS τ FOR YOU.  `selectBasis()` takes one τ; the answer can in
//    principle be an artefact of it.  So the caller supplies τ AND a list of
//    probe offsets, and `basisStability()` is run across them.  A winner that
//    moves under ±10 ms is reported as unstable rather than as a winner.
//
// 4. IT NEVER READS `ranked[0]` WITHOUT `unique`.  The 4-way exact tie under a
//    single-axis gesture is the documented degeneracy (rnis_pano_attitude.hpp),
//    and the excitation of the REFERENCE series is graded independently so a
//    selection that separated by noise on a degenerate log is still refused.
//
// ── The two file formats it reads ──────────────────────────────────────────
//
//   `panoplus/sensors.jsonl`         — one row per SensorEvent, written by
//                                      PanoPlusAndroidRecorder.kt:
//     {"type":"rotation-vector","tsNs":…,"q":[x,y,z,w],"tS":…,"accuracy":…,
//      "elapsedRealtimeNsAtDelivery":…}
//
//   `panoplus/attitude_arcore.jsonl` — one row per ARCore frame, written by
//                                      PanoPlusArCoreReference.kt:
//     {"kind":"arcore-frame","tsNs":…,"tS":…,"q":[x,y,z,w],
//      "qDisplayOriented":[x,y,z,w],"t":[x,y,z],"trackingState":"TRACKING",
//      "trackingFailureReason":"NONE","tsDomain":…,"matchKind":…,"matchSeq":…}
//
// Both are hand-rolled by their writers, both are flat objects, and both put
// the quaternion in `[x, y, z, w]` — `rnis::pano`'s order, NOT `SensorManager
// .getQuaternionFromVector`'s `[w, x, y, z]`, which the recorder already
// reorders on the way out.  This file states that expectation because the two
// conventions differ by a rotation nothing downstream can detect.
//
// ── ⚠ THE TWO TIMEBASES ARE THE SAME AND THE INSTANTS ARE NOT ─────────────
//
// ARCore documents `Frame.getTimestamp()` as sharing the Camera2
// `SENSOR_TIMESTAMP` timebase, and it is tempting to read that as "the ARCore
// row and the track row for one frame carry the SAME integer".  MEASURED ON
// SM-A356U1 IN SHARED-CAMERA MODE, THEY DO NOT: 0 of 738 ARCore timestamps
// equalled any track row's `tsNs`, while the nearest-neighbour gap had a
// median of 0.9 ms and never left one 30 fps frame period.
//
// This reader never needs the equality — `selectBasis()` brackets the IMU
// series around each reference sample and SLERPs, which is the right operation
// for two clocks that agree on epoch and disagree on instant — but the fact is
// recorded here because the natural "join by tsNs" would have produced an
// EMPTY join and been read as a broken recorder.  The sidecar's own
// `matchKind` is a LIVE, writer-lagged lookup and is diagnostic only.

#ifndef RNIS_PANO_ANDROID_S1_HPP
#define RNIS_PANO_ANDROID_S1_HPP

#include <string>
#include <vector>

#include "rnis_pano_android_report.hpp"
#include "rnis_pano_attitude.hpp"
#include "rnis_pano_calib.hpp"

namespace rnis {
namespace pano {
namespace android {

/// How far a quaternion's norm may sit from 1 before its row is dropped.
///
/// 1e-3 is far looser than any float round-trip through `%.9g` (which is
/// exact to ~1e-9) and far tighter than any real writer bug — a swapped
/// component order, a three-element vector padded with a zero, an
/// uninitialised buffer — all of which land well outside it.
extern const double kQuatNormTolerance;

/// One parsed attitude series, and EVERY row that did not make it.
///
/// The counters are not diagnostics-for-later: `pairs` in a BasisFit is the
/// number of reference samples successfully bracketed, and a fit over 12 pairs
/// because 300 rows were silently dropped looks identical to a fit over 12
/// pairs from a 12-row log.  These say which it was.
struct SeriesParse {
    std::vector<AttitudeSample> samples;

    int linesTotal        = 0;   ///< non-blank lines seen
    int rowsAccepted      = 0;
    int rowsWrongType     = 0;   ///< a row of the OTHER sensor / kind
    int rowsMalformed     = 0;   ///< no `tS`/`tsNs`, no quaternion, unparseable
    int rowsNonUnitQuat   = 0;
    int rowsOutOfOrder    = 0;   ///< timestamp <= the previous accepted row's

    double firstTS = 0.0;
    double lastTS  = 0.0;
    double hz      = 0.0;        ///< (accepted−1) / (lastTS−firstTS), 0 if < 2
};

/// Read a `sensors.jsonl` body.  `type` matches the row's `"type"` field
/// exactly — `"rotation-vector"` or `"game-rotation-vector"`.
///
/// Timestamps come from `tS` (seconds) when present, else `tsNs / 1e9`.  The
/// recorder writes both and they are the same instant; preferring `tS` keeps
/// this reader working against a writer that ever drops the integer field.
SeriesParse parseSensorsJsonl(const std::string& text, const char* type);

/// Read an `attitude_arcore.jsonl` body.
///
/// `field` selects WHICH pose: `"q"` is ARCore `Camera.getPose()` — the
/// physical camera's `world←camera` in the GL camera convention, the direct
/// analogue of ARKit's `ARCamera.transform` and therefore the one
/// `selectBasis()` wants.  `"qDisplayOriented"` is
/// `Camera.getDisplayOrientedPose()`, which folds in the display rotation and
/// is recorded only so the choice is the reader's rather than the writer's.
///
/// Rows whose `trackingState` is not `"TRACKING"` are dropped as
/// `rowsWrongType`: a pose from a PAUSED or STOPPED camera is not a
/// measurement of where the phone was pointing, and letting one into the
/// series would put a step discontinuity into the reference.
SeriesParse parseArCoreJsonl(const std::string& text, const char* field);

/// What an S1 run needs beyond the two series.
struct S1Request {
    /// τ applied to the REFERENCE timestamps to bring them into the IMU
    /// timebase, exactly as `align()` uses it.  0 is the right default ONLY
    /// when both series are on one clock — on Android that holds when
    /// `SENSOR_INFO_TIMESTAMP_SOURCE` is `REALTIME`, which the recorder
    /// records in `device.json` rather than assuming.
    ///
    /// ⚠ AND WHICH `runS1OnPack` NOW READS.  Every caller on the programme
    /// leaves this at 0 (the JNI entry's default, the Kotlin module's default,
    /// and the panel passes none), so the assumption was being made silently on
    /// every run.  `S1PackResult::cameraTimestampSource` /
    /// `::clockAssumption` carry what the pack actually said.  A run over two
    /// strings still cannot check anything — the caller owns τ there.
    double tauS = 0.0;

    /// Offsets (SECONDS, absolute, not relative to `tauS`) at which to re-fit
    /// for `basisStability()`.  EMPTY ⇒ the stability check is reported as
    /// not-run rather than as passed.
    std::vector<double> tauCandidatesS;

    /// The DERIVED index to falsify, from `deriveBasis()`.  −1 ⇒ no
    /// comparison is made and the report says so.
    int derivedBasisIndex = -1;

    ExcitationPolicy excitation;
    BasisPolicy      basis;

    /// Sweep length and canvas scale for the drift verdict's px conversion.
    /// Defaults match `DriftVerdict`'s own.
    double sweepSeconds   = 8.0;
    double canvasPxPerDeg = 11.7;
};

/// Everything an S1 run produced.  Nothing here is inferred, and every
/// "absent" is distinguishable from every "zero".
struct S1Report {
    bool ok = false;

    /// "ok" | "no-imu-samples" | "no-reference-samples" | the selection's own
    /// refusal | "excitation-insufficient" | "rms-too-large" | "too-few-pairs"
    ///
    /// `ok` is TRUE only when the basis may be persisted, i.e. exactly
    /// `gradeBasis()`'s verdict.  A run that measured a winner but failed the
    /// excitation gate reports the winner AND `ok == false`.
    const char* reason = "no-imu-samples";

    SeriesParse imu;
    SeriesParse ref;

    /// Excitation of the REFERENCE series — the one whose frame is known, so
    /// the one whose `perAxisDeg` / `needMore` can be turned into coaching.
    AxisExcitation    refExcitation;
    ExcitationVerdict refExcitationVerdict;

    /// Excitation of the IMU series.  ⚠ Its `perAxisDeg` is in the DEVICE
    /// frame — naming those axes is exactly what `C` has not been solved for
    /// — so only the frame-invariant `eig` / `rank2` / `rank3` are comparable
    /// with the reference's.  A large disagreement between the two rank2s is
    /// itself a finding (one series is not seeing the motion the other is).
    AxisExcitation imuExcitation;

    BasisSelection selection;
    BasisVerdict   verdict;

    bool           stabilityRun = false;
    BasisStability stability;

    /// The falsification itself.  `haveAgreement` false ⇒ no derived index was
    /// supplied, or the measurement produced no unique winner to compare.
    bool           haveAgreement = false;
    BasisAgreement agreement;

    /// Set when a comparison was WITHHELD, and why — so a panel renders "not
    /// compared because the winner was ambiguous" rather than blank.
    const char* agreementWithheld = "";

    double tauS = 0.0;
};

/// Run the whole S1 pipeline.  PURE — no I/O, no clock, no allocation beyond
/// the report.  Never throws.
S1Report runS1(const SeriesParse& imu, const SeriesParse& ref, const S1Request& req);

/// The report as one JSON object, same non-finite rule as its siblings: a
/// value that is not finite is emitted as `null`, NEVER as `nan`/`inf`.
std::string s1ReportToJson(const S1Report& r);

// ── Reading the two ledgers off disk ────────────────────────────────────────

/// An S1 run addressed by PACK DIRECTORY rather than by two strings.
struct S1PackRequest {
    S1Request run;

    /// The pack root OR its `panoplus/` subdirectory — both are accepted,
    /// because the recorder reports the latter and an operator types the
    /// former.
    std::string packDir;

    /// Which `sensors.jsonl` row type is the IMU series.  `rotation-vector`
    /// by default; `game-rotation-vector` is the magnetometer-free arm the
    /// recorder logs beside it, and running S1 on both is how the port finds
    /// out whether the compass is contributing anything.
    std::string imuType = "rotation-vector";

    /// Which ARCore pose: `q` (Camera.getPose) or `qDisplayOriented`.
    std::string refField = "q";
};

/// What a pack-addressed run produced, INCLUDING where it looked.
///
/// A missing `attitude_arcore.jsonl` is the common case — the ARCore
/// reference channel is off by default — and it must read as "this pack has
/// no reference series", never as a failed measurement.
struct S1PackResult {
    bool ok = false;

    /// "ok" | "no-pack-dir" | "sensors-jsonl-missing" |
    /// "arcore-jsonl-missing" | the run's own reason
    const char* reason = "no-pack-dir";

    std::string panoplusDir;
    std::string sensorsPath;
    std::string arcorePath;
    std::string deviceJsonPath;
    bool sensorsFound   = false;
    bool arcoreFound    = false;
    bool deviceJsonFound = false;

    /// ── THE CLOCK THE FIT WAS MADE UNDER, READ RATHER THAN ASSUMED ──────
    ///
    /// `clocks.cameraTimestampSource` verbatim out of the pack's own
    /// `device.json` (`REALTIME` / `UNKNOWN` / `unavailable` / …), or EMPTY
    /// when there was no `device.json` or no such field.
    ///
    /// ⚠ WHY THIS IS HERE AND NOT LEFT TO THE READER.  This runner joins
    /// `sensors.jsonl` (`SensorEvent.timestamp`) to `attitude_arcore.jsonl`
    /// (ARCore's frame timestamp, i.e. the Camera2 `SENSOR_TIMESTAMP` domain)
    /// at `tauS`, whose default is ZERO everywhere on the programme — the JNI
    /// entry, the Kotlin module and the panel all pass 0.  Zero is right ONLY
    /// when the camera is on the `elapsedRealtime` clock.  `UNKNOWN` means the
    /// boot/uptime clock, which STOPS in suspend: the two series are then
    /// offset by the accumulated suspend time, which is small enough to fit and
    /// far outside the ±10 ms `basisStability` sweep — so the run would report
    /// a stable, unique winner and nothing would say what it was fitted across.
    /// The measured index is documented to WIN over the derived one, so that
    /// winner must carry the clock it was measured under.
    std::string cameraTimestampSource;

    /// The verdict on the τ = 0 assumption, as a word rather than a boolean:
    ///
    ///   "confirmed-realtime"  — device.json says REALTIME and τ is 0.
    ///   "not-realtime"        — device.json names a source that is NOT
    ///                           REALTIME and τ is 0.  The fit still runs and
    ///                           still reports its winner; this is provenance,
    ///                           not a refusal, and withholding the number
    ///                           would lose the only measurement in the pack.
    ///   "unconfirmed"         — no device.json, or no such field, and τ is 0.
    ///   "caller-supplied-tau" — τ ≠ 0, so the caller took the decision and the
    ///                           REALTIME check is not what justified it.
    ///   "not-run"             — no run happened (no pack, no ledgers).
    const char* clockAssumption = "not-run";

    S1Report report;
};

/// Read the two ledgers and run S1 over them.  Never throws.
S1PackResult runS1OnPack(const S1PackRequest& req);

/// The pack result as one JSON object — the report plus where it looked.
std::string s1PackResultToJson(const S1PackResult& r);

// ── Small exported helpers (host-tested directly) ───────────────────────────
namespace detail {

/// Locate the value of `key` at the TOP LEVEL of one JSON object, returning
/// the half-open span `[b, e)` of its raw text.
///
/// String-aware and depth-aware, so a key name occurring inside a nested
/// object or inside a string VALUE is not mistaken for the member — the
/// failure a `find("\"q\":")` would have, on a row that legitimately carries
/// `"trackingFailureReason":"…"`.
bool memberSpan(const std::string& s, const char* key, size_t* b, size_t* e);

/// Parse the span as a JSON number.  False when it is not one.
bool spanNumber(const std::string& s, size_t b, size_t e, double* out);

/// Compare the span — which must be a JSON string — with `want`.  Escapes are
/// NOT decoded: every string this reads is a machine-written enum name.
bool spanStringEquals(const std::string& s, size_t b, size_t e, const char* want);

/// Parse the span as a JSON array of exactly `n` numbers.
bool spanNumberArray(const std::string& s, size_t b, size_t e, double* out, int n);

/// `clocks.cameraTimestampSource` out of a `device.json` body.
///
/// TWO LEVELS, not a search: the top-level `clocks` member first, then the
/// field inside it.  A `find("\"cameraTimestampSource\"")` would also hit a
/// same-named key in any other block, and reporting the wrong block's value as
/// the camera clock is worse than reporting none.
///
/// False (and `*out` untouched) when the text is not an object, has no
/// `clocks`, or `clocks` has no such string member — which must NOT be read as
/// REALTIME.  Escapes are not decoded: the value is a machine-written enum
/// name.
bool cameraTimestampSource(const std::string& deviceJson, std::string* out);

}  // namespace detail

}  // namespace android
}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_ANDROID_S1_HPP
