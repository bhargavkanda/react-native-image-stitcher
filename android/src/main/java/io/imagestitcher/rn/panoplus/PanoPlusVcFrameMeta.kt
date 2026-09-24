// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import android.graphics.Rect
import android.content.Context

/**
 * What a vision-camera frame's `CaptureResult` says about it (M4).
 *
 * ⚠ WHY THIS EXISTS. The vision-camera arm used to run with NO capture
 * metadata: the engine's exposure normalisation was fed zeros (the gain
 * chain's `expGain` read identically 1.000 on 93% of packs), the intrinsics
 * assumed the default crop, and there was no way to tell whether an exposure
 * lock held.
 *
 * ⚠ AND THE FRAME ITSELF CANNOT CARRY IT (M4 review, measured in the CameraX
 * 1.5.0-alpha03 bytecode vision-camera 4.7 pins): ImageAnalysis reads from an
 * isolated `AndroidImageReaderProxy` (no metadata reader), and
 * `ImageAnalysisAbstractAnalyzer` re-wraps every image in a
 * `SettableImageProxy` with an `ImmutableImageInfo` before the analyzer sees
 * it — so no analysis frame ever pairs with its result. The first version of
 * this arm read `frame.imageProxy.imageInfo` for one and got null on every
 * frame. The results come instead from a CAPTURE-RESULT LISTENER on
 * vision-camera's camera (`RNSCaptureResultTap`, the plan's M4(b) route),
 * pushed into a [PanoPlusVcResultRing] and JOINED to each frame by
 * `SENSOR_TIMESTAMP` (== `Image.timestamp`) on the sink's worker thread,
 * with a bounded wait and a counted miss.
 *
 * Vision-camera-independent on purpose, so the always-compiled recorder can
 * hold it on a build without vision-camera.
 */
internal data class PanoPlusVcFrameMeta(
    /** SENSOR_EXPOSURE_TIME, ns; 0 when the result did not carry it. */
    val exposureTimeNs: Long,
    /** SENSOR_SENSITIVITY (ISO); 0 when absent. */
    val iso: Int,
    /** CONTROL_AE_LOCK as the result reports it — the lock READ-BACK. */
    val aeLock: Boolean?,
    val awbLock: Boolean?,
    val aeState: Int?,
    val afMode: Int?,
    /** LENS_FOCUS_DISTANCE, diopters — what a focus lock pins. */
    val focusDistance: Float?,
    val oisMode: Int?,
    val videoStabMode: Int?,
    /** SCALER_CROP_REGION — the region of the ACTIVE array this frame shows. */
    val cropRegion: Rect?,
    /** CONTROL_ZOOM_RATIO (API 30+). */
    val zoomRatio: Float?,
    /** LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID (API 29+): which lens it came from. */
    val activePhysicalId: String?,
    /** SENSOR_TIMESTAMP, ns — the join key against `Image.timestamp`; 0 = absent. */
    val sensorTimestampNs: Long = 0L,
    /** CONTROL_AF_STATE — the settle gate pins focus only once it has settled. */
    val afState: Int? = null,
    /** CONTROL_AWB_STATE. */
    val awbState: Int? = null,
)

/**
 * The AE/AWB lock, OIS/EIS off and a frozen focus on the camera
 * VISION-CAMERA opened — the set the Camera2 arm asserts on its own repeating
 * request, which a sweep on vision-camera's camera used to go without — and
 * the capture-result tap that makes the lock verifiable.
 *
 * Implemented in PanoPlusVcCameraControl (vision-camera-only sources) and
 * reached through [PanoPlusVcBridge], so this package still builds without
 * vision-camera.
 */
internal interface PanoPlusVcCameraLock {
    /**
     * Resolve vision-camera's CameraX camera behind [viewTag] and apply the
     * lock. Asynchronous (the view is resolved on the UI thread); [onResult]
     * receives `state` and a detail string:
     *   · `applied` — CameraX reports the options took effect;
     *   · `apply-failed` — CameraX refused them;
     *   · `cancelled` — [unlock] ran before the lock did, so it was NOT applied;
     *   · `unavailable` — some link to the camera is missing.
     * FAILS CLOSED: any missing link is "unavailable", never a guess.
     */
    fun lock(
        ctx: Context,
        viewTag: Int,
        focusDistance: Float?,
        onResult: (state: String, detail: String) -> Unit,
    )

    /**
     * Clear everything [lock] applied, and CANCEL a lock still waiting to run
     * (M4 review: a lock posted before a teardown used to land after it and
     * stay on the camera). Idempotent; safe from any thread.
     */
    fun unlock(): String

    /** A lock this process applied and has not cleared. */
    val isLocked: Boolean

    /**
     * Start delivering vision-camera's capture results to [onMeta] (on the
     * camera's executor — keep it cheap). [onResult] reports `attached` /
     * `cancelled` / `unavailable` with a detail, exactly like [lock].
     */
    fun attachResults(
        ctx: Context,
        viewTag: Int,
        onMeta: (PanoPlusVcFrameMeta) -> Unit,
        onResult: (state: String, detail: String) -> Unit,
    )

    /** Stop the delivery [attachResults] started, or cancel it if pending. */
    fun detachResults(): String
}

/** The vision-camera-only half registers itself here at plugin registration. */
internal object PanoPlusVcBridge {
    @Volatile var cameraLock: PanoPlusVcCameraLock? = null
}

/**
 * A GENERATION GATE: work posted to another thread runs only if nothing has
 * invalidated the gate since it was posted.
 *
 * The M4 review's major finding in one class: `lock()` posted `applyLock` to
 * the UI thread and `unlock()` ran synchronously, so a teardown that won the
 * race found nothing to clear and the lock landed a moment later, pinning the
 * exposure of every photo after the sweep. With the gate, [invalidate] (the
 * unlock) bumps the generation under the same monitor [runIfCurrent] holds,
 * so a lock posted before it can never apply after it.
 */
internal class PanoPlusGenGate {
    private val mon = Any()
    private var gen = 0L

    /** The ticket a posted job must present. */
    fun ticket(): Long = synchronized(mon) { gen }

    /** Run [block] only if nothing invalidated the gate since [ticket]; else null. */
    fun <T> runIfCurrent(ticket: Long, block: () -> T): T? = synchronized(mon) {
        if (gen != ticket) null else block()
    }

    /** Invalidate every outstanding ticket, then run [block] under the same monitor. */
    fun <T> invalidate(block: () -> T): T = synchronized(mon) {
        gen += 1
        block()
    }
}

/**
 * Capture results for the frames vision-camera is delivering, keyed by
 * SENSOR_TIMESTAMP, for the sink worker to JOIN against each frame's
 * `Image.timestamp`. Bounded: the oldest result is evicted past [capacity].
 */
internal class PanoPlusVcResultRing(private val capacity: Int = 48) {
    private val lock = Object()
    private val byTs = LinkedHashMap<Long, PanoPlusVcFrameMeta>()
    private var received = 0L

    val resultsReceived: Long get() = synchronized(lock) { received }

    fun put(m: PanoPlusVcFrameMeta) {
        if (m.sensorTimestampNs == 0L) return
        synchronized(lock) {
            byTs[m.sensorTimestampNs] = m
            received += 1
            while (byTs.size > capacity) {
                val eldest = byTs.keys.iterator().next()
                byTs.remove(eldest)
            }
            lock.notifyAll()
        }
    }

    /**
     * The result for [tsNs], waiting up to [waitMs] for it to arrive (results
     * can land a little after their image). Null on a miss — the caller counts
     * it; nothing is ever interpolated or borrowed from a neighbour.
     */
    fun await(tsNs: Long, waitMs: Long): PanoPlusVcFrameMeta? {
        val deadline = System.nanoTime() + waitMs.coerceAtLeast(0L) * 1_000_000L
        synchronized(lock) {
            while (true) {
                byTs.remove(tsNs)?.let { return it }
                val remainingNs = deadline - System.nanoTime()
                if (remainingNs <= 0L) return null
                try {
                    lock.wait(remainingNs / 1_000_000L, (remainingNs % 1_000_000L).toInt())
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return null
                }
            }
        }
    }

    fun clear() { synchronized(lock) { byTs.clear(); received = 0L } }
}

/**
 * WHEN TO TAKE THE LOCK (M4 review): not on the first frame, but once
 * metering has settled — [stableNeeded] consecutive results with AE
 * CONVERGED / FLASH_REQUIRED / LOCKED (and AWB CONVERGED where reported) — or
 * at [ceilingMs] after the first frame, whichever comes first. The Camera2 arm
 * and the iOS lock both settle before they lock; a sweep started while AE was
 * still searching would otherwise be pinned to a transitional exposure for
 * its whole length.
 *
 * Focus is pinned only when AF has SETTLED at the lock (PASSIVE_FOCUSED /
 * FOCUSED_LOCKED); otherwise AF is left running and the decision says so.
 */
internal class PanoPlusVcSettle(
    private val stableNeeded: Int,
    private val ceilingMs: Double,
) {
    data class Decision(
        /** `converged` / `ceiling` / `ceiling-no-results`. */
        val reason: String,
        /** Focus to pin, or null to leave AF running. */
        val focusDistance: Float?,
        val aeStateAtLock: Int?,
        val afStateAtLock: Int?,
        val settleMs: Double,
        val resultsSeen: Int,
    )

    private var firstMs = Double.NaN
    private var stableRun = 0
    private var seen = 0
    private var decided = false

    /** Feed one frame; returns the decision exactly once, else null. */
    fun feed(meta: PanoPlusVcFrameMeta?, nowMs: Double): Decision? {
        if (decided) return null
        if (firstMs.isNaN()) firstMs = nowMs
        val elapsed = nowMs - firstMs
        if (meta != null) {
            seen += 1
            val aeOk = meta.aeState == AE_CONVERGED || meta.aeState == AE_LOCKED ||
                meta.aeState == AE_FLASH_REQUIRED
            val awbOk = meta.awbState == null || meta.awbState == AWB_CONVERGED ||
                meta.awbState == AWB_LOCKED
            stableRun = if (aeOk && awbOk) stableRun + 1 else 0
        }
        val reason = when {
            meta != null && stableNeeded > 0 && stableRun >= stableNeeded -> "converged"
            meta != null && stableNeeded <= 0 -> "converged"
            elapsed >= ceilingMs -> if (seen == 0) "ceiling-no-results" else "ceiling"
            else -> return null
        }
        decided = true
        val afSettled = meta?.afState == AF_PASSIVE_FOCUSED || meta?.afState == AF_FOCUSED_LOCKED
        return Decision(
            reason = reason,
            focusDistance = if (afSettled) meta?.focusDistance else null,
            aeStateAtLock = meta?.aeState,
            afStateAtLock = meta?.afState,
            settleMs = elapsed,
            resultsSeen = seen,
        )
    }

    companion object {
        // CaptureResult constants, restated so this class needs no Android jar.
        const val AE_CONVERGED = 2
        const val AE_LOCKED = 3
        const val AE_FLASH_REQUIRED = 4
        const val AWB_CONVERGED = 2
        const val AWB_LOCKED = 3
        const val AF_PASSIVE_FOCUSED = 2
        const val AF_FOCUSED_LOCKED = 4
    }
}

/**
 * THE LOCK'S VERDICT, derived — never left for a reader to assemble from
 * counters (M4 review: `aeLockedFrames == framesAfterLock` was vacuously true
 * at 0 == 0, i.e. an unverified lock read as held).
 *
 *   · `unverified` — no capture result followed the lock (or none reported
 *     the lock engaged), so nothing can be said;
 *   · `held` — from the FIRST result reporting AE locked, every result
 *     reported AE (and AWB) locked, with one exposure and one ISO;
 *   · `not-held` — otherwise.
 *
 * The window starts at the first LOCKED result rather than at the request,
 * because the 2–6 frames already in the pipeline when the options land were
 * captured under the old request and would fail a lock that did hold.
 */
internal fun panoVcLockVerdict(
    resultsAfterFirstLocked: Long,
    aeLockedAfterFirstLocked: Long,
    awbLockedAfterFirstLocked: Long,
    expMinNs: Long,
    expMaxNs: Long,
    isoMin: Int,
    isoMax: Int,
): String = when {
    resultsAfterFirstLocked <= 0L -> "unverified"
    aeLockedAfterFirstLocked == resultsAfterFirstLocked &&
        awbLockedAfterFirstLocked == resultsAfterFirstLocked &&
        expMinNs == expMaxNs && isoMin == isoMax -> "held"
    else -> "not-held"
}
