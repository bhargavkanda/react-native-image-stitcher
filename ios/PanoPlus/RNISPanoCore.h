// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoCore.h — Obj-C façade over the pano+ slit-scan engine
// (cpp/rnis_pano.{hpp,cpp}) and its session/pack machinery.
//
// PURE OBJ-C ON PURPOSE.  The podspec puts every `ios/*.h` into the pod
// umbrella, and the umbrella is compiled in Obj-C context — a C++ type here
// would break the pod for any `use_frameworks!` host.  All C++ lives in the
// .mm (the same split every Obj-C++ core header in this pod uses).
//
// ── What this owns ───────────────────────────────────────────────────────
//
//   * a bounded, PRE-ALLOCATED frame ring so the ARKit delegate thread only
//     ever does a plane-aware memcpy and an enqueue (ARKit recycles
//     `capturedImage` the moment `process(_:)` returns; a CF retain does NOT
//     protect it — RNISARFramePlugin.swift:78-84);
//   * a serial ENGINE queue that converts the copy to cv::Mat and drives
//     rnis::pano::Engine;
//   * a serial PACK queue that appends the ledger + track JSONL and encodes
//     source frames / the preview band;
//   * the debug pack itself (see §5 of the design), so the offline harness is
//     the device engine's replay twin.
//
// ── Threading contract ───────────────────────────────────────────────────
//
//   +startWithOptions / +finalizeSession / +cancel : any background queue
//                                                    (NEVER the main queue —
//                                                    finalize encodes a
//                                                    multi-megapixel JPEG)
//   +ingestPixelBuffer                             : the AR delegate thread,
//                                                    once per ARFrame
//   +status                                        : any thread, lock-guarded,
//                                                    returns a cached snapshot
//
// A frame the ring cannot accept is DROPPED and counted (`droppedQueue`),
// never blocked on — stalling the AR thread would stall ARKit tracking and
// every other registered plugin.

#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>

NS_ASSUME_NONNULL_BEGIN

/// Error domain for the pano+ session.  A distinct symbol from any host
/// plugin's error domain (two extern NSStrings sharing a name would be
/// a duplicate symbol at app link).  Nothing JS-side reads the domain — the
/// reject KEYS carry the contract.
extern NSString *const RNISPanoPlusErrorDomain;

@interface RNISPanoCore : NSObject

/// Begin a sweep.  Creates the session directory tree, allocates the frame
/// ring and the engine, and opens the pack writers.  Rejects (NO + *error)
/// when a session is already running, the options are degenerate, or the
/// session directory cannot be created.
///
/// `options` (every key optional except `sessionDir`):
///   sessionDir            NSString  — absolute path; created if absent
///   canvasScale, stripMargin, minAdvancePx, maxAdvancePx, maxAdvanceFrac,
///   workScale, phaseWindowPx, minPhaseResponse, stallResumeResponse,
///   maxRejectRunFrames, gainStepClamp, gainCumClamp, gainSampleMinPx,
///   canvasInitWidthPx, canvasMaxWidthPx, canvasPadPx, canvasMaxHeightPx,
///   canvasMaxPixels, trackingWarmupFrames,
///   cageStallFrames, axisLatchFrames, maxTranslationJumpM, maxSweepSpeedMps,
///   poseSlackM, rectifyYawLimitDeg, axisOverride, signOverride  — NSNumber,
///                             each mapping 1:1 onto rnis::pano::Config
///   outputRotationCwDeg   NSNumber  — 0 | 90 | 180 | 270, the UPRIGHT BAKE
///                             applied to `canvas.jpg` (and nothing else).
///                             Host-supplied because a portrait-locked app
///                             cannot ask UIKit for the physical hold; the
///                             SDK sends `panoPlusUprightRotationDeg`.
///                             Default 0 = the pre-v14 raster-frame output.
///   rectify, gainMatch, cropVertical, canvasGrowVertical, backfillGaps,
///   abortOnLimitedTracking                                      — NSNumber(bool)
///   packFrames            NSString  — "all" (default) | "painted" | "none"
///   packFrameEveryN       NSNumber  — default 1
///   packFrameQuality      NSNumber  — default 70
///   packMaxFrames         NSNumber  — default 1500 (hit ⇒ recorded, not silent)
///   canvasQuality         NSNumber  — default 92
///   previewIntervalMs     NSNumber  — default 120 (a FLOOR; see below)
///   previewMaxDutyPct     NSNumber  — default 8 — the preview's own measured
///                                     cost is held to this share of wall
///                                     time, so a dear render slows the
///                                     REFRESH RATE and never the sweep
///   previewQuality        NSNumber  — default 82 (JPEG)
///   previewWindowCrossMult NSNumber — default 1.44 — follow-the-frontier
///                                     window as a multiple of the cross
///                                     extent; 0 ⇒ always fit the whole canvas
///   previewMaxAlong/Cross NSNumber  — default 2000 / 800.  The legacy
///                                     previewMaxW/H keys are still accepted
///                                     and map onto these.
///   packQueueMax          NSNumber  — default 8 pending frame encodes
///   exposureNormalize, exposureGainClamp, photoMinSamples,
///   photoGradMaxDN, photoUniformMinFrac, photoLocalWindowPx     — v6 photometry
+ (BOOL)startWithOptions:(NSDictionary<NSString *, id> *)options
                   error:(NSError **)error NS_SWIFT_NAME(start(options:));

/// Feed one ARFrame.  Returns IMMEDIATELY: copies the pixels into a ring slot
/// and hands the slot to the engine queue.  A no-op when no sweep is running.
/// `rotation` is the world←camera unit quaternion [x,y,z,w] (ARKit GL
/// convention); `translation` is the camera position in world metres;
/// intrinsics are the frame's OWN, in pixels, against imageWidth/imageHeight
/// — never hardcoded anywhere below this call.
///
/// `exposureDurationS` (seconds) and `exposureISO` are the capture device's
/// exposure for this frame (v6).  Scene radiance is LINEAR in their product,
/// which is what lets the engine normalise every frame to the reference
/// frame's exposure EXACTLY instead of estimating it from image overlap.
/// Pass 0 for either when the metadata is unavailable — the engine then
/// treats the frame as needing no normalisation, which is byte-identical to
/// v5's behaviour.
///
/// `arExposureDurationS` / `arExposureOffsetEV` are ARKit'S OWN numbers for
/// this frame (`ARCamera.exposureDuration` in seconds, `ARCamera.exposure-
/// Offset` in EV), and `arExposureHave` says whether they were readable at
/// all.  They exist to make the AE-lock evidence NON-CIRCULAR: everything in
/// the pair above is read off the `AVCaptureDevice` this pod resolved and
/// locked, so it cannot answer "is that the device ARKit streams?" or "does
/// the lock reach ARKit's pixels?".  These two can.
///
/// EVIDENCE ONLY — the engine records them and nothing else.  They do not
/// feed the radiometric normalisation, the gain chain, the placement or the
/// verdict, and a build that cannot read them produces a byte-identical
/// canvas with `arExposureFrames: 0` in the pack.  `arExposureHave` is
/// carried separately because `exposureOffset` is an EV OFFSET whose 0.0 is
/// a legal reading, so absence can never be inferred from the value.
+ (void)ingestPixelBuffer:(CVPixelBufferRef)pixelBuffer
              timestampNs:(double)timestampNs
                       fx:(double)fx
                       fy:(double)fy
                       cx:(double)cx
                       cy:(double)cy
               imageWidth:(NSInteger)imageWidth
              imageHeight:(NSInteger)imageHeight
                 rotation:(NSArray<NSNumber *> *)rotation
              translation:(NSArray<NSNumber *> *)translation
                 tracking:(NSString *)tracking
        exposureDurationS:(double)exposureDurationS
              exposureISO:(double)exposureISO
      arExposureDurationS:(double)arExposureDurationS
       arExposureOffsetEV:(double)arExposureOffsetEV
           arExposureHave:(BOOL)arExposureHave
    NS_SWIFT_NAME(ingest(pixelBuffer:timestampNs:fx:fy:cx:cy:imageWidth:imageHeight:rotation:translation:tracking:exposureDurationS:exposureISO:arExposureDurationS:arExposureOffsetEV:arExposureHave:));

/// Cached live status — the SYNC channel the AR plugin returns each frame
/// (the async `emit` channel is recorded as unreliable in a host, so nothing
/// the operator must see rides it).  nil when no sweep is running.
+ (nullable NSDictionary<NSString *, id> *)status;

/// Drain, run the lead-out tail flush, write `canvas.jpg` + `meta.json`, close
/// the pack, and return the summary.  Named `finalizeSession` rather than
/// `finalize` to stay clear of NSObject's legacy GC selector.
///
/// Returns `{ sessionDir, canvasPath, previewPath, width, height, counts{…},
/// axis, sweepSign, maxRectifyDeg, unpaintedRuns, unpaintedRunsAxis,
/// clipping{…}, verticalEnvelope{…}, engineMs{…}, arThreadUs{…},
/// previewMs{…}, droppedQueue, droppedPack, framesWritten, packBytes,
/// sweepMs, finalizeMs, abort }` on success.
///
/// `unpaintedRuns` indexes the SWEEP axis (`unpaintedRunsAxis` names it) — the
/// output's column axis only for a horizontal sweep.  `clipping` is the
/// PERPENDICULAR integrity signal, which `unpaintedRuns` structurally cannot
/// see: a panorama truncated in height reports zero holes.
///
/// On a sweep that painted nothing
/// returns nil with *error (code `panoplus-empty`); the pack is still on disk
/// and *error's userInfo carries the counters, so a FAILED sweep is still
/// evidence (the D2 pattern this pod already uses).
+ (nullable NSDictionary<NSString *, id> *)finalizeSessionWithError:(NSError **)error
    NS_SWIFT_NAME(finalizeSession());

/// Abandon the sweep and delete the session directory.  Safe to call twice.
+ (void)cancel;

+ (BOOL)isRunning;

/// Record the capture-side camera-lock report (v6) so it rides meta.json.
/// Called by PanoPlusBridge AFTER `start` succeeds and the AE/AWB/AF lock has
/// been attempted; a nil/empty dictionary means "not attempted".  Safe to
/// call when no session is running (it is then a no-op).
///
/// This is a REPORT, not a claim: it carries what the device said after the
/// write.  Whether ARKit honoured it is answered by the pack's own exposure
/// trace (`exposure.rangeRatio`), never by this dictionary.
+ (void)recordCameraLock:(nullable NSDictionary<NSString *, id> *)report
    NS_SWIFT_NAME(recordCameraLock(_:));

/// Merge the SWEEP'S OWN camera-lock evidence into the report recorded at
/// start.  Called at teardown, before finalize, with the counters that only
/// exist once the sweep has run: how many frames were observed with the lock
/// gone, how many re-asserts it took, and whether the RESTORE was refused —
/// which leaves the camera pinned for every other capture surface in the app
/// and used to be an os_log line nobody would ever read.
///
/// Keys already present in the start report are NOT overwritten; this only
/// adds.  Safe to call with no session running.
+ (void)mergeCameraLock:(nullable NSDictionary<NSString *, id> *)extra
    NS_SWIFT_NAME(mergeCameraLock(_:));

/// v11 — record the AR-exposure probe's own report so it rides
/// `meta.json → exposure.ar.probe`.  Called by PanoPlusBridge at teardown,
/// before finalize.  Safe to call with no session running.
///
/// It answers the question the numbers beside it cannot: a run with
/// `exposure.ar.frames == 0` is ambiguous between a build that cannot reach
/// ARKit's camera, a preview view that was never mounted, and a sweep that
/// ingested nothing — and a probe that cannot say WHY it is empty is not
/// evidence.  Replaces the report wholesale (unlike `mergeCameraLock`); the
/// probe owns the whole dictionary and there is no earlier half to protect.
+ (void)recordArExposureProbe:(nullable NSDictionary<NSString *, id> *)report
    NS_SWIFT_NAME(recordArExposureProbe(_:));

/// `meta.json → poseSource`.  Called by the DECOUPLED (AVFoundation +
/// CoreMotion) source at teardown, before finalize.  Safe with no session.
///
/// ⚠ THE KEY IS EMITTED ONLY WHEN THIS IS CALLED.  On the ARKit arm nothing
/// calls it, the key is absent, and `meta.json` is byte-identical to what
/// shipped — which is why this is a record hook rather than a key in the meta
/// literal with an explicit null on the default arm.
///
/// It exists because `meta.json` carries `counts.rejectedPoseSpeed: 0` from a
/// cage that never ran on the decoupled arm (`t` is identically zero there),
/// and every offline harness in this repo reads `meta.json` rather than the
/// `pose_source.json` sidecar the disclosure used to live in alone.  The one
/// file with the zeros in it was the one file with no marker on it.
+ (void)recordPoseSource:(nullable NSDictionary<NSString *, id> *)report
    NS_SWIFT_NAME(recordPoseSource(_:));

/// `meta.json → imuSidecar`.  Called by `RNISPanoImuSidecar` at teardown,
/// before finalize, on the ARKit arm ONLY and only when the sweep asked for
/// the second attitude channel.  Safe with no session.
///
/// ⚠ SAME EMIT-ONLY-WHEN-CALLED CONTRACT AS `recordPoseSource:` ABOVE, and for
/// the same reason: the sidecar is an EXPERIMENT beside the shipped,
/// field-validated ARKit producer, so a sweep that did not arm it must produce
/// the `meta.json` that shipped, byte for byte.  A key with an explicit null on
/// the default arm would not be that.
///
/// The block names the CoreMotion reference frame, the requested AND DELIVERED
/// sample rates, the two channels' delivery latencies (the timebase evidence),
/// this plugin's own AR-thread cost, and the τ/basis provenance that was on
/// disk at capture time — applied to nothing.  The samples themselves are in
/// `attitude_imu.jsonl` beside `track.jsonl`, RAW, so the offline replay can
/// sweep τ and basis instead of inheriting whichever pair happened to be
/// stored.
+ (void)recordImuSidecar:(nullable NSDictionary<NSString *, id> *)report
    NS_SWIFT_NAME(recordImuSidecar(_:));

@end

NS_ASSUME_NONNULL_END
