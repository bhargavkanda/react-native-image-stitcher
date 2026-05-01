//
// OpenCVIncrementalStitcher.mm
//
// See OpenCVIncrementalStitcher.h for the API contract.
//
// Algorithm summary (per addPixelBuffer call):
//   1. Lock + read NV12 planes from CVPixelBuffer
//   2. Convert + downscale to compose-size BGR cv::Mat
//   3. Pose-delta gate: skip if overlap > maxOverlap or < minOverlap
//   4. ORB.detectAndCompute (1000 features cap)
//   5. BFMatcher.knnMatch + Lowe's ratio test (0.75)
//   6. cv::findHomography(src=newPts, dst=lastPts, RANSAC, 5.0)
//   7. Inlier ratio + match count + det(H) → confidence
//   8. Compose worldH = lastFrameToWorldH * H_newToLast
//   9. warpPerspective + distance-transform feather blend onto canvas
//   10. Update state: lastFrameToWorldH, lastDescriptors, lastKeypoints,
//       lastAcceptedYaw/Pitch, acceptedCount++
//
// What this file deliberately does NOT do:
//   - Bundle adjustment.  We accumulate pair-wise homography only;
//     drift is accepted as the trade for live preview + Android parity
//     (the Android prebuilt OpenCV ships without `cv::Stitcher`'s BA
//     helpers).  Long-pan drift is documented as future work in the
//     design doc's open questions.
//   - Multi-band blending.  Same Android-parity reason.  Distance-
//     transform feather over a 20px band gives clean-enough seams for
//     live preview; a final-pass MultiBand is possible at finalize
//     time on iOS only if drift becomes the dominant artefact.
//   - Exposure compensation.  Auto-exposure on the camera handles
//     gross brightness changes; the feather hides residual mismatches.

// OpenCV's stitching headers contain `enum { NO, ... }` and `enum { YES, ... }`
// declarations.  Objective-C's `<objc/objc.h>` (transitively imported by every
// Cocoapods prefix.pch) #defines `NO` and `YES` as boolean macros — by the
// time OpenCV's enums are parsed, the preprocessor has already eaten those
// identifiers and the build dies with "expected identifier".  Undef both
// BEFORE importing opencv2/*; restore after.  Same pattern as OpenCVStitcher.mm.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#import <opencv2/opencv.hpp>
#import <opencv2/core.hpp>
#import <opencv2/imgproc.hpp>
#import <opencv2/imgcodecs.hpp>
#import <opencv2/features2d.hpp>
#import <opencv2/calib3d.hpp>

#import <vector>
#import <chrono>

#define NO  ((BOOL)0)
#define YES ((BOOL)1)

#import "OpenCVIncrementalStitcher.h"

#import <UIKit/UIKit.h>

NSString *const RetaiLensIncrementalStitcherErrorDomain =
    @"RetaiLensIncrementalStitcherErrorDomain";

// ── Private telemetry result class ──────────────────────────────────

@interface RLISFrameTelemetry ()
@property (nonatomic, readwrite) RLISFrameOutcome outcome;
@property (nonatomic, readwrite) double overlapPercent;
@property (nonatomic, readwrite) NSInteger matchCount;
@property (nonatomic, readwrite) double inlierRatio;
@property (nonatomic, readwrite) double confidence;
@property (nonatomic, readwrite) double processingMs;
@end

@implementation RLISFrameTelemetry
@end

@interface RLISSnapshot ()
@property (nonatomic, copy, readwrite) NSString *panoramaPath;
@property (nonatomic, readwrite) NSInteger width;
@property (nonatomic, readwrite) NSInteger height;
@property (nonatomic, readwrite) NSInteger acceptedCount;
@end

@implementation RLISSnapshot
@end

// ── Acceptance thresholds ───────────────────────────────────────────
//
// All values empirical seeds from the design doc.  Documented here
// alongside the code so a tuning pass during field testing can adjust
// them without hunting through the .h.

namespace {

constexpr double kMinOverlapPct = 15.0;   // below this → too far gone
constexpr double kMaxOverlapPct = 70.0;   // above this → too close, wait
constexpr int kMinMatchesAccept = 20;
constexpr double kMinInlierRatioAccept = 0.25;
constexpr double kHighConfidenceMatches = 80;
constexpr double kHighConfidenceInlierRatio = 0.7;
constexpr int kOrbMaxFeatures = 1000;
constexpr float kLoweRatio = 0.75f;
constexpr double kRansacReprojThresh = 5.0;
constexpr double kHomDetMin = 0.4;        // det outside [min, max] = degenerate
constexpr double kHomDetMax = 2.5;

}  // namespace

// ── Engine impl ─────────────────────────────────────────────────────

@implementation OpenCVIncrementalStitcher {
    NSInteger _composeWidth;
    NSInteger _composeHeight;
    NSInteger _canvasWidth;
    NSInteger _canvasHeight;
    NSInteger _featherPx;

    cv::Mat _canvas;       // CV_8UC3 BGR — the running panorama
    cv::Mat _canvasMask;   // CV_8UC1 — 255 where canvas has been written

    // Last accepted frame's features + descriptors, ready to match
    // the next candidate against.  Cleared on reset.
    std::vector<cv::KeyPoint> _lastKeypoints;
    cv::Mat _lastDescriptors;
    cv::Mat _lastFrameToWorld;     // 3x3 CV_64F — composes new frames
    double _lastAcceptedYaw;
    double _lastAcceptedPitch;
    bool _hasFirstFrame;

    cv::Ptr<cv::ORB> _orb;
    cv::Ptr<cv::BFMatcher> _matcher;

    NSInteger _accepted;
}

- (instancetype)initWithComposeWidth:(NSInteger)composeWidth
                       composeHeight:(NSInteger)composeHeight
                         canvasWidth:(NSInteger)canvasWidth
                        canvasHeight:(NSInteger)canvasHeight
                         featherPx:(NSInteger)featherPx
{
    if (self = [super init]) {
        _composeWidth  = composeWidth  > 0 ? composeWidth  : 1280;
        _composeHeight = composeHeight > 0 ? composeHeight : 720;
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 4800;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 1600;
        _featherPx     = featherPx     > 0 ? featherPx     : 20;

        _orb = cv::ORB::create(
            kOrbMaxFeatures,    // nfeatures
            1.2f,               // scaleFactor
            8,                  // nlevels
            31,                 // edgeThreshold
            0,                  // firstLevel
            2,                  // WTA_K
            cv::ORB::HARRIS_SCORE,
            31,                 // patchSize
            20                  // fastThreshold
        );
        // BFMatcher with NORM_HAMMING is the right pairing for ORB's
        // binary descriptors.  crossCheck=false because we use Lowe's
        // ratio test downstream — they're orthogonal filtering steps
        // and ratio test alone is the established convention.
        _matcher = cv::BFMatcher::create(cv::NORM_HAMMING, false);

        [self reset];
    }
    return self;
}

- (void)reset {
    _canvas = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC3);
    _canvasMask = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC1);
    _lastKeypoints.clear();
    _lastDescriptors = cv::Mat();
    _lastFrameToWorld = cv::Mat::eye(3, 3, CV_64F);
    _lastAcceptedYaw = 0.0;
    _lastAcceptedPitch = 0.0;
    _hasFirstFrame = false;
    _accepted = 0;
}

- (NSInteger)acceptedCount { return _accepted; }

// ── Public: ingestPixelBuffer ───────────────────────────────────────

- (RLISFrameTelemetry *)ingestPixelBuffer:(CVPixelBufferRef)pixelBuffer
                                      yaw:(double)yaw
                                    pitch:(double)pitch
                          fovHorizDegrees:(double)fovHorizDegrees
                             trackingPoor:(BOOL)trackingPoor
{
    auto t0 = std::chrono::steady_clock::now();

    RLISFrameTelemetry *tele = [[RLISFrameTelemetry alloc] init];
    tele.overlapPercent = -1;

    if (trackingPoor) {
        tele.outcome = RLISFrameOutcomeSkippedTrackingPoor;
        tele.processingMs = msSince(t0);
        return tele;
    }

    cv::Mat frameBGR;
    if (![self convertPixelBuffer:pixelBuffer toMat:frameBGR]) {
        // Conversion failed — treat as a tracking-poor skip rather
        // than a hard error so the capture continues.
        tele.outcome = RLISFrameOutcomeSkippedTrackingPoor;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // First frame is special: place at canvas centre, take its
    // features, accept unconditionally.
    if (!_hasFirstFrame) {
        [self placeFirstFrame:frameBGR];
        _lastAcceptedYaw = yaw;
        _lastAcceptedPitch = pitch;
        _hasFirstFrame = true;
        _accepted = 1;
        tele.outcome = RLISFrameOutcomeAcceptedHigh;
        tele.confidence = 1.0;
        tele.overlapPercent = 0;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Pose-delta gating.  Estimate per-axis FoV from horizontal
    // FoV + frame aspect; take the larger angular delta as the pan
    // axis and compute fractional overlap.
    double overlap = computeOverlapPct(
        yaw - _lastAcceptedYaw,
        pitch - _lastAcceptedPitch,
        fovHorizDegrees,
        (double)_composeWidth / (double)_composeHeight
    );
    tele.overlapPercent = overlap;

    if (overlap > kMaxOverlapPct) {
        // Not moved enough since last accept — wait for more pan.
        tele.outcome = RLISFrameOutcomeSkippedTooClose;
        tele.processingMs = msSince(t0);
        return tele;
    }
    if (overlap < kMinOverlapPct) {
        // Moved past the overlap window — alignment is going to be
        // fragile.  Reject and let the JS layer hint the operator.
        tele.outcome = RLISFrameOutcomeRejectedTooFar;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Feature work — only candidates in the [15, 70]% overlap window
    // get this far.
    std::vector<cv::KeyPoint> kpts;
    cv::Mat descs;
    cv::Mat gray;
    cv::cvtColor(frameBGR, gray, cv::COLOR_BGR2GRAY);
    _orb->detectAndCompute(gray, cv::noArray(), kpts, descs);

    if (descs.empty() || kpts.size() < 4) {
        tele.outcome = RLISFrameOutcomeRejectedSceneUniform;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // knnMatch with k=2 → ratio test.
    std::vector<std::vector<cv::DMatch>> knn;
    _matcher->knnMatch(descs, _lastDescriptors, knn, 2);
    std::vector<cv::DMatch> good;
    good.reserve(knn.size());
    for (const auto &pair : knn) {
        if (pair.size() < 2) continue;
        if (pair[0].distance < kLoweRatio * pair[1].distance) {
            good.push_back(pair[0]);
        }
    }
    tele.matchCount = (NSInteger)good.size();

    if ((int)good.size() < kMinMatchesAccept) {
        tele.outcome = RLISFrameOutcomeRejectedSceneUniform;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Pull point lists for findHomography: src = new frame, dst = last.
    std::vector<cv::Point2f> srcPts, dstPts;
    srcPts.reserve(good.size());
    dstPts.reserve(good.size());
    for (const auto &m : good) {
        srcPts.push_back(kpts[m.queryIdx].pt);
        dstPts.push_back(_lastKeypoints[m.trainIdx].pt);
    }

    cv::Mat ransacMask;
    cv::Mat H_newToLast = cv::findHomography(
        srcPts, dstPts, cv::RANSAC, kRansacReprojThresh, ransacMask
    );
    if (H_newToLast.empty()) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }

    int inliers = cv::countNonZero(ransacMask);
    double inlierRatio = (double)inliers / (double)good.size();
    tele.inlierRatio = inlierRatio;

    if (inliers < kMinMatchesAccept || inlierRatio < kMinInlierRatioAccept) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Sanity-check the homography determinant.  Severe shear / fold-
    // over collapses produce drift that compounds catastrophically;
    // better to reject one frame and let the operator continue.
    double det = cv::determinant(H_newToLast(cv::Rect(0, 0, 2, 2)));
    if (det < kHomDetMin || det > kHomDetMax) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Compose worldH for the new frame: maps new-frame pixel coords
    // → canvas pixel coords.  H_newToLast maps new → last; lastFrameToWorld
    // maps last → world.  Multiplication order: world ← last ← new.
    cv::Mat newFrameToWorld = _lastFrameToWorld * H_newToLast;

    // Warp + feather blend onto the canvas in place.
    [self warpAndBlend:frameBGR worldH:newFrameToWorld];

    // Update state for next call.
    _lastFrameToWorld = newFrameToWorld;
    _lastKeypoints = kpts;
    _lastDescriptors = descs;
    _lastAcceptedYaw = yaw;
    _lastAcceptedPitch = pitch;
    _accepted += 1;

    // Confidence score: weighted blend of inlier ratio + match count.
    double matchScore = std::min(1.0, (double)good.size() / kHighConfidenceMatches);
    double inlierScore = std::min(1.0, inlierRatio / kHighConfidenceInlierRatio);
    double confidence = 0.6 * inlierScore + 0.4 * matchScore;
    tele.confidence = confidence;

    if (confidence >= 0.8) {
        tele.outcome = RLISFrameOutcomeAcceptedHigh;
    } else {
        tele.outcome = RLISFrameOutcomeAcceptedMedium;
    }
    tele.processingMs = msSince(t0);
    return tele;
}

// ── Snapshot / finalize ─────────────────────────────────────────────

- (nullable RLISSnapshot *)snapshotWithJpegQuality:(NSInteger)quality
                                              error:(NSError **)error
{
    return [self writeSnapshotToPath:[self defaultSnapshotPath]
                          jpegQuality:quality
                            tightCrop:NO
                                error:error];
}

- (nullable RLISSnapshot *)finalizeAtPath:(NSString *)outputPath
                              jpegQuality:(NSInteger)quality
                                    error:(NSError **)error
{
    RLISSnapshot *snap = [self writeSnapshotToPath:outputPath
                                       jpegQuality:quality
                                         tightCrop:YES
                                             error:error];
    [self reset];
    return snap;
}

- (NSString *)defaultSnapshotPath {
    NSString *tmpDir = NSTemporaryDirectory();
    return [tmpDir stringByAppendingPathComponent:@"rlis-live-snapshot.jpg"];
}

- (nullable RLISSnapshot *)writeSnapshotToPath:(NSString *)outputPath
                                   jpegQuality:(NSInteger)quality
                                     tightCrop:(BOOL)tightCrop
                                         error:(NSError **)error
{
    if (_accepted == 0) {
        if (error) {
            *error = [NSError errorWithDomain:RetaiLensIncrementalStitcherErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey:
                                       @"No frames have been accepted yet."}];
        }
        return nil;
    }

    cv::Mat out;
    cv::Rect cropRect(0, 0, _canvas.cols, _canvas.rows);
    if (tightCrop) {
        // Tight-crop to the bounding box of the canvas mask.  This
        // is what lets the final panorama come out sized to its
        // actual content rather than the full pre-allocated canvas.
        cropRect = cv::boundingRect(_canvasMask);
        if (cropRect.width <= 0 || cropRect.height <= 0) {
            cropRect = cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        }
    }
    out = _canvas(cropRect).clone();

    int q = (int)std::clamp((long long)quality, 0LL, 100LL);
    std::vector<int> params = {cv::IMWRITE_JPEG_QUALITY, q};
    NSString *cleanPath = [outputPath hasPrefix:@"file://"]
        ? [outputPath substringFromIndex:7]
        : outputPath;
    bool ok = cv::imwrite(std::string([cleanPath UTF8String]), out, params);
    if (!ok) {
        if (error) {
            *error = [NSError errorWithDomain:RetaiLensIncrementalStitcherErrorDomain
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey:
                                       [NSString stringWithFormat:
                                        @"Failed to write JPEG to %@", outputPath]}];
        }
        return nil;
    }

    RLISSnapshot *snap = [[RLISSnapshot alloc] init];
    snap.panoramaPath = cleanPath;
    snap.width = out.cols;
    snap.height = out.rows;
    snap.acceptedCount = _accepted;
    return snap;
}

// ── Internals ───────────────────────────────────────────────────────

static double msSince(std::chrono::steady_clock::time_point t0) {
    auto dt = std::chrono::steady_clock::now() - t0;
    return std::chrono::duration_cast<std::chrono::microseconds>(dt).count() / 1000.0;
}

/// Compute fractional overlap between consecutive frames assuming the
/// camera is rotated about its centre by (deltaYaw, deltaPitch) in
/// radians.  Output is in percent.  We take the dominant axis (the
/// one with larger angular delta) as the pan axis — overlap on that
/// axis is what determines whether the frames have moved enough.
static double computeOverlapPct(double deltaYaw,
                                double deltaPitch,
                                double fovHorizDegrees,
                                double frameAspect)
{
    double absYaw = std::fabs(deltaYaw);
    double absPitch = std::fabs(deltaPitch);
    double fovH = fovHorizDegrees * M_PI / 180.0;
    if (fovH <= 1e-6) {
        // Sentinel for "no intrinsics info" — assume mid-tier
        // smartphone camera FoV (~65°) so we still gate something.
        fovH = 65.0 * M_PI / 180.0;
    }
    // Vertical FoV from horizontal FoV + aspect (approx, treating
    // the image as a flat plane at a fixed depth).
    double fovV = 2.0 * std::atan(std::tan(fovH / 2.0) / std::max(frameAspect, 0.1));

    // Pan-axis selection — rotational handhelds dominate handheld
    // panoramas, so the larger angular delta is the pan direction.
    double overlap;
    if (absYaw >= absPitch) {
        overlap = 1.0 - absYaw / fovH;
    } else {
        overlap = 1.0 - absPitch / fovV;
    }
    return std::clamp(overlap, 0.0, 1.0) * 100.0;
}

- (BOOL)convertPixelBuffer:(CVPixelBufferRef)pixelBuffer toMat:(cv::Mat &)outBGR {
    if (pixelBuffer == NULL) return NO;
    OSType pf = CVPixelBufferGetPixelFormatType(pixelBuffer);

    CVReturn lockResult = CVPixelBufferLockBaseAddress(pixelBuffer,
                                                        kCVPixelBufferLock_ReadOnly);
    if (lockResult != kCVReturnSuccess) return NO;

    cv::Mat frame;
    BOOL ok = NO;

    if (pf == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ||
        pf == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
        // ARKit's NV12 — Y plane in plane 0, interleaved CbCr in plane 1.
        // OpenCV exposes a direct NV12 → BGR conversion.
        size_t w = CVPixelBufferGetWidth(pixelBuffer);
        size_t h = CVPixelBufferGetHeight(pixelBuffer);
        size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0);
        size_t cStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1);
        uint8_t *yPlane = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0);
        uint8_t *cPlane = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1);

        // Build a contiguous YUV buffer expected by cvtColorTwoPlane.
        // OpenCV provides cvtColorTwoPlane which takes Y and UV planes
        // separately — perfect for NV12 with potentially-different
        // strides between planes.
        cv::Mat yMat((int)h, (int)w, CV_8UC1, yPlane, yStride);
        cv::Mat cMat((int)h / 2, (int)w / 2, CV_8UC2, cPlane, cStride);
        int code = (pf == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
            ? cv::COLOR_YUV2BGR_NV12 : cv::COLOR_YUV2BGR_NV12;
        cv::cvtColorTwoPlane(yMat, cMat, frame, code);
        ok = YES;
    } else if (pf == kCVPixelFormatType_32BGRA) {
        size_t w = CVPixelBufferGetWidth(pixelBuffer);
        size_t h = CVPixelBufferGetHeight(pixelBuffer);
        size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
        uint8_t *base = (uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);
        cv::Mat bgra((int)h, (int)w, CV_8UC4, base, stride);
        cv::cvtColor(bgra, frame, cv::COLOR_BGRA2BGR);
        ok = YES;
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    if (!ok) return NO;

    // ARKit delivers landscape sensor pixels regardless of device
    // orientation.  The shelf-audit user holds the phone in PORTRAIT
    // — a horizontal pan looks vertical in the raw frame.  Rotate
    // 90° clockwise so the panorama coordinate system matches the
    // way the user is actually moving the phone.
    cv::Mat rotated;
    cv::rotate(frame, rotated, cv::ROTATE_90_CLOCKWISE);

    // Downscale to compose-resolution.
    cv::Size target((int)_composeWidth, (int)_composeHeight);
    if (rotated.cols == target.width && rotated.rows == target.height) {
        outBGR = rotated;
    } else {
        cv::resize(rotated, outBGR, target, 0, 0, cv::INTER_AREA);
    }
    return YES;
}

- (void)placeFirstFrame:(const cv::Mat &)frameBGR {
    int fw = frameBGR.cols, fh = frameBGR.rows;
    int ox = (_canvas.cols - fw) / 2;
    int oy = (_canvas.rows - fh) / 2;
    cv::Rect roi(ox, oy, fw, fh);
    frameBGR.copyTo(_canvas(roi));
    _canvasMask(roi).setTo(255);

    // Build the translation matrix that places (0,0)_frame at
    // (ox, oy)_canvas — this is the seed for the cumulative
    // homography.
    cv::Mat H = cv::Mat::eye(3, 3, CV_64F);
    H.at<double>(0, 2) = (double)ox;
    H.at<double>(1, 2) = (double)oy;
    _lastFrameToWorld = H;

    // Stash this frame's keypoints + descriptors as the matching
    // anchor for the next frame.
    cv::Mat gray;
    cv::cvtColor(frameBGR, gray, cv::COLOR_BGR2GRAY);
    _orb->detectAndCompute(gray, cv::noArray(), _lastKeypoints, _lastDescriptors);
}

/// Warp `frameBGR` into the canvas at `worldH` and feather-blend
/// against the existing pixels.  Touches `_canvas` and `_canvasMask`.
- (void)warpAndBlend:(const cv::Mat &)frameBGR worldH:(const cv::Mat &)worldH {
    cv::Size canvasSize(_canvas.cols, _canvas.rows);

    // Warp the new frame onto an empty canvas-sized buffer.
    cv::Mat warped;
    cv::warpPerspective(frameBGR, warped, worldH, canvasSize,
                        cv::INTER_LINEAR, cv::BORDER_CONSTANT,
                        cv::Scalar(0, 0, 0));

    // Warp a "this is in-frame" mask the same way.  Anywhere the
    // mask is non-zero, `warped` has valid pixels.
    cv::Mat frameOnesMask = cv::Mat::ones(frameBGR.rows, frameBGR.cols, CV_8UC1) * 255;
    cv::Mat warpedMask;
    cv::warpPerspective(frameOnesMask, warpedMask, worldH, canvasSize,
                        cv::INTER_NEAREST, cv::BORDER_CONSTANT,
                        cv::Scalar(0));

    // Distance-transform feather: alpha ramps from 0 at the warped-
    // frame edges to 1 over `_featherPx` pixels inward.  In the
    // overlap region this gives a soft blend; in non-overlap region
    // alpha will saturate to 1 in the interior, which is fine because
    // there's no existing canvas pixel to blend against.
    cv::Mat dist;
    cv::distanceTransform(warpedMask, dist, cv::DIST_L2, 3);
    cv::Mat alpha;
    dist.convertTo(alpha, CV_32F, 1.0 / (double)_featherPx);
    cv::threshold(alpha, alpha, 1.0, 1.0, cv::THRESH_TRUNC);

    // Where the existing canvas mask is empty, force alpha=1 so the
    // new frame writes directly without blending against zero.
    cv::Mat existingMaskF;
    _canvasMask.convertTo(existingMaskF, CV_32F, 1.0 / 255.0);
    // alpha = where(existingMask==0, 1, alpha)
    cv::Mat noPriorMask;
    cv::compare(_canvasMask, 0, noPriorMask, cv::CMP_EQ);
    alpha.setTo(1.0, noPriorMask);

    // Per-channel multiply: result = alpha*warped + (1-alpha)*canvas
    // OpenCV doesn't have a direct 1-channel-alpha × 3-channel-image
    // multiply, so we expand alpha to 3 channels first.
    cv::Mat alpha3;
    cv::Mat alphaChannels[] = {alpha, alpha, alpha};
    cv::merge(alphaChannels, 3, alpha3);
    cv::Mat invAlpha3 = cv::Scalar(1, 1, 1) - alpha3;

    cv::Mat warpedF, canvasF;
    warped.convertTo(warpedF, CV_32FC3);
    _canvas.convertTo(canvasF, CV_32FC3);
    cv::Mat blendedF;
    cv::multiply(warpedF, alpha3, warpedF);
    cv::multiply(canvasF, invAlpha3, canvasF);
    cv::add(warpedF, canvasF, blendedF);

    // Only write into canvas where warpedMask is set — leaves the
    // rest of the canvas (areas the new frame doesn't touch) intact.
    cv::Mat blended8;
    blendedF.convertTo(blended8, CV_8UC3);
    blended8.copyTo(_canvas, warpedMask);

    // Update canvas mask = OR(canvasMask, warpedMask).
    cv::bitwise_or(_canvasMask, warpedMask, _canvasMask);
}

@end
