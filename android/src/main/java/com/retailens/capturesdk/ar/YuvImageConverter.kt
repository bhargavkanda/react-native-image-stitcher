// SPDX-License-Identifier: UNLICENSED
package com.retailens.capturesdk.ar

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.view.Surface
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream

/**
 * Convert an ARCore `Image` (YUV_420_888) to a JPEG file on disk.
 *
 * Why JPEG → file → re-decode by OpenCV (slightly wasteful)?
 *   The incremental engine's existing API (matching iOS') consumes
 *   image PATHS, not raw planes.  Threading raw YUV through the
 *   bridge would require a second native ingestion path.  At ~3-5
 *   Hz of accepted frames, a ~10 ms YUV→JPEG encode is negligible
 *   next to the ~40 ms per-frame engine work — keeping the surface
 *   uniform across iOS / Android paths is worth the few-ms cost.
 *
 * `Image` ownership: caller MUST `image.close()` after this returns.
 * We don't close inside because the caller may want to inspect more
 * fields (timestamp, format) before releasing.
 */
internal object YuvImageConverter {

    /// Convert + write JPEG.  Returns the path (no file:// prefix)
    /// or null on any encode/write error (caller-decides whether to
    /// log + drop the frame).
    ///
    /// 2026-05-15 (B3) — `displayRotation` parameter writes the
    /// appropriate EXIF orientation tag so RN's Image loader (and
    /// any other consumer that respects EXIF) displays the JPEG
    /// upright regardless of how the device was held at capture.
    ///
    /// Without this, Android's image loaders display the raw sensor
    /// pixels (typically landscape) as-is — so a portrait-held
    /// capture's thumbnail appears sideways.  iOS's image loader
    /// auto-respects EXIF orientation; Android's doesn't always
    /// (depends on the loader path).  Setting the tag covers both.
    ///
    /// `displayRotation` should be the value returned from
    /// `WindowManager.defaultDisplay.rotation` at capture time
    /// (Surface.ROTATION_0/_90/_180/_270).  We assume a typical
    /// back-camera sensor orientation of 90° — true for all
    /// devices we ship to (Galaxy A35 verified).  Wire through
    /// CameraCharacteristics.SENSOR_ORIENTATION in a follow-up
    /// if we ever encounter a device that differs.
    ///
    /// Default `displayRotation = Surface.ROTATION_0` (portrait)
    /// preserves the previous behaviour for legacy callsites that
    /// haven't been updated yet.
    fun encodeToJpeg(
        image: Image,
        outputPath: String,
        jpegQuality: Int = 70,
        displayRotation: Int = Surface.ROTATION_0,
    ): String? {
        if (image.format != ImageFormat.YUV_420_888) return null
        val nv21 = yuv420toNV21(image) ?: return null
        val yuvImage = YuvImage(
            nv21,
            ImageFormat.NV21,
            image.width,
            image.height,
            null,
        )
        val baos = ByteArrayOutputStream()
        val ok = yuvImage.compressToJpeg(
            Rect(0, 0, image.width, image.height),
            jpegQuality.coerceIn(1, 100),
            baos,
        )
        if (!ok) return null
        try {
            FileOutputStream(File(outputPath)).use { it.write(baos.toByteArray()) }
        } catch (e: Throwable) {
            return null
        }
        // Write EXIF orientation tag based on display rotation.
        // Sensor orientation 90° assumed (back camera).  The math:
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
        // every output JPEG self-describing for downstream
        // consumers (cv::Stitcher does NOT auto-honour EXIF, see
        // RetaiLensStitcher.applyExifOrientation; this metadata
        // exists primarily for the live thumbnail strip + future
        // RN Image renderers).
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
            // missing the orientation hint.  Caller doesn't need to
            // know — non-fatal.
        }
        return outputPath
    }

    /**
     * Pack a YUV_420_888 `Image` into a contiguous NV21 byte array.
     *
     * The Image API exposes Y, U, V as three planes, each with its
     * own row stride and pixel stride.  NV21 expects a single
     * contiguous buffer with Y plane first, then interleaved VU bytes
     * after.  The repacking handles row + pixel strides that don't
     * match the dense layout.
     */
    private fun yuv420toNV21(image: Image): ByteArray? {
        val w = image.width
        val h = image.height
        val ySize = w * h
        val uvSize = w * h / 2

        val nv21 = ByteArray(ySize + uvSize)
        val planes = image.planes
        if (planes.size < 3) return null

        // Y plane.
        val yPlane = planes[0]
        val yBuf = yPlane.buffer
        val yRowStride = yPlane.rowStride
        if (yRowStride == w) {
            yBuf.get(nv21, 0, ySize)
        } else {
            // Row-by-row copy when stride != width.
            var dstOffset = 0
            var srcOffset = 0
            for (row in 0 until h) {
                yBuf.position(srcOffset)
                yBuf.get(nv21, dstOffset, w)
                dstOffset += w
                srcOffset += yRowStride
            }
        }

        // U + V planes.  YUV_420_888 has them subsampled 2:1 so each
        // covers (w/2) × (h/2).  Pixel stride is 1 (planar) or 2
        // (semi-planar interleaved).  NV21 requires interleaved VU.
        val uPlane = planes[1]
        val vPlane = planes[2]
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer
        val uRowStride = uPlane.rowStride
        val uPixelStride = uPlane.pixelStride
        val vRowStride = vPlane.rowStride
        val vPixelStride = vPlane.pixelStride

        // Most camera2 / ARCore implementations on Android already
        // produce semi-planar interleaved data with pixelStride=2.
        // In that case Y plane + V plane (offset by 1) form NV21
        // directly with a single block copy.  Detect + fast-path it.
        if (uPixelStride == 2 && vPixelStride == 2 &&
            uRowStride == vRowStride && uRowStride == w) {
            // The V plane in NV21 layout starts at vBuf's first byte.
            // Copy the entire V plane (which physically interleaves
            // with U bytes since pixelStride=2 means consecutive
            // bytes are V-U-V-U...).
            val vBytes = vBuf.remaining().coerceAtMost(uvSize)
            vBuf.get(nv21, ySize, vBytes)
            return nv21
        }

        // Slow path — manual interleave.
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
        return nv21
    }
}
