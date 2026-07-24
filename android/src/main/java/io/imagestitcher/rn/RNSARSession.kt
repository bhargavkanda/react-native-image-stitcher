// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
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
    /// When set (document scanning), [selectMatchingCameraConfig] picks the
    /// LARGEST 4:3 CPU image instead of the smallest, so AR `takePhoto`
    /// captures at the device's highest ARCore CPU resolution.  Gated so
    /// generic AR / stitching consumers keep the cheap small-config streaming.
    @Volatile private var prefersHighResCapture = false
    /**
     * keyframeQualityCapture holders — a REFCOUNT, not a boolean: the
     * stitcher Camera can overlap two ARCameraView mounts during a
     * source/lens swap, and mount-B's enable(true) followed by
     * unmount-A's cleanup(false) must NOT switch the live session back
     * to the 640×480 config mid-pan (field finding 2026-07-10: keyframes
     * stayed 640×480 with `kfQuality=true chose 1920x1080` in the log —
     * the cleanup re-pick had yanked it back seconds later).
     */
    @Volatile private var keyframeQualityHolders = 0
    private val prefersKeyframeQuality: Boolean
        get() = keyframeQualityHolders > 0
    /// v0.23 anti-blur (`frameSelection.antiBlur.preferHighFpsFormat`) —
    /// when set, [selectMatchingCameraConfig] restricts its pick to
    /// ARCore configs that stream at >= 60 fps.  This is the ONLY
    /// exposure lever this library owns on Android: ARCore exposes no
    /// AE / SENSOR_EXPOSURE_TIME API at all, but a 60 fps config bounds
    /// exposure at 1/60 s BY CONSTRUCTION (the sensor cannot integrate
    /// longer than the frame interval), and it doubles the candidate
    /// count each sharpness window gets to choose from.  Costs stream
    /// throughput, hence opt-in.  Default false = today's pick.
    @Volatile private var prefersHighFpsFormat = false
    private val poseLog = mutableListOf<RNSARFramePose>()
    private val poseLogLock = ReentrantReadWriteLock()

    // ── v0.13.1 — Android <Camera> portrait lock ────────────────────
    //
    // Unlike iOS (where supported orientations are a static Info.plist
    // declaration the app can't override per-view at runtime), Android
    // lets a view force its host Activity's orientation via
    // `Activity.requestedOrientation`.  The SDK's `<Camera>` uses this
    // to guarantee a portrait capture surface regardless of the host
    // app's manifest — even a fully landscape/unlocked host gets a
    // portrait camera while `<Camera>` is mounted.
    //
    // `lockPortrait()` is called from `Camera.tsx`'s mount effect and
    // covers BOTH capture paths (AR ARCore view + non-AR vision-camera)
    // because the lock lives on the Activity, not on either camera view.
    // `unlockOrientation()` (mount-effect cleanup) restores the EXACT
    // orientation the Activity had before we locked, so hosts with
    // mixed-orientation screens get their prior setting back rather than
    // a generic default.
    //
    // SCREEN_ORIENTATION_UNSET (-2) is our "nothing captured yet"
    // sentinel; we never pass it to setRequestedOrientation.
    private var priorRequestedOrientation: Int = ORIENTATION_UNSET

    @ReactMethod
    fun lockPortrait() {
        val activity: Activity = reactApplicationContext.currentActivity ?: run {
            Log.w(TAG, "lockPortrait: no current activity — skipping")
            return
        }
        activity.runOnUiThread {
            // Capture the prior value ONCE (first lock wins).  Guards
            // against a remount double-capturing our own portrait value
            // and losing the host's real prior orientation.
            if (priorRequestedOrientation == ORIENTATION_UNSET) {
                priorRequestedOrientation = activity.requestedOrientation
            }
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    @ReactMethod
    fun unlockOrientation() {
        val activity: Activity = reactApplicationContext.currentActivity ?: run {
            Log.w(TAG, "unlockOrientation: no current activity — skipping")
            return
        }
        activity.runOnUiThread {
            if (priorRequestedOrientation != ORIENTATION_UNSET) {
                activity.requestedOrientation = priorRequestedOrientation
                priorRequestedOrientation = ORIENTATION_UNSET
            } else {
                // No capture on record (lock never ran or already
                // restored) — fall back to UNSPECIFIED so we don't pin
                // the host to whatever we last set.
                activity.requestedOrientation =
                    ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }
    }

    /**
     * Android side of the JS `<Camera planeDetection=...>` prop.  Sets
     * which plane orientations are EMITTED into `arAnchors`
     * (`"vertical"` | `"horizontal"` | `"both"`); an unrecognised value
     * falls back to `"vertical"`.
     *
     * Unlike iOS — where the prop narrows ARKit's `planeDetection`
     * option set — we deliberately do NOT narrow ARCore's
     * `planeFindingMode`: it stays `HORIZONTAL_AND_VERTICAL` so ARCore
     * keeps bootstrapping tracking from horizontal planes (a plain
     * vertical wall alone leaves ARCore unable to establish a
     * gravity-aligned world; see the start()/startForView() config
     * comments).  We only FILTER which plane orientations are surfaced
     * into `arAnchors` (in [RNSARCameraView.collectTrackingAnchors]).
     *
     * Void (no Promise): a fire-and-forget setter mirroring the other
     * config-prop bridge calls.
     */
    @ReactMethod
    fun setPlaneDetection(mode: String) {
        planeDetectionMode = when (mode) {
            "vertical", "horizontal", "both" -> mode
            else -> "vertical"
        }
    }

    // ── onArFrame — LIGHT AR metadata channel (v0.18.0) ───────────────
    //
    // Android side of the shared `onArFrame` contract.  Delivers light
    // AR metadata (tracking state, pose, intrinsics, depth dims, anchor
    // descriptors, mesh counts) to JS on the main thread as a normal
    // RCTDeviceEventEmitter event — NO worklets, NO zero-copy buffers.
    //
    // This is the deliberate counterpart to the `arFrameProcessor`
    // host-worklet path: worklets-core's closure-wrap crashes when an
    // AR worklet captures host objects, so `onArFrame` bypasses worklets
    // entirely and uses the bridge event channel the rest of this module
    // already uses (see `IncrementalStitcher.emitState`).
    //
    // TS sets the gate via `setArFrameMetaEnabled(true, intervalMs)` when
    // a host passes the `onArFrame` prop, and `setArFrameMetaEnabled(false, _)`
    // on unmount / prop removal.  The per-frame build + emit happens in
    // `RNSARCameraView.onDrawFrame` (the only thread guaranteed to run
    // once the AR session is live), gated + throttled by the companion
    // state set here.

    /**
     * JS-facing gate for the `onArFrame` metadata channel.
     *
     *  - `enabled`    — true while a host supplies the `onArFrame` prop.
     *  - `intervalMs` — throttle floor in milliseconds (default contract
     *                   value 100 ≈ 10 Hz).  Clamped to ≥ 0; a 0 interval
     *                   means "emit every render frame" (no throttle).
     *
     * Fire-and-forget (no Promise) — mirrors the other config-prop bridge
     * setters (`setPlaneDetection`, `lockPortrait`).
     */
    @ReactMethod
    fun setArFrameMetaEnabled(enabled: Boolean, intervalMs: Double) {
        arFrameMetaEnabled = enabled
        arFrameMetaIntervalMs = if (intervalMs.isNaN()) 100L else intervalMs.toLong().coerceAtLeast(0L)
        // Reset the throttle clock so the first frame after enabling emits
        // immediately rather than waiting out a stale interval window.
        arFrameMetaLastEmitNs = 0L
    }

    // ── enableFeaturePoints — opt-in ARCore SLAM point cloud (Android) ──
    //
    // Android twin of iOS' `RNSARSession.setFeaturePointsEnabled(_:)`.  Same
    // JS surface (`NativeModules.RNSARSession.setFeaturePointsEnabled(bool)`,
    // driven by the `<Camera enableFeaturePoints>` prop): while enabled, the
    // GL render thread acquires ARCore's sparse SLAM point cloud
    // (`Frame.acquirePointCloud()`) once per plugin-bearing frame and exposes
    // it to native AR plugins via [ARFrameContext.featurePoints] (stride-4
    // `[x, y, z, confidence]`, world space).  Off by default — when off the
    // render thread never calls `acquirePointCloud`, so a host that doesn't
    // opt in pays ZERO ARCore cost.  No session reconfiguration is needed;
    // ARCore populates the point cloud on every `Frame` regardless of config,
    // so the flag takes effect on the very next frame [RNSARCameraView]
    // processes.
    //
    // Threading mirrors [setArFrameMetaEnabled]: the flag is a `@Volatile`
    // companion field written here on the JS bridge thread and read on the GL
    // render thread in [RNSARCameraView.runArPlugins].
    //
    // Fire-and-forget (no Promise) — mirrors the other config-prop setters
    // (setPlaneDetection, setArFrameMetaEnabled, lockPortrait).

    /**
     * JS-facing gate for the ARCore feature-point cloud.  Method name matches
     * iOS exactly (`setFeaturePointsEnabled`) so the shared TS layer calls one
     * name on both platforms.
     */
    @ReactMethod
    fun setFeaturePointsEnabled(enabled: Boolean) {
        // NOTE the backing companion flag is named `featurePointsCloudEnabled`,
        // NOT `featurePointsEnabled`: a `@JvmStatic var featurePointsEnabled`
        // would synthesise a static `setFeaturePointsEnabled(Boolean)` setter
        // whose JVM signature collides with THIS @ReactMethod (same `(Z)V`),
        // failing compilation with "Platform declaration clash".  The distinct
        // name sidesteps that while keeping the JS-facing method name exact.
        featurePointsCloudEnabled = enabled
    }

    // ── 0.20.0 — AR overlay/annotation imperative API ────────────────────
    //
    // JS-facing methods backing the `<Camera>` / `<ARCameraView>` ref's
    // overlay API (setOverlays / addOverlay / updateOverlay / removeOverlay /
    // clearOverlays) AND the declarative `overlays` prop (which TS funnels
    // through `setOverlays`).  Each forwards to the bound AR camera view's
    // [AROverlayStore] JS namespace; the renderer draws the UNION of these
    // and any native-plugin overlays.  Fire-and-forget (no Promise) — mirrors
    // the other config-prop setters (setPlaneDetection, lockPortrait).
    //
    // No-op (logged) when no AR camera view is bound — the host called an
    // overlay method before mounting <ARCameraView>; the next mount will NOT
    // auto-replay JS overlays (unlike plugin overlays), so the host should
    // set overlays after mount (the declarative `overlays` prop does this
    // naturally via its mount effect).

    @ReactMethod
    fun setOverlays(overlays: com.facebook.react.bridge.ReadableArray?) {
        val view = attachedView ?: run {
            Log.d(TAG, "setOverlays: no AR camera view bound — ignoring")
            return
        }
        view.setOverlaysFromJs(AROverlayData.fromReadableArray(overlays))
    }

    @ReactMethod
    fun addOverlay(overlay: com.facebook.react.bridge.ReadableMap?) {
        val view = attachedView ?: run {
            Log.d(TAG, "addOverlay: no AR camera view bound — ignoring")
            return
        }
        val parsed = AROverlayData.fromReadableMap(overlay) ?: run {
            Log.w(TAG, "addOverlay: malformed overlay (no id / no anchor) — ignoring")
            return
        }
        view.addOverlayFromJs(parsed)
    }

    @ReactMethod
    fun updateOverlay(id: String?, patch: com.facebook.react.bridge.ReadableMap?) {
        if (id.isNullOrEmpty() || patch == null) {
            Log.w(TAG, "updateOverlay: missing id or patch — ignoring")
            return
        }
        val view = attachedView ?: run {
            Log.d(TAG, "updateOverlay: no AR camera view bound — ignoring")
            return
        }
        view.updateOverlayFromJs(id, patch)
    }

    @ReactMethod
    fun removeOverlay(id: String?) {
        if (id.isNullOrEmpty()) return
        val view = attachedView ?: run {
            Log.d(TAG, "removeOverlay: no AR camera view bound — ignoring")
            return
        }
        view.removeOverlayFromJs(id)
    }

    @ReactMethod
    fun clearOverlays() {
        val view = attachedView ?: run {
            Log.d(TAG, "clearOverlays: no AR camera view bound — ignoring")
            return
        }
        view.clearOverlaysFromJs()
    }

    // v0.20.0 — raycast from the screen-centre crosshair to the nearest real
    // surface; resolves `{ worldPosition: [x,y,z] }` or null.  The hitTest
    // needs the live ARCore frame on the GL thread, so the view fulfils it on
    // the next render tick.  Resolves null (not reject) when no view is bound
    // so the JS controller falls back to its fixed 1 m-ahead placement.
    @ReactMethod
    fun raycast(promise: Promise) {
        val view = attachedView ?: run {
            Log.d(TAG, "raycast: no AR camera view bound — resolving null")
            promise.resolve(null)
            return
        }
        view.requestRaycast(promise)
    }

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
                selectMatchingCameraConfig(it)
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
            // 2026-05-23 (crash fix) — Session.pause() stops frame
            // production but keeps the native session ALIVE: its
            // internal worker threads (tango_pool_lp4, etc.) keep
            // running.  Once the session reference is nulled here,
            // those threads become orphaned — still alive, but with
            // no owner to clean them up.  Under later memory
            // pressure scudo unmaps freed pages and an in-flight
            // tango_pool_lp4 memcpy SEGVs on an unmapped destination
            // (the crash we diagnosed from tombstone_03, with
            // libarcore_c.so internal `ImageBlockData` frames).
            //
            // Session.close() shuts down those threads AND releases
            // native resources, which is what we actually want for
            // an explicit "AR off" toggle.  Pause+close together is
            // ARCore's documented full-teardown sequence.  The next
            // start() recreates the Session from scratch (see
            // line 105's `sessionRef.get() ?: Session(...)` path).
            val prev = sessionRef.getAndSet(null)
            try {
                prev?.pause()
            } catch (t: Throwable) {
                Log.w(TAG, "stop: pause failed (ignoring): ${t.message}")
            }
            try {
                prev?.close()
            } catch (t: Throwable) {
                Log.w(TAG, "stop: close failed (ignoring): ${t.message}")
            }
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
                selectMatchingCameraConfig(it)
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
            // 2026-05-23 (crash fix) — pause + close, not just pause.
            // See the matching fix in `stop()` above for the full
            // rationale.  Short version: pause() leaves ARCore's
            // internal worker threads alive but orphaned; close()
            // tears them down.  Required for the AR-off toggle path
            // (ARCameraView unmount → onDetachedFromWindow → here).
            try {
                prev.pause()
            } catch (t: Throwable) {
                Log.w(TAG, "stopForView: pause failed (ignoring): ${t.message}")
            }
            try {
                prev.close()
            } catch (t: Throwable) {
                Log.w(TAG, "stopForView: close failed (ignoring): ${t.message}")
            }
            trackingStateRef.set(TRACKING_NOT_AVAILABLE)
            Log.i(TAG, "stopForView: AR session paused + closed")
        } catch (t: Throwable) {
            Log.w(TAG, "stopForView: teardown failed: ${t.message}", t)
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

    /**
     * Pose-ledger accessor with a watermark: resolves every pose whose frame
     * timestamp is STRICTLY AFTER `sinceNs` (nanoseconds on the AR clock —
     * the same clock [RNSARFramePose.timestampMs] is expressed in, ×10⁶),
     * in capture order.  `0` (or any negative value) = the full log, same as
     * [snapshotPoseLog].  A caller polling incrementally passes the last
     * pose's `timestampMs * 1e6` as the next watermark.  iOS twin:
     * `RNSARSession.getFramePoses(sinceNs:)`.
     */
    @ReactMethod
    fun getFramePoses(sinceNs: Double, promise: Promise) {
        val out = Arguments.createArray()
        poseLogLock.read {
            for (pose in poseLog) {
                if (pose.timestampMs * 1_000_000.0 > sinceNs) {
                    out.pushMap(pose.toWritableMap())
                }
            }
        }
        promise.resolve(out)
    }

    @ReactMethod
    fun clearPoseLog(promise: Promise) {
        clearPoseLogInternal()
        promise.resolve(null)
    }

    // ── Phase 5 (Android parity) — AR-backed photo + video capture ──
    //
    // iOS exposes takePhoto / startRecording / stopRecording on
    // RNSARSession.shared.  These are the matching @ReactMethods.
    //
    // For `takePhoto`, the actual frame capture happens on the GL
    // render thread inside RNSARCameraView (because ARCore Frame
    // objects can't be safely accessed from arbitrary threads).
    // We delegate via the bound camera view; the view's
    // `requestTakePhoto` stores the request, the next render tick
    // consumes it.
    //
    // startRecording / stopRecording are stubbed pending Android
    // AVAssetWriter equivalent (MediaRecorder + Surface ingest from
    // the GL background renderer).  Until that lands they reject
    // with a clear "not yet supported" message — better than the
    // generic "method not found" the bridge would otherwise emit.
    @ReactMethod
    fun takePhoto(options: com.facebook.react.bridge.ReadableMap, promise: Promise) {
        val view = attachedView
        if (view == null) {
            promise.reject(
                "ar-photo-no-view",
                "takePhoto: no RNSARCameraView is currently bound — mount the AR camera view first.",
            )
            return
        }
        val rawPath = if (options.hasKey("path")) options.getString("path") ?: "" else ""
        val quality = readJpegQuality(options)
        // v0.13.2 — physical device orientation from JS (useDeviceOrientation).
        // Drives the saved JPEG's rotation so landscape AR captures are
        // upright even under a portrait-locked host.  Defaults to
        // 'portrait' (pre-v0.12 behaviour) when the host omits it.
        val orientation =
            if (options.hasKey("orientation")) options.getString("orientation") ?: "portrait"
            else "portrait"
        val resolvedPath: String = if (rawPath.isNotEmpty()) {
            rawPath
        } else {
            val tmpDir = reactApplicationContext.cacheDir
            java.io.File(
                tmpDir,
                "RNImageStitcher-ar-${java.util.UUID.randomUUID()}.jpg",
            ).absolutePath
        }
        // The FULL options map rides along so registered photo-capture
        // plugins ([RNSPhotoCapturePlugin]) receive it verbatim.  With no
        // plugin registered the extra keys are never read.
        view.requestTakePhoto(resolvedPath, quality, orientation, promise, options)
    }

    /**
     * Read the `quality` option as a JPEG quality in **0..100**, falling back to
     * [DEFAULT_JPEG_QUALITY] for anything that isn't a usable value.
     *
     * WHY THIS IS NOT `options.getInt("quality")`: `getInt` TRUNCATES a JS double,
     * so a caller passing vision-camera's 0..1 convention (`quality: 0.95` — an
     * easy mistake, since `Camera.takePhoto` there is 0..1) yielded 0, and the
     * downstream `coerceIn(1, 100)` turned that into **1 — the single worst JPEG
     * the encoder can emit**.  At quality 1 every quantisation-table entry is 255,
     * so the chroma DC quantises to zero and the photo lands as near-greyscale
     * with only a few extreme-saturation blocks surviving.  That was field-reported
     * as "colour space corruption" (A35, Jul 2026); it was never a gamut problem.
     *
     * A fractional quality is therefore treated as CALLER CONFUSION and resolved to
     * the documented default rather than clipped — the same fallback-not-clip rule
     * the overlay alphas use, and for the same reason: silently producing the worst
     * possible output is never the charitable reading of a nonsense value.  It also
     * makes Android match iOS, where `as? Int` already REJECTS a non-integral
     * NSNumber and falls through to the default (which is why this only ever
     * reproduced on Android).
     *
     * Deliberately NOT auto-scaling 0..1 → 0..100: `quality: 1` is a legal (if
     * awful) request, so `1.0` cannot be reinterpreted as 100 without breaking it.
     */
    private fun readJpegQuality(options: com.facebook.react.bridge.ReadableMap): Int {
        if (!options.hasKey("quality")) return DEFAULT_JPEG_QUALITY
        if (options.getType("quality") != com.facebook.react.bridge.ReadableType.Number) {
            return DEFAULT_JPEG_QUALITY
        }
        val raw = options.getDouble("quality")
        // Non-finite, out-of-range, or fractional (never an integral 0..100).
        if (!raw.isFinite() || raw < 1.0 || raw > 100.0 || raw != kotlin.math.floor(raw)) {
            android.util.Log.w(
                "RNSARSession",
                "takePhoto: ignoring unusable quality=$raw — expected an INTEGER 0..100 " +
                    "(not vision-camera's 0..1); using $DEFAULT_JPEG_QUALITY",
            )
            return DEFAULT_JPEG_QUALITY
        }
        return raw.toInt()
    }

    @ReactMethod
    fun startRecording(options: com.facebook.react.bridge.ReadableMap, promise: Promise) {
        promise.reject(
            "ar-recording-unsupported-android",
            "startRecording is not yet implemented on Android.  Use the photo capture path " +
                "(takePhoto) or the non-AR sweep-video recorder (via vision-camera).  Tracking " +
                "issue: react-native-image-stitcher#android-ar-video.",
        )
    }

    @ReactMethod
    fun stopRecording(promise: Promise) {
        promise.reject(
            "ar-recording-unsupported-android",
            "stopRecording is not yet implemented on Android (see startRecording).",
        )
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
        // 0.20.0 — replay any plugin overlays placed BEFORE this view
        // mounted (e.g. from MainApplication.onCreate) so they render
        // immediately.  Plugin overlays live in the plugin namespace; JS
        // overlays (set via the imperative API) survive across remounts on
        // the view's own store, so we don't touch them here.
        val cached = RNSARPluginRegistry.currentPluginOverlays()
        if (cached.isNotEmpty()) {
            view.overlayStore.setPluginOverlays(cached)
        }
    }

    internal fun unbindCameraView(view: RNSARCameraView) {
        if (attachedView === view) attachedView = null
    }

    /// 0.20.0 — the bound AR camera view's overlay store, or null when no
    /// view is mounted.  Used by [RNSARPluginRegistry] to push native-plugin
    /// overlays into the live renderer.
    internal fun boundOverlayStore(): AROverlayStore? = attachedView?.overlayStore

    /**
     * Emit a pre-built [ARFrameMeta] WritableMap to JS over the shared
     * `RNImageStitcherARFrame` device event.  Called from
     * [RNSARCameraView.maybeEmitArFrameMeta] on the GL render thread.
     *
     * Uses the same `DeviceEventManagerModule.RCTDeviceEventEmitter`
     * channel as [IncrementalStitcher.emitState] — RN drops the event
     * when no JS listener is attached, so no extra gating is needed
     * beyond the enabled flag the caller already checked.  The
     * TS-required `addListener`/`removeListeners` no-op pair already
     * exists on the `IncrementalStitcher` module; the `NativeEventEmitter`
     * the TS layer constructs over `RNSARSession` needs the same pair, so
     * they're declared below.
     */
    internal fun emitArFrameMeta(meta: com.facebook.react.bridge.WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(
                    com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java,
                )
                .emit(AR_FRAME_META_EVENT, meta)
        } catch (t: Throwable) {
            // Catalyst instance torn down mid-emit (reload / unmount race),
            // or no JS context yet — drop the frame silently.  AR metadata
            // is best-effort and re-emitted every interval, so a dropped
            // frame is harmless.
            Log.d(TAG, "emitArFrameMeta: emit failed (ignoring): ${t.message}")
        }
    }

    /**
     * Emit a pre-built ASYNC plugin-result body to JS over the
     * `RNImageStitcherARPluginResult` device event (0.19.0).  Called from
     * [RNSARPluginRegistry.emit] — the body is `{ plugin, result }`.
     *
     * Reuses the SAME `DeviceEventManagerModule.RCTDeviceEventEmitter`
     * channel as [emitArFrameMeta]; RN drops the event when no JS listener
     * is attached, and a torn-down Catalyst instance is swallowed silently
     * (plugin results are best-effort).
     */
    internal fun emitArPluginResult(body: com.facebook.react.bridge.WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(
                    com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java,
                )
                .emit(AR_PLUGIN_RESULT_EVENT, body)
        } catch (t: Throwable) {
            Log.d(TAG, "emitArPluginResult: emit failed (ignoring): ${t.message}")
        }
    }

    /// Required by RN's `NativeEventEmitter` contract — the TS
    /// `onArFrame` wiring constructs a `NativeEventEmitter` over this
    /// module, which calls `addListener`/`removeListeners` on subscribe /
    /// unsubscribe.  No-op on Android: `DeviceEventManagerModule` does its
    /// own listener tracking and drops events when none are attached
    /// (same rationale as `IncrementalStitcher.addListener`).
    @ReactMethod
    fun addListener(eventName: String) { /* no-op — see KDoc */ }

    @ReactMethod
    fun removeListeners(count: Int) { /* no-op — see KDoc */ }

    private fun clearPoseLogInternal() {
        poseLogLock.write { poseLog.clear() }
    }

    /**
     * Document scanning opts in to the device's HIGHEST 4:3 ARCore CPU image
     * (vs the default smallest) so AR `takePhoto` captures at full ARCore
     * resolution.  Gated — generic AR / stitching keep the small, cheap
     * config.  If a session is already live we re-apply the config in place
     * (best-effort; setCameraConfig needs the session paused).  Called from
     * JS via the `highResCapture` prop on `<ARCameraView>` (no-op until now
     * on Android — the method didn't exist).
     */
    @ReactMethod
    fun setHighResCaptureEnabled(on: Boolean) {
        if (prefersHighResCapture == on) return
        prefersHighResCapture = on
        val session = sessionRef.get() ?: return
        try {
            session.pause()
            selectMatchingCameraConfig(session)
            session.resume()
            Log.i(TAG, "setHighResCaptureEnabled=$on; re-applied config to live session")
        } catch (t: Throwable) {
            Log.w(TAG, "setHighResCaptureEnabled reconfig failed (ignoring): ${t.message}")
        }
    }

    /**
     * Panorama keyframe QUALITY opt-in (`keyframeQualityCapture` prop on
     * `<ARCameraView>`): picks a larger ARCore CPU-image config (largest
     * long-edge ≤ 1920, aspect as tiebreak — see selectMatchingCameraConfig)
     * and lifts the keyframe encoder's long-edge budget 640 → 1280.  The
     * pano flows opt in; DT/liveness sessions never set it, so their frame
     * costs stay at the cheap 640×480 default.  The ARCameraView effect
     * resets it to false on unmount (single-camera app: no concurrent
     * session can observe the global encoder budget mid-flip).
     */
    @ReactMethod
    fun setKeyframeQualityCaptureEnabled(on: Boolean) {
        // ACQUIRE/RELEASE semantics (see keyframeQualityHolders): each
        // ARCameraView mount that opts in calls (true) once and its
        // unmount cleanup calls (false) once; overlapping mounts during a
        // camera swap keep the count > 0 so the live session never
        // downgrades mid-pan. Only an EFFECTIVE state change re-picks.
        val wasOn: Boolean
        val isOn: Boolean
        synchronized(this) {
            wasOn = keyframeQualityHolders > 0
            keyframeQualityHolders =
                (keyframeQualityHolders + if (on) 1 else -1).coerceAtLeast(0)
            isOn = keyframeQualityHolders > 0
        }
        Log.i(
            TAG,
            "setKeyframeQualityCaptureEnabled($on): holders=$keyframeQualityHolders " +
                "effective=$isOn",
        )
        if (wasOn == isOn) return
        io.imagestitcher.rn.ar.YuvImageConverter.setKeyframeQuality(isOn)
        val session = sessionRef.get() ?: return
        try {
            session.pause()
            selectMatchingCameraConfig(session)
            session.resume()
            Log.i(TAG, "keyframeQuality effective=$isOn; re-applied config to live session")
        } catch (t: Throwable) {
            Log.w(TAG, "setKeyframeQualityCaptureEnabled reconfig failed (ignoring): ${t.message}")
        }
    }

    /**
     * v0.23 anti-blur — opt in to a >= 60 fps ARCore camera config
     * (`frameSelection.antiBlur.preferHighFpsFormat`).  Called from
     * `IncrementalStitcher.start()` through the singleton, mirroring
     * iOS' `RNSARSession.setHighFpsFormatEnabled`.
     *
     * Same live-session semantics as [setHighResCaptureEnabled]: the
     * config can only be swapped on a PAUSED session, so an already
     * running session is paused/reconfigured/resumed in place.  That
     * costs an ARCore tracking reset, which is why the no-change guard
     * comes first — a host that leaves the setting alone (the default)
     * never touches the session at all.  Best-effort: any failure keeps
     * the current config and the capture proceeds.
     */
    internal fun setHighFpsFormatEnabled(on: Boolean) {
        if (prefersHighFpsFormat == on) return
        prefersHighFpsFormat = on
        val session = sessionRef.get() ?: return
        try {
            session.pause()
            selectMatchingCameraConfig(session)
            session.resume()
            Log.i(TAG, "setHighFpsFormatEnabled=$on; re-applied config to live session")
        } catch (t: Throwable) {
            Log.w(TAG, "setHighFpsFormatEnabled reconfig failed (ignoring): ${t.message}")
        }
    }

    /**
     * Pick an ARCore camera config whose CPU image and GPU texture share
     * the same aspect ratio, so the preview (texture) and the captured /
     * stitched frames (acquireCameraImage) cover the SAME field of view.
     *
     * ARCore's default often pairs a 16:9 GPU texture with a 4:3 CPU
     * image (e.g. 1920x1080 texture + 640x480 image on the Galaxy A35):
     * the texture is then missing ~12 deg of vertical sensor FOV the
     * image has, so the preview can never match the photo.  Choosing a
     * config where the two aspects match (preferring 4:3 for max FOV,
     * then the highest image resolution) makes preview == capture by
     * construction -- and usually raises the stitched-frame / photo
     * resolution above 640x480 as a bonus.
     *
     * Must be called on a freshly-created, un-resumed session (ARCore
     * requires the session paused for setCameraConfig).  Best-effort: on
     * any failure we keep ARCore's default config.
     */
    private fun selectMatchingCameraConfig(session: Session) {
        try {
            val allConfigs = session.getSupportedCameraConfigs(CameraConfigFilter(session))
            if (allConfigs.isEmpty()) return
            fun aspect(s: android.util.Size): Float = s.width.toFloat() / s.height.toFloat()

            // v0.23 anti-blur — narrow the field to >= 60 fps configs
            // first, so the resolution rules below choose WITHIN the
            // short-exposure set rather than against it.  Falls back to
            // the full list when the device has no 60 fps config (many
            // don't): a missing high-fps option must never cost the
            // caller their resolution preference.
            val configs = if (prefersHighFpsFormat) {
                allConfigs
                    .filter { (it.fpsRange?.upper ?: 0) >= 60 }
                    .ifEmpty { allConfigs }
            } else {
                allConfigs
            }

            // Option B (max FOV + bounded memory): prefer the 4:3-aspect
            // IMAGE for full vertical sensor FOV, regardless of texture aspect
            // (the A35 only pairs its 4:3 image with a 16:9 texture, so an
            // aspect-MATCH filter would force 16:9 and lose that FOV).  Among
            // 4:3 images prefer the SMALLEST resolution — the keyframe is
            // downscaled to AR_KEYFRAME_MAX_LONG_EDGE anyway, so smallest is
            // closest to that budget + cheapest.  Device-agnostic: any
            // device's 4:3 image is chosen, then normalised by the downscale
            // guard in YuvImageConverter.  Trade-off: the 16:9 preview texture
            // shows less than the 4:3 capture (accepted for max FOV).
            // Document scanning: MAXIMISE resolution regardless of aspect.  On
            // the A35 the only 4:3 ARCore config is 640×480 (0.3 MP), but its
            // 1920×1080 (16:9) is 2 MP — 6× the pixels; crop-to-document doesn't
            // need the 4:3 FOV, so the bigger 16:9 image wins for OCR.  Generic
            // AR / stitching keep the 4:3 + SMALLEST pick (max FOV, cheap stream
            // — keyframes downscale anyway).
            // NB the parentheses around the whole if-chain: with a bare
            // `if/else-if/else ?: return`, Kotlin binds the elvis to the
            // LAST branch only, leaving `chosen` nullable (compile error at
            // the Log below).
            val chosen: CameraConfig = (if (prefersHighResCapture) {
                configs.maxByOrNull { it.imageSize.width * it.imageSize.height }
            } else if (prefersKeyframeQuality) {
                // PANO KEYFRAME QUALITY (keyframeQualityCapture): the
                // smallest-4:3 default is 640×480 on devices like the A35 —
                // panos assembled from 0.3 MP tiles read as "very blurry"
                // regardless of hand steadiness.  Pick the LARGEST image
                // whose long edge fits the 1920 source budget (the keyframe
                // encoder then downsamples to its lifted 1280 budget —
                // ~2× supersampled).  Aspect is a tiebreak only: on the A35
                // the sole 4:3 config IS the tiny one, so insisting on 4:3
                // would defeat the feature; the 16:9 1920×1080 (2 MP, 6×
                // the pixels) wins.  Falls through to the default pick when
                // nothing fits the budget.
                configs
                    .filter {
                        kotlin.math.max(it.imageSize.width, it.imageSize.height) <=
                            KEYFRAME_QUALITY_SOURCE_MAX_LONG_EDGE
                    }
                    .sortedWith(
                        compareByDescending<CameraConfig> {
                            it.imageSize.width * it.imageSize.height
                        }.thenBy { kotlin.math.abs(aspect(it.imageSize) - 4f / 3f) },
                    ).firstOrNull()
                    ?: configs.sortedWith(
                        compareBy<CameraConfig> { kotlin.math.abs(aspect(it.imageSize) - 4f / 3f) }
                            .thenBy { it.imageSize.width * it.imageSize.height },
                    ).firstOrNull()
            } else {
                configs.sortedWith(
                    compareBy<CameraConfig> { kotlin.math.abs(aspect(it.imageSize) - 4f / 3f) }
                        .thenBy { it.imageSize.width * it.imageSize.height },
                ).firstOrNull()
            }) ?: return
            session.setCameraConfig(chosen)
            Log.i(
                TAG,
                "selectMatchingCameraConfig: highRes=$prefersHighResCapture " +
                    "kfQuality=$prefersKeyframeQuality highFps=$prefersHighFpsFormat " +
                    "chose image=" +
                    "${chosen.imageSize.width}x${chosen.imageSize.height} texture=" +
                    "${chosen.textureSize.width}x${chosen.textureSize.height} fps=" +
                    "${chosen.fpsRange} | all=[" +
                    allConfigs.joinToString {
                        "${it.imageSize.width}x${it.imageSize.height}@${it.fpsRange?.upper}"
                    } + "]",
            )
        } catch (t: Throwable) {
            Log.w(TAG, "selectMatchingCameraConfig failed; keeping default config: ${t.message}")
        }
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
         * `takePhoto` JPEG quality (0..100) when the caller omits `quality` or
         * passes something unusable — see [readJpegQuality].  Matches the iOS
         * default in `ARSessionBridge.takePhoto`.
         */
        private const val DEFAULT_JPEG_QUALITY = 90
        /** keyframeQualityCapture source budget: largest ARCore CPU image
         *  whose long edge fits this (A35: picks 1920×1080 over 640×480);
         *  the keyframe encoder then downsamples to its 1280 budget. */
        private const val KEYFRAME_QUALITY_SOURCE_MAX_LONG_EDGE = 1920

        // Sentinel for "no prior Activity orientation captured yet".
        // Distinct from any real ActivityInfo.SCREEN_ORIENTATION_*
        // value (those are >= -1); -2 is unused by the framework.
        private const val ORIENTATION_UNSET = -2

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

        /**
         * Which plane orientations reach `arAnchors`:
         * `"vertical"` | `"horizontal"` | `"both"`.
         *
         * Default `"vertical"` preserves the legacy plane-projected
         * stitch path (the shutter-gate / evaluatePlanesForFrame logic
         * only ever cared about vertical planes), so existing hosts see
         * no change unless they opt into a wider filter via the JS
         * `<Camera planeDetection=...>` prop (→ [setPlaneDetection]).
         *
         * Read on the GL render thread in
         * [RNSARCameraView.collectTrackingAnchors]; written from the JS
         * thread via [setPlaneDetection] — hence `@Volatile`.
         */
        @JvmStatic
        @Volatile
        var planeDetectionMode: String = "vertical"

        // ── onArFrame gate + throttle (v0.18.0) ──────────────────────
        //
        // Written from the JS thread via [setArFrameMetaEnabled];
        // read on the GL render thread in
        // [RNSARCameraView.maybeEmitArFrameMeta] — hence `@Volatile`.
        //
        //  - `arFrameMetaEnabled`     — gate: only build+emit when true.
        //  - `arFrameMetaIntervalMs`  — throttle floor (ms); contract
        //                               default 100 (≈10 Hz).
        //  - `arFrameMetaLastEmitNs`  — monotonic clock of the last emit
        //                               (System.nanoTime()); 0 = "never",
        //                               reset on every enable so the first
        //                               post-enable frame emits at once.
        @JvmStatic
        @Volatile
        var arFrameMetaEnabled: Boolean = false

        @JvmStatic
        @Volatile
        var arFrameMetaIntervalMs: Long = 100L

        @JvmStatic
        @Volatile
        var arFrameMetaLastEmitNs: Long = 0L

        // ── enableFeaturePoints gate (Android feature-point cloud) ────
        //
        // Written from the JS thread via [setFeaturePointsEnabled]; read on
        // the GL render thread in [RNSARCameraView.runArPlugins] — hence
        // `@Volatile`.  When false the render thread never calls
        // `Frame.acquirePointCloud()`, so a non-opted-in host pays no ARCore
        // cost.  Default off (parity with iOS `isFeaturePointsEnabled`).
        //
        // Named `featurePointsCloudEnabled` (not `featurePointsEnabled`) on
        // purpose: as a `@JvmStatic var`, the shorter name would emit a static
        // `setFeaturePointsEnabled(Boolean)` setter that clashes with the
        // instance `@ReactMethod setFeaturePointsEnabled(Boolean)` (identical
        // `(Z)V` JVM signature).  See the note in [setFeaturePointsEnabled].
        @JvmStatic
        @Volatile
        var featurePointsCloudEnabled: Boolean = false

        /// Event name carrying the [ARFrameMeta] payload to JS.  MUST
        /// match the shared contract + the iOS `supportedEvents` entry +
        /// the TS `NativeEventEmitter` subscription string exactly.
        const val AR_FRAME_META_EVENT = "RNImageStitcherARFrame"

        /// Event name carrying an ASYNC plugin result to JS (0.19.0).
        /// MUST match [RNSARPluginRegistry.AR_PLUGIN_RESULT_EVENT], the
        /// iOS `supportedEvents` entry, and the TS subscription string.
        const val AR_PLUGIN_RESULT_EVENT =
            RNSARPluginRegistry.AR_PLUGIN_RESULT_EVENT
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
