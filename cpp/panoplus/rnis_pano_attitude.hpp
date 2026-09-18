// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_attitude.hpp — the DECOUPLED CAPTURE PATH's attitude seam
//
//
// Step S2 of the decoupled-capture architecture (2026-08-30).
// It lands BEFORE either platform has a frame source calling it, and that is
// the whole point: this is the one piece an iOS implementation and an Android
// implementation would silently diverge on, and it is ~pure arithmetic with no
// platform API in it.  Written once, host-tested once, called from both.
//
// ── What problem this solves ─────────────────────────────────────────────
//
// The pano+ engine consumes, per frame, a world←camera attitude quaternion
// that is TIME-ALIGNED to the pixels.  On the ARKit arm that alignment is free:
// ARKit hands the plugin one `ARFrame` carrying both.  On the decoupled arm the
// pixels come from an `AVCaptureSession` / `CameraCaptureSession` and the
// attitude comes from a motion sensor running on its own clock, at its own
// rate, with its own latency.  Nothing pairs them.  This does.
//
// ── The three rules, and why each one is a REFUSAL and not a fallback ────
//
//  1. SAMPLE AT `PTS + τ`, NEVER AT ARRIVAL TIME.  On the operator's own packs
//     frame-timestamp cadence jitter is 0.4–2.8 µs while ARRIVAL jitter is
//     7.5–16.7 ms — four orders of magnitude apart.  Aligning on arrival would
//     inject the whole of that second number.
//
//  2. INTERPOLATE, NEVER SNAP.  A nearest-sample snap quantises the alignment
//     to one IMU period (~5–10 ms).  The entire error budget measured from the
//     operator's packs is 3.08 / 3.29 / 3.91 ms at p95 for the 0.50 px band
//     gate.  A snap is therefore 2–4× the whole budget, and worse, the
//     resulting measurement would be reporting ITS OWN GRID rather than the
//     physical offset.  So: SLERP between the two BRACKETING samples.
//
//  3. NEVER EXTRAPOLATE.  If no motion sample exists at or after `PTS + τ`,
//     this REFUSES the frame and counts the refusal.  Extrapolating past the
//     last sample is the one UNBOUNDED error term in the architecture: its
//     magnitude is set by how far behind the IMU happens to be, which is a
//     scheduling accident, not a bounded physical quantity.  A refused frame
//     costs one strip; an extrapolated frame corrupts the chain silently.
//     (The SOURCE may HOLD a frame for at most one IMU period first — see
//     `Config::holdBudgetS` — but the hold is a wait, never an invention.)
//
// ── τ is REFUSED, not guessed ────────────────────────────────────────────
//
// τ folds three things into one observable: the epoch difference between the
// camera and sensor timebases, the exposure-timestamp convention
// (start-of-exposure vs mid-exposure — 8.33 ms at 60 fps, ~3× the whole
// budget, on its own), and the rolling-shutter readout constant.  It is
// therefore a per-(device, lens, format) constant and it is MEASURED
// optically, by `CaptureClockProbe`.  A build with no measured τ for the
// active configuration DOES NOT SWEEP on this arm: `Config::tauMeasured`
// false makes every `align()` return the fatal `TauNotMeasured`.
//
// SIGN TRAVELS WITH THE NUMBER.  Positive τ means the motion a frame recorded
// is LATER in the sensor timebase than that frame's presentation timestamp, so
// the attitude is sampled at `pts + τ`.  Applied backwards an offset does not
// halve the error — it DOUBLES it.
//
// ── AND THE ONE WAY TO SWEEP WITHOUT ONE: `tauUncorrected` ───────────────
//
// 2026-08-31.  A τ calibration run on the operator's own device RESOLVED on 8
// of 12 runs and scattered 0.12–5.15 ms — a 5.03 ms spread, WIDER than the
// 3.08 ms budget the correction is meant to buy back — so the persist gate
// refused to write it, correctly.  But the same panel showed the RAW lag on
// the resolved runs sitting mostly INSIDE that budget, i.e. τ may not be the
// binding constraint at all.  Settling that needs a sweep at τ = 0, and the
// question it answers ("does this arm produce a good panorama?") outranks
// perfecting an input we may not need.
//
// The lazy route is to hand the seam `tauS = 0, tauMeasured = true`.  It works
// and IT IS FORBIDDEN: it writes a MEASUREMENT CLAIM into the pack for a sweep
// that measured nothing, which is the defect class this whole file exists to
// prevent (`subjectDistanceFitM`, self-scoring and 2–7.5× wrong; cages reading
// PASSED that never ran).  So the uncorrected sweep gets its OWN input,
// `Config::tauUncorrected`, and its own state that travels beside
// `tauMeasured` rather than inside it:
//
//   · `TauProvenance` is THREE-VALUED at this layer (`not-measured`,
//     `measured`, `uncorrected`) and never a boolean.  The host adds the
//     fourth distinction a pack needs — `measured` from OPTIONS vs from the
//     on-disk STORE — which this translation unit cannot know.
//   · CLAIMING BOTH IS A FATAL REFUSAL WITH ITS OWN NAME:
//     `AlignRefusal::TauModeConflict`.  A run that says it both measured τ and
//     deliberately applied none is not a run whose pack anybody can read, so
//     it does not start.  `tauConflictReason()` says which of the two shapes
//     it was.
//   · `resolveTauSource()` is the ORDER OF PRECEDENCE, host-tested here
//     because Android will need exactly the same rule: AN EXPLICIT
//     UNCORRECTED REQUEST OUTRANKS A STORED τ.  A calibration store that
//     silently supplied a measured τ over the top of the experiment would
//     mean the experiment never ran, and the pack would say it did.
//
// The gate `tauMeasured` enforces is NOT weakened by any of this: a
// configuration that is neither measured NOR explicitly uncorrected still
// refuses every frame with `TauNotMeasured`, exactly as before.
//
// ── The basis change, and why it is 24 candidates and not 576 ────────────
//
// The engine wants `R_world←cam` in the GL convention.  A motion sensor gives
// `R_ref←device` in some gravity-aligned reference frame with some device-body
// axis convention, so
//
//     R_world←cam(GL) = B · R_ref←device · C
//
// with `B` the reference-frame change and `C` the device→camera change at the
// pinned capture orientation.  **B CANCELS EXACTLY.**  The only rotation that
// reaches the geometry is the relative one, `dR = R₀ᵀ · Rᵢ`
// (rnis_pano.cpp:2963), and
//
//     (B·R₀·C)ᵀ (B·Rᵢ·C) = Cᵀ (R₀ᵀ Rᵢ) C
//
// so the arbitrary yaw datum of `.xArbitraryZVertical` (and of Android's
// `TYPE_GAME_ROTATION_VECTOR`) is STRUCTURALLY IRRELEVANT.  Only `C` survives,
// and `C` is one signed permutation with det +1 — 24 candidates, enumerated
// here, indexed stably.
//
// **AN UNVALIDATED BASIS IS NEVER SHIPPED.**  `Config::basisIndex` defaults to
// −1 and every `align()` then returns the fatal `BasisNotValidated`.  The
// index is chosen from DATA by `selectBasis()` below, not from a derivation on
// a whiteboard: the motion sensor does not touch the camera, so it can be
// logged BESIDE a live ARKit session and the candidate whose relative-rotation
// series matches ARKit's wins.
//
// ── And the term that can veto the whole architecture ────────────────────
//
// ARKit corrects gyro bias against the image every frame; a bare motion sensor
// does not.  At 11.7 canvas px per degree, a 0.01 °/s in-run bias costs ≈ 0.94
// canvas px over an 8 s sweep — the same order as the 0.68–0.85 px jog these
// packs ALREADY fail integrity on, and it accumulates LINEARLY in the
// rectification channel, which does not self-correct.  `BasisFit::driftDegPerS`
// measures it from the same concurrent log that picks `C`.  That is why S1
// gates S3: if this term alone exceeds the budget, the capture path should not
// be written yet.
//
// ── Namespace / dependencies ─────────────────────────────────────────────
//
// `rnis::pano`, beside the engine.  HAND-WRITTEN, like rnis_pano.{hpp,cpp} —
// it has no generated ancestor and is not produced by any codegen step.
//
// STL ONLY.  No OpenCV, no Apple header, no JNI.  That is not tidiness: the
// Android leg compiles this exact translation unit, and anything platform-
// shaped here would be the first crack in the "one architecture" claim.

#ifndef RNIS_PANO_ATTITUDE_HPP
#define RNIS_PANO_ATTITUDE_HPP

#include <cstddef>
#include <cstdint>
#include <vector>

namespace rnis {
namespace pano {

// ── Quaternion convention ───────────────────────────────────────────────────
// `[x, y, z, w]`, unit, Hamilton product, ACTIVE rotation of a vector.  This is
// the same convention `FrameInput::q` already carries, so the aligner's output
// drops straight into `ingest()` with no adaptor.

/// One motion-sensor attitude sample, in the SENSOR's own timebase.
struct AttitudeSample {
    double tS   = 0.0;              ///< sensor timebase, SECONDS
    double q[4] = {0, 0, 0, 1};     ///< R_ref←device
};

/// Why one frame could not be aligned.  Distinguished rather than collapsed
/// because two of them are CONFIGURATION faults that must stop the sweep, and
/// the rest are per-frame conditions the engine's own hold ladder handles.
enum class AlignRefusal : int {
    None              = 0,
    TauNotMeasured    = 1,  ///< FATAL — no measured τ for this configuration
    BasisNotValidated = 2,  ///< FATAL — `C` was never picked from data
    BufferEmpty       = 3,  ///< no motion samples yet (start-up transient)
    BeforeFirstSample = 4,  ///< target predates the oldest retained sample
    AfterLastSample   = 5,  ///< THE EXTRAPOLATION REFUSAL — the IMU is behind
    NonFiniteInput    = 6,  ///< a NaN/Inf timestamp reached the seam
    Lurch             = 7,  ///< the acceleration cage fired (see below)

    /// FATAL — the configuration claimed a MEASURED τ *and* an explicitly
    /// UNCORRECTED sweep, or claimed uncorrected while carrying a non-zero τ.
    ///
    /// It has its own enum value rather than borrowing `TauNotMeasured`
    /// because the two send an operator to opposite actions: `TauNotMeasured`
    /// means "go and measure one", this means "your caller asked for two
    /// mutually exclusive things and neither of them is what the pack would
    /// have said". Collapsing them would put a run that BELIEVED it was
    /// calibrated and a run that DECLARED itself uncorrected behind one word.
    TauModeConflict   = 8,
};

/// WHERE THE τ THIS SWEEP RAN ON CAME FROM, at this layer.  Three states, and
/// never a boolean — a boolean is exactly what let `tauS: 0, tauMeasured:
/// true` become indistinguishable from a device whose τ genuinely measured
/// zero.
///
/// The HOST splits `Measured` again into "the caller supplied it" and "it came
/// off the on-disk calibration store", which is the three-way field a pack
/// carries (`measured` / `from-store` / `uncorrected`).  That distinction is
/// deliberately NOT here: this translation unit has no store and inventing a
/// value it cannot observe would be the same defect one layer up.
enum class TauProvenance : int {
    NotMeasured = 0,   ///< no τ and none claimed — every align() refuses
    Measured    = 1,   ///< a finite, claimed-measured τ
    Uncorrected = 2,   ///< DELIBERATELY zero, and DELIBERATELY unmeasured
    Conflict    = 3,   ///< both were claimed — see `AlignRefusal::TauModeConflict`
};

/// Stable lowercase-hyphen names for the pack: `not-measured`, `measured`,
/// `uncorrected`, `conflict`.  Greppable, never localised.
const char* tauProvenanceName(TauProvenance p);

/// Stable lowercase-hyphen names, for the pack.  Never localised, never
/// re-worded: an offline harness greps these.
const char* refusalName(AlignRefusal r);

/// A configuration refusal stops the arm; a runtime refusal costs one frame.
bool refusalIsFatal(AlignRefusal r);

/// The result of aligning ONE frame.
struct AlignedAttitude {
    bool   ok       = false;
    double q[4]     = {0, 0, 0, 1};   ///< world←cam (GL), ready for FrameInput::q

    /// 0 notAvailable / 1 limited / 2 normal — the engine's own enum.
    ///
    /// DERIVED, NEVER HARDCODED.  Hardcoding `normal` would fake a signal the
    /// pack then reports as though it had been measured — derived, never
    /// hardcoded.  Here `normal` means a bracketing pair existed and the bracket
    /// gap was inside `maxBracketGapS`; `limited` means it was bracketed but
    /// the IMU had a hole in it; `notAvailable` means no bracket at all.  The
    /// engine's existing warmup / hold / abort ladder then runs on a REAL
    /// input.
    int    tracking = 0;

    AlignRefusal refusal = AlignRefusal::None;

    double targetS      = 0.0;  ///< pts + τ, the instant actually sampled
    double bracketGapS  = 0.0;  ///< t₁ − t₀ of the bracketing pair
    double alpha        = 0.0;  ///< 0..1 position inside the bracket
    double slerpAngleDeg = 0.0; ///< rotation swept across the bracket

    /// True when an acceleration magnitude was supplied AND the cage was
    /// configured.  False is reported, not silently equated with "passed".
    bool   lurchEvaluated = false;
};

/// Cumulative counters.  Every one of these rides the pack, because with
/// `t ≡ 0` the engine's own `rejectedPoseSpeed` and `maxTranslationJump` read
/// zero and a reader would conclude those cages PASSED.  They did not run.
struct AlignerCounters {
    int64_t pushed              = 0;
    int64_t droppedNonMonotonic = 0;  ///< sample arrived at/behind the previous
    int64_t droppedNonFinite    = 0;

    int64_t aligned             = 0;  ///< align() calls
    int64_t accepted            = 0;
    int64_t acceptedNormal      = 0;
    int64_t acceptedLimited     = 0;

    int64_t refusedTau          = 0;
    int64_t refusedBasis        = 0;
    int64_t refusedEmpty        = 0;
    int64_t refusedBefore       = 0;
    int64_t refusedAfter        = 0;
    int64_t refusedNonFinite    = 0;
    int64_t refusedLurch        = 0;
    /// The configuration claimed a measured τ AND an uncorrected sweep, or
    /// claimed uncorrected while carrying a non-zero τ.  Counted separately
    /// from `refusedTau` because the two mean opposite things to whoever reads
    /// the pack.
    int64_t refusedTauConflict  = 0;

    /// The cage's own honesty fields.  FOUR states, none of which may share a
    /// field with another, because three of them are NOT a pass:
    ///
    ///   `lurchEvaluated`     — the cage ran on this frame and let it through
    ///                          (or refused it: a `Lurch` refusal counts here).
    ///   `lurchNotConfigured` — no threshold was set at all.
    ///   `lurchNotEvaluated`  — a threshold existed, the frame REACHED the
    ///                          cage, and the caller supplied no acceleration.
    ///   `lurchNotReached`    — a threshold existed but the frame was refused
    ///                          UPSTREAM of the cage (no bracket, τ/basis
    ///                          unconfigured, non-finite input), so the cage
    ///                          never saw it.
    ///
    /// ⚠ 2026-08-31.  These were tallied from `alignAndCount`'s ARGUMENTS,
    /// without regard to whether `align()` had reached the cage at all — and
    /// the cage sits AFTER the bracket search, so every `after-last-sample`
    /// (the common runtime refusal on the decoupled arm) was counted as
    /// EVALUATED.  A pack reading `evaluatedFrames: 1200, refusals.lurch: 0`
    /// then said "the cage examined 1200 frames and passed them" when it had
    /// examined none of them.  They are now derived from the RESULT.
    int64_t lurchEvaluated      = 0;
    int64_t lurchNotConfigured  = 0;
    int64_t lurchNotEvaluated   = 0;
    int64_t lurchNotReached     = 0;

    double  maxBracketGapS      = 0.0;

    /// Largest |userAcceleration| the caller ever supplied, TRACKED WHETHER OR
    /// NOT THE CAGE IS CONFIGURED.
    ///
    /// It used to update only inside the configured branch, which made the
    /// threshold unknowable by construction: the cage cannot be tuned without
    /// the distribution, and the distribution was only recorded once the cage
    /// was already armed with an untuned number.  An UNCAGED sweep is now the
    /// evidence that lets the first caged one pick a threshold.
    double  maxLurchAccelMps2   = 0.0;
    /// How many frames arrived with a finite acceleration at all — the
    /// denominator `maxLurchAccelMps2` is meaningless without.
    int64_t accelSamples        = 0;
};

/// The aligner.  NOT thread-safe: one instance is owned by one queue, exactly
/// like `rnis::pano::Engine`.  On the platforms this runs on, `push()` is
/// called from the sensor callback and `align()` from the video callback, so
/// the OWNER is responsible for the mutex — deliberately not hidden in here,
/// where it would be a second, invisible lock beside the one the source
/// already needs for its frame ring.
class AttitudeAligner {
public:
    struct Config {
        /// The measured offset, SECONDS.  Positive ⇒ sample at `pts + τ`.
        double tauS        = 0.0;
        /// False ⇒ every align() is a FATAL refusal.  There is no default τ.
        bool   tauMeasured = false;

        /// τ IS DELIBERATELY ZERO AND DELIBERATELY UNMEASURED.
        ///
        /// The ONE way to sweep this arm without a measured τ, and it is a
        /// separate input rather than `tauMeasured = true` with a zero because
        /// the two must never be confusable in the pack — see the header.
        /// `align()` accepts it, `TauProvenance` reports `Uncorrected`, and
        /// every layer above carries that state beside `tauMeasured` rather
        /// than inside it.
        ///
        /// SETTING IT *AND* `tauMeasured` IS A FATAL REFUSAL
        /// (`TauModeConflict`), as is setting it with a non-zero `tauS`: an
        /// uncorrected run that applied a correction is neither of the two
        /// things it claims to be.
        bool   tauUncorrected = false;

        /// 0..23, from `selectBasis()`.  −1 ⇒ every align() is a FATAL refusal.
        int    basisIndex  = -1;

        /// Bracket gaps wider than this degrade the frame to `limited` rather
        /// than accepting it as `normal`.  Default 25 ms ≈ 5 missed samples at
        /// 200 Hz, or 2.5 at 100 Hz: wide enough not to fire on ordinary
        /// scheduler jitter, narrow enough that a real sensor stall is visible
        /// to the engine's ladder instead of being averaged over.
        double maxBracketGapS = 0.025;

        /// How long the SOURCE may wait for the IMU to catch up before calling
        /// `align()` a second time.  Carried here so both platforms read one
        /// number, but the WAIT ITSELF is the source's job — this class never
        /// blocks.  One IMU period is the design's bound; 0 disables the hold.
        double holdBudgetS = 0.006;

        /// Acceleration-magnitude cage, m/s², replacing the engine's pose-side
        /// speed cage (rnis_pano.cpp:2951), which with `t ≡ 0` can never fire.
        ///
        /// The hazard is REAL and the image side structurally cannot see it: a
        /// lurch big enough to WRAP the phase-correlation window comes back
        /// MEASURED SMALL.  The old cage bounded DISPLACEMENT; this one bounds
        /// ACCELERATION, so its threshold is a NEW NUMBER that must be tuned
        /// against a deliberate lurch — which the operator has not yet
        /// produced.  `rejectedPoseSpeed == 0` on the ARKit packs is evidence
        /// the lurch has not happened, NOT evidence the cage is unnecessary.
        ///
        /// 0 ⇒ not configured, and every frame is counted as such.
        double lurchAccelMps2 = 0.0;

        /// Retained samples.  512 at 200 Hz is 2.56 s of history — far more
        /// than any τ, and enough that a video-queue stall does not empty the
        /// ring under the frames still in flight.
        std::size_t capacity = 512;
    };

    explicit AttitudeAligner(const Config& cfg);

    /// Append one sample.  Non-finite samples and samples at or behind the
    /// newest retained timestamp are DROPPED and counted — a sensor callback
    /// that delivers out of order would otherwise break the bracket search's
    /// monotonicity assumption, and a binary search over an unsorted array
    /// fails silently rather than loudly.
    void push(const AttitudeSample& s);
    void push(double tS, const double q[4]);

    /// Align one frame.
    ///
    /// `ptsS`           — the frame's PRESENTATION timestamp, camera timebase.
    /// `accelMagMps2`   — |userAcceleration| for the lurch cage.  Pass a
    ///                    non-finite value (e.g. NaN) for "not available"; it
    ///                    is counted as not-evaluated, never as a pass.
    AlignedAttitude align(double ptsS, double accelMagMps2) const;

    /// Convenience: no acceleration available.
    AlignedAttitude align(double ptsS) const;

    /// `align()` plus counter update.  The const overload above exists so a
    /// test (or a τ sweep) can probe the same arithmetic without polluting the
    /// counters that ride the pack.
    AlignedAttitude alignAndCount(double ptsS, double accelMagMps2);

    const AlignerCounters& counters() const { return counters_; }
    const Config&          config()   const { return cfg_; }

    /// Newest retained sample timestamp, or NaN when empty.  The source needs
    /// it to decide whether a HOLD could possibly help: if the newest sample
    /// is already past `pts + τ`, waiting cannot change the answer.
    double newestSampleS() const;
    double oldestSampleS() const;
    std::size_t size() const { return count_; }

    /// True when this configuration can never align anything, so the caller
    /// can refuse to START rather than producing a sweep of refusals.
    ///
    /// An EXPLICITLY UNCORRECTED configuration (`tauUncorrected`, basis valid)
    /// IS usable — that is the whole of the 2026-08-31 change.  A
    /// configuration that is neither measured nor uncorrected is not, exactly
    /// as before, and one that claims BOTH is not either.
    bool configurationIsUsable() const;

    /// WHERE THIS SWEEP'S τ CAME FROM, three-valued (plus the conflict state).
    /// Derived from the configuration at construction; never stored as a
    /// boolean anywhere.
    TauProvenance tauProvenance() const;

    /// When `tauProvenance() == Conflict`, WHICH shape of conflict it was —
    /// `"measured-and-uncorrected"` or `"uncorrected-with-nonzero-tau"`.
    /// Empty string otherwise.  Stable, greppable, and carried into the
    /// refusal message so the caller is told which of its two claims to drop.
    const char* tauConflictReason() const;

private:
    Config          cfg_;
    std::vector<AttitudeSample> ring_;
    std::size_t     head_  = 0;      // index of the OLDEST sample
    std::size_t     count_ = 0;
    double          basis_[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    bool            basisOk_ = false;
    /// nullptr ⇒ no conflict.  A `const char*` rather than a bool so the
    /// REASON travels with the fact.
    const char*     tauConflict_ = nullptr;
    AlignerCounters counters_;

    const AttitudeSample& at(std::size_t i) const;  // 0 == oldest
};

// ── WHICH τ A HOST SHOULD USE, AND IN WHAT ORDER ────────────────────────────
//
// Written HERE, host-tested here, for the same reason everything else in this
// file is: iOS reads a calibration store on disk, Android will read a
// different one, and "which source wins" is precisely the kind of rule that
// gets written twice and diverges without either copy looking wrong.
//
// It is four states because a host has four things it can be holding.
enum class TauSource : int {
    None        = 0,  ///< nothing anywhere — the arm must refuse to start
    Options     = 1,  ///< the caller supplied τ (a deliberate experiment)
    Store       = 2,  ///< the on-disk calibration record for this format
    Uncorrected = 3,  ///< an explicit τ = 0, unmeasured sweep
};

/// Stable names: `none` / `options` / `store` / `uncorrected`.
const char* tauSourceName(TauSource s);

/// THE PRECEDENCE, and the one clause that matters:
///
///   **AN EXPLICIT UNCORRECTED REQUEST OUTRANKS A STORED τ.**
///
/// The store exists so a calibrated device does not have to re-measure before
/// every sweep, which means its natural behaviour is to FILL IN whatever the
/// caller left out.  That is right for a normal sweep and fatal for this one:
/// an uncorrected experiment whose τ was quietly supplied from disk is not the
/// experiment, and nothing in the resulting pack would say so.  So the
/// uncorrected request wins here, before the store is ever consulted for τ.
///
/// (The BASIS is unaffected — it is a different number with a different scope,
/// it really was measured, and an uncorrected sweep still needs it.)
TauSource resolveTauSource(bool uncorrectedRequested,
                           bool haveOptionTau,
                           bool haveStoreTau);

// ── AND WHEN THE HOST MAY *NOT* FORCE THE ZERO ──────────────────────────────
//
// Having resolved the source to `Uncorrected`, the host's next job is to force
// `tauS = 0` and write `tauMeasured = false` — deliberately, visibly, and
// stated in the pack.  It may do that only when NOTHING IN THE CALLER'S OWN
// BAG CONTRADICTS THE REQUEST.  Otherwise the forcing quietly resolves a
// contradiction this file refuses on purpose: the pack that comes out is
// truthful about τ while having swallowed a claim the caller actually made,
// and the caller never learns its claim was dropped.
//
// Written here, and host-tested here, for the same reason `resolveTauSource`
// is: the iOS bridge holds a bag of caller options and the Android one will
// hold its own, and "which shapes must be left alone to be refused" is exactly
// the rule that gets written twice and drifts without either copy looking
// wrong.
enum class TauOptionConflict : int {
    None            = 0,  ///< nothing contradicts it — force the zero and say so
    MeasuredClaim   = 1,  ///< the bag also claims `tauMeasured`
    ExplicitNonZero = 2,  ///< the bag carries a τ that is not exactly zero
};

/// Stable names: `none` / `measured-claim` / `explicit-nonzero-tau`.
const char* tauOptionConflictName(TauOptionConflict c);

/// Does the caller's own bag contradict its uncorrected request?
///
/// `None` for every sweep that did not ask to be uncorrected — there is
/// nothing to contradict.  Otherwise it NAMES the shape, and the host must
/// pass the bag on UNCHANGED so the configuration is refused with
/// `AlignRefusal::TauModeConflict` rather than silently normalised.
///
/// ⚠ `optionsClaimMeasuredTau` is the RAW CLAIM — the `tauMeasured` the caller
/// actually sent — not a host-derived "claim ∧ the number was finite".  A claim
/// with no number behind it is still a claim, and collapsing it before this
/// predicate sees it is how it gets swallowed.
///
/// `optionsTauS` is compared with `== 0.0`, so a NaN counts as non-zero: a
/// caller that sent garbage gets the refusal, never a silent zero.
TauOptionConflict inspectUncorrectedOptions(bool uncorrectedRequested,
                                            bool optionsClaimMeasuredTau,
                                            bool optionsHaveExplicitTau,
                                            double optionsTauS);

// ── WHERE THE *BASIS* CAME FROM ─────────────────────────────────────────────
//
// The basis is the half that DID calibrate on this device, and a pack that
// records it as `measured` is telling the truth — as long as it really came
// off the device's own validated store.  A caller may also hand one in, and a
// pack that stamped `measured` on THAT would be certifying a calibration
// nobody ran: precisely the defect the τ side of this file exists to prevent,
// committed on the other number.  So the word is DERIVED from the source it
// came from, never asserted beside it.
enum class BasisProvenance : int {
    NotMeasured    = 0,  ///< no basis at all — the arm cannot start
    Measured       = 1,  ///< the device's own validated calibration store
    CallerSupplied = 2,  ///< handed in by the caller; this build measured nothing
};

/// Stable names: `not-measured` / `measured` / `caller-supplied`.
const char* basisProvenanceName(BasisProvenance p);

/// `"store"` → `Measured`, `"options"` → `CallerSupplied`, anything else →
/// `NotMeasured`.  Deliberately TOTAL and deliberately unflattering: an
/// unrecognised source (a typo, a future route, a null) is the conservative
/// answer, because the failure mode being guarded is a pack that claims more
/// than it has.
BasisProvenance basisProvenanceForSource(const char* source);

// ── The basis candidates ────────────────────────────────────────────────────

/// Exactly 24: the signed permutation matrices with determinant +1.
int basisCandidateCount();

/// Row-major `C` for `index` in `[0, 24)`.  Index 0 is the IDENTITY.  The
/// order is a stable enumeration (permutation-major, then sign pattern), so an
/// index recorded in a pack means the same matrix forever.  Out-of-range
/// returns false and leaves `m` untouched.
bool basisMatrix(int index, double m[9]);

/// A short, stable label — e.g. `+x+y+z`, `+y-z+x` — for the pack and the
/// on-screen panel.  A bare integer is unreadable in a bug report.
const char* basisLabel(int index);

// ── S1: pick `C` from data, and measure the drift that can veto S3 ──────────

/// The verdict on ONE candidate basis, or on the winner.
struct BasisFit {
    bool   ok           = false;
    int    index        = -1;
    const char* label   = "";
    int    pairs        = 0;      ///< reference samples successfully bracketed

    /// Residual angle between the IMU's relative rotation (through this `C`)
    /// and the reference's, per pair.
    double rmsDeg       = 0.0;
    double maxDeg       = 0.0;
    double finalDeg     = 0.0;    ///< residual at the LAST pair

    /// Slope of the residual angle against elapsed time, degrees per second,
    /// fitted through the origin (the residual is 0 at the reference latch by
    /// construction, so a fitted intercept would be fitting noise).
    ///
    /// THIS IS THE GYRO-BIAS-DRIFT TERM, and it is the number that decides
    /// whether the decoupled arm is viable at all.  Multiply by the sweep
    /// duration and by 11.7 canvas px/deg to get the cost in the currency the
    /// integrity gate is written in.
    double driftDegPerS = 0.0;

    /// The residual with the fitted linear drift REMOVED.  If `rmsDeg` is
    /// large but this is small, the error is a bias ramp (correctable in
    /// principle); if both are large, the basis is wrong or the sensor is.
    double rmsDetrendedDeg = 0.0;
};

/// The verdict of an S1 run: the ranked candidates AND whether the log was
/// capable of deciding between them.
struct BasisSelection {
    /// Best first.  POPULATED WHENEVER A FIT WAS POSSIBLE AT ALL — including
    /// the ambiguous case, because seeing the four exactly-tied candidates is
    /// what tells the operator to re-capture with more axes in the motion.
    /// Empty only for "too-few-samples" / "stationary" / "too-few-pairs".
    /// **Never read `ranked[0].index` without checking `unique`.**
    std::vector<BasisFit> ranked;

    /// TRUE only when the runner-up is decisively worse.  **The caller must
    /// check this**, because a tie here is not a near-miss — it is exact.
    bool   unique    = false;
    double marginDeg = 0.0;         ///< rms(runner-up) − rms(winner)

    /// Stable machine-readable outcome:
    ///   "ok"              — a winner, and `unique` says whether to trust it
    ///   "too-few-samples" — the logs are too short to fit anything
    ///   "stationary"      — the reference barely rotated (see below)
    ///   "too-few-pairs"   — fewer than 3 reference samples could be bracketed
    ///   "ambiguous-axis"  — A WINNER EXISTS BUT THE LOG CANNOT IDENTIFY IT
    const char* refusal = "too-few-samples";
};

/// Search all 24 candidates against a REFERENCE attitude series.
///
/// `imu` and `ref` are each in THEIR OWN timebase; `tauS` converts a reference
/// timestamp into the IMU timebase exactly as `align()` does.  For the S1 run
/// the reference is a live ARKit session's `world←camera` quaternion logged
/// beside CoreMotion — which is possible precisely because the motion sensor
/// does NOT touch the camera.
///
/// Both series must be time-sorted.  Pairs the aligner cannot bracket are
/// skipped and reported through `BasisFit::pairs`, never extrapolated.
///
/// ── THE DEGENERACY, AND WHY IT DECIDES HOW S1 IS PERFORMED ──────────────
///
/// `C` is recovered from `dR ↦ Cᵀ·dR·C`.  If every rotation in the log is
/// about ONE axis `n`, then two candidates that agree on `Cᵀn` produce
/// IDENTICAL residuals — not similar, identical — so a pure pan identifies
/// exactly one column of `C` and leaves a **4-way exact tie**.  This was not
/// predicted; it was found by a test that fed a pure y-axis pan and got
/// candidate 20 back where candidate 2 was the truth, at the same rms.
///
/// The consequence is operational: **the S1 log must contain rotation about
/// more than one axis** — the design's "a minute of hand-waving" is load-
/// bearing, and a careful single-axis pan is the WORST possible S1 capture.
/// Under a single-axis log this returns `refusal == "ambiguous-axis"` and
/// `unique == false` rather than a plausible-looking index.
BasisSelection selectBasis(const std::vector<AttitudeSample>& imu,
                           const std::vector<AttitudeSample>& ref,
                           double tauS);

// ── Small exported helpers (host-tested directly) ───────────────────────────
namespace detail {

/// Shortest-path SLERP, `[x,y,z,w]`, both inputs assumed unit.  `a == 0` gives
/// `q0`, `a == 1` gives `q1`.  Falls back to normalised LERP below a 1e-9
/// angle, where the trig loses precision and the two are indistinguishable.
void slerp(const double q0[4], const double q1[4], double a, double out[4]);

/// Rotation angle of `q`, degrees, in `[0, 180]`.
double quatAngleDeg(const double q[4]);

/// Angle between two rotations, degrees: `angle(q0⁻¹ ⊗ q1)`.
double quatDeltaDeg(const double q0[4], const double q1[4]);

void quatToMat(const double q[4], double m[9]);   // row-major
void matToQuat(const double m[9], double q[4]);
void matMul(const double a[9], const double b[9], double out[9]);
void quatNormalize(double q[4]);

}  // namespace detail

}  // namespace pano
}  // namespace rnis

#endif  // RNIS_PANO_ATTITUDE_HPP
