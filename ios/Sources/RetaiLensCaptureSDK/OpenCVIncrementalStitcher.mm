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

    /// V9 pose-driven state — hand-rolled cylindrical projection.
    /// Replaces v7's planar `H = K · R · K⁻¹` with cylindrical
    /// remap into a gravity-aligned panorama frame.  The panorama
    /// frame is defined at first-frame time:
    ///   +Y = world-gravity-up (cylinder axis is vertical)
    ///   +Z = horizontal projection of first camera's forward
    ///        (theta=0 sits at first frame's centre; no wraparound)
    ///   +X = +Y × +Z (right-handed)
    /// This avoids the v8 bug where cv::detail::CylindricalWarper
    /// placed the cylinder seam directly in front of the camera.
    cv::Mat _firstRotationArkit;  // 3x3 CV_64F, ARKit camera-to-world
    cv::Mat _K_compose;           // 3x3 CV_64F, intrinsics scaled to compose dims
    cv::Mat _M_arkitToCv;         // diag(1, -1, -1) basis flip
    cv::Mat _T_canvas;            // (legacy from v7; unused in v9)
    cv::Mat _R_panToWorld;        // 3x3 CV_64F, panorama-to-world (cached at first frame)
    double  _focalCompose;        // cylinder radius in compose pixels
    int     _canvasOriginCylX;    // canvas (0,0) in cylindrical pixel space (origin offset)
    int     _canvasOriginCylY;

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
        // K in compose pixel coords.
        double sx = (double)frameBGR.cols / std::max((NSInteger)1, imageWidth);
        double sy = (double)frameBGR.rows / std::max((NSInteger)1, imageHeight);
        double s = 0.5 * (sx + sy);
        _K_compose = (cv::Mat_<double>(3, 3) <<
                      fx * s, 0,      cx * s,
                      0,      fy * s, cy * s,
                      0,      0,      1);
        _focalCompose = fx * s;  // cylinder radius

        // V9: build the panorama-to-world rotation from the first
        // ARKit pose.  Panorama +Y = world up, +Z = horizontal
        // projection of first-camera forward.
        cv::Mat fwdArkitCam = (cv::Mat_<double>(3, 1) << 0, 0, -1);
        cv::Mat fwdWorld = _firstRotationArkit * fwdArkitCam;
        double fwx = fwdWorld.at<double>(0);
        double fwz = fwdWorld.at<double>(2);
        double horiz = std::sqrt(fwx * fwx + fwz * fwz);
        if (horiz < 1e-6) { fwx = 0; fwz = -1; horiz = 1; }
        double pzx = fwx / horiz;
        double pzz = fwz / horiz;
        // pan_X = pan_Y × pan_Z = (0,1,0) × (pzx,0,pzz) = (pzz, 0, -pzx)
        _R_panToWorld = (cv::Mat_<double>(3, 3) <<
            pzz,   0, pzx,
            0,     1, 0,
            -pzx,  0, pzz);

        // Place first frame onto canvas via cylindrical warp.  R for
        // the warp is panorama→camera in OpenCV cam frame; for the
        // first frame this is approximately identity (camera-forward
        // = panorama +Z).  The cylindrical warp gives us a warped
        // image + a corner in cylindrical-pixel space.
        cv::Mat warpedFirst, warpedFirstMask;
        cv::Point firstCornerCyl =
            [self cylindricalWarp:frameBGR rArkit:R_new
                            outImage:warpedFirst outMask:warpedFirstMask];

        // Anchor the first frame at canvas centre.
        int dstX = (int)(_canvas.cols - warpedFirst.cols) / 2;
        int dstY = (int)(_canvas.rows - warpedFirst.rows) / 2;
        cv::Rect roi(dstX, dstY, warpedFirst.cols, warpedFirst.rows);
        roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        cv::Rect srcRoi(0, 0, roi.width, roi.height);
        warpedFirst(srcRoi).copyTo(_canvas(roi), warpedFirstMask(srcRoi));
        warpedFirstMask(srcRoi).copyTo(_canvasMask(roi),
                                        warpedFirstMask(srcRoi));

        // Track the cylindrical pixel that lives at canvas (0, 0).
        // Subsequent frames' cylindrical corners → canvas position
        // by subtracting this origin.
        _canvasOriginCylX = firstCornerCyl.x - dstX;
        _canvasOriginCylY = firstCornerCyl.y - dstY;

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

    // V9 cylindrical warp + feather blend.
    cv::Mat warpedNew, warpedNewMask;
    cv::Point newCornerCyl =
        [self cylindricalWarp:frameBGR rArkit:R_new
                       outImage:warpedNew outMask:warpedNewMask];
    if (warpedNew.empty()) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // Map cylindrical-pixel corner to canvas-pixel corner.
    cv::Point newCornerCanvas(newCornerCyl.x - _canvasOriginCylX,
                              newCornerCyl.y - _canvasOriginCylY);

    // V9b: optical-flow refinement.  ARKit pose accuracy is ~1-2°,
    // which translates to ~25-50 px residual misalignment at typical
    // focal lengths.  KLT flow on a sparse grid in the overlap
    // region recovers sub-pixel accuracy without needing the full
    // ORB+RANSAC machinery from the v1-v3 path.  The result is a
    // single (dx, dy) translation applied to the canvas placement.
    cv::Point2f shift = [self refineWithOpticalFlow:warpedNew
                                          newMask:warpedNewMask
                                     canvasOrigin:newCornerCanvas];
    newCornerCanvas.x += (int)std::round(shift.x);
    newCornerCanvas.y += (int)std::round(shift.y);

    cv::Rect dstRoi(newCornerCanvas.x, newCornerCanvas.y,
                    warpedNew.cols, warpedNew.rows);
    cv::Rect canvasBounds(0, 0, _canvas.cols, _canvas.rows);
    cv::Rect dstClipped = dstRoi & canvasBounds;
    if (dstClipped.width <= 0 || dstClipped.height <= 0) {
        tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
        tele.processingMs = msSince(t0);
        return tele;
    }
    cv::Rect srcRoi(dstClipped.x - dstRoi.x, dstClipped.y - dstRoi.y,
                    dstClipped.width, dstClipped.height);

    [self featherBlendWarped:warpedNew(srcRoi)
                         mask:warpedNewMask(srcRoi)
                  intoCanvas:_canvas(dstClipped)
                  canvasMask:_canvasMask(dstClipped)];

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
    // Tight-crop the live snapshot to the actual content.  No
    // exposure-comp on live snapshots — CLAHE adds ~50 ms which
    // would push per-accept latency over the realtime budget.
    return [self writeSnapshotToPath:[self currentSnapshotPath]
                          jpegQuality:quality
                            tightCrop:YES
                    applyExposureComp:NO
                                error:error];
}

- (nullable RLISSnapshot *)finalizeAtPath:(NSString *)outputPath
                              jpegQuality:(NSInteger)quality
                                    error:(NSError **)error
{
    // V9d: apply exposure-compensation at finalize.  Runs off the
    // main thread because Swift wrapper dispatches finalize on
    // workQueue.  CLAHE on the L channel of Lab evens out brightness
    // variation across the panorama (frames captured ~200ms apart
    // with auto-exposure produce visible vertical banding without
    // this) without crushing colour or contrast.
    RLISSnapshot *snap = [self writeSnapshotToPath:outputPath
                                       jpegQuality:quality
                                         tightCrop:YES
                                 applyExposureComp:YES
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
                             applyExposureComp:(BOOL)applyExposureComp
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

    if (applyExposureComp && !out.empty()) {
        // CLAHE on the L channel of Lab.  Preserves colour, evens
        // out luminance variation across the panorama.  Conservative
        // clipLimit=2.0 — enough to even out auto-exposure bands,
        // not so much that it crushes highlight/shadow detail.
        cv::Mat lab;
        cv::cvtColor(out, lab, cv::COLOR_BGR2Lab);
        std::vector<cv::Mat> labChannels(3);
        cv::split(lab, labChannels);
        cv::Ptr<cv::CLAHE> clahe = cv::createCLAHE(2.0, cv::Size(8, 8));
        clahe->apply(labChannels[0], labChannels[0]);
        cv::merge(labChannels, lab);
        cv::cvtColor(lab, out, cv::COLOR_Lab2BGR);
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

/// V9 hand-rolled cylindrical projection.
///
/// Projects a source frame onto a vertical cylinder (axis = panorama
/// +Y = world gravity-up).  Output coords:
///   theta  = horizontal angle around the cylinder (radians)
///   h      = vertical offset along the cylinder axis
///   pixel  = (focal · theta, focal · h) at compose-resolution focal
///
/// We compute the panorama→camera rotation `R_panToCam` from the
/// frame's ARKit pose, find the bbox of the source's 4 corners
/// projected onto the cylinder, allocate inverse-map tables for that
/// bbox, then `cv::remap` the source into the bbox.
///
/// Returns the bbox's top-left in cylindrical-pixel coords; the
/// caller adds the canvas origin offset to land it on the canvas.
- (cv::Point)cylindricalWarp:(const cv::Mat &)src
                       rArkit:(const cv::Mat &)rArkit
                     outImage:(cv::Mat &)outImage
                      outMask:(cv::Mat &)outMask
{
    if (_R_panToWorld.empty() || _focalCompose <= 0) {
        outImage = cv::Mat();
        outMask = cv::Mat();
        return cv::Point(0, 0);
    }

    // Panorama→camera rotation (CV_64F internally, CV_32F for SIMD).
    //   R_panToCam = M · R_arkit⁻¹ · R_panToWorld
    cv::Mat R_panToCam = _M_arkitToCv * rArkit.t() * _R_panToWorld;

    // Intrinsics in compose pixels.
    const double fx = _K_compose.at<double>(0, 0);
    const double fy = _K_compose.at<double>(1, 1);
    const double cx = _K_compose.at<double>(0, 2);
    const double cy = _K_compose.at<double>(1, 2);
    const double f  = _focalCompose;

    // ── Forward-project source corners onto cylinder to size bbox ──
    //
    // For each source corner pixel (u, v):
    //   ray_cam   = K⁻¹ · (u, v, 1)   = ((u-cx)/fx, (v-cy)/fy, 1)
    //   ray_world = R_panToCam⁻¹ · ray_cam = R_panToCam.t() · ray_cam
    //   theta     = atan2(ray_world.x, ray_world.z)
    //   h         = ray_world.y / sqrt(x²+z²)
    //   cyl_pixel = (f · theta, f · h)
    cv::Mat R_camToPan = R_panToCam.t();
    auto projectCorner = ^cv::Point2d(double u, double v) {
        double rx = (u - cx) / fx;
        double ry = (v - cy) / fy;
        double rz = 1.0;
        double wx = R_camToPan.at<double>(0,0)*rx + R_camToPan.at<double>(0,1)*ry + R_camToPan.at<double>(0,2)*rz;
        double wy = R_camToPan.at<double>(1,0)*rx + R_camToPan.at<double>(1,1)*ry + R_camToPan.at<double>(1,2)*rz;
        double wz = R_camToPan.at<double>(2,0)*rx + R_camToPan.at<double>(2,1)*ry + R_camToPan.at<double>(2,2)*rz;
        double theta = std::atan2(wx, wz);
        double denom = std::sqrt(wx*wx + wz*wz);
        double h = (denom > 1e-9) ? (wy / denom) : 0.0;
        return cv::Point2d(f * theta, f * h);
    };
    cv::Point2d c00 = projectCorner(0, 0);
    cv::Point2d c10 = projectCorner((double)src.cols - 1, 0);
    cv::Point2d c01 = projectCorner(0, (double)src.rows - 1);
    cv::Point2d c11 = projectCorner((double)src.cols - 1, (double)src.rows - 1);
    double minX = std::min({c00.x, c10.x, c01.x, c11.x});
    double maxX = std::max({c00.x, c10.x, c01.x, c11.x});
    double minY = std::min({c00.y, c10.y, c01.y, c11.y});
    double maxY = std::max({c00.y, c10.y, c01.y, c11.y});

    int bboxX = (int)std::floor(minX);
    int bboxY = (int)std::floor(minY);
    int bboxW = (int)std::ceil(maxX - minX) + 1;
    int bboxH = (int)std::ceil(maxY - minY) + 1;
    if (bboxW <= 0 || bboxH <= 0
        || bboxW > (int)_canvas.cols * 2
        || bboxH > (int)_canvas.rows * 2) {
        outImage = cv::Mat();
        outMask = cv::Mat();
        return cv::Point(0, 0);
    }

    // ── Inverse-map: for each bbox pixel, find source pixel ──
    cv::Mat mapX(bboxH, bboxW, CV_32FC1);
    cv::Mat mapY(bboxH, bboxW, CV_32FC1);

    // Cylindrical → camera: ray_world = (sin θ, h, cos θ)
    //                       ray_cam   = R_panToCam · ray_world
    //                       u = fx · ray.x/ray.z + cx
    //                       v = fy · ray.y/ray.z + cy
    const double r00 = R_panToCam.at<double>(0,0), r01 = R_panToCam.at<double>(0,1), r02 = R_panToCam.at<double>(0,2);
    const double r10 = R_panToCam.at<double>(1,0), r11 = R_panToCam.at<double>(1,1), r12 = R_panToCam.at<double>(1,2);
    const double r20 = R_panToCam.at<double>(2,0), r21 = R_panToCam.at<double>(2,1), r22 = R_panToCam.at<double>(2,2);

    for (int y = 0; y < bboxH; y++) {
        float *mx = mapX.ptr<float>(y);
        float *my = mapY.ptr<float>(y);
        double cylY = (double)(bboxY + y);
        double h = cylY / f;
        for (int x = 0; x < bboxW; x++) {
            double cylX = (double)(bboxX + x);
            double theta = cylX / f;
            double sinT = std::sin(theta);
            double cosT = std::cos(theta);
            double wx = sinT, wy = h, wz = cosT;
            double rx = r00*wx + r01*wy + r02*wz;
            double ry = r10*wx + r11*wy + r12*wz;
            double rz = r20*wx + r21*wy + r22*wz;
            if (rz <= 1e-6) {
                mx[x] = -1.0f;  // out-of-range → INTER_LINEAR border
                my[x] = -1.0f;
            } else {
                double u = fx * rx / rz + cx;
                double v = fy * ry / rz + cy;
                if (u < 0 || u >= (double)src.cols
                    || v < 0 || v >= (double)src.rows) {
                    mx[x] = -1.0f;
                    my[x] = -1.0f;
                } else {
                    mx[x] = (float)u;
                    my[x] = (float)v;
                }
            }
        }
    }

    // Remap source → output bbox.
    outImage.create(bboxH, bboxW, src.type());
    cv::remap(src, outImage, mapX, mapY,
              cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0));

    // Build mask from valid map entries (non-negative).
    outMask.create(bboxH, bboxW, CV_8UC1);
    outMask.setTo(0);
    for (int y = 0; y < bboxH; y++) {
        const float *mx = mapX.ptr<float>(y);
        uchar *m = outMask.ptr<uchar>(y);
        for (int x = 0; x < bboxW; x++) {
            if (mx[x] >= 0.0f) m[x] = 255;
        }
    }

    return cv::Point(bboxX, bboxY);
}

/// V9b KLT optical flow refinement.  Computes a residual translation
/// (dx, dy) the new warped frame should be shifted by to align
/// pixel-perfectly with the existing canvas in their overlap region.
///
/// Algorithm:
///   1. Compute the overlap rect between warpedNew (placed at
///      canvasOrigin) and the existing canvas mask.
///   2. Convert both regions to grayscale.
///   3. `cv::goodFeaturesToTrack` on the canvas overlap: find ~50
///      strong corners.
///   4. `cv::calcOpticalFlowPyrLK` to track those corners into the
///      warped overlap.
///   5. Median (dx, dy) over inlier tracks = residual shift.
///
/// Returns (0, 0) if not enough tracks, or if the shift exceeds a
/// sanity threshold (likely a bad frame, don't bias the placement).
- (cv::Point2f)refineWithOpticalFlow:(const cv::Mat &)warpedNew
                              newMask:(const cv::Mat &)warpedNewMask
                         canvasOrigin:(cv::Point)canvasOrigin
{
    if (_accepted == 0) return cv::Point2f(0, 0);

    // Compute overlap rect (canvas coords).
    cv::Rect newRect(canvasOrigin.x, canvasOrigin.y,
                     warpedNew.cols, warpedNew.rows);
    cv::Rect canvasBounds(0, 0, _canvas.cols, _canvas.rows);
    cv::Rect newOnCanvas = newRect & canvasBounds;
    if (newOnCanvas.width < 16 || newOnCanvas.height < 16) {
        return cv::Point2f(0, 0);
    }

    cv::Mat canvasOverlap = _canvas(newOnCanvas);
    cv::Mat canvasMaskOverlap = _canvasMask(newOnCanvas);
    cv::Mat warpedOverlap = warpedNew(cv::Rect(
        newOnCanvas.x - newRect.x, newOnCanvas.y - newRect.y,
        newOnCanvas.width, newOnCanvas.height));
    cv::Mat warpedMaskOverlap = warpedNewMask(cv::Rect(
        newOnCanvas.x - newRect.x, newOnCanvas.y - newRect.y,
        newOnCanvas.width, newOnCanvas.height));

    // Both regions need pixels — bail if either side is mostly empty.
    int canvasFilled = cv::countNonZero(canvasMaskOverlap);
    int warpedFilled = cv::countNonZero(warpedMaskOverlap);
    int totalPx = newOnCanvas.width * newOnCanvas.height;
    if (canvasFilled < totalPx / 4 || warpedFilled < totalPx / 4) {
        return cv::Point2f(0, 0);
    }

    cv::Mat canvasGray, warpedGray;
    cv::cvtColor(canvasOverlap, canvasGray, cv::COLOR_BGR2GRAY);
    cv::cvtColor(warpedOverlap, warpedGray, cv::COLOR_BGR2GRAY);

    // Find strong corners in canvas, restricted to the overlap mask.
    std::vector<cv::Point2f> canvasPts;
    cv::Mat featureMask;
    cv::bitwise_and(canvasMaskOverlap, warpedMaskOverlap, featureMask);
    cv::goodFeaturesToTrack(canvasGray, canvasPts, /*maxCorners=*/64,
                             /*qualityLevel=*/0.01, /*minDistance=*/10,
                             featureMask, /*blockSize=*/3, false, 0.04);
    if (canvasPts.size() < 8) return cv::Point2f(0, 0);

    // Track into warped frame.
    std::vector<cv::Point2f> warpedPts;
    std::vector<uchar> status;
    std::vector<float> err;
    cv::calcOpticalFlowPyrLK(canvasGray, warpedGray,
                              canvasPts, warpedPts, status, err,
                              cv::Size(21, 21), 3,
                              cv::TermCriteria(
                                  cv::TermCriteria::COUNT
                                      | cv::TermCriteria::EPS,
                                  20, 0.03));

    // Collect inlier displacements.
    std::vector<float> dxs, dys;
    dxs.reserve(canvasPts.size());
    dys.reserve(canvasPts.size());
    for (size_t i = 0; i < canvasPts.size(); i++) {
        if (!status[i] || err[i] > 30.0f) continue;
        float dx = warpedPts[i].x - canvasPts[i].x;
        float dy = warpedPts[i].y - canvasPts[i].y;
        // Filter outliers — implausible jumps.
        if (std::fabs(dx) > 60.0f || std::fabs(dy) > 60.0f) continue;
        dxs.push_back(dx);
        dys.push_back(dy);
    }
    if (dxs.size() < 6) return cv::Point2f(0, 0);

    // Median is robust to remaining outliers.
    std::nth_element(dxs.begin(), dxs.begin() + dxs.size() / 2, dxs.end());
    std::nth_element(dys.begin(), dys.begin() + dys.size() / 2, dys.end());
    float medDx = dxs[dxs.size() / 2];
    float medDy = dys[dys.size() / 2];

    // The track tells us "to align canvas pixels with warped pixels,
    // shift WARPED by (-medDx, -medDy)".  We want to shift the
    // PLACEMENT of warped on canvas by the opposite to compensate.
    return cv::Point2f(-medDx, -medDy);
}

/// V9 feather blend.  Smooth ratio-of-distances feather (the
/// algorithm cv::detail::FeatherBlender uses) over the canvas-vs-new
/// overlap region.  Outside the overlap, copy whichever frame has
/// content.
- (void)featherBlendWarped:(cv::Mat)warped
                       mask:(cv::Mat)warpedMask
                intoCanvas:(cv::Mat)canvasRoi
                canvasMask:(cv::Mat)canvasMaskRoi
{
    cv::Mat distNew, distCanvas;
    cv::distanceTransform(warpedMask, distNew, cv::DIST_L2, 3);
    cv::distanceTransform(canvasMaskRoi, distCanvas, cv::DIST_L2, 3);

    // Ratio alpha: where new is deeper, alpha→1; where canvas is
    // deeper, alpha→0.  Smooth transition mid-overlap.
    cv::Mat sum = distNew + distCanvas + 1e-6f;
    cv::Mat alpha;
    cv::divide(distNew, sum, alpha, 1.0, CV_32F);

    // First-touch regions: alpha=1 unconditionally.
    cv::Mat noPrior;
    cv::compare(canvasMaskRoi, 0, noPrior, cv::CMP_EQ);
    alpha.setTo(1.0f, noPrior);

    // Outside-of-new regions: keep canvas (alpha=0).
    cv::Mat noNew;
    cv::compare(warpedMask, 0, noNew, cv::CMP_EQ);
    alpha.setTo(0.0f, noNew);

    // Per-channel blend.
    cv::Mat alpha3, invAlpha3;
    cv::Mat ch[] = {alpha, alpha, alpha};
    cv::merge(ch, 3, alpha3);
    invAlpha3 = cv::Scalar(1, 1, 1) - alpha3;

    cv::Mat warpedF, canvasF;
    warped.convertTo(warpedF, CV_32FC3);
    canvasRoi.convertTo(canvasF, CV_32FC3);
    cv::Mat blendedF = warpedF.mul(alpha3) + canvasF.mul(invAlpha3);
    cv::Mat blended8;
    blendedF.convertTo(blended8, CV_8UC3);

    // Write back: only where the union mask has content.
    cv::Mat unionMask;
    cv::bitwise_or(warpedMask, canvasMaskRoi, unionMask);
    blended8.copyTo(canvasRoi, unionMask);
    cv::bitwise_or(canvasMaskRoi, warpedMask, canvasMaskRoi);
}

// (Legacy v7 planar warpAndBlend kept below for reference but is no
//  longer called.  Remove in v9-cleanup once the cylindrical path is
//  field-validated.)
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
