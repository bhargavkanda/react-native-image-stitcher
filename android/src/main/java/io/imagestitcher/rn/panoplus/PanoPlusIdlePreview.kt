// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusIdlePreview.kt — the viewfinder BEFORE the sweep.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────
//
// The operator, 2026-09-02: he cannot frame the shot. The Android panel drew
// a black rectangle and a caption — "aim by the panorama band once the sweep
// starts" — and that caption was TRUE, which is the whole problem. The only
// producer of preview frames was the sweep's own capture session
// (`PanoPlusPreviewView`'s SurfaceTexture is a second output of it), so there
// were no pixels before Start by construction. The first frame anchors the
// whole canvas; framing it blind is guessing.
//
// iOS has had the answer since v12: `RNISPanoAvfSource.startIdlePreview` runs
// the arm's own session INPUT-ONLY — no output, no delegate, no motion, no
// engine — until Start takes over. `PanoPlusLiveModule.setIdlePreview` is the
// same door on Android, and this class is what it opens.
//
// ── THE ONE HARD CONSTRAINT: THERE IS ONE BACK CAMERA ───────────────────
//
// Android permits ONE client per camera device. This session and the sweep's
// can never be up at the same time, and the failure is not theoretical: the
// second open evicts the first, which arrives at the loser as
// `onDisconnected` — mid-sweep, several seconds into a pack that then ends
// early. So the ordering is enforced in ONE place and by construction:
//
//   * `PanoPlusAndroidRecorder.start` tears this down and WAITS for
//     `onClosed` before it opens anything (it runs on Dispatchers.IO, never on
//     RN's NativeModules queue, so the wait costs nothing but latency).
//   * `startIdlePreview` REFUSES while a recorder session is installed.
//
// Both halves exist because JS cannot be relied on to sequence them: the
// panel's idle-preview effect and its Start button are two async bridge calls
// from the same tick, and their arrival order at native is not defined.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────
//
// No ImageReader, no pack directory, no IMU, no engine, no ARCore. It is a
// camera, a surface and a repeating request. Everything the recorder does
// beyond that exists to produce EVIDENCE, and an idle viewfinder produces
// none — a file written while the operator was deciding where to point would
// be a pack of a sweep that never happened.

package io.imagestitcher.rn.panoplus

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.graphics.ImageFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.util.Range
import android.util.Size
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val IDLE_TAG = "RNISPanoIdle"

/**
 * The defaults the LIVE SWEEP will use, repeated here because the idle
 * viewfinder has to reach the same camera and the same aspect ratio as the
 * sweep it is framing for.
 *
 * ⚠ THESE THREE ARE A COUPLING, AND IT IS DELIBERATE RATHER THAN CLEVER.
 * `PanoPlusLiveModule.start` sends `maxWidth = DEFAULT_MAX_WIDTH`,
 * `preferFps = 60` and `preferPhysical = true`; `PanoPlusAndroidRecorder`
 * reads them with the same defaults. `setIdlePreview` carries `{lens,
 * poseSource, cameraId}` from the SDK and nothing about size or rate, so the
 * idle path cannot be told those and must assume — and if it assumed
 * differently, the operator would frame at one field of view and record at
 * another. If those defaults move, move these. (`lens` IS carried and, since
 * 2026-09-03, honoured — see `pickCamera`.)
 */
private const val IDLE_PREFER_FPS = 60
private const val IDLE_OPEN_TIMEOUT_MS = 4000L

/**
 * The note when the rate pin was never attempted — the DEFAULT, because
 * `pinPreviewFps` defaults off (see [PanoPlusIdlePreviewSession.start]).
 *
 * It is a full sentence rather than "off" because the operator reading a
 * stuttering viewfinder needs to know that the stutter is a knob he has not
 * turned on, not a camera that refused him.
 */
private const val IDLE_FPS_NOT_ASKED =
    "the frame rate was NOT pinned (pinPreviewFps is off): this viewfinder runs at whatever " +
        "CONTROL_AE_TARGET_FPS_RANGE the HAL defaults TEMPLATE_PREVIEW to, which on most " +
        "bodies is a VARIABLE range — so it may drop its rate in a dim aisle where the sweep, " +
        "which pins the range, will not."

/**
 * The note when the pin WAS asked for and the camera was never reached — a
 * permission refusal, no mounted surface, no camera that would characterise
 * itself, a preview size that does not exist.
 *
 * ⚠ SEPARATE FROM [IDLE_FPS_NOT_ASKED] BECAUSE THE FIRST DRAFT CONFLATED THEM,
 * and a report that said "pinPreviewFps is off" to an operator who had just
 * turned it ON would send him looking for the wrong fault. Neither sentence is
 * "the rate is fine"; they are two different reasons it is unknown.
 */
private const val IDLE_FPS_NOT_REACHED =
    "the frame rate pin was requested, but the viewfinder never reached a configured camera, " +
        "so no range was requested — see the reason above for why there is no feed."

/**
 * "This idle preview is framing for an ARCore sweep" — plus what ARCore said,
 * if it could be asked.
 *
 * Non-null ONLY on the AR arm. Its presence is the arm; its `cameraId` is
 * ARCore's answer or null, and `whyNoHint` is why it is null. See
 * `PanoPlusIdlePreviewSession.pickCamera` for what each case prints on screen,
 * and `PanoPlusArCoreCameraHint` for where the answer comes from.
 */
internal class IdleArArm(
    val cameraId: String?,
    val cpuSize: Size?,
    /** `"observed"` | `"probed"` — how ARCore's answer was obtained. */
    val source: String,
    /** Why there is no answer, when `cameraId` is null. */
    val whyNoHint: String,
)

/**
 * WHAT HAPPENED TO THE FRAME RATE — the Android half of what iOS returns as
 * `previewFormatApplied`.
 *
 * ⚠ THE PANEL HAS TO BE ABLE TO SAY "THIS VIEWFINDER DOES NOT MATCH". The pin
 * can be declined for four separate reasons (the knob is off, the camera
 * advertises no ranges, the preview output cannot clock the range, the HAL
 * refuses the request) and in every one of them the viewfinder still comes up
 * — it is the ONLY viewfinder on the decoupled arm, so a rate that could not
 * be set must never be a black screen. The difference between "pinned" and
 * "up but free-running" is invisible on screen and decides whether the
 * operator can trust what he is framing, so it is REPORTED rather than
 * inferred.
 */
internal class IdleFpsReport(
    /** Did CONTROL_AE_TARGET_FPS_RANGE actually reach a live repeating
     *  request? False on every decline, including the ones where a range was
     *  chosen and then refused. */
    val applied: Boolean,
    /** The range that was requested, `[lower, upper]`, or null when none was
     *  — a range the characteristics do not advertise is never asked for. */
    val requested: String?,
    /** Why, in words the panel could render. */
    val note: String,
)

/**
 * One preview-only Camera2 session. Single-use: [start] once, [stop] once,
 * then throw it away — the HandlerThread is quit by [stop], which is what
 * makes "is this object alive?" a question with one answer.
 */
internal class PanoPlusIdlePreviewSession(private val ctx: Context) {

    private val camThread = HandlerThread("rnis-pp-idle").apply { start() }
    private val camH = Handler(camThread.looper)

    // @Volatile on both: they are WRITTEN on the idle camera thread (the
    // device/session callbacks) and READ by stop() on a Dispatchers.IO
    // coroutine, which decides from `device` whether an onClosed is owed.
    @Volatile private var device: CameraDevice? = null
    @Volatile private var session: CameraCaptureSession? = null

    /** Settled exactly once, from whichever of six callbacks arrives first —
     *  the same single-settle discipline as the recorder's own start. */
    private val settled = AtomicBoolean(false)

    /**
     * [start]'s completion, held so [stop] can settle it too.
     *
     * ⚠ WITHOUT THIS, ONE ORDERING HANGS A PROMISE FOREVER. `stop()` calls
     * `quitSafely()`, which runs the messages already DUE and DROPS the
     * delayed ones — including the open watchdog. So the sequence the panel
     * actually produces on a fast re-render — setIdlePreview(true) while
     * opening, then setIdlePreview(false) — would leave the first call's
     * Promise with no remaining path to a settle. `stop()` settles it as a
     * refusal instead, which is the truth: it was stopped before it opened.
     */
    @Volatile private var pendingDone: ((Boolean, String) -> Unit)? = null
    private val closed = CountDownLatch(1)
    private val disposed = AtomicBoolean(false)
    /** Counted down when [stop] has finished. A SECOND caller waits on it
     *  rather than being told the camera is free while the first caller is
     *  still closing it — see [stop]. */
    private val stopped = CountDownLatch(1)

    /**
     * `openCamera` HAS BEEN CALLED — which is NOT the same question as
     * "did a CameraDevice arrive", and conflating the two leaked one.
     *
     * ⚠ THE LEAK, EXACTLY. `CameraManager.openCamera` is asynchronous to the
     * CALLER but its `connectDevice` binder call is not: by the time it
     * returns, the camera service has already created the client and only the
     * `onOpened` delivery is still in flight, posted to [camH]. A [stop]
     * landing in that gap used to read `device == null`, conclude "no device
     * was ever opened", skip the [closed] wait, and `quitSafely()` the ONE
     * looper `onOpened` could have been delivered on. The service kept the
     * client for the life of the process, and every later open of that camera
     * — the sweep's own, and ARCore's — failed ERROR_CAMERA_IN_USE on a caller
     * that had done nothing wrong. This file's header names that failure; this
     * flag is what closes it.
     *
     * The window is not exotic: `stopIdlePreview("superseded-by-start")` fires
     * on every START, and the recorder's retry loop re-issues opens for up to
     * 6 s after a Discard.
     *
     * Cleared again in the three synchronous catch clauses around the open,
     * because a throw from `openCamera` means the service refused and there is
     * no client to wait for.
     */
    private val openIssued = AtomicBoolean(false)

    /** Why the feed is or is not up, in words the panel could render. */
    @Volatile var note: String = "the idle viewfinder has not been started"
        private set

    /**
     * Was the refusal a TRANSIENT one — the camera held by a client that is on
     * its way out — rather than a settled fact about this build?
     *
     * ⚠ THIS EXISTS BECAUSE THE HANDOVER RACES IN BOTH DIRECTIONS, and only
     * one of the two was closed on 2026-09-03. Handing the camera TO the sweep
     * is sequenced (`start()` waits for this session's `onClosed`). Getting it
     * BACK is not: `Discard` tears the sweep down asynchronously while the
     * panel's effect re-fires `setIdlePreview(true)` immediately, and ARCore is
     * still holding camera 0. Measured on the operator's A35 —
     *
     *     21:19:33.940 W/RNISPanoIdle: could not open camera 2:
     *                  ERROR_MAX_CAMERAS_IN_USE
     *     21:19:34.309 W/RNISPanoRec: (ARCore teardown still running)
     *
     * — and the camera was demonstrably free again a few seconds later. So the
     * refusal is not an answer, it is a "not yet", and the recorder retries on
     * it. Classifying it HERE and not by matching the message text keeps the
     * retry from turning a genuine ERROR_CAMERA_DISABLED into a spin.
     */
    @Volatile var retryable: Boolean = false
        private set

    /**
     * WHY THIS CAMERA — the clause the success line ends with.
     *
     * Held as a field rather than threaded through `configure` because the
     * sentence is decided at selection time and printed at configure time, and
     * the two are three callbacks apart. It is the difference between "this is
     * the framing the sweep will record" (true on the IMU arm, and on the AR
     * arm once ARCore has been asked) and a claim about a lens the sweep will
     * not open — which is what shipped, and what the operator framed against.
     */
    @Volatile private var framingNote: String = ""

    /** What was actually opened, for the log line and for the refusal text. */
    @Volatile var openedCameraId: String? = null
        private set
    @Volatile var previewSize: Size? = null
        private set

    /**
     * The AE target range this session will REQUEST, or null when the pin was
     * declined before the request was ever built.
     *
     * Decided in [openOnCamThread] (which is where the camera and the preview
     * size are both known) and read in [configure] three callbacks later —
     * the same reason [framingNote] is a field.
     */
    @Volatile private var plannedFpsRange: Range<Int>? = null

    /** What happened to the rate. Never null: the "off" case is an answer too.
     *  See [IdleFpsReport]. */
    @Volatile var fpsReport: IdleFpsReport = IdleFpsReport(false, null, IDLE_FPS_NOT_ASKED)
        private set

    /**
     * Open the camera and run a repeating preview request into the mounted
     * viewfinder's surface.
     *
     * @param done called EXACTLY ONCE, on the camera thread, with whether
     *   there is a live feed and why. Never throws out of here.
     */
    fun start(
        cameraId: String?,
        maxWidth: Int,
        arHint: IdleArArm?,
        lens: String?,
        /**
         * Request the SWEEP'S OWN AE target frame-rate range on this preview.
         *
         * ⚠ DEFAULTS OFF AT EVERY CALLER, AND OFF IS BYTE-IDENTICAL TO WHAT
         * SHIPPED. False builds exactly the request this class built before
         * 2026-09-07 — same keys, same order, no CONTROL_AE_TARGET_FPS_RANGE —
         * so the only thing that changes with the knob down is that
         * [fpsReport] now says the rate is not pinned. The operator turns it
         * on after he has seen both pictures: a pinned 60 means SHORTER
         * exposures, so the idle preview is DARKER in a dim aisle than the
         * free-running one is. That is the honest picture — it is what the
         * sweep is going to record — but it is his call, not this file's.
         */
        pinFps: Boolean,
        done: (Boolean, String) -> Unit,
    ) {
        pendingDone = done
        // The report's DEFAULT has to name the right absence from here on: the
        // field is read on every settle, including the refusals that happen
        // before a camera is ever characterised. See [IDLE_FPS_NOT_REACHED].
        if (pinFps) fpsReport = IdleFpsReport(false, null, IDLE_FPS_NOT_REACHED)

        // ⚠ A CAMERA THAT NEVER CALLS BACK MUST STILL SETTLE. openCamera can
        // return without ever reaching onOpened or onError — a HAL wedged by
        // another client is the ordinary case — and an unsettled Promise here
        // is a JS `await` that never returns.
        camH.postDelayed({
            if (!settled.get()) {
                settleOnCamThread(
                    false,
                    "the camera did not reach a configured preview within " +
                        "${IDLE_OPEN_TIMEOUT_MS}ms. Another client is probably holding it; " +
                        "the sweep will still work — Start opens the camera for itself.",
                    // Its own message names the transient cause, so it is one.
                    transient = true,
                )
            }
        }, IDLE_OPEN_TIMEOUT_MS)

        camH.post {
            try {
                openOnCamThread(cameraId, maxWidth, arHint, lens, pinFps, ::settleOnCamThread)
            } catch (t: Throwable) {
                settleOnCamThread(
                    false,
                    "the idle viewfinder threw while opening " +
                        "(${t.javaClass.simpleName}: ${t.message}) — the sweep is unaffected",
                )
            }
        }
    }

    /**
     * Answer [start]'s caller, exactly once, and close the camera on a
     * refusal.
     *
     * Named for the thread it must run on: it calls [closeOnCamThread], and
     * every caller inside this class is already on the idle camera thread.
     * [stop] is the one exception and it POSTS.
     */
    /**
     * Record whether the refusal is a "not yet" — but ONLY from the callback
     * that actually decides this session's fate.
     *
     * ⚠ EVERY ONE OF THESE CALLBACKS CAN ARRIVE LATE. `onDisconnected` in
     * particular is documented to land long after a settle, and the recorder
     * has by then already read [retryable] and either retried or reported. A
     * late write would re-label a decision that has been acted on — turning a
     * fatal ERROR_CAMERA_DISABLED into a spin, or (worse) clearing the flag
     * that a retry is relying on. All settles run on the single idle camera
     * thread, so this check and the CAS beside it are effectively serialized.
     */
    private fun classifyIfDeciding(transient: Boolean) {
        if (settled.get()) return
        retryable = transient
    }

    private fun settleOnCamThread(ok: Boolean, why: String, transient: Boolean = false) {
        note = why
        if (transient) classifyIfDeciding(true)
        if (!settled.compareAndSet(false, true)) return
        if (ok) Log.i(IDLE_TAG, why) else Log.w(IDLE_TAG, why)
        if (!ok) closeOnCamThread()
        val d = pendingDone
        pendingDone = null
        try { d?.invoke(ok, why) } catch (t: Throwable) {
            Log.w(IDLE_TAG, "the idle-preview completion threw", t)
        }
    }

    private fun openOnCamThread(
        cameraId: String?, maxWidth: Int, arHint: IdleArArm?, lens: String?, pinFps: Boolean,
        settle: (Boolean, String) -> Unit,
    ) {
        if (ctx.checkSelfPermission(Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return settle(
                false,
                "android.permission.CAMERA is not granted, so no viewfinder can open. " +
                    "The panel requests it from JS before a sweep.",
            )
        }
        if (!PanoPlusPreview.hasSurface) {
            // Not an error: the view mounts on the next React commit and the
            // panel calls back in. Saying so beats opening a camera whose
            // frames have nowhere to go.
            return settle(
                false,
                "no viewfinder surface is mounted yet — nothing would be drawn. " +
                    PanoPlusPreview.note,
            )
        }
        val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            ?: return settle(false, "CAMERA_SERVICE is unavailable on this device.")

        val pick = pickCamera(mgr, cameraId, arHint, lens)
        val cam = pick?.cam
            ?: return settle(
                false,
                "no camera could be characterised for an idle preview" +
                    (if (cameraId != null) " (cameraId '$cameraId' was requested)" else ""),
            )
        framingNote = pick.why
        val sensorOrientation = cam.chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
        val front = cam.facing == CameraCharacteristics.LENS_FACING_FRONT

        val recording = pickRecordingSize(cam, maxWidth, pick.matchSize)
            ?: return settle(false, "camera ${cam.id} advertises no usable YUV output size.")
        val preview = pickPreviewSize(cam.chars, recording)
            ?: return settle(
                false,
                "camera ${cam.id} publishes no SurfaceTexture output size, so no preview " +
                    "surface can be configured.",
            )
        previewSize = preview
        openedCameraId = cam.id
        // THE RATE, PLANNED HERE because this is the one place that knows both
        // the camera (its advertised ranges) and the preview size (what that
        // output can actually be clocked at). Applied three callbacks later in
        // `configure`; declined here, in words, when it cannot be.
        if (pinFps) fpsReport = planFpsRange(cam, preview)

        // ⚠ THE SIZE, THE MOUNTING AND THE FACING TOGETHER. The view draws the
        // buffer through `PanoPlusPreviewTransform`, which needs all three; a
        // claim that carried only the size would put an upright-shaped
        // letterbox around a sideways image.
        val surface = PanoPlusPreview.claim(preview, sensorOrientation, front)
            ?: return settle(false, PanoPlusPreview.note)

        val stateCb = object : CameraDevice.StateCallback() {
            override fun onOpened(d: CameraDevice) {
                device = d
                // ⚠ THE DEVICE CAN ARRIVE AFTER WE HAVE GIVEN UP ON IT, and
                // without this it was configured anyway. `stop()` posts its
                // teardown to this same thread, so the ordering
                // stop-then-onOpened is ordinary rather than rare; so is the
                // 4 s open watchdog firing and the HAL answering at 4.1 s. In
                // both cases `settled` is already true, so `configure`'s
                // `settle` would return silently — leaving a repeating request
                // running into a surface `closeOnCamThread` has already
                // released, and a CameraDevice nothing will ever close.
                // Closing it here is also what makes the [closed] latch fire,
                // which is what `stop()` is parked on.
                if (disposed.get() || settled.get()) {
                    Log.i(
                        IDLE_TAG,
                        "camera ${cam.id} opened after the idle viewfinder was already " +
                            "settled/stopped — closing it rather than configuring it",
                    )
                    try { d.close() } catch (t: Throwable) {
                        Log.w(IDLE_TAG, "closing an unwanted camera device threw", t)
                    }
                    return
                }
                try {
                    configure(d, surface, cam, settle)
                } catch (t: Throwable) {
                    settle(
                        false,
                        "configuring the idle preview session threw " +
                            "(${t.javaClass.simpleName}: ${t.message})",
                    )
                }
            }

            override fun onDisconnected(d: CameraDevice) {
                // ADOPT THE DEVICE BEFORE CLOSING. A disconnect can arrive
                // before `onOpened` ever did, and `closeOnCamThread` closes
                // the FIELD — which would still be null, so the client the
                // service handed us here would never be closed and `closed`
                // would never count down.
                device = d
                // Another client took the camera. Ordinary here — the capture
                // shell's own viewfinder reconnecting behind the panel does
                // it — and it can arrive LONG after we settled, which is why
                // the note is updated either way.
                note = "the idle viewfinder was disconnected: another camera client took " +
                    "camera ${cam.id}. Press START anyway — the sweep opens the camera for " +
                    "itself and will evict that client in turn."
                // The other client may be on its way out (a sweep tearing
                // down), so this is a "not yet" rather than an answer.
                classifyIfDeciding(true)
                PanoPlusPreview.setAttached(false, note)
                Log.w(IDLE_TAG, note)
                settle(false, note)
                closeOnCamThread()
            }

            override fun onError(d: CameraDevice, error: Int) {
                // Same reason as `onDisconnected` above: the error callback is
                // the only place this client is ever handed to us on the paths
                // that never reach `onOpened`, and an unclosed one is the leak
                // `openIssued` exists to make visible.
                device = d
                val why = "the idle viewfinder could not open camera ${cam.id}: " +
                    idleErrorName(error) +
                    ". The SWEEP is unaffected — it opens the camera itself."
                // ONLY the two in-use codes. DISABLED (policy), DEVICE and
                // SERVICE are settled facts, and retrying them would spin for
                // the whole budget and report the same thing at the end of it.
                classifyIfDeciding(
                    error == CameraDevice.StateCallback.ERROR_CAMERA_IN_USE ||
                        error == CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE,
                )
                PanoPlusPreview.setAttached(false, why)
                settle(false, why)
                closeOnCamThread()
            }

            override fun onClosed(d: CameraDevice) {
                // The ONLY signal that the HAL has actually let go. Every
                // handover to the sweep waits on this; without it the sweep's
                // own open races a device that is still closing.
                closed.countDown()
            }
        }

        // ⚠ SET BEFORE THE CALL, NOT AFTER IT. `openCamera` can create the
        // service-side client and then throw, and it can create it and return
        // while `onOpened` is still queued. Both are states in which a close is
        // owed; only a THROW means no client exists, and the catches below say
        // so by clearing the flag. See [openIssued].
        openIssued.set(true)
        try {
            mgr.openCamera(cam.id, stateCb, camH)
        } catch (e: CameraAccessException) {
            openIssued.set(false)
            settle(
                false,
                "the idle viewfinder was refused camera ${cam.id} " +
                    "(CameraAccessException reason=${e.reason}): ${e.message}. Another camera " +
                    "client in this app is holding it.",
            )
        } catch (e: SecurityException) {
            openIssued.set(false)
            settle(false, "CAMERA permission was revoked between the check and the open.")
        } catch (t: Throwable) {
            openIssued.set(false)
            settle(
                false,
                "openCamera threw ${t.javaClass.simpleName}: ${t.message}",
            )
        }
    }

    /**
     * THE VIEWFINDER'S OWN METERING, WRITTEN DOWN INSTEAD OF THROWN AWAY.
     *
     * Until 2026-09-09 both `setRepeatingRequest` calls below passed `null`
     * here, so this session never saw one CaptureResult of its own — and the
     * sweep that follows it re-learned the same scene from nothing, costing the
     * operator ~1.15 s of AE/AWB settle before a single frame reached the
     * engine (measured 1045-1139 ms across five A35 packs).
     *
     * This callback is READ-ONLY with respect to the camera: it sets nothing,
     * requests nothing and cannot refuse anything. Its entire effect is one
     * write into [PanoPlusMeteringMemo], which the recorder may then use, gated
     * on freshness and on the camera id, and reports either way.
     *
     * ONLY CONVERGED RESULTS ARE RECORDED. A memo taken mid-search looks
     * authoritative and is not, which is worse than having none — so a result
     * whose AE or AWB is still SEARCHING is ingested and dropped. A HAL that
     * publishes no state at all (null) is treated as converged, matching the
     * recorder's own settle predicate, which has always read a null state as
     * "this device does not report it" rather than "it is not ready".
     */
    private fun meteringObserver(cam: CamInfo) = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(
            s: CameraCaptureSession, req: CaptureRequest, res: TotalCaptureResult,
        ) {
            val ae = res.get(CaptureResult.CONTROL_AE_STATE)
            val awb = res.get(CaptureResult.CONTROL_AWB_STATE)
            val aeOk = ae == null ||
                ae == CaptureResult.CONTROL_AE_STATE_CONVERGED ||
                ae == CaptureResult.CONTROL_AE_STATE_LOCKED ||
                ae == CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED
            val awbOk = awb == null ||
                awb == CaptureResult.CONTROL_AWB_STATE_CONVERGED ||
                awb == CaptureResult.CONTROL_AWB_STATE_LOCKED
            if (!aeOk || !awbOk) return
            PanoPlusMeteringMemo.put(
                PanoPlusMetering(
                    cameraId = cam.id,
                    atElapsedNs = android.os.SystemClock.elapsedRealtimeNanos(),
                    exposureTimeNs = res.get(CaptureResult.SENSOR_EXPOSURE_TIME),
                    sensitivityIso = res.get(CaptureResult.SENSOR_SENSITIVITY),
                    frameDurationNs = res.get(CaptureResult.SENSOR_FRAME_DURATION),
                    focusDistanceDiopters = res.get(CaptureResult.LENS_FOCUS_DISTANCE),
                    aeState = ae,
                    awbState = awb,
                    colorGains = res.get(CaptureResult.COLOR_CORRECTION_GAINS)?.let {
                        floatArrayOf(it.red, it.greenEven, it.greenOdd, it.blue)
                    },
                ),
            )
        }
    }

    private fun configure(
        d: CameraDevice, surface: android.view.Surface, cam: CamInfo,
        settle: (Boolean, String) -> Unit,
    ) {
        val cb = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                // ⚠ THE RATE PIN MUST NEVER BE ABLE TO TAKE THE VIEWFINDER
                // DOWN. This is the ONLY viewfinder on the decoupled arm — the
                // sweep's own preview does not exist until Start — so a
                // CONTROL_AE_TARGET_FPS_RANGE the HAL will not accept has to
                // cost the operator the RATE, not the picture. The range is
                // chosen only from the ones the camera advertises and only
                // when the preview output can clock it (see [planFpsRange]),
                // so a refusal here means the device disagreed with its own
                // characteristics — rare, real, and reported rather than
                // fatal. The retry builds the pre-2026-09-07 request exactly.
                val want = plannedFpsRange
                var pinned = false
                var refusal: String? = null
                if (want != null) {
                    try {
                        s.setRepeatingRequest(buildRequest(d, surface, cam, want).build(), meteringObserver(cam), camH)
                        pinned = true
                    } catch (t: Throwable) {
                        refusal = "${t.javaClass.simpleName}: ${t.message}"
                        Log.w(IDLE_TAG, "camera ${cam.id} refused the pinned rate $want", t)
                    }
                }
                if (!pinned) {
                    try {
                        s.setRepeatingRequest(buildRequest(d, surface, cam, null).build(), meteringObserver(cam), camH)
                    } catch (t: Throwable) {
                        settle(
                            false,
                            "the idle preview session configured but its repeating request was " +
                                "refused (${t.javaClass.simpleName}: ${t.message})",
                        )
                        return
                    }
                }
                if (want != null) {
                    fpsReport = if (pinned) {
                        IdleFpsReport(
                            true, want.toString(),
                            "the viewfinder is pinned to $want — the same range the sweep will " +
                                "request, chosen by the same selector",
                        )
                    } else {
                        IdleFpsReport(
                            false, want.toString(),
                            "camera ${cam.id} REFUSED CONTROL_AE_TARGET_FPS_RANGE $want " +
                                "($refusal) even though it advertises it; the viewfinder is up " +
                                "at the HAL's own rate and does NOT match what the sweep will " +
                                "record",
                        )
                    }
                }
                // ⚠ THE CLAIM IS THE SELECTION'S, NOT THIS METHOD'S. It used
                // to end "— this is the framing the sweep will record" on
                // every path, which on the AR arm was false: ARCore opens its
                // own CameraConfig camera and this session had opened the
                // widest one. See [framingNote].
                val why = "idle viewfinder LIVE on camera ${cam.id} at " +
                    "${previewSize?.width}x${previewSize?.height}" +
                    (if (framingNote.isEmpty()) "" else " — $framingNote") +
                    // Only when the pin was ASKED FOR: with the knob down this
                    // sentence is character-identical to the one that shipped.
                    (if (want == null) "" else " · ${fpsReport.note}")
                PanoPlusPreview.setAttached(true, why)
                settle(true, why)
            }

            override fun onConfigureFailed(s: CameraCaptureSession) {
                val why = "camera ${cam.id} refused a preview-only session at " +
                    "${previewSize?.width}x${previewSize?.height}."
                PanoPlusPreview.setAttached(false, why)
                settle(false, why)
            }
        }
        @Suppress("DEPRECATION")
        d.createCaptureSession(listOf(surface), cb, camH)
    }

    /**
     * The repeating request.
     *
     * ⚠ IT MIRRORS THE SWEEP'S, AND THAT IS THE POINT OF THE WHOLE CLASS.
     * Stabilisation crops and warps the frame; a zoom ratio the device booted
     * at rescales it. Either one shown here and not applied during the sweep
     * (or the reverse) makes this viewfinder a picture of a DIFFERENT framing
     * from the one the pack will hold — which is the fault it exists to fix,
     * arriving through the back door. The values are the ones
     * `PanoPlusAndroidRecorder.baseRequest` asserts.
     *
     * The one deliberate difference is AF: this runs CONTINUOUS_PICTURE, which
     * is what the sweep runs during its AE settle before FREEZING the
     * converged distance. Framing a 0.5-1.5 m shelf through an
     * infinity-locked lens would be framing through a blur.
     *
     * ⚠ THE RATE WAS MISSING FROM THAT MIRROR UNTIL 2026-09-07, and it is the
     * one key `baseRequest` sets that this did not. Everything above about
     * stabilisation and zoom applies to CONTROL_AE_TARGET_FPS_RANGE just as
     * hard: TEMPLATE_PREVIEW's default range is the HAL's, it is VARIABLE on
     * most bodies, and a variable range lets AE lengthen the exposure in a dim
     * aisle — so the operator frames through a viewfinder that stutters and
     * dims where the pinned sweep will not. iOS had the identical fault on its
     * idle path (16:9 and a free-running rate against a 4:3 pinned 60) and
     * `RNISPanoAvfSource.startIdlePreviewOnSessionQ` is where it was fixed.
     * Here it arrives through [planFpsRange] and behind a knob that defaults
     * OFF — see [start]'s `pinFps`.
     */
    private fun buildRequest(
        d: CameraDevice, surface: android.view.Surface, cam: CamInfo,
        fps: Range<Int>?,
    ): CaptureRequest.Builder {
        val b = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
        b.addTarget(surface)
        // ⚠ NULL HERE IS THE SHIPPED REQUEST, EXACTLY. Every other key below
        // is set unconditionally, so `fps == null` builds byte-for-byte the
        // request this class built before the pin existed — which is what
        // makes the knob's OFF position a true no-op rather than a claim.
        // Set FIRST, in the same position `PanoPlusAndroidRecorder.baseRequest`
        // sets it, so the two requests read the same top to bottom.
        fps?.let { b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
        b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
        b.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO)
        b.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_OFF)
        b.set(CaptureRequest.CONTROL_AE_LOCK, false)
        b.set(CaptureRequest.CONTROL_AWB_LOCK, false)

        val c = cam.chars
        val ois = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)
        if (ois != null && ois.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF)) {
            b.set(
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF,
            )
        }
        val evs = c.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)
        if (evs != null && evs.contains(CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF)) {
            b.set(
                CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF,
            )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val zr = c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
            if (zr != null && zr.lower <= 1.0f && zr.upper >= 1.0f) {
                b.set(CaptureRequest.CONTROL_ZOOM_RATIO, 1.0f)
            }
        }
        val afModes = c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.toList()
            ?: emptyList()
        if (afModes.contains(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
            b.set(
                CaptureRequest.CONTROL_AF_MODE,
                CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE,
            )
        } else if (afModes.contains(CameraMetadata.CONTROL_AF_MODE_AUTO)) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO)
        }
        return b
    }

    /**
     * Choose the AE target frame-rate range to request, or say why none is —
     * and NEVER refuse the viewfinder over it.
     *
     * ⚠ THE SELECTOR IS NOT HERE, AND THAT IS THE WHOLE POINT.
     * `PanoPlusProbeMath.pickAeFpsRange` is the rule
     * `PanoPlusAndroidRecorder.start` runs for the sweep, lifted out on
     * 2026-09-07 so this file cannot reach a different answer — the same move
     * `largestAtLeastFps` already is for the size ladder, and for the same
     * reason: two copies of a rule are two rules the moment either moves. What
     * IS here is the three guards, each mirroring one the recorder carries:
     *
     *  1. A RANGE THE CHARACTERISTICS DO NOT ADVERTISE IS NEVER ASKED FOR.
     *     `CamInfo.fpsRanges` is `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES` and
     *     nothing else; empty means nothing requested, exactly as the sweep's
     *     `fpsRequestedNote` reports it.
     *  2. THE 10-FPS TRAP. `PanoPlusAndroidRecorder` names it on its size
     *     ladder — "a 4000x3000 output that can only be clocked at 10 fps no
     *     matter what CONTROL_AE_TARGET_FPS_RANGE says" — and defends by
     *     choosing the size by its published rate. This session cannot: its one
     *     output is a preview-sized SurfaceTexture whose size is already fixed
     *     by the recording aspect. So it asks the same question of THAT output
     *     and declines the pin when the answer is no, rather than handing the
     *     HAL a request it must reject.
     *  3. A DEVICE THAT CANNOT HONOUR THE RANGE ANYWAY is caught one level up,
     *     in [configure], which retries the request unpinned and reports it.
     *
     * The preference is [IDLE_PREFER_FPS], the same 60 the module sends the
     * sweep as `preferFps` — see this file's header on that coupling.
     */
    private fun planFpsRange(cam: CamInfo, preview: Size): IdleFpsReport {
        val ranges = cam.fpsRanges
        if (ranges.isEmpty()) {
            return IdleFpsReport(
                false, null,
                "camera ${cam.id} publishes no CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES, so no " +
                    "rate was requested — a range the characteristics do not advertise must " +
                    "never be asked for. The sweep says the same thing on the same camera.",
            )
        }
        val pick = PanoPlusProbeMath.pickAeFpsRange(
            ranges.map { it.toProbeFpsRange() }, IDLE_PREFER_FPS,
        ) ?: return IdleFpsReport(
            false, null,
            "no AE target range could be chosen for camera ${cam.id} from " +
                "${ranges.joinToString { it.toString() }} — nothing was requested.",
        )
        val outMax = previewMaxFps(cam.chars, preview)
        if (!PanoPlusProbeMath.outputCanSustainFpsRange(pick, outMax)) {
            return IdleFpsReport(
                false, null,
                "camera ${cam.id} clocks ${preview.width}x${preview.height} at " +
                    String.format(Locale.US, "%.1f", outMax ?: 0.0) + " fps, below the " +
                    "$pick the sweep will request, so the rate was NOT pinned — a request the " +
                    "output cannot honour would have been refused and taken the whole " +
                    "viewfinder with it. The picture is live; its RATE is the HAL's, not the " +
                    "sweep's.",
            )
        }
        plannedFpsRange = pick.toAndroidRange()
        val reach = if (pick.upper >= IDLE_PREFER_FPS) {
            "reaches the preferred ${IDLE_PREFER_FPS}fps"
        } else {
            "is the fastest this camera advertises; NO range reaches ${IDLE_PREFER_FPS}fps here " +
                "— 60 is a motion-blur defence, not a requirement, and the sweep proceeds on " +
                "the same range"
        }
        return IdleFpsReport(false, pick.toString(), "requesting $pick ($reach)")
    }

    /** What the HAL says this preview OUTPUT can be clocked at, or null when it
     *  published no minimum frame duration for it — which is not the same as
     *  "arbitrarily fast" and is why every rate here is nullable. */
    private fun previewMaxFps(chars: CameraCharacteristics, preview: Size): Double? {
        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
        val ns = try {
            map.getOutputMinFrameDuration(SurfaceTexture::class.java, preview)
        } catch (_: Throwable) { -1L }
        return PanoPlusProbeMath.maxFpsFromMinFrameDuration(ns)
    }

    // ════════════════════════════════════════════════════════════════════
    //  Selection — the sweep's own rules, reached independently
    // ════════════════════════════════════════════════════════════════════

    /**
     * ⚠ REPLICATES THE SWEEP'S SELECTION — AND THERE ARE TWO OF THEM.
     *
     * This is the one place that decides WHAT THE OPERATOR SEES before he
     * presses Start, so it has to reach the same answer the sweep will, and
     * the sweep answers differently on the two arms:
     *
     *   IMU arm   `PanoPlusAndroidRecorder.start` opens the widest-FOV back
     *             camera (camera 2 on the A35, 96.2°, 4:3).
     *   AR arm    ARCore's shared-camera `CameraConfig` OUTRANKS that rule
     *             entirely — the capture session is ARCore's to join and a
     *             different camera would simply fail to configure. On the A35
     *             every shared config is on camera 0, and `open()` takes the
     *             largest CPU image, so 1920x1080 at 69.7°.
     *
     * ⚠ THIS FUNCTION IGNORED THE SECOND ONE UNTIL 2026-09-03, AND THE
     * VIEWFINDER LIED BECAUSE OF IT. Propped phone, untouched between two
     * frames: idle drew 1440x1080 through the ultra-wide, the sweep recorded
     * 1920x1080 through the wide — 1.60× tighter, zero SIFT matches between
     * the two, 57.3 DN mean difference. The operator frames a bay edge to edge
     * and the pack holds a crop of it. `IdleArArm` is how the arm reaches
     * here, and `PanoPlusArCoreCameraHint` is how ARCore's answer does.
     *
     * The reason string travels WITH the pick ([Picked.why]) because the
     * screen prints it, and on the AR arm the honest sentence depends on
     * whether ARCore was asked or assumed.
     *
     * NOT replicated, and stated rather than hidden: route 2 of the sweep's
     * physical binding (`OutputConfiguration.setPhysicalCameraId`, API 28+),
     * which leaves the opened device logical and re-points only the
     * ImageReader stream. On a logical multi-camera where that route fires,
     * the sweep's recording aspect is read from the PHYSICAL sub-camera's
     * characteristics and this preview's from the logical one, so the two can
     * differ. On SM-A356U1 — the phone this arm runs on — neither back camera
     * is a logical multi-camera (`physicalBindRoute: "not a logical
     * multi-camera"` in every live pack), so that route does not fire.
     */
    private class Picked(
        val cam: CamInfo,
        /** The output size to MATCH the aspect of, when it is known from
         *  outside (ARCore's CPU image). Null = use the sweep's own ladder. */
        val matchSize: Size?,
        /** One clause naming what this preview is framing FOR, appended to the
         *  success line. Never a claim the caller cannot check. */
        val why: String,
    )

    private fun pickCamera(
        mgr: CameraManager, explicit: String?, arHint: IdleArArm?, lens: String?,
    ): Picked? {
        // The chip's request. Parsed here so both branches below can name it:
        // the AR arm to say it is ignored, the IMU arm to honour it.
        val wanted = PanoPlusLens.parse(lens)
        val ids = try { mgr.cameraIdList } catch (t: Throwable) {
            Log.w(IDLE_TAG, "getCameraIdList threw", t)
            return null
        }
        val infos = ids.mapNotNull { id ->
            try { readCamInfo(mgr, id) } catch (_: Throwable) { null }
        }
        if (infos.isEmpty()) return null
        if (explicit != null) {
            val c = infos.firstOrNull { it.id == explicit } ?: return null
            return Picked(c, null, "camera $explicit was requested explicitly")
        }

        val backs = infos.filter { it.facing == CameraCharacteristics.LENS_FACING_BACK }
        val pool = backs.ifEmpty { infos }

        // ── THE AR ARM: ARCore CHOOSES, WE FOLLOW ───────────────────────
        if (arHint != null) {
            val hintedId = arHint.cameraId
            val hinted = if (hintedId != null) infos.firstOrNull { it.id == hintedId } else null
            if (hinted != null) {
                // Two sources, two different strengths of claim, and the
                // sentence says which: a camera ARCore actually OPENED for a
                // sweep on this phone is a fact; one it REPORTS it would open
                // is its own prediction, obtained without opening anything.
                val how = if (arHint.source == "observed") {
                    "is the camera ARCore actually opened for the last AR sweep on this phone"
                } else {
                    "is the camera ARCore reports it will open for its shared session " +
                        "(asked without opening it)"
                }
                return Picked(
                    hinted, arHint.cpuSize,
                    "camera ${hinted.id}" +
                        (if (arHint.cpuSize != null) " at ${arHint.cpuSize}" else "") +
                        " $how, so this is the framing the AR sweep will record. The 0.5x " +
                        "ultra-wide is NOT reachable on this arm" +
                        (if (wanted != null)
                            " — the requested ${wanted.label} lens is ignored here, exactly " +
                                "as the sweep ignores it."
                        else "."),
                )
            }
            // ARCore could not be asked (not installed, unsupported, or the
            // probe threw). ARCore only ever uses the platform's DEFAULT REAR
            // camera, which is the first back-facing id the manager lists — so
            // that is the assumption, and it is PRINTED rather than implied.
            val fallback = pool.firstOrNull { it.yuvSizes.isNotEmpty() }
            if (fallback != null) {
                return Picked(
                    fallback, null,
                    "camera ${fallback.id} is this device's DEFAULT REAR camera and the AR arm " +
                        "is selected, so it is the best available guess at ARCore's own choice " +
                        "— ARCore could not be asked (${arHint.whyNoHint}). If the sweep opens " +
                        "a different camera the pack's arm block will say so.",
                )
            }
        }

        // ── THE IMU ARM, WITH A LENS ASKED FOR (2026-09-03) ─────────────
        // THE SAME FUNCTION THE RECORDER RUNS (`pickCameraForLens`, over the
        // same `CamInfo` enumeration in the same list order), which is the
        // only way "the framing the sweep will record" can be a fact here
        // rather than a hope. 1x = the wide-band back camera, 0.5x = the
        // ultra-wide, by vision-camera's hFOV bands — Pano's own chip's rule.
        if (wanted != null) {
            val lp = pickCameraForLens(
                infos.mapIndexed { i, c -> c.toLensCandidate(i) }, wanted,
            ) ?: return null
            val c = infos.firstOrNull { it.id == lp.id } ?: return null
            // Route 1 of the sweep's physical binding, replicated ONLY for the
            // ultra-wide: the recorder skips physical binding under a 1x
            // request (the widest sub-camera IS the 0.5x), and this must
            // frame through the same lens it will open.
            if (lp.ran == PanoPlusLens.ULTRA_WIDE && c.logicalPhysicalIds.isNotEmpty()) {
                val direct = c.logicalPhysicalIds
                    .filter { ids.contains(it) }
                    .mapNotNull { id -> try { readCamInfo(mgr, id) } catch (_: Throwable) { null } }
                    .filter { it.yuvSizes.isNotEmpty() }
                    .maxByOrNull { if (it.hFovDeg.isFinite()) it.hFovDeg else -1.0 }
                if (direct != null) {
                    return Picked(
                        direct, null,
                        "${lp.why}; the sweep opens its physical sub-camera ${direct.id} " +
                            "directly, so this does too — the framing it will record",
                    )
                }
            }
            return Picked(
                c, null,
                lp.why + " — the same rule the sweep runs, so this is the framing it " +
                    "will record",
            )
        }

        // ── THE IMU ARM, NO LENS ASKED FOR: the recorder's shipped rule ─
        val widest = pool
            .filter { it.hFovDeg.isFinite() && it.yuvSizes.isNotEmpty() }
            .maxByOrNull { it.hFovDeg }
            ?: pool.firstOrNull { it.yuvSizes.isNotEmpty() }
            ?: return null

        // Route 1 of the sweep's physical binding: a physical id that is
        // INDEPENDENTLY OPENABLE is opened directly, which changes the lens
        // and therefore the framing. Replicated because it does.
        if (widest.logicalPhysicalIds.isNotEmpty()) {
            val direct = widest.logicalPhysicalIds
                .filter { ids.contains(it) }
                .mapNotNull { id -> try { readCamInfo(mgr, id) } catch (_: Throwable) { null } }
                .filter { it.yuvSizes.isNotEmpty() }
                .maxByOrNull { if (it.hFovDeg.isFinite()) it.hFovDeg else -1.0 }
            if (direct != null) {
                return Picked(
                    direct, null,
                    "camera ${direct.id} is the widest back lens this device will open " +
                        "directly — the same rule the sweep runs, so this is the framing it " +
                        "will record",
                )
            }
        }
        return Picked(
            widest, null,
            "camera ${widest.id} is the widest-FOV back lens — the same rule the sweep runs, " +
                "so this is the framing it will record",
        )
    }

    /** The sweep's output size: largest EVEN 4:3 YUV size under the width cap
     *  that sustains 60 fps, else 30 fps, else the largest. Only its ASPECT is
     *  used here — this session configures no ImageReader — but it has to be
     *  the same answer, because the preview is matched to it.
     *
     *  @param forced ARCore's CPU image size on the AR arm. When ARCore has
     *   fixed the raster there is no ladder to run: its size IS the sweep's
     *   output, and it is 16:9 on the A35 where this function's own rule would
     *   have said 4:3. A letterbox computed from the wrong aspect is the same
     *   lie as the wrong lens, one step later. */
    private fun pickRecordingSize(cam: CamInfo, maxWidth: Int, forced: Size?): Size? {
        if (forced != null && forced.width > 0 && forced.height > 0) return forced
        val map = cam.chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?: return null
        val sizes = cam.yuvSizes
        if (sizes.isEmpty()) return null
        val capped = (if (maxWidth > 0) sizes.filter { it.width <= maxWidth } else sizes)
            .ifEmpty { sizes }
        val even = capped.filter { it.width % 2 == 0 && it.height % 2 == 0 }
        val fourThree = even.filter {
            it.height > 0 && Math.abs(it.width.toDouble() / it.height - 4.0 / 3.0) < 0.01
        }
        val shortlist = fourThree.ifEmpty { even }.ifEmpty { return null }
        val rated = shortlist.map {
            PanoPlusProbeMath.OutputSize(
                it.width, it.height,
                try {
                    map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, it)
                } catch (_: Throwable) { -1L },
            )
        }
        val pick = PanoPlusProbeMath.largestAtLeastFps(rated, IDLE_PREFER_FPS.toDouble())
            ?: (if (IDLE_PREFER_FPS > 30) {
                PanoPlusProbeMath.largestAtLeastFps(rated, 30.0)
            } else null)
        if (pick != null) return Size(pick.width, pick.height)
        return shortlist.maxByOrNull { it.width.toLong() * it.height }
    }

    /** Identical rule to `PanoPlusAndroidRecorder.claimPreviewSurface`: the
     *  largest published SurfaceTexture size at the recording aspect, capped
     *  at 1080p (every device's guaranteed preview maximum). */
    private fun pickPreviewSize(chars: CameraCharacteristics, recording: Size): Size? {
        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = try {
            map?.getOutputSizes(SurfaceTexture::class.java)?.toList() ?: emptyList()
        } catch (_: Throwable) { emptyList() }
        if (sizes.isEmpty()) return null
        val want = recording.width.toDouble() / recording.height
        val capped = sizes.filter { it.width <= 1920 && it.height <= 1080 }.ifEmpty { sizes }
        val matched = capped.filter {
            it.height > 0 && Math.abs(it.width.toDouble() / it.height - want) < 0.02
        }
        return (matched.ifEmpty { capped }).maxByOrNull { it.width.toLong() * it.height }
    }

    // ════════════════════════════════════════════════════════════════════
    //  Teardown
    // ════════════════════════════════════════════════════════════════════

    /**
     * Close everything and WAIT for the HAL to let go.
     *
     * ⚠ THE WAIT IS THE WHOLE POINT, AND IT IS WHY THIS RETURNS A STRING
     * RATHER THAN VOID. The sweep opens the same camera the instant this
     * returns; a `close()` that has been issued is not a camera that has been
     * released, and the two overlapping is `onDisconnected` on whichever loses
     * — i.e. a sweep that dies seconds in. `onClosed` is the only signal that
     * the device is actually gone, so this blocks on it, bounded, and reports
     * whether the bound was reached.
     *
     * NEVER call from RN's NativeModules queue or the UI thread: it blocks for
     * up to [timeoutMs]. Its callers are `Dispatchers.IO` coroutines.
     */
    fun stop(timeoutMs: Long = 2000L): String {
        if (!disposed.compareAndSet(false, true)) {
            // ⚠ WAIT, DO NOT RETURN "already stopped". Two callers reach here
            // in the ordering the panel actually produces: JS's
            // setIdlePreview(false) starts an async stop, and the operator's
            // START arrives while it is still closing. Returning immediately
            // would tell `start()` the camera is free when the HAL has not
            // let go, and the sweep's open would then evict — or be evicted
            // by — a session that is halfway through dying.
            if (Looper.myLooper() !== camThread.looper) {
                Log.i(IDLE_TAG, "a second caller is waiting on the idle viewfinder's close")
                try {
                    stopped.await(timeoutMs, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
            return note
        }
        if (Looper.myLooper() === camThread.looper) {
            // Cannot wait on ourselves. Close inline and say so.
            closeOnCamThread()
            stopped.countDown()
            return "closed inline (called on the idle camera thread)"
        }
        val done = CountDownLatch(1)
        camH.post {
            // A start still in flight has to be ANSWERED, not abandoned:
            // quitSafely below drops the open watchdog, which would otherwise
            // have been the last path to a settle. See [pendingDone].
            if (!settled.get()) {
                settleOnCamThread(
                    false,
                    "the idle viewfinder was stopped before it finished opening",
                )
            } else {
                closeOnCamThread()
            }
            done.countDown()
        }
        val posted = try {
            done.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt(); false
        }
        // `closed` is only counted down by CameraDevice.StateCallback.onClosed
        // — the real release.
        //
        // ⚠ THE PROBE IS `openIssued`, NOT `device`, AND THAT WAS A LEAK.
        // `device` is written by `onOpened`, which is POSTED to [camH]; a stop
        // landing between `openCamera` returning and that post running found
        // null, read it as "no camera was ever taken", skipped this wait and
        // quit the looper — killing the only delivery path for a client the
        // service had already created. The question this wait needs answered is
        // "is a close owed", and the flag set at the call site is the only
        // honest answer to it. A camera that was genuinely never asked for
        // still counts down here at once, so the fast path is unchanged.
        val released = if (!openIssued.get()) true else try {
            closed.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt(); false
        }
        camThread.quitSafely()
        // A SLICE of the caller's budget, never a fixed 500: the lifecycle
        // callers pass a few hundred milliseconds because they are on RN's
        // NativeModules queue or the UI thread, and a fixed join here would
        // add to a budget that exists to prevent an ANR.
        try { camThread.join(minOf(timeoutMs, 500L)) } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        val why = when {
            posted && released -> "the idle viewfinder released the camera"
            !posted -> "the idle viewfinder did not finish closing within ${timeoutMs}ms"
            else ->
                "the idle viewfinder issued close() but the HAL did not report onClosed " +
                    "within ${timeoutMs}ms — the next open may be refused as CAMERA_IN_USE"
        }
        if (!(posted && released)) Log.w(IDLE_TAG, why) else Log.i(IDLE_TAG, why)
        note = why
        stopped.countDown()
        return why
    }

    /** Order is fixed: repeating request, session, device, then the shared
     *  preview slot — releasing the surface while the HAL still fills it is a
     *  native crash in the producer (see PanoPlusPreviewView's header). */
    private fun closeOnCamThread() {
        try { session?.stopRepeating() } catch (t: Throwable) {
            Log.w(IDLE_TAG, "stopRepeating threw", t)
        }
        try { session?.close() } catch (t: Throwable) { Log.w(IDLE_TAG, "session.close", t) }
        session = null
        try { device?.close() } catch (t: Throwable) { Log.w(IDLE_TAG, "device.close", t) }
        // `device` is deliberately NOT nulled: stop() reads it to decide
        // whether an onClosed is owed at all, and nulling it here would make a
        // real close look like "no device was ever opened".
        try { PanoPlusPreview.release() } catch (t: Throwable) {
            Log.w(IDLE_TAG, "releasing the preview surface threw", t)
        }
        PanoPlusPreview.setAttached(false, "the idle viewfinder was stopped")
    }

    private fun idleErrorName(e: Int): String = when (e) {
        CameraDevice.StateCallback.ERROR_CAMERA_IN_USE ->
            "ERROR_CAMERA_IN_USE — another client in this app already holds it (usually the " +
                "capture shell's own viewfinder)"
        CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE ->
            "ERROR_MAX_CAMERAS_IN_USE — at the device's concurrent-camera limit"
        CameraDevice.StateCallback.ERROR_CAMERA_DISABLED -> "ERROR_CAMERA_DISABLED (policy)"
        CameraDevice.StateCallback.ERROR_CAMERA_DEVICE -> "ERROR_CAMERA_DEVICE (fatal, device)"
        CameraDevice.StateCallback.ERROR_CAMERA_SERVICE -> "ERROR_CAMERA_SERVICE (fatal, service)"
        else -> "CameraDevice error $e"
    }
}
