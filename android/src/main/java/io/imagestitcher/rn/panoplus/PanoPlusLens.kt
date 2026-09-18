// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusLens.kt — WHICH BACK CAMERA IS "1×" AND WHICH IS "0.5×", decided by
// facing and field of view and never by a camera id.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────
//
// The owner, 2026-09-03: pano+ must carry Pano's own lens switcher, and "in
// non-AR mode I am able to switch between 1x and 0.5x also". Until this file
// the Android sweep and the idle viewfinder had ONE rule — the widest-FOV back
// camera — and the SDK's `lens` key was read by nobody: `PanoPlusLiveModule.
// start` never copied it into the recorder's bag and `setIdlePreview` read it
// and DELIBERATELY ignored it (its comment argued, correctly at the time, that
// honouring it at idle would show a framing the sweep then did not record).
// Both halves now honour it, through this one rule, so the viewfinder and the
// pack can only ever agree.
//
// ── THE RULE, AND WHERE ITS NUMBERS COME FROM ───────────────────────────
//
// Pano's chip on Android is fed by vision-camera, which classifies a camera by
// horizontal field of view (`CameraDeviceDetails.kt:241`):
//
//     fov > 94        → ultra-wide-angle-camera   (the chip's 0.5×)
//     60 ≤ fov ≤ 94   → wide-angle-camera         (the chip's 1×)
//     fov < 60        → telephoto-camera
//
// The same bands are used here so that "0.5×" means the SAME lens on the pano+
// segment as on the Pano segment of the same screen. On SM-A356U1 that is
// camera 2 (f=1.64 mm, 96.2°) for 0.5× and camera 0 (f=4.69 mm, 69.7°) for 1× —
// read from the device, never assumed: a phone that lists its lenses in another
// order, or has no ultra-wide at all, is answered by the same arithmetic.
//
// ⚠ ABSENT IS NOT "ULTRA-WIDE". A bag with no `lens` key — every caller that
// predates this file: the debug panel's `startRecording`, the basis runs, the
// ARCore reference sessions — keeps the rule that shipped (widest-FOV back
// camera, `PanoPlusAndroidRecorder.start`) and opens the same camera it always
// did. The lens rule runs only when a lens was asked for, and the pack says
// which of the two rules ran (`selection.lensNote`).
//
// PURE. Nothing here touches `android.*`, so the JVM suite holds the A35 table
// verbatim and the two devices this programme has not met yet (no ultra-wide;
// no wide-band camera at all).

package io.imagestitcher.rn.panoplus

/** The two lenses the chip can name. The SDK spells them `'ultraWide'` and
 *  `'wide'` (`PanoPlusCaptureSurfaceProps.lens`); iOS's AVF arm reads the same
 *  two strings (`RNISPanoAvfSource.swift:367`). */
internal enum class PanoPlusLens(val wire: String, val label: String) {
    ULTRA_WIDE("ultraWide", "0.5x"),
    WIDE("wide", "1x");

    companion object {
        /**
         * `'ultraWide'` | `'wide'` (case-insensitive; the chip's own `0.5x` /
         * `1x` are accepted too) → the lens, or null for absent/unrecognised.
         *
         * Null and not a default, on purpose: the caller decides what "no
         * lens" means (the recorder keeps its shipped widest-FOV rule), and a
         * misspelt value must read as "nothing was asked" rather than silently
         * becoming one of the two — see the header.
         */
        fun parse(raw: String?): PanoPlusLens? = when (raw?.trim()?.lowercase()) {
            "ultrawide", "ultra-wide", "0.5x", "0.5" -> ULTRA_WIDE
            "wide", "1x", "1" -> WIDE
            else -> null
        }
    }
}

/**
 * vision-camera's ultra-wide threshold, degrees of HORIZONTAL field of view
 * (`react-native-vision-camera/…/CameraDeviceDetails.kt:241`). Strictly
 * greater is ultra-wide.
 */
internal const val PANO_LENS_ULTRA_WIDE_MIN_HFOV_DEG = 94.0

/** vision-camera's wide band, inclusive at both ends (same file, line 242). */
internal const val PANO_LENS_WIDE_MIN_HFOV_DEG = 60.0
internal const val PANO_LENS_WIDE_MAX_HFOV_DEG = 94.0

/**
 * One camera, as much of it as the lens rule needs. Built from a `CamInfo`
 * (recorder / idle preview) or by hand (the tests).
 *
 * @param order position in `CameraManager.getCameraIdList()`. The tiebreak
 *   between two wide-band back cameras (a main and a macro, say) is the
 *   platform's DEFAULT rear camera, which Android defines as the first
 *   back-facing id in that list — the camera ARCore opens and the one
 *   vision-camera calls `wide-angle-camera` by default.
 */
internal class PanoPlusLensCandidate(
    val id: String,
    val back: Boolean,
    val hFovDeg: Double,
    val hasYuv: Boolean,
    val order: Int,
)

/** vision-camera's band for one field of view, by name. */
internal fun panoLensBand(hFovDeg: Double): String = when {
    !hFovDeg.isFinite() -> "unknown"
    hFovDeg > PANO_LENS_ULTRA_WIDE_MIN_HFOV_DEG -> "ultra-wide"
    hFovDeg >= PANO_LENS_WIDE_MIN_HFOV_DEG -> "wide"
    else -> "telephoto"
}

/**
 * Which of the two lenses a camera IS, for the pack's `lensRan`. An ultra-wide
 * band answers 0.5×; everything else — wide, telephoto, unknown — answers 1×,
 * because the chip has exactly two positions and a camera that is not the
 * ultra-wide is the other one.
 */
internal fun panoLensOf(hFovDeg: Double): PanoPlusLens =
    if (hFovDeg.isFinite() && hFovDeg > PANO_LENS_ULTRA_WIDE_MIN_HFOV_DEG) {
        PanoPlusLens.ULTRA_WIDE
    } else {
        PanoPlusLens.WIDE
    }

/**
 * The answer, with the sentence the viewfinder and the pack print beside it.
 *
 * @param honoured false when [ran] is not [requested] — the device has no lens
 *   in the requested band, and the one that ran is named in [why]. Never a
 *   silent substitution: the SDK deletes `lens` from the bag on the AR arm for
 *   exactly this reason, and the IMU arm gets the same honesty here.
 */
internal class PanoPlusLensPick(
    val id: String,
    val requested: PanoPlusLens,
    val ran: PanoPlusLens,
    val honoured: Boolean,
    val why: String,
)

/**
 * Pick the camera for a requested lens.
 *
 * Pool: back-facing cameras with a YUV stream, else every camera with one
 * (a device with no back camera at all still gets a viewfinder). Empty → null.
 *
 *   1×    the first pool camera IN LIST ORDER whose hFOV is in the wide band;
 *         if none is, the first pool camera in list order (the platform's
 *         default rear camera), and [PanoPlusLensPick.why] says the band rule
 *         could not run.
 *   0.5×  the WIDEST pool camera above the ultra-wide threshold that is not
 *         the 1× pick; if there is none, the 1× pick runs with
 *         `honoured = false` — the device has no 0.5×.
 *
 * Pure; the caller maps `CamInfo` in and reads the id out.
 */
internal fun pickCameraForLens(
    cameras: List<PanoPlusLensCandidate>,
    requested: PanoPlusLens,
): PanoPlusLensPick? {
    val withYuv = cameras.filter { it.hasYuv }.sortedBy { it.order }
    val backs = withYuv.filter { it.back }
    val pool = backs.ifEmpty { withYuv }
    if (pool.isEmpty()) return null
    val poolNote = if (backs.isEmpty()) " (no LENS_FACING_BACK camera — chosen across all facings)" else ""

    val wideBand = pool.firstOrNull {
        it.hFovDeg.isFinite() &&
            it.hFovDeg >= PANO_LENS_WIDE_MIN_HFOV_DEG &&
            it.hFovDeg <= PANO_LENS_WIDE_MAX_HFOV_DEG
    }
    val wide = wideBand ?: pool.first()
    val wideWhy = if (wideBand != null) {
        "camera ${wide.id} is the 1x wide lens (${fmtDeg(wide.hFovDeg)} hFOV, in the " +
            "${PANO_LENS_WIDE_MIN_HFOV_DEG.toInt()}-${PANO_LENS_WIDE_MAX_HFOV_DEG.toInt()}° " +
            "wide band, first in the camera list)$poolNote"
    } else {
        "camera ${wide.id} is this device's default rear camera, taken as the 1x lens " +
            "because no back camera reports an hFOV in the wide band " +
            "(${pool.joinToString { "${it.id}=${fmtDeg(it.hFovDeg)}" }})$poolNote"
    }

    if (requested == PanoPlusLens.WIDE) {
        return PanoPlusLensPick(wide.id, requested, PanoPlusLens.WIDE, true, wideWhy)
    }

    val ultra = pool
        .filter {
            it.id != wide.id && it.hFovDeg.isFinite() &&
                it.hFovDeg > PANO_LENS_ULTRA_WIDE_MIN_HFOV_DEG
        }
        .maxByOrNull { it.hFovDeg }
    if (ultra != null) {
        return PanoPlusLensPick(
            ultra.id, requested, PanoPlusLens.ULTRA_WIDE, true,
            "camera ${ultra.id} is the 0.5x ultra-wide lens (${fmtDeg(ultra.hFovDeg)} hFOV, " +
                "above the ${PANO_LENS_ULTRA_WIDE_MIN_HFOV_DEG.toInt()}° ultra-wide threshold; " +
                "the 1x is camera ${wide.id} at ${fmtDeg(wide.hFovDeg)})$poolNote",
        )
    }
    return PanoPlusLensPick(
        wide.id, requested, PanoPlusLens.WIDE, false,
        "0.5x was requested but this device has NO ultra-wide back lens (nothing above " +
            "${PANO_LENS_ULTRA_WIDE_MIN_HFOV_DEG.toInt()}° hFOV: " +
            "${pool.joinToString { "${it.id}=${fmtDeg(it.hFovDeg)}" }}) — the 1x wide, " +
            "camera ${wide.id}, ran instead$poolNote",
    )
}

private fun fmtDeg(v: Double): String =
    if (v.isFinite()) String.format(java.util.Locale.US, "%.1f°", v) else "unknown hFOV"
