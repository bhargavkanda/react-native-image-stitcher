// SPDX-License-Identifier: Apache-2.0
//
// M2 — a live AR sweep runs on the stitcher's ARCore session and on nothing of
// pano+'s own. The rule is the pure `panoStartMode`, and `start()` must consult
// it before it can open anything.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PanoPlusStartModeTest {

    @Test
    fun `a live AR sweep is ALWAYS the AR-plugin arm — no flag decides it`() {
        assertEquals(
            PanoStartMode.AR_PLUGIN,
            panoStartMode(live = true, poseSource = "ar", arcoreReference = ArCoreRefMode.OFF, vcPluginArm = false),
        )
        // The vc flag cannot pull an AR sweep onto the vc arm either.
        assertEquals(
            PanoStartMode.AR_PLUGIN,
            panoStartMode(live = true, poseSource = "ar", arcoreReference = ArCoreRefMode.OFF, vcPluginArm = true),
        )
    }

    @Test
    fun `a live AR sweep that asks for pano+'s own ARCore is refused by name`() {
        for (ref in listOf(ArCoreRefMode.SHARED, ArCoreRefMode.STANDALONE, ArCoreRefMode.AUTO)) {
            assertEquals(
                PanoStartMode.REFUSE_OWN_ARCORE_ON_AR_ARM,
                panoStartMode(live = true, poseSource = "ar", arcoreReference = ref, vcPluginArm = false),
            )
        }
    }

    @Test
    fun `the vc arm is read WITH the IMU pose arm, never alone`() {
        assertEquals(
            PanoStartMode.VC_PLUGIN,
            panoStartMode(live = true, poseSource = "imu", arcoreReference = ArCoreRefMode.OFF, vcPluginArm = true),
        )
    }

    @Test
    fun `M3 — a live IMU sweep on no plugin arm is refused unless it owns its camera`() {
        // <Camera> never sends this: its non-AR Android sweep is the vc arm or
        // refused in JS. Reaching here means the arm was lost on the way, and
        // pano+'s own Camera2 client would be a second camera owner.
        assertEquals(
            PanoStartMode.REFUSE_LIVE_WITHOUT_CAMERA,
            panoStartMode(live = true, poseSource = "imu", arcoreReference = ArCoreRefMode.OFF, vcPluginArm = false),
        )
        // A surface that OWNS its camera (standalone, or the DR-1a hatch) may.
        assertEquals(
            PanoStartMode.RECORDER,
            panoStartMode(
                live = true, poseSource = "imu", arcoreReference = ArCoreRefMode.OFF,
                vcPluginArm = false, allowOwnCamera = true,
            ),
        )
        // Recording sessions are untouched.
        assertEquals(
            PanoStartMode.RECORDER,
            panoStartMode(live = false, poseSource = "imu", arcoreReference = ArCoreRefMode.OFF, vcPluginArm = false),
        )
    }

    @Test
    fun `a RECORDING session keeps the reference channel — that is the basis-falsification run`() {
        assertEquals(
            PanoStartMode.RECORDER,
            panoStartMode(live = false, poseSource = "ar", arcoreReference = ArCoreRefMode.SHARED, vcPluginArm = false),
        )
    }

    @Test
    fun `start() decides the mode BEFORE it can open an ARCore channel or a camera`() {
        // Structural, and deliberately so: the call order is the whole defect
        // M2 fixes (the plugin arm was dispatched AFTER pano+'s ARCore channel
        // and pose arm had already opened), and a unit JVM cannot run start().
        val src = File("src/main/java/io/imagestitcher/rn/panoplus/PanoPlusAndroidRecorder.kt").readText()
        val start = src.indexOf("    fun start(promise: Promise) {")
        assertTrue("start() not found", start >= 0)
        val body = src.substring(start)
        val mode = body.indexOf("panoStartMode(")
        val channel = body.indexOf("openArCoreChannel(")
        val cameraService = body.indexOf("CAMERA_SERVICE")
        assertTrue("start() must consult panoStartMode", mode >= 0)
        assertTrue("panoStartMode must precede openArCoreChannel", channel < 0 || mode < channel)
        assertTrue("panoStartMode must precede the camera service", cameraService < 0 || mode < cameraService)
    }

    @Test
    fun `the AR-plugin pose row is one the offline basis reader keeps`() {
        val q = doubleArrayOf(0.1, 0.2, 0.3, 0.927)
        val t = doubleArrayOf(0.01, 0.02, 0.03)
        val row = panoArPluginPoseRow(1.5e9, q, t, "normal")
        // rnis_pano_android_s1 keeps only kind "arcore-frame" with
        // trackingState "TRACKING" — ARCore's name, not the plugin contract's.
        assertTrue(row, row.contains("\"kind\":\"arcore-frame\""))
        assertTrue(row, row.contains("\"trackingState\":\"TRACKING\""))
        assertTrue(row, row.contains("\"tsNs\":1500000000"))
        assertTrue(row, row.contains("\"q\":[0.1,0.2,0.3,0.927]"))
        assertTrue(row, row.contains("\"source\":\"ar-plugin\""))
        assertTrue(panoArPluginPoseRow(1.0, q, t, "limited").contains("\"trackingState\":\"PAUSED\""))
        assertTrue(panoArPluginPoseRow(1.0, q, t, "notAvailable").contains("\"trackingState\":\"STOPPED\""))
    }
}
