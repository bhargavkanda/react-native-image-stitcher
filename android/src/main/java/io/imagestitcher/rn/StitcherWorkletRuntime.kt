// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.os.HandlerThread
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * v0.8.0 Phase 3b — Android twin of iOS' `RNSARWorkletRuntime`.
 * Owns the per-AR-frame worklet runtime + the thread it dispatches
 * on.  Symmetric API shape to the iOS class so the cross-platform
 * dispatch story (Phase 3c) lands in lockstep.
 *
 * ## Phase 3b scope (this commit)
 *
 * - Singleton accessor + lifecycle (installIfNeeded / isInstalled).
 * - Dedicated `HandlerThread` for worklet dispatch — keeps work off
 *   the GLSurfaceView GL render thread (audit caveat #4 from the
 *   Phase-0 audit).
 * - `dispatchFrame()` stub — Phase 3c will fill in:
 *     1. Build `StitcherFrameHostObject` from ARCore Frame + pose
 *        (via the shared C++ JSI host object now linked into
 *        `libimage_stitcher.so` post-Phase-3a).
 *     2. Run first-party stitching synchronously on the caller
 *        thread (`onDrawFrame`'s GL thread, today).
 *     3. If host worklets are registered, dispatch the host object
 *        onto this runtime's `HandlerThread` + invoke each worklet
 *        via JNI → `RNWorklet::WorkletInvoker::call`.
 *     4. Invalidate the host object after all worklets return.
 *
 * ## Worklet-runtime construction model
 *
 * Unlike iOS (where the lib's `.mm` directly `std::make_shared`s
 * a `RNWorklet::JsiWorkletContext`), Android can't construct the
 * context purely from native C++ without elaborate JNI plumbing.
 * Phase 3c will choose between two paths:
 *
 *   - **Option A (recommended):** JS-side code calls
 *     `Worklets.createContext("stitcher.ar")` at AR-mode start;
 *     hands the resulting context pointer to this Kotlin class via
 *     a small JSI plugin.  Minimal new JNI.
 *   - **Option B:** Direct JNI binding to worklets-core's C++
 *     constructor.  More native code but no JS dependency at runtime.
 *
 * Phase 3b ships the Kotlin facade either way is compatible with;
 * Phase 3c picks one.
 *
 * @see [RNSARWorkletRuntime] iOS equivalent
 * @see [docs/plans/handoff/2026-05-26-v0.8.0-phase-0-audit.md] for the
 *      worklets-core API rationale (Audit 2: `JsiWorkletContext`).
 */
object StitcherWorkletRuntime {
    private const val TAG = "StitcherWorkletRuntime"

    /// Single-flight install guard.  `compareAndSet` makes the
    /// runtime construction race-safe across concurrent first-mount
    /// calls from multiple `<Camera>` instances.
    private val installed = AtomicBoolean(false)

    /// Dedicated dispatch thread.  Constructed eagerly so we can
    /// validate the thread starts cleanly during `installIfNeeded`.
    /// Off the GLSurfaceView GL render thread (audit caveat #4)
    /// + off the main thread.  Phase 3c will configure the worklet
    /// context's `workletCallInvoker` to post onto this thread's
    /// looper.
    private val dispatchThread: HandlerThread by lazy {
        HandlerThread("io.imagestitcher.ar-worklet-runtime").apply { start() }
    }

    /// Construct the underlying worklet context if not yet installed.
    /// Idempotent — repeated calls are no-ops.
    ///
    /// Phase 3b: starts the dispatch thread; no JsiWorkletContext
    /// construction yet (deferred to Phase 3c).
    /// Phase 3c: also wires the JsiWorkletContext + binds it to the
    /// dispatch thread's looper.
    @JvmStatic
    fun installIfNeeded() {
        if (!installed.compareAndSet(false, true)) {
            return
        }
        // Force the lazy `dispatchThread` to initialise.  If the
        // OS denies thread creation (extreme memory pressure on a
        // budget device), `HandlerThread.start()` won't throw but
        // the looper won't be available — the Phase 3c dispatch
        // logic will need to defend against that.  For Phase 3b
        // we only care that this method returns without throwing.
        val tid = dispatchThread.threadId
        Log.i(TAG, "installed runtime; dispatch thread id=$tid")
    }

    /// Diagnostics + tests.  Returns `true` after a successful
    /// `installIfNeeded()`.
    @JvmStatic
    fun isInstalled(): Boolean = installed.get()

    /// Dispatch one AR frame through the registered worklets.
    /// Called per ARCore `Frame` by `RNSARCameraView.onDrawFrame`
    /// once Phase 3c lands the migration.  Phase 3b is a no-op
    /// stub — same rationale as the iOS twin.
    ///
    /// Parameters mirror the iOS `dispatchFrame:pose:` signature.
    /// Pose is the already-decomposed quaternion + translation; the
    /// ARCore Frame is passed by JNI handle (a `Long` because
    /// Kotlin can't hold a raw C++ pointer; the Phase 3c JNI layer
    /// unboxes).
    ///
    /// @param arFrameJniRef Opaque handle to the ARCore `ArFrame*`
    ///                     (retained for the dispatch duration).
    /// @param qx,qy,qz,qw  Pose rotation quaternion (unit length).
    /// @param tx,ty,tz     Pose translation (metres, world coords).
    /// @param imageWidth   Camera image width (pixels).
    /// @param imageHeight  Camera image height (pixels).
    /// @param timestampNs  Frame timestamp in nanoseconds.
    @JvmStatic
    fun dispatchFrame(
        arFrameJniRef: Long,
        qx: Double, qy: Double, qz: Double, qw: Double,
        tx: Double, ty: Double, tz: Double,
        imageWidth: Int, imageHeight: Int,
        timestampNs: Double,
    ) {
        // Phase 3b stub.  No-op until Phase 3c.  Suppress unused-
        // parameter warnings; the args are part of the contract.
        if (!installed.get()) return
        // (Intentionally empty — see class docstring.)
        @Suppress("UNUSED_PARAMETER")
        val _suppress = arFrameJniRef + qx.toLong() + qy.toLong() +
            qz.toLong() + qw.toLong() + tx.toLong() + ty.toLong() +
            tz.toLong() + imageWidth.toLong() + imageHeight.toLong() +
            timestampNs.toLong()
    }
}
