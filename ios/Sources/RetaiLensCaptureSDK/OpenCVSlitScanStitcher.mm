//
// OpenCVSlitScanStitcher.mm
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

#import "OpenCVSlitScanStitcher.h"

@implementation OpenCVSlitScanStitcher {
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
        _canvasWidth   = canvasWidth   > 0 ? canvasWidth   : 4800;
        _canvasHeight  = canvasHeight  > 0 ? canvasHeight  : 2200;
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

    // First frame: build panorama frame, place a center strip.
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

        // Panorama-to-world (gravity-up Y, first-camera-forward Z).
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

        // First strip: paint the FULL frame as a starting block at
        // canvas centre (the seed for subsequent strip painting).
        _canvasOriginCylX = -_canvas.cols / 2;
        _canvasOriginCylY = -_canvas.rows / 2;
        cv::Rect roi((int)((_canvas.cols - frameBGR.cols) / 2),
                     (int)((_canvas.rows - frameBGR.rows) / 2),
                     frameBGR.cols, frameBGR.rows);
        roi &= cv::Rect(0, 0, _canvas.cols, _canvas.rows);
        if (roi.width > 0 && roi.height > 0) {
            cv::Rect srcR(0, 0, roi.width, roi.height);
            frameBGR(srcR).copyTo(_canvas(roi));
            _canvasMask(roi).setTo(255);
        }
        _lastAcceptedTheta = 0;
        _lastAcceptedH = 0;
        _hasFirstFrame = true;
        _accepted = 1;
        [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
        [tele setValue:@(1.0) forKey:@"confidence"];
        return tele;
    }

    // Compute current frame's center on the cylinder.
    cv::Mat R_panToCam = _M_arkitToCv * R_new.t() * _R_panToWorld;
    cv::Mat camToPan = R_panToCam.t();
    cv::Mat centerRayCam = (cv::Mat_<double>(3, 1) << 0, 0, 1);
    cv::Mat centerRayPan = camToPan * centerRayCam;
    double wx = centerRayPan.at<double>(0);
    double wy = centerRayPan.at<double>(1);
    double wz = centerRayPan.at<double>(2);
    double currentTheta = std::atan2(wx, wz);
    double denom = std::sqrt(wx*wx + wz*wz);
    double currentH = (denom > 1e-9) ? (wy / denom) : 0;

    double dTheta = currentTheta - _lastAcceptedTheta;
    double dH = currentH - _lastAcceptedH;
    int dThetaPx = (int)std::round(_focalCompose * std::fabs(dTheta));
    int dHPx     = (int)std::round(_focalCompose * std::fabs(dH));

    // ── Lock pan direction at second accept ──────────────────────
    if (_slitScanMode == 0) {
        if (dThetaPx < kMinStripWidthPx && dHPx < kMinStripWidthPx) {
            [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
            return tele;
        }
        _slitScanMode = (dThetaPx >= dHPx) ? 1 : 2;
    }

    // ── Mode-specific strip extraction + placement ──────────────
    int stripWidthPx = 0, stripHeightPx = 0;
    cv::Rect stripSrcRect;
    cv::Rect dstRoi;

    if (_slitScanMode == 1) {
        // YAW pan — extract a vertical strip from frame centre,
        // strip width tracks angular delta.
        if (dThetaPx < kMinStripWidthPx) {
            [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
            return tele;
        }
        stripWidthPx  = std::min(dThetaPx, kMaxStripWidthPx);
        stripHeightPx = frameBGR.rows;
        int frameCx   = frameBGR.cols / 2;
        int srcX      = frameCx - stripWidthPx / 2;
        srcX = std::max(0, std::min(srcX, frameBGR.cols - stripWidthPx));
        stripSrcRect = cv::Rect(srcX, 0, stripWidthPx, stripHeightPx);

        int cx = (int)std::round(_focalCompose * currentTheta) - _canvasOriginCylX;
        int cy = (int)std::round(-_focalCompose * currentH)     - _canvasOriginCylY;
        // Y-flip: panorama +Y is gravity-up; image +Y is image-down.
        // Same convention as the v9 hybrid engine.
        dstRoi = cv::Rect(cx - stripWidthPx / 2, cy - stripHeightPx / 2,
                          stripWidthPx, stripHeightPx);
    } else {
        // PITCH pan — extract a horizontal strip from frame centre,
        // strip HEIGHT tracks pitch delta.  The "narrow seam" axis
        // is now horizontal instead of vertical.
        if (dHPx < kMinStripWidthPx) {
            [tele setValue:@(RLISFrameOutcomeSkippedTooClose) forKey:@"outcome"];
            return tele;
        }
        stripHeightPx = std::min(dHPx, kMaxStripWidthPx);
        stripWidthPx  = frameBGR.cols;
        int frameCy   = frameBGR.rows / 2;
        int srcY      = frameCy - stripHeightPx / 2;
        srcY = std::max(0, std::min(srcY, frameBGR.rows - stripHeightPx));
        stripSrcRect = cv::Rect(0, srcY, stripWidthPx, stripHeightPx);

        int cx = (int)std::round(_focalCompose * currentTheta) - _canvasOriginCylX;
        int cy = (int)std::round(-_focalCompose * currentH)     - _canvasOriginCylY;
        dstRoi = cv::Rect(cx - stripWidthPx / 2, cy - stripHeightPx / 2,
                          stripWidthPx, stripHeightPx);
    }

    cv::Mat stripSrc = frameBGR(stripSrcRect);

    cv::Rect canvasBounds(0, 0, _canvas.cols, _canvas.rows);
    cv::Rect dstClipped = dstRoi & canvasBounds;
    if (dstClipped.width <= 0 || dstClipped.height <= 0) {
        [tele setValue:@(RLISFrameOutcomeRejectedAlignmentLost) forKey:@"outcome"];
        return tele;
    }
    cv::Rect srcRoi(dstClipped.x - dstRoi.x, dstClipped.y - dstRoi.y,
                    dstClipped.width, dstClipped.height);

    // Per-strip feather: soften the edges PERPENDICULAR to the seam.
    //   YAW mode (vertical strips, seams on left/right edges)  → feather X.
    //   PITCH mode (horizontal strips, seams on top/bottom)    → feather Y.
    cv::Mat stripMask(dstClipped.height, dstClipped.width, CV_8UC1, cv::Scalar(255));
    if (_slitScanMode == 1) {
        int featherPx = std::min(2, dstClipped.width / 4);
        for (int x = 0; x < featherPx; x++) {
            uchar v = (uchar)((float)x / featherPx * 255.0f);
            for (int y = 0; y < dstClipped.height; y++) {
                stripMask.at<uchar>(y, x) = std::min(stripMask.at<uchar>(y, x), v);
                stripMask.at<uchar>(y, dstClipped.width - 1 - x) =
                    std::min(stripMask.at<uchar>(y, dstClipped.width - 1 - x), v);
            }
        }
    } else {
        int featherPx = std::min(2, dstClipped.height / 4);
        for (int y = 0; y < featherPx; y++) {
            uchar v = (uchar)((float)y / featherPx * 255.0f);
            for (int x = 0; x < dstClipped.width; x++) {
                stripMask.at<uchar>(y, x) = std::min(stripMask.at<uchar>(y, x), v);
                stripMask.at<uchar>(dstClipped.height - 1 - y, x) =
                    std::min(stripMask.at<uchar>(dstClipped.height - 1 - y, x), v);
            }
        }
    }
    cv::Mat canvasRoi = _canvas(dstClipped);
    cv::Mat canvasMaskRoi = _canvasMask(dstClipped);
    cv::Mat stripCropped = stripSrc(srcRoi);

    cv::Mat noPrior;
    cv::compare(canvasMaskRoi, 0, noPrior, cv::CMP_EQ);
    stripCropped.copyTo(canvasRoi, noPrior);

    cv::Mat overlapMask;
    cv::bitwise_and(canvasMaskRoi, stripMask, overlapMask);
    if (cv::countNonZero(overlapMask) > 0) {
        cv::Mat alphaF;
        stripMask.convertTo(alphaF, CV_32F, 1.0 / 255.0);
        cv::Mat alpha3;
        cv::Mat ch[] = {alphaF, alphaF, alphaF};
        cv::merge(ch, 3, alpha3);
        cv::Mat invAlpha3 = cv::Scalar(1, 1, 1) - alpha3;
        cv::Mat sF, cF;
        stripCropped.convertTo(sF, CV_32FC3);
        canvasRoi.convertTo(cF, CV_32FC3);
        cv::Mat blendedF = sF.mul(alpha3) + cF.mul(invAlpha3);
        cv::Mat blended8;
        blendedF.convertTo(blended8, CV_8UC3);
        blended8.copyTo(canvasRoi, overlapMask);
    }
    cv::bitwise_or(canvasMaskRoi, stripMask, canvasMaskRoi);

    _lastAcceptedTheta = currentTheta;
    _lastAcceptedH = currentH;
    _accepted += 1;
    [tele setValue:@(RLISFrameOutcomeAcceptedHigh) forKey:@"outcome"];
    [tele setValue:@(1.0) forKey:@"confidence"];

    auto t1 = std::chrono::steady_clock::now();
    double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
    [tele setValue:@(ms) forKey:@"processingMs"];
    return tele;
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

    // Gravity-derived output rotation (same logic as v9 engine).
    int rotationDeg = 0;
    if (_hasFirstFrame && !_firstRotationArkit.empty()) {
        cv::Mat gravWorld = (cv::Mat_<double>(3, 1) << 0, -1, 0);
        cv::Mat gravArkit = _firstRotationArkit.t() * gravWorld;
        cv::Mat gravCv = _M_arkitToCv * gravArkit;
        double gx = gravCv.at<double>(0);
        double gy = gravCv.at<double>(1);
        double angle = std::atan2(gx, gy) * 180.0 / M_PI;
        rotationDeg = (int)std::round(angle / 90.0) * 90;
        rotationDeg = ((rotationDeg % 360) + 360) % 360;
    }
    cv::Mat out;
    if (rotationDeg == 90) cv::rotate(cropped, out, cv::ROTATE_90_CLOCKWISE);
    else if (rotationDeg == 180) cv::rotate(cropped, out, cv::ROTATE_180);
    else if (rotationDeg == 270) cv::rotate(cropped, out, cv::ROTATE_90_COUNTERCLOCKWISE);
    else out = cropped;

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
