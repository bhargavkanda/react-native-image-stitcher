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

/// Strategy selector — chooses how the gate measures "new content" for
/// the accept decision.  Set via `setStrategy(...)` between captures;
/// not safe to flip mid-capture.
///
///   Pose — the original V16-Phase-0 algorithm: project frame corners
///          onto the latched plane, compare polygon overlap.  Falls
///          back to camera-forward angular delta when projection
///          degenerates (no plane / behind-camera intersection).
///          Cheap but oversensitive when the latched plane covers a
///          small fraction of the visible frame: 6 cm of physical
///          motion at 2.7 m perpDist on a 0.4×1.6 m plane produced 6
///          accepts in 1 s (Ram report 2026-05-13).
///
///   Flow — V16 fix-attempt-8/A2: sparse Lucas-Kanade optical flow.
///          Detect Shi-Tomasi corners once per accepted keyframe;
///          track them into each incoming frame with
///          `calcOpticalFlowPyrLK`; accept when the median pan-axis
///          displacement crosses `overlapThreshold * frame_dim` (the
///          same 0.40 threshold as Pose, with directly-translatable
///          semantics: 40 % of frame dim = 40 % new content).  Costs
///          one detect (~15–25 ms) per accept + one track (~1–3 ms)
///          per frame.  Scale-invariant — independent of plane size.
///          Falls back to angular delta when feature tracking fails
///          (texture-poor scene / motion exceeds pyramid window).
///
/// Default is `Pose` to keep behaviour unchanged when this field
/// arrives unset.  The TS/host side flips to `Flow` via settings in a
/// follow-up commit.
enum class GateStrategy : int32_t {
    Pose = 0,
    Flow = 1,
};

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
    // Flow strategy reasons (V16 A2)
    AcceptOkFlow                = 12,  // "ok-flow" — flow median displacement crossed threshold
    AcceptFirstFlow             = 13,  // "first-flow" — first frame under flow strategy
    RejectOverlapTooHighFlow    = 14,  // "overlap-too-high (flow)"
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
    void reset();                                  // clears acceptedCount, lastCorners, planeCached AND flow state

    // ── Strategy selector + Flow params (V16 A2) ──────────────────
    // Flow params are only consulted when strategy == Flow.  Safe to
    // set when strategy == Pose; they'll be live the moment strategy
    // flips.  Defaults below are stable on iPhone 13/14/15 testing.
    void setStrategy(GateStrategy strategy);
    GateStrategy getStrategy() const;
    void setFlowMaxCorners(int32_t maxCorners);    // ≥ 30; default 150
    void setFlowQualityLevel(double quality);      // (0, 1]; default 0.01
    void setFlowMinDistance(double minDistance);   // ≥ 1.0; default 10.0 (working-resolution pixels)

    // ── Per-frame evaluation ──────────────────────────────────────
    //
    // Two overloads:
    //
    //   evaluate(pose, plane)
    //       Backward-compat entry point.  Used by callers that don't
    //       (yet) supply per-frame image data.  Always runs the Pose
    //       strategy regardless of `getStrategy()` — Flow needs the
    //       image to compute novelty, so Pose is the only thing it
    //       CAN do here.  Android JNI today calls this; the iOS side
    //       moves to `evaluateWithFrame` in commit 2.
    //
    //   evaluateWithFrame(pose, plane, grayData, width, height, stride)
    //       Strategy-aware entry point.  When strategy == Flow, runs
    //       sparse-flow novelty on the supplied grayscale frame.
    //       When strategy == Pose, behaves identically to `evaluate`
    //       (the frame data is ignored — no extra cost beyond the
    //       caller's pixel-buffer → grayscale conversion, which the
    //       caller can elide by checking strategy first).
    //
    // @param pose          camera pose + intrinsics for the frame
    // @param latchedPlane  optional plane transform (column-major 4×4
    //                       matching ARKit ARPlaneAnchor convention).
    //                       Pass nullptr if no plane is latched →
    //                       gate uses angular-delta fallback.
    // @param grayData      pointer to grayscale 8-bit pixel data.
    //                       Non-owning; data only needs to be valid
    //                       for the duration of this call.
    // @param width/height  frame dimensions in pixels.
    // @param stride        bytes per row (usually equal to width;
    //                       larger when the underlying buffer is
    //                       padded).
    KeyframeGateDecision evaluate(const Pose& pose,
                                  const PlaneTransform* latchedPlane);
    KeyframeGateDecision evaluateWithFrame(const Pose& pose,
                                           const PlaneTransform* latchedPlane,
                                           const uint8_t* grayData,
                                           int32_t width,
                                           int32_t height,
                                           int32_t stride);

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
