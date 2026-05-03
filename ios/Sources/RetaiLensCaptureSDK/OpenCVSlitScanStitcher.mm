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
    double _lastAcceptedTheta;  // panorama angle (radians) of last strip's centre
    double _lastAcceptedH;      // panorama height of last strip's centre
    // Dominant pan direction, locked at second accept.  0 = unknown,
    // 1 = yaw (left-right pan, vertical strips), 2 = pitch (up-down
    // pan, horizontal strips).  Once locked, only frames with motion
    // in this direction generate new strips.
    int _slitScanMode;
}

- (instancetype)initWithComposeWidth:(NSInteger)composeWidth
                       composeHeight:(NSInteger)composeHeight
                         canvasWidth:(NSInteger)canvasWidth
                        canvasHeight:(NSInteger)canvasHeight
                         featherPx:(NSInteger)featherPx
              frameRotationDegrees:(NSInteger)frameRotationDegrees
{
    if (self = [super init]) {
        _composeWidth  = composeWidth  > 0 ? composeWidth  : 960;
        _composeHeight = composeHeight > 0 ? composeHeight : 720;
        // V11 Gap #4: square canvas — see OpenCVIncrementalStitcher.mm.
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 5000;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 5000;
        _frameRotationDegrees = frameRotationDegrees;

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
    _lastAcceptedTheta = 0;
    _lastAcceptedH = 0;
    _slitScanMode = 0;
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

// Slit-scan tuning constants.
namespace {
// Minimum strip width in compose pixels — below this, skip the
// strip (gyro hasn't moved enough to be worth painting).
constexpr int    kMinStripWidthPx = 6;
// Maximum strip width in compose pixels — above this, cap (camera
// jumped too far; capping keeps the strip from trying to cover an
// unreasonable angular span).
constexpr int    kMaxStripWidthPx = 240;
// Number of strips painted before declaring "first frame done".
// Slit-scan emits MANY accepts (every ~50ms in steady pan); keep
// the snapshot cadence sane via the Swift-side every-N counter.
}

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
        double sx = (double)frameBGR.cols / std::max((NSInteger)1, imageWidth);
        double sy = (double)frameBGR.rows / std::max((NSInteger)1, imageHeight);
        double s = 0.5 * (sx + sy);
        _K_compose = (cv::Mat_<double>(3, 3) <<
                      fx * s, 0,      cx * s,
                      0,      fy * s, cy * s,
                      0,      0,      1);
        _focalCompose = fx * s;

        cv::Mat fwdArkitCam = (cv::Mat_<double>(3, 1) << 0, 0, -1);
        cv::Mat fwdWorld = _firstRotationArkit * fwdArkitCam;
        double fwx = fwdWorld.at<double>(0);
        double fwz = fwdWorld.at<double>(2);
        double horiz = std::sqrt(fwx * fwx + fwz * fwz);
        if (horiz < 1e-6) { fwx = 0; fwz = -1; horiz = 1; }
        double pzx = fwx / horiz, pzz = fwz / horiz;
        _R_panToWorld = (cv::Mat_<double>(3, 3) <<
            pzz,  0, pzx,
            0,    1, 0,
            -pzx, 0, pzz);

        // Cylindrical-warp the first frame and place at canvas centre.
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

        _lastAcceptedTheta = 0;
        _lastAcceptedH = 0;
        _hasFirstFrame = true;
        _accepted = 1;
        [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        [tele setValue:@(1.0) forKey:@"confidence"];
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
    _lastAcceptedTheta = 0;  // no longer used in this path
    _lastAcceptedH = 0;

    auto t1 = std::chrono::steady_clock::now();
    double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
    [tele setValue:@(ms) forKey:@"processingMs"];
    return tele;
}

// Hand-rolled cylindrical projection.  Same algorithm as v9's helper
// in OpenCVIncrementalStitcher.mm — duplicated here to keep the two
// engines cleanly separated as separate files.  See that file for the
// full annotation; in short:
//   - panorama frame is gravity-up Y, first-camera-forward Z
//   - R_panToCam = M · R_arkit⁻¹ · R_panToWorld
//   - inverse-map each canvas pixel (theta, h) back to a source pixel
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
        return cv::Point2d(f * theta, -f * h);  // Y-flip: panorama +Y up vs image +Y down
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
    cv::Mat mapX(bboxH, bboxW, CV_32FC1);
    cv::Mat mapY(bboxH, bboxW, CV_32FC1);
    const double r00 = R_panToCam.at<double>(0,0), r01 = R_panToCam.at<double>(0,1), r02 = R_panToCam.at<double>(0,2);
    const double r10 = R_panToCam.at<double>(1,0), r11 = R_panToCam.at<double>(1,1), r12 = R_panToCam.at<double>(1,2);
    const double r20 = R_panToCam.at<double>(2,0), r21 = R_panToCam.at<double>(2,1), r22 = R_panToCam.at<double>(2,2);
    for (int y = 0; y < bboxH; y++) {
        float *mx = mapX.ptr<float>(y);
        float *my = mapY.ptr<float>(y);
        double cylY = (double)(bboxY + y);
        double h = -cylY / f;  // inverse of forward Y-flip
        for (int x = 0; x < bboxW; x++) {
            double cylX = (double)(bboxX + x);
            double theta = cylX / f;
            double sinT = std::sin(theta);
            double cosT = std::cos(theta);
            double wx = sinT, wy = h, wz = cosT;
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

    // V11 Gap #14: cylindrical canvas is gravity-aligned by
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
