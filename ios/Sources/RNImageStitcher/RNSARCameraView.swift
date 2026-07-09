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
import SceneKit
import UIKit
import simd


@objc(RNSARCameraView)
public final class RNSARCameraView: UIView, ARSCNViewDelegate {

    /// The ARSCNView that does the actual rendering.  Bound to the
    /// singleton's ARSession so all preview surfaces share the same
    /// session (and the same pose log that the stitcher consumes).
    private var arSCNView: ARSCNView!

    /// v0.20.0 — world-anchored overlays backed by REAL `ARAnchor`s.  Each
    /// overlay becomes an `ARAnchor` added to the session; ARSCNView creates a
    /// node per anchor (via `renderer(_:nodeFor:)`) and keeps its transform
    /// synced to the anchor every frame — and crucially ARKit *refines* the
    /// anchor as its world understanding improves (drift / re-localization),
    /// so the marker stays glued to the real-world spot across a long session,
    /// not just a short one (which a fixed world coordinate would not survive).
    /// Diffed against the overlay store each render pass (`RNISAROverlay` is
    /// `Equatable`): add new ids, rebuild changed ones, remove gone ones.
    ///
    /// Two maps, guarded by `anchorLock` because `nodeFor` may run on a
    /// different (render) thread than the `updateAtTime` diff:
    ///   - `overlayAnchors`: overlay id → (its anchor, the overlay it came from)
    ///   - `anchorOverlays`: anchor UUID → overlay (so `nodeFor` can build it)
    private var overlayAnchors: [String: (anchor: ARAnchor, overlay: RNISAROverlay)] = [:]
    private var anchorOverlays: [UUID: RNISAROverlay] = [:]
    private let anchorLock = NSLock()

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

        // v0.20.0 — overlays render as world-anchored SceneKit nodes inside
        // `arSCNView.scene` (see `syncOverlayNodes`), so there is no separate
        // 2D overlay UIView to add here.
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
        // Overlay nodes live in `arSCNView.scene` and are rendered by the
        // same (letterboxed) ARSCNView against the live AR camera, so they
        // need no separate framing — they align with the camera feed
        // automatically.
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

    /// Called once per ARSCNView render pass.  Keeps the set of overlay
    /// ARAnchors in sync with the overlay store (add / rebuild / remove).
    /// ARKit then tracks each anchor and ARSCNView positions its node — we do
    /// NOT project or position anything by hand.  Cheap: an `==` diff over a
    /// handful of overlays.
    ///
    /// We deliberately do NOT touch `RNSARSession`'s pose log / plugin /
    /// onArFrame paths — those ride the ARSession delegate which the singleton
    /// owns.  This delegate is purely the overlay-sync hook.
    public func renderer(
        _ renderer: SCNSceneRenderer,
        updateAtTime time: TimeInterval
    ) {
        syncOverlayAnchors()
    }

    /// ARSCNViewDelegate: vend the node for one of our overlay anchors.  May
    /// run on the render thread; ARSCNView keeps the returned node's transform
    /// synced to the (ARKit-refined) anchor.  We build the visual RELATIVE to
    /// the anchor origin — the anchor carries the world position.
    public func renderer(
        _ renderer: SCNSceneRenderer,
        nodeFor anchor: ARAnchor
    ) -> SCNNode? {
        anchorLock.lock()
        let overlay = anchorOverlays[anchor.identifier]
        anchorLock.unlock()
        guard let overlay = overlay else { return nil }

        if let quad = overlay.worldQuad, quad.count >= 3 {
            // Anchor sits at the centroid; draw the loop relative to it.
            var c = simd_float3(0, 0, 0)
            for v in quad { c += v }
            c /= Float(quad.count)
            return Self.makeQuadOutlineNode(
                relCorners: quad.map { $0 - c },
                color: overlay.color, label: overlay.label,
                shape: overlay.shape)
        }
        return Self.makeBillboardNode(
            sizeMeters: overlay.sizeMeters, color: overlay.color,
            label: overlay.label)
    }

    /// Diff the overlay store against the live anchors: add an ARAnchor for
    /// each new/changed overlay, remove anchors whose overlay is gone.
    private func syncOverlayAnchors() {
        let session = arSCNView.session
        let overlays = RNISAROverlayStore.shared.snapshot()
        var liveIDs = Set<String>()
        liveIDs.reserveCapacity(overlays.count)

        for overlay in overlays {
            liveIDs.insert(overlay.id)
            anchorLock.lock()
            let existing = overlayAnchors[overlay.id]
            anchorLock.unlock()
            if let existing = existing, existing.overlay == overlay { continue }

            // New or changed → drop the old anchor, add a fresh one.
            if let existing = existing {
                session.remove(anchor: existing.anchor)
                anchorLock.lock()
                anchorOverlays[existing.anchor.identifier] = nil
                overlayAnchors[overlay.id] = nil
                anchorLock.unlock()
            }
            guard let pose = Self.anchorPose(for: overlay) else { continue }
            let anchor = ARAnchor(transform: pose)
            anchorLock.lock()
            anchorOverlays[anchor.identifier] = overlay
            overlayAnchors[overlay.id] = (anchor, overlay)
            anchorLock.unlock()
            session.add(anchor: anchor)
        }

        // Remove anchors whose overlay id is gone (snapshot under the lock,
        // call session.remove outside it).
        anchorLock.lock()
        let goneIDs = overlayAnchors.keys.filter { !liveIDs.contains($0) }
        let goneAnchors = goneIDs.compactMap { overlayAnchors[$0]?.anchor }
        for id in goneIDs {
            if let a = overlayAnchors[id]?.anchor { anchorOverlays[a.identifier] = nil }
            overlayAnchors[id] = nil
        }
        anchorLock.unlock()
        for a in goneAnchors { session.remove(anchor: a) }
    }

    // MARK: - v0.20.0 overlay node builders (RELATIVE to the anchor origin)

    /// World transform for an overlay's anchor: a translation-only pose at the
    /// `worldPosition`, or at the centroid of `worldQuad`.  nil if no geometry.
    private static func anchorPose(for overlay: RNISAROverlay) -> simd_float4x4? {
        let p: simd_float3
        if let quad = overlay.worldQuad, quad.count >= 3 {
            var c = simd_float3(0, 0, 0)
            for v in quad { c += v }
            p = c / Float(quad.count)
        } else if let center = overlay.worldPosition {
            p = center
        } else {
            return nil
        }
        var m = matrix_identity_float4x4
        m.columns.3 = simd_float4(p.x, p.y, p.z, 1)
        return m
    }

    /// A camera-facing billboard plane (at the anchor origin), sized in metres,
    /// textured with a stroked outline + optional centred label.  Always drawn
    /// on top (depth read/write off) so an annotation is never hidden.
    private static func makeBillboardNode(
        sizeMeters: CGSize?,
        color: UIColor,
        label: String?
    ) -> SCNNode {
        let w = sizeMeters?.width ?? RNISAROverlay.defaultMarkerExtent
        let h = sizeMeters?.height ?? RNISAROverlay.defaultMarkerExtent
        let plane = SCNPlane(width: w, height: h)
        let mat = SCNMaterial()
        mat.diffuse.contents = overlayImage(color: color, label: label)
        mat.isDoubleSided = true
        mat.lightingModel = .constant      // unlit — show the texture as-is
        mat.writesToDepthBuffer = false
        mat.readsFromDepthBuffer = false   // never occluded by the scene
        plane.firstMaterial = mat

        let node = SCNNode(geometry: plane)
        node.renderingOrder = 1000         // draw after the camera background
        let billboard = SCNBillboardConstraint()
        billboard.freeAxes = .all          // always face the camera, flat
        node.constraints = [billboard]
        return node
    }

    /// Edge-cylinder radii per overlay shape.  `.outline` keeps the original
    /// prominent 4 mm stroke.  `.box` — the SDK's "filled + subtle border"
    /// intent (see RNISAROverlay shape docs; Android draws a 4 *screen*-px
    /// stroke + 22% fill) — uses 1.5 mm: at the 0.5–0.8 m shelf stand-off
    /// that subtends ≈5–8 px, matching Android instead of the ≈15–25 px the
    /// 4 mm cylinders read as (reported as "box edges got so much thicker").
    private static let outlineEdgeRadius: CGFloat = 0.004
    private static let boxEdgeRadius: CGFloat = 0.0015
    /// `.box` fill opacity — Android parity (BOX_FILL_ALPHA 0x38 ≈ 22%).
    private static let boxFillAlpha: CGFloat = 0.22

    /// A 3D outline through corners expressed RELATIVE to the anchor
    /// origin (anchor at the quad centroid).  Each edge is a thin cylinder —
    /// SceneKit `.line` primitives are always 1px and unscalable, so a visible
    /// outline must be real geometry.  `shape == .box` additionally renders
    /// the translucent face the SDK asked for (previously ignored on iOS —
    /// Android has always honoured it) and thins the edges to the border
    /// role.  Optional camera-facing label at centre.
    private static func makeQuadOutlineNode(
        relCorners: [simd_float3],
        color: UIColor,
        label: String?,
        shape: RNISAROverlay.Shape
    ) -> SCNNode {
        let node = SCNNode()
        node.renderingOrder = 1000
        let radius = shape == .box ? boxEdgeRadius : outlineEdgeRadius
        let n = relCorners.count
        if shape == .box, let fill = quadFillNode(relCorners: relCorners, color: color) {
            node.addChildNode(fill)
        }
        for i in 0..<n {
            if let edge = edgeCylinder(
                from: relCorners[i], to: relCorners[(i + 1) % n], color: color,
                radius: radius) {
                node.addChildNode(edge)
            }
        }
        if let label = label, !label.isEmpty {
            // Label at the centroid (≈ local origin in relative space).
            let labelNode = makeBillboardNode(
                sizeMeters: CGSize(width: 0.12, height: 0.12),
                color: color, label: label)
            node.addChildNode(labelNode)
        }
        return node
    }

    /// The translucent face of a `.box` quad: the polygon fan-triangulated
    /// about corner 0 (corners arrive in loop order from the detector).
    /// Double-sided so the fill reads from either side of the plane; no
    /// depth interaction, matching the edges.
    private static func quadFillNode(
        relCorners: [simd_float3], color: UIColor
    ) -> SCNNode? {
        let n = relCorners.count
        guard n >= 3 else { return nil }
        let source = SCNGeometrySource(
            vertices: relCorners.map { SCNVector3($0.x, $0.y, $0.z) })
        var indices: [Int32] = []
        indices.reserveCapacity((n - 2) * 3)
        for i in 1..<(n - 1) {
            indices.append(0)
            indices.append(Int32(i))
            indices.append(Int32(i + 1))
        }
        let element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
        let geom = SCNGeometry(sources: [source], elements: [element])
        let mat = SCNMaterial()
        mat.diffuse.contents = color.withAlphaComponent(boxFillAlpha)
        mat.lightingModel = .constant
        mat.isDoubleSided = true
        mat.writesToDepthBuffer = false
        mat.readsFromDepthBuffer = false
        geom.firstMaterial = mat
        let node = SCNNode(geometry: geom)
        // Under the edges/label (parent order is not a z-guarantee in
        // SceneKit — renderingOrder is).
        node.renderingOrder = 999
        return node
    }

    /// A thin cylinder spanning two points — one edge of a quad outline.
    /// SCNCylinder's axis is +Y, so we centre it at the midpoint and
    /// rotate +Y onto the edge direction.
    private static func edgeCylinder(
        from a: simd_float3, to b: simd_float3, color: UIColor,
        radius: CGFloat
    ) -> SCNNode? {
        let d = b - a
        let len = simd_length(d)
        guard len > 1e-5 else { return nil }
        let cyl = SCNCylinder(radius: radius, height: CGFloat(len))
        let mat = SCNMaterial()
        mat.diffuse.contents = color
        mat.lightingModel = .constant
        mat.writesToDepthBuffer = false
        mat.readsFromDepthBuffer = false
        cyl.firstMaterial = mat
        let node = SCNNode(geometry: cyl)
        node.renderingOrder = 1000
        node.simdPosition = (a + b) * 0.5
        let yAxis = simd_float3(0, 1, 0)
        let dir = d / len
        let dot = simd_dot(yAxis, dir)
        if dot < -0.9999 {
            node.simdOrientation = simd_quatf(angle: .pi, axis: simd_float3(1, 0, 0))
        } else if dot < 0.9999 {
            let axis = simd_normalize(simd_cross(yAxis, dir))
            node.simdOrientation = simd_quatf(angle: acos(dot), axis: axis)
        }
        return node
    }

    /// Render a stroked rounded-rect outline + optional centred label chip to
    /// a square image, used as the billboard plane's texture.  Transparent
    /// background so only the outline + chip show over the camera feed.
    private static func overlayImage(color: UIColor, label: String?) -> UIImage {
        let px: CGFloat = 512
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: px, height: px))
        return renderer.image { ctx in
            let cg = ctx.cgContext
            let inset = px * 0.07
            let rect = CGRect(x: inset, y: inset,
                              width: px - 2 * inset, height: px - 2 * inset)
            let path = UIBezierPath(roundedRect: rect, cornerRadius: px * 0.05)
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(px * 0.03)
            path.stroke()

            guard let label = label, !label.isEmpty else { return }
            let fontSize = px * 0.13
            let font = UIFont.systemFont(ofSize: fontSize, weight: .bold)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: UIColor.white,
            ]
            let ts = (label as NSString).size(withAttributes: attrs)
            let pad = fontSize * 0.35
            let chip = CGRect(x: (px - ts.width) / 2 - pad,
                              y: (px - ts.height) / 2 - pad,
                              width: ts.width + 2 * pad,
                              height: ts.height + 2 * pad)
            color.withAlphaComponent(0.9).setFill()
            UIBezierPath(roundedRect: chip, cornerRadius: pad).fill()
            (label as NSString).draw(
                at: CGPoint(x: (px - ts.width) / 2, y: (px - ts.height) / 2),
                withAttributes: attrs)
        }
    }

}

