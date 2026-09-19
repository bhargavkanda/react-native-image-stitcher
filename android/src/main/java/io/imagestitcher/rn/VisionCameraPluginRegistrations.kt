// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import com.mrousavy.camera.frameprocessors.FrameProcessorPluginRegistry

/**
 * EVERY vision-camera symbol this package touches at the registration layer,
 * in ONE file that can be excluded from the build.
 *
 * ── WHY IT EXISTS: THE PACKAGE DID NOT COMPILE WITHOUT VISION-CAMERA ────
 * `android/build.gradle` applies `compileOnly project(':react-native-vision-camera')`
 * only when that project exists, and excludes the plugin sources when it does
 * not. The exclude covered ONE of the three files that import
 * `com.mrousavy.camera`:
 *
 *   CvFlowGateFrameProcessor.kt   excluded  ✓
 *   SaveFrameAsJpegPlugin.kt      NOT excluded
 *   RNImageStitcherPackage.kt     NOT excluded, and CANNOT BE — it is the
 *                                 package entry point React Native autolinks
 *
 * So a consumer without vision-camera got an unresolved-import failure on the
 * entry point itself. The `catch (NoClassDefFoundError)` around the
 * registrations reads like it covers this and does not: it is a RUNTIME
 * guard, and an unresolved Kotlin import is a COMPILE error. The comment
 * above it — "the SDK doesn't hard-depend on it, consumers that don't use
 * `<Camera>` don't pay the dep" — was the intent; it has not been true on
 * Android.
 *
 * ⚠ THE ENTRY POINT MUST REACH THIS REFLECTIVELY. A direct call would be a
 * static reference to a class that is excluded from the very build this
 * exists to fix, which is the same compile error one layer along. So
 * `RNImageStitcherPackage` resolves this class by NAME and a
 * `ClassNotFoundException` is the expected, handled answer on a build
 * without vision-camera.
 *
 * ⚠ AND EVERY FUTURE vc PLUGIN REGISTERS HERE, NOT THERE. A registration
 * added to the entry point reintroduces the import this file removed, and
 * the failure is invisible to anyone who has vision-camera installed —
 * which is everyone who works on this repo.
 */
internal object VisionCameraPluginRegistrations {

    /**
     * Register every Frame Processor plugin this package ships.
     *
     * Invoked reflectively, so the signature is a contract: `public static`
     * (`@JvmStatic` on an `object`), no arguments, no return. Changing it
     * silently disables every plugin — the caller can only report that the
     * method was not found, not that it was renamed.
     *
     * Throws nothing it can help: the caller catches, but a throw here would
     * abort the remaining registrations, so failures are per-plugin.
     */
    @JvmStatic
    fun registerAll() {
        FrameProcessorPluginRegistry.addFrameProcessorPlugin(
            "cv_flow_gate_process_frame",
        ) { proxy, options -> CvFlowGateFrameProcessor(proxy, options) }

        FrameProcessorPluginRegistry.addFrameProcessorPlugin(
            SaveFrameAsJpegPlugin.PLUGIN_NAME,
        ) { proxy, options -> SaveFrameAsJpegPlugin(proxy, options) }
    }
}
