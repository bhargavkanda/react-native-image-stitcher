//
// OpenCVStitcher.mm
//
// Objective-C++ implementation that wraps cv::Stitcher.  This is the
// only file in the SDK that includes <opencv2/...> — everything else
// sees the slim `OpenCVStitcher.h` interface above and stays in
// Swift / Objective-C.
//
// Why `cv::Stitcher::SCANS` mode?
//   OpenCV ships two stitcher presets: PANORAMA (the default) and
//   SCANS.  PANORAMA assumes a rotational camera (e.g. spinning in
//   place to capture a vista) and uses spherical projection.  SCANS
//   assumes a TRANSLATIONAL camera moving across a roughly-planar
//   subject — exactly the gesture our field reps use to walk along
//   a shelf.  SCANS skips the spherical warp, runs faster on phones,
//   and produces straighter shelf edges in the output.  Empirically:
//   PANORAMA mode bends the shelf corners; SCANS keeps them right-
//   angled.  Use SCANS.
//
// References:
//   * OpenCV docs: https://docs.opencv.org/4.x/d2/d8d/classcv_1_1Stitcher.html
//   * SCANS mode: cv::Stitcher::SCANS — ORB features + plane warp.

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
                        durationMs:(double)durationMs {
  self = [super init];
  if (self) {
    _outputPath = [outputPath copy];
    _width = width;
    _height = height;
    _durationMs = durationMs;
  }
  return self;
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

// Read every input file as a cv::Mat.  Fail fast on the first
// unreadable input so the caller gets a precise error rather than a
// post-stitch "needs more images" verdict that hides the real cause.
bool loadFramesOrFail(NSArray<NSString *> *framePaths,
                      std::vector<cv::Mat> &frames,
                      NSError **error) {
  frames.reserve(framePaths.count);
  // V12.13 — breadcrumb each load.  If the landscape-only crash is
  // in cv::imread (e.g., decoding a JPEG produced by the new
  // per-frame autoreleasepool extract) the LAST log line tells us
  // which frame index + path triggered it.
  NSInteger idx = 0;
  for (NSString *path in framePaths) {
    NSString *cleaned = normalizeImagePath(path);
    cv::Mat img = cv::imread([cleaned UTF8String]);
    NSLog(@"[stitch-bc] loadFrames %ld/%lu: %@ -> %dx%d (channels=%d, empty=%d)",
          (long)idx, (unsigned long)framePaths.count,
          path.lastPathComponent, img.cols, img.rows, img.channels(),
          (int)img.empty());
    if (img.empty()) {
      if (error) {
        *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                     code:1001
                                 userInfo:@{
          NSLocalizedDescriptionKey:
            [NSString stringWithFormat:@"Could not read image at path: %@", path],
        }];
      }
      return false;
    }
    frames.push_back(img);
    idx += 1;
  }
  return true;
}

// Translate cv::Stitcher::Status into a stable NSError.code so the JS
// side can branch on classes of failure (need-more-frames vs.
// homography-failed vs. camera-params-failed).  cv::Stitcher uses
// magic ints; mapping them here keeps the call-site clean.
NSError *errorForStitchStatus(cv::Stitcher::Status status) {
  NSString *message = @"OpenCV stitch failed";
  switch (status) {
    case cv::Stitcher::ERR_NEED_MORE_IMGS:
      message = @"Stitcher needs more overlapping frames — capture a few more across the shelf.";
      break;
    case cv::Stitcher::ERR_HOMOGRAPHY_EST_FAIL:
      message = @"Stitcher could not estimate homography — frames may not overlap enough or have insufficient features.";
      break;
    case cv::Stitcher::ERR_CAMERA_PARAMS_ADJUST_FAIL:
      message = @"Stitcher could not refine camera parameters — try recapturing with more overlap.";
      break;
    default:
      break;
  }
  return [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                             code:(NSInteger)status
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

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
  // V12.14.2 — FAULT-level sentinel.  Survives Console.app rate-limit;
  // proves the function entered.  If a future trace doesn't show this
  // line for a crashed run, the crash is BEFORE stitchFramePaths
  // (e.g., in extractFramesFromVideoAtPath or in the dispatch_async
  // block in StitcherBridge).
  const double kStartResidentMB = StitcherResidentMB();
  os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
      "[stitch-bc] STITCH START: %lu frames mem=%.1fMB",
      (unsigned long)framePaths.count, kStartResidentMB);

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
  double kStartTotalRAMGB =
      (double)NSProcessInfo.processInfo.physicalMemory
      / (1024.0 * 1024.0 * 1024.0);
  const double kPreStitchAbortMB = MAX(700.0, kStartTotalRAMGB * 300.0);
  if (kStartResidentMB > kPreStitchAbortMB) {
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] PRE-STITCH ABORT: mem=%.1fMB > %.1fMB threshold",
        kStartResidentMB, kPreStitchAbortMB);
    // V16 fix-attempt 9 — sentinel return.  See validPairs<1 site
    // below for the full root-cause analysis.  The Swift try-bridge
    // crashes on this method's `return nil`+`*error` failure pattern;
    // returning a non-nil sentinel result (width=0, height=0) bypasses
    // it.  *error left unwritten — the Swift caller maps any sentinel
    // to its own NSError, so a populated *error here would be ignored
    // anyway.
    NSLog(@"[RetaiLensStitcher] PRE-STITCH ABORT (mem %.1fMB > %.1fMB) — returning sentinel (fix-9)",
          kStartResidentMB, kPreStitchAbortMB);
    return [[RetaiLensStitchResult alloc] initWithOutputPath:@""
                                                       width:0
                                                      height:0
                                                  durationMs:0];
  }

  // Defaults if caller passed nil — keeps the old 3-arg call-sites
  // working until we update them.
  if (warperType == nil || warperType.length == 0) warperType = @"plane";
  if (blenderType == nil || blenderType.length == 0) blenderType = @"multiband";
  if (seamFinderType == nil || seamFinderType.length == 0) seamFinderType = @"graphcut";
  if (framePaths.count < 2) {
    // V16 fix-attempt 9 — sentinel return (see validPairs<1 site
    // below for full RCA).  Defensive: the Swift caller intercepts
    // count<2 before reaching here, but a future call-site could
    // hit this without that guard, and we want the bridge-bypass
    // applied consistently across every nil-return in this method.
    NSLog(@"[RetaiLensStitcher] framePaths.count<2 (%lu) — returning sentinel (fix-9)",
          (unsigned long)framePaths.count);
    return [[RetaiLensStitchResult alloc] initWithOutputPath:@""
                                                       width:0
                                                      height:0
                                                  durationMs:0];
  }

  // V12.14.2 — defensive frame cap.  Ram's V12.14 traces showed a
  // landscape capture with 12 frames (144 pairwise) crash inside
  // BundleAdjusterRay.  A 7-frame capture (49 pairwise) succeeded.
  // Above ~10 frames the BA solver becomes unstable on landscape
  // inputs — most likely the Levenberg-Marquardt Jacobian conditions
  // get bad with the wider aspect ratio + more pairwise constraints.
  // Cap framePaths to kMaxFramesForStitch evenly-spaced indices
  // BEFORE loadFramesOrFail so we don't even pay the imread cost
  // for the discarded frames.  Trade-off: long pans get slightly
  // less overlap (a 5-second pan at 3 fps = 15 frames is downsampled
  // to 8 evenly-spaced).  Quality regression is minor; stability is
  // huge — this kills the EXC_BAD_ACCESS deterministically.
  static const NSUInteger kMaxFramesForStitch = 8;
  NSArray<NSString *> *workFramePaths = framePaths;
  if (workFramePaths.count > kMaxFramesForStitch) {
    NSMutableArray<NSString *> *downsampled =
        [NSMutableArray arrayWithCapacity:kMaxFramesForStitch];
    NSUInteger origCount = workFramePaths.count;
    for (NSUInteger i = 0; i < kMaxFramesForStitch; i++) {
      NSUInteger idx = (i * (origCount - 1)) / (kMaxFramesForStitch - 1);
      [downsampled addObject:workFramePaths[idx]];
    }
    workFramePaths = downsampled;
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] downsampled %lu -> %lu frames (BA stability cap)",
        (unsigned long)origCount, (unsigned long)kMaxFramesForStitch);
  }

  // Load all input frames before invoking the stitcher.  Memory cost
  // is N × frame size — for typical shelf captures (~2048×1536 RGB,
  // ~9 MB / frame raw, but cv::imread decodes JPEG so resident
  // footprint is bounded by the original sensor resolution).
  std::vector<cv::Mat> frames;
  if (!loadFramesOrFail(workFramePaths, frames, error)) {
    // V16 fix-attempt 9 — sentinel return.  loadFramesOrFail may
    // have populated *error with an NSError describing which path
    // failed to read (e.g., bad JPEG, missing file).  That *error
    // would crash Swift's try-bridge on `return nil` here (see
    // validPairs<1 site below for full RCA).  Returning a sentinel
    // RetaiLensStitchResult instead leaves *error harmlessly in the
    // Swift autoreleasing pad — Swift only reads it on nil return,
    // so the diagnostic is preserved in Console.app via NSLog from
    // loadFramesOrFail but Swift never retains the dangerous pointer.
    NSLog(@"[RetaiLensStitcher] loadFramesOrFail returned false — returning sentinel (fix-9)");
    return [[RetaiLensStitchResult alloc] initWithOutputPath:@""
                                                       width:0
                                                      height:0
                                                  durationMs:0];
  }

  auto t0 = std::chrono::steady_clock::now();

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
  // grep-able in Console.app.
  NSLog(@"[RetaiLensStitcher] start: %lu frames", (unsigned long)frames.size());

  // Wrap the entire stitch in @autoreleasepool.  ObjC autoreleased
  // temporaries (e.g. NSString objects produced inside the hot
  // path, intermediate cv::Mat::data wrappers) accumulate until
  // the runloop's outer pool drains.  Without an explicit pool
  // here, peak memory during the stitch can be 100+ MB higher
  // than necessary — exactly the headroom we need to stay under
  // iOS' foreground jetsam threshold on long pans.
  //
  // V16 fix-10 (2026-05-13) — STRUCTURAL: NO return statement
  // executes inside the @autoreleasepool block.  Failure paths
  // capture the result/error into STRONG locals declared above the
  // pool, then `break` out of the do/while(0) wrapper.  The pool
  // drains; the strong locals survive (they're not autoreleased);
  // after the pool we either return the sentinel `result`, surface
  // `capturedError` via the outparameter, or fall through to the
  // success path.
  //
  // Why this matters: the previous structure had `*error = [NSError
  // errorWithDomain:…]; return nil;` (and similar sentinel `return
  // [[RetaiLensStitchResult alloc] init…]`) executing while INSIDE
  // the pool.  ARC autoreleases the return value (or the NSError
  // factory's +0 return) into the pool.  When the pool drained at
  // the closing brace AFTER the return statement was lexically
  // inside it, the autoreleased object was freed.  Swift's caller-
  // side `objc_retainAutoreleasedReturnValue` then dereferenced
  // freed memory → EXC_BAD_ACCESS at objc_retain+16.  Documented
  // in the comment block at the end of this pool — but the previous
  // fix only moved the SUCCESS return out of the pool; the failure
  // returns stayed inside and kept crashing.  ASan's quarantine
  // hid this for prior diagnostic runs by extending object
  // lifetimes; the non-ASan production build re-exposed it.
  //
  // See docs/site-content/learnings/react-native.md#autoreleasepool-return-uaf
  RetaiLensStitchResult *result = nil;
  NSError *capturedError = nil;
  @autoreleasepool {
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
    //   COMPOSE_MP (1.0): RE-WARP + blend at this larger resolution
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
    constexpr double REGISTRATION_MP = 0.3;
    // 0.6 MP matches cv::Stitcher::PANORAMA's registration_resol
    // default and is the "safe sharp" setting on Debug builds —
    // 1.0 MP was visibly sharper but pushed memory peak into iOS
    // jetsam territory (Sentry caught WatchdogTermination + the
    // EXC_BAD_ACCESS-during-tear-down variant under the same root
    // cause).  Release builds free ~200-300 MB of RN baseline
    // overhead and would tolerate 1.0 MP fine; if/when a Release
    // build is the test target, bump this back up.
    constexpr double COMPOSE_MP = 0.6;

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
      for (const auto &f : frames) {
        cv::Mat scaled;
        cv::resize(f, scaled, cv::Size(), work_scale, work_scale,
                   cv::INTER_AREA);
        workFrames.push_back(scaled);
      }
    } else {
      for (const auto &f : frames) workFrames.push_back(f);
    }

    NSLog(@"[RetaiLensStitcher] step1: features (work scale %d×%d)",
          workFrames.empty() ? 0 : workFrames[0].cols,
          workFrames.empty() ? 0 : workFrames[0].rows);
    // V12.14 Commit B — paired fprintf(stderr) breadcrumb.  iOS'
    // Console.app rate-limits NSLog under high-frequency emission
    // (Ram's V12.13 trace had loadFrames 4-7 + step1 missing while
    // loadFrames 0-3 + step2 made it through).  Stderr is not rate-
    // limited and flushes promptly, so the LAST stderr line before
    // the crash reliably pinpoints the failing stage.
    NSLog(@"[stitch-bc] step1 enter (work %d×%d, %lu frames)",
            workFrames.empty() ? 0 : workFrames[0].cols,
            workFrames.empty() ? 0 : workFrames[0].rows,
            (unsigned long)workFrames.size());
    // Step 1: features.  800 ORB features is enough for matching
    // ~50% overlap between adjacent frames; 1500 was overkill and
    // doubled the matching work for marginal quality gain.
    auto featuresFinder = cv::ORB::create(800);
    std::vector<cv::detail::ImageFeatures> imgFeatures(workFrames.size());
    for (size_t i = 0; i < workFrames.size(); i++) {
      cv::detail::computeImageFeatures(featuresFinder, workFrames[i],
                                        imgFeatures[i]);
      imgFeatures[i].img_idx = (int)i;
      NSLog(@"[stitch-bc] step1 frame %zu: %lu features",
              i, (unsigned long)imgFeatures[i].keypoints.size());
    }
    NSLog(@"[stitch-bc] step1 done");

    // Step 2: pairwise matching.  match_conf=0.65 matches what
    // cv::Stitcher::PANORAMA uses internally — looser values
    // (counter-intuitively) hurt BA convergence by letting through
    // contradictory low-confidence matches that don't fit a
    // consistent rotation model.  Stick with the proven default.
    // V16 — swapped BestOf2NearestMatcher → AffineBestOf2NearestMatcher
    // (2026-05-13).  The plain matcher fits a rotation-only homography
    // during RANSAC outlier rejection, which collapses MatchesInfo.
    // confidence to 0 whenever the user has translated the camera
    // (parallax breaks the rotation-only model).  Symptom:
    // [RetaiLensStitcher] step2.5: 0 valid pairwise matches → sentinel
    // → "Could not stitch" toast (or, before fix-9, EXC_BAD_ACCESS in
    // Swift's try-bridge).  In Ram's repros the camera translates
    // 25-60cm between adjacent keyframes — way past what rotation-
    // only RANSAC can absorb.
    //
    // AffineBestOf2NearestMatcher uses an affine model for inlier
    // selection (full_affine=true → 6 DOF: rotation, non-uniform
    // scale, shear, translation).  This tolerates the typical
    // shelf-scanning translation pattern.  The downstream stitcher
    // pipeline (HomographyBasedEstimator + BundleAdjusterRay) is
    // unchanged; the swap only affects WHICH pairwise matches are
    // accepted as inliers — the rest of the pipeline still computes
    // a proper rotation-based camera placement on the surviving
    // inliers.
    //
    // Trade-off: an affine inlier check is more permissive than a
    // rotation-only one — false positives are theoretically possible
    // when the two views are entirely unrelated.  In practice the
    // gate has already vetted novelty/overlap, so the matcher only
    // sees frames that genuinely overlap; permissiveness is the
    // right side of the trade-off.
    NSLog(@"[RetaiLensStitcher] step2: matching");
    NSLog(@"[stitch-bc] step2 enter: AffineBestOf2Nearest matching (full_affine=YES)");
    cv::detail::AffineBestOf2NearestMatcher matcher(/*full_affine=*/true,
                                                    /*try_use_gpu=*/false,
                                                    /*match_conf=*/0.65f,
                                                    /*num_matches_thresh1=*/6);
    std::vector<cv::detail::MatchesInfo> pairwise;
    matcher(imgFeatures, pairwise);
    matcher.collectGarbage();
    NSLog(@"[stitch-bc] step2 done: %lu pairwise entries",
            (unsigned long)pairwise.size());

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
    for (const auto &m : pairwise) {
      if (m.confidence > 0.0 && m.matches.size() >= 6) {
        validPairs++;
      }
    }
    NSLog(@"[RetaiLensStitcher] step2.5: %d valid pairwise matches", validPairs);
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
      NSLog(@"[RetaiLensStitcher] step2.5: 0 valid pairs — sentinel result (fix-10: break out of pool to avoid drain UAF)");
      result = [[RetaiLensStitchResult alloc] initWithOutputPath:@""
                                                           width:0
                                                          height:0
                                                      durationMs:0];
      break;
    }

    NSLog(@"[RetaiLensStitcher] step3: leave-biggest");
    NSLog(@"[stitch-bc] step3 enter: leave-biggest");
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
    NSLog(@"[RetaiLensStitcher] step3.5: kept %lu frames in biggest component",
          (unsigned long)workFrames.size());
    if (workFrames.size() < 2) {
      // V16 fix-attempt 9 (NULL TEST) — same rationale as the
      // validPairs<1 sentinel above.  Bypass the *error→throw bridge
      // by returning a width=0/height=0 sentinel result instead.
      NSLog(@"[RetaiLensStitcher] step3.5: <2 frames after leaveBiggestComponent — sentinel result (fix-10: break out of pool to avoid drain UAF)");
      result = [[RetaiLensStitchResult alloc] initWithOutputPath:@""
                                                           width:0
                                                          height:0
                                                      durationMs:0];
      break;
    }

    // Step 4: estimator
    NSLog(@"[RetaiLensStitcher] step4: estimator");
    NSLog(@"[stitch-bc] step4 enter: estimator");
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
      NSLog(@"[RetaiLensStitcher] step4: HomographyBasedEstimator failed — sentinel result (fix-10: break out of pool to avoid drain UAF)");
      result = [[RetaiLensStitchResult alloc] initWithOutputPath:@""
                                                           width:0
                                                          height:0
                                                      durationMs:0];
      break;
    }
    for (auto &cam : cameras) {
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
      NSLog(@"[RetaiLensStitcher] step5: bundle adjustment (t+%.0fms)", _ms);
      NSLog(@"[stitch-bc] step5 enter: bundle adjustment");
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
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step5 BA INVOKE: cameras=%lu cam0.R[0,0]=%.4f cam0.focal=%.2f",
          (unsigned long)cameras.size(), r00, focal);
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
    } catch (const cv::Exception &e) {
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step5 BA threw cv::Exception: %s — fallback to estimator cameras",
          e.what());
      baSucceeded = false;
    } catch (const std::exception &e) {
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step5 BA threw std::exception: %s — fallback to estimator cameras",
          e.what());
      baSucceeded = false;
    } catch (...) {
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step5 BA threw unknown exception — fallback to estimator cameras");
      baSucceeded = false;
    }

    if (!baSucceeded) {
      // Fall through with the cameras the estimator produced —
      // step5.5 wave correction + step6+ compose can still run on
      // unrefined cameras.  Result quality will be lower (no global
      // optimisation) but the engine returns a panorama instead of
      // crashing.
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step5 BA SKIPPED — proceeding with estimator cameras");
    } else {
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step5 BA OK");
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
      NSLog(@"[RetaiLensStitcher] step5.5: wave correction (BA done, t+%.0fms)", _ms);
      NSLog(@"[stitch-bc] step5.5 enter: wave correction");
    }
    std::vector<cv::Mat> rmats;
    rmats.reserve(cameras.size());
    for (const auto &cam : cameras) {
      rmats.push_back(cam.R.clone());
    }
    try {
      cv::detail::waveCorrect(rmats, cv::detail::WAVE_CORRECT_HORIZ);
      for (size_t i = 0; i < cameras.size(); i++) {
        cameras[i].R = rmats[i];
      }
    } catch (const cv::Exception &e) {
      // Wave correction can fail on degenerate input (only 1-2
      // cameras with collinear rotations).  Swallow the failure
      // and continue without correction — the panorama will have
      // the wave artifact but is still better than aborting.
      NSLog(@"[RetaiLensStitcher] wave correction skipped: %s", e.what());
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
    NSLog(@"[RetaiLensStitcher] step6: compose rescale "
          "(work_scale=%.3f → compose_scale=%.3f, aspect=%.3f)",
          work_scale, compose_scale, compose_work_aspect);
    for (auto &cam : cameras) {
      cam.focal *= compose_work_aspect;
      cam.ppx  *= compose_work_aspect;
      cam.ppy  *= compose_work_aspect;
    }

    // Step 6.5: median focal length determines the warper scale.
    // Computed AFTER compose rescale so warpedScale is already in
    // compose units — matches cv::Stitcher's flow.
    std::vector<double> focals;
    for (const auto &cam : cameras) focals.push_back(cam.focal);
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
    NSLog(@"[RetaiLensStitcher] step7: warper (%s)", warperType.UTF8String);
    NSLog(@"[stitch-bc] step7 enter: warper=%s", warperType.UTF8String);
    // Plane / Cylindrical / Spherical — runtime-selectable so
    // the host's settings UI can A/B test which projection looks
    // best for the operator's actual gesture (close-up planar
    // subject vs partial-arc rotation vs wide pan).
    cv::Ptr<cv::WarperCreator> warperCreator;
    if ([warperType isEqualToString:@"cylindrical"]) {
      warperCreator = cv::makePtr<cv::CylindricalWarper>();
    } else if ([warperType isEqualToString:@"spherical"]) {
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
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step7a: warper created (warpedScale=%.2f)", warpedScale);

    // Step 7.5: build composeFrames at COMPOSE_MP from full-res
    // input.  Warp + blend run at this resolution to produce the
    // sharp final output.  Release workFrames first — BA is done,
    // so we don't need the small set anymore.  Sequential release
    // ensures the two big arrays never coexist at peak.
    for (auto &wf : workFrames) wf.release();
    workFrames.clear();
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step7b: workFrames released, building composeFrames "
        "(N=%lu, compose_scale=%.3f)",
        (unsigned long)frames.size(), compose_scale);

    // V12.14.3 — wrap the resize loop in try/catch so a bad input
    // Mat doesn't terminate the process.  Per-frame resize on
    // bogus/corrupt cv::Mat data has historically been a SIGSEGV
    // source on consecutive captures.
    std::vector<cv::Mat> composeFrames;
    composeFrames.reserve(frames.size());
    try {
      for (size_t i = 0; i < frames.size(); i++) {
        const auto &f = frames[i];
        os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
            "[stitch-bc] step7c: resize frame %zu (%dx%d, channels=%d, "
            "data=%p)", i, f.cols, f.rows, f.channels(), (void *)f.data);

        // V12.14.4 — defensive validation.  Skip frames with NULL
        // data ptr, zero dimensions, or non-positive total — they
        // would SIGSEGV inside cv::resize regardless of interp mode.
        if (f.data == nullptr || f.empty() || f.total() == 0
            || f.cols <= 0 || f.rows <= 0) {
          os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
              "[stitch-bc] step7c: SKIPPING frame %zu — invalid Mat "
              "(data=%p empty=%d total=%zu)",
              i, (void *)f.data, (int)f.empty(), (size_t)f.total());
          continue;
        }

        // V12.14.4 — wrap each iteration in @autoreleasepool so any
        // ObjC temporaries cv::resize might autorelease internally
        // get drained between frames.  Doesn't hurt.
        @autoreleasepool {
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
      }
    } catch (const cv::Exception &e) {
      // V12.14.7 — %{public}s so the message survives Console.app
      // privacy redaction.  Without this, e.what() shows as "<private>"
      // and we can't see which assertion fired.
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step7c: cv::resize threw cv::Exception: %{public}s",
          e.what());
      // V16 fix-10 — capture error into strong local, break out of
      // pool.  See pool-entry block at the top of this method.
      capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                          code:1007
                                      userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:@"Compose-stage resize failed: %s", e.what()],
      }];
      break;
    } catch (...) {
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step7c: cv::resize threw unknown exception");
      capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                          code:1007
                                      userInfo:@{
        NSLocalizedDescriptionKey:
          @"Compose-stage resize failed (unknown).",
      }];
      break;
    }
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step7d: composeFrames built (N=%lu)",
        (unsigned long)composeFrames.size());

    // Release full-res `frames` now that composeFrames has its
    // own resized copies.  Frees ~50-100 MB for a typical 8-frame
    // stitch — a critical part of staying under iOS' jetsam
    // threshold (the ACTUAL cause of the "u != 0" /
    // WatchdogTermination crashes we were debugging — Sentry
    // confirmed those were OOM kills, not OpenCV bugs).
    for (auto &f : frames) f.release();
    frames.clear();
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step7e: full-res frames released mem=%.1fMB",
        StitcherResidentMB());
    NSLog(@"[RetaiLensStitcher] step7.5: composeFrames %d×%d "
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
    BOOL useSeam = [seamFinderType isEqualToString:@"graphcut"];
    NSLog(@"[RetaiLensStitcher] step8: %s",
          useSeam ? "BATCH (warp-all + seam + feed)"
                  : "STREAM (warp+feed per frame)");
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step8 enter: %s",
        useSeam ? "BATCH" : "STREAM");

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
    if ([blenderType isEqualToString:@"feather"]) {
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
    NSLog(@"[RetaiLensStitcher] step10: blender = %s",
          blenderType.UTF8String);

    if (useSeam) {
      // ── BATCH path ─────────────────────────────────────────────
      const size_t N = composeFrames.size();
      std::vector<cv::Point> corners(N);
      std::vector<cv::Mat> imagesWarped(N);
      std::vector<cv::Mat> masksWarped(N);
      std::vector<cv::Size> sizes(N);
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step8a: BATCH warp loop (N=%lu)",
          (unsigned long)N);
      // V12.14.6 — defensive measures around the warp loop.  Same
      // recycled-mmap pattern that hit cv::resize in V12.14.3
      // logs (Ram's 4th-capture crash).  cv::PlaneWarper::warp
      // uses cv::remap internally which has its own cached state
      // keyed on input addresses.
      try {
        for (size_t i = 0; i < N; i++) {
          os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
              "[stitch-bc] step8b: warp frame %zu (%dx%d, data=%p)", i,
              composeFrames[i].cols, composeFrames[i].rows,
              (void *)composeFrames[i].data);
          // Per-iteration @autoreleasepool drains any ObjC
          // autoreleased temps cv::remap holds onto.
          @autoreleasepool {
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
        }
      } catch (const cv::Exception &e) {
        // V12.14.7 — %{public}s to unredact the message under
        // Console.app privacy filtering.  e.what() was showing as
        // "<private>" in V12.14.6's caught traces.
        os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
            "[stitch-bc] step8b: warper->warp threw cv::Exception: %{public}s",
            e.what());
        // V16 fix-10 — capture error into strong local, break out of pool.
        capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                            code:1008
                                        userInfo:@{
          NSLocalizedDescriptionKey:
            [NSString stringWithFormat:@"Warp stage failed: %s", e.what()],
        }];
        break;
      } catch (...) {
        os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
            "[stitch-bc] step8b: warper->warp threw unknown exception");
        capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                            code:1008
                                        userInfo:@{
          NSLocalizedDescriptionKey: @"Warp stage failed (unknown).",
        }];
        break;
      }
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step8c: warp loop done mem=%.1fMB",
          StitcherResidentMB());
      // composeFrames has done its job — release before we
      // allocate the float UMat shadow set for seam finding.
      // V12.14.7: most/all of these are already released inside
      // the warp loop above; the .clear() drops the now-empty
      // Mat headers from the vector.
      for (auto &cf : composeFrames) cf.release();
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
      const double SEAM_MP = 0.1;
      double seam_scale = std::min(1.0, std::sqrt(SEAM_MP / origMp));
      // Aspect from compose scale → seam scale (the rescale we
      // apply to existing compose-scale data, not the original).
      double seam_compose_aspect = seam_scale / compose_scale;
      {
        auto _t = std::chrono::steady_clock::now();
        double _ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            _t - t0).count();
        NSLog(@"[RetaiLensStitcher] step9: graph-cut seam finder "
              "(compose→seam aspect = %.3f, t+%.0fms)",
              seam_compose_aspect, _ms);
      }
      auto _seamStart = std::chrono::steady_clock::now();
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step9a: seam-scale resize loop (aspect=%.3f)",
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
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step9b: seam-scale resize done, GraphCut find starting");
      cv::Ptr<cv::detail::SeamFinder> seamFinder =
          cv::makePtr<cv::detail::GraphCutSeamFinder>(
              cv::detail::GraphCutSeamFinder::COST_COLOR);
      seamFinder->find(imagesWarpedF_seam, corners_seam,
                       masksWarpedU_seam);
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step9c: GraphCut find done");
      {
        auto _t = std::chrono::steady_clock::now();
        double _seamMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            _t - _seamStart).count();
        NSLog(@"[RetaiLensStitcher] step9: graph-cut find took %.0fms", _seamMs);
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
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step10a: blender->prepare");
      blender->prepare(corners, sizes);
      os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
          "[stitch-bc] step10b: feeding blender (N=%lu)",
          (unsigned long)N);
      for (size_t i = 0; i < N; i++) {
        os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
            "[stitch-bc] step10c: feed frame %zu", i);
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
          "[stitch-bc] step10d: feed loop done");
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
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step11a: blender->blend starting");
    blender->blend(panoramaS, panoramaMask);
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step11b: blend complete (panoramaS=%dx%d)",
        panoramaS.cols, panoramaS.rows);
    panoramaS.convertTo(panorama, CV_8U);
    {
      auto _t = std::chrono::steady_clock::now();
      double _ms = std::chrono::duration_cast<std::chrono::milliseconds>(
          _t - t0).count();
      NSLog(@"[RetaiLensStitcher] step11: blend complete (output %d×%d, t+%.0fms)",
            panorama.cols, panorama.rows, _ms);
    }
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
        "[stitch-bc] step11c: panorama 8U conversion done (panorama=%dx%d) mem=%.1fMB",
        panorama.cols, panorama.rows, StitcherResidentMB());
  } catch (const cv::Exception &e) {
    // V16 fix-10 — capture error into strong local, break out of pool.
    capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                        code:1100
                                    userInfo:@{
      NSLocalizedDescriptionKey:
        [NSString stringWithFormat:
          @"OpenCV exception during stitch: %s", e.what()],
    }];
    break;
  } catch (const std::exception &e) {
    capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                        code:1101
                                    userInfo:@{
      NSLocalizedDescriptionKey:
        [NSString stringWithFormat:
          @"std exception during stitch: %s", e.what()],
    }];
    break;
  } catch (...) {
    capturedError = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                        code:1102
                                    userInfo:@{
      NSLocalizedDescriptionKey:
        @"Unknown exception during stitch.",
    }];
    break;
  }
  } while (0);
  }  // end @autoreleasepool — drains OpenCV's autoreleased
     // temporaries before we run the cheap post-stitch work
     // (crop, JPEG encode) and construct the return value.
     //
     // HISTORY (V16 fix-10, 2026-05-13): this brace USED to live at
     // the very bottom of the function, wrapping the `return [[Retai-
     // LensStitchResult alloc] init…]` as well.  ARC inserts an
     // autorelease for the return value, which then registered with
     // this @autoreleasepool; the pool drained at the closing brace,
     // deallocating the return object BEFORE the caller could
     // `objc_retain` it.  An earlier fix pulled the brace UP, which
     // protected the SUCCESS-path return below — but the FAILURE-path
     // returns (`*error = [NSError …]; return nil;`) and the fix-9
     // sentinel returns (`return [[Result alloc] init…sentinel…]`)
     // were still INSIDE the pool and kept crashing for the same
     // reason.  ASan's allocator quarantine masked this on diagnostic
     // builds; non-ASan production builds re-exposed it.
     //
     // Fix-10 restructure: every failure path now captures its
     // return value into a STRONG LOCAL declared above the pool
     // (`result` / `capturedError`) and `break`s out of the do/while(0)
     // wrapper to fall past the pool's closing brace cleanly.  The
     // strong locals survive the drain.  We then either return the
     // sentinel `result`, surface `capturedError` via the outparameter
     // (the outparameter is __autoreleasing — assigning to it puts
     // the NSError into the OUTER pool, drained by the caller's GCD
     // work-item boundary, comfortably after Swift retains it), or
     // fall through to the success path below.
     //
     // See docs/site-content/learnings/react-native.md#autoreleasepool-return-uaf
     // for the full pattern + a checklist for future ObjC bridges.

  // V16 fix-10 — handle failure paths captured from inside the pool.
  if (result != nil) {
    // Sentinel result (validPairs<1, workFrames<2, estimator fail).
    // The Swift caller checks r.width == 0 / r.height == 0 and
    // surfaces a clean error via completion(nil, NSError(...)).
    return result;
  }
  if (capturedError != nil) {
    // C++ exception caught inside the pool — surface via outparameter.
    if (error) {
      *error = capturedError;
    }
    return nil;
  }

  if (panorama.empty()) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1003
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Stitcher produced an empty panorama.",
      }];
    }
    return nil;
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
    if (useInscribedRectCrop) {
      cv::Mat closedMask;
      cv::morphologyEx(
          mask, closedMask, cv::MORPH_CLOSE,
          cv::getStructuringElement(cv::MORPH_RECT, cv::Size(5, 5)));
      bbox = MaxInscribedRectFromMask(closedMask);
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
        NSLog(@"[RetaiLensStitcher] inscribed-rect rejected: "
              "%dx%d (area=%lld) vs bbox %dx%d (area=%lld); "
              "using bbox fallback.",
              bbox.width, bbox.height, inscribedArea,
              bboxFallback.width, bboxFallback.height, fallbackArea);
        bbox = bboxFallback;
      } else {
        NSLog(@"[RetaiLensStitcher] inscribed-rect: %dx%d "
              "(area=%lld, %.0f%% of bbox %dx%d)",
              bbox.width, bbox.height, inscribedArea,
              100.0 * (double)inscribedArea / (double)fallbackArea,
              bboxFallback.width, bboxFallback.height);
      }
    } else {
      bbox = cv::boundingRect(mask);
      NSLog(@"[RetaiLensStitcher] crop: bbox-only %dx%d "
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
    if (!useInscribedRectCrop) {
      // Skip the second-pass column-projection entirely.
    } else

    {
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
    const int *cs = colSum.ptr<int>(0);
    for (int c = 0; c < cols; c++) {
      if (cs[c] >= contentThreshold) {
        if (cropLeft < 0) cropLeft = c;
        cropRight = c;
      }
    }
    NSLog(@"[RetaiLensStitcher] rectCrop col-proj: cols=%d rows=%d threshold=%d cropLeft=%d cropRight=%d",
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
      NSLog(@"[RetaiLensStitcher] rectCrop applied: %dx%d → %dx%d",
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
      NSLog(@"[RetaiLensStitcher] rectCrop relaxed (80%%): cropLeft=%d cropRight=%d",
            cropLeft, cropRight);
      if (cropLeft >= 0 && cropRight > cropLeft + 10
          && (cropRight - cropLeft + 1) >= minRectWidth) {
        cv::Rect rectCrop(cropLeft, 0,
                          cropRight - cropLeft + 1, rows);
        finalImage = finalImage(rectCrop).clone();
        NSLog(@"[RetaiLensStitcher] rectCrop relaxed applied: %dx%d → %dx%d",
              cols, rows, finalImage.cols, finalImage.rows);
      } else {
        NSLog(@"[RetaiLensStitcher] rectCrop SKIPPED — best band is "
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

  auto t1 = std::chrono::steady_clock::now();
  double durationMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

  // Encode + write the JPEG.  Clamp quality into [0, 100] to defend
  // against caller bugs.
  //
  // V16 Phase 1b.fix3 — write via ImageIO so we can bake the EXIF
  // Orientation tag into the output.  cv::imwrite produces a plain
  // JPEG with no metadata; iOS image renderers (UIImage / RN
  // <Image>) display it in raw pixel orientation, which looks
  // sideways when the user holds the phone in portrait.  The tag
  // tells the renderer how to rotate for display without re-
  // encoding the pixels.
  NSInteger clampedQuality = MAX(0, MIN(100, quality));
  NSString *cleanedOutPath = normalizeImagePath(outputPath);

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
  //   - Output JPEG always EXIF=1.  Bake is in the pixels, so all
  //     viewers (Photos.app, RN <Image>, share-sheet) agree.
  //   - The cv::rotate happens AFTER BA / blend / seam-find when
  //     their working sets are released — incremental memory cost.
  //   - Per-keyframe JPEGs (OpenCVKeyframeCollector) untouched —
  //     they still carry EXIF=6 so LiveFrameStrip thumbnails show
  //     portrait-correct during capture.
  cv::Mat finalImageRotated;
  cv::Mat *imageToWrite = &finalImage;
  NSString *normalisedOrientation = captureOrientation ?: @"portrait";
  // os_log with %{public}@ — without `public` qualifier iOS redacts
  // the string to "<private>" in the system log, making it impossible
  // to read what orientation actually arrived from JS.  These two
  // log lines are diagnostic-only and contain no PII, safe to mark
  // public.
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
  if ([normalisedOrientation isEqualToString:@"landscape-left"]) {
    cv::rotate(finalImage, finalImageRotated,
               cv::ROTATE_90_COUNTERCLOCKWISE);
    imageToWrite = &finalImageRotated;
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
                     "[RetaiLensStitcher] bake-rotated 90° CCW for landscape-left "
                     "(%dx%d → %dx%d)",
                     finalImage.cols, finalImage.rows,
                     finalImageRotated.cols, finalImageRotated.rows);
  } else if ([normalisedOrientation isEqualToString:@"landscape-right"]) {
    cv::rotate(finalImage, finalImageRotated,
               cv::ROTATE_90_CLOCKWISE);
    imageToWrite = &finalImageRotated;
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
                     "[RetaiLensStitcher] bake-rotated 90° CW for landscape-right "
                     "(%dx%d → %dx%d)",
                     finalImage.cols, finalImage.rows,
                     finalImageRotated.cols, finalImageRotated.rows);
  } else if ([normalisedOrientation isEqualToString:@"portrait-upside-down"]) {
    cv::rotate(finalImage, finalImageRotated, cv::ROTATE_180);
    imageToWrite = &finalImageRotated;
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
                     "[RetaiLensStitcher] bake-rotated 180° for portrait-upside-down "
                     "(%dx%d)", finalImage.cols, finalImage.rows);
  } else {
    os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
                     "[RetaiLensStitcher] no bake-rotation (orientation=%{public}@, %dx%d)",
                     normalisedOrientation, finalImage.cols, finalImage.rows);
  }
  BOOL wrote = WriteJPEGWithEXIFTag(*imageToWrite, cleanedOutPath,
                                    1, clampedQuality);  // always EXIF=1 — rotation is baked
  if (!wrote) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1002
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"Stitch succeeded but could not write JPEG to %@", outputPath],
      }];
    }
    return nil;
  }

  // V16 Phase 1b.fix5d — report the dimensions of the bytes we
  // actually wrote (rotated, if we baked one in above), not the
  // pre-rotate Mat.  JS-side consumers need the displayable shape.
  return [[RetaiLensStitchResult alloc]
      initWithOutputPath:outputPath
                   width:(NSInteger)imageToWrite->cols
                  height:(NSInteger)imageToWrite->rows
              durationMs:durationMs];
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
  // from the JS accelerometer hook through RetaiLensIncrementalStitcher.
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
// RetaiLensARSession) and skips the brittle features → matching
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
  NSLog(@"[RetaiLensStitcher] pose-driven: matched=%d dropped=%d",
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
      NSLog(@"[RetaiLensStitcher] pose: wave correction skipped: %s", e.what());
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
  NSLog(@"[RetaiLensStitcher] keyframe-stitch: loaded=%d dropped=%d",
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
      NSLog(@"[RetaiLensStitcher] keyframe: wave correction skipped: %s",
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
