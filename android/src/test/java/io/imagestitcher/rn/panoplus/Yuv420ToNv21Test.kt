// SPDX-License-Identifier: Apache-2.0
//
// Yuv420ToNv21Test.kt — the ONE part of PanoPlusAndroidRecorder that can be
// tested without a device, and the part whose failure is invisible.
//
// A stride bug here does not crash and does not show up in any counter: the
// pack is written, the ledger is clean, every frame is present, and every
// pixel is wrong — sheared by a few bytes per row, or with U and V swapped so
// the shelf is orange where it is blue.  The recorder cannot detect that, so
// it is pinned here instead, against layouts synthesised to match the three
// real ones (planar I420, semi-planar NV21-order, semi-planar NV12-order) and
// the padded variants of each.
//
// `Yuv420ToNv21.convert` takes ByteBuffers and ints precisely so this file can
// exist; nothing in it touches android.media.Image or android.graphics.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.ByteBuffer

class Yuv420ToNv21Test {

    private val w = 8
    private val h = 6

    /** Y(x,y), U(cx,cy), V(cx,cy) — distinct, and distinct BETWEEN planes, so
     *  a U/V swap or a row shear cannot pass by coincidence. */
    private fun yVal(x: Int, y: Int): Byte = (10 + y * w + x).toByte()
    private fun uVal(x: Int, y: Int): Byte = (100 + y * (w / 2) + x).toByte()
    private fun vVal(x: Int, y: Int): Byte = (200 + y * (w / 2) + x).toByte()

    /** The one correct answer, built independently of the converter. */
    private fun expected(): ByteArray {
        val out = ByteArray(w * h * 3 / 2)
        for (y in 0 until h) for (x in 0 until w) out[y * w + x] = yVal(x, y)
        var o = w * h
        for (cy in 0 until h / 2) for (cx in 0 until w / 2) {
            out[o++] = vVal(cx, cy)   // NV21 is V FIRST
            out[o++] = uVal(cx, cy)
        }
        return out
    }

    private fun buf(n: Int) = ByteBuffer.allocateDirect(n)

    private fun scratchFor(yPs: Int, uPs: Int, vPs: Int) =
        ByteArray(Yuv420ToNv21.scratchBytes(w, yPs, uPs, vPs))

    private fun yPlane(rowStride: Int, pixelStride: Int): ByteBuffer {
        val b = buf(rowStride * h + 64)
        for (y in 0 until h) for (x in 0 until w) {
            b.put(y * rowStride + x * pixelStride, yVal(x, y))
        }
        return b
    }

    // ── Planar (I420): U and V in their own buffers, pixelStride 1 ──────

    @Test
    fun planarI420_unpadded() {
        val cw = w / 2; val ch = h / 2
        val u = buf(cw * ch + 64); val v = buf(cw * ch + 64)
        for (cy in 0 until ch) for (cx in 0 until cw) {
            u.put(cy * cw + cx, uVal(cx, cy))
            v.put(cy * cw + cx, vVal(cx, cy))
        }
        val out = ByteArray(w * h * 3 / 2)
        val layout = Yuv420ToNv21.convert(
            yPlane(w, 1), w, 1, u, cw, 1, v, cw, 1, w, h, out, scratchFor(1, 1, 1),
        )
        assertArrayEquals(expected(), out)
        assertTrue(layout.family().startsWith("planar"))
        assertTrue(layout.yBulkRowCopy)
    }

    @Test
    fun planarI420_paddedRowStrides() {
        // Padded chroma rows are the common real case on hardware that aligns
        // every plane row to 16 or 64 bytes.
        val cw = w / 2; val ch = h / 2
        val uRs = cw + 5; val vRs = cw + 11
        val u = buf(uRs * ch + 64); val v = buf(vRs * ch + 64)
        for (cy in 0 until ch) for (cx in 0 until cw) {
            u.put(cy * uRs + cx, uVal(cx, cy))
            v.put(cy * vRs + cx, vVal(cx, cy))
        }
        val out = ByteArray(w * h * 3 / 2)
        Yuv420ToNv21.convert(
            yPlane(w + 7, 1), w + 7, 1, u, uRs, 1, v, vRs, 1, w, h, out, scratchFor(1, 1, 1),
        )
        assertArrayEquals(expected(), out)
    }

    // ── Semi-planar: ONE interleaved region, two views into it ──────────

    /**
     * Build a real semi-planar chroma region and return (uBuffer, vBuffer)
     * positioned as Camera2 positions them: both views onto the same memory,
     * offset by one byte from each other.
     *
     * @param vFirst true for NV21 order (V at offset 0), false for NV12 order.
     */
    private fun semiPlanar(rowStride: Int, vFirst: Boolean): Pair<ByteBuffer, ByteBuffer> {
        val cw = w / 2; val ch = h / 2
        val region = buf(rowStride * ch + 64)
        for (cy in 0 until ch) for (cx in 0 until cw) {
            val base = cy * rowStride + cx * 2
            if (vFirst) {
                region.put(base, vVal(cx, cy)); region.put(base + 1, uVal(cx, cy))
            } else {
                region.put(base, uVal(cx, cy)); region.put(base + 1, vVal(cx, cy))
            }
        }
        val vOff = if (vFirst) 0 else 1
        val uOff = if (vFirst) 1 else 0
        val vb = region.duplicate(); vb.position(vOff)
        val ub = region.duplicate(); ub.position(uOff)
        return ub.slice() to vb.slice()
    }

    @Test
    fun semiPlanar_nv21Order() {
        val (u, v) = semiPlanar(w, vFirst = true)
        val out = ByteArray(w * h * 3 / 2)
        val layout = Yuv420ToNv21.convert(
            yPlane(w, 1), w, 1, u, w, 2, v, w, 2, w, h, out, scratchFor(1, 2, 2),
        )
        assertArrayEquals(expected(), out)
        assertTrue(layout.family().startsWith("semi-planar"))
    }

    /**
     * THE ONE THAT MATTERS. On an NV12-order device the V plane starts one
     * byte AFTER the U plane. A converter that assumes adjacency — the
     * "advance V by one and compare" fast path this recorder deliberately does
     * not use — writes U where V belongs and produces a whole pack with the
     * chroma channels swapped. Same geometry, wrong colour, nothing in the
     * pack to say so.
     */
    @Test
    fun semiPlanar_nv12Order_isNotSwapped() {
        val (u, v) = semiPlanar(w, vFirst = false)
        val out = ByteArray(w * h * 3 / 2)
        Yuv420ToNv21.convert(
            yPlane(w, 1), w, 1, u, w, 2, v, w, 2, w, h, out, scratchFor(1, 2, 2),
        )
        assertArrayEquals(expected(), out)
    }

    @Test
    fun semiPlanar_paddedRowStride() {
        val rs = w + 16
        val (u, v) = semiPlanar(rs, vFirst = true)
        val out = ByteArray(w * h * 3 / 2)
        Yuv420ToNv21.convert(
            yPlane(w + 32, 1), w + 32, 1, u, rs, 2, v, rs, 2, w, h, out, scratchFor(1, 2, 2),
        )
        assertArrayEquals(expected(), out)
    }

    // ── Luma with a non-unit pixelStride (the rare, ugly case) ─────────

    @Test
    fun lumaPixelStride2() {
        val yPs = 2; val yRs = w * yPs + 9
        val cw = w / 2; val ch = h / 2
        val u = buf(cw * ch + 64); val v = buf(cw * ch + 64)
        for (cy in 0 until ch) for (cx in 0 until cw) {
            u.put(cy * cw + cx, uVal(cx, cy)); v.put(cy * cw + cx, vVal(cx, cy))
        }
        val out = ByteArray(w * h * 3 / 2)
        val layout = Yuv420ToNv21.convert(
            yPlane(yRs, yPs), yRs, yPs, u, cw, 1, v, cw, 1, w, h, out, scratchFor(yPs, 1, 1),
        )
        assertArrayEquals(expected(), out)
        assertTrue("a strided luma plane cannot be bulk-copied", !layout.yBulkRowCopy)
    }

    // ── Contracts the recorder relies on ───────────────────────────────

    @Test
    fun bufferPositionsAreRestored() {
        val cw = w / 2; val ch = h / 2
        val y = yPlane(w, 1)
        val u = buf(cw * ch + 64); val v = buf(cw * ch + 64)
        y.position(0); u.position(0); v.position(0)
        Yuv420ToNv21.convert(
            y, w, 1, u, cw, 1, v, cw, 1, w, h, ByteArray(w * h * 3 / 2), scratchFor(1, 1, 1),
        )
        // The Image is closed right after conversion, but a moved position
        // would silently corrupt any second read of the same planes.
        assertEquals(0, y.position())
        assertEquals(0, u.position())
        assertEquals(0, v.position())
    }

    @Test
    fun nonZeroBufferPositionIsHonoured() {
        // Camera2 hands back buffers positioned at 0, but a sliced/duplicated
        // view need not be — and the semi-planar case above produces exactly
        // that. Addressing must be relative to the incoming position.
        val cw = w / 2; val ch = h / 2
        val pad = 13
        val yb = buf(w * h + pad + 64)
        for (yy in 0 until h) for (x in 0 until w) yb.put(pad + yy * w + x, yVal(x, yy))
        yb.position(pad)
        val ub = buf(cw * ch + pad + 64); val vb = buf(cw * ch + pad + 64)
        for (cy in 0 until ch) for (cx in 0 until cw) {
            ub.put(pad + cy * cw + cx, uVal(cx, cy))
            vb.put(pad + cy * cw + cx, vVal(cx, cy))
        }
        ub.position(pad); vb.position(pad)
        val out = ByteArray(w * h * 3 / 2)
        Yuv420ToNv21.convert(
            yb, w, 1, ub, cw, 1, vb, cw, 1, w, h, out, scratchFor(1, 1, 1),
        )
        assertArrayEquals(expected(), out)
        assertEquals(pad, yb.position())
    }

    @Test
    fun scratchIsBigEnoughForEveryLayoutTheConverterAccepts() {
        // scratchBytes() is the recorder's only sizing input; if it under-
        // reports, convert() throws mid-sweep on a device nobody can attach a
        // debugger to.
        for (width in intArrayOf(2, 8, 64, 640, 1920, 4000)) {
            for (yPs in intArrayOf(1, 2)) for (uPs in intArrayOf(1, 2)) for (vPs in intArrayOf(1, 2)) {
                val n = Yuv420ToNv21.scratchBytes(width, yPs, uPs, vPs)
                val cw = width / 2
                val chromaRow = (cw - 1) * maxOf(uPs, vPs) + 1
                val lumaRow = (width - 1) * yPs + 1
                assertTrue(
                    "scratch $n too small for w=$width yPs=$yPs uPs=$uPs vPs=$vPs",
                    n / 2 >= chromaRow && n >= lumaRow,
                )
            }
        }
    }

    @Test
    fun oddDimensionsAreRefusedNotSilentlyTruncated() {
        try {
            Yuv420ToNv21.convert(
                buf(64), 7, 1, buf(64), 4, 1, buf(64), 4, 1, 7, 6,
                ByteArray(128), ByteArray(256),
            )
            fail("an odd width must be refused: 4:2:0 chroma cannot address it")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun undersizedOutputIsRefused() {
        val cw = w / 2; val ch = h / 2
        try {
            Yuv420ToNv21.convert(
                yPlane(w, 1), w, 1, buf(cw * ch + 64), cw, 1, buf(cw * ch + 64), cw, 1,
                w, h, ByteArray(w * h), scratchFor(1, 1, 1),   // luma only: too small
            )
            fail("an out[] with no room for chroma must be refused")
        } catch (_: IllegalArgumentException) {
        }
    }
}
