// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusArCoreModeTest.kt — the host-testable half of the ARCore reference
// channel.
//
// The channel itself needs a phone, a camera and a Play Services APK.  What
// does NOT is the option parser that decides which of four experiments a sweep
// runs, and it has one specific way of lying: a TYPO.
//
// `arcoreReference: "shard"` must be OFF.  If an unrecognised value fell
// through to AUTO — the tidy-looking default — a misspelt option in a field
// build would silently start a second camera client, take the camera away from
// the recorder's own selection, change the pack's raster, and produce a pack
// that reads as a deliberate shared-camera A/B.  That failure is invisible in
// every log and is only discoverable by reading device.json afterwards, which
// is exactly the class of defect this programme keeps paying for.
//
// The four modes are also not four flavours of one thing, and the parser is
// where that is enforced:
//   OFF        — no ARCore.  No falsification is possible from the pack.
//   SHARED     — the same-pixels A/B.  ARCore joins the recorder's capture.
//   STANDALONE — ARCore owns the camera; NO pixels of ours.  Answers the basis
//                question and NOT the pose-arm A/B.
//   AUTO       — try SHARED, fall back to STANDALONE, and NAME the fallback.
//
// Runs on the JVM (no device, no emulator, no ARCore on the classpath):
//   cd <host-app>/android && \
//     ./gradlew :react-native-image-stitcher:testDebugUnitTest

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class PanoPlusArCoreModeTest {

    @Test
    fun `the default and every off spelling parse to OFF`() {
        // The recorder passes optStr(..., "off") when the key is absent, so
        // the literal default has to land on OFF too.
        for (v in listOf(null, "", "off", "OFF", "Off", "false", "none")) {
            assertEquals("input=$v", ArCoreRefMode.OFF, parseArCoreRefMode(v))
        }
    }

    @Test
    fun `the three real modes parse, case-insensitively`() {
        assertEquals(ArCoreRefMode.SHARED, parseArCoreRefMode("shared"))
        assertEquals(ArCoreRefMode.SHARED, parseArCoreRefMode("SHARED"))
        assertEquals(ArCoreRefMode.STANDALONE, parseArCoreRefMode("standalone"))
        assertEquals(ArCoreRefMode.STANDALONE, parseArCoreRefMode("Standalone"))
        // `separate` is the word an operator reaches for when describing the
        // back-to-back arm, and it means the same experiment.
        assertEquals(ArCoreRefMode.STANDALONE, parseArCoreRefMode("separate"))
        assertEquals(ArCoreRefMode.AUTO, parseArCoreRefMode("auto"))
        assertEquals(ArCoreRefMode.AUTO, parseArCoreRefMode("true"))
    }

    @Test
    fun `a TYPO is OFF, never AUTO`() {
        // The defect this test exists for. AUTO would open a camera, change
        // the pack's raster, and label the result as a deliberate experiment.
        for (v in listOf("shard", "shraed", "standalon", "yes", "1", "on", "sharedd")) {
            assertEquals("input=$v", ArCoreRefMode.OFF, parseArCoreRefMode(v))
            assertNotEquals("input=$v", ArCoreRefMode.AUTO, parseArCoreRefMode(v))
        }
    }

    // ── The availability guard, on a JVM with no ARCore on the classpath ──
    //
    // This is not a contrived environment: it is EXACTLY the runtime shape of
    // a host app that does not depend on ARCore, because this module declares
    // ARCore `compileOnly` and packages none of it. The guard must answer
    // "not-linked" and must NOT throw — a `Class.forName` miss that escaped
    // would take down a recorder start.

    @Test
    fun `the classpath probe ANSWERS rather than throwing`() {
        // ⚠ THIS ASSERTION INVERTED WITH THE PACKAGE MOVE, AND THE INVERSION
        // IS THE POINT. In the private overlay pano+ came from, ARCore was
        // `compileOnly` and deliberately off the test classpath, so the probe
        // answered null here and the test pinned that. This package declares
        // ARCore as an `implementation` dependency, so the class IS loadable
        // in a unit-test JVM and the probe finds it.
        //
        // What the probe actually guarantees is unchanged and is what is
        // pinned now: it ANSWERS — never throws, never propagates a
        // ClassNotFoundException or a NoClassDefFoundError — and its answer
        // agrees with whether the class is genuinely loadable. Asserting a
        // fixed null would have been asserting this package's dependency
        // scope, which is build configuration, not behaviour.
        val direct: Class<*>? = try {
            Class.forName("com.google.ar.core.ArCoreApk")
        } catch (_: Throwable) {
            null
        }
        assertEquals(direct, arCoreApkClassOrNull())
    }

    @Test
    fun `the not-linked verdict names where the runtime is supposed to come from`() {
        val a = arCoreNotLinked()
        assertEquals(false, a.linked)
        assertEquals(false, a.supported)
        assertEquals("not-linked", a.status)
        // The verdict must say WHERE the runtime was supposed to come from;
        // "ARCore is missing" alone sends a reader hunting in the wrong build
        // file. Since this package declares ARCore itself, reaching this
        // verdict means something removed it.
        assert(a.detail.contains("implementation dependency")) { a.detail }
        assert(a.detail.contains("host app")) { a.detail }
    }

    @Test
    fun `OFF is not an unavailability`() {
        // "not requested" and "requested and refused" are different pack
        // provenances. A pack whose reason reads `off (...)` was never an
        // experiment; one that reads `unavailable: ...` was an experiment that
        // failed, and reading the first as the second makes a working build
        // look broken on every ordinary sweep.
        val anything = ArCoreAvailability(true, "SUPPORTED_INSTALLED", true, "fine")
        val p = planArCoreChannel(ArCoreRefMode.OFF, anything)
        assertEquals(false, p.proceed)
        assert(p.reason.startsWith("off")) { p.reason }
    }

    @Test
    fun `a build with no ARCore refuses BY NAME, carrying the detail through`() {
        val p = planArCoreChannel(ArCoreRefMode.SHARED, arCoreNotLinked())
        assertEquals(false, p.proceed)
        assert(p.reason.startsWith("unavailable:")) { p.reason }
        // The DETAIL must survive the plan, not be flattened to "unavailable".
        // Its wording changed when pano+ moved packages (ARCore went from a
        // compileOnly of the host's copy to this package's own implementation
        // dependency), so assert the part that is about the channel rather
        // than the part that is about dependency scope.
        assert(p.reason.contains("ArCoreApk is not on the classpath")) { p.reason }
    }

    @Test
    fun `an unsupported device refuses even when the classes are linked`() {
        // The A35 could plausibly be here. `linked` says the SDK is on the
        // classpath; only `supported` says Play Services for AR will serve
        // this device — and collapsing the two would construct a Session that
        // throws UnavailableDeviceNotCapableException on the recorder's
        // critical path.
        val linkedButNot = ArCoreAvailability(
            linked = true,
            status = "UNSUPPORTED_DEVICE_NOT_CAPABLE",
            supported = false,
            detail = "ARCore does not support this device.",
        )
        for (m in listOf(ArCoreRefMode.SHARED, ArCoreRefMode.STANDALONE, ArCoreRefMode.AUTO)) {
            val p = planArCoreChannel(m, linkedButNot)
            assertEquals("mode=$m", false, p.proceed)
            assert(p.reason.contains("UNSUPPORTED_DEVICE_NOT_CAPABLE")) { p.reason }
        }
    }

    @Test
    fun `UNKNOWN_CHECKING refuses rather than racing an unsettled answer`() {
        // checkAvailability starts an ASYNCHRONOUS query. Treating "still
        // checking" as available would construct a Session against an answer
        // that has not arrived.
        val checking = ArCoreAvailability(
            linked = true, status = "UNKNOWN_CHECKING", supported = false,
            detail = "asynchronous query has not finished",
        )
        val p = planArCoreChannel(ArCoreRefMode.SHARED, checking)
        assertEquals(false, p.proceed)
        assert(p.reason.contains("UNKNOWN_CHECKING")) { p.reason }
    }

    @Test
    fun `only STANDALONE clears the shared flag`() {
        val ok = ArCoreAvailability(true, "SUPPORTED_INSTALLED", true, "fine")
        assertEquals(true, planArCoreChannel(ArCoreRefMode.SHARED, ok).shared)
        // AUTO tries SHARED first — the fallback is a runtime event, and it is
        // NAMED in the advisories when it happens rather than being planned.
        assertEquals(true, planArCoreChannel(ArCoreRefMode.AUTO, ok).shared)
        assertEquals(false, planArCoreChannel(ArCoreRefMode.STANDALONE, ok).shared)
        for (m in listOf(ArCoreRefMode.SHARED, ArCoreRefMode.STANDALONE, ArCoreRefMode.AUTO)) {
            assertEquals("mode=$m", true, planArCoreChannel(m, ok).proceed)
        }
    }
}
