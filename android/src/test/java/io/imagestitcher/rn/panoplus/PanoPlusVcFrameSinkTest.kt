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
        /** Results the tap "delivered", keyed by SENSOR_TIMESTAMP. */
        val results = PanoPlusVcResultRing()
        var outcomes = 0

        override fun metaFor(tsNs: Long): PanoPlusVcFrameMeta? = results.await(tsNs, 0L)

        override fun solveAttitude(tsNs: Long): PanoPlusVcFrameSink.PanoPlusVcAttitude {
            ingested += tsNs
            started.countDown()
            gate?.await(5, TimeUnit.SECONDS)
            return PanoPlusVcFrameSink.PanoPlusVcAttitude(doubleArrayOf(0.0, 0.0, 0.0, 1.0), 2)
        }

        override fun intrinsicsFor(width: Int, height: Int, meta: PanoPlusVcFrameMeta?): DoubleArray =
            doubleArrayOf(1000.0, 1000.0, width / 2.0, height / 2.0)

        override fun onVcFrameMeta(meta: PanoPlusVcFrameMeta?) { metas += meta }

        override fun onVcFrameOutcome(ran: Boolean, painted: Boolean, outcome: Int, droppedBusy: Boolean) {
            if (!droppedBusy) synchronized(this) { outcomes += 1 }
        }
    }

    private fun meta(expNs: Long, ts: Long) = PanoPlusVcFrameMeta(
        exposureTimeNs = expNs, iso = 100, aeLock = true, awbLock = true, aeState = 3,
        afMode = 0, focusDistance = 1.5f, oisMode = 0, videoStabMode = 0,
        cropRegion = null, zoomRatio = 1f, activePhysicalId = null, sensorTimestampNs = ts,
    )

    private var armed: FakeHost? = null

    @After
    fun tearDown() {
        armed?.let { PanoPlusVcFrameSink.disarm(it) }
        PanoPlusVcFrameSink.awaitIdle(2000)
    }

    private fun offer(ts: Long): Boolean {
        val b = PanoPlusVcFrameSink.acquireBuffer(16) ?: return false
        return PanoPlusVcFrameSink.submit(b, b.size, 4, 2, ts)
    }

    /** The partition the pack is read with — every offered frame in one bucket. */
    private fun accounted(h: FakeHost): Long =
        PanoPlusVcFrameSink.framesDroppedBusy + PanoPlusVcFrameSink.framesRefusedPostAcquire +
            PanoPlusVcFrameSink.framesSuperseded + PanoPlusVcFrameSink.framesDroppedAtDisarm +
            synchronized(h) { h.outcomes.toLong() }

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
    fun `each frame is JOINED to its own capture result by timestamp — a miss is null, never a neighbour`() {
        val host = FakeHost().also { armed = it }
        host.results.put(meta(8_000_000L, ts = 10L))
        host.results.put(meta(9_000_000L, ts = 12L))   // for a frame that never comes
        PanoPlusVcFrameSink.arm(host)
        assertTrue(offer(10L))
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        assertTrue(offer(11L))
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
        // M4 review — the waiting frame is COUNTED, and the partition closes.
        assertEquals(1L, PanoPlusVcFrameSink.framesDroppedAtDisarm)
        assertEquals(PanoPlusVcFrameSink.framesOffered, accounted(host))
    }

    @Test
    fun `M4 review — a frame offered after disarm is in no bucket because it is in no total`() {
        val host = FakeHost().also { armed = it }
        PanoPlusVcFrameSink.arm(host)
        assertTrue(offer(1L))
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        PanoPlusVcFrameSink.disarm(host)
        armed = null
        val before = PanoPlusVcFrameSink.framesOffered
        assertNull(PanoPlusVcFrameSink.acquireBuffer(16))
        assertEquals(before, PanoPlusVcFrameSink.framesOffered)
        assertEquals(PanoPlusVcFrameSink.framesOffered, accounted(host))
    }

    @Test
    fun `M4 review — a sweep armed while the last one's loop finishes keeps its first frame`() {
        val gate = CountDownLatch(1)
        val h1 = FakeHost(gate)
        PanoPlusVcFrameSink.arm(h1)
        assertTrue(offer(1L))                        // h1's loop blocks in ingest
        assertTrue(h1.started.await(2, TimeUnit.SECONDS))
        val h2 = FakeHost().also { armed = it }
        PanoPlusVcFrameSink.arm(h2)                  // no disarm of h1 (the zombie case)
        assertTrue(offer(100L))                      // pending under h2
        gate.countDown()
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        assertEquals(listOf(100L), h2.ingested.toList())
        assertEquals(PanoPlusVcFrameSink.framesOffered, accounted(h2))
    }

    @Test
    fun `M4 review — disarm releases the pool — the process holds no frame buffers after a sweep`() {
        val host = FakeHost().also { armed = it }
        PanoPlusVcFrameSink.arm(host)
        assertTrue(offer(1L))
        assertTrue(PanoPlusVcFrameSink.awaitIdle(2000))
        PanoPlusVcFrameSink.disarm(host)
        armed = null
        assertEquals(0, PanoPlusVcFrameSink.pooledBuffersForTest())
    }
}
