// SPDX-License-Identifier: Apache-2.0
//
// sharpness.cpp — OpenCV implementation of the shared sharpness metric.
//
// See sharpness.hpp for the algorithm rationale (variance of Laplacian
// as a focus measure) and the cross-platform-parity contract.  This
// translation unit owns the only OpenCV dependency; the header
// forward-declares cv::Mat so the JNI / Obj-C++ bridges include it
// without dragging opencv2 into their compile.

// OpenCV's headers redefine NO/YES on platforms whose prefix.pch already
// has the ObjC bool macros; undef defensively (no-op off iOS).  Same
// guard as glare.cpp / crop_quad.cpp / keyframe_gate.cpp.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>  // Laplacian, cvtColor, resize

#include <algorithm>  // std::max

#include "sharpness.hpp"

namespace retailens {

double varianceOfLaplacian(const cv::Mat& gray) {
  if (gray.empty()) {
    return 0.0;
  }

  // Normalise to single-channel 8-bit.  The engines hand us the Y
  // plane (already CV_8UC1); colour fallbacks cover the BGRA path of
  // the iOS collector and any host that scores a decoded JPEG.
  cv::Mat g;
  switch (gray.channels()) {
    case 1:
      g = gray;
      break;
    case 3:
      cv::cvtColor(gray, g, cv::COLOR_BGR2GRAY);
      break;
    case 4:
      cv::cvtColor(gray, g, cv::COLOR_BGRA2GRAY);
      break;
    default:
      return 0.0;  // unsupported layout — no signal, no invented score
  }
  if (g.type() != CV_8UC1) {
    g.convertTo(g, CV_8UC1);
  }

  // CV_64F output so negative Laplacian swings survive (an 8-bit
  // destination would clamp them to 0 and halve the signal).
  cv::Mat lap;
  cv::Laplacian(g, lap, CV_64F);

  cv::Scalar mean, stddev;
  cv::meanStdDev(lap, mean, stddev);
  return stddev[0] * stddev[0];  // variance = sigma²
}

double sharpnessScore(const cv::Mat& image) {
  if (image.empty()) {
    return 0.0;
  }
  const int longEdge = std::max(image.rows, image.cols);
  if (longEdge <= kSharpnessWorkingLongEdge) {
    return varianceOfLaplacian(image);  // already at working size
  }
  // INTER_AREA is the correct filter for downsampling (area average —
  // no aliasing that would masquerade as sharpness).
  const double scale =
      static_cast<double>(kSharpnessWorkingLongEdge) / longEdge;
  cv::Mat work;
  cv::resize(image, work, cv::Size(), scale, scale, cv::INTER_AREA);
  return varianceOfLaplacian(work);
}

}  // namespace retailens
