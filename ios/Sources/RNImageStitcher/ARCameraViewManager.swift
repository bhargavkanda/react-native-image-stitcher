// SPDX-License-Identifier: Apache-2.0
//
// ARCameraViewManager — RCTViewManager that vends RNSARCameraView
// instances to React Native.
//
// React Native discovers native UI components via subclasses of
// RCTViewManager (or its newer ComponentDescriptor/ShadowNode siblings
// for Fabric).  We're on the bridge architecture (RN 0.84 Paper),
// so a thin RCTViewManager subclass is enough: override `view()` to
// return a fresh view instance, declare props via RCT_EXPORT_VIEW_PROPERTY
// in the .m bridge file, and React Native handles the rest of the
// view-tree integration.
//
// The class itself does almost nothing — view lifecycle (start/stop AR
// session) lives on the view, props are bridged via the .m file.  Most
// of the value here is the @objc(RNSARCameraViewManager) name
// matching the JS-side `requireNativeComponent` call.

#if canImport(React)
import Foundation
import React
import UIKit


@objc(RNSARCameraViewManager)
public final class RNSARCameraViewManager: RCTViewManager {

    /// Vends a new view instance per React Native mount.  RN reuses
    /// view instances when possible (recycler) but during initial
    /// hookup this is called once per `<ARCameraView>` element.
    public override func view() -> UIView! {
        return RNSARCameraView()
    }

    /// AR-camera view setup needs the main thread (UIKit + ARSCNView).
    public override class func requiresMainQueueSetup() -> Bool {
        return true
    }

    // MARK: - v0.20.0 — AR overlays
    //
    // OVERLAY WIRE PATH (shared cross-platform contract, see
    // `src/camera/arOverlayController.ts`): the JS imperative methods
    // (setOverlays / addOverlay / updateOverlay / removeOverlay /
    // clearOverlays) AND the declarative `overlays` prop both resolve, in
    // JS, to the FULL current overlay array and dispatch it through the
    // `RNSARSession.setOverlays(_:)` native MODULE method (see
    // `ARSessionBridge.swift`).  Native replaces its JS-overlay namespace
    // in `RNISAROverlayStore` wholesale and merges with the SEPARATE
    // plugin-overlay namespace (`RNISARPluginRegistry.setOverlays`) — the
    // draw view renders the UNION every ARFrame.
    //
    // The module method is the chosen mechanism (matching every other AR
    // setting: setPlaneDetection / setArFrameMetaEnabled /
    // setSceneReconstructionEnabled) because there is exactly ONE
    // `RNSARCameraView` mounted (ARKit can't share the camera), so there's
    // nothing to key by view tag.  We ALSO honor the declarative
    // `overlays` view prop here on the view (`RNSARCameraView.overlays`
    // KVC setter) so a host can drive overlays purely declaratively
    // without the module — both land in the same store namespace.
}
#endif
