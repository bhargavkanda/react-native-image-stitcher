// SPDX-License-Identifier: Apache-2.0
//
// ExposureBurstSinkPlugin.mm — v0.22.0 vc Frame Processor plugin
// `rnis_exposure_burst_sink`: forwards each producer-thread frame's
// sample buffer to `ExposureBurstController` (the native side of
// `CameraHandle.captureExposureBurst`).
//
// The lib's stitcher worklet calls this plugin for every frame ONLY
// while the JS side has armed a burst (a module-level shared value in
// `src/camera/exposureBurst.ts`), and the controller itself no-ops
// unless a burst is mid-collection — so the plugin is a pure
// forwarding shim with no state and no arguments.
//
// CONDITIONAL COMPILATION — same `__has_include` guard as
// `KeyframeGateFrameProcessor.mm`: if the consumer's pod install
// didn't pull vision-camera, this file is a no-op translation unit.

#import <Foundation/Foundation.h>

#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)

#import <VisionCamera/Frame.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import <CoreMedia/CoreMedia.h>

// Forward-declare only the Swift API we use (importing the generated
// `RNImageStitcher-Swift.h` would drag React/ARKit into this TU — see
// the rationale in KeyframeGateFrameProcessor.mm).  Must stay in sync
// with `ExposureBurst.swift`'s @objc surface; drift is caught at link
// time (unresolved selector).
@class RNISExposureBurstController;
@interface RNISExposureBurstController : NSObject
+ (RNISExposureBurstController * _Nonnull)shared;
- (void)ingestSampleBuffer:(CMSampleBufferRef _Nonnull)sampleBuffer;
@end

@interface ExposureBurstSinkPlugin : FrameProcessorPlugin
@end

@implementation ExposureBurstSinkPlugin

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                  withOptions:(NSDictionary* _Nullable)options {
  return [super initWithProxy:proxy withOptions:options];
}

- (id)callback:(Frame*)frame withArguments:(NSDictionary* _Nullable)arguments {
  CMSampleBufferRef sampleBuffer = frame.buffer;
  if (sampleBuffer == NULL) {
    return @{@"ok": @NO, @"error": @"frame.buffer was NULL"};
  }
  // Synchronous hand-off; the controller deep-copies what it keeps
  // before returning, so the buffer's pool lifetime is respected.
  [[RNISExposureBurstController shared] ingestSampleBuffer:sampleBuffer];
  return @{@"ok": @YES};
}

+ (void)load {
  [FrameProcessorPluginRegistry
    addFrameProcessorPlugin:@"rnis_exposure_burst_sink"
            withInitializer:^FrameProcessorPlugin* _Nonnull(
                VisionCameraProxyHolder* proxy,
                NSDictionary* _Nullable options) {
              return [[ExposureBurstSinkPlugin alloc]
                  initWithProxy:proxy withOptions:options];
            }];
}

@end

#endif // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
