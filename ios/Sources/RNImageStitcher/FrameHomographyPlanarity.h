// SPDX-License-Identifier: Apache-2.0
//
// FrameHomographyPlanarity.h — Obj-C interface exposing the shared
// OpenCV scene-liveness "planarity" primitive (real shelf vs.
// photo-of-a-screen) to Swift and, through the public umbrella, to
// the camera-sdk's frame-processor worklet bridge.
//
// Why this exists (same posture as GlareBridge.h / KeyframeGateBridge.h):
//   The planarity score is computed with OpenCV (ORB feature matching
//   + RANSAC homography inlier fraction).  Swift cannot import any C++
//   token, and the pod's umbrella module is compiled in a pure-Obj-C
//   context under `use_frameworks!` (as RetaiLens does) — it chokes on
//   any C++ token.  This thin Obj-C class confines ALL OpenCV (the Mat,
//   ORB, BFMatcher and findHomography machinery) to its `.mm`
//   translation unit and exposes ONLY plain Obj-C types here, so the
//   header is safe to pull into the public umbrella and reach both
//   Swift and the camera-sdk.
//
// Keep this header PURE Obj-C: zero C++ tokens, no OpenCV imports.
// All OpenCV lives in FrameHomographyPlanarity.mm.
//
// ── Algorithm (ported from scene_liveness_validate.py) ───────────
//   For each consecutive frame PAIR with enough camera motion:
//     * ORB(1200) detect+compute on each (downscaled) luma frame.
//     * BFMatcher(NORM_HAMMING, crossCheck=true) match descriptors.
//     * Require >= 30 matches.
//     * flow = median match displacement (px, in the downscaled
//       coordinate space).
//     * findHomography(RANSAC, reproj = 2.5 px); planarity for the
//       pair = inlier mask.mean() (the H-inlier fraction).
//   The per-pair planarity values accumulate in a ring buffer; the
//   reported metric is their ROBUST MEDIAN (np.median parity).
//
// ── Verdict direction (documented here, APPLIED later in JS) ─────
//   planarityMedian HIGH (~>= 0.9)  ⇒ flat plane fits everything ⇒
//                                     SCREEN (presentation attack).
//   planarityMedian LOWER           ⇒ parallax breaks the single-
//                                     homography fit ⇒ REAL shelf.
//
// ── Gyro + flow gate (CRITICAL to correctness) ──────────────────
//   A pair is COUNTED toward planarity ONLY when BOTH:
//     * rotationRateRadPerSec < ~0.35  (low rotation ⇒ any image
//       flow is translation-driven ⇒ parallax is meaningful), AND
//     * median match flow >= 2.0 px    (enough baseline to expose
//       parallax; near-static pairs carry no signal).
//   High-rotation pairs are SKIPPED (counted in `rotationSkipped`,
//   never pushed) because pure/strong rotation fits a homography for
//   ANY scene — a real shelf panned quickly would otherwise
//   false-read as a flat screen.
//
// ── Process-wide singleton ──────────────────────────────────────
//   The camera-sdk frame-processor (WRITER, calls processLumaPlane:)
//   and the RN bridge (READER, calls getMetrics) live in different
//   translation units but must share ONE accumulator.  Hence a
//   `sharedInstance` singleton.  All internal state is native and
//   NSLock-guarded; nothing here ever runs inside a worklet.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Process-wide accumulator for the scene-liveness planarity signal.
///
/// Thread-safety: all methods are safe to call from any thread; the
/// instance serialises with an internal NSLock.  Typical wiring:
///   * WRITER — the camera frame-processor calls
///     `processLumaPlane:width:height:bytesPerRow:rotationRateRadPerSec:`
///     once per frame on the camera producer thread.
///   * READER — the RN bridge calls `getMetrics` on the JS/main
///     thread to surface the current robust-median planarity.
///
/// `processLumaPlane:` does NOT retain the pixel buffer: it reads the
/// luma plane into an OpenCV matrix (confined to the .mm), downscales,
/// runs ORB, and stores only the resulting keypoints+descriptors as new
/// "previous" frame.  The caller may recycle the buffer immediately
/// after the call returns.
NS_SWIFT_NAME(FrameHomographyPlanarity)
@interface FrameHomographyPlanarity : NSObject

/// The shared, process-wide accumulator.  The camera-sdk writer and
/// the RN reader MUST use this same instance so the ring buffer is one
/// shared accumulator (see header rationale).
+ (instancetype)sharedInstance;

/// Enable/disable processing.  When disabled, `processLumaPlane:…` is
/// a no-op (returns immediately without touching ORB or the ring
/// buffer).  Disabled is the default until a consumer opts in.
- (void)setEnabled:(BOOL)enabled;

/// Ingest one luma (grayscale, 8-bit single-channel) plane.
///
/// No-op when disabled.  Otherwise:
///   1. Wraps `base` (stride `bytesPerRow`) as an 8UC1 image — no copy.
///   2. Downscales ~0.5 (INTER_AREA) and runs ORB(1200) (restricted to
///      the optional normalized ROI via a mask, if set).
///   3. If a previous frame's keypoints exist AND both frames have
///      >= 30 keypoints: BFMatcher(NORM_HAMMING, crossCheck) match,
///      median match flow, then the gyro+flow gate.  When the pair is
///      counted, findHomography(RANSAC, 2.5) → push inlier mask.mean()
///      into the ring buffer.
///   4. Always stores the current frame's keypoints+descriptors as the
///      new "previous" (textureless / too-few-matches frames simply
///      update prev without contributing a verdict — graceful, never a
///      false reading).
///
/// @param base   pointer to the first byte of the luma plane.
/// @param w      plane width in pixels.
/// @param h      plane height in pixels.
/// @param bpr    bytes per row (row stride; may exceed `w`).
/// @param rot    instantaneous device rotation rate, radians/second
///               (magnitude). Used by the gyro gate (< ~0.35 to count).
- (void)processLumaPlane:(const uint8_t *)base
                   width:(NSInteger)w
                  height:(NSInteger)h
             bytesPerRow:(NSInteger)bpr
   rotationRateRadPerSec:(double)rot;

/// Snapshot of the current accumulator state.  Keys (all NSNumber):
///   * @"ready"            — BOOL: pairsUsed >= 4 (enough to trust the
///                           median).
///   * @"pairsUsed"        — Int: pairs that PASSED the gate and were
///                           pushed into the ring buffer (capped at the
///                           ring capacity).
///   * @"planarityMedian"  — Double: robust median (np.median parity)
///                           of the ring buffer; 0.0 when empty.
///   * @"lastFlowPx"       — Double: median match flow (px, downscaled
///                           space) of the most recent matched pair.
///   * @"framesSeen"       — Int: total frames processed while enabled.
///   * @"rotationSkipped"  — Int: pairs skipped because rotation was
///                           too high to trust planarity.
- (NSDictionary *)getMetrics;

/// Clear all accumulated state: ring buffer, counters, and the stored
/// previous frame.  Does NOT change the enabled flag or the ROI.
- (void)reset;

/// Restrict ORB detection to a normalized box (all components in
/// 0..1, relative to the FULL-resolution frame; the box is scaled with
/// the internal downscale).  Out-of-range / degenerate boxes are
/// clamped/ignored.  Use to focus the liveness test on the shelf
/// region and exclude static framing furniture.
- (void)setROIWithX:(double)x y:(double)y width:(double)w height:(double)h
    NS_SWIFT_NAME(setROI(x:y:width:height:));

/// Remove any ROI restriction; ORB runs over the whole frame.
- (void)clearROI;

@end

NS_ASSUME_NONNULL_END
