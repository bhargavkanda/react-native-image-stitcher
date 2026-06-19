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
 *     1. Build `CameraFrameHostObject` from ARCore Frame + pose
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

    /// v0.8.0 Phase 4b.iii — fan out one AR frame to every host
    /// worklet registered in the shared C++ `StitcherWorkletRegistry`
    /// (populated from JS via `__stitcherProxy.install(workletFn)`).
    ///
    /// Called from `RNSARCameraView.onDrawFrame` immediately after
    /// `runFirstParty { ... }` returns, with the already-extracted
    /// AR frame data (pose + NV21 bytes + dimensions + tracking
    /// state).
    ///
    /// **Fast-path:** the native side queries the registry's count
    /// FIRST and returns before copying any bytes when no host
    /// worklets are registered.  In the common first-party-only
    /// deployment, this method costs one JNI call + one C++ atomic
    /// read per frame — negligible.
    ///
    /// **When host worklets ARE registered:** the JNI layer copies
    /// the NV21 byte array into an owned C++ `std::vector` (so the
    /// async dispatch can outlive ARCore's `Image.close()` scope),
    /// builds a `CameraFrameJsiHostObject`, and posts a lambda
    /// onto worklets-core's default `JsiWorkletContext`'s worklet
    /// thread.  The lambda iterates the registry's
    /// `WorkletInvoker`s, calls each with the JSI host object as
    /// its argument, and invalidates the host object after the
    /// last invoker returns.  Per-worklet failure isolation: one
    /// host worklet throwing does NOT stop the lib's stitching or
    /// the other host worklets.
    ///
    /// **Threading:** this method returns synchronously on the
    /// caller's thread.  The actual worklet invocations happen
    /// asynchronously on the worklets-core thread; the caller does
    /// NOT block on them.
    ///
    /// **Caller-thread contract:** the caller (`RNSARCameraView`'s
    /// `onDrawFrame`) MUST have already invoked `runFirstParty`
    /// before calling this method.  The first-party stitching
    /// path holds the synchronous ARCore Image consumption
    /// contract; the host-worklet dispatch does not.
    ///
    /// @param nv21Bytes      Pre-packed NV21 byte array.  COPIED
    ///                       into a native owned buffer; caller can
    ///                       release the reference after return.
    /// @param width          Camera image width (pixels).
    /// @param height         Camera image height (pixels).
    /// @param qx,qy,qz,qw    Pose rotation quaternion (unit length).
    /// @param tx,ty,tz       Pose translation (metres, world coords).
    /// @param timestampNs    Frame timestamp in nanoseconds.
    /// @param trackingState  One of "" / "notAvailable" / "limited"
    ///                       / "normal".  Empty string ⇒ JS-side
    ///                       `arTrackingState` is `undefined`.
    /// @param depthBytes     Raw ARCore DEPTH16 bytes, dense row-packed
    ///                       (`depthWidth*depthHeight*2` bytes, uint16/px,
    ///                       low 13 bits = mm, high 3 bits = confidence).
    ///                       `null` when depth is unavailable this frame —
    ///                       the JNI then leaves `data.arDepth == nullopt`.
    /// @param depthWidth     Depth-map width (px); 0 when no depth.
    /// @param depthHeight    Depth-map height (px); 0 when no depth.
    /// @param anchorIds      Parallel arrays describing every TRACKING
    /// @param anchorTypes    anchor: stable id, coarse type
    /// @param anchorTransforms ("plane"/"image"/"point"/"mesh"), and a
    ///                       16-element ROW-MAJOR (anchor->world) transform
    ///                       (identity for the depth-derived "mesh" anchor —
    ///                       its vertices are camera-local).  Empty when no
    ///                       anchors/mesh were collected.
    /// @param anchorMeshVertices Parallel per-anchor mesh byte arrays: a
    /// @param anchorMeshFaces    Float32-xyz vertex buffer + a Uint32 index
    ///                       buffer for the depth-derived mesh anchor, `null`
    ///                       for every non-mesh anchor.  Carried verbatim to
    ///                       the JNI which sets `ArAnchor.hasMesh` + the
    ///                       mesh vectors when both are non-null.
    @JvmStatic
    fun dispatchToHostWorklets(
        nv21Bytes: ByteArray,
        width: Int,
        height: Int,
        qx: Double, qy: Double, qz: Double, qw: Double,
        tx: Double, ty: Double, tz: Double,
        timestampNs: Double,
        trackingState: String,
        depthBytes: ByteArray?,
        depthWidth: Int,
        depthHeight: Int,
        anchorIds: Array<String>,
        anchorTypes: Array<String>,
        anchorTransforms: Array<DoubleArray>,
        anchorMeshVertices: Array<ByteArray?>,
        anchorMeshFaces: Array<ByteArray?>,
        fx: Double, fy: Double, cx: Double, cy: Double,
        intrinsicsImageWidth: Int, intrinsicsImageHeight: Int,
        anchorAlignments: Array<String>,
        anchorExtents: Array<DoubleArray?>,
    ) {
        if (!installed.get()) return
        nativeDispatchToHostWorklets(
            nv21Bytes, width, height,
            qx, qy, qz, qw,
            tx, ty, tz,
            timestampNs, trackingState,
            depthBytes, depthWidth, depthHeight,
            anchorIds, anchorTypes, anchorTransforms,
            anchorMeshVertices, anchorMeshFaces,
            fx, fy, cx, cy,
            intrinsicsImageWidth, intrinsicsImageHeight,
            anchorAlignments, anchorExtents,
        )
    }

    /// v0.8.0 Phase 4b.iii — number of registered host worklets.
    /// Cheap (microsecond) call into the native registry.  Used by
    /// `RNSARCameraView.onDrawFrame` to gate the per-frame
    /// NV21-pack + dispatch path: when no worklets are registered
    /// AND no capture is active, the entire `forwardToIncremental`
    /// branch can be skipped, saving the ~3-5ms NV21 pack cost per
    /// idle preview frame.
    @JvmStatic
    fun hasHostWorklets(): Boolean {
        if (!installed.get()) return false
        return nativeRegistryCount() > 0
    }

    /// Per-frame AR-metadata extraction toggles (the JS-driven
    /// enableDepth/enableAnchors/enableMesh `<Camera>` props, written via
    /// `__stitcherProxy.setExtractionConfig`).  Read once per frame in
    /// `RNSARCameraView.forwardToIncremental` to GATE the costly ARCore
    /// depth-acquire / anchor-collect / mesh-build work — all default OFF,
    /// so a host pays zero AR-metadata cost until it opts in.
    ///
    /// Returns all-false (no extraction) before `installIfNeeded()` runs.
    data class ExtractionFlags(
        val depth: Boolean,
        val anchors: Boolean,
        val mesh: Boolean,
    )

    @JvmStatic
    fun extractionFlags(): ExtractionFlags {
        if (!installed.get()) return ExtractionFlags(false, false, false)
        val bits = nativeExtractionFlags()
        return ExtractionFlags(
            depth = (bits and 0x1) != 0,
            anchors = (bits and 0x2) != 0,
            mesh = (bits and 0x4) != 0,
        )
    }

    @JvmStatic
    private external fun nativeRegistryCount(): Int

    /// JNI binding: `nativeExtractionFlags` in
    /// `android/src/main/cpp/stitcher_jsi_install_jni.cpp`.  Packs
    /// `retailens::getExtractionConfig()` into a bitmask
    /// (bit0=depth, bit1=anchors, bit2=mesh).
    @JvmStatic
    private external fun nativeExtractionFlags(): Int

    /// JNI binding: `android/src/main/cpp/stitcher_jsi_install_jni.cpp`'s
    /// `nativeDispatchToHostWorklets`.  Fast-path early-exit lives
    /// inside the native function — see its docstring.
    @JvmStatic
    private external fun nativeDispatchToHostWorklets(
        nv21Bytes: ByteArray,
        width: Int,
        height: Int,
        qx: Double, qy: Double, qz: Double, qw: Double,
        tx: Double, ty: Double, tz: Double,
        timestampNs: Double,
        trackingState: String,
        depthBytes: ByteArray?,
        depthWidth: Int,
        depthHeight: Int,
        anchorIds: Array<String>,
        anchorTypes: Array<String>,
        anchorTransforms: Array<DoubleArray>,
        anchorMeshVertices: Array<ByteArray?>,
        anchorMeshFaces: Array<ByteArray?>,
        fx: Double, fy: Double, cx: Double, cy: Double,
        intrinsicsImageWidth: Int, intrinsicsImageHeight: Int,
        anchorAlignments: Array<String>,
        anchorExtents: Array<DoubleArray?>,
    )

    init {
        // The JSI install module (`StitcherJsiInstallerModule`)
        // already loads `libimage_stitcher` at class load.  We
        // load it again here defensively in case
        // `StitcherWorkletRuntime` is referenced before the install
        // module — `System.loadLibrary` is idempotent.
        System.loadLibrary("image_stitcher")
    }
}
