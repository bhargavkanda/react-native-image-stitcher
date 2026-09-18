// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusProbeMathTest.kt — the host-testable half of the Android capability
// probe.
//
// WHY THIS EXISTS.  The probe itself cannot be tested without a phone, but the
// three derivations that turn raw CameraCharacteristics into the numbers the
// pano+ port will make decisions on ARE pure arithmetic, and each has a known
// way of lying:
//   * `maxFpsFromMinFrameDuration` — a HAL that publishes 0 means "no minimum
//     published", NOT "infinitely fast"; a probe that divided anyway would
//     report ∞ fps and the port would believe it.
//   * `largestMatchingAspectAtLeastFps` — the 60 fps question is decided in
//     whole nanoseconds, so a device capable of 59.94 fps publishes
//     16 683 350 ns and an exact `>= 60.0` comparison silently answers "no".
//   * `fovDegrees` / `focalPixels` — the fx ÷ imageWidth ratio the engine's
//     lens gate reads (rnis_pano.cpp `lens::resolve`) must come out invariant
//     under raster scale, or the ratio measured here cannot be compared with
//     the one a frame will produce.
//
// These run on the JVM (no device, no emulator):
//   cd <host-app>/android && ./gradlew :react-native-image-stitcher:testDebugUnitTest
//
// PanoPlusProbeMath deliberately takes primitives (no android.util.Size, no
// WritableMap) so this suite needs neither a mockable android.jar nor React
// Native on the classpath.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusProbeMathTest {

    /** A size the HAL published with an achievable frame rate. */
    private fun sz(w: Int, h: Int, fps: Double) =
        PanoPlusProbeMath.OutputSize(w, h, Math.round(1e9 / fps))

    /** A size whose min frame duration the HAL did NOT publish (0 ns). */
    private fun szUnknown(w: Int, h: Int) =
        PanoPlusProbeMath.OutputSize(w, h, 0L)

    // ── maxFpsFromMinFrameDuration ───────────────────────────────────

    @Test
    fun `an unpublished min frame duration is unknown, never infinite`() {
        assertNull(PanoPlusProbeMath.maxFpsFromMinFrameDuration(0L))
        assertNull(PanoPlusProbeMath.maxFpsFromMinFrameDuration(-1L))
    }

    @Test
    fun `min frame duration inverts to frames per second`() {
        assertEquals(30.0, PanoPlusProbeMath.maxFpsFromMinFrameDuration(33_333_333L)!!, 1e-3)
        assertEquals(60.0, PanoPlusProbeMath.maxFpsFromMinFrameDuration(16_666_666L)!!, 1e-3)
        assertEquals(120.0, PanoPlusProbeMath.maxFpsFromMinFrameDuration(8_333_333L)!!, 1e-3)
    }

    // ── matchesAspect ────────────────────────────────────────────────

    @Test
    fun `four by three is recognised at every raster the HALs actually publish`() {
        assertTrue(PanoPlusProbeMath.matchesAspect(4032, 3024, 4, 3))
        assertTrue(PanoPlusProbeMath.matchesAspect(4000, 3000, 4, 3))
        assertTrue(PanoPlusProbeMath.matchesAspect(1440, 1080, 4, 3))
        assertTrue(PanoPlusProbeMath.matchesAspect(640, 480, 4, 3))
    }

    @Test
    fun `sixteen by nine is not four by three`() {
        assertFalse(PanoPlusProbeMath.matchesAspect(1920, 1080, 4, 3))
        assertFalse(PanoPlusProbeMath.matchesAspect(3840, 2160, 4, 3))
    }

    @Test
    fun `a degenerate size matches nothing rather than dividing by zero`() {
        assertFalse(PanoPlusProbeMath.matchesAspect(0, 0, 4, 3))
        assertFalse(PanoPlusProbeMath.matchesAspect(1920, 0, 4, 3))
        assertFalse(PanoPlusProbeMath.matchesAspect(-4, -3, 4, 3))
    }

    // ── largestMatchingAspectAtLeastFps ──────────────────────────────

    private val catalogue = listOf(
        sz(4032, 3024, 30.0),
        sz(1920, 1440, 60.0),
        sz(1280, 960, 120.0),
        sz(1920, 1080, 60.0),   // 16:9 — must never be chosen for a 4:3 ask
        szUnknown(2048, 1536),  // unpublished duration — not evidence of 60
    )

    @Test
    fun `the largest four by three at sixty is the largest one that reaches sixty`() {
        val pick = PanoPlusProbeMath.largestMatchingAspectAtLeastFps(catalogue, 4, 3, 60.0)
        assertNotNull(pick)
        assertEquals(1920, pick!!.width)
        assertEquals(1440, pick.height)
    }

    @Test
    fun `the largest four by three at thirty is the full-array one`() {
        val pick = PanoPlusProbeMath.largestMatchingAspectAtLeastFps(catalogue, 4, 3, 30.0)
        assertNotNull(pick)
        assertEquals(4032, pick!!.width)
    }

    @Test
    fun `a size whose min frame duration is unpublished is never counted as fast`() {
        val only = listOf(szUnknown(4032, 3024))
        assertNull(PanoPlusProbeMath.largestMatchingAspectAtLeastFps(only, 4, 3, 30.0))
    }

    @Test
    fun `nothing fast enough answers null rather than the nearest miss`() {
        assertNull(PanoPlusProbeMath.largestMatchingAspectAtLeastFps(catalogue, 4, 3, 240.0))
        assertNull(PanoPlusProbeMath.largestMatchingAspectAtLeastFps(emptyList(), 4, 3, 30.0))
    }

    @Test
    fun `NTSC rates count as their nominal rate`() {
        // 59.94 fps ⇒ 16 683 350 ns.  An exact `>= 60.0` would answer "no 60 fps
        // size" on a device that has one; the tolerance is why it does not.
        val ntsc = listOf(PanoPlusProbeMath.OutputSize(1920, 1440, 16_683_350L))
        assertNotNull(PanoPlusProbeMath.largestMatchingAspectAtLeastFps(ntsc, 4, 3, 60.0))
        val ntsc30 = listOf(PanoPlusProbeMath.OutputSize(4032, 3024, 33_366_700L))
        assertNotNull(PanoPlusProbeMath.largestMatchingAspectAtLeastFps(ntsc30, 4, 3, 30.0))
    }

    @Test
    fun `the tolerance does not stretch to the next rate up`() {
        // 30 fps must not be reported as satisfying a 60 fps ask.
        val thirty = listOf(sz(1920, 1440, 30.0))
        assertNull(PanoPlusProbeMath.largestMatchingAspectAtLeastFps(thirty, 4, 3, 60.0))
    }

    // ── sensor min delay ─────────────────────────────────────────────

    @Test
    fun `a zero min delay is on-change or unspecified, not unbounded`() {
        assertNull(PanoPlusProbeMath.maxHzFromMinDelayUs(0))
        assertNull(PanoPlusProbeMath.maxHzFromMinDelayUs(-1))
    }

    @Test
    fun `min delay inverts to hertz`() {
        assertEquals(200.0, PanoPlusProbeMath.maxHzFromMinDelayUs(5000)!!, 1e-6)
        assertEquals(400.0, PanoPlusProbeMath.maxHzFromMinDelayUs(2500)!!, 1e-6)
    }

    // ── optics ───────────────────────────────────────────────────────

    @Test
    fun `horizontal field of view comes off the sensor width and the focal length`() {
        assertEquals(65.898, PanoPlusProbeMath.fovDegrees(7.0, 5.4)!!, 0.01)
        assertEquals(51.850, PanoPlusProbeMath.fovDegrees(5.25, 5.4)!!, 0.01)
    }

    @Test
    fun `a missing sensor dimension or focal length yields no field of view`() {
        assertNull(PanoPlusProbeMath.fovDegrees(0.0, 5.4))
        assertNull(PanoPlusProbeMath.fovDegrees(7.0, 0.0))
        assertNull(PanoPlusProbeMath.fovDegrees(Double.NaN, 5.4))
        assertNull(PanoPlusProbeMath.fovDegrees(7.0, Double.POSITIVE_INFINITY))
    }

    @Test
    fun `focal length in pixels is the millimetre focal over the pixel pitch`() {
        assertEquals(3085.714, PanoPlusProbeMath.focalPixels(5.4, 4000, 7.0)!!, 1e-3)
        assertNull(PanoPlusProbeMath.focalPixels(5.4, 0, 7.0))
        assertNull(PanoPlusProbeMath.focalPixels(0.0, 4000, 7.0))
        assertNull(PanoPlusProbeMath.focalPixels(5.4, 4000, 0.0))
    }

    @Test
    fun `the engine's fx over width ratio is invariant under raster scale`() {
        // rnis_pano.cpp `lens::resolve` gates on fx ÷ imageWidth precisely
        // because it survives the host rescaling intrinsics to the raster it
        // copied.  If the probe's ratio were raster-dependent it could not be
        // compared against a frame's.
        val full = PanoPlusProbeMath.focalPixels(5.4, 4000, 7.0)!! / 4000.0
        val half = PanoPlusProbeMath.focalPixels(5.4, 2000, 7.0)!! / 2000.0
        assertEquals(full, half, 1e-12)
        assertEquals(5.4 / 7.0, full, 1e-12)
    }
}
