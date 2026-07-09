// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Range
import android.view.Surface
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.react.CameraView
import io.imagestitcher.rn.ar.YuvImageConverter
import java.io.File
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * v0.22.0 — fixed-short-exposure frame burst (refresh-banding probe,
 * NonAR-2).  Native half of `CameraHandle.captureExposureBurst`:
 * N consecutive video-stream frames at a manual ≤2 ms exposure, JPEG-
 * encoded sensor-oriented, auto-exposure restored after.  The banding
 * ANALYSIS (row-mean FFT over a rack ROI) lives in the consumer — this
 * module is only the capture primitive.
 *
 * ## How manual exposure reaches vision-camera's session
 *
 * vision-camera 4.7.3 Android is built on CameraX (not raw Camera2),
 * and CameraX ships a public Camera2 interop —
 * `androidx.camera.camera2.interop.Camera2CameraControl` — that merges
 * arbitrary `CaptureRequest` keys (`CONTROL_AE_MODE_OFF`,
 * `SENSOR_EXPOSURE_TIME`, `SENSOR_SENSITIVITY`) into the LIVE repeating
 * request with higher priority than CameraX's own 3A, re-applied across
 * its internal request rebuilds.  The only non-public hop is reaching
 * vision-camera's CameraX `Camera` handle:
 *
 *   CameraView.cameraSession   (internal val → private JVM field)
 *     → CameraSession.camera   (internal var → private JVM field)
 *       → camera.cameraControl → Camera2CameraControl.from(...)   [all public]
 *
 * Two `getDeclaredField(...).setAccessible(true)` reads, verified
 * against vision-camera 4.7.3 (field names are plain property names,
 * stable across debug/release — unlike the Kotlin-internal GETTERS,
 * whose JVM names are mangled with the build variant).  Guarded by
 * `consumer-rules.pro` keep rules so consumer R8 builds don't rename
 * the two fields.  Restore = `clearCaptureRequestOptions()`, which
 * drops ONLY our interop keys and lets CameraX rebuild its normal
 * AE-on request (vc's zoom/torch/EV live elsewhere and are untouched).
 *
 * ## Why frames come from the frame-processor stream, not takePhoto
 *
 * Still pipelines run vendor multi-frame merges that average the
 * banding phases away, and CameraX's `ImageCapture` also fires an AE
 * precapture sequence that fights `CONTROL_AE_MODE_OFF`.  The
 * `rnis_exposure_burst_sink` vc plugin (see `ExposureBurstSinkPlugin`)
 * hands us single-integration YUV frames with no session changes.
 *
 * ## Settle window
 *
 * Unlike iOS (whose `setExposureModeCustom` completion hands back the
 * exact first-applied frame timestamp), CameraX exposes no per-frame
 * AE actuals through the interop, so after the options-future completes
 * the collector skips `SETTLE_FRAMES` frames (pipeline depth) before
 * keeping any.  The applied exposure is reported back on the result so
 * the consumer can sanity-check brightness statistics per frame.
 *
 * ## Orientation contract (mirrors iOS)
 *
 * Saved JPEGs are the raw video-stream pixels: SENSOR-NATIVE landscape,
 * no pixel rotation, EXIF orientation NORMAL (we pass
 * `displayRotation = ROTATION_90`, which `encodeJpegFromNV21` maps to
 * the NORMAL tag — the parameter names display rotation, but the tag
 * mapping is what matters here).  Image rows == sensor rows == the
 * banding axis.  `maxLongEdge = 0` disables the encoder's 640 px AR-
 * keyframe clamp — full-res rows ARE the signal.
 *
 * ## Reject codes
 *
 * `EXPOSURE_BURST_IN_FLIGHT`, `EXPOSURE_BURST_VIEW_NOT_FOUND`,
 * `EXPOSURE_BURST_SESSION_UNAVAILABLE` (reflection failed / camera not
 * bound — includes unsupported vision-camera versions),
 * `EXPOSURE_BURST_UNSUPPORTED` (no `CONTROL_AE_MODE_OFF` on this
 * camera), `EXPOSURE_BURST_APPLY_FAILED`, `EXPOSURE_BURST_TIMEOUT`,
 * `EXPOSURE_BURST_ENCODE_FAILED`, `EXPOSURE_BURST_BAD_ARGS`.
 */
@androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
internal object ExposureBurstCoordinator {

    private const val TAG = "RNISExposureBurst"

    /** Frames skipped after the options-future completes (pipeline depth). */
    private const val SETTLE_FRAMES = 4

    /**
     * One burst in flight.  `phase` transitions inside the session's
     * monitor; the slot itself is CAS-owned like
     * `PreviewFrameGrabCoordinator` so take/timeout settle exactly once.
     */
    class Session(
        val frameCount: Int,
        val quality: Int,
        val outputDir: String,
        val appliedExposureMs: Double,
        val appliedIso: Int,
        val control: Camera2CameraControl,
        val promise: Promise,
    ) {
        /** 0 = waiting for the interop future; 1 = settling; 2 = collecting. */
        var phase = 0
        var settleRemaining = SETTLE_FRAMES
        val collected = ArrayList<YuvImageConverter.PackedYuv>()
        val timestampsNs = ArrayList<Long>()
    }

    private val slot = AtomicReference<Session?>(null)
    private val encodeExecutor: Executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "rnis-exposure-burst-encode").apply { isDaemon = true }
    }

    fun arm(session: Session): Boolean = slot.compareAndSet(null, session)

    fun cancelIfCurrent(session: Session): Boolean =
        slot.compareAndSet(session, null)

    /** The interop options-future completed — start the settle countdown. */
    fun onExposureApplied(session: Session) {
        synchronized(session) {
            if (session.phase == 0) session.phase = 1
        }
    }

    /**
     * Per-frame entry from the sink plugin (frame-processor thread).
     * One atomic read when no burst is armed; during a burst it packs
     * (copies) the frame synchronously — ~10 ms, inside the frame
     * budget, so consecutive frames stay consecutive — and hands the
     * final encode to a background executor.
     */
    fun ingest(frame: Frame) {
        val session = slot.get() ?: return
        var complete = false
        synchronized(session) {
            when (session.phase) {
                0 -> return                      // exposure not applied yet
                1 -> {
                    session.settleRemaining -= 1
                    if (session.settleRemaining <= 0) session.phase = 2
                    return
                }
            }
            if (session.collected.size >= session.frameCount) return
            // Both accessors throw FrameInvalidError once vc has closed
            // the frame — skip and wait for the next one.
            val image: android.media.Image
            val timestampNs: Long
            try {
                image = frame.image
                timestampNs = frame.timestamp
            } catch (t: Throwable) {
                return
            }
            if (image.format != android.graphics.ImageFormat.YUV_420_888) return
            val packed = YuvImageConverter.packNV21(image) ?: return
            session.collected.add(packed)
            session.timestampsNs.add(timestampNs)
            complete = session.collected.size >= session.frameCount
        }
        if (!complete) return
        // All frames in hand: this thread must win the slot before
        // settling (the timeout may have fired meanwhile).
        if (!cancelIfCurrent(session)) return
        restoreAutoExposure(session.control)
        encodeExecutor.execute { encodeAndResolve(session) }
    }

    fun timeout(session: Session) {
        if (!cancelIfCurrent(session)) return
        restoreAutoExposure(session.control)
        val got: Int
        val wanted: Int
        synchronized(session) {
            got = session.collected.size
            wanted = session.frameCount
        }
        session.promise.reject(
            "EXPOSURE_BURST_TIMEOUT",
            "captureExposureBurst: timed out with $got/$wanted frames "
                + "collected.  Is the lib's non-AR frame processor mounted?  "
                + "(Hosts that replace it must compose `useStitcherWorklet`.)",
        )
    }

    /** Reject path for a session that never armed frames (apply failed). */
    fun abort(session: Session, code: String, message: String, cause: Throwable?) {
        if (!cancelIfCurrent(session)) return
        restoreAutoExposure(session.control)
        session.promise.reject(code, message, cause)
    }

    private fun restoreAutoExposure(control: Camera2CameraControl) {
        try {
            // Drops only OUR interop keys; CameraX rebuilds its normal
            // AE-on repeating request (vc's zoom/torch are separate
            // CameraControl state and unaffected).
            control.clearCaptureRequestOptions()
        } catch (t: Throwable) {
            Log.w(TAG, "failed to clear interop capture-request options: ${t.message}")
        }
    }

    private fun encodeAndResolve(session: Session) {
        try {
            val dir = File(session.outputDir)
            if (!dir.exists() && !dir.mkdirs()) {
                session.promise.reject(
                    "EXPOSURE_BURST_ENCODE_FAILED",
                    "captureExposureBurst: could not create output dir "
                        + session.outputDir,
                )
                return
            }
            val paths = Arguments.createArray()
            val timestamps = Arguments.createArray()
            var width = 0
            var height = 0
            session.collected.forEachIndexed { i, packed ->
                val path = File(dir, "frame-$i.jpg").absolutePath
                // ROTATION_90 → EXIF NORMAL (see class docs): pixels stay
                // sensor-native and carry no effective orientation tag.
                // maxLongEdge = 0 disables the encoder's 640 px keyframe
                // clamp — the burst contract is source resolution.
                val encoded = YuvImageConverter.encodeJpegFromNV21(
                    packed,
                    path,
                    jpegQuality = session.quality,
                    displayRotation = Surface.ROTATION_90,
                    maxLongEdge = 0,
                )
                    ?: throw IllegalStateException("encodeJpegFromNV21 failed for $path")
                paths.pushString(encoded)
                timestamps.pushDouble(session.timestampsNs[i].toDouble())
                width = packed.width
                height = packed.height
            }
            val result = Arguments.createMap().apply {
                putArray("frames", paths)
                putInt("width", width)
                putInt("height", height)
                putDouble("exposureDurationMs", session.appliedExposureMs)
                putDouble("iso", session.appliedIso.toDouble())
                putArray("timestampsNs", timestamps)
            }
            session.promise.resolve(result)
        } catch (t: Throwable) {
            session.promise.reject(
                "EXPOSURE_BURST_ENCODE_FAILED",
                "captureExposureBurst: JPEG encode/write failed: ${t.message}",
                t,
            )
        }
    }
}


@androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
class ExposureBurstModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RNISExposureBurst"

    private val timeoutHandler = Handler(Looper.getMainLooper())

    @ReactMethod
    fun capture(options: ReadableMap?, promise: Promise) {
        val viewTag = readInt(options, "viewTag", -1)
        val outputDir = options?.getString("outputDir")
        if (viewTag < 0 || outputDir.isNullOrEmpty()) {
            promise.reject(
                "EXPOSURE_BURST_BAD_ARGS",
                "captureExposureBurst: `viewTag` and `outputDir` are required.",
            )
            return
        }
        val frameCount = readInt(options, "frameCount", 3).coerceIn(1, 10)
        val exposureMs = readDouble(options, "exposureDurationMs", 2.0)
            .coerceIn(0.05, 100.0)
        val isoOption = readInt(options, "iso", -1)
        val quality = readInt(options, "quality", 85).coerceIn(1, 100)
        val timeoutMs = readDouble(options, "timeoutMs", 5000.0)
            .coerceIn(500.0, 30_000.0)
        val cleanDir = if (outputDir.startsWith("file://")) {
            outputDir.substring(7)
        } else {
            outputDir
        }

        // View resolution must happen on the UI thread (same constraint
        // vision-camera's own CameraViewModule works under).
        reactApplicationContext.runOnUiQueueThread {
            beginOnUiThread(
                viewTag, cleanDir, frameCount, exposureMs, isoOption,
                quality, timeoutMs, promise,
            )
        }
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun beginOnUiThread(
        viewTag: Int,
        outputDir: String,
        frameCount: Int,
        exposureMs: Double,
        isoOption: Int,
        quality: Int,
        timeoutMs: Double,
        promise: Promise,
    ) {
        // ── vision-camera view → CameraX Camera (one reflection hop) ──
        val cameraView = try {
            // Fabric view tags are even, Paper's odd — mirror of
            // vision-camera's own findCameraView.
            val type = if (viewTag % 2 == 0) UIManagerType.FABRIC else UIManagerType.DEFAULT
            UIManagerHelper.getUIManager(reactApplicationContext, type)
                ?.resolveView(viewTag) as? CameraView
        } catch (t: Throwable) {
            null
        }
        if (cameraView == null) {
            promise.reject(
                "EXPOSURE_BURST_VIEW_NOT_FOUND",
                "captureExposureBurst: no vision-camera CameraView for react "
                    + "tag $viewTag (is the non-AR preview mounted?).",
            )
            return
        }

        val camera: Camera? = try {
            val sessionField = CameraView::class.java.getDeclaredField("cameraSession")
            sessionField.isAccessible = true
            val cameraSession = sessionField.get(cameraView)
            val cameraField = cameraSession?.javaClass?.getDeclaredField("camera")
            cameraField?.isAccessible = true
            cameraField?.get(cameraSession) as? Camera
        } catch (t: Throwable) {
            Log.w(
                "RNISExposureBurst",
                "vision-camera internals not reachable (${t.javaClass.simpleName}: "
                    + "${t.message}) — captureExposureBurst requires "
                    + "react-native-vision-camera ~4.7 (CameraView.cameraSession / "
                    + "CameraSession.camera fields).",
            )
            null
        }
        if (camera == null) {
            promise.reject(
                "EXPOSURE_BURST_SESSION_UNAVAILABLE",
                "captureExposureBurst: vision-camera's CameraX Camera is not "
                    + "reachable (camera not bound yet, or an unsupported "
                    + "vision-camera version — needs ~4.7).",
            )
            return
        }

        // ── Capability + clamping (public interop) ────────────────────
        val info = Camera2CameraInfo.from(camera.cameraInfo)
        val aeModes: IntArray? =
            info.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES)
        if (aeModes == null || !aeModes.contains(CameraMetadata.CONTROL_AE_MODE_OFF)) {
            promise.reject(
                "EXPOSURE_BURST_UNSUPPORTED",
                "captureExposureBurst: this camera does not support manual "
                    + "exposure (CONTROL_AE_MODE_OFF unavailable — common on "
                    + "devices without the MANUAL_SENSOR capability).",
            )
            return
        }
        val exposureRange: Range<Long>? =
            info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
        val isoRange: Range<Int>? =
            info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
        val requestedNs = (exposureMs * 1_000_000.0).toLong()
        val exposureNs = exposureRange?.clamp(requestedNs) ?: requestedNs
        // No live AE actuals are observable through the interop, so the
        // default ISO is a fixed 800 (clamped) — bright enough to keep
        // banding contrast at 2 ms indoors without blowing highlights.
        // Callers with scene knowledge pass `iso` explicitly.
        val requestedIso = if (isoOption > 0) isoOption else 800
        val iso = isoRange?.clamp(requestedIso) ?: requestedIso

        val control = try {
            Camera2CameraControl.from(camera.cameraControl)
        } catch (t: Throwable) {
            promise.reject(
                "EXPOSURE_BURST_SESSION_UNAVAILABLE",
                "captureExposureBurst: Camera2CameraControl.from failed: "
                    + t.message,
                t,
            )
            return
        }

        val session = ExposureBurstCoordinator.Session(
            frameCount = frameCount,
            quality = quality,
            outputDir = outputDir,
            appliedExposureMs = exposureNs / 1_000_000.0,
            appliedIso = iso,
            control = control,
            promise = promise,
        )
        if (!ExposureBurstCoordinator.arm(session)) {
            promise.reject(
                "EXPOSURE_BURST_IN_FLIGHT",
                "captureExposureBurst: a burst is already in flight.",
            )
            return
        }

        // ── Apply manual exposure to the live repeating request ───────
        val opts = CaptureRequestOptions.Builder()
            .setCaptureRequestOption(
                CaptureRequest.CONTROL_AE_MODE,
                CameraMetadata.CONTROL_AE_MODE_OFF,
            )
            .setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, exposureNs)
            .setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, iso)
            .build()
        val future = control.setCaptureRequestOptions(opts)
        future.addListener({
            try {
                future.get()
                ExposureBurstCoordinator.onExposureApplied(session)
            } catch (t: Throwable) {
                ExposureBurstCoordinator.abort(
                    session,
                    "EXPOSURE_BURST_APPLY_FAILED",
                    "captureExposureBurst: applying manual exposure failed "
                        + "(camera closed / rebinding?): ${t.message}",
                    t,
                )
            }
        }, ContextCompatMainExecutor)

        timeoutHandler.postDelayed(
            { ExposureBurstCoordinator.timeout(session) },
            timeoutMs.toLong(),
        )
    }

    private fun readInt(map: ReadableMap?, key: String, fallback: Int): Int {
        if (map == null || !map.hasKey(key) || map.isNull(key)) return fallback
        return try {
            map.getDouble(key).toInt()
        } catch (t: Throwable) {
            fallback
        }
    }

    private fun readDouble(map: ReadableMap?, key: String, fallback: Double): Double {
        if (map == null || !map.hasKey(key) || map.isNull(key)) return fallback
        return try {
            map.getDouble(key)
        } catch (t: Throwable) {
            fallback
        }
    }

    private companion object {
        /** Main-thread executor for the interop future listener. */
        val ContextCompatMainExecutor = Executor { r ->
            Handler(Looper.getMainLooper()).post(r)
        }
    }
}
