// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_calib.hpp — THE CALIBRATION STEP the decoupled arm has been
// missing.
//
// `rnis_pano_attitude.{hpp,cpp}` REFUSES to align a frame without two measured
// numbers — τ and the basis index `C`.  It is right to refuse.  But nothing in
// the programme produced either number on hardware, so the arm was not merely
// off: it was unreachable, and the refusal was the only thing anybody could
// ever observe from it.  This file is the other half — the arithmetic that
// turns an operator's five-second gesture into those two numbers, or into a
// STATED REASON why the gesture was not good enough.
//
// It is deliberately the same shape as its sibling: STL only, `rnis::pano`,
// host-tested, called from both platforms.  A calibration policy implemented
// on the iOS side would be a calibration policy Android silently re-invents,
// and the two would disagree in the one place nobody looks — the gate that
// decides whether a number is good enough to keep.
//
// ── The three jobs, and why each is here rather than in a panel ──────────
//
//  1. **EXCITATION** — grade the MOTION, before grading the fit.  The
//     prototype run proved a pure pan cannot identify `C`: a one-axis log
//     leaves an EXACT 4-way tie (margin 9.86e-15 deg) and the tie-break
//     returned the wrong candidate.  `selectBasis` now refuses that case, but
//     a refusal AFTER a five-second capture is a bad experience and a worse
//     diagnosis — the operator learns "ambiguous-axis" and not "you only
//     panned; now tilt".  `excitation()` measures the same degeneracy from the
//     motion ALONE, so it can be shown LIVE, per axis, with names an operator
//     can act on.
//
//  2. **THE τ COMBINE** — a single optical fit is a point estimate with no
//     stated error.  The study's budget is on a RESIDUAL (3.08 ms p95 to hold
//     the 0.50 canvas-px band gate) and the whole point of measuring τ is to
//     REMOVE the offset, after which what remains is the calibration's own
//     uncertainty.  So the honest gate is on the SPREAD OF REPEATS, not on the
//     magnitude of τ.  `combineTau()` is that gate.
//
//  3. **THE PERSIST DECISION** — one place, one set of bars, one stable
//     reason string.  `subjectDistanceFitM` is this repo's cautionary example:
//     a fit that was 2–7.5× wrong, saturating its own clamp, and SELF-SCORING,
//     so nothing ever reported it.  A calibration that grades itself with the
//     same code that produced it repeats that.  Here the grader is separate
//     from the fitter, its bars are named constants with stated justification,
//     and every refusal carries a machine-readable reason an offline harness
//     can grep.
//
// ── WHY MAGNITUDE IS THE WRONG BAR FOR τ, stated once ───────────────────
//
// The 2026-08-30 study says it plainly: "a *constant* lag is largely benign
// for placement and calibratable offline … **Jitter** in τ is what is
// unrecoverable."  The 3.08 / 3.29 / 3.91 ms p95 budget is the budget for the
// alignment error that SURVIVES.  Grading |τ| against it asks whether the
// disease is smaller than the tolerance for the cure: a τ of −11 ms measured
// to ±0.3 ms is an EXCELLENT calibration, and a τ of +0.9 ms recovered from a
// correlation peak of r = 0.31 is not a calibration at all.  This file grades
// the second number — the uncertainty — and reports the first as a fact.
//
// ── Namespace / dependencies ────────────────────────────────────────────
//
// `rnis::pano`, beside the engine and the aligner.  HAND-WRITTEN — it has no
// generated ancestor and is not produced by any codegen step.
// STL ONLY: no OpenCV, no Apple header, no JNI.

#ifndef RNIS_PANO_CALIB_HPP
#define RNIS_PANO_CALIB_HPP

#include <cstddef>
#include <vector>

#include "rnis_pano_attitude.hpp"

namespace rnis {
namespace pano {

// ════════════════════════════════════════════════════════════════════════
//  1.  EXCITATION — grading the GESTURE, in the frame it was performed in
// ════════════════════════════════════════════════════════════════════════

/// What the motion in an attitude log actually contained.
///
/// Computed from the INCREMENTAL rotation vectors `log(Rₖᵀ·Rₖ₊₁)`, which live
/// in the BODY frame of the series — so for an ARKit `world←camera` log the
/// three components are camera-frame rotations and therefore NAMEABLE:
/// `x` = tilt (nod up/down), `y` = pan (turn left/right), `z` = roll (twist
/// about the lens axis).  For a CoreMotion `ref←device` log the same three
/// numbers are device-frame and their NAMES are exactly what `C` has not been
/// solved for yet — so `perAxisDeg` is meaningful for the reference series and
/// is deliberately NOT used to coach from the IMU one.
///
/// `eig` / `rank2` / `rank3` are FRAME-INVARIANT (a rotation of the frame is a
/// similarity transform of the scatter matrix), so those ARE comparable across
/// the two series, and a large disagreement between them is itself a finding.
struct AxisExcitation {
    bool   ok    = false;
    int    steps = 0;        ///< increments that cleared the noise floor
    int    stepsBelowFloor = 0;

    /// Σ |θₖ| over the increments, degrees.  "How much rotating happened."
    double sweptDeg = 0.0;

    /// Largest angle from the FIRST sample, degrees.  A shake about a fixed
    /// pose sweeps a lot and spans little; `selectBasis`'s own stationarity
    /// test uses this quantity, so it is reported in the same units here.
    double spanDeg = 0.0;

    /// Σ |vₖ[i]| per component, degrees.  L1, so a back-and-forth pan
    /// accumulates rather than cancelling — which is what an operator doing
    /// the gesture experiences and therefore what a live meter must show.
    double perAxisDeg[3] = {0.0, 0.0, 0.0};

    /// Eigenvalues of Σ vₖ vₖᵀ, DESCENDING, in deg².  The angle-weighting is
    /// deliberate: a milliradian of sensor noise about a third axis must not
    /// count as excitation of that axis.
    double eig[3] = {0.0, 0.0, 0.0};

    /// √(eig[1]/eig[0]) and √(eig[2]/eig[0]) — the second and third axes'
    /// amplitude relative to the dominant one, in ANGLE units.  A pure pan
    /// gives rank2 ≈ 0; the 4-way tie lives at rank2 = 0 exactly.
    double rank2 = 0.0;
    double rank3 = 0.0;
};

/// Increments turning through less than this are DROPPED from the scatter.
///
/// Not tidiness — a false-PASS defence.  Gyro noise is very nearly isotropic,
/// so at rest it fills all three eigenvalues equally and `rank2` climbs toward
/// 1.0: noise looks like PERFECT three-axis excitation.  0.02° per increment
/// is ≈ 2 °/s at 100 Hz — far above any sensor's noise floor and far below any
/// deliberate hand motion, so the floor removes the noise and keeps the
/// gesture.  `stepsBelowFloor` reports how much was removed, because a log
/// that is 95 % below the floor is a still phone whatever its rank2 says.
extern const double kExcitationMinStepDeg;

AxisExcitation excitation(const std::vector<AttitudeSample>& s);

/// The bars a gesture must clear before a basis fit is worth attempting, and
/// the COACHING that follows from missing one.
struct ExcitationPolicy {
    /// Total turning.  Below this the log is a twitch, not a gesture.
    double minSweptDeg = 90.0;
    /// Per-axis L1 turning that counts an axis as "exercised".  25° is roughly
    /// a comfortable single nod or twist, so two of them is a gesture a person
    /// performs rather than endures.
    double minAxisDeg = 25.0;
    /// How many axes must clear `minAxisDeg`.
    ///
    /// TWO, and this is a THEOREM rather than a preference.  Writing the true
    /// basis `C₀` and a candidate `C = C₀·A`, the residual vanishes for all
    /// observed increments iff `A` commutes with every one of them.  A motion
    /// exercising two independent axes generates all of SO(3), whose
    /// centraliser is {I} — so `A = I` and `C` is unique.  A motion about ONE
    /// axis `n` generates only the rotations about `n`, whose centraliser
    /// contains the quarter-turns about `n`: exactly the four signed
    /// permutations that tied at 9.86e-15 deg in the prototype run.
    int    minExercisedAxes = 2;
    /// The second eigen-amplitude, relative to the first.  Two axes 3° apart
    /// clear `minAxisDeg` twice and are still one axis; this is what catches
    /// that, and it is the same quantity the degeneracy actually turns on.
    double minRank2 = 0.25;
};

/// The verdict, with per-axis coaching attached.
struct ExcitationVerdict {
    bool sufficient = false;

    /// Stable, lowercase-hyphen, never localised — an offline harness greps
    /// these and a panel switches on them:
    ///   "ok" | "too-few-samples" | "stationary" | "single-axis" |
    ///   "axes-too-close" | "not-enough-turning"
    const char* reason = "too-few-samples";

    /// TRUE for an axis that has NOT cleared `minAxisDeg`.  The panel turns
    /// these into "tilt it up and down" / "turn it left and right" / "twist
    /// it".  Only meaningful for a series whose frame is known — i.e. the
    /// ARKit reference — see `AxisExcitation`.
    bool needMore[3] = {true, true, true};

    /// How many axes cleared the bar.
    int  exercisedAxes = 0;

    /// 0..1, for a progress meter: the least-complete of the requirements, so
    /// the bar cannot read "nearly there" while one axis is untouched.
    double progress = 0.0;
};

ExcitationVerdict gradeExcitation(const AxisExcitation& e,
                                  const ExcitationPolicy& p);

/// Human axis names for `perAxisDeg` / `needMore`, in index order.
/// `axisName(0) == "tilt"`, `1 == "pan"`, `2 == "roll"`.  Out of range → "".
const char* axisName(int i);

// ════════════════════════════════════════════════════════════════════════
//  2.  τ — combining REPEATS into a number with a stated uncertainty
// ════════════════════════════════════════════════════════════════════════

/// One optical τ measurement, as `CaptureClockProbe` produces it.
struct TauRun {
    bool   resolved    = false;  ///< the probe's own peak-strength verdict
    double tauMs       = 0.0;
    double peakR       = 0.0;
    double bandWidthMs = 0.0;    ///< plateau width at (peak − 0.005)
};

/// The bars τ must clear to be PERSISTED.
struct TauPolicy {
    /// Repeats.  ONE measurement has no uncertainty at all — only a plateau
    /// width, which is a property of the correlation's shape and not of the
    /// estimator's repeatability.  Three is the smallest number from which a
    /// spread can be quoted; the panel offers more.
    int    minRuns = 3;
    /// The probe's own peak bar, re-checked HERE so the persist decision is in
    /// one file rather than split between a Swift reducer and a TS panel.
    double minPeakR = 0.80;
    /// Max−min across the resolved runs.
    double maxSpreadMs = 2.0;
    /// Standard error of the mean.  1.0 ms spends about a THIRD of the 3.08 ms
    /// residual budget on the calibration's own error, leaving the rest for
    /// the jitter term the study calls unrecoverable.  A device that cannot
    /// reach it is REFUSED rather than persisted, because the failure mode of
    /// a silently-wrong τ is a whole sweep that looks plausible and is not.
    double maxStdErrMs = 1.0;
    /// The tightest of the study's three p95 budgets, carried so the caller
    /// needs no arithmetic and cannot use a different one.
    double budgetMs = 3.08;
};

struct TauFit {
    /// May this be persisted?  Never true on an empty or unresolved set.
    bool   ok     = false;
    /// "ok" | "no-runs" | "too-few-resolved-runs" | "weak-peak" |
    /// "spread-too-wide" | "std-err-too-wide"
    const char* reason = "no-runs";

    int    runs         = 0;
    int    resolvedRuns = 0;
    /// Runs the CALLER marked resolved but which carried a non-finite `peakR`
    /// or `tauMs`.  Counted so a refusal can say WHY the resolved count is
    /// lower than the caller expected, instead of the two silently disagreeing.
    int    malformedRuns = 0;

    /// THE NUMBER, milliseconds: the MEDIAN of the resolved runs.  Median
    /// rather than mean because with three samples one bad run should move the
    /// answer by nothing, and the spread gate below is what catches the case
    /// where "one bad run" is really "no agreement at all".
    double tauMs   = 0.0;
    double meanMs  = 0.0;
    double sdMs    = 0.0;   ///< sample SD (n−1), the spread of the estimator
    double spreadMs = 0.0;  ///< max − min
    /// sd/√n — the uncertainty ON THE PERSISTED NUMBER.  This, not |τ|, is
    /// what the study's residual budget must be compared against.
    double stdErrMs = 0.0;

    /// The WEAKEST correlation peak among the runs that counted.
    ///
    /// ⚠ 2026-08-31.  This initialised to an impossible 2.0 and was only ever
    /// LOWERED by a finite `peakR`, so a set whose every run carried a
    /// non-finite peak published `worstPeakR: 2.0` and sailed past
    /// `minPeakR 0.80`.  Unreachable through the iOS marshaller (which
    /// defaults a bad peak to 0.0 and so failed closed) but `combineTau` is
    /// the SHARED cross-platform contract the Android leg calls directly, and
    /// its own `fin()` guard says it expects non-finite input.  A run with a
    /// non-finite peak is now UNRESOLVED, which is what it is.
    double worstPeakR      = 0.0;
    double maxBandWidthMs  = 0.0;

    double budgetMs           = 3.08;
    /// stdErr / budget.  "How much of the residual budget the calibration
    /// itself has already spent."  > 1 is a refusal by `maxStdErrMs` long
    /// before it gets here; it is reported so the margin is visible, not
    /// merely the pass/fail.
    double budgetFractionUsed = 0.0;

    /// ⚠ With n = 3 the SD is itself uncertain to roughly ±40 %.  Reported as
    /// a flag rather than buried in a comment, so a panel can say so and a
    /// reader cannot mistake `sdMs` for a converged quantity.
    bool   smallSample = true;
};

TauFit combineTau(const std::vector<TauRun>& runs, const TauPolicy& p);

// ════════════════════════════════════════════════════════════════════════
//  3.  THE BASIS PERSIST DECISION — and the drift term, kept SEPARATE
// ════════════════════════════════════════════════════════════════════════

struct BasisPolicy {
    /// Residual of the winning candidate.  A correct `C` against a healthy
    /// reference sits well under a degree; 2.0° is loose enough not to reject
    /// a warm-up transient and tight enough that a wrong-but-lucky candidate
    /// cannot pass.
    double maxRmsDeg = 2.0;
    /// Minimum pairs actually bracketed.  `selectBasis` already refuses under
    /// 3; 60 is ~1 s at 60 Hz and is what makes the rms mean anything.
    int    minPairs = 60;
};

/// The gyro-bias term the study says can veto the whole architecture, kept in
/// its OWN struct and its own verdict.
///
/// ⚠ IT MUST NOT GATE PERSISTING THE BASIS, and conflating the two is the
/// obvious mistake to make here.  The basis INDEX is a discrete choice among
/// 24 signed permutations; a drifting gyro does not make a different
/// permutation correct.  Refusing to persist a correct `C` because the drift
/// is large would throw away a measurement that is still exactly right and
/// force the operator to redo the gesture for a fault the gesture cannot fix.
/// So: the basis persists on its own evidence, and the drift is reported as a
/// separate architectural verdict against its own budget.
struct DriftVerdict {
    bool   measured = false;
    double degPerS  = 0.0;
    /// degPerS × sweepSeconds × canvasPxPerDeg — the cost in the currency the
    /// integrity gate is written in.
    double canvasPxOverSweep = 0.0;
    double sweepSeconds      = 8.0;
    double canvasPxPerDeg    = 11.7;
    /// The jog p95 these packs ALREADY fail integrity at is 0.68–0.85 px, so
    /// a drift term of that size on its own is the veto the study describes.
    double budgetPx = 0.68;
    bool   withinBudget = false;

    /// ⚠ `selectBasis` fits its slope to |residual|, a MAGNITUDE, through the
    /// origin.  Zero-mean noise therefore produces a positive slope, so this
    /// number is biased HIGH — it is an upper-ish bound, not an unbiased
    /// estimate, and it must be read as one.  `rmsDetrendedDeg` next to it is
    /// what says whether the residual really is a ramp.
    double rmsDetrendedDeg = 0.0;
    bool   biasedHigh = true;
};

struct BasisVerdict {
    /// May the index be persisted?
    bool   ok     = false;
    /// "ok" | the selection's own refusal ("ambiguous-axis", "stationary",
    /// "too-few-samples", "too-few-pairs") | "excitation-insufficient" |
    /// "rms-too-large" | "too-few-pairs"
    const char* reason = "too-few-samples";

    int         index = -1;
    const char* label = "invalid";
    int         pairs = 0;
    double      rmsDeg = 0.0;
    double      maxDeg = 0.0;
    double      marginDeg = 0.0;
    bool        unique = false;

    /// The runner-up, so a reader can see WHAT was rejected and by how much.
    int         runnerUpIndex = -1;
    const char* runnerUpLabel = "invalid";
    double      runnerUpRmsDeg = 0.0;

    DriftVerdict drift;
};

/// Grade a `selectBasis` result against the gesture that produced it.
///
/// `exc` is the EXCITATION OF THE REFERENCE SERIES.  It is consulted so that a
/// selection which happened to look unique on a degenerate log is still
/// refused: `selectBasis`'s margin test is necessary but it is a test on the
/// FIT, and a fit can separate for the wrong reason (noise) on a log that
/// physically cannot identify `C`.  Two independent gates, both required.
BasisVerdict gradeBasis(const BasisSelection& sel,
                        const AxisExcitation& exc,
                        const ExcitationPolicy& excPolicy,
                        const BasisPolicy& p);

// ════════════════════════════════════════════════════════════════════════
//  4.  τ-SENSITIVITY OF THE BASIS — is the winner an artefact of the offset?
// ════════════════════════════════════════════════════════════════════════

/// The basis fit is run at a τ the caller supplies.  For the ARKit-reference
/// fit that τ is ≈ 0 (ARFrame.timestamp and CMDeviceMotion.timestamp both run
/// on the system uptime clock) — but "≈" is doing work in that sentence, and
/// the honest way to close it is to re-fit at several offsets and check the
/// ANSWER does not move.  A winner that changes under ±10 ms is a winner that
/// was chosen by the offset, not by the geometry.
struct BasisStability {
    bool   ok = false;
    int    triedOffsets = 0;
    int    agreeingOffsets = 0;
    /// True only when EVERY offset produced a unique winner AND they all
    /// agreed.  A single disagreement makes this false and is reported.
    bool   winnerStable = false;
    int    winnerIndex = -1;
    /// Smallest margin seen across the offsets — the weakest link.
    double minMarginDeg = 0.0;
    /// "ok" | "no-offsets" | "not-unique-at-some-offset" | "winner-changed"
    const char* reason = "no-offsets";
};

BasisStability basisStability(const std::vector<AttitudeSample>& imu,
                              const std::vector<AttitudeSample>& ref,
                              const std::vector<double>& tauCandidatesS);

}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_CALIB_HPP
