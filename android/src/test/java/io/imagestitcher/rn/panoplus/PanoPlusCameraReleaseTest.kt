// SPDX-License-Identifier: Apache-2.0
//
// M8 review — the camera-release point is scoped to the session that is
// INSTALLED. A stop's teardown marks its own generation; a superseded session,
// or one that lost the install race, cannot mark the sweep that did install.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusCameraReleaseTest {

    @Test
    fun `a new session starts unreleased and its own teardown releases it`() {
        val g = PanoPlusCameraRelease.begin()
        assertFalse(PanoPlusCameraRelease.released)
        PanoPlusCameraRelease.release(g)
        assertTrue(PanoPlusCameraRelease.released)
    }

    @Test
    fun `a superseded session's teardown cannot release the new sweep`() {
        val old = PanoPlusCameraRelease.begin()
        val current = PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(old)          // lands late
        assertFalse(PanoPlusCameraRelease.released)
        PanoPlusCameraRelease.release(current)
        assertTrue(PanoPlusCameraRelease.released)
    }

    @Test
    fun `a session that lost the install race (generation -1) releases nothing`() {
        PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(-1L)
        assertFalse(PanoPlusCameraRelease.released)
    }

    @Test
    fun `the next session starts unreleased again`() {
        val g = PanoPlusCameraRelease.begin()
        PanoPlusCameraRelease.release(g)
        PanoPlusCameraRelease.begin()
        assertFalse(PanoPlusCameraRelease.released)
    }
}
