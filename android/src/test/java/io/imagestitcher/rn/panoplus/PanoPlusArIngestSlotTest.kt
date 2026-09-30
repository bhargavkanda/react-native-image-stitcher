// SPDX-License-Identifier: Apache-2.0
//
// A1.2 — the AR-plugin arm's pool and latest-wins slot.
//
// Mirrors PanoPlusVcFrameSinkTest, because the slot is the vc sink's M4 design
// moved onto the AR arm, and every property that sink's review pinned has to
// hold here too. The engine call is replaced by an injected ingest function,
// which is the observation point: it runs for exactly the frames the slot
// hands to the engine, in the order it hands them.

package io.imagestitcher.rn.panoplus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.Random
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PanoPlusArIngestSlotTest {

    /** The engine, as the slot sees it: records each frame, optionally held on a gate. */
    private class FakeEngine(private val gate: CountDownLatch? = null, private val sleepMs: Long = 0L) {
        val ingested: MutableList<Double> = Collections.synchronizedList(mutableListOf<Double>())
        val seqs: MutableList<Long> = Collections.synchronizedList(mutableListOf<Long>())
        val started = CountDownLatch(1)
        fun ingest(job: PanoPlusArIngestSlot.ArJob) {
            ingested += job.frame.tsNs
            seqs += job.seq
            started.countDown()
            gate?.await(5, TimeUnit.SECONDS)
            if (sleepMs > 0L) Thread.sleep(sleepMs)
        }
    }

    private val made = mutableListOf<PanoPlusArIngestSlot>()

    private fun slotFor(engine: FakeEngine): PanoPlusArIngestSlot =
        PanoPlusArIngestSlot({ engine.ingest(it) }).also { it.arm(); made += it }

    @After
    fun tearDown() {
        for (s in made) { s.disarm(); s.awaitIdle(2000) }
    }

    private fun frame(buf: ByteArray, ts: Double) = PanoPlusArIngestSlot.ArFrame(
        buf = buf, width = 4, height = 2, tsNs = ts, fx = 1400.0, fy = 1400.0,
        cx = 2.0, cy = 1.0, q = doubleArrayOf(0.0, 0.0, 0.0, 1.0),
        exposureDurationS = 0.0, exposureISO = 0.0,
    )

    private fun offer(slot: PanoPlusArIngestSlot, ts: Double): Boolean {
        val b = slot.acquire(16) ?: return false
        return slot.submit(frame(b, ts))
    }

    private fun c(slot: PanoPlusArIngestSlot, k: String): Double = slot.counters()[k] as Double

    /** The partition, from the slot's own counters (no plugin-side throws here). */
    private fun accounted(slot: PanoPlusArIngestSlot): Double =
        c(slot, "taken") + c(slot, "superseded") + c(slot, "droppedBusy") +
            c(slot, "refusedAtAcquire") + c(slot, "allocFailed") + c(slot, "refusedPostAcquire") +
            c(slot, "droppedAtDisarm") + c(slot, "submitFailed") + c(slot, "pendingNow")

    @Test
    fun `(a) newest wins — frames 1, 2, 3 ingest as 1 and 3, with 2 superseded`() {
        val gate = CountDownLatch(1)
        val engine = FakeEngine(gate)
        val slot = slotFor(engine)
        assertTrue(offer(slot, 1.0))                   // starts the worker, which blocks
        assertTrue(engine.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(slot, 2.0))                   // pending
        assertTrue(offer(slot, 3.0))                   // replaces 2
        assertEquals(1.0, c(slot, "superseded"), 0.0)
        gate.countDown()
        assertTrue(slot.awaitIdle(2000))
        assertEquals(listOf(1.0, 3.0), engine.ingested.toList())
    }

    @Test
    fun `(b) the pool is bounded at three — a fourth acquire is refused and counted busy`() {
        val gate = CountDownLatch(1)
        val engine = FakeEngine(gate)
        val slot = slotFor(engine)
        assertTrue(offer(slot, 1.0))
        assertTrue(engine.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(slot, 2.0))                   // pending
        val writing = slot.acquire(16)                 // the one the GL thread is copying into
        assertNotNull(writing)
        assertNull(slot.acquire(16))
        assertEquals(1.0, c(slot, "droppedBusy"), 0.0)
        assertEquals(3.0, c(slot, "poolBuffers"), 0.0)
        slot.returnBuffer(writing!!)
        gate.countDown()
        assertTrue(slot.awaitIdle(2000))
    }

    @Test
    fun `(c) the worker never idles while a frame is pending`() {
        // THE CEILING THIS REPLACES: under the busy gate the worker, once
        // done, waited for the GL loop's NEXT tick. Here the pending frame runs
        // the moment the gate opens, with no further submit.
        val gate = CountDownLatch(1)
        val engine = FakeEngine(gate)
        val slot = slotFor(engine)
        assertTrue(offer(slot, 1.0))
        assertTrue(engine.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(slot, 2.0))
        gate.countDown()                               // no further offer
        assertTrue(slot.awaitIdle(2000))
        assertEquals(listOf(1.0, 2.0), engine.ingested.toList())
        assertEquals(2.0, c(slot, "taken"), 0.0)
    }

    @Test
    fun `(d) disarm drops the pending frame, counts it, and does not wait for the one in flight`() {
        val gate = CountDownLatch(1)
        val engine = FakeEngine(gate)
        val slot = slotFor(engine)
        assertTrue(offer(slot, 1.0))
        assertTrue(engine.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(slot, 2.0))                   // pending
        val t0 = System.nanoTime()
        slot.disarm()                                  // the ingest of 1 is still held
        assertTrue("disarm must not wait on the worker", (System.nanoTime() - t0) / 1e6 < 200.0)
        assertEquals(1.0, c(slot, "droppedAtDisarm"), 0.0)
        gate.countDown()
        assertTrue(slot.awaitIdle(2000))
        assertEquals(listOf(1.0), engine.ingested.toList())
        assertEquals(c(slot, "offered"), accounted(slot), 0.0)
    }

    @Test
    fun `(e) a frame copied across a disarm is refused post-acquire and its buffer returned`() {
        val slot = slotFor(FakeEngine())
        val b = slot.acquire(16)!!
        slot.disarm()
        assertFalse(slot.submit(frame(b, 1.0)))
        assertEquals(1.0, c(slot, "refusedPostAcquire"), 0.0)
        assertEquals(c(slot, "offered"), accounted(slot), 0.0)
        // …and a buffer asked for after the disarm is a refusal, not busy.
        assertNull(slot.acquire(16))
        assertEquals(1.0, c(slot, "refusedAtAcquire"), 0.0)
        assertEquals(0.0, c(slot, "droppedBusy"), 0.0)
    }

    @Test
    fun `(f) a sweep armed while the last one's loop finishes keeps its first frame`() {
        val gate = CountDownLatch(1)
        val engine = FakeEngine(gate)
        val slot = slotFor(engine)
        assertTrue(offer(slot, 1.0))                   // the old sweep's loop blocks in ingest
        assertTrue(engine.started.await(2, TimeUnit.SECONDS))
        slot.arm()                                     // no disarm (the zombie case)
        assertTrue(offer(slot, 100.0))                 // pending under the new sweep
        gate.countDown()
        assertTrue(slot.awaitIdle(2000))
        assertEquals(listOf(1.0, 100.0), engine.ingested.toList())
        assertEquals(c(slot, "offered"), accounted(slot), 0.0)
    }

    @Test
    fun `(g) disarm releases the pool — the process holds no frame buffers after a sweep`() {
        val slot = slotFor(FakeEngine())
        assertTrue(offer(slot, 1.0))
        assertTrue(slot.awaitIdle(2000))
        assertTrue(slot.pooledBuffersForTest() > 0)
        slot.disarm()
        assertEquals(0, slot.pooledBuffersForTest())
        assertEquals(0.0, c(slot, "poolBuffers"), 0.0)
    }

    @Test
    fun `(h) a submit on a shut-down executor resets working and returns its buffer`() {
        val engine = FakeEngine()
        val slot = slotFor(engine)
        slot.shutdownWorkerForTest()
        assertFalse(offer(slot, 1.0))
        assertEquals(1.0, c(slot, "submitFailed"), 0.0)
        // `working` came back down, so the slot is idle rather than wedged…
        assertTrue(slot.awaitIdle(100))
        // …and the buffer went back to the pool.
        assertEquals(1, slot.pooledBuffersForTest())
        // A re-arm replaces the dead worker and the arm ingests again.
        slot.arm()
        assertTrue(offer(slot, 2.0))
        assertTrue(slot.awaitIdle(2000))
        assertEquals(listOf(2.0), engine.ingested.toList())
    }

    @Test
    fun `(h2) a buffer that cannot be allocated gives its pool slot back — no OOM wedge`() {
        // THE OLD GATE'S OOM WEDGE, MOVED INTO THE POOL: acquire reserves a
        // slot BEFORE it allocates, so an allocation that escaped as a throw
        // held that slot until the next arm — three of them and every acquire
        // refused for the rest of the sweep. Int.MAX_VALUE is past the JVM's
        // array limit, so the allocation throws OutOfMemoryError every time.
        val slot = slotFor(FakeEngine())
        repeat(PanoPlusArIngestSlot.POOL + 1) {
            assertNull(slot.acquire(Int.MAX_VALUE))
            assertEquals(PanoPlusArIngestSlot.AcquireRefusal.ALLOC_FAILED, slot.lastAcquireRefusal())
        }
        // A leaked slot per failure would have refused the fourth as busy.
        assertEquals(4.0, c(slot, "allocFailed"), 0.0)
        assertEquals("a failed allocation is not backpressure", 0.0, c(slot, "droppedBusy"), 0.0)
        assertEquals("no slot is held for a buffer that never existed", 0.0, c(slot, "poolBuffers"), 0.0)
        assertEquals(c(slot, "offered"), accounted(slot), 0.0)
        // …and the arm goes on: the next frame gets a buffer and is ingested.
        assertTrue(offer(slot, 1.0))
        assertEquals(PanoPlusArIngestSlot.AcquireRefusal.NONE, slot.lastAcquireRefusal())
        assertTrue(slot.awaitIdle(2000))
        assertEquals(1.0, c(slot, "taken"), 0.0)
        assertEquals(c(slot, "offered"), accounted(slot), 0.0)
    }

    @Test
    fun `(h3) each refusal names itself, so the arm can label it`() {
        val gate = CountDownLatch(1)
        val engine = FakeEngine(gate)
        val slot = slotFor(engine)
        assertTrue(offer(slot, 1.0))
        assertTrue(engine.started.await(2, TimeUnit.SECONDS))
        assertTrue(offer(slot, 2.0))                   // pending
        val writing = slot.acquire(16)!!
        assertNull(slot.acquire(16))
        assertEquals(PanoPlusArIngestSlot.AcquireRefusal.BUSY, slot.lastAcquireRefusal())
        slot.returnBuffer(writing)
        slot.disarm()
        assertNull(slot.acquire(16))
        assertEquals(PanoPlusArIngestSlot.AcquireRefusal.DISARMED, slot.lastAcquireRefusal())
        gate.countDown()
        assertTrue(slot.awaitIdle(2000))
    }

    @Test
    fun `(i) the partition closes over a long randomized schedule with a slow engine`() {
        val engine = FakeEngine(sleepMs = 1L)
        val slot = slotFor(engine)
        val rnd = Random(42)
        var ts = 0.0
        repeat(1000) {
            ts += 1.0
            offer(slot, ts)
            if (rnd.nextInt(4) == 0) Thread.sleep(rnd.nextInt(3).toLong())
        }
        slot.disarm()
        assertTrue(slot.awaitIdle(5000))
        assertEquals(1000.0, c(slot, "offered"), 0.0)
        assertEquals(c(slot, "offered"), accounted(slot), 0.0)
        // One producer, three buffers: backpressure never refuses a frame.
        assertEquals(0.0, c(slot, "droppedBusy"), 0.0)
        assertTrue(c(slot, "superseded") > 0.0)
        assertEquals(c(slot, "taken"), engine.ingested.size.toDouble(), 0.0)
    }

    @Test
    fun `(j) the engine sees strictly increasing timestamps, and superseded frames leave seq gaps`() {
        val engine = FakeEngine(sleepMs = 2L)
        val slot = slotFor(engine)
        var ts = 0.0
        repeat(200) {
            ts += 1.0
            offer(slot, ts)
            if (it % 3 == 0) Thread.sleep(1L)
        }
        assertTrue(slot.awaitIdle(5000))
        val seen = engine.ingested.toList()
        for (i in 1 until seen.size) assertTrue("not increasing at $i", seen[i] > seen[i - 1])
        val seqs = engine.seqs.toList()
        for (i in 1 until seqs.size) assertTrue("seq not increasing at $i", seqs[i] > seqs[i - 1])
        // seq is assigned at SUBMIT (the vc convention): every submitted frame
        // consumed one, superseded or not.
        assertEquals(c(slot, "taken") + c(slot, "superseded"), (seqs.last() + 1).toDouble(), 0.0)
    }

    @Test
    fun `the worker's busy fraction and idle time are measured, not assumed`() {
        val engine = FakeEngine(sleepMs = 5L)
        val slot = slotFor(engine)
        assertTrue(offer(slot, 1.0))
        assertTrue(slot.awaitIdle(2000))
        Thread.sleep(20)                               // the worker ran dry
        assertTrue(offer(slot, 2.0))
        assertTrue(slot.awaitIdle(2000))
        assertTrue(c(slot, "workerIdleMsTotal") >= 15.0)
        val busy = c(slot, "workerBusyFrac")
        assertTrue("busy fraction $busy", busy > 0.0 && busy < 1.0)
        assertTrue(c(slot, "ingestWallMsP50") >= 5.0)
        assertEquals(PanoPlusArIngestSlot.DESCRIPTION, slot.counters()["ingestSlot"])
    }

    @Test
    fun `an injected worker factory is what runs the ingest`() {
        val names = Collections.synchronizedList(mutableListOf<String>())
        val slot = PanoPlusArIngestSlot(
            { names += Thread.currentThread().name },
            { Executors.newSingleThreadExecutor { r -> Thread(r, "test-ar-worker").apply { isDaemon = true } } },
        ).also { it.arm(); made += it }
        assertTrue(offer(slot, 1.0))
        assertTrue(slot.awaitIdle(2000))
        assertEquals(listOf("test-ar-worker"), names.toList())
    }
}
