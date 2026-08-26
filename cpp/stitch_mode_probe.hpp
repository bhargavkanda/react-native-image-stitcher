// SPDX-License-Identifier: Apache-2.0
//
// stitch_mode_probe — decide PANORAMA vs SCANS from MATCH QUALITY.
//
// ## Why
//
// The motion resolver (`resolveStitchModeAuto`) infers the geometry from how
// the device MOVED.  That is an inference, and it has been wrong twice in ways
// that cost output quality:
//
//   - Its `ratio` is algebraically `r/(r+0.10)` where `r = tMeters/rRadians` is
//     the PIVOT RADIUS, so the pan angle cancels entirely and the verdict turns
//     only on how far behind the lens the operator turned.  At the shipped
//     threshold of 0.55 that meant `r >= 12.2 cm` — shorter than a human wrist
//     — so every hand-held pan was classified as a scan.  (Fixed by raising it
//     to 0.93; measured hand-held sweeps run 0.80-0.92.)
//   - In NON-AR there is no pose at all, so `tMeters` is the double-integrated
//     accelerometer, measured on 2026-08-26 at r = -0.28 against this
//     stitcher's own image-derived translation.  Anti-correlated.  No threshold
//     can work on that.
//
// This probe asks the question directly instead: **which geometric model
// actually describes these images?**  It answers with the SAME matcher
// `cv::Stitcher` will use moments later, so the answer is about the data rather
// than about a proxy for it — and it works identically in AR and non-AR,
// because it never touches pose or IMU.
//
// ## What it measures
//
// `cv::detail::MatchesInfo::confidence` is the quantity `leaveBiggestComponent`
// thresholds on when deciding which frames stay connected (see
// `stitcher.cpp`).  Counting pairs above that threshold under each model is
// therefore not a proxy for stitchability — it is the same arithmetic the
// stitch itself will do.
//
// Validated offline over 90 real capture sets: the two captures that shipped
// wrongly as SCANS score the homography model 40-53 % higher than affine (mean
// pair confidence 1.27 vs 0.83/0.91 under SIFT, 1.45 vs 1.22/1.15 under ORB),
// and affine more than halves the pairs above the connectivity threshold.
//
// ## Why the decision is deliberately asymmetric
//
// Choosing SCANS wrongly is TERMINAL: the ladder is scans-primary, the
// `scans@0.50` rung short-circuits on frame count, and panorama is never tried
// — that is exactly how a 47.7 deg arm sweep shipped at conf=0.500.  Choosing
// PANORAMA wrongly is RECOVERABLE: the ladder's own `scans@1.00 / scans@0.50`
// rungs are still there to catch it.
//
// So affine must win by a MARGIN, not merely win.  With ORB — the finder the
// production stitch uses — the raw rule produced two noise verdicts across 90
// sets (one on a 2-image set with zero strong pairs either way, one on a 0.03
// confidence gap); requiring one extra strong pair removed both without
// changing any confident verdict.

#pragma once

#include <string>
#include <vector>
#include <functional>

namespace rnis {

/// Tunables.  Defaults are the validated values; callers should not need these.
struct StitchModeProbeConfig {
    /// Longest side, px, that features are computed at.  The probe only needs
    /// enough texture to MATCH, not to compose, so this is far below the
    /// registration resolution.  720 mirrors the keyframe gate's own working
    /// size.
    int workingMaxSide = 720;
    /// ORB feature budget per image.  800 matches the manual pipeline's finder
    /// in `stitcher.cpp`, so the probe sees what the stitch will see.
    int orbFeatures = 800;
    /// Matcher confidence, passed to both matchers so neither is advantaged.
    float matchConf = 0.3f;
    /// Pair confidence at/above which a pair counts as "strong".  1.0 is
    /// `cv::Stitcher`'s own `leaveBiggestComponent` threshold.
    double strongPairConf = 1.0;
    /// Extra strong pairs affine must win by before SCANS is chosen.  See the
    /// asymmetry note above; 1 removed every noise verdict in the 90-set sweep.
    int scansStrongPairMargin = 1;
    /// Hard cap on images considered.  Guards the cost and the peak memory on
    /// a pathological capture; the probe samples evenly when exceeded.
    int maxImages = 12;
};

/// Outcome.  `ok == false` means the probe could not form an opinion (too few
/// readable images, or an OpenCV failure) — the caller MUST fall back to the
/// motion resolver rather than treating this as a vote for either mode.
struct StitchModeProbeResult {
    bool ok = false;
    /// True only when affine won by the configured margin.
    bool preferScans = false;
    int imagesUsed = 0;
    int homographyStrongPairs = 0;
    int affineStrongPairs = 0;
    double homographyMeanConf = 0.0;
    double affineMeanConf = 0.0;
    double elapsedMs = 0.0;
    /// Empty when `ok`; otherwise a short slug for the telemetry.
    std::string error;
};

using ProbeLogFn = std::function<void(int level, const char* tag, const char* msg)>;

/// Run the probe over the capture's keyframes.
///
/// Cost is dominated by ORB detection: ~0.11 s mean / 0.26 s worst over 90 real
/// capture sets on a desktop, i.e. a few percent of a 5-11 s stitch.  Images
/// are decoded, downscaled and RELEASED before matching so peak memory stays
/// bounded — this repo has jetsam history and the probe runs immediately before
/// the stitch's own allocation peak.
StitchModeProbeResult probeStitchMode(const std::vector<std::string>& framePaths,
                                      const StitchModeProbeConfig& cfg,
                                      const ProbeLogFn& log);

}  // namespace rnis
