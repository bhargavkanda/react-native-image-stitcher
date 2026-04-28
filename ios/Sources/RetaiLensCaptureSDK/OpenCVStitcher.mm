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
  for (NSString *path in framePaths) {
    NSString *cleaned = normalizeImagePath(path);
    cv::Mat img = cv::imread([cleaned UTF8String]);
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

}  // namespace


// ─────────────────────────────────────────────────────────────────────
// OpenCVStitcher (public)
// ─────────────────────────────────────────────────────────────────────

@implementation OpenCVStitcher

+ (nullable RetaiLensStitchResult *)stitchFramePaths:(NSArray<NSString *> *)framePaths
                                          outputPath:(NSString *)outputPath
                                         jpegQuality:(NSInteger)quality
                                               error:(NSError **)error {
  if (framePaths.count < 2) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1000
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Need at least 2 frames to stitch a panorama.",
      }];
    }
    return nil;
  }

  // Load all input frames before invoking the stitcher.  Memory cost
  // is N × frame size — for typical shelf captures (~2048×1536 RGB,
  // ~9 MB / frame raw, but cv::imread decodes JPEG so resident
  // footprint is bounded by the original sensor resolution).
  std::vector<cv::Mat> frames;
  if (!loadFramesOrFail(framePaths, frames, error)) {
    return nil;
  }

  auto t0 = std::chrono::steady_clock::now();

  // SCANS mode — see file header for rationale.
  cv::Ptr<cv::Stitcher> stitcher = cv::Stitcher::create(cv::Stitcher::SCANS);

  cv::Mat panorama;
  cv::Stitcher::Status status = stitcher->stitch(frames, panorama);
  if (status != cv::Stitcher::OK) {
    if (error) {
      *error = errorForStitchStatus(status);
    }
    return nil;
  }

  auto t1 = std::chrono::steady_clock::now();
  double durationMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

  // Encode + write the JPEG.  Clamp quality into [0, 100] to defend
  // against caller bugs.
  NSInteger clampedQuality = MAX(0, MIN(100, quality));
  std::vector<int> params = {
      cv::IMWRITE_JPEG_QUALITY, static_cast<int>(clampedQuality),
  };
  NSString *cleanedOutPath = normalizeImagePath(outputPath);
  bool wrote = cv::imwrite([cleanedOutPath UTF8String], panorama, params);
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

  return [[RetaiLensStitchResult alloc]
      initWithOutputPath:outputPath
                   width:(NSInteger)panorama.cols
                  height:(NSInteger)panorama.rows
              durationMs:durationMs];
}

@end
