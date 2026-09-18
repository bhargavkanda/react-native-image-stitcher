// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusLensTest.kt — 1x and 0.5x are decided by facing and field of view,
// never by a camera id, and the pack always says which one ran.
//
// The A35 table below is the device's own (files/panoplus-android-probe.json,
// 2026-09-03): camera 0 f=4.69 mm → 69.7° hFOV, camera 2 f=1.64 mm → 96.2°,
// cameras 1 and 3 front. vision-camera's bands (>94° ultra-wide, 60-94° wide)
// are what Pano's chip on the same screen runs on, so they are the bands here.
//
// Runs on the JVM (no device, no android.jar):
//   cd <host-app>/android && \
//     ./gradlew :react-native-image-stitcher:testDebugUnitTest

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusLensTest {

    private fun cam(id: String, back: Boolean, hFov: Double, yuv: Boolean = true, order: Int) =
        PanoPlusLensCandidate(id, back, hFov, yuv, order)

    /** SM-A356U1, in getCameraIdList order. */
    private val a35 = listOf(
        cam("0", back = true, hFov = 69.7, order = 0),
        cam("1", back = false, hFov = 80.0, order = 1),
        cam("2", back = true, hFov = 96.2, order = 2),
        cam("3", back = false, hFov = 80.0, order = 3),
    )

    // ── parsing ─────────────────────────────────────────────────────────

    @Test
    fun `the SDK's two spellings parse, and nothing else does`() {
        assertEquals(PanoPlusLens.ULTRA_WIDE, PanoPlusLens.parse("ultraWide"))
        assertEquals(PanoPlusLens.WIDE, PanoPlusLens.parse("wide"))
        // The chip's own labels are accepted too.
        assertEquals(PanoPlusLens.ULTRA_WIDE, PanoPlusLens.parse("0.5x"))
        assertEquals(PanoPlusLens.WIDE, PanoPlusLens.parse("1x"))
        // Absent or misspelt is "nothing was asked" — the caller keeps the
        // shipped rule. It must NOT silently become one of the two.
        assertNull(PanoPlusLens.parse(null))
        assertNull(PanoPlusLens.parse(""))
        assertNull(PanoPlusLens.parse("telephoto"))
        assertNull(PanoPlusLens.parse("widest"))
    }

    // ── the A35, verbatim ───────────────────────────────────────────────

    @Test
    fun `on the A35 1x is camera 0 and 0_5x is camera 2`() {
        val wide = pickCameraForLens(a35, PanoPlusLens.WIDE)!!
        assertEquals("0", wide.id)
        assertEquals(PanoPlusLens.WIDE, wide.ran)
        assertTrue(wide.honoured)
        assertTrue(wide.why, wide.why.contains("1x wide"))
        assertTrue(wide.why, wide.why.contains("69.7"))

        val ultra = pickCameraForLens(a35, PanoPlusLens.ULTRA_WIDE)!!
        assertEquals("2", ultra.id)
        assertEquals(PanoPlusLens.ULTRA_WIDE, ultra.ran)
        assertTrue(ultra.honoured)
        assertTrue(ultra.why, ultra.why.contains("0.5x ultra-wide"))
        assertTrue(ultra.why, ultra.why.contains("96.2"))
        // The road not taken is IN the sentence, so a reader can check it.
        assertTrue(ultra.why, ultra.why.contains("camera 0"))
    }

    @Test
    fun `front cameras are never a lens, however wide`() {
        // A front camera above the ultra-wide threshold must not become the
        // 0.5x: the chip is about the BACK of the phone.
        val cams = a35 + cam("5", back = false, hFov = 120.0, order = 4)
        assertEquals("2", pickCameraForLens(cams, PanoPlusLens.ULTRA_WIDE)!!.id)
        assertEquals("0", pickCameraForLens(cams, PanoPlusLens.WIDE)!!.id)
    }

    // ── the rule is by FOV, not by id ───────────────────────────────────

    @Test
    fun `ids are not assumed - a device listing the ultra-wide first still gets it right`() {
        val flipped = listOf(
            cam("0", back = true, hFov = 96.2, order = 0),   // ultra-wide at id 0
            cam("1", back = false, hFov = 80.0, order = 1),
            cam("2", back = true, hFov = 69.7, order = 2),   // wide at id 2
        )
        assertEquals("2", pickCameraForLens(flipped, PanoPlusLens.WIDE)!!.id)
        assertEquals("0", pickCameraForLens(flipped, PanoPlusLens.ULTRA_WIDE)!!.id)
    }

    @Test
    fun `two wide-band back cameras - the first in list order is the 1x`() {
        // A main (78°) and a macro (80°): both in band. The platform's default
        // rear camera is the first back-facing id, and that is the 1x.
        val cams = listOf(
            cam("0", back = true, hFov = 78.0, order = 0),
            cam("1", back = false, hFov = 80.0, order = 1),
            cam("2", back = true, hFov = 110.0, order = 2),
            cam("4", back = true, hFov = 80.0, order = 3),
        )
        assertEquals("0", pickCameraForLens(cams, PanoPlusLens.WIDE)!!.id)
        assertEquals("2", pickCameraForLens(cams, PanoPlusLens.ULTRA_WIDE)!!.id)
    }

    @Test
    fun `the widest ultra-wide wins when there are two`() {
        val cams = listOf(
            cam("0", back = true, hFov = 78.0, order = 0),
            cam("2", back = true, hFov = 100.0, order = 1),
            cam("3", back = true, hFov = 118.0, order = 2),
        )
        assertEquals("3", pickCameraForLens(cams, PanoPlusLens.ULTRA_WIDE)!!.id)
    }

    // ── the two devices this programme has not met ──────────────────────

    @Test
    fun `no ultra-wide - a 0_5x request runs the 1x and SAYS so`() {
        val noUw = listOf(
            cam("0", back = true, hFov = 78.0, order = 0),
            cam("1", back = false, hFov = 80.0, order = 1),
            cam("2", back = true, hFov = 45.0, order = 2),   // a telephoto
        )
        val p = pickCameraForLens(noUw, PanoPlusLens.ULTRA_WIDE)!!
        assertEquals("0", p.id)
        assertEquals(PanoPlusLens.ULTRA_WIDE, p.requested)
        assertEquals(PanoPlusLens.WIDE, p.ran)
        assertFalse("a substitution must never claim to be honoured", p.honoured)
        assertTrue(p.why, p.why.contains("NO ultra-wide"))
        assertTrue(p.why, p.why.contains("ran instead"))
    }

    @Test
    fun `a 92 degree lens is not 0_5x - the band is Pano's, not merely wider than the other`() {
        // vision-camera would hide the 0.5x chip on this device (92° < 94°), so
        // a 0.5x request here must not open the 92° camera and call it 0.5x.
        val cams = listOf(
            cam("0", back = true, hFov = 78.0, order = 0),
            cam("2", back = true, hFov = 92.0, order = 1),
        )
        val p = pickCameraForLens(cams, PanoPlusLens.ULTRA_WIDE)!!
        assertEquals("0", p.id)
        assertFalse(p.honoured)
    }

    @Test
    fun `no wide-band camera at all - the default rear camera is the 1x, and the note says why`() {
        val odd = listOf(
            cam("0", back = true, hFov = 50.0, order = 0),    // telephoto-band main
            cam("2", back = true, hFov = 105.0, order = 1),
        )
        val p = pickCameraForLens(odd, PanoPlusLens.WIDE)!!
        assertEquals("0", p.id)
        assertTrue(p.why, p.why.contains("default rear camera"))
        assertTrue(p.why, p.why.contains("no back camera reports an hFOV in the wide band"))
        // …and the ultra-wide is still the ultra-wide.
        assertEquals("2", pickCameraForLens(odd, PanoPlusLens.ULTRA_WIDE)!!.id)
    }

    @Test
    fun `an unknown hFOV never becomes the 0_5x and is printed as a word, not NaN`() {
        val cams = listOf(
            cam("0", back = true, hFov = 78.0, order = 0),
            cam("2", back = true, hFov = Double.NaN, order = 1),
        )
        val p = pickCameraForLens(cams, PanoPlusLens.ULTRA_WIDE)!!
        assertEquals("0", p.id)
        assertFalse(p.honoured)
        assertFalse(p.why, p.why.contains("NaN"))
        assertTrue(p.why, p.why.contains("unknown hFOV"))
    }

    @Test
    fun `cameras without a YUV stream are not candidates`() {
        val cams = listOf(
            cam("0", back = true, hFov = 78.0, order = 0),
            cam("2", back = true, hFov = 110.0, yuv = false, order = 1),
        )
        val p = pickCameraForLens(cams, PanoPlusLens.ULTRA_WIDE)!!
        assertEquals("0", p.id)
        assertFalse(p.honoured)
    }

    @Test
    fun `no back camera - chosen across all facings, and the note says so`() {
        val frontOnly = listOf(
            cam("1", back = false, hFov = 80.0, order = 0),
        )
        val p = pickCameraForLens(frontOnly, PanoPlusLens.WIDE)!!
        assertEquals("1", p.id)
        assertTrue(p.why, p.why.contains("no LENS_FACING_BACK camera"))
        assertNull(pickCameraForLens(emptyList(), PanoPlusLens.WIDE))
    }

    // ── classification of the camera that RAN ───────────────────────────

    @Test
    fun `lensRan is by band - ultra-wide above 94, everything else is the 1x`() {
        assertEquals(PanoPlusLens.ULTRA_WIDE, panoLensOf(96.2))
        assertEquals(PanoPlusLens.WIDE, panoLensOf(94.0))
        assertEquals(PanoPlusLens.WIDE, panoLensOf(69.7))
        assertEquals(PanoPlusLens.WIDE, panoLensOf(30.0))
        assertEquals(PanoPlusLens.WIDE, panoLensOf(Double.NaN))
        assertEquals("ultra-wide", panoLensBand(96.2))
        assertEquals("wide", panoLensBand(69.7))
        assertEquals("wide", panoLensBand(60.0))
        assertEquals("telephoto", panoLensBand(59.9))
        assertEquals("unknown", panoLensBand(Double.NaN))
        assertNotNull(PanoPlusLens.ULTRA_WIDE.wire)
        assertEquals("ultraWide", PanoPlusLens.ULTRA_WIDE.wire)
        assertEquals("wide", PanoPlusLens.WIDE.wire)
    }
}
