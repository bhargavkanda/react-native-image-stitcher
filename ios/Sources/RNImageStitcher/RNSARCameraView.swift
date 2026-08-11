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
            let rel = quad.map { $0 - c }
            // Unit vector centroid → CAMERA, in world space.  The anchor pose
            // is translation-only (see `anchorPose`), so a world direction is
            // also a node-local direction and needs no basis change.  Used
            // ONLY to give "1.5 mm in front of the fill" an unambiguous sign
            // for a plane-oriented quad (whose normal direction depends on
            // the producer's corner winding, which we do not control).  nil ⇒
            // the winding's own normal is used; the worst case is a stroke
            // drawn 1.5 mm BEHIND its own fill and therefore tinted by it —
            // never a vanished box, because nothing in the visible tier
            // writes depth.
            let camDir: simd_float3? = {
                guard let pov = renderer.pointOfView else { return nil }
                let d = pov.simdWorldPosition - c
                let len = simd_length(d)
                guard len.isFinite, len > 1e-4 else { return nil }
                return d / len
            }()
            // `orient:'camera'` box ⇒ draw a GRAVITY-UP, YAW-TO-CAMERA box
            // (see `makeBillboardBoxNode`) — for corners that are not on a
            // reliable plane yet.  Default 'plane' keeps the world-corner
            // outline, which foreshortens correctly with the surface.
            if overlay.billboard, overlay.shape == .box {
                return Self.makeBillboardBoxNode(
                    relCorners: rel, color: overlay.color, label: overlay.label,
                    fillAlpha: overlay.fillAlpha, strokeAlpha: overlay.strokeAlpha,
                    imageUri: overlay.imageUri,
                    depthOcclusion: overlay.depthOcclusion)
            }
            return Self.makeQuadOutlineNode(
                relCorners: rel,
                color: overlay.color, label: overlay.label,
                shape: overlay.shape, fillAlpha: overlay.fillAlpha,
                strokeAlpha: overlay.strokeAlpha,
                imageUri: overlay.imageUri,
                camDir: camDir,
                depthOcclusion: overlay.depthOcclusion)
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
    ///
    /// Keeps `freeAxes = .all` on purpose while `makeBillboardBoxNode` drops
    /// to `.Y`: this is a TEXT/marker annotation, 2-D chrome whose whole job
    /// is to stay legible and screen-aligned.  A world-anchored box marks a
    /// physical thing and must not roll with the device; a caption may.
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
        // `overlayOrder`, not a third value: the depth scheme has exactly TWO
        // tiers and an auditable "one renderingOrder for everything visible"
        // invariant.  This was 1000, which after the collapse would have sat
        // BETWEEN the writers (999) and every box (1001) — a marker drawn
        // before the boxes and therefore tinted by any fill over it.
        node.renderingOrder = overlayOrder  // after the camera background
        let billboard = SCNBillboardConstraint()
        billboard.freeAxes = .all          // always face the camera, flat
        node.constraints = [billboard]
        return node
    }

    /// Decoded badge-image cache.  A tracked overlay re-sends the SAME
    /// `imageUri` on EVERY frame, so decoding per frame would burn CPU and
    /// heat the device for no pixel change.  Bounded by count; `NSCache`
    /// also evicts under memory pressure, and a miss simply re-decodes.
    private static let badgeImageCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 128
        return cache
    }()

    /// Load (and cache) an overlay's badge image.  Returns nil when the path
    /// is missing or undecodable — the box then draws WITHOUT a badge rather
    /// than the overlay failing, so a stale path degrades gracefully.
    private static func badgeImage(_ uri: String) -> UIImage? {
        let key = uri as NSString
        if let hit = badgeImageCache.object(forKey: key) { return hit }
        let path = uri.hasPrefix("file://") ? (URL(string: uri)?.path ?? uri) : uri
        guard let img = UIImage(contentsOfFile: path) else { return nil }
        badgeImageCache.setObject(img, forKey: key)
        return img
    }

    /// A camera-facing plane textured with the overlay's badge image (no
    /// outline, no label).  Aspect-preserving: the image fits INSIDE
    /// `extent` so a tall image and a wide one both read correctly instead
    /// of being squashed to a square.
    ///
    /// Stays fully billboarded (`.all`): this is a small identification
    /// BADGE, not the marked object itself — it should read the same however
    /// the surface is angled, and a badge that rolls with the device is
    /// exactly what "screen-upright" means for 2-D chrome.
    ///
    /// Keeps depth read AND write OFF, deliberately.  A camera-facing badge
    /// is NOT parallel to the quad it annotates, so at a grazing angle it
    /// intersects that plane; depth-reading it would slice the badge in half
    /// against its own box's writer instead of occluding it.  The price is
    /// that a badge belonging to an occluded box still shows — a ≤5 cm chip,
    /// and strictly better than the whole box showing.  The caller offsets
    /// it towards the viewer so the transparent sort puts it last within its
    /// own box.
    private static func makeBadgeImageNode(
        image: UIImage, extent: CGFloat
    ) -> SCNNode {
        let ar = image.size.height > 0 ? image.size.width / image.size.height : 1
        let w = ar >= 1 ? extent : extent * ar
        let h = ar >= 1 ? extent / ar : extent
        let plane = SCNPlane(width: w, height: h)
        let mat = SCNMaterial()
        mat.diffuse.contents = image
        mat.isDoubleSided = true
        mat.lightingModel = .constant      // unlit — show the image as-is
        mat.writesToDepthBuffer = false
        mat.readsFromDepthBuffer = false    // chrome — see the doc comment
        plane.firstMaterial = mat

        let node = SCNNode(geometry: plane)
        node.renderingOrder = overlayOrder  // ONE tier for every visible part
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
    // NOTE: `.box` fill opacity is no longer a constant here — it is
    // per-overlay (`RNISAROverlay.fillAlpha`, already sanitised to 0...1 by
    // the model's init).  The old hardcoded 0.22 now lives as
    // `RNISAROverlay.defaultFillAlpha`, so a JS overlay that omits the key
    // still fills at exactly 22%.

    // MARK: - Depth participation (box-vs-box occlusion) — PER-OVERLAY OPT-IN
    //
    // The scheme below is gated on the overlay's `depthOcclusion` flag
    // (default false).  A `.box` that does NOT opt in renders with the
    // LEGACY pipeline exactly as every pre-`depthOcclusion` build drew it:
    // no depth writer, no depth reads, fill at `legacyFillOrder` under
    // edges at `legacyChromeOrder`, and no stroke offset — including the
    // historical artifact that a box further back can draw its stroke over
    // a nearer box's fill.  That artifact is precisely what the opt-in
    // fixes; keeping the default at the legacy pipeline means no existing
    // public consumer's boxes change appearance without asking.
    //
    // LEGACY (and the `depthOcclusion:false` path today): every overlay
    // material had `readsFromDepthBuffer = false` AND
    // `writesToDepthBuffer = false`, and the parts of a box carried THREE
    // different `renderingOrder`s (999 fill / 1000 edges / 1000 label).
    // `renderingOrder` is GLOBAL, not per-node-tree, so a box 10 cm BEHIND
    // another drew its stroke (1000) straight over the near box's fill (999)
    // at full alpha — overlapping world-anchored boxes were unreadable.
    //
    // OPT-IN (`depthOcclusion:true`): a two-tier scheme.
    //
    //   tier `depthWriterOrder` — one INVISIBLE, colour-masked plane per
    //       `.box`, sitting `occluderSetbackM` BEHIND the box along its own
    //       normal.  It writes depth and nothing else.
    //   tier `overlayOrder`    — EVERY visible part of EVERY box (fill,
    //       stroke, badge) at ONE value, reading depth, writing none.  With
    //       a single value SceneKit's own back-to-front transparent sort is
    //       the only thing that orders them, so "far box's stroke over near
    //       box's fill" is structurally impossible.
    //
    // Why a separate SET-BACK writer rather than simply turning
    // `writesToDepthBuffer` on for the fill:
    //
    //   Boxes marking objects on one surface are COPLANAR.  Two coplanar
    //   translucent fills that both write depth z-fight — half the overlap
    //   pixels blend twice and half once, which reads as a moiré wash in the
    //   SAME colour, i.e. dirt rather than depth.  With the writer set back
    //   3 cm, a coplanar neighbour is always IN FRONT of every writer and
    //   always draws.  Only something more than `occluderSetbackM` behind is
    //   culled — the genuinely-behind case the scheme exists for, with
    //   comfortable margin over typical plane-fit residuals (~1 cm).
    //
    // Why the writer is PARALLEL to the geometry it guards (and not, say, a
    // camera-facing plane at the centroid): a quad seen at θ off-axis spans
    // a RANGE of depths — 0.15 m of quad at 45° spans 10.6 cm, far more than
    // the 3 cm setback.  A view-facing writer has one uniform depth, so its
    // near half would sit BEHIND the box's far half and cull it: the box
    // would lose its far edge exactly when viewed off-axis.  A writer built
    // from the same corners, pushed along the quad's own normal, holds the
    // same 3 cm gap at every point of the quad however oblique the view, and
    // its footprint is the box's footprint exactly (no over-occlusion).
    //
    // The normal's SIGN comes from the camera at node-build time
    // (`QuadBasis.front`), because corner winding is the producer's
    // business, not ours.  Two guards make a stale sign harmless:
    //   * no camera direction (`pointOfView` nil) ⇒ NO writer at all.  No
    //     occlusion is strictly better than a writer that might sit in front
    //     of its own box and erase it.
    //   * a quad more than ~75° off head-on (`frontCos` ≤ `minWriterFrontCos`)
    //     ⇒ no writer.  There the 3 cm normal offset projects to under ~8 mm
    //     of depth and the sign is numerically unstable, while the box
    //     itself covers almost no screen area.
    // Beyond that a stale sign needs the viewer to cross to the far side of
    // the quad's plane between node rebuilds.
    //
    // NOT real-world occlusion: with `sceneReconstruction` off there is no
    // scene mesh, and a hand or a passer-by will NOT hide a box.  Only
    // overlay-vs-overlay is occluded.
    //
    // `.outline` overlays deliberately stay OUT of the depth scheme entirely
    // — no writer, depth read off — so a guidance/reticle affordance can
    // never be hidden by the boxes it is guiding.  Badge images and labels
    // likewise keep depth read OFF: they are chrome, they are small, and a
    // billboarded badge intersects the plane it annotates at a grazing
    // angle, so depth-reading it would clip the badge in half rather than
    // occlude it.
    //
    // MIXED SCENES: occlusion is strictly BETWEEN opted-in boxes.  A
    // non-opted-in box writes no depth (it cannot occlude an opted-in box)
    // and reads none (opted-in writers cannot occlude it) — the flag is a
    // pure per-overlay property with no action at a distance on overlays
    // that did not set it.
    private static let depthWriterOrder = 999
    private static let overlayOrder = 1001
    /// Legacy per-part tiers for a `.box` that has NOT opted into depth
    /// occlusion (`depthOcclusion` absent/false — every pre-existing public
    /// consumer): fill under edges, exactly the pre-`depthOcclusion`
    /// pipeline.  `legacyFillOrder` numerically equals `depthWriterOrder`
    /// by historical accident; the two never interact because writers exist
    /// only for opted-in boxes and are opaque-pass, while the legacy fill
    /// neither reads nor writes depth.
    private static let legacyFillOrder = 999
    private static let legacyChromeOrder = 1000
    /// How far behind a box its depth writer sits, along the quad normal, in
    /// metres.  A box further back than this is occluded; anything within it
    /// (a coplanar neighbour, plane-fit residual) still draws.
    private static let occluderSetbackM: Float = 0.03
    /// Minimum |cos| between the quad normal and the view before a writer is
    /// emitted at all (≈75° off head-on).  Below it the projected depth gap
    /// falls under ~8 mm and the normal's sign is numerically unstable.
    private static let minWriterFrontCos: Float = 0.25
    /// Separation between a box's stacked layers (fill → stroke → badge).
    /// 0.5 mm is fine at a 1 m stand-off but falls under a depth-buffer
    /// quantum at very close range, where the layers could sort arbitrarily;
    /// 1.5 mm holds at both.
    private static let layerGapM: Float = 0.0015

    /// The in-plane basis of a quad, plus its extents in that basis.
    /// `front` is the quad's own normal FLIPPED to point at the camera when a
    /// camera direction is known, so a caller can offset "towards the viewer"
    /// without depending on the producer's corner winding.
    private struct QuadBasis {
        let right: simd_float3
        let up: simd_float3
        let front: simd_float3
        /// |cos| between the quad normal and the camera direction — 0 when no
        /// camera direction was supplied, so `front`'s sign is untrustworthy.
        let frontCos: Float
        let minR: Float
        let minU: Float
        let width: Float
        let height: Float
    }

    /// Build `QuadBasis` for a set of relative corners.  `up` is world-up
    /// projected into the quad's plane (so "bottom-left" is what the VIEWER
    /// sees, not what the corner ordering says); a quad lying in the
    /// horizontal plane has no world-up component to project, so it falls
    /// back to an in-plane edge rather than dividing by ~0.  Returns nil for
    /// a degenerate quad (fewer than 3 corners, or collinear corners →
    /// zero/NaN normal).
    private static func quadBasis(
        relCorners: [simd_float3], camDir: simd_float3?
    ) -> QuadBasis? {
        let n = relCorners.count
        guard n >= 3 else { return nil }
        let e1 = relCorners[1] - relCorners[0]
        let e2 = relCorners[2] - relCorners[0]
        let cross = simd_cross(e1, e2)
        let crossLen = simd_length(cross)
        guard crossLen.isFinite, crossLen > 1e-9 else { return nil }
        let normal = cross / crossLen
        let worldUp = simd_float3(0, 1, 0)
        var up = worldUp - normal * simd_dot(worldUp, normal)
        if simd_length(up) < 1e-5 {
            let alt = e2 - normal * simd_dot(e2, normal)
            guard simd_length(alt) > 1e-9 else { return nil }
            up = simd_normalize(alt)
        } else {
            up = simd_normalize(up)
        }
        let right = simd_normalize(simd_cross(up, normal))
        guard right.x.isFinite, up.x.isFinite else { return nil }
        var front = normal
        var frontCos: Float = 0
        if let cam = camDir {
            let d = simd_dot(front, cam)
            if d < 0 { front = -front }
            frontCos = abs(d)
            if !frontCos.isFinite { frontCos = 0 }
        }

        var minR = Float.greatestFiniteMagnitude
        var maxR = -Float.greatestFiniteMagnitude
        var minU = Float.greatestFiniteMagnitude
        var maxU = -Float.greatestFiniteMagnitude
        for v in relCorners {
            let r = simd_dot(v, right), u = simd_dot(v, up)
            minR = min(minR, r); maxR = max(maxR, r)
            minU = min(minU, u); maxU = max(maxU, u)
        }
        let w = maxR - minR, h = maxU - minU
        guard w.isFinite, h.isFinite else { return nil }
        return QuadBasis(
            right: right, up: up, front: front, frontCos: frontCos,
            minR: minR, minU: minU, width: w, height: h)
    }

    /// The material every depth writer shares: writes depth, paints nothing.
    ///
    /// Deliberately OPAQUE (`blendMode = .replace`, alpha 1) even though it
    /// paints nothing: SceneKit renders the opaque pass before the
    /// transparent pass, so an opaque writer is guaranteed to precede the
    /// translucent geometry it must occlude — belt AND braces alongside the
    /// lower `renderingOrder`.  A transparent writer would be sorted amongst
    /// the very fills it exists to gate.
    private static func depthWriterMaterial() -> SCNMaterial {
        let mat = SCNMaterial()
        mat.diffuse.contents = UIColor.black
        mat.lightingModel = .constant
        mat.isDoubleSided = true
        mat.colorBufferWriteMask = []      // depth only — paints no pixels
        mat.blendMode = .replace           // ⇒ classified opaque, drawn first
        mat.writesToDepthBuffer = true
        mat.readsFromDepthBuffer = true    // a far writer must not clobber a near one
        return mat
    }

    /// Depth writer for a PLANE-ORIENTED quad: the same polygon as the fill,
    /// pushed `occluderSetbackM` along the quad's own normal, away from the
    /// camera.  Parallel to the fill by construction, so the depth gap is the
    /// same at every point of the quad no matter how oblique the view.
    /// Returns nil when the basis is missing or too edge-on to trust (see
    /// `minWriterFrontCos`) — the box then simply does not occlude.
    private static func depthWriterQuadNode(
        relCorners: [simd_float3], basis: QuadBasis
    ) -> SCNNode? {
        guard basis.frontCos > minWriterFrontCos else { return nil }
        guard let geom = quadGeometry(relCorners: relCorners) else { return nil }
        geom.firstMaterial = depthWriterMaterial()
        let node = SCNNode(geometry: geom)
        node.renderingOrder = depthWriterOrder
        node.simdPosition = -basis.front * occluderSetbackM
        return node
    }

    /// Depth writer for the GRAVITY-UP/YAW-TO-CAMERA box: a plane of the
    /// box's own size at local −Z.  The parent's constraint keeps the box's
    /// plane and this writer parallel, so the same "uniform gap" property
    /// holds without needing a normal sign at all.
    private static func depthWriterPlaneNode(
        width: CGFloat, height: CGFloat
    ) -> SCNNode {
        let plane = SCNPlane(width: max(width, 0.001), height: max(height, 0.001))
        plane.firstMaterial = depthWriterMaterial()
        let node = SCNNode(geometry: plane)
        node.renderingOrder = depthWriterOrder
        node.simdPosition = simd_float3(0, 0, -occluderSetbackM)
        return node
    }

    /// Fan-triangulated geometry for a quad's corners (shared by the fill and
    /// its depth writer, so the two can never disagree about the shape).
    private static func quadGeometry(relCorners: [simd_float3]) -> SCNGeometry? {
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
        return SCNGeometry(sources: [source], elements: [element])
    }

    /// A GRAVITY-UP, YAW-TO-CAMERA box for a `.box` `worldQuad` overlay with
    /// `orient:'camera'`.  Sized by the quad's OWN edge lengths (width/height
    /// in metres, orientation-independent) and centred at the anchor (the
    /// quad centroid).
    ///
    /// THIS IS THE FALLBACK ORIENTATION, not the primary one.  It exists for
    /// a quad whose corners are NOT yet on a reliably fitted plane.  When
    /// the corners do come from a real plane, the overlay should be sent as
    /// `orient:'plane'` and drawn by `makeQuadOutlineNode`, where
    /// orientation is implicit in the corners and the box foreshortens by
    /// cos θ like the surface it marks.
    ///
    /// The billboard constraint frees ONLY the yaw axis (`.Y`), NOT `.all`:
    /// a full billboard matches the camera's orientation on all three axes,
    /// so it also copies the camera's ROLL — tilt the device and every box
    /// tilts with it.  With `.Y` the box turns to face the viewer while its
    /// up vector stays the AR world's +Y, which is gravity under the default
    /// `.gravity` world alignment — "camera-facing + screen-upright".
    ///
    /// It does NOT foreshorten: a box that always turns to face the viewer
    /// always presents its full metric width, so at θ off-axis it covers
    /// 1/cos θ of what the marked object covers (1.41× at 45°).  Only the
    /// plane path foreshortens.  That is why this is the fallback.
    private static func makeBillboardBoxNode(
        relCorners: [simd_float3],
        color: UIColor,
        label: String?,
        fillAlpha: CGFloat,
        strokeAlpha: CGFloat,
        imageUri: String?,
        depthOcclusion: Bool = false
    ) -> SCNNode {
        // Box dims from the quad's own in-plane basis: the edge lengths are
        // the metric width/height whatever the quad's orientation, so the box
        // is the right size even when the source plane is edge-on.  (Same
        // basis the badge placement below uses.)  A degenerate quad yields no
        // basis → fall back to the default marker extent rather than a
        // NaN-sized plane.
        let basis = quadBasis(relCorners: relCorners, camDir: nil)
        var w = CGFloat(basis?.width ?? 0)
        var h = CGFloat(basis?.height ?? 0)
        if !(w > 0.0001) { w = RNISAROverlay.defaultMarkerExtent }
        if !(h > 0.0001) { h = RNISAROverlay.defaultMarkerExtent }

        // Parent node: yaws to face the camera, stays gravity-upright.
        // SceneKit re-orients it every frame at render rate; the anchor world
        // position is fixed, so there is no per-frame node churn (the whole
        // point of a stable world-anchored overlay).
        let node = SCNNode()
        node.renderingOrder = overlayOrder
        let billboard = SCNBillboardConstraint()
        // NOT `.all`: `.all` copies the camera's roll onto the box.
        billboard.freeAxes = .Y
        node.constraints = [billboard]

        // Depth writer — `occluderSetbackM` behind, so a box further back
        // than that is genuinely occluded instead of drawing over this one.
        // Parallel to the box because the parent's constraint rotates both.
        // Opt-in only (`depthOcclusion`): a non-opted-in box neither
        // occludes nor is occluded.
        if depthOcclusion {
            node.addChildNode(depthWriterPlaneNode(width: w, height: h))
        }

        // Translucent fill (behind the outline), matching the plane-oriented
        // box.
        if fillAlpha > 0 {
            let plane = SCNPlane(width: w, height: h)
            let mat = SCNMaterial()
            mat.diffuse.contents = color.withAlphaComponent(fillAlpha)
            mat.isDoubleSided = true
            mat.lightingModel = .constant
            mat.writesToDepthBuffer = false     // writers own the depth buffer
            mat.readsFromDepthBuffer = depthOcclusion
            plane.firstMaterial = mat
            let fillNode = SCNNode(geometry: plane)
            fillNode.renderingOrder = overlayOrder
            node.addChildNode(fillNode)
        }
        // Stroked outline — CONSTANT-WORLD-THICKNESS bars (≈3 mm), NOT a
        // texture stroke scaled to the box.  A proportional stroke collapses
        // to sub-millimetre (and vanishes) on a small or distant box; four
        // thin billboard-plane bars hold a fixed 3 mm edge at EVERY box size.
        if strokeAlpha > 0 {
            let strokeColor = strokeAlpha >= 1 ? color : color.withAlphaComponent(strokeAlpha)
            let t: CGFloat = 0.003  // ~3mm world, scale/size-independent
            func addBar(_ bw: CGFloat, _ bh: CGFloat, _ dx: CGFloat, _ dy: CGFloat) {
                let bar = SCNPlane(width: max(bw, t), height: max(bh, t))
                let mat = SCNMaterial()
                mat.diffuse.contents = strokeColor
                mat.isDoubleSided = true
                mat.lightingModel = .constant
                mat.writesToDepthBuffer = false  // writers own the depth buffer
                mat.readsFromDepthBuffer = depthOcclusion
                bar.firstMaterial = mat
                let barNode = SCNNode(geometry: bar)
                barNode.simdPosition = simd_float3(Float(dx), Float(dy), layerGapM)
                barNode.renderingOrder = overlayOrder
                node.addChildNode(barNode)
            }
            addBar(w, t, 0, (h - t) / 2)    // top
            addBar(w, t, 0, -(h - t) / 2)   // bottom
            addBar(t, h, -(w - t) / 2, 0)   // left
            addBar(t, h, (w - t) / 2, 0)    // right
        }
        // Badge image bottom-left INSIDE the box.  The parent faces the
        // camera, so local −X/−Y is screen bottom-left; same proportional
        // sizing as the plane-oriented path (≈26% of the shorter side,
        // clamped).
        if let uri = imageUri, w > 0.012, h > 0.012, let img = badgeImage(uri) {
            let extent = min(max(min(w, h) * 0.26, 0.004), 0.05)
            let pad = Float(extent) * 0.25
            let badge = makeBadgeImageNode(image: img, extent: extent)
            badge.simdPosition = simd_float3(
                Float(-w / 2) + Float(extent) / 2 + pad,
                Float(-h / 2) + Float(extent) / 2 + pad,
                2 * layerGapM)
            node.addChildNode(badge)
        } else if let label = label, !label.isEmpty {
            let labelNode = makeBillboardNode(
                sizeMeters: CGSize(width: 0.12, height: 0.12),
                color: color, label: label)
            node.addChildNode(labelNode)
        }
        return node
    }

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
        shape: RNISAROverlay.Shape,
        fillAlpha: CGFloat = RNISAROverlay.defaultFillAlpha,
        strokeAlpha: CGFloat = RNISAROverlay.defaultStrokeAlpha,
        imageUri: String? = nil,
        camDir: simd_float3? = nil,
        depthOcclusion: Bool = false
    ) -> SCNNode {
        let node = SCNNode()
        node.renderingOrder = overlayOrder
        let radius = shape == .box ? boxEdgeRadius : outlineEdgeRadius
        let n = relCorners.count
        // Depth participation is for `.box` only, and ONLY when the overlay
        // opted in (`depthOcclusion`).  `.outline` is a guidance affordance
        // that must never be hidden by the boxes it is guiding, so it
        // neither writes depth (no writer) nor reads it; a non-opted-in box
        // renders with the LEGACY pipeline (no writer, no depth reads,
        // legacy per-part tiers, no stroke offset) so pre-existing
        // consumers' boxes draw exactly as before this scheme existed.
        let isBox = shape == .box
        let participatesInDepth = isBox && depthOcclusion
        // In-plane basis + the quad normal SIGNED towards the camera, so
        // "1.5 mm in front of the fill" has an unambiguous direction that
        // does not depend on the producer's corner winding.
        let basis = quadBasis(relCorners: relCorners, camDir: camDir)
        let front = basis?.front ?? simd_float3(0, 0, 0)
        // Depth writer FIRST (order within a parent is irrelevant — the tiers
        // are what sequence the draw — but it keeps the intent adjacent to
        // the geometry it gates).  nil ⇒ no camera direction or too edge-on
        // to trust the normal's sign; the box then does not occlude, which is
        // the safe direction of that failure.
        if participatesInDepth, let b = basis,
           let writer = depthWriterQuadNode(relCorners: relCorners, basis: b) {
            node.addChildNode(writer)
        }
        if isBox,
           let fill = quadFillNode(
               relCorners: relCorners, color: color, fillAlpha: fillAlpha,
               depthRead: participatesInDepth,
               renderingOrder: participatesInDepth
                   ? overlayOrder : legacyFillOrder) {
            node.addChildNode(fill)
        }
        // strokeAlpha == 0 ⇒ FILL-ONLY: emit no edge geometry at all (not
        // just transparent edges) so a tiled set of adjacent quads reads as
        // ONE continuous region with no internal seams — and so N quads cost
        // N fewer × 4 SCNNodes.  Default 1 keeps the historical opaque
        // outline.
        if strokeAlpha > 0 {
            let edgeColor = strokeAlpha >= 1
                ? color : color.withAlphaComponent(strokeAlpha)
            // Nudged `layerGapM` towards the viewer — OPT-IN BOXES ONLY:
            // there, fill and stroke share ONE renderingOrder, so their draw
            // order is decided purely by SceneKit's back-to-front transparent
            // sort and a coplanar stroke would tie with the fill and could be
            // drawn under it (picking up the fill's tint); 1.5 mm settles the
            // tie at every stand-off.  A legacy box (and every `.outline`)
            // keeps the un-offset legacy geometry: its edges draw after its
            // fill by TIER (`legacyChromeOrder` > `legacyFillOrder`), exactly
            // as before, so no tie-break is needed.
            let edgeOffset = participatesInDepth
                ? front * layerGapM : simd_float3(0, 0, 0)
            let edgeOrder = (isBox && !participatesInDepth)
                ? legacyChromeOrder : overlayOrder
            for i in 0..<n {
                if let edge = edgeCylinder(
                    from: relCorners[i], to: relCorners[(i + 1) % n],
                    color: edgeColor, radius: radius,
                    depthRead: participatesInDepth, offset: edgeOffset,
                    renderingOrder: edgeOrder) {
                    node.addChildNode(edge)
                }
            }
        }
        // A badge image REPLACES the centroid text label: a chip over the
        // middle of the box would cover exactly what the box marks.  Drawn
        // inside the quad at its BOTTOM-LEFT, inset.
        if let uri = imageUri, let b = basis, let img = badgeImage(uri) {
            // Plane basis from world-up projected into the quad's plane, so
            // "bottom-left" is what the VIEWER sees and does not depend on
            // the producer's corner ordering.  Computed once at the top of
            // this function (`quadBasis`) and shared with the depth writer
            // and the stroke offset, rather than recomputed here.
            let right = b.right, up = b.up
            let minR = b.minR, minU = b.minU
            let qw = CGFloat(b.width), qh = CGFloat(b.height)
            // Skip only a DEGENERATE quad — a small box still gets a small
            // badge.  (A larger cutoff would suppress the badge on every
            // near-minimum-size box, i.e. most of them at close range.)
            if qw > 0.012, qh > 0.012 {
                // Proportional BADGE — NOT an absolute floor.  An absolute
                // floor can be half of a small box and cover it; ~26% of the
                // shorter side reads the same on a tiny quad and a 15 cm one.
                // The tiny floor only avoids a zero-size plane, the cap only
                // stops a huge quad's badge dwarfing the feed.
                let extent = min(max(min(qw, qh) * 0.26, 0.004), 0.05)
                let pad = Float(extent) * 0.25
                let badge = makeBadgeImageNode(image: img, extent: extent)
                // `front * 2 * layerGapM` — one tier above the stroke in the
                // transparent sort, for the same tie-break reason as the
                // stroke.
                badge.simdPosition =
                    right * (minR + Float(extent) / 2 + pad)
                    + up * (minU + Float(extent) / 2 + pad)
                    + front * (2 * layerGapM)
                node.addChildNode(badge)
            }
        } else if let label = label, !label.isEmpty {
            // Label at the centroid (≈ local origin in relative space).
            let labelNode = makeBillboardNode(
                sizeMeters: CGSize(width: 0.12, height: 0.12),
                color: color, label: label)
            node.addChildNode(labelNode)
        }
        return node
    }

    /// The translucent face of a `.box` quad: the polygon fan-triangulated
    /// about corner 0 (corners arrive in loop order from the producer).
    /// Double-sided so the fill reads from either side of the plane.  For an
    /// OPT-IN (`depthOcclusion`) box it READS depth (so a box behind another
    /// opted-in box's writer is culled) but never WRITES it — the box's own
    /// depth writer, 3 cm back, owns that.  A legacy box's fill neither
    /// reads nor writes depth, exactly as before the scheme existed.
    private static func quadFillNode(
        relCorners: [simd_float3], color: UIColor, fillAlpha: CGFloat,
        depthRead: Bool, renderingOrder: Int
    ) -> SCNNode? {
        guard let geom = quadGeometry(relCorners: relCorners) else { return nil }
        let mat = SCNMaterial()
        // `fillAlpha` REPLACES any alpha carried by the overlay colour (the
        // colour channel drives hue only) — same rule as Android, which masks
        // the colour's alpha out.  Callers pass `RNISAROverlay.fillAlpha`,
        // which the model's init already sanitised to 0...1.
        mat.diffuse.contents = color.withAlphaComponent(fillAlpha)
        mat.lightingModel = .constant
        mat.isDoubleSided = true
        mat.writesToDepthBuffer = false     // the box's depth writer owns depth
        mat.readsFromDepthBuffer = depthRead
        geom.firstMaterial = mat
        let node = SCNNode(geometry: geom)
        // Caller-selected tier.  Opt-in box: `overlayOrder` — ONE
        // renderingOrder for every visible part of every opted-in box
        // (`renderingOrder` is GLOBAL, so "under my edges" also means "under
        // a completely different box's edges"; ordering within a box is the
        // geometric `layerGapM` offset plus SceneKit's transparent sort, and
        // ordering BETWEEN boxes is the depth buffer).  Legacy box:
        // `legacyFillOrder` — the historical under-the-edges tier, kept
        // byte-for-byte so non-opted-in consumers see the pre-scheme
        // rendering, warts and all.
        node.renderingOrder = renderingOrder
        return node
    }

    /// A thin cylinder spanning two points — one edge of a quad outline.
    /// SCNCylinder's axis is +Y, so we centre it at the midpoint and
    /// rotate +Y onto the edge direction.
    private static func edgeCylinder(
        from a: simd_float3, to b: simd_float3, color: UIColor,
        radius: CGFloat, depthRead: Bool, offset: simd_float3,
        renderingOrder: Int
    ) -> SCNNode? {
        let d = b - a
        let len = simd_length(d)
        guard len > 1e-5 else { return nil }
        let cyl = SCNCylinder(radius: radius, height: CGFloat(len))
        let mat = SCNMaterial()
        mat.diffuse.contents = color
        mat.lightingModel = .constant
        mat.writesToDepthBuffer = false     // the box's depth writer owns depth
        mat.readsFromDepthBuffer = depthRead
        cyl.firstMaterial = mat
        let node = SCNNode(geometry: cyl)
        // Caller-selected tier: `overlayOrder` for opt-in boxes and
        // `.outline`s, `legacyChromeOrder` for a legacy box's edges (the
        // historical over-the-fill tier).
        node.renderingOrder = renderingOrder
        node.simdPosition = (a + b) * 0.5 + offset
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

