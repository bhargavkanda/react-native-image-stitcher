// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusArArmState — the pano+ AR-plugin arm's gating and counters, as a
// plain class that implements NOTHING.
//
// ⚠ IT IS SPLIT OUT SO IT CAN BE TESTED. PanoPlusArFramePlugin implements
// io.imagestitcher.rn.ARFramePlugin, which is compileOnly here (the host app
// provides it at runtime). Kotlin cannot even REFERENCE a class whose supertype
// it cannot resolve, so any unit test naming the plugin fails to compile — and
// putting the SPI on the test classpath breaks PanoPlusArCoreModeTest, which
// asserts the SPI is absent in a unit-test JVM. Both routes were tried.
//
// So the decisions live here, in front of the engine, where a test can reach
// them, and the plugin class is reduced to marshalling.
//
// The decisions matter: the SHARED-camera arm produced zero painted strips for
// eighteen days while looking exactly like an arm that was never selected, so
// every refusal is counted and named rather than dropped.

package io.imagestitcher.rn.panoplus

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Why a frame did not reach the engine, or that it did. */
internal enum class ArFrameVerdict { INGEST, NOT_ARMED, NOT_TRACKING, BAD_GEOMETRY, DUPLICATE }

/**
 * The stitcher's tracking CONTRACT string for "tracking is good".
 *
 * ARFrameContext documents the field as "normal" | "limited" | "notAvailable",
 * matching the engine's own ingest vocabulary on both platforms. It is NOT the
 * ARCore enum name, and mistaking the two is how the first working AR sweep
 * refused all 472 of its frames.
 */
internal const val TRACKING_NORMAL = "normal"

internal class PanoPlusArArmState {

    private val armed = AtomicBoolean(false)
    private val seq = AtomicLong(0)
    private val ingested = AtomicLong(0)
    private val painted = AtomicLong(0)
    private val skippedNotTracking = AtomicLong(0)
    private val skippedBadGeometry = AtomicLong(0)
    private val ingestThrew = AtomicLong(0)
    private val skippedDuplicate = AtomicLong(0)

    /**
     * EVERY call into the plugin, counted before any gate can refuse it.
     *
     * ⚠ WITHOUT THIS THE ARM CANNOT BE DIAGNOSED, and the 2026-09-11 AR pack
     * proved it: the sweep painted 99 strips from 130 ledger rows and NOTHING
     * anywhere could say whether ARCore had delivered 130 frames or 300 and we
     * had refused the difference. Every other counter here is a count of
     * REFUSALS, so they can only ever explain frames we were given — the one
     * number that separates "we dropped them" from "they never arrived" was
     * the one number missing.
     *
     * ⚠ BUT IT IS A RENDER COUNT, NOT A DELIVERY COUNT, and the difference has
     * already misled one investigation. `process` is invoked once per GL RENDER
     * TICK; the loop free-runs at the display rate while ARCore is in
     * LATEST_CAMERA_IMAGE, so the same camera frame is handed to us repeatedly
     * until a newer one lands. Distinct camera frames is `seen -
     * skippedDuplicate`, and THAT is the number to compare with the ledger.
     */
    private val seen = AtomicLong(0)

    /**
     * Frames refused because the previous frame's ingest was still running.
     *
     * The same bounded backpressure the Camera2 arm applies
     * (PanoPlusAndroidRecorder's `droppedBusy`): a gate, never a queue. See the
     * offload comment in PanoPlusArFramePlugin.process for why the alternative
     * is worse than the loss this counts.
     */
    private val droppedBusy = AtomicLong(0)

    /**
     * The last ARCore frame timestamp handed to the engine.
     *
     * ⚠ THE AR ARM DELIVERS EVERY FRAME TWICE, AND IT IS NOT A BUG UPSTREAM.
     * The stitcher runs its plugin pass from the GL render thread, which draws
     * at the display rate, while ARCore produces camera frames at ~30 Hz. When
     * `Session.update()` has no new frame it returns the SAME one, unchanged
     * timestamp and all, so roughly every other render repeats.
     *
     * Measured on the operator's first working AR sweep: 53 of 333 rows carried
     * a timestamp <= the previous row's, at rows 3, 5, 7, 9, 11 … — every other
     * row. The engine refused all 53 as `rejected-input`, which is correct but
     * wasteful: it doubled the bootstrap (53 frames against the IMU arm's 8)
     * because half of what it was fed could never advance the chain.
     *
     * A plugin must not hand the engine a frame it has already handed it. The
     * engine's own non-monotonic guard is a LAST line of defence, not a
     * de-duplicator.
     */
    private val lastTsNs = java.util.concurrent.atomic.AtomicLong(Long.MIN_VALUE)

    @Volatile
    var lastOutcome: String = "(no frame yet)"
        private set

    val isArmed: Boolean get() = armed.get()

    /** Arm for a sweep. Counters reset so a pack describes exactly ONE sweep. */
    fun arm() {
        seq.set(0); ingested.set(0); painted.set(0)
        skippedNotTracking.set(0); skippedBadGeometry.set(0); ingestThrew.set(0)
        skippedDuplicate.set(0); seen.set(0); droppedBusy.set(0)
        lastTsNs.set(Long.MIN_VALUE)
        lastOutcome = "(armed, no frame yet)"
        armed.set(true)
    }

    fun disarm() {
        armed.set(false)
    }

    /**
     * Decide whether this frame reaches the engine, and count the decision.
     *
     * TRACKING ONLY: the engine's reference latch needs consecutive frames whose
     * attitude it can trust, and a PAUSED ARCore pose is not one — feeding it
     * would put a stale or identity rotation into the chain and lean the canvas.
     *
     * The geometry floor is the engine's own: it refuses anything without a real
     * focal length (fx, fy > 1.0), and a zero-sized raster is not a frame.
     */
    fun verdict(trackingState: String, width: Int, height: Int, fx: Double, fy: Double): ArFrameVerdict {
        // COUNTED FIRST, BEFORE THE ARMED CHECK, because "the arm was not armed
        // and the session still called us 300 times" and "nobody called us at
        // all" are different findings and both are worth knowing.
        seen.incrementAndGet()
        if (!armed.get()) return ArFrameVerdict.NOT_ARMED
        // ⚠ THE CONTRACT STRING, NOT THE ARCore ENUM NAME. ARFrameContext.kt:71
        // states it: "normal" | "limited" | "notAvailable" — the same vocabulary
        // the engine's own ingest uses on iOS, deliberately, so one contract
        // spans both platforms. Checking for "TRACKING", which is the raw
        // com.google.ar.core.TrackingState name, refused 472 consecutive frames
        // on the operator's first working AR sweep with lastOutcome reading
        // "skipped: ARCore normal" — the gate printing the value it was
        // rejecting, which is the only reason this took minutes instead of days.
        if (trackingState != TRACKING_NORMAL) {
            skippedNotTracking.incrementAndGet()
            lastOutcome = "skipped: ARCore $trackingState"
            return ArFrameVerdict.NOT_TRACKING
        }
        if (width <= 0 || height <= 0 || fx <= 1.0 || fy <= 1.0) {
            skippedBadGeometry.incrementAndGet()
            lastOutcome = "skipped: bad frame geometry"
            return ArFrameVerdict.BAD_GEOMETRY
        }
        return ArFrameVerdict.INGEST
    }

    /**
     * Second gate, and it needs the timestamp: refuse a frame the engine has
     * already seen. See [lastTsNs] for why every other frame is a repeat.
     *
     * Separate from [verdict] because it MUTATES the accepted timestamp, so it
     * must run exactly once per frame and only after every other check has
     * passed — a duplicate that was going to be refused for bad geometry should
     * not advance the watermark.
     */
    fun acceptTs(tsNs: Double): Boolean {
        val t = tsNs.toLong()
        val prev = lastTsNs.get()
        if (prev != Long.MIN_VALUE && t <= prev) {
            skippedDuplicate.incrementAndGet()
            lastOutcome = "skipped: duplicate frame (the GL thread re-rendered it)"
            return false
        }
        lastTsNs.set(t)
        return true
    }

    /** The sequence number for a frame that passed [verdict]. */
    fun nextSeq(): Long = seq.getAndIncrement()

    fun recordIngest(ran: Boolean, wasPainted: Boolean, outcome: Int) {
        ingested.incrementAndGet()
        if (wasPainted) painted.incrementAndGet()
        lastOutcome = if (ran) "outcome $outcome" else "engine did not run"
    }

    fun recordThrew(what: String) {
        ingestThrew.incrementAndGet()
        lastOutcome = "ingest threw $what"
    }

    /** A frame arrived while the previous one was still being ingested. */
    fun recordDroppedBusy() {
        droppedBusy.incrementAndGet()
        lastOutcome = "dropped: previous ingest still running"
    }

    /**
     * Everything the arm did, as plain values.
     *
     * ⚠ IT REPORTS EVEN WHEN THE ARM DID NOTHING. `ingested = 0` has to be as
     * visible as a painted count, because a silent arm looking identical to an
     * unselected one is how the shared-camera arm shipped broken for 18 days.
     */
    fun counters(): Map<String, Any> = linkedMapOf(
        "armed" to armed.get(),
        // FIRST, because it is the number that decides where to look: compare
        // it with the ledger's row count before reading anything else here.
        "seen" to seen.get().toDouble(),
        "ingested" to ingested.get().toDouble(),
        "painted" to painted.get().toDouble(),
        "skippedNotTracking" to skippedNotTracking.get().toDouble(),
        "skippedBadGeometry" to skippedBadGeometry.get().toDouble(),
        "skippedDuplicate" to skippedDuplicate.get().toDouble(),
        "droppedBusy" to droppedBusy.get().toDouble(),
        "ingestThrew" to ingestThrew.get().toDouble(),
        "lastOutcome" to lastOutcome,
        "note" to (
            "pano+ riding the stitcher's ARCore session. The pose arrives WITH " +
                "the pixels, so there is no pose ring, no bracket tolerance and " +
                "no shared-camera handover on this arm. " +
                "⚠ READ `seen` CAREFULLY: it counts EVERY call into the plugin, " +
                "which is one per GL RENDER TICK, not one per camera frame. The " +
                "GL loop free-runs at the display rate and ARCore is in " +
                "LATEST_CAMERA_IMAGE, so the SAME frame is re-offered until a " +
                "newer one lands. DISTINCT CAMERA FRAMES ~= seen - " +
                "skippedDuplicate; `seen` itself is a render count and must not " +
                "be compared with the ledger's row count as if it were a " +
                "delivery count."
            ),
    )
}
