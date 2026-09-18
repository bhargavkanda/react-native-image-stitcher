// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusNativeBasis.kt — the recorder's read-only window onto the engine's
// 24-candidate basis table.
//
// ── WHY THE RECORDER NEEDS A NATIVE CALL AT ALL ─────────────────────────
//
// To write `q` the recorder needs the MATRIX `C`, and `C` is one entry of a
// table that lives in rnis_pano_attitude.cpp. Rebuilding that table in Kotlin
// would be a second enumeration to keep in step with the first, and when the
// two drifted, every pack recorded in between would carry quaternions built on
// one indexing and replay against the other — a silent 90° roll with nothing
// in the pack able to name it. So the engine is ASKED. Five tiny JNI entries,
// documented at the foot of panoplus_jni.cpp, and no JSON parser on the
// frame path.
//
// ── IT NEVER THROWS, AND THAT IS THE CONTRACT ───────────────────────────
//
// A build whose `externalNativeBuild` did not run, a host without the
// stitcher's OpenCV, a stale .so missing these exports — all three arrive as
// `UnsatisfiedLinkError`, all three are recorded as a REFUSAL with the loader's
// own message, and all three leave the sweep running with `q` identity and
// `qSource:"none"`. That is the recorder's original behaviour, so a missing
// native half costs the pack its attitude channel and nothing else. Throwing
// here would cost the whole sweep, on a device nobody can attach a debugger to.

package io.imagestitcher.rn.panoplus

import java.util.concurrent.atomic.AtomicBoolean

/**
 * `RecorderRotation` (rnis_pano_android_basis.hpp), by ordinal.
 *
 * ⚠ THE RECORDER HANDS THE ENGINE THE RAW SENSOR BUFFER. It converts
 * YUV_420_888 → NV21 → JPEG at the sensor's native orientation and never
 * rotates (PanoPlusAndroidRecorder's writeFrame says so beside the encode, and
 * the intrinsics are expressed against that same raster). `RawSensorBuffer` is
 * therefore a FACT about this recorder, not a default to be tuned — if the
 * encode path ever rotates, this constant and the intrinsics must move
 * together or `C` is wrong by that angle with nothing to show for it.
 */
internal const val PANO_RECORDER_ROTATION_RAW_SENSOR_BUFFER = 0

/** Everything the pack must be able to say about how `C` was chosen. */
internal class PanoBasisResolution(
    val authority: PanoBasisAuthority,
    /** Row-major `C`, or null when the authority is `none`. */
    val matrix: DoubleArray?,
    /** The engine's own label for [PanoBasisAuthority.index]. */
    val label: String,
    /** `deriveBasis()`'s index for this camera, whether or not it won. */
    val derivedIndex: Int,
    /** `BasisDerivation::refusal`, verbatim. */
    val derivedRefusal: String,
    /** `basisCandidateCount()` — 0 when native never answered. */
    val candidateCount: Int,
    /** Null when the native half loaded and answered. */
    val nativeError: String?,
) {
    val usable: Boolean get() = matrix != null && authority.index >= 0
}

internal object PanoPlusNativeBasis {

    // Signatures/order/types must match the JNI C signatures at the foot of
    // panoplus_jni.cpp EXACTLY — an UnsatisfiedLinkError at runtime is
    // the only thing that checks them, which is why every call below is inside
    // the try that turns one into a named refusal.
    private external fun nativePanoDeriveBasisIndex(
        sensorOrientationDeg: Int,
        lensFacing: Int,
        recorderRotation: Int,
        displayRotationDeg: Int,
        explicitRotationCwDeg: Int,
        mirrored: Boolean,
    ): Int

    private external fun nativePanoDeriveBasisRefusal(
        sensorOrientationDeg: Int,
        lensFacing: Int,
        recorderRotation: Int,
        displayRotationDeg: Int,
        explicitRotationCwDeg: Int,
        mirrored: Boolean,
    ): String

    private external fun nativePanoBasisMatrix(index: Int): DoubleArray?

    private external fun nativePanoBasisLabel(index: Int): String

    private external fun nativePanoBasisCandidateCount(): Int

    /**
     * Resolve the basis for one sweep: derive, apply the authority ladder,
     * and fetch the winning matrix from the engine's own table.
     *
     * @param sensorOrientationDeg `CameraCharacteristics.SENSOR_ORIENTATION`
     *   of the camera actually OPENED (the physical one when the recorder
     *   bound a physical id — that is the raster the pack carries). −1 when it
     *   could not be read, which the derivation refuses by name rather than
     *   defaulting to 0.
     * @param lensFacing a raw `CameraCharacteristics.LENS_FACING`.
     *   ⚠ NEVER `Camera.CameraInfo` — the two numberings are SWAPPED, and the
     *   legacy one derives the FRONT basis for a BACK sweep while refusing
     *   nothing (rnis_pano_android_basis.hpp's LensFacing note).
     * @param measuredBasisIndex the `measuredBasisIndex` start option, or −1.
     */
    fun resolve(
        sensorOrientationDeg: Int,
        lensFacing: Int,
        measuredBasisIndex: Int,
    ): PanoBasisResolution {
        val loadError = ensureNativeOrNull()
        if (loadError != null) return unavailable(measuredBasisIndex, loadError)

        val derivedIndex: Int
        val derivedRefusal: String
        val candidateCount: Int
        try {
            derivedIndex = nativePanoDeriveBasisIndex(
                sensorOrientationDeg,
                lensFacing,
                PANO_RECORDER_ROTATION_RAW_SENSOR_BUFFER,
                0,      // displayRotationDeg — read only by UprightForDisplayRotation
                0,      // explicitRotationCwDeg — read only by Explicit
                false,  // mirrored: this recorder never flips; a flip is det −1
                        // and no member of the 24-candidate set can express it
            )
            derivedRefusal = nativePanoDeriveBasisRefusal(
                sensorOrientationDeg,
                lensFacing,
                PANO_RECORDER_ROTATION_RAW_SENSOR_BUFFER,
                0,
                0,
                false,
            )
            candidateCount = nativePanoBasisCandidateCount()
        } catch (t: Throwable) {
            return unavailable(measuredBasisIndex, describe(t))
        }

        val authority = panoResolveBasisAuthority(
            measuredBasisIndex, derivedIndex, derivedRefusal, candidateCount,
        )
        if (authority.index < 0) {
            return PanoBasisResolution(
                authority, null, "invalid", derivedIndex, derivedRefusal, candidateCount, null,
            )
        }

        val m: DoubleArray?
        val label: String
        try {
            m = nativePanoBasisMatrix(authority.index)
            label = nativePanoBasisLabel(authority.index)
        } catch (t: Throwable) {
            return unavailable(measuredBasisIndex, describe(t))
        }
        if (m == null || m.size != 9) {
            // The ladder accepted an index the table then refused to look up.
            // Only reachable if candidateCount disagrees with basisMatrix, so
            // it is a native inconsistency and not an operator error — fall to
            // identity and SAY which half disagreed.
            return PanoBasisResolution(
                panoResolveBasisAuthority(
                    -1, -1,
                    "basisMatrix(${authority.index}) returned no matrix even though " +
                        "basisCandidateCount() reported $candidateCount candidates",
                    candidateCount,
                ),
                null, "invalid", derivedIndex, derivedRefusal, candidateCount, null,
            )
        }
        return PanoBasisResolution(
            authority, m, label, derivedIndex, derivedRefusal, candidateCount, null,
        )
    }

    /**
     * No native half — so no basis, whatever was supplied.
     *
     * A `measuredBasisIndex` cannot rescue this: without the engine there is
     * no matrix to apply it through, and an index alone rotates nothing.
     */
    private fun unavailable(measuredBasisIndex: Int, why: String): PanoBasisResolution {
        val authority = panoResolveBasisAuthority(
            measuredBasisIndex, -1,
            "the pano+ native half is unavailable, so neither the derivation nor the " +
                "24-candidate matrix table could be reached ($why)",
            0,
        )
        return PanoBasisResolution(authority, null, "invalid", -1, "native-unavailable", 0, why)
    }

    private fun describe(t: Throwable): String =
        "${t.javaClass.simpleName}: ${t.message ?: "(no message)"}"

    /**
     * Load the JNI shim, returning null on success or the reason on failure.
     *
     * The same shape and the same reasoning as
     * `PanoPlusAndroidModule.ensureNativeOrNull` — a missing .so is a RESULT
     * the pack must carry, not an exception to propagate — and, like that one,
     * it keeps its own flags. `System.loadLibrary` is idempotent, so a third
     * cache costs one extra no-op call and no cache can leave another
     * believing a load that never happened.
     */
    private fun ensureNativeOrNull(): String? {
        if (!opencvLoaded.get()) {
            try {
                System.loadLibrary("opencv_java4")
                opencvLoaded.set(true)
            } catch (e: UnsatisfiedLinkError) {
                return "OpenCV native library 'opencv_java4' failed to load — is " +
                    "react-native-image-stitcher (which ships it) linked? " +
                    "(${e.message ?: "no message"})"
            }
        }
        if (!pluginsLoaded.get()) {
            try {
                System.loadLibrary("image_stitcher_panoplus")
                pluginsLoaded.set(true)
            } catch (e: UnsatisfiedLinkError) {
                return "JNI shim 'image_stitcher_panoplus' failed to load. Check that " +
                    "react-native-image-stitcher built its externalNativeBuild " +
                    "(libimage_stitcher_panoplus.so). (${e.message ?: "no message"})"
            }
        }
        return null
    }

    private val opencvLoaded = AtomicBoolean(false)
    private val pluginsLoaded = AtomicBoolean(false)
}
