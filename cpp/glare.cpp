// SPDX-License-Identifier: Apache-2.0
//
// glare.cpp — OpenCV implementation of the shared veiling-glare detector.
//
// See glare.hpp for the algorithm rationale, the dark-channel-prior
// derivation, and the calibration numbers.  This translation unit owns
// the only OpenCV dependency; the header forward-declares cv::Mat so the
// JNI / Obj-C++ bridges include it without dragging opencv2 into their
// compile.
//
// The steps map 1:1 onto the Python that calibrated the thresholds:
//   resize longest-edge→512 (INTER_AREA, downscale only)
//   minc = min over colour channels                 (cv::split + cv::min)
//   dark = erode(minc, 15×15 rect)                  (dark-channel prior)
//   score = mean(dark within the product ROI)       (0..255)

// OpenCV's headers redefine NO/YES on platforms whose prefix.pch already
// has the ObjC bool macros; undef defensively (no-op off iOS).  Same
// guard as crop_quad.cpp / keyframe_gate.cpp.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>  // resize, split, min, erode,
                                // getStructuringElement, mean

#include <algorithm>  // std::max
#include <cstdio>     // std::snprintf
#include <string>
#include <vector>

#include "glare.hpp"

namespace retailens {

namespace {

// Central-box product region (working-image pixels) used when the caller
// passes no explicit ROI.  Pulled out so the fallback geometry is shared
// by both platforms verbatim.
cv::Rect centralBox(int w, int h) {
  const int x0 = cvRound(kRoiInsetX * w);
  const int x1 = cvRound((1.0 - kRoiInsetX) * w);
  const int y0 = cvRound(kRoiInsetTop * h);
  const int y1 = cvRound((1.0 - kRoiInsetBottom) * h);
  return cv::Rect(x0, y0, std::max(1, x1 - x0), std::max(1, y1 - y0)) &
         cv::Rect(0, 0, w, h);
}

}  // namespace

double computeGlareScore(const cv::Mat& image, const GlareRoi& roi,
                         std::string* debugOut) {
  if (image.empty()) {
    return 0.0;
  }

  // 1. Downscale (never upscale) so the longest edge is kWorkingLongEdge.
  //    Keeps the fixed-pixel erode window at a consistent physical scale
  //    across capture resolutions.
  const int longEdge = std::max(image.rows, image.cols);
  const double scale =
      (longEdge > kWorkingLongEdge)
          ? static_cast<double>(kWorkingLongEdge) / longEdge
          : 1.0;
  cv::Mat work;
  if (scale < 1.0) {
    cv::resize(image, work, cv::Size(), scale, scale, cv::INTER_AREA);
  } else {
    work = image;  // shallow header copy; read-only below
  }
  const int W = work.cols;
  const int H = work.rows;
  if (W <= 0 || H <= 0) {
    return 0.0;
  }

  // 2. Dark channel = per-pixel min over colour channels, then the local
  //    min over a 15×15 window (an erode).  Colour min is what makes the
  //    cue glare-specific (see header); it is channel-order independent.
  cv::Mat minc;
  const int ch = work.channels();
  if (ch >= 3) {
    std::vector<cv::Mat> planes;
    cv::split(work, planes);
    cv::min(planes[0], planes[1], minc);
    cv::min(minc, planes[2], minc);  // min(B,G,R); alpha (planes[3]) ignored
  } else if (ch == 1) {
    minc = work;  // grayscale fallback — degraded margin (see header)
  } else {
    // Unusual 2-channel input: fall back to the first channel.
    std::vector<cv::Mat> planes;
    cv::split(work, planes);
    minc = planes[0];
  }
  if (minc.type() != CV_8UC1) {
    minc.convertTo(minc, CV_8UC1);
  }

  cv::Mat dark;
  const cv::Mat kernel = cv::getStructuringElement(
      cv::MORPH_RECT, cv::Size(kDarkErodeKernel, kDarkErodeKernel));
  cv::erode(minc, dark, kernel);

  // 3. Resolve the product region: an explicit ROI (scaled from original
  //    to working pixels and clamped), else the central-box fallback.
  cv::Rect region;
  if (roi.width > 0 && roi.height > 0) {
    region = cv::Rect(cvRound(roi.x * scale), cvRound(roi.y * scale),
                      cvRound(roi.width * scale), cvRound(roi.height * scale)) &
             cv::Rect(0, 0, W, H);
  }
  if (region.width <= 0 || region.height <= 0) {
    region = centralBox(W, H);  // no/invalid ROI → central box
  }
  if (region.width <= 0 || region.height <= 0) {
    return 0.0;
  }

  // 4. Mean dark-channel over the region = the glare score (0..255).
  const double meanDark = cv::mean(dark(region))[0];

  if (debugOut != nullptr) {
    char buf[160];
    std::snprintf(buf, sizeof(buf),
                  "glare meanDark=%.2f roi=%dx%d@%d,%d work=%dx%d", meanDark,
                  region.width, region.height, region.x, region.y, W, H);
    debugOut->append(buf);
  }
  return meanDark;
}

}  // namespace retailens
