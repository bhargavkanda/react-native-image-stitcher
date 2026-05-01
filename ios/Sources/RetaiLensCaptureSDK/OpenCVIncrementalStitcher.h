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
                         featherPx:(NSInteger)featherPx NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// Try to incorporate `pixelBuffer` into the running panorama.  Pose
/// inputs (`yaw`, `pitch` in radians, `fovHorizDegrees`) drive the
/// pose-delta gating step — frames whose overlap with the previous
/// accepted frame falls outside the [minOverlapPct, maxOverlapPct]
/// window are skipped before any expensive feature work runs.
///
/// `trackingPoor` should be YES when the AR session reports
/// non-tracking state at the time of this frame; the engine then
/// skips immediately with `RLISFrameOutcomeSkippedTrackingPoor`.
///
/// Returns telemetry describing what happened.  Pixel-buffer access
/// is locked + unlocked internally; caller does not need to lock.
///
/// `NS_SWIFT_NAME` is set so Swift sees a stable selector name; the
/// importer would otherwise strip "PixelBuffer" because it considers
/// the parameter type redundant with the method name, leading to
/// compile errors on the Swift side referring to a renamed selector.
- (RLISFrameTelemetry *)ingestPixelBuffer:(CVPixelBufferRef)pixelBuffer
                                      yaw:(double)yaw
                                    pitch:(double)pitch
                          fovHorizDegrees:(double)fovHorizDegrees
                             trackingPoor:(BOOL)trackingPoor
    NS_SWIFT_NAME(ingest(pixelBuffer:yaw:pitch:fovHorizDegrees:trackingPoor:));

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
