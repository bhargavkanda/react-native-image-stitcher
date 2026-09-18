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
// RNISPanoPlusPlugin.shared)` at PanoPlusBridge.swift:646 — with ARKit owning
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
// `forwardToIncremental` (:517) -> `runArPlugins` (:1215), and the library's own
// comment at :1221 says so: "Written by runArPlugins on the GL render thread".
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
//     thread also DRAWS THE VIEWFINDER: backgroundRenderer.draw runs at :444,
//     but GLSurfaceView swaps buffers only when onDrawFrame RETURNS, so the
//     drawn frame does not reach the screen until our ingest finishes. Viewport
//     cadence WAS our ingest cadence. Measured on that pack: ingest p50 40.5 ms,
//     p99 234.0 ms, max 300.7 ms. The picture could not be smoother than that,
//     and the non-AR arm was unaffected because its viewfinder is a TextureView
//     fed straight from Camera2 and never touches our threads.
//
//   · THE TIME-ALIGNMENT OBJECTION DOES NOT APPLY TO A COPY. ARFrameContext
//     hands over the pose AND the pixels in ONE callback. Carrying that matched
//     pair to another thread preserves the alignment exactly. The objection is
//     to re-SAMPLING a pose beside a queue of pixels, which is a different
//     design and not this one. Nothing about `q` changes here.
//
// So: the gates stay on the GL thread (microseconds), the frame is COPIED into
// a reused buffer, and the engine runs on our own single thread. One ingest in
// flight, drop-and-count on top.
//
// ⚠ AND THE GATE IS TAKEN BEFORE THE DUPLICATE WATERMARK, WHICH IS NOT AN
// ARBITRARY ORDER. This arm is a POLLING producer — the GL loop re-offers the
// SAME ARCore frame every tick until a newer one lands — so a frame refused for
// backpressure comes back in ~11 ms and can still be taken. Advancing the
// watermark first would make that re-offer read as a duplicate and lose the
// frame outright, at a measured cost of roughly a THIRD of the engine's input.
// See the comment in `process`; it is the one ordering in this file that a
// reader is most likely to 'tidy' and must not.
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
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

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
     * The thread the engine actually runs on. ONE thread, so frames keep their
     * delivery order — the engine's chain requires monotonic timestamps and a
     * pool would reorder them.
     *
     * Daemon: this plugin is a process-wide singleton, so the thread must never
     * be the reason the process stays alive.
     */
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "rnis-pp-ar-ingest").apply { isDaemon = true }
    }

    /** True while an ingest is in flight. See the backpressure note in [process]. */
    private val busy = AtomicBoolean(false)

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
        try {
            io.imagestitcher.rn.RNSARPluginRegistry.register(this)
        } catch (t: Throwable) {
            // A host without the stitcher linked: the arm cannot work, and the
            // pack must say so rather than reporting a plausible silence.
            state.recordThrew("register:" + t.javaClass.simpleName)
            Log.w(TAG, "could not register with RNSARPluginRegistry", t)
        }
        state.arm()
        Log.i(TAG, "armed and registered — pano+ will ingest the stitcher's ARCore frames")
    }

    /**
     * Disarm AND unregister. The stitcher's AR view outlives our sweep, so a
     * plugin left registered and armed would keep feeding a finished engine.
     */
    fun disarm() {
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
        state.disarm()
        try {
            io.imagestitcher.rn.RNSARPluginRegistry.unregister(NAME)
        } catch (t: Throwable) {
            Log.w(TAG, "could not unregister from RNSARPluginRegistry", t)
        }
        Log.i(TAG, "disarmed and unregistered — ${state.counters()}")
    }


    fun snapshot(): WritableNativeMap = WritableNativeMap().apply {
        for ((k, v) in state.counters()) {
            when (v) {
                is Boolean -> putBoolean(k, v)
                is Double -> putDouble(k, v)
                else -> putString(k, v.toString())
            }
        }
    }

    override fun process(context: ARFrameContext): WritableMap? {
        val verdict = state.verdict(
            context.trackingState, context.width, context.height, context.fx, context.fy,
        )
        if (verdict != ArFrameVerdict.INGEST) return null

        // ── BACKPRESSURE FIRST, WATERMARK SECOND. THE ORDER IS THE FIX. ──────
        //
        // ⚠ THIS ARM IS A POLLING PRODUCER, AND THAT CHANGES WHAT A DROP COSTS.
        // The GL loop free-runs (RENDERMODE_CONTINUOUSLY, RNSARCameraView.kt:78)
        // and ARCore is in LATEST_CAMERA_IMAGE (RNSARSession.kt:504), so when no
        // newer camera image has landed `session.update()` returns THE SAME
        // frame, unchanged timestamp and all, and the library de-duplicates
        // nothing. The identical frame is therefore re-offered to us tick after
        // tick — roughly every 11 ms — until a newer one arrives.
        //
        // So a frame refused HERE is not lost: it comes back almost immediately
        // and is taken the instant the worker frees. But if the watermark were
        // advanced first, that re-offer would read as a duplicate and the frame
        // would be gone for good — forfeiting a whole camera period per busy
        // cycle, measured at roughly a THIRD of the engine's input.
        //
        // This is exactly where the Camera2 precedent does NOT transfer. There
        // (PanoPlusAndroidRecorder.kt:3978-4001) an ImageReader hands each image
        // over exactly once, so drop-and-forget forfeits nothing. Here it does.
        //
        // One ingest in flight, dropped and counted — never a queue: at 3.11 MB
        // per frame a queue would reach a gigabyte in seconds of stall, which is
        // the jetsam kill the Camera2 arm's own comment refuses.
        if (!busy.compareAndSet(false, true)) {
            state.recordDroppedBusy()
            return null
        }

        // NOW the watermark, and only for a frame we are actually going to
        // ingest. A duplicate must release the gate on its way out or the arm
        // wedges shut.
        if (!state.acceptTs(context.timestampNs)) {
            busy.set(false)
            return null
        }

        val n = state.nextSeq()

        // ── THE COPY, WHICH IS THE WHOLE POINT ──────────────────────────────
        //
        // ARFrameContext's contract, stated at ARFrameContext.kt:48: "COPY
        // BEFORE OFFLOADING — nv21/yPlane/depthBytes are the SDK's own arrays,
        // reused on the next frame ... valid ONLY for the duration of the
        // synchronous process() call". `poseRotation` is named by the same
        // rule.
        //
        // ⚠ INSIDE THE try, AND THE try MUST RELEASE THE GATE. A 3.11 MB
        // allocation is exactly the one that throws OutOfMemory first, and a
        // throw between the CAS above and the worker submit below would leave
        // `busy` latched true forever — one transient OOM would silently end
        // every sweep for the life of the process.
        try {
            val nv21 = scratchFor(context.nv21)
            val q = context.poseRotation.copyOf()
            val w = context.width
            val h = context.height
            val tsNs = context.timestampNs
            val fx = context.fx
            val fy = context.fy
            val cx = context.cx
            val cy = context.cy
            worker.execute { ingestOffThread(nv21, w, h, tsNs, fx, fy, cx, cy, q, n) }
        } catch (t: Throwable) {
            busy.set(false)
            state.recordThrew("submit:" + t.javaClass.simpleName)
            Log.w(TAG, "could not hand frame $n to the ingest thread", t)
        }
        return null
    }

    /**
     * The frame buffer handed to [worker], reusing one allocation.
     *
     * ⚠ SAFE ONLY BECAUSE OF THE SINGLE-IN-FLIGHT GATE, so do not lift this out
     * of it. The caller holds `busy`, which means the previous ingest has
     * already returned and nothing else can be reading this array; and no
     * further frame can be admitted until the worker releases the gate. One
     * writer, then one reader, never overlapping.
     *
     * It exists because the alternative allocates 3.11 MB per frame — ~93 MB/s
     * at 30 fps, straight into ART's large-object space, on the very render
     * thread whose pauses this whole change is meant to remove. Trading a GC
     * pause on the GL thread for a memcpy is the entire point.
     */
    private var scratch: ByteArray? = null

    private fun scratchFor(src: ByteArray): ByteArray {
        val dst = scratch?.takeIf { it.size == src.size } ?: ByteArray(src.size).also { scratch = it }
        System.arraycopy(src, 0, dst, 0, src.size)
        return dst
    }

    /**
     * The engine call, on [worker]. Every argument is a COPY or a primitive —
     * nothing here may touch the ARFrameContext, which belongs to the frame the
     * GL thread has already moved past.
     */
    private fun ingestOffThread(
        nv21: ByteArray,
        w: Int,
        h: Int,
        tsNs: Double,
        fx: Double,
        fy: Double,
        cx: Double,
        cy: Double,
        q: DoubleArray,
        n: Long,
    ) {
        try {
            val r = PanoPlusLiveNative.ingest(
                nv21 = nv21,
                length = nv21.size,
                width = w,
                height = h,
                tsNs = tsNs,
                fx = fx,
                fy = fy,
                cx = cx,
                cy = cy,
                // ARCore's pose is world<-camera and already in the engine's own
                // convention, [x, y, z, w] — the same statement the iOS plugin
                // makes about ARKit. NO BASIS IS APPLIED on this arm, which is
                // why it cannot inherit the basis-selection or magnetometer
                // problems the rotation-vector arm has.
                q = q,
                // 2 is the engine's "normal", and it is honest: this line is
                // only reached when ARCore itself said TRACKING.
                tracking = 2,
                seq = n,
                // No Camera2 stream on this arm, so no CaptureResult and no
                // exposure pair. 0 reads as "not measured", never as a measured
                // zero — the same shape the iOS ARKit arm has always had.
                exposureDurationS = 0.0,
                exposureISO = 0.0,
            )
            state.recordIngest(r.ran, r.painted, r.outcome)
        } catch (t: Throwable) {
            // NEVER let this thread die on us. It is ours now rather than the
            // stitcher's, so a throw no longer takes the AR session down — but
            // an uncaught throw would still kill the single worker and silently
            // end the sweep, so it is caught and counted exactly as before.
            state.recordThrew(t.javaClass.simpleName)
            Log.w(TAG, "ingest threw on frame $n", t)
        } finally {
            // ALWAYS, on every path. A gate that is not released is an arm that
            // never ingests again.
            busy.set(false)
        }
    }
}
