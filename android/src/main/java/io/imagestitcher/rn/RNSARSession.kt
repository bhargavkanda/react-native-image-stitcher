// SPDX-License-Identifier: UNLICENSED
package io.imagestitcher.rn

import android.app.Activity
import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Plane
import com.google.ar.core.Pose
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.UnavailableException
import kotlin.math.abs
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * Android twin of iOS's `RNSARSession`.
 *
 * Phase 4 foundation for the AR measurement plan
 * (docs/site-content/design/2026-04-29-ar-measurement-and-detection.md).
 * Wraps ARCore in a singleton + RN bridge with the same JS surface
 * as iOS:
 *
 *   isSupported()       → Promise<boolean>
 *   start()             → Promise<void>
 *   stop()              → Promise<void>
 *   getState()          → Promise<{ isRunning, trackingState }>
 *   snapshotPoseLog()   → Promise<FramePose[]>
 *   clearPoseLog()      → Promise<void>
 *
 * Trade-offs vs iOS:
 *   - ARCore needs an `Activity` context to install Play Services
 *     for AR if the user doesn't have it; we keep a soft-ref to
 *     `currentActivity` from the React context.
 *   - Pose updates come from `Frame.getCamera().getPose()` polled
 *     each frame (caller drives the polling — typically the
 *     ARCore-backed CameraView).  Phase 4.4 wires that up.
 */
class RNSARSession(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RNSARSession"

    /// Tracking state values mirror the iOS enum exactly.
    /// 0 = notAvailable, 1 = initialising, 2 = tracking, 3 = limited.
    /// JS code does not need conditional branching across platforms.
    private val trackingStateRef = AtomicReference(TRACKING_NOT_AVAILABLE)
    private val sessionRef = AtomicReference<Session?>(null)
    private val poseLog = mutableListOf<RNSARFramePose>()
    private val poseLogLock = ReentrantReadWriteLock()

    @ReactMethod
    fun isSupported(promise: Promise) {
        // `checkAvailability` can return UNKNOWN_CHECKING if the
        // device's support status hasn't been polled yet — that's
        // the first-launch case.  Treat UNKNOWN as "available" so
        // the UI shows the AR feature; the actual `start` call will
        // surface a clearer error if the device truly can't run AR.
        val availability = ArCoreApk.getInstance().checkAvailability(reactApplicationContext)
        val supported = availability.isSupported || availability.isTransient
        promise.resolve(supported)
    }

    @ReactMethod
    fun start(promise: Promise) {
        // ReactContextBaseJavaModule.getCurrentActivity() — Java
        // getter, no Kotlin property syntax.  ARCore's installer
        // path needs an Activity to attach the consent dialog to.
        val activity: Activity? = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject(
                "no-activity",
                "AR session requires an active Activity; was none attached when start() was called.",
            )
            return
        }
        try {
            // ArCoreApk install path — kicks off Play Services for
            // AR install dialog on first call if needed.  We call
            // it synchronously from the same Activity each time
            // start() is invoked; subsequent calls are no-ops once
            // installation is complete.
            val installStatus = ArCoreApk.getInstance().requestInstall(activity, true)
            when (installStatus) {
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
                    // User was prompted; system will resume our Activity
                    // when the dialog returns.  Caller should call
                    // start() again from onResume().
                    trackingStateRef.set(TRACKING_NOT_AVAILABLE)
                    promise.resolve(null)
                    return
                }
                ArCoreApk.InstallStatus.INSTALLED -> { /* fall through */ }
            }

            val session = sessionRef.get() ?: Session(reactApplicationContext).also {
                sessionRef.set(it)
            }
            val config = Config(session).apply {
                // Smoothed depth is the ARCore equivalent of iOS
                // sceneDepth — only available on Depth-API-supported
                // devices.  Toggle on if available; the resume() call
                // below validates configuration and will reject if
                // the device can't deliver what we asked for.
                if (session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
                    depthMode = Config.DepthMode.AUTOMATIC
                }
                // HORIZONTAL_AND_VERTICAL (not VERTICAL-only) — ARCore
                // bootstraps its world model from SfM on whatever planes
                // it can find.  Field testing showed VERTICAL-only mode
                // yields trackingV=0 indefinitely on plain walls (the
                // user's Galaxy A35), because ARCore can't establish a
                // gravity-aligned world reference without seeing the
                // floor/desk first.  Detecting horizontal planes too
                // gives ARCore the world anchor it needs, which then
                // unblocks vertical plane detection on the shelf wall.
                // We still filter to vertical-only at evaluation time
                // in evaluatePlanesForFrame — the JS shutter-gate only
                // unlocks on a latched VERTICAL plane.
                planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
                focusMode = Config.FocusMode.AUTO
                lightEstimationMode = Config.LightEstimationMode.DISABLED
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
            }
            session.configure(config)
            session.resume()

            clearPoseLogInternal()
            trackingStateRef.set(TRACKING_INITIALISING)
            promise.resolve(null)
        } catch (e: UnavailableException) {
            trackingStateRef.set(TRACKING_NOT_AVAILABLE)
            promise.reject("ar-unavailable", e.message, e)
        } catch (t: Throwable) {
            promise.reject("ar-start-failed", t.message, t)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            sessionRef.getAndSet(null)?.pause()
            trackingStateRef.set(TRACKING_NOT_AVAILABLE)
            clearPoseLogInternal()
            promise.resolve(null)
        } catch (t: Throwable) {
            promise.reject("ar-stop-failed", t.message, t)
        }
    }

    // ── Internal lifecycle hooks for the AR camera view ──────────────────
    //
    // Mirror of iOS' `RNSARSession.shared.start()` /
    // `.stop()` calls from `RNSARCameraView.didMoveToWindow`.
    // The Promise-based `start(promise)` / `stop(promise)` above
    // remain the canonical JS-facing API; these synchronous twins
    // exist so the native view can self-bootstrap its session
    // without round-tripping through the JS bridge.
    //
    // Key differences vs the Promise variants:
    //   - No Promise (return a Boolean from `startForView`;
    //     `stopForView` is fire-and-forget).
    //   - Errors are LOGGED, not thrown.  Failure leaves the view
    //     in its cleared-black state; the user can recover via
    //     navigating away + back, or via a future explicit start().
    //   - `startForView` does NOT clear the pose log.  Pose log is
    //     host-controlled (per iOS comment in didMoveToWindow:
    //     "Don't clear the pose log here; the host explicitly
    //     clears between captures via clearPoseLog()").
    //   - Both methods are idempotent.  Multiple ARCameraView
    //     instances mounting/unmounting concurrently won't race
    //     destructively (AtomicReference does the sequencing).

    /**
     * Ensure the AR session is running.  Called from
     * [RNSARCameraView.onAttachedToWindow].  Returns true
     * iff a session is now running.
     *
     * Return-value semantics:
     *   - true: session is now (or was already) running.  Caller
     *     can immediately borrow it via `getSessionForView()`.
     *   - false: session is NOT running.  Possible reasons:
     *       * no current Activity attached
     *       * ARCore install dialog was shown (INSTALL_REQUESTED) —
     *         caller should expect a follow-up onAttachedToWindow
     *         after the user returns from the install flow
     *       * ARCore reports the device unsupported or transient
     *         unavailable
     *       * configure / resume threw — see logcat for the cause
     *
     * Threading: must be called on the main thread (ARCore's
     * `Session.resume()` requires it).  `onAttachedToWindow` is
     * guaranteed to be on the main thread, so callers don't need
     * to hop queues.
     */
    internal fun startForView(): Boolean {
        // Fast path: session already running.
        sessionRef.get()?.let {
            Log.i(TAG, "startForView: session already running")
            return true
        }
        val activity: Activity = reactApplicationContext.currentActivity ?: run {
            Log.w(
                TAG,
                "startForView: no current Activity; deferring AR start " +
                    "(view will retry on next onAttachedToWindow)",
            )
            return false
        }
        return try {
            // ArCoreApk install path — shows the Play Services for
            // AR install dialog on first call if the user doesn't
            // have it.  Subsequent calls return INSTALLED quickly.
            when (ArCoreApk.getInstance().requestInstall(activity, true)) {
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
                    Log.i(
                        TAG,
                        "startForView: ARCore install prompt shown; " +
                            "will retry on next view attach",
                    )
                    trackingStateRef.set(TRACKING_NOT_AVAILABLE)
                    return false
                }
                ArCoreApk.InstallStatus.INSTALLED -> { /* fall through */ }
            }

            val session = Session(reactApplicationContext).also {
                sessionRef.set(it)
            }
            val config = Config(session).apply {
                if (session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
                    depthMode = Config.DepthMode.AUTOMATIC
                }
                // HORIZONTAL_AND_VERTICAL (not VERTICAL-only) — ARCore
                // bootstraps its world model from SfM on whatever planes
                // it can find.  Field testing showed VERTICAL-only mode
                // yields trackingV=0 indefinitely on plain walls (the
                // user's Galaxy A35), because ARCore can't establish a
                // gravity-aligned world reference without seeing the
                // floor/desk first.  Detecting horizontal planes too
                // gives ARCore the world anchor it needs, which then
                // unblocks vertical plane detection on the shelf wall.
                // We still filter to vertical-only at evaluation time
                // in evaluatePlanesForFrame — the JS shutter-gate only
                // unlocks on a latched VERTICAL plane.
                planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
                focusMode = Config.FocusMode.AUTO
                lightEstimationMode = Config.LightEstimationMode.DISABLED
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
            }
            session.configure(config)
            session.resume()

            trackingStateRef.set(TRACKING_INITIALISING)
            Log.i(TAG, "startForView: AR session started successfully")
            true
        } catch (e: UnavailableException) {
            Log.w(TAG, "startForView: AR unavailable: ${e.message}", e)
            trackingStateRef.set(TRACKING_NOT_AVAILABLE)
            sessionRef.set(null)
            false
        } catch (t: Throwable) {
            Log.w(TAG, "startForView: unexpected failure: ${t.message}", t)
            sessionRef.set(null)
            false
        }
    }

    /**
     * Pause + release the AR session.  Called from
     * [RNSARCameraView.onDetachedFromWindow].  Frees the
     * hardware camera so other consumers (vision-camera, packaged
     * camera app via picker, etc.) can claim it.
     *
     * Does NOT clear the pose log — see iOS parity comment above.
     */
    internal fun stopForView() {
        try {
            val prev = sessionRef.getAndSet(null)
            if (prev == null) {
                // Nothing to stop — view detached without a session.
                // Common on first-attach failures (no Activity, etc.).
                return
            }
            prev.pause()
            trackingStateRef.set(TRACKING_NOT_AVAILABLE)
            Log.i(TAG, "stopForView: AR session paused")
        } catch (t: Throwable) {
            Log.w(TAG, "stopForView: pause failed: ${t.message}", t)
        }
    }

    @ReactMethod
    fun getState(promise: Promise) {
        val map = Arguments.createMap()
        map.putBoolean("isRunning", sessionRef.get() != null)
        map.putInt("trackingState", trackingStateRef.get())
        promise.resolve(map)
    }

    @ReactMethod
    fun snapshotPoseLog(promise: Promise) {
        val out = Arguments.createArray()
        poseLogLock.read {
            for (pose in poseLog) {
                out.pushMap(pose.toWritableMap())
            }
        }
        promise.resolve(out)
    }

    @ReactMethod
    fun clearPoseLog(promise: Promise) {
        clearPoseLogInternal()
        promise.resolve(null)
    }

    /**
     * Internal entry point used by the (Phase 4.4) AR-backed
     * camera view to push a fresh pose into the log.  Called on
     * the GL render thread once per frame.  Bounded by
     * MAX_POSE_LOG.
     */
    internal fun appendPose(pose: RNSARFramePose) {
        poseLogLock.write {
            poseLog.add(pose)
            if (poseLog.size > MAX_POSE_LOG) {
                val drop = poseLog.size - MAX_POSE_LOG
                repeat(drop) { poseLog.removeAt(0) }
            }
        }
    }

    /**
     * Find the pose closest to `targetMs` (timestamps in ms since
     * session start), within `maxToleranceMs`.
     */
    internal fun poseClosestTo(targetMs: Double, maxToleranceMs: Double = 50.0): RNSARFramePose? {
        var best: RNSARFramePose? = null
        var bestDelta = Double.POSITIVE_INFINITY
        poseLogLock.read {
            for (p in poseLog) {
                val d = Math.abs(p.timestampMs - targetMs)
                if (d < bestDelta) {
                    bestDelta = d
                    best = p
                }
            }
        }
        return if (bestDelta > maxToleranceMs) null else best
    }

    /**
     * Update tracking state — called by the camera view as ARCore
     * reports tracking changes.
     */
    internal fun updateTrackingState(arState: TrackingState) {
        val mapped = when (arState) {
            TrackingState.TRACKING -> TRACKING_TRACKING
            TrackingState.PAUSED -> TRACKING_LIMITED
            TrackingState.STOPPED -> TRACKING_NOT_AVAILABLE
        }
        trackingStateRef.set(mapped)
    }

    // ── V15.0e — Vertical plane detection (iOS parity) ────────────────
    //
    // Mirror of iOS' RNSARSession.swift planar-detection state +
    // relatchPlaneFromCurrentAnchors algorithm.  iOS runs evaluation
    // continuously via ARKit's ARSessionDelegate didUpdate callbacks;
    // ARCore on Android exposes per-frame plane trackables only from
    // session.update() (which the camera view drives).  We therefore
    // run evaluatePlanesForFrame() from RNSARCameraView.onDrawFrame.
    //
    // State is read by JS via getARPlaneStatus() at 2 Hz; the shutter
    // gate in AuditCaptureScreen.tsx (planeShutterGate) flips to enabled
    // when status == "ready".
    //
    // The algorithm:
    //   1. Iterate all currently-tracking VERTICAL planes.
    //   2. Skip subsumed planes (ARCore merges overlapping planes into
    //      a larger one; the subsumed-by reference flags the merged-into
    //      child).
    //   3. Compute alignment = |planeNormal · cameraForward| — must
    //      exceed planeAlignmentThreshold (default 0.6 ≈ 53° max
    //      off-camera) to be considered.
    //   4. Reject planes with area < MIN_PLANE_AREA_M2 (0.20 m²) —
    //      these are typically ARCore artifacts (sign edges, reflective
    //      patches) that briefly fit but aren't real scan targets.
    //   5. Among passing planes, pick the CLOSEST by perpendicular
    //      distance — closest plane is most likely the foreground scan
    //      target (the V15.0g.3 heuristic on iOS).
    //   6. Track the best REJECTED alignment so the JS UI can show
    //      "found plane but off-axis (best 0.45)" guidance.

    /// Minimum plane area to be considered for latching.
    /// Matches iOS' kMinPlaneArea in RNSARSession.swift.
    private val minPlaneAreaM2: Float = 0.20f  // 0.45m × 0.45m

    /// V15.0d — minimum |planeNormal · cameraForward| for a plane to
    /// be eligible for latching.  Tunable from JS via the existing
    /// `arkitPlaneAlignmentThreshold` setting in the panorama config.
    /// Range [0, 1]: 0 = accept any vertical plane; 1 = only accept
    /// perfectly camera-facing planes.  Default 0.6 (≈ 53°).
    @Volatile var planeAlignmentThreshold: Float = 0.6f

    /// V15.0e — best alignment seen on a candidate plane that was
    /// REJECTED by the alignment filter.  -1.0 = no candidate seen
    /// yet.  Drives the "evaluating" UI state in getARPlaneStatus().
    /// Read on the JS thread, written on the GL render thread.
    @Volatile private var bestRejectedAlignment: Float = -1.0f

    /// Pose of the currently latched plane (or null if no lock).  We
    /// store the centerPose (not the Plane reference) so the value is
    /// stable across the plane being subsumed or losing tracking — the
    /// pose snapshot is what the stitcher cares about anyway.
    /// Read on the JS thread, written on the GL render thread.
    @Volatile private var latchedPlanePose: Pose? = null

    /// Public read-only view of the latch status, used by hasPlaneDetected
    /// getter and by the bridge method.  iOS parity: hasPlaneDetected
    /// is a getter that reads detectedPlaneTransformInternal.
    internal val hasPlaneDetected: Boolean
        get() = latchedPlanePose != null

    /// Returns the latched plane transform as a Pose, or null if no
    /// plane is currently latched.  Used by the slit-scan engine
    /// (when ported) for plane-projected stitching.
    internal val latchedPlaneTransform: Pose?
        get() = latchedPlanePose

    /**
     * Per-frame plane evaluation — called from
     * [RNSARCameraView.onDrawFrame] AFTER session.update().
     *
     * Mirrors iOS' RNSARSession.swift::relatchPlaneFromCurrentAnchors,
     * but runs every frame (ARKit re-runs internally on iOS; we mirror
     * by polling every ARCore frame at ~60 Hz).  Continuous evaluation
     * means the JS 2 Hz getARPlaneStatus poll sees a live answer
     * without the user having to press anything.
     *
     * @param cameraForwardWorld unit vector pointing where the camera
     *                            is looking, in world space (precomputed
     *                            by the camera view — usually -zAxis of
     *                            the camera pose).
     * @param cameraPosWorld     camera origin in world space (translation
     *                            component of the camera pose).
     */
    /**
     * Rate-limit diagnostic logging — log at most once every N frames
     * so we don't flood logcat at 60 Hz.  30 = ~2 logs per second.
     */
    private var planeEvalLogTick: Int = 0
    private val planeEvalLogStride: Int = 30

    internal fun evaluatePlanesForFrame(
        cameraForwardWorld: FloatArray,
        cameraPosWorld: FloatArray,
    ) {
        val session = sessionRef.get() ?: return

        var bestPlane: Plane? = null
        var bestPerpDist = Float.POSITIVE_INFINITY
        var bestAlignment = -1.0f
        var thisFrameBestRejected = -1.0f
        // Diagnostic counters — surfaced via the rate-limited log
        // below so field testing can see WHY plane detection is slow.
        var seenVertical = 0
        var seenHorizontal = 0
        var seenSubsumed = 0
        var seenNotTracking = 0
        var rejectedAlignment = 0
        var rejectedArea = 0

        for (plane in session.getAllTrackables(Plane::class.java)) {
            if (plane.trackingState != TrackingState.TRACKING) {
                seenNotTracking++
                continue
            }
            // Skip planes that were merged into a parent — ARCore keeps
            // both alive but only the parent is the real geometry.
            if (plane.subsumedBy != null) {
                seenSubsumed++
                continue
            }
            // Count by type for diagnostic visibility.
            when (plane.type) {
                Plane.Type.VERTICAL -> seenVertical++
                Plane.Type.HORIZONTAL_UPWARD_FACING,
                Plane.Type.HORIZONTAL_DOWNWARD_FACING -> seenHorizontal++
                else -> { /* none */ }
            }
            // Vertical only — shelf-scanning use case.
            if (plane.type != Plane.Type.VERTICAL) continue

            // ARCore convention: plane.centerPose's Y axis is the plane
            // normal (the plane lies in the X-Z plane of its pose).
            // ARCore 1.45's Pose.getYAxis() returns a new FloatArray —
            // no two-arg fill-buffer overload in this version.
            val normal = plane.centerPose.yAxis

            val alignment = abs(
                normal[0] * cameraForwardWorld[0]
                + normal[1] * cameraForwardWorld[1]
                + normal[2] * cameraForwardWorld[2]
            )

            if (alignment < planeAlignmentThreshold) {
                if (alignment > thisFrameBestRejected) {
                    thisFrameBestRejected = alignment
                }
                rejectedAlignment++
                continue
            }

            // extentX and extentZ are the plane size along the local X
            // and Z axes (Y is the normal).
            val area = plane.extentX * plane.extentZ
            if (area < minPlaneAreaM2) {
                rejectedArea++
                continue
            }

            // Perpendicular distance from camera to plane:
            //   |(planeCenter - cameraPos) · planeNormal|
            // Lower = closer.  Closer wins (V15.0g.3 heuristic).
            val center = plane.centerPose
            val dx = center.tx() - cameraPosWorld[0]
            val dy = center.ty() - cameraPosWorld[1]
            val dz = center.tz() - cameraPosWorld[2]
            val perpDist = abs(dx * normal[0] + dy * normal[1] + dz * normal[2])

            if (perpDist < bestPerpDist) {
                bestPlane = plane
                bestPerpDist = perpDist
                bestAlignment = alignment
            }
        }

        // Publish atomic state changes.  Latching: a plane found this
        // frame replaces any prior latch.  Once latched, a subsequent
        // frame with NO eligible planes does NOT un-latch (matches iOS
        // behaviour — once a plane is locked, the user can pan around
        // and we keep the lock until they explicitly relatch).
        if (bestPlane != null) {
            latchedPlanePose = bestPlane.centerPose
        }
        bestRejectedAlignment = thisFrameBestRejected

        // ── Rate-limited diagnostic log ──────────────────────────────
        // Surfaces WHY plane detection is or isn't latching.  Logs
        // once every planeEvalLogStride frames (default ~2 Hz).  Field
        // testing protocol: tail logcat with `adb logcat -s
        // RNSARSession:V`, navigate to AuditCapture, watch this
        // tick to understand whether ARCore is finding planes at all,
        // and if it is, why they're being rejected.
        if (planeEvalLogTick++ % planeEvalLogStride == 0) {
            val latched = latchedPlanePose != null
            // Read ARCore camera tracking state — updated each frame
            // by the view's appendPose path.  TRACKING=2 means ARCore
            // has a confident world model; LIMITED=3 means it's still
            // bootstrapping; NOT_AVAILABLE=0 means the session is
            // initialising.  Plane detection ONLY happens once
            // tracking == TRACKING.
            val trackingStateInt = trackingStateRef.get()
            val trackingLabel = when (trackingStateInt) {
                TRACKING_TRACKING -> "TRACKING"
                TRACKING_LIMITED -> "LIMITED"
                TRACKING_INITIALISING -> "INITIALISING"
                TRACKING_NOT_AVAILABLE -> "NOT_AVAILABLE"
                else -> "UNKNOWN($trackingStateInt)"
            }
            Log.i(
                TAG,
                "evaluatePlanes: " +
                    "track=$trackingLabel " +
                    "vert=$seenVertical " +
                    "horiz=$seenHorizontal " +
                    "notTracking=$seenNotTracking " +
                    "subsumed=$seenSubsumed " +
                    "rejAlign=$rejectedAlignment " +
                    "rejArea=$rejectedArea " +
                    "bestThisAlign=${"%.2f".format(bestAlignment)} " +
                    "bestRejAlign=${"%.2f".format(thisFrameBestRejected)} " +
                    "thresh=${"%.2f".format(planeAlignmentThreshold)} " +
                    "latched=$latched",
            )
        }
    }

    /**
     * Force-clear the latch and best-rejected.  Called by
     * relatchARPlane bridge method — next ARCore frame's
     * evaluatePlanesForFrame will re-populate.
     */
    internal fun clearPlaneLatch() {
        latchedPlanePose = null
        bestRejectedAlignment = -1.0f
    }

    // ── Helpers consumed by IncrementalStitcher's @ReactMethod ─
    //
    // iOS exposes getARPlaneStatus / relatchARPlane on the JS module
    // `IncrementalStitcher` (the IncrementalStitcherBridge —
    // see iOS IncrementalStitcherBridge.swift); both methods delegate
    // to `RNSARSession.shared`.  We mirror that JS-callable
    // surface: the `@ReactMethod` versions live on
    // IncrementalStitcher.kt and call these helpers.  This
    // keeps JS unchanged across platforms (it calls
    // `NativeIncrementalModule.getARPlaneStatus()`, not
    // `RNSARSession.getARPlaneStatus()`).

    /**
     * Build the plane-status payload — caller resolves the Promise.
     * Shape MUST match iOS' `getARPlaneStatus()` exactly so the JS
     * TypeScript interface ARPlaneStatus is satisfied identically.
     */
    internal fun buildARPlaneStatusMap(): com.facebook.react.bridge.WritableMap {
        val hasPlane = latchedPlanePose != null
        val rejected = bestRejectedAlignment
        val status = when {
            hasPlane -> "ready"
            rejected > 0.0f -> "evaluating"
            else -> "searching"
        }
        val map = Arguments.createMap()
        map.putString("status", status)
        map.putBoolean("hasPlane", hasPlane)
        map.putDouble("bestAlignment", rejected.toDouble())
        map.putDouble("threshold", planeAlignmentThreshold.toDouble())
        return map
    }

    /// Used by `RNSARCameraView` to borrow the underlying
    /// ARCore Session for rendering + per-frame `update()`.  Returns
    /// null when the session hasn't been started yet (the view will
    /// retry on the next render frame).
    internal fun getSessionForView(): Session? = sessionRef.get()

    /// Camera view registers + unregisters itself so the bridge can
    /// keep track of who's actively rendering.  Currently used only
    /// for diagnostics (the view feeds frames into the engine via
    /// the bridge module's static reference, no fan-out needed yet).
    @Volatile private var attachedView: RNSARCameraView? = null

    internal fun bindCameraView(view: RNSARCameraView) {
        attachedView = view
    }

    internal fun unbindCameraView(view: RNSARCameraView) {
        if (attachedView === view) attachedView = null
    }

    private fun clearPoseLogInternal() {
        poseLogLock.write { poseLog.clear() }
    }

    companion object {
        // Mirrors RNSARTrackingState on iOS for cross-platform
        // identical JS behaviour.
        const val TRACKING_NOT_AVAILABLE = 0
        const val TRACKING_INITIALISING = 1
        const val TRACKING_TRACKING = 2
        const val TRACKING_LIMITED = 3

        private const val TAG = "RNSARSession"
        private const val MAX_POSE_LOG = 600  // ~10 s @ 60Hz

        /**
         * Convenience accessor for the AR camera view (in Phase 4.4)
         * to reach the singleton-installed module instance.  We use
         * a static accessor rather than dependency injection because
         * the AR camera view is constructed by RN's view manager,
         * which doesn't have easy access to the bridge module
         * registry.
         */
        @JvmStatic
        @Volatile
        var instance: RNSARSession? = null
            private set
    }

    init {
        // Singleton-style: keep the most recently-constructed
        // instance accessible to the AR camera view.  RN may
        // reconstruct modules across reloads; the AR camera view
        // always uses the latest reference.
        instance = this
    }
}


/**
 * Plain data class for a single frame's pose.  Mirror of iOS'
 * `RNSARFramePose`; same JSON shape so the JS bridge sees
 * identical data on both platforms.
 */
internal data class RNSARFramePose(
    val tx: Double, val ty: Double, val tz: Double,
    val qx: Double, val qy: Double, val qz: Double, val qw: Double,
    val fx: Double, val fy: Double, val cx: Double, val cy: Double,
    val imageWidth: Int, val imageHeight: Int,
    val timestampMs: Double,
    val trackingState: Int,
) {
    fun toWritableMap(): com.facebook.react.bridge.WritableMap {
        val m = com.facebook.react.bridge.Arguments.createMap()
        m.putDouble("tx", tx); m.putDouble("ty", ty); m.putDouble("tz", tz)
        m.putDouble("qx", qx); m.putDouble("qy", qy); m.putDouble("qz", qz); m.putDouble("qw", qw)
        m.putDouble("fx", fx); m.putDouble("fy", fy); m.putDouble("cx", cx); m.putDouble("cy", cy)
        m.putInt("imageWidth", imageWidth); m.putInt("imageHeight", imageHeight)
        m.putDouble("timestampMs", timestampMs)
        m.putInt("trackingState", trackingState)
        return m
    }
}
