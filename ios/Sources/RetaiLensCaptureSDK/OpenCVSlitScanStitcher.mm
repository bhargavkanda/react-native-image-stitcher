//
// OpenCVFirstWinsCylindricalStitcher.mm
//
// Apple-style slit-scan engine (Option B from the panorama north-star
// doc).  Reuses the panorama-frame coord setup from v9 but paints
// narrow vertical strips instead of warping whole frames.
//

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
#import <opencv2/features2d.hpp>  // ORB, BFMatcher (V12.11 Step 4)
#import <opencv2/calib3d.hpp>     // findHomography (V12.11 Step 4)

#import <vector>
#import <chrono>
#import <os/log.h>

// V13.0a.4 — diagnostic os_log subsystem.  os_log_with_type(FAULT)
// survives Console.app's NSLog burst rate-limit (~10/sec) — same
// pattern we used in V12.14.x to get crash-trail breadcrumbs through.
static os_log_t SlitDiagLog(void) {
    static os_log_t log = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        log = os_log_create("com.tiger.retailens.sdk", "slitscan");
    });
    return log;
}

#define NO  ((BOOL)0)
#define YES ((BOOL)1)

#import "OpenCVSlitScanStitcher.h"  // file name kept; class renamed to OpenCVFirstWinsCylindricalStitcher (V11 Gap #23)

@implementation OpenCVFirstWinsCylindricalStitcher {
    NSInteger _composeWidth;
    NSInteger _composeHeight;
    NSInteger _canvasWidth;
    NSInteger _canvasHeight;
    /// V12.12 — pan-axis canvas extent (defaults to max of
    /// constructor's canvasWidth/Height, e.g. 5000).  Used at first-
    /// frame allocation to size the pan-axis dimension of the canvas.
    /// The perpendicular axis is taken from the actual frame size at
    /// first-frame ingest, so the canvas is "just wide enough" along
    /// perpendicular and "5000-deep" along the pan axis.  This pairs
    /// with the new engine-internal canvas allocation (deferred to
    /// first frame so we can use the pose-detected orientation).
    NSInteger _canvasPanExtent;
    NSInteger _frameRotationDegrees;
    /// V12.3 orientation-aware cylinder axis — see v9 engine.
    BOOL _isLandscape;
    /// V12.7 Variant B: rectilinear mode.  When YES, skip cylindrical
    /// warp entirely.  First frame is pasted raw onto canvas.
    /// Subsequent frames contribute a narrow central strip placed by
    /// ARKit pose-delta, with first-painted-wins masking.  The
    /// canvas content stays in the camera's native rectilinear
    /// projection — zero cylindrical curvature.
    BOOL _useRectilinear;
    /// V12.7 first-frame anchor for rectilinear placement.
    int _firstFrameDstX;
    int _firstFrameDstY;
    /// V12.11 Step D — running max position along the pan axis.
    /// Tracks the FURTHEST extent reached during the current
    /// capture.  If a subsequent frame's homography-corrected
    /// dst position drops below `max - kReverseStopPx` the
    /// engine treats it as a reverse-direction event and emits
    /// RLISFrameOutcomeRejectedReverseDirection without pasting.
    /// Reset by `[reset]` to firstFrameDstX/Y at first frame.
    int _maxDstX;
    int _maxDstY;

    cv::Mat _canvas;
    cv::Mat _canvasMask;

    // Panorama-frame state — same shape as v9 hybrid engine.
    cv::Mat _firstRotationArkit;
    cv::Mat _M_arkitToCv;
    cv::Mat _R_panToWorld;
    cv::Mat _K_compose;
    double  _focalCompose;
    int     _canvasOriginCylX;
    int     _canvasOriginCylY;

    bool _hasFirstFrame;
    NSInteger _accepted;
    NSInteger _snapshotSeq;

    // Last-strip state — strip placement is incremental from here.
    // V11 Gap #22: deleted dead state (_lastAcceptedTheta,
    // _lastAcceptedH, _slitScanMode) — these were strip-extraction
    // state from the original slit-scan design, never used by the
    // first-painted-wins implementation.
}

- (instancetype)initWithComposeWidth:(NSInteger)composeWidth
                       composeHeight:(NSInteger)composeHeight
                         canvasWidth:(NSInteger)canvasWidth
                        canvasHeight:(NSInteger)canvasHeight
                         featherPx:(NSInteger)featherPx
              frameRotationDegrees:(NSInteger)frameRotationDegrees
                     useRectilinear:(BOOL)useRectilinear
{
    if (self = [super init]) {
        _composeWidth  = composeWidth  > 0 ? composeWidth  : 960;
        _composeHeight = composeHeight > 0 ? composeHeight : 720;
        // V12.12 — canvasWidth/Height args become HINTS, not exact
        // dims: the engine allocates the actual canvas at first frame
        // based on detected orientation.  The pan-axis dimension is
        // max(canvasWidth, canvasHeight) — both are typically 5000 so
        // the value is unambiguous; the perpendicular dim is
        // determined by the actual frame size at first-frame ingest.
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 5000;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 5000;
        _canvasPanExtent = std::max(_canvasWidth, _canvasHeight);
        _frameRotationDegrees = frameRotationDegrees;
        _useRectilinear = useRectilinear;
        _firstFrameDstX = 0;
        _firstFrameDstY = 0;
        _maxDstX = 0;
        _maxDstY = 0;
        // V12.6 Step C: detected at first-frame init from R_panToCam,
        // not from frameRotationDegrees.  Default false here is just
        // a safe initialiser.
        _isLandscape = NO;

        _M_arkitToCv = (cv::Mat_<double>(3, 3) <<
            1, 0, 0,
            0, -1, 0,
            0, 0, -1);

        [self reset];
    }
    return self;
}

- (void)reset {
    // V12.12 — canvas alloc DEFERRED to first-frame branch (see
    // ingestPixelBuffer below) so we can size it based on the
    // pose-detected orientation.  Empty Mats here signal "no canvas
    // yet" — first-frame branch checks `_canvas.empty()` and
    // allocates accordingly.
    _canvas = cv::Mat();
    _canvasMask = cv::Mat();
    _firstRotationArkit = cv::Mat();
    _R_panToWorld = cv::Mat();
    _K_compose = cv::Mat();
    _focalCompose = 0;
    _canvasOriginCylX = 0;
    _canvasOriginCylY = 0;
    _hasFirstFrame = false;
    _accepted = 0;
    _snapshotSeq = 0;
    // V12.11 Step D — clear running-max trackers; will be
    // re-initialised to first-frame position on next accept.
    _firstFrameDstX = 0;
    _firstFrameDstY = 0;
    _maxDstX = 0;
    _maxDstY = 0;
}

- (NSInteger)acceptedCount { return _accepted; }

// Quaternion → rotation matrix (CV_64F).
static cv::Mat quatToR(double qx, double qy, double qz, double qw) {
    double n = std::sqrt(qx*qx + qy*qy + qz*qz + qw*qw);
    if (n > 1e-9) { qx /= n; qy /= n; qz /= n; qw /= n; }
    return (cv::Mat_<double>(3, 3) <<
        1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qw*qz),     2*(qx*qz + qw*qy),
        2*(qx*qy + qw*qz),     1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qw*qx),
        2*(qx*qz - qw*qy),     2*(qy*qz + qw*qx),     1 - 2*(qx*qx + qy*qy));
}

// V11 Gap #22: deleted dead kMinStripWidthPx/kMaxStripWidthPx.
// These were strip-width bounds for the original slit-scan design,
// never referenced in the first-painted-wins implementation.

// V12.12 — fraction of the PAN-AXIS the rectilinear engine retains
// per frame.  The remaining (1 - fraction) is cropped equally from
// both edges of the pan axis, keeping the perpendicular axis full.
//
// Apple-pano-style slit scan: each frame contributes a NARROWER-
// than-frame slit centred on the screen, perpendicular to motion.
// The clipped-out content (top/bottom in landscape, left/right in
// portrait — the user-perceived edges along the pan direction) sits
// behind translucent dim bars in the live preview.  Earlier versions
// (V12.11 Step 3) clipped the LONG sensor axis (perpendicular to
// pan in landscape, along pan in portrait) which produced bars on
// the wrong screen edge in landscape and forced the JS layer to
// guess orientation.  V12.12 makes the engine itself
// orientation-aware: clip rows for landscape (canvas Y is pan
// axis), clip cols for portrait (canvas X is pan axis).
//
// First-frame and subsequent-frame branches both reference this
// constant — DRY-critical because if they ever drift the engine
// misbehaves (frame 1 placed bigger than frame 2's source ROI).
static const double kPanAxisFractionRect = 0.70;

// V13.0a — homographyOffset() and the kHomogTier* constants were
// removed in the revert from V12.11.1 + V12.14 (ORB+RANSAC homography
// correction with 3-tier confidence ladder) back to pose-only paste.
//
// Per-frame homography refinement was chronically fragile under low-
// overlap / low-texture / fast-pan conditions.  V12.14's tier ladder
// filtered the worst homographies but couldn't fully tame them — MED
// tier (translation-only) stripped rotation/scale and produced
// visible chevrons + frame-stacking pull-back artifacts.
//
// V13.0b will reintroduce a LIGHTWEIGHT 1D column-edge NCC
// correlation (~1 ms, ±100 px search) for sub-pixel perpendicular
// drift correction on top of pose — the algorithm production camera
// apps (iOS Camera Pano, Samsung native pano) ship.  Until that
// lands, perpendicular drift is bounded only by ARKit pose accuracy.

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
    // V12.12 — set isLandscape on every telemetry up-front so every
    // return path (early-out trackingPoor, alignment-lost, accept,
    // skip, reverse, etc.) carries the orientation.  Stays at the
    // FIRST-FRAME determination after that point.  Pre-first-frame
    // it's just the default (NO/portrait), which is a safe initial
    // state for the JS layer to render against.
    [tele setValue:@(_isLandscape ? YES : NO) forKey:@"isLandscape"];
    // V12.14.9 — paintedExtent + panExtent on EVERY return path so
    // the JS band overlay can size the thumb proportionally on every
    // state event (not just snapshot frames).
    // V12.14.10: unified — both supported modes use _maxDstY as the
    // pan-axis leading edge.  Pre-first-frame _maxDstY=0 so
    // paintedExtent=0 → fillRatio=0 → minimum-size thumb.
    [tele setValue:@(_maxDstY) forKey:@"paintedExtent"];
    [tele setValue:@(_canvasPanExtent) forKey:@"panExtent"];

    // V13.0a.2 — call counter + per-call state log.  Ram's V13.0a.1
    // trace showed only [V13.0a-focal] firing (1 per capture), no
    // [V13.0a-pose] / [V13.0a-paint] — meaning subsequent frames are
    // returning early before reaching the pose projection.  Most
    // likely culprit: trackingPoor=YES on ARKit → silent return at
    // line ~247.  This log fires on EVERY ingestPixelBuffer call
    // BEFORE any early returns, so we can see how many frames per
    // capture are coming in and what their tracking state is.
    static NSInteger _engineCallCounter = 0;
    _engineCallCounter += 1;
    // Log every 5th call to keep volume manageable but still see
    // the per-frame pattern.  (At 60 fps × 2 sec capture ≈ 120
    // frames → 24 log lines, fits in Console.app's burst budget.)
    if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 3) {
        // V13.0a.4 — FAULT-level os_log to bypass NSLog burst rate-limit.
        os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
            "[V13.0a-call] #%ld hasFirstFrame=%d trackingPoor=%d "
            "useRectilinear=%d _accepted=%ld",
            (long)_engineCallCounter, (int)_hasFirstFrame,
            (int)trackingPoor, (int)_useRectilinear,
            (long)_accepted);
    }

    if (trackingPoor) {
        [tele setValue:@(RLISFrameOutcomeSkippedTrackingPoor) forKey:@"outcome"];
        return tele;
    }

    cv::Mat frameBGR;
    if (![self convertPixelBuffer:pixelBuffer to:frameBGR]) {
        [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
        return tele;
    }

    cv::Mat R_new = quatToR(qx, qy, qz, qw);

    // ── First frame: build panorama coords + paint the FULL first
    //    frame via cylindrical warp.  Earlier slit-scan versions
    //    painted strips only; the user's expectation is "first full
    //    frame visible, slits append at its edges" — which is more
    //    natural than Apple's pure no-first-frame slit-scan.
    if (!_hasFirstFrame) {
        _firstRotationArkit = R_new.clone();
        // V11 Gaps #1, #2: per-axis K scaling + geometric-mean cylinder
        // radius.  See OpenCVIncrementalStitcher.mm for full annotation.
        double sx = (double)frameBGR.cols / std::max((NSInteger)1, imageWidth);
        double sy = (double)frameBGR.rows / std::max((NSInteger)1, imageHeight);
        _K_compose = (cv::Mat_<double>(3, 3) <<
                      fx * sx, 0,       cx * sx,
                      0,       fy * sy, cy * sy,
                      0,       0,       1);
        _focalCompose = std::sqrt((fx * sx) * (fy * sy));

        // V13.0a.1 — diagnostic log #1: focal scaling inputs +
        // computed `focalCompose`.  Lets us check whether
        // imageWidth/imageHeight (from host) match what fx/fy are
        // normalized to.  If `sx` or `sy` ≠ 1.0 unexpectedly, the
        // `alpha × focalCompose` pixel mapping undercounts (or
        // overcounts) → "everything shorter / taller than reality"
        // (the height-shrink artifact in V13.0a captures).
        NSLog(@"[V13.0a-focal] fx=%.1f fy=%.1f imageW=%ld imageH=%ld "
              @"frame=%dx%d sx=%.3f sy=%.3f focalCompose=%.1f",
              fx, fy, (long)imageWidth, (long)imageHeight,
              frameBGR.cols, frameBGR.rows, sx, sy, _focalCompose);

        cv::Mat fwdArkitCam = (cv::Mat_<double>(3, 1) << 0, 0, -1);
        cv::Mat fwdWorld = _firstRotationArkit * fwdArkitCam;
        double fwx = fwdWorld.at<double>(0);
        double fwz = fwdWorld.at<double>(2);
        double horiz = std::sqrt(fwx * fwx + fwz * fwz);
        // V11 Gap #3: reject if camera looking nearly vertical (no
        // horizontal forward to anchor the panorama frame).  See
        // OpenCVIncrementalStitcher.mm for full annotation.
        if (horiz < 0.1) {
            [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
            return tele;
        }
        double pzx = fwx / horiz, pzz = fwz / horiz;
        _R_panToWorld = (cv::Mat_<double>(3, 3) <<
            pzz,  0, pzx,
            0,    1, 0,
            -pzx, 0, pzz);

        // V12.6 Step C: detect orientation from R_panToCam at first
        // frame — see v9 engine for the rationale.  JS's
        // frameRotationDegrees is unreliable when iOS orientation-
        // lock is on; ARKit's pose is ground truth.
        cv::Mat R_panToCam_first = _M_arkitToCv * _firstRotationArkit.t() * _R_panToWorld;
        const double absR01 = std::fabs(R_panToCam_first.at<double>(0, 1));
        const double absR11 = std::fabs(R_panToCam_first.at<double>(1, 1));
        _isLandscape = (absR11 > absR01);
        // V12.12 — re-stamp the tele with the freshly-detected
        // isLandscape so the FIRST frame's state event carries the
        // right value (the up-front set at the top of this method
        // ran before _isLandscape was computed).
        [tele setValue:@(_isLandscape ? YES : NO) forKey:@"isLandscape"];
        NSLog(@"[V12.6-orient] engine=firstwins detected isLandscape=%d "
              @"|R[0,1]|=%.4f |R[1,1]|=%.4f (frameRotationDegrees from JS = %ld)",
              (int)_isLandscape, absR01, absR11, (long)_frameRotationDegrees);

        if (_useRectilinear) {
            // V12.14.10 — UNIFIED clip for both supported modes.
            // Per the two-mode spec (project memory `ar-stitching-two-modes`),
            // the supported modes are landscape+vertical-pan and
            // portrait+horizontal-pan.  Both have pan rotation around
            // CAM +X (the phone's long edge / sensor X direction):
            //
            //   - landscape vertical pan: phone long edge = user
            //     horizontal; rotation around it = tilt up/down.
            //   - portrait horizontal pan: phone long edge = user
            //     vertical; rotation around it = pan sideways.
            //
            // Both rotations move sensor content along sensor Y.
            // So clip ALONG sensor Y (clip rows to 70% = ~756 px),
            // perp = full sensor X (1920) — IDENTICAL in both modes.
            //
            // Pre-V12.14.10 the portrait branch wrongly clipped sensor X
            // (assumed cam +Y rotation = portrait+vertical-pan, an
            // unsupported mode).  That mis-wiring was the root cause of
            // Issue 2 ("sideways portrait → first frame only output").
            int clipW, clipH, srcClipX, srcClipY;
            clipW = frameBGR.cols;  // perpendicular: full sensor X (1920)
            clipH = std::max(1, (int)(frameBGR.rows * kPanAxisFractionRect));
            srcClipX = 0;
            srcClipY = (frameBGR.rows - clipH) / 2;
            cv::Mat frameClipped = frameBGR(cv::Rect(srcClipX, srcClipY, clipW, clipH));

            // V12.14.10 — UNIFIED canvas allocation.  Both supported
            // modes pan along canvas Y (mirrors sensor Y motion).
            // Canvas: 1920 cols × 5000 rows = 1920w × 5000h.
            // Memory: ~28 MB BGR.
            //
            // For portrait+horizontal-pan, the saved JPEG must be in
            // user-perspective WIDE horizontal strip orientation
            // (~5000w × 1920h).  Rotation 90° applied at snapshot /
            // finalize time (see writeOutToPath) — keeps the runtime
            // engine simple, single rotation per output rather than
            // per-frame paste rotations.
            //
            // Pre-V12.14.10 the portrait canvas was 5000×1080 (perp =
            // sensor Y, wrong) — caused frames to never advance dstX
            // because the engine's pose projection was on a different
            // axis than the actual pan direction.
            if (_canvas.empty()) {
                int canvasCols = frameBGR.cols;        // perp = sensor X = 1920
                int canvasRows = (int)_canvasPanExtent; // pan = 5000
                _canvas = cv::Mat::zeros(canvasRows, canvasCols, CV_8UC3);
                _canvasMask = cv::Mat::zeros(canvasRows, canvasCols, CV_8UC1);
                NSLog(@"[V12.14.10-canvas] allocated %dx%d (cols x rows) for "
                      @"isLandscape=%d (pan extent %ld, frame=%dx%d)",
                      canvasCols, canvasRows, (int)_isLandscape,
                      (long)_canvasPanExtent, frameBGR.cols, frameBGR.rows);
            }

            // V12.12 — first-frame placement at canvas ORIGIN (0, 0).
            // With the new engine-internal canvas allocation the
            // canvas perpendicular dim EXACTLY matches the clipped
            // frame's perpendicular dim, so there's no centring
            // offset — both axes are 0.  As the user pans, dstX
            // (portrait) or dstY (landscape) advances from 0.
            int dstX = 0;
            int dstY = 0;
            cv::Rect roi(dstX, dstY, clipW, clipH);
            roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
            cv::Rect srcR(0, 0, roi.width, roi.height);
            frameClipped(srcR).copyTo(_canvas(roi));
            cv::rectangle(_canvasMask, roi, cv::Scalar(255), cv::FILLED);
            _firstFrameDstX = dstX;
            _firstFrameDstY = dstY;
            // V12.11 Step D — initialise the running-max tracker
            // to first-frame position.  Subsequent frames must
            // monotonically advance from here along the pan axis.
            _maxDstX = dstX;
            _maxDstY = dstY;
            _hasFirstFrame = true;
            _accepted = 1;
            [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
            [tele setValue:@(1.0) forKey:@"confidence"];
            // V12.14.9 — first-frame paintedExtent on the RECTILINEAR
            // path (this is the actively-used engine; the cylindrical
            // branch below is V12.2 legacy).  Use the slit's pan-axis
            // size so the band thumb shows non-zero progress on the
            // very first frame.
            // V12.14.10: unified — both supported modes use clipH as
            // the slit's pan-axis extent.
            [tele setValue:@(clipH) forKey:@"paintedExtent"];
            NSLog(@"[V12.12-rect] first frame placed at (%d,%d) clipped=%dx%d "
                  @"(srcClip=%d,%d) along-pan-axis isLandscape=%d focal=%.2f canvas=%dx%d",
                  dstX, dstY, clipW, clipH, srcClipX, srcClipY,
                  (int)_isLandscape, _focalCompose,
                  _canvas.cols, _canvas.rows);
            return tele;
        }

        // V12.2 cylindrical-warp the first frame and place at canvas centre.
        cv::Mat warpedFirst, warpedFirstMask;
        cv::Point firstCornerCyl =
            [self cylindricalWarp:frameBGR rArkit:R_new
                            outImage:warpedFirst outMask:warpedFirstMask];
        if (warpedFirst.empty()) {
            [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
            return tele;
        }
        int dstX = (int)(_canvas.cols - warpedFirst.cols) / 2;
        int dstY = (int)(_canvas.rows - warpedFirst.rows) / 2;
        cv::Rect roi(dstX, dstY, warpedFirst.cols, warpedFirst.rows);
        roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        cv::Rect srcR(0, 0, roi.width, roi.height);
        warpedFirst(srcR).copyTo(_canvas(roi), warpedFirstMask(srcR));
        warpedFirstMask(srcR).copyTo(_canvasMask(roi),
                                       warpedFirstMask(srcR));
        _canvasOriginCylX = firstCornerCyl.x - dstX;
        _canvasOriginCylY = firstCornerCyl.y - dstY;

        _hasFirstFrame = true;
        _accepted = 1;
        [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        [tele setValue:@(1.0) forKey:@"confidence"];
        // V12.14.9 — paintedExtent was set at line ~445 to _maxDstY (= 0
        // before first frame).  In the cylindrical first-frame branch
        // we don't update _maxDstY (cylindrical uses its own canvas-
        // centre placement model rather than the slit-leading-edge
        // tracker).  Leaving paintedExtent at 0 here means the band
        // thumb shows zero progress on the cylindrical first frame —
        // acceptable; the next frame's running-max update will set
        // a real value.  Cylindrical is V12.2 legacy and not the
        // primary engine; rectilinear (above) sets a real value.
        return tele;
    }

    if (_useRectilinear) {
        // V12.8 Variant B subsequent frame: paste the SAME long-side-
        // clipped portion as the first frame, at canvas position
        // offset by pan_angle × focal along the pan axis.  First-
        // painted-wins masking ensures only the LEADING-EDGE sliver
        // (the part outside the previously-painted region) actually
        // gets painted.  Even tiny pans produce immediate
        // incremental growth — no V12.7 dead-zone where strips
        // entirely overlapped the first frame.
        cv::Mat R_rel = _firstRotationArkit.t() * R_new;
        // V12.14.10 — UNIFIED clip for both supported modes (see
        // first-frame branch comment).  Both pan around cam +X →
        // sensor content moves along sensor Y → clip sensor Y to
        // 70%, full sensor X.
        int clipW, clipH, srcClipX, srcClipY;
        clipW = frameBGR.cols;
        clipH = std::max(1, (int)(frameBGR.rows * kPanAxisFractionRect));
        srcClipX = 0;
        srcClipY = (frameBGR.rows - clipH) / 2;
        cv::Mat frameClipped = frameBGR(cv::Rect(srcClipX, srcClipY, clipW, clipH));

        // V12.14.10 — UNIFIED pose projection.  Both supported modes
        // have pan rotation around cam +X axis.  alpha > 0 means the
        // camera rotated such that sensor content moved DOWN (cam-Z
        // toward cam+Y in OpenCV right-down-forward convention) →
        // dstY in canvas advances NEGATIVE (content shifts UP / to
        // smaller Y), matching the existing landscape paste convention.
        //
        // For portrait+horizontal-pan the user perceives this as
        // "look right" or "look left" depending on hold direction;
        // the canvas-Y growth still represents pan progress, and
        // the canvas-rotated saved JPEG (writeOutToPath) maps that
        // progress to the user-perspective horizontal direction.
        double alpha = std::atan2(R_rel.at<double>(2, 1), R_rel.at<double>(1, 1));
        int dstX = _firstFrameDstX;
        int dstY = _firstFrameDstY - (int)std::round(alpha * _focalCompose);

        // V13.0a.4 — FAULT-level os_log (bypasses NSLog burst rate-
        // limit; throttle still applied to keep Console.app readable).
        if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
            os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                "[V13.0a-pose] #%ld alpha_deg=%.3f focal=%.1f dstX=%d dstY=%d "
                "(firstDstY=%d, deltaDstY=%d)",
                (long)_engineCallCounter, alpha * 180.0 / M_PI, _focalCompose,
                dstX, dstY, _firstFrameDstY, dstY - _firstFrameDstY);
        }

        // V13.0a — REVERTED V12.11 Step 4 + V12.11.1 Item E + V12.14
        // homography refinement.  Restored pose-only paste.
        //
        // Why reverted: the ORB+RANSAC homography correction (V12.11)
        // and the full warpPerspective paste (V12.11.1) introduced
        // chronic chevron / banding / frame-stacking artifacts under
        // realistic capture conditions (low overlap, low texture,
        // fast pan).  V12.14's 3-tier ladder filtered the worst
        // homographies but couldn't fully tame them — MED tier
        // translation-only correction strips rotation/scale and
        // produces the "frames pull back" pattern in field traces.
        //
        // Pose-only paste is what production camera apps (iOS Camera
        // Pano, Samsung native pano) use as their PRIMARY tracking;
        // they layer lightweight 1D edge correlation on top for
        // sub-pixel perpendicular drift correction.  V13.0b will
        // restore that lightweight refinement (1D NCC column
        // correlation, ±100 px search) on top of this pose-only
        // baseline.
        //
        // For now (V13.0a): rotation is correct from ARKit pose;
        // perpendicular drift may be visible (~5–10 px on short
        // pans) until V13.0b lands.  Translation along the pan
        // axis comes from `alpha * _focalCompose` above.

        // V12.11 Step D — reverse-direction detection.
        //
        // After homography correction, check whether the new paste
        // position has REGRESSED from the running max along the
        // pan axis by more than `kReverseStopPx`.  If so, the
        // operator has reversed direction (intentionally or
        // accidentally) — skip the paste, emit
        // `RejectedReverseDirection`, and let the host auto-finalise.
        // The high-water-mark (max) is what we want to ship as the
        // pano; back-tracking would only damage it under
        // first-painted-wins.
        //
        // Threshold: 150 px ≈ 4° of pan at the typical iPhone focal —
        // comfortably above normal alignment-correction wobble.
        // V12.14.10 — UNIFIED running-max for both supported modes.
        // Both pan along canvas Y, so _maxDstY is the leading-edge
        // tracker in both.  _maxDstX stays at 0 (perp axis static).
        // Reverse-direction detection: when dstY regresses
        // > kReverseStopPx (150 px ≈ 4° at iPhone focal), auto-stop
        // the engine — operator has clearly reversed pan direction.
        constexpr int kReverseStopPx = 150;
        if (dstY < _maxDstY - kReverseStopPx) {
            NSLog(@"[V12.11-reverse] %s stop: dstY=%d max=%d (regressed %d px)",
                  _isLandscape ? "landscape" : "portrait",
                  dstY, _maxDstY, _maxDstY - dstY);
            [tele setValue:@(RLISFrameOutcomeRejectedReverseDirection) forKey:@"outcome"];
            return tele;
        }

        // V13.0b — minimum-Δ accept gate.  Slow handheld pans
        // currently produce 1–6 px slivers per accept (Ram's
        // V13.0a.4 trace showed ~2–3 px typical), creating ~270
        // zig-zag boundaries in 663 px of pan growth — the high-
        // frequency wobble pattern the eye reads as "compressed
        // vertical features" / TV-stand-looks-shorter.
        //
        // Throttle accepts to require at least kMinAcceptDeltaPx
        // of pan-axis advance from the last accepted frame.  Per-
        // accept sliver becomes ~50 px tall instead of ~2 px,
        // dropping zig-zag boundary count ~25× over the same pan
        // extent.  Same wobble magnitude per boundary, but spread
        // across far fewer transitions = visually much smoother.
        //
        // Mirrors how production camera apps gate slit-scan accepts
        // by motion-distance threshold (iOS Camera Pano, Samsung
        // native pano).  No new outcome enum — reuse SkippedTooClose
        // since the gate's intent matches: "frame too close to
        // previous accept to contribute meaningfully".
        constexpr int kMinAcceptDeltaPx = 50;
        const int panDelta = dstY - _maxDstY;
        if (panDelta < kMinAcceptDeltaPx) {
            // V13.0b — diagnostic gate-fire log (throttled).
            if (_engineCallCounter % 5 == 0) {
                os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                    "[V13.0b-gate] #%ld dstY=%d _maxDstY=%d panDelta=%d "
                    "< kMinAcceptDeltaPx=%d -> SkippedTooClose",
                    (long)_engineCallCounter, dstY, _maxDstY, panDelta,
                    kMinAcceptDeltaPx);
            }
            [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
            auto t1 = std::chrono::steady_clock::now();
            double ms = std::chrono::duration_cast<std::chrono::microseconds>(
                t1 - t0).count() / 1000.0;
            [tele setValue:@(ms) forKey:@"processingMs"];
            return tele;
        }

        // Past the gate: this frame WILL be accepted.  Update
        // running max so the next frame's gate is measured from
        // this position.
        _maxDstY = dstY;

        // V12.14.9 — re-stamp paintedExtent on the tele AFTER the
        // running-max update so JS state reflects THIS frame's
        // contribution.  V12.14.10: unified — both modes use _maxDstY
        // and clipH (sensor Y as pan axis).
        [tele setValue:@(_maxDstY + clipH) forKey:@"paintedExtent"];

        // V13.0a — pose-only paste (the ONLY paste path now in the
        // rectilinear engine).  V12.11.1's full warpPerspective paste
        // and its homography-translation correction were removed;
        // this pose-projected (dstX, dstY) is now the final paste
        // position with no per-frame visual refinement.
        cv::Rect dstRoi(dstX, dstY, clipW, clipH);
        cv::Rect canvasBounds(0, 0, _canvas.cols, _canvas.rows);
        cv::Rect dstClipped = dstRoi & canvasBounds;
        if (dstClipped.width <= 0 || dstClipped.height <= 0) {
            [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
            return tele;
        }
        // Source ROI: same offset within the (already-clipped) frame.
        cv::Rect srcRoi(dstClipped.x - dstX,
                        dstClipped.y - dstY,
                        dstClipped.width, dstClipped.height);
        cv::Mat srcRegion = frameClipped(srcRoi);
        cv::Mat canvasRoi = _canvas(dstClipped);
        cv::Mat maskRoi = _canvasMask(dstClipped);
        // First-painted-wins: only fill where mask == 0.  This is what
        // produces the smooth incremental edge — overlap with first
        // frame is blocked, leading-edge sliver gets the new content.
        cv::Mat emptyMask;
        cv::compare(maskRoi, 0, emptyMask, cv::CMP_EQ);
        int newPixels = cv::countNonZero(emptyMask);
        if (newPixels > 0) {
            srcRegion.copyTo(canvasRoi, emptyMask);
            maskRoi.setTo(255, emptyMask);
            _accepted += 1;
            // V13.0a.1 — diagnostic log #3: per-accept slit width +
            // dst delta from previous accepted frame.  Shrunken pano
            // signal: if slit width per row is consistently small
            // relative to expected per-frame pan, focal calibration
            // is off.
            // V13.0a.3 — THROTTLED to every 5th call (NSLog burst
            // rate-limit).
            const int slitWidthPx = clipW > 0 ? (newPixels / clipW) : 0;
            const int dstYDeltaFromMax = dstY - _maxDstY;
            // V13.0a.4 — FAULT-level os_log + throttle.
            if (_engineCallCounter % 5 == 0 || _engineCallCounter <= 5) {
                os_log_with_type(SlitDiagLog(), OS_LOG_TYPE_FAULT,
                    "[V13.0a-paint] #%ld dstY=%d (deltaFromMax=%+d) clipH=%d "
                    "newPixels=%d slitWidth=%dpx _accepted=%ld",
                    (long)_engineCallCounter, dstY, dstYDeltaFromMax,
                    clipH, newPixels, slitWidthPx, (long)_accepted);
            }
            [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        } else {
            [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
        }
        auto t1 = std::chrono::steady_clock::now();
        double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
        [tele setValue:@(ms) forKey:@"processingMs"];
        return tele;
    }

    // ── Subsequent frame: cylindrical-warp the FULL new frame, then
    //    paint into the canvas ONLY where the canvas mask is empty.
    //    "First-painted wins" — the original first frame stays
    //    untouched in its footprint, and new frames append content
    //    only into pixels that have never been painted before.  This
    //    is what gives the user the "first full frame, slits at the
    //    edges" behaviour.  No gaps because the cylindrical-warped
    //    new frame covers a wide angular extent (similar to the
    //    first frame's), so adjacent frames overlap heavily and
    //    every pixel between them gets covered.
    cv::Mat warpedNew, warpedNewMask;
    cv::Point newCornerCyl =
        [self cylindricalWarp:frameBGR rArkit:R_new
                        outImage:warpedNew outMask:warpedNewMask];
    if (warpedNew.empty()) {
        [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
        return tele;
    }

    cv::Point newCornerCanvas(newCornerCyl.x - _canvasOriginCylX,
                              newCornerCyl.y - _canvasOriginCylY);
    cv::Rect dstRoi(newCornerCanvas.x, newCornerCanvas.y,
                    warpedNew.cols, warpedNew.rows);
    cv::Rect canvasBounds(0, 0, _canvas.cols, _canvas.rows);
    cv::Rect dstClipped = dstRoi & canvasBounds;
    if (dstClipped.width <= 0 || dstClipped.height <= 0) {
        [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
        return tele;
    }
    cv::Rect srcRoi(dstClipped.x - dstRoi.x, dstClipped.y - dstRoi.y,
                    dstClipped.width, dstClipped.height);

    cv::Mat warpedNewClipped     = warpedNew(srcRoi);
    cv::Mat warpedNewMaskClipped = warpedNewMask(srcRoi);
    cv::Mat canvasRoi            = _canvas(dstClipped);
    cv::Mat canvasMaskRoi        = _canvasMask(dstClipped);

    // Paint into NEW pixels only.
    cv::Mat noPrior;
    cv::compare(canvasMaskRoi, 0, noPrior, cv::CMP_EQ);
    cv::Mat paintMask;
    cv::bitwise_and(noPrior, warpedNewMaskClipped, paintMask);
    if (cv::countNonZero(paintMask) > 0) {
        warpedNewClipped.copyTo(canvasRoi, paintMask);
        cv::bitwise_or(canvasMaskRoi, paintMask, canvasMaskRoi);
        _accepted += 1;
        [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        [tele setValue:@(1.0) forKey:@"confidence"];
    } else {
        // No new content to paint — the new frame's coverage is
        // entirely inside the existing canvas.  Skip silently.
        [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
    }

    auto t1 = std::chrono::steady_clock::now();
    double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
    [tele setValue:@(ms) forKey:@"processingMs"];
    return tele;
}

// Hand-rolled cylindrical projection.  Same algorithm as v9's helper
// in OpenCVIncrementalStitcher.mm — duplicated here to keep the two
// engines cleanly separated as separate files.  See that file for
// the full annotation; in short:
//   - panorama frame is gravity-up Y, first-camera-forward Z
//   - R_panToCam = M · R_arkit⁻¹ · R_panToWorld
//   - V12.2 cylindrical projection (theta = atan2(-wx, wz),
//     h = wy/sqrt(wx²+wz²)).  The −wx flip is the V12 mirror fix.
//     V12 had switched to spherical to handle extreme pitch; that
//     bulged level frames into a fisheye, so V12.2 reverts to
//     cylindrical and will solve pitch via an orientation-aware
//     cylinder axis (Step 3).
//   - inverse-map each canvas pixel back to a source pixel
//   - cv::remap fills the output bbox
//   - output mask has 255 only where the inverse map landed inside
//     the source frame
- (cv::Point)cylindricalWarp:(const cv::Mat &)src
                       rArkit:(const cv::Mat &)rArkit
                     outImage:(cv::Mat &)outImage
                      outMask:(cv::Mat &)outMask
{
    if (_R_panToWorld.empty() || _focalCompose <= 0) {
        outImage = cv::Mat(); outMask = cv::Mat();
        return cv::Point(0, 0);
    }
    cv::Mat R_panToCam = _M_arkitToCv * rArkit.t() * _R_panToWorld;
    const double fx = _K_compose.at<double>(0, 0);
    const double fy = _K_compose.at<double>(1, 1);
    const double cx = _K_compose.at<double>(0, 2);
    const double cy = _K_compose.at<double>(1, 2);
    const double f  = _focalCompose;

    cv::Mat R_camToPan = R_panToCam.t();
    // V12.3: orientation-aware cylinder axis — see v9 engine for the
    // full derivation.  Portrait → vertical-axis cylinder.  Landscape
    // → transverse (pan_X-axis) cylinder.
    auto projectCorner = ^cv::Point2d(double u, double v) {
        double rx = (u - cx) / fx;
        double ry = (v - cy) / fy;
        double rz = 1.0;
        double wx = R_camToPan.at<double>(0,0)*rx + R_camToPan.at<double>(0,1)*ry + R_camToPan.at<double>(0,2)*rz;
        double wy = R_camToPan.at<double>(1,0)*rx + R_camToPan.at<double>(1,1)*ry + R_camToPan.at<double>(1,2)*rz;
        double wz = R_camToPan.at<double>(2,0)*rx + R_camToPan.at<double>(2,1)*ry + R_camToPan.at<double>(2,2)*rz;
        if (_isLandscape) {
            double denom = std::sqrt(wy*wy + wz*wz);
            double s = (denom > 1e-9) ? (-wx / denom) : 0.0;
            double theta = std::atan2(wy, wz);
            return cv::Point2d(f * s, -f * theta);
        } else {
            // V12 mirror fix kept: −wx so user's-right maps to canvas-right.
            double theta = std::atan2(-wx, wz);
            double denom = std::sqrt(wx*wx + wz*wz);
            double h = (denom > 1e-9) ? (wy / denom) : 0.0;
            return cv::Point2d(f * theta, -f * h);  // Y-flip
        }
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
        || bboxW > (int)_canvas.cols * 2 || bboxH > (int)_canvas.rows * 2) {
        outImage = cv::Mat(); outMask = cv::Mat();
        return cv::Point(0, 0);
    }
    // V12.4 slit-scan + long-side clip — see v9 engine for the
    // rationale.  Same fractions, same axis-aware logic.
    static const double kPanStripFraction  = 0.70;
    static const double kLongSideFraction  = 0.85;
    int preCropX = bboxX, preCropY = bboxY, preCropW = bboxW, preCropH = bboxH;
    {
        int newW, newH;
        if (_isLandscape) {
            newW = std::max(1, (int)(bboxW * kLongSideFraction));
            newH = std::max(1, (int)(bboxH * kPanStripFraction));
        } else {
            newW = std::max(1, (int)(bboxW * kPanStripFraction));
            newH = std::max(1, (int)(bboxH * kLongSideFraction));
        }
        bboxX += (bboxW - newW) / 2;
        bboxY += (bboxH - newH) / 2;
        bboxW = newW;
        bboxH = newH;
    }
    // V12.5 telemetry — same line shape as v9 engine, engine tag swapped.
    NSLog(@"[V12.5-warp] engine=firstwins accepted=%ld isLandscape=%d "
          @"corners=(%.1f,%.1f),(%.1f,%.1f),(%.1f,%.1f),(%.1f,%.1f) "
          @"preCrop=(x=%d,y=%d,w=%d,h=%d) "
          @"postCrop=(x=%d,y=%d,w=%d,h=%d) "
          @"R_panToCam=[[%.4f,%.4f,%.4f],[%.4f,%.4f,%.4f],[%.4f,%.4f,%.4f]] "
          @"focalCompose=%.2f",
          (long)_accepted, (int)_isLandscape,
          c00.x, c00.y, c10.x, c10.y, c01.x, c01.y, c11.x, c11.y,
          preCropX, preCropY, preCropW, preCropH,
          bboxX, bboxY, bboxW, bboxH,
          R_panToCam.at<double>(0,0), R_panToCam.at<double>(0,1), R_panToCam.at<double>(0,2),
          R_panToCam.at<double>(1,0), R_panToCam.at<double>(1,1), R_panToCam.at<double>(1,2),
          R_panToCam.at<double>(2,0), R_panToCam.at<double>(2,1), R_panToCam.at<double>(2,2),
          f);
    cv::Mat mapX(bboxH, bboxW, CV_32FC1);
    cv::Mat mapY(bboxH, bboxW, CV_32FC1);
    const double r00 = R_panToCam.at<double>(0,0), r01 = R_panToCam.at<double>(0,1), r02 = R_panToCam.at<double>(0,2);
    const double r10 = R_panToCam.at<double>(1,0), r11 = R_panToCam.at<double>(1,1), r12 = R_panToCam.at<double>(1,2);
    const double r20 = R_panToCam.at<double>(2,0), r21 = R_panToCam.at<double>(2,1), r22 = R_panToCam.at<double>(2,2);
    if (_isLandscape) {
        // Transverse cylinder (axis = pan_X) inverse map.
        for (int y = 0; y < bboxH; y++) {
            float *mx = mapX.ptr<float>(y);
            float *my = mapY.ptr<float>(y);
            double cylY = (double)(bboxY + y);
            double theta = -cylY / f;
            double sinTh = std::sin(theta);
            double cosTh = std::cos(theta);
            for (int x = 0; x < bboxW; x++) {
                double cylX = (double)(bboxX + x);
                double s = cylX / f;
                double wx = -s, wy = sinTh, wz = cosTh;
                double rx = r00*wx + r01*wy + r02*wz;
                double ry = r10*wx + r11*wy + r12*wz;
                double rz = r20*wx + r21*wy + r22*wz;
                if (rz <= 1e-6) { mx[x] = -1.0f; my[x] = -1.0f; }
                else {
                    double u = fx * rx / rz + cx;
                    double v = fy * ry / rz + cy;
                    if (u < 0 || u >= (double)src.cols || v < 0 || v >= (double)src.rows) {
                        mx[x] = -1.0f; my[x] = -1.0f;
                    } else { mx[x] = (float)u; my[x] = (float)v; }
                }
            }
        }
    } else {
        // Vertical cylinder (axis = pan_Y) inverse map.
        for (int y = 0; y < bboxH; y++) {
            float *mx = mapX.ptr<float>(y);
            float *my = mapY.ptr<float>(y);
            double cylY = (double)(bboxY + y);
            double h = -cylY / f;  // inverse Y-flip
            for (int x = 0; x < bboxW; x++) {
                double cylX = (double)(bboxX + x);
                double theta = cylX / f;
                double sinT = std::sin(theta);
                double cosT = std::cos(theta);
                // Inverse of V12 mirror fix: wx = −sinT.
                double wx = -sinT, wy = h, wz = cosT;
                double rx = r00*wx + r01*wy + r02*wz;
                double ry = r10*wx + r11*wy + r12*wz;
                double rz = r20*wx + r21*wy + r22*wz;
                if (rz <= 1e-6) { mx[x] = -1.0f; my[x] = -1.0f; }
                else {
                    double u = fx * rx / rz + cx;
                    double v = fy * ry / rz + cy;
                    if (u < 0 || u >= (double)src.cols || v < 0 || v >= (double)src.rows) {
                        mx[x] = -1.0f; my[x] = -1.0f;
                    } else { mx[x] = (float)u; my[x] = (float)v; }
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
        for (int x = 0; x < bboxW; x++) if (mx[x] >= 0.0f) m[x] = 255;
    }
    return cv::Point(bboxX, bboxY);
}

- (BOOL)convertPixelBuffer:(CVPixelBufferRef)pixelBuffer to:(cv::Mat &)outBGR {
    CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    OSType pf = CVPixelBufferGetPixelFormatType(pixelBuffer);
    size_t w = CVPixelBufferGetWidth(pixelBuffer);
    size_t h = CVPixelBufferGetHeight(pixelBuffer);
    cv::Mat frame;
    BOOL ok = NO;
    if (pf == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        || pf == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
        size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0);
        size_t uvStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1);
        uint8_t *yBase = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0);
        uint8_t *uvBase = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1);
        cv::Mat nv12((int)(h + h / 2), (int)w, CV_8UC1);
        for (size_t y = 0; y < h; y++) {
            memcpy(nv12.ptr<uchar>((int)y),
                   yBase + y * yStride, w);
        }
        for (size_t y = 0; y < h / 2; y++) {
            memcpy(nv12.ptr<uchar>((int)(h + y)),
                   uvBase + y * uvStride, w);
        }
        cv::cvtColor(nv12, frame, cv::COLOR_YUV2BGR_NV12);
        ok = YES;
    } else if (pf == kCVPixelFormatType_32BGRA) {
        size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
        uint8_t *base = (uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);
        cv::Mat bgra((int)h, (int)w, CV_8UC4, base, stride);
        cv::cvtColor(bgra, frame, cv::COLOR_BGRA2BGR);
        ok = YES;
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
    if (!ok) return NO;

    double scale = std::min(
        (double)_composeWidth  / (double)frame.cols,
        (double)_composeHeight / (double)frame.rows
    );
    if (scale > 1.0) scale = 1.0;
    int outW = std::max(1, (int)std::round(frame.cols * scale));
    int outH = std::max(1, (int)std::round(frame.rows * scale));
    if (frame.cols == outW && frame.rows == outH) {
        outBGR = frame;
    } else {
        cv::resize(frame, outBGR, cv::Size(outW, outH), 0, 0, cv::INTER_AREA);
    }
    return YES;
}

- (nullable RLISSnapshot *)snapshotWithJpegQuality:(NSInteger)quality
                                              error:(NSError **)error
{
    _snapshotSeq += 1;
    NSString *tmpDir = NSTemporaryDirectory();
    NSInteger slot = _snapshotSeq % 4;
    NSString *path = [tmpDir stringByAppendingPathComponent:
                       [NSString stringWithFormat:@"rlss-live-%ld.jpg", (long)slot]];
    return [self writeOutToPath:path quality:quality applyExposureComp:NO error:error];
}

- (nullable RLISSnapshot *)finalizeAtPath:(NSString *)outputPath
                              jpegQuality:(NSInteger)quality
                                    error:(NSError **)error
{
    RLISSnapshot *snap = [self writeOutToPath:outputPath
                                       quality:quality
                              applyExposureComp:YES
                                         error:error];
    [self reset];
    return snap;
}

- (nullable RLISSnapshot *)writeOutToPath:(NSString *)outputPath
                                   quality:(NSInteger)quality
                          applyExposureComp:(BOOL)applyExposureComp
                                     error:(NSError **)error
{
    if (_accepted == 0) {
        if (error) {
            *error = [NSError errorWithDomain:RetaiLensIncrementalStitcherErrorDomain
                                         code:1
                                     userInfo:@{NSLocalizedDescriptionKey:
                                       @"No strips painted yet."}];
        }
        return nil;
    }

    cv::Rect bbox = cv::boundingRect(_canvasMask);
    if (bbox.width <= 0 || bbox.height <= 0) {
        bbox = cv::Rect(0, 0, _canvas.cols, _canvas.rows);
    }
    cv::Mat cropped = _canvas(bbox).clone();

    // V12.14.10 — orientation-aware output rotation.
    //
    // The engine's canvas is in sensor-Y-as-pan-axis orientation in
    // both supported modes (1920w × 5000h, dstY grows with pan).
    // For LANDSCAPE+vertical-pan that's the user-natural output:
    // 1920 wide × Y tall → wide horizontal strip when displayed in
    // the portrait-locked app UI (matches what the user saw in
    // their landscape view).
    //
    // For PORTRAIT+horizontal-pan the canvas is the same shape
    // (1920w × Yh) but the user EXPECTS a wide horizontal strip
    // showing their horizontal pan extent.  Rotate 90° CCW so
    // the saved JPEG is Y wide × 1920 tall — wide strip in
    // portrait UI.
    //
    // V13.0a — ROTATE_90_CLOCKWISE (was COUNTERCLOCKWISE in V12.14.10).
    // Ram's V12.14.10 device test showed the saved JPEG appearing
    // upside-down in the portrait UI; CCW was the wrong direction.
    // CW maps the canvas's pan-axis growth direction to the user-
    // perspective rightward direction, which matches the UI's
    // expected wide-horizontal-strip layout.
    cv::Mat out;
    if (_isLandscape) {
        out = cropped;
    } else {
        cv::rotate(cropped, out, cv::ROTATE_90_CLOCKWISE);
    }

    if (applyExposureComp && !out.empty()) {
        cv::Mat lab;
        cv::cvtColor(out, lab, cv::COLOR_BGR2Lab);
        std::vector<cv::Mat> ch(3);
        cv::split(lab, ch);
        cv::Ptr<cv::CLAHE> clahe = cv::createCLAHE(2.0, cv::Size(8, 8));
        clahe->apply(ch[0], ch[0]);
        cv::merge(ch, lab);
        cv::cvtColor(lab, out, cv::COLOR_Lab2BGR);
    }

    int q = (int)std::clamp((long long)quality, 0LL, 100LL);
    std::vector<int> params = {cv::IMWRITE_JPEG_QUALITY, q};
    NSString *cleanPath = [outputPath hasPrefix:@"file://"]
        ? [outputPath substringFromIndex:7] : outputPath;
    if (!cv::imwrite(std::string([cleanPath UTF8String]), out, params)) {
        if (error) {
            *error = [NSError errorWithDomain:RetaiLensIncrementalStitcherErrorDomain
                                         code:2
                                     userInfo:@{NSLocalizedDescriptionKey:
                                       @"imwrite failed"}];
        }
        return nil;
    }

    RLISSnapshot *snap = [[RLISSnapshot alloc] init];
    [snap setValue:cleanPath forKey:@"panoramaPath"];
    [snap setValue:@(out.cols) forKey:@"width"];
    [snap setValue:@(out.rows) forKey:@"height"];
    [snap setValue:@(_accepted) forKey:@"acceptedCount"];
    return snap;
}

@end
