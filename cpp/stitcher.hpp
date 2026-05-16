// SPDX-License-Identifier: UNLICENSED
//
// stitcher.hpp — shared cv::Stitcher orchestration used by both
// iOS (via Obj-C++ bridge in OpenCVStitcherBridge.mm) and Android
// (via JNI in retailens_stitcher.cpp).
//
// Why this exists
// ───────────────
//
// Before 2026-05-15, iOS had a hand-rolled cv::detail::* pipeline
// (~3,000 lines in OpenCVStitcher.mm) while Android used the
// high-level cv::Stitcher::create() API (~600 lines in
// retailens_stitcher.cpp).  Two implementations of the same algorithm
// drifted independently — fixes landed on one platform and didn't on
// the other.  This file collapses that into a single source of truth.
//
// V1 scope (this commit): port the Android high-level pipeline
// verbatim into shared C++ + add the C+D progressive-confidence retry
// loop + dimension/memory instrumentation.  Both platforms call this.
//
// V2 scope (follow-up): port iOS's manual cv::detail::* pipeline
// features (explicit leaveBiggestComponent retry around
// just the prune step rather than the whole stitch — 5-10× cheaper;
// wave correction; exposure compensator) into this file as a
// SECOND code path selectable via StitchConfig::useManualPipeline.
// Until then, iOS gets the Android-level capability set.
//
// API design
// ──────────
//
// One function: stitchFramePaths(framePaths, outputPath, config).
//
// All inputs marshalled as primitive C++ types.  Output is a
// StitchResult struct that carries success/error info + the C+D
// drop-count telemetry.  Loggin happens via an optional callback so
// the iOS bridge can plumb to os_log and the Android bridge to
// __android_log_print — same source, different sink.
//
// Threading: not thread-safe.  Caller must serialise.  Each
// invocation is independent (no shared mutable state).

#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>


namespace retailens {

// Stable error codes.  Mirror the JS-side `StitchErrorCode` enum so
// the bridge layers can map these to NSError.code / Java throwable
// without translation tables.
//
// Bit-for-bit aligned to cv::Stitcher::Status values where possible
// (NeedMoreImages, HomographyEstimationFailed, CameraParamsAdjustFailed)
// + a few new codes for failure modes that cv::Stitcher itself
// doesn't surface (image read/write failure, all-frames-dropped).
enum class StitchErrorCode : int32_t {
    Ok                          = 0,
    NeedMoreImages              = 1,  // cv::Stitcher::ERR_NEED_MORE_IMGS
    HomographyEstimationFailed  = 2,  // cv::Stitcher::ERR_HOMOGRAPHY_EST_FAIL
    CameraParamsAdjustFailed    = 3,  // cv::Stitcher::ERR_CAMERA_PARAMS_ADJUST_FAIL
    ImageReadFailed             = 100,
    ImageWriteFailed            = 101,
    AllFramesDroppedByConfidence = 102,
    InvalidArgument             = 200,
    UnknownCvException          = 300,
};


// Stitcher mode selector — maps to cv::Stitcher::Mode.
//
//   Panorama: rotation-only (spherical/cylindrical/plane warper +
//             BundleAdjusterRay + BestOf2NearestMatcher).  Best for
//             rotate-in-place captures.
//   Scans:    affine (plane warper + BundleAdjusterAffine +
//             AffineBestOf2NearestMatcher).  Best for shelf-pan
//             translation captures.
//
// Caller (typically the JS engineMode resolver) picks per capture.
// "auto" resolution happens UPSTREAM in JS via accumulated
// translation vs rotation totals from the KeyframeGate — by the
// time we get here, it's a concrete mode.
enum class StitchMode : int32_t {
    Panorama = 0,
    Scans    = 1,
};


// Configuration bundle for a single stitch invocation.  All fields
// have safe defaults so callers only override what they care about.
//
// Resolution budgets (`*ResolMP`) are in megapixels per frame:
//   < 0.0  → keep cv::Stitcher's library default
//   ≥ 0.0  → cap at this MP target via cv::Stitcher::set*Resol()
//
// The compositingResolMP default of 1.0 is THE important non-cv-
// default knob: cv::Stitcher's library default for compositing is
// ORIG_RESOL (-1.0) which composes at full sensor resolution and
// trivially OOMs on Android.  Always cap compositing.
struct StitchConfig {
    std::string warperType           = "plane";        // "plane"|"cylindrical"|"spherical"
    std::string blenderType          = "multiband";    // "multiband"|"feather"
    std::string seamFinderType       = "graphcut";     // "graphcut"|"skip"|"voronoi"
    StitchMode  stitchMode           = StitchMode::Panorama;
    std::string captureOrientation   = "portrait";     // "portrait"|"portrait-upside-down"|"landscape-left"|"landscape-right"
    bool        useInscribedRectCrop = false;          // bbox-only crop is the default
    double      registrationResolMP  = -1.0;           // < 0 = cv default (0.6 MP)
    double      seamEstimationResolMP = -1.0;          // < 0 = cv default (0.1 MP)
    double      compositingResolMP   = 1.0;            // 1.0 MP cap — THE OOM fix
    int         jpegQuality          = 85;

    // Manual-pipeline opt-in (V2 of the shared port).
    //
    // Set true to route stitchFramePaths() through the hand-rolled
    // cv::detail::* pipeline implemented in stitchFramePathsManual()
    // instead of the high-level cv::Stitcher::create() wrapper.  The
    // manual pipeline gives finer control that the high-level API
    // hides behind defaults that don't fit our shelf-pan capture
    // shape:
    //
    //   * Seam finder runs at a SEPARATE seam-MP budget (~0.1 MP
    //     default) and the seam mask is upscaled back to compose-MP
    //     before feeding the blender.  GraphCut is roughly O(N²) in
    //     pixels — running it at compose-MP (1.0 MP) costs ~100× more
    //     than at seam-MP and was timing out finalize() in JS.
    //
    //   * MultiBandBlender's Laplacian pyramid is built at compose-MP
    //     directly (rather than re-warping from features-resolution
    //     work frames).  Cylindrical-era sharpness restored on iOS.
    //
    //   * leaveBiggestComponent runs at PRUNE granularity (i.e., the
    //     retry happens BEFORE the expensive BA / warp / blend), not
    //     around the whole pipeline.  Retry cost is 5-10× cheaper than
    //     the high-level cv::Stitcher's C+D loop that re-runs every
    //     stage at each threshold.
    //
    //   * Explicit BundleAdjusterRay + wave correction + median focal
    //     length scale determination — all features cv::Stitcher does
    //     internally but with parameters we can't override (iter cap,
    //     wave-correct kind, confidence threshold).
    //
    // Android currently leaves this false (the high-level pipeline
    // works fine on Android's pre-V16 keyframe budgets).  iOS will
    // flip it to true once the manual port is verified — separate
    // commit from this V2 introduction.
    bool        useManualPipeline    = false;
};


// Result returned to the caller.  On success: outputPath written +
// dimensions + C+D telemetry.  On failure: errorCode + errorMessage
// (errorCode is the primary signal; message is human-readable).
struct StitchResult {
    bool             success         = false;
    StitchErrorCode  errorCode       = StitchErrorCode::UnknownCvException;
    std::string      errorMessage;

    int32_t  width                   = 0;
    int32_t  height                  = 0;

    // C+D telemetry — filled in even on success.  See
    // 2026-05-15 commit 57ecccd for context.
    int32_t  framesRequested         = 0;
    int32_t  framesIncluded          = 0;
    double   finalConfidenceThresh   = -1.0;  // The threshold value that succeeded; -1 if not relevant.

    int64_t  durationMs              = 0;
};


// Logging callback type — bridge layers plug their platform logger
// (os_log on iOS, __android_log_print on Android).  Use nullptr to
// silence.
//
//   level: 0=info, 1=warn, 2=error
//   tag:   short tag like "[stitch]" or "[dimstat]"
//   msg:   the formatted message (caller must format before passing)
using LogFn = std::function<void(int level, const char* tag, const char* msg)>;


// Primary entry point.  Loads input JPEGs, configures cv::Stitcher
// per the config, runs the C+D progressive-confidence retry loop,
// crops, bake-rotates, writes the output JPEG.
//
// When `config.useManualPipeline` is true the call is routed to
// `stitchFramePathsManual()` instead — see below for the manual
// pipeline's structural differences.
//
// Thread-safe per-call (no shared state); caller must serialise
// concurrent calls.
//
// On failure (StitchResult::success == false) the output file is
// not written.  errorCode + errorMessage tell why.
StitchResult stitchFramePaths(
    const std::vector<std::string>& framePaths,
    const std::string&              outputPath,
    const StitchConfig&             config,
    LogFn                           logFn = nullptr);


// Manual cv::detail::* pipeline entry point.  Same input/output
// contract as stitchFramePaths(), but uses the hand-rolled stitching
// pipeline ported from OpenCVStitcher.mm (ORB → BestOf2NearestMatcher
// → HomographyBasedEstimator → BundleAdjusterRay → wave correct →
// median-focal warper scale → two-stage resolution (registration_MP
// / compose_MP) → GraphCutSeamFinder at seam_MP → MultiBandBlender).
//
// Use via config.useManualPipeline = true to get this entry point
// indirectly from stitchFramePaths().  Also callable directly if a
// future caller wants to bypass the high-level wrapper entirely.
//
// Thread-safe per-call (no shared state); caller must serialise
// concurrent calls.
//
// On failure (StitchResult::success == false) the output file is
// not written.  errorCode + errorMessage tell why.
StitchResult stitchFramePathsManual(
    const std::vector<std::string>& framePaths,
    const std::string&              outputPath,
    const StitchConfig&             config,
    LogFn                           logFn = nullptr);

}  // namespace retailens
