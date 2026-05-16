// SPDX-License-Identifier: UNLICENSED
//
// stitcher.cpp — shared cv::Stitcher orchestration.  See stitcher.hpp
// for design rationale.
//
// V1 (2026-05-15): ported from retailens_stitcher.cpp (Android JNI
// shim) verbatim with the platform-specific Obj-C / JNI marshalling
// stripped.  Both platforms now call this through thin bridges.
//
// V2 (planned): port iOS's manual cv::detail::* pipeline features
// (explicit leaveBiggestComponent at a SEPARATE retry granularity,
// wave correction, exposure compensator) so iOS doesn't regress
// from where OpenCVStitcher.mm had it.  Selectable via a future
// StitchConfig::useManualPipeline flag.

#include "stitcher.hpp"

#include <opencv2/core.hpp>
#include <opencv2/features2d.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/stitching.hpp>
#include <opencv2/stitching/detail/blenders.hpp>
#include <opencv2/stitching/detail/camera.hpp>
#include <opencv2/stitching/detail/matchers.hpp>
#include <opencv2/stitching/detail/motion_estimators.hpp>
#include <opencv2/stitching/detail/seam_finders.hpp>
#include <opencv2/stitching/detail/warpers.hpp>
#include <opencv2/stitching/warpers.hpp>

#include <algorithm>
#include <chrono>
#include <cfloat>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <vector>


namespace retailens {

namespace {

// Lightweight logging helper.  When logFn is null, the message is
// dropped (no allocation past the snprintf temp buffer).
void log_info(const LogFn& logFn, const char* tag, const char* fmt, ...) {
    if (!logFn) return;
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    logFn(0, tag, buf);
}

void log_error(const LogFn& logFn, const char* tag, const char* fmt, ...) {
    if (!logFn) return;
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    logFn(2, tag, buf);
}

// Read /proc/self/statm to get RSS in MB.  Cheap (~20 µs).  Used at
// pipeline phase boundaries to correlate logged peak memory with the
// staging-resolution + retry decisions.  Returns -1 on read failure
// (e.g., procfs not mounted — never happens on iOS/Android but we
// guard for portability).
double rss_mb() {
    FILE* f = std::fopen("/proc/self/statm", "r");
    if (f == nullptr) return -1.0;
    long size_pages = 0, resident_pages = 0;
    int n = std::fscanf(f, "%ld %ld", &size_pages, &resident_pages);
    std::fclose(f);
    if (n != 2) return -1.0;
    long page_bytes = sysconf(_SC_PAGESIZE);
    return (double) resident_pages * (double) page_bytes / (1024.0 * 1024.0);
}

double mat_mb(const cv::Mat& m) {
    if (m.empty()) return 0.0;
    return (double)(m.total() * m.elemSize()) / (1024.0 * 1024.0);
}

// Map string → cv::WarperCreator.  Returns nullptr for unknown names
// (caller falls back to PlaneWarper for SCANS mode anyway).
cv::Ptr<cv::WarperCreator> make_warper(const std::string& name) {
    if (name == "plane")       return cv::makePtr<cv::PlaneWarper>();
    if (name == "cylindrical") return cv::makePtr<cv::CylindricalWarper>();
    if (name == "spherical")   return cv::makePtr<cv::SphericalWarper>();
    return nullptr;
}

cv::Ptr<cv::detail::Blender> make_blender(const std::string& name) {
    if (name == "feather") {
        return cv::detail::Blender::createDefault(cv::detail::Blender::FEATHER, false);
    }
    return cv::detail::Blender::createDefault(cv::detail::Blender::MULTI_BAND, false);
}

cv::Ptr<cv::detail::SeamFinder> make_seam_finder(const std::string& name) {
    if (name == "skip" || name == "no") {
        return cv::makePtr<cv::detail::NoSeamFinder>();
    }
    if (name == "voronoi") {
        return cv::makePtr<cv::detail::VoronoiSeamFinder>();
    }
    return cv::makePtr<cv::detail::GraphCutSeamFinder>(
        cv::detail::GraphCutSeamFinder::COST_COLOR_GRAD);
}

// Bake an output rotation per the capture orientation.  Rotation
// table mirrors OpenCVStitcher.mm and the previous
// retailens_stitcher.cpp — kept verbatim so behaviour is unchanged.
cv::Mat bake_rotation(const cv::Mat& src, const std::string& orientation,
                      const LogFn& logFn) {
    cv::Mat rotated;
    if (orientation == "landscape-left") {
        cv::rotate(src, rotated, cv::ROTATE_90_COUNTERCLOCKWISE);
        log_info(logFn, "[stitch]",
                 "bake-rotated 90° CCW for landscape-left (%dx%d → %dx%d)",
                 src.cols, src.rows, rotated.cols, rotated.rows);
        return rotated;
    }
    if (orientation == "landscape-right") {
        cv::rotate(src, rotated, cv::ROTATE_90_CLOCKWISE);
        log_info(logFn, "[stitch]",
                 "bake-rotated 90° CW for landscape-right (%dx%d → %dx%d)",
                 src.cols, src.rows, rotated.cols, rotated.rows);
        return rotated;
    }
    if (orientation == "portrait-upside-down") {
        cv::rotate(src, rotated, cv::ROTATE_180);
        log_info(logFn, "[stitch]",
                 "bake-rotated 180° for portrait-upside-down (%dx%d)",
                 src.cols, src.rows);
        return rotated;
    }
    log_info(logFn, "[stitch]", "no bake-rotation (orientation=%s, %dx%d)",
             orientation.c_str(), src.cols, src.rows);
    return src;
}

// Crop the non-zero bounding rect from the stitched panorama.  cv::
// Stitcher's compose stage leaves a black border around the warped
// region; we trim that here.
cv::Mat crop_bbox(const cv::Mat& panorama) {
    cv::Mat gray;
    cv::cvtColor(panorama, gray, cv::COLOR_BGR2GRAY);
    cv::Mat mask;
    cv::threshold(gray, mask, 0, 255, cv::THRESH_BINARY);
    cv::Rect bbox = cv::boundingRect(mask);
    if (bbox.width <= 0 || bbox.height <= 0) {
        return panorama;
    }
    return panorama(bbox).clone();
}

// Map cv::Stitcher::Status → StitchErrorCode.  cv::Stitcher's enum
// values aren't documented as ABI-stable so we don't rely on
// numeric equality; switch through the named constants.
StitchErrorCode statusToErrorCode(cv::Stitcher::Status status) {
    switch (status) {
        case cv::Stitcher::OK:                            return StitchErrorCode::Ok;
        case cv::Stitcher::ERR_NEED_MORE_IMGS:            return StitchErrorCode::NeedMoreImages;
        case cv::Stitcher::ERR_HOMOGRAPHY_EST_FAIL:       return StitchErrorCode::HomographyEstimationFailed;
        case cv::Stitcher::ERR_CAMERA_PARAMS_ADJUST_FAIL: return StitchErrorCode::CameraParamsAdjustFailed;
        default:                                          return StitchErrorCode::UnknownCvException;
    }
}

// V16 Phase 1b.fix3 — find the largest axis-aligned rectangle that
// fits ENTIRELY inside the non-zero region of `mask` (CV_8UC1).
// Used to crop the post-stitch panorama tightly: the regular
// boundingRect of non-zero pixels still includes the black corners
// where the projection didn't fill; the max-inscribed rectangle
// excludes those entirely.
//
// Algorithm: maximum-rectangle-in-histogram swept row by row.
// O(W * H).  For a 4-6 MP panorama on iPhone 16 Pro, completes in
// 30-60 ms.
//
// Returns cv::Rect(0,0,0,0) if `mask` is empty or fully zero.
cv::Rect maxInscribedRectFromMask(const cv::Mat& mask) {
    if (mask.empty() || mask.type() != CV_8UC1) {
        return cv::Rect();
    }
    const int H = mask.rows;
    const int W = mask.cols;

    // Per-column running heights of consecutive non-zero pixels
    // ending at the current row.
    std::vector<int> heights((size_t)W, 0);
    cv::Rect bestRect(0, 0, 0, 0);
    long long bestArea = 0;

    // Reusable monotonic stack for the row's largest-rectangle-in-
    // histogram subroutine.
    std::vector<int> stack;
    stack.reserve((size_t)W + 1);

    for (int row = 0; row < H; ++row) {
        const uchar* m = mask.ptr<uchar>(row);
        for (int col = 0; col < W; ++col) {
            heights[(size_t)col] =
                (m[col] != 0) ? heights[(size_t)col] + 1 : 0;
        }

        // Largest rectangle in the histogram for this row.
        stack.clear();
        for (int col = 0; col <= W; ++col) {
            const int h = (col == W) ? 0 : heights[(size_t)col];
            while (!stack.empty()
                   && heights[(size_t)stack.back()] > h) {
                const int topIdx = stack.back();
                stack.pop_back();
                const int leftIdx =
                    stack.empty() ? -1 : stack.back();
                const int width = col - leftIdx - 1;
                const long long area =
                    (long long)heights[(size_t)topIdx]
                    * (long long)width;
                if (area > bestArea) {
                    bestArea = area;
                    bestRect = cv::Rect(
                        leftIdx + 1,
                        row - heights[(size_t)topIdx] + 1,
                        width,
                        heights[(size_t)topIdx]
                    );
                }
            }
            stack.push_back(col);
        }
    }
    return bestRect;
}

}  // namespace


StitchResult stitchFramePaths(
    const std::vector<std::string>& framePaths,
    const std::string&              outputPath,
    const StitchConfig&             config,
    LogFn                           logFn)
{
    // V2 routing — when caller opts in, hand off to the manual
    // cv::detail::* pipeline.  See stitcher.hpp::StitchConfig::
    // useManualPipeline for the tradeoffs.  Routing here keeps the
    // call-site signature identical so existing bridges (iOS Obj-C++,
    // Android JNI) don't need to know which path runs internally.
    if (config.useManualPipeline) {
        return stitchFramePathsManual(framePaths, outputPath, config, logFn);
    }

    const auto t0 = std::chrono::steady_clock::now();
    StitchResult result;
    result.framesRequested = static_cast<int32_t>(framePaths.size());

    if (framePaths.size() < 2) {
        result.errorCode = StitchErrorCode::InvalidArgument;
        result.errorMessage = "Need at least 2 frames to stitch (got " +
                              std::to_string(framePaths.size()) + ")";
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }
    if (outputPath.empty()) {
        result.errorCode = StitchErrorCode::InvalidArgument;
        result.errorMessage = "outputPath must not be empty";
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }

    log_info(logFn, "[stitch]",
             "stitchFramePaths: frames=%zu warper=%s blender=%s seam=%s "
             "mode=%s orientation=%s quality=%d inscribedRect=%d",
             framePaths.size(),
             config.warperType.c_str(),
             config.blenderType.c_str(),
             config.seamFinderType.c_str(),
             config.stitchMode == StitchMode::Scans ? "scans" : "panorama",
             config.captureOrientation.c_str(),
             config.jpegQuality,
             config.useInscribedRectCrop ? 1 : 0);
    log_info(logFn, "[memstat]", "phase=entry rss=%.1f MB", rss_mb());

    // ── 1.  Load input frames ───────────────────────────────────────
    std::vector<cv::Mat> images;
    images.reserve(framePaths.size());
    double totalInputMB = 0.0;
    for (size_t i = 0; i < framePaths.size(); ++i) {
        cv::Mat img = cv::imread(framePaths[i], cv::IMREAD_COLOR);
        if (img.empty()) {
            result.errorCode = StitchErrorCode::ImageReadFailed;
            result.errorMessage = "Failed to load frame: " + framePaths[i];
            log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
            return result;
        }
        const double mb = mat_mb(img);
        totalInputMB += mb;
        log_info(logFn, "[dimstat]",
                 "input[%zu] %dx%d %dch elemSize=%zu data=%.2f MB",
                 i, img.cols, img.rows, img.channels(), img.elemSize(), mb);
        images.push_back(std::move(img));
    }
    log_info(logFn, "[dimstat]", "loaded %zu frames total_input_data=%.2f MB",
             images.size(), totalInputMB);
    log_info(logFn, "[memstat]", "phase=after_imread rss=%.1f MB", rss_mb());

    // ── 2.  Configure cv::Stitcher ──────────────────────────────────
    const cv::Stitcher::Mode cvMode = (config.stitchMode == StitchMode::Scans)
        ? cv::Stitcher::SCANS : cv::Stitcher::PANORAMA;
    cv::Ptr<cv::Stitcher> stitcher;
    try {
        stitcher = cv::Stitcher::create(cvMode);
    } catch (const cv::Exception& e) {
        result.errorCode = StitchErrorCode::UnknownCvException;
        result.errorMessage = std::string("Stitcher::create threw: ") + e.what();
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }

    // Warper only applies in PANORAMA mode (SCANS hard-wires PlaneWarper
    // internally; setting a different warper there silently breaks the
    // affine BA's assumptions — see learning doc on pipeline coherence).
    if (cvMode == cv::Stitcher::PANORAMA) {
        if (auto warper = make_warper(config.warperType)) {
            stitcher->setWarper(warper);
        }
    } else {
        log_info(logFn, "[stitch]",
                 "SCANS mode: skipping setWarper (PlaneWarper hard-wired)");
    }
    stitcher->setBlender(make_blender(config.blenderType));
    stitcher->setSeamFinder(make_seam_finder(config.seamFinderType));

    // Resolution budgets.  Negative => keep cv::Stitcher library default.
    if (config.registrationResolMP > 0.0) {
        stitcher->setRegistrationResol(config.registrationResolMP);
    }
    if (config.seamEstimationResolMP > 0.0) {
        stitcher->setSeamEstimationResol(config.seamEstimationResolMP);
    }
    if (config.compositingResolMP > 0.0) {
        stitcher->setCompositingResol(config.compositingResolMP);
    }
    log_info(logFn, "[dimstat]",
             "cv::Stitcher resol budgets (per frame, MP):"
             " registration=%.3f seam=%.3f compositing=%.3f%s",
             stitcher->registrationResol(),
             stitcher->seamEstimationResol(),
             stitcher->compositingResol(),
             stitcher->compositingResol() < 0
                 ? " (ORIG_RESOL = no downscale!)" : "");

    // ── 3.  Stitch with progressive-confidence retry (C+D) ──────────
    //
    // cv::Stitcher::leaveBiggestComponent drops frames whose pairwise
    // confidence is below `panoConfidenceThresh`.  Boundary frames
    // (first/last 1-2) statistically fall below first.  We retry
    // with progressively lower thresholds [1.0 → 0.5 → 0.3] until
    // every frame is retained or we hit the floor.  SCANS skips the
    // higher thresholds (its default is already 0.3).
    log_info(logFn, "[memstat]", "phase=before_stitch rss=%.1f MB", rss_mb());
    const double kRetryThresholds[] = {1.0, 0.5, 0.3};
    const int kNumAttempts = sizeof(kRetryThresholds) / sizeof(double);
    cv::Mat panorama;
    cv::Stitcher::Status status = cv::Stitcher::ERR_NEED_MORE_IMGS;
    int framesIncluded = 0;
    double finalThreshold = -1.0;
    int finalAttempt = 0;
    for (int attempt = 0; attempt < kNumAttempts; ++attempt) {
        const double thresh = kRetryThresholds[attempt];
        if (cvMode == cv::Stitcher::SCANS && thresh > 0.31) continue;
        stitcher->setPanoConfidenceThresh(thresh);
        finalAttempt = attempt + 1;
        finalThreshold = thresh;
        log_info(logFn, "[stitch-retry]",
                 "attempt %d/%d panoConfidenceThresh=%.2f",
                 finalAttempt, kNumAttempts, thresh);
        try {
            status = stitcher->stitch(images, panorama);
        } catch (const cv::Exception& e) {
            result.errorCode = StitchErrorCode::UnknownCvException;
            result.errorMessage = std::string("Stitcher::stitch threw on attempt ") +
                std::to_string(finalAttempt) + ": " + e.what();
            log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
            return result;
        }
        if (status != cv::Stitcher::OK) {
            log_info(logFn, "[stitch-retry]",
                     "attempt %d FAILED with status=%d, trying next threshold",
                     finalAttempt, static_cast<int>(status));
            continue;
        }
        const std::vector<int>& component = stitcher->component();
        framesIncluded = static_cast<int>(component.size());
        log_info(logFn, "[stitch-retry]",
                 "attempt %d OK: framesIncluded=%d of %zu (thresh=%.2f)",
                 finalAttempt, framesIncluded, framePaths.size(), thresh);
        if (framesIncluded >= static_cast<int>(framePaths.size())) {
            break;  // all retained — done
        }
        if (attempt + 1 < kNumAttempts) {
            log_info(logFn, "[stitch-retry]",
                     "%d frames dropped — retrying with lower threshold",
                     (int)framePaths.size() - framesIncluded);
        } else {
            log_info(logFn, "[stitch-retry]",
                     "%d frames dropped at lowest threshold %.2f — accepting result",
                     (int)framePaths.size() - framesIncluded, thresh);
        }
    }
    if (status != cv::Stitcher::OK) {
        result.errorCode = statusToErrorCode(status);
        result.errorMessage = "Stitcher::stitch failed at all " +
            std::to_string(finalAttempt) + " thresholds, last status code " +
            std::to_string(static_cast<int>(status));
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }
    log_info(logFn, "[dimstat]",
             "post-stitch panorama %dx%d %dch data=%.2f MB"
             " (framesIncluded=%d/%zu, finalThresh=%.2f, attempts=%d)",
             panorama.cols, panorama.rows, panorama.channels(),
             mat_mb(panorama),
             framesIncluded, framePaths.size(), finalThreshold, finalAttempt);
    log_info(logFn, "[memstat]", "phase=after_stitch rss=%.1f MB", rss_mb());

    // ── 4.  Crop to non-zero bounding rect ──────────────────────────
    cv::Mat cropped = crop_bbox(panorama);
    log_info(logFn, "[dimstat]",
             "post-crop_bbox %dx%d → %dx%d data=%.2f MB (inscribedRect=%d, currently ignored)",
             panorama.cols, panorama.rows, cropped.cols, cropped.rows,
             mat_mb(cropped),
             config.useInscribedRectCrop ? 1 : 0);
    log_info(logFn, "[memstat]", "phase=after_crop rss=%.1f MB", rss_mb());

    // ── 5.  Bake rotation per capture orientation ───────────────────
    cv::Mat final_image = bake_rotation(cropped, config.captureOrientation, logFn);
    log_info(logFn, "[dimstat]",
             "post-bake_rotation %dx%d data=%.2f MB",
             final_image.cols, final_image.rows, mat_mb(final_image));
    log_info(logFn, "[memstat]", "phase=after_bake_rotation rss=%.1f MB", rss_mb());

    // ── 6.  Write JPEG ──────────────────────────────────────────────
    const int q = std::max(0, std::min(100, config.jpegQuality));
    std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, q};
    bool wrote = false;
    try {
        wrote = cv::imwrite(outputPath, final_image, params);
    } catch (const cv::Exception& e) {
        result.errorCode = StitchErrorCode::ImageWriteFailed;
        result.errorMessage = std::string("cv::imwrite threw: ") + e.what();
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }
    if (!wrote) {
        result.errorCode = StitchErrorCode::ImageWriteFailed;
        result.errorMessage = "cv::imwrite returned false (path=" + outputPath + ")";
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }
    log_info(logFn, "[stitch]",
             "output written: %s (%dx%d)",
             outputPath.c_str(), final_image.cols, final_image.rows);
    log_info(logFn, "[memstat]", "phase=after_imwrite rss=%.1f MB", rss_mb());

    // ── 7.  Fill the result ─────────────────────────────────────────
    const auto t1 = std::chrono::steady_clock::now();
    result.success                = true;
    result.errorCode              = StitchErrorCode::Ok;
    result.width                  = final_image.cols;
    result.height                 = final_image.rows;
    result.framesIncluded         = framesIncluded;
    result.finalConfidenceThresh  = finalThreshold;
    result.durationMs             = std::chrono::duration_cast<std::chrono::milliseconds>(
                                       t1 - t0).count();
    return result;
}


// ════════════════════════════════════════════════════════════════════
// stitchFramePathsManual — manual cv::detail::* pipeline
// ════════════════════════════════════════════════════════════════════
//
// Ported from OpenCVStitcher.mm:stitchFramePaths: (the iOS-only
// ~1500-line method, lines 401-1911 of that file).  Pipeline matches
// cv::Stitcher::PANORAMA's internal algorithm EXCEPT we drive the
// stages ourselves so we can:
//
//   * Run GraphCutSeamFinder at SEAM_MP (0.1) instead of compose_MP —
//     ~100× faster.
//   * Re-warp at COMPOSE_MP (0.6-1.0) after BA runs at REGISTRATION_MP
//     (0.3) — gives us back the cylindrical-era sharpness without the
//     OOM that comes from composing at ORIG_RESOL.
//   * Retry leaveBiggestComponent at PRUNE granularity (cheap) rather
//     than around the whole stitch (cv::Stitcher's C+D approach).
//   * Catch BA exceptions and fall back to estimator cameras instead
//     of aborting.
//
// The 9-step structure is preserved with the original Step N: comments
// so iOS↔shared traceability stays intact.  Many of the comments
// reference iOS-specific incidents (V12.x / V16 phases, Ram's traces,
// Console.app rate-limit behaviour) — those references are KEPT so
// the institutional memory survives the port.  The behaviours they
// describe still apply on Android too: cv::resize allocator state,
// jetsam/lmkd-equivalent OOM-kill behaviour, BA convergence failures
// on landscape inputs.
//
// Notable differences from the iOS original:
//   * No @autoreleasepool / ARC machinery — pure C++ stack semantics
//     handle scope-exit cleanup.  The fix-10 "capture failure into
//     strong local + break out of pool" pattern collapses to ordinary
//     C++ early-returns / goto-style break-out — we use a do/while(0)
//     wrapper so all failure paths set the result and `break` once.
//   * No os_log — replaced with the shared log_info/log_error
//     callbacks.  Originals' OS_LOG_TYPE_FAULT importance is encoded
//     by routing to log_error.
//   * No `loadFramesOrFail` helper — we inline the cv::imread loop
//     because the shared cpp/stitcher.cpp already has its own loader
//     pattern for the high-level path; reusing the same approach
//     keeps the file's load-error handling consistent.
//   * No EXIF-tag JPEG writer (WriteJPEGWithEXIFTag).  iOS's
//     ImageIO-backed writer baked an EXIF Orientation=1 tag into the
//     output.  We rely on `bake_rotation` already rotating the pixels
//     in-place, so a tag-less cv::imwrite gives the same visual
//     result on iOS image renderers.  When this function is wired to
//     iOS, if EXIF=1 is required, the iOS bridge can re-encode after
//     the fact OR we add an EXIF-aware writer to the shared layer
//     (see TODO[shared-stitcher-port-part-2] below).
//   * Pre-stitch memory abort + kMaxFramesForStitch=8 frame cap are
//     KEPT — they exist for the same reason on both platforms.
//   * StitcherResidentMB / phys_footprint reporting collapses to the
//     existing rss_mb() helper.  rss_mb reads /proc/self/statm which
//     works on both Android (Linux procfs) and iOS (procfs is mounted
//     in the simulator at least; on real device this falls back to
//     -1.0 which is harmless).  TODO below covers re-introducing the
//     mach task_info path if iOS reports -1 in production traces.
StitchResult stitchFramePathsManual(
    const std::vector<std::string>& framePaths,
    const std::string&              outputPath,
    const StitchConfig&             config,
    LogFn                           logFn)
{
    const auto t0 = std::chrono::steady_clock::now();
    StitchResult result;
    result.framesRequested = static_cast<int32_t>(framePaths.size());

    // V12.14.2 — FAULT-level sentinel.  Survives Console.app rate-limit;
    // proves the function entered.  If a future trace doesn't show this
    // line for a crashed run, the crash is BEFORE stitchFramePaths
    // (e.g., in extractFramesFromVideoAtPath or in the dispatch_async
    // block in StitcherBridge).
    const double kStartResidentMB = rss_mb();
    log_info(logFn, "[stitch-bc]",
             "STITCH START: %zu frames mem=%.1fMB",
             framePaths.size(), kStartResidentMB);

    // V16 Phase 1b.fix1 — device-aware pre-stitch memory abort.
    //
    // Original V12.14.8 fixed the threshold at 700 MB, sized for legacy
    // iPhones (~2 GB total RAM, ~720 MB jetsam kill point on camera-
    // active foreground apps).  That ceiling is irrelevant on modern
    // hardware: iPhone 16 Pro has 8 GB RAM and a per-process limit of
    // ~3 GB on iOS 26 (confirmed by JetsamEvent at 3.38 GB).
    //
    // Also, the V12.14.8 assumption — "vision-camera CameraView is
    // unmounted before stitch, so baseline drops to ~350-450 MB" —
    // doesn't hold for the V16 batch-keyframe flow, where the AR
    // session keeps running during stitch (baseline naturally 600-800
    // MB).  AR pause is now done at the bridge level (Phase 1b.fix1
    // in RetaiLensIncrementalStitcher.swift), but even with that, the
    // 700 MB threshold throttles modern devices for no reason.
    //
    // New formula: max(700, totalRAMGB × 300).  Leaves ~30% headroom
    // below the per-process limit for the stitch peak.
    //   2 GB device → 700  MB threshold (clamped, legacy protection)
    //   4 GB device → 1200 MB
    //   6 GB device → 1800 MB
    //   8 GB device → 2400 MB
    //
    // TODO[shared-stitcher-port-part-2]: read total RAM in a
    // platform-agnostic way.  Original used
    // `NSProcessInfo.processInfo.physicalMemory`.  Linux/Android side
    // would use sysconf(_SC_PHYS_PAGES) * sysconf(_SC_PAGESIZE).  For
    // now, we use a conservative 4 GB assumption so the threshold is
    // 1200 MB — high enough not to throttle real devices, low enough
    // to still abort on degenerate baselines.  When iOS wires this
    // up, plumb the actual physicalMemory through the bridge or add
    // an `availableRamMB` field to StitchConfig.
    const double kAssumedTotalRAMGB = 4.0;
    const double kPreStitchAbortMB = std::max(700.0, kAssumedTotalRAMGB * 300.0);
    if (kStartResidentMB > kPreStitchAbortMB) {
        log_error(logFn, "[stitch-bc]",
                  "PRE-STITCH ABORT: mem=%.1fMB > %.1fMB threshold",
                  kStartResidentMB, kPreStitchAbortMB);
        // V16 fix-attempt 9 — sentinel return.  See validPairs<1 site
        // below for the full root-cause analysis.  In the iOS original
        // this returned an empty RetaiLensStitchResult; here we return
        // a StitchResult with success=false + a stable error code so
        // both bridges see a clean failure rather than an
        // ambiguous "output written but zero pixels" surface.
        result.errorCode = StitchErrorCode::UnknownCvException;
        result.errorMessage = "Pre-stitch memory abort";
        return result;
    }

    if (framePaths.size() < 2) {
        // V16 fix-attempt 9 — sentinel return.
        result.errorCode = StitchErrorCode::InvalidArgument;
        result.errorMessage = "Need at least 2 frames to stitch (got " +
                              std::to_string(framePaths.size()) + ")";
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }
    if (outputPath.empty()) {
        result.errorCode = StitchErrorCode::InvalidArgument;
        result.errorMessage = "outputPath must not be empty";
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }

    // V12.14.2 — defensive frame cap.  Ram's V12.14 traces showed a
    // landscape capture with 12 frames (144 pairwise) crash inside
    // BundleAdjusterRay.  A 7-frame capture (49 pairwise) succeeded.
    // Above ~10 frames the BA solver becomes unstable on landscape
    // inputs — most likely the Levenberg-Marquardt Jacobian conditions
    // get bad with the wider aspect ratio + more pairwise constraints.
    // Cap framePaths to kMaxFramesForStitch evenly-spaced indices
    // BEFORE the imread loop so we don't even pay the imread cost
    // for the discarded frames.  Trade-off: long pans get slightly
    // less overlap (a 5-second pan at 3 fps = 15 frames is downsampled
    // to 8 evenly-spaced).  Quality regression is minor; stability is
    // huge — this kills the EXC_BAD_ACCESS deterministically.
    static const size_t kMaxFramesForStitch = 8;
    std::vector<std::string> workFramePaths = framePaths;
    if (workFramePaths.size() > kMaxFramesForStitch) {
        std::vector<std::string> downsampled;
        downsampled.reserve(kMaxFramesForStitch);
        const size_t origCount = workFramePaths.size();
        for (size_t i = 0; i < kMaxFramesForStitch; i++) {
            size_t idx = (i * (origCount - 1)) / (kMaxFramesForStitch - 1);
            downsampled.push_back(workFramePaths[idx]);
        }
        workFramePaths = std::move(downsampled);
        log_info(logFn, "[stitch-bc]",
                 "downsampled %zu -> %zu frames (BA stability cap)",
                 origCount, kMaxFramesForStitch);
    }

    // Load all input frames before invoking the stitcher.  Memory cost
    // is N × frame size — for typical shelf captures (~2048×1536 RGB,
    // ~9 MB / frame raw, but cv::imread decodes JPEG so resident
    // footprint is bounded by the original sensor resolution).
    //
    // V12.13 — breadcrumb each load.  If the landscape-only crash is
    // in cv::imread (e.g., decoding a JPEG produced by the new
    // per-frame autoreleasepool extract) the LAST log line tells us
    // which frame index + path triggered it.
    std::vector<cv::Mat> frames;
    frames.reserve(workFramePaths.size());
    for (size_t idx = 0; idx < workFramePaths.size(); ++idx) {
        const std::string& path = workFramePaths[idx];
        cv::Mat img = cv::imread(path);
        log_info(logFn, "[stitch-bc]",
                 "loadFrames %zu/%zu: %s -> %dx%d (channels=%d, empty=%d)",
                 idx, workFramePaths.size(),
                 path.c_str(), img.cols, img.rows, img.channels(),
                 (int)img.empty());
        if (img.empty()) {
            result.errorCode = StitchErrorCode::ImageReadFailed;
            result.errorMessage = "Could not read image at path: " + path;
            log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
            return result;
        }
        frames.push_back(img);
    }

    // ── Hand-rolled stitch via cv::detail::* with CylindricalWarper ────
    //
    // The high-level cv::Stitcher::PANORAMA uses SphericalWarper, which
    // produces the "panorama bowl" shape on short shelf-scan arcs.
    // Calling setWarper(CylindricalWarper) on the high-level stitcher
    // crashes (PANORAMA's BundleAdjusterRay's R-matrix outputs are
    // structured for spherical warp).  So we drive the pipeline
    // ourselves, replicating PANORAMA's algorithm exactly EXCEPT we
    // swap the warper at the end.  This is also the same path
    // Phase 5 will populate with AR-derived poses (skipping
    // features→matching→BA when poses are known).
    //
    // Pipeline:
    //   1. ORB features per frame
    //   2. BestOf2NearestMatcher (PANORAMA's default)
    //   3. HomographyBasedEstimator → camera initial guesses
    //   4. BundleAdjusterRay (PANORAMA's default) refines cameras
    //   5. CylindricalWarper warps each frame using cameras
    //   6. GraphCutSeamFinder + MultiBandBlender produce final panorama
    cv::Mat panorama;
    // Breadcrumbs in the device console.  If the next stitch
    // crashes, the last logged step pinpoints the failure point —
    // makes debugging without Xcode much faster.  Prefix is
    // grep-able in Console.app / logcat.
    log_info(logFn, "[RetaiLensStitcher]", "start: %zu frames", frames.size());

    // V16 fix-10 (2026-05-13) — STRUCTURAL: NO return statement
    // executes inside the @autoreleasepool block.  Failure paths
    // capture the result into a strong local declared above the
    // pool, then `break` out of the do/while(0) wrapper.  In the
    // pure-C++ port the @autoreleasepool is gone (no ObjC autorelease
    // semantics), but we keep the do/while(0) wrapper so all failure
    // paths converge on a single result-construction site below.
    // Helps reading + matches the iOS original's control flow line
    // for line.
    bool failedInsidePool = false;
    bool sentinelInsidePool = false;
    StitchErrorCode capturedErrorCode = StitchErrorCode::UnknownCvException;
    std::string     capturedErrorMessage;

    do {
    try {
        // Two-stage resolution pipeline (matches cv::Stitcher::PANORAMA):
        //
        //   REGISTRATION_MP (0.3): downscale used for features, matching,
        //   BA, wave-correct.  The expensive optimisation stages run
        //   here.  cv::Stitcher uses 0.6; we use 0.3 because BA still
        //   converges reliably on shelf-scan inputs and the smaller
        //   matrices make BA noticeably faster on iPhone.
        //
        //   COMPOSE_MP (0.6-1.0): RE-WARP + blend at this larger resolution
        //   to produce the FINAL panorama.  cv::Stitcher uses ORIG_RESOL
        //   (full input size) — gorgeous output but iPhones at 12 MP × N
        //   frames blow past the jetsam threshold.  1.0 MP is the
        //   sweet spot: ~2× linear sharpness over single-stage 0.3 MP,
        //   with peak compose memory still under ~120 MB thanks to the
        //   per-frame release pattern in the blender feed loop below.
        //
        // The cylindrical-era sharpness came from cv::Stitcher's
        // automatic two-stage flow.  When we hand-rolled the pipeline
        // to use PlaneWarper safely, we collapsed it to a single 0.3 MP
        // stage — output went from ~1500×800 (cylindrical) to ~700×400
        // (plane).  This restores the multi-stage structure while
        // keeping the PlaneWarper that the host app actually wants.
        //
        // V2 port note: registrationResolMP / compositingResolMP from
        // StitchConfig let the CALLER override the defaults if needed
        // (e.g., a low-RAM device build can drop COMPOSE_MP to 0.4).
        // When config values are <0, we use the hard-coded defaults
        // ported from the iOS original (REGISTRATION=0.3, COMPOSE=0.6).
        const double REGISTRATION_MP = (config.registrationResolMP > 0.0)
            ? config.registrationResolMP : 0.3;
        // 0.6 MP matches cv::Stitcher::PANORAMA's registration_resol
        // default and is the "safe sharp" setting on Debug builds —
        // 1.0 MP was visibly sharper but pushed memory peak into iOS
        // jetsam territory (Sentry caught WatchdogTermination + the
        // EXC_BAD_ACCESS-during-tear-down variant under the same root
        // cause).  Release builds free ~200-300 MB of RN baseline
        // overhead and would tolerate 1.0 MP fine; if/when a Release
        // build is the test target, bump this back up.
        const double COMPOSE_MP = (config.compositingResolMP > 0.0)
            ? config.compositingResolMP : 0.6;

        // Capture original size BEFORE downscaling — we need it later
        // to compute the compose scale relative to full-res input.
        int origCols = frames[0].cols;
        int origRows = frames[0].rows;
        double origMp = (double)origCols * origRows / 1e6;

        // Stage 1: downscale to REGISTRATION_MP for features+matching+BA.
        std::vector<cv::Mat> workFrames;
        workFrames.reserve(frames.size());
        double work_scale = (origMp > REGISTRATION_MP)
            ? std::sqrt(REGISTRATION_MP / origMp)
            : 1.0;
        if (work_scale < 1.0) {
            for (const auto& f : frames) {
                cv::Mat scaled;
                cv::resize(f, scaled, cv::Size(), work_scale, work_scale,
                           cv::INTER_AREA);
                workFrames.push_back(scaled);
            }
        } else {
            for (const auto& f : frames) workFrames.push_back(f);
        }

        log_info(logFn, "[RetaiLensStitcher]",
                 "step1: features (work scale %d×%d)",
                 workFrames.empty() ? 0 : workFrames[0].cols,
                 workFrames.empty() ? 0 : workFrames[0].rows);
        // V12.14 Commit B — paired fprintf(stderr) breadcrumb.  iOS'
        // Console.app rate-limits NSLog under high-frequency emission
        // (Ram's V12.13 trace had loadFrames 4-7 + step1 missing while
        // loadFrames 0-3 + step2 made it through).  Stderr is not rate-
        // limited and flushes promptly, so the LAST stderr line before
        // the crash reliably pinpoints the failing stage.
        //
        // Shared-port note: this breadcrumb collapses to log_info under
        // the shared LogFn callback.  On Android the bridge sinks to
        // logcat (not rate-limited).  On iOS, when wired up, the bridge
        // can still emit to os_log if rate-limit pressure returns.
        log_info(logFn, "[stitch-bc]",
                 "step1 enter (work %d×%d, %zu frames)",
                 workFrames.empty() ? 0 : workFrames[0].cols,
                 workFrames.empty() ? 0 : workFrames[0].rows,
                 workFrames.size());

        // Step 1: features.  800 ORB features is enough for matching
        // ~50% overlap between adjacent frames; 1500 was overkill and
        // doubled the matching work for marginal quality gain.
        auto featuresFinder = cv::ORB::create(800);
        std::vector<cv::detail::ImageFeatures> imgFeatures(workFrames.size());
        for (size_t i = 0; i < workFrames.size(); i++) {
            cv::detail::computeImageFeatures(featuresFinder, workFrames[i],
                                             imgFeatures[i]);
            imgFeatures[i].img_idx = (int)i;
            log_info(logFn, "[stitch-bc]",
                     "step1 frame %zu: %zu features",
                     i, imgFeatures[i].keypoints.size());
        }
        log_info(logFn, "[stitch-bc]", "step1 done");

        // Step 2: pairwise matching.  match_conf=0.65 matches what
        // cv::Stitcher::PANORAMA uses internally — looser values
        // (counter-intuitively) hurt BA convergence by letting through
        // contradictory low-confidence matches that don't fit a
        // consistent rotation model.  Stick with the proven default.
        // V16 fix-11 (2026-05-13) — REVERTED the AffineBestOf2NearestMatcher
        // swap.  The swap (commit 505c6f1) targeted the validPairs=0
        // symptom on translation-heavy captures, but produced a downstream
        // regression: "Warp stage failed: matrix.cpp:246 setSize s >= 0".
        //
        // Root cause: cv::Stitcher's pipeline has TWO coherent end-to-end
        // modes documented in OpenCV:
        //
        //   PANORAMA: BestOf2NearestMatcher → HomographyBasedEstimator →
        //             BundleAdjusterRay → SphericalWarper/etc.
        //             All stages assume rotation-only camera motion.
        //
        //   SCANS:    AffineBestOf2NearestMatcher → AffineBasedEstimator →
        //             BundleAdjusterAffinePartial → AffineWarper.
        //             All stages assume affine (rotation+translation+
        //             scale+shear) camera motion.
        //
        // Swapping ONLY step 2 to affine while keeping the rotation-only
        // estimator/BA/warper downstream produced incoherent camera
        // parameters: the affine matcher passed inliers with parallax-
        // induced inconsistencies that the rotation estimator turned into
        // non-orthonormal "rotation" matrices.  The warper then computed
        // negative destination canvas sizes and the cv::Mat::setSize
        // assertion fired at step 8b.
        //
        // Fix: revert to BestOf2NearestMatcher so the WHOLE pipeline is
        // coherent in PANORAMA mode.  Translation-heavy captures fall
        // back to validPairs=0 → sentinel result → clean toast (no
        // crash, thanks to fix-10's @autoreleasepool restructure).  The
        // gate's translation-budget force-accept (`flowMaxTranslationCm`
        // in Settings) is the operator's lever to keep per-pair
        // translation small enough that BestOf2NearestMatcher's
        // rotation-homography RANSAC produces useful inliers.
        //
        // Longer-term: see docs/site-content/design/2026-05-13-stitch-
        // pipeline-mode-selection.md for the architectural answer —
        // motion-classified per-capture routing between PANORAMA and
        // SCANS modes at finalize() time.
        log_info(logFn, "[RetaiLensStitcher]", "step2: matching");
        log_info(logFn, "[stitch-bc]",
                 "step2 enter: BestOf2Nearest matching (PANORAMA mode — coherent end-to-end)");
        cv::detail::BestOf2NearestMatcher matcher(false, 0.65f);
        std::vector<cv::detail::MatchesInfo> pairwise;
        matcher(imgFeatures, pairwise);
        matcher.collectGarbage();
        log_info(logFn, "[stitch-bc]",
                 "step2 done: %zu pairwise entries", pairwise.size());

        // Step 3: leave-best-of-2 keeps only well-connected images at
        // confThresh=1.0 — also matches cv::Stitcher::PANORAMA's
        // default.  Pairs with weaker overlap get dropped before BA.
        // Pre-check: count how many pairwise matches actually have
        // non-trivial features matched.  cv::Stitcher's
        // leaveBiggestComponent / HomographyBasedEstimator fire
        // CV_Assert internally if no useful pairwise data exists —
        // and CV_Assert can SIGABRT in our build (signal not caught
        // by C++ try/catch).  Throwing our own structured error here
        // is the only way to fail-fast before that abort.
        int validPairs = 0;
        for (const auto& m : pairwise) {
            if (m.confidence > 0.0 && m.matches.size() >= 6) {
                validPairs++;
            }
        }
        log_info(logFn, "[RetaiLensStitcher]",
                 "step2.5: %d valid pairwise matches", validPairs);
        if (validPairs < 1) {
            // V16 fix-attempt 9 (NULL TEST, 2026-05-13).  Eight prior
            // attempts chased a deterministic SEGV inside Swift's try-bridge
            // on this *error→throw path.  ASan-on-device with Sentry
            // disabled (RetaiLens-2026-05-13-172125.ips) showed
            // EXC_BAD_ACCESS at 0x60007a530 (UNMAPPED VM, ASan
            // ReportDeadlySignal — no shadow-memory match) firing inside
            // objc_retain immediately after this return.  By returning a
            // non-nil SENTINEL result (width=0, height=0) instead of
            // populating *error and returning nil, we bypass Swift's
            // autoreleasing NSError out-parameter retain entirely.  The
            // Swift caller in RetaiLensIncrementalStitcher.finalize checks
            // `r.width == 0` and constructs a Swift-native NSError to pass
            // to its completion block.
            //
            // Hypothesis under test:
            //   (A) If this path no longer crashes → the throw bridge IS
            //       the proximate trigger.  Permanent: keep sentinel,
            //       document why.
            //   (B) If it still crashes the same way → corruption is
            //       upstream of our return (likely inside opencv2.framework
            //       stitcher allocator pool).  Revert and escalate to C3
            //       (stitch on isolated DispatchQueue).
            //
            // See: docs/site-content/design/2026-05-12-finalize-crash-investigation.md
            //
            // Shared-port note: in the pure-C++ port there is no ObjC
            // autoreleasing-NSError pad, so the historical reason for
            // the sentinel is gone.  We still mark success=false +
            // emit a structured StitchErrorCode so the JS layer sees
            // a clean failure (it's the JS surface that surfaces the
            // "all frames dropped" toast).  Kept the long comment
            // because it explains WHY the iOS bridge added a
            // sentinel-path check — historically valuable.
            log_error(logFn, "[RetaiLensStitcher]",
                      "step2.5: 0 valid pairs — sentinel result (port: signalling AllFramesDroppedByConfidence)");
            capturedErrorCode = StitchErrorCode::AllFramesDroppedByConfidence;
            capturedErrorMessage = "Stitcher found 0 valid pairwise matches — frames may not overlap enough.";
            sentinelInsidePool = true;
            break;
        }

        log_info(logFn, "[RetaiLensStitcher]", "step3: leave-biggest");
        log_info(logFn, "[stitch-bc]", "step3 enter: leave-biggest");
        // leaveBiggestComponent mutates imgFeatures and pairwise IN
        // PLACE to drop frames that aren't part of the biggest
        // connected component.  We MUST also subset workFrames to
        // match — otherwise cameras.size() (built from the trimmed
        // imgFeatures) will be smaller than workFrames.size() and the
        // warp loop reads cameras[i] out of bounds.  That's a likely
        // root cause of the SIGABRT seen on second-stitch attempts.
        std::vector<int> indices = cv::detail::leaveBiggestComponent(
            imgFeatures, pairwise, 1.0f);
        // Trim BOTH workFrames AND the full-res frames using the same
        // indices.  workFrames feeds BA below; full-res frames feed the
        // compose stage further down (re-warped at COMPOSE_MP).  Both
        // must stay aligned with cameras[i] / imgFeatures[i] post-trim.
        std::vector<cv::Mat> trimmedWorkFrames;
        std::vector<cv::Mat> trimmedFrames;
        trimmedWorkFrames.reserve(indices.size());
        trimmedFrames.reserve(indices.size());
        for (int idx : indices) {
            if (idx >= 0 && idx < (int)workFrames.size()) {
                trimmedWorkFrames.push_back(workFrames[idx]);
                trimmedFrames.push_back(frames[idx]);
            }
        }
        workFrames = std::move(trimmedWorkFrames);
        frames = std::move(trimmedFrames);
        log_info(logFn, "[RetaiLensStitcher]",
                 "step3.5: kept %zu frames in biggest component",
                 workFrames.size());
        if (workFrames.size() < 2) {
            // V16 fix-attempt 9 (NULL TEST) — same rationale as the
            // validPairs<1 sentinel above.  Bypass the *error→throw bridge
            // by returning a width=0/height=0 sentinel result instead.
            log_error(logFn, "[RetaiLensStitcher]",
                      "step3.5: <2 frames after leaveBiggestComponent — sentinel result");
            capturedErrorCode = StitchErrorCode::AllFramesDroppedByConfidence;
            capturedErrorMessage = "Less than 2 frames remain after leaveBiggestComponent.";
            sentinelInsidePool = true;
            break;
        }

        // Step 4: estimator
        log_info(logFn, "[RetaiLensStitcher]", "step4: estimator");
        log_info(logFn, "[stitch-bc]", "step4 enter: estimator");
        cv::detail::HomographyBasedEstimator estimator;
        std::vector<cv::detail::CameraParams> cameras;
        if (!estimator(imgFeatures, pairwise, cameras)) {
            // V16 fix-attempt 9 — sentinel return (see validPairs<1 site
            // above for full RCA).  Estimator failures are a real production
            // hazard on borderline-dissimilar frame sequences (typical mode:
            // user pans through occluded regions or featureless walls
            // mid-arc).  Returning sentinel keeps the failure surface clean
            // even though the immediate V16 batch-keyframe repro doesn't
            // typically reach this path.
            log_error(logFn, "[RetaiLensStitcher]",
                      "step4: HomographyBasedEstimator failed — sentinel result");
            capturedErrorCode = StitchErrorCode::HomographyEstimationFailed;
            capturedErrorMessage = "HomographyBasedEstimator failed.";
            sentinelInsidePool = true;
            break;
        }
        for (auto& cam : cameras) {
            cv::Mat R32;
            cam.R.convertTo(R32, CV_32F);
            cam.R = R32;
        }

        // Step 5: bundle adjustment (the slow step).  BundleAdjusterRay
        // is what cv::Stitcher::PANORAMA uses internally.  confThresh=1.0
        // matches cv::Stitcher's default — drops weak match-pair
        // constraints from the optimisation so BA converges reliably.
        // Cap iterations at 100 (default 1000) so a poorly-conditioned
        // problem can't run away into a 60s timeout.  BA typically
        // converges in 20-50 iters on good input; if 100 isn't enough,
        // the inputs themselves are unstitchable and we want to fail
        // fast rather than spin.
        {
            auto _t = std::chrono::steady_clock::now();
            double _ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                _t - t0).count();
            log_info(logFn, "[RetaiLensStitcher]",
                     "step5: bundle adjustment (t+%.0fms)", _ms);
            log_info(logFn, "[stitch-bc]", "step5 enter: bundle adjustment");
        }
        auto adjuster = cv::makePtr<cv::detail::BundleAdjusterRay>();
        adjuster->setConfThresh(1.0f);
        adjuster->setTermCriteria(cv::TermCriteria(
            cv::TermCriteria::EPS + cv::TermCriteria::COUNT,
            100,
            DBL_EPSILON));

        // V12.14.2 — FAULT-level sentinel + camera sanity dump.  These
        // bracket the BA call so a future trace can pinpoint whether
        // the crash is BEFORE BA invocation, INSIDE BA, or AFTER BA.
        // Also dump the first camera's R[0,0] + focal so we can see if
        // estimator produced NaN/Inf values that would crash BA's
        // Levenberg-Marquardt.
        {
            double r00 = cameras.empty() ? 0.0 :
                (cameras[0].R.empty() ? 0.0 : (double)cameras[0].R.at<float>(0, 0));
            double focal = cameras.empty() ? 0.0 : cameras[0].focal;
            log_info(logFn, "[stitch-bc]",
                     "step5 BA INVOKE: cameras=%zu cam0.R[0,0]=%.4f cam0.focal=%.2f",
                     cameras.size(), r00, focal);
        }

        // V12.14.2 — wrap BA in try/catch.  Catches cv::Exception (most
        // likely if BA detects a bad input) and std::exception (defensive).
        // On exception, fall back to the estimator cameras (skipping the
        // BA refinement step).  Pano quality is slightly lower without
        // BA but it WON'T CRASH.  Note: this catches C++ exceptions;
        // raw SIGSEGV from BA's internal pointer deref would still
        // terminate the process — for that, the kMaxFramesForStitch=8
        // cap above is the primary defence.
        bool baSucceeded = false;
        try {
            baSucceeded = (*adjuster)(imgFeatures, pairwise, cameras);
        } catch (const cv::Exception& e) {
            log_error(logFn, "[stitch-bc]",
                      "step5 BA threw cv::Exception: %s — fallback to estimator cameras",
                      e.what());
            baSucceeded = false;
        } catch (const std::exception& e) {
            log_error(logFn, "[stitch-bc]",
                      "step5 BA threw std::exception: %s — fallback to estimator cameras",
                      e.what());
            baSucceeded = false;
        } catch (...) {
            log_error(logFn, "[stitch-bc]",
                      "step5 BA threw unknown exception — fallback to estimator cameras");
            baSucceeded = false;
        }

        if (!baSucceeded) {
            // Fall through with the cameras the estimator produced —
            // step5.5 wave correction + step6+ compose can still run on
            // unrefined cameras.  Result quality will be lower (no global
            // optimisation) but the engine returns a panorama instead of
            // crashing.
            log_info(logFn, "[stitch-bc]",
                     "step5 BA SKIPPED — proceeding with estimator cameras");
        } else {
            log_info(logFn, "[stitch-bc]", "step5 BA OK");
        }

        // Step 5.5: WAVE CORRECTION.  cv::Stitcher::PANORAMA does
        // this automatically; my hand-rolled pipeline was missing it.
        // After BA produces camera rotation matrices, waveCorrect
        // globally rotates them so all cameras share a consistent
        // up-vector.  Without this, the cylindrical (or spherical)
        // projection produces visible "wavy" top / bottom edges where
        // edge frames hit the projection surface at slightly
        // different vertical angles.
        //
        // WAVE_CORRECT_HORIZ — this is what was working yesterday for
        // BOTH portrait+horizontal-pan and landscape+vertical-pan.
        // Why it works for both: HORIZ aligns each camera's "up" vector
        // to the world Y axis (gravity).  vision-camera writes mp4s
        // with `outputOrientation="device"` so the saved frames are
        // already in the user's view orientation; after BA + waveCorrect
        // HORIZ, the panorama's vertical axis matches world's vertical
        // axis regardless of pan direction.
        //
        // I briefly switched to autoDetectWaveCorrectKind thinking it'd
        // handle vertical pans better — it actually picked the wrong
        // kind for portrait+horizontal pans, breaking yesterday's
        // working normal-mode capture.  Reverting.
        {
            auto _t = std::chrono::steady_clock::now();
            double _ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                _t - t0).count();
            log_info(logFn, "[RetaiLensStitcher]",
                     "step5.5: wave correction (BA done, t+%.0fms)", _ms);
            log_info(logFn, "[stitch-bc]", "step5.5 enter: wave correction");
        }
        std::vector<cv::Mat> rmats;
        rmats.reserve(cameras.size());
        for (const auto& cam : cameras) {
            rmats.push_back(cam.R.clone());
        }
        try {
            cv::detail::waveCorrect(rmats, cv::detail::WAVE_CORRECT_HORIZ);
            for (size_t i = 0; i < cameras.size(); i++) {
                cameras[i].R = rmats[i];
            }
        } catch (const cv::Exception& e) {
            // Wave correction can fail on degenerate input (only 1-2
            // cameras with collinear rotations).  Swallow the failure
            // and continue without correction — the panorama will have
            // the wave artifact but is still better than aborting.
            log_info(logFn, "[RetaiLensStitcher]",
                     "wave correction skipped: %s", e.what());
        }

        // Step 6: COMPOSE rescale.  This is the key step that gives us
        // back the cylindrical-era sharpness.  cv::Stitcher does this
        // internally as `composePanorama`: rescale camera intrinsics
        // by (compose_scale / work_scale), recreate the warper at
        // the new scale, then warp+blend on freshly-resized frames at
        // COMPOSE_MP.  Without this step, output stays at REGISTRATION_MP
        // and is visibly blurry.
        double compose_scale = (origMp > COMPOSE_MP)
            ? std::sqrt(COMPOSE_MP / origMp)
            : 1.0;
        double compose_work_aspect = compose_scale / work_scale;
        log_info(logFn, "[RetaiLensStitcher]",
                 "step6: compose rescale "
                 "(work_scale=%.3f → compose_scale=%.3f, aspect=%.3f)",
                 work_scale, compose_scale, compose_work_aspect);
        for (auto& cam : cameras) {
            cam.focal *= compose_work_aspect;
            cam.ppx  *= compose_work_aspect;
            cam.ppy  *= compose_work_aspect;
        }

        // Step 6.5: median focal length determines the warper scale.
        // Computed AFTER compose rescale so warpedScale is already in
        // compose units — matches cv::Stitcher's flow.
        std::vector<double> focals;
        for (const auto& cam : cameras) focals.push_back(cam.focal);
        std::sort(focals.begin(), focals.end());
        float warpedScale =
            focals.empty() ? 1.0f
                           : (float)focals[focals.size() / 2];

        // Step 7: PLANE warper.  The crucial swap.
        //
        // For close-up shelf scans (~30° pan, mostly translational
        // gesture across a planar product face), plane projection is
        // the right choice — it produces a flat output with no
        // cylindrical curve and no spherical bowl.
        //
        // Cylindrical/spherical only buy you something for wider arcs
        // where the per-frame perspective curves matter.  Below ~45°
        // arc, plane is empirically the most natural-looking option
        // and exactly what SCANS mode used (just SCANS coupled it
        // with affine BA which we just established was the wrong
        // estimator for our motion).
        log_info(logFn, "[RetaiLensStitcher]",
                 "step7: warper (%s)", config.warperType.c_str());
        log_info(logFn, "[stitch-bc]",
                 "step7 enter: warper=%s", config.warperType.c_str());
        // Plane / Cylindrical / Spherical — runtime-selectable so
        // the host's settings UI can A/B test which projection looks
        // best for the operator's actual gesture (close-up planar
        // subject vs partial-arc rotation vs wide pan).
        cv::Ptr<cv::WarperCreator> warperCreator;
        if (config.warperType == "cylindrical") {
            warperCreator = cv::makePtr<cv::CylindricalWarper>();
        } else if (config.warperType == "spherical") {
            warperCreator = cv::makePtr<cv::SphericalWarper>();
        } else {
            // "plane" is the default — straight verticals/horizontals,
            // good for close-up subjects.  Hourglass shape produced
            // by partial arcs is removed by the rectangular-crop step
            // below.
            warperCreator = cv::makePtr<cv::PlaneWarper>();
        }
        // V12.14.3 — FAULT breadcrumbs around each sub-step within
        // step7 → step7.5.  Ram's V12.14.2 trace had the crash here
        // (last visible log was step7 enter; step7.5 never fired).
        // These pinpoint which sub-step actually crashes.
        cv::Ptr<cv::detail::RotationWarper> warper =
            warperCreator->create(warpedScale);
        log_info(logFn, "[stitch-bc]",
                 "step7a: warper created (warpedScale=%.2f)", warpedScale);

        // Step 7.5: build composeFrames at COMPOSE_MP from full-res
        // input.  Warp + blend run at this resolution to produce the
        // sharp final output.  Release workFrames first — BA is done,
        // so we don't need the small set anymore.  Sequential release
        // ensures the two big arrays never coexist at peak.
        for (auto& wf : workFrames) wf.release();
        workFrames.clear();
        log_info(logFn, "[stitch-bc]",
                 "step7b: workFrames released, building composeFrames "
                 "(N=%zu, compose_scale=%.3f)",
                 frames.size(), compose_scale);

        // V12.14.3 — wrap the resize loop in try/catch so a bad input
        // Mat doesn't terminate the process.  Per-frame resize on
        // bogus/corrupt cv::Mat data has historically been a SIGSEGV
        // source on consecutive captures.
        std::vector<cv::Mat> composeFrames;
        composeFrames.reserve(frames.size());
        try {
            for (size_t i = 0; i < frames.size(); i++) {
                const auto& f = frames[i];
                log_info(logFn, "[stitch-bc]",
                         "step7c: resize frame %zu (%dx%d, channels=%d, "
                         "data=%p)", i, f.cols, f.rows, f.channels(),
                         (const void*)f.data);

                // V12.14.4 — defensive validation.  Skip frames with NULL
                // data ptr, zero dimensions, or non-positive total — they
                // would SIGSEGV inside cv::resize regardless of interp mode.
                if (f.data == nullptr || f.empty() || f.total() == 0
                    || f.cols <= 0 || f.rows <= 0) {
                    log_error(logFn, "[stitch-bc]",
                              "step7c: SKIPPING frame %zu — invalid Mat "
                              "(data=%p empty=%d total=%zu)",
                              i, (const void*)f.data, (int)f.empty(),
                              (size_t)f.total());
                    continue;
                }

                // V12.14.4 — original wraps each iteration in
                // @autoreleasepool so any ObjC temporaries cv::resize
                // might autorelease internally get drained between
                // frames.  In the pure-C++ port this is a no-op: pure
                // C++ has no autoreleased temporaries; cv::Mat's RAII
                // dtor runs at iteration scope exit naturally.
                cv::Mat scaled;
                if (std::abs(compose_scale - 1.0) > 1e-3) {
                    // V12.14.4 — pre-allocate `scaled` with explicit dims
                    // BEFORE cv::resize so the internal `dst.create()` is a
                    // no-op.  Skips the allocator state corruption Ram's
                    // V12.14.3 trace pointed at: cv::resize crashed on the
                    // 5th consecutive resize when iOS recycled mmap regions
                    // from a prior capture, suggesting cv::resize's internal
                    // allocator path was hitting stale state.
                    //
                    // Plus: switch INTER_AREA → INTER_LINEAR.  INTER_AREA
                    // uses precomputed cached interpolation tables that
                    // appear to be the corrupted state.  INTER_LINEAR uses
                    // a different code path (no cached table).  Slightly
                    // less crisp at extreme downscales but for our 0.538×
                    // shelf-image downscale the visual difference is
                    // negligible — and stability >> sharpness.
                    int newCols = (int)std::round(f.cols * compose_scale);
                    int newRows = (int)std::round(f.rows * compose_scale);
                    scaled.create(newRows, newCols, f.type());
                    cv::resize(f, scaled, scaled.size(), 0, 0, cv::INTER_LINEAR);
                } else {
                    scaled = f.clone();
                }
                composeFrames.push_back(scaled);
            }
        } catch (const cv::Exception& e) {
            // V12.14.7 — %{public}s so the message survives Console.app
            // privacy redaction.  Without this, e.what() shows as "<private>"
            // and we can't see which assertion fired.
            log_error(logFn, "[stitch-bc]",
                      "step7c: cv::resize threw cv::Exception: %s",
                      e.what());
            capturedErrorCode = StitchErrorCode::UnknownCvException;
            capturedErrorMessage = std::string("Compose-stage resize failed: ") + e.what();
            failedInsidePool = true;
            break;
        } catch (...) {
            log_error(logFn, "[stitch-bc]",
                      "step7c: cv::resize threw unknown exception");
            capturedErrorCode = StitchErrorCode::UnknownCvException;
            capturedErrorMessage = "Compose-stage resize failed (unknown).";
            failedInsidePool = true;
            break;
        }
        log_info(logFn, "[stitch-bc]",
                 "step7d: composeFrames built (N=%zu)",
                 composeFrames.size());

        // Release full-res `frames` now that composeFrames has its
        // own resized copies.  Frees ~50-100 MB for a typical 8-frame
        // stitch — a critical part of staying under iOS' jetsam
        // threshold (the ACTUAL cause of the "u != 0" /
        // WatchdogTermination crashes we were debugging — Sentry
        // confirmed those were OOM kills, not OpenCV bugs).
        for (auto& f : frames) f.release();
        frames.clear();
        log_info(logFn, "[stitch-bc]",
                 "step7e: full-res frames released mem=%.1fMB",
                 rss_mb());
        log_info(logFn, "[RetaiLensStitcher]",
                 "step7.5: composeFrames %d×%d "
                 "(compose_scale=%.3f)",
                 composeFrames.empty() ? 0 : composeFrames[0].cols,
                 composeFrames.empty() ? 0 : composeFrames[0].rows,
                 compose_scale);

        // Step 8: warp + (optional) seam finder + blender feed.
        //
        // Two paths based on caller's seamFinderType:
        //
        //   "graphcut" — BATCH path.  Warp all frames into memory,
        //     run GraphCutSeamFinder for optimal seams, then feed
        //     the blender.  Higher peak memory (all warped frames
        //     coexist during seam finding) but produces clean seams
        //     that pair beautifully with MultiBandBlender.  Same
        //     algorithm cv::Stitcher::PANORAMA uses internally.
        //
        //   "skip"     — STREAM path.  Warp + feed each frame in the
        //     same loop, releasing immediately.  Never holds more
        //     than one warped frame in memory.  ~40-50 MB lower peak
        //     at 1.0 MP × 8 frames.  Right choice for low-RAM
        //     devices; the host's per-device defaults pick this
        //     path on devices with <2 GB physical RAM.
        //
        // Both paths feed the SAME blender (selected per caller's
        // blenderType).  Final blend happens after either path
        // completes.
        const bool useSeam = (config.seamFinderType == "graphcut");
        log_info(logFn, "[RetaiLensStitcher]",
                 "step8: %s",
                 useSeam ? "BATCH (warp-all + seam + feed)"
                         : "STREAM (warp+feed per frame)");
        log_info(logFn, "[stitch-bc]",
                 "step8 enter: %s", useSeam ? "BATCH" : "STREAM");

        // Build the blender once — both paths feed into it.
        //
        // The "u != 0" UMat assertion we previously hit when running
        // MultiBand or GraphCut was a SYMPTOM of iOS jetsam OOM-kill
        // (confirmed via Sentry's WatchdogTermination signature),
        // not a bug in MBB / GraphCut.  With the OOM fixes now in
        // place (autoreleasepool wrapping, camera pause during
        // stitch, per-frame Mat releases, plus this stream path for
        // low-mem devices), both should run cleanly.
        cv::Ptr<cv::detail::Blender> blender;
        if (config.blenderType == "feather") {
            blender = cv::detail::Blender::createDefault(
                cv::detail::Blender::FEATHER, false);
            auto fb = blender.dynamicCast<cv::detail::FeatherBlender>();
            if (fb) fb->setSharpness(0.02f);
        } else {
            // "multiband" — Laplacian pyramids per fed frame.
            // More memory than Feather but much sharper seams when
            // paired with GraphCut.
            blender = cv::detail::Blender::createDefault(
                cv::detail::Blender::MULTI_BAND, false);
            auto mbb = blender.dynamicCast<cv::detail::MultiBandBlender>();
            if (mbb) mbb->setNumBands(5);
        }
        log_info(logFn, "[RetaiLensStitcher]",
                 "step10: blender = %s", config.blenderType.c_str());

        if (useSeam) {
            // ── BATCH path ─────────────────────────────────────────────
            const size_t N = composeFrames.size();
            std::vector<cv::Point> corners(N);
            std::vector<cv::Mat> imagesWarped(N);
            std::vector<cv::Mat> masksWarped(N);
            std::vector<cv::Size> sizes(N);
            log_info(logFn, "[stitch-bc]",
                     "step8a: BATCH warp loop (N=%zu)", N);
            // V12.14.6 — defensive measures around the warp loop.  Same
            // recycled-mmap pattern that hit cv::resize in V12.14.3
            // logs (Ram's 4th-capture crash).  cv::PlaneWarper::warp
            // uses cv::remap internally which has its own cached state
            // keyed on input addresses.
            try {
                for (size_t i = 0; i < N; i++) {
                    log_info(logFn, "[stitch-bc]",
                             "step8b: warp frame %zu (%dx%d, data=%p)", i,
                             composeFrames[i].cols, composeFrames[i].rows,
                             (const void*)composeFrames[i].data);
                    // Per-iteration scope drains any autoreleased temps in
                    // the iOS original; pure C++ does this via RAII.
                    cv::Mat K;
                    cameras[i].K().convertTo(K, CV_32F);

                    // V12.14.6 — clone input to break any recycled-mmap
                    // link to prior captures' allocations.  cv::Mat::clone
                    // forces a fresh memcpy into a freshly-allocated buffer.
                    cv::Mat freshInput = composeFrames[i].clone();

                    // V12.14.6 — pre-allocate output Mats via warpRoi() so
                    // cv::remap doesn't need to call create() internally
                    // (the suspect path that crashed in cv::resize too).
                    cv::Rect roi = warper->warpRoi(
                        freshInput.size(), K, cameras[i].R);
                    imagesWarped[i].create(roi.size(), freshInput.type());
                    masksWarped[i].create(roi.size(), CV_8U);

                    cv::Mat mask(freshInput.size(), CV_8U, cv::Scalar(255));
                    corners[i] = warper->warp(
                        freshInput, K, cameras[i].R, cv::INTER_LINEAR,
                        cv::BORDER_CONSTANT, imagesWarped[i]);
                    warper->warp(mask, K, cameras[i].R, cv::INTER_NEAREST,
                                 cv::BORDER_CONSTANT, masksWarped[i]);
                    sizes[i] = imagesWarped[i].size();
                    // V12.14.7 — release composeFrames[i] inside the loop
                    // (was: released only after the entire loop at step8c).
                    // Frees ~14 MB per frame mid-loop, keeping peak working
                    // set ~50-100 MB lower for an 8-frame batch — directly
                    // targets the jetsam OOM kill that struck V12.14.6
                    // after cv::Exception was caught (process died despite
                    // managed throw).  composeFrames[i] is no longer needed
                    // after warp populates imagesWarped[i] / masksWarped[i].
                    composeFrames[i].release();
                }
            } catch (const cv::Exception& e) {
                // V12.14.7 — %{public}s to unredact the message under
                // Console.app privacy filtering.  e.what() was showing as
                // "<private>" in V12.14.6's caught traces.
                log_error(logFn, "[stitch-bc]",
                          "step8b: warper->warp threw cv::Exception: %s",
                          e.what());
                capturedErrorCode = StitchErrorCode::UnknownCvException;
                capturedErrorMessage = std::string("Warp stage failed: ") + e.what();
                failedInsidePool = true;
                break;
            } catch (...) {
                log_error(logFn, "[stitch-bc]",
                          "step8b: warper->warp threw unknown exception");
                capturedErrorCode = StitchErrorCode::UnknownCvException;
                capturedErrorMessage = "Warp stage failed (unknown).";
                failedInsidePool = true;
                break;
            }
            log_info(logFn, "[stitch-bc]",
                     "step8c: warp loop done mem=%.1fMB", rss_mb());
            // composeFrames has done its job — release before we
            // allocate the float UMat shadow set for seam finding.
            // V12.14.7: most/all of these are already released inside
            // the warp loop above; the .clear() drops the now-empty
            // Mat headers from the vector.
            for (auto& cf : composeFrames) cf.release();
            composeFrames.clear();

            // Step 9: GraphCutSeamFinder at SEAM_MP (~0.1 MP).
            //
            // GraphCut's runtime is roughly quadratic in pixel count
            // because it solves a max-flow on a per-pixel grid graph.
            // Running it at compose scale (1.0 MP) takes ~100× longer
            // than at the ~0.1 MP that cv::Stitcher::PANORAMA uses
            // internally (`seam_est_resol_ = 0.1`).  At 1.0 MP we
            // observed >60s stitch-timeouts in JS; at 0.1 MP it
            // finishes in <1s.  Pattern matches cv::Stitcher's flow:
            //   1. Downscale imagesWarped + masksWarped + corners to
            //      seam scale.
            //   2. Run seam finder on the small images.
            //   3. Upscale the seam-optimised masks back to compose
            //      scale.
            //   4. Bitwise-AND with the original masks so we don't
            //      include pixels outside each frame's warped region.
            const double SEAM_MP = (config.seamEstimationResolMP > 0.0)
                ? config.seamEstimationResolMP : 0.1;
            double seam_scale = std::min(1.0, std::sqrt(SEAM_MP / origMp));
            // Aspect from compose scale → seam scale (the rescale we
            // apply to existing compose-scale data, not the original).
            double seam_compose_aspect = seam_scale / compose_scale;
            {
                auto _t = std::chrono::steady_clock::now();
                double _ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    _t - t0).count();
                log_info(logFn, "[RetaiLensStitcher]",
                         "step9: graph-cut seam finder "
                         "(compose→seam aspect = %.3f, t+%.0fms)",
                         seam_compose_aspect, _ms);
            }
            auto _seamStart = std::chrono::steady_clock::now();
            log_info(logFn, "[stitch-bc]",
                     "step9a: seam-scale resize loop (aspect=%.3f)",
                     seam_compose_aspect);
            std::vector<cv::UMat> imagesWarpedF_seam(N);
            std::vector<cv::UMat> masksWarpedU_seam(N);
            std::vector<cv::Point> corners_seam(N);
            for (size_t i = 0; i < N; i++) {
                cv::Mat seamImage, seamMask;
                cv::resize(imagesWarped[i], seamImage, cv::Size(),
                           seam_compose_aspect, seam_compose_aspect,
                           cv::INTER_LINEAR);
                cv::resize(masksWarped[i], seamMask, cv::Size(),
                           seam_compose_aspect, seam_compose_aspect,
                           cv::INTER_NEAREST);
                seamImage.convertTo(imagesWarpedF_seam[i], CV_32F);
                seamMask.copyTo(masksWarpedU_seam[i]);
                corners_seam[i] = cv::Point(
                    cvRound(corners[i].x * seam_compose_aspect),
                    cvRound(corners[i].y * seam_compose_aspect));
            }
            log_info(logFn, "[stitch-bc]",
                     "step9b: seam-scale resize done, GraphCut find starting");
            cv::Ptr<cv::detail::SeamFinder> seamFinder =
                cv::makePtr<cv::detail::GraphCutSeamFinder>(
                    cv::detail::GraphCutSeamFinder::COST_COLOR);
            seamFinder->find(imagesWarpedF_seam, corners_seam,
                             masksWarpedU_seam);
            log_info(logFn, "[stitch-bc]", "step9c: GraphCut find done");
            {
                auto _t = std::chrono::steady_clock::now();
                double _seamMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    _t - _seamStart).count();
                log_info(logFn, "[RetaiLensStitcher]",
                         "step9: graph-cut find took %.0fms", _seamMs);
            }
            imagesWarpedF_seam.clear();

            // Upscale seam-optimised masks back to compose scale.
            //
            // CRITICAL: dilate each mask before upscaling so adjacent
            // frames have a small OVERLAP region for the blender to
            // feather across.  Without this, the seam-cut creates a
            // strict pixel partition with NO overlap — MultiBand then
            // has nothing to feather, producing visible HARD seams
            // (the "cuts" we observed in the output).  cv::Stitcher
            // does the same dilation step in its compose pipeline.
            // A 3×3 default kernel at seam scale becomes ~10px of
            // overlap at compose scale (since seam_aspect_compose ≈
            // 0.1 → 10× upscale), which is plenty for MultiBand's
            // Laplacian pyramids to blend smoothly across.
            //
            // The bitwise_and with the original mask keeps each frame's
            // mask within its actual warped region (seam-cut + dilation
            // can spill past edges, especially after linear upscale).
            for (size_t i = 0; i < N; i++) {
                cv::Mat seamMaskCpu, seamMaskDilated, seamMaskFull;
                masksWarpedU_seam[i].copyTo(seamMaskCpu);
                cv::dilate(seamMaskCpu, seamMaskDilated, cv::Mat());
                cv::resize(seamMaskDilated, seamMaskFull,
                           masksWarped[i].size(), 0, 0, cv::INTER_LINEAR);
                cv::bitwise_and(seamMaskFull, masksWarped[i], masksWarped[i]);
            }
            masksWarpedU_seam.clear();

            // Feed the blender, releasing each frame as we go.
            log_info(logFn, "[stitch-bc]", "step10a: blender->prepare");
            blender->prepare(corners, sizes);
            log_info(logFn, "[stitch-bc]",
                     "step10b: feeding blender (N=%zu)", N);
            for (size_t i = 0; i < N; i++) {
                log_info(logFn, "[stitch-bc]", "step10c: feed frame %zu", i);
                cv::Mat imgS;
                imagesWarped[i].convertTo(imgS, CV_16S);
                blender->feed(imgS, masksWarped[i], corners[i]);
                imagesWarped[i].release();
                masksWarped[i].release();
                imgS.release();
            }
            imagesWarped.clear();
            masksWarped.clear();
            log_info(logFn, "[stitch-bc]", "step10d: feed loop done");
        } else {
            // ── STREAM path ────────────────────────────────────────────
            // Pre-pass: warp masks ONLY (single-channel, cheap) to
            // compute corners + sizes.  blender->prepare() needs both
            // BEFORE the first feed, so a tiny first pass is unavoidable.
            const size_t N = composeFrames.size();
            std::vector<cv::Point> corners(N);
            std::vector<cv::Size> sizes(N);
            for (size_t i = 0; i < N; i++) {
                cv::Mat K;
                cameras[i].K().convertTo(K, CV_32F);
                cv::Mat mask(composeFrames[i].size(), CV_8U, cv::Scalar(255));
                cv::Mat tmpMaskWarped;
                corners[i] = warper->warp(
                    mask, K, cameras[i].R, cv::INTER_NEAREST,
                    cv::BORDER_CONSTANT, tmpMaskWarped);
                sizes[i] = tmpMaskWarped.size();
            }

            // Main pass: warp + feed + release per frame.  Never holds
            // more than ONE warped image + ONE warped mask in memory.
            // ~40-50 MB lower peak vs the BATCH path at 1.0 MP × 8
            // frames — the difference between staying under iOS' jetsam
            // threshold on a 2 GB device and getting WatchdogTermination.
            blender->prepare(corners, sizes);
            for (size_t i = 0; i < N; i++) {
                cv::Mat K;
                cameras[i].K().convertTo(K, CV_32F);
                cv::Mat mask(composeFrames[i].size(), CV_8U, cv::Scalar(255));
                cv::Mat imgWarped, maskWarped;
                warper->warp(composeFrames[i], K, cameras[i].R,
                             cv::INTER_LINEAR, cv::BORDER_CONSTANT, imgWarped);
                warper->warp(mask, K, cameras[i].R, cv::INTER_NEAREST,
                             cv::BORDER_CONSTANT, maskWarped);
                cv::Mat imgS;
                imgWarped.convertTo(imgS, CV_16S);
                blender->feed(imgS, maskWarped, corners[i]);
                // Release the input compose frame too — done with it.
                composeFrames[i].release();
                // imgS / imgWarped / maskWarped release at scope exit.
            }
            composeFrames.clear();
        }

        cv::Mat panoramaS, panoramaMask;
        log_info(logFn, "[stitch-bc]", "step11a: blender->blend starting");
        blender->blend(panoramaS, panoramaMask);
        log_info(logFn, "[stitch-bc]",
                 "step11b: blend complete (panoramaS=%dx%d)",
                 panoramaS.cols, panoramaS.rows);
        panoramaS.convertTo(panorama, CV_8U);
        {
            auto _t = std::chrono::steady_clock::now();
            double _ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                _t - t0).count();
            log_info(logFn, "[RetaiLensStitcher]",
                     "step11: blend complete (output %d×%d, t+%.0fms)",
                     panorama.cols, panorama.rows, _ms);
        }
        log_info(logFn, "[stitch-bc]",
                 "step11c: panorama 8U conversion done (panorama=%dx%d) mem=%.1fMB",
                 panorama.cols, panorama.rows, rss_mb());

        // Record retained-frame count for telemetry.  In the high-level
        // path this comes from stitcher->component().size() after retry;
        // in the manual path it's whatever leaveBiggestComponent kept.
        result.framesIncluded = static_cast<int32_t>(cameras.size());
        // Manual path doesn't loop over confidence thresholds — it
        // does ONE pass through leaveBiggestComponent at 1.0.  Report
        // 1.0 for parity with the high-level path's telemetry.
        result.finalConfidenceThresh = 1.0;
    } catch (const cv::Exception& e) {
        // Top-level catch: anything inside the pipeline that wasn't
        // caught by a stage-specific try/catch lands here.  Capture
        // into a strong local + break out of the do/while(0) wrapper.
        capturedErrorCode = StitchErrorCode::UnknownCvException;
        capturedErrorMessage = std::string("OpenCV exception during stitch: ") + e.what();
        failedInsidePool = true;
        break;
    } catch (const std::exception& e) {
        capturedErrorCode = StitchErrorCode::UnknownCvException;
        capturedErrorMessage = std::string("std exception during stitch: ") + e.what();
        failedInsidePool = true;
        break;
    } catch (...) {
        capturedErrorCode = StitchErrorCode::UnknownCvException;
        capturedErrorMessage = "Unknown exception during stitch.";
        failedInsidePool = true;
        break;
    }
    } while (0);

    // V16 fix-10 — handle failure paths captured from inside the pool.
    //
    // HISTORY (V16 fix-10, 2026-05-13): in the iOS original, the
    // closing @autoreleasepool brace USED to live at the very bottom
    // of the function, wrapping the return statement as well.  ARC
    // inserts an autorelease for the return value, which then
    // registered with this @autoreleasepool; the pool drained at the
    // closing brace, deallocating the return object BEFORE the
    // caller could `objc_retain` it.
    //
    // Fix-10 restructure: every failure path captures its return
    // value into a STRONG LOCAL declared above the pool
    // (`result`/`capturedError`) and `break`s out of the do/while(0)
    // wrapper to fall past the pool's closing brace cleanly.  The
    // strong locals survive the drain.
    //
    // In the pure-C++ port there is no @autoreleasepool — the
    // do/while(0) wrapper is kept purely for control-flow parity with
    // the iOS original.  C++ stack-locals have proper RAII lifetimes
    // so the drain UAF is impossible.
    //
    // See docs/site-content/learnings/react-native.md#autoreleasepool-return-uaf
    if (sentinelInsidePool || failedInsidePool) {
        result.errorCode = capturedErrorCode;
        result.errorMessage = capturedErrorMessage;
        const auto t1 = std::chrono::steady_clock::now();
        result.durationMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            t1 - t0).count();
        return result;
    }

    if (panorama.empty()) {
        result.errorCode = StitchErrorCode::UnknownCvException;
        result.errorMessage = "Stitcher produced an empty panorama.";
        return result;
    }

    // Crop the panorama to the bounding box of non-black pixels.
    //
    // The default SphericalWarper from PANORAMA mode lays the
    // captured patch into a much larger sphere-shaped canvas.  For
    // a typical 30-45° shelf-scan arc, that means the actual scene
    // occupies a small region of a much larger black-bordered
    // image (the "panorama bowl" effect).  Cropping to the
    // content's bounding box returns the actual stitched scene
    // without the surrounding empty bowl.  Algorithm:
    //   1. Convert to grayscale.
    //   2. Threshold > 1 to find any non-black pixel.
    //   3. boundingRect of all non-zero pixels.
    //   4. Crop the panorama to that rect.
    //
    // V16 Phase 1b.fix3 — maximum-inscribed-rectangle crop (was bbox).
    // cv::Stitcher's compose stage produces irregular black corners
    // where the warped frames didn't fill; cv::boundingRect was
    // including those.  MaxInscribedRectFromMask finds the largest
    // axis-aligned rectangle entirely inside the non-zero region —
    // clean output with no black corners.  Falls back to bbox
    // (and ultimately the un-cropped panorama) on any OpenCV failure.
    //
    // V16 Phase 1b.fix5 — RCA from Ram's first fix3 capture: the
    // raw inscribed-rect collapsed to a thin sliver in the
    // landscape output.  Cause: cv::Stitcher's compose produces
    // small scattered zero-pixels INSIDE the content region (graph-
    // cut seam, exposure-comp rounding, multi-band blend artifacts).
    // The inscribed-rect algorithm demands a strictly hole-free
    // rectangle, so a single interior zero forces it to either
    // avoid that pixel (collapsing to a thin strip) or skip the
    // affected row entirely.  Python simulation on a realistic
    // 800×200 mask with 0.5% scattered holes:
    //
    //     raw inscribed-rect    →   23×100 = 1.4% of original (BUG)
    //     after 5×5 close       → 642×196 = 78.6% of original (clean)
    //     bounding rect          → 800×200 = 100%
    //
    // Fix: morphologically CLOSE the mask before the inscribed-rect
    // search — a 5×5 close fills holes ≤5 px (more than enough for
    // compose artifacts) without bridging across legitimate concave
    // gaps (which cv::Stitcher panoramas don't really have).  Keep
    // the bbox safety floor: if the inscribed rect still came out
    // < 50% of bbox area, use bbox — the mask shape is pathological
    // and shipping bbox-with-corners is better than a sliver.
    cv::Mat finalImage = panorama;
    try {
        cv::Mat gray;
        cv::cvtColor(panorama, gray, cv::COLOR_BGR2GRAY);
        cv::Mat mask;
        cv::threshold(gray, mask, 1, 255, cv::THRESH_BINARY);

        // V16 Phase 1b.fix5c — operator-toggleable crop strategy.
        //
        //   useInscribedRectCrop = NO (default in settings modal):
        //     Final crop is just cv::boundingRect(mask) — preserves all
        //     stitched content at the cost of possible black corners
        //     where cv::Stitcher's projection didn't fill.
        //
        //   useInscribedRectCrop = YES (operator opt-in):
        //     Run the full inscribed-rect pipeline (morph-close + 50%
        //     safety floor + column-projection second pass) for a clean
        //     -cornered rectangle.  Can over-aggressively shrink the
        //     output on lopsided masks (1146×1102 bbox → 602×1102 strip
        //     in one field log).
        cv::Rect bbox;
        if (config.useInscribedRectCrop) {
            cv::Mat closedMask;
            cv::morphologyEx(
                mask, closedMask, cv::MORPH_CLOSE,
                cv::getStructuringElement(cv::MORPH_RECT, cv::Size(5, 5)));
            bbox = maxInscribedRectFromMask(closedMask);
            cv::Rect bboxFallback = cv::boundingRect(mask);
            const long long inscribedArea =
                (long long)bbox.width * bbox.height;
            const long long fallbackArea =
                (long long)bboxFallback.width * bboxFallback.height;
            if (bbox.width <= 0 || bbox.height <= 0
                || inscribedArea * 2 < fallbackArea) {
                // Either degenerate, or inscribed < 50% of bbox area.
                // Safety floor: ship bbox so the operator gets *something*
                // usable (legacy behaviour pre-fix3) rather than a sliver.
                log_info(logFn, "[RetaiLensStitcher]",
                         "inscribed-rect rejected: "
                         "%dx%d (area=%lld) vs bbox %dx%d (area=%lld); "
                         "using bbox fallback.",
                         bbox.width, bbox.height, inscribedArea,
                         bboxFallback.width, bboxFallback.height, fallbackArea);
                bbox = bboxFallback;
            } else {
                log_info(logFn, "[RetaiLensStitcher]",
                         "inscribed-rect: %dx%d "
                         "(area=%lld, %.0f%% of bbox %dx%d)",
                         bbox.width, bbox.height, inscribedArea,
                         100.0 * (double)inscribedArea / (double)fallbackArea,
                         bboxFallback.width, bboxFallback.height);
            }
        } else {
            bbox = cv::boundingRect(mask);
            log_info(logFn, "[RetaiLensStitcher]",
                     "crop: bbox-only %dx%d "
                     "(useInscribedRectCrop=NO via setting)",
                     bbox.width, bbox.height);
        }
        if (bbox.width > 0 && bbox.height > 0
            && bbox.width <= panorama.cols && bbox.height <= panorama.rows) {
            finalImage = panorama(bbox).clone();
        }

        // V16 Phase 1b.fix5c — column-projection second pass ALSO gated
        // on the inscribed-rect toggle.  When OFF, skip directly to the
        // write so the operator sees the full bbox-cropped panorama
        // without further trimming.  When ON, keep the existing
        // 95%-then-80%-then-skip relaxation chain.
        if (config.useInscribedRectCrop) {
            // Second pass: rectangular crop.  Find the column range where
            // ≥95% of rows have content, crop to that × full height.
            cv::Mat finalGray;
            cv::cvtColor(finalImage, finalGray, cv::COLOR_BGR2GRAY);
            cv::Mat finalMask;
            cv::threshold(finalGray, finalMask, 30, 255, cv::THRESH_BINARY);
            cv::erode(finalMask, finalMask,
                      cv::getStructuringElement(cv::MORPH_RECT, cv::Size(5, 5)),
                      cv::Point(-1, -1), 1);

            int rows = finalMask.rows, cols = finalMask.cols;
            // Reduce mask to per-column content count.  Mask is 0 or 255,
            // so column sum / 255 = number of content rows in that column.
            cv::Mat colSum;
            cv::reduce(finalMask, colSum, 0, cv::REDUCE_SUM, CV_32S);
            const int contentThreshold = (int)(0.95 * rows * 255);
            int cropLeft = -1, cropRight = -1;
            const int* cs = colSum.ptr<int>(0);
            for (int c = 0; c < cols; c++) {
                if (cs[c] >= contentThreshold) {
                    if (cropLeft < 0) cropLeft = c;
                    cropRight = c;
                }
            }
            log_info(logFn, "[RetaiLensStitcher]",
                     "rectCrop col-proj: cols=%d rows=%d threshold=%d cropLeft=%d cropRight=%d",
                     cols, rows, contentThreshold, cropLeft, cropRight);
            // Sanity floor: don't accept a column-projection crop that
            // shrinks the image to less than 30% of the bbox-cropped width.
            // Such an aggressive crop usually means the stitch was poorly
            // aligned and only a tiny vertical band has full multi-frame
            // coverage — applying it produces the "thin sliver" output
            // we observed in the field.  Better to show the user the full
            // bounding-box crop (still trims the all-black borders) than
            // a sliver that's effectively useless.
            const int minRectWidth = (int)(cols * 0.30);
            if (cropLeft >= 0 && cropRight > cropLeft + 10
                && (cropRight - cropLeft + 1) >= minRectWidth) {
                cv::Rect rectCrop(cropLeft, 0,
                                  cropRight - cropLeft + 1, rows);
                finalImage = finalImage(rectCrop).clone();
                log_info(logFn, "[RetaiLensStitcher]",
                         "rectCrop applied: %dx%d → %dx%d",
                         cols, rows, finalImage.cols, finalImage.rows);
            } else {
                // No column qualified at 95%, OR the qualifying band is too
                // narrow to trust.  Try a relaxed 80% before giving up.
                const int relaxedThreshold = (int)(0.80 * rows * 255);
                cropLeft = -1;
                cropRight = -1;
                for (int c = 0; c < cols; c++) {
                    if (cs[c] >= relaxedThreshold) {
                        if (cropLeft < 0) cropLeft = c;
                        cropRight = c;
                    }
                }
                log_info(logFn, "[RetaiLensStitcher]",
                         "rectCrop relaxed (80%%): cropLeft=%d cropRight=%d",
                         cropLeft, cropRight);
                if (cropLeft >= 0 && cropRight > cropLeft + 10
                    && (cropRight - cropLeft + 1) >= minRectWidth) {
                    cv::Rect rectCrop(cropLeft, 0,
                                      cropRight - cropLeft + 1, rows);
                    finalImage = finalImage(rectCrop).clone();
                    log_info(logFn, "[RetaiLensStitcher]",
                             "rectCrop relaxed applied: %dx%d → %dx%d",
                             cols, rows, finalImage.cols, finalImage.rows);
                } else {
                    log_info(logFn, "[RetaiLensStitcher]",
                             "rectCrop SKIPPED — best band is "
                             "narrower than 30%% of bbox (%d < %d).  Likely poor "
                             "stitch alignment; keeping bbox crop.",
                             cropRight >= 0 ? (cropRight - cropLeft + 1) : 0,
                             minRectWidth);
                }
            }
        }
    } catch (...) {
        // Crop failed — fall back to the raw stitched output.
        finalImage = panorama;
    }

    // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
    //
    // Bake-rotation driven by the user's phone-hold orientation at
    // capture start, NOT the output Mat's aspect ratio.  Reasoning:
    //
    //   - fix5d's earlier attempt to key off the same orientation used
    //     `exifOrientation:NSInteger` (an EXIF tag 1/3/6/8), inferred
    //     from frameRotationDegrees, which collapsed landscape-left
    //     and landscape-right to the same value.  Ram's reports made
    //     it clear the two landscape variants need OPPOSITE rotations
    //     (they're mirror images of each other w.r.t. the sensor's
    //     world-up direction), so the EXIF-tag intermediary was lossy.
    //
    //   - fix5e's aspect-ratio approach was correct for 3+ frame
    //     horizontal pans but the threshold "cols > rows" was fragile
    //     at 2 frames (output Mat near-square or even tall) and
    //     conflated "wide because horizontal pan" with "tall because
    //     vertical pan."  The user spec explicitly lists two modes;
    //     using their classification is more robust than guessing
    //     from output geometry.
    //
    // The two supported modes:
    //
    //   Mode A — landscape phone + vertical pan from top
    //     landscape-left  → ROTATE_90_COUNTERCLOCKWISE
    //     landscape-right → ROTATE_90_CLOCKWISE
    //       (mirror-image directions because world-up sits on opposite
    //        sensor edges between landscape-left and landscape-right;
    //        opposite rotations land world-up at output-top for both)
    //
    //   Mode B — portrait phone + horizontal pan from left
    //     portrait              → no rotation (cv::Stitcher's natural
    //                              output already aligns world-up to
    //                              output-top for portrait hold)
    //     portrait-upside-down  → ROTATE_180
    //
    // Anything else: best-effort no rotation.  Unsupported combination
    // (e.g., portrait phone + vertical pan) is treated as Mode B.
    //
    // Properties:
    //   - Compose canvas geometry unchanged from baseline 437c763:
    //     cv::imread default applies EXIF rotation at load time,
    //     producing portrait Mats for portrait hold and landscape
    //     Mats for landscape hold.  No fix5b-style 6-frame OOM.
    //   - Output JPEG always EXIF=1 in the iOS original (ImageIO
    //     writer with kCGImagePropertyOrientation=1).  In the shared
    //     port we use cv::imwrite which doesn't write EXIF — the
    //     pixels are already rotated correctly, so the visual result
    //     matches.  See TODO[shared-stitcher-port-part-2] for a
    //     proper EXIF-aware writer if iOS callers report viewers
    //     that ignore the pixel rotation.
    //   - The cv::rotate happens AFTER BA / blend / seam-find when
    //     their working sets are released — incremental memory cost.
    //   - Per-keyframe JPEGs (OpenCVKeyframeCollector) untouched —
    //     they still carry EXIF=6 so LiveFrameStrip thumbnails show
    //     portrait-correct during capture.
    //
    // Empirically calibrated (Ram's 2026-05-11 test, iteration 2):
    // Iteration 1 swapped both the labels AND the directions — net
    // visual rotation per roll-value was unchanged (output still
    // looked "landscape-left oriented" to Ram).  Iteration 2 flips
    // ONLY the directions; labels stay where they landed.
    //   landscape-left  (roll ≈ -90°, Ram's L-left hold)  → 90° CCW
    //   landscape-right (roll ≈ +90°, Ram's L-right hold) → 90° CW
    // For a roll=-90° capture (what Ram tested), this rotates the
    // OPPOSITE direction from iteration 1.  If iteration 1 put
    // scene-up on the LEFT of the tall image, iteration 2 will put
    // scene-up on the RIGHT.
    cv::Mat finalImageRotated = bake_rotation(finalImage,
                                              config.captureOrientation,
                                              logFn);

    // Encode + write the JPEG.  Clamp quality into [0, 100] to defend
    // against caller bugs.
    //
    // V16 Phase 1b.fix3 (iOS original) — write via ImageIO so we can
    // bake the EXIF Orientation tag into the output.  cv::imwrite
    // produces a plain JPEG with no metadata.  In the shared port we
    // rely on `bake_rotation` rotating pixels in-place above, so the
    // EXIF tag is unnecessary for correct display — kept as a TODO
    // below in case downstream consumers expect EXIF=1.
    const int q = std::max(0, std::min(100, config.jpegQuality));
    std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, q};
    bool wrote = false;
    try {
        wrote = cv::imwrite(outputPath, finalImageRotated, params);
    } catch (const cv::Exception& e) {
        result.errorCode = StitchErrorCode::ImageWriteFailed;
        result.errorMessage = std::string("cv::imwrite threw: ") + e.what();
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }
    if (!wrote) {
        result.errorCode = StitchErrorCode::ImageWriteFailed;
        result.errorMessage = "Stitch succeeded but could not write JPEG to " + outputPath;
        log_error(logFn, "[stitch]", "%s", result.errorMessage.c_str());
        return result;
    }

    // V16 Phase 1b.fix5d — report the dimensions of the bytes we
    // actually wrote (rotated, if we baked one in above), not the
    // pre-rotate Mat.  JS-side consumers need the displayable shape.
    const auto t1 = std::chrono::steady_clock::now();
    result.success                = true;
    result.errorCode              = StitchErrorCode::Ok;
    result.width                  = finalImageRotated.cols;
    result.height                 = finalImageRotated.rows;
    result.durationMs             = std::chrono::duration_cast<std::chrono::milliseconds>(
                                       t1 - t0).count();
    return result;
}

}  // namespace retailens
