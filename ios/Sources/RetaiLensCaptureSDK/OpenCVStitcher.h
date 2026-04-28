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
+ (nullable RetaiLensStitchResult *)stitchFramePaths:(NSArray<NSString *> *)framePaths
                                          outputPath:(NSString *)outputPath
                                         jpegQuality:(NSInteger)quality
                                               error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
