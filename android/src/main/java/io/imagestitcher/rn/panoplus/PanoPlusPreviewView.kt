// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusPreviewView.kt — the Android arm's VIEWFINDER, and the surface
// handover that makes it safe.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────
//
// The operator opened the pano+ Android panel and saw no camera. He was right:
// PanoPlusAndroidRecorder created ZERO preview surfaces. It is an
// `ImageReader`-only recorder, so a sweep was recorded BLIND — the operator
// aimed a black rectangle at a shelf and found out what he had captured by
// replaying the pack afterwards.
//
// iOS solved the same problem on 2026-08-31 (ios/RNISPanoSourceView.swift,
// whose header quotes the same report: "The camera screen is blank!!!"), and
// this is its Android counterpart: a `TextureView` that vends a `Surface` for
// the recorder to add as a SECOND session output beside the ImageReader.
//
// ── HOW IT DIFFERS FROM THE iOS ONE, AND WHY IT HAS TO ──────────────────
//
// The iOS view is a PURE OUTPUT: `AVCaptureVideoPreviewLayer` attaches itself
// to a session that already exists, so that view starts nothing, owns nothing
// and can be mounted and unmounted at any moment.
//
// Camera2 has no such thing. A preview is an OUTPUT SURFACE, and outputs are
// fixed when `createCaptureSession` runs — a surface that arrives afterwards
// cannot join, and a surface that goes away while the session still targets it
// is a buffer queue the HAL keeps writing into. So this file is not just a
// view: it is the HANDOVER PROTOCOL between a view whose lifetime is React's
// and a capture session whose lifetime is the recorder's.
//
// ── THE TRAP THIS FILE IS MOSTLY ABOUT ──────────────────────────────────
//
// `TextureView.SurfaceTextureListener.onSurfaceTextureDestroyed` RETURNS A
// BOOLEAN, and the default everyone writes is `true` — "yes, release it".
// Returning true while a capture session still holds that SurfaceTexture is a
// native crash in the producer, and it happens exactly when the operator
// closes the panel mid-sweep, which is the most ordinary thing he can do.
//
// So this returns FALSE whenever the recorder has the surface, takes ownership
// of the release, and performs it in [PanoPlusPreview.release] — which the
// recorder calls after `captureSession.close()` and `device.close()`, at which
// point nothing can be writing into it. Returning false makes the leak OUR
// problem, and the orphan handling below is the price of not crashing.
//
// ⚠ WHAT THAT LEAVES OPEN, STATED RATHER THAN HIDDEN. Between the view going
// away and the recorder tearing down, the camera is still filling a
// SurfaceTexture that nobody is calling `updateTexImage` on. Its BufferQueue
// can then fill, and a full queue back-pressures the producer. The window is
// bounded by the panel, which stops the recorder from its own unmount and
// close handlers (`if (recordingRef.current) void stopRec(...)` in
// PanoPlusAndroidPanel), so the teardown follows within a frame or two — and a
// few stalled preview frames cost nothing, because the PACK comes from the
// ImageReader, which is a separate output with its own queue. The alternative
// — rebuilding the repeating request without the preview target from a UI
// callback — would race the recorder's own request ladder, which is a worse
// trade for a debug viewfinder.
//
// ── AND WHAT IT DRAWS, WHICH IS THE OTHER HALF (2026-09-02) ─────────────
//
// The handover above got PIXELS onto the screen. It did not get them onto the
// screen the right shape or the right way up, and the operator reported both:
// "the viewfinder is elongated vertically" and, turned sideways, "the
// viewfinder is sideways".
//
// A `TextureView` with the identity transform STRETCHES its SurfaceTexture to
// fill the view rect and never rotates it — and `setTransform` was called
// nowhere in this module. On this device that is a 1440x1080 buffer scaled
// x0.750 across and x2.167 down into a 1080x2340 view: 2.889x of vertical
// anisotropy, exactly what he saw. The rotation term was simply absent, so a
// raster that is landscape by construction (Camera2 always delivers the SENSOR
// frame; turning the phone turns the scene inside the buffer, not the buffer)
// stayed landscape on a portrait screen.
//
// [configurePreviewTransform] fixes both with one matrix, and the arithmetic
// lives in `PanoPlusPreviewTransform` — android-free, so the JVM suite can
// hold all four display rotations. The view's contribution is knowing WHEN to
// recompute (four callbacks) and the producer's contribution is [Geometry],
// the two facts a view structurally cannot read.

package io.imagestitcher.rn.panoplus

import android.content.Context
import android.content.res.Configuration
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.util.Log
import android.view.Surface
import android.view.TextureView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

private const val PREVIEW_TAG = "PanoPlusPreview"

/**
 * The one live preview surface, and who currently owns it.
 *
 * A SINGLETON on purpose, and for the same reason `StitchPluginsPackage`
 * constructs ONE recorder: the recorder and the view are created by different
 * machinery (a native module vs. React's view tree) and neither can hold a
 * reference to the other. A process-wide rendezvous is the only place they can
 * meet. There is exactly one back camera and one panel, so one slot is the
 * right size — and a second view mounting while a first is claimed is handled
 * as an orphan rather than being assumed impossible.
 *
 * EVERY METHOD IS SYNCHRONIZED AND NONE THROW. `offer`/`destroyed` run on the
 * UI thread, `claim`/`release` on the recorder's camera and IO threads, and a
 * throw out of any of them would take down whichever it was.
 */
internal object PanoPlusPreview {

    private class Held(val texture: SurfaceTexture) {
        val surface: Surface = Surface(texture)
        /** The VIEW has let go; whoever holds the claim must release. */
        var viewGone = false
    }

    private val lock = Object()

    /** The surface a mounted view is currently offering, if any. */
    private var available: Held? = null

    /** What the recorder is holding. May outlive [available] — that is the
     *  panel-closed-mid-sweep case this whole file exists for. */
    private var claimed: Held? = null

    /**
     * Why there is no preview, in words the panel can render. Never null.
     *
     * ⚠ THIS IS HALF OF A CONTRACT WITH JS, AND THE OTHER HALF IS TWO LINES IN
     * THE LIVE SESSION'S `getStatus()`. Put these two into the status map under
     * EXACTLY these keys:
     *
     *     map.putBoolean("viewfinderAttached", PanoPlusPreview.attached)
     *     map.putString("viewfinderNote", PanoPlusPreview.note)
     *
     * The SDK coerces both (`coercePanoPlusStatus`) and renders the note as
     * "NO LIVE CAMERA FEED — <note>" (`panoPlusViewfinderNotice`). Without
     * those two lines this object still knows exactly why the screen is black
     * and the operator still does not — which is the state that produced "The
     * camera screen is blank!!!" and "no camera at all". A sentence he can read
     * is the difference between "stop and restart" and "keep sweeping, the
     * pack is fine".
     */
    @Volatile
    var note: String = "no preview surface has been offered — the viewfinder view is not mounted"
        private set

    /**
     * What the PRODUCER configured, published so the view can draw it
     * correctly.
     *
     * ⚠ THE VIEW CANNOT DERIVE ANY OF THIS. A `TextureView` knows only its own
     * pixel dimensions; the buffer size is chosen from
     * SCALER_STREAM_CONFIGURATION_MAP by whoever calls [claim], and
     * SENSOR_ORIENTATION is a characteristic of the camera that was opened.
     * Without both, the view has exactly two options — stretch the buffer to
     * fill itself (which is what it did until 2026-09-02, at a measured 2.889x
     * vertical anisotropy) or guess. This is the third option.
     */
    internal class Geometry(
        val bufferW: Int,
        val bufferH: Int,
        val sensorOrientationDeg: Int,
        val frontFacing: Boolean,
    ) {
        override fun toString() =
            "${bufferW}x$bufferH sensor=${sensorOrientationDeg}° " +
                (if (frontFacing) "front" else "back")
    }

    /** The last [claim]'s geometry. Survives [release] on purpose: a
     *  TextureView keeps its last frame after the producer goes away, and a
     *  transform that reverted to identity would STRETCH that frame the
     *  instant the sweep ended. */
    @Volatile
    var geometry: Geometry? = null
        private set

    /** The mounted view, told when [geometry] changes. At most one — the same
     *  single-slot rule as [available], for the same reason (one back camera,
     *  one panel). Held under [lock] but INVOKED outside it: the view's
     *  callback hops to the UI thread, and a listener that re-entered this
     *  object while the camera thread held the lock would deadlock. */
    private var geometryListener: ((Geometry?) -> Unit)? = null

    /** True while a mounted view is offering a SurfaceTexture. Read by the
     *  idle-preview path, which must refuse rather than open a camera whose
     *  frames have nowhere to go. */
    val hasSurface: Boolean
        get() = synchronized(lock) { available != null }

    /**
     * Block until a mounted view is offering a SurfaceTexture, or [timeoutMs]
     * elapses. Returns whether there is one.
     *
     * ⚠ WHY A WAIT AND NOT A `hasSurface` READ — THE BUG THIS CLOSES.
     * The panel's idle-preview effect and this view's mount are the SAME React
     * commit, and their arrival at native is not ordered: the effect is a
     * bridge call, the view is a UIManager operation. Measured on the operator's
     * A35 on 2026-09-03, the effect won by 12 ms —
     *
     *     20:47:33.809 W/RNISPanoIdle: no viewfinder surface is mounted yet
     *     20:47:33.821 I/PanoPlusPreview: viewfinder transform: view 2340x1080…
     *
     * — so `startIdlePreview` refused, released the camera, and NOTHING RETRIED
     * (the effect's deps cannot change when a SurfaceTexture arrives). The
     * operator got a permanently black viewfinder and a caption explaining a
     * situation that was not the one he was in.
     *
     * The IMU arm hid this for a day because `armPendingForIdle` holds its
     * effect back one `calibRead` round-trip, which is long enough to lose the
     * race. That is an accident of an unrelated async call, not a design — so
     * the wait is the fix for BOTH arms, not an AR-arm special case.
     *
     * ⚠ CALLERS MUST BE OFF RN'S NativeModules QUEUE AND OFF THE UI THREAD.
     * `offer()` runs on the UI thread; a UI-thread waiter would be waiting on
     * itself. The only caller is `PanoPlusAndroidRecorder.startIdlePreview`,
     * which is already on `Dispatchers.IO` and already blocks there.
     */
    fun awaitSurface(timeoutMs: Long): Boolean {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        synchronized(lock) {
            while (available == null) {
                val left = deadline - SystemClock.elapsedRealtime()
                if (left <= 0L) return false
                try {
                    // Releases the monitor while parked, so the UI thread can
                    // enter `offer()` and wake us.
                    lock.wait(left)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return false
                }
            }
            return true
        }
    }

    fun setGeometryListener(l: (Geometry?) -> Unit) {
        val g: Geometry?
        synchronized(lock) {
            geometryListener = l
            g = geometry
        }
        // Fire immediately with what is already known: a view that mounts
        // AFTER a claim (a re-render, a panel reopened over a live sweep)
        // would otherwise wait for a claim that has already happened.
        if (g != null) l(g)
    }

    /** Only clears the slot if [l] is still the registered listener — a second
     *  view mounting before the first detaches must not leave the live one
     *  unsubscribed. */
    fun clearGeometryListener(l: (Geometry?) -> Unit) {
        synchronized(lock) { if (geometryListener === l) geometryListener = null }
    }

    /** True while a capture session is targeting the preview surface.
     *  Reaches JS as `viewfinderAttached` — see [note]. */
    @Volatile
    var attached: Boolean = false
        private set

    /** A view has a SurfaceTexture and is offering it. */
    fun offer(texture: SurfaceTexture) {
        synchronized(lock) {
            val prev = available
            if (prev != null && prev.texture !== texture) {
                // A second view mounted without the first being destroyed.
                // Release the old one UNLESS the recorder is holding it, in
                // which case it becomes an orphan and `release` will get it.
                if (claimed !== prev) releaseNow(prev)
            }
            available = Held(texture)
            note = "a preview surface is available and waiting for the next start()"
            // Wake anyone parked in `awaitSurface` — the idle viewfinder that
            // raced this mount and would otherwise refuse forever.
            lock.notifyAll()
        }
    }

    /**
     * The view is going away.
     *
     * @return whether the CALLER may release the SurfaceTexture — i.e. what
     *   `onSurfaceTextureDestroyed` must return. False means this object has
     *   taken ownership because a capture session is still writing into it.
     */
    fun destroyed(texture: SurfaceTexture): Boolean {
        synchronized(lock) {
            val held = if (available?.texture === texture) available else null
            if (held == null) {
                // Not the surface we know about — an already-orphaned one, or
                // a view we never saw offer. Let the framework have it.
                return true
            }
            available = null
            note = "the viewfinder view was unmounted"
            if (claimed === held) {
                // ⚠ THE CRASH THIS FILE EXISTS TO PREVENT. Returning true here
                // releases a buffer queue the camera HAL is still filling.
                held.viewGone = true
                return false
            }
            releaseNow(held)
            return true
        }
    }

    /**
     * The recorder takes the surface for one capture session.
     *
     * @param size the buffer size to request. NOT the view's size:
     *   `SurfaceTexture` defaults its buffers to the view's dimensions, and a
     *   size the camera does not publish makes `createCaptureSession` pick one
     *   for us — or refuse. The recorder passes a size read from
     *   SCALER_STREAM_CONFIGURATION_MAP, which is the only kind Camera2
     *   guarantees.
     * @param sensorOrientationDeg SENSOR_ORIENTATION of the camera being
     *   opened, and @param frontFacing its LENS_FACING. Both travel with the
     *   size because the VIEW needs them and cannot read them: Camera2
     *   delivers buffers in the SENSOR frame, so without the mounting angle a
     *   viewfinder can only draw the raster sideways — which is exactly what
     *   the operator reported on 2026-09-02. See [Geometry].
     * @return null when nothing is mounted; the pack then records a HEADLESS
     *   sweep, which is worse than a preview and far better than no sweep.
     */
    fun claim(size: Size, sensorOrientationDeg: Int, frontFacing: Boolean): Surface? {
        var notify: ((Geometry?) -> Unit)? = null
        var published: Geometry? = null
        var out: Surface? = null
        synchronized(lock) {
            val prevClaim = claimed
            if (prevClaim != null && prevClaim !== available) {
                // An orphan from a previous session whose owner never released
                // it (a torn-down recorder, a crashed start). Reclaiming the
                // slot without freeing it would leak the buffer queue for the
                // life of the process.
                releaseNow(prevClaim)
                claimed = null
            }
            val h = available ?: run {
                note = "no preview surface was offered before start() — Camera2 fixes a " +
                    "session's outputs at createCaptureSession, so a surface arriving later " +
                    "cannot join THIS session. The sweep is recording headless; mount the " +
                    "viewfinder before pressing START to see it on the next one."
                return null
            }
            try {
                h.texture.setDefaultBufferSize(size.width, size.height)
            } catch (t: Throwable) {
                // A texture released underneath us between offer and claim.
                Log.w(PREVIEW_TAG, "setDefaultBufferSize threw", t)
                note = "the preview surface was released between being offered and being " +
                    "claimed (${t.javaClass.simpleName}) — recording headless"
                return null
            }
            if (!h.surface.isValid) {
                note = "the preview Surface is no longer valid — recording headless"
                return null
            }
            claimed = h
            note = "preview claimed at ${size.width}x${size.height}"
            published = Geometry(size.width, size.height, sensorOrientationDeg, frontFacing)
            geometry = published
            notify = geometryListener
            // Captured under the lock, returned after it: the surface handed
            // back must be the one THIS claim took, never a re-read that a
            // release racing in between could have nulled.
            out = h.surface
        }
        // OUTSIDE the lock, deliberately: this runs on the producer's camera
        // thread and the listener hops to the UI thread, so calling it under
        // the lock would let a UI-thread `destroyed()` and this thread wait on
        // each other. Nothing below reads shared state.
        try { notify?.invoke(published) } catch (t: Throwable) {
            Log.w(PREVIEW_TAG, "the geometry listener threw", t)
        }
        return out
    }

    /** The recorder is done with it. MUST be called after the capture session
     *  and the CameraDevice are closed, never before. */
    fun release() {
        synchronized(lock) {
            attached = false
            val h = claimed ?: return
            claimed = null
            // Only OUR release when the view has already let go. A view still
            // mounted keeps its own SurfaceTexture and can be claimed again.
            if (h.viewGone || h !== available) releaseNow(h)
        }
    }

    /** Called by the recorder once the session has actually configured with
     *  the preview attached — or with the reason it did not. */
    fun setAttached(on: Boolean, why: String) {
        attached = on
        note = why
    }

    private fun releaseNow(h: Held) {
        // Surface FIRST: it references the texture, and releasing the texture
        // out from under a live Surface is undefined.
        try { h.surface.release() } catch (t: Throwable) {
            Log.w(PREVIEW_TAG, "surface.release threw", t)
        }
        try { h.texture.release() } catch (t: Throwable) {
            Log.w(PREVIEW_TAG, "surfaceTexture.release threw", t)
        }
    }
}

/**
 * The viewfinder itself — a `TextureView` that does nothing but publish its
 * SurfaceTexture.
 *
 * `TextureView` AND NOT `SurfaceView`, deliberately. A SurfaceView owns a
 * window-manager surface whose `surfaceDestroyed` contract requires the
 * producer to have STOPPED DRAWING before the callback returns — which, inside
 * a React `<Modal>` that can be dismissed at any moment, would mean blocking
 * the UI thread on a camera teardown. A TextureView's SurfaceTexture is an
 * ordinary buffer queue that can outlive its view, which is what makes the
 * handover in [PanoPlusPreview] possible at all.
 *
 * It STARTS NOTHING — the same rule as the iOS view. Session ownership stays
 * with the recorder, which claims this surface inside `start()` on its own
 * camera thread. A view that opened or reconfigured a camera from the UI
 * thread would race the recorder's own ladder, and camera contention is the
 * single failure this arm has already paid for twice.
 */
internal class PanoPlusPreviewView(context: Context) : TextureView(context) {

    /** Told by [PanoPlusPreview] when a producer claims the surface — i.e.
     *  when the buffer size and the sensor mounting first become knowable.
     *  Arrives on the PRODUCER's camera thread, so it hops to the UI thread
     *  before touching the view. */
    private val geometryListener: (PanoPlusPreview.Geometry?) -> Unit = {
        configurePreviewTransform()
    }

    /** What the last applied transform was computed from. Only so the log line
     *  fires on CHANGE — this runs on every layout pass and every rotation,
     *  and a line per frame would bury the one that matters. */
    private var appliedKey: String? = null

    init {
        surfaceTextureListener = object : SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(t: SurfaceTexture, w: Int, h: Int) {
                PanoPlusPreview.offer(t)
                configurePreviewTransform()
            }

            override fun onSurfaceTextureSizeChanged(t: SurfaceTexture, w: Int, h: Int) {
                // THE BUFFER SIZE IS STILL NOT TOUCHED — that half of the
                // original comment stands and is load-bearing: the buffer size
                // is the CAMERA's, set in PanoPlusPreview.claim from a
                // published output size, and re-setting it here would resize a
                // buffer queue the capture session is bound to.
                //
                // ⚠ BUT DOING NOTHING AT ALL WAS THE BUG. This is the callback
                // a rotation arrives through, and the view→buffer mapping it
                // invalidates is exactly what `setTransform` carries. Until
                // 2026-09-02 nothing recomputed it, so the preview was
                // stretched in portrait and sideways in landscape.
                configurePreviewTransform()
            }

            override fun onSurfaceTextureDestroyed(t: SurfaceTexture): Boolean =
                PanoPlusPreview.destroyed(t)

            override fun onSurfaceTextureUpdated(t: SurfaceTexture) {}
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // ── PANO'S PORTRAIT LOCK, HELD FROM HERE (2026-09-03) ───────────
        // The stitcher's `<Camera>` pins the Activity to portrait while it is
        // mounted; pano+ unmounts that camera, so the pano+ screen rotated
        // with the accelerometer and Pano's did not. This view is mounted for
        // the whole pano+ segment on Android, and attach/detach are UI-thread
        // framework callbacks no JS path can skip — so the lock lives here.
        // See PanoPlusPortraitLock.kt for why this beats a @ReactMethod pair.
        PanoPlusPortraitLock.hold(this)
        PanoPlusPreview.setGeometryListener(geometryListener)
        // `display` is null while detached, so THIS is the first moment the
        // display rotation is readable at all. Under the lock above it reads
        // ROTATION_0 however the phone is held — which is the point: the
        // sensor mapping keeps the picture upright, exactly as Pano's does.
        configurePreviewTransform()
    }

    override fun onDetachedFromWindow() {
        PanoPlusPreview.clearGeometryListener(geometryListener)
        // Restores the prior requestedOrientation when this was the last
        // holder — the same restore RNSARSession.unlockOrientation performs.
        PanoPlusPortraitLock.release(this)
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        configurePreviewTransform()
    }

    override fun onConfigurationChanged(newConfig: Configuration?) {
        super.onConfigurationChanged(newConfig)
        // BOTH callbacks, not one. A rotation normally changes the view's size
        // and arrives at onSizeChanged — but a square-ish view (or a
        // 180-degree flip, where the size is identical) changes the DISPLAY
        // ROTATION without changing a single dimension, and only this one
        // fires. The transform is idempotent, so the overlap costs a matrix.
        //
        // ⚠ THE OVERLAP ALSO MEANS ONE TRANSIENT FRAME, and it is worth
        // naming. This callback arrives with the NEW display rotation while
        // the view still has its OLD size, so the pair is briefly mismatched
        // and the preview is drawn to a letterbox that is right-way-up but
        // the wrong shape. `onSizeChanged` corrects it: measured on
        // SM-A356U1, 14 ms apart (08:38:29.560 -> .574). One frame during a
        // rotation is cheaper than missing the 180-degree flip entirely.
        configurePreviewTransform()
    }

    /**
     * Recompute and apply the buffer→view transform. Idempotent, cheap, and
     * safe to call from anywhere.
     *
     * ⚠ THE `return`s HERE ARE "LEAVE THE IDENTITY ALONE", NOT "GIVE UP". Two
     * facts are genuinely unknown before the first claim — the buffer size and
     * the sensor mounting — and a transform built on a guessed buffer size
     * would put a WRONG framing on screen, which is worse than a stretched one
     * because it looks correct. Every path that can supply the missing fact
     * (the claim callback, attach, layout, rotation) calls back in here.
     */
    private fun configurePreviewTransform() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            // The claim callback arrives on the recorder's camera thread; view
            // state is the UI thread's.
            post { configurePreviewTransform() }
            return
        }
        val g = PanoPlusPreview.geometry ?: return
        val vw = width
        val vh = height
        if (vw <= 0 || vh <= 0) return
        // The DISPLAY's rotation, not the device's: an activity pinned to one
        // orientation reports ROTATION_0 however the phone is held, and the
        // preview must be upright relative to the SCREEN the operator is
        // looking at, not to gravity.
        val d = display ?: return
        val displayDeg = PanoPlusPreviewTransform.displayRotationDegrees(
            try { d.rotation } catch (t: Throwable) { 0 },
        )
        // THE DIAGNOSTIC OVERRIDE — `adb shell settings put system panoplus_rot
        // <0|90|180|270>`, and `settings delete system panoplus_rot` to go back
        // to the rule. Absent (the normal case) it costs one ContentResolver
        // read per LAYOUT — not per frame; this method runs on surface/size/
        // config changes only.
        //
        // It is here rather than deleted because it is what MEASURED the rule.
        // ROTATION_0 is pinned by picture; the display term is not, because
        // this phone refused every attempt to force a landscape display and
        // nobody was there to turn it. Whoever next holds the phone sideways
        // and sees a tilted viewfinder can settle it in ten seconds instead of
        // waiting for a build — and can report the value that worked.
        val forced = try {
            android.provider.Settings.System.getString(
                context.contentResolver, "panoplus_rot",
            )?.toIntOrNull()
        } catch (t: Throwable) {
            // A restricted-profile or a locked-down ContentResolver must cost
            // the viewfinder nothing: fall through to the rule.
            null
        }
        val rot = forced ?: PanoPlusPreviewTransform.previewRotationCwDeg(displayDeg)
        // ⚠ THE SENSOR TERM GOES IN HERE AND NOWHERE ELSE. It decides the
        // fit box's ASPECT (the camera pre-rotates the picture inside the
        // buffer for a SurfaceTexture consumer, so a 1440x1080 buffer carries
        // a 1080x1440 picture) and it must NOT decide the ROTATION. Passing
        // it to `previewRotationCwDeg` is the quarter turn; withholding it
        // here is the 1.778x squash. Both were shipped, one after the other.
        val v = PanoPlusPreviewTransform.matrixValues(
            vw, vh, g.bufferW, g.bufferH, rot, g.sensorOrientationDeg,
        ) ?: return
        val m = Matrix()
        m.setValues(v)
        // setTransform invalidates the view itself, so no explicit invalidate.
        setTransform(m)
        // `forced` is part of the key, not just `rot`: an override that happens
        // to equal the rule's own answer would otherwise never announce itself,
        // and "is the override on?" is the first question anyone reading this
        // log is trying to answer.
        val key = "$vw x $vh <- $g display=$displayDeg rot=$rot forced=$forced"
        if (key != appliedKey) {
            appliedKey = key
            val fit = PanoPlusPreviewTransform.fittedContentSize(
                vw, vh, g.bufferW, g.bufferH, rot, g.sensorOrientationDeg,
            )
            val pic = PanoPlusPreviewTransform.contentSize(
                g.bufferW, g.bufferH, g.sensorOrientationDeg,
            )
            Log.i(
                PREVIEW_TAG,
                "viewfinder transform: view ${vw}x$vh, buffer ${g.bufferW}x${g.bufferH}, " +
                    "display ${displayDeg}°" +
                    (if (forced != null) " [FORCED by settings panoplus_rot]" else "") +
                    " -> rotate ${rot}° CW " +
                    // Printed because the sensor term is in exactly ONE of the
                    // two answers on this line, and which one is the whole
                    // history of this file: SENSOR_ORIENTATION does NOT enter
                    // the rotation (the camera already applied it to a
                    // SurfaceTexture consumer's buffers) and DOES decide the
                    // picture's aspect (which is why the buffer and the
                    // picture below have their dimensions swapped).
                    "(sensor ${g.sensorOrientationDeg}° sets the PICTURE " +
                    "${pic?.get(0)}x${pic?.get(1)} inside that buffer, and is NOT " +
                    "in the rotation — see PanoPlusPreviewTransform), letterboxed to " +
                    "${fit?.get(0)}x${fit?.get(1)} (aspect FIT: the engine ingests the WHOLE " +
                    "frame, so a crop here would hide pixels the sweep paints)",
            )
        }
    }
}

/**
 * RN registration.
 *
 * `getName()` IS the JS component name — no "Manager" stripping, which is an
 * iOS/`RCT_EXTERN_MODULE` convention and not this one. The SDK probes for this
 * exact string through `UIManager.getViewManagerConfig` before requiring it,
 * so it must match `panoPlusAndroidPreviewView.ts`.
 *
 * ⚠ THE LOGCAT LINE THAT LOOKS LIKE A DEFECT AND IS NOT. Every launch prints
 *
 *     W ViewManagerPropertyUpdater: Could not find generated setter for class
 *       io.imagestitcher.rn.panoplus.PanoPlusPreviewViewManager
 *
 * and it was read — reasonably — as "this view never receives props, so no
 * camera attaches". It is not that. RN 0.84's own
 * `ViewManagerPropertyUpdater.findGeneratedSetter` logs that line for EVERY
 * manager whose `$$PropsSetter` was not emitted by the annotation processor,
 * then falls through to `FallbackViewManagerSetter`, which applies `@ReactProp`
 * by REFLECTION. This module declares only `compileOnly
 * "com.facebook.react:react-android"` and runs no annotation processor, so the
 * line is emitted here — and, measured on this device, also for
 * `ReactModalHostManager`, `ReactProgressBarViewManager`,
 * `CameraViewManager` (vision-camera) and `RNSARCameraViewManager`, all four of
 * which demonstrably work in this build. It is a performance note about
 * reflection, not a wiring failure.
 *
 * The reason there was no camera is in [PanoPlusPreview]: until 2026-09-02 the
 * only producer of preview frames was the SWEEP's capture session, so the
 * viewfinder was black before Start by construction. That is what
 * `PanoPlusAndroidRecorder.startIdlePreview` now fixes — not this line.
 *
 * (Silencing it would mean adding `kapt "com.facebook.react:processor"` to a
 * Kotlin-only module for a view that declares NO props of its own. That buys a
 * generated setter with nothing to set, and costs an annotation-processing
 * round in every build. Left alone, and documented here so the next
 * investigation does not spend a day on it.)
 */
internal class PanoPlusPreviewViewManager : SimpleViewManager<PanoPlusPreviewView>() {

    override fun getName(): String = COMPONENT_NAME

    override fun createViewInstance(ctx: ThemedReactContext): PanoPlusPreviewView =
        PanoPlusPreviewView(ctx)

    /**
     * ⚠ NOT A NO-OP. React drops the view; the SurfaceTexture is a native
     * buffer queue that survives it, and without this the only thing that ever
     * frees it is a `destroyed` callback the framework is not obliged to
     * deliver on every teardown path. [PanoPlusPreview.destroyed] is
     * idempotent and refuses to free a surface the recorder still holds, so
     * calling it here is safe during a live sweep.
     */
    override fun onDropViewInstance(view: PanoPlusPreviewView) {
        val t = view.surfaceTexture
        if (t != null) PanoPlusPreview.destroyed(t)
        super.onDropViewInstance(view)
    }

    companion object {
        const val COMPONENT_NAME = "RNSSweepPreviewView"
    }
}
