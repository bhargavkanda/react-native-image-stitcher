// SPDX-License-Identifier: Apache-2.0
//
// ⚠ THE SWEEP THAT HAD PERFECT ATTITUDE AND REFUSED EVERY FRAME.
//
// Measured on a Galaxy A35, 2026-09-18. A live AR sweep whose tracker never
// bootstrapped:
//
//   * ARCore reported trackingState=PAUSED on all 175 frames, with
//     INSUFFICIENT_LIGHT from 2.00 s in. The pose sink admits TRACKING poses
//     only, so all 174 were dropped and the AR ring stayed empty.
//
//     ⚠ THAT LABEL IS NOT A PHOTOMETER READING, and calling it one is a
//     mistake this repo has already made and written down. Across the 17
//     sidecars on disk, ISO p50 spans a 64x range on packs carrying it and a
//     capture 3.3 stops DARKER tracked cleanly. It is what ARCore latches
//     when its one-shot motion-tracking bootstrap fails to converge inside a
//     fixed ~2 s window — a COUNT of frames, not a clock and not a light
//     meter.
//   * `arArmActive` had exactly one assignment (:2527) and no clear, and the
//     per-frame fork tested it BEFORE the IMU branch — so the IMU ring was
//     structurally unreachable for the rest of the sweep.
//   * All 120 frames refused `buffer-empty`, tracking stayed 0, the engine's
//     reference latch never armed, and the sweep painted NOTHING.
//
// And beside it, untouched: 858 rotation-vector samples at 121.6 Hz, accuracy
// 3 on every one, a derived basis (index 8) and a passing clock gate.
// Re-joining that pack offline solves all 120 frames at a ~8.2 ms bracket
// against a 25 ms bound. The attitude was there the whole time.
//
// `shouldDegradeArToImu` is the rule that gives the arm up. Every term in it
// is a SAFETY property, and these cases pin each one against the specific way
// it could go wrong — most of all the one-way term, because the arm decision
// is made once on purpose ("a sweep that switched arms mid-way would produce a
// quaternion series that is not comparable with itself") and this must depend
// on that rule rather than breach it.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusArImuFallbackTest {

    /** The failing pack's own numbers, at the moment the degrade should fire:
     *  ARCore has latched a failure reason and the IMU ring is healthy. */
    private fun theFailingSweep(
        minFramesFloor: Int = DEFAULT_AR_IMU_FALLBACK_FRAMES,
        arPosesAccepted: Long = 0L,
        arFramesSolved: Long = 0L,
        framesWithNoPose: Long = DEFAULT_AR_IMU_FALLBACK_FRAMES.toLong(),
        arcoreVerdictLatched: Boolean = true,
        nsSinceStart: Long = 2_100_000_000L,
        graceNs: Long = (DEFAULT_AR_IMU_FALLBACK_GRACE_MS * 1_000_000.0).toLong(),
        attitudeMapping: Boolean = true,
        haveBasis: Boolean = true,
        imuRingSamples: Long = 858L,
    ) = shouldDegradeArToImu(
        minFramesFloor = minFramesFloor,
        arPosesAccepted = arPosesAccepted,
        arFramesSolved = arFramesSolved,
        framesWithNoPose = framesWithNoPose,
        arcoreVerdictLatched = arcoreVerdictLatched,
        nsSinceStart = nsSinceStart,
        graceNs = graceNs,
        attitudeMapping = attitudeMapping,
        haveBasis = haveBasis,
        imuRingSamples = imuRingSamples,
    )

    @Test
    fun `fires on the sweep that actually failed`() {
        assertTrue(theFailingSweep())
    }

    // ── THE BOOTSTRAP WINDOW — THE REGRESSION THIS REWRITE EXISTS FOR ───
    //
    // The first version triggered on a frame COUNT and fired at 30 frames.
    // Measured on the verification run: that was ~950 ms of ARCore output, at
    // pose ~28 of the first 60 — every one of which was PAUSED with reason
    // NONE, i.e. ARCore still bootstrapping and reporting no fault. The repo
    // had already measured the window at ~2 s across 17 sidecars. Since the
    // degrade is one-way, firing there discards a healthy arm permanently.

    @Test
    fun `does NOT fire while ARCore is still bootstrapping and reporting no fault`() {
        // Reason has not latched, and we are inside the ~2 s window.
        assertFalse(
            theFailingSweep(
                arcoreVerdictLatched = false,
                nsSinceStart = 1_000_000_000L,
                framesWithNoPose = 10_000L,   // frames alone must not carry it
            ),
        )
    }

    @Test
    fun `fires as soon as ARCore itself reports a failure`() {
        // ARCore's verdict is a DECISION, not a timeout: the repo's study
        // found the label contiguous to the last row in 13 of 13 packs and
        // never returning to NONE. So it is safe to act on immediately.
        assertTrue(theFailingSweep(arcoreVerdictLatched = true, nsSinceStart = 2_100_000_000L))
    }

    @Test
    fun `fires on the backstop when ARCore never reports any reason at all`() {
        // The shape a 25-frame run on this phone showed: 32 rows of PAUSED
        // with reason NONE and nothing else, ever.
        assertTrue(
            theFailingSweep(arcoreVerdictLatched = false, nsSinceStart = 4_100_000_000L),
        )
    }

    @Test
    fun `holds just under the backstop`() {
        assertFalse(
            theFailingSweep(arcoreVerdictLatched = false, nsSinceStart = 3_900_000_000L),
        )
    }

    // ── THE FLOOR IS A FLOOR, NOT A TRIGGER ─────────────────────────────

    @Test
    fun `will not fire below the frame floor even when ARCore has already given up`() {
        // The earliest rows of a session are where a transient reason can
        // appear before the bootstrap has finished.
        assertFalse(theFailingSweep(framesWithNoPose = DEFAULT_AR_IMU_FALLBACK_FRAMES - 1L))
    }

    @Test
    fun `zero disables it outright`() {
        assertFalse(
            theFailingSweep(minFramesFloor = 0, framesWithNoPose = 10_000L),
        )
    }

    @Test
    fun `a negative frame budget cannot enable it`() {
        assertFalse(theFailingSweep(minFramesFloor = -5, framesWithNoPose = 10_000L))
    }

    // ── THE ONE-WAY TERMS ───────────────────────────────────────────────

    @Test
    fun `never fires once a single AR pose has been accepted`() {
        assertFalse(theFailingSweep(arPosesAccepted = 1L))
    }

    @Test
    fun `never fires once a single frame has SOLVED against the AR ring`() {
        // The thread-local half of the invariant. `arPoseAccepted` is written
        // by the ARCore pump thread after the ring insert, so a reader on the
        // writer thread can momentarily see a ring one sample ahead of the
        // counter. That window cannot actually produce a mixed series — a
        // one-sample ring only solves on a bit-exact timestamp match, measured
        // 0 times in 738 on this device — but `arFramesSolved` is incremented
        // inside solveArPose on the writer thread itself, so it states the
        // property directly instead of via a four-step argument.
        assertFalse(theFailingSweep(arFramesSolved = 1L))
    }

    @Test
    fun `never fires for a healthy arm even very late in a long sweep`() {
        assertFalse(
            theFailingSweep(
                arPosesAccepted = 3_000L,
                arFramesSolved = 2_900L,
                framesWithNoPose = 100_000L,
                nsSinceStart = 60_000_000_000L,
            ),
        )
    }

    // ── NEVER DEGRADE INTO AN ARM THAT CANNOT ANSWER EITHER ─────────────

    @Test
    fun `refuses when the attitude map is not active`() {
        assertFalse(theFailingSweep(attitudeMapping = false))
    }

    @Test
    fun `refuses when there is no basis to apply`() {
        assertFalse(theFailingSweep(haveBasis = false))
    }

    @Test
    fun `refuses when the IMU ring is empty too`() {
        assertFalse(theFailingSweep(imuRingSamples = 0L))
    }

    @Test
    fun `fires on a single IMU sample — the ring only has to be non-empty`() {
        assertTrue(theFailingSweep(imuRingSamples = 1L))
    }
}
