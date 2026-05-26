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
        promise: com.facebook.react.bridge.Promise,
    ) {
        val req = TakePhotoRequest(outputPath, quality, promise)
        val previous = pendingTakePhoto.getAndSet(req)
        previous?.promise?.reject(
            "ar-photo-superseded",
            "takePhoto: superseded by a newer call before the frame was captured.",
        )
        // Wake the render loop in case it's idle.
        glView.requestRender()
    }

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
            val late = RNSARSession.instance?.getSessionForView()
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
        RNSARSession.instance?.evaluatePlanesForFrame(
            cameraForwardWorld,
            cameraPosWorld,
        )

        // Push pose into the AR session log.  Mirrors iOS' delegate
        // path; the existing RNSARFramePose / appendPose
        // contract was already in place for Phase 4.
        appendPose(camera, frame.timestamp)

        // Forward to the incremental stitcher if engaged.
        if (ingestActive) {
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
                displayRotation = if (lastDisplayRotation >= 0)
                    lastDisplayRotation
                else
                    Surface.ROTATION_0,
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

        // F8.6 (v0.6) — the eager JPEG encode for live-engine mode
        // is gone.  Pass the already-packed NV21 directly via
        // `nv21PixelData`; the engine's new `addFramePixelData`
        // path builds the BGR cv::Mat in-process via cvtColor,
        // skipping the JPEG decode round-trip downstream.  In
        // batch-keyframe mode the engine ignores `nv21PixelData`
        // (it uses `grayData` + `onAccept` lazily); no behaviour
        // change there.
        //
        // (Was: eager JPEG encode for non-batch-keyframe modes,
        //  written to `tmpJpegFile`, passed as `legacyJpegPath`.
        //  See the v0.3 / F8.6 entries in CHANGELOG.md.)
        //
        // v0.8.0 Phase 3c — route through the worklet runtime's
        // `runFirstParty` indirection.  The lambda body is the
        // unchanged engine ingest call; the indirection sets up
        // the seam where Phase 4 will fan out to host worklets
        // without touching this first-party path.  Synchronous
        // invocation preserves the ARCore Image ownership contract
        // — the engine consumes the TransferredNV21 inside the
        // lambda before ARCore recycles the Image.
        StitcherWorkletRuntime.installIfNeeded()
        StitcherWorkletRuntime.runFirstParty {
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
            legacyJpegPath = null,
            // F8.6 — pixel-data path for live engines.  Batch-
            // keyframe mode ignores these (bails earlier).
            //
            // v0.10.0 audit #4A — wrap `packed.nv21` in
            // TransferredNV21 so ownership is enforced at runtime.
            // The AR caller passes the SAME `packed.nv21` array as
            // both `grayData` (sync, gate-eval read) and
            // `nv21PixelData` (async, engine ingest).  Today no race
            // because grayData is consumed inside evaluateWithFrame
            // before workScope.launch fires; the wrapper makes a
            // future refactor that reorders consumption fail loudly
            // instead of silently corrupting frames.
            nv21PixelData = TransferredNV21(packed.nv21),
            nv21PixelWidth = packed.width,
            nv21PixelHeight = packed.height,
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
        }  // closes StitcherWorkletRuntime.runFirstParty { … } (v0.8.0 Phase 3c)
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
        private const val TAG = "RNSARCameraView"
    }
}
