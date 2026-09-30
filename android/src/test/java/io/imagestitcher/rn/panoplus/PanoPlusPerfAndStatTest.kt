// SPDX-License-Identifier: Apache-2.0
//
// A1.0 — the device-state block every pack now carries (`perf`), and the
// reservoir every timing block is built from (`Stat`, moved out of the
// recorder and given the p99 the new `…P99` keys promise).
//
// `perf` is read to decide whether a pack was taken on a phone in a nominal
// state — the 2026-09-29 AR pack was taken at ~1.9x cost with nothing in it to
// say so. So the rule under test is the one that keeps it honest: a reading the
// device could not give is NULL, never 0, because 0 is a thermal status and a
// GC count.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusPerfAndStatTest {

    private fun sample(
        elapsedMs: Long, cpuMs: Long, thermal: Int? = 0, headroom: Double? = 0.4,
        gc: Long? = 10L, gcMs: Long? = 100L, blocking: Long? = 1L,
    ) = PanoPlusPerf.Sample(elapsedMs, cpuMs, thermal, headroom, gc, gcMs, blocking)

    @Test
    fun `the perf block reports deltas over the sweep and the thermal state at each end`() {
        val j = PanoPlusPerf.toJson(
            sample(1_000L, 500L, thermal = 0),
            sample(7_000L, 9_500L, thermal = 2, headroom = 0.8, gc = 14L, gcMs = 160L, blocking = 2L),
        )
        assertTrue(j, j.contains("\"thermalStatusStart\":0"))
        assertTrue(j, j.contains("\"thermalStatusStartName\":\"none\""))
        assertTrue(j, j.contains("\"thermalStatusStop\":2"))
        assertTrue(j, j.contains("\"thermalStatusStopName\":\"moderate\""))
        assertTrue(j, j.contains("\"gcCount\":4.0"))
        assertTrue(j, j.contains("\"gcTimeMs\":60.0"))
        assertTrue(j, j.contains("\"blockingGcCount\":1.0"))
        assertTrue(j, j.contains("\"processCpuMs\":9000.0"))
        assertTrue(j, j.contains("\"wallMs\":6000.0"))
        assertTrue(j, j.contains("\"processCpuPerWall\":1.5"))
    }

    @Test
    fun `a reading the device cannot give is null — never a 0 that reads as a measurement`() {
        val j = PanoPlusPerf.toJson(
            sample(1_000L, 0L, thermal = null, headroom = null, gc = null, gcMs = null, blocking = null),
            sample(2_000L, 0L, thermal = null, headroom = null, gc = null, gcMs = null, blocking = null),
        )
        for (k in listOf(
            "thermalStatusStart", "thermalStatusStop", "thermalHeadroom10sStart",
            "thermalHeadroom10sStop", "gcCount", "gcTimeMs", "blockingGcCount",
        )) {
            assertTrue("$k: $j", j.contains("\"$k\":null"))
        }
    }

    @Test
    fun `the start-of-sweep write has no stop, so every delta is null`() {
        val j = PanoPlusPerf.toJson(sample(1_000L, 500L), null)
        for (k in listOf("gcCount", "processCpuMs", "wallMs", "processCpuPerWall", "thermalStatusStop")) {
            assertTrue("$k: $j", j.contains("\"$k\":null"))
        }
        assertTrue(j.contains("\"thermalStatusStart\":0"))
    }

    @Test
    fun `sampling never throws off-device`() {
        // Every Android call here is a unit-test stub; the point is that a
        // platform refusing all of them still yields a sample, not a throw
        // inside writeDeviceJson.
        val s = PanoPlusPerf.sample(null)
        assertEquals(null, s.thermalStatus)
        PanoPlusPerf.toJson(s, PanoPlusPerf.sample(null))
    }

    @Test
    fun `Stat carries a p99 and a max, and its JSON block gains the p99`() {
        val st = Stat()
        for (i in 1..100) st.add(i.toDouble())
        assertEquals(51.0, st.p50(), 0.0)
        assertEquals(99.0, st.p99(), 0.0)
        assertEquals(100.0, st.max(), 0.0)
        assertEquals(5050.0, st.sum(), 0.0)
        assertTrue(st.toJson(), st.toJson().contains("\"p99\":99.0"))
        st.reset()
        assertEquals(0L, st.count())
        assertEquals(0.0, st.p99(), 0.0)
        assertEquals(0.0, st.max(), 0.0)
    }

    @Test
    fun `Stat ignores non-finite samples rather than poisoning a percentile`() {
        val st = Stat()
        st.add(Double.NaN); st.add(Double.POSITIVE_INFINITY); st.add(3.0)
        assertEquals(1L, st.count())
        assertEquals(3.0, st.p99(), 0.0)
    }
}
