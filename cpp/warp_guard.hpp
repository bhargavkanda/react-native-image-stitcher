// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstdint>

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

}  // namespace retailens
