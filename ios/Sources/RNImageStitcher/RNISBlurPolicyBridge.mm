// SPDX-License-Identifier: Apache-2.0
//
// RNISBlurPolicyBridge.mm — see RNISBlurPolicyBridge.h.

#import "RNISBlurPolicyBridge.h"

#include <memory>

#include "blur_policy.hpp"

// Pin the Obj-C enum raw values to the C++ enum so a re-ordering on
// either side is a compile error, not a silent behaviour change.
static_assert((NSInteger)RNISBlurAdmissionCommit ==
              (NSInteger)retailens::BlurAdmission::Commit, "");
static_assert((NSInteger)RNISBlurAdmissionHoldForMotion ==
              (NSInteger)retailens::BlurAdmission::HoldForMotion, "");
static_assert((NSInteger)RNISBlurAdmissionHoldForSoftness ==
              (NSInteger)retailens::BlurAdmission::HoldForSoftness, "");

@implementation RNISBlurPolicyBridge {
    retailens::BlurPolicyConfig _config;
    std::unique_ptr<retailens::RunningScoreMedian> _median;
}

- (instancetype)init {
    if (self = [super init]) {
        // Default-constructed config = every check OFF except the
        // forward-progress cap, so an engine that never calls
        // `configure…` behaves exactly as it did before this policy
        // existed.
        _config = retailens::BlurPolicyConfig();
        _median = std::make_unique<retailens::RunningScoreMedian>();
    }
    return self;
}

- (void)configureWithMaxCommitPanRate:(double)radPerSec
             minScoreFractionOfMedian:(double)fraction
                  maxConsecutiveHolds:(NSInteger)holds
{
    _config.maxCommitPanRateRadPerSec = radPerSec;
    _config.minScoreFractionOfMedian  = fraction;
    _config.maxConsecutiveHolds       = static_cast<int32_t>(holds);
}

- (BOOL)isEnabled {
    // maxConsecutiveHolds is deliberately NOT part of this test: it is
    // a safety CAP on the other two, never a reason to hold on its own.
    return (_config.maxCommitPanRateRadPerSec > 0.0 ||
            _config.minScoreFractionOfMedian > 0.0) ? YES : NO;
}

- (RNISBlurAdmission)admitWithCandidateScore:(double)candidateScore
                            panRateRadPerSec:(double)panRateRadPerSec
                            consecutiveHolds:(NSInteger)consecutiveHolds
{
    retailens::BlurAdmissionInput in;
    in.candidateScore     = candidateScore;
    in.sessionMedianScore = _median->median();
    in.panRateRadPerSec   = panRateRadPerSec;
    in.consecutiveHolds   = static_cast<int32_t>(consecutiveHolds);
    return static_cast<RNISBlurAdmission>(
        retailens::admitKeyframe(_config, in));
}

- (void)recordAcceptedScore:(double)score {
    _median->add(score);
}

- (double)sessionMedianScore {
    return _median->median();
}

- (void)resetHistory {
    _median->reset();
}

@end
