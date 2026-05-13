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
#import <CoreVideo/CVPixelBuffer.h>

NS_ASSUME_NONNULL_BEGIN

/// Mirror of `retailens::GateStrategy` (keyframe_gate.hpp).  Bridged as
/// raw NSInteger across Obj-C; the Swift facade lifts it to an enum.
/// MUST stay 1:1 with the C++ enum integer values.
typedef NS_ENUM(NSInteger, KGBStrategy) {
    KGBStrategyPose = 0,   ///< Plane-projection-overlap path (default)
    KGBStrategyFlow = 1,   ///< Sparse-optical-flow novelty (V16 A2)
};

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

// ── Strategy + Flow params (V16 A2) ──────────────────────────────
- (void)setStrategy:(KGBStrategy)strategy;
- (KGBStrategy)strategy;
- (void)setFlowMaxCorners:(NSInteger)maxCorners;
- (void)setFlowQualityLevel:(double)quality;
- (void)setFlowMinDistance:(double)minDistance;

// ── Read-only state ─────────────────────────────────────────────
- (BOOL)isEnabled;
- (NSInteger)acceptedCount;
- (NSInteger)maxCount;

/// Evaluate one frame (pose-only).  Pass `plane16` = nil to trigger
/// the C++ angular-delta fallback; otherwise pass a 16-element NSArray
/// of NSNumber (NSDoubles or NSFloats) holding the plane transform
/// column-major (matching `simd_float4x4` element order).
///
/// Backward-compat entry point — always runs the C++ Pose strategy
/// regardless of `strategy` setting (since Flow needs the frame).
/// New code should call `evaluatePixelBuffer:…` below.
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

/// V16 A2 — strategy-aware evaluate that also accepts the frame's
/// pixel buffer.  Required by Flow strategy (sparse-optical-flow
/// novelty needs the image content).  Pose strategy ignores the
/// pixel buffer here — same result + cost as `evaluateWith…plane16:`.
///
/// Supported pixel formats:
///   * `kCVPixelFormatType_420YpCbCr8BiPlanar{FullRange,VideoRange}`
///     — ARKit's native format.  Y plane is read directly as
///     grayscale (no conversion cost).
///   * `kCVPixelFormatType_32BGRA` — converted to grayscale via
///     `cv::cvtColor` (~2-3 ms at 1920×1440).
/// Other formats → falls through to Pose strategy (defensive).
///
/// The buffer is locked for the duration of the call.  Caller can
/// safely release/recycle the buffer after this method returns.
- (KGBDecision *)evaluatePixelBuffer:(CVPixelBufferRef)pixelBuffer
                                  tx:(float)tx
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
                             plane16:(nullable NSArray<NSNumber *> *)plane16
    NS_SWIFT_NAME(evaluate(pixelBuffer:tx:ty:tz:qx:qy:qz:qw:fx:fy:cx:cy:imageWidth:imageHeight:plane16:));

@end

NS_ASSUME_NONNULL_END
