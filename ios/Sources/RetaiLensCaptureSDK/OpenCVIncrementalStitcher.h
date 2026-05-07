//
// OpenCVIncrementalStitcher.h
//
// Per-frame incremental panorama stitcher.  Replaces the batch-mode
// `cv::Stitcher` flow used by `OpenCVStitcher` with a streaming
// pipeline: each accepted frame is matched against the previous,
// warped via a RANSAC homography, and feather-blended onto a running
// canvas — no end-of-capture wait.
//
// Why incremental:
//   See docs/site-content/design/2026-04-30-realtime-incremental-stitching.md
//   for the full motivation.  TL;DR: live preview, bounded memory,
//   fail-fast on bad frames, no terminal BA stall.
//
// What this file owns:
//   The C++/OpenCV side of the engine — feature extraction, matching,
//   RANSAC, warp, feather blend.  All `cv::*` types stay inside the
//   `.mm` impl; this header exposes only Foundation types so it can
//   be imported from pure Swift via the umbrella header.
//
// Threading:
//   Methods on this class are NOT thread-safe internally.  The Swift
//   layer (`RetaiLensIncrementalStitcher`) owns a serial queue and
//   funnels all calls through it.  The lock is intentional: live
//   capture wants ordered frame ingestion, not parallel mutation of
//   the canvas.
//

#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>

NS_ASSUME_NONNULL_BEGIN

/// NSError domain raised by incremental stitcher errors.
extern NSString *const RetaiLensIncrementalStitcherErrorDomain;

/// Per-frame outcome — drives the JS-side UX (silent accept, subtle
/// flag, explicit hint).
typedef NS_ENUM(NSInteger, RLISFrameOutcome) {
    /// Frame accepted with high confidence.  Silent UX update.
    RLISFrameOutcomeAcceptedHigh = 0,
    /// Frame accepted but match quality was middling.  Show subtle
    /// confidence flag (yellow ring) — not an error, just informational.
    RLISFrameOutcomeAcceptedMedium = 1,
    /// Frame skipped because pose hasn't moved enough since last accept.
    /// Normal — operator hasn't panned past the overlap window yet.
    RLISFrameOutcomeSkippedTooClose = 2,
    /// Frame skipped because pose moved too far since last accept —
    /// operator panned past the overlap window before another accept.
    /// JS shows a "slow down" hint.
    RLISFrameOutcomeRejectedTooFar = 3,
    /// Feature matching produced too few correspondences.  Scene is
    /// likely uniform/textureless or the frame is motion-blurred.
    /// JS shows a "scene too uniform" hint.
    RLISFrameOutcomeRejectedSceneUniform = 4,
    /// RANSAC homography failed or produced a degenerate transform.
    /// JS shows an "alignment lost — slow down" hint.
    RLISFrameOutcomeRejectedAlignmentLost = 5,
    /// Tracking state from the AR session was poor at the time of
    /// this frame — no point trying to incorporate it.
    RLISFrameOutcomeSkippedTrackingPoor = 6,
    /// V12.11 Step D — operator has panned BACKWARDS past the
    /// running max along the pan axis by more than
    /// `kReverseStopPx`.  Engine has SKIPPED the paste; host should
    /// auto-finalize the capture and surface the panorama as it
    /// stood at the running-max position.  Emitted by the
    /// rectilinear engine only — cylindrical engines tolerate
    /// reverse motion via their warp pipeline.
    RLISFrameOutcomeRejectedReverseDirection = 7,
};

/// Telemetry returned alongside each addFrame call — host can log
/// these to refine threshold tuning during field testing.
@interface RLISFrameTelemetry : NSObject
@property (nonatomic, readonly) RLISFrameOutcome outcome;
/// Estimated FoV-overlap with the previously accepted frame, in
/// percent.  Computed from pose-delta + intrinsics, NOT from
/// matched features (which would require running the matcher
/// every frame).  Range [0, 100].  -1 if first frame.
@property (nonatomic, readonly) double overlapPercent;
/// Number of feature matches that survived ratio-test filtering.
/// Zero unless the frame went through feature matching (i.e.
/// passed the pose-delta gate).
@property (nonatomic, readonly) NSInteger matchCount;
/// Fraction of matches that survived RANSAC inlier filtering.
/// Range [0, 1].  Zero unless the frame went through RANSAC.
@property (nonatomic, readonly) double inlierRatio;
/// Composite confidence score [0, 1].
@property (nonatomic, readonly) double confidence;
/// Wall-clock milliseconds the addFrame call took (end-to-end).
@property (nonatomic, readonly) double processingMs;
/// V12.12 — physical device orientation as detected by the engine
/// from `R_panToCam` at first frame.  TRUE for landscape capture
/// (vertical pan), FALSE for portrait capture (horizontal pan).
/// Stays at the FIRST-FRAME determination for the rest of the
/// capture (orientation can't physically change without restarting
/// pano).  Defaults to FALSE (portrait) before first frame.
///
/// JS side reads this from `IncrementalState.isLandscape` to drive
/// orientation-aware UI (band overlay, dim bars).  This is the
/// single source of truth for orientation across the SDK + host —
/// the V12.6 fix established that JS-side orientation hooks are
/// unreliable under iOS interface-orientation lock; pose detection
/// is.
@property (nonatomic, readonly) BOOL isLandscape;

/// V12.14.9 — running max paint position along the pan axis, in
/// canvas pixels.  In landscape mode (`isLandscape == TRUE`) this
/// is the canvas Y at which the most-recently-pasted slit ends;
/// in portrait mode (`isLandscape == FALSE` = portrait+horizontal-pan
/// per the two-mode spec) this is the canvas X.  Zero before
/// first frame is accepted.  JS-side band overlay computes
/// `fillRatio = paintedExtent / panExtent` to size the thumb.
@property (nonatomic, readonly) NSInteger paintedExtent;

/// V12.14.9 — total pan-axis extent of the canvas (the engine's
/// `_canvasPanExtent` config value, default 5000).  Constant for
/// the lifetime of a capture.  Emitted on every telemetry frame
/// for symmetry with `paintedExtent`; JS uses the ratio.
@property (nonatomic, readonly) NSInteger panExtent;
@end


/// Snapshot of the current panorama canvas.  Returned by `snapshot`.
@interface RLISSnapshot : NSObject
/// Path to the JPEG written for this snapshot.  Lives in
/// `NSTemporaryDirectory()` and is overwritten on each snapshot —
/// the host is expected to consume it before requesting the next.
@property (nonatomic, copy, readonly) NSString *panoramaPath;
@property (nonatomic, readonly) NSInteger width;
@property (nonatomic, readonly) NSInteger height;
@property (nonatomic, readonly) NSInteger acceptedCount;
@end


@interface OpenCVIncrementalStitcher : NSObject

/// Initialise an engine ready to accept frames at the given compose
/// resolution.  `composeWidth` and `composeHeight` are the dimensions
/// each ingested ARFrame is scaled to before feature extraction —
/// 720p (1280×720 landscape) is the design-doc default.  Smaller =
/// faster + less memory at the cost of feature density.
///
/// `canvasWidth` and `canvasHeight` size the pre-allocated panorama
/// canvas (CV_8UC3).  Pick generously to avoid clipping long pans.
/// Defaults if 0/0 passed: 4800×1600 (≈23 MB).  The first accepted
/// frame is placed in the canvas centre so growth in either pan
/// direction is symmetric.
- (instancetype)initWithComposeWidth:(NSInteger)composeWidth
                       composeHeight:(NSInteger)composeHeight
                         canvasWidth:(NSInteger)canvasWidth
                        canvasHeight:(NSInteger)canvasHeight
                         featherPx:(NSInteger)featherPx
              frameRotationDegrees:(NSInteger)frameRotationDegrees NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// Try to incorporate `pixelBuffer` into the running panorama.
///
/// V6 (pose-driven): the engine builds the warp homography
/// `H = T · K · M · R_first⁻¹ · R_new · M · K⁻¹` directly from the
/// ARKit camera quaternion and intrinsics passed alongside the
/// frame.  No feature extraction, no matching, no RANSAC — the
/// alignment is geometrically exact for the rotational pans that
/// dominate handheld panoramas.  `M = diag(1, -1, -1)` converts
/// ARKit's (Y-up, -Z forward) camera frame to OpenCV's standard
/// (Y-down, +Z forward) frame.
///
/// Pose-delta gating still uses (yaw, pitch, fov*Degrees) to skip
/// frames outside the overlap window before any warp work runs.
///
/// `trackingPoor` should be YES when the AR session reports
/// non-tracking state at the time of this frame; the engine then
/// skips immediately with `RLISFrameOutcomeSkippedTrackingPoor`.
- (RLISFrameTelemetry *)ingestPixelBuffer:(CVPixelBufferRef)pixelBuffer
                                       qx:(double)qx
                                       qy:(double)qy
                                       qz:(double)qz
                                       qw:(double)qw
                                       tx:(double)tx
                                       ty:(double)ty
                                       tz:(double)tz
                                       fx:(double)fx
                                       fy:(double)fy
                                       cx:(double)cx
                                       cy:(double)cy
                              imageWidth:(NSInteger)imageWidth
                             imageHeight:(NSInteger)imageHeight
                                      yaw:(double)yaw
                                    pitch:(double)pitch
                          fovHorizDegrees:(double)fovHorizDegrees
                           fovVertDegrees:(double)fovVertDegrees
                             trackingPoor:(BOOL)trackingPoor
    NS_SWIFT_NAME(ingest(pixelBuffer:qx:qy:qz:qw:tx:ty:tz:fx:fy:cx:cy:imageWidth:imageHeight:yaw:pitch:fovHorizDegrees:fovVertDegrees:trackingPoor:));

/// Snapshot the current panorama as a JPEG (overwriting any previous
/// snapshot file).  Cheap enough to call after each accepted frame
/// for live-preview UX.  Returns nil with `error` populated if the
/// snapshot failed (disk full, permission, etc.).
- (nullable RLISSnapshot *)snapshotWithJpegQuality:(NSInteger)quality
                                              error:(NSError **)error;

/// Final write at end of capture — same shape as `snapshot` but
/// written to `outputPath` (caller-controlled location).  Includes
/// a tight crop to the actual panorama bounds (no trailing canvas
/// black).  After this call, the canvas is reset; the engine is
/// ready for a fresh capture without re-init.
- (nullable RLISSnapshot *)finalizeAtPath:(NSString *)outputPath
                              jpegQuality:(NSInteger)quality
                                    error:(NSError **)error;

/// Reset state so the engine can begin a new capture.  Called
/// automatically by `finalizeAtPath:` and on construction.
- (void)reset;

/// Frames accepted into the panorama since `reset`.  Read-only;
/// monotonically increasing within a capture.
@property (nonatomic, readonly) NSInteger acceptedCount;

@end

NS_ASSUME_NONNULL_END
