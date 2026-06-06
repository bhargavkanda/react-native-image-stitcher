// SPDX-License-Identifier: Apache-2.0
//
// KeyframeGate — Swift facade over the shared C++ KeyframeGate.
//
// This file used to BE the algorithm (~545 lines of Swift simd math).
// As of P3-B of the Android-iOS parity work, the algorithm lives in
// react-native-image-stitcher/cpp/keyframe_gate.{hpp,cpp} and is shared with
// the Android side via JNI.  This Swift class is now a thin facade
// that:
//
//   1. Preserves the original public Swift API exactly so the 13
//      callsites in IncrementalStitcher.swift don't change.
//   2. Marshals the Swift `RNSARFramePose` + `simd_float4x4?`
//      into the primitive types the Obj-C++ bridge expects.
//   3. Maps the Obj-C++ bridge's return shape back into the original
//      `KeyframeGateDecision` struct.
//
// Why a facade (not direct callsite rewrites):
//   The Swift code has 13 callsites — each touching enabled,
//   overlapThreshold, maxCount, forceAcceptNext, reset(), evaluate(...),
//   acceptedCount.  Rewriting them all introduces churn and regression
//   risk.  A drop-in facade keeps the call shape identical; the only
//   change to the engine code is "underneath, this calls C++ instead
//   of Swift simd math".  iOS device-verify (P3-C) will confirm
//   behaviour is bit-identical to the old Swift impl.
//
// The original Swift implementation is preserved at
// /tmp/KeyframeGate.swift.bak for ~one session; can be retrieved
// from git history thereafter (commit before P3-B).

import Foundation
import simd

/// Returned from `KeyframeGate.evaluate(pose:latchedPlane:)`.  Same
/// shape as the original Swift definition so callers don't change.
struct KeyframeGateDecision {
    let accept: Bool
    /// Short reason string for fault-level logging and JS telemetry.
    /// 1:1 mapping with the C++ `KeyframeGateDecisionReason` enum is
    /// done in `KeyframeGateBridge.mm::kReasonStringFor`.
    let reason: String
    /// Computed new-content fraction in [0, 1].  -1.0 if not computed
    /// (gate disabled, force-first/last, no plane available).
    let newContentFraction: Double
    /// Keyframes accepted so far (including this one if accept=true).
    let acceptedCount: Int
    /// Max keyframes for the capture (0 if gate disabled).
    let maxCount: Int
}

final class KeyframeGate {

    // The Obj-C++ bridge owns the C++ `retailens::KeyframeGate`
    // instance.  We keep a single instance per KeyframeGate Swift
    // object — lifetimes are tied (ARC dealloc → bridge dealloc → C++
    // destructor).
    private let bridge = KeyframeGateBridge()

    // MARK: - Settings (called between captures)
    //
    // All settings are pass-throughs to the C++ instance via the
    // bridge.  We use computed getters that read fresh from the
    // bridge so the value is never out-of-sync with the C++ state
    // (would matter if a caller mutates the bridge directly — they
    // don't, but defensive).

    /// True when frameSelectionMode == "pose-based".  When false,
    /// every evaluate() returns accept=true (gate is a passthrough).
    var enabled: Bool {
        get { bridge.isEnabled() }
        set { bridge.setEnabled(newValue) }
    }

    /// Required new-content fraction (0…1).  Default 0.4 (40% new
    /// content ≈ 4-5 keyframes for a 90° landscape pan).
    ///
    /// NOTE: This is stored locally too because the C++ bridge has no
    /// getter for it (the read-side was never needed by Swift code).
    /// Setter is what propagates into C++.
    var overlapThreshold: Double = 0.4 {
        didSet { bridge.setOverlapThreshold(overlapThreshold) }
    }

    /// Hard cap on keyframes per capture (default 6).  Same getter
    /// pattern as enabled — we read from the bridge.
    var maxCount: Int {
        get { bridge.maxCount() }
        set { bridge.setMaxCount(newValue) }
    }

    // MARK: - V16 A2 — strategy + flow tunables

    /// Mirror of `retailens::GateStrategy`.  Pose = the V16 Phase-0
    /// plane-overlap path.  Flow = V16 A2 sparse-optical-flow novelty
    /// (needs per-frame image data via the `evaluate(pose:plane:pixelBuffer:)`
    /// overload below; the older pixel-buffer-free `evaluate(pose:plane:)`
    /// silently falls back to Pose regardless of this setting).
    enum GateStrategy: Int {
        case pose = 0
        case flow = 1
    }

    var strategy: GateStrategy {
        get { GateStrategy(rawValue: bridge.strategy().rawValue) ?? .pose }
        set { bridge.setStrategy(KGBStrategy(rawValue: newValue.rawValue) ?? .pose) }
    }

    /// Flow strategy — number of Shi-Tomasi corners to detect per
    /// accepted keyframe.  Default 150; the C++ side clamps to ≥30.
    /// Higher = more robust median, slower detect (~15-25 ms at 150
    /// on iPhone 13 Pro).  Tunable from PanoramaSettingsModal.
    var flowMaxCorners: Int = 150 {
        didSet { bridge.setFlowMaxCorners(flowMaxCorners) }
    }

    /// Flow strategy — Shi-Tomasi quality level (0, 1].  Default
    /// 0.01.  Lower = more (weaker) corners detected; higher = fewer
    /// (stronger) corners.  C++ side clamps to (0.001, 1.0].
    var flowQualityLevel: Double = 0.01 {
        didSet { bridge.setFlowQualityLevel(flowQualityLevel) }
    }

    /// Flow strategy — minimum pixel distance between detected
    /// corners (in WORKING-resolution pixels — gate downscales to
    /// 720 px longest side internally).  Default 10.  Higher =
    /// more spatially-spread features = more representative median.
    var flowMinDistance: Double = 10.0 {
        didSet { bridge.setFlowMinDistance(flowMinDistance) }
    }

    /// V16 — translation budget for the Flow strategy, in CENTIMETRES
    /// (UI-friendly unit; bridge converts to metres before crossing).
    /// When > 0, the gate force-accepts a frame if the camera has
    /// translated more than this distance (3D Euclidean) since the
    /// last accepted keyframe — even when novelty < overlapThreshold.
    /// Bounds the parallax between adjacent keyframes so the
    /// downstream stitcher's matcher (even the affine one) sees
    /// inputs it can handle.  Default 0 = disabled (back-compat);
    /// operator opts-in via the capture-settings UI.  Recommended
    /// starting value once enabled: 8 cm.
    var flowMaxTranslationCm: Double = 0.0 {
        didSet {
            // Bridge takes metres; UI surface uses cm for legibility.
            bridge.setFlowMaxTranslationM(flowMaxTranslationCm / 100.0)
        }
    }

    /// Wall-clock keyframe-interval budget, in MILLISECONDS.  When > 0,
    /// the gate force-accepts a frame once the elapsed time since the
    /// last accepted keyframe exceeds this value — even when novelty <
    /// overlapThreshold.  Unlike `flowMaxTranslationCm` this applies to
    /// BOTH the Pose and Flow strategies, and is passed STRAIGHT
    /// THROUGH to the bridge (the unit is already what C++ expects — no
    /// cm→m style conversion).  Default 2000 ms; 0 = disabled.  The C++
    /// setter clamps to ≥ 0.
    var maxKeyframeIntervalMs: Double = 2000.0 {
        didSet {
            bridge.setMaxKeyframeIntervalMs(maxKeyframeIntervalMs)
        }
    }

    /// V16 — percentile used to aggregate the tracked features'
    /// absolute displacements into a per-axis novelty estimate.
    /// Default 0.85.  Pre-V16 used median (0.50); the higher
    /// percentile picks up leading-edge motion sooner — better
    /// matches user perception of "new content visible".  Clamped
    /// at the bridge to [0.5, 0.99].
    var flowNoveltyPercentile: Double = 0.85 {
        didSet { bridge.setFlowNoveltyPercentile(flowNoveltyPercentile) }
    }

    /// V16 — Swift-side throttle for gate evaluation cadence.  Default
    /// 1 (evaluate on every consumeFrame).  Set higher to skip evals
    /// on (N-1)/N frames — pure CPU/battery savings, no change to
    /// WHICH frames are accepted (still subject to overlapThreshold
    /// + translation budget).  Range 1-10 enforced at start() time.
    ///
    /// This knob lives in Swift, not C++, because it's about HOW
    /// OFTEN we call into the gate, not about gate-internal logic.
    /// Read by IncrementalStitcher.consumeFrame before
    /// invoking `evaluate(...)`.
    var flowEvalEveryNFrames: Int = 1

    /// 2026-05-22 (audit F1b) — non-AR-mode opt-out for the angular-
    /// delta fallback.  See the bridge doc for the full rationale.
    /// In short: set this to `true` in non-AR mode (captureSource =
    /// 'non-ar') where there's no AR pose — the gate's angular-delta
    /// computation would otherwise run on gyro-integrated drift and
    /// accept near-identical frames → cv::Stitcher degenerate-param
    /// crash.  Default `false` (back-compat — AR mode uses the
    /// fallback).  Write-only; no read accessor on the C++ side.
    var disableAngularFallback: Bool = false {
        didSet { bridge.setDisableAngularFallback(disableAngularFallback) }
    }


    /// One-shot flag: when set to `true`, the very next evaluate()
    /// accepts unconditionally and the flag self-resets.  Set by JS
    /// shutter-release path so we don't truncate the trailing edge
    /// of the scan.
    ///
    /// Lives only on the C++ side — the Swift `var` is a "write-only
    /// trigger".  Reading after the assignment will always see false
    /// because the trigger is consumed inside the bridge.  The
    /// original Swift KeyframeGate also exposed it as a stored bool;
    /// no caller reads the value, only writes it.
    var forceAcceptNext: Bool {
        get { false }
        set {
            if newValue {
                bridge.markNextFrameAsLast()
            }
        }
    }

    // MARK: - State (read-only post-evaluate)

    /// Keyframes accepted so far in this capture.
    var acceptedCount: Int { bridge.acceptedCount() }

    // MARK: - Lifecycle

    func reset() {
        bridge.reset()
        // Re-apply Swift-side default settings that the bridge default-
        // initializes too, but write through anyway in case the caller
        // tweaked them — this guarantees the threshold survives reset.
        bridge.setOverlapThreshold(overlapThreshold)
    }

    // MARK: - Evaluation

    /// Decide whether to accept this ARFrame as a keyframe.
    ///
    /// Same call shape as the original Swift gate so callers in
    /// IncrementalStitcher.swift don't change.  Internally
    /// marshals the pose + optional plane matrix into the Obj-C++
    /// bridge's primitive args, calls into shared C++, then unwraps
    /// the result.
    func evaluate(
        pose: RNSARFramePose,
        latchedPlane: simd_float4x4?
    ) -> KeyframeGateDecision {
        // Flatten the 4×4 plane matrix into a 16-element NSNumber
        // array column-major.  simd_float4x4's `columns` property
        // already gives us column-major access; passing in the order
        // (column 0 elements, column 1 elements, …) matches what the
        // C++ `PlaneTransform.m[16]` expects.
        let plane16: [NSNumber]?
        if let m = latchedPlane {
            let c0 = m.columns.0
            let c1 = m.columns.1
            let c2 = m.columns.2
            let c3 = m.columns.3
            plane16 = [
                NSNumber(value: c0.x), NSNumber(value: c0.y),
                NSNumber(value: c0.z), NSNumber(value: c0.w),
                NSNumber(value: c1.x), NSNumber(value: c1.y),
                NSNumber(value: c1.z), NSNumber(value: c1.w),
                NSNumber(value: c2.x), NSNumber(value: c2.y),
                NSNumber(value: c2.z), NSNumber(value: c2.w),
                NSNumber(value: c3.x), NSNumber(value: c3.y),
                NSNumber(value: c3.z), NSNumber(value: c3.w),
            ]
        } else {
            plane16 = nil
        }

        let result = bridge.evaluate(
            withTx: Float(pose.tx),
            ty: Float(pose.ty),
            tz: Float(pose.tz),
            qx: Float(pose.qx),
            qy: Float(pose.qy),
            qz: Float(pose.qz),
            qw: Float(pose.qw),
            fx: Float(pose.fx),
            fy: Float(pose.fy),
            cx: Float(pose.cx),
            cy: Float(pose.cy),
            imageWidth: Int32(pose.imageWidth),
            imageHeight: Int32(pose.imageHeight),
            plane16: plane16
        )

        return KeyframeGateDecision(
            accept: result.accept,
            reason: result.reasonString,
            newContentFraction: result.newContentFraction,
            acceptedCount: result.acceptedCount,
            maxCount: result.maxCount
        )
    }

    /// V16 A2 — strategy-aware evaluate that also accepts the
    /// frame's pixel buffer.  Required by `strategy = .flow` (sparse-
    /// flow novelty needs the image content).  When `strategy = .pose`
    /// the pixel buffer is ignored — same result + cost as
    /// `evaluate(pose:latchedPlane:)`.
    ///
    /// The bridge handles all pixel-format handling (YUV-direct,
    /// BGRA-via-cvtColor, unknown → pose fallback).
    func evaluate(
        pose: RNSARFramePose,
        latchedPlane: simd_float4x4?,
        pixelBuffer: CVPixelBuffer
    ) -> KeyframeGateDecision {
        let plane16: [NSNumber]?
        if let m = latchedPlane {
            let c0 = m.columns.0
            let c1 = m.columns.1
            let c2 = m.columns.2
            let c3 = m.columns.3
            plane16 = [
                NSNumber(value: c0.x), NSNumber(value: c0.y),
                NSNumber(value: c0.z), NSNumber(value: c0.w),
                NSNumber(value: c1.x), NSNumber(value: c1.y),
                NSNumber(value: c1.z), NSNumber(value: c1.w),
                NSNumber(value: c2.x), NSNumber(value: c2.y),
                NSNumber(value: c2.z), NSNumber(value: c2.w),
                NSNumber(value: c3.x), NSNumber(value: c3.y),
                NSNumber(value: c3.z), NSNumber(value: c3.w),
            ]
        } else {
            plane16 = nil
        }

        let result = bridge.evaluate(
            pixelBuffer: pixelBuffer,
            tx: Float(pose.tx),
            ty: Float(pose.ty),
            tz: Float(pose.tz),
            qx: Float(pose.qx),
            qy: Float(pose.qy),
            qz: Float(pose.qz),
            qw: Float(pose.qw),
            fx: Float(pose.fx),
            fy: Float(pose.fy),
            cx: Float(pose.cx),
            cy: Float(pose.cy),
            imageWidth: Int32(pose.imageWidth),
            imageHeight: Int32(pose.imageHeight),
            plane16: plane16
        )

        return KeyframeGateDecision(
            accept: result.accept,
            reason: result.reasonString,
            newContentFraction: result.newContentFraction,
            acceptedCount: result.acceptedCount,
            maxCount: result.maxCount
        )
    }
}
