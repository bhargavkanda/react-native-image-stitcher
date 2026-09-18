// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoSourceView — the decoupled arm's viewfinder.
//
// WHY THIS EXISTS.  On `poseSource == 'imu'` the surface deliberately never
// mounts ARCameraView (mounting it STARTS ARKit, which cannot share the camera
// with this arm's AVCaptureSession — that gate is the fix for a camera-
// contention P0 and stays).  Until 2026-08-31 the arm vended NO other preview
// surface: `makePreviewLayer()` existed with zero callers, there was no view
// manager, and the operator's whole screen was a black View and one grey
// sentence — his report, verbatim: "The camera screen is blank!!! All I have
// is the preview to look at."
//
// This view is the other half: a plain UIView hosting an
// `AVCaptureVideoPreviewLayer` on the arm's OWN session.  Zero contention by
// construction — it renders whatever that session streams and never touches
// the camera itself:
//   * during a sweep, the sweep's live frames (the session the engine ingests
//     from IS the session this layer draws);
//   * while idle, the bridge's idle-preview mode (`setIdlePreview`) runs the
//     same session input-only, so the operator can FRAME the first shot.
//
// LIFECYCLE IS DELIBERATELY NOT HERE.  The AR view starts ARKit from
// `didMoveToWindow`; this view starts NOTHING — session ownership stays with
// `RNISPanoAvfSource` (sweeps) and `PanoPlusBridge.setIdlePreview` (idle),
// both serialized on the module's method queue.  A view that mutated the
// session from the main thread would race the bridge queue's start(), and
// that race is exactly the class of fault this arm exists to avoid.

#if canImport(React)
import AVFoundation
import Foundation
import React
import UIKit

@objc(RNSSweepSourceView)
public final class RNISPanoSourceView: UIView {
    private var previewLayer: AVCaptureVideoPreviewLayer?

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            guard previewLayer == nil else { return }
            let l = RNISPanoAvfSource.shared.makePreviewLayer()
            l.frame = bounds
            layer.addSublayer(l)
            previewLayer = l
        } else {
            previewLayer?.removeFromSuperlayer()
            previewLayer = nil
        }
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        // No implicit animation: a layout pass during rotation would otherwise
        // tween the camera feed across the screen.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer?.frame = bounds
        CATransaction.commit()
    }
}

/// RN registration — same Paper-bridge pattern as the stitcher's
/// `RNSARCameraViewManager`: the manager vends views, the .m file's
/// `RCT_EXTERN_MODULE` registers it, and RN derives the JS component name
/// "RNSSweepSourceView" by stripping "Manager".
@objc(RNSSweepSourceViewManager)
public final class RNISPanoSourceViewManager: RCTViewManager {
    public override func view() -> UIView! {
        return RNISPanoSourceView()
    }

    public override class func requiresMainQueueSetup() -> Bool {
        return true
    }
}
#endif
