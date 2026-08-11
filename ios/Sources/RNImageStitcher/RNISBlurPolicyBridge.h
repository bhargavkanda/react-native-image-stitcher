// SPDX-License-Identifier: Apache-2.0
//
// RNISBlurPolicyBridge.h — Obj-C facade over the shared C++ anti-blur
// ADMISSION policy (cpp/blur_policy.{hpp,cpp}).
//
// Same bridge pattern as SharpnessWindowBridge: Swift can't touch the
// C++ free function / class directly, so this thin wrapper owns the
// POD config plus the running-score median and exposes the single call
// the engine makes per ready-to-commit keyframe.  Every threshold,
// precedence rule and fail-open case lives in the shared C++ so iOS and
// Android cannot drift (gtest-covered in cpp/tests/).
//
// How it composes with the sharpness window: the window answers "which
// of these K frames is sharpest" — a purely RELATIVE choice that has
// nothing better to offer when a steady pan smears all of them.  This
// policy answers the question the window structurally cannot: "should
// ANY of them be committed yet".  The engine consults it AFTER the
// window picks its best and BEFORE that best is saved.
//
// FAIL-OPEN is inherited from the C++: disabled knobs, an unknown
// median and an unknown pan rate all yield Commit, and the
// consecutive-hold cap guarantees forward progress.  A misfire must
// cost a soft keyframe, never a capture that cannot finish.
//
// Threading: NOT thread-safe (the C++ median is plain state, exactly
// like SharpnessWindowMachine).  The engine serialises every call under
// its stateLock.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// 1:1 with retailens::BlurAdmission — static_asserts in the .mm pin
/// the raw values against the C++ enum.
typedef NS_ENUM(NSInteger, RNISBlurAdmission) {
    /// Commit the candidate (the default and the fail-open answer).
    RNISBlurAdmissionCommit          = 0,
    /// Device slewing too fast — hold the window open, keep scoring.
    RNISBlurAdmissionHoldForMotion   = 1,
    /// Candidate anomalously soft for this session — same semantics,
    /// distinct value so hosts can coach "hold steady" vs "slow down".
    RNISBlurAdmissionHoldForSoftness = 2,
};

@interface RNISBlurPolicyBridge : NSObject

/// Install this capture's tunables (mirrors retailens::BlurPolicyConfig).
/// Any value <= 0 DISABLES its check.  Called once per start(); the
/// score history is independent (see `resetHistory`).
- (void)configureWithMaxCommitPanRate:(double)radPerSec
             minScoreFractionOfMedian:(double)fraction
                  maxConsecutiveHolds:(NSInteger)holds;

/// YES when at least one HOLD-producing knob is on.  The engine reads
/// this before doing anything else so a default-configured capture pays
/// nothing: no median bookkeeping, no pan-rate maths, no admission call.
- (BOOL)isEnabled;

/// One admission decision for the candidate about to be committed.
/// `panRateRadPerSec` < 0 means UNKNOWN (skips the motion gate).  The
/// session median is this object's own running median, so callers can't
/// feed the policy a reference the history doesn't support.
- (RNISBlurAdmission)admitWithCandidateScore:(double)candidateScore
                            panRateRadPerSec:(double)panRateRadPerSec
                            consecutiveHolds:(NSInteger)consecutiveHolds;

/// Record an ACCEPTED keyframe's sharpness score.  Non-positive scores
/// are dropped by the C++ (they'd drag the median toward zero and
/// weaken the very floor they feed).
- (void)recordAcceptedScore:(double)score;

/// Running median of the accepted scores; 0.0 = no history yet, the
/// documented "unknown" sentinel that fails the floor open.  Exposed
/// for diagnostics — `admit…` reads it internally.
- (double)sessionMedianScore;

/// Start/cancel of a capture: drop the score history.  The config
/// survives (start() re-installs it anyway); the history must not,
/// because it describes a scene that is over.
- (void)resetHistory;

@end

NS_ASSUME_NONNULL_END
