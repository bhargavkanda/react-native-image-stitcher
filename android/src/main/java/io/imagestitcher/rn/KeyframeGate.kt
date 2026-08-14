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

    // v0.24.4 — fail here, legibly, rather than letting nativeCreate()
    // throw a bare UnsatisfiedLinkError from inside JNI.  Declared
    // before `nativeHandle` so it runs first (Kotlin initialises
    // properties and init blocks in declaration order).
    init { NativeLibraryLoader.require() }

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

    /// 2026-05-22 (audit F6) — Gate strategy.  Matches the C++ enum
    /// retailens::GateStrategy (0 = Pose, 1 = Flow).  Pose strategy
    /// uses plane-projection / angular novelty; Flow strategy uses
    /// sparse optical-flow KLT.  iOS parity: Swift facade's
    /// `keyframeGate.strategy = .flow / .pose`.  Default `Pose`
    /// (matches C++ default).  Write-only; the C++ side has a getter
    /// but the Kotlin facade caches locally to avoid JNI round-trip.
    enum class Strategy(val nativeValue: Int) {
        Pose(0),
        Flow(1);
    }

    var strategy: Strategy = Strategy.Pose
        set(value) {
            field = value
            nativeSetStrategy(nativeHandle, value.nativeValue)
        }

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

    /// v0.25 — per-frame AR tracking trust; see C++ `setPoseTrusted`.
    /// `false` suppresses the gate's two POSE-DRIVEN force-accepts (the
    /// translation budget and the angular fallback) so an initialising /
    /// relocalising ARCore pose can't burst-accept a stationary capture
    /// to the keyframe cap and auto-finalise the operator's hold.  Set
    /// from `Frame.camera.trackingState == TRACKING` on every consumed
    /// AR frame.  Default `true` (back-compat).  Write-only.
    ///
    /// DELIBERATELY UNGUARDED — writes through on every assignment, like
    /// `disableAngularFallback` above.  An earlier v0.25 draft skipped
    /// redundant JNI hops with `if (field == value) return`, which
    /// silently broke the fix from the SECOND capture onward:
    /// `KeyframeGate::reset()` sets the C++ flag back to `true` at
    /// capture start, but this Kotlin mirror belongs to a
    /// process-lifetime gate and kept whatever the previous capture left.
    /// If capture A ended while tracking was degraded the mirror held
    /// `false`, so capture B's per-frame `= false` matched `field` and
    /// never reached C++ — leaving pose-driven accepts live through
    /// exactly the initialising window this exists to protect.
    ///
    /// A boolean across JNI is trivial next to the evaluate() that
    /// follows it, so there is nothing to optimise here.
    var poseTrusted: Boolean = true
        set(value) {
            field = value
            nativeSetPoseTrusted(nativeHandle, value)
        }

    /// v0.25 — may a keep-alive (time-budget) accept be the accept that
    /// REACHES `maxCount`, and so end the capture via the host's
    /// count-based auto-finalize?  Default `true` = pre-0.25 behaviour.
    ///
    /// `false` stops a stationary hold self-finalizing on the clock: the
    /// gate stalls at maxCount - 1 instead of tripping the auto-stop.
    /// Set once per capture from settings, not per frame.
    var timeIntervalCanFinalize: Boolean = true
        set(value) {
            if (field == value) return
            field = value
            nativeSetTimeIntervalCanFinalize(nativeHandle, value)
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

    /// Wall-clock keyframe-interval budget, in MILLISECONDS, between
    /// consecutive accepted keyframes before force-acceptance.  Same
    /// knob iOS exposes via setMaxKeyframeIntervalMs (KeyframeGate.swift
    /// `maxKeyframeIntervalMs`).  Unlike flowMaxTranslationM this applies
    /// to BOTH the Pose and Flow strategies, and is passed STRAIGHT
    /// THROUGH (already in the unit the C++ expects — no conversion).
    /// Default 2000 ms (matches iOS); 0 = disabled.  The C++ setter
    /// clamps to ≥ 0.  NOTE: like every other facade property the
    /// initializer below does NOT fire this setter, so the caller
    /// (IncrementalStitcher.kt) writes it explicitly at capture start
    /// to push the value into C++ (same contract as the iOS facade).
    var maxKeyframeIntervalMs: Double = 1500.0
        set(value) {
            field = value
            nativeSetMaxKeyframeIntervalMs(nativeHandle, value)
        }

    /// 2026-05-22 (audit F5) — Flow strategy: Shi-Tomasi max corners
    /// to track per frame.  Same knob iOS exposes via setFlowMaxCorners.
    /// C++ clamps to ≥ 30.  Higher = more sensitive to fine detail but
    /// CPU-quadratic in the KLT step.  Default 150 (matches iOS).
    var flowMaxCorners: Int = 150
        set(value) {
            field = value
            nativeSetFlowMaxCorners(nativeHandle, value)
        }

    /// 2026-05-22 (audit F5) — Flow strategy: Shi-Tomasi minimum
    /// eigenvalue threshold (0, 1].  C++ default 0.01.  Lower lets
    /// weaker corners in (more candidate points, more KLT noise);
    /// higher demands stronger corners (fewer points, more robust).
    var flowQualityLevel: Double = 0.01
        set(value) {
            field = value
            nativeSetFlowQualityLevel(nativeHandle, value)
        }

    /// 2026-05-22 (audit F5) — Flow strategy: Shi-Tomasi minimum
    /// distance between accepted corners, in working-resolution
    /// pixels.  C++ clamps to ≥ 1.0.  Default 10.0 (matches iOS).
    var flowMinDistance: Double = 10.0
        set(value) {
            field = value
            nativeSetFlowMinDistance(nativeHandle, value)
        }

    /// 2026-05-22 (audit F5) — Eval cadence: caller-side throttle so
    /// the Flow strategy runs every Nth frame instead of every frame.
    /// iOS parity with `IncrementalStitcher.swift:2459-2471` —
    /// the GATE doesn't enforce the throttle itself; it just stores
    /// the value here.  The caller (`IncrementalStitcher.kt`) reads
    /// this and decides per-frame whether to evaluate.  Default 1
    /// (no throttle).  Caller is responsible for clamping to [1, 10].
    var flowEvalEveryNFrames: Int = 1
        set(value) {
            field = value.coerceAtLeast(1)
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

    /**
     * Pixel-aware evaluate.  Hands the gate the frame's grayscale
     * plane so the C++ Flow strategy (sparse optical-flow novelty)
     * actually runs — without grayData, the gate silently falls back
     * to the Pose strategy (angular-delta).  iOS parity: see
     * `KeyframeGateBridge.mm::evaluateWithPixelBuffer:...`.
     *
     * 2026-05-21 (v0.3) added.  Two call-site categories:
     *
     *  - AR mode (`RNSARCameraView.forwardToIncremental`): extracts
     *    the Y plane from the ARCore camera image (YUV_420_888) and
     *    hands it through.  Zero-copy on the way in (the byte[] is
     *    pinned via GetPrimitiveArrayCritical in the JNI).
     *  - Non-AR mode (`CvFlowGateFrameProcessor` via
     *    `IncrementalStitcher.consumeFrameFromPlugin`): extracts the
     *    Y plane from the vision-camera Frame's YUV_420_888 image on
     *    the producer thread and hands it through.  (Pre-v0.6 a
     *    JS-driver `processFrameAtPath` path also called this with
     *    JPEG-decoded grayscale; both were removed in v0.6.)
     *
     * @param grayData    The grayscale plane bytes.  Length must be
     *                    at least `grayStride * grayHeight`.
     * @param grayWidth   Image width in pixels (≤ grayStride).
     * @param grayHeight  Image height in pixels.
     * @param grayStride  Bytes per row.  May exceed `grayWidth` when
     *                    the plane has padding (ARCore can pad).
     */
    fun evaluateWithFrame(
        pose: RNSARFramePose,
        latchedPlaneMatrix: FloatArray?,
        grayData: ByteArray,
        grayWidth: Int,
        grayHeight: Int,
        grayStride: Int,
    ): KeyframeGateDecision {
        val result = nativeEvaluateWithFrame(
            nativeHandle,
            pose.tx.toFloat(), pose.ty.toFloat(), pose.tz.toFloat(),
            pose.qx.toFloat(), pose.qy.toFloat(), pose.qz.toFloat(), pose.qw.toFloat(),
            pose.fx.toFloat(), pose.fy.toFloat(), pose.cx.toFloat(), pose.cy.toFloat(),
            pose.imageWidth, pose.imageHeight,
            latchedPlaneMatrix,
            grayData, grayWidth, grayHeight, grayStride,
        )
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
    private external fun nativeSetPoseTrusted(handle: Long, trusted: Boolean)
    private external fun nativeSetTimeIntervalCanFinalize(handle: Long, canFinalize: Boolean)
    private external fun nativeSetFlowNoveltyPercentile(handle: Long, percentile: Double)
    private external fun nativeSetFlowMaxTranslationM(handle: Long, metres: Double)
    // Wall-clock keyframe-interval budget (ms).  iOS parity:
    // KeyframeGateBridge.setMaxKeyframeIntervalMs.
    private external fun nativeSetMaxKeyframeIntervalMs(handle: Long, ms: Double)
    // 2026-05-22 (audit F5) — flow-strategy tunables that were
    // previously iOS-only.  Add Android JNI parity so the Settings UI
    // sliders work on both platforms.
    private external fun nativeSetFlowMaxCorners(handle: Long, maxCorners: Int)
    private external fun nativeSetFlowQualityLevel(handle: Long, quality: Double)
    private external fun nativeSetFlowMinDistance(handle: Long, minDistance: Double)
    // 2026-05-22 (audit F6) — gate-strategy selector.  Maps to C++
    // retailens::GateStrategy (Pose=0, Flow=1).
    private external fun nativeSetStrategy(handle: Long, strategy: Int)
    private external fun nativeEvaluate(
        handle: Long,
        tx: Float, ty: Float, tz: Float,
        qx: Float, qy: Float, qz: Float, qw: Float,
        fx: Float, fy: Float, cx: Float, cy: Float,
        imageWidth: Int, imageHeight: Int,
        plane16: FloatArray?,
    ): DoubleArray
    private external fun nativeEvaluateWithFrame(
        handle: Long,
        tx: Float, ty: Float, tz: Float,
        qx: Float, qy: Float, qz: Float, qw: Float,
        fx: Float, fy: Float, cx: Float, cy: Float,
        imageWidth: Int, imageHeight: Int,
        plane16: FloatArray?,
        grayData: ByteArray,
        grayWidth: Int, grayHeight: Int, grayStride: Int,
    ): DoubleArray

    companion object {
        init {
            // libimage_stitcher.so contains both the OpenCV stitcher
            // shim AND the C++ KeyframeGate + JNI bindings (single .so
            // keeps APK lean and avoids a second System.loadLibrary).
            //
            // v0.24.4 — via NativeLibraryLoader.tryLoad(), which never
            // throws, so class init always succeeds.  The instance
            // `init` block below calls require() to fail legibly at
            // construction instead.
            NativeLibraryLoader.tryLoad()
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
            // Flow-strategy reasons (v0.3.0, cpp KeyframeGateDecisionReason
            // 12-15) — strings must match the cpp/iOS labels exactly.
            12 -> "ok-flow"
            13 -> "first-flow"
            14 -> "overlap-too-high (flow)"
            15 -> "ok-flow-translation"
            // Wall-clock keyframe-interval force-accept (Pose + Flow);
            // cpp KeyframeGateDecisionReason::AcceptTimeInterval = 16.
            16 -> "ok-time-interval"
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
