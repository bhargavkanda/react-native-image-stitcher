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
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/stitching.hpp>
#include <opencv2/stitching/detail/blenders.hpp>
#include <opencv2/stitching/detail/seam_finders.hpp>
#include <opencv2/stitching/warpers.hpp>

#include <chrono>
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

}  // namespace


StitchResult stitchFramePaths(
    const std::vector<std::string>& framePaths,
    const std::string&              outputPath,
    const StitchConfig&             config,
    LogFn                           logFn)
{
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

}  // namespace retailens
