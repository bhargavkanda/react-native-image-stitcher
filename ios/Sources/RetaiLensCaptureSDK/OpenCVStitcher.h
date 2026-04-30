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
extern NSString *const RetaiLensStitcherErrorDomain;

/// Result of a successful stitch — pixel dimensions of the panorama
/// plus the path it was written to (host app passed it in).
@interface RetaiLensStitchResult : NSObject
@property (nonatomic, copy, readonly) NSString *outputPath;
@property (nonatomic, assign, readonly) NSInteger width;
@property (nonatomic, assign, readonly) NSInteger height;
@property (nonatomic, assign, readonly) double durationMs;
- (instancetype)initWithOutputPath:(NSString *)outputPath
                             width:(NSInteger)width
                            height:(NSInteger)height
                        durationMs:(double)durationMs NS_DESIGNATED_INITIALIZER;
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
/// `error` (NSError, RetaiLensStitcherErrorDomain) and returns nil.
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
+ (nullable RetaiLensStitchResult *)stitchFramePaths:(NSArray<NSString *> *)framePaths
                                          outputPath:(NSString *)outputPath
                                         jpegQuality:(NSInteger)quality
                                          warperType:(nullable NSString *)warperType
                                         blenderType:(nullable NSString *)blenderType
                                      seamFinderType:(nullable NSString *)seamFinderType
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
+ (nullable RetaiLensStitchResult *)stitchVideoAtPath:(NSString *)videoPath
                                           outputPath:(NSString *)outputPath
                                            maxFrames:(NSInteger)maxFrames
                                          jpegQuality:(NSInteger)quality
                                           warperType:(nullable NSString *)warperType
                                          blenderType:(nullable NSString *)blenderType
                                       seamFinderType:(nullable NSString *)seamFinderType
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
