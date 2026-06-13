// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.ar

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.view.Surface
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** AR keyframe long-edge budget (px).  Every device's acquired AR frame is
 *  downscaled to this before the keyframe JPEG is written, so the stitch
 *  held-set (and thus memory) is consistent across devices regardless of
 *  their ARCore 4:3 image resolution.  Matches the non-AR keyframe size. */
private const val AR_KEYFRAME_MAX_LONG_EDGE = 640

/**
 * Convert an ARCore `Image` (YUV_420_888) to a JPEG file on disk.
 *
 * 2026-05-22 (audit follow-up #19) — split into two phases so callers
 * can release the underlying ARCore `Image` ASAP:
 *
 *   1. `packNV21(image)`  — reads the Y/U/V planes into a contiguous
 *      JVM-side `ByteArray` (NV21 layout).  Fast (~3 ms for 1920×1080).
 *      The caller can close the `Image` IMMEDIATELY after this returns,
 *      freeing the ARCore Camera2 ImageReader buffer.
 *
 *   2. `encodeJpegFromNV21(packed, …)` — does the slow YUV→JPEG
 *      conversion (~10-25 ms) on the already-extracted bytes, NOT on
 *      the Image.  Safe to run after the Image has been closed.
 *
 * The pre-#19 single-call `encodeToJpeg(image, …)` API is preserved as
 * a thin wrapper for callers that don't care about Image hold time
 * (e.g., one-shot photo capture).  Performance-critical paths
 * (`RNSARCameraView.forwardToIncremental`, called at ~60 Hz on the
 * GL render thread) should use the two-step API to keep Image hold
 * times bounded by the ~3 ms pack step instead of the ~25 ms encode.
 *
 * Why JPEG → file → re-decode by OpenCV (slightly wasteful)?
 *   The incremental engine's existing API (matching iOS') consumes
 *   image PATHS, not raw planes.  Threading raw YUV through the
 *   bridge would require a second native ingestion path.  At ~3-5
 *   Hz of accepted frames, a ~10 ms YUV→JPEG encode is negligible
 *   next to the ~40 ms per-frame engine work — keeping the surface
 *   uniform across iOS / Android paths is worth the few-ms cost.
 *
 * `Image` ownership: the two-step API (`packNV21` + `encodeJpegFromNV21`)
 * returns control to the caller after the pack step so the caller can
 * close the Image at the right moment.  The legacy single-call
 * `encodeToJpeg(image, …)` does NOT close the Image — caller is
 * responsible for that.
 */
internal object YuvImageConverter {

    /**
     * Packed NV21 pixel data extracted from an ARCore `Image`.
     * Once you hold one of these, the source `Image` can be closed —
     * all subsequent operations work on the JVM-side byte array.
     *
     * NV21 layout (single contiguous byte array):
     *   bytes [0 .. width*height)              = Y plane (luminance),
     *                                            densely packed,
     *                                            row stride = width
     *   bytes [width*height .. width*height*3/2) = interleaved V-U pairs
     *                                              at half resolution
     *
     * The Y plane portion can be passed directly to the C++
     * `keyframe_gate` as grayscale pixels with `stride = width`.
     */
    data class PackedYuv(
        val nv21: ByteArray,
        val width: Int,
        val height: Int,
    ) {
        /** Length of the Y plane portion (bytes [0 .. ySize)). */
        val ySize: Int get() = width * height

        // equals + hashCode override required because `nv21` is a
        // mutable array; default `data class` equality uses reference
        // identity for arrays, which is rarely what callers want.
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is PackedYuv) return false
            return width == other.width
                && height == other.height
                && nv21.contentEquals(other.nv21)
        }
        override fun hashCode(): Int {
            var result = nv21.contentHashCode()
            result = 31 * result + width
            result = 31 * result + height
            return result
        }
    }


    /**
     * Pack the Y, U, V planes of a YUV_420_888 `Image` into a
     * contiguous JVM-side NV21 byte array.  Returns null if the
     * `Image`'s format isn't YUV_420_888 or doesn't expose 3 planes.
     *
     * Performance: ~3 ms for 1920×1080 on a Galaxy A35.  Dominated
     * by the row-by-row copy through the direct ByteBuffers backing
     * the camera planes.
     *
     * The Y plane is densely repacked (the source rowStride may be
     * padded, but we discard padding on the way in so the result has
     * `rowStride = width`).  This is what callers want — `cv::Mat`
     * wrap on the C++ side prefers tight strides, and downstream
     * `YuvImage.compressToJpeg` requires densely-packed input.
     */
    fun packNV21(image: Image): PackedYuv? {
        if (image.format != ImageFormat.YUV_420_888) return null
        val planes = image.planes
        if (planes.size < 3) return null

        val w = image.width
        val h = image.height
        val ySize = w * h
        val uvSize = w * h / 2
        val nv21 = ByteArray(ySize + uvSize)

        // ── Y plane (luminance) ─────────────────────────────────
        val yPlane = planes[0]
        val yBuf = yPlane.buffer
        val yRowStride = yPlane.rowStride
        if (yRowStride == w) {
            // Source already densely packed — single block copy.
            // Use duplicate() so we don't mutate the original buffer's
            // position state (defensive — ARCore may have other readers
            // of the same underlying buffer, though in practice it
            // shouldn't).
            yBuf.duplicate().apply { rewind() }.get(nv21, 0, ySize)
        } else {
            // Row-by-row copy when stride > width (padded rows).
            val dup = yBuf.duplicate()
            var dstOffset = 0
            var srcOffset = 0
            for (row in 0 until h) {
                dup.position(srcOffset)
                dup.get(nv21, dstOffset, w)
                dstOffset += w
                srcOffset += yRowStride
            }
        }

        // ── U + V planes (chroma) ───────────────────────────────
        // YUV_420_888 has them subsampled 2:1 so each plane physically
        // covers (w/2) × (h/2).  Pixel stride is 1 (planar) or 2
        // (semi-planar interleaved).  NV21 expects interleaved V-U.
        val uPlane = planes[1]
        val vPlane = planes[2]
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer
        val uRowStride = uPlane.rowStride
        val uPixelStride = uPlane.pixelStride
        val vRowStride = vPlane.rowStride
        val vPixelStride = vPlane.pixelStride

        // Fast path — most Android camera2 / ARCore producers emit
        // semi-planar interleaved data with pixelStride=2.  In that
        // case the V plane's underlying bytes physically interleave
        // V-U-V-U... and copying the V plane's full byte range
        // produces NV21 layout directly.
        if (uPixelStride == 2 && vPixelStride == 2 &&
            uRowStride == vRowStride && uRowStride == w) {
            val vBytes = vBuf.remaining().coerceAtMost(uvSize)
            // Defensive duplicate() again — same reasoning as Y plane.
            vBuf.duplicate().apply { rewind() }.get(nv21, ySize, vBytes)
            return PackedYuv(nv21, w, h)
        }

        // Slow path — manual interleave for planar (pixelStride=1) or
        // non-tight semi-planar layouts.
        var pos = ySize
        val rowsUv = h / 2
        val colsUv = w / 2
        for (row in 0 until rowsUv) {
            for (col in 0 until colsUv) {
                val vIdx = row * vRowStride + col * vPixelStride
                val uIdx = row * uRowStride + col * uPixelStride
                nv21[pos++] = vBuf.get(vIdx)
                nv21[pos++] = uBuf.get(uIdx)
            }
        }
        return PackedYuv(nv21, w, h)
    }


    /**
     * Encode an already-packed NV21 buffer to a JPEG file on disk.
     *
     * Returns the output path on success, or null on any encode/write
     * error (caller decides whether to log + drop the frame).
     *
     * `displayRotation` writes the appropriate EXIF orientation tag
     * so consumers that respect EXIF (RN's Image loader, etc.)
     * display the JPEG upright regardless of how the device was held
     * at capture.  Should be the value from
     * `WindowManager.defaultDisplay.rotation` at capture time
     * (Surface.ROTATION_0 / _90 / _180 / _270).
     *
     * Sensor orientation 90° assumed (back camera) — verified on
     * Galaxy A35.  Wire `CameraCharacteristics.SENSOR_ORIENTATION`
     * through in a follow-up if we hit a device that differs.
     */
    fun encodeJpegFromNV21(
        packed: PackedYuv,
        outputPath: String,
        jpegQuality: Int = 70,
        displayRotation: Int = Surface.ROTATION_0,
    ): String? {
        val yuvImage = YuvImage(
            packed.nv21,
            ImageFormat.NV21,
            packed.width,
            packed.height,
            null,
        )
        val baos = ByteArrayOutputStream()
        val ok = yuvImage.compressToJpeg(
            Rect(0, 0, packed.width, packed.height),
            jpegQuality.coerceIn(1, 100),
            baos,
        )
        if (!ok) return null
        // AR keyframe downscale guard — normalise the long edge to
        // AR_KEYFRAME_MAX_LONG_EDGE so every device (whatever its ARCore 4:3
        // image resolution) writes the same ~0.3 MP keyframe -> consistent
        // stitch memory cross-device.  Only the SAVED keyframe is scaled; the
        // C++ keyframe gate already ran on the full-res Y plane upstream.
        var jpegBytes = baos.toByteArray()
        if (max(packed.width, packed.height) > AR_KEYFRAME_MAX_LONG_EDGE) {
            val src = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size)
            if (src != null) {
                val scale =
                    AR_KEYFRAME_MAX_LONG_EDGE.toFloat() / max(src.width, src.height)
                val dst = Bitmap.createScaledBitmap(
                    src,
                    (src.width * scale).roundToInt().coerceAtLeast(1),
                    (src.height * scale).roundToInt().coerceAtLeast(1),
                    true,
                )
                val baos2 = ByteArrayOutputStream()
                dst.compress(
                    Bitmap.CompressFormat.JPEG,
                    jpegQuality.coerceIn(1, 100),
                    baos2,
                )
                jpegBytes = baos2.toByteArray()
                if (dst !== src) dst.recycle()
                src.recycle()
            }
        }
        try {
            FileOutputStream(File(outputPath)).use { it.write(jpegBytes) }
        } catch (e: Throwable) {
            return null
        }

        // Write EXIF orientation tag based on display rotation.
        // The math:
        //   ROTATION_0  (portrait, sensor 90° CW from screen-up)
        //     → JPEG needs 90° CW to display upright → ROTATE_90 (6)
        //   ROTATION_90 (landscape-left, sensor aligned with screen)
        //     → no rotation → NORMAL (1)
        //   ROTATION_180 (portrait-upside-down)
        //     → 270° CW → ROTATE_270 (8)
        //   ROTATION_270 (landscape-right)
        //     → 180° → ROTATE_180 (3)
        //
        // EXIF tag set EVEN when the orientation is normal — keeps
        // every output JPEG self-describing for downstream consumers.
        // cv::Stitcher does NOT auto-honour EXIF (see
        // BatchStitcher.applyExifOrientation); this metadata exists
        // primarily for the live thumbnail strip + future RN Image
        // renderers.
        val exifOrientation = when (displayRotation) {
            Surface.ROTATION_0   -> ExifInterface.ORIENTATION_ROTATE_90
            Surface.ROTATION_90  -> ExifInterface.ORIENTATION_NORMAL
            Surface.ROTATION_180 -> ExifInterface.ORIENTATION_ROTATE_270
            Surface.ROTATION_270 -> ExifInterface.ORIENTATION_ROTATE_180
            else                 -> ExifInterface.ORIENTATION_NORMAL
        }
        try {
            val exif = ExifInterface(outputPath)
            exif.setAttribute(
                ExifInterface.TAG_ORIENTATION,
                exifOrientation.toString(),
            )
            exif.saveAttributes()
        } catch (e: Throwable) {
            // EXIF write failed — JPEG itself is still valid; just
            // missing the orientation hint.  Non-fatal; caller doesn't
            // need to know.
        }
        return outputPath
    }


    /**
     * Single-call convenience wrapper: pack the `Image` and encode
     * to JPEG in one step.  Keeps the `Image` open through the entire
     * ~25 ms encode — fine for one-shot photo capture, NOT
     * recommended for the ~60 Hz `forwardToIncremental` path.  See the
     * file-level docs for the two-step alternative.
     *
     * Caller still owns the `Image` and MUST close it afterwards;
     * this function does not.
     */
    fun encodeToJpeg(
        image: Image,
        outputPath: String,
        jpegQuality: Int = 70,
        displayRotation: Int = Surface.ROTATION_0,
    ): String? {
        val packed = packNV21(image) ?: return null
        return encodeJpegFromNV21(
            packed,
            outputPath,
            jpegQuality = jpegQuality,
            displayRotation = displayRotation,
        )
    }
}
