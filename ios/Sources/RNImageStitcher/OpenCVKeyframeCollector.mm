// SPDX-License-Identifier: Apache-2.0

#import "OpenCVKeyframeCollector.h"
#import <ImageIO/ImageIO.h>
#import <CoreServices/CoreServices.h>

// Same #pragma dance the other ObjC++ stitcher files use to suppress
// noisy header warnings before importing opencv2.
#pragma push_macro("NO")
#undef NO
#include <opencv2/opencv.hpp>
#include <opencv2/imgcodecs.hpp>
#pragma pop_macro("NO")

// V16 Phase 1.fix2 — write a JPEG with an EXIF Orientation tag so
// iOS image renderers display the saved frame correctly while
// cv::imread (with IMREAD_IGNORE_ORIENTATION) gets raw landscape
// pixels for the stitcher.  Returns YES on success.
static BOOL WriteJPEGWithEXIF(const cv::Mat &bgr,
                              NSString *path,
                              NSInteger exifOrientation,
                              NSInteger quality) {
  if (bgr.empty()) return NO;

  // Convert BGR (OpenCV native) → RGBA (CoreGraphics expects).
  cv::Mat rgba;
  cv::cvtColor(bgr, rgba, cv::COLOR_BGR2RGBA);

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGBitmapInfo bitmapInfo =
      kCGBitmapByteOrderDefault | kCGImageAlphaNoneSkipLast;
  CGContextRef ctx = CGBitmapContextCreate(
      rgba.data,
      (size_t)rgba.cols,
      (size_t)rgba.rows,
      8,
      (size_t)rgba.step,
      colorSpace,
      bitmapInfo);
  if (!ctx) {
    CGColorSpaceRelease(colorSpace);
    return NO;
  }
  CGImageRef cgImage = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  CGColorSpaceRelease(colorSpace);
  if (!cgImage) return NO;

  NSURL *url = [NSURL fileURLWithPath:path];
  CGImageDestinationRef dst = CGImageDestinationCreateWithURL(
      (__bridge CFURLRef)url,
      // public.jpeg is the stable UTI for JPEG.  Avoiding kUTTypeJPEG
      // (deprecated) and the iOS-15+ UTType class so this compiles
      // against older deployment targets too.
      CFSTR("public.jpeg"),
      1,
      NULL);
  if (!dst) {
    CGImageRelease(cgImage);
    return NO;
  }

  NSInteger q = MAX(0, MIN(100, quality));
  // Clamp EXIF orientation to the valid range (1..8).  Default to
  // 1 (no rotation) for unrecognised values.
  NSInteger exif = (exifOrientation >= 1 && exifOrientation <= 8)
      ? exifOrientation : 1;
  NSDictionary *props = @{
    (id)kCGImageDestinationLossyCompressionQuality: @((double)q / 100.0),
    (id)kCGImagePropertyOrientation: @(exif),
  };
  CGImageDestinationAddImage(
      dst, cgImage, (__bridge CFDictionaryRef)props);
  BOOL ok = CGImageDestinationFinalize(dst);
  CFRelease(dst);
  CGImageRelease(cgImage);
  return ok;
}


// ─────────────────────────────────────────────────────────────────────
// Record
// ─────────────────────────────────────────────────────────────────────

@implementation OpenCVKeyframeRecord
- (instancetype)initWithPath:(NSString *)path
                       index:(NSInteger)index
                       width:(NSInteger)width
                      height:(NSInteger)height {
  if ((self = [super init])) {
    _path = [path copy];
    _index = index;
    _width = width;
    _height = height;
  }
  return self;
}
@end


// ─────────────────────────────────────────────────────────────────────
// Collector
// ─────────────────────────────────────────────────────────────────────

@interface OpenCVKeyframeCollector ()
@property (nonatomic, copy, readwrite) NSString *sessionDir;
@property (nonatomic, assign, readwrite) NSInteger acceptedCount;
@end


@implementation OpenCVKeyframeCollector

- (nullable instancetype)init {
  // Forward to the throwing init with a discarded error.  Used only
  // when Swift's `try Type()` form chooses the no-error path; calls
  // from ObjC should always use `initWithError:` directly.
  return [self initWithError:nil];
}

- (nullable instancetype)initWithError:(NSError **)error {
  if ((self = [super init])) {
    NSURL *appSupport = [[NSFileManager defaultManager]
        URLForDirectory:NSApplicationSupportDirectory
               inDomain:NSUserDomainMask
      appropriateForURL:nil
                 create:YES
                  error:error];
    if (!appSupport) return nil;
    NSString *captureUUID = [[NSUUID UUID] UUIDString];
    NSString *sessionPath =
        [[appSupport.path stringByAppendingPathComponent:@"Captures"]
                          stringByAppendingPathComponent:captureUUID];
    BOOL ok = [[NSFileManager defaultManager]
                createDirectoryAtPath:sessionPath
          withIntermediateDirectories:YES
                           attributes:nil
                                error:error];
    if (!ok) return nil;
    _sessionDir = [sessionPath copy];
    _acceptedCount = 0;
    NSLog(@"[KeyframeCollector] session dir: %@", _sessionDir);
  }
  return self;
}

- (nullable OpenCVKeyframeRecord *)saveKeyframe:(CVPixelBufferRef)pixelBuffer
                                rotationDegrees:(NSInteger)rotationDegrees
                                exifOrientation:(NSInteger)exifOrientation
                                    jpegQuality:(NSInteger)jpegQuality
                                          error:(NSError **)error {
  if (!pixelBuffer) {
    if (error) {
      *error = [NSError errorWithDomain:@"OpenCVKeyframeCollector"
                                   code:1200
                               userInfo:@{
        NSLocalizedDescriptionKey: @"Nil pixelBuffer.",
      }];
    }
    return nil;
  }

  cv::Mat bgr;
  if (![self convertPixelBuffer:pixelBuffer toMat:bgr]) {
    if (error) {
      *error = [NSError errorWithDomain:@"OpenCVKeyframeCollector"
                                   code:1201
                               userInfo:@{
        NSLocalizedDescriptionKey:
          @"Unsupported pixel-buffer format (need NV12 or BGRA).",
      }];
    }
    return nil;
  }

  // Rotate to caller-requested orientation.  The JPEGs are saved in
  // the orientation the stitcher expects (user-pan orientation), so
  // OpenCVStitcher.stitchKeyframePaths can read them with no further
  // rotation work.
  cv::Mat rotated;
  if (rotationDegrees == 90) {
    cv::rotate(bgr, rotated, cv::ROTATE_90_CLOCKWISE);
    bgr.release();
  } else if (rotationDegrees == 180) {
    cv::rotate(bgr, rotated, cv::ROTATE_180);
    bgr.release();
  } else if (rotationDegrees == 270) {
    cv::rotate(bgr, rotated, cv::ROTATE_90_COUNTERCLOCKWISE);
    bgr.release();
  } else {
    rotated = bgr;
  }

  NSInteger idx = self.acceptedCount;
  NSString *filename =
      [NSString stringWithFormat:@"keyframe-%03ld.jpg", (long)idx];
  NSString *fullPath =
      [self.sessionDir stringByAppendingPathComponent:filename];

  // V16 Phase 1.fix2 — write JPEG via ImageIO so we can set the
  // EXIF Orientation tag.  cv::imwrite doesn't support EXIF; iOS
  // image renderers (RN's <Image>, Files.app) need the tag to display
  // the saved landscape-sensor JPEG correctly when the user is
  // holding the phone in portrait (which puts the sensor's natural
  // long axis vertical to user — making un-tagged thumbnails appear
  // sideways).
  BOOL wrote = WriteJPEGWithEXIF(rotated, fullPath, exifOrientation,
                                  jpegQuality);
  if (!wrote) {
    if (error) {
      *error = [NSError errorWithDomain:@"OpenCVKeyframeCollector"
                                   code:1202
                               userInfo:@{
        NSLocalizedDescriptionKey:
          [NSString stringWithFormat:
            @"WriteJPEGWithEXIF failed for %@ (orient=%ld q=%ld)",
            fullPath, (long)exifOrientation, (long)jpegQuality],
      }];
    }
    return nil;
  }

  self.acceptedCount = idx + 1;
  NSInteger w = rotated.cols, h = rotated.rows;
  rotated.release();
  return [[OpenCVKeyframeRecord alloc] initWithPath:fullPath
                                              index:idx
                                              width:w
                                             height:h];
}

- (void)cleanup {
  if (self.sessionDir.length == 0) return;
  [[NSFileManager defaultManager] removeItemAtPath:self.sessionDir
                                             error:nil];
}

// ── CVPixelBuffer → cv::Mat (BGR) ──────────────────────────────────
//
// Mirrors `OpenCVIncrementalStitcher.convertPixelBuffer:toMat:` but
// kept inline here so this file is self-contained.  Supports the two
// pixel formats ARFrame.capturedImage uses on iOS (NV12 by default;
// BGRA when the AR session is configured for it).  Lock-once, copy
// out, unlock — buffer lifetime ends with the caller's accept frame.
- (BOOL)convertPixelBuffer:(CVPixelBufferRef)pixelBuffer
                     toMat:(cv::Mat &)outBGR {
  OSType pf = CVPixelBufferGetPixelFormatType(pixelBuffer);
  CVReturn lockResult =
      CVPixelBufferLockBaseAddress(pixelBuffer,
                                   kCVPixelBufferLock_ReadOnly);
  if (lockResult != kCVReturnSuccess) return NO;

  BOOL ok = NO;
  @try {
    if (pf == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ||
        pf == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
      // NV12 — Y plane (full res) + interleaved CbCr (half res).
      size_t w = CVPixelBufferGetWidth(pixelBuffer);
      size_t h = CVPixelBufferGetHeight(pixelBuffer);
      size_t yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0);
      size_t cStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1);
      uint8_t *yPlane =
          (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0);
      uint8_t *cPlane =
          (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1);

      cv::Mat nv12((int)(h * 3 / 2), (int)w, CV_8UC1);
      // Copy Y plane row-by-row (strides may differ from width).
      for (size_t r = 0; r < h; r++) {
        memcpy(nv12.ptr((int)r), yPlane + r * yStride, w);
      }
      // Copy CbCr (interleaved) — height is h/2.
      for (size_t r = 0; r < h / 2; r++) {
        memcpy(nv12.ptr((int)(h + r)), cPlane + r * cStride, w);
      }
      cv::cvtColor(nv12, outBGR, cv::COLOR_YUV2BGR_NV12);
      ok = YES;
    } else if (pf == kCVPixelFormatType_32BGRA) {
      size_t w = CVPixelBufferGetWidth(pixelBuffer);
      size_t h = CVPixelBufferGetHeight(pixelBuffer);
      size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
      uint8_t *base = (uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);
      // Wrap (no copy), then convert into outBGR (which IS owned).
      cv::Mat bgra((int)h, (int)w, CV_8UC4, base, stride);
      cv::cvtColor(bgra, outBGR, cv::COLOR_BGRA2BGR);
      ok = YES;
    }
  } @catch (NSException *e) {
    NSLog(@"[KeyframeCollector] convertPixelBuffer exception: %@", e);
    ok = NO;
  }
  CVPixelBufferUnlockBaseAddress(pixelBuffer,
                                 kCVPixelBufferLock_ReadOnly);
  return ok;
}

@end
