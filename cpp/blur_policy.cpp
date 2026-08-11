// SPDX-License-Identifier: Apache-2.0
//
// blur_policy.cpp — implementation of the shared anti-blur admission
// policy.  See blur_policy.hpp for the rationale; this file is
// deliberately dependency-free (no OpenCV, no platform headers) so both
// the iOS Obj-C++ bridge and the Android JNI bridge compile it as-is.

#include "blur_policy.hpp"

#include <algorithm>
#include <cmath>

namespace retailens {

namespace {

/// A value is usable only when it is finite AND positive. NaN/inf can
/// reach us from a degenerate sensor sample or a zero-variance frame;
/// treating them as "unknown" is what keeps the policy fail-open.
inline bool usable(double v) {
    return std::isfinite(v) && v > 0.0;
}

}  // namespace

BlurAdmission admitKeyframe(const BlurPolicyConfig& cfg,
                            const BlurAdmissionInput& in) {
    // 1. Forward-progress guarantee. Checked FIRST so that no other
    //    rule can starve a capture: once we have held this same pending
    //    keyframe `maxConsecutiveHolds` times, it goes in regardless of
    //    how fast or how soft it is. A capture that cannot progress is
    //    a worse failure than a soft keyframe.
    if (cfg.maxConsecutiveHolds > 0 &&
        in.consecutiveHolds >= cfg.maxConsecutiveHolds) {
        return BlurAdmission::Commit;
    }

    // 2. Motion gate — the CAUSE term of motion blur. Skipped when the
    //    gate is disabled (<= 0) or the rate is unknown/degenerate
    //    (negative, NaN, inf → `usable` false), both fail-open.
    if (usable(cfg.maxCommitPanRateRadPerSec) &&
        usable(in.panRateRadPerSec) &&
        in.panRateRadPerSec > cfg.maxCommitPanRateRadPerSec) {
        return BlurAdmission::HoldForMotion;
    }

    // 3. Relative softness floor — the SYMPTOM. Requires BOTH a
    //    candidate score and a session median to compare against; the
    //    first keyframe of a capture has no median (0.0) and therefore
    //    always passes, which is intended (there is no reference yet).
    if (usable(cfg.minScoreFractionOfMedian) &&
        usable(in.candidateScore) &&
        usable(in.sessionMedianScore)) {
        const double floor =
            in.sessionMedianScore * cfg.minScoreFractionOfMedian;
        if (in.candidateScore < floor) {
            return BlurAdmission::HoldForSoftness;
        }
    }

    return BlurAdmission::Commit;
}

// ── RunningScoreMedian ──────────────────────────────────────────────

RunningScoreMedian::RunningScoreMedian(int32_t capacity) {
    capacity_ = std::max(1, std::min(kMaxCapacity, capacity));
}

void RunningScoreMedian::add(double score) {
    // Non-positive / non-finite scores carry no information about the
    // scene's typical sharpness and would drag the median toward zero,
    // weakening the very floor they'd be feeding. Drop them.
    if (!usable(score)) return;
    buf_[next_] = score;
    next_ = (next_ + 1) % capacity_;
    if (count_ < capacity_) ++count_;
}

double RunningScoreMedian::median() const {
    if (count_ <= 0) return 0.0;  // documented "unknown" → fails open
    double sorted[kMaxCapacity];
    std::copy(buf_, buf_ + count_, sorted);
    std::sort(sorted, sorted + count_);
    const int32_t mid = count_ / 2;
    // Even count → mean of the two central samples; odd → the middle.
    return (count_ % 2 == 0)
        ? 0.5 * (sorted[mid - 1] + sorted[mid])
        : sorted[mid];
}

void RunningScoreMedian::reset() {
    count_ = 0;
    next_  = 0;
}

}  // namespace retailens
