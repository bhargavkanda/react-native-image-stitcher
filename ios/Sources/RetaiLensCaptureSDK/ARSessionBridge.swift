// SPDX-License-Identifier: UNLICENSED
//
// ARSessionBridge — RN bridge for RetaiLensARSession.
//
// JS surface (mirrored on Android via the analogous ARCore bridge):
//
//   isSupported() → Promise<boolean>
//   start() → Promise<void>
//   stop() → Promise<void>
//   getState() → Promise<{ isRunning, trackingState }>
//   snapshotPoseLog() → Promise<FramePose[]>
//
// Phase 5+ APIs (stitchVideoWithPoses, measureRegion) are added on
// the existing RetaiLensStitcher bridge, not here — keeps each
// module focused on one ARKit/OpenCV concern.

import Foundation
import React

@objc(RetaiLensARSessionBridge)
public final class RetaiLensARSessionBridge: NSObject {

    @objc public static func requiresMainQueueSetup() -> Bool {
        // ARSession.start() must be called on the main thread —
        // ARKit needs to attach to the active CVDisplayLink.
        return true
    }

    @objc(isSupported:rejecter:)
    public func isSupported(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        resolver(RetaiLensARSession.isSupported)
    }

    @objc(start:rejecter:)
    public func start(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            RetaiLensARSession.shared.start()
            resolver(nil)
        }
    }

    @objc(stop:rejecter:)
    public func stop(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            RetaiLensARSession.shared.stop()
            resolver(nil)
        }
    }

    @objc(getState:rejecter:)
    public func getState(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let s = RetaiLensARSession.shared
        resolver([
            "isRunning": s.isRunning,
            "trackingState": s.currentTrackingState.rawValue,
        ])
    }

    @objc(snapshotPoseLog:rejecter:)
    public func snapshotPoseLog(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let poses = RetaiLensARSession.shared.snapshotPoseLog()
        resolver(poses.map { $0.asDictionary() })
    }

    @objc(clearPoseLog:rejecter:)
    public func clearPoseLog(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RetaiLensARSession.shared.clearPoseLog()
        resolver(nil)
    }
}
