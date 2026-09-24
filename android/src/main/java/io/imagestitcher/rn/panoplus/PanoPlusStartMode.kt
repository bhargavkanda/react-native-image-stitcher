// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn.panoplus

/**
 * Which start mode a recorder session takes — decided from the bag ALONE,
 * before anything is opened.
 *
 * ⚠ A LIVE AR SWEEP IS ALWAYS THE AR-PLUGIN ARM. It runs on the stitcher's own
 * ARCore session (`RNSARSession`) through [PanoPlusArFramePlugin]; pano+ opens
 * no ARCore Session and no Camera2 client for it. Until M2 this was reached
 * only behind an `arPluginArm` flag the library never sent, and only AFTER the
 * recorder had opened its own ARCore channel — so the library-default AR sweep
 * ran on pano+'s own SHARED_CAMERA arm, a second camera owner that never
 * painted a strip in 23 packs.
 *
 * A live AR sweep that also asks for pano+'s own ARCore reference channel is
 * REFUSED BY NAME: the channel would be exactly that second owner.
 *
 * Pure, so the rule is a JVM test rather than a device observation.
 */
internal enum class PanoStartMode {
    /** The stitcher's ARCore session feeds the engine through the AR frame plugin. */
    AR_PLUGIN,

    /** A live AR sweep asked for pano+'s own ARCore channel — refused by name. */
    REFUSE_OWN_ARCORE_ON_AR_ARM,

    /** vision-camera's camera feeds the engine through the frame processor plugin. */
    VC_PLUGIN,

    /** Everything else: the recorder's own start path (recording, reference runs). */
    RECORDER,
}

internal fun panoStartMode(
    live: Boolean,
    poseSource: String,
    arcoreReference: ArCoreRefMode,
    vcPluginArm: Boolean,
): PanoStartMode = when {
    live && poseSource == "ar" && arcoreReference != ArCoreRefMode.OFF ->
        PanoStartMode.REFUSE_OWN_ARCORE_ON_AR_ARM
    live && poseSource == "ar" -> PanoStartMode.AR_PLUGIN
    // Read WITH the pose arm, never alone (the 2026-09-10 regression: a flag
    // that selects an ARM read on its own sent an IMU sweep down the wrong one).
    vcPluginArm && poseSource == "imu" -> PanoStartMode.VC_PLUGIN
    else -> PanoStartMode.RECORDER
}
