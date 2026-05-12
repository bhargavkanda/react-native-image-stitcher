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

    /**
     * JNI bridge to our custom-built OpenCV stitcher.  Mirrors iOS'
     * OpenCVStitcher.stitchFramePaths so the batch-keyframe flow has
     * parity across platforms.  Implementation:
     *   retailens-capture-sdk/android/src/main/cpp/retailens_stitcher.cpp
     *
     * @param framePaths  input JPEG paths in capture order (≥2 required)
     * @param outputPath  destination JPEG path
     * @param jpegQuality 0..100
     * @param warperType  "plane" | "cylindrical" | "spherical"
     * @param blenderType "multiband" | "feather"
     * @param seamFinderType "graphcut" | "skip" | "voronoi"
     * @param captureOrientation "portrait" | "portrait-upside-down"
     *                            | "landscape-left" | "landscape-right"
     *                            (drives output bake-rotation table,
     *                            mirrors iOS)
     * @param useInscribedRectCrop  reserved for future parity with
     *                              iOS' inscribed-rect crop toggle;
     *                              currently bbox-only on Android
     * @return [width, height] of the written JPEG
     * @throws RuntimeException on stitch failure
     */
    private external fun nativeStitchFramePaths(
        framePaths: Array<String>,
        outputPath: String,
        jpegQuality: Int,
        warperType: String,
        blenderType: String,
        seamFinderType: String,
        captureOrientation: String,
        useInscribedRectCrop: Boolean,
    ): IntArray

    // ── Stitch frames → panorama ─────────────────────────────────

    @ReactMethod
    fun stitch(options: ReadableMap, promise: Promise) {
        // Unmarshal options.  We accept iOS-aligned parameter names
        // so the JS-side code stays platform-agnostic.
        val framePathsArr = options.getArray("framePaths")
        if (framePathsArr == null || framePathsArr.size() < 2) {
            promise.reject(
                "invalid-options",
                "framePaths must be an array of at least 2 paths " +
                    "(got ${framePathsArr?.size() ?: 0}).",
            )
            return
        }
        val framePaths = Array(framePathsArr.size()) {
            stripFileScheme(framePathsArr.getString(it) ?: "")
        }
        val outputPath = options.getString("outputPath")
            ?.let(::stripFileScheme)
            ?: return promise.reject("invalid-options", "outputPath required")
        val quality = if (options.hasKey("quality"))
            options.getInt("quality") else 85
        val warperType = options.getString("warperType") ?: "plane"
        val blenderType = options.getString("blenderType") ?: "multiband"
        val seamFinderType = options.getString("seamFinderType") ?: "graphcut"
        val captureOrientation = options.getString("captureOrientation") ?: "portrait"
        val useInscribedRectCrop = options.hasKey("useInscribedRectCrop") &&
            options.getBoolean("useInscribedRectCrop")

        CoroutineScope(Dispatchers.Default).launch {
            val start = System.currentTimeMillis()
            try {
                ensureNativeStitcher()
                val dims = nativeStitchFramePaths(
                    framePaths,
                    outputPath,
                    quality,
                    warperType,
                    blenderType,
                    seamFinderType,
                    captureOrientation,
                    useInscribedRectCrop,
                )
                val duration = System.currentTimeMillis() - start
                val result = WritableNativeMap().apply {
                    putString("outputPath", outputPath)
                    putInt("width", dims[0])
                    putInt("height", dims[1])
                    putInt("durationMs", duration.toInt())
                }
                promise.resolve(result)
            } catch (t: Throwable) {
                promise.reject(
                    "stitch-failed",
                    "Native stitch threw: ${t.message ?: t.javaClass.simpleName}",
                    t,
                )
            }
        }
    }

    // ── Stitch video → panorama (extract + stitch + cleanup) ─────

    @ReactMethod
    fun stitchVideo(options: ReadableMap, promise: Promise) {
        // Video → frames extraction not yet implemented on Android.
        // The batch-keyframe flow drives stitch() directly with
        // already-captured frame paths.  If video-driven panorama
        // ever ships on Android, extract via MediaMetadataRetriever
        // and delegate to nativeStitchFramePaths.
        promise.reject(
            "STITCH_VIDEO_NOT_IMPLEMENTED",
            "stitchVideo() is not implemented on Android.  Use " +
                "stitch() with pre-extracted framePaths instead.",
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

    /**
     * Load the JNI shim that exposes cv::Stitcher.  libopencv_java4
     * must be loaded FIRST because the shim dynamically links against
     * it (uses cv::Mat, cv::imread/imwrite, cv::imgproc symbols
     * exported by the fat lib).
     */
    private fun ensureNativeStitcher() {
        ensureOpenCv()
        if (!stitcherInitialised.get()) {
            try {
                System.loadLibrary("retailens_stitcher")
                stitcherInitialised.set(true)
            } catch (e: UnsatisfiedLinkError) {
                throw IllegalStateException(
                    "JNI shim 'retailens_stitcher' failed to load. " +
                        "Check that the custom OpenCV build artifacts " +
                        "(libopencv_java4.so + libopencv_stitching.a) " +
                        "are in vendor/OpenCV-android-sdk/sdk/native/.",
                    e,
                )
            }
        }
    }

    private class StitcherException(val code: String, message: String) : Exception(message)

    companion object {
        @JvmStatic
        private val opencvInitialised = AtomicBoolean(false)

        @JvmStatic
        private val stitcherInitialised = AtomicBoolean(false)
    }
}
