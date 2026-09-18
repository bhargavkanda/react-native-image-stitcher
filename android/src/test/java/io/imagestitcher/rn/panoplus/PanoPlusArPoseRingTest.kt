// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusArPoseRingTest.kt — THE AR ARM'S RING, AT THE CADENCE IT ACTUALLY
// RUNS AT.
//
// ── WHY THIS SUITE EXISTS AND WHAT IT IS REALLY ABOUT ───────────────────────
//
// The AR pose arm (2026-09-02) reuses `PanoAttitudeRing` — the same bracket +
// SLERP the IMU arm uses — and that reuse is correct but NOT free, because the
// two arms feed it at completely different rates against the same 30 fps
// frames:
//
//   IMU arm    TYPE_ROTATION_VECTOR at ~122 Hz. A sample NEWER than any frame
//              is essentially always already in the ring, so `solve()` finds a
//              bracket on the first try and the interpolation is over ~8 ms.
//
//   AR arm     ARCore at the CAMERA's own ~30 Hz, produced by the SAME capture
//              that produced the frame's pixels, on a different thread. Whether
//              the newer half of the bracket has landed when the writer thread
//              reaches this frame is a RACE, and losing it returns
//              `after-last-sample` — a frame with a perfectly good pose 3 ms in
//              its future, painted from the identity.
//
// That race is why `Config.arPoseWaitMs` exists and why `solveArPose()` waits
// only for `after-last-sample`. This suite proves the ring's half of that
// contract on the JVM: it CANNOT prove the wait (that needs the recorder's
// threads and a live ARCore pump — device work), but it can prove exactly what
// the wait is waiting FOR, and that the two refusals it deliberately does NOT
// wait for are unwaitable by construction.
//
// ⚠ WHAT NO TEST HERE CAN CHECK. That ARCore's `Camera.getPose()` is in the
// engine's own `world<-camera` convention — the claim that makes the AR arm
// apply NO basis. That is a fact about ARCore's API, corroborated by
// `selectBasis()` being written to fit the rotation-vector series ONTO this one
// (cpp/rnis_pano_android_s1.hpp), and it is falsifiable only by a sweep: a
// wrong convention rotates the whole canvas, visibly, on the first pan.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val MS = 1_000_000L

/** ~30 fps, the rate BOTH the ARCore pump and the camera run at in shared mode. */
private const val FRAME_NS = 33_333_333L

/** The bracket bound the recorder passes (`attitudeMaxBracketMs`, default 120). */
private const val MAX_BRACKET_NS = 120L * MS

/** Rotation about +Y by `deg`, as [x,y,z,w] — the engine's order, and the order
 *  the sink hands over (`Pose.getRotationQuaternion()` is xyzw too). A yaw is
 *  the right stand-in: it is what a horizontal shelf sweep actually is. */
private fun yaw(deg: Double): DoubleArray {
    val h = Math.toRadians(deg) / 2.0
    return doubleArrayOf(0.0, Math.sin(h), 0.0, Math.cos(h))
}

/** The yaw angle back out of a quaternion, in degrees. */
private fun yawOf(q: DoubleArray): Double =
    Math.toDegrees(2.0 * Math.atan2(q[1], q[3]))

class PanoPlusArPoseRingTest {

    // ════════════════════════════════════════════════════════════════════
    //  1.  The race the wait exists for
    // ════════════════════════════════════════════════════════════════════

    @Test
    fun `a frame newer than the newest ARCore pose refuses, and does not extrapolate`() {
        val ring = PanoAttitudeRing()
        // Four poses at 30 Hz, a steady 6 deg/frame pan — 180 deg/s, a brisk
        // but ordinary shelf sweep.
        for (i in 0 until 4) {
            val q = yaw(i * 6.0)
            assertTrue(ring.add(i * FRAME_NS, q[0], q[1], q[2], q[3]))
        }
        // The frame for the NEXT capture arrives before its pose does. This is
        // the ~50% case on hardware, not an edge case.
        val sol = ring.solve(4 * FRAME_NS, MAX_BRACKET_NS)
        assertFalse(sol.ok)
        assertEquals(PanoAttitudeRefusal.AFTER_LAST_SAMPLE, sol.refusal)
        // ⚠ AND THE QUATERNION IS THE IDENTITY, not the last sample clamped.
        // Clamping would hand the engine a frozen attitude it cannot tell from
        // a still phone, and the strip would advance by zero while the operator
        // panned — a seam with no cause anywhere in the log.
        assertEquals(1.0, sol.q[3], 1e-12)
        assertEquals(0.0, sol.q[1], 1e-12)
    }

    @Test
    fun `the same frame resolves once the pose lands — this is what the wait buys`() {
        val ring = PanoAttitudeRing()
        for (i in 0 until 4) {
            val q = yaw(i * 6.0)
            ring.add(i * FRAME_NS, q[0], q[1], q[2], q[3])
        }
        val target = 4 * FRAME_NS - 1L * MS      // 1 ms before the next pose
        assertFalse(ring.solve(target, MAX_BRACKET_NS).ok)

        // The pump delivers. `solveArPose` re-solves inside its wait loop for
        // exactly this reason — the notify is a hint, the re-solve is the test.
        val q4 = yaw(24.0)
        ring.add(4 * FRAME_NS, q4[0], q4[1], q4[2], q4[3])

        val sol = ring.solve(target, MAX_BRACKET_NS)
        assertTrue(sol.ok)
        assertEquals(PanoAttitudeRefusal.NONE, sol.refusal)
        // SLERPed, not snapped: 1 ms before the 24 deg sample, 32.33 ms after
        // the 18 deg one, so alpha ~0.97 and the yaw lands just under 24 deg.
        assertEquals(0.97, sol.alpha, 0.01)
        assertEquals(23.82, yawOf(sol.q), 0.05)
    }

    // ════════════════════════════════════════════════════════════════════
    //  2.  The two refusals `solveArPose` deliberately does NOT wait for
    // ════════════════════════════════════════════════════════════════════

    @Test
    fun `before-first-sample is unwaitable — no future pose can bracket a past frame`() {
        val ring = PanoAttitudeRing()
        // ARCore resumes late: its first pose is a full second after the
        // recorder's first frames. Every frame before it is unrecoverable, and
        // waiting on them would spend the budget on a certainty — 33 ms of
        // dead time per frame, on the thread that also runs the engine.
        for (i in 0 until 4) {
            val q = yaw(i * 6.0)
            ring.add(1_000L * MS + i * FRAME_NS, q[0], q[1], q[2], q[3])
        }
        val sol = ring.solve(500L * MS, MAX_BRACKET_NS)
        assertFalse(sol.ok)
        assertEquals(PanoAttitudeRefusal.BEFORE_FIRST_SAMPLE, sol.refusal)
        // And it STAYS refused however many poses arrive afterwards.
        val q = yaw(99.0)
        ring.add(2_000L * MS, q[0], q[1], q[2], q[3])
        assertEquals(
            PanoAttitudeRefusal.BEFORE_FIRST_SAMPLE,
            ring.solve(500L * MS, MAX_BRACKET_NS).refusal,
        )
    }

    @Test
    fun `bracket-too-wide is unwaitable — a later pose cannot narrow a past gap`() {
        val ring = PanoAttitudeRing()
        val a = yaw(0.0)
        ring.add(0L, a[0], a[1], a[2], a[3])
        // A tracking dropout: the sink admits TRACKING poses only, so a lost
        // second of tracking is a second-wide hole in the ring.
        val b = yaw(60.0)
        ring.add(1_000L * MS, b[0], b[1], b[2], b[3])

        val sol = ring.solve(500L * MS, MAX_BRACKET_NS)
        assertFalse(sol.ok)
        assertEquals(PanoAttitudeRefusal.BRACKET_TOO_WIDE, sol.refusal)
        // The gap is already in the past; nothing arriving later changes it.
        val c = yaw(66.0)
        ring.add(1_033L * MS, c[0], c[1], c[2], c[3])
        assertEquals(
            PanoAttitudeRefusal.BRACKET_TOO_WIDE,
            ring.solve(500L * MS, MAX_BRACKET_NS).refusal,
        )
    }

    // ════════════════════════════════════════════════════════════════════
    //  3.  The two arms cannot contaminate each other
    // ════════════════════════════════════════════════════════════════════

    @Test
    fun `the AR ring and the IMU ring are independent series`() {
        // The recorder keeps TWO rings on purpose. `sensors.jsonl` is still
        // written on an AR sweep — that is what lets ONE pack replay on BOTH
        // arms offline, which is the comparison the operator asked for — so
        // both are being fed at once, at different rates, with different
        // conventions, and a shared buffer would interleave them into a series
        // that is neither.
        val imu = PanoAttitudeRing()
        val ar = PanoAttitudeRing()
        // 122 Hz vs 30 Hz, same 100 ms window.
        var t = 0L
        while (t <= 100L * MS) {
            val q = yaw(t / 1e6 * 0.18)          // 180 deg/s
            imu.add(t, q[0], q[1], q[2], q[3])
            t += 8_196_721L                       // 122 Hz
        }
        for (i in 0..3) {
            val q = yaw(i * FRAME_NS / 1e6 * 0.18)
            ar.add(i * FRAME_NS, q[0], q[1], q[2], q[3])
        }
        assertEquals(13L, imu.sampleCount())
        assertEquals(4L, ar.sampleCount())

        // Mid-window both agree on the ANGLE — same motion, sampled twice —
        // which is what makes the offline A/B meaningful at all. The AR
        // bracket is four times wider, which is the cost being measured.
        val at = 50L * MS
        val si = imu.solve(at, MAX_BRACKET_NS)
        val sa = ar.solve(at, MAX_BRACKET_NS)
        assertTrue(si.ok)
        assertTrue(sa.ok)
        assertEquals(yawOf(si.q), yawOf(sa.q), 0.01)
        assertTrue(sa.bracketGapS > si.bracketGapS * 3.0)
    }

    @Test
    fun `a non-monotonic ARCore timestamp is rejected and counted, never reordered`() {
        // ARCore's pump is one thread and its timestamps should climb, but the
        // ring is the only thing that can PROVE it — and a recorder that
        // silently sorted would hide a real fault behind a plausible series.
        val ring = PanoAttitudeRing()
        val a = yaw(0.0)
        ring.add(2 * FRAME_NS, a[0], a[1], a[2], a[3])
        val b = yaw(6.0)
        assertFalse(ring.add(FRAME_NS, b[0], b[1], b[2], b[3]))
        assertEquals(1L, ring.sampleCount())
        assertEquals(1L, ring.nonMonotonicCount())
    }
}
