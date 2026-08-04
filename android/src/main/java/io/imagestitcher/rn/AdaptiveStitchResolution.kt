// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.content.Context
import android.content.SharedPreferences

/**
 * perf-4a — opt-in, MEASURED compositing-resolution adaptation.
 *
 * The correct replacement for the RAM-keyed cut removed in Phase 1: decide
 * whether to reduce compositing resolution from a PERSISTED ROLLING MEDIAN of
 * per-keyframe stitch wall time (`stitchWallMs / acceptedCount`, from the
 * Phase 0 `timings`) — the actual "is this device slow" signal — never from
 * RAM and never from a core-count guess.
 *
 * Two invariants make "measured" honest and keep the hysteresis alive:
 *
 *   1. **Measure before you cut.** Until a capture-config key has at least
 *      MIN_SAMPLES real default-budget samples, [evaluate] returns
 *      `adapt=false` (seeded). The finalize then runs at the DEFAULT budget and
 *      records a real sample, so the first cut is always driven by a genuine
 *      median of THIS device — not a heuristic that can never be corrected, and
 *      not one anomalous first capture (a cold start / thermal blip is exactly
 *      when the first stitch is slowest). (The old core-count seed cut on the
 *      first finalize, which then never recorded, permanently latching the
 *      regime — removed.)
 *
 *   2. **Keep measuring while cutting.** Cutting compose makes the run fast,
 *      but a cut run is NOT a default-budget sample, so recording it would
 *      corrupt the median — the caller skips it. Left alone that freezes the
 *      median above the threshold forever (the exit branch becomes dead code
 *      and a one-off thermal blip latches a permanent resolution cut). To keep
 *      the exit reachable, every [PROBE_EVERY]-th fired finalize is a PROBE:
 *      `adapt=false`, so it runs the default budget and records, letting a
 *      cooled device pull its median back under the exit line and un-fire.
 *
 * Hysteresis: enter above the threshold, exit below 0.8× — prevents flapping.
 * Fully off unless the host opts in (`adaptiveStitchResolution`); an opted-out
 * finalize still RECORDS its default-budget entry so a later opt-in starts
 * from measured history.
 *
 * This focused build does COMPOSE adaptation only (the real lever). The
 * registration-resolution adaptation + thermal signal from docs/perf-4a are
 * deferred: registration is a documented no-op on default 640px captures, and
 * needs the C++ per-cv-phase `registrationMs` (Phase 0 native timing) which is
 * not yet implemented.
 *
 * Storage: one SharedPreferences file, per capture-configuration key
 * (`v1|le=<longEdge>|kf=<maxCount>`). Per key: a CSV of the last N default-
 * budget `wallMs:acceptedCount` entries, a persisted `fired` boolean, and a
 * persisted probe counter driving the re-measure cadence.
 */
internal object AdaptiveStitchResolution {
    private const val PREFS = "rn-image-stitcher.adaptive-stitch"
    private const val MAX_ENTRIES = 5
    private const val MIN_SAMPLES = 3     // fire only once the median rests on ≥3 real samples
    private const val EXIT_MARGIN = 0.8   // exit hysteresis: median < 0.8×threshold clears fired
    private const val PROBE_EVERY = 4     // every Nth fired finalize re-measures at the default budget

    fun key(longEdge: Int, maxCount: Int): String = "v1|le=$longEdge|kf=$maxCount"

    /** Result of a fire decision. */
    data class Decision(
        /** True → cut compose to the floor for THIS run. */
        val adapt: Boolean,
        /** Rolling median of default-budget per-keyframe ms; null until measured. */
        val medianMsPerKeyframe: Double?,
        /** True → no measured history yet; running the default budget to measure. */
        val seeded: Boolean,
        /** True → a forced default-budget re-measure while in the fired regime. */
        val probe: Boolean,
    )

    /**
     * Decide whether to adapt for [key] against [thresholdMsPerFrame].
     *
     * Returns `adapt=false` (never cuts) until at least one measured sample
     * exists (seeded). Once history exists, applies hysteresis on the persisted
     * rolling median: enter > threshold, exit < 0.8×. While fired, every
     * [PROBE_EVERY]-th call is a probe (`adapt=false`) so the median can be
     * refreshed and the exit stays reachable.
     */
    fun evaluate(ctx: Context, key: String, thresholdMsPerFrame: Double): Decision {
        val prefs = prefs(ctx)
        val samples = sortedSamplesPerKeyframe(prefs, key)
        // Invariant 1 — measure before you cut. Require ≥ MIN_SAMPLES real
        // default-budget samples so the fire decision rests on a genuine median
        // and not one anomalous first capture (a cold start or thermal blip is
        // exactly when the first stitch is slowest). Until then: run the default
        // budget and record (seeded).
        if (samples.size < MIN_SAMPLES) {
            return Decision(adapt = false, medianMsPerKeyframe = null, seeded = true, probe = false)
        }
        val median = medianOf(samples)
        val wasFired = prefs.getBoolean(firedKey(key), false)
        val nowFired = when {
            median > thresholdMsPerFrame -> true
            median < EXIT_MARGIN * thresholdMsPerFrame -> false
            else -> wasFired   // inside the band → hold the current regime
        }
        if (nowFired != wasFired) {
            prefs.edit().putBoolean(firedKey(key), nowFired).apply()
        }
        if (!nowFired) {
            // Not slow → run default. Reset the probe cadence so a later
            // re-fire starts a fresh count.
            if (prefs.getInt(probeKey(key), 0) != 0) {
                prefs.edit().putInt(probeKey(key), 0).apply()
            }
            return Decision(adapt = false, medianMsPerKeyframe = median, seeded = false, probe = false)
        }
        // Invariant 2 — fired ⇒ cut, but periodically probe at the default
        // budget so the median can fall again and the exit hysteresis stays
        // reachable instead of freezing above the threshold forever.
        val n = prefs.getInt(probeKey(key), 0) + 1
        prefs.edit().putInt(probeKey(key), n).apply()
        val probe = n % PROBE_EVERY == 0
        return Decision(adapt = !probe, medianMsPerKeyframe = median, seeded = false, probe = probe)
    }

    /**
     * Record a DEFAULT-budget run's wall time (unconditional on opt-in, so
     * later opt-ins start from history). The caller MUST only pass runs that
     * actually ran at the default compositing budget (compose ≥ 1.0) and did
     * not ladder-escalate; a cut run is not a default-budget sample and would
     * corrupt the median. Skips zero/invalid samples. Keeps the last
     * [MAX_ENTRIES] per key.
     */
    fun recordDefaultRun(ctx: Context, key: String, wallMs: Long, acceptedCount: Int) {
        if (wallMs <= 0L || acceptedCount <= 0) return
        val prefs = prefs(ctx)
        val existing = prefs.getString(defKey(key), "").orEmpty()
            .split(",").filter { it.isNotBlank() }
        val next = (existing + "$wallMs:$acceptedCount").takeLast(MAX_ENTRIES)
        prefs.edit().putString(defKey(key), next.joinToString(",")).apply()
    }

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun defKey(key: String) = "$key|def"
    private fun firedKey(key: String) = "$key|fired"
    private fun probeKey(key: String) = "$key|pc"

    /** Parsed, sorted per-keyframe ms samples from the persisted default CSV. */
    private fun sortedSamplesPerKeyframe(prefs: SharedPreferences, key: String): List<Double> =
        prefs.getString(defKey(key), "").orEmpty()
            .split(",")
            .mapNotNull { entry ->
                val p = entry.split(":")
                if (p.size != 2) return@mapNotNull null
                val w = p[0].toLongOrNull() ?: return@mapNotNull null
                val n = p[1].toIntOrNull() ?: return@mapNotNull null
                if (n <= 0 || w <= 0) null else w.toDouble() / n
            }
            .sorted()

    /** Median of a pre-sorted, non-empty list. */
    private fun medianOf(sorted: List<Double>): Double {
        val mid = sorted.size / 2
        return if (sorted.size % 2 == 1) sorted[mid] else (sorted[mid - 1] + sorted[mid]) / 2.0
    }
}
