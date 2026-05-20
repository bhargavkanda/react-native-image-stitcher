// SPDX-License-Identifier: Apache-2.0
//
// OpenCVFirstWinsCylindricalStitcher.h
//
// Apple-style slit-scan panorama engine.  Alternative to
// OpenCVIncrementalStitcher (which is the Samsung-style hybrid
// frame-based approach).  Both engines expose the same JS-facing
// API contract; the host picks one via the `engine` flag in start
// options.
//
// What slit-scan does differently:
//
//   Hybrid (v9): accepts WHOLE frames at intervals, warps each via
//   cylindrical projection, blends with feather over a substantial
//   overlap region (~30-50% of frame width).
//
//   Slit-scan (v10): continuously samples the camera buffer.  For
//   each AR frame, takes a NARROW VERTICAL STRIP (typically 30-60
//   pixels) whose width tracks the gyro angular delta since the
//   last strip.  Strips are painted onto the cylindrical canvas at
//   their exact angular positions, so the per-strip overlap is just
//   1-3 pixels.  The "stitching" problem mostly disappears because
//   the overlap region is too narrow to show parallax.
//
// Why both engines:
//
//   Slit-scan produces near-perfect output for clean rotational
//   pans (Apple Camera-app quality) but is sensitive to gyro drift
//   on long pans and to non-rotational motion (operator translates
//   their body slightly).  Hybrid is more forgiving but has visible
//   seams where alignment is imperfect.  Field captures decide which
//   wins for the actual gesture our reps use.
//

#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#import "OpenCVIncrementalStitcher.h"  // RLISFrameOutcome, RLISFrameTelemetry, RLISSnapshot

NS_ASSUME_NONNULL_BEGIN

@interface OpenCVFirstWinsCylindricalStitcher : NSObject

- (instancetype)initWithComposeWidth:(NSInteger)composeWidth
                       composeHeight:(NSInteger)composeHeight
                         canvasWidth:(NSInteger)canvasWidth
                        canvasHeight:(NSInteger)canvasHeight
                         featherPx:(NSInteger)featherPx
              frameRotationDegrees:(NSInteger)frameRotationDegrees
                     useRectilinear:(BOOL)useRectilinear NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// V15 — set the per-stage correction config.  Should be called once
/// after init, before any `ingestPixelBuffer:` call.  Subsequent calls
/// replace the config but mid-capture changes can produce inconsistent
/// state (prev features tracked under different settings).  Best
/// practice: reset the engine when config changes.  If never called,
/// the engine uses a default equivalent to
/// `+[RLISStitcherConfig configForMode:@"slitscan-both"]`.
- (void)setConfig:(RLISStitcherConfig *)config;

/// V15.0b — set the world-frame plane transform (4×4, column-major,
/// 16 floats).  Should be called once a vertical plane has been
/// detected by ARKit and before any subsequent ingest.  If never
/// called, the engine ignores `_config.useDetectedPlane` and falls
/// back to pose-driven projection.
- (void)setPlaneTransformFlat:(NSArray<NSNumber *> *)transform16;

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
    NS_SWIFT_NAME(ingest(pixelBuffer:qx:qy:qz:qw:tx:ty:tz:fx:fy:cx:cy:imageWidth:imageHeight:yaw:pitch:fovHorizDegrees:fovVertDegrees:trackingPoor:));

- (nullable RLISSnapshot *)snapshotWithJpegQuality:(NSInteger)quality
                                              error:(NSError **)error;

- (nullable RLISSnapshot *)finalizeAtPath:(NSString *)outputPath
                              jpegQuality:(NSInteger)quality
                                    error:(NSError **)error;

- (void)reset;

@property (nonatomic, readonly) NSInteger acceptedCount;

@end

NS_ASSUME_NONNULL_END
