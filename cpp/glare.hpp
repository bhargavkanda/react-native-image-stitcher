// SPDX-License-Identifier: Apache-2.0
//
// glare.hpp — shared C++ glare detector (specular-veiling reflection).
//
// What "glare" means here
// -----------------------
// In retail-shelf / cooler photography the dominant glare is NOT a
// blown-out specular hot-spot — it is a *veiling reflection*: the glass
// door reflects the bright outdoor scene (sky, trees, the photographer)
// as a translucent, MID-TONE layer over the products behind it.  That
// veil sits around luma 130–210 and never reaches a 230–255 "clipped
// white" gate, so the classic bright-blob / specular detectors both MISS
// it (the veil is too dark to threshold) and FALSE-FIRE on genuinely
// bright but harmless backgrounds (sunlit umbrella, sky, pavement).
//
// The signal that actually works: dark-channel floor-lift
// -------------------------------------------------------
// A translucent veil cannot leave dark pixels behind — it adds light
// everywhere it covers, so the local "darkest pixel" floor gets LIFTED.
// Clean products (open rack, or a clear glass cooler) keep deep shadow
// gaps between items, so their dark floor stays low.  This is the
// dark-channel prior from the dehazing literature, applied as a glare
// cue:
//
//   darkChannel(p) = min over a 15×15 window of ( min over B,G,R at p )
//
//   - The inner min-over-COLOR-channels is what makes it glare-specific:
//     a saturated product (e.g. a red packet) is dark in its non-dominant
//     channels, so its channel-min is low → it does NOT inflate the
//     score.  Only NEUTRAL light (a reflected sky/scene) is bright in all
//     three channels → high channel-min → high dark-channel.  (Min over
//     channels is channel-ORDER independent, so BGR vs RGB doesn't
//     matter.)
//   - The outer min-over-window (an erode) requires the lifted floor to
//     be CONTIGUOUS — a single white bottle among dark gaps doesn't lift
//     it, only an actual veil does.  This is why dark-channel was chosen
//     over a simpler "fraction of bright pixels", which fires on any
//     cooler full of white products.
//
// glareScore = mean(darkChannel) over the product region, on a 0..255
// scale.  Higher = more veiling glare.
//
// Calibration (6 field frames, 2 glary coolers / 4 clean racks; the only
// data on hand — treat the threshold as PROVISIONAL until field data via
// the QualityChecker calibration log firms it up):
//
//        glary (positive):  meanDark = 38.0, 46.5
//        clean (negative):  meanDark = 18.9, 24.6, 26.0, 28.1
//        → separating midpoint ≈ 33  (gap 28.1 → 38.0)
//
// NB — the ABSOLUTE scale (hence the ≈33 cutoff) is coupled to three
// constants: kWorkingLongEdge (512), the INTER_AREA downscale in
// glare.cpp, and kDarkErodeKernel (15).  INTER_AREA area-averages the
// ~8× downscale, lifting the dark floor versus a sparse INTER_LINEAR
// sample — the SAME frames score ~25% lower under LINEAR (midpoint ≈ 25
// instead of ≈ 33).  Change any of the three and maxGlare must be
// re-calibrated; the SEPARATION itself (gap ≈ 10, all 6 frames correct)
// is invariant to the choice.
//
// The 0..255 score is returned here; the pass/fail decision (the
// `maxGlare` threshold, ≈ 33) lives on the JS side in scoreToReport so
// there is a single source of truth for the cutoff.
//
// Resolution independence: the input is first downscaled so its longest
// edge is `kWorkingLongEdge` (512) before the 15×15 erode, so the score
// does not drift with capture resolution (a fixed-pixel window means a
// different physical scale on a 12 MP vs a 2 MP frame).  This mirrors the
// downscale the blur/Laplacian path already relies on.
//
// Threading: stateless free function — no statics, no globals; safe to
// call concurrently on distinct inputs.

#pragma once

#include <string>

// Forward-declare cv::Mat rather than pulling opencv2 into this header —
// same posture as keyframe_gate.hpp / crop_quad.hpp.  The OpenCV include
// lives only in glare.cpp's translation unit; the JNI / Obj-C++ bridges
// that include this header construct their own cv::Mat and pass it in.
namespace cv { class Mat; }

namespace retailens {

// ── Tunable constants (calibration knobs) ─────────────────────────────

// Canonical working size: the input is downscaled (never upscaled) so its
// LONGEST edge is this many pixels before the dark-channel erode, making
// the score resolution-independent.  The 6-frame calibration above was
// measured at this size.
inline constexpr int kWorkingLongEdge = 512;

// Dark-channel window: side length (px, at the working size) of the
// square erode that takes the local min.  15 ≈ 3% of a 512px edge — large
// enough that a lone bright product can't lift the floor, small enough to
// localise the veil.
inline constexpr int kDarkErodeKernel = 15;

// Central-box product-region fallback, used when the caller does not pass
// an explicit ROI (see GlareRoi).  Insets as fractions of the working
// frame: horizontally [6%, 94%], vertically [18%, 92%].  The generous TOP
// inset (18%) drops the sky / sunlit-awning band that otherwise dominates
// outdoor shelf shots; the bottom inset (8%) drops the foreground floor.
inline constexpr double kRoiInsetX      = 0.06;  // left & right
inline constexpr double kRoiInsetTop    = 0.18;
inline constexpr double kRoiInsetBottom = 0.08;

// Region of interest in ORIGINAL-image pixels (pre-downscale).  In the
// SDK pipeline this is where the detected shelf / cooler region plugs in,
// so glare is measured only over the products — not the surroundings.
// A non-positive `width`/`height` (the default) selects the central-box
// fallback above.  The rect is scaled to the working image and clamped to
// its bounds internally.
struct GlareRoi {
  int x = 0;
  int y = 0;
  int width = 0;   // <= 0 → central-box fallback
  int height = 0;  // <= 0 → central-box fallback
};

// Compute the veiling-glare score for `image` over `roi`.
//
// @param image     BGR (CV_8UC3), BGRA (CV_8UC4 — alpha ignored), or
//                  grayscale (CV_8UC1) 8-bit frame.  COLOR is strongly
//                  preferred: on grayscale the channel-min degrades to the
//                  luma itself, which still separates but with a narrower
//                  margin (gray gap 5.6 vs colour gap 10 on the calib
//                  set).  An empty / unsupported Mat returns 0.0.
// @param roi       product region in original-image pixels; default
//                  GlareRoi{} → central-box fallback.
// @param debugOut  optional, nullable.  When non-null, one calibration
//                  line is appended:
//                  "glare meanDark=.. roi=WxH@x,y work=WxH".  Lets the
//                  caller log per-capture numbers while tuning `maxGlare`.
//                  Pass nullptr in production.
//
// @return mean dark-channel over the region, 0..255.  Higher = more
//         veiling glare; 0.0 for an unusable input.
double computeGlareScore(const cv::Mat& image,
                         const GlareRoi& roi = GlareRoi{},
                         std::string* debugOut = nullptr);

}  // namespace retailens
