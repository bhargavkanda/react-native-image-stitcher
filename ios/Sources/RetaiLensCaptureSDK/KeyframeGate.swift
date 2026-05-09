// SPDX-License-Identifier: UNLICENSED
//
// KeyframeGate — Phase 0 of the iOS/Samsung-quality panorama redesign
// (V16).  Replaces the slit-scan engine's static 2 fps frame stream
// with iOS-Camera-style "accept a frame only when ≥X% of its content
// is NEW" gating, capped at a small bounded number of keyframes.
//
// Why this matters:
//   - Bounds the engine's input set to ≤6 frames per capture →
//     bounded memory, no OOM at long pans.
//   - Each accepted neighbor pair has 50–60% overlap (vs slit-scan's
//     ~95%) → thousands of strong feature correspondences for the
//     stitcher's bundle adjuster + ExposureCompensator + multi-band
//     blender to operate on.
//   - Matches the architecture iOS Camera and Samsung Pano use; the
//     reason their output is so much better than ours is that they
//     stitch ~5 distinct keyframes, not a 60-frame video stream.
//
// How "new content" is measured:
//   For each frame, project its 4 image-corner rays through the
//   camera pose onto the latched ARKit plane to get 4 world-space
//   points.  Convert to 2D plane-local (u, v) using the plane's
//   tangent basis.  Compute polygon overlap with the previous
//   accepted keyframe via Sutherland-Hodgman (both quads are convex
//   so the result is always convex).  new_content_fraction =
//   1 − intersection_area / current_frame_area.
//
//   This metric is invariant to motion type — pure rotation, pure
//   translation, user stepping closer/farther, diagonal pans — all
//   collapse to a single overlap percentage.
//
// AR plane is required:
//   Without an ARKit plane there's no shared metric coordinate frame
//   for comparing two frames' footprints.  When no plane is latched,
//   the gate degrades silently to "always accept" — the underlying
//   engine's existing time/pose-based gates take over.
//
// First / last frame:
//   - First frame is always accepted unconditionally (anchors the
//     reference polygon for everything that follows).
//   - When the host calls `markNextFrameAsLast()` (typically on
//     shutter release), the next frame is force-accepted regardless
//     of overlap — guarantees we don't truncate the right edge of
//     the scan if the user releases before pan reaches a 50%-new-
//     content boundary.

import Foundation
import simd
import os.log

/// Gate decision returned for each ARFrame.  Caller checks `accept`;
/// the rest of the fields are for telemetry / state events.
struct KeyframeGateDecision {
    let accept: Bool
    /// Short reason string for fault-level logging and JS telemetry.
    let reason: String
    /// Computed new-content fraction in [0, 1].  -1.0 if not computed
    /// (gate disabled, force-first/last, no plane available).
    let newContentFraction: Double
    /// Keyframes accepted so far (including this one if accept=true).
    let acceptedCount: Int
    /// Max keyframes for the capture (0 if gate disabled).
    let maxCount: Int
}

/// In-plane orthonormal basis derived from an ARKit plane transform.
/// Used to convert world-space points to 2D plane-local (u, v) so we
/// can reason about polygon area on the plane in metres.
struct PlaneBasis {
    let origin: simd_float3
    /// Plane surface normal (pointing AWAY from the wall, toward camera).
    let normal: simd_float3
    /// In-plane tangent — "right" along the wall, in metres.
    let tangentU: simd_float3
    /// In-plane tangent — "up" along the wall (right-handed: normal × U).
    let tangentV: simd_float3

    /// ARKit ARPlaneAnchor convention: column 0 = tangent X, column 1 =
    /// surface normal, column 2 = tangent Z, column 3 = origin.
    /// Returns nil for a degenerate matrix.
    init?(transform: simd_float4x4) {
        let n = simd_make_float3(transform.columns.1)
        let u = simd_make_float3(transform.columns.0)
        let o = simd_make_float3(transform.columns.3)
        let nLen = simd_length(n)
        let uLen = simd_length(u)
        guard nLen > 1e-6, uLen > 1e-6 else { return nil }
        let nN = n / nLen
        let uN = u / uLen
        // Re-derive V from N × U so the basis is strictly orthonormal
        // even if ARKit's column 2 has drifted.  Right-handed.
        let v = simd_cross(nN, uN)
        let vLen = simd_length(v)
        guard vLen > 1e-6 else { return nil }
        self.origin = o
        self.normal = nN
        self.tangentU = uN
        self.tangentV = v / vLen
    }

    /// Project a world-space point onto plane-local 2D coords (metres).
    func worldToLocal(_ p: simd_float3) -> SIMD2<Float> {
        let d = p - origin
        return SIMD2<Float>(simd_dot(d, tangentU), simd_dot(d, tangentV))
    }
}

final class KeyframeGate {
    // MARK: Settings (set on start)

    /// True when frameSelectionMode == "pose-based".  When false,
    /// every evaluate() returns accept=true (gate is a passthrough).
    var enabled: Bool = false

    /// Required new-content fraction (0…1).  A frame is accepted only
    /// when its projection onto the plane has at least this fraction
    /// of area outside the last keyframe's projection.  Default 0.4
    /// (40% new content → ~4–5 keyframes for a 90° landscape pan).
    var overlapThreshold: Double = 0.4

    /// Hard cap on keyframes per capture.  Once reached, all further
    /// frames are rejected (except the force-last on shutter release).
    /// Default 6 (matches Samsung's behaviour).
    var maxCount: Int = 6

    // MARK: State (reset on start / cancel)

    /// Number of keyframes accepted so far (includes first / last
    /// force-accepts).  Surfaced to JS for the "Keyframes: 3/6" pill.
    private(set) var acceptedCount: Int = 0

    /// Last accepted keyframe's 4 corners on the plane, in 2D plane-
    /// local coordinates (metres).  CCW winding is enforced before
    /// polygon clipping so the order at population time doesn't matter.
    private var lastCornersOnPlane: [SIMD2<Float>]?

    /// Plane basis cached at first-frame accept.  All subsequent
    /// frames are projected onto THIS basis — using a refreshed plane
    /// would invalidate the stored polygon.  ARKit may continue to
    /// refine the plane mid-capture but we don't follow those updates
    /// (RetaiLensARSession latches the plane anyway).
    private var planeForCapture: PlaneBasis?

    /// When true, the next evaluate() call accepts unconditionally and
    /// resets the flag.  Set by `markNextFrameAsLast()` from the JS
    /// shutter-release path so the trailing edge of the scan isn't
    /// truncated.
    var forceAcceptNext: Bool = false

    // MARK: Logging

    private static let log = OSLog(
        subsystem: "com.tiger.retailens.sdk",
        category: "keyframe"
    )

    // MARK: Public API

    func reset() {
        acceptedCount = 0
        lastCornersOnPlane = nil
        planeForCapture = nil
        forceAcceptNext = false
    }

    /// Decide whether to accept this ARFrame as a keyframe.
    ///
    /// - Parameters:
    ///   - pose: pose for the frame about to be ingested.
    ///   - latchedPlane: ARKit plane transform if one is latched, else
    ///     nil.  When nil, the gate accepts everything (we can't
    ///     compute a metric overlap without a shared plane).
    /// - Returns: a decision struct with `accept`, telemetry, and the
    ///   updated counters.
    func evaluate(
        pose: RetaiLensARFramePose,
        latchedPlane: simd_float4x4?
    ) -> KeyframeGateDecision {
        // Mode disabled → always pass through.
        guard enabled else {
            return KeyframeGateDecision(
                accept: true, reason: "gate-disabled",
                newContentFraction: -1.0,
                acceptedCount: 0, maxCount: 0
            )
        }

        // Force-accept on shutter release.
        if forceAcceptNext {
            forceAcceptNext = false
            // Update the polygon state too, in case the engine ingests
            // more frames after this (rare but possible if the user
            // taps shutter→hold quickly).
            if let basis = planeForCapture ?? latchedPlane.flatMap(PlaneBasis.init(transform:)),
               let corners = projectCornersOntoPlane(pose: pose, plane: basis) {
                lastCornersOnPlane = corners
                if planeForCapture == nil { planeForCapture = basis }
            }
            acceptedCount += 1
            os_log(.fault, log: Self.log,
                   "[V16-keyframe] FORCE-LAST accepted (#%d/%d)",
                   acceptedCount, maxCount)
            return KeyframeGateDecision(
                accept: true, reason: "force-last",
                newContentFraction: -1.0,
                acceptedCount: acceptedCount, maxCount: maxCount
            )
        }

        // First-frame anchor — always accepted.
        if acceptedCount == 0 {
            if let planeMat = latchedPlane,
               let basis = PlaneBasis(transform: planeMat),
               let corners = projectCornersOntoPlane(pose: pose, plane: basis) {
                planeForCapture = basis
                lastCornersOnPlane = corners
                acceptedCount = 1
                os_log(.fault, log: Self.log,
                       "[V16-keyframe] FIRST keyframe anchored (#1/%d) on plane (%d corners)",
                       maxCount, corners.count)
                return KeyframeGateDecision(
                    accept: true, reason: "first-anchored-on-plane",
                    newContentFraction: -1.0,
                    acceptedCount: 1, maxCount: maxCount
                )
            } else {
                // No plane yet — accept first frame unconditionally.
                // Subsequent frames will see no cached polygon and
                // fall through the no-plane branch below ("accept all").
                acceptedCount = 1
                os_log(.fault, log: Self.log,
                       "[V16-keyframe] FIRST keyframe accepted but NO PLANE — gate disengaged for capture")
                return KeyframeGateDecision(
                    accept: true, reason: "first-no-plane",
                    newContentFraction: -1.0,
                    acceptedCount: 1, maxCount: maxCount
                )
            }
        }

        // No plane cached → can't compute overlap → pass through (the
        // engine's own gate decides).  Counter stays at 1 because we
        // never finished anchoring on a plane; max is effectively
        // disengaged for this capture.
        guard let basis = planeForCapture,
              let lastCorners = lastCornersOnPlane else {
            // Don't increment acceptedCount past 1 — we never engaged
            // gating, so JS pill shouldn't tick up.
            return KeyframeGateDecision(
                accept: true, reason: "no-plane-pass-through",
                newContentFraction: -1.0,
                acceptedCount: 1, maxCount: maxCount
            )
        }

        // Cap reached.
        if acceptedCount >= maxCount {
            os_log(.fault, log: Self.log,
                   "[V16-keyframe] REJECT max-reached (%d/%d)",
                   acceptedCount, maxCount)
            return KeyframeGateDecision(
                accept: false, reason: "max-reached",
                newContentFraction: -1.0,
                acceptedCount: acceptedCount, maxCount: maxCount
            )
        }

        // Project current frame onto the cached plane.
        guard let currentCorners = projectCornersOntoPlane(pose: pose, plane: basis) else {
            // Frame's optical axis is parallel to the plane (or behind
            // it).  Can't gate; accept silently.
            return KeyframeGateDecision(
                accept: true, reason: "projection-degenerate",
                newContentFraction: -1.0,
                acceptedCount: acceptedCount, maxCount: maxCount
            )
        }

        // Polygon overlap on the plane (metres²).
        let intersectArea = polygonIntersectionArea(
            subject: currentCorners,
            clip: lastCorners
        )
        let currentArea = polygonArea(currentCorners)
        guard currentArea > 1e-6 else {
            // Degenerate quad — accept and skip gating this round.
            return KeyframeGateDecision(
                accept: true, reason: "current-area-zero",
                newContentFraction: -1.0,
                acceptedCount: acceptedCount, maxCount: maxCount
            )
        }
        let overlapFraction = Double(min(max(intersectArea / currentArea, 0.0), 1.0))
        let newContentFraction = 1.0 - overlapFraction

        if newContentFraction < overlapThreshold {
            os_log(.fault, log: Self.log,
                   "[V16-keyframe] REJECT overlap-too-high newContent=%.3f thr=%.3f (%d/%d)",
                   newContentFraction, overlapThreshold, acceptedCount, maxCount)
            return KeyframeGateDecision(
                accept: false, reason: "overlap-too-high",
                newContentFraction: newContentFraction,
                acceptedCount: acceptedCount, maxCount: maxCount
            )
        }

        // Accept.
        lastCornersOnPlane = currentCorners
        acceptedCount += 1
        os_log(.fault, log: Self.log,
               "[V16-keyframe] accepted (#%d/%d) newContent=%.3f thr=%.3f",
               acceptedCount, maxCount, newContentFraction, overlapThreshold)
        return KeyframeGateDecision(
            accept: true, reason: "ok",
            newContentFraction: newContentFraction,
            acceptedCount: acceptedCount, maxCount: maxCount
        )
    }

    // MARK: Geometry helpers (file-private)

    /// Project the 4 image corners (TL, TR, BR, BL) onto the plane via
    /// the camera pose's intrinsics + extrinsics.  Returns 4 plane-
    /// local (u, v) points in metres, or nil if any corner ray fails
    /// to intersect the plane (parallel / behind camera).
    private func projectCornersOntoPlane(
        pose: RetaiLensARFramePose,
        plane: PlaneBasis
    ) -> [SIMD2<Float>]? {
        let fx = Float(pose.fx), fy = Float(pose.fy)
        let cx = Float(pose.cx), cy = Float(pose.cy)
        let W = Float(pose.imageWidth), H = Float(pose.imageHeight)
        let rayOrigin = simd_float3(
            Float(pose.tx), Float(pose.ty), Float(pose.tz)
        )
        let q = simd_quatf(
            ix: Float(pose.qx), iy: Float(pose.qy),
            iz: Float(pose.qz), r: Float(pose.qw)
        )
        // ARKit camera frame = right-up-back (camera looks along -Z).
        // OpenCV intrinsics convention has +V going DOWN in image, so
        // we negate (v - cy) when converting back to ARKit camera
        // coords where +Y is UP.  Same convention used in the
        // existing `yawPitch` helper which assumes (0, 0, -1) is
        // forward in camera-frame.
        let imgCorners: [(Float, Float)] = [
            (0, 0), (W, 0), (W, H), (0, H)
        ]
        var planeCorners: [SIMD2<Float>] = []
        planeCorners.reserveCapacity(4)
        for (u, v) in imgCorners {
            let rayCam = simd_float3(
                (u - cx) / fx,
                -(v - cy) / fy,
                -1.0
            )
            let rayWorld = simd_normalize(simd_act(q, rayCam))
            // Solve t s.t. (origin + t·dir − planeOrigin) · normal = 0
            let denom = simd_dot(rayWorld, plane.normal)
            if abs(denom) < 1e-6 { return nil }  // parallel
            let t = simd_dot(plane.origin - rayOrigin, plane.normal) / denom
            if t <= 1e-3 { return nil }  // behind camera or coincident
            let worldPt = rayOrigin + t * rayWorld
            planeCorners.append(plane.worldToLocal(worldPt))
        }
        return planeCorners
    }

    /// Shoelace formula — returns absolute polygon area.
    private func polygonArea(_ pts: [SIMD2<Float>]) -> Float {
        guard pts.count >= 3 else { return 0 }
        var sum: Float = 0
        for i in 0..<pts.count {
            let j = (i + 1) % pts.count
            sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y
        }
        return abs(sum) * 0.5
    }

    /// Signed shoelace — positive for CCW, negative for CW winding.
    /// Used to canonicalise input polygons before clipping.
    private func signedArea(_ pts: [SIMD2<Float>]) -> Float {
        guard pts.count >= 3 else { return 0 }
        var sum: Float = 0
        for i in 0..<pts.count {
            let j = (i + 1) % pts.count
            sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y
        }
        return sum * 0.5
    }

    /// Force CCW winding (positive signed area).  Sutherland-Hodgman
    /// is sensitive to winding order; both polygons must use the same.
    private func ensureCCW(_ pts: [SIMD2<Float>]) -> [SIMD2<Float>] {
        if signedArea(pts) < 0 { return pts.reversed() }
        return pts
    }

    /// Convex polygon intersection via Sutherland-Hodgman.  Both
    /// inputs are 4-vertex convex quads (camera footprints on plane).
    /// O(n × m) — 16 ops worst case.
    private func polygonIntersectionArea(
        subject: [SIMD2<Float>],
        clip: [SIMD2<Float>]
    ) -> Float {
        let subj = ensureCCW(subject)
        let clp = ensureCCW(clip)
        var output = subj
        for i in 0..<clp.count {
            if output.isEmpty { return 0 }
            let edgeStart = clp[i]
            let edgeEnd = clp[(i + 1) % clp.count]
            let input = output
            output = []
            output.reserveCapacity(input.count + 1)
            guard !input.isEmpty else { return 0 }
            var s = input.last!
            for e in input {
                let eIn = isInside(e, edgeStart, edgeEnd)
                let sIn = isInside(s, edgeStart, edgeEnd)
                if eIn {
                    if !sIn,
                       let p = lineIntersect(s, e, edgeStart, edgeEnd) {
                        output.append(p)
                    }
                    output.append(e)
                } else if sIn,
                          let p = lineIntersect(s, e, edgeStart, edgeEnd) {
                    output.append(p)
                }
                s = e
            }
        }
        return polygonArea(output)
    }

    /// Half-plane test: point `p` is "inside" the edge a→b (CCW) when
    /// the 2D cross product (b−a) × (p−a) is non-negative.
    private func isInside(
        _ p: SIMD2<Float>, _ a: SIMD2<Float>, _ b: SIMD2<Float>
    ) -> Bool {
        return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0
    }

    /// Intersect segments s→e and a→b.  Returns nil for parallel /
    /// near-parallel segments.
    private func lineIntersect(
        _ s: SIMD2<Float>, _ e: SIMD2<Float>,
        _ a: SIMD2<Float>, _ b: SIMD2<Float>
    ) -> SIMD2<Float>? {
        let dcx = a.x - b.x
        let dcy = a.y - b.y
        let dpx = s.x - e.x
        let dpy = s.y - e.y
        let denom = dcx * dpy - dcy * dpx
        if abs(denom) < 1e-9 { return nil }
        let n1 = a.x * b.y - a.y * b.x
        let n2 = s.x * e.y - s.y * e.x
        return SIMD2<Float>(
            (n1 * dpx - n2 * dcx) / denom,
            (n1 * dpy - n2 * dcy) / denom
        )
    }
}
