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

    @Volatile private var host: Host? = null
    private val busy = AtomicBoolean(false)
    private val seq = AtomicLong(0)
    /** Frames the plugin offered. `0` on a finished sweep means the arm was
     *  armed and never fed — the failure this sink exists to make visible. */
    private val offered = AtomicLong(0)
    private val droppedBusy = AtomicLong(0)
    private var worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "rnis-pp-vc-ingest").apply { isDaemon = true }
    }

    /** True while a sweep wants frames from a vision-camera plugin. */
    val isArmed: Boolean get() = host != null

    /** Frames the plugin has offered since [arm]. Read by the pack. */
    val framesOffered: Long get() = offered.get()
    val framesDroppedBusy: Long get() = droppedBusy.get()

    @Synchronized
    fun arm(h: Host) {
        // Zeroed WITH the arm, never apart from it: the counters are the
        // evidence for THIS sweep, and an arm that inherited the last one's
        // numbers would report a feeder that had already stopped.
        offered.set(0)
        droppedBusy.set(0)
        seq.set(0)
        busy.set(false)
        if (worker.isShutdown) {
            worker = Executors.newSingleThreadExecutor { r ->
                Thread(r, "rnis-pp-vc-ingest").apply { isDaemon = true }
            }
        }
        host = h
        Log.i(TAG, "armed — waiting for vision-camera frames")
    }

    @Synchronized
    fun disarm() {
        host = null
        Log.i(TAG, "disarmed after $offered offered / $droppedBusy dropped-busy")
    }

    /**
     * Offer one frame. The caller owns [nv21] until this returns, and MUST
     * NOT reuse it until the next call — the ingest runs off-thread against
     * this exact array.
     *
     * Returns true when the frame was taken for ingest, false when it was
     * dropped (no session, or one already in flight). Never throws.
     */
    fun offer(nv21: ByteArray, length: Int, width: Int, height: Int, tsNs: Long): Boolean {
        val h = host ?: return false
        offered.incrementAndGet()
        // ⚠ DROP RATHER THAN QUEUE, AND RETURN FAST. Under
        // STRATEGY_BLOCK_PRODUCER the camera is waiting on this callback, so
        // a slow answer here is a slower camera — the drop is the cheaper
        // failure and it is counted rather than hidden.
        if (!busy.compareAndSet(false, true)) {
            droppedBusy.incrementAndGet()
            h.onVcFrameOutcome(ran = false, painted = false, outcome = -1, droppedBusy = true)
            return false
        }
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
