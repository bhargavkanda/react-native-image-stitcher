// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.media.Image
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.VisionCameraProxy

/**
 * F8.4 — Android vision-camera Frame Processor plugin that mirrors
 * iOS' `KeyframeGateFrameProcessor.mm`.
 *
 * Plugin name (must match the iOS plugin):
 *   `cv_flow_gate_process_frame`
 *
 * JS-side usage is identical to iOS — the same `useFrameProcessorDriver`
 * hook + the same `plugin.call(frame, args)` contract.  The JS layer
 * is 100% platform-agnostic.
 *
 * ## What this plugin does
 *
 * Per producer-thread frame:
 *   1. Pull the `android.media.Image` out of vision-camera's `Frame`.
 *   2. Extract pose primitives from the worklet's `params` dict
 *      (defaults safe for non-AR: tx/ty/tz=0, qw=1 identity, fx/fy=0
 *      → engine uses 65°×50° FoV fallback).
 *   3. Call `IncrementalStitcher.consumeFrameFromPlugin(image, …)`
 *      which:
 *        - Drops the call if `frameSourceMode != "frameProcessor"`
 *          (prevents double-feeding the engine alongside the
 *          AR-mode `ingestFromARCameraView` path).
 *        - Otherwise: extracts the Y plane, evaluates the keyframe
 *          gate via `KeyframeGate.evaluateWithFrame`, encodes the
 *          accepted frame to JPEG synchronously, and hands the path
 *          to the existing `ingestFromARCameraView` engine entry.
 *
 * ## Lifetime / threading
 *
 * The `Frame` (and the underlying `Image` / `ImageProxy`) is valid
 * only for the duration of this callback — vision-camera closes it
 * on return.  All Image access (including the JPEG encode on
 * accept) MUST happen synchronously inside `callback()`.
 *
 * ## Divergence vs iOS
 *
 * iOS keeps the `CVPixelBuffer` reachable end-to-end into the
 * stitcher engine (zero-copy).  Android's engine entry point
 * (`ingestFromARCameraView`) takes a Y `ByteArray` + a JPEG file
 * path, so we copy Y bytes here and encode JPEG inline on accept.
 * Cross-platform parity at the engine level is tracked as F8.6.
 *
 * ## Registration
 *
 * Registered in `RNImageStitcherPackage.kt`'s companion-object
 * static initialiser via `FrameProcessorPluginRegistry`.  Vision-
 * camera docs say "should be called as soon as possible — ideally
 * on app start or in a static initialiser"; the package class is
 * loaded by RN autolinking at app startup, so the registration
 * fires before any JS Frame Processor can `initFrameProcessorPlugin`
 * the plugin.
 */
@DoNotStrip
@Keep
class CvFlowGateFrameProcessor(
    proxy: VisionCameraProxy,
    options: Map<String, Any>?,
) : FrameProcessorPlugin() {

    // The `proxy` and `options` are accepted by the
    // `PluginInitializer` contract but the plugin is stateless —
    // all gate tunables live on `IncrementalStitcher` and are
    // configured at its `start()` time from the host-app settings.
    // The plugin is a thin pose-injector.
    //
    // Lint suppressors: we intentionally don't read these.
    @Suppress("unused", "UNUSED_PARAMETER")
    private val unused = proxy to options

    @Suppress("UNCHECKED_CAST")
    override fun callback(frame: Frame, params: Map<String, Any>?): Any? {
        // Frame may throw `FrameInvalidError` if vision-camera has
        // already released it.  Defensive: swallow and return.
        val image: Image = try {
            frame.image
        } catch (e: Throwable) {
            return mapOf("submitted" to false, "error" to "frame invalid")
        }

        val stitcher = IncrementalStitcher.bridgeInstance
        if (stitcher == null) {
            // Module never registered (host hasn't initialised the
            // React bridge yet, or autolinking skipped us).  Drop
            // the call; JS sees `submitted: false` and can detect.
            return mapOf("submitted" to false, "error" to "stitcher not registered")
        }

        // F8.4-Android-c rotation fix: read CameraX's authoritative
        // "rotation needed to display upright" value via
        // `imageProxy.imageInfo.rotationDegrees`.
        //
        // The earlier attempt used `Frame.orientation` (the enum),
        // but vision-camera's `getOrientation()` returns the REVERSE
        // of the rotation-needed value (see Frame.java:88, the
        // "Reverse it" comment).  Trying to invert the enum
        // ourselves was off by 90° on the A35.  The raw
        // `imageInfo.rotationDegrees` is unambiguous.
        //
        // Used by the engine's JPEG encoder to write the correct
        // EXIF Orientation tag so thumbnails (and any other
        // EXIF-honoring viewer) display upright.  The raw cv::Mat
        // the stitcher sees is unaffected — see consumeFrameFromPlugin
        // docstring for the no-double-rotation rationale.
        val sensorRotationDegrees = try {
            frame.imageProxy.imageInfo.rotationDegrees
        } catch (_: Throwable) {
            // FrameInvalidError or null mid-callback — treat as
            // portrait back-camera default (sensor mounted 90° CW).
            90
        }

        stitcher.consumeFrameFromPlugin(
            image = image,
            tx = argDouble(params, "tx", 0.0),
            ty = argDouble(params, "ty", 0.0),
            tz = argDouble(params, "tz", 0.0),
            qx = argDouble(params, "qx", 0.0),
            qy = argDouble(params, "qy", 0.0),
            qz = argDouble(params, "qz", 0.0),
            qw = argDouble(params, "qw", 1.0),
            fx = argDouble(params, "fx", 0.0),
            fy = argDouble(params, "fy", 0.0),
            cx = argDouble(params, "cx", image.width / 2.0),
            cy = argDouble(params, "cy", image.height / 2.0),
            timestampMs = argDouble(params, "timestampMs", 0.0),
            // Default 2 == `.tracking` so the worklet doesn't need
            // to send a tracking-state field on every frame.
            trackingStateRaw = argInt(params, "trackingStateRaw", 2),
            sensorRotationDegrees = sensorRotationDegrees,
        )

        return mapOf("submitted" to true)
    }

    private fun argDouble(args: Map<String, Any>?, key: String, default: Double): Double {
        if (args == null) return default
        val v = args[key] ?: return default
        return when (v) {
            is Number -> v.toDouble()
            else -> default
        }
    }

    private fun argInt(args: Map<String, Any>?, key: String, default: Int): Int {
        if (args == null) return default
        val v = args[key] ?: return default
        return when (v) {
            is Number -> v.toInt()
            else -> default
        }
    }
}
