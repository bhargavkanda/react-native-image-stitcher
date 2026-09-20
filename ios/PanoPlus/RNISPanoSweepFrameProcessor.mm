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
//    ONE REASON REMAINS, AND IT IS NOT THE ONE THIS FILE USED TO GIVE.
// ══════════════════════════════════════════════════════════════════════
//
// INTRINSICS ARE NO LONGER THE BLOCKER — see below; this arm derives them.
// What is still missing is a start mode: `PanoPlusBridge` must configure
// `RNISPanoAttitude`, start CoreMotion via the existing `startMotion()` seam
// (RNISPanoAvfSource.swift:1154) and open NO `AVCaptureSession`.
//
// ⚠ AND THAT NEEDS ONE DESIGN ANSWER THIS CODE CANNOT SUPPLY. τ is stored
// under `model | lens | W×H | fps` (RNISPanoCalibStore.swift:19, :78) — the
// rolling-shutter constant is part of the FORMAT. On this arm
// VISION-CAMERA picks the format, so which stored τ applies, and whether a
// τ measured under our own 60 fps 4:3 plan may be reused under vc's, is a
// decision about measurement validity rather than a refactor. Guessing it
// would reintroduce exactly the class of error the old intrinsics reasoning
// was: a number that looks right and is silently for something else.
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
//     ⚠ THIS IS REACHABLE, AND AN EARLIER VERSION OF THIS HEADER SAID IT WAS
//     NOT. It argued that vc's `Frame` carries no device, so there was
//     "nothing here to derive FROM". True about `Frame`, and irrelevant: we
//     do not need vision-camera to hand us the device. JS already sends the
//     id it mounted (`vcCameraId` — on iOS that IS the
//     `AVCaptureDevice.uniqueID`), and `+[AVCaptureDevice deviceWithUniqueID:]`
//     resolves it. That is exactly how the ANDROID arm gets its intrinsics
//     (`CameraCharacteristics` for `vcCameraId`), and the arithmetic is the
//     one `RNISPanoAvfSource` already runs on its own device (:729-735),
//     marking the pack with `fovDerivedFx`.
//
//     So this arm now DERIVES AND MARKS when no matrix is delivered, which
//     is the established policy in this subspec rather than a new one. The
//     old reasoning failed by asking only what vc hands the plugin and never
//     asking whether the plugin could get it another way.
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
// So the rule is: DERIVE WHERE YOU KNOW WHICH DEVICE IT IS; REFUSE WHERE YOU
// DO NOT. This arm CAN know — JS is meant to tell it, over
// `kCameraIdNotification`.
//
// ⚠ AND NOTHING POSTS THAT NOTIFICATION YET, WHICH AN EARLIER VERSION OF
// THIS HEADER FAILED TO SAY. `RNISPanoSweepVcCameraIdDidChange` has exactly
// ONE occurrence in either repository — its own declaration below. So the
// derivation this file gained is REACHABLE CODE THAT CANNOT RUN: `cameraId`
// is empty on every frame, `RNISSweepFovFxForCamera()` is never consulted,
// and a sweep on this arm would refuse 100% of frames with
// `intrinsicsFovDerived: 0`. The commit that added it said the start mode
// was "precisely" what still blocked the iOS arm; that was one blocker
// short, and the word `precisely` is what would stop the next reader
// looking for the second.
//
// The genuine hazard is narrower than
// the old header claimed: a VIRTUAL multi-camera container switches its
// active constituent under zoom unannounced, so an fx read from the
// container is wrong at 0.5×. That is a question about WHICH DEVICE IS
// MOUNTED, not about a frame, and it is guarded where it belongs —
// `sweepHostOwnsCamera` refuses the arm on a multicam body away from 1×.
//
// WHAT MAKES IT WORK. The arm needs ALL THREE, and the third is the one
// this header used to omit:
//   * an iOS start path that arms this plugin and opens no AVCaptureSession
//     (factor the attitude-configure + CoreMotion half out of
//     `RNISPanoAvfSource.start`, and post `kArmNotification`); AND
//   * intrinsics: vision-camera enabling delivery on its video connection (a
//     one-line change upstream, and vc 5.x already ships it as
//     `enableCameraMatrixDelivery`), or a host enabling it on a session it
//     owns, or `<Camera>` mounting a PHYSICAL device — which would remove the
//     constituent hazard too; AND
//   * ⚠ A PUBLISHER FOR `kCameraIdNotification`, carrying `cameraId` and a
//     `frameWidth` that matches the delivered buffer. Without it the FOV
//     fallback above is dead code and the second bullet becomes mandatory
//     rather than an alternative. The natural site is wherever `vcCameraId`
//     and `vcPluginArm` are handed to native — JS already sends both
//     (`Camera.tsx` passes `vcCameraId` into the surface, and the surface
//     puts it in `start`'s options bag), so this is a wire, not a design.
//     It is deliberately NOT added here: a poster no device has ever fired
//     is a sixth inert knob, and this subspec's rule is that a flag is wired
//     only when an OUTCOME proves it. The counters that would prove it
//     (`intrinsicsDelivered` / `intrinsicsFovDerived`) already exist.
//
// ── WHAT IS AND IS NOT OBSERVABLE ──────────────────────────────────────
//
// An earlier version of this header claimed the inert state "is
// distinguishable in the pack from 'it ran and painted nothing'". That was
// FALSE and is removed. What is true now:
//
//   * ATTITUDE work is now COUNTED, because this arm calls `align` (the
//     counted overload) rather than `probe`.
//     One counted alignment per delivered frame is the documented contract
//     (`RNISPanoAttitude.h:115-129`); `probe` exists for a HOLD LOOP, which
//     this plugin does not have. The old comment justified `probe` by saying
//     it "does not consume the sample" — neither call consumes anything, the
//     ring is written only by `push`, and the real difference is counting.
//
//     ⚠ AND ON STOCK VISION-CAMERA THEY ARE WRITTEN ON **NO** FRAME, which
//     an earlier version of this bullet got wrong twice over — it first
//     claimed they reach the pack, then that they are "written every frame
//     and read by nobody". Both are false. `align` sits BELOW the intrinsics
//     gate, and that gate returns on every frame here (vc 4.7.3 attaches no
//     matrix), which is below the arm gate nothing sets. So the honest
//     statement is: this arm currently produces no attitude rows at all, and
//     `RNISPanoAttitude.report()` has exactly ONE caller in the package —
//     inside `RNISPanoAvfSource`'s teardown — which this arm exists to keep
//     from running. Counted becomes true when the arm is armed AND
//     intrinsics arrive; PUBLISHED needs the start path below.
//   * THIS PLUGIN'S OWN counters are reachable only via `+report`. Nothing
//     calls it yet, because the thing that would — the iOS start path —
//     does not exist. When it lands it must publish BOTH `+report` AND
//     `RNISPanoAttitude.report()` at teardown, the way `RNISPanoAvfSource`
//     publishes the latter (:1431) — shipping only the first leaves the pack
//     with no `alignment` block at all. Until then, say "unobservable", not
//     "distinguishable".

#import <Foundation/Foundation.h>

#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)

#import <VisionCamera/Frame.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import <VisionCamera/VisionCameraProxyHolder.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
// `matrix_float3x3` lives here. It resolved before only through
// VisionCamera/FrameProcessor.h → AVFoundation, i.e. through a header this
// file does not name and an upstream package could stop including.
#import <simd/simd.h>

#import <math.h>
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

/// Posted with `userInfo[@"cameraId"]` — the `AVCaptureDevice.uniqueID` of
/// the device vision-camera mounted, which JS already sends as `vcCameraId`.
static NSString *const kCameraIdNotification = @"RNISPanoSweepVcCameraIdDidChange";

/// ⚠ CLASS-LEVEL, NOT PER-INSTANCE — and the reason is NOT the one an earlier
/// version of this comment gave.
///
/// It said "the registry builds the plugin object ONCE and reuses it". It does
/// not: `FrameProcessorPluginRegistry.getPlugin` calls `initializer(proxy,
/// options)` on every lookup with no cache (vc 4.7.3,
/// FrameProcessorPluginRegistry.m:46), and vc's own header documents the
/// initializer as called every time the plugin is loaded. A FRESH object comes
/// back from every `initFrameProcessorPlugin`.
///
/// Which makes per-instance counters worse, not better, for two reasons a
/// reader needs to keep straight:
///
///   * they would be silently zeroed whenever `useSweepWorklet` re-acquires —
///     a remount, a fast refresh — so a sweep's totals could be split across
///     two objects with nothing saying so; and
///   * a start path publishing `+report` holds no reference to the instance,
///     so per-instance numbers are unreachable from the only place that would
///     write them into the pack.
///
/// The real lifetime is one layer up: the JS hook calls
/// `initFrameProcessorPlugin` ONCE per `<Camera>` mount and holds the handle,
/// so one instance spans every sweep on one camera screen. That is precisely
/// long enough to mix two sweeps' numbers, which is why these reset on ARM
/// rather than on construction. (The Android plugin's size latch has the same
/// lifetime and the same fix — a generation counter off `PanoPlusVcFrameSink`.)
///
/// Atomics because the callback runs on vc's frame-processor queue while
/// arming happens on whatever thread the start path uses.
static atomic_bool  g_armed              = ATOMIC_VAR_INIT(false);
/// Every frame vision-camera OFFERED — counted before the arm gate, so it is
/// a true denominator. Without it the buckets below cannot be checked
/// against anything, and "vision-camera delivered nothing" reads identically
/// to "vision-camera delivered N and the core refused all of them", which is
/// the single most common question to ask of this arm.
static atomic_ullong g_seen               = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedNotArmed    = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedNotRunning  = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedNoPixelBuf  = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedFrameInvalid = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedBadPts      = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedNoIntrinsics = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedBadMatrix    = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedShortMatrix  = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedFatalAttitude = ATOMIC_VAR_INIT(0);
static atomic_ullong g_ingestedDegraded    = ATOMIC_VAR_INIT(0);
static atomic_ullong g_ingested            = ATOMIC_VAR_INIT(0);
static atomic_ullong g_fovDerived          = ATOMIC_VAR_INIT(0);
static atomic_ullong g_intrinsicsDelivered = ATOMIC_VAR_INIT(0);

/// The FOV-derived focal length for the device vision-camera mounted, and
/// the id it was derived from. Guarded by `g_fovLock` — written on the arm
/// notification, read on the frame-processor queue.
static NSLock *g_fovLock = nil;
static double  g_fovFx = 0.0;
static NSString *g_fovCameraId = nil;

/// Derive fx from a device's published horizontal field of view.
///
/// ⚠ THIS IS THE ROUTE AN EARLIER VERSION OF THIS FILE SAID DID NOT EXIST.
/// Its header argued that a Frame Processor "can reach neither" intrinsics
/// source, because vision-camera's `Frame` carries no `AVCaptureDevice`.
/// True, and irrelevant: we do not need vc to hand us the device. JS already
/// sends the id it mounted (`vcCameraId` — on iOS that IS the
/// `AVCaptureDevice.uniqueID`), and `AVCaptureDevice` can be looked up by it.
/// That is the same route the Android arm has always used with
/// `CameraCharacteristics`, and the same arithmetic `RNISPanoAvfSource`
/// already performs on its own device (:729-735), marking the pack with
/// `fovDerivedFx`. Derive-and-mark is the established policy in this subspec;
/// the old header contradicted it.
static double RNISSweepFovFxForCamera(NSString *cameraId, size_t frameWidth) {
  if (cameraId.length == 0 || frameWidth == 0) return 0.0;
  AVCaptureDevice *dev = [AVCaptureDevice deviceWithUniqueID:cameraId];
  if (dev == nil) return 0.0;
  const double hFovDeg = (double)dev.activeFormat.videoFieldOfView;
  if (!(hFovDeg > 0.0)) return 0.0;
  return (0.5 * (double)frameWidth) / tan(0.5 * hFovDeg * M_PI / 180.0);
}

@interface RNISPanoSweepFrameProcessor : FrameProcessorPlugin
@end

@implementation RNISPanoSweepFrameProcessor

- (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
                  withOptions:(NSDictionary* _Nullable)options {
  // Stateless: everything the sweep needs is configured on `RNISPanoCore` /
  // `RNISPanoAttitude` at start() time. WHY the counters are class-level is
  // at their declaration — and it is NOT "the registry reuses this object",
  // which this file disproves forty lines up and used to repeat here in the
  // same breath.
  return [super initWithProxy:proxy withOptions:options];
}

/// The counters, for a start path to publish into `meta.json` at teardown.
/// Nothing calls this yet — see the header.
+ (NSDictionary<NSString *, id> *)report {
  return @{
    @"armed":                @(atomic_load(&g_armed)),
    // ⚠ `seen` IS THE DENOMINATOR. `ingested` plus every `refused*` below
    // must equal it; a gap means a return path that books nothing, which is
    // how two of them shipped.
    @"seen":                 @(atomic_load(&g_seen)),
    @"refusedNotRunning":    @(atomic_load(&g_refusedNotRunning)),
    @"refusedNoPixelBuffer": @(atomic_load(&g_refusedNoPixelBuf)),
    @"refusedNotArmed":      @(atomic_load(&g_refusedNotArmed)),
    @"refusedFrameInvalid":  @(atomic_load(&g_refusedFrameInvalid)),
    @"refusedBadPts":        @(atomic_load(&g_refusedBadPts)),
    @"refusedNoIntrinsics":  @(atomic_load(&g_refusedNoIntrinsics)),
    @"refusedBadMatrix":     @(atomic_load(&g_refusedBadMatrix)),
    @"refusedShortMatrix":   @(atomic_load(&g_refusedShortMatrix)),
    @"refusedFatalAttitude": @(atomic_load(&g_refusedFatalAttitude)),
    @"ingestedDegraded":     @(atomic_load(&g_ingestedDegraded)),
    @"ingested":             @(atomic_load(&g_ingested)),
    // WHICH intrinsics each ingested frame used. A pack that cannot say
    // this cannot be compared with a Camera2-arm pack.
    @"intrinsicsDelivered":  @(atomic_load(&g_intrinsicsDelivered)),
    @"intrinsicsFovDerived": @(atomic_load(&g_fovDerived)),
  };
}

- (id)callback:(Frame*)frame withArguments:(NSDictionary* _Nullable)arguments {
  // ── OWNERSHIP FIRST, AND IT IS NOT `isRunning` ─────────────────────
  // `isRunning` answers "is a sweep in progress", which is true on the AVF
  // and ARKit arms too. Feeding the engine there is a second producer
  // interleaving into one session. Only a vc-arm start path arms this.
  // ⚠ COUNTED BEFORE THE ARM GATE, NOT AFTER IT. `seen` is documented as
  // the denominator that `ingested` plus every refusal must sum to — and
  // `refusedNotArmed` is one of them. Booking `seen` after this gate put
  // that refusal structurally outside the total, which makes the identity
  // false on the ONLY state this arm can currently be in.
  atomic_fetch_add(&g_seen, 1);
  if (!atomic_load(&g_armed)) {
    atomic_fetch_add(&g_refusedNotArmed, 1);
    return @{@"ingested": @NO, @"why": @"not armed — no iOS vc-arm start path"};
  }
  // Every refusal from here books a bucket too. Two of these returns used
  // to book nothing, so `ingested + the buckets` did not account for the
  // frames vision-camera delivered — and this arm's counters are its ONLY
  // evidence channel.
  if (![RNISPanoCore isRunning]) {
    atomic_fetch_add(&g_refusedNotRunning, 1);
    return @{@"ingested": @NO, @"why": @"not running"};
  }

  // ⚠ `isValid` BEFORE `.buffer`, NOT A NULL TEST AFTER IT. `-[Frame buffer]`
  // THROWS `capture/frame-invalid` when the frame has been closed
  // (vc 4.7.3, Frame.m:37-48) and otherwise returns a buffer `isValid` has
  // already established is non-nil — so `sampleBuffer == NULL` is a branch
  // that can never be taken, sitting exactly where the real failure mode is.
  // Unchecked, an already-released frame raises an NSException that vc turns
  // into a JS error thrown inside the worklet: no counter, no refusal row,
  // nothing in `+report`.
  //
  // The Android sibling reaches the same OUTCOME by a different mechanism,
  // worth stating rather than glossing: it wraps the access in try/catch and
  // books the throw (`PanoPlusSweepFrameProcessor.kt:115-122`), where this
  // checks first. It also books into the shared pre-offer bucket, while this
  // has its own `g_refusedFrameInvalid` — so "the same" means counted, not
  // the same bucket.
  if (!frame.isValid) {
    atomic_fetch_add(&g_refusedFrameInvalid, 1);
    return @{@"ingested": @NO, @"why": @"frame invalid — already released"};
  }
  CMSampleBufferRef sampleBuffer = frame.buffer;
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  if (pixelBuffer == NULL) {
    atomic_fetch_add(&g_refusedNoPixelBuf, 1);
    return @{@"ingested": @NO, @"why": @"no pixel buffer"};
  }

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
  const double ptsS = CMTimeGetSeconds(pts);
  // ⚠ `CMTIME_IS_VALID` ALONE IS NOT ENOUGH. `kCMTimePositiveInfinity`
  // carries the Valid flag, so it passes that macro and `CMTimeGetSeconds`
  // yields +inf. `align` then answers the NON-FATAL `NonFiniteInput`
  // refusal — and this arm's policy is to INGEST non-fatal refusals, so the
  // frame would reach the engine with `timestampNs: inf * 1e9`. The
  // finiteness test is the one the AVF sibling makes, and adopting its
  // non-fatal-ingest policy is precisely what makes skipping it unsafe.
  if (!CMTIME_IS_VALID(pts) || !isfinite(ptsS)) {
    atomic_fetch_add(&g_refusedBadPts, 1);
    return @{
      @"ingested": @NO,
      @"why": @"presentation timestamp is not a finite number",
      @"refusedBadPts": @(atomic_load(&g_refusedBadPts)),
    };
  }

  // ── INTRINSICS, OR REFUSE — AND SAY WHICH FAULT ────────────────────
  // Three distinct faults used to share one message that named
  // vision-camera. Only the first is vision-camera's: the other two mean
  // delivery IS on and the payload is wrong, which sends a reader upstream
  // for nothing.
  double fx = 0.0, fy = 0.0, cx = 0.0, cy = 0.0;
  CFTypeRef matrixRef = CMGetAttachment(
      sampleBuffer, kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, NULL);
  const size_t pxW = CVPixelBufferGetWidth(pixelBuffer);
  if (matrixRef == NULL) {
    // ── NO DELIVERED MATRIX: DERIVE FROM THE DEVICE'S FOV, AND MARK IT ──
    //
    // vision-camera 4.7.3 never enables intrinsic-matrix delivery (measured:
    // zero occurrences of `IntrinsicMatrix` in its iOS tree), so this is the
    // ordinary path, not the exceptional one. An earlier version of this file
    // REFUSED here, on the grounds that a guessed focal length is the one
    // error the engine's `fx > 0` guard cannot catch. The premise was wrong:
    // this is not a guess, it is the same arithmetic on the same published
    // measurement that `RNISPanoAvfSource` does on its own device, and it is
    // reached the same way the Android arm reaches it — through the device id
    // JS already sends. Refusing made the whole arm inert for a constraint
    // that does not exist.
    //
    // The REAL hazard the old header named is still real and still guarded,
    // one layer up: a VIRTUAL multi-camera container switches its active
    // constituent under zoom with no notification, so an fx read from the
    // container is wrong at 0.5×. `sweepHostOwnsCamera` refuses the arm on a
    // multicam body away from the 1× baseline, which is where that belongs —
    // it is a question about which device is mounted, not about a frame.
    double fovFx = 0.0;
    [g_fovLock lock];
    fovFx = g_fovFx;
    [g_fovLock unlock];
    if (!(fovFx > 0.0)) {
      atomic_fetch_add(&g_refusedNoIntrinsics, 1);
      return @{
        @"ingested": @NO,
        @"why": @"no intrinsic-matrix attachment, and no FOV-derived focal "
                @"length either — the arm was not told which camera "
                @"vision-camera mounted (vcCameraId), or that device "
                @"publishes no videoFieldOfView",
        @"refusedNoIntrinsics": @(atomic_load(&g_refusedNoIntrinsics)),
      };
    }
    fx = fovFx;
    fy = fovFx;
    cx = (double)pxW * 0.5;
    cy = (double)CVPixelBufferGetHeight(pixelBuffer) * 0.5;
    atomic_fetch_add(&g_fovDerived, 1);
  } else if (CFGetTypeID(matrixRef) != CFDataGetTypeID()) {
    atomic_fetch_add(&g_refusedBadMatrix, 1);
    return @{
      @"ingested": @NO,
      @"why": @"intrinsic-matrix attachment is present but is not CFData — "
              @"delivery IS enabled and the payload is wrong; this is not a "
              @"vision-camera configuration problem",
      @"refusedBadMatrix": @(atomic_load(&g_refusedBadMatrix)),
    };
  } else {
    // DELIVERED — always preferred over the derivation above.
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
    atomic_fetch_add(&g_intrinsicsDelivered, 1);
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
      atomic_store(&g_seen, 0);
      atomic_store(&g_refusedNotArmed, 0);
      atomic_store(&g_refusedNotRunning, 0);
      atomic_store(&g_refusedNoPixelBuf, 0);
      atomic_store(&g_refusedFrameInvalid, 0);
      atomic_store(&g_refusedBadPts, 0);
      atomic_store(&g_refusedNoIntrinsics, 0);
      atomic_store(&g_refusedBadMatrix, 0);
      atomic_store(&g_refusedShortMatrix, 0);
      atomic_store(&g_refusedFatalAttitude, 0);
      atomic_store(&g_ingestedDegraded, 0);
      atomic_store(&g_ingested, 0);
      atomic_store(&g_fovDerived, 0);
      atomic_store(&g_intrinsicsDelivered, 0);
    }
    atomic_store(&g_armed, armed);
  }];

  // The device vision-camera mounted, from the id JS already sends. Derived
  // ONCE per arm rather than per frame: `deviceWithUniqueID:` is a lookup,
  // and this runs on whatever thread the start path uses, not on vc's
  // frame-processor queue.
  if (g_fovLock == nil) g_fovLock = [[NSLock alloc] init];
  [[NSNotificationCenter defaultCenter]
      addObserverForName:kCameraIdNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
    NSString *camId = note.userInfo[@"cameraId"];
    NSNumber *w = note.userInfo[@"frameWidth"];
    [g_fovLock lock];
    g_fovCameraId = [camId copy];
    g_fovFx = RNISSweepFovFxForCamera(camId, (size_t)[w unsignedLongValue]);
    [g_fovLock unlock];
  }];
}

@end

#endif  // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
