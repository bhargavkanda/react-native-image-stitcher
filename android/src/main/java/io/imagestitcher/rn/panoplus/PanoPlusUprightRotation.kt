// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

/**
 * THE UPRIGHT BAKE, ANDROID HALF — the quarter turn that takes a pano+
 * deliverable out of the camera raster frame and into the world-upright one.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The operator's report, verbatim: *"the output image is sideways"*.
 * Reproduced on his own 2026-09-02 packs — a `hold: "portrait"` sweep comes
 * out with the shelves running DOWN the image; rotating that canvas 90° CW
 * gives a plumb, level panorama and nothing shears.
 *
 * The cause is a MISSING step, not a wrong one. This module's recorder writes
 * frames with "NO ROTATION and NO EXIF" on purpose (see
 * `PanoPlusAndroidRecorder`'s writer comment): rotating pixels at ingest while
 * the intrinsics stay unoriented is the standing repo trap, and it would break
 * every `H_rect`. What was never written is the LAST step — raster to upright —
 * which the recorder's own comment deferred to "the offline pass" that does not
 * exist. `rnis::pano::Config::outputRotationCwDeg` is that step; this file
 * computes the number to put in it.
 *
 * ── THE FORMULA ────────────────────────────────────────────────────────────
 *
 *     outputRotationCwDeg = (SENSOR_ORIENTATION − displayRotationCwDeg) mod 360
 *
 * the standard AOSP back-camera transform. `SENSOR_ORIENTATION` is defined by
 * Camera2 as the clockwise angle the sensor's output must be rotated through to
 * be upright with the device in its NATURAL orientation — 90 on the A35's back
 * camera (`device.json`). `displayRotationCwDeg` is how far the device has been
 * turned from natural at sweep start.
 *
 * ⚠ BACK CAMERA ONLY. A front-facing sensor is mirrored, and its upright
 * transform is `(SENSOR_ORIENTATION + displayRotation) mod 360` plus a
 * reflection — a reflection no orthogonal bake can express. pano+ sweeps the
 * back camera; [uprightRotationCwDeg] is documented, and [isSupportedSensorOrientation]
 * gated, so a future front-camera caller gets a refusal rather than a mirror.
 */
internal object PanoPlusUprightRotation {

    /** The only sensor orientations Camera2 may report, and the only display
     *  rotations `Display.getRotation()` can produce, in degrees. */
    private val QUARTERS = intArrayOf(0, 90, 180, 270)

    /** The engine config key, spelled once. It is the C++ field name — the
     *  filter in `PanoPlusLiveModule.engineKnobKeys` is a FILTER and never a
     *  translation, so a typo here is a knob that silently does not apply. */
    const val KEY = "outputRotationCwDeg"

    /**
     * What the SDK assumed when it computed the value it sent.
     *
     * `panoPlusUprightRotationDeg` is `90 − deviceRotationCw`, and that 90 is
     * the BACK-CAMERA SENSOR CONSTANT — the same 90 the SDK's
     * `panoPlusImageRotationDeg` has spelled since v7, true for every iPhone and
     * for the A35 (`device.json`). It is not a law on Android, which is why
     * `PanoPlusLiveModule.correctUprightRotation` unwinds it against the real
     * `SENSOR_ORIENTATION` before the sweep starts.
     */
    const val SDK_ASSUMED_SENSOR_ORIENTATION_DEG = 90

    fun isSupportedSensorOrientation(deg: Int): Boolean = QUARTERS.contains(deg)

    /**
     * `(sensorOrientationCwDeg − displayRotationCwDeg) mod 360`, normalised
     * into {0, 90, 180, 270}.
     *
     * Returns `null` — never a plausible zero — when either input is not a
     * quarter turn. A wrong-but-plausible 0 here ships a sideways deliverable
     * and says nothing; a null makes the caller fall back to the host's own
     * value and record that it did.
     */
    fun uprightRotationCwDeg(sensorOrientationCwDeg: Int, displayRotationCwDeg: Int): Int? {
        if (!QUARTERS.contains(sensorOrientationCwDeg)) return null
        if (!QUARTERS.contains(displayRotationCwDeg)) return null
        var r = (sensorOrientationCwDeg - displayRotationCwDeg) % 360
        if (r < 0) r += 360
        return r
    }

    /**
     * The inverse read: given the bake a host asked for, which display rotation
     * does it imply for this sensor? Used only to CHECK a host value against the
     * device's real `SENSOR_ORIENTATION` — the host assumes 90 (true on every
     * phone we ship to, and on the A35, but not on every tablet), so this is how
     * a disagreement becomes visible instead of silent.
     */
    fun impliedDisplayRotationCwDeg(sensorOrientationCwDeg: Int, uprightCwDeg: Int): Int? {
        if (!QUARTERS.contains(sensorOrientationCwDeg)) return null
        if (!QUARTERS.contains(uprightCwDeg)) return null
        var r = (sensorOrientationCwDeg - uprightCwDeg) % 360
        if (r < 0) r += 360
        return r
    }

    /**
     * `Surface.ROTATION_*` (0..3) to degrees. Kept here rather than inlined at
     * the call site so the JVM suite can pin it: `Surface.ROTATION_90` is the
     * constant 1, not 90, and reading it as degrees is the classic way to get a
     * quarter turn's worth of wrong.
     */
    fun surfaceRotationToDeg(surfaceRotation: Int): Int? = when (surfaceRotation) {
        0 -> 0
        1 -> 90
        2 -> 180
        3 -> 270
        else -> null
    }
}
