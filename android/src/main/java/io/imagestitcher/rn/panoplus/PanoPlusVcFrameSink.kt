// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The seam between a vision-camera Frame Processor and the sweep engine.
 *
 * ── WHY THIS IS A SEPARATE OBJECT FROM THE PLUGIN ───────────────────────
 * It holds NO vision-camera type. The plugin file that does is excluded from
 * the build on a consumer without vision-camera (see android/build.gradle),
 * and everything in here has to survive that exclusion: the recorder arms
 * this sink whether or not a plugin ever calls it, and `armedWithoutFeeder`
 * is how a sweep that was promised frames and never got any says so.
 *
 * ⚠ THAT COUNTER IS THE WHOLE REASON THIS CLASS HAS A DIAGNOSTIC AT ALL.
 * The AR plugin arm shipped once with its flag read WITHOUT its arm: an IMU
 * sweep took the no-camera branch, opened nothing, and sat waiting for
 * frames from a plugin the surface had correctly declined to mount. The
 * operator: "Even I switch off AR, I only see the AR tracking message and
 * nothing gets captured!!!!" A plugin arm must be able to prove its feeder
 * exists, not assume it.
 *
 * ── THE THREADING CONTRACT, WHICH IS NOT THE OBVIOUS ONE ────────────────
 * `PanoPlusLiveNative.ingest`'s own doc says to call it "from the recorder's
 * engine thread and NEVER from the camera callback", and the Camera2 arm
 * obeys that: it de-strides on the reader thread and posts the ingest to a
 * separate writer thread. This sink keeps that shape, and it matters more
 * under vision-camera than under Camera2 — vc runs its frame processor with
 * STRATEGY_BLOCK_PRODUCER on a single HandlerThread, so a synchronous ~30 ms
 * ingest does not drop a frame, it THROTTLES THE CAMERA. The de-stride must
 * still happen inside the callback (the Image dies on return), but the
 * engine call must not.
 *
 * So: the plugin copies pixels into a pooled buffer synchronously and hands
 * it here; this posts the ingest to [worker] and returns immediately. One
 * ingest in flight, dropped and counted — never a queue, because at ~3 MB a
 * frame a queue reaches a gigabyte in seconds of stall, which is the jetsam
 * kill the Camera2 arm's own comment refuses.
 */
internal object PanoPlusVcFrameSink {

    /** What the sink needs from whoever owns the sweep. Implemented by the
     *  recorder; an interface so the sink can be exercised without a camera,
     *  a sensor or a native library. */
    internal interface Host {
        /**
         * The attitude for this frame, already through basis C, plus the
         * engine's `tracking` for it.
         *
         * ⚠ `tracking == 2` MUST MEAN "a pose solved for THIS frame", not
         * "the sensor looks healthy". The engine latches its reference from
         * the first run of five consecutive 2s; a 2 backed by a stale sample
         * latches the datum the whole sweep is measured against onto a
         * rotation that was never observed.
         */
        fun solveAttitude(tsNs: Long): PanoPlusVcAttitude

        /** fx, fy, cx, cy for a frame of this size. Derived from
         *  CameraCharacteristics, NOT from a CaptureResult — vision-camera
         *  delivers no capture metadata, so there is no per-frame crop to
         *  map. Must return fx > 1.0 and fy > 1.0 or every frame is refused
         *  by the engine as RejectedInput, silently. */
        fun intrinsicsFor(width: Int, height: Int): DoubleArray

        /**
         * Record what the engine did with the frame, for the pack.
         *
         * ⚠ `ran` IS NOT `painted`, AND THE DEVICE GATE MUST READ THE
         * SECOND. The two most likely bring-up failures on this arm —
         * intrinsics resolving to 0, and tracking never reaching 2 — both
         * give 100% `ran` and 0% `painted`. A gate that checks "frames
         * reached the engine" passes on a sweep that painted nothing.
         */
        fun onVcFrameOutcome(ran: Boolean, painted: Boolean, outcome: Int, droppedBusy: Boolean)
    }

    /** Solved attitude for one frame. */
    internal data class PanoPlusVcAttitude(val q: DoubleArray, val tracking: Int) {
        override fun equals(other: Any?): Boolean =
            other is PanoPlusVcAttitude && tracking == other.tracking && q.contentEquals(other.q)
        override fun hashCode(): Int = 31 * q.contentHashCode() + tracking
    }

    private const val TAG = "RNSSweep.vcSink"

    /**
     * The registered Frame Processor name.
     *
     * ⚠ IT LIVES HERE, NOT ON THE PLUGIN. The plugin class is EXCLUDED from
     * the build without vision-camera; the recorder names this arm in
     * `arArmReason`, and referencing the plugin's own constant made the
     * package stop compiling for exactly the consumers the exclusion
     * exists to serve. Verified: `Unresolved reference
     * 'PanoPlusSweepFrameProcessor'` with the vc project forced absent.
     */
    const val PLUGIN_NAME = "panoplus_sweep_ingest"

    @Volatile private var host: Host? = null
    private val busy = AtomicBoolean(false)
    private val seq = AtomicLong(0)
    /** Frames the plugin offered. `0` on a finished sweep means the arm was
     *  armed and never fed — the failure this sink exists to make visible. */
    private val offered = AtomicLong(0)
    private val refusedPostAcquire = AtomicLong(0)
    private val generation = AtomicLong(0)
    private val droppedBusy = AtomicLong(0)
    private var worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "rnis-pp-vc-ingest").apply { isDaemon = true }
    }

    /** True while a sweep wants frames from a vision-camera plugin. */
    val isArmed: Boolean get() = host != null

    /** Frames the plugin has offered since [arm]. Read by the pack. */
    val framesOffered: Long get() = offered.get()
    val framesDroppedBusy: Long get() = droppedBusy.get()
    /** Frames the PLUGIN refused before it ever reached [tryAcquire] — bad
     *  format, odd size, a convert that threw. Reported so
     *  `framesOffered == 0` cannot be read as "the plugin never mounted"
     *  when the truth is "every frame was refused at the door". */
    val framesRefusedPreOffer: Long get() = refusedPreOffer.get()
    /** Refused AFTER the door — see [notePostAcquireRefusal]. */
    val framesRefusedPostAcquire: Long get() = refusedPostAcquire.get()
    private val refusedPreOffer = AtomicLong(0)

    /** Called by the plugin when it refuses a frame before acquiring. */
    fun notePreOfferRefusal() { refusedPreOffer.incrementAndGet() }

    /**
     * Frames refused AFTER [tryAcquire] already counted them as offered.
     *
     * ⚠ A SECOND COUNTER RATHER THAN A SECOND CALLER OF THE ONE ABOVE, and
     * the distinction is arithmetic. [refusedPreOffer]'s own contract is
     * "refused before it ever reached `tryAcquire`", so a post-acquire
     * refusal booked there lands in BOTH buckets and `offered +
     * refusedPreOffer` stops being a partition of what vision-camera
     * delivered. Three branches were doing exactly that. With the split,
     * `offered` counts every frame that got through the door and
     * `ingested + droppedBusy + refusedPostAcquire` accounts for all of
     * them — an identity a reader can check, which is the only reason to
     * carry counters at all.
     */
    fun notePostAcquireRefusal() { refusedPostAcquire.incrementAndGet() }

    /**
     * Bumped on every [arm]. The plugin latches it alongside the frame size
     * so a NEW sweep re-latches rather than inheriting the last one's — see
     * `PanoPlusSweepFrameProcessor`. It lives here because `arm()` is the
     * only event that means "a different sweep starts now", and the plugin
     * instance outlives any one sweep.
     */
    val armGeneration: Long get() = generation.get()

    /**
     * Block until no ingest is in flight, or the budget expires.
     *
     * Teardown calls this after [disarm]: disarming stops new frames, this
     * waits out the one already inside `nativeLiveIngest`. Returns true when
     * the worker went idle, false on timeout — the caller records which.
     */
    fun awaitIdle(budgetMs: Long): Boolean {
        val deadline = System.nanoTime() + budgetMs * 1_000_000L
        while (busy.get()) {
            if (System.nanoTime() >= deadline) {
                Log.w(TAG, "an ingest was still in flight after ${budgetMs}ms")
                return false
            }
            try { Thread.sleep(2) } catch (_: InterruptedException) {
                Thread.currentThread().interrupt(); return false
            }
        }
        return true
    }

    @Synchronized
    fun arm(h: Host) {
        // ⚠ NEVER CLEAR `busy` HERE. A previous sweep's ingest can still be
        // on the worker; zeroing the gate would let the NEW sweep's first
        // frame run concurrently with it, against the same pooled buffer.
        // The gate is released by whoever set it, in its own `finally`.
        // Zeroed WITH the arm, never apart from it: the counters are the
        // evidence for THIS sweep, and an arm that inherited the last one's
        // numbers would report a feeder that had already stopped.
        offered.set(0)
        droppedBusy.set(0)
        refusedPreOffer.set(0)
        refusedPostAcquire.set(0)
        seq.set(0)
        // LAST of the zeroing, and it is what tells the plugin its own
        // per-sweep latches are stale. Bumped with the counters for the same
        // reason they are zeroed together: a generation that moved without
        // the counters, or counters that moved without it, would let one
        // sweep read the other's state.
        generation.incrementAndGet()
        if (worker.isShutdown) {
            worker = Executors.newSingleThreadExecutor { r ->
                Thread(r, "rnis-pp-vc-ingest").apply { isDaemon = true }
            }
        }
        host = h
        Log.i(TAG, "armed — waiting for vision-camera frames")
    }

    /**
     * Stop feeding [h].
     *
     * ⚠ HOST-AWARE, AND THAT IS NOT DEFENSIVENESS. This is a process
     * singleton and `Rec` is per-sweep, so a previous sweep's teardown can
     * land AFTER the next sweep has armed — the recorder's own teardown is
     * explicitly budgeted and asynchronous. A blind `host = null` there
     * unfeeds the sweep that is currently running, and the symptom is
     * `vcFramesOffered == 0` on a sweep whose plugin was mounted and
     * working: the exact reading this sink exists to make impossible.
     */
    @Synchronized
    fun disarm(h: Host) {
        if (host !== h) {
            Log.i(TAG, "stale disarm ignored — a newer sweep owns the sink")
            return
        }
        host = null
        Log.i(TAG, "disarmed after ${offered.get()} offered / ${droppedBusy.get()} dropped-busy")
    }

    /**
     * Offer one frame. The caller owns [nv21] until this returns, and MUST
     * NOT reuse it until the next call — the ingest runs off-thread against
     * this exact array.
     *
     * Returns true when the frame was taken for ingest, false when it was
     * dropped (no session, or one already in flight). Never throws.
     */
    /**
     * Claim the single in-flight slot BEFORE touching the shared buffer.
     *
     * ⚠ THE ORDER IS THE WHOLE POINT, AND THE FIRST VERSION HAD IT WRONG.
     * The de-stride writes a POOLED array that the worker is still reading
     * for the previous frame. Gating after the copy — which is what
     * `offer()` alone did — lets callback N+1 overwrite the buffer inside
     * N's `nativeLiveIngest`, and then refuses N+1 as "busy" so the tear is
     * recorded as a clean drop. With ingest at ~30 ms against a 33 ms frame
     * interval that is the steady state, not an edge case.
     *
     * Returns false when a frame is already in flight; the caller must then
     * NOT touch the buffer. On true the caller owns the buffer until it
     * calls [offerAcquired] or [release].
     */
    fun tryAcquire(): Boolean {
        if (host == null) return false
        offered.incrementAndGet()
        // Drop rather than queue, and return fast: under
        // STRATEGY_BLOCK_PRODUCER the camera waits on this callback, so a
        // slow answer is a slower camera.
        if (!busy.compareAndSet(false, true)) {
            droppedBusy.incrementAndGet()
            host?.onVcFrameOutcome(false, false, -1, droppedBusy = true)
            return false
        }
        return true
    }

    /** Give the slot back without ingesting — the caller acquired it and
     *  then could not produce a frame (bad format, convert threw). */
    fun release() {
        busy.set(false)
    }

    /** Ingest a frame whose slot was already claimed by [tryAcquire]. */
    fun offerAcquired(
        nv21: ByteArray,
        length: Int,
        width: Int,
        height: Int,
        tsNs: Long,
    ): Boolean {
        val h = host
        if (h == null) { busy.set(false); return false }
        val n = seq.getAndIncrement()
        return try {
            worker.execute {
                try {
                    val att = h.solveAttitude(tsNs)
                    val k = h.intrinsicsFor(width, height)
                    val res = PanoPlusLiveNative.ingest(
                        nv21 = nv21,
                        length = length,
                        width = width,
                        height = height,
                        tsNs = tsNs.toDouble(),
                        fx = k[0], fy = k[1], cx = k[2], cy = k[3],
                        q = att.q,
                        tracking = att.tracking,
                        seq = n,
                        // ⚠ ZEROS, AND THEY ARE A KNOWN LOSS, NOT A DEFAULT.
                        // vision-camera 4.7.3 surfaces no SENSOR_EXPOSURE_TIME
                        // and no SENSOR_SENSITIVITY on Android, so the
                        // engine's exposure normalisation — which is ON by
                        // default and which the Camera2 arm feeds exactly —
                        // has nothing to work from on this arm. Passing zeros
                        // is legal and never refuses a frame; it turns the
                        // normalisation off. Recorded in the pack rather than
                        // left as an unremarked pair of zeros.
                        exposureDurationS = 0.0,
                        exposureISO = 0.0,
                    )
                    h.onVcFrameOutcome(
                        ran = res.ran,
                        painted = res.painted,
                        outcome = res.outcome,
                        droppedBusy = false,
                    )
                } catch (t: Throwable) {
                    Log.w(TAG, "ingest threw", t)
                    h.onVcFrameOutcome(false, false, -1, droppedBusy = false)
                } finally {
                    busy.set(false)
                }
            }
            true
        } catch (t: Throwable) {
            // The executor refused (shutdown mid-sweep). Release the gate or
            // the arm wedges shut for the rest of the session.
            busy.set(false)
            false
        }
    }
}
