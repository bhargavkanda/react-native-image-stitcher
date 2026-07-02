// SPDX-License-Identifier: Apache-2.0
//
// sharpness_window.hpp — shared pick-sharpest-in-window DECISION machine.
//
// Why a shared machine:
//   v0.21 shipped the anti-blur sharpness window as two parallel
//   platform implementations (IncrementalStitcher.swift on iOS,
//   IncrementalStitcher.kt on Android) whose window semantics were
//   re-derived independently — the 2026-07 adversarial review found
//   zero tests on either side and several subtle divergences waiting
//   to happen.  This class extracts the WINDOW DECISION logic (when to
//   open, when a candidate replaces the buffered best, when the window
//   closes) into one pure, OpenCV-free C++ class that both platforms
//   consult per event.  Buffering and I/O (deep-copied CVPixelBuffer
//   on iOS, retained NV21 ByteArray on Android) stay platform-side —
//   the machine only answers "what should you do with this frame?".
//
// Window semantics (identical to the v0.21 platform code):
//   - A gate-ACCEPTED frame opens a K-frame window seeded with itself
//     (K = sharpnessWindow config, clamped [1, 10] platform-side).
//   - The accepted frame plus up to K−1 subsequent gate-EVALUATED
//     frames are candidates; the platform scores each with the shared
//     variance-of-Laplacian metric (cpp/sharpness.{hpp,cpp}) and the
//     machine keeps a streaming max — a candidate replaces the
//     buffered best only when its score is STRICTLY better.
//   - The window closes (best is saved) when the K−1 candidate slots
//     are used up, when a new gate-accept arrives mid-window (save
//     the pending best first, then re-seed — FlushThenOpen), when the
//     overlap-drift guard fires (below), or at finalize (drain()).
//   - K == 1 bypasses the window entirely: SaveImmediately reproduces
//     the pre-v0.21 immediate-save path.
//
// Overlap-drift guard (2026-07 adversarial review, fix B):
//   Candidates arrive AFTER the accepted frame, so the saved keyframe
//   can drift away from the pose the gate accepted.  The drift was
//   previously bounded only by K × eval-cadence (frames), which is
//   unbounded in CONTENT terms on a fast pan.  The guard closes the
//   window early — saving the best-so-far, and NOT letting the
//   drifted frame compete — as soon as a candidate's own gate novelty
//   exceeds 0.5 × overlapThreshold, i.e. as soon as the camera has
//   moved half-way to the next natural keyframe boundary.  This
//   bounds the saved frame's drift in overlap terms, independent of
//   K and the eval-throttle cadence.
//
// Threading: NOT thread-safe.  Callers must serialise ingest() /
// drain() / reset() the same way they serialise the keyframe gate
// (stateLock on iOS, the window lock on Android).

#pragma once

#include <cstdint>

namespace retailens {

/// What the platform must do with the current frame / the buffered
/// best.  One action per ingest() event.
enum class SharpnessWindowAction : int32_t {
    /// Nothing to do (no window open and the event doesn't open one).
    None            = 0,
    /// K == 1: save THIS frame immediately (pre-v0.21 path, window
    /// machinery bypassed).
    SaveImmediately = 1,
    /// Accept opened a fresh window.  Buffer THIS frame as the best
    /// (replaceBest is true).
    OpenWindow      = 2,
    /// Accept arrived while a window was open: SAVE the buffered best
    /// first, then buffer THIS frame as the new window's seed
    /// (replaceBest is true).
    FlushThenOpen   = 3,
    /// Candidate strictly beat the buffered best: replace the buffer
    /// (replaceBest is true).  Window stays open.
    ReplaceBest     = 4,
    /// Candidate did not beat the best: keep the buffer.  A candidate
    /// slot was still consumed.
    KeepBest        = 5,
    /// Window closed (slots exhausted or drift guard): save the
    /// buffered best NOW.  When replaceBest is true, THIS closing
    /// candidate won the window — buffer it before saving.
    CloseAndSave    = 6,
};

/// Why a CloseAndSave fired.  NotClosed for every other action.
enum class SharpnessWindowCloseReason : int32_t {
    NotClosed    = 0,
    WindowFull   = 1,   // the K−1 candidate slots were used up
    NoveltyDrift = 2,   // candidate novelty > 0.5 × overlapThreshold
};

struct SharpnessWindowDecision {
    SharpnessWindowAction action = SharpnessWindowAction::None;
    /// True when THIS event's frame must become the buffered best
    /// (buffer + pose + score) BEFORE acting on `action`.  Set for
    /// OpenWindow / FlushThenOpen (the seed) and for ReplaceBest /
    /// the winning-candidate CloseAndSave.
    bool replaceBest = false;
    SharpnessWindowCloseReason closeReason =
        SharpnessWindowCloseReason::NotClosed;
};

/// Pure decision machine — no OpenCV, no I/O, no platform types.
/// Deterministic: the same event sequence always produces the same
/// decision sequence (covered by gtest).
class SharpnessWindowMachine {
public:
    /// @param k  total candidates per accepted keyframe (the accepted
    ///           frame + up to k−1 evaluated frames).  Clamped to ≥ 1.
    explicit SharpnessWindowMachine(int32_t k = 4);

    /// Reconfigure K between captures.  Resets any open window (the
    /// platforms call this from start(), where a leftover window
    /// belongs to a dead capture anyway).
    void setWindowSize(int32_t k);
    int32_t windowSize() const { return k_; }

    /// Feed one gate-evaluated frame.
    ///
    /// @param isAccept          the gate ACCEPTED this frame (opens /
    ///                          re-seeds a window).  false = the frame
    ///                          is a window candidate (gate-rejected).
    /// @param score             the frame's sharpness score
    ///                          (retailens::sharpnessScore).  Only
    ///                          compared within one capture.
    /// @param noveltyFraction   the gate's newContentFraction for this
    ///                          frame; pass -1.0 when the gate didn't
    ///                          compute one (never triggers the drift
    ///                          guard).
    /// @param overlapThreshold  the gate's accept threshold in [0, 1];
    ///                          the drift guard fires at half of it.
    ///                          Pass ≤ 0 to disable the guard.
    SharpnessWindowDecision ingest(bool isAccept,
                                   double score,
                                   double noveltyFraction,
                                   double overlapThreshold);

    /// Finalize-time flush: close any open window.  Returns true when
    /// a best candidate was pending — the platform must save its
    /// buffered best (the trailing keyframe).  Idempotent: a second
    /// drain() returns false.
    bool drain();

    /// Cancel / start-of-capture: discard any open window.
    void reset();

    bool isOpen() const { return open_; }
    /// Best score of the current window; sticky after close until the
    /// next reset()/re-open (so platforms can log it post-close).
    /// -1.0 when no window was ever opened since reset().
    double bestScore() const { return bestScore_; }
    int32_t remainingSlots() const { return remaining_; }

private:
    int32_t k_;
    bool    open_      = false;
    int32_t remaining_ = 0;
    double  bestScore_ = -1.0;
};

} // namespace retailens
