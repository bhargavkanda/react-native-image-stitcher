// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

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
 * Android twin of the iOS QualityChecker (`RNImageStitcherQualityChecker` native module).
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
class QualityChecker(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RNImageStitcherQualityChecker"

    /**
     * Three-axis image quality measurement for a single still image.
     * STRING-path surface (JS: `native.measure(path)`), matching the
     * iOS QualityChecker `measure:` selector.  Distinct from
     * [runQualityCheck], which keeps the legacy ReadableMap/options +
     * pass/fail/issues surface and is left untouched.
     *
     * Scores (all on OpenCV's native scales):
     *   - blurScore       : variance of the Laplacian of the gray
     *                       image (same computation as runQualityCheck;
     *                       higher = sharper).
     *   - brightnessScore : mean luminance on the 0..255 scale (NOT
     *                       divided by 255 — matches iOS `measure`,
     *                       which returns the raw 0..255 mean; this is
     *                       deliberately different from runQualityCheck,
     *                       whose `brightnessScore` is normalised 0..1).
     *   - glareScore      : mean dark-channel veiling-glare score
     *                       (0..255, higher = more glare), computed in
     *                       shared C++ via [nativeComputeGlareScore].
     *                       The COLOUR (BGR) Mat is passed through — the
     *                       C++ dark-channel prior takes the per-pixel
     *                       min over B,G,R, so it needs colour, not the
     *                       gray image.
     */
    @ReactMethod
    fun measure(imagePath: String, promise: Promise) {
        // Same threading rationale as runQualityCheck: decode +
        // Laplacian + dark-channel erode is tens of ms — keep it off
        // the JS thread.
        CoroutineScope(Dispatchers.Default).launch {
            var color: Mat? = null
            var gray: Mat? = null
            var lap: Mat? = null
            var mean: MatOfDouble? = null
            var stddev: MatOfDouble? = null
            try {
                ensureOpenCv()
                val cleaned = stripFileScheme(imagePath)
                // COLOUR (BGR, CV_8UC3) — the C++ glare detector needs
                // all three channels for the dark-channel-prior min.
                color = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
                if (color.empty()) {
                    promise.reject(
                        "read-failed",
                        "Could not decode image at $imagePath",
                    )
                    return@launch
                }

                gray = Mat()
                Imgproc.cvtColor(color, gray, Imgproc.COLOR_BGR2GRAY)

                // Laplacian variance — EXACTLY as runQualityCheck.
                lap = Mat()
                Imgproc.Laplacian(gray, lap, CvType.CV_64F)
                mean = MatOfDouble()
                stddev = MatOfDouble()
                Core.meanStdDev(lap, mean, stddev)
                val blurScore = stddev.toArray()[0].let { it * it }

                // Mean luminance on the 0..255 scale (iOS-parity —
                // NOT divided by 255, unlike runQualityCheck).
                val brightnessScore = Core.mean(gray).`val`[0]

                // Veiling-glare score (0..255) from shared C++.  Pass
                // the COLOUR Mat's nativeObjAddr; V1 uses the default
                // central-box ROI (no roi argument).
                val glareScore = nativeComputeGlareScore(color.nativeObjAddr)

                val result = WritableNativeMap().apply {
                    putDouble("blurScore", blurScore)
                    putDouble("brightnessScore", brightnessScore)
                    putDouble("glareScore", glareScore)
                }
                promise.resolve(result)
            } catch (t: Throwable) {
                promise.reject("quality-check-failed", t.message, t)
            } finally {
                color?.release()
                gray?.release()
                lap?.release()
                mean?.release()
                stddev?.release()
            }
        }
    }

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

    // ── JNI thunk ───────────────────────────────────────────────
    //
    // Bridges to the shared C++ retailens::computeGlareScore (see
    // cpp/glare.{hpp,cpp}) via glare_jni.cpp.  matAddr is the
    // OpenCV-Java Mat.nativeObjAddr of a COLOUR (BGR, CV_8UC3) Mat;
    // returns the mean dark-channel veiling-glare score on a 0..255
    // scale.  INSTANCE method → the JNI thunk takes a jobject (the
    // symbol lives in libimage_stitcher.so, loaded in the companion
    // init below).
    private external fun nativeComputeGlareScore(matAddr: Long): Double

    companion object {
        init {
            // The glare JNI thunk (nativeComputeGlareScore) lives in
            // libimage_stitcher.so — load it so the external fun above
            // resolves.  Distinct from the opencv_java4 load in
            // ensureOpenCv(): that one initialises the org.opencv.*
            // Java classes (imread/Laplacian/etc.) this module also
            // uses.  System.loadLibrary is idempotent, so loading
            // image_stitcher here (it dynamically links opencv_java4)
            // and opencv_java4 again in ensureOpenCv() is safe.
            //
            // v0.24.4 — via NativeLibraryLoader.tryLoad(), which never
            // throws.  RNImageStitcherPackage.createNativeModules()
            // constructs this module during bridge startup, so a
            // throwing static initialiser took the whole app down
            // before any JS ran.  Individual methods surface the
            // failure through their own promise rejections instead.
            NativeLibraryLoader.tryLoad()
        }

        @Volatile
        private var opencvInitialised: Boolean = false

        internal fun stripFileScheme(path: String): String =
            if (path.startsWith("file://")) path.removePrefix("file://") else path
    }
}
