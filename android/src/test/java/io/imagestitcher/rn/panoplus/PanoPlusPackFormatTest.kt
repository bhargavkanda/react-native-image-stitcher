// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusPackFormatTest.kt — the two rules that decide whether a recorded
// pack is usable at all, pinned off device.
//
//   1. EVERY NUMBER MUST BE JSON.  `Double.toString` emits `NaN` and
//      `Infinity`, which `json.loads` rejects — and the row that carries a
//      non-finite number is always the pathological one the sweep was run to
//      capture.  One such row aborts the harness mid-pack.
//   2. THE JOIN KEY MUST BE ASCII DIGITS.  `frames/frame_%06d.jpg % seq` is
//      the ONLY thing tying a track row to its pixels.  `String.format`
//      without an explicit locale emits Eastern Arabic digits under an
//      ar-EG default, and every frame in the pack becomes unreachable — on a
//      device the operator cannot debug, for a reason nothing in the pack
//      would record.
//
// Both were real defects in this file before this test existed.

package io.imagestitcher.rn.panoplus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class PanoPlusPackFormatTest {

    private val defaultLocale: Locale = Locale.getDefault()

    @After fun restoreLocale() { Locale.setDefault(defaultLocale) }

    // ── 1. Non-finite numbers never reach the pack ──────────────────────

    // The divisions are the POINT: on device the non-finite value is always
    // computed (an fps from a zero time span, a mean of an empty stat), never
    // the literal constant, and a guard that only catches Double.NaN would let
    // the computed one straight through.
    @Suppress("DIVISION_BY_ZERO")
    @Test
    fun nonFiniteNumbersBecomeZeroNotNaN() {
        assertEquals("0", jnum(Double.NaN))
        assertEquals("0", jnum(Double.POSITIVE_INFINITY))
        assertEquals("0", jnum(Double.NEGATIVE_INFINITY))
        assertEquals("0", jnum(0.0 / 0.0))
        assertEquals("0", jnum(1.0 / 0.0))
    }

    @Test
    fun finiteNumbersSurviveVerbatim() {
        assertEquals("1.5", jnum(1.5))
        assertEquals("-0.25", jnum(-0.25))
        assertEquals("0.0", jnum(0.0))
        // Exponent form is valid JSON and must not be "helpfully" rewritten.
        assertTrue(jnum(1e-9).contains("E") || jnum(1e-9).startsWith("0.0"))
    }

    @Test
    fun nonFiniteNumbersAreZeroedThroughEveryEmitter() {
        assertEquals("[0,0,1.5]", jarr(Double.NaN, Double.POSITIVE_INFINITY, 1.5))
        assertEquals("""{"a":0,"b":2.0}""", Jo().n("a", Double.NaN).n("b", 2.0).end())
        // A Float NaN takes the same route as a Double one — this is the path
        // every LENS_FOCUS_DISTANCE / focal-length read actually uses.
        assertEquals("""{"f":0}""", Jo().n("f", Float.NaN).end())
    }

    @Test
    fun aRowFullOfUnreadableMetadataStillEmitsValidJson() {
        // The realistic worst case: a LEGACY device where every optional
        // CaptureResult key came back null or unreadable. The row must still
        // parse — a pack the harness cannot open records nothing at all.
        val row = Jo()
            .i("seq", 0L)
            .i("tsNs", 0L)
            .n("tsWallMs", Double.NaN)
            .raw("q", "[0,0,0,1]")
            .raw("t", "[0,0,0]")
            .n("fx", Double.NaN).n("fy", Double.NaN)
            .n("cx", Double.NaN).n("cy", Double.NaN)
            .i("w", 0).i("h", 0)
            .n("expDurS", 0.0)
            .s("qDeviceType", null)
            .raw("qDevice", "null")
            .b("metaJoined", false)
            .end()
        assertEquals(
            """{"seq":0,"tsNs":0,"tsWallMs":0,"q":[0,0,0,1],"t":[0,0,0],""" +
                """"fx":0,"fy":0,"cx":0,"cy":0,"w":0,"h":0,"expDurS":0.0,""" +
                """"qDeviceType":null,"qDevice":null,"metaJoined":false}""",
            row,
        )
    }

    // ── String escaping (advisories carry device-supplied text) ─────────

    @Test
    fun stringsAreEscaped() {
        assertEquals("\"plain\"", jstr("plain"))
        assertEquals("\"a\\\"b\"", jstr("a\"b"))
        assertEquals("\"a\\\\b\"", jstr("a\\b"))
        assertEquals("\"a\\nb\"", jstr("a\nb"))
        assertEquals("\"a\\tb\"", jstr("a\tb"))
        assertEquals("\"a\\u0000b\"", jstr("a\u0000b"))
    }

    @Test
    fun escapingIsLocaleIndependent() {
        // The \\uXXXX escape is String.format'd; a Turkish default locale is
        // the classic way an unqualified format produces a dotless i.
        Locale.setDefault(Locale.forLanguageTag("tr-TR"))
        assertEquals("\"\\u0001\"", jstr("\u0001"))
        Locale.setDefault(Locale.forLanguageTag("ar-EG"))
        assertEquals("\"\\u0001\"", jstr("\u0001"))
    }

    @Test
    fun emptyObjectAndKeyOrderAreStable() {
        assertEquals("{}", Jo().end())
        // Authoring order is the emitted order, so two packs from the same
        // build diff line-for-line.
        assertEquals(
            """{"z":1,"a":2,"m":true}""",
            Jo().i("z", 1L).i("a", 2L).b("m", true).end(),
        )
    }

    @Test
    fun nullsAreEmittedAsJsonNullNotTheStringNull() {
        assertEquals("""{"s":null,"i":null,"f":null}""",
            Jo().s("s", null).i("i", null as Int?).n("f", null as Float?).end())
    }

    // ── 2. The harness join key ─────────────────────────────────────────

    @Test
    fun frameFileNameIsZeroPaddedAsciiUnderAnyDefaultLocale() {
        for (tag in listOf("en-US", "ar-EG", "fa-IR", "hi-IN", "bn-BD", "my-MM", "tr-TR")) {
            Locale.setDefault(Locale.forLanguageTag(tag))
            assertEquals(
                "locale $tag corrupted the pack's only join key",
                "frame_000042.jpg", frameFileName(42L),
            )
            assertEquals("frame_000000.jpg", frameFileName(0L))
        }
    }

    @Test
    fun frameFileNameMatchesTheHarnessGlobExactly() {
        // every offline-twin reader builds the path as
        // "frames/frame_%06d.jpg" % t["seq"]. Six digits, zero-padded, and
        // NOT truncated once a long sweep passes 999999.
        assertEquals("frame_000001.jpg", frameFileName(1L))
        assertEquals("frame_012345.jpg", frameFileName(12345L))
        assertEquals("frame_999999.jpg", frameFileName(999999L))
        assertEquals("frame_1000000.jpg", frameFileName(1000000L))
        for (seq in longArrayOf(0, 1, 217, 4000)) {
            assertTrue(frameFileName(seq).matches(Regex("frame_[0-9]{6,}\\.jpg")))
        }
    }
}
