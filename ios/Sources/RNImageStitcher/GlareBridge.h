// SPDX-License-Identifier: Apache-2.0
//
// GlareBridge.h — Obj-C interface exposing the shared C++ glare
// detector (cpp/glare.{hpp,cpp}) to Swift.
//
// Why this exists (same posture as KeyframeGateBridge.h):
//   The glare score is computed by the cross-platform C++
//   `retailens::computeGlareScore` so iOS and Android measure
//   veiling-reflection glare identically.  Swift cannot `#import`
//   the C++ header (`glare.hpp` forward-declares `cv::Mat`, and the
//   pod's umbrella module is compiled in a pure-Obj-C context under
//   `use_frameworks!` — it chokes on any C++ token).  This thin
//   Obj-C++ shim does the cv::imread + the C++ call in its `.mm`
//   translation unit and exposes ONLY plain Obj-C types here, so the
//   header is safe to pull into the public umbrella and reach Swift.
//
// Keep this header PURE Obj-C: no `cv::`, no `#import "glare.hpp"`.
// All C++ lives in GlareBridge.mm.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Thin Obj-C wrapper around `retailens::computeGlareScore`.
///
/// V1 measures glare over the C++ central-box ROI fallback (no ROI is
/// passed), matching the QualityChecker blur/brightness path which
/// also scores the whole decoded frame.
NS_SWIFT_NAME(GlareBridge)
@interface GlareBridge : NSObject

/// Decode the image at `path` (a filesystem path or a `file://` URL —
/// the scheme is stripped internally, mirroring the other bridges and
/// QualityChecker.decodeImage) and return its veiling-glare score.
///
/// @return mean dark-channel over the central product region, on a
///         0..255 scale (higher = more glare).  Returns 0.0 if the
///         file is missing or cannot be decoded (same "unusable input
///         → 0.0" contract as `retailens::computeGlareScore`).
+ (double)glareScoreForImageAtPath:(NSString *)path
    NS_SWIFT_NAME(glareScore(forImageAtPath:));

@end

NS_ASSUME_NONNULL_END
