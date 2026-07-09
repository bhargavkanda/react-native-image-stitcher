// SPDX-License-Identifier: Apache-2.0
//
// PreviewFrameGrabber.mm — v0.22.0 preview-frame grab primitive
// (torch-differential probe v3).
//
// Grabs the NEXT vision-camera preview frame on demand and JPEG-encodes
// it to NSTemporaryDirectory(), resolving a JS promise with the file
// path.  Three pieces live in this one translation unit:
//
//   1. RNISPreviewFrameGrabCoordinator — a single-slot atomic handoff
//      between the JS-armed request and the frame that services it.
//   2. RNISPreviewFrameGrabber — the RCT module JS calls:
//      `NativeModules.RNISPreviewFrameGrabber.grab(options)`.  Arms the
//      coordinator and schedules the reject-on-timeout.
//   3. PreviewFrameGrabPlugin — the vc Frame Processor plugin
//      (`grab_preview_frame`).  `<Camera>` attaches a minimal worklet
//      that calls it every frame ONLY while a captureTorchPair() is in
//      flight; an armed request is serviced on the first frame seen.
//
// Why JS-promise + native one-shot arming (vs. worklet args/returns):
// the torch pair needs two frames ~250 ms apart across a torch flip
// with real error/timeout semantics.  Keeping the worklet body down to
// `plugin.call(frame)` means it captures nothing but the plugin handle
// (no shared values, no runOnJS), and the promise is settled natively
// by whoever wins the take-vs-timeout CAS — exactly once.
//
// The encode path (CIImage → CGImage → UIImage → JPEG, atomic write) is
// lifted from the retired v0.9.0 `SaveFrameAsJpegPlugin.mm`
// (archive/ios/…), plus a long-edge downscale so probe files stay small
// (default 1280 px; the pair scorer reads 256×256 grids anyway).
//
// ## Pixel formats
//
// `CIImage imageWithCVPixelBuffer:` handles the 420v/420f biplanar
// formats vision-camera delivers by default AND BGRA (if a host set
// pixelFormat="rgb"), so no format branching is needed here — unlike
// Android, where only YUV_420_888 is accepted.
//
// ## Orientation
//
// Frames are written sensor-oriented (no rotation bake, no EXIF
// orientation).  The torch-pair scorer compares the two frames to EACH
// OTHER, and both frames of a pair share one camera orientation by
// construction — mutual alignment is all that matters.
//
// ## CONDITIONAL COMPILATION
//
// The coordinator + RCT module compile unconditionally (grab() then
// rejects via timeout if vision-camera is absent and no frame can ever
// arrive).  Only the plugin is guarded by the same `__has_include` as
// KeyframeGateFrameProcessor.mm.

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

// ─── 1. Coordinator ─────────────────────────────────────────────────

/// One armed grab.  Immutable after arm; settled exactly once by its
/// owner (the plugin's take, or the timeout's cancelIfCurrent).
@interface RNISPreviewFrameGrabRequest : NSObject
@property (nonatomic) NSInteger maxLongEdge;   // 0 = no downscale
@property (nonatomic) double quality;          // 1-100
@property (nonatomic, copy) NSString *outputPath;
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@property (nonatomic, copy) RCTPromiseRejectBlock reject;
@end

@implementation RNISPreviewFrameGrabRequest
@end


@interface RNISPreviewFrameGrabCoordinator : NSObject
+ (BOOL)arm:(RNISPreviewFrameGrabRequest *)request;
+ (nullable RNISPreviewFrameGrabRequest *)take;
+ (BOOL)cancelIfCurrent:(RNISPreviewFrameGrabRequest *)request;
@end

@implementation RNISPreviewFrameGrabCoordinator

static RNISPreviewFrameGrabRequest *_Nullable gGrabSlot = nil;

/// Arm `request`.  NO when another grab is already armed (the JS layer
/// serialises grabs; this is defensive).
+ (BOOL)arm:(RNISPreviewFrameGrabRequest *)request {
  @synchronized(self) {
    if (gGrabSlot != nil) return NO;
    gGrabSlot = request;
    return YES;
  }
}

/// Remove + return the armed request.  The caller now OWNS settling
/// its promise (the timeout can no longer reach it).
+ (nullable RNISPreviewFrameGrabRequest *)take {
  @synchronized(self) {
    RNISPreviewFrameGrabRequest *taken = gGrabSlot;
    gGrabSlot = nil;
    return taken;
  }
}

/// Timeout path: remove `request` only if it is still the armed one.
/// NO means the plugin already took it (or a newer grab replaced it) —
/// the caller must NOT settle the promise.
+ (BOOL)cancelIfCurrent:(RNISPreviewFrameGrabRequest *)request {
  @synchronized(self) {
    if (gGrabSlot != request) return NO;
    gGrabSlot = nil;
    return YES;
  }
}

@end


// ─── 2. RCT module ──────────────────────────────────────────────────

@interface RNISPreviewFrameGrabber : NSObject <RCTBridgeModule>
@end

@implementation RNISPreviewFrameGrabber

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// Helper: read a numeric option with a fallback (JS numbers arrive as
// NSNumber; anything else falls back).  Same shape as the arg helpers
// in the other vc plugin bridges.
static double rnis_grabOptDouble(NSDictionary *_Nullable options,
                                 NSString *key, double fallback) {
  id v = options[key];
  if ([v isKindOfClass:[NSNumber class]]) return [(NSNumber *)v doubleValue];
  return fallback;
}

RCT_EXPORT_METHOD(grab:(NSDictionary *_Nullable)options
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject) {
  NSInteger maxLongEdge =
      (NSInteger)rnis_grabOptDouble(options, @"maxLongEdge", 1280.0);
  maxLongEdge = MAX((NSInteger)0, MIN(maxLongEdge, (NSInteger)8192));
  double quality = rnis_grabOptDouble(options, @"quality", 80.0);
  quality = MAX(1.0, MIN(quality, 100.0));
  double timeoutMs = rnis_grabOptDouble(options, @"timeoutMs", 2000.0);
  timeoutMs = MAX(100.0, MIN(timeoutMs, 10000.0));

  // De-collide filenames when two grabs land in the same ms.
  static NSInteger gFileSeq = 0;
  NSInteger seq;
  @synchronized([RNISPreviewFrameGrabber class]) {
    seq = ++gFileSeq;
  }
  NSString *filename =
      [NSString stringWithFormat:@"rnis-torchpair-%.0f-%ld.jpg",
                                 [[NSDate date] timeIntervalSince1970] * 1000.0,
                                 (long)seq];
  NSString *outputPath =
      [NSTemporaryDirectory() stringByAppendingPathComponent:filename];

  RNISPreviewFrameGrabRequest *request =
      [[RNISPreviewFrameGrabRequest alloc] init];
  request.maxLongEdge = maxLongEdge;
  request.quality = quality;
  request.outputPath = outputPath;
  request.resolve = resolve;
  request.reject = reject;

  if (![RNISPreviewFrameGrabCoordinator arm:request]) {
    reject(@"E_GRAB_BUSY",
           @"a preview-frame grab is already armed — grabs must be "
           @"serialised by the caller",
           nil);
    return;
  }

  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutMs * NSEC_PER_MSEC)),
      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        if ([RNISPreviewFrameGrabCoordinator cancelIfCurrent:request]) {
          request.reject(
              @"E_GRAB_TIMEOUT",
              [NSString stringWithFormat:
                            @"no preview frame arrived within %.0f ms — is "
                            @"the camera active and the grab frame processor "
                            @"attached (non-AR mode only)?",
                            timeoutMs],
              nil);
        }
      });
}

@end

NS_ASSUME_NONNULL_END


// ─── 3. Frame Processor plugin (vision-camera present only) ────────

#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)

#import <VisionCamera/Frame.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#import <UIKit/UIKit.h>

@interface PreviewFrameGrabPlugin : FrameProcessorPlugin
@end

@implementation PreviewFrameGrabPlugin

- (instancetype)initWithProxy:(VisionCameraProxyHolder *)proxy
                  withOptions:(NSDictionary *_Nullable)options {
  return [super initWithProxy:proxy withOptions:options];
}

// Hot path.  One synchronized read when idle; the two frames a torch
// pair actually encodes each block the frame-processor thread for the
// ~10-60 ms encode (vc drops the intervening frames, preview is
// unaffected).  All CVPixelBuffer access stays synchronous inside the
// callback — the buffer is only valid for its duration.
- (id)callback:(Frame *)frame withArguments:(NSDictionary *)arguments {
  RNISPreviewFrameGrabRequest *request = [RNISPreviewFrameGrabCoordinator take];
  if (request == nil) return nil;

  // From here on the request is OURS: every early return below MUST
  // settle the promise, or JS would hang until its outer timeout.
  CMSampleBufferRef sampleBuffer = frame.buffer;
  if (sampleBuffer == NULL) {
    request.reject(@"E_GRAB_ENCODE_FAILED", @"frame.buffer was NULL", nil);
    return nil;
  }
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) {
    request.reject(@"E_GRAB_ENCODE_FAILED",
                   @"CMSampleBufferGetImageBuffer returned NULL", nil);
    return nil;
  }

  size_t srcWidth = CVPixelBufferGetWidth(pixelBuffer);
  size_t srcHeight = CVPixelBufferGetHeight(pixelBuffer);

  CIImage *ciImage = [CIImage imageWithCVPixelBuffer:pixelBuffer];
  if (ciImage == nil) {
    request.reject(@"E_GRAB_ENCODE_FAILED",
                   @"CIImage imageWithCVPixelBuffer returned nil", nil);
    return nil;
  }

  // Long-edge downscale (probe files stay small; the pair scorer reads
  // 256×256 grids, so 1280 px is already generous).
  double longEdge = (double)MAX(srcWidth, srcHeight);
  if (request.maxLongEdge > 0 && longEdge > (double)request.maxLongEdge) {
    double scale = (double)request.maxLongEdge / longEdge;
    ciImage = [ciImage
        imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
  }

  // Static context — created once, reused for both frames of a pair
  // (and any future pair).  Construction costs ~10 ms, which would
  // otherwise eat into the torch settle window on the first grab.
  static CIContext *gCIContext = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    gCIContext = [CIContext context];
  });

  CGImageRef cgImage =
      [gCIContext createCGImage:ciImage fromRect:CGRectIntegral(ciImage.extent)];
  if (cgImage == NULL) {
    request.reject(@"E_GRAB_ENCODE_FAILED", @"CIContext createCGImage failed",
                   nil);
    return nil;
  }
  UIImage *uiImage = [UIImage imageWithCGImage:cgImage];
  CGImageRelease(cgImage);

  NSData *jpegData =
      UIImageJPEGRepresentation(uiImage, (CGFloat)(request.quality / 100.0));
  if (jpegData == nil) {
    request.reject(@"E_GRAB_ENCODE_FAILED",
                   @"UIImageJPEGRepresentation returned nil", nil);
    return nil;
  }

  NSError *writeError = nil;
  BOOL ok = [jpegData writeToFile:request.outputPath
                          options:NSDataWritingAtomic
                            error:&writeError];
  if (!ok) {
    NSString *msg =
        writeError.localizedDescription ?: @"NSData writeToFile returned NO";
    request.reject(@"E_GRAB_ENCODE_FAILED", msg, writeError);
    return nil;
  }

  // width/height = SOURCE stream dims (pre-downscale), matching the
  // Android plugin + save_frame_as_jpeg's convention.
  request.resolve(@{
    @"path" : request.outputPath,
    @"width" : @(srcWidth),
    @"height" : @(srcHeight),
  });
  return nil;
}

// Auto-register at class-load time — same pattern as
// KeyframeGateFrameProcessor's +load.  Name MUST match Android's
// PreviewFrameGrabPlugin.PLUGIN_NAME and the JS-side
// `initFrameProcessorPlugin('grab_preview_frame')`.
+ (void)load {
  [FrameProcessorPluginRegistry
      addFrameProcessorPlugin:@"grab_preview_frame"
              withInitializer:^FrameProcessorPlugin *_Nonnull(
                  VisionCameraProxyHolder *proxy,
                  NSDictionary *_Nullable options) {
                return [[PreviewFrameGrabPlugin alloc] initWithProxy:proxy
                                                         withOptions:options];
              }];
}

@end

#endif // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
