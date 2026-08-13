// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * Kotlin facade over the shared C++ anti-blur ADMISSION policy
 * (react-native-image-stitcher/cpp/blur_policy.{hpp,cpp}).
 *
 * Architecture parity with iOS:
 *   iOS wraps the same two C++ entities (the `admitKeyframe` free
 *   function + `RunningScoreMedian`) through an Obj-C++ bridge; this
 *   facade is the Android equivalent (JNI plumbing in
 *   android/src/main/cpp/blur_policy_jni.cpp).  The VERDICT logic —
 *   hold-cap precedence, motion gate, softness floor, and every
 *   fail-open sentinel — lives only in the shared C++ (gtest-covered
 *   in cpp/tests/blur_policy_test.cpp), so the platforms cannot drift.
 *   This class holds the per-capture tunables and the accepted-score
 *   history; it makes no decisions of its own.
 *
 * Why the window machine is not enough (see cpp/blur_policy.hpp for
 * the full argument): [SharpnessWindow] picks the sharpest of K
 * candidates, a purely RELATIVE choice.  A steady continuous pan
 * smears every candidate equally, so best-of-K is still blurry.  This
 * policy adds the two judgements the window structurally cannot make —
 * "the device is slewing too fast to commit" and "every candidate here
 * is anomalously soft for this scene".
 *
 * Default-OFF contract:
 *   Both gate knobs default to 0 = disabled, and [admissionEnabled] is
 *   false in that state.  The engine checks it before doing ANY
 *   policy work, so a capture that doesn't opt in runs exactly the
 *   pre-v0.23 code path.
 *
 * Lifecycle:
 *   Owns one C++ RunningScoreMedian via a `Long` opaque handle;
 *   [close] releases it (called from
 *   IncrementalStitcher.onCatalystInstanceDestroy, same as
 *   KeyframeGate / SharpnessWindow).
 *
 * Threading:
 *   The underlying C++ median is NOT thread-safe.  The engine
 *   serialises every call under its sharpness-window lock — the same
 *   lock that guards the commit point this policy is consulted at.
 */
internal class BlurPolicy : AutoCloseable {

    // v0.24.4 — see KeyframeGate: fail legibly at construction rather
    // than with a bare UnsatisfiedLinkError from nativeMedianCreate().
    init { NativeLibraryLoader.require() }

    private val nativeHandle: Long = nativeMedianCreate(MEDIAN_CAPACITY)

    @Volatile private var closed: Boolean = false

    override fun close() {
        if (!closed) {
            closed = true
            nativeMedianDestroy(nativeHandle)
        }
    }

    // Defensive net for missed close() calls — same rationale as
    // KeyframeGate.finalize().  Always prefer explicit close().
    @Suppress("DEPRECATION")
    protected fun finalize() {
        close()
    }

    /** 1:1 with retailens::BlurAdmission (ordinals pinned by the JNI). */
    enum class Admission {
        /** Commit the pending keyframe (also the fail-open answer). */
        COMMIT,
        /** Device slewing too fast — hold, keep collecting candidates. */
        HOLD_FOR_MOTION,
        /** Candidate anomalously soft for this scene — hold. */
        HOLD_FOR_SOFTNESS,
    }

    // ── Per-capture tunables (mirror retailens::BlurPolicyConfig) ──
    //
    // Kept Kotlin-side rather than behind JNI setters: they are three
    // scalars passed by value on each (rare) admission call, so a
    // native config object would only add round-trips and a second
    // place for the values to go stale.  The engine clamps them when
    // it parses configOverrides.

    /** rad/s; commit is held above this. 0 = motion gate off. */
    var maxCommitPanRateRadPerSec: Double = 0.0

    /** Fraction of the session median; below it commit is held. 0 = off. */
    var minScoreFractionOfMedian: Double = 0.0

    /**
     * Forward-progress valve: after this many consecutive holds of the
     * SAME pending keyframe the policy commits regardless.  Mirrors the
     * C++ default (12); <= 0 disables the cap.
     */
    var maxConsecutiveHolds: Int = 12

    /**
     * True when at least one hold-producing gate is armed.  The engine
     * MUST check this before doing any policy work: with both gates at
     * 0 the shared C++ would answer COMMIT for every input anyway, so
     * skipping the call keeps the disabled path byte-identical to
     * pre-v0.23 (no JNI crossing, no pan-rate tracking, no median
     * bookkeeping on the producer thread).
     */
    val admissionEnabled: Boolean
        get() = maxCommitPanRateRadPerSec > 0.0 || minScoreFractionOfMedian > 0.0

    /**
     * Decide whether the pending keyframe may be committed.
     *
     * @param candidateScore    sharpness of the buffered best; <= 0 =
     *                          unknown (softness floor skipped).
     * @param panRateRadPerSec  magnitude of the device's angular rate;
     *                          < 0 = unknown (motion gate skipped).
     * @param consecutiveHolds  how many times THIS pending keyframe has
     *                          already been held.
     */
    fun admit(
        candidateScore: Double,
        panRateRadPerSec: Double,
        consecutiveHolds: Int,
    ): Admission {
        val ordinal = nativeAdmitKeyframe(
            maxCommitPanRateRadPerSec,
            minScoreFractionOfMedian,
            maxConsecutiveHolds,
            candidateScore,
            nativeMedianValue(nativeHandle),
            panRateRadPerSec,
            consecutiveHolds,
        )
        val values = Admission.values()
        // An out-of-range ordinal can only mean a C++/Kotlin enum
        // skew; fail open rather than throwing on the producer thread.
        return if (ordinal in values.indices) values[ordinal] else Admission.COMMIT
    }

    /**
     * Record one COMMITTED keyframe's sharpness into the running
     * median the softness floor calibrates against.  Non-positive
     * scores are dropped natively (they carry no information).
     */
    fun recordAccepted(score: Double) = nativeMedianAdd(nativeHandle, score)

    /** Median of the accepted scores so far; 0.0 = no history yet. */
    val medianScore: Double get() = nativeMedianValue(nativeHandle)

    /** How many accepted scores are in the window. */
    val historyCount: Int get() = nativeMedianCount(nativeHandle)

    /** Start-of-capture / cancel: the previous capture's scene is gone. */
    fun resetHistory() = nativeMedianReset(nativeHandle)

    // ── JNI surface (blur_policy_jni.cpp) ───────────────────────

    private external fun nativeMedianCreate(capacity: Int): Long
    private external fun nativeMedianDestroy(handle: Long)
    private external fun nativeMedianAdd(handle: Long, score: Double)
    private external fun nativeMedianValue(handle: Long): Double
    private external fun nativeMedianCount(handle: Long): Int
    private external fun nativeMedianReset(handle: Long)
    private external fun nativeAdmitKeyframe(
        maxCommitPanRateRadPerSec: Double,
        minScoreFractionOfMedian: Double,
        maxConsecutiveHolds: Int,
        candidateScore: Double,
        sessionMedianScore: Double,
        panRateRadPerSec: Double,
        consecutiveHolds: Int,
    ): Int

    companion object {
        /// Matches the C++ default: 8 covers a typical 6-keyframe pano
        /// plus slack, so the median tracks THIS capture's scene.
        private const val MEDIAN_CAPACITY = 8

        init {
            // Same shim KeyframeGate / SharpnessWindow load;
            // System.loadLibrary is idempotent so class-init order
            // doesn't matter.
            // v0.24.4 — non-throwing; the instance init requires it.
            NativeLibraryLoader.tryLoad()
        }
    }
}
