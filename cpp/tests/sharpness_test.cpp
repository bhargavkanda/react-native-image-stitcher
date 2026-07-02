// SPDX-License-Identifier: Apache-2.0
//
// sharpness_test.cpp — GoogleTest coverage for the shared sharpness
// metric (cpp/sharpness.{hpp,cpp}) behind the pick-sharpest-in-window
// anti-blur keyframe selection.
//
// Unlike the other suites in this harness, the subject depends on
// OpenCV (cv::Laplacian / cv::meanStdDev / cv::resize), so this file
// is only compiled when the tests' CMake config found an OpenCV
// install — see cpp/tests/CMakeLists.txt (find_package(OpenCV QUIET))
// and cpp/tests/README.md for how to provide one locally.
//
// What the metric must guarantee (the contract the window selector
// relies on):
//   1. A sharp frame scores STRICTLY higher than a motion/gaussian
//      blurred copy of the same content — this is the whole basis of
//      "pick the sharpest frame in the window".
//   2. A featureless frame (constant) scores ~0 — blur cannot be
//      detected without texture, and the score must not invent
//      signal from nothing.
//   3. Deterministic, resolution-bounded cost: sharpnessScore()
//      downscales to kSharpnessWorkingLongEdge before scoring, and
//      is exactly varianceOfLaplacian() for already-small inputs.

#include <gtest/gtest.h>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include "sharpness.hpp"

namespace {

// 8-bit gray checkerboard — dense strong edges, high Laplacian
// variance.  Deterministic (no RNG).
cv::Mat makeCheckerboard(int rows, int cols, int cell) {
  cv::Mat img(rows, cols, CV_8UC1);
  for (int y = 0; y < rows; ++y) {
    for (int x = 0; x < cols; ++x) {
      img.at<uint8_t>(y, x) =
          (((y / cell) + (x / cell)) % 2 == 0) ? 230 : 25;
    }
  }
  return img;
}

// Deterministic pseudo-random texture (fixed-seed cv::RNG) — models a
// natural high-frequency scene better than the checkerboard's pure
// square wave.
cv::Mat makeNoise(int rows, int cols) {
  cv::Mat img(rows, cols, CV_8UC1);
  cv::RNG rng(0x5EED);  // fixed seed → identical image on every run
  rng.fill(img, cv::RNG::UNIFORM, 0, 256);
  return img;
}

cv::Mat blurred(const cv::Mat& src) {
  cv::Mat out;
  cv::GaussianBlur(src, out, cv::Size(9, 9), 2.0);
  return out;
}

}  // namespace

// ── varianceOfLaplacian: core metric ─────────────────────────────────

TEST(SharpnessTest, ConstantImageScoresNearZero) {
  cv::Mat flat(480, 640, CV_8UC1, cv::Scalar(128));
  EXPECT_NEAR(retailens::varianceOfLaplacian(flat), 0.0, 1e-9);
}

TEST(SharpnessTest, EmptyMatScoresZero) {
  EXPECT_EQ(retailens::varianceOfLaplacian(cv::Mat()), 0.0);
  EXPECT_EQ(retailens::sharpnessScore(cv::Mat()), 0.0);
}

TEST(SharpnessTest, CheckerboardSharperThanItsBlurredCopy) {
  const cv::Mat sharp = makeCheckerboard(480, 640, 8);
  const double sharpScore = retailens::varianceOfLaplacian(sharp);
  const double blurScore = retailens::varianceOfLaplacian(blurred(sharp));
  EXPECT_GT(sharpScore, 0.0);
  // Strictly greater is the contract; in practice the gap is huge
  // (square-wave edges lose most of their second derivative under a
  // sigma-2 Gaussian).  Assert a comfortable margin so a subtle
  // regression (e.g. scoring the wrong buffer) can't slip through as
  // a hairline difference.
  EXPECT_GT(sharpScore, 2.0 * blurScore);
}

TEST(SharpnessTest, NoiseTextureSharperThanItsBlurredCopy) {
  const cv::Mat sharp = makeNoise(480, 640);
  const double sharpScore = retailens::varianceOfLaplacian(sharp);
  const double blurScore = retailens::varianceOfLaplacian(blurred(sharp));
  EXPECT_GT(sharpScore, 0.0);
  EXPECT_GT(sharpScore, 2.0 * blurScore);
}

TEST(SharpnessTest, MonotoneUnderIncreasingBlur) {
  // More blur → strictly lower score.  This is what makes the
  // streaming-max window pick the LEAST blurred frame, not merely
  // "a different" frame.
  const cv::Mat sharp = makeCheckerboard(480, 640, 8);
  cv::Mat blur1, blur2;
  cv::GaussianBlur(sharp, blur1, cv::Size(5, 5), 1.0);
  cv::GaussianBlur(sharp, blur2, cv::Size(13, 13), 3.0);
  const double s0 = retailens::varianceOfLaplacian(sharp);
  const double s1 = retailens::varianceOfLaplacian(blur1);
  const double s2 = retailens::varianceOfLaplacian(blur2);
  EXPECT_GT(s0, s1);
  EXPECT_GT(s1, s2);
}

TEST(SharpnessTest, ColorInputIsConvertedToGray) {
  // A BGR image whose three channels are identical must score the
  // same as its gray original (BT.601 weights sum to 1, so the
  // conversion is the identity on (v,v,v) up to rounding).
  const cv::Mat gray = makeCheckerboard(240, 320, 8);
  cv::Mat bgr;
  cv::merge(std::vector<cv::Mat>{gray, gray, gray}, bgr);
  const double grayScore = retailens::varianceOfLaplacian(gray);
  const double bgrScore = retailens::varianceOfLaplacian(bgr);
  EXPECT_GT(bgrScore, 0.0);
  EXPECT_NEAR(bgrScore, grayScore, grayScore * 0.05);
}

// ── sharpnessScore: downscale wrapper ────────────────────────────────

TEST(SharpnessTest, SmallInputIsNotResized) {
  // Long edge already ≤ kSharpnessWorkingLongEdge → the wrapper must
  // be EXACTLY the raw metric (no resample, no drift).
  const cv::Mat img =
      makeCheckerboard(360, retailens::kSharpnessWorkingLongEdge, 8);
  EXPECT_EQ(retailens::sharpnessScore(img),
            retailens::varianceOfLaplacian(img));
}

TEST(SharpnessTest, LargeInputIsScoredAtWorkingScale) {
  // A frame larger than the working edge must be scored on the
  // downscaled copy — i.e. the wrapper's result equals scoring a
  // manually INTER_AREA-downscaled image, not the full-res one.
  const cv::Mat big = makeNoise(1440, 1920);
  const double scale =
      static_cast<double>(retailens::kSharpnessWorkingLongEdge) / 1920.0;
  cv::Mat manual;
  cv::resize(big, manual, cv::Size(), scale, scale, cv::INTER_AREA);
  EXPECT_DOUBLE_EQ(retailens::sharpnessScore(big),
                   retailens::varianceOfLaplacian(manual));
}

TEST(SharpnessTest, LargeSharpBeatsLargeBlurredThroughTheWrapper) {
  // End-to-end contract at ARKit-native resolution (1920×1440 Y
  // plane): the wrapper must still rank sharp above blurred after
  // its own downscale.
  const cv::Mat sharp = makeCheckerboard(1440, 1920, 16);
  EXPECT_GT(retailens::sharpnessScore(sharp),
            retailens::sharpnessScore(blurred(sharp)));
}
