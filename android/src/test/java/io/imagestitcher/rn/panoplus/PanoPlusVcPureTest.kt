// SPDX-License-Identifier: Apache-2.0
//
// M4 review — the pure halves of the vision-camera arm's lock and metadata:
// the generation gate that orders a posted lock against teardown, the result
// ring the frames are joined against, the settle that decides WHEN to lock,
// and the verdict that says whether it held.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PanoPlusVcPureTest {

    private fun meta(
        ts: Long,
        ae: Int? = 2,
        awb: Int? = 2,
        af: Int? = 2,
        focus: Float? = 1.25f,
    ) = PanoPlusVcFrameMeta(
        exposureTimeNs = 1L, iso = 1, aeLock = null, awbLock = null, aeState = ae,
        afMode = 4, focusDistance = focus, oisMode = null, videoStabMode = null,
        cropRegion = null, zoomRatio = null, activePhysicalId = null,
        sensorTimestampNs = ts, afState = af, awbState = awb,
    )

    // ── the gate ──────────────────────────────────────────────────────────

    @Test
    fun `a lock posted before an unlock NEVER applies after it`() {
        val gate = PanoPlusGenGate()
        var applied = false
        val ticket = gate.ticket()          // lock() posts its job…
        gate.invalidate { }                 // …teardown's unlock() runs first…
        val out = gate.runIfCurrent(ticket) { applied = true; "requested" }
        assertNull(out)                     // …and the posted job is cancelled.
        assertTrue(!applied)
    }

    @Test
    fun `a lock with nothing in between runs`() {
        val gate = PanoPlusGenGate()
        val ticket = gate.ticket()
        assertEquals("requested", gate.runIfCurrent(ticket) { "requested" })
    }

    @Test
    fun `the posted job and the unlock are serialised — an unlock cannot land mid-apply`() {
        val gate = PanoPlusGenGate()
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        val order = java.util.Collections.synchronizedList(mutableListOf<String>())
        val ex = Executors.newSingleThreadExecutor()
        val t = gate.ticket()
        ex.submit {
            gate.runIfCurrent(t) {
                inside.countDown()
                release.await(2, TimeUnit.SECONDS)
                order += "apply"
            }
        }
        assertTrue(inside.await(2, TimeUnit.SECONDS))
        val un = Executors.newSingleThreadExecutor().submit { gate.invalidate { order += "clear" } }
        Thread.sleep(50)
        release.countDown()
        un.get(2, TimeUnit.SECONDS)
        assertEquals(listOf("apply", "clear"), order.toList())
        ex.shutdown()
    }

    // ── the ring ──────────────────────────────────────────────────────────

    @Test
    fun `the ring joins by exact timestamp, waits a bounded time, and evicts the oldest`() {
        val ring = PanoPlusVcResultRing(capacity = 3)
        ring.put(meta(1)); ring.put(meta(2)); ring.put(meta(3)); ring.put(meta(4))
        assertNull(ring.await(1, 0))        // evicted
        assertNotNull(ring.await(3, 0))
        assertNull(ring.await(3, 0))        // consumed
        val ex = Executors.newSingleThreadExecutor()
        ex.submit { Thread.sleep(30); ring.put(meta(9)) }
        assertNotNull(ring.await(9, 1000))  // arrives while waiting
        val t0 = System.nanoTime()
        assertNull(ring.await(99, 40))
        assertTrue((System.nanoTime() - t0) / 1_000_000L >= 35)
        ex.shutdown()
    }

    @Test
    fun `a result with no timestamp is never joinable`() {
        val ring = PanoPlusVcResultRing()
        ring.put(meta(0))
        assertEquals(0L, ring.resultsReceived)
    }

    // ── the settle ────────────────────────────────────────────────────────

    @Test
    fun `the lock waits for N converged results, not the first frame`() {
        val s = PanoPlusVcSettle(stableNeeded = 3, ceilingMs = 3000.0)
        assertNull(s.feed(meta(1, ae = 1), 0.0))      // SEARCHING
        assertNull(s.feed(meta(2), 33.0))
        assertNull(s.feed(meta(3), 66.0))
        val d = s.feed(meta(4), 99.0)
        assertEquals("converged", d?.reason)
        assertEquals(1.25f, d?.focusDistance)
        assertNull(s.feed(meta(5), 132.0))            // decided once
    }

    @Test
    fun `a metering that never settles locks at the ceiling, and says so`() {
        val s = PanoPlusVcSettle(stableNeeded = 3, ceilingMs = 100.0)
        assertNull(s.feed(meta(1, ae = 1), 0.0))
        assertNull(s.feed(meta(2, ae = 1), 50.0))
        assertEquals("ceiling", s.feed(meta(3, ae = 1), 100.0)?.reason)
    }

    @Test
    fun `no capture results at all locks at the ceiling with the reason named`() {
        val s = PanoPlusVcSettle(stableNeeded = 3, ceilingMs = 100.0)
        assertNull(s.feed(null, 0.0))
        val d = s.feed(null, 150.0)
        assertEquals("ceiling-no-results", d?.reason)
        assertNull(d?.focusDistance)
    }

    @Test
    fun `focus is pinned only when AF has settled`() {
        val s = PanoPlusVcSettle(stableNeeded = 1, ceilingMs = 3000.0)
        val d = s.feed(meta(1, af = 1 /* PASSIVE_SCAN */), 0.0)
        assertEquals("converged", d?.reason)
        assertNull(d?.focusDistance)
    }

    // ── the verdict ───────────────────────────────────────────────────────

    @Test
    fun `no results after the lock is UNVERIFIED — never a vacuous held`() {
        assertEquals("unverified", panoVcLockVerdict(0, 0, 0, 0, 0, 0, 0))
    }

    @Test
    fun `held needs every result locked with one exposure and one ISO`() {
        assertEquals("held", panoVcLockVerdict(10, 10, 10, 5, 5, 100, 100))
        assertEquals("not-held", panoVcLockVerdict(10, 9, 10, 5, 5, 100, 100))
        assertEquals("not-held", panoVcLockVerdict(10, 10, 10, 5, 6, 100, 100))
        assertEquals("not-held", panoVcLockVerdict(10, 10, 10, 5, 5, 100, 200))
        assertEquals("not-held", panoVcLockVerdict(10, 10, 8, 5, 5, 100, 100))
    }
}
