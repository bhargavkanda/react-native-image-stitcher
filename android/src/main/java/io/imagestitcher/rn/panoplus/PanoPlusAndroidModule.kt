// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusAndroidModule — ONE RN surface for the whole pano+ Android port.
//
// ── The name, and why it is not iOS's ───────────────────────────────────────
//
// `RNSSweepTools`, deliberately DIFFERENT from iOS's
// `RNSSweepSession`. They are not the same surface and must not be confused
// by JS: iOS's module runs a LIVE capture session (start → frames → stop, with
// the engine ingesting on the AR thread), while this one records a REPLAYABLE
// PACK and then replays it offline. A shared name would make
// `NativeModules.RNSSweepSession != null` mean two different things on two
// platforms, and the first JS caller to assume the iOS contract on Android
// would get a module that has no `start`.
//
// ── What this class is, and what it is NOT ──────────────────────────────────
//
// It is a FAÇADE plus two native entries of its own:
//
//   · probe() / measureSensorRates()      → delegate to PanoPlusAndroidProbe
//   · startRecording() / stopRecording()
//     / recordingStatus()                 → delegate to PanoPlusAndroidRecorder
//   · engineInfo() / deriveBasis()
//     / arcoreBasisRun() / replayPack()   → its OWN JNI entries
//
// The delegates hold the SAME instances the package registered, passed in
// rather than constructed here. That is load-bearing, not tidiness: the
// recorder owns its session in an instance field, so a second instance would
// let `startRecording()` on this module and `stop()` on
// `RNSSweepRecorder` address different sessions — a camera left open
// with nothing able to close it, on a device nobody can attach a debugger to.
//
// ── Everything returns a payload; nothing throws ────────────────────────────
//
// The four native entries return ONE JSON STRING and never throw (see the
// pano+ block in panoplus_jni.cpp). This module parses nothing: the
// string crosses the bridge as `json` and JS parses it. Parsing here would mean
// writing a second marshalling layer whose only job is to lose fields the C++
// side already serialised and the host gtest suite already pins.
//
// The ONE thing this module adds is `nativeAvailable`: whether the .so loaded
// at all. A build whose externalNativeBuild did not run, or whose OpenCV is
// missing, must say so as a payload — `probe()` still works there, because it
// touches no native code, and knowing WHICH half is broken is the difference
// between a diagnosable field trip and a wasted one.

package io.imagestitcher.rn.panoplus

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class PanoPlusAndroidModule(
    reactContext: ReactApplicationContext,
    private val probeModule: PanoPlusAndroidProbe,
    private val recorderModule: PanoPlusAndroidRecorder,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RNSSweepTools"

    // ── JNI ──────────────────────────────────────────────────────────────
    // Signatures/order/types must match the JNI C signatures in
    // panoplus_jni.cpp EXACTLY or it is an UnsatisfiedLinkError at
    // runtime — the one failure mode a compile cannot catch.

    /** Engine version + a linkage probe into each pano translation unit + the
     *  basis self-test. Returns a JSON string; never throws natively. */
    private external fun nativePanoEngineInfo(): String

    /** `rnis::pano::android::buildBasisReport` as JSON. All arguments are RAW
     *  Camera2 values — see the JNI doc for why nothing is remapped here. */
    private external fun nativeDeriveBasis(
        sensorOrientationDeg: Int,
        lensFacing: Int,
        recorderRotation: Int,
        displayRotationDeg: Int,
        explicitRotationCwDeg: Int,
        mirrored: Boolean,
        lensPoseQuat: DoubleArray?,
        lensPoseReference: Int,
        poseQuatSense: Int,
        cameraFrameAdjustIndex: Int,
        poseThresholdDeg: Double,
        referenceBasisIndex: Int,
    ): String

    /** `rnis::pano::android::runS1OnPack` as JSON: read the pack's own
     *  `sensors.jsonl` + `attitude_arcore.jsonl`, run `selectBasis()` over
     *  them, and compare the winner with the DERIVED index. */
    private external fun nativeArCoreBasisRun(
        packDir: String,
        imuType: String,
        refField: String,
        tauS: Double,
        tauCandidatesS: DoubleArray?,
        derivedBasisIndex: Int,
        sweepSeconds: Double,
        canvasPxPerDeg: Double,
    ): String

    /** `rnis::pano::replay::replayPack` as JSON. Minutes on a 400-frame pack —
     *  always called off the JS thread. */
    private external fun nativeReplayPack(
        packDir: String,
        outDir: String,
        maxFrames: Int,
        writeCanvas: Boolean,
        writeLedger: Boolean,
        canvasQuality: Int,
        canvasCropPad: Boolean,
        useMetaConfig: Boolean,
        compareLedger: Boolean,
        frameMissingReportCap: Int,
        overrideNames: Array<String>,
        overrideValues: Array<String>,
    ): String

    // ── ReadableMap accessors that DEGRADE ──────────────────────────────
    // The bridge getters throw ClassCastException on a type mismatch (the
    // house note on every robust bridge entry in this package, and the
    // recorder's own copy of these). A malformed option must fall back to its default,
    // never red-screen a diagnostic panel.
    private fun optStr(m: ReadableMap?, k: String, d: String): String =
        try { if (m != null && m.hasKey(k)) m.getString(k) ?: d else d } catch (_: Throwable) { d }
    private fun optInt(m: ReadableMap?, k: String, d: Int): Int =
        try { if (m != null && m.hasKey(k)) m.getInt(k) else d } catch (_: Throwable) { d }
    private fun optDbl(m: ReadableMap?, k: String, d: Double): Double =
        try { if (m != null && m.hasKey(k)) m.getDouble(k) else d } catch (_: Throwable) { d }
    private fun optBool(m: ReadableMap?, k: String, d: Boolean): Boolean =
        try { if (m != null && m.hasKey(k)) m.getBoolean(k) else d } catch (_: Throwable) { d }
    private fun optArr(m: ReadableMap?, k: String): ReadableArray? =
        try { if (m != null && m.hasKey(k) && !m.isNull(k)) m.getArray(k) else null }
        catch (_: Throwable) { null }

    private fun stripFileScheme(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

    // ── delegated: the pure-read capability probe ───────────────────────
    //
    // Straight pass-through to the SAME instance the package registered. Not
    // reimplemented here, and not given its own instance: PanoPlusAndroidProbe
    // is 1800 lines of Camera2/SensorManager reads and a second copy would be a
    // second thing to keep correct.

    @ReactMethod
    fun probe(promise: Promise) {
        probeModule.probeCapabilities(promise)
    }

    @ReactMethod
    fun measureSensorRates(durationMs: Double, promise: Promise) {
        probeModule.measureSensorRates(durationMs, promise)
    }

    // ── delegated: the Camera2 pack recorder ────────────────────────────

    @ReactMethod
    fun startRecording(options: ReadableMap?, promise: Promise) {
        recorderModule.start(options, promise)
    }

    @ReactMethod
    fun stopRecording(promise: Promise) {
        recorderModule.stop(promise)
    }

    @ReactMethod
    fun recordingStatus(promise: Promise) {
        recorderModule.status(promise)
    }

    // ── native: is the engine in this build ─────────────────────────────

    /**
     * The first thing to press. Resolves `{ nativeAvailable, json, loadError }`
     * — and resolves even when the .so did not load, because "the native half
     * is missing" is the single most useful thing this call can report and a
     * rejection would bury it in an error path the panel renders as "failed".
     */
    @ReactMethod
    fun engineInfo(promise: Promise) {
        CoroutineScope(Dispatchers.Default).launch {
            val err = ensureNativeOrNull()
            if (err != null) {
                promise.resolve(unavailablePayload(err))
                return@launch
            }
            try {
                val json = nativePanoEngineInfo()
                promise.resolve(
                    WritableNativeMap().apply {
                        putBoolean("nativeAvailable", true)
                        putString("json", json)
                    },
                )
            } catch (t: Throwable) {
                // UnsatisfiedLinkError lands here when the .so loaded but does
                // not export this entry — a STALE .so. Gradle reports SUCCESS
                // without relinking, so this is the failure an operator cannot
                // diagnose from a generic message. Name it.
                promise.resolve(unavailablePayload(describe(t)))
            }
        }
    }

    // ── native: derive the IMU→camera basis ─────────────────────────────

    /**
     * Derive `C` from `SENSOR_ORIENTATION` + lens facing + what the recorder
     * did to the buffer.
     *
     * `sensorOrientationDeg` has NO default: its absence is the "the
     * characteristic was never read" case, which the derivation refuses by
     * name. Defaulting it to 0 here would turn a refusal into a plausible
     * wrong answer, which is the exact failure the C++ header refuses to make.
     *
     * `lensFacing` is a raw `CameraCharacteristics.LENS_FACING` value.
     * ⚠ It must come from `CameraCharacteristics`, NEVER from the deprecated
     * `Camera.CameraInfo` — the two numberings are SWAPPED, and reading the
     * legacy one derives the FRONT basis for a BACK sweep without refusing
     * anything.
     */
    @ReactMethod
    fun deriveBasis(options: ReadableMap?, promise: Promise) {
        val sensorOrientationDeg = optInt(options, "sensorOrientationDeg", -1)
        val lensFacing = optInt(options, "lensFacing", 1)          // LENS_FACING_BACK
        val recorderRotation = optInt(options, "recorderRotation", 0)  // RawSensorBuffer
        val displayRotationDeg = optInt(options, "displayRotationDeg", 0)
        val explicitRotationCwDeg = optInt(options, "explicitRotationCwDeg", 0)
        val mirrored = optBool(options, "mirrored", false)
        val lensPoseReference = optInt(options, "lensPoseReference", 2)  // Undefined
        val poseQuatSense = optInt(options, "poseQuatSense", 0)
        val cameraFrameAdjustIndex = optInt(options, "cameraFrameAdjustIndex", 0)
        val poseThresholdDeg = optDbl(options, "poseThresholdDeg", 0.0)
        val referenceBasisIndex = optInt(options, "referenceBasisIndex", -1)

        // A quaternion that is present but not 4 long is DROPPED rather than
        // padded: three numbers are not a rotation, and fitting a padded one
        // would report a residual against a value nobody supplied.
        val quatArr = optArr(options, "lensPoseRotation")
        val quat: DoubleArray? = if (quatArr != null && quatArr.size() == 4) {
            try { DoubleArray(4) { quatArr.getDouble(it) } } catch (_: Throwable) { null }
        } else {
            null
        }

        CoroutineScope(Dispatchers.Default).launch {
            val err = ensureNativeOrNull()
            if (err != null) {
                promise.resolve(unavailablePayload(err))
                return@launch
            }
            try {
                val json = nativeDeriveBasis(
                    sensorOrientationDeg,
                    lensFacing,
                    recorderRotation,
                    displayRotationDeg,
                    explicitRotationCwDeg,
                    mirrored,
                    quat,
                    lensPoseReference,
                    poseQuatSense,
                    cameraFrameAdjustIndex,
                    poseThresholdDeg,
                    referenceBasisIndex,
                )
                promise.resolve(
                    WritableNativeMap().apply {
                        putBoolean("nativeAvailable", true)
                        putString("json", json)
                        // Echoed so a saved payload is self-describing: the
                        // quaternion's PRESENCE is the difference between a
                        // refused LENS_POSE block and one that was never asked
                        // for, and the JSON alone cannot say which.
                        putBoolean("lensPoseSupplied", quat != null)
                    },
                )
            } catch (t: Throwable) {
                promise.resolve(unavailablePayload(describe(t)))
            }
        }
    }

    // ── native: MEASURE the basis from a pack, and falsify the derived one ─

    /**
     * The other half of [deriveBasis], and the port's only falsification.
     *
     * [deriveBasis] computes `C` from `SENSOR_ORIENTATION` + lens facing. On a
     * device that does not publish `LENS_POSE_ROTATION` — the A35 does not —
     * NOTHING on the phone can contradict that answer, which is why the pack
     * has to carry `basisProvenance:"derived"`. This entry MEASURES `C`
     * instead, by running the engine's own `selectBasis()` over the ARCore
     * reference series a recording session logged beside the rotation vector.
     *
     * ⚠ THE MEASURED INDEX WINS IF THEY DISAGREE, and the SIZE of the
     * disagreement localises the fault: ~90° about the optical axis means the
     * recorder rotated the buffer without saying so; 180° about X is the
     * GL-vs-CV convention error. The report states both; this module decides
     * nothing.
     *
     * ⚠ AND A SINGLE-AXIS GESTURE CANNOT ANSWER IT AT ALL. A pure pan leaves a
     * 4-way EXACT tie (`refusal:"ambiguous-axis"`), which is why the report
     * carries the reference series' excitation and per-axis coaching — the
     * caller must render those rather than the index alone.
     *
     * Seconds, not minutes, but still off the JS thread: it parses two text
     * ledgers and fits 24 candidates.
     */
    @ReactMethod
    fun arcoreBasisRun(options: ReadableMap?, promise: Promise) {
        val packDir = stripFileScheme(optStr(options, "packDir", ""))
        if (packDir.isEmpty()) {
            promise.reject("invalid-options", "packDir required")
            return
        }
        val imuType = optStr(options, "imuType", "rotation-vector")
        val refField = optStr(options, "refField", "q")
        val tauS = optDbl(options, "tauS", 0.0)
        val derivedBasisIndex = optInt(options, "derivedBasisIndex", -1)
        val sweepSeconds = optDbl(options, "sweepSeconds", 0.0)
        val canvasPxPerDeg = optDbl(options, "canvasPxPerDeg", 0.0)

        // ±10 ms by default, five offsets. The point is NOT precision: it is
        // that a winner which MOVES under a plausible clock error was chosen by
        // the offset rather than by the geometry, and `basisStability` reports
        // exactly that. An explicit empty array turns the check off and is
        // reported as not-run, never as passed.
        val tauArr = optArr(options, "tauCandidatesS")
        val taus: DoubleArray = if (tauArr != null) {
            try { DoubleArray(tauArr.size()) { tauArr.getDouble(it) } }
            catch (_: Throwable) { doubleArrayOf() }
        } else {
            doubleArrayOf(-0.010, -0.005, 0.0, 0.005, 0.010)
        }

        CoroutineScope(Dispatchers.Default).launch {
            val err = ensureNativeOrNull()
            if (err != null) {
                promise.resolve(unavailablePayload(err))
                return@launch
            }
            try {
                val json = nativeArCoreBasisRun(
                    packDir, imuType, refField, tauS, taus,
                    derivedBasisIndex, sweepSeconds, canvasPxPerDeg,
                )
                promise.resolve(
                    WritableNativeMap().apply {
                        putBoolean("nativeAvailable", true)
                        putString("json", json)
                        // Echoed so a saved payload is self-describing: whether
                        // a derived index was OFFERED is the difference between
                        // "no comparison was possible" and "no comparison was
                        // asked for", and the JSON's `withheld` field alone
                        // reads the same for a caller that forgot to pass one.
                        putBoolean("derivedIndexSupplied", derivedBasisIndex >= 0)
                        putInt("tauOffsetsRequested", taus.size)
                    },
                )
            } catch (t: Throwable) {
                promise.resolve(unavailablePayload(describe(t)))
            }
        }
    }

    // ── native: replay a pack ───────────────────────────────────────────

    /**
     * Drive the engine over a pack directory: throughput, outcome counts, and
     * the per-row diff against the pack's own iOS ledger.
     *
     * ⚠ MINUTES, not milliseconds, on a full pack. Runs on Dispatchers.Default
     * — never the JS thread.
     *
     * `outDir` empty means measure-only (nothing written), which is what a
     * read-only pack location needs. The driver REFUSES an `outDir` that
     * resolves to the pack's own `panoplus/` — it would overwrite the very
     * ledger it is graded against.
     */
    @ReactMethod
    fun replayPack(options: ReadableMap?, promise: Promise) {
        val packDir = stripFileScheme(optStr(options, "packDir", ""))
        if (packDir.isEmpty()) {
            promise.reject("invalid-options", "packDir required")
            return
        }
        val outDir = stripFileScheme(optStr(options, "outDir", ""))
        val maxFrames = optInt(options, "maxFrames", 0)
        val writeCanvas = optBool(options, "writeCanvas", true)
        val writeLedger = optBool(options, "writeLedger", true)
        val canvasQuality = optInt(options, "canvasQuality", 92)
        val canvasCropPad = optBool(options, "canvasCropPad", true)
        val useMetaConfig = optBool(options, "useMetaConfig", true)
        val compareLedger = optBool(options, "compareLedger", true)
        val frameMissingReportCap = optInt(options, "frameMissingReportCap", 8)

        // `configOverrides` is a plain object: { knobName: value }. Values are
        // stringified here because the C++ side parses them itself (one table,
        // shared with meta.json's reader) — a typed marshalling would be a
        // second table to keep in step, and the knob set changes.
        val names = ArrayList<String>()
        val values = ArrayList<String>()
        val ov = try {
            if (options != null && options.hasKey("configOverrides")
                && !options.isNull("configOverrides")
            ) {
                options.getMap("configOverrides")
            } else {
                null
            }
        } catch (_: Throwable) {
            null
        }
        if (ov != null) {
            val it = ov.keySetIterator()
            while (it.hasNextKey()) {
                val k = it.nextKey()
                val v: String? = try {
                    when (ov.getType(k)) {
                        com.facebook.react.bridge.ReadableType.Number ->
                            formatKnobNumber(ov.getDouble(k))
                        com.facebook.react.bridge.ReadableType.Boolean ->
                            if (ov.getBoolean(k)) "true" else "false"
                        com.facebook.react.bridge.ReadableType.String -> ov.getString(k)
                        // Null/Map/Array are not knob values. Passed through as
                        // an empty string so the DRIVER counts them in
                        // overridesMalformed — dropping them here would hide an
                        // A/B arm that never ran.
                        else -> ""
                    }
                } catch (_: Throwable) {
                    ""
                }
                names.add(k)
                values.add(v ?: "")
            }
        }

        CoroutineScope(Dispatchers.Default).launch {
            val err = ensureNativeOrNull()
            if (err != null) {
                promise.resolve(unavailablePayload(err))
                return@launch
            }
            try {
                val startedMs = System.currentTimeMillis()
                val json = nativeReplayPack(
                    packDir,
                    outDir,
                    maxFrames,
                    writeCanvas,
                    writeLedger,
                    canvasQuality,
                    canvasCropPad,
                    useMetaConfig,
                    compareLedger,
                    frameMissingReportCap,
                    names.toTypedArray(),
                    values.toTypedArray(),
                )
                promise.resolve(
                    WritableNativeMap().apply {
                        putBoolean("nativeAvailable", true)
                        putString("json", json)
                        // WALL time around the whole native call, which the
                        // C++ report cannot see. It includes JNI marshalling
                        // and the frame decode the report separates out, so it
                        // is a CEILING on the engine cost, never the engine
                        // cost — read `msP50` in the JSON for that.
                        putDouble(
                            "wallMs",
                            (System.currentTimeMillis() - startedMs).toDouble(),
                        )
                    },
                )
            } catch (t: Throwable) {
                promise.resolve(unavailablePayload(describe(t)))
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /**
     * `%s` on a Double gives `1.0` for an integral knob, and a knob the C++
     * table parses as an int would then be a malformed value. Emit integral
     * doubles without the fractional part; everything else with enough digits
     * to round-trip.
     */
    private fun formatKnobNumber(v: Double): String =
        if (v.isFinite() && v == Math.floor(v) && Math.abs(v) < 1e15) {
            v.toLong().toString()
        } else {
            v.toString()
        }

    private fun describe(t: Throwable): String =
        "${t.javaClass.simpleName}: ${t.message ?: "(no message)"}"

    private fun unavailablePayload(loadError: String): WritableNativeMap =
        WritableNativeMap().apply {
            putBoolean("nativeAvailable", false)
            putString("loadError", loadError)
            // A parseable payload on EVERY path, so JS has one shape to read
            // and a missing .so cannot look like a corrupt report.
            putString(
                "json",
                "{\"ok\":false,\"error\":\"native library unavailable\"}",
            )
        }

    /**
     * Load the JNI shim, returning null on success or the reason on failure.
     *
     * RETURNS the failure rather than throwing (the shape StitchPluginsModule's
     * `ensureNative` uses is right for its callers, which are inside a
     * try/catch that rejects). Here a missing .so is a RESULT the operator
     * needs to see on screen, not an error path.
     *
     * libopencv_java4 must load FIRST: the shim dynamically links against it.
     * Loading an already-loaded library is a no-op, so this is safe alongside
     * StitchPluginsModule's own ensureNative and the stitcher's.
     */
    private fun ensureNativeOrNull(): String? =
        // One loader for the whole package: it remembers each outcome, never
        // throws, and names the library, the running ABIs and the remedy.
        io.imagestitcher.rn.NativeLibraryLoader.loadPanoPlusOrReason()

}
