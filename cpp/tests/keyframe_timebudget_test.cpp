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

// ─────────────────────────────────────────────────────────────────────
// v0.25 — timeBudgetMayForceAccept: the "reserve the last cap slot"
// guard that stops a stationary hold from self-finalizing on the clock.
//
// WHAT IT DEFENDS.  Keep-alive accepts count toward maxCount exactly
// like novelty accepts, and the host auto-finalizes the capture when
// that count is reached.  So a hold that never pans marches to the cap
// on the clock alone and ends itself having captured nothing new — at
// the shipped defaults (maxKeyframes 6, interval 1500 ms) in ~7.5 s.
//
// WHY THE GUARD IS SHAPED THIS WAY rather than exempting keep-alives
// from the count: exempting them removes the last bound on a
// stationary capture (maxPanDurationMs defaults to 0, the drift
// finalizers are motion-triggered, nothing caps the saved-keyframe
// list), so it would trade "ends too early" for "never ends, fills the
// disk, then OOMs in cv::Stitcher".  Reserving the final slot keeps
// acceptedCount <= maxCount by construction.
// ─────────────────────────────────────────────────────────────────────

using retailens::timeBudgetMayForceAccept;

// Default (canFinalize = true) must be byte-identical to the old
// behaviour: exactly timeBudgetCrossed, whatever the counts.
TEST(TimeBudgetMayForceAccept, DefaultIsIdenticalToTimeBudgetCrossed) {
  for (int accepted = 0; accepted < 8; ++accepted) {
    for (int max = 1; max < 8; ++max) {
      EXPECT_EQ(timeBudgetMayForceAccept(2000.0, 1000, 3000, accepted, max, true),
                timeBudgetCrossed(2000.0, 1000, 3000))
          << "accepted=" << accepted << " max=" << max;
      EXPECT_EQ(timeBudgetMayForceAccept(2000.0, 1000, 2999, accepted, max, true),
                timeBudgetCrossed(2000.0, 1000, 2999))
          << "accepted=" << accepted << " max=" << max;
    }
  }
}

// With the guard on, keep-alives still fire while a slot remains free.
TEST(TimeBudgetMayForceAccept, GuardAllowsAcceptsBelowTheReservedSlot) {
  // maxCount 6: accepted 0..3 leave >= 2 slots, so 0+1<6 .. 3+1<6 hold.
  EXPECT_TRUE(timeBudgetMayForceAccept(1500.0, 0, 1500, 0, 6, false));
  EXPECT_TRUE(timeBudgetMayForceAccept(1500.0, 0, 1500, 3, 6, false));
  EXPECT_TRUE(timeBudgetMayForceAccept(1500.0, 0, 1500, 4, 6, false));  // 4+1 < 6
}

// THE FIX: the keep-alive can never be the accept that REACHES the cap.
TEST(TimeBudgetMayForceAccept, GuardBlocksTheAcceptThatWouldReachTheCap) {
  // accepted == maxCount-1: accepting would make it maxCount and trip
  // the host's `acceptedCount >= keyframeMaxCount` auto-finalize.
  EXPECT_FALSE(timeBudgetMayForceAccept(1500.0, 0, 1500, 5, 6, false));
  // ...and it stays blocked at/over the cap.
  EXPECT_FALSE(timeBudgetMayForceAccept(1500.0, 0, 1500, 6, 6, false));
  EXPECT_FALSE(timeBudgetMayForceAccept(1500.0, 0, 1500, 9, 6, false));
}

// The guard NEVER manufactures an accept the budget itself would not
// have made — it can only ever subtract.
TEST(TimeBudgetMayForceAccept, GuardOnlySubtractsNeverAdds) {
  for (int accepted = 0; accepted < 12; ++accepted) {
    for (int max = 1; max < 12; ++max) {
      // budget not crossed => false regardless of counts or flag
      EXPECT_FALSE(timeBudgetMayForceAccept(2000.0, 1000, 2999, accepted, max, false));
      EXPECT_FALSE(timeBudgetMayForceAccept(0.0, 1000, 999999, accepted, max, false));
      EXPECT_FALSE(timeBudgetMayForceAccept(2000.0, -1, 999999, accepted, max, false));
      // guarded result implies unguarded result
      if (timeBudgetMayForceAccept(2000.0, 1000, 5000, accepted, max, false)) {
        EXPECT_TRUE(timeBudgetCrossed(2000.0, 1000, 5000));
      }
    }
  }
}

// Both hosts clamp maxCount to >= 3, so at least two slots always remain
// for real novelty accepts.  This path can therefore never be the reason
// a capture finishes with a single keyframe.
TEST(TimeBudgetMayForceAccept, AtHostClampedMinimumTwoSlotsRemainForNovelty) {
  const int32_t kHostMin = 3;  // Swift max(3,min(10,v)) / Kotlin coerceIn(3,10)
  EXPECT_TRUE(timeBudgetMayForceAccept(1500.0, 0, 1500, 0, kHostMin, false));
  EXPECT_TRUE(timeBudgetMayForceAccept(1500.0, 0, 1500, 1, kHostMin, false));
  EXPECT_FALSE(timeBudgetMayForceAccept(1500.0, 0, 1500, 2, kHostMin, false));
}

// A degenerate maxCount (reachable only by a direct C++ caller, not
// through either bridge) must fail SAFE — the budget simply never
// fires, rather than firing unbounded.
TEST(TimeBudgetMayForceAccept, DegenerateMaxCountFailsSafe) {
  EXPECT_FALSE(timeBudgetMayForceAccept(1500.0, 0, 1500, 0, 1, false));
  EXPECT_FALSE(timeBudgetMayForceAccept(1500.0, 0, 1500, 0, 0, false));
  EXPECT_FALSE(timeBudgetMayForceAccept(1500.0, 0, 1500, 0, -3, false));
}
