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
    private val ingested = AtomicLong(0)
    private val painted = AtomicLong(0)
    /**
     * A call that arrived while the arm was NOT armed. Not a refusal — the
     * plugin stays registered across the AR view's lifecycle, so it is silence
     * — but counted, because without it `seen` cannot be partitioned.
     */
    private val skippedNotArmed = AtomicLong(0)
    private val skippedNotTracking = AtomicLong(0)
    private val skippedBadGeometry = AtomicLong(0)
    private val skippedDuplicate = AtomicLong(0)

    // ── THE THROWS, SPLIT (A1.2) ─────────────────────────────────────────
    // One `ingestThrew` used to count four different things — a registry
    // registration, a pose-row write, a failed hand-off and an engine throw —
    // and only ONE of them is a frame the engine lost. The offered-frame
    // identity cannot close over a counter that mixes them, so each is its own.
    /** The registry refused `register` at arm. No frame is involved. */
    private val registerThrew = AtomicLong(0)
    /** The `attitude_arcore.jsonl` sink threw for a frame. The frame itself
     *  still went on through the gates — this is a lost POSE ROW. */
    private val poseRowThrew = AtomicLong(0)
    /** A throw between the buffer and the hand-off (the copy, an OOM): the
     *  buffer was returned and the frame lost. A bucket of `offered`. */
    private val submitThrew = AtomicLong(0)
    /** The engine call threw on the worker. A bucket of the slot's `taken`. */
    private val engineThrew = AtomicLong(0)

    /** Interval between successive `process` calls — the GL tick as the arm
     *  sees it. GL thread only. */
    private val tickIntervalMs = Stat()
    @Volatile private var lastTickNs = 0L
    /** The GL thread's copy of one frame (arraycopy + the pose/intrinsics). */
    private val copyMs = Stat()

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
     * until a newer one lands. The frames that passed the gates are the
     * slot's `offered` (distinct unless `droppedBusy` or `allocFailed` > 0) —
     * see the identities in [counters].
     */
    private val seen = AtomicLong(0)

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
        ingested.set(0); painted.set(0)
        skippedNotArmed.set(0); skippedNotTracking.set(0); skippedBadGeometry.set(0)
        skippedDuplicate.set(0); seen.set(0)
        registerThrew.set(0); poseRowThrew.set(0); submitThrew.set(0); engineThrew.set(0)
        tickIntervalMs.reset(); copyMs.reset(); lastTickNs = 0L
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
        if (!armed.get()) {
            skippedNotArmed.incrementAndGet()
            return ArFrameVerdict.NOT_ARMED
        }
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
     * Second gate, and it needs the timestamp: is this a frame the engine has
     * already been offered? See [lastTsNs] for why every other frame is a
     * repeat. Counts `skippedDuplicate` when it is.
     *
     * ⚠ IT DOES NOT ADVANCE THE WATERMARK — [commitTs] does, and only once
     * the frame has a buffer (A1.2). The split is what lets the duplicate
     * check come BEFORE any buffer is taken while a frame that could not get
     * one stays re-offerable: the GL loop hands the same frame back on its
     * next tick, and a watermark already advanced would refuse it for good.
     *
     * Check-then-set across the two calls is safe because both run on the GL
     * thread, from the plugin's `process`, and nowhere else.
     */
    fun isDuplicate(tsNs: Double): Boolean {
        val prev = lastTsNs.get()
        if (prev != Long.MIN_VALUE && tsNs.toLong() <= prev) {
            skippedDuplicate.incrementAndGet()
            lastOutcome = "skipped: duplicate frame (the GL thread re-rendered it)"
            return true
        }
        return false
    }

    /** The frame at [tsNs] is being handed to the engine: advance the watermark. */
    fun commitTs(tsNs: Double) {
        lastTsNs.set(tsNs.toLong())
    }

    /**
     * [isDuplicate] then [commitTs], for a caller with nothing to do between
     * them. Separate from [verdict] because it MUTATES the accepted timestamp,
     * so it must run exactly once per frame and only after every other check
     * has passed — a duplicate that was going to be refused for bad geometry
     * should not advance the watermark.
     */
    fun acceptTs(tsNs: Double): Boolean {
        if (isDuplicate(tsNs)) return false
        commitTs(tsNs)
        return true
    }

    /**
     * Steps 3-5 of the plugin's `process`, AFTER a verdict of INGEST — here so
     * the ORDER is a unit test away (the plugin class is not; see the header):
     *
     *   3. a duplicate is refused BEFORE any buffer is taken;
     *   4. the slot is asked for a buffer — from here the frame is OFFERED
     *      and the slot counts it; null means the sweep stopped between the
     *      verdict and this call, the pool is exhausted, or a new buffer
     *      could not be allocated;
     *   5. only a frame that GOT a buffer advances the watermark, so the GL
     *      loop's re-offer of a frame that did not can still be taken.
     *
     * Returns the buffer to copy the frame into, or null. GL thread only.
     */
    fun admit(tsNs: Double, bytes: Int, slot: PanoPlusArIngestSlot): ByteArray? {
        if (isDuplicate(tsNs)) return null
        val buf = slot.acquire(bytes)
        if (buf == null) {
            noteAcquireRefused(slot.lastAcquireRefusal())
            return null
        }
        commitTs(tsNs)
        return buf
    }

    /** The top of `process`: one GL tick as the arm sees it. GL thread only. */
    fun noteTick(nowNs: Long) {
        val prev = lastTickNs
        if (prev != 0L && nowNs > prev) tickIntervalMs.add((nowNs - prev) / 1e6)
        lastTickNs = nowNs
    }

    /** The GL thread's copy of one frame into the slot's buffer. */
    fun recordCopy(ms: Double) {
        copyMs.add(ms)
    }

    fun recordIngest(ran: Boolean, wasPainted: Boolean, outcome: Int) {
        ingested.incrementAndGet()
        if (wasPainted) painted.incrementAndGet()
        lastOutcome = if (ran) "outcome $outcome" else "engine did not run"
    }

    /** The engine call threw on the worker. Kept under its old name for the
     *  callers that predate the split; it means [recordEngineThrew]. */
    fun recordThrew(what: String) = recordEngineThrew(what)

    fun recordEngineThrew(what: String) {
        engineThrew.incrementAndGet()
        lastOutcome = "ingest threw $what"
    }

    fun recordSubmitThrew(what: String) {
        submitThrew.incrementAndGet()
        lastOutcome = "hand-off threw $what"
    }

    fun recordPoseRowThrew(what: String) {
        poseRowThrew.incrementAndGet()
        lastOutcome = "pose row threw $what"
    }

    /**
     * The registry refused at arm. Recorded AFTER [arm] — which zeroes every
     * counter — or it is erased the instant it is counted, which is what the
     * single `ingestThrew` used to do to it.
     */
    fun recordRegisterThrew(what: String) {
        registerThrew.incrementAndGet()
        lastOutcome = "register threw $what"
    }

    /** The slot refused a buffer, and why ([PanoPlusArIngestSlot.acquire]). */
    fun noteAcquireRefused(why: PanoPlusArIngestSlot.AcquireRefusal) {
        lastOutcome = when (why) {
            PanoPlusArIngestSlot.AcquireRefusal.DISARMED ->
                "refused: the sweep stopped between the gate and the buffer"
            PanoPlusArIngestSlot.AcquireRefusal.ALLOC_FAILED ->
                "dropped: a frame buffer could not be allocated (out of memory)"
            else -> "dropped: every pooled buffer was in use"
        }
    }

    /**
     * Everything the arm did, as plain values, merged with the ingest slot's
     * own counters ([PanoPlusArIngestSlot.counters]; empty when there is none).
     *
     * ⚠ IT REPORTS EVEN WHEN THE ARM DID NOTHING. `ingested = 0` has to be as
     * visible as a painted count, because a silent arm looking identical to an
     * unselected one is how the shared-camera arm shipped broken for 18 days.
     *
     * ⚠ AND IT STATES ITS OWN IDENTITIES, AND CHECKS THEM. The note used to say
     * DISTINCT ≈ seen − skippedDuplicate, and under the busy gate that was
     * FALSE: a refused re-offer was counted as `droppedBusy`, not as a
     * duplicate — measured 164 against the sidecar's 131 distinct frames on
     * the 2026-09-29 pack. The two below are exact once the arm is quiet (the
     * stop's device.json), and `identity*Holds` says whether they did.
     */
    fun counters(slot: Map<String, Any> = emptyMap()): Map<String, Any> {
        fun d(k: String): Double = (slot[k] as? Double) ?: 0.0
        val totalThrew = registerThrew.get() + poseRowThrew.get() + submitThrew.get() + engineThrew.get()
        val m = linkedMapOf<String, Any>(
            "armed" to armed.get(),
            // FIRST, because it is the number that decides where to look: compare
            // it with the ledger's row count before reading anything else here.
            "seen" to seen.get().toDouble(),
            "ingested" to ingested.get().toDouble(),
            "painted" to painted.get().toDouble(),
            "skippedNotArmed" to skippedNotArmed.get().toDouble(),
            "skippedNotTracking" to skippedNotTracking.get().toDouble(),
            "skippedBadGeometry" to skippedBadGeometry.get().toDouble(),
            "skippedDuplicate" to skippedDuplicate.get().toDouble(),
            // Present on every pack, with the slot's count when there is one:
            // under latest-wins it must be 0, and 0 has to be SAID.
            "droppedBusy" to d("droppedBusy"),
            "registerThrew" to registerThrew.get().toDouble(),
            "poseRowThrew" to poseRowThrew.get().toDouble(),
            "submitThrew" to submitThrew.get().toDouble(),
            "engineThrew" to engineThrew.get().toDouble(),
            // The pre-split total, kept so an older reader's key still means
            // "something threw" — never read it as frames lost.
            "ingestThrew" to totalThrew.toDouble(),
            "tickIntervalMsP50" to tickIntervalMs.p50(),
            "tickIntervalMsP99" to tickIntervalMs.p99(),
            "copyMsP50" to copyMs.p50(),
            "copyMsP99" to copyMs.p99(),
            "lastOutcome" to lastOutcome,
        )
        for ((k, v) in slot) if (k != "droppedBusy") m[k] = v
        if (slot.isNotEmpty()) {
            val seenSum = skippedNotArmed.get() + skippedNotTracking.get() + skippedBadGeometry.get() +
                skippedDuplicate.get() + d("offered").toLong()
            val offeredSum = d("taken") + d("superseded") + d("droppedBusy") + d("refusedAtAcquire") +
                d("allocFailed") + d("refusedPostAcquire") + d("droppedAtDisarm") + d("submitFailed") +
                submitThrew.get().toDouble() + d("pendingNow")
            val takenSum = ingested.get().toDouble() + engineThrew.get().toDouble() +
                d("workerThrew") + d("inFlight")
            m["identitySeenHolds"] = seenSum == seen.get()
            m["identityOfferedHolds"] = offeredSum == d("offered")
            m["identityTakenHolds"] = takenSum == d("taken")
        }
        m["note"] = (
            "pano+ riding the stitcher's ARCore session. The pose arrives WITH " +
                "the pixels, so there is no pose ring, no bracket tolerance and " +
                "no shared-camera handover on this arm. " +
                "⚠ READ `seen` CAREFULLY: it counts EVERY call into the plugin, " +
                "which is one per GL RENDER TICK, not one per camera frame. The " +
                "GL loop free-runs at the display rate and ARCore is in " +
                "LATEST_CAMERA_IMAGE, so the SAME frame is re-offered until a " +
                "newer one lands; `seen` is a render count and must not be " +
                "compared with the ledger's row count as if it were a delivery " +
                "count. EXACT IDENTITIES (at the stop): seen = skippedNotArmed + " +
                "skippedNotTracking + skippedBadGeometry + skippedDuplicate + " +
                "offered; offered (buffer requests for frames that passed the " +
                "gates — distinct frames unless droppedBusy or allocFailed > 0, " +
                "whose re-offer is requested again) = taken + superseded + " +
                "droppedBusy + " +
                "refusedAtAcquire + allocFailed + refusedPostAcquire + " +
                "droppedAtDisarm + submitFailed + submitThrew + pendingNow; " +
                "taken = ingested + engineThrew + " +
                "workerThrew + inFlight. The old 'distinct ~= seen - " +
                "skippedDuplicate' was FALSE under the one-in-flight busy gate " +
                "(a refused re-offer counted as droppedBusy, not as a duplicate: " +
                "164 against 131 distinct on the 2026-09-29 pack). Under the " +
                "latest-wins slot droppedBusy must be 0; the loss that remains " +
                "is `superseded` — a frame replaced by a newer one while the " +
                "engine was busy."
            )
        return m
    }
}
