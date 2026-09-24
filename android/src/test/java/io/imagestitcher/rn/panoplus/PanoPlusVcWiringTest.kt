// SPDX-License-Identifier: Apache-2.0
//
// M4 review — the recorder's vision-camera wiring, checked structurally (a
// unit JVM cannot run start() or a CameraX camera). Each assertion is one
// review finding whose fix lives in a line a refactor could drop with every
// behavioural test still green.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PanoPlusVcWiringTest {
    private val rec = File("src/main/java/io/imagestitcher/rn/panoplus/PanoPlusAndroidRecorder.kt").readText()
    private val plugin = File("src/main/java/io/imagestitcher/rn/panoplus/PanoPlusSweepFrameProcessor.kt").readText()
    private val live = File("src/main/java/io/imagestitcher/rn/panoplus/PanoPlusLiveModule.kt").readText()

    private fun body(src: String, sig: String): String {
        val i = src.indexOf(sig)
        assertTrue("$sig not found", i >= 0)
        return src.substring(i, (i + 6000).coerceAtMost(src.length))
    }

    @Test
    fun `the plugin no longer reads a CaptureResult off the frame — CameraX never pairs one`() {
        assertTrue(!plugin.contains("metaOf(frame)"))
    }

    @Test
    fun `the vc arm attaches the result tap, is active BEFORE it arms, and re-checks teardown after`() {
        val b = body(rec, "private fun startVcPluginArm(")
        val attach = b.indexOf("attachResults(")
        val active = b.indexOf("vcPluginArmActive = true")
        val arm = b.indexOf("PanoPlusVcFrameSink.arm(this)")
        val recheck = b.indexOf("if (torndown.get())")
        assertTrue("attach the tap", attach >= 0)
        assertTrue("attach before arm", attach < arm)
        assertTrue("active before arm", active in 0 until arm)
        assertTrue("re-check teardown after arm", recheck > arm)
        assertTrue("clear a stale lock at arm", b.indexOf("unlock()") in 0 until arm)
    }

    @Test
    fun `the lock is taken by the settle, not on the first frame`() {
        val b = body(rec, "override fun onVcFrameMeta(")
        assertTrue(b.contains("vcSettle?.feed("))
        assertTrue(b.contains("d.focusDistance"))
    }

    @Test
    fun `the pack carries a derived lock verdict and the join counters`() {
        assertTrue(rec.contains(".s(\"verdict\", panoVcLockVerdict("))
        assertTrue(rec.contains(".i(\"joinMisses\""))
        assertTrue(rec.contains(".i(\"vcFramesDroppedAtDisarm\""))
    }

    @Test
    fun `teardown and invalidate take the tap off as well as the lock`() {
        assertTrue(rec.contains("vcTapDetached = PanoPlusVcBridge.cameraLock?.detachResults()"))
        assertTrue(live.contains("cameraLock?.detachResults()"))
    }
}
