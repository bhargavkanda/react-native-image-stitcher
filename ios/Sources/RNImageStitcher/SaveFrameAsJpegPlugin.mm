// SPDX-License-Identifier: Apache-2.0
//
// SaveFrameAsJpegPlugin.mm — v0.9.0 Layer 1: vc Frame Processor plugin
// that JPEG-encodes the supplied frame's pixel buffer to a host-
// supplied path.  Worklet-callable; thin wrapper around the standard
// iOS CIImage → CGImage → UIImage → UIImageJPEGRepresentation path.
//
// JS-side usage (from a worklet — typically inside `useFrameStream`
// (Layer 3) or directly from a custom `useFrameProcessor` body):
//
//     const plugin = VisionCameraProxy.initFrameProcessorPlugin(
//       'save_frame_as_jpeg', {},
//     );
//
//     const fp = useFrameProcessor((frame) => {
//       'worklet';
//       if (plugin == null) return;
//       const result = plugin.call(frame, {
//         path: '/path/to/output.jpg',
//         quality: 75,  // 0-100; defaults to 75
//       });
//       // result: { ok: true, path, width, height }  OR
//       //         { ok: false, error: "..." }
//     }, [plugin]);
//
// ## Why a separate plugin (not folded into KeyframeGateFrameProcessor)
//
// `cv_flow_gate_process_frame` (the existing plugin) drives the lib's
// FIRST-PARTY stitching pipeline: it consumes the frame, evaluates
// the keyframe gate, dispatches into `IncrementalStitcher`.  It owns
// state.
//
// `save_frame_as_jpeg` is STATELESS — a pure encode-and-write function.
// Mixing them would force every JS-side caller of either to pay both
// codepaths' arg-parsing costs (and would confuse the use-case
// boundary).  Two plugins, one job each.
//
// ## CONDITIONAL COMPILATION
//
// Same `__has_include` guard as `KeyframeGateFrameProcessor.mm` — if
// vision-camera isn't on the host's classpath, this file is a no-op
// translation unit.  See that file's header for the rationale.

#import <Foundation/Foundation.h>

#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)

#import <VisionCamera/Frame.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreImage/CoreImage.h>
#import <UIKit/UIKit.h>

@interface SaveFrameAsJpegPlugin : FrameProcessorPlugin
@end

@implementation SaveFrameAsJpegPlugin

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                   withOptions:(NSDictionary* _Nullable)options {
  return [super initWithProxy:proxy withOptions:options];
}

// Helper: read a string arg with a fallback.  Returns nil only when
// the arg is missing AND no fallback was supplied.
static NSString* sfj_argString(NSDictionary* args, NSString* key,
                                NSString* _Nullable fallback) {
  id v = args[key];
  if ([v isKindOfClass:[NSString class]]) return (NSString*)v;
  return fallback;
}

// Helper: read a numeric arg (NSNumber or NSString-parseable) with a
// fallback.  Matches the pattern in KeyframeGateFrameProcessor.mm.
static double sfj_argDouble(NSDictionary* args, NSString* key,
                             double fallback) {
  id v = args[key];
  if ([v isKindOfClass:[NSNumber class]]) return [(NSNumber*)v doubleValue];
  if ([v isKindOfClass:[NSString class]]) return [(NSString*)v doubleValue];
  return fallback;
}

// The host-callable plugin entry point.  vc dispatches each
// `plugin.call(frame, args)` from a worklet here.
//
// ## Arguments
//
//   - `path` (string, REQUIRED): absolute filesystem path to write
//     the JPEG to.  Parent directory must exist (we don't `mkdir -p`).
//     Existing file is overwritten atomically.
//   - `quality` (number, optional): 0-100 JPEG quality.  Default 75
//     (matches `KeyframeGate.onAccept`'s encoder).  Clamped silently
//     to `[1, 100]`.
//
// ## Returns
//
//   - On success: `{ ok: YES, path: <path>, width: <px>, height: <px> }`
//   - On failure: `{ ok: NO, error: "<reason>" }`
//
// Errors are surfaced via the result dict, NOT thrown as `JSError` —
// host worklets that want to react to encoder failures (e.g., to
// rotate slot paths, or to back off) can branch on `result.ok`
// without try/catch boilerplate.  Throwing would break the
// Layer 3 `useFrameStream` flow which only sees the result.
- (id)callback:(Frame*)frame withArguments:(NSDictionary*)arguments {
  NSString* path = sfj_argString(arguments, @"path", nil);
  if (path == nil) {
    return @{@"ok": @NO, @"error": @"missing required `path` argument"};
  }
  double q = sfj_argDouble(arguments, @"quality", 75.0);
  if (q < 1.0) q = 1.0;
  if (q > 100.0) q = 100.0;

  CMSampleBufferRef sampleBuffer = frame.buffer;
  if (sampleBuffer == NULL) {
    return @{@"ok": @NO, @"error": @"frame.buffer was NULL"};
  }
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) {
    return @{@"ok": @NO, @"error": @"CMSampleBufferGetImageBuffer returned NULL"};
  }

  // CIImage → CGImage → UIImage → JPEG.  Standard iOS path; the
  // CIContext + colorSpace are cheap to construct per-call (CoreImage
  // caches GPU resources internally).  If profiling shows this in
  // the hot path, lift the context to a static; for v0.9.0 baseline,
  // per-call construction is fine.
  CIImage* ciImage = [CIImage imageWithCVPixelBuffer:pixelBuffer];
  if (ciImage == nil) {
    return @{@"ok": @NO, @"error": @"CIImage imageWithCVPixelBuffer returned nil"};
  }
  CIContext* ctx = [CIContext context];
  CGImageRef cgImage = [ctx createCGImage:ciImage fromRect:ciImage.extent];
  if (cgImage == NULL) {
    return @{@"ok": @NO, @"error": @"CIContext createCGImage failed"};
  }
  UIImage* uiImage = [UIImage imageWithCGImage:cgImage];
  size_t width = CGImageGetWidth(cgImage);
  size_t height = CGImageGetHeight(cgImage);
  CGImageRelease(cgImage);

  NSData* jpegData = UIImageJPEGRepresentation(uiImage, (CGFloat)(q / 100.0));
  if (jpegData == nil) {
    return @{@"ok": @NO, @"error": @"UIImageJPEGRepresentation returned nil"};
  }

  // Atomic write — under the hood NSData writes to a temp file then
  // renames.  Avoids torn writes if a reader tries to open the path
  // mid-write (would otherwise see a partial JPEG and choke).
  NSError* err = nil;
  BOOL ok = [jpegData writeToFile:path
                          options:NSDataWritingAtomic
                            error:&err];
  if (!ok) {
    NSString* msg = err.localizedDescription ?: @"NSData writeToFile returned NO";
    return @{@"ok": @NO, @"error": msg};
  }

  return @{
    @"ok": @YES,
    @"path": path,
    @"width": @(width),
    @"height": @(height),
  };
}

// Auto-register the plugin at class-load time.  Name must match what
// JS passes to `VisionCameraProxy.initFrameProcessorPlugin('save_frame_as_jpeg')`.
// Same pattern as KeyframeGateFrameProcessor's +load.
+ (void)load {
  [FrameProcessorPluginRegistry
    addFrameProcessorPlugin:@"save_frame_as_jpeg"
            withInitializer:^FrameProcessorPlugin* _Nonnull(
                VisionCameraProxyHolder* proxy,
                NSDictionary* _Nullable options) {
              return [[SaveFrameAsJpegPlugin alloc]
                  initWithProxy:proxy withOptions:options];
            }];
}

@end

#endif // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
