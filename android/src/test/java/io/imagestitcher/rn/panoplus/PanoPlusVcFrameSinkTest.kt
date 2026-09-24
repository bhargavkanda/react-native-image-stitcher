// SPDX-License-Identifier: Apache-2.0
//
// M4 — the vision-camera sink's pool and latest-wins slot.
//
// The engine call itself cannot run in a JVM (PanoPlusLiveNative is not
// loaded, so `ingest` answers 0 at once); what is under test is the ORDER in
// which frames reach it and the bound on buffers, which are the two things the
// rework changed. The host's callbacks are the observation point: the sink
// calls onVcFrameMeta/solveAttitude/intrinsicsFor for exactly the frames it
// ingests, in order.

package io.imagestitcher.rn.panoplus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PanoPlusVcFrameSinkTest {

    private class FakeHost(private val gate: CountDownLatch? = null) : PanoPlusVcFrameSink.Host {
        val ingested: MutableList<Long> = Collections.synchronizedList(mutableListOf<Long>())
        val metas: MutableList<PanoPlusVcFrameMeta?> = Collections.synchronizedList(mutableListOf())
        val started = CountDownLatch(1)

        override fun solveAttitude(tsNs: Long): PanoPlusVcFrameSink.PanoPlusVcAttitude {
            ingested += tsNs
            started.countDown()
            gate?.await(5, TimeUnit.SECONDS)
            return PanoPlusVcFrameSink.PanoPlusVcAttitude(doubleArrayOf(0.0, 0.0, 0.0, 1.0), 2)
        }

        override fun intrinsicsFor(width: Int, height: Int, meta: PanoPlusVcFrameMeta?): DoubleArray =
            doubleArrayOf(1000.0, 1000.0, width / 2.0, height / 2.0)

        override fun onVcFrameMeta(meta: PanoPlusVcFrameMeta?) { metas += meta }

        override fun onVcFrameOutcome(ran: Boolean, painted: Boolean, outcome: Int, droppedBusy: Boolean) {}
    }

    private fun meta(expNs: Long) = PanoPlusVcFrameMeta(
        exposureTimeNs = expNs, iso = 100, aeLock = true, awbLock = true, aeState = 3,
        afMode = 0, focusDistance = 1.5f, oisMode = 0, videoStabMode = 0,
        cropRegion = null, zoomRatio = 1f, activePhysicalId = null,
    )

    private var armed: FakeHost? = null

    @After
    fun tearDown() {
        armed?.let { PanoPlusVcFrameSink.disarm(it) }
        PanoPlusVcFrameSink.awaitIdle(2000)
    }

    private fun offer(ts: Long, m: PanoPlusVcFrameMeta? = null): Boolean {
        val b = PanoPlusVcFrameSink.acquireBuffer(16) ?: return false
        return PanoPlusVcFrameSink.submit(b, b.size, 4, 2, ts, m)
    }

    @Test
    fun `a frame arriving while one waits REPLACES it — the engine always takes the newest`() {
        val gate = CountDownLatch(1)
        val host = FakeHost(gate).also { armed = it }
        PanoPlusVcFrameSink.arm(host)
        assertTrue(offer(1L))                        // starts the worker, which blocks
        assertTrue(host.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(2L))                        // pending
        assertTrue(offer(3L))                        // replaces 2
        assertEquals(1L, PanoPlusVcFrameSink.framesSuperseded)
        gate.countDown()
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        assertEquals(listOf(1L, 3L), host.ingested.toList())
    }

    @Test
    fun `the pool is bounded — ingesting, pending and one being written, never more`() {
        val gate = CountDownLatch(1)
        val host = FakeHost(gate).also { armed = it }
        PanoPlusVcFrameSink.arm(host)
        assertTrue(offer(1L))
        assertTrue(host.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(2L))                        // pending
        // The third buffer is the one a plugin is writing into…
        val writing = PanoPlusVcFrameSink.acquireBuffer(16)
        assertNotNull(writing)
        // …and a fourth frame finds none: dropped, and counted busy.
        assertNull(PanoPlusVcFrameSink.acquireBuffer(16))
        assertEquals(1L, PanoPlusVcFrameSink.framesDroppedBusy)
        PanoPlusVcFrameSink.returnBuffer(writing!!)
        gate.countDown()
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
    }

    @Test
    fun `each frame's own CaptureResult travels with it to the engine`() {
        val host = FakeHost().also { armed = it }
        PanoPlusVcFrameSink.arm(host)
        assertTrue(offer(10L, meta(8_000_000L)))
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        assertTrue(offer(11L, null))
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        assertEquals(listOf(10L, 11L), host.ingested.toList())
        assertEquals(8_000_000L, host.metas[0]?.exposureTimeNs)
        assertNull(host.metas[1])
    }

    @Test
    fun `disarm drops a waiting frame — nothing reaches a sweep that is being finalized`() {
        val gate = CountDownLatch(1)
        val host = FakeHost(gate).also { armed = it }
        PanoPlusVcFrameSink.arm(host)
        assertTrue(offer(1L))
        assertTrue(host.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(2L))                        // pending
        PanoPlusVcFrameSink.disarm(host)
        armed = null
        gate.countDown()
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        assertEquals(listOf(1L), host.ingested.toList())
        assertNull(PanoPlusVcFrameSink.acquireBuffer(16))   // not armed: no buffer
    }
}
