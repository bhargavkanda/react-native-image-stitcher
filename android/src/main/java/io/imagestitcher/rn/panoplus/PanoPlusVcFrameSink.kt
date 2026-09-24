// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import android.util.Log
import java.util.ArrayDeque
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * The seam between a vision-camera Frame Processor and the sweep engine.
 *
 * ── WHY THIS IS A SEPARATE OBJECT FROM THE PLUGIN ───────────────────────
 * It holds NO vision-camera type. The plugin file that does is excluded from
 * the build on a consumer without vision-camera (see android/build.gradle),
 * and everything in here has to survive that exclusion: the recorder arms
 * this sink whether or not a plugin ever calls it, and a sweep that was
 * promised frames and never got any says so through `framesOffered == 0`.
 *
 * ── THE THREADING CONTRACT ──────────────────────────────────────────────
 * `PanoPlusLiveNative.ingest` must not run on the camera callback: vision-
 * camera runs its frame processor with STRATEGY_BLOCK_PRODUCER on a single
 * HandlerThread, so a synchronous ~30 ms ingest THROTTLES THE CAMERA. The
 * plugin de-strides into a pooled buffer inside the callback (the Image dies
 * on return) and [submit]s it; the engine call runs on [worker].
 *
 * ── M4: A POOL AND A LATEST-WINS SLOT, NOT ONE BUFFER ───────────────────
 * One buffer meant one frame in flight: every frame that arrived while the
 * worker was busy was dropped, and the worker then sat IDLE until the next
 * one arrived. Measured at 1440×1080: 13–46% of offered frames dropped busy,
 * the engine running at 16–26 fps. Now:
 *
 *   · [POOL] buffers per size — one being ingested, one PENDING, one being
 *     written by the plugin — so the plugin never waits on the worker;
 *   · a new frame arriving while one is pending REPLACES it (the older one
 *     is counted as `superseded` and its buffer returned): the worker always
 *     takes the NEWEST frame the moment it finishes, and never idles while a
 *     frame is waiting.
 *
 * Still never a queue: at ~3 MB a frame a queue reaches a gigabyte in seconds
 * of stall. Bounded at [POOL] buffers whatever happens, and RELEASED at
 * disarm (M4 review: the process-wide pool used to pin ~7–9 MB after every
 * sweep, for the life of the process).
 *
 * ── THE PARTITION THE PACK IS READ WITH ─────────────────────────────────
 * Every frame counted in [framesOffered] lands in exactly ONE bucket:
 *
 *   offered = droppedBusy + refusedPostAcquire + superseded
 *           + droppedAtDisarm + (the frames the engine took)
 *
 * The M4 review measured the identity failing by one on 19 of 30 simulated
 * sweeps — the frame waiting in the pending slot at stop was counted nowhere.
 *
 * ── THE FRAME'S CAPTURE RESULT IS JOINED HERE, ON THE WORKER ────────────
 * CameraX never pairs an analysis frame with its result (see
 * [PanoPlusVcFrameMeta]); the host joins one by SENSOR_TIMESTAMP in
 * [Host.metaFor], with a bounded wait — on this thread, never on the camera's.
 */
internal object PanoPlusVcFrameSink {

    /** What the sink needs from whoever owns the sweep (the recorder). */
    internal interface Host {
        /**
         * The attitude for this frame, already through basis C, plus the
         * engine's `tracking` for it.
         *
         * ⚠ `tracking == 2` MUST MEAN "a pose solved for THIS frame". The
         * engine latches its reference from the first run of five 2s.
         */
        fun solveAttitude(tsNs: Long): PanoPlusVcAttitude

        /** Intrinsics for a frame of this size, crop-mapped when [meta] has a crop. */
        fun intrinsicsFor(width: Int, height: Int, meta: PanoPlusVcFrameMeta?): DoubleArray

        /** The frame's capture result, joined by SENSOR_TIMESTAMP; null on a miss. */
        fun metaFor(tsNs: Long): PanoPlusVcFrameMeta?

        /** The frame's own CaptureResult (null when CameraX paired none). */
        fun onVcFrameMeta(meta: PanoPlusVcFrameMeta?)

        /** Per-frame outcome, for the pack. */
        fun onVcFrameOutcome(ran: Boolean, painted: Boolean, outcome: Int, droppedBusy: Boolean)
    }

    internal data class PanoPlusVcAttitude(val q: DoubleArray, val tracking: Int) {
        override fun equals(other: Any?): Boolean =
            other is PanoPlusVcAttitude && tracking == other.tracking && q.contentEquals(other.q)
        override fun hashCode(): Int = 31 * q.contentHashCode() + tracking
    }

    private const val TAG = "RNSSweep.vcSink"
    const val PLUGIN_NAME = "panoplus_sweep_ingest"

    /** Buffers per frame size: ingesting + pending + being written. */
    internal const val POOL = 3

    private class Job(
        val buf: ByteArray,
        val length: Int,
        val width: Int,
        val height: Int,
        val tsNs: Long,
        val seq: Long,
    )

    private val lock = Object()
    @Volatile private var host: Host? = null
    // ── guarded by [lock] ──
    private val free = ArrayDeque<ByteArray>()
    private var poolBytes = -1
    private var outstanding = 0
    private var pending: Job? = null
    private var working = false
    // ──
    private val seq = AtomicLong(0)
    private val offered = AtomicLong(0)
    private val droppedBusy = AtomicLong(0)
    private val superseded = AtomicLong(0)
    private val droppedAtDisarm = AtomicLong(0)
    private val refusedPreOffer = AtomicLong(0)
    private val refusedPostAcquire = AtomicLong(0)
    private val generation = AtomicLong(0)
    private var worker: ExecutorService = newWorker()

    private fun newWorker(): ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "rnis-pp-vc-ingest").apply { isDaemon = true }
    }

    val isArmed: Boolean get() = host != null
    val framesOffered: Long get() = offered.get()
    /** Frames refused because every pooled buffer was in use. */
    val framesDroppedBusy: Long get() = droppedBusy.get()
    /** Frames converted and then replaced by a newer one before the engine took them. */
    val framesSuperseded: Long get() = superseded.get()
    /** Frames waiting in the pending slot when the sweep disarmed. */
    val framesDroppedAtDisarm: Long get() = droppedAtDisarm.get()
    val framesRefusedPreOffer: Long get() = refusedPreOffer.get()
    val framesRefusedPostAcquire: Long get() = refusedPostAcquire.get()
    fun notePreOfferRefusal() { refusedPreOffer.incrementAndGet() }

    /**
     * M5 — the FIRST device-level refusal of this sweep (`rotated-buffer` /
     * `mirrored-buffer`), for the live status: the frames are refused, so the
     * sweep cannot paint, and the host discards it by name the moment the
     * status carries this — the same key the iOS arm reports.
     */
    @Volatile var firstDeviceRefusal: String? = null
        private set
    fun noteDeviceRefusal(name: String) {
        refusedPreOffer.incrementAndGet()
        if (firstDeviceRefusal == null) firstDeviceRefusal = name
    }
    fun notePostAcquireRefusal() { refusedPostAcquire.incrementAndGet() }

    /** Bumped on every arm, so a plugin can re-latch its frame size per sweep. */
    val armGeneration: Long get() = generation.get()

    /** Block until no ingest is running or pending, or [budgetMs] passes. */
    fun awaitIdle(budgetMs: Long): Boolean {
        val deadline = System.nanoTime() + budgetMs * 1_000_000L
        while (true) {
            synchronized(lock) { if (!working && pending == null) return true }
            if (System.nanoTime() >= deadline) {
                Log.w(TAG, "an ingest was still in flight after ${budgetMs}ms")
                return false
            }
            try { Thread.sleep(2) } catch (_: InterruptedException) {
                Thread.currentThread().interrupt(); return false
            }
        }
    }

    fun arm(h: Host) {
        synchronized(lock) {
            offered.set(0)
            droppedBusy.set(0)
            superseded.set(0)
            droppedAtDisarm.set(0)
            refusedPreOffer.set(0)
            firstDeviceRefusal = null
            refusedPostAcquire.set(0)
            seq.set(0)
            generation.incrementAndGet()
            if (worker.isShutdown) worker = newWorker()
            pending = null
            free.clear()
            poolBytes = -1
            outstanding = 0
            host = h
        }
        Log.i(TAG, "armed — waiting for vision-camera frames")
    }

    fun disarm(h: Host) {
        synchronized(lock) {
            if (host !== h) {
                Log.i(TAG, "stale disarm ignored — a newer sweep owns the sink")
                return
            }
            host = null
            // A frame waiting for the engine will never be taken now — and it
            // was OFFERED, so it is counted (the partition in the header).
            pending?.let {
                droppedAtDisarm.incrementAndGet()
                returnLocked(it.buf)
            }
            pending = null
            // RELEASE THE POOL. It is process-wide; left filled it pins up to
            // POOL frame buffers after the camera screen is gone. Buffers still
            // out (the one being ingested, one a plugin is writing) now fail
            // the size check on return and are dropped rather than pooled.
            free.clear()
            poolBytes = -1
        }
        Log.i(
            TAG,
            "disarmed after ${offered.get()} offered / ${droppedBusy.get()} dropped-busy / " +
                "${superseded.get()} superseded",
        )
    }

    /**
     * A buffer of [bytes] for the plugin to convert into, or null when every
     * pooled buffer is in use (the frame is then dropped and counted busy).
     * Counts the frame as OFFERED either way.
     */
    fun acquireBuffer(bytes: Int): ByteArray? {
        val h: Host
        synchronized(lock) {
            // Counted as offered only once it is known the sink is ARMED, so a
            // frame arriving after disarm is in no bucket because it is in no
            // total either.
            h = host ?: return null
            offered.incrementAndGet()
            if (bytes != poolBytes) {
                // A new size (a new sweep, or a format change): the old pool
                // cannot hold this frame. Buffers still out are dropped when
                // they come back (their size no longer matches).
                free.clear()
                poolBytes = bytes
                outstanding = 0
            }
            val b = free.pollFirst() ?: if (outstanding < POOL) ByteArray(bytes) else null
            if (b != null) {
                outstanding += 1
                return b
            }
        }
        droppedBusy.incrementAndGet()
        h.onVcFrameOutcome(false, false, -1, droppedBusy = true)
        return null
    }

    /** Buffers held in the free pool — test-only. */
    internal fun pooledBuffersForTest(): Int = synchronized(lock) { free.size }

    /** Give back a buffer the plugin acquired and did not submit. */
    fun returnBuffer(buf: ByteArray) {
        synchronized(lock) { returnLocked(buf) }
    }

    private fun returnLocked(buf: ByteArray) {
        if (buf.size != poolBytes) return   // from an older pool size
        if (outstanding > 0) outstanding -= 1
        if (free.size < POOL) free.addLast(buf)
    }

    /**
     * Hand a converted frame to the engine. Starts the worker when it is
     * idle; otherwise the frame waits in the PENDING slot, replacing (and
     * counting as superseded) any frame already waiting there.
     */
    fun submit(
        buf: ByteArray,
        length: Int,
        width: Int,
        height: Int,
        tsNs: Long,
    ): Boolean {
        val start: Job
        val h: Host
        synchronized(lock) {
            h = host ?: run {
                // Disarmed while the plugin converted it: offered, then refused.
                refusedPostAcquire.incrementAndGet()
                returnLocked(buf)
                return false
            }
            val job = Job(buf, length, width, height, tsNs, seq.getAndIncrement())
            if (working) {
                pending?.let {
                    superseded.incrementAndGet()
                    returnLocked(it.buf)
                }
                pending = job
                return true
            }
            working = true
            start = job
        }
        return try {
            worker.execute { runLoop(h, start) }
            true
        } catch (t: Throwable) {
            synchronized(lock) {
                working = false
                returnLocked(start.buf)
            }
            false
        }
    }

    /**
     * Ingest [first], then whatever is pending when it finishes, until nothing
     * is.
     *
     * ⚠ UNDER THE CURRENT HOST, re-read every turn (M4 review). The loop used
     * to take the pending job only if the host was still the one it started
     * with, and cleared `pending` either way — so a NEW sweep armed while the
     * previous one's loop was finishing lost its first frame, uncounted, and
     * with it a pool slot. `arm()` clears `pending`, so anything pending now
     * was submitted to the current host; `disarm()` clears it too, so a null
     * host means there is nothing to take.
     */
    private fun runLoop(h0: Host, first: Job) {
        var h = h0
        var job: Job? = first
        while (job != null) {
            ingest(h, job)
            synchronized(lock) {
                returnLocked(job!!.buf)
                val cur = host
                job = if (cur != null) pending else null
                pending = null
                if (cur != null) h = cur
                if (job == null) working = false
            }
        }
    }

    private fun ingest(h: Host, job: Job) {
        try {
            val m = h.metaFor(job.tsNs)
            h.onVcFrameMeta(m)
            val att = h.solveAttitude(job.tsNs)
            val k = h.intrinsicsFor(job.width, job.height, m)
            val res = PanoPlusLiveNative.ingest(
                nv21 = job.buf,
                length = job.length,
                width = job.width,
                height = job.height,
                tsNs = job.tsNs.toDouble(),
                fx = k[0], fy = k[1], cx = k[2], cy = k[3],
                q = att.q,
                tracking = att.tracking,
                seq = job.seq,
                // M4: the frame's own exposure, so the engine's exposure
                // normalisation runs on the camera rather than on zeros.
                exposureDurationS = if (m != null && m.exposureTimeNs > 0L) m.exposureTimeNs / 1e9 else 0.0,
                exposureISO = if (m != null && m.iso > 0) m.iso.toDouble() else 0.0,
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
        }
    }
}
