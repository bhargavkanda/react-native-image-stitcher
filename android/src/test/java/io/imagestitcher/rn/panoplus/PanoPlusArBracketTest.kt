// SPDX-License-Identifier: Apache-2.0
//
// ⚠ THE ARITHMETIC THAT MADE THE AR ARM INCAPABLE OF OUTPUT.
//
// The AR pose ring inherited the IMU ring's 25 ms bracket limit. ARCore emits
// one pose per CAMERA frame — measured 33.4-33.8 ms apart on 17 packs spanning
// 2026-08-24 to 2026-09-10 — so the two poses straddling any frame are ~33.8 ms
// apart, 33.8 > 25, and solve() refused EVERY frame as bracket-too-wide.
//
// The operator's last attempt, with the arm working perfectly on its own terms:
// ARCore TRACKING on 184 of 208 poses, 183 accepted into the ring, 174 frames
// waited for a pose and NONE timed out, and framesSolved = 0 with 175
// bracket-too-wide. Every ledger row warming-up. Canvas empty. His words:
// "Tried capturing in AR, it never starts. Just stuck in waiting for AR
// tracking state."
//
// These tests pin the arithmetic, not the implementation, because the defect
// was a number and only a number.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusArBracketTest {

    /** The measured ARCore pose interval, worst case across all 17 packs. */
    private val arcorePoseIntervalMs = 33.8
    /** The measured p90 on the noisiest pack. */
    private val arcorePoseP90Ms = 35.0

    @Test
    fun `the IMU limit cannot bracket an ARCore pose pair — the defect, pinned`() {
        // If this ever passes, the AR arm regressed back to silent refusal.
        assertTrue(
            "25 ms cannot span a 33.8 ms ARCore bracket — this is why the arm produced nothing",
            arcorePoseIntervalMs > DEFAULT_ATTITUDE_MAX_BRACKET_MS,
        )
    }

    @Test
    fun `the AR limit clears the measured pose interval, and its p90`() {
        assertTrue(
            "the AR bracket limit must span two consecutive ARCore poses",
            DEFAULT_AR_ATTITUDE_MAX_BRACKET_MS > arcorePoseIntervalMs,
        )
        assertTrue(
            "and must clear the p90, or a jittery device refuses a tenth of its frames",
            DEFAULT_AR_ATTITUDE_MAX_BRACKET_MS > arcorePoseP90Ms,
        )
    }

    @Test
    fun `a genuine ARCore dropout is still refused`() {
        // One MISSED pose doubles the bracket. That is a real fault and must not
        // be silently interpolated across — which is the whole reason the limit
        // is widened rather than removed.
        val oneMissedPoseMs = arcorePoseIntervalMs * 2
        assertTrue(
            "a dropped ARCore pose must still be refused, not SLERPed over",
            oneMissedPoseMs > DEFAULT_AR_ATTITUDE_MAX_BRACKET_MS,
        )
    }

    @Test
    fun `the two rings keep SEPARATE limits`() {
        // Widening the IMU's instead would accept a 50 ms gap in a 122 Hz series
        // — six missing samples, a real fault worth refusing.
        assertTrue(
            "the IMU ring must stay tight; it is fed at ~122 Hz, i.e. 8.2 ms apart",
            DEFAULT_ATTITUDE_MAX_BRACKET_MS < DEFAULT_AR_ATTITUDE_MAX_BRACKET_MS,
        )
        val imuIntervalMs = 8.2
        assertTrue(
            "25 ms is three IMU samples of slack, which is the point of the tighter limit",
            DEFAULT_ATTITUDE_MAX_BRACKET_MS > imuIntervalMs * 2,
        )
    }
}
