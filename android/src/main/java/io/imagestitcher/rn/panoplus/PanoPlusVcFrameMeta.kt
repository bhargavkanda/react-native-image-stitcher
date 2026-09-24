// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import android.graphics.Rect
import android.content.Context

/**
 * What a vision-camera frame's own `CaptureResult` says about it (M4).
 *
 * ⚠ WHY THIS EXISTS. The vision-camera arm used to run with NO capture
 * metadata: the engine's exposure normalisation was fed zeros (the gain
 * chain's `expGain` read identically 1.000 on 93% of packs), the intrinsics
 * assumed the default crop, and there was no way to tell whether an exposure
 * lock held. CameraX's ImageAnalysis pairs every image with the
 * `CaptureResult` it came from (its metadata image reader), so the frame
 * itself carries all of it — read in PanoPlusVcCameraControl.metaOf, which
 * FAILS CLOSED (null) when the pairing is absent.
 *
 * Vision-camera-independent on purpose, so the always-compiled recorder can
 * hold it on a build without vision-camera.
 */
internal data class PanoPlusVcFrameMeta(
    /** SENSOR_EXPOSURE_TIME, ns; 0 when the result did not carry it. */
    val exposureTimeNs: Long,
    /** SENSOR_SENSITIVITY (ISO); 0 when absent. */
    val iso: Int,
    /** CONTROL_AE_LOCK as the result reports it — the lock READ-BACK. */
    val aeLock: Boolean?,
    val awbLock: Boolean?,
    val aeState: Int?,
    val afMode: Int?,
    /** LENS_FOCUS_DISTANCE, diopters — what a focus lock pins. */
    val focusDistance: Float?,
    val oisMode: Int?,
    val videoStabMode: Int?,
    /** SCALER_CROP_REGION — the region of the ACTIVE array this frame shows. */
    val cropRegion: Rect?,
    /** CONTROL_ZOOM_RATIO (API 30+). */
    val zoomRatio: Float?,
    /** LOGICAL_MULTI_CAMERA_ACTIVE_PHYSICAL_ID (API 29+): which lens it came from. */
    val activePhysicalId: String?,
)

/**
 * The AE/AWB lock, OIS/EIS off and a frozen focus on the camera
 * VISION-CAMERA opened — the set the Camera2 arm asserts on its own repeating
 * request, which a sweep on vision-camera's camera used to go without.
 *
 * Implemented in PanoPlusVcCameraControl (vision-camera-only sources) and
 * reached through [PanoPlusVcBridge], so this package still builds without
 * vision-camera.
 */
internal interface PanoPlusVcCameraLock {
    /**
     * Resolve vision-camera's CameraX camera behind [viewTag] and apply the
     * lock. Asynchronous (the view is resolved on the UI thread); [onResult]
     * receives `state` ("requested" or "unavailable") and a detail string.
     * FAILS CLOSED: any missing link is "unavailable", never a guess.
     */
    fun lock(
        ctx: Context,
        viewTag: Int,
        focusDistance: Float?,
        onResult: (state: String, detail: String) -> Unit,
    )

    /** Clear everything [lock] applied. Idempotent; safe from any thread. */
    fun unlock(): String

    /** A lock this process applied and has not cleared. */
    val isLocked: Boolean
}

/** The vision-camera-only half registers itself here at plugin registration. */
internal object PanoPlusVcBridge {
    @Volatile var cameraLock: PanoPlusVcCameraLock? = null
}
