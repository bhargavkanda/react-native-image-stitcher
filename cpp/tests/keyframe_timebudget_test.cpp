// SPDX-License-Identifier: Apache-2.0
//
// keyframe_timebudget_test.cpp — host unit tests for the pure
// `retailens::timeBudgetCrossed` predicate (the keyframe gate's
// time-budget force-accept decision).
//
// The full KeyframeGate depends on OpenCV and cannot run in this
// harness (see CMakeLists.txt).  The time-budget boundary logic was
// therefore deliberately extracted into an inline, OpenCV-free
// predicate in keyframe_gate.hpp precisely so it CAN be unit-tested
// here without linking the gate's OpenCV-dependent .cpp.

#include <gtest/gtest.h>

#include "keyframe_gate.hpp"

using retailens::timeBudgetCrossed;

// intervalMs <= 0 disables the budget entirely (opt-out path).
TEST(TimeBudgetCrossed, DisabledWhenIntervalNonPositive) {
  EXPECT_FALSE(timeBudgetCrossed(0.0, 1000, 999999));
  EXPECT_FALSE(timeBudgetCrossed(-5.0, 1000, 999999));
}

// Never fires before the first accept (lastAcceptMs sentinel -1),
// regardless of how large `nowMs` is.
TEST(TimeBudgetCrossed, NeverFiresBeforeFirstAccept) {
  EXPECT_FALSE(timeBudgetCrossed(2000.0, -1, 1000000));
}

// Fires exactly at the boundary (elapsed == interval) and beyond.
TEST(TimeBudgetCrossed, FiresAtAndAfterBoundary) {
  EXPECT_TRUE(timeBudgetCrossed(2000.0, 1000, 3000));  // elapsed == 2000
  EXPECT_TRUE(timeBudgetCrossed(2000.0, 1000, 5000));  // elapsed  > 2000
}

// Does NOT fire just under the boundary.
TEST(TimeBudgetCrossed, DoesNotFireJustUnderBoundary) {
  EXPECT_FALSE(timeBudgetCrossed(2000.0, 1000, 2999));  // elapsed == 1999
}

// A backwards or equal clock must never fire.  A monotonic source
// should prevent now < lastAccept, but the predicate must be robust.
TEST(TimeBudgetCrossed, BackwardsOrEqualClockDoesNotFire) {
  EXPECT_FALSE(timeBudgetCrossed(2000.0, 5000, 4000));  // now < lastAccept
  EXPECT_FALSE(timeBudgetCrossed(2000.0, 5000, 5000));  // elapsed 0 < 2000
}

// Sub-millisecond budget must NOT collapse to "accept every frame":
// the predicate compares elapsed in double, so a 0.5 ms budget needs
// ~1 ms elapsed (not 0).  Guards the truncation regression.
TEST(TimeBudgetCrossed, SubMillisecondBudgetDoesNotAcceptEveryFrame) {
  EXPECT_FALSE(timeBudgetCrossed(0.5, 1000, 1000));  // elapsed 0.0 < 0.5
  EXPECT_TRUE(timeBudgetCrossed(0.5, 1000, 1001));   // elapsed 1.0 >= 0.5
}

// Realistic 2 s budget across a slow pan: a keyframe accepted at t,
// the next force-accept lands at t + 2000 ms, not before.
TEST(TimeBudgetCrossed, TwoSecondBudgetTypicalUse) {
  const int64_t lastAccept = 10000;
  EXPECT_FALSE(timeBudgetCrossed(2000.0, lastAccept, lastAccept + 1500));
  EXPECT_FALSE(timeBudgetCrossed(2000.0, lastAccept, lastAccept + 1999));
  EXPECT_TRUE(timeBudgetCrossed(2000.0, lastAccept, lastAccept + 2000));
  EXPECT_TRUE(timeBudgetCrossed(2000.0, lastAccept, lastAccept + 2001));
}
