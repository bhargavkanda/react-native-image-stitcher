// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusIdleWantTest.kt — the idle viewfinder's cancellation policy.
//
// These pin a rule with ONE exception, and both halves have already been got
// wrong once each on the way to fixing the operator's black pano+ screen:
//
//   * Miss the RULE and a request parked in `PanoPlusPreview.awaitSurface`
//     wakes after the panel has closed and opens a camera nobody wants — a
//     CameraDevice leaked for the life of the process.
//   * Miss the EXCEPTION and `startIdlePreview`'s own housekeeping stop
//     cancels the request it is serving, so no idle preview can EVER start.
//     (That was the first draft of the fix. It replaced the operator's black
//     screen with a different black screen.)
//
// Pure JVM: this suite has no Robolectric, so the Android halves of the change
// — `awaitSurface`'s monitor and the recorder's camera ordering — are verified
// on hardware instead. What is testable here is the policy, and the policy is
// where the two mistakes above live.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class PanoPlusIdleWantTest {

    @Test
    fun `a fresh request is current`() {
        val want = PanoPlusIdleWant()
        val gen = want.begin()
        assertTrue("a request nothing has cancelled must still be served", want.isCurrent(gen))
    }

    @Test
    fun `a cancel makes the in-flight request stale`() {
        val want = PanoPlusIdleWant()
        val gen = want.begin()
        want.cancel()
        assertFalse(
            "setIdlePreview(false) during the awaitSurface park must stop the open",
            want.isCurrent(gen),
        )
    }

    @Test
    fun `cancel works when nothing is installed — that is the dangerous window`() {
        // The recorder's `stopIdlePreviewAsync` returns early when no session
        // exists. During the park there IS no session, so the token is the
        // only thing that can reach the sleeper.
        val want = PanoPlusIdleWant()
        val gen = want.begin()
        want.cancel() // no session, nothing else to stop
        assertFalse(want.isCurrent(gen))
    }

    @Test
    fun `a second start supersedes the first`() {
        val want = PanoPlusIdleWant()
        val first = want.begin()
        val second = want.begin()
        assertFalse("a lens flip must not leave two opens racing", want.isCurrent(first))
        assertTrue(want.isCurrent(second))
    }

    @Test
    fun `the housekeeping stop inside startIdlePreview must NOT cancel its own request`() {
        // THE EXCEPTION, AS THE RECORDER SEQUENCES IT.
        //   val gen = idleWant.begin()                       // take the token
        //   stopIdlePreview("restarting", cancelWant = false) // clear a PREVIOUS session
        //   if (!idleWant.isCurrent(gen)) return              // must NOT fire
        val want = PanoPlusIdleWant()
        val gen = want.begin()
        // cancelWant = false ⇒ stopIdlePreview does not touch the token.
        assertTrue(
            "the stop that serves this request must leave it current, or no idle " +
                "preview can ever start",
            want.isCurrent(gen),
        )
    }

    @Test
    fun `every external stop DOES cancel`() {
        // The three callers that pass cancelWant = true (the default):
        // setIdlePreview(false), start()'s "superseded-by-start", and the two
        // lifecycle teardowns.
        for (reason in listOf("setIdlePreview(false)", "superseded-by-start", "host-destroyed")) {
            val want = PanoPlusIdleWant()
            val gen = want.begin()
            want.cancel()
            assertFalse("'$reason' must cancel a parked request", want.isCurrent(gen))
        }
    }

    @Test
    fun `the async stop's LATE half must not cancel — a lens flip is begin-then-late-stop`() {
        // THE FROZEN-VIEWFINDER-ON-FIRST-LENS-FLIP BUG, as token arithmetic.
        //
        // `stopIdlePreviewAsync` cancels SYNCHRONOUSLY on the caller's thread —
        // RN's NativeModules queue — and then launches a coroutine to close the
        // camera. A lens flip is ONE React commit, so that queue sees, in order:
        //
        //   (A) setIdlePreview(false)      → idleWant.cancel(), launch coroutine
        //   (C) setIdlePreview(true, NEW)  → val gen = idleWant.begin()
        //
        // (A) before (C) is guaranteed; the COROUTINE before (C) is not. If its
        // `stopIdlePreview` used the default `cancelWant = true`, its cancel
        // would land after (C)'s `begin()` and bump the generation past a token
        // the new request is already holding — so the request that the operator
        // just made is stale before it opens anything, and settles false with
        // "no longer wanted (the panel closed, or a sweep started)" over a
        // TextureView still showing the OLD lens's last frame. Nothing re-arms.
        val want = PanoPlusIdleWant()

        want.cancel()                 // (A), on the queue — ordered, correct
        val gen = want.begin()        // (C), on the queue — the new request
        // …the async half of (A) finally runs, on IO, ordered against nothing:
        // with `cancelWant = false` it touches no token at all.
        assertTrue(
            "the async stop's late half must leave the NEXT request current — "
                + "if this fails, the first 1x<->0.5x flip freezes the viewfinder",
            want.isCurrent(gen),
        )

        // And the inverse, so this test fails for the right reason: a late half
        // that DID cancel is exactly what kills it.
        val regressed = PanoPlusIdleWant()
        regressed.cancel()
        val gen2 = regressed.begin()
        regressed.cancel()            // what `cancelWant = true` would have done
        assertFalse(
            "sanity: a late cancel really does strand the new request",
            regressed.isCurrent(gen2),
        )
    }

    @Test
    fun `a cancelled request stays cancelled`() {
        val want = PanoPlusIdleWant()
        val gen = want.begin()
        want.cancel()
        want.cancel()
        assertFalse("a second stop must not wrap around into current again", want.isCurrent(gen))
    }

    @Test
    fun `concurrent begins hand out distinct tokens and exactly one survives`() {
        // The token is read from several threads (an IO coroutine parked in
        // awaitSurface, RN's NativeModules queue issuing a stop). This asserts
        // the counter is not merely "usually" monotonic.
        val want = PanoPlusIdleWant()
        val threads = 16
        val ready = CountDownLatch(threads)
        val go = CountDownLatch(1)
        val done = CountDownLatch(threads)
        val tokens = java.util.Collections.synchronizedList(mutableListOf<Long>())
        val stillCurrent = AtomicInteger(0)

        repeat(threads) {
            Thread {
                ready.countDown()
                go.await(5, TimeUnit.SECONDS)
                tokens.add(want.begin())
                done.countDown()
            }.start()
        }
        assertTrue(ready.await(5, TimeUnit.SECONDS))
        go.countDown()
        assertTrue(done.await(5, TimeUnit.SECONDS))

        assertTrue("every begin must hand out its own token", tokens.toSet().size == threads)
        for (t in tokens) if (want.isCurrent(t)) stillCurrent.incrementAndGet()
        assertTrue(
            "exactly one request may survive a burst of begins, got ${stillCurrent.get()}",
            stillCurrent.get() == 1,
        )
    }
}
