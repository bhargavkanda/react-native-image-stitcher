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

}  // namespace retailens
