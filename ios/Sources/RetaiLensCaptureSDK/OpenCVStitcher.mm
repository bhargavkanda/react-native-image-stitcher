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
                                               error:(NSError **)error {
  // V12.14.2 — FAULT-level sentinel.  Survives Console.app rate-limit;
  // proves the function entered.  If a future trace doesn't show this
  // line for a crashed run, the crash is BEFORE stitchFramePaths
  // (e.g., in extractFramesFromVideoAtPath or in the dispatch_async
  // block in StitcherBridge).
  os_log_with_type(StitcherDiagLog(), OS_LOG_TYPE_FAULT,
      "[stitch-bc] STITCH START: %lu frames", (unsigned long)framePaths.count);

  // Defaults if caller passed nil — keeps the old 3-arg call-sites
  // working until we update them.
  if (warperType == nil || warperType.length == 0) warperType = @"plane";
  if (blenderType == nil || blenderType.length == 0) blenderType = @"multiband";
  if (seamFinderType == nil || seamFinderType.length == 0) seamFinderType = @"graphcut";
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
    return nil;
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
  @autoreleasepool {
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
    NSLog(@"[RetaiLensStitcher] step2: matching");
    NSLog(@"[stitch-bc] step2 enter: BestOf2Nearest matching");
    cv::detail::BestOf2NearestMatcher matcher(false, 0.65f);
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
      if (error) {
        *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                     code:1004
                                 userInfo:@{
          NSLocalizedDescriptionKey:
            @"Stitcher could not match enough overlapping frames — try recapturing with a slower, more overlapping pan.",
        }];
      }
      return nil;
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
      if (error) {
        *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                     code:1004
                                 userInfo:@{
          NSLocalizedDescriptionKey:
            @"Stitcher could not match enough overlapping frames — try recapturing with a slower pan and more overlap.",
        }];
      }
      return nil;
    }

    // Step 4: estimator
    NSLog(@"[RetaiLensStitcher] step4: estimator");
    NSLog(@"[stitch-bc] step4 enter: estimator");
    cv::detail::HomographyBasedEstimator estimator;
    std::vector<cv::detail::CameraParams> cameras;
    if (!estimator(imgFeatures, pairwise, cameras)) {
      if (error) {
        *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                     code:1005
                                 userInfo:@{
          NSLocalizedDescriptionKey:
            @"Stitcher could not estimate camera parameters — frames may be too dissimilar.",
        }];
      }
      return nil;
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
    cv::Ptr<cv::detail::RotationWarper> warper =
        warperCreator->create(warpedScale);

    // Step 7.5: build composeFrames at COMPOSE_MP from full-res
    // input.  Warp + blend run at this resolution to produce the
    // sharp final output.  Release workFrames first — BA is done,
    // so we don't need the small set anymore.  Sequential release
    // ensures the two big arrays never coexist at peak.
    for (auto &wf : workFrames) wf.release();
    workFrames.clear();

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
    // Release full-res `frames` now that composeFrames has its
    // own resized copies.  Frees ~50-100 MB for a typical 8-frame
    // stitch — a critical part of staying under iOS' jetsam
    // threshold (the ACTUAL cause of the "u != 0" /
    // WatchdogTermination crashes we were debugging — Sentry
    // confirmed those were OOM kills, not OpenCV bugs).
    for (auto &f : frames) f.release();
    frames.clear();
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
      for (size_t i = 0; i < N; i++) {
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
      // composeFrames has done its job — release before we
      // allocate the float UMat shadow set for seam finding.
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
      cv::Ptr<cv::detail::SeamFinder> seamFinder =
          cv::makePtr<cv::detail::GraphCutSeamFinder>(
              cv::detail::GraphCutSeamFinder::COST_COLOR);
      seamFinder->find(imagesWarpedF_seam, corners_seam,
                       masksWarpedU_seam);
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
      blender->prepare(corners, sizes);
      for (size_t i = 0; i < N; i++) {
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
    blender->blend(panoramaS, panoramaMask);
    panoramaS.convertTo(panorama, CV_8U);
    {
      auto _t = std::chrono::steady_clock::now();
      double _ms = std::chrono::duration_cast<std::chrono::milliseconds>(
          _t - t0).count();
      NSLog(@"[RetaiLensStitcher] step11: blend complete (output %d×%d, t+%.0fms)",
            panorama.cols, panorama.rows, _ms);
    }
  } catch (const cv::Exception &e) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1100
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"OpenCV exception during stitch: %s", e.what()],
      }];
    }
    return nil;
  } catch (const std::exception &e) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1101
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"std exception during stitch: %s", e.what()],
      }];
    }
    return nil;
  } catch (...) {
    if (error) {
      *error = [NSError errorWithDomain:RetaiLensStitcherErrorDomain
                                   code:1102
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Unknown exception during stitch.",
      }];
    }
    return nil;
  }
  }  // end @autoreleasepool — drains OpenCV's autoreleased
     // temporaries before we run the cheap post-stitch work
     // (crop, JPEG encode) and construct the return value.
     //
     // CRITICAL: this brace USED to live at the very bottom of the
     // function, wrapping the `return [[RetaiLensStitchResult alloc]
     // init…]` as well.  ARC inserts an autorelease for the return
     // value, which then registered with this @autoreleasepool;
     // the pool drained at the closing brace, deallocating the
     // return object BEFORE the caller could `objc_retain` it.
     // Caller's first interaction (the implicit retain that ARC
     // inserts when receiving a returned object) hit freed memory
     // → EXC_BAD_ACCESS at objc_retain.  Sentry confirmed this
     // crash signature on the multi-res build.  Pulling the
     // closing brace UP — so the return statement lives OUTSIDE
     // the pool — fixes it.
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
  // Wrapped in try/catch so any OpenCV edge case (e.g. fully
  // black panorama from a failed stitch) falls back to writing
  // the un-cropped output rather than crashing.
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

    // Second pass: rectangular crop.  Find the column range where
    // ≥95% of rows have content, crop to that × full height.
    //
    // Algorithm (column projection — more robust than the per-row
    // scan I had before):
    //   1. Build a binary content mask (threshold + erode to drop
    //      fringe artifacts at the warp edges).
    //   2. For each column, count how many rows have content at
    //      that column.  Use cv::reduce(REDUCE_SUM).
    //   3. A column "qualifies" if its content-row count is at
    //      least 95% of total rows.  ≥95% (not 100%) tolerates
    //      the small black artifacts that survive thresholding
    //      at hourglass corners.
    //   4. Find leftmost + rightmost qualifying columns.  Crop
    //      to that range, full height.
    //
    // Why column projection is better than the per-row scan:
    //   The per-row approach computed globalLeft = max(rowLeft)
    //   across rows.  Bug: even with erosion, antialiasing left
    //   stray non-zero pixels at edge columns in some rows, so
    //   globalLeft kept getting reset to 0 by those rows.
    //   Column projection asks "is this column mostly content?"
    //   and naturally ignores stray pixels in 1-2 rows.
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
  } catch (...) {
    // Crop failed — fall back to the raw stitched output.
    finalImage = panorama;
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
  bool wrote = cv::imwrite([cleanedOutPath UTF8String], finalImage, params);
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
                   width:(NSInteger)finalImage.cols
                  height:(NSInteger)finalImage.rows
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
  RetaiLensStitchResult *result =
      [self stitchFramePaths:frames
                  outputPath:outputPath
                 jpegQuality:quality
                  warperType:warperType
                 blenderType:blenderType
              seamFinderType:seamFinderType
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
    cv::Mat img = cv::imread([framePaths[i] UTF8String]);
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
