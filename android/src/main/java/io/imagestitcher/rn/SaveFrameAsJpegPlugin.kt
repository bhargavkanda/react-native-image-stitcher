// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.graphics.ImageFormat
import android.media.Image
import android.util.Log
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.VisionCameraProxy
import io.imagestitcher.rn.ar.YuvImageConverter

/**
 * v0.9.0 Layer 1 — Android vc Frame Processor plugin that JPEG-
 * encodes the supplied frame to a host-supplied path.  Mirror of
 * iOS' `SaveFrameAsJpegPlugin.mm`.
 *
 * Plugin name (must match iOS): `save_frame_as_jpeg`.
 *
 * ## Wrapping the existing encoder
 *
 * The lib already encodes JPEGs from NV21 bytes via
 * `YuvImageConverter.encodeJpegFromNV21` — that's the path
 * `RNSARCameraView.kt`'s keyframe-accept callback uses (line 589,
 * `onAccept = { targetPath -> ... encodeJpegFromNV21(...) }`).
 * This plugin reuses that exact encoder so:
 *   - JPEG output is byte-equivalent to the keyframe-accept output
 *     (same encoder, same quality knob)
 *   - No new encoder maintenance burden
 *
 * vision-camera's `Frame.image` is an `android.media.Image` in
 * `YUV_420_888` format (the camera's native).  We pass it through
 * `YuvImageConverter.packNV21(image)` to extract the dense NV21
 * byte array + dims, then `encodeJpegFromNV21(packed, file, q, rot)`
 * does the JPEG write.
 *
 * ## Plugin contract (matches iOS surface exactly)
 *
 * Arguments dict:
 *   - `path` (string, REQUIRED): absolute output path.
 *   - `quality` (number, optional): 0-100 JPEG quality.  Default 75.
 *     Clamped to [1, 100].
 *
 * Returns:
 *   - On success: `{ "ok" => true, "path" => ..., "width" => ...,
 *                    "height" => ... }`
 *   - On failure: `{ "ok" => false, "error" => "..." }`
 *
 * Errors surfaced via the result map (not thrown) — host worklets
 * can branch on `result.ok` without try/catch.  Same convention
 * as iOS.
 *
 * ## Lifetime / threading
 *
 * The supplied `Frame` (and its `Image`) is valid only for the
 * duration of this callback — vision-camera closes the underlying
 * `Image` on return.  All Image access (NV21 pack + JPEG encode)
 * happens synchronously inside `callback()`.
 *
 * ## Format restriction
 *
 * Only `YUV_420_888` input is supported (vc Android's standard).
 * Anything else returns `{ ok: false, error: "unsupported format" }`.
 * No format conversion fallback — that would mask bugs in the host
 * camera config.
 *
 * ## Registration
 *
 * Registered in `RNImageStitcherPackage.kt`'s companion-object
 * `ensureFrameProcessorPluginRegistered()`, alongside
 * `cv_flow_gate_process_frame`.  Same defensive
 * NoClassDefFoundError handling — if vc isn't on the host's
 * classpath, registration is silently skipped (and the plugin's
 * `init { … }` calls below never happen).
 */
@DoNotStrip
@Keep
class SaveFrameAsJpegPlugin(
    @Suppress("UNUSED_PARAMETER") proxy: VisionCameraProxy,
    @Suppress("UNUSED_PARAMETER") options: Map<String, Any>?,
) : FrameProcessorPlugin() {

    override fun callback(frame: Frame, params: Map<String, Any>?): Any {
        val path = params?.get("path") as? String
            ?: return mapOf(
                "ok" to false,
                "error" to "missing required `path` argument",
            )
        val rawQuality = (params["quality"] as? Number)?.toInt() ?: 75
        val quality = rawQuality.coerceIn(1, 100)

        // Frame may throw if vc already released it.
        val image: Image = try {
            frame.image
        } catch (e: Throwable) {
            return mapOf(
                "ok" to false,
                "error" to "frame invalid: ${e.message}",
            )
        }

        if (image.format != ImageFormat.YUV_420_888) {
            return mapOf(
                "ok" to false,
                "error" to "unsupported format ${image.format} (need YUV_420_888)",
            )
        }

        // Pack NV21 — same call site RNSARCameraView uses.
        val packed = YuvImageConverter.packNV21(image)
            ?: return mapOf(
                "ok" to false,
                "error" to "YuvImageConverter.packNV21 returned null",
            )

        // Reuse the lib's existing JPEG encoder.  Rotation is 0 here
        // (the host's frame is in camera-native orientation; if they
        // want display orientation they can pass an `orientation`
        // arg in a future version — for v0.9.0 the worklet emits
        // raw-camera-oriented JPEGs, matching the keyframe-accept
        // pipeline's behaviour).
        //
        // Signature: `encodeJpegFromNV21(packed, outputPath: String,
        // jpegQuality: Int, displayRotation: Int): String?` — returns
        // the written path on success, null on failure.
        val encodedPath: String? = try {
            YuvImageConverter.encodeJpegFromNV21(
                packed,
                path,
                jpegQuality = quality,
                displayRotation = 0,
            )
        } catch (e: Throwable) {
            return mapOf(
                "ok" to false,
                "error" to "encodeJpegFromNV21 threw: ${e.message}",
            )
        }
        if (encodedPath == null) {
            return mapOf(
                "ok" to false,
                "error" to "encodeJpegFromNV21 returned null",
            )
        }

        return mapOf(
            "ok" to true,
            "path" to encodedPath,
            "width" to packed.width,
            "height" to packed.height,
        )
    }

    companion object {
        private const val TAG = "SaveFrameAsJpegPlugin"

        /// Plugin name; MUST match iOS + the JS-side
        /// `initFrameProcessorPlugin('save_frame_as_jpeg')` call.
        const val PLUGIN_NAME = "save_frame_as_jpeg"
    }
}
