// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.VisionCameraProxy

/**
 * v0.22.0 — vc Frame Processor plugin `rnis_exposure_burst_sink`:
 * forwards each producer-thread frame to `ExposureBurstCoordinator`
 * (the native half of `CameraHandle.captureExposureBurst`).  Mirror of
 * iOS' `ExposureBurstSinkPlugin.mm`.
 *
 * The lib's stitcher worklet calls this plugin for every frame ONLY
 * while the JS side has armed a burst (module-level shared value in
 * `src/camera/exposureBurst.ts`), and the coordinator no-ops on a
 * single atomic read unless a burst is mid-collection — a pure
 * forwarding shim, no state, no arguments.
 *
 * Registered in `RNImageStitcherPackage.ensureFrameProcessorPluginRegistered()`
 * alongside the other vc plugins (same defensive NoClassDefFoundError
 * posture).
 */
@DoNotStrip
@Keep
class ExposureBurstSinkPlugin(
    @Suppress("UNUSED_PARAMETER") proxy: VisionCameraProxy,
    @Suppress("UNUSED_PARAMETER") options: Map<String, Any>?,
) : FrameProcessorPlugin() {

    override fun callback(frame: Frame, params: Map<String, Any>?): Any? {
        // Synchronous hand-off; the coordinator packs (copies) what it
        // keeps before returning, respecting vc's frame lifetime.
        ExposureBurstCoordinator.ingest(frame)
        return null
    }

    companion object {
        /// Plugin name; MUST match iOS + the JS-side
        /// `initFrameProcessorPlugin('rnis_exposure_burst_sink')` call.
        const val PLUGIN_NAME = "rnis_exposure_burst_sink"
    }
}
