// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.util.Log
import com.facebook.react.bridge.WritableMap
// V13.0a — removed unused imports (Calib3d, DMatch, KeyPoint,
// MatOfByte, MatOfDMatch, MatOfKeyPoint, MatOfPoint2f, BFMatcher,
// ORB) after the homography revert.  CvType + MatOfInt kept because
// they're still used elsewhere in the engine.
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.core.Point
import org.opencv.core.Rect
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Android port of iOS' OpenCVFirstWinsCylindricalStitcher with the
 * full V12.x stack baked in:
 *
 *   V12.2 — cylindrical projection (mirror-fixed: theta = atan2(-wx, wz))
 *   V12.3 — orientation-aware cylinder axis (transverse for landscape)
 *   V12.4 — central 70% (pan) × 85% (perpendicular) post-warp crop
 *   V12.6 — orientation detection from R_panToCam at first frame
 *           (NOT from JS-passed frameRotationDegrees, which is wrong
 *           under iOS interface-orientation lock — Android equivalent
 *           is screen-orientation lock; same fix applies)
 *   V12.7 — rectilinear path: skip cylindrical warp entirely.  First
 *           frame pasted raw onto canvas; subsequent frames contribute
 *           a narrow central strip placed by pose-delta around the
 *           dominant pan axis.  First-painted-wins masks the strip.
 *
 * Differences from the iOS engine:
 *   - Frames arrive as JPEG paths (vision-camera + gyro driver writes
 *     them to disk on each accept), not as raw CVPixelBuffers.  We
 *     read with Imgcodecs and downsample to compose dims here.
 *   - OpenCV Java bindings: cv::Mat is org.opencv.core.Mat with
 *     element accessors that return double[] — slower per-element
 *     than the C++ at<double>() but only used in setup paths, not
 *     the per-pixel inverse-map loop (that's done with put/get
 *     bulk float arrays for the remap).
 *
 * What this DOESN'T do (yet, intentional scope):
 *   - No KLT optical-flow refinement (iOS hybrid only; firstwins
 *     doesn't use it either)
 *   - No per-pair gain compensation
 *   - No CLAHE finalize (kept simpler to match firstwins minimalism)
 */
internal class IncrementalFirstwinsEngine(
    val composeWidth: Int,
    val composeHeight: Int,
    val canvasWidth: Int,
    val canvasHeight: Int,
    val snapshotJpegQuality: Int,
    val snapshotEveryNAccepts: Int,
    /// 0/90/180/270 — output rotation applied at finalize for display.
    /// Compute pipeline works in sensor-native landscape compose space.
    /// V12.6: orientation detection no longer uses this; ARKit/ARCore
    /// pose at first frame is ground truth.
    val frameRotationDegrees: Int,
    /// V12.7 Variant B: when true, skip cylindrical warp.  See class doc.
    val useRectilinear: Boolean,
    /// Critic #27 fix: cache-dir from the bridge.  Snapshot JPEGs are
    /// written here.  System.getProperty("java.io.tmpdir") on Android
    /// resolves to /data/local/tmp which is NOT writable by ordinary
    /// apps, so the previous version silently dropped every snapshot.
    val snapshotCacheDir: String,
) {
    // V12.12 — canvas allocation:
    //   • RECTILINEAR engine: deferred to first-frame branch so the
    //     canvas can be sized from the pose-detected orientation.
    //     Empty Mats here; the first-frame branch checks
    //     `canvas.empty()` and allocates.
    //   • CYLINDRICAL engines (hybrid, firstwins): use the
    //     constructor's square 5000×5000 canvas as before — they
    //     compute paste positions in cylinder coords and don't
    //     benefit from orientation-aware sizing.
    private var canvas: Mat = if (useRectilinear) {
        Mat()
    } else {
        Mat.zeros(canvasHeight, canvasWidth, CvType.CV_8UC3)
    }
    private var canvasMask: Mat = if (useRectilinear) {
        Mat()
    } else {
        Mat.zeros(canvasHeight, canvasWidth, CvType.CV_8UC1)
    }

    // V12.x state — mirrors iOS layout.
    private var firstRotationArkit: Mat = Mat()
    private var rPanToWorld: Mat = Mat()
    private var kCompose: Mat = Mat()
    private var focalCompose: Double = 0.0
    private val mArkitToCv: Mat = Mat(3, 3, CvType.CV_64F).apply {
        // diag(1, -1, -1) — ARKit/ARCore world (Y-up, -Z forward) → OpenCV.
        setTo(Scalar(0.0))
        put(0, 0, 1.0); put(1, 1, -1.0); put(2, 2, -1.0)
    }
    private var canvasOriginCylX: Int = 0
    private var canvasOriginCylY: Int = 0
    /// V12.7 first-frame anchor for rectilinear placement (canvas-pixel).
    private var firstFrameDstX: Int = 0
    private var firstFrameDstY: Int = 0
    /// V12.11 Step D — running max position along the pan axis.
    /// Mirrors iOS' _maxDstX/_maxDstY.  Reverse-direction stop
    /// fires when the homography-corrected dst regresses below
    /// max - kReverseStopPx.
    private var maxDstX: Int = 0
    private var maxDstY: Int = 0
    /// V12.6 detected at first frame from R_panToCam.
    private var isLandscape: Boolean = false

    private var hasFirstFrame: Boolean = false
    private var acceptsSinceSnapshot: Int = 0
    /// Critic #19 fix: AtomicInteger so JS-thread reads from
    /// `getState`/promise resolves see a consistent value.
    private val acceptedCountAtomic = AtomicInteger(0)
    val acceptedCount: Int get() = acceptedCountAtomic.get()
    private var snapshotSeq: Int = 0
    /// Critic #30 fix: cache the painted-region bbox so we don't
    /// re-scan a 25M-px mask N times per accept (writeOut + width
    /// + height + buildState all called boundingRect separately).
    private var cachedBoundingRect: Rect? = null
    var lastState: WritableMap? = null
        private set

    /// V12.4 slit-scan + long-side clip fractions.  Same values as iOS.
    private val kPanStripFraction: Double = 0.70
    private val kLongSideFraction: Double = 0.85
    /// V12.12 — fraction of the PAN AXIS (not the long side) the
    /// rectilinear engine retains per frame.  Apple-pano slit-scan:
    /// each frame contributes a narrower-than-frame slit perpendicular
    /// to motion.  See iOS `kPanAxisFractionRect` for the full
    /// rationale.  Both platforms MUST stay in sync.
    private val kPanAxisFractionRect: Double = 0.70

    /// V12.12 — pan-axis canvas extent, sized at first-frame
    /// allocation alongside the orientation-detected perpendicular
    /// dim.  Default 5000 (max of the constructor canvas dims) —
    /// kept as max-of-args for backwards compatibility with hosts
    /// that pass canvasWidth/Height hints.
    private val canvasPanExtent: Int = max(canvasWidth, canvasHeight)

    /**
     * Same shape as the V7 IncrementalEngine.addFrameAtPath() so the
     * RN bridge can route frames here without changing the JS contract.
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
                FrameOutcome.SkippedTrackingPoor, -1.0, 0, yaw, pitch,
                msSince(t0),
                isLandscape = isLandscape,
            )
        }
        val cleaned = path.removePrefix("file://")
        val srcRaw = Imgcodecs.imread(cleaned, Imgcodecs.IMREAD_COLOR)
        if (srcRaw.empty()) {
            return FrameTelemetry(
                FrameOutcome.RejectedAlignmentLost, -1.0, 0, yaw, pitch,
                msSince(t0),
                isLandscape = isLandscape,
            )
        }
        val frameBGR = downsampleToCompose(srcRaw)
        if (frameBGR !== srcRaw) srcRaw.release()

        val rNew = quaternionToRotationMat(qx, qy, qz, qw)

        if (!hasFirstFrame) {
            // V11/V12 first-frame setup: build panorama frame, detect
            // orientation, paste/warp the first frame.
            firstRotationArkit = rNew.clone()
            val sx = frameBGR.cols().toDouble() / max(1, imageWidth)
            val sy = frameBGR.rows().toDouble() / max(1, imageHeight)
            kCompose = Mat(3, 3, CvType.CV_64F).apply {
                setTo(Scalar(0.0))
                put(0, 0, fx * sx); put(0, 2, cx * sx)
                put(1, 1, fy * sy); put(1, 2, cy * sy)
                put(2, 2, 1.0)
            }
            focalCompose = sqrt(fx * sx * fy * sy)

            // Build R_panToWorld from horizontal projection of camera-forward.
            val fwdArkitCam = Mat(3, 1, CvType.CV_64F).apply {
                put(0, 0, 0.0); put(1, 0, 0.0); put(2, 0, -1.0)
            }
            val fwdWorld = Mat()
            Core.gemm(firstRotationArkit, fwdArkitCam, 1.0, Mat(), 0.0, fwdWorld)
            val fwx = fwdWorld[0, 0][0]
            val fwz = fwdWorld[2, 0][0]
            val horiz = sqrt(fwx * fwx + fwz * fwz)
            if (horiz < 0.1) {
                // V11 Gap #3 — refuse first-frame init while looking near vertical.
                frameBGR.release()
                return FrameTelemetry(
                    FrameOutcome.RejectedAlignmentLost, -1.0, 0, yaw, pitch,
                    msSince(t0),
                isLandscape = isLandscape,
                )
            }
            val pzx = fwx / horiz
            val pzz = fwz / horiz
            rPanToWorld = Mat(3, 3, CvType.CV_64F).apply {
                put(0, 0, pzz);  put(0, 1, 0.0); put(0, 2, pzx)
                put(1, 0, 0.0);  put(1, 1, 1.0); put(1, 2, 0.0)
                put(2, 0, -pzx); put(2, 1, 0.0); put(2, 2, pzz)
            }

            // V12.6 orientation detection from R_panToCam.
            val rPanToCamFirst = computeRPanToCam(firstRotationArkit)
            val absR01 = Math.abs(rPanToCamFirst[0, 1][0])
            val absR11 = Math.abs(rPanToCamFirst[1, 1][0])
            isLandscape = absR11 > absR01
            Log.i(
                "V12.6-orient",
                "engine=android-firstwins detected isLandscape=$isLandscape " +
                    "|R[0,1]|=${"%.4f".format(absR01)} " +
                    "|R[1,1]|=${"%.4f".format(absR11)}",
            )

            if (useRectilinear) {
                // V12.12 — orientation-aware clip + engine-internal
                // canvas allocation.  Pan axis = canvas Y for
                // landscape (vertical pan), canvas X for portrait
                // (horizontal pan).  Clip is ALONG the pan axis.
                // Mirrors iOS' OpenCVSlitScanStitcher.mm exactly.
                val clipW: Int
                val clipH: Int
                val srcClipX: Int
                val srcClipY: Int
                if (isLandscape) {
                    clipW = frameBGR.cols()
                    clipH = max(1, (frameBGR.rows() * kPanAxisFractionRect).toInt())
                    srcClipX = 0
                    srcClipY = (frameBGR.rows() - clipH) / 2
                } else {
                    clipW = max(1, (frameBGR.cols() * kPanAxisFractionRect).toInt())
                    clipH = frameBGR.rows()
                    srcClipX = (frameBGR.cols() - clipW) / 2
                    srcClipY = 0
                }
                val frameClipped = Mat(frameBGR, Rect(srcClipX, srcClipY, clipW, clipH))

                // V12.12 — engine-internal canvas allocation, sized
                // from detected orientation + actual frame dims.
                if (canvas.empty()) {
                    val newCanvasCols: Int
                    val newCanvasRows: Int
                    if (isLandscape) {
                        newCanvasCols = frameBGR.cols()      // perp full
                        newCanvasRows = canvasPanExtent      // pan extent
                    } else {
                        newCanvasCols = canvasPanExtent      // pan extent
                        newCanvasRows = frameBGR.rows()      // perp full
                    }
                    canvas = Mat.zeros(newCanvasRows, newCanvasCols, CvType.CV_8UC3)
                    canvasMask = Mat.zeros(newCanvasRows, newCanvasCols, CvType.CV_8UC1)
                    Log.i(
                        "V12.12-canvas",
                        "allocated ${newCanvasCols}x${newCanvasRows} (cols x rows) for " +
                            "isLandscape=$isLandscape (pan extent $canvasPanExtent, " +
                            "frame=${frameBGR.cols()}x${frameBGR.rows()})",
                    )
                }

                // V12.12 — first-frame placement at canvas ORIGIN
                // (0,0).  Canvas perpendicular dim now matches
                // clipped frame perpendicular dim, so no centring
                // offset.  As user pans, dstX (portrait) or dstY
                // (landscape) advances from 0.
                val dstX = 0
                val dstY = 0
                val roi = Rect(dstX, dstY, clipW, clipH).intersection(
                    Rect(0, 0, canvas.cols(), canvas.rows())
                )
                val srcR = Rect(0, 0, roi.width, roi.height)
                Mat(frameClipped, srcR).copyTo(Mat(canvas, roi))
                Imgproc.rectangle(
                    canvasMask,
                    Point(roi.x.toDouble(), roi.y.toDouble()),
                    Point((roi.x + roi.width).toDouble(), (roi.y + roi.height).toDouble()),
                    Scalar(255.0), -1
                )
                firstFrameDstX = dstX
                firstFrameDstY = dstY
                // V12.11 Step D — initialise running-max trackers
                // to first-frame position.
                maxDstX = dstX
                maxDstY = dstY
                hasFirstFrame = true
                acceptedCountAtomic.set(1); cachedBoundingRect = null
                Log.i(
                    "V12.12-rect",
                    "first frame placed at ($dstX,$dstY) clipped=${clipW}x${clipH} " +
                        "(srcClip=$srcClipX,$srcClipY) along-pan-axis " +
                        "isLandscape=$isLandscape focal=${"%.2f".format(focalCompose)} " +
                        "canvas=${canvas.cols()}x${canvas.rows()}",
                )
                frameClipped.release()
                frameBGR.release()
                return FrameTelemetry(
                    FrameOutcome.AcceptedHigh, 1.0, 0, yaw, pitch, msSince(t0),
                isLandscape = isLandscape,
                )
            }

            // V12.2 cylindrical first frame: warp + place at canvas centre.
            val warped = Mat()
            val warpedMask = Mat()
            val firstCornerCyl = cylindricalWarp(frameBGR, rNew, warped, warpedMask)
            if (warped.empty()) {
                frameBGR.release()
                return FrameTelemetry(
                    FrameOutcome.RejectedAlignmentLost, -1.0, 0, yaw, pitch,
                    msSince(t0),
                isLandscape = isLandscape,
                )
            }
            val dstX = (canvasWidth - warped.cols()) / 2
            val dstY = (canvasHeight - warped.rows()) / 2
            val roi = Rect(dstX, dstY, warped.cols(), warped.rows()).intersection(
                Rect(0, 0, canvasWidth, canvasHeight)
            )
            val srcR = Rect(0, 0, roi.width, roi.height)
            Mat(warped, srcR).copyTo(Mat(canvas, roi), Mat(warpedMask, srcR))
            Mat(warpedMask, srcR).copyTo(Mat(canvasMask, roi), Mat(warpedMask, srcR))
            canvasOriginCylX = firstCornerCyl.x.toInt() - dstX
            canvasOriginCylY = firstCornerCyl.y.toInt() - dstY

            warped.release(); warpedMask.release()
            hasFirstFrame = true
            acceptedCountAtomic.set(1); cachedBoundingRect = null
            frameBGR.release()
            return FrameTelemetry(
                FrameOutcome.AcceptedHigh, 1.0, 0, yaw, pitch, msSince(t0),
                isLandscape = isLandscape,
            )
        }

        // ─── Subsequent frame ───────────────────────────────────────
        if (useRectilinear) {
            // V12.8 Variant B: paste the SAME long-side-clipped portion
            // as the first frame at canvas offset = pan_angle * focal.
            // First-painted-wins masking ensures only the leading-edge
            // sliver (the part outside the previously-painted region)
            // gets painted — smooth incremental growth from frame 2,
            // no V12.7 dead-zone.
            val rRel = Mat()
            val firstT = firstRotationArkit.t()
            try {
                Core.gemm(firstT, rNew, 1.0, Mat(), 0.0, rRel)
            } finally {
                firstT.release()
            }

            // V12.12 — orientation-aware clip, MUST match the
            // first-frame branch above so subsequent frames have the
            // same shape as the first frame (otherwise paste positions
            // get inconsistent).
            val clipW: Int
            val clipH: Int
            val srcClipX: Int
            val srcClipY: Int
            if (isLandscape) {
                clipW = frameBGR.cols()
                clipH = max(1, (frameBGR.rows() * kPanAxisFractionRect).toInt())
                srcClipX = 0
                srcClipY = (frameBGR.rows() - clipH) / 2
            } else {
                clipW = max(1, (frameBGR.cols() * kPanAxisFractionRect).toInt())
                clipH = frameBGR.rows()
                srcClipX = (frameBGR.cols() - clipW) / 2
                srcClipY = 0
            }
            val frameClipped = Mat(frameBGR, Rect(srcClipX, srcClipY, clipW, clipH))

            var dstX: Int
            var dstY: Int
            val alpha: Double
            if (isLandscape) {
                // Vertical pan around cam +X: alpha = atan2(R_rel[2,1], R_rel[1,1]).
                alpha = atan2(rRel[2, 1][0], rRel[1, 1][0])
                dstX = firstFrameDstX
                // alpha > 0 (look up) → content shifts UP in canvas.
                dstY = firstFrameDstY - round(alpha * focalCompose).toInt()
            } else {
                // Horizontal pan around cam +Y: alpha = atan2(R_rel[0,2], R_rel[0,0]).
                alpha = atan2(rRel[0, 2][0], rRel[0, 0][0])
                // alpha > 0 (look right) → content shifts RIGHT in canvas.
                dstX = firstFrameDstX + round(alpha * focalCompose).toInt()
                dstY = firstFrameDstY
            }
            rRel.release()

            // V13.0a — REVERTED V12.11 Step 4 + V12.11.1 Item E + V12.14
            // homography refinement (mirrors iOS revert).  See
            // OpenCVSlitScanStitcher.mm for the rationale.  Restored
            // pose-only paste; perpendicular drift correction will
            // come back in V13.0b as 1D column-edge NCC correlation.

            // V12.11 Step D — reverse-direction detection.  Mirrors
            // iOS' running-max check.  See OpenCVSlitScanStitcher.mm
            // for the full rationale.  150 px ≈ 4° of pan at the
            // typical iPhone focal — comfortably above wobble.
            val kReverseStopPx = 150
            if (isLandscape) {
                if (dstY > maxDstY) {
                    maxDstY = dstY
                } else if (dstY < maxDstY - kReverseStopPx) {
                    Log.i(
                        "V12.11-reverse",
                        "landscape stop: dstY=$dstY max=$maxDstY (regressed ${maxDstY - dstY} px)",
                    )
                    frameClipped.release()
                    frameBGR.release()
                    return FrameTelemetry(
                        FrameOutcome.RejectedReverseDirection, -1.0, 0, yaw, pitch,
                        msSince(t0),
                isLandscape = isLandscape,
                    )
                }
            } else {
                if (dstX > maxDstX) {
                    maxDstX = dstX
                } else if (dstX < maxDstX - kReverseStopPx) {
                    Log.i(
                        "V12.11-reverse",
                        "portrait stop: dstX=$dstX max=$maxDstX (regressed ${maxDstX - dstX} px)",
                    )
                    frameClipped.release()
                    frameBGR.release()
                    return FrameTelemetry(
                        FrameOutcome.RejectedReverseDirection, -1.0, 0, yaw, pitch,
                        msSince(t0),
                isLandscape = isLandscape,
                    )
                }
            }

            // V13.0a — pose-only paste (the ONLY paste path now).
            // V12.11.1's full warpPerspective paste was removed; this
            // pose-projected (dstX, dstY) is the final paste position.
            val dstRoi = Rect(dstX, dstY, clipW, clipH).intersection(
                Rect(0, 0, canvas.cols(), canvas.rows())
            )
            if (dstRoi.width <= 0 || dstRoi.height <= 0) {
                frameClipped.release()
                frameBGR.release()
                return FrameTelemetry(
                    FrameOutcome.RejectedAlignmentLost, -1.0, 0, yaw, pitch,
                    msSince(t0),
                isLandscape = isLandscape,
                )
            }
            val srcRoi = Rect(
                dstRoi.x - dstX,
                dstRoi.y - dstY,
                dstRoi.width, dstRoi.height,
            )
            val srcRegion = Mat(frameClipped, srcRoi)
            val canvasRoi = Mat(canvas, dstRoi)
            val maskRoi = Mat(canvasMask, dstRoi)
            val emptyMask = Mat()
            Core.compare(maskRoi, Scalar(0.0), emptyMask, Core.CMP_EQ)
            val newPixels = Core.countNonZero(emptyMask)
            if (newPixels > 0) {
                srcRegion.copyTo(canvasRoi, emptyMask)
                maskRoi.setTo(Scalar(255.0), emptyMask)
                acceptedCountAtomic.incrementAndGet(); cachedBoundingRect = null
                srcRegion.release(); canvasRoi.release(); maskRoi.release()
                emptyMask.release(); frameClipped.release()
                frameBGR.release()
                return FrameTelemetry(
                    FrameOutcome.AcceptedHigh, 1.0, 0, yaw, pitch, msSince(t0),
                isLandscape = isLandscape,
                )
            }
            srcRegion.release(); canvasRoi.release(); maskRoi.release()
            emptyMask.release(); frameClipped.release()
            frameBGR.release()
            return FrameTelemetry(
                FrameOutcome.SkippedTooClose, 0.0, 0, yaw, pitch, msSince(t0),
                isLandscape = isLandscape,
            )
        }

        // V12.4 firstwins (cylindrical + central crop + first-painted-wins).
        val warped = Mat()
        val warpedMask = Mat()
        val newCornerCyl = cylindricalWarp(frameBGR, rNew, warped, warpedMask)
        if (warped.empty()) {
            frameBGR.release()
            return FrameTelemetry(
                FrameOutcome.RejectedAlignmentLost, -1.0, 0, yaw, pitch, msSince(t0),
                isLandscape = isLandscape,
            )
        }
        val newCornerCanvas = Point(
            (newCornerCyl.x - canvasOriginCylX).toDouble(),
            (newCornerCyl.y - canvasOriginCylY).toDouble(),
        )
        val dstRoi = Rect(
            newCornerCanvas.x.toInt(), newCornerCanvas.y.toInt(),
            warped.cols(), warped.rows(),
        ).intersection(Rect(0, 0, canvas.cols(), canvas.rows()))
        if (dstRoi.width <= 0 || dstRoi.height <= 0) {
            warped.release(); warpedMask.release(); frameBGR.release()
            return FrameTelemetry(
                FrameOutcome.RejectedAlignmentLost, -1.0, 0, yaw, pitch, msSince(t0),
                isLandscape = isLandscape,
            )
        }
        val srcRoi = Rect(
            dstRoi.x - newCornerCanvas.x.toInt(),
            dstRoi.y - newCornerCanvas.y.toInt(),
            dstRoi.width, dstRoi.height,
        )
        val warpedClipped = Mat(warped, srcRoi)
        val warpedMaskClipped = Mat(warpedMask, srcRoi)
        val canvasRoi = Mat(canvas, dstRoi)
        val canvasMaskRoi = Mat(canvasMask, dstRoi)

        // First-painted-wins: paint where canvasMask == 0 AND warped mask == 255.
        val noPrior = Mat()
        Core.compare(canvasMaskRoi, Scalar(0.0), noPrior, Core.CMP_EQ)
        val paintMask = Mat()
        Core.bitwise_and(noPrior, warpedMaskClipped, paintMask)
        val newPixels = Core.countNonZero(paintMask)
        if (newPixels > 0) {
            warpedClipped.copyTo(canvasRoi, paintMask)
            paintMask.copyTo(canvasMaskRoi, paintMask)
            acceptedCountAtomic.incrementAndGet(); cachedBoundingRect = null
        }
        noPrior.release(); paintMask.release()
        warped.release(); warpedMask.release(); frameBGR.release()
        return FrameTelemetry(
            if (newPixels > 0) FrameOutcome.AcceptedHigh else FrameOutcome.SkippedTooClose,
            if (newPixels > 0) 1.0 else 0.0, 0, yaw, pitch, msSince(t0),
                isLandscape = isLandscape,
        )
    }

    /**
     * Live-snapshot path — same JPEG-cycle pattern as iOS.  Cycles
     * through 4 filenames so RN's <Image> cache sees a fresh URI
     * each accept.
     *
     * Critic #8 / #9 fix: ALWAYS build state and pass `telemetry` so
     * JS sees outcome / confidence / overlapPercent / processingMs
     * even on rejected/skipped frames.  Matches the JS
     * IncrementalState contract in src/stitching/incremental.ts.
     */
    fun snapshotIfDue(telemetry: FrameTelemetry): WritableMap? {
        val isAccept = telemetry.outcome == FrameOutcome.AcceptedHigh ||
            telemetry.outcome == FrameOutcome.AcceptedMedium
        var snapshotPath: String? = null
        if (isAccept) {
            acceptsSinceSnapshot += 1
            if (acceptsSinceSnapshot >= snapshotEveryNAccepts) {
                acceptsSinceSnapshot = 0
                val path = currentSnapshotPath()
                if (writeOut(path, snapshotJpegQuality, applyExposureComp = false)) {
                    snapshotPath = path
                }
            }
        }
        lastState = buildState(snapshotPath = snapshotPath, telemetry = telemetry)
        return lastState
    }

    fun finalize(outputPath: String, quality: Int): StitcherSnapshot? {
        val cleaned = outputPath.removePrefix("file://")
        val ok = writeOut(cleaned, quality, applyExposureComp = true)
        if (!ok) return null
        val bbox = cachedBoundingRect ?: Imgproc.boundingRect(canvasMask).also { cachedBoundingRect = it }
        val snap = StitcherSnapshot(
            cleaned,
            if (bbox.width > 0) bbox.width else canvasWidth,
            if (bbox.height > 0) bbox.height else canvasHeight,
            acceptedCount,
        )
        reset()
        return snap
    }

    /**
     * Critic #22 fix: explicit native-buffer release (75 MB canvas
     * + 25 MB mask + smaller transient Mats).  Call from the bridge
     * when the engine is being thrown away (finalize/cancel paths).
     * After this, the engine is unusable.
     */
    fun release() {
        canvas.release()
        canvasMask.release()
        firstRotationArkit.release()
        rPanToWorld.release()
        kCompose.release()
        mArkitToCv.release()
        cachedBoundingRect = null
    }

    fun reset() {
        canvas.setTo(Scalar(0.0, 0.0, 0.0))
        canvasMask.setTo(Scalar(0.0))
        firstRotationArkit = Mat()
        rPanToWorld = Mat()
        kCompose = Mat()
        focalCompose = 0.0
        canvasOriginCylX = 0
        canvasOriginCylY = 0
        firstFrameDstX = 0
        firstFrameDstY = 0
        // V12.11 Step D — clear running-max trackers; reinitialised
        // to first-frame position on next accept.
        maxDstX = 0
        maxDstY = 0
        isLandscape = false
        hasFirstFrame = false
        acceptsSinceSnapshot = 0
        acceptedCountAtomic.set(0)
        snapshotSeq = 0
        lastState = null
    }

    // ─── Internals ─────────────────────────────────────────────────────

    private fun computeRPanToCam(rArkit: Mat): Mat {
        // R_panToCam = M · R_arkit^T · R_panToWorld
        val tmp1 = Mat()
        Core.gemm(rArkit.t(), rPanToWorld, 1.0, Mat(), 0.0, tmp1)
        val out = Mat()
        Core.gemm(mArkitToCv, tmp1, 1.0, Mat(), 0.0, out)
        tmp1.release()
        return out
    }

    /**
     * V12.6 cylindrical warp — full annotation in iOS' OpenCVSlitScanStitcher.mm.
     * Returns the bbox top-left in cylindrical-pixel coords.  Writes the
     * warped frame into outImage and the corresponding mask into outMask.
     */
    private fun cylindricalWarp(src: Mat, rArkit: Mat, outImage: Mat, outMask: Mat): Point {
        if (rPanToWorld.empty() || focalCompose <= 0) {
            outImage.release(); outMask.release()
            return Point(0.0, 0.0)
        }
        val rPanToCam = computeRPanToCam(rArkit)
        val rCamToPan = rPanToCam.t()

        val fx = kCompose[0, 0][0]
        val fy = kCompose[1, 1][0]
        val cx = kCompose[0, 2][0]
        val cy = kCompose[1, 2][0]
        val f = focalCompose

        // Forward-project the 4 source corners.
        val r00 = rPanToCam[0, 0][0]; val r01 = rPanToCam[0, 1][0]; val r02 = rPanToCam[0, 2][0]
        val r10 = rPanToCam[1, 0][0]; val r11 = rPanToCam[1, 1][0]; val r12 = rPanToCam[1, 2][0]
        val r20 = rPanToCam[2, 0][0]; val r21 = rPanToCam[2, 1][0]; val r22 = rPanToCam[2, 2][0]
        val cTP00 = rCamToPan[0, 0][0]; val cTP01 = rCamToPan[0, 1][0]; val cTP02 = rCamToPan[0, 2][0]
        val cTP10 = rCamToPan[1, 0][0]; val cTP11 = rCamToPan[1, 1][0]; val cTP12 = rCamToPan[1, 2][0]
        val cTP20 = rCamToPan[2, 0][0]; val cTP21 = rCamToPan[2, 1][0]; val cTP22 = rCamToPan[2, 2][0]

        fun project(u: Double, v: Double): DoubleArray {
            val rx = (u - cx) / fx
            val ry = (v - cy) / fy
            val rz = 1.0
            val wx = cTP00 * rx + cTP01 * ry + cTP02 * rz
            val wy = cTP10 * rx + cTP11 * ry + cTP12 * rz
            val wz = cTP20 * rx + cTP21 * ry + cTP22 * rz
            return if (isLandscape) {
                // Transverse cylinder (axis = pan_X)
                val denom = sqrt(wy * wy + wz * wz)
                val s = if (denom > 1e-9) (-wx / denom) else 0.0
                val theta = atan2(wy, wz)
                doubleArrayOf(f * s, -f * theta)
            } else {
                // Vertical cylinder (axis = pan_Y), V12 mirror fix.
                val theta = atan2(-wx, wz)
                val denom = sqrt(wx * wx + wz * wz)
                val h = if (denom > 1e-9) (wy / denom) else 0.0
                doubleArrayOf(f * theta, -f * h)
            }
        }

        val c00 = project(0.0, 0.0)
        val c10 = project((src.cols() - 1).toDouble(), 0.0)
        val c01 = project(0.0, (src.rows() - 1).toDouble())
        val c11 = project((src.cols() - 1).toDouble(), (src.rows() - 1).toDouble())
        val xs = doubleArrayOf(c00[0], c10[0], c01[0], c11[0])
        val ys = doubleArrayOf(c00[1], c10[1], c01[1], c11[1])
        val minX = xs.min(); val maxX = xs.max()
        val minY = ys.min(); val maxY = ys.max()

        var bboxX = floor(minX).toInt()
        var bboxY = floor(minY).toInt()
        var bboxW = (Math.ceil(maxX - minX).toInt()) + 1
        var bboxH = (Math.ceil(maxY - minY).toInt()) + 1
        if (bboxW <= 0 || bboxH <= 0 ||
            bboxW > canvasWidth * 2 || bboxH > canvasHeight * 2) {
            outImage.release(); outMask.release()
            rPanToCam.release(); rCamToPan.release()
            return Point(0.0, 0.0)
        }

        // V12.4 slit-scan + long-side clip.
        run {
            val newW: Int
            val newH: Int
            if (isLandscape) {
                newW = max(1, (bboxW * kLongSideFraction).toInt())
                newH = max(1, (bboxH * kPanStripFraction).toInt())
            } else {
                newW = max(1, (bboxW * kPanStripFraction).toInt())
                newH = max(1, (bboxH * kLongSideFraction).toInt())
            }
            bboxX += (bboxW - newW) / 2
            bboxY += (bboxH - newH) / 2
            bboxW = newW
            bboxH = newH
        }

        // Inverse-map: build mapX/mapY for cv::remap, then warp.
        val mapX = Mat(bboxH, bboxW, CvType.CV_32FC1)
        val mapY = Mat(bboxH, bboxW, CvType.CV_32FC1)

        val rowMx = FloatArray(bboxW)
        val rowMy = FloatArray(bboxW)
        val srcCols = src.cols(); val srcRows = src.rows()

        if (isLandscape) {
            for (y in 0 until bboxH) {
                val sphereY = (bboxY + y).toDouble()
                val theta = -sphereY / f
                val sinT = sin(theta); val cosT = cos(theta)
                for (x in 0 until bboxW) {
                    val sphereX = (bboxX + x).toDouble()
                    val s = sphereX / f
                    val wx = -s
                    val wy = sinT
                    val wz = cosT
                    val rx = r00 * wx + r01 * wy + r02 * wz
                    val ry = r10 * wx + r11 * wy + r12 * wz
                    val rz = r20 * wx + r21 * wy + r22 * wz
                    if (rz <= 1e-6) {
                        rowMx[x] = -1.0f; rowMy[x] = -1.0f
                    } else {
                        val u = fx * rx / rz + cx
                        val v = fy * ry / rz + cy
                        if (u < 0 || u >= srcCols || v < 0 || v >= srcRows) {
                            rowMx[x] = -1.0f; rowMy[x] = -1.0f
                        } else {
                            rowMx[x] = u.toFloat(); rowMy[x] = v.toFloat()
                        }
                    }
                }
                mapX.put(y, 0, rowMx)
                mapY.put(y, 0, rowMy)
            }
        } else {
            for (y in 0 until bboxH) {
                val cylY = (bboxY + y).toDouble()
                val h = -cylY / f
                for (x in 0 until bboxW) {
                    val cylX = (bboxX + x).toDouble()
                    val theta = cylX / f
                    val sinT = sin(theta); val cosT = cos(theta)
                    val wx = -sinT; val wy = h; val wz = cosT
                    val rx = r00 * wx + r01 * wy + r02 * wz
                    val ry = r10 * wx + r11 * wy + r12 * wz
                    val rz = r20 * wx + r21 * wy + r22 * wz
                    if (rz <= 1e-6) {
                        rowMx[x] = -1.0f; rowMy[x] = -1.0f
                    } else {
                        val u = fx * rx / rz + cx
                        val v = fy * ry / rz + cy
                        if (u < 0 || u >= srcCols || v < 0 || v >= srcRows) {
                            rowMx[x] = -1.0f; rowMy[x] = -1.0f
                        } else {
                            rowMx[x] = u.toFloat(); rowMy[x] = v.toFloat()
                        }
                    }
                }
                mapX.put(y, 0, rowMx)
                mapY.put(y, 0, rowMy)
            }
        }

        outImage.create(bboxH, bboxW, src.type())
        Imgproc.remap(
            src, outImage, mapX, mapY,
            Imgproc.INTER_LINEAR, Core.BORDER_CONSTANT, Scalar(0.0, 0.0, 0.0),
        )

        // Build the mask in a single pass by re-reading mapX rows.
        outMask.create(bboxH, bboxW, CvType.CV_8UC1)
        outMask.setTo(Scalar(0.0))
        val maskRow = ByteArray(bboxW)
        for (y in 0 until bboxH) {
            mapX.get(y, 0, rowMx)
            for (x in 0 until bboxW) {
                maskRow[x] = if (rowMx[x] >= 0.0f) 255.toByte() else 0.toByte()
            }
            outMask.put(y, 0, maskRow)
        }

        mapX.release(); mapY.release()
        rPanToCam.release(); rCamToPan.release()
        return Point(bboxX.toDouble(), bboxY.toDouble())
    }

    private fun downsampleToCompose(src: Mat): Mat {
        val scale = min(
            composeWidth.toDouble() / src.cols(),
            composeHeight.toDouble() / src.rows(),
        )
        if (scale >= 1.0) return src
        val outW = max(1, round(src.cols() * scale).toInt())
        val outH = max(1, round(src.rows() * scale).toInt())
        val out = Mat()
        Imgproc.resize(src, out, Size(outW.toDouble(), outH.toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)
        return out
    }

    private fun quaternionToRotationMat(qx: Double, qy: Double, qz: Double, qw: Double): Mat {
        val n = sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        val x = if (n > 1e-9) qx / n else qx
        val y = if (n > 1e-9) qy / n else qy
        val z = if (n > 1e-9) qz / n else qz
        val w = if (n > 1e-9) qw / n else qw
        return Mat(3, 3, CvType.CV_64F).apply {
            put(0, 0, 1 - 2 * (y * y + z * z)); put(0, 1, 2 * (x * y - w * z));     put(0, 2, 2 * (x * z + w * y))
            put(1, 0, 2 * (x * y + w * z));     put(1, 1, 1 - 2 * (x * x + z * z)); put(1, 2, 2 * (y * z - w * x))
            put(2, 0, 2 * (x * z - w * y));     put(2, 1, 2 * (y * z + w * x));     put(2, 2, 1 - 2 * (x * x + y * y))
        }
    }

    private fun currentSnapshotPath(): String {
        snapshotSeq += 1
        val slot = snapshotSeq % 4
        // Critic #27 fix: use the bridge-provided cache dir
        // (reactContext.cacheDir.absolutePath), NOT java.io.tmpdir
        // which on Android is /data/local/tmp (rooted-only).
        return "$snapshotCacheDir/rlis-live-$slot.jpg"
    }

    private fun writeOut(path: String, quality: Int, applyExposureComp: Boolean): Boolean {
        // V12 — bbox crop only, no inscribed-rect search (dropped per V12 plan).
        val bbox = Imgproc.boundingRect(canvasMask)
        val cropRect = if (bbox.width > 0 && bbox.height > 0) bbox
            else Rect(0, 0, canvasWidth, canvasHeight)
        val cropped = Mat(canvas, cropRect).clone()
        val out = if (applyExposureComp) applyClahe(cropped) else cropped
        val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, max(1, min(100, quality)))
        val ok = Imgcodecs.imwrite(path, out, params)
        if (cropped !== out) cropped.release()
        out.release()
        return ok
    }

    private fun applyClahe(src: Mat): Mat {
        val lab = Mat()
        Imgproc.cvtColor(src, lab, Imgproc.COLOR_BGR2Lab)
        val channels = mutableListOf<Mat>()
        Core.split(lab, channels)
        val clahe = Imgproc.createCLAHE(2.0, Size(8.0, 8.0))
        clahe.apply(channels[0], channels[0])
        Core.merge(channels, lab)
        val out = Mat()
        Imgproc.cvtColor(lab, out, Imgproc.COLOR_Lab2BGR)
        for (c in channels) c.release()
        lab.release()
        return out
    }

    /**
     * Critic #8/#9/#23 fix: always include the full state event shape
     * the JS IncrementalState interface expects (outcome, confidence,
     * overlapPercent, processingMs).  Matches the hybrid engine's
     * shape so JS subscribers don't break when the engine variant
     * is toggled at runtime.
     *
     * Critic #30 fix: use cached bounding rect; refresh once per
     * accept inside the inner loops, NOT here on every state event.
     */
    private fun buildState(snapshotPath: String?, telemetry: FrameTelemetry): WritableMap {
        val map = com.facebook.react.bridge.Arguments.createMap()
        map.putInt("acceptedCount", acceptedCount)
        if (snapshotPath != null) {
            map.putString("panoramaPath", snapshotPath)
        } else {
            map.putNull("panoramaPath")
        }
        val r = cachedBoundingRect ?: Imgproc.boundingRect(canvasMask).also { cachedBoundingRect = it }
        map.putInt("width", if (r.width > 0) r.width else 0)
        map.putInt("height", if (r.height > 0) r.height else 0)
        map.putInt("outcome", telemetry.outcome.ordinal)
        map.putDouble("confidence", telemetry.confidence)
        map.putDouble("overlapPercent", telemetry.overlapPercent)
        map.putDouble("processingMs", telemetry.processingMs)
        // V12.12 — engine-detected orientation, plumbed through to JS
        // for the band overlay + dim bar UI.
        map.putBoolean("isLandscape", telemetry.isLandscape)
        return map
    }

    private fun msSince(t0Nanos: Long): Double =
        (System.nanoTime() - t0Nanos) / 1_000_000.0
}

// Helper: Rect intersection (Android OpenCV doesn't expose it cleanly).
private fun Rect.intersection(other: Rect): Rect {
    val x = max(this.x, other.x)
    val y = max(this.y, other.y)
    val r = min(this.x + this.width, other.x + other.width)
    val b = min(this.y + this.height, other.y + other.height)
    return Rect(x, y, max(0, r - x), max(0, b - y))
}

// V13.0a — homographyOffset(), HomographyResult, and the kHomogTier*
// constants were removed in the revert from V12.11.1 + V12.14
// (ORB+RANSAC homography correction with 3-tier confidence ladder)
// back to pose-only paste.  See iOS OpenCVSlitScanStitcher.mm for
// the matching revert + V13.0b plan (1D column-edge NCC correlation
// for sub-pixel perpendicular drift correction).

