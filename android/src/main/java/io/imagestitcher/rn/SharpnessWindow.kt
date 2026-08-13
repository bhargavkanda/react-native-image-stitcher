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

    // v0.24.4 — see KeyframeGate: fail legibly at construction rather
    // than with a bare UnsatisfiedLinkError from nativeCreate().
    init { NativeLibraryLoader.require() }

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

    /// Kotlin-side mirror of the machine's K, kept only so
    /// [reopenKeepingBest] can apply the same K <= 1 guard the iOS
    /// bridge does without a JNI accessor.  Clamped like the C++.
    private var windowSize: Int = 4

    /**
     * Reconfigure K (total candidates per accepted keyframe) between
     * captures.  Resets any open window.  Clamped to >= 1 natively.
     */
    fun setWindowSize(k: Int) {
        windowSize = k.coerceAtLeast(1)
        nativeSetWindowSize(nativeHandle, k)
    }

    /**
     * v0.23 (anti-blur admission) — RE-OPEN the window around the SAME
     * buffered best after the admission policy HELD a CLOSE_AND_SAVE.
     *
     * A hold means "this keyframe is not committable yet"; keeping the
     * window open is what makes the hold FREE — the frames that arrive
     * while the operator steadies keep flowing in as candidates and can
     * still beat the held best.  Feeding the machine an accept event
     * carrying its OWN current best score restores the K−1 candidate
     * slots without disturbing the streaming max, so no platform-side
     * window state has to be invented alongside the shared machine.
     * The caller keeps its buffered frame — there is no new frame here.
     *
     * Returns false (and changes nothing) when the window is still
     * open, when K == 1, or when nothing has been scored yet: in each
     * of those the hold would have nowhere to live and the caller must
     * commit instead.
     *
     * Parity: 1:1 with SharpnessWindowBridge.mm's `reopenKeepingBest`.
     */
    fun reopenKeepingBest(): Boolean {
        // Refuse anything that isn't the documented post-CLOSE_AND_SAVE
        // state.  On an OPEN window an accept event means
        // FLUSH_THEN_OPEN — it would tell the caller to save a previous
        // best that doesn't exist.  K == 1 never opens a window at all,
        // and a best score of -1 means nothing has been scored since
        // reset().
        val best = nativeBestScore(nativeHandle)
        // `!(best > 0.0)` rather than `best <= 0.0`: NaN compares false
        // to BOTH, so the `<=` spelling would let a degenerate score
        // through and re-open the window, while iOS's guard refuses it
        // and commits. Identical inputs must produce identical decisions
        // on both platforms (v0.23 adversarial review).
        if (nativeIsOpen(nativeHandle) || windowSize <= 1 || !(best > 0.0)) {
            return false
        }
        // novelty = -1 / threshold = 0 keep the drift guard out of a
        // seed event (it only inspects candidates anyway).
        val packed = nativeIngest(nativeHandle, true, best, -1.0, 0.0)
        return (packed and 0xFF) == Action.OPEN_WINDOW.ordinal
    }

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
            // v0.24.4 — non-throwing; the instance init requires it.
            NativeLibraryLoader.tryLoad()
        }
    }
}
