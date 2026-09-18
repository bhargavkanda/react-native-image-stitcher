// SPDX-License-Identifier: Apache-2.0
//
// The memo's gating rules, which are the only part of the 2026-09-10 settle
// change that can be tested off a device. The settle predicate itself lives
// inside a CameraCaptureSession.CaptureCallback and is exercised on hardware;
// what IS testable here is the contract the predicate leans on — that a memo
// from the wrong camera, or a stale one, or one without an exposure pair, is
// never handed back as usable.

package io.imagestitcher.rn.panoplus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusMeteringMemoTest {

    @After
    fun tearDown() {
        PanoPlusMeteringMemo.clear()
    }

    // A fixed synthetic clock: SystemClock is a framework stub that throws in a
    // plain JVM test, and the memo takes the clock as a parameter precisely so
    // these tests need no Robolectric and no returnDefaultValues.
    private val now = 10_000_000_000L  // 10 s in elapsed-realtime nanoseconds

    private fun memo(
        cameraId: String = "0",
        ageMs: Long = 0,
        exposureTimeNs: Long? = 8_330_000L,
        sensitivityIso: Int? = 320,
    ) = PanoPlusMetering(
        cameraId = cameraId,
        atElapsedNs = now - ageMs * 1_000_000L,
        exposureTimeNs = exposureTimeNs,
        sensitivityIso = sensitivityIso,
        frameDurationNs = 33_320_000L,
        focusDistanceDiopters = 1.34f,
        aeState = 2,
        awbState = 2,
        colorGains = floatArrayOf(1.9f, 1.0f, 1.0f, 1.6f),
    )

    @Test
    fun `an empty memo answers null rather than throwing`() {
        assertNull(PanoPlusMeteringMemo.get("0", 4000.0, now))
        assertNull(PanoPlusMeteringMemo.peek())
    }

    @Test
    fun `a fresh memo on the same camera comes back`() {
        PanoPlusMeteringMemo.put(memo())
        val got = PanoPlusMeteringMemo.get("0", 4000.0, now)
        assertNotNull(got)
        assertEquals(8_330_000L, got!!.exposureTimeNs)
        assertEquals(320, got.sensitivityIso)
    }

    @Test
    fun `a memo from a different camera is refused`() {
        // The A35's ultra-wide is camera 2 and its 1x is camera 0. Metering
        // from one lens says nothing usable about the other, and a sweep that
        // silently seeded across lenses would be the hardest kind of bug to
        // see: plausible numbers, wrong scene scale.
        PanoPlusMeteringMemo.put(memo(cameraId = "2"))
        assertNull(PanoPlusMeteringMemo.get("0", 4000.0, now))
        // ...but it stays readable for the audit trail, which is what
        // device.json prints when it explains the refusal.
        assertEquals("2", PanoPlusMeteringMemo.peek()?.cameraId)
    }

    @Test
    fun `a stale memo is refused and the limit is the caller's`() {
        PanoPlusMeteringMemo.put(memo(ageMs = 5_000))
        assertNull(PanoPlusMeteringMemo.get("0", 4000.0, now))
        // The same memo, with a caller willing to accept it, comes back. The
        // object holds no expiry policy of its own by design.
        assertNotNull(PanoPlusMeteringMemo.get("0", 60_000.0, now))
    }

    @Test
    fun `a zero age limit refuses even a memo taken this instant`() {
        // This is how the settle is switched off: meteringMemoMaxAgeMs=0. The
        // recorder short-circuits before calling get(), but the boundary must
        // hold here too or the flag would depend on which caller asked.
        PanoPlusMeteringMemo.put(memo(ageMs = 1))
        assertNull(PanoPlusMeteringMemo.get("0", 0.0, now))
    }

    @Test
    fun `a memo without an exposure pair is reported not usable`() {
        // A LIMITED-level HAL may publish neither key. hasExposurePair is what
        // stops that becoming a comparison against nulls in the settle.
        assertFalse(memo(exposureTimeNs = null).hasExposurePair())
        assertFalse(memo(sensitivityIso = null).hasExposurePair())
        assertTrue(memo().hasExposurePair())
    }

    @Test
    fun `last writer wins — there is one slot and the newest scene is the right one`() {
        PanoPlusMeteringMemo.put(memo(exposureTimeNs = 8_330_000L, sensitivityIso = 100))
        PanoPlusMeteringMemo.put(memo(exposureTimeNs = 33_320_000L, sensitivityIso = 800))
        val got = PanoPlusMeteringMemo.get("0", 4000.0, now)!!
        assertEquals(33_320_000L, got.exposureTimeNs)
        assertEquals(800, got.sensitivityIso)
    }

    @Test
    fun `clear drops it, so a lens change cannot leave the old lens's light behind`() {
        PanoPlusMeteringMemo.put(memo())
        PanoPlusMeteringMemo.clear()
        assertNull(PanoPlusMeteringMemo.get("0", 4000.0, now))
        assertNull(PanoPlusMeteringMemo.peek())
    }

    @Test
    fun `ageMs grows and is measured against the caller's own clock read`() {
        val m = memo(ageMs = 250)
        assertEquals(250.0, m.ageMs(now), 0.001)
        assertEquals(1250.0, m.ageMs(now + 1_000_000_000L), 0.001)
    }
}
