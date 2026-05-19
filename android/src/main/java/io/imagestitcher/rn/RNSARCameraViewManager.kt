// SPDX-License-Identifier: UNLICENSED
package io.imagestitcher.rn

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

/**
 * RN ViewManager for `RNSARCameraView`.
 *
 * JS side imports it as:
 *
 *     import { requireNativeComponent } from 'react-native';
 *     const RNARCamera = requireNativeComponent('RNSARCameraView');
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
class RNSARCameraViewManager : SimpleViewManager<RNSARCameraView>() {

    override fun getName(): String = REACT_CLASS

    override fun createViewInstance(reactContext: ThemedReactContext): RNSARCameraView =
        RNSARCameraView(reactContext)

    companion object {
        const val REACT_CLASS = "RNSARCameraView"
    }
}
