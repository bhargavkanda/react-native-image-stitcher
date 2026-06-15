// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstdint>
#include <cmath>

// ─────────────────────────────────────────────────────────────────────
// Warp-canvas size guard — shared by the warp pre-pass (which decides
// whether to fall back from a diverging plane projection to the bounded
// cylindrical one) and the in-loop final safety net in stitcher.cpp.
//
// Header-only + OpenCV-free on purpose: the predicate below is the one
// piece of warp-guard logic worth unit-testing in isolation (the int64
// overflow handling in particular), and the cpp test suite is NOT
// OpenCV-aware.  Keep this file free of any cv:: dependency.
// ─────────────────────────────────────────────────────────────────────

namespace retailens {

// A single warped frame requiring more than this many pixels of
// intermediate storage is from a broken estimator (degenerate camera
// params), not a real capture: at 3-4 bytes/px that's 300-400 MB for ONE
// frame, and blending several would jetsam-OOM the app.  100 megapixels.
constexpr int64_t kMaxWarpPixels = 100LL * 1000LL * 1000LL;

// Max size of the CUMULATIVE blend canvas — the bounding box over every
// positioned warp rect (corner + size) that `cv::detail::Blender::prepare`
// allocates as its CV_16SC3 accumulator (~6 bytes/px) plus a CV_8U mask
// and, for MultiBand, Laplacian-pyramid overhead (~1.5-2× on top).  This
// is a DIFFERENT axis from kMaxWarpPixels: a degenerate homography can
// shift ONE frame's corner to a huge offset so the union spans gigapixels
// while every individual frame's extent still passes the per-frame guard.
// Guarding the union before prepare() is what actually stops crash B (the
// 51 MB → 3.7 GB single-pan blow-up).
//
// 50 MP sizing: a valid 360° cylindrical canvas is ~9 MP (2π·~1200 px
// focal × ~1200 px tall) and real field-log panoramas are ~1.3 MP, so
// 50 MP is ~5× headroom over the widest legitimate pano (zero false
// positives) while 50 MP × (6 + 1) bytes + pyramid overhead ≈ 500-600 MB
// peak — comfortably under the 6 GB-class pre-stitch headroom.
constexpr int64_t kMaxCanvasPixels = 50LL * 1000LL * 1000LL;

// True if a warp ROI of `width`×`height` px is degenerate: non-positive
// in either dimension, or strictly larger than `maxPixels` (so a canvas
// exactly at the limit is still allowed).
//
// Computes the area in int64 so a wildly degenerate ROI (e.g.
// 65536×65536 = 2^32, whose int32 area wraps to 0) is still caught
// instead of silently slipping past the guard.
inline bool warpRoiExceedsGuard(int width, int height,
                                int64_t maxPixels = kMaxWarpPixels) {
  if (width <= 0 || height <= 0) {
    return true;
  }
  const int64_t pixels =
      static_cast<int64_t>(width) * static_cast<int64_t>(height);
  return pixels > maxPixels;
}

// True if the cumulative blend-canvas of `width`×`height` px is degenerate:
// non-positive in either dimension, or strictly larger than `maxPixels`
// (so a canvas exactly at the limit is still allowed).  Same int64 area
// math as warpRoiExceedsGuard — the union of a degenerate corner offset is
// exactly the case where int32 area would overflow.  Takes int64 dims
// because the union is computed in int64 (a degenerate corner can exceed
// the int32 range on its own).
inline bool canvasExceedsGuard(int64_t width, int64_t height,
                               int64_t maxPixels = kMaxCanvasPixels) {
  if (width <= 0 || height <= 0) {
    return true;
  }
  // width/height are already bounded by the caller's union math, but cap
  // the multiply defensively: if either exceeds ~3 G the product overflows
  // int64, and such a dimension is degenerate by any measure.
  if (width > 3'000'000'000LL || height > 3'000'000'000LL) {
    return true;
  }
  return width * height > maxPixels;
}

// ─────────────────────────────────────────────────────────────────────
// RAM-aware output-canvas budget (the wide-pan blend-OOM fix).
//
// Distinct from the guards above: a VALID but wide pan produces a large
// union canvas, and the BATCH + MultiBand blend peak scales with it (on a
// 6 GB device a ~70 MP union hit ~2.97 GB RSS and was lmkd-killed mid-
// blend).  Rather than REJECT a valid capture, we cap the canvas to a
// memory budget by reducing compose scale — yielding a slightly-lower-res
// but COMPLETE panorama.  The two functions below are the OpenCV-free,
// unit-testable core of that cap (the warp/resize itself lives in
// stitcher.cpp and is on-device-only).
//
// kBlendBytesPerUnionPx was back-solved from the on-device capture-14
// failure: (2970 MB peak − ~330 MB baseline) / 70.7 MP ≈ 37.4 B per union
// pixel.  Round up to 38 for headroom.  kBudgetCeilMP (42) keeps a 6 GB
// device's predicted peak (~1.9 GB) under its lmkd death point while
// staying ≤ kMaxCanvasPixels (50 MP) so the degenerate-canvas guard above
// never fires on a cap-eligible pan.  kBudgetFloorMP (12) is > the widest
// VALID 360° panorama (~9 MP), so a normal pano is provably never capped.
constexpr double kBlendBytesPerUnionPx = 38.0;
constexpr double kBlendRamFraction     = 0.30;
constexpr double kBudgetFloorMP        = 12.0;
constexpr double kBudgetCeilMP         = 42.0;

// Output-canvas megapixel budget for a device with `totalRamMB` of RAM.
// Monotonic-nondecreasing in RAM, clamped to [floor, ceil].  A non-
// positive/sentinel RAM falls to the floor (the caller should resolve a
// -1 sentinel to an assumed RAM before calling, but never get a <=0
// budget regardless).
inline double composeCanvasBudgetMP(double totalRamMB) {
  const double raw = (totalRamMB * kBlendRamFraction) / kBlendBytesPerUnionPx;
  if (raw < kBudgetFloorMP) return kBudgetFloorMP;
  if (raw > kBudgetCeilMP)  return kBudgetCeilMP;
  return raw;
}

// Linear downscale factor that brings a `canvasMP`-megapixel canvas down to
// `budgetMP`.  Canvas area scales with factor², so factor = sqrt(budget /
// canvas), clamped to [0.2, 1.0]: never UPSCALES (≤ 1.0 — a canvas already
// within budget returns 1.0, a no-op), and never collapses below 0.2 (a
// canvas still over budget after 0.2× is degenerate, which the separate
// canvasExceedsGuard net catches on its own axis).  Returns 1.0 when either
// input is non-positive (no div-by-zero; matches a "nothing to cap" no-op).
inline double canvasDownscaleForBudget(double canvasMP, double budgetMP) {
  if (canvasMP <= 0.0 || budgetMP <= 0.0 || canvasMP <= budgetMP) {
    return 1.0;
  }
  double factor = std::sqrt(budgetMP / canvasMP);
  if (factor < 0.2) factor = 0.2;
  if (factor > 1.0) factor = 1.0;
  return factor;
}

// Seam-finder downscale aspect, re-capped against the WARPED image size.
//
// The GraphCut seam finder must run at ~`seamMp` megapixels per image (what
// cv::Stitcher's seam_est_resol targets) or its per-pixel max-flow graph
// blows up — a wide-pan capture whose warped images spanned a 19 MP canvas
// OOM-killed the app because the seam images were multi-MP, not 0.1 MP.
//
// The caller's `inputAspect` is derived from the INPUT frame size, but the
// resize it feeds is applied to the WARPED images, which can be many× larger
// (the warp expands a ~0.3 MP frame across the whole canvas).  So re-cap the
// aspect so the LARGEST warped frame (`maxWarpedMp`) downscales to ≤ seamMp.
// Never RAISES the aspect (only tightens it); a no-op when the warped images
// are already ≤ seamMp or the inputs are degenerate.
inline double cappedSeamAspect(double inputAspect, double maxWarpedMp,
                               double seamMp) {
  if (seamMp <= 0.0 || maxWarpedMp <= seamMp) {
    return inputAspect;
  }
  const double capped = std::sqrt(seamMp / maxWarpedMp);
  return (capped < inputAspect) ? capped : inputAspect;
}

// ─────────────────────────────────────────────────────────────────────
// Issue 3 — post-stitch disjointness check (pure).
//
// The confidence filter drops frames that don't register, but nothing
// validated the OUTPUT: a frame that survived confidence yet landed
// geometrically disconnected shows up as a separate blob in the coverage
// mask ("disjointed image frames in the output").  Given the largest
// connected component's area, the total covered area, and the frame count,
// decide whether a MEANINGFUL fraction of coverage lies OUTSIDE the main
// blob — i.e. the frames didn't fuse into one panorama.  Pure so the
// threshold is unit-testable; the OpenCV connected-components extraction
// (which feeds these areas) lives in stitcher.cpp's validateStitchOutput.
//
// Conservative by design: a normal panorama is ONE connected blob
// (fragmentFraction ≈ 0), so the 0.15 default never trips on it; a whole
// disconnected frame in a few-frame pan easily exceeds 15 % of coverage.
constexpr double kMaxStitchFragmentFraction = 0.15;

inline bool stitchOutputIsDisjoint(
    double largestComponentArea, double totalCoveredArea, int numFrames,
    double maxFragmentFraction = kMaxStitchFragmentFraction) {
  if (numFrames < 2) return false;
  if (totalCoveredArea <= 0.0 || largestComponentArea <= 0.0) return false;
  const double fragmentFraction =
      1.0 - (largestComponentArea / totalCoveredArea);
  return fragmentFraction > maxFragmentFraction;
}

// Coverage-to-canvas UTILIZATION guard — the "black canvas" failure.  When
// BundleAdjusterRay mis-places a weak boundary frame, PlaneWarper throws it
// far off-axis so the union canvas balloons and the real content clusters in
// one corner.  That is a single coherent blob, so `stitchOutputIsDisjoint`
// (fragmentFraction ≈ 0) PASSES it — yet it's garbage.  Guard the ratio of
// covered pixels to total panorama pixels instead.  A valid pano (cropped to
// its coverage downstream) fills well above this; a marooned-corner canvas is
// only a percent or two.  The 50 MP `canvasExceedsGuard` catches gigapixel
// blowups; this catches the moderate 12–50 MP band it leaves open.
constexpr double kMinStitchUtilization = 0.10;

inline bool stitchOutputUnderutilized(
    double totalCoveredArea, double canvasArea, int numFrames,
    double minUtilization = kMinStitchUtilization) {
  if (numFrames < 2) return false;
  if (canvasArea <= 0.0 || totalCoveredArea <= 0.0) return false;
  return (totalCoveredArea / canvasArea) < minUtilization;
}

// ─────────────────────────────────────────────────────────────────────
// Issue 6 — headroom-based memory gating (pure).
//
// We CANNOT measure the stitch's own allocation apart from the shared
// process RSS (OpenCV uses malloc; there's no per-library accounting).  So
// rather than a flat device-scaled RSS ceiling — which a memory-heavy HOST
// app trips even when the stitch itself is small — we reason about HEADROOM:
// estimate the per-process kill ceiling and gate on whether the stitch's
// INCREMENTAL demand fits on top of the CURRENT process footprint.

// Estimated per-process memory ceiling (MB) before the OS (iOS jetsam /
// Android lmkd) kills the app, as a fraction of total device RAM.  Anchored
// to the iPhone 16 Pro (8 GB) observed jetsam at ~3.38 GB ⇒ ~0.42.  Floored
// so tiny (2 GB) devices still get a sane budget.
constexpr double kProcessLimitFraction = 0.42;
constexpr double kProcessBudgetFloorMB = 900.0;

inline double perProcessMemoryBudgetMB(double totalRamMB) {
  const double raw = totalRamMB * kProcessLimitFraction;
  return (raw < kProcessBudgetFloorMB) ? kProcessBudgetFloorMB : raw;
}

// Smallest streaming-stitch peak we insist on having room for (one warped
// frame + the CV_16SC3 accumulator + masks at compose resolution).
// Conservative.
constexpr double kMinStreamStitchMB = 350.0;

// Early pre-stitch gate: abort BEFORE loading frames ONLY when the process
// is already so close to its ceiling that even a minimal streaming stitch
// won't fit on top of the current footprint.  A true last resort — scoped to
// the stitch's MINIMAL incremental demand, not a flat device ceiling — so a
// heavy host app with headroom remaining still proceeds.
inline bool stitchExceedsMinimalHeadroom(double currentRssMB,
                                         double totalRamMB) {
  return currentRssMB + kMinStreamStitchMB
         > perProcessMemoryBudgetMB(totalRamMB);
}

// Comfortable free headroom (MB) below which we prefer the STREAM+feather
// path over BATCH (graphcut+multiband), whose blend peak can spike far above
// STREAM's.  Used as an ADDITIONAL routing trigger alongside the fixed
// canvas/held-set MP thresholds — it only ever makes routing MORE
// conservative (more likely STREAM), never less, so it can't cause an OOM
// that the fixed thresholds would have avoided.
constexpr double kBatchHeadroomMB = 1000.0;

inline bool lowBatchHeadroom(double currentRssMB, double totalRamMB) {
  return (perProcessMemoryBudgetMB(totalRamMB) - currentRssMB)
         < kBatchHeadroomMB;
}

}  // namespace retailens
