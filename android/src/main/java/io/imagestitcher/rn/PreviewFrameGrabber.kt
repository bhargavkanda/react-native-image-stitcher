// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.graphics.ImageFormat
import android.media.Image
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.VisionCameraProxy
import io.imagestitcher.rn.ar.YuvImageConverter
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * v0.22.0 — preview-frame grab primitive (torch-differential probe v3).
 *
 * Grabs the NEXT vision-camera preview frame on demand and JPEG-encodes
 * it to the app cache dir, resolving a JS promise with the file path.
 * Unlike `save_frame_as_jpeg` (host-worklet-driven, path supplied per
 * call from the worklet), this is JS-PROMISE-driven: JS arms a one-shot
 * request via `NativeModules.RNISPreviewFrameGrabber.grab(...)`, and the
 * `grab_preview_frame` Frame Processor plugin — attached by `<Camera>`
 * only while a torch-pair capture is in flight — services it on the
 * next frame the producer thread delivers.
 *
 * Why this shape: `captureTorchPair()` needs two preview frames a few
 * hundred ms apart across a torch flip, with NO still-capture pipeline
 * (auto-exposure partially compensates in the ~1 s a still pair takes,
 * killing the differential).  A dumb always-call worklet + native
 * one-shot arming keeps the worklet capture-free (it closes over only
 * the plugin handle) and gives JS real promise semantics with a native
 * timeout — no shared values, no runOnJS.
 *
 * ## Contract
 *
 * `grab(options)`:
 *   - `maxLongEdge` (number, default 1280): long-edge downscale budget
 *     for the SAVED JPEG.  `0` disables (source resolution).
 *   - `quality` (number, default 80): JPEG quality, clamped [1, 100].
 *   - `timeoutMs` (number, default 2000, clamped [100, 10000]): reject
 *     window if no frame arrives (frame processor not attached, camera
 *     inactive, AR mode…).
 *
 * Resolves `{ path, width, height }` — width/height are the SOURCE
 * video-stream dimensions (pre-downscale), matching
 * `save_frame_as_jpeg`'s convention.
 *
 * Reject codes: `E_GRAB_BUSY` (a grab is already armed — the JS layer
 * serialises, so this is defensive), `E_GRAB_TIMEOUT`,
 * `E_GRAB_ENCODE_FAILED`.
 *
 * ## Single-slot coordinator
 *
 * One armed request at a time, owned by whoever atomically removes it
 * from the slot: the plugin's `take()` (services it) or the timeout's
 * `cancelIfCurrent()` (rejects it).  `AtomicReference` CAS makes the
 * take/timeout race settle each promise exactly once.
 *
 * ## Orientation
 *
 * Frames are written sensor-oriented with the same
 * `displayRotation = ROTATION_0` EXIF convention as
 * `save_frame_as_jpeg` / the keyframe pipeline.  The torch-pair scorer
 * compares the two frames to EACH OTHER (256×256 aligned grids), so
 * only mutual alignment matters — and both frames of a pair share one
 * camera orientation by construction.
 *
 * ## Registration
 *
 * Module: `RNImageStitcherPackage.createNativeModules`.  Plugin:
 * `ensureFrameProcessorPluginRegistered()`, same defensive
 * NoClassDefFoundError posture as the other two vc plugins.
 */
internal object PreviewFrameGrabCoordinator {

    /** One armed grab.  Immutable; settled exactly once by its owner. */
    class Request(
        val maxLongEdge: Int,
        val quality: Int,
        val outputPath: String,
        val promise: Promise,
    )

    private val slot = AtomicReference<Request?>(null)

    /** Arm `request`.  False when another grab is already armed. */
    fun arm(request: Request): Boolean = slot.compareAndSet(null, request)

    /** Remove + return the armed request (the caller now OWNS settling it). */
    fun take(): Request? = slot.getAndSet(null)

    /**
     * Timeout path: remove `request` only if it is still the armed one.
     * False means the plugin already took it (or a newer grab replaced
     * it) — the caller must NOT settle the promise.
     */
    fun cancelIfCurrent(request: Request): Boolean =
        slot.compareAndSet(request, null)
}


class PreviewFrameGrabber(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RNISPreviewFrameGrabber"

    // Main-looper handler purely for the timeout timer (fires rarely;
    // the encode itself never runs here).
    private val timeoutHandler = Handler(Looper.getMainLooper())

    // De-collides output filenames when two grabs land in the same ms
    // (off/on pairs are ~250 ms apart, but don't rely on it).
    private val fileSeq = AtomicInteger(0)

    @ReactMethod
    fun grab(options: ReadableMap?, promise: Promise) {
        val maxLongEdge = readInt(options, "maxLongEdge", 1280)
            .coerceIn(0, 8192)
        val quality = readInt(options, "quality", 80).coerceIn(1, 100)
        val timeoutMs = readInt(options, "timeoutMs", 2000)
            .coerceIn(100, 10_000)

        val outputPath = File(
            reactApplicationContext.cacheDir,
            "rnis-torchpair-${System.currentTimeMillis()}"
                + "-${fileSeq.incrementAndGet()}.jpg",
        ).absolutePath

        val request = PreviewFrameGrabCoordinator.Request(
            maxLongEdge = maxLongEdge,
            quality = quality,
            outputPath = outputPath,
            promise = promise,
        )
        if (!PreviewFrameGrabCoordinator.arm(request)) {
            promise.reject(
                "E_GRAB_BUSY",
                "a preview-frame grab is already armed — grabs must be "
                    + "serialised by the caller",
            )
            return
        }
        // No removeCallbacks bookkeeping: if the plugin serviced the
        // request first, cancelIfCurrent() fails the CAS and this
        // runnable is a no-op.  It holds the request for ≤ timeoutMs.
        timeoutHandler.postDelayed({
            if (PreviewFrameGrabCoordinator.cancelIfCurrent(request)) {
                promise.reject(
                    "E_GRAB_TIMEOUT",
                    "no preview frame arrived within ${timeoutMs} ms — is "
                        + "the camera active and the grab frame processor "
                        + "attached (non-AR mode only)?",
                )
            }
        }, timeoutMs.toLong())
    }

    private fun readInt(map: ReadableMap?, key: String, fallback: Int): Int {
        if (map == null || !map.hasKey(key) || map.isNull(key)) return fallback
        // JS numbers arrive as doubles; getInt throws on non-integral.
        return try {
            map.getDouble(key).toInt()
        } catch (e: Throwable) {
            fallback
        }
    }
}


/**
 * The vc Frame Processor plugin half of the grab primitive.  Called by
 * `<Camera>`'s internal grab worklet for every producer-thread frame
 * WHILE a torch-pair capture is in flight; a single atomic read makes
 * the idle case (no armed request) effectively free.
 *
 * All Image access is synchronous inside `callback()` — vision-camera
 * closes the underlying `Image` on return (same lifetime rule as
 * `SaveFrameAsJpegPlugin`).  The ~10-60 ms encode briefly blocks the
 * frame-processor thread; vc drops intervening frames, the preview is
 * unaffected, and a torch pair only ever encodes two frames.
 */
@DoNotStrip
@Keep
class PreviewFrameGrabPlugin(
    @Suppress("UNUSED_PARAMETER") proxy: VisionCameraProxy,
    @Suppress("UNUSED_PARAMETER") options: Map<String, Any>?,
) : FrameProcessorPlugin() {

    override fun callback(frame: Frame, params: Map<String, Any>?): Any? {
        // Owner semantics: take() removes the request, so the timeout
        // can no longer reject it — this plugin MUST settle it below.
        val request = PreviewFrameGrabCoordinator.take() ?: return null

        try {
            val image: Image = try {
                frame.image
            } catch (e: Throwable) {
                request.promise.reject(
                    "E_GRAB_ENCODE_FAILED",
                    "frame invalid: ${e.message}",
                )
                return null
            }

            if (image.format != ImageFormat.YUV_420_888) {
                request.promise.reject(
                    "E_GRAB_ENCODE_FAILED",
                    "unsupported pixel format ${image.format} (need "
                        + "YUV_420_888 — leave the camera at "
                        + "pixelFormat=\"yuv\")",
                )
                return null
            }

            val packed = YuvImageConverter.packNV21(image)
            if (packed == null) {
                request.promise.reject(
                    "E_GRAB_ENCODE_FAILED",
                    "YuvImageConverter.packNV21 returned null",
                )
                return null
            }

            val encodedPath = YuvImageConverter.encodeJpegFromNV21(
                packed,
                request.outputPath,
                jpegQuality = request.quality,
                displayRotation = Surface.ROTATION_0,
                maxLongEdge = request.maxLongEdge,
            )
            if (encodedPath == null) {
                request.promise.reject(
                    "E_GRAB_ENCODE_FAILED",
                    "encodeJpegFromNV21 failed for ${request.outputPath}",
                )
                return null
            }

            val result = Arguments.createMap().apply {
                putString("path", encodedPath)
                putInt("width", packed.width)
                putInt("height", packed.height)
            }
            request.promise.resolve(result)
        } catch (t: Throwable) {
            // The request was taken — it MUST settle here, or the JS
            // side would hang until its own outer timeout.
            request.promise.reject(
                "E_GRAB_ENCODE_FAILED",
                "grab_preview_frame threw: ${t.message}",
            )
        }
        return null
    }

    companion object {
        /// Plugin name; MUST match iOS + the JS-side
        /// `initFrameProcessorPlugin('grab_preview_frame')` call.
        const val PLUGIN_NAME = "grab_preview_frame"
    }
}
