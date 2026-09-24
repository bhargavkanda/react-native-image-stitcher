// SPDX-License-Identifier: Apache-2.0
package androidx.camera.camera2.internal

import android.annotation.SuppressLint
import android.hardware.camera2.TotalCaptureResult
import androidx.camera.core.CameraControl
import androidx.camera.core.impl.CameraControlInternal

/**
 * M4(b) — every capture result of the camera vision-camera opened, delivered
 * to one callback. The ONLY source of per-frame metadata on the vision-camera
 * arm: CameraX's ImageAnalysis never pairs a frame with its result (see
 * `PanoPlusVcFrameMeta`), so the sweep joins these to frames by
 * SENSOR_TIMESTAMP.
 *
 * ⚠ IN CAMERAX'S OWN PACKAGE, deliberately and narrowly. The listener hook
 * (`Camera2CameraControlImpl.addCaptureResultListener`) is package-private in
 * CameraX 1.5.0-alpha03 — the version vision-camera 4.7 pins (the peer range
 * is `<5`). The route is `CameraControl` → `CameraControlInternal
 * .getImplementation()` (a public default method, overridden by CameraX's
 * forwarding controls) → `Camera2CameraControlImpl`. Anything else on the way
 * answers `null`, and the caller reports "unavailable" — never a crash.
 *
 * `onCaptureResult` ALWAYS answers false: true tells CameraX to REMOVE the
 * listener. It runs on the camera's executor, so the callback must be cheap.
 *
 * vision-camera-only (CameraX is `compileOnly`): excluded from the build with
 * it — see `vcOnlySources` in android/build.gradle — and kept from R8 renaming
 * by consumer-rules.pro.
 */
@SuppressLint("RestrictedApi")
internal object RNSCaptureResultTap {

    /** An attached listener, for [detach]. Opaque to callers. */
    class Handle internal constructor(
        internal val impl: Camera2CameraControlImpl,
        internal val listener: Camera2CameraControlImpl.CaptureResultListener,
    )

    /** Attach [onResult] to [control]'s camera, or null when unreachable. */
    fun attach(control: CameraControl, onResult: (TotalCaptureResult) -> Unit): Handle? {
        val internal = control as? CameraControlInternal ?: return null
        val impl = internal.implementation as? Camera2CameraControlImpl ?: return null
        val listener = Camera2CameraControlImpl.CaptureResultListener { r ->
            try { onResult(r) } catch (_: Throwable) { }
            false
        }
        impl.addCaptureResultListener(listener)
        return Handle(impl, listener)
    }

    fun detach(handle: Handle) {
        handle.impl.removeCaptureResultListener(handle.listener)
    }
}
