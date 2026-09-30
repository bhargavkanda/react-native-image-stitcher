// SPDX-License-Identifier: Apache-2.0
//
// RNSARFrameStats — what the AR view's GL render loop spends each tick on,
// cheap enough to leave on.
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────────
//
// Everything a plugin on the AR session receives is paced by
// `RNSARCameraView.onDrawFrame`: the plugin loop runs INSIDE it, and a camera
// frame the loop never gets round to is a frame no plugin ever sees. On one
// field sweep the loop ticked at 26.8 Hz where it had ticked at ~57 Hz a
// fortnight earlier, and ~51 of ~182 camera frames were never offered to the
// sweep at all — and nothing in the pack could say where the tick had gone:
// `session.update()`, the background draw, the NV21 pack, a depth acquire, a
// point-cloud copy, another plugin, or simply a thread that was waiting for a
// core. The loop was untimed, and so was every consumer on it.
//
// So every tick is counted — including the ones that return early — and each
// stage is timed, together with the thread's CPU time over the tick (wall ≫ CPU
// is a thread that was runnable and not running) and the core it runs on.
//
// ── THE COST RULE ────────────────────────────────────────────────────────────
//
// ⚠ IT TIMES NOTHING UNLESS A SWEEP THAT REPORTS IT IS ARMED ([active]). The
// AR view is public, and most hosts that mount it never arm a sweep: for them
// the view skips its timed wrapper, [mark] hands back [NOT_TIMING] without
// reading a clock, and every other entry point here is one volatile read and a
// return. Nobody would ever read what they paid for.
//
// While armed it runs on the GL thread at the display rate, so it must not
// become the cost it measures: stages are an array indexed by enum ordinal (no
// map lookup, no boxing), [Stat.add] allocates nothing, and plugin timers are a
// ConcurrentHashMap keyed by the plugin's own name — the map is filled once
// per name on the GL thread and read by the recorder while the loop runs,
// which is exactly the insert-during-iteration a plain HashMap turns into a
// ConcurrentModificationException. It holds at most [PLUGIN_SLOTS] names, so a
// plugin whose name changes per call cannot grow it for the length of a sweep.
// The one allocation left is the core sample's file handle, on one tick in
// [CORE_SAMPLE_EVERY]; the line it reads is parsed in place.
//
// Process-wide, like the loop it describes. Started (and zeroed) only by the
// sweep arm that is going to report it, for the same reason the AR plugin's
// counters are, and stopped by that arm's disarm.

package io.imagestitcher.rn

import io.imagestitcher.rn.panoplus.Stat
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicLongArray

internal object RNSARFrameStats {

    /** The timed stages of one tick, in the order the loop runs them. */
    enum class Stage(val key: String) {
        /** `session.update()` — ARCore's own frame step. */
        UPDATE("update"),
        /** The camera background draw (CPU side; the GPU work is async). */
        DRAW("draw"),
        /** `RNSARSession.evaluatePlanesForFrame`. */
        PLANES("planes"),
        /** Overlay anchor reconcile + the overlay camera snapshot. */
        OVERLAY("overlay"),
        /** `acquireCameraImage` + `packNV21` — a fresh NV21 array per tick. */
        FORWARD("forward"),
        /** The keyframe stitcher's ingest, when capture is engaged. */
        STITCH_INGEST("stitchIngest"),
        /** The DEPTH16 acquire and row-pack (enableDepth / enableMesh). */
        DEPTH("depth"),
        /** The SLAM point-cloud acquire and copy (enableFeaturePoints). */
        POINT_CLOUD("pointCloud"),
        /** The per-frame image-metadata read for the plugins' exposure. */
        IMAGE_METADATA("imageMetadata"),
        /** The host-worklet fan-out. */
        WORKLETS("worklets"),
        /** The onArFrame metadata event. */
        AR_FRAME_META("arFrameMeta"),
    }

    /** One core sample per this many ticks — ~2-4 Hz at a 30-60 Hz loop. */
    const val CORE_SAMPLE_EVERY = 16L
    private const val CORE_SLOTS = 32
    /** Distinct plugin names timed per sweep; a name past these is counted
     *  in `pluginNamesOverflow` and not timed. */
    const val PLUGIN_SLOTS = 16
    /** What [mark] returns while nothing is being timed. */
    const val NOT_TIMING = Long.MIN_VALUE
    // The ASCII bytes the stat-line scan looks for.
    private const val RPAREN: Byte = 0x29   // ')'
    private const val SPACE: Byte = 0x20
    private const val NEWLINE: Byte = 0x0A
    private const val DIGIT_0: Byte = 0x30
    private const val DIGIT_9: Byte = 0x39

    /**
     * True from [start] to [stop] — while a sweep that reports these timers is
     * armed. Off by default: see the cost rule in the header.
     */
    @Volatile var active = false
        private set

    private val STAGES = Stage.values()
    private val stages = Array(STAGES.size) { Stat() }
    private val tickMs = Stat()
    private val tickCpuMs = Stat()
    private val tickIntervalMs = Stat()
    private val swapWaitMs = Stat()
    private val plugins = ConcurrentHashMap<String, Stat>()

    private val ticks = AtomicLong(0)
    private val ticksNoSession = AtomicLong(0)
    private val ticksPaused = AtomicLong(0)
    private val ticksUpdateThrew = AtomicLong(0)
    private val acquireFailed = AtomicLong(0)
    private val packNull = AtomicLong(0)
    private val noBridge = AtomicLong(0)
    private val reRenderTicks = AtomicLong(0)
    private val pluginNamesOverflow = AtomicLong(0)
    private val cores = AtomicLongArray(CORE_SLOTS)
    private val coreSamples = AtomicLong(0)
    private val coreUnknown = AtomicLong(0)

    // GL thread only, except for reset(); volatile so a reset from the
    // recorder is seen on the next tick.
    @Volatile private var lastTickStartNs = 0L
    @Volatile private var lastTickEndNs = 0L
    @Volatile private var coreSamplingBroken = false
    private val coreBuf = ByteArray(1024)

    /**
     * Zero everything and start timing. Called by the sweep arm that will
     * report it; zeroed FIRST, so the first tick timed is this sweep's.
     */
    fun start() {
        reset()
        active = true
    }

    /**
     * Stop timing. Called by the arm's disarm after it has frozen its
     * snapshot; what was recorded stays readable until the next [start].
     */
    fun stop() {
        active = false
    }

    /** Zero everything. [start] calls it; it does not change [active]. */
    fun reset() {
        for (s in stages) s.reset()
        tickMs.reset(); tickCpuMs.reset(); tickIntervalMs.reset(); swapWaitMs.reset()
        plugins.clear()
        ticks.set(0); ticksNoSession.set(0); ticksPaused.set(0); ticksUpdateThrew.set(0)
        acquireFailed.set(0); packNull.set(0); noBridge.set(0); reRenderTicks.set(0)
        pluginNamesOverflow.set(0)
        for (i in 0 until CORE_SLOTS) cores.set(i, 0L)
        coreSamples.set(0); coreUnknown.set(0)
        lastTickStartNs = 0L
        lastTickEndNs = 0L
    }

    /**
     * The clock at the start of a timed span, or [NOT_TIMING] — without
     * reading the clock — while nothing is being timed. Close the span with
     * [stageSince].
     */
    fun mark(): Long = if (active) System.nanoTime() else NOT_TIMING

    /**
     * The top of a tick. Records the interval since the previous tick began
     * and the SWAP WAIT — the gap since the previous tick RETURNED, which is
     * where `eglSwapBuffers` and the vsync wait live. A tick that is short but
     * whose interval is long is a loop waiting on the display, not on work.
     */
    fun tickBegin(nowNs: Long) {
        if (!active) return
        ticks.incrementAndGet()
        val prevStart = lastTickStartNs
        val prevEnd = lastTickEndNs
        if (prevStart != 0L && nowNs > prevStart) tickIntervalMs.add((nowNs - prevStart) / 1e6)
        if (prevEnd != 0L && prevEnd >= prevStart && nowNs >= prevEnd) {
            swapWaitMs.add((nowNs - prevEnd) / 1e6)
        }
        lastTickStartNs = nowNs
    }

    /**
     * The bottom of a tick, whichever return it took. [cpuNs] is the GL
     * thread's CPU time over the tick, or negative when the platform cannot
     * say.
     */
    fun tickEnd(startNs: Long, endNs: Long, cpuNs: Long) {
        if (!active) return
        tickMs.add((endNs - startNs) / 1e6)
        if (cpuNs >= 0L) tickCpuMs.add(cpuNs / 1e6)
        lastTickEndNs = endNs
        if (ticks.get() % CORE_SAMPLE_EVERY == 0L) sampleCore()
    }

    fun stage(s: Stage, ns: Long) {
        if (!active) return
        stages[s.ordinal].add(ns / 1e6)
    }

    /** Close a span [mark] opened. Nothing when it was opened untimed. */
    fun stageSince(s: Stage, startNs: Long) {
        if (startNs == NOT_TIMING || !active) return
        stages[s.ordinal].add((System.nanoTime() - startNs) / 1e6)
    }

    /**
     * One plugin's `process()`, keyed by its own `name()`. At most
     * [PLUGIN_SLOTS] names are kept; a new name past them is counted, not
     * timed.
     */
    fun plugin(name: String, ns: Long) {
        if (!active) return
        val st = plugins[name] ?: run {
            if (plugins.size >= PLUGIN_SLOTS) {
                pluginNamesOverflow.incrementAndGet()
                return
            }
            plugins.putIfAbsent(name, Stat()) ?: plugins[name]
        } ?: return
        st.add(ns / 1e6)
    }

    fun countNoSession() { if (active) ticksNoSession.incrementAndGet() }
    fun countPaused() { if (active) ticksPaused.incrementAndGet() }
    fun countUpdateThrew() { if (active) ticksUpdateThrew.incrementAndGet() }
    fun countAcquireFailed() { if (active) acquireFailed.incrementAndGet() }
    fun countPackNull() { if (active) packNull.incrementAndGet() }
    fun countNoBridge() { if (active) noBridge.incrementAndGet() }
    fun countReRender() { if (active) reRenderTicks.incrementAndGet() }

    /** Record which core the GL thread is on (tests feed it directly). */
    fun noteCore(core: Int) {
        if (!active) return
        coreSamples.incrementAndGet()
        if (core in 0 until CORE_SLOTS) cores.incrementAndGet(core) else coreUnknown.incrementAndGet()
    }

    /**
     * Where the GL thread runs. There is no Java API for the current CPU, so
     * this reads `processor` (field 39) of `/proc/thread-self/stat` on one tick
     * in [CORE_SAMPLE_EVERY]. A platform without it fails once and stops
     * trying — a missing sample is reported as zero samples, never guessed.
     */
    private fun sampleCore() {
        if (coreSamplingBroken) return
        try {
            val n = java.io.FileInputStream("/proc/thread-self/stat").use { it.read(coreBuf) }
            if (n <= 0) { coreSamplingBroken = true; return }
            noteCore(parseStatProcessor(coreBuf, n))
        } catch (_: Throwable) {
            coreSamplingBroken = true
        }
    }

    /**
     * Field 39 (`processor`) of a `/proc/<pid>/task/<tid>/stat` line held in
     * the first [n] bytes of [buf], or -1. Scanned in place — no String, no
     * split — and counted from the LAST ')', because the command name in
     * field 2 may itself contain spaces and parentheses.
     */
    fun parseStatProcessor(buf: ByteArray, n: Int): Int {
        val end = minOf(n, buf.size)
        var i = end - 1
        while (i >= 0 && buf[i] != RPAREN) i--
        if (i < 0) return -1
        i++
        // The ')' closes field 2, so the first token after it is field 3.
        var field = 2
        while (i < end) {
            while (i < end && (buf[i] == SPACE || buf[i] == NEWLINE)) i++
            if (i >= end) return -1
            field++
            if (field == 39) {
                var v = 0
                var digits = 0
                while (i < end && buf[i] in DIGIT_0..DIGIT_9) {
                    if (++digits > 6) return -1
                    v = v * 10 + (buf[i] - DIGIT_0)
                    i++
                }
                // The field must END here: "12x" is not a core index.
                if (digits == 0 || (i < end && buf[i] != SPACE && buf[i] != NEWLINE)) return -1
                return v
            }
            while (i < end && buf[i] != SPACE && buf[i] != NEWLINE) i++
        }
        return -1
    }

    /**
     * Everything above as FLAT Doubles and Booleans only, so the recorder's
     * generic counter serializers carry it without a case for it.
     */
    fun snapshot(): Map<String, Any> {
        val m = LinkedHashMap<String, Any>()
        m["ticks"] = ticks.get().toDouble()
        m["ticksNoSession"] = ticksNoSession.get().toDouble()
        m["ticksPaused"] = ticksPaused.get().toDouble()
        m["ticksUpdateThrew"] = ticksUpdateThrew.get().toDouble()
        m["tickMsP50"] = tickMs.p50()
        m["tickMsP99"] = tickMs.p99()
        m["tickMsMax"] = tickMs.max()
        m["tickCpuMsP50"] = tickCpuMs.p50()
        m["tickCpuMsP99"] = tickCpuMs.p99()
        m["tickIntervalMsP50"] = tickIntervalMs.p50()
        m["tickIntervalMsP99"] = tickIntervalMs.p99()
        m["swapWaitMsP50"] = swapWaitMs.p50()
        m["swapWaitMsP99"] = swapWaitMs.p99()
        for (s in STAGES) {
            val st = stages[s.ordinal]
            m["${s.key}MsP50"] = st.p50()
            m["${s.key}MsP99"] = st.p99()
            m["${s.key}N"] = st.count().toDouble()
        }
        m["acquireFailed"] = acquireFailed.get().toDouble()
        m["packNull"] = packNull.get().toDouble()
        m["noBridge"] = noBridge.get().toDouble()
        m["reRenderTicks"] = reRenderTicks.get().toDouble()
        m["glCoreSamples"] = coreSamples.get().toDouble()
        m["glCoreUnknown"] = coreUnknown.get().toDouble()
        for (i in 0 until CORE_SLOTS) {
            val c = cores.get(i)
            if (c > 0L) m["glCore.$i"] = c.toDouble()
        }
        m["glCoreSamplingAvailable"] = !coreSamplingBroken
        m["pluginNamesOverflow"] = pluginNamesOverflow.get().toDouble()
        for (name in plugins.keys.sorted()) {
            val st = plugins[name] ?: continue
            m["plugin.$name.msP50"] = st.p50()
            m["plugin.$name.msP99"] = st.p99()
            m["plugin.$name.n"] = st.count().toDouble()
        }
        return m
    }
}
