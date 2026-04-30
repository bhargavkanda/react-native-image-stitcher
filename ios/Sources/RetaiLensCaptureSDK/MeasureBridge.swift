// SPDX-License-Identifier: UNLICENSED
//
// MeasureBridge — RN bridge for RetaiLensMeasure.
//
// Surface (Phase 6):
//   measureDistance(options) → Promise<{ distanceCm, confidence, pixelsPerMetre }>
//   measureRegion(options)   → Promise<{ widthCm, heightCm, confidence, pixelsPerMetre }>

#if canImport(React)
import Foundation
import React


@objc(RetaiLensMeasureBridge)
public final class RetaiLensMeasureBridge: NSObject {

    @objc public static func requiresMainQueueSetup() -> Bool {
        // Pure-math module — no UIKit or main-thread state.
        return false
    }

    /// Expected `options` keys:
    ///   panoramaWidth: Int (px)
    ///   panoramaHeight: Int (px)
    ///   framePoses: NSArray of pose dicts (RetaiLensARFramePose.asDictionary())
    ///   pointA: { x: Double, y: Double } in panorama pixel coords
    ///   pointB: { x: Double, y: Double }
    ///   sceneDepthMeters: Double (optional, default 0.70 m)
    @objc(measureDistance:resolver:rejecter:)
    public func measureDistance(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let width = options["panoramaWidth"] as? Int,
              let height = options["panoramaHeight"] as? Int,
              let poses = options["framePoses"] as? [[String: Any]],
              let pointA = options["pointA"] as? [String: Double],
              let pointB = options["pointB"] as? [String: Double] else {
            rejecter("invalid-options",
                     "panoramaWidth/Height, framePoses, pointA, pointB are required",
                     nil)
            return
        }
        let depth = (options["sceneDepthMeters"] as? Double) ?? 0
        let result = RetaiLensMeasure.measureDistance(
            panoramaWidth: width,
            panoramaHeight: height,
            framePoses: poses,
            pointA: pointA,
            pointB: pointB,
            sceneDepthMeters: depth
        )
        resolver(result)
    }

    @objc(measureRegion:resolver:rejecter:)
    public func measureRegion(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let width = options["panoramaWidth"] as? Int,
              let height = options["panoramaHeight"] as? Int,
              let poses = options["framePoses"] as? [[String: Any]],
              let tl = options["topLeft"] as? [String: Double],
              let br = options["bottomRight"] as? [String: Double] else {
            rejecter("invalid-options",
                     "panoramaWidth/Height, framePoses, topLeft, bottomRight are required",
                     nil)
            return
        }
        let depth = (options["sceneDepthMeters"] as? Double) ?? 0
        let result = RetaiLensMeasure.measureRegion(
            panoramaWidth: width,
            panoramaHeight: height,
            framePoses: poses,
            topLeft: tl,
            bottomRight: br,
            sceneDepthMeters: depth
        )
        resolver(result)
    }
}
#endif
