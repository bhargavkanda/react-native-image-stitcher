// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_attitude.cpp — implementation.  See the header for the WHY; this
// file carries only the arithmetic and the few places where the arithmetic has
// a trap in it.

#include "rnis_pano_attitude.hpp"

#include <algorithm>
#include <cmath>
#include <string>

namespace rnis {
namespace pano {

namespace {

inline bool finite1(double v) { return std::isfinite(v); }

inline bool finiteQuat(const double q[4]) {
    return finite1(q[0]) && finite1(q[1]) && finite1(q[2]) && finite1(q[3]);
}

// ── The 24 candidates ───────────────────────────────────────────────────────
//
// A signed permutation matrix: column `c` is `sign[c] · e_{perm[c]}`.  Its
// determinant is `sign(perm) · sign[0] · sign[1] · sign[2]`, and we keep the
// +1 half — the −1 half are REFLECTIONS, not rotations, and a reflection here
// would silently mirror the canvas.
//
// Enumeration order is permutation-major (lexicographic on the permutation),
// then sign pattern (`k` as a 3-bit mask, bit c set ⇒ column c negated).  It
// is fixed forever: an index recorded in a pack must mean the same matrix in
// five years.  Index 0 is the identity by construction.

struct BasisTable {
    int  perm[24][3];
    int  sign[24][3];
    std::string label[24];
    int  n = 0;
};

const BasisTable& basisTable() {
    static const BasisTable t = [] {
        BasisTable b;
        static const int perms[6][3] = {
            {0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}};
        // Parity of each permutation above, in the same order.
        static const int parity[6] = {+1, -1, -1, +1, +1, -1};
        static const char axis[3] = {'x', 'y', 'z'};
        for (int p = 0; p < 6; ++p) {
            for (int k = 0; k < 8; ++k) {
                int s[3];
                int prod = 1;
                for (int c = 0; c < 3; ++c) {
                    s[c] = ((k >> c) & 1) ? -1 : +1;
                    prod *= s[c];
                }
                if (parity[p] * prod != +1) continue;   // reflection — drop
                std::string lab;
                for (int c = 0; c < 3; ++c) {
                    b.perm[b.n][c] = perms[p][c];
                    b.sign[b.n][c] = s[c];
                    lab += (s[c] > 0 ? '+' : '-');
                    lab += axis[perms[p][c]];
                }
                b.label[b.n] = lab;
                ++b.n;
            }
        }
        return b;
    }();
    return t;
}

}  // namespace

int basisCandidateCount() { return basisTable().n; }

bool basisMatrix(int index, double m[9]) {
    const BasisTable& t = basisTable();
    if (index < 0 || index >= t.n || m == nullptr) return false;
    for (int i = 0; i < 9; ++i) m[i] = 0.0;
    for (int c = 0; c < 3; ++c) {
        // Row-major: element (row = perm[c], col = c).
        m[t.perm[index][c] * 3 + c] = (double)t.sign[index][c];
    }
    return true;
}

const char* basisLabel(int index) {
    const BasisTable& t = basisTable();
    if (index < 0 || index >= t.n) return "invalid";
    return t.label[index].c_str();
}

const char* refusalName(AlignRefusal r) {
    switch (r) {
        case AlignRefusal::None:              return "none";
        case AlignRefusal::TauNotMeasured:    return "tau-not-measured";
        case AlignRefusal::BasisNotValidated: return "basis-not-validated";
        case AlignRefusal::BufferEmpty:       return "buffer-empty";
        case AlignRefusal::BeforeFirstSample: return "before-first-sample";
        case AlignRefusal::AfterLastSample:   return "after-last-sample";
        case AlignRefusal::NonFiniteInput:    return "non-finite-input";
        case AlignRefusal::Lurch:             return "lurch";
        case AlignRefusal::TauModeConflict:   return "tau-mode-conflict";
    }
    return "unknown";
}

bool refusalIsFatal(AlignRefusal r) {
    return r == AlignRefusal::TauNotMeasured
        || r == AlignRefusal::BasisNotValidated
        || r == AlignRefusal::TauModeConflict;
}

const char* tauProvenanceName(TauProvenance p) {
    switch (p) {
        case TauProvenance::NotMeasured: return "not-measured";
        case TauProvenance::Measured:    return "measured";
        case TauProvenance::Uncorrected: return "uncorrected";
        case TauProvenance::Conflict:    return "conflict";
    }
    return "unknown";
}

const char* tauSourceName(TauSource s) {
    switch (s) {
        case TauSource::None:        return "none";
        case TauSource::Options:     return "options";
        case TauSource::Store:       return "store";
        case TauSource::Uncorrected: return "uncorrected";
    }
    return "unknown";
}

TauSource resolveTauSource(bool uncorrectedRequested,
                           bool haveOptionTau,
                           bool haveStoreTau) {
    // THE UNCORRECTED REQUEST IS CHECKED FIRST, and that ordering IS the rule.
    // Putting the store ahead of it — which is what a host's ordinary
    // "fill in whatever the caller omitted" fallback does by default — would
    // hand the experiment a measured τ off disk and leave nothing anywhere
    // saying the experiment did not run.
    if (uncorrectedRequested) return TauSource::Uncorrected;
    if (haveOptionTau)        return TauSource::Options;
    if (haveStoreTau)         return TauSource::Store;
    return TauSource::None;
}

const char* tauOptionConflictName(TauOptionConflict c) {
    switch (c) {
        case TauOptionConflict::None:            return "none";
        case TauOptionConflict::MeasuredClaim:   return "measured-claim";
        case TauOptionConflict::ExplicitNonZero: return "explicit-nonzero-tau";
    }
    return "unknown";
}

TauOptionConflict inspectUncorrectedOptions(bool uncorrectedRequested,
                                            bool optionsClaimMeasuredTau,
                                            bool optionsHaveExplicitTau,
                                            double optionsTauS) {
    // Not the experiment: nothing here has an opinion, and the calibrated path
    // is byte-for-byte what it was.
    if (!uncorrectedRequested) return TauOptionConflict::None;
    // THE CLAIM AS MADE.  Deliberately checked before the number, and
    // deliberately not conditioned on the number being finite: "I measured τ"
    // with nothing behind it is still a claim, and a host that collapsed it to
    // false before asking would swallow the contradiction instead of naming it.
    if (optionsClaimMeasuredTau) return TauOptionConflict::MeasuredClaim;
    // `!(x == 0.0)` rather than `x != 0.0` so a NaN lands on the REFUSING side.
    // The caller sent a number; it is not zero; a run calling itself
    // uncorrected would have applied it.
    if (optionsHaveExplicitTau && !(optionsTauS == 0.0))
        return TauOptionConflict::ExplicitNonZero;
    return TauOptionConflict::None;
}

const char* basisProvenanceName(BasisProvenance p) {
    switch (p) {
        case BasisProvenance::NotMeasured:    return "not-measured";
        case BasisProvenance::Measured:       return "measured";
        case BasisProvenance::CallerSupplied: return "caller-supplied";
    }
    return "unknown";
}

BasisProvenance basisProvenanceForSource(const char* source) {
    if (source == nullptr) return BasisProvenance::NotMeasured;
    const std::string s(source);
    // Exact matches only.  A near-miss is NOT read generously: the whole point
    // of deriving this word is that nothing gets to claim `measured` by
    // accident.
    if (s == "store")   return BasisProvenance::Measured;
    if (s == "options") return BasisProvenance::CallerSupplied;
    return BasisProvenance::NotMeasured;
}

// ── detail:: quaternion arithmetic ──────────────────────────────────────────
namespace detail {

void quatNormalize(double q[4]) {
    const double n = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!(n > 0.0) || !std::isfinite(n)) { q[0] = q[1] = q[2] = 0.0; q[3] = 1.0; return; }
    const double inv = 1.0 / n;
    q[0] *= inv; q[1] *= inv; q[2] *= inv; q[3] *= inv;
}

void slerp(const double q0[4], const double q1[4], double a, double out[4]) {
    double b[4] = {q1[0], q1[1], q1[2], q1[3]};
    double dot = q0[0] * b[0] + q0[1] * b[1] + q0[2] * b[2] + q0[3] * b[3];
    // SHORTEST PATH.  `q` and `−q` are the same rotation, so without this the
    // interpolation can take the long way round the 4-sphere — a 350° sweep
    // across a 10° bracket, which is not a subtle error but it IS a silent one
    // (the output is still a unit quaternion).
    if (dot < 0.0) {
        for (int i = 0; i < 4; ++i) b[i] = -b[i];
        dot = -dot;
    }
    if (dot > 1.0) dot = 1.0;
    const double theta = std::acos(dot);
    if (!(theta > 1e-9)) {
        // Below ~1e-9 rad the sines lose all their significant figures and
        // NLERP is indistinguishable from SLERP to far better than double
        // precision on a unit input.
        for (int i = 0; i < 4; ++i) out[i] = q0[i] + a * (b[i] - q0[i]);
        quatNormalize(out);
        return;
    }
    const double s = std::sin(theta);
    const double w0 = std::sin((1.0 - a) * theta) / s;
    const double w1 = std::sin(a * theta) / s;
    for (int i = 0; i < 4; ++i) out[i] = w0 * q0[i] + w1 * b[i];
    quatNormalize(out);
}

// ⚠ ATAN2, NEVER ACOS — and this is not a style preference.
//
// The obvious form is `2·acos(|w|)`.  Near the identity — which is exactly
// where every interesting measurement in this file lives, because a correct
// alignment and a correct basis both produce a residual of ZERO — `acos` loses
// half its significant figures to cancellation: `w = cos(θ/2) ≈ 1 − θ²/8`, so
// a double's 1 ulp at 1.0 maps to θ ≈ 2·√(2ε) ≈ 4.2e-8 rad ≈ **2.4e-6 deg**.
// That is a FLOOR the function cannot see below, and it was measured, not
// predicted: with the acos form the exact-by-construction SLERP tests came back
// at 1.71e-6 deg and `selectBasis` graded a perfect basis at 1.36e-6 deg rms.
// Both numbers are the instrument, not the signal — and a noise floor 2.4e-6
// deg wide sits directly on top of the gyro-bias term S1 has to resolve
// (0.01 °/s over 8 s ≈ 0.08 deg, but its per-sample residual early in a sweep
// is far smaller).
//
// `2·atan2(‖v‖, |w|)` is well-conditioned across the whole range: near the
// identity ‖v‖ ≈ θ/2 carries the information in its own leading digits.
double quatAngleDeg(const double q[4]) {
    const double v = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    return 2.0 * std::atan2(v, std::fabs(q[3])) * 180.0 / M_PI;
}

double quatDeltaDeg(const double q0[4], const double q1[4]) {
    // r = conj(q0) ⊗ q1.  The full product is needed (not just the scalar
    // part) precisely because the VECTOR part is what carries the precision
    // near zero — see the note above.
    const double w = q0[3] * q1[3] + q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2];
    const double x = q0[3] * q1[0] - q0[0] * q1[3] - q0[1] * q1[2] + q0[2] * q1[1];
    const double y = q0[3] * q1[1] + q0[0] * q1[2] - q0[1] * q1[3] - q0[2] * q1[0];
    const double z = q0[3] * q1[2] - q0[0] * q1[1] + q0[1] * q1[0] - q0[2] * q1[3];
    const double v = std::sqrt(x * x + y * y + z * z);
    return 2.0 * std::atan2(v, std::fabs(w)) * 180.0 / M_PI;
}

void quatToMat(const double q[4], double m[9]) {
    const double x = q[0], y = q[1], z = q[2], w = q[3];
    const double xx = x * x, yy = y * y, zz = z * z;
    const double xy = x * y, xz = x * z, yz = y * z;
    const double wx = w * x, wy = w * y, wz = w * z;
    m[0] = 1.0 - 2.0 * (yy + zz); m[1] = 2.0 * (xy - wz);       m[2] = 2.0 * (xz + wy);
    m[3] = 2.0 * (xy + wz);       m[4] = 1.0 - 2.0 * (xx + zz); m[5] = 2.0 * (yz - wx);
    m[6] = 2.0 * (xz - wy);       m[7] = 2.0 * (yz + wx);       m[8] = 1.0 - 2.0 * (xx + yy);
}

void matToQuat(const double m[9], double q[4]) {
    // Shepperd's method: pick the branch with the largest denominator so the
    // division is never near-singular.  The naive trace-only form loses all
    // precision near a 180° rotation, which is exactly where several of the 24
    // basis candidates live.
    const double tr = m[0] + m[4] + m[8];
    if (tr > 0.0) {
        double s = std::sqrt(tr + 1.0) * 2.0;
        q[3] = 0.25 * s;
        q[0] = (m[7] - m[5]) / s;
        q[1] = (m[2] - m[6]) / s;
        q[2] = (m[3] - m[1]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
        double s = std::sqrt(1.0 + m[0] - m[4] - m[8]) * 2.0;
        q[3] = (m[7] - m[5]) / s;
        q[0] = 0.25 * s;
        q[1] = (m[1] + m[3]) / s;
        q[2] = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
        double s = std::sqrt(1.0 + m[4] - m[0] - m[8]) * 2.0;
        q[3] = (m[2] - m[6]) / s;
        q[0] = (m[1] + m[3]) / s;
        q[1] = 0.25 * s;
        q[2] = (m[5] + m[7]) / s;
    } else {
        double s = std::sqrt(1.0 + m[8] - m[0] - m[4]) * 2.0;
        q[3] = (m[3] - m[1]) / s;
        q[0] = (m[2] + m[6]) / s;
        q[1] = (m[5] + m[7]) / s;
        q[2] = 0.25 * s;
    }
    quatNormalize(q);
}

void matMul(const double a[9], const double b[9], double out[9]) {
    double t[9];
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            t[r * 3 + c] = a[r * 3 + 0] * b[0 * 3 + c]
                         + a[r * 3 + 1] * b[1 * 3 + c]
                         + a[r * 3 + 2] * b[2 * 3 + c];
    for (int i = 0; i < 9; ++i) out[i] = t[i];
}

}  // namespace detail

// ── AttitudeAligner ─────────────────────────────────────────────────────────

AttitudeAligner::AttitudeAligner(const Config& cfg) : cfg_(cfg) {
    if (cfg_.capacity < 2) cfg_.capacity = 2;
    ring_.resize(cfg_.capacity);

    // ── THE TWO SHAPES OF "THIS PACK WOULD CLAIM SOMETHING UNTRUE" ──────
    // Derived once, here, so no caller can construct a usable aligner whose
    // provenance is ambiguous.  Both are FATAL: the sweep does not start, so
    // there is no pack to misread.
    if (cfg_.tauMeasured && cfg_.tauUncorrected) {
        tauConflict_ = "measured-and-uncorrected";
    } else if (cfg_.tauUncorrected && !(cfg_.tauS == 0.0)) {
        // A non-zero (or non-finite) τ under an uncorrected request means a
        // correction WOULD be applied by a run that calls itself uncorrected.
        // Refused rather than zeroed here: silently overwriting the caller's
        // number is how the two states get confused in the first place.  The
        // HOST forces the zero, deliberately and visibly, when nothing
        // contradicts it.
        tauConflict_ = "uncorrected-with-nonzero-tau";
    }

    basisOk_ = basisMatrix(cfg_.basisIndex, basis_);
    if (!basisOk_) {
        // Leave the identity in `basis_` so nothing reads uninitialised
        // memory, but `basisOk_` false means align() never gets that far.
        double id[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
        for (int i = 0; i < 9; ++i) basis_[i] = id[i];
    }
}

const AttitudeSample& AttitudeAligner::at(std::size_t i) const {
    return ring_[(head_ + i) % ring_.size()];
}

double AttitudeAligner::newestSampleS() const {
    if (count_ == 0) return std::nan("");
    return at(count_ - 1).tS;
}

double AttitudeAligner::oldestSampleS() const {
    if (count_ == 0) return std::nan("");
    return at(0).tS;
}

bool AttitudeAligner::configurationIsUsable() const {
    // UNCHANGED FOR EVERY CONFIGURATION THAT EXISTED BEFORE 2026-08-31: with
    // `tauUncorrected` false this is byte-for-byte `tauMeasured && basisOk_`.
    // The uncorrected arm is an ADDED admissible state, not a relaxed gate —
    // "no τ and nothing said about it" still refuses.
    return tauConflict_ == nullptr
        && (cfg_.tauMeasured || cfg_.tauUncorrected)
        && basisOk_;
}

TauProvenance AttitudeAligner::tauProvenance() const {
    if (tauConflict_ != nullptr) return TauProvenance::Conflict;
    if (cfg_.tauUncorrected)     return TauProvenance::Uncorrected;
    if (cfg_.tauMeasured)        return TauProvenance::Measured;
    return TauProvenance::NotMeasured;
}

const char* AttitudeAligner::tauConflictReason() const {
    return tauConflict_ != nullptr ? tauConflict_ : "";
}

void AttitudeAligner::push(const AttitudeSample& s) {
    if (!finite1(s.tS) || !finiteQuat(s.q)) {
        ++counters_.droppedNonFinite;
        return;
    }
    // STRICTLY increasing.  The bracket search is a binary search and a binary
    // search over an unsorted array does not fail loudly — it returns a
    // plausible neighbour.  Equal timestamps are dropped too: they would make
    // a zero-width bracket whose alpha is a division by zero.
    if (count_ > 0 && !(s.tS > at(count_ - 1).tS)) {
        ++counters_.droppedNonMonotonic;
        return;
    }
    AttitudeSample n = s;
    detail::quatNormalize(n.q);
    if (count_ < ring_.size()) {
        ring_[(head_ + count_) % ring_.size()] = n;
        ++count_;
    } else {
        ring_[head_] = n;
        head_ = (head_ + 1) % ring_.size();
    }
    ++counters_.pushed;
}

void AttitudeAligner::push(double tS, const double q[4]) {
    AttitudeSample s;
    s.tS = tS;
    for (int i = 0; i < 4; ++i) s.q[i] = q[i];
    push(s);
}

AlignedAttitude AttitudeAligner::align(double ptsS) const {
    return align(ptsS, std::nan(""));
}

AlignedAttitude AttitudeAligner::align(double ptsS, double accelMagMps2) const {
    AlignedAttitude out;

    // ── Configuration refusals come FIRST and are FATAL ─────────────────
    // Checked before anything else so a build with no measured τ cannot
    // produce a single aligned frame, however good the sensor data is.
    // THE CONFLICT OUTRANKS THE MISSING-τ REFUSAL.  Both claims present is a
    // different fault from no claim at all, and it sends the caller somewhere
    // else entirely — so it must not be reported as "go and measure a τ".
    if (tauConflict_ != nullptr) { out.refusal = AlignRefusal::TauModeConflict; return out; }
    // An EXPLICITLY UNCORRECTED sweep passes this gate.  Nothing else does:
    // `tauUncorrected` false leaves the original condition untouched.
    if (!cfg_.tauMeasured && !cfg_.tauUncorrected) {
        out.refusal = AlignRefusal::TauNotMeasured;
        return out;
    }
    if (!basisOk_)         { out.refusal = AlignRefusal::BasisNotValidated; return out; }

    if (!finite1(ptsS) || !finite1(cfg_.tauS)) {
        out.refusal = AlignRefusal::NonFiniteInput;
        return out;
    }

    // SIGN: positive τ ⇒ the motion this frame recorded is LATER in the sensor
    // timebase, so we sample AHEAD of the presentation timestamp.
    const double target = ptsS + cfg_.tauS;
    out.targetS = target;

    if (count_ == 0)                { out.refusal = AlignRefusal::BufferEmpty; return out; }
    if (target < at(0).tS)          { out.refusal = AlignRefusal::BeforeFirstSample; return out; }
    // THE EXTRAPOLATION REFUSAL.  Never invent attitude past the last sample.
    if (target > at(count_ - 1).tS) { out.refusal = AlignRefusal::AfterLastSample; return out; }

    // Bracket: largest i with at(i).tS <= target.  count_ >= 1 and the two
    // range checks above guarantee such an i exists and that i < count_-1
    // unless target lands exactly on the newest sample.
    std::size_t lo = 0, hi = count_ - 1;
    while (lo < hi) {
        const std::size_t mid = lo + (hi - lo + 1) / 2;
        if (at(mid).tS <= target) lo = mid; else hi = mid - 1;
    }
    const std::size_t i0 = lo;
    const std::size_t i1 = (i0 + 1 < count_) ? i0 + 1 : i0;

    const AttitudeSample& s0 = at(i0);
    const AttitudeSample& s1 = at(i1);
    const double gap = s1.tS - s0.tS;
    double alpha = 0.0;
    if (gap > 0.0) alpha = (target - s0.tS) / gap;
    if (alpha < 0.0) alpha = 0.0;
    if (alpha > 1.0) alpha = 1.0;

    double qi[4];
    detail::slerp(s0.q, s1.q, alpha, qi);

    // ── Basis: R_engine = R_imu · C  (B cancels — see the header) ───────
    double Rimu[9], Reng[9];
    detail::quatToMat(qi, Rimu);
    detail::matMul(Rimu, basis_, Reng);
    detail::matToQuat(Reng, out.q);

    out.bracketGapS   = gap;
    out.alpha         = alpha;
    out.slerpAngleDeg = detail::quatDeltaDeg(s0.q, s1.q);

    // ── The lurch cage ─────────────────────────────────────────────────
    // Replaces the engine's pose-side speed cage, which with `t ≡ 0` can never
    // fire.  A lurch is reported as `notAvailable` rather than as a silent
    // drop so the engine's OWN hold-and-abort ladder runs on it, and the frame
    // still gets a ledger row.
    if (cfg_.lurchAccelMps2 > 0.0) {
        if (finite1(accelMagMps2)) {
            out.lurchEvaluated = true;
            if (accelMagMps2 > cfg_.lurchAccelMps2) {
                out.refusal = AlignRefusal::Lurch;
                out.tracking = 0;
                out.ok = false;
                return out;
            }
        }
    }

    // ── Tracking, DERIVED ──────────────────────────────────────────────
    out.tracking = (gap <= cfg_.maxBracketGapS) ? 2 : 1;
    out.ok = true;
    return out;
}

AlignedAttitude AttitudeAligner::alignAndCount(double ptsS, double accelMagMps2) {
    const AlignedAttitude r = align(ptsS, accelMagMps2);
    ++counters_.aligned;

    // ── THE ACCELERATION LEDGER, INDEPENDENT OF THE CAGE ────────────────
    // Recorded on every frame that carried a finite magnitude, configured or
    // not.  The cage's threshold is a number in a currency nothing in this
    // repo has ever measured, and it can only be chosen from the distribution
    // an UNCAGED sweep produces.  Tracking this inside the configured branch
    // (as it was until 2026-08-31) made the first threshold unknowable.
    if (finite1(accelMagMps2)) {
        ++counters_.accelSamples;
        if (accelMagMps2 > counters_.maxLurchAccelMps2)
            counters_.maxLurchAccelMps2 = accelMagMps2;
    }

    // ── THE CAGE'S OWN FOUR-WAY LEDGER, DERIVED FROM THE RESULT ─────────
    // `r.lurchEvaluated` is set by `align()` at the cage itself, so it is the
    // only honest source for "the cage saw this frame".  Counting from the
    // ARGUMENTS — which is what this did — tallied every frame refused
    // upstream of the cage (`after-last-sample` above all) as evaluated.
    if (r.lurchEvaluated) {
        ++counters_.lurchEvaluated;
    } else if (cfg_.lurchAccelMps2 <= 0.0) {
        ++counters_.lurchNotConfigured;
    } else if (r.refusal != AlignRefusal::None) {
        // Configured, but the frame died before the cage: no bracket, no τ, no
        // basis, non-finite input.  NOT "the cage passed it".
        ++counters_.lurchNotReached;
    } else {
        // Configured, the frame reached the cage, and no acceleration arrived.
        ++counters_.lurchNotEvaluated;
    }

    if (r.ok) {
        ++counters_.accepted;
        if (r.tracking == 2) ++counters_.acceptedNormal; else ++counters_.acceptedLimited;
        if (r.bracketGapS > counters_.maxBracketGapS)
            counters_.maxBracketGapS = r.bracketGapS;
        return r;
    }
    switch (r.refusal) {
        case AlignRefusal::TauNotMeasured:    ++counters_.refusedTau; break;
        case AlignRefusal::BasisNotValidated: ++counters_.refusedBasis; break;
        case AlignRefusal::BufferEmpty:       ++counters_.refusedEmpty; break;
        case AlignRefusal::BeforeFirstSample: ++counters_.refusedBefore; break;
        case AlignRefusal::AfterLastSample:   ++counters_.refusedAfter; break;
        case AlignRefusal::NonFiniteInput:    ++counters_.refusedNonFinite; break;
        case AlignRefusal::Lurch:             ++counters_.refusedLurch; break;
        case AlignRefusal::TauModeConflict:   ++counters_.refusedTauConflict; break;
        case AlignRefusal::None:              break;
    }
    return r;
}

// ── selectBasis ─────────────────────────────────────────────────────────────

BasisSelection selectBasis(const std::vector<AttitudeSample>& imu,
                           const std::vector<AttitudeSample>& ref,
                           double tauS) {
    BasisSelection sel;
    std::vector<BasisFit> out;
    if (imu.size() < 2 || ref.size() < 3 || !finite1(tauS)) {
        sel.refusal = "too-few-samples";
        return sel;
    }

    // A basis fitted to a STATIONARY phone is meaningless: every candidate
    // reproduces the identity perfectly and the winner is noise.  Require the
    // reference to have actually rotated.  5° is well above any hand tremor
    // and far below the "minute of hand-waving" S1 asks for.
    double refSpanDeg = 0.0;
    for (std::size_t j = 1; j < ref.size(); ++j)
        refSpanDeg = std::max(refSpanDeg, detail::quatDeltaDeg(ref[0].q, ref[j].q));
    if (refSpanDeg < 5.0) {
        sel.refusal = "stationary";
        return sel;
    }

    const int n = basisCandidateCount();
    for (int bi = 0; bi < n; ++bi) {
        AttitudeAligner::Config c;
        c.tauS = tauS;
        c.tauMeasured = true;          // the caller supplies the τ under test
        c.basisIndex = bi;
        c.capacity = imu.size() + 2;
        c.maxBracketGapS = 1e9;        // the fit does not grade bracket width
        AttitudeAligner al(c);
        for (const AttitudeSample& s : imu) al.push(s);

        std::vector<double> resid;
        std::vector<double> dt;
        bool haveDatum = false;
        double q0eng[4] = {0, 0, 0, 1};
        double q0ref[4] = {0, 0, 0, 1};
        double t0 = 0.0;
        double maxDeg = 0.0, sumSq = 0.0, finalDeg = 0.0;

        for (const AttitudeSample& r : ref) {
            const AlignedAttitude a = al.align(r.tS, std::nan(""));
            if (!a.ok) continue;
            if (!haveDatum) {
                for (int k = 0; k < 4; ++k) { q0eng[k] = a.q[k]; q0ref[k] = r.q[k]; }
                t0 = r.tS;
                haveDatum = true;
                continue;   // the datum's own residual is 0 by construction
            }
            // Relative rotations, both measured from their own first frame —
            // exactly what the engine consumes (dR = R₀ᵀ·Rᵢ), which is why B
            // never enters this comparison either.
            // The residual is the ANGLE BETWEEN the two relative rotations,
            // not the difference of their magnitudes: two rotations of equal
            // size about different axes are a total mismatch that a magnitude
            // difference would score as zero.
            double dEng[4], dRef[4];
            {
                // conj(q0) ⊗ q
                const double c0[4] = {-q0eng[0], -q0eng[1], -q0eng[2], q0eng[3]};
                const double c1[4] = {-q0ref[0], -q0ref[1], -q0ref[2], q0ref[3]};
                auto mul = [](const double a_[4], const double b_[4], double o[4]) {
                    o[3] = a_[3] * b_[3] - a_[0] * b_[0] - a_[1] * b_[1] - a_[2] * b_[2];
                    o[0] = a_[3] * b_[0] + a_[0] * b_[3] + a_[1] * b_[2] - a_[2] * b_[1];
                    o[1] = a_[3] * b_[1] - a_[0] * b_[2] + a_[1] * b_[3] + a_[2] * b_[0];
                    o[2] = a_[3] * b_[2] + a_[0] * b_[1] - a_[1] * b_[0] + a_[2] * b_[3];
                };
                mul(c0, a.q, dEng);
                mul(c1, r.q, dRef);
            }
            const double e = detail::quatDeltaDeg(dEng, dRef);
            resid.push_back(e);
            dt.push_back(r.tS - t0);
            sumSq += e * e;
            maxDeg = std::max(maxDeg, e);
            finalDeg = e;
        }

        if (resid.size() < 3) continue;   // this candidate contributes nothing

        BasisFit f;
        f.ok = true;
        f.index = bi;
        f.label = basisLabel(bi);
        f.pairs = (int)resid.size();
        f.rmsDeg = std::sqrt(sumSq / (double)resid.size());
        f.maxDeg = maxDeg;
        f.finalDeg = finalDeg;

        // Drift: least squares through the ORIGIN.  The residual is 0 at the
        // datum by construction, so fitting an intercept would be fitting
        // noise into a term the physics says is zero.
        double sxy = 0.0, sxx = 0.0;
        for (std::size_t k = 0; k < resid.size(); ++k) {
            sxy += dt[k] * resid[k];
            sxx += dt[k] * dt[k];
        }
        f.driftDegPerS = (sxx > 0.0) ? (sxy / sxx) : 0.0;

        double sq = 0.0;
        for (std::size_t k = 0; k < resid.size(); ++k) {
            const double r2 = resid[k] - f.driftDegPerS * dt[k];
            sq += r2 * r2;
        }
        f.rmsDetrendedDeg = std::sqrt(sq / (double)resid.size());

        out.push_back(f);
    }

    // Every candidate sees the SAME reference samples, so `out` is either
    // empty (no candidate could bracket 3 pairs) or full.  The `< 2` form is
    // defensive: `out[1]` is dereferenced below.
    if (out.size() < 2) {
        sel.refusal = "too-few-pairs";
        return sel;
    }

    std::sort(out.begin(), out.end(), [](const BasisFit& a, const BasisFit& b) {
        if (a.rmsDeg != b.rmsDeg) return a.rmsDeg < b.rmsDeg;
        return a.index < b.index;   // deterministic tie-break
    });

    // ── THE DEGENERACY GATE ────────────────────────────────────────────
    // See the header.  A log whose rotation is about ONE axis leaves four
    // candidates with EXACTLY equal residuals, and the sort's tie-break would
    // then hand back a plausible index chosen by enumeration order.  That is
    // the failure this whole file exists to prevent, so it is refused here
    // with an actionable reason rather than left to the caller to notice.
    //
    // Two bars, because a real log has noise in it: the runner-up must be
    // worse by at least 1.0° ABSOLUTE (so a near-perfect fit is not declared
    // ambiguous over floating-point dust) and by at least 2× the winner's own
    // rms (so a noisy log cannot manufacture separation out of its noise).
    sel.marginDeg = out[1].rmsDeg - out[0].rmsDeg;
    sel.unique = (sel.marginDeg > 1.0) && (sel.marginDeg > 2.0 * out[0].rmsDeg);
    sel.ranked = out;
    sel.refusal = sel.unique ? "ok" : "ambiguous-axis";
    return sel;
}

}  // namespace pano
}  // namespace rnis
