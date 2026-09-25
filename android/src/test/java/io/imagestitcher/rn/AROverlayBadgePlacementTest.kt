// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The `badgePlacement` overlay rule ([AROverlayBadgePlacement]) — the one
 * function the parser and the patch path call.  Pins iOS's rule (only the
 * exact string `'plane'` opts in; everything else is the pre-field
 * `'camera'` badge), and that a native-plugin SPI caller that never heard of
 * the field gets the default.
 */
class AROverlayBadgePlacementTest {

    @Test
    fun onlyTheExactStringPlaneOptsIn() {
        assertEquals("plane", AROverlayBadgePlacement.sanitize("plane"))
        assertEquals(AROverlayBadgePlacement.PLANE, AROverlayBadgePlacement.sanitize("plane"))
    }

    @Test
    fun everythingElseIsThePreFieldCameraBadge() {
        for (raw in listOf<Any?>(null, "camera", "", "Plane", "PLANE", " plane", "flat", true, 1, 1.0)) {
            assertEquals("raw $raw", "camera", AROverlayBadgePlacement.sanitize(raw))
        }
        assertEquals(AROverlayBadgePlacement.CAMERA, AROverlayBadgePlacement.DEFAULT)
    }

    @Test
    fun anSpiCallerThatNeverSetsItGetsTheDefault_andItNeverChangesIdentity() {
        val o = AROverlayData(
            id = "a",
            worldPosition = floatArrayOf(0f, 0f, 0f),
            sizeMeters = floatArrayOf(0.1f, 0.1f),
            worldQuad = null,
            shape = "box",
            label = null,
            colorArgb = AROverlayData.DEFAULT_COLOR_ARGB,
            mode = "2d",
        )
        assertEquals("camera", o.badgePlacement)
        // Identity (the store's diff key) is the id alone, as for every field.
        val p = o.copy(badgePlacement = AROverlayBadgePlacement.PLANE)
        assertEquals(o, p)
        assertEquals("plane", p.badgePlacement)
    }
}
