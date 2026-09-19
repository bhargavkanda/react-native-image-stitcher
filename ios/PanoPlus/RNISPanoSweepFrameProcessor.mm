// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoSweepFrameProcessor — the sweep engine, fed from the camera
// `<Camera>` already owns (S6).
//
// The iOS half of direction A's non-AR arm. pano+ opens its own
// AVCaptureSession in `RNISPanoAvfSource`; this plugin is the path in which
// it does not — vision-camera owns the device, hands the pixels over per
// frame, and `RNISPanoCore` is unchanged behind it.
//
// Shaped exactly like `KeyframeGateFrameProcessor.mm`: `__has_include`
// guard so the file is a no-op translation unit without vision-camera,
// `+load` registration, and a callback that does the smallest possible
// amount of work on vc's frame-processor queue.
//
// ══════════════════════════════════════════════════════════════════════
//  ⚠ THIS PLUGIN REFUSES RATHER THAN GUESSES, AND ON STOCK
//    VISION-CAMERA THAT MEANS IT REFUSES EVERY FRAME.
// ══════════════════════════════════════════════════════════════════════
//
// The engine needs a focal length. There are exactly two sources on iOS and
// a plugin can reach neither today:
//
//  1. THE DELIVERED INTRINSIC MATRIX, attached to the sample buffer as
//     `kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix`. It is attached
//     ONLY when the session owner sets
//     `isCameraIntrinsicMatrixDeliveryEnabled` on the video connection.
//     pano+ does that on its own connection (RNISPanoAvfSource.swift:830).
//     vision-camera 4.7.3 NEVER does — measured: zero occurrences of
//     `IntrinsicMatrix` anywhere in its iOS tree. So the attachment is
//     absent on the session this plugin runs on.
//
//  2. AN FOV DERIVATION off `AVCaptureDevice.activeFormat.videoFieldOfView`.
//     That needs the device, and vision-camera's `Frame` and
//     `VisionCameraProxyHolder` carry no device, no connection and no
//     session. Worse, `<Camera>` mounts a VIRTUAL multi-camera device
//     (Triple / Dual Wide) on real iPhones and does 0.5x by `zoom`, so the
//     ACTIVE CONSTITUENT changes under zoom with no notification —
//     `RNISPanoAvfSource` refuses virtual containers by construction for
//     exactly that reason (:513-517). An fx derived from the wrong
//     constituent mid-sweep is not a refused frame; it is a canvas that
//     keeps painting at the wrong scale and reports success.
//
// So: when the matrix is delivered, ingest. When it is not, REFUSE and say
// which of the two reasons applied. A guessed focal length is the one
// failure the engine's own `fx > 0` guard cannot catch, and this codebase
// has already paid for a confidently-wrong canvas once.
//
// WHAT MAKES IT WORK. Any ONE of:
//   * vision-camera enabling intrinsic-matrix delivery on its video
//     connection — a one-line change upstream, and vc 5.x already ships it
//     as first-class API (`enableCameraMatrixDelivery`);
//   * a host that owns its session enabling it before mounting `<Camera>`;
//   * `<Camera>` mounting a PHYSICAL device rather than a virtual
//     container, which also removes the constituent hazard.
// Until one of those, this arm is present, correct and inert — which is the
// honest state, and is distinguishable in the pack from "it ran and painted
// nothing".

#import <Foundation/Foundation.h>

#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)

#import <VisionCamera/Frame.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>

#import "RNISPanoAttitude.h"
#import "RNISPanoCore.h"

@interface RNISPanoSweepFrameProcessor : FrameProcessorPlugin
@end

@implementation RNISPanoSweepFrameProcessor {
  // Counted rather than logged: a refusal that happens 30 times a second
  // must not write 30 lines a second, and the totals are what a reader
  // needs anyway.
  uint64_t _refusedNoIntrinsics;
  uint64_t _refusedNoAttitude;
  uint64_t _ingested;
}

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                  withOptions:(NSDictionary* _Nullable)options {
  // Stateless beyond the counters: everything the sweep needs is configured
  // on `RNISPanoCore` / `RNISPanoAttitude` at start() time.
  return [super initWithProxy:proxy withOptions:options];
}

- (id)callback:(Frame*)frame withArguments:(NSDictionary* _Nullable)arguments {
  // Cheapest exit first — no sweep is running, which is most of the time.
  if (![RNISPanoCore isRunning]) {
    return @{@"ingested": @NO, @"why": @"not running"};
  }

  CMSampleBufferRef sampleBuffer = frame.buffer;
  if (sampleBuffer == NULL) return @{@"ingested": @NO, @"why": @"no sample buffer"};
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) return @{@"ingested": @NO, @"why": @"no pixel buffer"};

  // ⚠ THE PRESENTATION TIMESTAMP, NOT `frame.timestamp`. The attitude ring
  // is fed from CoreMotion in the CMTime/host-clock domain that the sample
  // buffer's PTS shares; vc's `Frame.timestamp` is milliseconds off a
  // different origin. Joining the wrong clock would bracket every frame
  // against samples from the wrong era and refuse them all — silently, and
  // looking exactly like a dead sensor.
  const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (!CMTIME_IS_VALID(pts)) return @{@"ingested": @NO, @"why": @"invalid pts"};
  const double ptsS = CMTimeGetSeconds(pts);

  // ── INTRINSICS, OR REFUSE ──────────────────────────────────────────
  double fx = 0.0, fy = 0.0, cx = 0.0, cy = 0.0;
  CFTypeRef matrixRef = CMGetAttachment(
      sampleBuffer, kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, NULL);
  if (matrixRef != NULL && CFGetTypeID(matrixRef) == CFDataGetTypeID()) {
    CFDataRef data = (CFDataRef)matrixRef;
    if (CFDataGetLength(data) >= (CFIndex)sizeof(matrix_float3x3)) {
      matrix_float3x3 k;
      CFDataGetBytes(data, CFRangeMake(0, sizeof(matrix_float3x3)), (UInt8 *)&k);
      fx = (double)k.columns[0][0];
      fy = (double)k.columns[1][1];
      cx = (double)k.columns[2][0];
      cy = (double)k.columns[2][1];
    }
  }
  if (!(fx > 0.0) || !(fy > 0.0)) {
    _refusedNoIntrinsics += 1;
    // See the file header: this is the expected state on stock
    // vision-camera, and guessing here is the one error the engine cannot
    // catch.
    return @{
      @"ingested": @NO,
      @"why": @"no intrinsic matrix — vision-camera does not enable "
              @"isCameraIntrinsicMatrixDeliveryEnabled, and a derived focal "
              @"length cannot be trusted on a virtual multi-camera device",
      @"refusedNoIntrinsics": @(_refusedNoIntrinsics),
    };
  }

  // ── ATTITUDE ───────────────────────────────────────────────────────
  // `probe` rather than `align`: probe does not consume the sample, so a
  // frame this plugin then refuses does not advance the ring past a pose a
  // later frame still needs. accelMag 0 — the lurch cage is the aligner's,
  // and this arm has no accelerometer of its own.
  const RNISPanoAlignResult att = [RNISPanoAttitude probePtsS:ptsS accelMagMps2:0.0];
  if (!att.ok) {
    _refusedNoAttitude += 1;
    return @{
      @"ingested": @NO,
      @"why": [NSString stringWithFormat:@"attitude: %@",
                        [RNISPanoAttitude refusalName:att.refusal]],
      @"refusedNoAttitude": @(_refusedNoAttitude),
    };
  }

  const size_t w = CVPixelBufferGetWidth(pixelBuffer);
  const size_t h = CVPixelBufferGetHeight(pixelBuffer);

  [RNISPanoCore ingestPixelBuffer:pixelBuffer
                      timestampNs:ptsS * 1e9
                               fx:fx fy:fy cx:cx cy:cy
                       imageWidth:(NSInteger)w
                      imageHeight:(NSInteger)h
                         rotation:@[@(att.qx), @(att.qy), @(att.qz), @(att.qw)]
                      // No VIO on this arm — zero because there is none to
                      // measure, not because it could not be measured. The
                      // same statement the AVF arm makes.
                      translation:@[@0.0, @0.0, @0.0]
                         tracking:(att.tracking == 2 ? @"normal"
                                    : (att.tracking == 1 ? @"limited" : @"notAvailable"))
                // vision-camera surfaces no per-frame exposure, and the AE
                // lock is the session owner's. Zeros turn the engine's
                // radiometric normalisation OFF rather than feeding it a
                // guess — the same trade the Android vc arm records.
                exposureDurationS:0.0
                      exposureISO:0.0
              arExposureDurationS:0.0
               arExposureOffsetEV:0.0
                   arExposureHave:NO];
  _ingested += 1;
  return @{@"ingested": @YES, @"count": @(_ingested)};
}

+ (void)load {
  [FrameProcessorPluginRegistry
    addFrameProcessorPlugin:@"panoplus_sweep_ingest"
            withInitializer:^FrameProcessorPlugin* _Nonnull(
                VisionCameraProxyHolder* proxy,
                NSDictionary* _Nullable options) {
              return [[RNISPanoSweepFrameProcessor alloc] initWithProxy:proxy
                                                            withOptions:options];
            }];
}

@end

#endif  // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
