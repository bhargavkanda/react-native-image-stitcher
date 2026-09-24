// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoSweepFrameProcessor — the sweep engine, fed from the camera
// `<Camera>` already owns (M5).
//
// The iOS half of the vision-camera arm. vision-camera owns the device and
// hands the pixels over per frame; `RNISPanoCore` is unchanged behind it, and
// nothing in pano+ opens an `AVCaptureSession`.
//
// Shaped like `KeyframeGateFrameProcessor.mm`: `__has_include` guard so the
// file is a no-op translation unit without vision-camera, `+load`
// registration, and a callback that does the smallest possible amount of work
// on vision-camera's frame-processor queue.
//
// ── WHO ARMS IT ─────────────────────────────────────────────────────────
//
// `RNISPanoVcArm` (Swift), from `PanoPlusBridge.start` with `poseSource:
// 'imu'` + `vcPluginArm` + `vcCameraId`. It resolves the device vision-camera
// mounted, refuses what the sweep cannot run on, derives the device-to-camera
// basis (D3), starts CoreMotion (`RNISPanoImuArm`), locks exposure on the
// device, and then posts `kArmNotification` with the camera id, the format
// width and whether the lock took. Disarm is the same notification with
// `armed: NO`, and it is SYNCHRONOUS: the observer waits out a frame already
// inside the engine before it returns, so nothing ingests after the sweep
// has ended. The arm's report is read back through `+report`, by name
// (`NSClassFromString`), so the Swift side links on a build without this file.
//
// ⚠ `[RNISPanoCore isRunning]` IS NOT AN OWNERSHIP TEST — it is true on every
// arm. Ownership is the explicit arm flag; a plugin gated only on `isRunning`
// beside a live AVF or ARKit arm would be a second producer into one engine.
//
// ── INTRINSICS ──────────────────────────────────────────────────────────
//
// vision-camera 4.7.3 never enables `isCameraIntrinsicMatrixDeliveryEnabled`
// (measured: zero occurrences of `IntrinsicMatrix` in its iOS tree), so the
// ordinary path DERIVES fx from the device's published horizontal field of
// view — the arithmetic `RNISPanoAvfSource` runs on its own device — and marks
// the pack (`intrinsicsFovDerived`). Measured offline on 48 iPhone packs: the
// derived focal length reads 0.4–3.1% low, and replay shows the canvas within
// 0.6%. A delivered matrix, when present, is always preferred.
//
// The device vision-camera mounts is PHYSICAL on iOS in practice (its minZoom
// is ≥1, so `<Camera>`'s multicam branch never fires there), or a virtual
// device with exactly ONE colour constituent (the LiDAR depth camera a depth
// build mounts at 1×). `RNISPanoVcArm` refuses multi-lens virtual devices by
// name before arming, because their active constituent changes under zoom;
// this file refuses any frame taken at a zoom other than 1× for the same
// reason.
//
// ── D3: THE BUFFER MUST BE THE RAW SENSOR RASTER ─────────────────────────
//
// The basis was derived for the back camera's native landscape raster, read
// unrotated and unmirrored. A mirrored buffer, a buffer taller than wide, or
// a frame whose orientation differs from the sweep's first frame is REFUSED
// and named (`deviceRefusal` in `+report`, surfaced live through the bridge's
// status so the host discards the sweep by name). Painting on a basis that no
// longer describes the pixels is a confidently wrong canvas.
//
// ── WHAT IS OBSERVABLE ──────────────────────────────────────────────────
//
// `seen` is the denominator: every frame vision-camera offered books exactly
// one bucket (`ingested` or one `refused*`). The attitude work is COUNTED
// (`align`, one call per delivered frame — `RNISPanoAttitude.h`), and the
// aligner's report reaches the pack through `RNISPanoImuArm.publish`.

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

/// Posted by `RNISPanoVcArm` to arm/disarm this plugin. `userInfo`:
///   armed       NSNumber BOOL
///   cameraId    NSString — the `AVCaptureDevice.uniqueID` vision-camera mounted
///   frameWidth  NSNumber — the active format's LONG edge, for the FOV focal length
///   lockArmed   NSNumber BOOL — the exposure lock took, so a frame whose device
///               reports a non-locked exposure mode is counted as unlocked
///
/// A NOTIFICATION RATHER THAN A CLASS METHOD, deliberately. This whole file is
/// inside `#if __has_include(<VisionCamera/…>)`, so a `+setArmed:` declared in
/// a header would be a symbol that vanishes on builds without vision-camera
/// and takes its caller's link down with it. A notification name is a string:
/// the poster compiles and runs whether or not this plugin exists.
static NSString *const kArmNotification = @"RNISPanoSweepVcArmDidChange";

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
// M5 — the device-level refusals (D3 buffer checks and the zoom guard), the
// lock witness, and the frames currently inside the callback.
static atomic_ullong g_refusedZoom          = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedMirrored      = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedRotated       = ATOMIC_VAR_INIT(0);
static atomic_ullong g_refusedOrientation   = ATOMIC_VAR_INIT(0);
static atomic_ullong g_observedUnlocked     = ATOMIC_VAR_INIT(0);
static atomic_ullong g_exposureRead         = ATOMIC_VAR_INIT(0);
static atomic_bool   g_lockArmed            = ATOMIC_VAR_INIT(false);
/// Frames currently inside `callback:`. Incremented BEFORE the arm gate so a
/// disarm that has cleared the flag can wait for every frame that might have
/// read it as set (see the disarm observer).
static atomic_int    g_inFlight             = ATOMIC_VAR_INIT(0);
/// The sweep's first frame orientation (UIImageOrientation), −1 until seen.
static atomic_int    g_firstOrientation     = ATOMIC_VAR_INIT(-1);
/// The FIRST device-level refusal of the sweep, by name — surfaced live by the
/// bridge's status so the host can discard the sweep by name. Guarded by
/// `g_fovLock`.
static NSString *g_deviceRefusal = nil;

namespace {
/// Balanced on every return path of `callback:` by scope, including the early
/// ones — which is what makes the disarm drain exact.
struct RNISInFlight {
  RNISInFlight() { atomic_fetch_add(&g_inFlight, 1); }
  ~RNISInFlight() { atomic_fetch_sub(&g_inFlight, 1); }
};
}  // namespace

/// The FOV-derived focal length for the device vision-camera mounted, and
/// the id it was derived from. Guarded by `g_fovLock` — written on the arm
/// notification, read on the frame-processor queue.
static NSLock *g_fovLock = nil;
static double  g_fovFx = 0.0;
/// The buffer width `g_fovFx` was baked FROM. `fx` scales linearly with image
/// width at a fixed field of view, so an fx baked at one width and applied at
/// another is wrong by exactly that ratio — and it is not a hypothetical: the
/// width arrives over `kArmNotification` from the AVCaptureDevice format
/// while the frame processor is handed vision-camera's VIDEO buffer, which is
/// a different resolution on most bodies, and a rotation swaps w/h on top.
/// Kept so the fx can be rescaled to the buffer actually delivered.
static size_t  g_fovWidth = 0;
/// Frames whose delivered width did not match the baked one, so the FOV fx
/// had to be rescaled. A silent rescale is the kind of correction that hides
/// a wiring mistake, so it is COUNTED and reported.
static atomic_int g_fovWidthRescaled;
static NSString *g_fovCameraId = nil;
/// The device the frames come from, resolved once per arm. Read on the frame
/// queue for the per-frame exposure / ISO / zoom; guarded by `g_fovLock`.
static AVCaptureDevice *g_device = nil;

/// Record the sweep's first device-level refusal. Later ones only count.
static void RNISSweepNoteDeviceRefusal(NSString *name) {
  [g_fovLock lock];
  if (g_deviceRefusal == nil) g_deviceRefusal = [name copy];
  [g_fovLock unlock];
}

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
static NSString *RNISSweepDeviceRefusal(void) {
  [g_fovLock lock];
  NSString *r = [g_deviceRefusal copy];
  [g_fovLock unlock];
  return r;
}

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
    // Non-zero means the width the arm sent over `kArmNotification` did not
    // match the buffer vision-camera delivered. The fx was rescaled and the
    // sweep is geometrically sound — but a persistently non-zero count is a
    // WIRING report: the publisher is sending the format width where it
    // should send the video one. Counted rather than silently corrected.
    @"intrinsicsFovWidthRescaled": @(atomic_load(&g_fovWidthRescaled)),
    // M5 — the device-level refusals: a zoom other than 1×, and the D3
    // buffer checks. `deviceRefusal` is the FIRST one's name (or null).
    @"refusedZoom":              @(atomic_load(&g_refusedZoom)),
    @"refusedMirrored":          @(atomic_load(&g_refusedMirrored)),
    @"refusedRotated":           @(atomic_load(&g_refusedRotated)),
    @"refusedOrientationChanged": @(atomic_load(&g_refusedOrientation)),
    @"deviceRefusal":            RNISSweepDeviceRefusal() ?: (id)[NSNull null],
    @"firstOrientation":         @(atomic_load(&g_firstOrientation)),
    // The lock witness: frames whose device reported a non-locked exposure
    // mode while the start-time lock claimed success. The AVF arm's delegate
    // made the same check; nothing else drives it on this arm.
    @"lockArmed":                @(atomic_load(&g_lockArmed)),
    @"framesObservedUnlocked":   @(atomic_load(&g_observedUnlocked)),
    // Frames that carried the device's exposure duration and ISO to the
    // engine — its exposure normalisation used to run on zeros here.
    @"framesWithExposure":       @(atomic_load(&g_exposureRead)),
    @"accelSource":              @"RNISPanoAttitude.latestAccelMagMps2 (the IMU arm's CoreMotion)",
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
  //
  // ⚠ IN FLIGHT FIRST, BEFORE THE ARM GATE: the disarm observer clears the
  // flag and then waits for this count to reach zero, so every frame that
  // could have read the flag as set is waited out.
  RNISInFlight inFlight;
  atomic_fetch_add(&g_seen, 1);
  if (!atomic_load(&g_armed)) {
    atomic_fetch_add(&g_refusedNotArmed, 1);
    return @{@"ingested": @NO, @"why": @"not armed — no vision-camera sweep is running"};
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

  // ── D3: THE RAW SENSOR RASTER, OR REFUSE BY NAME ─────────────────────
  // The basis was derived for the back camera's landscape raster, read
  // unrotated and unmirrored. Anything else is a basis that no longer
  // describes these pixels — refused, counted, and the first one named.
  if (frame.isMirrored) {
    atomic_fetch_add(&g_refusedMirrored, 1);
    RNISSweepNoteDeviceRefusal(@"mirrored-buffer");
    return @{@"ingested": @NO, @"why": @"the buffer is mirrored"};
  }
  {
    const size_t bw = CVPixelBufferGetWidth(pixelBuffer);
    const size_t bh = CVPixelBufferGetHeight(pixelBuffer);
    if (bh >= bw) {
      atomic_fetch_add(&g_refusedRotated, 1);
      RNISSweepNoteDeviceRefusal(@"rotated-buffer");
      return @{@"ingested": @NO, @"why": @"the buffer is not the landscape sensor raster"};
    }
  }
  {
    // The orientation vision-camera reports is RECORDED, and must not change
    // within a sweep: a change means vision-camera re-oriented its outputs
    // under the sweep.
    const int o = (int)frame.orientation;
    int expected = -1;
    if (!atomic_compare_exchange_strong(&g_firstOrientation, &expected, o) && expected != o) {
      atomic_fetch_add(&g_refusedOrientation, 1);
      RNISSweepNoteDeviceRefusal(@"orientation-changed");
      return @{@"ingested": @NO, @"why": @"the frame orientation changed mid-sweep"};
    }
  }

  // ── THE DEVICE: ZOOM GUARD, EXPOSURE, AND THE LOCK WITNESS ────────────
  [g_fovLock lock];
  AVCaptureDevice *dev = g_device;
  [g_fovLock unlock];
  double expDur = 0.0, expISO = 0.0;
  if (dev != nil) {
    // The focal length is the UNZOOMED lens's; a zoomed frame would paint at
    // the wrong scale and report success.
    const double z = (double)dev.videoZoomFactor;
    if (!(fabs(z - 1.0) <= 1e-3)) {
      atomic_fetch_add(&g_refusedZoom, 1);
      RNISSweepNoteDeviceRefusal(@"zoom-not-1");
      return @{@"ingested": @NO, @"why": @"the camera is zoomed"};
    }
    const double sec = CMTimeGetSeconds(dev.exposureDuration);
    if (isfinite(sec) && sec > 0.0) expDur = sec;
    const double iso = (double)dev.ISO;
    if (isfinite(iso) && iso > 0.0) expISO = iso;
    if (expDur > 0.0 && expISO > 0.0) atomic_fetch_add(&g_exposureRead, 1);
    if (atomic_load(&g_lockArmed) && dev.exposureMode != AVCaptureExposureModeLocked) {
      atomic_fetch_add(&g_observedUnlocked, 1);
    }
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
    // ⚠ ONE CRITICAL SECTION FOR BOTH, because they are ONE fact. Reading
    // the fx and the width it was baked from under separate locks lets a
    // an arm notification land in between and pair camera A's fx with
    // camera B's width — a ratio built from two different cameras, which is
    // worse than either alone and would look like a plausible number.
    double fovFx = 0.0;
    size_t bakedW = 0;
    [g_fovLock lock];
    fovFx = g_fovFx;
    bakedW = g_fovWidth;
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
    // ⚠ RESCALED TO THE DELIVERED BUFFER, AND AGAINST ITS LONG EDGE.
    //
    // `g_fovFx` is baked once at arm time from the width JS sent; `cx`/`cy`
    // below come from the buffer in hand. Taking the four numbers of one
    // intrinsics set from two different widths is a canvas that paints at
    // the wrong scale and reports success — the exact failure the
    // refuse-or-derive policy exists to prevent.
    //
    // ⚠ AND IT IS THE LONG EDGE, NOT `pxW`. An earlier version of this block
    // scaled by `pxW / bakedW` under a comment claiming it "absorbs the
    // rotated case". It does not, and the comment was wrong. A focal length
    // in PIXELS is invariant to rotating the buffer: the same capture
    // delivered 1280x720 and 720x1280 has the same fx. Baked at 1920 with a
    // 68° hFOV (fx 1423.26):
    //
    //   delivered 1280x720  -> 1423.26 * 1280/1920 = 948.84   ✓ (truth 948.84)
    //   delivered 720x1280  -> 1423.26 *  720/1920 = 533.72   ✗ (truth 948.84)
    //
    // `videoFieldOfView` is the HORIZONTAL field of the sensor's native
    // landscape frame, so the fx it yields belongs to the LONG edge. Scaling
    // by `max(w, h)` is therefore right in both orientations, and `fy = fx`
    // holds because the pixels are square.
    const size_t pxH = CVPixelBufferGetHeight(pixelBuffer);
    const size_t deliveredLong = (pxW > pxH) ? pxW : pxH;
    if (bakedW > 0 && bakedW != deliveredLong) {
      fovFx = fovFx * ((double)deliveredLong / (double)bakedW);
      atomic_fetch_add(&g_fovWidthRescaled, 1);
    }
    fx = fovFx;
    fy = fovFx;
    cx = (double)pxW * 0.5;
    cy = (double)pxH * 0.5;
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
  // The acceleration magnitude from the IMU arm's CoreMotion stream (M5) —
  // the same quantity the AVF arm cages. NaN until the first motion sample,
  // which the cage records as NOT EVALUATED, never as a pass.
  const RNISPanoAlignResult att = [RNISPanoAttitude
      alignPtsS:ptsS accelMagMps2:[RNISPanoAttitude latestAccelMagMps2]];
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
                // M5 — the device's own exposure, read per frame: the
                // engine's exposure normalisation runs on the camera
                // rather than on zeros. Zero only when unreadable.
                exposureDurationS:expDur
                      exposureISO:expISO
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

  // Arming, from `RNISPanoVcArm`. Registered at image load so it cannot be
  // missed by a poster that runs early.
  if (g_fovLock == nil) g_fovLock = [[NSLock alloc] init];
  [[NSNotificationCenter defaultCenter]
      addObserverForName:kArmNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
    const BOOL armed = [note.userInfo[@"armed"] boolValue];
    if (armed) {
      // RESET ON ARM, not on disarm: the stop path publishes `+report` AFTER
      // disarming.
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
      atomic_store(&g_fovWidthRescaled, 0);
      atomic_store(&g_intrinsicsDelivered, 0);
      atomic_store(&g_refusedZoom, 0);
      atomic_store(&g_refusedMirrored, 0);
      atomic_store(&g_refusedRotated, 0);
      atomic_store(&g_refusedOrientation, 0);
      atomic_store(&g_observedUnlocked, 0);
      atomic_store(&g_exposureRead, 0);
      atomic_store(&g_firstOrientation, -1);
      atomic_store(&g_lockArmed, [note.userInfo[@"lockArmed"] boolValue] ? true : false);
      // The device and its FOV focal length, ONCE per arm: a
      // `deviceWithUniqueID:` lookup does not belong on the frame queue.
      NSString *camId = note.userInfo[@"cameraId"];
      NSNumber *w = note.userInfo[@"frameWidth"];
      [g_fovLock lock];
      g_deviceRefusal = nil;
      g_fovCameraId = [camId copy];
      g_fovWidth = (size_t)[w unsignedLongValue];
      g_device = camId.length > 0 ? [AVCaptureDevice deviceWithUniqueID:camId] : nil;
      g_fovFx = RNISSweepFovFxForCamera(camId, g_fovWidth);
      [g_fovLock unlock];
      atomic_store(&g_armed, true);
      return;
    }
    // DISARM, AND WAIT. Clearing the flag stops NEW frames; a frame already
    // past the gate may be inside `ingestPixelBuffer`. The stop path finalizes
    // the engine next, so every such frame is waited out here (bounded — a
    // wedged frame queue must not wedge the bridge).
    atomic_store(&g_armed, false);
    const CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 1.0;
    while (atomic_load(&g_inFlight) > 0 && CFAbsoluteTimeGetCurrent() < deadline) {
      usleep(1000);
    }
    [g_fovLock lock];
    g_device = nil;
    [g_fovLock unlock];
  }];
}

@end

#endif  // __has_include(<VisionCamera/FrameProcessorPlugin.h>)
