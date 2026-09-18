// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusTrackingTest.kt — the one field in a track row that can turn a
// working engine into an empty canvas.
//
// ── WHAT WENT WRONG, AND WHY IT NEEDED A TEST ────────────────────────────
//
// The recorder used to derive `tracking` from `SensorEvent.accuracy` of
// TYPE_ROTATION_VECTOR.  That sensor is magnetometer-fused, so its accuracy is
// the COMPASS's calibration health: it reads LOW or UNRELIABLE until the
// compass has been figure-eighted, and it drops to LOW beside steel shelving —
// which is where every sweep on this programme happens.
//
// The engine gates its reference latch on `tracking == 2` and needs
// TRACKING_WARMUP_FRAMES of them CONSECUTIVELY before it latches at all
// (cpp/rnis_pano.cpp — `if (in.tracking != 2) { S.warm = 0; return
// WarmingUp; }`).  Replaying a real 286-row pack with `tracking = 1` on every
// row paints ZERO frames and produces an EMPTY canvas — which, on a first
// Android sweep, reads as a verdict on the ENGINE rather than on the compass.
//
// And it was gating a CONSTANT: the recorder writes `q` as identity with
// `qSource:"none"`, so the row's attitude never came from the magnetometer in
// the first place.
//
// So `tracking` now answers the only question the recorder can honestly answer
// — IS THERE A LIVE ATTITUDE CHANNEL BEHIND THIS FRAME — from sample
// freshness, measured in ONE clock.  These tests pin that, and pin the
// consecutive-run property the latch actually depends on.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val MS = 1_000_000L
private val MAX_AGE_NS = (DEFAULT_ATTITUDE_MAX_AGE_MS * 1e6).toLong()

/** `SensorManager.SENSOR_STATUS_*`, as literals — the point of every test
 *  below is that the derivation does NOT read them, and importing the android
 *  stub to say so would be a dependency on the thing being excluded. */
private const val ACCURACY_UNRELIABLE = 0
private const val ACCURACY_LOW = 1
private const val ACCURACY_MEDIUM = 2
private const val ACCURACY_HIGH = 3

class PanoPlusTrackingTest {

    // ── The override still wins, and only in range ───────────────────────

    @Test
    fun explicitOverrideWinsOverEverything() {
        // Even with NO attitude sample at all: the option exists so an operator
        // can force a pack through a known-good path, and a forced value that
        // the freshness rule could veto would not be a force.
        assertEquals(0, derivePanoTracking(0, null, 0L, MAX_AGE_NS))
        assertEquals(1, derivePanoTracking(1, null, 0L, MAX_AGE_NS))
        assertEquals(2, derivePanoTracking(2, null, 0L, MAX_AGE_NS))
        // And with a stale sample it still wins.
        assertEquals(2, derivePanoTracking(2, 0L, 10_000L * MS, MAX_AGE_NS))
    }

    @Test
    fun outOfRangeOverrideIsNotAnOverride() {
        // -1 is the "not supplied" sentinel the Config uses; 3 and 7 are
        // typos. All three must fall through to the real derivation rather
        // than reaching the pack as a value the engine cannot interpret.
        for (bad in intArrayOf(-1, -5, 3, 7)) {
            assertEquals(
                "override $bad must fall through to the freshness rule",
                2, derivePanoTracking(bad, 100L * MS, 101L * MS, MAX_AGE_NS),
            )
            assertEquals(
                "override $bad must fall through to the freshness rule",
                0, derivePanoTracking(bad, null, 101L * MS, MAX_AGE_NS),
            )
        }
    }

    // ── The freshness rule ───────────────────────────────────────────────

    @Test
    fun noAttitudeSampleIsNotAvailableNotNormal() {
        // The head of every sweep, before the first sensor callback lands.
        assertEquals(0, derivePanoTracking(-1, null, 500L * MS, MAX_AGE_NS))
    }

    @Test
    fun aFreshSampleIsNormal() {
        val accept = 1_000L * MS
        assertEquals(2, derivePanoTracking(-1, accept, accept, MAX_AGE_NS))
        assertEquals(2, derivePanoTracking(-1, accept - 5L * MS, accept, MAX_AGE_NS))
        assertEquals(2, derivePanoTracking(-1, accept - 99L * MS, accept, MAX_AGE_NS))
    }

    @Test
    fun theBoundIsInclusive() {
        // A sample exactly at the bound is IN. An exclusive bound would make
        // the verdict depend on nanosecond scheduling noise at the boundary,
        // which is the kind of flake nobody can reproduce in an aisle.
        val accept = 1_000L * MS
        assertEquals(2, derivePanoTracking(-1, accept - MAX_AGE_NS, accept, MAX_AGE_NS))
        assertEquals(0, derivePanoTracking(-1, accept - MAX_AGE_NS - 1L, accept, MAX_AGE_NS))
    }

    @Test
    fun aStaleSampleIsNotAvailable() {
        // The sensor stopped delivering mid-sweep — a real failure the pack
        // must record, and the ONE case the old accuracy rule could not see
        // at all (a stalled sensor keeps its last accuracy forever).
        val accept = 10_000L * MS
        assertEquals(0, derivePanoTracking(-1, accept - 101L * MS, accept, MAX_AGE_NS))
        assertEquals(0, derivePanoTracking(-1, accept - 5_000L * MS, accept, MAX_AGE_NS))
    }

    @Test
    fun aSampleFromJustAfterTheAcceptIsFreshNotStale() {
        // Two threads read the same clock; the IMU callback can win by
        // microseconds. Clamping a negative age to "stale" would drop random
        // rows to 0 and reset the latch run for no physical reason.
        val accept = 1_000L * MS
        assertEquals(2, derivePanoTracking(-1, accept + 1L, accept, MAX_AGE_NS))
        assertEquals(2, derivePanoTracking(-1, accept + 2L * MS, accept, MAX_AGE_NS))
    }

    // ── THE REGRESSION ITSELF ────────────────────────────────────────────

    @Test
    fun compassHealthNoLongerDecidesAnything() {
        // The derivation takes no accuracy argument, so a device reporting
        // UNRELIABLE beside a steel gondola gets the same answer as one that
        // has just been figure-eighted. These four constants are here to make
        // the absence explicit: if `tracking` ever consults them again, this
        // test is where the argument has to be re-made.
        val accept = 1_000L * MS
        val fresh = accept - 3L * MS
        for (accuracy in intArrayOf(
            ACCURACY_UNRELIABLE, ACCURACY_LOW, ACCURACY_MEDIUM, ACCURACY_HIGH,
        )) {
            // `accuracy` is deliberately unused by the call — that IS the fix.
            assertEquals(
                "accuracy $accuracy must not change a fresh row's tracking",
                2, derivePanoTracking(-1, fresh, accept, MAX_AGE_NS),
            )
        }
    }

    @Test
    fun aHealthySweepReachesTheEnginesConsecutiveRunRequirement() {
        // 286 rows at 30 fps with the IMU at 200 Hz — the shape of the real
        // pack the reviewer replayed. Under the accuracy rule with a LOW
        // compass every one of these rows was 1, the latch never fired, and
        // the canvas came back empty. Under freshness they are all 2.
        val framePeriodNs = 33L * MS
        val imuPeriodNs = 5L * MS
        var longest = 0
        var run = 0
        var normal = 0
        for (i in 0 until 286) {
            val accept = i * framePeriodNs
            // The newest sample at or before the accept instant.
            val newest = (accept / imuPeriodNs) * imuPeriodNs
            val t = derivePanoTracking(-1, newest, accept, MAX_AGE_NS)
            if (t == 2) {
                normal++
                run++
                if (run > longest) longest = run
            } else {
                run = 0
            }
        }
        assertEquals("every row of a healthy sweep is normal", 286, normal)
        assertTrue(
            "the reference latch needs $TRACKING_WARMUP_FRAMES consecutive normal rows; " +
                "this sweep offered $longest",
            longest >= TRACKING_WARMUP_FRAMES,
        )
    }

    @Test
    fun anAbsentSensorLeavesTheSweepUnlatchable() {
        // TYPE_ROTATION_VECTOR missing, or its registration refused: no sample
        // ever reaches the frame path, so `imuLatest` stays null for the whole
        // sweep. THE advisory's trigger condition — device.json must be able to
        // say "no latch is possible from this pack" rather than leave the
        // operator to infer it from an empty canvas.
        val framePeriodNs = 33L * MS
        var longest = 0
        var run = 0
        for (i in 0 until 300) {
            val t = derivePanoTracking(-1, null, i * framePeriodNs, MAX_AGE_NS)
            if (t == 2) { run++; if (run > longest) longest = run } else run = 0
        }
        assertEquals("no sample can never be normal", 0, longest)
        assertTrue(longest < TRACKING_WARMUP_FRAMES)
    }

    @Test
    fun aSensorSlowerThanTheBoundNeverStringsEnoughTogether() {
        // The subtler failure: the sensor IS delivering, but at 4 Hz — a
        // throttled or badly-batched rotation vector. Every burst goes stale
        // before the next sample lands, so the rows alternate and the longest
        // consecutive run stays under the engine's requirement however long the
        // operator sweeps. A histogram of tracking values would look healthy
        // here (most rows are 2); only the CONSECUTIVE run tells the truth,
        // which is why device.json reports that number and not just the mix.
        val framePeriodNs = 33L * MS
        val imuPeriodNs = 250L * MS
        var longest = 0
        var run = 0
        var normal = 0
        for (i in 0 until 300) {
            val accept = i * framePeriodNs
            val newest = (accept / imuPeriodNs) * imuPeriodNs
            val t = derivePanoTracking(-1, newest, accept, MAX_AGE_NS)
            if (t == 2) { normal++; run++; if (run > longest) longest = run } else run = 0
        }
        assertTrue("this sweep should still look mostly healthy row-by-row", normal > 100)
        assertTrue(
            "a 4 Hz attitude channel must not look latchable (longest run was $longest)",
            longest < TRACKING_WARMUP_FRAMES,
        )
    }

    @Test
    fun aSensorThatDiesMidSweepStaysLatchableForTheBoundThenStops() {
        // NOT a failure of the rule — a documented consequence of it, recorded
        // here so nobody "fixes" it later. A sensor that stops mid-sweep leaves
        // the frames inside the staleness bound normal, so the engine latches
        // and then hits its own `tracking-lost` abort on the first stale row.
        // That is a LOUD, named outcome; silently refusing to latch would have
        // been the quiet one.
        val framePeriodNs = 33L * MS
        val imuPeriodNs = 5L * MS
        val deathNs = 2L * framePeriodNs
        var longest = 0
        var run = 0
        var lost = 0
        for (i in 0 until 120) {
            val accept = i * framePeriodNs
            val newest = minOf((accept / imuPeriodNs) * imuPeriodNs, deathNs)
            val t = derivePanoTracking(-1, newest, accept, MAX_AGE_NS)
            if (t == 2) { run++; if (run > longest) longest = run } else { run = 0; lost++ }
        }
        assertTrue(
            "the frames within the staleness bound of the last sample stay normal",
            longest >= TRACKING_WARMUP_FRAMES,
        )
        assertTrue("and everything after the bound is not-available", lost > 100)
    }

    // ── The size default that shares this file's failure mode ────────────

    @Test
    fun theDefaultRasterIsTheIosReferenceWidth() {
        // Not a style constant: 0 (the old default) means "take the largest
        // advertised 4:3 size", which on a modern sensor is 4000x3000 through
        // a software JPEG encoder — a few-fps pack that reads as a slow camera
        // in every counter and is actually a chosen size.
        assertEquals(1920, DEFAULT_MAX_WIDTH)
    }

    @Test
    fun theWarmupMirrorMatchesTheEngine() {
        // cpp/rnis_pano.hpp: `int trackingWarmupFrames = 5`. The engine stays
        // the authority; this constant only lets the advisory print the real
        // number, and a drift between them would make that advisory lie.
        assertEquals(5, TRACKING_WARMUP_FRAMES)
    }
}
