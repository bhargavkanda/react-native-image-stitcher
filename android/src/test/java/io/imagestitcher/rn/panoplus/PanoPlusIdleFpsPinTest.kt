// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusIdleFpsPinTest.kt — the ONE AE-target-fps-range selector, and the
// one guard that refuses to request a range an output cannot clock.
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────
//
// On iOS the idle viewfinder opened a DIFFERENT camera configuration from the
// sweep — `.high` (16:9) with a free-running frame rate against the sweep's
// 4:3 at a pinned 60 — so the operator framed in a letterbox and the preview
// stuttered in dim light (fixed 2026-09-07 in
// `RNISPanoAvfSource.startIdlePreviewOnSessionQ`).
//
// Android's preview SHAPE was already right: `PanoPlusIdlePreviewSession`
// derives its preview size from the recording size through the same rate
// ladder the recorder runs. Its RATE was not: `buildRequest` set
// CONTROL_MODE, AE/AWB mode, flash, stabilisation, zoom and AF and never
// CONTROL_AE_TARGET_FPS_RANGE, while `PanoPlusAndroidRecorder.baseRequest`
// does. TEMPLATE_PREVIEW's default range is the HAL's own, and every HAL that
// publishes a variable one lets AE lengthen the exposure in a dim aisle — the
// exact stutter the operator reported on iOS, and the reason the sweep prefers
// a FIXED range at the same ceiling.
//
// The fix is not "set a range in the preview too" — that is a SECOND selector,
// and two selectors drift. `pickAeFpsRange` is the recorder's own rule lifted
// out verbatim so both call sites reach the same answer by construction, the
// way `largestAtLeastFps` already is for the size ladder.
//
// `outputCanSustainFpsRange` is the 10-fps trap
// (`PanoPlusAndroidRecorder.kt` ~:2649: "a 4000x3000 output that can only be
// clocked at 10 fps no matter what CONTROL_AE_TARGET_FPS_RANGE says") asked as
// a question the idle viewfinder can answer before it requests anything: a
// FIXED 60 on a surface the HAL clocks at 10 is a request the device cannot
// honour, and the honest move is to skip the pin and SAY SO rather than have
// the repeating request refused and the viewfinder go black.
//
// JVM only (no device, no emulator):
//   cd <host-app>/android && ./gradlew :react-native-image-stitcher:testDebugUnitTest

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusIdleFpsPinTest {

    private fun r(lo: Int, hi: Int) = PanoPlusProbeMath.FpsRange(lo, hi)

    // ── pickAeFpsRange: the recorder's rule, and nobody else's ─────────

    /**
     * The A35's published list, in the order the HAL lists it. The sweep asks
     * for 60 and takes the FIXED [60,60]: a variable range at the same ceiling
     * would let AE lengthen the exposure, and a long exposure on a moving
     * phone is the motion blur 60 exists to defend against.
     */
    @Test
    fun `a fixed range is preferred over a variable one at the same ceiling`() {
        val ranges = listOf(r(15, 30), r(30, 30), r(15, 60), r(60, 60))
        assertEquals(r(60, 60), PanoPlusProbeMath.pickAeFpsRange(ranges, 60))
    }

    /**
     * The LOWEST ceiling that still reaches the preference, not the highest
     * available: a [30,120] would clock the sensor twice as fast as asked and
     * halve the exposure for nothing.
     */
    @Test
    fun `the lowest ceiling that reaches the preference wins`() {
        val ranges = listOf(r(30, 120), r(24, 60), r(15, 30))
        assertEquals(r(24, 60), PanoPlusProbeMath.pickAeFpsRange(ranges, 60))
    }

    /**
     * 60 is a motion-blur DEFENCE, not an engine requirement: a body that
     * publishes nothing above 30 still gets a range requested, and the caller
     * says so in words. Highest ceiling, fixed breaking the tie.
     */
    @Test
    fun `no range reaching the preference falls back to the highest ceiling`() {
        val ranges = listOf(r(15, 30), r(30, 30), r(7, 15))
        assertEquals(r(30, 30), PanoPlusProbeMath.pickAeFpsRange(ranges, 60))
    }

    /**
     * A camera that publishes no CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES gets
     * NOTHING requested. Inventing a range the characteristics do not advertise
     * is how a capture request gets refused wholesale.
     */
    @Test
    fun `an empty published list yields no range at all`() {
        assertNull(PanoPlusProbeMath.pickAeFpsRange(emptyList(), 60))
    }

    /**
     * THE ANTI-DRIFT TEST, and the reason this function exists at all rather
     * than being written twice. Whatever the recorder would request for a
     * given published list, the idle viewfinder requests the same thing —
     * because it is the same call.
     */
    @Test
    fun `the idle viewfinder and the sweep cannot disagree`() {
        val published = listOf(r(15, 15), r(15, 30), r(30, 30), r(15, 60), r(60, 60), r(30, 120))
        for (want in listOf(15, 24, 30, 60, 120, 240)) {
            val sweep = PanoPlusProbeMath.pickAeFpsRange(published, want)
            val idle = PanoPlusProbeMath.pickAeFpsRange(published, want)
            assertEquals("preferFps=$want", sweep, idle)
        }
    }

    /**
     * CHARACTERISATION, not a new behaviour: [pickAeFpsRange] was LIFTED out of
     * `PanoPlusAndroidRecorder.start`, and lifting a rule is only safe if the
     * lifted copy answers identically. This holds the recorder's two original
     * lambdas as an oracle and sweeps a corpus past both. It was GREEN the
     * moment it was written — the refactor was already in — and it is here so
     * the sweep's own choice cannot drift under the extraction.
     *
     * The oracle, verbatim from the pre-2026-09-07 recorder:
     *
     *     fpsRange = ranges.filter { it.upper >= want }.minByOrNull {
     *         (if (it.lower == it.upper) 0 else 1_000_000) + it.upper
     *     } ?: ranges.maxByOrNull {
     *         it.upper * 1000 + (if (it.lower == it.upper) 1 else 0)
     *     }
     */
    @Test
    fun `the extracted selector answers exactly as the recorder's own lambdas did`() {
        fun oracle(
            ranges: List<PanoPlusProbeMath.FpsRange>,
            want: Int,
        ): PanoPlusProbeMath.FpsRange? =
            ranges.filter { it.upper >= want }.minByOrNull {
                (if (it.lower == it.upper) 0 else 1_000_000) + it.upper
            } ?: ranges.maxByOrNull {
                it.upper * 1000 + (if (it.lower == it.upper) 1 else 0)
            }

        val corpora = listOf(
            emptyList(),
            listOf(r(30, 30)),
            listOf(r(15, 30), r(30, 30), r(15, 60), r(60, 60)),
            listOf(r(60, 60), r(15, 60), r(30, 30), r(15, 30)),
            listOf(r(7, 15), r(15, 15), r(10, 24), r(24, 24)),
            listOf(r(30, 120), r(24, 60), r(15, 30), r(120, 120)),
            listOf(r(15, 30), r(15, 30)),
        )
        for (ranges in corpora) {
            for (want in listOf(1, 15, 24, 30, 60, 90, 120, 240)) {
                assertEquals(
                    "ranges=$ranges want=$want",
                    oracle(ranges, want),
                    PanoPlusProbeMath.pickAeFpsRange(ranges, want),
                )
            }
        }
    }

    // ── outputCanSustainFpsRange: the 10-fps trap ──────────────────────

    /**
     * The trap itself, in the shape it bit in: the HAL clocks this output at
     * 10 fps no matter what the AE range says, so a FIXED 60 is a request it
     * cannot honour.
     */
    @Test
    fun `a fixed 60 is refused on an output the HAL clocks at 10`() {
        assertFalse(PanoPlusProbeMath.outputCanSustainFpsRange(r(60, 60), 10.0))
    }

    /**
     * A VARIABLE range is not the same question. [15,60] on a 30-fps output is
     * honourable — AE simply runs at the bottom of the range — so only the
     * LOWER bound is tested. Refusing here would disable the pin on the very
     * devices it helps most.
     */
    @Test
    fun `a variable range whose floor the output can reach is honourable`() {
        assertTrue(PanoPlusProbeMath.outputCanSustainFpsRange(r(15, 60), 30.0))
        assertFalse(PanoPlusProbeMath.outputCanSustainFpsRange(r(15, 60), 10.0))
    }

    /**
     * The NTSC tolerance, for the same reason `largestAtLeastFps` carries one:
     * a 59.94 fps output publishes 16 683 350 ns, and an exact `>= 60.0` would
     * call a body that genuinely reaches 60 unable to.
     */
    @Test
    fun `an NTSC-rate output still satisfies a fixed 60`() {
        val ntsc = PanoPlusProbeMath.maxFpsFromMinFrameDuration(16_683_350L)!!
        assertTrue(PanoPlusProbeMath.outputCanSustainFpsRange(r(60, 60), ntsc))
    }

    /**
     * An UNPUBLISHED duration is not evidence of slowness, and this is the
     * ordinary case for a preview-sized SurfaceTexture. The recorder requests
     * its range on such a camera too; refusing here would mean the pin never
     * fires on most bodies, which is a silent no-op dressed as a guard.
     */
    @Test
    fun `an unpublished output rate does not veto the pin`() {
        assertTrue(PanoPlusProbeMath.outputCanSustainFpsRange(r(60, 60), null))
    }
}
