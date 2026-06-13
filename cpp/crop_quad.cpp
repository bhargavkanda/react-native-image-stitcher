// SPDX-License-Identifier: Apache-2.0
//
// crop_quad.cpp — OpenCV implementation of the free-quad perspective
// crop (`cropToQuad`), the only net-new native code for item-7 of the
// first-time-user guidance flow.
//
// Pairs with the EXISTING axis-aligned crop (cropToRectAtPath on iOS /
// cropToRect on Android).  Where that crop slices a sub-rectangle out of
// the panorama, this one takes 4 user-dragged corners (a skewed
// quadrilateral) and perspective-rectifies them into an upright rectangle
// — the editor in src/camera/RectCropPreview.tsx picks `cropToQuad` over
// `cropToRect` whenever the dragged quad isn't ~axis-aligned.
//
// Why a separate .cpp (not folded into stitcher.cpp): the geometry core
// (quadDstRect / isQuadAcceptable) is the OpenCV-FREE, unit-tested
// cpp/crop_quad.hpp; this file is JUST the thin cv:: warp around it, kept
// out of stitcher.cpp's translation unit so the test suite can link the
// header without pulling in the whole stitch pipeline.
//
// Both platform bridges (iOS OpenCVStitcher.mm, Android BatchStitcher.kt)
// duplicate this warp in their own native language today — see the
// integrator notes in the item-7 handoff — so this file is the shared
// C++ reference + the home of the canvasExceedsGuard wiring.  Wire it
// into a translation unit (the pod / the JNI lib) when the native crop is
// routed through shared C++ rather than per-platform OpenCV bindings.

// OpenCV's headers redefine NO/YES on platforms whose prefix.pch already
// has the ObjC bool macros; undef defensively (no-op off iOS).
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#include <opencv2/opencv.hpp>
#include <opencv2/imgproc.hpp>

#include <string>
#include <vector>

#include "crop_quad.hpp"
#include "warp_guard.hpp"

namespace retailens {

// Result of a cropToQuad call.  `ok == false` carries a human-readable
// `error` (the bridge maps it to NSError / Promise.reject); on success
// `width`/`height` are the written output dimensions.
struct CropQuadResult {
  bool ok = false;
  std::string error;
  int width = 0;
  int height = 0;
};

// Perspective-rectify the quad `q` (4 ORDERED [TL, TR, BR, BL] image-pixel
// corners) out of the image at `inPath` into an upright w×h rectangle,
// written to `outPath` as a JPEG at `quality` (clamped to [1, 100]).
//
// Guards, in order (each is a hard reject — NO partial output is written):
//   1. inPath decodes (cv::imread non-empty).
//   2. isQuadAcceptable — convex + min-area + within the decoded image
//      bounds.  A degenerate / non-convex / out-of-bounds quad is rejected
//      here, before any allocation.
//   3. quadDstRect yields a positive w×h.
//   4. canvasExceedsGuard(w, h) — the SAME blend-canvas guard the stitch
//      pipeline uses.  A near-collinear quad whose averaged opposite-edge
//      lengths still multiply to a multi-gigapixel output (e.g. a 1 px ×
//      40000 px sliver dragged across a wide pano) can't OOM the device:
//      the output Mat is never allocated when this fires.
//
// The warp itself is cv::getPerspectiveTransform(src → axis-aligned dst)
// + cv::warpPerspective to a w×h canvas.  `outPath == inPath` is allowed
// (overwrite in place), matching cropToRect's contract.
CropQuadResult cropQuadToFile(const std::string& inPath,
                              const std::string& outPath,
                              const CropQuad& q,
                              int quality) {
  CropQuadResult result;

  cv::Mat img = cv::imread(inPath, cv::IMREAD_COLOR);
  if (img.empty()) {
    result.error = "Could not decode image at " + inPath;
    return result;
  }

  // Guard 2 — geometry: convex, non-degenerate, inside the decoded image.
  if (!isQuadAcceptable(q, static_cast<double>(img.cols),
                        static_cast<double>(img.rows))) {
    result.error =
        "Crop quad is degenerate (non-convex, zero-area, or out of bounds)";
    return result;
  }

  // Guard 3 — positive destination size.
  const QuadDstSize dst = quadDstRect(q);
  if (dst.width <= 0 || dst.height <= 0) {
    result.error = "Crop quad rectifies to a non-positive rectangle";
    return result;
  }

  // Guard 4 — output-canvas OOM net (shared with the stitch pipeline).
  if (canvasExceedsGuard(dst.width, dst.height)) {
    result.error = "Crop quad output canvas exceeds the size guard (" +
                   std::to_string(dst.width) + "x" +
                   std::to_string(dst.height) + ")";
    return result;
  }

  const cv::Point2f src[4] = {
      cv::Point2f(static_cast<float>(q.tl.x), static_cast<float>(q.tl.y)),
      cv::Point2f(static_cast<float>(q.tr.x), static_cast<float>(q.tr.y)),
      cv::Point2f(static_cast<float>(q.br.x), static_cast<float>(q.br.y)),
      cv::Point2f(static_cast<float>(q.bl.x), static_cast<float>(q.bl.y)),
  };
  const cv::Point2f dstPts[4] = {
      cv::Point2f(0.0f, 0.0f),
      cv::Point2f(static_cast<float>(dst.width), 0.0f),
      cv::Point2f(static_cast<float>(dst.width),
                  static_cast<float>(dst.height)),
      cv::Point2f(0.0f, static_cast<float>(dst.height)),
  };

  cv::Mat warped;
  try {
    const cv::Mat transform = cv::getPerspectiveTransform(src, dstPts);
    cv::warpPerspective(img, warped, transform,
                        cv::Size(dst.width, dst.height),
                        cv::INTER_LINEAR);
  } catch (const cv::Exception& e) {
    result.error = std::string("Perspective warp failed: ") + e.what();
    return result;
  }
  if (warped.empty()) {
    result.error = "Perspective warp produced an empty image";
    return result;
  }

  int q255 = quality;
  if (q255 < 1) q255 = 1;
  if (q255 > 100) q255 = 100;
  const std::vector<int> writeParams = {cv::IMWRITE_JPEG_QUALITY, q255};
  bool wrote = false;
  try {
    wrote = cv::imwrite(outPath, warped, writeParams);
  } catch (const cv::Exception& e) {
    result.error = std::string("Could not write cropped image: ") + e.what();
    return result;
  }
  if (!wrote) {
    result.error = "Could not write cropped image to " + outPath;
    return result;
  }

  result.ok = true;
  result.width = warped.cols;
  result.height = warped.rows;
  return result;
}

}  // namespace retailens
