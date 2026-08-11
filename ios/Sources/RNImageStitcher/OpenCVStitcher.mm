// SPDX-License-Identifier: Apache-2.0
//
// OpenCVStitcher.mm
//
// Objective-C++ implementation that wraps cv::Stitcher.  This is the
// only file in the SDK that includes <opencv2/...> — everything else
// sees the slim `OpenCVStitcher.h` interface above and stays in
// Swift / Objective-C.
//
// History note (V12 → V16 → 2026-05-16 shared-C++ port):
//   V12-era this file used `cv::Stitcher::SCANS` mode (translational,
//   plane warp, ORB).  V16 fix-11 reverted that to PANORAMA after
//   discovering the AffineBestOf2NearestMatcher swap broke the
//   warper/blender pipeline coherence (see learning doc
//   `stitcher-pipeline-coherence`).  2026-05-15 reintroduced SCANS
//   as one of two modes selected per-capture via the shared
//   `StitchMode` enum in `cpp/stitcher.hpp` (translation-heavy
//   captures → SCANS; rotation-heavy → PANORAMA; auto-resolved by
//   the KeyframeGate's accumulated motion totals).
//   2026-05-16 commit 98b1a60 swapped this method body to delegate
//   to the shared C++ at `cpp/stitcher.cpp` — both modes now live
//   there, this file is just the Obj-C++ marshalling shim.
//
// References:
//   * OpenCV docs: https://docs.opencv.org/4.x/d2/d8d/classcv_1_1Stitcher.html
//   * Mode-selection design: docs/site-content/design/2026-05-13-stitch-pipeline-mode-selection.md
//   * Pipeline coherence learning: docs/site-content/learnings/2026-05-13-stitcher-pipeline-coherence.md

// OpenCV's stitching headers contain `enum { NO, ... }` and `enum { YES, ... }`
// definitions.  Objective-C's `<objc/objc.h>` (transitively imported by every
// Cocoapods prefix.pch) #defines `NO` and `YES` as macros for the boolean
// constants — by the time OpenCV's enum is parsed, the preprocessor has
// already eaten those identifiers and the build dies with "expected
// identifier".  Undef both BEFORE importing opencv2/*.  This is the
// standard pattern used by every ObjC++ ↔ OpenCV bridge.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#import <opencv2/opencv.hpp>
#import <opencv2/stitching.hpp>
#import <opencv2/imgcodecs.hpp>
#import <chrono>
#import <vector>
#import <string>

// Now that OpenCV is parsed, restore the ObjC macros + import the
// Foundation/UIKit deps the rest of this file uses.
#define NO  ((BOOL)0)
#define YES ((BOOL)1)

#import "OpenCVStitcher.h"
// Phase 2 shared-stitcher port (2026-05-16): stitchFramePaths now
// delegates to the cross-platform C++ pipeline in cpp/stitcher.cpp.
// The header lives in the SDK's `cpp/` dir and is on the pod's
// HEADER_SEARCH_PATHS (see RNImageStitcher.podspec).
#import "stitcher.hpp"
// item-7 cropToQuad: the OpenCV-free quad geometry (quadDstRect /
// isQuadAcceptable) + the shared canvas OOM guard.  Same `cpp/`
// HEADER_SEARCH_PATHS as stitcher.hpp.
#import "crop_quad.hpp"
#import "warp_guard.hpp"
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <os/log.h>
// V16 Phase 1b.fix3 — ImageIO for EXIF Orientation tag on output
// panorama JPEG.
#import <ImageIO/ImageIO.h>
#import <mach/mach.h>
#import <mach/task.h>
#import <mach/task_info.h>

// V12.14.2 — dedicated os_log subsystem for the stitcher.  os_log
// with OS_LOG_TYPE_FAULT survives Console.app's rate-limit cap that
// drops bursts of NSLog calls — Ram's V12.14 trace had Run 2's
// extractFrames + loadFrames + step1 entirely missing, only the
// step2-5 enter cluster surviving.  We use FAULT level for SENTINEL
// breadcrumbs that MUST be visible (start of stitch, BA call site,
// any catch-all for the BA crash).
static os_log_t StitcherDiagLog(void) {
    static os_log_t log = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        log = os_log_create("com.tiger.retailens.sdk", "stitch");
    });
    return log;
}

// V12.14.7 — resident memory probe for jetsam diagnosis.  Returns
// the process' resident_size in MB.  When stitch fails with cv::Exception
// AND the app subsequently dies (V12.14.6 trace pattern: throw caught
// → app quits), iOS jetsam OOM-kill is the prime suspect.  Logging
// resident_size before/after each pipeline stage lets us correlate
// the kill with a memory growth pattern across successive captures.
static double StitcherResidentMB(void) {
    task_vm_info_data_t info;
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    kern_return_t kr = task_info(mach_task_self(), TASK_VM_INFO,
                                 (task_info_t)&info, &count);
    if (kr != KERN_SUCCESS) return -1.0;
    // phys_footprint is what jetsam evaluates against; resident_size
    // is what `ps`/Xcode shows.  We log both via the same helper for
    // correlation — phys_footprint is the one that matters for survival.
    return (double)info.phys_footprint / (1024.0 * 1024.0);
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
static cv::Rect MaxInscribedRectFromMask(const cv::Mat &mask) {
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
        const uchar *m = mask.ptr<uchar>(row);
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

// v0.15 — fill interior holes of a content mask so that ONLY black
// connected to the image BORDER (the never-covered projection wedges)
// stays excluded.  Dark image content (unlit furniture, shadow) forms
// INTERIOR holes surrounded by content — those are filled back in.
// This is the pixel-based proxy for true frame coverage, which the
// shared high-level cv::Stitcher path doesn't expose.
static cv::Mat FillBorderConnectedHoles(const cv::Mat &mask) {
    // Pad a 1px black border so the exterior is one connected region,
    // then flood the border-connected black to white from the corner.
    cv::Mat padded;
    cv::copyMakeBorder(mask, padded, 1, 1, 1, 1, cv::BORDER_CONSTANT, cv::Scalar(0));
    cv::floodFill(padded, cv::Point(0, 0), cv::Scalar(255));
    cv::Mat exterior = padded(cv::Rect(1, 1, mask.cols, mask.rows));
    // Pixels still 0 after the flood are interior holes (never reached
    // from the border) → real content to keep.
    cv::Mat holes;
    cv::bitwise_not(exterior, holes);
    cv::Mat filled;
    cv::bitwise_or(mask, holes, filled);
    return filled;
}


// V16 Phase 1b.fix3 — write a cv::Mat (BGR) as a JPEG with an EXIF
// Orientation tag, via ImageIO.  iOS image renderers (UIImage,
// RN's <Image>, Files.app, Photos) honour the tag; cv::imread with
// IMREAD_IGNORE_ORIENTATION returns raw landscape pixels.  Mirrors
// the helper of the same name in OpenCVKeyframeCollector.mm — kept
// duplicated rather than refactored to a shared header per the
// codebase convention ("duplicate stage code, DRY when proven").
static BOOL WriteJPEGWithEXIFTag(const cv::Mat &bgr,
                                  NSString *path,
                                  NSInteger exifOrientation,
                                  NSInteger quality) {
    if (bgr.empty()) return NO;

    cv::Mat rgba;
    cv::cvtColor(bgr, rgba, cv::COLOR_BGR2RGBA);

    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGBitmapInfo bitmapInfo =
        kCGBitmapByteOrderDefault | kCGImageAlphaNoneSkipLast;
    CGContextRef ctx = CGBitmapContextCreate(
        rgba.data,
        (size_t)rgba.cols,
        (size_t)rgba.rows,
        8,
        (size_t)rgba.step,
        colorSpace,
        bitmapInfo);
    if (!ctx) {
        CGColorSpaceRelease(colorSpace);
        return NO;
    }
    CGImageRef cgImage = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    CGColorSpaceRelease(colorSpace);
    if (!cgImage) return NO;

    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageDestinationRef dst = CGImageDestinationCreateWithURL(
        (__bridge CFURLRef)url,
        CFSTR("public.jpeg"),
        1,
        NULL);
    if (!dst) {
        CGImageRelease(cgImage);
        return NO;
    }

    NSInteger q = MAX(0, MIN(100, quality));
    NSInteger exif = (exifOrientation >= 1 && exifOrientation <= 8)
        ? exifOrientation : 1;
    NSDictionary *props = @{
        (id)kCGImageDestinationLossyCompressionQuality:
            @((double)q / 100.0),
        (id)kCGImagePropertyOrientation: @(exif),
    };
    CGImageDestinationAddImage(
        dst, cgImage, (__bridge CFDictionaryRef)props);
    BOOL ok = CGImageDestinationFinalize(dst);
    CFRelease(dst);
    CGImageRelease(cgImage);
    return ok;
}


NSString *const RNImageStitcherErrorDomain = @"RNImageStitcherErrorDomain";

// ─────────────────────────────────────────────────────────────────────
// RNStitchResult
// ─────────────────────────────────────────────────────────────────────

// Redeclare debugSummary as readwrite internally so it can be set after the
// designated initializer (keeps the init signature unchanged).
@interface RNStitchResult ()
@property (nonatomic, copy, readwrite) NSString *debugSummary;
@end

@implementation RNStitchResult

- (instancetype)initWithOutputPath:(NSString *)outputPath
                             width:(NSInteger)width
                            height:(NSInteger)height
                        durationMs:(double)durationMs
                   framesRequested:(NSInteger)framesRequested
                    framesIncluded:(NSInteger)framesIncluded
             finalConfidenceThresh:(double)finalConfidenceThresh {
  self = [super init];
  if (self) {
    _outputPath = [outputPath copy];
    _width = width;
    _height = height;
    _durationMs = durationMs;
    _framesRequested = framesRequested;
    _framesIncluded = framesIncluded;
    _finalConfidenceThresh = finalConfidenceThresh;
    _debugSummary = @"";
  }
  return self;
}

- (instancetype)initWithOutputPath:(NSString *)outputPath
                             width:(NSInteger)width
                            height:(NSInteger)height
                        durationMs:(double)durationMs {
  return [self initWithOutputPath:outputPath
                            width:width
                           height:height
                       durationMs:durationMs
                  framesRequested:-1
                   framesIncluded:-1
            finalConfidenceThresh:-1.0];
}

@end


// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

namespace {

// Strip the `file://` scheme some callers attach so cv::imread can
// open the path (cv::imread takes a filesystem path, not a URL).
NSString *normalizeImagePath(NSString *path) {
  if ([path hasPrefix:@"file://"]) {
    return [path substringFromIndex:[@"file://" length]];
  }
  return path;
}

// 2026-05-16 (post-Phase-2 cleanup): `loadFramesOrFail()` and
// `errorForStitchStatus()` removed from this file.  Both were
// called only by the prior `stitchFramePaths:` method body that
// was replaced by the shared-C++ delegating wrapper in commit
// 98b1a60.  Equivalents now live at:
//   - frame loading: cpp/stitcher.cpp anonymous-namespace
//     `loadAllFrames()` (called by both the high-level and manual
//     entries)
//   - error mapping: the explicit StitchErrorCode → NSError.code
//     switch in this file at the new wrapper (lines ~528-595)
// Removed to keep the anonymous namespace tight; sibling methods
// (stitchFramePaths, stitchVideoAtPath) don't need them.

// Phase 5: build a cv::detail::CameraParams from an ARKit pose.
//
// ARKit's camera-to-world transform uses a right-handed system
// with +X right, +Y up, -Z forward (out of the screen).  OpenCV
// uses +X right, +Y down, +Z forward (into the scene).  Conversion
// is:
//
//   M = diag(1, -1, -1)             // axis-flip from ARKit → OpenCV
//   R_ar_to_world = quaternion → 3x3 rotation matrix
//   R_world_to_cv = M * R_ar_to_world.transpose()
//
// The transpose is what changes from camera-to-world (what ARKit
// gives us) to world-to-camera (what cv::detail::CameraParams.R
// expects).  We don't set CameraParams.t — for panoramic stitching,
// translation is largely irrelevant (warpers project rays, not
// world points), and ARKit's metric translations would otherwise
// throw off cv::detail::SphericalWarper's scale heuristics.
//
// Intrinsics come straight from ARFrame.camera.intrinsics —
// focal length and principal point in pixels at the ARFrame's
// native resolution.
cv::detail::CameraParams cameraParamsFromPose(NSDictionary *pose) {
    cv::detail::CameraParams cam;

    double qx = [pose[@"qx"] doubleValue];
    double qy = [pose[@"qy"] doubleValue];
    double qz = [pose[@"qz"] doubleValue];
    double qw = [pose[@"qw"] doubleValue];

    // Quaternion → 3x3 rotation matrix (camera-to-world in ARKit).
    // Standard formula; assumes the quaternion is unit-length
    // (ARKit guarantees this).
    cv::Mat R_ar = (cv::Mat_<double>(3, 3) <<
        1 - 2*(qy*qy + qz*qz),  2*(qx*qy - qw*qz),      2*(qx*qz + qw*qy),
        2*(qx*qy + qw*qz),      1 - 2*(qx*qx + qz*qz),  2*(qy*qz - qw*qx),
        2*(qx*qz - qw*qy),      2*(qy*qz + qw*qx),      1 - 2*(qx*qx + qy*qy)
    );

    // Axis-flip matrix: ARKit Y-up → OpenCV Y-down, ARKit -Z forward
    // → OpenCV +Z forward.
    cv::Mat M = (cv::Mat_<double>(3, 3) <<
        1, 0, 0,
        0, -1, 0,
        0, 0, -1
    );

    // R_world_to_cv = M * R_ar_to_world.T
    cv::Mat R_world_to_cv = M * R_ar.t();
    cv::Mat R_float;
    R_world_to_cv.convertTo(R_float, CV_32F);
    cam.R = R_float;
    cam.t = cv::Mat::zeros(3, 1, CV_32F);

    // Intrinsics — at the pose's native image resolution.  The
    // compose-rescale step below will adjust these to compose scale.
    double fx = [pose[@"fx"] doubleValue];
    double fy = [pose[@"fy"] doubleValue];
    cam.focal = (fx + fy) / 2.0;
    cam.aspect = (fx > 0.0) ? (fy / fx) : 1.0;
    cam.ppx = [pose[@"cx"] doubleValue];
    cam.ppy = [pose[@"cy"] doubleValue];

    return cam;
}

}  // namespace


// ─────────────────────────────────────────────────────────────────────
// OpenCVStitcher (public)
// ─────────────────────────────────────────────────────────────────────

@implementation OpenCVStitcher

+ (nullable RNStitchResult *)stitchFramePaths:(NSArray<NSString *> *)framePaths
                                          outputPath:(NSString *)outputPath
                                         jpegQuality:(NSInteger)quality
                                          warperType:(NSString *)warperType
                                         blenderType:(NSString *)blenderType
                                      seamFinderType:(NSString *)seamFinderType
                                  captureOrientation:(NSString *)captureOrientation
                                useInscribedRectCrop:(BOOL)useInscribedRectCrop
                                          stitchMode:(NSString *)stitchMode
                                   useManualPipeline:(BOOL)useManualPipeline
                                               error:(NSError **)error {
  // Legacy selector — behaviour-identical delegate.  The -1 sentinels keep
  // the historical staged-resolution pins (compose 1.0 MP / registration
  // 0.6 MP) exactly as before the overload existed.
  return [OpenCVStitcher stitchFramePaths:framePaths
                               outputPath:outputPath
                              jpegQuality:quality
                               warperType:warperType
                              blenderType:blenderType
                           seamFinderType:seamFinderType
                       captureOrientation:captureOrientation
                     useInscribedRectCrop:useInscribedRectCrop
                               stitchMode:stitchMode
                        useManualPipeline:useManualPipeline
                       compositingResolMP:-1.0
                      registrationResolMP:-1.0
                                    error:error];
}

+ (nullable RNStitchResult *)stitchFramePaths:(NSArray<NSString *> *)framePaths
                                          outputPath:(NSString *)outputPath
                                         jpegQuality:(NSInteger)quality
                                          warperType:(NSString *)warperType
                                         blenderType:(NSString *)blenderType
                                      seamFinderType:(NSString *)seamFinderType
                                  captureOrientation:(NSString *)captureOrientation
                                useInscribedRectCrop:(BOOL)useInscribedRectCrop
                                          stitchMode:(NSString *)stitchMode
                                   useManualPipeline:(BOOL)useManualPipeline
                                  compositingResolMP:(double)compositingResolMP
                                 registrationResolMP:(double)registrationResolMP
                                               error:(NSError **)error {
  // ── Phase 2 (2026-05-16): delegated to shared C++ ───────────────────
  //
  // The hand-rolled cv::detail::* pipeline that used to live here
  // (~1500 lines from the original implementation, covering frames-
  // load → ORB features → BestOf2Nearest matching → leaveBiggest
  // Component → HomographyBasedEstimator → BundleAdjusterRay → wave
  // correct → median-focal warper-scale → seam find → multi-band
  // blend → max-inscribed-rect crop → bake-rotate → JPEG write) was
  // ported verbatim to `retailens::stitchFramePathsManual()` in
  // cpp/stitcher.cpp during Phase 1 (commit 02534ac).  Android already
  // routes through the same file via the high-level pipeline; iOS
  // now routes through it via `useManualPipeline=true`.
  //
  // Git blame on commit 02534ac (and its parent) captures the full
  // algorithm history with the original step-by-step comments.  The
  // shared C++ file carries forward equivalent comments at each step.
  //
  // This wrapper's only job: marshal Obj-C args into the shared
  // StitchConfig + std::vector<std::string>, route logs to os_log,
  // map StitchErrorCode → NSError.code so the JS-side UX taxonomy
  // (9001 / 9002 / … / 9007) is preserved.

  // Defaults if caller passed nil — keeps the older 3-arg call-sites
  // working until they are updated.  The shared C++ has its own
  // defaults but we want the wrapper to be tolerant of nil inputs
  // from Swift / Obj-C callers that grew up against the legacy API.
  if (warperType == nil || warperType.length == 0) warperType = @"spherical";
  if (blenderType == nil || blenderType.length == 0) blenderType = @"multiband";
  if (seamFinderType == nil || seamFinderType.length == 0) seamFinderType = @"graphcut";
  if (captureOrientation == nil || captureOrientation.length == 0) captureOrientation = @"portrait";

  // Build the shared-C++ config.
  //
  // 2026-06-06 (parity — see docs/stitch-pipeline-architecture.md §3/§7):
  // explicitly match the high-level / Android resolution budget instead of
  // leaving the sentinel -1.0, which made the manual entry point fall back
  // to its LOW defaults (registration 0.3 MP / compose 0.6 MP — half /
  // 0.6x Android's 0.6 / 1.0 MP, a major reason iOS output looked softer).
  retailens::StitchConfig cfg;
  cfg.registrationResolMP  = 0.6;   // cv::Stitcher default
  cfg.compositingResolMP   = 1.0;   // high-level default (manual was 0.6)
  cfg.warperType           = warperType.UTF8String;
  cfg.blenderType          = blenderType.UTF8String;
  cfg.seamFinderType       = seamFinderType.UTF8String;
  cfg.captureOrientation   = captureOrientation.UTF8String;
  cfg.useInscribedRectCrop = (useInscribedRectCrop != NO);
  cfg.jpegQuality          = (int)quality;
  // Explicit caller budgets win (> 0); <= 0 keeps the pins above.  The
  // shared-C++ canvas guard still downscales when the total compose canvas
  // exceeds the RAM budget, so a full-res request degrades instead of
  // OOMing.
  if (compositingResolMP > 0.0)  cfg.compositingResolMP  = compositingResolMP;
  if (registrationResolMP > 0.0) cfg.registrationResolMP = registrationResolMP;
  // 2026-05-22 (audit F2) — stitchMode is now wired through.  Caller
  // (IncrementalStitcher.swift) reads the JS setting and, when set
  // to 'auto', resolves to 'panorama' or 'scans' based on accumulated
  // translation/rotation ratio (mirroring Android's
  // resolveStitchModeAuto at IncrementalStitcher.kt:1727).
  // Unknown / nil values fall through to Panorama (the historical
  // hardcoded default — preserves behaviour for callers that haven't
  // updated yet).
  if ([stitchMode isEqualToString:@"scans"]) {
    cfg.stitchMode         = retailens::StitchMode::Scans;
  } else {
    cfg.stitchMode         = retailens::StitchMode::Panorama;
  }
  // Pre-stitch memory-abort threshold inside the manual pipeline keys
  // off this value.  Plumb the device's physical RAM through so the
  // heuristic scales correctly across the iPhone fleet (~2 GB legacy
  // → ~8 GB iPhone 16 Pro).
  cfg.availableRamMB =
      (double)NSProcessInfo.processInfo.physicalMemory
      / (1024.0 * 1024.0);
  // 2026-06-15 — DEFAULT to the MANUAL cv::detail pipeline.  ALL the memory/OOM
  // hardening lives on the manual path (PreStitchMemoryAbort, RAM-aware
  // canvas-budget downscale, STREAM/BATCH held-set routing, the black-canvas
  // utilization guard); the high-level cv::Stitcher path calls NONE of it.  So
  // manual is both the user's preferred output AND the memory-safe one.
  //
  // WARPER: NOT hardcoded — cfg.warperType carries the caller's choice (set from
  // the JS `warperType`, which defaults to "spherical" and is settable via the
  // ⚙️ panel / the host's `defaultWarper` prop).  The JS default is the single
  // source of truth now.  Choosing "plane" re-arms the dynamic plane→spherical
  // fallback + divergence switch in the manual pipeline (they only fire when
  // warperType != "spherical").
  //
  // The pipeline is caller-driven: batch capture passes YES (manual, default
  // output); the on-demand high-level tab re-stitches with NO.
  cfg.useManualPipeline = useManualPipeline;

  // 2026-06-16 — iOS resident-memory probe.  iOS has no /proc/self/statm, so the
  // shared rss_mb() returned -1 — which (a) blinded the per-stitch profiling and
  // (b) silently DISABLED the runtime-pressure half of the manual pipeline's OOM
  // router (the lowBatchHeadroom STREAM trigger), on the very platform (jetsam)
  // it protects.  Plug task_info(TASK_VM_INFO).phys_footprint (the metric jetsam
  // evaluates) as the probe.  Set UNCONDITIONALLY — the OOM guards must work in
  // release too; only the sampler + per-stitch record are gated by the compile
  // flag (debug-on, release-off).
  cfg.memProbeFn = []() -> double { return StitcherResidentMB(); };
  cfg.enableMemoryProfiling = (RNIS_MEMORY_PROFILING != 0);

  // Marshal NSArray<NSString*> → std::vector<std::string>.  Strip the
  // `file://` scheme that some callers attach so the shared C++ can
  // cv::imread the raw filesystem path.
  std::vector<std::string> paths;
  paths.reserve(framePaths.count);
  for (NSString *p in framePaths) {
    NSString *cleaned = p;
    if ([cleaned hasPrefix:@"file://"]) {
      cleaned = [cleaned substringFromIndex:[@"file://" length]];
    }
    paths.emplace_back(cleaned.UTF8String);
  }
  NSString *cleanedOutputPath = outputPath;
  if ([cleanedOutputPath hasPrefix:@"file://"]) {
    cleanedOutputPath = [cleanedOutputPath substringFromIndex:[@"file://" length]];
  }

  // Logging callback: route shared-C++ logs to the same os_log
  // subsystem the rest of this file uses, so Console.app shows them
  // alongside the existing breadcrumbs.  Level mapping mirrors what
  // the shared C++ already documents (0=info, 1=warn, 2=error).
  retailens::LogFn logFn = [](int level, const char *tag, const char *msg) {
    os_log_type_t logType;
    switch (level) {
      case 0:  logType = OS_LOG_TYPE_INFO;    break;
      case 1:  logType = OS_LOG_TYPE_DEFAULT; break;
      case 2:  logType = OS_LOG_TYPE_FAULT;   break;
      default: logType = OS_LOG_TYPE_DEFAULT; break;
    }
    os_log_with_type(StitcherDiagLog(), logType, "%{public}s %{public}s",
                     tag ? tag : "[stitch]", msg ? msg : "");
  };

  // ── Run the stitch under an @autoreleasepool ─────────────────────
  //
  // fix-10 pattern (see line 599-ish of the prior file revision for
  // the canonical comment block — preserved by git blame on the
  // pre-Phase-2 commit): any NSError/NSString created INSIDE the
  // pool would otherwise be autoreleased into the pool and freed at
  // the closing brace BEFORE Swift's `objc_retainAutoreleasedReturn-
  // Value` could retain it, producing the EXC_BAD_ACCESS the old
  // implementation chased through fix-1 through fix-9.
  //
  // For this wrapper the C++ call doesn't autorelease anything by
  // itself, but ANY `[NSString stringWithUTF8String:]` or
  // `[NSError errorWithDomain:…]` we build from the result IS
  // autoreleased.  So we run the C++ call + the NSError build inside
  // the pool, but capture the NSError into a STRONG LOCAL declared
  // ABOVE the pool.  The pool drains; the strong local survives
  // (ARC retain on the alloc, NOT autoreleased); after the pool we
  // either return the success result, write `*error` from the strong
  // local, or fall through.
  //
  // See docs/site-content/learnings/react-native.md#autoreleasepool-return-uaf
  RNStitchResult *result = nil;
  NSError *capturedError = nil;
  @autoreleasepool {
    retailens::StitchResult r = retailens::stitchFramePaths(
        paths,
        cleanedOutputPath.UTF8String,
        cfg,
        logFn);

    if (r.success) {
      const int64_t durationMs = r.durationMs;
      // 2026-05-16 (Issue 5) — pass C+D retry telemetry up to Swift so
      // the JS finalize dict can carry it.  framesRequested defaults
      // to the input count when the cpp path didn't fill it (e.g. an
      // early-return success path that bypassed the retry loop).
      const NSInteger framesRequested =
          r.framesRequested > 0 ? (NSInteger)r.framesRequested
                                : (NSInteger)paths.size();
      result = [[RNStitchResult alloc]
          initWithOutputPath:outputPath
                       width:(NSInteger)r.width
                      height:(NSInteger)r.height
                  durationMs:(double)durationMs
             framesRequested:framesRequested
              framesIncluded:(NSInteger)r.framesIncluded
       finalConfidenceThresh:r.finalConfidenceThresh];
      if (!r.debugSummary.empty()) {
        std::string dbg = r.debugSummary;
        // iOS has no mallopt purge; the post-stitch settle read IS the leak
        // floor (memFloor).  Append it so it rides debugSummary to JS like
        // Android's post-purge value (gated; debug-only).
        if (RNIS_MEMORY_PROFILING != 0) {
          char fbuf[40];
          snprintf(fbuf, sizeof(fbuf), ";memFloor=%.1f", StitcherResidentMB());
          dbg += fbuf;
        }
        result.debugSummary =
            [NSString stringWithUTF8String:dbg.c_str()];
      }
      // 2026-06-15 — the eager A/B harness that ALSO stitched the high-level
      // alt on EVERY capture has been REMOVED.  Manual is now the default (this
      // method), so computing high-level eagerly was pure wasted work —
      // especially while profiling memory/perf — when the user isn't viewing
      // it.  The keyframe JPEGs are retained on disk so high-level can be
      // produced ON DEMAND (follow-up: a `useManualPipeline` param on this
      // method lets `refinePanorama` re-stitch them via the high-level path
      // when the user switches to the high-level tab).
    } else {
      // Map StitchErrorCode → NSError.code.  Preserves the existing
      // 9001/9002/9003/1001/9007 sentinels the JS UX layer already
      // branches on; adds new codes 9100-9103 for manual-pipeline-
      // specific failure modes that previously collapsed into
      // 9007 / generic crashes.
      NSInteger nsCode = 9999;
      switch (r.errorCode) {
        case retailens::StitchErrorCode::NeedMoreImages:
          nsCode = 9001;
          break;
        case retailens::StitchErrorCode::HomographyEstimationFailed:
          nsCode = 9002;
          break;
        case retailens::StitchErrorCode::CameraParamsAdjustFailed:
          nsCode = 9003;
          break;
        case retailens::StitchErrorCode::ImageReadFailed:
          nsCode = 1001;
          break;
        case retailens::StitchErrorCode::AllFramesDroppedByConfidence:
          // 9007 preserves the existing sentinel the JS-side surfaces
          // as "could not stitch — try recapturing with more overlap";
          // changing this would silently flip the operator-facing
          // copy across the app.
          nsCode = 9007;
          break;
        case retailens::StitchErrorCode::PreStitchMemoryAbort:
          nsCode = 9100;
          break;
        case retailens::StitchErrorCode::ComposeResizeFailed:
          nsCode = 9101;
          break;
        case retailens::StitchErrorCode::WarpFailed:
          nsCode = 9102;
          break;
        case retailens::StitchErrorCode::EmptyPanorama:
          nsCode = 9103;
          break;
        case retailens::StitchErrorCode::InvalidArgument:
          nsCode = 9000;
          break;
        default:
          nsCode = 9999;
          break;
      }
      NSString *msg =
          [NSString stringWithUTF8String:r.errorMessage.c_str()] ?: @"Stitch failed";
      capturedError = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                          code:nsCode
                                      userInfo:@{NSLocalizedDescriptionKey: msg}];
    }
  }  // end @autoreleasepool — drains shared-C++ temporary NSStrings
     // that we built from r.errorMessage / tag strings.  result and
     // capturedError survive the drain because they were assigned
     // to strong locals declared ABOVE the pool.

  // Failure path: outparameter assignment happens AFTER the pool
  // drains so the NSError lives in the OUTER pool (drained by the
  // GCD work item / Swift autoreleasing boundary).
  if (capturedError != nil) {
    if (error) {
      *error = capturedError;
    }
    return nil;
  }
  return result;
}


// ─────────────────────────────────────────────────────────────────────
// Video → frames (AVFoundation, no OpenCV)
// ─────────────────────────────────────────────────────────────────────

+ (nullable NSArray<NSString *> *)extractFramesFromVideoAtPath:(NSString *)videoPath
                                                     outputDir:(NSString *)outputDir
                                                     maxFrames:(NSInteger)maxFrames
                                                   jpegQuality:(NSInteger)quality
                                                         error:(NSError **)error {
  if (maxFrames < 2) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1010
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"maxFrames must be ≥ 2 for the stitcher to have something to align.",
      }];
    }
    return nil;
  }

  NSString *cleanedVideoPath = normalizeImagePath(videoPath);
  NSURL *videoURL = [NSURL fileURLWithPath:cleanedVideoPath];
  if (![[NSFileManager defaultManager] fileExistsAtPath:cleanedVideoPath]) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1011
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Video file not found: %@", videoPath],
      }];
    }
    return nil;
  }

  // Make sure outputDir exists; the SDK call creates it but be
  // defensive in case the host wrote a literal path that doesn't.
  [[NSFileManager defaultManager] createDirectoryAtPath:normalizeImagePath(outputDir)
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];

  AVURLAsset *asset = [AVURLAsset assetWithURL:videoURL];
  CMTime duration = asset.duration;
  Float64 totalSeconds = CMTimeGetSeconds(duration);
  if (!isfinite(totalSeconds) || totalSeconds <= 0) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1012
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Could not read video duration — file may be corrupt or still being written.",
      }];
    }
    return nil;
  }

  AVAssetImageGenerator *generator =
      [AVAssetImageGenerator assetImageGeneratorWithAsset:asset];
  // Honour the camera's recorded orientation — without this, all
  // frames come out unrotated and stitch into a sideways panorama.
  generator.appliesPreferredTrackTransform = YES;
  // Tight tolerances → AVFoundation seeks to the requested timestamp
  // exactly rather than the nearest keyframe.  Cost: slower extract.
  // Worth it; nearest-keyframe sampling can give near-duplicate frames
  // when the keyframe interval lines up with our sample rate.
  generator.requestedTimeToleranceBefore = kCMTimeZero;
  generator.requestedTimeToleranceAfter = kCMTimeZero;

  NSInteger clampedQuality = MAX(0, MIN(100, quality));
  CGFloat compressionQuality = clampedQuality / 100.0;

  NSMutableArray<NSString *> *paths =
      [NSMutableArray arrayWithCapacity:(NSUInteger)maxFrames];
  NSString *cleanedOutputDir = normalizeImagePath(outputDir);

  // V12.13 — diagnostic for the landscape-only `EXC_BAD_ACCESS` crash
  // Ram caught.  Track per-frame extract progress + dimensions so the
  // log breadcrumb pinpoints which stage and frame triggers the
  // memory error if it recurs.  Also log the asset's video track size
  // + preferred transform up front so we know what AVFoundation is
  // about to hand us before the loop runs.
  AVAssetTrack *videoTrack = nil;
  NSArray *videoTracks = [asset tracksWithMediaType:AVMediaTypeVideo];
  if (videoTracks.count > 0) {
    videoTrack = videoTracks.firstObject;
  }
  CGSize naturalSize = videoTrack ? videoTrack.naturalSize : CGSizeZero;
  CGAffineTransform xform = videoTrack ? videoTrack.preferredTransform
                                       : CGAffineTransformIdentity;
  NSLog(@"[stitch-bc] extractFrames start: maxFrames=%ld duration=%.2fs "
        @"track.naturalSize=%.0fx%.0f preferredTransform=[a=%.2f b=%.2f c=%.2f d=%.2f tx=%.2f ty=%.2f]",
        (long)maxFrames, totalSeconds,
        naturalSize.width, naturalSize.height,
        xform.a, xform.b, xform.c, xform.d, xform.tx, xform.ty);

  for (NSInteger i = 0; i < maxFrames; i++) {
    // V12.13 — wrap each iteration in its own @autoreleasepool so
    // UIImage / NSData / NSString temporaries get drained per-frame
    // instead of accumulating to function exit.  Without this, a
    // 30-frame extract from a landscape video can hold ~100+ MB of
    // autoreleased temporaries — combined with the video extractor's
    // own caches this has historically triggered jetsam +
    // EXC_BAD_ACCESS-during-tear-down (see the COMPOSE_MP comment
    // around line 313 of stitchFramePaths for the same pattern).
    @autoreleasepool {
      // Even time spacing across [0, duration].  Dividing by
      // (maxFrames - 1) gives endpoints at exactly 0 and `duration`,
      // capturing the first and last useful moments.
      Float64 fraction = (Float64)i / (Float64)(maxFrames - 1);
      Float64 timeSeconds = fraction * totalSeconds;
      CMTime cmTime = CMTimeMakeWithSeconds(timeSeconds, 600);

      NSError *frameErr = nil;
      CGImageRef cgImage =
          [generator copyCGImageAtTime:cmTime actualTime:NULL error:&frameErr];
      if (cgImage == NULL) {
        NSLog(@"[stitch-bc] frame %ld/%ld: copyCGImageAtTime returned NULL "
              @"(t=%.2fs, err=%@)",
              (long)i, (long)maxFrames, timeSeconds,
              frameErr.localizedDescription ?: @"nil");
        // Skip an unreadable frame rather than aborting — sometimes
        // the very-last-millisecond seek fails on short videos.  The
        // stitcher just gets one fewer frame.
        continue;
      }

      size_t cgW = CGImageGetWidth(cgImage);
      size_t cgH = CGImageGetHeight(cgImage);

      UIImage *uiImage = [UIImage imageWithCGImage:cgImage];
      CGImageRelease(cgImage);

      NSData *jpegData = UIImageJPEGRepresentation(uiImage, compressionQuality);
      if (jpegData == nil) {
        NSLog(@"[stitch-bc] frame %ld/%ld: UIImageJPEGRepresentation returned nil",
              (long)i, (long)maxFrames);
        continue;
      }

      NSString *framePath =
          [cleanedOutputDir stringByAppendingPathComponent:
              [NSString stringWithFormat:@"frame_%03ld.jpg", (long)i]];
      BOOL wrote = [jpegData writeToFile:framePath atomically:YES];
      NSLog(@"[stitch-bc] frame %ld/%ld: cgImage=%zux%zu jpeg=%lu bytes wrote=%d",
            (long)i, (long)maxFrames, cgW, cgH,
            (unsigned long)jpegData.length, (int)wrote);
      if (wrote) {
        [paths addObject:framePath];
      }
    }
  }
  NSLog(@"[stitch-bc] extractFrames done: produced %lu frames",
        (unsigned long)paths.count);

  if (paths.count < 2) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1013
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"Extracted only %lu frames from video — need ≥ 2.  "
             "The video may be too short or the file unreadable.",
            (unsigned long)paths.count],
      }];
    }
    return nil;
  }

  return paths;
}


// ─────────────────────────────────────────────────────────────────────
// Combined pipeline: video → stitched panorama
// ─────────────────────────────────────────────────────────────────────

+ (nullable RNStitchResult *)stitchVideoAtPath:(NSString *)videoPath
                                           outputPath:(NSString *)outputPath
                                            maxFrames:(NSInteger)maxFrames
                                          jpegQuality:(NSInteger)quality
                                           warperType:(NSString *)warperType
                                          blenderType:(NSString *)blenderType
                                       seamFinderType:(NSString *)seamFinderType
                                                error:(NSError **)error {
  // Tmp dir for extracted frames — UUID'd so concurrent stitches
  // can't clobber each other's working state.
  NSString *tmpDir =
      [NSTemporaryDirectory() stringByAppendingPathComponent:
          [NSString stringWithFormat:@"RNImageStitcherStitch-%@",
              [[NSUUID UUID] UUIDString]]];

  NSError *extractErr = nil;
  NSArray<NSString *> *frames =
      [self extractFramesFromVideoAtPath:videoPath
                              outputDir:tmpDir
                              maxFrames:maxFrames
                            jpegQuality:quality
                                  error:&extractErr];
  if (!frames) {
    // Best-effort cleanup — the dir may not exist if extract bailed
    // before creating it.  Ignore the error.
    [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];
    if (error) *error = extractErr;
    return nil;
  }

  NSError *stitchErr = nil;
  // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
  // Legacy video-driven path: no AR-frame orientation context, so
  // we pass nil for captureOrientation → the .mm side treats nil as
  // "portrait" → no bake-rotation.  Callers wanting rotation should
  // use the keyframe-driven Swift path which carries the orientation
  // from the JS accelerometer hook through IncrementalStitcher.
  // 2026-05-22 (audit F2) — legacy video path passes nil stitchMode,
  // which falls through to Panorama (preserves prior behaviour).
  RNStitchResult *result =
      [self stitchFramePaths:frames
                  outputPath:outputPath
                 jpegQuality:quality
                  warperType:warperType
                 blenderType:blenderType
              seamFinderType:seamFinderType
          captureOrientation:nil
        useInscribedRectCrop:NO
                  stitchMode:nil
           useManualPipeline:NO  // legacy video path keeps high-level cv::Stitcher
                       error:&stitchErr];

  // Always tear down the tmp dir, success or fail — leaving
  // hundreds of MB of frame JPEGs in /tmp would balloon the app's
  // working set across panoramas.
  [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];

  if (!result && error) *error = stitchErr;
  return result;
}


// ─────────────────────────────────────────────────────────────────────
// Photo orientation normalisation
// ─────────────────────────────────────────────────────────────────────
// Round-trip through cv::imread / cv::imwrite to bake the EXIF
// rotation into the pixel buffer, then write a plain JPEG with no
// orientation metadata.  Cheap (~ms for a typical iPhone JPEG) and
// idempotent on already-normalised files.

+ (NSDictionary<NSString *, NSNumber *> *)normaliseImageAtPath:(NSString *)imagePath
                                                         error:(NSError **)error {
  NSString *cleaned = normalizeImagePath(imagePath);
  if (![[NSFileManager defaultManager] fileExistsAtPath:cleaned]) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1020
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Image not found: %@", imagePath],
      }];
    }
    return nil;
  }

  std::string nativePath(cleaned.UTF8String);
  cv::Mat img = cv::imread(nativePath, cv::IMREAD_COLOR);
  if (img.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1021
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not decode image at %@", imagePath],
      }];
    }
    return nil;
  }

  std::vector<int> writeParams = {
    cv::IMWRITE_JPEG_QUALITY, 92,
  };
  bool ok = cv::imwrite(nativePath, img, writeParams);
  if (!ok) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1022
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"Could not rewrite image at %@", imagePath],
      }];
    }
    return nil;
  }

  return @{
    @"width":  @((NSInteger)img.cols),
    @"height": @((NSInteger)img.rows),
  };
}

+ (NSDictionary<NSString *, NSNumber *> *)computeInscribedRectAtPath:(NSString *)imagePath
                                                              error:(NSError **)error {
  NSString *cleaned = normalizeImagePath(imagePath);
  if (![[NSFileManager defaultManager] fileExistsAtPath:cleaned]) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1020
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Image not found: %@", imagePath],
      }];
    }
    return nil;
  }

  std::string nativePath(cleaned.UTF8String);
  cv::Mat img = cv::imread(nativePath, cv::IMREAD_COLOR);
  if (img.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1021
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not decode image at %@", imagePath],
      }];
    }
    return nil;
  }

  // Prefer the TRUE coverage sidecar the stitch writes next to the
  // panorama (<path>.coverage.png); fall back to the hole-fill brightness
  // proxy when it's absent (e.g. a non-stitch image).
  NSString *coveragePath = [cleaned stringByAppendingString:@".coverage.png"];
  cv::Mat mask;
  if ([[NSFileManager defaultManager] fileExistsAtPath:coveragePath]) {
    cv::Mat cov = cv::imread(std::string(coveragePath.UTF8String), cv::IMREAD_GRAYSCALE);
    if (!cov.empty() && cov.cols == img.cols && cov.rows == img.rows) {
      cv::threshold(cov, mask, 0, 255, cv::THRESH_BINARY);
    }
  }
  if (mask.empty()) {
    cv::Mat gray, raw;
    cv::cvtColor(img, gray, cv::COLOR_BGR2GRAY);
    cv::threshold(gray, raw, 1, 255, cv::THRESH_BINARY);
    mask = FillBorderConnectedHoles(raw);
  }
  cv::Rect r = MaxInscribedRectFromMask(mask);

  return @{
    @"x":           @((NSInteger)r.x),
    @"y":           @((NSInteger)r.y),
    @"width":       @((NSInteger)r.width),
    @"height":      @((NSInteger)r.height),
    @"imageWidth":  @((NSInteger)img.cols),
    @"imageHeight": @((NSInteger)img.rows),
  };
}

+ (NSDictionary<NSString *, NSNumber *> *)cropToRectAtPath:(NSString *)imagePath
                                                        x:(NSInteger)x
                                                        y:(NSInteger)y
                                                    width:(NSInteger)width
                                                   height:(NSInteger)height
                                                  quality:(NSInteger)quality
                                                    error:(NSError **)error {
  NSString *cleaned = normalizeImagePath(imagePath);
  if (![[NSFileManager defaultManager] fileExistsAtPath:cleaned]) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1020
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Image not found: %@", imagePath],
      }];
    }
    return nil;
  }

  std::string nativePath(cleaned.UTF8String);
  cv::Mat img = cv::imread(nativePath, cv::IMREAD_COLOR);
  if (img.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1021
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not decode image at %@", imagePath],
      }];
    }
    return nil;
  }

  // Clamp the requested rect to the image bounds (defensive — the JS
  // side derives it from computeInscribedRect, but never trust input).
  int rx = (int)x; if (rx < 0) { rx = 0; }
  int ry = (int)y; if (ry < 0) { ry = 0; }
  if (rx > img.cols - 1) { rx = img.cols - 1; }
  if (ry > img.rows - 1) { ry = img.rows - 1; }
  int rw = (int)width; if (rw < 1) { rw = 1; }
  int rh = (int)height; if (rh < 1) { rh = 1; }
  if (rx + rw > img.cols) { rw = img.cols - rx; }
  if (ry + rh > img.rows) { rh = img.rows - ry; }

  cv::Mat cropped = img(cv::Rect(rx, ry, rw, rh)).clone();

  int q = (int)quality;
  if (q < 1) { q = 1; }
  if (q > 100) { q = 100; }
  std::vector<int> writeParams = { cv::IMWRITE_JPEG_QUALITY, q };
  bool ok = cv::imwrite(nativePath, cropped, writeParams);
  if (!ok) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1022
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not rewrite image at %@", imagePath],
      }];
    }
    return nil;
  }

  return @{
    @"width":  @((NSInteger)cropped.cols),
    @"height": @((NSInteger)cropped.rows),
  };
}

// item-7 — free-quad perspective crop.  Mirrors cropToRectAtPath, but
// instead of an axis-aligned sub-rectangle it takes 4 user-dragged
// corners in IMAGE-PIXEL space (ordered TL, TR, BR, BL by the JS editor's
// orderQuadCorners) and rectifies them to an upright rectangle via
// cv::getPerspectiveTransform + cv::warpPerspective.  The destination
// size + the convex/min-area/in-bounds gate come from the shared OpenCV-
// free cpp/crop_quad.hpp so iOS / Android / JS agree bit-for-bit; the
// output canvas is GUARDED with the same canvasExceedsGuard the stitch
// pipeline uses so a near-collinear quad can't OOM a multi-MP panorama.
+ (NSDictionary<NSString *, NSNumber *> *)cropToQuadAtPath:(NSString *)imagePath
                                                      tlX:(double)tlX
                                                      tlY:(double)tlY
                                                      trX:(double)trX
                                                      trY:(double)trY
                                                      brX:(double)brX
                                                      brY:(double)brY
                                                      blX:(double)blX
                                                      blY:(double)blY
                                                  quality:(NSInteger)quality
                                                    error:(NSError **)error {
  NSString *cleaned = normalizeImagePath(imagePath);
  if (![[NSFileManager defaultManager] fileExistsAtPath:cleaned]) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1020
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Image not found: %@", imagePath],
      }];
    }
    return nil;
  }

  std::string nativePath(cleaned.UTF8String);
  cv::Mat img = cv::imread(nativePath, cv::IMREAD_COLOR);
  if (img.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1021
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not decode image at %@", imagePath],
      }];
    }
    return nil;
  }

  retailens::CropQuad quad;
  quad.tl = {tlX, tlY};
  quad.tr = {trX, trY};
  quad.br = {brX, brY};
  quad.bl = {blX, blY};

  // Geometry gate — convex, non-degenerate, inside the decoded image.
  if (!retailens::isQuadAcceptable(quad, (double)img.cols, (double)img.rows)) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1023
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Crop quad is degenerate (non-convex, zero-area, or out of bounds)",
      }];
    }
    return nil;
  }

  const retailens::QuadDstSize dst = retailens::quadDstRect(quad);
  // Output-canvas OOM net — the same guard the stitch pipeline uses.
  if (dst.width <= 0 || dst.height <= 0 ||
      retailens::canvasExceedsGuard(dst.width, dst.height)) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1024
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"Crop quad output canvas is degenerate or exceeds the size guard (%dx%d)",
            dst.width, dst.height],
      }];
    }
    return nil;
  }

  const cv::Point2f src[4] = {
    cv::Point2f((float)tlX, (float)tlY),
    cv::Point2f((float)trX, (float)trY),
    cv::Point2f((float)brX, (float)brY),
    cv::Point2f((float)blX, (float)blY),
  };
  const cv::Point2f dstPts[4] = {
    cv::Point2f(0.0f, 0.0f),
    cv::Point2f((float)dst.width, 0.0f),
    cv::Point2f((float)dst.width, (float)dst.height),
    cv::Point2f(0.0f, (float)dst.height),
  };

  cv::Mat warped;
  // OpenCV throws cv::Exception (a C++ exception) — catch with a C++
  // try/catch, NOT @try/@catch (which only traps NSException).
  try {
    cv::Mat transform = cv::getPerspectiveTransform(src, dstPts);
    cv::warpPerspective(img, warped, transform,
                        cv::Size(dst.width, dst.height), cv::INTER_LINEAR);
  } catch (const cv::Exception &e) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1025
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Perspective warp failed: %s", e.what()],
      }];
    }
    return nil;
  }
  if (warped.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1025
                               userInfo:@{
        NSLocalizedDescriptionKey: @"Perspective warp produced an empty image",
      }];
    }
    return nil;
  }

  int q = (int)quality;
  if (q < 1) { q = 1; }
  if (q > 100) { q = 100; }
  std::vector<int> writeParams = { cv::IMWRITE_JPEG_QUALITY, q };
  bool ok = cv::imwrite(nativePath, warped, writeParams);
  if (!ok) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1022
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not rewrite image at %@", imagePath],
      }];
    }
    return nil;
  }

  return @{
    @"width":  @((NSInteger)warped.cols),
    @"height": @((NSInteger)warped.rows),
  };
}

+ (NSDictionary *)debugMaskOverlayAtPath:(NSString *)imagePath
                               threshold:(NSInteger)threshold
                                   error:(NSError **)error {
  NSString *cleaned = normalizeImagePath(imagePath);
  if (![[NSFileManager defaultManager] fileExistsAtPath:cleaned]) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1020
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Image not found: %@", imagePath],
      }];
    }
    return nil;
  }

  std::string nativePath(cleaned.UTF8String);
  cv::Mat img = cv::imread(nativePath, cv::IMREAD_COLOR);
  if (img.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1021
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not decode image at %@", imagePath],
      }];
    }
    return nil;
  }

  // Prefer the TRUE coverage sidecar (<path>.coverage.png) the stitch
  // writes; else the hole-fill brightness proxy at threshold `t`.
  NSString *coveragePath = [cleaned stringByAppendingString:@".coverage.png"];
  cv::Mat mask;
  if ([[NSFileManager defaultManager] fileExistsAtPath:coveragePath]) {
    cv::Mat cov = cv::imread(std::string(coveragePath.UTF8String), cv::IMREAD_GRAYSCALE);
    if (!cov.empty() && cov.cols == img.cols && cov.rows == img.rows) {
      cv::threshold(cov, mask, 0, 255, cv::THRESH_BINARY);
    }
  }
  if (mask.empty()) {
    int t = (int)threshold;
    if (t < 0) { t = 0; }
    cv::Mat gray, raw;
    cv::cvtColor(img, gray, cv::COLOR_BGR2GRAY);
    cv::threshold(gray, raw, t, 255, cv::THRESH_BINARY);
    mask = FillBorderConnectedHoles(raw);
  }
  cv::Mat excluded;
  cv::bitwise_not(mask, excluded);                        // 255 = dropped pixels

  // Blend red (BGR 0,0,255) over the dropped pixels so they stand out.
  cv::Mat overlay = img.clone();
  cv::Mat red(img.size(), img.type(), cv::Scalar(0, 0, 255));
  cv::Mat blended;
  cv::addWeighted(img, 0.35, red, 0.65, 0.0, blended);
  blended.copyTo(overlay, excluded);

  std::string outPath = std::string(cleaned.UTF8String) + ".mask.jpg";
  std::vector<int> writeParams = { cv::IMWRITE_JPEG_QUALITY, 90 };
  if (!cv::imwrite(outPath, overlay, writeParams)) {
    if (error) {
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
                                   code:1022
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Could not write mask overlay for %@", imagePath],
      }];
    }
    return nil;
  }

  long total = (long)mask.rows * (long)mask.cols;
  long content = (long)cv::countNonZero(mask);
  int excludedPct = (total > 0)
    ? (int)((double)(total - content) * 100.0 / (double)total)
    : 0;

  return @{
    @"maskPath":        [NSString stringWithUTF8String:outPath.c_str()],
    @"width":           @((NSInteger)img.cols),
    @"height":          @((NSInteger)img.rows),
    @"excludedPercent": @((NSInteger)excludedPct),
  };
}

@end
