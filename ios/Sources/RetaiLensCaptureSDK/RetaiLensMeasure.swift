// SPDX-License-Identifier: UNLICENSED
//
// RetaiLensMeasure — Phase 6 SfM-based measurement.
//
// Cross-platform constraint: works on any AR-capable device, NO
// LiDAR dependency.  The user explicitly asked for this so the
// measurement feature lights up on the Android fleet too.
//
// Algorithm (rough but defensible — refine as we get field data):
//
//   1. Extract yaw angles from the framePoses' quaternions.
//      Range = ymax - ymin = the panorama's horizontal angular
//      extent in radians.
//
//   2. Assume a scene plane at depth D in front of the operator.
//      For shelf-arm-length capture (60–100 cm), 0.70 m is a
//      defensible default.  Future iteration: estimate D per-capture
//      from ARKit's feature-point cloud or scene-mesh API.
//
//   3. Real-world width spanned by the panorama:
//        W = 2 * D * tan(angularExtent / 2)
//
//   4. Pixels-per-metre = panoramaWidth / W
//      Vertical scale assumed isotropic (small-angle approximation).
//
//   5. Convert pixel distance/region to cm via that scale factor.
//
// Confidence flag reflects whether the inputs are "trustworthy":
//   - high: angular extent ≥ 20° AND ≥ 5 poses AND tracking nominal
//   - medium: angular extent ≥ 10° AND ≥ 3 poses
//   - low: anything below those bars (caller should warn the user)
//
// Limitations baked in (documented in the JS API caveats too):
//   - Single-depth assumption — packets at different distances will
//     measure inconsistently.
//   - Panoramic captures are mostly rotational, so SfM-triangulation
//     can't improve much over the planar-scene assumption.
//   - Lens distortion at extreme angles isn't corrected.

import Foundation
import simd


@objc(RetaiLensMeasure)
public final class RetaiLensMeasure: NSObject {

    /// Default scene depth in metres when not provided by the caller.
    /// Tuned for shelf-arm-length capture; can be overridden via the
    /// `sceneDepthMeters` option in the JS bridge.
    private static let DEFAULT_SCENE_DEPTH_M: Double = 0.70

    /// Minimum angular extent (radians) before we flag confidence as "low".
    private static let MIN_GOOD_EXTENT_RAD: Double = 10.0 * .pi / 180.0
    /// Minimum angular extent for "high" confidence.
    private static let HIGH_EXTENT_RAD: Double = 20.0 * .pi / 180.0

    /// Compute pixels-per-metre + confidence from a pose array.
    /// Returns (pixelsPerMetre, confidence).  Throws on degenerate
    /// input (no poses, no rotation extent).
    @objc public static func calibrate(
        panoramaWidth: Int,
        panoramaHeight: Int,
        framePoses: [[String: Any]],
        sceneDepthMeters: Double
    ) -> [String: Any] {
        let depth = sceneDepthMeters > 0 ? sceneDepthMeters : DEFAULT_SCENE_DEPTH_M
        if framePoses.isEmpty || panoramaWidth <= 0 {
            return [
                "pixelsPerMetre": 0.0,
                "confidence": "low",
                "angularExtentRadians": 0.0,
                "sceneDepthMeters": depth,
                "reason": "no poses or zero panorama width",
            ]
        }

        // Extract yaw (rotation around the world's vertical axis)
        // from each pose's quaternion.  For ARKit's right-handed
        // Y-up world, yaw = atan2(2*(qw*qy + qx*qz), 1 - 2*(qy² + qz²))
        // — the angle around the +Y axis.
        var yaws: [Double] = []
        yaws.reserveCapacity(framePoses.count)
        var minTrackingState = 2  // assume tracking nominal until proven otherwise
        for pose in framePoses {
            guard let qx = pose["qx"] as? Double,
                  let qy = pose["qy"] as? Double,
                  let qz = pose["qz"] as? Double,
                  let qw = pose["qw"] as? Double else {
                continue
            }
            let sinYawCosPitch = 2.0 * (qw * qy + qx * qz)
            let cosYawCosPitch = 1.0 - 2.0 * (qy * qy + qz * qz)
            let yaw = atan2(sinYawCosPitch, cosYawCosPitch)
            yaws.append(yaw)
            if let ts = pose["trackingState"] as? Int, ts < minTrackingState {
                minTrackingState = ts
            }
        }
        if yaws.count < 2 {
            return [
                "pixelsPerMetre": 0.0,
                "confidence": "low",
                "angularExtentRadians": 0.0,
                "sceneDepthMeters": depth,
                "reason": "fewer than 2 valid poses",
            ]
        }

        // Yaw can wrap around ±π — unwrap before computing range.
        // For typical shelf scans (<90°) this is rarely needed but
        // we handle it defensively.
        var unwrapped: [Double] = [yaws[0]]
        for i in 1..<yaws.count {
            var y = yaws[i]
            let prev = unwrapped[i - 1]
            while y - prev > .pi { y -= 2 * .pi }
            while y - prev < -.pi { y += 2 * .pi }
            unwrapped.append(y)
        }
        let ymin = unwrapped.min() ?? 0
        let ymax = unwrapped.max() ?? 0
        let extent = abs(ymax - ymin)
        if extent <= 0.0 {
            return [
                "pixelsPerMetre": 0.0,
                "confidence": "low",
                "angularExtentRadians": 0.0,
                "sceneDepthMeters": depth,
                "reason": "no angular extent (camera didn't rotate)",
            ]
        }

        // Real-world width spanned by the panorama at this depth.
        let realWidthMeters = 2.0 * depth * tan(extent / 2.0)
        let pixelsPerMetre = Double(panoramaWidth) / realWidthMeters

        // Confidence
        let confidence: String
        if extent >= HIGH_EXTENT_RAD
           && framePoses.count >= 5
           && minTrackingState >= 2 {
            confidence = "high"
        } else if extent >= MIN_GOOD_EXTENT_RAD && framePoses.count >= 3 {
            confidence = "medium"
        } else {
            confidence = "low"
        }

        return [
            "pixelsPerMetre": pixelsPerMetre,
            "confidence": confidence,
            "angularExtentRadians": extent,
            "sceneDepthMeters": depth,
            "reason": "ok",
        ]
    }

    /// Convert a 2-point pixel distance to centimetres.
    @objc public static func measureDistance(
        panoramaWidth: Int,
        panoramaHeight: Int,
        framePoses: [[String: Any]],
        pointA: [String: Double],
        pointB: [String: Double],
        sceneDepthMeters: Double
    ) -> [String: Any] {
        let cal = calibrate(
            panoramaWidth: panoramaWidth,
            panoramaHeight: panoramaHeight,
            framePoses: framePoses,
            sceneDepthMeters: sceneDepthMeters
        )
        let pixelsPerMetre = (cal["pixelsPerMetre"] as? Double) ?? 0
        let confidence = (cal["confidence"] as? String) ?? "low"
        let ax = pointA["x"] ?? 0
        let ay = pointA["y"] ?? 0
        let bx = pointB["x"] ?? 0
        let by = pointB["y"] ?? 0
        let dx = bx - ax
        let dy = by - ay
        let pixels = sqrt(dx * dx + dy * dy)
        let distanceCm: Double
        if pixelsPerMetre > 0 {
            distanceCm = (pixels / pixelsPerMetre) * 100.0
        } else {
            distanceCm = 0
        }
        return [
            "distanceCm": distanceCm,
            "confidence": confidence,
            "pixelsPerMetre": pixelsPerMetre,
        ]
    }

    /// Convert a 2-corner panorama region to a real-world width × height.
    @objc public static func measureRegion(
        panoramaWidth: Int,
        panoramaHeight: Int,
        framePoses: [[String: Any]],
        topLeft: [String: Double],
        bottomRight: [String: Double],
        sceneDepthMeters: Double
    ) -> [String: Any] {
        let cal = calibrate(
            panoramaWidth: panoramaWidth,
            panoramaHeight: panoramaHeight,
            framePoses: framePoses,
            sceneDepthMeters: sceneDepthMeters
        )
        let pixelsPerMetre = (cal["pixelsPerMetre"] as? Double) ?? 0
        let confidence = (cal["confidence"] as? String) ?? "low"
        let widthPx = abs((bottomRight["x"] ?? 0) - (topLeft["x"] ?? 0))
        let heightPx = abs((bottomRight["y"] ?? 0) - (topLeft["y"] ?? 0))
        let widthCm: Double
        let heightCm: Double
        if pixelsPerMetre > 0 {
            widthCm = (widthPx / pixelsPerMetre) * 100.0
            heightCm = (heightPx / pixelsPerMetre) * 100.0
        } else {
            widthCm = 0
            heightCm = 0
        }
        return [
            "widthCm": widthCm,
            "heightCm": heightCm,
            "confidence": confidence,
            "pixelsPerMetre": pixelsPerMetre,
        ]
    }
}
