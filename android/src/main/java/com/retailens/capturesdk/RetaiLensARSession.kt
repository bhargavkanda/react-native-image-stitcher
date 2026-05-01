// SPDX-License-Identifier: UNLICENSED
package com.retailens.capturesdk

import android.app.Activity
import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.UnavailableException
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * Android twin of iOS's `RetaiLensARSession`.
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
class RetaiLensARSession(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RetaiLensARSession"

    /// Tracking state values mirror the iOS enum exactly.
    /// 0 = notAvailable, 1 = initialising, 2 = tracking, 3 = limited.
    /// JS code does not need conditional branching across platforms.
    private val trackingStateRef = AtomicReference(TRACKING_NOT_AVAILABLE)
    private val sessionRef = AtomicReference<Session?>(null)
    private val poseLog = mutableListOf<RetaiLensARFramePose>()
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
                planeFindingMode = Config.PlaneFindingMode.DISABLED
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
    internal fun appendPose(pose: RetaiLensARFramePose) {
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
    internal fun poseClosestTo(targetMs: Double, maxToleranceMs: Double = 50.0): RetaiLensARFramePose? {
        var best: RetaiLensARFramePose? = null
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

    /// Used by `RetaiLensARCameraView` to borrow the underlying
    /// ARCore Session for rendering + per-frame `update()`.  Returns
    /// null when the session hasn't been started yet (the view will
    /// retry on the next render frame).
    internal fun getSessionForView(): Session? = sessionRef.get()

    /// Camera view registers + unregisters itself so the bridge can
    /// keep track of who's actively rendering.  Currently used only
    /// for diagnostics (the view feeds frames into the engine via
    /// the bridge module's static reference, no fan-out needed yet).
    @Volatile private var attachedView: RetaiLensARCameraView? = null

    internal fun bindCameraView(view: RetaiLensARCameraView) {
        attachedView = view
    }

    internal fun unbindCameraView(view: RetaiLensARCameraView) {
        if (attachedView === view) attachedView = null
    }

    private fun clearPoseLogInternal() {
        poseLogLock.write { poseLog.clear() }
    }

    companion object {
        // Mirrors RetaiLensARTrackingState on iOS for cross-platform
        // identical JS behaviour.
        const val TRACKING_NOT_AVAILABLE = 0
        const val TRACKING_INITIALISING = 1
        const val TRACKING_TRACKING = 2
        const val TRACKING_LIMITED = 3

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
        var instance: RetaiLensARSession? = null
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
 * `RetaiLensARFramePose`; same JSON shape so the JS bridge sees
 * identical data on both platforms.
 */
internal data class RetaiLensARFramePose(
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
