// SPDX-License-Identifier: Apache-2.0
//
// ARCHIVED — pose-driven stitch  (NOT compiled, NOT shipped)
// ════════════════════════════════════════════════════════════════════
//
// Extracted during the 2026-06 batch-keyframe cleanup from the
// pre-cleanup ios/Sources/RNImageStitcher/OpenCVStitcher.mm
// (git commit d94a6f3; removed in d045e75).
//
// WHAT THIS IS
// ───────────
// The "pose-driven" stitch path: build cv::detail::CameraParams
// DIRECTLY from ARKit/ARCore camera poses (quaternion + intrinsics),
// skipping the features → matching → BundleAdjuster steps that the
// live feature-matched `stitchFramePaths` runs.  This is the "Phase 5"
// direction the C++ core still references (cpp/stitcher.cpp: "this is
// also the same path Phase 5 will populate with AR-derived poses").
//
// WHY IT'S DEAD (as of the cleanup)
// ─────────────────────────────────
// Audit-confirmed unreferenced.  The AR batch-keyframe flow uses poses
// ONLY for keyframe GATING (selecting which frames to capture); the
// selected keyframes are then stitched by FEATURE-MATCHING via
// `stitchFramePaths`, which takes no poses.  Nothing ever called these
// pose-driven stitch methods.  See
// docs/plans/2026-06-02-batch-keyframe-cleanup.md.
//
// HOW TO RESURRECT
// ────────────────
//   • `cameraParamsFromPose()` was a file-scope helper inside the
//     anonymous namespace of OpenCVStitcher.mm (alongside the kept
//     MaxInscribedRectFromMask / FillBorderConnectedHoles helpers).
//   • The two `+ (...)` methods were members of @implementation
//     OpenCVStitcher; re-add their declarations to OpenCVStitcher.h.
//   • Both DUPLICATE the compose stage (warp + seam + blend + crop)
//     from `stitchFramePaths` — the intended follow-up was to DRY them
//     into a shared compose helper once the pose path was proven on
//     real captures.
//   • The matching StitchVideoOptions.poses JS field + Swift/bridge
//     threading were removed too; restore those to re-expose the API.
//   • Symbols referenced here (RNStitchResult, StitcherDiagLog,
//     normalizeImagePath, …) live in OpenCVStitcher.mm; this file is a
//     faithful copy for reference, not a standalone TU.
//
// ════════════════════════════════════════════════════════════════════

#if 0  // ARCHIVED — never compiled

// ─── file-scope helper (was in OpenCVStitcher.mm's anonymous namespace) ───

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

// ─── methods (were members of @implementation OpenCVStitcher) ───

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

+ (nullable RNStitchResult *)stitchVideoAtPath:(NSString *)videoPath
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
          [NSString stringWithFormat:@"RNImageStitcherStitchAR-%@",
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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

  return [[RNStitchResult alloc]
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
//   RNStitchResult *result = nil;
//   @autoreleasepool {
//     do {
//       try { ... ; result = [[RNStitchResult alloc] init...]; break; }
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

+ (nullable RNStitchResult *)stitchKeyframePaths:(NSArray<NSString *> *)framePaths
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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
      *error = [NSError errorWithDomain:RNImageStitcherErrorDomain
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

  return [[RNStitchResult alloc]
      initWithOutputPath:outputPath
                   width:(NSInteger)finalImage.cols
                  height:(NSInteger)finalImage.rows
              durationMs:durationMs];
}

#endif  // ARCHIVED — pose-driven stitch
