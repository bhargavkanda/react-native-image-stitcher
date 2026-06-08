// SPDX-License-Identifier: Apache-2.0
//
// KeyframeGateBridge.mm — Obj-C++ glue between Swift and the shared
// C++ KeyframeGate.  See header for design rationale.

#import "KeyframeGateBridge.h"
#import "keyframe_gate.hpp"     // ../../../cpp/keyframe_gate.hpp via header search path
#import "ar_frame_pose.h"

// V16 A2 — OpenCV needed for the BGRA → grayscale conversion fallback
// in the new pixel-buffer evaluate path.  ARKit's native YUV format
// (the dominant case) skips OpenCV entirely — Y plane is read
// directly as the grayscale source.  We only pay the cvtColor cost
// for non-YUV buffers (e.g., vision-camera BGRA capture flows).
#import <opencv2/core.hpp>
#import <opencv2/imgproc.hpp>

// Single source of truth for the reason-code → string mapping.  These
// strings MUST stay 1:1 with the labels emitted by the original
// KeyframeGate.swift (and read by the JS telemetry layer in
// react-native-image-stitcher/src/stitching/incremental.ts).  Drift will
// silently break the JS UI's pill text.
static NSString *kReasonStringFor(retailens::KeyframeGateDecisionReason r) {
    using R = retailens::KeyframeGateDecisionReason;
    switch (r) {
        case R::AcceptDisabled:              return @"gate-disabled";
        case R::AcceptForceLast:             return @"force-last";
        case R::AcceptFirstOnPlane:          return @"first-anchored-on-plane";
        case R::AcceptFirstNoPlane:          return @"first-no-plane";
        case R::AcceptOk:                    return @"ok";
        case R::AcceptOkAngular:             return @"ok-angular";
        case R::AcceptProjectionDegenerate:  return @"projection-degenerate";
        case R::AcceptCurrentAreaZero:       return @"current-area-zero";
        case R::AcceptNoPoseYet:             return @"no-pose-yet";
        case R::RejectMaxReached:            return @"max-reached";
        case R::RejectOverlapTooHigh:        return @"overlap-too-high";
        case R::RejectOverlapTooHighAngular: return @"overlap-too-high (angular)";
        // V16 A2 — flow strategy reason codes
        case R::AcceptOkFlow:                return @"ok-flow";
        case R::AcceptFirstFlow:             return @"first-flow";
        case R::RejectOverlapTooHighFlow:    return @"overlap-too-high (flow)";
        // V16 — translation-budget force-accept
        case R::AcceptFlowTranslation:       return @"ok-flow-translation";
        // Wall-clock keyframe-interval force-accept (Pose + Flow)
        case R::AcceptTimeInterval:          return @"ok-time-interval";
    }
    return @"unknown";
}

// ── KGBDecision impl ─────────────────────────────────────────────

@interface KGBDecision ()
@property (nonatomic, readwrite) BOOL      accept;
@property (nonatomic, readwrite) NSInteger reasonCode;
@property (nonatomic, readwrite) NSString *reasonString;
@property (nonatomic, readwrite) double    newContentFraction;
@property (nonatomic, readwrite) NSInteger acceptedCount;
@property (nonatomic, readwrite) NSInteger maxCount;
@end

@implementation KGBDecision
@end

// ── KeyframeGateBridge impl ──────────────────────────────────────

@implementation KeyframeGateBridge {
    retailens::KeyframeGate _gate;
}

- (instancetype)init {
    self = [super init];
    // No init needed — KeyframeGate's default state is exactly right
    // (enabled=false, threshold=0.4, maxCount=6, acceptedCount=0).
    return self;
}

- (void)setEnabled:(BOOL)enabled {
    _gate.setEnabled(static_cast<bool>(enabled));
}

- (void)setOverlapThreshold:(double)threshold {
    _gate.setOverlapThreshold(threshold);
}

- (void)setMaxCount:(NSInteger)maxCount {
    _gate.setMaxCount(static_cast<int32_t>(maxCount));
}

- (void)markNextFrameAsLast {
    _gate.markNextFrameAsLast();
}

- (void)reset {
    _gate.reset();
}

- (BOOL)isEnabled         { return static_cast<BOOL>(_gate.isEnabled()); }
- (NSInteger)acceptedCount { return static_cast<NSInteger>(_gate.getAcceptedCount()); }
- (NSInteger)maxCount      { return static_cast<NSInteger>(_gate.getMaxCount()); }

// ── V16 A2 — strategy + flow tunables ───────────────────────────

- (void)setStrategy:(KGBStrategy)strategy {
    _gate.setStrategy(static_cast<retailens::GateStrategy>(strategy));
}

- (KGBStrategy)strategy {
    return static_cast<KGBStrategy>(_gate.getStrategy());
}

- (void)setFlowMaxCorners:(NSInteger)maxCorners {
    _gate.setFlowMaxCorners(static_cast<int32_t>(maxCorners));
}

- (void)setFlowQualityLevel:(double)quality {
    _gate.setFlowQualityLevel(quality);
}

- (void)setFlowMinDistance:(double)minDistance {
    _gate.setFlowMinDistance(minDistance);
}

- (void)setFlowMaxTranslationM:(double)metres {
    _gate.setFlowMaxTranslationM(metres);
}

- (void)setMaxKeyframeIntervalMs:(double)ms {
    _gate.setMaxKeyframeIntervalMs(ms);
}

- (void)setFlowNoveltyPercentile:(double)percentile {
    _gate.setFlowNoveltyPercentile(percentile);
}

- (void)setDisableAngularFallback:(BOOL)disabled {
    // 2026-05-22 (audit F1b) — see header doc for rationale.
    _gate.setDisableAngularFallback(disabled ? true : false);
}

- (KGBDecision *)evaluateWithTx:(float)tx ty:(float)ty tz:(float)tz
                              qx:(float)qx qy:(float)qy qz:(float)qz qw:(float)qw
                              fx:(float)fx fy:(float)fy cx:(float)cx cy:(float)cy
                       imageWidth:(int32_t)imageWidth
                      imageHeight:(int32_t)imageHeight
                          plane16:(nullable NSArray<NSNumber *> *)plane16
{
    retailens::Pose pose;
    pose.tx = tx; pose.ty = ty; pose.tz = tz;
    pose.qx = qx; pose.qy = qy; pose.qz = qz; pose.qw = qw;
    pose.fx = fx; pose.fy = fy; pose.cx = cx; pose.cy = cy;
    pose.imageWidth = imageWidth;
    pose.imageHeight = imageHeight;

    retailens::PlaneTransform planeStorage;
    const retailens::PlaneTransform *planePtr = nullptr;
    if (plane16 != nil && plane16.count == 16) {
        for (NSUInteger i = 0; i < 16; ++i) {
            planeStorage.m[i] = static_cast<float>(plane16[i].doubleValue);
        }
        planePtr = &planeStorage;
    }

    retailens::KeyframeGateDecision d = _gate.evaluate(pose, planePtr);

    KGBDecision *out = [[KGBDecision alloc] init];
    out.accept             = static_cast<BOOL>(d.accept);
    out.reasonCode         = static_cast<NSInteger>(d.reason);
    out.reasonString       = kReasonStringFor(d.reason);
    out.newContentFraction = d.newContentFraction;
    out.acceptedCount      = static_cast<NSInteger>(d.acceptedCount);
    out.maxCount           = static_cast<NSInteger>(d.maxCount);
    return out;
}

// V16 A2 — strategy-aware evaluate that also accepts the frame's
// pixel buffer.  See header for format support + cost notes.
//
// Internal flow:
//   1. Build the retailens::Pose + optional plane (same as
//      evaluateWith…plane16:).
//   2. Lock the pixel buffer (read-only — we never write back).
//   3. Get a grayscale view of the frame: Y-plane direct read for
//      YUV 4:2:0, cv::cvtColor for BGRA.  Other formats → fall
//      through to the pose-only path (defensive).
//   4. Hand grayscale data pointer + dims + stride to the C++ gate
//      via evaluateWithFrame(...).
//   5. Unlock the pixel buffer.
//   6. Marshal the decision back to KGBDecision.
//
// The grayscale data MUST stay alive for the duration of the C++
// call: for YUV that's guaranteed by the lock; for BGRA we hold
// the cvtColor result in a stack-local cv::Mat (`bgraToGrayHolder`)
// whose buffer outlives the gate call.
- (KGBDecision *)evaluatePixelBuffer:(CVPixelBufferRef)pixelBuffer
                                  tx:(float)tx ty:(float)ty tz:(float)tz
                                  qx:(float)qx qy:(float)qy qz:(float)qz qw:(float)qw
                                  fx:(float)fx fy:(float)fy cx:(float)cx cy:(float)cy
                          imageWidth:(int32_t)imageWidth
                         imageHeight:(int32_t)imageHeight
                             plane16:(nullable NSArray<NSNumber *> *)plane16
{
    // Fast path: Pose strategy doesn't need the pixel buffer; route
    // straight to the pose-only evaluate so we don't pay the
    // CVPixelBuffer lock/unlock cost (~10 µs but at 60 fps = 600 µs/s
    // wasted) for every Pose-strategy frame.
    if (_gate.getStrategy() == retailens::GateStrategy::Pose) {
        return [self evaluateWithTx:tx ty:ty tz:tz
                                 qx:qx qy:qy qz:qz qw:qw
                                 fx:fx fy:fy cx:cx cy:cy
                          imageWidth:imageWidth
                         imageHeight:imageHeight
                             plane16:plane16];
    }

    retailens::Pose pose;
    pose.tx = tx; pose.ty = ty; pose.tz = tz;
    pose.qx = qx; pose.qy = qy; pose.qz = qz; pose.qw = qw;
    pose.fx = fx; pose.fy = fy; pose.cx = cx; pose.cy = cy;
    pose.imageWidth = imageWidth;
    pose.imageHeight = imageHeight;

    retailens::PlaneTransform planeStorage;
    const retailens::PlaneTransform *planePtr = nullptr;
    if (plane16 != nil && plane16.count == 16) {
        for (NSUInteger i = 0; i < 16; ++i) {
            planeStorage.m[i] = static_cast<float>(plane16[i].doubleValue);
        }
        planePtr = &planeStorage;
    }

    // Lock the buffer for read-only access.  Caller (the engine's AR
    // delegate) might want to use the same buffer for its own
    // processing — the lock is reentrant within the same thread, so
    // this is safe.
    CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);

    const OSType format = CVPixelBufferGetPixelFormatType(pixelBuffer);
    const uint8_t *grayData = nullptr;
    int32_t  grayWidth  = 0;
    int32_t  grayHeight = 0;
    int32_t  grayStride = 0;
    cv::Mat  bgraToGrayHolder;  // owns the converted buffer for BGRA path

    if (format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ||
        format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    {
        // YUV 4:2:0 biplanar — Y plane IS our grayscale.  Zero
        // conversion cost.  ARKit's native format; the dominant
        // production path.
        grayData   = static_cast<const uint8_t *>(
            CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0));
        grayWidth  = static_cast<int32_t>(CVPixelBufferGetWidthOfPlane(pixelBuffer, 0));
        grayHeight = static_cast<int32_t>(CVPixelBufferGetHeightOfPlane(pixelBuffer, 0));
        grayStride = static_cast<int32_t>(CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0));
    } else if (format == kCVPixelFormatType_32BGRA) {
        // BGRA — convert to grayscale via OpenCV.  ~2-3 ms at
        // 1920×1440 on iPhone 13 Pro.
        const int32_t w = static_cast<int32_t>(CVPixelBufferGetWidth(pixelBuffer));
        const int32_t h = static_cast<int32_t>(CVPixelBufferGetHeight(pixelBuffer));
        const int32_t bgraStride = static_cast<int32_t>(CVPixelBufferGetBytesPerRow(pixelBuffer));
        uint8_t *bgraPtr = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(pixelBuffer));
        cv::Mat bgra(h, w, CV_8UC4, bgraPtr, bgraStride);
        cv::cvtColor(bgra, bgraToGrayHolder, cv::COLOR_BGRA2GRAY);
        grayData   = bgraToGrayHolder.data;
        grayWidth  = static_cast<int32_t>(bgraToGrayHolder.cols);
        grayHeight = static_cast<int32_t>(bgraToGrayHolder.rows);
        grayStride = static_cast<int32_t>(bgraToGrayHolder.step);
    } else if (format == kCVPixelFormatType_OneComponent8) {
        // Single-channel grayscale — used by the non-AR
        // batch-keyframe path (v0.3+) which decodes the JPEG snapshot
        // directly to grayscale before evaluating.  Base address IS
        // the Y plane; no conversion cost.
        grayData   = static_cast<const uint8_t *>(
            CVPixelBufferGetBaseAddress(pixelBuffer));
        grayWidth  = static_cast<int32_t>(CVPixelBufferGetWidth(pixelBuffer));
        grayHeight = static_cast<int32_t>(CVPixelBufferGetHeight(pixelBuffer));
        grayStride = static_cast<int32_t>(CVPixelBufferGetBytesPerRow(pixelBuffer));
    }
    // else: grayData stays nullptr.  The C++ gate detects this and
    // falls back to the pose-only path inside evaluateWithFrame —
    // graceful degradation for unsupported pixel formats.

    retailens::KeyframeGateDecision d = _gate.evaluateWithFrame(
        pose, planePtr,
        grayData, grayWidth, grayHeight, grayStride);

    CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);

    KGBDecision *out = [[KGBDecision alloc] init];
    out.accept             = static_cast<BOOL>(d.accept);
    out.reasonCode         = static_cast<NSInteger>(d.reason);
    out.reasonString       = kReasonStringFor(d.reason);
    out.newContentFraction = d.newContentFraction;
    out.acceptedCount      = static_cast<NSInteger>(d.acceptedCount);
    out.maxCount           = static_cast<NSInteger>(d.maxCount);
    return out;
}

@end
