// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Rect
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android twin of the iOS BatchStitcher.  Mirrors the JS-facing
 * surface exactly:
 *
 *   stitch({ framePaths, outputPath, quality })
 *     → { outputPath, width, height, durationMs }
 *
 *   stitchVideo({ videoPath, outputPath, maxFrames, quality })
 *     → { outputPath, width, height, durationMs }
 *
 *   normaliseImage({ imagePath })
 *     → { width, height }
 *
 * Algorithm choices match iOS:
 *   - cv::Stitcher::SCANS mode (translational, planar subject — the
 *     shelf-walking gesture) instead of PANORAMA (which assumes
 *     rotational camera).
 *   - 10 evenly-spaced frames as the SCANS-mode sweet spot.
 *   - JPEG quality 85 default; adjustable per call.
 *
 * Frame extraction uses Android's MediaMetadataRetriever — analogous
 * to iOS' AVAssetImageGenerator.  Each call to getFrameAtTime is
 * fast (~30-50 ms) and the API blocks per-frame, so we run the
 * whole pipeline on a background coroutine.
 */
class BatchStitcher(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BatchStitcher"

    /**
     * JNI bridge to our custom-built OpenCV stitcher.  Mirrors iOS'
     * OpenCVStitcher.stitchFramePaths so the batch-keyframe flow has
     * parity across platforms.  Implementation:
     *   react-native-image-stitcher/android/src/main/cpp/image_stitcher_jni.cpp
     *
     * @param framePaths  input JPEG paths in capture order (≥2 required)
     * @param outputPath  destination JPEG path
     * @param jpegQuality 0..100
     * @param warperType  "plane" | "cylindrical" | "spherical"
     * @param blenderType "multiband" | "feather"
     * @param seamFinderType "graphcut" | "skip" | "voronoi"
     * @param captureOrientation "portrait" | "portrait-upside-down"
     *                            | "landscape-left" | "landscape-right"
     *                            (drives output bake-rotation table,
     *                            mirrors iOS)
     * @param useInscribedRectCrop  when true, the cv::Stitcher path
     *                              crops to the maximum inscribed
     *                              rectangle of the coverage mask
     *                              (choose_crop_rect in stitcher.cpp);
     *                              false = looser cv::boundingRect
     * @return [width, height] of the written JPEG
     * @throws RuntimeException on stitch failure
     */
    private external fun nativeStitchFramePaths(
        framePaths: Array<String>,
        outputPath: String,
        jpegQuality: Int,
        warperType: String,
        blenderType: String,
        seamFinderType: String,
        captureOrientation: String,
        useInscribedRectCrop: Boolean,
        // V16-followup (Android OOM fix): cv::Stitcher staged-resolution
        // budgets in megapixels.  Pass any negative value to keep
        // cv::Stitcher's library default for that stage.  See
        // image_stitcher_jni.cpp arg doc for the full rationale; the
        // tl;dr is that the cv::Stitcher COMPOSITING default is
        // ORIG_RESOL (no downscale) which on Android with 1920×1080
        // sensor frames balloons MultiBand memory and triggers lmkd.
        // Bounding compositing to ~1.0 MP keeps stitch peak < 200 MB
        // on the A35.
        registrationResolMP: Double,
        seamEstimationResolMP: Double,
        compositingResolMP: Double,
        // 2026-05-14 — cv::Stitcher pipeline mode picker.
        //   "panorama" → cv::Stitcher::PANORAMA (rotation-only)
        //   "scans"    → cv::Stitcher::SCANS    (translation/affine)
        // Always a concrete mode at this layer; 'auto' is resolved
        // upstream in IncrementalStitcher.finalize() based
        // on accumulated translation/rotation totals.  Defaults to
        // "scans" in the JNI on unknown input (safer fallback —
        // SCANS canvas size is bounded by sum-of-frames; PANORAMA
        // can diverge to multi-GB on translation-heavy input).
        stitchMode: String,
        // 2026-06-15 — pipeline picker (mirrors iOS' OpenCVStitcher
        // `useManualPipeline:` param).  true → the MANUAL cv::detail
        // pipeline (graphcut + multiband + the full memory-guard set;
        // the default for batch capture).  false → stock high-level
        // cv::Stitcher (the on-demand HIGH-LEVEL preview tab driven by
        // refinePanorama).  Appended LAST to match the JNI C signature
        // in image_stitcher_jni.cpp — order/count/type must line up
        // exactly or it's an UnsatisfiedLinkError at runtime.
        useManualPipeline: Boolean,
    ): IntArray

    // 2026-06-15 — getter for the last successful stitch's debugSummary
    // (pipe/warp/route/seam/blend).  The jintArray return of
    // nativeStitchFramePaths can't carry a string; this fetches the value the
    // JNI stashed.  Called by stitchSync right after a successful stitch.
    private external fun nativeLastDebugSummary(): String

    /** debugSummary of the most recent stitchSync() (empty if none/failed). */
    internal var lastDebugSummary: String = ""
        private set

    // ── Stitch frames → panorama ─────────────────────────────────

    @ReactMethod
    fun stitch(options: ReadableMap, promise: Promise) {
        // Unmarshal options.  We accept iOS-aligned parameter names
        // so the JS-side code stays platform-agnostic.
        val framePathsArr = options.getArray("framePaths")
        if (framePathsArr == null || framePathsArr.size() < 2) {
            promise.reject(
                "invalid-options",
                "framePaths must be an array of at least 2 paths " +
                    "(got ${framePathsArr?.size() ?: 0}).",
            )
            return
        }
        val framePaths = Array(framePathsArr.size()) {
            stripFileScheme(framePathsArr.getString(it) ?: "")
        }
        val outputPath = options.getString("outputPath")
            ?.let(::stripFileScheme)
            ?: return promise.reject("invalid-options", "outputPath required")
        val quality = if (options.hasKey("quality"))
            options.getInt("quality") else 85
        val warperType = options.getString("warperType") ?: "plane"
        val blenderType = options.getString("blenderType") ?: "multiband"
        val seamFinderType = options.getString("seamFinderType") ?: "graphcut"
        val captureOrientation = options.getString("captureOrientation") ?: "portrait"
        val useInscribedRectCrop = options.hasKey("useInscribedRectCrop") &&
            options.getBoolean("useInscribedRectCrop")
        // V16-followup (Android OOM fix): cv::Stitcher staged-resolution
        // budgets in MP.  Defaults:
        //   registrationResolMP   = -1.0 → keep cv::Stitcher default 0.6 MP
        //   seamEstimationResolMP = -1.0 → keep cv::Stitcher default 0.1 MP
        //   compositingResolMP    = 1.0  → OVERRIDE the dangerous
        //                                  ORIG_RESOL (-1.0) default
        // Caller-supplied negative values keep the library default;
        // any positive value scales the stage to that target MP.
        val registrationResolMP = if (options.hasKey("registrationResolMP"))
            options.getDouble("registrationResolMP") else -1.0
        val seamEstimationResolMP = if (options.hasKey("seamEstimationResolMP"))
            options.getDouble("seamEstimationResolMP") else -1.0
        val compositingResolMP = if (options.hasKey("compositingResolMP"))
            options.getDouble("compositingResolMP") else 1.0
        // 2026-05-14 — cv::Stitcher pipeline mode.  Caller from
        // IncrementalStitcher.finalize resolves 'auto' to
        // 'panorama' or 'scans' before reaching here.  Direct
        // @ReactMethod callers (CLI / tests) can pass 'auto' too;
        // we default to 'scans' if missing/unrecognised since SCANS
        // is the safer mode (bounded canvas; can't lmkd-kill on
        // translation-heavy input).
        val stitchMode = (options.getString("stitchMode") ?: "scans")
            .let { if (it in setOf("panorama", "scans")) it else "scans" }
        // Pipeline passthrough.  Absent = this path's historical MANUAL
        // pipeline (the memory-safe default; mirrors iOS' batch capture).
        // An explicit false selects the stock high-level cv::Stitcher.
        val useManualPipeline = if (options.hasKey("useManualPipeline"))
            options.getBoolean("useManualPipeline") else true

        CoroutineScope(Dispatchers.Default).launch {
            val start = System.currentTimeMillis()
            try {
                ensureNativeStitcher()
                val dims = nativeStitchFramePaths(
                    framePaths,
                    outputPath,
                    quality,
                    warperType,
                    blenderType,
                    seamFinderType,
                    captureOrientation,
                    useInscribedRectCrop,
                    registrationResolMP,
                    seamEstimationResolMP,
                    compositingResolMP,
                    stitchMode,
                    useManualPipeline,
                )
                val duration = System.currentTimeMillis() - start
                // 2026-05-15 (D) — dims layout from native JNI:
                //   [0] width, [1] height, [2] framesRequested,
                //   [3] framesIncluded, [4] finalThresholdMilli
                // (see image_stitcher_jni.cpp return site).
                // dims.size >= 5 guards against older native libs
                // (defensive — keeps Kotlin/native loosely versioned).
                val framesRequested = if (dims.size > 2) dims[2] else framePaths.size
                val framesIncluded = if (dims.size > 3) dims[3] else framePaths.size
                val finalConfidenceThresh =
                    if (dims.size > 4) dims[4].toDouble() / 1000.0 else -1.0
                val result = WritableNativeMap().apply {
                    putString("outputPath", outputPath)
                    putInt("width", dims[0])
                    putInt("height", dims[1])
                    putInt("durationMs", duration.toInt())
                    putInt("framesRequested", framesRequested)
                    putInt("framesIncluded", framesIncluded)
                    putInt("framesDropped", framesRequested - framesIncluded)
                    putDouble("finalConfidenceThresh", finalConfidenceThresh)
                }
                promise.resolve(result)
            } catch (t: Throwable) {
                promise.reject(
                    "stitch-failed",
                    "Native stitch threw: ${t.message ?: t.javaClass.simpleName}",
                    t,
                )
            }
        }
    }

    // ── Stitch video → panorama (extract + stitch + cleanup) ─────

    @ReactMethod
    fun stitchVideo(options: ReadableMap, promise: Promise) {
        // Video → frames extraction not yet implemented on Android.
        // The batch-keyframe flow drives stitch() directly with
        // already-captured frame paths.  If video-driven panorama
        // ever ships on Android, extract via MediaMetadataRetriever
        // and delegate to nativeStitchFramePaths.
        promise.reject(
            "STITCH_VIDEO_NOT_IMPLEMENTED",
            "stitchVideo() is not implemented on Android.  Use " +
                "stitch() with pre-extracted framePaths instead.",
        )
    }

    // ── Normalise photo orientation (bake EXIF into pixels) ──────

    /**
     * Bake EXIF rotation into pixels + strip the tag.  JS calls this
     * `normaliseOrientation` (matching the iOS bridge); historically the
     * Android method was named `normaliseImage`, so the JS lookup found
     * nothing on Android and silently no-op'd — leaving every Android capture
     * with an un-baked EXIF orientation tag (RN's <Image> honoured it, OpenCV
     * did not → the crop-preview image was squished and the detected quad was
     * rotated 90°).  Renamed to match JS; `normaliseImage` kept as an alias.
     */
    @ReactMethod
    fun normaliseOrientation(options: ReadableMap, promise: Promise) {
        val imagePath = options.getString("imagePath")
            ?: return promise.reject("invalid-options", "imagePath required")

        CoroutineScope(Dispatchers.Default).launch {
            try {
                val cleaned = stripFileScheme(imagePath)
                if (!File(cleaned).exists()) {
                    promise.reject("read-failed", "Image not found: $imagePath")
                    return@launch
                }
                // DETERMINISTIC orientation bake.  OpenCV's imread auto-applies
                // EXIF INCONSISTENTLY (verified on-device: the same pipeline
                // returned 1080x1440 for one shot and 1440x1080 for the next —
                // the phone is held flat over the document so the device
                // orientation is ambiguous).  Android's BitmapFactory.decodeFile
                // NEVER auto-orients, so we read the RAW pixels, read the EXIF
                // tag explicitly, rotate with a Matrix, and re-encode upright
                // with NO orientation metadata — consistent for RN <Image> AND
                // OpenCV (detectDocument / cropQuad).
                val exif = androidx.exifinterface.media.ExifInterface(cleaned)
                val exifOrient = exif.getAttributeInt(
                    androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL,
                )
                val raw = android.graphics.BitmapFactory.decodeFile(cleaned)
                    ?: return@launch promise.reject("read-failed", "Could not decode $imagePath")
                val matrix = android.graphics.Matrix()
                when (exifOrient) {
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_TRANSPOSE -> {
                        matrix.postRotate(90f); matrix.postScale(-1f, 1f)
                    }
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_TRANSVERSE -> {
                        matrix.postRotate(270f); matrix.postScale(-1f, 1f)
                    }
                    else -> {}
                }
                val upright = if (matrix.isIdentity) raw else android.graphics.Bitmap.createBitmap(
                    raw, 0, 0, raw.width, raw.height, matrix, true,
                )
                val outW = upright.width
                val outH = upright.height
                java.io.FileOutputStream(cleaned).use { fos ->
                    upright.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, fos)
                }
                if (upright !== raw) upright.recycle()
                raw.recycle()
                promise.resolve(WritableNativeMap().apply {
                    putInt("width", outW)
                    putInt("height", outH)
                })
            } catch (t: Throwable) {
                promise.reject("normalise-failed", t.message, t)
            }
        }
    }

    /** Back-compat alias for the historical Android method name. */
    @ReactMethod
    fun normaliseImage(options: ReadableMap, promise: Promise) =
        normaliseOrientation(options, promise)

    // ── v0.15 inscribed-rect debug harness (iOS parity) ──────────
    //
    // Pure-Kotlin / OpenCV-Java twins of iOS' OpenCVStitcher
    // computeInscribedRect / cropToRect / debugMaskOverlay.  Exposing
    // them as @ReactMethods is what makes the example app's
    // `inscribedRectDebugAvailable()` return true so the __DEV__
    // top-left rect-debug toggle shows on Android too.  The
    // inscribed-rect ALGORITHM is a direct port of cpp/stitcher.cpp's
    // maxInscribedRectFromMask, duplicated in Kotlin per the same
    // "duplicate stage code, DRY when proven" convention the sibling
    // normaliseImage follows.  Returns/params
    // match the iOS StitcherBridge contract exactly so the shared JS
    // (InscribedRectDebug.tsx) is platform-agnostic.

    /** Resolves `{ x, y, width, height, imageWidth, imageHeight }`. */
    @ReactMethod
    fun computeInscribedRect(options: ReadableMap, promise: Promise) {
        val imagePath = options.getString("imagePath")
            ?: return promise.reject("invalid-options", "imagePath required")
        CoroutineScope(Dispatchers.Default).launch {
            val toRelease = mutableListOf<Mat>()
            try {
                ensureOpenCv()
                val cleaned = stripFileScheme(imagePath)
                if (!File(cleaned).exists()) {
                    promise.reject("read-failed", "Image not found: $imagePath")
                    return@launch
                }
                val img = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
                toRelease += img
                if (img.empty()) {
                    promise.reject("read-failed", "Could not decode $imagePath")
                    return@launch
                }
                val mask = coverageOrBrightnessMask(img, cleaned, 1, toRelease)
                val r = maxInscribedRect(mask)   // [x, y, w, h]
                promise.resolve(WritableNativeMap().apply {
                    putInt("x", r[0])
                    putInt("y", r[1])
                    putInt("width", r[2])
                    putInt("height", r[3])
                    putInt("imageWidth", img.cols())
                    putInt("imageHeight", img.rows())
                })
            } catch (t: Throwable) {
                promise.reject("compute-inscribed-rect-failed", t.message, t)
            } finally {
                toRelease.forEach { it.release() }
            }
        }
    }

    /** Crop `imagePath` to `{ x, y, width, height }` in place; resolves `{ width, height }`. */
    @ReactMethod
    fun cropToRect(options: ReadableMap, promise: Promise) {
        val imagePath = options.getString("imagePath")
            ?: return promise.reject("invalid-options", "imagePath required")
        fun optInt(key: String, default: Int): Int =
            if (options.hasKey(key) && !options.isNull(key)) options.getInt(key) else default
        val x = optInt("x", 0)
        val y = optInt("y", 0)
        val width = optInt("width", 0)
        val height = optInt("height", 0)
        val quality = optInt("quality", 90).coerceIn(1, 100)
        CoroutineScope(Dispatchers.Default).launch {
            val toRelease = mutableListOf<Mat>()
            try {
                ensureOpenCv()
                val cleaned = stripFileScheme(imagePath)
                if (!File(cleaned).exists()) {
                    promise.reject("read-failed", "Image not found: $imagePath")
                    return@launch
                }
                val img = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
                toRelease += img
                if (img.empty()) {
                    promise.reject("read-failed", "Could not decode $imagePath")
                    return@launch
                }
                // Clamp the rect to image bounds (never trust JS input).
                val rx = x.coerceIn(0, img.cols() - 1)
                val ry = y.coerceIn(0, img.rows() - 1)
                var rw = width.coerceAtLeast(1)
                var rh = height.coerceAtLeast(1)
                if (rx + rw > img.cols()) rw = img.cols() - rx
                if (ry + rh > img.rows()) rh = img.rows() - ry
                val cropped = Mat(img, Rect(rx, ry, rw, rh)).clone()
                toRelease += cropped
                val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, quality)
                if (!Imgcodecs.imwrite(cleaned, cropped, params)) {
                    promise.reject("write-failed", "Could not rewrite $imagePath")
                    return@launch
                }
                promise.resolve(WritableNativeMap().apply {
                    putInt("width", cropped.cols())
                    putInt("height", cropped.rows())
                })
            } catch (t: Throwable) {
                promise.reject("crop-to-rect-failed", t.message, t)
            } finally {
                toRelease.forEach { it.release() }
            }
        }
    }

    /**
     * item-7 — free-quad perspective crop (iOS `cropToQuadAtPath` parity).
     *
     * `options` carries `imagePath` + the 4 IMAGE-PIXEL corners as a flat
     * `quad` array of 8 numbers `[tlX,tlY,trX,trY,brX,brY,blX,blY]`
     * (ordered TL→TR→BR→BL by the JS editor's `orderQuadCorners`) +
     * optional `quality` (default 90).  Rectifies the quadrilateral to an
     * upright rectangle (Imgproc.getPerspectiveTransform +
     * Imgproc.warpPerspective), overwrites in place, resolves
     * `{ width, height }`.  Mirrors `cropToRect`; the JS editor chooses
     * this when the dragged quad isn't ~axis-aligned.
     *
     * The destination size (averaged opposite edges) + the convex /
     * min-area / in-bounds gate + the output-canvas OOM guard are
     * Kotlin ports of cpp/crop_quad.hpp (quadDstRect / isQuadAcceptable)
     * and cpp/warp_guard.hpp (canvasExceedsGuard), kept in sync with iOS
     * per the same "duplicate stage code" convention `cropToRect` follows.
     */
    @ReactMethod
    fun cropToQuad(options: ReadableMap, promise: Promise) {
        val imagePath = options.getString("imagePath")
            ?: return promise.reject("invalid-options", "imagePath required")
        val quadArr = options.getArray("quad")
        if (quadArr == null || quadArr.size() != 8) {
            return promise.reject(
                "invalid-options",
                "quad must be an array of 8 numbers [tlX,tlY,trX,trY,brX,brY,blX,blY]",
            )
        }
        val p = DoubleArray(8) { quadArr.getDouble(it) }
        val quality =
            (if (options.hasKey("quality") && !options.isNull("quality")) {
                options.getInt("quality")
            } else {
                90
            }).coerceIn(1, 100)
        CoroutineScope(Dispatchers.Default).launch {
            val toRelease = mutableListOf<Mat>()
            try {
                ensureOpenCv()
                val cleaned = stripFileScheme(imagePath)
                if (!File(cleaned).exists()) {
                    promise.reject("read-failed", "Image not found: $imagePath")
                    return@launch
                }
                val img = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
                toRelease += img
                if (img.empty()) {
                    promise.reject("read-failed", "Could not decode $imagePath")
                    return@launch
                }

                // Geometry gate — convex, non-degenerate, inside the image.
                if (!isQuadAcceptableForCrop(p, img.cols().toDouble(), img.rows().toDouble())) {
                    promise.reject(
                        "crop-to-quad-failed",
                        "Crop quad is degenerate (non-convex, zero-area, or out of bounds)",
                    )
                    return@launch
                }
                // Destination size = avg of opposite edge lengths (rounded).
                val dstW = Math.round((quadEdge(p, 0, 1) + quadEdge(p, 3, 2)) / 2.0).toInt()
                val dstH = Math.round((quadEdge(p, 0, 3) + quadEdge(p, 1, 2)) / 2.0).toInt()
                // Output-canvas OOM net — same 50 MP guard the stitch uses.
                if (dstW <= 0 || dstH <= 0 || canvasExceedsGuard(dstW.toLong(), dstH.toLong())) {
                    promise.reject(
                        "crop-to-quad-failed",
                        "Crop quad output canvas is degenerate or exceeds the size guard (${dstW}x${dstH})",
                    )
                    return@launch
                }

                val src = MatOfPoint2f(
                    Point(p[0], p[1]),  // TL
                    Point(p[2], p[3]),  // TR
                    Point(p[4], p[5]),  // BR
                    Point(p[6], p[7]),  // BL
                )
                toRelease += src
                val dst = MatOfPoint2f(
                    Point(0.0, 0.0),
                    Point(dstW.toDouble(), 0.0),
                    Point(dstW.toDouble(), dstH.toDouble()),
                    Point(0.0, dstH.toDouble()),
                )
                toRelease += dst
                val transform = Imgproc.getPerspectiveTransform(src, dst)
                toRelease += transform
                val warped = Mat()
                toRelease += warped
                Imgproc.warpPerspective(
                    img, warped, transform, Size(dstW.toDouble(), dstH.toDouble()),
                    Imgproc.INTER_LINEAR,
                )
                if (warped.empty()) {
                    promise.reject("crop-to-quad-failed", "Perspective warp produced an empty image")
                    return@launch
                }
                val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, quality)
                if (!Imgcodecs.imwrite(cleaned, warped, params)) {
                    promise.reject("write-failed", "Could not rewrite $imagePath")
                    return@launch
                }
                promise.resolve(WritableNativeMap().apply {
                    putInt("width", warped.cols())
                    putInt("height", warped.rows())
                })
            } catch (t: Throwable) {
                promise.reject("crop-to-quad-failed", t.message, t)
            } finally {
                toRelease.forEach { it.release() }
            }
        }
    }

    /** Red-tint the dropped pixels; writes `<path>.mask.jpg`. Resolves `{ maskPath, width, height, excludedPercent }`. */
    @ReactMethod
    fun debugMaskOverlay(options: ReadableMap, promise: Promise) {
        val imagePath = options.getString("imagePath")
            ?: return promise.reject("invalid-options", "imagePath required")
        val threshold = if (options.hasKey("threshold") && !options.isNull("threshold")) {
            options.getInt("threshold")
        } else {
            1
        }
        CoroutineScope(Dispatchers.Default).launch {
            val toRelease = mutableListOf<Mat>()
            try {
                ensureOpenCv()
                val cleaned = stripFileScheme(imagePath)
                if (!File(cleaned).exists()) {
                    promise.reject("read-failed", "Image not found: $imagePath")
                    return@launch
                }
                val img = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
                toRelease += img
                if (img.empty()) {
                    promise.reject("read-failed", "Could not decode $imagePath")
                    return@launch
                }
                val mask = coverageOrBrightnessMask(img, cleaned, threshold.coerceAtLeast(0), toRelease)
                val excluded = Mat()
                toRelease += excluded
                Core.bitwise_not(mask, excluded)                 // 255 = dropped pixels
                // Blend red (BGR 0,0,255) over the dropped pixels so they stand out.
                val red = Mat(img.size(), img.type(), Scalar(0.0, 0.0, 255.0))
                toRelease += red
                val blended = Mat()
                toRelease += blended
                Core.addWeighted(img, 0.35, red, 0.65, 0.0, blended)
                val overlay = img.clone()
                toRelease += overlay
                blended.copyTo(overlay, excluded)
                val maskPath = "$cleaned.mask.jpg"
                val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, 90)
                if (!Imgcodecs.imwrite(maskPath, overlay, params)) {
                    promise.reject("write-failed", "Could not write mask overlay for $imagePath")
                    return@launch
                }
                val total = img.rows() * img.cols()
                val excludedPercent = if (total > 0) Core.countNonZero(excluded) * 100 / total else 0
                promise.resolve(WritableNativeMap().apply {
                    putString("maskPath", maskPath)
                    putInt("width", img.cols())
                    putInt("height", img.rows())
                    putInt("excludedPercent", excludedPercent)
                })
            } catch (t: Throwable) {
                promise.reject("debug-mask-overlay-failed", t.message, t)
            } finally {
                toRelease.forEach { it.release() }
            }
        }
    }

    /**
     * Coverage mask for an on-disk image: prefer the TRUE coverage
     * sidecar (`<path>.coverage.png`) the stitch writes next to the
     * panorama; else a brightness proxy (gray > threshold, with
     * border-connected holes filled).  Mirrors the iOS debug methods.
     * The returned Mat (and any intermediates) are registered in
     * `toRelease`.
     */
    private fun coverageOrBrightnessMask(
        img: Mat,
        cleaned: String,
        threshold: Int,
        toRelease: MutableList<Mat>,
    ): Mat {
        val coveragePath = "$cleaned.coverage.png"
        if (File(coveragePath).exists()) {
            val cov = Imgcodecs.imread(coveragePath, Imgcodecs.IMREAD_GRAYSCALE)
            toRelease += cov
            if (!cov.empty() && cov.cols() == img.cols() && cov.rows() == img.rows()) {
                val mask = Mat()
                toRelease += mask
                Imgproc.threshold(cov, mask, 0.0, 255.0, Imgproc.THRESH_BINARY)
                return mask
            }
        }
        val gray = Mat()
        toRelease += gray
        Imgproc.cvtColor(img, gray, Imgproc.COLOR_BGR2GRAY)
        val raw = Mat()
        toRelease += raw
        Imgproc.threshold(gray, raw, threshold.toDouble(), 255.0, Imgproc.THRESH_BINARY)
        val filled = fillBorderConnectedHoles(raw)
        toRelease += filled
        return filled
    }

    /**
     * Fill mask holes NOT connected to the border (interior content the
     * brightness threshold dropped).  Mirrors iOS' FillBorderConnectedHoles:
     * pad a black border, flood the border-connected black to white, then
     * OR the surviving interior holes back in.
     */
    private fun fillBorderConnectedHoles(mask: Mat): Mat {
        val padded = Mat()
        Core.copyMakeBorder(mask, padded, 1, 1, 1, 1, Core.BORDER_CONSTANT, Scalar(0.0))
        // floodFill needs a mask 2px larger than the image; a zero mask
        // makes it behave like the no-mask overload iOS uses.
        val ffMask = Mat.zeros(padded.rows() + 2, padded.cols() + 2, CvType.CV_8UC1)
        Imgproc.floodFill(padded, ffMask, Point(0.0, 0.0), Scalar(255.0))
        val exterior = Mat(padded, Rect(1, 1, mask.cols(), mask.rows()))
        val holes = Mat()
        Core.bitwise_not(exterior, holes)
        val filled = Mat()
        Core.bitwise_or(mask, holes, filled)
        padded.release()
        ffMask.release()
        exterior.release()
        holes.release()
        return filled
    }

    /**
     * Largest axis-aligned rectangle entirely inside the non-zero region
     * of a CV_8UC1 `mask`.  Returns `[x, y, width, height]` (all 0 if
     * empty).  Direct port of cpp/stitcher.cpp's maxInscribedRectFromMask
     * (max-rectangle-in-histogram, row-swept, O(W*H)); operates on a
     * bulk-extracted ByteArray so there is no per-pixel JNI Mat access.
     */
    private fun maxInscribedRect(mask: Mat): IntArray {
        if (mask.empty() || mask.type() != CvType.CV_8UC1) return intArrayOf(0, 0, 0, 0)
        val h = mask.rows()
        val w = mask.cols()
        val data = ByteArray(h * w)
        mask.get(0, 0, data)
        val heights = IntArray(w)
        var bestArea = 0L
        var bx = 0
        var by = 0
        var bw = 0
        var bh = 0
        val stack = IntArray(w + 1)
        for (row in 0 until h) {
            val base = row * w
            for (col in 0 until w) {
                heights[col] = if (data[base + col].toInt() != 0) heights[col] + 1 else 0
            }
            var sp = 0
            for (col in 0..w) {
                val hh = if (col == w) 0 else heights[col]
                while (sp > 0 && heights[stack[sp - 1]] > hh) {
                    val topIdx = stack[--sp]
                    val leftIdx = if (sp == 0) -1 else stack[sp - 1]
                    val width = col - leftIdx - 1
                    val area = heights[topIdx].toLong() * width.toLong()
                    if (area > bestArea) {
                        bestArea = area
                        bx = leftIdx + 1
                        by = row - heights[topIdx] + 1
                        bw = width
                        bh = heights[topIdx]
                    }
                }
                stack[sp++] = col
            }
        }
        return intArrayOf(bx, by, bw, bh)
    }

    // ── item-7 free-quad crop geometry (ports of cpp/crop_quad.hpp +
    //    cpp/warp_guard.hpp; kept in sync with iOS cropToQuad) ───────

    /**
     * Euclidean length of the edge between corners `i` and `j` in the flat
     * `[x0,y0,x1,y1,...]` quad array `p` (corner k = (p[2k], p[2k+1])).
     */
    private fun quadEdge(p: DoubleArray, i: Int, j: Int): Double {
        val dx = p[2 * i] - p[2 * j]
        val dy = p[2 * i + 1] - p[2 * j + 1]
        return Math.hypot(dx, dy)
    }

    /**
     * Port of cpp/crop_quad.hpp:isQuadAcceptable for the flat 8-number
     * quad `p` ([tlX,tlY,trX,trY,brX,brY,blX,blY]).  True when the quad is
     * convex, has |area| ≥ `minArea` px², and every corner lies inside
     * `[0..imageW]×[0..imageH]` (½-px epsilon).  Mirrors the iOS gate so
     * both platforms reject the same degenerate quads.
     */
    private fun isQuadAcceptableForCrop(
        p: DoubleArray,
        imageW: Double,
        imageH: Double,
        minArea: Double = 1.0,
    ): Boolean {
        // Convexity — all consecutive edge cross-products share one sign.
        var sign = 0
        for (i in 0 until 4) {
            val ax = p[2 * i]; val ay = p[2 * i + 1]
            val bx = p[2 * ((i + 1) % 4)]; val by = p[2 * ((i + 1) % 4) + 1]
            val cx = p[2 * ((i + 2) % 4)]; val cy = p[2 * ((i + 2) % 4) + 1]
            val cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
            if (cross != 0.0) {
                val s = if (cross > 0.0) 1 else -1
                if (sign == 0) sign = s else if (s != sign) return false
            }
        }
        // Min-area via the shoelace formula (|2A| ≥ 2·minArea).
        var area2 = 0.0
        for (i in 0 until 4) {
            val ax = p[2 * i]; val ay = p[2 * i + 1]
            val bx = p[2 * ((i + 1) % 4)]; val by = p[2 * ((i + 1) % 4) + 1]
            area2 += ax * by - bx * ay
        }
        if (Math.abs(area2) < minArea * 2.0) return false
        // In-bounds — every corner inside the decoded image (½-px slop).
        if (imageW > 0.0 && imageH > 0.0) {
            val eps = 0.5
            for (i in 0 until 4) {
                val x = p[2 * i]; val y = p[2 * i + 1]
                if (x < -eps || x > imageW + eps || y < -eps || y > imageH + eps) return false
            }
        }
        return true
    }

    /**
     * Port of cpp/warp_guard.hpp:canvasExceedsGuard — true when a
     * `width`×`height` output canvas is degenerate (non-positive) or
     * strictly larger than `maxPixels` (default 50 MP, boundary inclusive).
     * int64 area math matches the C++ so the same quads are rejected.
     */
    private fun canvasExceedsGuard(
        width: Long,
        height: Long,
        maxPixels: Long = 50L * 1000L * 1000L,
    ): Boolean {
        if (width <= 0 || height <= 0) return true
        if (width > 3_000_000_000L || height > 3_000_000_000L) return true
        return width * height > maxPixels
    }

    // ── Internals ────────────────────────────────────────────────

    /**
     * Read EXIF orientation tag and rotate the Mat accordingly.
     * The original Mat is released and replaced if rotation was
     * needed — caller can compare references to know if a fresh
     * Mat was returned.
     */
    private fun applyExifOrientation(path: String, src: Mat): Mat {
        val exif = androidx.exifinterface.media.ExifInterface(path)
        val orientation = exif.getAttributeInt(
            androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
            androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL,
        )
        val rotated = Mat()
        when (orientation) {
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> {
                org.opencv.core.Core.rotate(src, rotated, org.opencv.core.Core.ROTATE_90_CLOCKWISE)
            }
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> {
                org.opencv.core.Core.rotate(src, rotated, org.opencv.core.Core.ROTATE_180)
            }
            androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> {
                org.opencv.core.Core.rotate(src, rotated, org.opencv.core.Core.ROTATE_90_COUNTERCLOCKWISE)
            }
            else -> return src
        }
        return rotated
    }

    private fun stripFileScheme(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

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

    /**
     * Internal-visibility synchronous stitch entry point so the
     * orchestrator (IncrementalStitcher) can drive the V16
     * batch-keyframe finalize without re-marshalling through the
     * @ReactMethod surface.  Loads the JNI shim if not yet loaded,
     * then calls straight into native.  Throws on error.
     */
    internal fun stitchSync(
        framePaths: Array<String>,
        outputPath: String,
        jpegQuality: Int,
        warperType: String,
        blenderType: String,
        seamFinderType: String,
        captureOrientation: String,
        useInscribedRectCrop: Boolean,
        // V16-followup (Android OOM fix): MP budgets for the
        // staged-resolution pipeline.  Negative = use cv::Stitcher
        // library default.  Default param values here apply the OOM
        // fix (compose=1.0 MP) by default for the internal-orchestrator
        // call site — caller can override per capture if needed.
        registrationResolMP: Double = -1.0,
        seamEstimationResolMP: Double = -1.0,
        compositingResolMP: Double = 1.0,
        // 2026-05-14 — cv::Stitcher pipeline mode.  Caller resolves
        // 'auto' upstream; "panorama" or "scans" only here.  Default
        // 'scans' since SCANS handles both rotation-light and
        // translation captures safely (PANORAMA on translation can
        // diverge → multi-GB canvas → lmkd kill).
        stitchMode: String = "scans",
        // 2026-06-15 — pipeline picker (mirrors iOS' OpenCVStitcher
        // `useManualPipeline:`).  Defaults to true (MANUAL) so the
        // batch-keyframe finalize orchestrator gets the memory-safe
        // manual path without re-stating it.  The refine/high-level
        // path passes false to drive the stock cv::Stitcher pipeline.
        useManualPipeline: Boolean = true,
    ): IntArray {
        ensureNativeStitcher()
        val dims = nativeStitchFramePaths(
            framePaths,
            outputPath,
            jpegQuality,
            warperType,
            blenderType,
            seamFinderType,
            captureOrientation,
            useInscribedRectCrop,
            registrationResolMP,
            seamEstimationResolMP,
            compositingResolMP,
            stitchMode,
            useManualPipeline,
        )
        // Capture the run's debugSummary (pipe/warp/route/seam/blend) for the
        // DEV overlay; best-effort so a getter hiccup never fails the stitch.
        lastDebugSummary = try { nativeLastDebugSummary() } catch (_: Throwable) { "" }
        return dims
    }

    /**
     * Load the JNI shim that exposes cv::Stitcher.  libopencv_java4
     * must be loaded FIRST because the shim dynamically links against
     * it (uses cv::Mat, cv::imread/imwrite, cv::imgproc symbols
     * exported by the fat lib).
     */
    internal fun ensureNativeStitcher() {
        ensureOpenCv()
        if (!stitcherInitialised.get()) {
            try {
                System.loadLibrary("image_stitcher")
                stitcherInitialised.set(true)
            } catch (e: UnsatisfiedLinkError) {
                throw IllegalStateException(
                    "JNI shim 'image_stitcher' failed to load. " +
                        "Check that the custom OpenCV build artifacts " +
                        "(libopencv_java4.so + libopencv_stitching.a) " +
                        "are in vendor/OpenCV-android-sdk/sdk/native/.",
                    e,
                )
            }
        }
    }

    private class StitcherException(val code: String, message: String) : Exception(message)

    init {
        // Singleton-style accessor for callers that need the
        // BatchStitcher instance from outside the @ReactMethod
        // path (e.g. IncrementalStitcher.finalize() during
        // batch-keyframe stitching).
        //
        // Why this exists:
        //   reactContext.getNativeModule(BatchStitcher::class.java)
        //   returns null under bridgeless / new-architecture mode for
        //   modules registered the legacy way (ReactPackage +
        //   createNativeModules), even when the module is fully
        //   registered.  Empirically confirmed by Galaxy A35
        //   capture session 2026-05-13: stitcher IS registered (see
        //   RNImageStitcherPackage.kt) but lookup returned null →
        //   "BatchStitcher module not registered" IllegalState
        //   at finalize time.
        //
        // Same pattern IncrementalStitcher uses (its
        // `bridgeInstance` companion).
        bridgeInstance = this
    }

    companion object {
        @JvmStatic
        private val opencvInitialised = AtomicBoolean(false)

        @JvmStatic
        private val stitcherInitialised = AtomicBoolean(false)

        /// Direct access to the last-constructed BatchStitcher.
        /// RN may rebuild modules across reloads; the lookup always
        /// returns the latest reference.  Read-only from outside;
        /// only the init {} above sets it.
        @JvmStatic
        @Volatile
        var bridgeInstance: BatchStitcher? = null
            private set
    }
}
