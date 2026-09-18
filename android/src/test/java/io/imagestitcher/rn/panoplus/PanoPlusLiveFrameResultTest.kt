// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusLiveFrameResultTest.kt — the packed int the live engine returns for
// every frame, decoded.
//
// ── WHY THIS IS WORTH A TEST ────────────────────────────────────────────────
//
// `nativeLiveIngest` returns ONE int per frame rather than an object, because
// it is called thirty times a second and an `IntArray` return would allocate a
// Java object to carry four bits. The cost of that choice is a bit layout
// written down TWICE — once in the JNI shim's anonymous-namespace enum and
// once in [PanoPlusLiveNative] — with no compiler between them.
//
// Change one and the other is silently wrong, and the symptom is not a crash:
// it is a `painted` that reads as `previewRendered`, i.e. a HUD that says the
// sweep is committing strips while the canvas stays black. That is precisely
// the class of defect this programme has paid for repeatedly, so the layout is
// pinned here in the language that can be tested off-device.
//
// ⚠ THE C++ HALF CANNOT BE ASSERTED FROM HERE. These tests pin the Kotlin
// decode against the documented layout; the encode lives in the one translation
// unit no host test can reach (it needs <jni.h>). The mirror is named in both
// files, and the runtime proof is a device sweep whose `livePainted` count
// tracks the engine's own `painted` in the pack's meta.json.
//
// Touches no `android.*` and no React Native type, by the suite's own rule —
// `PanoLiveFrameResult` is a value class over an Int and the constants it reads
// are `const val`, so they inline and the enclosing object is never loaded.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusLiveFrameResultTest {

    /** The encode side of the boundary, spelled exactly as the JNI spells it. */
    private fun pack(ran: Boolean, painted: Boolean, preview: Boolean, outcome: Int): Int {
        if (!ran) return 0
        var p = PanoPlusLiveNative.RAN
        if (painted) p = p or PanoPlusLiveNative.PAINTED
        if (preview) p = p or PanoPlusLiveNative.PREVIEW
        return p or ((outcome + 1) shl PanoPlusLiveNative.OUTCOME_SHIFT)
    }

    @Test
    fun `zero is a dropped frame and never outcome zero`() {
        // 0 is the JNI's "the frame did not reach the engine" — no session, a
        // wrong-sized buffer, a conversion that refused. It must NOT decode as
        // `Outcome::Painted` (ordinal 0), which is what a naive layout without
        // the +1 bias would do: a dropped frame would then be indistinguishable
        // from the single most successful outcome there is.
        val r = PanoLiveFrameResult(0)
        assertFalse(r.ran)
        assertFalse(r.painted)
        assertFalse(r.previewRendered)
        assertEquals(-1, r.outcome)
    }

    @Test
    fun `a painted frame decodes every flag and the outcome`() {
        // Outcome::Painted == 0 (rnis_pano.hpp) — the case the +1 bias exists
        // for.
        val r = PanoLiveFrameResult(pack(ran = true, painted = true, preview = false, outcome = 0))
        assertTrue(r.ran)
        assertTrue(r.painted)
        assertFalse(r.previewRendered)
        assertEquals(0, r.outcome)
    }

    @Test
    fun `a rejected frame still counts as having reached the engine`() {
        // Outcome::RejectedLowResponse == 3. A rejection is a DECISION, not a
        // failure: the engine saw the frame, measured it and declined to commit
        // a strip. `ran` must stay true or the recorder's `liveRefused` counter
        // — which means "the engine could not even look at this" — would absorb
        // every ordinary rejection and point the RCA at the wrong half.
        val r = PanoLiveFrameResult(pack(ran = true, painted = false, preview = false, outcome = 3))
        assertTrue(r.ran)
        assertFalse(r.painted)
        assertEquals(3, r.outcome)
    }

    @Test
    fun `the preview bit is independent of the painted bit`() {
        // The preview renders on a THROTTLE, not on a paint: a tick that
        // rendered while the engine skipped, and a paint on a tick the throttle
        // was not due for, are both ordinary. Sharing a bit — or deriving one
        // from the other — would make the HUD's "preview alive" light track the
        // wrong thing.
        val previewOnly =
            PanoLiveFrameResult(pack(ran = true, painted = false, preview = true, outcome = 2))
        assertTrue(previewOnly.previewRendered)
        assertFalse(previewOnly.painted)

        val paintOnly =
            PanoLiveFrameResult(pack(ran = true, painted = true, preview = false, outcome = 0))
        assertFalse(paintOnly.previewRendered)
        assertTrue(paintOnly.painted)
    }

    @Test
    fun `every engine outcome ordinal survives the round trip`() {
        // rnis::pano::Outcome runs 0..12 today and grows. The shift is 8, so the
        // ordinal field is a whole byte — but a future enum past 254 would wrap
        // silently, so the whole range in use is walked rather than sampled.
        for (outcome in 0..254) {
            val r = PanoLiveFrameResult(
                pack(ran = true, painted = false, preview = false, outcome = outcome),
            )
            assertTrue("outcome $outcome lost `ran`", r.ran)
            assertEquals("outcome $outcome did not round-trip", outcome, r.outcome)
        }
    }

    @Test
    fun `the flag bits do not collide with the outcome field`() {
        // The three flags live below bit 8 and the outcome above it. If the
        // shift ever shrinks, an outcome of 1 would set the PAINTED bit and
        // every WarmingUp frame would report as painted — a black canvas with a
        // HUD claiming strips. Asserted as arithmetic rather than trusted.
        val allFlags = PanoPlusLiveNative.RAN or
            PanoPlusLiveNative.PAINTED or
            PanoPlusLiveNative.PREVIEW
        assertTrue(
            "the flag mask overlaps the outcome field",
            allFlags < (1 shl PanoPlusLiveNative.OUTCOME_SHIFT),
        )
    }

    @Test
    fun `pack frame modes match the C++ PackFrames ordinals`() {
        // `PackFrames` in rnis_pano_live.hpp: All = 0, Painted = 1, None = 2.
        // These cross the JNI as a bare int, so a reordering on either side
        // would turn a "write every frame" request into "write none" — and the
        // symptom is a pack that replays to nothing, weeks later, with no
        // evidence of why.
        assertEquals(0, PanoPlusLiveNative.PACK_FRAMES_ALL)
        assertEquals(1, PanoPlusLiveNative.PACK_FRAMES_PAINTED)
        assertEquals(2, PanoPlusLiveNative.PACK_FRAMES_NONE)
    }
}
