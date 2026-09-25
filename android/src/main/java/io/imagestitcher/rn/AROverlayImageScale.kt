// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * The `imageScale` rule of the AR overlay contract (TS `AROverlay.imageScale`,
 * iOS `RNISAROverlay.sanitizedImageScale` / `badgeExtent`) — pure Kotlin, no
 * React Native or Android types, so the JVM unit tests exercise the SAME code
 * the parser ([AROverlayData.fromReadableMap]) and the renderer
 * ([AROverlayRenderer]) run.
 *
 * `imageScale` multiplies the in-box badge's size.  Absent ⇒ [DEFAULT] (1),
 * which is exactly the badge every pre-field build drew; the honoured range is
 * [[MIN], [MAX]]; anything else falls back to [DEFAULT] rather than being
 * clipped (the alphas' fallback-not-clip rule).
 */
object AROverlayImageScale {
    /** The pre-field badge: `imageScale` absent. */
    const val DEFAULT = 1.0f
    const val MIN = 0.25f
    /** At the top of the range the inset badge still ends inside the box:
     *  inset + extent = 1.15 × 0.26 × 2.5 = 0.75 of the shorter side. */
    const val MAX = 2.5f

    /** Non-finite or outside [[MIN], [MAX]] ⇒ [DEFAULT]. */
    @JvmStatic
    fun sanitize(raw: Float): Float =
        if (!raw.isFinite() || raw < MIN || raw > MAX) DEFAULT else raw

    /**
     * THE badge extent rule, in screen px, for a projected box whose shorter
     * side is [shortSidePx]: ~26% of it × the scale, clamped to
     * `[10 px, 110 px × scale]`.  At scale 1 this is exactly the renderer's
     * pre-field `(minOf(bw, bh) * 0.26f).coerceIn(10f, 110f)`.  The scale is
     * re-sanitised here: a native plugin can construct [AROverlayData]
     * directly and bypass the parser.
     */
    @JvmStatic
    fun badgeExtentPx(shortSidePx: Float, imageScale: Float): Float {
        val s = sanitize(imageScale)
        return (shortSidePx * 0.26f * s).coerceIn(10f, 110f * s)
    }
}
