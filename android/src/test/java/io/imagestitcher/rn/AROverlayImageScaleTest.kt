// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The `imageScale` overlay rule ([AROverlayImageScale]) — the one function the
 * parser and the renderer both call.  Pins the two promises the contract
 * makes: absent / invalid ⇒ exactly the pre-field badge, and the scale moves
 * the proportional extent and the upper clamp, never the lower floor.
 */
class AROverlayImageScaleTest {

    /** The renderer's pre-field expression, verbatim — the byte-identity oracle. */
    private fun legacyExtent(shortSide: Float): Float = (shortSide * 0.26f).coerceIn(10f, 110f)

    @Test
    fun defaultScaleIsBitIdenticalToThePreFieldRule() {
        for (side in listOf(0f, 5f, 20f, 38.4f, 40f, 100f, 250f, 423.1f, 1000f, 5000f)) {
            assertEquals(
                "short side $side",
                legacyExtent(side).toBits(),
                AROverlayImageScale.badgeExtentPx(side, AROverlayImageScale.DEFAULT).toBits(),
            )
        }
    }

    @Test
    fun invalidScalesFallBackToOneNotClipped() {
        for (bad in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, 0f, -1f, 0.2f, 2.6f, 100f)) {
            assertEquals("scale $bad", 1f, AROverlayImageScale.sanitize(bad), 0f)
            assertEquals(
                "extent at scale $bad",
                legacyExtent(200f),
                AROverlayImageScale.badgeExtentPx(200f, bad),
                0f,
            )
        }
    }

    @Test
    fun rangeEndsAreHonoured() {
        assertEquals(0.25f, AROverlayImageScale.sanitize(0.25f), 0f)
        assertEquals(2.5f, AROverlayImageScale.sanitize(2.5f), 0f)
        assertEquals(2f, AROverlayImageScale.sanitize(2f), 0f)
    }

    @Test
    fun scaleTwoDoublesTheProportionalExtentAndTheCap() {
        // 200 px short side: 52 px at 1, 104 px at 2.
        assertEquals(52f, AROverlayImageScale.badgeExtentPx(200f, 1f), 1e-4f)
        assertEquals(104f, AROverlayImageScale.badgeExtentPx(200f, 2f), 1e-4f)
        // The cap moves with the scale: 1000 px → 110 at 1, 220 at 2.
        assertEquals(110f, AROverlayImageScale.badgeExtentPx(1000f, 1f), 0f)
        assertEquals(220f, AROverlayImageScale.badgeExtentPx(1000f, 2f), 0f)
    }

    @Test
    fun theLowerFloorDoesNotScale() {
        // A tiny box keeps the 10 px floor at any scale.
        assertEquals(10f, AROverlayImageScale.badgeExtentPx(20f, 0.25f), 0f)
        assertEquals(10f, AROverlayImageScale.badgeExtentPx(20f, 1f), 0f)
        assertEquals(10.4f, AROverlayImageScale.badgeExtentPx(20f, 2f), 1e-4f)
    }

    @Test
    fun theInsetBadgeEndsInsideTheBoxAtTheTopOfTheRange() {
        // Renderer inset = 0.15 × extent; the badge ends at inset + extent.
        for (side in listOf(40f, 100f, 300f)) {
            val e = AROverlayImageScale.badgeExtentPx(side, AROverlayImageScale.MAX)
            assert(e * 1.15f <= side) { "side $side: badge end ${e * 1.15f}" }
        }
    }
}
