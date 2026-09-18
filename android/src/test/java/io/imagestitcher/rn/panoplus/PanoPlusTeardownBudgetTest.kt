// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusTeardownBudgetTest.kt — the arithmetic that decides whether the app
// survives an Activity destroy.
//
// ── WHAT WENT WRONG ──────────────────────────────────────────────────────
//
// `onHostDestroy()` was given `invalidate()`'s body under the comment "same
// reasoning as invalidate".  The reasoning about the RACE was right; the
// reasoning about the THREAD was never checked.  `ReactContext.onHostDestroy()`
// is `@ThreadConfined(UI)`, so that body ran on the main looper: a blocking
// `CameraDevice.close()`, then FOUR `HandlerThread` joins each independently
// bounded at 3 s, then a `device.json` fsync, then a full Camera2
// re-enumeration.  Independently bounded means ADDITIVE — a worst case around
// twelve seconds against a system ANR limit of five.
//
// The fix is not a shorter per-join timeout (four short ones are still
// additive); it is ONE budget shared by every join, spent in order.  That is
// pure arithmetic over a clock, so it is pinned here rather than on a phone —
// which is the only place the failure it prevents can be observed.
//
// ⚠ THE TRAP THIS ENCODES: `Thread.join(0)` blocks FOREVER.  A budget that has
// run out must therefore return a value the CALLER branches on, never a timeout
// it can pass straight through — a spent budget handed to `join()` would turn
// the bound into its exact opposite.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusTeardownBudgetTest {

    /** A clock the test moves by hand — no sleeping, no flake. */
    private class FakeClock(var ms: Long = 1_000L) {
        val now: () -> Long = { ms }
    }

    // ── the shared budget is shared ─────────────────────────────────────

    @Test
    fun `four joins share one budget instead of getting one each`() {
        val clock = FakeClock()
        val budget = JoinBudget(JOIN_BUDGET_UI_MS, clock.now)

        // Join 1 may use the whole second; it burns 600 ms.
        assertEquals(1000L, budget.remainingMs())
        clock.ms += 600

        // Join 2 gets only what is LEFT — the defect was it getting 1000 again.
        assertEquals(400L, budget.remainingMs())
        clock.ms += 400

        // Joins 3 and 4 get nothing, and the total spent is the budget, not 4x.
        assertEquals(0L, budget.remainingMs())
        assertEquals(0L, budget.remainingMs())
    }

    @Test
    fun `an overrun never yields a negative slice`() {
        val clock = FakeClock()
        val budget = JoinBudget(JOIN_BUDGET_UI_MS, clock.now)
        // A join that overshot its slice (a thread that ignored quitSafely for
        // a while, a scheduler stall) must not hand the NEXT one a negative
        // timeout — Thread.join rejects it, and the teardown would throw out of
        // the one path that must not throw.
        clock.ms += 9_999
        assertEquals(0L, budget.remainingMs())
    }

    @Test
    fun `a spent budget is distinguishable from an unlimited one`() {
        val clock = FakeClock()
        val budget = JoinBudget(JOIN_BUDGET_UI_MS, clock.now)
        clock.ms += JOIN_BUDGET_UI_MS
        // ZERO, and the call site must read it as "skip the join". Passing this
        // to Thread.join(0) waits forever — the exact inversion this API shape
        // exists to make impossible to write by accident.
        assertEquals(0L, budget.remainingMs())
    }

    // ── the two budgets are the two threads ─────────────────────────────

    @Test
    fun `the UI budget is under the system ANR limit and the IO budget is not`() {
        // 5 s is the ANR limit for an input-dispatch/main-thread stall. The UI
        // teardown must fit inside it WITH room for CameraDevice.close() and a
        // device.json fsync, neither of which this budget covers.
        assertTrue(
            "the UI join budget must leave headroom under the 5s ANR limit",
            JOIN_BUDGET_UI_MS <= 1_000L,
        )
        // And the background budget must NOT have been quietly tightened to
        // match: on Dispatchers.IO a slow writer drain is a slow drain, and
        // cutting it short loses the track rows it was still flushing.
        assertTrue(
            "the background join budget must stay generous",
            JOIN_BUDGET_MS >= 12_000L,
        )
    }

    @Test
    fun `the default clock advances`() {
        // The production default is System.nanoTime, deliberately (monotonic,
        // and not an Android API a unit test would have to mock). If someone
        // swaps it for a constant the budget silently becomes unlimited.
        val budget = JoinBudget(20L)
        assertTrue("a fresh budget must start with time on it", budget.remainingMs() > 0L)
        Thread.sleep(60)
        assertEquals("the default clock never advanced", 0L, budget.remainingMs())
    }
}
