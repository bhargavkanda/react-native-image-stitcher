// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusArIngestSlot — the AR-plugin arm's hand-off to the engine: a small
// buffer pool and a LATEST-WINS pending slot, modelled line for line on the
// vision-camera sink (PanoPlusVcFrameSink, M4).
//
// ── WHY IT REPLACES THE BUSY GATE ────────────────────────────────────────────
//
// The arm used to be ONE ingest in flight with drop-and-count: a frame that
// arrived while the worker was busy was refused, and the worker then sat IDLE
// until the GL loop offered it another one. That is a throughput ceiling on a
// POLLING producer — the worker can only restart on the next GL tick — and it
// cost ~20-25% of worker capacity on every pack examined. The re-offer that
// was supposed to hide it (the GL loop hands the same ARCore frame over again
// on the next tick) only works while the loop ticks far faster than the
// camera: at ~57 Hz it rescued most refusals, at the 26.8 Hz measured on
// 2026-09-29 it rescued almost none, and the arm ingested 10 fps.
//
// The vc sink solved the same problem in M4 and its packs ingest at camera
// rate. So, the same shape:
//
//   · [POOL] buffers — one being ingested, one PENDING, one being written by
//     the GL thread — so the GL thread never waits on the worker;
//   · a frame submitted while one is pending REPLACES it (the older one is
//     counted as `superseded` and its buffer returned): the worker always takes
//     the NEWEST frame the moment it finishes, and never idles while one waits.
//
// Still never a queue: at 3.11 MB a frame a queue reaches a gigabyte in seconds
// of stall. Bounded at [POOL] buffers whatever happens, and RELEASED at disarm.
//
// ── WHAT DIFFERS FROM THE vc SINK ────────────────────────────────────────────
//
// An instance, not an object, with an injected ingest function and worker
// factory, so every decision here is a JVM test away (the plugin class cannot
// be referenced from a unit test; see PanoPlusArArmState). And an [ArFrame]
// carries its pose, intrinsics and exposure: ARCore delivers them WITH the
// pixels, so there is nothing to solve on the worker.
//
// ── THE PARTITION ────────────────────────────────────────────────────────────
//
// Every [acquire] call is one OFFERED buffer request, and it lands in exactly
// one bucket:
//
//   offered = taken + superseded + droppedBusy + refusedAtAcquire
//           + allocFailed + refusedPostAcquire + droppedAtDisarm
//           + submitFailed + (the plugin's own submitThrew) + pendingNow
//
// `offered` counts REQUESTS for frames that passed the gates. They are
// distinct frames unless `droppedBusy` or `allocFailed` > 0: neither refusal
// advances the watermark, so the GL loop's re-offer of that same frame asks
// again and is counted again.
//
// `refusedAtAcquire` is a frame whose buffer was asked for after a disarm that
// landed between the plugin's verdict and the acquire — a stop, not
// backpressure, so it is NOT `droppedBusy`, which with one producer and
// [POOL] = 3 must be zero. `allocFailed` is a new buffer whose allocation
// threw (an OutOfMemory under pressure): its pool slot is given back, so a
// failed allocation can never shrink the pool for the rest of the sweep.

package io.imagestitcher.rn.panoplus

import java.util.ArrayDeque
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal class PanoPlusArIngestSlot(
    private val ingestFn: (ArJob) -> Unit,
    private val workerFactory: () -> ExecutorService = ::defaultWorker,
) {

    /** One frame, as the GL thread copied it: every field a copy or a primitive. */
    internal class ArFrame(
        val buf: ByteArray,
        val width: Int,
        val height: Int,
        val tsNs: Double,
        val fx: Double,
        val fy: Double,
        val cx: Double,
        val cy: Double,
        val q: DoubleArray,
        val exposureDurationS: Double,
        val exposureISO: Double,
    )

    /**
     * A frame with its engine sequence number, assigned at [submit] (the vc
     * convention): a superseded frame leaves a GAP in `seq`, which replay —
     * row-driven — reads as nothing more than a frame that was not ingested.
     */
    internal class ArJob(val frame: ArFrame) {
        var seq: Long = -1L
            internal set
    }

    /** Why the last [acquire] returned null — see [lastAcquireRefusal]. */
    internal enum class AcquireRefusal { NONE, DISARMED, BUSY, ALLOC_FAILED }

    companion object {
        /** Buffers: ingesting + pending + being written. */
        const val POOL = 3
        const val DESCRIPTION = "latest-wins/$POOL"

        /**
         * ONE thread, so frames keep their delivery order — the engine's chain
         * requires monotonic timestamps and a pool would reorder them. Daemon:
         * the plugin is a process-wide singleton and must never be the reason
         * the process stays alive.
         */
        fun defaultWorker(): ExecutorService = Executors.newSingleThreadExecutor { r ->
            Thread(r, "rnis-pp-ar-ingest").apply { isDaemon = true }
        }
    }

    private val lock = Object()
    // ── guarded by [lock] ──
    private var armed = false
    private val free = ArrayDeque<ByteArray>()
    private var poolBytes = -1
    private var outstanding = 0
    private var pending: ArJob? = null
    private var working = false
    private var inFlight = false
    private var worker: ExecutorService = workerFactory()
    private var seq = 0L
    private var offered = 0L
    private var taken = 0L
    private var superseded = 0L
    private var droppedBusy = 0L
    private var refusedAtAcquire = 0L
    private var allocFailed = 0L
    private var refusedPostAcquire = 0L
    private var droppedAtDisarm = 0L
    private var submitFailed = 0L
    private var workerThrew = 0L
    private var lastEndNs = 0L
    private var busyNs = 0L
    private var lastRefusal = AcquireRefusal.NONE
    // ──
    /** Wall time of each ingest the worker ran (the JNI call and its bookkeeping). */
    private val ingestWallMs = Stat()
    /** The gaps between one ingest ending and the next starting. */
    private val workerIdleMs = Stat()

    val isArmed: Boolean get() = synchronized(lock) { armed }

    /** Arm for a sweep: counters and pool reset, so a pack describes ONE sweep. */
    fun arm() {
        synchronized(lock) {
            seq = 0L
            offered = 0L; taken = 0L; superseded = 0L; droppedBusy = 0L
            refusedAtAcquire = 0L; allocFailed = 0L; refusedPostAcquire = 0L
            droppedAtDisarm = 0L; submitFailed = 0L; workerThrew = 0L
            lastEndNs = 0L; busyNs = 0L
            lastRefusal = AcquireRefusal.NONE
            ingestWallMs.reset(); workerIdleMs.reset()
            if (worker.isShutdown) worker = workerFactory()
            pending = null
            free.clear()
            poolBytes = -1
            outstanding = 0
            armed = true
        }
    }

    /**
     * Disarm. NEVER WAITS: the caller is `stop()`, a @ReactMethod on RN's one
     * NativeModules queue, and an ingest still in flight is safe to let finish
     * (see PanoPlusArFramePlugin.disarm). A frame waiting in the pending slot
     * will never be taken now, and it was OFFERED, so it is counted.
     */
    fun disarm() {
        synchronized(lock) {
            armed = false
            pending?.let {
                droppedAtDisarm += 1
                returnLocked(it.frame.buf)
            }
            pending = null
            // RELEASE THE POOL (the M4-review lesson): the plugin is a
            // process-wide singleton, and a filled pool would pin ~9 MB after
            // the camera screen is gone. Buffers still out — the one being
            // ingested, one the GL thread is writing — fail the size check on
            // their way back and are dropped rather than pooled.
            free.clear()
            poolBytes = -1
        }
    }

    /**
     * A buffer of [bytes] to copy one frame into, or null. Every call is one
     * OFFERED request. Null when the slot was disarmed between the plugin's
     * verdict and this call (`refusedAtAcquire`), when every pooled buffer is
     * out (`droppedBusy` — impossible with one producer and [POOL] = 3, and
     * counted so that stays checkable) or when a new buffer could not be
     * allocated (`allocFailed`). [lastAcquireRefusal] says which.
     *
     * NEVER THROWS, like [submit]: the slot it reserved is its own to give
     * back, and a caller that saw a throw could not know one was reserved.
     */
    fun acquire(bytes: Int): ByteArray? {
        var reuse: ByteArray? = null
        synchronized(lock) {
            offered += 1
            if (!armed) {
                refusedAtAcquire += 1
                lastRefusal = AcquireRefusal.DISARMED
                return null
            }
            if (bytes != poolBytes) {
                // A new size (a new sweep, or a format change): the old pool
                // cannot hold this frame. Buffers still out are dropped when
                // they come back (their size no longer matches).
                free.clear()
                poolBytes = bytes
                outstanding = 0
            }
            reuse = free.pollFirst()
            if (reuse == null && outstanding >= POOL) {
                droppedBusy += 1
                lastRefusal = AcquireRefusal.BUSY
                return null
            }
            outstanding += 1
            lastRefusal = AcquireRefusal.NONE
        }
        reuse?.let { return it }
        // Allocated OUTSIDE the lock — 3.11 MB is not work to hold the worker
        // off for. Only the first POOL frames of a sweep ever get here.
        //
        // ⚠ AND CAUGHT HERE, because the slot is ALREADY RESERVED above. A
        // 3.11 MB allocation is exactly the one that throws OutOfMemory first,
        // and an escaping throw would keep `outstanding` one high until the
        // next arm — three of them and every acquire refuses for the rest of
        // the sweep: the old busy gate's OOM wedge, moved into the pool.
        return try {
            ByteArray(bytes)
        } catch (t: Throwable) {
            synchronized(lock) {
                // Only if the reservation is still this pool's: an arm, a
                // disarm or a size change in between has already let this
                // pool go, and the next acquire resets `outstanding`.
                if (bytes == poolBytes && outstanding > 0) outstanding -= 1
                allocFailed += 1
                lastRefusal = AcquireRefusal.ALLOC_FAILED
            }
            null
        }
    }

    /**
     * Why the last [acquire] returned null (NONE after one that returned a
     * buffer). Meaningful to the ONE producer that called it — the GL thread —
     * right after the call.
     */
    fun lastAcquireRefusal(): AcquireRefusal = synchronized(lock) { lastRefusal }

    /** Give back a buffer that was acquired and will not be submitted. */
    fun returnBuffer(buf: ByteArray) {
        synchronized(lock) { returnLocked(buf) }
    }

    private fun returnLocked(buf: ByteArray) {
        if (buf.size != poolBytes) return   // from an older pool size
        if (outstanding > 0) outstanding -= 1
        if (free.size < POOL) free.addLast(buf)
    }

    /**
     * Hand a copied frame to the engine. Starts the worker when it is idle;
     * otherwise the frame waits in the PENDING slot, replacing (and counting
     * as superseded) any frame already waiting there. Returns false — with
     * the buffer returned and the frame counted — when it was not taken.
     *
     * NEVER THROWS: the caller has no way to know whether a buffer that went
     * in came back out, so every failure is handled here.
     */
    fun submit(frame: ArFrame): Boolean {
        val job = try {
            ArJob(frame)
        } catch (t: Throwable) {
            synchronized(lock) {
                submitFailed += 1
                returnLocked(frame.buf)
            }
            return false
        }
        synchronized(lock) {
            if (!armed) {
                // Disarmed while the GL thread copied it: offered, then refused.
                refusedPostAcquire += 1
                returnLocked(frame.buf)
                return false
            }
            job.seq = seq++
            if (working) {
                pending?.let {
                    superseded += 1
                    returnLocked(it.frame.buf)
                }
                pending = job
                return true
            }
            working = true
        }
        return try {
            worker.execute { runLoop(job) }
            true
        } catch (t: Throwable) {
            // A shut-down or saturated executor. `working` must come back down
            // or the next submit parks a frame in `pending` that nothing will
            // ever run.
            synchronized(lock) {
                working = false
                submitFailed += 1
                returnLocked(frame.buf)
            }
            false
        }
    }

    /**
     * Ingest [first], then whatever is pending when it finishes, until nothing
     * is. Re-reads the arm every turn (the vc sink's M4-review fix): `arm()`
     * clears `pending`, so anything pending now was submitted to the CURRENT
     * sweep — a sweep armed while the previous one's loop was finishing keeps
     * its first frame instead of losing it, uncounted, with a pool slot.
     */
    private fun runLoop(first: ArJob) {
        var next: ArJob? = first
        while (next != null) {
            val job: ArJob = next ?: break
            val t0 = System.nanoTime()
            synchronized(lock) {
                taken += 1
                inFlight = true
                // Idle is the gap since the previous ingest ENDED. Inside one
                // run of this loop it is ~0 by construction; it grows only when
                // the worker ran dry and a later submit had to restart it.
                if (lastEndNs != 0L && t0 >= lastEndNs) workerIdleMs.add((t0 - lastEndNs) / 1e6)
            }
            try {
                ingestFn(job)
            } catch (t: Throwable) {
                // The plugin's ingest catches everything itself; this is the
                // last line, because an uncaught throw would kill the single
                // worker and silently end the sweep.
                synchronized(lock) { workerThrew += 1 }
            }
            val t1 = System.nanoTime()
            synchronized(lock) {
                inFlight = false
                ingestWallMs.add((t1 - t0) / 1e6)
                busyNs += (t1 - t0)
                lastEndNs = t1
                returnLocked(job.frame.buf)
                next = if (armed) pending else null
                pending = null
                if (next == null) working = false
            }
        }
    }

    /** Block until no ingest is running or pending, or [budgetMs] passes. TEST HELPER. */
    fun awaitIdle(budgetMs: Long): Boolean {
        val deadline = System.nanoTime() + budgetMs * 1_000_000L
        while (true) {
            synchronized(lock) { if (!working && pending == null) return true }
            if (System.nanoTime() >= deadline) return false
            try { Thread.sleep(2) } catch (_: InterruptedException) {
                Thread.currentThread().interrupt(); return false
            }
        }
    }

    /** Buffers held in the free pool — test-only. */
    internal fun pooledBuffersForTest(): Int = synchronized(lock) { free.size }

    /** Shut the worker down — test-only, for the shut-down-executor path. */
    internal fun shutdownWorkerForTest() { synchronized(lock) { worker.shutdownNow() } }

    /**
     * Everything the slot did, as plain values (Double / String). Read with
     * PanoPlusArArmState.counters, which states the identities.
     */
    fun counters(): Map<String, Any> = synchronized(lock) {
        val idleMs = workerIdleMs.sum()
        val busyMs = busyNs / 1e6
        linkedMapOf(
            "ingestSlot" to DESCRIPTION,
            "offered" to offered.toDouble(),
            "taken" to taken.toDouble(),
            "superseded" to superseded.toDouble(),
            "droppedBusy" to droppedBusy.toDouble(),
            "refusedAtAcquire" to refusedAtAcquire.toDouble(),
            "allocFailed" to allocFailed.toDouble(),
            "refusedPostAcquire" to refusedPostAcquire.toDouble(),
            "droppedAtDisarm" to droppedAtDisarm.toDouble(),
            "submitFailed" to submitFailed.toDouble(),
            "workerThrew" to workerThrew.toDouble(),
            "pendingNow" to (if (pending != null) 1.0 else 0.0),
            "inFlight" to (if (inFlight) 1.0 else 0.0),
            // Buffers this sweep holds right now: out plus pooled, <= POOL.
            "poolBuffers" to (if (poolBytes < 0) 0.0 else (outstanding + free.size).toDouble()),
            "ingestWallMsP50" to ingestWallMs.p50(),
            "ingestWallMsP99" to ingestWallMs.p99(),
            "workerIdleMsTotal" to idleMs,
            "workerBusyFrac" to (if (busyMs + idleMs > 0.0) busyMs / (busyMs + idleMs) else 0.0),
        )
    }
}
