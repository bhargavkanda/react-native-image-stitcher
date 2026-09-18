// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusArCoreCameraHint.kt — WHICH CAMERA THE AR SWEEP WILL OPEN, asked
// BEFORE the sweep, so the idle viewfinder can frame through the same lens.
//
// ── THE INCIDENT ────────────────────────────────────────────────────────
//
// 2026-09-03, measured on the operator's A35 with the phone propped and never
// touched between two frames:
//
//   idle    `PanoPlusIdlePreviewSession.pickCamera` → camera 2, 1440x1080,
//           hFOV 96.2° (the ultra-wide — the widest back lens, which is the
//           SWEEP's rule and the right one on the IMU arm)
//   sweep   ARCore's shared-camera CameraConfig → camera 0, 1920x1080,
//           hFOV 69.7°
//
// tan(48.1°)/tan(34.85°) = 1.60× tighter. The operator frames a bay edge to
// edge on the ultra-wide and the pack records a 1.6× crop of it — and the
// idle session's own success line said "this is the framing the sweep will
// record", which on that arm was false. A viewfinder that shows a shot you
// will not get is worse than no viewfinder, because it is believed.
//
// ── WHY A HINT AND NOT A READ ───────────────────────────────────────────
//
// ARCore will only answer `getSupportedCameraConfigs()` through a live
// `Session`, and the idle path cannot afford to hold one: constructing a
// Session per idle re-arm (a lens flip, a tab bounce, a foreground) would put
// ARCore's initialisation on the path of every viewfinder open. So the answer
// is resolved ONCE per process and cached, by two routes that agree:
//
//   1. OBSERVED — the recorder tells us what ARCore actually forced, the first
//      time an AR sweep runs. This is ground truth and outranks everything.
//   2. PROBED — a single throwaway Session, constructed and configured but
//      NEVER RESUMED (so no camera is opened and nothing is evicted), read for
//      its CameraConfig list and closed. Same selection rule as
//      `ArCoreReferenceChannel.open()`: LARGEST CPU IMAGE WINS.
//
// If both are unavailable the caller gets null and must say so rather than
// guess — see `PanoPlusIdlePreviewSession.pickCamera`, which then falls back
// to ARCore's documented default rear camera and PRINTS that it assumed.
//
// ⚠ NEVER CALL [resolve] FROM RN'S NativeModules QUEUE OR THE UI THREAD.
// Session construction is hundreds of milliseconds and `Session.resume()`
// wedging that queue is a failure this port has already paid for once. The
// only caller is `PanoPlusAndroidRecorder.startIdlePreview`'s IO coroutine.

package io.imagestitcher.rn.panoplus

import android.content.Context
import android.util.Log
import android.util.Size
import java.util.concurrent.atomic.AtomicBoolean

private const val HINT_TAG = "RNISPanoArHint"

/** What ARCore will open, and how we came to believe it. */
internal data class ArCoreCameraHint(
    val cameraId: String,
    val cpuSize: Size?,
    /** `"observed"` | `"probed"`. Never a guess — a guess returns null. */
    val source: String,
)

internal object PanoPlusArCoreCameraHint {

    @Volatile private var cached: ArCoreCameraHint? = null

    /** One probe per process, success or failure. A device that refuses ARCore
     *  refuses it every time, and re-probing would put a Session construction
     *  on every idle re-arm for an answer that cannot change. */
    private val probeRan = AtomicBoolean(false)

    /**
     * Ground truth, from the recorder, the first time an AR sweep opens the
     * ARCore channel. OUTRANKS a probe: this is what ARCore actually chose for
     * a session that actually ran, and it is written even if a probe already
     * cached a different answer.
     */
    fun observed(cameraId: String?, cpuSize: Size?) {
        if (cameraId.isNullOrEmpty()) return
        val prev = cached
        if (prev != null && prev.source == "observed" &&
            prev.cameraId == cameraId && prev.cpuSize == cpuSize
        ) {
            return
        }
        cached = ArCoreCameraHint(cameraId, cpuSize, "observed")
        Log.i(
            HINT_TAG,
            "ARCore's shared camera OBSERVED as $cameraId at ${cpuSize ?: "(unknown size)"} — " +
                "the idle viewfinder will frame through that lens from now on" +
                (if (prev != null && prev.cameraId != cameraId)
                    " (it had assumed ${prev.cameraId} from a ${prev.source})"
                else ""),
        )
    }

    /**
     * The cached answer, probing once if nothing has been observed yet.
     *
     * @return null when ARCore cannot be asked at all (not linked, not
     *   installed, unsupported device, or the probe threw). The caller must
     *   then say what it assumed instead — see this file's header.
     */
    fun resolve(ctx: Context): ArCoreCameraHint? {
        cached?.let { return it }
        if (!probeRan.compareAndSet(false, true)) return cached
        val probed = probe(ctx)
        if (probed != null && cached == null) cached = probed
        return cached
    }

    /**
     * Construct → configure → read → close. NO `resume()`, so no camera is
     * opened: the idle viewfinder may already hold camera 2 while this runs and
     * must not be evicted by a question.
     *
     * `Throwable`, not `Exception`: on a host APK with no ARCore runtime the
     * constructor raises `NoClassDefFoundError`, which is an `Error` — letting
     * it out of here would kill the app for the sake of a viewfinder.
     */
    private fun probe(ctx: Context): ArCoreCameraHint? {
        val avail = try { readArCoreAvailability(ctx) } catch (t: Throwable) {
            Log.w(HINT_TAG, "ARCore availability check threw", t)
            return null
        }
        if (!avail.supported) {
            Log.i(
                HINT_TAG,
                "not asking ARCore which camera it would use: ${avail.status} — ${avail.detail}",
            )
            return null
        }
        var session: com.google.ar.core.Session? = null
        return try {
            // SHARED_CAMERA, because the CameraConfig list DIFFERS by feature
            // set: a plain session may offer configs a shared one cannot use,
            // and the sweep only ever runs shared (standalone opens no camera
            // of ours, so there is nothing to frame for).
            val s = com.google.ar.core.Session(
                ctx,
                java.util.EnumSet.of(com.google.ar.core.Session.Feature.SHARED_CAMERA),
            )
            session = s
            val filter = com.google.ar.core.CameraConfigFilter(s)
            val all = s.getSupportedCameraConfigs(filter)
            // ⚠ THE SAME RULE AS `ArCoreReferenceChannel.open()`, DELIBERATELY.
            // If these two ever disagree the viewfinder is back to framing a
            // lens the sweep does not use, which is the whole fault. Largest
            // CPU image wins there; largest CPU image wins here.
            val best = all.maxByOrNull {
                it.imageSize.width.toLong() * it.imageSize.height.toLong()
            } ?: return null
            val hint = ArCoreCameraHint(best.cameraId, best.imageSize, "probed")
            Log.i(
                HINT_TAG,
                "ARCore would use camera ${hint.cameraId} at ${hint.cpuSize} " +
                    "(${all.size} shared-camera configs offered) — probed without resuming, " +
                    "so no camera was opened",
            )
            hint
        } catch (t: Throwable) {
            Log.w(
                HINT_TAG,
                "asking ARCore which camera it would use failed " +
                    "(${t.javaClass.simpleName}: ${t.message}) — the idle viewfinder will " +
                    "assume the default rear camera and say so",
            )
            null
        } finally {
            try { session?.close() } catch (t: Throwable) {
                Log.w(HINT_TAG, "closing the probe session threw", t)
            }
        }
    }
}
