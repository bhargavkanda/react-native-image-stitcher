// SPDX-License-Identifier: Apache-2.0
//
// GlareBridge.mm — Obj-C++ glue between Swift and the shared C++
// glare detector.  See GlareBridge.h for design rationale.

// OpenCV's headers contain `enum { NO, ... }` / `enum { YES, ... }`
// which collide with Obj-C's `NO`/`YES` macros (defined transitively
// by <objc/objc.h>).  Undef both BEFORE importing opencv2/*, then
// restore them.  Same standard pattern as OpenCVStitcher.mm.
#ifdef NO
#undef NO
#endif
#ifdef YES
#undef YES
#endif

#import <opencv2/core.hpp>
#import <opencv2/imgcodecs.hpp>

// Restore the Obj-C boolean macros now that OpenCV is parsed.
#define NO  ((BOOL)0)
#define YES ((BOOL)1)

#import "GlareBridge.h"
// Shared C++ glare detector.  Resolves via the pod's HEADER_SEARCH_PATHS
// entry `${PODS_TARGET_SRCROOT}/cpp` (see RNImageStitcher.podspec) — the
// same mechanism KeyframeGateBridge.mm uses for keyframe_gate.hpp.
#import "glare.hpp"

#import <string>

@implementation GlareBridge

+ (double)glareScoreForImageAtPath:(NSString *)path {
    if (path == nil) {
        return 0.0;
    }

    // Strip the `file://` scheme some callers attach so cv::imread can
    // open the raw filesystem path (cv::imread takes a path, not a URL).
    // Mirrors normalizeImagePath() in OpenCVStitcher.mm and the
    // file:// strip in QualityChecker.decodeImage.
    NSString *cleaned = path;
    if ([cleaned hasPrefix:@"file://"]) {
        cleaned = [cleaned substringFromIndex:[@"file://" length]];
    }

    const char *utf8 = cleaned.UTF8String;
    if (utf8 == NULL) {
        return 0.0;
    }
    std::string stdPath(utf8);

    // COLOUR (BGR, CV_8UC3) is required by computeGlareScore for the
    // per-channel-min that makes the score glare-specific.
    cv::Mat img = cv::imread(stdPath, cv::IMREAD_COLOR);
    if (img.empty()) {
        // Missing / undecodable file → unusable input.  Matches the
        // C++ contract (empty Mat → 0.0); QualityChecker's vImage path
        // raises its own decode error separately, so here we just
        // return the neutral score.
        return 0.0;
    }

    // V1: default ROI (central-box fallback) — pass no roi.
    return retailens::computeGlareScore(img);
}

@end
