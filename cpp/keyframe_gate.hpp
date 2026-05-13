// SPDX-License-Identifier: UNLICENSED
//
// keyframe_gate.hpp — shared C++ port of KeyframeGate.swift.
//
// Why a shared port:
//   The Swift KeyframeGate has been the production-quality V16-Phase-0
//   gate on iOS for months.  The Android side was running a frame-
//   counter MVP placeholder, producing different keyframe sets and
//   therefore different panoramas across platforms.  Porting to
//   shared C++ that both iOS (via Obj-C++ bridge) and Android (via
//   JNI) call into eliminates the divergence and makes panorama
//   composition platform-identical.
//
// Algorithm summary (1:1 with KeyframeGate.swift comments):
//   For each candidate frame, project its 4 image corners onto the
//   latched ARKit/ARCore plane via ray-plane intersection.  Compute
//   convex-polygon overlap with the previous accepted keyframe's
//   plane-projected polygon via Sutherland-Hodgman clipping.
//   new_content_fraction = 1 − intersection_area / current_frame_area.
//   Accept iff new_content_fraction ≥ overlapThreshold (default 0.4)
//   and acceptedCount < maxCount (default 6).
//
// No-plane fallback:
//   When the host can't supply a plane (planeSource=Disabled, or
//   plane lock hasn't latched yet), the gate falls back to comparing
//   the camera-forward angular delta from the last accepted keyframe.
//   new_content = angularDelta / min(fovH, fovV).  Same accept rule.
//
// First/last frames:
//   - First frame is always accepted (anchor).
//   - markNextFrameAsLast() arms a one-shot "next frame is the
//     trailing keyframe, force-accept".  Set on shutter-release path
//     so we don't truncate the right edge of the scan.
//
// Threading: NOT thread-safe.  Caller must serialise evaluate() /
// reset() / markNextFrameAsLast() / setters.  On both platforms this
// is already guaranteed by the engine's work queue serial dispatch.

#pragma once

#include <cstdint>
#include "ar_frame_pose.h"

namespace retailens {

/// 1:1 with KeyframeGate.swift's `reason` strings.  An int enum
/// crosses the bridge cleanly; iOS/Android wrappers map back to
/// strings for telemetry.
enum class KeyframeGateDecisionReason : int32_t {
    // Accept reasons
    AcceptDisabled              = 0,   // "gate-disabled" — pass-through when !enabled
    AcceptForceLast             = 1,   // "force-last" — shutter-release force-accept
    AcceptFirstOnPlane          = 2,   // "first-anchored-on-plane"
    AcceptFirstNoPlane          = 3,   // "first-no-plane"
    AcceptOk                    = 4,   // "ok" — plane path
    AcceptOkAngular             = 5,   // "ok-angular" — no-plane fallback
    AcceptProjectionDegenerate  = 6,   // "projection-degenerate"
    AcceptCurrentAreaZero       = 7,   // "current-area-zero"
    AcceptNoPoseYet             = 8,   // "no-pose-yet" — defensive
    // Reject reasons
    RejectMaxReached            = 9,   // "max-reached"
    RejectOverlapTooHigh        = 10,  // "overlap-too-high"
    RejectOverlapTooHighAngular = 11,  // "overlap-too-high (angular)"
};

struct KeyframeGateDecision {
    bool       accept;
    KeyframeGateDecisionReason reason;
    double     newContentFraction;   // -1.0 when not computed (disabled / first / force-last)
    int32_t    acceptedCount;
    int32_t    maxCount;
};

/// Opaque handle — implementation kept in keyframe_gate.cpp via pImpl.
/// Lifetime is owned by the host wrapper (Obj-C++ object on iOS, JNI
/// `Long` handle on Android).
class KeyframeGate {
public:
    KeyframeGate();
    ~KeyframeGate();

    // Non-copyable, non-movable — the pImpl is heap-owned and the
    // bridges manage lifetime explicitly.
    KeyframeGate(const KeyframeGate&) = delete;
    KeyframeGate& operator=(const KeyframeGate&) = delete;
    KeyframeGate(KeyframeGate&&) = delete;
    KeyframeGate& operator=(KeyframeGate&&) = delete;

    // ── Settings (called between captures, not per-frame) ─────────
    void setEnabled(bool enabled);
    void setOverlapThreshold(double threshold);    // [0, 1]; default 0.4
    void setMaxCount(int32_t maxCount);            // ≥ 1; default 6
    void markNextFrameAsLast();                    // one-shot, consumed by next evaluate()
    void reset();                                  // clears acceptedCount, lastCorners, planeCached

    // ── Per-frame evaluation ──────────────────────────────────────
    //
    // @param pose          camera pose + intrinsics for the frame
    // @param latchedPlane  optional plane transform (column-major 4×4
    //                       matching ARKit ARPlaneAnchor convention).
    //                       Pass nullptr if no plane is latched →
    //                       gate uses angular-delta fallback.
    KeyframeGateDecision evaluate(const Pose& pose,
                                  const PlaneTransform* latchedPlane);

    // ── State accessors (read-only, post-evaluate) ────────────────
    int32_t getAcceptedCount() const;
    int32_t getMaxCount() const;
    bool    isEnabled() const;

private:
    struct Impl;
    Impl* pImpl_;

    // Shared angular-delta evaluation path.  Used by §4 (no plane was
    // ever latched) and §5's degenerate branches (V16 Phase 2 fix —
    // projection-degenerate / current-area-zero fall back here rather
    // than accepting blindly, which used to burst-accept every frame
    // and corrupt the gate cap).
    static KeyframeGateDecision evaluateAngularFallback(
        Impl& s, const Pose& pose);
};

} // namespace retailens
