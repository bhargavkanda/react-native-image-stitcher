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

#import <vector>
#import <chrono>

#define NO  ((BOOL)0)
#define YES ((BOOL)1)

#import "OpenCVSlitScanStitcher.h"  // file name kept; class renamed to OpenCVFirstWinsCylindricalStitcher (V11 Gap #23)

@implementation OpenCVFirstWinsCylindricalStitcher {
    NSInteger _composeWidth;
    NSInteger _composeHeight;
    NSInteger _canvasWidth;
    NSInteger _canvasHeight;
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
        // V11 Gap #4: square canvas — see OpenCVIncrementalStitcher.mm.
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 5000;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 5000;
        _frameRotationDegrees = frameRotationDegrees;
        _useRectilinear = useRectilinear;
        _firstFrameDstX = 0;
        _firstFrameDstY = 0;
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
    _canvas = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC3);
    _canvasMask = cv::Mat::zeros((int)_canvasHeight, (int)_canvasWidth, CV_8UC1);
    _firstRotationArkit = cv::Mat();
    _R_panToWorld = cv::Mat();
    _K_compose = cv::Mat();
    _focalCompose = 0;
    _canvasOriginCylX = 0;
    _canvasOriginCylY = 0;
    _hasFirstFrame = false;
    _accepted = 0;
    _snapshotSeq = 0;
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
        NSLog(@"[V12.6-orient] engine=firstwins detected isLandscape=%d "
              @"|R[0,1]|=%.4f |R[1,1]|=%.4f (frameRotationDegrees from JS = %ld)",
              (int)_isLandscape, absR01, absR11, (long)_frameRotationDegrees);

        if (_useRectilinear) {
            // V12.8 Variant B first frame: paste the LONG-SIDE-CLIPPED
            // portion of the raw sensor frame at canvas centre.  Long
            // side = sensor X (always wide for landscape-mounted iPhone
            // sensor, regardless of device orientation).  Pan axis =
            // sensor Y, kept FULL to match user's mental-model drawing
            // (clipping only on the longer side perpendicular to pan).
            //
            // No cylindrical warp.  Canvas pixels are camera-native
            // rectilinear — straight world lines stay straight.
            const double kLongSideFractionRect = 0.85;
            int clipW = std::max(1, (int)(frameBGR.cols * kLongSideFractionRect));
            int clipH = frameBGR.rows;
            int srcClipX = (frameBGR.cols - clipW) / 2;
            int srcClipY = 0;
            cv::Mat frameClipped = frameBGR(cv::Rect(srcClipX, srcClipY, clipW, clipH));

            int dstX = (int)(_canvas.cols - clipW) / 2;
            int dstY = (int)(_canvas.rows - clipH) / 2;
            cv::Rect roi(dstX, dstY, clipW, clipH);
            roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
            cv::Rect srcR(0, 0, roi.width, roi.height);
            frameClipped(srcR).copyTo(_canvas(roi));
            cv::rectangle(_canvasMask, roi, cv::Scalar(255), cv::FILLED);
            _firstFrameDstX = dstX;
            _firstFrameDstY = dstY;
            _hasFirstFrame = true;
            _accepted = 1;
            [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
            [tele setValue:@(1.0) forKey:@"confidence"];
            NSLog(@"[V12.8-rect] first frame clipped+pasted at (%d,%d) size %dx%d (clip=%dx%d) isLandscape=%d focal=%.2f",
                  dstX, dstY, clipW, clipH, srcClipX, srcClipY, (int)_isLandscape, _focalCompose);
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
        const double kLongSideFractionRect = 0.85;
        int clipW = std::max(1, (int)(frameBGR.cols * kLongSideFractionRect));
        int clipH = frameBGR.rows;
        int srcClipX = (frameBGR.cols - clipW) / 2;
        int srcClipY = 0;
        cv::Mat frameClipped = frameBGR(cv::Rect(srcClipX, srcClipY, clipW, clipH));

        int dstX, dstY;
        double alpha;
        if (_isLandscape) {
            // Vertical pan around cam +X axis.  alpha > 0 = look up
            // (verified by R_x convention: +α rotates cam-Z toward cam+Y).
            alpha = std::atan2(R_rel.at<double>(2, 1), R_rel.at<double>(1, 1));
            dstX = _firstFrameDstX;
            // Look up → content shifts UP in canvas (smaller Y).
            dstY = _firstFrameDstY - (int)std::round(alpha * _focalCompose);
        } else {
            // Horizontal pan around cam +Y axis.
            alpha = std::atan2(R_rel.at<double>(0, 2), R_rel.at<double>(0, 0));
            // Look right → content shifts RIGHT in canvas (larger X).
            dstX = _firstFrameDstX + (int)std::round(alpha * _focalCompose);
            dstY = _firstFrameDstY;
        }
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

    // V11 Gap #14: panorama-frame canvas is gravity-aligned by
    // construction.  No output rotation needed.  See v9 engine for
    // the full explanation.
    cv::Mat out = cropped;

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
