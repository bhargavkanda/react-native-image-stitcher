// SPDX-License-Identifier: Apache-2.0
//
// OpenCVStitcher.h
//
// Objective-C interface to the OpenCV stitcher.  All C++ types
// (`cv::Stitcher`, `cv::Mat`, `std::vector`) are confined to the
// implementation file (`.mm`) so this header can be imported from
// pure Swift without dragging in the C++ standard library.
//
// Why the layered design (ObjC interface ↔ ObjC++ impl ↔ C++ lib)?
//   The Swift importer does not understand C++.  Without this layer
//   we'd have to write a much heavier @objc shim using opaque void*
//   pointers.  Letting Objective-C own the boundary types gives us
//   automatic memory management for NSString/NSError/NSDictionary
//   and zero copy on the boundary — the .mm only does the C++→C++
//   work, never marshalling.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// NSError domain raised by OpenCVStitcher errors.  Codes match the
/// `cv::Stitcher::Status` enum values so callers can branch on
/// "needs more images" vs. "homography failed".
extern NSString *const RNImageStitcherErrorDomain;

/// Result of a successful stitch — pixel dimensions of the panorama
/// plus the path it was written to (host app passed it in).
@interface RNStitchResult : NSObject
@property (nonatomic, copy, readonly) NSString *outputPath;
@property (nonatomic, assign, readonly) NSInteger width;
@property (nonatomic, assign, readonly) NSInteger height;
@property (nonatomic, assign, readonly) double durationMs;
/// 2026-05-16 (Issue 5) — C+D progressive-confidence retry telemetry
/// sourced from `retailens::StitchResult`.  Surface in the JS finalize
/// dict so the host can render a debug toast on retry.
///
///   framesRequested:        number of keyframes handed to the stitcher
///   framesIncluded:         number retained after leaveBiggestComponent
///   finalConfidenceThresh:  threshold the successful attempt used
///                            (1.0 / 0.5 / 0.3); -1.0 when the
///                            retry path didn't run (rare error paths)
@property (nonatomic, assign, readonly) NSInteger framesRequested;
@property (nonatomic, assign, readonly) NSInteger framesIncluded;
@property (nonatomic, assign, readonly) double finalConfidenceThresh;
- (instancetype)initWithOutputPath:(NSString *)outputPath
                             width:(NSInteger)width
                            height:(NSInteger)height
                        durationMs:(double)durationMs
                   framesRequested:(NSInteger)framesRequested
                    framesIncluded:(NSInteger)framesIncluded
             finalConfidenceThresh:(double)finalConfidenceThresh NS_DESIGNATED_INITIALIZER;
/// Convenience initializer for paths that don't carry C+D retry
/// telemetry (e.g. stitchVideoAtPath / stitchKeyframePaths).  Sets
/// the telemetry fields to sentinel values (-1) so JS callers can
/// detect "no retry data available" cleanly.
- (instancetype)initWithOutputPath:(NSString *)outputPath
                             width:(NSInteger)width
                            height:(NSInteger)height
                        durationMs:(double)durationMs;
- (instancetype)init NS_UNAVAILABLE;
@end


@interface OpenCVStitcher : NSObject

/// Stitch the images at `framePaths` into a single panoramic JPEG
/// at `outputPath`.
///
/// `quality`: JPEG quality [0..100].  Caller-clamped; 0 / 101 will
/// be coerced into range by the impl.
///
/// On success returns the result object; on failure populates
/// `error` (NSError, RNImageStitcherErrorDomain) and returns nil.
/// `warperType`: one of @"plane" / @"cylindrical" / @"spherical".
///   Pass nil/empty for the default (@"plane").  Different
///   projections suit different gestures — see the field A/B
///   testing settings UI for guidance.
/// `blenderType`: one of @"multiband" / @"feather".  Pass nil for
///   the default (@"multiband").
/// `seamFinderType`: one of @"graphcut" / @"skip".  Pass nil for
///   the default (@"graphcut").
///   - "graphcut" runs cv::detail::GraphCutSeamFinder over all
///     warped frames before blending — produces clean seams,
///     pairs well with MultiBandBlender, but holds all warped
///     frames in memory simultaneously (higher peak).
///   - "skip" streams warp+feed in a single pass and never holds
///     more than one warped frame.  Lower peak memory.  Use on
///     low-RAM devices or for fastest path with FeatherBlender.
/// AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
///
///   - `captureOrientation` ("portrait" | "portrait-upside-down" |
///     "landscape-left" | "landscape-right"): physical phone hold at
///     capture start, sourced from the JS-side accelerometer hook.
///     Drives the OUTPUT panorama's bake-rotation per the two
///     supported capture modes:
///       portrait              → no bake-rotation
///       portrait-upside-down  → bake ROTATE_180
///       landscape-left        → bake ROTATE_90_COUNTERCLOCKWISE
///       landscape-right       → bake ROTATE_90_CLOCKWISE
///     Output JPEG is always written with EXIF=1 (no metadata
///     rotation) since the rotation is baked into the pixels.
///
///   - **Maximum-inscribed-rectangle crop** instead of bounding-
///     rectangle.  cv::Stitcher's output has irregular black corners
///     where the projection didn't fill; bbox crop still included
///     them.  With `useInscribedRectCrop:YES` we find the largest
///     axis-aligned rectangle entirely inside the non-zero region
///     and crop to that — clean output with no black corners.
+ (nullable RNStitchResult *)stitchFramePaths:(NSArray<NSString *> *)framePaths
                                          outputPath:(NSString *)outputPath
                                         jpegQuality:(NSInteger)quality
                                          warperType:(nullable NSString *)warperType
                                         blenderType:(nullable NSString *)blenderType
                                      seamFinderType:(nullable NSString *)seamFinderType
                                  captureOrientation:(nullable NSString *)captureOrientation
                                useInscribedRectCrop:(BOOL)useInscribedRectCrop
                                          stitchMode:(nullable NSString *)stitchMode
                                               error:(NSError **)error;

/// Extract `maxFrames` evenly-spaced frames from the video at
/// `videoPath`, write each as a JPEG into `outputDir`, return the
/// list of file paths in capture order.
///
/// Used as the first half of the panorama pipeline: the host app
/// records video while the user holds the shutter, then we sample
/// it down to N still frames the stitcher can consume.  cv::Stitcher
/// works best with 5-15 well-spaced frames — much more is redundant
/// and slow; much less risks gaps in the seam.
///
/// Implementation uses AVAssetImageGenerator (Foundation), not
/// OpenCV, so no C++ touches this path; cheap enough that we can
/// expose it as a separate primitive too.
+ (nullable NSArray<NSString *> *)extractFramesFromVideoAtPath:(NSString *)videoPath
                                                     outputDir:(NSString *)outputDir
                                                     maxFrames:(NSInteger)maxFrames
                                                   jpegQuality:(NSInteger)quality
                                                         error:(NSError **)error;

/// One-shot helper: extract frames from `videoPath`, stitch them
/// into a panorama at `outputPath`, delete the temporary frames,
/// return the result.  This is what the JS shutter-hold flow calls;
/// callers don't have to manage their own tmp directory or clean
/// up partial state on failure.
+ (nullable RNStitchResult *)stitchVideoAtPath:(NSString *)videoPath
                                           outputPath:(NSString *)outputPath
                                            maxFrames:(NSInteger)maxFrames
                                          jpegQuality:(NSInteger)quality
                                           warperType:(nullable NSString *)warperType
                                          blenderType:(nullable NSString *)blenderType
                                       seamFinderType:(nullable NSString *)seamFinderType
                                                error:(NSError **)error;

/// Phase 5: pose-driven stitch.  Same end-to-end shape as
/// `stitchVideoAtPath` but consumes pre-computed camera poses
/// (from ARKit/ARCore via RNSARSession) and skips the
/// brittle features → matching → BundleAdjuster steps.  Internally:
///
///   1. Extract maxFrames evenly-spaced frames from the video.
///   2. Compute each frame's timestamp (fraction × totalSeconds).
///   3. Match each frame to the nearest pose in `poses` (within
///      a 100 ms tolerance).
///   4. Build cv::detail::CameraParams directly from the pose's
///      quaternion + intrinsics — flips coordinate conventions
///      between ARKit (Y-up, -Z forward) and OpenCV (Y-down,
///      +Z forward).
///   5. Hand cameras to the existing warp + seam + blend pipeline.
///
/// `poses` is an NSArray of NSDictionary; each entry has the keys
/// matching `RNSARFramePose.asDictionary()`:
///   tx, ty, tz, qx, qy, qz, qw, fx, fy, cx, cy,
///   imageWidth, imageHeight, timestampMs, trackingState
/// Frames whose closest pose is missing or beyond tolerance fall
/// back to the feature-matched path frame-by-frame (degraded but
/// functional).  When ALL poses are missing the method returns
/// the same NSError code (1030) so the host can opt to retry via
/// the non-pose path.
+ (nullable RNStitchResult *)stitchVideoAtPath:(NSString *)videoPath
                                           outputPath:(NSString *)outputPath
                                            maxFrames:(NSInteger)maxFrames
                                          jpegQuality:(NSInteger)quality
                                           warperType:(nullable NSString *)warperType
                                          blenderType:(nullable NSString *)blenderType
                                       seamFinderType:(nullable NSString *)seamFinderType
                                                poses:(NSArray<NSDictionary *> *)poses
                                                error:(NSError **)error;

/// V16 Phase 1: pose-driven stitch over an explicit list of frame
/// paths.  Sibling of `stitchVideoAtPath:withPoses:` — same compose
/// stage, but the caller supplies frames as already-on-disk JPEGs
/// + a 1:1 pose array, so the video extraction + timestamp matching
/// steps are skipped entirely.
///
/// This is the hot path for the "batch-on-AR-keyframes" flow: the
/// Swift `KeyframeGate` accepts ≤6 frames per capture, each saved
/// to disk with a known pose; on shutter release we feed those
/// straight into the same `BundleAdjuster + GraphCutSeamFinder +
/// MultiBandBlender` pipeline that the video-driven path uses.
///
/// `framePaths.count` MUST equal `poses.count` (1:1 mapping; any
/// downstream filtering happens inside this method).  `framePaths`
/// must be at least 2 entries.  Pose dictionaries follow the same
/// shape as `RNSARFramePose.asDictionary()`.
+ (nullable RNStitchResult *)stitchKeyframePaths:(NSArray<NSString *> *)framePaths
                                            outputPath:(NSString *)outputPath
                                           jpegQuality:(NSInteger)quality
                                            warperType:(nullable NSString *)warperType
                                           blenderType:(nullable NSString *)blenderType
                                        seamFinderType:(nullable NSString *)seamFinderType
                                                 poses:(NSArray<NSDictionary *> *)poses
                                                 error:(NSError **)error;

/// Normalise the EXIF orientation of `imagePath` in place.
///
/// vision-camera writes photos with the camera-sensor's native
/// landscape pixels and an EXIF Orientation tag describing how to
/// rotate them for display.  Most consumers (iOS UIImage, RN's
/// <Image>) honour the tag, but Sentry breadcrumbs, share sheets,
/// downstream image-manipulation libs, and the cv::Stitcher all
/// read raw pixels and end up sideways.
///
/// This method round-trips the file through cv::imread (which
/// honours EXIF and gives us the post-rotation pixel buffer) and
/// cv::imwrite (which writes a plain JPEG with NO EXIF), so the
/// saved file ends up with rotation baked into pixels and no
/// orientation metadata.  Idempotent on already-normalised images.
///
/// Returns `@{ @"width": NSNumber, @"height": NSNumber }` post
/// rotation so the caller can update its CaptureResult dimensions
/// to match what's now on disk.  NSDictionary is used (rather than
/// CGSize) because Swift can't translate `(CGSize) + (NSError**)`
/// into a throwing API — a nullable reference type is required.
+ (nullable NSDictionary<NSString *, NSNumber *> *)normaliseImageAtPath:(NSString *)imagePath
                                                                  error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
