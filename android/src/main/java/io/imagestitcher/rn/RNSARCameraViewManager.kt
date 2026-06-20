// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

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
 * Props:
 *   - `overlays` (0.20.0) — declarative `AROverlay[]` drawn on the AR
 *     overlay layer above the camera preview (see [AROverlayStore] /
 *     [AROverlayRenderer]).  React state-driven: when the array changes,
 *     RN re-sends it and we REPLACE the view's JS overlay namespace.  The
 *     imperative ref API (setOverlays / addOverlay / updateOverlay /
 *     removeOverlay / clearOverlays) routes through the `RNSARSession`
 *     native module instead (the same idiom takePhoto uses); both write the
 *     SAME JS namespace, and the renderer draws the union of JS + native-
 *     plugin overlays.
 *
 * Lifecycle remains driven by mount/unmount + the incremental stitcher's
 * start/finalize methods.
 */
class RNSARCameraViewManager : SimpleViewManager<RNSARCameraView>() {

    override fun getName(): String = REACT_CLASS

    override fun createViewInstance(reactContext: ThemedReactContext): RNSARCameraView =
        RNSARCameraView(reactContext)

    /**
     * 0.20.0 — declarative `overlays` prop.  Parses the `AROverlay[]` array
     * (the shared TS contract shape) and REPLACES the view's JS overlay
     * namespace.  A null / empty array clears the JS overlays (native-plugin
     * overlays are untouched).  Malformed entries are dropped (see
     * [AROverlayData.fromReadableArray]).
     *
     * React diffs the prop by value before re-sending, so we don't diff
     * here — a fresh array means "this is the new full JS overlay set".
     */
    @ReactProp(name = "overlays")
    fun setOverlays(view: RNSARCameraView, overlays: ReadableArray?) {
        view.setOverlaysFromJs(AROverlayData.fromReadableArray(overlays))
    }

    companion object {
        const val REACT_CLASS = "RNSARCameraView"
    }
}
