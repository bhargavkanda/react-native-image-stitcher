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
// HEADER_SEARCH_PATHS (see RetaiLensCaptureSDK.podspec).
#import "stitcher.hpp"
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


NSString *const RetaiLensStitcherErrorDomain = @"RetaiLensStitcherErrorDomain";

// ─────────────────────────────────────────────────────────────────────
// RetaiLensStitchResult
// ─────────────────────────────────────────────────────────────────────

@implementation RetaiLensStitchResult

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
// (stitchKeyframePaths, stitchVideoAtPath) don't need them.

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

+ (nullable RetaiLensStitchResult *)stitchFramePaths:(NSArray<NSString *> *)framePaths
                                          outputPath:(NSString *)outputPath
                                         jpegQuality:(NSInteger)quality
                                          warperType:(NSString *)warperType
                                         blenderType:(NSString *)blenderType
                                      seamFinderType:(NSString *)seamFinderType
                                  captureOrientation:(NSString *)captureOrientation
                                useInscribedRectCrop:(BOOL)useInscribedRectCrop
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
  if (warperType == nil || warperType.length == 0) warperType = @"plane";
  if (blenderType == nil || blenderType.length == 0) blenderType = @"multiband";
  if (seamFinderType == nil || seamFinderType.length == 0) seamFinderType = @"graphcut";
  if (captureOrientation == nil || captureOrientation.length == 0) captureOrientation = @"portrait";

  // Build the shared-C++ config.  Sentinel resolution budgets (-1.0)
  // let the manual entry point pick its own defaults (registration
  // 0.6 MP / seam 0.1 MP / compose 0.6 MP per Phase 1 fixes).
  retailens::StitchConfig cfg;
  cfg.warperType           = warperType.UTF8String;
  cfg.blenderType          = blenderType.UTF8String;
  cfg.seamFinderType       = seamFinderType.UTF8String;
  cfg.captureOrientation   = captureOrientation.UTF8String;
  cfg.useInscribedRectCrop = (useInscribedRectCrop != NO);
  cfg.jpegQuality          = (int)quality;
  // The iOS API doesn't expose stitchMode yet; defaulting to Panorama
  // matches the prior hand-rolled pipeline's BestOf2NearestMatcher +
  // BundleAdjusterRay configuration (rotation-only end-to-end).
  cfg.stitchMode           = retailens::StitchMode::Panorama;
  // Pre-stitch memory-abort threshold inside the manual pipeline keys
  // off this value.  Plumb the device's physical RAM through so the
  // heuristic scales correctly across the iPhone fleet (~2 GB legacy
  // → ~8 GB iPhone 16 Pro).
  cfg.availableRamMB =
      (double)NSProcessInfo.processInfo.physicalMemory
      / (1024.0 * 1024.0);
  // Route to the manual cv::detail::* pipeline; the high-level
  // cv::Stitcher::create path (Android's default) is unsuitable for
  // iOS's shelf-pan capture shape (compose-MP defaults, graphcut at
  // compose-MP, BA convergence params — see stitcher.hpp comment
  // block).
  cfg.useManualPipeline = true;

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
  RetaiLensStitchResult *result = nil;
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
      result = [[RetaiLensStitchResult alloc]
          initWithOutputPath:outputPath
                       width:(NSInteger)r.width
                      height:(NSInteger)r.height
                  durationMs:(double)durationMs
             framesRequested:framesRequested
              framesIncluded:(NSInteger)r.framesIncluded
       finalConfidenceThresh:r.finalConfidenceThresh];
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
      capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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

+ (nullable RetaiLensStitchResult *)stitchVideoAtPath:(NSString *)videoPath
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
          [NSString stringWithFormat:@"RetaiLensStitch-%@",
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
  RetaiLensStitchResult *result =
      [self stitchFramePaths:frames
                  outputPath:outputPath
                 jpegQuality:quality
                  warperType:warperType
                 blenderType:blenderType
              seamFinderType:seamFinderType
          captureOrientation:nil
        useInscribedRectCrop:NO
                       error:&stitchErr];

  // Always tear down the tmp dir, success or fail — leaving
  // hundreds of MB of frame JPEGs in /tmp would balloon the app's
  // working set across panoramas.
  [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];

  if (!result && error) *error = stitchErr;
  return result;
}


// ─────────────────────────────────────────────────────────────────────
// Phase 5: pose-driven video → panorama (ARKit/ARCore)
// ─────────────────────────────────────────────────────────────────────
//
// Same end-to-end shape as `stitchVideoAtPath` but consumes
// pre-computed camera poses (from ARKit/ARCore via the host's
// RNSARSession) and skips the brittle features → matching
// → BundleAdjuster steps that the feature-matched path runs.
// The compose stage (warp + seam + blend + crop) is duplicated
// from `stitchFramePaths` rather than refactored — keeps the
// hard-won existing pipeline untouched while we field-test the
// pose path; both paths can be DRY'd into a shared helper once
// the new code is proven on real shelf captures.

+ (nullable RetaiLensStitchResult *)stitchVideoAtPath:(NSString *)videoPath
                                           outputPath:(NSString *)outputPath
                                            maxFrames:(NSInteger)maxFrames
                                          jpegQuality:(NSInteger)quality
                                           warperType:(NSString *)warperType
                                          blenderType:(NSString *)blenderType
                                       seamFinderType:(NSString *)seamFinderType
                                                poses:(NSArray<NSDictionary *> *)poses
                                                error:(NSError **)error {
  if (warperType == nil || warperType.length == 0) warperType = @"plane";
  if (blenderType == nil || blenderType.length == 0) blenderType = @"multiband";
  if (seamFinderType == nil || seamFinderType.length == 0) seamFinderType = @"graphcut";
  if (poses.count < 2) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1030
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Pose-driven stitch needs at least 2 poses; got fewer.",
      }];
    }
    return nil;
  }

  NSString *tmpDir =
      [NSTemporaryDirectory() stringByAppendingPathComponent:
          [NSString stringWithFormat:@"RetaiLensStitchAR-%@",
              [[NSUUID UUID] UUIDString]]];

  // Extract evenly-spaced frames from the video (same helper the
  // feature-matched path uses).  Returns paths only; we'll compute
  // each frame's timestamp ourselves to match against `poses`.
  NSError *extractErr = nil;
  NSArray<NSString *> *framePaths =
      [self extractFramesFromVideoAtPath:videoPath
                              outputDir:tmpDir
                              maxFrames:maxFrames
                            jpegQuality:quality
                                  error:&extractErr];
  if (!framePaths) {
    [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];
    if (error) *error = extractErr;
    return nil;
  }

  // Compute total video duration so frame timestamps match what
  // the AR session captured.  Pose timestamps are in absolute ms;
  // we normalise against poses[0] so they align with the mp4
  // timeline (which AVAssetWriter wrote starting at 0).
  NSURL *videoURL = [NSURL fileURLWithPath:
      ([videoPath hasPrefix:@"file://"]
        ? [videoPath substringFromIndex:[@"file://" length]]
        : videoPath)];
  AVURLAsset *asset = [AVURLAsset assetWithURL:videoURL];
  Float64 totalSeconds = CMTimeGetSeconds(asset.duration);
  if (!isfinite(totalSeconds) || totalSeconds <= 0) {
    [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1031
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Could not read video duration for pose-time alignment.",
      }];
    }
    return nil;
  }
  double baseMs = [poses[0][@"timestampMs"] doubleValue];

  // Match each extracted frame to its closest pose by timestamp.
  // Tolerance is 100 ms — at 60 Hz pose log + 30 fps frame extract,
  // worst case is ~17 ms drift, plenty of headroom.
  NSInteger N = (NSInteger)framePaths.count;
  std::vector<cv::Mat> frames;
  std::vector<cv::detail::CameraParams> cameras;
  frames.reserve(N);
  cameras.reserve(N);
  int matched = 0, dropped = 0;
  for (NSInteger i = 0; i < N; i++) {
    Float64 fraction = (N == 1) ? 0.0 : ((Float64)i / (Float64)(N - 1));
    Float64 frameTimeMs = fraction * totalSeconds * 1000.0;

    NSDictionary *bestPose = nil;
    double bestDelta = INFINITY;
    for (NSDictionary *pose in poses) {
      double poseMs = [pose[@"timestampMs"] doubleValue] - baseMs;
      double delta = fabs(poseMs - frameTimeMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestPose = pose;
      }
    }
    if (!bestPose || bestDelta > 100.0) {
      dropped++;
      continue;
    }
    // V16 Phase 1.fix3 — IMREAD_IGNORE_ORIENTATION parity with the
    // batch-keyframe path.  AVAssetImageGenerator writes JPEGs with
    // EXIF Orientation tags; cv::imread defaults (OpenCV 4.5+) apply
    // them, returning rotated pixels that don't match the pose's
    // intrinsics (which describe the unrotated landscape sensor).
    // Force raw landscape pixels for the stitcher.
    cv::Mat img = cv::imread([framePaths[i] UTF8String],
                             cv::IMREAD_COLOR | cv::IMREAD_IGNORE_ORIENTATION);
    if (img.empty()) {
      dropped++;
      continue;
    }
    frames.push_back(img);
    cameras.push_back(cameraParamsFromPose(bestPose));
    matched++;
  }
  NSLog(@"[BatchStitcher] pose-driven: matched=%d dropped=%d",
        matched, dropped);

  if (frames.size() < 2) {
    [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1032
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Fewer than 2 frames matched a pose within tolerance — "
           "AR tracking may have been lost during the pan.",
      }];
    }
    return nil;
  }

  auto t0 = std::chrono::steady_clock::now();
  cv::Mat panorama;

  @autoreleasepool {
  try {
    // Pose-driven path: cameras already populated.  intrinsics are
    // at the source frame's native resolution, so work_scale = 1.0.
    int origCols = frames[0].cols;
    int origRows = frames[0].rows;
    double origMp = (double)origCols * origRows / 1e6;
    constexpr double COMPOSE_MP = 1.0;
    double compose_scale = (origMp > COMPOSE_MP)
        ? std::sqrt(COMPOSE_MP / origMp)
        : 1.0;
    double compose_work_aspect = compose_scale;  // work_scale == 1

    // No camera-0 normalisation in the pose-driven path.
    //
    // I added one previously thinking it matched cv::Stitcher's BA
    // convention.  In fact it BROKE the natural orientation: BA
    // normalises into a frame where camera 0's "up" is the panorama
    // up; for pose-driven, the cameras already live in ARKit's
    // gravity-aligned world (Y-up = scene up regardless of phone
    // orientation), so passing R values in ARKit's world frame is
    // exactly what cv::detail::SphericalWarper wants — it unwraps
    // the sphere with world's +Y as up, giving correct orientation
    // for any phone pose + any pan direction.  Normalising rotated
    // the panorama 90° (the user's left-to-right pan in portrait
    // came out with natural-up on the side).
    //
    // waveCorrect below provides the per-camera fine alignment that
    // BA would have done in the feature-matched path.

    // Optional waveCorrect — uses HORIZ to match the feature-
    // matched path.  Operators may pan in any direction; HORIZ
    // aligns each camera's "up" to the world Y axis (gravity),
    // which is what we want for both portrait+horizontal and
    // landscape+vertical pans (assuming the user keeps the phone
    // oriented to gravity, which is the typical handheld case).
    std::vector<cv::Mat> rmats;
    rmats.reserve(cameras.size());
    for (const auto &cam : cameras) rmats.push_back(cam.R.clone());
    try {
      cv::detail::waveCorrect(rmats, cv::detail::WAVE_CORRECT_HORIZ);
      for (size_t i = 0; i < cameras.size(); i++) {
        cameras[i].R = rmats[i];
      }
    } catch (const cv::Exception &e) {
      NSLog(@"[BatchStitcher] pose: wave correction skipped: %s", e.what());
    }

    // Rescale intrinsics for compose-scale warping.
    for (auto &cam : cameras) {
      cam.focal *= compose_work_aspect;
      cam.ppx   *= compose_work_aspect;
      cam.ppy   *= compose_work_aspect;
    }

    std::vector<double> focals;
    for (const auto &cam : cameras) focals.push_back(cam.focal);
    std::sort(focals.begin(), focals.end());
    float warpedScale = focals.empty() ? 1.0f
                                       : (float)focals[focals.size() / 2];

    cv::Ptr<cv::WarperCreator> warperCreator;
    if ([warperType isEqualToString:@"cylindrical"]) {
      warperCreator = cv::makePtr<cv::CylindricalWarper>();
    } else if ([warperType isEqualToString:@"spherical"]) {
      warperCreator = cv::makePtr<cv::SphericalWarper>();
    } else {
      warperCreator = cv::makePtr<cv::PlaneWarper>();
    }
    cv::Ptr<cv::detail::RotationWarper> warper =
        warperCreator->create(warpedScale);

    // Build composeFrames at COMPOSE_MP from full-res input.
    std::vector<cv::Mat> composeFrames;
    composeFrames.reserve(frames.size());
    for (const auto &f : frames) {
      cv::Mat scaled;
      if (std::abs(compose_scale - 1.0) > 1e-3) {
        cv::resize(f, scaled, cv::Size(), compose_scale, compose_scale,
                   cv::INTER_AREA);
      } else {
        scaled = f.clone();
      }
      composeFrames.push_back(scaled);
    }
    for (auto &f : frames) f.release();
    frames.clear();

    // Build the blender (same selection logic as the feature-matched
    // path).  The "u != 0" UMat assertion the original feature-matched
    // builds hit was OOM-induced; with the per-frame Mat releases
    // and @autoreleasepool from that path's stabilisation, MultiBand
    // + GraphCut are safe here too.
    BOOL useSeam = [seamFinderType isEqualToString:@"graphcut"];
    cv::Ptr<cv::detail::Blender> blender;
    if ([blenderType isEqualToString:@"feather"]) {
      blender = cv::detail::Blender::createDefault(
          cv::detail::Blender::FEATHER, false);
      auto fb = blender.dynamicCast<cv::detail::FeatherBlender>();
      if (fb) fb->setSharpness(0.02f);
    } else {
      blender = cv::detail::Blender::createDefault(
          cv::detail::Blender::MULTI_BAND, false);
      auto mbb = blender.dynamicCast<cv::detail::MultiBandBlender>();
      if (mbb) mbb->setNumBands(5);
    }

    if (useSeam) {
      const size_t M = composeFrames.size();
      std::vector<cv::Point> corners(M);
      std::vector<cv::Mat> imagesWarped(M);
      std::vector<cv::Mat> masksWarped(M);
      std::vector<cv::Size> sizes(M);
      for (size_t i = 0; i < M; i++) {
        cv::Mat K;
        cameras[i].K().convertTo(K, CV_32F);
        cv::Mat mask(composeFrames[i].size(), CV_8U, cv::Scalar(255));
        corners[i] = warper->warp(
            composeFrames[i], K, cameras[i].R, cv::INTER_LINEAR,
            cv::BORDER_CONSTANT, imagesWarped[i]);
        warper->warp(mask, K, cameras[i].R, cv::INTER_NEAREST,
                     cv::BORDER_CONSTANT, masksWarped[i]);
        sizes[i] = imagesWarped[i].size();
      }
      for (auto &cf : composeFrames) cf.release();
      composeFrames.clear();

      // Seam finder at SEAM_MP scale (same downscale-find-upscale
      // pattern as the feature-matched path).
      const double SEAM_MP = 0.1;
      double seam_scale = std::min(1.0, std::sqrt(SEAM_MP / origMp));
      double seam_compose_aspect = seam_scale / compose_scale;
      std::vector<cv::UMat> imagesWarpedF_seam(M);
      std::vector<cv::UMat> masksWarpedU_seam(M);
      std::vector<cv::Point> corners_seam(M);
      for (size_t i = 0; i < M; i++) {
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
      cv::Ptr<cv::detail::SeamFinder> seamFinder =
          cv::makePtr<cv::detail::GraphCutSeamFinder>(
              cv::detail::GraphCutSeamFinder::COST_COLOR);
      seamFinder->find(imagesWarpedF_seam, corners_seam, masksWarpedU_seam);
      imagesWarpedF_seam.clear();
      for (size_t i = 0; i < M; i++) {
        cv::Mat seamMaskCpu, seamMaskDilated, seamMaskFull;
        masksWarpedU_seam[i].copyTo(seamMaskCpu);
        cv::dilate(seamMaskCpu, seamMaskDilated, cv::Mat());
        cv::resize(seamMaskDilated, seamMaskFull,
                   masksWarped[i].size(), 0, 0, cv::INTER_LINEAR);
        cv::bitwise_and(seamMaskFull, masksWarped[i], masksWarped[i]);
      }
      masksWarpedU_seam.clear();

      blender->prepare(corners, sizes);
      for (size_t i = 0; i < M; i++) {
        cv::Mat imgS;
        imagesWarped[i].convertTo(imgS, CV_16S);
        blender->feed(imgS, masksWarped[i], corners[i]);
        imagesWarped[i].release();
        masksWarped[i].release();
        imgS.release();
      }
      imagesWarped.clear();
      masksWarped.clear();
    } else {
      // STREAM path
      const size_t M = composeFrames.size();
      std::vector<cv::Point> corners(M);
      std::vector<cv::Size> sizes(M);
      for (size_t i = 0; i < M; i++) {
        cv::Mat K;
        cameras[i].K().convertTo(K, CV_32F);
        cv::Mat mask(composeFrames[i].size(), CV_8U, cv::Scalar(255));
        cv::Mat tmpMaskWarped;
        corners[i] = warper->warp(
            mask, K, cameras[i].R, cv::INTER_NEAREST,
            cv::BORDER_CONSTANT, tmpMaskWarped);
        sizes[i] = tmpMaskWarped.size();
      }
      blender->prepare(corners, sizes);
      for (size_t i = 0; i < M; i++) {
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
        composeFrames[i].release();
      }
      composeFrames.clear();
    }

    cv::Mat panoramaS, panoramaMask;
    blender->blend(panoramaS, panoramaMask);
    panoramaS.convertTo(panorama, CV_8U);
  } catch (const cv::Exception &e) {
    [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1100
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"OpenCV exception during pose-driven stitch: %s", e.what()],
      }];
    }
    return nil;
  } catch (...) {
    [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1102
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Unknown exception during pose-driven stitch.",
      }];
    }
    return nil;
  }
  }  // end @autoreleasepool

  if (panorama.empty()) {
    [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1003
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Pose-driven stitch produced an empty panorama.",
      }];
    }
    return nil;
  }

  // Crop to bounding box (skip the column-projection rect crop —
  // pose-driven stitches don't have the hourglass shape that
  // plane-warper feature-matched panoramas produce).
  cv::Mat finalImage = panorama;
  try {
    cv::Mat gray;
    cv::cvtColor(panorama, gray, cv::COLOR_BGR2GRAY);
    cv::Mat mask;
    cv::threshold(gray, mask, 1, 255, cv::THRESH_BINARY);
    cv::Rect bbox = cv::boundingRect(mask);
    if (bbox.width > 0 && bbox.height > 0
        && bbox.width <= panorama.cols && bbox.height <= panorama.rows) {
      finalImage = panorama(bbox).clone();
    }
  } catch (...) {
    finalImage = panorama;
  }

  auto t1 = std::chrono::steady_clock::now();
  double durationMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

  NSInteger clampedQuality = MAX(0, MIN(100, quality));
  std::vector<int> params = {
      cv::IMWRITE_JPEG_QUALITY, static_cast<int>(clampedQuality),
  };
  NSString *cleanedOutPath = ([outputPath hasPrefix:@"file://"]
      ? [outputPath substringFromIndex:[@"file://" length]]
      : outputPath);
  bool wrote = cv::imwrite([cleanedOutPath UTF8String], finalImage, params);

  // Cleanup the tmp dir always.
  [[NSFileManager defaultManager] removeItemAtPath:tmpDir error:nil];

  if (!wrote) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1002
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"Pose-driven stitch succeeded but could not write JPEG to %@",
            outputPath],
      }];
    }
    return nil;
  }

  return [[RetaiLensStitchResult alloc]
      initWithOutputPath:outputPath
                   width:(NSInteger)finalImage.cols
                  height:(NSInteger)finalImage.rows
              durationMs:durationMs];
}


// ─────────────────────────────────────────────────────────────────────
// V16 Phase 1: pose-driven stitch over explicit keyframe paths
// ─────────────────────────────────────────────────────────────────────
//
// Same compose stage as the video-driven pose path above, minus the
// AVAssetImageGenerator extract + timestamp-matching step.  Frames
// arrive as already-on-disk JPEGs from the AR-keyframe capture flow;
// poses are 1:1 with frames (KeyframeGate saved both as the user
// panned).  Compose code is duplicated per the convention noted
// above ("DRY when the new path is proven on real shelf captures").
//
// AUDIT NOTE (2026-05-15, sibling @autoreleasepool-return audit)
// ──────────────────────────────────────────────────────────────
//
// This method (and the pose-driven `stitchVideoAtPath:withPoses:`
// variant earlier in this file at ~line 2162) BOTH have the same
// @autoreleasepool-return-UAF pattern that V16 fix-10 closed in
// `stitchFramePaths:` at line 597 — autoreleased NSError* assigned
// to the `error` outparameter from inside an @autoreleasepool, then
// the function returns, the pool drains, the NSError dangles, the
// caller crashes dereferencing.  See:
//   docs/site-content/design/2026-05-12-finalize-crash-investigation.md
//
// CURRENT REACHABILITY: BOTH methods are dead code as of 2026-05-15.
// Confirmed by grep — only referenced in dSYM debug symbols + comments,
// never actually called from Swift/Obj-C/Kotlin source paths.  V16
// batch-keyframe uses `stitchFramePaths:` exclusively; this method
// was the earlier per-keyframe-with-pose design that was superseded.
//
// IF/WHEN RE-ENABLED, apply fix-10's pattern (also in this file
// around `stitchFramePaths:` lines 562-571 + 1519-1527):
//
//   NSError *capturedError = nil;
//   RetaiLensStitchResult *result = nil;
//   @autoreleasepool {
//     do {
//       try { ... ; result = [[RetaiLensStitchResult alloc] init...]; break; }
//       catch (cv::Exception &e) { capturedError = [NSError ...]; break; }
//       catch (...) { capturedError = [NSError ...]; break; }
//     } while (0);
//   }
//   if (capturedError) { if (error) *error = capturedError; return nil; }
//   return result;
//
// Strong locals (`capturedError`, `result`) are declared OUTSIDE the
// @autoreleasepool so their refcount survives the pool drain.  Both
// success + failure paths exit the pool via `break` rather than
// `return nil;` so the pool drains cleanly before the function
// returns.
//
// Not applied now because the methods aren't called; risk is latent
// not active.  Refactoring dead code carries its own risk (subtle
// behaviour changes) without active testing.

+ (nullable RetaiLensStitchResult *)stitchKeyframePaths:(NSArray<NSString *> *)framePaths
                                            outputPath:(NSString *)outputPath
                                           jpegQuality:(NSInteger)quality
                                            warperType:(NSString *)warperType
                                           blenderType:(NSString *)blenderType
                                        seamFinderType:(NSString *)seamFinderType
                                                 poses:(NSArray<NSDictionary *> *)poses
                                                 error:(NSError **)error {
  if (warperType == nil || warperType.length == 0) warperType = @"plane";
  if (blenderType == nil || blenderType.length == 0) blenderType = @"multiband";
  if (seamFinderType == nil || seamFinderType.length == 0) seamFinderType = @"graphcut";
  if (framePaths.count < 2) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1030
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Keyframe stitch needs at least 2 frames; got fewer.",
      }];
    }
    return nil;
  }
  if (framePaths.count != poses.count) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1033
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"Keyframe stitch requires 1:1 paths/poses; "
             "got %lu paths, %lu poses.",
            (unsigned long)framePaths.count,
            (unsigned long)poses.count],
      }];
    }
    return nil;
  }

  // V16 Phase 1 — memory diagnostic instrumentation.  Each stage
  // logs phys_footprint (the metric jetsam evaluates) so we can
  // bisect the stage that pushed us into OS-watchdog termination.
  // FAULT level so iOS doesn't drop logs under burst.
  os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
         "[V16-stitch-mem] ENTER framePaths=%d posesCount=%d phys=%.1fMB",
         (int)framePaths.count, (int)poses.count, StitcherResidentMB());

  // Load each path → cv::Mat + cameraParams.  Drop any that fail
  // to load (corrupt JPEG, missing file) — but require ≥2 to
  // succeed for a panorama to be possible.
  //
  // V16 Phase 1.fix2 — IMREAD_IGNORE_ORIENTATION: collector saves
  // JPEGs with an EXIF Orientation tag so iOS Image renderers (e.g.
  // LiveFrameStrip) display correctly.  cv::imread defaults (since
  // OpenCV 4.5+) APPLY the EXIF rotation; that would re-introduce
  // the image-vs-intrinsics mismatch fix1 was meant to remove.  Pass
  // IMREAD_IGNORE_ORIENTATION explicitly to get raw landscape sensor
  // pixels for the stitcher.
  std::vector<cv::Mat> frames;
  std::vector<cv::detail::CameraParams> cameras;
  frames.reserve(framePaths.count);
  cameras.reserve(framePaths.count);
  int loaded = 0, dropped = 0;
  for (NSInteger i = 0; i < (NSInteger)framePaths.count; i++) {
    NSString *path = framePaths[i];
    NSString *cleaned = ([path hasPrefix:@"file://"]
        ? [path substringFromIndex:[@"file://" length]]
        : path);
    cv::Mat img = cv::imread([cleaned UTF8String],
                             cv::IMREAD_COLOR | cv::IMREAD_IGNORE_ORIENTATION);
    if (img.empty()) {
      dropped++;
      continue;
    }
    frames.push_back(img);
    cameras.push_back(cameraParamsFromPose(poses[i]));
    loaded++;
  }
  NSLog(@"[BatchStitcher] keyframe-stitch: loaded=%d dropped=%d",
        loaded, dropped);
  if (!frames.empty()) {
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
           "[V16-stitch-mem] AFTER imread N=%d size=%dx%d totalMB=%.1f phys=%.1fMB",
           (int)frames.size(),
           frames[0].cols, frames[0].rows,
           (double)frames.size() * frames[0].cols * frames[0].rows * 3
             / (1024.0 * 1024.0),
           StitcherResidentMB());
  }

  if (frames.size() < 2) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1032
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Fewer than 2 keyframes loaded successfully — JPEGs may "
           "have been corrupted or removed before stitch ran.",
      }];
    }
    return nil;
  }

  auto t0 = std::chrono::steady_clock::now();
  cv::Mat panorama;

  @autoreleasepool {
  try {
    int origCols = frames[0].cols;
    int origRows = frames[0].rows;
    double origMp = (double)origCols * origRows / 1e6;
    constexpr double COMPOSE_MP = 1.0;
    double compose_scale = (origMp > COMPOSE_MP)
        ? std::sqrt(COMPOSE_MP / origMp)
        : 1.0;
    double compose_work_aspect = compose_scale;  // work_scale == 1

    // V16 Phase 1.fix2 — auto-detect pan axis from camera rotation
    // spread.  Compute the std-dev of camera "forward" vectors
    // projected onto each world axis; the axis with the smallest
    // spread is the pan-rotation axis (i.e. rotation about that
    // axis is what differs across frames most).  HORIZ_PAN means
    // rotation about world Y (yaw): use WAVE_CORRECT_HORIZ.
    // VERT_PAN means rotation about world X (pitch): use WAVE_CORRECT_VERT.
    //
    // Earlier hardcoded HORIZ produced misaligned panoramas for
    // Ram's top-to-bottom landscape pan (no yaw spread; pitch
    // spread).  Picking the right axis lets waveCorrect actually
    // help instead of being a no-op (or flipping the panorama).
    cv::detail::WaveCorrectKind waveKind = cv::detail::WAVE_CORRECT_HORIZ;
    if (cameras.size() >= 2) {
      // forward[i] = -3rd-column of R (camera looks along -Z in cv)
      double minF[3] = { 1e9, 1e9, 1e9};
      double maxF[3] = {-1e9,-1e9,-1e9};
      for (const auto &cam : cameras) {
        for (int axis = 0; axis < 3; axis++) {
          double v = -cam.R.at<float>(2, axis);
          if (v < minF[axis]) minF[axis] = v;
          if (v > maxF[axis]) maxF[axis] = v;
        }
      }
      double rangeX = maxF[0] - minF[0];
      double rangeY = maxF[1] - minF[1];
      // Larger Y-range of forward => more vertical (pitch) variation
      // => vertical pan => WAVE_CORRECT_VERT.
      if (rangeY > rangeX) {
        waveKind = cv::detail::WAVE_CORRECT_VERT;
      }
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
             "[V16-stitch-mem] waveKind=%{public}s "
             "rangeForwardX=%.3f rangeForwardY=%.3f",
             (waveKind == cv::detail::WAVE_CORRECT_VERT)
               ? "VERT (vertical pan)"
               : "HORIZ (horizontal pan)",
             rangeX, rangeY);
    }
    std::vector<cv::Mat> rmats;
    rmats.reserve(cameras.size());
    for (const auto &cam : cameras) rmats.push_back(cam.R.clone());
    try {
      cv::detail::waveCorrect(rmats, waveKind);
      for (size_t i = 0; i < cameras.size(); i++) {
        cameras[i].R = rmats[i];
      }
    } catch (const cv::Exception &e) {
      NSLog(@"[BatchStitcher] keyframe: wave correction skipped: %s",
            e.what());
    }

    // Rescale intrinsics for compose-scale warping.
    for (auto &cam : cameras) {
      cam.focal *= compose_work_aspect;
      cam.ppx   *= compose_work_aspect;
      cam.ppy   *= compose_work_aspect;
    }

    std::vector<double> focals;
    for (const auto &cam : cameras) focals.push_back(cam.focal);
    std::sort(focals.begin(), focals.end());
    float warpedScale = focals.empty() ? 1.0f
                                       : (float)focals[focals.size() / 2];

    cv::Ptr<cv::WarperCreator> warperCreator;
    if ([warperType isEqualToString:@"cylindrical"]) {
      warperCreator = cv::makePtr<cv::CylindricalWarper>();
    } else if ([warperType isEqualToString:@"spherical"]) {
      warperCreator = cv::makePtr<cv::SphericalWarper>();
    } else {
      warperCreator = cv::makePtr<cv::PlaneWarper>();
    }
    cv::Ptr<cv::detail::RotationWarper> warper =
        warperCreator->create(warpedScale);

    // Build composeFrames at COMPOSE_MP from full-res input.
    std::vector<cv::Mat> composeFrames;
    composeFrames.reserve(frames.size());
    for (const auto &f : frames) {
      cv::Mat scaled;
      if (std::abs(compose_scale - 1.0) > 1e-3) {
        cv::resize(f, scaled, cv::Size(), compose_scale, compose_scale,
                   cv::INTER_AREA);
      } else {
        scaled = f.clone();
      }
      composeFrames.push_back(scaled);
    }
    for (auto &f : frames) f.release();
    frames.clear();
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
           "[V16-stitch-mem] AFTER composeFrames built+frames cleared "
           "compose_scale=%.3f compose_size=%dx%d phys=%.1fMB",
           compose_scale,
           composeFrames.empty() ? 0 : composeFrames[0].cols,
           composeFrames.empty() ? 0 : composeFrames[0].rows,
           StitcherResidentMB());

    BOOL useSeam = [seamFinderType isEqualToString:@"graphcut"];
    cv::Ptr<cv::detail::Blender> blender;
    if ([blenderType isEqualToString:@"feather"]) {
      blender = cv::detail::Blender::createDefault(
          cv::detail::Blender::FEATHER, false);
      auto fb = blender.dynamicCast<cv::detail::FeatherBlender>();
      if (fb) fb->setSharpness(0.02f);
    } else {
      blender = cv::detail::Blender::createDefault(
          cv::detail::Blender::MULTI_BAND, false);
      auto mbb = blender.dynamicCast<cv::detail::MultiBandBlender>();
      if (mbb) mbb->setNumBands(5);
    }
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
           "[V16-stitch-mem] config blender=%{public}@ seam=%{public}@ warper=%{public}@ phys=%.1fMB",
           blenderType, seamFinderType, warperType, StitcherResidentMB());

    if (useSeam) {
      const size_t M = composeFrames.size();
      std::vector<cv::Point> corners(M);
      std::vector<cv::Mat> imagesWarped(M);
      std::vector<cv::Mat> masksWarped(M);
      std::vector<cv::Size> sizes(M);
      for (size_t i = 0; i < M; i++) {
        cv::Mat K;
        cameras[i].K().convertTo(K, CV_32F);
        cv::Mat mask(composeFrames[i].size(), CV_8U, cv::Scalar(255));
        corners[i] = warper->warp(
            composeFrames[i], K, cameras[i].R, cv::INTER_LINEAR,
            cv::BORDER_CONSTANT, imagesWarped[i]);
        warper->warp(mask, K, cameras[i].R, cv::INTER_NEAREST,
                     cv::BORDER_CONSTANT, masksWarped[i]);
        sizes[i] = imagesWarped[i].size();
      }
      // Compute panorama bbox so we can see if the warped span is
      // unexpectedly large (drives MultiBand pyramid memory).
      int minX = INT_MAX, minY = INT_MAX, maxX = INT_MIN, maxY = INT_MIN;
      for (size_t i = 0; i < M; i++) {
        minX = std::min(minX, corners[i].x);
        minY = std::min(minY, corners[i].y);
        maxX = std::max(maxX, corners[i].x + (int)sizes[i].width);
        maxY = std::max(maxY, corners[i].y + (int)sizes[i].height);
      }
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
             "[V16-stitch-mem] AFTER warps M=%d bbox=%dx%d "
             "warpedTotalMB=%.1f phys=%.1fMB",
             (int)M,
             (maxX > minX ? maxX - minX : 0),
             (maxY > minY ? maxY - minY : 0),
             (double)M * (M ? sizes[0].width : 0)
               * (M ? sizes[0].height : 0) * 3 / (1024.0 * 1024.0),
             StitcherResidentMB());
      const int panBboxW = (maxX > minX ? maxX - minX : 0);
      const int panBboxH = (maxY > minY ? maxY - minY : 0);
      // Quiet `unused variable` warnings if the inner os_log calls
      // are stripped by the compiler in release builds.
      (void)panBboxW; (void)panBboxH;
      for (auto &cf : composeFrames) cf.release();
      composeFrames.clear();
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
             "[V16-stitch-mem] AFTER composeFrames cleared (warps held) phys=%.1fMB",
             StitcherResidentMB());

      const double SEAM_MP = 0.1;
      double seam_scale = std::min(1.0, std::sqrt(SEAM_MP / origMp));
      double seam_compose_aspect = seam_scale / compose_scale;
      std::vector<cv::UMat> imagesWarpedF_seam(M);
      std::vector<cv::UMat> masksWarpedU_seam(M);
      std::vector<cv::Point> corners_seam(M);
      for (size_t i = 0; i < M; i++) {
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
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
             "[V16-stitch-mem] BEFORE GraphCutSeamFinder seam_scale=%.3f phys=%.1fMB",
             seam_scale, StitcherResidentMB());
      cv::Ptr<cv::detail::SeamFinder> seamFinder =
          cv::makePtr<cv::detail::GraphCutSeamFinder>(
              cv::detail::GraphCutSeamFinder::COST_COLOR);
      seamFinder->find(imagesWarpedF_seam, corners_seam, masksWarpedU_seam);
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
             "[V16-stitch-mem] AFTER GraphCutSeamFinder phys=%.1fMB",
             StitcherResidentMB());
      imagesWarpedF_seam.clear();
      for (size_t i = 0; i < M; i++) {
        cv::Mat seamMaskCpu, seamMaskDilated, seamMaskFull;
        masksWarpedU_seam[i].copyTo(seamMaskCpu);
        cv::dilate(seamMaskCpu, seamMaskDilated, cv::Mat());
        cv::resize(seamMaskDilated, seamMaskFull,
                   masksWarped[i].size(), 0, 0, cv::INTER_LINEAR);
        cv::bitwise_and(seamMaskFull, masksWarped[i], masksWarped[i]);
      }
      masksWarpedU_seam.clear();

      blender->prepare(corners, sizes);
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
             "[V16-stitch-mem] AFTER blender->prepare() phys=%.1fMB",
             StitcherResidentMB());
      for (size_t i = 0; i < M; i++) {
        cv::Mat imgS;
        imagesWarped[i].convertTo(imgS, CV_16S);
        blender->feed(imgS, masksWarped[i], corners[i]);
        imagesWarped[i].release();
        masksWarped[i].release();
        imgS.release();
      }
      imagesWarped.clear();
      masksWarped.clear();
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
             "[V16-stitch-mem] AFTER blender->feed() loop (graphcut) phys=%.1fMB",
             StitcherResidentMB());
    } else {
      // STREAM path
      const size_t M = composeFrames.size();
      std::vector<cv::Point> corners(M);
      std::vector<cv::Size> sizes(M);
      for (size_t i = 0; i < M; i++) {
        cv::Mat K;
        cameras[i].K().convertTo(K, CV_32F);
        cv::Mat mask(composeFrames[i].size(), CV_8U, cv::Scalar(255));
        cv::Mat tmpMaskWarped;
        corners[i] = warper->warp(
            mask, K, cameras[i].R, cv::INTER_NEAREST,
            cv::BORDER_CONSTANT, tmpMaskWarped);
        sizes[i] = tmpMaskWarped.size();
      }
      blender->prepare(corners, sizes);
      for (size_t i = 0; i < M; i++) {
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
        composeFrames[i].release();
      }
      composeFrames.clear();
    }

    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
           "[V16-stitch-mem] BEFORE blender->blend() phys=%.1fMB",
           StitcherResidentMB());
    cv::Mat panoramaS, panoramaMask;
    blender->blend(panoramaS, panoramaMask);
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
           "[V16-stitch-mem] AFTER blender->blend() panorama=%dx%d phys=%.1fMB",
           panoramaS.cols, panoramaS.rows, StitcherResidentMB());
    panoramaS.convertTo(panorama, CV_8U);
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
           "[V16-stitch-mem] AFTER 16S->8U convert phys=%.1fMB",
           StitcherResidentMB());
  } catch (const cv::Exception &e) {
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
           "[V16-stitch-mem] cv::Exception: %{public}s phys=%.1fMB",
           e.what(), StitcherResidentMB());
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1100
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"OpenCV exception during keyframe stitch: %s", e.what()],
      }];
    }
    return nil;
  } catch (...) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1102
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Unknown exception during keyframe stitch.",
      }];
    }
    return nil;
  }
  }  // end @autoreleasepool

  if (panorama.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1003
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Keyframe stitch produced an empty panorama.",
      }];
    }
    return nil;
  }

  // Crop to bounding box.
  cv::Mat finalImage = panorama;
  try {
    cv::Mat gray;
    cv::cvtColor(panorama, gray, cv::COLOR_BGR2GRAY);
    cv::Mat mask;
    cv::threshold(gray, mask, 1, 255, cv::THRESH_BINARY);
    cv::Rect bbox = cv::boundingRect(mask);
    if (bbox.width > 0 && bbox.height > 0
        && bbox.width <= panorama.cols && bbox.height <= panorama.rows) {
      finalImage = panorama(bbox).clone();
    }
  } catch (...) {
    finalImage = panorama;
  }
  os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
         "[V16-stitch-mem] AFTER crop final=%dx%d phys=%.1fMB",
         finalImage.cols, finalImage.rows, StitcherResidentMB());

  auto t1 = std::chrono::steady_clock::now();
  double durationMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

  NSInteger clampedQuality = MAX(0, MIN(100, quality));
  std::vector<int> params = {
      cv::IMWRITE_JPEG_QUALITY, static_cast<int>(clampedQuality),
  };
  NSString *cleanedOutPath = ([outputPath hasPrefix:@"file://"]
      ? [outputPath substringFromIndex:[@"file://" length]]
      : outputPath);
  bool wrote = cv::imwrite([cleanedOutPath UTF8String], finalImage, params);
  os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
         "[V16-stitch-mem] AFTER cv::imwrite ok=%d total=%.0fms phys=%.1fMB",
         wrote ? 1 : 0, durationMs, StitcherResidentMB());

  if (!wrote) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1002
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"Keyframe stitch succeeded but could not write JPEG to %@",
            outputPath],
      }];
    }
    return nil;
  }

  return [[RetaiLensStitchResult alloc]
      initWithOutputPath:outputPath
                   width:(NSInteger)finalImage.cols
                  height:(NSInteger)finalImage.rows
              durationMs:durationMs];
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
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
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

@end
