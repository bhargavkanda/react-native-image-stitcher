// SPDX-License-Identifier: Apache-2.0
//
// RNISBlurPolicyBridge.mm — see RNISBlurPolicyBridge.h.

#import "RNISBlurPolicyBridge.h"

#include <memory>

#include "blur_policy.hpp"

// Pin the Obj-C enum raw values to the C++ enum so a re-ordering on
// either side is a compile error, not a silent behaviour change.
static_assert((NSInteger)RNISBlurAdmissionCommit ==
              (NSInteger)rnis::BlurAdmission::Commit, "");
static_assert((NSInteger)RNISBlurAdmissionHoldForMotion ==
              (NSInteger)rnis::BlurAdmission::HoldForMotion, "");
static_assert((NSInteger)RNISBlurAdmissionHoldForSoftness ==
              (NSInteger)rnis::BlurAdmission::HoldForSoftness, "");

@implementation RNISBlurPolicyBridge {
    rnis::BlurPolicyConfig _config;
    std::unique_ptr<rnis::RunningScoreMedian> _median;
}

- (instancetype)init {
    if (self = [super init]) {
        // Default-constructed config = every check OFF except the
        // forward-progress cap, so an engine that never calls
        // `configure…` behaves exactly as it did before this policy
        // existed.
        _config = rnis::BlurPolicyConfig();
        _median = std::make_unique<rnis::RunningScoreMedian>();
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
    rnis::BlurAdmissionInput in;
    in.candidateScore     = candidateScore;
    in.sessionMedianScore = _median->median();
    in.panRateRadPerSec   = panRateRadPerSec;
    in.consecutiveHolds   = static_cast<int32_t>(consecutiveHolds);
    return static_cast<RNISBlurAdmission>(
        rnis::admitKeyframe(_config, in));
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
