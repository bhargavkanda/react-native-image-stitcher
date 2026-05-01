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

    private var engine: IncrementalEngine? = null
    private val isRunning = AtomicBoolean(false)
    private val workScope = CoroutineScope(Dispatchers.Default)

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
            engine = IncrementalEngine(
                composeWidth  = options.getIntOrDefault("composeWidth",  1280),
                composeHeight = options.getIntOrDefault("composeHeight", 720),
                canvasWidth   = options.getIntOrDefault("canvasWidth",   4800),
                canvasHeight  = options.getIntOrDefault("canvasHeight",  1600),
                featherPx     = options.getIntOrDefault("featherPx",     20),
                snapshotJpegQuality = options.getIntOrDefault("snapshotJpegQuality", 75),
                snapshotEveryNAccepts = options.getIntOrDefault("snapshotEveryNAccepts", 1),
            )
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
        val engine = this.engine
            ?: return promise.reject(
                "incremental-not-running",
                "Call start() before processFrameAtPath().",
            )
        val path = options.getString("path")
            ?: return promise.reject("invalid-options", "path required")
        val yaw = options.getDoubleOrDefault("yaw", 0.0)
        val pitch = options.getDoubleOrDefault("pitch", 0.0)
        val fov = options.getDoubleOrDefault("fovHorizDegrees", 65.0)
        val trackingPoor = options.getBooleanOrDefault("trackingPoor", false)

        workScope.launch {
            try {
                val telemetry = engine.addFrameAtPath(
                    path = path,
                    yaw = yaw,
                    pitch = pitch,
                    fovHorizDegrees = fov,
                    trackingPoor = trackingPoor,
                )
                val state = engine.snapshotIfDue(telemetry)
                emitState(state)
                val result = Arguments.createMap()
                result.putInt("outcome", telemetry.outcome.ordinal)
                result.putDouble("confidence", telemetry.confidence)
                result.putDouble("overlapPercent", telemetry.overlapPercent)
                result.putDouble("processingMs", telemetry.processingMs)
                result.putInt("acceptedCount", engine.acceptedCount)
                promise.resolve(result)
            } catch (t: Throwable) {
                promise.reject("incremental-process-failed", t.message, t)
            }
        }
    }

    @ReactMethod
    fun finalize(options: ReadableMap, promise: Promise) {
        val engine = this.engine
            ?: return promise.reject(
                "incremental-not-running",
                "No active capture — call start() first.",
            )
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

        workScope.launch {
            try {
                val snap = engine.finalize(outputPath, quality)
                this@RetaiLensIncrementalStitcher.engine = null
                isRunning.set(false)
                val map = Arguments.createMap()
                map.putString("panoramaPath", snap.panoramaPath)
                map.putInt("width", snap.width)
                map.putInt("height", snap.height)
                map.putInt("acceptedCount", snap.acceptedCount)
                map.putInt("droppedBackpressure", 0)
                promise.resolve(map)
            } catch (t: Throwable) {
                this@RetaiLensIncrementalStitcher.engine = null
                isRunning.set(false)
                promise.reject("incremental-finalize-failed", t.message, t)
            }
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        arCameraViewRef?.setIncrementalIngestionActive(false)
        engine?.release()
        engine = null
        isRunning.set(false)
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
        yaw: Double,
        pitch: Double,
        fovHorizDegrees: Double,
        trackingPoor: Boolean,
    ) {
        val engine = this.engine ?: return
        workScope.launch {
            val tele = engine.addFrameAtPath(
                path = path,
                yaw = yaw,
                pitch = pitch,
                fovHorizDegrees = fovHorizDegrees,
                trackingPoor = trackingPoor,
            )
            val state = engine.snapshotIfDue(tele)
            emitState(state)
        }
    }

    @ReactMethod
    fun getState(promise: Promise) {
        val state = engine?.lastState
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
) {
    private val canvas: Mat = Mat.zeros(canvasHeight, canvasWidth, CvType.CV_8UC3)
    private val canvasMask: Mat = Mat.zeros(canvasHeight, canvasWidth, CvType.CV_8UC1)
    private var lastKeypoints: MatOfKeyPoint = MatOfKeyPoint()
    private var lastDescriptors: Mat = Mat()
    private var lastFrameToWorld: Mat = Mat.eye(3, 3, CvType.CV_64F)
    private var lastAcceptedYaw: Double = 0.0
    private var lastAcceptedPitch: Double = 0.0
    private var hasFirstFrame: Boolean = false
    private var acceptsSinceSnapshot: Int = 0
    var acceptedCount: Int = 0
        private set
    var lastState: WritableMap? = null
        private set

    private val orb: ORB = ORB.create(
        ORB_MAX_FEATURES,
        ORB_SCALE_FACTOR,
        ORB_LEVELS,
        ORB_EDGE_THRESHOLD,
        0,                  // firstLevel
        2,                  // WTA_K
        ORB.HARRIS_SCORE,
        31,                 // patchSize
        20,                 // fastThreshold
    )
    private val matcher: BFMatcher = BFMatcher.create(Core.NORM_HAMMING, false)

    /**
     * Read the JPEG at `path`, downscale to compose-resolution, run
     * the same algorithm as the iOS engine.
     */
    fun addFrameAtPath(
        path: String,
        yaw: Double,
        pitch: Double,
        fovHorizDegrees: Double,
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
        val frame = downsampleToCompose(srcRaw)
        srcRaw.release()

        if (!hasFirstFrame) {
            placeFirstFrame(frame)
            lastAcceptedYaw = yaw
            lastAcceptedPitch = pitch
            hasFirstFrame = true
            acceptedCount = 1
            return FrameTelemetry(
                FrameOutcome.AcceptedHigh, 0.0, 0, 0.0, 1.0, msSince(t0),
            )
        }

        val overlap = computeOverlapPct(
            yaw - lastAcceptedYaw, pitch - lastAcceptedPitch,
            fovHorizDegrees, composeWidth.toDouble() / composeHeight.toDouble(),
        )
        if (overlap > MAX_OVERLAP_PCT) {
            return FrameTelemetry(
                FrameOutcome.SkippedTooClose, overlap, 0, 0.0, 0.0, msSince(t0),
            )
        }
        if (overlap < MIN_OVERLAP_PCT) {
            return FrameTelemetry(
                FrameOutcome.RejectedTooFar, overlap, 0, 0.0, 0.0, msSince(t0),
            )
        }

        val gray = Mat()
        Imgproc.cvtColor(frame, gray, Imgproc.COLOR_BGR2GRAY)
        val kpts = MatOfKeyPoint()
        val descs = Mat()
        orb.detectAndCompute(gray, Mat(), kpts, descs)
        gray.release()
        if (descs.empty() || kpts.toArray().size < 4) {
            return FrameTelemetry(
                FrameOutcome.RejectedSceneUniform, overlap, 0, 0.0, 0.0,
                msSince(t0),
            )
        }

        // knnMatch + Lowe's ratio test.
        val knnMatches = mutableListOf<MatOfDMatch>()
        matcher.knnMatch(descs, lastDescriptors, knnMatches, 2)
        val good = mutableListOf<DMatch>()
        for (pair in knnMatches) {
            val arr = pair.toArray()
            if (arr.size < 2) continue
            if (arr[0].distance < LOWE_RATIO * arr[1].distance) {
                good.add(arr[0])
            }
        }
        if (good.size < MIN_MATCHES_ACCEPT) {
            return FrameTelemetry(
                FrameOutcome.RejectedSceneUniform, overlap, good.size, 0.0, 0.0,
                msSince(t0),
            )
        }

        val srcPts = mutableListOf<Point>()
        val dstPts = mutableListOf<Point>()
        val newKpArr = kpts.toArray()
        val lastKpArr = lastKeypoints.toArray()
        for (m in good) {
            srcPts.add(newKpArr[m.queryIdx].pt)
            dstPts.add(lastKpArr[m.trainIdx].pt)
        }
        val srcMof = MatOfPoint2f(); srcMof.fromList(srcPts)
        val dstMof = MatOfPoint2f(); dstMof.fromList(dstPts)
        val ransacMask = Mat()
        val hNewToLast = Calib3d.findHomography(
            srcMof, dstMof, Calib3d.RANSAC, RANSAC_REPROJ_THRESH, ransacMask,
        )
        srcMof.release(); dstMof.release()
        if (hNewToLast.empty()) {
            ransacMask.release()
            return FrameTelemetry(
                FrameOutcome.RejectedAlignmentLost, overlap, good.size, 0.0, 0.0,
                msSince(t0),
            )
        }

        val inliers = Core.countNonZero(ransacMask)
        ransacMask.release()
        val inlierRatio = inliers.toDouble() / good.size.toDouble()
        if (inliers < MIN_MATCHES_ACCEPT || inlierRatio < MIN_INLIER_RATIO_ACCEPT) {
            return FrameTelemetry(
                FrameOutcome.RejectedAlignmentLost, overlap, good.size, inlierRatio, 0.0,
                msSince(t0),
            )
        }

        val det = Core.determinant(hNewToLast.submat(0, 2, 0, 2))
        if (det < HOM_DET_MIN || det > HOM_DET_MAX) {
            return FrameTelemetry(
                FrameOutcome.RejectedAlignmentLost, overlap, good.size, inlierRatio, 0.0,
                msSince(t0),
            )
        }

        val newFrameToWorld = Mat()
        Core.gemm(lastFrameToWorld, hNewToLast, 1.0, Mat(), 0.0, newFrameToWorld)
        warpAndBlend(frame, newFrameToWorld)

        // Update state.
        lastFrameToWorld.release()
        lastFrameToWorld = newFrameToWorld
        lastKeypoints.release()
        lastKeypoints = kpts
        lastDescriptors.release()
        lastDescriptors = descs
        lastAcceptedYaw = yaw
        lastAcceptedPitch = pitch
        acceptedCount++

        val matchScore = minOf(1.0, good.size / HIGH_CONF_MATCHES.toDouble())
        val inlierScore = minOf(1.0, inlierRatio / HIGH_CONF_INLIER_RATIO)
        val confidence = 0.6 * inlierScore + 0.4 * matchScore
        val outcome = if (confidence >= 0.8) FrameOutcome.AcceptedHigh
                      else FrameOutcome.AcceptedMedium

        frame.release()
        return FrameTelemetry(
            outcome, overlap, good.size, inlierRatio, confidence, msSince(t0),
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
                val tmpPath = "${System.getProperty("java.io.tmpdir") ?: "/data/local/tmp"}" +
                              "/rlis-live-snapshot.jpg"
                val snap = writeJpeg(tmpPath, snapshotJpegQuality, tightCrop = false)
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
        lastKeypoints.release()
        lastDescriptors.release()
        lastFrameToWorld.release()
    }

    // ── internal helpers ────────────────────────────────────────────

    private fun downsampleToCompose(src: Mat): Mat {
        val target = Size(composeWidth.toDouble(), composeHeight.toDouble())
        if (src.cols() == composeWidth && src.rows() == composeHeight) {
            return src.clone()
        }
        val out = Mat()
        Imgproc.resize(src, out, target, 0.0, 0.0, Imgproc.INTER_AREA)
        return out
    }

    private fun placeFirstFrame(frame: Mat) {
        val ox = (canvasWidth - frame.cols()) / 2
        val oy = (canvasHeight - frame.rows()) / 2
        val roi = Rect(ox, oy, frame.cols(), frame.rows())
        frame.copyTo(canvas.submat(roi))
        canvasMask.submat(roi).setTo(Scalar(255.0))

        val h = Mat.eye(3, 3, CvType.CV_64F)
        h.put(0, 2, ox.toDouble())
        h.put(1, 2, oy.toDouble())
        lastFrameToWorld.release()
        lastFrameToWorld = h

        val gray = Mat()
        Imgproc.cvtColor(frame, gray, Imgproc.COLOR_BGR2GRAY)
        lastKeypoints.release()
        lastDescriptors.release()
        lastKeypoints = MatOfKeyPoint()
        lastDescriptors = Mat()
        orb.detectAndCompute(gray, Mat(), lastKeypoints, lastDescriptors)
        gray.release()
    }

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

        val dist = Mat()
        Imgproc.distanceTransform(warpedMask, dist, Imgproc.DIST_L2, 3)
        val alpha = Mat()
        dist.convertTo(alpha, CvType.CV_32F, 1.0 / featherPx.toDouble())
        Imgproc.threshold(alpha, alpha, 1.0, 1.0, Imgproc.THRESH_TRUNC)
        dist.release()

        // Force alpha=1 where canvas is empty so the new frame writes
        // directly without blending against zero.
        val noPriorMask = Mat()
        Core.compare(canvasMask, Scalar(0.0), noPriorMask, Core.CMP_EQ)
        alpha.setTo(Scalar(1.0), noPriorMask)
        noPriorMask.release()

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
        val out = Mat(canvas, crop)
        val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, quality)
        val ok = Imgcodecs.imwrite(outputPath, out, params)
        out.release()
        if (!ok) return null
        return StitcherSnapshot(
            panoramaPath = outputPath,
            width = crop.width,
            height = crop.height,
            acceptedCount = acceptedCount,
        )
    }

    private fun msSince(t0Nanos: Long): Double =
        (System.nanoTime() - t0Nanos) / 1_000_000.0

    companion object {
        private const val MIN_OVERLAP_PCT = 15.0
        private const val MAX_OVERLAP_PCT = 70.0
        private const val MIN_MATCHES_ACCEPT = 20
        private const val MIN_INLIER_RATIO_ACCEPT = 0.25
        private const val HIGH_CONF_MATCHES = 80
        private const val HIGH_CONF_INLIER_RATIO = 0.7
        private const val ORB_MAX_FEATURES = 1000
        private const val ORB_SCALE_FACTOR = 1.2f
        private const val ORB_LEVELS = 8
        private const val ORB_EDGE_THRESHOLD = 31
        private const val LOWE_RATIO = 0.75f
        private const val RANSAC_REPROJ_THRESH = 5.0
        private const val HOM_DET_MIN = 0.4
        private const val HOM_DET_MAX = 2.5
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
    frameAspect: Double,
): Double {
    val absYaw = kotlin.math.abs(deltaYaw)
    val absPitch = kotlin.math.abs(deltaPitch)
    var fovH = fovHorizDegrees * Math.PI / 180.0
    if (fovH <= 1e-6) fovH = 65.0 * Math.PI / 180.0
    val fovV = 2.0 * kotlin.math.atan(
        kotlin.math.tan(fovH / 2.0) / maxOf(frameAspect, 0.1),
    )
    val overlap = if (absYaw >= absPitch) {
        1.0 - absYaw / fovH
    } else {
        1.0 - absPitch / fovV
    }
    return overlap.coerceIn(0.0, 1.0) * 100.0
}


internal fun stripFileScheme(path: String): String =
    if (path.startsWith("file://")) path.removePrefix("file://") else path
