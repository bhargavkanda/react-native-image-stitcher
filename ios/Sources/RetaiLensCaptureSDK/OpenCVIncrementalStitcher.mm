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

    /// V6 pose-driven state.  Replaces the v5 feature-matching state
    /// (lastKeypoints/Descriptors/FrameToWorld + ORB + matcher).
    /// On the first accepted frame we capture the camera's ARKit-frame
    /// rotation and intrinsics and use those as the reference for all
    /// subsequent frames' pose-derived homographies.
    cv::Mat _firstRotationArkit;  // 3x3 CV_64F, ARKit camera-to-world
    cv::Mat _K_sensor;            // 3x3 CV_64F, sensor-resolution intrinsics
    cv::Mat _M_arkitToCv;         // diag(1, -1, -1) basis flip
    NSInteger _firstSensorWidth;
    NSInteger _firstSensorHeight;
    /// Cached scale factor + per-frame compose dims captured at first
    /// frame so subsequent frames warp into the same compose-space.
    double _scaleSensorToCompose;
    NSInteger _firstFrameComposeWidth;
    NSInteger _firstFrameComposeHeight;
    /// Canvas-placement translation: places the first frame's
    /// top-left corner at (canvas_center - first_frame_center) so the
    /// pan can extend in either direction symmetrically.
    cv::Mat _T_canvas;

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
        // Frame rotation determines the post-rotate aspect, which in
        // turn drives the compose-dim default.  Caller can override.
        _frameRotationDegrees = frameRotationDegrees;
        BOOL portraitRotation = (frameRotationDegrees == 90 || frameRotationDegrees == 270);
        // Default compose dims preserve the post-rotation aspect of
        // a 4:3 sensor: portrait rotations → 720x960 (3:4), landscape
        // → 960x720 (4:3).  Either way, it's a uniform scale —
        // never a non-uniform stretch that would distort matching.
        _composeWidth  = composeWidth  > 0 ? composeWidth
                          : (portraitRotation ? 720 : 960);
        _composeHeight = composeHeight > 0 ? composeHeight
                          : (portraitRotation ? 960 : 720);
        // Canvas defaults: shelf pans grow horizontally (left-right
        // operator motion in portrait phone) → wide canvas.  4800
        // wide handles ~3 frame-widths of pan; 2200 tall fits one
        // frame-height plus ~150% extension for hand-held pitch
        // wobble + the occasional "lift to read top shelf" gesture.
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

        [self reset];
    }
    return self;
}

- (void)reset {
    _canvas = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC3);
    _canvasMask = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC1);
    _firstRotationArkit = cv::Mat();
    _K_sensor = cv::Mat();
    _T_canvas = cv::Mat::eye(3, 3, CV_64F);
    _firstSensorWidth = 0;
    _firstSensorHeight = 0;
    _scaleSensorToCompose = 1.0;
    _firstFrameComposeWidth = 0;
    _firstFrameComposeHeight = 0;
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
        _firstSensorWidth = imageWidth;
        _firstSensorHeight = imageHeight;
        _firstFrameComposeWidth = frameBGR.cols;
        _firstFrameComposeHeight = frameBGR.rows;
        // Sensor-resolution K (full intrinsics as ARKit reported).
        _K_sensor = (cv::Mat_<double>(3, 3) <<
                     fx, 0,  cx,
                     0,  fy, cy,
                     0,  0,  1);
        // Scale that takes us from sensor pixels (post-frame-rotation)
        // to compose pixels.  For 90/270 rotation the rotated frame
        // size is (sensorH, sensorW); scale = composeWidth / sensorH.
        // For 0/180, scale = composeWidth / sensorW.
        BOOL portraitRot = (_frameRotationDegrees == 90 || _frameRotationDegrees == 270);
        double rotatedW = portraitRot ? (double)imageHeight : (double)imageWidth;
        _scaleSensorToCompose = (double)frameBGR.cols / rotatedW;

        // Place first frame at canvas centre.
        int ox = (int)(_canvas.cols - frameBGR.cols) / 2;
        int oy = (int)(_canvas.rows - frameBGR.rows) / 2;
        cv::Rect roi(ox, oy, frameBGR.cols, frameBGR.rows);
        frameBGR.copyTo(_canvas(roi));
        _canvasMask(roi).setTo(255);
        _T_canvas = (cv::Mat_<double>(3, 3) <<
                     1, 0, (double)ox,
                     0, 1, (double)oy,
                     0, 0, 1);

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

    // ── Pose-driven homography ──────────────────────────────────
    //
    //   R_rel_cv = M · R_first_arkit⁻¹ · R_new_arkit · M
    //   H_sensor = K · R_rel_cv · K⁻¹
    //   H_compose = (S⁻¹ · S2R) · H_sensor · (R2S · S)
    //   H_canvas = T_canvas · H_compose
    //
    // where M = diag(1, -1, -1) flips ARKit's (Y-up, -Z forward)
    // camera frame to OpenCV's (Y-down, +Z forward); R2S maps a
    // post-rotation pixel to a sensor-native pixel; S maps a
    // compose pixel to a post-rotation pixel (just inverse scale).
    // The chain composes in 3x3 cv::Mat multiplications — plenty
    // fast (~5 ms total) and produces a perspective-correct warp
    // for arbitrary 3D camera rotations.

    cv::Mat R_relCv = _M_arkitToCv * _firstRotationArkit.t() * R_new * _M_arkitToCv;
    cv::Mat H_sensor = _K_sensor * R_relCv * _K_sensor.inv();

    cv::Mat R2S = sensorRotationMatrix(_frameRotationDegrees,
                                        (int)_firstSensorWidth,
                                        (int)_firstSensorHeight);
    cv::Mat S2R = R2S.inv();
    double s = _scaleSensorToCompose;
    cv::Mat S = (cv::Mat_<double>(3, 3) <<
                 1.0/s, 0,    0,
                 0,    1.0/s, 0,
                 0,    0,    1);
    cv::Mat S_inv = (cv::Mat_<double>(3, 3) <<
                     s, 0, 0,
                     0, s, 0,
                     0, 0, 1);

    cv::Mat H_compose = S_inv * S2R * H_sensor * R2S * S;
    cv::Mat H_canvas  = _T_canvas * H_compose;

    // Sanity: reject the frame if the homography places the new
    // frame's centre outside the canvas (would warp to a black
    // void and not show anything).  This shouldn't normally happen
    // but guards against pose glitches.
    cv::Mat centreH = (cv::Mat_<double>(3, 1) <<
                       frameBGR.cols / 2.0,
                       frameBGR.rows / 2.0,
                       1.0);
    cv::Mat warpedCentre = H_canvas * centreH;
    double cw = warpedCentre.at<double>(2);
    if (std::fabs(cw) < 1e-6) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }
    double cu = warpedCentre.at<double>(0) / cw;
    double cv_y = warpedCentre.at<double>(1) / cw;
    if (cu < -frameBGR.cols || cu > _canvas.cols + frameBGR.cols
        || cv_y < -frameBGR.rows || cv_y > _canvas.rows + frameBGR.rows) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Warp + hard-seam blend onto the canvas in place.
    [self warpAndBlend:frameBGR worldH:H_canvas];

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

/// Build the 3x3 homography that maps a post-rotation pixel back to
/// its corresponding sensor-native pixel for a given image rotation.
/// `sensorW`/`sensorH` are the sensor's pre-rotation dimensions.
///
/// Convention:
///   R2S * (u_rot, v_rot, 1)ᵀ = (u_sensor, v_sensor, 1)ᵀ
///
/// 90° CW: u_s = v_r,         v_s = sensorH - 1 - u_r
/// 180°  : u_s = sensorW - 1 - u_r, v_s = sensorH - 1 - v_r
/// 270°  : u_s = sensorW - 1 - v_r, v_s = u_r
/// 0°    : identity
static cv::Mat sensorRotationMatrix(int rotationDegrees, int sensorW, int sensorH) {
    if (rotationDegrees == 90) {
        return (cv::Mat_<double>(3, 3) <<
            0, 1, 0,
           -1, 0, sensorH - 1,
            0, 0, 1);
    } else if (rotationDegrees == 180) {
        return (cv::Mat_<double>(3, 3) <<
           -1, 0, sensorW - 1,
            0, -1, sensorH - 1,
            0, 0, 1);
    } else if (rotationDegrees == 270) {
        return (cv::Mat_<double>(3, 3) <<
            0, -1, sensorW - 1,
            1, 0, 0,
            0, 0, 1);
    }
    return cv::Mat::eye(3, 3, CV_64F);
}

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

    // ARKit delivers landscape sensor pixels regardless of device
    // orientation.  Rotation matches the device orientation reported
    // by JS (`useDeviceOrientation`):
    //   portrait        → 90° CW: panorama grows horizontally for
    //                     the user's left↔right pan
    //   portrait-upside-down → 90° CCW
    //   landscape (L/R) → no rotation: sensor is already aligned
    //                     with the user's pan direction
    cv::Mat rotated;
    if (_frameRotationDegrees == 90) {
        cv::rotate(frame, rotated, cv::ROTATE_90_CLOCKWISE);
    } else if (_frameRotationDegrees == 180) {
        cv::rotate(frame, rotated, cv::ROTATE_180);
    } else if (_frameRotationDegrees == 270) {
        cv::rotate(frame, rotated, cv::ROTATE_90_COUNTERCLOCKWISE);
    } else {
        rotated = frame;
    }

    // Uniform-scale downsample preserving the rotated frame's aspect
    // ratio.  Pick the scale factor from whichever input dimension
    // hits its compose target first; the OTHER dimension comes out
    // proportional.  Using the engine's compose dims as a budget
    // keeps the compute predictable while never introducing the
    // non-uniform stretch that the v1/v2 force-resize did.
    double scale = std::min(
        (double)_composeWidth  / (double)rotated.cols,
        (double)_composeHeight / (double)rotated.rows
    );
    if (scale > 1.0) scale = 1.0;  // never upscale
    int outW = std::max(1, (int)std::round(rotated.cols * scale));
    int outH = std::max(1, (int)std::round(rotated.rows * scale));
    cv::Size target(outW, outH);
    if (rotated.cols == outW && rotated.rows == outH) {
        outBGR = rotated;
    } else {
        cv::resize(rotated, outBGR, target, 0, 0, cv::INTER_AREA);
    }
    return YES;
}

// `placeFirstFrame` was removed in v6 — the first-frame logic is now
// inlined in `ingestPixelBuffer:` so the engine can capture the
// reference pose + intrinsics in the same place it positions the
// frame on the canvas.

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

    // Hard midline seam (replaces the v4 ratio-feather).  Within the
    // overlap region, the seam is the locus of points where each
    // pixel is equally far from BOTH frames' outer edges — the
    // "middle" of the overlap.  We use the new frame on whichever
    // side the new frame is "deeper" and the existing canvas where
    // the canvas is deeper.  Each output pixel comes from exactly
    // ONE frame, so misalignment of a few pixels between frames
    // can't produce ghosting (which is what was happening with
    // smooth feather blending — both frames' versions of the same
    // object contributed and you saw both).
    //
    // The transition is softened with a small Gaussian so the seam
    // line itself isn't a hard pixel-perfect cut (which would be
    // visible as a faint line where lighting / exposure differ).
    // 7-px sigma blends across ~3 px on either side — enough to
    // hide micro-misalignment, not enough to reintroduce ghosts.
    //
    // Cylindrical projection + gradient-driven seam placement
    // (where Samsung-style panoramas hide seams along real scene
    // edges) is Phase 0.5 work.  For now, midline + small blur
    // gets us 80% of the way there.
    cv::Mat distNew, distCanvas;
    cv::distanceTransform(warpedMask, distNew, cv::DIST_L2, 3);
    cv::distanceTransform(_canvasMask, distCanvas, cv::DIST_L2, 3);

    // Binary alpha: 1 where new frame is deeper than canvas (use new)
    //               0 where canvas is deeper than new frame  (keep canvas)
    cv::Mat alpha8;
    cv::compare(distNew, distCanvas, alpha8, cv::CMP_GE);

    // First-touch regions: where canvasMask is 0, new frame must
    // write unconditionally (no prior data to seam against).
    // compare() already returns 255 here because distCanvas=0 ≤ distNew.
    // Belt and suspenders: enforce explicitly.
    cv::Mat noPriorMask;
    cv::compare(_canvasMask, 0, noPriorMask, cv::CMP_EQ);
    alpha8.setTo(255, noPriorMask);

    cv::Mat alpha;
    alpha8.convertTo(alpha, CV_32F, 1.0 / 255.0);
    // 3-pixel Gaussian smoothing of the seam to hide pixel-perfect
    // edge artefacts without bringing ghosting back.
    cv::GaussianBlur(alpha, alpha, cv::Size(7, 7), 0);

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
