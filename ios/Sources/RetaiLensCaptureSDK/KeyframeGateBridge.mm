// SPDX-License-Identifier: UNLICENSED
//
// KeyframeGateBridge.mm — Obj-C++ glue between Swift and the shared
// C++ KeyframeGate.  See header for design rationale.

#import "KeyframeGateBridge.h"
#import "keyframe_gate.hpp"     // ../../../cpp/keyframe_gate.hpp via header search path
#import "ar_frame_pose.h"

// Single source of truth for the reason-code → string mapping.  These
// strings MUST stay 1:1 with the labels emitted by the original
// KeyframeGate.swift (and read by the JS telemetry layer in
// retailens-capture-sdk/src/stitching/incremental.ts).  Drift will
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

@end
