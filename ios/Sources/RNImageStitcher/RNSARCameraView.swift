// SPDX-License-Identifier: Apache-2.0
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
        // Do NOT set autoresizingMask — we manage the ARSCNView frame
        // manually in layoutSubviews() to achieve letterboxing.
        // autoresizingMask would fight that and re-expand the view to
        // fill our bounds on every Auto Layout pass.

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

        // Black background: fills the letterbox bars (the areas of
        // this view outside ARSCNView's letterboxed sub-rect).
        backgroundColor = .black
        addSubview(arSCNView)
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        // Letterbox the ARSCNView to show the full camera FOV.
        //
        // ARSCNView's internal renderer always uses resizeAspectFill
        // (fills its view, crops if aspect ratios differ).  If we give
        // it our full bounds (portrait 9:21) and the camera image is
        // effectively portrait 3:4 (4:3 sensor rotated for device
        // orientation), it crops ~19% off each horizontal edge —
        // exactly the "viewport ≠ captured frame" bug.
        //
        // Fix: set ARSCNView's frame to the largest rect inside our
        // bounds that has the camera's content aspect ratio.  When
        // ARSCNView fills a same-AR sub-rect, there is nothing to crop
        // and the user sees the full captured scene.  The parent view's
        // black background fills the remainder.
        arSCNView.frame = letterboxedFrame()
    }

    /// Returns the largest `CGRect` inside `bounds` that matches the
    /// camera's content aspect ratio (accounting for device orientation),
    /// centred within `bounds`.
    private func letterboxedFrame() -> CGRect {
        let aspect = cameraContentAspect()
        let bw = bounds.width
        let bh = bounds.height
        guard bw > 0, bh > 0, aspect > 0 else { return bounds }

        // Try fitting by width first; if height overflows, fit by height.
        let hByWidth = bw / aspect
        if hByWidth <= bh {
            // Content fits within height — horizontal bars top+bottom.
            let y = (bh - hByWidth) / 2
            return CGRect(x: 0, y: y, width: bw, height: hByWidth)
        } else {
            // Vertical bars left+right.
            let wByHeight = bh * aspect
            let x = (bw - wByHeight) / 2
            return CGRect(x: x, y: 0, width: wByHeight, height: bh)
        }
    }

    /// Camera content aspect ratio (W÷H) in the current device orientation.
    ///
    /// The ARKit sensor is physically landscape (e.g. 1920 × 1440, aspect 4/3).
    /// When the device is portrait the ARSCNView displays the scene rotated,
    /// so the effective content aspect is 3/4.  We invert accordingly so the
    /// letterboxed frame always reflects what the user is actually looking at.
    ///
    /// Source priority:
    ///   1. `currentFrame.camera.imageResolution` — live, most accurate.
    ///   2. Active session config's `videoFormat.imageResolution` — stable
    ///      after `arSession.run(…)` and before the first frame.
    ///   3. 4:3 hardcoded fallback — correct for every iPhone ARKit camera.
    private func cameraContentAspect() -> CGFloat {
        let rawResolution: CGSize? = {
            if let res = RNSARSession.shared.arSession.currentFrame?.camera.imageResolution {
                return CGSize(width: res.width, height: res.height)
            }
            if let fmt = (RNSARSession.shared.arSession.configuration as? ARWorldTrackingConfiguration)?.videoFormat {
                return CGSize(width: fmt.imageResolution.width, height: fmt.imageResolution.height)
            }
            return nil
        }()

        // Raw sensor aspect (always landscape > 1 for iPhone cameras).
        let sensorAspect: CGFloat = rawResolution.map { $0.width / $0.height } ?? (4.0 / 3.0)

        // In portrait mode (view taller than wide) the displayed scene
        // is effectively portrait → invert the sensor aspect.
        let deviceIsPortrait = bounds.height > bounds.width
        return deviceIsPortrait ? (1.0 / sensorAspect) : sensorAspect
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
            // Re-layout after session start: the configuration's
            // videoFormat (and shortly after, currentFrame) are now
            // available for a more accurate aspect ratio.  On iOS all
            // ARKit cameras are 4:3 so this is a no-op in practice,
            // but it keeps the code correct for future configs.
            setNeedsLayout()
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


