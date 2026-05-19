// SPDX-License-Identifier: UNLICENSED
//
// RNSARCameraView — native UIView that renders the AR camera
// feed for the SDK's pose-aware capture surface.
//
// Phase 4.4 of the AR measurement plan.  This is the camera-access
// handoff: vision-camera owns the camera in non-AR audits, ARKit
// owns it in AR audits.  React Native picks which CameraView the
// host mounts; the host never sees both at once.
//
// Why ARSCNView vs custom Metal:
//   We just need to render `ARFrame.capturedImage` to screen — no
//   3D content overlays, no SceneKit nodes.  Custom Metal would be
//   ~150 lines of MTKView setup + a textured-quad shader.  ARSCNView
//   does the same thing in 2 lines: it's a UIKit view that auto-
//   renders the camera feed as the SceneKit background whenever its
//   `session` property points at a running ARSession.  Phase 5
//   stitching consumes pose data, NOT pixels-from-Metal, so we
//   never need the lower-level rendering control.
//
// Why a wrapper UIView (vs. exposing ARSCNView directly):
//   RCTViewManager expects to vend a UIView subclass it owns.
//   Wrapping ARSCNView lets us:
//     - resize its frame to match the React Native layout in
//       `layoutSubviews` (auto-resizing masks alone don't always
//       fire when RN's flexbox engine assigns a new bounds rect),
//     - add lifecycle hooks (start/stop the singleton AR session
//       when the view enters / leaves the window hierarchy), and
//     - keep room for future overlays (tracking-state HUD, focus
//       indicator, etc.) without touching ARSCNView internals.

import Foundation
import ARKit
import UIKit


@objc(RNSARCameraView)
public final class RNSARCameraView: UIView {

    /// The ARSCNView that does the actual rendering.  Bound to the
    /// singleton's ARSession so all preview surfaces share the same
    /// session (and the same pose log that the stitcher consumes).
    private var arSCNView: ARSCNView!

    public override init(frame: CGRect) {
        super.init(frame: frame)
        setupView()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupView()
    }

    private func setupView() {
        arSCNView = ARSCNView(frame: bounds)
        arSCNView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        // Bind to the singleton's session.  This is the critical
        // line — without it, ARSCNView would try to create its own
        // session and we'd lose the pose log.  Sharing means:
        //   - The host's `useARSession` hook still drives lifecycle.
        //   - Pose data captured via `RNSARSession.shared`'s
        //     delegate callbacks remains intact; this view is purely
        //     a renderer.
        arSCNView.session = RNSARSession.shared.arSession

        // We don't draw any 3D content in Phase 4.4.  Disable
        // SceneKit's automatic statistics overlay and lighting model
        // — we just want the camera feed.
        arSCNView.showsStatistics = false
        arSCNView.automaticallyUpdatesLighting = false

        // Black background while ARKit is initialising so the user
        // sees a clean frame instead of whatever was there before.
        backgroundColor = .black
        addSubview(arSCNView)
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        // RN's flexbox can re-bound this view at any time; keep the
        // ARSCNView locked to our bounds.  autoresizingMask handles
        // most cases but isn't always enough on rotation transitions.
        arSCNView.frame = bounds
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        // When this view enters the hierarchy, ensure the AR session
        // is running.  When it leaves, stop the session so the
        // hardware camera is freed for vision-camera or other uses.
        //
        // The singleton's start/stop are idempotent, so multiple
        // ARCameraView instances mounting/unmounting won't fight
        // each other (last-mount-wins semantics).  In practice the
        // host only mounts one at a time.
        if window != nil {
            if !RNSARSession.shared.isRunning {
                RNSARSession.shared.start()
            }
        } else {
            // Removed from window — stop the session.  Don't clear
            // the pose log here; the host explicitly clears between
            // captures via `RNSARSession.shared.clearPoseLog()`
            // so the JS layer controls when poses get discarded.
            if RNSARSession.shared.isRunning {
                RNSARSession.shared.stop()
            }
        }
    }
}


