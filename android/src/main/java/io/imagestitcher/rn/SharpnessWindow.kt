// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * Kotlin facade over the shared C++ SharpnessWindowMachine
 * (react-native-image-stitcher/cpp/sharpness_window.{hpp,cpp}) — the
 * pick-sharpest-in-window DECISION machine.
 *
 * Architecture parity with iOS:
 *   iOS wraps the same C++ class via SharpnessWindowBridge.mm; this
 *   facade is the Android equivalent (JNI plumbing in
 *   android/src/main/cpp/sharpness_window_jni.cpp).  ALL window
 *   decisions — open / replace / keep / close / flush-then-open,
 *   including the overlap-drift guard — live in the shared C++
 *   (gtest-covered in cpp/tests/sharpness_window_test.cpp), so the
 *   two platforms cannot drift.  The engine only buffers frames and
 *   acts on the returned action.
 *
 * Lifecycle:
 *   Owns one C++ machine via a `Long` opaque handle; [close] releases
 *   it (called from IncrementalStitcher.onCatalystInstanceDestroy,
 *   same as KeyframeGate).
 *
 * Threading:
 *   The underlying C++ class is NOT thread-safe.  The engine
 *   serialises every call under its window lock.
 */
internal class SharpnessWindow : AutoCloseable {

    private val nativeHandle: Long = nativeCreate()

    @Volatile private var closed: Boolean = false

    override fun close() {
        if (!closed) {
            closed = true
            nativeDestroy(nativeHandle)
        }
    }

    // Defensive net for missed close() calls — same rationale as
    // KeyframeGate.finalize().  Always prefer explicit close().
    @Suppress("DEPRECATION")
    protected fun finalize() {
        close()
    }

    /** 1:1 with retailens::SharpnessWindowAction (pinned by the JNI). */
    enum class Action {
        NONE,
        SAVE_IMMEDIATELY,
        OPEN_WINDOW,
        FLUSH_THEN_OPEN,
        REPLACE_BEST,
        KEEP_BEST,
        CLOSE_AND_SAVE,
    }

    /**
     * One per-frame decision.
     *
     * @property action      what the engine must do with this frame /
     *                       the buffered best.
     * @property replaceBest THIS frame must become the buffered best
     *                       (frame + pose) BEFORE acting on [action].
     * @property driftClosed a CLOSE_AND_SAVE was triggered by the
     *                       overlap-drift guard (candidate novelty >
     *                       overlapThreshold / 2), not slot exhaustion.
     */
    data class Decision(
        val action: Action,
        val replaceBest: Boolean,
        val driftClosed: Boolean,
    )

    /**
     * Reconfigure K (total candidates per accepted keyframe) between
     * captures.  Resets any open window.  Clamped to >= 1 natively.
     */
    fun setWindowSize(k: Int) = nativeSetWindowSize(nativeHandle, k)

    /**
     * Feed one gate-evaluated frame.
     *
     * @param isAccept          the gate ACCEPTED this frame.
     * @param score             the frame's sharpness score
     *                          (nativeSharpnessScore).
     * @param noveltyFraction   the gate decision's newContentFraction;
     *                          -1.0 when the gate didn't compute one
     *                          (never triggers the drift guard).
     * @param overlapThreshold  the gate's accept threshold; the drift
     *                          guard fires at half of it.
     */
    fun ingest(
        isAccept: Boolean,
        score: Double,
        noveltyFraction: Double,
        overlapThreshold: Double,
    ): Decision {
        val packed = nativeIngest(
            nativeHandle, isAccept, score, noveltyFraction, overlapThreshold)
        // Packing contract (see sharpness_window_jni.cpp): bits 0-7 =
        // action ordinal, bit 8 = replaceBest, bit 9 = driftClosed.
        val ordinal = packed and 0xFF
        val actions = Action.values()
        val action = if (ordinal in actions.indices) actions[ordinal] else Action.NONE
        return Decision(
            action = action,
            replaceBest = (packed and 0x100) != 0,
            driftClosed = (packed and 0x200) != 0,
        )
    }

    /**
     * Finalize-time flush: closes any open window.  `true` = a best
     * candidate is pending and MUST be committed (the trailing
     * keyframe).  Idempotent.
     */
    fun drain(): Boolean = nativeDrain(nativeHandle)

    /** Cancel / start-of-capture: discard any open window. */
    fun reset() = nativeReset(nativeHandle)

    val isOpen: Boolean get() = nativeIsOpen(nativeHandle)

    /** Best score of the current window; sticky after close until reset. */
    val bestScore: Double get() = nativeBestScore(nativeHandle)

    // ── JNI surface (sharpness_window_jni.cpp) ──────────────────

    private external fun nativeCreate(): Long
    private external fun nativeDestroy(handle: Long)
    private external fun nativeSetWindowSize(handle: Long, k: Int)
    private external fun nativeIngest(
        handle: Long,
        isAccept: Boolean,
        score: Double,
        noveltyFraction: Double,
        overlapThreshold: Double,
    ): Int
    private external fun nativeDrain(handle: Long): Boolean
    private external fun nativeReset(handle: Long)
    private external fun nativeIsOpen(handle: Long): Boolean
    private external fun nativeBestScore(handle: Long): Double

    companion object {
        init {
            // Same shim KeyframeGate loads; System.loadLibrary is
            // idempotent so class-init order doesn't matter.
            System.loadLibrary("image_stitcher")
        }
    }
}
