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
import com.google.ar.core.Camera
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.SessionPausedException
import io.imagestitcher.rn.ar.BackgroundRenderer
import io.imagestitcher.rn.ar.YuvImageConverter
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

    init {
        // Black background avoids a flash before the GL surface starts
        // clearing itself black each frame (the GL-level letterbox draws
        // the bars; this is just belt-and-suspenders for the first frame).
        setBackgroundColor(android.graphics.Color.BLACK)
        addView(
            glView,
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

        // Forward to the incremental stitcher when capture is engaged,
        // OR when an AR frame-processor host worklet is registered (the
        // v0.8.0 Phase 4b.iii fan-out forwards preview frames whenever
        // host worklets exist, even with capture off — the host worklet
        // observes the live AR stream).  `forwardToIncremental` does the
        // NV21 pack once and gates the first-party ingest internally on
        // `ingestActive`; the host-worklet dispatch is gated on the
        // native registry count.  `hasHostWorklets()` is a cheap atomic
        // read (microseconds) so the common capture-off / no-worklet
        // preview path stays near-free.
        if (ingestActive || StitcherWorkletRuntime.hasHostWorklets()) {
            forwardToIncremental(frame, camera)
        }

        // takePhoto consumer — runs on EVERY render tick (not just
        // when ingest is active), since the host calls takePhoto in
        // photo mode where ingest is off.  No-op when no request is
        // pending; cheap atomic CAS on the hot path.
        pendingTakePhoto.getAndSet(null)?.let { req ->
            fulfilTakePhoto(frame, req)
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
                YuvImageConverter.encodeJpegFromNV21(
                    packed,
                    targetPath,
                    jpegQuality = 70,
                    displayRotation = rotationForEncode,
                ) != null
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
        )
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
