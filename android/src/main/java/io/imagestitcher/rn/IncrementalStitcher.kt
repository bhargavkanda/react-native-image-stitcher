// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.app.ActivityManager
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
import kotlinx.coroutines.SupervisorJob
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
import io.imagestitcher.rn.ar.YuvImageConverter
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android twin of iOS' OpenCVIncrementalStitcher + IncrementalStitcher.
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
 *   - finalize(options)     — write the final panorama and reset
 *   - cancel()              — abort without producing output
 *   - getState()            — pull the latest state on demand
 *   - refinePanorama()      — re-run the C++ stitcher over saved keyframes
 *   - cleanupKeyframes()    — GC stale per-capture keyframe directories
 *   - Event "IncrementalStateUpdate" emitted on every accepted frame
 *
 * How frames reach the engine (no JS-driven path post-v0.6):
 *   - AR mode: `RNSARCameraView` calls `ingestFromARCameraView(...)`
 *     once per ARCore Frame from its scene-update listener.
 *   - Non-AR mode: the vision-camera Frame Processor plugin
 *     (`CvFlowGateFrameProcessor`) calls `consumeFrameFromPlugin(...)`
 *     on the producer thread, gated by `frameProcessorIngestEnabled`.
 *   The pre-v0.6 `processFrameAtPath` JS-driver entry point is gone.
 */
class IncrementalStitcher(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    // F8.4 note: the static singleton accessor for cross-thread
    // lookup (used by `CvFlowGateFrameProcessor` running on vision-
    // camera's producer thread) is the existing `bridgeInstance`
    // companion field below — same pattern that `RNSARCameraView`
    // uses to call back into the bridge.  No new companion object
    // needed.

    override fun getName(): String = "IncrementalStitcher"

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

    // ── V16 batch-keyframe mode (Android parity with iOS' V16 Phase 1) ─
    //
    // Selected for engineMode == 'batch-keyframe'.  No live engine
    // runs — instead, accepted frames are collected as keyframe paths,
    // and at finalize() time we hand them all to the JNI shim
    // (libimage_stitcher.so) for one-shot cv::Stitcher processing.
    //
    // The MVP gate is frame-count-based ("accept every Nth frame
    // until cap").  iOS uses a pose-based gate (overlap < threshold)
    // — adding that here is a follow-up that needs ARCore-pose
    // accumulation across `ingestFromARCameraView` calls.  For now,
    // every N-th frame is good enough to validate end-to-end
    // stitching parity.
    private var batchKeyframeMode: Boolean = false
    private val batchKeyframePaths: MutableList<String> = mutableListOf()
    private var batchKeyframeFrameCounter: Int = 0
    /// V16 Phase 2 (Android Fix-1) — per-capture-session subdirectory
    /// under `cacheDir` where this capture's batch-keyframe JPEGs are
    /// written.  Created on each batch-keyframe `start()` with a fresh
    /// UUID.
    ///
    /// Why:
    ///   The V16 Phase-1 MVP wrote every accepted keyframe to
    ///   `cacheDir/rlis-keyframe-{N}.jpg` where N restarted at 0 on
    ///   each capture.  Two captures in a row → second capture's
    ///   `rlis-keyframe-0.jpg` overwrites the first's.  Worse, RN's
    ///   `<Image>` component on Android caches decoded bitmaps keyed
    ///   by URI string; the file:// URI was byte-identical across
    ///   captures, so the previous capture's bitmap got served for
    ///   the new capture's first thumbnail — Ram's "thumbnails come
    ///   from the previous capture" symptom (2026-05-12).  Also a
    ///   data-integrity hazard if a new capture starts while the
    ///   previous one's stitcher is still reading the JPEGs from
    ///   disk.
    ///
    /// Per-session UUID subdir fixes both:
    ///   - Each capture's keyframes live at a unique path → no URI
    ///     collision → no bitmap-cache reuse across captures.
    ///   - Files survive past finalize for post-hoc reprocessing
    ///     (Ram's request — same behaviour as iOS' OpenCVKeyframeCollector).
    ///
    /// Lifetime:
    ///   • Created in `start()` batch-keyframe branch.
    ///   • Used by `copyKeyframeToStore()`.
    ///   • Persists past `finalize()` for reprocessing.
    ///   • Cleaned up on `cancel()` and in `onCatalystInstanceDestroy()`.
    ///
    /// Parity: matches iOS `OpenCVKeyframeCollector.sessionDir`
    /// (created with `Library/AppSupport/Captures/{NSUUID}/`).
    private var captureSessionDir: java.io.File? = null
    /// Accept every Nth frame.  10 is the iOS default capture cadence
    /// (5-6 keyframes over a ~2-3 second pan = roughly one every 10
    /// frames at 30fps).
    private var batchKeyframeAcceptStride: Int = 10
    /// Hard cap on keyframes to match iOS' default (V16 Phase 1's
    /// keyframeMaxCount=6).  Going higher inflates cv::Stitcher's
    /// MultiBandBlender memory; iOS hit OOM at 7+ on some scenes.
    private var batchKeyframeMaxCount: Int = 6
    /// Batch knobs threaded through to nativeStitchFramePaths at
    /// finalize.  Mirror iOS' batchWarperType / batchBlenderType /
    /// batchSeamFinderType / batchEnableInscribedRectCrop ivars.
    private var batchWarperType: String = "plane"
    private var batchBlenderType: String = "multiband"
    private var batchSeamFinderType: String = "graphcut"
    private var batchUseInscribedRectCrop: Boolean = false
    /// Capture orientation at start time.  Drives the bake-rotation
    /// table inside the JNI shim.  Sourced from configOverrides
    /// (passed from JS), falling back to "portrait".
    private var batchCaptureOrientation: String = "portrait"

    // ── 2026-05-14: cv::Stitcher pipeline-mode auto-routing ──────────
    //
    // `batchStitchMode` is the JS-supplied setting from
    // PanoramaSettings.stitchMode.  Three valid values:
    //   'auto' (default) — at finalize() time, compute translation/
    //                      rotation totals from the first and last
    //                      accepted keyframe pose, pick PANORAMA or
    //                      SCANS by the design-doc 0.55 threshold.
    //   'panorama'       — force cv::Stitcher::PANORAMA mode at JNI.
    //   'scans'          — force cv::Stitcher::SCANS mode at JNI.
    //
    // batchFirstAcceptedPose / batchLastAcceptedPose are populated by
    // ingestFromARCameraView() on every accepted keyframe.  Cleared
    // at start() and consumed at finalize().  They store (tx, ty, tz,
    // qx, qy, qz, qw) — same shape as `KeyframeGate`'s internal
    // last-accepted-pose tracker, but kept locally so we don't have
    // to wire a new accessor through the C++ bridge.
    private var batchStitchMode: String = "auto"
    private var batchFirstAcceptedPose: DoubleArray? = null
    private var batchLastAcceptedPose: DoubleArray? = null

    /// V16 Phase 1 / P3-F — shared-C++ KeyframeGate.  Replaces the
    /// V16-Phase-1 frame-counter MVP placeholder
    /// (handleBatchKeyframeFrame above) with the same pose-driven
    /// 40%-new-content algorithm iOS has used since the V16 ship.
    /// Both platforms call into retailens::KeyframeGate (in
    /// react-native-image-stitcher/cpp/keyframe_gate.cpp) — see that file
    /// for the algorithm.
    ///
    /// Lifetime: owned for the life of the module.  Closed in
    /// `onCatalystInstanceDestroy()` to release the C++ heap
    /// allocation.  `reset()` is called between captures.
    private val keyframeGate = KeyframeGate()

    /// P3-G diagnostic — rate-limit the per-frame log in
    /// ingestFromARCameraView so we don't spam logcat at 60Hz but
    /// still see the "0 frames captured" mystery resolve to a
    /// specific failure mode.
    private var frameIngestLogTick: Int = 0

    /// 2026-05-22 (audit F5) — Frame counter for the flowEvalEveryNFrames
    /// throttle.  Incremented on every per-frame entry point
    /// (`ingestFromARCameraView` for AR mode, `consumeFrameFromPlugin`
    /// for non-AR Frame Processor mode); gate evaluation only runs when
    /// (counter - 1) % evalCadence == 0 so frame #1 always evaluates
    /// regardless of cadence.  iOS parity:
    /// IncrementalStitcher.swift:2459-2471 (`consumeFrameCounter`).
    /// Reset to 0 on each `start()` call.
    private var consumeFrameCounter: Long = 0L

    private val isRunning = AtomicBoolean(false)

    /// F8.4 — gate for `consumeFrameFromPlugin` (the vision-camera
    /// Frame Processor producer-thread entry point on Android).
    /// TRUE only when the current capture was started with
    /// `frameSourceMode == "frameProcessor"`.  In AR mode
    /// (`frameSourceMode == "arSession"`) the plugin would double-feed
    /// the engine alongside `ingestFromARCameraView` — bytes from the
    /// producer thread + bytes from the ARCore Frame listener, racing
    /// on the same workScope serial dispatcher — so we drop the
    /// producer-thread call.
    ///
    /// AtomicBoolean: producer thread reads lock-free, JS thread
    /// (start/cancel/finalize) writes via `set()`/`compareAndSet()`.
    /// Mirror of iOS' `frameProcessorIngestEnabled` ivar.
    private val frameProcessorIngestEnabled = AtomicBoolean(false)
    /// Critic #5 fix: serial dispatcher so concurrent per-frame
    /// ingest calls (today: `ingestFromARCameraView` in AR mode,
    /// `consumeFrameFromPlugin` in frame-processor mode) can't race
    /// on the engine's canvas.  `limitedParallelism(1)` guarantees
    /// one-at-a-time execution while still backing onto the Default
    /// pool — matches iOS' `workQueue` (DispatchQueue.serial).
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val workScope = CoroutineScope(Dispatchers.Default.limitedParallelism(1))

    /// 2026-05-16 — realtime+batch fusion (Option A "Replace on
    /// completion") scope.  Kept SEPARATE from `workScope` so the
    /// 2-5 s `cv::Stitcher` refinement run that follows a hybrid-
    /// engine finalize() does NOT delay a new start()/processFrame()
    /// that the operator may issue while the refinement is in flight.
    /// The design doc explicitly calls out "operator can continue
    /// browsing / starting another capture during refinement".
    ///
    /// Serial: at most one refinement runs at a time (the design's
    /// "cancellation semantics if a new capture starts mid-refine"
    /// is out of scope for this MVP).
    ///
    /// 2026-05-16 (Phase 3 critic MED-1) — `SupervisorJob()` keeps
    /// the scope alive when a single refinement coroutine fails.
    /// Every `refineScope.launch { … }` already has a try/catch
    /// around the throwing surface; SupervisorJob is defense-in-
    /// depth for future code added outside that catch.
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val refineScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Default.limitedParallelism(1)
    )

    /// Reference to a mounted ARCameraView (if any).  Set by the view
    /// when it attaches; the engine flips its `ingestActive` flag
    /// on start/stop so the view feeds frames only during a capture.
    @Volatile private var arCameraViewRef: RNSARCameraView? = null

    init {
        // Static back-pointer so `RNSARCameraView` can call into
        // the singleton-style bridge module without a DI dance.  RN
        // may rebuild module instances across reloads; the view always
        // uses the latest reference.
        bridgeInstance = this
    }

    /// View calls this on attach so the engine can route ingestion
    /// without searching the view tree on every frame.
    internal fun bindArCameraView(view: RNSARCameraView) {
        arCameraViewRef = view
        // If a capture is already running when the view mounts, hot-
        // engage ingestion so the user gets a partial panorama
        // started from this point onward.
        if (isRunning.get()) {
            view.setIncrementalIngestionActive(true)
        }
    }

    internal fun unbindArCameraView(view: RNSARCameraView) {
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
            // F8.4 — frameSourceMode honoured on Android.  Pre-F8.4,
            // Android ignored this option (only iOS interpreted it).
            // Now `"frameProcessor"` unlocks `consumeFrameFromPlugin`'s
            // producer-thread ingest path; `"arSession"` (the default)
            // keeps it dormant so the ARCore-driven
            // `ingestFromARCameraView` path runs unmodified.
            // Default to "arSession" for parity with iOS — pre-v0.6 this
            // defaulted to "jsDriver", but that mode (the JS-driver
            // processFrameAtPath path) was removed in v0.6.  Raw
            // NativeModules callers that omit `frameSourceMode` get the
            // AR-mode behaviour (the production <Camera> always sets
            // 'arSession' explicitly for AR captures anyway).
            val frameSourceMode = options.getString("frameSourceMode") ?: "arSession"
            frameProcessorIngestEnabled.set(frameSourceMode == "frameProcessor")
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
            // V16 added 'batch-keyframe' as a fifth variant: no live
            // engine, frames are saved as JPEGs and handed to
            // cv::Stitcher (via the JNI shim) at finalize.
            val engineMode = options.getString("engine") ?: "hybrid"
            // 2026-05-15 — Route 'slitscan*' engineModes to the same
            // IncrementalFirstwinsEngine that handles 'firstwins*'.
            // Per IncrementalFirstwinsEngine's docstring (lines 260,
            // 431, 436, 672, 957): "Mirrors iOS' OpenCVSlitScanStitcher.mm
            // exactly".  Before this change, 'slitscan' / 'slitscan-rotate'
            // / 'slitscan-both' engineModes fell through to IncrementalEngine
            // (the hybrid engine), producing identical output to picking
            // 'hybrid' — silent platform divergence vs iOS.
            //
            // iOS-parity reference: IncrementalStitcher.swift:556
            // computes `useFirstwinsClass = normalisedMode.hasPrefix("slitscan")`
            // which routes BOTH 'slitscan-rotate' AND 'slitscan-both' AND
            // the deprecated aliases to OpenCVFirstWinsCylindricalStitcher.
            // We mirror that logic here so Android Settings → Engine
            // dropdown actually toggles the underlying engine.
            val isFirstwinsClass =
                engineMode.startsWith("firstwins") ||
                engineMode.startsWith("slitscan")
            val isFirstwins = isFirstwinsClass    // legacy name kept
                                                  // for the remainder of
                                                  // start() — refactor to
                                                  // isFirstwinsClass when
                                                  // the engineMode taxonomy
                                                  // is rationalised.
            val useRectilinear =
                engineMode == "firstwins-rectilinear" ||
                engineMode == "slitscan-rotate"
            val isBatchKeyframe = engineMode == "batch-keyframe"

            val configOverrides: ReadableMap? =
                if (options.hasKey("config")) options.getMap("config") else null

            if (isBatchKeyframe) {
                // No live engine runs.  Reset the keyframe collector
                // state.  Read knobs from `config` per the V16 Phase
                // 1 plumbing pattern.
                engine = null
                firstwinsEngine = null
                batchKeyframeMode = true
                batchKeyframePaths.clear()
                batchKeyframeFrameCounter = 0
                // V16 Phase 2 (Android Fix-1) — fresh per-session subdir
                // for this capture's keyframe JPEGs.  Replaces the
                // V16-Phase-1 "rlis-keyframe-{N}.jpg in cacheDir"
                // scheme that caused thumbnails from a previous capture
                // to leak into the next one via RN's bitmap cache (see
                // `captureSessionDir` declaration above for the full
                // RCA).  Matches iOS' OpenCVKeyframeCollector behaviour.
                captureSessionDir = java.io.File(
                    reactContext.cacheDir,
                    "rlis-capture-${java.util.UUID.randomUUID()}",
                ).also { it.mkdirs() }
                batchKeyframeMaxCount = configOverrides
                    ?.getIntOrDefault("keyframeMaxCount", 6) ?: 6
                batchWarperType = configOverrides?.getString("warperType")
                    ?: "plane"
                batchBlenderType = configOverrides?.getString("blenderType")
                    ?: "multiband"
                batchSeamFinderType = configOverrides?.getString("seamFinderType")
                    ?: "graphcut"
                batchUseInscribedRectCrop = configOverrides
                    ?.getBooleanOrDefault("enableMaxInscribedRectCrop", false)
                    ?: false
                // 2026-05-14 — stitch-mode picker from JS Settings.
                // Default 'auto'.  Validated against the closed set
                // {auto, panorama, scans}; unknown values fall back
                // to 'auto'.  Reset accumulated-pose state for the
                // new capture so finalize() picks a fresh mode.
                batchStitchMode = (configOverrides?.getString("stitchMode") ?: "auto")
                    .let { if (it in setOf("auto", "panorama", "scans")) it else "auto" }
                batchFirstAcceptedPose = null
                batchLastAcceptedPose = null
                // captureOrientation is JS-supplied here (Android
                // doesn't yet have a native ARCore classifier
                // equivalent to iOS' nativeCaptureOrientation; the
                // JS hook is stale but at least it's directional).
                batchCaptureOrientation = options.getString("captureOrientation")
                    ?: "portrait"
                // P3-F — configure the shared-C++ KeyframeGate for
                // this capture.  Same knob set + defaults as iOS:
                //   overlapThreshold default 0.4 (40% new content)
                //   maxCount         default 6
                // Both clamped to safe ranges that iOS also uses (see
                // IncrementalStitcher.swift:608-615).
                val threshold = configOverrides
                    ?.getDoubleOrDefault("keyframeOverlapThreshold", 0.4) ?: 0.4
                keyframeGate.overlapThreshold = threshold.coerceIn(0.10, 0.80)
                keyframeGate.maxCount = batchKeyframeMaxCount.coerceIn(3, 10)

                // 2026-05-14 — thread flow-strategy tunables through to the
                // shared C++ gate.  Before this commit the Android JNI was
                // missing setFlowNoveltyPercentile + setFlowMaxTranslationM
                // bindings (iOS-only via KeyframeGateBridge), which meant
                // operators flipping these in Settings only affected iOS
                // captures.  Now both platforms honour them.
                val pctile = configOverrides
                    ?.getDoubleOrDefault("flowNoveltyPercentile", 0.85) ?: 0.85
                keyframeGate.flowNoveltyPercentile = pctile.coerceIn(0.50, 0.99)
                // Settings UI exposes flowMaxTranslationCm in CENTIMETRES;
                // C++ API is in METRES.  Convert.  0 = disabled.
                val txBudgetCm = configOverrides
                    ?.getDoubleOrDefault("flowMaxTranslationCm", 0.0) ?: 0.0
                keyframeGate.flowMaxTranslationM = (txBudgetCm / 100.0).coerceAtLeast(0.0)
                // 2026-05-22 (audit F5) — flow-strategy Shi-Tomasi
                // tunables.  Pre-audit, Android had no JNI for these
                // (iOS-only via KeyframeGateBridge); JS Settings sliders
                // were silent no-ops.  Now both platforms honour them.
                // Clamp ranges match iOS (IncrementalStitcher.swift:907-924).
                val maxCorners = configOverrides
                    ?.getIntOrDefault("flowMaxCorners", 150) ?: 150
                keyframeGate.flowMaxCorners = maxCorners.coerceIn(50, 300)
                val quality = configOverrides
                    ?.getDoubleOrDefault("flowQualityLevel", 0.01) ?: 0.01
                keyframeGate.flowQualityLevel = quality.coerceIn(0.005, 0.05)
                val minDist = configOverrides
                    ?.getDoubleOrDefault("flowMinDistance", 10.0) ?: 10.0
                keyframeGate.flowMinDistance = minDist.coerceIn(1.0, 50.0)
                // Eval throttle: caller (this class) applies the cadence
                // at the per-frame call sites.  iOS parity at
                // IncrementalStitcher.swift:2459-2471.
                val evalCadence = configOverrides
                    ?.getIntOrDefault("flowEvalEveryNFrames", 1) ?: 1
                keyframeGate.flowEvalEveryNFrames = evalCadence.coerceIn(1, 10)

                // 2026-05-22 — non-AR mode opt-out for angular fallback.
                // captureSource = 'non-ar' means the host is using
                // vision-camera (no ARKit/ARCore pose).  Disable the gate's
                // angular fallback so it doesn't compute on garbage pose
                // (gyro drift accumulating into the integrated angle was
                // making the gate accept near-identical frames → degenerate
                // cv::Stitcher params → "warpRoi too large" crash).
                //
                // Audit fix: pre-v0.3 the check tested the legacy
                // 'wide'/'ultrawide' enum (replaced 2026-05-14 by 'ar'/'non-ar').
                // The string mismatch silently nullified this opt-out for the
                // entire Android non-AR path.  See PanoramaSettings audit
                // table row `captureSource`.
                val captureSource = configOverrides?.getString("captureSource") ?: "ar"
                val isNonAR = (captureSource == "non-ar")
                keyframeGate.disableAngularFallback = isNonAR

                // 2026-05-22 (audit F6) — honour frameSelectionMode.
                // Pre-audit Android force-enabled the gate with the C++
                // default (Pose) strategy regardless of the JS setting,
                // making `frameSelectionMode = 'flow-based'` silently
                // ineffective on Android (the Flow KLT path was never
                // taken — only on iOS).  Match iOS' mapping:
                //   'time-based' → gate disabled (passthrough)
                //   'pose-based' → gate enabled, Pose strategy
                //   'flow-based' → gate enabled, Flow strategy
                val frameMode = configOverrides?.getString("frameSelectionMode")
                    ?: "flow-based"
                keyframeGate.enabled =
                    (frameMode == "pose-based" || frameMode == "flow-based")
                keyframeGate.strategy = if (frameMode == "flow-based") {
                    KeyframeGate.Strategy.Flow
                } else {
                    KeyframeGate.Strategy.Pose
                }
                keyframeGate.reset()
                // 2026-05-22 (audit F5) — reset the eval-throttle frame
                // counter so the first frame of every capture is
                // ALWAYS evaluated regardless of evalCadence.
                consumeFrameCounter = 0L
            } else if (isFirstwins) {
                batchKeyframeMode = false
                batchKeyframePaths.clear()
                keyframeGate.enabled = false   // gate is batch-only; off for live engines
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
                batchKeyframeMode = false
                batchKeyframePaths.clear()
                keyframeGate.enabled = false   // gate is batch-only; off for hybrid engine
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

            // ── P3-G diagnostic ──────────────────────────────────
            // Surfaces start() state so we can see in logcat: (a)
            // engine mode actually selected, (b) batchKeyframeMode
            // flag, (c) KeyframeGate config, (d) whether the AR
            // view is bound.  Each of these is a potential failure
            // point for the "0 keyframes captured" symptom.
            android.util.Log.i(
                "IncrementalStitcher",
                "start() ENTRY: engineMode=$engineMode " +
                    "batchKeyframeMode=$batchKeyframeMode " +
                    "gate.enabled=${keyframeGate.enabled} " +
                    "gate.maxCount=${keyframeGate.maxCount} " +
                    "gate.threshold=${keyframeGate.overlapThreshold} " +
                    "arCameraViewBound=${arCameraViewRef != null} " +
                    "isRunning=${isRunning.get()}",
            )

            val map = Arguments.createMap()
            map.putBoolean("ok", true)
            promise.resolve(map)
        } catch (t: Throwable) {
            isRunning.set(false)
            frameProcessorIngestEnabled.set(false)  // F8.4 — symmetric clear on error path
            promise.reject("incremental-start-failed", t.message, t)
        }
    }

    /**
     * Copy a (non-persistent) source JPEG to a persistent per-keyframe
     * path under the React context's cache dir.  The ARCameraView's
     * forwardToIncremental writes every frame to a SINGLE reused tmp
     * file (rlis-arframe.jpg) — adequate for the live engines that
     * decode synchronously, but the batch-keyframe collector
     * accumulates paths for stitching at finalize time, so each
     * keyframe needs its own stable file.
     *
     * Returns the absolute path of the destination on success, or
     * null if the copy failed.  Cost ≈ 3-5 ms for a 1080p JPEG on
     * iPhone 16 / Galaxy A35 class hardware.
     *
     * Naming: `rlis-keyframe-{N}.jpg` where N is the next slot index
     * (= batchKeyframePaths.size).  Survives until either the next
     * batch-keyframe capture overwrites the same slot or the OS
     * cleans the cache dir.  iOS counterpart writes per-session
     * uuid-dirs via OpenCVKeyframeCollector — that's deeper parity
     * for a Phase 3 follow-up; this MVP is just enough to make
     * batch-keyframe work end-to-end on Android.
     */
    private fun copyKeyframeToStore(srcPath: String): String? {
        // V16 Phase 2 (Android Fix-1) — write into the per-session
        // subdir created by start().  If start() didn't run (defensive
        // — should never happen on the live ingest path), the
        // captureSessionDir is null and we drop the frame; the older
        // "rlis-keyframe-{N}.jpg in cacheDir" fallback is GONE because
        // it was the source of the cross-capture cache bug.
        val dir = captureSessionDir
        if (dir == null) {
            android.util.Log.w(
                "IncrementalStitcher",
                "copyKeyframeToStore: captureSessionDir is null — " +
                    "start() should have created it; dropping frame",
            )
            return null
        }
        val destFile = java.io.File(dir, "keyframe-${batchKeyframePaths.size}.jpg")
        return try {
            java.io.File(srcPath).copyTo(destFile, overwrite = true).absolutePath
        } catch (e: Exception) {
            android.util.Log.w(
                "IncrementalStitcher",
                "copyKeyframeToStore: failed to copy $srcPath → " +
                    "${destFile.absolutePath}: ${e.message}",
                e,
            )
            null
        }
    }

    // ── V16 Phase 1 → P3-F migration note ────────────────────────
    // The frame-counter placeholder gate `handleBatchKeyframeFrame`
    // that lived here has been REMOVED.  Both the AR-driven path
    // (`ingestFromARCameraView`) and the Frame Processor path
    // (`consumeFrameFromPlugin`) now route through the shared-C++
    // `KeyframeGate` (cpp/keyframe_gate.{hpp,cpp}) — same algorithm
    // iOS has used since the V16 ship.  See
    // `private val keyframeGate = KeyframeGate()` above for the
    // instance + lifetime.
    //
    // `batchKeyframeAcceptStride` is no longer consulted (the proper
    // gate uses pose-driven overlap, not a frame-counter stride);
    // the field is kept around for now because removing it would
    // touch unrelated init/serialization paths.  Wire it back in if
    // we ever add a "force every Nth frame regardless of overlap"
    // override.


    @ReactMethod
    fun finalize(options: ReadableMap, promise: Promise) {
        val hybrid = this.engine
        val firstwins = this.firstwinsEngine
        if (hybrid == null && firstwins == null && !batchKeyframeMode) {
            return promise.reject(
                "incremental-not-running",
                "No active capture — call start() first.",
            )
        }
        val outputPathOpt = options.getString("outputPath") ?: ""
        val outputPath = if (outputPathOpt.isEmpty()) {
            File(reactContext.cacheDir, "RNImageStitcherIncremental-${System.nanoTime()}.jpg").absolutePath
        } else {
            // Strip the `file://` scheme — hosts commonly pass paths
            // sourced from `expo-file-system`'s `documentDirectory`,
            // which always prefixes `file://`.  cv::imwrite (used
            // downstream by the batch-keyframe + hybrid + slit-scan
            // engines) silently returns false on URI-scheme paths,
            // surfacing as "Stitch failed: cv::imwrite returned
            // false".  iOS already strips at the same boundary —
            // see IncrementalStitcher.swift:1215.
            stripFileScheme(outputPathOpt)
        }
        val quality = options.getIntOrDefault("quality", 90)
        // 2026-05-18 (iOS cross-orientation fix; symmetric on Android) —
        // JS may pass a fresh deviceOrientation at finalize time; if
        // so, override batchCaptureOrientation BEFORE we snapshot it
        // for the stitcher.  Empty/missing → keep legacy start-time
        // value.  Android cross-orientation was already working per
        // user test (likely because users tested fewer rotation
        // sequences here), but propagating the fresh value uniformly
        // closes the same hole iOS had.
        val freshOrientationOpt = options.getString("captureOrientation") ?: ""
        if (freshOrientationOpt.isNotEmpty()) {
            batchCaptureOrientation = freshOrientationOpt
        }

        // Disengage the ARCameraView ingestion path FIRST so no late
        // frames slip into the engine while we serialize the canvas.
        arCameraViewRef?.setIncrementalIngestionActive(false)
        // Critic #4 fix: synchronously flip isRunning=false BEFORE
        // dispatching the finalize body, so any in-flight per-frame
        // ingest workers about to launch on workScope (today:
        // `ingestFromARCameraView` or `consumeFrameFromPlugin`) bail
        // at the re-check inside their workScope.launch blocks.
        // Matches iOS V12.1 fix.
        isRunning.set(false)
        frameProcessorIngestEnabled.set(false)  // F8.4 — cut producer-thread ingest at finalize

        // V16 batch-keyframe finalize: snapshot the keyframe state
        // synchronously under the same "stop ingestion before
        // dispatching" pattern, then null out the live state.
        val wasBatchKeyframe = batchKeyframeMode
        val keyframePathsSnapshot = batchKeyframePaths.toList()
        val captureOrientationSnapshot = batchCaptureOrientation
        val warperTypeSnapshot = batchWarperType
        val blenderTypeSnapshot = batchBlenderType
        val seamFinderTypeSnapshot = batchSeamFinderType
        val useInscribedRectCropSnapshot = batchUseInscribedRectCrop
        // 2026-05-14 — resolve stitch-mode auto → concrete mode.
        // 'auto' uses the pose deltas accumulated during capture to
        // pick PANORAMA (rotation-heavy) vs SCANS (translation-heavy).
        //
        // Heuristic (matches design doc 2026-05-13-stitch-pipeline-mode-selection):
        //   translation_score = ||t_last − t_first|| (meters) / 0.10
        //   rotation_score    = angle(fwd_last, fwd_first) (radians) / 1.00
        //   ratio = translation_score / (translation_score + rotation_score)
        //   ratio ≥ 0.55 → SCANS  (translation-dominant)
        //   ratio  < 0.55 → PANORAMA (rotation-dominant)
        //   missing poses → SCANS (safer default: bounded canvas).
        //
        // Why biased toward SCANS: PANORAMA on translation diverges
        // catastrophically (3.2 GB compositing canvas observed
        // 2026-05-14 → lmkd kill).  SCANS on rotation degrades
        // gracefully (slightly worse seams, never blows up).
        val firstPose = batchFirstAcceptedPose
        val lastPose = batchLastAcceptedPose
        // 2026-05-22 (audit F2b) — JS-supplied IMU translation
        // magnitude (metres).  In non-AR mode the JS-driver path
        // never carries pose tx/ty/tz so resolveStitchModeAuto's
        // pose-only signal is always 0 → resolver always picks
        // panorama.  The IMU translation gate's measured displacement
        // fills the gap.  Defaults to 0 (back-compat) → resolver
        // falls back to pose data only.  Always non-negative.
        val imuTranslationMetres = (options.getDoubleOrDefault("imuTranslationMetres", 0.0) ?: 0.0)
            .coerceAtLeast(0.0)
        val stitchModeResolved: String = when (batchStitchMode) {
            "panorama" -> "panorama"
            "scans"    -> "scans"
            else -> resolveStitchModeAuto(firstPose, lastPose, imuTranslationMetres)
        }
        android.util.Log.i(
            "IncrementalStitcher",
            "finalize stitch-mode: configured=$batchStitchMode resolved=$stitchModeResolved " +
                "firstPose=${firstPose != null} lastPose=${lastPose != null} " +
                "imuT=${"%.3f".format(imuTranslationMetres)}m",
        )
        batchKeyframeMode = false
        batchKeyframePaths.clear()
        batchKeyframeFrameCounter = 0
        batchFirstAcceptedPose = null
        batchLastAcceptedPose = null

        // Null the bridge refs synchronously NOW so any worker that's
        // about to run sees them as gone (V12.1 pattern).  We keep
        // local refs to do the actual finalize.
        engine = null
        firstwinsEngine = null

        workScope.launch {
            try {
                val map = Arguments.createMap()
                if (wasBatchKeyframe) {
                    // V16 batch-keyframe: hand keyframe paths to the
                    // JNI shim for one-shot cv::Stitcher processing.
                    if (keyframePathsSnapshot.size < 2) {
                        throw IllegalStateException(
                            "Batch-keyframe finalize: only " +
                            "${keyframePathsSnapshot.size} keyframe(s) " +
                            "captured — at least 2 required."
                        )
                    }
                    // Use the static `bridgeInstance` accessor on
                    // BatchStitcher rather than
                    // reactContext.getNativeModule — the latter
                    // returns null under bridgeless / new-architecture
                    // mode even for legacy-registered modules.
                    // Empirically: getNativeModule failed on Galaxy
                    // A35 with `BatchStitcher module not
                    // registered`, despite the module being present
                    // in RNImageStitcherPackage.createNativeModules.
                    // Same pattern that already works for
                    // IncrementalStitcher.bridgeInstance.
                    val stitcher = BatchStitcher.bridgeInstance
                        ?: throw IllegalStateException(
                            "BatchStitcher.bridgeInstance is null " +
                                "— module hasn't been instantiated yet. " +
                                "Check RNImageStitcherPackage registration."
                        )
                    val dims = stitcher.stitchSync(
                        keyframePathsSnapshot.toTypedArray(),
                        outputPath,
                        quality,
                        warperTypeSnapshot,
                        blenderTypeSnapshot,
                        seamFinderTypeSnapshot,
                        captureOrientationSnapshot,
                        useInscribedRectCropSnapshot,
                        stitchMode = stitchModeResolved,
                    )
                    // 2026-05-15 (D) — dims layout from native JNI:
                    //   [0] width, [1] height, [2] framesRequested,
                    //   [3] framesIncluded, [4] finalThresholdMilli
                    // The framesIncluded count is the post-
                    // leaveBiggestComponent retained subset.  Any
                    // delta from acceptedCount = frames the stitcher
                    // dropped due to weak feature-matching confidence.
                    // Surfaced to JS so the capture-screen UX can
                    // show "Stitched N of M frames" when drops > 0.
                    val framesRequested =
                        if (dims.size > 2) dims[2] else keyframePathsSnapshot.size
                    val framesIncluded =
                        if (dims.size > 3) dims[3] else keyframePathsSnapshot.size
                    val finalConfidenceThresh =
                        if (dims.size > 4) dims[4].toDouble() / 1000.0 else -1.0
                    map.putString("panoramaPath", outputPath)
                    map.putInt("width", dims[0])
                    map.putInt("height", dims[1])
                    map.putInt("acceptedCount", keyframePathsSnapshot.size)
                    map.putInt("framesRequested", framesRequested)
                    map.putInt("framesIncluded", framesIncluded)
                    map.putInt("framesDropped", framesRequested - framesIncluded)
                    map.putDouble("finalConfidenceThresh", finalConfidenceThresh)
                    // 2026-05-22 (audit F2g) — iOS parity.  Echo the
                    // resolved cv::Stitcher mode so JS can surface it
                    // on the output preview + debug toast.
                    map.putString("stitchModeResolved", stitchModeResolved)
                } else if (firstwins != null) {
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
                    // 2026-05-16 — realtime+batch fusion (Option A
                    // "Replace on completion") hook.  The live
                    // panorama has been written to outputPath; now
                    // fire-and-forget an async refinement on the
                    // engine's accepted keyframes via the shared C++
                    // stitcher.
                    //
                    // Today's `IncrementalEngine` (the hybrid live
                    // engine) does NOT retain per-frame JPEGs — it
                    // paints into a single persistent canvas Mat
                    // that's torn down by `release()` above.  So the
                    // keyframe-paths list passed to runHybridAutoRefine
                    // is empty for the hybrid branch, which means
                    // the auto-trigger detects "< 2 keyframes on
                    // disk" and emits `isRefining=false` without
                    // running cv::Stitcher.  Per the prompt's
                    // "no-op when no keyframes on disk" constraint.
                    //
                    // When a future change wires the hybrid engine
                    // to a keyframe collector (parallel to iOS'
                    // OpenCVKeyframeCollector), the same hook will
                    // light up automatically — just pass the
                    // populated list here.
                    val keyframePathsForHybrid: List<String> = emptyList()
                    val refinedOutputPath = refinedPathFromLive(outputPath)
                    runHybridAutoRefine(
                        framePaths = keyframePathsForHybrid,
                        refinedOutputPath = refinedOutputPath,
                        captureOrientation = captureOrientationSnapshot,
                        warperType = warperTypeSnapshot,
                        blenderType = blenderTypeSnapshot,
                        seamFinderType = seamFinderTypeSnapshot,
                        useInscribedRectCrop = useInscribedRectCropSnapshot,
                    )
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
        frameProcessorIngestEnabled.set(false)  // F8.4 — cut producer-thread ingest at cancel
        val hybrid = engine
        val firstwins = firstwinsEngine
        engine = null
        firstwinsEngine = null
        // V16 Phase 2 (Android Fix-1) — clean up the per-session
        // batch-keyframe subdir.  iOS-parity: cancel removes the
        // session's saved JPEGs because the operator explicitly
        // aborted, so the keyframes aren't worth preserving for
        // reprocessing.  (Successful finalize keeps them — see the
        // ivar declaration.)
        val sessionDirToCleanup = captureSessionDir
        captureSessionDir = null
        batchKeyframeMode = false
        batchKeyframePaths.clear()
        batchKeyframeFrameCounter = 0
        // Defer engine release + session-dir cleanup onto the work
        // queue so we don't race with an ingest that already passed
        // the null-check and is mid-execution on a captured local
        // reference.
        workScope.launch {
            hybrid?.release()
            firstwins?.reset()
            sessionDirToCleanup?.deleteRecursively()
        }
        val map = Arguments.createMap()
        map.putBoolean("ok", true)
        promise.resolve(map)
    }

    /**
     * Called by `RNSARCameraView` per ARCore frame when it has
     * a fresh Y-plane + pose to ingest.  Synchronous from the
     * caller's perspective.  Drops the frame silently if no engine
     * is running (race between view lifecycle and stitcher start/stop).
     *
     * 2026-05-21 (v0.3) — pixel-data path.  Pre-0.3 this method took
     * a `path: String` argument pointing at a JPEG that the camera
     * view had already encoded for every ARCore frame whether the
     * gate would accept it or not (~25 ms of JPEG-encode + disk I/O
     * per frame at ~60 Hz).  The gate then ran a pose-only
     * evaluation because it had no pixel data, so the C++ Flow
     * strategy silently fell back to Pose.
     *
     * The new contract: caller hands us the frame's grayscale Y
     * plane bytes (already in memory from the YUV camera image —
     * zero new JPEG cost) and an `onAccept` lambda that knows how
     * to encode + persist a JPEG given a target path.  The lambda
     * runs ONLY if the gate accepts.  Net wins:
     *   • Flow strategy actually runs on accepted-or-not decisions.
     *   • Per-frame disk I/O eliminated for rejected frames
     *     (the typical 95%+ of frames in a capture).
     *   • Lazy JPEG encode + write happens at most ~6 times per
     *     capture (the gate's keyframeMaxCount), inside the lambda
     *     while the caller still holds the ARCore Image open.
     *
     * @param grayData    Y-plane (or otherwise grayscale) bytes.
     *                    Length must be ≥ grayStride * grayHeight.
     * @param grayWidth   Image width in pixels.
     * @param grayHeight  Image height in pixels.
     * @param grayStride  Bytes per row; may exceed grayWidth when
     *                    the source plane has padding (ARCore can pad).
     * @param onAccept    Invoked ONLY if the gate accepts this frame.
     *                    Receives the absolute target path
     *                    `<captureSessionDir>/keyframe-N.jpg` that the
     *                    callee MUST write a full-resolution JPEG of
     *                    the current camera image to.  Returns true
     *                    on success, false if the encode/write
     *                    failed (the frame is then dropped; gate
     *                    counter was already incremented, next
     *                    acceptable frame still lands on its own).
     */
    internal fun ingestFromARCameraView(
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        yaw: Double,
        pitch: Double,
        fovHorizDegrees: Double,
        fovVertDegrees: Double,
        trackingPoor: Boolean,
        grayData: ByteArray,
        grayWidth: Int,
        grayHeight: Int,
        grayStride: Int,
        onAccept: (targetPath: String) -> Boolean,
        // 2026-05-21 (v0.3) — only required when batchKeyframeMode
        // is false (the legacy hybrid/firstwins live-engine path,
        // which feeds JPEG paths into addFrameAtPath for each ARCore
        // frame).  Pass null when batchKeyframeMode is true; the
        // batch path uses `grayData` + `onAccept` instead.  Modern
        // callers prefer `nv21PixelData` below — `legacyJpegPath` is
        // kept only as a defensive fallback for older call sites
        // that have not yet been migrated.
        legacyJpegPath: String? = null,
        // F8.6 — pixel-data path for live engines.  When supplied
        // (and `batchKeyframeMode == false`), takes precedence over
        // `legacyJpegPath`: the live engine ingests via
        // `addFramePixelData` (NV21 → BGR Mat in-process) instead of
        // `addFrameAtPath` (JPEG decode round-trip).  Saves ~30-50 ms
        // per accepted frame on a mid-tier device.  Pass null to use
        // the legacy JPEG path.
        //
        // OWNERSHIP: the engine retains a reference to `nv21PixelData`
        // until `workScope`'s coroutine consumes it (~50 ms later).
        // Callers MUST treat the array as transferred — do not
        // mutate it or return it to a buffer pool after calling
        // this method.  If a caller needs to recycle the buffer,
        // pass `.copyOf()` (currently no caller does — the F8.4
        // Frame Processor plugin allocates a fresh array per frame).
        nv21PixelData: ByteArray? = null,
        nv21PixelWidth: Int = 0,
        nv21PixelHeight: Int = 0,
    ) {
        // ── V16 batch-keyframe: AR-driven path ─────────────────────
        //
        // Batch-keyframe mode runs WITHOUT a live engine (engine ==
        // firstwinsEngine == null) — frames accumulate as keyframe
        // paths and the cv::Stitcher pipeline runs at finalize time.
        //
        // P3-F: this branch now calls into the shared-C++
        // KeyframeGate (cpp/keyframe_gate.{hpp,cpp}, same algorithm
        // iOS uses).  The placeholder frame-counter gate that lived
        // here previously (handleBatchKeyframeFrame) is GONE.
        //
        // The ARCameraView's JPEG-encode pipeline writes to a single
        // REUSED tmp file (rlis-arframe.jpg in cacheDir) — fine for
        // live engines (decoded into cv::Mat synchronously inside
        // addFrameAtPath, before next frame arrives), but FATAL for
        // batch-keyframe (all accepted keyframe paths would point to
        // the same overwritten file → finalize stitches 6 copies of
        // the same frame).  So we must COPY to a unique path on
        // accept.  We do the gate-evaluate BEFORE the copy so we
        // skip the ~5 ms JPEG copy on rejected frames.
        if (batchKeyframeMode) {
            // Build the POD pose for the gate.  tx/ty/tz are passed
            // through from the AR camera view (camera.pose.tx() etc.);
            // they're required for the plane-overlap math.  Falling
            // back to the angular path when no plane is latched is
            // handled internally by the gate (latchedPlane=null arg).
            val pose = RNSARFramePose(
                tx = tx, ty = ty, tz = tz,
                qx = qx, qy = qy, qz = qz, qw = qw,
                fx = fx, fy = fy, cx = cx, cy = cy,
                imageWidth = imageWidth, imageHeight = imageHeight,
                timestampMs = 0.0,           // not used by the gate
                trackingState = RNSARSession.TRACKING_TRACKING,
            )
            // Fetch the latched plane (if any) from the AR session
            // and convert to a column-major 16-float matrix matching
            // the C++ PlaneTransform layout.  ARCore's
            // Pose.toMatrix(out, offset) gives us exactly that layout
            // (same as iOS simd_float4x4).
            val planeMatrix: FloatArray? =
                RNSARSession.instance?.latchedPlaneTransform?.let { p ->
                    FloatArray(16).also { p.toMatrix(it, 0) }
                }

            // 2026-05-22 (audit F5) — eval-throttle.  When
            // flowEvalEveryNFrames > 1, evaluate the gate every Nth
            // ARCore frame instead of every frame.  Cuts CPU on the
            // 30-60Hz delegate path linearly with N.  First frame
            // (counter=1) always evaluates regardless of N because
            // (1 - 1) % N == 0 for any N ≥ 1.  iOS parity:
            // IncrementalStitcher.swift:2459-2471.  Skipped frames
            // are dropped entirely — NOT saved as keyframes, NOT
            // counted toward the keyframe budget.
            consumeFrameCounter += 1L
            val evalCadence = keyframeGate.flowEvalEveryNFrames.coerceAtLeast(1)
            if ((consumeFrameCounter - 1) % evalCadence != 0L) {
                return
            }

            // 2026-05-21 (v0.3) — pixel-aware evaluation.  Hands the
            // gate the Y-plane bytes so the Flow strategy actually
            // runs sparse-flow novelty on real image content (pre-0.3
            // this fell back to Pose strategy because the JS-bridge
            // path supplied no pixel data — same bug as the iOS
            // non-AR path; both fixed in v0.3).
            val decision = keyframeGate.evaluateWithFrame(
                pose, planeMatrix,
                grayData, grayWidth, grayHeight, grayStride,
            )

            // ── P3-G diagnostic ──────────────────────────────────
            // Rate-limit at the same cadence as the plane evaluator
            // (every 30 frames ≈ 2 Hz at 60Hz frame rate) but ALWAYS
            // log accepts (rare, important signal).
            if (decision.accept || (frameIngestLogTick++ % 30 == 0)) {
                android.util.Log.i(
                    "IncrementalStitcher",
                    "ingestFromARCameraView batch: " +
                        "accept=${decision.accept} reason=${decision.reason} " +
                        "newContent=${"%.3f".format(decision.newContentFraction)} " +
                        "gateCount=${decision.acceptedCount} " +
                        "paths.size=${batchKeyframePaths.size} " +
                        "planeAvailable=${planeMatrix != null}",
                )
            }
            if (!decision.accept) {
                // 2026-05-22 (audit follow-up) — emit a reject-state
                // event so the JS debug overlay sees a live overlap %
                // (matches iOS' emitKeyframeRejectState at
                // IncrementalStitcher.swift:2143).  No disk I/O — the
                // onAccept lambda is NOT invoked.  Cost: one extra
                // JS event per evaluated frame; with the F5 eval-
                // throttle at default 5, that's ~6 events/sec at
                // 30 Hz ARCore — fine.
                emitBatchKeyframeRejectState(
                    decision = decision,
                    keyframeCount = batchKeyframePaths.size,
                    keyframeMax = keyframeGate.maxCount,
                    isLandscape = imageWidth >= imageHeight,
                )
                return
            }
            // Accepted — generate the per-keyframe target path and
            // invoke the caller's onAccept lambda for the lazy JPEG
            // encode + write.  The caller (the AR camera view) still
            // holds the ARCore Image open at this point, so it can
            // encode raw camera pixels directly to disk without any
            // redundant copy.  Single disk write per accepted frame
            // (pre-0.3 was: write to tmp, then copy to store = two
            // disk writes; now we write to the final path directly).
            val dir = captureSessionDir
            if (dir == null) {
                android.util.Log.w(
                    "IncrementalStitcher",
                    "ingestFromARCameraView batch: ACCEPTED but " +
                        "captureSessionDir is null — frame dropped " +
                        "(start() should have created it)",
                )
                return
            }
            val persistentPath = java.io.File(
                dir, "keyframe-${batchKeyframePaths.size}.jpg"
            ).absolutePath
            val ok = onAccept(persistentPath)
            if (!ok) {
                android.util.Log.w(
                    "IncrementalStitcher",
                    "ingestFromARCameraView batch: ACCEPTED but onAccept returned false — frame dropped",
                )
                // Encode/persist failed — drop the frame.  Counter
                // was already incremented inside the gate; that's
                // fine — the next acceptable frame still lands on
                // its own merits.
                return
            }
            batchKeyframePaths.add(persistentPath)
            // 2026-05-14 — capture pose at every accept for the
            // stitch-mode auto-decision at finalize().  First accept
            // anchors the "from" pose; every subsequent accept
            // updates "to".  Cleared at start().  Order: tx, ty, tz,
            // qx, qy, qz, qw (same as the Pose struct in C++ KeyframeGate).
            val poseSnapshot = doubleArrayOf(tx, ty, tz, qx, qy, qz, qw)
            if (batchFirstAcceptedPose == null) batchFirstAcceptedPose = poseSnapshot
            batchLastAcceptedPose = poseSnapshot
            android.util.Log.i(
                "IncrementalStitcher",
                "ingestFromARCameraView batch: ACCEPTED keyframe #${batchKeyframePaths.size}" +
                    " → $persistentPath",
            )
            // Emit a state event so the JS-side LiveFrameStrip
            // renders the thumbnail strip + the "Keyframes: n/max"
            // pill updates in real time.  iOS counterpart:
            // emitBatchKeyframeAcceptedState in
            // IncrementalStitcher.swift — same field set
            // so the JS subscriber doesn't branch on platform.
            emitBatchKeyframeAcceptedState(
                thumbnailPath = persistentPath,
                keyframeIndex = batchKeyframePaths.size - 1,
                keyframeCount = batchKeyframePaths.size,
                keyframeMax = keyframeGate.maxCount,
                isLandscape = imageWidth >= imageHeight,
                newContentFraction = decision.newContentFraction,
            )
            return
        }

        val hybrid = this.engine
        val firstwins = this.firstwinsEngine
        if (hybrid == null && firstwins == null) return
        // 2026-05-21 (v0.3) — legacy live-engine path requires a JPEG
        // path (hybrid/firstwins addFrameAtPath feeds the cv::Mat
        // pipeline).  The batch-keyframe path above lazily encodes
        // only on accept and reaches `return` before this point, so
        // we only get here when batchKeyframeMode == false.  Caller
        // (RNSARCameraView) was expected to supply legacyJpegPath in
        // that case — defensively drop the frame if it didn't.
        // F8.6 — prefer the pixel-data path when the caller supplied
        // NV21 bytes (Frame Processor / refactored ARCore path),
        // otherwise fall back to legacyJpegPath (un-migrated ARCore
        // path).  At least one of them must be present; drop the
        // frame defensively otherwise.
        val hasPixelData = nv21PixelData != null
            && nv21PixelWidth > 0
            && nv21PixelHeight > 0
        val path = if (hasPixelData) null else legacyJpegPath ?: run {
            android.util.Log.w(
                "IncrementalStitcher",
                "ingestFromARCameraView legacy: batchKeyframeMode=false " +
                    "but both legacyJpegPath and nv21PixelData are null — " +
                    "dropping frame.  Caller must supply NV21 pixel data " +
                    "(preferred) or a JPEG path for the live engine path.",
            )
            return
        }
        workScope.launch {
            val state: WritableMap? = if (firstwins != null) {
                val tele = if (hasPixelData) {
                    firstwins.addFramePixelData(
                        nv21 = nv21PixelData!!,
                        nv21Width = nv21PixelWidth,
                        nv21Height = nv21PixelHeight,
                        qx = qx, qy = qy, qz = qz, qw = qw,
                        fx = fx, fy = fy, cx = cx, cy = cy,
                        imageWidth = imageWidth, imageHeight = imageHeight,
                        yaw = yaw, pitch = pitch,
                        fovHorizDegrees = fovHorizDegrees,
                        fovVertDegrees = fovVertDegrees,
                        trackingPoor = trackingPoor,
                    )
                } else {
                    firstwins.addFrameAtPath(
                        path = path!!,
                        qx = qx, qy = qy, qz = qz, qw = qw,
                        fx = fx, fy = fy, cx = cx, cy = cy,
                        imageWidth = imageWidth, imageHeight = imageHeight,
                        yaw = yaw, pitch = pitch,
                        fovHorizDegrees = fovHorizDegrees,
                        fovVertDegrees = fovVertDegrees,
                        trackingPoor = trackingPoor,
                    )
                }
                firstwins.snapshotIfDue(tele)
            } else {
                val tele = if (hasPixelData) {
                    hybrid!!.addFramePixelData(
                        nv21 = nv21PixelData!!,
                        nv21Width = nv21PixelWidth,
                        nv21Height = nv21PixelHeight,
                        qx = qx, qy = qy, qz = qz, qw = qw,
                        fx = fx, fy = fy, cx = cx, cy = cy,
                        imageWidth = imageWidth, imageHeight = imageHeight,
                        yaw = yaw, pitch = pitch,
                        fovHorizDegrees = fovHorizDegrees,
                        fovVertDegrees = fovVertDegrees,
                        trackingPoor = trackingPoor,
                    )
                } else {
                    hybrid!!.addFrameAtPath(
                        path = path!!,
                        qx = qx, qy = qy, qz = qz, qw = qw,
                        fx = fx, fy = fy, cx = cx, cy = cy,
                        imageWidth = imageWidth, imageHeight = imageHeight,
                        yaw = yaw, pitch = pitch,
                        fovHorizDegrees = fovHorizDegrees,
                        fovVertDegrees = fovVertDegrees,
                        trackingPoor = trackingPoor,
                    )
                }
                hybrid.snapshotIfDue(tele)
            }
            emitState(state)
        }
    }

    // ─── F8.4 — Frame Processor entry point ──────────────────────
    //
    // `consumeFrameFromPlugin` is the producer-thread ingress for
    // the vision-camera Frame Processor plugin
    // (`CvFlowGateFrameProcessor`).  It takes a live
    // `android.media.Image` (held open by vision-camera for the
    // duration of the plugin callback) plus pose primitives, and
    // delegates to the existing `ingestFromARCameraView` after
    // extracting the Y plane bytes and wiring an inline JPEG
    // encoder for the on-accept lambda.
    //
    // ## Why this lives here (not on the plugin class)
    //
    // The plugin needs zero knowledge of the engine's internals
    // (batchKeyframeMode, eval-throttling, plane-latching, etc.)
    // — that's all in `ingestFromARCameraView`.  Mirroring iOS'
    // `consumeFrameFromPlugin`, the wrapper just maps the public
    // primitive contract to the existing engine entry point.
    //
    // ## Why pass `Image` (not just the Y bytes)
    //
    // The engine's `ingestFromARCameraView` uses Y-only for the
    // keyframe gate.  But when the gate ACCEPTS, the host (us) is
    // responsible for encoding the accepted frame as JPEG before
    // `ingestFromARCameraView` returns.  YuvImage / NV21 needs the
    // full Y + interleaved VU planes, so we keep the Image
    // reachable through the lambda.  Image's lifetime is bounded
    // by the plugin callback's return — vision-camera closes the
    // ImageProxy automatically — so the encode MUST be synchronous.
    //
    // ## Threading
    //
    // Called on vision-camera's frame-processor thread (a single-
    // thread executor).  `frameProcessorIngestEnabled` is read
    // lock-free via AtomicBoolean.  `ingestFromARCameraView`
    // dispatches the heavy engine work to `workScope` (serial),
    // so producer-thread blocking is bounded to the synchronous
    // gate evaluation + (on accept) JPEG encode — typically
    // 5–10 ms reject, 30–50 ms accept on a mid-tier device.
    fun consumeFrameFromPlugin(
        image: android.media.Image,
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        timestampMs: Double,
        trackingStateRaw: Int,
        // F8.4-Android-c rotation fix: how many degrees the sensor
        // data needs to be rotated CW to display upright.  Comes
        // from vision-camera's `Frame.imageProxy.imageInfo.rotationDegrees`.
        // Typically 90 for a portrait-held back camera on Samsung
        // devices (sensor mounted 90° rotated from screen-up).
        sensorRotationDegrees: Int,
    ) {
        // F8.4 — drop the call unless this capture was started in
        // frameProcessor mode.  Otherwise the plugin would double-
        // feed the engine alongside the AR-mode
        // `ingestFromARCameraView` path.  See the flag's declaration
        // for the full reasoning.  Mirrors iOS H1.
        if (!frameProcessorIngestEnabled.get()) return

        // F8.6 — pack the full NV21 (Y + interleaved VU) once,
        // then reuse it for BOTH the gate's Y-plane read AND the
        // live engine's pixel-data ingest.  Previously the plugin
        // only extracted Y; the live engine then had to JPEG-decode
        // a separately-encoded path to recover BGR colour.  Now we
        // skip both round-trips: the packed NV21 → BGR cvtColor
        // inside `addFramePixelData` produces the BGR Mat directly.
        //
        // YuvImageConverter.packNV21 is stride-aware and densely
        // repacks Y (so the gate's `grayStride = grayWidth = width`
        // works), then interleaves VU per the standard NV21 layout
        // [Y...][VU...].  Returns null only on degenerate Images
        // (closed mid-callback or non-YUV format).
        val packed = io.imagestitcher.rn.ar.YuvImageConverter.packNV21(image)
            ?: return
        val width = packed.width
        val height = packed.height
        val nv21Bytes = packed.nv21
        // The gate reads `grayHeight` rows of `grayWidth` pixels
        // at stride=width starting from offset 0.  That's exactly
        // the Y plane region of nv21Bytes — the gate naturally
        // stops before the UV bytes start.  No need to slice into
        // a separate ByteArray.
        val yBytes = nv21Bytes
        val yRowStride = width

        // Compute derived params expected by the existing ingest
        // API.  Quaternion-to-yaw/pitch follows the same convention
        // useFrameProcessorDriver synthesises on JS (q_yaw * q_pitch).
        //
        //   yaw   = atan2(2(qw*qy + qx*qz), 1 - 2(qy² + qz²))
        //   pitch = asin(clamp(2(qw*qx - qz*qy), -1, 1))
        val yaw = kotlin.math.atan2(
            2.0 * (qw * qy + qx * qz),
            1.0 - 2.0 * (qy * qy + qz * qz),
        )
        val pitch = kotlin.math.asin(
            (2.0 * (qw * qx - qz * qy)).coerceIn(-1.0, 1.0),
        )

        // FoV from intrinsics + dims.  fx == 0 is the "JS didn't
        // supply" signal (the iOS wrapper has the same default);
        // fall back to a 65°×50° estimate so the engine doesn't
        // see NaN.
        val fovHorizDegrees = if (fx > 0.0)
            2.0 * kotlin.math.atan(width.toDouble() / (2.0 * fx)) * 180.0 / Math.PI
        else 65.0
        val fovVertDegrees = if (fy > 0.0)
            2.0 * kotlin.math.atan(height.toDouble() / (2.0 * fy)) * 180.0 / Math.PI
        else 50.0

        // `2` == `.tracking` per the iOS RNSARTrackingState enum.
        // Anything else maps to trackingPoor=true, routing the
        // frame through the engine's degraded-tracking branches
        // (failing closed; symmetric with iOS C2).
        val trackingPoor = trackingStateRaw != 2

        ingestFromARCameraView(
            tx = tx, ty = ty, tz = tz,
            qx = qx, qy = qy, qz = qz, qw = qw,
            fx = fx, fy = fy, cx = cx, cy = cy,
            imageWidth = width, imageHeight = height,
            yaw = yaw, pitch = pitch,
            fovHorizDegrees = fovHorizDegrees,
            fovVertDegrees = fovVertDegrees,
            trackingPoor = trackingPoor,
            grayData = yBytes,
            grayWidth = width,
            grayHeight = height,
            grayStride = yRowStride,
            // F8.6 — pass the already-packed NV21 so the live
            // engine branch (hybrid / firstwins) can ingest via
            // `addFramePixelData` instead of JPEG-decoding a
            // separately-written path.  Batch-keyframe mode
            // ignores these (it uses `grayData` + `onAccept`).
            nv21PixelData = nv21Bytes,
            nv21PixelWidth = width,
            nv21PixelHeight = height,
            onAccept = { targetPath ->
                // Synchronous JPEG encode via the existing
                // YuvImageConverter (also used by RNSARCameraView's
                // ARCore path).  Reuses the NV21 already packed at
                // the top of `consumeFrameFromPlugin` — F8.6 saves
                // a duplicate packNV21 call here (the previous
                // version repacked the live `image` inside the
                // lambda).
                //
                // EXIF rotation is BAKED-AS-METADATA, not pixel-
                // rotated.  cv::imread in the stitcher ignores EXIF
                // by default (see BatchStitcher.applyExifOrientation),
                // so the engine's stored `frameRotationDegrees` still
                // governs how the cv::Mat is interpreted downstream.
                // No double-rotation.
                //
                // Returning `true` tells the engine the keyframe was
                // persisted; `false` tells it to drop the accept.
                try {
                    val displayRotation = when (sensorRotationDegrees) {
                        0   -> android.view.Surface.ROTATION_90
                        90  -> android.view.Surface.ROTATION_0
                        180 -> android.view.Surface.ROTATION_270
                        270 -> android.view.Surface.ROTATION_180
                        else -> android.view.Surface.ROTATION_0
                    }
                    val outPath = YuvImageConverter.encodeJpegFromNV21(
                        packed,
                        targetPath,
                        jpegQuality = 80,
                        displayRotation = displayRotation,
                    )
                    outPath != null
                } catch (e: Throwable) {
                    android.util.Log.w(
                        "IncrementalStitcher",
                        "consumeFrameFromPlugin: JPEG encode failed for $targetPath: ${e.javaClass.simpleName}: ${e.message}",
                        e,
                    )
                    false
                }
            },
        )
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

    // ── V15.0e — AR plane detection bridge (iOS-parity) ──────────────
    //
    // iOS exposes these on the IncrementalStitcherBridge (NOT on the
    // ARSession module) so the JS code calls
    //   getIncrementalNativeModule().getARPlaneStatus()
    // (see react-native-image-stitcher/src/stitching/incremental.ts:535).
    // Both methods delegate to the AR session singleton — same pattern
    // as iOS' IncrementalStitcherBridge.swift, where the bridge holds
    // the RN @objc surface and the singleton holds the AR algorithm.

    /**
     * Poll-friendly plane-status read.  Called by JS at 2 Hz while
     * planeSource = 'ARKitDetected' (the default).  When the AR session
     * native module isn't registered (e.g. plain stitching tests
     * without an active AR session), returns a stable "searching"
     * default so the JS gate never throws.
     */
    @ReactMethod
    fun getARPlaneStatus(promise: Promise) {
        val session = RNSARSession.instance
        if (session == null) {
            // Safe default: no AR session = no plane to lock onto.
            // Shape MUST match the iOS contract so JS doesn't branch.
            val map = Arguments.createMap()
            map.putString("status", "searching")
            map.putBoolean("hasPlane", false)
            map.putDouble("bestAlignment", -1.0)
            map.putDouble("threshold", 0.6)
            promise.resolve(map)
            return
        }
        promise.resolve(session.buildARPlaneStatusMap())
    }

    /**
     * Force re-evaluation of plane detection.  Used by the JS
     * hold-to-scan press handler in AuditCaptureScreen.tsx:529 (which
     * `.catch(()=>{})`s the result).  Returns `latched=false`
     * synchronously; JS sees the new state on the next 2 Hz
     * getARPlaneStatus poll (~16 ms later, when the GL render thread
     * runs evaluatePlanesForFrame on the next ARCore frame).  See
     * detailed semantic note in RNSARSession.buildARPlaneStatusMap.
     */
    @ReactMethod
    fun relatchARPlane(promise: Promise) {
        RNSARSession.instance?.clearPlaneLatch()
        val map = Arguments.createMap()
        map.putBoolean("latched", false)
        promise.resolve(map)
    }

    /**
     * iOS-parity bridge method (was missing from Android — flagged
     * in the parity audit as Section C gap #1 / Section F gap #2).
     *
     * Arms the KeyframeGate to force-accept the NEXT frame regardless
     * of overlap.  Used by the JS shutter-release path so we don't
     * truncate the trailing edge of the scan.  iOS counterpart:
     * IncrementalStitcherBridge.swift markNextFrameAsLastKeyframe.
     *
     * Always resolves with `{ ok: true }`.  No-op when the gate is
     * disabled (which is fine — the live engines don't need a
     * force-last; only batch-keyframe does).
     */
    @ReactMethod
    fun markNextFrameAsLastKeyframe(promise: Promise) {
        keyframeGate.forceAcceptNext = true
        val map = Arguments.createMap()
        map.putBoolean("ok", true)
        promise.resolve(map)
    }

    /**
     * 2026-05-18 (Iss 3) — GC stale keyframe-session directories under
     * the SDK's cacheDir.  Scans `cacheDir` for `rlis-capture-*`
     * subdirectories (created by start() above) and removes those whose
     * newest file mtime is older than `olderThanMs` (default 24h).
     *
     * iOS sibling: `IncrementalStitcher.swift::cleanupKeyframes`.
     *
     * Resolves with `{ sessionsDeleted, bytesFreed }`.  Never rejects —
     * filesystem failures (missing dir, permission errors) resolve with
     * zero counts so the host can call this unconditionally on launch.
     *
     * Note: Android's OS already evicts cacheDir entries under storage
     * pressure, so this is a "be a good citizen and free space sooner"
     * helper rather than a hard requirement.  Still useful so the user's
     * disk-usage report doesn't show 100s of MB of stale captures.
     */
    @ReactMethod
    fun cleanupKeyframes(options: ReadableMap?, promise: Promise) {
        val olderThanMs = options?.getDoubleOrDefault(
            "olderThanMs", 24.0 * 3600.0 * 1000.0,
        ) ?: (24.0 * 3600.0 * 1000.0)
        val cutoffMs = System.currentTimeMillis() - olderThanMs.toLong()
        var sessionsDeleted = 0
        var bytesFreed = 0L
        try {
            val cache = reactContext.cacheDir ?: throw IllegalStateException("no cacheDir")
            val sessions = cache.listFiles { f -> f.isDirectory && f.name.startsWith("rlis-capture-") }
                ?: emptyArray()
            for (sessionDir in sessions) {
                // Newest mtime across the session's files (flat tree today,
                // walked recursively for future-proofing).
                var newestMtime = 0L
                var bytes = 0L
                sessionDir.walkTopDown().forEach { f ->
                    if (f.isFile) {
                        if (f.lastModified() > newestMtime) newestMtime = f.lastModified()
                        bytes += f.length()
                    }
                }
                if (newestMtime == 0L) {
                    // Empty session — fall back to the dir's own mtime.
                    newestMtime = sessionDir.lastModified()
                }
                if (newestMtime in 1 until cutoffMs) {
                    if (sessionDir.deleteRecursively()) {
                        sessionsDeleted += 1
                        bytesFreed += bytes
                    }
                }
            }
        } catch (e: Exception) {
            android.util.Log.w(
                "IncrementalStitcher",
                "cleanupKeyframes: ${e.message}",
            )
        }
        val map = Arguments.createMap()
        map.putInt("sessionsDeleted", sessionsDeleted)
        map.putDouble("bytesFreed", bytesFreed.toDouble())
        promise.resolve(map)
    }

    /**
     * 2026-05-18 (Iss 3) — return the current capture's keyframe
     * session directory.  Empty string when no capture is in flight
     * (or not in batch-keyframe mode).
     *
     * iOS sibling: `IncrementalStitcher.swift::currentKeyframeDir`.
     */
    @ReactMethod
    fun getKeyframeDir(promise: Promise) {
        val path = if (batchKeyframeMode) {
            captureSessionDir?.absolutePath ?: ""
        } else {
            ""
        }
        val map = Arguments.createMap()
        map.putString("path", path)
        promise.resolve(map)
    }

    /**
     * 2026-05-16 — realtime+batch fusion (Option A "Replace on
     * completion") entry point.  Run the shared C++ `cv::Stitcher`
     * pipeline over a caller-supplied list of keyframe JPEGs and
     * write a refined panorama to `outputPath`.
     *
     * Pre-conditions:
     *   - `framePaths.length >= 2`
     *   - Each path must exist on disk
     *
     * Routing: delegates to `BatchStitcher.stitchSync(...)` —
     * the same shared-JNI shim the batch-keyframe finalize uses.
     * Quality defaults match the batch-keyframe finalize:
     *   warperType         = "spherical"
     *   blenderType        = "multiband"
     *   seamFinderType     = "graphcut"
     *   captureOrientation = "portrait"
     *   useInscribedRectCrop = false
     *   stitchMode         = "auto"
     *   jpegQuality        = 90
     *
     * Threading: dispatches onto `refineScope` so the JS promise
     * doesn't block the @ReactMethod thread for the 2-5 s the
     * stitcher takes.  iOS-parity behaviour.
     *
     * iOS sibling: `IncrementalStitcher.swift::refinePanorama`.
     *
     * See: docs/site-content/design/2026-05-14-realtime-batch-fusion.md
     */
    @ReactMethod
    fun refinePanorama(options: ReadableMap, promise: Promise) {
        val framePathsArr = options.getArray("framePaths")
        if (framePathsArr == null || framePathsArr.size() < 2) {
            promise.reject(
                "incremental-refine-invalid-input",
                "refinePanorama requires at least 2 framePaths (got " +
                    "${framePathsArr?.size() ?: 0}).",
            )
            return
        }
        val framePaths = Array(framePathsArr.size()) {
            stripFileScheme(framePathsArr.getString(it) ?: "")
        }
        val outputPathOpt = options.getString("outputPath")
        if (outputPathOpt.isNullOrEmpty()) {
            promise.reject(
                "incremental-refine-invalid-input",
                "refinePanorama requires a non-empty outputPath.",
            )
            return
        }
        val outputPath = stripFileScheme(outputPathOpt)
        val config: ReadableMap? =
            if (options.hasKey("config")) options.getMap("config") else null
        val warperType = config?.getString("warperType") ?: "spherical"
        val blenderType = config?.getString("blenderType") ?: "multiband"
        val seamFinderType = config?.getString("seamFinderType") ?: "graphcut"
        val captureOrientation = config?.getString("captureOrientation") ?: "portrait"
        val useInscribedRectCrop =
            config?.getBooleanOrDefault("useInscribedRectCrop", false) ?: false
        val stitchMode = (config?.getString("stitchMode") ?: "auto")
            .let { if (it in setOf("auto", "panorama", "scans")) it else "auto" }
        val jpegQuality = max(1, min(100,
            config?.getIntOrDefault("jpegQuality", 90) ?: 90))

        // Pre-flight existence check — same defensive layer iOS has.
        for (p in framePaths) {
            if (!File(p).exists()) {
                promise.reject(
                    "incremental-refine-missing-keyframe",
                    "refinePanorama: keyframe missing on disk — $p",
                )
                return
            }
        }

        refineScope.launch {
            try {
                val stitcher = BatchStitcher.bridgeInstance
                    ?: throw IllegalStateException(
                        "BatchStitcher.bridgeInstance is null — " +
                            "module hasn't been instantiated yet.",
                    )
                // "auto" mode is meaningful only when we have first/
                // last keyframe poses to consult; the explicit
                // refinePanorama entry point has no pose context, so
                // collapse 'auto' → 'scans' here (the safer fallback,
                // identical to resolveStitchModeAuto's null-pose
                // branch).  Concrete modes pass through unchanged.
                val effectiveMode = if (stitchMode == "auto") "scans" else stitchMode
                val dims = stitcher.stitchSync(
                    framePaths,
                    outputPath,
                    jpegQuality,
                    warperType,
                    blenderType,
                    seamFinderType,
                    captureOrientation,
                    useInscribedRectCrop,
                    stitchMode = effectiveMode,
                )
                val framesRequested =
                    if (dims.size > 2) dims[2] else framePaths.size
                val framesIncluded =
                    if (dims.size > 3) dims[3] else framePaths.size
                val finalConfidenceThresh =
                    if (dims.size > 4) dims[4].toDouble() / 1000.0 else -1.0
                val map = Arguments.createMap().apply {
                    putString("panoramaPath", outputPath)
                    putInt("width", dims[0])
                    putInt("height", dims[1])
                    putInt("framesRequested", framesRequested)
                    putInt("framesIncluded", framesIncluded)
                    putInt("framesDropped", framesRequested - framesIncluded)
                    putDouble("finalConfidenceThresh", finalConfidenceThresh)
                }
                promise.resolve(map)
            } catch (t: Throwable) {
                promise.reject("incremental-refine-failed", t.message, t)
            }
        }
    }

    /**
     * 2026-05-16 — realtime+batch fusion auto-trigger called from
     * the hybrid-engine branch of `finalize()`.  Fire-and-forget;
     * the finalize() promise has ALREADY resolved with the live
     * panorama before this is invoked.
     *
     *   1. Emits a state event with `isRefining = true` so the
     *      host renders a "Refining…" pill.
     *   2. Runs `BatchStitcher.stitchSync(...)` on the supplied
     *      keyframe paths.
     *   3. On success: emits a state event with `isRefining = false`
     *      AND `refinedPanoramaPath = <path>`.
     *   4. On failure: emits a state event with `isRefining = false`
     *      and no refined path.  Host keeps showing the live
     *      panorama; failure does not affect audit save.
     *
     * NO-OP when `framePaths.size < 2` or any path is missing on
     * disk — matches the design doc's "if keyframes are NOT on
     * disk, auto-trigger is a no-op" contract.  Today's hybrid
     * engine retains no per-frame JPEGs so this is the
     * always-no-op path; the hook is wired in advance of a future
     * keyframe-collector enhancement.
     */
    internal fun runHybridAutoRefine(
        framePaths: List<String>,
        refinedOutputPath: String,
        captureOrientation: String,
        warperType: String,
        blenderType: String,
        seamFinderType: String,
        useInscribedRectCrop: Boolean,
    ) {
        if (framePaths.size < 2) {
            android.util.Log.i(
                "IncrementalStitcher",
                "[refine.auto] skipped: framePaths.size=${framePaths.size} " +
                    "(hybrid engine retains no per-frame JPEGs)",
            )
            emitRefinementState(isRefining = false, refinedPanoramaPath = null)
            return
        }
        for (p in framePaths) {
            if (!File(p).exists()) {
                android.util.Log.i(
                    "IncrementalStitcher",
                    "[refine.auto] skipped: missing keyframe $p",
                )
                emitRefinementState(isRefining = false, refinedPanoramaPath = null)
                return
            }
        }
        emitRefinementState(isRefining = true, refinedPanoramaPath = null)
        refineScope.launch {
            try {
                val stitcher = BatchStitcher.bridgeInstance
                    ?: throw IllegalStateException(
                        "BatchStitcher.bridgeInstance is null at auto-refine time",
                    )
                stitcher.stitchSync(
                    framePaths.toTypedArray(),
                    refinedOutputPath,
                    90,
                    warperType,
                    blenderType,
                    seamFinderType,
                    captureOrientation,
                    useInscribedRectCrop,
                    stitchMode = "scans",
                )
                android.util.Log.i(
                    "IncrementalStitcher",
                    "[refine.auto] success path=$refinedOutputPath",
                )
                emitRefinementState(
                    isRefining = false,
                    refinedPanoramaPath = refinedOutputPath,
                )
            } catch (t: Throwable) {
                android.util.Log.w(
                    "IncrementalStitcher",
                    "[refine.auto] refinement failed (live output kept): ${t.message}",
                )
                emitRefinementState(isRefining = false, refinedPanoramaPath = null)
            }
        }
    }

    /**
     * 2026-05-16 — emit a refinement-related state event.  Reuses
     * the same IncrementalStateUpdate channel the live
     * engines emit on; JS reads `isRefining` and `refinedPanoramaPath`
     * directly from the event payload (no schema change required on
     * the JS dispatch side).
     */
    private fun emitRefinementState(
        isRefining: Boolean,
        refinedPanoramaPath: String?,
    ) {
        val state = Arguments.createMap().apply {
            putNull("panoramaPath")
            putInt("width", 0)
            putInt("height", 0)
            putInt("acceptedCount", 0)
            putInt("outcome", 0)              // AcceptedHigh
            putDouble("confidence", 1.0)
            putDouble("overlapPercent", -1.0)
            putInt("processingMs", 0)
            putBoolean("isLandscape", false)
            putInt("paintedExtent", 0)
            putInt("panExtent", 0)
            putInt("keyframeMax", 0)
            putBoolean("isRefining", isRefining)
            if (refinedPanoramaPath != null) {
                putString("refinedPanoramaPath", refinedPanoramaPath)
            }
        }
        emitState(state)
    }

    /**
     * 2026-05-16 — given the live panorama path, derive a sibling
     * path for the refined output.  Same algorithm iOS uses:
     *   /…/<base>.jpg → /…/<base>-refined.jpg
     */
    private fun refinedPathFromLive(livePath: String): String {
        val cleaned = stripFileScheme(livePath)
        val file = File(cleaned)
        val parent = file.parentFile ?: File(reactContext.cacheDir, "panoramas")
        val name = file.name
        val dot = name.lastIndexOf('.')
        val refinedName = if (dot >= 0) {
            "${name.substring(0, dot)}-refined${name.substring(dot)}"
        } else {
            "$name-refined"
        }
        return File(parent, refinedName).absolutePath
    }

    /**
     * Poll the process' memory footprint in MB.  Android parity for
     * iOS' `getMemoryFootprintMB` (which polls Mach `phys_footprint`
     * via `task_info(TASK_VM_INFO)` — see
     * `IncrementalStitcherBridge.swift:231-259`).
     *
     * Returns the **total PSS** (proportional set size) of this
     * process in MB.  PSS is the metric Android's Low-Memory-Killer
     * (`lmkd`) ranks against, so it's the right one-true-number for
     * the on-screen memory pill: it's "how close are we to being
     * killed by the system?".
     *
     * Total PSS = USS (private) + sum(shared / refcount).  Read via
     * `ActivityManager.getProcessMemoryInfo()`, which is the same API
     * Android Studio's profiler uses.  Granularity is 1 KB; we
     * divide by 1024 to MB so the JS side displays a number directly
     * comparable to the iOS phys_footprint value.
     *
     * Returns -1.0 on failure (very rare — `getProcessMemoryInfo()`
     * is generally infallible since Android 5.0 because PSS is read
     * from `/proc/self/smaps` synchronously on the calling thread).
     */
    @ReactMethod
    fun getMemoryFootprintMB(promise: Promise) {
        try {
            val am = reactContext.getSystemService(ActivityManager::class.java)
            if (am == null) {
                promise.resolve(-1.0)
                return
            }
            val pid = android.os.Process.myPid()
            val infos = am.getProcessMemoryInfo(intArrayOf(pid))
            if (infos == null || infos.isEmpty()) {
                promise.resolve(-1.0)
                return
            }
            // totalPss is in KB.  Divide by 1024 → MB.  Use Double so
            // the JS overlay can render fractional MB if it wants.
            val mb = infos[0].totalPss.toDouble() / 1024.0
            promise.resolve(mb)
        } catch (t: Throwable) {
            android.util.Log.w(
                "IncrementalStitcher",
                "getMemoryFootprintMB: failed: ${t.message}",
            )
            promise.resolve(-1.0)
        }
    }

    /**
     * Release the C++ KeyframeGate heap allocation when RN tears
     * down the bridge module (e.g. on a JS reload).  Without this,
     * each reload leaks ~100 bytes of native heap — small but
     * unbounded over a long dev session.
     */
    override fun onCatalystInstanceDestroy() {
        try {
            keyframeGate.close()
        } catch (t: Throwable) {
            android.util.Log.w(
                "IncrementalStitcher",
                "onCatalystInstanceDestroy: keyframeGate.close failed: ${t.message}",
            )
        }
        // V16 Phase 2 (Android Fix-1) — best-effort cleanup of the
        // current per-session subdir.  Prevents leftover dirs
        // accumulating across dev-time RN reloads.  OS cache cleanup
        // would eventually reclaim cacheDir entries anyway, but this
        // makes the dev loop tidy.
        try {
            captureSessionDir?.deleteRecursively()
        } catch (t: Throwable) {
            // Ignore — not critical at teardown.
        }
        captureSessionDir = null
        // F8.4 — release the static back-pointer so the Frame
        // Processor plugin sees a clean nil after bridge teardown.
        // A new bridge will set it again via the init block.
        if (bridgeInstance === this) {
            bridgeInstance = null
        }
        super.onCatalystInstanceDestroy()
    }

    private fun emitState(state: WritableMap?) {
        if (state == null) return
        // Re-emit to JS via the standard DeviceEventEmitter pattern.
        // RN drops events when no listener is attached, so we don't
        // need our own gating.
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("IncrementalStateUpdate", state)
    }

    /**
     * Emit a state event when a batch-keyframe is accepted.  Carries
     * the on-disk thumbnail path so JS can render it in the
     * LiveFrameStrip + advance the "Keyframes: N/M" pill.
     *
     * iOS-parity field set — mirrors
     * IncrementalStitcher.swift::emitBatchKeyframeAcceptedState
     * exactly (same field names, types, order) so the JS subscriber
     * in incremental.ts doesn't need to branch on platform.
     */
    /**
     * 2026-05-22 (audit follow-up) — emit a state event when the gate
     * REJECTS a frame in batch-keyframe mode.  iOS does this via
     * `emitKeyframeRejectState` so the debug overlay's overlap %
     * updates continuously as the operator pans (even when no new
     * keyframe is being accepted).  Without this, Android's overlay
     * was frozen between accepts — operator could see "5 / 6
     * frames" but not "currently 92% overlap, need to pan more".
     *
     * Outcome enum: 5 = RejectedOverlap (matches iOS' RLISFrameOutcomeRejectedOverlap).
     */
    private fun emitBatchKeyframeRejectState(
        decision: KeyframeGateDecision,
        keyframeCount: Int,
        keyframeMax: Int,
        isLandscape: Boolean,
    ) {
        val state = Arguments.createMap()
        state.putNull("panoramaPath")
        state.putInt("width", 0)
        state.putInt("height", 0)
        state.putInt("acceptedCount", keyframeCount)
        // Map gate-reject reason → numeric outcome.  "max-reached" is
        // its own outcome (6 = RejectedMaxKeyframes); everything else
        // is the generic overlap-rejected (5).
        val outcome = if (decision.reason == "max-reached") 6 else 5
        state.putInt("outcome", outcome)
        state.putDouble("confidence", 0.0)
        val overlapPercent = if (decision.newContentFraction >= 0.0) {
            (1.0 - decision.newContentFraction) * 100.0
        } else {
            -1.0
        }
        state.putDouble("overlapPercent", overlapPercent)
        state.putInt("processingMs", 0)
        state.putBoolean("isLandscape", isLandscape)
        state.putInt("paintedExtent", 0)
        state.putInt("panExtent", 0)
        state.putInt("keyframeMax", keyframeMax)
        emitState(state)
    }

    private fun emitBatchKeyframeAcceptedState(
        thumbnailPath: String,
        keyframeIndex: Int,
        keyframeCount: Int,
        keyframeMax: Int,
        isLandscape: Boolean,
        // 2026-05-22 (audit follow-up) — overlap % was hardcoded to
        // -1 here, so the debug overlay's `overlap` row was blank
        // on Android.  iOS computes overlapPercent from the gate's
        // newContentFraction via `(1 - newContent) * 100`.  Match
        // that conversion here.  Pass -1.0 to keep the legacy
        // "unknown" behaviour for call sites that don't have a
        // decision in hand.
        newContentFraction: Double,
    ) {
        val state = Arguments.createMap()
        state.putNull("panoramaPath")
        state.putInt("width", 0)
        state.putInt("height", 0)
        state.putInt("acceptedCount", keyframeCount)
        // Outcome 0 = AcceptedHigh — matches the FrameOutcome enum
        // ordinal that the live engines emit.  Keeps the iOS
        // IncrementalOutcome contract: batch-keyframe
        // accepts all carry outcome=acceptedHigh.
        state.putInt("outcome", 0)
        state.putDouble("confidence", 1.0)
        val overlapPercent = if (newContentFraction >= 0.0) {
            (1.0 - newContentFraction) * 100.0
        } else {
            -1.0
        }
        state.putDouble("overlapPercent", overlapPercent)
        state.putInt("processingMs", 0)
        state.putBoolean("isLandscape", isLandscape)
        state.putInt("paintedExtent", 0)   // batch-keyframe doesn't
        state.putInt("panExtent", 0)        // paint a live canvas
        state.putInt("keyframeMax", keyframeMax)
        // Batch-keyframe extras the live-engine schema doesn't carry
        // — JS reads these directly from the event payload (matches
        // iOS' direct-userInfo-write at the bottom of the iOS
        // emitter).
        state.putString("batchKeyframeThumbnailPath", thumbnailPath)
        state.putInt("batchKeyframeIndex", keyframeIndex)
        emitState(state)
    }

    // ── OpenCV bootstrap ────────────────────────────────────────────

    /**
     * 2026-05-14 — stitch-mode auto-resolution.
     *
     * Inputs are the first and last accepted-keyframe poses captured
     * during this batch capture.  Each pose is `[tx, ty, tz, qx, qy,
     * qz, qw]` in the AR-session world frame.  When either pose is
     * null (e.g., < 2 keyframes were accepted, OR the capture used a
     * non-AR camera path where ARKit/ARCore poses aren't available)
     * we default to 'scans' — that's the safer of the two: SCANS on
     * pure rotation produces a slightly-less-sharp output, while
     * PANORAMA on translation produces an unbounded compositing
     * canvas and the lmkd kill we observed 2026-05-14.
     *
     * Heuristic (see design doc 2026-05-13-stitch-pipeline-mode-selection):
     *   translation_score = ||t_last − t_first|| / 0.10           (10 cm → 1.0)
     *   rotation_score    = angle(fwd_last, fwd_first) / 1.00     (1 rad ≈ 57° → 1.0)
     *   ratio = translation_score / (translation_score + rotation_score)
     *   ratio ≥ 0.55 → SCANS   (biased toward SCANS for safety)
     *   ratio  < 0.55 → PANORAMA
     *
     * Returns "panorama" or "scans" — never "auto".
     */
    private fun resolveStitchModeAuto(
        firstPose: DoubleArray?,
        lastPose: DoubleArray?,
        // 2026-05-22 (audit F2b) — JS-measured cumulative IMU
        // translation in METRES.  Used as a fallback when pose-derived
        // translation is 0 (non-AR mode).
        imuTranslationMetres: Double = 0.0,
    ): String {
        if (firstPose == null || lastPose == null) {
            // No pose data at all — fall back on the IMU signal.  IMU
            // > 5 cm hints SCANS; everything else hints PANORAMA.
            return if (imuTranslationMetres > 0.05) "scans" else "panorama"
        }
        if (firstPose.size != 7 || lastPose.size != 7) {
            return if (imuTranslationMetres > 0.05) "scans" else "panorama"
        }

        // Translation magnitude (Euclidean, in metres) — pose-derived.
        val dtx = lastPose[0] - firstPose[0]
        val dty = lastPose[1] - firstPose[1]
        val dtz = lastPose[2] - firstPose[2]
        val tPose = kotlin.math.sqrt(dtx * dtx + dty * dty + dtz * dtz)
        // 2026-05-22 (audit F2b) — non-AR mode delivers pose-derived
        // translation = 0 because the JS-driver path doesn't carry
        // tx/ty/tz.  Take the larger of pose-derived and IMU-measured
        // so AR (accurate pose) and non-AR (IMU only) both produce a
        // meaningful ratio.
        val tMeters = kotlin.math.max(tPose, imuTranslationMetres)

        // Rotation magnitude — angle between camera-forward vectors.
        // Camera-forward in body frame is (0, 0, -1) for ARKit/ARCore
        // conventions; rotated by the pose quaternion gives the world-
        // frame forward direction.  Angle between the first and last
        // camera-forward vectors is the total rotation around any axis.
        val fwdFirst = qrotForward(firstPose[3], firstPose[4], firstPose[5], firstPose[6])
        val fwdLast = qrotForward(lastPose[3], lastPose[4], lastPose[5], lastPose[6])
        val dot = (fwdFirst[0] * fwdLast[0] + fwdFirst[1] * fwdLast[1] + fwdFirst[2] * fwdLast[2])
            .coerceIn(-1.0, 1.0)
        val rRadians = kotlin.math.acos(dot)

        // Normalisation: 10 cm of translation ≈ 1 rad of rotation as
        // "equivalent magnitude" for the ratio.  Empirically: shelf
        // scans cover ~30 cm of translation with ~10° (0.17 rad) of
        // rotation.  ratio = (0.30/0.10) / (3.0 + 0.17) = 0.95 → SCANS.
        // Pure 90° rotation panorama: 0 translation, 1.57 rad rotation.
        // ratio = 0 / (0 + 1.57) = 0.0 → PANORAMA.
        val tScore = tMeters / 0.10
        val rScore = rRadians / 1.00
        val denom = tScore + rScore
        if (denom <= 1e-9) return "panorama"  // no motion either way
        val ratio = tScore / denom

        android.util.Log.i(
            "IncrementalStitcher",
            "stitch-mode auto: tPose=${"%.3f".format(tPose)}m " +
                "tImu=${"%.3f".format(imuTranslationMetres)}m " +
                "r=${"%.3f".format(rRadians)}rad " +
                "ratio=${"%.3f".format(ratio)} " +
                "→ ${if (ratio >= 0.55) "scans" else "panorama"}",
        )
        return if (ratio >= 0.55) "scans" else "panorama"
    }

    /**
     * Rotate the camera-forward unit vector (0, 0, -1) by a unit
     * quaternion (qx, qy, qz, qw).  Closed-form expansion of
     * v' = q · v · q⁻¹.  Same convention as `qrot` in
     * cpp/keyframe_gate.cpp.
     */
    private fun qrotForward(qx: Double, qy: Double, qz: Double, qw: Double): DoubleArray {
        // v = (0, 0, -1).  q · v · q⁻¹ closed-form:
        // result = v + 2 * qw * (q_xyz × v) + 2 * q_xyz × (q_xyz × v)
        // Pre-computed for v=(0,0,-1):
        //   q_xyz × v = (qy * -1 - qz * 0, qz * 0 - qx * -1, qx * 0 - qy * 0)
        //             = (-qy, qx, 0)
        //   q_xyz × (q_xyz × v):
        //     = (qy*0 - qz*qx, qz*(-qy) - qx*0, qx*qx - qy*(-qy))
        //     = (-qz*qx, -qz*qy, qx² + qy²)
        // result = (0 + 2*qw*(-qy) + 2*(-qz*qx),
        //          0 + 2*qw*qx    + 2*(-qz*qy),
        //          -1 + 2*qw*0    + 2*(qx² + qy²))
        return doubleArrayOf(
            -2.0 * (qw * qy + qz * qx),
            2.0 * (qw * qx - qz * qy),
            -1.0 + 2.0 * (qx * qx + qy * qy),
        )
    }

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
        var bridgeInstance: IncrementalStitcher? = null
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
    /** V12.11 Step D — operator panned BACKWARDS past the running
     *  max along the pan axis.  Engine has SKIPPED the paste; host
     *  should auto-finalize.  Rectilinear-only. */
    RejectedReverseDirection,
}


internal data class FrameTelemetry(
    val outcome: FrameOutcome,
    val overlapPercent: Double,
    val matchCount: Int,
    val inlierRatio: Double,
    val confidence: Double,
    val processingMs: Double,
    /** V12.12 — engine-detected orientation.  Mirrors iOS'
     *  `RLISFrameTelemetry.isLandscape`.  TRUE for landscape capture
     *  (vertical pan), FALSE for portrait (horizontal pan).  Stays
     *  at the FIRST-FRAME determination thereafter. */
    val isLandscape: Boolean = false,
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
        return addFrameMat(
            frame,
            qx, qy, qz, qw,
            fx, fy, cx, cy,
            imageWidth, imageHeight,
            yaw, pitch,
            fovHorizDegrees, fovVertDegrees,
            t0,
        )
    }

    /**
     * F8.6 — pixel-data twin of [addFrameAtPath].  Accepts the
     * camera frame as an NV21 byte buffer instead of a JPEG file
     * path; skips the JPEG decode round-trip.  See
     * `IncrementalFirstwinsEngine.addFramePixelData` for the
     * sibling implementation rationale.
     */
    fun addFramePixelData(
        nv21: ByteArray,
        nv21Width: Int,
        nv21Height: Int,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        yaw: Double, pitch: Double,
        fovHorizDegrees: Double, fovVertDegrees: Double,
        trackingPoor: Boolean,
    ): FrameTelemetry {
        val t0 = System.nanoTime()
        if (trackingPoor) {
            return FrameTelemetry(
                FrameOutcome.SkippedTrackingPoor, -1.0, 0, 0.0, 0.0,
                msSince(t0),
            )
        }
        // F8.6 IS-1 — length guard; see
        // `IncrementalFirstwinsEngine.addFramePixelData` for the
        // failure-mode rationale.
        val expectedBytes = nv21Width * nv21Height * 3 / 2
        require(nv21.size >= expectedBytes) {
            "addFramePixelData: nv21 buffer too small " +
                "(${nv21.size} bytes < $expectedBytes for " +
                "${nv21Width}x${nv21Height})"
        }
        val yuv = Mat(nv21Height + nv21Height / 2, nv21Width, CvType.CV_8UC1)
        yuv.put(0, 0, nv21)
        val srcRaw = Mat()
        Imgproc.cvtColor(yuv, srcRaw, Imgproc.COLOR_YUV2BGR_NV21)
        yuv.release()
        if (srcRaw.empty()) {
            return FrameTelemetry(
                FrameOutcome.SkippedTrackingPoor, -1.0, 0, 0.0, 0.0,
                msSince(t0),
            )
        }
        val frame = downsampleToCompose(srcRaw)
        if (frame !== srcRaw) srcRaw.release()
        return addFrameMat(
            frame,
            qx, qy, qz, qw,
            fx, fy, cx, cy,
            imageWidth, imageHeight,
            yaw, pitch,
            fovHorizDegrees, fovVertDegrees,
            t0,
        )
    }

    /**
     * F8.6 — the body extracted from [addFrameAtPath].  Takes a
     * BGR `Mat` (already downsampled to compose dims) and runs the
     * pose-driven homography paste pipeline.  Behaviour is
     * identical to the pre-F8.6 `addFrameAtPath` — the body is a
     * verbatim move.
     */
    private fun addFrameMat(
        frame: Mat,
        qx: Double, qy: Double, qz: Double, qw: Double,
        fx: Double, fy: Double, cx: Double, cy: Double,
        imageWidth: Int, imageHeight: Int,
        yaw: Double, pitch: Double,
        fovHorizDegrees: Double, fovVertDegrees: Double,
        t0: Long,
    ): FrameTelemetry {
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
