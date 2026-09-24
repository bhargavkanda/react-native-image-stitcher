// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.os.Build
import android.util.Log
import androidx.camera.camera2.internal.RNSCaptureResultTap
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.mrousavy.camera.react.CameraView

/**
 * M4 — the vision-camera arm's reach into the camera vision-camera opened.
 *
 * Two jobs, both FAIL-CLOSED:
 *
 *  1. [attachResults] — every capture result of that camera, through
 *     `RNSCaptureResultTap` (the plan's M4(b) route). The frame itself never
 *     carries one on CameraX 1.5.0-alpha03 — see `PanoPlusVcFrameMeta` — so
 *     the sweep joins these to frames by SENSOR_TIMESTAMP.
 *  2. [lock] / [unlock] — AE/AWB lock, OIS and video stabilisation off, and
 *     focus frozen at its settled distance, through CameraX's PUBLIC interop
 *     (`Camera2CameraControl.addCaptureRequestOptions`) on vision-camera's own
 *     camera. Each option is applied only where the device reports it
 *     available, and the detail names what was skipped.
 *
 * The one non-public step shared by both is reaching that camera: CameraView's
 * `cameraSession` and CameraSession's `camera` are Kotlin `internal`, so they
 * are read by field name (kept from R8 by consumer-rules.pro). A renamed field
 * is "unavailable", never a crash, and the pack says which link broke.
 *
 * ⚠ ORDERED AGAINST TEARDOWN (M4 review). Both are resolved on the UI thread
 * and so land AFTER the call returns. A teardown that ran first used to find
 * nothing to clear, and the lock applied a moment later stayed on the camera
 * for every photo after the sweep. [PanoPlusGenGate] closes that: [unlock] /
 * [detachResults] invalidate every job still waiting to run, under the monitor
 * the job itself runs under.
 *
 * vision-camera 4.x only (the peer range is pinned below 5).
 */
@OptIn(ExperimentalCamera2Interop::class)
internal object PanoPlusVcCameraControl : PanoPlusVcCameraLock {
    private const val TAG = "RNSSweep.vcLock"

    private val lockGate = PanoPlusGenGate()
    private val tapGate = PanoPlusGenGate()
    // ── guarded by the gates' monitors ──
    @Volatile private var locked: Camera2CameraControl? = null
    @Volatile private var tap: RNSCaptureResultTap.Handle? = null

    override val isLocked: Boolean get() = locked != null

    /** A capture result, projected. */
    fun metaOf(cr: CaptureResult): PanoPlusVcFrameMeta = PanoPlusVcFrameMeta(
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
        sensorTimestampNs = cr.get(CaptureResult.SENSOR_TIMESTAMP) ?: 0L,
        afState = cr.get(CaptureResult.CONTROL_AF_STATE),
        awbState = cr.get(CaptureResult.CONTROL_AWB_STATE),
    )

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

    /** vision-camera's CameraX camera behind [viewTag], or why not. UI thread. */
    private fun resolveCamera(context: android.content.Context, viewTag: Int): Pair<Camera?, String> {
        if (viewTag <= 0) return null to "no vision-camera view tag in the start bag"
        val ctx = context as? ReactContext
            ?: return null to "the recorder's context is not a ReactContext"
        val view = UIManagerHelper.getUIManager(ctx, viewTag)?.resolveView(viewTag) as? CameraView
            ?: return null to "view tag $viewTag did not resolve to a vision-camera CameraView"
        val session = field(view, "cameraSession")
            ?: return null to "CameraView.cameraSession not found (vision-camera internals moved)"
        val camera = field(session, "camera") as? Camera
            ?: return null to "CameraSession.camera not found or not bound yet"
        return camera to ""
    }

    override fun attachResults(
        ctx: android.content.Context,
        viewTag: Int,
        onMeta: (PanoPlusVcFrameMeta) -> Unit,
        onResult: (state: String, detail: String) -> Unit,
    ) {
        val ticket = tapGate.ticket()
        UiThreadUtil.runOnUiThread {
            val out = tapGate.runIfCurrent(ticket) {
                try {
                    val (camera, why) = resolveCamera(ctx, viewTag)
                    if (camera == null) {
                        "unavailable" to why
                    } else {
                        tap?.let { RNSCaptureResultTap.detach(it) }
                        val h = RNSCaptureResultTap.attach(camera.cameraControl) { r -> onMeta(metaOf(r)) }
                        tap = h
                        if (h == null) {
                            "unavailable" to "the camera's control is not CameraX's Camera2 implementation"
                        } else {
                            "attached" to "Camera2CameraControlImpl.addCaptureResultListener"
                        }
                    }
                } catch (t: Throwable) {
                    "unavailable" to "threw ${t.javaClass.simpleName}: ${t.message}"
                }
            } ?: ("cancelled" to "detached before the tap was attached")
            if (out.first != "attached") Log.w(TAG, "results ${out.first}: ${out.second}")
            onResult(out.first, out.second)
        }
    }

    override fun detachResults(): String = tapGate.invalidate {
        val h = tap ?: return@invalidate "none-held"
        tap = null
        try {
            RNSCaptureResultTap.detach(h)
            "detached"
        } catch (t: Throwable) {
            Log.w(TAG, "detaching the result tap threw", t)
            "detach-threw ${t.javaClass.simpleName}"
        }
    }

    override fun lock(
        ctx: android.content.Context,
        viewTag: Int,
        focusDistance: Float?,
        onResult: (state: String, detail: String) -> Unit,
    ) {
        val ticket = lockGate.ticket()
        UiThreadUtil.runOnUiThread {
            val out = lockGate.runIfCurrent(ticket) {
                try {
                    applyLock(ctx, viewTag, focusDistance, onResult)
                } catch (t: Throwable) {
                    "unavailable" to "threw ${t.javaClass.simpleName}: ${t.message}"
                }
            } ?: ("cancelled" to "unlocked before the lock ran — nothing was applied")
            if (out.first != "requested") {
                Log.w(TAG, "lock ${out.first}: ${out.second}")
                onResult(out.first, out.second)
            }
        }
    }

    /** Runs under the lock gate's monitor. Answers `requested` when the
     *  options were handed to CameraX; [onResult] then fires once more with
     *  `applied` / `apply-failed` when CameraX reports the outcome. */
    private fun applyLock(
        context: android.content.Context,
        viewTag: Int,
        focusDistance: Float?,
        onResult: (state: String, detail: String) -> Unit,
    ): Pair<String, String> {
        val (camera, why) = resolveCamera(context, viewTag)
        if (camera == null) return "unavailable" to why
        val c2 = Camera2CameraControl.from(camera.cameraControl)
        val info = try { Camera2CameraInfo.from(camera.cameraInfo) } catch (_: Throwable) { null }
        fun <T> ch(key: CameraCharacteristics.Key<T>): T? =
            try { info?.getCameraCharacteristic(key) } catch (_: Throwable) { null }
        val b = CaptureRequestOptions.Builder()
        val applied = mutableListOf<String>()
        val skipped = mutableListOf<String>()
        // ⚠ AVAILABILITY FIRST (M4 review): a LEGACY/LIMITED device with
        // CONTROL_AE_LOCK_AVAILABLE=false ignores the key silently, and the
        // pack used to say it was applied.
        if (ch(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true) {
            b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, true); applied += "AE_LOCK"
        } else skipped += "AE_LOCK(unavailable)"
        if (ch(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) == true) {
            b.setCaptureRequestOption(CaptureRequest.CONTROL_AWB_LOCK, true); applied += "AWB_LOCK"
        } else skipped += "AWB_LOCK(unavailable)"
        if (ch(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)
                ?.contains(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF) == true) {
            b.setCaptureRequestOption(
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF,
            )
            applied += "OIS_OFF"
        } else skipped += "OIS_OFF(unavailable)"
        if (ch(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)
                ?.contains(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF) == true) {
            b.setCaptureRequestOption(
                CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF,
            )
            applied += "EIS_OFF"
        } else skipped += "EIS_OFF(unavailable)"
        val manual = ch(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)?.contains(
            CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR,
        ) == true
        when {
            focusDistance == null -> skipped += "AF_OFF(focus not settled — AF left running)"
            !manual -> skipped += "AF_OFF(no MANUAL_SENSOR)"
            !focusDistance.isFinite() || focusDistance < 0f -> skipped += "AF_OFF(bad distance)"
            else -> {
                b.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
                b.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, focusDistance)
                applied += "AF_OFF@$focusDistance"
            }
        }
        if (applied.isEmpty()) return "unavailable" to "nothing to apply: ${skipped.joinToString(",")}"
        val detail = applied.joinToString(",") +
            (if (skipped.isEmpty()) "" else "; skipped ${skipped.joinToString(",")}")
        val f = c2.addCaptureRequestOptions(b.build())
        locked = c2
        // THE OUTCOME, not the request: CameraX completes this future once
        // the repeating request carrying the options has been issued.
        f.addListener({
            val ok = try { f.get(); true } catch (_: Throwable) { false }
            onResult(if (ok) "applied" else "apply-failed", detail)
        }, { r -> r.run() })
        return "requested" to detail
    }

    override fun unlock(): String = lockGate.invalidate {
        val c = locked ?: return@invalidate "none-held"
        locked = null
        try {
            c.clearCaptureRequestOptions()
            "cleared"
        } catch (t: Throwable) {
            Log.w(TAG, "clearing the lock threw", t)
            "clear-threw ${t.javaClass.simpleName}"
        }
    }
}
