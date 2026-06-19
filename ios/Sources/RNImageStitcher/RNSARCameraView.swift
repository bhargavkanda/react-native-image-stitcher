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
import simd


@objc(RNSARCameraView)
public final class RNSARCameraView: UIView, ARSCNViewDelegate {

    /// The ARSCNView that does the actual rendering.  Bound to the
    /// singleton's ARSession so all preview surfaces share the same
    /// session (and the same pose log that the stitcher consumes).
    private var arSCNView: ARSCNView!

    /// v0.20.0 — transparent overlay layer drawn ABOVE the camera
    /// preview.  Reprojects each overlay's world point(s) to screen
    /// every AR frame and strokes the outline/box + label.  Letterboxed
    /// to the SAME sub-rect as `arSCNView` so projected screen points
    /// (which are in the camera-image viewport) line up with the pixels
    /// the user sees.
    private var overlayView: AROverlayDrawView!

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

        // v0.20.0 — become the ARSCNView's render delegate so
        // `renderer(_:updateAtTime:)` fires once per render pass (display
        // rate) on the MAIN thread.  This is our per-frame overlay redraw
        // hook: cheap (a handful of overlays), already on the main thread,
        // and gives us smooth display-rate tracking without touching the
        // ARSession delegate (which `RNSARSession` owns for pose logging).
        arSCNView.delegate = self

        // We don't draw any 3D content in Phase 4.4.  Disable
        // SceneKit's automatic statistics overlay and lighting model
        // — we just want the camera feed.
        arSCNView.showsStatistics = false
        arSCNView.automaticallyUpdatesLighting = false

        // Black background: fills the letterbox bars (the areas of
        // this view outside ARSCNView's letterboxed sub-rect).
        backgroundColor = .black
        addSubview(arSCNView)

        // v0.20.0 — overlay layer ABOVE the preview.  Transparent +
        // non-interactive (touches pass through to RN's gesture layer).
        overlayView = AROverlayDrawView(frame: bounds)
        overlayView.backgroundColor = .clear
        overlayView.isOpaque = false
        overlayView.isUserInteractionEnabled = false
        addSubview(overlayView)
    }

    // MARK: - v0.20.0 — declarative `overlays` prop (KVC from RN)

    /// Declarative `overlays` prop.  RN sets this via KVC
    /// (`RCT_EXPORT_VIEW_PROPERTY(overlays, NSArray)`) whenever the prop
    /// changes; we replace the JS overlay namespace wholesale (declarative
    /// = the full set each render).  Forwarded to the global store rather
    /// than held per-view because the overlay world is global to the single
    /// AR session.  `@objc` + `NSArray` so KVC can set it.
    @objc public var overlays: NSArray = [] {
        didSet {
            Self.applyJSSetOverlays(overlays)
        }
    }

    /// Parse a JS overlay-dictionary array and replace the JS overlay
    /// namespace in the shared store.  Shared by the declarative prop
    /// setter (above) and the imperative `setOverlays` view command (in
    /// `RNSARCameraViewManager`).
    static func applyJSSetOverlays(_ overlays: NSArray) {
        var parsed: [RNISAROverlay] = []
        parsed.reserveCapacity(overlays.count)
        for item in overlays {
            guard let dict = item as? [String: Any],
                  let o = RNISAROverlay.from(dictionary: dict) else { continue }
            parsed.append(o)
        }
        RNISAROverlayStore.shared.setJSOverlays(parsed)
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
        let lb = letterboxedFrame()
        arSCNView.frame = lb
        // Overlay must cover the SAME letterboxed sub-rect: projectPoint
        // returns viewport-relative pixels for the camera-image area, so
        // the overlay's coordinate origin has to match `arSCNView`'s.
        overlayView.frame = lb
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

    // MARK: - ARSCNViewDelegate (v0.20.0 overlay redraw hook)

    /// Called once per ARSCNView render pass (≈ display rate) on the MAIN
    /// thread.  We use it ONLY to drive the overlay redraw: refresh the
    /// projected screen points from the current ARFrame's camera
    /// pose+intrinsics and mark the overlay layer dirty.  Cheap — bails
    /// immediately when there are no overlays (the common case), so a
    /// preview with no annotations pays essentially nothing here.
    ///
    /// We deliberately do NOT touch `RNSARSession`'s pose log / plugin /
    /// onArFrame paths — those ride the ARSession delegate which the
    /// singleton owns.  This delegate is purely the renderer's hook.
    public func renderer(
        _ renderer: SCNSceneRenderer,
        updateAtTime time: TimeInterval
    ) {
        guard overlayView != nil else { return }
        if RNISAROverlayStore.shared.isEmpty {
            // Clear any stale geometry once after the last overlay is
            // removed, then stop doing work.
            if overlayView.hasProjectedShapes {
                overlayView.update(projected: [])
            }
            return
        }
        guard let frame = arSCNView.session.currentFrame else { return }
        let viewportSize = overlayView.bounds.size
        guard viewportSize.width > 0, viewportSize.height > 0 else { return }

        // Interface orientation drives ARKit's projectPoint mapping.  Read
        // it from the window scene (main thread — we are on it).
        let orientation = currentInterfaceOrientation()

        let overlays = RNISAROverlayStore.shared.snapshot()
        var projected: [AROverlayDrawView.ProjectedShape] = []
        projected.reserveCapacity(overlays.count)
        for overlay in overlays {
            if let shape = Self.project(
                overlay: overlay,
                camera: frame.camera,
                orientation: orientation,
                viewportSize: viewportSize
            ) {
                projected.append(shape)
            }
        }
        overlayView.update(projected: projected)
    }

    /// Reproject one overlay's world point(s) to screen via ARKit's
    /// BUILT-IN `ARCamera.projectPoint(_:orientation:viewportSize:)`.
    /// Returns `nil` (overlay hidden this frame) when ANY required corner
    /// is behind the camera — `projectPoint` clamps off-screen but does
    /// not signal "behind", so we additionally test each point against the
    /// camera's view matrix and drop the whole shape if any corner has a
    /// non-negative camera-space Z (i.e. behind the lens).
    private static func project(
        overlay: RNISAROverlay,
        camera: ARCamera,
        orientation: UIInterfaceOrientation,
        viewportSize: CGSize
    ) -> AROverlayDrawView.ProjectedShape? {

        // v0.20.0 3D SCAFFOLD HOOK ───────────────────────────────────
        // `mode:'3d'` is a scaffold this release — no 3D engine
        // (SceneKit / Filament) is wired.  We render it as 2D (below)
        // and warn ONCE.  A future release plugs a SceneKit node-based
        // renderer in HERE (e.g. add/update an SCNNode on
        // `arSCNView.scene.rootNode` keyed by overlay.id) instead of
        // falling through to the 2D projection.
        if overlay.mode == .threeD {
            warnOnce3DScaffold()
            // fall through → treat as 2D
        }

        // Build the world corners to project.
        let worldCorners: [simd_float3]
        if let quad = overlay.worldQuad, quad.count >= 3 {
            worldCorners = quad
        } else if let center = overlay.worldPosition {
            worldCorners = billboardCorners(
                center: center,
                sizeMeters: overlay.sizeMeters,
                camera: camera
            )
        } else {
            return nil
        }

        // Drop the shape if ANY corner is behind the camera.  Camera-space
        // Z >= 0 means at/behind the lens (ARKit camera looks down -Z).
        let viewMatrix = camera.viewMatrix(for: orientation)
        for corner in worldCorners {
            let cam = viewMatrix * simd_float4(corner.x, corner.y, corner.z, 1)
            if cam.z >= 0 { return nil }
        }

        // Project each corner with ARKit's built-in projection (correct
        // for the device's intrinsics + lens distortion model).
        var screenPoints: [CGPoint] = []
        screenPoints.reserveCapacity(worldCorners.count)
        for corner in worldCorners {
            let pt = camera.projectPoint(
                corner,
                orientation: orientation,
                viewportSize: viewportSize
            )
            // Guard against NaN/inf from a degenerate projection.
            guard pt.x.isFinite, pt.y.isFinite else { return nil }
            screenPoints.append(pt)
        }

        // Hide entirely-off-screen shapes (all corners outside the
        // viewport rect) — keeps the draw layer clean and avoids drawing
        // labels for things the user can't see.
        let viewportRect = CGRect(origin: .zero, size: viewportSize)
        let anyVisible = screenPoints.contains { viewportRect.contains($0) }
        if !anyVisible { return nil }

        return AROverlayDrawView.ProjectedShape(
            id: overlay.id,
            points: screenPoints,
            color: overlay.color,
            label: overlay.label,
            closed: true
        )
    }

    /// Four world corners of an axis-screen-aligned billboard centred at
    /// `center`, half-extents from `sizeMeters` (default a small marker).
    /// The billboard faces the camera by spanning the camera's RIGHT and
    /// UP world axes (columns 0 and 1 of the camera transform) so the
    /// marker always presents flat to the viewer.
    private static func billboardCorners(
        center: simd_float3,
        sizeMeters: CGSize?,
        camera: ARCamera
    ) -> [simd_float3] {
        let halfW = Float((sizeMeters?.width
            ?? RNISAROverlay.defaultMarkerExtent)) * 0.5
        let halfH = Float((sizeMeters?.height
            ?? RNISAROverlay.defaultMarkerExtent)) * 0.5
        let t = camera.transform
        let right = simd_normalize(simd_float3(
            t.columns.0.x, t.columns.0.y, t.columns.0.z))
        let up = simd_normalize(simd_float3(
            t.columns.1.x, t.columns.1.y, t.columns.1.z))
        let rW = right * halfW
        let uH = up * halfH
        // CW from top-left for a clean stroked quad.
        return [
            center - rW + uH,  // top-left
            center + rW + uH,  // top-right
            center + rW - uH,  // bottom-right
            center - rW - uH,  // bottom-left
        ]
    }

    /// Current interface orientation, read on the main thread.  Falls
    /// back to `.portrait` (the SDK's default capture orientation) when a
    /// window scene isn't available yet.
    private func currentInterfaceOrientation() -> UIInterfaceOrientation {
        if let scene = window?.windowScene {
            return scene.interfaceOrientation
        }
        for scene in UIApplication.shared.connectedScenes {
            if let ws = scene as? UIWindowScene {
                return ws.interfaceOrientation
            }
        }
        return .portrait
    }

    /// One-time warning that `mode:'3d'` is a scaffold (rendered as 2D).
    private static var did3DScaffoldWarn = false
    private static let warnLock = NSLock()
    private static func warnOnce3DScaffold() {
        warnLock.lock()
        defer { warnLock.unlock() }
        guard !did3DScaffoldWarn else { return }
        did3DScaffoldWarn = true
        NSLog("[RNSARCameraView] AROverlay mode:'3d' is a scaffold in this "
            + "release — rendering as 2D.  A SceneKit-backed 3D renderer "
            + "is coming in a later release.")
    }
}


// MARK: - AROverlayDrawView (v0.20.0)

/// Transparent overlay layer that strokes the projected overlay shapes +
/// labels.  Geometry is recomputed every AR frame by `RNSARCameraView`
/// and pushed via `update(projected:)`; this view just draws what it's
/// told in `draw(_:)` — a thin, allocation-light Core Graphics pass.
final class AROverlayDrawView: UIView {

    /// One overlay's screen-space geometry for the current frame.  A
    /// value type so `update(projected:)` swaps an immutable snapshot
    /// (no shared mutable state between the producing/drawing steps).
    struct ProjectedShape {
        let id: String
        /// Screen points (in this view's coordinate space) to connect.
        let points: [CGPoint]
        /// Stroke + label color.
        let color: UIColor
        /// Optional text label, drawn near the shape's centroid.
        let label: String?
        /// Whether to close the polygon (connect last→first).
        let closed: Bool
    }

    private var shapes: [ProjectedShape] = []

    /// Whether anything was drawn last update — lets the camera view skip
    /// a redundant clear when the overlay set empties.
    var hasProjectedShapes: Bool { !shapes.isEmpty }

    /// Stroke width (points) for outlines / boxes.
    private let strokeWidth: CGFloat = 2.5
    /// Label font.
    private let labelFont = UIFont.systemFont(ofSize: 13, weight: .semibold)

    /// Replace the geometry to draw and request a redraw.  Called on the
    /// main thread from `RNSARCameraView.renderer(_:updateAtTime:)`.
    func update(projected: [ProjectedShape]) {
        shapes = projected
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.setLineWidth(strokeWidth)
        ctx.setLineJoin(.round)
        ctx.setLineCap(.round)

        for shape in shapes {
            guard shape.points.count >= 2 else {
                // A single projected point (degenerate) — draw a small dot
                // so a marker that collapsed to one pixel is still visible.
                if let p = shape.points.first {
                    drawDot(at: p, color: shape.color, in: ctx)
                    drawLabel(shape.label, near: p, color: shape.color)
                }
                continue
            }

            ctx.setStrokeColor(shape.color.cgColor)
            ctx.beginPath()
            ctx.move(to: shape.points[0])
            for i in 1..<shape.points.count {
                ctx.addLine(to: shape.points[i])
            }
            if shape.closed {
                ctx.closePath()
            }
            ctx.strokePath()

            // Label at the centroid (or above the top-most point).
            drawLabel(shape.label, near: centroid(of: shape.points),
                      color: shape.color)
        }
    }

    private func drawDot(at p: CGPoint, color: UIColor, in ctx: CGContext) {
        let r: CGFloat = 4
        ctx.setFillColor(color.cgColor)
        ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r,
                                   width: 2 * r, height: 2 * r))
    }

    private func centroid(of points: [CGPoint]) -> CGPoint {
        guard !points.isEmpty else { return .zero }
        var sx: CGFloat = 0, sy: CGFloat = 0
        for p in points { sx += p.x; sy += p.y }
        return CGPoint(x: sx / CGFloat(points.count),
                       y: sy / CGFloat(points.count))
    }

    private func drawLabel(_ text: String?, near point: CGPoint,
                           color: UIColor) {
        guard let text = text, !text.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: UIColor.white,
        ]
        let size = (text as NSString).size(withAttributes: attrs)
        let padding: CGFloat = 4
        // Background chip for legibility over the camera feed.
        let chipRect = CGRect(
            x: point.x - size.width / 2 - padding,
            y: point.y - size.height / 2 - padding,
            width: size.width + 2 * padding,
            height: size.height + 2 * padding
        )
        let chipPath = UIBezierPath(roundedRect: chipRect, cornerRadius: 4)
        color.withAlphaComponent(0.85).setFill()
        chipPath.fill()
        (text as NSString).draw(
            at: CGPoint(x: chipRect.minX + padding,
                        y: chipRect.minY + padding),
            withAttributes: attrs
        )
    }
}


