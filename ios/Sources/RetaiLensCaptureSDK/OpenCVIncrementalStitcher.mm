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
#import <opencv2/stitching.hpp>
#import <opencv2/stitching/detail/warpers.hpp>
#import <opencv2/stitching/detail/seam_finders.hpp>
#import <opencv2/stitching/detail/blenders.hpp>
#import <opencv2/stitching/detail/exposure_compensate.hpp>
#import <opencv2/stitching/detail/camera.hpp>

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

// FoV gate window — slightly more permissive than the design doc's
// 30-50% sweet spot to handle pose noise + slow pans without
// rejecting valid candidates.
constexpr double kMinOverlapPct = 10.0;   // below this → moved too far
constexpr double kMaxOverlapPct = 75.0;   // above this → too close, wait
// Match-quality gates — relaxed from the design doc seeds because
// shelf scenes with light textures (white walls behind shelves,
// uniform packaging) produce fewer matches than the 80-feature
// "ideal".  Field tuning in v3.
constexpr int kMinMatchesAccept = 10;
constexpr double kMinInlierRatioAccept = 0.18;
constexpr double kHighConfidenceMatches = 60;
constexpr double kHighConfidenceInlierRatio = 0.55;
constexpr int kOrbMaxFeatures = 1000;
constexpr float kLoweRatio = 0.75f;
constexpr double kRansacReprojThresh = 5.0;
// Similarity (4-DOF: scale, rotation, tx, ty) keeps the determinant
// equal to scale².  Tight bounds reject degenerate fits aggressively
// while leaving slack for the natural ~0.9-1.1 scale that hand-held
// pans introduce (parallax + lens distortion residuals).
constexpr double kHomDetMin = 0.7;
constexpr double kHomDetMax = 1.4;

}  // namespace

// ── Engine impl ─────────────────────────────────────────────────────

@implementation OpenCVIncrementalStitcher {
    NSInteger _composeWidth;
    NSInteger _composeHeight;
    NSInteger _canvasWidth;
    NSInteger _canvasHeight;
    NSInteger _featherPx;
    NSInteger _frameRotationDegrees;

    cv::Mat _canvas;       // CV_8UC3 BGR — the running panorama
    cv::Mat _canvasMask;   // CV_8UC1 — 255 where canvas has been written

    /// V7 pose-driven state — sensor-native compute path.
    cv::Mat _firstRotationArkit;  // 3x3 CV_64F, ARKit camera-to-world
    cv::Mat _K_compose;           // 3x3 CV_64F, intrinsics scaled to compose dims
    cv::Mat _M_arkitToCv;         // diag(1, -1, -1) basis flip
    cv::Mat _T_canvas;            // (legacy from v7 planar; no longer used in v8 cylindrical)

    /// V8 cylindrical-warp state.  CylindricalWarper projects each
    /// frame onto a cylinder using the AR pose; the canvas is the
    /// unrolled cylinder.  Mirrors the cv::Stitcher::PANORAMA
    /// pipeline but applied per-frame instead of all-at-once.
    cv::Ptr<cv::detail::RotationWarper> _warper;
    /// Cylindrical-pixel coords of the canvas's (0, 0).  Set when the
    /// first frame is placed: the first frame's cylindrical-pixel
    /// corner gets mapped to a position near the canvas centre, so
    /// the pan can extend in either direction.
    cv::Point _cylinderCanvasOrigin;

    double _lastAcceptedYaw;
    double _lastAcceptedPitch;
    bool _hasFirstFrame;

    NSInteger _accepted;
    /// Monotonic snapshot sequence — used to mint a unique path per
    /// live snapshot.  RN's <Image> caches `file://` URIs by path
    /// alone and ignores cache-bust query strings, so writing to the
    /// SAME path each accept made the live preview show the FIRST
    /// frame forever.  Bumping the path each snapshot side-steps
    /// the cache.
    NSInteger _snapshotSeq;
}

- (instancetype)initWithComposeWidth:(NSInteger)composeWidth
                       composeHeight:(NSInteger)composeHeight
                         canvasWidth:(NSInteger)canvasWidth
                        canvasHeight:(NSInteger)canvasHeight
                         featherPx:(NSInteger)featherPx
              frameRotationDegrees:(NSInteger)frameRotationDegrees
{
    if (self = [super init]) {
        // V7: frameRotationDegrees is now an OUTPUT-ONLY rotation —
        // it's applied at snapshot/finalize time to orient the saved
        // JPEG for display.  The compute pipeline always works in
        // sensor-native landscape compose space.
        _frameRotationDegrees = frameRotationDegrees;
        // Default compose dims preserve the 4:3 sensor aspect
        // (1920x1440 → 960x720 at scale 0.5).  Always landscape
        // because we no longer rotate input; the canvas geometry
        // matches the sensor's pixel-shift direction for either
        // yaw or pitch pan, in either device orientation.
        _composeWidth  = composeWidth  > 0 ? composeWidth  : 960;
        _composeHeight = composeHeight > 0 ? composeHeight : 720;
        // Canvas: wide-landscape because for the typical shelf-scan
        // use case (portrait phone, left-right yaw pan), the sensor
        // sees content shifting along its X axis (the wide 1920
        // axis).  Canvas-X covers ~3 frame-widths of pan; canvas-Y
        // covers one frame plus pitch-wobble headroom.
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 4800;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 2200;
        _featherPx     = featherPx     > 0 ? featherPx     : 20;

        // ARKit camera frame (Y-up, -Z forward) → OpenCV camera frame
        // (Y-down, +Z forward).  Pre-multiplying ARKit-rotation by
        // M (and post-multiplying by M, since M is its own inverse)
        // converts the rotation into OpenCV camera-frame conventions
        // before we plug it into the pinhole projection K.
        _M_arkitToCv = (cv::Mat_<double>(3, 3) <<
            1, 0, 0,
            0, -1, 0,
            0, 0, -1);

        // V8 CylindricalWarper.  Constructed once with a placeholder
        // scale; the actual scale (= focal length in compose pixels)
        // is set when the first frame's intrinsics are known.  We
        // recreate the warper at first-frame time via setScale to
        // bind it to the right cylinder radius.
        _warper = cv::CylindricalWarper().create(1.0f);

        [self reset];
    }
    return self;
}

- (void)reset {
    _canvas = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC3);
    _canvasMask = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC1);
    _firstRotationArkit = cv::Mat();
    _K_compose = cv::Mat();
    _T_canvas = cv::Mat::eye(3, 3, CV_64F);
    _lastAcceptedYaw = 0.0;
    _lastAcceptedPitch = 0.0;
    _hasFirstFrame = false;
    _accepted = 0;
    _snapshotSeq = 0;
}

- (NSInteger)acceptedCount { return _accepted; }

// ── Public: ingestPixelBuffer (V6 pose-driven) ─────────────────────

- (RLISFrameTelemetry *)ingestPixelBuffer:(CVPixelBufferRef)pixelBuffer
                                       qx:(double)qx
                                       qy:(double)qy
                                       qz:(double)qz
                                       qw:(double)qw
                                       fx:(double)fx
                                       fy:(double)fy
                                       cx:(double)cx
                                       cy:(double)cy
                              imageWidth:(NSInteger)imageWidth
                             imageHeight:(NSInteger)imageHeight
                                      yaw:(double)yaw
                                    pitch:(double)pitch
                          fovHorizDegrees:(double)fovHorizDegrees
                           fovVertDegrees:(double)fovVertDegrees
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
        tele.outcome = RLISFrameOutcomeSkippedTrackingPoor;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Build R_new (3x3, ARKit-camera-to-world rotation) from the
    // quaternion.
    cv::Mat R_new = quaternionToRotationMat(qx, qy, qz, qw);

    // First frame: place at canvas centre, store the reference pose
    // and intrinsics, accept unconditionally.  All subsequent frames
    // compute their pose-driven homography RELATIVE to this first
    // frame.
    if (!_hasFirstFrame) {
        _firstRotationArkit = R_new.clone();
        // K in compose pixel coordinates.
        double sx = (double)frameBGR.cols / std::max((NSInteger)1, imageWidth);
        double sy = (double)frameBGR.rows / std::max((NSInteger)1, imageHeight);
        double s = 0.5 * (sx + sy);
        _K_compose = (cv::Mat_<double>(3, 3) <<
                      fx * s, 0,      cx * s,
                      0,      fy * s, cy * s,
                      0,      0,      1);

        // Bind cylindrical warper to the focal length (cylinder radius
        // in compose pixels).
        float focalCompose = (float)(fx * s);
        _warper = cv::CylindricalWarper().create(focalCompose);

        // V8.1 BUG-FIX: R for CylindricalWarper must be gravity-aligned
        // world-to-camera, not first-frame-relative.  The warper
        // assumes cylinder axis = world +Y (gravity).  Passing R
        // expressed in the first camera's local frame put the cylinder
        // axis sideways for portrait phones — every frame collapsed
        // to the same cylindrical-pixel position and only the first
        // showed up.
        //
        //   R_warper = M · R_arkit⁻¹     (world-to-cam, OpenCV basis)
        //
        // where R_arkit is the camera-to-world from ARKit.  ARKit's
        // world is already gravity-aligned (+Y up), which is exactly
        // what CylindricalWarper assumes.
        cv::Mat R_first_world_to_cam = _M_arkitToCv * _firstRotationArkit.t();

        cv::Mat K32f, R32f;
        _K_compose.convertTo(K32f, CV_32F);
        R_first_world_to_cam.convertTo(R32f, CV_32F);

        cv::Mat warpedFirst, warpedFirstMask;
        cv::Point firstCorner = _warper->warp(
            frameBGR, K32f, R32f,
            cv::INTER_LINEAR, cv::BORDER_CONSTANT, warpedFirst);
        cv::Mat firstFrameMask(frameBGR.size(), CV_8U, cv::Scalar(255));
        _warper->warp(firstFrameMask, K32f, R32f,
                      cv::INTER_NEAREST, cv::BORDER_CONSTANT, warpedFirstMask);

        // Canvas placement: centre the first warped frame.
        int dstX = (_canvas.cols - warpedFirst.cols) / 2;
        int dstY = (_canvas.rows - warpedFirst.rows) / 2;
        cv::Rect roi(dstX, dstY, warpedFirst.cols, warpedFirst.rows);
        roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        cv::Rect srcRoi(0, 0, roi.width, roi.height);
        warpedFirst(srcRoi).copyTo(_canvas(roi), warpedFirstMask(srcRoi));
        warpedFirstMask(srcRoi).copyTo(_canvasMask(roi),
                                        warpedFirstMask(srcRoi));

        // Cylinder origin tracking unchanged: canvas (0, 0) ↔
        // cylinder pixel (firstCorner.x - dstX, firstCorner.y - dstY).
        _cylinderCanvasOrigin = cv::Point(firstCorner.x - dstX,
                                          firstCorner.y - dstY);

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

    // Pose-delta gate (cheap; runs before any warping).
    double overlap = computeOverlapPct(
        yaw - _lastAcceptedYaw,
        pitch - _lastAcceptedPitch,
        fovHorizDegrees,
        fovVertDegrees
    );
    tele.overlapPercent = overlap;

    if (overlap > kMaxOverlapPct) {
        tele.outcome = RLISFrameOutcomeSkippedTooClose;
        tele.processingMs = msSince(t0);
        return tele;
    }
    if (overlap < kMinOverlapPct) {
        tele.outcome = RLISFrameOutcomeRejectedTooFar;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // V8 cylindrical pipeline.  Per-frame rotation for the warper
    // is gravity-aligned world-to-camera in OpenCV basis:
    //
    //   R_warper = M · R_arkit⁻¹
    //
    // (NOT first-frame-relative — cv::detail::CylindricalWarper
    // assumes cylinder axis = world +Y which is exactly ARKit's
    // gravity convention).  Same formula as the first-frame branch.
    cv::Mat R_world_to_new = _M_arkitToCv * R_new.t();

    BOOL placed = [self cylindricalWarpAndBlend:frameBGR
                                    rWorldToCam:R_world_to_new];
    if (!placed) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }

    _lastAcceptedYaw = yaw;
    _lastAcceptedPitch = pitch;
    _accepted += 1;

    // Pose-driven path is geometrically exact when ARKit tracking is
    // good (which we already gated on `trackingPoor`).  Confidence
    // is a function of the FoV-overlap quality: high near 50%, lower
    // at the edges of the [10, 75]% acceptance window.
    double midOverlap = 0.5 * (kMinOverlapPct + kMaxOverlapPct);
    double overlapDistance = std::fabs(overlap - midOverlap)
                              / (kMaxOverlapPct - midOverlap);
    double confidence = std::max(0.0, 1.0 - overlapDistance);
    tele.confidence = confidence;
    tele.matchCount = -1;       // not applicable in pose-driven path
    tele.inlierRatio = -1;
    tele.outcome = (confidence >= 0.6)
                    ? RLISFrameOutcomeAcceptedHigh
                    : RLISFrameOutcomeAcceptedMedium;
    tele.processingMs = msSince(t0);
    return tele;
}

// ── Snapshot / finalize ─────────────────────────────────────────────

- (nullable RLISSnapshot *)snapshotWithJpegQuality:(NSInteger)quality
                                              error:(NSError **)error
{
    _snapshotSeq += 1;
    // Tight-crop the live snapshot to the actual content.  The full
    // canvas is 4800x2200 — most of it empty black space until the
    // pan covers the canvas.  Without this, every snapshot was a
    // ~24 MB JPEG that RN's <Image> couldn't keep up with — the
    // user saw "Pan to begin capturing" for the entire capture
    // because the previous snapshot was still loading when the
    // next one overwrote the path.  Tight-cropped snapshots are
    // ~50–500 KB; <Image> renders them in milliseconds.
    return [self writeSnapshotToPath:[self currentSnapshotPath]
                          jpegQuality:quality
                            tightCrop:YES
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

- (NSString *)currentSnapshotPath {
    // Cycle through 4 filenames so RN's image cache sees a new URI
    // on every snapshot but tmp dir doesn't grow unbounded over a
    // long pan.  4 is enough to outpace RN's most aggressive
    // image cache lifetimes; the OS reclaims tmp at app launch
    // anyway.
    NSString *tmpDir = NSTemporaryDirectory();
    NSInteger slot = _snapshotSeq % 4;
    NSString *filename = [NSString stringWithFormat:@"rlis-live-%ld.jpg", (long)slot];
    return [tmpDir stringByAppendingPathComponent:filename];
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

    cv::Mat cropped;
    cv::Rect cropRect(0, 0, _canvas.cols, _canvas.rows);
    if (tightCrop) {
        // Bounding box of painted region.
        cropRect = cv::boundingRect(_canvasMask);
        if (cropRect.width <= 0 || cropRect.height <= 0) {
            cropRect = cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        }
    }
    // V8 INSCRIBED-RECTANGLE CROP (only on finalize, not live preview).
    //
    // Trim edges where the canvas mask is sparsely filled, leaving a
    // sub-rectangle where almost every pixel has real content.  This
    // is what gives the saved panorama clean rectangular borders
    // instead of jagged black corners — same effect Apple/Samsung
    // get with their final-pass rectangle-fit.
    //
    // Heuristic: walk inward from each side, trim rows/cols that
    // are < kInscribedFillRatio full (defaults to 95%).  Not the
    // mathematically optimal largest-inscribed-rectangle, but close
    // and very fast (O(W+H)).
    if (tightCrop && cropRect.width > 0 && cropRect.height > 0) {
        cv::Mat maskRoi = _canvasMask(cropRect);
        const double kFillRatio = 0.95;
        int top = 0, bottom = maskRoi.rows - 1;
        int left = 0, right = maskRoi.cols - 1;
        while (top < bottom) {
            int filled = cv::countNonZero(maskRoi.row(top));
            if (filled < kFillRatio * maskRoi.cols) top++;
            else break;
        }
        while (bottom > top) {
            int filled = cv::countNonZero(maskRoi.row(bottom));
            if (filled < kFillRatio * maskRoi.cols) bottom--;
            else break;
        }
        const int trimmedHeight = bottom - top + 1;
        while (left < right && trimmedHeight > 0) {
            int filled = cv::countNonZero(
                maskRoi.col(left).rowRange(top, bottom + 1));
            if (filled < kFillRatio * trimmedHeight) left++;
            else break;
        }
        while (right > left && trimmedHeight > 0) {
            int filled = cv::countNonZero(
                maskRoi.col(right).rowRange(top, bottom + 1));
            if (filled < kFillRatio * trimmedHeight) right--;
            else break;
        }
        if (right > left && bottom > top) {
            cropRect = cv::Rect(cropRect.x + left, cropRect.y + top,
                                right - left + 1, bottom - top + 1);
        }
    }
    cropped = _canvas(cropRect).clone();

    // V7.1 GRAVITY-DERIVED OUTPUT ROTATION.  The compute pipeline
    // keeps everything in sensor-native landscape.  At save time,
    // we rotate the output so gravity (world -Y in ARKit) points
    // image-down.
    //
    // Math: gravity in first-camera frame = R_first⁻¹ · (0, -1, 0)
    // Convert to OpenCV camera (Y-down, +Z forward) via M = diag(1,-1,-1).
    // The (gx, gy) components give gravity's direction in the buffer's
    // image plane.  We snap the rotation to the nearest 90° so the
    // output is axis-aligned regardless of small pose noise.
    //
    // This replaces the v7 `frameRotationDegrees` parameter (which
    // came from the JS `useDeviceOrientation` hook and was unreliable
    // — defaulted to portrait on first read, didn't update mid-
    // capture, and conflated landscape-left with landscape-right).
    int rotationDeg = 0;
    if (_hasFirstFrame && !_firstRotationArkit.empty()) {
        cv::Mat gravWorld = (cv::Mat_<double>(3, 1) << 0.0, -1.0, 0.0);
        cv::Mat gravArkit = _firstRotationArkit.t() * gravWorld;
        cv::Mat gravCv = _M_arkitToCv * gravArkit;
        double gx = gravCv.at<double>(0);
        double gy = gravCv.at<double>(1);
        // atan2(gx, gy) gives angle from +Y axis (image-down).
        // We want the rotation that aligns gravity with +Y.
        double angle = std::atan2(gx, gy) * 180.0 / M_PI;
        // Snap to nearest 90° and normalise to [0, 360).
        rotationDeg = (int)std::round(angle / 90.0) * 90;
        rotationDeg = ((rotationDeg % 360) + 360) % 360;
    }

    cv::Mat out;
    if (rotationDeg == 90) {
        cv::rotate(cropped, out, cv::ROTATE_90_CLOCKWISE);
    } else if (rotationDeg == 180) {
        cv::rotate(cropped, out, cv::ROTATE_180);
    } else if (rotationDeg == 270) {
        cv::rotate(cropped, out, cv::ROTATE_90_COUNTERCLOCKWISE);
    } else {
        out = cropped;
    }

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

/// Quaternion (x, y, z, w) → 3x3 rotation matrix (CV_64F).
/// Defensive: normalises if the input isn't unit-length.
static cv::Mat quaternionToRotationMat(double qx, double qy, double qz, double qw) {
    double n = std::sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
    if (n > 1e-9) { qx /= n; qy /= n; qz /= n; qw /= n; }
    return (cv::Mat_<double>(3, 3) <<
        1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qw*qz),     2*(qx*qz + qw*qy),
        2*(qx*qy + qw*qz),     1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qw*qx),
        2*(qx*qz - qw*qy),     2*(qy*qz + qw*qx),     1 - 2*(qx*qx + qy*qy));
}

// `sensorRotationMatrix` was removed in V7 — the rotation chain it
// powered is no longer in the homography path.  See the v7 commit
// for the architectural fix that replaced it with sensor-native
// compute + output-only rotation.

/// Compute fractional overlap between consecutive frames assuming the
/// camera is rotated about its centre by (deltaYaw, deltaPitch) in
/// radians.  Output is in percent.  We take the dominant axis (the
/// one with larger angular delta) as the pan axis — overlap on that
/// axis is what determines whether the frames have moved enough.
static double computeOverlapPct(double deltaYaw,
                                double deltaPitch,
                                double fovHorizDegrees,
                                double fovVertDegrees)
{
    double absYaw = std::fabs(deltaYaw);
    double absPitch = std::fabs(deltaPitch);
    double fovH = fovHorizDegrees * M_PI / 180.0;
    double fovV = fovVertDegrees * M_PI / 180.0;
    if (fovH <= 1e-6) {
        // Sentinel for "no intrinsics info" — assume mid-tier
        // smartphone camera FoV (~65° H, 50° V for 4:3 sensors).
        fovH = 65.0 * M_PI / 180.0;
    }
    if (fovV <= 1e-6) {
        // Sensible default if vertical wasn't passed; ~50° works
        // for typical 4:3 phone cameras.
        fovV = 50.0 * M_PI / 180.0;
    }

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

    // V7: NO input rotation.  ARKit delivers sensor-native landscape
    // pixels and we keep them that way through the entire compute
    // pipeline.  This is the architectural fix that resolves the
    // v6 rotation-vs-canvas mismatch — we no longer need an `R2S`
    // chain in the homography to undo a rotation we shouldn't have
    // applied in the first place.
    //
    // The sensor's native orientation is what the ARKit pose +
    // intrinsics describe.  Working directly in that frame keeps
    // `H = K · R_rel · K⁻¹` clean and bug-free.  Output rotation
    // for display happens AT SNAPSHOT/FINALIZE time only.
    //
    // Uniform-scale downsample preserves the 4:3 sensor aspect ratio
    // (no non-uniform stretch).  Picks whichever dimension hits the
    // compose budget first; the other comes out proportional.
    double scale = std::min(
        (double)_composeWidth  / (double)frame.cols,
        (double)_composeHeight / (double)frame.rows
    );
    if (scale > 1.0) scale = 1.0;  // never upscale
    int outW = std::max(1, (int)std::round(frame.cols * scale));
    int outH = std::max(1, (int)std::round(frame.rows * scale));
    cv::Size target(outW, outH);
    if (frame.cols == outW && frame.rows == outH) {
        outBGR = frame;
    } else {
        cv::resize(frame, outBGR, target, 0, 0, cv::INTER_AREA);
    }
    return YES;
}

// `placeFirstFrame` was removed in v6 — the first-frame logic is now
// inlined in `ingestPixelBuffer:` so the engine can capture the
// reference pose + intrinsics in the same place it positions the
// frame on the canvas.

/// V8 cylindrical warp + per-pair seam-cut + multi-band blend +
/// exposure compensation.  Replaces v7's planar warp + hard-seam
/// path with the same cv::detail::* pipeline `cv::Stitcher::PANORAMA`
/// uses internally — applied per accepted frame instead of all-at-once.
///
/// Inputs:
///   frameBGR        — compose-resolution sensor-native frame (CV_8UC3)
///   rWorldToCam     — world-to-camera rotation in OpenCV cam frame
///                     (3x3 CV_64F).  Suitable for CylindricalWarper.
///
/// Returns NO if the warped frame falls entirely outside the canvas
/// or is too small to blend (very rare; would indicate a pose glitch).
- (BOOL)cylindricalWarpAndBlend:(const cv::Mat &)frameBGR
                    rWorldToCam:(const cv::Mat &)rWorldToCam
{
    // K + R must be CV_32F for cv::detail::* APIs.
    cv::Mat K32f, R32f;
    _K_compose.convertTo(K32f, CV_32F);
    rWorldToCam.convertTo(R32f, CV_32F);

    // ── 1. Cylindrical warp ─────────────────────────────────────
    cv::Mat warpedNew, warpedNewMask;
    cv::Point newCornerCyl = _warper->warp(
        frameBGR, K32f, R32f,
        cv::INTER_LINEAR, cv::BORDER_CONSTANT, warpedNew);
    cv::Mat frameOnesMask(frameBGR.size(), CV_8U, cv::Scalar(255));
    _warper->warp(frameOnesMask, K32f, R32f,
                  cv::INTER_NEAREST, cv::BORDER_CONSTANT, warpedNewMask);

    if (warpedNew.empty() || warpedNew.cols < 8 || warpedNew.rows < 8) {
        return NO;
    }

    // Map the new frame's cylindrical corner to a canvas pixel.
    cv::Point newCornerCanvas = newCornerCyl - _cylinderCanvasOrigin;

    // ── Compute the union ROI (canvas region covered by the new
    //    frame).  We'll do per-pair seam + blend on this region.
    //    For the canvas side of the pair, take the canvas's existing
    //    pixels in the same ROI.
    cv::Rect newDstRoi(newCornerCanvas.x, newCornerCanvas.y,
                       warpedNew.cols, warpedNew.rows);
    cv::Rect canvasBounds(0, 0, _canvas.cols, _canvas.rows);
    cv::Rect dstRoiClipped = newDstRoi & canvasBounds;
    if (dstRoiClipped.width <= 0 || dstRoiClipped.height <= 0) {
        return NO;
    }
    // Source ROI inside warpedNew that maps to the clipped canvas ROI.
    cv::Rect newSrcRoi(dstRoiClipped.x - newCornerCanvas.x,
                       dstRoiClipped.y - newCornerCanvas.y,
                       dstRoiClipped.width,
                       dstRoiClipped.height);
    cv::Mat warpedNewClipped     = warpedNew(newSrcRoi);
    cv::Mat warpedNewMaskClipped = warpedNewMask(newSrcRoi);
    cv::Mat canvasRegion         = _canvas(dstRoiClipped);
    cv::Mat canvasRegionMask     = _canvasMask(dstRoiClipped);

    // ── 2. Exposure compensation ───────────────────────────────
    //
    // BlocksGainCompensator computes per-block gains so frame
    // brightnesses match in overlap regions.  For per-pair use:
    // feed (canvasRegion, canvasRegionMask) and (warpedNewClipped,
    // warpedNewMaskClipped) — both at corner (0, 0) within the
    // ROI's local coordinate system.  Apply the gains to the new
    // frame before seam finding; canvas keeps its existing values.
    cv::Mat warpedNewExposed = warpedNewClipped.clone();
    {
        cv::detail::BlocksGainCompensator compensator;
        std::vector<cv::Point> corners = {cv::Point(0, 0), cv::Point(0, 0)};
        std::vector<cv::UMat> images(2);
        canvasRegion.copyTo(images[0]);
        warpedNewClipped.copyTo(images[1]);
        std::vector<std::pair<cv::UMat, uchar>> masks(2);
        masks[0].first = canvasRegionMask.getUMat(cv::ACCESS_READ);
        masks[0].second = 255;
        masks[1].first = warpedNewMaskClipped.getUMat(cv::ACCESS_READ);
        masks[1].second = 255;
        compensator.feed(corners, images, masks);
        compensator.apply(1, cv::Point(0, 0),
                          warpedNewExposed, warpedNewMaskClipped);
    }

    // ── 3. Graph-cut seam finding ──────────────────────────────
    //
    // Find the seam through the overlap region that minimises
    // visual discontinuity (places it along scene gradients).
    // Operates on float-type images.  Outputs updated masks where
    // the seam cuts across the overlap — `seamMaskCanvas` says
    // "use canvas here", `seamMaskNew` says "use new frame here".
    cv::Mat seamMaskCanvas = canvasRegionMask.clone();
    cv::Mat seamMaskNew    = warpedNewMaskClipped.clone();
    {
        cv::Ptr<cv::detail::SeamFinder> seamFinder =
            cv::makePtr<cv::detail::GraphCutSeamFinder>(
                cv::detail::GraphCutSeamFinder::COST_COLOR);
        std::vector<cv::UMat> imagesF(2);
        cv::Mat canvasF, newF;
        canvasRegion.convertTo(canvasF, CV_32F);
        warpedNewExposed.convertTo(newF, CV_32F);
        canvasF.copyTo(imagesF[0]);
        newF.copyTo(imagesF[1]);
        std::vector<cv::Point> corners = {cv::Point(0, 0), cv::Point(0, 0)};
        std::vector<cv::UMat> masks(2);
        seamMaskCanvas.copyTo(masks[0]);
        seamMaskNew.copyTo(masks[1]);
        seamFinder->find(imagesF, corners, masks);
        masks[0].copyTo(seamMaskCanvas);
        masks[1].copyTo(seamMaskNew);
    }

    // First-touch handling: anywhere the canvas was empty before
    // (no prior data), the new frame's seam mask must include those
    // pixels regardless of what the seam finder said.  Otherwise we
    // get holes.
    cv::Mat noPrior;
    cv::compare(canvasRegionMask, 0, noPrior, cv::CMP_EQ);
    cv::Mat newOnlyRegion;
    cv::bitwise_and(noPrior, warpedNewMaskClipped, newOnlyRegion);
    cv::bitwise_or(seamMaskNew, newOnlyRegion, seamMaskNew);

    // ── 4. Multi-band blending ─────────────────────────────────
    //
    // Decomposes both contributions into Laplacian pyramids,
    // blends each band separately, reconstructs.  Hides any
    // residual misalignment along the seam by spreading the
    // transition across multiple frequency bands.
    cv::Rect blendRoi(0, 0, dstRoiClipped.width, dstRoiClipped.height);
    cv::detail::MultiBandBlender blender(/*try_gpu=*/false, /*num_bands=*/5);
    blender.prepare(blendRoi);

    cv::Mat canvasS, newS;
    canvasRegion.convertTo(canvasS, CV_16SC3);
    warpedNewExposed.convertTo(newS, CV_16SC3);

    blender.feed(canvasS, seamMaskCanvas, cv::Point(0, 0));
    blender.feed(newS,    seamMaskNew,    cv::Point(0, 0));

    cv::Mat blendedS, blendedMask;
    blender.blend(blendedS, blendedMask);
    cv::Mat blended8;
    blendedS.convertTo(blended8, CV_8UC3);

    // Write back into the canvas region — only where the union mask
    // says we have any contribution.
    blended8.copyTo(canvasRegion, blendedMask);
    cv::bitwise_or(canvasRegionMask, blendedMask, canvasRegionMask);
    return YES;
}

@end
