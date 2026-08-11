// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.opengl.Matrix
import android.util.Log
import android.view.View

/**
 * 0.20.0 — transparent overlay [View] drawn ABOVE the [RNSARCameraView]'s
 * GLSurfaceView.  Each AR frame, [RNSARCameraView.onDrawFrame] snapshots the
 * current camera **view** + **projection** matrices and the GL letterbox box,
 * pushes them in via [updateCamera], then requests a redraw; [onDraw]
 * reprojects every overlay's world point(s) → screen and strokes the
 * outline / box + label with a [Canvas].
 *
 * This is the Android side of the shared 0.20.0 contract — the iOS twin uses
 * `ARFrame.camera.projectPoint(...)` on a `CAShapeLayer`.  Here we do the
 * projection ourselves from the ARCore matrices:
 *
 *   clip = projection · view · [x y z 1]ᵀ
 *   ndc  = clip.xyz / clip.w          (w ≤ 0 ⇒ behind camera ⇒ hidden)
 *   px   = box.x + (ndc.x*0.5 + 0.5) * box.w
 *   py   = box.y + (0.5 - ndc.y*0.5) * box.h   (GL y-up → screen y-down)
 *
 * The view/projection matrices come from `frame.camera.getViewMatrix(...)`
 * and `getProjectionMatrix(...)`, which already bake in the current display
 * rotation (the session's `setDisplayGeometry`), so the projected pixels land
 * in the SAME letterbox box the camera feed renders into — overlays track the
 * scene at display rate.
 *
 * ## 3D scaffold (mode:'3d')
 *
 * v1 renders ONLY '2d'.  An overlay with `mode:'3d'` is treated as '2d' with
 * a one-time [Log] warning (see [warn3dOnce]).  The clearly-marked
 * [render3dScaffold] hook is where a future Android 3D renderer (SceneView /
 * Filament) will plug in — it is intentionally empty this release.
 *
 * ## Threading
 *
 * [updateCamera] is called on the GL render thread; [onDraw] runs on the UI
 * (main) thread.  The matrices + box are published through `@Volatile`
 * fields, and the overlay set is read from the shared [AROverlayStore]
 * (its own AtomicReferences) — so no locks are needed.  We snapshot the
 * matrices into local copies in [onDraw] so a concurrent [updateCamera]
 * mid-draw can't tear a single matrix.
 */
internal class AROverlayRenderer(
    context: Context,
    /// Shared overlay source — the UNION of JS + plugin overlays.
    private val store: AROverlayStore,
) : View(context) {

    // ── Camera state published per AR frame (GL thread → UI thread) ──────
    //
    // Two full 4x4 column-major matrices (OpenGL layout, as ARCore returns
    // them) + the letterbox box [x,y,w,h] in this view's pixel space.  Held
    // behind a single @Volatile reference object so onDraw reads a coherent
    // snapshot (no half-updated matrix).

    private class CameraState(
        val view: FloatArray,        // 16, column-major
        val projection: FloatArray,  // 16, column-major
        val boxX: Float,
        val boxY: Float,
        val boxW: Float,
        val boxH: Float,
        val tracking: Boolean,
    )

    @Volatile
    private var camera: CameraState? = null

    // v0.20.0 — per-overlay anchor positions (overlay id → live world [x,y,z]),
    // published from the GL thread each frame after the view reconciles ARCore
    // anchors.  When present for an overlay, onDraw uses this DRIFT-CORRECTED
    // position instead of the overlay's frozen worldPosition / worldQuad — so
    // ARCore can keep the marker on the real spot across re-localization.
    @Volatile
    private var anchorPositions: Map<String, FloatArray> = emptyMap()

    /// Publish drift-corrected anchor positions for the current frame (called
    /// on the GL thread before [updateCamera]).  Empty = no anchored overlays.
    fun setAnchorPositions(positions: Map<String, FloatArray>) {
        anchorPositions = positions
    }

    // Reusable paints (allocate once — onDraw runs at display rate).
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = STROKE_WIDTH_PX
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        textSize = LABEL_TEXT_SIZE_PX
        textAlign = Paint.Align.CENTER
    }
    private val labelBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = LABEL_BG_ARGB
    }

    // Scratch buffers reused across onDraw (avoid per-frame allocations).
    private val viewProj = FloatArray(16)
    private val clip = FloatArray(4)
    private val homog = FloatArray(4)
    private val path = Path()
    private val labelBounds = android.graphics.Rect()

    init {
        // Fully transparent — only the camera feed shows through where we
        // don't draw.  Don't intercept touches: the overlay is display-only,
        // gestures pass through to whatever the host stacks below/above.
        setBackgroundColor(Color.TRANSPARENT)
        // Hardware layer: Canvas stroking of a few shapes is cheap; keep the
        // default (HW-accelerated) rendering — no setLayerType needed.
    }

    override fun onTouchEvent(event: android.view.MotionEvent?): Boolean = false

    /**
     * Publish this AR frame's camera matrices + letterbox box, then request
     * a redraw.  Called from the GL render thread once per frame (cheap when
     * no overlays exist — caller can skip via [AROverlayStore.isEmpty]).
     *
     * @param viewMatrix       column-major 4x4 from `camera.getViewMatrix`.
     * @param projectionMatrix column-major 4x4 from `camera.getProjectionMatrix`.
     * @param boxX,boxY,boxW,boxH letterbox box (pixels) the camera feed fills.
     * @param tracking         true when ARCore tracking == TRACKING (overlays
     *                         are hidden while not tracking — their world
     *                         positions aren't yet meaningful).
     */
    fun updateCamera(
        viewMatrix: FloatArray,
        projectionMatrix: FloatArray,
        boxX: Float,
        boxY: Float,
        boxW: Float,
        boxH: Float,
        tracking: Boolean,
    ) {
        camera = CameraState(
            view = viewMatrix.copyOf(16),
            projection = projectionMatrix.copyOf(16),
            boxX = boxX, boxY = boxY, boxW = boxW, boxH = boxH,
            tracking = tracking,
        )
        // Request a redraw on the UI thread (postInvalidate is thread-safe).
        postInvalidateOnAnimation()
    }

    /// Clear all drawing (e.g. when the session stops / view detaches).
    fun clear() {
        camera = null
        postInvalidateOnAnimation()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cam = camera ?: return
        if (!cam.tracking) return            // hide overlays until tracking
        val overlays = store.snapshot()
        if (overlays.isEmpty()) return

        // viewProj = projection · view (column-major multiply).
        Matrix.multiplyMM(viewProj, 0, cam.projection, 0, cam.view, 0)

        for (overlay in overlays) {
            try {
                drawOverlay(canvas, overlay, cam)
            } catch (t: Throwable) {
                // One bad overlay must never crash the whole draw pass.
                Log.w(TAG, "drawOverlay('${overlay.id}') failed: ${t.message}")
            }
        }
    }

    private fun drawOverlay(canvas: Canvas, overlay: AROverlayData, cam: CameraState) {
        // 3D scaffold: v1 renders '3d' as '2d' with a one-time warning.
        if (overlay.mode == "3d") {
            warn3dOnce()
            render3dScaffold(overlay)
            // fall through — draw it as a 2D overlay this release.
        }

        // Build the world corners to project:
        //   - worldQuad: the explicit 3-4 corners.
        //   - worldPosition + sizeMeters: 4 corners of a billboard quad
        //     facing the camera (so the box always presents flat to the
        //     viewer regardless of camera angle).
        // v0.20.0 — prefer the drift-corrected ARCore anchor position when the
        // view has published one for this overlay; else the frozen geometry.
        val anchorPos = anchorPositions[overlay.id]
        val worldCorners: Array<FloatArray> = when {
            overlay.worldQuad != null -> {
                val q = overlay.worldQuad
                if (anchorPos != null) {
                    // Translate the quad so its centroid sits at the anchor.
                    var cx = 0f; var cy = 0f; var cz = 0f
                    for (v in q) { cx += v[0]; cy += v[1]; cz += v[2] }
                    val n = q.size.toFloat()
                    val dx = anchorPos[0] - cx / n
                    val dy = anchorPos[1] - cy / n
                    val dz = anchorPos[2] - cz / n
                    Array(q.size) { i ->
                        floatArrayOf(q[i][0] + dx, q[i][1] + dy, q[i][2] + dz)
                    }
                } else {
                    q
                }
            }
            overlay.worldPosition != null ->
                billboardCorners(anchorPos ?: overlay.worldPosition, overlay.sizeMeters, cam)
            else -> return
        }

        // Project each corner to screen pixels; bail if ANY corner is behind
        // the camera (w<=0) — a partially-behind quad would draw a garbage
        // wrap-around polygon.
        val screen = FloatArray(worldCorners.size * 2)
        for (i in worldCorners.indices) {
            val p = projectToScreen(worldCorners[i], cam) ?: return
            screen[i * 2] = p[0]
            screen[i * 2 + 1] = p[1]
        }

        // Off-screen cull: if the whole polygon is outside the view bounds,
        // skip (cheap, and avoids drawing labels for unseen overlays).
        if (isFullyOffscreen(screen)) return

        // Build the closed polygon path.
        path.reset()
        path.moveTo(screen[0], screen[1])
        for (i in 1 until worldCorners.size) {
            path.lineTo(screen[i * 2], screen[i * 2 + 1])
        }
        path.close()

        if (overlay.shape == "box") {
            // Translucent fill (overlay colour @ the overlay's fillAlpha,
            // default ~22%) + stroke.  The colour's own alpha is masked out
            // on purpose — fillAlpha is the single source of fill opacity,
            // matching iOS's `color.withAlphaComponent(fillAlpha)`.
            fillPaint.color = (overlay.colorArgb and 0x00FFFFFF) or
                (alphaByte(overlay.fillAlpha, AROverlayData.DEFAULT_FILL_ALPHA) shl 24)
            canvas.drawPath(path, fillPaint)
        }
        // strokeAlpha == 0 ⇒ FILL-ONLY: skip the outline entirely so a tiled
        // set of adjacent quads reads as ONE continuous region (no internal
        // seams).
        //
        // Unlike the fill (which ALWAYS replaces the colour's alpha, exactly
        // as the hardcoded BOX_FILL_ALPHA did), the stroke only overrides the
        // colour's own alpha when strokeAlpha is BELOW 1.  At the default the
        // colour passes through untouched, so a caller that encoded stroke
        // opacity in an #AARRGGBB colour — the only way to do it before this
        // field existed — stays pixel-identical.  iOS applies the same three
        // cases (skip / colour as-is / withAlphaComponent).
        if (overlay.strokeAlpha > 0f) {
            strokePaint.color = if (overlay.strokeAlpha >= 1f) {
                overlay.colorArgb
            } else {
                (overlay.colorArgb and 0x00FFFFFF) or
                    (alphaByte(overlay.strokeAlpha, AROverlayData.DEFAULT_STROKE_ALPHA) shl 24)
            }
            canvas.drawPath(path, strokePaint)
        }

        // A badge image REPLACES the centroid label: a chip over the MIDDLE
        // of the box would cover exactly what the box marks.  Falls back to
        // the label when the image is missing, so the overlay still
        // annotates.
        val badge = overlay.imageUri?.let { badgeBitmap(it) }
        if (badge != null) {
            drawBadge(canvas, badge, screen)
        } else {
            overlay.label?.let { drawLabel(canvas, it, screen, overlay.colorArgb) }
        }
    }

    /**
     * Decoded badge-image cache.  A tracked overlay re-sends the SAME
     * `imageUri` on EVERY frame, so decoding per frame would burn CPU and
     * heat the device for no pixel change.  [badgeMisses] additionally
     * remembers paths that failed to decode, so a stale path is not retried
     * on every single frame either.
     */
    private val badgeCache =
        object : android.util.LruCache<String, android.graphics.Bitmap>(32) {
            override fun sizeOf(key: String, value: android.graphics.Bitmap): Int = 1
        }
    private val badgeMisses = HashSet<String>()
    private val badgeDst = android.graphics.RectF()
    private val badgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        isFilterBitmap = true
    }

    /// Decode (and cache) an overlay's badge image; null when missing /
    /// undecodable — the box then draws WITHOUT one rather than the overlay
    /// failing.
    private fun badgeBitmap(uri: String): android.graphics.Bitmap? {
        badgeCache.get(uri)?.let { return it }
        if (badgeMisses.contains(uri)) return null
        val path = if (uri.startsWith("file://")) uri.removePrefix("file://") else uri
        val bmp = try {
            android.graphics.BitmapFactory.decodeFile(path)
        } catch (t: Throwable) {
            null
        }
        if (bmp == null) {
            badgeMisses.add(uri)
            return null
        }
        badgeCache.put(uri, bmp)
        return bmp
    }

    /// Draw the badge image INSIDE the projected polygon at its BOTTOM-LEFT,
    /// inset and aspect-preserving.  Screen y grows DOWN, so "bottom" is maxY.
    private fun drawBadge(
        canvas: Canvas,
        bmp: android.graphics.Bitmap,
        screen: FloatArray,
    ) {
        var minX = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxY = -Float.MAX_VALUE
        var i = 0
        while (i + 1 < screen.size) {
            val x = screen[i]
            val y = screen[i + 1]
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            i += 2
        }
        val bw = maxX - minX
        val bh = maxY - minY
        // Skip only a DEGENERATE box; a small box still gets a small badge.
        if (bw < 20f || bh < 20f) return
        // Proportional badge (iOS parity): ~26% of the shorter side,
        // bottom-left, clamped so a huge box's badge never dwarfs the feed.
        val extent = (minOf(bw, bh) * 0.26f).coerceIn(10f, 110f)
        val ar = if (bmp.height > 0) bmp.width.toFloat() / bmp.height.toFloat() else 1f
        val w = if (ar >= 1f) extent else extent * ar
        val h = if (ar >= 1f) extent / ar else extent
        val pad = extent * 0.15f
        val left = minX + pad
        val top = maxY - h - pad
        badgeDst.set(left, top, left + w, top + h)
        canvas.drawBitmap(bmp, null, badgeDst, badgePaint)
    }

    /**
     * An overlay's alpha (0..1) → the 0..255 alpha byte a paint needs.
     * [AROverlayData.sanitizeAlpha] runs FIRST against [fallback] and is not
     * optional: a NaN would round to 0 (an invisible fill / erased outline —
     * the exact bugs these fields exist to control) and an out-of-range value
     * would overflow the byte and wrap.  `coerceIn` is then belt-and-braces
     * on the rounded int.
     *
     * Re-sanitising here (rather than trusting the parse) covers the
     * native-plugin path, which can construct an [AROverlayData] directly and
     * bypass [AROverlayData.fromReadableMap].
     *
     * The fill default (0.22f) rounds to 56 == 0x38 — bit-for-bit the alpha
     * this renderer hardcoded before `fillAlpha` existed, so overlays that
     * omit the key (every pre-existing caller) produce an identical pixel.
     */
    private fun alphaByte(raw: Float, fallback: Float): Int =
        Math.round(AROverlayData.sanitizeAlpha(raw, fallback) * 255f).coerceIn(0, 255)

    /**
     * Project a world point [x,y,z] through viewProj → screen pixels inside
     * the letterbox box.  Returns null when the point is behind the camera
     * (clip.w ≤ 0).
     */
    private fun projectToScreen(world: FloatArray, cam: CameraState): FloatArray? {
        homog[0] = world[0]; homog[1] = world[1]; homog[2] = world[2]; homog[3] = 1f
        Matrix.multiplyMV(clip, 0, viewProj, 0, homog, 0)
        val w = clip[3]
        if (w <= 1e-6f) return null          // behind / on the camera plane
        val ndcX = clip[0] / w
        val ndcY = clip[1] / w
        // NDC [-1,1] → box pixels.  GL is y-up; screen is y-down → flip Y.
        val px = cam.boxX + (ndcX * 0.5f + 0.5f) * cam.boxW
        val py = cam.boxY + (0.5f - ndcY * 0.5f) * cam.boxH
        return floatArrayOf(px, py)
    }

    /**
     * Build 4 world corners of a camera-facing billboard quad centred at
     * [center] with extent [size] (metres).  The quad's right axis is the
     * camera's right (row 0 of the view matrix) and its up axis is the
     * camera's up (row 1) — so the box always faces the viewer.
     *
     * The view matrix is world→camera; its rows (in column-major storage:
     * elements 0,4,8 = right; 1,5,9 = up) give the camera basis in world
     * space.
     */
    private fun billboardCorners(
        center: FloatArray,
        size: FloatArray,
        cam: CameraState,
    ): Array<FloatArray> {
        val v = cam.view
        // Camera right (world space) = first ROW of the view matrix.
        val rx = v[0]; val ry = v[4]; val rz = v[8]
        // Camera up (world space) = second ROW of the view matrix.
        val ux = v[1]; val uy = v[5]; val uz = v[9]
        val hw = size[0] * 0.5f
        val hh = size[1] * 0.5f
        // Corner order: TL, TR, BR, BL (CW) so the stroked outline is a quad.
        fun corner(sx: Float, sy: Float) = floatArrayOf(
            center[0] + rx * sx * hw + ux * sy * hh,
            center[1] + ry * sx * hw + uy * sy * hh,
            center[2] + rz * sx * hw + uz * sy * hh,
        )
        return arrayOf(
            corner(-1f, 1f),   // top-left
            corner(1f, 1f),    // top-right
            corner(1f, -1f),   // bottom-right
            corner(-1f, -1f),  // bottom-left
        )
    }

    /// Draw a label with a translucent rounded background at the polygon's
    /// screen centroid.  Colour matches the overlay's stroke colour.
    private fun drawLabel(canvas: Canvas, text: String, screen: FloatArray, colorArgb: Int) {
        if (text.isEmpty()) return
        var cx = 0f
        var cy = 0f
        val n = screen.size / 2
        for (i in 0 until n) { cx += screen[i * 2]; cy += screen[i * 2 + 1] }
        cx /= n
        cy /= n

        labelPaint.color = colorArgb
        labelPaint.getTextBounds(text, 0, text.length, labelBounds)
        val padX = LABEL_PAD_PX
        val padY = LABEL_PAD_PX * 0.6f
        val bgW = labelBounds.width() + padX * 2
        val bgH = labelBounds.height() + padY * 2
        val left = cx - bgW / 2
        val top = cy - bgH / 2
        canvas.drawRoundRect(
            left, top, left + bgW, top + bgH,
            LABEL_CORNER_PX, LABEL_CORNER_PX, labelBgPaint,
        )
        // Baseline so the text is vertically centred in the bg box.
        val baseline = cy - (labelPaint.descent() + labelPaint.ascent()) / 2
        canvas.drawText(text, cx, baseline, labelPaint)
    }

    /// True when every projected vertex lies outside this view's bounds on
    /// the SAME side (cheap conservative cull — a polygon straddling an edge
    /// still draws).
    private fun isFullyOffscreen(screen: FloatArray): Boolean {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return false
        var allLeft = true; var allRight = true; var allAbove = true; var allBelow = true
        var i = 0
        while (i < screen.size) {
            val x = screen[i]; val y = screen[i + 1]
            if (x >= 0f) allLeft = false
            if (x <= w) allRight = false
            if (y >= 0f) allAbove = false
            if (y <= h) allBelow = false
            i += 2
        }
        return allLeft || allRight || allAbove || allBelow
    }

    // ── 3D scaffold (mode:'3d') — LIGHT, intentionally empty this release ──

    @Volatile private var warned3d = false

    /// One-time log warning when an overlay requests the not-yet-implemented
    /// '3d' mode (v1 renders it as '2d').  Mirrors the contract's "one-time
    /// console/log warning".
    private fun warn3dOnce() {
        if (warned3d) return
        warned3d = true
        Log.w(
            TAG,
            "AROverlay mode:'3d' is a SCAFFOLD this release — rendering it as " +
                "'2d'.  A 3D renderer (SceneView / Filament) is planned for a " +
                "later release; see render3dScaffold().",
        )
    }

    /**
     * SCAFFOLD HOOK — where a future Android 3D overlay renderer will plug
     * in (SceneView / Filament / a GL pass into the camera surface).  v1
     * does NOTHING here on purpose: the data-model field (`mode:'3d'`) is
     * defined and the call site is wired, but no 3D engine is added this
     * release.  The overlay is still drawn as 2D by the caller.
     *
     * @param overlay the '3d'-mode overlay (currently unused).
     */
    @Suppress("UNUSED_PARAMETER")
    private fun render3dScaffold(overlay: AROverlayData) {
        // TODO(0.21+): place/update a 3D node for `overlay` here.
    }

    companion object {
        private const val TAG = "AROverlayRenderer"
        private const val STROKE_WIDTH_PX = 4f
        private const val LABEL_TEXT_SIZE_PX = 36f
        private const val LABEL_PAD_PX = 14f
        private const val LABEL_CORNER_PX = 8f
        /// Label background: ~70% black.
        private const val LABEL_BG_ARGB = 0xB3000000.toInt()
        // NOTE: the box fill alpha is no longer a constant here — it is
        // per-overlay (`AROverlayData.fillAlpha`), converted to a byte by
        // [alphaByte].  The old hardcoded 0x38 now lives as
        // `AROverlayData.DEFAULT_FILL_ALPHA` (0.22f), which rounds back to
        // exactly 0x38 for any overlay that omits the key.
    }
}
