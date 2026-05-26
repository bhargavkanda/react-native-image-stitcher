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
 * context purely from native C++ without JNI plumbing.  Phase 3c
 * will choose between two paths:
 *
 *   - **Option A:** JS-side code calls
 *     `Worklets.createContext("stitcher.ar")` at AR-mode start;
 *     hands the resulting context pointer to this Kotlin class via
 *     a small JSI plugin.  Minimal new JNI.  **Phase 3b's
 *     HandlerThread becomes dead code** under this option — the
 *     JS-side `Worklets.createContext` picks its own thread.  We'd
 *     need to remove the HandlerThread + change `installIfNeeded`
 *     into a no-op until a `setContextHandle(Long)` setter lands.
 *   - **Option B:** Direct JNI binding to worklets-core's C++
 *     constructor.  More native code but no JS dependency at runtime.
 *     **Phase 3b's HandlerThread is exactly the right scaffold**
 *     under this option — its looper becomes the JsiWorkletContext's
 *     `workletCallInvoker` target.
 *
 * **Phase 3b assumption: Option B is the more likely path.**  The
 * scaffolding below (HandlerThread + serial dispatch) fits Option
 * B; if Phase 3c picks Option A instead, the HandlerThread becomes
 * unused and Phase 3c will refactor accordingly.
 *
 * @see [RNSARWorkletRuntime] iOS equivalent
 * @see docs/plans/handoff/2026-05-26-v0.8.0-phase-0-audit.md
 *      worklets-core API rationale (Audit 2: `JsiWorkletContext`).
 * @see docs/plans/handoff/2026-05-26-v0.8.0-phases-2-5-implementation-guide.md
 *      Phase 3c implementation plan.
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
        //
        // Log `Thread.id` (Java-side monotonic, always non-zero) —
        // NOT `HandlerThread.threadId` (Linux tid set after first
        // Looper-prepared message; reading from this caller thread
        // immediately after .start() returns -1 until scheduled).
        val javaThreadId = dispatchThread.id
        Log.i(TAG, "installed runtime; dispatch java-thread id=$javaThreadId")
    }

    /// Diagnostics + tests.  Returns `true` after a successful
    /// `installIfNeeded()`.
    @JvmStatic
    fun isInstalled(): Boolean = installed.get()

    /// v0.8.0 Phase 3c — first-party stitching dispatch.  Invokes
    /// the supplied block synchronously on the caller thread
    /// (`onDrawFrame`'s GL render thread today).
    ///
    /// Phase 3c minimum-viable: this is the closure-based equivalent
    /// of iOS' first-party callback.  The block is the original
    /// `module.ingestFromARCameraView(...)` call site moved
    /// verbatim into a lambda — no behaviour change, just an
    /// indirection so Phase 4 can interpose host-worklet fanout
    /// without touching the engine ingest path.
    ///
    /// **Why synchronous + on the caller thread:** the engine's
    /// `ingestFromARCameraView` takes ownership of the ARCore
    /// `Image`-derived NV21 buffer (via the v0.10.0 `TransferredNV21`
    /// wrapper).  ARCore's `Image.close()` happens after this call
    /// returns, so the consumer must finish reading the bytes before
    /// we return — exactly what synchronous block invocation
    /// provides.  Phase 4 will copy the buffer for off-thread
    /// access in host worklets; Phase 3c keeps the sync contract.
    ///
    /// If `installIfNeeded()` hasn't been called yet, the block
    /// still runs (no-op on the registry side).  Defensive — the
    /// caller may call this method before `installIfNeeded` is
    /// wired up.
    @JvmStatic
    fun runFirstParty(block: () -> Unit) {
        // Synchronous invocation — Phase 4 will extend this to also
        // post the registered host worklets onto `dispatchThread`.
        // Not `inline`: Phase 4 will need to read `dispatchThread`
        // (private) from inside this function body, and Kotlin's
        // inline functions can't access private members from call
        // sites outside the declaring class.  Per-frame lambda
        // alloc is ~ns and the alternative (callers passing a
        // method reference) doesn't materially change cost.
        block()
    }

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
    //
    // Phase 3c gate: install/idempotence tests + dispatchFrame
    // integration test required before merging Phase 3c.  See
    // CLAUDE.md's "tests with mocked deps prove nothing" mandate
    // + the audit's #11A Android JUnit scaffold.
    @Suppress("UNUSED_PARAMETER")
    @JvmStatic
    fun dispatchFrame(
        arFrameJniRef: Long,
        qx: Double, qy: Double, qz: Double, qw: Double,
        tx: Double, ty: Double, tz: Double,
        imageWidth: Int, imageHeight: Int,
        timestampNs: Double,
    ) {
        // Phase 3b stub.  No-op until Phase 3c.  The function-level
        // @Suppress above silences UNUSED_PARAMETER warnings; the
        // body stays clean.  When Phase 3c implements the dispatch,
        // the suppression comes off naturally (every param will be
        // read by the dispatch logic).
        if (!installed.get()) return
        // (Intentionally empty — see class docstring.)
    }
}
