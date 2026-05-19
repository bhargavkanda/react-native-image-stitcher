// SPDX-License-Identifier: UNLICENSED
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
}
#endif
