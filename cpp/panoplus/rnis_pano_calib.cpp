// SPDX-License-Identifier: Apache-2.0
//
// rnis_pano_calib.cpp — implementation.  See the header for the WHY; this file
// carries the arithmetic and the handful of places where the arithmetic has a
// trap in it.

#include "rnis_pano_calib.hpp"

#include <algorithm>
#include <cmath>
#include <functional>

namespace rnis {
namespace pano {

const double kExcitationMinStepDeg = 0.02;

namespace {

constexpr double kRadToDeg = 57.29577951308232;

inline bool fin(double v) { return std::isfinite(v); }

/// Rotation vector (axis × angle, RADIANS) of `conj(a) ⊗ b`, expressed in the
/// body frame of `a`.
///
/// SHORTEST PATH: `q` and `−q` are the same rotation, and without the flip a
/// 1° increment can come back as 359° — still a unit quaternion, still
/// finite, and it would dominate every scatter matrix it entered.
///
/// ATAN2, NEVER ACOS, for the reason `rnis_pano_attitude.cpp` sets out at
/// length: near the identity — where every increment in a 100 Hz log lives —
/// `acos` loses half its significant figures to cancellation, and the floor it
/// leaves (≈ 2.4e-6 deg) sits directly on top of the quantities this file has
/// to resolve.
bool deltaRotVec(const double a[4], const double b[4], double out[3]) {
    double w = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    double x = a[3] * b[0] - a[0] * b[3] - a[1] * b[2] + a[2] * b[1];
    double y = a[3] * b[1] + a[0] * b[2] - a[1] * b[3] - a[2] * b[0];
    double z = a[3] * b[2] - a[0] * b[1] + a[1] * b[0] - a[2] * b[3];
    if (!fin(w) || !fin(x) || !fin(y) || !fin(z)) return false;
    if (w < 0.0) { w = -w; x = -x; y = -y; z = -z; }
    const double v = std::sqrt(x * x + y * y + z * z);
    const double theta = 2.0 * std::atan2(v, w);
    if (!fin(theta)) return false;
    if (!(v > 1e-15)) { out[0] = out[1] = out[2] = 0.0; return true; }
    const double s = theta / v;
    out[0] = x * s; out[1] = y * s; out[2] = z * s;
    return true;
}

/// Eigenvalues of a symmetric 3×3, DESCENDING.  Closed form (Smith), which is
/// exact enough here and keeps this translation unit free of any linear-algebra
/// dependency — the Android leg compiles this same file.
void symEig3Desc(const double m[9], double out[3]) {
    const double p1 = m[1] * m[1] + m[2] * m[2] + m[5] * m[5];
    const double q = (m[0] + m[4] + m[8]) / 3.0;
    if (!(p1 > 0.0)) {
        // Already diagonal.
        out[0] = m[0]; out[1] = m[4]; out[2] = m[8];
        std::sort(out, out + 3, std::greater<double>());
        return;
    }
    const double d0 = m[0] - q, d1 = m[4] - q, d2 = m[8] - q;
    const double p2 = d0 * d0 + d1 * d1 + d2 * d2 + 2.0 * p1;
    const double p = std::sqrt(p2 / 6.0);
    if (!(p > 0.0) || !fin(p)) {
        out[0] = out[1] = out[2] = q;
        return;
    }
    const double ip = 1.0 / p;
    // B = (A − qI)/p, then r = det(B)/2.
    const double b0 = d0 * ip, b1 = m[1] * ip, b2 = m[2] * ip;
    const double b4 = d1 * ip, b5 = m[5] * ip, b8 = d2 * ip;
    double r = 0.5 * (b0 * (b4 * b8 - b5 * b5)
                    - b1 * (b1 * b8 - b5 * b2)
                    + b2 * (b1 * b5 - b4 * b2));
    if (r < -1.0) r = -1.0;
    if (r > 1.0) r = 1.0;
    const double phi = std::acos(r) / 3.0;
    const double e0 = q + 2.0 * p * std::cos(phi);
    const double e2 = q + 2.0 * p * std::cos(phi + 2.0 * M_PI / 3.0);
    const double e1 = 3.0 * q - e0 - e2;
    out[0] = e0; out[1] = e1; out[2] = e2;
    std::sort(out, out + 3, std::greater<double>());
    // A scatter matrix is positive semi-definite; a tiny negative eigenvalue is
    // round-off, and letting it through would put a NaN in the sqrt below.
    for (int i = 0; i < 3; ++i) if (out[i] < 0.0) out[i] = 0.0;
}

double medianOf(std::vector<double> v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const std::size_t n = v.size();
    if (n % 2 == 1) return v[n / 2];
    return 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

}  // namespace

// ── 1. EXCITATION ───────────────────────────────────────────────────────────

const char* axisName(int i) {
    switch (i) {
        case 0: return "tilt";
        case 1: return "pan";
        case 2: return "roll";
        default: return "";
    }
}

AxisExcitation excitation(const std::vector<AttitudeSample>& s) {
    AxisExcitation e;
    if (s.size() < 2) return e;

    double m[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0};
    const double floorRad = kExcitationMinStepDeg / kRadToDeg;

    for (std::size_t i = 1; i < s.size(); ++i) {
        double v[3];
        if (!deltaRotVec(s[i - 1].q, s[i].q, v)) continue;
        const double theta = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if (!fin(theta)) continue;
        if (theta < floorRad) { ++e.stepsBelowFloor; continue; }
        ++e.steps;
        e.sweptDeg += theta * kRadToDeg;
        for (int k = 0; k < 3; ++k) e.perAxisDeg[k] += std::fabs(v[k]) * kRadToDeg;
        // Angle-weighted scatter: v is axis×angle, so vvᵀ is (angle²)·(axis
        // axisᵀ).  Small increments therefore contribute quadratically less,
        // which is exactly the weighting that keeps residual noise from
        // manufacturing a third axis.
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                m[r * 3 + c] += v[r] * v[c];
    }

    // Span, measured the same way `selectBasis`'s stationarity gate measures
    // it, so the two cannot disagree about what "did not move" means.
    for (std::size_t i = 1; i < s.size(); ++i)
        e.spanDeg = std::max(e.spanDeg, detail::quatDeltaDeg(s[0].q, s[i].q));

    if (e.steps < 1) return e;

    double eigRad2[3];
    symEig3Desc(m, eigRad2);
    for (int i = 0; i < 3; ++i) eigRad2[i] *= kRadToDeg * kRadToDeg;
    e.eig[0] = eigRad2[0]; e.eig[1] = eigRad2[1]; e.eig[2] = eigRad2[2];
    if (e.eig[0] > 0.0) {
        e.rank2 = std::sqrt(e.eig[1] / e.eig[0]);
        e.rank3 = std::sqrt(e.eig[2] / e.eig[0]);
    }
    e.ok = true;
    return e;
}

ExcitationVerdict gradeExcitation(const AxisExcitation& e,
                                  const ExcitationPolicy& p) {
    ExcitationVerdict v;
    for (int i = 0; i < 3; ++i) v.needMore[i] = !(e.perAxisDeg[i] >= p.minAxisDeg);
    v.exercisedAxes = 0;
    for (int i = 0; i < 3; ++i) if (!v.needMore[i]) ++v.exercisedAxes;

    // The progress meter, built from the LEAST-complete requirement so it can
    // never read "nearly there" while an axis is untouched.
    double axisSorted[3] = {e.perAxisDeg[0], e.perAxisDeg[1], e.perAxisDeg[2]};
    std::sort(axisSorted, axisSorted + 3, std::greater<double>());
    const int need = std::max(1, std::min(3, p.minExercisedAxes));
    double axisProgress = 1.0;
    if (p.minAxisDeg > 0.0)
        axisProgress = std::min(1.0, axisSorted[need - 1] / p.minAxisDeg);
    const double sweptProgress =
        p.minSweptDeg > 0.0 ? std::min(1.0, e.sweptDeg / p.minSweptDeg) : 1.0;
    const double rankProgress =
        p.minRank2 > 0.0 ? std::min(1.0, e.rank2 / p.minRank2) : 1.0;
    v.progress = std::min(sweptProgress, std::min(axisProgress, rankProgress));
    if (!(v.progress >= 0.0)) v.progress = 0.0;

    // "Too few samples" means the LOG is short, not that the phone was still.
    // A still phone delivers hundreds of increments, all of them under the
    // noise floor, and reporting that as "too-few-samples" would send the
    // operator to look at the sensor rate instead of at his own hands.
    const int totalSteps = e.steps + e.stepsBelowFloor;
    if (totalSteps < 2)           { v.reason = "too-few-samples"; return v; }
    // 5° is `selectBasis`'s own stationarity bar, repeated here so a gesture
    // this file calls sufficient can never be one that file calls stationary.
    if (e.spanDeg < 5.0)          { v.reason = "stationary"; return v; }
    if (e.steps < 2 || e.sweptDeg < p.minSweptDeg) {
        v.reason = "not-enough-turning"; return v;
    }
    // Axis COUNT before axis SEPARATION: "you only panned" is the message the
    // operator can act on, and it is the true diagnosis whenever both fire.
    if (v.exercisedAxes < need)   { v.reason = "single-axis"; return v; }
    if (e.rank2 < p.minRank2)     { v.reason = "axes-too-close"; return v; }

    v.sufficient = true;
    v.reason = "ok";
    v.progress = 1.0;
    return v;
}

// ── 2. τ ────────────────────────────────────────────────────────────────────

TauFit combineTau(const std::vector<TauRun>& runs, const TauPolicy& p) {
    TauFit f;
    f.budgetMs = p.budgetMs;
    f.runs = (int)runs.size();

    std::vector<double> taus;
    double worstR = 2.0, maxBand = 0.0;
    int malformed = 0;
    for (const TauRun& r : runs) {
        if (!r.resolved) continue;
        // A RUN WITHOUT A FINITE τ OR A FINITE PEAK IS NOT A RESOLVED RUN.
        // `worstR` starts at an impossible 2.0 and is only ever lowered, so
        // letting a non-finite peak through left the sentinel standing and
        // `minPeakR` was compared against a correlation of 2.0 — a gate that
        // cannot fail.  Fail closed instead, and SAY how many were dropped.
        if (!fin(r.tauMs) || !fin(r.peakR)) { ++malformed; continue; }
        taus.push_back(r.tauMs);
        worstR = std::min(worstR, r.peakR);
        if (fin(r.bandWidthMs)) maxBand = std::max(maxBand, r.bandWidthMs);
    }
    f.malformedRuns = malformed;
    f.resolvedRuns = (int)taus.size();
    f.worstPeakR = taus.empty() ? 0.0 : worstR;
    f.maxBandWidthMs = maxBand;
    f.smallSample = f.resolvedRuns < 5;

    if (taus.empty()) { f.reason = f.runs == 0 ? "no-runs" : "too-few-resolved-runs"; return f; }

    // EVERY statistic is computed before any gate fires, because a refusal
    // that also shows its evidence is the only kind an operator can act on.
    f.tauMs = medianOf(taus);
    double sum = 0.0;
    for (double t : taus) sum += t;
    f.meanMs = sum / (double)taus.size();
    if (taus.size() >= 2) {
        double sq = 0.0;
        for (double t : taus) { const double d = t - f.meanMs; sq += d * d; }
        f.sdMs = std::sqrt(sq / (double)(taus.size() - 1));
        f.stdErrMs = f.sdMs / std::sqrt((double)taus.size());
    }
    f.spreadMs = *std::max_element(taus.begin(), taus.end())
               - *std::min_element(taus.begin(), taus.end());
    if (p.budgetMs > 0.0) f.budgetFractionUsed = f.stdErrMs / p.budgetMs;

    if (f.resolvedRuns < p.minRuns)      { f.reason = "too-few-resolved-runs"; return f; }
    if (f.worstPeakR < p.minPeakR)       { f.reason = "weak-peak"; return f; }
    if (f.spreadMs > p.maxSpreadMs)      { f.reason = "spread-too-wide"; return f; }
    if (f.stdErrMs > p.maxStdErrMs)      { f.reason = "std-err-too-wide"; return f; }

    f.ok = true;
    f.reason = "ok";
    return f;
}

// ── 3. THE BASIS PERSIST DECISION ───────────────────────────────────────────

BasisVerdict gradeBasis(const BasisSelection& sel,
                        const AxisExcitation& exc,
                        const ExcitationPolicy& excPolicy,
                        const BasisPolicy& p) {
    BasisVerdict v;
    v.unique = sel.unique;
    v.marginDeg = sel.marginDeg;

    if (sel.ranked.empty()) {
        // The selection could not fit anything; its own reason is strictly
        // more precise than anything this function could add.
        v.reason = sel.refusal;
        return v;
    }

    const BasisFit& w = sel.ranked[0];
    v.index = w.index;
    v.label = w.label;
    v.pairs = w.pairs;
    v.rmsDeg = w.rmsDeg;
    v.maxDeg = w.maxDeg;
    if (sel.ranked.size() >= 2) {
        v.runnerUpIndex = sel.ranked[1].index;
        v.runnerUpLabel = sel.ranked[1].label;
        v.runnerUpRmsDeg = sel.ranked[1].rmsDeg;
    }

    // The drift term, computed and reported WHATEVER the persist decision is —
    // it is the number that can veto the architecture, and an architecture
    // veto must not be suppressed by a basis refusal.
    v.drift.measured = true;
    v.drift.degPerS = w.driftDegPerS;
    v.drift.rmsDetrendedDeg = w.rmsDetrendedDeg;
    v.drift.canvasPxOverSweep =
        w.driftDegPerS * v.drift.sweepSeconds * v.drift.canvasPxPerDeg;
    v.drift.withinBudget = std::fabs(v.drift.canvasPxOverSweep) <= v.drift.budgetPx;

    // ── THE TWO GATES, in the order that gives the best diagnosis ──────
    // Excitation FIRST.  It is the PHYSICAL precondition, and it is the one an
    // operator can do something about.  It is also the case `selectBasis`'s
    // own margin test cannot fully cover: a margin can open up on noise, and a
    // log that physically cannot identify C must be refused even when the fit
    // looks decisive.
    const ExcitationVerdict ev = gradeExcitation(exc, excPolicy);
    if (!ev.sufficient) { v.reason = "excitation-insufficient"; return v; }
    if (!sel.unique)    { v.reason = sel.refusal; return v; }
    if (w.pairs < p.minPairs)   { v.reason = "too-few-pairs"; return v; }
    if (w.rmsDeg > p.maxRmsDeg) { v.reason = "rms-too-large"; return v; }

    v.ok = true;
    v.reason = "ok";
    return v;
}

// ── 4. τ-SENSITIVITY OF THE BASIS ───────────────────────────────────────────

BasisStability basisStability(const std::vector<AttitudeSample>& imu,
                              const std::vector<AttitudeSample>& ref,
                              const std::vector<double>& tauCandidatesS) {
    BasisStability st;
    if (tauCandidatesS.empty()) return st;

    int winner = -1;
    bool first = true;
    bool allUnique = true;
    bool changed = false;
    double minMargin = 0.0;

    for (double tau : tauCandidatesS) {
        if (!fin(tau)) continue;
        ++st.triedOffsets;
        const BasisSelection sel = selectBasis(imu, ref, tau);
        if (!sel.unique || sel.ranked.empty()) { allUnique = false; continue; }
        const int idx = sel.ranked[0].index;
        if (first) { winner = idx; minMargin = sel.marginDeg; first = false; }
        else {
            if (idx != winner) changed = true;
            minMargin = std::min(minMargin, sel.marginDeg);
        }
        if (idx == winner) ++st.agreeingOffsets;
    }

    st.winnerIndex = winner;
    st.minMarginDeg = minMargin;
    if (st.triedOffsets == 0)      { st.reason = "no-offsets"; return st; }
    st.ok = true;
    if (changed)                   { st.reason = "winner-changed"; return st; }
    if (!allUnique)                { st.reason = "not-unique-at-some-offset"; return st; }
    if (winner < 0)                { st.reason = "not-unique-at-some-offset"; return st; }
    st.winnerStable = true;
    st.reason = "ok";
    return st;
}

}  // namespace pano
}  // namespace rnis
