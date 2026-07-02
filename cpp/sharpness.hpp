// SPDX-License-Identifier: Apache-2.0
//
// sharpness.hpp — shared C++ sharpness metric (variance of Laplacian).
//
// Why this exists
// ---------------
// The keyframe gate selects frames purely by overlap / novelty / time —
// it never looks at image QUALITY.  A motion-blurred frame that crosses
// the novelty threshold is saved and stitched, so panoramas show blur
// even on slow pans (one bad frame in the set is enough).  The
// pick-sharpest-in-window selection fixes that: when the gate accepts a
// frame, the engine scores it plus up to K−1 subsequent candidate
// frames and saves the SHARPEST (streaming max — only the best
// candidate is ever buffered).  This header owns the scoring half of
// that feature; the window state machine lives on each platform's
// engine (IncrementalStitcher.swift / IncrementalStitcher.kt).
//
// The metric: variance of the Laplacian
// -------------------------------------
// The Laplacian is the isotropic second derivative — it responds to
// edges and fine texture.  Blur (motion or defocus) is a low-pass
// filter: it attenuates exactly that high-frequency content, so the
// Laplacian response collapses.  Its VARIANCE over the frame is the
// classic single-number focus measure (Pech-Pacheco et al., ICPR 2000):
//   sharp frame   → strong positive+negative Laplacian swings → high
//                   variance
//   blurred frame → Laplacian hugs zero → low variance
// Scores are content-dependent (a blank wall scores ~0 no matter how
// sharp) so they are only COMPARED BETWEEN FRAMES OF THE SAME SCENE
// within one window — never against an absolute threshold.  That makes
// the metric self-calibrating for this use.
//
// Cross-platform parity: iOS (Obj-C++ via OpenCVKeyframeCollector) and
// Android (JNI via sharpness_jni.cpp) both call these functions so the
// two platforms rank candidate frames with bit-identical math.
//
// Threading: stateless free functions — no statics, no globals; safe to
// call concurrently on distinct inputs.

#pragma once

// Forward-declare cv::Mat rather than pulling opencv2 into this header —
// same posture as glare.hpp / keyframe_gate.hpp.  The OpenCV include
// lives only in sharpness.cpp's translation unit.
namespace cv { class Mat; }

namespace retailens {

// Canonical working size for `sharpnessScore`: inputs whose longest
// edge exceeds this are INTER_AREA-downscaled (never upscaled) before
// the Laplacian, which
//   (a) bounds the cost to ~1–3 ms regardless of capture resolution
//       (a 1920×1440 ARKit Y plane becomes 640×480), and
//   (b) makes scores comparable when the same capture pipeline hands
//       us frames at slightly different resolutions.
// 640 sits at the ARCore CPU-image size (640×480), so typical Android
// frames score at native resolution while iOS frames get one cheap
// area-average downscale.
inline constexpr int kSharpnessWorkingLongEdge = 640;

// Variance of the Laplacian of `gray`, computed at the INPUT's
// resolution (no resizing — see `sharpnessScore` for the bounded-cost
// wrapper).
//
// @param gray  8-bit frame.  CV_8UC1 preferred (the Y plane is already
//              gray); CV_8UC3 (BGR) / CV_8UC4 (BGRA) inputs are
//              converted to gray first.  Empty / unsupported → 0.0.
// @return      variance (sigma²) of the CV_64F Laplacian response.
//              ≥ 0; ~0 for constant or featureless frames.  Higher =
//              sharper, for the same scene content.
double varianceOfLaplacian(const cv::Mat& gray);

// Bounded-cost scoring entry point used by both platform engines:
// downscale so the longest edge is `kSharpnessWorkingLongEdge`
// (INTER_AREA, downscale only), then `varianceOfLaplacian`.  For
// inputs already at or below the working size this is EXACTLY
// `varianceOfLaplacian(image)`.
//
// NB — scores from different working scales are not comparable (the
// downscale itself removes high-frequency energy), which is why the
// working edge is a fixed constant and not a parameter.
double sharpnessScore(const cv::Mat& image);

}  // namespace retailens
