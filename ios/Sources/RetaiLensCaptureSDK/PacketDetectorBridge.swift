// SPDX-License-Identifier: UNLICENSED
//
// PacketDetectorBridge — RN bridge for RetaiLensPacketDetector.
//
// Surface (Phase 7):
//   isAvailable() → Promise<boolean>
//   runPacketDetection(options) → Promise<{ items: [...] }>

#if canImport(React)
import Foundation
import React


@objc(RetaiLensPacketDetectorBridge)
public final class RetaiLensPacketDetectorBridge: NSObject {

    @objc public static func requiresMainQueueSetup() -> Bool {
        // Inference runs on a background queue; bridge setup
        // doesn't need main thread.
        return false
    }

    @objc(isAvailable:rejecter:)
    public func isAvailable(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        resolver(RetaiLensPacketDetector.isAvailable)
    }

    /// `options` keys:
    ///   panoramaPath: String (required)
    ///   confidenceThreshold: Double (optional, default 0.35)
    @objc(runPacketDetection:resolver:rejecter:)
    public func runPacketDetection(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        guard let path = options["panoramaPath"] as? String else {
            rejecter("invalid-options", "panoramaPath must be a string", nil)
            return
        }
        let threshold = (options["confidenceThreshold"] as? Double) ?? 0.35
        DispatchQueue.global(qos: .userInitiated).async {
            RetaiLensPacketDetector.detect(
                panoramaPath: path,
                confidenceThreshold: threshold
            ) { items, error in
                if let error = error {
                    rejecter("detect-failed", error.localizedDescription, error)
                } else {
                    resolver([
                        "items": (items ?? []).map { $0.asDictionary() },
                        "isAvailable": RetaiLensPacketDetector.isAvailable,
                    ])
                }
            }
        }
    }
}
#endif
