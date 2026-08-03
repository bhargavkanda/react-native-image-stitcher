// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.content.Context
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import android.widget.FrameLayout
import com.google.ar.core.Anchor
import com.google.ar.core.Camera
import com.google.ar.core.Pose
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.ResourceExhaustedException
import com.google.ar.core.exceptions.SessionPausedException
import io.imagestitcher.rn.ar.BackgroundRenderer
import io.imagestitcher.rn.ar.YuvImageConverter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.asin

/**
 * Android twin of `RNSARCameraView.swift` (iOS Phase 4.4).
 *
 * Embeds a `GLSurfaceView` that renders the ARCore camera feed and
 * drives the AR session's per-frame `update()` loop on the GL render
 * thread.  When the incremental stitcher is running, each frame's
 * camera image is converted to JPEG and fed into the engine with the
 * matching ARCore pose — full parity with iOS' ARSession path (no
 * gyro fallback needed when this view is mounted).
 *
 * Why a GLSurfaceView and not a TextureView / SurfaceView:
 *   ARCore needs a GL_TEXTURE_EXTERNAL_OES texture as its camera
 *   sink (Session.setCameraTextureName).  Only a GLSurfaceView with
 *   EGL14 context gives us the OES extension.  The Renderer
 *   callback is also where the per-frame Session.update() lives, so
 *   the threading model lines up cleanly.
 *
 * Lifecycle:
 *   onAttachedToWindow      → mark "wants to render", borrow Session
 *                              from RNSARSession.instance
 *   onSurfaceCreated (GL)   → create OES texture, build BackgroundRenderer
 *   onSurfaceChanged (GL)   → notify session of display geometry
 *   onDrawFrame (GL)        → session.update(); pose → log;
 *                              if stitcher running: image → JPEG → engine
 *   onDetachedFromWindow    → pause render thread; do NOT pause Session
 *                              (other views may still be using it)
 */
class RNSARCameraView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : FrameLayout(context, attrs, defStyle), GLSurfaceView.Renderer {

    // Raw camera sensor aspect ratio (W÷H, always > 1 for landscape sensors).
    // Initialised to 4:3 — a safe fallback for the first layout pass before
    // the session is attached.  Updated from session.cameraConfig once the
    // session is available; many Android ARCore devices use 16:9 configs
    // (e.g. Pixel phones), so reading it dynamically is important here.
    private var cameraAspect: Float = 4f / 3f

    private val glView: GLSurfaceView = GLSurfaceView(context).also { v ->
        v.preserveEGLContextOnPause = true
        v.setEGLContextClientVersion(2)
        v.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        v.setRenderer(this)
        v.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
    }

    private val backgroundRenderer = BackgroundRenderer()
    private val sessionRef = AtomicReference<Session?>(null)
    private var sessionTextureBound = false

    // ── 0.20.0 — AR overlay/annotation renderer ─────────────────────────
    //
    // [overlayStore] is the single source of truth for the overlays to
    // draw (UNION of JS-set + native-plugin-set; see [AROverlayStore]);
    // [overlayRenderer] is the transparent Canvas View stacked ABOVE the
    // GLSurfaceView in this FrameLayout.  Per frame, [onDrawFrame] snapshots
    // the camera view/projection matrices + the letterbox box and pushes
    // them into the renderer (which reprojects + redraws on the UI thread).
    //
    // The store is exposed (via [overlayStore] internal) so the native
    // plugin path ([RNSARPluginRegistry.setOverlays] etc.) and the JS
    // imperative path ([RNSARSession] @ReactMethods → bound view) both write
    // to it; the JS imperative path uses the JS namespace, plugins the
    // plugin namespace.
    val overlayStore = AROverlayStore()
    private val overlayRenderer = AROverlayRenderer(context, overlayStore)

    // v0.20.0 — one ARCore Anchor per world-anchored overlay (parity with
    // iOS' ARAnchor) so ARCore refines the pose against drift / re-localization
    // instead of trusting a frozen world coordinate.  GL-thread only (created /
    // read / detached inside [reconcileOverlayAnchors] from onDrawFrame).
    private val overlayAnchors = HashMap<String, Anchor>()
    // The source world point each anchor was created at — used to detect when
    // an overlay's position changed (JS re-set it) and recreate the anchor.
    private val overlayAnchorSrc = HashMap<String, FloatArray>()

    // Scratch matrices for the per-frame overlay camera snapshot — reused
    // each frame so the GL thread does no per-frame allocation when overlays
    // are active.  ARCore returns COLUMN-MAJOR (OpenGL) matrices.
    private val overlayViewMatrix = FloatArray(16)
    private val overlayProjMatrix = FloatArray(16)
    /// Last known display rotation; consulted on each setDisplayGeometry
    /// call so we can recompute when the user rotates the device.
    private var lastDisplayRotation: Int = -1
    private var surfaceWidth: Int = 0
    private var surfaceHeight: Int = 0

    /// Whether to feed the AR session's frames into the incremental
    /// engine.  Toggled by IncrementalStitcher.start/stop
    /// via setIncrementalIngestionActive() below.
    @Volatile private var ingestActive: Boolean = false

    /// Pending takePhoto request, populated by `requestTakePhoto`
    /// from the bridge thread and consumed by the GL render thread
    /// on the next `onDrawFrame` so the latest ARCore frame is
    /// captured.  Cleared atomically so concurrent shutter taps
    /// don't double-fire — the second tap's promise rejects the
    /// older request before replacing it.
    internal data class TakePhotoRequest(
        val outputPath: String,
        val quality: Int,
        // v0.13.2 — physical device orientation at capture time, from the
        // JS `useDeviceOrientation()` hook (one of 'portrait' /
        // 'portrait-upside-down' / 'landscape-left' / 'landscape-right').
        // Used INSTEAD of the window display rotation so AR photos come
        // out upright even under a PORTRAIT-LOCKED host (where the window
        // rotation is always ROTATION_0 regardless of how the device is
        // held — the cause of the "landscape AR photo is sideways" bug).
        val orientation: String,
        val promise: com.facebook.react.bridge.Promise,
    )
    private val pendingTakePhoto =
        AtomicReference<TakePhotoRequest?>(null)

    /// Called from the bridge (RNSARSession.takePhoto @ReactMethod).
    /// Stores a request that will be fulfilled on the next render
    /// tick.  If another request is already queued, that one is
    /// rejected (the JS layer should serialise its own calls).
    internal fun requestTakePhoto(
        outputPath: String,
        quality: Int,
        orientation: String,
        promise: com.facebook.react.bridge.Promise,
    ) {
        val req = TakePhotoRequest(outputPath, quality, orientation, promise)
        val previous = pendingTakePhoto.getAndSet(req)
        previous?.promise?.reject(
            "ar-photo-superseded",
            "takePhoto: superseded by a newer call before the frame was captured.",
        )
        // Wake the render loop in case it's idle.
        glView.requestRender()
    }

    /// Pending crosshair raycast (v0.20.0).  Fulfilled on the next render
    /// tick with the live ARCore frame — `Frame.hitTest` must run on the GL
    /// thread, so a JS `raycast()` call can't resolve synchronously.
    private val pendingRaycast =
        AtomicReference<com.facebook.react.bridge.Promise?>(null)

    /// Called from the bridge (RNSARSession.raycast @ReactMethod).  Stores a
    /// promise fulfilled on the next render tick by hitTest from the screen
    /// centre.  Supersedes any queued raycast.
    internal fun requestRaycast(promise: com.facebook.react.bridge.Promise) {
        val previous = pendingRaycast.getAndSet(promise)
        previous?.resolve(null) // superseded → null (caller falls back)
        glView.requestRender()
    }

    init {
        // Black background avoids a flash before the GL surface starts
        // clearing itself black each frame (the GL-level letterbox draws
        // the bars; this is just belt-and-suspenders for the first frame).
        setBackgroundColor(android.graphics.Color.BLACK)
        addView(
            glView,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
        )
        // 0.20.0 — overlay renderer stacked ABOVE the GLSurfaceView (added
        // after glView so it draws on top).  Full-screen + transparent; it
        // reprojects world overlays into the same letterbox box the camera
        // feed fills, so its coordinate space matches the preview.
        addView(
            overlayRenderer,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
        )
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        Log.i(TAG, "onAttachedToWindow: requesting AR session start (iOS-parity didMoveToWindow)")
        // iOS parity (didMoveToWindow): ensure the singleton AR
        // session is running BEFORE we try to borrow it for
        // rendering.  Previously the view only borrowed an existing
        // session — if nothing else had started one yet, the
        // GLSurfaceView would stay at its cleared-black state
        // forever and the user would see a black camera preview.
        //
        // startForView() is idempotent (no-op if a session is
        // already running) and silently logs failures rather than
        // throwing — if it returns false the view falls through to
        // the borrow logic below, which then renders empty.  Worst-
        // case the user navigates away + back to retry.
        RNSARSession.instance?.startForView()

        glView.onResume()
        // Try to borrow the session from the running RNSARSession.
        val session = RNSARSession.instance?.getSessionForView()
        if (session != null) {
            sessionRef.set(session)
            // ARCore's `Session.resume()` must be called on the main
            // thread — startForView() above already resumed a freshly-
            // created session, but if we got here with a pre-existing
            // paused session (e.g. another ARCameraView's onDetached
            // ran and paused, then this view re-mounted) we resume
            // again here.  Idempotent: Session.resume() is a no-op
            // if the session is already resumed.
            try {
                session.resume()
            } catch (e: CameraNotAvailableException) {
                Log.w(TAG, "session.resume on attach: $e")
            }
            // Read the actual camera image dimensions from the ARCore
            // session config so the GL-level letterbox can size its box.
            // cameraConfig is stable after session creation; on Pixel and
            // some other Android devices the default config is 16:9, not
            // 4:3, so we must read dynamically rather than hard-code.
            try {
                val size = session.cameraConfig.imageSize
                if (size.width > 0 && size.height > 0) {
                    cameraAspect = size.width.toFloat() / size.height.toFloat()
                    Log.i(TAG, "cameraConfig imageSize: ${size.width}×${size.height} → cameraAspect=$cameraAspect")
                    // Invalidate the cached display geometry so the next
                    // onDrawFrame re-pushes it with the now-known camera
                    // aspect.  The GL-level letterbox recomputes the box
                    // every frame — no view resize needed.
                    lastGeomW = -1
                    lastGeomH = -1
                }
            } catch (t: Throwable) {
                Log.w(TAG, "cameraConfig not yet available in onAttach; will use $cameraAspect fallback: ${t.message}")
            }
        } else {
            Log.w(
                TAG,
                "onAttachedToWindow: session is still null after startForView; " +
                    "preview will stay black until the view re-mounts " +
                    "(possible reasons: no Activity, ARCore install in progress, " +
                    "device unsupported — see RNSARSession logs)",
            )
        }
        RNSARSession.instance?.bindCameraView(this)
        IncrementalStitcher.bridgeInstance?.bindArCameraView(this)
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        Log.i(TAG, "onDetachedFromWindow: requesting AR session stop (iOS-parity didMoveToWindow)")
        // Pause the GL thread so we stop drawing frames.
        glView.onPause()
        sessionTextureBound = false
        // 0.20.0 — stop drawing overlays; we drop the camera snapshot so a
        // stale pose isn't reused if the view re-attaches.  The overlay SET
        // itself is left intact (the host may keep the same overlays across
        // a remount); only the per-frame camera state is cleared.
        overlayRenderer.clear()
        IncrementalStitcher.bridgeInstance?.unbindArCameraView(this)
        RNSARSession.instance?.unbindCameraView(this)
        // iOS parity (didMoveToWindow else-branch): stop the session
        // so the hardware camera is freed for vision-camera or other
        // consumers when the user navigates away.  Updated from the
        // previous "do NOT pause the session" comment, which assumed
        // the bridge module's start/stop owned lifecycle exclusively.
        // With startForView()/stopForView(), the view is now the
        // primary lifecycle owner for the auto-mounted case (the
        // most common path: AuditCaptureScreen mounts the view, which
        // starts the session; navigates away, which stops it).
        // The JS-facing `start(promise)` / `stop(promise)` continue
        // to work for hosts that prefer explicit control — the
        // refs/state are shared.
        RNSARSession.instance?.stopForView()
        // 2026-05-23 (crash fix) — drop our local Session reference
        // too.  stopForView() above pause+close'd the session and
        // nulled the singleton's ref, but our own sessionRef still
        // pointed at the closed Session.  If the view ever got
        // re-used (re-attach without recreating), the next
        // session.resume() / forwardToIncremental call would
        // dereference a closed Session → SEGV in libarcore_c.so's
        // internal cleanup, exactly the tombstone we saw.
        sessionRef.set(null)
    }

    /// Called by IncrementalStitcher.start/stop.  When true,
    /// each ARCore frame's camera image is encoded to JPEG + handed
    /// to the engine; when false, the per-frame work skips ingestion
    /// (the camera feed continues to render either way).
    fun setIncrementalIngestionActive(active: Boolean) {
        // P3-G diagnostic — surfaces whether the camera view ever
        // got "engage the ingestion path" command from the stitcher.
        // Common failure mode: stitcher.start() ran, but
        // arCameraViewRef was null (view not bound yet) → this never
        // fires → forwardToIncremental never runs → 0 frames.
        Log.i(TAG, "setIncrementalIngestionActive: $active (prev=$ingestActive)")
        ingestActive = active
    }

    // ── Stitch-phase render throttle ──────────────────────────────────
    //
    // During finalize the GL render thread is pure overhead — the camera
    // feed is visible but no frames are ingested, yet ARCore
    // session.update() + BackgroundRenderer.draw at 30-60 Hz saturate
    // one CPU core and (on low-end SoCs) trigger thermal throttling
    // that multiplicatively slows down the cv::Stitcher worker.
    //
    // pauseRenderingForStitch / resumeRenderingAfterStitch switch the
    // GLSurfaceView to RENDERMODE_WHEN_DIRTY (stops the GL thread's
    // busy-loop) and back.  Called from IncrementalStitcher.finalize()
    // before/after the stitch body.  The camera preview freezes for
    // the stitch duration (~5-40 s) — acceptable because the user is
    // waiting for the result anyway.  iOS parity: the SCNView pauses
    // its scene update loop at the same boundary.
    @Volatile private var renderPausedForStitch: Boolean = false

    fun pauseRenderingForStitch() {
        if (renderPausedForStitch) return
        renderPausedForStitch = true
        Log.i(TAG, "pauseRenderingForStitch: switching to RENDERMODE_WHEN_DIRTY")
        glView.renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
    }

    fun resumeRenderingAfterStitch() {
        if (!renderPausedForStitch) return
        renderPausedForStitch = false
        Log.i(TAG, "resumeRenderingAfterStitch: switching to RENDERMODE_CONTINUOUSLY")
        glView.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
    }

    // ── GL-level letterbox ─────────────────────────────────────────
    //
    // The [glView] stays full-screen (MATCH_PARENT); we letterbox at the
    // GL layer instead of resizing the SurfaceView.  Resizing the view
    // does NOT work for ARCore: its BackgroundRenderer maps the camera
    // texture with `Frame.transformCoordinates2d`, which uses the
    // session's *display geometry* — not the view bounds.  A resized view
    // therefore still rendered the full-screen (centre-cropped) camera,
    // merely clipped to the smaller view → a cropped scene with one
    // visible bar (the other hidden behind the capture controls).
    //
    // The correct fix is pure GL + ARCore geometry, applied per frame:
    //   1. clear the WHOLE surface to black  → the letterbox bars,
    //   2. setDisplayGeometry to the BOX size → ARCore's UV transform
    //      fills the box aspect; when box aspect == camera aspect there
    //      is nothing to crop, so the full FOV shows,
    //   3. glViewport to the centred box      → camera draws only there.

    /** Last display geometry pushed to ARCore; only re-push on change. */
    private var lastGeomW: Int = -1
    private var lastGeomH: Int = -1
    private var lastGeomRotation: Int = -1

    /**
     * The centred letterbox rect [x, y, w, h] inside the full GL surface
     * that preserves the camera's content aspect ratio.  The sensor is
     * landscape (e.g. 640×480, 4:3); in portrait the on-screen content
     * aspect is the inverse, so [cameraAspect] is inverted when the
     * surface is taller than wide.  Falls back to the full surface until
     * the surface has been measured.
     */
    private fun letterboxBox(): IntArray {
        val sw = surfaceWidth
        val sh = surfaceHeight
        if (sw <= 0 || sh <= 0 || cameraAspect <= 0f) return intArrayOf(0, 0, sw, sh)
        val contentAspect = if (sh > sw) 1f / cameraAspect else cameraAspect
        val surfaceAspect = sw.toFloat() / sh.toFloat()
        return if (surfaceAspect > contentAspect) {
            // Surface wider than content — vertical bars left/right.
            val w = (sh * contentAspect).toInt()
            intArrayOf((sw - w) / 2, 0, w, sh)
        } else {
            // Surface taller than content — horizontal bars top/bottom.
            val h = (sw / contentAspect).toInt()
            intArrayOf(0, (sh - h) / 2, sw, h)
        }
    }

    // ── GLSurfaceView.Renderer ─────────────────────────────────────

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        backgroundRenderer.createOnGlThread()
        sessionTextureBound = false
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        surfaceWidth = width
        surfaceHeight = height
        applyDisplayGeometry()
    }

    override fun onDrawFrame(gl: GL10?) {
        // Step 1 — paint the WHOLE surface black.  This is the letterbox:
        // anything outside the camera box below stays black.
        GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)

        val session = sessionRef.get() ?: run {
            // Session not yet attached (start() hasn't run, or
            // the bridge module instance was rebuilt).  Try once
            // more in case the bridge resolved it after onAttach.
            val late = RNSARSession.instance?.getSessionForView()
            if (late != null) sessionRef.set(late)
            return
        }
        if (!sessionTextureBound) {
            backgroundRenderer.bindToSession(session)
            sessionTextureBound = true
        }

        // Step 2 — keep ARCore's display geometry equal to the letterbox
        // box (not the full surface) so its UV transform fills the box
        // aspect with the full camera FOV (no centre-crop).  Cheap: only
        // calls setDisplayGeometry when the box actually changes.
        applyDisplayGeometry()

        val frame = try {
            session.update()
        } catch (e: SessionPausedException) {
            return  // session paused — wait for resume
        } catch (t: Throwable) {
            Log.w(TAG, "session.update failed: ${t.message}")
            return
        }

        // Step 3 — confine the camera draw to the centred box; the black
        // cleared in step 1 remains as the bars around it.
        val box = letterboxBox()
        GLES20.glViewport(box[0], box[1], box[2], box[3])

        // Draw the camera background regardless of tracking state —
        // gives the user something to look at while AR initialises.
        backgroundRenderer.draw(frame)

        val camera: Camera = frame.camera

        // ── V15.0e — vertical plane detection (iOS parity) ──────────
        // Run this each frame so the JS 2 Hz getARPlaneStatus poll
        // sees a live answer without the user having to take any
        // action.  iOS ARKit re-runs evaluation internally on each
        // ARSessionDelegate didUpdate callback; we mirror by polling
        // every ARCore frame.  Cost: ~10-20 us per frame at idle (no
        // planes), ~50-100 us when iterating a handful of tracking
        // planes — negligible against the 16ms frame budget.
        val pose = camera.pose
        // ARCore Pose convention: zAxis is the world-space direction
        // of the local Z axis.  Camera looks down -Z (OpenGL
        // convention), so cameraForward = -zAxis.  ARCore 1.45's
        // Pose.getZAxis() takes no args and returns a new FloatArray.
        val zAxis = pose.zAxis
        val cameraForwardWorld = floatArrayOf(-zAxis[0], -zAxis[1], -zAxis[2])
        val cameraPosWorld = floatArrayOf(pose.tx(), pose.ty(), pose.tz())
        RNSARSession.instance?.evaluatePlanesForFrame(
            cameraForwardWorld,
            cameraPosWorld,
        )

        // v0.8.0 Phase 4b.iii — ensure the host-worklet runtime is
        // installed before any per-frame fan-out can run.  Idempotent
        // (AtomicBoolean CAS): the first frame starts the dispatch
        // thread; every later frame is a single atomic read.  Kept on
        // the GL thread because that's the only thread guaranteed to
        // run once the AR session is live.
        StitcherWorkletRuntime.installIfNeeded()

        // Push pose into the AR session log.  Mirrors iOS' delegate
        // path; the existing RNSARFramePose / appendPose
        // contract was already in place for Phase 4.
        appendPose(camera, frame.timestamp)

        // ── 0.20.0 — feed the overlay renderer this frame's camera ───────
        //
        // Only when overlays exist (cheap AtomicReference emptiness check),
        // snapshot the view + projection matrices and the letterbox box so
        // the overlay View can reproject world points → screen and redraw.
        // Runs every render frame so overlays track at display rate.
        //
        // First reconcile ARCore anchors + publish their drift-corrected poses
        // so the renderer projects the refined positions, not frozen coords.
        reconcileOverlayAnchors(session)
        maybeUpdateOverlayCamera(camera, box)

        // Forward to the incremental stitcher when capture is engaged,
        // OR when an AR frame-processor host worklet is registered (the
        // v0.8.0 Phase 4b.iii fan-out forwards preview frames whenever
        // host worklets exist, even with capture off — the host worklet
        // observes the live AR stream), OR when a native AR plugin is
        // registered (0.19.0 — `forwardToIncremental` builds the
        // ARFrameContext + runs the plugins; their SYNC results are stashed
        // for the onArFrame meta below).  `forwardToIncremental` does the
        // NV21 pack once and gates the first-party ingest internally on
        // `ingestActive`; the host-worklet dispatch is gated on the native
        // worklet registry count; the plugin invocation on the plugin
        // registry.  All three checks are cheap atomic reads so the common
        // idle preview path (no capture, no worklet, no plugin) stays
        // near-free.
        //
        // ORDER (0.19.0): run forwardToIncremental BEFORE maybeEmitArFrameMeta
        // so the native-plugin SYNC results computed in the former are
        // available to fold into the onArFrame `plugins` field built in the
        // latter (same render frame).
        if (ingestActive ||
            StitcherWorkletRuntime.hasHostWorklets() ||
            !RNSARPluginRegistry.isEmpty()
        ) {
            forwardToIncremental(frame, camera)
        } else {
            // No consumer this frame — make sure last frame's stashed plugin
            // sync results don't leak into a later onArFrame meta.
            lastPluginSyncResults = null
        }

        // onArFrame (v0.18.0) — LIGHT AR-metadata event channel.  Built
        // + emitted INDEPENDENTLY of the stitcher ingest / host-worklet
        // fan-out above: a host that only wants per-frame AR metadata
        // (no capture, no worklet) still gets it.  Gated + throttled
        // internally; near-free (one volatile read + one nanoTime
        // compare) when disabled or inside the throttle window.  Native-
        // plugin SYNC results (0.19.0) stashed by forwardToIncremental
        // above ride along under the meta's `plugins` field.
        maybeEmitArFrameMeta(frame, camera)

        // takePhoto consumer — runs on EVERY render tick (not just
        // when ingest is active), since the host calls takePhoto in
        // photo mode where ingest is off.  No-op when no request is
        // pending; cheap atomic CAS on the hot path.
        pendingTakePhoto.getAndSet(null)?.let { req ->
            fulfilTakePhoto(frame, req)
        }

        // raycast consumer (v0.20.0) — same pattern: a JS raycast() request
        // is fulfilled here with the live frame's hitTest from the crosshair.
        pendingRaycast.getAndSet(null)?.let { promise ->
            fulfilRaycast(frame, camera, promise)
        }
    }

    /// Raycast from the screen-centre crosshair to the nearest real-world
    /// surface; resolve `{ worldPosition: [x,y,z] }` (or null when nothing is
    /// hit / not tracking).  Runs on the GL render thread from onDrawFrame.
    /// hitTest coordinates are in the `setDisplayGeometry` space — which we
    /// feed the LETTERBOX BOX — so the crosshair is the box centre.  Mirrors
    /// iOS `RNSARSession.raycast`; the JS controller falls back to a fixed
    /// 1 m-ahead point when this resolves null.
    private fun fulfilRaycast(
        frame: com.google.ar.core.Frame,
        camera: Camera,
        promise: com.facebook.react.bridge.Promise,
    ) {
        try {
            if (camera.trackingState != TrackingState.TRACKING) {
                promise.resolve(null)
                return
            }
            val box = letterboxBox()
            val cx = box[2] / 2f // box width  / 2
            val cy = box[3] / 2f // box height / 2
            val hits = frame.hitTest(cx, cy)
            // hits are sorted near→far.  Prefer a plane hit inside the
            // detected polygon, then a depth / feature point, then any hit.
            val hit = hits.firstOrNull { h ->
                when (val t = h.trackable) {
                    is com.google.ar.core.Plane ->
                        t.trackingState == TrackingState.TRACKING &&
                            t.isPoseInPolygon(h.hitPose)
                    is com.google.ar.core.DepthPoint -> true
                    is com.google.ar.core.Point -> true
                    else -> false
                }
            } ?: hits.firstOrNull()
            if (hit == null) {
                promise.resolve(null)
                return
            }
            val p = hit.hitPose
            val wp = com.facebook.react.bridge.Arguments.createArray().apply {
                pushDouble(p.tx().toDouble())
                pushDouble(p.ty().toDouble())
                pushDouble(p.tz().toDouble())
            }
            val result = com.facebook.react.bridge.Arguments.createMap().apply {
                putArray("worldPosition", wp)
            }
            promise.resolve(result)
        } catch (t: Throwable) {
            Log.w(TAG, "raycast failed: ${t.message}")
            promise.resolve(null)
        }
    }

    /// Capture the current ARCore frame to JPEG and resolve / reject
    /// `req.promise`.  Runs on the GL render thread, called from
    /// `onDrawFrame` after the frame has been obtained via
    /// `session.update()`.  Mirrors iOS' `RNSARSession.takePhoto`
    /// resolution shape: `{ path, width, height, isMirrored,
    /// isRawPhoto }` so JS code is platform-agnostic.
    private fun fulfilTakePhoto(
        frame: com.google.ar.core.Frame,
        req: TakePhotoRequest,
    ) {
        val image = try {
            frame.acquireCameraImage()
        } catch (t: Throwable) {
            req.promise.reject(
                "ar-photo-no-frame",
                "takePhoto: acquireCameraImage failed: ${t.message}",
            )
            return
        }
        val width = image.width
        val height = image.height
        try {
            val written = YuvImageConverter.encodeToJpeg(
                image,
                req.outputPath,
                jpegQuality = req.quality.coerceIn(1, 100),
                // v0.13.2 — derive the encode rotation from the PHYSICAL
                // device orientation (JS gyro), not the window display
                // rotation.  Under a portrait-locked host the window stays
                // ROTATION_0 regardless of how the device is held, so the
                // old `lastDisplayRotation` path baked a portrait EXIF tag
                // onto landscape captures → sideways photo.  The
                // device-orientation → Surface.ROTATION_* mapping below
                // feeds encodeToJpeg's existing EXIF table.
                displayRotation = deviceOrientationToSurfaceRotation(req.orientation),
            )
            if (written == null) {
                req.promise.reject(
                    "ar-photo-encode-failed",
                    "takePhoto: YuvImageConverter.encodeToJpeg returned null.",
                )
                return
            }
            val result = com.facebook.react.bridge.Arguments.createMap().apply {
                putString("path", written)
                putInt("width", width)
                putInt("height", height)
                putBoolean("isMirrored", false)
                putBoolean("isRawPhoto", false)
            }
            req.promise.resolve(result)
        } catch (t: Throwable) {
            req.promise.reject(
                "ar-photo-failed",
                "takePhoto: unexpected error: ${t.message}",
                t,
            )
        } finally {
            // Image must always be closed or ARCore will starve.
            try { image.close() } catch (_: Throwable) {}
        }
    }

    private fun appendPose(camera: Camera, timestampNs: Long) {
        val pose = camera.pose
        val translation = pose.translation
        val rotation = pose.rotationQuaternion  // x, y, z, w
        val intrinsics = camera.imageIntrinsics
        val focal = intrinsics.focalLength
        val principal = intrinsics.principalPoint
        val dims = intrinsics.imageDimensions

        val tracking = when (camera.trackingState) {
            TrackingState.TRACKING -> RNSARSession.TRACKING_TRACKING
            TrackingState.PAUSED   -> RNSARSession.TRACKING_LIMITED
            TrackingState.STOPPED  -> RNSARSession.TRACKING_NOT_AVAILABLE
            else -> RNSARSession.TRACKING_NOT_AVAILABLE
        }

        val framePose = RNSARFramePose(
            tx = translation[0].toDouble(),
            ty = translation[1].toDouble(),
            tz = translation[2].toDouble(),
            qx = rotation[0].toDouble(),
            qy = rotation[1].toDouble(),
            qz = rotation[2].toDouble(),
            qw = rotation[3].toDouble(),
            fx = focal[0].toDouble(),
            fy = focal[1].toDouble(),
            cx = principal[0].toDouble(),
            cy = principal[1].toDouble(),
            imageWidth = dims[0],
            imageHeight = dims[1],
            timestampMs = timestampNs / 1_000_000.0,
            trackingState = tracking,
        )
        RNSARSession.instance?.appendPose(framePose)
        RNSARSession.instance?.updateTrackingState(camera.trackingState)
    }

    /// v0.20.0 — keep one ARCore Anchor per world-anchored overlay so ARCore
    /// refines its pose against drift / re-localization (parity with iOS'
    /// ARAnchor).  Runs on the GL thread each frame: create anchors for new
    /// overlays, recreate when an overlay's source pose changes, detach removed
    /// ones, then publish the live anchor positions to the renderer (which uses
    /// them instead of the frozen world coordinates).  Cheap no-op when there
    /// are neither overlays nor lingering anchors.
    private fun reconcileOverlayAnchors(session: Session) {
        if (overlayStore.isEmpty() && overlayAnchors.isEmpty()) return

        val overlays = overlayStore.snapshot()
        val live = HashSet<String>(overlays.size)
        val positions = HashMap<String, FloatArray>(overlays.size)

        for (o in overlays) {
            val target = anchorTarget(o) ?: continue
            live.add(o.id)
            val prev = overlayAnchorSrc[o.id]
            if (prev == null || !prev.contentEquals(target)) {
                // New overlay, or its position changed → (re)create the anchor.
                overlayAnchors.remove(o.id)?.detach()
                val anchor = try {
                    session.createAnchor(
                        Pose(target, floatArrayOf(0f, 0f, 0f, 1f)),
                    )
                } catch (t: Throwable) {
                    Log.w(TAG, "createAnchor failed for '${o.id}': ${t.message}")
                    null
                }
                if (anchor != null) {
                    overlayAnchors[o.id] = anchor
                    overlayAnchorSrc[o.id] = target.copyOf()
                } else {
                    overlayAnchorSrc.remove(o.id)
                }
            }
            // Publish the live (tracking) anchor pose, else the source pose.
            val a = overlayAnchors[o.id]
            positions[o.id] = if (a != null && a.trackingState == TrackingState.TRACKING) {
                val p = a.pose
                floatArrayOf(p.tx(), p.ty(), p.tz())
            } else {
                overlayAnchorSrc[o.id] ?: target
            }
        }

        // Detach anchors for overlays that no longer exist.
        if (overlayAnchors.keys.any { it !in live }) {
            for (id in overlayAnchors.keys.filter { it !in live }) {
                overlayAnchors.remove(id)?.detach()
                overlayAnchorSrc.remove(id)
            }
        }

        overlayRenderer.setAnchorPositions(positions)
    }

    /// The world point to anchor an overlay at: its `worldPosition`, or the
    /// centroid of its `worldQuad`.  null when it has no world geometry.
    private fun anchorTarget(o: AROverlayData): FloatArray? {
        o.worldPosition?.let { return it }
        val q = o.worldQuad ?: return null
        if (q.isEmpty()) return null
        var cx = 0f; var cy = 0f; var cz = 0f
        for (v in q) { cx += v[0]; cy += v[1]; cz += v[2] }
        val n = q.size.toFloat()
        return floatArrayOf(cx / n, cy / n, cz / n)
    }

    // ── 0.20.0 — per-frame overlay camera snapshot + JS imperative API ──

    /**
     * Snapshot this frame's camera view + projection matrices and the
     * letterbox box into the [overlayRenderer], then trigger a redraw.
     *
     * Cheap no-op when no overlays are set (single AtomicReference
     * emptiness check) so the common no-overlay preview path pays almost
     * nothing.  ARCore's `getViewMatrix` / `getProjectionMatrix` are
     * COLUMN-MAJOR (OpenGL) — exactly what `android.opengl.Matrix` and the
     * renderer expect.  The near/far planes (0.05 m / 100 m) bound depth
     * precision; they don't affect XY projection.
     *
     * @param camera the ARCore camera for this frame (pose + intrinsics).
     * @param glBox  the letterbox box [x, y, w, h] in GL pixel space
     *               (origin BOTTOM-left, as used by `glViewport`).  We flip
     *               Y to the overlay View's TOP-left origin here.
     */
    private fun maybeUpdateOverlayCamera(camera: Camera, glBox: IntArray) {
        if (overlayStore.isEmpty()) return

        // ARCore projection matrix: near=0.05 m, far=100 m (matches the
        // BackgroundRenderer's typical range; depth bounds only).
        try {
            camera.getViewMatrix(overlayViewMatrix, 0)
            camera.getProjectionMatrix(overlayProjMatrix, 0, 0.05f, 100f)
        } catch (t: Throwable) {
            // Camera not ready (early frames) — skip this frame's overlay
            // update; the feed keeps drawing and we retry next frame.
            return
        }

        // GL viewport box → overlay View box.  GL origin is bottom-left;
        // the View is top-left.  Both share surfaceWidth × surfaceHeight.
        val boxX = glBox[0].toFloat()
        val boxW = glBox[2].toFloat()
        val boxH = glBox[3].toFloat()
        val boxYTop = (surfaceHeight - (glBox[1] + glBox[3])).toFloat()

        val tracking = camera.trackingState == TrackingState.TRACKING

        overlayRenderer.updateCamera(
            viewMatrix = overlayViewMatrix,
            projectionMatrix = overlayProjMatrix,
            boxX = boxX,
            boxY = boxYTop,
            boxW = boxW,
            boxH = boxH,
            tracking = tracking,
        )
    }

    // ── JS imperative overlay API (forwarded from RNSARSession) ──────────
    //
    // The JS `ARCameraViewHandle` / `<Camera>` ref methods (setOverlays /
    // addOverlay / updateOverlay / removeOverlay / clearOverlays) route
    // through the singleton `RNSARSession` native module — the SAME idiom
    // takePhoto uses — which forwards to the bound view's [overlayStore]
    // (JS namespace).  These run on the bridge thread; the store's
    // AtomicReferences make that safe against the GL thread's per-frame
    // read.  An overlay set change triggers an immediate redraw so the
    // overlay appears without waiting for the next AR frame's snapshot.

    internal fun setOverlaysFromJs(overlays: List<AROverlayData>) {
        overlayStore.setJsOverlays(overlays)
        overlayRenderer.postInvalidateOnAnimation()
    }

    internal fun addOverlayFromJs(overlay: AROverlayData) {
        overlayStore.addJsOverlay(overlay)
        overlayRenderer.postInvalidateOnAnimation()
    }

    internal fun updateOverlayFromJs(id: String, patch: com.facebook.react.bridge.ReadableMap) {
        overlayStore.updateJsOverlay(id, patch)
        overlayRenderer.postInvalidateOnAnimation()
    }

    internal fun removeOverlayFromJs(id: String) {
        overlayStore.removeJsOverlay(id)
        overlayRenderer.postInvalidateOnAnimation()
    }

    internal fun clearOverlaysFromJs() {
        overlayStore.clearJsOverlays()
        overlayRenderer.postInvalidateOnAnimation()
    }

    /// P3-G diagnostic — rate-limit the per-frame log so we can see
    /// at-a-glance whether forwardToIncremental is even running, vs
    /// being short-circuited at the `if (ingestActive)` guard in
    /// onDrawFrame.
    private var forwardLogTick: Int = 0

    private fun forwardToIncremental(
        frame: com.google.ar.core.Frame,
        camera: Camera,
    ) {
        if (forwardLogTick++ % 30 == 0) {
            Log.i(TAG, "forwardToIncremental: ingestActive=$ingestActive trackingState=${camera.trackingState}")
        }
        // Acquire the camera image.  Each call may throw
        // NotYetAvailableException for the first ~1-2 frames before
        // ARCore catches up — silently skip those.
        val image = try {
            frame.acquireCameraImage()
        } catch (t: Throwable) {
            if (forwardLogTick % 30 == 1) {
                Log.w(TAG, "forwardToIncremental: acquireCameraImage failed: ${t.message}")
            }
            return
        }

        // 2026-05-22 (audit follow-up #19) — minimise ARCore Image
        // hold time.
        //
        // Pre-#19 the Image stayed open through the entire JNI
        // ingest call AND any subsequent JPEG encode (~25 ms in
        // legacy hybrid mode where every frame is encoded eagerly;
        // ~25 ms in batch-keyframe mode for the ~5/60 frames the
        // gate accepts).  At 60 Hz ARCore that meant the Image was
        // held 25-30 ms per frame on accepts, starving the Camera2
        // ImageReader's circular buffer pool and risking
        // "BufferQueue has been abandoned" stalls.
        //
        // The fix is mechanical: pack the YUV planes into a
        // JVM-side NV21 byte array (~3 ms), close the Image, and
        // run all subsequent work (JNI ingest + JPEG encode) on
        // the copied bytes.  ARCore Camera2 buffer pool stays
        // healthier; latency-sensitive ARCore frames flow through
        // their fixed pool instead of waiting on our JPEG path.
        //
        // The packed.nv21 array's first `width*height` bytes are
        // the Y plane (densely packed, stride = width) — these go
        // to the C++ gate as grayscale.  The full array is the
        // input to YuvImageConverter.encodeJpegFromNV21 if the
        // gate accepts (or if we're in legacy eager-encode mode).
        val packed = try {
            YuvImageConverter.packNV21(image)
        } finally {
            // Close ASAP — every microsecond reduces buffer-pool
            // pressure on Camera2.  Even if packNV21 returns null
            // (unsupported format), we still need to close.
            try { image.close() } catch (_: Throwable) {}
        } ?: run {
            if (forwardLogTick % 30 == 1) {
                Log.w(TAG, "forwardToIncremental: packNV21 returned null (unexpected format?)")
            }
            return
        }

        // Compute yaw + pitch from the ARCore quaternion using
        // the same convention the iOS Swift side uses (camera-
        // forward in world space).  This keeps the two platforms
        // numerically aligned for the FoV-overlap gate.  `camera`
        // (and `camera.pose`) remain valid after image.close() —
        // they're ARCore Frame metadata, not pixel buffers.
        val q = camera.pose.rotationQuaternion  // x, y, z, w
        val (yaw, pitch) = quaternionYawPitch(q)

        // Both FoVs + the full quaternion + intrinsics go to the
        // engine.  V6 pose-driven path uses (qx, qy, qz, qw, fx,
        // fy, cx, cy, w, h) to compute the geometrically-exact
        // homography.
        val intrinsics = camera.imageIntrinsics
        val fx = intrinsics.focalLength[0].toDouble()
        val fy = intrinsics.focalLength[1].toDouble()
        val cxIntr = intrinsics.principalPoint[0].toDouble()
        val cyIntr = intrinsics.principalPoint[1].toDouble()
        val w = intrinsics.imageDimensions[0].toDouble()
        val h = intrinsics.imageDimensions[1].toDouble()
        val fovHRad = 2.0 * atan(w / (2.0 * fx))
        val fovVRad = 2.0 * atan(h / (2.0 * fy))
        val fovHDeg = fovHRad * 180.0 / Math.PI
        val fovVDeg = fovVRad * 180.0 / Math.PI

        // ARCore quaternion comes back in (x, y, z, w) order.
        val qarr = camera.pose.rotationQuaternion
        // P3-F: also extract translation so the KeyframeGate's
        // plane-based ray-projection can compute polygon overlap.
        // Previously these were dropped, forcing the gate into
        // angular-fallback even when a plane was latched.
        val tArr = camera.pose.translation

        val trackingPoor = camera.trackingState != TrackingState.TRACKING
        val module = IncrementalStitcher.bridgeInstance ?: return
        // 2026-05-15 (B3) — pass current display rotation so the
        // encoded JPEG gets an EXIF orientation tag.  Captured into
        // a local val so the lambda below closes over a primitive
        // (avoids re-reading lastDisplayRotation if it shifts
        // between gate-evaluate and lambda invocation).
        val rotationForEncode = if (lastDisplayRotation >= 0)
            lastDisplayRotation else android.view.Surface.ROTATION_0

        // Batch-keyframe ingest.  The gate reads the Y plane of the packed
        // NV21 synchronously (grayData) and the lazy onAccept JPEG-encodes only
        // accepted frames — no eager encode, no live-engine pixel-data path
        // (the live engines + the TransferredNV21 ownership wrapper were removed
        // in the 2026-06 cleanup; see audit #8).  Runs inline so the gate read
        // completes before ARCore recycles the Image.  Only ingest when the host
        // has actively engaged capture (`setIncrementalIngestionActive(true)`).
        if (ingestActive) {
        module.ingestFromARCameraView(
            tx = tArr[0].toDouble(),
            ty = tArr[1].toDouble(),
            tz = tArr[2].toDouble(),
            qx = qarr[0].toDouble(), qy = qarr[1].toDouble(),
            qz = qarr[2].toDouble(), qw = qarr[3].toDouble(),
            fx = fx, fy = fy, cx = cxIntr, cy = cyIntr,
            imageWidth = intrinsics.imageDimensions[0],
            imageHeight = intrinsics.imageDimensions[1],
            yaw = yaw, pitch = pitch,
            fovHorizDegrees = fovHDeg, fovVertDegrees = fovVDeg,
            trackingPoor = trackingPoor,
            // The Y plane lives at packed.nv21[0 .. width*height).
            // C++ keyframe_gate reads `height * stride` bytes and
            // ignores anything past that, so passing the full NV21
            // array with `grayStride = width` reads exactly the Y
            // plane (UV bytes at the tail are not touched).
            grayData = packed.nv21,
            grayWidth = packed.width,
            grayHeight = packed.height,
            grayStride = packed.width,
            onAccept = { targetPath ->
                // Lazy JPEG encode.  Runs ONLY if the C++ KeyframeGate
                // accepted the frame.  Encodes from the pre-packed
                // NV21 bytes — the ARCore Image has been closed since
                // ~25 ms ago (right after packNV21), so no
                // Image-hold cost on this slow path.
                //
                // v0.21.1 (review C) — try/catch mirrors the plugin
                // path's onAccept: an encoder throw (EXIF write, disk
                // full, degenerate dims) must report "not persisted"
                // (false) instead of killing the ARCore frame-listener
                // thread.
                try {
                    YuvImageConverter.encodeJpegFromNV21(
                        packed,
                        targetPath,
                        jpegQuality = 70,
                        displayRotation = rotationForEncode,
                    ) != null
                } catch (t: Throwable) {
                    Log.w(TAG, "forwardToIncremental: JPEG encode failed " +
                        "for $targetPath: ${t.javaClass.simpleName}: ${t.message}")
                    false
                }
            },
            retainFrame = {
                // v0.21.1 (review C) — RAM retention for the sharpness
                // window: `packed` is this frame's own JVM array (the
                // ARCore Image is already closed), so retaining it is
                // a reference grab — no copy, no disk write.  Encode
                // params mirror onAccept above so the commit-time
                // encode is byte-identical to an immediate save.
                SharpnessCandidateFrame(
                    packed = packed,
                    displayRotation = rotationForEncode,
                    jpegQuality = 70,
                )
            },
        )
        }  // closes `if (ingestActive)` (v0.8.0 Phase 4b.iii)

        // ── v0.8.0 Phase 4b.iii — AR frame-processor host-worklet fan-out ──
        //
        // After the first-party stitching ingest (above), fan the SAME
        // already-packed NV21 frame + pose out to every host worklet the
        // JS `arFrameProcessor` registered via `__stitcherProxy.install`.
        // This is independent of `ingestActive`: a host worklet observes
        // the live AR stream whether or not the user has engaged capture
        // (the onDrawFrame gate already let us in when host worklets
        // exist).  `dispatchToHostWorklets` does a cheap native
        // registry-count fast-path early-exit + (only when worklets are
        // registered) copies the bytes into an owned native buffer and
        // dispatches asynchronously on worklets-core's default context,
        // so the GL render thread is NOT blocked on worklet execution.
        //
        // We reuse `packed.nv21` (full NV21: Y plane then interleaved
        // VU) + `qarr` / `tArr` (already read above) — no extra Image
        // hold, no second pack.  ARCore camera pose is full 6DoF, so
        // translation is always valid.
        val arTracking = when (camera.trackingState) {
            TrackingState.TRACKING -> "normal"
            TrackingState.PAUSED -> "limited"
            TrackingState.STOPPED -> "notAvailable"
            else -> "notAvailable"
        }

        // ── Opt-in AR-metadata extraction gate ──────────────────────────
        //
        // depth/anchors/mesh are all OFF by default (the JS-driven
        // enableDepth/enableAnchors/enableMesh `<Camera>` props, read via
        // the shared `retailens::getExtractionConfig()` snapshot).  Skip
        // the costly ARCore depth-acquire / anchor-collect / mesh-build
        // work for every toggle a host hasn't opted into.  A mesh anchor
        // is reconstructed FROM the depth map, so mesh implies acquiring
        // depth even when `depth` (the raw arDepth emission) is off.
        val flags = StitcherWorkletRuntime.extractionFlags()

        // ── AR depth (ARCore Depth API, DEPTH16) ────────────────────────
        //
        // Acquire the 16-bit depth image for this frame and ROW-PACK it
        // into a contiguous w*h*2 byte array (uint16/pixel, low 13 bits =
        // millimetres, high 3 bits = confidence 0..7).  The shared JSI
        // layer (`cpp/camera_frame_jsi.cpp`) unpacks mm->metres and
        // confidence 0..7 -> 0..2, so we emit the RAW packed bytes with
        // format "u16packed" and leave the confidence array empty.
        //
        // ARCore's plane[0].rowStride may EXCEED w*2 (alignment padding);
        // we copy exactly w*2 bytes per row so the JS-side reader sees a
        // dense, no-padding buffer.  Older devices / un-supported sessions
        // throw NotYetAvailableException (or depth disabled) — caught and
        // treated as "no depth this frame" (null).  `use {}` closes the
        // ARCore Image deterministically in all paths.
        //
        // Acquired when EITHER depth (raw emission) OR mesh
        // (reconstruction) is requested.
        val depth: ArDepthData? =
            if (flags.depth || flags.mesh) acquireDepth16Packed(frame) else null

        // ── AR anchors ──────────────────────────────────────────────────
        //
        // Emit every TRACKING anchor as { id, type, transform(row-major) }.
        // The app does NOT call session.createAnchor() anywhere today, so
        // getAllAnchors() is empty in practice — an empty list is the
        // CORRECT contract for "AR frame, no anchors" (the JSI layer still
        // returns a [] for source=="ar").  The extraction below is fully
        // wired so it lights up automatically if anchor creation lands.
        // Gated on the anchors toggle.
        val anchors: List<ArAnchorData> =
            if (flags.anchors)
                sessionRef.get()?.let { collectTrackingAnchors(it) } ?: emptyList()
            else emptyList()

        // ── AR scene mesh (reconstructed from the depth map) ─────────────
        //
        // ARCore has no native scene mesh (unlike ARKit's ARMeshAnchor), so
        // when `mesh` is requested we unproject the DEPTH16 map into a
        // camera-local point grid and triangulate it.  Emitted as ONE extra
        // anchor (type="mesh", id="mesh-depth", identity transform — the
        // vertices are camera-local, NOT world).  Built only when mesh is
        // on AND a depth map was available this frame.
        val meshAnchor: ArAnchorData? =
            if (flags.mesh && depth != null) buildDepthMesh(depth, intrinsics)
            else null

        // Combine real anchors + the optional depth mesh into the parallel
        // marshal arrays.  meshVertices/meshFaces are null for every
        // non-mesh anchor; the mesh anchor carries its Float32/Uint32 byte
        // buffers (the JNI sets ArAnchor.hasMesh from them).
        val allAnchors: List<ArAnchorData> =
            if (meshAnchor != null) anchors + meshAnchor else anchors
        val anchorIds = Array(allAnchors.size) { allAnchors[it].id }
        val anchorTypes = Array(allAnchors.size) { allAnchors[it].type }
        val anchorTransforms = Array(allAnchors.size) { allAnchors[it].transform }
        val anchorMeshVertices =
            Array<ByteArray?>(allAnchors.size) { allAnchors[it].meshVertices }
        val anchorMeshFaces =
            Array<ByteArray?>(allAnchors.size) { allAnchors[it].meshFaces }
        // Per-anchor plane alignment ("" for image/mesh) + extent
        // ([extentX, extentZ] metres, null for non-plane anchors).
        val anchorAlignments = Array(allAnchors.size) { allAnchors[it].alignment }
        val anchorExtents = Array<DoubleArray?>(allAnchors.size) { allAnchors[it].extent }

        StitcherWorkletRuntime.dispatchToHostWorklets(
            nv21Bytes = packed.nv21,
            width = packed.width,
            height = packed.height,
            qx = qarr[0].toDouble(), qy = qarr[1].toDouble(),
            qz = qarr[2].toDouble(), qw = qarr[3].toDouble(),
            tx = tArr[0].toDouble(), ty = tArr[1].toDouble(),
            tz = tArr[2].toDouble(),
            timestampNs = frame.timestamp.toDouble(),
            trackingState = arTracking,
            // Emit raw arDepth ONLY when depth was explicitly requested —
            // a mesh-only host gets the mesh anchor but no arDepth buffer.
            depthBytes = if (flags.depth) depth?.bytes else null,
            depthWidth = if (flags.depth) depth?.width ?: 0 else 0,
            depthHeight = if (flags.depth) depth?.height ?: 0 else 0,
            anchorIds = anchorIds,
            anchorTypes = anchorTypes,
            anchorTransforms = anchorTransforms,
            anchorMeshVertices = anchorMeshVertices,
            anchorMeshFaces = anchorMeshFaces,
            // Per-frame camera intrinsics (fx,fy,cx,cy in pixels at the
            // capture resolution).  `intrinsics` = camera.imageIntrinsics,
            // already in scope above (declared at the top of this fn).
            fx = intrinsics.focalLength[0].toDouble(),
            fy = intrinsics.focalLength[1].toDouble(),
            cx = intrinsics.principalPoint[0].toDouble(),
            cy = intrinsics.principalPoint[1].toDouble(),
            intrinsicsImageWidth = intrinsics.imageDimensions[0],
            intrinsicsImageHeight = intrinsics.imageDimensions[1],
            anchorAlignments = anchorAlignments,
            anchorExtents = anchorExtents,
        )

        // ── 0.19.0 — native AR-plugin per-frame invocation ───────────────
        //
        // Mirror of iOS' RNSARSession.session(_:didUpdate:) plugin loop.
        // Only build the ARFrameContext + call plugins when the registry is
        // NON-EMPTY (the onDrawFrame gate already let us in via that check,
        // but a worklet-only frame can reach here with an empty plugin
        // registry — re-check so those frames pay nothing).  Runs on the AR
        // (GL render) thread, synchronously.  Reuses the already-packed
        // `packed.nv21`, the depth/anchors collected above, and the pose +
        // intrinsics already read — no extra Image acquire, no second pack.
        // Depth is passed ONLY when the host opted into enableDepth (a
        // mesh-only host acquired depth for its mesh, but the contract says
        // the context's depth is null unless enableDepth).
        runArPlugins(
            packed, qarr, tArr, arTracking, frame, intrinsics, anchors,
            depth = if (flags.depth) depth else null,
        )
    }

    /// 0.19.0 — last frame's native-plugin SYNC results, keyed by plugin
    /// name.  Written by [runArPlugins] on the GL render thread, read by
    /// [maybeEmitArFrameMeta] on the same thread one step later in the same
    /// onDrawFrame tick.  Null = no plugins ran / no sync results this
    /// frame.  Single-threaded handoff (both on the GL thread) so no
    /// synchronisation is needed, but @Volatile is cheap insurance against
    /// any future cross-thread read.
    @Volatile
    private var lastPluginSyncResults: Map<String, Any?>? = null

    /**
     * 0.19.0 — build one [ARFrameContext] from the current frame and invoke
     * every registered [ARFramePlugin].
     *
     *  - Non-null SYNC results are collected into a `{ name -> result }` map
     *    and stashed in [lastPluginSyncResults] for [maybeEmitArFrameMeta]
     *    to fold into the onArFrame `plugins` field this same tick.
     *  - A plugin returning `null` defers to the ASYNC channel
     *    ([RNSARPluginRegistry.emit] → `RNImageStitcherARPluginResult`).
     *
     * A throwing plugin is isolated (logged, skipped) so one bad plugin
     * can't take down the AR render loop.
     *
     * Reuses caller-collected data (no extra Image work):
     * @param packed     the already-packed NV21 camera image.
     * @param qarr       pose rotation quaternion [x,y,z,w].
     * @param tArr       pose translation [x,y,z] (world metres).
     * @param tracking   contract tracking string ("normal"|"limited"|"notAvailable").
     * @param frame      the ARCore frame (for the timestamp).
     * @param intrinsics camera intrinsics (fx,fy,cx,cy + image dims).
     * @param anchors    anchor descriptors already collected for onArFrame
     *                   (enableAnchors-gated; empty otherwise).
     * @param depth      row-packed DEPTH16 or null (enableDepth-gated).
     */
    private fun runArPlugins(
        packed: YuvImageConverter.PackedYuv,
        qarr: FloatArray,
        tArr: FloatArray,
        tracking: String,
        frame: com.google.ar.core.Frame,
        intrinsics: com.google.ar.core.CameraIntrinsics,
        anchors: List<ArAnchorData>,
        depth: ArDepthData?,
    ) {
        val plugins = RNSARPluginRegistry.plugins()
        if (plugins.isEmpty()) {
            lastPluginSyncResults = null
            return
        }

        // Flatten the already-collected anchor descriptors into plain maps
        // (id/type/transform + optional alignment/extent) so plugins get the
        // same shape as the JS `ARAnchor` contract without a JSI dependency.
        val anchorMaps: List<Map<String, Any?>> =
            if (anchors.isEmpty()) emptyList()
            else anchors.map { a ->
                val m = HashMap<String, Any?>(5)
                m["id"] = a.id
                m["type"] = a.type
                m["transform"] = a.transform
                if (a.alignment.isNotEmpty()) m["alignment"] = a.alignment
                a.extent?.let { m["extent"] = it }
                m
            }

        // ── enableFeaturePoints — ARCore SLAM point cloud (opt-in) ───────
        //
        // Only when the host opted in (`<Camera enableFeaturePoints>` →
        // `setFeaturePointsEnabled` → `RNSARSession.featurePointsCloudEnabled`)
        // do we pay the acquire cost.  ARCore's `Frame.acquirePointCloud()`
        // hands back a `PointCloud` whose native buffer MUST be released — it
        // is `Closeable`, and there is a small fixed pool of them (ARCore
        // recommends acquiring at most one per frame).  Leaking it throws
        // `ResourceExhaustedException` on a later acquire.  `.use { }`
        // guarantees `close()` even on an early return / exception inside the
        // block.
        //
        // The `points` buffer is a direct `FloatBuffer` with a native
        // stride-4 `[x, y, z, confidence]` layout in world space.  We copy it
        // out to a plain `FloatArray` INSIDE `.use { }` (before close) so the
        // plugin gets a stable array that outlives the (immediately-closed)
        // PointCloud.
        //
        // NULL-vs-EMPTY contract (cross-platform parity, review F3): iOS sets
        // featurePoints = frame.rawFeaturePoints?.points, so "no usable cloud"
        // is NIL.  We mirror that here — an empty cloud (session not yet
        // TRACKING / SLAM not converged yields position=0) becomes NULL, never
        // an empty FloatArray, so a plugin's `context.featurePoints == null`
        // gate means the same thing on both platforms.  A non-null array
        // therefore always carries at least one point.
        //
        // Exception contract: acquirePointCloud()'s DOCUMENTED throws are
        // DeadlineExceededException (frame already superseded) and
        // ResourceExhaustedException (too many un-closed acquirables); a
        // not-yet-TRACKING session returns an empty cloud rather than throwing.
        // A single Throwable backstop catches everything (all unchecked) →
        // featurePoints stays null; we never crash the render loop.
        var featurePoints: FloatArray? = null
        if (RNSARSession.featurePointsCloudEnabled) {
            try {
                frame.acquirePointCloud().use { cloud ->
                    val buf = cloud.points  // direct FloatBuffer, stride-4
                    val n = buf.remaining()
                    if (n > 0) {
                        val out = FloatArray(n)
                        buf.get(out)  // copies [x,y,z,confidence] * pointCount
                        featurePoints = out
                    }
                    // n == 0 → leave featurePoints null (parity with iOS nil).
                }
            } catch (e: ResourceExhaustedException) {
                if (forwardLogTick % 30 == 1) {
                    Log.w(TAG, "acquirePointCloud: resource exhausted (leak?) — ${e.message}")
                }
                featurePoints = null
            } catch (t: Throwable) {
                // Defensive: any other ARCore/runtime failure must not take
                // down the AR render loop.  Feature points are best-effort.
                if (forwardLogTick % 30 == 1) {
                    Log.w(TAG, "acquirePointCloud failed (ignoring): ${t.message}")
                }
                featurePoints = null
            }
        }

        val ctx = ARFrameContext(
            nv21 = packed.nv21,
            width = packed.width,
            height = packed.height,
            timestampNs = frame.timestamp.toDouble(),
            fx = intrinsics.focalLength[0].toDouble(),
            fy = intrinsics.focalLength[1].toDouble(),
            cx = intrinsics.principalPoint[0].toDouble(),
            cy = intrinsics.principalPoint[1].toDouble(),
            imageWidth = intrinsics.imageDimensions[0],
            imageHeight = intrinsics.imageDimensions[1],
            poseRotation = doubleArrayOf(
                qarr[0].toDouble(), qarr[1].toDouble(),
                qarr[2].toDouble(), qarr[3].toDouble(),
            ),
            poseTranslation = doubleArrayOf(
                tArr[0].toDouble(), tArr[1].toDouble(), tArr[2].toDouble(),
            ),
            trackingState = tracking,
            depthBytes = depth?.bytes,
            depthWidth = depth?.width ?: 0,
            depthHeight = depth?.height ?: 0,
            anchors = anchorMaps,
            featurePoints = featurePoints,
        )

        var sync: HashMap<String, Any?>? = null
        for (plugin in plugins) {
            val result = try {
                plugin.process(ctx)
            } catch (t: Throwable) {
                if (forwardLogTick % 30 == 1) {
                    Log.w(TAG, "AR plugin '${plugin.name()}' threw in process(): ${t.message}")
                }
                null
            }
            if (result != null) {
                if (sync == null) sync = HashMap()
                sync[plugin.name()] = result
            }
        }
        lastPluginSyncResults = sync
    }

    /// Packed DEPTH16 result: dense (no row padding) uint16-per-pixel
    /// bytes plus the depth-map dimensions.  `bytes.size == width*height*2`.
    private data class ArDepthData(
        val bytes: ByteArray,
        val width: Int,
        val height: Int,
    )

    /// One anchor flattened for the JNI parallel-array marshal.
    /// `transform` is a 16-element ROW-MAJOR (anchor->world) matrix.
    ///
    /// For a depth-derived scene mesh (type="mesh") the geometry rides
    /// along in `meshVertices` (Float32 xyz triplets, LITTLE-ENDIAN) and
    /// `meshFaces` (Uint32 triangle indices, LITTLE-ENDIAN); both are
    /// `null` for plane/image/point anchors.  Mesh vertices are
    /// CAMERA-LOCAL, so the mesh anchor's `transform` is identity.
    private data class ArAnchorData(
        val id: String,
        val type: String,
        val transform: DoubleArray,
        val meshVertices: ByteArray? = null,
        val meshFaces: ByteArray? = null,
        /// Plane alignment: "" (n/a — image/mesh anchors) | "horizontal"
        /// | "vertical".  Set only on plane anchors; the JNI maps it to
        /// `ArAnchor.alignment` (empty → JS `alignment === undefined`).
        val alignment: String = "",
        /// Plane extent [extentX, extentZ] in metres, or null (image/mesh
        /// anchors).  Non-null → the JNI sets `ArAnchor.hasExtent`.
        val extent: DoubleArray? = null,
    )

    /**
     * Acquire this frame's ARCore depth image (DEPTH16) and copy it into a
     * dense, row-packed `ByteArray` of `w*h*2` bytes (no stride padding).
     *
     * Returns null when depth is unavailable for this frame — older
     * devices that don't support the Depth API, the first frames before
     * ARCore produces a depth estimate (`NotYetAvailableException`), or a
     * session configured without `DepthMode.AUTOMATIC`.  The ARCore Image
     * is always closed via `use {}`.
     *
     * Byte order is preserved verbatim from ARCore's little-endian
     * DEPTH16 buffer — the shared C++ JSI layer reinterprets the bytes as
     * `uint16_t` on the same (little-endian ARM) device, so no swap is
     * needed.
     */
    private fun acquireDepth16Packed(
        frame: com.google.ar.core.Frame,
    ): ArDepthData? {
        return try {
            frame.acquireDepthImage16Bits()?.use { img ->
                val w = img.width
                val h = img.height
                if (w <= 0 || h <= 0) return null
                val plane = img.planes[0]
                val rowStride = plane.rowStride          // may exceed w*2
                val src = plane.buffer                   // direct ByteBuffer
                val rowBytes = w * 2                      // DEPTH16: 2 bytes/px
                val out = ByteArray(rowBytes * h)
                // Copy ROW BY ROW — only the first `rowBytes` of each
                // `rowStride`-byte source row are real pixels; the tail
                // (rowStride - rowBytes) is alignment padding to skip.
                val row = ByteArray(rowBytes)
                for (y in 0 until h) {
                    src.position(y * rowStride)
                    src.get(row, 0, rowBytes)
                    System.arraycopy(row, 0, out, y * rowBytes, rowBytes)
                }
                ArDepthData(bytes = out, width = w, height = h)
            }
        } catch (t: Throwable) {
            // NotYetAvailableException (early frames), depth unsupported,
            // or any plane-access failure — treat as "no depth this frame".
            if (forwardLogTick % 30 == 1) {
                Log.d(TAG, "acquireDepth16Packed: no depth this frame: ${t.message}")
            }
            null
        }
    }

    /**
     * Reconstruct a triangle mesh from this frame's DEPTH16 map.
     *
     * ARCore (unlike ARKit's `ARMeshAnchor`) exposes no scene mesh, so we
     * unproject every valid depth pixel into a camera-local 3D point and
     * triangulate the resulting grid.  The output is ONE `ArAnchorData`
     * with type="mesh", id="mesh-depth", an IDENTITY transform (vertices
     * are camera-local, not world), a Float32 vertex buffer (xyz triplets,
     * little-endian) and a Uint32 triangle-index buffer (little-endian).
     *
     * ## Intrinsics
     *
     * `camera.imageIntrinsics` gives focal length + principal point at the
     * CAMERA-IMAGE resolution.  The depth map is much smaller (~160x120 on
     * ARCore), so we SCALE the intrinsics to the depth resolution:
     *   fx_d = fx * depthW / imgW,  cx_d = cx * depthW / imgW   (and y).
     *
     * ## Unprojection
     *
     * Depth z (metres) = (raw uint16 & 0x1FFF) / 1000.0  (low 13 bits = mm;
     * high 3 bits = confidence, masked off).  z==0 ⇒ invalid (skipped).
     *   X = (u - cx_d) * z / fx_d
     *   Y = (v - cy_d) * z / fy_d
     *   Z = z
     *
     * ## Triangulation
     *
     * For each grid cell whose 4 corners are ALL valid, emit 2 triangles
     * (6 Uint32 indices into the vertex array).  No decimation (non-goal).
     *
     * Returns null if the depth map has no valid pixels / no full cells.
     */
    private fun buildDepthMesh(
        depth: ArDepthData,
        intrinsics: com.google.ar.core.CameraIntrinsics,
    ): ArAnchorData? {
        val w = depth.width
        val h = depth.height
        if (w <= 1 || h <= 1) return null

        // Scale camera-image intrinsics to the depth-map resolution.
        val imgW = intrinsics.imageDimensions[0].toDouble()
        val imgH = intrinsics.imageDimensions[1].toDouble()
        if (imgW <= 0.0 || imgH <= 0.0) return null
        val sx = w.toDouble() / imgW
        val sy = h.toDouble() / imgH
        val fxD = intrinsics.focalLength[0].toDouble() * sx
        val fyD = intrinsics.focalLength[1].toDouble() * sy
        val cxD = intrinsics.principalPoint[0].toDouble() * sx
        val cyD = intrinsics.principalPoint[1].toDouble() * sy
        if (fxD <= 0.0 || fyD <= 0.0) return null

        // Read DEPTH16 as little-endian uint16 (raw mm in low 13 bits).
        val depthBuf = ByteBuffer.wrap(depth.bytes).order(ByteOrder.LITTLE_ENDIAN)
        val px = w * h

        // Unproject every valid pixel; build a pixel->vertex index map
        // (-1 for invalid) so triangulation can reference the compacted
        // vertex array.
        val vertXyz = FloatArray(px * 3)   // upper-bound; trimmed on write
        val indexMap = IntArray(px) { -1 }
        var vertCount = 0
        for (v in 0 until h) {
            val rowBase = v * w
            for (u in 0 until w) {
                val raw = depthBuf.getShort((rowBase + u) * 2).toInt() and 0xFFFF
                val mm = raw and 0x1FFF
                if (mm == 0) continue            // invalid depth — skip
                val z = mm / 1000.0
                val x = (u - cxD) * z / fxD
                val y = (v - cyD) * z / fyD
                val o = vertCount * 3
                vertXyz[o] = x.toFloat()
                vertXyz[o + 1] = y.toFloat()
                vertXyz[o + 2] = z.toFloat()
                indexMap[rowBase + u] = vertCount
                vertCount++
            }
        }
        if (vertCount == 0) return null

        // Triangulate the grid: each cell with all 4 corners valid → 2
        // triangles.  Index buffer is grown dynamically (count of full
        // cells isn't known ahead without a second pass).
        //   tl tr
        //   bl br   →  (tl, bl, br) + (tl, br, tr)
        val faces = ArrayList<Int>(px * 2)
        for (v in 0 until h - 1) {
            val r0 = v * w
            val r1 = r0 + w
            for (u in 0 until w - 1) {
                val tl = indexMap[r0 + u]
                val tr = indexMap[r0 + u + 1]
                val bl = indexMap[r1 + u]
                val br = indexMap[r1 + u + 1]
                if (tl < 0 || tr < 0 || bl < 0 || br < 0) continue
                faces.add(tl); faces.add(bl); faces.add(br)
                faces.add(tl); faces.add(br); faces.add(tr)
            }
        }
        if (faces.isEmpty()) return null

        // Pack vertices (Float32 xyz) + faces (Uint32) into little-endian
        // byte arrays — the JSI layer reinterprets these as ArrayBuffers
        // verbatim (Float32Array / Uint32Array on the same LE ARM device).
        val vertBytes = ByteArray(vertCount * 3 * 4)
        val vbuf = ByteBuffer.wrap(vertBytes).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until vertCount * 3) vbuf.putFloat(vertXyz[i])

        val faceBytes = ByteArray(faces.size * 4)
        val fbuf = ByteBuffer.wrap(faceBytes).order(ByteOrder.LITTLE_ENDIAN)
        for (idx in faces) fbuf.putInt(idx)

        // Identity 4x4 (row-major == column-major for identity).
        val identity = DoubleArray(16)
        identity[0] = 1.0; identity[5] = 1.0; identity[10] = 1.0; identity[15] = 1.0

        return ArAnchorData(
            id = "mesh-depth",
            type = "mesh",
            transform = identity,
            meshVertices = vertBytes,
            meshFaces = faceBytes,
        )
    }

    // ── onArFrame (v0.18.0) — LIGHT AR-metadata event channel ────────
    //
    // Build + throttle + emit the shared `ARFrameMeta` payload over the
    // `RNImageStitcherARFrame` device event.  Runs every render frame
    // from `onDrawFrame`, but is near-free unless a host has opted in
    // via `RNSARSession.setArFrameMetaEnabled(true, intervalMs)`:
    //   - one volatile read of `arFrameMetaEnabled` short-circuits the
    //     disabled case,
    //   - a monotonic `nanoTime()` compare throttles to `intervalMs`.
    //
    // The payload mirrors the shared contract EXACTLY (timestamp ns,
    // trackingState string, pose {rotation[4], translation[3]},
    // intrinsics|null, depth|null, anchors[], mesh|null).  depth/anchors/
    // mesh honour the SAME `enableDepth`/`enableAnchors`/`enableMesh`
    // extraction flags the worklet fan-out uses, so a host pays no
    // depth-acquire / anchor-collect cost for a field it didn't request.
    //
    // CRITICAL: this is LIGHT.  No pixel copies — depth is read for
    // dimensions + confidence-presence only (no `acquireDepth16Packed`
    // row-pack), and mesh is reported as anchor/vertex/face COUNTS only
    // (no vertex/face byte marshaling).  The heavy buffers stay on the
    // `arFrameProcessor` worklet path.

    private fun maybeEmitArFrameMeta(
        frame: com.google.ar.core.Frame,
        camera: Camera,
    ) {
        // Gate: disabled is the overwhelmingly common case — bail on a
        // single volatile read before touching the clock or the frame.
        if (!RNSARSession.arFrameMetaEnabled) return

        // Throttle: emit at most once per `arFrameMetaIntervalMs`.  Uses
        // System.nanoTime() (monotonic; immune to wall-clock jumps).  A
        // 0 interval disables throttling (emit every render frame).
        val nowNs = System.nanoTime()
        val intervalMs = RNSARSession.arFrameMetaIntervalMs
        if (intervalMs > 0L) {
            val last = RNSARSession.arFrameMetaLastEmitNs
            if (last != 0L && (nowNs - last) < intervalMs * 1_000_000L) return
        }
        RNSARSession.arFrameMetaLastEmitNs = nowNs

        val session = RNSARSession.instance ?: return

        // ── trackingState (always) — contract string enum ───────────
        val trackingStr = when (camera.trackingState) {
            TrackingState.TRACKING -> "normal"
            TrackingState.PAUSED -> "limited"
            TrackingState.STOPPED -> "notAvailable"
            else -> "notAvailable"
        }

        // ── pose (always) — rotation quaternion [x,y,z,w] + translation
        val pose = camera.pose
        val q = pose.rotationQuaternion  // x, y, z, w
        val t = pose.translation         // x, y, z

        val meta = com.facebook.react.bridge.Arguments.createMap()
        meta.putDouble("timestamp", frame.timestamp.toDouble())  // ns
        meta.putString("trackingState", trackingStr)

        val poseMap = com.facebook.react.bridge.Arguments.createMap()
        val rotArr = com.facebook.react.bridge.Arguments.createArray()
        rotArr.pushDouble(q[0].toDouble()); rotArr.pushDouble(q[1].toDouble())
        rotArr.pushDouble(q[2].toDouble()); rotArr.pushDouble(q[3].toDouble())
        poseMap.putArray("rotation", rotArr)
        val transArr = com.facebook.react.bridge.Arguments.createArray()
        transArr.pushDouble(t[0].toDouble()); transArr.pushDouble(t[1].toDouble())
        transArr.pushDouble(t[2].toDouble())
        poseMap.putArray("translation", transArr)
        meta.putMap("pose", poseMap)

        // ── intrinsics (always) — fx,fy,cx,cy + image dims, or null ──
        // camera.imageIntrinsics is always present once tracking has a
        // frame; guarded defensively (older devices can throw before the
        // first valid frame).
        val intrinsicsMap: com.facebook.react.bridge.WritableMap? = try {
            val intr = camera.imageIntrinsics
            com.facebook.react.bridge.Arguments.createMap().apply {
                putDouble("fx", intr.focalLength[0].toDouble())
                putDouble("fy", intr.focalLength[1].toDouble())
                putDouble("cx", intr.principalPoint[0].toDouble())
                putDouble("cy", intr.principalPoint[1].toDouble())
                putInt("imageWidth", intr.imageDimensions[0])
                putInt("imageHeight", intr.imageDimensions[1])
            }
        } catch (t2: Throwable) {
            null
        }
        if (intrinsicsMap != null) meta.putMap("intrinsics", intrinsicsMap)
        else meta.putNull("intrinsics")

        // Honour the SAME extraction flags as the worklet fan-out so
        // depth/anchors/mesh only cost work when the host opted in.
        val flags = StitcherWorkletRuntime.extractionFlags()

        // ── depth (only when enableDepth) — DIMS + confidence presence,
        //    NO pixel copy.  DEPTH16 packs an 8-bit (high 3 bits)
        //    confidence with each sample, so when a depth image exists
        //    confidence is always present.
        if (flags.depth) {
            val depthDims = acquireDepthDimsLight(frame)
            if (depthDims != null) {
                val depthMap = com.facebook.react.bridge.Arguments.createMap()
                depthMap.putInt("width", depthDims[0])
                depthMap.putInt("height", depthDims[1])
                depthMap.putBoolean("hasConfidence", true)
                meta.putMap("depth", depthMap)
            } else {
                meta.putNull("depth")
            }
        } else {
            meta.putNull("depth")
        }

        // ── anchors (only when enableAnchors) — descriptors, no pixels.
        //    Reuses the existing collectTrackingAnchors (id/type/alignment/
        //    extent/transform); the depth-mesh anchor is NOT included here
        //    (mesh is reported as counts in the `mesh` field below).
        val anchorsArr = com.facebook.react.bridge.Arguments.createArray()
        if (flags.anchors) {
            val anchors = sessionRef.get()?.let { collectTrackingAnchors(it) } ?: emptyList()
            for (a in anchors) {
                val am = com.facebook.react.bridge.Arguments.createMap()
                am.putString("id", a.id)
                am.putString("type", a.type)
                if (a.alignment.isNotEmpty()) am.putString("alignment", a.alignment)
                a.extent?.let { ext ->
                    val extArr = com.facebook.react.bridge.Arguments.createArray()
                    extArr.pushDouble(ext[0]); extArr.pushDouble(ext[1])
                    am.putArray("extent", extArr)
                }
                // classification: ARCore exposes none for plane/image
                // trackables (ARKit-only field) — omit it (JS sees
                // `classification === undefined`), matching the
                // `classification?` optionality in the contract.
                val tArr = com.facebook.react.bridge.Arguments.createArray()
                for (v in a.transform) tArr.pushDouble(v)
                am.putArray("transform", tArr)
                anchorsArr.pushMap(am)
            }
        }
        meta.putArray("anchors", anchorsArr)

        // ── mesh (only when enableMesh) — COUNTS only, no byte marshal.
        //    ARCore has no native scene mesh; the depth-reconstructed
        //    mesh is what the worklet path emits.  For the LIGHT channel
        //    we report a single anchor (anchorCount=1) whose vertex/face
        //    counts come from a count-only depth scan (no buffer build).
        //    Reported only when mesh is on AND a depth image is available.
        if (flags.mesh) {
            val meshCounts = computeDepthMeshCountsLight(frame)
            if (meshCounts != null) {
                val meshMap = com.facebook.react.bridge.Arguments.createMap()
                meshMap.putInt("anchorCount", 1)
                meshMap.putInt("vertexCount", meshCounts[0])
                meshMap.putInt("faceCount", meshCounts[1])
                meta.putMap("mesh", meshMap)
            } else {
                meta.putNull("mesh")
            }
        } else {
            meta.putNull("mesh")
        }

        // ── plugins (0.19.0) — native-plugin SYNC results, if any ────────
        //    `lastPluginSyncResults` was stashed by `runArPlugins` earlier
        //    in THIS same onDrawFrame tick (forwardToIncremental runs before
        //    maybeEmitArFrameMeta).  Each value is the WritableMap a plugin
        //    returned from `process()`; we re-key it under `plugins[name]`.
        //    Omitted entirely when no plugin produced a sync result (JS sees
        //    `meta.plugins === undefined`), matching the optional `plugins?`
        //    field in the ARFrameMeta contract.
        // Take ownership of the stashed plugin maps and CLEAR the field
        // immediately.  `putMap` CONSUMES each WritableMap; if the field kept
        // pointing at the now-consumed maps and a later emit ran before
        // runArPlugins refreshed them (this emit is throttled, runArPlugins is
        // not), putMap would throw `ObjectAlreadyConsumedException: Map already
        // consumed` on the GL thread and crash AR.  Nulling here makes a
        // consumed map un-reusable.
        val pluginResults = lastPluginSyncResults
        lastPluginSyncResults = null
        if (!pluginResults.isNullOrEmpty()) {
            val pluginsMap = com.facebook.react.bridge.Arguments.createMap()
            for ((name, value) in pluginResults) {
                when (value) {
                    is com.facebook.react.bridge.WritableMap ->
                        pluginsMap.putMap(name, value)
                    null -> pluginsMap.putNull(name)
                    // Defensive: a plugin should only ever return a
                    // WritableMap, but never let an unexpected type crash the
                    // emit — drop it.
                    else -> { /* skip unsupported result type */ }
                }
            }
            meta.putMap("plugins", pluginsMap)
        }

        session.emitArFrameMeta(meta)
    }

    /**
     * LIGHT depth probe — return `[width, height]` of this frame's
     * DEPTH16 image WITHOUT copying any pixels (the contract's depth
     * field carries dims + confidence-presence only).  `use {}` closes
     * the ARCore Image deterministically in all paths.  Returns null when
     * depth is unavailable (unsupported device, early frames, or depth
     * not configured).
     */
    private fun acquireDepthDimsLight(
        frame: com.google.ar.core.Frame,
    ): IntArray? {
        return try {
            frame.acquireDepthImage16Bits()?.use { img ->
                val w = img.width
                val h = img.height
                if (w <= 0 || h <= 0) null else intArrayOf(w, h)
            }
        } catch (t: Throwable) {
            // NotYetAvailableException / depth unsupported — no depth.
            null
        }
    }

    /**
     * LIGHT mesh count probe — return `[vertexCount, faceCount]` for the
     * depth-reconstructed mesh WITHOUT building any vertex/face byte
     * buffers (the contract's mesh field carries counts only).
     *
     * Mirrors [buildDepthMesh]'s validity rules exactly (z==0 ⇒ invalid
     * vertex; a grid cell contributes 2 faces iff all 4 corners are
     * valid) so the reported counts match what the worklet path would
     * actually marshal — but we never allocate the vertex/index/byte
     * arrays.  Reuses [acquireDepth16Packed] for the row-packed DEPTH16
     * read (the only depth read available), then scans it numerically.
     *
     * Returns null when no depth image is available or the mesh would be
     * empty (no valid pixels / no full cells).
     *
     * Note: camera intrinsics are NOT needed here — vertex/face VALIDITY
     * is purely a function of the depth value (mm != 0), and counts are
     * invariant to the unprojection the worklet path performs.
     */
    private fun computeDepthMeshCountsLight(
        frame: com.google.ar.core.Frame,
    ): IntArray? {
        val depth = acquireDepth16Packed(frame) ?: return null
        val w = depth.width
        val h = depth.height
        if (w <= 1 || h <= 1) return null

        val depthBuf = ByteBuffer.wrap(depth.bytes).order(ByteOrder.LITTLE_ENDIAN)

        // Per-pixel validity (matches buildDepthMesh: low 13 bits = mm;
        // mm==0 ⇒ invalid).  Track which pixels are valid so face cells
        // can test their 4 corners without re-reading the buffer.
        val valid = BooleanArray(w * h)
        var vertexCount = 0
        for (i in 0 until w * h) {
            val raw = depthBuf.getShort(i * 2).toInt() and 0xFFFF
            if ((raw and 0x1FFF) != 0) {
                valid[i] = true
                vertexCount++
            }
        }
        if (vertexCount == 0) return null

        // Faces: each cell with all 4 corners valid → 2 triangles.
        var faceCount = 0
        for (v in 0 until h - 1) {
            val r0 = v * w
            val r1 = r0 + w
            for (u in 0 until w - 1) {
                if (valid[r0 + u] && valid[r0 + u + 1] &&
                    valid[r1 + u] && valid[r1 + u + 1]
                ) {
                    faceCount += 2
                }
            }
        }
        if (faceCount == 0) return null
        return intArrayOf(vertexCount, faceCount)
    }

    /**
     * Collect every currently-TRACKING anchor from the session as
     * `ArAnchorData` (id, coarse type, row-major 4x4 transform).
     *
     * `Pose.toMatrix(float[16], 0)` yields a COLUMN-MAJOR (OpenGL) matrix;
     * we TRANSPOSE it to the row-major layout the shared C++ contract
     * expects (`ArAnchor.transform`, anchor->world, row-major).
     *
     * Cross-platform parity: ARKit's `frame.anchors` auto-includes detected
     * `ARPlaneAnchor`s (planeDetection is on), so iOS surfaces planes as
     * anchors for free.  ARCore exposes detected planes / augmented images
     * as TRACKABLES (not `Anchor`s) until you call `createAnchor`, and this
     * app creates none — so to give the worklet the same useful per-frame
     * spatial data, we surface detected plane + augmented-image trackables
     * (in TRACKING state) directly as anchors.  `centerPose` is the anchor
     * pose; `Pose.toMatrix` is COLUMN-MAJOR (OpenGL) so we transpose to the
     * row-major layout the shared C++ contract (`ArAnchor.transform`,
     * anchor->world) expects.  ids are per-session-stable (identity hash).
     */
    private fun collectTrackingAnchors(
        session: Session,
    ): List<ArAnchorData> {
        val out = ArrayList<ArAnchorData>()
        val colMajor = FloatArray(16)

        // Transpose ARCore's COLUMN-MAJOR (OpenGL) pose matrix to the
        // ROW-MAJOR (anchor->world) layout the shared C++ contract wants.
        fun rowMajorTransform(pose: com.google.ar.core.Pose): DoubleArray {
            pose.toMatrix(colMajor, 0)  // COLUMN-MAJOR (OpenGL)
            val rowMajor = DoubleArray(16)
            for (r in 0 until 4) {
                for (c in 0 until 4) {
                    rowMajor[r * 4 + c] = colMajor[c * 4 + r].toDouble()
                }
            }
            return rowMajor
        }

        // Image/mesh anchors carry no alignment/extent (alignment=""/
        // extent=null) — same shape as before this change.
        fun emit(id: String, type: String, pose: com.google.ar.core.Pose) {
            out.add(ArAnchorData(id = id, type = type, transform = rowMajorTransform(pose)))
        }

        // Read the JS `<Camera planeDetection=...>` filter once per frame
        // ("vertical" | "horizontal" | "both").  We FILTER which plane
        // orientations are surfaced here — ARCore's planeFindingMode stays
        // HORIZONTAL_AND_VERTICAL (see RNSARSession.setPlaneDetection).
        val planeMode = RNSARSession.planeDetectionMode

        for (plane in session.getAllTrackables(com.google.ar.core.Plane::class.java)) {
            if (plane.trackingState != TrackingState.TRACKING) continue
            // Skip planes merged into a larger one (avoids duplicate poses).
            if (plane.subsumedBy != null) continue

            val alignment = when (plane.type) {
                com.google.ar.core.Plane.Type.HORIZONTAL_UPWARD_FACING,
                com.google.ar.core.Plane.Type.HORIZONTAL_DOWNWARD_FACING -> "horizontal"
                com.google.ar.core.Plane.Type.VERTICAL -> "vertical"
                else -> ""
            }
            // Filter by the JS plane-detection prop (applied AFTER the
            // subsumedBy / trackingState skips above).  "both" keeps all.
            when (planeMode) {
                "vertical" -> if (alignment != "vertical") continue
                "horizontal" -> if (alignment != "horizontal") continue
                else -> { /* "both" — keep all orientations */ }
            }

            out.add(
                ArAnchorData(
                    id = "plane-${System.identityHashCode(plane)}",
                    type = "plane",
                    transform = rowMajorTransform(plane.centerPose),
                    alignment = alignment,
                    // extentX/extentZ: plane size (metres) along its local
                    // X/Z axes (Y is the normal).
                    extent = doubleArrayOf(
                        plane.extentX.toDouble(),
                        plane.extentZ.toDouble(),
                    ),
                ),
            )
        }
        for (img in session.getAllTrackables(com.google.ar.core.AugmentedImage::class.java)) {
            if (img.trackingState != TrackingState.TRACKING) continue
            emit("image-${System.identityHashCode(img)}", "image", img.centerPose)
        }
        return out
    }

    /// v0.13.2 — map the JS physical device orientation to the
    /// `Surface.ROTATION_*` value `YuvImageConverter.encodeToJpeg`
    /// expects.  Mirrors the equivalence documented in encodeToJpeg's
    /// EXIF table (ROTATION_0=portrait, _90=landscape-left,
    /// _180=portrait-upside-down, _270=landscape-right).  Unknown /
    /// missing → portrait (the safe pre-v0.12 default).
    private fun deviceOrientationToSurfaceRotation(orientation: String): Int =
        when (orientation) {
            "landscape-left" -> Surface.ROTATION_90
            "portrait-upside-down" -> Surface.ROTATION_180
            "landscape-right" -> Surface.ROTATION_270
            else -> Surface.ROTATION_0 // "portrait" + fallback
        }

    private fun applyDisplayGeometry() {
        val session = sessionRef.get() ?: return
        val rotation = (context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager)
            ?.defaultDisplay
            ?.rotation
            ?: Surface.ROTATION_0
        // Keep lastDisplayRotation current regardless — the JPEG encode
        // path (forwardToIncremental → encodeJpegFromNV21) reads it for
        // the EXIF orientation tag.
        lastDisplayRotation = rotation

        val box = letterboxBox()
        val bw = box[2]
        val bh = box[3]
        if (bw <= 0 || bh <= 0) return
        // Feed ARCore the BOX dimensions (not the full surface) so its UV
        // transform fills the box aspect — the full camera FOV with no
        // centre-crop.  Only push on change to avoid per-frame churn.
        if (rotation != lastGeomRotation || bw != lastGeomW || bh != lastGeomH) {
            session.setDisplayGeometry(rotation, bw, bh)
            lastGeomRotation = rotation
            lastGeomW = bw
            lastGeomH = bh
            Log.d(
                TAG,
                "setDisplayGeometry(box): rotation=$rotation box=${bw}×${bh} "
                    + "surface=${surfaceWidth}×${surfaceHeight} cameraAspect=$cameraAspect",
            )
        }
    }

    /**
     * Convert an ARCore quaternion (x, y, z, w) to (yaw, pitch) in
     * radians — same convention as the iOS Swift side: rotate the
     * camera-forward (-Z) vector by the quaternion, then pull yaw
     * (atan2 onto X-Z plane) and pitch (asin of Y component).
     *
     * Closed-form forward = R * (0, 0, -1), where R is the standard
     * quaternion-to-3x3 matrix.  Bottom row of R gives `forwardZ`,
     * etc; multiplying (0,0,-1) just negates the third column.
     */
    private fun quaternionYawPitch(q: FloatArray): Pair<Double, Double> {
        val x = q[0].toDouble()
        val y = q[1].toDouble()
        val z = q[2].toDouble()
        val w = q[3].toDouble()
        val forwardX = -(2.0 * (x * z + w * y))
        val forwardY = -(2.0 * (y * z - w * x))
        val forwardZ = -(1.0 - 2.0 * (x * x + y * y))
        val yaw = atan2(forwardX, -forwardZ)
        val pitch = asin(forwardY.coerceIn(-1.0, 1.0))
        return yaw to pitch
    }

    companion object {
        private const val TAG = "RNSARCameraView"
    }
}
