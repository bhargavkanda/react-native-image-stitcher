// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusLiveNative.kt — the recorder's window onto the LIVE pano+ engine.
//
// ── What this is for ────────────────────────────────────────────────────────
//
// Android has had RECORD-then-REPLAY since the port began: the recorder writes
// JPEGs and a track ledger, and `RNSSweepTools.replayPack()` runs
// the engine over them afterwards. This is the other half — the six entries
// that let the SAME recorder feed the SAME engine while the operator is still
// sweeping, so the canvas grows on screen instead of appearing minutes later.
//
// ── WHY IT IS AN OBJECT AND NOT A ReactContextBaseJavaModule ────────────────
//
// Because [ingest] is on the FRAME PATH, ~30 times a second, and an RN module
// would put a Promise and the NativeModules queue thread between the camera and
// the engine. This is a plain `object` whose JNI symbols are named for it; the
// RN surface (`PanoPlusLiveModule`) sits above and never touches the frame path.
//
// ── IT NEVER THROWS, AND THAT IS THE CONTRACT ───────────────────────────────
//
// Same rule as [PanoPlusNativeBasis], and here it matters more. An
// `UnsatisfiedLinkError` from a stale .so, a build whose `externalNativeBuild`
// did not run, a host without the stitcher's OpenCV — every one of them arrives
// as a REFUSAL with the loader's own message, recorded once, and the sweep
// carries on as a plain recording. A throw on the frame path would take the app
// down in an aisle; a throw at start would cost the operator the trip.
//
// ⚠ SIGNATURES MUST MATCH `panoplus_jni.cpp` EXACTLY — order, arity and
// type. A mismatch is an `UnsatisfiedLinkError` at RUNTIME, the one failure a
// compile cannot catch, which is why [available] resolves the whole set on the
// first call and reports the loader's message rather than letting each entry
// discover it separately.

package io.imagestitcher.rn.panoplus

import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One frame's outcome, decoded from the packed int [PanoPlusLiveNative.ingest]
 * returns.
 *
 * Packed rather than an `IntArray` because this is the frame path: an array
 * return would allocate a Java object thirty times a second to carry four bits.
 */
internal class PanoLiveFrameResult(private val packed: Int) {
    /** The frame reached the engine. `false` is a DROP, not an error. */
    val ran: Boolean get() = (packed and PanoPlusLiveNative.RAN) != 0

    /** The engine committed a strip (Painted / Bootstrap / Gap*). */
    val painted: Boolean get() = (packed and PanoPlusLiveNative.PAINTED) != 0

    /** The preview pump rendered on this tick. It publishes on its own worker
     *  thread; this is reported only so a slow frame can be attributed. */
    val previewRendered: Boolean get() = (packed and PanoPlusLiveNative.PREVIEW) != 0

    /** `rnis::pano::Outcome` as an ordinal, or -1 when [ran] is false. */
    val outcome: Int get() =
        if (!ran) -1 else ((packed ushr PanoPlusLiveNative.OUTCOME_SHIFT) and 0xFF) - 1
}

internal object PanoPlusLiveNative {

    // ⚠ MIRRORED IN panoplus_jni.cpp (the anonymous-namespace enum in the
    // pano+ LIVE block). Two constants in two languages with no compiler
    // between them: change one and the other is silently wrong, so they are
    // named identically on both sides and both sides say so.
    const val RAN = 0x1
    const val PAINTED = 0x2
    const val PREVIEW = 0x4
    const val OUTCOME_SHIFT = 8

    /** `PackFrames` (rnis_pano_live.hpp), by ordinal. */
    const val PACK_FRAMES_ALL = 0
    const val PACK_FRAMES_PAINTED = 1
    const val PACK_FRAMES_NONE = 2

    // ── JNI ─────────────────────────────────────────────────────────────

    private external fun nativeLiveStart(
        sessionDir: String,
        packFramesMode: Int,
        packFrameEveryN: Int,
        packFrameQuality: Int,
        packMaxFrames: Int,
        canvasQuality: Int,
        canvasCropPad: Boolean,
        previewIntervalMs: Double,
        previewMaxDutyPct: Double,
        previewQuality: Int,
        previewMaxAlong: Int,
        previewMaxCross: Int,
        previewWindowCrossMult: Double,
        previewWindowAlongPx: Int,
        previewCropPad: Boolean,
        previewLeadOut: Boolean,
        writeLedger: Boolean,
        poseSource: String,
        captureJson: String,
        overrideNames: Array<String>,
        overrideValues: Array<String>,
    ): String

    private external fun nativeLiveIngest(
        nv21: ByteArray,
        length: Int,
        width: Int,
        height: Int,
        tsNs: Double,
        fx: Double,
        fy: Double,
        cx: Double,
        cy: Double,
        qx: Double,
        qy: Double,
        qz: Double,
        qw: Double,
        tracking: Int,
        seq: Long,
        exposureDurationS: Double,
        exposureISO: Double,
    ): Int

    private external fun nativeLiveStatusJson(): String
    private external fun nativeLiveFinalize(): String
    private external fun nativeLiveCancel()
    private external fun nativeLiveRunning(): Boolean
    private external fun nativeLiveSetPoseSource(kind: String): Boolean

    /**
     * Correct `meta.json`'s `poseSource` when the pose arm CHANGES mid-sweep.
     *
     * `meta.json` is read on its own by every offline harness, and its
     * `poseSource.kind` is fixed at `start()` — correct only while the arm
     * cannot change afterwards. The Android recorder can now give the ARCore
     * arm up and finish on the IMU ring, so without this the pack would
     * report `ar` for a sweep the IMU painted.
     *
     * ⚠ RETURNS WHETHER IT LANDED, AND THE CALLER MUST NOT DISCARD IT. With
     * no `JNI_OnLoad` in this library every native entry binds at its FIRST
     * CALL, so a signature mismatch surfaces as an UnsatisfiedLinkError on a
     * device rather than at build time. Swallowing that here would leave the
     * pack wrong and silent — the exact shape of the defect this method
     * exists to remove.
     */
    fun setPoseSource(kind: String): Boolean =
        try {
            nativeLiveSetPoseSource(kind)
        } catch (t: Throwable) {
            Log.w("RNSSweep.live", "nativeLiveSetPoseSource failed", t)
            false
        }

    // ── Public, refusal-shaped ──────────────────────────────────────────

    /**
     * Begin a live sweep. Returns the native StartReport as a JSON string —
     * `{"ok":true,…}` on success, `{"ok":false,"error":"…"}` otherwise, and
     * NEVER a throw.
     *
     * `configOverrides` is `knobName -> value` as text; the values are parsed
     * natively against the ONE knob table that also reads `meta.json` and drives
     * replay overrides, so an A/B arm cannot reach a knob the replay cannot
     * report on. A name the table does not know, or a value it cannot parse,
     * comes back in `overridesUnknown` / `overridesMalformed` rather than being
     * silently dropped — a sweep that ran at a knob the operator did not set is
     * the failure this port cannot afford.
     */
    fun start(
        sessionDir: String,
        packFramesMode: Int,
        packFrameEveryN: Int,
        packFrameQuality: Int,
        packMaxFrames: Int,
        canvasQuality: Int,
        canvasCropPad: Boolean,
        previewIntervalMs: Double,
        previewMaxDutyPct: Double,
        previewQuality: Int,
        previewMaxAlong: Int,
        previewMaxCross: Int,
        previewWindowCrossMult: Double,
        previewWindowAlongPx: Int,
        previewCropPad: Boolean,
        previewLeadOut: Boolean,
        writeLedger: Boolean,
        poseSource: String,
        captureJson: String,
        configOverrides: Map<String, String>,
    ): String {
        val err = ensureNativeOrNull()
        if (err != null) return unavailableJson(err)
        return try {
            val names = ArrayList<String>(configOverrides.size)
            val values = ArrayList<String>(configOverrides.size)
            for ((k, v) in configOverrides) { names.add(k); values.add(v) }
            nativeLiveStart(
                sessionDir, packFramesMode, packFrameEveryN, packFrameQuality,
                packMaxFrames, canvasQuality, canvasCropPad,
                previewIntervalMs, previewMaxDutyPct, previewQuality,
                previewMaxAlong, previewMaxCross, previewWindowCrossMult,
                previewWindowAlongPx, previewCropPad, previewLeadOut,
                writeLedger, poseSource, captureJson,
                names.toTypedArray(), values.toTypedArray(),
            )
        } catch (t: Throwable) {
            // UnsatisfiedLinkError lands here when the .so LOADED but does not
            // export this entry — a STALE .so. Gradle reports SUCCESS without
            // relinking, so this is the failure an operator cannot diagnose
            // from a generic message. Name it in the payload the panel renders.
            unavailableJson(describe(t))
        }
    }

    /** The width of the last frame ANY arm handed the engine. 0 before the
     *  first. See the note in [ingest]. */
    @Volatile var deliveredW: Int = 0
        private set

    /** The height of the last frame ANY arm handed the engine. */
    @Volatile var deliveredH: Int = 0
        private set

    /** Forget the latch between sweeps, so a pack can never report the
     *  PREVIOUS sweep's frame size as its own. Called from the recorder's
     *  start. */
    fun resetDeliveredSize() {
        deliveredW = 0
        deliveredH = 0
    }

    /**
     * One frame into the engine. ~30 ms on the A35; call it from the recorder's
     * engine thread and never from the camera callback.
     *
     * `nv21` is `width * height * 3 / 2` bytes in NV21 layout — exactly what
     * [Yuv420ToNv21.convert] produces. It is copied natively before any work
     * begins, so the caller may reuse the buffer as soon as this returns.
     *
     * ⚠ INTRINSICS MUST BE EXPRESSED AGAINST `width` x `height` UNROTATED, in
     * the sensor frame. The recorder never rotates the buffer
     * (PANO_RECORDER_ROTATION_RAW_SENSOR_BUFFER is a FACT about it, not a
     * preference); rotating pixels without rotating fx/fy/cx/cy would leave the
     * basis wrong by that angle with nothing in the pack able to name it.
     *
     * Returns a result whose `ran` is false when the frame did not reach the
     * engine — no session, wrong buffer size, a conversion that refused. That
     * is a DROP for the caller to count, never a throw.
     */
    fun ingest(
        nv21: ByteArray,
        length: Int,
        width: Int,
        height: Int,
        tsNs: Double,
        fx: Double,
        fy: Double,
        cx: Double,
        cy: Double,
        q: DoubleArray,
        tracking: Int,
        seq: Long,
        exposureDurationS: Double,
        exposureISO: Double,
    ): PanoLiveFrameResult {
        // No ensureNativeOrNull() here: this is the frame path, and the check is
        // a volatile read plus a branch that can only answer what `start`
        // already answered. A sweep whose start refused never reaches this.
        if (!loaded()) return PanoLiveFrameResult(0)
        // ⚠ THE DELIVERED FRAME SIZE, LATCHED HERE BECAUSE THIS IS THE ONE
        // PLACE EVERY ARM PASSES THROUGH.
        //
        // The pack reported frame dimensions from `outSize` — the RECORDER's
        // own Camera2 choice — so on the two PLUGIN arms, where the recorder
        // opens no camera, `capture.width`/`height` came out NULL. Measured
        // on the operator's A35: three consecutive sweeps on the vc-plugin
        // arm painted the MOST strips of any arm (125-131) and produced the
        // SMALLEST canvases (331x422, 335x406, 533x336), and the pack could
        // not say what resolution those frames were. "The output is 500x300,
        // what resolution are the frames?" was unanswerable from the pack,
        // which is the whole point of the pack.
        //
        // Latched at the ONE function all three call sites funnel through
        // (the recorder's Camera2 path, `PanoPlusArFramePlugin`, and
        // `PanoPlusVcFrameSink`) rather than at each of them, so a fourth arm
        // reports its size without being told to.
        deliveredW = width
        deliveredH = height
        // A malformed quaternion is the IDENTITY, never a padded guess: three
        // numbers are not a rotation, and the engine's rectification would
        // silently apply whatever the padding happened to mean.
        val qx = if (q.size == 4) q[0] else 0.0
        val qy = if (q.size == 4) q[1] else 0.0
        val qz = if (q.size == 4) q[2] else 0.0
        val qw = if (q.size == 4) q[3] else 1.0
        return try {
            PanoLiveFrameResult(
                nativeLiveIngest(
                    nv21, length, width, height, tsNs, fx, fy, cx, cy,
                    qx, qy, qz, qw, tracking, seq,
                    exposureDurationS, exposureISO,
                ),
            )
        } catch (t: Throwable) {
            // Recorded once by the caller (firstFrameError) and then silent:
            // logging per frame on a failing sweep is its own denial of service.
            PanoLiveFrameResult(0)
        }
    }

    /**
     * The live status as JSON. The Android leg has NO push channel (iOS rides
     * the AR plugin's synchronous per-frame return), so this poll is the
     * operator's ONLY live signal — and `running` is the one field the SDK's
     * coercion treats as mandatory.
     */
    fun statusJson(): String {
        if (!loaded()) return withViewfinder("{\"running\":false}")
        return try { withViewfinder(nativeLiveStatusJson()) } catch (_: Throwable) {
            withViewfinder("{\"running\":false}")
        }
    }

    /**
     * Splice the VIEWFINDER's state onto the engine's status.
     *
     * ── Why here and not in C++ with everything else ────────────────────
     *
     * Because the fact is Kotlin's. [PanoPlusPreview] is a JVM object holding a
     * SurfaceTexture handover; `rnis_pano_live.cpp` has no way to see it, and
     * giving the native session a JNI upcall to ask would be a callback into
     * the VM from the engine thread for a debug string.
     *
     * ── Why it is worth a splice at all ─────────────────────────────────
     *
     * The viewfinder and the panorama panel are TWO DIFFERENT PICTURES, and on
     * Android the viewfinder can fail in a way that looks exactly like success.
     * Camera2 fixes a session's outputs at `createCaptureSession`: a preview
     * Surface offered after that moment cannot join, and the sweep then records
     * HEADLESS — correctly, completely, at full quality, and with a black
     * rectangle where the shelf should be. That is the state behind the
     * operator's "The camera screen is blank!!!" and "no camera at all".
     *
     * [PanoPlusPreview] already knows which happened and keeps the reason as a
     * sentence. These two keys carry it to `panoPlusViewfinderNotice`, which
     * renders "NO LIVE CAMERA FEED — <note>". Without them the operator's
     * evidence for "the camera is broken" and for "the camera is fine, the
     * panel is behind" is the same black rectangle — and the two have opposite
     * correct responses (stop and restart, vs. keep sweeping, the pack is fine).
     *
     * ⚠ ADDITIVE AND FAILURE-PROOF. A malformed body is returned untouched
     * rather than corrupted: `JSON.parse` throws in JS three layers from here,
     * and a status channel that can break the panel is worse than one that
     * cannot explain it.
     */
    private fun withViewfinder(json: String): String {
        if (json.length < 2 || json[0] != '{' || json[json.length - 1] != '}') {
            return json
        }
        // The note is authored here and in PanoPlusPreviewView, but it also
        // carries exception class names, so it is escaped rather than trusted.
        // Control characters are not legal raw in a JSON string.
        val note = buildString {
            for (c in PanoPlusPreview.note) {
                when {
                    c == '"' -> append("\\\"")
                    c == '\\' -> append("\\\\")
                    c.code < 0x20 -> append(' ')
                    else -> append(c)
                }
            }
        }
        val head = json.substring(0, json.length - 1)
        // `{}` would leave a leading comma; the engine never emits one, but a
        // future `{}` must not produce invalid JSON.
        val sep = if (head.length > 1) "," else ""
        return head + sep +
            "\"viewfinderAttached\":${PanoPlusPreview.attached}," +
            "\"viewfinderNote\":\"" + note + "\"}"
    }

    /**
     * Tail flush, `canvas.jpg`, `meta.json`, and the summary.
     *
     * ⚠ SECONDS, not milliseconds — it encodes a multi-megapixel JPEG. Never
     * call it from an `@ReactMethod` body (that is RN's ONE NativeModules queue
     * thread and blocking it wedges every native module in the app) and never
     * from the UI thread. [cancel] is the exit for teardowns that cannot afford
     * this.
     */
    fun finalizeSweep(): String {
        if (!loaded()) return "{\"ok\":false,\"error\":\"native library unavailable\"}"
        return try { nativeLiveFinalize() } catch (t: Throwable) {
            "{\"ok\":false,\"error\":\"${describe(t).replace('"', '\'')}\"}"
        }
    }

    /**
     * Abandon the sweep cheaply: no canvas render, no JPEG, no meta. Files
     * already on disk are KEPT — an Activity destroy must not cost the operator
     * the evidence his sweep produced. Idempotent, and safe on a thread that
     * must not block.
     */
    fun cancel() {
        if (!loaded()) return
        try { nativeLiveCancel() } catch (_: Throwable) {}
    }

    fun running(): Boolean {
        if (!loaded()) return false
        return try { nativeLiveRunning() } catch (_: Throwable) { false }
    }

    /** Null when the native half is present; the loader's reason otherwise. */
    fun availability(): String? = ensureNativeOrNull()

    // ── Loader ──────────────────────────────────────────────────────────

    private fun loaded(): Boolean = pluginsLoaded.get() && opencvLoaded.get()

    private fun describe(t: Throwable): String =
        "${t.javaClass.simpleName}: ${t.message ?: "(no message)"}"

    private fun unavailableJson(reason: String): String =
        "{\"ok\":false,\"error\":\"${reason.replace('"', '\'').replace('\n', ' ')}\"}"

    /**
     * Load the JNI shim, returning null on success or the reason on failure.
     *
     * Its own flags rather than [PanoPlusNativeBasis]'s or
     * `PanoPlusAndroidModule`'s, for the reason those two already state:
     * `System.loadLibrary` is idempotent, so a third cache costs one extra
     * no-op call and none of them can leave another believing a load that never
     * happened.
     *
     * libopencv_java4 must load FIRST — the shim dynamically links against it.
     */
    private fun ensureNativeOrNull(): String? {
        if (!opencvLoaded.get()) {
            try {
                System.loadLibrary("opencv_java4")
                opencvLoaded.set(true)
            } catch (e: UnsatisfiedLinkError) {
                return "OpenCV native library 'opencv_java4' failed to load — is " +
                    "react-native-image-stitcher (which ships it) linked? " +
                    "(${e.message ?: "no message"})"
            }
        }
        if (!pluginsLoaded.get()) {
            try {
                System.loadLibrary("image_stitcher_panoplus")
                pluginsLoaded.set(true)
            } catch (e: UnsatisfiedLinkError) {
                return "JNI shim 'image_stitcher_panoplus' failed to load. Check that " +
                    "react-native-image-stitcher built its externalNativeBuild " +
                    "(libimage_stitcher_panoplus.so). (${e.message ?: "no message"})"
            }
        }
        return null
    }

    @JvmStatic
    private val opencvLoaded = AtomicBoolean(false)

    @JvmStatic
    private val pluginsLoaded = AtomicBoolean(false)
}
