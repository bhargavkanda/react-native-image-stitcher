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
        @Volatile
        private var fpPluginRegistered = false

        /**
         * F8.4 — register the vision-camera Frame Processor plugin.
         * Called lazily from `createNativeModules` (which fires
         * AFTER the React bridge has booted, side-stepping the
         * bridgeless TurboModule init race we'd hit if we did this
         * in a class-level static initialiser).
         *
         * No-op when vision-camera isn't on the runtime classpath
         * (the SDK doesn't hard-depend on it — consumers that don't
         * use `<Camera>` don't pay the dep).  Catches
         * `NoClassDefFoundError` defensively because the runtime
         * classpath is what matters, not the compile-time one.
         *
         * Idempotent: guarded by `fpPluginRegistered` so a host
         * with multiple React instances doesn't double-register
         * (would throw "name already exists" from the registry).
         */
        @JvmStatic
        @Synchronized
        fun ensureFrameProcessorPluginRegistered() {
            if (fpPluginRegistered) return
            try {
                FrameProcessorPluginRegistry.addFrameProcessorPlugin(
                    "cv_flow_gate_process_frame",
                ) { proxy, options ->
                    CvFlowGateFrameProcessor(proxy, options)
                }
                // v0.9.0 Layer 1 — register `save_frame_as_jpeg`
                // alongside the cv_flow_gate plugin.  Same lifecycle,
                // same defensive error handling (the outer try/catch
                // covers both registrations).  Either both register
                // or neither does — if vc isn't on the classpath,
                // both calls are skipped together.
                FrameProcessorPluginRegistry.addFrameProcessorPlugin(
                    SaveFrameAsJpegPlugin.PLUGIN_NAME,
                ) { proxy, options ->
                    SaveFrameAsJpegPlugin(proxy, options)
                }
                fpPluginRegistered = true
            } catch (e: NoClassDefFoundError) {
                android.util.Log.i(
                    "RNImageStitcherPackage",
                    "vision-camera FrameProcessorPluginRegistry not on classpath — "
                    + "skipping cv_flow_gate_process_frame + save_frame_as_jpeg "
                    + "plugin registration (host app doesn't appear to use "
                    + "Frame Processors).",
                )
                fpPluginRegistered = true  // don't retry every package init
            } catch (e: Throwable) {
                android.util.Log.w(
                    "RNImageStitcherPackage",
                    "Failed to register Frame Processor plugins "
                    + "(cv_flow_gate_process_frame / save_frame_as_jpeg): "
                    + e.message,
                )
                fpPluginRegistered = true
            }
        }
    }

    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> {
        // F8.4 — register the Frame Processor plugin here, after the
        // bridge is fully booted.  See `ensureFrameProcessorPluginRegistered`
        // for the rationale (vs. a class-load-time static init).
        ensureFrameProcessorPluginRegistered()
        return listOf(
            QualityChecker(reactContext),
            BatchStitcher(reactContext),
            RNSARSession(reactContext),
            IncrementalStitcher(reactContext),
            FileBridge(reactContext),
        )
    }

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = listOf(
        RNSARCameraViewManager(),
    )
}
