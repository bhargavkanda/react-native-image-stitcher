// SPDX-License-Identifier: Apache-2.0
//
// M8 review — the camera-release point is scoped to the session that is
// INSTALLED. A stop's teardown marks its own generation; a superseded session,
// or one that lost the install race, cannot mark the sweep that did install.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusCameraReleaseTest {

    @Test
    fun `a new session starts unreleased and its own teardown releases it`() {
        val g = PanoPlusCameraRelease.begin()
        assertFalse(PanoPlusCameraRelease.released)
        PanoPlusCameraRelease.release(g)
        assertTrue(PanoPlusCameraRelease.released)
    }

    @Test
    fun `a superseded session's teardown cannot release the new sweep`() {
        val old = PanoPlusCameraRelease.begin()
        val current = PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(old)          // lands late
        assertFalse(PanoPlusCameraRelease.released)
        PanoPlusCameraRelease.release(current)
        assertTrue(PanoPlusCameraRelease.released)
    }

    @Test
    fun `a session that lost the install race (generation -1) releases nothing`() {
        PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(-1L)
        assertFalse(PanoPlusCameraRelease.released)
    }

    @Test
    fun `the next session starts unreleased again`() {
        val g = PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(g)
        PanoPlusCameraRelease.begin()
        assertFalse(PanoPlusCameraRelease.released)
    }

    // ── U5c — the release INSTANT, not just the fact ──────────────────────
    //
    // A finish of 44-228 ms is often over before any 100 ms status poll can
    // see the boolean, so the stamp is what lets the finish timeline place the
    // release at all. It must be wall-clock epoch ms (JS `Date.now()`'s clock)
    // and it must fail CLOSED: 0 means "not reported", never a time.

    @Test
    fun `U5c — the release is stamped in epoch ms at the moment it happens`() {
        val g = PanoPlusCameraRelease.begin()
        assertEquals(0.0, PanoPlusCameraRelease.releasedAtMs, 0.0)
        val before = System.currentTimeMillis().toDouble()
        PanoPlusCameraRelease.release(g)
        val after = System.currentTimeMillis().toDouble()
        val at = PanoPlusCameraRelease.releasedAtMs
        assertTrue("stamped $at outside [$before, $after]", at in before..after)
    }

    @Test
    fun `U5c — a stale session's release stamps nothing on the current sweep`() {
        val old = PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(old)          // lands late
        assertEquals(0.0, PanoPlusCameraRelease.releasedAtMs, 0.0)
    }

    @Test
    fun `U5c — the stamp fails closed across a new generation`() {
        // What this pins is the GETTER's generation gate: a new session reads
        // 0 whether or not begin() also zeroes the stored stamp (it does, but
        // only to narrow the getter's check-then-read window, which a unit
        // test cannot open). The new session's own release then stamps anew.
        val g = PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(g)
        assertTrue(PanoPlusCameraRelease.releasedAtMs > 0.0)
        val next = PanoPlusCameraRelease.begin()
        assertEquals(0.0, PanoPlusCameraRelease.releasedAtMs, 0.0)
        PanoPlusCameraRelease.release(next)
        assertTrue(PanoPlusCameraRelease.releasedAtMs > 0.0)
    }
}
