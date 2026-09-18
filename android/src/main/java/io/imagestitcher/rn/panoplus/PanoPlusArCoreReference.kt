// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusArCoreReference.kt — the OPTIONAL ARCore REFERENCE CHANNEL for a
// pano+ Android recording session.
//
// ── The question this exists to answer, and why one sweep is the design ─────
//
// Two things about the Android arm are unproven:
//
//   1. WHICH POSE ARM IS BETTER — ARCore's visual-inertial `world←camera`, or
//      the decoupled `TYPE_ROTATION_VECTOR` the recorder already logs.
//   2. WHETHER THE DERIVED BASIS IS RIGHT.  `rnis_pano_android_basis` derives
//      `C` (index 8 on the A35) from SENSOR_ORIENTATION + lens facing.
//      `LENS_POSE_ROTATION` is not published on that device, so NOTHING on the
//      phone can currently contradict that derivation.
//
// The naive design for (1) is two sweeps, one per arm.  That is CONFOUNDED:
// the defect under study — band shear, wobble — is a function of how the hand
// moved, and the hand moves differently every time.  So BOTH attitude sources
// are recorded during ONE sweep and the SAME PIXELS are replayed twice
// offline, once per source.  Same frames, same timestamps, same motion; the
// only variable is the attitude channel.
//
// (2) falls out of the same recording for free: `selectBasis()` searches all
// 24 candidates against a reference `world←camera` series, which is exactly
// what ARCore supplies.  See cpp/rnis_pano_android_s1.* for that arithmetic.
//
// ── ARCore NORMALLY OWNS THE CAMERA.  Three ways that can go. ───────────────
//
// Two full Camera2 clients cannot coexist, so an "ARCore alongside the
// recorder" channel is only possible in one of these shapes, and WHICH ONE RAN
// IS RECORDED IN THE PACK so nobody later reads the weaker one as the stronger:
//
//   SHARED     — ARCore's shared-camera mode.  The APP owns the CameraDevice
//                and the CameraCaptureSession; ARCore adds its surfaces to
//                them.  The recorder keeps its own ImageReader, so the pixels
//                and the ARCore pose come from the SAME capture.  This is the
//                controlled A/B.
//
//                ⚠ IT IS NOT FREE, AND EVERY COST IS RECORDED.  ARCore picks
//                the camera id and the CPU image size from its own
//                `CameraConfig` list — the recorder's widest-FOV choice and its
//                1920-wide raster are both OVERRIDDEN — and once
//                `Session.resume()` runs, ARCore installs its own repeating
//                request, so the recorder's AE/AWB/AF locks are ARCore's to
//                keep or drop.  Whether they survived is not asserted here: it
//                is VISIBLE in `device.json`'s exposure/ISO trace, which is
//                flat exactly when the lock reached the pixels.
//
//   STANDALONE — ARCore owns the camera outright and the recorder does not
//                open one.  There are NO PIXELS OF OURS, so this is NOT the
//                same-pixels A/B and the pack says so in as many words.  It is
//                still a complete answer to (2): the rotation-vector series and
//                the ARCore series are simultaneous, which is all
//                `selectBasis()` needs.
//
//   (unavailable) — ARCore not on the classpath, not installed, or the device
//                is not supported.  Then nothing is recorded and the pack says
//                which of those it was.  A pack must never claim a provenance
//                it does not have.
//
// ── ARCore NEEDS A GL CONTEXT, and this file has no view ────────────────────
//
// `Session.update()` is written for a renderer: it wants a texture to hand the
// camera image to, and it throws without a current EGL context.  A recorder has
// no `GLSurfaceView`, so one is made — a 1×1 pbuffer with an
// `GL_TEXTURE_EXTERNAL_OES` name — on the pump thread, and `update()` is called
// only from there.  That is the whole of the graphics in this file; nothing is
// ever drawn or read back.
//
// ── EVERY ARCore TYPE IN THIS FILE IS `compileOnly` ─────────────────────────
//
// The ARCore runtime in the APK belongs to the HOST (react-native-image-stitcher
// pulls in `com.google.ar:core`).  This module compiles against it and packages
// none of it, which means a host without ARCore compiles fine and would fail at
// CLASS LOAD.  So: nothing outside `ArCoreReferenceChannel` names an ARCore
// type, the recorder holds only the ARCore-free `ArCoreChannel` interface, and
// the single `new` is inside a `Throwable` catch guarded by a reflective
// `Class.forName` probe.  A missing runtime is then a reported reason, not a
// crash.

package io.imagestitcher.rn.panoplus

import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraDevice
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.os.Handler
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.Surface
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Frame
import com.google.ar.core.Session
import com.google.ar.core.SharedCamera
import com.google.ar.core.TrackingState
import java.util.EnumSet
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

private const val ARTAG = "RNISPanoArCore"

/** `GL_TEXTURE_EXTERNAL_OES` — the target ARCore binds the camera image to.
 *  Not in `GLES20`, and pulling in the GLES11Ext class for one constant would
 *  add a dependency to a file that draws nothing. */
private const val GL_TEXTURE_EXTERNAL_OES = 0x8D65

// ════════════════════════════════════════════════════════════════════════
//  Mode
// ════════════════════════════════════════════════════════════════════════

/**
 * What the operator ASKED for.  What actually RAN is `ArCoreChannel.modeRan`,
 * and the two are reported separately on purpose: a silent downgrade from
 * SHARED to STANDALONE would turn a same-pixels A/B into a different
 * experiment under the same name.
 */
internal enum class ArCoreRefMode { OFF, SHARED, STANDALONE, AUTO }

internal fun parseArCoreRefMode(s: String?): ArCoreRefMode = when (s?.lowercase()) {
    null, "", "off", "false", "none" -> ArCoreRefMode.OFF
    "shared" -> ArCoreRefMode.SHARED
    "standalone", "separate" -> ArCoreRefMode.STANDALONE
    "auto", "true" -> ArCoreRefMode.AUTO
    // An unrecognised value is OFF, not AUTO. A typo must not silently start a
    // second camera client on a field build.
    else -> ArCoreRefMode.OFF
}

// ════════════════════════════════════════════════════════════════════════
//  Availability — reflective, and SHARED WITH THE PROBE
// ════════════════════════════════════════════════════════════════════════

/**
 * What `ArCoreApk.checkAvailability()` said, plus whether the classes are on
 * the classpath at all.
 *
 * ⚠ `status` is the raw enum NAME (`SUPPORTED_INSTALLED`,
 * `UNSUPPORTED_DEVICE_NOT_CAPABLE`, `UNKNOWN_CHECKING`, …) and is never
 * translated into a boolean anywhere but `supported`. The four "unsupported"
 * reasons send an operator to four different actions.
 */
internal class ArCoreAvailability(
    val linked: Boolean,
    val status: String,
    val supported: Boolean,
    val detail: String,
)

/**
 * Is `com.google.ar.core.ArCoreApk` on the classpath at all?
 *
 * Separate from [readArCoreAvailability] because it needs NO Context, which is
 * what makes it — and the not-linked verdict below — reachable from the JVM
 * unit suite. On that suite the answer is genuinely false, which is the exact
 * runtime shape of a host app that does not depend on ARCore.
 */
internal fun arCoreApkClassOrNull(): Class<*>? = try {
    Class.forName("com.google.ar.core.ArCoreApk")
} catch (_: Throwable) {
    null
}

/** The verdict when the SDK is not in this build at all. */
internal fun arCoreNotLinked(): ArCoreAvailability = ArCoreAvailability(
    linked = false,
    status = "not-linked",
    supported = false,
    // Names WHERE the runtime is supposed to come from. "ARCore is missing"
    // alone sends a reader hunting in the wrong build file.
    //
    // ⚠ THIS TEXT CHANGED WITH THE PACKAGE. In the private overlay this
    // module came from, ARCore was `compileOnly` and the runtime arrived from
    // the host. Here it is an `implementation` dependency of this package, so
    // reaching this verdict means something REMOVED it — an `exclude` rule, a
    // stripped build, or a resolution conflict — not a host that never had it.
    detail = "com.google.ar.core.ArCoreApk is not on the classpath. " +
        "This package declares ARCore as an implementation dependency, so it " +
        "should be here: check for an exclude rule or a dependency conflict " +
        "in the host app. No ARCore reference channel is possible in this " +
        "build.",
)

/**
 * Read ARCore's availability WITHOUT touching an ARCore type.
 *
 * Reflective on purpose, and this is the one place in the module that must
 * stay so: it is the guard that decides whether it is safe to load
 * `ArCoreReferenceChannel` at all, and a guard written in the types it is
 * guarding cannot run when they are absent.
 *
 * `checkAvailability` can answer `UNKNOWN_CHECKING`, which means an
 * asynchronous query is still in flight. That is reported verbatim rather than
 * being polled here — a probe that blocks is a probe that hangs a panel — and
 * the caller's advice is to press again.
 */
internal fun readArCoreAvailability(ctx: Context): ArCoreAvailability {
    val cls = arCoreApkClassOrNull()
    if (cls == null) return arCoreNotLinked()
    return try {
        val instance = cls.getMethod("getInstance").invoke(null)
        val avail = cls.getMethod("checkAvailability", Context::class.java)
            .invoke(instance, ctx)
        val name = (avail as? Enum<*>)?.name ?: avail?.toString() ?: "unknown"
        ArCoreAvailability(
            linked = true,
            status = name,
            supported = name == "SUPPORTED_INSTALLED",
            detail = when (name) {
                "SUPPORTED_INSTALLED" ->
                    "Google Play Services for AR is installed and this device is supported."
                "UNKNOWN_CHECKING" ->
                    "checkAvailability started an ASYNCHRONOUS query that has not finished. " +
                        "This is not a refusal — ask again in a moment."
                "SUPPORTED_NOT_INSTALLED", "SUPPORTED_APK_TOO_OLD" ->
                    "The device is supported but Google Play Services for AR is missing or " +
                        "too old. This module deliberately does NOT trigger an install " +
                        "(that needs an Activity, and a recorder has none) — install or " +
                        "update it from Play, then re-run."
                "UNSUPPORTED_DEVICE_NOT_CAPABLE" ->
                    "ARCore does not support this device. There is no ARCore reference " +
                        "channel here and no amount of configuration will produce one."
                else -> "ArCoreApk.checkAvailability() answered $name."
            },
        )
    } catch (t: Throwable) {
        ArCoreAvailability(
            linked = true,
            status = "check-threw",
            supported = false,
            detail = "ArCoreApk.checkAvailability threw ${t.javaClass.simpleName}: ${t.message}",
        )
    }
}

// ════════════════════════════════════════════════════════════════════════
//  The recorder's side of the seam — NO ARCore TYPES BELOW THIS LINE
// ════════════════════════════════════════════════════════════════════════

/** How an ARCore pose row relates to a frame the recorder wrote. */
internal class ArCoreMatch(val kind: String, val seq: Long, val deltaNs: Long)

/**
 * The recorder's index of WRITTEN frames, by `SENSOR_TIMESTAMP`.
 *
 * Only frames that reached disk are in it: a frame dropped for encoder
 * backpressure has no `seq`, and reporting a pose as belonging to it would
 * name a file that does not exist.
 */
internal interface ArCoreFrameIndex {
    fun match(tsNs: Long): ArCoreMatch
}

/**
 * Everything the recorder needs from the channel, expressed WITHOUT an ARCore
 * type — see the file header for why that boundary is load-bearing.
 *
 * Every method is safe to call in any mode; the ones that only mean something
 * in SHARED are no-ops otherwise (identity wrappers, empty surface lists).
 */
/**
 * A LIVE consumer of ARCore's per-frame rotation — the AR POSE ARM (2026-09-02).
 *
 * ── WHY THIS IS NOT JUST THE JSONL WRITER ──────────────────────────────────
 *
 * Until today every ARCore pose this file produced went to `attitude_arcore.
 * jsonl` and was read minutes later by an offline replay. The engine was fed
 * from `TYPE_ROTATION_VECTOR` through the derived basis `C`, on every sweep,
 * whatever the operator selected — the AR pill on Android changed nothing and
 * native answered `imu` to every request. The operator learned that on
 * 2026-09-02, having asked for "the same capture done both via imu and ar and
 * see the comparison", which is possible on iPhone and was not possible here.
 *
 * This is the second consumer that makes it possible: the same `emit()`, the
 * same frame, handed synchronously to the recorder's live ring so the sweep can
 * PAINT from it.
 *
 * ⚠ NO BASIS IS APPLIED TO WHAT COMES OUT OF HERE, AND THAT IS THE POINT.
 * `Camera.getPose()` is `world←camera` with the camera's own axes (+X right,
 * +Y up, −Z forward) — the SAME convention ARKit's `camera.transform` uses and
 * the engine was written against. That is not an assumption: `selectBasis()`
 * (rnis_pano_attitude.hpp) searches for the `C` that makes the ROTATION-VECTOR
 * series match THIS series, so this series is by construction the target the
 * IMU arm is trying to reach. The IMU arm needs `C` because CoreMotion/Android
 * sensor attitude is in a device frame; ARCore does not, because it is already
 * in the camera frame.
 *
 * ⚠ CALLED ON THE PUMP THREAD, INSIDE `emit()`. The implementation must not
 * block: `Config.UpdateMode.BLOCKING` means the next `update()` is already
 * waiting on the next camera frame, and time spent here is pose latency added
 * to every frame. The recorder's sink is a `@Synchronized` ring insert and a
 * `notifyAll`, which is the whole of what it may cost.
 */
internal fun interface ArCorePoseSink {
    /**
     * @param tsNs ARCore's `Frame.getTimestamp()` — the Camera2
     *   `SENSOR_TIMESTAMP` TIMEBASE, but NOT bit-identical to any one frame's
     *   value (0 of 738 matched exactly on SM-A356U1; median nearest gap
     *   0.9 ms). The consumer must bracket, never look up.
     * @param tracking `trackingState == TRACKING`. A pose from a PAUSED
     *   session is ARCore's last known one, not a measurement of now.
     */
    fun onPose(
        tsNs: Long,
        x: Double,
        y: Double,
        z: Double,
        w: Double,
        tracking: Boolean,
    )
}

internal interface ArCoreChannel {
    /** `"shared"` | `"standalone"`. What actually ran, never what was asked. */
    val modeRan: String

    /**
     * ARCore's reason for NOT tracking, live and current. Empty while tracking.
     *
     * ⚠ ON THE INTERFACE, not just the implementation, because the recorder
     * holds the interface and the whole point is that this reaches the SCREEN.
     * Until 2026-09-10 the panel could only say "Waiting for AR tracking" and
     * advise the operator to hold steady — advice that is actively wrong when
     * the answer is INSUFFICIENT_LIGHT, which ARCore reported on 126 of 186
     * poses in his last attempt while he re-tried in a dark room. The reason
     * was written to the pack all along and reached him never.
     */
    val latestTrackingFailure: String

    /** ARCore chose the camera; the recorder's own selection was overridden.
     *  Null in STANDALONE (the recorder opens nothing) and when unknown. */
    fun forcedCameraId(): String?

    /** ARCore's CPU image size — the ONLY size the app's ImageReader may be in
     *  shared mode. Null when not applicable. */
    fun forcedImageSize(): Size?

    fun wrapDeviceStateCallback(
        cb: CameraDevice.StateCallback,
        h: Handler,
    ): CameraDevice.StateCallback

    fun wrapSessionStateCallback(
        cb: CameraCaptureSession.StateCallback,
        h: Handler,
    ): CameraCaptureSession.StateCallback

    /** ARCore's own output surfaces, which MUST be in the capture session. */
    fun arCoreSurfaces(): List<Surface>

    /** Register the app's surfaces so ARCore keeps them in the repeating
     *  request it installs on resume. Must be called BEFORE `openCamera`. */
    fun setAppSurfaces(cameraId: String, surfaces: List<Surface>)

    /**
     * The capture session is configured; ARCore may resume.
     *
     * `captureCallback` is re-registered through `SharedCamera` because
     * `Session.resume()` replaces the repeating request — and with it the
     * app's `CaptureCallback`. Losing that callback loses `SENSOR_TIMESTAMP`,
     * which is the only timestamp `track.jsonl` is allowed to carry.
     */
    fun onSessionConfigured(captureCallback: CameraCaptureSession.CaptureCallback, h: Handler)

    /** Begin (or, in SHARED, arm) the pose pump. `writer` is called with one
     *  finished JSONL row and must be safe from an arbitrary thread. */
    fun startPump(writer: (String) -> Unit, index: ArCoreFrameIndex?)

    /**
     * Idempotent. Safe from any thread, including a teardown racing the pump.
     *
     * ⚠ MUST BE CALLED BEFORE THE CAPTURE SESSION IS CLOSED, and the pump join
     * MUST share the caller's teardown budget. `Config.UpdateMode.BLOCKING`
     * means `update()` waits for the next camera frame; once the recorder has
     * closed the session there is no next frame, so the pump sits there for
     * the whole of `joinMs`. A fixed budget here would be additive with the
     * recorder's four thread joins — and on `onHostDestroy`, which is
     * `@ThreadConfined(UI)` with ONE second for everything, that is an ANR.
     *
     * `joinMs <= 0` means do not block at all.
     */
    fun stop(joinMs: Long)

    /** Everything measured, as a JSON object for `device.json`. */
    fun statusJson(): String

    /** Advisories raised by the channel, for the recorder's own list. */
    fun advisories(): List<String>

    /** Rows written so far — polled live by the panel. */
    fun rowsWritten(): Long

    /** Frames whose `trackingState` was TRACKING. The number that decides
     *  whether the reference series is usable at all. */
    fun trackingRows(): Long

    /**
     * Install (or clear) the LIVE pose consumer — see {@link ArCorePoseSink}.
     *
     * Separate from `startPump`'s `writer` because the two have different
     * lifetimes and different failure meanings: the writer is the pack's
     * sidecar and is set once at open, while the sink is the live arm and must
     * be clearable at teardown so a pump frame that races the recorder's
     * shutdown cannot insert into a ring that is being reported on.
     */
    fun setPoseSink(sink: ArCorePoseSink?)
}

/**
 * Build a channel, or say why not.
 *
 * ⚠ THE ONLY PLACE `ArCoreReferenceChannel` IS NAMED. The `Throwable` catch is
 * not defensive programming: on a host whose APK carries no ARCore runtime the
 * `new` below raises `NoClassDefFoundError`, which is an `Error` and not an
 * `Exception`, and letting it out of a recorder start would kill the app
 * instead of reporting a missing dependency.
 */
internal fun openArCoreChannel(
    ctx: Context,
    requested: ArCoreRefMode,
    availability: ArCoreAvailability,
    focusMode: String,
    onAdvise: (String) -> Unit,
): Pair<ArCoreChannel?, String> {
    val plan = planArCoreChannel(requested, availability)
    if (!plan.proceed) return null to plan.reason
    val shared = plan.shared
    return try {
        val ch = ArCoreReferenceChannel(ctx, shared, focusMode, onAdvise)
        val err = ch.open()
        if (err == null) {
            ch to "ok"
        } else if (shared && requested == ArCoreRefMode.AUTO) {
            // A NAMED downgrade, never a silent one: STANDALONE answers the
            // basis question but is NOT the same-pixels A/B, and a pack that
            // let the two share a label would be unreadable a week later.
            ch.close()
            onAdvise(
                "ARCore SHARED-CAMERA mode could not start ($err) — falling back to " +
                    "STANDALONE, which records an ARCore pose series beside the rotation " +
                    "vector but NO PIXELS OF OURS. That still falsifies the derived basis; " +
                    "it is NOT the same-pixels pose-arm A/B.",
            )
            val alt = ArCoreReferenceChannel(ctx, false, focusMode, onAdvise)
            val err2 = alt.open()
            if (err2 == null) alt to "ok (downgraded from shared)"
            else { alt.close(); null to "unavailable: shared failed ($err); standalone failed ($err2)" }
        } else {
            ch.close()
            null to "unavailable: $err"
        }
    } catch (t: Throwable) {
        null to "unavailable: the ARCore runtime is not loadable in this build " +
            "(${t.javaClass.simpleName}: ${t.message}). ARCore is compileOnly here; the " +
            "APK's copy comes from the host app."
    }
}

/** Whether a channel may be attempted at all, and — when not — WHY. */
internal class ArCoreChannelPlan(
    val proceed: Boolean,
    val shared: Boolean,
    val reason: String,
)

/**
 * The gate, extracted so it is PURE and therefore host-testable.
 *
 * ⚠ "not requested" AND "requested and refused" ARE DIFFERENT PACK
 * PROVENANCES, and collapsing them is the defect this shape prevents: a pack
 * whose reason reads `unavailable: …` was an experiment that failed, and one
 * whose reason reads `off (…)` was never an experiment. A single boolean would
 * have made a build that silently cannot do ARCore indistinguishable from a
 * sweep nobody asked to.
 */
internal fun planArCoreChannel(
    requested: ArCoreRefMode,
    availability: ArCoreAvailability,
): ArCoreChannelPlan {
    if (requested == ArCoreRefMode.OFF) {
        return ArCoreChannelPlan(false, false, "off (arcoreReference was not requested)")
    }
    if (!availability.linked) {
        return ArCoreChannelPlan(false, false, "unavailable: ${availability.detail}")
    }
    // `linked` says the SDK is on the classpath; only `supported` says Play
    // Services for AR will serve THIS device. Collapsing the two would
    // construct a Session that throws UnavailableDeviceNotCapableException on
    // the recorder's critical path.
    if (!availability.supported) {
        return ArCoreChannelPlan(
            false, false,
            "unavailable: availability=${availability.status} — ${availability.detail}",
        )
    }
    return ArCoreChannelPlan(true, requested != ArCoreRefMode.STANDALONE, "ok")
}

// ════════════════════════════════════════════════════════════════════════
//  The implementation — ARCore types live ONLY below here
// ════════════════════════════════════════════════════════════════════════

private class ArCoreReferenceChannel(
    private val ctx: Context,
    private val wantShared: Boolean,
    private val focusModeOpt: String,
    private val onAdvise: (String) -> Unit,
) : ArCoreChannel {

    override val modeRan: String get() = if (wantShared) "shared" else "standalone"

    private var session: Session? = null
    private var sharedCamera: SharedCamera? = null

    // ── ⚠ THE CameraConfig IS SNAPSHOTTED, NOT HELD ─────────────────────
    // `CameraConfig` is a handle onto native ARCore state. After
    // `Session.close()` its accessors go quiet: measured on SM-A356U1,
    // `getCameraId()` returned null and `getImageSize()` returned 0x0 — and
    // `statusJson()` runs at SHUTDOWN, so the pack recorded
    // `cameraIdChosenByArCore: null, cpuImageSize: "0x0"` for a sweep that had
    // demonstrably run on camera 0 at 1920x1080. That is the pack losing the
    // single confound it exists to record. Copied into plain fields here, at
    // open(), while the session is alive.
    private var cfgCameraId: String? = null
    private var cfgCpuSize: Size? = null
    private var cfgGpuSize: String? = null
    private var cfgFpsRange: String? = null

    private val running = AtomicBoolean(false)
    private val configured = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)
    private var pumpThread: Thread? = null

    private val rows = AtomicLong(0)
    private val tracking = AtomicLong(0)
    private val updateFailures = AtomicLong(0)
    private val zeroTimestampFrames = AtomicLong(0)
    private val firstTsNs = AtomicLong(0)
    private val lastTsNs = AtomicLong(0)
    /** ARCore's reason for NOT tracking, live. Empty while tracking. */
    @Volatile override var latestTrackingFailure: String = ""
        private set

    private val trackingStateHist = HashMap<String, Long>()
    private val failureReasonHist = HashMap<String, Long>()
    private val firstError = AtomicReference<String?>(null)

    // ⚠ @Volatile, not tidiness: every one of these is written on the PUMP
    // thread and read by `statusJson()` on the coroutine that writes
    // device.json — including the "recording-started" snapshot, which fires
    // moments after the pump starts. Without it that snapshot can carry
    // `egl: "not-created"` for a context that had already been made, and the
    // first thing anyone reads about a failed channel would be a stale value.
    @Volatile private var focusApplied = "not-attempted"
    @Volatile private var resumeError: String? = null
    @Volatile private var glError: String? = null
    @Volatile private var eglSummary = "not-created"
    private val configsSeen = ArrayList<String>()
    @Volatile private var intrinsicsJson = "null"
    @Volatile private var resumedAtElapsedNs = 0L

    private var writer: ((String) -> Unit)? = null
    private var frameIndex: ArCoreFrameIndex? = null

    /** The LIVE arm's consumer. @Volatile because it is installed from the
     *  recorder's start coroutine and cleared from its teardown, and read on
     *  the pump thread on every frame. */
    @Volatile private var poseSink: ArCorePoseSink? = null
    /** Poses handed to the sink, and poses the sink refused to be handed
     *  because they were not TRACKING. Both are in `statusJson()`: an AR-armed
     *  sweep that painted nothing needs to say whether ARCore produced poses at
     *  all or produced only untracked ones. */
    private val posesToSink = AtomicLong(0)
    private val posesNotTracking = AtomicLong(0)

    // ── open ────────────────────────────────────────────────────────────

    /** Construct + configure the session. Returns null on success, or the
     *  reason. Does NOT resume — in shared mode the capture session has to
     *  exist first. */
    fun open(): String? {
        val features = if (wantShared) EnumSet.of(Session.Feature.SHARED_CAMERA)
        else EnumSet.noneOf(Session.Feature::class.java)
        val s = try {
            Session(ctx, features)
        } catch (t: Throwable) {
            // Every UnavailableException subclass sends the operator somewhere
            // different, so the class NAME is carried rather than a generic
            // "ARCore failed".
            return "Session(${if (wantShared) "SHARED_CAMERA" else "no features"}) threw " +
                "${t.javaClass.simpleName}: ${t.message}"
        }
        session = s

        if (wantShared) {
            sharedCamera = try { s.sharedCamera } catch (t: Throwable) {
                return "getSharedCamera() threw ${t.javaClass.simpleName}: ${t.message}"
            }
            if (sharedCamera == null) return "getSharedCamera() returned null"
        }

        // ── The camera config, and what it COSTS ────────────────────────
        // ARCore chooses the camera id and the CPU image size from this list.
        // The recorder's widest-FOV pick and its 1920 cap are both overridden;
        // the whole list is recorded so the pack says what was on offer, not
        // only what was taken.
        try {
            val filter = CameraConfigFilter(s)
            val all = s.getSupportedCameraConfigs(filter)
            for (c in all) {
                configsSeen += "id=${c.cameraId} cpu=${c.imageSize} gpu=${c.textureSize} " +
                    "fps=${c.fpsRange} depth=${c.depthSensorUsage}"
            }
            // LARGEST CPU IMAGE WINS. The recorder's whole output is that
            // buffer, and 640x480 vs 1920x1080 is the difference between a
            // pack that can be looked at and one that can only be counted.
            // (On SM-A356U1 the list is 640x480 / 1280x720 / 1920x1080, all on
            // camera 0 at 30 fps — so the ultra-wide id 2 is NOT reachable in
            // shared mode on that device at all.)
            val best = all.maxByOrNull {
                it.imageSize.width.toLong() * it.imageSize.height.toLong()
            }
            if (best != null) {
                s.cameraConfig = best
            }
            snapshotCameraConfig(s)
        } catch (t: Throwable) {
            // Non-fatal: ARCore keeps whatever default it picked, and the pack
            // reports that the enumeration failed rather than a config that
            // was never chosen.
            onAdvise(
                "ARCore camera-config enumeration failed (${t.javaClass.simpleName}: " +
                    "${t.message}) — the session keeps its DEFAULT config, so the pack's " +
                    "raster is whatever ARCore chose",
            )
            snapshotCameraConfig(s)
        }

        val cfg = Config(s)
        // Everything that costs frames or moves pixels is OFF. This session is
        // a pose source; a plane finder, a depth pass and a light estimator
        // would each spend the tracking budget the reference series is for.
        cfg.planeFindingMode = Config.PlaneFindingMode.DISABLED
        cfg.lightEstimationMode = Config.LightEstimationMode.DISABLED
        cfg.depthMode = Config.DepthMode.DISABLED
        cfg.instantPlacementMode = Config.InstantPlacementMode.DISABLED
        cfg.cloudAnchorMode = Config.CloudAnchorMode.DISABLED
        // BLOCKING gives exactly one update() per camera frame, which is what a
        // per-frame ledger wants. LATEST_CAMERA_IMAGE is for a renderer that
        // must not stall, and it would silently drop poses.
        cfg.updateMode = Config.UpdateMode.BLOCKING
        // ⚠ EIS WOULD DESTROY THE EXPERIMENT. Electronic image stabilisation
        // warps the frame against the very motion the attitude channel is
        // being graded on, so the pixels and the pose would no longer describe
        // the same camera. OFF is ARCore's default; it is set explicitly
        // because a default is not a guarantee and this one is load-bearing.
        try {
            cfg.imageStabilizationMode = Config.ImageStabilizationMode.OFF
        } catch (t: Throwable) {
            onAdvise(
                "ARCore image-stabilisation could not be set OFF explicitly " +
                    "(${t.javaClass.simpleName}) — if this runtime enables EIS by default " +
                    "the pixels are warped against the motion and the pose/pixel pairing " +
                    "is not trustworthy",
            )
        }
        focusApplied = when (focusModeOpt.lowercase()) {
            "fixed" -> { cfg.focusMode = Config.FocusMode.FIXED; "FIXED" }
            else -> { cfg.focusMode = Config.FocusMode.AUTO; "AUTO" }
        }
        try {
            s.configure(cfg)
        } catch (t: Throwable) {
            return "Session.configure threw ${t.javaClass.simpleName}: ${t.message}"
        }
        return null
    }

    /** Copy the live config into plain fields — see the field declarations for
     *  the shutdown-time zeroing this defends against. */
    private fun snapshotCameraConfig(s: Session) {
        try {
            val cc = s.cameraConfig
            cfgCameraId = cc.cameraId
            cfgCpuSize = cc.imageSize
            cfgGpuSize = cc.textureSize?.toString()
            cfgFpsRange = cc.fpsRange?.toString()
        } catch (t: Throwable) {
            onAdvise(
                "ARCore's chosen CameraConfig could not be read " +
                    "(${t.javaClass.simpleName}) — the pack cannot say which camera or " +
                    "raster ARCore forced, so treat this sweep's configuration as UNKNOWN " +
                    "rather than as the recorder's own choice",
            )
        }
    }

    fun close() {
        stop(2000L)
    }

    // ── the Camera2 seam (SHARED only) ──────────────────────────────────

    override fun forcedCameraId(): String? = if (wantShared) cfgCameraId else null

    override fun forcedImageSize(): Size? = if (wantShared) cfgCpuSize else null

    override fun wrapDeviceStateCallback(
        cb: CameraDevice.StateCallback,
        h: Handler,
    ): CameraDevice.StateCallback {
        val sc = sharedCamera ?: return cb
        return try { sc.createARDeviceStateCallback(cb, h) } catch (t: Throwable) {
            onAdvise(
                "createARDeviceStateCallback threw ${t.javaClass.simpleName} — the camera is " +
                    "opened WITHOUT ARCore's device callback, so ARCore will not be able to " +
                    "track on this session",
            )
            cb
        }
    }

    override fun wrapSessionStateCallback(
        cb: CameraCaptureSession.StateCallback,
        h: Handler,
    ): CameraCaptureSession.StateCallback {
        val sc = sharedCamera ?: return cb
        return try { sc.createARSessionStateCallback(cb, h) } catch (t: Throwable) {
            onAdvise(
                "createARSessionStateCallback threw ${t.javaClass.simpleName} — ARCore will " +
                    "not see this capture session",
            )
            cb
        }
    }

    override fun arCoreSurfaces(): List<Surface> {
        val sc = sharedCamera ?: return emptyList()
        return try { sc.arCoreSurfaces ?: emptyList() } catch (t: Throwable) {
            onAdvise("getArCoreSurfaces threw ${t.javaClass.simpleName}: ${t.message}")
            emptyList()
        }
    }

    override fun setAppSurfaces(cameraId: String, surfaces: List<Surface>) {
        val sc = sharedCamera ?: return
        try { sc.setAppSurfaces(cameraId, surfaces) } catch (t: Throwable) {
            onAdvise(
                "setAppSurfaces threw ${t.javaClass.simpleName}: ${t.message} — ARCore's own " +
                    "repeating request may not include the recorder's ImageReader, which " +
                    "would stop frames arriving the moment ARCore resumes",
            )
        }
    }

    override fun onSessionConfigured(
        captureCallback: CameraCaptureSession.CaptureCallback,
        h: Handler,
    ) {
        pendingCaptureCallback = captureCallback
        pendingCaptureHandler = h
        configured.set(true)
    }

    private var pendingCaptureCallback: CameraCaptureSession.CaptureCallback? = null
    private var pendingCaptureHandler: Handler? = null

    // ── the pump ────────────────────────────────────────────────────────

    override fun startPump(writer: (String) -> Unit, index: ArCoreFrameIndex?) {
        if (!running.compareAndSet(false, true)) return
        this.writer = writer
        this.frameIndex = index
        val t = Thread({ pumpBody() }, "rnis-pp-arcore")
        t.isDaemon = true
        pumpThread = t
        t.start()
    }

    private fun pumpBody() {
        val s = session ?: return
        val gl = OffscreenGl()
        val glErr = gl.create()
        eglSummary = gl.summary
        if (glErr != null) {
            // FATAL for this channel and only this channel: without a GL
            // context `update()` throws on every call, so there is no point
            // spinning. The recorder's own sweep is untouched.
            //
            // ⚠ RELEASE ANYWAY. `create()` fails at one of six steps and the
            // first of them is `eglInitialize`, so a failure at any LATER step
            // leaves an initialised display — and a failure after
            // `eglCreateContext`/`eglMakeCurrent` leaves a context CURRENT on
            // this thread, which is about to exit. Returning without this leaks
            // one EGLContext per attempt for the life of the process; the
            // operator who taps record again after a GL failure gets a second
            // one, and eventually `eglCreateContext` fails for a reason that
            // has nothing to do with the original fault. `release()` guards
            // every handle, so it is correct on a partial create.
            gl.release()
            glError = glErr
            firstError.compareAndSet(null, glErr)
            onAdvise(
                "ARCore reference channel could not create its offscreen GL context " +
                    "($glErr). Session.update() requires one, so NO ARCore poses were " +
                    "recorded. The sweep's pixels and rotation-vector series are unaffected.",
            )
            running.set(false)
            return
        }

        try {
            s.setCameraTextureName(gl.textureId)
        } catch (t: Throwable) {
            glError = "setCameraTextureName threw ${t.javaClass.simpleName}: ${t.message}"
            firstError.compareAndSet(null, glError)
            onAdvise("ARCore $glError — no poses will be recorded")
            gl.release()
            running.set(false)
            return
        }

        // In SHARED mode ARCore must not resume before the app's capture
        // session exists — it installs its repeating request onto that
        // session. In STANDALONE it owns the camera and can resume at once.
        if (wantShared) {
            val deadline = SystemClock.elapsedRealtime() + 8000L
            while (running.get() && !configured.get() &&
                SystemClock.elapsedRealtime() < deadline
            ) {
                try { Thread.sleep(10L) } catch (_: InterruptedException) { break }
            }
            if (!configured.get()) {
                resumeError = "the capture session was not configured within 8s; ARCore " +
                    "was never resumed"
                firstError.compareAndSet(null, resumeError)
                onAdvise("ARCore reference channel: $resumeError")
                gl.release()
                running.set(false)
                return
            }
        }

        try {
            s.resume()
            resumedAtElapsedNs = SystemClock.elapsedRealtimeNanos()
        } catch (t: Throwable) {
            resumeError = "Session.resume() threw ${t.javaClass.simpleName}: ${t.message}"
            firstError.compareAndSet(null, resumeError)
            onAdvise(
                "ARCore $resumeError — on a shared session this usually means the camera " +
                    "was taken by another client; no poses were recorded",
            )
            gl.release()
            running.set(false)
            return
        }

        // ⚠ AFTER resume(), NOT BEFORE. Session.resume() installs ARCore's own
        // repeating request over the shared session and with it ARCore's
        // CaptureCallback — so the app's callback, and therefore every
        // SENSOR_TIMESTAMP that track.jsonl is allowed to carry, is dropped
        // unless it is re-registered here.
        if (wantShared) {
            val cb = pendingCaptureCallback
            val h = pendingCaptureHandler
            if (cb != null && h != null) {
                try { sharedCamera?.setCaptureCallback(cb, h) } catch (t: Throwable) {
                    onAdvise(
                        "SharedCamera.setCaptureCallback threw ${t.javaClass.simpleName} — " +
                            "the recorder will stop receiving CaptureResults now that ARCore " +
                            "owns the repeating request, so track rows will carry " +
                            "metaJoined:false",
                    )
                }
            }
        }

        while (running.get()) {
            val frame: Frame? = try {
                s.update()
            } catch (t: Throwable) {
                updateFailures.incrementAndGet()
                firstError.compareAndSet(
                    null, "update() threw ${t.javaClass.simpleName}: ${t.message}",
                )
                try { Thread.sleep(5L) } catch (_: InterruptedException) { break }
                null
            }
            if (frame != null) emit(frame)
        }

        try { s.pause() } catch (t: Throwable) { Log.w(ARTAG, "session.pause threw", t) }
        gl.release()
    }

    private fun emit(frame: Frame) {
        val deliveredElapsedNs = SystemClock.elapsedRealtimeNanos()
        val tsNs = try { frame.timestamp } catch (_: Throwable) { 0L }
        if (tsNs == 0L) {
            // ARCore hands back timestamp 0 for a frame that carries no camera
            // image yet (its own documented "not ready" signal). Counted, never
            // written: a row at t=0 would be an out-of-order sample in every
            // reader downstream.
            zeroTimestampFrames.incrementAndGet()
            return
        }

        val cam = try { frame.camera } catch (_: Throwable) { null } ?: return
        val state = try { cam.trackingState } catch (_: Throwable) { null }
        val stateName = state?.name ?: "unknown"
        val reason = try {
            if (state == TrackingState.TRACKING) "NONE" else cam.trackingFailureReason.name
        } catch (_: Throwable) { "unknown" }

        // ⚠ THE LIVE ONE, not just the histogram. The histogram is a pack
        // artefact read minutes later; the operator is standing there NOW
        // being told "Waiting for AR tracking" with no reason, and the advice
        // that message gives ("hold steady") is actively wrong when the answer
        // is INSUFFICIENT_LIGHT. Same value, published live.
        latestTrackingFailure = if (stateName == "TRACKING") "" else reason
        synchronized(trackingStateHist) {
            trackingStateHist[stateName] = (trackingStateHist[stateName] ?: 0L) + 1L
            if (stateName != "TRACKING") {
                failureReasonHist[reason] = (failureReasonHist[reason] ?: 0L) + 1L
            }
        }
        if (state == TrackingState.TRACKING) tracking.incrementAndGet()

        val q = try { cam.pose.rotationQuaternion } catch (_: Throwable) { null }
        val tr = try { cam.pose.translation } catch (_: Throwable) { null }
        val qd = try { cam.displayOrientedPose.rotationQuaternion } catch (_: Throwable) { null }
        if (q == null || q.size < 4) return

        // ── THE LIVE ARM ────────────────────────────────────────────────
        // BEFORE the JSONL row is composed, because the row is ~600 bytes of
        // string building and the sink is the thing a frame is waiting on.
        // The sidecar is evidence; this is the sweep.
        //
        // `pose`, NOT `displayOrientedPose`. The display-oriented one folds in
        // the current screen rotation, which would make the attitude series a
        // function of how the operator was holding the phone — the engine
        // wants the physical camera's rotation and applies its own output
        // orientation downstream.
        val sink = poseSink
        if (sink != null) {
            val isTracking = state == TrackingState.TRACKING
            if (isTracking) posesToSink.incrementAndGet() else posesNotTracking.incrementAndGet()
            try {
                sink.onPose(
                    tsNs,
                    q[0].toDouble(), q[1].toDouble(), q[2].toDouble(), q[3].toDouble(),
                    isTracking,
                )
            } catch (t: Throwable) {
                // A sink that throws must not kill the pump: the reference
                // sidecar is still being written and is still the thing that
                // lets the sweep be replayed on the other arm offline.
                Log.w(ARTAG, "pose sink threw", t)
            }
        }

        if (intrinsicsJson == "null") {
            intrinsicsJson = try {
                val i = cam.imageIntrinsics
                val f = i.focalLength
                val p = i.principalPoint
                val d = i.imageDimensions
                Jo().n("fx", f[0].toDouble()).n("fy", f[1].toDouble())
                    .n("cx", p[0].toDouble()).n("cy", p[1].toDouble())
                    .i("width", d[0].toLong()).i("height", d[1].toLong())
                    .s(
                        "note",
                        "ARCore's own CPU-image intrinsics, recorded once. They describe " +
                            "ARCore's image, which in shared mode is the SAME buffer the " +
                            "recorder writes, and in standalone mode is a buffer this pack " +
                            "does not contain.",
                    )
                    .end()
            } catch (_: Throwable) { "null" }
        }

        val m = frameIndex?.match(tsNs)
        if (firstTsNs.get() == 0L) firstTsNs.set(tsNs)
        lastTsNs.set(tsNs)

        val row = Jo()
            .s("kind", "arcore-frame")
            .i("tsNs", tsNs)
            .n("tS", tsNs / 1e9)
            .raw("q", jarr(q[0].toDouble(), q[1].toDouble(), q[2].toDouble(), q[3].toDouble()))
            .raw(
                "qDisplayOriented",
                if (qd != null && qd.size >= 4)
                    jarr(qd[0].toDouble(), qd[1].toDouble(), qd[2].toDouble(), qd[3].toDouble())
                else "null",
            )
            .raw(
                "t",
                if (tr != null && tr.size >= 3)
                    jarr(tr[0].toDouble(), tr[1].toDouble(), tr[2].toDouble())
                else "null",
            )
            .s("trackingState", stateName)
            .s("trackingFailureReason", reason)
            // WHICH FRAME THIS POSE BELONGS TO — stated as MEASURED, not as
            // documented. ARCore's Frame.getTimestamp() is specified to share
            // the Camera2 SENSOR_TIMESTAMP timebase, and the obvious reading of
            // that ("so the join is by equality") IS WRONG ON REAL HARDWARE:
            // on SM-A356U1, 0 of 738 ARCore timestamps equalled any track row's
            // tsNs, while the nearest-neighbour gap had a median of 0.9 ms and
            // stayed inside one 30 fps frame period. Same timebase, different
            // instant. JOIN BY NEAREST, NEVER BY EQUALITY — which is also why
            // the S1 runner brackets and SLERPs rather than looking up.
            .s("tsDomain", if (wantShared)
                "arcore-frame-timestamp; SAME timebase as the recorder's Camera2 " +
                    "SENSOR_TIMESTAMP but NOT bit-identical to it — join by nearest"
            else "arcore-frame-timestamp (ARCore's own camera; no Camera2 stream of ours)")
            // ⚠ LIVE AND LAG-BIASED, and the value says so. The recorder's ring
            // holds only frames ALREADY ENCODED, and on a shared session the
            // CaptureResult that feeds the writer arrives ~116 ms after its own
            // sensor timestamp while ARCore's pump sees the frame sooner — so
            // this lookup resolves ~2 periods back. The authoritative join is
            // offline, on `tsNs`, which is exact on every row.
            .s("matchKind", m?.kind ?: if (wantShared) "no-frame-index" else "no-camera2-stream")
            .i("matchSeq", m?.seq ?: -1L)
            .i("matchDeltaNs", m?.deltaNs ?: 0L)
            .i("elapsedRealtimeNsAtDelivery", deliveredElapsedNs)
            .end()

        try { writer?.invoke(row) } catch (t: Throwable) {
            Log.w(ARTAG, "arcore row write threw", t)
            return
        }
        rows.incrementAndGet()
    }

    override fun stop(joinMs: Long) {
        if (!closed.compareAndSet(false, true)) return
        running.set(false)
        val t = pumpThread
        pumpThread = null
        if (t != null && t !== Thread.currentThread()) {
            // join(0) blocks FOREVER — the same one-line trap the recorder's
            // JoinBudget exists to make un-hittable.
            if (joinMs > 0L) {
                try { t.join(joinMs) } catch (_: InterruptedException) {}
            }
            if (t.isAlive) {
                onAdvise(
                    "the ARCore pump thread did not exit within ${joinMs}ms — it was left " +
                        "running and any pose it had not yet flushed is missing from this pack",
                )
            }
        }
        // The session is closed only after the pump is out of update(); calling
        // close() under a live update() is a native crash, the same rule the
        // recorder's ImageReader teardown follows.
        val s = session
        session = null
        sharedCamera = null
        if (s != null && (t == null || !t.isAlive)) {
            try { s.close() } catch (x: Throwable) { Log.w(ARTAG, "session.close threw", x) }
        } else if (s != null) {
            onAdvise(
                "the ARCore Session was NOT closed: its pump thread is still inside update(). " +
                    "It will be reclaimed with the process; a subsequent ARCore start in this " +
                    "process may fail until then.",
            )
        }
    }

    override fun rowsWritten(): Long = rows.get()
    override fun trackingRows(): Long = tracking.get()
    override fun advisories(): List<String> = emptyList()

    /** @Volatile write; no lock. The pump reads the field once per frame and a
     *  torn read is not possible for a reference. Clearing it at teardown is
     *  what stops a late pump frame inserting into a ring already being
     *  reported on. */
    override fun setPoseSink(sink: ArCorePoseSink?) { poseSink = sink }

    override fun statusJson(): String {
        val stateHist = synchronized(trackingStateHist) {
            trackingStateHist.entries.sortedBy { it.key }
                .joinToString(",", "{", "}") { "${jstr(it.key)}:${it.value}" }
        }
        val reasonHist = synchronized(trackingStateHist) {
            failureReasonHist.entries.sortedBy { it.key }
                .joinToString(",", "{", "}") { "${jstr(it.key)}:${it.value}" }
        }
        return Jo()
            .s("modeRan", modeRan)
            .s(
                "modeMeaning",
                if (wantShared)
                    "SHARED CAMERA: the app owns the CameraDevice and the capture session; " +
                        "ARCore added its surfaces to them. The pixels in frames/ and the " +
                        "poses in attitude_arcore.jsonl come from the SAME capture, which is " +
                        "what makes the two attitude arms comparable on identical input."
                else
                    "STANDALONE: ARCore owns the camera and this pack contains NO PIXELS. " +
                        "The rotation-vector series and the ARCore series are simultaneous, " +
                        "so the BASIS falsification is valid — but this is NOT the " +
                        "same-pixels pose-arm A/B and must never be read as one.",
            )
            .s("cameraIdChosenByArCore", cfgCameraId)
            .s("cpuImageSize", cfgCpuSize?.toString())
            .s("gpuTextureSize", cfgGpuSize)
            .s("fpsRange", cfgFpsRange)
            .raw("supportedCameraConfigs", jarrStr(configsSeen))
            .s(
                "configConfound",
                if (wantShared)
                    "ARCore SELECTS the camera id and the CPU image size from the list above; " +
                        "the recorder's own widest-FOV choice and its maxWidth cap were both " +
                        "OVERRIDDEN. Session.resume() also installs ARCore's own repeating " +
                        "request, so the recorder's AE/AWB/AF lock requests are ARCore's to " +
                        "keep or drop — read applied.exposureTimeNs / sensitivityIso below: " +
                        "min==max is the lock reaching the pixels, a spread is ARCore running " +
                        "its own AE."
                else
                    "not applicable — the recorder opened no camera in this mode",
            )
            .s("focusModeApplied", focusApplied)
            .s("imageStabilisation", "requested OFF (EIS warps pixels against the motion)")
            .s("updateMode", "BLOCKING (one update() per camera frame)")
            .s("egl", eglSummary)
            .s("glError", glError)
            .s("resumeError", resumeError)
            .i("resumedAtElapsedRealtimeNs", resumedAtElapsedNs)
            .i("rowsWritten", rows.get())
            .i("trackingRows", tracking.get())
            // ── THE LIVE ARM'S OWN COUNTERS (2026-09-02) ─────────────────
            // Zero on every reference-only sweep, which is the honest reading:
            // no sink was installed, so no pose was offered to one. On an
            // AR-ARMED sweep these two separate "ARCore produced nothing" from
            // "ARCore produced only untracked poses" — different faults with
            // different fixes (light/texture vs. the session never resuming).
            .i("posesOfferedToLiveArm", posesToSink.get())
            .i("posesRefusedNotTracking", posesNotTracking.get())
            .i("updateFailures", updateFailures.get())
            .i("zeroTimestampFramesSkipped", zeroTimestampFrames.get())
            .i("firstTsNs", firstTsNs.get())
            .i("lastTsNs", lastTsNs.get())
            .n(
                "hzMeasured",
                if (lastTsNs.get() > firstTsNs.get() && rows.get() > 1)
                    (rows.get() - 1) / ((lastTsNs.get() - firstTsNs.get()) / 1e9) else 0.0,
            )
            .raw("trackingStateHistogram", stateHist)
            .raw("trackingFailureReasonHistogram", reasonHist)
            .raw("imageIntrinsics", intrinsicsJson)
            .s("firstError", firstError.get())
            .s(
                "poseConvention",
                "q is Camera.getPose().getRotationQuaternion() — world<-camera in ARCore's " +
                    "GL camera convention (+X right, +Y up, +Z backwards along the optical " +
                    "axis), the direct analogue of ARKit's ARCamera.transform and the series " +
                    "selectBasis() expects. qDisplayOriented is getDisplayOrientedPose(), " +
                    "which folds in the display rotation; it is recorded so the CHOICE is the " +
                    "reader's, and it is NOT the default.",
            )
            .end()
    }
}

// ════════════════════════════════════════════════════════════════════════
//  The offscreen GL context ARCore requires
// ════════════════════════════════════════════════════════════════════════

/**
 * A 1×1 pbuffer and one external texture — the minimum `Session.update()` will
 * accept, on a recorder that has no view to render into.
 *
 * ⚠ EVERYTHING HERE IS THREAD-CONFINED to the thread that called `create()`.
 * An EGL context is current on ONE thread, and `update()` must be called on
 * that same thread; the pump owns both, which is why this class is private to
 * it and has no locking.
 */
private class OffscreenGl {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var surface: EGLSurface = EGL14.EGL_NO_SURFACE
    var textureId: Int = 0
        private set
    var summary: String = "not-created"
        private set

    /** Null on success, else the reason — which is reported into the pack
     *  rather than logged, because "ARCore recorded nothing" and "ARCore could
     *  not get a GL context" are the same symptom with different fixes. */
    fun create(): String? {
        // ⚠ `summary` ADVANCES WITH THE STEPS, and it is not decoration: it is
        // what `device.json`'s `arcore.channel.egl` carries, and a failure at
        // step five used to report `egl: "not-created"` for a display that had
        // been initialised and a context that had been made. That sends the
        // reader to "this device has no EGL" when the real fault was one call
        // further in.
        summary = "eglGetDisplay"
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        if (display == EGL14.EGL_NO_DISPLAY) return "eglGetDisplay returned EGL_NO_DISPLAY"
        val ver = IntArray(2)
        summary = "eglInitialize"
        if (!EGL14.eglInitialize(display, ver, 0, ver, 1)) {
            return "eglInitialize failed (0x${Integer.toHexString(EGL14.eglGetError())})"
        }
        summary = "EGL ${ver[0]}.${ver[1]}, initialised (no config yet)"
        val attribs = intArrayOf(
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val n = IntArray(1)
        if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, n, 0) || n[0] <= 0) {
            return "eglChooseConfig found no ES2 pbuffer config"
        }
        context = EGL14.eglCreateContext(
            display, configs[0], EGL14.EGL_NO_CONTEXT,
            intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
        )
        if (context == EGL14.EGL_NO_CONTEXT) {
            return "eglCreateContext failed (0x${Integer.toHexString(EGL14.eglGetError())})"
        }
        summary = "EGL ${ver[0]}.${ver[1]}, ES2 context created (no surface yet)"
        surface = EGL14.eglCreatePbufferSurface(
            display, configs[0],
            intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0,
        )
        if (surface == EGL14.EGL_NO_SURFACE) {
            return "eglCreatePbufferSurface failed (0x${Integer.toHexString(EGL14.eglGetError())})"
        }
        if (!EGL14.eglMakeCurrent(display, surface, surface, context)) {
            return "eglMakeCurrent failed (0x${Integer.toHexString(EGL14.eglGetError())})"
        }
        summary = "EGL ${ver[0]}.${ver[1]}, 1x1 pbuffer current (no texture yet)"
        val tex = IntArray(1)
        GLES20.glGenTextures(1, tex, 0)
        if (tex[0] == 0) return "glGenTextures returned 0"
        textureId = tex[0]
        GLES20.glBindTexture(GL_TEXTURE_EXTERNAL_OES, textureId)
        GLES20.glTexParameteri(
            GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR,
        )
        GLES20.glTexParameteri(
            GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR,
        )
        summary = "EGL ${ver[0]}.${ver[1]}, 1x1 pbuffer, external texture $textureId"
        return null
    }

    fun release() {
        try {
            if (display != EGL14.EGL_NO_DISPLAY) {
                if (textureId != 0) {
                    GLES20.glDeleteTextures(1, intArrayOf(textureId), 0)
                    textureId = 0
                }
                EGL14.eglMakeCurrent(
                    display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT,
                )
                if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
                if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
                EGL14.eglTerminate(display)
            }
        } catch (t: Throwable) {
            Log.w(ARTAG, "EGL teardown threw", t)
        } finally {
            display = EGL14.EGL_NO_DISPLAY
            context = EGL14.EGL_NO_CONTEXT
            surface = EGL14.EGL_NO_SURFACE
        }
    }
}
