// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusArFramePlugin — pano+ riding the stitcher's OWN ARCore session on
// Android, the way it has ridden ARKit on iOS since the beginning.
//
// ── WHY THIS EXISTS, AND IT IS THE OPERATOR'S OWN QUESTION ───────────────────
//
// 2026-09-10: "I took an AR capture in pano with no issues!! What is happening??
// Why can't we use the same for pano+ too?"
//
// He was right, and the asymmetry was ours. On iOS pano+ has always been a
// plugin on Pano's AR session — one line, `RNISARPluginRegistry.shared.register(
// RNISPanoPlusPlugin.shared)` in PanoPlusBridge.swift — with ARKit owning
// the camera and pano+ receiving pixels, attitude and real per-frame intrinsics.
// iOS AR works: 278 of 278 packs on disk painted.
//
// On Android pano+ went its own way: it opens its own Camera2 session and bolts
// ARCore on in SHARED_CAMERA mode. That arm has never painted a strip. 23 packs
// spanning 2026-08-24 to 2026-09-10, every one of them zero.
//
// The seam was there the whole time. `io.imagestitcher.rn.ARFramePlugin` and
// `RNSARPluginRegistry` ship in the Android stitcher and are already used by
// first-party AR plugins in shipping hosts.
// pano+ was the one thing that did not use it.
//
// ── WHAT THIS DELETES, WHICH IS THE POINT ────────────────────────────────────
//
// Not "another way to get poses" — the REMOVAL of the machinery that has
// produced nothing but failures:
//
//   · THE BOOTSTRAP RACE. ARCore gives motion tracking ONE window of about 60
//     frames (~2.0 s) and latches a failure verdict if it misses. The shared
//     arm resumes ARCore at the moment recording starts, so its single attempt
//     runs on a camera that is ALREADY PANNING. Measured across 17 sidecars:
//     the failure label first appears at ARCore row 60 in 12 of 13 failing
//     packs, 2001-2062 ms in, contiguous to the last row in 13 of 13, and never
//     clears — one pack held it for 7,245 rows across 247 s. The stitcher's
//     session is created and resumed at VIEW MOUNT, so by the time the operator
//     presses the shutter tracking is long since established. There is no
//     window to miss.
//   · THE POSE RING AND ITS BRACKET ARITHMETIC. No ring, no interpolation, no
//     bracket tolerance: the pose arrives WITH the pixels it belongs to, in one
//     callback, already time-aligned. The 25 ms tolerance that refused every
//     frame against ARCore's 33.8 ms pose interval simply has nothing to do.
//   · THE SHARED-CAMERA HANDOVER. No second client on the one back camera, no
//     forced CameraConfig, no `configured` gate, no repeating-request contest.
//
// ── WHAT IT COSTS, STATED PLAINLY ────────────────────────────────────────────
//
// ARCore chooses the camera and the CPU image size, so the recorder's own
// widest-FOV and maxWidth preferences do not apply on this arm. That is the
// same price any ARKit- or ARCore-hosted capture pays. It is a
// recorded confound when comparing an AR canvas against an IMU one, not a
// defect.
//
// There is no Camera2 stream on this arm, so no per-frame CaptureResult and
// therefore no exposure pair. `exposureDurationS` and `exposureISO` are passed
// as 0, which the engine reads as "not measured" rather than as a measurement
// of zero — the same shape the iOS ARKit arm has always had.
//
// ── THREADING, AND THE ONE REAL RISK ─────────────────────────────────────────
//
// `process` runs on the GL RENDER THREAD — `RNSARCameraView.onDrawFrame` ->
// `drawFrame` -> `forwardToIncremental` -> `runArPlugins`, and the library's
// own comment on `lastPluginSyncResults` says so: "Written by runArPlugins on
// the GL render thread".
//
// ⚠ THIS FILE USED TO CALL THE ENGINE SYNCHRONOUSLY THERE, AND DEFENDED IT IN
// WRITING. The defence was: a queue between the pose and the pixels it belongs
// to is exactly the time-alignment problem this class exists to delete. That
// argument was WRONG, and the operator paid for it — 2026-09-11, on the A35:
// "in AR mode, the camera gets stuck ... There is a very visible stutter."
//
// It was wrong twice over:
//
//   · IT MISREAD ITS OWN RISK. The cost was booked as "we might overrun the
//     33.8 ms ARCore cadence and lose frames". The real cost is that the GL
//     thread also DRAWS THE VIEWFINDER: backgroundRenderer.draw runs in the
//     same drawFrame, but GLSurfaceView swaps buffers only when onDrawFrame
//     RETURNS, so the drawn frame does not reach the screen until our ingest
//     finishes. Viewport cadence WAS our ingest cadence. Measured on that
//     pack: ingest p50 40.5 ms, p99 234.0 ms, max 300.7 ms. The picture could
//     not be smoother than that, and the non-AR arm was unaffected because its
//     viewfinder is a TextureView fed straight from Camera2 and never touches
//     our threads.
//
//   · THE TIME-ALIGNMENT OBJECTION DOES NOT APPLY TO A COPY. ARFrameContext
//     hands over the pose AND the pixels in ONE callback. Carrying that matched
//     pair to another thread preserves the alignment exactly. The objection is
//     to re-SAMPLING a pose beside a queue of pixels, which is a different
//     design and not this one. Nothing about `q` changes here.
//
// So: the gates stay on the GL thread (microseconds), the frame is COPIED into
// a pooled buffer, and the engine runs on our own single thread.
//
// ── A1.2: A LATEST-WINS SLOT, NOT A BUSY GATE ────────────────────────────────
//
// This used to be ONE ingest in flight with drop-and-count, and on a POLLING
// producer that is a throughput ceiling: after an ingest the worker sat idle
// until the GL loop offered it the next frame. The loop's re-offer of a
// refused frame was meant to hide that, and only did while the loop ticked far
// faster than the camera — ~17.5 ms apart at the ~57 Hz of 2026-09-16/17, but
// ~37 ms at the 26.8 Hz of 2026-09-29, when only 33 of 164 ticks were
// re-offers and the arm ingested 10 fps. Now the hand-off is
// [PanoPlusArIngestSlot] — the vision-camera sink's M4 design: three pooled
// buffers and a PENDING slot a newer frame replaces. The worker takes the
// newest frame the moment it finishes and never idles while one waits.
//
// ⚠ WHICH IS WHY THE DUPLICATE CHECK NOW COMES FIRST. With a pending slot a
// frame is never refused for backpressure, so there is nothing for the
// watermark to wait for — but the watermark is still COMMITTED only after the
// frame has a buffer, so if a buffer is ever unavailable (pool exhaustion,
// impossible with one producer and three buffers, and counted) the GL loop's
// re-offer can still be taken. See `process`.
//
// Every frame's outcome is counted so the pack can say what the arm did rather
// than leaving a silent arm looking identical to a dead one — the failure mode
// that let the shared arm ship broken for eighteen days.

package io.imagestitcher.rn.panoplus

import android.util.Log
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeMap
import io.imagestitcher.rn.ARFrameContext
import io.imagestitcher.rn.ARFramePlugin
import io.imagestitcher.rn.RNSARFrameStats

/**
 * The pano+ engine as a plugin on the stitcher's ARCore session.
 *
 * A SINGLETON registered once, whose [armed] flag decides whether a frame is
 * ingested. Registration is idempotent by name in the registry, and an unarmed
 * plugin is a cheap early return rather than an unregister, so the AR view's
 * mount/unmount cycle cannot leave a half-registered arm behind.
 */
internal class PanoPlusArFramePlugin private constructor() : ARFramePlugin {

    companion object {
        const val NAME = "sweepAr"
        private const val TAG = "PanoPlusArPlugin"


        @JvmStatic
        val shared = PanoPlusArFramePlugin()
    }

    /**
     * ALL the decisions and counters live here, in a class that implements
     * nothing — see PanoPlusArArmState for why. This class is marshalling.
     */
    @JvmField
    val state = PanoPlusArArmState()

    /**
     * The hand-off to the engine: a pooled buffer per frame, a latest-wins
     * pending slot, and ONE worker thread (frames keep their delivery order —
     * the engine's chain requires monotonic timestamps). See the A1.2 note in
     * the header. Its counters are merged into [counters].
     */
    private val slot = PanoPlusArIngestSlot({ job -> ingestOffThread(job) })

    /**
     * The GL loop's own timers, frozen at [disarm] so the pack describes the
     * SWEEP and not the post-sweep idle ticks the loop keeps running through
     * the finalize. Null while armed (the recorder then reads it live) and
     * before the first sweep.
     */
    @Volatile var glLoopAtDisarm: Map<String, Any>? = null
        private set

    /**
     * Every frame's ARCore pose, handed to the recorder for
     * `attitude_arcore.jsonl` — the REFERENCE series the offline basis run
     * (`arcoreBasisRun`, rnis_pano_android_s1) needs.
     *
     * ⚠ M2: pano+'s own ARCore channel used to write that file, and a live AR
     * sweep no longer opens one — it runs on the stitcher's session through
     * this plugin. Without this the basis tool would lose its only input on
     * the only AR arm left. Called for EVERY frame, including non-tracking
     * ones (the reader filters on `trackingState`), and before every gate,
     * so a frame the engine drops is still a pose on disk. The same
     * `camera.pose` the channel recorded (RNSARCameraView reads
     * `camera.pose.rotationQuaternion`, not the display-oriented pose).
     */
    @Volatile var poseRowSink: ((tsNs: Double, q: DoubleArray, t: DoubleArray, tracking: String) -> Unit)? = null
        set(value) {
            field = value
            lastPoseTsNs = Long.MIN_VALUE
        }

    /**
     * The last camera timestamp written as a pose row. The AR view can hand
     * plugins the SAME ARCore frame more than once (a GL re-render with no new
     * camera image); without this each re-render wrote a duplicate row. Read
     * and written only on the GL thread, in [process].
     */
    private var lastPoseTsNs = Long.MIN_VALUE

    override fun name(): String = NAME

    /**
     * Arm for a sweep, AND REGISTER WITH THE STITCHER'S REGISTRY.
     *
     * ⚠ THESE ARE ONE ACTION AND WERE BRIEFLY TWO. Registration lived only in
     * PanoPlusLiveModule.setArPluginArmed, which nothing called, so the first
     * wired build armed a plugin the registry had never heard of: the sweep
     * started, the AR camera view ran, and the engine received zero frames.
     * logcat showed `PanoPlusArPlugin: armed` beside a registry that listed only
     * the host's own plugin. Arming without registering is a silent no-op, so
     * the two cannot be separable.
     */
    fun arm() {
        var registerFailure: Throwable? = null
        try {
            io.imagestitcher.rn.RNSARPluginRegistry.register(this)
        } catch (t: Throwable) {
            registerFailure = t
            Log.w(TAG, "could not register with RNSARPluginRegistry", t)
        }
        // THE SLOT BEFORE THE STATE: a frame that passes the state's verdict
        // must find the slot armed. (disarm runs the other way round.)
        slot.arm()
        state.arm()
        // A1.0 — the GL loop's timers describe THIS sweep from here: zeroed
        // and switched on only here (they are process-wide, like the counters
        // above), and off again at disarm — a host that never arms a sweep
        // never pays for them.
        RNSARFrameStats.start()
        glLoopAtDisarm = null
        // A host without the stitcher linked: the arm cannot work, and the
        // pack must say so rather than reporting a plausible silence. Counted
        // AFTER state.arm(), which zeroes every counter — before it, the count
        // was erased the moment it was made.
        registerFailure?.let { state.recordRegisterThrew(it.javaClass.simpleName) }
        Log.i(TAG, "armed and registered — pano+ will ingest the stitcher's ARCore frames")
    }

    /**
     * Disarm AND unregister. The stitcher's AR view outlives our sweep, so a
     * plugin left registered and armed would keep feeding a finished engine.
     */
    fun disarm() {
        poseRowSink = null
        // state.disarm() makes verdict() refuse every subsequent frame, so no
        // NEW work can be submitted after this line.
        //
        // ⚠ AND THAT IS ALL THAT IS NEEDED — THERE IS DELIBERATELY NO DRAIN.
        // An earlier version of this offload blocked here until the in-flight
        // ingest finished, on the stated grounds that `stop()` finalizes the
        // native session immediately afterwards and a late ingest would crash.
        // THAT PREMISE IS FALSE, and it was worth checking rather than
        // believing: nativeLiveIngest takes a SHARED lock and then null-checks
        // the session (panoplus_jni.cpp), while
        // nativeLiveFinalize takes the UNIQUE lock and resets the pointer
        // (:1789-1791). A late ingest therefore either completes under the
        // shared lock before finalize acquires, or finds `sess == nullptr` /
        // `!running()` and returns 0. There is no window in which it touches a
        // torn-down engine.
        //
        // Blocking here was not merely unnecessary, it was harmful: disarm()
        // is called from stop(), a @ReactMethod, so the wait ran on RN's ONE
        // NativeModules queue — the wedge this file warns about elsewhere and
        // that has taken the whole bridge down before. It also never closed the
        // window it claimed to: a frame admitted by the gate but not yet
        // submitted is invisible to any barrier on the worker.
        //
        // The slot follows the same rule (A1.2): `slot.disarm()` drops and
        // counts a PENDING frame and releases the pool, and never waits for
        // the one in flight. A frame the GL thread is copying right now finds
        // the slot disarmed at submit and is counted `refusedPostAcquire`.
        val wasArmed = state.isArmed
        state.disarm()
        slot.disarm()
        // Frozen HERE: the loop keeps ticking through the finalize, and those
        // ticks are not the sweep's. Only on the disarm that ENDS an armed
        // sweep — disarm is idempotent and called defensively from every
        // teardown, and a second call must not overwrite the sweep's numbers
        // with post-sweep ticks.
        if (wasArmed) glLoopAtDisarm = RNSARFrameStats.snapshot()
        // …and the timers go OFF, on every disarm (idempotent): the view
        // stops timing its ticks the moment nobody will report them.
        RNSARFrameStats.stop()
        try {
            io.imagestitcher.rn.RNSARPluginRegistry.unregister(NAME)
        } catch (t: Throwable) {
            Log.w(TAG, "could not unregister from RNSARPluginRegistry", t)
        }
        Log.i(TAG, "disarmed and unregistered — ${counters()}")
    }

    /** The arm's counters and the slot's, with the identities checked. */
    fun counters(): Map<String, Any> = state.counters(slot.counters())

    /**
     * What this arm's frames were refused as, for the SUMMARY's `droppedQueue`:
     * the frames the engine never got because a newer one replaced them, or
     * because no buffer was free. On this arm the Camera2 encoder counter the
     * summary used to copy is structurally 0, so a sweep that lost 70 of 131
     * distinct frames reported `droppedQueue: 0`.
     */
    fun droppedQueue(): Double {
        val c = slot.counters()
        return ((c["superseded"] as? Double) ?: 0.0) + ((c["droppedBusy"] as? Double) ?: 0.0)
    }

    fun snapshot(): WritableNativeMap = WritableNativeMap().apply {
        for ((k, v) in counters()) {
            when (v) {
                is Boolean -> putBoolean(k, v)
                is Double -> putDouble(k, v)
                else -> putString(k, v.toString())
            }
        }
    }

    override fun process(context: ARFrameContext): WritableMap? {
        // A1.0 — the GL tick as the arm sees it, before anything can return.
        state.noteTick(System.nanoTime())
        // 1. THE POSE ROW, FIRST AND UNCHANGED: the sidecar keeps every
        //    distinct frame, whatever the gates below decide about its pixels.
        poseRowSink?.let { sink ->
            val ts = context.timestampNs.toLong()
            if (ts > lastPoseTsNs) {
                lastPoseTsNs = ts
                try {
                    sink(context.timestampNs, context.poseRotation, context.poseTranslation, context.trackingState)
                } catch (t: Throwable) {
                    state.recordPoseRowThrew(t.javaClass.simpleName)
                }
            }
        }
        // 2. THE VERDICT (armed, tracking, geometry).
        val verdict = state.verdict(
            context.trackingState, context.width, context.height, context.fx, context.fy,
        )
        if (verdict != ArFrameVerdict.INGEST) return null

        // 3. DUPLICATE FIRST, BEFORE ANY BUFFER IS TAKEN. THE ORDER IS THE FIX.
        //
        // ⚠ THIS ARM IS A POLLING PRODUCER. The GL loop free-runs
        // (RENDERMODE_CONTINUOUSLY, RNSARCameraView.kt) and ARCore is in
        // LATEST_CAMERA_IMAGE (RNSARSession.kt), so when no newer camera image
        // has landed `session.update()` returns THE SAME frame, unchanged
        // timestamp and all, and the library de-duplicates nothing. Measured:
        // re-offers ~17.5 ms apart at the ~57 Hz loop of 2026-09-16/17, ~37 ms
        // at the 26.8 Hz loop of 2026-09-29 — not the ~11 ms this comment used
        // to assume.
        //
        // Under the old one-in-flight gate the BUSY check had to come first, so
        // a frame refused for backpressure could still be taken on its re-offer.
        // With the latest-wins slot a frame is never refused for backpressure
        // (a newer one REPLACES the pending one instead), so the duplicate
        // check comes first and a re-render costs no buffer at all.
        //
        // 4. A BUFFER — OFFERED from here on (the slot counts it). Null means
        //    the sweep stopped between the verdict and this line, a new buffer
        //    could not be allocated (`allocFailed`; the slot gives its pool
        //    slot back — acquire never throws), or — with one producer and
        //    three buffers, never — the pool is exhausted.
        //
        // 5. THE WATERMARK, only for a frame that got a buffer: on a null the
        //    GL loop's re-offer of this frame can still be taken.
        //
        // All three in PanoPlusArArmState.admit, where the order is tested.
        val buf = state.admit(context.timestampNs, context.nv21.size, slot) ?: return null

        // 6. THE COPY, WHICH IS THE WHOLE POINT.
        //
        // ARFrameContext's contract, stated at ARFrameContext.kt:48: "COPY
        // BEFORE OFFLOADING — nv21/yPlane/depthBytes are the SDK's own arrays,
        // reused on the next frame ... valid ONLY for the duration of the
        // synchronous process() call". `poseRotation` is named by the same
        // rule.
        //
        // 7. ⚠ INSIDE THE try, AND THE catch MUST RETURN THE BUFFER. A throw
        // between the acquire above and the submit below (an OutOfMemory on
        // the pose copy is the likely one) would otherwise leak a pool slot
        // for the rest of the sweep — the pool's version of the old gate's
        // "one transient OOM latches `busy` forever".
        val copy0 = System.nanoTime()
        val frame = try {
            System.arraycopy(context.nv21, 0, buf, 0, context.nv21.size)
            PanoPlusArIngestSlot.ArFrame(
                buf = buf,
                width = context.width,
                height = context.height,
                tsNs = context.timestampNs,
                fx = context.fx,
                fy = context.fy,
                cx = context.cx,
                cy = context.cy,
                q = context.poseRotation.copyOf(),
                exposureDurationS = if (context.exposureTimeNs > 0L) context.exposureTimeNs / 1e9 else 0.0,
                exposureISO = if (context.sensitivityIso > 0) context.sensitivityIso.toDouble() else 0.0,
            )
        } catch (t: Throwable) {
            slot.returnBuffer(buf)
            state.recordSubmitThrew(t.javaClass.simpleName)
            Log.w(TAG, "could not copy a frame for the ingest thread", t)
            return null
        }
        state.recordCopy((System.nanoTime() - copy0) / 1e6)
        // Never throws; a frame it cannot take is counted and its buffer
        // returned inside (refusedPostAcquire / submitFailed).
        slot.submit(frame)
        return null
    }

    /**
     * The engine call, on the slot's worker. Every field of [job] is a COPY or
     * a primitive — nothing here may touch the ARFrameContext, which belongs
     * to the frame the GL thread has already moved past.
     */
    private fun ingestOffThread(job: PanoPlusArIngestSlot.ArJob) {
        val f = job.frame
        val n = job.seq
        try {
            val r = PanoPlusLiveNative.ingest(
                nv21 = f.buf,
                length = f.buf.size,
                width = f.width,
                height = f.height,
                tsNs = f.tsNs,
                fx = f.fx,
                fy = f.fy,
                cx = f.cx,
                cy = f.cy,
                // ARCore's pose is world<-camera and already in the engine's own
                // convention, [x, y, z, w] — the same statement the iOS plugin
                // makes about ARKit. NO BASIS IS APPLIED on this arm, which is
                // why it cannot inherit the basis-selection or magnetometer
                // problems the rotation-vector arm has.
                q = f.q,
                // 2 is the engine's "normal", and it is honest: this line is
                // only reached when ARCore itself said TRACKING.
                tracking = 2,
                seq = n,
                // M4: ARCore's own per-frame exposure, from the frame's image
                // metadata (it used to be a zero pair, so exposure
                // normalisation ran on nothing on this arm). NOT locked —
                // ARCore offers no AE lock on a normal Session — but measured,
                // it is correctable. 0 still reads as "not measured".
                exposureDurationS = f.exposureDurationS,
                exposureISO = f.exposureISO,
            )
            state.recordIngest(r.ran, r.painted, r.outcome)
        } catch (t: Throwable) {
            // NEVER let this thread die on us. It is ours now rather than the
            // stitcher's, so a throw no longer takes the AR session down — but
            // an uncaught throw would still kill the single worker and silently
            // end the sweep, so it is caught and counted exactly as before.
            state.recordEngineThrew(t.javaClass.simpleName)
            Log.w(TAG, "ingest threw on frame $n", t)
        }
        // No gate to release any more: the slot returns this frame's buffer to
        // the pool when this function returns, on every path.
    }
}
