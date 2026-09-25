// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

/**
 * The `badgePlacement` rule of the AR overlay contract (TS
 * `AROverlay.badgePlacement`, iOS `RNISAROverlay.BadgePlacement`) — pure
 * Kotlin, no React Native or Android types, so the JVM unit test exercises the
 * SAME code the parser ([AROverlayData.fromReadableMap]) and the patch path
 * ([AROverlayStore.updateJsOverlay]) run.
 *
 * `badgePlacement: 'plane'` is an iOS renderer opt-in: an `orient:'plane'`
 * quad's `imageUri` badge lies flat in the quad's plane, and the badge draws a
 * tier above its box's fill. Android PARSES the key so the overlay contract
 * is the same on both platforms (a patch carries it like its siblings, and a
 * native plugin reading [AROverlayData] sees what JS sent), and IGNORES it
 * when drawing: [AROverlayRenderer] sizes the badge from the projected screen
 * box — which foreshortens with the surface, so the badge never spilled — and
 * draws it after the fill already. That is why Android's
 * `RNSARSession.overlayFeatures()` does not list `flatPlaneBadge`
 * ([AROverlayFeatures]).
 *
 * The rule is iOS's: only the exact string `'plane'` opts in. Absent,
 * `'camera'`, any other string or any non-string ⇒ [CAMERA], the pre-field
 * badge (fallback-not-coerce, as `depthOcclusion`).
 */
object AROverlayBadgePlacement {
    /** The pre-field badge: `badgePlacement` absent (iOS `.camera`). */
    const val CAMERA = "camera"

    /** The iOS opt-in (iOS `.plane`). */
    const val PLANE = "plane"

    /** The value an overlay that never mentions the key carries. */
    const val DEFAULT = CAMERA

    /** Only the exact string [PLANE] ⇒ [PLANE]; anything else ⇒ [DEFAULT]. */
    @JvmStatic
    fun sanitize(raw: Any?): String = if (raw == PLANE) PLANE else DEFAULT
}
