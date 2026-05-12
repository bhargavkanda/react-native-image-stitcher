// SPDX-License-Identifier: UNLICENSED
//
// KeyframeGate — Swift facade over the shared C++ KeyframeGate.
//
// This file used to BE the algorithm (~545 lines of Swift simd math).
// As of P3-B of the Android-iOS parity work, the algorithm lives in
// retailens-capture-sdk/cpp/keyframe_gate.{hpp,cpp} and is shared with
// the Android side via JNI.  This Swift class is now a thin facade
// that:
//
//   1. Preserves the original public Swift API exactly so the 13
//      callsites in RetaiLensIncrementalStitcher.swift don't change.
//   2. Marshals the Swift `RetaiLensARFramePose` + `simd_float4x4?`
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
    /// RetaiLensIncrementalStitcher.swift don't change.  Internally
    /// marshals the pose + optional plane matrix into the Obj-C++
    /// bridge's primitive args, calls into shared C++, then unwraps
    /// the result.
    func evaluate(
        pose: RetaiLensARFramePose,
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
}
