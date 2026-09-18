// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusAndroidRecorder.kt — the Camera2 PACK RECORDER for the pano+
// Android port.
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────
//
// It is a RECORDER, not an engine host.  It writes the SAME self-contained
// replayable pack the iOS arm writes (ios/RNISPanoCore.mm), so the operator's
// first Android sweep produces evidence that the ALREADY-VALIDATED offline
// twin and the platform-free engine (cpp/rnis_pano.*) can consume, with no live Android engine integration and
// no solved calibration in the loop.  Every hard question the port faces —
// does the IMU share the camera's clock, which of the 24 device→camera bases
// is the right one, does the lock reach the pixels — is a question this file
// makes ANSWERABLE OFFLINE.  It answers none of them itself and it fabricates
// nothing.
//
//   <sessionDir>/panoplus/frames/frame_%06d.jpg   pixels, indexed BY `seq`
//   <sessionDir>/panoplus/track.jsonl             one row per WRITTEN frame
//   <sessionDir>/panoplus/sensors.jsonl           the attitude series, raw
//   <sessionDir>/panoplus/device.json             the probe + what was applied
//
// `frame_%06d.jpg % seq` is the offline replay harness's join, verbatim across
// its nineteen readers, so `seq` is the key, not a row index: it is
// assigned only to frames that get WRITTEN, contiguously, and drops are
// carried forward on the next row's `droppedBefore`.  That is iOS' rule
// (RNISPanoCore.mm:1012 — `arSeq.fetch_add(1)` happens after the ring slot is
// won, never before), and it is why a pack with 217 rows has frames 000000…
// 000216 with no holes.
//
// ── THE THREE THINGS THIS FILE REFUSES TO GUESS ─────────────────────────
//
// 1. ATTITUDE.  `track.jsonl`'s `q` is the engine's `world←cam` quaternion in
//    ARKit's GL basis.  Android's TYPE_ROTATION_VECTOR is `ref←device` in an
//    ENU/device-body basis, and rnis_pano_attitude.hpp is unambiguous that the
//    device→camera change `C` is one of 24 candidates, that `Config::basisIndex`
//    defaults to −1, and that every `align()` under an unvalidated basis is a
//    fatal refusal.  Writing a rotated quaternion under a basis nobody chose
//    would be precisely the fabricated-number-presented-as-measured this
//    programme forbids.
//
//    So the guess is still refused — but the port now HAS a basis, and the
//    escape this header always named ("a twin that has selected a basis
//    rewrites `q` from `qDevice`") is taken HERE instead of offline.  `q` is
//    written only when an AUTHORITY exists for `C`, and `qSource` NAMES WHICH:
//    `rotation-vector×basis-measured` for an index measured against a
//    reference log and handed in as `measuredBasisIndex`;
//    `rotation-vector×basis-derived` for `rnis::pano::android::deriveBasis`'s
//    arithmetic on this camera's own SENSOR_ORIENTATION and lens facing;
//    `none` — IDENTITY, byte-for-byte the original behaviour — when there is
//    neither, when the clock gate below fails, or when the frame's own bracket
//    was refused.  Never a bare "imu".  The RAW device quaternion still rides
//    on every row as `qDevice` and the full series is still in sensors.jsonl,
//    so the mapping is checkable after the fact and an offline pass can still
//    re-derive `q` under a different basis without re-recording a sweep.
//    PanoPlusAttitudeMap.kt holds the arithmetic and the honesty rule.
//
// 2. THE CLOCK.  Camera timestamps are `SENSOR_TIMESTAMP`; IMU timestamps are
//    `SensorEvent.timestamp`.  Whether they share an epoch is THE open
//    question, and `SENSOR_INFO_TIMESTAMP_SOURCE` only half-answers it.  So
//    both domains are recorded explicitly, both are sampled against
//    `SystemClock.elapsedRealtimeNanos()` AT DELIVERY (min/median/max of the
//    offset), and device.json states the rule by which `clocksComparable` was
//    derived.  `align()` already models the residual as `tauS`; this recorder
//    hands it the data to fit it.
//
//    The `q` mapping in item 1 needs the EPOCH half of that question answered
//    BEFORE it can bracket a frame between two IMU samples, so it reads
//    `SENSOR_INFO_TIMESTAMP_SOURCE` from the opened camera at runtime and maps
//    only on REALTIME (`panoAttitudeClockGate`).  SM-A356U1 measured REALTIME
//    on 2026-09-01 and that measurement is NOT what this build relies on — the
//    characteristic is re-read every start, and anything else falls back to
//    identity with the reason named.  The LATENCY half stays open: τ is 0 and
//    the pack says `tauUncorrected` rather than pretending it was fitted.
//
// 3. INTRINSICS.  Used per-frame when `LENS_INTRINSIC_CALIBRATION` is
//    populated, derived from focal length + physical size otherwise, and
//    labelled `intrinsicsSource` either way.  Both paths are mapped through
//    the frame's OWN `SCALER_CROP_REGION` — a device that ships a default
//    crop would otherwise silently scale every fx in the pack.
//
// ── AND THE ONE OPTIMISATION IT REFUSES ─────────────────────────────────
//
// The well-travelled "are the UV planes already NV21?" probe (advance V by a
// byte, chop U's limit, `compareTo`) returns TRUE on any frame whose chroma is
// locally constant — a grey wall, a white shelf riser — even on an NV12 device
// where U and V are the other way round.  The cost of that false positive is a
// whole pack with U and V swapped: plausible geometry, wrong colour, and
// nothing in the pack to say so.  The strided gather below is layout-agnostic
// by construction (it addresses U and V through their own planes and never
// assumes adjacency), costs a few ms at the sizes involved, and cannot be
// wrong.  The observed layout is REPORTED instead of being exploited.

package io.imagestitcher.rn.panoplus

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.graphics.YuvImage
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.util.Range
import android.util.Size
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.BufferedOutputStream
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.nio.ByteBuffer
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private const val TAG = "RNISPanoRec"

// ════════════════════════════════════════════════════════════════════════
//  Minimal JSON emission
// ════════════════════════════════════════════════════════════════════════
//
// Hand-rolled rather than org.json for two reasons that both bit this
// programme before: `Double.toString` emits `NaN` / `Infinity`, which are not
// JSON and which the python harness's `json.loads` rejects on the row that
// matters most (the pathological one); and org.json is an android.jar stub
// under JVM unit tests, so anything that touched it could not be tested off
// device.  Every number that leaves this file goes through [jnum].

/**
 * The pack's join key: `frames/frame_%06d.jpg` indexed by the track row's
 * `seq`, which is what all nineteen readers in the offline replay harness
 * open. Locale.US is not decoration — `String.format` with a default locale
 * emits Eastern Arabic digits on an ar-EG device, and the harness would then
 * find no frame for any row in the pack.
 */
internal fun frameFileName(seq: Long): String =
    String.format(Locale.US, "frame_%06d.jpg", seq)

/** JSON number, or `0` for anything non-finite. A pack row must always parse. */
internal fun jnum(v: Double): String = if (v.isFinite()) v.toString() else "0"

internal fun jstr(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (c in s) {
        when {
            c == '"' -> sb.append("\\\"")
            c == '\\' -> sb.append("\\\\")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\t' -> sb.append("\\t")
            c.code < 0x20 -> sb.append(String.format(Locale.US, "\\u%04x", c.code))
            else -> sb.append(c)
        }
    }
    return sb.append('"').toString()
}

/**
 * Serialise a plain counter map (String/Boolean/Double values, as
 * [PanoPlusArArmState.counters] returns) into a JSON object, preserving the
 * map's own key order so packs still diff cleanly.
 *
 * Deliberately NOT generic: it accepts the three value kinds that map carries
 * and stringifies anything else rather than throwing, because a pack that fails
 * to write is worse than a pack with one over-quoted field.
 */
internal fun joFromCounters(m: Map<String, Any>): String =
    m.entries.joinToString(",", "{", "}") { (k, v) ->
        val value = when (v) {
            is Boolean -> if (v) "true" else "false"
            is Double -> jnum(v)
            is Number -> jnum(v.toDouble())
            else -> jstr(v.toString())
        }
        "${jstr(k)}:$value"
    }

/** Ordered JSON object builder. Key order is authoring order — packs diff. */
internal class Jo {
    private val sb = StringBuilder(256).append('{')
    private var first = true
    private fun key(k: String): Jo {
        if (!first) sb.append(',')
        first = false
        sb.append(jstr(k)).append(':')
        return this
    }
    fun s(k: String, v: String?): Jo =
        if (v == null) key(k).also { sb.append("null") } else key(k).also { sb.append(jstr(v)) }
    fun n(k: String, v: Double): Jo = key(k).also { sb.append(jnum(v)) }
    fun n(k: String, v: Float?): Jo =
        if (v == null) key(k).also { sb.append("null") } else n(k, v.toDouble())
    fun i(k: String, v: Long): Jo = key(k).also { sb.append(v) }
    fun i(k: String, v: Int?): Jo =
        if (v == null) key(k).also { sb.append("null") } else key(k).also { sb.append(v) }
    fun b(k: String, v: Boolean): Jo = key(k).also { sb.append(if (v) "true" else "false") }
    /** Already-serialised JSON (nested object, array, or `null`). */
    fun raw(k: String, v: String): Jo = key(k).also { sb.append(v) }
    fun rect(k: String, r: Rect?): Jo =
        if (r == null) key(k).also { sb.append("null") }
        else raw(k, "[${r.left},${r.top},${r.width()},${r.height()}]")
    fun end(): String = sb.append('}').toString()
}

internal fun jarr(vararg v: Double): String = v.joinToString(",", "[", "]") { jnum(it) }
internal fun jarrStr(v: List<String>): String = v.joinToString(",", "[", "]") { jstr(it) }
private fun jarrRaw(v: List<String>): String = v.joinToString(",", "[", "]")

// ════════════════════════════════════════════════════════════════════════
//  YUV_420_888 → NV21
// ════════════════════════════════════════════════════════════════════════

/** What the converter FOUND in the planes. Reported verbatim in device.json. */
internal data class YuvLayout(
    val yRowStride: Int, val yPixelStride: Int,
    val uRowStride: Int, val uPixelStride: Int,
    val vRowStride: Int, val vPixelStride: Int,
    val yBulkRowCopy: Boolean,
) {
    /** Layout FAMILY, from the strides alone. The semi-planar INTERLEAVE ORDER
     *  (NV12 vs NV21) is deliberately not inferred — see the file header: the
     *  only cheap probe for it returns a false positive on flat chroma, and the
     *  converter does not need to know because it addresses U and V through
     *  their own plane buffers. */
    fun family(): String = when {
        uPixelStride == 1 && vPixelStride == 1 -> "planar (I420-family)"
        uPixelStride == 2 && vPixelStride == 2 -> "semi-planar (interleave order not probed)"
        else -> "mixed/strided (uPixelStride=$uPixelStride vPixelStride=$vPixelStride)"
    }
    fun toJson(): String = Jo()
        .i("yRowStride", yRowStride).i("yPixelStride", yPixelStride)
        .i("uRowStride", uRowStride).i("uPixelStride", uPixelStride)
        .i("vRowStride", vRowStride).i("vPixelStride", vPixelStride)
        .b("yBulkRowCopy", yBulkRowCopy)
        .s("family", family())
        .s(
            "note",
            "YUV_420_888 is not NV12: rowStride and pixelStride are read per " +
                "plane and both semi-planar (pixelStride 2) and planar " +
                "(pixelStride 1) UV are gathered explicitly. No adjacency " +
                "between the U and V buffers is assumed anywhere.",
        )
        .end()
}

/**
 * Pure YUV_420_888 → packed NV21, honouring every stride.
 *
 * Extracted from `android.media.Image` on purpose: it takes ByteBuffers and
 * ints, so it is the one piece of this recorder that CAN be tested on a JVM
 * without a device — and it is also the piece whose failure mode (swapped
 * chroma, half-shifted rows) produces a pack that looks fine in the ledger and
 * is wrong in every pixel.
 *
 * NV21 destination layout: `h` rows of `w` luma bytes, then `h/2` rows of `w`
 * bytes each holding `w/2` **V,U** pairs — which is what `YuvImage` consumes
 * when its `strides` argument is null.
 *
 * Buffer positions are captured on entry and RESTORED on exit; nothing here
 * mutates the caller's view of the planes.
 */
internal object Yuv420ToNv21 {

    /** @return the layout observed, so the caller can report it. */
    fun convert(
        y: ByteBuffer, yRowStride: Int, yPixelStride: Int,
        u: ByteBuffer, uRowStride: Int, uPixelStride: Int,
        v: ByteBuffer, vRowStride: Int, vPixelStride: Int,
        width: Int, height: Int,
        out: ByteArray,
        scratch: ByteArray,
    ): YuvLayout {
        require(width > 0 && height > 0) { "size must be positive ($width x $height)" }
        require(width % 2 == 0 && height % 2 == 0) {
            "YUV_420_888 chroma is half-resolution: $width x $height is not even"
        }
        val ySize = width * height
        require(out.size >= ySize + ySize / 2) {
            "out is ${out.size}, need ${ySize + ySize / 2}"
        }

        val yBase = y.position()
        val uBase = u.position()
        val vBase = v.position()
        val bulk = yPixelStride == 1
        try {
            // ── Luma ────────────────────────────────────────────────────
            if (bulk) {
                for (r in 0 until height) {
                    y.position(yBase + r * yRowStride)
                    y.get(out, r * width, width)
                }
            } else {
                for (r in 0 until height) {
                    val span = (width - 1) * yPixelStride + 1
                    y.position(yBase + r * yRowStride)
                    y.get(scratch, 0, span)
                    var o = r * width
                    var i = 0
                    for (c in 0 until width) {
                        out[o++] = scratch[i]
                        i += yPixelStride
                    }
                }
            }

            // ── Chroma, gathered V-then-U per pair ──────────────────────
            // One bulk read per plane per row into `scratch`, then de-stride
            // in the array: a per-byte ByteBuffer.get() on a direct buffer is
            // a JNI-ish virtual call and would dominate the frame budget.
            val cw = width / 2
            val ch = height / 2
            val uSpan = (cw - 1) * uPixelStride + 1
            val vSpan = (cw - 1) * vPixelStride + 1
            require(scratch.size >= maxOf(uSpan, vSpan)) {
                "scratch is ${scratch.size}, need ${maxOf(uSpan, vSpan)}"
            }
            val half = scratch.size / 2
            require(half >= maxOf(uSpan, vSpan)) {
                "scratch must hold one U row AND one V row (${scratch.size} < " +
                    "${2 * maxOf(uSpan, vSpan)})"
            }
            for (r in 0 until ch) {
                v.position(vBase + r * vRowStride)
                v.get(scratch, 0, vSpan)
                u.position(uBase + r * uRowStride)
                u.get(scratch, half, uSpan)
                var o = ySize + r * width
                var vi = 0
                var ui = half
                for (c in 0 until cw) {
                    out[o++] = scratch[vi]
                    out[o++] = scratch[ui]
                    vi += vPixelStride
                    ui += uPixelStride
                }
            }
        } finally {
            y.position(yBase)
            u.position(uBase)
            v.position(vBase)
        }
        return YuvLayout(
            yRowStride, yPixelStride, uRowStride, uPixelStride,
            vRowStride, vPixelStride, bulk,
        )
    }

    /**
     * Scratch bytes needed for [convert] at this size and these strides.
     * Sized for TWO chroma rows (U and V are read before either is consumed)
     * and for one luma row on the non-unit-pixelStride path.
     */
    fun scratchBytes(width: Int, yPixelStride: Int, uPixelStride: Int, vPixelStride: Int): Int {
        val cw = width / 2
        val chroma = 2 * (((cw - 1).coerceAtLeast(0)) * maxOf(uPixelStride, vPixelStride) + 1)
        val luma = 2 * ((width - 1) * yPixelStride + 1)
        return maxOf(chroma, luma, 2 * width) + 64
    }
}

// ════════════════════════════════════════════════════════════════════════
//  Per-frame metadata joined from the CaptureResult
// ════════════════════════════════════════════════════════════════════════

private class FrameMeta(
    val sensorTsNs: Long,
    val exposureNs: Long?,
    val iso: Int?,
    val cropRegion: Rect?,
    val intrinsics: FloatArray?,   // LENS_INTRINSIC_CALIBRATION, pre-correction px
    val focusDistance: Float?,
    val afMode: Int?,
    val aeState: Int?,
    val awbState: Int?,
    val aeLock: Boolean?,
    val awbLock: Boolean?,
    val lensState: Int?,
    /** elapsedRealtimeNanos sampled AT onCaptureCompleted — half of the
     *  clock-domain evidence (the other half is the IMU's). */
    val deliveredElapsedNs: Long,
)

/** One attitude sample, recorded in the SENSOR's own timebase. */
private class ImuSample(
    val tsNs: Long, val x: Double, val y: Double, val z: Double, val w: Double,
    val accuracy: Int, val type: String,
    /** `SystemClock.elapsedRealtimeNanos()` sampled INSIDE the callback that
     *  delivered this sample. The only timestamp on it that can be compared
     *  with anything else in this recorder without assuming a shared epoch —
     *  see [derivePanoTracking]. */
    val deliveredElapsedNs: Long,
)

/** Running min / mean / max / p50 over a bounded reservoir. */
private class Stat(private val cap: Int = 512) {
    private val buf = DoubleArray(cap)
    private var n = 0L
    private var sum = 0.0
    private var lo = Double.MAX_VALUE
    private var hi = -Double.MAX_VALUE
    @Synchronized fun add(v: Double) {
        if (!v.isFinite()) return
        if (n < cap) buf[n.toInt()] = v else buf[(n % cap).toInt()] = v
        n++; sum += v
        if (v < lo) lo = v
        if (v > hi) hi = v
    }
    @Synchronized fun toJson(): String {
        if (n == 0L) return Jo().i("n", 0L).end()
        val k = minOf(n, cap.toLong()).toInt()
        val c = buf.copyOf(k); c.sort()
        return Jo().i("n", n).n("min", lo).n("p50", c[k / 2]).n("mean", sum / n).n("max", hi).end()
    }
    @Synchronized fun count(): Long = n

    /**
     * The p50, for the ONE consumer that needs a number rather than a JSON
     * block: the live status the panel polls at 2 Hz while the sweep runs.
     * `toJson()` stays the authority for the pack — this is the same sample
     * set read a cheaper way.
     */
    @Synchronized fun p50(): Double {
        if (n == 0L) return 0.0
        val k = minOf(n, cap.toLong()).toInt()
        val c = buf.copyOf(k); c.sort()
        return c[k / 2]
    }
}

// ════════════════════════════════════════════════════════════════════════
//  The module
// ════════════════════════════════════════════════════════════════════════

class PanoPlusAndroidRecorder(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    override fun getName(): String = "RNSSweepRecorder"

    private val session = AtomicReference<Rec?>(null)

    /**
     * The PRE-SWEEP viewfinder (PanoPlusIdlePreview.kt), owned here for one
     * reason: there is one back camera, and this class is what opens it.
     *
     * ⚠ THE TWO CAN NEVER BE UP TOGETHER, AND JS CANNOT BE THE ONE TO ENSURE
     * IT. The panel's idle-preview effect and its START button are two async
     * bridge calls issued in the same React tick, and their arrival order at
     * native is undefined — so a Start that trusted JS to have stopped the
     * idle session first would, on the losing ordering, open the camera
     * against a client that still holds it. Android answers that by EVICTING
     * one of them (`onDisconnected` on the loser), which reads as a sweep that
     * dies several seconds in. [start] therefore tears this down itself and
     * WAITS, and [startIdlePreview] refuses while a sweep is installed.
     */
    private val idlePreview = AtomicReference<PanoPlusIdlePreviewSession?>(null)

    /**
     * Which idle-preview REQUEST is currently wanted. Bumped by every start
     * AND by every stop, so a start that is mid-flight can tell that the
     * answer it is about to install is no longer the one being asked for.
     *
     * ⚠ THIS IS WHAT MAKES THE `awaitSurface` WAIT SAFE. `startIdlePreview`
     * now parks on `Dispatchers.IO` until the viewfinder mounts, and during
     * that park `stopIdlePreviewAsync` finds `idlePreview == null` and returns
     * having done nothing — there is no session to stop YET. Without a token,
     * the parked start would then wake up and open a camera that the panel had
     * already navigated away from: a leaked CameraDevice, held until the
     * process dies, that makes every later open fail with CAMERA_IN_USE on an
     * innocent caller. The generation is checked after every blocking step.
     */
    private val idleWant = PanoPlusIdleWant()

    init {
        // ── THE OWNER CAN DIE WITHOUT CALLING stop() ────────────────────────
        // Until this existed, the ONLY route out of a recording session was an
        // explicit stop() from JS. Everything else — the operator closing the
        // panel, maxFrames being reached, a dev reload, the Activity being
        // destroyed — left a CameraDevice open and four HandlerThreads spinning,
        // with the module's own pointer to them thrown away. The next open then
        // fails ERROR_CAMERA_IN_USE against a session nothing can reach, and on
        // a field build the only cure is a force-stop.
        reactContext.addLifecycleEventListener(this)
    }

    /**
     * RN is tearing this module down — a reload, or the bridge going away.
     *
     * RUNS ON THE NATIVE-MODULES THREAD, NOT THE UI THREAD. That is what makes
     * the synchronous teardown below legal, and it is the fact to check before
     * copying this body anywhere else (see [onHostDestroy], which does run on
     * the UI thread and therefore does NOT get the same budget).
     *
     * SYNCHRONOUS, unlike every other teardown path in this file, and that is
     * the point: on a reload RN constructs a REPLACEMENT instance immediately,
     * and a replacement whose `session` is null while the old session still
     * holds the camera turns this leak into an unexplainable
     * ERROR_CAMERA_IN_USE on the operator's next tap.
     */
    override fun invalidate() {
        // The idle viewfinder first and on a SHORT leash: this is RN's one
        // NativeModules queue thread, and an idle camera left open across a
        // reload is the same unexplainable ERROR_CAMERA_IN_USE on the next tap
        // that the sweep teardown below exists to prevent.
        stopIdlePreview("module-invalidated", IDLE_STOP_BUDGET_UI_MS)
        teardownOwnerless("module-invalidated", JOIN_BUDGET_MS, reprobeCameras = true)
        try { reactContext.removeLifecycleEventListener(this) } catch (_: Throwable) {}
        super.invalidate()
    }

    /**
     * The Activity is going away.
     *
     * ⚠ THIS ONE IS THE UI THREAD. `ReactContext.onHostDestroy()` is
     * `@ThreadConfined(UI)`, so everything below it blocks the main looper —
     * and this used to run [invalidate]'s body verbatim under the comment "same
     * reasoning as invalidate", which was true of the RACE and false of the
     * THREAD. Worst case was `CameraDevice.close()` plus four independently
     * 3 s-bounded joins plus a `device.json` fsync plus a full camera
     * re-enumeration: additive, ~12 s, an ANR at the 5 s mark.
     *
     * Still synchronous — an Activity destroy can be followed immediately by a
     * new one opening the camera, so handing the teardown to another thread
     * would restore the very race [invalidate] pays to avoid — but under ONE
     * 1 s budget for all four joins, and with the unbounded camera
     * re-enumeration skipped. A thread that overruns is named in the pack's
     * advisories instead of taking the app down.
     */
    override fun onHostDestroy() {
        // ⚠ UI THREAD — see the KDoc. The idle stop is bounded so its wait plus
        // the sweep teardown's own 1 s budget stay under the 5 s ANR mark.
        stopIdlePreview("host-destroyed", IDLE_STOP_BUDGET_UI_MS)
        teardownOwnerless("host-destroyed", JOIN_BUDGET_UI_MS, reprobeCameras = false)
    }

    /**
     * Is the Activity off screen right now? Written by the two lifecycle
     * callbacks below, READ by [startIdlePreview] as a refusal.
     *
     * ⚠ WHY THE IDLE PATH NEEDS ITS OWN COPY OF A FACT THE PANEL ALSO HAS.
     * The panel stops asking for the viewfinder when the app goes to the
     * background, but it cannot stop a request that is ALREADY in flight from
     * landing after the pause — and two of its own mechanisms produce exactly
     * that: the 1 Hz idle heartbeat's `getStatus` round-trip can resolve after
     * HOME and re-arm, and React's own effect ordering puts the ask before the
     * AppState event on a tick where both fire. Either one used to open the
     * camera for an app that was no longer visible, which is the background
     * camera hold this pause handler exists to end. The recorder learns about
     * the pause SYNCHRONOUSLY on the UI thread; JS learns about it a bridge hop
     * later. So the refusal lives here, where the fact is first.
     *
     * Starts FALSE, not true: `ReactContext.addLifecycleEventListener` replays
     * `onHostResume` to a listener added while the host is already resumed, so
     * a true default would only ever be corrected, never relied on — and a
     * false one costs nothing while the Activity is genuinely down, because
     * [onHostPause] is the first callback it then receives.
     */
    @Volatile private var hostPaused = false

    // For a SWEEP this is deliberately inert. onHostPause fires for a
    // permission dialog, a system share sheet and the screen blanking, none of
    // which should cost a sweep in progress — and Android disconnects the
    // camera itself if the process is genuinely backgrounded, which arrives as
    // onDisconnected and is already handled. The idle viewfinder is the panel's
    // to re-arm (its AppState listener fires on this same resume), so nothing
    // is opened from here either; only the refusal flag is lowered.
    override fun onHostResume() {
        hostPaused = false
    }

    /**
     * ⚠ THE SWEEP AND THE IDLE VIEWFINDER DO NOT GET THE SAME POLICY, and
     * giving them one held the back camera with the app off screen.
     *
     * The comment above is about a SWEEP: a permission dialog or a share sheet
     * must not cost the operator a pack he is four minutes into, and its
     * "Android disconnects the camera itself" clause is the safety net for the
     * case where it really is backgrounded. Measured on the A35, 2026-09-03,
     * with the idle preview live and HOME pressed: `dumpsys media.camera` still
     * reported `Camera ID: 2` still held by the host app at +3 s, and the camera
     * came back only at ~+6 s. So the net exists but it is SLOW, and for three
     * seconds an invisible app holds the camera and lights the system's
     * in-use indicator.
     *
     * The idle viewfinder has nothing to protect — no pack, no evidence, no
     * engine — and no claim on the camera at all when nothing is on screen. It
     * also loses nothing by being torn down: the panel re-arms it on
     * foreground (`PanoPlusCaptureSurface`'s AppState listener) and its idle
     * heartbeat catches the case where that misses.
     *
     * ⚠ ASYNC, NOT `stopIdlePreview`. This is `@ThreadConfined(UI)`; the
     * blocking stop waits on the HAL's `onClosed` and would put that wait on
     * the main looper.
     *
     * ⚠ AND NO `idlePreview == null` EARLY-OUT — THAT NULL IS THE DANGEROUS
     * STATE, NOT THE SAFE ONE. It is exactly what a request looks like while it
     * is PARKED: in `awaitSurface`, or asleep between two attempts of the
     * retry loop, which empties the slot for 250 ms at a time across a 6 s
     * budget after every Discard. An early-out here let that request wake up
     * after HOME and open the camera for an app that was no longer on screen.
     * `stopIdlePreviewAsync` bumps the want token BEFORE its own null check, so
     * calling it unconditionally IS the cancel, and when nothing is parked or
     * installed it costs one atomic increment. The flag above closes the
     * remaining route — a fresh ask that arrives from JS after this ran.
     */
    override fun onHostPause() {
        if (session.get() != null) return  // a SWEEP — see above, it survives.
        hostPaused = true
        stopIdlePreviewAsync("host-paused")
    }

    /**
     * ⚠ NEVER FINALIZES THE LIVE ENGINE. Both callers are on threads that must
     * not block for seconds — [invalidate] is RN's ONE NativeModules queue
     * thread (a block there wedges every native module in the app) and
     * [onHostDestroy] is the UI thread with 1 s before an ANR — and the canvas
     * render plus JPEG encode is seconds of work. The live session is
     * ABANDONED instead: the engine is released, every file already on disk is
     * kept, and the pack still replays.
     */
    private fun teardownOwnerless(
        reason: String,
        joinBudgetMs: Long,
        reprobeCameras: Boolean,
    ) {
        // ⚠ DISARM HERE TOO, NOT ONLY IN stop(). The stitcher's ARCore view
        // outlives this recorder and the plugin registry is a process-wide
        // object that nothing else unregisters, so an arm left standing keeps
        // being called on every GL tick for the life of the process. It used to
        // be nearly free — a no-op JNI call that returned 0 once the session was
        // gone — but the ingest offload now COPIES the frame before it can
        // discover there is nothing to feed, so a leaked arm costs a 3.11 MB
        // allocation per render tick on the render thread. Idempotent.
        PanoPlusArFramePlugin.shared.disarm()
        val rec = session.getAndSet(null) ?: return
        try {
            rec.shutdown(reason, joinBudgetMs, reprobeCameras, finalizeLive = false)
        } catch (t: Throwable) {
            Log.w(TAG, "teardown on $reason threw", t)
        }
    }

    // ── ReadableMap accessors that DEGRADE ──────────────────────────────
    // The bridge getters throw ClassCastException on a type mismatch (the
    // house note on every robust bridge entry in this package); a malformed option
    // must fall back to its default, never red-screen a capture.
    private fun optStr(m: ReadableMap?, k: String, d: String?): String? =
        try { if (m != null && m.hasKey(k)) m.getString(k) ?: d else d } catch (_: Throwable) { d }
    private fun optInt(m: ReadableMap?, k: String, d: Int): Int =
        try { if (m != null && m.hasKey(k)) m.getInt(k) else d } catch (_: Throwable) { d }
    private fun optDbl(m: ReadableMap?, k: String, d: Double): Double =
        try { if (m != null && m.hasKey(k)) m.getDouble(k) else d } catch (_: Throwable) { d }
    private fun optBool(m: ReadableMap?, k: String, d: Boolean): Boolean =
        try { if (m != null && m.hasKey(k)) m.getBoolean(k) else d } catch (_: Throwable) { d }
    private fun hasKeySafe(m: ReadableMap?, k: String): Boolean =
        try { m != null && m.hasKey(k) && !m.isNull(k) } catch (_: Throwable) { false }

    /**
     * A `{ knobName: value }` object, stringified.
     *
     * Values are STRINGS because the C++ side parses them itself against the
     * one knob table that also reads `meta.json` and drives replay overrides —
     * a typed marshalling here would be a second table to keep in step, and the
     * knob set changes. Types that are not knob values (null / map / array)
     * become an empty string ON PURPOSE, so the native side counts them in
     * `overridesMalformed`; dropping them here would hide an A/B arm that never
     * ran. Same rule, and the same words, as `PanoPlusAndroidModule.replayPack`.
     */
    private fun readKnobMap(options: ReadableMap?, key: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        val m = try {
            if (hasKeySafe(options, key)) options?.getMap(key) else null
        } catch (_: Throwable) {
            null
        } ?: return out
        val it = m.keySetIterator()
        while (it.hasNextKey()) {
            val k = it.nextKey()
            val v: String = try {
                when (m.getType(k)) {
                    com.facebook.react.bridge.ReadableType.Number ->
                        formatKnobNumber(m.getDouble(k))
                    com.facebook.react.bridge.ReadableType.Boolean ->
                        if (m.getBoolean(k)) "true" else "false"
                    com.facebook.react.bridge.ReadableType.String -> m.getString(k) ?: ""
                    else -> ""
                }
            } catch (_: Throwable) {
                ""
            }
            out[k] = v
        }
        return out
    }

    /**
     * `%s` on a Double gives `1.0` for an integral knob, and a knob the C++
     * table parses as an int would then be a malformed value.
     */
    private fun formatKnobNumber(v: Double): String =
        if (v.isFinite() && v == Math.floor(v) && Math.abs(v) < 1e15) {
            v.toLong().toString()
        } else {
            v.toString()
        }

    // ── start ───────────────────────────────────────────────────────────

    @ReactMethod
    fun start(options: ReadableMap?, promise: Promise) {
        // Permission is checked BEFORE anything is opened. openCamera throws
        // SecurityException without it, and a thrown SecurityException out of
        // a HandlerThread is an app kill, not a rejected promise.
        if (reactContext.checkSelfPermission(Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            promise.reject(
                "permission-denied",
                "android.permission.CAMERA is not granted to this process. The " +
                    "recorder never requests it (a native module has no Activity " +
                    "to host the dialog) and never opens a camera without it — " +
                    "request it from JS, then call start() again. The HOST app " +
                    "must also declare <uses-permission android:name=" +
                    "\"android.permission.CAMERA\"/>; this library adds no manifest " +
                    "entry of its own.",
            )
            return
        }

        val cfg = Config(
            cameraId = optStr(options, "cameraId", null),
            // The chip's lens — `'ultraWide'` | `'wide'` — or null for every
            // caller that predates it, which keeps the shipped widest-FOV rule.
            // See PanoPlusLens.kt.
            lens = optStr(options, "lens", null),
            sessionDir = optStr(options, "sessionDir", null),
            // 1920 BY DEFAULT, not 0. A 0 cap means "take the largest 4:3 YUV
            // size", which on a modern sensor is 4000x3000 — 6.5x the pixels of
            // the iOS reference regime (1920x1440) through a SOFTWARE JPEG
            // encoder, on a recorder that drops every frame arriving while the
            // encoder is busy. The result is a few-fps pack that looks like a
            // slow camera in every counter and is actually a chosen size.
            // Pass maxWidth:0 to lift the cap deliberately.
            maxWidth = optInt(options, "maxWidth", DEFAULT_MAX_WIDTH),
            jpegQuality = optInt(options, "jpegQuality", 88).coerceIn(1, 100),
            readerMaxImages = optInt(options, "readerMaxImages", 3).coerceIn(2, 8),
            settleCeilingMs = optDbl(options, "settleCeilingMs", 3000.0).coerceIn(0.0, 20000.0),
            lockCamera = optBool(options, "lockCamera", true),
            attitudeMagFree = optBool(options, "attitudeMagFree", false),
            arPluginArm = optBool(options, "arPluginArm", false),
            meteringMemoMaxAgeMs =
                optDbl(options, "meteringMemoMaxAgeMs", 4000.0).coerceIn(0.0, 60000.0),
            settleStableResults = optInt(options, "settleStableResults", 3).coerceIn(0, 60),
            openTimeoutMs = optDbl(options, "openTimeoutMs", 6000.0).coerceIn(500.0, 30000.0),
            metaJoinWaitMs = optDbl(options, "metaJoinWaitMs", 60.0).coerceIn(0.0, 500.0),
            focusDistanceM =
                if (hasKeySafe(options, "focusDistanceM")) optDbl(options, "focusDistanceM", 0.0)
                else Double.NaN,
            preferFps = optInt(options, "preferFps", 60).coerceIn(1, 480),
            template = optStr(options, "template", "record") ?: "record",
            trackingOverride =
                if (hasKeySafe(options, "trackingOverride"))
                    optInt(options, "trackingOverride", -1) else -1,
            preferPhysical = optBool(options, "preferPhysical", true),
            maxFrames = optInt(options, "maxFrames", 4000).coerceAtLeast(1),
            attitudeMaxAgeMs = optDbl(options, "attitudeMaxAgeMs", DEFAULT_ATTITUDE_MAX_AGE_MS)
                .coerceIn(1.0, 5000.0),
            // NOT coerced into range here. An out-of-range index must reach
            // panoResolveBasisAuthority so it can be DISCARDED BY NAME in the
            // pack: clamping it would silently apply a basis the operator did
            // not ask for, under the label of one they did.
            measuredBasisIndex = optInt(options, "measuredBasisIndex", -1),
            attitudeMaxBracketMs =
                optDbl(options, "attitudeMaxBracketMs", DEFAULT_ATTITUDE_MAX_BRACKET_MS),
            arAttitudeMaxBracketMs =
                optDbl(options, "arAttitudeMaxBracketMs", DEFAULT_AR_ATTITUDE_MAX_BRACKET_MS)
                    .coerceIn(1.0, 1000.0),
            // OFF BY DEFAULT and INERT when off: the reference channel starts a
            // second camera client (shared) or takes the camera outright
            // (standalone), and neither belongs in a sweep nobody asked it for.
            // An unrecognised value is OFF, never AUTO — see parseArCoreRefMode.
            arcoreReference = parseArCoreRefMode(optStr(options, "arcoreReference", "off")),
            // AUTO by default: in shared mode ARCore owns the focus, and FIXED
            // is infinity focus, which is wrong for a 0.5-1.5 m shelf. The
            // tradeoff is real (auto-focus moves the intrinsics per frame and
            // ARCore warns it can cost tracking quality), so the choice is the
            // operator's and the applied value is recorded.
            arcoreFocusMode = optStr(options, "arcoreFocusMode", "auto") ?: "auto",
            // ── The live arm ────────────────────────────────────────────
            // OFF by default and INERT when off: every existing caller of this
            // module (the debug panel, the basis runs, the ARCore reference
            // sessions) must record exactly the pack it recorded before.
            live = optBool(options, "live", false),
            // "none" while live, "all" otherwise — a live sweep pays ~15-20 ms
            // per frame for a JPEG on the same thread as the engine, and a
            // RECORDING sweep exists to produce those files. Either default is
            // overridable; both are stated in the pack's meta.
            packFrames = optStr(
                options, "packFrames",
                if (optBool(options, "live", false)) "none" else "all",
            ) ?: "none",
            liveConfigOverrides = readKnobMap(options, "configOverrides"),
            livePreviewIntervalMs = optDbl(options, "previewIntervalMs", 120.0),
            livePreviewMaxDutyPct = optDbl(options, "previewMaxDutyPct", 8.0),
            livePreviewQuality = optInt(options, "previewQuality", 82),
            livePreviewMaxAlong = optInt(options, "previewMaxAlong", 1200),
            livePreviewMaxCross = optInt(options, "previewMaxCross", 480),
            livePreviewWindowCrossMult = optDbl(options, "previewWindowCrossMult", 1.44),
            livePreviewCropPad = optBool(options, "previewCropPad", true),
            livePreviewLeadOut = optBool(options, "previewLeadOut", true),
            liveCanvasQuality = optInt(options, "canvasQuality", 92),
            liveCanvasCropPad = optBool(options, "canvasCropPad", true),
            liveWriteLedger = optBool(options, "writeLedger", true),
            livePoseSource = optStr(options, "poseSource", "imu") ?: "imu",
            // One 30 fps frame period. Coerced rather than trusted: a caller
            // that sent 5000 here would make every frame wait five seconds for
            // a pose that is never coming, on the thread that also drives the
            // engine, and the sweep would look hung rather than slow.
            arPoseWaitMs = optDbl(options, "arPoseWaitMs", 33.0).coerceIn(0.0, 200.0),
            // Coerced, not trusted: a 1 here would degrade a healthy arm on
            // the first frame that raced its pose, which is the one thing
            // this must never do.
            arImuFallbackAfterFrames =
                optInt(options, "arImuFallbackAfterFrames", DEFAULT_AR_IMU_FALLBACK_FRAMES)
                    .coerceIn(0, 600),
            // Coerced well above ARCore's measured ~2 s bootstrap window at
            // the bottom end: a caller that sent 200 here would degrade
            // healthy arms, which is the one thing this must never do.
            arImuFallbackGraceMs =
                optDbl(options, "arImuFallbackGraceMs", DEFAULT_AR_IMU_FALLBACK_GRACE_MS)
                    .coerceIn(2_500.0, 60_000.0),
        )

        // A second start() tears the first one down FIRST — a leaked
        // CameraDevice makes every later open fail with CAMERA_IN_USE and the
        // failure surfaces on the innocent call.
        val previous = session.getAndSet(null)
        CoroutineScope(Dispatchers.IO).launch {
            // ⚠ FIRST, AND IT BLOCKS ON PURPOSE. The idle viewfinder holds the
            // same back camera this sweep is about to open; `close()` having
            // been ISSUED is not the HAL having LET GO, so this waits for
            // `onClosed` before anything else runs. Legal here and nowhere
            // else in this method: `Dispatchers.IO`, never RN's NativeModules
            // queue. `start()` itself has already returned to JS.
            stopIdlePreview("superseded-by-start")
            if (previous != null) {
                // Disarm the outgoing sweep's AR plugin before its session
                // goes: the registry outlives the recorder, so the previous
                // arm would otherwise keep being called on every GL tick. See
                // the note in teardownOwnerless.
                PanoPlusArFramePlugin.shared.disarm()
                try { previous.shutdown("superseded-by-start") } catch (t: Throwable) {
                    Log.w(TAG, "teardown of the previous session threw", t)
                }
            }
            val rec = Rec(reactContext, cfg)
            // However this session ends — stop(), a camera error, a
            // disconnect, or a start() that never reached recording — the
            // module drops its pointer. Without this a failed start leaves a
            // torn-down Rec installed, and the next start() reports
            // `recorder-busy` for a session that no longer exists.
            rec.onTeardown = { session.compareAndSet(rec, null) }
            if (!session.compareAndSet(null, rec)) {
                // Another start() raced in and installed its own session.
                PanoPlusArFramePlugin.shared.disarm()
                try { rec.shutdown("lost-start-race") } catch (_: Throwable) {}
                promise.reject(
                    "recorder-busy",
                    "another start() is already installing a session; stop() first.",
                )
                return@launch
            }
            try {
                rec.start(promise)
            } catch (t: Throwable) {
                session.compareAndSet(rec, null)
                // start() may already have armed the plugin (startArPluginArm
                // arms before it can throw), so this path must disarm too.
                PanoPlusArFramePlugin.shared.disarm()
                try { rec.shutdown("start-threw") } catch (_: Throwable) {}
                rec.settleReject(promise, "start-failed", "start threw: ${describe(t)}")
            }
        }
    }

    // ── stop ────────────────────────────────────────────────────────────

    @ReactMethod
    fun stop(promise: Promise) {
        // ⚠ DISARM FIRST, AND UNCONDITIONALLY. The AR-plugin arm's frames come
        // from the STITCHER's session, which outlives our recorder — its camera
        // view stays mounted after the sweep ends. A plugin left armed would
        // keep feeding a finished engine, so this runs before anything else and
        // regardless of whether a session was even running. Idempotent, like
        // stop() itself.
        PanoPlusArFramePlugin.shared.disarm()
        val rec = session.getAndSet(null)
        if (rec == null) {
            // NOT an error: stop() is idempotent by design (an unmount, a
            // crash-recovery path and an operator tap all call it).
            promise.resolve(
                WritableNativeMap().apply {
                    putBoolean("wasRecording", false)
                    putString("note", "no recorder session was running; nothing to stop.")
                },
            )
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val summary = rec.shutdown("stop")
                promise.resolve(summary)
            } catch (t: Throwable) {
                promise.reject("stop-failed", "stop threw: ${describe(t)}", t)
            }
        }
    }

    // ── status ──────────────────────────────────────────────────────────

    /** Live counters, safe to poll from JS while a sweep runs. */
    @ReactMethod
    fun status(promise: Promise) {
        val rec = session.get()
        if (rec == null) {
            promise.resolve(WritableNativeMap().apply { putBoolean("running", false) })
            return
        }
        promise.resolve(rec.statusMap())
    }

    // ── Read-only accessors for the LIVE module ─────────────────────────
    //
    // `PanoPlusLiveModule` (`RNSSweepSession`) delegates to THIS instance —
    // one camera, one sweep — and needs two facts that are not worth a second
    // Promise round trip: is a session installed, and what are its counters.
    // Both are plain reads of the same AtomicReference `status()` uses.

    /** True while a recorder session is installed (opening, settling, or
     *  recording). The live module's `stop()` uses it to answer
     *  `panoplus-not-running` without opening anything. */
    fun isRecording(): Boolean = session.get() != null

    /** [statusMap]'s contents, or null when no session is installed. Named
     *  differently from `status()` because that one settles a Promise and this
     *  one is a value — a method that could do either is a method someone will
     *  call from the wrong side. */
    fun statusSnapshot(): WritableNativeMap? = session.get()?.statusMap()

    // ── The IDLE viewfinder, for the LIVE module ────────────────────────
    //
    // iOS's `setIdlePreview` (RNISPanoAvfSource.startIdlePreview), reached
    // through `PanoPlusLiveModule.setIdlePreview`. It lives HERE and not in
    // that module because the camera does: one back camera, one owner, and the
    // ordering against `start()` is enforced by construction rather than by
    // hoping JS sequences two async bridge calls correctly.

    /**
     * Run a preview-only session so the operator can FRAME before he starts.
     *
     * ⚠ NEVER BLOCKS THE CALLER. Everything below — the wait for a previous
     * idle session's `onClosed`, the camera open — happens on
     * `Dispatchers.IO`, because the only caller is an `@ReactMethod` on RN's
     * ONE NativeModules queue thread, where a block wedges every native module
     * in the app.
     *
     * @param arArm the sweep this is framing for will run on ARCore poses. NOT
     *   cosmetic: ARCore's shared-camera CameraConfig OUTRANKS this recorder's
     *   widest-FOV rule, so on that arm the idle session has to follow ARCore's
     *   camera and raster or the operator frames through a lens the pack will
     *   not contain. Measured on the A35: 96.2° ultra-wide at idle vs 69.7°
     *   wide in the pack, 1.60× tighter, from the identical phone pose.
     * @param done invoked EXACTLY ONCE with whether there is a live feed and
     *   why. Both answers are useful to the panel: `false` re-shows the
     *   explainer instead of leaving a black rectangle that looks broken.
     */
    // `internal`, not public, for the ONE reason [IdleFpsReport] is internal:
    // it is a detail of the idle viewfinder, and its only caller
    // (`PanoPlusLiveModule.setIdlePreview`) lives in this Gradle module. A
    // public signature carrying an internal type does not compile, and widening
    // the report to public would publish a type nothing outside can use.
    internal fun startIdlePreview(
        cameraId: String?,
        maxWidth: Int,
        arArm: Boolean,
        lens: String?,
        /** Ask the viewfinder to request the SWEEP'S OWN AE target frame-rate
         *  range. Defaults off at the JS edge (`pinPreviewFps`), and off is
         *  byte-identical to the request that shipped — see
         *  [PanoPlusIdlePreviewSession.start]. */
        pinFps: Boolean,
        done: (Boolean, String, IdleFpsReport?) -> Unit,
    ) {
        val once = AtomicBoolean(false)
        // WHAT HAPPENED TO THE RATE, carried out beside the answer rather than
        // encoded into `why`: the panel has to be able to say "the preview does
        // not match" as a FLAG, the way iOS returns `previewFormatApplied`, and
        // parsing that back out of an English sentence is not a contract.
        // Null on every path that never reached a camera at all.
        val fpsReport = AtomicReference<IdleFpsReport?>(null)
        fun settle(ok: Boolean, why: String) {
            if (!once.compareAndSet(false, true)) return
            try { done(ok, why, fpsReport.get()) } catch (t: Throwable) {
                Log.w(TAG, "the idle-preview completion threw", t)
            }
        }
        // Claim a generation BEFORE any suspension point, so a stop issued
        // from here on is visible to every check below. See [idleWant].
        val gen = idleWant.begin()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                if (session.get() != null) {
                    // The sweep owns the camera and its own preview is already
                    // a session output. Opening a second client here would
                    // EVICT the sweep — the failure this refusal exists for.
                    settle(
                        false,
                        "a pano+ sweep is running; its own capture session is already feeding " +
                            "the viewfinder. There is one back camera and a second client " +
                            "would evict the sweep.",
                    )
                    return@launch
                }
                if (reactContext.checkSelfPermission(Manifest.permission.CAMERA)
                    != PackageManager.PERMISSION_GRANTED
                ) {
                    settle(
                        false,
                        "android.permission.CAMERA is not granted to this process, so no " +
                            "viewfinder can open. Request it from JS, then reopen the panel.",
                    )
                    return@launch
                }
                // A previous idle session (a lens flip, a re-render) must be
                // GONE — not merely told to stop — before the next open.
                // `cancelWant = false`: this stop serves THIS request, so it
                // must not cancel it. See [stopIdlePreview].
                stopIdlePreview("restarting-idle-preview", cancelWant = false)
                if (session.get() != null) {
                    // A start() raced in during the wait above.
                    settle(false, "a pano+ sweep started while the viewfinder was opening.")
                    return@launch
                }
                // ⚠ WAIT FOR THE VIEWFINDER, DO NOT REFUSE BECAUSE IT IS LATE.
                // The panel's effect and the view's mount are one React commit
                // and arrive here unordered; the operator's A35 measured the
                // effect winning by 12 ms, which used to be a permanent black
                // screen because nothing retried. See `PanoPlusPreview.awaitSurface`.
                // A refusal is still the answer when the view genuinely is not
                // there (a build without the ViewManager, a panel that never
                // mounted it) — it just has to be a MEASURED absence now.
                val surfaceWaitBegan = SystemClock.elapsedRealtime()
                val hadSurface = PanoPlusPreview.hasSurface
                if (!PanoPlusPreview.awaitSurface(IDLE_SURFACE_WAIT_MS)) {
                    settle(
                        false,
                        "no viewfinder surface was offered within ${IDLE_SURFACE_WAIT_MS}ms — " +
                            "nothing would be drawn. ${PanoPlusPreview.note}",
                    )
                    return@launch
                }
                if (!hadSurface) {
                    // THE RACE, MEASURED, EVERY TIME IT HAPPENS. Without this
                    // line the wait is invisible when it works, and the next
                    // person to read this code cannot tell whether it is
                    // load-bearing or dead weight. A non-zero number here is
                    // the viewfinder mounting AFTER the request arrived — which
                    // is the whole bug (12 ms on the A35, 2026-09-03).
                    Log.i(
                        TAG,
                        "the idle viewfinder request beat the view's surface by " +
                            "${SystemClock.elapsedRealtime() - surfaceWaitBegan}ms; waited " +
                            "for it instead of refusing.",
                    )
                }
                // The park above is the longest one here, and the panel can be
                // closed inside it. Everything after this point OPENS A CAMERA,
                // so a superseded request must stop at this line.
                if (!idleWant.isCurrent(gen)) {
                    settle(
                        false,
                        "the idle viewfinder was no longer wanted by the time the preview " +
                            "surface arrived (the panel closed, or a sweep started).",
                    )
                    return@launch
                }
                if (session.get() != null) {
                    settle(false, "a pano+ sweep started while the viewfinder was opening.")
                    return@launch
                }
                if (hostPaused) {
                    // A request that arrived after HOME — the panel's heartbeat
                    // resolving late, or its effect beating the AppState event.
                    // The panel re-asks on foreground; opening here would hold
                    // the camera for an app nobody can see. See [hostPaused].
                    settle(false, IDLE_REFUSED_HOST_PAUSED)
                    return@launch
                }
                val cap = if (maxWidth > 0) maxWidth else DEFAULT_MAX_WIDTH
                // ── WHICH LENS THE AR SWEEP WILL ACTUALLY OPEN ──────────
                // Resolved HERE, on IO, and never on RN's NativeModules queue:
                // the first call may construct a throwaway ARCore Session to
                // ask (it is never resumed, so no camera is opened and this
                // preview's own is not evicted), and one process pays that once.
                val arHint: IdleArArm? = if (!arArm) null else {
                    val h = try {
                        PanoPlusArCoreCameraHint.resolve(reactContext)
                    } catch (t: Throwable) {
                        Log.w(TAG, "resolving ARCore's camera for the idle viewfinder threw", t)
                        null
                    }
                    IdleArArm(
                        cameraId = h?.cameraId,
                        cpuSize = h?.cpuSize,
                        source = h?.source ?: "",
                        whyNoHint = if (h != null) "" else
                            "ARCore did not answer which camera it would use — see logcat " +
                                "tag RNISPanoArHint",
                    )
                }
                // ── THE OPEN, RETRIED WHILE THE CAMERA IS STILL CHANGING HANDS ──
                //
                // ⚠ THE HANDOVER RACES IN BOTH DIRECTIONS AND ONLY ONE END IS
                // SEQUENCED. Giving the camera TO the sweep is ordered by
                // construction (`start()` waits for this session's `onClosed`).
                // Getting it BACK is not: Discard tears the sweep down
                // asynchronously while the panel's effect re-fires
                // `setIdlePreview(true)` at once, and ARCore still holds camera
                // 0. Measured on the operator's A35, 2026-09-03:
                //
                //     21:19:33.940 could not open camera 2:
                //                  ERROR_MAX_CAMERAS_IN_USE
                //     21:19:34.309 (ARCore teardown still running)
                //
                // …and a re-entry seconds later opened first try. So a single
                // attempt answers a question the camera had not finished
                // answering, and the operator is left looking at the sweep's
                // frozen last frame with a caption under it. Only
                // `PanoPlusIdlePreviewSession.retryable` failures spin, so a
                // real ERROR_CAMERA_DISABLED still reports at once.
                val deadline = SystemClock.elapsedRealtime() + IDLE_OPEN_RETRY_BUDGET_MS
                val began = SystemClock.elapsedRealtime()
                var attempt = 0
                while (true) {
                    attempt++
                    // Both cancels are re-read EVERY attempt, not once: the
                    // whole point of a retry loop is that time passes inside it.
                    if (!idleWant.isCurrent(gen)) {
                        settle(false, "the idle viewfinder was cancelled while it was opening.")
                        return@launch
                    }
                    if (session.get() != null) {
                        settle(false, "a pano+ sweep started while the viewfinder was opening.")
                        return@launch
                    }
                    if (hostPaused) {
                        // Re-read per attempt for the same reason the two above
                        // are: this loop can run for 6 s, and HOME inside it is
                        // the ordinary case after a Discard.
                        settle(false, IDLE_REFUSED_HOST_PAUSED)
                        return@launch
                    }
                    val s = PanoPlusIdlePreviewSession(reactContext)
                    if (!idlePreview.compareAndSet(null, s)) {
                        // Another startIdlePreview raced in and installed its
                        // own. `s` already has a running HandlerThread —
                        // constructing it started one — so losing the race means
                        // disposing of it, not just dropping the reference.
                        try { s.stop(IDLE_STOP_BUDGET_MS) } catch (_: Throwable) {}
                        settle(false, "another idle viewfinder is already installing.")
                        return@launch
                    }
                    // RE-CHECK AFTER INSTALLING, not only before. A stop landing
                    // in the gap above found `idlePreview == null` and cancelled
                    // only the token; from here on it would find the session —
                    // but it has already been and gone. This is what makes
                    // "installed" and "wanted" agree.
                    if (!idleWant.isCurrent(gen)) {
                        idlePreview.compareAndSet(s, null)
                        try { s.stop(IDLE_STOP_BUDGET_MS) } catch (_: Throwable) {}
                        settle(
                            false,
                            "the idle viewfinder was cancelled as it was being installed.",
                        )
                        return@launch
                    }
                    // `s.start` settles on the idle camera thread; this IO
                    // coroutine waits for that answer so the loop can decide.
                    // Bounded well past the session's own 4 s open watchdog, so
                    // a session that somehow never settles cannot park this
                    // coroutine for ever.
                    val done = CountDownLatch(1)
                    val ok = AtomicBoolean(false)
                    val why = AtomicReference("the idle viewfinder never answered.")
                    s.start(cameraId, cap, arHint, lens, pinFps) { o, w ->
                        ok.set(o)
                        why.set(w)
                        // Read from the session, not from the callback: it is
                        // set before the settle on every path, and a retry
                        // overwrites it with the NEXT attempt's answer, which
                        // is the one the caller is being told about.
                        fpsReport.set(s.fpsReport)
                        done.countDown()
                    }
                    if (!done.await(IDLE_OPEN_ANSWER_BUDGET_MS, TimeUnit.MILLISECONDS)) {
                        Log.w(TAG, "the idle viewfinder did not answer within " +
                            "${IDLE_OPEN_ANSWER_BUDGET_MS}ms; abandoning it")
                    }
                    if (ok.get()) {
                        if (attempt > 1) {
                            Log.i(
                                TAG,
                                "the idle viewfinder opened on attempt $attempt after " +
                                    "${SystemClock.elapsedRealtime() - began}ms — the " +
                                    "previous camera owner was still letting go.",
                            )
                        }
                        settle(true, why.get())
                        return@launch
                    }
                    // Failed. Dispose before deciding: a retry must not leave
                    // the slot occupied, and `stop()` is safe from this thread
                    // (it POSTS to the session's own camera thread) — which the
                    // session's completion callback was NOT, which is why the
                    // old code hopped to a fresh coroutine to do this.
                    try { s.stop(IDLE_STOP_BUDGET_MS) } catch (t: Throwable) {
                        Log.w(TAG, "disposing a failed idle preview threw", t)
                    }
                    idlePreview.compareAndSet(s, null)
                    val mayRetry = s.retryable
                        && SystemClock.elapsedRealtime() + IDLE_OPEN_RETRY_INTERVAL_MS < deadline
                        && idleWant.isCurrent(gen)
                    if (!mayRetry) {
                        settle(false, why.get())
                        return@launch
                    }
                    Thread.sleep(IDLE_OPEN_RETRY_INTERVAL_MS)
                }
            } catch (t: Throwable) {
                settle(
                    false,
                    "the idle viewfinder failed to start (${t.javaClass.simpleName}: " +
                        "${t.message}). The sweep is unaffected — START opens the camera itself.",
                )
            }
        }
    }

    /**
     * Close the idle viewfinder and WAIT for the camera to be released.
     *
     * Returns what happened, in words, so a caller that cares (the panel's
     * `setIdlePreview(false)`) can say it. Idempotent, and safe to call when
     * nothing is running.
     *
     * ⚠ BLOCKS for up to [timeoutMs]. Callers on RN's NativeModules queue or
     * the UI thread pass [IDLE_STOP_BUDGET_UI_MS]; `start()`'s IO coroutine
     * pays the full budget because correctness there is worth the latency.
     */
    /** [stopIdlePreview] off the caller's thread, for callers that are on one
     *  they may not block — RN's NativeModules queue, in practice. Fire and
     *  forget: the only caller that needs the ANSWER is `start()`, which waits
     *  for it deliberately. */
    fun stopIdlePreviewAsync(reason: String) {
        // ⚠ BUMP BEFORE THE EARLY-OUT, NEVER AFTER IT. A start parked in
        // `awaitSurface` has installed NO session yet, so the null check below
        // is true and this method would otherwise return having cancelled
        // nothing — and the parked start would open a camera for a panel that
        // is already gone. The token is the only thing that reaches it.
        idleWant.cancel()
        if (idlePreview.get() == null) return
        CoroutineScope(Dispatchers.IO).launch {
            // ⚠ `cancelWant = false` — THE CANCEL ALREADY HAPPENED, ABOVE, AND
            // CANCELLING AGAIN FROM HERE KILLS THE NEXT REQUEST.
            //
            // The line above runs on the caller's thread, which for every real
            // caller is RN's NativeModules queue, so it is ORDERED against the
            // `setIdlePreview(true)` that follows it. This coroutine is ordered
            // against nothing. A lens flip is one React commit — effect cleanup
            // then effect body — so native sees `setIdlePreview(false)` then
            // `setIdlePreview(true, {lens: NEW})`, and the second call takes its
            // token with `idleWant.begin()` SYNCHRONOUSLY on that same queue.
            // If this coroutine then reached `stopIdlePreview`'s default
            // `cancelWant = true`, its `idleWant.cancel()` would bump the
            // generation PAST the token the new request is already holding.
            //
            // And it wins the race almost every time: this cancel is the first
            // statement of `stopIdlePreview`, while the new request must first
            // get through its OWN blocking `stopIdlePreview(cancelWant = false)`
            // — which waits on the previous camera's `onClosed` — before it
            // reaches its first `isCurrent(gen)` gate. The new request then
            // settles false with "no longer wanted … (the panel closed, or a
            // sweep started)", which is a FALSE sentence: nothing closed and no
            // sweep started. JS clears `idleFeedLive` and prints that reason
            // over a TextureView still holding the previous lens's last frame,
            // and nothing re-arms — the heartbeat is gated on `idleFeedLive`.
            // The operator sees a frozen viewfinder on the first 1×↔0.5× flip.
            //
            // Cancelling here buys nothing that :1223 has not already bought:
            // the early-out above means a session IS installed, so there is no
            // parked request for this stop to reach. The async half only has to
            // CLOSE THE CAMERA.
            try { stopIdlePreview(reason, cancelWant = false) } catch (t: Throwable) {
                Log.w(TAG, "async idle-viewfinder stop threw", t)
            }
        }
    }

    /**
     * @param cancelWant whether this stop also CANCELS a pending idle-preview
     *   request that has not installed a session yet — the one parked in
     *   `awaitSurface`. Defaults to true because every external caller means
     *   "no viewfinder, please": `setIdlePreview(false)`, `start()`
     *   ("superseded-by-start"), and the two lifecycle teardowns. Without it
     *   the `?: return` below would report "nothing was running" and leave the
     *   parked request to open a camera afterwards.
     *
     *   `startIdlePreview` passes FALSE, and it is the only caller that may:
     *   it calls this to clear a PREVIOUS session on its way to installing its
     *   own, so cancelling the want here would cancel the request being served
     *   and no idle preview could ever start.
     */
    fun stopIdlePreview(
        reason: String,
        timeoutMs: Long = IDLE_STOP_BUDGET_MS,
        cancelWant: Boolean = true,
    ): String {
        if (cancelWant) idleWant.cancel()
        // ⚠ READ, THEN CLEAR — NEVER `getAndSet(null)` FIRST. Clearing up
        // front makes the session invisible to a `start()` racing in behind
        // an async stop, and `start()` would then open the camera without
        // waiting for the close it cannot see. Leaving the reference in place
        // until the stop RETURNS means the racing caller finds the same
        // session and blocks on its completion latch instead.
        val s = idlePreview.get()
            ?: return "no idle viewfinder was running"
        Log.i(TAG, "stopping the idle viewfinder: $reason")
        val why = try { s.stop(timeoutMs) } catch (t: Throwable) {
            Log.w(TAG, "stopping the idle viewfinder threw", t)
            "stopping the idle viewfinder threw ${t.javaClass.simpleName}"
        }
        idlePreview.compareAndSet(s, null)
        return why
    }

    // ── There is deliberately no probe() here ───────────────────────────
    // `RNSSweepProbe.probeCapabilities()` (PanoPlusAndroidProbe.kt)
    // is the pure-read capability probe for this port and is far more
    // thorough than anything this file would duplicate.  What the RECORDER
    // knows that a probe cannot — which camera it actually opened, what the
    // lock read back as, what the plane strides turned out to be — is in
    // device.json, which carries its own camera enumeration for the record.

    private fun describe(t: Throwable): String =
        "${t.javaClass.simpleName}: ${t.message ?: "(no message)"}"
}

// ════════════════════════════════════════════════════════════════════════
//  Options
// ════════════════════════════════════════════════════════════════════════

/** The iOS reference raster width (1920x1440). Not a hardware limit — the
 *  budget of a SOFTWARE JPEG encoder sitting on the frame path. */
internal const val DEFAULT_MAX_WIDTH = 1920

/**
 * `[x, y, z, w]` identity, for a frame whose attitude the map refused.
 *
 * A shared constant and not a fresh `doubleArrayOf` per frame: this is the
 * frame path, and the array is only ever READ (the JNI copies it into the
 * native FrameIn before the call returns), so one instance is safe and thirty
 * allocations a second are not.
 */
internal val PANO_IDENTITY_Q = doubleArrayOf(0.0, 0.0, 0.0, 1.0)

/**
 * How stale the newest attitude sample may be, at the moment a frame is
 * accepted, before that frame's `tracking` drops to 0.
 *
 * 100 ms is roughly three frame periods at 30 fps and ten to fifty IMU periods
 * at SENSOR_DELAY_FASTEST, so a healthy sensor never approaches it and a
 * genuinely stalled one crosses it immediately. It is deliberately NOT tight:
 * this bound answers "is there an attitude channel at all", not "how good is
 * the attitude" — the raw sample and its accuracy are on every row for the
 * offline pass to judge.
 */
internal const val DEFAULT_ATTITUDE_MAX_AGE_MS = 100.0

/** `Config::trackingWarmupFrames` in the engine (cpp/rnis_pano.hpp:766): the
 *  number of CONSECUTIVE `tracking == 2` rows the reference latch needs before
 *  it will latch at all. Mirrored here only to make the advisory say the real
 *  number; the engine remains the authority. */
internal const val TRACKING_WARMUP_FRAMES = 5

/**
 * How long ALL of a shutdown's thread joins may take TOGETHER, on the paths
 * that run off the caller's thread (`stop()`, `fail()`, the max-frames path —
 * every one of them dispatches onto `Dispatchers.IO`).
 *
 * Four joins at 3 s each, i.e. what the recorder has always done — kept as the
 * default because on a background thread a slow drain is a slow drain, and
 * cutting the writer off early loses the rows it was still flushing.
 */
internal const val JOIN_BUDGET_MS = 12_000L

/**
 * The same budget for a teardown running on a thread that MUST NOT BLOCK —
 * `onHostDestroy`, which `@ThreadConfined(UI)` puts on the main thread.
 *
 * ONE second for all four joins, not one second each. The distinction is the
 * whole fix: four independently-bounded joins are ADDITIVE, and 4 × 3 s plus a
 * blocking `CameraDevice.close()` plus a `device.json` fsync is an ANR — the
 * system's own limit is 5 s. A thread that misses this window is left to exit
 * on its own and is named in the advisories, which is strictly better than a
 * killed app that reports nothing.
 */
internal const val JOIN_BUDGET_UI_MS = 1_000L

/**
 * How long a caller waits for the IDLE viewfinder to hand the camera back.
 *
 * Two numbers for the same reason [JOIN_BUDGET_MS] and [JOIN_BUDGET_UI_MS] are
 * two: the wait is REQUIRED (an issued `close()` is not a released HAL, and
 * the sweep opens the same camera the instant it returns), but the thread
 * paying it decides what it can afford. `start()` waits on Dispatchers.IO and
 * pays the full budget; `invalidate()` is RN's NativeModules queue and
 * `onHostDestroy()` is the UI thread with an ANR at 5 s, so both take the
 * short one and accept that a very slow HAL is named in logcat instead.
 */
internal const val IDLE_STOP_BUDGET_MS = 2_000L
internal const val IDLE_STOP_BUDGET_UI_MS = 300L

/**
 * How long `startIdlePreview` waits for the panel's viewfinder view to offer
 * its SurfaceTexture before concluding there is not one.
 *
 * The wait exists because the panel's idle-preview effect and the view's mount
 * are ONE React commit whose two halves reach native unordered — measured at 12
 * ms apart on the operator's A35 (2026-09-03), with the effect winning and the
 * preview refusing permanently because nothing retried.
 *
 * 1500 ms is ~125x the measured gap, which is the point: this is not a tuned
 * number, it is a bound chosen to be far past any plausible commit so that a
 * timeout means "there is genuinely no viewfinder in this build" rather than
 * "the phone was busy". It is paid on `Dispatchers.IO` and by nothing else —
 * never RN's NativeModules queue, never the UI thread — and a request that is
 * superseded during it is cancelled by `PanoPlusIdleWant` rather than by waking up.
 */
internal const val IDLE_SURFACE_WAIT_MS = 1_500L

/**
 * How long `startIdlePreview` keeps retrying an open that failed because the
 * camera is still held by a client on its way out — the sweep it has just
 * replaced, whose ARCore teardown runs asynchronously after Discard.
 *
 * Only `PanoPlusIdlePreviewSession.retryable` refusals spin (the two
 * CameraDevice in-use codes, a disconnect, and the session's own open
 * watchdog); everything else answers on the first attempt.
 *
 * 6 s covers the measured gap with room to spare and is still short enough
 * that a genuinely occupied camera reports itself rather than hanging the
 * panel on a spinner. The whole loop is cancellable — `idleWant` is re-read
 * every attempt — so closing the panel mid-retry costs at most one interval.
 */
internal const val IDLE_OPEN_RETRY_BUDGET_MS = 6_000L
internal const val IDLE_OPEN_RETRY_INTERVAL_MS = 250L

/**
 * The refusal `startIdlePreview` answers while the Activity is paused. A
 * constant because it is answered from two places in the same request and the
 * panel prints it verbatim under "No live camera feed —", so the two must not
 * drift into two sentences for one state.
 */
internal const val IDLE_REFUSED_HOST_PAUSED =
    "the app is not in the foreground, so the idle viewfinder was not opened — it " +
        "reopens on its own when the app comes back."

/**
 * How long the IO coroutine waits for ONE attempt to answer before abandoning
 * it. The session settles itself within its own 4 s open watchdog, so this is
 * only a backstop against a session that never answers at all — without it a
 * single wedged HAL would park this coroutine for ever.
 */
internal const val IDLE_OPEN_ANSWER_BUDGET_MS = 8_000L

/**
 * ONE deadline shared by every join in a teardown.
 *
 * Pure and clock-injected so the arithmetic — the part that decides whether the
 * app survives an Activity destroy — is testable on the JVM with no device and
 * no `SystemClock`. `System.nanoTime` is the default because it is monotonic
 * and, unlike `SystemClock.elapsedRealtime`, is not an Android API that a unit
 * test would have to mock.
 */
internal class JoinBudget(
    val totalMs: Long,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
) {
    private val start: Long = nowMs()

    /**
     * Milliseconds the NEXT join may block for: whatever is left of the shared
     * budget, never negative.
     *
     * ZERO MEANS DO NOT BLOCK AT ALL — and the caller must honour that rather
     * than passing it to `Thread.join(0)`, which blocks FOREVER. That one-line
     * trap is why this returns a value the call site has to branch on.
     */
    fun remainingMs(): Long {
        val left = totalMs - (nowMs() - start)
        return if (left > 0L) left else 0L
    }
}

private class Config(
    val cameraId: String?,
    /**
     * The lens the chip asked for, RAW — `'ultraWide'` | `'wide'` — or null
     * when the bag carried no `lens` key (2026-09-03).
     *
     * ⚠ THREE THINGS OUTRANK IT, EACH RECORDED IN `selection.lensNote`: an
     * explicit [cameraId] (the caller named a device), ARCore's shared-camera
     * id on the AR arm (the session is ARCore's to configure), and a device
     * with no lens in the requested band (the other lens runs, `lensHonoured`
     * false). Null keeps the shipped widest-FOV rule, so every older caller
     * opens exactly the camera it opened before — its pack gains the
     * `selection.lens*` keys and nothing else moves.
     */
    val lens: String?,
    val sessionDir: String?,
    val maxWidth: Int,
    val jpegQuality: Int,
    val readerMaxImages: Int,
    val settleCeilingMs: Double,
    /**
     * WHICH ATTITUDE SERIES DRIVES THE GEOMETRY.
     *
     * false (shipped default) = `TYPE_ROTATION_VECTOR`, magnetometer-fused.
     * true  = `TYPE_GAME_ROTATION_VECTOR`, magnetometer-FREE.
     *
     * ⚠ WHY THIS EXISTS. Measured across 11 A35 packs on 2026-09-10: the
     * mag-fused series leaks indoor heading pull into the OFF-AXIS
     * remainder, because a near-horizontal sweep axis cannot absorb it into
     * psi. The rectifier then applies that remainder as a projective
     * KEYSTONE of every frame's footprint, so the painted band's bottom and
     * top edges tilt OPPOSITE ways — the operator's "the bottom edge, the
     * left edge drops". sign(residual yaw) == sign(predicted tilt) on 11 of
     * 11 packs; the mag-vs-game divergence is opposite in sign to that
     * residual on 11 of 11; and the ONE pack whose compass pulls the other
     * way is the ONE canvas that leans right.
     *
     * IT IS NOT A CURE. Analytic A/B over the same 11 packs: median residual
     * yaw 11.65 deg -> 3.27, predicted lean 11.78 -> 2.66. About 75%. The
     * rest is genuinely off-axis hand movement plus the sweep axis being
     * quantised to a cardinal raster direction, which is a separate change.
     *
     * THE COST IS GYRO YAW DRIFT, and it is the term the attitude header
     * itself calls the one that could veto the architecture. Without a
     * compass there is no absolute heading to correct it. It is measured
     * into every pack now (`attitude.headingDriftDegPerS`) rather than
     * assumed, so the operator's own captures size it.
     *
     * STRUCTURALLY THIS IS SOUND: rnis_pano_attitude.hpp:99-118 shows the
     * absolute datum CANCELS — only C survives `dR = R0^T Ri` — so a series
     * with no absolute heading is fine for this engine by construction.
     * Both series are still logged either way; only the driver changes.
     */
    /**
     * Lock AE and AWB for the sweep, after the settle.
     *
     * ⚠ ANDROID IGNORED THIS UNTIL 2026-09-10 — the lock was unconditional
     * and the flag died at the bridge, so the A/B it exists for could never
     * be run here. It matters now because the argument for pano+ owning a
     * camera on Android at all comes down to this lock: vision-camera
     * offers exposure COMPENSATION and never a lock. If an unlocked sweep
     * holds up, that argument goes with it.
     *
     * Note what the lock does and does not hold, measured: exposure time
     * pins exactly (33.32 ms on both ends of four sweeps) while ISO still
     * drifts a few percent (291-310, 265-268), so 'locked' is already not
     * quite constant even when it is on.
     */
    val lockCamera: Boolean,
    val attitudeMagFree: Boolean,
    /**
     * RIDE THE STITCHER'S OWN ARCore SESSION instead of opening a camera.
     *
     * The third start mode. The recorder opens NO Camera2 client and NO
     * ARCore session of its own; the host mounts the stitcher's AR camera
     * view and PanoPlusArFramePlugin feeds the engine from its frames, with
     * the pose arriving alongside the pixels it belongs to.
     *
     * This is what iOS has always done (RNISARPluginRegistry). The Android
     * SHARED_CAMERA arm it replaces has never painted a strip in 23 packs.
     */
    val arPluginArm: Boolean,
    /**
     * How old the idle viewfinder's metering memo may be and still be
     * usable as a settle TARGET (see the settle callback). 0 disables the
     * memo path entirely and restores the pre-2026-09-10 settle exactly.
     */
    val meteringMemoMaxAgeMs: Double,
    /**
     * Consecutive CaptureResults carrying an IDENTICAL exposure/ISO pair
     * before the settle is allowed to conclude on stability alone. 0
     * disables the stability path.
     */
    val settleStableResults: Int,
    val openTimeoutMs: Double,
    val metaJoinWaitMs: Double,
    val focusDistanceM: Double,
    val preferFps: Int,
    val template: String,
    val trackingOverride: Int,
    val preferPhysical: Boolean,
    val maxFrames: Int,
    val attitudeMaxAgeMs: Double,
    /**
     * A basis index MEASURED against a reference log (S1 / `selectBasis`),
     * or −1 for none.
     *
     * ⚠ THE OPTION IS AN ASSERTION, NOT A MEASUREMENT. Nothing here verifies
     * it — the recorder cannot, having no reference series until after the
     * sweep. What it does is OUTRANK the derived index and stamp every row
     * `rotation-vector×basis-measured`, so a pack that claims a measurement
     * says so in a field a reader can go and check against the S1 report that
     * produced the number. Passing a number that was never measured puts a
     * false claim in the pack; that is the operator's to get right, and it is
     * why the option is named for the evidence rather than for the effect.
     */
    val measuredBasisIndex: Int,
    /** Widest IMU bracket that may be interpolated across, milliseconds.
     *  Defaults to the engine's own `maxBracketGapS`. */
    val attitudeMaxBracketMs: Double,
    /**
     * The AR pose ring's own bracket limit. SEPARATE from the IMU ring's
     * because ARCore emits one pose per CAMERA frame (~30 Hz, measured
     * 33.4-33.8 ms apart on 17 packs) while TYPE_ROTATION_VECTOR arrives at
     * ~122 Hz. Sharing the 25 ms constant refused every AR frame as
     * bracket-too-wide and made the arm incapable of output.
     */
    val arAttitudeMaxBracketMs: Double,
    /** `off` (default) | `shared` | `standalone` | `auto`. See
     *  PanoPlusArCoreReference.kt for what each one costs. */
    val arcoreReference: ArCoreRefMode,
    val arcoreFocusMode: String,
    // ── THE LIVE ARM ────────────────────────────────────────────────────
    // `live` asks for the engine to ingest DURING the sweep. Off by default so
    // every existing caller of `RNSSweepRecorder.start()` — the debug
    // panel, the basis runs, the ARCore reference sessions — is byte-identical
    // to what shipped; `RNSSweepSession.start()` turns it on.
    val live: Boolean,
    /** "all" | "painted" | "none". See PackFrames in rnis_pano_live.hpp. */
    val packFrames: String,
    /** Engine knobs by NAME, passed through to `applyConfigOverride`. */
    val liveConfigOverrides: Map<String, String>,
    val livePreviewIntervalMs: Double,
    val livePreviewMaxDutyPct: Double,
    val livePreviewQuality: Int,
    val livePreviewMaxAlong: Int,
    val livePreviewMaxCross: Int,
    val livePreviewWindowCrossMult: Double,
    val livePreviewCropPad: Boolean,
    val livePreviewLeadOut: Boolean,
    val liveCanvasQuality: Int,
    val liveCanvasCropPad: Boolean,
    val liveWriteLedger: Boolean,
    /**
     * "imu" | "ar". THE ARM THAT FEEDS THE ENGINE (2026-09-02).
     *
     * "imu" is TYPE_ROTATION_VECTOR mapped through the basis `C` — the arm
     * that shipped, and the only one there was until today. "ar" feeds the
     * engine ARCore's `world<-camera` rotation directly, with NO basis (see
     * [ArCorePoseSink]: that series IS the convention `selectBasis()` fits the
     * IMU series onto).
     *
     * ⚠ ASKING FOR "ar" IS NOT GETTING IT. The AR arm needs a SHARED-camera
     * ARCore channel, which can refuse for four recorded reasons; when it
     * does, the sweep runs on the IMU arm and says so in `arm.ran`,
     * `arm.reason` and the start payload. A sweep is never lost to a pose-arm
     * refusal — a pack from the other arm is still a pack.
     */
    val livePoseSource: String,
    /**
     * How long a frame may WAIT for an ARCore pose that brackets it, ms.
     *
     * ⚠ WHY THIS EXISTS AT ALL. The ring interpolates BETWEEN two samples and
     * refuses to extrapolate past the newest one — the right rule, and the one
     * the IMU arm gets for free because the rotation vector runs at ~122 Hz
     * against 30 fps frames, so a sample newer than the frame is always already
     * there. ARCore runs at the CAMERA's rate: the pose for frame N is produced
     * by the same capture that produced frame N's pixels, on a different
     * thread, and whether it has landed when this frame is processed is a race
     * roughly half of frames would lose. Losing it means `after-last-sample` and
     * a frame painted from nothing.
     *
     * One frame period (33 ms at 30 fps) is enough to turn that race into a
     * wait, and the wait is bounded, counted, and paid on the WRITER thread —
     * never on RN's NativeModules queue. What it costs is throughput: a frame
     * arriving while this one waits is dropped by the single-in-flight gate and
     * counted in `droppedBusy`, exactly as a slow engine ingest already is.
     *
     * 0 disables the wait (and the first pack's `waitTimeouts` says what that
     * would have cost).
     */
    val arPoseWaitMs: Double,
    /**
     * Frames the AR arm may go WITHOUT A SINGLE ACCEPTED POSE before the
     * recorder gives it up and finishes the sweep on the IMU ring. `0`
     * disables the degrade and restores the pre-2026-09-18 behaviour.
     *
     * ⚠ WHY IT IS ON BY DEFAULT, when the house rule is that new behaviour
     * ships off. A default-off knob here would be a knob that protects
     * nobody: the state it guards against is a TOTAL LOSS of the sweep, it is
     * reached by an ordinary condition (a dim room), and the arm it degrades
     * from produced nothing at all in that state — 23 packs since 2026-08-24
     * and one more on 2026-09-18, zero strips between them. There is no
     * working behaviour for this to regress, because the branch only runs
     * when the AR arm has delivered literally zero poses.
     *
     * 30 is ~1.5 s at the measured 20 fps live cadence, and it is chosen
     * against ARCore's own timing rather than picked round: on the failing
     * pack ARCore first reported INSUFFICIENT_LIGHT 2.00 s in and had emitted
     * 174 poses by then, every one dropped as not-TRACKING. A healthy arm
     * delivers ~30 Hz, so thirty consecutive frames with ZERO accepted poses
     * is not a slow start — it is an arm that is not going to produce one.
     */
    val arImuFallbackAfterFrames: Int,
    /** The backstop for an ARCore that never reports a failure reason and
     *  never tracks. See `shouldDegradeArToImu`. */
    val arImuFallbackGraceMs: Double,
)

/**
 * `track.jsonl`'s `tracking` for one row: 2 when a FRESH attitude sample backs
 * the frame, 0 when none does.
 *
 * ── ⚠ WHY NOT `SensorEvent.accuracy`, which is what this file used until
 * 2026-09-01 ────────────────────────────────────────────────────────────────
 *
 * TYPE_ROTATION_VECTOR is magnetometer-fused, so its `accuracy` is the
 * COMPASS's calibration health. It reads LOW or UNRELIABLE until the compass
 * has been figure-eighted, and it drops to LOW beside steel shelving — which
 * is where every sweep on this programme happens.
 *
 * The engine reads `tracking != 2` as "not tracking": the reference latch
 * needs [TRACKING_WARMUP_FRAMES] CONSECUTIVE 2s and resets its counter on any
 * other value (rnis_pano.cpp — `if (in.tracking != 2) { S.warm = 0; return
 * WarmingUp; }`). Replaying a real 286-row pack with `tracking = 1` on every
 * row paints ZERO frames and yields an EMPTY canvas. That is a compass reading
 * dressed up as an engine verdict on Android, and it would have been the
 * port's first result.
 *
 * It was also gating a CONSTANT at the time: the recorder then wrote `q` as
 * identity on every row, so a row's attitude did not come from the
 * magnetometer — or from anywhere else.
 *
 * ── ⚠ AND WHY FRESHNESS ALONE IS NO LONGER ENOUGH ──────────────────────────
 *
 * That last clause stopped being true on 2026-09-01. `q` is now MAPPED from
 * the rotation vector whenever a basis authority and the clock gate allow it
 * (file header, item 1), and the map can fail PER FRAME: a frame the ring
 * cannot bracket — before the first sample, after the last, or across a gap
 * wider than [DEFAULT_ATTITUDE_MAX_BRACKET_MS] — is refused rather than
 * extrapolated, and its row carries the IDENTITY.
 *
 * A refused frame can still have a FRESH sample behind it (a sample delivered
 * 3 ms ago brackets nothing if the frame's own timestamp is 3 ms in that
 * sample's future), so the freshness rule on its own would answer 2 — telling
 * the engine "good attitude" about a row whose attitude is a constant. That is
 * the exact combination the reference latch must never be fed, so
 * [attitudeRefused] vetoes it.
 *
 * THE VETO IS SCOPED TO A REFUSED MAP, not to identity in general. A sweep
 * with NO basis authority writes identity on every row by design and is a
 * legitimate planar-arm pack; there `attitudeRefused` is false and the
 * freshness answer stands, unchanged, exactly as it shipped.
 *
 * ── FRESHNESS IS MEASURED IN ONE CLOCK ─────────────────────────────────────
 *
 * Both timestamps are `SystemClock.elapsedRealtimeNanos()`: the IMU sample's
 * as read at DELIVERY, the frame's as read at ACCEPT. Differencing the
 * camera's `SENSOR_TIMESTAMP` against `SensorEvent.timestamp` instead would be
 * exactly the shared-epoch assumption this recorder refuses to make (file
 * header, item 2) — and would silently answer 0 on every device whose
 * timestamp source is UNKNOWN.
 *
 * The raw `SensorEvent.accuracy` still rides on EVERY row as `imuAccuracy`, so
 * any stricter policy — including the old one — can be applied offline without
 * re-recording a sweep.
 */
internal fun derivePanoTracking(
    overrideValue: Int,
    imuDeliveredElapsedNs: Long?,
    frameAcceptElapsedNs: Long,
    maxAgeNs: Long,
    attitudeRefused: Boolean = false,
): Int {
    if (overrideValue in 0..2) return overrideValue
    // BEFORE the freshness rule, because a fresh sample is exactly what makes
    // this case dangerous: the row carries identity, so the only honest answer
    // is "no attitude channel behind this frame".
    if (attitudeRefused) return 0
    if (imuDeliveredElapsedNs == null) return 0
    val ageNs = frameAcceptElapsedNs - imuDeliveredElapsedNs
    // A NEGATIVE age is a sample delivered fractionally after the frame was
    // accepted — scheduling jitter between two threads reading the same clock.
    // That sample is fresher than fresh, so it must not fall through to 0.
    if (ageNs > maxAgeNs) return 0
    return 2
}

/**
 * WHY this camera was opened, in words — and NEVER a rule that did not run.
 *
 * ⚠ THE DEFECT THIS EXISTS TO CLOSE.  `device.json → selection.rule` was a
 * two-branch ternary: an explicit `cameraId` option, else "largest horizontal
 * FOV among LENS_FACING_BACK cameras".  Neither branch knew about ARCore, and
 * in shared-camera mode ARCore CHOOSES the camera id — so a sweep with no
 * explicit option (the panel's normal case) recorded a pack asserting that the
 * widest-FOV rule had chosen ARCore's camera.  Measured on SM-A356U1: the pack
 * said `rule: largest horizontal FOV …` beside `hFovDeg: 69.7` for camera 0,
 * while the rule's real answer was camera 2 at 96.2°.  The pack therefore
 * claimed 69.7° was the widest back FOV the device has, and a reader comparing
 * canvases across packs would attribute a narrower sweep to the device rather
 * than to the experiment.
 *
 * PURE, so the JVM suite can hold it: every argument is a String or a Double
 * and nothing here touches `android.*`.
 */
internal fun cameraSelectionRule(
    openedCameraId: String?,
    requestedCameraId: String?,
    forcedByArCoreId: String?,
    arcoreModeRan: String?,
    wouldHaveCameraId: String?,
    wouldHaveHFovDeg: Double,
    /** The chip's lens, when one was requested (2026-09-03) — `"0.5x"` /
     *  `"1x"` — else null. Outranked by the explicit option and by ARCore,
     *  exactly as in `start()`; when it ran, the rule MUST name it, or a 1x
     *  pack claims the widest-FOV rule chose camera 0 (measured: the first
     *  1x pack off the A35 said exactly that). */
    lensRequestedLabel: String? = null,
): String = when {
    openedCameraId == null ->
        "no camera was opened by this recorder" +
            (if (arcoreModeRan == "standalone")
                " — ARCore owns it in STANDALONE mode, and this pack has no pixels"
            else " — the sweep did not reach a selection")
    forcedByArCoreId != null ->
        "FORCED to camera $forcedByArCoreId by ARCore's shared-camera CameraConfig. " +
            "NEITHER the widest-FOV rule NOR the cameraId option chose it" +
            (if (requestedCameraId != null) " (the option asked for '$requestedCameraId')" else "") +
            ". Without ARCore this recorder would have taken camera " +
            "${wouldHaveCameraId ?: "?"} at " +
            (if (wouldHaveHFovDeg.isFinite())
                String.format(Locale.US, "%.1f", wouldHaveHFovDeg) + "°"
            else "an unknown") +
            " hFOV. hFovDeg beside this describes the camera ARCore forced, NOT the " +
            "widest this device has — read it as the price of the same-pixels A/B."
    requestedCameraId != null -> "explicit cameraId option"
    lensRequestedLabel != null ->
        "the chip's $lensRequestedLabel lens, by vision-camera's hFOV bands (>94° ultra-wide, " +
            "60-94° wide; 1x = first wide-band back camera in list order, 0.5x = widest " +
            "ultra-wide) — NOT the widest-FOV rule; see lensNote for the camera it chose " +
            "and lensHonoured for whether the band existed"
    else -> "largest horizontal FOV among LENS_FACING_BACK cameras, " +
        "computed as 2*atan(activePhysicalWidthMm / (2*minFocalMm))"
}

// ════════════════════════════════════════════════════════════════════════
//  Camera enumeration (shared by probe() and the recorder)
// ════════════════════════════════════════════════════════════════════════

/**
 * ⚠ `internal`, NOT `private`, AND ONLY FOR ONE READER.
 * `PanoPlusIdlePreviewSession` (PanoPlusIdlePreview.kt) has to reach the SAME
 * camera this recorder will open — the operator frames his shot through the
 * idle viewfinder and then records with the sweep, and a different lens
 * between the two is a framing he was shown and does not get. Sharing the
 * enumeration is what makes "the same camera" a fact rather than an intention.
 */
internal class CamInfo(
    val id: String,
    val chars: CameraCharacteristics,
    val facing: Int?,
    val focalsMm: FloatArray?,
    val physW: Float?,
    val physH: Float?,
    val pixelArray: Size?,
    val preActive: Rect?,
    val active: Rect?,
    val hFovDeg: Double,
    val level: Int?,
    val timestampSource: Int?,
    val logicalPhysicalIds: Set<String>,
    val yuvSizes: List<Size>,
    val fpsRanges: List<Range<Int>>,
)

private fun levelName(v: Int?): String = when (v) {
    CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
    CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
    CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
    CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL_3"
    CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "EXTERNAL"
    null -> "unavailable"
    else -> "unknown($v)"
}

private fun timestampSourceName(v: Int?): String = when (v) {
    CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME -> "REALTIME"
    CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN -> "UNKNOWN"
    null -> "unavailable"
    else -> "unrecognised($v)"
}

/**
 * @throws anything `getCameraCharacteristics` throws. Deliberately NOT caught
 * here: a camera that will not describe itself must be named to the operator by
 * the caller, and a half-populated CamInfo would read as a real answer.
 *
 * `internal` for the same one reason [CamInfo] is — see its KDoc.
 */
internal fun readCamInfo(mgr: CameraManager, id: String): CamInfo {
    run {
        val c = mgr.getCameraCharacteristics(id)
        val focals = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
        val phys = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        val pixelArray = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
        val preActive = c.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
        val active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)

        // Widest FOV = SHORTEST focal length, against the physical width of the
        // ACTIVE area (not the whole pixel array — the inactive border carries
        // no image and would overstate the angle).
        val fMin = focals?.filter { it.isFinite() && it > 0f }?.minOrNull()
        val physActiveW = if (phys != null && pixelArray != null && preActive != null &&
            pixelArray.width > 0
        ) phys.width * (preActive.width().toFloat() / pixelArray.width) else phys?.width
        val hFov =
            if (fMin != null && physActiveW != null && physActiveW > 0f)
                2.0 * Math.toDegrees(Math.atan((physActiveW / (2.0 * fMin))))
            else Double.NaN

        val physIds: Set<String> =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                try { c.physicalCameraIds } catch (_: Throwable) { emptySet() }
            else emptySet()

        val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val yuv = map?.getOutputSizes(ImageFormat.YUV_420_888)?.toList() ?: emptyList()
        val fps = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            ?.toList() ?: emptyList()

        return CamInfo(
            id = id, chars = c,
            facing = c.get(CameraCharacteristics.LENS_FACING),
            focalsMm = focals, physW = phys?.width, physH = phys?.height,
            pixelArray = pixelArray, preActive = preActive, active = active,
            hFovDeg = hFov,
            level = c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL),
            timestampSource = c.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE),
            logicalPhysicalIds = physIds,
            yuvSizes = yuv, fpsRanges = fps,
        )
    }
}

/**
 * The lens rule's view of a camera. `order` is its position in
 * `getCameraIdList`, which is the 1x tiebreak (the platform's default rear
 * camera is the first back-facing id in that list). Shared with the idle
 * viewfinder for the same one reason [CamInfo] is.
 */
/**
 * `android.util.Range<Int>` ↔ the android-free [PanoPlusProbeMath.FpsRange].
 *
 * The selector is deliberately free of android.* so the JVM suite can pin it
 * (see `PanoPlusIdleFpsPinTest`); these two lines are the whole cost of that,
 * and they are shared by the sweep and the idle viewfinder so neither has to
 * carry its own conversion.
 */
internal fun Range<Int>.toProbeFpsRange(): PanoPlusProbeMath.FpsRange =
    PanoPlusProbeMath.FpsRange(lower, upper)

internal fun PanoPlusProbeMath.FpsRange.toAndroidRange(): Range<Int> = Range(lower, upper)

internal fun CamInfo.toLensCandidate(order: Int): PanoPlusLensCandidate =
    PanoPlusLensCandidate(
        id = id,
        back = facing == CameraCharacteristics.LENS_FACING_BACK,
        hFovDeg = hFovDeg,
        hasYuv = yuvSizes.isNotEmpty(),
        order = order,
    )

private fun camInfoJson(i: CamInfo): String {
    val jo = Jo()
        .s("id", i.id)
        .s(
            "facing", when (i.facing) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
                else -> "unknown"
            },
        )
        .n("hFovDeg", i.hFovDeg)
        .raw(
            "focalLengthsMm",
            i.focalsMm?.let { f -> jarr(*DoubleArray(f.size) { f[it].toDouble() }) } ?: "null",
        )
        .n("physicalWidthMm", i.physW)
        .n("physicalHeightMm", i.physH)
        .s("pixelArray", i.pixelArray?.toString())
        .rect("preCorrectionActiveArray", i.preActive)
        .rect("activeArray", i.active)
        .s("hardwareLevel", levelName(i.level))
        .s("timestampSource", timestampSourceName(i.timestampSource))
        .raw("physicalCameraIds", jarrStr(i.logicalPhysicalIds.sorted()))
        .b("isLogicalMultiCamera", i.logicalPhysicalIds.isNotEmpty())
        .raw("yuv420Sizes", jarrStr(i.yuvSizes.map { it.toString() }))
        .raw("aeTargetFpsRanges", jarrStr(i.fpsRanges.map { it.toString() }))
    return jo.end()
}

private fun probeCameras(mgr: CameraManager): String {
    val out = ArrayList<String>()
    val ids = try { mgr.cameraIdList } catch (t: Throwable) {
        return "[" + Jo().s("error", "getCameraIdList threw: ${t.javaClass.simpleName}: ${t.message}")
            .end() + "]"
    }
    for (id in ids) {
        out += try {
            camInfoJson(readCamInfo(mgr, id))
        } catch (t: Throwable) {
            Jo().s("id", id)
                .s("error", "characteristics unavailable: ${t.javaClass.simpleName}: ${t.message}")
                .end()
        }
    }
    return jarrRaw(out)
}

// ════════════════════════════════════════════════════════════════════════
//  The recording session
// ════════════════════════════════════════════════════════════════════════

private const val ST_IDLE = 0
private const val ST_OPENING = 1
private const val ST_SETTLING = 2
private const val ST_RECORDING = 3
private const val ST_STOPPING = 4

private class Rec(private val ctx: Context, private val cfg: Config) {

    // ── Threads. Four, each with one job, all quit in shutdown(). ───────
    // camThread carries the CameraDevice / session / CaptureResult callbacks
    // and must never be blocked by pixel work: the CaptureResult it delivers
    // is the ONLY source of SENSOR_TIMESTAMP, and a late result is a frame
    // written with `metaJoined:false`.
    private val camThread = HandlerThread("rnis-pp-cam").apply { start() }
    private val camH = Handler(camThread.looper)
    private val readerThread = HandlerThread("rnis-pp-reader").apply { start() }
    private val readerH = Handler(readerThread.looper)
    private val writerThread = HandlerThread("rnis-pp-writer").apply { start() }
    private val writerH = Handler(writerThread.looper)
    private val sensorThread = HandlerThread("rnis-pp-imu").apply { start() }
    private val sensorH = Handler(sensorThread.looper)
    private val camExec = Executor { r -> camH.post(r) }

    /** Invoked once at the end of shutdown(), whatever caused it — a stop(),
     *  a camera error, a disconnect or a failed start. The module uses it to
     *  drop its pointer, so status()/stop() stop reporting on a dead session
     *  instead of pretending a torn-down recorder is still live. */
    @Volatile var onTeardown: (() -> Unit)? = null

    private val state = AtomicInteger(ST_IDLE)
    private val settled = AtomicBoolean(false)   // promise settle guard
    private val torndown = AtomicBoolean(false)

    private var mgr: CameraManager? = null
    private var device: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var reader: ImageReader? = null

    // ── Chosen configuration, filled during start() ─────────────────────
    private var chosen: CamInfo? = null
    private var boundPhysicalId: String? = null
    private var physicalBindRoute = "logical-or-plain (no physical binding attempted)"
    private var effChars: CameraCharacteristics? = null   // physical's, when bound
    @Volatile private var outSize: Size? = null
    private var fpsRange: Range<Int>? = null
    private var fpsRequestedNote = ""
    private var sensorOrientation: Int? = null
    /** ARCore's shared-camera id, when it OVERRODE this recorder's own pick.
     *  Null in every other mode — see [wouldHaveCameraId] for why both halves
     *  are kept. */
    private var forcedCameraIdByArCore: String? = null
    /** What the recorder's OWN rule would have chosen, kept even when it was
     *  overridden.
     *
     *  ⚠ WITHOUT THIS THE PACK LIES ABOUT ITS OWN SELECTION. `selection.rule`
     *  used to read "largest horizontal FOV among LENS_FACING_BACK cameras" on
     *  every sweep that did not pass an explicit `cameraId` — INCLUDING a
     *  shared-camera sweep, where ARCore picks the id and the rule never ran.
     *  On SM-A356U1 that put `rule: widest-FOV` beside `hFovDeg: 69.7` for
     *  camera 0 while the rule's real answer was camera 2 at 96.2°, i.e. the
     *  pack asserted 69.7° was the widest back FOV this device has. */
    private var wouldHaveCameraId: String? = null
    private var wouldHaveHFovDeg = Double.NaN
    // ── THE CHIP'S LENS (2026-09-03) ────────────────────────────────────
    /** The request, parsed; null when the bag carried no `lens` (an older
     *  caller — the widest-FOV rule then runs unchanged). */
    private val lensRequested: PanoPlusLens? = PanoPlusLens.parse(cfg.lens)
    /** Which lens the OPENED camera is, by vision-camera's hFOV band — written
     *  on EVERY sweep, including ones that asked for none, so the pack always
     *  says which lens ran. */
    private var lensRan: PanoPlusLens? = null
    /** `lensRequested != null && lensRan == lensRequested`. */
    private var lensHonoured = false
    /** Why that lens, in the sentence the pack and the start payload carry. */
    private var lensNote = "no camera has been selected yet"
    /** WHY this output size won, in words — the size alone cannot say whether
     *  it was chosen for its rate, settled for, or fallen back to. */
    private var sizeChoiceReason = ""
    private var chosenSizeMinFrameDurationNs = -1L
    private var chosenSizeMaxFps = Double.NaN

    /** Attitude staleness bound in the elapsedRealtime domain, resolved once. */
    private val attitudeMaxAgeNs: Long = (cfg.attitudeMaxAgeMs * 1e6).toLong()

    // ── Files ───────────────────────────────────────────────────────────
    private lateinit var packDir: File
    private lateinit var framesDir: File
    private var trackW: BufferedWriter? = null
    private var sensorsW: BufferedWriter? = null
    /** OPENED ONLY WHEN THE ARCORE CHANNEL ACTUALLY RAN. An empty
     *  `attitude_arcore.jsonl` in a pack that never asked for one would read
     *  as "ARCore recorded nothing", which is a different and much worse
     *  claim than "no reference channel was requested". */
    private var arcoreW: BufferedWriter? = null
    private val arcoreWLock = Object()

    // ── Counters. Every fallback in this file lands in exactly one. ─────
    private val seqNext = AtomicLong(0)
    private val framesArrived = AtomicLong(0)
    private val framesWritten = AtomicLong(0)
    private val droppedBusy = AtomicLong(0)
    private val droppedNotRecording = AtomicLong(0)
    private val droppedAcquireNull = AtomicLong(0)
    private val droppedFrameCap = AtomicLong(0)
    private val frameWriteFailed = AtomicLong(0)
    private val convertFailed = AtomicLong(0)
    private val metaMissing = AtomicLong(0)
    private val intrinsicsPerFrameRows = AtomicLong(0)
    private val layoutChanged = AtomicLong(0)
    private val resultsSeen = AtomicLong(0)
    private val pendingDropReport = AtomicInteger(0)
    private val encoderBusy = AtomicBoolean(false)
    private val firstFrameError = AtomicReference<String?>(null)

    // ── The live arm ────────────────────────────────────────────────────
    // `liveActive` is set only after the native session has actually STARTED.
    // It is deliberately not `cfg.live`: a request to run live and a live
    // session that opened are different facts, and a sweep that fell back to
    // plain recording because the .so was stale must say so rather than write
    // rows claiming an engine that never ran.
    // @Volatile on all four: they are WRITTEN on the start coroutine
    // (Dispatchers.IO) and on the teardown thread, and READ on the writer
    // thread (`writeFrame`) and on RN's NativeModules thread (`statusSnapshot`
    // at 2 Hz). `liveActive` in particular gates the ingest call itself — a
    // frame path reading a stale `false` would silently record instead of
    // painting, which is the whole defect this arm exists to fix, arriving
    // through a missing memory barrier.
    //
    // The publication of `liveActive` is ALSO carried by the AtomicInteger
    // `state` (written after it, read before any frame is accepted), so this is
    // the belt to that brace rather than the only guard — but the brace depends
    // on an ordering three methods apart and this does not.
    @Volatile private var liveActive = false
    @Volatile private var liveStartJson: String? = null
    @Volatile private var liveStartError: String? = null
    @Volatile private var liveSummaryJson: String? = null
    private val packFramesMode: Int = when (cfg.packFrames.lowercase()) {
        "all" -> PanoPlusLiveNative.PACK_FRAMES_ALL
        "painted" -> PanoPlusLiveNative.PACK_FRAMES_PAINTED
        else -> PanoPlusLiveNative.PACK_FRAMES_NONE
    }
    private val liveIngested = AtomicLong(0)
    private val livePainted = AtomicLong(0)
    private val liveRefused = AtomicLong(0)
    private val liveEngineMs = Stat()

    private val convertMs = Stat()
    private val encodeMs = Stat()
    private val readerMs = Stat()
    private val jpegBytes = Stat()
    private val camTsMinusElapsed = Stat()
    private val imuTsMinusElapsed = Stat()
    private val exposureNsStat = Stat()
    private val isoStat = Stat()

    private var firstTsNs = 0L
    private var lastTsNs = 0L
    private var firstResultTsNs = 0L
    private var lastResultTsNs = 0L
    private var resultTsCount = 0L

    // ── Buffers (single frame in flight; see the busy gate) ─────────────
    @Volatile private var nv21: ByteArray? = null
    private var jpegRect: Rect? = null
    private var yuvImage: YuvImage? = null
    private var yuvBacking: ByteArray? = null
    private var scratch: ByteArray? = null
    private var observedLayout: YuvLayout? = null

    // ── CaptureResult join ──────────────────────────────────────────────
    private val metaLock = Object()
    private val metaByTs = LinkedHashMap<Long, FrameMeta>()

    // ── ARCore reference channel (optional; see PanoPlusArCoreReference) ─
    @Volatile private var arcore: ArCoreChannel? = null
    private var arcoreAvailability: ArCoreAvailability? = null
    private var arcoreReason = "off (arcoreReference was not requested)"
    private var arcoreRowWriteFailed = 0L
    private var arcoreRowsAfterClose = 0L

    // ── The written-frame index the ARCore rows are matched against ──────
    // Only frames that REACHED DISK are in it: a frame dropped for encoder
    // backpressure has no `seq`, and a pose row naming it would point at a
    // file that does not exist. Bounded because a long sweep must not grow a
    // list; 1024 rows is ~34 s at 30 fps, far longer than any pose row's lag
    // behind the writer.
    private val frameTsRing = LongArray(1024)
    private val frameSeqRing = LongArray(1024)
    private var frameRingCount = 0
    private val frameRingLock = Object()

    // ── IMU ─────────────────────────────────────────────────────────────
    private var sensorMgr: SensorManager? = null
    private var rotVec: Sensor? = null
    private var gameRotVec: Sensor? = null
    private val imuLatest = AtomicReference<ImuSample?>(null)
    private val imuCount = AtomicLong(0)
    private val gameImuCount = AtomicLong(0)
    private var imuFirstTsNs = 0L
    private var imuLastTsNs = 0L
    private val imuAccuracyHist = IntArray(8)     // index = accuracy+1, clamped
    private val trackingHist = IntArray(3)
    // The LONGEST run of consecutive tracking==2 rows, and the run in progress.
    // Written only on the writer thread, published to the reporter by the
    // shutdown join — the trackingHist rule, for the same reason. This is the
    // number the engine's reference latch actually gates on, and a sweep that
    // never reaches TRACKING_WARMUP_FRAMES paints nothing at all.
    private var trackingRun = 0
    private var trackingRunMax = 0

    // ── The VIEWFINDER (see PanoPlusPreviewView.kt) ─────────────────────
    // `previewSurface` is non-null from the moment it is CLAIMED;
    // `previewAttached` only once a session has configured with it. Every
    // capture request reads the second, because addTarget on a surface that is
    // not one of the session's outputs throws on every request.
    // All four are @Volatile: they are written on the start() coroutine and on
    // camThread and READ from the JS thread by statusMap(), which the panel
    // polls twice a second during a sweep.
    @Volatile private var previewSurface: android.view.Surface? = null
    @Volatile private var previewAttached = false
    /** ⚠ STICKY, AND device.json READS THIS ONE. `previewAttached` is CLEARED
     *  during teardown — it has to be, because a capture request must not add
     *  a target the session no longer has — and device.json is written AFTER
     *  teardown, so every finished pack reported `preview.attached: false`
     *  even when the operator had a viewfinder for the whole sweep. Measured
     *  on the 2026-09-01 live packs: `attached:false` sitting beside
     *  `note: "preview claimed at 1440x1080"`, i.e. the claim succeeding and
     *  the report denying it. A pack that cannot say whether the sweep was
     *  aimed or blind cannot answer the only question a framing complaint
     *  asks. */
    @Volatile private var previewEverAttached = false
    @Volatile private var previewSize: Size? = null
    @Volatile private var previewNote = "no viewfinder was mounted when this sweep started"

    // ── The attitude MAP (see the file header, item 1) ───────────────────
    // The ring is written on the sensor thread and read on the writer thread;
    // it is @Synchronized internally, which is why it is not behind a lock
    // here. It exists BESIDE imuLatest rather than replacing it: `imuLatest`
    // answers FRESHNESS (one atomic read, no search) and the ring answers
    // POSE (bracket + SLERP), and collapsing them would make `tracking` pay
    // for a binary search on every frame to answer a question it never asks.
    private val attitudeRing = PanoAttitudeRing()
    private val attitudeMaxBracketNs: Long = (cfg.attitudeMaxBracketMs * 1e6).toLong()
    private val arAttitudeMaxBracketNs: Long = (cfg.arAttitudeMaxBracketMs * 1e6).toLong()

    // ── THE AR POSE ARM (2026-09-02, see Config.livePoseSource) ──────────
    //
    // A SECOND ring, deliberately, rather than a mode switch inside the first.
    // The two series are on the same CLOCK but are not the same measurement:
    // the rotation vector is ~122 Hz device attitude that must be mapped
    // through `C`, and this is ~30 Hz camera attitude that must not be mapped
    // at all. Sharing one ring would make the pack unable to say which series
    // a refusal came from, and would make an AR sweep's `attitude.map` block
    // describe samples the map never touched.
    //
    // WRITTEN ON THE ARCore PUMP THREAD, READ ON THE WRITER THREAD. The ring
    // is `@Synchronized` internally; `arPoseLock` is separate and exists ONLY
    // for the bracket wait's notify — a frame waiting for a newer sample has to
    // be woken by the insert that makes it available, and the ring's own
    // monitor is not something the wait may hold.
    private val arPoseRing = PanoAttitudeRing()
    private val arPoseLock = Object()
    private val arPoseWaitNs: Long = (cfg.arPoseWaitMs * 1e6).toLong()

    /** True only when the AR arm was ASKED FOR and can actually run: the
     *  channel opened in SHARED mode (standalone has no pixels of ours to pose)
     *  and the sink is installed. Read on the writer thread on every frame. */
    @Volatile private var arArmActive = false

    /**
     * True when THIS sweep armed the AR frame plugin.
     *
     * ⚠ IT EXISTS BECAUSE THE PLUGIN'S COUNTERS ARE PROCESS-WIDE AND ITS ARM IS
     * NOT. `PanoPlusArFramePlugin.shared` is a singleton whose counters are
     * zeroed only by `arm()`, so after one AR sweep they keep their values for
     * the life of the process. Writing them unconditionally into device.json
     * would stamp the previous AR sweep's `seen`/`droppedBusy` onto every later
     * IMU pack — and the operator's own 2026-09-11 session is exactly that
     * shape: one AR sweep followed by three IMU sweeps in 73 seconds. Each of
     * those three would have carried a ~150-frame refusal it never had, in the
     * one field added to make the arm trustworthy.
     *
     * A per-[Rec] flag rather than a global: `Rec` is constructed fresh on every
     * start(), so it cannot leak across sweeps by construction.
     */
    @Volatile private var arPluginArmActive = false
    /** Why [arArmActive] is what it is — always populated, and the string the
     *  pack and the start payload both carry. */
    @Volatile private var arArmReason = "not requested (poseSource was not 'ar')"
    /** Poses the sink accepted into the ring (TRACKING only). */
    private val arPoseAccepted = AtomicLong(0)
    /**
     * Consecutive-from-the-start frames that found the AR ring still empty.
     * Only counted while [arPoseAccepted] is 0, so it stops the instant the
     * arm produces anything and can never trip a working sweep.
     */
    private val arFramesWithNoPose = AtomicLong(0)
    /** Set once if the AR arm was given up mid-sweep for the IMU ring. Read by
     *  the pack so `ran: "imu"` can never be mistaken for "AR was never
     *  requested" — the camera ARCore forced is still the camera that shot it. */
    @Volatile private var arArmDegraded = false
    /** The `seq` of the row the degrade happened on — the SAME index
     *  track.jsonl carries, so a reader can join the two without guessing.
     *  -1 while it has not happened. */
    @Volatile private var arArmDegradedAtSeq = -1L
    /** The two counts as they stood AT THE DECISION. Frozen deliberately: the
     *  sibling fields in `arm` are sweep totals, and quoting a running total
     *  inside a sentence about a past moment is how a pack contradicts
     *  itself. */
    @Volatile private var arArmDegradeCounters = ""
    /** Set when the AR arm went stale AFTER producing a usable pose, which the
     *  degrade cannot rescue. Carries the reason so a second total-loss pack
     *  is not diagnosed from scratch. */
    @Volatile private var arArmDegradeDeclined = ""
    /** Whether the native `meta.json` correction landed. Recorded rather than
     *  assumed: the JNI entry binds at its first call. */
    @Volatile private var arArmMetaCorrected = false
    private var arArmDeclinedSaid = false
    private var arArmLastSolvedSeen = 0L
    private val arFramesSinceSolve = AtomicLong(0)
    /** Poses the sink DROPPED because ARCore was not TRACKING. Separate from
     *  the channel's own count: this one is the number the ring never saw. */
    private val arPoseDroppedNotTracking = AtomicLong(0)
    /** Frames that had to wait for a bracketing pose, and those that waited the
     *  whole budget and still had none. The second is the number that says
     *  whether [Config.arPoseWaitMs] is big enough on this device. */
    private val arPoseWaited = AtomicLong(0)
    private val arPoseWaitTimedOut = AtomicLong(0)
    private val arPoseWaitMsStat = Stat()
    /** Frames the AR ring successfully bracketed + SLERPed. */
    private val arPoseSolved = AtomicLong(0)
    /** AR-ring refusals by [PanoAttitudeRefusal] name — the AR arm's own
     *  equivalent of `attitudeRefusalCounts`, and never merged with it. */
    private val arPoseRefusalCounts = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /** Resolved ONCE per sweep, before the first frame. Never re-resolved:
     *  every row of a pack must be built on one basis, or the pack's own
     *  quaternions are not comparable with each other. */
    @Volatile private var basis: PanoBasisResolution? = null
    @Volatile private var clockGate: PanoClockGate? = null
    /** True only when a basis authority AND the clock gate both allow it. */
    @Volatile private var attitudeMapping = false

    private val attitudeMapped = AtomicLong(0)
    /** Refusals bucketed by [PanoAttitudeRefusal]; the pack reports each by
     *  name, because "the map refused 40 frames" and "the map refused 40
     *  frames because the sensor had not started yet" send a reader to
     *  different places. */
    private val attitudeRefusalCounts = java.util.concurrent.ConcurrentHashMap<String, Long>()
    /**
     * The first and last MAPPED `q` of the sweep.
     *
     * THE HEADLINE NUMBER OF THE WHOLE CHANGE. The identity arm's failure was
     * legible in exactly one figure — first→last quaternion angle 0.00° across
     * 152 frames while ARCore saw 57.1° — so the pack now carries that figure
     * itself. A sweep whose mapped series still reports ~0° over a real pan
     * has a dead map, and this is where it says so.
     *
     * Written only on the writer thread; published to the reporter by the
     * shutdown join, the same rule as trackingRunMax.
     */
    private var attitudeFirstQ: DoubleArray? = null
    private var attitudeLastQ: DoubleArray? = null

    // ── Applied-settings read-back (report, never assume) ───────────────
    /** The two attitude series, kept side by side for the drift witness. */
    private val magLatest = java.util.concurrent.atomic.AtomicReference<ImuSample?>(null)
    private val gameLatest = java.util.concurrent.atomic.AtomicReference<ImuSample?>(null)
    /** First and last paired reading, for the sweep-long divergence. */
    private var divFirst: Pair<ImuSample, ImuSample>? = null
    private var divLast: Pair<ImuSample, ImuSample>? = null
    private var aeSettleMs = -1.0
    private var aeSettleResults = 0
    /** Which predicate ended the settle. See the settle callback. */
    private var aeSettleExitReason: String = "unset"
    /** The idle viewfinder's memo as it stood when the settle began. */
    private var meteringMemoAtStart: PanoPlusMetering? = null
    private var meteringMemoAgeMsAtStart = -1.0
    private var meteringMemoVerdict: String = "not consulted"
    /** The settle-phase exposure/ISO trace, so the exit is auditable. */
    private val settleTrace = ArrayList<LongArray>(64)
    private var aeStateAtLock: Int? = null
    private var awbStateAtLock: Int? = null
    private var aeLockObserved: Boolean? = null
    private var awbLockObserved: Boolean? = null
    private var afModeApplied: Int? = null
    private var afModeObserved: Int? = null
    private var focusRequestedDiopters: Float? = null
    private var focusObservedDiopters: Float? = null
    private var lensStateObserved: Int? = null
    private var oisApplied: String = "not-attempted"
    private var evsApplied: String = "not-attempted"
    private var zoomApplied: String = "not-attempted"
    private var cropRegionFirst: Rect? = null
    private var cropRegionChanged = false
    private var intrinsicsSource = "pending"
    private var intrinsicsNote = ""
    // Intrinsics in PRE-CORRECTION ACTIVE ARRAY pixels — the frame each frame's
    // SCALER_CROP_REGION is then applied to. `constFx..constCy` below are these
    // mapped through the FULL array, kept only so device.json can report the
    // uncropped numbers.
    @Volatile private var arrFx = 0.0
    @Volatile private var arrFy = 0.0
    @Volatile private var arrCx = 0.0
    @Volatile private var arrCy = 0.0
    @Volatile private var arrValid = false
    @Volatile private var arrayRect: Rect? = null
    private var constFx = 0.0
    private var constFy = 0.0
    private var constCx = 0.0
    private var constCy = 0.0
    private val advisories = ArrayList<String>()

    private var startWallMs = 0.0
    private var startElapsedNs = 0L
    private var startUptimeNs = 0L
    private var abortReason: String? = null

    private fun advise(s: String) {
        synchronized(advisories) { if (advisories.size < 64) advisories += s }
        Log.w(TAG, s)
    }

    // ════════════════════════════════════════════════════════════════════
    //  start
    // ════════════════════════════════════════════════════════════════════

    fun start(promise: Promise) {
        state.set(ST_OPENING)
        startWallMs = System.currentTimeMillis().toDouble()
        startElapsedNs = SystemClock.elapsedRealtimeNanos()
        startUptimeNs = SystemClock.uptimeMillis() * 1_000_000L

        // ── The ARCore reference channel, BEFORE the camera ─────────────
        // Order is load-bearing in shared mode: ARCore SELECTS the camera id
        // and the CPU image size, so the recorder's own selection has to run
        // against ARCore's answer rather than being overridden after the fact.
        // In standalone mode ARCore takes the camera outright and the recorder
        // opens none at all.
        if (cfg.arcoreReference != ArCoreRefMode.OFF) {
            val avail = readArCoreAvailability(ctx)
            arcoreAvailability = avail
            val (ch, why) = openArCoreChannel(
                ctx, cfg.arcoreReference, avail, cfg.arcoreFocusMode, { advise("ARCore: $it") },
            )
            arcore = ch
            arcoreReason = why
            if (ch == null) {
                // REFUSED BY NAME, and the sweep still runs. The pixels and the
                // rotation-vector series are exactly what they would have been;
                // what is missing is the reference channel, and device.json
                // says which of the four reasons it was.
                advise(
                    "ARCore reference channel was REQUESTED (${cfg.arcoreReference}) and did " +
                        "NOT run: $why. This pack has NO reference attitude series, so the " +
                        "derived basis stays unfalsified and there is no pose-arm A/B — the " +
                        "sweep itself is unaffected.",
                )
            } else {
                advise(
                    "ARCore reference channel is running in ${ch.modeRan.uppercase()} mode. " +
                        (if (ch.modeRan == "shared")
                            "ARCore selected camera ${ch.forcedCameraId()} at " +
                                "${ch.forcedImageSize()}, OVERRIDING this recorder's own " +
                                "widest-FOV and maxWidth choices — that is a recorded confound, " +
                                "not a defect."
                        else
                            "ARCore owns the camera; THIS PACK WILL CONTAIN NO PIXELS. The " +
                                "basis falsification is still valid (both attitude series are " +
                                "simultaneous); the same-pixels pose-arm A/B is NOT."),
                )
            }
        }

        // ── THE AR POSE ARM: ARM IT, OR SAY WHY NOT ─────────────────────
        // Decided HERE, once, before the camera opens, because everything
        // downstream — which ring a frame solves against, what `qSource` says,
        // what the pack's `arm` block records — has to be one answer for the
        // whole sweep. A sweep that switched arms mid-way would produce a
        // quaternion series that is not comparable with itself.
        if (cfg.live && cfg.livePoseSource == "ar") {
            val ch = arcore
            when {
                ch == null -> {
                    arArmReason =
                        "the AR arm was REQUESTED and the ARCore channel did not open " +
                            "($arcoreReason). The sweep runs on the IMU arm " +
                            "(TYPE_ROTATION_VECTOR through the derived basis C) — a pack from " +
                            "the other arm is still a pack, and losing the sweep to a " +
                            "pose-arm refusal would be the worse trade."
                    advise("pose arm: $arArmReason")
                }
                ch.modeRan != "shared" -> {
                    // STANDALONE poses ARCore's OWN camera, and the recorder
                    // opens none — there would be no pixels for the engine to
                    // paint. Refusing here rather than at the first frame is
                    // what keeps the failure attributable.
                    arArmReason =
                        "the AR arm was REQUESTED and ARCore came up in ${ch.modeRan.uppercase()} " +
                            "mode, not SHARED. In that mode ARCore owns the camera and this " +
                            "recorder opens none, so there are no pixels of ours to paint from. " +
                            "The sweep runs on the IMU arm."
                    advise("pose arm: $arArmReason")
                }
                else -> {
                    ch.setPoseSink(arPoseSink)
                    arArmActive = true
                    arArmReason =
                        "ARCore SHARED-camera poses feed the engine directly, with NO basis " +
                            "(Camera.getPose() is already world<-camera in the engine's own " +
                            "convention). COSTS, all measured and none hidden: ARCore chose " +
                            "camera ${ch.forcedCameraId()} at ${ch.forcedImageSize()} from its " +
                            "own CameraConfig list, so the ultra-wide and the maxWidth cap are " +
                            "BOTH overridden; Session.resume() installs ARCore's repeating " +
                            "request, so the AE/AWB lock is ARCore's to keep or drop (read " +
                            "applied.exposureTimeNs — a spread means it dropped it); and the " +
                            "pose series is ~30 Hz, joined by NEAREST-bracket + SLERP, never by " +
                            "timestamp equality."
                    advise("pose arm: AR (ARCore, shared camera). $arArmReason")
                }
            }
        } else if (cfg.livePoseSource == "ar") {
            // `poseSource:'ar'` on a RECORDING (non-live) session. Nothing is
            // being painted, so there is no arm to switch; said rather than
            // ignored, because a silent no-op here is how a bag key gets
            // believed.
            arArmReason =
                "poseSource 'ar' was sent to a RECORDING session (live:false). There is no " +
                    "engine to feed, so the option is inert; the ARCore channel, if requested, " +
                    "still writes its reference series."
        }

        // ── THE AR-PLUGIN ARM: no camera of ours, and no ARCore of ours ──
        // The stitcher owns the ARCore session and the camera; we consume its
        // frames through PanoPlusArFramePlugin. Checked BEFORE standalone
        // because it needs neither an ARCore channel nor a Camera2 client, and
        // reaching either branch below would open one.
        //
        // ⚠ AND ONLY ON THE AR POSE ARM. Shipped once without this second
        // condition (2026-09-10) and it broke NON-AR capture outright: the
        // field flag is on by default, so an IMU sweep also took this branch,
        // opened no camera, and sat waiting for frames from a plugin whose AR
        // view the surface had correctly declined to mount. The operator:
        // "Even I switch off AR, I only see the AR tracking message and nothing
        // gets captured!!!!" A flag that selects an ARM must be read together
        // with the arm, never on its own.
        if (cfg.arPluginArm && cfg.livePoseSource == "ar") {
            return startArPluginArm(promise)
        }

        // ── STANDALONE: no Camera2 client of ours at all ────────────────
        if (arcore?.modeRan == "standalone") {
            return startStandalone(promise)
        }

        val cameraManager = ctx.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            ?: return fail(promise, "no-camera-service", "CAMERA_SERVICE is unavailable.")
        mgr = cameraManager

        // ── Pick the camera ─────────────────────────────────────────────
        val ids = try { cameraManager.cameraIdList } catch (t: Throwable) {
            return fail(
                promise, "camera-enumeration-failed",
                "getCameraIdList threw: ${t.javaClass.simpleName}: ${t.message}",
            )
        }
        if (ids.isEmpty()) {
            return fail(promise, "no-cameras", "the device reports no cameras.")
        }
        val infos = ArrayList<CamInfo>()
        for (id in ids) {
            try { infos += readCamInfo(cameraManager, id) } catch (t: Throwable) {
                advise("camera $id could not be characterised (${t.javaClass.simpleName}) — skipped")
            }
        }
        if (infos.isEmpty()) {
            return fail(
                promise, "no-characterisable-camera",
                "every camera refused getCameraCharacteristics; see logcat.",
            )
        }

        // ARCore's shared-camera id OUTRANKS both the option and the
        // widest-FOV rule: in shared mode the capture session is ARCore's to
        // join, and opening a different camera would simply fail to configure.
        val forcedCamId = arcore?.forcedCameraId()
        if (forcedCamId != null && cfg.cameraId != null && forcedCamId != cfg.cameraId) {
            advise(
                "the cameraId option '${cfg.cameraId}' was OVERRIDDEN by ARCore's shared-camera " +
                    "id '$forcedCamId'. ARCore chooses the camera in shared mode; a sweep on " +
                    "the requested camera needs arcoreReference:'off'.",
            )
        }
        val effectiveCameraId = forcedCamId ?: cfg.cameraId
        forcedCameraIdByArCore = forcedCamId
        // GROUND TRUTH FOR THE NEXT IDLE VIEWFINDER. Everything before this
        // point is ARCore's answer for a session that is actually about to run;
        // handing it to the hint means the operator's NEXT framing is through
        // the lens this sweep proved, not through a probe's prediction of it.
        PanoPlusArCoreCameraHint.observed(forcedCamId, arcore?.forcedImageSize())
        // RUN THE RECORDER'S OWN RULE EVEN WHEN IT IS ABOUT TO BE OVERRIDDEN.
        // `selection.rule` has to be able to say what was NOT taken; deriving
        // that after the fact is impossible once `chosen` holds ARCore's pick.
        run {
            val backs = infos.filter { it.facing == CameraCharacteristics.LENS_FACING_BACK }
            val pool = backs.ifEmpty { infos }
            val widest = pool
                .filter { it.hFovDeg.isFinite() && it.yuvSizes.isNotEmpty() }
                .maxByOrNull { it.hFovDeg }
            wouldHaveCameraId = widest?.id
            wouldHaveHFovDeg = widest?.hFovDeg ?: Double.NaN
        }

        var pick: CamInfo?
        if (effectiveCameraId != null) {
            pick = infos.firstOrNull { it.id == effectiveCameraId }
            if (pick == null) {
                return fail(
                    promise, "camera-not-found",
                    "cameraId '$effectiveCameraId' is not in ${infos.map { it.id }}" +
                        (if (forcedCamId != null) " (it was ARCore's shared-camera id)" else "") +
                        ".",
                )
            }
        } else if (lensRequested != null) {
            // ── THE CHIP'S LENS (2026-09-03) ────────────────────────────
            // 1x = the wide-band back camera, 0.5x = the ultra-wide one, by
            // vision-camera's own hFOV bands — the rule Pano's chip runs on
            // this same screen, so "0.5x" is the same lens on both segments.
            // `PanoPlusIdlePreviewSession.pickCamera` runs this identical
            // function, which is what makes the viewfinder's framing the
            // sweep's framing. A device with no lens in the requested band
            // runs the other one and SAYS so (`lensHonoured` false).
            val lp = pickCameraForLens(
                infos.mapIndexed { i, c -> c.toLensCandidate(i) }, lensRequested,
            ) ?: return fail(
                promise, "no-yuv-camera",
                "no camera advertises a YUV_420_888 output size.",
            )
            pick = infos.firstOrNull { it.id == lp.id }
            if (pick == null) {
                return fail(
                    promise, "camera-not-found",
                    "the lens rule chose camera '${lp.id}', which is not in " +
                        "${infos.map { it.id }} — this cannot happen; see logcat.",
                )
            }
            lensNote = lp.why
            if (!lp.honoured) advise("lens: ${lp.why}")
        } else {
            val backs = infos.filter { it.facing == CameraCharacteristics.LENS_FACING_BACK }
            val pool = backs.ifEmpty {
                advise("no LENS_FACING_BACK camera found — selecting across ALL facings")
                infos
            }
            val withFov = pool.filter { it.hFovDeg.isFinite() && it.yuvSizes.isNotEmpty() }
            pick = withFov.maxByOrNull { it.hFovDeg }
            if (pick == null) {
                // No camera exposed focal length + physical size. Fall back to
                // the first with a usable YUV stream and SAY SO — a widest-FOV
                // claim without the numbers behind it would be a fiction.
                pick = pool.firstOrNull { it.yuvSizes.isNotEmpty() }
                if (pick == null) {
                    return fail(
                        promise, "no-yuv-camera",
                        "no camera advertises a YUV_420_888 output size.",
                    )
                }
                advise(
                    "widest-FOV selection was NOT possible (no camera exposed both " +
                        "LENS_INFO_AVAILABLE_FOCAL_LENGTHS and SENSOR_INFO_PHYSICAL_SIZE); " +
                        "fell back to camera ${pick.id}, the first with a YUV stream",
                )
            }
        }
        val cam = pick!!
        chosen = cam
        sensorOrientation = cam.chars.get(CameraCharacteristics.SENSOR_ORIENTATION)

        // ── Logical multi-camera → bind a PHYSICAL id where possible ────
        var openId = cam.id
        var characteristics = cam.chars
        // ⚠ NO PHYSICAL BINDING UNDER SHARED CAMERA. ARCore's session is
        // configured against the LOGICAL camera it named; re-pointing the
        // stream at a physical sub-camera would change the very intrinsics
        // ARCore's poses are expressed in, and the two halves of the A/B would
        // then describe different lenses.
        //
        // ⚠ AND NONE UNDER A 1x REQUEST. Both physical routes below choose the
        // WIDEST physical sub-camera, which on a logical multi-camera is the
        // ultra-wide — binding it would turn the operator's 1x into a 0.5x
        // after the lens rule had just chosen the 1x. The logical stream IS
        // the 1x on every such device. (SM-A356U1 exposes no logical
        // multi-camera, so this branch is stated, not measured.)
        val allowPhysical = cfg.preferPhysical && forcedCamId == null &&
            lensRequested != PanoPlusLens.WIDE
        if (cfg.preferPhysical && forcedCamId != null && cam.logicalPhysicalIds.isNotEmpty()) {
            physicalBindRoute =
                "logical multi-camera; physical binding SUPPRESSED because ARCore's " +
                    "shared-camera session is configured against the logical camera"
            advise(physicalBindRoute)
        }
        if (allowPhysical && cam.logicalPhysicalIds.isNotEmpty()) {
            // Route 1: the physical id is independently openable (it is in the
            // id list) — open it directly. Cleanest: its own characteristics,
            // its own intrinsics, its own results, no per-stream binding.
            val direct = cam.logicalPhysicalIds
                .filter { ids.contains(it) }
                .mapNotNull { id -> try { readCamInfo(cameraManager, id) } catch (_: Throwable) { null } }
                .filter { it.yuvSizes.isNotEmpty() }
                .maxByOrNull { if (it.hFovDeg.isFinite()) it.hFovDeg else -1.0 }
            if (direct != null) {
                openId = direct.id
                characteristics = direct.chars
                boundPhysicalId = direct.id
                physicalBindRoute = "direct-physical-open (physical id is in getCameraIdList)"
                chosen = direct
                sensorOrientation = direct.chars.get(CameraCharacteristics.SENSOR_ORIENTATION)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                // Route 2: bind the stream to a physical id on the LOGICAL
                // device (API 28+). The device stays logical; the stream is
                // physical.
                val hidden = cam.logicalPhysicalIds
                    .mapNotNull { id ->
                        try { id to cameraManager.getCameraCharacteristics(id) }
                        catch (_: Throwable) { null }
                    }
                    .mapNotNull { (id, c) ->
                        val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                        val sizes = map?.getOutputSizes(ImageFormat.YUV_420_888)?.toList()
                        if (sizes.isNullOrEmpty()) null else Triple(id, c, sizes)
                    }
                    .maxByOrNull { (_, c, _) ->
                        val f = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                            ?.filter { it > 0f }?.minOrNull()
                        val p = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
                        if (f != null && p != null)
                            2.0 * Math.toDegrees(Math.atan(p.width / (2.0 * f))) else -1.0
                    }
                if (hidden != null) {
                    boundPhysicalId = hidden.first
                    characteristics = hidden.second
                    physicalBindRoute =
                        "logical + OutputConfiguration.setPhysicalCameraId (API " +
                            "${Build.VERSION.SDK_INT})"
                } else {
                    physicalBindRoute =
                        "logical multi-camera, but no physical id exposed a YUV stream — " +
                            "recording the LOGICAL stream"
                    advise(physicalBindRoute)
                }
            } else {
                physicalBindRoute =
                    "logical multi-camera, but API ${Build.VERSION.SDK_INT} < 28 has no " +
                        "setPhysicalCameraId — recording the LOGICAL stream"
                advise(physicalBindRoute)
            }
        } else if (cam.logicalPhysicalIds.isNotEmpty()) {
            if (forcedCamId == null) {
                physicalBindRoute =
                    if (cfg.preferPhysical && lensRequested == PanoPlusLens.WIDE) {
                        "logical multi-camera; physical binding SKIPPED because the 1x lens " +
                            "was requested — the widest physical sub-camera is the 0.5x, and " +
                            "the logical stream is the 1x"
                    } else {
                        "logical multi-camera; physical binding disabled by option"
                    }
                if (lensRequested == PanoPlusLens.WIDE) advise(physicalBindRoute)
            }
        } else {
            physicalBindRoute = "not a logical multi-camera (no physical binding needed)"
        }
        effChars = characteristics

        // ── WHICH LENS RAN, by band, from the camera that will be OPENED ──
        // After the physical binding, not before it: route 1 re-points
        // `chosen` at a physical sub-camera with its own hFOV. Written for
        // every sweep so the pack can never be silent about its lens.
        run {
            val opened = chosen ?: cam
            val ran = panoLensOf(opened.hFovDeg)
            lensRan = ran
            lensHonoured = lensRequested != null && ran == lensRequested
            val band = "${panoLensBand(opened.hFovDeg)} band, " +
                (if (opened.hFovDeg.isFinite())
                    String.format(Locale.US, "%.1f", opened.hFovDeg) + "° hFOV"
                else "hFOV unknown")
            when {
                forcedCamId != null -> lensNote =
                    "ARCore's shared-camera CameraConfig FORCED camera ${opened.id} " +
                        "(${ran.label}: $band). " +
                        (if (lensRequested != null)
                            "The requested ${lensRequested.label} lens was IGNORED on this " +
                                "arm — the capture session is ARCore's to configure."
                        else
                            "No lens was requested (the SDK sends none on the AR arm) and " +
                                "none could have been honoured — the session is ARCore's.")
                cfg.cameraId != null -> lensNote =
                    "the explicit cameraId option chose camera ${opened.id} " +
                        "(${ran.label}: $band)" +
                        (if (lensRequested != null)
                            "; it outranks the requested ${lensRequested.label} lens"
                        else "; no lens was requested")
                lensRequested == null -> lensNote =
                    "no lens was requested; the shipped widest-FOV rule chose camera " +
                        "${opened.id} (${ran.label}: $band)"
                // else: the lens rule's own sentence, set where it ran.
            }
            if (forcedCamId != null && lensRequested != null) advise("lens: $lensNote")
        }

        // ── Output size: the largest 4:3 YUV_420_888 ────────────────────
        val effMap = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = effMap?.getOutputSizes(ImageFormat.YUV_420_888)?.toList() ?: emptyList()
        if (sizes.isEmpty()) {
            return fail(
                promise, "no-yuv-sizes",
                "camera $openId advertises no YUV_420_888 output sizes.",
            )
        }
        val capped = if (cfg.maxWidth > 0) sizes.filter { it.width <= cfg.maxWidth } else sizes
        val pool = capped.ifEmpty {
            advise(
                "maxWidth=${cfg.maxWidth} excluded every YUV size " +
                    "(${sizes.joinToString { it.toString() }}) — the cap was ignored",
            )
            sizes
        }
        val even = pool.filter { it.width % 2 == 0 && it.height % 2 == 0 }
        val fourThree = even.filter {
            it.height > 0 && Math.abs(it.width.toDouble() / it.height - 4.0 / 3.0) < 0.01
        }
        val shortlist = fourThree.ifEmpty { even }
        if (shortlist.isEmpty()) {
            return fail(
                promise, "no-even-yuv-size",
                "no YUV_420_888 size with even dimensions; sizes were " +
                    sizes.joinToString { it.toString() },
            )
        }

        // ── ASK WHAT EACH SIZE CAN SUSTAIN, THEN TAKE THE BIGGEST ───────
        // "Largest" alone answers the wrong question. SCALER_STREAM_CONFIGU-
        // RATION_MAP publishes a MINIMUM FRAME DURATION per size, and on every
        // phone the top few sizes carry a duration that caps the stream well
        // below the AE range's ceiling — a 4000x3000 output that can only be
        // clocked at 10 fps no matter what CONTROL_AE_TARGET_FPS_RANGE says.
        // A sweep at 10 fps aliases the shelf, and nothing in the resulting
        // pack would attribute that to the size that caused it. So the rate
        // the HAL publishes for a size is part of choosing it.
        val rated: List<Pair<Size, Long>> = shortlist.map { s ->
            s to (
                try {
                    effMap?.getOutputMinFrameDuration(ImageFormat.YUV_420_888, s) ?: -1L
                } catch (_: Throwable) {
                    -1L
                }
                )
        }
        // A size with NO published duration is excluded from the rate rungs
        // rather than assumed fast: silence is not evidence of speed. It is
        // still eligible for the final largest-of-everything fallback.
        fun largestAtLeast(targetFps: Double): Size? = rated
            .filter { (_, ns) ->
                val fps = PanoPlusProbeMath.maxFpsFromMinFrameDuration(ns)
                fps != null && fps >= targetFps * (1.0 - PanoPlusProbeMath.FPS_TOLERANCE_FRAC)
            }
            .maxByOrNull { (s, _) -> s.width.toLong() * s.height }
            ?.first

        val wantFps = cfg.preferFps
        val atPreferred = largestAtLeast(wantFps.toDouble())
        val atThirty = if (wantFps > 30) largestAtLeast(30.0) else null
        // ARCore's CPU image size is NOT a preference in shared mode: the
        // ImageReader has to be exactly the size ARCore's CameraConfig
        // declares, or the shared capture session will not configure. The
        // whole rate ladder above is therefore computed and then OVERRIDDEN,
        // and both answers go into device.json so the pack says what the
        // recorder would have chosen on its own.
        val forcedSize = arcore?.forcedImageSize()
        val size = forcedSize
            ?: atPreferred
            ?: atThirty
            ?: shortlist.maxByOrNull { it.width.toLong() * it.height }!!
        val chosenDurNs = rated.firstOrNull { it.first == size }?.second ?: -1L
        val chosenFps = PanoPlusProbeMath.maxFpsFromMinFrameDuration(chosenDurNs)
        val aspectWord = if (fourThree.isEmpty()) "non-4:3" else "4:3"
        val rateWord = chosenFps?.let { String.format(Locale.US, "%.1f fps", it) }
            ?: "no published minimum frame duration"
        sizeChoiceReason = when {
            atPreferred != null ->
                "largest $aspectWord YUV_420_888 size whose SCALER minimum frame duration " +
                    "reaches the preferred ${wantFps}fps ($rateWord)"
            atThirty != null ->
                "NO $aspectWord size reaches the preferred ${wantFps}fps; took the largest that " +
                    "reaches 30fps ($rateWord). 60fps is a motion-blur defence, not an engine " +
                    "requirement — sweep more slowly"
            else ->
                "no $aspectWord size published a minimum frame duration reaching 30fps (or any " +
                    "at all), so the rate could not inform the choice — fell back to the " +
                    "LARGEST $aspectWord size, whose published rate is $rateWord"
        } + " · maxWidth cap " +
            (if (cfg.maxWidth > 0) "${cfg.maxWidth}px" else "none (explicitly lifted)") +
            " · ${shortlist.size} of ${sizes.size} advertised sizes were eligible"
        if (forcedSize != null) {
            val wouldHave = (atPreferred ?: atThirty
                ?: shortlist.maxByOrNull { it.width.toLong() * it.height })
            sizeChoiceReason =
                "FORCED to ${forcedSize.width}x${forcedSize.height} by ARCore's CameraConfig " +
                    "(shared-camera mode: the app's ImageReader must match ARCore's CPU image " +
                    "size or the shared session will not configure). Without ARCore this " +
                    "recorder would have chosen ${wouldHave?.width}x${wouldHave?.height} — " +
                    sizeChoiceReason
            advise(
                "output size $sizeChoiceReason. This is the price of the same-pixels A/B and " +
                    "it is a REAL confound against every earlier pack: read the raster before " +
                    "comparing canvases.",
            )
        }
        if (fourThree.isEmpty()) {
            advise(
                "NO 4:3 YUV_420_888 size exists on camera $openId; recorded " +
                    "${size.width}x${size.height} " +
                    "(aspect ${String.format(Locale.US, "%.4f", size.width.toDouble() / size.height)}) instead — " +
                    "the pack is still replayable, but it is NOT the iOS 4:3 regime",
            )
        }
        if (atPreferred == null) advise("output size: $sizeChoiceReason")
        outSize = size
        chosenSizeMinFrameDurationNs = chosenDurNs
        chosenSizeMaxFps = chosenFps ?: Double.NaN
        if (size.width > DEFAULT_MAX_WIDTH) {
            advise(
                "output is ${size.width}x${size.height}, ${String.format(Locale.US, "%.2f", size.width.toDouble() / DEFAULT_MAX_WIDTH)}x " +
                    "the iOS reference width (1920x1440). JPEG encode cost scales with " +
                    "pixels and this recorder drops any frame that arrives while the " +
                    "encoder is busy (counted as droppedBusy). Read " +
                    "timings.encodeMs / counts.droppedBusy in device.json before the " +
                    "second sweep; pass maxWidth:1920 to match the iOS regime.",
            )
        }

        // ── fps range ───────────────────────────────────────────────────
        val ranges = characteristics.get(
            CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES,
        )?.toList() ?: emptyList()
        // A FIXED range (lower == upper) is preferred over a variable one at
        // the same ceiling: a variable range lets AE lengthen the exposure in
        // dim aisles, and a long exposure on a moving phone is motion blur —
        // which is the whole reason 60 is wanted. 60 is a blur DEFENCE, not
        // an engine requirement, so 30 is accepted and recorded as such.
        val want = cfg.preferFps
        // ⚠ ONE SELECTOR, AND IT LIVES IN `PanoPlusProbeMath` (2026-09-07).
        // The rule is unchanged — fixed ranges first (they stop AE lengthening
        // the exposure in a dim aisle), then the lowest ceiling that still
        // meets `want`, else the highest ceiling there is — but it is no
        // longer written HERE. `PanoPlusIdlePreviewSession` has to request the
        // same range this sweep will, or the operator frames through one rate
        // and records at another; a second copy of these two lambdas is how
        // that becomes true again the first time either moves. Same move, same
        // reason, as `largestAtLeastFps` for the size ladder just above.
        fpsRange = PanoPlusProbeMath
            .pickAeFpsRange(ranges.map { it.toProbeFpsRange() }, want)
            ?.toAndroidRange()
        fpsRequestedNote = when {
            ranges.isEmpty() ->
                "CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES is unavailable — no range requested"
            fpsRange == null -> "no range could be chosen"
            fpsRange!!.upper >= want ->
                "requested ${fpsRange} (>= preferred ${want}fps)"
            else ->
                "NO range reaches ${want}fps on this camera; requested ${fpsRange} instead — " +
                    "60fps is a motion-blur defence, not an engine requirement, so the sweep " +
                    "proceeds. Sweep more slowly."
        }
        if (fpsRange != null && fpsRange!!.upper < want) advise(fpsRequestedNote)

        // ── Files ───────────────────────────────────────────────────────
        try { openPack() } catch (t: Throwable) {
            return fail(
                promise, "pack-open-failed",
                "could not create the pack under '${cfg.sessionDir ?: "(default)"}': " +
                    "${t.javaClass.simpleName}: ${t.message}",
            )
        }

        // ── Intrinsics, constant part ───────────────────────────────────
        computeConstantIntrinsics(characteristics, size)

        // ── THE LIVE ENGINE ─────────────────────────────────────────────
        // Opened AFTER the pack directory exists (it writes ledger.jsonl and
        // preview.jpg into it) and BEFORE any frame can arrive — the reader is
        // created further down and `state` only reaches ST_RECORDING at the
        // end of lockAndRecord, so there is no window in which a frame finds a
        // half-built session.
        //
        // ⚠ A LIVE START THAT FAILS DOES NOT FAIL THE SWEEP. The recorder is a
        // complete capture arm on its own; a stale .so or a bad knob must cost
        // the operator the live canvas, not the pack. The reason is recorded,
        // returned in `start()`'s payload, polled in `status()` and written to
        // device.json, so the panel can say WHY the canvas is missing instead
        // of showing an empty box.
        if (cfg.live) startLiveEngine()

        // ── The attitude MAP's two gates, resolved ONCE ─────────────────
        // Here and not in writeFrame: every row of a pack must be built on one
        // basis and one clock verdict, or its quaternions are not comparable
        // with each other. Both answers, and the reasoning behind both, go
        // into device.json whichever way they fall.
        resolveAttitudeMapping(characteristics)

        // ── IMU first: attitude BEFORE the first frame, never after ─────
        startImu()

        // ── Reader ──────────────────────────────────────────────────────
        val ir = ImageReader.newInstance(
            size.width, size.height, ImageFormat.YUV_420_888, cfg.readerMaxImages,
        )
        reader = ir
        nv21 = ByteArray(size.width * size.height * 3 / 2)
        ir.setOnImageAvailableListener({ r -> onImages(r) }, readerH)

        // ── Watchdog: a device that never calls back must REJECT ────────
        camH.postDelayed({
            if (state.get() == ST_OPENING || state.get() == ST_SETTLING) {
                val where = if (state.get() == ST_OPENING) "open/configure" else "AE settle"
                fail(
                    promise, "camera-timeout",
                    "camera $openId did not reach recording within " +
                        "${cfg.openTimeoutMs.toLong()}ms (stuck in $where). Nothing was " +
                        "recorded; the session has been torn down.",
                )
            }
        }, cfg.openTimeoutMs.toLong() + cfg.settleCeilingMs.toLong() + 2000L)

        // ── The VIEWFINDER, claimed before the session is configured ────
        // Camera2 fixes a session's outputs at createCaptureSession, so this
        // is the last moment a preview can join. A surface that is not mounted
        // yet means a HEADLESS sweep — recorded, reported, and far better than
        // a refused one.
        previewSurface = claimPreviewSurface(characteristics, size)

        // ── ARCore must know about the app's surface BEFORE the open ────
        // `Session.resume()` installs ARCore's OWN repeating request over the
        // shared session; a surface ARCore has not been told about is simply
        // not a target of that request, and frames stop arriving the instant
        // ARCore resumes — which looks exactly like a dead camera.
        //
        // The preview goes in the SAME list for the same reason: in shared
        // mode ARCore's request is the one that runs, so a preview it has not
        // been told about would configure fine and stay black forever.
        arcore?.setAppSurfaces(openId, appSurfaces(ir))

        // ── Open ────────────────────────────────────────────────────────
        try {
            val stateCb = object : CameraDevice.StateCallback() {
                override fun onOpened(d: CameraDevice) {
                    device = d
                    try { configureSession(d, ir, promise) } catch (t: Throwable) {
                        fail(
                            promise, "session-configure-threw",
                            "configuring the capture session threw: " +
                                "${t.javaClass.simpleName}: ${t.message}",
                        )
                    }
                }
                override fun onDisconnected(d: CameraDevice) {
                    abortReason = "camera-disconnected"
                    fail(
                        promise, "camera-disconnected",
                        "camera $openId was DISCONNECTED — this session was evicted by another " +
                            "camera client. Within this app the usual culprit is the capture " +
                            "shell's own viewfinder reconnecting behind the panel: Android " +
                            "allows one client per back camera, so whoever opens second wins " +
                            "and the loser is torn down mid-sweep. Also fires when another app " +
                            "takes the camera or the device is unplugged.",
                    )
                }
                override fun onError(d: CameraDevice, error: Int) {
                    abortReason = "camera-error-$error"
                    fail(
                        promise, "camera-error-$error",
                        "CameraDevice.StateCallback.onError($error) on camera $openId: " +
                            cameraErrorName(error),
                    )
                }
            }
            // ⚠ ARCore's WRAPPER, not the callback above, when a shared
            // session is running: ARCore needs the CameraDevice the moment it
            // opens in order to attach its own surfaces to it. Passing the
            // bare callback leaves ARCore holding no device, and its resume()
            // then fails with a message that says nothing about this line.
            cameraManager.openCamera(openId, arcore?.wrapDeviceStateCallback(stateCb, camH)
                ?: stateCb, camH)
        } catch (e: CameraAccessException) {
            fail(
                promise, "camera-access-denied",
                "openCamera($openId) threw CameraAccessException " +
                    "reason=${e.reason} (${accessReasonName(e.reason)}): ${e.message}",
            )
        } catch (e: SecurityException) {
            fail(
                promise, "permission-denied",
                "openCamera($openId) threw SecurityException — the CAMERA permission was " +
                    "revoked between the check and the open: ${e.message}",
            )
        } catch (t: Throwable) {
            fail(
                promise, "open-failed",
                "openCamera($openId) threw ${t.javaClass.simpleName}: ${t.message}",
            )
        }
    }

    /**
     * STANDALONE mode: ARCore owns the camera and this recorder opens none.
     *
     * ⚠ THIS PACK HAS NO PIXELS, and that is the entire difference between it
     * and a shared-camera pack. It is a complete answer to the BASIS question
     * — the rotation-vector series and the ARCore series run simultaneously,
     * which is all `selectBasis()` needs — and it is NOT the pose-arm A/B,
     * because there are no frames to replay twice. `device.json` says so in
     * `arcore.modeMeaning` and `purpose`, and `counts.framesWritten` is 0 by
     * construction rather than by failure.
     *
     * Everything else the recorder does is unchanged: the pack directory, the
     * sensors ledger, the clock evidence and the advisories are the same code
     * paths, which is why this branch is eleven lines rather than a second
     * recorder.
     */
    /**
     * Start a sweep that consumes the STITCHER'S ARCore frames.
     *
     * No Camera2 client, no ARCore session, no preview Surface, no pose ring —
     * the host's AR camera view owns all of that and the pose arrives with the
     * pixels. What the recorder still owns is the PACK: the ledger, the canvas,
     * the device.json and the rotation-vector sidecar, so an AR sweep remains
     * as diagnosable as every other arm.
     *
     * The IMU still runs. It drives nothing on this arm — the attitude comes
     * from ARCore, per frame — but sensors.jsonl is what lets ONE pack be
     * replayed on BOTH arms offline, which is the only way to compare them
     * without confounding the arm with the gesture.
     */
    private fun startArPluginArm(promise: Promise) {
        if (!cfg.live) {
            return fail(
                promise, "ar-plugin-needs-live",
                "the AR-plugin arm feeds the LIVE engine and nothing else: there is no Camera2 " +
                    "stream on it, so a recording-only session would write an empty pack. Send " +
                    "live:true, or use a camera arm to record frames.",
            )
        }
        try { openPack() } catch (t: Throwable) {
            return fail(
                promise, "pack-open-failed",
                "could not create the pack under '${cfg.sessionDir ?: "(default)"}': " +
                    "${t.javaClass.simpleName}: ${t.message}",
            )
        }
        startImu()
        intrinsicsSource = "arcore-per-frame (the stitcher's session)"
        intrinsicsNote =
            "ARCore owns the camera on this arm and hands the engine its OWN per-frame " +
                "intrinsics alongside the pixels, so there are no Camera2 rows here and no " +
                "derived focal length. This is the same shape the iOS ARKit arm has always had."
        startLiveEngine()
        if (liveStartError != null) {
            return fail(
                promise, "live-start-failed",
                "the engine refused to start: $liveStartError",
            )
        }
        PanoPlusArFramePlugin.shared.arm()
        // Set WITH the arm, never apart from it: arm() is what zeroes the
        // counters, so the flag that says "these counters are mine" and the
        // zeroing are one action. See [arPluginArmActive].
        arPluginArmActive = true
        arArmReason =
            "AR-PLUGIN ARM: pano+ is registered on the stitcher's own ARCore session " +
                "(ARFramePlugin '${PanoPlusArFramePlugin.NAME}'). No Camera2 client and no " +
                "ARCore session of ours exists on this arm, so there is no shared-camera " +
                "handover, no bootstrap race and no pose ring."
        advise(arArmReason)
        state.set(ST_RECORDING)
        CoroutineScope(Dispatchers.IO).launch { writeDeviceJson("recording-started") }
        settleResolve(promise)
    }

    private fun startStandalone(promise: Promise) {
        try { openPack() } catch (t: Throwable) {
            return fail(
                promise, "pack-open-failed",
                "could not create the pack under '${cfg.sessionDir ?: "(default)"}': " +
                    "${t.javaClass.simpleName}: ${t.message}",
            )
        }
        // The IMU FIRST, exactly as in the camera path: the rotation-vector
        // series has to be running before the first ARCore pose, or the
        // earliest reference samples have nothing to be bracketed by and
        // selectBasis silently fits over fewer pairs.
        startImu()
        intrinsicsSource = "not-applicable (no Camera2 stream in standalone mode)"
        intrinsicsNote =
            "ARCore owns the camera in this mode; the recorder wrote no frames, so there are " +
                "no per-row intrinsics. ARCore's own image intrinsics are in the arcore block."
        arcore?.startPump({ row -> writeArCoreRow(row) }, null)
        state.set(ST_RECORDING)
        CoroutineScope(Dispatchers.IO).launch { writeDeviceJson("recording-started") }
        settleResolve(promise)
    }

    /** `CameraAccessException.reason`, named — the same contention story as
     *  [cameraErrorName], arriving through the throw path instead. */
    private fun accessReasonName(r: Int): String = when (r) {
        CameraAccessException.CAMERA_IN_USE ->
            "CAMERA_IN_USE — another client in this process or on this device already holds " +
                "the camera; close the capture shell's viewfinder first"
        CameraAccessException.MAX_CAMERAS_IN_USE ->
            "MAX_CAMERAS_IN_USE — at the device's concurrent-camera limit; close the other " +
                "camera client in this process first"
        CameraAccessException.CAMERA_DISABLED -> "CAMERA_DISABLED (device policy)"
        CameraAccessException.CAMERA_DISCONNECTED -> "CAMERA_DISCONNECTED"
        CameraAccessException.CAMERA_ERROR -> "CAMERA_ERROR (device in a fatal error state)"
        else -> "unrecognised"
    }

    /**
     * The error code AND the thing the operator has to do about it.
     *
     * The two contention codes are named at length on purpose. Android permits
     * exactly one client on a back camera, and the host app that shows this
     * recorder's panel is a CAMERA app: if any viewfinder is still mounted
     * behind the panel, the arbitration goes one of two ways and BOTH read as
     * "the pano+ Android recorder is broken" from a bare integer. Either this
     * open is refused (IN_USE / MAX_CAMERAS_IN_USE), or the other client is
     * evicted, reconnects, and evicts THIS session mid-sweep — which arrives
     * as onDisconnected several seconds into a pack that then ends early.
     */
    /**
     * HOW FAR THE TWO ATTITUDE SERIES DRIFTED APART ACROSS THIS SWEEP, in
     * degrees, and the same divided by the elapsed seconds.
     *
     * The two differ ONLY by the magnetometer, so the relative rotation between
     * them is exactly the quantity in dispute. On the mag-fused arm it is the
     * compass pull that keystones the band (measured 7-23 deg across 11 A35
     * packs on 2026-09-10). On the mag-free arm it is the gyro yaw drift that is
     * the price of removing that pull, and which nothing here had ever measured.
     *
     * It is the SAME number on both arms, which is the point: whichever series
     * drives, the pack now carries the size of the trade, so the default can be
     * decided from the operator's own captures instead of from one borrowed
     * window of ARCore data.
     *
     * Returns [degrees, degPerSecond], or null when the pack never held a
     * matched pair (a device with no game vector, most likely).
     */
    private fun headingDivergence(): DoubleArray? {
        val a = divFirst ?: return null
        val b = divLast ?: return null
        fun rel(m: ImuSample, g: ImuSample): DoubleArray {
            // q = conj(game) * mag, the rotation taking one series onto the other
            val gx = -g.x.toDouble(); val gy = -g.y.toDouble()
            val gz = -g.z.toDouble(); val gw = g.w.toDouble()
            val mx = m.x.toDouble(); val my = m.y.toDouble()
            val mz = m.z.toDouble(); val mw = m.w.toDouble()
            return doubleArrayOf(
                gw * mx + gx * mw + gy * mz - gz * my,
                gw * my - gx * mz + gy * mw + gz * mx,
                gw * mz + gx * my - gy * mx + gz * mw,
                gw * mw - gx * mx - gy * my - gz * mz,
            )
        }
        val q0 = rel(a.first, a.second)
        val q1 = rel(b.first, b.second)
        // The CHANGE in the disagreement, not its absolute value: a constant
        // offset between the two series is a basis/datum difference and is
        // harmless, because the engine only ever uses relative rotation. What
        // leans a band is the part that GROWS during the sweep.
        val d = doubleArrayOf(
            q0[3] * q1[0] - q0[0] * q1[3] - q0[1] * q1[2] + q0[2] * q1[1],
            q0[3] * q1[1] + q0[0] * q1[2] - q0[1] * q1[3] - q0[2] * q1[0],
            q0[3] * q1[2] - q0[0] * q1[1] + q0[1] * q1[0] - q0[2] * q1[3],
            q0[3] * q1[3] + q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2],
        )
        val w = kotlin.math.abs(d[3]).coerceIn(-1.0, 1.0)
        val deg = Math.toDegrees(2.0 * kotlin.math.acos(w))
        val secs = (b.first.tsNs - a.first.tsNs) / 1e9
        return doubleArrayOf(deg, if (secs > 0.05) deg / secs else 0.0)
    }

    private fun cameraErrorName(e: Int): String = when (e) {
        CameraDevice.StateCallback.ERROR_CAMERA_IN_USE ->
            "ERROR_CAMERA_IN_USE — ANOTHER CLIENT ALREADY HOLDS THIS CAMERA. On this app that " +
                "is almost always the capture shell's own viewfinder: Android allows one " +
                "client per back camera, so the host must UNMOUNT its camera surface (and let " +
                "the HAL close) before the pano+ recorder opens one."
        CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE ->
            "ERROR_MAX_CAMERAS_IN_USE — the device is already at its concurrent-camera limit. " +
                "Same cause and same fix as ERROR_CAMERA_IN_USE: close the other camera client " +
                "in this process first."
        CameraDevice.StateCallback.ERROR_CAMERA_DISABLED ->
            "ERROR_CAMERA_DISABLED (device policy has disabled the camera)"
        CameraDevice.StateCallback.ERROR_CAMERA_DEVICE -> "ERROR_CAMERA_DEVICE (fatal, device)"
        CameraDevice.StateCallback.ERROR_CAMERA_SERVICE -> "ERROR_CAMERA_SERVICE (fatal, service)"
        else -> "unrecognised"
    }

    // ════════════════════════════════════════════════════════════════════
    //  Session configuration + the AE/AWB settle ladder
    // ════════════════════════════════════════════════════════════════════

    /**
     * Pick a preview buffer size and take the mounted viewfinder's surface.
     *
     * ⚠ THE SIZE MUST COME FROM THE CAMERA, NOT FROM THE VIEW. A
     * `SurfaceTexture` defaults its buffers to the TextureView's pixel
     * dimensions, which is an arbitrary number the HAL never published — and
     * an unpublished size is where `createCaptureSession` either silently
     * substitutes one or refuses the whole configuration. So the size is read
     * from SCALER_STREAM_CONFIGURATION_MAP for `SurfaceTexture`, matched to
     * the RECORDING aspect (a preview at a different aspect would show the
     * operator a framing the pack does not have) and capped at 1080p, which is
     * every device's guaranteed PREVIEW maximum.
     */
    private fun claimPreviewSurface(
        characteristics: CameraCharacteristics, recording: Size,
    ): android.view.Surface? {
        val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = try {
            map?.getOutputSizes(SurfaceTexture::class.java)?.toList() ?: emptyList()
        } catch (t: Throwable) {
            advise("preview sizes unavailable (${t.javaClass.simpleName}) — recording headless")
            emptyList()
        }
        if (sizes.isEmpty()) {
            previewNote = "this camera publishes no SurfaceTexture output size, so no preview " +
                "surface can be configured — the sweep records headless"
            advise(previewNote)
            return null
        }
        val wantAspect = recording.width.toDouble() / recording.height
        val capped = sizes.filter { it.width <= 1920 && it.height <= 1080 }.ifEmpty { sizes }
        val matched = capped.filter {
            it.height > 0 && Math.abs(it.width.toDouble() / it.height - wantAspect) < 0.02
        }
        val chosenPreview = (matched.ifEmpty { capped })
            .maxByOrNull { it.width.toLong() * it.height } ?: return null
        previewSize = chosenPreview
        if (matched.isEmpty()) {
            advise(
                "no preview size matches the recording aspect " +
                    "(${recording.width}x${recording.height}); the viewfinder is " +
                    "$chosenPreview and therefore shows a DIFFERENT framing from the pack. " +
                    "Aim by the pack's aspect, not the screen's.",
            )
        }
        // ⚠ THE DISPLAY TRANSFORM'S TWO INPUTS, from the characteristics of the
        // camera THIS SESSION OPENED — never from a remembered field. In shared
        // ARCore mode the camera is ARCore's choice, not the recorder's, and a
        // transform built from the camera the recorder WANTED would rotate the
        // viewfinder against the stream it is actually showing.
        val s = PanoPlusPreview.claim(
            chosenPreview,
            characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0,
            characteristics.get(CameraCharacteristics.LENS_FACING)
                == CameraCharacteristics.LENS_FACING_FRONT,
        )
        previewNote = PanoPlusPreview.note
        if (s == null) advise("no viewfinder: $previewNote")
        return s
    }

    /** The app's own outputs — ImageReader first, preview second when one was
     *  claimed. One builder for the session, the repeating request and
     *  ARCore's `setAppSurfaces`, so the three can never disagree about what
     *  this session is targeting. */
    private fun appSurfaces(ir: ImageReader): List<android.view.Surface> {
        val out = ArrayList<android.view.Surface>(2)
        out += ir.surface
        previewSurface?.let { out += it }
        return out
    }

    private fun configureSession(
        d: CameraDevice, ir: ImageReader, promise: Promise, withPreview: Boolean = true,
    ) {
        val arCoreSurfaces = arcore?.arCoreSurfaces() ?: emptyList()
        // The preview is dropped for the RETRY pass only. `previewSurface`
        // itself is left alone until the retry actually reaches onConfigured,
        // because a session that failed may still be holding it.
        val preview = if (withPreview) previewSurface else null
        val rawCb = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                captureSession = s
                previewAttached = preview != null
                if (previewAttached) previewEverAttached = true
                PanoPlusPreview.setAttached(
                    previewAttached,
                    if (previewAttached) {
                        "attached to the capture session at " +
                            "${previewSize?.width}x${previewSize?.height}"
                    } else {
                        previewNote
                    },
                )
                try { beginSettle(d, s, promise) } catch (t: Throwable) {
                    fail(
                        promise, "settle-failed",
                        "starting the settle request threw: ${t.javaClass.simpleName}: ${t.message}",
                    )
                }
            }
            override fun onConfigureFailed(s: CameraCaptureSession) {
                // ⚠ A HEADLESS SWEEP BEATS NO SWEEP. The preview is a third
                // output on a configuration that may already be at the
                // device's limit — and in shared-camera mode the constraint is
                // ARCore's, not this recorder's ("the ImageReader must be
                // exactly ARCore's CPU image size and no other output may be
                // added"). So a refusal WITH a preview is retried ONCE
                // WITHOUT it, and the drop is named rather than inferred. Only
                // a refusal that survives the retry fails the sweep.
                if (preview != null) {
                    previewSurface = null
                    previewAttached = false
                    previewNote =
                        "the capture session was REFUSED with the preview attached and " +
                            "reconfigured WITHOUT it" +
                            (if (arcore != null)
                                " — expected in shared-camera mode, where ARCore's " +
                                    "CameraConfig fixes the outputs and a third surface may " +
                                    "not fit"
                            else " — this camera would not take a third output at " +
                                "${outSize?.width}x${outSize?.height} plus " +
                                "${previewSize?.width}x${previewSize?.height}") +
                            ". The sweep is recording HEADLESS: the pack is complete and " +
                            "replayable, and the operator is aiming blind."
                    advise(previewNote)
                    PanoPlusPreview.setAttached(false, previewNote)
                    try { s.close() } catch (_: Throwable) {}
                    // ARCore must be re-told: its app-surface list still names
                    // the preview, and resuming against a surface that is not
                    // in the session is the same black-preview fault in
                    // reverse.
                    try { arcore?.setAppSurfaces(d.id, appSurfaces(ir)) } catch (t: Throwable) {
                        Log.w(TAG, "re-declaring app surfaces without the preview threw", t)
                    }
                    try {
                        configureSession(d, ir, promise, withPreview = false)
                        return
                    } catch (t: Throwable) {
                        fail(
                            promise, "session-configure-threw",
                            "the preview-less retry threw: " +
                                "${t.javaClass.simpleName}: ${t.message}",
                        )
                        return
                    }
                }
                fail(
                    promise, "session-configure-failed",
                    "the camera refused the capture session for " +
                        "${outSize?.width}x${outSize?.height} YUV_420_888" +
                        (boundPhysicalId?.let { " bound to physical id $it" } ?: "") +
                        (if (arcore != null)
                            " WITH ARCore's ${arCoreSurfaces.size} shared surface(s) attached. " +
                                "A shared-camera configuration is far more constrained than a " +
                                "plain one — the ImageReader must be exactly ARCore's CPU " +
                                "image size and no other output may be added. Re-run with " +
                                "arcoreReference:'off' to separate a shared-camera refusal " +
                                "from a camera refusal."
                        else ".") ,
                )
            }
        }
        // ARCore's own surfaces MUST be in the session it is going to render
        // through; without them resume() has nothing to attach to.
        val cb = arcore?.wrapSessionStateCallback(rawCb, camH) ?: rawCb

        val bindPhysical = boundPhysicalId != null &&
            physicalBindRoute.startsWith("logical + OutputConfiguration")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val oc = OutputConfiguration(ir.surface)
            if (bindPhysical) {
                try {
                    oc.setPhysicalCameraId(boundPhysicalId)
                } catch (t: Throwable) {
                    // The bind is an OPTIMISATION, not a requirement: fall back
                    // to the logical stream rather than failing the sweep, and
                    // record that the fallback happened.
                    physicalBindRoute =
                        "setPhysicalCameraId($boundPhysicalId) was REFUSED " +
                            "(${t.javaClass.simpleName}) — recording the LOGICAL stream"
                    advise(physicalBindRoute)
                    boundPhysicalId = null
                    effChars = chosen?.chars
                    outSize?.let { computeConstantIntrinsics(chosen!!.chars, it) }
                }
            }
            // ARCore's surfaces ride alongside the recorder's ImageReader in
            // ONE session — that is the whole of shared-camera mode. They are
            // de-duplicated because `getArCoreSurfaces()` may already include
            // an app surface registered through `setAppSurfaces`, and a
            // repeated Surface makes createCaptureSession throw.
            val outputs = ArrayList<OutputConfiguration>()
            outputs += oc
            // The viewfinder is a plain second output — never physically
            // bound. Binding a preview to a sub-camera buys nothing (the
            // operator is aiming, not measuring) and would be a second place
            // for setPhysicalCameraId to be refused.
            preview?.let { outputs += OutputConfiguration(it) }
            for (sf in arCoreSurfaces) {
                if (sf !== ir.surface && sf !== preview) outputs += OutputConfiguration(sf)
            }
            d.createCaptureSession(
                SessionConfiguration(
                    SessionConfiguration.SESSION_REGULAR, outputs, camExec, cb,
                ),
            )
        } else {
            if (bindPhysical) {
                physicalBindRoute =
                    "physical binding dropped: API ${Build.VERSION.SDK_INT} < 28"
                advise(physicalBindRoute)
                boundPhysicalId = null
            }
            val surfaces = ArrayList<android.view.Surface>()
            surfaces += ir.surface
            preview?.let { surfaces += it }
            for (sf in arCoreSurfaces) if (sf !== ir.surface && sf !== preview) surfaces += sf
            @Suppress("DEPRECATION")
            d.createCaptureSession(surfaces, cb, camH)
        }
    }

    /** Build the request every stage shares: fps, stabilisation off, zoom 1x. */
    private fun baseRequest(d: CameraDevice): CaptureRequest.Builder {
        val template = when (cfg.template.lowercase()) {
            "preview" -> CameraDevice.TEMPLATE_PREVIEW
            "still" -> CameraDevice.TEMPLATE_STILL_CAPTURE
            else -> CameraDevice.TEMPLATE_RECORD
        }
        val b = d.createCaptureRequest(template)
        b.addTarget(reader!!.surface)
        // ONLY once the session has configured with it. Adding a target that
        // is not one of the session's outputs makes every capture request
        // throw IllegalArgumentException — so this reads `previewAttached`
        // (set in onConfigured) and never `previewSurface`, which is non-null
        // from the moment it is claimed.
        if (previewAttached) previewSurface?.let { b.addTarget(it) }
        fpsRange?.let { b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)

        val c = effChars
        // ── STABILISATION OFF, BOTH KINDS ──────────────────────────────
        // OIS moves the optical path between frames and EIS crops-and-warps
        // per frame. Either one makes the per-frame intrinsics a lie and
        // injects image motion the attitude channel cannot see — which in a
        // strip-advance panorama is indistinguishable from a real advance.
        // Off, verified by read-back, and recorded either way.
        val ois = c?.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)
        oisApplied = if (ois != null &&
            ois.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF)
        ) {
            b.set(
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF,
            )
            "requested OFF"
        } else if (ois == null) "key unavailable (nothing requested)"
        else "OFF not in ${ois.toList()} (nothing requested)"

        val evs = c?.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)
        evsApplied = if (evs != null &&
            evs.contains(CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF)
        ) {
            b.set(
                CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF,
            )
            "requested OFF"
        } else if (evs == null) "key unavailable (nothing requested)"
        else "OFF not in ${evs.toList()} (nothing requested)"

        // A device that boots at a zoom ratio other than 1.0 would silently
        // rescale every intrinsic in the pack. Pin it, and read it back.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val zr = c?.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
            zoomApplied = if (zr != null && zr.lower <= 1.0f && zr.upper >= 1.0f) {
                b.set(CaptureRequest.CONTROL_ZOOM_RATIO, 1.0f)
                "requested 1.0x (range $zr)"
            } else if (zr == null) "key unavailable (nothing requested)"
            else "1.0x outside $zr (nothing requested)"
        } else {
            zoomApplied = "API ${Build.VERSION.SDK_INT} < 30 (CONTROL_ZOOM_RATIO unavailable)"
        }
        b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
        b.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO)
        b.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_OFF)
        return b
    }

    private fun beginSettle(d: CameraDevice, s: CameraCaptureSession, promise: Promise) {
        state.set(ST_SETTLING)
        val b = baseRequest(d)
        // AF runs CONTINUOUS_PICTURE during the settle so the lens converges on
        // the shelf the operator is pointing at; the converged distance is then
        // FROZEN below. Guessing a fixed distance up front is how a whole sweep
        // comes back soft.
        val afModes = effChars?.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.toList()
            ?: emptyList()
        if (afModes.contains(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
            b.set(
                CaptureRequest.CONTROL_AF_MODE,
                CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE,
            )
        } else if (afModes.contains(CameraMetadata.CONTROL_AF_MODE_AUTO)) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO)
        }
        b.set(CaptureRequest.CONTROL_AE_LOCK, false)
        b.set(CaptureRequest.CONTROL_AWB_LOCK, false)

        val t0 = SystemClock.elapsedRealtime()
        val transitioned = AtomicBoolean(false)

        // ── THE IDLE VIEWFINDER'S ANSWER, AS A TARGET TO RECOGNISE ──────────
        //
        // The operator, 2026-09-09: "the preview thumbnail appears after more
        // than a second after I hold the shutter". Measured on his five A35
        // packs, 1045-1139 ms of that is THIS settle, on a scene the idle
        // viewfinder had already metered correctly and then forgot, because
        // Android allows one client per back camera and its device was closed
        // before this one opened.
        //
        // The memo is used as a TARGET, never as a value that is forced onto
        // the camera. Nothing here writes SENSOR_EXPOSURE_TIME, so nothing here
        // needs MANUAL_SENSOR — which matters, because this A35 reports
        // hardwareLevel LIMITED and manual sensor control is not guaranteed on
        // it. All the memo does is let the settle STOP EARLY once the HAL has
        // independently arrived back at the exposure the viewfinder was already
        // showing. If the operator repointed at a different scene the numbers
        // will not match and this path simply never fires.
        val memo =
            if (cfg.meteringMemoMaxAgeMs > 0.0) {
                PanoPlusMeteringMemo.get(d.id, cfg.meteringMemoMaxAgeMs)
            } else {
                null
            }
        meteringMemoAtStart = memo ?: PanoPlusMeteringMemo.peek()
        meteringMemoAgeMsAtStart =
            meteringMemoAtStart?.ageMs(SystemClock.elapsedRealtimeNanos()) ?: -1.0
        meteringMemoVerdict = when {
            cfg.meteringMemoMaxAgeMs <= 0.0 -> "disabled by meteringMemoMaxAgeMs=0"
            memo == null && PanoPlusMeteringMemo.peek() == null ->
                "no memo — the idle viewfinder never reached a converged CaptureResult " +
                    "(it may never have been started on this arm)"
            memo == null ->
                "REJECTED: memo is for camera ${PanoPlusMeteringMemo.peek()?.cameraId} at " +
                    "${"%.0f".format(meteringMemoAgeMsAtStart)}ms old; this sweep opened " +
                    "camera ${d.id} and the limit is ${cfg.meteringMemoMaxAgeMs.toLong()}ms"
            !memo.hasExposurePair() ->
                "REJECTED: memo has no exposure/ISO pair (this HAL published neither key)"
            else ->
                "accepted as a settle target: ${memo.exposureTimeNs}ns @ ISO " +
                    "${memo.sensitivityIso}, ${"%.0f".format(meteringMemoAgeMsAtStart)}ms old"
        }
        val memoUsable = memo != null && memo.hasExposurePair()

        // Stability tracker: consecutive results carrying an IDENTICAL pair.
        var lastExp = -1L
        var lastIso = -1
        var stableRun = 0

        val settleCb = object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureCompleted(
                sess: CameraCaptureSession, req: CaptureRequest, res: TotalCaptureResult,
            ) {
                ingestResult(res)
                aeSettleResults++
                val ae = res.get(CaptureResult.CONTROL_AE_STATE)
                val awb = res.get(CaptureResult.CONTROL_AWB_STATE)
                val elapsed = (SystemClock.elapsedRealtime() - t0).toDouble()
                val aeOk = ae == null ||
                    ae == CaptureResult.CONTROL_AE_STATE_CONVERGED ||
                    ae == CaptureResult.CONTROL_AE_STATE_LOCKED ||
                    ae == CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED
                val awbOk = awb == null ||
                    awb == CaptureResult.CONTROL_AWB_STATE_CONVERGED ||
                    awb == CaptureResult.CONTROL_AWB_STATE_LOCKED

                // ── The settle-phase trace, recorded whatever ends it ────────
                // Every claim this project makes about the settle has been an
                // aggregate until now (aeSettleMs and a result count). The row
                // is [elapsedMs, exposureNs, iso, aeState, awbState] so the
                // exit is auditable against the numbers it was taken on.
                val expNs = res.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: -1L
                val iso = res.get(CaptureResult.SENSOR_SENSITIVITY) ?: -1
                if (settleTrace.size < 240) {
                    settleTrace.add(
                        longArrayOf(
                            elapsed.toLong(), expNs, iso.toLong(),
                            (ae ?: -1).toLong(), (awb ?: -1).toLong(),
                        ),
                    )
                }

                if (expNs > 0 && iso > 0 && expNs == lastExp && iso == lastIso) {
                    stableRun++
                } else {
                    stableRun = if (expNs > 0 && iso > 0) 1 else 0
                    lastExp = expNs
                    lastIso = iso
                }

                // ── The three ways this can end early, in priority order ─────
                // A HAL that says CONVERGED is believed first: it is the only
                // one of the three the device itself asserts.
                val matchedMemo = memoUsable && expNs > 0 && iso > 0 && run {
                    val me = memo!!.exposureTimeNs!!
                    val mi = memo.sensitivityIso!!
                    // 5% on exposure, 15% on ISO. Deliberately loose: the point
                    // is "the HAL is back where the viewfinder was", not "these
                    // are equal". Tight bounds here would simply never fire and
                    // the path would be dead code that looked alive.
                    val expClose = me > 0 && kotlin.math.abs(expNs - me).toDouble() / me <= 0.05
                    val isoClose = mi > 0 && kotlin.math.abs(iso - mi).toDouble() / mi <= 0.15
                    expClose && isoClose
                }
                val stableEnough =
                    cfg.settleStableResults > 0 && stableRun >= cfg.settleStableResults

                val reason = when {
                    aeOk && awbOk -> "converged"
                    matchedMemo -> "matched-idle-memo"
                    stableEnough -> "stable"
                    elapsed >= cfg.settleCeilingMs -> "ceiling"
                    else -> null
                }
                if (reason != null) {
                    if (transitioned.compareAndSet(false, true)) {
                        aeSettleMs = elapsed
                        aeSettleExitReason = reason
                        aeStateAtLock = ae
                        awbStateAtLock = awb
                        if (reason == "matched-idle-memo" || reason == "stable") {
                            advise(
                                "the settle ended on '$reason' at ${elapsed.toLong()}ms rather " +
                                    "than waiting for the HAL to declare CONVERGED " +
                                    "(aeState=${aeStateName(ae)} awbState=${awbStateName(awb)}). " +
                                    "The exposure pair was ${expNs}ns @ ISO $iso and had been " +
                                    "steady for $stableRun results. This is a LATENCY choice and " +
                                    "it is visible in applied.settleTrace: if the trace shows the " +
                                    "pair still moving after this point, raise settleStableResults " +
                                    "or set meteringMemoMaxAgeMs=0 to restore the old behaviour.",
                            )
                        }
                        if (!(aeOk && awbOk) && reason == "ceiling") {
                            advise(
                                "AE/AWB did NOT converge within ${cfg.settleCeilingMs.toLong()}ms " +
                                    "(aeState=${aeStateName(ae)} awbState=${awbStateName(awb)}); " +
                                    "locking anyway so the sweep has a CONSTANT exposure — an " +
                                    "unconverged constant beats a drifting correct one for the " +
                                    "radiometric chain, but check the frames for clipping",
                            )
                        }
                        try { lockAndRecord(d, sess, res, promise) } catch (t: Throwable) {
                            fail(
                                promise, "lock-failed",
                                "applying the AE/AWB lock threw: " +
                                    "${t.javaClass.simpleName}: ${t.message}",
                            )
                        }
                    }
                }
            }
            override fun onCaptureFailed(
                sess: CameraCaptureSession, req: CaptureRequest,
                f: android.hardware.camera2.CaptureFailure,
            ) {
                Log.w(TAG, "settle capture failed (reason=${f.reason}, seq=${f.sequenceId})")
            }
        }
        s.setRepeatingRequest(b.build(), settleCb, camH)

        // If NO CaptureResult ever arrives the callback above can never fire,
        // so the ceiling is also enforced from outside it.
        camH.postDelayed({
            if (transitioned.compareAndSet(false, true) && state.get() == ST_SETTLING) {
                aeSettleMs = (SystemClock.elapsedRealtime() - t0).toDouble()
                aeSettleExitReason = "no-results"
                advise(
                    "no CaptureResult reached the settle callback within " +
                        "${cfg.settleCeilingMs.toLong()}ms (results seen: $aeSettleResults) — " +
                        "proceeding to lock on the request alone; every read-back field in " +
                        "device.json will say 'unobserved'",
                )
                try { lockAndRecord(d, s, null, promise) } catch (t: Throwable) {
                    fail(
                        promise, "lock-failed",
                        "applying the AE/AWB lock threw: ${t.javaClass.simpleName}: ${t.message}",
                    )
                }
            }
        }, cfg.settleCeilingMs.toLong() + 250L)
    }

    private fun lockAndRecord(
        d: CameraDevice, s: CameraCaptureSession, settleRes: TotalCaptureResult?, promise: Promise,
    ) {
        val b = baseRequest(d)
        // The A/B this flag exists for. OFF leaves AE/AWB free-running for the
        // whole sweep, which is what a vision-camera-owned session would give
        // us on Android — the one capability that argument turns on.
        b.set(CaptureRequest.CONTROL_AE_LOCK, cfg.lockCamera)
        b.set(CaptureRequest.CONTROL_AWB_LOCK, cfg.lockCamera)

        // ── Freeze focus ────────────────────────────────────────────────
        val afModes = effChars?.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.toList()
            ?: emptyList()
        val minFocus = effChars?.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)
        val fixedFocusLens = minFocus != null && minFocus == 0.0f
        val requested: Float? = when {
            cfg.focusDistanceM.isFinite() && cfg.focusDistanceM > 0.0 ->
                (1.0 / cfg.focusDistanceM).toFloat()
            cfg.focusDistanceM.isFinite() && cfg.focusDistanceM == 0.0 -> 0.0f  // infinity
            else -> settleRes?.get(CaptureResult.LENS_FOCUS_DISTANCE)
        }
        if (afModes.contains(CameraMetadata.CONTROL_AF_MODE_OFF) && !fixedFocusLens) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
            afModeApplied = CameraMetadata.CONTROL_AF_MODE_OFF
            if (requested != null && requested.isFinite()) {
                val clamped = requested.coerceIn(0.0f, minFocus ?: requested)
                b.set(CaptureRequest.LENS_FOCUS_DISTANCE, clamped)
                focusRequestedDiopters = clamped
            } else {
                advise(
                    "AF was switched OFF but no focus distance could be determined (the " +
                        "settle result carried no LENS_FOCUS_DISTANCE and none was passed) — " +
                        "the lens holds wherever it was. Pass focusDistanceM if the sweep " +
                        "comes back soft.",
                )
            }
        } else if (fixedFocusLens) {
            afModeApplied = null
            advise(
                "LENS_INFO_MINIMUM_FOCUS_DISTANCE is 0 — this is a FIXED-FOCUS lens; " +
                    "no AF request was made and none is needed",
            )
        } else {
            // AF OFF unsupported (common on LEGACY): keep it continuous and say
            // so, rather than pretending focus is frozen.
            if (afModes.contains(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
                b.set(
                    CaptureRequest.CONTROL_AF_MODE,
                    CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE,
                )
                afModeApplied = CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
            }
            advise(
                "CONTROL_AF_MODE_OFF is not available (modes: $afModes) — focus is NOT " +
                    "frozen for this sweep; a refocus mid-sweep will change the effective " +
                    "focal length and shows up as a scale step in the ledger",
            )
        }

        val recordCb = object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureCompleted(
                sess: CameraCaptureSession, req: CaptureRequest, res: TotalCaptureResult,
            ) = ingestResult(res)
        }
        s.setRepeatingRequest(b.build(), recordCb, camH)
        state.set(ST_RECORDING)

        // ── Hand the session to ARCore, then let it pump ────────────────
        // The order matters and it is not obvious: ARCore may only resume once
        // a capture session exists, and its resume() REPLACES the repeating
        // request just installed above — taking `recordCb` with it. The
        // channel re-registers that callback through SharedCamera after
        // resume, which is why it is handed over here rather than being
        // assumed to survive. Losing it would cost every SENSOR_TIMESTAMP, and
        // `tsNs` is the only clock track.jsonl is allowed to carry.
        arcore?.let { ch ->
            ch.onSessionConfigured(recordCb, camH)
            ch.startPump({ row -> writeArCoreRow(row) }, arcoreFrameIndex)
        }

        // Written NOW, before a single frame, so a jetsam or a crash mid-sweep
        // still leaves the probe behind; rewritten with the results at stop().
        // OFF camThread: it re-enumerates every camera, and camThread is the
        // only source of SENSOR_TIMESTAMP — a ~50 ms stall here would show up
        // as a run of `metaJoined:false` rows at the head of the sweep.
        CoroutineScope(Dispatchers.IO).launch { writeDeviceJson("recording-started") }

        settleResolve(promise)
    }

    // ════════════════════════════════════════════════════════════════════
    //  CaptureResult ingest
    // ════════════════════════════════════════════════════════════════════

    private fun ingestResult(res: TotalCaptureResult) {
        try {
            val ts = res.get(CaptureResult.SENSOR_TIMESTAMP) ?: return
            val nowElapsed = SystemClock.elapsedRealtimeNanos()
            resultsSeen.incrementAndGet()
            camTsMinusElapsed.add((ts - nowElapsed).toDouble())
            if (firstResultTsNs == 0L) firstResultTsNs = ts
            lastResultTsNs = ts
            resultTsCount++

            val crop = res.get(CaptureResult.SCALER_CROP_REGION)
            if (crop != null) {
                if (cropRegionFirst == null) cropRegionFirst = Rect(crop)
                else if (cropRegionFirst != crop) cropRegionChanged = true
            }
            val exp = res.get(CaptureResult.SENSOR_EXPOSURE_TIME)
            val iso = res.get(CaptureResult.SENSOR_SENSITIVITY)
            exp?.let { exposureNsStat.add(it.toDouble()) }
            iso?.let { isoStat.add(it.toDouble()) }
            res.get(CaptureResult.CONTROL_AE_LOCK)?.let { aeLockObserved = it }
            res.get(CaptureResult.CONTROL_AWB_LOCK)?.let { awbLockObserved = it }
            res.get(CaptureResult.CONTROL_AF_MODE)?.let { afModeObserved = it }
            res.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { focusObservedDiopters = it }
            res.get(CaptureResult.LENS_STATE)?.let { lensStateObserved = it }

            val meta = FrameMeta(
                sensorTsNs = ts,
                exposureNs = exp,
                iso = iso,
                cropRegion = crop,
                intrinsics = res.get(CaptureResult.LENS_INTRINSIC_CALIBRATION),
                focusDistance = res.get(CaptureResult.LENS_FOCUS_DISTANCE),
                afMode = res.get(CaptureResult.CONTROL_AF_MODE),
                aeState = res.get(CaptureResult.CONTROL_AE_STATE),
                awbState = res.get(CaptureResult.CONTROL_AWB_STATE),
                aeLock = res.get(CaptureResult.CONTROL_AE_LOCK),
                awbLock = res.get(CaptureResult.CONTROL_AWB_LOCK),
                lensState = res.get(CaptureResult.LENS_STATE),
                deliveredElapsedNs = nowElapsed,
            )
            synchronized(metaLock) {
                metaByTs[ts] = meta
                // BOUNDED: a result whose image was dropped is never collected
                // by anyone, so without the cap this map is a slow leak for the
                // length of the sweep.
                while (metaByTs.size > 64) {
                    val it = metaByTs.keys.iterator()
                    it.next(); it.remove()
                }
                (metaLock as Object).notifyAll()
            }
        } catch (t: Throwable) {
            // A metadata read must never kill the camera callback thread.
            Log.w(TAG, "ingestResult threw", t)
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  Frame path
    // ════════════════════════════════════════════════════════════════════

    private fun onImages(r: ImageReader) {
        // Drain EVERY available image on each callback. An image left in the
        // reader consumes one of `readerMaxImages` slots, and when they are all
        // consumed the camera stalls silently — which looks exactly like a dead
        // sensor and is the single worst failure this recorder could have.
        var drained = 0
        while (true) {
            val img: Image? = try { r.acquireNextImage() } catch (t: Throwable) {
                Log.w(TAG, "acquireNextImage threw", t); null
            }
            if (img == null) {
                // A null ends the drain loop and is the NORMAL exit. A null on
                // the FIRST attempt is not: the listener fired with nothing to
                // hand over, which on some devices precedes a stream stall.
                if (drained == 0) droppedAcquireNull.incrementAndGet()
                return
            }
            drained++
            try {
                framesArrived.incrementAndGet()
                when {
                    // NOT counted into pendingDropReport: settle-phase frames
                    // were never candidates, and folding them in would put a
                    // droppedBefore of ~180 on the pack's FIRST row and make
                    // the sweep look like it started by losing six seconds.
                    state.get() != ST_RECORDING -> droppedNotRecording.incrementAndGet()
                    framesWritten.get() + 1 > cfg.maxFrames -> {
                        if (droppedFrameCap.getAndIncrement() == 0L) {
                            advise(
                                "maxFrames=${cfg.maxFrames} reached — the session is closing " +
                                    "itself. The track rows already on disk are complete and " +
                                    "replayable; counts.droppedFrameCap carries any frames that " +
                                    "arrived during the teardown.",
                            )
                            // CLOSE, don't idle. Before this the cap only stopped
                            // WRITING: the camera stayed open, the four
                            // HandlerThreads kept running and device.json was
                            // never rewritten with the results, until someone
                            // remembered to press stop. A capture that has
                            // finished must release the camera, and the pack
                            // must be finalised at the moment it stops growing.
                            //
                            // Off this thread: shutdown() joins the reader
                            // thread, which is the thread running right now.
                            CoroutineScope(Dispatchers.IO).launch {
                                try { shutdown("max-frames-reached") } catch (t: Throwable) {
                                    Log.w(TAG, "max-frames teardown threw", t)
                                }
                            }
                        }
                        pendingDropReport.incrementAndGet()
                    }
                    // THE BACKPRESSURE RULE, and the whole reason this is a
                    // gate rather than a queue: a frame that arrives while the
                    // writer is busy is DROPPED AND COUNTED. Queueing would
                    // trade a bounded, visible frame loss for an unbounded
                    // memory growth that ends in a jetsam kill with no pack.
                    !encoderBusy.compareAndSet(false, true) -> {
                        droppedBusy.incrementAndGet()
                        pendingDropReport.incrementAndGet()
                    }
                    else -> {
                        val t0 = SystemClock.elapsedRealtimeNanos()
                        var ok = false
                        try {
                            ok = convertInto(img)
                        } catch (t: Throwable) {
                            convertFailed.incrementAndGet()
                            firstFrameError.compareAndSet(
                                null, "convert: ${t.javaClass.simpleName}: ${t.message}",
                            )
                        }
                        if (!ok) {
                            encoderBusy.set(false)
                            pendingDropReport.incrementAndGet()
                        } else {
                            val tsNs = img.timestamp
                            val seq = seqNext.getAndIncrement()
                            val dropped = pendingDropReport.getAndSet(0)
                            val convMs = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
                            convertMs.add(convMs)
                            val imu = imuLatest.get()
                            // `t0` is elapsedRealtimeNanos as this frame entered
                            // the accept path. It is the frame's half of the
                            // attitude-freshness comparison, and it is taken
                            // BEFORE the writer runs so an encode backlog can
                            // never make a live IMU look stale.
                            val acceptElapsedNs = t0
                            // Wall clock sampled HERE, at accept time, not in
                            // the writer: the writer runs one encode later and
                            // its clock would carry that latency into the pack.
                            val wallMs = startWallMs +
                                (SystemClock.elapsedRealtimeNanos() - startElapsedNs) / 1e6
                            // Image is closed by the finally below, BEFORE the
                            // writer runs: the writer owns only the ByteArray.
                            val posted = writerH.post {
                                writeFrame(
                                    seq, tsNs, wallMs, dropped, convMs, imu, acceptElapsedNs,
                                )
                            }
                            if (!posted) {
                                // The writer looper is quitting (a stop() is in
                                // flight). Nothing will clear the gate, and a
                                // stuck gate would drop every remaining frame.
                                encoderBusy.set(false)
                                droppedNotRecording.incrementAndGet()
                                pendingDropReport.addAndGet(dropped + 1)
                            }
                        }
                        readerMs.add((SystemClock.elapsedRealtimeNanos() - t0) / 1e6)
                    }
                }
            } finally {
                // Unconditional: an Image that is not closed holds one of the
                // reader's `maxImages` slots forever, and losing all of them
                // stalls the camera with no error anywhere.
                try { img.close() } catch (t: Throwable) { Log.w(TAG, "image.close threw", t) }
            }
        }
    }

    /** @return true when [nv21] now holds this frame. */
    private fun convertInto(img: Image): Boolean {
        val size = outSize ?: return false
        val dst = nv21 ?: return false
        val planes = img.planes
        if (planes.size < 3) {
            firstFrameError.compareAndSet(
                null, "image has ${planes.size} planes, expected 3 (YUV_420_888)",
            )
            convertFailed.incrementAndGet()
            return false
        }
        if (img.width != size.width || img.height != size.height) {
            // The reader was created at `size`; a different size here means the
            // device silently re-negotiated the stream. Refuse rather than
            // write a mislabelled frame.
            firstFrameError.compareAndSet(
                null,
                "frame is ${img.width}x${img.height} but the reader was configured for " +
                    "${size.width}x${size.height}",
            )
            convertFailed.incrementAndGet()
            return false
        }
        val y = planes[0]; val u = planes[1]; val v = planes[2]
        var sc = scratch
        val need = Yuv420ToNv21.scratchBytes(
            size.width, y.pixelStride, u.pixelStride, v.pixelStride,
        )
        if (sc == null || sc.size < need) { sc = ByteArray(need); scratch = sc }

        val layout = Yuv420ToNv21.convert(
            y.buffer, y.rowStride, y.pixelStride,
            u.buffer, u.rowStride, u.pixelStride,
            v.buffer, v.rowStride, v.pixelStride,
            size.width, size.height, dst, sc,
        )
        val prev = observedLayout
        if (prev == null) observedLayout = layout
        else if (prev != layout) {
            // The plane geometry is fixed by format+size, so this should be
            // impossible. If it happens, the pack must say so — every frame
            // before it was converted under a different assumption.
            layoutChanged.incrementAndGet()
            observedLayout = layout
        }
        return true
    }

    private fun writeFrame(
        seq: Long, tsNs: Long, wallMs: Double, droppedBefore: Int, convMs: Double,
        imu: ImuSample?, acceptElapsedNs: Long,
    ) {
        try {
            val size = outSize ?: return
            val dst = nv21 ?: return

            // ── Join the CaptureResult ──────────────────────────────────
            // Done HERE, not on the reader thread: the result and the image
            // race, and by the time the encode is queued the result has almost
            // always landed. The wait is bounded and its expiry is COUNTED —
            // a row that could not be joined says so rather than borrowing a
            // neighbour's exposure.
            var meta: FrameMeta?
            synchronized(metaLock) {
                meta = metaByTs[tsNs]
                if (meta == null && cfg.metaJoinWaitMs > 0.0) {
                    val deadline = SystemClock.elapsedRealtime() + cfg.metaJoinWaitMs.toLong()
                    while (meta == null) {
                        val left = deadline - SystemClock.elapsedRealtime()
                        if (left <= 0L) break
                        try { (metaLock as Object).wait(left) } catch (_: InterruptedException) {
                            Thread.currentThread().interrupt(); break
                        }
                        meta = metaByTs[tsNs]
                    }
                }
                if (meta != null) metaByTs.remove(tsNs)
            }
            val m = meta
            if (m == null) metaMissing.incrementAndGet()

            // ── Everything the ENGINE needs, computed before any I/O ─────
            // These four blocks used to sit BELOW the JPEG encode. They are
            // pure functions of `m`, `size`, `tsNs` and `acceptElapsedNs` — no
            // file, no camera — so moving them above it changes nothing about
            // what they compute, and it is what lets the live arm hand the
            // engine a frame WITHOUT first paying for a JPEG the live pack does
            // not want.
            val ic = intrinsicsFor(m, size)
            if (ic.perFrame) intrinsicsPerFrameRows.incrementAndGet()

            // `basisC` is resolved FIRST and `sol` only exists when it is
            // non-null, so `sol != null` means exactly "the map ran on this
            // frame". Solving first and checking the matrix afterwards would
            // make a missing matrix indistinguishable from a refused bracket
            // and put a refusal named "none" in the counters.
            //
            // ⚠ TWO ARMS SINCE 2026-09-02, AND THIS IS THE FORK. On the AR arm
            // the pose comes from ARCore's own ring and NO BASIS IS APPLIED —
            // `Camera.getPose()` is already `world<-camera` in the engine's
            // convention, which is precisely why `selectBasis()` fits the IMU
            // series ONTO this one. Applying `C` here would rotate a series
            // that is already in the target frame, twice.
            //
            // The IMU ring is still fed and `sensors.jsonl` is still written on
            // an AR sweep, so the SAME pack replays on the other arm offline —
            // the controlled A/B the operator asked for ("the same capture done
            // both via imu and ar and see the comparison"), on one hand motion
            // instead of two.
            // ── THE ONE-WAY DEGRADE: AR -> IMU, BEFORE THE FIRST AR POSE ──
            //
            // WHY IT EXISTS. `arArmActive` had exactly one assignment and no
            // clear, and the fork below tests it FIRST — so once the ARCore
            // channel opened, a full IMU ring beside it was structurally
            // unreachable for the rest of the sweep. Measured on a Galaxy A35
            // on 2026-09-18: ARCore never tracked, the sink admits TRACKING
            // poses only so it dropped all 174, and all 120 frames refused
            // `buffer-empty`. Beside them the IMU ring held 858
            // rotation-vector samples at 121.6 Hz, accuracy 3 on every one,
            // with a derived basis and a passing clock gate; re-joining that
            // pack offline solves all 120 at a ~8.2 ms bracket against a
            // 25 ms bound. A tracker that cannot bootstrap should cost a
            // sweep its pose ACCURACY, not the entire sweep.
            //
            // ⚠ NOT "a dark room". ARCore's INSUFFICIENT_LIGHT is not a
            // photometer reading — the repo measured ISO p50 spanning a 64x
            // range across the packs that carry it, and a capture 3.3 stops
            // DARKER tracked cleanly. It is the label ARCore latches when its
            // one-shot motion-tracking bootstrap fails to converge. Saying it
            // was about light is a mistake this codebase has already made
            // once and written down; do not reintroduce it here.
            //
            // The trigger and the one-way terms are in `shouldDegradeArToImu`
            // with their evidence. Everything below is the state it reads and
            // the record it leaves.
            if (arArmActive
                && cfg.arImuFallbackAfterFrames > 0
                && arPoseAccepted.get() == 0L
            ) {
                val n = arFramesWithNoPose.incrementAndGet()
                // ARCore's own verdict: "" while TRACKING, else the reason
                // name. `NONE` is the reason it reports while still starting,
                // so it is explicitly NOT a failure.
                val failure = arcore?.latestTrackingFailure ?: ""
                if (shouldDegradeArToImu(
                        minFramesFloor = cfg.arImuFallbackAfterFrames,
                        arPosesAccepted = arPoseAccepted.get(),
                        arFramesSolved = arPoseSolved.get(),
                        framesWithNoPose = n,
                        arcoreVerdictLatched = failure.isNotEmpty() && failure != "NONE",
                        nsSinceStart = acceptElapsedNs - startElapsedNs,
                        graceNs = (cfg.arImuFallbackGraceMs * 1_000_000.0).toLong(),
                        attitudeMapping = attitudeMapping,
                        haveBasis = basis != null,
                        imuRingSamples = attitudeRing.sampleCount(),
                    )
                ) {
                    // ⚠ THE SINK COMES OFF FIRST, AND IT IS NOT TIDINESS.
                    // Left installed, ARCore can start tracking later and
                    // keep growing `arPoseAccepted` — so a degraded pack
                    // could report `degradedFromAr:true` beside
                    // `posesAcceptedIntoRing: 40`, and the one number that
                    // EVIDENCES the one-way invariant would contradict it.
                    // Clearing it freezes that counter at the value the
                    // decision was made on.
                    try { arcore?.setPoseSink(null) } catch (t: Throwable) {
                        Log.w(TAG, "clearing the ARCore pose sink at degrade threw", t)
                    }
                    // A `seq` a reader can JOIN ON. The previous version
                    // recorded the private no-pose counter, which is off by
                    // one from the row boundary in track.jsonl and means
                    // nothing outside this function.
                    arArmDegradedAtSeq = seq
                    arArmDegradeCounters =
                        "at the decision: ${arPoseDroppedNotTracking.get()} poses had arrived " +
                            "and every one was dropped as not-TRACKING; the IMU ring held " +
                            "${attitudeRing.sampleCount()} samples"
                    arArmReason =
                        "the AR arm was REQUESTED, ARCore opened in SHARED mode, and then " +
                            "delivered NO usable pose. Given up at seq $seq, after $n frames " +
                            "with an empty AR ring and " +
                            (if (failure.isNotEmpty() && failure != "NONE")
                                "ARCore's own verdict '$failure'"
                            else
                                "${(acceptElapsedNs - startElapsedNs) / 1_000_000L}ms without " +
                                    "ARCore ever reporting a failure reason") +
                            ". $arArmDegradeCounters. The sweep finished on the IMU arm, on " +
                            "TYPE_ROTATION_VECTOR through the derived basis C. NOTHING WAS " +
                            "PAINTED FROM AN ARCore POSE — the degrade can only fire while " +
                            "zero poses have been accepted AND zero frames have solved, so " +
                            "this series is entirely IMU-derived and is comparable with " +
                            "itself. ⚠ THE CAMERA IS STILL ARCore'S CHOICE: it forced the " +
                            "sensor, the size and the fps before this happened, and the " +
                            "AE/AWB lock was its to keep. This pack is NOT equivalent to one " +
                            "from a sweep that asked for the IMU arm up front."
                    arArmDegraded = true
                    arArmActive = false
                    // ⚠ CORRECT meta.json TOO, AND RECORD WHETHER IT LANDED.
                    // `meta.json`'s `poseSource.kind` is fixed at start() and
                    // is what every offline harness reads ON ITS OWN — a
                    // device.json cross-reference does not reach it. Without
                    // this the pack says `ar` for a sweep the IMU painted.
                    // The boolean is kept because the native entry binds
                    // lazily at first call, so "it failed" and "it worked"
                    // are otherwise indistinguishable here.
                    arArmMetaCorrected = PanoPlusLiveNative.setPoseSource("imu")
                    if (!arArmMetaCorrected) {
                        Log.w(TAG, "meta.json poseSource was NOT corrected after the degrade")
                    }
                    advise("pose arm DEGRADED: $arArmReason")
                }
            } else if (arArmActive && arPoseAccepted.get() > 0L) {
                // ── THE DEGRADE DECLINED, SAID OUT LOUD ────────────────────
                // ARCore tracking for a moment and then losing it for good is
                // the SAME total loss, and the degrade deliberately cannot
                // rescue it: a frame has already solved against an AR pose,
                // so switching now would splice two pose conventions into one
                // series — the thing the arm decision forbids.
                //
                // What must not happen is for that pack to look identical to
                // the pre-degrade failure. Silence here is how a second total
                // loss gets diagnosed twice.
                if (arPoseSolved.get() == arArmLastSolvedSeen) {
                    val stale = arFramesSinceSolve.incrementAndGet()
                    if (stale == cfg.arImuFallbackAfterFrames.toLong() && !arArmDeclinedSaid) {
                        arArmDeclinedSaid = true
                        arArmDegradeDeclined =
                            "the AR arm produced ${arPoseAccepted.get()} pose(s) and then went " +
                                "stale for $stale consecutive frames from seq $seq. The IMU " +
                                "fallback was CONSIDERED AND DECLINED: a frame has already " +
                                "solved against an ARCore pose, and switching arms now would " +
                                "produce a quaternion series that is not comparable with " +
                                "itself. If this pack is empty or short, that is why — the " +
                                "fix is the tracker, not the fallback."
                        advise("pose arm: $arArmDegradeDeclined")
                    }
                } else {
                    arArmLastSolvedSeen = arPoseSolved.get()
                    arFramesSinceSolve.set(0)
                }
            }

            val basisC: DoubleArray? = if (attitudeMapping) basis?.matrix else null
            val sol: PanoAttitudeSolution? = when {
                arArmActive -> solveArPose(tsNs)
                basisC != null -> attitudeRing.solve(tsNs, attitudeMaxBracketNs)
                else -> null
            }
            val qMapped: DoubleArray? = when {
                sol == null || !sol.ok -> null
                arArmActive -> sol.q
                basisC != null -> panoApplyBasis(sol.q, basisC)
                else -> null
            }
            if (sol != null) {
                if (qMapped != null) {
                    attitudeMapped.incrementAndGet()
                    if (attitudeFirstQ == null) attitudeFirstQ = qMapped
                    attitudeLastQ = qMapped
                } else if (!arArmActive) {
                    // The AR arm buckets its own refusals in
                    // `arPoseRefusalCounts` inside `solveArPose` — merging them
                    // into the IMU map's counters would make an AR sweep's
                    // `attitude.map` block describe a ring the map never read.
                    attitudeRefusalCounts.merge(sol.refusal, 1L) { a, b -> a + b }
                }
            }

            // Derived from sample FRESHNESS, never from the magnetometer's
            // calibration health — see derivePanoTracking for the empty canvas
            // that replaced — and vetoed outright when the map was ATTEMPTED
            // and refused, because such a row carries the identity and a fresh
            // sample behind it would otherwise still answer 2.
            //
            // ⚠ THE AR ARM ANSWERS FROM ITS OWN SOLVE, not from IMU freshness.
            // `derivePanoTracking`'s freshness term reads the ROTATION VECTOR's
            // delivery age, which on an AR sweep is the age of a series the
            // engine is not being fed from: a phone whose rotation-vector
            // sensor never started would report tracking 0 on every frame while
            // ARCore was tracking perfectly, and the engine's warmup latch
            // would never arm. A frame the AR ring BRACKETED has a pose
            // measured either side of it, which is a stronger statement than
            // any freshness test — and a refusal is exactly a tracking loss,
            // because the sink admits TRACKING poses only.
            val tracking = if (arArmActive) {
                when {
                    cfg.trackingOverride in 0..2 -> cfg.trackingOverride
                    qMapped != null -> 2
                    else -> 0
                }
            } else {
                derivePanoTracking(
                    cfg.trackingOverride,
                    imu?.deliveredElapsedNs,
                    acceptElapsedNs,
                    attitudeMaxAgeNs,
                    attitudeRefused = sol != null && qMapped == null,
                )
            }
            if (tracking in 0..2) trackingHist[tracking]++
            if (tracking == 2) {
                trackingRun++
                if (trackingRun > trackingRunMax) trackingRunMax = trackingRun
            } else {
                trackingRun = 0
            }

            // ── THE LIVE ARM ────────────────────────────────────────────
            // The whole difference between this recorder and the one that
            // shipped: the pixels go into the engine NOW, on this thread,
            // instead of only onto the disk for a replay minutes later.
            //
            // Synchronous and ~30 ms on this phone. That cost is why the
            // single-in-flight gate above matters: a frame arriving while this
            // runs is dropped and COUNTED (droppedBusy), never queued, so the
            // memory ceiling is one NV21 buffer whatever the engine does.
            //
            // `q` is the MAPPED quaternion or the identity — the same value the
            // track row records — so the pack and the live canvas are built
            // from one attitude, not two.
            val liveT0 = if (liveActive) SystemClock.elapsedRealtimeNanos() else 0L
            val live: PanoLiveFrameResult? = if (liveActive) {
                PanoPlusLiveNative.ingest(
                    dst, dst.size, size.width, size.height,
                    tsNs.toDouble(), ic.fx, ic.fy, ic.cx, ic.cy,
                    qMapped ?: PANO_IDENTITY_Q, tracking, seq,
                    m?.exposureNs?.let { it / 1e9 } ?: 0.0,
                    m?.iso?.toDouble() ?: 0.0,
                )
            } else {
                null
            }
            if (live != null) {
                liveEngineMs.add((SystemClock.elapsedRealtimeNanos() - liveT0) / 1e6)
                if (live.ran) {
                    liveIngested.incrementAndGet()
                    if (live.painted) livePainted.incrementAndGet()
                } else {
                    // The engine REFUSED this frame outright — a wrong-sized
                    // buffer or a conversion that threw. Counted separately
                    // from the engine's own rejection outcomes, which are
                    // decisions rather than failures.
                    liveRefused.incrementAndGet()
                }
            }

            // ── Encode ──────────────────────────────────────────────────
            // OPTIONAL now. `packFrames` decides whether this sweep leaves a
            // replayable pixel twin behind, and the live arm defaults it to
            // "none": a 1920x1080 software JPEG is ~15-20 ms on the SAME thread
            // the engine just used, and doubling the per-frame cost halves the
            // sweep's frame rate. `track.jsonl` (the replay INPUT) is written
            // on every mode regardless, so a "none" pack still carries the full
            // pose ledger — what it cannot do is re-run the PIXELS offline.
            val wantJpeg = when (packFramesMode) {
                PanoPlusLiveNative.PACK_FRAMES_NONE -> false
                PanoPlusLiveNative.PACK_FRAMES_PAINTED -> live?.painted == true
                else -> true
            }
            val t0 = SystemClock.elapsedRealtimeNanos()
            val path = File(framesDir, frameFileName(seq))
            var bytes = 0L
            // `true` when there is nothing to write, so the not-written failure
            // path below stays about FAILURES. A skipped frame is a choice.
            var wrote = !wantJpeg
            if (wantJpeg) try {
                // NO ROTATION and NO EXIF. The frame is written in the SENSOR
                // frame the intrinsics below describe; rotating it (or letting
                // a decoder rotate it from an EXIF tag) would silently invalidate
                // fx/fy/cx/cy for every consumer. SENSOR_ORIENTATION is recorded
                // in device.json so the offline pass can rotate BOTH together.
                //
                // ⚠ v14 — AND FOR A LONG TIME "the offline pass" DID NOT EXIST.
                // This comment was right about the frames and wrong about who
                // finished the job: nothing downstream ever applied the
                // raster -> upright turn, so a portrait sweep's deliverable came
                // out a quarter turn over (the operator's 2026-09-02 report,
                // "the output image is sideways"). The turn now lives in the
                // ENGINE — `rnis::pano::Config::outputRotationCwDeg`, derived by
                // `PanoPlusUprightRotation` from this same SENSOR_ORIENTATION and
                // baked once into canvas.jpg. THESE FRAMES ARE STILL RAW, and
                // must stay raw, for exactly the reason stated above.
                // Reused across frames: YuvImage keeps a REFERENCE to `dst`
                // (it does not copy), and `dst` is the same buffer every time
                // by construction of the single-in-flight gate.
                var yuv = yuvImage
                if (yuv == null || yuvBacking !== dst) {
                    yuv = YuvImage(dst, ImageFormat.NV21, size.width, size.height, null)
                    yuvImage = yuv
                    yuvBacking = dst
                }
                var rect = jpegRect
                if (rect == null) { rect = Rect(0, 0, size.width, size.height); jpegRect = rect }
                FileOutputStream(path).use { fos ->
                    BufferedOutputStream(fos, 1 shl 16).use { bos ->
                        wrote = yuv.compressToJpeg(rect, cfg.jpegQuality, bos)
                        bos.flush()
                    }
                }
                bytes = if (wrote) path.length() else 0L
            } catch (t: Throwable) {
                wrote = false
                firstFrameError.compareAndSet(
                    null, "encode: ${t.javaClass.simpleName}: ${t.message}",
                )
            }
            val encMs = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
            encodeMs.add(encMs)

            if (!wrote) {
                // NOT SWALLOWED: framesWritten must never overstate what is on
                // disk, or the pack lies about its own contents.
                //
                // ⚠ ONLY REACHABLE WHEN A WRITE WAS ATTEMPTED AND FAILED —
                // `wrote` starts TRUE when `packFrames` asked for no file, so a
                // deliberately frame-less live sweep does not report 100%
                // write failures and abandon every row. The whole point of a
                // live sweep is the rows and the canvas; the JPEGs are the
                // optional twin.
                frameWriteFailed.incrementAndGet()
                pendingDropReport.addAndGet(droppedBefore + 1)
                try { path.delete() } catch (_: Throwable) {}
                return
            }
            if (wantJpeg) jpegBytes.add(bytes.toDouble())

            // The pose rows join on this — and the ARCore reference channel
            // joins its own rows to a frame SEQ through it.
            //
            // Recorded once the frame is COMMITTED: after a successful encode
            // when this sweep writes files, and after the engine ingest when it
            // does not. The old comment said "so a row can never name a frame
            // that is not on disk", which was the right invariant for a
            // recorder whose only product was files; for a live sweep the row
            // itself is the product and there may deliberately be no file.
            synchronized(frameRingLock) {
                val i = (frameRingCount % frameTsRing.size)
                frameTsRing[i] = tsNs
                frameSeqRing[i] = seq
                frameRingCount++
            }

            if (firstTsNs == 0L) firstTsNs = tsNs
            lastTsNs = tsNs

            // ── The row ─────────────────────────────────────────────────
            val jo = Jo()
                .i("seq", seq)
                .i("tsNs", tsNs)
                // Unix epoch ms, sampled when the frame was ACCEPTED (iOS
                // labels the same field the same way). `tsNs` above is the
                // camera's own clock and the two are NOT interchangeable —
                // see device.json's `clocks` block.
                .n("tsWallMs", wallMs)
                // R_engine = R_imu · C, bracketed and SLERPed onto this
                // frame's timestamp — or IDENTITY when there is no basis
                // authority, no clock join, or no bracket. `qSource` below
                // says WHICH, on every row, and never a bare "imu".
                .raw(
                    "q",
                    if (qMapped != null) jarr(qMapped[0], qMapped[1], qMapped[2], qMapped[3])
                    else "[0,0,0,1]",
                )
                .raw("t", "[0,0,0]")
                .n("fx", ic.fx).n("fy", ic.fy).n("cx", ic.cx).n("cy", ic.cy)
                .i("w", size.width).i("h", size.height)
                .i("tracking", tracking)
                .n("expDurS", m?.exposureNs?.let { it / 1e9 } ?: 0.0)
                .n("expISO", m?.iso?.toDouble() ?: 0.0)
                // ARKit-only fields, present so the row shape matches iOS and
                // the harness parses one schema. Never true on Android.
                .n("arExpDurS", 0.0).n("arExpOffsetEV", 0.0).b("arExpHave", false)
                .n("arThreadUs", convMs * 1000.0)
                .i("droppedBefore", droppedBefore.toLong())
                // ── Android-only, additive ──────────────────────────────
                // NAMES THE BASIS AUTHORITY, never a bare "imu": a reader who
                // distrusts the derivation can select every row it touched by
                // string match, and a pack that claims `basis-measured` says
                // so in a field that points at the S1 report behind it.
                .s(
                    "qSource",
                    when {
                        qMapped == null -> PANO_Q_SOURCE_NONE
                        // NO BASIS ON THIS ARM, so no basis in the label. See
                        // PANO_Q_SOURCE_ARCORE.
                        arArmActive -> PANO_Q_SOURCE_ARCORE
                        else -> basis?.authority?.qSource ?: PANO_Q_SOURCE_NONE
                    },
                )
                // −1 / null ON THE AR ARM, and that is not "unknown": it is
                // "no basis took part in this row". Writing the derived index
                // here would make every AR row look like it had been mapped
                // through a matrix it never touched.
                .i(
                    "qBasisIndex",
                    if (qMapped != null && !arArmActive) basis?.authority?.index ?: -1 else -1,
                )
                .s("qBasisLabel", if (qMapped != null && !arArmActive) basis?.label else null)
                .s(
                    "qBasisAuthority",
                    if (qMapped != null && !arArmActive) basis?.authority?.authority else null,
                )
                // The bracket this row's attitude was interpolated across, and
                // where in it the frame landed. A pack whose gaps creep toward
                // the bound is one sensor hiccup from refusing frames, and
                // that is visible here per row before it is visible anywhere.
                .n("qBracketGapS", sol?.bracketGapS ?: 0.0)
                .n("qBracketAlpha", sol?.alpha ?: 0.0)
                .s(
                    "qRefusal",
                    when {
                        sol == null -> null            // the map never ran this sweep
                        qMapped != null -> PanoAttitudeRefusal.NONE
                        else -> sol.refusal
                    },
                )
                .s(
                    "qBasisNote",
                    if (qMapped != null) null
                    else "q is identity: " +
                        (basis?.authority?.note ?: "the attitude map did not run for this sweep") +
                        " qDevice below is the RAW sensor quaternion.",
                )
                .raw(
                    "qDevice",
                    if (imu == null) "null" else jarr(imu.x, imu.y, imu.z, imu.w),
                )
                .s("qDeviceType", imu?.type)
                .raw("qDeviceTsNs", imu?.tsNs?.toString() ?: "null")
                .i("imuAccuracy", imu?.accuracy)
                .n("encodeMs", encMs).n("convertMs", convMs)
                .i("jpegBytes", bytes)
                .b("metaJoined", m != null)
                .b("intrinsicsPerFrame", ic.perFrame)
                .rect("cropRegion", m?.cropRegion)
                .i("aeState", m?.aeState).i("awbState", m?.awbState)
                .i("afMode", m?.afMode).n("focusDiopters", m?.focusDistance)
                .i("lensState", m?.lensState)
                .i("elapsedRealtimeNsAtWrite", SystemClock.elapsedRealtimeNanos())
                // ── THE LIVE ENGINE'S VERDICT ON THIS ROW ───────────────
                // Present only on a live sweep, so a recorded pack's rows are
                // byte-identical to what shipped and the harness parses one
                // schema either way. `liveOutcome` is the engine's ordinal for
                // the same frame the row describes, which is what makes a live
                // pack's `track.jsonl` diffable against its own `ledger.jsonl`
                // without a join — and what lets a REPLAY of the same pack be
                // graded against the decisions the device actually made.
                .also { jo ->
                    if (live != null) {
                        jo.b("liveRan", live.ran)
                        jo.i("liveOutcome", live.outcome)
                        jo.b("livePainted", live.painted)
                        jo.b("liveFramePacked", wantJpeg && wrote)
                    }
                }
            val line = jo.end() + "\n"
            trackW?.let { w ->
                w.write(line)
                // Periodic flush, iOS' rule and its reason: a background kill
                // mid-sweep must not cost the ledger. 30 rows is ~half a second.
                if ((seq % 30L) == 29L) w.flush()
            }
            framesWritten.incrementAndGet()
        } catch (t: Throwable) {
            frameWriteFailed.incrementAndGet()
            firstFrameError.compareAndSet(null, "row: ${t.javaClass.simpleName}: ${t.message}")
            Log.w(TAG, "writeFrame threw", t)
        } finally {
            // LAST, unconditionally: leaving this true would drop every
            // remaining frame of the sweep — the bug the gate exists to avoid,
            // reintroduced by its own failure path.
            encoderBusy.set(false)
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  Intrinsics
    // ════════════════════════════════════════════════════════════════════

    private class Intr(
        val fx: Double, val fy: Double, val cx: Double, val cy: Double, val perFrame: Boolean,
    )

    /**
     * Map intrinsics from the pre-correction active array through the frame's
     * own crop region onto the output size.
     *
     * The output stream is a CENTRE CROP of the crop region to the output
     * aspect, then a scale. Skipping the crop-region step is how a device that
     * boots with a default digital zoom writes a whole pack of fx values that
     * are quietly wrong by that ratio.
     */
    private fun mapIntrinsics(
        fxA: Double, fyA: Double, cxA: Double, cyA: Double, crop: Rect, out: Size,
    ): Intr {
        if (crop.width() <= 0 || crop.height() <= 0 || out.width <= 0 || out.height <= 0) {
            // A degenerate crop is not a mapping problem, it is a bad reading.
            // Pass the array-frame values through unscaled rather than
            // dividing by zero and emitting a confident wrong number.
            return Intr(fxA, fyA, cxA, cyA, false)
        }
        val outAspect = out.width.toDouble() / out.height
        val cropAspect = crop.width().toDouble() / crop.height()
        val effW: Double; val effH: Double; val x0: Double; val y0: Double
        if (cropAspect > outAspect) {
            effH = crop.height().toDouble(); effW = effH * outAspect
            x0 = crop.left + (crop.width() - effW) / 2.0; y0 = crop.top.toDouble()
        } else {
            effW = crop.width().toDouble(); effH = effW / outAspect
            x0 = crop.left.toDouble(); y0 = crop.top + (crop.height() - effH) / 2.0
        }
        val s = if (effW > 0.0) out.width / effW else 1.0
        return Intr(fxA * s, fyA * s, (cxA - x0) * s, (cyA - y0) * s, false)
    }

    private fun intrinsicsFor(m: FrameMeta?, size: Size): Intr {
        val crop = m?.cropRegion ?: cropRegionFirst ?: arrayRect
        val ic = m?.intrinsics
        if (ic != null && ic.size >= 4 && crop != null &&
            ic[0].isFinite() && ic[0] > 0f && ic[1].isFinite() && ic[1] > 0f
        ) {
            val r = mapIntrinsics(
                ic[0].toDouble(), ic[1].toDouble(), ic[2].toDouble(), ic[3].toDouble(), crop, size,
            )
            return Intr(r.fx, r.fy, r.cx, r.cy, true)
        }
        // The fallback goes through the SAME crop mapping as the per-frame
        // path. Reusing a value mapped once through the full array would make
        // the fallback rows disagree with the calibrated ones on any device
        // that ships a default digital crop — the two would differ by exactly
        // the crop ratio, on alternating rows, with nothing to say why.
        if (!arrValid) return Intr(0.0, 0.0, 0.0, 0.0, false)
        val rect = crop ?: return Intr(constFx, constFy, constCx, constCy, false)
        val r = mapIntrinsics(arrFx, arrFy, arrCx, arrCy, rect, size)
        return Intr(r.fx, r.fy, r.cx, r.cy, false)
    }

    private fun computeConstantIntrinsics(c: CameraCharacteristics, size: Size) {
        val preActive = c.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
        val active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        val pixelArray = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
        val phys = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        val focals = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
        val staticIntr = c.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION)
        arrayRect = preActive

        if (preActive != null && active != null && preActive != active) {
            intrinsicsNote =
                "SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE $preActive and " +
                    "SENSOR_INFO_ACTIVE_ARRAY_SIZE $active DIFFER. " +
                    "LENS_INTRINSIC_CALIBRATION lives in the former and SCALER_CROP_REGION in " +
                    "the latter; this recorder maps them in one system without correcting the " +
                    "offset. Both rects are recorded so the offline pass can."
            advise(intrinsicsNote)
        }

        if (staticIntr != null && staticIntr.size >= 4 && staticIntr[0].isFinite() &&
            staticIntr[0] > 0f && preActive != null
        ) {
            arrFx = staticIntr[0].toDouble(); arrFy = staticIntr[1].toDouble()
            arrCx = staticIntr[2].toDouble(); arrCy = staticIntr[3].toDouble()
            arrValid = true
            val r = mapIntrinsics(arrFx, arrFy, arrCx, arrCy, preActive, size)
            constFx = r.fx; constFy = r.fy; constCx = r.cx; constCy = r.cy
            intrinsicsSource = "LENS_INTRINSIC_CALIBRATION"
            return
        }

        val f = focals?.filter { it.isFinite() && it > 0f }?.minOrNull()
        if (f != null && phys != null && pixelArray != null && preActive != null &&
            pixelArray.width > 0 && pixelArray.height > 0 && phys.width > 0f && phys.height > 0f
        ) {
            // fx in ACTIVE-ARRAY pixels: a crop does not change a focal length
            // expressed in pixels, only the principal point, so the pixel pitch
            // of the FULL pixel array is the right divisor.
            val pitchX = phys.width / pixelArray.width
            val pitchY = phys.height / pixelArray.height
            val fxA = f / pitchX
            val fyA = f / pitchY
            // Optical centre = centre of the PIXEL ARRAY, expressed in
            // pre-correction-active coordinates (whose origin is the pixel
            // array's). Assuming the centre of preActive would be wrong on any
            // sensor with an asymmetric inactive border.
            val cxA = pixelArray.width / 2.0 - preActive.left
            val cyA = pixelArray.height / 2.0 - preActive.top
            arrFx = fxA.toDouble(); arrFy = fyA.toDouble(); arrCx = cxA; arrCy = cyA
            arrValid = true
            val r = mapIntrinsics(arrFx, arrFy, arrCx, arrCy, preActive, size)
            constFx = r.fx; constFy = r.fy; constCx = r.cx; constCy = r.cy
            intrinsicsSource = "derived"
            intrinsicsNote = (if (intrinsicsNote.isEmpty()) "" else intrinsicsNote + " ") +
                "Derived from LENS_INFO_AVAILABLE_FOCAL_LENGTHS min=${f}mm and " +
                "SENSOR_INFO_PHYSICAL_SIZE ${phys.width}x${phys.height}mm over " +
                "SENSOR_INFO_PIXEL_ARRAY_SIZE $pixelArray, mapped through $preActive onto " +
                "${size.width}x${size.height}. cx/cy are the PIXEL ARRAY centre, not a " +
                "measured principal point."
            return
        }

        arrValid = false
        constFx = 0.0; constFy = 0.0; constCx = 0.0; constCy = 0.0
        intrinsicsSource = "unavailable"
        advise(
            "INTRINSICS UNAVAILABLE: neither LENS_INTRINSIC_CALIBRATION nor " +
                "(LENS_INFO_AVAILABLE_FOCAL_LENGTHS + SENSOR_INFO_PHYSICAL_SIZE + " +
                "SENSOR_INFO_PIXEL_ARRAY_SIZE) is populated on this camera. Every track row " +
                "carries fx=fy=cx=cy=0, which the engine reads as 'no intrinsics'. The " +
                "pixels and the IMU series are still worth having; a fabricated focal " +
                "length would not be.",
        )
    }

    // ════════════════════════════════════════════════════════════════════
    //  IMU
    // ════════════════════════════════════════════════════════════════════

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            try {
                val type = when (e.sensor.type) {
                    Sensor.TYPE_ROTATION_VECTOR -> "rotation-vector"
                    Sensor.TYPE_GAME_ROTATION_VECTOR -> "game-rotation-vector"
                    else -> return
                }
                // getQuaternionFromVector reads values[0..2] and, when present,
                // values[3]. Some devices deliver 3, 4 or 5 elements; copying
                // the first min(len,4) is the shape it accepts on all of them.
                val n = minOf(e.values.size, 4)
                if (n < 3) return
                val src = FloatArray(n)
                System.arraycopy(e.values, 0, src, 0, n)
                val wxyz = FloatArray(4)
                SensorManager.getQuaternionFromVector(wxyz, src)   // [w, x, y, z]
                // THE ONE PLACE THE ORDER IS SWAPPED. Android returns
                // [w, x, y, z]; the pack, the engine and every consumer use
                // [x, y, z, w]. `qDevice` and the mapped `q` both descend from
                // this array, so they cannot be built on different readings of
                // the same four floats.
                val q = panoQuatFromSensorWxyz(wxyz)
                // Sampled HERE, inside the delivering callback, not later: this
                // is the only reading that makes the sample's age measurable
                // against the frame path without assuming the sensor and camera
                // clocks share an epoch.
                val deliveredElapsedNs = SystemClock.elapsedRealtimeNanos()
                val s = ImuSample(
                    e.timestamp, q[0], q[1], q[2], q[3],
                    e.accuracy, type, deliveredElapsedNs,
                )
                // ── WHICH SERIES DRIVES THE GEOMETRY (see cfg.attitudeMagFree) ──
                // Until 2026-09-10 this was a hardcode on TYPE_ROTATION_VECTOR
                // with no flag and no meta field, and that hardcode is what put
                // the compass into the canvas. Both series are still logged
                // whichever one drives; only the driver moves.
                val drivingType =
                    if (cfg.attitudeMagFree) Sensor.TYPE_GAME_ROTATION_VECTOR
                    else Sensor.TYPE_ROTATION_VECTOR
                // The heading-drift witness. The two series differ ONLY by the
                // magnetometer, so their relative rotation over the sweep is
                // exactly the quantity in dispute: on the mag arm it is the
                // compass pull that leans the band, and on the mag-free arm it
                // is the gyro yaw drift that is the price of removing it. Same
                // number, both arms, so the trade is measurable from any pack.
                if (e.sensor.type == Sensor.TYPE_GAME_ROTATION_VECTOR) {
                    gameLatest.set(s)
                } else {
                    magLatest.set(s)
                }
                run {
                    val m = magLatest.get()
                    val g = gameLatest.get()
                    // Pair them only when both are fresh against each other, so
                    // the divergence is a rotation between two readings of the
                    // same instant rather than of two different poses.
                    if (m != null && g != null &&
                        kotlin.math.abs(m.tsNs - g.tsNs) < 25_000_000L
                    ) {
                        if (divFirst == null) divFirst = Pair(m, g)
                        divLast = Pair(m, g)
                    }
                }
                if (e.sensor.type == drivingType) {
                    // Only the driving series feeds `tracking` and `qDevice`; the
                    // other rides along as evidence for the S1 basis run.
                    imuLatest.set(s)
                    // The ring feeds the PER-FRAME bracket. Fed unconditionally,
                    // even when no basis authority exists: an offline pass that
                    // later picks a basis reads sensors.jsonl, but the pack's
                    // own counters must describe the same series either way, and
                    // a ring that only filled on the mapping arm would make the
                    // two arms' diagnostics incomparable.
                    attitudeRing.add(e.timestamp, q[0], q[1], q[2], q[3])
                    imuCount.incrementAndGet()
                    if (imuFirstTsNs == 0L) imuFirstTsNs = e.timestamp
                    imuLastTsNs = e.timestamp
                    imuTsMinusElapsed.add((e.timestamp - deliveredElapsedNs).toDouble())
                    val idx = (e.accuracy + 1).coerceIn(0, imuAccuracyHist.size - 1)
                    imuAccuracyHist[idx]++
                } else {
                    gameImuCount.incrementAndGet()
                }
                sensorsW?.write(
                    Jo().s("type", type)
                        .i("tsNs", e.timestamp)
                        .raw("q", jarr(s.x, s.y, s.z, s.w))
                        .n("tS", e.timestamp / 1e9)
                        .i("accuracy", e.accuracy)
                        .i("elapsedRealtimeNsAtDelivery", deliveredElapsedNs)
                        .end() + "\n",
                )
                if ((imuCount.get() % 200L) == 0L) sensorsW?.flush()
            } catch (t: Throwable) {
                Log.w(TAG, "onSensorChanged threw", t)
            }
        }
        override fun onAccuracyChanged(s: Sensor?, accuracy: Int) {}
    }

    /**
     * Decide, once per sweep, whether `q` may be written from the IMU — and
     * under whose authority.
     *
     * TWO INDEPENDENT GATES, BOTH FROM THE DEVICE, NEITHER FROM A CONSTANT:
     *
     *   · THE BASIS. `deriveBasis()` on the characteristics of the camera
     *     actually OPENED, outranked by a `measuredBasisIndex` option when one
     *     was supplied. Neither ⇒ identity, and the pack names the refusal.
     *   · THE CLOCK. `SENSOR_INFO_TIMESTAMP_SOURCE` re-read here on every
     *     start. REALTIME is the only value that makes bracketing a camera
     *     timestamp between two `SensorEvent.timestamp`s a defined operation;
     *     anything else ⇒ identity, because the join would otherwise cross an
     *     unknown epoch and produce plausible quaternions on the wrong frames.
     *
     * ⚠ READ FROM `effChars`, NOT FROM `chosen`. When the recorder bound a
     * physical sub-camera the pixels — and therefore the raster
     * SENSOR_ORIENTATION describes — come from THAT sensor, while `chosen`
     * may still be the logical device. `C` is a statement about the raster, so
     * it must be derived from the same characteristics the intrinsics were.
     */
    private fun resolveAttitudeMapping(characteristics: CameraCharacteristics) {
        val orient = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION)
        val facing = characteristics.get(CameraCharacteristics.LENS_FACING)
        val tsName = timestampSourceName(
            characteristics.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE),
        )
        val gate = panoAttitudeClockGate(tsName)
        clockGate = gate

        // −1 rather than a default of 0: an unread SENSOR_ORIENTATION is
        // refused BY NAME downstream, and 0 is a legal value that would derive
        // a plausible basis for a configuration nobody observed.
        val res = PanoPlusNativeBasis.resolve(
            sensorOrientationDeg = orient ?: -1,
            // LENS_FACING_BACK when the characteristic is missing would be a
            // guess about the optical axis, so an absent value goes through as
            // an out-of-range int and the derivation refuses it.
            lensFacing = facing ?: -1,
            measuredBasisIndex = cfg.measuredBasisIndex,
        )
        basis = res
        attitudeMapping = res.usable && gate.joinable

        if (orient != null && sensorOrientation != null && orient != sensorOrientation) {
            advise(
                "SENSOR_ORIENTATION differs between the camera this recorder SELECTED " +
                    "($sensorOrientation°) and the stream it is RECORDING ($orient°, the " +
                    "physically-bound sub-camera). The basis was derived from the recording " +
                    "stream's value, which is the raster the pack carries.",
            )
        }
        res.nativeError?.let {
            advise(
                "the pano+ native half did not load, so no basis could be derived and `q` " +
                    "stays IDENTITY on every row: $it",
            )
        }
        if (!gate.joinable) advise("attitude map DISABLED — ${gate.reason}")
        if (res.usable && !gate.joinable) {
            advise(
                "a basis WAS available (index ${res.authority.index} '${res.label}', " +
                    "${res.authority.authority}) and went UNUSED because the clock gate " +
                    "refused. sensors.jsonl carries the full series; an offline pass that can " +
                    "establish the camera↔sensor epoch offset can still map this pack.",
            )
        }
        if (attitudeMapping) {
            advise(
                "attitude map ACTIVE: q = rotation-vector × C, basis index " +
                    "${res.authority.index} '${res.label}' (${res.authority.authority}), " +
                    "bracketed and SLERPed within ${cfg.attitudeMaxBracketMs}ms, tau=0 " +
                    "UNCORRECTED. Every row says so in qSource; qDevice still carries the raw " +
                    "sample. ${res.authority.note}",
            )
        } else {
            advise(
                "attitude map INACTIVE: `q` is identity with qSource:\"none\" on every row — " +
                    "this pack replays on the PLANAR arm. ${res.authority.note}",
            )
        }
    }

    private fun startImu() {
        try {
            val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            sensorMgr = sm
            if (sm == null) { advise("SENSOR_SERVICE unavailable — sensors.jsonl will be empty"); return }
            rotVec = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
            gameRotVec = sm.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
            if (rotVec == null) {
                advise(
                    "TYPE_ROTATION_VECTOR is not present on this device — there is NO attitude " +
                        "series in this pack, and `tracking` will be 0 on every row",
                )
            } else {
                sm.registerListener(sensorListener, rotVec, SensorManager.SENSOR_DELAY_FASTEST, sensorH)
            }
            // GAME_ROTATION_VECTOR carries no magnetometer, so it has no
            // mag-jump artefacts over a ten-second sweep. Logged BESIDE the
            // primary so the offline S1 run can choose; it drives nothing here.
            if (gameRotVec != null) {
                sm.registerListener(
                    sensorListener, gameRotVec, SensorManager.SENSOR_DELAY_FASTEST, sensorH,
                )
            }
        } catch (t: Throwable) {
            advise("IMU registration threw ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  Pack files
    // ════════════════════════════════════════════════════════════════════

    /**
     * The written-frame index the ARCore channel matches its poses against.
     *
     * ⚠ THIS MATCH IS LIVE, AND IT IS SYSTEMATICALLY LAGGED. The ring holds
     * only frames that have already been ENCODED, and on a shared session the
     * `CaptureResult` that feeds the writer arrives ~116 ms after its own
     * sensor timestamp (measured on SM-A356U1) while ARCore's pump sees the
     * frame sooner — so every lookup resolved about two frame periods back,
     * with a delta near −66 ms on all 738 rows of the first shared sweep.
     *
     * That is why the value NAMES itself `live-…`, and why the authoritative
     * join is OFFLINE on `tsNs`, which is exact on every row. Reporting the
     * lagged seq without saying so would be a two-frame lie in the field the
     * whole A/B is joined on.
     *
     * `no-frame-written-yet` is a real answer and must stay one: `update()`
     * can return before anything has been encoded at all.
     */
    // ════════════════════════════════════════════════════════════════════
    //  THE AR POSE ARM — sink, wait, solve
    // ════════════════════════════════════════════════════════════════════

    /**
     * ARCore's pose, straight into the live ring. Runs on the ARCore PUMP
     * THREAD; see [ArCorePoseSink] for why it may not block.
     *
     * ⚠ TRACKING POSES ONLY. A pose from a PAUSED/STOPPED session is ARCore's
     * LAST KNOWN one, not a measurement of now, and inserting it would make the
     * ring interpolate smoothly across a tracking loss — the engine would paint
     * a strip advance that never happened and the seam would look like a real
     * one. Dropped and counted instead; the frames that then find no bracket
     * refuse honestly, and the engine holds.
     */
    private val arPoseSink = ArCorePoseSink { tsNs, x, y, z, w, tracking ->
        if (!tracking) {
            arPoseDroppedNotTracking.incrementAndGet()
            return@ArCorePoseSink
        }
        // `add` refuses a non-monotonic or non-finite sample and counts it
        // itself, so a false return is already recorded in the ring.
        if (arPoseRing.add(tsNs, x, y, z, w)) arPoseAccepted.incrementAndGet()
        // WAKE THE WAITER UNCONDITIONALLY, even on a refused insert: a frame
        // waiting on this monitor must re-check its predicate rather than
        // sleep out its whole budget behind a sample the ring rejected.
        synchronized(arPoseLock) { (arPoseLock as Object).notifyAll() }
    }

    /**
     * The AR arm's attitude for one frame — bracket, wait if it has to, SLERP.
     *
     * The wait is the whole difference from the IMU path and the reason this is
     * a function rather than one more `if` at the call site. See
     * [Config.arPoseWaitMs]: the ARCore series is produced by the same capture
     * as the pixels, so "is the bracketing sample here yet" is a race about
     * half of frames lose, and losing it is `after-last-sample` on a frame that
     * had a perfectly good pose 3 ms later.
     *
     * ⚠ RUNS ON THE WRITER THREAD ONLY. Never on RN's NativeModules queue: the
     * whole reason `start()` hands off to `Dispatchers.IO` is that a block
     * there wedges every native module in the app.
     */
    private fun solveArPose(tsNs: Long): PanoAttitudeSolution {
        var sol = arPoseRing.solve(tsNs, arAttitudeMaxBracketNs)
        if (sol.ok || arPoseWaitNs <= 0L) {
            if (sol.ok) arPoseSolved.incrementAndGet()
            else arPoseRefusalCounts.merge(sol.refusal, 1L) { a, b -> a + b }
            return sol
        }
        // ONLY `after-last-sample` IS WORTH WAITING FOR. `before-first-sample`
        // means the frame predates the ARCore series and no future sample can
        // bracket it; `bracket-too-wide` means the two samples that DO straddle
        // it are further apart than the gap allows, and waiting cannot narrow a
        // gap that already exists. Waiting on either would spend the budget on
        // a certainty.
        if (sol.refusal != PanoAttitudeRefusal.AFTER_LAST_SAMPLE) {
            arPoseRefusalCounts.merge(sol.refusal, 1L) { a, b -> a + b }
            return sol
        }
        arPoseWaited.incrementAndGet()
        val t0 = SystemClock.elapsedRealtimeNanos()
        val deadline = t0 + arPoseWaitNs
        synchronized(arPoseLock) {
            while (true) {
                val leftNs = deadline - SystemClock.elapsedRealtimeNanos()
                if (leftNs <= 0L) break
                try {
                    (arPoseLock as Object).wait(leftNs / 1_000_000L, (leftNs % 1_000_000L).toInt())
                } catch (_: InterruptedException) {
                    // Teardown. Restore the flag and stop waiting — the frame
                    // refuses, which is the correct answer for a sweep that is
                    // ending.
                    Thread.currentThread().interrupt()
                    break
                }
                // RE-SOLVE INSIDE THE LOOP rather than trusting the wake. A
                // `notifyAll` fires on every insert including refused ones, and
                // spurious wakeups are permitted by the JLS.
                sol = arPoseRing.solve(tsNs, arAttitudeMaxBracketNs)
                if (sol.ok || sol.refusal != PanoAttitudeRefusal.AFTER_LAST_SAMPLE) break
            }
        }
        arPoseWaitMsStat.add((SystemClock.elapsedRealtimeNanos() - t0) / 1e6)
        if (sol.ok) {
            arPoseSolved.incrementAndGet()
        } else {
            if (sol.refusal == PanoAttitudeRefusal.AFTER_LAST_SAMPLE) {
                arPoseWaitTimedOut.incrementAndGet()
            }
            arPoseRefusalCounts.merge(sol.refusal, 1L) { a, b -> a + b }
        }
        return sol
    }

    private val arcoreFrameIndex = object : ArCoreFrameIndex {
        override fun match(tsNs: Long): ArCoreMatch {
            synchronized(frameRingLock) {
                if (frameRingCount == 0) {
                    return ArCoreMatch("no-frame-written-yet", -1L, 0L)
                }
                val n = minOf(frameRingCount, frameTsRing.size)
                var bestIdx = -1
                var bestDelta = Long.MAX_VALUE
                for (i in 0 until n) {
                    val d = frameTsRing[i] - tsNs
                    val ad = if (d < 0) -d else d
                    if (ad < bestDelta) { bestDelta = ad; bestIdx = i }
                }
                if (bestIdx < 0) return ArCoreMatch("no-frame-written-yet", -1L, 0L)
                val delta = frameTsRing[bestIdx] - tsNs
                return if (delta == 0L) {
                    ArCoreMatch("live-exact-sensor-timestamp", frameSeqRing[bestIdx], 0L)
                } else {
                    ArCoreMatch("live-nearest-written-frame", frameSeqRing[bestIdx], delta)
                }
            }
        }
    }

    /** One finished pose row. Synchronised because the pump thread and the
     *  shutdown flush are different threads and a BufferedWriter is not
     *  thread-safe — an interleaved write would corrupt the row that the
     *  basis run then reads as malformed. */
    private fun writeArCoreRow(row: String) {
        synchronized(arcoreWLock) {
            val w = arcoreW
            if (w == null) {
                // The pump can produce one more pose between the ledger being
                // closed and its own exit. COUNTED, because the channel's
                // `rowsWritten` increments on emit and would otherwise
                // overstate what is on disk by exactly these rows — and a pack
                // whose counter disagrees with its own file is a pack nobody
                // can reason from.
                arcoreRowsAfterClose++
                return
            }
            try {
                w.write(row)
                w.write("\n")
                val n = arcore?.rowsWritten() ?: 0L
                if ((n % 60L) == 0L) w.flush()
            } catch (t: Throwable) {
                arcoreRowWriteFailed++
                Log.w(TAG, "attitude_arcore.jsonl write threw", t)
            }
        }
    }

    /**
     * Open the native live session over this pack directory.
     *
     * Sets [liveActive] ONLY when the engine actually started. That distinction
     * is the whole reason this is a method and not a flag copy: a request to
     * run live and a live session that opened are different facts, and rows
     * written under a false claim would name an engine that never ran.
     */
    private fun startLiveEngine() {
        val dir = try { packDir.absolutePath } catch (t: Throwable) {
            liveStartError = "pack directory was not initialised: " +
                "${t.javaClass.simpleName}: ${t.message}"
            return
        }
        val json = PanoPlusLiveNative.start(
            sessionDir = dir,
            packFramesMode = packFramesMode,
            // The recorder's own cadence/cap/quality knobs drive the pack
            // frames, so a live sweep and a recorded sweep produce the same
            // files under the same names when both are asked for them.
            packFrameEveryN = 1,
            packFrameQuality = cfg.jpegQuality,
            packMaxFrames = cfg.maxFrames,
            canvasQuality = cfg.liveCanvasQuality,
            canvasCropPad = cfg.liveCanvasCropPad,
            previewIntervalMs = cfg.livePreviewIntervalMs,
            previewMaxDutyPct = cfg.livePreviewMaxDutyPct,
            previewQuality = cfg.livePreviewQuality,
            previewMaxAlong = cfg.livePreviewMaxAlong,
            previewMaxCross = cfg.livePreviewMaxCross,
            previewWindowCrossMult = cfg.livePreviewWindowCrossMult,
            previewWindowAlongPx = 0,
            previewCropPad = cfg.livePreviewCropPad,
            previewLeadOut = cfg.livePreviewLeadOut,
            writeLedger = cfg.liveWriteLedger,
            // ⚠ THE ARM THAT RAN, not the one asked for. `meta.json`'s
            // `poseSource` is the field an RCA reads to know which series
            // painted the pixels, and a sweep whose ARCore channel refused
            // ran on the IMU whatever the bag said. `arArmActive` is already
            // resolved by here — it is decided in `start()` before the camera
            // opens, precisely so this line can be honest.
            poseSource = if (arArmActive) "ar" else "imu",
            captureJson = liveCaptureJson(),
            configOverrides = cfg.liveConfigOverrides,
        )
        liveStartJson = json
        // The payload is a JSON string this class does not parse (the same rule
        // PanoPlusAndroidModule states: parsing here would be a second
        // marshalling layer whose only job is to lose fields). The ONE bit it
        // needs is success, and `"ok":true` is emitted by exactly one writer in
        // exactly one form.
        if (json.contains("\"ok\":true")) {
            liveActive = true
        } else {
            liveStartError = json
            advise(
                "THE LIVE ENGINE DID NOT START — this sweep is a plain RECORDING. The pack " +
                    "and its track rows are complete and replayable, but no canvas will grow " +
                    "on screen and stop() will return no panorama. The native reason is in " +
                    "live.startError. Most often this is a STALE .so: assembleDebug reports " +
                    "SUCCESS without relinking libimage_stitcher_panoplus.so after a cpp/ edit.",
            )
        }
    }

    /**
     * The capture arm's own provenance, written verbatim into
     * `meta.json -> capture` by the live session.
     *
     * It exists because the engine cannot know any of it and must not invent
     * it: which camera was opened, at what raster, whether the AE lock was
     * asked for, and — the load-bearing one — WHICH BASIS the quaternions on
     * every row were built with and whether it was DERIVED or MEASURED. A live
     * canvas that comes out rotated is attributable in one glance from this
     * block and from nowhere else.
     */
    private fun liveCaptureJson(): String = try {
        Jo()
            .s("cameraId", chosen?.id)
            .s("physicalId", boundPhysicalId)
            .i("width", outSize?.width)
            .i("height", outSize?.height)
            .i("sensorOrientationDeg", sensorOrientation)
            .s("sizeChoiceReason", sizeChoiceReason)
            .s("fpsRange", fpsRange?.toString())
            .b("attitudeMapActive", attitudeMapping)
            .s("qSource", if (attitudeMapping) basis?.authority?.qSource else PANO_Q_SOURCE_NONE)
            .i("qBasisIndex", if (attitudeMapping) basis?.authority?.index ?: -1 else -1)
            .s("qBasisLabel", if (attitudeMapping) basis?.label else null)
            .s("qBasisAuthority", if (attitudeMapping) basis?.authority?.authority else null)
            .s("qBasisDerivedRefusal", basis?.derivedRefusal)
            // τ IS ZERO AND UNCORRECTED. ~97 ms of camera pipeline latency
            // between the two clock domains is not compensated on this leg;
            // saying so in the pack is the difference between a known
            // approximation and an unexamined one.
            .n("attitudeTauS", 0.0)
            .b("attitudeTauCorrected", false)
            .s("intrinsicsSource", intrinsicsSource)
            .b("aeLockRequested", true)
            .raw("aeLockReadBack", aeLockObserved?.toString() ?: "null")
            .raw("awbLockReadBack", awbLockObserved?.toString() ?: "null")
            .end()
    } catch (t: Throwable) {
        // A provenance block that throws must not take the sweep with it; an
        // empty string is dropped by the native side and named there.
        Log.w(TAG, "building the live capture provenance threw", t)
        ""
    }

    private fun openPack() {
        val base = cfg.sessionDir?.removePrefix("file://")?.let { File(it) }
            ?: File(
                ctx.getExternalFilesDir(null) ?: ctx.filesDir,
                "panoplus-android-${System.currentTimeMillis()}",
            )
        packDir = File(base, "panoplus")
        framesDir = File(packDir, "frames")
        if (!framesDir.exists() && !framesDir.mkdirs() && !framesDir.isDirectory) {
            throw IllegalStateException("could not create ${framesDir.absolutePath}")
        }
        // ── THE FRAMES DIR IS TRUNCATED TOO ─────────────────────────────
        // The two writers below open with FileOutputStream, which TRUNCATES —
        // so a reused pack directory starts with an empty track.jsonl and an
        // empty sensors.jsonl but a frames/ dir still holding the previous
        // sweep. `seq` restarts at 0, so the new rows overwrite frames 000000…
        // upward and every frame ABOVE the new sweep's last seq survives as an
        // orphan. Nothing in the pack marks them: the harness joins by seq, so
        // it never opens them, but a person browsing frames/ (or any tool that
        // counts files) reads two sweeps as one. Frames must follow the same
        // truncate rule the ledgers already have.
        var stale = 0
        var staleUnremovable = 0
        try {
            framesDir.listFiles()?.forEach { f ->
                if (f.isFile && f.name.startsWith("frame_") && f.name.endsWith(".jpg")) {
                    if (f.delete()) stale++ else staleUnremovable++
                }
            }
        } catch (t: Throwable) {
            // Reported, not fatal: a pack that records over a stale frame is
            // still better than no pack, as long as it SAYS so.
            advise(
                "could not enumerate ${framesDir.absolutePath} to clear it: " +
                    "${t.javaClass.simpleName}: ${t.message}",
            )
        }
        if (stale > 0) {
            advise(
                "$stale stale frame(s) from a previous sweep were deleted from " +
                    "${framesDir.absolutePath} before recording — the pack directory was reused",
            )
        }
        if (staleUnremovable > 0) {
            advise(
                "$staleUnremovable stale frame(s) in ${framesDir.absolutePath} could NOT be " +
                    "deleted. Any of them above this sweep's last seq will remain in the pack " +
                    "and belong to the PREVIOUS sweep — the track rows are authoritative, the " +
                    "extra files are not",
            )
        }
        trackW = BufferedWriter(
            OutputStreamWriter(FileOutputStream(File(packDir, "track.jsonl")), Charsets.UTF_8),
            1 shl 16,
        )
        sensorsW = BufferedWriter(
            OutputStreamWriter(FileOutputStream(File(packDir, "sensors.jsonl")), Charsets.UTF_8),
            1 shl 16,
        )
        // Created ONLY when a channel actually opened. A pack that carries an
        // empty attitude_arcore.jsonl is saying "ARCore ran and saw nothing",
        // which is a completely different — and much worse — claim than "no
        // reference channel was requested". The S1 runner distinguishes the two
        // by the file's absence.
        if (arcore != null) {
            arcoreW = BufferedWriter(
                OutputStreamWriter(
                    FileOutputStream(File(packDir, "attitude_arcore.jsonl")), Charsets.UTF_8,
                ),
                1 shl 16,
            )
        }
    }

    private fun aeStateName(v: Int?): String = when (v) {
        CaptureResult.CONTROL_AE_STATE_INACTIVE -> "INACTIVE"
        CaptureResult.CONTROL_AE_STATE_SEARCHING -> "SEARCHING"
        CaptureResult.CONTROL_AE_STATE_CONVERGED -> "CONVERGED"
        CaptureResult.CONTROL_AE_STATE_LOCKED -> "LOCKED"
        CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED -> "FLASH_REQUIRED"
        CaptureResult.CONTROL_AE_STATE_PRECAPTURE -> "PRECAPTURE"
        null -> "unobserved"
        else -> "unrecognised($v)"
    }

    private fun awbStateName(v: Int?): String = when (v) {
        CaptureResult.CONTROL_AWB_STATE_INACTIVE -> "INACTIVE"
        CaptureResult.CONTROL_AWB_STATE_SEARCHING -> "SEARCHING"
        CaptureResult.CONTROL_AWB_STATE_CONVERGED -> "CONVERGED"
        CaptureResult.CONTROL_AWB_STATE_LOCKED -> "LOCKED"
        null -> "unobserved"
        else -> "unrecognised($v)"
    }

    /**
     * The clock verdict, stated as a RULE with its evidence attached rather
     * than as a bare boolean.
     *
     * `SENSOR_TIMESTAMP` and `SensorEvent.timestamp` are each sampled against
     * `SystemClock.elapsedRealtimeNanos()` at the moment of DELIVERY. If both
     * offsets are small and negative — a pipeline latency, not an epoch gap —
     * the two series are on one timeline and `align()`'s `tauS` is a latency
     * to fit. If either is enormous, they are not, and no offline pass should
     * subtract one from the other.
     */
    private fun clockVerdict(): Pair<Boolean, String> {
        val camN = camTsMinusElapsed.count()
        val imuN = imuTsMinusElapsed.count()
        if (camN == 0L || imuN == 0L) {
            return false to
                "UNDECIDED: camera offset samples=$camN, IMU offset samples=$imuN — at least " +
                "one series is empty, so nothing was compared."
        }
        val src = timestampSourceName(effChars?.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE))
        return true to
            "RULE: both SENSOR_TIMESTAMP and SensorEvent.timestamp were sampled against " +
            "SystemClock.elapsedRealtimeNanos() at delivery; see clocks.cameraTsMinusElapsedNs " +
            "and clocks.imuTsMinusElapsedNs. If both p50 values are within a few tens of " +
            "milliseconds of zero the two series share the elapsedRealtime epoch and their " +
            "difference is a pipeline latency (align()'s tauS). If the camera's is far from " +
            "zero it is on the uptime/boot clock instead and the two must NOT be differenced. " +
            "SENSOR_INFO_TIMESTAMP_SOURCE on this camera is $src. This recorder does not " +
            "decide; it records both so the offline pass can."
    }

    /**
     * The attitude map's whole audit trail: both gates, the basis and its
     * provenance, the per-frame refusal buckets, and the one number that says
     * whether the map is alive.
     *
     * ⚠ `firstToLastMappedDeg` IS THE HEADLINE. The identity arm's failure was
     * legible in exactly that figure — 0.00° across 152 frames while ARCore
     * recorded 57.1° over the same pixels — so a sweep that still reports ~0°
     * over a real pan has a dead map, whatever the counters say. It is
     * reported as −1 when fewer than two frames were mapped, never as 0: a
     * zero here must mean "measured and zero", not "nothing to measure".
     */
    private fun attitudeMapJson(): String {
        val b = basis
        val g = clockGate
        val refusals = Jo()
        var refusedTotal = 0L
        for (k in listOf(
            PanoAttitudeRefusal.BUFFER_EMPTY,
            PanoAttitudeRefusal.BEFORE_FIRST_SAMPLE,
            PanoAttitudeRefusal.AFTER_LAST_SAMPLE,
            PanoAttitudeRefusal.BRACKET_TOO_WIDE,
            PanoAttitudeRefusal.NON_FINITE,
        )) {
            val n = attitudeRefusalCounts[k] ?: 0L
            refusedTotal += n
            refusals.i(k, n)
        }
        val f = attitudeFirstQ
        val l = attitudeLastQ
        return Jo()
            .b("active", attitudeMapping)
            .s(
                "qSourceWhenMapped",
                if (attitudeMapping) b?.authority?.qSource else PANO_Q_SOURCE_NONE,
            )
            .s("basisAuthority", b?.authority?.authority ?: PANO_BASIS_AUTHORITY_NONE)
            .i("basisIndex", b?.authority?.index ?: -1)
            .s("basisLabel", b?.label ?: "invalid")
            .s("basisAuthorityNote", b?.authority?.note)
            // The DERIVED index rides here even when a measured one outranked
            // it: that pair IS the falsification, and a pack that dropped the
            // loser could not report the disagreement it exists to find.
            .i("derivedBasisIndex", b?.derivedIndex ?: -1)
            .s("derivedBasisRefusal", b?.derivedRefusal)
            .i("basisCandidateCount", (b?.candidateCount ?: 0).toLong())
            .s("nativeError", b?.nativeError)
            .s(
                "basisProvenanceRule",
                "A DERIVED basis is NEVER stamped `measured` — rnis_pano_android_basis.hpp is " +
                    "explicit that two documented frames multiplied together is a hypothesis " +
                    "about the sensor mounting, not a measurement of it. `measured` here means " +
                    "an index supplied through the measuredBasisIndex option, which asserts " +
                    "that selectBasis() ran against a reference log.",
            )
            .b("clockJoinable", g?.joinable ?: false)
            .s("clockReason", g?.reason)
            .b("tauUncorrected", true)
            .n("tauS", 0.0)
            .s(
                "tauNote",
                "tau is 0 and NOT measured. The clock gate establishes only that the two " +
                    "series share an EPOCH; the residual pipeline latency between " +
                    "SENSOR_TIMESTAMP and SensorEvent.timestamp on this device has not been " +
                    "fitted, so every mapped q is offset by that latency. align() models it " +
                    "as tauS — this pack hands an offline pass the data to fit it.",
            )
            .n("maxBracketMs", cfg.attitudeMaxBracketMs)
            .n("arMaxBracketMs", cfg.arAttitudeMaxBracketMs)
            .s(
                "bracketRule",
                "The frame's tsNs is bracketed between the two nearest rotation-vector samples " +
                    "and SLERPed. A frame outside the retained window, or one whose bracket is " +
                    "wider than maxBracketMs, is REFUSED and counted below — never " +
                    "extrapolated — and its row carries the identity with tracking forced to 0.",
            )
            // ⚠ SCOPE, NOT A TOTAL, WHEN THE ARM CHANGED MID-SWEEP. This
            // block reads as the whole sweep's attitude policy, and it is —
            // unless the AR arm was given up partway, in which case the map
            // only ran from that seq onward and every counter below counts
            // the tail, not the sweep. Without this a reader divides
            // `framesMapped` by the sweep's frame count and concludes the
            // map refused the difference; the frames before the degrade
            // were never OFFERED to it (the merge at the fork is guarded by
            // `else if (!arArmActive)`).
            .i("activeFromSeq", if (arArmDegraded) arArmDegradedAtSeq else 0L)
            .b("scopedToPartOfSweep", arArmDegraded)
            .i("framesMapped", attitudeMapped.get())
            .i("framesRefused", refusedTotal)
            .raw("refusals", refusals.end())
            .i("ringSamples", attitudeRing.sampleCount())
            .i("ringNonMonotonicRejected", attitudeRing.nonMonotonicCount())
            .n(
                "firstToLastMappedDeg",
                if (f != null && l != null && attitudeMapped.get() >= 2)
                    panoQuatDeltaDeg(f, l)
                else -1.0,
            )
            .n(
                "lastMappedAngleFromIdentityDeg",
                if (l != null) panoQuatAngleDeg(l) else -1.0,
            )
            .end()
    }

    /** Serialised: the "recording-started" snapshot runs on an IO coroutine
     *  while a stop() could arrive, and two interleaved writers would leave a
     *  device.json that parses as far as it goes — worse than none. */
    @Synchronized
    private fun writeDeviceJson(phase: String, reprobeCameras: Boolean = true) {
        try {
            val cam = chosen
            val size = outSize
            val (comparable, verdict) = clockVerdict()
            val nowElapsed = SystemClock.elapsedRealtimeNanos()
            val writtenN = framesWritten.get()
            val sweepS = if (firstTsNs != 0L && lastTsNs > firstTsNs)
                (lastTsNs - firstTsNs) / 1e9 else 0.0
            val resultSweepS = if (firstResultTsNs != 0L && lastResultTsNs > firstResultTsNs)
                (lastResultTsNs - firstResultTsNs) / 1e9 else 0.0

            val json = Jo()
                .s("schema", "imagestitcher.panoplus.android.device/1")
                .s("phase", phase)
                .s(
                    "purpose",
                    if (arcore?.modeRan == "standalone")
                        "ARCore STANDALONE reference run: NO PIXELS. ARCore owned the camera, " +
                            "so this pack carries the raw rotation-vector series and a " +
                            "simultaneous ARCore world<-camera series and nothing else. It " +
                            "answers the BASIS question (selectBasis needs only the two " +
                            "attitude series) and it CANNOT answer the pose-arm A/B, which " +
                            "needs the same pixels replayed twice. Nothing in this pack is " +
                            "estimated, fused or corrected."
                    else
                        "Recorder-only pack: pixels + camera metadata + a raw attitude series, " +
                            "in the format cpp/rnis_pano.* and the offline twin " +
                            "already replay. No engine ran on device. Nothing in this pack is " +
                            "estimated, fused or corrected." +
                            (if (arcore != null)
                                " An ARCore reference series rides beside it in " +
                                    "attitude_arcore.jsonl, recorded from the SAME shared " +
                                    "capture — see the arcore block for what that cost."
                            else ""),
                )
                .s("device", "${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE})")
                .s("androidRelease", Build.VERSION.RELEASE)
                .i("sdkInt", Build.VERSION.SDK_INT)
                .s("packDir", packDir.absolutePath)

                // ── What was chosen, and why ────────────────────────────
                .raw(
                    "selection", Jo()
                        .s("cameraIdOpened", cam?.id)
                        .s("cameraIdRequested", cfg.cameraId)
                        // ⚠ THE OVERRIDE, NAMED IN THE BLOCK THAT MAKES THE
                        // CLAIM. `arcore.channel.cameraIdChosenByArCore` has
                        // carried this all along, but a reader checking HOW the
                        // camera was chosen reads `selection`, and `selection`
                        // used to answer with a rule that had not run.
                        .s("cameraIdForcedByArCore", forcedCameraIdByArCore)
                        // ── THE LENS (2026-09-03) ───────────────────────
                        // `lensRan` on EVERY pack, requested or not: a reader
                        // comparing two canvases must not have to infer the
                        // lens from hFovDeg. `lensHonoured` false + the note is
                        // how a 0.5x request that ran 1x (no ultra-wide on the
                        // device; the AR arm) stays attributable.
                        .s("lensRequested", lensRequested?.wire)
                        .s("lensRan", lensRan?.wire)
                        .b("lensHonoured", lensHonoured)
                        .s("lensNote", lensNote)
                        .s(
                            "lensBandRule",
                            "vision-camera's bands on horizontal FOV — >94° ultra-wide (0.5x), " +
                                "60-94° wide (1x) — the same rule the Pano segment's chip uses " +
                                "on Android (CameraDeviceDetails.kt:241); 1x is the first " +
                                "wide-band back camera in getCameraIdList order, 0.5x the " +
                                "widest ultra-wide one. Absent lensRequested = the widest-FOV " +
                                "rule that shipped.",
                        )
                        .s(
                            "rule",
                            cameraSelectionRule(
                                openedCameraId = cam?.id,
                                requestedCameraId = cfg.cameraId,
                                forcedByArCoreId = forcedCameraIdByArCore,
                                arcoreModeRan = arcore?.modeRan,
                                wouldHaveCameraId = wouldHaveCameraId,
                                wouldHaveHFovDeg = wouldHaveHFovDeg,
                                lensRequestedLabel = lensRequested?.label,
                            ),
                        )
                        .n("hFovDeg", cam?.hFovDeg ?: Double.NaN)
                        .s("hFovWouldHaveBeenCameraId", wouldHaveCameraId)
                        .n("hFovWouldHaveBeenDeg", wouldHaveHFovDeg)
                        .s("physicalBindRoute", physicalBindRoute)
                        .s("boundPhysicalId", boundPhysicalId)
                        .i("sensorOrientation", sensorOrientation)
                        .s(
                            "orientationNote",
                            "Frames are written UNROTATED, in the sensor frame the intrinsics " +
                                "below describe, and carry no EXIF orientation tag. Rotate " +
                                "pixels and intrinsics together or neither.",
                        )
                        .end(),
                )

                // ── Format ──────────────────────────────────────────────
                .raw(
                    "format", Jo()
                        .s("output", size?.let { "${it.width}x${it.height}" })
                        .n(
                            "aspect",
                            if (size != null && size.height > 0)
                                size.width.toDouble() / size.height else Double.NaN,
                        )
                        .s("pixelFormat", "YUV_420_888 -> NV21 -> JPEG (android.graphics.YuvImage)")
                        .i("jpegQuality", cfg.jpegQuality.toLong())
                        .raw(
                            "planeLayoutObserved",
                            observedLayout?.toJson()
                                ?: jstr("no frame converted yet").let { "null" },
                        )
                        .i("planeLayoutChangedMidSweep", layoutChanged.get())
                        .raw(
                            "yuvSizesAvailable",
                            jarrStr((cam?.yuvSizes ?: emptyList()).map { it.toString() }),
                        )
                        .i("maxWidthOption", cfg.maxWidth.toLong())
                        // WHY this size, not merely which. Without it a pack
                        // recorded at 1280x960 is indistinguishable from one
                        // where the cap, the rate rung and the 4:3 filter each
                        // moved the answer — and the second sweep's operator
                        // has no idea which knob to turn.
                        .s("sizeChoiceReason", sizeChoiceReason.ifEmpty { null })
                        .n(
                            "chosenSizeMinFrameDurationNs",
                            if (chosenSizeMinFrameDurationNs >= 0)
                                chosenSizeMinFrameDurationNs.toDouble() else Double.NaN,
                        )
                        .n("chosenSizeMaxFpsPublished", chosenSizeMaxFps)
                        .s(
                            "chosenSizeRateNote",
                            "chosenSizeMaxFpsPublished is SCALER's minimum frame duration for " +
                                "this size, i.e. the ceiling the STREAM allows. The sweep also " +
                                "needs an AE target range that reaches it (requestedFpsRange " +
                                "below), and the encoder has to keep up " +
                                "(fpsWrittenMeasured vs fpsSensorDeliveredMeasured). All three " +
                                "are reported separately because any one of them can be the " +
                                "limit.",
                        )
                        .s("requestedFpsRange", fpsRange?.toString())
                        .s("fpsNote", fpsRequestedNote)
                        .raw(
                            "fpsRangesAvailable",
                            jarrStr((cam?.fpsRanges ?: emptyList()).map { it.toString() }),
                        )
                        .n(
                            "fpsWrittenMeasured",
                            if (sweepS > 0.0) (writtenN - 1) / sweepS else 0.0,
                        )
                        .n(
                            "fpsSensorDeliveredMeasured",
                            if (resultSweepS > 0.0) (resultTsCount - 1) / resultSweepS else 0.0,
                        )
                        .s(
                            "fpsNote2",
                            "fpsWrittenMeasured counts only frames that reached disk; " +
                                "fpsSensorDeliveredMeasured is the camera's real rate from " +
                                "consecutive CaptureResult timestamps. A large gap between " +
                                "them is encoder backpressure, not a slow sensor.",
                        )
                        .s("template", cfg.template)
                        .end(),
                )

                // ── The viewfinder ─────────────────────────────────────
                // In the pack because a HEADLESS sweep is a fact about the
                // EXPERIMENT, not about the recorder: the operator aimed at a
                // shelf he could not see, and a canvas that misses the top
                // shelf then has two candidate explanations instead of one.
                .raw(
                    "preview", Jo()
                        .b("attached", previewEverAttached)
                        .b("attachedNow", previewAttached)
                        .s("size", previewSize?.let { "${it.width}x${it.height}" })
                        .s("note", previewNote)
                        .s(
                            "meaning",
                            "attached:false means this sweep was recorded BLIND — the " +
                                "viewfinder was never a target of the capture session. It is " +
                                "STICKY: attachedNow is the live flag, which teardown clears " +
                                "before this file is written, so attachedNow:false in a " +
                                "phase:stop pack says nothing at all. The pack is complete and " +
                                "replayable either way — the preview is a second session " +
                                "output and touches neither the ImageReader's pixels nor the " +
                                "pose rows — but a BLIND sweep had its FRAMING chosen without " +
                                "a viewfinder.",
                        )
                        .end(),
                )

                // ── What was applied, and what was READ BACK ────────────
                .raw(
                    "applied", Jo()
                        .b("lockRequested", cfg.lockCamera)
            .n("aeSettleMs", aeSettleMs)
                        .i("aeSettleResults", aeSettleResults.toLong())
                        .s("aeSettleExitReason", aeSettleExitReason)
                        .s("meteringMemo", meteringMemoVerdict)
                        .n("meteringMemoAgeMs", meteringMemoAgeMsAtStart)
                        .s(
                            "settleTrace",
                            // [elapsedMs, exposureNs, iso, aeState, awbState] per
                            // CaptureResult, so the exit reason above is auditable
                            // against the numbers it was taken on rather than asserted.
                            settleTrace.joinToString(";") { r ->
                                "${r[0]},${r[1]},${r[2]},${aeStateName(r[3].toInt())}," +
                                    awbStateName(r[4].toInt())
                            },
                        )
                        .s("aeStateAtLock", aeStateName(aeStateAtLock))
                        .s("awbStateAtLock", awbStateName(awbStateAtLock))
                        .s(
                            "aeLockReadBack",
                            aeLockObserved?.toString() ?: "unobserved (no CaptureResult carried it)",
                        )
                        .s(
                            "awbLockReadBack",
                            awbLockObserved?.toString() ?: "unobserved (no CaptureResult carried it)",
                        )
                        .i("afModeRequested", afModeApplied)
                        .i("afModeReadBack", afModeObserved)
                        .n("focusDioptersRequested", focusRequestedDiopters)
                        .n("focusDioptersReadBack", focusObservedDiopters)
                        .i("lensStateReadBack", lensStateObserved)
                        .n(
                            "minimumFocusDistanceDiopters",
                            effChars?.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE),
                        )
                        .s("opticalStabilisation", oisApplied)
                        .s("videoStabilisation", evsApplied)
                        .s("zoomRatio", zoomApplied)
                        .rect("scalerCropRegionFirst", cropRegionFirst)
                        .b("scalerCropRegionChangedMidSweep", cropRegionChanged)
                        .raw("exposureTimeNs", exposureNsStat.toJson())
                        .raw("sensitivityIso", isoStat.toJson())
                        .s(
                            "lockEvidenceNote",
                            "A lock is proven by a FLAT exposureTimeNs/sensitivityIso trace " +
                                "across the sweep, not by the request having been sent. " +
                                "min==max on both is the lock reaching the pixels.",
                        )
                        .end(),
                )

                // ── Intrinsics ──────────────────────────────────────────
                .raw(
                    "intrinsics", Jo()
                        .s("intrinsicsSource", intrinsicsSource)
                        .b("arrayFrameValid", arrValid)
                        .n("arrayFx", arrFx).n("arrayFy", arrFy)
                        .n("arrayCx", arrCx).n("arrayCy", arrCy)
                        .s(
                            "arrayFrameNote",
                            "arrayFx..arrayCy are in PRE-CORRECTION ACTIVE ARRAY pixels. Every " +
                                "track row maps them (or the frame's own " +
                                "LENS_INTRINSIC_CALIBRATION) through that frame's " +
                                "SCALER_CROP_REGION onto the output size. constFx..constCy " +
                                "below are the same numbers through the FULL array — i.e. what " +
                                "the rows would carry if no crop were applied.",
                        )
                        .n("constFx", constFx).n("constFy", constFy)
                        .n("constCx", constCx).n("constCy", constCy)
                        .i("perFrameRows", intrinsicsPerFrameRows.get())
                        .i("totalRows", writtenN)
                        .s("note", intrinsicsNote.ifEmpty { null })
                        .rect(
                            "preCorrectionActiveArray",
                            effChars?.get(
                                CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE,
                            ),
                        )
                        .rect(
                            "activeArray",
                            effChars?.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE),
                        )
                        .s(
                            "pixelArray",
                            effChars?.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
                                ?.toString(),
                        )
                        .s(
                            "physicalSizeMm",
                            effChars?.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
                                ?.toString(),
                        )
                        .raw(
                            "focalLengthsMm",
                            effChars?.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                                ?.let { f -> jarr(*DoubleArray(f.size) { f[it].toDouble() }) }
                                ?: "null",
                        )
                        .raw(
                            "lensDistortion",
                            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                                effChars?.get(CameraCharacteristics.LENS_DISTORTION) else null)
                                ?.let { d -> jarr(*DoubleArray(d.size) { d[it].toDouble() }) }
                                ?: "null",
                        )
                        .s(
                            "distortionNote",
                            "LENS_DISTORTION is RECORDED, never applied. The frames are as the " +
                                "sensor delivered them; any undistortion is an offline decision.",
                        )
                        .end(),
                )

                // ── Clocks: the open question, made answerable ──────────
                .raw(
                    "clocks", Jo()
                        .s(
                            "cameraDomain",
                            "CaptureResult.SENSOR_TIMESTAMP (nanoseconds). track.jsonl `tsNs` " +
                                "is this value verbatim — never System.nanoTime.",
                        )
                        .s(
                            "cameraTimestampSource",
                            timestampSourceName(
                                effChars?.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE),
                            ),
                        )
                        .s(
                            "imuDomain",
                            "SensorEvent.timestamp (nanoseconds, device-defined; nominally " +
                                "SystemClock.elapsedRealtimeNanos). sensors.jsonl `tsNs` is " +
                                "this value verbatim and `tS` is it in seconds, which is the " +
                                "unit rnis::pano::AttitudeSample::tS expects.",
                        )
                        .raw("cameraTsMinusElapsedNs", camTsMinusElapsed.toJson())
                        .raw("imuTsMinusElapsedNs", imuTsMinusElapsed.toJson())
                        .b("clocksComparable", comparable)
                        .s("clocksVerdict", verdict)
                        .raw(
                            "anchorAtStart", Jo()
                                .n("wallMs", startWallMs)
                                .i("elapsedRealtimeNs", startElapsedNs)
                                .i("uptimeNs", startUptimeNs)
                                .end(),
                        )
                        .raw(
                            "anchorNow", Jo()
                                .n("wallMs", System.currentTimeMillis().toDouble())
                                .i("elapsedRealtimeNs", nowElapsed)
                                .i("uptimeNs", SystemClock.uptimeMillis() * 1_000_000L)
                                .end(),
                        )
                        .i("firstFrameTsNs", firstTsNs)
                        .i("lastFrameTsNs", lastTsNs)
                        .i("firstImuTsNs", imuFirstTsNs)
                        .i("lastImuTsNs", imuLastTsNs)
                        .end(),
                )

                // ── Attitude ────────────────────────────────────────────
                .raw(
                    "attitude", Jo()
                        .b("rotationVectorPresent", rotVec != null)
                        .b("gameRotationVectorPresent", gameRotVec != null)
                        .i("rotationVectorSamples", imuCount.get())
                        .i("gameRotationVectorSamples", gameImuCount.get())
                        // ── WHICH SERIES ACTUALLY DROVE THE GEOMETRY ────────
                        // Recorded because it was a HARDCODE until 2026-09-10
                        // and no pack could say which arm produced it. A canvas
                        // whose lean is being argued about must name its own
                        // attitude source.
                        .s(
                            "drivingSeries",
                            if (cfg.attitudeMagFree) "game-rotation-vector (magnetometer-FREE)"
                            else "rotation-vector (magnetometer-fused)",
                        )
                        .b("attitudeMagFree", cfg.attitudeMagFree)
                        // ── THE TRADE, MEASURED ─────────────────────────────
                        // See headingDivergence(). The two series differ only by
                        // the magnetometer, so the rotation BETWEEN them, and
                        // specifically how much it GROWS over the sweep, is the
                        // compass pull on one arm and the gyro yaw drift on the
                        // other. Same number, both arms. Negative means the pack
                        // never held a matched pair.
                        .n("headingDivergenceDeg", headingDivergence()?.get(0) ?: -1.0)
                        .n("headingDriftDegPerS", headingDivergence()?.get(1) ?: -1.0)
                        .s(
                            "headingDivergenceNote",
                            "the CHANGE in disagreement between the mag-fused and " +
                                "mag-free series across this sweep. A constant offset is " +
                                "harmless (the engine uses only relative rotation); what " +
                                "leans a band is the part that grows. On the mag arm this " +
                                "is the compass pull that keystones the canvas; on the " +
                                "mag-free arm it is the gyro drift that is the price of " +
                                "removing it.",
                        )
                        .n(
                            "rotationVectorHzMeasured",
                            if (imuLastTsNs > imuFirstTsNs && imuCount.get() > 1)
                                (imuCount.get() - 1) / ((imuLastTsNs - imuFirstTsNs) / 1e9) else 0.0,
                        )
                        .s("requestedDelay", "SENSOR_DELAY_FASTEST")
                        .s("quaternionOrder", "[x, y, z, w] (rnis::pano convention)")
                        .s(
                            "quaternionBasis",
                            "RAW Android TYPE_ROTATION_VECTOR: world(ENU: x=east, y=north, " +
                                "z=up) <- device(x=right, y=up, z=out of screen). This is NOT " +
                                "ARKit's world<-cam GL basis. The device->camera change C is " +
                                "one of 24 signed permutations and rnis_pano_attitude.hpp " +
                                "selects it FROM DATA (selectBasis), refusing every align() " +
                                "until it is validated.",
                        )
                        .s(
                            "trackFieldPolicy",
                            if (attitudeMapping)
                                "track.jsonl `q` is the rotation vector MAPPED through the " +
                                    "basis in `map` below: q = R_imu · C, bracketed between " +
                                    "the two samples straddling the frame's own tsNs and " +
                                    "SLERPed. `qSource` on every row NAMES the basis authority " +
                                    "(never a bare \"imu\"), and the RAW sample still rides " +
                                    "beside it as `qDevice`, so an offline pass can re-derive " +
                                    "`q` under a different basis without re-recording."
                            else
                                "track.jsonl `q` is IDENTITY with qSource:\"none\"; the raw " +
                                    "sample rides beside it as `qDevice`. See `map` below for " +
                                    "which gate refused. An offline pass that supplies what is " +
                                    "missing rewrites `q` from `qDevice`; until then the pack " +
                                    "replays on the planar arm.",
                        )
                        // ── THE ATTITUDE MAP, and every gate it passed ──
                        // Whether or not it ran: a pack that mapped nothing
                        // must say WHICH of the two gates refused, or the
                        // planar-arm result reads as a verdict on the engine.
                        .raw("map", attitudeMapJson())
                        .raw(
                            "accuracyHistogram", Jo()
                                .i("unreliable", imuAccuracyHist[1].toLong())
                                .i("low", imuAccuracyHist[2].toLong())
                                .i("medium", imuAccuracyHist[3].toLong())
                                .i("high", imuAccuracyHist[4].toLong())
                                .i("noContact(-1)", imuAccuracyHist[0].toLong())
                                .end(),
                        )
                        .raw(
                            "trackingHistogram", Jo()
                                .i("notAvailable(0)", trackingHist[0].toLong())
                                .i("limited(1)", trackingHist[1].toLong())
                                .i("normal(2)", trackingHist[2].toLong())
                                .end(),
                        )
                        // THE NUMBER THE ENGINE ACTUALLY GATES ON. The histogram
                        // above can show a healthy majority of 2s and still
                        // never latch, because the latch wants them CONSECUTIVE.
                        .i("maxConsecutiveNormalTracking", trackingRunMax.toLong())
                        .i("trackingWarmupFramesRequired", TRACKING_WARMUP_FRAMES.toLong())
                        .b("referenceLatchReachable", trackingRunMax >= TRACKING_WARMUP_FRAMES)
                        .n("attitudeMaxAgeMs", cfg.attitudeMaxAgeMs)
                        .s(
                            "trackingMapping",
                            if (cfg.trackingOverride in 0..2)
                                "FORCED to ${cfg.trackingOverride} by the trackingOverride " +
                                    "option — the mapping below did not run"
                            else
                                "FRESHNESS, not accuracy: a frame whose newest attitude sample " +
                                    "was delivered within attitudeMaxAgeMs of the frame's " +
                                    "accept time -> 2 (normal); no sample, or a staler one -> 0 " +
                                    "(notAvailable). Both instants are read from " +
                                    "SystemClock.elapsedRealtimeNanos(), so no shared epoch " +
                                    "between the camera and sensor clocks is assumed. " +
                                    "SensorEvent.accuracy is NOT used: TYPE_ROTATION_VECTOR is " +
                                    "magnetometer-fused, so its accuracy is the COMPASS's " +
                                    "calibration health — LOW beside steel shelving — and " +
                                    "gating on it made the engine warm up forever and paint an " +
                                    "empty canvas. The RAW accuracy is on every row as " +
                                    "`imuAccuracy` and in accuracyHistogram above, so a " +
                                    "stricter policy can still be applied offline.",
                        )
                        .end(),
                )

                // ── The ARCore reference channel ────────────────────────
                // Present on EVERY pack, including the ones that never asked
                // for it: "not requested" and "requested and refused" and
                // "ran" are three different provenances, and a block that
                // appeared only on success would make the first two
                // indistinguishable from an older recorder.
                .raw(
                    "arcore", Jo()
                        .s("requested", cfg.arcoreReference.name.lowercase())
                        .s("ran", arcore?.modeRan ?: "none")
                        .s("reason", arcoreReason)
                        .s("availability", arcoreAvailability?.status)
                        .b("availabilityLinked", arcoreAvailability?.linked ?: false)
                        .b("availabilitySupported", arcoreAvailability?.supported ?: false)
                        .s("availabilityDetail", arcoreAvailability?.detail)
                        .i("rowWriteFailures", arcoreRowWriteFailed)
                        .i("rowsProducedAfterLedgerClosed", arcoreRowsAfterClose)
                        .s(
                            "rowCountNote",
                            "channel.rowsWritten counts poses the pump PRODUCED; the ledger " +
                                "holds that minus rowsProducedAfterLedgerClosed minus " +
                                "rowWriteFailures. The file is authoritative.",
                        )
                        .s("sidecar", if (arcore != null) "attitude_arcore.jsonl" else null)
                        .raw("channel", arcore?.statusJson() ?: "null")
                        .s(
                            "joinRule",
                            "JOIN THE TWO LEDGERS BY NEAREST tsNs, NEVER BY EQUALITY. ARCore " +
                                "documents Frame.getTimestamp() as sharing the Camera2 " +
                                "SENSOR_TIMESTAMP timebase, and it does — but the integers are " +
                                "not the same: measured on SM-A356U1 in shared mode, 0 of 738 " +
                                "ARCore timestamps equalled any track row's tsNs, with a " +
                                "nearest-neighbour median of 0.9ms and never more than one " +
                                "frame period. The sidecar's `matchKind`/`matchSeq` are a LIVE " +
                                "lookup against frames already ENCODED and are lagged by the " +
                                "CaptureResult latency (cameraTsMinusElapsedNs above) — " +
                                "diagnostic only. The basis run does not need the join at all: " +
                                "it brackets and SLERPs.",
                        )
                        .s(
                            "howToUse",
                            "attitude_arcore.jsonl is the REFERENCE world<-camera series. " +
                                "cpp/rnis_pano_android_s1 runs selectBasis() over it against " +
                                "sensors.jsonl's rotation vector and compares the winner with " +
                                "the DERIVED index — that comparison is the only thing on this " +
                                "programme that can falsify the derivation. Reachable from the " +
                                "panel as ARCORE BASIS RUN, or from the module as " +
                                "arcoreBasisRun({packDir}).",
                        )
                        .end(),
                )

                // ── THE POSE ARM (2026-09-02) ───────────────────────────
                //
                // ⚠ WHY THIS BLOCK IS NOT OPTIONAL AND NOT SHORT. Two arms now
                // produce packs on this phone and THEY ARE NOT COMPARABLE
                // WITHOUT IT: the AR arm runs on the camera ARCore picked
                // (camera 0, 69.7° — NO ULTRA-WIDE) at ARCore's own CPU image
                // size, with ARCore's repeating request holding the AE/AWB lock
                // this recorder asserted, at ~30 Hz. An IMU pack runs on the
                // widest-FOV physical camera at up to 60 fps with the lock the
                // recorder set. Put a canvas from each side by side without
                // this block and every difference — sweep coverage, banding,
                // sharpness — is attributable to the arm when most of it is
                // attributable to the CAMERA the arm forced.
                //
                // Written on EVERY sweep, including IMU ones, so its absence
                // can never be read as "the arm question did not apply".
                .raw(
                    "arm", Jo()
                        .s("requested", cfg.livePoseSource)
                        .s("ran", if (arArmActive) "ar" else "imu")
                        .b("live", cfg.live)
                        .s("reason", arArmReason)
                        .s(
                            "qSource",
                            if (arArmActive) PANO_Q_SOURCE_ARCORE
                            else basis?.authority?.qSource ?: PANO_Q_SOURCE_NONE,
                        )
                        .b("degradedFromAr", arArmDegraded)
                        // The SAME index track.jsonl carries, so the two join.
                        .i("degradedAtSeq", arArmDegradedAtSeq)
                        .s("degradedCountersAtDecision", arArmDegradeCounters)
                        // Empty unless the arm went stale AFTER a usable pose,
                        // which the degrade cannot rescue — said out loud so a
                        // second total-loss pack is not diagnosed from scratch.
                        .s("degradeDeclined", arArmDegradeDeclined)
                        // If this is false on a degraded pack, meta.json's
                        // poseSource still says "ar" and device.json is the
                        // only file carrying the truth.
                        .b("metaPoseSourceCorrected", arArmMetaCorrected)
                        .i("posesAcceptedIntoRing", arPoseAccepted.get())
                        .i("posesDroppedNotTracking", arPoseDroppedNotTracking.get())
                        .i("ringNonMonotonicRejects", arPoseRing.nonMonotonicCount())
                        .i("framesSolved", arPoseSolved.get())
                        .i("framesWaitedForPose", arPoseWaited.get())
                        .i("framesWaitTimedOut", arPoseWaitTimedOut.get())
                        .n("waitBudgetMs", cfg.arPoseWaitMs)
                        .raw("waitMs", arPoseWaitMsStat.toJson())
                        .raw(
                            "refusals",
                            arPoseRefusalCounts.entries.sortedBy { it.key }
                                .joinToString(",", "{", "}") { "${jstr(it.key)}:${it.value}" },
                        )
                        .s(
                            "costs",
                            if (arArmDegraded)
                                // ⚠ NOT "not applicable". The poses are the IMU
                                // arm's, but ARCore had ALREADY forced the
                                // camera before the arm was given up, so the
                                // sentence below would credit this recorder
                                // with a selection it never made.
                                "⚠ MIXED — the POSES are the IMU arm's, the CAMERA is not. " +
                                    "ARCore opened in SHARED mode first and forced the sensor, " +
                                    "the image size and the fps from its own CameraConfig, and " +
                                    "the AE/AWB lock was its repeating request's to keep. All " +
                                    "of that had already happened when the arm was given up at " +
                                    "seq $arArmDegradedAtSeq. Do NOT compare this pack with " +
                                    "one from a sweep that asked for the IMU arm up front: the " +
                                    "pose series is comparable, the pixels are not."
                            else if (!arArmActive)
                                "not applicable — this sweep ran on the IMU arm, on the camera " +
                                    "this recorder selected, at the fps it requested, with the " +
                                    "AE/AWB lock it asserted."
                            else
                                "THE AR ARM'S PRICE, MEASURED, SO NO AR PACK IS EVER COMPARED " +
                                    "WITH AN ULTRA-WIDE IMU PACK BY ACCIDENT: (1) CAMERA — " +
                                    "ARCore selects the id and the CPU image size from its own " +
                                    "CameraConfig list, so the widest-FOV/ultra-wide choice and " +
                                    "the maxWidth cap were both overridden; the id it took is " +
                                    "in selection.cameraIdForcedByArCore and the size in " +
                                    "arcore.channel.cpuImageSize. (2) EXPOSURE — Session." +
                                    "resume() installs ARCore's repeating request over this " +
                                    "session, so CONTROL_AE_LOCK is ARCore's to keep or drop; " +
                                    "applied.exposureTimeNs / sensitivityIso is the only honest " +
                                    "read (min==max is a lock that reached the pixels, a spread " +
                                    "is ARCore running its own AE). (3) RATE — the pose series " +
                                    "is the CAMERA's rate (~30 Hz), not the rotation vector's " +
                                    "~122 Hz, so a frame may WAIT up to waitBudgetMs for a " +
                                    "bracketing pose; framesWaitedForPose/framesWaitTimedOut is " +
                                    "what that cost. (4) BASIS — none is applied on this arm, so " +
                                    "qBasisIndex is −1 on every row BY CONSTRUCTION and not for " +
                                    "want of a derivation.",
                        )
                        .s(
                            "abNote",
                            "sensors.jsonl (rotation vector) IS STILL WRITTEN on an AR sweep, " +
                                "and attitude_arcore.jsonl is still written on an IMU sweep " +
                                "whenever the reference channel ran. So ONE pack replays on " +
                                "BOTH arms offline, on one hand motion — which is the only way " +
                                "to compare them without confounding the arm with the gesture.",
                        )
                        // ── THE PLUGIN'S OWN LEDGER, AND THE FIRST THING TO READ
                        // ON AN AR PACK ────────────────────────────────────────
                        //
                        // These counters existed since the arm shipped and were
                        // visible ONLY to the live HUD (statusMap), so no pack
                        // ever carried them. The 2026-09-11 AR pack is what that
                        // cost: it painted 99 strips from 130 ledger rows and
                        // nothing on disk could say whether ARCore had delivered
                        // 130 frames or 300 and we had refused the difference.
                        //
                        // `seen` counts EVERY call into the plugin, before any
                        // gate. So: seen vs the ledger's row count separates
                        // "they never arrived" from "we refused them", and the
                        // skipped*/droppedBusy breakdown then says which gate.
                        // ⚠ ONLY WHEN THIS SWEEP ARMED IT. The counters are
                        // process-wide and only arm() zeroes them, so an
                        // unconditional write stamps the previous AR sweep's
                        // numbers onto every later IMU pack — see
                        // [arPluginArmActive]. The key is always PRESENT, with
                        // an explicit not-applicable string on the other arms,
                        // matching `costs` above: an absent field and a silent
                        // arm must not look alike, and neither may a stale one
                        // look live.
                        .raw(
                            "arPlugin",
                            if (arPluginArmActive) {
                                joFromCounters(PanoPlusArFramePlugin.shared.state.counters())
                            } else {
                                jstr(
                                    "not applicable — this sweep did not arm the AR frame " +
                                        "plugin. The plugin's counters are process-wide and are " +
                                        "zeroed only when a sweep arms it, so reporting them here " +
                                        "would attribute an earlier AR sweep's frames to this one.",
                                )
                            },
                        )
                        .end(),
                )

                // ── Counts. Every fallback in this file lands here. ─────
                .raw(
                    "counts", Jo()
                        .i("framesArrived", framesArrived.get())
                        .i("framesWritten", writtenN)
                        .i("droppedBusy", droppedBusy.get())
                        .i("droppedNotRecording", droppedNotRecording.get())
                        .i("droppedFrameCap", droppedFrameCap.get())
                        .i("droppedAcquireNull", droppedAcquireNull.get())
                        .i("convertFailed", convertFailed.get())
                        .i("frameWriteFailed", frameWriteFailed.get())
                        .i("metaJoinMissed", metaMissing.get())
                        .i("captureResultsSeen", resultsSeen.get())
                        .i("maxFramesOption", cfg.maxFrames.toLong())
                        .i("readerMaxImages", cfg.readerMaxImages.toLong())
                        .s("firstFrameError", firstFrameError.get())
                        .s(
                            "backpressureNote",
                            "A frame arriving while the encoder is busy is dropped and counted " +
                                "as droppedBusy, never queued. droppedBusy >> 0 with a healthy " +
                                "fpsSensorDeliveredMeasured means the encoder is the limit: " +
                                "lower jpegQuality or pass maxWidth.",
                        )
                        .end(),
                )

                .raw(
                    "timings", Jo()
                        .raw("convertMs", convertMs.toJson())
                        .raw("encodeMs", encodeMs.toJson())
                        .raw("readerThreadMs", readerMs.toJson())
                        .raw("jpegBytes", jpegBytes.toJson())
                        .end(),
                )

                .s("abortReason", abortReason)
                // ── THE LIVE ARM ────────────────────────────────────
                // In device.json and not only in the live session's own
                // meta.json, because these two facts are about the RECORDER:
                // was live asked for, and did the engine actually open. A pack
                // with no canvas.jpg and no meta.json is ambiguous between "a
                // recording, as intended" and "a live sweep whose engine never
                // started", and that distinction decides whether the field trip
                // was wasted.
                .raw(
                    "live",
                    Jo()
                        .b("requested", cfg.live)
                        .b("active", liveActive)
                        .s("startError", liveStartError)
                        .s("packFrames", cfg.packFrames)
                        .i("ingested", liveIngested.get())
                        .i("painted", livePainted.get())
                        .i("refused", liveRefused.get())
                        .raw("engineMs", liveEngineMs.toJson())
                        .end(),
                )
                .raw("advisories", synchronized(advisories) { jarrStr(advisories) })
                // An UNBOUNDED Camera2 round trip — re-reading characteristics
                // for every camera on the device. Worth it on a normal teardown;
                // skipped when the caller is racing a thread-blocking deadline,
                // where the field it produces has never been what a teardown
                // pack was diagnosed from. The refusal is RECORDED, so a reader
                // never mistakes an omitted probe for a device with no cameras.
                .raw(
                    "camerasProbed",
                    if (!reprobeCameras) {
                        jstr(
                            "skipped: this teardown ran under a thread-blocking deadline and " +
                                "a full camera re-enumeration is unbounded",
                        )
                    } else {
                        mgr?.let { probeCameras(it) } ?: "null"
                    },
                )
                .end()

            // Atomic-ish: a half-written device.json on a mid-write kill would
            // be worse than none, because it parses as far as it goes.
            val tmp = File(packDir, "device.json.tmp")
            FileOutputStream(tmp).use { it.write(json.toByteArray(Charsets.UTF_8)); it.fd.sync() }
            val dst = File(packDir, "device.json")
            if (!tmp.renameTo(dst)) {
                tmp.copyTo(dst, overwrite = true)
                tmp.delete()
            }
        } catch (t: Throwable) {
            Log.e(TAG, "device.json could not be written", t)
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  Status + teardown
    // ════════════════════════════════════════════════════════════════════

    fun statusMap(): WritableNativeMap = WritableNativeMap().apply {
        putBoolean("running", state.get() == ST_RECORDING)
        putString(
            "state", when (state.get()) {
                ST_IDLE -> "idle"; ST_OPENING -> "opening"; ST_SETTLING -> "settling"
                ST_RECORDING -> "recording"; else -> "stopping"
            },
        )
        putDouble("framesWritten", framesWritten.get().toDouble())
        putDouble("framesArrived", framesArrived.get().toDouble())
        putDouble("droppedBusy", droppedBusy.get().toDouble())
        putDouble("frameWriteFailed", frameWriteFailed.get().toDouble())
        putDouble("imuSamples", imuCount.get().toDouble())
        putDouble("captureResults", resultsSeen.get().toDouble())
        putString("packDir", if (::packDir.isInitialized) packDir.absolutePath else null)
        putString("firstFrameError", firstFrameError.get())
        // WHY THE AR ARM IS NOT PAINTING, LIVE. Until 2026-09-10 the panel
        // could only say "Waiting for AR tracking" and advise holding steady
        // — advice that is actively WRONG when ARCore is reporting
        // INSUFFICIENT_LIGHT, which it did on 126 of 186 poses in the
        // operator's last attempt while he stood there re-trying. The reason
        // was in the pack all along and reached the screen never. Empty while
        // tracking is fine, so the panel branches on presence.
        putString("arTrackingFailure", arcore?.latestTrackingFailure ?: "")
        // The AR-PLUGIN arm's own counters, so a canvas made from the
        // stitcher's ARCore frames can be traced to how it was made — and
        // so an arm that ingested NOTHING says so out loud rather than
        // looking like an arm that was never selected.
        putMap("arPlugin", PanoPlusArFramePlugin.shared.snapshot())
        // Polled LIVE by the panel so a sweep that can never latch is visible
        // while there is still time to re-run it, not only in device.json
        // afterwards. Read without a join, so it can lag the writer thread by a
        // frame — which is immaterial for a progress read and is why the
        // authoritative copy stays in device.json.
        putDouble("trackingNormalRows", trackingHist[2].toDouble())
        putDouble("maxConsecutiveNormalTracking", trackingRunMax.toDouble())
        putDouble("trackingWarmupFramesRequired", TRACKING_WARMUP_FRAMES.toDouble())
        // Polled live for the same reason the tracking run is: an ARCore
        // channel that opened but is not TRACKING produces a reference series
        // of zero usable samples, and finding that out after the sweep costs
        // the sweep.
        putString("arcoreMode", arcore?.modeRan)
        putDouble("arcoreRows", (arcore?.rowsWritten() ?: 0L).toDouble())
        putDouble("arcoreTrackingRows", (arcore?.trackingRows() ?: 0L).toDouble())
        // Live, for the same reason: a map that is refusing every frame is a
        // sweep to abandon and re-run, and finding that out in device.json
        // afterwards costs the sweep. `attitudeSweepDeg` is the one number
        // that says the map is ALIVE rather than merely running.
        putBoolean("previewAttached", previewAttached)
        putString("previewNote", previewNote)
        putBoolean("attitudeMapActive", attitudeMapping)
        putDouble("attitudeMapped", attitudeMapped.get().toDouble())
        putDouble("attitudeRefused", attitudeRefusalCounts.values.sum().toDouble())
        putDouble(
            "attitudeSweepDeg",
            attitudeFirstQ?.let { f ->
                attitudeLastQ?.let { l -> panoQuatDeltaDeg(f, l) }
            } ?: -1.0,
        )
        putString(
            "outputSize",
            outSize?.let { "${it.width}x${it.height}" },
        )
        // ── The live arm, live ──────────────────────────────────────────
        // `liveActive` is the engine that OPENED, not the one that was asked
        // for; `liveStartError` says why when they differ. A panel showing an
        // empty canvas has to be able to tell "the engine refused to start"
        // from "the engine is running and has painted nothing yet", and those
        // two are one field apart.
        putBoolean("liveRequested", cfg.live)
        putBoolean("liveActive", liveActive)
        putString("liveStartError", liveStartError)
        putDouble("liveIngested", liveIngested.get().toDouble())
        putDouble("livePainted", livePainted.get().toDouble())
        putDouble("liveRefused", liveRefused.get().toDouble())
        putDouble("liveEngineMsP50", liveEngineMs.p50())
        putString("packFrames", cfg.packFrames)
        // ── The pose arm, live ──────────────────────────────────────────
        // Polled twice a second while the sweep runs. `poseWaitTimedOut`
        // climbing is the one AR-arm symptom that looks like an engine fault
        // from the outside: the canvas stops advancing because frames are
        // arriving with no pose to bracket them, not because the engine is
        // rejecting them.
        putString("poseSourceRan", if (arArmActive) "ar" else "imu")
        putDouble("poseSolved", arPoseSolved.get().toDouble())
        putDouble("poseWaited", arPoseWaited.get().toDouble())
        putDouble("poseWaitTimedOut", arPoseWaitTimedOut.get().toDouble())
        putDouble("poseNotTracking", arPoseDroppedNotTracking.get().toDouble())
    }

    /**
     * Close everything, exactly once, in the only order that is safe:
     * camera first (no new frames), then drain the writer (queued rows reach
     * disk), then the files, then device.json. Idempotent — start()'s error
     * paths and stop() both call it.
     *
     * @param joinBudgetMs the budget SHARED by all four thread joins. The
     *   default is the background-thread one; a caller stuck on the main thread
     *   must pass [JOIN_BUDGET_UI_MS] or risk an ANR.
     * @param reprobeCameras re-enumerate every camera into `device.json`. Rich
     *   evidence, and the most expensive thing left on a tight-budget teardown —
     *   an unbounded Camera2 round trip for a field that no teardown-triggered
     *   pack has ever been diagnosed from.
     */
    fun shutdown(
        reason: String,
        joinBudgetMs: Long = JOIN_BUDGET_MS,
        reprobeCameras: Boolean = true,
        finalizeLive: Boolean = true,
    ): WritableNativeMap {
        val budget = JoinBudget(joinBudgetMs)
        val already = torndown.getAndSet(true)
        state.set(ST_STOPPING)
        if (!already && abortReason == null && reason != "stop") abortReason = reason

        if (!already) {
            // ── ARCore FIRST, BEFORE THE CAMERA IS CLOSED ───────────────
            // Its pump sits inside `Session.update()` in BLOCKING mode, which
            // returns when the next CAMERA FRAME arrives. Close the capture
            // session first and there is no next frame, so the pump blocks for
            // the whole of its join — additive with the four thread joins
            // below, and on onHostDestroy (UI thread, ONE second for
            // everything) that is an ANR. Stopped here, it is still being fed
            // and exits on the next frame.
            //
            // The join takes a SLICE OF THE SHARED BUDGET, never a fixed 2 s:
            // a fixed number here would defeat JoinBudget entirely. 2 s is the
            // ceiling on a background teardown; the UI path's whole budget is
            // 1 s and this cannot exceed it.
            //
            // ⚠ THE LIVE SINK COMES OFF FIRST, AND IT IS NOT TIDINESS. A pump
            // frame in flight when the writer thread is being joined would
            // insert into `arPoseRing` while the report is being built from it,
            // and — worse — a frame still inside `solveArPose` waiting on
            // `arPoseLock` has to be woken by something. Clearing the sink stops
            // new inserts; the wait's own deadline ends the last one.
            try { arcore?.setPoseSink(null) } catch (t: Throwable) {
                Log.w(TAG, "clearing the ARCore pose sink threw", t)
            }
            // ⚠ `arArmActive` IS DELIBERATELY NOT CLEARED HERE. The writer
            // thread is joined BELOW, so a frame is very likely mid-row right
            // now; flipping the arm under it would produce a row whose `q` came
            // from the AR ring and whose `qSource` named the IMU basis — a
            // provenance lie manufactured by the teardown. With the sink gone
            // the ring simply stops growing, those frames refuse
            // `after-last-sample`, tracking answers 0, and the engine holds.
            // That is the same shape as any other end-of-sweep frame.
            synchronized(arPoseLock) { (arPoseLock as Object).notifyAll() }
            try {
                arcore?.stop(budget.remainingMs().coerceAtMost(2000L))
            } catch (t: Throwable) {
                Log.w(TAG, "ARCore channel stop threw", t)
            }

            try { captureSession?.stopRepeating() } catch (t: Throwable) {
                Log.w(TAG, "stopRepeating threw", t)
            }
            try { captureSession?.abortCaptures() } catch (t: Throwable) {
                Log.w(TAG, "abortCaptures threw", t)
            }
            try { captureSession?.close() } catch (t: Throwable) { Log.w(TAG, "session.close", t) }
            captureSession = null
            try { device?.close() } catch (t: Throwable) { Log.w(TAG, "device.close", t) }
            device = null

            // ── THE VIEWFINDER, RELEASED ONLY NOW ───────────────────────
            // AFTER the session and the device are closed and never before:
            // PanoPlusPreview.destroyed returned FALSE for this surface if the
            // operator closed the panel mid-sweep, which handed US the
            // release — and performing it while the HAL still had the buffer
            // queue is a native crash in the producer. This is the first
            // instant at which nothing can be writing into it. Cheap, so it
            // runs before the thread joins rather than after their budget.
            previewAttached = false
            previewSurface = null
            try { PanoPlusPreview.release() } catch (t: Throwable) {
                Log.w(TAG, "releasing the preview surface threw", t)
            }

            try { sensorMgr?.unregisterListener(sensorListener) } catch (t: Throwable) {
                Log.w(TAG, "unregisterListener threw", t)
            }

            // quitSafely lets ALREADY-QUEUED messages run — which is how the
            // in-flight frame and its track row reach disk instead of being
            // discarded at the finish line. The reader is quit BEFORE the
            // writer so no new work is posted while the writer drains.
            quitJoin(readerThread, "reader", budget)
            quitJoin(writerThread, "writer", budget)
            quitJoin(sensorThread, "imu", budget)

            // The reader is closed only after its listener thread is dead:
            // closing it under a live acquireNextImage is a native crash.
            try { reader?.close() } catch (t: Throwable) { Log.w(TAG, "reader.close", t) }
            reader = null

            // ── THE LIVE ENGINE, FINISHED ───────────────────────────────
            // HERE and not earlier: the reader and writer threads are joined
            // above, so this is the first instant at which no frame can be in
            // flight. The native side takes an exclusive lock of its own as a
            // second guard, but ordering it correctly is cheaper than relying
            // on the guard.
            //
            // ⚠ TWO EXITS, AND THE CALLER PICKS. `finalizeSweep` renders a
            // multi-megapixel canvas and JPEG-encodes it — SECONDS, not
            // milliseconds. Every path that reaches teardown with a hard time
            // budget (`onHostDestroy` on the UI thread with 1 s before an ANR,
            // `invalidate` on RN's ONE NativeModules queue thread, where a
            // block wedges every native module in the app) passes
            // finalizeLive = false and takes `cancel`, which releases the
            // engine and keeps every file already on disk.
            if (liveActive) {
                if (finalizeLive) {
                    liveSummaryJson = try {
                        PanoPlusLiveNative.finalizeSweep()
                    } catch (t: Throwable) {
                        Log.w(TAG, "live finalize threw", t)
                        null
                    }
                } else {
                    try { PanoPlusLiveNative.cancel() } catch (t: Throwable) {
                        Log.w(TAG, "live cancel threw", t)
                    }
                    advise(
                        "the live engine was ABANDONED rather than finalised (teardown reason " +
                            "'$reason' runs on a thread with a hard time budget and the canvas " +
                            "render is seconds of work). No canvas.jpg was written; the pack, " +
                            "its track rows and the engine's ledger.jsonl are on disk and the " +
                            "pack replays.",
                    )
                }
                liveActive = false
            }

            try { trackW?.flush(); trackW?.close() } catch (t: Throwable) {
                Log.w(TAG, "track.jsonl close threw", t)
            }
            trackW = null
            try { sensorsW?.flush(); sensorsW?.close() } catch (t: Throwable) {
                Log.w(TAG, "sensors.jsonl close threw", t)
            }
            sensorsW = null
            synchronized(arcoreWLock) {
                try { arcoreW?.flush(); arcoreW?.close() } catch (t: Throwable) {
                    Log.w(TAG, "attitude_arcore.jsonl close threw", t)
                }
                arcoreW = null
            }

            // camThread is joined BEFORE the snapshot, not after: every
            // read-back field in device.json (aeLockObserved, cropRegionFirst,
            // focusObservedDiopters, the exposure trace that PROVES the lock)
            // is written on camThread, and only the join publishes those
            // writes to this thread. Snapshotting first would race the very
            // evidence the snapshot exists to carry.
            quitJoin(camThread, "cam", budget)

            // ── A LOCK THAT WAS REQUESTED AND DID NOT HOLD ─────────────────
            // `lockAndRecord` sets CONTROL_AE_LOCK / CONTROL_AWB_LOCK
            // UNCONDITIONALLY, so a `false` read-back is never "not asked
            // for" — it is the camera refusing, and the photometric datum the
            // whole sweep is normalised against then moves mid-sweep. It was
            // recorded in `applied.aeLockReadBack` and nowhere else, which
            // means only a reader who already suspected it would find it. The
            // house rule is that a fallback is COUNTED AND NAMED; this names
            // it, and names ARCore when ARCore is the reason.
            //
            // Placed after the camThread join for the same reason the snapshot
            // is: both read-backs are written on camThread and only the join
            // publishes them here.
            if (aeLockObserved == false || awbLockObserved == false) {
                val which = when {
                    aeLockObserved == false && awbLockObserved == false -> "AE and AWB locks"
                    aeLockObserved == false -> "the AE lock"
                    else -> "the AWB lock"
                }
                advise(
                    "$which was REQUESTED and READ BACK FALSE — the exposure/white-balance " +
                        "datum was not held for this sweep, so the frames are not " +
                        "photometrically comparable with a locked pack" +
                        (if (arcore?.modeRan == "shared")
                            ". EXPECTED IN SHARED-CAMERA MODE: Session.resume() installs " +
                                "ARCore's own repeating request over the shared session, so " +
                                "the locks in this recorder's request are ARCore's to keep or " +
                                "drop. Read applied.exposureTimeNs / sensitivityIso — min==max " +
                                "means the pixels were steady anyway."
                        else ". Read applied.exposureTimeNs / sensitivityIso: min==max means " +
                            "the pixels were steady despite the refusal."),
                )
            }

            // ── THE ADVISORY THAT WOULD HAVE SAVED THE FIRST FIELD TRIP ─────
            // The engine's reference latch needs TRACKING_WARMUP_FRAMES
            // CONSECUTIVE rows at tracking==2 and paints NOTHING until it gets
            // them (rnis_pano.cpp). A pack that never reaches that run replays
            // to an empty canvas, and an empty canvas from a first Android
            // sweep reads as a verdict on the ENGINE rather than on the pack it
            // was fed. Said here, in the pack, at the only moment the recorder
            // can still say it.
            //
            // Raised only when frames were actually written: a sweep that wrote
            // nothing has a different, louder problem and this line would only
            // point away from it.
            // ── The ARCore channel's own no-evidence advisory ───────────────
            // A channel that opened, ran, and never TRACKED produces a
            // reference file full of PAUSED rows, which the S1 reader drops —
            // so the basis run then reports "no reference samples" for a pack
            // that visibly has a sidecar. Say it here, where the counts are.
            val ch = arcore
            if (ch != null) {
                val rows = ch.rowsWritten()
                val trk = ch.trackingRows()
                if (rows == 0L) {
                    advise(
                        "the ARCore reference channel ran in ${ch.modeRan} mode and wrote ZERO " +
                            "pose rows. attitude_arcore.jsonl is empty, so no basis can be " +
                            "measured from this pack. Read arcore.channel.firstError / " +
                            "glError / resumeError in this file before re-running.",
                    )
                } else if (trk == 0L) {
                    advise(
                        "the ARCore reference channel wrote $rows pose rows and NONE of them " +
                            "were TRACKING. The S1 reader drops non-TRACKING rows (a pose from " +
                            "a paused camera is not a measurement), so the basis run will " +
                            "report 'no-reference-samples' despite the sidecar being present. " +
                            "See arcore.channel.trackingFailureReasonHistogram.",
                    )
                }
            }

            if (framesWritten.get() > 0 && trackingRunMax < TRACKING_WARMUP_FRAMES) {
                advise(
                    "NO REFERENCE LATCH IS POSSIBLE FROM THIS PACK: the longest run of " +
                        "consecutive tracking==2 rows was $trackingRunMax, and the engine needs " +
                        "$TRACKING_WARMUP_FRAMES (Config::trackingWarmupFrames). Every frame " +
                        "will replay as WarmingUp and the canvas will be EMPTY — that is this " +
                        "pack, not the engine. tracking is 2 only while an attitude sample " +
                        "arrived within ${cfg.attitudeMaxAgeMs.toLong()}ms of the frame; check " +
                        "attitude.rotationVectorSamples (is TYPE_ROTATION_VECTOR delivering at " +
                        "all?) and attitude.rotationVectorHzMeasured before blaming the sweep.",
                )
            }

            // ── The attitude map's own verdicts ─────────────────────────
            // Three failures that all look like "the pack replayed flat", and
            // that a reader would otherwise have to reconstruct from counters.
            if (attitudeMapping && framesWritten.get() > 0) {
                val mapped = attitudeMapped.get()
                val refused = attitudeRefusalCounts.values.sum()
                if (mapped == 0L) {
                    advise(
                        "THE ATTITUDE MAP WAS ACTIVE AND MAPPED NOTHING: $refused frames were " +
                            "refused and none were mapped, so every row carries the identity " +
                            "and this pack replays exactly as the identity arm did. Read " +
                            "attitude.map.refusals — buffer-empty means the sensor had not " +
                            "delivered yet, after-last-sample means the camera clock runs AHEAD " +
                            "of the sensor's (an epoch fault the REALTIME gate did not catch), " +
                            "and bracket-too-wide means the rotation vector is arriving more " +
                            "slowly than ${cfg.attitudeMaxBracketMs.toLong()}ms apart.",
                    )
                } else if (refused > mapped / 4L) {
                    advise(
                        "the attitude map refused $refused of ${mapped + refused} frames. Each " +
                            "refused row carries the IDENTITY and tracking 0, which breaks the " +
                            "engine's consecutive-tracking run — see " +
                            "attitude.maxConsecutiveNormalTracking. Read attitude.map.refusals " +
                            "for which of the four causes it was.",
                    )
                }
                val f = attitudeFirstQ
                val l = attitudeLastQ
                if (f != null && l != null && mapped >= 2L && panoQuatDeltaDeg(f, l) < 1.0) {
                    advise(
                        "the mapped attitude series moved less than 1° from the first frame to " +
                            "the last. If the phone was PANNED during this sweep the map is " +
                            "dead and the pack is an identity pack wearing a qSource — this is " +
                            "the exact figure the identity arm failed on (0.00° over 152 " +
                            "frames while ARCore saw 57.1°). If the phone was still, ignore it.",
                    )
                }
            }
            if (cfg.trackingOverride in 0..2 && attitudeRefusalCounts.values.sum() > 0L) {
                advise(
                    "trackingOverride=${cfg.trackingOverride} FORCED every row's tracking while " +
                        "the attitude map refused ${attitudeRefusalCounts.values.sum()} frames. " +
                        "Those rows carry the IDENTITY under a forced tracking value, which is " +
                        "the one combination that tells the engine 'good attitude' about a " +
                        "constant. The override is honoured because it is an explicit " +
                        "instruction; read attitude.map.refusals before trusting the replay.",
                )
            }

            if (::packDir.isInitialized) writeDeviceJson(reason, reprobeCameras)
        }

        if (!already) {
            try { onTeardown?.invoke() } catch (t: Throwable) {
                Log.w(TAG, "onTeardown threw", t)
            }
        }

        return WritableNativeMap().apply {
            putBoolean("wasRecording", !already)
            putString("reason", reason)
            putString("packDir", if (::packDir.isInitialized) packDir.absolutePath else null)
            putString(
                "devicePath",
                if (::packDir.isInitialized) File(packDir, "device.json").absolutePath else null,
            )
            putDouble("framesWritten", framesWritten.get().toDouble())
            putDouble("framesArrived", framesArrived.get().toDouble())
            putDouble("droppedBusy", droppedBusy.get().toDouble())
            putDouble("droppedNotRecording", droppedNotRecording.get().toDouble())
            putDouble("frameWriteFailed", frameWriteFailed.get().toDouble())
            putDouble("convertFailed", convertFailed.get().toDouble())
            putDouble("metaJoinMissed", metaMissing.get().toDouble())
            putDouble("imuSamples", imuCount.get().toDouble())
            putDouble("captureResults", resultsSeen.get().toDouble())
            putString("intrinsicsSource", intrinsicsSource)
            putString("physicalBindRoute", physicalBindRoute)
            putString("firstFrameError", firstFrameError.get())
            putDouble("maxConsecutiveNormalTracking", trackingRunMax.toDouble())
            putDouble("trackingWarmupFramesRequired", TRACKING_WARMUP_FRAMES.toDouble())
            putString("arcoreMode", arcore?.modeRan)
            putString("arcoreReason", arcoreReason)
            putDouble("arcoreRows", (arcore?.rowsWritten() ?: 0L).toDouble())
            putDouble("arcoreTrackingRows", (arcore?.trackingRows() ?: 0L).toDouble())
            putString("sizeChoiceReason", sizeChoiceReason.ifEmpty { null })
            putString(
                "advisories",
                synchronized(advisories) { jarrStr(advisories) },
            )
            // ── The live arm's own summary, verbatim ────────────────────
            // Handed across as a JSON STRING and not parsed here, exactly as
            // PanoPlusAndroidModule hands the replay report across: parsing it
            // in this class would be a second marshalling layer whose only job
            // is to lose fields the C++ side already serialised and the host
            // gtest suite already pins. `PanoPlusLiveModule` parses it once,
            // into the shape the SDK reads.
            putString("liveSummaryJson", liveSummaryJson)
            putString("liveStartJson", liveStartJson)
            putString("liveStartError", liveStartError)
            putBoolean("liveRequested", cfg.live)
            putDouble("liveIngested", liveIngested.get().toDouble())
            putDouble("livePainted", livePainted.get().toDouble())
            putDouble("liveRefused", liveRefused.get().toDouble())
            putString("packFrames", cfg.packFrames)
        }
    }

    private fun quitJoin(t: HandlerThread, name: String, budget: JoinBudget) {
        try {
            t.quitSafely()
            if (Thread.currentThread() === t) {
                // Every shutdown() call site dispatches onto Dispatchers.IO
                // precisely so this cannot happen. If a future one forgets,
                // the timed join below would still stall the teardown for
                // three seconds and then leave the thread alive with its
                // writes unpublished — so say so instead of pretending.
                advise(
                    "shutdown ran ON the $name thread; its join was skipped and any value " +
                        "that thread wrote may be missing from this snapshot",
                )
                return
            }
            // ONE budget across all four joins, not one each. `join(0)` waits
            // FOREVER, so a spent budget must skip the join outright — the whole
            // reason remainingMs() hands back a number to branch on.
            val slice = budget.remainingMs()
            if (slice <= 0L) {
                advise(
                    "$name thread was NOT joined: the teardown's shared ${budget.totalMs}ms " +
                        "join budget was already spent. It was asked to quit and will exit on " +
                        "its own; any value it had not yet published may be missing here",
                )
                return
            }
            t.join(slice)
            if (t.isAlive) {
                advise("$name thread did not exit within ${slice}ms — it was left running")
            }
        } catch (x: Throwable) {
            Log.w(TAG, "joining the $name thread threw", x)
        }
    }

    // ── Promise settle guard ────────────────────────────────────────────
    // Every failure path above can fire concurrently with the watchdog; a
    // double settle on an RN promise throws out of whichever callback loses.

    fun settleResolve(p: Promise) {
        if (!settled.compareAndSet(false, true)) return
        p.resolve(
            WritableNativeMap().apply {
                putBoolean("started", true)
                putString("packDir", packDir.absolutePath)
                putString("devicePath", File(packDir, "device.json").absolutePath)
                putString("cameraId", chosen?.id)
                // ── THE LENS THAT RAN, AT START (2026-09-03) ───────────
                // Same rule as `poseSourceRan` below it: the operator who
                // tapped 0.5x and is about to sweep on the 1x (no ultra-wide,
                // or the AR arm) learns it now, while re-running is free.
                putString("lensRequested", lensRequested?.wire)
                putString("lensRan", lensRan?.wire)
                putBoolean("lensHonoured", lensHonoured)
                putString("lensNote", lensNote)
                putDouble(
                    "hFovDeg",
                    chosen?.hFovDeg?.takeIf { it.isFinite() } ?: -1.0,
                )
                putString("physicalBindRoute", physicalBindRoute)
                putInt("width", outSize?.width ?: 0)
                putInt("height", outSize?.height ?: 0)
                // The size is not self-explaining: WHICH rung of the rate ladder
                // won, whether the maxWidth cap moved the answer, and whether a
                // 4:3 raster existed at all are the three facts that decide
                // whether a slow pack is a slow camera or a chosen size.
                putString("sizeChoiceReason", sizeChoiceReason)
                putDouble(
                    "sizeMaxFpsPublished",
                    if (chosenSizeMaxFps.isFinite()) chosenSizeMaxFps else -1.0,
                )
                putString("fpsRange", fpsRange?.toString())
                putString("fpsNote", fpsRequestedNote)
                putDouble("attitudeMaxAgeMs", cfg.attitudeMaxAgeMs)
                putInt("maxFrames", cfg.maxFrames)
                // WHICH ARM THIS SWEEP IS. The difference between a pack whose
                // `q` is a measured attitude and one whose `q` is the identity
                // decides what the replay's canvas MEANS, and the operator has
                // to know it before the sweep rather than after — a flat
                // canvas from an identity pack reads as a verdict on the
                // engine unless the panel said which arm was running.
                // WAS THE OPERATOR ABLE TO SEE ANYTHING. A headless sweep is a
                // valid pack and a bad experiment: he aimed at a shelf he
                // could not see. The panel says so at START, when re-aiming is
                // still free.
                putBoolean("previewAttached", previewAttached)
                putString("previewNote", previewNote)
                putString("previewSize", previewSize?.let { "${it.width}x${it.height}" })
                // WHETHER THE ENGINE IS ACTUALLY RUNNING, at START, while
                // re-running the sweep is still free. A live start that
                // refused produces a perfectly good RECORDING and no canvas,
                // and the operator has to learn that now rather than at stop().
                putBoolean("liveRequested", cfg.live)
                putBoolean("liveActive", liveActive)
                putString("liveStartError", liveStartError)
                putString("liveStartJson", liveStartJson)
                putString("packFrames", cfg.packFrames)
                // ── THE POSE ARM (2026-09-02) ──────────────────────────
                // At START, because that is when re-running the sweep is still
                // free — the same rule the two fields above it follow. An
                // operator who selected AR and is about to sweep on the IMU
                // because ARCore refused has to learn it now, not from the
                // pack.
                putString("poseSourceRequested", cfg.livePoseSource)
                putString("poseSourceRan", if (arArmActive) "ar" else "imu")
                putString("poseArmReason", arArmReason)
                // ⚠ `attitudeMapActive` DESCRIBES THE IMU MAP AND ONLY IT. On
                // the AR arm the engine is fed without a basis, so this can be
                // FALSE on a sweep that is posing perfectly — read
                // `poseSourceRan` first. It is still reported because
                // `sensors.jsonl` is still written on an AR sweep and the
                // offline replay of the OTHER arm depends on exactly this.
                putBoolean("attitudeMapActive", attitudeMapping)
                putString(
                    "qSource",
                    when {
                        arArmActive -> PANO_Q_SOURCE_ARCORE
                        attitudeMapping -> basis?.authority?.qSource ?: PANO_Q_SOURCE_NONE
                        else -> PANO_Q_SOURCE_NONE
                    },
                )
                putString("basisAuthority", basis?.authority?.authority ?: PANO_BASIS_AUTHORITY_NONE)
                putInt("basisIndex", basis?.authority?.index ?: -1)
                putString("basisLabel", basis?.label ?: "invalid")
                putString("basisNote", basis?.authority?.note)
                putString("clockGate", clockGate?.reason)
                putBoolean("clockJoinable", clockGate?.joinable ?: false)
                putDouble("aeSettleMs", aeSettleMs)
                putString("aeStateAtLock", aeStateName(aeStateAtLock))
                putString("intrinsicsSource", intrinsicsSource)
                putInt("sensorOrientation", sensorOrientation ?: -1)
                // The panel derives the basis for the camera the pack was
                // actually recorded on, so it has to be told when ARCore moved
                // that camera out from under the recorder's own selection.
                putString("arcoreMode", arcore?.modeRan)
                putString("arcoreReason", arcoreReason)
                putString(
                    "advisories",
                    synchronized(advisories) { jarrStr(advisories) },
                )
            },
        )
    }

    /**
     * Settle the start() promise as a failure AND tear the session down.
     *
     * EVERY early return in start() must go through this. Without it the four
     * HandlerThreads, the two pack writers and the (possibly open) camera
     * survive the rejection — a leak the caller has no handle on, because the
     * only handle was the promise that just rejected.
     */
    fun fail(p: Promise, code: String, msg: String) {
        settleReject(p, code, msg)
        // Never on the calling thread: shutdown() joins camThread, and some of
        // these paths run ON camThread (the device/session callbacks).
        CoroutineScope(Dispatchers.IO).launch { shutdown(code) }
    }

    fun settleReject(p: Promise, code: String, msg: String) {
        if (!settled.compareAndSet(false, true)) {
            Log.w(TAG, "suppressed second settle: $code — $msg")
            return
        }
        p.reject(code, msg)
    }
}
