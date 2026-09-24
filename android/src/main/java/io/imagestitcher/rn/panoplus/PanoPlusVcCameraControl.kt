// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.os.Build
import android.util.Log
import androidx.camera.camera2.internal.Camera2CameraCaptureResult
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.internal.CameraCaptureResultImageInfo
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.react.CameraView

/**
 * M4 — the vision-camera arm's reach into the camera vision-camera opened.
 *
 * Two jobs, both FAIL-CLOSED:
 *
 *  1. [metaOf] — the frame's own `CaptureResult`. CameraX's ImageAnalysis
 *     pairs each image with the result it came from, so the frame carries it
 *     (`CameraCaptureResultImageInfo` → `Camera2CameraCaptureResult`). No
 *     listener, no timestamp join. Null when the pairing is absent.
 *  2. [lock] / [unlock] — AE/AWB lock, OIS and video stabilisation off, and
 *     focus frozen at its current distance, through CameraX's PUBLIC interop
 *     (`Camera2CameraControl.addCaptureRequestOptions`) on vision-camera's own
 *     camera. The one non-public step is reaching that camera: CameraView's
 *     `cameraSession` and CameraSession's `camera` are Kotlin `internal`, so
 *     they are read by field name. A renamed field is "unavailable", never a
 *     crash, and the pack says which link broke.
 *
 * ⚠ UNLOCK IS NOT OPTIONAL. Interop request options live on the camera's
 * control for as long as the camera does — across rebinds and JS reloads — so
 * a lock left behind would pin the exposure of every photo and keyframe
 * capture that follows. The recorder unlocks at stop, cancel and every
 * teardown, and the module on invalidate.
 *
 * vision-camera 4.x only (the peer range is pinned below 5).
 */
@OptIn(ExperimentalCamera2Interop::class)
internal object PanoPlusVcCameraControl : PanoPlusVcCameraLock {
    private const val TAG = "RNSSweep.vcLock"

    @Volatile private var locked: Camera2CameraControl? = null
    override val isLocked: Boolean get() = locked != null

    /** The frame's CaptureResult, projected; null when CameraX did not pair one. */
    fun metaOf(frame: Frame): PanoPlusVcFrameMeta? = try {
        val info = frame.imageProxy.imageInfo
        val ccr = (info as? CameraCaptureResultImageInfo)?.cameraCaptureResult
        val cr = (ccr as? Camera2CameraCaptureResult)?.captureResult
        if (cr == null) null else PanoPlusVcFrameMeta(
            exposureTimeNs = cr.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: 0L,
            iso = cr.get(CaptureResult.SENSOR_SENSITIVITY) ?: 0,
            aeLock = cr.get(CaptureResult.CONTROL_AE_LOCK),
            awbLock = cr.get(CaptureResult.CONTROL_AWB_LOCK),
            aeState = cr.get(CaptureResult.CONTROL_AE_STATE),
            afMode = cr.get(CaptureResult.CONTROL_AF_MODE),
            focusDistance = cr.get(CaptureResult.LENS_FOCUS_DISTANCE),
            oisMode = cr.get(CaptureResult.LENS_OPTICAL_STABILIZATION_MODE),
            videoStabMode = cr.get(CaptureResult.CONTROL_VIDEO_STABILIZATION_MODE),
            cropRegion = cr.get(CaptureResult.SCALER_CROP_REGION),
            zoomRatio = if (Build.VERSION.SDK_INT >= 30) cr.get(CaptureResult.CONTROL_ZOOM_RATIO) else null,
            activePhysicalId = if (Build.VERSION.SDK_INT >= 29) {
                cr.get(CaptureResult.LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID)
            } else null,
        )
    } catch (_: Throwable) {
        null
    }

    private fun field(obj: Any, name: String): Any? {
        var cls: Class<*>? = obj.javaClass
        while (cls != null) {
            try {
                val f = cls.getDeclaredField(name)
                f.isAccessible = true
                return f.get(obj)
            } catch (_: NoSuchFieldException) {
                cls = cls.superclass
            }
        }
        return null
    }

    override fun lock(
        ctx: android.content.Context,
        viewTag: Int,
        focusDistance: Float?,
        onResult: (state: String, detail: String) -> Unit,
    ) {
        UiThreadUtil.runOnUiThread {
            val (state, detail) = try {
                applyLock(ctx, viewTag, focusDistance)
            } catch (t: Throwable) {
                "unavailable" to "threw ${t.javaClass.simpleName}: ${t.message}"
            }
            if (state != "requested") Log.w(TAG, "lock $state: $detail")
            onResult(state, detail)
        }
    }

    private fun applyLock(context: android.content.Context, viewTag: Int, focusDistance: Float?): Pair<String, String> {
        if (viewTag <= 0) return "unavailable" to "no vision-camera view tag in the start bag"
        val ctx = context as? ReactContext
            ?: return "unavailable" to "the recorder's context is not a ReactContext"
        val view = UIManagerHelper.getUIManager(ctx, viewTag)?.resolveView(viewTag) as? CameraView
            ?: return "unavailable" to "view tag $viewTag did not resolve to a vision-camera CameraView"
        val session = field(view, "cameraSession")
            ?: return "unavailable" to "CameraView.cameraSession not found (vision-camera internals moved)"
        val camera = field(session, "camera") as? Camera
            ?: return "unavailable" to "CameraSession.camera not found or not bound yet"
        val c2 = Camera2CameraControl.from(camera.cameraControl)
        val chars = try {
            Camera2CameraInfo.from(camera.cameraInfo).let { info ->
                Triple(
                    info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION),
                    info.getCameraCharacteristic(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES),
                    info.getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES),
                )
            }
        } catch (_: Throwable) { Triple(null, null, null) }
        val b = CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, true)
            .setCaptureRequestOption(CaptureRequest.CONTROL_AWB_LOCK, true)
        val applied = mutableListOf("AE_LOCK", "AWB_LOCK")
        if (chars.first?.contains(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF) == true) {
            b.setCaptureRequestOption(
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF,
            )
            applied += "OIS_OFF"
        }
        if (chars.second?.contains(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF) == true) {
            b.setCaptureRequestOption(
                CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF,
            )
            applied += "EIS_OFF"
        }
        val manual = chars.third?.contains(
            CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR,
        ) == true
        if (manual && focusDistance != null && focusDistance.isFinite() && focusDistance >= 0f) {
            b.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
            b.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, focusDistance)
            applied += "AF_OFF@$focusDistance"
        }
        c2.addCaptureRequestOptions(b.build())
        locked = c2
        return "requested" to applied.joinToString(",")
    }

    override fun unlock(): String {
        val c = locked ?: return "none-held"
        locked = null
        return try {
            c.clearCaptureRequestOptions()
            "cleared"
        } catch (t: Throwable) {
            Log.w(TAG, "clearing the lock threw", t)
            "clear-threw ${t.javaClass.simpleName}"
        }
    }
}
