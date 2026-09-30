// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusPerf — the DEVICE STATE a sweep ran in, sampled at its start and its
// stop, for device.json's `perf` block on EVERY arm.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// The same A35 ran the same engine at 15 ms/frame at 16:38 and at 24 ms/frame
// at 16:35 on 2026-09-29, with no code change between the two — and an AR sweep
// taken just before them ran every native cost at ~1.9x. Nothing in any pack
// could say why: thermal throttling, a burst of GC, or background load all read
// the same from a timing block. A verdict judged on a pack taken in that state
// is judged on noise, so the pack now records the state:
//
//   · thermal status (PowerManager, API 29+) and the 10 s thermal headroom
//     (API 30+) at start and stop — throttling, named;
//   · ART's GC count, GC time and blocking-GC count over the sweep — churn;
//   · the process's CPU time over the sweep's wall time — load.
//
// Written on EVERY arm, so the vision-camera control sweep reports it too.
//
// ⚠ NEVER THROWS, AND NEVER GUESSES. Each reading is independently optional: an
// API level that lacks it, a stat the runtime does not publish or a NaN
// headroom is written as null, never as 0 — a 0 thermal status is "none", which
// is a measurement.

package io.imagestitcher.rn.panoplus

import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock

internal object PanoPlusPerf {

    /** One reading. Every field but the clocks may be null ("not available"). */
    internal class Sample(
        /** `SystemClock.elapsedRealtime()` — the monotonic clock the deltas use. */
        val elapsedMs: Long,
        /** `Process.getElapsedCpuTime()` — this process's CPU time, ms. */
        val processCpuMs: Long,
        val thermalStatus: Int?,
        val thermalHeadroom10s: Double?,
        val gcCount: Long?,
        val gcTimeMs: Long?,
        val blockingGcCount: Long?,
    )

    fun sample(ctx: Context?): Sample {
        var thermal: Int? = null
        var headroom: Double? = null
        try {
            val pm = ctx?.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (pm != null && Build.VERSION.SDK_INT >= 29) thermal = pm.currentThermalStatus
            if (pm != null && Build.VERSION.SDK_INT >= 30) {
                val h = pm.getThermalHeadroom(10).toDouble()
                if (h.isFinite()) headroom = h
            }
        } catch (_: Throwable) {
        }
        return Sample(
            elapsedMs = try { SystemClock.elapsedRealtime() } catch (_: Throwable) { 0L },
            processCpuMs = try { Process.getElapsedCpuTime() } catch (_: Throwable) { 0L },
            thermalStatus = thermal,
            thermalHeadroom10s = headroom,
            gcCount = runtimeStat("art.gc.gc-count"),
            gcTimeMs = runtimeStat("art.gc.gc-time"),
            blockingGcCount = runtimeStat("art.gc.blocking-gc-count"),
        )
    }

    private fun runtimeStat(name: String): Long? =
        try { Debug.getRuntimeStat(name)?.trim()?.toLongOrNull() } catch (_: Throwable) { null }

    /** PowerManager's THERMAL_STATUS_* as its documented name. */
    fun thermalName(status: Int?): String? = when (status) {
        null -> null
        0 -> "none"
        1 -> "light"
        2 -> "moderate"
        3 -> "severe"
        4 -> "critical"
        5 -> "emergency"
        6 -> "shutdown"
        else -> "unknown($status)"
    }

    private fun delta(a: Long?, b: Long?): Double? =
        if (a == null || b == null) null else (b - a).toDouble()

    /** A number, or JSON null — NOT [jnum]'s 0, which here would be a reading. */
    private fun Jo.numOrNull(k: String, v: Double?): Jo =
        if (v == null || !v.isFinite()) raw(k, "null") else n(k, v)

    /**
     * The `perf` block. [stop] is null for the start-of-sweep write (only the
     * start is known then); every delta is then null rather than 0.
     */
    fun toJson(start: Sample?, stop: Sample?): String {
        val wallMs = if (start != null && stop != null) (stop.elapsedMs - start.elapsedMs).toDouble() else null
        val cpuMs = if (start != null && stop != null) (stop.processCpuMs - start.processCpuMs).toDouble() else null
        return Jo()
            .i("thermalStatusStart", start?.thermalStatus)
            .s("thermalStatusStartName", thermalName(start?.thermalStatus))
            .i("thermalStatusStop", stop?.thermalStatus)
            .s("thermalStatusStopName", thermalName(stop?.thermalStatus))
            .numOrNull("thermalHeadroom10sStart", start?.thermalHeadroom10s)
            .numOrNull("thermalHeadroom10sStop", stop?.thermalHeadroom10s)
            .numOrNull("gcCount", delta(start?.gcCount, stop?.gcCount))
            .numOrNull("gcTimeMs", delta(start?.gcTimeMs, stop?.gcTimeMs))
            .numOrNull("blockingGcCount", delta(start?.blockingGcCount, stop?.blockingGcCount))
            .numOrNull("processCpuMs", cpuMs)
            .numOrNull("wallMs", wallMs)
            // Cores' worth of CPU the whole process used on average: 1.0 is
            // one core flat out. Separates "the phone was busy" from "we were".
            .numOrNull(
                "processCpuPerWall",
                if (wallMs != null && wallMs > 0.0 && cpuMs != null) cpuMs / wallMs else null,
            )
            .s(
                "note",
                "Device state across the sweep, start to stop (the start is sampled with " +
                    "the first device.json write). A teardown with no owner (the Activity " +
                    "destroyed or the module invalidated mid-sweep) takes no stop sample — it " +
                    "runs on the UI thread or RN's module queue — so its stop fields and " +
                    "deltas are null. thermalStatus is PowerManager's " +
                    "THERMAL_STATUS_* (API 29+), headroom getThermalHeadroom(10) (API 30+; " +
                    "1.0 = throttling imminent). gc*/processCpuMs are deltas over the sweep. " +
                    "null = not available on this device, never 0.",
            )
            .end()
    }
}
