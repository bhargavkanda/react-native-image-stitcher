// SPDX-License-Identifier: UNLICENSED
package com.retailens.capturesdk

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
import com.retailens.capturesdk.ar.BackgroundRenderer
import com.retailens.capturesdk.ar.YuvImageConverter
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.asin

/**
 * Android twin of `RetaiLensARCameraView.swift` (iOS Phase 4.4).
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
 *                              from RetaiLensARSession.instance
 *   onSurfaceCreated (GL)   → create OES texture, build BackgroundRenderer
 *   onSurfaceChanged (GL)   → notify session of display geometry
 *   onDrawFrame (GL)        → session.update(); pose → log;
 *                              if stitcher running: image → JPEG → engine
 *   onDetachedFromWindow    → pause render thread; do NOT pause Session
 *                              (other views may still be using it)
 */
class RetaiLensARCameraView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : FrameLayout(context, attrs, defStyle), GLSurfaceView.Renderer {

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

    /// Tmp directory for the per-frame JPEG file we hand to the
    /// incremental engine.  Created lazily and reused across frames
    /// — no per-frame allocation.
    private val tmpJpegFile: File by lazy {
        File(context.cacheDir, "rlis-arframe.jpg")
    }

    /// Whether to feed the AR session's frames into the incremental
    /// engine.  Toggled by RetaiLensIncrementalStitcher.start/stop
    /// via setIncrementalIngestionActive() below.
    @Volatile private var ingestActive: Boolean = false

    init {
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
        RetaiLensARSession.instance?.startForView()

        glView.onResume()
        // Try to borrow the session from the running RetaiLensARSession.
        val session = RetaiLensARSession.instance?.getSessionForView()
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
        } else {
            Log.w(
                TAG,
                "onAttachedToWindow: session is still null after startForView; " +
                    "preview will stay black until the view re-mounts " +
                    "(possible reasons: no Activity, ARCore install in progress, " +
                    "device unsupported — see RetaiLensARSession logs)",
            )
        }
        RetaiLensARSession.instance?.bindCameraView(this)
        RetaiLensIncrementalStitcher.bridgeInstance?.bindArCameraView(this)
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        Log.i(TAG, "onDetachedFromWindow: requesting AR session stop (iOS-parity didMoveToWindow)")
        // Pause the GL thread so we stop drawing frames.
        glView.onPause()
        sessionTextureBound = false
        RetaiLensIncrementalStitcher.bridgeInstance?.unbindArCameraView(this)
        RetaiLensARSession.instance?.unbindCameraView(this)
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
        RetaiLensARSession.instance?.stopForView()
    }

    /// Called by RetaiLensIncrementalStitcher.start/stop.  When true,
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
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)

        val session = sessionRef.get() ?: run {
            // Session not yet attached (start() hasn't run, or
            // the bridge module instance was rebuilt).  Try once
            // more in case the bridge resolved it after onAttach.
            val late = RetaiLensARSession.instance?.getSessionForView()
            if (late != null) sessionRef.set(late)
            return
        }
        if (!sessionTextureBound) {
            backgroundRenderer.bindToSession(session)
            sessionTextureBound = true
            // Ensure ARCore knows the surface geometry.
            applyDisplayGeometry()
        }

        val frame = try {
            session.update()
        } catch (e: SessionPausedException) {
            return  // session paused — wait for resume
        } catch (t: Throwable) {
            Log.w(TAG, "session.update failed: ${t.message}")
            return
        }

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
        RetaiLensARSession.instance?.evaluatePlanesForFrame(
            cameraForwardWorld,
            cameraPosWorld,
        )

        // Push pose into the AR session log.  Mirrors iOS' delegate
        // path; the existing RetaiLensARFramePose / appendPose
        // contract was already in place for Phase 4.
        appendPose(camera, frame.timestamp)

        // Forward to the incremental stitcher if engaged.
        if (ingestActive) {
            forwardToIncremental(frame, camera)
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
            TrackingState.TRACKING -> RetaiLensARSession.TRACKING_TRACKING
            TrackingState.PAUSED   -> RetaiLensARSession.TRACKING_LIMITED
            TrackingState.STOPPED  -> RetaiLensARSession.TRACKING_NOT_AVAILABLE
            else -> RetaiLensARSession.TRACKING_NOT_AVAILABLE
        }

        val framePose = RetaiLensARFramePose(
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
        RetaiLensARSession.instance?.appendPose(framePose)
        RetaiLensARSession.instance?.updateTrackingState(camera.trackingState)
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
        try {
            val written = YuvImageConverter.encodeToJpeg(
                image,
                tmpJpegFile.absolutePath,
                jpegQuality = 70,
                // 2026-05-15 (B3) — pass current display rotation so
                // the encoded JPEG gets an EXIF orientation tag.
                // Without this, the live thumbnail strip shows
                // sideways pictures when the device is held in
                // portrait (sensor pixels are landscape by default).
                // lastDisplayRotation is updated by the
                // updateDisplayRotation() helper called from
                // didMoveToWindow / the ARCore Session.setDisplayGeometry
                // hook (see line ~410).
                displayRotation = if (lastDisplayRotation >= 0)
                    lastDisplayRotation else android.view.Surface.ROTATION_0,
            ) ?: return

            // Compute yaw + pitch from the ARCore quaternion using
            // the same convention the iOS Swift side uses (camera-
            // forward in world space).  This keeps the two platforms
            // numerically aligned for the FoV-overlap gate.
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
            postFrameToEngine(
                path = written,
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
            )
        } finally {
            image.close()
        }
    }

    private fun postFrameToEngine(
        path: String,
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        yaw: Double,
        pitch: Double,
        fovHorizDegrees: Double,
        fovVertDegrees: Double,
        trackingPoor: Boolean,
    ) {
        val module = RetaiLensIncrementalStitcher.bridgeInstance ?: return
        module.ingestFromARCameraView(
            path = path,
            tx = tx, ty = ty, tz = tz,
            qx = qx, qy = qy, qz = qz, qw = qw,
            fx = fx, fy = fy, cx = cx, cy = cy,
            imageWidth = imageWidth, imageHeight = imageHeight,
            yaw = yaw,
            pitch = pitch,
            fovHorizDegrees = fovHorizDegrees,
            fovVertDegrees = fovVertDegrees,
            trackingPoor = trackingPoor,
        )
    }

    private fun applyDisplayGeometry() {
        val session = sessionRef.get() ?: return
        val rotation = (context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager)
            ?.defaultDisplay
            ?.rotation
            ?: Surface.ROTATION_0
        if (rotation != lastDisplayRotation
            || surfaceWidth > 0 || surfaceHeight > 0
        ) {
            session.setDisplayGeometry(rotation, surfaceWidth, surfaceHeight)
            lastDisplayRotation = rotation
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
        private const val TAG = "RetaiLensARCameraView"
    }
}
