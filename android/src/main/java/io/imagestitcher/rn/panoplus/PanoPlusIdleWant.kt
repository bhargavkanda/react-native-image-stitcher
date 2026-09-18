// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusIdleWant.kt — "is the idle viewfinder still wanted?", as a token.
//
// ── WHY THIS IS A CLASS AND NOT AN `AtomicLong` IN THE RECORDER ─────────
//
// Because the rule it encodes has an EXCEPTION, and the exception is the one
// that silently breaks the feature.
//
// `PanoPlusAndroidRecorder.startIdlePreview` now PARKS on `Dispatchers.IO`
// waiting for the panel's viewfinder view to offer its SurfaceTexture (see
// `PanoPlusPreview.awaitSurface` — the panel's effect and the view's mount are
// one React commit and reached native 12 ms apart on the operator's A35, with
// the effect winning and the preview then refusing forever). A park that long
// can be overtaken: the operator closes the panel, or presses START, while the
// request is still asleep. `stopIdlePreviewAsync` cannot reach it — there is no
// session installed yet, so it finds `null` and returns having done nothing —
// and the sleeper would wake and open a camera nobody wants. That is a leaked
// `CameraDevice` for the life of the process, surfacing later as CAMERA_IN_USE
// on an innocent caller.
//
// So every stop CANCELS. Every stop except one: `startIdlePreview` calls
// `stopIdlePreview("restarting-idle-preview")` ITSELF, on its way to installing
// its own session, to clear a previous one. If that stop cancelled, it would
// cancel the very request it is serving and NO idle preview could ever start —
// which is exactly the bug this file's first draft had, on the way to fixing
// the operator's black screen with a different black screen.
//
// A bare counter puts that distinction in a comment. This puts it in a type,
// and in the test beside it.

package io.imagestitcher.rn.panoplus

import java.util.concurrent.atomic.AtomicLong

/**
 * A monotonic "which request is wanted" token.
 *
 * Thread-safe and allocation-free. Every method is safe from any thread; the
 * only ordering it promises is the one it needs — a [cancel] that HAPPENS
 * BEFORE an [isCurrent] is visible to it.
 */
internal class PanoPlusIdleWant {

    private val gen = AtomicLong(0)

    /**
     * Begin a request and take its token. Supersedes any request already in
     * flight: an older token stops being current the moment this returns, so a
     * second `setIdlePreview(true)` cannot leave two opens racing to install.
     */
    fun begin(): Long = gen.incrementAndGet()

    /**
     * No idle viewfinder is wanted any more. Every in-flight request — parked,
     * opening, or installed — stops being current.
     *
     * Idempotent, and meaningful even when nothing is installed: that is the
     * whole point, since the dangerous window is precisely the one where there
     * is nothing for a stop to find.
     */
    fun cancel() {
        gen.incrementAndGet()
    }

    /** Is [token] still the request the caller should be serving? */
    fun isCurrent(token: Long): Boolean = gen.get() == token
}
