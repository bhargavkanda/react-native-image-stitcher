// SPDX-License-Identifier: UNLICENSED
package com.retailens.capturesdk

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * ReactPackage that registers the SDK's two native modules with
 * the host app.  Picked up by RN autolinking via the package's
 * sourceDir entry in `react-native.config.js`.
 *
 * Modules registered:
 *   - RetaiLensQualityChecker: blur + brightness scoring
 *   - RetaiLensStitcher:       stitch / stitchVideo / normaliseImage
 *
 * The Android JS surface mirrors iOS exactly so any code using
 * `NativeModules.RetaiLensQualityChecker.runQualityCheck(...)` or
 * `NativeModules.RetaiLensStitcher.stitch(...)` works the same on
 * both platforms — no conditional branching needed in the SDK's
 * JS layer.
 */
class RetaiLensCapturePackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> = listOf(
        RetaiLensQualityChecker(reactContext),
        RetaiLensStitcher(reactContext),
        RetaiLensARSession(reactContext),
    )

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
