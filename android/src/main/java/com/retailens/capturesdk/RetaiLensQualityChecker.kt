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
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfDouble
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc

/**
 * Android twin of the iOS RetaiLensQualityChecker.
 *
 * Algorithm:
 *   - Blur score: variance of the Laplacian of the grayscale image.
 *     Higher = sharper.  Threshold (passed by host) typically 100.
 *   - Brightness score: mean luminance of the grayscale image, in
 *     [0..1].  Threshold range typically [0.2, 0.8].
 *
 * Same surface as the iOS module:
 *   runQualityCheck({ imagePath, blurThreshold, brightnessLow,
 *                     brightnessHigh })
 *     → { passed, blurScore, brightnessScore, issues: [] }
 *
 * OpenCV is initialised lazily on first call.  The init is fast
 * (no native loader prompts in OpenCV 4.x) and the result is
 * cached.
 */
class RetaiLensQualityChecker(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RetaiLensQualityChecker"

    @ReactMethod
    fun runQualityCheck(options: ReadableMap, promise: Promise) {
        val imagePath = options.getString("imagePath")
            ?: return promise.reject("invalid-options", "imagePath required")
        val blurThreshold =
            if (options.hasKey("blurThreshold")) options.getDouble("blurThreshold") else 100.0
        val brightnessLow =
            if (options.hasKey("brightnessLow")) options.getDouble("brightnessLow") else 0.2
        val brightnessHigh =
            if (options.hasKey("brightnessHigh")) options.getDouble("brightnessHigh") else 0.8

        // Run on background coroutine — image decode + Laplacian
        // takes ~30-80 ms on a midrange phone, enough to drop a
        // frame on the JS thread.
        CoroutineScope(Dispatchers.Default).launch {
            try {
                ensureOpenCv()
                val cleaned = stripFileScheme(imagePath)
                val src = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
                if (src.empty()) {
                    promise.reject(
                        "read-failed",
                        "Could not decode image at $imagePath",
                    )
                    return@launch
                }

                val gray = Mat()
                Imgproc.cvtColor(src, gray, Imgproc.COLOR_BGR2GRAY)

                // Laplacian variance — same algorithm as iOS.
                val lap = Mat()
                Imgproc.Laplacian(gray, lap, CvType.CV_64F)
                val mean = MatOfDouble()
                val stddev = MatOfDouble()
                Core.meanStdDev(lap, mean, stddev)
                val blurScore = stddev.toArray()[0].let { it * it }

                // Mean luminance, normalised to 0..1.
                val meanBrightness = Core.mean(gray).`val`[0] / 255.0

                val issues = mutableListOf<Map<String, String>>()
                if (blurScore < blurThreshold) {
                    issues.add(mapOf(
                        "type" to "blur",
                        "message" to "Image is too blurry (score $blurScore < $blurThreshold)",
                        "severity" to "error",
                    ))
                }
                if (meanBrightness < brightnessLow) {
                    issues.add(mapOf(
                        "type" to "brightness_low",
                        "message" to "Image is too dark",
                        "severity" to "warning",
                    ))
                } else if (meanBrightness > brightnessHigh) {
                    issues.add(mapOf(
                        "type" to "brightness_high",
                        "message" to "Image is too bright",
                        "severity" to "warning",
                    ))
                }

                val passed = issues.none { it["severity"] == "error" }

                val result = WritableNativeMap().apply {
                    putBoolean("passed", passed)
                    putDouble("blurScore", blurScore)
                    putDouble("brightnessScore", meanBrightness)
                    val issuesArray = com.facebook.react.bridge.WritableNativeArray()
                    for (issue in issues) {
                        val m = WritableNativeMap()
                        m.putString("type", issue["type"])
                        m.putString("message", issue["message"])
                        m.putString("severity", issue["severity"])
                        issuesArray.pushMap(m)
                    }
                    putArray("issues", issuesArray)
                }

                src.release()
                gray.release()
                lap.release()
                mean.release()
                stddev.release()

                promise.resolve(result)
            } catch (t: Throwable) {
                promise.reject("quality-check-failed", t.message, t)
            }
        }
    }

    private fun ensureOpenCv() {
        if (!opencvInitialised) {
            // Load the prebuilt OpenCV native lib directly from
            // the APK's lib/<ABI>/ folder.  We deliberately avoid
            // OpenCV's `OpenCVLoader.initDebug()` because the rest
            // of `org.opencv.android.*` (AsyncServiceHelper,
            // StaticHelper, BaseLoaderCallback, etc.) is the
            // legacy "OpenCV Manager service" code path that
            // depends on a deprecated AIDL interface and an
            // auto-generated R class — both excluded from our
            // build.  System.loadLibrary is the same final call
            // those helpers make under the hood.
            try {
                System.loadLibrary("opencv_java4")
                opencvInitialised = true
            } catch (e: UnsatisfiedLinkError) {
                throw IllegalStateException(
                    "OpenCV native library 'opencv_java4' failed to load",
                    e,
                )
            }
        }
    }

    companion object {
        @Volatile
        private var opencvInitialised: Boolean = false

        internal fun stripFileScheme(path: String): String =
            if (path.startsWith("file://")) path.removePrefix("file://") else path
    }
}
