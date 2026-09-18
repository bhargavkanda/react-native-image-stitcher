// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusAttitudeMapTest.kt — the five places `q` can be silently wrong.
//
// Every case below produces a UNIT QUATERNION whichever way it goes, which is
// the whole problem: a swapped [w,x,y,z], a reversed multiplication, a
// nearest-neighbour instead of a SLERP and a clamped extrapolation all look
// exactly like a correct attitude in every scalar diagnostic a pack carries.
// The only thing that separates them is an independently-computed expected
// value, so the matrices below are worked out by hand in the comments rather
// than being produced by the functions under test.
//
// ⚠ WHAT THIS SUITE CANNOT DO. It cannot check that index 8 is the RIGHT basis
// for the A35 — that is a claim about how Samsung mounted the sensor, and only
// the ARCore falsification sweep can answer it
// (rnis_pano_android_basis.hpp's FALSIFICATION section). What it checks is
// that whatever index wins is APPLIED the way the engine applies it, and that
// a sweep with no authority for one writes the identity instead.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val EPS = 1e-12
private const val DEG_EPS = 1e-9

/** Rotation about +Z by 90°, row-major. Used as a stand-in for a basis: it is
 *  a signed axis permutation with det +1, which is exactly what the engine's
 *  24 candidates are. */
private val C_ROT_Z90 = doubleArrayOf(
    0.0, -1.0, 0.0,
    1.0, 0.0, 0.0,
    0.0, 0.0, 1.0,
)

/** Rotation about +X by 90°, row-major. Stands in for `R_imu`. */
private val R_ROT_X90 = doubleArrayOf(
    1.0, 0.0, 0.0,
    0.0, 0.0, -1.0,
    0.0, 1.0, 0.0,
)

/** `R_ROT_X90 · C_ROT_Z90`, multiplied out BY HAND — the engine's order. */
private val R_TIMES_C = doubleArrayOf(
    0.0, -1.0, 0.0,
    0.0, 0.0, -1.0,
    1.0, 0.0, 0.0,
)

/** `C_ROT_Z90 · R_ROT_X90`, by hand — the order it is NOT. */
private val C_TIMES_R = doubleArrayOf(
    0.0, 0.0, 1.0,
    1.0, 0.0, 0.0,
    0.0, 1.0, 0.0,
)

private fun assertMatEquals(expected: DoubleArray, actual: DoubleArray, tol: Double = 1e-12) {
    assertEquals("matrix size", 9, actual.size)
    for (i in 0 until 9) {
        assertEquals("m[$i]", expected[i], actual[i], tol)
    }
}

class PanoPlusAttitudeMapTest {

    // ── 1. THE QUATERNION ORDER ─────────────────────────────────────────

    @Test
    fun sensorOrderIsWxyzAndTheEngineOrderIsXyzw() {
        // SensorManager.getQuaternionFromVector fills [w, x, y, z]. The pack's
        // `q`, FrameInput::q and every rnis::pano helper use [x, y, z, w].
        // Four distinct values so a swapped PAIR cannot pass by symmetry.
        val fromSensor = floatArrayOf(0.1f, 0.2f, 0.3f, 0.4f)   // w, x, y, z
        val q = panoQuatFromSensorWxyz(fromSensor)
        assertEquals(0.2, q[0], 1e-7)   // x
        assertEquals(0.3, q[1], 1e-7)   // y
        assertEquals(0.4, q[2], 1e-7)   // z
        assertEquals(0.1, q[3], 1e-7)   // w
    }

    @Test
    fun theIdentityRotationIsWOneNotXOne() {
        // The classic symptom of the swap: an untouched device reads as a 180°
        // rotation about x. Pinning it here means the swap cannot come back as
        // "the phone was upside down".
        val q = panoQuatFromSensorWxyz(floatArrayOf(1.0f, 0.0f, 0.0f, 0.0f))
        assertEquals(0.0, panoQuatAngleDeg(q), DEG_EPS)
        assertMatEquals(
            doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
            panoQuatToMat(q),
        )
    }

    // ── 2. THE MULTIPLICATION ORDER ─────────────────────────────────────

    @Test
    fun matMulIsRowMajorAndAgreesWithTheHandComputedProduct() {
        assertMatEquals(R_TIMES_C, panoMatMul(R_ROT_X90, C_ROT_Z90))
        assertMatEquals(C_TIMES_R, panoMatMul(C_ROT_Z90, R_ROT_X90))
    }

    @Test
    fun applyBasisIsRimuTimesCNotCTimesRimu() {
        // rnis_pano_attitude.cpp: matMul(Rimu, basis_, Reng) — the basis is on
        // the RIGHT. Both products are unit quaternions describing legitimate
        // rotations, so nothing but this assertion distinguishes them.
        val qImu = panoMatToQuat(R_ROT_X90)
        val got = panoQuatToMat(panoApplyBasis(qImu, C_ROT_Z90))
        assertMatEquals(R_TIMES_C, got, 1e-9)
        // And the two really do differ, so the assertion above has teeth.
        assertTrue(
            "the two orders must differ for this test to mean anything",
            (0 until 9).any { Math.abs(R_TIMES_C[it] - C_TIMES_R[it]) > 0.5 },
        )
        assertNotEquals(
            0.0,
            panoQuatDeltaDeg(panoMatToQuat(R_TIMES_C), panoMatToQuat(C_TIMES_R)),
            1.0,
        )
    }

    @Test
    fun theIdentityBasisLeavesTheImuQuaternionAlone() {
        // Basis 0 (`+x+y+z`) is a legal candidate, so a build that quietly did
        // nothing would pass a test written only against it. This pins the
        // no-op case; the case above pins that it is not ALWAYS a no-op.
        val id = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        val qImu = panoMatToQuat(R_ROT_X90)
        assertEquals(0.0, panoQuatDeltaDeg(qImu, panoApplyBasis(qImu, id)), 1e-9)
    }

    @Test
    fun matToQuatSurvivesA180DegreeRotationWhereTheNaiveFormWouldNot() {
        // Several of the 24 candidates ARE 180° rotations, and the trace-only
        // form loses all its precision exactly there. diag(1, -1, -1) is a 180°
        // roll about x — the very rotation that separates basis 8 from 11.
        val m = doubleArrayOf(1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0)
        val q = panoMatToQuat(m)
        assertEquals(180.0, panoQuatAngleDeg(q), 1e-9)
        assertMatEquals(m, panoQuatToMat(q), 1e-12)
    }

    // ── 3. THE SLERP ────────────────────────────────────────────────────

    @Test
    fun slerpMidpointIsHalfTheAngle() {
        val q0 = doubleArrayOf(0.0, 0.0, 0.0, 1.0)
        val q1 = panoMatToQuat(C_ROT_Z90)                       // 90° about z
        val mid = panoQuatSlerp(q0, q1, 0.5)
        assertEquals(45.0, panoQuatAngleDeg(mid), 1e-9)
        assertEquals(1.0, Math.sqrt(mid.sumOfSquares()), EPS)
    }

    @Test
    fun slerpTakesTheShortestPathThroughTheAntipode() {
        // `q` and `-q` are the SAME rotation. Without the sign flip the
        // interpolation goes the long way round the 4-sphere — a 270° swing
        // across an 8 ms bracket, still unit, still finite, and wrong.
        val q0 = doubleArrayOf(0.0, 0.0, 0.0, 1.0)
        val q1raw = panoMatToQuat(C_ROT_Z90)
        val q1neg = doubleArrayOf(-q1raw[0], -q1raw[1], -q1raw[2], -q1raw[3])
        val mid = panoQuatSlerp(q0, q1neg, 0.5)
        assertEquals(45.0, panoQuatAngleDeg(mid), 1e-9)
    }

    @Test
    fun slerpEndpointsAreExact() {
        val q0 = doubleArrayOf(0.0, 0.0, 0.0, 1.0)
        val q1 = panoMatToQuat(R_ROT_X90)
        assertEquals(0.0, panoQuatDeltaDeg(q0, panoQuatSlerp(q0, q1, 0.0)), 1e-9)
        assertEquals(0.0, panoQuatDeltaDeg(q1, panoQuatSlerp(q0, q1, 1.0)), 1e-9)
    }

    // ── 4. THE BRACKET ──────────────────────────────────────────────────

    @Test
    fun theRingInterpolatesRatherThanSnappingToTheNearestSample() {
        // Two samples 10 ms apart spanning 90°; the frame lands 1 ms in.
        // SLERP answers 9°. NEAREST-NEIGHBOUR answers 0° — and at the ~122 Hz
        // this device delivers, that class of error is up to ~4 ms of motion
        // on every single row.
        val ring = PanoAttitudeRing(16)
        ring.add(0L, 0.0, 0.0, 0.0, 1.0)
        val q90 = panoMatToQuat(C_ROT_Z90)
        ring.add(10_000_000L, q90[0], q90[1], q90[2], q90[3])

        val s = ring.solve(1_000_000L, 25_000_000L)
        assertTrue(s.ok)
        assertEquals(PanoAttitudeRefusal.NONE, s.refusal)
        assertEquals(9.0, panoQuatAngleDeg(s.q), 1e-9)
        assertEquals(0.1, s.alpha, 1e-12)
        assertEquals(0.01, s.bracketGapS, 1e-12)
        assertEquals(90.0, s.slerpAngleDeg, 1e-9)
    }

    @Test
    fun aTargetOnASampleGivesThatSampleExactly() {
        val ring = PanoAttitudeRing(16)
        ring.add(0L, 0.0, 0.0, 0.0, 1.0)
        val q90 = panoMatToQuat(C_ROT_Z90)
        ring.add(10_000_000L, q90[0], q90[1], q90[2], q90[3])
        assertEquals(0.0, panoQuatAngleDeg(ring.solve(0L, 25_000_000L).q), 1e-9)
        assertEquals(90.0, panoQuatAngleDeg(ring.solve(10_000_000L, 25_000_000L).q), 1e-9)
    }

    @Test
    fun theBinarySearchFindsTheRightBracketAcrossManySamples() {
        // 200 samples at 8 ms, rotating 1° each. A search that picked the
        // wrong pair would still return a plausible quaternion.
        val ring = PanoAttitudeRing(512)
        for (i in 0 until 200) {
            val a = Math.toRadians(i.toDouble()) / 2.0
            ring.add(i * 8_000_000L, 0.0, 0.0, Math.sin(a), Math.cos(a))
        }
        // Halfway between sample 50 (50°) and sample 51 (51°).
        val s = ring.solve(50 * 8_000_000L + 4_000_000L, 25_000_000L)
        assertTrue(s.ok)
        assertEquals(50.5, panoQuatAngleDeg(s.q), 1e-9)
    }

    // ── 5. THE REFUSALS — every one named, none extrapolated ────────────

    @Test
    fun anEmptyRingRefusesRatherThanReturningTheIdentityAsAnAnswer() {
        val s = PanoAttitudeRing(8).solve(1L, 25_000_000L)
        assertFalse(s.ok)
        assertEquals(PanoAttitudeRefusal.BUFFER_EMPTY, s.refusal)
        // The identity IS what it hands back — but `ok` is false, so no caller
        // can mistake the placeholder for a measurement.
        assertEquals(0.0, panoQuatAngleDeg(s.q), DEG_EPS)
    }

    @Test
    fun aFrameBeforeTheFirstSampleIsRefusedNotClamped() {
        val ring = PanoAttitudeRing(8)
        ring.add(1_000_000_000L, 0.0, 0.0, 0.0, 1.0)
        ring.add(1_008_000_000L, 0.0, 0.0, 0.0, 1.0)
        val s = ring.solve(999_000_000L, 25_000_000L)
        assertFalse(s.ok)
        assertEquals(PanoAttitudeRefusal.BEFORE_FIRST_SAMPLE, s.refusal)
    }

    @Test
    fun aFrameAfterTheLastSampleIsRefusedNotExtrapolated() {
        // THE ONE THAT WOULD LOOK MOST NORMAL: a frame that arrives a
        // millisecond before its IMU sample. Clamping would hand back the
        // newest attitude on every such row and the series would look fine.
        val ring = PanoAttitudeRing(8)
        ring.add(1_000_000_000L, 0.0, 0.0, 0.0, 1.0)
        val s = ring.solve(1_000_001_000L, 25_000_000L)
        assertFalse(s.ok)
        assertEquals(PanoAttitudeRefusal.AFTER_LAST_SAMPLE, s.refusal)
    }

    @Test
    fun aBracketWiderThanTheBoundIsRefused() {
        val ring = PanoAttitudeRing(8)
        ring.add(0L, 0.0, 0.0, 0.0, 1.0)
        ring.add(40_000_000L, 0.0, 0.0, 0.0, 1.0)     // 40 ms apart
        val s = ring.solve(20_000_000L, 25_000_000L)  // bound is 25 ms
        assertFalse(s.ok)
        assertEquals(PanoAttitudeRefusal.BRACKET_TOO_WIDE, s.refusal)
        // The same target under a bound that admits it is accepted, so the
        // refusal is the BOUND's doing and not a broken search.
        assertTrue(ring.solve(20_000_000L, 50_000_000L).ok)
    }

    @Test
    fun theDefaultBoundIsTheEnginesOwnMaxBracketGap() {
        // rnis_pano_attitude.hpp: AttitudeAligner::Config::maxBracketGapS =
        // 0.025. A row this recorder accepts must be one the aligner would
        // grade tracking==2, or the pack and the engine disagree about which
        // frames had an attitude behind them.
        assertEquals(25.0, DEFAULT_ATTITUDE_MAX_BRACKET_MS, 0.0)
    }

    @Test
    fun theRingDropsTheOldestAndRefusesATargetItNoLongerHolds() {
        val ring = PanoAttitudeRing(4)
        for (i in 0 until 6) ring.add(i * 8_000_000L, 0.0, 0.0, 0.0, 1.0)
        assertEquals(6L, ring.sampleCount())
        // Samples 0 and 1 have been evicted; the window now starts at 2.
        assertEquals(
            PanoAttitudeRefusal.BEFORE_FIRST_SAMPLE,
            ring.solve(8_000_000L, 25_000_000L).refusal,
        )
        assertTrue(ring.solve(3 * 8_000_000L, 25_000_000L).ok)
    }

    @Test
    fun aNonMonotonicSampleIsRejectedAndCountedRatherThanReordered() {
        // The binary search's precondition is a strictly increasing series —
        // the engine's own buffer refuses the same thing. An out-of-order
        // sensor is a fact the pack should carry, not one to paper over.
        val ring = PanoAttitudeRing(8)
        assertTrue(ring.add(10_000_000L, 0.0, 0.0, 0.0, 1.0))
        assertFalse(ring.add(9_000_000L, 0.0, 0.0, 0.0, 1.0))
        assertFalse(ring.add(10_000_000L, 0.0, 0.0, 0.0, 1.0))
        assertEquals(1L, ring.sampleCount())
        assertEquals(2L, ring.nonMonotonicCount())
    }

    @Test
    fun aNonFiniteSampleNeverEntersTheRing() {
        val ring = PanoAttitudeRing(8)
        assertFalse(ring.add(1L, Double.NaN, 0.0, 0.0, 1.0))
        assertFalse(ring.add(2L, 0.0, Double.POSITIVE_INFINITY, 0.0, 1.0))
        assertEquals(0L, ring.sampleCount())
    }

    // ── 6. THE BASIS AUTHORITY LADDER ───────────────────────────────────

    @Test
    fun aMeasuredIndexOutranksADerivedOne() {
        val a = panoResolveBasisAuthority(3, 8, "none", 24)
        assertEquals(3, a.index)
        assertEquals(PANO_BASIS_AUTHORITY_MEASURED, a.authority)
        assertEquals(PANO_Q_SOURCE_MEASURED, a.qSource)
        // The loser is named, because the disagreement is the falsification.
        assertTrue(a.note.contains("8"))
    }

    @Test
    fun theDerivedIndexIsUsedWhenNoMeasurementWasSupplied() {
        val a = panoResolveBasisAuthority(-1, 8, "none", 24)
        assertEquals(8, a.index)
        assertEquals(PANO_BASIS_AUTHORITY_DERIVED, a.authority)
        assertEquals(PANO_Q_SOURCE_DERIVED, a.qSource)
        // NEVER "measured": rnis_pano_android_basis.hpp's whole provenance
        // section exists to stop a derivation certifying a calibration nobody
        // ran, and this is the Kotlin side of that rule.
        assertNotEquals(PANO_BASIS_AUTHORITY_MEASURED, a.authority)
        assertFalse(a.qSource.contains(PANO_BASIS_AUTHORITY_MEASURED))
    }

    @Test
    fun noAuthorityMeansIdentityAndTheRefusalIsQuotedVerbatim() {
        val a = panoResolveBasisAuthority(-1, -1, "sensor-orientation-not-read", 24)
        assertEquals(-1, a.index)
        assertEquals(PANO_BASIS_AUTHORITY_NONE, a.authority)
        assertEquals(PANO_Q_SOURCE_NONE, a.qSource)
        assertTrue(a.note.contains("sensor-orientation-not-read"))
    }

    @Test
    fun anOutOfRangeMeasuredIndexIsDiscardedByNameAndNotSilentlyIgnored() {
        // The operator believes their measurement is in this pack. Falling
        // through to the derived index without saying so would put a DIFFERENT
        // basis under their claim.
        val a = panoResolveBasisAuthority(24, 8, "none", 24)
        assertEquals(8, a.index)
        assertEquals(PANO_BASIS_AUTHORITY_DERIVED, a.authority)
        assertTrue(a.note.contains("OUT OF RANGE"))
        val b = panoResolveBasisAuthority(99, -1, "refused", 24)
        assertEquals(-1, b.index)
        assertEquals(PANO_BASIS_AUTHORITY_NONE, b.authority)
        assertTrue(b.note.contains("OUT OF RANGE"))
    }

    @Test
    fun withoutTheEnginesCandidateCountNothingIsAcceptable() {
        // candidateCount 0 is what a missing .so reports. An index cannot be
        // range-checked against a table this build never linked, so nothing is
        // applied and the pack says the native half was the reason.
        val a = panoResolveBasisAuthority(8, 8, "native-unavailable", 0)
        assertEquals(-1, a.index)
        assertEquals(PANO_BASIS_AUTHORITY_NONE, a.authority)
    }

    // ── 7. THE CLOCK GATE ───────────────────────────────────────────────

    @Test
    fun onlyRealtimeTimestampsMayBeJoined() {
        val g = panoAttitudeClockGate("REALTIME")
        assertTrue(g.joinable)
        assertTrue(g.reason.contains("elapsedRealtimeNanos"))
        // τ IS NOT CLAIMED. The gate settles the EPOCH; the residual latency
        // is unmeasured and the reason has to say so, or a reader takes an
        // uncorrected join for a calibrated one.
        assertTrue(g.reason.contains("UNCORRECTED"))
    }

    @Test
    fun everyOtherTimestampSourceRefusesTheJoin() {
        for (name in listOf("UNKNOWN", "unavailable", "unrecognised(7)", "", "realtime")) {
            val g = panoAttitudeClockGate(name)
            assertFalse("'$name' must not be joinable", g.joinable)
            assertTrue(g.reason.contains("IDENTITY"))
        }
    }

    // ── 8. THE TRACKING VETO ────────────────────────────────────────────

    @Test
    fun aRefusedBracketCannotReportTrackingTwo() {
        // The dangerous combination: a sample delivered 1 ms ago (fresh by any
        // measure) behind a frame the ring could not bracket. Freshness alone
        // answers 2; the row carries the identity.
        val maxAge = (DEFAULT_ATTITUDE_MAX_AGE_MS * 1e6).toLong()
        val fresh = 1_000_000_000L
        val accept = fresh + 1_000_000L
        assertEquals(2, derivePanoTracking(-1, fresh, accept, maxAge, attitudeRefused = false))
        assertEquals(0, derivePanoTracking(-1, fresh, accept, maxAge, attitudeRefused = true))
    }

    @Test
    fun theVetoDoesNotTouchASweepThatNeverMapped() {
        // A pack with no basis authority writes identity on every row BY
        // DESIGN and is a legitimate planar-arm pack. `attitudeRefused` is
        // false there, so the freshness answer stands exactly as it shipped.
        val maxAge = (DEFAULT_ATTITUDE_MAX_AGE_MS * 1e6).toLong()
        assertEquals(2, derivePanoTracking(-1, 0L, 1_000_000L, maxAge))
        assertEquals(0, derivePanoTracking(-1, null, 1_000_000L, maxAge))
    }
}

private fun DoubleArray.sumOfSquares(): Double {
    var s = 0.0
    for (v in this) s += v * v
    return s
}
