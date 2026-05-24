// SPDX-License-Identifier: Apache-2.0
//
// KeyframeGateFrameProcessor.mm — F8.1 vision-camera Frame Processor
// Plugin that runs on the camera producer thread (not the JS bridge).
//
// JS-side usage (from a worklet):
//
//     import { VisionCameraProxy, useFrameProcessor } from
//       'react-native-vision-camera';
//
//     const plugin = VisionCameraProxy.initFrameProcessorPlugin(
//       'cv_flow_gate_process_frame',
//       { overlapThreshold: 0.2, maxCount: 32 },  // optional tunables
//     );
//
//     const fp = useFrameProcessor((frame) => {
//       'worklet';
//       if (plugin == null) return;
//       const result = plugin.call(frame, { /* optional pose */ });
//       // result is { accepted, novelty, acceptedCount, reason, ... }
//     }, [plugin]);
//
// F8.1.b SCOPE — calls into `KeyframeGateBridge::evaluatePixelBuffer:`
// (which wraps `cpp/keyframe_gate.cpp`).  The bridge handles pixel-
// format dispatch: YUV biplanar → Y-plane direct, BGRA → cv::cvtColor.
// Configured for Flow strategy + angular-fallback disabled so the
// non-AR producer thread never falls into the gyro-integration path.
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
#import "KeyframeGateBridge.h"

// Helpers for reading typed values out of an NSDictionary with a
// default.  Used to pull pose params from per-call `arguments` and
// tunables from plugin-init `options`.
static float kg_argFloat(NSDictionary* args, NSString* key, float defaultValue) {
  if (args == nil) return defaultValue;
  NSNumber* n = args[key];
  return [n isKindOfClass:[NSNumber class]] ? n.floatValue : defaultValue;
}
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

@implementation KeyframeGateFrameProcessor {
  KeyframeGateBridge* _bridge;
}

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                  withOptions:(NSDictionary* _Nullable)options {
  if (self = [super initWithProxy:proxy withOptions:options]) {
    _bridge = [[KeyframeGateBridge alloc] init];

    // F8.1.b — configure for non-AR Flow strategy.  Flow runs sparse
    // optical flow on the Y plane to measure new content fraction
    // between consecutive accepted keyframes; it does not require an
    // ARKit pose.  Disable the angular-delta fallback so a missing or
    // zero pose can never silently flip to the gyro-integration path.
    [_bridge setStrategy:KGBStrategyFlow];
    [_bridge setEnabled:YES];
    [_bridge setDisableAngularFallback:YES];

    // Allow the JS host to override the gate's tunables once at
    // plugin-init time (via the second arg of
    // VisionCameraProxy.initFrameProcessorPlugin).  Defaults match
    // what F6/F7 used in production AR captures.
    [_bridge setOverlapThreshold:kg_argDouble(options, @"overlapThreshold", 0.2)];
    [_bridge setMaxCount:kg_argInt(options, @"maxCount", 32)];
    [_bridge setFlowMaxCorners:kg_argInt(options, @"flowMaxCorners", 200)];
    [_bridge setFlowQualityLevel:kg_argDouble(options, @"flowQualityLevel", 0.01)];
    [_bridge setFlowMinDistance:kg_argDouble(options, @"flowMinDistance", 10.0)];
    [_bridge setFlowMaxTranslationM:kg_argDouble(options, @"flowMaxTranslationM", 0.0)];
    [_bridge setFlowNoveltyPercentile:kg_argDouble(options, @"flowNoveltyPercentile", 0.85)];
  }
  return self;
}

- (id)callback:(Frame*)frame withArguments:(NSDictionary* _Nullable)arguments {
  CMSampleBufferRef sampleBuffer = frame.buffer;
  if (sampleBuffer == NULL) {
    return @{@"error": @"no sample buffer"};
  }

  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) {
    return @{@"error": @"no pixel buffer"};
  }

  // Frame dims used by both the bridge call below and the response.
  // The bridge re-locks the buffer internally; we don't need to lock
  // here.  We read dims via the plane-aware accessors so this works
  // for YUV biplanar AND single-plane BGRA without branching.
  size_t planeCount = CVPixelBufferGetPlaneCount(pixelBuffer);
  int32_t width  = planeCount >= 1
      ? (int32_t)CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
      : (int32_t)CVPixelBufferGetWidth(pixelBuffer);
  int32_t height = planeCount >= 1
      ? (int32_t)CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
      : (int32_t)CVPixelBufferGetHeight(pixelBuffer);

  // Pose params — Flow strategy ignores these but the bridge call
  // signature is shared with Pose strategy.  Defaults: identity
  // quaternion (qw=1), zero translation, zero intrinsics.  Callers
  // in AR mode (future) can override via `arguments`.
  float tx = kg_argFloat(arguments, @"tx", 0.0f);
  float ty = kg_argFloat(arguments, @"ty", 0.0f);
  float tz = kg_argFloat(arguments, @"tz", 0.0f);
  float qx = kg_argFloat(arguments, @"qx", 0.0f);
  float qy = kg_argFloat(arguments, @"qy", 0.0f);
  float qz = kg_argFloat(arguments, @"qz", 0.0f);
  float qw = kg_argFloat(arguments, @"qw", 1.0f);
  float fx = kg_argFloat(arguments, @"fx", 0.0f);
  float fy = kg_argFloat(arguments, @"fy", 0.0f);
  float cx = kg_argFloat(arguments, @"cx", 0.0f);
  float cy = kg_argFloat(arguments, @"cy", 0.0f);

  KGBDecision* decision = [_bridge evaluatePixelBuffer:pixelBuffer
                                                    tx:tx ty:ty tz:tz
                                                    qx:qx qy:qy qz:qz qw:qw
                                                    fx:fx fy:fy cx:cx cy:cy
                                            imageWidth:width
                                           imageHeight:height
                                               plane16:nil];

  return @{
    @"accepted":          @(decision.accept),
    @"reason":            decision.reasonString ?: @"",
    @"reasonCode":        @(decision.reasonCode),
    @"novelty":           @(decision.newContentFraction),
    @"acceptedCount":     @(decision.acceptedCount),
    @"maxCount":          @(decision.maxCount),
    @"width":             @(width),
    @"height":            @(height),
  };
}

// Auto-register the plugin at class-load time.  The name passed here
// is what JS uses with `VisionCameraProxy.initFrameProcessorPlugin`.
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
