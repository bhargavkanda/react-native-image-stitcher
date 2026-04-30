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

    // MARK: - Phase 5: AR-backed photo + video capture

    /// `options` keys: `path` (required), `quality` (optional, 0-100,
    /// default 90).  Resolves with `{ path, width, height, isMirrored,
    /// isRawPhoto }` matching vision-camera's PhotoFile shape.
    @objc(takePhoto:resolver:rejecter:)
    public func takePhoto(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let path = (options["path"] as? String) ?? ""
        let quality = (options["quality"] as? Int) ?? 90
        RetaiLensARSession.shared.takePhoto(
            toPath: path,
            quality: quality
        ) { result, error in
            if let error = error {
                rejecter("ar-photo-failed", error.localizedDescription, error)
            } else {
                resolver(result)
            }
        }
    }

    /// `options` keys: `path` (optional, native generates one in
    /// NSTemporaryDirectory when omitted).  Resolves with `{ path }`
    /// once recording is set up (frames begin flowing automatically
    /// from the ARSession delegate).
    @objc(startRecording:resolver:rejecter:)
    public func startRecording(
        options: NSDictionary,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let path = (options["path"] as? String) ?? ""
        RetaiLensARSession.shared.startRecording(toPath: path) { resolvedPath, error in
            if let error = error {
                rejecter("ar-recording-failed", error.localizedDescription, error)
            } else {
                resolver(["path": resolvedPath ?? ""])
            }
        }
    }

    /// Resolves with `{ path, duration, size, width, height }`
    /// matching vision-camera's VideoFile shape.
    @objc(stopRecording:rejecter:)
    public func stopRecording(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RetaiLensARSession.shared.stopRecording { result, error in
            if let error = error {
                rejecter("ar-stop-failed", error.localizedDescription, error)
            } else {
                resolver(result)
            }
        }
    }
}
