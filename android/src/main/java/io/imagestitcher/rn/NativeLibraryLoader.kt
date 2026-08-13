// SPDX-FileCopyrightText: 2026 Tiger Analytics
// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.util.Log

/**
 * Single, survivable entry point for loading this SDK's native
 * libraries.
 *
 * ## The bug this exists to prevent (v0.24.4)
 *
 * Seven classes used to call `System.loadLibrary("image_stitcher")`
 * directly from a `companion object { init { … } }` block.  Four of
 * them — `QualityChecker`, `BatchStitcher`, `IncrementalStitcher`,
 * `StitcherJsiInstallerModule` — are constructed EAGERLY by
 * `RNImageStitcherPackage.createNativeModules()`, which RN calls
 * during bridge startup, before a single line of JS runs.
 *
 * A static initialiser that throws does not merely fail: the JVM
 * wraps it in `ExceptionInInitializerError`, which propagates out of
 * `createNativeModules()` and takes the whole app down.  So on any
 * device or emulator where `libimage_stitcher.so` is absent for the
 * running ABI, the host app did not "lose the panorama feature" — it
 * **failed to launch at all**, with a stack trace that names
 * `ExceptionInInitializerError` and no hint about ABIs or OpenCV.
 *
 * That is not hypothetical.  This AAR ships **arm64-v8a only** (see
 * the `abiFilters` block in `android/build.gradle` — our custom
 * OpenCV build with `BUILD_opencv_stitching=ON` exists only for that
 * ABI).  Every x86_64 emulator, and every armeabi-v7a device, hits
 * exactly this path.  The first thing most integrators do with a new
 * dependency is run the app on an emulator.
 *
 * ## Contract
 *
 * - [tryLoad] NEVER throws.  Static initialisers call this, so class
 *   initialisation always succeeds and the host app always boots.
 *   The first failure is logged loudly, once, with the running ABI
 *   and the actual remedy.
 * - [require] throws a legible [IllegalStateException].  Call it at
 *   the point of USE — a constructor, or an RN method that can
 *   reject a promise — so the failure surfaces attached to the
 *   feature that needs it rather than as a raw
 *   `UnsatisfiedLinkError` from somewhere inside JNI.
 * - [isAvailable] is the cheap predicate for callers that want to
 *   degrade rather than throw.
 *
 * Both are idempotent and thread-safe; `System.loadLibrary` itself
 * is idempotent, and we memoise the outcome so a missing library
 * costs one failed lookup rather than one per call site.
 */
object NativeLibraryLoader {

    private const val TAG = "RNImageStitcher"

    /** The JNI shim: C++ KeyframeGate, cv::Stitcher bridge, JSI install. */
    const val LIB_IMAGE_STITCHER = "image_stitcher"

    @Volatile
    private var attempted = false

    @Volatile
    private var failure: Throwable? = null

    /**
     * Load `libimage_stitcher.so` if it hasn't been loaded already.
     * Returns true when the library is usable.  Never throws — safe
     * to call from a static initialiser.
     */
    @JvmStatic
    @Synchronized
    fun tryLoad(): Boolean {
        if (attempted) return failure == null
        attempted = true
        return try {
            System.loadLibrary(LIB_IMAGE_STITCHER)
            failure = null
            true
        } catch (t: Throwable) {
            // UnsatisfiedLinkError is the expected shape, but a
            // broken/partial APK can surface others.  Catch
            // Throwable: the entire point of this method is that the
            // caller's class initialisation must not fail.
            failure = t
            Log.e(TAG, buildDiagnostic(t), t)
            false
        }
    }

    /** True when the native shim loaded successfully. */
    @JvmStatic
    val isAvailable: Boolean
        get() = tryLoad()

    /**
     * Throw a legible error when the native shim is unavailable.
     * Call from constructors / RN methods — never from a static
     * initialiser (that reintroduces the startup crash).
     */
    @JvmStatic
    fun require() {
        if (tryLoad()) return
        throw IllegalStateException(buildDiagnostic(failure), failure)
    }

    private fun buildDiagnostic(cause: Throwable?): String {
        val abis = try {
            android.os.Build.SUPPORTED_ABIS.joinToString(", ")
        } catch (_: Throwable) {
            "unknown"
        }
        return buildString {
            append("react-native-image-stitcher: native library '")
            append(LIB_IMAGE_STITCHER)
            append("' could not be loaded. Panorama capture, keyframe ")
            append("gating and stitching are unavailable; the rest of the ")
            append("app is unaffected.\n")
            append("  Device ABIs: ").append(abis).append('\n')
            append("  This SDK ships arm64-v8a ONLY — our OpenCV is built ")
            append("with BUILD_opencv_stitching=ON for that ABI alone.\n")
            append("  Most likely cause:\n")
            append("    - Running on an x86_64 / armeabi-v7a emulator or ")
            append("device. Use an arm64-v8a emulator image (available on ")
            append("Apple Silicon) or a physical arm64 device.\n")
            append("    - The host app's own `ndk { abiFilters ... }` ")
            append("selected an ABI this AAR does not ship.\n")
            append("    - `npm install` ran with --ignore-scripts, so the ")
            append("OpenCV Android SDK was never downloaded.\n")
            append("  See docs/android-abi-support.md")
            cause?.message?.let { append("\n  Underlying error: ").append(it) }
        }
    }
}
