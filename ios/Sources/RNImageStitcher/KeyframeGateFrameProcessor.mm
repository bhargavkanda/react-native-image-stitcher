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
//     );
//
//     const fp = useFrameProcessor((frame) => {
//       'worklet';
//       if (plugin == null) return;
//       const result = plugin.call(frame, { yaw: 0.5, pitch: 0.1 });
//       // result is { accepted, novelty, acceptedCount, width, height, ... }
//     }, [plugin]);
//
// F8.1.a SCOPE — JUST the JSI plumbing (no keyframe_gate integration
// yet).  Returns frame dimensions to prove the producer-thread →
// worklet → plugin → result chain works.  F8.1.b will hook in
// `KeyframeGate::evaluateWithFrame`.
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

@interface KeyframeGateFrameProcessor : FrameProcessorPlugin
@end

@implementation KeyframeGateFrameProcessor

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                  withOptions:(NSDictionary* _Nullable)options {
  if (self = [super initWithProxy:proxy withOptions:options]) {
    // No per-instance setup yet.  F8.1.b will allocate the
    // KeyframeGate C++ instance here.
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

  // Lock for read-only access — required before any plane address
  // call.  Must unlock before we return.
  CVReturn lockResult = CVPixelBufferLockBaseAddress(pixelBuffer,
                                                    kCVPixelBufferLock_ReadOnly);
  if (lockResult != kCVReturnSuccess) {
    return @{@"error": @"pixel buffer lock failed",
             @"lockCode": @(lockResult)};
  }

  size_t planeCount = CVPixelBufferGetPlaneCount(pixelBuffer);
  size_t width = 0;
  size_t height = 0;
  size_t stride = 0;

  if (planeCount >= 1) {
    // YUV biplanar: plane 0 is Y (grayscale).  This is the format
    // vision-camera defaults to when frameProcessor is wired and the
    // host hasn't requested pixelFormat=rgb.  Y-plane is exactly what
    // KeyframeGate::evaluateWithFrame wants for optical-flow keyframe
    // gating.
    width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0);
    height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0);
    stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0);
  } else {
    // Non-planar (single-buffer) format, e.g. BGRA.  Whole-buffer
    // dims.  F8.1.b will need a conversion path for this case OR we
    // can constrain to YUV via vision-camera's pixelFormat prop.
    width = CVPixelBufferGetWidth(pixelBuffer);
    height = CVPixelBufferGetHeight(pixelBuffer);
    stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
  }

  CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);

  return @{
    @"width": @((int)width),
    @"height": @((int)height),
    @"stride": @((int)stride),
    @"planeCount": @((int)planeCount),
    @"pixelFormat": frame.pixelFormat ?: @"unknown",
    @"frameTimestamp": @(frame.timestamp),
    // Echo back any options the caller passed so JS can verify
    // arguments threading works.
    @"args": arguments ?: @{},
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
