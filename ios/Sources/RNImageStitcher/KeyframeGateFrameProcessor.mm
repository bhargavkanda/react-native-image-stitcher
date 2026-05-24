// SPDX-License-Identifier: Apache-2.0
//
// KeyframeGateFrameProcessor.mm — F8.3 vision-camera Frame Processor
// plugin: a thin pose-injector that hands every producer-thread frame
// to `IncrementalStitcher.consumeFrameFromPlugin`.
//
// JS-side usage (from a worklet):
//
//     import { VisionCameraProxy, useFrameProcessor } from
//       'react-native-vision-camera';
//
//     const plugin = VisionCameraProxy.initFrameProcessorPlugin(
//       'cv_flow_gate_process_frame', {},
//     );
//
//     const fp = useFrameProcessor((frame) => {
//       'worklet';
//       if (plugin == null) return;
//       plugin.call(frame, {
//         qx, qy, qz, qw,         // gyro-integrated quaternion
//         fx, fy, cx, cy,         // synthesised intrinsics
//         imageWidth, imageHeight,
//         // tx/ty/tz default to 0 (no AR translation in non-AR mode)
//         // trackingStateRaw default = 2 (= .tracking)
//       });
//     }, [plugin]);
//
// F8.3 SCOPE — the plugin owns NO gate state and NO per-frame
// decision logic.  It just:
//   1. Extracts `CVPixelBuffer` from the vision-camera frame.
//   2. Builds a pose from the worklet's `arguments` dict (with
//      defaults safe for non-AR mode).
//   3. Calls `[IncrementalStitcher.shared consumeFrameFromPlugin:…]`
//      which routes into the SAME entry point AR mode uses
//      (`consumeFrame(pixelBuffer:pose:)`).
//
// The KeyframeGate evaluation, work-queue dispatch, deep-copy, and
// engine ingest all happen INSIDE `consumeFrame` — exactly as they
// already do for AR mode.  Single source of truth, no duplication.
//
// CONDITIONAL COMPILATION — this file imports vision-camera headers.
// The SDK's podspec does NOT declare a Pod dependency on VisionCamera
// because we don't want non-camera-using consumers to be forced to
// pull it.  The `__has_include` guard means: if the consumer's pod
// install pulled vision-camera (which it will, since `<Camera>`
// requires it as a peer dep), this plugin compiles in.  Otherwise the
// file is a no-op translation unit.

#import <Foundation/Foundation.h>

#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)

#import <VisionCamera/Frame.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import <CoreVideo/CoreVideo.h>

// Forward-declare only the Swift APIs we use here.  Importing the
// full `RNImageStitcher-Swift.h` would force this TU to also import
// React (`RCTEventEmitter`, `RCTViewManager`) and ARKit
// (`ARSessionDelegate`), because the generated header exposes every
// `@objc` symbol in the module.  We don't need any of those.
//
// Risk: this declaration must stay in sync with the Swift extension
// at the bottom of `IncrementalStitcher.swift`.  Both files are
// committed together; signature drift would be caught at link time
// (unresolved selector) and at the next build.
@class IncrementalStitcher;
@interface IncrementalStitcher : NSObject
+ (IncrementalStitcher * _Nonnull)shared;
- (void)consumeFrameFromPluginWithPixelBuffer:(CVPixelBufferRef _Nonnull)pixelBuffer
                                           tx:(double)tx
                                           ty:(double)ty
                                           tz:(double)tz
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
                                  timestampMs:(double)timestampMs
                             trackingStateRaw:(NSInteger)trackingStateRaw;
@end

// Read a Double from the per-call `arguments` dict with a default.
// Used to extract pose params; tolerant of missing keys (non-AR mode
// may send only the rotation fields, not translation/intrinsics).
static double kg_argDouble(NSDictionary* args, NSString* key, double defaultValue) {
  if (args == nil) return defaultValue;
  NSNumber* n = args[key];
  return [n isKindOfClass:[NSNumber class]] ? n.doubleValue : defaultValue;
}
static NSInteger kg_argInt(NSDictionary* args, NSString* key, NSInteger defaultValue) {
  if (args == nil) return defaultValue;
  NSNumber* n = args[key];
  return [n isKindOfClass:[NSNumber class]] ? n.integerValue : defaultValue;
}

@interface KeyframeGateFrameProcessor : FrameProcessorPlugin
@end

@implementation KeyframeGateFrameProcessor

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                  withOptions:(NSDictionary* _Nullable)options {
  // No per-instance setup.  All gate tunables (overlapThreshold,
  // maxCount, flow params, strategy, ...) live on
  // `IncrementalStitcher` and are configured at its `start()` time
  // from the host-app settings.  The plugin is a stateless
  // pose-injector.
  return [super initWithProxy:proxy withOptions:options];
}

- (id)callback:(Frame*)frame withArguments:(NSDictionary* _Nullable)arguments {
  CMSampleBufferRef sampleBuffer = frame.buffer;
  if (sampleBuffer == NULL) {
    return @{@"submitted": @NO, @"error": @"no sample buffer"};
  }

  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) {
    return @{@"submitted": @NO, @"error": @"no pixel buffer"};
  }

  // Frame dims for the pose.  Read from plane 0 if planar (YUV) else
  // whole buffer; this is the dimensionality the stitcher expects.
  size_t planeCount = CVPixelBufferGetPlaneCount(pixelBuffer);
  NSInteger width  = (NSInteger)(planeCount >= 1
      ? CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
      : CVPixelBufferGetWidth(pixelBuffer));
  NSInteger height = (NSInteger)(planeCount >= 1
      ? CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
      : CVPixelBufferGetHeight(pixelBuffer));

  // Pose from worklet args.  Defaults are safe non-AR values:
  //   * tx/ty/tz = 0 (no translation in non-AR; gyro only gives rot)
  //   * qw = 1 (identity quaternion if JS hasn't supplied rotation)
  //   * fx/fy/cx/cy = 0 → JS-driver caller MUST supply these (the
  //     engine derives FoV from intrinsics; 0 would yield NaN FoV).
  //     We default the principal point to image centre as a safer
  //     fallback if only fx/fy are missing.
  //   * trackingStateRaw = 2 → `.tracking` (non-AR captures don't
  //     have a real tracking-quality signal; engine's `trackingPoor`
  //     path stays inactive, matching legacy `useIncrementalJSDriver`).
  double tx = kg_argDouble(arguments, @"tx", 0.0);
  double ty = kg_argDouble(arguments, @"ty", 0.0);
  double tz = kg_argDouble(arguments, @"tz", 0.0);
  double qx = kg_argDouble(arguments, @"qx", 0.0);
  double qy = kg_argDouble(arguments, @"qy", 0.0);
  double qz = kg_argDouble(arguments, @"qz", 0.0);
  double qw = kg_argDouble(arguments, @"qw", 1.0);
  double fx = kg_argDouble(arguments, @"fx", 0.0);
  double fy = kg_argDouble(arguments, @"fy", 0.0);
  double cx = kg_argDouble(arguments, @"cx", (double)width  / 2.0);
  double cy = kg_argDouble(arguments, @"cy", (double)height / 2.0);
  double timestampMs = kg_argDouble(arguments, @"timestampMs", 0.0);
  NSInteger trackingState = kg_argInt(arguments, @"trackingStateRaw", 2);

  // Submit.  consumeFrame internally early-returns if isRunning ==
  // false, so it's safe to call every producer-thread frame whether
  // or not a capture is in progress.  ~1-2 µs of overhead per
  // "stitcher not running" frame; negligible at 30 fps.
  [IncrementalStitcher.shared
      consumeFrameFromPluginWithPixelBuffer:pixelBuffer
                                         tx:tx ty:ty tz:tz
                                         qx:qx qy:qy qz:qz qw:qw
                                         fx:fx fy:fy cx:cx cy:cy
                                 imageWidth:width
                                imageHeight:height
                                timestampMs:timestampMs
                           trackingStateRaw:trackingState];

  return @{@"submitted": @YES};
}

// Auto-register the plugin at class-load time.  Name must match what
// JS passes to `VisionCameraProxy.initFrameProcessorPlugin(...)`.
+ (void)load {
  [FrameProcessorPluginRegistry
    addFrameProcessorPlugin:@"cv_flow_gate_process_frame"
            withInitializer:^FrameProcessorPlugin* _Nonnull(
                VisionCameraProxyHolder* proxy,
                NSDictionary* _Nullable options) {
              return [[KeyframeGateFrameProcessor alloc]
                  initWithProxy:proxy withOptions:options];
            }];
}

@end

#endif // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
