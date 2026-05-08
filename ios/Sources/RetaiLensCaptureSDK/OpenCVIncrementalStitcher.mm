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
#import <opencv2/stitching/detail/warpers.hpp>  // V14.0pre — cv::detail::CylindricalWarper

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
@property (nonatomic, readwrite) BOOL isLandscape;
// V12.14.9 — see header doc for `paintedExtent` / `panExtent` semantics.
@property (nonatomic, readwrite) NSInteger paintedExtent;
@property (nonatomic, readwrite) NSInteger panExtent;
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


// ── V15 — RLISStitcherConfig ────────────────────────────────────────

@implementation RLISStitcherConfig

+ (instancetype)configForMode:(NSString *)mode {
    RLISStitcherConfig *c = [[RLISStitcherConfig alloc] init];

    NSString *m = mode ?: @"slitscan-both";
    // Backward-compat translation.
    if ([m isEqualToString:@"firstwins-rectilinear"]) {
        m = @"slitscan-rotate";
    } else if ([m isEqualToString:@"firstwins"] ||
               [m isEqualToString:@"firstwins-zoomed"]) {
        NSLog(@"[V15-config] DEPRECATED engine mode '%@' — falling "
              @"back to 'slitscan-both'", mode);
        m = @"slitscan-both";
    }

    if ([m isEqualToString:@"hybrid"]) {
        // n/a slit-shaping; hybrid uses whole-frame projection.
        c.kPanAxisFractionRect       = 0.30;  // unused for hybrid
        c.kMinAcceptDeltaPx          = 50;
        c.enableTriangulation        = NO;
        c.enableTriAccumulator       = NO;
        c.enable1dNcc                = NO;
        c.nccSearchRadius1d          = 15;
        c.enable2dNcc                = NO;
        c.enableRansacHomography     = NO;
        c.paintMode                  = RLISPaintModeFeatherBlend;  // V12.x feather
        c.hybridProjection           = RLISHybridProjectionPlanar;  // V15: planar default
    } else if ([m isEqualToString:@"slitscan-rotate"]) {
        // V13.0a baseline + 1D NCC.  No tri, no 2D NCC, no homography.
        c.kPanAxisFractionRect       = 0.30;
        c.kMinAcceptDeltaPx          = 0;     // accept on every frame
        c.enableTriangulation        = NO;
        c.enableTriAccumulator       = NO;
        c.enable1dNcc                = YES;   // wobble correction
        c.nccSearchRadius1d          = 15;
        c.enable2dNcc                = NO;
        c.enableRansacHomography     = NO;
        c.paintMode                  = RLISPaintModeFirstPaintedWins;
        c.hybridProjection           = RLISHybridProjectionPlanar;  // unused
    } else {
        // slitscan-both (default).  V13.0a baseline + no gate + feather.
        // Iterate via settings UI: enable tri / 2D NCC / RANSAC as needed.
        c.kPanAxisFractionRect       = 0.30;
        c.kMinAcceptDeltaPx          = 0;     // accept on every frame
        c.enableTriangulation        = NO;
        c.enableTriAccumulator       = NO;
        c.enable1dNcc                = NO;
        c.nccSearchRadius1d          = 15;
        c.enable2dNcc                = NO;
        c.enableRansacHomography     = NO;
        c.paintMode                  = RLISPaintModeFeatherBlend;
        c.hybridProjection           = RLISHybridProjectionPlanar;  // unused
    }

    return c;
}

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
    /// V12.3 orientation-aware cylinder axis.  Derived from
    /// frameRotationDegrees: 0/180 → landscape (axis = pan_X,
    /// transverse cylinder; pan direction is vertical world); 90/270 →
    /// portrait (axis = pan_Y, vertical-axis cylinder; pan direction
    /// is horizontal world).  Apple's pano follows the same rule:
    /// pan along the device's longer side, projection wraps around
    /// the shorter side.
    BOOL _isLandscape;

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

    /// V15 — runtime config controlling projection (cylindrical vs
    /// planar) and other hybrid-specific knobs.  Set via -setConfig:
    /// after init; defaults to hybrid factory config (planar) if
    /// never set.
    RLISStitcherConfig *_config;
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
        // V12.6 Step C: _isLandscape is no longer derived from the
        // JS-passed frameRotationDegrees.  V12.5 telemetry proved
        // JS was sending the wrong value when iOS orientation-lock
        // suppressed the rotation event (always reported portrait
        // even in landscape).  We now detect at first-frame init
        // from R_panToCam directly — see the cylindricalWarp's
        // first-frame branch.  Default false here is just a safe
        // initialiser; it WILL be overwritten before any warping
        // happens.
        _isLandscape = NO;
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

        // V15 — default config (hybrid mode → planar projection).
        // Caller should override via -setConfig: after init.
        _config = [RLISStitcherConfig configForMode:@"hybrid"];

        [self reset];
    }
    return self;
}

- (void)setConfig:(RLISStitcherConfig *)config {
    if (config == nil) return;
    _config = config;
    NSLog(@"[V15-config] hybrid config applied: hybridProjection=%@",
          _config.hybridProjection == RLISHybridProjectionPlanar
              ? @"Planar" : @"Cylindrical");
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
                                       tx:(double)tx
                                       ty:(double)ty
                                       tz:(double)tz
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
    // V13.0e — hybrid engine accepts tx/ty/tz for API symmetry with the
    // slit-scan engine but does not (yet) use them.  The Samsung-style
    // hybrid path's robustness comes from feature-matching its overlap
    // each frame; pose translation correction layered on top would be
    // redundant.  Suppress unused-warning explicitly so the call stays
    // semantically tied to the slit engine.
    (void)tx; (void)ty; (void)tz;

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
        // ARKit pose.  Panorama +Z = horizontal projection of first-
        // camera forward.  For PORTRAIT (cylinder axis = vertical):
        // panorama +Y = world up.  For LANDSCAPE (cylinder axis =
        // horizontal pan rotation axis): V14.0pre — panorama +Y =
        // first-camera +X (sensor X = phone long edge in landscape =
        // pan rotation axis).  This makes pano-Y the actual rotation
        // axis, eliminating the V12.x landscape-projection roll-
        // sensitivity bug (see 2026-05-07-v14-stitcher-plan.md).
        cv::Mat fwdArkitCam = (cv::Mat_<double>(3, 1) << 0, 0, -1);
        cv::Mat fwdWorld = _firstRotationArkit * fwdArkitCam;
        double fwx = fwdWorld.at<double>(0);
        double fwz = fwdWorld.at<double>(2);
        double horiz = std::sqrt(fwx * fwx + fwz * fwz);
        // V11 Gap #3: reject if camera looking nearly vertical.  The
        // panorama frame needs a horizontal +Z anchor; if camera
        // forward is gravity-aligned, the horizontal projection is
        // degenerate.
        if (horiz < 0.1) {
            tele.outcome = RLISFrameOutcomeRejectedAlignmentLost;
            tele.processingMs = msSince(t0);
            return tele;
        }
        double pzx = fwx / horiz;
        double pzz = fwz / horiz;

        // V14.0pre — orientation detection BEFORE _R_panToWorld
        // construction (was V12.6 detection done AFTER, using
        // R_panToCam_first which itself depended on _R_panToWorld —
        // chicken-and-egg).
        //
        // V14.0pre.1 — comparison INVERTED after V14.0pre field test
        // showed it firing backwards.  Hardware geometry: the phone's
        // sensor-Y axis (cam-Y) is along the SHORT edge of the phone.
        // In LANDSCAPE the phone is held long-edge horizontal, so
        // cam-Y points UP in the user's view (= along world-up =
        // gravity).  In PORTRAIT it points sideways (horizontal).
        // V14.0pre had max(|X|,|Z|) > |Y| firing as "landscape" — that
        // pattern actually identifies PORTRAIT.  Field log showed
        // |camY.worldY|=0.937 (clearly landscape) firing isLandscape=0.
        // Inverted comparison matches V12.6 slit-scan detection's
        // direction (absR11 > absR01).
        cv::Mat camYInWorld = _firstRotationArkit *
            (cv::Mat_<double>(3, 1) << 0, 1, 0);
        const double absCamYInWorldX = std::fabs(camYInWorld.at<double>(0));
        const double absCamYInWorldY = std::fabs(camYInWorld.at<double>(1));
        const double absCamYInWorldZ = std::fabs(camYInWorld.at<double>(2));
        _isLandscape = (absCamYInWorldY
                        > std::max(absCamYInWorldX, absCamYInWorldZ));
        NSLog(@"[V14.0pre-orient] engine=hybrid isLandscape=%d "
              @"|camY.worldX|=%.4f |camY.worldY|=%.4f |camY.worldZ|=%.4f",
              (int)_isLandscape, absCamYInWorldX, absCamYInWorldY,
              absCamYInWorldZ);

        if (_isLandscape) {
            // V14.0pre LANDSCAPE: pano-Y = first-cam +X axis (the pan
            // rotation axis for vertical pan).  Cylinder axis = pano-Y
            // = cam-X → roll around cam-Z just slides pixels along
            // theta with no asymmetric distortion.  Pano-Z = horizontal
            // projection of first-cam forward (already computed above).
            // Pano-X = pano-Y × pano-Z (right-handed completion;
            // approximately gravity-up for level first frame).
            //
            // pano-Y = R_first · (1,0,0)  (cam-X in world coords)
            cv::Mat camXInWorld = _firstRotationArkit *
                (cv::Mat_<double>(3, 1) << 1, 0, 0);
            const double pyx = camXInWorld.at<double>(0);
            const double pyy = camXInWorld.at<double>(1);
            const double pyz = camXInWorld.at<double>(2);
            // pano-Z = (pzx, 0, pzz) by construction above.
            // pano-X = pano-Y × pano-Z; with pano-Z having zero Y comp:
            //   px.x = pyy*pzz - pyz*0   = pyy*pzz
            //   px.y = pyz*pzx - pyx*pzz
            //   px.z = pyx*0   - pyy*pzx = -pyy*pzx
            const double pxx = pyy * pzz;
            const double pxy = pyz * pzx - pyx * pzz;
            const double pxz = -pyy * pzx;
            // Columns of _R_panToWorld are pano-X, pano-Y, pano-Z.
            _R_panToWorld = (cv::Mat_<double>(3, 3) <<
                pxx,  pyx,  pzx,
                pxy,  pyy,  0.0,
                pxz,  pyz,  pzz);
        } else {
            // PORTRAIT (unchanged from V9): pano-Y = world up.
            // pano-X = pano-Y × pano-Z = (0,1,0) × (pzx,0,pzz) = (pzz, 0, -pzx)
            _R_panToWorld = (cv::Mat_<double>(3, 3) <<
                pzz,   0, pzx,
                0,     1, 0,
                -pzx,  0, pzz);
        }

        // V14.0pre — sanity check the constructed pano frame is
        // orthonormal (det ≈ 1, R · R^T ≈ I).  Logs once per capture
        // (first-frame).  If det ≈ -1 or off-diagonals are large, the
        // pano-X cross-product computation has a sign or transcription
        // bug — fix BEFORE proceeding.
        const double pano_det = cv::determinant(_R_panToWorld);
        cv::Mat pano_RRT = _R_panToWorld * _R_panToWorld.t();
        NSLog(@"[V14.0pre-pano] det=%.4f I[0,0]=%.4f I[1,1]=%.4f I[2,2]=%.4f "
              @"I[0,1]=%.4f I[0,2]=%.4f I[1,2]=%.4f",
              pano_det,
              pano_RRT.at<double>(0,0), pano_RRT.at<double>(1,1),
              pano_RRT.at<double>(2,2), pano_RRT.at<double>(0,1),
              pano_RRT.at<double>(0,2), pano_RRT.at<double>(1,2));

        // Place first frame onto canvas via cylindrical warp.  R for
        // the warp is panorama→camera in OpenCV cam frame; for the
        // first frame this is approximately identity (camera-forward
        // = panorama +Z).  The cylindrical warp gives us a warped
        // image + a corner in cylindrical-pixel (theta, h)·f space.
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

    // V12.2 cylindrical warp (with V12 mirror fix) + feather blend.
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
    // image-top by construction).  V12 briefly tried spherical but
    // V12.2 reverted to cylindrical — the gravity-alignment guarantee
    // is the same.  The canvas IS already correctly oriented for
    // any device hold.
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

/// V12.2 hand-rolled CYLINDRICAL projection (with V12 mirror fix
/// kept).  V12 had tried spherical to handle extreme pitch, but
/// spherical bulges both axes and made every level frame look
/// fisheye.  Reverted to cylindrical here; pitch-axis flexibility
/// will come from making the cylinder axis orientation-aware
/// (Step 3) rather than from changing the projection itself.
///
/// Cylinder parameterised by:
///   theta = horizontal angle around panorama-Y, atan2(-wx, wz)
///                       (the −wx is the V12 mirror fix —
///                       panorama-X is "user's left" in our
///                       right-handed setup, so we flip X before
///                       atan2 to put user's-right at canvas-right)
///   h     = wy / sqrt(wx² + wz²)         (height up the cylinder)
///   pixel = (focal · theta, -focal · h)
///                       (the −h is the Y-flip — panorama +Y is
///                       gravity-up, image +Y is image-down)
///
/// Inverse map:
///   theta = canvas_x / focal
///   h     = -canvas_y / focal
///   ray   = (-sin(theta), h, cos(theta))
///
/// Vertical lines (perpendicular to the cylinder axis) stay
/// straight in the projection — that's why cylindrical produces a
/// natural-looking panorama for level scenes.  Pitch close to ±90°
/// (looking straight up/down) makes h = wy/sqrt(wx²+wz²) blow up
/// and the bbox grows unbounded; the canvas-x2 sanity check rejects
/// those frames.
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

    // V14.0pre — cv::detail::CylindricalWarper does the projection.
    // R = camera-to-panorama rotation in OpenCV camera frame.  K is
    // intrinsics in CV_32F (warper requires float).  Cylinder radius
    // = focal length.
    //
    // Replaces ~240 lines of hand-rolled per-corner forward projection
    // + bbox computation + inverse-map remap.  Same K + R inputs, same
    // cv::Point corner output (top-left of warped image in cylindrical-
    // pixel space).  Battle-tested edge handling, antialiased remap.
    cv::Mat R_panToCam = _M_arkitToCv * rArkit.t() * _R_panToWorld;
    cv::Mat R_camToPan = R_panToCam.t();

    cv::Mat K32, R32;
    _K_compose.convertTo(K32, CV_32F);
    R_camToPan.convertTo(R32, CV_32F);

    // V15 — projection selectable via _config.hybridProjection.
    // Default is Planar (cv::detail::PlaneWarper) for V15 hybrid mode,
    // because cylindrical projection has the V12.x roll-asymmetry bug
    // that's been documented in the V14 spec.  Planar is well-behaved
    // for pans <60°, which is the typical retail use case.
    cv::Point corner;
    cv::Mat whiteFrame(src.size(), CV_8UC1, cv::Scalar(255));

    if (_config.hybridProjection == RLISHybridProjectionPlanar) {
        cv::detail::PlaneWarper warper((float)_focalCompose);
        corner = warper.warp(src, K32, R32,
                             cv::INTER_LINEAR,
                             cv::BORDER_REFLECT,
                             outImage);
        warper.warp(whiteFrame, K32, R32,
                    cv::INTER_NEAREST,
                    cv::BORDER_CONSTANT,
                    outMask);
    } else {
        cv::detail::CylindricalWarper warper((float)_focalCompose);
        corner = warper.warp(src, K32, R32,
                             cv::INTER_LINEAR,
                             cv::BORDER_REFLECT,
                             outImage);
        warper.warp(whiteFrame, K32, R32,
                    cv::INTER_NEAREST,
                    cv::BORDER_CONSTANT,
                    outMask);
    }

    static bool _v14LoggedFirstWarp = false;
    if (!_v14LoggedFirstWarp) {
        _v14LoggedFirstWarp = true;
        NSLog(@"[V15-warp] hybrid projection=%@ corner=(%d,%d) outSize=%dx%d focal=%.1f",
              _config.hybridProjection == RLISHybridProjectionPlanar
                  ? @"Planar" : @"Cylindrical",
              corner.x, corner.y, outImage.cols, outImage.rows, _focalCompose);
        NSLog(@"[V14.0pre-warp] OpenCV CylindricalWarper "
              @"corner=(%d,%d) outSize=%dx%d focal=%.1f",
              corner.x, corner.y, outImage.cols, outImage.rows,
              _focalCompose);
    }

    return corner;
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
