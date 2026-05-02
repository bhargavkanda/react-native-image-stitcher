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

    /// V7 pose-driven state — sensor-native compute path.  No rotation
    /// chain (the v6 bug).  We store the first frame's ARKit rotation
    /// and a compose-resolution intrinsic matrix; every subsequent
    /// frame's homography is computed directly as
    /// `H = T · K · M · R_first⁻¹ · R_new · M · K⁻¹` in compose
    /// pixel coordinates.  No R2S/S2R, no scaleSensorToCompose
    /// ceremony — clean math, ~1/3 the matrix multiplications, and
    /// no orientation conflict with the canvas shape.
    cv::Mat _firstRotationArkit;  // 3x3 CV_64F, ARKit camera-to-world
    cv::Mat _K_compose;           // 3x3 CV_64F, intrinsics scaled to compose dims
    cv::Mat _M_arkitToCv;         // diag(1, -1, -1) basis flip
    cv::Mat _T_canvas;            // first-frame placement on canvas

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
        // V7: K is in COMPOSE pixel coordinates.  Sensor intrinsics
        // (fx, fy, cx, cy in sensor pixels) get scaled by the same
        // factor we used to downscale the frame from sensor to
        // compose, so the pinhole projection K · ray → pixel
        // produces the right pixel in compose space directly.  No
        // R2S/S chain needed downstream.
        double sx = (double)frameBGR.cols / std::max((NSInteger)1, imageWidth);
        double sy = (double)frameBGR.rows / std::max((NSInteger)1, imageHeight);
        // The downsample is uniform (preserved aspect), so sx == sy
        // in practice.  Use the average defensively.
        double s = 0.5 * (sx + sy);
        _K_compose = (cv::Mat_<double>(3, 3) <<
                      fx * s, 0,      cx * s,
                      0,      fy * s, cy * s,
                      0,      0,      1);

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

    // ── V7 pose-driven homography (sensor-native compose space) ─
    //
    //   R_rel_cv = M · R_first⁻¹ · R_new · M
    //   H_compose = K · R_rel_cv · K⁻¹       (K is in compose pixels)
    //   H_canvas = T_canvas · H_compose
    //
    // where M = diag(1, -1, -1) flips ARKit's (Y-up, -Z forward)
    // camera frame to OpenCV's (Y-down, +Z forward).  No R2S/S
    // chain — the v6 bug was applying an input rotation in the
    // compute pipeline, which forced the output direction to flip
    // through the chain.  V7 keeps frames in sensor-native compose
    // space (just downscaled) and lets the canvas extend in the
    // natural pan direction.  Output rotation for display happens
    // at snapshot/finalize time only.
    cv::Mat R_relCv = _M_arkitToCv * _firstRotationArkit.t() * R_new * _M_arkitToCv;
    cv::Mat H_compose = _K_compose * R_relCv * _K_compose.inv();
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

// ── Inscribed-rectangle search ──────────────────────────────────────
//
// Returns the largest axis-aligned rectangle of all-255 pixels inside
// the binary mask `m` (CV_8UC1).  Classic two-pass algorithm:
//   1. Build a height map where heights[r][c] = number of consecutive
//      255 pixels in column c ending at (and including) row r.
//   2. For each row's heights, find the largest rectangle in the
//      histogram via a monotonic stack (O(W) per row).
// Total: O(W * H).  The returned rect is in `m`'s coordinate frame.
- (cv::Rect)largestInscribedRect:(const cv::Mat &)m {
    if (m.empty()) return cv::Rect(0, 0, 0, 0);
    const int H = m.rows, W = m.cols;
    std::vector<int> heights(W, 0);
    int bestArea = 0;
    cv::Rect best(0, 0, 0, 0);

    for (int r = 0; r < H; r++) {
        const uchar *row = m.ptr<uchar>(r);
        for (int c = 0; c < W; c++) {
            heights[c] = (row[c] >= 128) ? heights[c] + 1 : 0;
        }
        // Largest rectangle in histogram via monotonic stack.
        // Sentinel value at end (W index) with height 0 forces the
        // stack to flush at the end without extra post-loop code.
        std::vector<int> stack;
        stack.reserve(W + 1);
        for (int c = 0; c <= W; c++) {
            int h = (c == W) ? 0 : heights[c];
            int start = c;
            while (!stack.empty() && heights[stack.back()] > h) {
                int top = stack.back(); stack.pop_back();
                int width = c - top;
                int area = heights[top] * width;
                if (area > bestArea) {
                    bestArea = area;
                    best = cv::Rect(top, r - heights[top] + 1,
                                    width, heights[top]);
                }
                start = top;
            }
            if (c < W) stack.push_back(c);
            (void)start;
        }
    }
    return best;
}

// ── Snapshot / finalize ─────────────────────────────────────────────

- (nullable RLISSnapshot *)snapshotWithJpegQuality:(NSInteger)quality
                                              error:(NSError **)error
{
    _snapshotSeq += 1;
    NSLog(@"[RLIS-PIP] snapshot called seq=%ld accepted=%ld canvasMaskNonZero=%d",
          (long)_snapshotSeq, (long)_accepted, cv::countNonZero(_canvasMask));
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
        // Bounding box of painted region (still useful as a fast
        // upper bound — inscribed-rectangle search runs inside this).
        cv::Rect bbox = cv::boundingRect(_canvasMask);
        if (bbox.width <= 0 || bbox.height <= 0) {
            cropRect = cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        } else {
            // Maximum inscribed axis-aligned rectangle inside the
            // painted region (largest rectangle of all-255 pixels in
            // _canvasMask, restricted to the bounding box).  This is
            // what gives the final JPEG clean rectangular borders
            // instead of the jagged corners a planar/cylindrical pan
            // produces — same crop Apple/Samsung apply at finalize.
            //
            // Algorithm: for each row, compute "histogram" of how
            // many consecutive 255-pixels are above each column
            // (including this row).  For each row's histogram,
            // run the classic O(W) stack-based largest-rectangle-
            // in-histogram.  Track the global max across all rows.
            // Total cost O(W*H) on the bbox region only.
            cropRect = [self largestInscribedRect:_canvasMask(bbox)];
            if (cropRect.width <= 0 || cropRect.height <= 0) {
                // Fallback to plain bounding box if for some reason
                // the inscribed search failed (shouldn't happen, but
                // belt-and-suspenders).
                cropRect = bbox;
            } else {
                cropRect.x += bbox.x;
                cropRect.y += bbox.y;
            }
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
    NSLog(@"[RLIS-PIP] imwrite path=%@ size=%dx%d quality=%d ok=%d",
          cleanPath, out.cols, out.rows, q, (int)ok);
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
