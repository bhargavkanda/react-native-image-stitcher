// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusStat — the bounded timing reservoir the recorder's device.json
// blocks are built from, in its own file so the arms and the AR view's GL-loop
// timers can use the SAME one.
//
// Moved out of PanoPlusAndroidRecorder.kt unchanged in behaviour, with one
// addition: a p99. The capture-loop instrumentation (A1.0) reports tail
// latency — a GL tick that is 16 ms at p50 and 120 ms at p99 is a stutter the
// p50 cannot show — and a reservoir with no p99 made every `…P99` key a
// promise nothing could keep.
//
// ⚠ ALLOCATION-FREE ON `add`. It is called on the GL render thread and on the
// ingest workers, once or more per frame; anything allocated there would itself
// become the GC churn it exists to measure. Only the READERS (`toJson`, `p50`,
// `p99`) copy the buffer, and they run once per status poll or pack write.

package io.imagestitcher.rn.panoplus

/** Running min / mean / max / p50 / p99 over a bounded reservoir. */
internal class Stat(private val cap: Int = 512) {
    private val buf = DoubleArray(cap)
    private var n = 0L
    private var sum = 0.0
    private var lo = Double.MAX_VALUE
    private var hi = -Double.MAX_VALUE
    @Synchronized fun add(v: Double) {
        if (!v.isFinite()) return
        if (n < cap) buf[n.toInt()] = v else buf[(n % cap).toInt()] = v
        n++; sum += v
        if (v < lo) lo = v
        if (v > hi) hi = v
    }
    @Synchronized fun toJson(): String {
        if (n == 0L) return Jo().i("n", 0L).end()
        val k = minOf(n, cap.toLong()).toInt()
        val c = buf.copyOf(k); c.sort()
        return Jo().i("n", n).n("min", lo).n("p50", c[k / 2]).n("p99", c[pctIndex(k, 0.99)])
            .n("mean", sum / n).n("max", hi).end()
    }
    @Synchronized fun count(): Long = n

    /**
     * The p50, for the ONE consumer that needs a number rather than a JSON
     * block: the live status the panel polls at 2 Hz while the sweep runs.
     * `toJson()` stays the authority for the pack — this is the same sample
     * set read a cheaper way.
     */
    @Synchronized fun p50(): Double {
        if (n == 0L) return 0.0
        val k = minOf(n, cap.toLong()).toInt()
        val c = buf.copyOf(k); c.sort()
        return c[k / 2]
    }

    /** The p99 of the retained samples (0 when there are none). */
    @Synchronized fun p99(): Double {
        if (n == 0L) return 0.0
        val k = minOf(n, cap.toLong()).toInt()
        val c = buf.copyOf(k); c.sort()
        return c[pctIndex(k, 0.99)]
    }

    /** The largest sample ever added (0 when there are none). */
    @Synchronized fun max(): Double = if (n == 0L) 0.0 else hi

    /** The sum of every sample ever added — for totals such as idle time. */
    @Synchronized fun sum(): Double = sum

    /** Forget everything — for a process-wide timer re-armed per sweep. */
    @Synchronized fun reset() {
        n = 0L; sum = 0.0
        lo = Double.MAX_VALUE
        hi = -Double.MAX_VALUE
    }

    private fun pctIndex(k: Int, p: Double): Int =
        Math.round(p * (k - 1)).toInt().coerceIn(0, k - 1)
}
