// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import io.imagestitcher.rn.panoplus.PanoPlusPackage

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
                // ⚠ BY NAME, NOT BY REFERENCE, AND THAT IS THE FIX.
                // `VisionCameraPluginRegistrations` imports vision-camera and
                // is EXCLUDED from the source set on a build that does not
                // have it. A direct call would be a static reference to a
                // class that is not compiled — the same unresolved-symbol
                // failure this indirection exists to remove, one layer along.
                //
                // `ClassNotFoundException` is therefore the EXPECTED answer on
                // a consumer without vision-camera, not an error: it means the
                // registrar was correctly excluded. `NoSuchMethodException`
                // is not — it means the registrar is present and its
                // reflective contract was renamed, which would silently
                // disable every plugin, so it is logged as a warning.
                Class.forName("io.imagestitcher.rn.VisionCameraPluginRegistrations")
                    .getMethod("registerAll")
                    .invoke(null)
                fpPluginRegistered = true
            } catch (e: ClassNotFoundException) {
                android.util.Log.i(
                    "RNImageStitcherPackage",
                    "vision-camera is not on this build — skipping Frame "
                    + "Processor plugin registration. This is the supported "
                    + "configuration for a consumer that does not use "
                    + "<Camera>; nothing is broken.",
                )
                fpPluginRegistered = true
            } catch (e: NoSuchMethodException) {
                android.util.Log.w(
                    "RNImageStitcherPackage",
                    "VisionCameraPluginRegistrations is present but "
                    + "registerAll() was not found — its reflective contract "
                    + "has been renamed and EVERY Frame Processor plugin is "
                    + "now unregistered: " + e.message,
                )
                fpPluginRegistered = true
            } catch (e: Throwable) {
                android.util.Log.w(
                    "RNImageStitcherPackage",
                    "Failed to register Frame Processor plugins: " + e.message,
                )
                fpPluginRegistered = true
            }
        }
    }

    // ⚠ pano+ IS NOT AUTOLINKED ON ITS OWN, AND CANNOT BE. React Native's
    // Gradle generator constructs exactly ONE ReactPackage per npm
    // dependency, named by react-native.config.js. A second top-level
    // registrar in this package would compile, ship inside the .aar, and
    // never be instantiated — every pano+ id simply absent from
    // NativeModules, on a green build and a successful install, with nothing
    // failing anywhere.
    //
    // Constructed ONCE, as a field, because PanoPlusPackage builds its probe
    // and its recorder exactly once inside its own createNativeModules: two
    // recorder instances would mean two Camera2 owners of the one back
    // camera.
    private val panoPlus = PanoPlusPackage()

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
            // v0.8.0 Phase 4b.ii — surfaces `NativeModules.StitcherJsiInstaller`
            // so JS' `ensureStitcherProxyInstalled()` can call its
            // blocking-sync `install()` to install `globalThis.__stitcherProxy`
            // on the main JS runtime (AR frame-processor host-worklet
            // registration).  Mirror of iOS' StitcherJsiInstaller.
            StitcherJsiInstallerModule(reactContext),
            // ⚠ BOTH OVERRIDES MUST DELEGATE. Forgetting one does not fail to
            // build and does not fail to install: it removes that half's
            // modules (or the pano+ viewfinder) at runtime, which reaches the
            // operator as "the feature is not available in this build".
        ) + panoPlus.createNativeModules(reactContext)
    }

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = listOf(
        RNSARCameraViewManager(),
    ) + panoPlus.createViewManagers(reactContext)
}
