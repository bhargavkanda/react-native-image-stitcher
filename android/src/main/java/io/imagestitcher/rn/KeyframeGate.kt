// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * Kotlin facade over the shared C++ KeyframeGate (in
 * react-native-image-stitcher/cpp/keyframe_gate.{hpp,cpp}).
 *
 * Architecture parity with iOS:
 *   iOS uses an Obj-C++ bridge (KeyframeGateBridge.mm) to wrap the
 *   same C++ class.  This Kotlin class is the Android equivalent —
 *   thin facade, JNI plumbing, identical public surface.  Both
 *   platforms call into the same C++ algorithm, so panorama
 *   composition decisions are bit-identical across platforms (the
 *   whole point of the P3 work).
 *
 * Lifecycle:
 *   Each instance owns one C++ KeyframeGate via a `Long` opaque
 *   handle.  Caller MUST call [close] before the instance is GC'd,
 *   otherwise we leak a small heap allocation per gate-instance.
 *   Practice on Android: KeyframeGate is held by
 *   IncrementalStitcher as a member; we add cleanup hook
 *   in `onCatalystInstanceDestroy()` so the JNI native heap stays
 *   bounded across RN reloads.
 *
 * Threading:
 *   The underlying C++ class is NOT thread-safe.  Caller MUST
 *   serialise — typically via the engine's workScope serial
 *   dispatcher.  Same contract the iOS side has.
 *
 * Reason-string parity:
 *   The JS layer reads `decision.reason` for telemetry; that string
 *   value MUST match iOS byte-for-byte or the UI pill drifts
 *   silently.  The mapping is centralised in [reasonFromCode] —
 *   1:1 with `KeyframeGateBridge.mm::kReasonStringFor` on iOS.
 *   Drift here is a parity bug.
 */
internal class KeyframeGate : AutoCloseable {

    private val nativeHandle: Long = nativeCreate()

    @Volatile private var closed: Boolean = false

    override fun close() {
        if (!closed) {
            closed = true
            nativeDestroy(nativeHandle)
        }
    }

    // Defensive net for missed close() calls.  Kotlin/JVM finalizers
    // are unreliable but better than nothing — they prevent a slow
    // native-heap leak in pathological "module rebuilt many times
    // without explicit cleanup" cases.  Always prefer explicit close().
    @Suppress("DEPRECATION")
    protected fun finalize() {
        close()
    }

    // ── Settings ────────────────────────────────────────────────

    var enabled: Boolean
        get() = nativeIsEnabled(nativeHandle)
        set(value) = nativeSetEnabled(nativeHandle, value)

    /// Required new-content fraction (0…1).  Default 0.4.  No getter
    /// — the C++ side has no read accessor (Swift side never needed
    /// to read this back either).  Stored locally for diagnostic
    /// readbacks; written into C++ via setter.
    var overlapThreshold: Double = 0.4
        set(value) {
            field = value
            nativeSetOverlapThreshold(nativeHandle, value)
        }

    var maxCount: Int
        get() = nativeGetMaxCount(nativeHandle)
        set(value) = nativeSetMaxCount(nativeHandle, value)

    /// One-shot write-only trigger.  Setting `true` arms the next
    /// evaluate() to force-accept; the trigger is consumed inside
    /// the C++ gate.  Reading always returns false (matches the
    /// iOS Swift facade's behaviour).
    var forceAcceptNext: Boolean
        get() = false
        set(value) {
            if (value) nativeMarkNextFrameAsLast(nativeHandle)
        }

    /// 2026-05-14 — disable the angular-delta fallback.  See C++
    /// `setDisableAngularFallback` doc for the full rationale.  In
    /// short: set this to `true` in non-AR mode (captureSource ∈
    /// {wide, ultrawide}) where pose data isn't available — the
    /// gate's angular calculation would otherwise produce nonsense.
    /// Default `false` (back-compat — AR mode uses the fallback).
    /// Write-only; no read accessor on the C++ side.
    var disableAngularFallback: Boolean = false
        set(value) {
            field = value
            nativeSetDisableAngularFallback(nativeHandle, value)
        }

    /// 2026-05-14 — Flow strategy: novelty aggregation percentile
    /// (same knob iOS exposes via setFlowNoveltyPercentile).  C++
    /// clamps to [0.5, 0.99].  Stored locally for diagnostic
    /// readback; the C++ side has no getter.
    var flowNoveltyPercentile: Double = 0.85
        set(value) {
            field = value
            nativeSetFlowNoveltyPercentile(nativeHandle, value)
        }

    /// 2026-05-14 — Flow strategy: max translation in METRES between
    /// consecutive accepted keyframes before force-acceptance.  Same
    /// knob iOS exposes via setFlowMaxTranslationM.  In non-AR mode
    /// the JS host computes translation from react-native-sensors
    /// IMU integration and pushes it through this setter so the
    /// translation-budget logic in C++ kicks in even without ARKit/
    /// ARCore pose.  0.0 (default) = disabled.
    var flowMaxTranslationM: Double = 0.0
        set(value) {
            field = value
            nativeSetFlowMaxTranslationM(nativeHandle, value)
        }

    // ── Read-only state ─────────────────────────────────────────

    val acceptedCount: Int get() = nativeGetAcceptedCount(nativeHandle)

    // ── Lifecycle ───────────────────────────────────────────────

    fun reset() {
        nativeReset(nativeHandle)
        // Re-apply locally-stored settings the C++ doesn't track for
        // readback.  (Currently just overlapThreshold.)  Matches the
        // iOS facade's reset() which re-writes overlapThreshold too.
        nativeSetOverlapThreshold(nativeHandle, overlapThreshold)
    }

    // ── Evaluation ──────────────────────────────────────────────

    /**
     * Decide whether to accept this ARCore frame as a keyframe.
     *
     * @param pose Camera pose + intrinsics for this frame.
     * @param latchedPlaneMatrix Column-major 4×4 plane transform
     *   (16 floats).  Pass null for the angular-delta fallback path
     *   (when no plane is latched).  Format MUST match what ARCore's
     *   `Pose.toMatrix(out, offset)` produces — column-major, same
     *   layout as iOS simd_float4x4.
     */
    fun evaluate(
        pose: RNSARFramePose,
        latchedPlaneMatrix: FloatArray?,
    ): KeyframeGateDecision {
        val result = nativeEvaluate(
            nativeHandle,
            pose.tx.toFloat(), pose.ty.toFloat(), pose.tz.toFloat(),
            pose.qx.toFloat(), pose.qy.toFloat(), pose.qz.toFloat(), pose.qw.toFloat(),
            pose.fx.toFloat(), pose.fy.toFloat(), pose.cx.toFloat(), pose.cy.toFloat(),
            pose.imageWidth, pose.imageHeight,
            latchedPlaneMatrix,
        )
        // result layout (matches keyframe_gate_jni.cpp::nativeEvaluate):
        //   [0] accept (1.0 / 0.0)
        //   [1] reasonCode (int)
        //   [2] newContentFraction (-1.0 when not computed)
        //   [3] acceptedCount (int)
        //   [4] maxCount (int)
        return KeyframeGateDecision(
            accept = result[0] >= 0.5,
            reason = reasonFromCode(result[1].toInt()),
            newContentFraction = result[2],
            acceptedCount = result[3].toInt(),
            maxCount = result[4].toInt(),
        )
    }

    // ── JNI thunks ──────────────────────────────────────────────

    private external fun nativeCreate(): Long
    private external fun nativeDestroy(handle: Long)
    private external fun nativeSetEnabled(handle: Long, enabled: Boolean)
    private external fun nativeSetOverlapThreshold(handle: Long, t: Double)
    private external fun nativeSetMaxCount(handle: Long, n: Int)
    private external fun nativeMarkNextFrameAsLast(handle: Long)
    private external fun nativeReset(handle: Long)
    private external fun nativeGetAcceptedCount(handle: Long): Int
    private external fun nativeGetMaxCount(handle: Long): Int
    private external fun nativeIsEnabled(handle: Long): Boolean
    // 2026-05-14 — new setters for the non-AR mode plumbing + the
    // setFlowNoveltyPercentile / setFlowMaxTranslationM iOS-parity
    // setters (Android JNI was a P3-followup until 2026-05-14).
    private external fun nativeSetDisableAngularFallback(handle: Long, disabled: Boolean)
    private external fun nativeSetFlowNoveltyPercentile(handle: Long, percentile: Double)
    private external fun nativeSetFlowMaxTranslationM(handle: Long, metres: Double)
    private external fun nativeEvaluate(
        handle: Long,
        tx: Float, ty: Float, tz: Float,
        qx: Float, qy: Float, qz: Float, qw: Float,
        fx: Float, fy: Float, cx: Float, cy: Float,
        imageWidth: Int, imageHeight: Int,
        plane16: FloatArray?,
    ): DoubleArray

    companion object {
        init {
            // libimage_stitcher.so contains both the OpenCV stitcher
            // shim AND the C++ KeyframeGate + JNI bindings (single .so
            // keeps APK lean and avoids a second System.loadLibrary).
            System.loadLibrary("image_stitcher")
        }

        /**
         * Map C++ `KeyframeGateDecisionReason` enum int → telemetry
         * string.  MUST stay byte-for-byte identical to iOS' mapping
         * in `KeyframeGateBridge.mm::kReasonStringFor`.  JS reads
         * `decision.reason` and surfaces it directly to the UI pill
         * (live frame strip "keyframe rejected: max-reached" etc.),
         * so drift across platforms is a parity bug.
         */
        private fun reasonFromCode(code: Int): String = when (code) {
            0 -> "gate-disabled"
            1 -> "force-last"
            2 -> "first-anchored-on-plane"
            3 -> "first-no-plane"
            4 -> "ok"
            5 -> "ok-angular"
            6 -> "projection-degenerate"
            7 -> "current-area-zero"
            8 -> "no-pose-yet"
            9 -> "max-reached"
            10 -> "overlap-too-high"
            11 -> "overlap-too-high (angular)"
            else -> "unknown($code)"
        }
    }
}

/**
 * Result of a single [KeyframeGate.evaluate] call.  Layout mirrors
 * iOS `KeyframeGateDecision` exactly so JS-side telemetry handlers
 * don't branch on platform.
 */
internal data class KeyframeGateDecision(
    /// Caller checks this first — `true` means ingest the frame.
    val accept: Boolean,
    /// Telemetry string ("ok" / "max-reached" / "overlap-too-high" / etc).
    val reason: String,
    /// Computed [0, 1] new-content fraction, or -1.0 if not computed
    /// (gate disabled, force-first/last, no plane available).
    val newContentFraction: Double,
    /// Keyframes accepted so far (includes this one if accept=true).
    val acceptedCount: Int,
    /// Cap for this capture (0 if gate disabled).
    val maxCount: Int,
)
