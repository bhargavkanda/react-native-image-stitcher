// SPDX-License-Identifier: Apache-2.0
//
// sharpness_window.cpp — see sharpness_window.hpp for the design.

#include "sharpness_window.hpp"

namespace retailens {

namespace {
inline int32_t clampK(int32_t k) { return k < 1 ? 1 : k; }
} // namespace

SharpnessWindowMachine::SharpnessWindowMachine(int32_t k)
    : k_(clampK(k)) {}

void SharpnessWindowMachine::setWindowSize(int32_t k) {
    k_ = clampK(k);
    reset();
}

void SharpnessWindowMachine::reset() {
    open_      = false;
    remaining_ = 0;
    bestScore_ = -1.0;
}

bool SharpnessWindowMachine::drain() {
    if (!open_) {
        return false;
    }
    open_      = false;
    remaining_ = 0;
    // bestScore_ intentionally sticky — see header.
    return true;
}

SharpnessWindowDecision SharpnessWindowMachine::ingest(
    bool isAccept,
    double score,
    double noveltyFraction,
    double overlapThreshold)
{
    SharpnessWindowDecision decision;

    if (isAccept) {
        if (k_ <= 1) {
            // K == 1: the window machinery is bypassed — immediate
            // save, byte-for-byte the pre-v0.21 path.  A window can't
            // be open here (setWindowSize resets); clear defensively
            // anyway so a (theoretically impossible) leftover window
            // can't wedge the machine.
            open_      = false;
            remaining_ = 0;
            decision.action = SharpnessWindowAction::SaveImmediately;
            return decision;
        }
        if (open_) {
            // Force-last / time-budget accepts can re-accept before
            // the previous window filled.  Save the pending best
            // FIRST (it is a selected keyframe), then seed the new
            // window with this frame.
            bestScore_ = score;
            remaining_ = k_ - 1;
            decision.action      = SharpnessWindowAction::FlushThenOpen;
            decision.replaceBest = true;
            return decision;
        }
        open_      = true;
        bestScore_ = score;
        remaining_ = k_ - 1;
        decision.action      = SharpnessWindowAction::OpenWindow;
        decision.replaceBest = true;
        return decision;
    }

    // Gate-rejected frame — a candidate only while a window is open.
    if (!open_ || remaining_ <= 0) {
        return decision;  // None
    }

    // Overlap-drift guard (fix B): once this candidate's own novelty
    // exceeds half the gate's accept threshold, the camera has moved
    // half-way to the next keyframe boundary — close NOW and save the
    // best-so-far.  The drifted candidate does NOT compete (its
    // content no longer matches the accepted pose), no matter how
    // sharp it is.  noveltyFraction < 0 (gate didn't compute one) and
    // overlapThreshold ≤ 0 (guard disabled) never trigger.
    if (overlapThreshold > 0.0
        && noveltyFraction >= 0.0
        && noveltyFraction > 0.5 * overlapThreshold) {
        open_      = false;
        remaining_ = 0;
        decision.action      = SharpnessWindowAction::CloseAndSave;
        decision.closeReason = SharpnessWindowCloseReason::NoveltyDrift;
        return decision;
    }

    // Streaming max — replace only on a STRICTLY better score, so a
    // tie keeps the earlier (closer-to-accept-pose) frame.
    const bool replace = (score > bestScore_);
    if (replace) {
        bestScore_ = score;
    }
    remaining_ -= 1;
    if (remaining_ <= 0) {
        open_ = false;
        decision.action      = SharpnessWindowAction::CloseAndSave;
        decision.replaceBest = replace;
        decision.closeReason = SharpnessWindowCloseReason::WindowFull;
        return decision;
    }
    decision.action = replace ? SharpnessWindowAction::ReplaceBest
                              : SharpnessWindowAction::KeepBest;
    decision.replaceBest = replace;
    return decision;
}

} // namespace retailens
