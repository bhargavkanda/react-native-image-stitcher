// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <array>

#include "stitcher.hpp"  // StitchMode only — stitcher.hpp is OpenCV-free

// ─────────────────────────────────────────────────────────────────────
// Flattened stitch-rung ladder — the pure planning/selection core of the
// high-level retry orchestration in stitcher.cpp.
//
// 2026-08-17 field evidence (Galaxy A35, 10-frame lateral pan): the old
// orchestration ran a 3-attempt PANORAMA threshold ladder WITH matcher
// loosening (matchConf 0.25/0.20 + rangeWidth 3) + a best-attempt
// re-estimation, then a FULL spherical re-ladder (useless — the warper
// plays no role in estimateTransform), then a SCANS rescue at 0.3 only:
// 8 estimateTransform runs worst case, 4m41s wall, and one bundle-adjust
// at matchConf 0.20 / rangeWidth 3 wedged 30 minutes at 100 % CPU.
// SCANS@1.0 solved the same capture 10/10 in ~3 s.  Meanwhile scans@0.3
// produced GARBAGE that passed the disjoint+utilization validators (10
// frames collapsed into a 722×718 canvas on-device; scattered islands on
// a 4674×3381 canvas offline).
//
// The redesign: four single-attempt rungs, THRESHOLD-ONLY (no matcher /
// registration-resolution escalation anywhere — the escalation was both
// the garbage source and the wedge source), primary model first, opposite
// model as the cross-model rescue.  scans@0.3 is eliminated outright.
//
// Header-only + OpenCV-free on purpose: the rung plan and the best-rung
// preference are the pieces worth unit-testing in isolation, and the cpp
// test suite is NOT OpenCV-aware.  Keep this file free of any cv::
// dependency.
// ─────────────────────────────────────────────────────────────────────

namespace retailens {

// One rung of the flattened ladder: which model to run and the single
// panoConfidenceThresh for its ONE estimateTransform attempt.
struct LadderRung {
    StitchMode mode;
    double     confidenceThresh;
};

constexpr int kStitchLadderRungs = 4;

// Rung plan for a given primary mode (the motion resolver's verdict, or a
// caller-pinned mode).  Primary model gets both its rungs FIRST so a
// correctly-classified capture never pays for the opposite model:
//
//   Panorama-primary:  pan@1.00 → pan@0.30 → scans@1.00 → scans@0.50
//   Scans-primary:     scans@1.00 → scans@0.50 → pan@1.00 → pan@0.30
//
// Threshold floors differ per model on purpose: PANORAMA keeps its proven
// 0.30 floor (boundary frames statistically register last), while SCANS
// floors at 0.50 — scans@0.3 admits pairings so weak that the affine
// mosaic collapses (the 722×718 10-frame squeeze above) and is banned
// from every plan.
inline std::array<LadderRung, kStitchLadderRungs> planStitchLadder(
    StitchMode primary) {
    if (primary == StitchMode::Scans) {
        return {{ { StitchMode::Scans,    1.00 },
                  { StitchMode::Scans,    0.50 },
                  { StitchMode::Panorama, 1.00 },
                  { StitchMode::Panorama, 0.30 } }};
    }
    return {{ { StitchMode::Panorama, 1.00 },
              { StitchMode::Panorama, 0.30 },
              { StitchMode::Scans,    1.00 },
              { StitchMode::Scans,    0.50 } }};
}

// The ladder may grow by AT MOST ONE dynamic rung (the spherical extra
// rung below), so tmp-file naming, the orphan sweep and the tests all
// bound the rung index by this, not by kStitchLadderRungs.
constexpr int kMaxLadderRungs = kStitchLadderRungs + 1;

// Best-rung preference: a LATER rung only displaces the incumbent when it
// retained STRICTLY more frames.  Ties keep the earlier rung — earlier
// rungs sit higher on the plan (primary model, higher threshold), so on
// equal coverage the earlier result is the more trustworthy geometry.
// Frame count is the one comparable quality signal the rungs share
// (StitchResult::framesIncluded); per-rung outputs are isolated in .tmp
// files precisely so this predicate alone decides what gets promoted.
inline bool ladderRungBeatsBest(int rungFramesIncluded,
                                int bestFramesIncluded) {
    return rungFramesIncluded > bestFramesIncluded;
}

// N-1 short-circuit (2026-08-17 review): a validated rung that retained
// ALL BUT ONE frame promotes immediately, exactly like a complete one.
// The single-dropped-frame shape is the DOMINANT partial in the field —
// a motion-blurred boundary keyframe that registers in no mode — so
// walking the remaining rungs costs up to 3 more full stitches (decode +
// registration + GB-class compose + JPEG encode each) chasing one frame
// that later rungs almost never recover, and the tie rule would discard
// their work anyway.  Legacy behaviour accepted exactly this partial at
// the ladder floor after ONE compose; this predicate restores that cost
// profile.  framesIncluded > 0 guards the degenerate Ok-with-nothing
// case; 2+-frame requests always have framesIncluded >= 2 in practice
// (estimateTransform needs two registered images).
inline bool ladderRungAcceptable(int framesIncluded, int framesRequested) {
    return framesIncluded > 0 && framesIncluded >= framesRequested - 1;
}

// Cannot-improve early-out (2026-08-17 review): once the outer ladder
// holds a best partial of M frames, a later rung whose estimate retained
// N <= M frames can never be promoted (ladderRungBeatsBest is strict >),
// so composing it — the expensive, jetsam-relevant stage — is pure waste.
// The impl consults this right after estimateTransform, BEFORE
// composePanorama, and skips the compose.  bestFramesSoFar < 0 = no best
// yet (never skips).
inline bool rungCannotImproveBest(int framesIncluded, int bestFramesSoFar) {
    return bestFramesSoFar >= 0 && framesIncluded <= bestFramesSoFar;
}

// Terminal rung failures — codes that stop the ladder outright because a
// mode/threshold change cannot fix them:
//   InvalidArgument / ImageReadFailed / ImageWriteFailed — input- or
//     filesystem-invariant; every further rung fails identically after a
//     full decode pass.
//   PreStitchMemoryAbort — the headroom gate's own verdict; mode-
//     independent by construction.
//   UnknownCvException — the classification bucket a CAUGHT native OOM
//     lands in (std::bad_alloc / cv StsNoMem from cv::Stitcher internals).
//     2026-08-17 jetsam RCA: relaunching a full stitch right after an OOM
//     re-peaked the process and produced the observed iPad jetsam kill,
//     so the base orchestration excluded this bucket from EVERY retry
//     trigger — the ladder must too.  The per-rung headroom re-gate is
//     NOT sufficient protection here: the failed rung's Mats are
//     RAII-freed before the gate re-reads rss (so it sees post-free
//     headroom and admits the relaunch), and on devices where rss/RAM is
//     unmeasurable the relaunch would run entirely uncapped.  A genuine
//     transient cv failure loses its (rarely useful) retry; an OOM
//     surfaces immediately as a classified error instead of a second
//     memory peak.
inline bool ladderErrorIsTerminal(StitchErrorCode code) {
    return code == StitchErrorCode::InvalidArgument
        || code == StitchErrorCode::ImageReadFailed
        || code == StitchErrorCode::ImageWriteFailed
        || code == StitchErrorCode::PreStitchMemoryAbort
        || code == StitchErrorCode::UnknownCvException;
}

// Dynamic spherical extra rung (2026-08-17 review) — the replacement for
// BOTH deleted spherical rescues (the wrapper-level full re-ladder and
// the compose-stage in-place re-compose, which was UB: OpenCV 4.10's
// composePanorama clears seam_est_imgs_ after the first compose, so a
// parameterless second call indexes a destroyed vector).  When a
// PANORAMA rung launched with a non-spherical warper fails on a shape
// spherical geometry can fix — LowQualityStitch (marooned / disjoint /
// predictive-utilization reject of an unbounded plane warp) or
// WarpFailed (degenerate/oversized plane canvas) — the ladder enqueues
// ONE extra rung: same mode, same threshold, warper pinned to spherical,
// immediately after the failing rung.  It is a normal fresh runOnce
// (re-estimation accepted — the path is rare and correctness beats the
// saved registration) with the same reservation gate and wall-clock
// budget as every rung.  At most one per ladder; never for SCANS rungs
// (SCANS hard-wires its affine warper — a spherical override is
// meaningless there).
inline bool sphericalExtraRungWarranted(StitchMode rungMode,
                                        StitchErrorCode code,
                                        bool rungWarperWasSpherical,
                                        bool alreadyEnqueued) {
    if (alreadyEnqueued || rungWarperWasSpherical) return false;
    if (rungMode != StitchMode::Panorama) return false;
    return code == StitchErrorCode::LowQualityStitch
        || code == StitchErrorCode::WarpFailed;
}

// Collapsed-placement arming (2026-08-17 review) — the collapsed check
// (warp_guard.hpp::stitchOutputCollapsed) is armed ONLY for flattened-
// ladder rungs (singleRungMode) running SCANS:
//   * ladder-only: the manual opt-in path (incl. its high-level SCANS
//     dispatch, which still runs the legacy multi-attempt schedule down
//     to scans@0.3) is promised byte-identical — arming a new rejection
//     there breaks that contract;
//   * SCANS-only: the observed collapse (10 frames -> 722x718) is an
//     AFFINE failure shape — weak scans pairings stack frames into one
//     footprint.  PANORAMA captures legitimately re-cover the same area
//     (pan-back / oscillating scrubs, stationary-hold force-accepted
//     keyframes), where coverage grows with SPAN, not frame count, and a
//     linear-in-N floor would deterministically hard-fail valid output
//     on every rung.
inline bool collapsedCheckArmed(bool singleRungMode, StitchMode mode) {
    return singleRungMode && mode == StitchMode::Scans;
}

}  // namespace retailens
