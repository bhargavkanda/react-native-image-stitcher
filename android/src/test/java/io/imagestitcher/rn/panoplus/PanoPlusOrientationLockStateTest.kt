// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusOrientationLockStateTest.kt — the portrait lock captures the prior
// orientation ONCE and restores it on the LAST release, and can never restore
// its own locked value as if it were the host's.
//
// This is the bookkeeping behind PanoPlusPortraitLock, which gives the pano+
// segment the same `requestedOrientation = PORTRAIT` lock the Pano segment gets
// from RNSARSession — bound to the viewfinder view's attach/detach so no JS path
// can forget to release it. The Activity call is six lines; everything that can
// be wrong is in here, and runs on the JVM with no android.jar.
//
//   cd <host-app>/android && \
//     ./gradlew :react-native-image-stitcher:testDebugUnitTest

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusOrientationLockStateTest {

    private companion object {
        const val PORTRAIT = 1        // ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        const val UNSPECIFIED = -1    // ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        const val LANDSCAPE = 0       // a host that pinned landscape before us
    }

    private class Owner

    @Test
    fun `first hold captures the prior and asks for portrait, last release restores it`() {
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val v = Owner()
        var reads = 0
        assertEquals(PORTRAIT, s.hold(v) { reads++; UNSPECIFIED })
        assertEquals(1, reads)
        assertEquals(UNSPECIFIED, s.prior)
        assertTrue(s.isHeld)

        assertEquals(UNSPECIFIED, s.release(v))
        assertFalse(s.isHeld)
        assertNull("the capture is forgotten once nobody holds", s.prior)
    }

    @Test
    fun `a host that had pinned landscape gets landscape back, not a generic default`() {
        // RNSARSession's own promise: "restores the EXACT orientation the
        // Activity had before we locked".
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val v = Owner()
        s.hold(v) { LANDSCAPE }
        assertEquals(LANDSCAPE, s.release(v))
    }

    @Test
    fun `a second holder neither re-captures nor re-applies`() {
        // React can attach a re-keyed view BEFORE it detaches the old one.
        // The second attach must not read the Activity (it would read OUR
        // portrait value and later "restore" it — the leak by another road).
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val a = Owner()
        val b = Owner()
        assertEquals(PORTRAIT, s.hold(a) { UNSPECIFIED })
        assertNull(s.hold(b) { error("the Activity must not be read for a second holder") })
        assertEquals(2, s.holderCount)
        assertEquals(UNSPECIFIED, s.prior)
    }

    @Test
    fun `releasing the first of two holders restores nothing - the lock stays held`() {
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val a = Owner()
        val b = Owner()
        s.hold(a) { UNSPECIFIED }
        s.hold(b) { error("unreachable") }
        assertNull("the re-keyed view is still on screen", s.release(a))
        assertTrue(s.isHeld)
        assertEquals(UNSPECIFIED, s.release(b))
        assertFalse(s.isHeld)
    }

    @Test
    fun `the same owner holding twice is one hold, and releasing twice is one release`() {
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val v = Owner()
        assertEquals(PORTRAIT, s.hold(v) { UNSPECIFIED })
        assertNull(s.hold(v) { error("unreachable") })
        assertEquals(1, s.holderCount)
        assertEquals(UNSPECIFIED, s.release(v))
        assertNull("a second release must not restore again", s.release(v))
    }

    @Test
    fun `releasing an owner that never held is a no-op`() {
        // A view dropped before it ever attached must not restore anything —
        // there is nothing to restore and another view may still hold.
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val a = Owner()
        val stranger = Owner()
        s.hold(a) { UNSPECIFIED }
        assertNull(s.release(stranger))
        assertTrue(s.isHeld)
    }

    @Test
    fun `after a full release the next hold reads the Activity afresh`() {
        // Between two pano+ visits the Pano segment's own lock may have come
        // and gone; a stale capture would restore the wrong value.
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val a = Owner()
        s.hold(a) { UNSPECIFIED }
        s.release(a)
        val b = Owner()
        assertEquals(PORTRAIT, s.hold(b) { LANDSCAPE })
        assertEquals(LANDSCAPE, s.prior)
        assertEquals(LANDSCAPE, s.release(b))
    }

    @Test
    fun `forget clears holders and the capture - a dead Activity restores nothing`() {
        val s = PanoPlusOrientationLockState(PORTRAIT)
        val a = Owner()
        s.hold(a) { UNSPECIFIED }
        s.forget()
        assertFalse(s.isHeld)
        assertNull(s.prior)
        assertNull("the old holder's release must not write to the new Activity", s.release(a))
    }
}
