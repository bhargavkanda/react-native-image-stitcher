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
//  ⚠ THIS ARM HAS NO iOS START PATH YET, SO THE PLUGIN IS DISARMED.
//    READ THIS BEFORE READING ANYTHING ELSE IN THE FILE.
// ══════════════════════════════════════════════════════════════════════
//
// An adversarial review of the first version of this file found that its
// header led with the SECOND reason it is inert and never stated the first.
// The first is this: there is nothing on iOS that arms it.
//
// Android has a fourth start mode — `PanoPlusAndroidRecorder.startVcPluginArm`,
// chosen by `vcPluginArm` in the start bag — in which the recorder opens no
// Camera2 client at all and waits to be fed. iOS has no equivalent:
// `PanoPlusBridge.start` reads `poseSource` and knows two producers, "ar" and
// "imu", and "imu" unconditionally starts `RNISPanoAvfSource`, which opens its
// OWN `AVCaptureSession` on a physical back device. `vcPluginArm` and
// `vcCameraId` are read by no Swift or Objective-C in this package.
//
// ⚠ AND `[RNISPanoCore isRunning]` IS NOT AN OWNERSHIP TEST. It is true on
// EVERY arm — `PanoPlusBridge` starts the core before the AVF source opens
// anything. So a plugin gated only on `isRunning`, running beside a live AVF
// arm, is a SECOND producer interleaving into one engine. In the first version
// of this file the only thing preventing that was the intrinsics refusal
// below, i.e. an accident: satisfy the intrinsics precondition and the
// double-feed begins, silently. Ownership is now an explicit flag
// (`kArmNotification`) that only a real vc-arm start path can set, exactly as
// Android gates on `PanoPlusVcFrameSink.isArmed` rather than on "is a sweep
// running".
//
// Nothing posts that notification today. That is the honest state and it is
// deliberately visible: the plugin refuses with `"not armed"` rather than
// looking like a sensor that went quiet.
//
// ── THE SECOND REASON: THERE IS NO FOCAL LENGTH TO BE HAD ──────────────
//
// Even once armed, the engine needs an fx. There are two sources on iOS and
// a Frame Processor can reach NEITHER:
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
//     This is NOT refused on principle — it is UNREACHABLE. vision-camera's
//     `Frame` and `VisionCameraProxyHolder` carry no device, no connection
//     and no session, so there is no `videoFieldOfView` to read. There is
//     nothing here to derive FROM.
//
// ⚠ AND THE FIRST VERSION OF THIS HEADER GOT THE ARGUMENT WRONG, in a way
// worth correcting rather than quietly deleting. It said a guessed focal
// length "is the one failure the engine's own `fx > 0` guard cannot catch,
// and this codebase has already paid for a confidently-wrong canvas once",
// which reads as a house rule against derivation. It is not one:
// `RNISPanoAvfSource.swift:1261-1272` DERIVES fx from FOV on every frame
// where the matrix is absent, and marks the pack with the delivered/derived
// split (`framesIntrinsicsFovDerived`). Derive-and-mark is the established
// policy in this very subspec.
//
// The AVF arm may do that because it OWNS the device: it opened one, it
// refuses virtual containers BY CONSTRUCTION (:508-517), and it therefore
// knows which physical camera the FOV belongs to. A plugin owns nothing. And
// if vision-camera did hand over a device it would be the wrong kind —
// `<Camera>` mounts a VIRTUAL multi-camera container (Triple / Dual Wide) on
// real iPhones and does 0.5× by `zoom`, so the ACTIVE CONSTITUENT changes
// under zoom with no notification. An fx from the wrong constituent mid-sweep
// is not a refused frame; it is a canvas that keeps painting at the wrong
// scale and reports success.
//
// So the rule is narrower than "never derive", and stating it narrowly
// matters because someone will cite this file later: DERIVE WHERE YOU OWN THE
// DEVICE AND KNOW WHICH ONE IT IS; REFUSE WHERE YOU DO NOT.
//
// WHAT MAKES IT WORK. The arm needs BOTH halves:
//   * an iOS start path that arms this plugin and opens no AVCaptureSession
//     (factor the attitude-configure + CoreMotion half out of
//     `RNISPanoAvfSource.start`, and post `kArmNotification`); AND
//   * intrinsics: vision-camera enabling delivery on its video connection (a
//     one-line change upstream, and vc 5.x already ships it as
//     `enableCameraMatrixDelivery`), or a host enabling it on a session it
//     owns, or `<Camera>` mounting a PHYSICAL device — which would remove the
//     constituent hazard too.
//
// ── WHAT IS AND IS NOT OBSERVABLE ──────────────────────────────────────
//
// An earlier version of this header claimed the inert state "is
// distinguishable in the pack from 'it ran and painted nothing'". That was
// FALSE and is removed. What is true now:
//
//   * ATTITUDE work lands in the pack through the existing channel, because
//     this arm now calls `align` (the COUNTED overload) rather than `probe`.
//     One counted alignment per delivered frame is the documented contract
//     (`RNISPanoAttitude.h:115-129`); `probe` exists for a HOLD LOOP, which
//     this plugin does not have. The old comment justified `probe` by saying
//     it "does not consume the sample" — neither call consumes anything, the
//     ring is written only by `push`, and the real difference is counting.
//   * THIS PLUGIN'S OWN counters are reachable only via `+report`. Nothing
//     calls it yet, because the thing that would — the iOS start path —
//     does not exist. When it lands it must publish `+report` into the pack
//     at teardown, the way `RNISPanoAvfSource` publishes
//     `RNISPanoAttitude.report()` (:1431). Until then, say "unobservable",
//     not "distinguishable".

#import <Foundation/Foundation.h>

#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)

#import <VisionCamera/Frame.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
// `matrix_float3x3` lives here. It resolved before only through
// VisionCamera/FrameProcessor.h → AVFoundation, i.e. through a header this
// file does not name and an upstream package could stop including.
#import <simd/simd.h>

#import <stdatomic.h>

#import "RNISPanoAttitude.h"
#import "RNISPanoCore.h"

/// Posted by a vc-arm start path to arm/disarm this plugin;
/// `userInfo[@"armed"]` is an `NSNumber` BOOL.
///
/// A NOTIFICATION RATHER THAN A CLASS METHOD, deliberately. This whole file
/// is inside `#if __has_include(<VisionCamera/…>)`, so a `+setArmed:`
/// declared in a header would be a symbol that vanishes on builds without
/// vision-camera and takes its caller's link down with it — the exact class
/// of defect `32a4231` was written to fix on Android. A notification name is
/// a string: the poster compiles and runs whether or not this plugin exists.
static NSString *const kArmNotification = @"RNISPanoSweepVcArmDidChange";

/// ⚠ CLASS-LEVEL, NOT PER-INSTANCE, AND THAT IS THE FIX FOR A REAL DEFECT.
/// The registry builds the plugin object ONCE and reuses it, so instance
/// counters accumulate across every sweep for the life of the process and a
/// reader cannot tell one sweep's refusals from the last ten. These reset on
/// each ARM. Atomics because the callback runs on vc's frame-processor queue
/// while arming happens on whatever thread the start path uses.
static atomic_bool  g_armed              = ATOMIC_VAR_INIT(false);
static atomic_ullong g_refusedNotArmed    = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedNoIntrinsics = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedBadMatrix    = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedShortMatrix  = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedFatalAttitude = ATOMIC_VAR_INIT(0);
static atomic_ullong g_ingestedDegraded    = ATOMIC_VAR_INIT(0);
static atomic_ullong g_ingested            = ATOMIC_VAR_INIT(0);

@interface RNISPanoSweepFrameProcessor : FrameProcessorPlugin
@end

@implementation RNISPanoSweepFrameProcessor

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                  withOptions:(NSDictionary* _Nullable)options {
  // Stateless: everything the sweep needs is configured on `RNISPanoCore` /
  // `RNISPanoAttitude` at start() time, and the counters are class-level so
  // they survive the registry reusing this object across sweeps.
  return [super initWithProxy:proxy withOptions:options];
}

/// The counters, for a start path to publish into `meta.json` at teardown.
/// Nothing calls this yet — see the header.
+ (NSDictionary<NSString *, id> *)report {
  return @{
    @"armed":                @(atomic_load(&g_armed)),
    @"refusedNotArmed":      @(atomic_load(&g_refusedNotArmed)),
    @"refusedNoIntrinsics":  @(atomic_load(&g_refusedNoIntrinsics)),
    @"refusedBadMatrix":     @(atomic_load(&g_refusedBadMatrix)),
    @"refusedShortMatrix":   @(atomic_load(&g_refusedShortMatrix)),
    @"refusedFatalAttitude": @(atomic_load(&g_refusedFatalAttitude)),
    @"ingestedDegraded":     @(atomic_load(&g_ingestedDegraded)),
    @"ingested":             @(atomic_load(&g_ingested)),
  };
}

- (id)callback:(Frame*)frame withArguments:(NSDictionary* _Nullable)arguments {
  // ── OWNERSHIP FIRST, AND IT IS NOT `isRunning` ─────────────────────
  // `isRunning` answers "is a sweep in progress", which is true on the AVF
  // and ARKit arms too. Feeding the engine there is a second producer
  // interleaving into one session. Only a vc-arm start path arms this.
  if (!atomic_load(&g_armed)) {
    atomic_fetch_add(&g_refusedNotArmed, 1);
    return @{@"ingested": @NO, @"why": @"not armed — no iOS vc-arm start path"};
  }
  if (![RNISPanoCore isRunning]) {
    return @{@"ingested": @NO, @"why": @"not running"};
  }

  CMSampleBufferRef sampleBuffer = frame.buffer;
  if (sampleBuffer == NULL) return @{@"ingested": @NO, @"why": @"no sample buffer"};
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) return @{@"ingested": @NO, @"why": @"no pixel buffer"};

  // THE PRESENTATION TIMESTAMP IN SECONDS, at full CMTime precision.
  //
  // ⚠ The previous comment here said vc's `Frame.timestamp` is "milliseconds
  // off a different origin". That is wrong: vision-camera 4.7.3's
  // `Frame.m` returns
  // `CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer)) * 1000`
  // — the SAME PTS and the same origin, scaled by 1000. Reading it here
  // would not be a clock error; it would be a 1000× UNIT error against the
  // CoreMotion ring's seconds domain, plus a needless precision loss on the
  // value the bracket search keys on. Reading the PTS directly is right
  // either way, but the file should not carry an argument that is false.
  const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  if (!CMTIME_IS_VALID(pts)) return @{@"ingested": @NO, @"why": @"invalid pts"};
  const double ptsS = CMTimeGetSeconds(pts);

  // ── INTRINSICS, OR REFUSE — AND SAY WHICH FAULT ────────────────────
  // Three distinct faults used to share one message that named
  // vision-camera. Only the first is vision-camera's: the other two mean
  // delivery IS on and the payload is wrong, which sends a reader upstream
  // for nothing.
  double fx = 0.0, fy = 0.0, cx = 0.0, cy = 0.0;
  CFTypeRef matrixRef = CMGetAttachment(
      sampleBuffer, kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, NULL);
  if (matrixRef == NULL) {
    atomic_fetch_add(&g_refusedNoIntrinsics, 1);
    return @{
      @"ingested": @NO,
      @"why": @"no intrinsic-matrix attachment — the session owner has not "
              @"set isCameraIntrinsicMatrixDeliveryEnabled (vision-camera "
              @"4.7.3 never does), and this plugin cannot reach a device to "
              @"derive a focal length from",
      @"refusedNoIntrinsics": @(atomic_load(&g_refusedNoIntrinsics)),
    };
  }
  if (CFGetTypeID(matrixRef) != CFDataGetTypeID()) {
    atomic_fetch_add(&g_refusedBadMatrix, 1);
    return @{
      @"ingested": @NO,
      @"why": @"intrinsic-matrix attachment is present but is not CFData — "
              @"delivery IS enabled and the payload is wrong; this is not a "
              @"vision-camera configuration problem",
      @"refusedBadMatrix": @(atomic_load(&g_refusedBadMatrix)),
    };
  }
  CFDataRef data = (CFDataRef)matrixRef;
  const CFIndex len = CFDataGetLength(data);
  if (len < (CFIndex)sizeof(matrix_float3x3)) {
    atomic_fetch_add(&g_refusedShortMatrix, 1);
    return @{
      @"ingested": @NO,
      @"why": [NSString stringWithFormat:
                  @"intrinsic-matrix attachment is %ld bytes, need %lu — "
                  @"delivery IS enabled and the payload is truncated",
                  (long)len, (unsigned long)sizeof(matrix_float3x3)],
      @"refusedShortMatrix": @(atomic_load(&g_refusedShortMatrix)),
    };
  }
  matrix_float3x3 k;
  CFDataGetBytes(data, CFRangeMake(0, sizeof(matrix_float3x3)), (UInt8 *)&k);
  fx = (double)k.columns[0][0];
  fy = (double)k.columns[1][1];
  cx = (double)k.columns[2][0];
  cy = (double)k.columns[2][1];
  if (!(fx > 0.0) || !(fy > 0.0)) {
    atomic_fetch_add(&g_refusedBadMatrix, 1);
    return @{
      @"ingested": @NO,
      @"why": @"intrinsic matrix decoded but fx/fy are not positive",
      @"refusedBadMatrix": @(atomic_load(&g_refusedBadMatrix)),
    };
  }

  // ── ATTITUDE ───────────────────────────────────────────────────────
  // `align`, not `probe`: `probe` is the PURE overload and exists for a hold
  // loop, which this plugin does not have. The contract is exactly one
  // COUNTED alignment per delivered frame (`RNISPanoAttitude.h:115-129`), and
  // counting is what puts this arm's attitude work in the pack at all.
  //
  // ⚠ `accelMagMps2: NAN`, NOT 0.0. Both contracts say non-finite means "not
  // available" and is recorded as NOT-EVALUATED. `0.0` is FINITE, so the
  // lurch cage evaluates it, compares zero against the threshold, and can
  // never exceed it — the pack would then show a cage that ran and passed on
  // every frame of a sweep where it never ran at all. This arm has no
  // accelerometer of its own; saying so is the whole point of the NaN.
  const RNISPanoAlignResult att = [RNISPanoAttitude alignPtsS:ptsS
                                                 accelMagMps2:NAN];
  if (!att.ok && att.fatal) {
    // A configuration fault cannot improve frame by frame — the same
    // reasoning, and the same policy, as RNISPanoAvfSource.swift:1246-1252.
    atomic_fetch_add(&g_refusedFatalAttitude, 1);
    return @{
      @"ingested": @NO,
      @"why": [NSString stringWithFormat:@"attitude (fatal): %@",
                        [RNISPanoAttitude refusalName:att.refusal]],
      @"refusedFatalAttitude": @(atomic_load(&g_refusedFatalAttitude)),
    };
  }
  // ⚠ NON-FATAL REFUSALS ARE STILL INGESTED, with tracking = notAvailable.
  // The first version of this file returned early on ANY `!att.ok`, which is
  // the OPPOSITE of what the AVF arm feeding the same engine does, and it
  // did so without saying it was choosing a different policy. The AVF arm's
  // reason applies here verbatim: the engine's own hold / abort ladder then
  // runs on a real input and the frame gets a ledger row — silently dropping
  // it would leave the pack unable to say the frame ever existed.
  const BOOL degraded = !att.ok;
  if (degraded) atomic_fetch_add(&g_ingestedDegraded, 1);

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
                         tracking:(degraded ? @"notAvailable"
                                    : (att.tracking == 2 ? @"normal"
                                        : (att.tracking == 1 ? @"limited"
                                            : @"notAvailable")))
                // vision-camera surfaces no per-frame exposure, and the AE
                // lock is the session owner's. Zeros turn the engine's
                // radiometric normalisation OFF rather than feeding it a
                // guess — the same trade the Android vc arm records.
                exposureDurationS:0.0
                      exposureISO:0.0
              arExposureDurationS:0.0
               arExposureOffsetEV:0.0
                   arExposureHave:NO];
  atomic_fetch_add(&g_ingested, 1);
  return @{
    @"ingested": @YES,
    @"degraded": @(degraded),
    @"count": @(atomic_load(&g_ingested)),
  };
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

  // Arming, from whatever start path eventually exists. Registered at image
  // load so it cannot be missed by a poster that runs early.
  [[NSNotificationCenter defaultCenter]
      addObserverForName:kArmNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
    const BOOL armed = [note.userInfo[@"armed"] boolValue];
    if (armed) {
      // RESET ON ARM, not on disarm: a teardown path that wants to publish
      // `+report` must be able to read it AFTER disarming.
      atomic_store(&g_refusedNotArmed, 0);
      atomic_store(&g_refusedNoIntrinsics, 0);
      atomic_store(&g_refusedBadMatrix, 0);
      atomic_store(&g_refusedShortMatrix, 0);
      atomic_store(&g_refusedFatalAttitude, 0);
      atomic_store(&g_ingestedDegraded, 0);
      atomic_store(&g_ingested, 0);
    }
    atomic_store(&g_armed, armed);
  }];
}

@end

#endif  // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
