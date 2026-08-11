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
import kotlinx.coroutines.asCoroutineDispatcher
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

/**
 * v0.21.1 (review C) — an encode-ready RAM snapshot of one camera
 * frame for the pick-sharpest-in-window selection.  Wraps the
 * per-frame packed NV21 the ingest paths ALREADY allocate (so
 * retaining one is a reference grab, not a copy) plus the exact
 * JPEG-encode parameters that path would have used, so the single
 * commit-time encode is byte-identical to what the immediate-save
 * path produces.
 */
internal class SharpnessCandidateFrame(
    val packed: YuvImageConverter.PackedYuv,
    val displayRotation: Int,
    val jpegQuality: Int,
)

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

    // ── V16 batch-keyframe mode (Android parity with iOS' V16 Phase 1) ─
    //
    // Selected for engineMode == 'batch-keyframe'.  No live engine
    // runs — instead, accepted frames are collected as keyframe paths,
    // and at finalize() time we hand them all to the JNI shim
    // (libimage_stitcher.so) for one-shot cv::Stitcher processing.
    //
    // Accepted frames are selected by the shared C++ KeyframeGate
    // (pose / flow / time strategies, configured in start()); the
    // collected paths are handed to the JNI shim at finalize().
    private var batchKeyframeMode: Boolean = false
    private val batchKeyframePaths: MutableList<String> = mutableListOf()
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

    // ── v0.21 — pick-sharpest-in-window anti-blur selection state ──
    //
    // When the keyframe gate ACCEPTS a frame, the frame is not
    // committed to `batchKeyframePaths` immediately: a K-frame window
    // opens (K = `sharpnessWindow` config, default 4, clamp [1, 10]).
    // The accepted frame plus up to K−1 subsequent gate-EVALUATED
    // frames are scored with the shared variance-of-Laplacian metric
    // (cpp/sharpness.{hpp,cpp} via nativeSharpnessScore — same math
    // as iOS) and the SHARPEST is the keyframe that gets committed.
    // Rationale: the gate selects purely by overlap/novelty/time, so
    // a motion-blurred frame crossing the threshold used to be
    // stitched as-is — panos showed blur even on slow pans.
    //
    // Buffering (v0.21.1, review C): the best candidate is buffered
    // IN RAM — its already-packed NV21 ByteArray (~0.5–3 MB depending
    // on camera resolution) + JPEG-encode params + pose, wrapped in a
    // SharpnessCandidateFrame.  BOTH ingest paths already hold the
    // frame in a per-frame JVM array before calling the engine (AR:
    // RNSARCameraView packs NV21 and closes the ARCore Image FIRST —
    // audit #19; plugin: consumeFrameFromPlugin packs NV21 at entry),
    // so "retaining" a winner is a reference grab — zero copy, zero
    // disk I/O.  The JPEG encode happens ONCE, at window commit.
    //
    // History: the first cut buffered candidates ON DISK (one JPEG
    // encode per improvement + a .tmp/rename dance) on the mistaken
    // belief that the frame was only reachable while the caller's
    // onAccept lambda ran.  That spent ~25 ms of producer-thread
    // encode per improvement and — worse — left a rename able to land
    // AFTER finalize had already committed/snapshotted the keyframe
    // (rename-after-commit race).  Encoding once at commit, under the
    // window lock, removes both.
    //
    // Threading (v0.21.1, review C): ALL window state (the decision
    // machine + the sharpnessBest* fields + the commit) is guarded by
    // `sharpnessWindowLock`.  Producers (ARCore frame listener in AR
    // mode, vision-camera's serial executor in non-AR mode) mutate
    // under the lock; finalize()/cancel()/start() on the bridge
    // thread acquire the SAME lock, so an in-flight ingest either
    // completes its commit before the finalize snapshot or is
    // excluded atomically by the isRunning re-check — no
    // half-committed window state, no post-snapshot writes.
    private val sharpnessWindowLock = Any()
    private var sharpnessWindowK: Int = 4
    /// perf-3b — PANORAMA attempt-1 feature-matcher range width, set from
    /// the `stitchRangeMatcherWidth` start() config key.  0 = OFF (default,
    /// full-pairwise). Passed to BatchStitcher.stitchSync at finalize().
    private var stitchRangeMatcherWidth: Int = 0
    /// perf-3b item 1 — OpenCV thread count, set from the `stitchNumThreads`
    /// start() config key.  0 = auto-multi (default), 1 = single kill-switch,
    /// N = explicit.  Passed to stitchSync at finalize()/refine().
    private var stitchNumThreads: Int = 0
    /// perf-4a — compose-resolution adaptation mode, from start() config.
    /// "off" (default, byte-identical) | "always" (deterministic cut every
    /// finalize) | "measured" (self-tuning, see AdaptiveStitchResolution).
    private var adaptiveStitchMode: String = "off"
    private var adaptiveMinOutputMP: Double = 0.6
    private var adaptiveSlowStitchMsPerFrame: Double = 1000.0
    /// RCA — when true, a successful finalize drops a self-describing
    /// `pack.json` next to the (already-persisted) keyframes so a field
    /// capture can be pulled and replayed offline (keyframe images + config +
    /// timings + result). Off by default; a pure diagnostic, never alters the
    /// stitch. See docs + the offline compare tool.
    private var debugPackEnabled: Boolean = false
    /// Shared-C++ window DECISION machine (cpp/sharpness_window.*,
    /// via the SharpnessWindow JNI facade).  Owns open/closed state,
    /// remaining candidate slots, the streaming-max best score and the
    /// overlap-drift guard — the SAME logic iOS consults
    /// (SharpnessWindowBridge), so the two platforms cannot drift.
    /// This class only buffers frames and acts on the machine's
    /// returned action.  Closed in onCatalystInstanceDestroy() like
    /// keyframeGate.
    private val sharpnessWindow = SharpnessWindow()
    /// The buffered best candidate — an encode-ready RAM snapshot
    /// (packed NV21 + encode params).  Non-null exactly while an
    /// uncommitted selected keyframe exists.
    private var sharpnessBestFrame: SharpnessCandidateFrame? = null
    /// Pose of the CURRENT BEST candidate — [tx, ty, tz, qx, qy, qz,
    /// qw], same layout as batchFirst/LastAcceptedPose.  The committed
    /// keyframe's recorded pose must match the saved pixels, not the
    /// gate-accept frame.
    private var sharpnessBestPose: DoubleArray? = null
    /// Gate-decision metadata captured when the window OPENED — the
    /// accepted-state event describes the accept decision that started
    /// the window.
    private var sharpnessBestNewContentFraction: Double = -1.0
    private var sharpnessBestIsLandscape: Boolean = true
    /// v0.23 — sharpness score of the BUFFERED best, tracked
    /// platform-side rather than read back from the machine.  The
    /// machine's `bestScore` is the window's streaming max, which
    /// diverges from the buffered frame in two places: a FlushThenOpen
    /// overwrites it with the NEW seed's score before we commit the old
    /// best, and a candidate that wins the max but fails `retainFrame`
    /// advances it past the frame we actually kept.  The admission
    /// policy compares the score of the frame we are about to WRITE, so
    /// it needs this one.  -1.0 = nothing buffered.
    private var sharpnessBestScore: Double = -1.0

    // ── v0.23 — anti-blur ADMISSION policy (motion gate + softness) ──
    //
    // OFF BY DEFAULT.  Every knob below defaults to 0/false, and the
    // engine short-circuits on `blurPolicy.admissionEnabled` before it
    // touches the policy at all — a capture that doesn't opt in runs
    // the pre-v0.23 path with no extra JNI crossings, no pan-rate
    // tracking and no median bookkeeping on the producer thread.
    //
    // Where it is consulted: the sharpness window's natural CLOSE
    // (window-full / novelty-drift), i.e. the moment a selected
    // keyframe is about to be written.  A HOLD there is free — the
    // buffered best stays in RAM and the window is re-opened seeded
    // with its own score, so later (steadier) frames can still beat it.
    //
    // Where it is deliberately NOT consulted, because a hold would
    // LOSE a keyframe instead of deferring one:
    //   • FlushThenOpen ("new-accept") — the gate has already accepted
    //     a new frame; the pending best is about to be replaced, so it
    //     must be written now or never.
    //   • finalize()'s drain — the capture is over.
    //   • the K == 1 / gate-disabled immediate-commit path — there is
    //     no window to hold in, and the gate has already advanced its
    //     reference pose, so skipping the frame would leave a real
    //     coverage gap rather than a deferred commit.
    // Those three paths commit unconditionally, which is also what
    // guarantees forward progress when `maxConsecutiveHolds` is 0.
    //
    // Threading: guarded by `sharpnessWindowLock` like every other
    // window field — the policy is only ever consulted from inside a
    // locked section of the window helpers.
    private val blurPolicy = BlurPolicy()
    /// Consecutive holds of the CURRENT pending keyframe.  Reset when a
    /// keyframe commits and when a new window is seeded.
    private var sharpnessHoldCount: Int = 0
    /// Last evaluated frame's orientation quaternion [qx, qy, qz, qw]
    /// and the monotonic clock reading it was sampled at — the two
    /// halves of the pan-rate estimate.  Null/0 = no anchor yet.
    private var panRateLastQuat: DoubleArray? = null
    private var panRateLastSampleNanos: Long = 0L
    /// Magnitude of the device's angular rate, rad/s, from the most
    /// recent usable pose pair.  -1.0 is the shared C++ "unknown"
    /// sentinel and makes the motion gate fail open.
    private var panRateRadPerSec: Double = -1.0

    /// v0.23 — the exposure-cap milliseconds JS asked for.  STORED BUT
    /// NOT ACTIONED on Android, because this library owns neither
    /// capture session that could honour it:
    ///   • non-AR — vision-camera owns the CameraX/Camera2 session; we
    ///     only ever see an already-captured `android.media.Image` in
    ///     the frame-processor plugin.  There is no CameraDevice, no
    ///     CaptureRequest.Builder and no CameraCharacteristics on this
    ///     side of the boundary, so CONTROL_AE_MODE_OFF +
    ///     SENSOR_EXPOSURE_TIME is simply not reachable.  The HOST must
    ///     apply it through vision-camera's Camera2 interop
    ///     (Camera2CameraControl — the same interop retailens-camera-sdk
    ///     already uses for manual exposure), or the softer
    ///     CONTROL_AE_TARGET_FPS_RANGE floor.
    ///   • AR — ARCore owns the camera and exposes NO exposure API at
    ///     all.  Its only related lever is the frame rate, which
    ///     `antiBlurPreferHighFpsFormat` below drives.
    /// Kept as a field so the wire contract stays honest (JS always
    /// emits the key) and so the reach is documented in one place.
    private var antiBlurMaxExposureMs: Double = 0.0
    /// v0.23 — ACTIONED on the AR path only: forwarded to
    /// RNSARSession.setHighFpsFormatEnabled, which restricts the ARCore
    /// camera-config pick to >= 60 fps.  A 60 fps stream bounds exposure
    /// at 1/60 s by construction, which is the closest thing to an
    /// exposure cap ARCore permits.  Inert on the non-AR path (no AR
    /// session exists; vision-camera's format is the host's choice).
    private var antiBlurPreferHighFpsFormat: Boolean = false

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
    /// Public read-only accessor so the Frame Processor plugin can
    /// fast-exit BEFORE touching `frame.image` when ingest is off
    /// (e.g. during the multi-second stitch phase).  Avoids per-frame
    /// ImageProxy/JNI overhead at 30 fps on the producer thread.
    val isFrameProcessorIngestEnabled: Boolean
        get() = frameProcessorIngestEnabled.get()
    /// Critic #5 fix: serial dispatcher so concurrent per-frame
    /// ingest calls (today: `ingestFromARCameraView` in AR mode,
    /// `consumeFrameFromPlugin` in frame-processor mode) can't race
    /// on the engine's canvas.  One-at-a-time execution, matching iOS'
    /// `workQueue` (DispatchQueue.serial).
    ///
    /// perf-3b item 1 — a DEDICATED single-thread executor (was
    /// `Dispatchers.Default.limitedParallelism(1)`, which serialized but
    /// MIGRATED the calling thread across the shared pool).  A stable
    /// thread lets OpenCV's parallel-backend per-worker TLS scratch prime
    /// ONCE per process instead of re-priming on each stitch's thread
    /// migration — that re-priming was the ~7-9 MB/stitch native-heap
    /// creep that forced `cv::setNumThreads(1)`.  With the thread pinned,
    /// multi-threading is safe again (see stitcher.cpp numThreads).  Shut
    /// down in onCatalystInstanceDestroy(); daemon so it can't block exit.
    private val workExecutor: java.util.concurrent.ExecutorService =
        java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "rnis-stitch").apply { isDaemon = true }
        }
    private val workScope = CoroutineScope(workExecutor.asCoroutineDispatcher())

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
    /// perf-3b item 1 — its OWN dedicated single-thread executor, SEPARATE
    /// from workExecutor (a refine must not delay a new start()/ingest, per
    /// the design note above), and stable-threaded for the same TLS-creep
    /// reason as workExecutor.  Concurrent finalize (workExecutor) + refine
    /// (refineExecutor) native entries are serialized at the C++ boundary by
    /// the stitch mutex in stitchFramePaths.  SupervisorJob retained.
    private val refineExecutor: java.util.concurrent.ExecutorService =
        java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "rnis-refine").apply { isDaemon = true }
        }
    private val refineScope = CoroutineScope(
        SupervisorJob() + refineExecutor.asCoroutineDispatcher()
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
            // Engine selection.  The live engines (hybrid `IncrementalEngine`,
            // firstwins / slitscan `IncrementalFirstwinsEngine`) were archived
            // in the 2026-06 batch-keyframe cleanup -- the SDK now ships only
            // 'batch-keyframe': no live engine; frames are saved as JPEGs and
            // handed to cv::Stitcher (via the JNI shim) at finalize.  Any other
            // engineMode is still accepted for backward compatibility but falls
            // back to batch-keyframe with a deprecation log (mirrors iOS'
            // IncrementalStitcher.start()).
            val engineMode = options.getString("engine") ?: "batch-keyframe"
            if (engineMode != "batch-keyframe") {
                android.util.Log.w(
                    "IncrementalStitcher",
                    "[bridge] DEPRECATED engine '$engineMode' -- live engines " +
                        "archived, using batch-keyframe",
                )
            }

            val configOverrides: ReadableMap? =
                if (options.hasKey("config")) options.getMap("config") else null

            // No live engine runs.  Reset the keyframe collector state.
            // Read knobs from `config` per the V16 Phase 1 plumbing pattern.
            batchKeyframeMode = true
            batchKeyframePaths.clear()
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
            // Wall-clock keyframe-interval budget, in MILLISECONDS.
            // Force-accept once this much time has elapsed since the last
            // accepted keyframe (applies to BOTH Pose and Flow strategies).
            // Passed straight through — the JS value is already in ms (no
            // cm→m style conversion).  Clamp to ≥ 0.  Default 2000 ms when
            // absent (NOT 0 — time-budget acceptance is on by default so a
            // stalled scan still advances).  iOS parity:
            // IncrementalStitcher.swift maxKeyframeIntervalMs block.
            val maxKfIntervalMs = configOverrides
                ?.getDoubleOrDefault("maxKeyframeIntervalMs", 1500.0) ?: 1500.0
            keyframeGate.maxKeyframeIntervalMs = maxKfIntervalMs.coerceAtLeast(0.0)
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

            // Reject-event emit throttle.  Default 0 = OFF (emit every
            // reject), which restores iOS parity — iOS never throttles
            // reject emits.  The reviewed 7df2dba commit hardcoded a
            // 250 ms throttle; the adversarial review found it a measured
            // placebo (≤6 events/s) that also let the overlap-% overlay
            // and gate-reason go stale for up to 250 ms.  A host that
            // genuinely needs to cap bridge traffic on an old-arch device
            // can set rejectEmitMinIntervalMs > 0.  Clamp ≥ 0.  See
            // docs/perf-3a for the JS-side (coalescing) alternative that
            // relieves the render cost the wire throttle can't touch.
            val rejectThrottleMs = (configOverrides
                ?.getIntOrDefault("rejectEmitMinIntervalMs", 0) ?: 0)
                .coerceAtLeast(0)
            rejectEmitMinIntervalNanos = rejectThrottleMs.toLong() * 1_000_000L

            // perf-3b — PANORAMA attempt-1 feature-matcher range width.
            // 0 (default) = OFF (full-pairwise, byte-identical to before).
            // > 0 matches only capture-adjacent keyframes on attempt 1;
            // attempts 2/3 keep the full matcher as the pan-back rescue.
            // Applied at finalize() → stitchSync.  Clamp ≥ 0.
            stitchRangeMatcherWidth = (configOverrides
                ?.getIntOrDefault("stitchRangeMatcherWidth", 0) ?: 0)
                .coerceAtLeast(0)

            // perf-3b item 1 — OpenCV thread count.  0 = auto-multi (default),
            // 1 = single-threaded kill-switch (revert if a device regresses on
            // the native-heap memstat gate), N = explicit.  Clamp ≥ 0.
            stitchNumThreads = (configOverrides
                ?.getIntOrDefault("stitchNumThreads", 0) ?: 0)
                .coerceAtLeast(0)

            // perf-4a — compose-resolution adaptation mode. Unknown/absent
            // values fall back to the safe "off" (byte-identical).
            adaptiveStitchMode = (configOverrides?.getString("adaptiveStitchMode") ?: "off")
                .let { if (it == "always" || it == "measured") it else "off" }
            // Clamped to [0.6, 1.0]: 0.6 is the OD/OCR output-pixel floor, and
            // 1.0 is the default budget — a floor above the default would make a
            // "cut" raise resolution (slower) and pollute default-budget history.
            adaptiveMinOutputMP = (configOverrides
                ?.getDoubleOrDefault("adaptiveMinOutputMP", 0.6) ?: 0.6)
                .coerceIn(0.6, 1.0)
            adaptiveSlowStitchMsPerFrame = (configOverrides
                ?.getDoubleOrDefault("adaptiveSlowStitchMsPerFrame", 1000.0) ?: 1000.0)
                .coerceAtLeast(1.0)

            // RCA — debug pack: write pack.json next to the keyframes on finalize.
            debugPackEnabled = configOverrides
                ?.getBooleanOrDefault("debugPack", false) ?: false

            // v0.21 — pick-sharpest-in-window anti-blur selection.
            // 1 = off (immediate commit, pre-v0.21 behaviour).
            // Default 4 when the key is absent — a deliberate
            // behaviour change so existing captures gain anti-blur
            // selection without a JS-side opt-in.  Clamp [1, 10].
            // iOS parity: IncrementalStitcher.swift sharpnessWindow
            // block in start().
            val sharpWin = configOverrides
                ?.getIntOrDefault("sharpnessWindow", 4) ?: 4
            sharpnessWindowK = sharpWin.coerceIn(1, 10)
            // Push the new K into the shared decision machine (which
            // also discards any window state a previous capture left
            // behind) and drop the matching platform-side buffer —
            // under the window lock like every other window mutation.
            synchronized(sharpnessWindowLock) {
                sharpnessWindow.setWindowSize(sharpnessWindowK)
                sharpnessBestFrame = null
                sharpnessBestPose = null
                sharpnessBestScore = -1.0
            }

            // v0.23 — anti-blur CAPTURE controls.  ALL DEFAULT OFF
            // (0/false) except the hold cap, so a host that never sets
            // `frameSelection.antiBlur` gets byte-identical v0.22
            // behaviour.  Clamps match iOS so a mis-typed setting can
            // never produce a different verdict per platform.
            //
            // The knobs arrive pre-flattened by
            // PanoramaSettingsBridge.panoramaSettingsToNativeConfig,
            // which always emits all five keys; the ?: defaults below
            // cover older JS bundles.
            //
            // Read as Double even for the integer knob: RN delivers
            // every JS number as a double, and ReadableMap.getInt()
            // THROWS on a fractional one.  A host typo must not be able
            // to fail start() — this whole feature is fail-open.
            val abPanRate = configOverrides
                ?.getDoubleOrDefault("antiBlurMaxCommitPanRateRadPerSec", 0.0) ?: 0.0
            val abFraction = configOverrides
                ?.getDoubleOrDefault("antiBlurMinScoreFractionOfMedian", 0.0) ?: 0.0
            val abHolds = configOverrides
                ?.getDoubleOrDefault("antiBlurMaxConsecutiveHolds", 12.0) ?: 12.0
            val abExposureMs = configOverrides
                ?.getDoubleOrDefault("antiBlurMaxExposureMs", 0.0) ?: 0.0
            // Stored-only on Android — see the field declarations for
            // which session owns exposure and what the host must do.
            antiBlurMaxExposureMs = abExposureMs.coerceIn(0.0, 100.0)
            antiBlurPreferHighFpsFormat = configOverrides
                ?.getBooleanOrDefault("antiBlurPreferHighFpsFormat", false) ?: false
            // The one exposure-adjacent lever this library DOES own on
            // Android: an ARCore config that streams at >= 60 fps caps
            // exposure at 1/60 s by construction.  No-ops when the flag
            // is unchanged (so the default capture never pauses the AR
            // session) and when no AR session exists — the non-AR path
            // runs on vision-camera, where the host owns the controls.
            // iOS parity: RNSARSession.setHighFpsFormatEnabled.
            RNSARSession.instance?.setHighFpsFormatEnabled(antiBlurPreferHighFpsFormat)
            synchronized(sharpnessWindowLock) {
                blurPolicy.maxCommitPanRateRadPerSec = abPanRate.coerceIn(0.0, 20.0)
                blurPolicy.minScoreFractionOfMedian = abFraction.coerceIn(0.0, 1.0)
                blurPolicy.maxConsecutiveHolds =
                    abHolds.coerceIn(0.0, 100.0).toInt()
                // A new capture is a new scene: the previous session's
                // accepted-score median would mis-calibrate the floor.
                blurPolicy.resetHistory()
                sharpnessHoldCount = 0
                panRateLastQuat = null
                panRateLastSampleNanos = 0L
                panRateRadPerSec = -1.0
            }

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
                    // v0.23 — the anti-blur admission state, so a
                    // device log says whether the knobs actually
                    // reached native (all-zero = the v0.22 path).
                    "antiBlur.panRate=${blurPolicy.maxCommitPanRateRadPerSec} " +
                    "antiBlur.minFraction=${blurPolicy.minScoreFractionOfMedian} " +
                    "antiBlur.maxHolds=${blurPolicy.maxConsecutiveHolds} " +
                    "antiBlur.exposureMs=$antiBlurMaxExposureMs(host-applied) " +
                    "antiBlur.preferHighFps=$antiBlurPreferHighFpsFormat " +
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


    @ReactMethod
    fun finalize(options: ReadableMap, promise: Promise) {
        if (!batchKeyframeMode) {
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
        // v0.21 — drain + commit an open sharpness window so the
        // trailing keyframe isn't lost (the LAST accepted keyframe is
        // typically still waiting in it).  One JPEG encode (~25 ms),
        // once per capture, ahead of the multi-second stitch.
        //
        // v0.21.1 (review C) — under the WINDOW LOCK: a producer-
        // thread ingest that already passed its isRunning re-check is
        // mid-mutation right now; taking the same lock means it either
        // completes its own commit first (the path lands in
        // batchKeyframePaths before the snapshot below) or we commit
        // after it finished a replace — never interleaved.  The
        // commit is idempotent, so the double-commit shapes
        // (producer's window-full commit + this drain) are safe.
        // The committed keyframe also emits the accepted-state event
        // (iOS review-d1 parity): the JS thumbnail strip must include
        // the trailing keyframe.
        synchronized(sharpnessWindowLock) {
            sharpnessWindow.drain()
            commitSharpnessWindowLocked("finalize")
        }

        val wasBatchKeyframe = batchKeyframeMode
        val keyframePathsSnapshot = batchKeyframePaths.toList()
        val captureOrientationSnapshot = batchCaptureOrientation
        // Snapshot the session dir on the bridge thread BEFORE the async stitch:
        // if a second capture starts before this finalize resolves it reassigns
        // the captureSessionDir FIELD, and the debug-pack write (async, minutes
        // later) would otherwise land in the wrong capture's dir.
        val captureSessionDirSnapshot = captureSessionDir
        // batchWarperType (settings) is superseded by the high-level warper tree
        // (pickHighLevelWarper) below — kept as a field for back-compat, unused here.
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
        // Resolve once so the dev readout gets the SAME tMeters / ratio / rRadians
        // that drove the decision — and gets them even when the mode was forced
        // (informative: shows what auto WOULD have picked).
        val autoResolution = resolveStitchModeAuto(firstPose, lastPose, imuTranslationMetres)
        val stitchModeResolved: String = when (batchStitchMode) {
            "panorama" -> "panorama"
            "scans"    -> "scans"
            else -> autoResolution.mode
        }
        // Surface the gyro rotation + translation + decision ratio for EVERY
        // capture (the forced modes skip the auto decision, but the dev preview
        // still reads these to tune the panorama-vs-SCANS threshold).
        val rRadiansResolved: Double = autoResolution.rRadians
        val tMetersResolved: Double = autoResolution.tMeters
        val decisionRatioResolved: Double = autoResolution.ratio
        // 2026-06-16 — HIGH-LEVEL ACROSS THE BOARD.  Pick the warper from the
        // (motion, Mode A/B, zoom) tree and always run cv::Stitcher PANORAMA
        // (useManualPipeline=false at the stitchSync call below).  stitchModeResolved
        // is now only the MOTION classifier feeding the tree + the dev readout;
        // the actual stitch mode is always panorama.  Zoom comes from the EXPLICIT
        // lens label the user selected ('1x'|'0.5x') — the reliable signal (FOV
        // from intrinsics was unreliable: multi-cam 0.5x doesn't change fx, and
        // the non-AR path may supply fx=0 → FOV defaulted to 65° → never 0.5x).
        val lensOpt = options.getString("lens") ?: "1x"
        val highLevelWarper = pickHighLevelWarper(captureOrientationSnapshot, lensOpt)
        android.util.Log.i(
            "IncrementalStitcher",
            "finalize stitch-mode: configured=$batchStitchMode resolved=$stitchModeResolved " +
                "firstPose=${firstPose != null} lastPose=${lastPose != null} " +
                "imuT=${"%.3f".format(imuTranslationMetres)}m",
        )
        batchKeyframeMode = false
        batchKeyframePaths.clear()
        batchFirstAcceptedPose = null
        batchLastAcceptedPose = null

        // Emit a stitching-phase event so a host that COMPOSES its own
        // vision-camera `<Camera>` can stop feeding frames during the
        // multi-second stitch (in non-AR mode the camera + frame-
        // processor thread otherwise keep running at 30-60 fps, eating
        // CPU the cv::Stitcher worker needs).  The correct vision-camera
        // v4 control is the `isActive` prop — render `<Camera
        // isActive={false}>` (or unmount) on "started" and restore on
        // "finished".  There is NO `camera.pause()` / `resume()` method
        // in vision-camera v4; an earlier version of this comment
        // recommended one that does not exist.  The first-party
        // `<Camera>` already unmounts the camera during the stitch, so
        // this event exists for composed hosts only.  Hosts MUST also
        // restore on the finalize()/cancel() PROMISE settling, not the
        // event alone, because cancel() does not emit "finished".  See
        // the TS wrapper `subscribeStitchingPhase()` (src/stitching/
        // incremental.ts) and docs/host-app-integration.md.
        //
        // NOTE (2026-08-03): the AR GL-render pause that used to sit here
        // was removed — it was a no-op in the first-party flow (the AR
        // view is already unmounted before finalize) and, in composed
        // Layer-2 integrations that keep the view mounted, it froze the
        // preview and dropped the next capture's frames on view
        // detach/reattach.  See the adversarial review of 7df2dba and
        // docs/perf-3a / perf-3b.
        emitStitchingPhase("started")

        // Phase 0 telemetry — timestamp the launch so the coroutine body
        // can measure queue delay (backlog on the serial workScope: a
        // pending ingest or a previous capture's stitch delays the body).
        val tStitchDispatch = android.os.SystemClock.elapsedRealtime()

        workScope.launch {
            // Phase 0 telemetry — queue delay = dispatch → body start.
            val queueDelayMs =
                android.os.SystemClock.elapsedRealtime() - tStitchDispatch
            // Wall time of the blocking stitchSync JNI call, filled in below.
            var stitchWallMs = -1L
            // perf-4a — compose-resolution adaptation state.  Computed inside
            // the batch-stitch block below but read again in the shared
            // `timings`/`appliedBudgets` reporting AFTER that block closes, so
            // it is hoisted to the launch scope alongside stitchWallMs (same
            // reason).  Stays 1.0 / null on the opted-out path (byte-identical).
            var adaptiveComposeMP = 1.0
            var adaptiveDecision: AdaptiveStitchResolution.Decision? = null
            // Nudge the stitch thread into the foreground scheduler band
            // so the multi-second blocking cv::Stitcher call isn't
            // scheduled on par with background / camera-analysis threads.
            // `android.os.Process.setThreadPriority` maps directly to the
            // Linux nice value the CFS scheduler actually uses — unlike
            // `java.lang.Thread.priority` (the previous approach), whose
            // coarse 1-10 scale barely moves nice on ART.  Held at
            // FOREGROUND (not URGENT_DISPLAY/AUDIO) so it can never starve
            // the UI thread.  Captured outside try so finally can restore.
            //
            // NOTE: this boosts only THIS orchestrating thread.  The
            // OpenCV worker pool — where most cycles go once intra-stitch
            // parallelism is restored (docs/perf-3b item 1/3) — is not
            // covered here; making the boost reach the pool is a perf-3b
            // task.
            val origThreadPriority = try {
                android.os.Process.getThreadPriority(android.os.Process.myTid())
            } catch (_: Throwable) {
                android.os.Process.THREAD_PRIORITY_DEFAULT
            }
            try {
                try {
                    android.os.Process.setThreadPriority(
                        android.os.Process.THREAD_PRIORITY_FOREGROUND
                    )
                } catch (_: Throwable) { /* unsupported / denied — ignore */ }

                val map = Arguments.createMap()
                if (wasBatchKeyframe) {
                    // V16 batch-keyframe: hand keyframe paths to the
                    // JNI shim for one-shot cv::Stitcher processing.
                    if (keyframePathsSnapshot.isEmpty()) {
                        promise.reject(
                            "9003",
                            "Batch-keyframe finalize: 0 keyframes captured — at least 1 required."
                        )
                        return@launch
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
                    // Resolution budgets: use the stitchSync defaults
                    // (registrationResolMP=-1.0 → cv::Stitcher/JNI default;
                    // compositingResolMP=1.0 → the OOM-safe high-level
                    // default).  The RAM-keyed adaptive cut that used to
                    // sit here (regMP=0.4 / composeMP=0.6 on ≤4 GB devices)
                    // was REMOVED (2026-08-03): the adversarial review of
                    // 7df2dba found it a no-op on default 640 px keyframes,
                    // a silent ~40% output-pixel cut on quality captures,
                    // fired on unaffected RN 0.83 hosts, mis-classified any
                    // device on ActivityManager-null, and cut registration
                    // to 0.4 MP where the pipeline's own analysis wants
                    // MORE resolution (raising drops/failures).  The
                    // correct, opt-in, measured replacement is specified in
                    // docs/perf-4a-measured-resolution-adaptation.md.
                    // perf-4a — opt-in measured compose-resolution adaptation.
                    // compositingResolMP stays 1.0 (byte-identical) unless the
                    // host opted in AND the persisted per-keyframe wall-time
                    // median for this capture config says the device is slow.
                    // Floored at adaptiveMinOutputMP (the OD/OCR floor).
                    // (adaptiveComposeMP / adaptiveDecision hoisted to the
                    // launch scope above — they are read in the timings block
                    // after this batch block closes.)
                    var adaptiveKey: String? = null
                    when (adaptiveStitchMode) {
                        "always" -> {
                            // DETERMINISTIC knob: cut every finalize to the floor,
                            // unconditionally. No measurement, no persistence — the
                            // clean A/B treatment. Floor clamped [0.6, 1.0] at read.
                            adaptiveComposeMP = adaptiveMinOutputMP
                        }
                        "measured" -> {
                            val longEdge = firstKeyframeLongEdge(keyframePathsSnapshot)
                            // A header-decode failure (longEdge ≤ 0) must NOT pool
                            // distinct capture sizes under a shared le=0 bucket (nor
                            // read/write it) — skip the store and run the default
                            // budget for this finalize.
                            if (longEdge > 0) {
                                adaptiveKey = AdaptiveStitchResolution.key(longEdge, keyframeGate.maxCount)
                                adaptiveDecision = AdaptiveStitchResolution.evaluate(
                                    reactContext, adaptiveKey, adaptiveSlowStitchMsPerFrame,
                                )
                                if (adaptiveDecision.adapt) {
                                    // Floor clamped [0.6, 1.0] at read, so the cut
                                    // never exceeds the 1.0 default (which would slow
                                    // the device AND pollute default-budget history)
                                    // and never drops below the 0.6 OD/OCR floor.
                                    adaptiveComposeMP = adaptiveMinOutputMP
                                }
                            }
                        }
                        else -> { /* "off" → compose stays 1.0 (byte-identical) */ }
                    }
                    // Phase 0 telemetry — wall time of the blocking native
                    // cv::Stitcher JNI call.  This is the RN-version-invariant
                    // number: on the same device it should not move between a
                    // 0.79 and an 0.83 host.  (Kotlin-side measurement; ≈ the
                    // C++ durationMs minus negligible JNI overhead.)
                    val tStitchStart = android.os.SystemClock.elapsedRealtime()
                    val dims = stitcher.stitchSync(
                        keyframePathsSnapshot.toTypedArray(),
                        outputPath,
                        quality,
                        highLevelWarper,                 // tree-chosen (was batchWarperType)
                        blenderTypeSnapshot,
                        seamFinderTypeSnapshot,
                        captureOrientationSnapshot,
                        useInscribedRectCropSnapshot,
                        compositingResolMP = adaptiveComposeMP,  // perf-4a (1.0 unless adapted)
                        stitchMode = "panorama",         // always high-level PANORAMA
                        useManualPipeline = false,       // high level across the board
                        rangeMatcherWidth = stitchRangeMatcherWidth,  // perf-3b (0 = off)
                        numThreads = stitchNumThreads,   // perf-3b item 1 (0 = auto-multi)
                    )
                    stitchWallMs =
                        android.os.SystemClock.elapsedRealtime() - tStitchStart
                    // perf-4a — record a DEFAULT-budget (compose 1.0), non-ladder-
                    // escalated success so the median reflects device speed at
                    // the default budget. finalConfidenceThresh (dims[4]/1000) <
                    // 1.0 ⇒ the ladder escalated (scene-hard, not device-slow) —
                    // skip. Recording is unconditional on the fire decision so a
                    // slow device keeps refreshing its default-budget history.
                    // COVERAGE NOTE: a device whose captures ALWAYS escalate never
                    // accrues the MIN_SAMPLES needed to fire, so it stays at the
                    // safe 1.0 default forever. Intended: its cost is scene-driven
                    // registration retries, which a compositing cut does not
                    // reduce — the fallback is conservative, never a wrong result.
                    if (adaptiveStitchMode == "measured" && adaptiveComposeMP >= 1.0) {
                        val threshMilli = if (dims.size > 4) dims[4] else 1000
                        val escalated = threshMilli < 1000
                        if (!escalated) {
                            adaptiveKey?.let {
                                AdaptiveStitchResolution.recordDefaultRun(
                                    reactContext, it, stitchWallMs, keyframePathsSnapshot.size,
                                )
                            }
                        }
                    }
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
                    map.putDouble("rRadians", rRadiansResolved)
                    // Dev tuning readout — translation magnitude + the auto
                    // decision ratio that drove panorama-vs-SCANS.
                    map.putDouble("tMeters", tMetersResolved)
                    map.putDouble("decisionRatio", decisionRatioResolved)
                    // 2026-06-15 (iOS parity) — the exact keyframe JPEG
                    // paths used for this stitch, so JS can re-stitch
                    // them ON DEMAND via refinePanorama (the high-level
                    // preview tab) without enumerating the session dir.
                    // Camera.tsx gates that tab on this array being
                    // present, so without it the tab never appears on
                    // Android (the bug this fixes).  Mirrors iOS'
                    // FinalizePayload "batchKeyframePaths": payload.paths.
                    val keyframePathsArray = Arguments.createArray()
                    keyframePathsSnapshot.forEach { keyframePathsArray.pushString(it) }
                    map.putArray("batchKeyframePaths", keyframePathsArray)
                    // The orientation THIS stitch baked into the output.
                    // The on-demand high-level re-stitch MUST pass the
                    // same value back through refinePanorama or the
                    // output comes out in raw sensor landscape (sideways)
                    // — refinePanorama otherwise defaults to "portrait"
                    // (no bake-rotation).  Mirrors iOS' FinalizePayload
                    // "captureOrientation": payload.captureOrientation.
                    map.putString("captureOrientation", captureOrientationSnapshot)
                    // 2026-06-15 — DEV overlay parity with iOS: the stitcher's
                    // runtime recipe (pipe/warp/route/seam/blend) so the Android
                    // pill shows the same detail, not just mode/score/frames.
                    val dbg = stitcher.lastDebugSummary
                    if (dbg.isNotEmpty()) map.putString("debugSummary", dbg)

                    // RCA — debug pack. When enabled, drop a self-describing
                    // pack.json next to the (persisted) keyframes so this exact
                    // capture can be pulled and replayed OFFLINE: keyframe images
                    // + the recipe + the result + the timing decomposition
                    // (stitchWallMs is the RN-version-INVARIANT native cost;
                    // queueDelayMs is bridge/JS). This is what turns a field
                    // "it's slow" into a decomposable measurement. Never fails
                    // the finalize — a pack-write error is logged and swallowed.
                    if (debugPackEnabled) {
                        captureSessionDirSnapshot?.let { dir ->
                            try {
                                val pack = org.json.JSONObject().apply {
                                    put("schema", "rlis-debug-pack/v1")
                                    put("timestampMs", System.currentTimeMillis())
                                    put("device", org.json.JSONObject().apply {
                                        put("model", android.os.Build.MODEL)
                                        put("manufacturer", android.os.Build.MANUFACTURER)
                                        put("abi", android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "")
                                        put("cores", Runtime.getRuntime().availableProcessors())
                                        put("sdkInt", android.os.Build.VERSION.SDK_INT)
                                    })
                                    put("capture", org.json.JSONObject().apply {
                                        put("keyframeCount", keyframePathsSnapshot.size)
                                        put("keyframeFiles", org.json.JSONArray(
                                            keyframePathsSnapshot.map { java.io.File(it).name }))
                                        put("firstKeyframeLongEdge",
                                            firstKeyframeLongEdge(keyframePathsSnapshot))
                                        put("captureOrientation", captureOrientationSnapshot)
                                    })
                                    put("config", org.json.JSONObject().apply {
                                        put("adaptiveStitchMode", adaptiveStitchMode)
                                        put("adaptiveMinOutputMP", adaptiveMinOutputMP)
                                        put("compositingResolMP", adaptiveComposeMP)
                                        put("stitchModeResolved", stitchModeResolved)
                                        put("warper", highLevelWarper)
                                        put("blender", blenderTypeSnapshot)
                                        put("seamFinder", seamFinderTypeSnapshot)
                                        put("rangeMatcherWidth", stitchRangeMatcherWidth)
                                        put("numThreads", stitchNumThreads)
                                        put("inscribedRectCrop", useInscribedRectCropSnapshot)
                                    })
                                    put("result", org.json.JSONObject().apply {
                                        put("width", dims[0])
                                        put("height", dims[1])
                                        put("framesRequested", framesRequested)
                                        put("framesIncluded", framesIncluded)
                                        put("framesDropped", framesRequested - framesIncluded)
                                        put("finalConfidenceThresh", finalConfidenceThresh)
                                    })
                                    put("timings", org.json.JSONObject().apply {
                                        put("stitchWallMs", stitchWallMs)
                                        put("queueDelayMs", queueDelayMs)
                                    })
                                    put("debugSummary", dbg)
                                }
                                java.io.File(dir, "pack.json").writeText(pack.toString(2))
                            } catch (t: Throwable) {
                                android.util.Log.w(
                                    "IncrementalStitcher",
                                    "debug pack write failed: ${t.message}",
                                )
                            }
                        }
                    }
                } else {
                    // The live engines (hybrid + firstwins/slit) and their
                    // auto-refine hook were archived in the 2026-06 batch-
                    // keyframe cleanup; batchKeyframeMode is always true now.
                    throw IllegalStateException(
                        "finalize: live engines were archived; " +
                            "expected batchKeyframeMode.",
                    )
                }
                map.putInt("droppedBackpressure", 0)
                // Phase 0 telemetry — attach the native/JS timing block so
                // the host can attribute a stitch-time regression to native
                // (stitchWallMs) vs bridge/JS.  Additive + optional on the TS
                // side (IncrementalTimings); keyframeCount + budgets let a
                // host normalise across captures.  See perfTrace.ts.
                val timings = Arguments.createMap()
                timings.putDouble("queueDelayMs", queueDelayMs.toDouble())
                if (stitchWallMs >= 0)
                    timings.putDouble("stitchWallMs", stitchWallMs.toDouble())
                timings.putInt("keyframeCount", keyframePathsSnapshot.size)
                timings.putInt("rangeMatcherWidth", stitchRangeMatcherWidth)
                // perf-4a — surface every applied budget so no cut is silent
                // (the removed RAM cut's core defect). Only present when the
                // host opted in.
                if (adaptiveStitchMode != "off") {
                    val ab = Arguments.createMap()
                    ab.putDouble("compositingResolMP", adaptiveComposeMP)
                    ab.putString("mode", adaptiveStitchMode)
                    // Did THIS run actually cut compose below the 1.0 default?
                    val adapted = adaptiveComposeMP < 1.0
                    ab.putBoolean("adapted", adapted)
                    ab.putDouble("floorMP", adaptiveMinOutputMP)
                    if (adaptiveStitchMode == "always") {
                        // Deterministic — no measurement state to report.
                        ab.putString("source", "always")
                    } else {
                        // "measured": distinguish the measured sub-states. adaptiveDecision
                        // is null ONLY when the header decode failed (longEdge ≤ 0), the
                        // store was skipped, and we ran the default budget — report that
                        // honestly rather than as a measured "default" run.
                        val probe = adaptiveDecision?.probe == true
                        val seeded = adaptiveDecision?.seeded == true
                        val decodeFailed = adaptiveDecision == null
                        ab.putString(
                            "source",
                            when {
                                decodeFailed -> "decode-failed"  // longEdge ≤ 0, ran default, not recorded
                                adapted -> "adapted"     // fired regime, cut this run
                                probe -> "probe"         // fired regime, forced default re-measure
                                seeded -> "seeded"       // < MIN_SAMPLES history, measuring
                                else -> "default"        // measured-fast (not fired)
                            },
                        )
                        ab.putBoolean("probe", probe)
                        ab.putBoolean("seeded", seeded)
                        adaptiveDecision?.medianMsPerKeyframe?.let {
                            ab.putDouble("medianStitchMsPerKeyframe", it)
                        }
                    }
                    timings.putMap("appliedBudgets", ab)
                }
                map.putMap("timings", timings)
                promise.resolve(map)
            } catch (t: Throwable) {
                promise.reject("incremental-finalize-failed", t.message, t)
            } finally {
                // Restore the thread's original scheduler priority.
                try {
                    android.os.Process.setThreadPriority(origThreadPriority)
                } catch (_: Throwable) { /* ignore */ }
                // Signal JS that the stitch is done so a composed host can
                // re-activate its vision-camera `<Camera>` (see the
                // "started" emit above; the host must also key off the
                // finalize/cancel promise, since cancel() emits nothing).
                emitStitchingPhase("finished")
            }
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        // Critic #4 fix: synchronously flip isRunning BEFORE the work
        // queue runs.  Any in-flight worker bails at the re-check.
        // Matches iOS V12.1 cancel path.
        arCameraViewRef?.setIncrementalIngestionActive(false)
        isRunning.set(false)
        frameProcessorIngestEnabled.set(false)  // F8.4 — cut producer-thread ingest at cancel
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
        // v0.21 — discard any open sharpness window; the operator
        // aborted, so its buffered best belongs to a dead capture.
        // Reset the shared decision machine + the platform buffer as
        // one unit, under the window lock (an in-flight producer
        // ingest completes or sees the cleared state — never a
        // half-reset window).
        synchronized(sharpnessWindowLock) {
            sharpnessWindow.reset()
            sharpnessBestFrame = null
            sharpnessBestPose = null
            sharpnessBestScore = -1.0
            // v0.23 — the aborted capture's accepted scores and pose
            // anchor describe a scene we're leaving; carrying them into
            // the next capture would mis-calibrate the softness floor
            // and manufacture a bogus first pan-rate sample.
            blurPolicy.resetHistory()
            sharpnessHoldCount = 0
            panRateLastQuat = null
            panRateLastSampleNanos = 0L
            panRateRadPerSec = -1.0
        }
        // Defer the session-dir cleanup onto the work queue so we don't
        // race with an ingest that already passed the null-check and is
        // mid-execution on a captured local reference.
        workScope.launch {
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
     *     capture (the gate's keyframeMaxCount).  NOTE (v0.21.1,
     *     review C — stale-contract fix): both callers encode from a
     *     frame ALREADY PACKED into a JVM NV21 array before this call
     *     (the ARCore Image is closed right after packNV21 — audit
     *     #19; the plugin packs at entry), NOT from a live camera
     *     Image.  The frame therefore outlives this call, which is
     *     what lets the sharpness window buffer winners in RAM via
     *     `retainFrame`.
     *
     * @param grayData    Y-plane (or otherwise grayscale) bytes.
     *                    Length must be ≥ grayStride * grayHeight.
     * @param grayWidth   Image width in pixels.
     * @param grayHeight  Image height in pixels.
     * @param grayStride  Bytes per row; may exceed grayWidth when
     *                    the source plane has padding (ARCore can pad).
     * @param onAccept    Invoked ONLY if the gate accepts this frame
     *                    AND the sharpness window is off (K == 1 /
     *                    gate-disabled passthrough).  Receives the
     *                    absolute target path
     *                    `<captureSessionDir>/keyframe-N.jpg` that the
     *                    callee MUST write a full-resolution JPEG of
     *                    the current camera frame to.  Returns true
     *                    on success, false if the encode/write
     *                    failed (the frame is then dropped; gate
     *                    counter was already incremented, next
     *                    acceptable frame still lands on its own).
     * @param retainFrame v0.21.1 (review C) — returns an encode-ready
     *                    RAM snapshot of THIS frame (the caller's
     *                    already-packed NV21 + the JPEG params the
     *                    caller's onAccept would have used), or null
     *                    for a degenerate frame.  Called at most once
     *                    per frame, only when the sharpness window
     *                    needs to buffer this frame (seed or
     *                    improvement).  Must be side-effect free.
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
        retainFrame: () -> SharpnessCandidateFrame?,
        // 2026-06-16 (audit #8/L3) — the live-engine ingest params
        // (legacyJpegPath / nv21PixelData / nv21PixelWidth/Height) were
        // removed here.  The live engines were archived in 2026-06, so the
        // only remaining path is batch-keyframe (always on), which ingests via
        // `grayData` + `onAccept`.  The TransferredNV21 ownership wrapper had no
        // live consumer (takeOnce() called nowhere — verified by grep) and is
        // deleted along with these params.
    ) {
        // ── V16 batch-keyframe: AR-driven path ─────────────────────
        //
        // Batch-keyframe mode runs WITHOUT a live engine (they were
        // archived in the 2026-06 cleanup) — frames accumulate as
        // keyframe paths and the cv::Stitcher pipeline runs at finalize.
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
            // v0.21.1 (review C) — teardown re-check.  finalize() and
            // cancel() flip isRunning on the bridge thread BEFORE they
            // snapshot/clear the batch state; a producer-thread frame
            // that already passed the view-level ingest gate must not
            // run the gate/save pipeline against a tearing-down
            // capture (pre-fix, a late frame could append a keyframe
            // after finalize snapshotted the path list — silently
            // dropped from the stitch — or race the session-dir
            // delete in cancel()).
            if (!isRunning.get()) return
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
                // v0.21 — pick-sharpest-in-window: a gate-rejected
                // frame that arrives while a window is open is a
                // CANDIDATE for the pending keyframe (the gate
                // necessarily rejects the frames right after an
                // accept — novelty resets there).  Score it, persist
                // it over the buffered best when it wins, close the
                // window (commit the best) once the K−1 candidate
                // slots are used up OR the candidate's own novelty
                // exceeds half the gate threshold (overlap-drift
                // guard — bounds how far the committed frame can
                // drift from the accepted pose, independent of K and
                // the eval cadence).  All decisions come from the
                // shared C++ machine.  No-op when no window is open.
                sharpnessWindowIngestCandidate(
                    decision.newContentFraction,
                    grayData, grayWidth, grayHeight, grayStride,
                    tx, ty, tz, qx, qy, qz, qw,
                    trackingPoor,
                    retainFrame,
                )
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
            // v0.21 — gate-ACCEPTED frame with the sharpness window
            // active (gate enabled + K > 1): do NOT commit
            // immediately.  Open a K-frame window seeded with this
            // frame; the sharpest of the K candidates is the keyframe
            // that gets committed.  K == 1 (and the gate-disabled
            // time-based passthrough) falls through to the pre-v0.21
            // immediate-commit path below, byte-for-byte.
            if (keyframeGate.enabled && sharpnessWindowK > 1) {
                sharpnessWindowHandleAccept(
                    decision.newContentFraction,
                    grayData, grayWidth, grayHeight, grayStride,
                    imageWidth, imageHeight,
                    tx, ty, tz, qx, qy, qz, qw,
                    trackingPoor,
                    retainFrame,
                )
                return
            }

            // Accepted — generate the per-keyframe target path and
            // invoke the caller's onAccept lambda for the lazy JPEG
            // encode + write.  The caller encodes from its per-frame
            // packed NV21 array (the ARCore Image was closed right
            // after packNV21 — audit #19; v0.21.1 review C fixed this
            // comment, which used to claim the Image was still open).
            // Single disk write per accepted frame (pre-0.3 was:
            // write to tmp, then copy to store = two disk writes; now
            // we write to the final path directly).
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
                // v0.7.0 — Tier 1 hook: pose snapshot + accept timestamp
                // threaded through to JS via the existing state-update
                // channel.  `tx,ty,tz,qx,qy,qz,qw` are parameters of
                // `ingestFromARCameraView`; in AR mode they're real
                // ARCore pose components, in non-AR mode they're
                // gyro-synthesised (translation ≈ 0).
                poseQx = qx, poseQy = qy, poseQz = qz, poseQw = qw,
                poseTx = tx, poseTy = ty, poseTz = tz,
                acceptedAtMs = System.currentTimeMillis(),
            )
            return
        }

    }

    // ── v0.21 — pick-sharpest-in-window helpers ─────────────────────
    //
    // See the field-block comment (`sharpnessWindowLock` &co) for the
    // design and the RAM-buffering rationale.  iOS parity:
    // IncrementalStitcher.swift's sharpnessWindowHandleAccept /
    // sharpnessWindowIngestCandidate / flushSharpnessWindow — same
    // window semantics (one shared C++ decision machine), same shared
    // metric, same buffering shape (one retained frame in RAM; iOS
    // deep-copies a CVPixelBuffer, Android grabs a reference to the
    // caller's per-frame packed NV21).

    /// Gate-ACCEPTED frame with the window feature active (K > 1):
    /// consult the shared machine.  OPEN_WINDOW seeds a fresh window
    /// with this frame; FLUSH_THEN_OPEN (force-last / time-budget
    /// accepts can re-accept before the previous window filled)
    /// commits the previous window's best FIRST so a selected keyframe
    /// is never lost, then seeds.
    private fun sharpnessWindowHandleAccept(
        newContentFraction: Double,
        grayData: ByteArray,
        grayWidth: Int,
        grayHeight: Int,
        grayStride: Int,
        imageWidth: Int,
        imageHeight: Int,
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        /// v0.23 — degraded tracking makes the pose delta meaningless
        /// as a pan rate; see samplePanRateLocked.
        trackingPoor: Boolean,
        retainFrame: () -> SharpnessCandidateFrame?,
    ) {
        // Score OUTSIDE the lock (~1-3 ms of OpenCV work) so
        // finalize()/cancel() never block behind it.
        val score = nativeSharpnessScore(
            grayData, grayWidth, grayHeight, grayStride)
        synchronized(sharpnessWindowLock) {
            // Teardown re-check under the lock: finalize/cancel may
            // have raced the scoring above; their window state is
            // authoritative once isRunning flipped.
            if (!isRunning.get()) return
            samplePanRateLocked(qx, qy, qz, qw, trackingPoor)
            val decision = sharpnessWindow.ingest(
                isAccept = true,
                score = score,
                noveltyFraction = newContentFraction,
                overlapThreshold = keyframeGate.overlapThreshold,
            )
            if (decision.action == SharpnessWindow.Action.FLUSH_THEN_OPEN) {
                // v0.23 — NO admission consult here: the gate has
                // already accepted a new frame, so the pending best is
                // about to be overwritten by the seed below.  Holding
                // would drop a selected keyframe rather than defer it,
                // which the fail-open contract forbids.
                val pendingScore = sharpnessBestScore
                val committed = commitSharpnessWindowLocked("new-accept")
                // Guarded so the disabled configuration crosses no JNI
                // boundary at all on this path.
                if (committed && blurPolicy.admissionEnabled) {
                    blurPolicy.recordAccepted(pendingScore)
                }
            }
            // Seed the (new) window: retain this frame in RAM (a
            // reference grab — the caller's packed NV21 already
            // outlives this call).  The JPEG encode happens once, at
            // commit.
            val frame = retainFrame()
            if (frame == null) {
                // Degenerate frame (packNV21 shape the encoder can't
                // take) — drop the accept, same as the pre-v0.21
                // path's onAccept-false handling.  Reset the machine
                // so its freshly-opened window can't outlive the
                // missing seed.
                sharpnessWindow.reset()
                sharpnessBestFrame = null
                sharpnessBestPose = null
                sharpnessBestScore = -1.0
                android.util.Log.w(
                    "IncrementalStitcher",
                    "sharpnessWindowHandleAccept: retainFrame returned " +
                        "null — accept dropped",
                )
                return
            }
            sharpnessBestFrame = frame
            sharpnessBestPose = doubleArrayOf(tx, ty, tz, qx, qy, qz, qw)
            sharpnessBestNewContentFraction = newContentFraction
            sharpnessBestIsLandscape = imageWidth >= imageHeight
            sharpnessBestScore = score
            // v0.23 — a fresh pending keyframe starts with a clean hold
            // budget; the cap counts holds of the SAME frame.
            sharpnessHoldCount = 0
            android.util.Log.i(
                "IncrementalStitcher",
                "sharpness window OPEN k=$sharpnessWindowK " +
                    "seedScore=${"%.1f".format(score)}",
            )
        }
    }

    /// Score one gate-rejected frame against the open window's best
    /// (streaming max, buffered in RAM — the shared machine decides).
    /// No-op when no window is open.
    private fun sharpnessWindowIngestCandidate(
        newContentFraction: Double,
        grayData: ByteArray,
        grayWidth: Int,
        grayHeight: Int,
        grayStride: Int,
        tx: Double, ty: Double, tz: Double,
        qx: Double, qy: Double, qz: Double, qw: Double,
        /// v0.23 — see samplePanRateLocked.
        trackingPoor: Boolean,
        retainFrame: () -> SharpnessCandidateFrame?,
    ) {
        // Cheap open-check before the multi-ms score.
        synchronized(sharpnessWindowLock) {
            if (sharpnessBestFrame == null || !sharpnessWindow.isOpen) return
        }
        val score = nativeSharpnessScore(
            grayData, grayWidth, grayHeight, grayStride)
        synchronized(sharpnessWindowLock) {
            // Re-check: finalize/cancel may have consumed the window
            // while we were scoring.
            if (sharpnessBestFrame == null || !sharpnessWindow.isOpen) return
            samplePanRateLocked(qx, qy, qz, qw, trackingPoor)
            val decision = sharpnessWindow.ingest(
                isAccept = false,
                score = score,
                noveltyFraction = newContentFraction,
                overlapThreshold = keyframeGate.overlapThreshold,
            )
            if (decision.replaceBest) {
                val frame = retainFrame()
                if (frame != null) {
                    sharpnessBestFrame = frame
                    sharpnessBestPose = doubleArrayOf(tx, ty, tz, qx, qy, qz, qw)
                    sharpnessBestScore = score
                    android.util.Log.i(
                        "IncrementalStitcher",
                        "sharpness window IMPROVED score=${"%.1f".format(score)}",
                    )
                }
                // null retain (degenerate frame) keeps the previous
                // best; the machine's streaming max advanced past it —
                // the only cost of this rare edge is that a later
                // candidate must beat THIS frame's score to replace
                // the buffer.
            }
            if (decision.action == SharpnessWindow.Action.CLOSE_AND_SAVE) {
                closeOrHoldWindowLocked(
                    reason = if (decision.driftClosed) "novelty-drift" else "window-full",
                    driftClosed = decision.driftClosed,
                )
            }
        }
    }

    /// v0.23 — the ADMISSION point.  The window machine has decided to
    /// close; the anti-blur policy gets the last word on whether the
    /// buffered best is good enough to write.
    ///
    /// Commit  → write it, feed its score to the running median (so the
    ///           softness floor calibrates on what this scene actually
    ///           yields), clear the hold counter.
    /// Hold*   → keep the buffered best and RE-OPEN the window seeded
    ///           with its own score, so the K−1 frames that arrive
    ///           while the operator steadies compete against it exactly
    ///           as normal candidates.  Re-seeding is what makes a hold
    ///           worth anything: leaving the machine closed would just
    ///           commit the same soft frame later.
    ///
    /// A NOVELTY-DRIFT close is exempt and commits unconditionally.
    /// That guard fires before the score comparison, so once it is
    /// firing no later candidate can compete for the buffer — a hold
    /// there could not improve the keyframe, only postpone it (and burn
    /// the hold budget that the window-full path needs).  Consequence,
    /// stated plainly: on pans fast enough that every window ends in
    /// drift rather than in exhausted slots, the motion gate has no
    /// teeth.  The lever for that regime is the exposure cap, which on
    /// Android only the host can apply (see `antiBlurMaxExposureMs`).
    ///
    /// Bounded by construction: `maxConsecutiveHolds` caps the retries
    /// natively, and even with the cap disabled the next gate-accept
    /// (FlushThenOpen) or finalize commits unconditionally.
    ///
    /// Caller MUST hold `sharpnessWindowLock`.
    private fun closeOrHoldWindowLocked(reason: String, driftClosed: Boolean) {
        // Default-off fast path: with both gates at 0 the shared C++
        // would answer Commit for every input, so skip the crossing
        // entirely and stay byte-identical to v0.22.
        if (!blurPolicy.admissionEnabled || driftClosed) {
            val pendingScore = sharpnessBestScore
            val committed = commitSharpnessWindowLocked(reason)
            if (blurPolicy.admissionEnabled) {
                // A drift-closed keyframe is still one this capture
                // accepted, so it still calibrates the softness floor.
                if (committed) blurPolicy.recordAccepted(pendingScore)
                sharpnessHoldCount = 0
            }
            return
        }
        // Nothing buffered: the commit helper is a no-op and there is
        // no candidate to judge.
        if (sharpnessBestFrame == null) return
        val verdict = blurPolicy.admit(
            candidateScore = sharpnessBestScore,
            panRateRadPerSec = panRateRadPerSec,
            consecutiveHolds = sharpnessHoldCount,
        )
        if (verdict == BlurPolicy.Admission.COMMIT) {
            val pendingScore = sharpnessBestScore
            // The pending frame is consumed either way (the commit
            // helper clears the buffer before it can fail), so the hold
            // budget resets regardless; only a keyframe that actually
            // landed belongs in the median.
            if (commitSharpnessWindowLocked(reason)) {
                blurPolicy.recordAccepted(pendingScore)
            }
            sharpnessHoldCount = 0
            return
        }
        // Re-open around the buffered best.  If the machine refuses
        // (K == 1, nothing scored, window somehow still open) there is
        // nowhere for the pending keyframe to live, so COMMIT — a held
        // frame with no open window would sit untouched until finalize.
        if (!sharpnessWindow.reopenKeepingBest()) {
            val pendingScore = sharpnessBestScore
            if (commitSharpnessWindowLocked(reason)) {
                blurPolicy.recordAccepted(pendingScore)
            }
            sharpnessHoldCount = 0
            return
        }
        sharpnessHoldCount += 1
        android.util.Log.i(
            "IncrementalStitcher",
            "sharpness window HOLD ($reason) verdict=$verdict " +
                "holds=$sharpnessHoldCount/${blurPolicy.maxConsecutiveHolds} " +
                "score=${"%.1f".format(sharpnessBestScore)} " +
                "median=${"%.1f".format(blurPolicy.medianScore)} " +
                "panRate=${"%.2f".format(panRateRadPerSec)}",
        )
    }

    /// v0.23 — update the pan-rate estimate from consecutive frame
    /// orientations.  Deliberately NOT a SensorManager listener: the
    /// pose already reaching this engine (ARCore in AR mode, the
    /// gyro-integrated quaternion the JS driver supplies in non-AR
    /// mode) carries the same rotation, costs nothing extra, and can't
    /// add a sensor lifecycle to get wrong.
    ///
    /// Every degenerate case resolves to -1.0 (the shared C++ "unknown"
    /// sentinel → motion gate skipped): degraded tracking, a non-unit
    /// quaternion, a missing anchor, or a sample interval outside the
    /// plausible frame-cadence band.  The wide dt band matters because
    /// the window only feeds us frames while it is open, so a gap
    /// between windows must re-anchor rather than divide a large
    /// rotation by a large dt.  The tracking guard matters most for
    /// ARCore relocalisation: a snap can move the pose by radians
    /// between frames, and reporting that as a pan rate would hold
    /// every commit until the cap broke the streak.
    ///
    /// Caller MUST hold `sharpnessWindowLock`.
    private fun samplePanRateLocked(
        qx: Double, qy: Double, qz: Double, qw: Double,
        trackingPoor: Boolean,
    ) {
        // No motion gate armed → don't even track (default-off path).
        if (blurPolicy.maxCommitPanRateRadPerSec <= 0.0) return
        val norm = kotlin.math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        if (trackingPoor || !norm.isFinite() || norm < 0.9 || norm > 1.1) {
            // Hosts that supply no orientation at all send zeros here.
            // Dropping the anchor (not just the rate) stops the frame
            // AFTER a bad one from measuring across the gap.
            panRateLastQuat = null
            panRateRadPerSec = -1.0
            return
        }
        val q = doubleArrayOf(qx / norm, qy / norm, qz / norm, qw / norm)
        val now = android.os.SystemClock.elapsedRealtimeNanos()
        val prev = panRateLastQuat
        val prevNanos = panRateLastSampleNanos
        panRateLastQuat = q
        panRateLastSampleNanos = now
        if (prev == null || prevNanos <= 0L) {
            panRateRadPerSec = -1.0
            return
        }
        val dtSec = (now - prevNanos) / 1_000_000_000.0
        // 1 ms floor guards against a divide-by-almost-zero.  The
        // ceiling must clear the SLOWEST legal evaluation cadence, not
        // just the frame rate: `flowEvalEveryNFrames` is clamped to 10
        // and the JS driver's throttle stacks on top, so samples can sit
        // ~300+ ms apart on a legal config — a 250 ms ceiling rejected
        // every one of them and left the motion gate permanently (and
        // silently) inert.  1.0 s still keeps a genuine stall out, and
        // matches the iOS bound so both platforms gate alike.
        if (dtSec < 0.001 || dtSec > 1.0) {
            panRateRadPerSec = -1.0
            return
        }
        // Angle of the relative rotation between the two orientations:
        // |q0 · q1| = cos(theta/2).  abs() collapses the double-cover
        // (q and -q are the same rotation), so the result is always the
        // short way round.
        val dot = kotlin.math.abs(
            prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3])
        val angle = 2.0 * kotlin.math.acos(dot.coerceIn(0.0, 1.0))
        val rate = angle / dtSec
        panRateRadPerSec = if (rate.isFinite()) rate else -1.0
    }

    /// perf-4a — read the long edge (max of width/height) of the FIRST
    /// keyframe via a header-only decode (inJustDecodeBounds — no pixel
    /// decode, ~1 ms) so the adaptive-resolution key reflects what was
    /// actually captured (640 vs 1280 px), not a prop. Returns 0 (its own
    /// bucket) on any read failure.
    private fun firstKeyframeLongEdge(paths: List<String>): Int {
        val p = paths.firstOrNull() ?: return 0
        return try {
            val opts = android.graphics.BitmapFactory.Options().apply {
                inJustDecodeBounds = true
            }
            android.graphics.BitmapFactory.decodeFile(p, opts)
            kotlin.math.max(opts.outWidth, opts.outHeight).coerceAtLeast(0)
        } catch (t: Throwable) {
            0
        }
    }

    /// Close the window: JPEG-encode the buffered best ONCE (the only
    /// encode the window path ever performs), commit the path to
    /// `batchKeyframePaths`, record the pose bookkeeping, and emit the
    /// accepted-state event JS renders in LiveFrameStrip (including at
    /// finalize — iOS review-d1 parity: the trailing keyframe must
    /// reach the thumbnail strip).
    ///
    /// Caller MUST hold `sharpnessWindowLock`.  Idempotent: the
    /// buffered best is cleared up-front, so a second call (or a call
    /// with no pending window) is a no-op — a producer's window-full
    /// commit and finalize's drain-commit can never double-append.
    ///
    /// v0.23 — returns true only when a keyframe actually landed in
    /// `batchKeyframePaths`.  The admission policy feeds its running
    /// median from that signal, so a dropped encode must not calibrate
    /// the softness floor against a frame nobody will ever stitch.
    private fun commitSharpnessWindowLocked(reason: String): Boolean {
        val frame = sharpnessBestFrame ?: return false
        val pose = sharpnessBestPose
        val newContent = sharpnessBestNewContentFraction
        val isLandscape = sharpnessBestIsLandscape
        // Sticky post-close score from the machine (for the log line).
        val score = sharpnessWindow.bestScore
        sharpnessBestFrame = null
        sharpnessBestPose = null
        sharpnessBestNewContentFraction = -1.0
        sharpnessBestScore = -1.0
        val dir = captureSessionDir
        if (dir == null) {
            android.util.Log.w(
                "IncrementalStitcher",
                "commitSharpnessWindow($reason): captureSessionDir is " +
                    "null — keyframe dropped",
            )
            return false
        }
        val path = java.io.File(
            dir, "keyframe-${batchKeyframePaths.size}.jpg"
        ).absolutePath
        // The single JPEG encode for this keyframe, under the window
        // lock — after this returns there is no pending write left
        // that could land after a finalize snapshot (the
        // rename-after-commit race the disk-buffered first cut had).
        val ok = try {
            YuvImageConverter.encodeJpegFromNV21(
                frame.packed,
                path,
                jpegQuality = frame.jpegQuality,
                displayRotation = frame.displayRotation,
            ) != null
        } catch (t: Throwable) {
            android.util.Log.w(
                "IncrementalStitcher",
                "commitSharpnessWindow($reason): encode threw for $path: " +
                    "${t.javaClass.simpleName}: ${t.message}",
                t,
            )
            false
        }
        if (!ok) {
            android.util.Log.w(
                "IncrementalStitcher",
                "commitSharpnessWindow($reason): encode failed — " +
                    "keyframe dropped",
            )
            return false
        }
        batchKeyframePaths.add(path)
        if (pose != null) {
            if (batchFirstAcceptedPose == null) batchFirstAcceptedPose = pose
            batchLastAcceptedPose = pose
        }
        android.util.Log.i(
            "IncrementalStitcher",
            "sharpness window COMMIT ($reason) " +
                "score=${"%.1f".format(score)} " +
                "keyframe #${batchKeyframePaths.size} → $path",
        )
        emitBatchKeyframeAcceptedState(
            thumbnailPath = path,
            keyframeIndex = batchKeyframePaths.size - 1,
            keyframeCount = batchKeyframePaths.size,
            keyframeMax = keyframeGate.maxCount,
            isLandscape = isLandscape,
            newContentFraction = newContent,
            poseQx = pose?.get(3) ?: 0.0,
            poseQy = pose?.get(4) ?: 0.0,
            poseQz = pose?.get(5) ?: 0.0,
            poseQw = pose?.get(6) ?: 0.0,
            poseTx = pose?.get(0) ?: 0.0,
            poseTy = pose?.get(1) ?: 0.0,
            poseTz = pose?.get(2) ?: 0.0,
            acceptedAtMs = System.currentTimeMillis(),
        )
        return true
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
    // keyframe gate, but the JPEG encode needs the full Y +
    // interleaved VU planes.  The Image itself is only valid until
    // the plugin callback returns (vision-camera closes the
    // ImageProxy automatically), so this wrapper packs the FULL NV21
    // into a JVM array at entry (F8.6) and everything downstream —
    // the gate read, the accept-path encode, and the sharpness
    // window's RAM retention — runs on that copy, which freely
    // outlives the callback.  (v0.21.1 review C fixed this comment:
    // it used to claim the encode read the live Image and therefore
    // had to complete synchronously.)
    //
    // ## Threading
    //
    // Called on vision-camera's frame-processor thread (a single-
    // thread executor).  `frameProcessorIngestEnabled` is read
    // lock-free via AtomicBoolean.  In the current batch-keyframe-only
    // engine `consumeFrameFromPlugin` / `ingestFromARCameraView` run the
    // keyframe-gate evaluation and (on accept) the JPEG encode
    // SYNCHRONOUSLY on this producer thread — there is NO workExecutor
    // dispatch on the ingest path (the only workExecutor.launch sites are
    // finalize + cancel-cleanup).  So producer-thread blocking is bounded
    // to that synchronous gate + encode — typically 5–10 ms reject,
    // 30–50 ms accept on a mid-tier device — and ingest is INDEPENDENT of
    // the finalize/refine native-stitch mutex (perf-3b item 1): a stitch
    // holding that lock never stalls frame ingestion here.
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

        // Shared by the accept-path encode AND the sharpness window's
        // commit-time encode (via retainFrame), so the two produce
        // byte-identical EXIF rotation handling.
        val displayRotation = when (sensorRotationDegrees) {
            0   -> android.view.Surface.ROTATION_90
            90  -> android.view.Surface.ROTATION_0
            180 -> android.view.Surface.ROTATION_270
            270 -> android.view.Surface.ROTATION_180
            else -> android.view.Surface.ROTATION_0
        }

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
            retainFrame = {
                // v0.21.1 (review C) — RAM retention for the sharpness
                // window: the NV21 was packed at entry and outlives
                // this callback, so this is a reference grab (no
                // copy).  Encode params mirror the onAccept lambda
                // above so the commit-time encode is byte-identical.
                SharpnessCandidateFrame(
                    packed = packed,
                    displayRotation = displayRotation,
                    jpegQuality = 80,
                )
            },
        )
    }

    @ReactMethod
    fun getState(promise: Promise) {
        // The live engines exposed a cached `lastState` snapshot; the
        // batch-keyframe path (the only engine now) drives state purely
        // through emitted IncrementalStateUpdate events, so there is no
        // poll-able snapshot to return.  (Batch-keyframe captures already
        // returned null here — engine/firstwinsEngine were both null.)
        promise.resolve(null)
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
        val requestedCount = framePathsArr?.size() ?: 0
        // v0.10.0 #15A — emit `validating` at the very top so JS sees
        // refine activity even when validation fails fast.  Frames may
        // be empty here; report whatever the caller asked for.
        emitRefineProgress(
            stage = "validating",
            fraction = 0.05,
            frames = requestedCount,
            errorMessage = null,
        )
        if (framePathsArr == null || framePathsArr.size() < 2) {
            val msg = "refinePanorama requires at least 2 framePaths (got " +
                "$requestedCount)."
            emitRefineProgress(
                stage = "error",
                fraction = 1.0,
                frames = requestedCount,
                errorMessage = msg,
            )
            promise.reject("incremental-refine-invalid-input", msg)
            return
        }
        val framePaths = Array(framePathsArr.size()) {
            stripFileScheme(framePathsArr.getString(it) ?: "")
        }
        val outputPathOpt = options.getString("outputPath")
        if (outputPathOpt.isNullOrEmpty()) {
            val msg = "refinePanorama requires a non-empty outputPath."
            emitRefineProgress(
                stage = "error",
                fraction = 1.0,
                frames = framePaths.size,
                errorMessage = msg,
            )
            promise.reject("incremental-refine-invalid-input", msg)
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
        // 2026-06-15 — pipeline is caller-selectable (mirrors iOS'
        // refinePanorama `refineManual`).  The on-demand HIGH-LEVEL
        // preview tab (Camera.tsx requestHighLevelAlt) calls
        // refinePanorama with useManualPipeline:false to re-stitch the
        // captured keyframes via stock cv::Stitcher.  Default false
        // (high-level) preserves the refine path's historical
        // cv::Stitcher behaviour.
        val useManualPipeline =
            config?.getBooleanOrDefault("useManualPipeline", false) ?: false
        val jpegQuality = max(1, min(100,
            config?.getIntOrDefault("jpegQuality", 90) ?: 90))
        // perf-3b — the re-stitch must use the SAME range-matcher width the
        // original finalize used, or the preview differs from the capture.
        // Prefer an explicit refine-config value; else fall back to the
        // session field set at start() (0 if the module was never started).
        val refineRangeMatcherWidth = (config
            ?.getIntOrDefault("stitchRangeMatcherWidth", stitchRangeMatcherWidth)
            ?: stitchRangeMatcherWidth).coerceAtLeast(0)

        // Pre-flight existence check — same defensive layer iOS has.
        for (p in framePaths) {
            if (!File(p).exists()) {
                val msg = "refinePanorama: keyframe missing on disk — $p"
                emitRefineProgress(
                    stage = "error",
                    fraction = 1.0,
                    frames = framePaths.size,
                    errorMessage = msg,
                )
                promise.reject("incremental-refine-missing-keyframe", msg)
                return
            }
        }

        refineScope.launch {
            try {
                emitRefineProgress(
                    stage = "stitching",
                    fraction = 0.1,
                    frames = framePaths.size,
                    errorMessage = null,
                )
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
                    // captureOrientation flows through so the high-level
                    // re-stitch bakes the SAME rotation the capture used
                    // — without it the output is sideways (raw sensor
                    // landscape).  The high-level tab passes back the
                    // orientation the finalize emitted.
                    captureOrientation,
                    useInscribedRectCrop,
                    stitchMode = effectiveMode,
                    // false = stock high-level cv::Stitcher (the on-demand
                    // HIGH-LEVEL preview tab); true would force the manual
                    // pipeline.  Sourced from the JS config above.
                    useManualPipeline = useManualPipeline,
                    rangeMatcherWidth = refineRangeMatcherWidth,  // perf-3b — match finalize
                    numThreads = stitchNumThreads,   // perf-3b item 1 (0 = auto-multi)
                )
                // Stitch returned — BatchStitcher writes the JPEG
                // synchronously, so "writing" reflects the final
                // assembly + file I/O cost (which has already been
                // paid by this point in practice).  Emit so JS can
                // flip its label from "Stitching" to "Writing"
                // before the done event fires.
                emitRefineProgress(
                    stage = "writing",
                    fraction = 0.9,
                    frames = framePaths.size,
                    errorMessage = null,
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
                    // DEV overlay — the high-level re-stitch's recipe so the
                    // pill shows pipe/warp/route/seam/blend on the high-level tab.
                    val dbg = stitcher.lastDebugSummary
                    if (dbg.isNotEmpty()) putString("debugSummary", dbg)
                }
                emitRefineProgress(
                    stage = "done",
                    fraction = 1.0,
                    frames = framePaths.size,
                    errorMessage = null,
                )
                promise.resolve(map)
            } catch (t: Throwable) {
                emitRefineProgress(
                    stage = "error",
                    fraction = 1.0,
                    frames = framePaths.size,
                    errorMessage = t.message ?: t.javaClass.simpleName,
                )
                promise.reject("incremental-refine-failed", t.message, t)
            }
        }
    }


    /**
     * v0.10.0 #15A — emit a refine-pipeline phase update on the same
     * `IncrementalStateUpdate` channel that carries `isRefining` /
     * `refinedPanoramaPath`.  Five `stage` values fire across the
     * lifetime of one `refinePanorama` call:
     *
     *   - "validating" (fraction 0.05) — synchronous input checks
     *   - "stitching"  (fraction 0.10) — start of the OpenCV stitch
     *   - "writing"    (fraction 0.90) — stitch returned, JPEG written
     *   - "done"       (fraction 1.00) — promise about to resolve
     *   - "error"      (fraction 1.00) — failure path (errorMessage
     *                                    is non-null)
     *
     * Coarse on purpose: OpenCV's Stitcher doesn't expose stage-by-
     * stage callbacks, so the 0.10 → 0.90 jump is one opaque step.
     * JS uses `stage` for the UI label and `fraction` for the spinner.
     *
     * iOS sibling: IncrementalStitcher.swift::emitRefineProgress.
     * Field names + stage strings are kept identical so the JS
     * subscriber in src/stitching/incremental.ts doesn't branch on
     * platform.
     */
    private fun emitRefineProgress(
        stage: String,
        fraction: Double,
        frames: Int?,
        errorMessage: String?,
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
            putString("refineStage", stage)
            putDouble("refineProgress", fraction)
            if (frames != null) {
                putInt("refineFrames", frames)
            }
            if (errorMessage != null) {
                putString("refineError", errorMessage)
            }
        }
        emitState(state)
    }


    /**
     * Poll the process' memory footprint in MB.  Android parity for
     * iOS' `getMemoryFootprintMB` (which polls Mach `phys_footprint`
     * via `task_info(TASK_VM_INFO)` — see
     * `IncrementalStitcherBridge.swift:231-259`).
     *
     * Returns the process **RSS** (resident set size) in MB, read from
     * `/proc/self/statm` (resident-pages × page-size).  RSS is what the shared
     * C++ `[memstat]` lines report (`rss_mb()` reads the same `/proc`), so the
     * pill and the stitch logs show the SAME number — handy when correlating a
     * spike with a logcat trace.
     *
     * Why not `ActivityManager.getProcessMemoryInfo().totalPss`?  It's
     * RATE-LIMITED on Android 8+ (returns a cached value when polled often), so
     * at the pill's 500 ms cadence it froze at the launch-time reading and never
     * moved.  `/proc/self/statm` is a single unthrottled read.
     *
     * Returns -1.0 on failure (very rare — `/proc/self/statm` is always present
     * and cheap to read on the calling thread).
     */
    @ReactMethod
    fun getMemoryFootprintMB(promise: Promise) {
        try {
            // Read RSS from /proc/self/statm (field[1] = resident pages).  This
            // is UNTHROTTLED and matches the C++ [memstat] rss_mb() in logcat, so
            // the pill tracks the same number I read from the stitch logs.
            //
            // 2026-06-15 — was ActivityManager.getProcessMemoryInfo().totalPss,
            // which is RATE-LIMITED on Android 8+: polled frequently (the pill
            // ticks every 500 ms) it returns a CACHED value, so the pill froze at
            // its launch-time reading (~310 MB) and never showed the stitch spike.
            val fields = java.io.File("/proc/self/statm")
                .readText().trim().split(' ')
            val residentPages = fields[1].toLong()
            val pageSize =
                android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE)
            val mb = residentPages.toDouble() * pageSize.toDouble() /
                (1024.0 * 1024.0)
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
     * Total physical RAM in MB.  Lets the DEV memory pill derive RAM-aware
     * pressure bands instead of the iPhone-fixed 1500/2200 MB thresholds (which
     * never trip on a 4 GB Android phone that jetsams ~1.3 GB — false comfort).
     * Reads `_SC_PHYS_PAGES × _SC_PAGE_SIZE` (TOTAL + stable across runs, unlike
     * the rate-limited ActivityManager path).  -1.0 on failure.
     */
    @ReactMethod
    fun getDeviceTotalRamMB(promise: Promise) {
        try {
            val pages = android.system.Os.sysconf(android.system.OsConstants._SC_PHYS_PAGES)
            val pageSize =
                android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE)
            if (pages <= 0 || pageSize <= 0) {
                promise.resolve(-1.0)
                return
            }
            promise.resolve(pages.toDouble() * pageSize.toDouble() / (1024.0 * 1024.0))
        } catch (t: Throwable) {
            android.util.Log.w(
                "IncrementalStitcher",
                "getDeviceTotalRamMB: failed: ${t.message}",
            )
            promise.resolve(-1.0)
        }
    }

    /// perf-3b item 1 — guards teardownOnce() so the native-heap + executor
    /// cleanup runs exactly once even if BOTH invalidate() and the deprecated
    /// onCatalystInstanceDestroy() fire (RN version-dependent).
    private val didTeardown = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Idempotent module teardown: release the C++ KeyframeGate +
     * SharpnessWindow native heap, the per-session dir, the static back-
     * pointer, and the dedicated stitch/refine executor threads.
     *
     * Invoked from BOTH `invalidate()` (the RN 0.74+ / New-Architecture
     * teardown hook — under bridgeless/New Arch the framework calls
     * invalidate(), NOT onCatalystInstanceDestroy()) and the deprecated
     * `onCatalystInstanceDestroy()` (older RN), guarded so it runs once.
     * Without routing through invalidate(), on RN 0.84 New Arch none of this
     * cleanup ran and every JS reload leaked native heap + 2 daemon threads.
     */
    private fun teardownOnce() {
        if (!didTeardown.compareAndSet(false, true)) return
        try {
            keyframeGate.close()
        } catch (t: Throwable) {
            android.util.Log.w("IncrementalStitcher", "teardown: keyframeGate.close failed: ${t.message}")
        }
        // v0.21.1 — release the shared-C++ sharpness-window machine's
        // native allocation too (same lifecycle as keyframeGate).
        try {
            sharpnessWindow.close()
        } catch (t: Throwable) {
            android.util.Log.w("IncrementalStitcher", "teardown: sharpnessWindow.close failed: ${t.message}")
        }
        // v0.23 — same for the admission policy's running-median
        // allocation (one small C++ object per module instance).
        try {
            blurPolicy.close()
        } catch (t: Throwable) {
            android.util.Log.w(
                "IncrementalStitcher",
                "onCatalystInstanceDestroy: blurPolicy.close failed: ${t.message}",
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
        // F8.4 — release the static back-pointer so the Frame Processor
        // plugin sees a clean nil after bridge teardown.  A new bridge will
        // set it again via the init block.
        if (bridgeInstance === this) {
            bridgeInstance = null
        }
        // perf-3b item 1 — release the dedicated stitch/refine threads so they
        // don't accumulate across dev-time RN reloads.  shutdown() (not
        // shutdownNow()) lets an in-flight stitch finish rather than
        // interrupting it mid-cv::Stitcher.
        try { workExecutor.shutdown() } catch (t: Throwable) {
            android.util.Log.w("IncrementalStitcher", "teardown: workExecutor.shutdown failed: ${t.message}")
        }
        try { refineExecutor.shutdown() } catch (t: Throwable) {
            android.util.Log.w("IncrementalStitcher", "teardown: refineExecutor.shutdown failed: ${t.message}")
        }
    }

    /**
     * RN 0.74+ / New-Architecture teardown hook.  Under bridgeless/New Arch
     * the framework tears modules down via invalidate() and NEVER calls the
     * deprecated onCatalystInstanceDestroy().
     */
    override fun invalidate() {
        teardownOnce()
        super.invalidate()
    }

    /**
     * Deprecated pre-0.74 teardown hook, retained for older-RN consumers
     * (peerDep is RN >= 0.72).  Delegates to the same idempotent teardown.
     */
    @Suppress("DEPRECATION")
    override fun onCatalystInstanceDestroy() {
        teardownOnce()
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
     * Emit a "StitchingPhaseChanged" event so the host's JS layer can
     * pause or resume vision-camera during the stitch.  In non-AR mode
     * the camera + frame-processor thread continue at 30 fps during
     * the multi-second stitch, eating CPU the cv::Stitcher worker
     * needs.  Host code can listen:
     *
     *   DeviceEventEmitter.addListener('StitchingPhaseChanged', ({ phase }) => {
     *     if (phase === 'started') camera.current?.pause();
     *     if (phase === 'finished') camera.current?.resume();
     *   });
     */
    private fun emitStitchingPhase(phase: String) {
        try {
            val payload = Arguments.createMap()
            payload.putString("phase", phase)
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("StitchingPhaseChanged", payload)
        } catch (t: Throwable) {
            // Best-effort — don't let an emission failure break the
            // stitch lifecycle.
            android.util.Log.w(
                "IncrementalStitcher",
                "emitStitchingPhase($phase) failed: ${t.message}",
            )
        }
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
     *
     * Emit throttle is OFF by default (rejectEmitMinIntervalNanos = 0),
     * matching iOS, which never throttles reject emits.  A host that
     * needs to cap bridge traffic on an old-arch device can opt in via
     * the `rejectEmitMinIntervalMs` config key (set in start()).  Accept
     * events are NEVER throttled — they carry thumbnails the UI must show
     * immediately.  (The 7df2dba commit's hardcoded 250 ms throttle was
     * removed: measured placebo, and it staled the overlap-% overlay.)
     */
    private var lastRejectEmitNanos: Long = 0L
    /// Min interval between reject emits, nanos.  0 = off (default).
    /// Set from the `rejectEmitMinIntervalMs` start() config key.
    private var rejectEmitMinIntervalNanos: Long = 0L
    private fun emitBatchKeyframeRejectState(
        decision: KeyframeGateDecision,
        keyframeCount: Int,
        keyframeMax: Int,
        isLandscape: Boolean,
    ) {
        // Optional time-based throttle (default off): skip if an interval
        // is configured and too little time has passed since the last emit.
        val now = System.nanoTime()
        if (rejectEmitMinIntervalNanos > 0L &&
            now - lastRejectEmitNanos < rejectEmitMinIntervalNanos) return
        lastRejectEmitNanos = now

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
        // v0.7.0 — Tier 1 hook fields.  Pose is the AR pose at the
        // accept moment (gyro-synthesised in non-AR mode — translation
        // reads as ~zeros).  `acceptedAtMs` is wall-clock ms since
        // Unix epoch; matches `Date.now()` on the JS side.
        poseQx: Double, poseQy: Double, poseQz: Double, poseQw: Double,
        poseTx: Double, poseTy: Double, poseTz: Double,
        acceptedAtMs: Long,
    ) {
        val state = Arguments.createMap()
        state.putNull("panoramaPath")
        state.putInt("width", 0)
        state.putInt("height", 0)
        state.putInt("acceptedCount", keyframeCount)
        // Outcome 0 = AcceptedHigh.  Keeps the iOS IncrementalOutcome
        // contract: batch-keyframe accepts all carry outcome=acceptedHigh.
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
        // v0.7.0 — Tier 1 hook (useKeyframeStream) reads these.  See
        // `AcceptedKeyframe` in src/stitching/incremental.ts.  Translation
        // is always emitted; AR mode populates it from the camera
        // transform, non-AR mode reads ~zeros (gyro-only, no spatial
        // anchor).
        val pose = Arguments.createMap()
        val rotation = Arguments.createArray()
        rotation.pushDouble(poseQx)
        rotation.pushDouble(poseQy)
        rotation.pushDouble(poseQz)
        rotation.pushDouble(poseQw)
        pose.putArray("rotation", rotation)
        val translation = Arguments.createArray()
        translation.pushDouble(poseTx)
        translation.pushDouble(poseTy)
        translation.pushDouble(poseTz)
        pose.putArray("translation", translation)
        state.putMap("batchKeyframePose", pose)
        state.putDouble("batchKeyframeAcceptedAtMs", acceptedAtMs.toDouble())
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
    /**
     * Result of [resolveStitchModeAuto]: the chosen mode PLUS the gyro rotation
     * magnitude that drove the decision.  rRadians is surfaced to JS (the dev
     * 3-tab preview shows it) so the panorama-vs-SCANS rotation threshold can be
     * tuned from real captures.  rRadians is 0.0 only on the no-pose fallbacks
     * (non-AR with no pose data) — there is no gyro-derived rotation to report.
     */
    private data class StitchModeResolution(
        val mode: String,
        val rRadians: Double,
        // tMeters = translation magnitude (m) that fed the ratio; ratio = the
        // tScore/(tScore+rScore) decision value (>=0.55 → SCANS). Surfaced to the
        // dev readout so the panorama-vs-SCANS threshold can be tuned from real
        // captures, alongside rRadians.
        val tMeters: Double,
        val ratio: Double,
    )

    private fun resolveStitchModeAuto(
        firstPose: DoubleArray?,
        lastPose: DoubleArray?,
        // 2026-05-22 (audit F2b) — JS-measured cumulative IMU
        // translation in METRES.  Used as a fallback when pose-derived
        // translation is 0 (non-AR mode).
        imuTranslationMetres: Double = 0.0,
    ): StitchModeResolution {
        if (firstPose == null || lastPose == null) {
            // No pose data at all — fall back on the IMU signal.  IMU
            // > 5 cm hints SCANS; everything else hints PANORAMA.
            return StitchModeResolution(
                if (imuTranslationMetres > 0.05) "scans" else "panorama", 0.0, 0.0, 0.0)
        }
        if (firstPose.size != 7 || lastPose.size != 7) {
            return StitchModeResolution(
                if (imuTranslationMetres > 0.05) "scans" else "panorama", 0.0, 0.0, 0.0)
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
        val rRadians = rotationRadians(firstPose, lastPose)

        // Normalisation: 10 cm of translation ≈ 1 rad of rotation as
        // "equivalent magnitude" for the ratio.  Empirically: shelf
        // scans cover ~30 cm of translation with ~10° (0.17 rad) of
        // rotation.  ratio = (0.30/0.10) / (3.0 + 0.17) = 0.95 → SCANS.
        // Pure 90° rotation panorama: 0 translation, 1.57 rad rotation.
        // ratio = 0 / (0 + 1.57) = 0.0 → PANORAMA.
        val tScore = tMeters / 0.10
        val rScore = rRadians / 1.00
        val denom = tScore + rScore
        if (denom <= 1e-9) return StitchModeResolution("panorama", rRadians, tMeters, 0.0)  // no motion
        val ratio = tScore / denom

        // 2026-06-15 — LOW-ROTATION GUARD.  The gyro rotation (rRadians) is
        // trustworthy; the IMU translation (tMeters, in non-AR) is NOT — a
        // continuous rotation leaks gravity into the double-integrated accel and
        // inflates it, which can falsely push `ratio` over 0.55 → SCANS, whose
        // affine warper can't represent the rotation.  So when the gyro shows a
        // clear pan (> ~20°) with only modest translation, force PANORAMA
        // regardless of the (possibly-inflated) translation.  Genuine shelf
        // scans (low rotation, large real translation) skip this and still
        // reach SCANS via the ratio.  (Conservative: keeps the tMeters cap so a
        // genuine large-translation capture isn't forced to PANORAMA.)
        val lowRotationGuard = rRadians > 0.35 && tMeters < 0.25
        val mode = if (!lowRotationGuard && ratio >= 0.55) "scans" else "panorama"
        android.util.Log.i(
            "IncrementalStitcher",
            "stitch-mode auto: tPose=${"%.3f".format(tPose)}m " +
                "tImu=${"%.3f".format(imuTranslationMetres)}m " +
                "r=${"%.3f".format(rRadians)}rad " +
                "ratio=${"%.3f".format(ratio)} " +
                "rotGuard=$lowRotationGuard → $mode",
        )
        return StitchModeResolution(mode, rRadians, tMeters, ratio)
    }

    /**
     * 2026-06-16 — high-level warper decision tree (the pipeline is now ALWAYS
     * high-level cv::Stitcher PANORAMA — useManualPipeline=false).  Warper is a
     * pure function of (lens, pan direction); the rotation-vs-translation
     * (ex-SCANS) distinction was DROPPED as redundant — at 1x the same
     * direction-based warpers serve both, and 0.5x is always spherical.  Inputs:
     *   orientation = capture hold ("landscape*" = Mode A vertical pan;
     *                 "portrait*" = Mode B horizontal pan)
     *   lens        = the EXPLICIT lens the user selected ("0.5x" ultra-wide |
     *                 "1x" wide).  Reliable zoom signal (FOV-from-intrinsics was
     *                 unreliable — multi-cam 0.5x reaches the ultra-wide by zoom
     *                 without changing fx, and the non-AR path may supply fx=0).
     *
     *     0.5x ultra-wide          → spherical   (bounded both axes; any pan)
     *     1x + Mode A (vertical)   → plane
     *     1x + Mode B (horizontal) → cylindrical
     *
     * Quality-preferred warper; the C++ memory ladder force-falls to spherical
     * (and downscales compositingResol) under pressure.
     */
    private fun pickHighLevelWarper(
        orientation: String,
        lens: String,
    ): String {
        if (lens == "0.5x") return "spherical"                // ultra-wide → always spherical
        val verticalPanModeA = orientation.startsWith("landscape")
        return if (verticalPanModeA) "plane" else "cylindrical"  // 1x: A→plane, B→cylindrical
    }

    /**
     * Gyro rotation magnitude (radians) between two 7-element poses
     * `[tx,ty,tz,qx,qy,qz,qw]` — the angle between the camera-forward vectors.
     * Returns 0.0 if either pose is missing/malformed (non-AR with no pose).
     * Shared by [resolveStitchModeAuto] and the finalize `rRadians` readout (DRY).
     */
    private fun rotationRadians(firstPose: DoubleArray?, lastPose: DoubleArray?): Double {
        if (firstPose == null || lastPose == null) return 0.0
        if (firstPose.size != 7 || lastPose.size != 7) return 0.0
        val f = qrotForward(firstPose[3], firstPose[4], firstPose[5], firstPose[6])
        val l = qrotForward(lastPose[3], lastPose[4], lastPose[5], lastPose[6])
        val dot = (f[0] * l[0] + f[1] * l[1] + f[2] * l[2]).coerceIn(-1.0, 1.0)
        return kotlin.math.acos(dot)
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

    /// v0.21 — variance-of-Laplacian sharpness score for the
    /// pick-sharpest-in-window selection.  Bridges to the shared
    /// retailens::sharpnessScore (cpp/sharpness.{hpp,cpp}) via
    /// android/src/main/cpp/sharpness_jni.cpp — identical math to
    /// iOS.  `gray` is the frame's Y-plane bytes (same buffer the
    /// keyframe gate evaluates); the metric downscales internally so
    /// the cost is ~1-3 ms.  Scores are content-dependent: only
    /// compare between frames of the same capture window.  INSTANCE
    /// method — the JNI symbol takes jobject, not jclass.
    private external fun nativeSharpnessScore(
        gray: ByteArray,
        width: Int,
        height: Int,
        stride: Int,
    ): Double

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
        init {
            // v0.21 — nativeSharpnessScore lives in libimage_stitcher.so
            // (the same JNI shim KeyframeGate and QualityChecker load).
            // System.loadLibrary is idempotent; loading here removes any
            // dependence on KeyframeGate's class-initialisation order.
            System.loadLibrary("image_stitcher")
        }

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


// stripFileScheme — same code as iOS's static helper, transcribed to Kotlin.


internal fun stripFileScheme(path: String): String =
    if (path.startsWith("file://")) path.removePrefix("file://") else path


// `sensorRotationMatrix` was removed in V7 — the rotation chain it
// powered is no longer in the homography path.  See iOS' equivalent.
