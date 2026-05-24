// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.mrousavy.camera.frameprocessors.FrameProcessorPluginRegistry

/**
 * ReactPackage that registers the SDK's two native modules with
 * the host app.  Picked up by RN autolinking via the package's
 * sourceDir entry in `react-native.config.js`.
 *
 * Modules registered:
 *   - QualityChecker: blur + brightness scoring
 *   - BatchStitcher:       stitch / stitchVideo / normaliseImage
 *
 * The Android JS surface mirrors iOS exactly so any code using
 * `NativeModules.RNImageStitcherQualityChecker.runQualityCheck(...)` or
 * `NativeModules.BatchStitcher.stitch(...)` works the same on
 * both platforms — no conditional branching needed in the SDK's
 * JS layer.
 */
class RNImageStitcherPackage : ReactPackage {

    companion object {
        // F8.4 — register the vision-camera Frame Processor plugin
        // exactly once, at class load time.  Vision-camera docs say:
        // "should be called as soon as possible — ideally on app
        // start or in a static initializer".  Autolinking loads this
        // class during MainApplication's package init, BEFORE any JS
        // can call `VisionCameraProxy.initFrameProcessorPlugin`, so
        // the plugin is guaranteed registered by the time JS looks
        // it up.
        //
        // No-op if vision-camera isn't on the classpath at runtime
        // (the SDK doesn't hard-depend on it — consumers that don't
        // use <Camera> don't pay the dep).  We catch the NoClassDef
        // defensively because the runtime classpath is what matters,
        // not the compile-time one (CocoaPods'
        // `__has_include` equivalent).
        init {
            try {
                FrameProcessorPluginRegistry.addFrameProcessorPlugin(
                    "cv_flow_gate_process_frame",
                ) { proxy, options ->
                    CvFlowGateFrameProcessor(proxy, options)
                }
            } catch (e: NoClassDefFoundError) {
                android.util.Log.i(
                    "RNImageStitcherPackage",
                    "vision-camera FrameProcessorPluginRegistry not on classpath — "
                    + "skipping cv_flow_gate_process_frame plugin registration "
                    + "(host app doesn't appear to use Frame Processors).",
                )
            } catch (e: Throwable) {
                android.util.Log.w(
                    "RNImageStitcherPackage",
                    "Failed to register cv_flow_gate_process_frame plugin: ${e.message}",
                )
            }
        }
    }

    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> = listOf(
        QualityChecker(reactContext),
        BatchStitcher(reactContext),
        RNSARSession(reactContext),
        IncrementalStitcher(reactContext),
        FileBridge(reactContext),
    )

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = listOf(
        RNSARCameraViewManager(),
    )
}
