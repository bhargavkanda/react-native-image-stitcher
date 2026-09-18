// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusSelectionRuleTest.kt — the pack must not claim a selection rule that
// did not run.
//
// `device.json → selection.rule` is the field a reader consults to find out HOW
// the camera was chosen, and it used to be a two-branch ternary that knew
// nothing about ARCore.  In shared-camera mode ARCore CHOOSES the camera id, so
// a sweep with no explicit `cameraId` option — the panel's normal case —
// recorded "largest horizontal FOV among LENS_FACING_BACK cameras" beside the
// hFOV of a camera that rule had not chosen.
//
// Measured on SM-A356U1: ARCore's shared CameraConfig list contains only camera
// 0 (69.7° hFOV); the widest-FOV rule's own answer is camera 2 at 96.2°.  The
// pack therefore asserted that 69.7° was the widest back FOV the device has, and
// a reader comparing this canvas with an earlier ultra-wide pack would blame the
// device rather than the experiment.
//
// Runs on the JVM (no device, no emulator, no ARCore on the classpath):
//   cd <host-app>/android && \
//     ./gradlew :react-native-image-stitcher:testDebugUnitTest

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusSelectionRuleTest {

    @Test
    fun `an ordinary sweep still reports the widest-FOV rule`() {
        val r = cameraSelectionRule(
            openedCameraId = "2",
            requestedCameraId = null,
            forcedByArCoreId = null,
            arcoreModeRan = null,
            wouldHaveCameraId = "2",
            wouldHaveHFovDeg = 96.2,
        )
        assertTrue(r, r.contains("largest horizontal FOV"))
        assertFalse(r, r.contains("ARCore"))
    }

    @Test
    fun `an explicit option is named as the option, not as the rule`() {
        val r = cameraSelectionRule(
            openedCameraId = "0",
            requestedCameraId = "0",
            forcedByArCoreId = null,
            arcoreModeRan = null,
            wouldHaveCameraId = "2",
            wouldHaveHFovDeg = 96.2,
        )
        assertTrue(r, r.contains("explicit cameraId option"))
        assertFalse(r, r.contains("largest horizontal FOV"))
    }

    @Test
    fun `a shared-camera sweep must NOT claim the widest-FOV rule chose the camera`() {
        // THE A35 CASE, verbatim.
        val r = cameraSelectionRule(
            openedCameraId = "0",
            requestedCameraId = null,
            forcedByArCoreId = "0",
            arcoreModeRan = "shared",
            wouldHaveCameraId = "2",
            wouldHaveHFovDeg = 96.2,
        )
        assertFalse(
            "the rule must not be claimed on a sweep where ARCore chose the camera: $r",
            r.contains("largest horizontal FOV"),
        )
        assertTrue(r, r.contains("FORCED to camera 0"))
        // The road not taken has to be IN the string: without it a reader cannot
        // tell that hFovDeg is not this device's widest.
        assertTrue(r, r.contains("camera 2"))
        assertTrue(r, r.contains("96.2"))
    }

    @Test
    fun `a forced camera that also had an explicit option names both`() {
        val r = cameraSelectionRule(
            openedCameraId = "0",
            requestedCameraId = "2",
            forcedByArCoreId = "0",
            arcoreModeRan = "shared",
            wouldHaveCameraId = "2",
            wouldHaveHFovDeg = 96.2,
        )
        assertTrue(r, r.contains("FORCED to camera 0"))
        assertTrue(r, r.contains("the option asked for '2'"))
    }

    @Test
    fun `a standalone sweep says no camera of ours was opened`() {
        // ARCore owns the camera; this pack has no pixels. Reporting a selection
        // rule here would describe a choice that was never made.
        val r = cameraSelectionRule(
            openedCameraId = null,
            requestedCameraId = null,
            forcedByArCoreId = null,
            arcoreModeRan = "standalone",
            wouldHaveCameraId = "2",
            wouldHaveHFovDeg = 96.2,
        )
        assertTrue(r, r.contains("no camera was opened"))
        assertTrue(r, r.contains("STANDALONE"))
        assertFalse(r, r.contains("largest horizontal FOV"))
    }

    @Test
    fun `a sweep the chip's lens chose must NOT claim the widest-FOV rule`() {
        // THE FIRST 1x PACK OFF THE A35 (pp_1788462948742, 2026-09-04): camera
        // 0 opened for `lensRequested: wide`, and `rule` still read "largest
        // horizontal FOV among LENS_FACING_BACK cameras" — beside hFovDeg 69.7
        // on a device whose widest is 96.2. The same lie this function was
        // written to close, by a new road.
        val r = cameraSelectionRule(
            openedCameraId = "0",
            requestedCameraId = null,
            forcedByArCoreId = null,
            arcoreModeRan = null,
            wouldHaveCameraId = "2",
            wouldHaveHFovDeg = 96.2,
            lensRequestedLabel = "1x",
        )
        assertFalse(r, r.contains("largest horizontal FOV"))
        assertTrue(r, r.contains("the chip's 1x lens"))
        assertTrue(r, r.contains("NOT the widest-FOV rule"))
    }

    @Test
    fun `the lens is outranked by an explicit option and by ARCore, as in start()`() {
        val explicit = cameraSelectionRule(
            openedCameraId = "0", requestedCameraId = "0", forcedByArCoreId = null,
            arcoreModeRan = null, wouldHaveCameraId = "2", wouldHaveHFovDeg = 96.2,
            lensRequestedLabel = "0.5x",
        )
        assertTrue(explicit, explicit.contains("explicit cameraId option"))
        assertFalse(explicit, explicit.contains("chip"))

        val forced = cameraSelectionRule(
            openedCameraId = "0", requestedCameraId = null, forcedByArCoreId = "0",
            arcoreModeRan = "shared", wouldHaveCameraId = "2", wouldHaveHFovDeg = 96.2,
            lensRequestedLabel = "0.5x",
        )
        assertTrue(forced, forced.contains("FORCED to camera 0"))
        assertFalse(forced, forced.contains("chip"))
    }

    @Test
    fun `an unknown would-have FOV is said to be unknown, never printed as a number`() {
        // No camera exposed both focal length and physical size, so the rule
        // could not run at all. "NaN°" in a provenance string is worse than a
        // word: it looks like a measurement.
        val r = cameraSelectionRule(
            openedCameraId = "0",
            requestedCameraId = null,
            forcedByArCoreId = "0",
            arcoreModeRan = "shared",
            wouldHaveCameraId = null,
            wouldHaveHFovDeg = Double.NaN,
        )
        assertFalse(r, r.contains("NaN"))
        assertTrue(r, r.contains("an unknown hFOV"))
    }
}
