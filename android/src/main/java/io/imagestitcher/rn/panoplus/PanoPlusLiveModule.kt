// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusLiveModule — `RNSSweepSession` on Android.
//
// ── THE NAME IS DELIBERATELY iOS'S ──────────────────────────────────────────
//
// `PanoPlusAndroidModule` is named `RNSSweepTools` and its header
// argues at length that a shared name would be wrong. That argument stands, and
// this class is not a contradiction of it: the two modules have genuinely
// different CONTRACTS (`startRecording` records a pack for offline replay;
// `start` runs a live sweep), so they keep different names.
//
// THIS one has iOS's contract — the same five methods, the same option bag, the
// same reject codes, the same status keys — so it takes iOS's name, and the SDK
// needs no platform branch. The argument is not new: an earlier module took
// the same iOS name for the same reason, and the failure it fixed is the one
// the operator is looking at now — until that module was registered,
// `NativeModules.<Name>` was absent on Android and every call through it
// silently refused. Here the same absence renders as
// "pano+ is not available in this build … the RNSSweepSession native module
// is not registered", which the operator reads — correctly — as the feature
// being missing.
//
// ⚠ THE PROBE THAT NOW ANSWERS TRUE ON ANDROID. `panoPlusIsAvailable()` is
// `typeof mod.start/stop/cancel === 'function'` (panoPlusNative.ts:45-57).
// Registering this module flips it, so every guard that used "the module is
// present" as a proxy for "this is iOS" now sees Android. The SDK's
// operator-facing unavailable copy says "iOS-only" and must be corrected in the
// same release, or the message becomes a lie in the other direction.
//
// ── ONE SESSION, SHARED WITH THE RECORDER ───────────────────────────────────
//
// This module owns NO camera. It delegates to the SAME
// `PanoPlusAndroidRecorder` instance the package registered, with `live: true`
// added to the option bag — because there is exactly one back camera and
// therefore exactly one sweep, and two objects that could each open it is a
// camera nobody can close. The recorder is the capture arm; this class is the
// iOS-shaped door onto it.
//
// ── WHAT THIS ARM CANNOT DO, STATED HERE ────────────────────────────────────
//
//  * `poseSource: 'ar'` RUNS ARCore SINCE 2026-09-02 — and may still answer
//    'imu'. Asking for it turns on the SHARED-camera ARCore channel and feeds
//    its `world<-camera` poses to the engine with no basis; when that channel
//    cannot open shared (four recorded reasons), the sweep runs on the IMU arm
//    rather than being lost, and `poseSource` / `poseSourceNote` say so. The
//    resolve carries THE ARM THAT ACTUALLY RAN, never the request — which is
//    what it always did; what changed is that the answer can now be 'ar'.
//    ⚠ The AR arm is not free and the price is in the pack (`device.json` →
//    `arm.costs`): ARCore picks the camera (0, 69.7°, NO ULTRA-WIDE) and the
//    CPU image size, its repeating request owns the AE/AWB lock, and the pose
//    series is the camera's ~30 Hz rather than the rotation vector's ~122 Hz.
//  * `setIdlePreview` NOW OPENS A REAL PRE-SWEEP VIEWFINDER (2026-09-02).
//    It used to resolve `{on:false}` with an accurate explanation — the
//    Android preview was an output of the recorder's own capture session, so
//    there was a live feed during a sweep and none before it — and the
//    operator could therefore not FRAME the shot, which on a slit-scan arm
//    anchors the whole canvas. `PanoPlusIdlePreviewSession` is the second,
//    much shorter camera lifecycle; the recorder owns both and closes this one
//    (waiting for `onClosed`) before a sweep opens anything.
//  * `cancel()` does NOT delete the pack. iOS deletes because its only caller
//    is an operator abandoning a sweep; here the same call is reached by
//    unmounts and error paths, and a deleted pack is deleted evidence.

package io.imagestitcher.rn.panoplus

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * RN's [Promise] has ten `reject` overloads. A shim that re-spells all ten is
 * ten chances to get a nullability or an argument order wrong, and the compiler
 * only catches the ones that fail to override — a signature that merely
 * DIFFERS becomes a new method nobody calls, and the rejection then reaches the
 * default implementation instead of the mapping. So they are funnelled once,
 * here, and every shim implements two methods.
 */
private abstract class MappedPromise : Promise {
    abstract fun onResolve(value: Any?)
    abstract fun onReject(code: String?, message: String?)

    final override fun resolve(value: Any?) = onResolve(value)

    final override fun reject(code: String?, message: String?) = onReject(code, message)
    final override fun reject(code: String?, throwable: Throwable?) =
        onReject(code, throwable?.message)
    final override fun reject(code: String?, message: String?, throwable: Throwable?) =
        onReject(code, message ?: throwable?.message)
    final override fun reject(throwable: Throwable) = onReject(null, throwable.message)
    final override fun reject(throwable: Throwable, userInfo: WritableMap) =
        onReject(null, throwable.message)
    final override fun reject(code: String?, userInfo: WritableMap) = onReject(code, null)
    final override fun reject(
        code: String?,
        throwable: Throwable?,
        userInfo: WritableMap,
    ) = onReject(code, throwable?.message)
    final override fun reject(code: String?, message: String?, userInfo: WritableMap) =
        onReject(code, message)
    final override fun reject(
        code: String?,
        message: String?,
        throwable: Throwable?,
        userInfo: WritableMap?,
    ) = onReject(code, message ?: throwable?.message)

    @Deprecated("Prefer reject(code, message)", ReplaceWith("reject(code, message)"))
    final override fun reject(message: String) = onReject(null, message)
}

class PanoPlusLiveModule(
    reactContext: ReactApplicationContext,
    private val recorder: PanoPlusAndroidRecorder,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RNSSweepSession"

    /**
     * M4 — a JS reload or a torn-down bridge must not leave the sweep's AE/AWB
     * lock on vision-camera's camera: interop request options outlive the
     * module, and a lock left behind pins the exposure of every photo taken
     * after it. The recorder clears it on every sweep teardown; this covers the
     * teardown that never reaches the recorder.
     */
    override fun invalidate() {
        try { PanoPlusVcBridge.cameraLock?.unlock() } catch (_: Throwable) { }
        // The capture-result tap outlives a JS reload like the lock does.
        try { PanoPlusVcBridge.cameraLock?.detachResults() } catch (_: Throwable) { }
        super.invalidate()
    }

    /**
     * ── WHY THIS PACKAGE SHIPS ITS OWN DOCUMENT DIRECTORY ────────────────
     * A sweep needs one thing from the filesystem before it can start: a
     * writable base directory to put the session under. Native creates the
     * session directory itself, so that single path is the whole requirement.
     *
     * pano+ got that path from `expo-file-system`, because the host it grew up
     * in is an Expo app. That dependency came along when pano+ moved into this
     * package and turned into a hidden, unstated requirement: a plain React
     * Native app installing `react-native-image-stitcher` — including THIS
     * repo's own example app — got "pano+ is not available", a message whose
     * wording sends the reader to the build when the truth was a missing peer
     * dependency they were never told about.
     *
     * An Apache-2.0 package must not require Expo to run its own feature. So
     * the base path comes from here, and the host's `expo-file-system` is now
     * a PREFERENCE rather than a requirement — see `fileSystem.ts`, which
     * still uses the host's copy when there is one so existing hosts keep
     * writing to exactly the directory they always did.
     *
     * A CONSTANT, not a `@ReactMethod`: the surface reads this during render
     * to decide whether it can offer a capture at all, and a promise cannot
     * answer a synchronous question without adding a frame in which the
     * feature falsely appears unavailable.
     *
     * `filesDir` is the deliberate choice — it is app-private, survives the
     * cache eviction that would delete a half-finished sweep out from under
     * the engine, and matches what `expo-file-system` reports for
     * `documentDirectory` on Android. The trailing slash and the `file://`
     * scheme match Expo's format exactly so both paths through
     * `loadVideoFileSystem()` hand the surface the same shape of string.
     */
    override fun getConstants(): MutableMap<String, Any> = hashMapOf(
        "documentDirectory" to
            documentDirectoryUri(reactApplicationContext.filesDir.absolutePath) as Any,
    )

    companion object {
        /**
         * The `filesDir` path in the exact shape `expo-file-system` reports
         * for `documentDirectory`: a `file://` URI with a TRAILING SLASH.
         *
         * Pure, and separate from [getConstants], because the format is the
         * only part that can be wrong and it is the part with a contract.
         * JS concatenates a session name straight onto this string, so a
         * missing trailing slash does not fail — it silently writes a
         * SIBLING of the app's files directory named `filessession-1`. And a
         * missing scheme would reach `barePath()`, which strips `file://`
         * and would then have nothing to strip, so both spellings have to
         * agree for a host to be able to swap between Expo's copy and this
         * one without moving its data.
         */
        @JvmStatic
        internal fun documentDirectoryUri(absolutePath: String): String =
            "file://" + absolutePath.trimEnd('/') + "/"
    }

    // ── Engine knobs the SDK may send at the TOP LEVEL of the option bag ──
    // iOS reads them off the same flat dictionary
    // (`RNISPanoCore.startWithOptions`), so the SDK sends them flat and this
    // class must pick them out of it. The NAMES are the C++ field names — the
    // ones `applyConfigOverride` and `meta.json` already use — so this list is
    // a FILTER and never a translation: a key that reaches native under a
    // different spelling is a knob that silently did not apply.
    //
    // A knob absent from this list still reaches native if the caller puts it
    // in `configOverrides`, and native reports it by name in
    // overridesUnknown/overridesMalformed either way. So the cost of this list
    // being incomplete is a knob that needs the explicit route, never a knob
    // that silently reverts.
    private val engineKnobKeys = listOf(
        "canvasScale", "stripMargin", "minAdvancePx", "maxAdvancePx", "maxAdvanceFrac",
        "maxSweepSpeedMps", "poseSlackM", "rectify", "gainMatch", "gainStepClamp",
        "gainCumClamp", "gainSampleMinPx", "workScale", "phaseWindowPx",
        "minPhaseResponse", "stallResumeResponse", "maxRejectRunFrames",
        "canvasInitWidthPx", "canvasMaxWidthPx", "canvasPadPx", "canvasGrowVertical",
        "canvasMaxHeightPx", "canvasMaxPixels", "backfillGaps",
        "abortOnLimitedTracking", "trackingWarmupFrames", "cageStallFrames",
        "axisLatchFrames", "maxTranslationJumpM", "rectifyYawLimitDeg",
        "axisOverride", "signOverride", "cropVertical", "projection", "sweepMaxDeg",
        // v14 — THE UPRIGHT BAKE. The host computes it from the hold it
        // measured at Start; `correctUprightRotation` below re-derives it
        // against this device's real SENSOR_ORIENTATION before it ships.
        "outputRotationCwDeg",
        "subjectDistanceM", "subjectDistanceAuto", "seamMetrics",
        "exposureNormalize", "exposureGainClamp", "photoMinSamples",
        "photoGradMaxDN", "photoUniformMinFrac", "photoLocalWindowPx",
        "lensUndistort", "lensDeviceModel", "lensDeviceLens",
        // THE ELBOW FIX (2026-09-06). The seed/tail blocks continue the
        // strips' cross-axis tilt (`crossTraj` 0 off / 1 chain / 2 overlap),
        // ease it off after the join (`crossTrajRelaxPx`, 0 = keep to the far
        // edge, 100 = the operator's RELAX flavour), anchor the lead-out on the
        // commit frontier, and let the preview's growing edge follow the same
        // trajectory (`leadOutTraj`). Applied by name through
        // `replay::applyConfigOverride`, like every key above.
        "crossTraj", "crossTrajRelaxPx", "leadOutFromFrontier", "leadOutTraj",
        // THE IMAGE-FITTED CROSS SCALE (2026-09-16). `crossFitMode` 1 drives the
        // cross-axis scale from the image instead of from pose forward travel,
        // which is identically zero on an imu-attitude-only arm and leaves the
        // shipped mode-2 driver pinned at exp(0) = 1. The other three make that
        // usable: mode 1 alone random-walks to a 19% vertical squash. Note
        // `crossFitMode` was NOT on this list before — it was reachable only
        // through explicit configOverrides, which is exactly the "needs the
        // explicit route" case the header above describes.
        "crossFitMode", "crossFitDcRemove", "crossScaleLeak", "crossFitMinBandR2",
        // THE SEED LEAD-IN TRIM (2026-09-23, engine v16). Default ON; a host
        // sending `seedLeadTrim: false` gets the control arm — on iOS that
        // top-level key is read directly (RNISPanoCore.mm), so without this
        // entry the same options object ran the control arm on one platform
        // and the trim on the other, with nothing reported.
        "seedLeadTrim",
    )

    // ── ReadableMap accessors that DEGRADE ──────────────────────────────
    // The bridge getters throw ClassCastException on a type mismatch; a
    // malformed option must fall back to its default, never red-screen a
    // capture. Same rule, same words, as the recorder's own copy.
    private fun optStr(m: ReadableMap?, k: String, d: String?): String? =
        try { if (m != null && m.hasKey(k)) m.getString(k) ?: d else d } catch (_: Throwable) { d }
    private fun optBool(m: ReadableMap?, k: String, d: Boolean): Boolean =
        try { if (m != null && m.hasKey(k)) m.getBoolean(k) else d } catch (_: Throwable) { d }
    private fun optDbl(m: ReadableMap?, k: String, d: Double): Double =
        try { if (m != null && m.hasKey(k)) m.getDouble(k) else d } catch (_: Throwable) { d }
    private fun hasKeySafe(m: ReadableMap?, k: String): Boolean =
        try { m != null && m.hasKey(k) && !m.isNull(k) } catch (_: Throwable) { false }

    // ════════════════════════════════════════════════════════════════════
    //  start
    // ════════════════════════════════════════════════════════════════════

    /**
     * Begin a live sweep.
     *
     * Resolves `{ sessionDir, startedAtMs, pluginAvailable, poseSource,
     * cameraLock, live… }` — the shape `startPanoPlus` maps
     * (panoPlusNative.ts:110-138).
     *
     * ⚠ NOTHING BLOCKS THIS THREAD. `recorder.start` dispatches onto
     * `Dispatchers.IO` before it opens anything, so the body here is a bag
     * translation and a hand-off. That is not an optimisation: an
     * `@ReactMethod` runs on RN's ONE NativeModules queue thread, and a block
     * there wedges every native module in the app — the exact class of bug
     * `RNSARSession.setKeyframeQualityCaptureEnabled` was just fixed for.
     */
    @ReactMethod
    fun start(options: ReadableMap?, promise: Promise) {
        val sessionDir = optStr(options, "sessionDir", null)
        if (sessionDir.isNullOrEmpty()) {
            promise.reject("invalid-options", "sessionDir is required")
            return
        }
        if (PanoPlusLiveNative.running()) {
            // The one code the surface knows means "a sweep is already up".
            promise.reject(
                "panoplus-busy",
                "a pano+ sweep is already running; stop it before starting another.",
            )
            return
        }

        val nativeErr = PanoPlusLiveNative.availability()
        if (nativeErr != null) {
            // REFUSE rather than start a recording the caller did not ask for.
            // `start()` resolving would put the surface into a sweep whose
            // stop() can only ever return "no panorama", and the operator would
            // spend the sweep before learning that.
            promise.reject(
                "panoplus-unavailable",
                "the pano+ engine is not in this build: $nativeErr",
            )
            return
        }

        // ── The recorder's bag ───────────────────────────────────────────
        val bag = WritableNativeMap()
        bag.putBoolean("live", true)
        // ⚠ THE PACK DIRECTORY, NOT ITS PARENT. The recorder appends
        // `panoplus/` to `sessionDir`, and the native live session writes
        // frames/, ledger.jsonl, meta.json, preview.jpg and canvas.jpg into
        // whatever directory it is handed — so it is handed the recorder's own
        // packDir, and the two halves of one sweep land in one place.
        bag.putString("sessionDir", stripFileScheme(sessionDir))
        bag.putString("packFrames", optStr(options, "packFrames", "none") ?: "none")
        bag.putBoolean("writeLedger", optBool(options, "writeLedger", true))
        // ── THE POSE ARM ─────────────────────────────────────────────
        // Passed through. A LIVE AR sweep is always the AR-plugin arm (see
        // PanoPlusStartMode): it runs on the stitcher's ARCore session and
        // opens no ARCore of pano+'s own, so nothing is injected here any more.
        //
        // ⚠ THIS USED TO INJECT `arcoreReference: 'shared'` FOR EVERY AR SWEEP,
        // which opened pano+'s own ARCore channel — a second camera owner — in
        // front of whichever arm then ran. A caller that explicitly asks for the
        // reference channel on a live AR sweep is now refused by name by the
        // recorder; on an IMU sweep it is still the basis-falsification run.
        val requestedPose = optStr(options, "poseSource", "imu") ?: "imu"
        bag.putString("poseSource", requestedPose)
        bag.putString("arcoreReference", optStr(options, "arcoreReference", "off") ?: "off")
        bag.putInt("jpegQuality", optDbl(options, "packFrameQuality", 70.0).toInt())
        bag.putInt("maxFrames", optDbl(options, "packMaxFrames", 4000.0).toInt())
        bag.putInt("canvasQuality", optDbl(options, "canvasQuality", 92.0).toInt())
        bag.putBoolean("canvasCropPad", optBool(options, "canvasCropPad", true))

        // ── Preview ──────────────────────────────────────────────────────
        // The ANDROID defaults, not iOS's, and the reason is Fresco: RN's
        // `<Image>` keys its bitmap memory cache by URI INCLUDING the query
        // string, and the preview cache-busts with `?v=<seq>` on every publish.
        // At iOS's 2000x800 each tick interns a 6.4 MB ARGB_8888 bitmap into an
        // LRU nothing evicts by hand, on a process that has peaked at 1.33 GB.
        // 1200x480 is 2.3 MB and still ~3x the panel's device pixels, so the
        // cost is preview sharpness alone.
        bag.putDouble("previewIntervalMs", optDbl(options, "previewIntervalMs", 120.0))
        bag.putDouble("previewMaxDutyPct", optDbl(options, "previewMaxDutyPct", 8.0))
        bag.putInt("previewQuality", optDbl(options, "previewQuality", 82.0).toInt())
        bag.putInt("previewMaxAlong", optDbl(options, "previewMaxAlong", 1200.0).toInt())
        bag.putInt("previewMaxCross", optDbl(options, "previewMaxCross", 480.0).toInt())
        bag.putDouble(
            "previewWindowCrossMult",
            optDbl(options, "previewWindowCrossMult", 1.44),
        )
        bag.putBoolean("previewCropPad", optBool(options, "previewCropPad", true))
        bag.putBoolean("previewLeadOut", optBool(options, "previewLeadOut", true))
        // ⚠ A RECORDER KNOB, NOT AN ENGINE ONE, so it takes the explicit
        // route rather than riding engineKnobKeys. It chooses which Android
        // attitude series drives the geometry: false = TYPE_ROTATION_VECTOR
        // (magnetometer-fused, the shipped default and the one whose indoor
        // heading pull keystones the canvas), true = TYPE_GAME_ROTATION_VECTOR
        // (magnetometer-free). Both are logged either way. See the field's
        // own doc on PanoPlusRecorderConfig for the measurement.
        // ⚠ ANDROID IGNORED THIS ENTIRELY UNTIL 2026-09-10. The flag existed
        // in the store, had a row in the flags screen and was passed by the
        // capture screen — and died HERE, unforwarded, so the recorder
        // applied CONTROL_AE_LOCK unconditionally. The operator ran a
        // four-capture A/B on it ("lock off, on, on, off") and all four came
        // back locked. iOS has honoured it since v6.
        bag.putBoolean("lockCamera", optBool(options, "lockCamera", true))
        bag.putBoolean("attitudeMagFree", optBool(options, "attitudeMagFree", false))
        // S5 — the vision-camera plugin arm, and the camera id it needs.
        // Forwarded unconditionally like every other bag key: the RECORDER
        // decides whether the arm applies (it reads the flag together with
        // the pose arm), and a module that filtered here would be a second
        // place that decision lives.
        bag.putBoolean("vcPluginArm", optBool(options, "vcPluginArm", false))
        // M3 — see PanoPlusStartMode.REFUSE_LIVE_WITHOUT_CAMERA.
        bag.putBoolean("allowOwnCamera", optBool(options, "allowOwnCamera", false))
        bag.putString("vcCameraId", optStr(options, "vcCameraId", "") ?: "")
        // M4 — vision-camera's CameraView tag, for the AE/AWB lock.
        bag.putInt("vcViewTag", optDbl(options, "vcViewTag", 0.0).toInt())

        // ── Camera ───────────────────────────────────────────────────────
        // The ultra-wide by default (`preferPhysical`), 60 fps preferred, and
        // the AE/AWB lock the recorder already asserts after its settle poll —
        // the banding defence the operator rejected twice on iOS.
        if (hasKeySafe(options, "cameraId")) {
            bag.putString("cameraId", optStr(options, "cameraId", null))
        }
        // ── THE CHIP'S LENS (2026-09-03) ─────────────────────────────
        // `'ultraWide'` | `'wide'`, copied through whenever the SDK sends it.
        // It used to stop HERE — the surface sent it on the IMU arm and this
        // method never put it in the bag, so the recorder's widest-FOV rule
        // ran on every sweep and the chip was a readout. The recorder decides
        // (an explicit cameraId and ARCore's forced id both outrank it) and
        // records what ran in `lensRan` / `lensNote`; see PanoPlusLens.kt.
        if (hasKeySafe(options, "lens")) {
            bag.putString("lens", optStr(options, "lens", null))
        }
        if (hasKeySafe(options, "focusDistanceM")) {
            bag.putDouble("focusDistanceM", optDbl(options, "focusDistanceM", 0.0))
        }
        bag.putInt("maxWidth", optDbl(options, "maxWidth", DEFAULT_MAX_WIDTH.toDouble()).toInt())
        bag.putInt("preferFps", optDbl(options, "preferFps", 60.0).toInt())
        bag.putBoolean("preferPhysical", optBool(options, "preferPhysical", true))

        // ── Engine knobs ─────────────────────────────────────────────────
        val overrides = WritableNativeMap()
        if (options != null) {
            for (k in engineKnobKeys) {
                if (!hasKeySafe(options, k)) continue
                try {
                    when (options.getType(k)) {
                        ReadableType.Number -> overrides.putDouble(k, options.getDouble(k))
                        ReadableType.Boolean -> overrides.putBoolean(k, options.getBoolean(k))
                        ReadableType.String -> overrides.putString(k, options.getString(k))
                        // Deliberately passed as null so native counts it in
                        // overridesMalformed: an A/B arm that never ran must be
                        // visible, and dropping it here would hide it.
                        else -> overrides.putNull(k)
                    }
                } catch (_: Throwable) {
                    overrides.putNull(k)
                }
            }
            // An explicit `configOverrides` object wins over the flat keys — it
            // is the caller saying "this exact knob, this exact value".
            if (hasKeySafe(options, "configOverrides")) {
                try {
                    val extra = options.getMap("configOverrides")
                    if (extra != null) overrides.merge(extra)
                } catch (_: Throwable) {}
            }
        }
        // ── v14: the upright bake, checked against THIS device ───────────
        correctUprightRotation(overrides)
        bag.putMap("configOverrides", overrides)

        recorder.start(bag, StartShim(promise, sessionDir, requestedPose))
    }

    // ════════════════════════════════════════════════════════════════════
    //  v14 — the upright bake, made device-authoritative
    // ════════════════════════════════════════════════════════════════════

    /// This device's back-camera `SENSOR_ORIENTATION`, read ONCE and OFF this
    /// module's queue.
    ///
    /// ⚠ THE READ NEVER HAPPENS ON THE RN THREAD. `getCameraIdList` /
    /// `getCameraCharacteristics` are binder calls into the camera service, and
    /// a cold service makes them tens of milliseconds — on RN's ONE
    /// NativeModules queue, which `start()`'s header already forbids blocking
    /// and which `PanoPlusAndroidProbe` hops off `Dispatchers.Default` to avoid
    /// for exactly these two calls. So it is warmed in the background at module
    /// construction and `start()` only ever CONSULTS the result.
    ///
    /// `0` is a legal SENSOR_ORIENTATION, so "not read yet" has to be a
    /// separate flag and never a zero.
    @Volatile
    private var backSensorOrientationDeg: Int? = null

    @Volatile
    private var backSensorOrientationRead = false

    init {
        warmBackSensorOrientation()
    }

    /// Fire-and-forget. Idempotent by the `backSensorOrientationRead` flag, and
    /// re-kicked from `start()` so a first read that lost a race (or threw) is
    /// retried before the NEXT sweep rather than never.
    private fun warmBackSensorOrientation() {
        if (backSensorOrientationRead) return
        CoroutineScope(Dispatchers.Default).launch { readBackSensorOrientationDeg() }
    }

    private fun readBackSensorOrientationDeg(): Int? {
        if (backSensorOrientationRead) return backSensorOrientationDeg
        backSensorOrientationDeg = try {
            val mgr = reactApplicationContext
                ?.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            var found: Int? = null
            var conflict = false
            for (id in mgr?.cameraIdList ?: emptyArray()) {
                val chars = try { mgr!!.getCameraCharacteristics(id) } catch (_: Throwable) { null }
                    ?: continue
                val facing = chars.get(CameraCharacteristics.LENS_FACING)
                if (facing != CameraCharacteristics.LENS_FACING_BACK) continue
                val orient = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: continue
                if (found == null) found = orient else if (found != orient) conflict = true
            }
            // Every back-facing camera is bolted to the same body, so they agree
            // on every device we have measured. If they DISAGREE this read
            // cannot say which one the recorder will open, and guessing would
            // be a coin flip on the deliverable's orientation — so it declines
            // and the host's value stands.
            if (conflict) null else found
        } catch (_: Throwable) {
            null
        }
        // Set LAST: the flag is what `correctUprightRotation` reads to decide
        // the value is trustworthy, so it must not become true before the value
        // it is vouching for exists.
        backSensorOrientationRead = true
        return backSensorOrientationDeg
    }

    /**
     * Re-derive `outputRotationCwDeg` against THIS device's real
     * `SENSOR_ORIENTATION`.
     *
     * The host cannot know it. The SDK computes the bake as
     * `90 − deviceRotationCw`, where 90 is the back-camera sensor constant —
     * true on the A35 (`device.json`) and on every phone this ships to, and NOT
     * a law: some tablets report 0 or 270. So the host value is treated as
     * carrying the HOLD (which only the host measured) and this re-derives the
     * BAKE (which only the device knows):
     *
     *   displayRotationCw = (90 − hostValue) mod 360        ← the hold it meant
     *   outputRotationCw  = (sensorOrientation − displayRotationCw) mod 360
     *
     * On a sensor-90 device the two steps cancel and the host value is passed
     * through unchanged, which is the case every measurement in this programme
     * has covered. Nothing here can turn an absent key into a rotation: no
     * `outputRotationCwDeg` in the bag means the deliverable stays in the raster
     * frame exactly as it did before v14.
     *
     * Never throws — a malformed override is left exactly as the host sent it,
     * and the engine's own `configure()` refuses anything that is not a quarter
     * turn, by name, at start.
     */
    private fun correctUprightRotation(overrides: WritableNativeMap) {
        try {
            val key = PanoPlusUprightRotation.KEY
            val host = try {
                if (!overrides.hasKey(key) || overrides.isNull(key)) return
                overrides.getDouble(key).toInt()
            } catch (_: Throwable) {
                return
            }
            // CONSULT ONLY — never the read itself. Not warm yet (first sweep
            // of a very fresh process, or a read that threw) means the host's
            // value stands, which is correct on every device this programme has
            // measured; the re-kick below gets the next sweep.
            if (!backSensorOrientationRead) { warmBackSensorOrientation(); return }
            val sensor = backSensorOrientationDeg ?: return
            if (!PanoPlusUprightRotation.isSupportedSensorOrientation(sensor)) return
            // The identity case: the two steps below would cancel exactly.
            if (sensor == PanoPlusUprightRotation.SDK_ASSUMED_SENSOR_ORIENTATION_DEG) return
            val display = PanoPlusUprightRotation.impliedDisplayRotationCwDeg(
                PanoPlusUprightRotation.SDK_ASSUMED_SENSOR_ORIENTATION_DEG,
                host,
            ) ?: return
            val corrected =
                PanoPlusUprightRotation.uprightRotationCwDeg(sensor, display) ?: return
            overrides.putDouble(key, corrected.toDouble())
        } catch (_: Throwable) {
            // Leave the host's value in place. A sweep that paints is worth more
            // than a sweep refused over an orientation refinement.
        }
    }

    /**
     * Maps the recorder's start payload onto the shape `startPanoPlus` reads,
     * and maps its reject codes onto the six the surface handles by name.
     *
     * A shim rather than a `.then`: `recorder.start` settles its Promise from
     * whichever of five callbacks gets there first (the settle guard is inside
     * the recorder), and interposing here keeps that single-settle discipline
     * intact instead of adding a second place a double-settle could happen.
     */
    private inner class StartShim(
        private val inner: Promise,
        private val sessionDir: String,
        private val requestedPose: String,
    ) : MappedPromise() {
        override fun onResolve(value: Any?) {
            val m = value as? ReadableMap
            val out = WritableNativeMap()
            out.putString("sessionDir", optStr(m, "packDir", sessionDir) ?: sessionDir)
            out.putDouble("startedAtMs", System.currentTimeMillis().toDouble())
            // `pluginAvailable` on iOS means "the AR frame plugin is registered
            // and frames will arrive". Here the equivalent fact is that the
            // native engine opened — a recorder running with `liveActive:false`
            // will produce a pack and never a canvas, and the surface must not
            // read that as a live sweep.
            out.putBoolean("pluginAvailable", optBool(m, "liveActive", false))
            // ⚠ THE ARM THAT RAN, READ FROM THE RECORDER — never a constant
            // and never the request. This line was `putString("poseSource",
            // "imu")` unconditionally until 2026-09-02, which was correct while
            // no ARCore-fed path existed and became the bug the moment one did:
            // the field that records which series painted the pixels must come
            // from the object that fed them.
            //
            // Defaulting to "imu" when the key is ABSENT is deliberate — an old
            // recorder in a mixed build has no AR arm, and the honest answer
            // for it is the arm it has.
            val ran = optStr(m, "poseSourceRan", "imu") ?: "imu"
            out.putString("poseSource", ran)
            if (requestedPose != ran) {
                out.putString("poseSourceRequested", requestedPose)
                out.putString(
                    "poseSourceNote",
                    "poseSource '$requestedPose' was requested and '$ran' ran. " +
                        (optStr(m, "poseArmReason", null)
                            ?: "The recorder did not say why; read device.json's arm block."),
                )
            } else if (ran == "ar") {
                // ⚠ SAID EVEN WHEN NOTHING WENT WRONG. The AR arm's costs are
                // not a failure and are exactly the thing that makes two packs
                // incomparable, so they travel with a SUCCESSFUL start too —
                // otherwise the only sweep whose confounds are stated is the
                // one that refused.
                out.putString(
                    "poseSourceNote",
                    optStr(m, "poseArmReason", null)
                        ?: "The AR arm is running; read device.json's arm block for its costs.",
                )
            }
            // Everything the panel needs to explain a canvas that never grows,
            // at START, while re-running the sweep is still free.
            out.putBoolean("liveActive", optBool(m, "liveActive", false))
            copyString(m, out, "poseArmReason")
            copyString(m, out, "liveStartError")
            copyString(m, out, "packFrames")
            copyString(m, out, "previewNote")
            copyString(m, out, "qSource")
            copyString(m, out, "sizeChoiceReason")
            out.putBoolean("previewAttached", optBool(m, "previewAttached", false))
            out.putBoolean("attitudeMapActive", optBool(m, "attitudeMapActive", false))
            // ── THE LENS THAT RAN (2026-09-03) ──────────────────────────
            // `lensRan` is the pack's answer ('ultraWide' | 'wide'), `cameraId`
            // the Camera2 id behind it, `lensHonoured` false when the chip's
            // request could not be met (no ultra-wide; the AR arm, where
            // ARCore configures the session) and `lensNote` says why. The
            // same rule as `poseSource` above: what RAN, never the request.
            copyString(m, out, "cameraId")
            copyString(m, out, "lensRequested")
            copyString(m, out, "lensRan")
            out.putBoolean("lensHonoured", optBool(m, "lensHonoured", false))
            copyString(m, out, "lensNote")
            out.putDouble("hFovDeg", optDbl(m, "hFovDeg", -1.0))
            // `cameraLock` is iOS's block. Android's read-backs are only known
            // after the sweep (they are written on camThread and published by
            // its join), so what is honest at START is that the lock was
            // REQUESTED — never a claim that it held.
            //
            // ⚠ `available` IS TRUE, AND IT USED TO BE ABSENT. The SDK's
            // `panoPlusCameraLockLine` reads a missing `available` as "no
            // camera device" and printed "NO CAMERA DEVICE — exposure cannot
            // be locked or measured" across EVERY Android sweep, over a live
            // feed from a device this recorder (or ARCore) had demonstrably
            // opened (A35, 2026-09-03, both arms). A device exists on both
            // arms; what differs is whether this recorder asserts a lock on
            // it, and that is the `requested` bit:
            //
            //   IMU arm  the recorder's own session — AE/AWB lock is asserted
            //            after the metering settle; `locked` is deliberately
            //            NOT written here, because it is not known yet.
            //   AR arm   ARCore's shared session — `Session.resume()` installs
            //            ARCore's repeating request over any lock this
            //            recorder asserts, so none is requested and the
            //            reason says so. The arm banner already names the cost.
            out.putMap(
                "cameraLock",
                WritableNativeMap().apply {
                    putBoolean("available", true)
                    putBoolean("requested", ran != "ar")
                    if (ran == "ar") {
                        putString(
                            "reason",
                            "arcore-owns-session: ARCore installs its own repeating request " +
                                "over the shared camera, so no AE/AWB lock is asserted on " +
                                "this arm",
                        )
                    }
                    putString(
                        "note",
                        if (ran == "ar") {
                            "ARCore owns the shared camera session on this arm; the exposure " +
                                "this sweep ran at is measured per frame and carried in the " +
                                "pack, never locked by this recorder."
                        } else {
                            "AE/AWB lock is asserted after a metering settle poll; whether the " +
                                "camera honoured it is read back at stop() and carried in " +
                                "device.json's applied block, never claimed here."
                        },
                    )
                },
            )
            inner.resolve(out)
        }

        override fun onReject(code: String?, message: String?) {
            // The surface handles six codes BY NAME (`panoPlusErrorInfo`). A
            // recorder code it does not know renders as a generic failure, so
            // the two with an exact equivalent are mapped and everything else
            // keeps the recorder's own code — which is MORE specific than any
            // of the six and is what the operator needs to act on ("unlock the
            // phone", "close the other camera").
            val mapped = when (code) {
                "recorder-busy" -> "panoplus-busy"
                "pack-open-failed" -> "panoplus-io"
                else -> code ?: "panoplus-start-failed"
            }
            inner.reject(mapped, message ?: "pano+ start failed with no message")
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  stop
    // ════════════════════════════════════════════════════════════════════

    /**
     * Finish the sweep and resolve the summary.
     *
     * ⚠ `panoplus-empty` IS A REJECTION WITH EVIDENCE. A sweep that painted
     * nothing rejects with `sessionDir` + `counts` + `abort` in `userInfo`,
     * because the SDK reads them (`panoPlusErrorInfo`) and because a failed
     * sweep whose counters are thrown away is a wasted field trip. The pack
     * stays on disk either way.
     */
    @ReactMethod
    fun stop(promise: Promise) {
        if (!recorder.isRecording() && !PanoPlusLiveNative.running()) {
            promise.reject("panoplus-not-running", "no pano+ sweep is running.")
            return
        }
        recorder.stop(StopShim(promise))
    }

    private inner class StopShim(private val inner: Promise) : MappedPromise() {
        override fun onResolve(value: Any?) {
            val m = value as? ReadableMap
            val summaryJson = optStr(m, "liveSummaryJson", null)
            // ⚠ THE SINGLETON MUST NOT SURVIVE A STOP THAT DID NOT FINALISE.
            // The native session is process-wide, so any exit that leaves it
            // installed makes EVERY later start() reject `panoplus-busy` for
            // the rest of the app's life — no reload, no recovery, force-stop
            // only. The recorder finalises on its own `stop` path; every other
            // way this resolves (an ownerless teardown got there first, the
            // engine never opened, a summary that will not parse) has to
            // release it here.
            if (PanoPlusLiveNative.running()) PanoPlusLiveNative.cancel()
            if (summaryJson.isNullOrEmpty()) {
                // The recorder tore down without a live finalize — an ownerless
                // teardown (module invalidate / Activity destroy) got there
                // first, or the engine never opened. Both are real and neither
                // is a panorama.
                val info = WritableNativeMap()
                copyString(m, info, "packDir")
                // `panoPlusErrorInfo` reads `userInfo.sessionDir` (iOS rejects
                // with the whole summary, which carries it); without it this
                // Android rejection lost the pack's location.
                optStr(m, "packDir", null)?.let { info.putString("sessionDir", it) }
                copyString(m, info, "liveStartError")
                copyString(m, info, "reason")
                inner.reject(
                    "panoplus-empty",
                    "the sweep produced no panorama: the live engine did not finalise. " +
                        (optStr(m, "liveStartError", null)
                            ?: "It was abandoned by a teardown that could not afford the " +
                            "canvas render (see the pack's advisories)."),
                    info,
                )
                return
            }
            val obj = try { JSONObject(summaryJson) } catch (t: Throwable) { null }
            if (obj == null || !obj.optBoolean("ok", false)) {
                val info = WritableNativeMap()
                copyString(m, info, "packDir")
                // `panoPlusErrorInfo` reads `userInfo.sessionDir` (iOS rejects
                // with the whole summary, which carries it); without it this
                // Android rejection lost the pack's location.
                optStr(m, "packDir", null)?.let { info.putString("sessionDir", it) }
                info.putString("summaryJson", summaryJson)
                inner.reject(
                    "panoplus-io",
                    obj?.optString("error")?.takeIf { it.isNotEmpty() }
                        ?: "the live engine's summary could not be read",
                    info,
                )
                return
            }
            val out = jsonToWritableMap(obj)
            // ⚠ THE DROP COUNT COMES FROM THE CAPTURE ARM, NOT THE ENGINE.
            // Backpressure lives in the recorder's single-in-flight gate, so
            // the engine structurally cannot see a frame that never reached it
            // and writes 0. Overwriting that 0 here with the recorder's own
            // `droppedBusy` is the difference between a summary that reports
            // the sweep and one that reports the half of it native could see.
            out.putDouble("droppedQueue", optDbl(m, "droppedBusy", 0.0))
            copyString(m, out, "packDir")
            copyString(m, out, "advisories")
            out.putDouble("framesArrived", optDbl(m, "framesArrived", 0.0))
            if (obj.optBoolean("empty", false)) {
                val info = jsonToWritableMap(obj)
                info.putDouble("droppedQueue", optDbl(m, "droppedBusy", 0.0))
                inner.reject(
                    "panoplus-empty",
                    "the sweep painted nothing. " + emptyHint(obj, m),
                    info,
                )
                return
            }
            inner.resolve(out)
        }

        override fun onReject(code: String?, message: String?) {
            // Same latch, the other exit: a recorder teardown that THREW still
            // has to release the native session, or the next start() refuses
            // for a sweep that no longer exists.
            if (PanoPlusLiveNative.running()) PanoPlusLiveNative.cancel()
            inner.reject(code ?: "panoplus-io", message ?: "pano+ stop failed")
        }
    }

    /**
     * Why an empty sweep was empty, in one sentence the operator can act on.
     *
     * The counters already say it; nobody reads counters in an aisle. The three
     * causes below are the ones this arm actually produces, in the order they
     * are worth checking.
     */
    private fun emptyHint(summary: JSONObject, rec: ReadableMap?): String {
        val counts = summary.optJSONObject("counts")
        val seen = counts?.optLong("seen") ?: 0L
        val warming = counts?.optLong("warmingUp") ?: 0L
        val rejTracking = counts?.optLong("rejectedTracking") ?: 0L
        val ingested = optDbl(rec, "liveIngested", 0.0).toLong()
        return when {
            ingested == 0L ->
                "NOT ONE FRAME reached the engine. The camera opened (the pack has rows) but " +
                    "every ingest was refused — read the pack's device.json live.refused and " +
                    "firstFrameError."
            warming >= seen && seen > 0L ->
                "every frame replayed as WarmingUp: the engine's reference latch needs " +
                    "$TRACKING_WARMUP_FRAMES CONSECUTIVE rows at tracking==2 and never got " +
                    "them. That is an ATTITUDE fault, not an engine one — check " +
                    "attitude.map.refusals in device.json before blaming the sweep."
            rejTracking > 0L ->
                "$rejTracking frames were rejected for tracking. The rotation-vector series " +
                    "was stale or the attitude map refused; device.json's attitude block says " +
                    "which."
            else ->
                "the engine saw $seen frames and committed no strip. Read counts in the pack's " +
                    "meta.json — rejectedLowResponse means the scene had no texture to " +
                    "register on, rejectedOutOfCage means the phone moved faster than the " +
                    "aliasing cage allows."
        }
    }

    // ════════════════════════════════════════════════════════════════════
    //  cancel
    // ════════════════════════════════════════════════════════════════════

    /**
     * Abandon the sweep. ALWAYS resolves.
     *
     * A cancel that could reject would leave the native session latched and
     * every later `start()` refusing `panoplus-busy` for the rest of the app's
     * life — which is exactly what the SDK's own comment on `cancelPanoPlus`
     * says (panoPlusNative.ts:155-160).
     *
     * ⚠ THE PACK IS KEPT, unlike iOS. There the only caller is an operator
     * abandoning a sweep; here the same call is reached by an unmount and by
     * the surface's own error paths, and a deleted pack is deleted evidence.
     */
    @ReactMethod
    fun cancel(promise: Promise) {
        recorder.stop(object : MappedPromise() {
            override fun onResolve(value: Any?) = settle(false)
            // A recorder teardown that FAILED still has to release the engine,
            // or the native singleton stays latched and every later start()
            // refuses `panoplus-busy` for the rest of the process's life.
            override fun onReject(code: String?, message: String?) = settle(true)

            private fun settle(teardownFailed: Boolean) {
                PanoPlusLiveNative.cancel()
                promise.resolve(
                    WritableNativeMap().apply {
                        putBoolean("cancelled", true)
                        if (teardownFailed) putBoolean("teardownFailed", true)
                    },
                )
            }
        })
    }

    // ════════════════════════════════════════════════════════════════════
    //  getStatus
    // ════════════════════════════════════════════════════════════════════

    /**
     * The live status.
     *
     * ⚠ THIS IS THE ONLY STATUS CHANNEL ON ANDROID. iOS has two — a per-frame
     * synchronous push riding the AR plugin's return, and this poll. There is
     * no AR plugin here, so everything the operator sees while sweeping comes
     * through this call, and `running` is the one field the SDK's coercion
     * treats as mandatory (its absence drops the whole tick).
     *
     * Cheap by construction: the native side keeps a cached snapshot string
     * built at the end of each ingest, so this is a copy and a JSON parse, not
     * an engine query. It runs on RN's NativeModules queue thread and must
     * stay that way.
     */
    @ReactMethod
    fun getStatus(promise: Promise) {
        val json = PanoPlusLiveNative.statusJson()
        val obj = try { JSONObject(json) } catch (_: Throwable) { null }
        if (obj == null) {
            promise.resolve(WritableNativeMap().apply {
                putBoolean("running", false)
                // M8 — read through the FINISH: JS unmounts the camera on it.
                putBoolean("cameraReleased", PanoPlusCameraRelease.released)
            })
            return
        }
        val out = jsonToWritableMap(obj)
        out.putBoolean("cameraReleased", PanoPlusCameraRelease.released)
        // The capture arm's own numbers, which the engine structurally cannot
        // see: it is never told about a frame that the backpressure gate
        // dropped before it, and `droppedQueue` written by the party that
        // cannot see the drops would be a lie the shape of a measurement.
        val rec = recorder.statusSnapshot()
        if (rec != null) {
            out.putDouble("droppedQueue", optDbl(rec, "droppedBusy", 0.0))
            out.putDouble("framesArrived", optDbl(rec, "framesArrived", 0.0))
            out.putDouble("framesWritten", optDbl(rec, "framesWritten", 0.0))
            // NOT `tracking`: that key is a 0/1/2 STATE and the native status
            // already carries the last frame's. This is the RUN LENGTH the
            // engine's reference latch needs, which is a different fact and
            // gets a different name.
            out.putDouble("trackingNormalRows", optDbl(rec, "trackingNormalRows", 0.0))
            out.putDouble(
                "maxConsecutiveNormalTracking",
                optDbl(rec, "maxConsecutiveNormalTracking", 0.0),
            )
            copyString(rec, out, "firstFrameError")
            copyString(rec, out, "liveStartError")
            // ── THE POSE ARM, LIVE ──────────────────────────────────────
            // The engine's status cannot see any of this: on the AR arm the
            // reason a canvas stops growing may be that frames are arriving
            // with no ARCore pose to bracket them, which from the engine's side
            // is indistinguishable from a still phone. `poseWaitTimedOut`
            // climbing while `poseSolved` does not is that state, named.
            // The AR arm's reason for not painting, so the panel can say it
            // instead of guessing. See the recorder's own note.
            copyString(rec, out, "arTrackingFailure")
            copyString(rec, out, "poseSourceRan")
            copyString(rec, out, "vcDeviceRefusal")
            out.putDouble("poseSolved", optDbl(rec, "poseSolved", 0.0))
            out.putDouble("poseWaited", optDbl(rec, "poseWaited", 0.0))
            out.putDouble("poseWaitTimedOut", optDbl(rec, "poseWaitTimedOut", 0.0))
            out.putDouble("poseNotTracking", optDbl(rec, "poseNotTracking", 0.0))
            out.putBoolean("previewAttached", optBool(rec, "previewAttached", false))
            // `running` from the RECORDER when native says false: the camera
            // being up with an engine that refused is a real state, and a
            // status that reported `running:false` there would make the surface
            // tear down a sweep still holding the camera.
            val engineRunning = out.hasKey("running") && out.getBoolean("running")
            if (!engineRunning && optBool(rec, "running", false)) {
                out.putBoolean("running", true)
                out.putBoolean("engineDown", true)
            }
        }
        promise.resolve(out)
    }

    // ════════════════════════════════════════════════════════════════════
    //  setIdlePreview
    // ════════════════════════════════════════════════════════════════════

    /**
     * iOS's pre-sweep viewfinder — now Android's too.
     *
     * ⚠ WHAT THIS USED TO BE, AND WHY IT IS NOT THAT ANY MORE. Until
     * 2026-09-02 this resolved `{on:false}` with a truthful explanation: the
     * Android preview was an OUTPUT of the recorder's capture session, so the
     * feed existed only while a sweep ran. The explanation was accurate and
     * the behaviour was wrong — the operator could not FRAME the shot, and on
     * a slit-scan arm the first frame anchors the whole canvas, so framing it
     * blind is guessing. "Answering honestly" is not a substitute for
     * answering.
     *
     * `PanoPlusIdlePreviewSession` is now the second, SHORTER camera
     * lifecycle: a device, a surface and a repeating request, and nothing
     * else. The contention this method's old comment worried about is real and
     * is handled where it has to be — in `PanoPlusAndroidRecorder`, which owns
     * both and tears this one down (waiting for `onClosed`) before a sweep
     * opens anything.
     *
     * ⚠ NOTHING BLOCKS THIS THREAD. Both branches hand off to the recorder,
     * which dispatches onto `Dispatchers.IO` before it opens or waits for
     * anything: an `@ReactMethod` runs on RN's ONE NativeModules queue and a
     * block there wedges every native module in the app.
     *
     * Resolves `{on, reason}` on EVERY path, never rejects — the SDK
     * (`setPanoPlusIdlePreview`) reads only `on`, and treats every `false` the
     * same way: no feed, keep the explainer. `reason` is for logcat and for
     * the next person reading a black screen.
     */
    @ReactMethod
    fun setIdlePreview(on: Boolean, options: ReadableMap?, promise: Promise) {
        val settled = java.util.concurrent.atomic.AtomicBoolean(false)
        fun answer(live: Boolean, why: String, fps: IdleFpsReport? = null) {
            // A Promise settled twice is a red screen in dev and a silent drop
            // in release. The recorder guarantees one call; this guarantees it
            // again, because the two error paths below can also answer.
            if (!settled.compareAndSet(false, true)) return
            promise.resolve(
                WritableNativeMap().apply {
                    putBoolean("on", live)
                    putString("reason", why)
                    // ⚠ THE PANEL HAS TO BE ABLE TO SAY "THIS DOES NOT MATCH".
                    // iOS returns `previewFormatApplied` for exactly this: a
                    // viewfinder that is UP but is not showing the sweep's own
                    // configuration is worse than no viewfinder, because it
                    // looks right. These three are the Android half — a flag
                    // the panel can branch on, the range that was asked for,
                    // and the sentence to print. Present on every path,
                    // including the ones that never reached a camera (the flag
                    // is then false and the note says why).
                    putBoolean("previewFpsApplied", fps?.applied ?: false)
                    val req = fps?.requested
                    if (req == null) putNull("previewFpsRange") else putString("previewFpsRange", req)
                    putString(
                        "previewFpsNote",
                        fps?.note
                            ?: "the idle viewfinder never reached a camera, so no frame rate " +
                                "was requested",
                    )
                },
            )
        }
        try {
            if (!on) {
                // The stop is dispatched, not awaited: this thread must not
                // wait on a camera. The recorder's own `start()` does the
                // waiting, on IO, and that is the ordering that matters.
                recorder.stopIdlePreviewAsync("setIdlePreview(false)")
                answer(false, "the idle viewfinder was asked to stop")
                return
            }
            // `lens` arrives from the SDK (`setPanoPlusIdlePreview(true,
            // {lens, poseSource})`) and IS HONOURED here since 2026-09-03,
            // for the one reason it was refused before: the framing shown
            // must be the framing the sweep records. Until today the SWEEP
            // did not read `lens` (`start()` above never copied it), so
            // honouring it at idle would have invented a framing; now
            // `start()` copies it and the recorder runs the identical rule
            // (`pickCameraForLens`), so the two agree by construction. An
            // explicit `cameraId` still outranks it, in both places.
            val cameraId = optStr(options, "cameraId", null)
            val lens = optStr(options, "lens", null)
            val maxWidth = optDbl(options, "maxWidth", 0.0).toInt()
            // ⚠ `poseSource` OUTRANKS `lens`. It decides WHO OPENS THE
            // CAMERA: on `'ar'` the sweep's session is ARCore's, and ARCore's
            // CameraConfig overrides every lens rule this preview otherwise
            // copies — the idle session then follows ARCore's camera and says
            // the lens request is ignored, exactly as the sweep will. Ignoring
            // the arm is what made the idle viewfinder frame at 96.2° for a
            // pack recorded at 69.7° (A35, 2026-09-03).
            val arArm = (optStr(options, "poseSource", "imu") ?: "imu")
                .lowercase() == "ar"
            // ⚠ THE RATE PIN IS A KNOB AND IT DEFAULTS OFF (2026-09-07). Until
            // today this preview set no CONTROL_AE_TARGET_FPS_RANGE at all
            // while the sweep pins one, so the operator framed through a
            // HAL-default — usually VARIABLE — rate: it dims and stutters in a
            // dim aisle where the sweep will not. `pinPreviewFps:true` makes
            // the viewfinder request the same range, by the same selector.
            // Absent (the default) the request built is byte-identical to the
            // one that shipped; only `previewFpsNote` changes, and it says so.
            // The default is the OPERATOR'S to flip, after he has seen both
            // pictures — a pinned 60 buys steadiness with SHORTER exposures,
            // so the idle preview goes darker in the same aisle.
            val pinFps = optBool(options, "pinPreviewFps", false)
            recorder.startIdlePreview(cameraId, maxWidth, arArm, lens, pinFps) { live, why, fps ->
                answer(live, why, fps)
            }
        } catch (t: Throwable) {
            answer(
                false,
                "the idle viewfinder could not be started (${t.javaClass.simpleName}: " +
                    "${t.message}). START still works — the sweep opens the camera itself.",
            )
        }
    }


    // ════════════════════════════════════════════════════════════════════
    //  Helpers
    // ════════════════════════════════════════════════════════════════════

    private fun stripFileScheme(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

    private fun copyString(src: ReadableMap?, dst: WritableMap, key: String) {
        val v = optStr(src, key, null)
        if (v != null) dst.putString(key, v)
    }

    /**
     * `org.json` → RN bridge, recursively.
     *
     * Hand-rolled because RN's own converter is not public API. The platform
     * parser rather than a hand-written one: this reads a string the C++ side
     * WROTE, and a bespoke reader that mis-parses a nested object would report
     * a plausible status instead of an error — the failure mode the pano+ port
     * has spent the most time on.
     *
     * ⚠ NaN / Infinity CANNOT APPEAR HERE — every native writer emits `null`
     * for a non-finite double (`jnum` in rnis_pano_live.cpp), because
     * `JSON.parse` throws on a bare `nan` three layers from whoever wrote it.
     * `JSONObject.NULL` is therefore the only null this ever sees.
     */
    private fun jsonToWritableMap(obj: JSONObject): WritableNativeMap {
        val out = WritableNativeMap()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            when (val v = obj.opt(k)) {
                null, JSONObject.NULL -> out.putNull(k)
                is JSONObject -> out.putMap(k, jsonToWritableMap(v))
                is JSONArray -> out.putArray(k, jsonToWritableArray(v))
                is Boolean -> out.putBoolean(k, v)
                is Int -> out.putDouble(k, v.toDouble())
                is Long -> out.putDouble(k, v.toDouble())
                is Double -> out.putDouble(k, v)
                else -> out.putString(k, v.toString())
            }
        }
        return out
    }

    private fun jsonToWritableArray(arr: JSONArray): WritableNativeArray {
        val out = WritableNativeArray()
        for (i in 0 until arr.length()) {
            when (val v = arr.opt(i)) {
                null, JSONObject.NULL -> out.pushNull()
                is JSONObject -> out.pushMap(jsonToWritableMap(v))
                is JSONArray -> out.pushArray(jsonToWritableArray(v))
                is Boolean -> out.pushBoolean(v)
                is Int -> out.pushDouble(v.toDouble())
                is Long -> out.pushDouble(v.toDouble())
                is Double -> out.pushDouble(v)
                else -> out.pushString(v.toString())
            }
        }
        return out
    }
}
