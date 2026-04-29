// SPDX-License-Identifier: UNLICENSED
package com.retailens.capturesdk

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.imgcodecs.Imgcodecs
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android twin of the iOS RetaiLensStitcher.  Mirrors the JS-facing
 * surface exactly:
 *
 *   stitch({ framePaths, outputPath, quality })
 *     → { outputPath, width, height, durationMs }
 *
 *   stitchVideo({ videoPath, outputPath, maxFrames, quality })
 *     → { outputPath, width, height, durationMs }
 *
 *   normaliseImage({ imagePath })
 *     → { width, height }
 *
 * Algorithm choices match iOS:
 *   - cv::Stitcher::SCANS mode (translational, planar subject — the
 *     shelf-walking gesture) instead of PANORAMA (which assumes
 *     rotational camera).
 *   - 10 evenly-spaced frames as the SCANS-mode sweet spot.
 *   - JPEG quality 85 default; adjustable per call.
 *
 * Frame extraction uses Android's MediaMetadataRetriever — analogous
 * to iOS' AVAssetImageGenerator.  Each call to getFrameAtTime is
 * fast (~30-50 ms) and the API blocks per-frame, so we run the
 * whole pipeline on a background coroutine.
 */
class RetaiLensStitcher(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RetaiLensStitcher"

    // ── Stitch frames → panorama ─────────────────────────────────

    @ReactMethod
    fun stitch(options: ReadableMap, promise: Promise) {
        // OpenCV's prebuilt Android `libopencv_java4.so` doesn't
        // contain `cv::Stitcher::create` symbols (the stitching
        // module is dropped from the binary at OpenCV's build
        // time, not just from Java bindings).  Reject with the
        // SDK's standard "not implemented on this platform" code
        // so the JS side falls through to the host app's
        // panorama-unsupported flow — same as web/older builds.
        promise.reject(
            "STITCH_NOT_IMPLEMENTED",
            "stitchFrames is not yet implemented on Android.  OpenCV's "
                + "prebuilt Android distribution drops the stitching "
                + "module; enabling it requires building OpenCV from "
                + "source with BUILD_opencv_stitching=ON.  See the SDK's "
                + "android/build.gradle comment for next steps.",
        )
    }

    // ── Stitch video → panorama (extract + stitch + cleanup) ─────

    @ReactMethod
    fun stitchVideo(options: ReadableMap, promise: Promise) {
        promise.reject(
            "STITCH_NOT_IMPLEMENTED",
            "stitchVideo is not yet implemented on Android.  Reason: "
                + "OpenCV's prebuilt Android library doesn't include "
                + "cv::Stitcher.  See android/build.gradle for the path "
                + "to a custom OpenCV build that re-enables stitching.",
        )
    }

    // ── Normalise photo orientation (bake EXIF into pixels) ──────

    @ReactMethod
    fun normaliseImage(options: ReadableMap, promise: Promise) {
        val imagePath = options.getString("imagePath")
            ?: return promise.reject("invalid-options", "imagePath required")

        CoroutineScope(Dispatchers.Default).launch {
            try {
                ensureOpenCv()
                val cleaned = stripFileScheme(imagePath)
                if (!File(cleaned).exists()) {
                    promise.reject("read-failed", "Image not found: $imagePath")
                    return@launch
                }
                // First rotate the source on the Java side using
                // ExifInterface — Android's cv::imread, unlike iOS',
                // doesn't auto-honour EXIF.  We re-write a rotated
                // intermediate to disk THEN call the JNI normalise
                // (which re-reads + re-writes via cv::imread/imwrite,
                // stripping EXIF metadata for good measure).
                val img = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
                if (img.empty()) {
                    promise.reject("read-failed", "Could not decode $imagePath")
                    return@launch
                }
                val rotated = applyExifOrientation(cleaned, img)
                val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, 92)
                if (!Imgcodecs.imwrite(cleaned, rotated, params)) {
                    promise.reject("write-failed", "Could not rewrite $imagePath")
                    return@launch
                }
                promise.resolve(WritableNativeMap().apply {
                    putInt("width", rotated.cols())
                    putInt("height", rotated.rows())
                })
                img.release()
                if (rotated !== img) rotated.release()
            } catch (t: Throwable) {
                promise.reject("normalise-failed", t.message, t)
            }
        }
    }

    // ── Internals ────────────────────────────────────────────────

    /**
     * Read EXIF orientation tag and rotate the Mat accordingly.
     * The original Mat is released and replaced if rotation was
     * needed — caller can compare references to know if a fresh
     * Mat was returned.
     */
    private fun applyExifOrientation(path: String, src: Mat): Mat {
        val exif = androidx.exifinterface.media.ExifInterface(path)
        val orientation = exif.getAttributeInt(
            androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
            androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL,
        )
        val rotated = Mat()
        when (orientation) {
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> {
                org.opencv.core.Core.rotate(src, rotated, org.opencv.core.Core.ROTATE_90_CLOCKWISE)
            }
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> {
                org.opencv.core.Core.rotate(src, rotated, org.opencv.core.Core.ROTATE_180)
            }
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> {
                org.opencv.core.Core.rotate(src, rotated, org.opencv.core.Core.ROTATE_90_COUNTERCLOCKWISE)
            }
            else -> return src
        }
        return rotated
    }

    private fun stripFileScheme(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

    private fun ensureOpenCv() {
        if (!opencvInitialised.get()) {
            try {
                System.loadLibrary("opencv_java4")
                opencvInitialised.set(true)
            } catch (e: UnsatisfiedLinkError) {
                throw IllegalStateException(
                    "OpenCV native library 'opencv_java4' failed to load",
                    e,
                )
            }
        }
    }

    private class StitcherException(val code: String, message: String) : Exception(message)

    companion object {
        @JvmStatic
        private val opencvInitialised = AtomicBoolean(false)
    }
}
