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
// V11 Gap #30: deleted dead kHomDetMin/kHomDetMax — pose-driven path
// doesn't fit a homography, so the determinant bounds were dead.

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
    /// V11 Gap #5: last-accepted rotation matrix (ARKit cam-to-world).
    /// The pose-delta gate computes the relative rotation between
    /// frames in SENSOR FRAME (axes fixed to the device hardware),
    /// not in world frame.  World-frame yaw/pitch were being compared
    /// against camera-frame FoV, which broke landscape pitch pans
    /// (the dominant pan axis is rotation about world-Y, but in
    /// landscape the sensor sees that as pitch-equivalent motion).
    cv::Mat _lastAcceptedR;

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
        // V11 Gap #4: square canvas so EITHER pan axis fits.  The
        // primary use case (top-to-bottom landscape pan) needs canvas-Y
        // ≥ 3000 px to cover ~90° pitch at typical compose focal — the
        // earlier 2200 px clipped the pan after 4-5 frames.  5000² is
        // ~88 MB (canvas + mask), comfortable on iPhone 13+ where the
        // app is targeted.  Real auto-grow is deferred — flat over-
        // allocation is simpler and works for both use cases.
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 5000;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 5000;
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
    _lastAcceptedR = cv::Mat();  // V11 Gap #5: clear sensor-frame gate state
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
        // V11 Gap #1: per-axis intrinsics scaling (was averaging into
        // a single scalar — silently distorts whenever compose dims
        // ratio ≠ sensor dims ratio).  K_compose = diag(sx,sy,1)·K.
        double sx = (double)frameBGR.cols / std::max((NSInteger)1, imageWidth);
        double sy = (double)frameBGR.rows / std::max((NSInteger)1, imageHeight);
        _K_compose = (cv::Mat_<double>(3, 3) <<
                      fx * sx, 0,       cx * sx,
                      0,       fy * sy, cy * sy,
                      0,       0,       1);
        // V11 Gap #2: cylinder radius = geometric mean of compose
        // focals.  Was just `fx * s`, which made canvas h-spacing
        // inconsistent with theta-spacing for any anisotropic-pixel
        // intrinsic.
        _focalCompose = std::sqrt((fx * sx) * (fy * sy));

        // V9: build the panorama-to-world rotation from the first
        // ARKit pose.  Panorama +Y = world up, +Z = horizontal
        // projection of first-camera forward.
        cv::Mat fwdArkitCam = (cv::Mat_<double>(3, 1) << 0, 0, -1);
        cv::Mat fwdWorld = _firstRotationArkit * fwdArkitCam;
        double fwx = fwdWorld.at<double>(0);
        double fwz = fwdWorld.at<double>(2);
        double horiz = std::sqrt(fwx * fwx + fwz * fwz);
        // V11 Gap #3: reject the first frame if the camera is
        // looking nearly straight up or down.  The panorama frame
        // needs a horizontal +Z anchor; if camera-forward is
        // gravity-aligned, the horizontal projection is degenerate.
        // Earlier code silently substituted (0, 0, -1) which gave a
        // panorama basis that didn't match the operator's actual
        // pan direction — every subsequent frame's placement was
        // arbitrary.  Refuse and let the operator level the camera.
        if (horiz < 0.1) {
            tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
            tele.processingMs = msSince(t0);
            // Note: we DON'T set _hasFirstFrame, so the next ingest
            // attempt will try again with the new pose.  Operator
            // tilting toward horizon will succeed naturally.
            return tele;
        }
        double pzx = fwx / horiz;
        double pzz = fwz / horiz;
        // pan_X = pan_Y × pan_Z = (0,1,0) × (pzx,0,pzz) = (pzz, 0, -pzx)
        _R_panToWorld = (cv::Mat_<double>(3, 3) <<
            pzz,   0, pzx,
            0,     1, 0,
            -pzx,  0, pzz);

        // Place first frame onto canvas via spherical warp.  R for
        // the warp is panorama→camera in OpenCV cam frame; for the
        // first frame this is approximately identity (camera-forward
        // = panorama +Z).  The spherical warp gives us a warped
        // image + a corner in sphere-pixel (theta, phi)·f space.
        cv::Mat warpedFirst, warpedFirstMask;
        cv::Point firstCornerCyl =
            [self sphericalWarp:frameBGR rArkit:R_new
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
        _lastAcceptedR = R_new.clone();
        _hasFirstFrame = true;
        _accepted = 1;
        tele.outcome = RLISFrameOutcomeAcceptedHigh;
        tele.confidence = 1.0;
        tele.overlapPercent = 0;
        tele.processingMs = msSince(t0);
        return tele;
    }

    // V11 Gap #5: pose-delta gate in SENSOR FRAME.
    //
    // Compute the relative rotation between the last-accepted frame
    // and this frame, expressed in the previous frame's CAMERA-LOCAL
    // axes (these are fixed to the device sensor hardware regardless
    // of how the user is holding the phone).
    //
    //   R_relative_in_prev_cam = R_prev⁻¹ · R_new   (column-vector convention)
    //
    // For ARKit camera axes (+X right, +Y up, −Z forward):
    //   rotation about sensor +Y → scene shifts horizontally on screen
    //                              → compare against fovH
    //   rotation about sensor +X → scene shifts vertically on screen
    //                              → compare against fovV
    //
    // For small-angle rotations (typical accept window 5-25°),
    // cv::Rodrigues' axis-angle vector ≈ (rotX, rotY, rotZ) with
    // each component being the rotation about that sensor axis.
    cv::Mat R_relSensor = _lastAcceptedR.t() * R_new;
    cv::Mat rvec;
    cv::Rodrigues(R_relSensor, rvec);
    double sensorRotX = std::fabs(rvec.at<double>(0));
    double sensorRotY = std::fabs(rvec.at<double>(1));
    double overlap = computeOverlapPctSensor(
        sensorRotX,
        sensorRotY,
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

    // V12 spherical warp + feather blend.
    cv::Mat warpedNew, warpedNewMask;
    cv::Point newCornerCyl =
        [self sphericalWarp:frameBGR rArkit:R_new
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
    _lastAcceptedR = R_new.clone();  // V11 Gap #5: sensor-frame gate state
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
    // Final output: bounding-box crop + CLAHE.  Runs off the AR
    // delegate thread because the Swift wrapper dispatches finalize
    // on workQueue.  V12 Gap #2: dropped the O(W·H) inscribed-rect
    // search — it produced a far thinner output than the actual
    // painted region for any non-rectangular pan footprint, and the
    // mask edges are clean (no per-pixel artefacts to crop away).
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

    cv::Rect cropRect(0, 0, _canvas.cols, _canvas.rows);
    if (tightCrop) {
        cv::Rect bbox = cv::boundingRect(_canvasMask);
        if (bbox.width > 0 && bbox.height > 0) {
            cropRect = bbox;
        }
    }
    cv::Mat cropped = _canvas(cropRect).clone();

    // V11 Gap #14: NO output rotation needed.
    //
    // The earlier (v7) sensor-native canvas needed a gravity-derived
    // rotation because the canvas was the camera buffer's pixel
    // layout — buffer-Y was image-down for portrait, image-right for
    // landscape, etc.  V8+ switched to a panorama-frame canvas
    // (gravity-up = +panorama-Y; the warp Y-flip puts world-up at
    // image-top by construction).  V12 swapped the cylindrical warp
    // for spherical — same gravity-alignment guarantee holds.  The
    // canvas IS already correctly oriented for any device hold.
    cv::Mat out = cropped;

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
/// V11 Gap #5: sensor-frame gate.
///
/// Inputs are absolute rotation magnitudes (radians) about the
/// sensor's +X and +Y axes — these axes are FIXED to the device
/// hardware regardless of how the operator is holding the phone.
///
///   sensorRotXRad: rotation about sensor +X → vertical scene shift
///                  → compare against fovV (sensor's vertical FoV)
///   sensorRotYRad: rotation about sensor +Y → horizontal scene shift
///                  → compare against fovH (sensor's horizontal FoV)
///
/// The "dominant axis = pan direction" heuristic still applies — pick
/// whichever rotation is larger and use the matching FoV to compute
/// the per-axis overlap.  Output is overlap percent [0, 100].
static double computeOverlapPctSensor(double sensorRotXRad,
                                      double sensorRotYRad,
                                      double fovHorizDegrees,
                                      double fovVertDegrees)
{
    double fovH = fovHorizDegrees * M_PI / 180.0;
    double fovV = fovVertDegrees * M_PI / 180.0;
    if (fovH <= 1e-6) fovH = 65.0 * M_PI / 180.0;
    if (fovV <= 1e-6) fovV = 50.0 * M_PI / 180.0;

    double overlap;
    if (sensorRotYRad >= sensorRotXRad) {
        overlap = 1.0 - sensorRotYRad / fovH;
    } else {
        overlap = 1.0 - sensorRotXRad / fovV;
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

/// V12 hand-rolled SPHERICAL (equirectangular) projection.
/// (Was cylindrical pre-V12 — replaced for the primary use case
/// of top-to-bottom landscape pan, which hits cylindrical's
/// degenerate poles at moderate pitch angles.  Spherical handles
/// ±90° pitch cleanly.)
///
/// Sphere parameterised by:
///   theta = horizontal angle (longitude), atan2(-wx, wz)
///                       (the −wx is the V12 mirror fix —
///                       panorama-X is "user's left" in our
///                       right-handed setup, so we flip the X
///                       sign before computing theta to put
///                       user's-right content at canvas-right)
///   phi   = vertical angle (latitude),    asin(wy / |w|)
///   pixel = (focal · theta, -focal · phi)
///                       (the −phi is the Y-flip — panorama +Y
///                       is gravity-up, image +Y is image-down)
///
/// Inverse map:
///   theta = canvas_x / focal
///   phi   = -canvas_y / focal
///   ray   = (-cos(phi)·sin(theta), sin(phi), cos(phi)·cos(theta))
///
/// The ray is unit-length and well-defined for ALL (theta, phi)
/// in [−π,π] × [−π/2, π/2] — no singularities except at the poles
/// themselves where cos(phi) = 0 (degenerate but bounded).
///
/// Returns the bbox's top-left in sphere-pixel coords; the
/// caller adds the canvas origin offset to land it on the canvas.
- (cv::Point)sphericalWarp:(const cv::Mat &)src
                     rArkit:(const cv::Mat &)rArkit
                   outImage:(cv::Mat &)outImage
                    outMask:(cv::Mat &)outMask
{
    if (_R_panToWorld.empty() || _focalCompose <= 0) {
        outImage = cv::Mat();
        outMask = cv::Mat();
        return cv::Point(0, 0);
    }

    // Panorama→camera rotation:  R_panToCam = M · R_arkit⁻¹ · R_panToWorld
    cv::Mat R_panToCam = _M_arkitToCv * rArkit.t() * _R_panToWorld;
    cv::Mat R_camToPan = R_panToCam.t();

    const double fx = _K_compose.at<double>(0, 0);
    const double fy = _K_compose.at<double>(1, 1);
    const double cx = _K_compose.at<double>(0, 2);
    const double cy = _K_compose.at<double>(1, 2);
    const double f  = _focalCompose;

    // ── Forward-project source corners onto sphere to size bbox ──
    auto projectCorner = ^cv::Point2d(double u, double v) {
        double rx = (u - cx) / fx;
        double ry = (v - cy) / fy;
        double rz = 1.0;
        double wx = R_camToPan.at<double>(0,0)*rx + R_camToPan.at<double>(0,1)*ry + R_camToPan.at<double>(0,2)*rz;
        double wy = R_camToPan.at<double>(1,0)*rx + R_camToPan.at<double>(1,1)*ry + R_camToPan.at<double>(1,2)*rz;
        double wz = R_camToPan.at<double>(2,0)*rx + R_camToPan.at<double>(2,1)*ry + R_camToPan.at<double>(2,2)*rz;
        double rayMag = std::sqrt(wx*wx + wy*wy + wz*wz);
        if (rayMag < 1e-9) return cv::Point2d(0, 0);
        // V12 MIRROR FIX: flip wx sign so user's-right (world +X,
        // which is panorama-X = -1 in our right-handed setup)
        // maps to positive theta = canvas-right.
        double theta = std::atan2(-wx, wz);
        double phi = std::asin(std::clamp(wy / rayMag, -1.0, 1.0));
        // Y-flip: panorama +Y is gravity-up, image +Y is image-down.
        return cv::Point2d(f * theta, -f * phi);
    };
    cv::Point2d c00 = projectCorner(0, 0);
    cv::Point2d c10 = projectCorner((double)src.cols - 1, 0);
    cv::Point2d c01 = projectCorner(0, (double)src.rows - 1);
    cv::Point2d c11 = projectCorner((double)src.cols - 1, (double)src.rows - 1);
    // Sample additional points along the source edges — for spherical
    // projection at extreme pitch, the bbox of just 4 corners can
    // miss the "bulge" the sphere creates between corners.
    cv::Point2d cTop  = projectCorner(src.cols / 2.0, 0);
    cv::Point2d cBot  = projectCorner(src.cols / 2.0, (double)src.rows - 1);
    cv::Point2d cLeft = projectCorner(0, src.rows / 2.0);
    cv::Point2d cRight= projectCorner((double)src.cols - 1, src.rows / 2.0);
    double minX = std::min({c00.x, c10.x, c01.x, c11.x, cTop.x, cBot.x, cLeft.x, cRight.x});
    double maxX = std::max({c00.x, c10.x, c01.x, c11.x, cTop.x, cBot.x, cLeft.x, cRight.x});
    double minY = std::min({c00.y, c10.y, c01.y, c11.y, cTop.y, cBot.y, cLeft.y, cRight.y});
    double maxY = std::max({c00.y, c10.y, c01.y, c11.y, cTop.y, cBot.y, cLeft.y, cRight.y});

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

    const double r00 = R_panToCam.at<double>(0,0), r01 = R_panToCam.at<double>(0,1), r02 = R_panToCam.at<double>(0,2);
    const double r10 = R_panToCam.at<double>(1,0), r11 = R_panToCam.at<double>(1,1), r12 = R_panToCam.at<double>(1,2);
    const double r20 = R_panToCam.at<double>(2,0), r21 = R_panToCam.at<double>(2,1), r22 = R_panToCam.at<double>(2,2);

    for (int y = 0; y < bboxH; y++) {
        float *mx = mapX.ptr<float>(y);
        float *my = mapY.ptr<float>(y);
        double sphereY = (double)(bboxY + y);
        double phi = -sphereY / f;  // inverse of forward Y-flip
        double sinPhi = std::sin(phi);
        double cosPhi = std::cos(phi);
        for (int x = 0; x < bboxW; x++) {
            double sphereX = (double)(bboxX + x);
            double theta = sphereX / f;
            double sinT = std::sin(theta);
            double cosT = std::cos(theta);
            // Inverse of the V12 mirror fix: wx = -cosPhi · sinT
            // (forward had theta = atan2(-wx, wz)).
            double wx = -cosPhi * sinT;
            double wy = sinPhi;
            double wz = cosPhi * cosT;
            double rx = r00*wx + r01*wy + r02*wz;
            double ry = r10*wx + r11*wy + r12*wz;
            double rz = r20*wx + r21*wy + r22*wz;
            if (rz <= 1e-6) {
                mx[x] = -1.0f;
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

    outImage.create(bboxH, bboxW, src.type());
    cv::remap(src, outImage, mapX, mapY,
              cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0));

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

    // Forward track: canvas → warped.
    std::vector<cv::Point2f> warpedPts;
    std::vector<uchar> statusFwd;
    std::vector<float> errFwd;
    cv::calcOpticalFlowPyrLK(canvasGray, warpedGray,
                              canvasPts, warpedPts, statusFwd, errFwd,
                              cv::Size(21, 21), 3,
                              cv::TermCriteria(
                                  cv::TermCriteria::COUNT
                                      | cv::TermCriteria::EPS,
                                  20, 0.03));

    // V11 Gap #9: forward-backward bidirectional check.  Track the
    // forward-tracked points BACK into the canvas frame; reject any
    // point whose round-trip error exceeds 1 px.  Status flag and
    // patch-error threshold catch obvious failures, but trackers
    // can drift inside the search window without flipping status —
    // FB error is the standard reliability gate (every production
    // OF aligner uses it).
    std::vector<cv::Point2f> canvasPtsRev;
    std::vector<uchar> statusBwd;
    std::vector<float> errBwd;
    cv::calcOpticalFlowPyrLK(warpedGray, canvasGray,
                              warpedPts, canvasPtsRev, statusBwd, errBwd,
                              cv::Size(21, 21), 3,
                              cv::TermCriteria(
                                  cv::TermCriteria::COUNT
                                      | cv::TermCriteria::EPS,
                                  20, 0.03));

    // Build the inlier set: forward + backward both succeeded, FB
    // error < 1 px, displacement in plausible range.
    std::vector<cv::Point2f> goodCanvas, goodWarped;
    goodCanvas.reserve(canvasPts.size());
    goodWarped.reserve(canvasPts.size());
    for (size_t i = 0; i < canvasPts.size(); i++) {
        if (!statusFwd[i] || !statusBwd[i]) continue;
        if (errFwd[i] > 30.0f || errBwd[i] > 30.0f) continue;
        float fbDx = canvasPtsRev[i].x - canvasPts[i].x;
        float fbDy = canvasPtsRev[i].y - canvasPts[i].y;
        if (fbDx*fbDx + fbDy*fbDy > 1.0f) continue;  // > 1 px FB error
        float dx = warpedPts[i].x - canvasPts[i].x;
        float dy = warpedPts[i].y - canvasPts[i].y;
        if (std::fabs(dx) > 30.0f || std::fabs(dy) > 30.0f) continue;
        goodCanvas.push_back(canvasPts[i]);
        goodWarped.push_back(warpedPts[i]);
    }
    if (goodCanvas.size() < 6) return cv::Point2f(0, 0);

    // V11 Gap #10: 2-D RANSAC translation fit (instead of per-axis
    // independent median, which can pick a (dx, dy) that no single
    // point voted for — an issue in multi-modal flow scenes like a
    // shelf with a moving customer).
    //
    // `estimateAffinePartial2D` fits a 2.5-DoF (rotation + uniform
    // scale + translation) similarity transform with RANSAC.  We
    // use only the translation component; the rotation/scale fall-
    // out shouldn't be applied (cylindrical warp already handled
    // those — OF is only correcting residual translation).
    std::vector<uchar> ransacInliers;
    cv::Mat affine = cv::estimateAffinePartial2D(
        goodCanvas, goodWarped, ransacInliers, cv::RANSAC,
        /*ransacReprojThreshold=*/3.0,
        /*maxIters=*/2000,
        /*confidence=*/0.99,
        /*refineIters=*/10);
    if (affine.empty()) return cv::Point2f(0, 0);
    // Inlier ratio sanity check.
    int inlierCount = cv::countNonZero(ransacInliers);
    if (inlierCount < 6 || inlierCount * 2 < (int)goodCanvas.size()) {
        return cv::Point2f(0, 0);
    }
    float medDx = (float)affine.at<double>(0, 2);
    float medDy = (float)affine.at<double>(1, 2);

    // The track tells us "to align canvas pixels with warped pixels,
    // shift WARPED by (-medDx, -medDy)".  We shift the placement
    // of warped on canvas by the opposite to compensate.
    return cv::Point2f(-medDx, -medDy);
}

/// V11 Gap #11: NARROW-band feather blend.  Earlier versions used
/// `alpha = distNew / (distNew + distCanvas)` over the FULL overlap,
/// which smears every pixel of disagreement across the entire
/// overlap region — the textbook ghosting source called out by
/// Brown-Lowe 2007.  At the typical ARKit ~1-2° pose error + KLT-
/// refined ~5 px residual, full-overlap feather creates visible
/// double-image.
///
/// Narrow-band approach: define the SEAM as `distNew == distCanvas`
/// (the locus of equal-distance-from-each-frame's-edge points).
/// Within `kSeamBandPx` of the seam, smoothly transition alpha 0→1.
/// Outside the band, alpha is binary (0 or 1).  Each pixel comes
/// from EXACTLY ONE frame, except in the small seam band — so any
/// per-pixel misalignment can't produce ghosts.
- (void)featherBlendWarped:(cv::Mat)warped
                       mask:(cv::Mat)warpedMask
                intoCanvas:(cv::Mat)canvasRoi
                canvasMask:(cv::Mat)canvasMaskRoi
{
    // V11 Gap #13: per-pair gain compensation BEFORE blending.
    // Frames captured 200ms apart often differ in luminance by
    // 5-15% due to auto-exposure drift; without compensation the
    // panorama shows visible vertical/horizontal banding at every
    // seam.  Apply a per-channel mean ratio (canvas / warped)
    // computed on the overlap region.  Conservative bounds to
    // avoid amplifying noise.
    cv::Mat warpedAdj;
    cv::Mat overlapMask;
    cv::bitwise_and(canvasMaskRoi, warpedMask, overlapMask);
    int overlapPx = cv::countNonZero(overlapMask);
    if (overlapPx > 100) {
        cv::Scalar canvasMean = cv::mean(canvasRoi, overlapMask);
        cv::Scalar warpedMean = cv::mean(warped, overlapMask);
        double gainB = (warpedMean[0] > 1.0) ? (canvasMean[0] / warpedMean[0]) : 1.0;
        double gainG = (warpedMean[1] > 1.0) ? (canvasMean[1] / warpedMean[1]) : 1.0;
        double gainR = (warpedMean[2] > 1.0) ? (canvasMean[2] / warpedMean[2]) : 1.0;
        // Clamp gains to ±25% to avoid blowing out highlights or
        // crushing shadows on a single noisy mean estimate.
        gainB = std::clamp(gainB, 0.75, 1.25);
        gainG = std::clamp(gainG, 0.75, 1.25);
        gainR = std::clamp(gainR, 0.75, 1.25);
        cv::Mat warpedF;
        warped.convertTo(warpedF, CV_32FC3);
        std::vector<cv::Mat> ch(3);
        cv::split(warpedF, ch);
        ch[0] *= gainB;
        ch[1] *= gainG;
        ch[2] *= gainR;
        cv::merge(ch, warpedF);
        warpedF.convertTo(warpedAdj, CV_8UC3);
    } else {
        warpedAdj = warped;
    }

    cv::Mat distNew, distCanvas;
    cv::distanceTransform(warpedMask, distNew, cv::DIST_L2, 3);
    cv::distanceTransform(canvasMaskRoi, distCanvas, cv::DIST_L2, 3);

    // Signed distance from seam: positive = "new wins side", negative
    // = "canvas wins side".  Pixels >= +bandHalf use new (alpha=1),
    // pixels <= -bandHalf use canvas (alpha=0), in-between band gets
    // a smooth ramp.
    constexpr float kSeamBandPx = 5.0f;
    cv::Mat signedDist = distNew - distCanvas;
    cv::Mat alpha;
    // alpha = clamp((signedDist + bandHalf) / band, 0, 1)
    signedDist.convertTo(alpha, CV_32F,
                          1.0 / (2.0 * kSeamBandPx),
                          0.5);
    cv::min(alpha, 1.0f, alpha);
    cv::max(alpha, 0.0f, alpha);

    // First-touch regions: alpha=1 unconditionally (canvas was empty
    // here, new frame is the only source).
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
    warpedAdj.convertTo(warpedF, CV_32FC3);  // V11 Gap #13: use gain-corrected
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

// V11 Gap #21: deleted ~85 lines of dead `warpAndBlend` (legacy v7
// planar warp + Gaussian-blurred binary alpha-blend).  Was never
// called after v9 switched to cylindricalWarp + featherBlendWarped.

@end
