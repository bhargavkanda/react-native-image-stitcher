// SPDX-License-Identifier: Apache-2.0
//
// The gating in front of the engine on the pano+ AR-plugin arm.
//
// It tests PanoPlusArArmState rather than the plugin class, and that is not a
// convenience: the plugin implements the stitcher's compileOnly ARFramePlugin,
// Kotlin cannot reference a class whose supertype it cannot resolve, and adding
// the SPI to the test classpath breaks PanoPlusArCoreModeTest, which asserts the
// SPI is absent in a unit-test JVM. Both routes were tried before the split.
//
// What is under test is the reason the SHARED-camera arm could ship broken for
// eighteen days: an arm that refuses every frame must be distinguishable from an
// arm that was never selected.

package io.imagestitcher.rn.panoplus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PanoPlusArFramePluginTest {

    private fun armed() = PanoPlusArArmState().apply { arm() }

    /** Slots made by a test, disarmed afterwards so no worker outlives it. */
    private val slots = mutableListOf<PanoPlusArIngestSlot>()

    private fun slot(fn: (PanoPlusArIngestSlot.ArJob) -> Unit = {}): PanoPlusArIngestSlot =
        PanoPlusArIngestSlot(fn).also { it.arm(); slots += it }

    @After
    fun tearDown() {
        for (s in slots) { s.disarm(); s.awaitIdle(2000) }
    }

    private fun frame(buf: ByteArray, ts: Double) = PanoPlusArIngestSlot.ArFrame(
        buf = buf, width = 4, height = 2, tsNs = ts, fx = 1400.0, fy = 1400.0,
        cx = 2.0, cy = 1.0, q = doubleArrayOf(0.0, 0.0, 0.0, 1.0),
        exposureDurationS = 0.0, exposureISO = 0.0,
    )

    @Test
    fun `an UNARMED arm refuses without counting a SKIP — but the call is still seen`() {
        val s = PanoPlusArArmState()
        assertEquals(ArFrameVerdict.NOT_ARMED, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        // NOT counted as a skip: the plugin stays registered across the AR
        // view's lifecycle, so an unarmed frame is not a refusal, it is silence.
        assertEquals(0.0, s.counters()["skippedNotTracking"])
        assertEquals(0.0, s.counters()["skippedBadGeometry"])
        assertTrue(!(s.counters()["armed"] as Boolean))
        // `seen` DOES count it, deliberately and before the armed check: "the
        // session called us 300 times while we were not armed" and "nobody
        // called us at all" are different findings and both are worth having.
        assertEquals(1.0, s.counters()["seen"])
    }

    @Test
    fun `the gate uses the CONTRACT string, not the ARCore enum name`() {
        // ⚠ THE 472-FRAME BUG. ARFrameContext documents trackingState as
        // "normal" | "limited" | "notAvailable" — the engine's own vocabulary on
        // both platforms — and the gate checked for "TRACKING", the raw
        // com.google.ar.core.TrackingState name. The first AR sweep that ever
        // delivered frames refused every one of them.
        val s = armed()
        assertEquals(ArFrameVerdict.INGEST, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        // And the enum name must NOT be accepted, or the mistake becomes silent.
        assertEquals(ArFrameVerdict.NOT_TRACKING, s.verdict("TRACKING", 1920, 1080, 1400.0, 1400.0))
    }

    @Test
    fun `a PAUSED ARCore pose never reaches the engine, and says so`() {
        // Feeding a non-tracking pose would put a stale or identity rotation
        // into the chain and lean the canvas — the exact defect the operator
        // reported on the rotation-vector arm.
        val s = armed()
        assertEquals(ArFrameVerdict.NOT_TRACKING, s.verdict("limited", 1920, 1080, 1400.0, 1400.0))
        assertEquals(1.0, s.counters()["skippedNotTracking"])
        assertTrue((s.counters()["lastOutcome"] as String).contains("limited"))
    }

    @Test
    fun `the engine's own geometry floor is enforced here, not discovered natively`() {
        val s = armed()
        // fx <= 1.0 is the engine's refusal threshold; a zero raster is not a frame.
        assertEquals(ArFrameVerdict.BAD_GEOMETRY, s.verdict("normal", 1920, 1080, 1.0, 1400.0))
        assertEquals(ArFrameVerdict.BAD_GEOMETRY, s.verdict("normal", 0, 1080, 1400.0, 1400.0))
        assertEquals(2.0, s.counters()["skippedBadGeometry"])
    }

    @Test
    fun `a good tracking frame is admitted, and the sequence is assigned at the hand-off`() {
        val s = armed()
        assertEquals(ArFrameVerdict.INGEST, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        // The engine's seq is the SLOT's, assigned at submit (the vc
        // convention), so a frame that never reaches submit consumes none.
        val gate = CountDownLatch(1)
        val seqs = java.util.Collections.synchronizedList(mutableListOf<Long>())
        val slot = slot { job -> seqs += job.seq; gate.await(2, TimeUnit.SECONDS) }
        val b0 = s.admit(1_000.0, 16, slot)!!
        assertTrue(slot.submit(frame(b0, 1_000.0)))
        val b1 = s.admit(1_001.0, 16, slot)!!
        assertTrue(slot.submit(frame(b1, 1_001.0)))
        gate.countDown()
        assertTrue(slot.awaitIdle(2000))
        assertEquals(listOf(0L, 1L), seqs.toList())
    }

    @Test
    fun `the GL thread re-rendering the SAME ARCore frame is refused here, not by the engine`() {
        // ⚠ MEASURED ON THE FIRST WORKING AR SWEEP. The stitcher runs its plugin
        // pass from the GL render thread, which draws at display rate, while
        // ARCore produces at ~30 Hz — so update() returns the SAME frame,
        // timestamp and all, roughly every other render. 53 of 333 rows carried
        // a timestamp <= the previous one, at rows 3, 5, 7, 9, 11 …, and the
        // engine refused all 53 as rejected-input. Correct but wasteful: it
        // DOUBLED the bootstrap, 53 frames against the IMU arm's 8.
        val s = armed()
        assertTrue(s.acceptTs(1_000.0))
        assertTrue(!s.acceptTs(1_000.0))          // the same frame again
        assertTrue(!s.acceptTs(999.0))            // and one that went backwards
        assertTrue(s.acceptTs(1_001.0))           // a genuinely new frame
        assertEquals(2.0, s.counters()["skippedDuplicate"])
    }

    @Test
    fun `the duplicate watermark resets on arm, so sweep two is not judged against sweep one`() {
        val s = armed()
        assertTrue(s.acceptTs(5_000.0))
        s.arm()
        // A new sweep's ARCore timestamps can legitimately be lower than the
        // previous sweep's; carrying the watermark over would refuse the whole
        // second capture.
        assertTrue(s.acceptTs(10.0))
    }

    @Test
    fun `arming RESETS every counter, so a pack describes exactly one sweep`() {
        val s = armed()
        s.verdict("limited", 1920, 1080, 1400.0, 1400.0)
        s.recordIngest(ran = true, wasPainted = true, outcome = 3)
        s.recordSubmitThrew("x"); s.recordEngineThrew("x"); s.recordPoseRowThrew("x")
        s.recordRegisterThrew("x")
        s.disarm()
        s.verdict("normal", 1920, 1080, 1400.0, 1400.0)   // skippedNotArmed
        s.recordCopy(1.0)
        s.arm()
        for (k in listOf(
            "ingested", "painted", "skippedNotTracking", "skippedBadGeometry", "ingestThrew",
            // Added with the ingest offload. Listed explicitly rather than
            // derived from counters().keys so that a NEW counter which someone
            // forgets to reset fails this test instead of silently joining it.
            "seen", "droppedBusy",
            // A1.2 — the split throws and the unarmed calls.
            "skippedNotArmed", "submitThrew", "engineThrew", "poseRowThrew", "registerThrew",
            // A1.0 — the GL-thread timings.
            "tickIntervalMsP50", "copyMsP50",
        )) {
            assertEquals("$k must reset on arm", 0.0, s.counters()[k])
        }
    }

    @Test
    fun `the SLOT's counters reset on its arm too`() {
        val slot = slot()
        slot.acquire(16)?.let { slot.returnBuffer(it) }
        assertNull(slot.acquire(Int.MAX_VALUE))                  // allocFailed
        slot.arm()
        for (k in listOf(
            "offered", "taken", "superseded", "droppedBusy", "refusedAtAcquire", "allocFailed",
            "refusedPostAcquire", "droppedAtDisarm", "submitFailed", "workerThrew",
            "ingestWallMsP50", "workerIdleMsTotal",
        )) {
            assertEquals("$k must reset on arm", 0.0, slot.counters()[k])
        }
    }

    @Test
    fun `an arm that did NOTHING still reports — the 18-day silence must not repeat`() {
        val s = armed()
        s.disarm()
        val c = s.counters()
        assertEquals(0.0, c["ingested"])
        assertTrue((c["lastOutcome"] as String).isNotEmpty())
        assertTrue((c["note"] as String).contains("no pose ring"))
    }

    // ── THE INGEST OFFLOAD (2026-09-15) ─────────────────────────────────────
    //
    // The engine moved off the GL render thread because the viewport could not
    // be smoother than our ingest: GLSurfaceView swaps only when onDrawFrame
    // returns. These pin the two decisions that are easy to get wrong and whose
    // breakage is silent.

    @Test
    fun `a duplicate is refused before any buffer is taken`() {
        // A1.2 — THE NEW ORDER. With a latest-wins slot a frame is never
        // refused for backpressure, so the GL loop's re-render of a frame that
        // was ALREADY taken can be refused first — and must cost no buffer:
        // at 3.11 MB a frame, a pooled buffer per re-render would be the
        // allocation churn the pool exists to avoid.
        val s = armed()
        val slot = slot()
        val b = s.admit(1_000.0, 16, slot)
        assertNotNull(b)
        assertNull("the same frame again", s.admit(1_000.0, 16, slot))
        assertNull("one that went backwards", s.admit(999.0, 16, slot))
        assertEquals(2.0, s.counters()["skippedDuplicate"])
        // Only the first reached the slot: the duplicates were never OFFERED.
        assertEquals(1.0, slot.counters()["offered"])
        slot.returnBuffer(b!!)
    }

    @Test
    fun `a pool-exhaustion refusal does not advance the watermark`() {
        // THE RESCUE THE OLD ORDER EXISTED FOR, KEPT: if a buffer is ever
        // unavailable, the watermark stays put, so the GL loop's re-offer of
        // the SAME frame can still be taken when one frees up. With one
        // producer and three buffers exhaustion cannot happen in production;
        // it is forced here by holding all three.
        val s = armed()
        val slot = slot()
        val held = listOf(
            s.admit(1_000.0, 16, slot)!!, s.admit(1_001.0, 16, slot)!!, s.admit(1_002.0, 16, slot)!!,
        )
        assertNull(s.admit(1_003.0, 16, slot))                 // refused: pool out
        assertEquals(1.0, slot.counters()["droppedBusy"])
        assertEquals("a refusal is not a duplicate", 0.0, s.counters()["skippedDuplicate"])
        slot.returnBuffer(held[0])
        assertNotNull("the re-offered frame must still be acceptable", s.admit(1_003.0, 16, slot))
        assertEquals(0.0, s.counters()["skippedDuplicate"])
    }

    @Test
    fun `a disarm between the verdict and the buffer is a REFUSAL, not droppedBusy`() {
        // verdict B.1 — `droppedBusy == 0` is an A1 bar. A stop landing between
        // the GL thread's verdict and its acquire must not read as
        // backpressure, or the bar fails spuriously on every sweep's last tick.
        val s = armed()
        val slot = slot()
        assertEquals(ArFrameVerdict.INGEST, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        slot.disarm()                                           // the stop lands here
        assertNull(s.admit(1_000.0, 16, slot))
        assertEquals(0.0, slot.counters()["droppedBusy"])
        assertEquals(1.0, slot.counters()["refusedAtAcquire"])
        assertTrue((s.counters()["lastOutcome"] as String).contains("stopped"))
    }

    @Test
    fun `a buffer that cannot be allocated is labelled, keeps the frame re-offerable, and is partitioned`() {
        // The slot catches the allocation's OutOfMemory itself (acquire never
        // throws); here, the arm's side: the refusal is NAMED, the watermark
        // stays put so the GL loop's re-offer is taken, and the identities
        // close — with `offered` counting the frame TWICE, which is why the
        // note says requests, not distinct frames.
        val s = armed()
        val slot = slot { s.recordIngest(ran = true, wasPainted = false, outcome = 3) }
        assertEquals(ArFrameVerdict.INGEST, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        assertNull(s.admit(1_000.0, Int.MAX_VALUE, slot))        // the allocation throws
        assertTrue((s.counters()["lastOutcome"] as String).contains("could not be allocated"))
        assertEquals(ArFrameVerdict.INGEST, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        val b = s.admit(1_000.0, 16, slot)
        assertNotNull("the re-offered frame must still be acceptable", b)
        assertEquals(0.0, s.counters()["skippedDuplicate"])
        assertTrue(slot.submit(frame(b!!, 1_000.0)))
        assertTrue(slot.awaitIdle(2000))
        val c = s.counters(slot.counters())
        assertEquals(1.0, c["allocFailed"])
        assertEquals(2.0, c["offered"])
        assertEquals(0.0, c["droppedBusy"])
        assertEquals(true, c["identitySeenHolds"])
        assertEquals(true, c["identityOfferedHolds"])
        assertEquals(true, c["identityTakenHolds"])
    }

    @Test
    fun `seen and offered partition EXACTLY — the old seen-minus-duplicates identity is gone`() {
        // A1.2 — THE IDENTITIES THE PACK IS READ WITH, CLOSED.
        //   seen    = skippedNotArmed + skippedNotTracking + skippedBadGeometry
        //           + skippedDuplicate + offered
        //   offered = taken + superseded + droppedBusy + refusedAtAcquire
        //           + refusedPostAcquire + droppedAtDisarm + submitFailed
        //           + submitThrew + pendingNow
        //   taken   = ingested + engineThrew + workerThrew + inFlight
        // (allocFailed sits in `offered` too; see the allocation test above.)
        // The old note said distinct ~= seen - skippedDuplicate; under the
        // busy gate it was false (164 against 131 on the 2026-09-29 pack).
        val s = PanoPlusArArmState()
        val gate = CountDownLatch(1)
        val slot = slot { job ->
            gate.await(2, TimeUnit.SECONDS)
            s.recordIngest(ran = true, wasPainted = job.seq % 2L == 0L, outcome = 3)
        }
        s.verdict("normal", 1920, 1080, 1400.0, 1400.0)          // not armed yet
        s.arm()
        // Mirror process(): verdict, admit, copy, submit.
        fun offer(ts: Double, tracking: String = "normal") {
            if (s.verdict(tracking, 1920, 1080, 1400.0, 1400.0) != ArFrameVerdict.INGEST) return
            val b = s.admit(ts, 16, slot) ?: return
            slot.submit(frame(b, ts))
        }
        offer(1.0)                   // taken, blocks on the gate
        offer(1.0)                   // duplicate
        offer(2.0, "limited")        // not tracking
        offer(3.0)                   // pending
        offer(4.0)                   // supersedes 3
        offer(5.0)                   // supersedes 4
        assertEquals(ArFrameVerdict.INGEST, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        val b = s.admit(6.0, 16, slot)!!                        // a copy that "throws"
        slot.returnBuffer(b); s.recordSubmitThrew("OutOfMemoryError")
        gate.countDown()
        assertTrue(slot.awaitIdle(2000))
        val c = s.counters(slot.counters())
        assertEquals(true, c["identitySeenHolds"])
        assertEquals(true, c["identityOfferedHolds"])
        assertEquals(true, c["identityTakenHolds"])
        assertEquals(7.0, c["seen"])
        assertEquals(5.0, c["offered"])
        assertEquals(2.0, c["superseded"])
        assertEquals(2.0, c["ingested"])                        // 1 and 5
        assertEquals(0.0, c["droppedBusy"])
    }
    @Test
    fun `the pack note does NOT claim seen is what ARCore delivered`() {
        // The first version of this note shipped that claim into every pack. It
        // is false — see above — and a wrong identity in an artifact outlives
        // the person who wrote it.
        val note = armed().counters()["note"] as String
        assertTrue("the note must warn that seen is a render count", note.contains("GL RENDER TICK"))
        assertTrue(note.contains("skippedDuplicate"))
        // …and it states the EXACT identities, not the approximate one.
        assertTrue(note.contains("EXACT IDENTITIES"))
        assertTrue(note.contains("= taken + superseded + droppedBusy"))
        assertTrue(note.contains("allocFailed"))
        assertFalse(note.contains("DISTINCT CAMERA FRAMES ~= seen"))
        // `offered` is buffer REQUESTS: a busy or allocation refusal leaves the
        // watermark, and the re-offer is requested — and counted — again.
        assertFalse(note.contains("offered (DISTINCT frames"))
        assertTrue(note.contains("buffer requests"))
    }

    @Test
    fun `a throw is recorded rather than swallowed — the AR thread must survive it`() {
        val s = armed()
        s.recordThrew("IllegalStateException")
        assertEquals(1.0, s.counters()["ingestThrew"])
        assertTrue((s.counters()["lastOutcome"] as String).contains("IllegalStateException"))
    }

    @Test
    fun `the four kinds of throw are counted apart — only two of them lose a frame`() {
        // verdict B.2: one shared counter made the offered identity impossible
        // to close, because a pose-row throw is NOT a lost frame and a submit
        // throw is.
        val s = armed()
        s.recordPoseRowThrew("IOException")
        s.recordSubmitThrew("OutOfMemoryError")
        s.recordEngineThrew("IllegalStateException")
        s.recordRegisterThrew("NoClassDefFoundError")
        val c = s.counters()
        assertEquals(1.0, c["poseRowThrew"])
        assertEquals(1.0, c["submitThrew"])
        assertEquals(1.0, c["engineThrew"])
        assertEquals(1.0, c["registerThrew"])
        assertEquals("the pre-split total", 4.0, c["ingestThrew"])
    }

    @Test
    fun `the GL tick and the copy are timed — and an idle arm reports zeros, not absence`() {
        val s = armed()
        val c0 = s.counters()
        for (k in listOf("tickIntervalMsP50", "tickIntervalMsP99", "copyMsP50", "copyMsP99")) {
            assertEquals("$k on an idle arm", 0.0, c0[k])
        }
        s.noteTick(1_000_000_000L)
        s.noteTick(1_020_000_000L)                               // 20 ms later
        s.recordCopy(1.5)
        val c = s.counters()
        assertEquals(20.0, c["tickIntervalMsP50"] as Double, 1e-9)
        assertEquals(1.5, c["copyMsP50"] as Double, 1e-9)
        s.arm()
        assertEquals(0.0, s.counters()["tickIntervalMsP50"])
        // …and the previous TICK goes with them: the new sweep's first
        // interval is measured from its own first tick, never across the gap
        // between sweeps (here ~4 s, which would own the p99).
        s.noteTick(5_000_000_000L)
        s.noteTick(5_016_000_000L)
        assertEquals(16.0, s.counters()["tickIntervalMsP99"] as Double, 1e-9)
    }
}
