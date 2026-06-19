// SPDX-License-Identifier: Apache-2.0
//
// ARSessionBridge — RN bridge for RNSARSession.
//
// JS surface (mirrored on Android via the analogous ARCore bridge):
//
//   isSupported() → Promise<boolean>
//   start() → Promise<void>
//   stop() → Promise<void>
//   getState() → Promise<{ isRunning, trackingState }>
//   snapshotPoseLog() → Promise<FramePose[]>
//
// Phase 5+ APIs (stitchVideoWithPoses) are added on the existing
// BatchStitcher bridge, not here — keeps each module focused on
// one ARKit/OpenCV concern.

import Foundation
import React

@objc(RNSARSessionBridge)
public final class RNSARSessionBridge: NSObject {

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
        resolver(RNSARSession.isSupported)
    }

    @objc(start:rejecter:)
    public func start(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            RNSARSession.shared.start()
            resolver(nil)
        }
    }

    @objc(stop:rejecter:)
    public func stop(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            RNSARSession.shared.stop()
            resolver(nil)
        }
    }

    @objc(getState:rejecter:)
    public func getState(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let s = RNSARSession.shared
        resolver([
            "isRunning": s.isRunning,
            "trackingState": s.currentTrackingState.rawValue,
        ])
    }

    /// Toggle ARKit scene reconstruction (LiDAR mesh / `ARMeshAnchor`s).
    /// Driven by the <Camera> `enableMesh` prop; gates the
    /// StitcherFrame `meshGeometry` extraction at the SESSION level
    /// (the per-frame `__stitcherProxy.setExtractionConfig(...mesh)`
    /// gates the marshaling — both must be on for a host to receive
    /// mesh).  Resolves with no value.
    ///
    /// Hops to the main queue: `setSceneReconstructionEnabled` may call
    /// `arSession.run(config)` to reconfigure a live session, and
    /// ARKit session lifecycle must run on the main thread (same
    /// constraint as `start`).
    @objc(setSceneReconstructionEnabled:resolver:rejecter:)
    public func setSceneReconstructionEnabled(
        enabled: NSNumber,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let on = enabled.boolValue
        DispatchQueue.main.async {
            RNSARSession.shared.setSceneReconstructionEnabled(on)
            resolver(nil)
        }
    }

    /// Hops to the main queue: `setPlaneDetection` may call
    /// `arSession.run(config)` to reconfigure a live session, and ARKit
    /// session lifecycle must run on the main thread (same constraint as
    /// `start` / `setSceneReconstructionEnabled`).
    @objc(setPlaneDetection:resolver:rejecter:)
    public func setPlaneDetection(
        mode: NSString,
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let m = mode as String
        DispatchQueue.main.async {
            RNSARSession.shared.setPlaneDetection(m)
            resolver(nil)
        }
    }

    @objc(snapshotPoseLog:rejecter:)
    public func snapshotPoseLog(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        let poses = RNSARSession.shared.snapshotPoseLog()
        resolver(poses.map { $0.asDictionary() })
    }

    @objc(clearPoseLog:rejecter:)
    public func clearPoseLog(
        resolver: @escaping RCTPromiseResolveBlock,
        rejecter: @escaping RCTPromiseRejectBlock
    ) {
        RNSARSession.shared.clearPoseLog()
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
        // v0.12.0 — host passes the actual device orientation so
        // the saved JPEG matches the user's view.  Defaults to
        // "portrait" if absent, preserving pre-v0.12 behavior for
        // any caller that hasn't been updated.
        let orientation = (options["orientation"] as? String) ?? "portrait"
        RNSARSession.shared.takePhoto(
            toPath: path,
            quality: quality,
            orientation: orientation
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
        RNSARSession.shared.startRecording(toPath: path) { resolvedPath, error in
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
        RNSARSession.shared.stopRecording { result, error in
            if let error = error {
                rejecter("ar-stop-failed", error.localizedDescription, error)
            } else {
                resolver(result)
            }
        }
    }
}
