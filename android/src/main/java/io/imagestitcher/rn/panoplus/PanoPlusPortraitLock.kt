// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusPortraitLock.kt — pano+ holds the SAME portrait lock Pano holds,
// for the same span, from the pano+ side.
//
// ── WHY THE PANO+ SCREEN ROTATED AND PANO'S DID NOT ─────────────────────
//
// The owner, 2026-09-03: "the pano UI does not rotate in landscape currently —
// why does the pano+ rotate?" The mechanism, verified: the stitcher's `<Camera>`
// sets `activity.requestedOrientation = SCREEN_ORIENTATION_PORTRAIT` in its
// mount effect and restores the prior value in its cleanup
// (`react-native-image-stitcher/…/RNSARSession.kt:205-238`, called from
// `Camera.tsx:1793-1803`). pano+ on the decoupled arm UNMOUNTS that camera, so
// the lock is released and the whole Activity follows the accelerometer —
// which is what he saw. The manifest declares no `screenOrientation` and lists
// `orientation|screenSize` in `configChanges`, so nothing else pins it.
//
// ── WHY IT IS BOUND TO THE VIEWFINDER VIEW, NOT TO A @ReactMethod PAIR ──
//
// RNSARSession's lock is two bridge methods called from a JS effect, and it
// has one documented exposure: a JS reload between the mount and the cleanup
// leaks the lock (no `invalidate`/`onHostDestroy` restore exists there). This
// file was asked to pick "the one that cannot leak on unmount/crash", and that
// is the VIEW: `PanoPlusPreviewView` is mounted for the whole pano+ segment on
// Android (the host's capture surface renders it whenever the AR arm is not
// armed, which on this path is always), React detaches it on the UI thread in the same commit
// that unmounts the surface — no bridge hop a JS exception or a reload can
// skip — and a reload tears the root view down, which detaches it too. A
// native crash takes the Activity's `requestedOrientation` with the process.
// There is nothing for JS to remember to call.
//
// ── RESTORE, EXACTLY AS RNSARSession DOES ───────────────────────────────
//
// The prior value is captured ONCE, on the first holder, and restored when
// the LAST holder lets go. The holder set exists because React can attach a
// re-keyed view before it detaches the old one; a plain flag would restore the
// prior value in that gap and then re-capture PORTRAIT as the "prior" — the
// leak, by a different road. When no holder remains the capture is forgotten,
// so the next hold reads the Activity afresh rather than a stale value.
//
// ⚠ TWO LOCKS ON ONE ACTIVITY. The stitcher's lock and this one both target
// `MainActivity`, and each restores what IT saw. They never hold together:
// a host shell that swaps between the two engines does so behind a
// strict-swap grace period (250 ms measured), so the stitcher's
// unlock has landed on the UI thread long before this view attaches, and this
// view has detached long before the stitcher's mount effect captures. If a
// future host ever mounts both in one commit, whichever captures second reads
// PORTRAIT as prior and the lock outlives both — that is the residual, and it
// is the grace window's to keep closed.
//
// ── THE PART THAT IS TESTABLE OFF-DEVICE ────────────────────────────────
//
// [PanoPlusOrientationLockState] is the bookkeeping — holders, capture, what
// to apply, what to restore — over plain ints, with no `android.*` in it, so
// the JVM suite pins it. [PanoPlusPortraitLock] is the six lines that touch
// the Activity.

package io.imagestitcher.rn.panoplus

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.util.Log
import android.view.View
import com.facebook.react.bridge.ReactContext

private const val LOCK_TAG = "PanoPlusPortraitLock"

/**
 * Pure state machine for a capture-once / restore-on-last-release lock.
 *
 * Every method returns WHAT TO DO — the orientation to write, or null for
 * "nothing" — and never does it. Thread-confined by its caller (the UI thread
 * in production, the test thread in the suite), so it is not synchronised.
 */
internal class PanoPlusOrientationLockState(
    /** The value every hold applies. `SCREEN_ORIENTATION_PORTRAIT` in
     *  production; a plain int here so the test needs no android.jar. */
    private val lockedValue: Int,
) {
    /** Identity set: a view is a holder, and two views are two holders. */
    private val holders = java.util.Collections.newSetFromMap(
        java.util.IdentityHashMap<Any, Boolean>(),
    )

    /** The Activity's value before the FIRST hold. Null when nobody holds. */
    var prior: Int? = null
        private set

    val holderCount: Int get() = holders.size
    val isHeld: Boolean get() = holders.isNotEmpty()

    /**
     * [owner] wants the lock. Returns the orientation to APPLY — the locked
     * value on the first hold, null afterwards (already applied; and a second
     * holder must not re-read a "prior" that is now our own locked value).
     *
     * @param current the Activity's `requestedOrientation` right now, read by
     *   the caller only when this is the first hold.
     */
    fun hold(owner: Any, current: () -> Int): Int? {
        if (!holders.add(owner)) return null          // same owner twice: idempotent
        if (holders.size > 1) return null             // already locked by another holder
        prior = current()
        return lockedValue
    }

    /**
     * [owner] lets go. Returns the orientation to RESTORE when it was the
     * last holder, else null. An owner that never held is a no-op — a view
     * that was dropped before it ever attached must not restore anything.
     */
    fun release(owner: Any): Int? {
        if (!holders.remove(owner)) return null
        if (holders.isNotEmpty()) return null
        val p = prior
        prior = null
        return p
    }

    /**
     * The Activity is gone: nothing to restore on it, and its value must not
     * be carried into the next Activity as a "prior". Clears everything.
     */
    fun forget() {
        holders.clear()
        prior = null
    }
}

/**
 * The lock itself. UI-thread only — both callers are View attach/detach
 * callbacks, which the framework delivers there.
 */
internal object PanoPlusPortraitLock {

    private val state = PanoPlusOrientationLockState(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)

    /** The Activity the lock is currently applied to, so a release restores
     *  the one that was captured even if `currentActivity` has moved on. */
    private var lockedActivity: Activity? = null

    /** A view is on screen; pin the Activity to portrait if nobody has yet. */
    fun hold(view: View) {
        val activity = activityOf(view.context)
        if (activity == null) {
            Log.w(LOCK_TAG, "hold: no Activity behind the viewfinder's context — not locking")
            return
        }
        if (lockedActivity != null && lockedActivity !== activity) {
            // A new Activity while the old one's holders never detached (a
            // destroy that skipped detach). The old value cannot be restored
            // on a dead Activity; start clean on this one.
            state.forget()
        }
        val apply = state.hold(view) { activity.requestedOrientation } ?: return
        lockedActivity = activity
        try {
            activity.requestedOrientation = apply
            Log.i(
                LOCK_TAG,
                "portrait lock HELD (prior requestedOrientation=${state.prior}) — same lock the " +
                    "Pano segment's RNSARSession holds; released when the pano+ viewfinder detaches",
            )
        } catch (t: Throwable) {
            Log.w(LOCK_TAG, "setRequestedOrientation threw on hold", t)
        }
    }

    /** A view left the screen; restore the prior value if it was the last. */
    fun release(view: View) {
        val restore = state.release(view) ?: return
        val activity = lockedActivity ?: activityOf(view.context)
        lockedActivity = null
        if (activity == null) {
            Log.w(LOCK_TAG, "release: no Activity to restore requestedOrientation=$restore on")
            return
        }
        try {
            activity.requestedOrientation = restore
            Log.i(LOCK_TAG, "portrait lock RELEASED — requestedOrientation restored to $restore")
        } catch (t: Throwable) {
            Log.w(LOCK_TAG, "setRequestedOrientation threw on release", t)
        }
    }

    /**
     * The Activity behind a View's context. A `ThemedReactContext` is a
     * `ContextWrapper` whose base is the application context — no Activity in
     * that chain — so `ReactContext.currentActivity` is the route that works
     * for RN views; the wrapper walk is for any host that hands us a real
     * Activity context.
     */
    private fun activityOf(ctx: Context?): Activity? {
        var c = ctx
        while (c != null) {
            if (c is Activity) return c
            if (c is ReactContext) {
                val a = try { c.currentActivity } catch (_: Throwable) { null }
                if (a != null) return a
            }
            c = (c as? ContextWrapper)?.baseContext
        }
        return null
    }
}
