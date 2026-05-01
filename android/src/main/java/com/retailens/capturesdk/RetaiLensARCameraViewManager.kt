// SPDX-License-Identifier: UNLICENSED
package com.retailens.capturesdk

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

/**
 * RN ViewManager for `RetaiLensARCameraView`.
 *
 * JS side imports it as:
 *
 *     import { requireNativeComponent } from 'react-native';
 *     const RNARCamera = requireNativeComponent('RetaiLensARCameraView');
 *
 * Or — preferred — uses the SDK's existing `<ARCameraView>` wrapper
 * in `src/camera/ARCameraView.tsx` which auto-selects the native
 * component for iOS vs Android.
 *
 * The view itself is config-free for now (no JS-side props beyond
 * `style`) since lifecycle is driven by mount/unmount + the
 * incremental stitcher's start/finalize methods.  Future phases may
 * add props like `enabled` to allow JS-controlled pause/resume of
 * the GL render loop.
 */
class RetaiLensARCameraViewManager : SimpleViewManager<RetaiLensARCameraView>() {

    override fun getName(): String = REACT_CLASS

    override fun createViewInstance(reactContext: ThemedReactContext): RetaiLensARCameraView =
        RetaiLensARCameraView(reactContext)

    companion object {
        const val REACT_CLASS = "RetaiLensARCameraView"
    }
}
