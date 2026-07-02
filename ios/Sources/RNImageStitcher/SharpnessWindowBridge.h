// SPDX-License-Identifier: Apache-2.0
//
// SharpnessWindowBridge.h — Obj-C facade over the shared C++
// retailens::SharpnessWindowMachine (cpp/sharpness_window.{hpp,cpp}),
// the pick-sharpest-in-window DECISION machine.
//
// Same bridge pattern as KeyframeGateBridge: Swift can't touch the
// C++ class directly, so this thin wrapper exposes the per-event
// ingest + lifecycle calls.  ALL window decisions (open / replace /
// keep / close / flush-then-open, including the overlap-drift guard)
// live in the C++ machine so iOS and Android cannot drift — the Swift
// side only buffers pixels and acts on the returned action.
//
// Threading: NOT thread-safe (mirrors the C++ class).  The engine
// serialises every call under its stateLock.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// 1:1 with retailens::SharpnessWindowAction — static_asserts in the
/// .mm pin the raw values against the C++ enum.
typedef NS_ENUM(NSInteger, RNISSharpnessWindowAction) {
    RNISSharpnessWindowActionNone            = 0,
    RNISSharpnessWindowActionSaveImmediately = 1,
    RNISSharpnessWindowActionOpenWindow      = 2,
    RNISSharpnessWindowActionFlushThenOpen   = 3,
    RNISSharpnessWindowActionReplaceBest     = 4,
    RNISSharpnessWindowActionKeepBest        = 5,
    RNISSharpnessWindowActionCloseAndSave    = 6,
};

@interface RNISSharpnessWindowBridge : NSObject

/// Reconfigure K (total candidates per accepted keyframe) between
/// captures.  Resets any open window.  Clamped to >= 1 by the C++.
- (void)setWindowSize:(NSInteger)k;
- (NSInteger)windowSize;

/// Feed one gate-evaluated frame; returns the action the engine must
/// take.  Out-params (both optional):
///   replaceBestOut — THIS frame must become the buffered best
///                    (buffer + pose) before acting on the action.
///   driftClosedOut — a CloseAndSave was triggered by the overlap-
///                    drift guard (novelty > overlapThreshold / 2)
///                    rather than slot exhaustion.
- (RNISSharpnessWindowAction)ingestWithAccept:(BOOL)isAccept
                                        score:(double)score
                              noveltyFraction:(double)noveltyFraction
                             overlapThreshold:(double)overlapThreshold
                                  replaceBest:(nullable BOOL *)replaceBestOut
                                  driftClosed:(nullable BOOL *)driftClosedOut;

/// Finalize-time flush: closes any open window.  YES = a best
/// candidate is pending and MUST be saved (the trailing keyframe).
- (BOOL)drain;

/// Cancel / start: discard any open window.
- (void)reset;

- (BOOL)isOpen;
/// Best score of the current window; sticky after close until reset.
- (double)bestScore;

@end

NS_ASSUME_NONNULL_END
