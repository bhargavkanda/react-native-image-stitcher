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

}  // namespace retailens
