// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The overlay-features report ([AROverlayFeatures]) — what
 * `RNSARSession.overlayFeatures()` resolves.  Pins the shape the host reads
 * (so "honoured" can be told from "asked"), and that the `imageScale` range
 * it reports IS the range the parser and renderer apply.
 */
class AROverlayFeaturesTest {

    @Test
    fun reportsImageScaleAsHonoured() {
        assertTrue(AROverlayFeatures.FEATURES.contains("imageScale"))
        assertEquals(listOf("imageScale"), AROverlayFeatures.FEATURES)
    }

    @Test
    fun shapeIsExactlyTheContract() {
        val d = AROverlayFeatures.describe()
        assertEquals(listOf("contract", "platform", "features", "imageScale"), d.keys.toList())
        assertEquals("arOverlayFeatures/1", d["contract"])
        assertEquals("android", d["platform"])
        assertEquals(listOf("imageScale"), d["features"])
        @Suppress("UNCHECKED_CAST")
        val scale = d["imageScale"] as Map<String, Double>
        assertEquals(listOf("min", "max", "default"), scale.keys.toList())
    }

    @Test
    fun imageScaleRangeIsTheOneTheRendererApplies() {
        @Suppress("UNCHECKED_CAST")
        val scale = AROverlayFeatures.describe()["imageScale"] as Map<String, Double>
        assertEquals(0.25, scale["min"]!!, 0.0)
        assertEquals(2.5, scale["max"]!!, 0.0)
        assertEquals(1.0, scale["default"]!!, 0.0)
        // The reported ends are honoured, one step past them is not.
        assertEquals(scale["min"]!!.toFloat(), AROverlayImageScale.sanitize(scale["min"]!!.toFloat()), 0f)
        assertEquals(scale["max"]!!.toFloat(), AROverlayImageScale.sanitize(scale["max"]!!.toFloat()), 0f)
        assertEquals(
            AROverlayImageScale.DEFAULT,
            AROverlayImageScale.sanitize(Math.nextUp(scale["max"]!!.toFloat())),
            0f,
        )
        // The value the field build asks for (the 2× packshot) is inside it.
        assertEquals(2f, AROverlayImageScale.sanitize(2f), 0f)
    }
}
