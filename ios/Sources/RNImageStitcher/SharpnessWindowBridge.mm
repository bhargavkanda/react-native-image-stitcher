// SPDX-License-Identifier: Apache-2.0
//
// SharpnessWindowBridge.mm — see SharpnessWindowBridge.h.

#import "SharpnessWindowBridge.h"

#include <memory>

#include "sharpness_window.hpp"

// Pin the Obj-C enum raw values to the C++ enum so a re-ordering on
// either side is a compile error, not a silent behaviour change.
static_assert((NSInteger)RNISSharpnessWindowActionNone ==
              (NSInteger)retailens::SharpnessWindowAction::None, "");
static_assert((NSInteger)RNISSharpnessWindowActionSaveImmediately ==
              (NSInteger)retailens::SharpnessWindowAction::SaveImmediately, "");
static_assert((NSInteger)RNISSharpnessWindowActionOpenWindow ==
              (NSInteger)retailens::SharpnessWindowAction::OpenWindow, "");
static_assert((NSInteger)RNISSharpnessWindowActionFlushThenOpen ==
              (NSInteger)retailens::SharpnessWindowAction::FlushThenOpen, "");
static_assert((NSInteger)RNISSharpnessWindowActionReplaceBest ==
              (NSInteger)retailens::SharpnessWindowAction::ReplaceBest, "");
static_assert((NSInteger)RNISSharpnessWindowActionKeepBest ==
              (NSInteger)retailens::SharpnessWindowAction::KeepBest, "");
static_assert((NSInteger)RNISSharpnessWindowActionCloseAndSave ==
              (NSInteger)retailens::SharpnessWindowAction::CloseAndSave, "");

@implementation RNISSharpnessWindowBridge {
    std::unique_ptr<retailens::SharpnessWindowMachine> _machine;
}

- (instancetype)init {
    if (self = [super init]) {
        _machine = std::make_unique<retailens::SharpnessWindowMachine>();
    }
    return self;
}

- (void)setWindowSize:(NSInteger)k {
    _machine->setWindowSize(static_cast<int32_t>(k));
}

- (NSInteger)windowSize {
    return static_cast<NSInteger>(_machine->windowSize());
}

- (RNISSharpnessWindowAction)ingestWithAccept:(BOOL)isAccept
                                        score:(double)score
                              noveltyFraction:(double)noveltyFraction
                             overlapThreshold:(double)overlapThreshold
                                  replaceBest:(BOOL *)replaceBestOut
                                  driftClosed:(BOOL *)driftClosedOut
{
    const retailens::SharpnessWindowDecision d =
        _machine->ingest(isAccept, score, noveltyFraction, overlapThreshold);
    if (replaceBestOut) {
        *replaceBestOut = d.replaceBest ? YES : NO;
    }
    if (driftClosedOut) {
        *driftClosedOut =
            (d.closeReason ==
             retailens::SharpnessWindowCloseReason::NoveltyDrift) ? YES : NO;
    }
    return static_cast<RNISSharpnessWindowAction>(d.action);
}

- (BOOL)drain {
    return _machine->drain() ? YES : NO;
}

- (void)reset {
    _machine->reset();
}

- (BOOL)isOpen {
    return _machine->isOpen() ? YES : NO;
}

- (double)bestScore {
    return _machine->bestScore();
}

@end
