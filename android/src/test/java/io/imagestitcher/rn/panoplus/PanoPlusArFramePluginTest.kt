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

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusArFramePluginTest {

    private fun armed() = PanoPlusArArmState().apply { arm() }

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
    fun `a good tracking frame is admitted, and the sequence advances only then`() {
        val s = armed()
        assertEquals(ArFrameVerdict.INGEST, s.verdict("normal", 1920, 1080, 1400.0, 1400.0))
        assertEquals(0L, s.nextSeq())
        assertEquals(1L, s.nextSeq())
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
        s.arm()
        for (k in listOf(
            "ingested", "painted", "skippedNotTracking", "skippedBadGeometry", "ingestThrew",
            // Added with the ingest offload. Listed explicitly rather than
            // derived from counters().keys so that a NEW counter which someone
            // forgets to reset fails this test instead of silently joining it.
            "seen", "droppedBusy",
        )) {
            assertEquals("$k must reset on arm", 0.0, s.counters()[k])
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
    fun `a busy-dropped frame is counted, and does NOT advance the duplicate watermark`() {
        // THE ORDERING THE PRODUCTION CODE DEPENDS ON. process() takes the busy
        // gate BEFORE acceptTs, so a frame refused for backpressure leaves the
        // watermark untouched and the GL loop's re-offer of that SAME frame can
        // still be taken. Reversing it loses the frame for good — a whole camera
        // period per busy cycle, measured at roughly a third of the engine's
        // input. This test is what makes that reversal fail loudly.
        val s = armed()
        assertTrue(s.acceptTs(1_000.0))          // frame A: taken
        s.recordDroppedBusy()                    // frame B: refused by the gate...
        assertEquals(1.0, s.counters()["droppedBusy"])
        // ...and because the gate ran FIRST, B never reached acceptTs. Its
        // re-offer is therefore still new, not a duplicate.
        assertTrue("the re-offered frame must still be acceptable", s.acceptTs(1_001.0))
        assertEquals("a gate refusal is not a duplicate", 0.0, s.counters()["skippedDuplicate"])
    }

    @Test
    fun `seen counts every call, so seen minus duplicates is the distinct-frame count`() {
        // `seen` is a RENDER count, not a delivery count — the GL loop re-offers
        // the same ARCore frame until a newer one lands. An investigation has
        // already been misled by reading it as frames delivered, so the identity
        // it is safe to use is pinned here.
        val s = armed()
        repeat(3) { s.verdict("normal", 1920, 1080, 1400.0, 1400.0) }
        assertTrue(s.acceptTs(2_000.0))
        assertTrue(!s.acceptTs(2_000.0))         // the GL thread re-rendered it
        assertTrue(!s.acceptTs(2_000.0))         // and again
        assertEquals(3.0, s.counters()["seen"])
        assertEquals(2.0, s.counters()["skippedDuplicate"])
        val distinct = (s.counters()["seen"] as Double) - (s.counters()["skippedDuplicate"] as Double)
        assertEquals(1.0, distinct, 0.0)
    }

    @Test
    fun `the pack note does NOT claim seen is what ARCore delivered`() {
        // The first version of this note shipped that claim into every pack. It
        // is false — see above — and a wrong identity in an artifact outlives
        // the person who wrote it.
        val note = armed().counters()["note"] as String
        assertTrue("the note must warn that seen is a render count", note.contains("GL RENDER TICK"))
        assertTrue(note.contains("skippedDuplicate"))
    }

    @Test
    fun `a throw is recorded rather than swallowed — the AR thread must survive it`() {
        val s = armed()
        s.recordThrew("IllegalStateException")
        assertEquals(1.0, s.counters()["ingestThrew"])
        assertTrue((s.counters()["lastOutcome"] as String).contains("IllegalStateException"))
    }
}
