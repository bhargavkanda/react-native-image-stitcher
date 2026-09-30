// SPDX-License-Identifier: Apache-2.0
//
// A1.0 — the AR view's GL-loop timers.
//
// The loop itself needs a GL context and an ARCore session; what is under test
// is the bookkeeping the loop feeds, which is where a wrong number would be
// made: a tick interval measured from the wrong edge, a plugin timer keyed by
// the wrong name, a reset that misses a counter, a value type the pack's
// generic serializer cannot carry — or a timer that runs, and costs, in a host
// that never armed a sweep.

package io.imagestitcher.rn

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RNSARFrameStatsTest {

    @Before
    fun setUp() = RNSARFrameStats.start()

    @After
    fun tearDown() {
        RNSARFrameStats.stop()
        RNSARFrameStats.reset()
    }

    private fun d(k: String): Double = RNSARFrameStats.snapshot()[k] as Double

    private fun parse(line: String): Int {
        val b = line.toByteArray(Charsets.US_ASCII)
        return RNSARFrameStats.parseStatProcessor(b, b.size)
    }

    /** Every entry point the view calls, once. */
    private fun feedEverything() {
        RNSARFrameStats.tickBegin(1_000_000_000L)
        RNSARFrameStats.tickEnd(1_000_000_000L, 1_010_000_000L, 5_000_000L)
        RNSARFrameStats.countNoSession(); RNSARFrameStats.countPaused()
        RNSARFrameStats.countUpdateThrew(); RNSARFrameStats.countAcquireFailed()
        RNSARFrameStats.countPackNull(); RNSARFrameStats.countNoBridge()
        RNSARFrameStats.countReRender(); RNSARFrameStats.noteCore(5)
        RNSARFrameStats.stage(RNSARFrameStats.Stage.UPDATE, 2_000_000L)
        RNSARFrameStats.stageSince(RNSARFrameStats.Stage.DRAW, System.nanoTime() - 1_000_000L)
        RNSARFrameStats.plugin("sweepAr", 3_000_000L)
    }

    private fun assertAllZero(why: String) {
        val s = RNSARFrameStats.snapshot()
        for ((k, v) in s) {
            if (v is Double) assertEquals("$k: $why", 0.0, v, 0.0)
        }
        assertFalse(why, s.keys.any { it.startsWith("plugin.") || it.startsWith("glCore.") })
    }

    @Test
    fun `reset zeroes every counter and timer`() {
        feedEverything()
        assertEquals(1.0, d("drawN"), 0.0)
        RNSARFrameStats.reset()
        val s = RNSARFrameStats.snapshot()
        for ((k, v) in s) {
            if (v is Double) assertEquals("$k must reset", 0.0, v, 0.0)
        }
        // A plugin timer from the previous sweep must not survive as a key.
        assertFalse(s.keys.any { it.startsWith("plugin.") })
        assertNull(s["glCore.5"])
    }

    @Test
    fun `nothing is timed or counted until a sweep starts it — a host that never arms pays nothing`() {
        // The view is public and most hosts never arm a sweep: they must not
        // pay a clock read, a counter or a /proc read per tick for numbers
        // nobody reports. Off is the DEFAULT, and every entry point is inert.
        RNSARFrameStats.stop()
        RNSARFrameStats.reset()
        assertFalse(RNSARFrameStats.active)
        assertEquals("no clock is read", RNSARFrameStats.NOT_TIMING, RNSARFrameStats.mark())
        feedEverything()
        assertAllZero("recorded while inactive")
        // start() switches it on, zeroed.
        RNSARFrameStats.start()
        assertTrue(RNSARFrameStats.active)
        assertNotEquals(RNSARFrameStats.NOT_TIMING, RNSARFrameStats.mark())
        feedEverything()
        assertEquals(1.0, d("ticks"), 0.0)
        assertEquals(1.0, d("drawN"), 0.0)
    }

    @Test
    fun `stop keeps what the sweep recorded readable, and records nothing after it`() {
        feedEverything()
        RNSARFrameStats.stop()
        feedEverything()                                   // post-sweep ticks
        assertEquals(1.0, d("ticks"), 0.0)
        assertEquals(1.0, d("updateN"), 0.0)
        assertEquals(1.0, RNSARFrameStats.snapshot()["plugin.sweepAr.n"] as Double, 0.0)
        // The next sweep's start zeroes it.
        RNSARFrameStats.start()
        assertAllZero("the previous sweep leaked into this one")
    }

    @Test
    fun `a span is recorded only if timing was on when it OPENED and when it closed`() {
        // The arm can land, or the disarm, in the middle of a tick.
        RNSARFrameStats.stop()
        val openedOff = RNSARFrameStats.mark()
        RNSARFrameStats.start()
        RNSARFrameStats.stageSince(RNSARFrameStats.Stage.UPDATE, openedOff)
        assertEquals(0.0, d("updateN"), 0.0)
        val openedOn = RNSARFrameStats.mark()
        RNSARFrameStats.stop()
        RNSARFrameStats.stageSince(RNSARFrameStats.Stage.UPDATE, openedOn)
        assertEquals(0.0, d("updateN"), 0.0)
    }

    @Test
    fun `stageSince times the span from its mark`() {
        val t = RNSARFrameStats.mark()
        Thread.sleep(5)
        RNSARFrameStats.stageSince(RNSARFrameStats.Stage.WORKLETS, t)
        assertEquals(1.0, d("workletsN"), 0.0)
        assertTrue(d("workletsMsP50") >= 4.0)
    }

    @Test
    fun `a tick is timed start to end, and the interval and swap wait are measured from the right edges`() {
        // Tick 1: 0-10 ms. Tick 2 starts at 16 ms: interval 16 (start to
        // start), swap wait 6 (the previous RETURN to this start).
        RNSARFrameStats.tickBegin(1_000_000_000L)
        RNSARFrameStats.tickEnd(1_000_000_000L, 1_010_000_000L, 4_000_000L)
        RNSARFrameStats.tickBegin(1_016_000_000L)
        RNSARFrameStats.tickEnd(1_016_000_000L, 1_026_000_000L, 4_000_000L)
        assertEquals(2.0, d("ticks"), 0.0)
        assertEquals(10.0, d("tickMsP50"), 1e-9)
        assertEquals(4.0, d("tickCpuMsP50"), 1e-9)
        assertEquals(16.0, d("tickIntervalMsP50"), 1e-9)
        assertEquals(6.0, d("swapWaitMsP50"), 1e-9)
    }

    @Test
    fun `a platform with no thread CPU clock records no CPU sample rather than a zero`() {
        RNSARFrameStats.tickBegin(1_000_000_000L)
        RNSARFrameStats.tickEnd(1_000_000_000L, 1_010_000_000L, -1L)
        assertEquals(0.0, d("tickCpuMsP50"), 0.0)
        assertEquals(10.0, d("tickMsP50"), 1e-9)
    }

    @Test
    fun `plugin timers are keyed by the plugin's own name`() {
        RNSARFrameStats.plugin("sweepAr", 2_000_000L)
        RNSARFrameStats.plugin("sweepAr", 4_000_000L)
        RNSARFrameStats.plugin("hostLiveness", 9_000_000L)
        val s = RNSARFrameStats.snapshot()
        assertEquals(2.0, s["plugin.sweepAr.n"] as Double, 0.0)
        assertEquals(1.0, s["plugin.hostLiveness.n"] as Double, 0.0)
        assertEquals(9.0, s["plugin.hostLiveness.msP50"] as Double, 1e-9)
    }

    @Test
    fun `every stage reports its p50, p99 and count, idle or not`() {
        RNSARFrameStats.stage(RNSARFrameStats.Stage.DEPTH, 7_000_000L)
        val s = RNSARFrameStats.snapshot()
        for (st in RNSARFrameStats.Stage.values()) {
            assertTrue("${st.key}MsP50", s.containsKey("${st.key}MsP50"))
            assertTrue("${st.key}MsP99", s.containsKey("${st.key}MsP99"))
            assertTrue("${st.key}N", s.containsKey("${st.key}N"))
        }
        assertEquals(7.0, s["depthMsP50"] as Double, 1e-9)
        assertEquals(1.0, s["depthN"] as Double, 0.0)
        assertEquals(0.0, s["pointCloudN"] as Double, 0.0)
    }

    @Test
    fun `snapshot values are only Double or Boolean, so the pack's generic serializers carry them`() {
        RNSARFrameStats.tickBegin(1L); RNSARFrameStats.tickEnd(1L, 2L, 1L)
        RNSARFrameStats.plugin("sweepAr", 1L)
        RNSARFrameStats.noteCore(4)
        for ((k, v) in RNSARFrameStats.snapshot()) {
            assertTrue("$k is ${v.javaClass.simpleName}", v is Double || v is Boolean)
        }
    }

    @Test
    fun `a plugin first seen while the recorder snapshots is not a ConcurrentModificationException`() {
        // verdict B.4 — the map is filled on the GL thread and read by the
        // recorder's; a plain HashMap throws when a new key lands mid-read.
        // The map is capped, so it is emptied every PLUGIN_SLOTS names to keep
        // new keys landing (and keys vanishing) under the reader.
        val slots = RNSARFrameStats.PLUGIN_SLOTS
        val writer = Thread {
            for (i in 0 until 2000) {
                if (i % slots == 0) RNSARFrameStats.reset()
                RNSARFrameStats.plugin("p${i % slots}", 1_000L)
            }
        }
        writer.start()
        repeat(200) { RNSARFrameStats.snapshot() }
        writer.join()
        assertEquals(1.0, RNSARFrameStats.snapshot()["plugin.p${slots - 1}.n"] as Double, 0.0)
    }

    @Test
    fun `the plugin map is bounded — a name that changes per call cannot grow it for a sweep`() {
        val slots = RNSARFrameStats.PLUGIN_SLOTS
        for (i in 0 until slots + 5) RNSARFrameStats.plugin("p$i", 1_000L)
        RNSARFrameStats.plugin("p0", 1_000L)               // a kept name still times
        val s = RNSARFrameStats.snapshot()
        assertEquals(slots, s.keys.count { it.startsWith("plugin.") && it.endsWith(".n") })
        assertEquals(5.0, s["pluginNamesOverflow"] as Double, 0.0)
        assertEquals(2.0, s["plugin.p0.n"] as Double, 0.0)
        assertNull(s["plugin.p$slots.n"])
    }

    @Test
    fun `the GL thread's core is counted per core, and an impossible index is unknown`() {
        RNSARFrameStats.noteCore(6); RNSARFrameStats.noteCore(6); RNSARFrameStats.noteCore(2)
        RNSARFrameStats.noteCore(-1)
        assertEquals(4.0, d("glCoreSamples"), 0.0)
        assertEquals(2.0, d("glCore.6"), 0.0)
        assertEquals(1.0, d("glCore.2"), 0.0)
        assertEquals(1.0, d("glCoreUnknown"), 0.0)
    }

    @Test
    fun `the processor field is read from the LAST paren — a command name may contain spaces`() {
        // A real /proc/<pid>/task/<tid>/stat line (fields 3..52), with the
        // processor (field 39) set to 6 and a comm that contains ") (".
        val rest = (3..52).joinToString(" ") { f -> if (f == 39) "6" else if (f == 3) "R" else "0" }
        assertEquals(6, parse("1234 (GLThread 12) (x)) $rest\n"))
        assertEquals(-1, parse("garbage"))
        assertEquals(-1, parse("1 (short) R 0 0"))
        // Negative fields before it (priority, nice) are tokens like any other.
        val neg = (3..52).joinToString(" ") { f -> if (f == 39) "11" else if (f == 18) "-2" else "0" }
        assertEquals(11, parse("7 (GLThread) $neg"))
        // The field must END where its digits do.
        val bad = (3..52).joinToString(" ") { f -> if (f == 39) "6x" else "0" }
        assertEquals(-1, parse("7 (GLThread) $bad"))
    }

    @Test
    fun `the stat line is parsed in place, only up to the bytes this read returned`() {
        // The sampler reuses ONE buffer, so the bytes past this read's end are
        // a previous, longer line's. They must not be read as this one's.
        val longer = (3..52).joinToString(" ") { f -> if (f == 39) "3" else "0" }
        val buf = "99 (GLThread 99999999) $longer".toByteArray(Charsets.US_ASCII).copyOf(1024)
        val short = "1 (a) R 0 0".toByteArray(Charsets.US_ASCII)
        System.arraycopy(short, 0, buf, 0, short.size)
        assertEquals(-1, RNSARFrameStats.parseStatProcessor(buf, short.size))
        val ok = "1 (GLThread) $longer".toByteArray(Charsets.US_ASCII)
        System.arraycopy(ok, 0, buf, 0, ok.size)
        assertEquals(3, RNSARFrameStats.parseStatProcessor(buf, ok.size))
        // A count past the buffer is clamped, never an index error.
        assertEquals(3, RNSARFrameStats.parseStatProcessor(ok, ok.size + 100))
    }
}
