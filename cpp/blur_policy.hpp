// SPDX-License-Identifier: Apache-2.0
//
// blur_policy.hpp — shared anti-blur ADMISSION policy for pano keyframes.
//
// Why this exists
// ---------------
// `sharpness_window` picks the SHARPEST frame in a window — a purely
// RELATIVE choice.  That wins when the operator's motion varies (the
// micro-pauses between shelf bays: field data shows committed keyframes
// running 1.4–2.3× the seed frame's sharpness).  It cannot help when
// EVERY frame in the window is smeared, which is exactly what a smooth
// continuous pan produces: blur extent ≈ angular-velocity × exposure,
// so a steady sweep blurs every candidate by the same amount and the
// best-of-K max is still blurry.
//
// This policy adds the two judgements the window structurally cannot
// make, both computed from signals the capture pipeline already has:
//
//   1. MOTION GATE (`panRateRadPerSec`) — refuse to COMMIT a keyframe
//      while the device is slewing faster than the operator can hold
//      sharp.  The gyro rate is the direct cause term of motion blur,
//      so gating on it converts "a blurred keyframe" into "wait a beat"
//      rather than into a bad stitch input.  The window stays open, so
//      the wait costs nothing — the frames that arrive once the
//      operator steadies are simply better candidates.
//
//   2. RELATIVE SHARPNESS FLOOR (`sessionMedianScore`) — variance-of-
//      Laplacian is content-dependent (a blank wall scores ~0 however
//      sharp), which is why the window compares only within one scene
//      and never against an absolute threshold.  But a RATIO against
//      the running median of this session's accepted keyframes is
//      self-calibrating in the same way, and it CAN say "all of these
//      are anomalously soft" — the statement the window cannot make.
//
// Both are advisory: the policy returns a verdict, never performs I/O.
// The platform engines (IncrementalStitcher.swift / .kt) consult it
// alongside the window machine and act on the verdict.
//
// FAIL-OPEN is the contract.  Every disabled/absent/degenerate input
// yields `Commit` — a missing gyro, an unknown median, or a
// zero/negative threshold must never be able to block a capture.  The
// worst outcome of this policy misfiring must be "we admitted a frame
// we could have improved", never "the operator cannot capture".
//
// Threading: stateless free functions over a small POD config — no
// statics, safe to call from any thread.

#pragma once

#include <cstdint>

namespace retailens {

/// What the engine should do with a keyframe that is ready to commit.
enum class BlurAdmission : int32_t {
    /// Commit it (the default and the fail-open answer).
    Commit          = 0,
    /// The device is moving too fast: HOLD the window open and keep
    /// scoring candidates instead of committing this one.  The engine
    /// must not drop the buffered best — the hold ends when motion
    /// settles, the window's own drift guard fires, or finalize drains.
    HoldForMotion   = 1,
    /// The best candidate is anomalously soft versus this session's
    /// running median: hold for a better frame, same semantics as
    /// HoldForMotion.  (Distinct value so hosts can coach differently:
    /// "slow down" vs "hold steady / refocus".)
    HoldForSoftness = 2,
};

/// Tunables, mirroring the JS `panoQuality.antiBlur` sub-tree. All
/// zero/negative values disable their respective check (fail-open).
struct BlurPolicyConfig {
    /// Commit is held while |pan rate| exceeds this, in rad/s.
    /// 0 (default) disables the motion gate entirely.  Reference: the
    /// JS pan coach buckets at 0.5 (good) / 1.0 (warn) rad/s, so ~1.0
    /// gates only the genuinely-too-fast sweeps.
    double maxCommitPanRateRadPerSec = 0.0;

    /// Commit is held while the candidate's score is below this
    /// FRACTION of the session's running median accepted score.
    /// 0 (default) disables the floor.  ~0.6 flags "clearly softer
    /// than what this scene has been yielding".
    double minScoreFractionOfMedian = 0.0;

    /// Safety valve: never hold the same pending keyframe for more
    /// than this many consecutive evaluated frames.  Guarantees
    /// forward progress when the operator simply cannot steady (moving
    /// vehicle, shaky hands) — after this many holds the policy
    /// returns Commit regardless.  <= 0 means "no cap" and is
    /// deliberately NOT the default: the default 12 keeps a bad sensor
    /// or a pathological scene from stalling a capture forever.
    int32_t maxConsecutiveHolds = 12;
};

/// The inputs for one admission decision.  Any field that is unknown
/// must be passed as its documented "unknown" sentinel, which makes the
/// corresponding check fail open.
struct BlurAdmissionInput {
    /// Sharpness (variance-of-Laplacian) of the candidate about to be
    /// committed.  <= 0 = unknown → the softness floor is skipped.
    double candidateScore = 0.0;

    /// Running median of the sharpness scores of the keyframes already
    /// accepted this capture.  <= 0 = unknown (e.g. the FIRST keyframe,
    /// where there is no history) → the softness floor is skipped.
    double sessionMedianScore = 0.0;

    /// Magnitude of the device's angular rate about the pan axis, rad/s.
    /// < 0 = unknown (no gyro / sensor unavailable) → the motion gate is
    /// skipped.  NOTE: pass the magnitude; sign carries no information
    /// for blur.
    double panRateRadPerSec = -1.0;

    /// How many consecutive times this same pending keyframe has
    /// already been held.  The engine tracks this and resets it on
    /// commit.
    int32_t consecutiveHolds = 0;
};

/// Decide whether a ready keyframe may be committed.
///
/// Order of precedence (first match wins):
///   1. the consecutive-hold cap → Commit (forward-progress guarantee)
///   2. motion gate              → HoldForMotion
///   3. softness floor           → HoldForSoftness
///   4. otherwise                → Commit
///
/// The motion gate is checked BEFORE the softness floor because motion
/// is the CAUSE and softness the SYMPTOM: while the device is slewing,
/// a low score is expected and "slow down" is the actionable coaching.
BlurAdmission admitKeyframe(const BlurPolicyConfig& cfg,
                            const BlurAdmissionInput& in);

/// Streaming median helper for `sessionMedianScore`.
///
/// Keeps an insertion-ordered ring of the last `capacity` accepted
/// scores and reports their median.  A MEDIAN (not a mean) so one
/// spectacular or one catastrophic frame cannot drag the reference:
/// the floor must track "what this scene typically yields".
class RunningScoreMedian {
public:
    /// @param capacity  window of recent accepted scores (clamped ≥ 1).
    ///                  8 covers a typical 6-keyframe pano plus slack.
    explicit RunningScoreMedian(int32_t capacity = 8);

    /// Record one ACCEPTED keyframe's score. Non-positive scores are
    /// ignored (they carry no information and would poison the median).
    void add(double score);

    /// Median of the recorded scores, or 0.0 when none have been
    /// recorded — the documented "unknown" sentinel, so an empty
    /// history fails open.
    double median() const;

    int32_t count() const { return count_; }
    void reset();

private:
    static constexpr int32_t kMaxCapacity = 32;
    double  buf_[kMaxCapacity] = {0.0};
    int32_t capacity_ = 8;
    int32_t count_    = 0;   // how many valid entries (≤ capacity_)
    int32_t next_     = 0;   // ring write cursor
};

} // namespace retailens
