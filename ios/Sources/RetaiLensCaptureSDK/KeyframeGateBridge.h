// SPDX-License-Identifier: UNLICENSED
//
// KeyframeGateBridge.h — Obj-C++ wrapper exposing the shared C++
// KeyframeGate (in retailens-capture-sdk/cpp/) to Swift.
//
// Why this exists:
//   The pose-driven keyframe-selection algorithm is the single most
//   important quality-determining piece of the panorama pipeline.
//   Historically it lived in pure Swift (KeyframeGate.swift), which
//   meant the Android side had to either re-implement it (parity
//   risk — confirmed bug in the V16 frame-counter MVP placeholder)
//   or skip it.  We've now ported the algorithm to shared C++ in
//   cpp/keyframe_gate.{hpp,cpp}; this Obj-C++ bridge is the thin
//   shim that lets Swift call into the same C++ code that the JNI
//   side will call on Android.
//
// Threading:
//   The C++ KeyframeGate is NOT thread-safe.  Caller (Swift) must
//   serialise — typically via the engine's workQueue.  Same
//   contract as the Swift-only KeyframeGate had before.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Mirror of `retailens::KeyframeGateDecision` in keyframe_gate.hpp.
/// `reasonCode` is the raw int32 of the C++ enum; `reasonString` is
/// the human-readable label matching the original Swift telemetry
/// strings (so JS telemetry stays bit-identical).
NS_SWIFT_NAME(KeyframeGateBridgeDecision)
@interface KGBDecision : NSObject
@property (nonatomic, readonly) BOOL      accept;
@property (nonatomic, readonly) NSInteger reasonCode;
@property (nonatomic, readonly) NSString *reasonString;
@property (nonatomic, readonly) double    newContentFraction;
@property (nonatomic, readonly) NSInteger acceptedCount;
@property (nonatomic, readonly) NSInteger maxCount;
@end

/// Thin Obj-C++ wrapper around `retailens::KeyframeGate`.  All
/// methods are 1:1 with the C++ API except `evaluate…`, which
/// flattens the Swift call shape (pose struct + optional plane
/// matrix) into primitive C-callable args.
NS_SWIFT_NAME(KeyframeGateBridge)
@interface KeyframeGateBridge : NSObject

- (instancetype)init;

// ── Settings ────────────────────────────────────────────────────
- (void)setEnabled:(BOOL)enabled;
- (void)setOverlapThreshold:(double)threshold;
- (void)setMaxCount:(NSInteger)maxCount;
- (void)markNextFrameAsLast;
- (void)reset;

// ── Read-only state ─────────────────────────────────────────────
- (BOOL)isEnabled;
- (NSInteger)acceptedCount;
- (NSInteger)maxCount;

/// Evaluate one frame.  Pass `plane16` = nil to trigger the C++
/// angular-delta fallback; otherwise pass a 16-element NSArray of
/// NSNumber (NSDoubles or NSFloats) holding the plane transform
/// column-major (matching `simd_float4x4` element order).
- (KGBDecision *)evaluateWithTx:(float)tx
                              ty:(float)ty
                              tz:(float)tz
                              qx:(float)qx
                              qy:(float)qy
                              qz:(float)qz
                              qw:(float)qw
                              fx:(float)fx
                              fy:(float)fy
                              cx:(float)cx
                              cy:(float)cy
                       imageWidth:(int32_t)imageWidth
                      imageHeight:(int32_t)imageHeight
                          plane16:(nullable NSArray<NSNumber *> *)plane16;

@end

NS_ASSUME_NONNULL_END
