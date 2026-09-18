// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoPlusPlugin — the pano+ frame source.
//
// A native `RNISARFramePlugin` registered into `RNISARPluginRegistry.shared`
// (the same framework the host app's other first-party AR plugins already
// use).  This is the ONLY path in the stitcher that delivers a
// TIME-ALIGNED (pixels, attitude, intrinsics) triple, synchronously, once per
// ARFrame, with no throttle:
//
//   * `ctx.pixelBuffer`   — the live `capturedImage`
//   * `ctx.poseRotation`  — the world←camera unit quaternion.  THE ATTITUDE.
//                           The offline RCA's whole finding is that image-only
//                           registration cannot observe pitch/yaw at 1-frame
//                           baselines; the iPhone pano is straight because the
//                           gyro measures all three rotation DOFs in hardware.
//   * `ctx.fx/fy/cx/cy`   — the frame's OWN ARKit intrinsics.  Never hardcoded,
//                           never synthesised from an assumed FoV (which is
//                           what the vision-camera worklet path does).
//
// ── v6: THE ONE THING THE CONTEXT DOES NOT CARRY ─────────────────────────
//
// `RNISARFrameContext` has no exposure fields, and adding them would widen
// the plugin ABI that every host of this package compiles against — a
// breaking change for one engine's benefit.  ARKit also
// hands plugins a bare `CVPixelBuffer` with no exposure attachment and does
// not expose the `ARFrame`.  So the exposure is sampled off the shared
// `AVCaptureDevice` singleton ARKit is streaming from, once per frame, by
// `RNISPanoCameraLock.currentExposure()` — two property reads.
//
// SCOPE, STATED HERE RATHER THAN IMPLIED: that is the DEVICE's exposure at
// callback time, not a value carried by this frame.  Under the sweep lock it
// is constant and the distinction is empty; with the lock refused it carries a
// frame or two of pipeline lag, which is exactly why the engine keeps a
// bounded residual corrector on top of it instead of trusting it outright.
//
// ── v11: AND THE SECOND READING, WHICH IS NOT CIRCULAR ───────────────────
//
// The paragraph above describes a measurement taken on the device WE chose
// and WE locked, verified by reading that same object back.  It cannot
// answer whether that is the device ARKit streams, nor whether the lock
// reaches ARKit's pixels — and the camera-lock file's header explicitly
// declines to claim either, saying "the pack carries the EVIDENCE instead of
// the claim".  `RNISArExposureProbe` supplies the missing evidence:
// `ARCamera.exposureDuration` and `ARCamera.exposureOffset`, off the ARFrame
// itself.  Two more floats on the same call, recorded and never consumed —
// the engine's radiometric normalisation still reads only the pair above.
//
// Every alternative was rejected for a specific reason: `ARFrameConsumer` and
// `setFirstPartyCallback` are SINGLE-slot and already claimed by the batch
// stitcher; the vision-camera worklet is async and fakes its intrinsics;
// `onArFrame` is throttled and carries no pixels; `getFramePoses` is poll-only
// with a 600-entry cap.
//
// ── The AR-thread contract, honoured to the letter ───────────────────────
//
// `process(_:)` runs on the ARKit delegate thread, once per frame, with no
// throttle and no try/catch, and every registered plugin runs SERIALLY in that
// same call.  A slow plugin stalls ARKit tracking and every sibling (the DT
// engine registers its own).  So this plugin does exactly two things: hand the
// buffer to `RNISPanoCore` (which memcpy's it into a pre-allocated ring slot
// and returns) and return the cached status dict.  It never allocates a
// canvas, never touches OpenCV, never blocks.
//
// The returned dictionary rides the throttled `onArFrame` meta under
// `plugins["sweep"]` — the SYNC channel.  Nothing the operator
// must see rides the async `emit` channel, which the document-scan host
// recorded as unreliable.


import Foundation
import CoreVideo

@objc(RNISPanoPlusPlugin)
public final class RNISPanoPlusPlugin: NSObject, RNISARFramePlugin {

    /// Singleton — the bridge registers/unregisters THIS instance, so the
    /// registry keys stay stable across start/stop cycles.
    @objc public static let shared = RNISPanoPlusPlugin()

    /// Registry key AND the `onArFrame` meta key JS reads.  Must match the
    /// TS layer's `meta.plugins.sweep` lookup exactly.
    @objc public static let pluginName = "sweep"

    private override init() { super.init() }

    public func name() -> String { Self.pluginName }

    public func process(_ context: RNISARFrameContext) -> [String: Any]? {
        // Not capturing ⇒ the cheapest possible exit.  The registry only
        // builds the context when SOME plugin is registered, so a pano+ that
        // is registered-but-idle costs one atomic load per frame.
        guard RNISPanoCore.isRunning() else { return nil }

        // v6 — the frame's exposure, for the engine's exact radiometric
        // normalisation.  `nil` (no device attached, or a device that reports
        // a non-finite duration/ISO) forwards as 0/0, which every consumer
        // below treats as "no metadata ⇒ no normalisation" — never as a dark
        // frame, and byte-identical to v5's behaviour.
        var expDurationS = 0.0
        var expISO = 0.0
        if let e = RNISPanoCameraLock.shared.currentExposure(), e.count >= 2 {
            expDurationS = e[0].doubleValue
            expISO = e[1].doubleValue
        }

        // v11 — THE NON-CIRCULAR HALF, two property reads off ARKit's own
        // camera.  Everything above is read off the `AVCaptureDevice` this
        // pod resolved and locked, so it cannot answer "is that the device
        // ARKit streams?" or "does the lock reach ARKit's pixels?".  These
        // can.  EVIDENCE ONLY: the engine records them and normalises
        // radiometry off the pair above exactly as v6 left it.
        //
        // nil forwards as have=false, which the engine counts in NEITHER
        // trace — an unreadable exposure is never a zero one.  The frame
        // timestamp goes with it so the probe can prove the ARFrame it read
        // is the frame this call was handed, rather than assume it.
        var arExpDurationS = 0.0
        var arExpOffsetEV = 0.0
        var arExpHave = false
        if let a = RNISArExposureProbe.shared.sample(
            frameTimestampNs: context.timestampNs), a.count >= 2 {
            arExpDurationS = a[0].doubleValue
            arExpOffsetEV = a[1].doubleValue
            arExpHave = true
        }

        // Hands off a COPY and returns.  The pixel buffer is ARKit's and is
        // recycled the moment this call returns — RNISPanoCore copies inside
        // this call, before returning, and never retains ARKit memory.
        RNISPanoCore.ingest(
            pixelBuffer: context.pixelBuffer,
            timestampNs: context.timestampNs,
            fx: context.fx, fy: context.fy, cx: context.cx, cy: context.cy,
            imageWidth: context.imageWidth,
            imageHeight: context.imageHeight,
            rotation: context.poseRotation.map { NSNumber(value: $0) },
            translation: context.poseTranslation.map { NSNumber(value: $0) },
            tracking: context.trackingState,
            exposureDurationS: expDurationS,
            exposureISO: expISO,
            arExposureDurationS: arExpDurationS,
            arExposureOffsetEV: arExpOffsetEV,
            arExposureHave: arExpHave
        )

        // SYNC channel: the live HUD/ledger snapshot.
        return RNISPanoCore.status()
    }
}

