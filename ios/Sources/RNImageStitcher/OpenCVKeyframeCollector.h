// SPDX-License-Identifier: Apache-2.0
//
// OpenCVKeyframeCollector — V16 Phase 1 helper that accumulates the
// AR-keyframe-gate's accepted CVPixelBuffers as on-disk JPEGs while
// the user pans, then hands the path list off to OpenCVStitcher's
// `stitchFramePaths:` on shutter release.
//
// Why a separate class:
//   - CVPixelBuffer → cv::Mat → cv::imwrite has to live in ObjC++ /
//     OpenCV-aware code.  IncrementalStitcher.swift can't
//     call it directly.
//   - The frame collection state (session dir, accepted-frame
//     counter) is small and capture-scoped; isolating it from the
//     much larger OpenCVStitcher class file keeps the surface
//     small.
//   - When KLT/multi-band incremental work lands later (Phase 3 LHF
//     #2), this collector becomes the natural seam between the
//     "frames are arriving live" path and the "stitch them now"
//     path; centralising it now pays back later.

#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>

NS_ASSUME_NONNULL_BEGIN

/// Each saved keyframe ends up with a JPEG path + the index it was
/// saved at + the on-disk size.  Returned from `saveKeyframe:…` so
/// the host can build the path/pose list for `stitchFramePaths:`.
@interface OpenCVKeyframeRecord : NSObject
@property (nonatomic, copy, readonly) NSString *path;
@property (nonatomic, assign, readonly) NSInteger index;
@property (nonatomic, assign, readonly) NSInteger width;
@property (nonatomic, assign, readonly) NSInteger height;
- (instancetype)initWithPath:(NSString *)path
                       index:(NSInteger)index
                       width:(NSInteger)width
                      height:(NSInteger)height NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;
@end


@interface OpenCVKeyframeCollector : NSObject

/// Active session directory under
/// `Library/AppSupport/Captures/{capture-uuid}/`.  Persisted (NOT
/// NSTemporaryDirectory) so the operator / debug menu can re-process
/// captures later.  Caller is responsible for `cleanup` when no
/// longer needed.
@property (nonatomic, copy, readonly) NSString *sessionDir;

/// Total keyframes saved so far.
@property (nonatomic, assign, readonly) NSInteger acceptedCount;

/// Create a new collector with a freshly-minted session directory
/// under `Library/AppSupport/Captures/{NSUUID}/`.  Returns nil if
/// the directory couldn't be created (out-of-space etc.) and
/// populates `error`.  Imported into Swift as
/// `try OpenCVKeyframeCollector()`.
- (nullable instancetype)initWithError:(NSError **)error NS_DESIGNATED_INITIALIZER;
/// Plain `init` is forwarded to `initWithError:` with a discarded
/// error so Swift's `try Type()` translation works without colliding
/// with NS_UNAVAILABLE machinery.  Don't call from ObjC — use the
/// throwing initializer.
- (nullable instancetype)init;

/// Save one accepted ARFrame's pixel buffer as a JPEG inside the
/// session directory.  Filename is `keyframe-{index zero-padded}.jpg`.
/// Pixel buffer format must be NV12 (the ARFrame default) or BGRA;
/// other formats fail with NSError code 1200.
///
/// `rotationDegrees`: 0/90/180/270.  The buffer is PHYSICALLY
/// rotated by this amount before encoding.  Use 0 for batch-keyframe
/// (the stitcher's intrinsics describe the unrotated landscape
/// sensor; rotating breaks the camera-K-matrix contract).
///
/// `exifOrientation`: standard EXIF Orientation tag value (1..8).
///   1 = no rotation; 6 = 90° CW for display; 3 = 180°; 8 = 90° CCW.
/// Saved as JPEG metadata via ImageIO.  iOS Image renderers (RN's
/// `<Image>`, Files.app, Photos) honour this and display the photo
/// rotated for natural viewing.  cv::imread (when called with
/// IMREAD_IGNORE_ORIENTATION) returns raw landscape pixels — match
/// for the stitcher's intrinsics.
- (nullable OpenCVKeyframeRecord *)saveKeyframe:(CVPixelBufferRef)pixelBuffer
                                rotationDegrees:(NSInteger)rotationDegrees
                                exifOrientation:(NSInteger)exifOrientation
                                    jpegQuality:(NSInteger)jpegQuality
                                          error:(NSError **)error;

/// Remove the session directory and any saved keyframes.  Idempotent.
/// Called from IncrementalStitcher's `cancel` / on
/// successful finalize when the operator hasn't opted into
/// "keep-for-reprocess" mode.
- (void)cleanup;

@end

NS_ASSUME_NONNULL_END
