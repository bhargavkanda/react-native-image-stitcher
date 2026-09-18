// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusPreviewTransform — the viewfinder's geometry, as arithmetic.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
//
// The operator's 2026-09-02 report, in two lines: "the viewfinder is
// elongated vertically" and "in landscape the viewfinder is sideways".
//
// Both are ONE missing call. `PanoPlusPreviewView` is a bare `TextureView`
// and `setTransform` was never called anywhere in this module, so the
// identity transform ran — and a TextureView with the identity transform
// STRETCHES its SurfaceTexture to fill the view rect and never rotates it.
// Measured on SM-A356U1 with the pack's own numbers (buffer 1440x1080 from
// the live packs' `preview.size`, view 1080x2340 from `dumpsys activity
// top`): x-scale 0.750, y-scale 2.167 — an anisotropy of 2.889x, vertical.
// That is the elongation. The absent rotation term is the sideways landscape.
//
// iOS never had either fault because `AVCaptureVideoPreviewLayer` carries
// `videoGravity` and its own connection orientation; Camera2 has no such
// thing and every correct Camera2 preview computes this matrix by hand.
//
// ── WHY IT IS A SEPARATE, ANDROID-FREE FILE ─────────────────────────────
//
// Because the sign of the display term is the classic place to be wrong, and
// a wrong sign is invisible in portrait (where display rotation is 0 and the
// term vanishes) and only shows up on a phone turned sideways in an aisle.
// Nothing here touches `android.*` or React Native, so the JVM suite
// (src/test/…/PanoPlusPreviewTransformTest.kt) exercises all four display
// rotations x both sensor mountings by mapping real corners — the same rule,
// and the same reason, as `PanoPlusProbeMath`.
//
// ⚠ NOT THE SAME QUANTITY AS THE DELIVERABLE'S BAKE — AND THIS FILE ONCE
// CLAIMED IT WAS. That claim ("one rule, one file, so the viewfinder and the
// canvas can never latch different answers") is what put a sensor term into
// the matrix below, and it is measurably false. On SM-A356U1, camera 2,
// SENSOR_ORIENTATION 90, phone held PORTRAIT, one instant:
//
//     the deliverable (canvas.jpg) needs a 90° CW bake to stand upright
//     the viewfinder (this file)   needs 0°     to stand upright
//
// Both verified by picture on 2026-09-02 — pack pp_1788407362514 wrote
// `outputRotationCwDeg: 90` and its canvas.jpg (541x721) is upright, while
// the four-way rotation sweep on the same pose showed rot=0 upright and
// rot=90 a quarter turn over.
//
// They differ because THE TWO BUFFERS ARE NOT IN THE SAME FRAME:
//
//   * the ENGINE is fed by an ImageReader — a CPU consumer — and Camera2
//     hands those buffers over in the raw SENSOR frame. So the engine, and
//     only the engine, owes SENSOR_ORIENTATION. That is
//     PanoPlusUprightRotation, and it is correct as written.
//   * this VIEW is fed by a SurfaceTexture — a GPU/display consumer — and
//     the camera has ALREADY applied the sensor orientation to those buffers
//     (the native-window transform hint) before they reach the view. Owing
//     it a second time is the quarter turn the operator reported.
//
// This is also why AOSP's own Camera2Basic applies NO rotation at
// ROTATION_0 and only `90 * (rotation - 2)` for the sideways cases: the
// display term is the whole rule for a TextureView preview.
//
// ⚠ AND THE SECOND HALF OF THAT SAME FACT, WHICH THIS FILE GOT WRONG UNTIL
// 2026-09-03. Removing the sensor term from the ROTATION was right. Removing
// it from the ASPECT was not, and it is the SAME premise that decides both:
//
//     if the camera has already turned the CONTENT by SENSOR_ORIENTATION
//     before the buffer reaches a SurfaceTexture, then a 1440x1080 buffer
//     carries a 1080x1440 PICTURE.
//
// The rotation is therefore 0 (nothing left to undo) and the fit box is
// 1080x1440 (portrait), not 1440x1080. Choosing the box from the buffer's own
// width and height letterboxed a 3:4 picture into a 4:3 box and SQUASHED it by
// (4/3)/(3/4) = 1.778 vertically — measured on SM-A356U1 2026-09-03 three ways:
// against the phone's own stock camera at the same 0.5x lens and pose (fan
// blade span 293 px in both, i.e. 1.000x across; downrod 177 px vs 99 px, i.e.
// 1.78x down); by the drawn band itself (stock 1080x1440, pano+ 1080x810); and
// against the deliverable from the same frames (canvas.jpg 541x721, 3:4). The
// picture that settles it costs nothing to re-read: in the pre-fix screenshot
// the image is UPRIGHT (ceiling at the top) and SHORT. Upright proves the
// producer pre-rotated; short proves the box did not know.
//
// So [contentSize] below is the one place that turns SENSOR_ORIENTATION into an
// aspect, and [previewRotationCwDeg] still refuses it. Two quantities, one
// premise, and the file no longer confuses them.
//
// ⚠ WHAT IS AND IS NOT VERIFIED. ROTATION_0 is measured on hardware, twice
// over. The display term is NOT: the A35 refused every attempt to force a
// landscape display (accelerometer_rotation 0 + user_rotation 1 + `cmd
// window user-rotation lock 1` all left mRotation=ROTATION_0), and no one
// was present to turn the phone. It follows AOSP rather than a measurement,
// and PanoPlusPreviewView carries a `panoplus_rot` override so the fact can
// be settled in ten seconds by whoever next holds the phone sideways.

package io.imagestitcher.rn.panoplus

internal object PanoPlusPreviewTransform {

    /**
     * Degrees the SURFACETEXTURE BUFFER must be turned CLOCKWISE to appear
     * upright to an operator looking at a display rotated by
     * `displayRotationDeg`.
     *
     * THERE IS NO SENSOR TERM, AND THAT IS THE FIX — see the file header for
     * the measurement that removed it. The camera has already applied
     * SENSOR_ORIENTATION to buffers bound for a GPU consumer, so the buffer
     * arrives upright for the display's NATURAL orientation. All that is left
     * is to undo however far the display has since been turned:
     *
     *     rot = (360 - display) % 360
     *
     * which is 0, 270, 180, 90 for ROTATION_0/90/180/270 — exactly AOSP
     * Camera2Basic's `90 * (rotation - 2)`, and 0 at ROTATION_0 as measured.
     *
     * There is no `frontFacing` parameter any more either. It selected the
     * sign of the sensor term, and with that term gone it has nothing to
     * select: a pre-oriented buffer is pre-oriented whichever way the lens
     * points. (The arm only ever opens LENS_FACING_BACK regardless.)
     *
     * @param displayRotationDeg 0/90/180/270 — see [displayRotationDegrees].
     */
    fun previewRotationCwDeg(displayRotationDeg: Int): Int {
        val display = quantiseToQuarterTurn(displayRotationDeg)
        return (360 - display) % 360
    }

    /**
     * `Surface.ROTATION_0..3` → degrees.
     *
     * A plain `* 90` on the constant, written out so the one place that knows
     * the constants are 0,1,2,3 is here and not in a view. Anything outside
     * that range is 0 — an unreadable display rotation must degrade to "the
     * natural orientation", never to a quarter turn nobody asked for.
     */
    fun displayRotationDegrees(surfaceRotationConstant: Int): Int =
        when (surfaceRotationConstant) {
            1 -> 90
            2 -> 180
            3 -> 270
            else -> 0
        }

    /**
     * The size of the PICTURE inside the buffer, as `intArrayOf(width,
     * height)` — which is NOT the buffer's own width and height whenever the
     * camera pre-rotates.
     *
     * ⚠ THE ONE PLACE SENSOR_ORIENTATION IS ALLOWED IN THIS FILE, and the fix
     * for the operator's 2026-09-03 report that the viewfinder had gone from
     * elongated to squashed. Camera2 delivers a buffer of exactly the size the
     * session was configured with (1440x1080 here) but, for a GPU/display
     * consumer, applies SENSOR_ORIENTATION to its CONTENT first. A 90-degree
     * mounting therefore hands over a 1440x1080 buffer holding a 1080x1440
     * picture, and a fit box chosen from 1440x1080 squashes it by
     * (4/3)/(3/4) = 1.778 in one axis — measured, see the file header.
     *
     * It does NOT enter [previewRotationCwDeg], and that is not an
     * inconsistency: the pre-rotation is exactly why there is nothing left for
     * the ROTATION to undo, and exactly why the ASPECT is transposed. One
     * premise, two consequences.
     */
    fun contentSize(bufW: Int, bufH: Int, sensorOrientationDeg: Int): IntArray? {
        if (bufW <= 0 || bufH <= 0) return null
        val transposed = quantiseToQuarterTurn(sensorOrientationDeg) % 180 != 0
        return if (transposed) intArrayOf(bufH, bufW) else intArrayOf(bufW, bufH)
    }

    /**
     * The size the rotated buffer occupies once it has been scaled to FIT
     * inside the view, as `intArrayOf(width, height)`. Null when any input is
     * non-positive.
     *
     * ⚠ FIT (letterbox), NOT centre-crop, AND THAT IS A DELIBERATE CHOICE.
     * The engine ingests the WHOLE frame — every pixel of the 1440x1080 the
     * ImageReader hands it — so a viewfinder that cropped would let the sweep
     * paint content the operator was never shown. That is the operator's own
     * 2026-09-01 report ("I see more than where I stopped the pan in the
     * output") arriving from the other direction. The black bars are the
     * honest part: they say THIS IS THE WHOLE FRAME.
     */
    fun fittedContentSize(
        viewW: Int, viewH: Int, bufW: Int, bufH: Int, rotCwDeg: Int,
        sensorOrientationDeg: Int,
    ): IntArray? {
        if (viewW <= 0 || viewH <= 0 || bufW <= 0 || bufH <= 0) return null
        val c = contentSize(bufW, bufH, sensorOrientationDeg) ?: return null
        val rot = quantiseToQuarterTurn(rotCwDeg)
        // The picture's own dimensions ([contentSize]), then the quarter turn
        // this transform will add. Reading the box off bufW/bufH instead is the
        // 1.778x squash the file header measures.
        val dstW = if (rot % 180 == 0) c[0] else c[1]
        val dstH = if (rot % 180 == 0) c[1] else c[0]
        val s = minOf(viewW.toDouble() / dstW, viewH.toDouble() / dstH)
        return intArrayOf(Math.round(dstW * s).toInt(), Math.round(dstH * s).toInt())
    }

    /**
     * The nine floats of the `android.graphics.Matrix` to hand
     * `TextureView.setTransform`, in Android's own order
     * (`MSCALE_X, MSKEW_X, MTRANS_X, MSKEW_Y, MSCALE_Y, MTRANS_Y, 0, 0, 1`).
     *
     * ⚠ THIS MATRIX IS COMPOSED ON TOP OF A STRETCH THAT HAS ALREADY
     * HAPPENED. A TextureView draws its SurfaceTexture into the view rect
     * FIRST — an anisotropic `scale(viewW/bufW, viewH/bufH)`, which is the
     * elongation being fixed — and only then applies this transform, in VIEW
     * coordinates. So the matrix has to undo that stretch as part of its own
     * work; a matrix that merely rotated would rotate an already-stretched
     * image. Every Camera2 sample that "just rotates" is wrong for exactly
     * this reason, and it is the reason this is derived rather than copied.
     *
     * Derivation (y-down screen coordinates, which is why a POSITIVE angle is
     * clockwise on screen — `Matrix.setRotate` uses x' = cos·x − sin·y,
     * y' = sin·x + cos·y, and (1,0) → (0,1) is right → down):
     *
     *     S       = scale(viewW/bufW, viewH/bufH)     the stretch TextureView did
     *     wanted  = translate(view centre) · scale(s) · R(rot) · translate(−buffer centre)
     *     this    = wanted ∘ S⁻¹
     *
     * with `s` the FIT scale from [fittedContentSize].
     *
     * @return null when any dimension is non-positive — the caller must then
     *   leave the identity transform in place rather than guess. That is the
     *   real pre-claim state: the buffer size is unknown until the recorder
     *   calls `PanoPlusPreview.claim`, and a guessed buffer size would put a
     *   WRONG framing on screen, which is worse than a stretched one because
     *   it looks correct.
     */
    fun matrixValues(
        viewW: Int, viewH: Int, bufW: Int, bufH: Int, rotCwDeg: Int,
        sensorOrientationDeg: Int,
    ): FloatArray? {
        if (viewW <= 0 || viewH <= 0 || bufW <= 0 || bufH <= 0) return null
        // ⚠ EVERYTHING BELOW IS IN *CONTENT* COORDINATES, NOT BUFFER ONES.
        // TextureView draws the pre-rotated picture stretched to fill the view
        // rect, so the stretch this matrix has to undo is
        // scale(viewW/cW, viewH/cH) — with the buffer's own dimensions it
        // undoes the wrong stretch and the result is the 1.778x squash.
        val c = contentSize(bufW, bufH, sensorOrientationDeg) ?: return null
        val cW = c[0]
        val cH = c[1]
        val rot = quantiseToQuarterTurn(rotCwDeg)
        val dstW = if (rot % 180 == 0) cW else cH
        val dstH = if (rot % 180 == 0) cH else cW
        val s = minOf(viewW.toDouble() / dstW, viewH.toDouble() / dstH)

        // Exact for quarter turns — no trig, so 90° carries no 6e-17 skew term
        // into a matrix that is compared in tests and read by a human.
        val cos = when (rot) { 0 -> 1.0; 180 -> -1.0; else -> 0.0 }
        val sin = when (rot) { 90 -> 1.0; 270 -> -1.0; else -> 0.0 }

        // S⁻¹ = scale(bufW/viewW, bufH/viewH); folded straight into the linear
        // part rather than composed, because two matrix products in float
        // would round where this does not.
        val invSx = cW.toDouble() / viewW
        val invSy = cH.toDouble() / viewH

        val a = s * cos * invSx
        val b = -s * sin * invSy
        val d = s * sin * invSx
        val e = s * cos * invSy

        // translate(view centre) − s·R·(buffer centre)
        val bcx = cW / 2.0
        val bcy = cH / 2.0
        val rx = cos * bcx - sin * bcy
        val ry = sin * bcx + cos * bcy
        val tx = viewW / 2.0 - s * rx
        val ty = viewH / 2.0 - s * ry

        return floatArrayOf(
            a.toFloat(), b.toFloat(), tx.toFloat(),
            d.toFloat(), e.toFloat(), ty.toFloat(),
            0f, 0f, 1f,
        )
    }

    /**
     * Map a CONTENT point — a pixel of the PICTURE the camera pre-rotated into
     * the buffer, so `(0,0)..(contentW,contentH)` from [contentSize], NOT
     * `(0,0)..(bufW,bufH)` — through the full chain (the stretch TextureView
     * applies plus [matrixValues]) into view pixels.
     *
     * Exists for the tests and for nothing else: a matrix can be asserted
     * value-by-value and still be geometrically wrong, so the suite asserts
     * where the buffer's four CORNERS land, which is the thing the operator
     * actually sees.
     */
    fun mapContentPoint(
        m: FloatArray, viewW: Int, viewH: Int, contentW: Int, contentH: Int,
        x: Double, y: Double,
    ): DoubleArray {
        val sx = viewW.toDouble() / contentW
        val sy = viewH.toDouble() / contentH
        val vx = x * sx
        val vy = y * sy
        return doubleArrayOf(
            m[0] * vx + m[1] * vy + m[2],
            m[3] * vx + m[4] * vy + m[5],
        )
    }

    /**
     * Nearest quarter turn in [0,360).
     *
     * `SENSOR_ORIENTATION` is a multiple of 90 by the Camera2 contract and
     * `Surface.ROTATION_*` is one of four constants, so this never fires in
     * the field — but a HAL that published 89 would otherwise put a
     * near-quarter-turn SKEW into the preview, which reads as a broken
     * viewfinder rather than as a broken characteristic.
     */
    private fun quantiseToQuarterTurn(deg: Int): Int {
        val norm = ((deg % 360) + 360) % 360
        return (Math.round(norm / 90.0).toInt() * 90) % 360
    }
}
