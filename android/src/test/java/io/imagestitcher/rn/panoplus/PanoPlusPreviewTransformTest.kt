// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusPreviewTransformTest.kt — the viewfinder's geometry, pinned.
//
// WHY THIS EXISTS. The operator reported two viewfinder faults on 2026-09-02:
// "elongated vertically" and, turned sideways, "the viewfinder is sideways".
// Both were the missing `setTransform`. The fix is one matrix, and a matrix
// has two ways of being wrong that no amount of reading catches:
//
//   * THE ASPECT. A transform that rotates correctly and still stretches
//     looks plausible in a screenshot of a shelf. So the corner assertions
//     below check the mapped content is the RIGHT SHAPE (the PICTURE's aspect,
//     preserved) and the right size, not just in the right place.
//
//     ⚠ AND "THE PICTURE'S ASPECT" IS NOT "THE BUFFER'S". Until 2026-09-03
//     every case here passed with the fit box derived from bufW/bufH, because
//     nothing in the suite carried the SENSOR term — so a viewfinder squashed
//     by exactly (4/3)/(3/4) = 1.778 was green. Every geometric case below is
//     now run at BOTH mountings (0 and 90), which is what makes that class of
//     defect fail rather than pass.
//   * THE SIGN OF THE DISPLAY TERM. It VANISHES in portrait — display
//     rotation 0 — so a wrong sign is invisible on a desk and only appears on
//     a phone held sideways in an aisle. Every one of the four rotations is
//     asserted here, in both sensor mountings, for exactly that reason.
//
// These are CORNER tests on purpose. `matrixValues` is composed on top of the
// anisotropic stretch TextureView has already applied, so asserting the nine
// floats would pin the arithmetic without pinning the picture. Mapping the
// buffer's four corners through the whole chain asserts what the operator
// sees: where the top-left of the camera frame lands on his screen.
//
//   cd <host-app>/android && ./gradlew :react-native-image-stitcher:testDebugUnitTest

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusPreviewTransformTest {

    // The REAL numbers from this device, so a regression is measured against
    // the phone in the drawer rather than against a round number:
    //   camera 2 (the ultra-wide the live arm opens), SENSOR_ORIENTATION 90,
    //   preview buffer 1440x1080 (live packs' `preview.size`),
    //   view 1080x2340 portrait / 2340x1080 landscape (dumpsys activity top).
    private val bufW = 1440
    private val bufH = 1080

    /** The device's real mounting. Camera 2 on SM-A356U1 publishes
     *  SENSOR_ORIENTATION 90, so the 1440x1080 buffer carries a 1080x1440
     *  picture — the quantity the fit box is built from. */
    private val sensor90 = 90

    /** A hypothetical 0-degree mounting: picture == buffer. Kept so every
     *  geometric case runs at both mountings; a rule that silently used the
     *  buffer's own aspect would pass here and fail at 90. */
    private val sensor0 = 0

    private fun picture(sensor: Int): IntArray =
        PanoPlusPreviewTransform.contentSize(bufW, bufH, sensor)!!

    private fun corners(
        viewW: Int, viewH: Int, rot: Int, sensor: Int = sensor90,
    ): Array<DoubleArray> {
        val m = PanoPlusPreviewTransform.matrixValues(viewW, viewH, bufW, bufH, rot, sensor)
        assertNotNull("matrix for rot=$rot sensor=$sensor", m)
        val c = picture(sensor)
        val cW = c[0].toDouble()
        val cH = c[1].toDouble()
        fun p(x: Double, y: Double) =
            PanoPlusPreviewTransform.mapContentPoint(m!!, viewW, viewH, c[0], c[1], x, y)
        return arrayOf(
            p(0.0, 0.0),   // picture top-left
            p(cW, 0.0),    // picture top-right
            p(cW, cH),     // picture bottom-right
            p(0.0, cH),    // picture bottom-left
        )
    }

    // ── The rotation rule ────────────────────────────────────────────

    @Test
    fun `the rule is the display term alone - measured on SM-A356U1`() {
        // THE PINNED CASE. Phone portrait, camera 2 (SENSOR_ORIENTATION 90),
        // 2026-09-02: a four-way sweep of forced rotations on one pose showed
        // rot=0 upright and rot=90 a quarter turn over, and the deliverable
        // from the same pose (pack pp_1788407362514, canvas.jpg 541x721,
        // outputRotationCwDeg 90) agreed with rot=0. Hence 0 here, NOT 90.
        assertEquals(0, PanoPlusPreviewTransform.previewRotationCwDeg(0))
        // The sideways cases follow AOSP Camera2Basic's `90 * (rotation - 2)`.
        // ⚠ NOT device-verified: the A35 refused every attempt to force a
        // landscape display and nobody was present to turn it.
        assertEquals(270, PanoPlusPreviewTransform.previewRotationCwDeg(90))
        assertEquals(180, PanoPlusPreviewTransform.previewRotationCwDeg(180))
        assertEquals(90, PanoPlusPreviewTransform.previewRotationCwDeg(270))
    }

    @Test
    fun `the sensor mounting DOES set the picture aspect - the 1 point 778x squash`() {
        // THE PINNED DEFECT, as the number it was. On 2026-09-03 the drawn band
        // measured 1080x810 (4:3) against the stock camera's 1080x1440 (3:4) at
        // the same lens and pose — a vertical squash of exactly
        // (4/3)/(3/4) = 1.7778, because the fit box was read off the BUFFER
        // (1440x1080) while the camera had already turned the PICTURE to
        // 1080x1440 inside it.
        val pic = picture(sensor90)
        assertEquals(1080, pic[0])
        assertEquals(1440, pic[1])
        // A 0-degree mounting is the identity: picture == buffer.
        assertEquals(bufW, picture(sensor0)[0])
        assertEquals(bufH, picture(sensor0)[1])
        // …and at the device's own display rotation (0 -> rot 0) the fit box is
        // the stock camera's own answer, 1080x1440, NOT 1080x810.
        val fit = PanoPlusPreviewTransform.fittedContentSize(
            1080, 2340, bufW, bufH, 0, sensor90,
        )!!
        assertEquals(1080, fit[0])
        assertEquals(1440, fit[1])
        // The squash, stated: what the old rule produced, and by how much.
        val squashed = PanoPlusPreviewTransform.fittedContentSize(
            1080, 2340, bufW, bufH, 0, sensor0,
        )!!
        assertEquals(810, squashed[1])
        assertEquals(1.7778, fit[1].toDouble() / squashed[1], 1e-3)
    }

    @Test
    fun `the sensor mounting does NOT enter the preview rule`() {
        // The regression guard for the defect this file was written to end:
        // a SurfaceTexture buffer is already sensor-oriented by the camera, so
        // owing SENSOR_ORIENTATION a second time is the quarter turn the
        // operator reported. There is no sensor parameter to pass any more —
        // this test exists so that re-adding one is a deliberate act with a
        // failing test attached, not a plausible-looking edit.
        for (display in intArrayOf(0, 90, 180, 270)) {
            assertEquals(
                (360 - display) % 360,
                PanoPlusPreviewTransform.previewRotationCwDeg(display),
            )
        }
    }

    @Test
    fun `an out-of-range display rotation degrades to no rotation`() {
        assertEquals(0, PanoPlusPreviewTransform.previewRotationCwDeg(0))
        assertEquals(0, PanoPlusPreviewTransform.previewRotationCwDeg(360))
        // A HAL that published a near-quarter turn must not put a skew on
        // screen; it quantises to the nearest quarter.
        assertEquals(270, PanoPlusPreviewTransform.previewRotationCwDeg(89))
    }

    @Test
    fun `surface rotation constants become degrees`() {
        assertEquals(0, PanoPlusPreviewTransform.displayRotationDegrees(0))
        assertEquals(90, PanoPlusPreviewTransform.displayRotationDegrees(1))
        assertEquals(180, PanoPlusPreviewTransform.displayRotationDegrees(2))
        assertEquals(270, PanoPlusPreviewTransform.displayRotationDegrees(3))
        // An unreadable rotation degrades to the natural orientation, never to
        // a quarter turn nobody asked for.
        assertEquals(0, PanoPlusPreviewTransform.displayRotationDegrees(7))
        assertEquals(0, PanoPlusPreviewTransform.displayRotationDegrees(-1))
    }

    // ── THE ELONGATION (item B) ──────────────────────────────────────

    @Test
    fun `the portrait viewfinder is NOT stretched - the 2 point 889x anisotropy is gone`() {
        // The defect, stated as the number it was: with the identity transform
        // a 1440x1080 buffer in a 1080x2340 view is scaled x0.750 across and
        // x2.167 down — 2.889x vertical anisotropy.
        // THE REAL DEVICE CASE: display ROTATION_0 -> rot 0, sensor 90.
        val c = corners(1080, 2340, rot = 0, sensor = sensor90)
        val across = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) // picture top edge
        val down = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1])   // picture left edge
        // The PICTURE's aspect, preserved: 1080/1440 = 0.75 (3:4 portrait).
        // Reading this off the buffer instead gives 1.3333 and is the squash.
        val pic = picture(sensor90)
        assertEquals(pic[0].toDouble() / pic[1], across / down, 1e-6)
        // …and in absolute pixels it is the stock camera's own band.
        assertEquals(1080.0, across, 1e-3)
        assertEquals(1440.0, down, 1e-3)

        // The hypothetical 0-degree mounting still preserves ITS picture's
        // aspect, so the rule is about the mounting and not about a constant.
        val c0 = corners(1080, 2340, rot = 90, sensor = sensor0)
        val across0 = Math.hypot(c0[0][0] - c0[3][0], c0[0][1] - c0[3][1])
        val down0 = Math.hypot(c0[0][0] - c0[1][0], c0[0][1] - c0[1][1])
        assertEquals(bufW.toDouble() / bufH, down0 / across0, 1e-6)
    }

    @Test
    fun `a square in the buffer stays square on screen`() {
        // The operator's own acceptance test, as arithmetic: a 500x500 square
        // in the camera frame must map to a square on the screen.
        for (sensor in intArrayOf(sensor0, sensor90)) {
            val c = picture(sensor)
            for (rot in intArrayOf(0, 90, 180, 270)) {
                for ((vw, vh) in listOf(1080 to 2340, 2340 to 1080)) {
                    val m = PanoPlusPreviewTransform
                        .matrixValues(vw, vh, bufW, bufH, rot, sensor)!!
                    fun p(x: Double, y: Double) =
                        PanoPlusPreviewTransform.mapContentPoint(m, vw, vh, c[0], c[1], x, y)
                    val a = p(100.0, 100.0)
                    val b = p(600.0, 100.0)
                    val d = p(100.0, 600.0)
                    val w = Math.hypot(b[0] - a[0], b[1] - a[1])
                    val h = Math.hypot(d[0] - a[0], d[1] - a[1])
                    val tag = "rot=$rot sensor=$sensor view=${vw}x$vh"
                    assertEquals(tag, w, h, 1e-3)
                    // …and the two sides stay perpendicular (no skew crept in).
                    val dot = (b[0] - a[0]) * (d[0] - a[0]) + (b[1] - a[1]) * (d[1] - a[1])
                    assertEquals("$tag perpendicular", 0.0, dot, 1e-3)
                }
            }
        }
    }

    // ── THE ROTATION (item D) ────────────────────────────────────────

    @Test
    fun `rot 90 sends the buffer top-left to the screen top-right`() {
        // The whole of "which way does it turn", in one assertion: rotating an
        // image 90 degrees CLOCKWISE moves its top-left corner to the top-right.
        val c = corners(1080, 2340, rot = 90, sensor = sensor0)
        val tl = c[0]
        val tr = c[1]
        assertTrue("buffer TL should be on the RIGHT: ${tl[0]}", tl[0] > 1080 / 2.0)
        assertTrue("buffer TL should be near the TOP: ${tl[1]}", tl[1] < 2340 / 2.0)
        // and the buffer's top-RIGHT goes to the bottom-right.
        assertTrue("buffer TR should be on the RIGHT: ${tr[0]}", tr[0] > 1080 / 2.0)
        assertTrue("buffer TR should be near the BOTTOM: ${tr[1]}", tr[1] > 2340 / 2.0)
    }

    @Test
    fun `rot 0 leaves the buffer upright`() {
        // A pure geometry case for rot = 0 — the transform must not turn the
        // buffer at all, only fit it. The view here is LANDSCAPE-shaped so the
        // letterbox lands on the left/right edges and the assertion has
        // something to measure; which display rotation actually yields rot = 0
        // is the rule's business, tested above, not this test's.
        // A 1440x1080 buffer in a 2340x1080 view pillarboxes to
        // (2340-1440)/2 = 450 px of black a side.
        val c = corners(2340, 1080, rot = 0, sensor = sensor0)
        assertEquals(450.0, c[0][0], 1e-3)   // buffer top-left stays top-left
        assertEquals(0.0, c[0][1], 1e-3)
        assertTrue("x increases along the buffer's top edge", c[0][0] < c[1][0])
        assertTrue("y increases down the buffer's left edge", c[0][1] < c[3][1])
    }

    @Test
    fun `every quarter turn keeps the content inside the view and centred`() {
        for (sensor in intArrayOf(sensor0, sensor90))
        for (rot in intArrayOf(0, 90, 180, 270)) {
            for ((vw, vh) in listOf(1080 to 2340, 2340 to 1080, 1080 to 1080)) {
                val c = corners(vw, vh, rot, sensor)
                val xs = c.map { it[0] }
                val ys = c.map { it[1] }
                val minX = xs.minOrNull()!!; val maxX = xs.maxOrNull()!!
                val minY = ys.minOrNull()!!; val maxY = ys.maxOrNull()!!
                val tag = "rot=$rot sensor=$sensor view=${vw}x$vh"
                assertTrue("$tag left  $minX", minX >= -0.01)
                assertTrue("$tag top   $minY", minY >= -0.01)
                assertTrue("$tag right $maxX", maxX <= vw + 0.01)
                assertTrue("$tag below $maxY", maxY <= vh + 0.01)
                // Centred: the letterbox bars are equal on both sides.
                assertEquals("$tag centre x", vw - maxX, minX, 0.01)
                assertEquals("$tag centre y", vh - maxY, minY, 0.01)
                // …and it FILLS one axis exactly, or the fit was not maximal.
                val fillsX = Math.abs(maxX - minX - vw) < 0.01
                val fillsY = Math.abs(maxY - minY - vh) < 0.01
                assertTrue("$tag fills an axis", fillsX || fillsY)
            }
        }
    }

    // ── The measured cases, as numbers ───────────────────────────────

    @Test
    fun `portrait letterboxes top and bottom, landscape pillarboxes`() {
        // Portrait: 1440x1080 turned 90 is 1080x1440 → fits 1080 wide exactly,
        // 1440 tall in a 2340 view, so 450 px of black above and below.
        val p = PanoPlusPreviewTransform.fittedContentSize(1080, 2340, bufW, bufH, 90, sensor0)!!
        assertEquals(1080, p[0])
        assertEquals(1440, p[1])
        // Landscape: unrotated 1440x1080 in a 2340x1080 view → full height,
        // 1440 wide, 450 px of black each side.
        val l = PanoPlusPreviewTransform
            .fittedContentSize(2340, 1080, bufW, bufH, 0, sensor0)!!
        assertEquals(1440, l[0])
        assertEquals(1080, l[1])

        // ── THE DEVICE'S OWN TWO CASES, at the real mounting (sensor 90) ──
        // Portrait display (ROTATION_0 -> rot 0): the 1080x1440 picture fits
        // the 1080-wide view exactly, 450 px of black above and below. This is
        // the number the stock camera produced and the one the squash missed.
        val pp = PanoPlusPreviewTransform.fittedContentSize(1080, 2340, bufW, bufH, 0, sensor90)!!
        assertEquals(1080, pp[0])
        assertEquals(1440, pp[1])
        // Landscape display (ROTATION_90 -> rot 270): the same picture turned
        // a quarter is 1440x1080 and pillarboxes in a 2340x1080 view.
        val ll = PanoPlusPreviewTransform
            .fittedContentSize(2340, 1080, bufW, bufH, 270, sensor90)!!
        assertEquals(1440, ll[0])
        assertEquals(1080, ll[1])
    }

    @Test
    fun `nothing is guessed before the buffer size is known`() {
        // The pre-claim state: the recorder has not called claim() yet, so the
        // buffer size is genuinely unknown. Null means "leave the identity
        // transform alone" — a guessed size would put a WRONG framing on
        // screen, which is worse than a stretched one because it looks right.
        assertNull(PanoPlusPreviewTransform.matrixValues(1080, 2340, 0, 0, 90, sensor90))
        assertNull(PanoPlusPreviewTransform.matrixValues(0, 0, bufW, bufH, 90, sensor90))
        assertNull(PanoPlusPreviewTransform.matrixValues(1080, -1, bufW, bufH, 90, sensor90))
        assertNull(PanoPlusPreviewTransform.fittedContentSize(1080, 2340, 0, 1080, 0, sensor90))
        assertNull(PanoPlusPreviewTransform.contentSize(0, 1080, 90))
    }
}
