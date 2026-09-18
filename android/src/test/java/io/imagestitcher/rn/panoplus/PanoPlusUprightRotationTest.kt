// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The upright bake's arithmetic — the half of item E that is provable on the
 * JVM, with no camera, no device and no android.* type (the constraint this
 * source set is documented to keep, `android/build.gradle`).
 *
 * WHAT IT CANNOT PROVE, said plainly: that `Display.getRotation()` and
 * `SENSOR_ORIENTATION` carry the values this arithmetic assumes on a real
 * Galaxy A35. That is a hardware check. What it DOES pin is the table, the
 * modulo behaviour on the negative branch, and the refusals — the three places
 * an orientation formula is normally wrong.
 */
class PanoPlusUprightRotationTest {

    // The AOSP back-camera table, at SENSOR_ORIENTATION 90 (the A35's value,
    // read from `device.json`). Each row is a hold the operator can actually
    // put the phone in, and the bake the deliverable needs in it.
    @Test
    fun `the four holds at sensor orientation 90`() {
        assertEquals(90, PanoPlusUprightRotation.uprightRotationCwDeg(90, 0))
        assertEquals(0, PanoPlusUprightRotation.uprightRotationCwDeg(90, 90))
        assertEquals(270, PanoPlusUprightRotation.uprightRotationCwDeg(90, 180))
        assertEquals(180, PanoPlusUprightRotation.uprightRotationCwDeg(90, 270))
    }

    // The subtraction goes negative for three of the four holds, and Kotlin's
    // `%` keeps the sign — so an un-normalised result would hand the engine a
    // −90 and be refused by name at start. This is the branch that matters.
    @Test
    fun `never returns a negative angle`() {
        for (sensor in intArrayOf(0, 90, 180, 270)) {
            for (display in intArrayOf(0, 90, 180, 270)) {
                val r = PanoPlusUprightRotation.uprightRotationCwDeg(sensor, display)
                assertTrue("sensor=$sensor display=$display -> $r", r != null && r >= 0)
                assertTrue("sensor=$sensor display=$display -> $r", r!! < 360)
                assertEquals(0, r % 90)
            }
        }
    }

    // A sensor orientation the device never reports must produce a REFUSAL, not
    // a plausible zero: a wrong-but-plausible 0 ships a sideways deliverable and
    // says nothing, which is the exact failure this whole change exists to fix.
    @Test
    fun `refuses a non-quarter input rather than rounding it`() {
        assertNull(PanoPlusUprightRotation.uprightRotationCwDeg(45, 0))
        assertNull(PanoPlusUprightRotation.uprightRotationCwDeg(90, 45))
        assertNull(PanoPlusUprightRotation.uprightRotationCwDeg(90, -90))
        assertNull(PanoPlusUprightRotation.uprightRotationCwDeg(360, 0))
        assertFalse(PanoPlusUprightRotation.isSupportedSensorOrientation(45))
        assertTrue(PanoPlusUprightRotation.isSupportedSensorOrientation(270))
    }

    // `impliedDisplayRotationCwDeg` exists to UNWIND the SDK's assumed sensor
    // constant so the device's real one can be applied instead. Round-tripping
    // it is the property that makes that safe.
    @Test
    fun `implied display rotation round-trips the bake`() {
        for (sensor in intArrayOf(0, 90, 180, 270)) {
            for (display in intArrayOf(0, 90, 180, 270)) {
                val bake = PanoPlusUprightRotation.uprightRotationCwDeg(sensor, display)!!
                assertEquals(
                    "sensor=$sensor display=$display",
                    display,
                    PanoPlusUprightRotation.impliedDisplayRotationCwDeg(sensor, bake),
                )
            }
        }
    }

    // The correction `PanoPlusLiveModule` performs, in one place: take the value
    // a host computed against the assumed sensor constant, recover the hold it
    // meant, and re-apply it to the sensor this device actually has.
    @Test
    fun `re-derives a host value against a different sensor orientation`() {
        val assumed = PanoPlusUprightRotation.SDK_ASSUMED_SENSOR_ORIENTATION_DEG
        assertEquals(90, assumed)

        // A tablet whose back sensor reports 0. The host, holding the phone
        // upright (display 0), sent 90 — which on that body would be a quarter
        // turn of damage. The correction returns it to 0.
        val hostSaysPortrait = PanoPlusUprightRotation.uprightRotationCwDeg(assumed, 0)!!
        val heldRotation =
            PanoPlusUprightRotation.impliedDisplayRotationCwDeg(assumed, hostSaysPortrait)!!
        assertEquals(0, heldRotation)
        assertEquals(0, PanoPlusUprightRotation.uprightRotationCwDeg(0, heldRotation))

        // And on a sensor-90 body the correction is the identity, which is every
        // device this programme has measured.
        for (display in intArrayOf(0, 90, 180, 270)) {
            val host = PanoPlusUprightRotation.uprightRotationCwDeg(assumed, display)!!
            val back = PanoPlusUprightRotation.impliedDisplayRotationCwDeg(assumed, host)!!
            assertEquals(host, PanoPlusUprightRotation.uprightRotationCwDeg(90, back))
        }
    }

    // `Surface.ROTATION_90` is the constant 1, not 90. Reading it as degrees is
    // a quarter turn of silent error, so the conversion is a named function with
    // a test rather than an inline `* 90`.
    @Test
    fun `surface rotation constants map to degrees`() {
        assertEquals(0, PanoPlusUprightRotation.surfaceRotationToDeg(0))
        assertEquals(90, PanoPlusUprightRotation.surfaceRotationToDeg(1))
        assertEquals(180, PanoPlusUprightRotation.surfaceRotationToDeg(2))
        assertEquals(270, PanoPlusUprightRotation.surfaceRotationToDeg(3))
        assertNull(PanoPlusUprightRotation.surfaceRotationToDeg(4))
        assertNull(PanoPlusUprightRotation.surfaceRotationToDeg(-1))
    }
}
