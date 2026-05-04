// SPDX-License-Identifier: UNLICENSED
package com.retailens.capturesdk

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.opencv.calib3d.Calib3d
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.DMatch
import org.opencv.core.KeyPoint
import org.opencv.core.Mat
import org.opencv.core.MatOfByte
import org.opencv.core.MatOfDMatch
import org.opencv.core.MatOfInt
import org.opencv.core.MatOfKeyPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Rect
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.features2d.BFMatcher
import org.opencv.features2d.ORB
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android twin of iOS' OpenCVIncrementalStitcher + RetaiLensIncrementalStitcher.
 *
 * Why a single file (vs the iOS three-file split):
 *   On iOS we cross C++↔ObjC↔Swift boundaries, so the .h/.mm/.swift
 *   layering pays for itself.  On Android, OpenCV's Java bindings
 *   give us cv::* operations directly callable from Kotlin — no JNI
 *   layer, no language boundary, the engine logic lives next to the
 *   RN module.
 *
 * Why we DON'T need cv::Stitcher (the missing piece on Android):
 *   The incremental algorithm only uses ORB + BFMatcher +
 *   findHomography + warpPerspective + distanceTransform.  All of
 *   these ship in the prebuilt `libopencv_java4.so` (features2d,
 *   calib3d, imgproc are always-on modules).  See the design doc for
 *   the full module-level breakdown.
 *
 * What the bridge exposes to JS:
 *   - start(options)        — spin up the engine
 *   - processFrameAtPath()  — feed a JPEG path + pose; engine returns
 *                             the same outcome enum iOS emits as events
 *   - finalize(options)     — write the final panorama and reset
 *   - cancel()              — abort without producing output
 *   - getState()            — pull the latest state on demand
 *   - Event "RetaiLensIncrementalStateUpdate" emitted on every
 *     processFrameAtPath call
 *
 * What's missing for true live capture on Android:
 *   ARCore-backed live frame delivery.  The engine itself doesn't
 *   care where frames come from; today the only Android caller is
 *   the `processFrameAtPath` bridge method.  A follow-up will plumb
 *   ARCore's per-frame `Frame.acquireCameraImage()` directly into
 *   the engine the same way iOS uses ARSession.
 */
class RetaiLensIncrementalStitcher(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "RetaiLensIncrementalStitcher"

    /// Required by RCTEventEmitter contract.  No-op on Android because
    /// `DeviceEventManagerModule` does its own listener tracking; we
    /// emit unconditionally and RN drops events when no listener is
    /// attached.
    @ReactMethod
    fun addListener(eventName: String) { /* no-op */ }

    @ReactMethod
    fun removeListeners(count: Int) { /* no-op */ }

    /// V7 hybrid engine — selected for engineMode == 'hybrid'.
    private var engine: IncrementalEngine? = null
    /// V12.7 firstwins engine — selected for any engineMode starting
    /// with 'firstwins' (firstwins, firstwins-zoomed, firstwins-rectilinear).
    /// Native engine is identical for firstwins and firstwins-zoomed
    /// (the difference is JS-side viewport zoom only).  useRectilinear
    /// is set for 'firstwins-rectilinear'.
    private var firstwinsEngine: IncrementalFirstwinsEngine? = null
    private val isRunning = AtomicBoolean(false)
    /// Critic #5 fix: serial dispatcher so concurrent
    /// processFrameAtPath() calls can't race on the engine's canvas.
    /// `limitedParallelism(1)` guarantees one-at-a-time execution
    /// while still backing onto the Default pool — matches iOS'
    /// `workQueue` (DispatchQueue.serial).
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val workScope = CoroutineScope(Dispatchers.Default.limitedParallelism(1))

    /// Reference to a mounted ARCameraView (if any).  Set by the view
    /// when it attaches; the engine flips its `ingestActive` flag
    /// on start/stop so the view feeds frames only during a capture.
    @Volatile private var arCameraViewRef: RetaiLensARCameraView? = null

    init {
        // Static back-pointer so `RetaiLensARCameraView` can call into
        // the singleton-style bridge module without a DI dance.  RN
        // may rebuild module instances across reloads; the view always
        // uses the latest reference.
        bridgeInstance = this
    }

    /// View calls this on attach so the engine can route ingestion
    /// without searching the view tree on every frame.
    internal fun bindArCameraView(view: RetaiLensARCameraView) {
        arCameraViewRef = view
        // If a capture is already running when the view mounts, hot-
        // engage ingestion so the user gets a partial panorama
        // started from this point onward.
        if (isRunning.get()) {
            view.setIncrementalIngestionActive(true)
        }
    }

    internal fun unbindArCameraView(view: RetaiLensARCameraView) {
        if (arCameraViewRef === view) {
            view.setIncrementalIngestionActive(false)
            arCameraViewRef = null
        }
    }

    @ReactMethod
    fun start(options: ReadableMap, promise: Promise) {
        if (isRunning.getAndSet(true)) {
            promise.reject(
                "incremental-already-running",
                "An incremental capture is already in progress.",
            )
            return
        }
        try {
            ensureOpenCv()
            val rotation = options.getIntOrDefault("frameRotationDegrees", 90)
            val composeW = options.getIntOrDefault("composeWidth",  960)
            val composeH = options.getIntOrDefault("composeHeight", 720)
            // V12 default canvas: 5000x5000 to match iOS.  Old default
            // was 4800x2200 (V7 wide-only); V12 needs square because
            // either pan axis can grow.
            val canvasW  = options.getIntOrDefault("canvasWidth",   5000)
            val canvasH  = options.getIntOrDefault("canvasHeight",  5000)
            val featherP = options.getIntOrDefault("featherPx",     20)
            val snapQ    = max(1, min(100, options.getIntOrDefault("snapshotJpegQuality", 75)))
            // Critic #29: clamp snapshotEveryNAccepts to >= 1 so a
            // value of 0 doesn't mean "snapshot every frame forever".
            val snapN    = max(1, options.getIntOrDefault("snapshotEveryNAccepts", 1))
            // V12.7 — engineMode now distinguishes 4 variants.  See
            // src/stitching/incremental.ts for the full description.
            val engineMode = options.getString("engine") ?: "hybrid"
            val isFirstwins = engineMode.startsWith("firstwins")
            val useRectilinear = engineMode == "firstwins-rectilinear"
            if (isFirstwins) {
                firstwinsEngine = IncrementalFirstwinsEngine(
                    composeWidth = composeW,
                    composeHeight = composeH,
                    canvasWidth = canvasW,
                    canvasHeight = canvasH,
                    snapshotJpegQuality = snapQ,
                    snapshotEveryNAccepts = snapN,
                    frameRotationDegrees = rotation,
                    useRectilinear = useRectilinear,
                    // Critic #27 fix: writable app-sandbox dir for
                    // live-snapshot JPEGs.  java.io.tmpdir resolves to
                    // /data/local/tmp on Android (rooted-only).
                    snapshotCacheDir = reactContext.cacheDir.absolutePath,
                )
                engine = null
            } else {
                engine = IncrementalEngine(
                    composeWidth  = composeW,
                    composeHeight = composeH,
                    canvasWidth   = canvasW,
                    canvasHeight  = canvasH,
                    featherPx     = featherP,
                    snapshotJpegQuality = snapQ,
                    snapshotEveryNAccepts = snapN,
                    frameRotationDegrees = rotation,
                )
                firstwinsEngine = null
            }
            // Engage the ARCameraView's per-frame ingestion path if a
            // view is mounted — this is what gives Android parity
            // with iOS' ARSession-driven path.  No-op when the view
            // isn't mounted (host is using vision-camera + the gyro
            // driver from useIncrementalAndroidDriver instead).
            arCameraViewRef?.setIncrementalIngestionActive(true)

            val map = Arguments.createMap()
            map.putBoolean("ok", true)
            promise.resolve(map)
        } catch (t: Throwable) {
            isRunning.set(false)
            promise.reject("incremental-start-failed", t.message, t)
        }
    }

    /**
     * Feed one frame at a JPEG path into the engine.  Pose inputs
     * drive the same FoV-overlap gate as iOS.  When a pose source
     * isn't available pass yaw=0, pitch=0, fovHorizDegrees=0 — the
     * engine treats fov<=0 as a sentinel for "no intrinsics" and
     * substitutes a 65° default, so frames will still be processed,
     * just less gated.
     */
    @ReactMethod
    fun processFrameAtPath(options: ReadableMap, promise: Promise) {
        val hybrid = this.engine
        val firstwins = this.firstwinsEngine
        if (hybrid == null && firstwins == null) {
            return promise.reject(
                "incremental-not-running",
                "Call start() before processFrameAtPath().",
            )
        }
        val path = options.getString("path")
            ?: return promise.reject("invalid-options", "path required")
        val yaw = options.getDoubleOrDefault("yaw", 0.0)
        val pitch = options.getDoubleOrDefault("pitch", 0.0)
        val fovH = options.getDoubleOrDefault("fovHorizDegrees", 65.0)
        val fovV = options.getDoubleOrDefault("fovVertDegrees", 50.0)
        // V6 pose-driven params.  Defaults removed per critic finding
        // #3: previously qw=1.0 default meant frames without explicit
        // quaternion produced an identity rotation, and EVERY
        // subsequent frame had R_rel = R_first^T (constant), so
        // strip placement never advanced and `acceptedCount` froze
        // at 1 after the first frame.  Now every quaternion field is
        // required; missing → reject as RejectedAlignmentLost so the
        // gyro driver upstream notices instantly.
        if (!options.hasKey("qx") || !options.hasKey("qy")
            || !options.hasKey("qz") || !options.hasKey("qw")) {
            return promise.reject(
                "invalid-options",
                "qx/qy/qz/qw all required (no identity-quaternion fallback)",
            )
        }
        val qx = options.getDouble("qx")
        val qy = options.getDouble("qy")
        val qz = options.getDouble("qz")
        val qw = options.getDouble("qw")
        val fx = options.getDoubleOrDefault("fx", 0.0)
        val fy = options.getDoubleOrDefault("fy", 0.0)
        val cx = options.getDoubleOrDefault("cx", 0.0)
        val cy = options.getDoubleOrDefault("cy", 0.0)
        val imageWidth = options.getIntOrDefault("imageWidth", 0)
        val imageHeight = options.getIntOrDefault("imageHeight", 0)
        val trackingPoor = options.getBooleanOrDefault("trackingPoor", false)

        workScope.launch {
            // Critic #4 fix: re-check isRunning synchronously here in
            // case finalize/cancel ran on the JS thread between the
            // null-check above and this dispatch landing.  Skip the
            // ingest if we're no longer running — matches iOS' V12.1
            // pattern (synchronous-stop + worker re-check).
            if (!isRunning.get()) {
                promise.resolve(Arguments.createMap().apply { putInt("outcome", -1) })
                return@launch
            }
            try {
                val telemetry: FrameTelemetry
                val state: WritableMap?
                val accepted: Int
                if (firstwins != null) {
                    telemetry = firstwins.addFrameAtPath(
                        path = path,
                        qx = qx, qy = qy, qz = qz, qw = qw,
                        fx = fx, fy = fy, cx = cx, cy = cy,
                        imageWidth = imageWidth, imageHeight = imageHeight,
                        yaw = yaw, pitch = pitch,
                        fovHorizDegrees = fovH, fovVertDegrees = fovV,
                        trackingPoor = trackingPoor,
                    )
                    state = firstwins.snapshotIfDue(telemetry)
                    accepted = firstwins.acceptedCount
                } else {
                    telemetry = hybrid!!.addFrameAtPath(
                        path = path,
                        qx = qx, qy = qy, qz = qz, qw = qw,
                        fx = fx, fy = fy, cx = cx, cy = cy,
                        imageWidth = imageWidth, imageHeight = imageHeight,
                        yaw = yaw, pitch = pitch,
                        fovHorizDegrees = fovH, fovVertDegrees = fovV,
                        trackingPoor = trackingPoor,
                    )
                    state = hybrid.snapshotIfDue(telemetry)
                    accepted = hybrid.acceptedCount
                }
                emitState(state)
                val result = Arguments.createMap()
                result.putInt("outcome", telemetry.outcome.ordinal)
                result.putDouble("confidence", telemetry.confidence)
                result.putDouble("overlapPercent", telemetry.overlapPercent)
                result.putDouble("processingMs", telemetry.processingMs)
                result.putInt("acceptedCount", accepted)
                promise.resolve(result)
            } catch (t: Throwable) {
                promise.reject("incremental-process-failed", t.message, t)
            }
        }
    }

    @ReactMethod
    fun finalize(options: ReadableMap, promise: Promise) {
        val hybrid = this.engine
        val firstwins = this.firstwinsEngine
        if (hybrid == null && firstwins == null) {
            return promise.reject(
                "incremental-not-running",
                "No active capture — call start() first.",
            )
        }
        val outputPathOpt = options.getString("outputPath") ?: ""
        val outputPath = if (outputPathOpt.isEmpty()) {
            File(reactContext.cacheDir, "RetaiLensIncremental-${System.nanoTime()}.jpg").absolutePath
        } else {
            outputPathOpt
        }
        val quality = options.getIntOrDefault("quality", 90)

        // Disengage the ARCameraView ingestion path FIRST so no late
        // frames slip into the engine while we serialize the canvas.
        arCameraViewRef?.setIncrementalIngestionActive(false)
        // Critic #4 fix: synchronously flip isRunning=false BEFORE
        // dispatching the finalize body, so any in-flight
        // processFrameAtPath workers that are about to launch will
        // bail at the re-check (see processFrameAtPath above).
        // Matches iOS V12.1 fix.
        isRunning.set(false)

        // Null the bridge refs synchronously NOW so any worker that's
        // about to run sees them as gone (V12.1 pattern).  We keep
        // local refs to do the actual finalize.
        engine = null
        firstwinsEngine = null

        workScope.launch {
            try {
                val map = Arguments.createMap()
                if (firstwins != null) {
                    val snap = firstwins.finalize(outputPath, quality)
                        ?: throw IllegalStateException("firstwins.finalize returned null")
                    map.putString("panoramaPath", snap.panoramaPath)
                    map.putInt("width", snap.width)
                    map.putInt("height", snap.height)
                    map.putInt("acceptedCount", snap.acceptedCount)
                    // Critic #22 fix: explicit native-buffer release.
                    firstwins.release()
                } else {
                    val snap = hybrid!!.finalize(outputPath, quality)
                    map.putString("panoramaPath", snap.panoramaPath)
                    map.putInt("width", snap.width)
                    map.putInt("height", snap.height)
                    map.putInt("acceptedCount", snap.acceptedCount)
                    hybrid.release()
                }
                map.putInt("droppedBackpressure", 0)
                promise.resolve(map)
            } catch (t: Throwable) {
                firstwins?.release()
                hybrid?.release()
                promise.reject("incremental-finalize-failed", t.message, t)
            }
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        // Critic #4 fix: synchronously flip isRunning + null engine
        // refs BEFORE releasing.  Any in-flight worker bails at the
        // re-check before touching the now-null engine.  Matches
        // iOS V12.1 cancel path.
        arCameraViewRef?.setIncrementalIngestionActive(false)
        isRunning.set(false)
        val hybrid = engine
        val firstwins = firstwinsEngine
        engine = null
        firstwinsEngine = null
        // Defer engine release onto the work queue so we don't race
        // with an ingest that already passed the null-check and is
        // mid-execution on a captured local reference.
        workScope.launch {
            hybrid?.release()
            firstwins?.reset()
        }
        val map = Arguments.createMap()
        map.putBoolean("ok", true)
        promise.resolve(map)
    }

    /**
     * Called by `RetaiLensARCameraView` per ARCore frame when it has
     * a fresh JPEG + pose to ingest.  Synchronous-feeling from the
     * caller's perspective but actually dispatched onto the engine's
     * own queue so we don't stall the GL render thread.  Drops the
     * frame silently if no engine is running (race between view
     * lifecycle and stitcher start/stop).
     */
    internal fun ingestFromARCameraView(
        path: String,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        yaw: Double,
        pitch: Double,
        fovHorizDegrees: Double,
        fovVertDegrees: Double,
        trackingPoor: Boolean,
    ) {
        val hybrid = this.engine
        val firstwins = this.firstwinsEngine
        if (hybrid == null && firstwins == null) return
        workScope.launch {
            val state: WritableMap? = if (firstwins != null) {
                val tele = firstwins.addFrameAtPath(
                    path = path,
                    qx = qx, qy = qy, qz = qz, qw = qw,
                    fx = fx, fy = fy, cx = cx, cy = cy,
                    imageWidth = imageWidth, imageHeight = imageHeight,
                    yaw = yaw, pitch = pitch,
                    fovHorizDegrees = fovHorizDegrees,
                    fovVertDegrees = fovVertDegrees,
                    trackingPoor = trackingPoor,
                )
                firstwins.snapshotIfDue(tele)
            } else {
                val tele = hybrid!!.addFrameAtPath(
                    path = path,
                    qx = qx, qy = qy, qz = qz, qw = qw,
                    fx = fx, fy = fy, cx = cx, cy = cy,
                    imageWidth = imageWidth, imageHeight = imageHeight,
                    yaw = yaw, pitch = pitch,
                    fovHorizDegrees = fovHorizDegrees,
                    fovVertDegrees = fovVertDegrees,
                    trackingPoor = trackingPoor,
                )
                hybrid.snapshotIfDue(tele)
            }
            emitState(state)
        }
    }

    @ReactMethod
    fun getState(promise: Promise) {
        val state = firstwinsEngine?.lastState ?: engine?.lastState
        if (state == null) {
            promise.resolve(null)
            return
        }
        promise.resolve(state)
    }

    private fun emitState(state: WritableMap?) {
        if (state == null) return
        // Re-emit to JS via the standard DeviceEventEmitter pattern.
        // RN drops events when no listener is attached, so we don't
        // need our own gating.
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("RetaiLensIncrementalStateUpdate", state)
    }

    // ── OpenCV bootstrap ────────────────────────────────────────────

    private fun ensureOpenCv() {
        if (!opencvInitialised.get()) {
            try {
                System.loadLibrary("opencv_java4")
                opencvInitialised.set(true)
            } catch (e: UnsatisfiedLinkError) {
                throw IllegalStateException(
                    "OpenCV native library 'opencv_java4' failed to load",
                    e,
                )
            }
        }
    }

    companion object {
        @JvmStatic
        private val opencvInitialised = AtomicBoolean(false)

        /// Static back-pointer used by the camera view to reach the
        /// active bridge module instance without a DI dance.  Set
        /// in `init {}` of the most recently constructed instance.
        @JvmStatic
        @Volatile
        var bridgeInstance: RetaiLensIncrementalStitcher? = null
            private set
    }
}


// ── ReadableMap helpers ─────────────────────────────────────────────

private fun ReadableMap.getIntOrDefault(key: String, default: Int): Int =
    if (hasKey(key) && !isNull(key)) getInt(key) else default

private fun ReadableMap.getDoubleOrDefault(key: String, default: Double): Double =
    if (hasKey(key) && !isNull(key)) getDouble(key) else default

private fun ReadableMap.getBooleanOrDefault(key: String, default: Boolean): Boolean =
    if (hasKey(key) && !isNull(key)) getBoolean(key) else default


// ── Frame outcome — mirrors iOS RLISFrameOutcome ────────────────────

internal enum class FrameOutcome {
    AcceptedHigh,
    AcceptedMedium,
    SkippedTooClose,
    RejectedTooFar,
    RejectedSceneUniform,
    RejectedAlignmentLost,
    SkippedTrackingPoor,
}


internal data class FrameTelemetry(
    val outcome: FrameOutcome,
    val overlapPercent: Double,
    val matchCount: Int,
    val inlierRatio: Double,
    val confidence: Double,
    val processingMs: Double,
)


internal data class StitcherSnapshot(
    val panoramaPath: String,
    val width: Int,
    val height: Int,
    val acceptedCount: Int,
)


/**
 * Pure-OpenCV implementation of the incremental algorithm.  No RN
 * dependency — this class can be unit-tested with synthetic Mat
 * inputs.  Exact algorithmic mirror of iOS' OpenCVIncrementalStitcher.mm.
 */
internal class IncrementalEngine(
    val composeWidth: Int,
    val composeHeight: Int,
    val canvasWidth: Int,
    val canvasHeight: Int,
    val featherPx: Int,
    val snapshotJpegQuality: Int,
    val snapshotEveryNAccepts: Int,
    /// 0/90/180/270 — rotation applied to each ingested frame before
    /// any other processing.  See iOS' equivalent for the full
    /// rationale.  JS computes from device orientation.
    val frameRotationDegrees: Int,
) {
    private val canvas: Mat = Mat.zeros(canvasHeight, canvasWidth, CvType.CV_8UC3)
    private val canvasMask: Mat = Mat.zeros(canvasHeight, canvasWidth, CvType.CV_8UC1)

    /// V7 pose-driven state — sensor-native compute path.  Mirrors iOS.
    private var firstRotationArkit: Mat = Mat()
    private var kCompose: Mat = Mat()
    private var tCanvas: Mat = Mat.eye(3, 3, CvType.CV_64F)
    private val mArkitToCv: Mat = Mat(3, 3, CvType.CV_64F).apply {
        // diag(1, -1, -1) — ARKit/ARCore (Y-up, -Z forward) → OpenCV.
        setTo(Scalar(0.0))
        put(0, 0, 1.0); put(1, 1, -1.0); put(2, 2, -1.0)
    }

    private var lastAcceptedYaw: Double = 0.0
    private var lastAcceptedPitch: Double = 0.0
    private var hasFirstFrame: Boolean = false
    private var acceptsSinceSnapshot: Int = 0
    var acceptedCount: Int = 0
        private set
    private var snapshotSeq: Int = 0
    var lastState: WritableMap? = null
        private set

    /**
     * Read the JPEG at `path`, downscale to compose-resolution, run
     * the same algorithm as the iOS engine.
     */
    fun addFrameAtPath(
        path: String,
        qx: Double,
        qy: Double,
        qz: Double,
        qw: Double,
        fx: Double,
        fy: Double,
        cx: Double,
        cy: Double,
        imageWidth: Int,
        imageHeight: Int,
        yaw: Double,
        pitch: Double,
        fovHorizDegrees: Double,
        fovVertDegrees: Double,
        trackingPoor: Boolean,
    ): FrameTelemetry {
        val t0 = System.nanoTime()
        if (trackingPoor) {
            return FrameTelemetry(
                FrameOutcome.SkippedTrackingPoor, -1.0, 0, 0.0, 0.0,
                msSince(t0),
            )
        }

        val cleaned = stripFileScheme(path)
        val srcRaw = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
        if (srcRaw.empty()) {
            return FrameTelemetry(
                FrameOutcome.SkippedTrackingPoor, -1.0, 0, 0.0, 0.0,
                msSince(t0),
            )
        }
        // V7: NO input rotation.  ARCore (and the JS gyro fallback)
        // deliver sensor-native landscape frames; we keep them in
        // that frame through the entire compute pipeline.  Output
        // rotation for display happens at snapshot/finalize time.
        // See iOS' equivalent fix for the architectural rationale.
        val frame = downsampleToCompose(srcRaw)
        if (frame !== srcRaw) srcRaw.release()

        // Build R_new from quaternion.
        val rNew = quaternionToRotationMat(qx, qy, qz, qw)

        if (!hasFirstFrame) {
            firstRotationArkit = rNew.clone()
            // V7: K is in COMPOSE pixel coordinates.  Sensor intrinsics
            // get scaled by the same uniform factor we used to downsample
            // the frame, so K · ray → pixel produces the right pixel
            // in compose space directly.  No rotation chain needed.
            val sx = frame.cols().toDouble() / maxOf(1, imageWidth)
            val sy = frame.rows().toDouble() / maxOf(1, imageHeight)
            val s = 0.5 * (sx + sy)
            kCompose = Mat(3, 3, CvType.CV_64F).apply {
                setTo(Scalar(0.0))
                put(0, 0, fx * s); put(0, 2, cx * s)
                put(1, 1, fy * s); put(1, 2, cy * s)
                put(2, 2, 1.0)
            }

            // Place first frame at canvas centre.
            val ox = (canvas.cols() - frame.cols()) / 2
            val oy = (canvas.rows() - frame.rows()) / 2
            val roi = Rect(ox, oy, frame.cols(), frame.rows())
            frame.copyTo(canvas.submat(roi))
            canvasMask.submat(roi).setTo(Scalar(255.0))
            tCanvas = Mat.eye(3, 3, CvType.CV_64F)
            tCanvas.put(0, 2, ox.toDouble())
            tCanvas.put(1, 2, oy.toDouble())

            lastAcceptedYaw = yaw
            lastAcceptedPitch = pitch
            hasFirstFrame = true
            acceptedCount = 1
            frame.release()
            return FrameTelemetry(
                FrameOutcome.AcceptedHigh, 0.0, 0, 0.0, 1.0, msSince(t0),
            )
        }

        val overlap = computeOverlapPct(
            yaw - lastAcceptedYaw, pitch - lastAcceptedPitch,
            fovHorizDegrees, fovVertDegrees,
        )
        if (overlap > MAX_OVERLAP_PCT) {
            frame.release()
            return FrameTelemetry(
                FrameOutcome.SkippedTooClose, overlap, 0, 0.0, 0.0, msSince(t0),
            )
        }
        if (overlap < MIN_OVERLAP_PCT) {
            frame.release()
            return FrameTelemetry(
                FrameOutcome.RejectedTooFar, overlap, 0, 0.0, 0.0, msSince(t0),
            )
        }

        // V7 pose-driven homography (sensor-native compose space):
        //   R_rel_cv = M · R_first⁻¹ · R_new · M
        //   H_compose = K_compose · R_rel_cv · K_compose⁻¹
        //   H_canvas = T_canvas · H_compose
        // No R2S/S chain — the v6 bug was applying input rotation
        // and undoing it via the chain; v7 keeps everything in
        // sensor-native compose space and rotates only at output.
        val firstInv = Mat()
        Core.transpose(firstRotationArkit, firstInv)
        val tmp1 = Mat(); Core.gemm(mArkitToCv, firstInv, 1.0, Mat(), 0.0, tmp1)
        val tmp2 = Mat(); Core.gemm(tmp1, rNew, 1.0, Mat(), 0.0, tmp2)
        val rRelCv = Mat(); Core.gemm(tmp2, mArkitToCv, 1.0, Mat(), 0.0, rRelCv)
        firstInv.release(); tmp1.release(); tmp2.release()

        val kInv = kCompose.inv()
        val hcTmp = Mat(); Core.gemm(kCompose, rRelCv, 1.0, Mat(), 0.0, hcTmp)
        val hCompose = Mat(); Core.gemm(hcTmp, kInv, 1.0, Mat(), 0.0, hCompose)
        kInv.release(); hcTmp.release(); rRelCv.release(); rNew.release()

        val hCanvas = Mat(); Core.gemm(tCanvas, hCompose, 1.0, Mat(), 0.0, hCanvas)
        hCompose.release()

        warpAndBlend(frame, hCanvas)
        hCanvas.release()
        frame.release()

        lastAcceptedYaw = yaw
        lastAcceptedPitch = pitch
        acceptedCount++

        // Confidence as in iOS — function of how centred the overlap
        // is in the [10, 75]% acceptance window.
        val midOverlap = 0.5 * (MIN_OVERLAP_PCT + MAX_OVERLAP_PCT)
        val overlapDistance = kotlin.math.abs(overlap - midOverlap) /
            (MAX_OVERLAP_PCT - midOverlap)
        val confidence = maxOf(0.0, 1.0 - overlapDistance)
        val outcome = if (confidence >= 0.6) FrameOutcome.AcceptedHigh
                      else FrameOutcome.AcceptedMedium

        return FrameTelemetry(
            outcome, overlap, -1, -1.0, confidence, msSince(t0),
        )
    }

    /** Write a JPEG snapshot if accept-counter has hit the configured cadence. */
    fun snapshotIfDue(tele: FrameTelemetry): WritableMap? {
        val isAccept = tele.outcome == FrameOutcome.AcceptedHigh
                    || tele.outcome == FrameOutcome.AcceptedMedium
        var snapshotPath: String? = null
        var snapW = 0
        var snapH = 0
        if (isAccept) {
            acceptsSinceSnapshot++
            if (acceptsSinceSnapshot >= snapshotEveryNAccepts) {
                acceptsSinceSnapshot = 0
                snapshotSeq++
                val slot = snapshotSeq % 4
                val tmpPath = "${System.getProperty("java.io.tmpdir") ?: "/data/local/tmp"}" +
                              "/rlis-live-$slot.jpg"
                // tightCrop = true for live snapshots: the canvas is
                // 4800x2200, but most of it is empty until the pan
                // covers it.  Without a tight crop, every snapshot
                // was a ~24 MB JPEG that RN's <Image> couldn't keep
                // up with.  Tight-cropped snapshots are 50–500 KB.
                val snap = writeJpeg(tmpPath, snapshotJpegQuality, tightCrop = true)
                if (snap != null) {
                    snapshotPath = snap.panoramaPath
                    snapW = snap.width
                    snapH = snap.height
                }
            }
        }

        val map = Arguments.createMap().apply {
            putInt("width", snapW)
            putInt("height", snapH)
            putInt("acceptedCount", acceptedCount)
            putInt("outcome", tele.outcome.ordinal)
            putDouble("confidence", tele.confidence)
            putDouble("overlapPercent", tele.overlapPercent)
            putDouble("processingMs", tele.processingMs)
            if (snapshotPath != null) putString("panoramaPath", snapshotPath)
        }
        lastState = map
        return map
    }

    fun finalize(outputPath: String, quality: Int): StitcherSnapshot {
        val cleaned = stripFileScheme(outputPath)
        val snap = writeJpeg(cleaned, quality, tightCrop = true)
            ?: throw IllegalStateException(
                "No frames have been accepted yet, or write failed: $cleaned",
            )
        release()
        return snap
    }

    fun release() {
        canvas.release()
        canvasMask.release()
        firstRotationArkit.release()
        kCompose.release()
        tCanvas.release()
        mArkitToCv.release()
    }

    // ── internal helpers ────────────────────────────────────────────

    private fun downsampleToCompose(src: Mat): Mat {
        // Uniform scale that fits inside the compose-dim budget — the
        // smaller of the two ratios wins so neither axis distorts.
        val sw = src.cols().toDouble()
        val sh = src.rows().toDouble()
        var scale = minOf(composeWidth.toDouble() / sw, composeHeight.toDouble() / sh)
        if (scale > 1.0) scale = 1.0  // never upscale
        val outW = maxOf(1, (sw * scale).toInt())
        val outH = maxOf(1, (sh * scale).toInt())
        if (src.cols() == outW && src.rows() == outH) return src
        val out = Mat()
        Imgproc.resize(src, out, Size(outW.toDouble(), outH.toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)
        return out
    }

    // `placeFirstFrame` was dropped in v6 — the first-frame logic is
    // now inlined in `addFrameAtPath` so the engine can capture the
    // reference pose + intrinsics in the same place it positions the
    // frame on the canvas.

    private fun warpAndBlend(frame: Mat, worldH: Mat) {
        val canvasSize = Size(canvasWidth.toDouble(), canvasHeight.toDouble())

        val warped = Mat()
        Imgproc.warpPerspective(
            frame, warped, worldH, canvasSize,
            Imgproc.INTER_LINEAR, Core.BORDER_CONSTANT, Scalar(0.0, 0.0, 0.0),
        )

        val frameOnesMask = Mat(frame.rows(), frame.cols(), CvType.CV_8UC1, Scalar(255.0))
        val warpedMask = Mat()
        Imgproc.warpPerspective(
            frameOnesMask, warpedMask, worldH, canvasSize,
            Imgproc.INTER_NEAREST, Core.BORDER_CONSTANT, Scalar(0.0),
        )
        frameOnesMask.release()

        // Hard midline seam (replaces v4 ratio-feather).  Same fix
        // as iOS v5: each output pixel comes from exactly one frame,
        // so misalignment between frames can't produce ghosts.  The
        // seam is placed where each pixel is equidistant from both
        // frames' outer edges (the "middle" of the overlap), then
        // softened with a small Gaussian to hide the pixel-perfect
        // cut.
        val distNew = Mat()
        Imgproc.distanceTransform(warpedMask, distNew, Imgproc.DIST_L2, 3)
        val distCanvas = Mat()
        Imgproc.distanceTransform(canvasMask, distCanvas, Imgproc.DIST_L2, 3)

        // alpha8: 255 where new is deeper, 0 where canvas is deeper.
        val alpha8 = Mat()
        Core.compare(distNew, distCanvas, alpha8, Core.CMP_GE)

        // First-touch regions need new frame to write unconditionally.
        val noPriorMask = Mat()
        Core.compare(canvasMask, Scalar(0.0), noPriorMask, Core.CMP_EQ)
        alpha8.setTo(Scalar(255.0), noPriorMask)
        noPriorMask.release()

        val alpha = Mat()
        alpha8.convertTo(alpha, CvType.CV_32F, 1.0 / 255.0)
        alpha8.release()
        Imgproc.GaussianBlur(alpha, alpha, Size(7.0, 7.0), 0.0)
        distNew.release(); distCanvas.release()

        val alphaChannels = mutableListOf(alpha, alpha, alpha)
        val alpha3 = Mat()
        Core.merge(alphaChannels, alpha3)
        val invAlpha3 = Mat()
        Core.subtract(Mat.ones(alpha3.size(), alpha3.type()).apply {
            setTo(Scalar(1.0, 1.0, 1.0))
        }, alpha3, invAlpha3)

        val warpedF = Mat(); warped.convertTo(warpedF, CvType.CV_32FC3)
        val canvasF = Mat(); canvas.convertTo(canvasF, CvType.CV_32FC3)
        val blendedF = Mat()
        Core.multiply(warpedF, alpha3, warpedF)
        Core.multiply(canvasF, invAlpha3, canvasF)
        Core.add(warpedF, canvasF, blendedF)
        warpedF.release(); canvasF.release()
        alpha.release(); alpha3.release(); invAlpha3.release()

        val blended8 = Mat()
        blendedF.convertTo(blended8, CvType.CV_8UC3)
        blendedF.release()
        // Only write where warpedMask is set; rest of canvas is unchanged.
        blended8.copyTo(canvas, warpedMask)
        blended8.release()

        Core.bitwise_or(canvasMask, warpedMask, canvasMask)
        warpedMask.release()
        warped.release()
    }

    private fun writeJpeg(
        outputPath: String,
        quality: Int,
        tightCrop: Boolean,
    ): StitcherSnapshot? {
        if (acceptedCount == 0) return null
        var crop = Rect(0, 0, canvas.cols(), canvas.rows())
        if (tightCrop) {
            val nonZero = MatOfPoint2f()
            // boundingRect on the mask matrix gives us the tight crop;
            // OpenCV Java's API takes a Mat of points, but for an
            // image mask we use Imgproc.boundingRect on a contour.
            // Cheaper path: walk the mask once.
            val contoured = Imgproc.boundingRect(MaskNonZeroContour(canvasMask))
            if (contoured.width > 0 && contoured.height > 0) {
                crop = contoured
            }
            nonZero.release()
        }
        val cropped = Mat(canvas, crop)
        // V7.1 GRAVITY-DERIVED OUTPUT ROTATION.  Mirrors iOS — see
        // OpenCVIncrementalStitcher.mm for the full derivation.  The
        // rotation comes from the AR pose (which knows gravity) so
        // we don't need a device-orientation hook (which was the
        // source of the v7 "sideways for landscape" bug).
        var rotationDeg = 0
        if (hasFirstFrame && !firstRotationArkit.empty()) {
            val gravWorld = Mat(3, 1, CvType.CV_64F).apply {
                put(0, 0, 0.0); put(1, 0, -1.0); put(2, 0, 0.0)
            }
            val firstT = Mat()
            Core.transpose(firstRotationArkit, firstT)
            val gravArkit = Mat(); Core.gemm(firstT, gravWorld, 1.0, Mat(), 0.0, gravArkit)
            val gravCv = Mat(); Core.gemm(mArkitToCv, gravArkit, 1.0, Mat(), 0.0, gravCv)
            val gx = gravCv.get(0, 0)[0]
            val gy = gravCv.get(1, 0)[0]
            val angle = kotlin.math.atan2(gx, gy) * 180.0 / Math.PI
            rotationDeg = (kotlin.math.round(angle / 90.0).toInt()) * 90
            rotationDeg = ((rotationDeg % 360) + 360) % 360
            gravWorld.release(); firstT.release(); gravArkit.release(); gravCv.release()
        }
        val out = when (rotationDeg) {
            90  -> Mat().also { Core.rotate(cropped, it, Core.ROTATE_90_CLOCKWISE) }
            180 -> Mat().also { Core.rotate(cropped, it, Core.ROTATE_180) }
            270 -> Mat().also { Core.rotate(cropped, it, Core.ROTATE_90_COUNTERCLOCKWISE) }
            else -> cropped
        }
        val outW = out.cols()
        val outH = out.rows()
        val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, quality)
        val ok = Imgcodecs.imwrite(outputPath, out, params)
        if (out !== cropped) out.release()
        cropped.release()
        if (!ok) return null
        return StitcherSnapshot(
            panoramaPath = outputPath,
            width = outW,
            height = outH,
            acceptedCount = acceptedCount,
        )
    }

    private fun msSince(t0Nanos: Long): Double =
        (System.nanoTime() - t0Nanos) / 1_000_000.0

    companion object {
        // v3 thresholds — relaxed match-count + inlier minimums for
        // light-texture shelf scenes; tighter det range because the
        // affine fit produces a much narrower legitimate scale band.
        private const val MIN_OVERLAP_PCT = 10.0
        private const val MAX_OVERLAP_PCT = 75.0
        private const val MIN_MATCHES_ACCEPT = 10
        private const val MIN_INLIER_RATIO_ACCEPT = 0.18
        private const val HIGH_CONF_MATCHES = 60
        private const val HIGH_CONF_INLIER_RATIO = 0.55
        private const val ORB_MAX_FEATURES = 1000
        private const val ORB_SCALE_FACTOR = 1.2f
        private const val ORB_LEVELS = 8
        private const val ORB_EDGE_THRESHOLD = 31
        private const val LOWE_RATIO = 0.75f
        private const val RANSAC_REPROJ_THRESH = 5.0
        private const val HOM_DET_MIN = 0.7
        private const val HOM_DET_MAX = 1.4
    }
}


/// Helper for OpenCV's odd boundingRect signature on a binary mask.
/// Wraps the mask's non-zero pixel coords as a MatOfPoint that
/// `Imgproc.boundingRect` will accept.
private fun MaskNonZeroContour(mask: Mat): org.opencv.core.MatOfPoint {
    val locations = Mat()
    Core.findNonZero(mask, locations)
    if (locations.empty()) {
        locations.release()
        return org.opencv.core.MatOfPoint()
    }
    val pts = mutableListOf<Point>()
    // findNonZero returns CV_32SC2 with N rows, 1 col.  Each entry is
    // a (col, row) pair; build a point list for boundingRect.
    val n = locations.rows()
    val buf = IntArray(2)
    for (i in 0 until n) {
        locations.get(i, 0, buf)
        pts.add(Point(buf[0].toDouble(), buf[1].toDouble()))
    }
    locations.release()
    val out = org.opencv.core.MatOfPoint()
    out.fromList(pts)
    return out
}


// computeOverlapPct, stripFileScheme — same code as iOS's static helpers,
// transcribed to Kotlin.

internal fun computeOverlapPct(
    deltaYaw: Double,
    deltaPitch: Double,
    fovHorizDegrees: Double,
    fovVertDegrees: Double,
): Double {
    val absYaw = kotlin.math.abs(deltaYaw)
    val absPitch = kotlin.math.abs(deltaPitch)
    var fovH = fovHorizDegrees * Math.PI / 180.0
    var fovV = fovVertDegrees * Math.PI / 180.0
    if (fovH <= 1e-6) fovH = 65.0 * Math.PI / 180.0
    if (fovV <= 1e-6) fovV = 50.0 * Math.PI / 180.0
    val overlap = if (absYaw >= absPitch) {
        1.0 - absYaw / fovH
    } else {
        1.0 - absPitch / fovV
    }
    return overlap.coerceIn(0.0, 1.0) * 100.0
}


internal fun stripFileScheme(path: String): String =
    if (path.startsWith("file://")) path.removePrefix("file://") else path


/// Quaternion → 3x3 rotation matrix, mirroring iOS `quaternionToRotationMat`.
internal fun quaternionToRotationMat(qx0: Double, qy0: Double, qz0: Double, qw0: Double): Mat {
    var qx = qx0; var qy = qy0; var qz = qz0; var qw = qw0
    val n = kotlin.math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw)
    if (n > 1e-9) { qx /= n; qy /= n; qz /= n; qw /= n }
    val r = Mat(3, 3, CvType.CV_64F)
    r.put(0, 0, 1 - 2*(qy*qy + qz*qz)); r.put(0, 1, 2*(qx*qy - qw*qz));     r.put(0, 2, 2*(qx*qz + qw*qy))
    r.put(1, 0, 2*(qx*qy + qw*qz));     r.put(1, 1, 1 - 2*(qx*qx + qz*qz)); r.put(1, 2, 2*(qy*qz - qw*qx))
    r.put(2, 0, 2*(qx*qz - qw*qy));     r.put(2, 1, 2*(qy*qz + qw*qx));     r.put(2, 2, 1 - 2*(qx*qx + qy*qy))
    return r
}


// `sensorRotationMatrix` was removed in V7 — the rotation chain it
// powered is no longer in the homography path.  See iOS' equivalent.
