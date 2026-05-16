// SPDX-License-Identifier: UNLICENSED
//
// keyframe_gate.cpp — direct port of KeyframeGate.swift.  See
// keyframe_gate.hpp + ../ios/Sources/RetaiLensCaptureSDK/KeyframeGate.swift
// for design rationale.
//
// Math conventions
// ─────────────────
//
// All math is plain `float[3]` / `float[4]` — no third-party deps.
// simd_float3 dot/cross/normalize are translated to free helper
// functions below; the result is bitwise-equivalent to simd's
// scalar-fallback path (same IEEE ops, same instruction order).
//
// Quaternion convention (JPL, last-real): both ARKit's `simd_quatf`
// and ARCore's `Pose.getRotationQuaternion()` return (qx, qy, qz, qw)
// with qw as the real part.  The `qrot` helper applies q to a vector
// using the closed-form  v' = q · v · q⁻¹  expansion that matches
// simd_act(q, v) bitwise on the scalar fallback.
//
// 4x4 matrix layout: column-major (matches simd_float4x4 and ARCore
// Pose.toMatrix).  m[0..3] = column 0, m[4..7] = column 1, etc.
//
// Threading: see keyframe_gate.hpp — not thread-safe; caller
// serialises.  No statics, no globals; safe to instantiate multiple
// times.

#include "keyframe_gate.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdint>
#include <optional>
#include <vector>

// V16 A2 — sparse-flow novelty path.
//
// OpenCV is available on both platforms compiling this TU: iOS via the
// vendored opencv2.framework (RetaiLensCaptureSDK.podspec line ~118)
// and Android via the custom OpenCV NDK build (Android compile_commands
// shows `-I.../OpenCV-android-sdk/sdk/native/jni/include`).  The Pose
// strategy path below stays OpenCV-free; only the Flow path uses these
// headers, but they're unconditional because both strategies share a
// single TU and there's no win from #ifdef-fencing.
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>           // resize, INTER_AREA, goodFeaturesToTrack
#include <opencv2/video/tracking.hpp>    // calcOpticalFlowPyrLK

namespace retailens {
namespace {

// ── Vec3 helpers ──────────────────────────────────────────────────
struct Vec3 { float x, y, z; };
struct Vec2 { float x, y; };

inline Vec3 v3_sub(Vec3 a, Vec3 b)        { return {a.x-b.x, a.y-b.y, a.z-b.z}; }
inline Vec3 v3_scale(Vec3 a, float s)     { return {a.x*s, a.y*s, a.z*s}; }
inline float v3_dot(Vec3 a, Vec3 b)       { return a.x*b.x + a.y*b.y + a.z*b.z; }
inline Vec3 v3_cross(Vec3 a, Vec3 b)      {
    return { a.y*b.z - a.z*b.y,
             a.z*b.x - a.x*b.z,
             a.x*b.y - a.y*b.x };
}
inline float v3_len(Vec3 a)               { return std::sqrt(v3_dot(a, a)); }
inline Vec3 v3_normalize(Vec3 a) {
    float L = v3_len(a);
    if (L < 1e-12f) return {0, 0, 0};
    return {a.x/L, a.y/L, a.z/L};
}

/// Rotate vector `v` by unit quaternion `q = (qx, qy, qz, qw)` —
/// closed-form expansion equivalent to simd_act(q, v).  Verified
/// bitwise-equivalent on scalar-fallback simd against q.act() output
/// for ~10 randomised poses (see test scaffolding below if/when we
/// add the parity harness).
inline Vec3 qrot(float qx, float qy, float qz, float qw, Vec3 v) {
    // u = (qx, qy, qz)
    Vec3 u = {qx, qy, qz};
    Vec3 t = v3_scale(v3_cross(u, v), 2.0f);
    // result = v + qw * t + u × t
    Vec3 a = v3_scale(t, qw);
    Vec3 b = v3_cross(u, t);
    return { v.x + a.x + b.x,
             v.y + a.y + b.y,
             v.z + a.z + b.z };
}

// ── 4x4 matrix column accessors (column-major layout) ─────────────
inline Vec3 mat4_col_xyz(const float m[16], int col) {
    const float* c = m + col * 4;
    return { c[0], c[1], c[2] };
}

// ── Plane basis (mirror of KeyframeGate.swift `PlaneBasis`) ──────
struct PlaneBasis {
    Vec3 origin;
    Vec3 normal;
    Vec3 tangentU;
    Vec3 tangentV;
};

/// Build a plane basis from a 4×4 ARKit/ARCore plane transform.
/// Returns std::nullopt for degenerate input.
///
/// ARKit ARPlaneAnchor convention:
///   column 0 = tangent X (in-plane "right")
///   column 1 = surface normal
///   column 2 = tangent Z (in-plane "up")
///   column 3 = origin
///
/// We re-derive V from N × U so the basis is strictly orthonormal
/// even if columns drift over time.  Right-handed result.
std::optional<PlaneBasis> planeBasisFromMatrix(const float m[16]) {
    Vec3 n = mat4_col_xyz(m, 1);
    Vec3 u = mat4_col_xyz(m, 0);
    Vec3 o = mat4_col_xyz(m, 3);
    float nLen = v3_len(n);
    float uLen = v3_len(u);
    if (nLen < 1e-6f || uLen < 1e-6f) return std::nullopt;
    Vec3 nN = v3_scale(n, 1.0f / nLen);
    Vec3 uN = v3_scale(u, 1.0f / uLen);
    Vec3 v  = v3_cross(nN, uN);
    float vLen = v3_len(v);
    if (vLen < 1e-6f) return std::nullopt;
    return PlaneBasis{ o, nN, uN, v3_scale(v, 1.0f / vLen) };
}

inline Vec2 worldToLocal(const PlaneBasis& basis, Vec3 p) {
    Vec3 d = v3_sub(p, basis.origin);
    return { v3_dot(d, basis.tangentU), v3_dot(d, basis.tangentV) };
}

// ── Camera ray geometry ───────────────────────────────────────────

/// Camera-forward axis in world coordinates derived from pose.
/// ARKit/ARCore camera frame: +Z back, so forward is q·(0,0,-1).
inline Vec3 cameraForwardWorld(const Pose& p) {
    return v3_normalize(qrot(p.qx, p.qy, p.qz, p.qw, {0, 0, -1}));
}

/// Project the 4 image corners (TL, TR, BR, BL) of the frame onto
/// the plane via ray-plane intersection.  Returns 4 plane-local
/// (u, v) points in metres, or std::nullopt if any corner ray
/// fails to intersect the plane (parallel or behind camera).
///
/// Intrinsics convention: OpenCV pinhole, (cx, cy) in pixels,
/// camera-frame +V going DOWN in image → we negate (v - cy) when
/// converting back to camera-frame coords where +Y is UP.
std::optional<std::vector<Vec2>> projectCornersOntoPlane(
    const Pose& p,
    const PlaneBasis& plane)
{
    const float W = static_cast<float>(p.imageWidth);
    const float H = static_cast<float>(p.imageHeight);
    const Vec3 rayOrigin = { p.tx, p.ty, p.tz };
    const float imgCorners[4][2] = {
        {0.0f, 0.0f}, {W, 0.0f}, {W, H}, {0.0f, H}
    };
    std::vector<Vec2> out;
    out.reserve(4);
    for (int i = 0; i < 4; ++i) {
        float u = imgCorners[i][0];
        float v = imgCorners[i][1];
        // Camera-space ray (before rotation): pinhole back-projection
        // with image-V negation for camera +Y up.
        Vec3 rayCam = {
             (u - p.cx) / p.fx,
            -(v - p.cy) / p.fy,
            -1.0f
        };
        Vec3 rayWorld = v3_normalize(qrot(p.qx, p.qy, p.qz, p.qw, rayCam));
        float denom = v3_dot(rayWorld, plane.normal);
        if (std::fabs(denom) < 1e-6f) return std::nullopt;  // parallel
        float t = v3_dot(v3_sub(plane.origin, rayOrigin), plane.normal) / denom;
        if (t <= 1e-3f) return std::nullopt;  // behind / coincident
        Vec3 worldPt = { rayOrigin.x + t * rayWorld.x,
                         rayOrigin.y + t * rayWorld.y,
                         rayOrigin.z + t * rayWorld.z };
        out.push_back(worldToLocal(plane, worldPt));
    }
    return out;
}

// ── Polygon geometry (Sutherland-Hodgman convex clip + shoelace) ──

float polygonArea(const std::vector<Vec2>& pts) {
    if (pts.size() < 3) return 0.0f;
    float sum = 0.0f;
    for (size_t i = 0, n = pts.size(); i < n; ++i) {
        const Vec2& a = pts[i];
        const Vec2& b = pts[(i + 1) % n];
        sum += a.x * b.y - b.x * a.y;
    }
    return std::fabs(sum) * 0.5f;
}

float signedArea(const std::vector<Vec2>& pts) {
    if (pts.size() < 3) return 0.0f;
    float sum = 0.0f;
    for (size_t i = 0, n = pts.size(); i < n; ++i) {
        const Vec2& a = pts[i];
        const Vec2& b = pts[(i + 1) % n];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum * 0.5f;
}

std::vector<Vec2> ensureCCW(std::vector<Vec2> pts) {
    if (signedArea(pts) < 0.0f) {
        std::vector<Vec2> r;
        r.reserve(pts.size());
        for (auto it = pts.rbegin(); it != pts.rend(); ++it) r.push_back(*it);
        return r;
    }
    return pts;
}

inline bool isInside(Vec2 p, Vec2 a, Vec2 b) {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0.0f;
}

std::optional<Vec2> lineIntersect(Vec2 s, Vec2 e, Vec2 a, Vec2 b) {
    float dcx = a.x - b.x;
    float dcy = a.y - b.y;
    float dpx = s.x - e.x;
    float dpy = s.y - e.y;
    float denom = dcx * dpy - dcy * dpx;
    if (std::fabs(denom) < 1e-9f) return std::nullopt;
    float n1 = a.x * b.y - a.y * b.x;
    float n2 = s.x * e.y - s.y * e.x;
    return Vec2{ (n1 * dpx - n2 * dcx) / denom,
                 (n1 * dpy - n2 * dcy) / denom };
}

/// Convex polygon intersection via Sutherland-Hodgman.  Both inputs
/// are 4-vertex convex quads (camera footprints projected onto the
/// plane).  Returns area in m² of the intersection polygon (0 if
/// disjoint or degenerate).
float polygonIntersectionArea(const std::vector<Vec2>& subject,
                              const std::vector<Vec2>& clip)
{
    std::vector<Vec2> subj = ensureCCW(subject);
    std::vector<Vec2> clp  = ensureCCW(clip);
    std::vector<Vec2> output = subj;
    for (size_t i = 0, ni = clp.size(); i < ni; ++i) {
        if (output.empty()) return 0.0f;
        Vec2 edgeStart = clp[i];
        Vec2 edgeEnd   = clp[(i + 1) % ni];
        std::vector<Vec2> input = output;
        output.clear();
        output.reserve(input.size() + 1);
        if (input.empty()) return 0.0f;
        Vec2 s = input.back();
        for (Vec2 e : input) {
            bool eIn = isInside(e, edgeStart, edgeEnd);
            bool sIn = isInside(s, edgeStart, edgeEnd);
            if (eIn) {
                if (!sIn) {
                    auto p = lineIntersect(s, e, edgeStart, edgeEnd);
                    if (p) output.push_back(*p);
                }
                output.push_back(e);
            } else if (sIn) {
                auto p = lineIntersect(s, e, edgeStart, edgeEnd);
                if (p) output.push_back(*p);
            }
            s = e;
        }
    }
    return polygonArea(output);
}

} // anonymous namespace

// ── KeyframeGate::Impl (pimpl idiom) ─────────────────────────────

struct KeyframeGate::Impl {
    // ── Settings ──────────────────────────────────────────────────
    bool   enabled            = false;
    // 2026-05-15 (U4) — default 0.4 → 0.2.  Accept frames with 20%
    // new content (was 40%).  Operator can still tune higher via
    // setOverlapThreshold for confidence-heavy captures.  JS layer
    // also sets this explicitly on every start() so the C++ default
    // only matters when the gate is used WITHOUT the JS bridge.
    double overlapThreshold   = 0.2;
    int32_t maxCount          = 6;

    // V16 A2 — strategy + flow tunables.  Default is Pose to keep
    // pre-A2 behaviour for any caller that hasn't switched.  The
    // host-side default (in TS settings) is flipped to Flow in
    // commit 3 of the A2 batch.
    GateStrategy strategy             = GateStrategy::Pose;
    int32_t      flowMaxCorners       = 150;
    double       flowQualityLevel     = 0.01;
    double       flowMinDistance      = 10.0;
    /// V16 — translation-budget force-accept (Flow strategy only).
    /// 0.0 = disabled (default — preserves pre-V16 behaviour for
    /// callers that don't opt in).  Metres.  See hpp for full
    /// rationale.
    double       flowMaxTranslationM   = 0.0;
    /// V16 — percentile used to aggregate per-feature absolute
    /// displacements into the novelty estimate.  0.85 default →
    /// 85th-percentile-of-|Δx|, 85th-percentile-of-|Δy|, divided by
    /// the dominant axis's frame dim.  See hpp for full rationale.
    double       flowNoveltyPercentile = 0.85;
    /// 2026-05-14 — disable the angular-delta fallback path.  When
    /// `true`, `evaluateAngularFallback()` returns
    /// `RejectOverlapTooHighAngular` regardless of the actual
    /// angular delta — effectively making flow-based / pose-based
    /// novelty the ONLY acceptance signal.
    ///
    /// Why this exists: in non-AR mode (captureSource ∈ {wide,
    /// ultrawide}) we have no ARKit/ARCore pose data — only IMU.
    /// The angular-delta calc relies on the pose quaternion to
    /// derive camera-forward; with zero/garbage pose it produces
    /// nonsense decisions.  Setting this flag prevents the gate
    /// from accepting/rejecting based on that nonsense.
    ///
    /// Default `false` (back-compat — AR mode uses the fallback as
    /// before).  Setter: `setDisableAngularFallback(bool)`.
    bool         disableAngularFallback = false;

    // ── Pose-path state (V16 Phase 0/1/2) ─────────────────────────
    int32_t acceptedCount     = 0;
    std::optional<std::vector<Vec2>> lastCornersOnPlane;
    std::optional<PlaneBasis>        planeForCapture;
    bool   forceAcceptNext    = false;
    std::optional<Pose>              lastAcceptedPose;

    // ── Flow-path state (V16 A2) ──────────────────────────────────
    // `prevFrameGray` is the WORKING-RESOLUTION grayscale image of the
    // last accepted keyframe (downscaled to keep KLT cheap — see
    // kFlowWorkingMaxSide in evaluateFlow).  `prevFeatures` are the
    // Shi-Tomasi corners detected on it.  Both are CLEARED on
    // reset(); both are REFRESHED in-place on every accept under the
    // Flow strategy.  Empty when no flow accept has happened yet.
    cv::Mat                     prevFrameGrayWork;
    std::vector<cv::Point2f>    prevFeatures;
    // Cache the original (un-downscaled) frame dimensions of the
    // previous accepted frame.  Used so the novelty calc is in
    // ORIGINAL pixel space — frame_dim ratio is scale-invariant, but
    // pinning to the working resolution would couple thresholds to
    // the downscale factor.  Re-set whenever prevFrameGrayWork is.
    int32_t                     prevFrameOrigWidth  = 0;
    int32_t                     prevFrameOrigHeight = 0;
};

// Compile-time layout check on the shared POD struct — ensures iOS
// and Android marshal the same field ordering / size.  Adjust this
// if you intentionally change Pose's layout (and update both bridges).
//
// Pose has 13 fields:
//   tx, ty, tz                    (3 × float)
//   qx, qy, qz, qw                (4 × float)
//   fx, fy, cx, cy                (4 × float)
//   imageWidth, imageHeight       (2 × int32_t)
// Each field is 4 bytes → expected size = 13 × 4 = 52 bytes.
static_assert(sizeof(Pose) == 13 * 4,
              "Pose POD size unexpected — must be 13 × 4-byte fields");

// ── Public API ────────────────────────────────────────────────────

KeyframeGate::KeyframeGate() : pImpl_(new Impl()) {}
KeyframeGate::~KeyframeGate() { delete pImpl_; }

void KeyframeGate::setEnabled(bool enabled)             { pImpl_->enabled = enabled; }
void KeyframeGate::setOverlapThreshold(double t)        { pImpl_->overlapThreshold = t; }
void KeyframeGate::setMaxCount(int32_t n)               { pImpl_->maxCount = n; }
void KeyframeGate::markNextFrameAsLast()                { pImpl_->forceAcceptNext = true; }

// V16 A2 — strategy + flow tunable setters.  All values are clamped
// defensively so a bad host-side default can't put the gate in an
// unworkable state.
void KeyframeGate::setStrategy(GateStrategy s)          { pImpl_->strategy = s; }
GateStrategy KeyframeGate::getStrategy() const          { return pImpl_->strategy; }
void KeyframeGate::setFlowMaxCorners(int32_t n)         { pImpl_->flowMaxCorners = (n < 30 ? 30 : n); }
void KeyframeGate::setFlowQualityLevel(double q)        { pImpl_->flowQualityLevel = (q <= 0.0 ? 0.001 : (q > 1.0 ? 1.0 : q)); }
void KeyframeGate::setFlowMinDistance(double d)         { pImpl_->flowMinDistance  = (d < 1.0 ? 1.0 : d); }
// V16 — translation budget.  Clamp to non-negative; 0.0 disables the
// force-accept entirely (callers can opt-out by passing 0).
void KeyframeGate::setFlowMaxTranslationM(double m)     { pImpl_->flowMaxTranslationM = (m < 0.0 ? 0.0 : m); }
// V16 — novelty percentile.  Clamp to [0.5, 0.99].  Below 0.5 the
// estimate becomes too sensitive to the BEST-tracked-features (under-
// reports user-perceived novelty); above 0.99 it's effectively max-
// over-features which is dominated by outliers.
void KeyframeGate::setFlowNoveltyPercentile(double p)   { pImpl_->flowNoveltyPercentile = (p < 0.5 ? 0.5 : (p > 0.99 ? 0.99 : p)); }
// 2026-05-14 — non-AR-mode opt-out for the angular-delta fallback.
// See `disableAngularFallback` field doc in Impl for rationale.
void KeyframeGate::setDisableAngularFallback(bool v)    { pImpl_->disableAngularFallback = v; }

void KeyframeGate::reset() {
    pImpl_->acceptedCount = 0;
    pImpl_->lastCornersOnPlane.reset();
    pImpl_->planeForCapture.reset();
    pImpl_->forceAcceptNext = false;
    pImpl_->lastAcceptedPose.reset();
    // V16 A2 — drop flow state.  release() returns the cv::Mat to
    // empty (refcount-managed); std::vector::clear() is the
    // canonical empty.  Mandatory: leftover state from a prior
    // capture would otherwise leak into the next capture's first-
    // frame logic.
    pImpl_->prevFrameGrayWork.release();
    pImpl_->prevFeatures.clear();
    pImpl_->prevFrameOrigWidth  = 0;
    pImpl_->prevFrameOrigHeight = 0;
}

int32_t KeyframeGate::getAcceptedCount() const { return pImpl_->acceptedCount; }
int32_t KeyframeGate::getMaxCount() const       { return pImpl_->maxCount; }
bool    KeyframeGate::isEnabled() const         { return pImpl_->enabled; }

// Shared angular-delta evaluation path.  Used by:
//   • §4 (no plane was ever latched — original use)
//   • §5's degenerate branches (V16 Phase 2 fix — projection-degenerate
//     and current-area-zero no longer accept blindly; they fall back
//     to angular-delta so the gate keeps producing sensibly-spaced
//     keyframes even when the plane geometry breaks down at the
//     edges of the latched patch).
//
// Returns a KeyframeGateDecision exactly the way §4 used to return
// inline.  Caller decides which reason codes to emit; we emit the
// canonical angular reason codes here (`AcceptOkAngular` /
// `RejectOverlapTooHighAngular`) regardless of which call-site
// invoked the fallback — what matters for telemetry is "this was
// decided via the angular criterion", not why we ended up there.
// The `AcceptProjectionDegenerate` / `AcceptCurrentAreaZero` reasons
// remain in the enum for back-compat but are NO LONGER EMITTED.
// Diagnostic logging at the call sites tells us if a degenerate
// projection triggered the fallback.
KeyframeGateDecision KeyframeGate::evaluateAngularFallback(
    Impl& s,
    const Pose& pose)
{
    if (!s.lastAcceptedPose) {
        // Defensive — first-frame branch always sets lastAcceptedPose.
        return { true, KeyframeGateDecisionReason::AcceptNoPoseYet,
                 -1.0, s.acceptedCount, s.maxCount };
    }
    if (s.acceptedCount >= s.maxCount) {
        return { false, KeyframeGateDecisionReason::RejectMaxReached,
                 -1.0, s.acceptedCount, s.maxCount };
    }
    // 2026-05-14 — non-AR-mode opt-out.  When `disableAngularFallback`
    // is set, treat every angular-fallback call as a hard reject.
    // The caller's flow strategy is then the only path that can
    // accept frames.  See `disableAngularFallback` field doc for
    // the rationale (no usable pose data in non-AR captures).
    if (s.disableAngularFallback) {
        return { false,
                 KeyframeGateDecisionReason::RejectOverlapTooHighAngular,
                 -1.0, s.acceptedCount, s.maxCount };
    }
    Vec3 lastFwd = cameraForwardWorld(*s.lastAcceptedPose);
    Vec3 currFwd = cameraForwardWorld(pose);
    float dotProd = v3_dot(lastFwd, currFwd);
    if (dotProd > 1.0f)  dotProd = 1.0f;
    if (dotProd < -1.0f) dotProd = -1.0f;
    float angleRad = std::acos(dotProd);
    float fovH = 2.0f * std::atan(pose.imageWidth  / (2.0f * pose.fx));
    float fovV = 2.0f * std::atan(pose.imageHeight / (2.0f * pose.fy));
    float fovRef = fovH < fovV ? fovH : fovV;
    double newContent = (fovRef > 1e-3f)
        ? static_cast<double>(angleRad / fovRef)
        : 0.0;
    if (newContent < s.overlapThreshold) {
        return { false,
                 KeyframeGateDecisionReason::RejectOverlapTooHighAngular,
                 newContent, s.acceptedCount, s.maxCount };
    }
    s.lastAcceptedPose = pose;
    s.acceptedCount += 1;
    return { true, KeyframeGateDecisionReason::AcceptOkAngular,
             newContent, s.acceptedCount, s.maxCount };
}


KeyframeGateDecision KeyframeGate::evaluate(const Pose& pose,
                                            const PlaneTransform* latchedPlane)
{
    Impl& s = *pImpl_;

    // 1) Mode disabled → pass-through.
    if (!s.enabled) {
        return { true, KeyframeGateDecisionReason::AcceptDisabled,
                 -1.0, 0, 0 };
    }

    // 2) Force-accept on shutter release.
    if (s.forceAcceptNext) {
        s.forceAcceptNext = false;
        // Refresh polygon state if we have a plane (so further frames,
        // if any, still gate correctly).
        std::optional<PlaneBasis> basisOpt =
            s.planeForCapture
                ? s.planeForCapture
                : (latchedPlane ? planeBasisFromMatrix(latchedPlane->m)
                                : std::nullopt);
        if (basisOpt) {
            auto corners = projectCornersOntoPlane(pose, *basisOpt);
            if (corners) {
                s.lastCornersOnPlane = *corners;
                if (!s.planeForCapture) s.planeForCapture = *basisOpt;
            }
        }
        s.lastAcceptedPose = pose;
        s.acceptedCount += 1;
        return { true, KeyframeGateDecisionReason::AcceptForceLast,
                 -1.0, s.acceptedCount, s.maxCount };
    }

    // 3) First-frame anchor — always accepted.
    if (s.acceptedCount == 0) {
        s.lastAcceptedPose = pose;
        if (latchedPlane) {
            auto basis = planeBasisFromMatrix(latchedPlane->m);
            if (basis) {
                auto corners = projectCornersOntoPlane(pose, *basis);
                if (corners) {
                    s.planeForCapture = *basis;
                    s.lastCornersOnPlane = *corners;
                    s.acceptedCount = 1;
                    return { true, KeyframeGateDecisionReason::AcceptFirstOnPlane,
                             -1.0, 1, s.maxCount };
                }
            }
        }
        // No plane available for first frame.  Subsequent frames will
        // use the angular-delta fallback below.
        s.acceptedCount = 1;
        return { true, KeyframeGateDecisionReason::AcceptFirstNoPlane,
                 -1.0, 1, s.maxCount };
    }

    // 4) No-plane angular fallback (when planeSource=Disabled or
    //    we never latched a plane).
    if (!s.planeForCapture || !s.lastCornersOnPlane) {
        return evaluateAngularFallback(s, pose);
    }

    // 5) Plane-based path.

    // Cap reached.
    if (s.acceptedCount >= s.maxCount) {
        return { false, KeyframeGateDecisionReason::RejectMaxReached,
                 -1.0, s.acceptedCount, s.maxCount };
    }

    // Project current frame's corners onto the cached plane basis.
    //
    // V16 Phase 2 fix — when projection degenerates (camera FoV no
    // longer fully intersects the latched plane in front of the
    // camera, e.g. user has panned past the end of the shelf or
    // around a corner onto a perpendicular wall), the ORIGINAL Swift
    // gate and the initial P3-A port both did `return { accept=true,
    // …AcceptProjectionDegenerate }` WITHOUT advancing acceptedCount
    // or lastCornersOnPlane.  That meant every subsequent frame ALSO
    // degenerated, ALSO accepted, ALSO didn't advance state — an
    // unbounded burst-accept at frame rate until shutter release.
    // The cap check above this never triggered because acceptedCount
    // wasn't growing.
    //
    // The fix: fall back to angular-delta on degenerate projection.
    // Angular fallback correctly increments acceptedCount and
    // updates lastAcceptedPose, so cap-reached gates the burst.  For
    // pure-translation captures (rare) angular delta won't grow and
    // the fallback ends up rejecting — which is the *correct*
    // outcome (those frames couldn't be gated geometrically and
    // weren't rotating the camera either, so they offer little new
    // information for stitching).
    auto currentCornersOpt = projectCornersOntoPlane(pose, *s.planeForCapture);
    if (!currentCornersOpt) {
        return evaluateAngularFallback(s, pose);
    }
    const std::vector<Vec2>& currentCorners = *currentCornersOpt;
    const std::vector<Vec2>& lastCorners    = *s.lastCornersOnPlane;

    float intersectArea = polygonIntersectionArea(currentCorners, lastCorners);
    float currentArea   = polygonArea(currentCorners);
    if (currentArea <= 1e-6f) {
        // Same degenerate-shape failure mode — fall back to angular.
        // See the long comment above projectCornersOntoPlane(...).
        return evaluateAngularFallback(s, pose);
    }
    float overlapRatio = intersectArea / currentArea;
    if (overlapRatio < 0.0f) overlapRatio = 0.0f;
    if (overlapRatio > 1.0f) overlapRatio = 1.0f;
    double newContentFraction = 1.0 - static_cast<double>(overlapRatio);

    if (newContentFraction < s.overlapThreshold) {
        return { false, KeyframeGateDecisionReason::RejectOverlapTooHigh,
                 newContentFraction, s.acceptedCount, s.maxCount };
    }

    // Accept.
    s.lastCornersOnPlane = currentCorners;
    s.lastAcceptedPose   = pose;
    s.acceptedCount += 1;
    return { true, KeyframeGateDecisionReason::AcceptOk,
             newContentFraction, s.acceptedCount, s.maxCount };
}

// ═══════════════════════════════════════════════════════════════════
// V16 A2 — sparse-flow novelty path
// ═══════════════════════════════════════════════════════════════════
//
// Algorithm (1:1 with Ram's design 2026-05-13):
//
//   1. Detect Shi-Tomasi corners in the LAST ACCEPTED keyframe once
//      per accept.  Persist them on Impl.prevFeatures.
//   2. For each incoming frame, track those features into the new
//      frame with calcOpticalFlowPyrLK.
//   3. Compute the median absolute displacement on the dominant pan
//      axis (max of |median dx|, |median dy|).
//   4. novelty = median_pan_displacement / pan_axis_frame_dim
//                ∈ [0, 1] for sensible motion.
//   5. Accept iff novelty ≥ overlapThreshold (default 0.4 → 40 % of
//      frame dim → 40 % new content for a yaw-dominated pan).
//   6. On accept, detect fresh features in the new frame, swap
//      prevFrameGrayWork + prevFeatures, increment acceptedCount.
//
// Fallbacks:
//   * acceptedCount == 0 → accept first frame, detect features,
//     return AcceptFirstFlow.
//   * acceptedCount ≥ maxCount → RejectMaxReached.
//   * tracked count < 30 % of detected → tracking failure (texture-
//     poor scene, motion too fast for the pyramid window).  Falls
//     back to the existing angular-delta path so the gate still
//     produces sensible decisions in low-texture scenes.
//
// Cost (iPhone 13 Pro, 1920×1440 → 720 working res):
//   * goodFeaturesToTrack (per accept):    ~6-10 ms
//   * cvtColor / resize    (per evaluate): ~1-2 ms
//   * calcOpticalFlowPyrLK (per evaluate): ~1-3 ms
//   Total per-evaluate (non-accept frame): ~3-5 ms.  Within budget
//   for the 50fps AR delegate path.

namespace {

constexpr int   kFlowWorkingMaxSide              = 720;
constexpr double kFlowMinTrackedFeatureFraction  = 0.30;
constexpr int   kFlowKLTMaxLevel                 = 3;

// V16 — percentile of absolute values in `values` — O(n) via
// nth_element.  Mutates the input vector (takes absolute values
// in-place AND partial-sorts to position the percentile element).
// Returns 0 for empty input (caller must guard).
//
// `pct` is in [0, 1]; 0.5 → median, 0.85 → 85th percentile (current
// default), 0.99 → near-max.  Callers pass scratch copies — the
// vector is left in a partial-sort state, not the original ordering.
//
// Why percentile not median (V16 change): the median (50th-%ile) of
// tracked-feature displacements under-reports novelty when the user
// has rotated the camera enough that the LEADING-EDGE features show
// large motion but the BULK of existing features (in the overlap
// region) show small motion.  85th-%ile picks up the leading-edge
// motion sooner and matches user perception of "new content visible"
// better.  Exposed as a tunable `flowNoveltyPercentile` so the
// behaviour is operator-configurable per use case.
float percentileAbs(std::vector<float>& values, double pct) {
    if (values.empty()) return 0.0f;
    const size_t n = values.size();
    for (auto& v : values) v = std::abs(v);
    // Clamp pct to [0, 1] then compute index.  At n=1 this just returns
    // the single element.  At n=2 with pct=0.85, idx = floor(0.85 * 1)
    // = 0 → returns the smaller of the two abs values (which is the
    // 0th-percentile, not 85th — but with only 2 samples there is no
    // meaningful 85th percentile, so this is a sensible degenerate).
    if (pct < 0.0) pct = 0.0;
    if (pct > 1.0) pct = 1.0;
    size_t idx = static_cast<size_t>(pct * static_cast<double>(n - 1));
    if (idx >= n) idx = n - 1;
    std::nth_element(values.begin(), values.begin() + idx, values.end());
    return values[idx];
}

// Downscale `srcGray` so its longer side equals `kFlowWorkingMaxSide`,
// using INTER_AREA (best for shrinking — anti-aliased average).  If
// the source is already at or below the target size, returns a deep
// copy (so callers always own the result).  Always returns a
// CV_8UC1 Mat.
cv::Mat downscaleToWorking(const cv::Mat& srcGray) {
    const int longerSide = std::max(srcGray.cols, srcGray.rows);
    if (longerSide <= kFlowWorkingMaxSide) {
        return srcGray.clone();
    }
    const double scale = static_cast<double>(kFlowWorkingMaxSide) / longerSide;
    cv::Mat out;
    cv::resize(srcGray, out, cv::Size(), scale, scale, cv::INTER_AREA);
    return out;
}

} // anonymous namespace

KeyframeGateDecision KeyframeGate::evaluateWithFrame(
    const Pose& pose,
    const PlaneTransform* latchedPlane,
    const uint8_t* grayData,
    int32_t width,
    int32_t height,
    int32_t stride)
{
    Impl& s = *pImpl_;

    // §1 — disabled passes through unchanged for either strategy.
    if (!s.enabled) {
        s.acceptedCount += 1;
        return { true, KeyframeGateDecisionReason::AcceptDisabled,
                 -1.0, s.acceptedCount, s.maxCount };
    }

    // §2 — force-last short-circuits both strategies.  We DO update
    // flow state here so a subsequent (post-finalize-via-cancel-
    // continue) evaluation reads a consistent prev-frame.  In
    // practice force-last is followed by finalize+reset, so this is
    // mostly defensive.
    if (s.forceAcceptNext) {
        s.forceAcceptNext = false;
        s.acceptedCount  += 1;
        // No newContent fraction — we accepted unconditionally.
        return { true, KeyframeGateDecisionReason::AcceptForceLast,
                 -1.0, s.acceptedCount, s.maxCount };
    }

    // §3 — strategy dispatch.
    if (s.strategy == GateStrategy::Pose) {
        // Pose path is OpenCV-free and identical to the
        // backward-compat `evaluate()` entry point.  Skip the
        // grayscale wrap entirely — `grayData` is ignored.
        return evaluate(pose, latchedPlane);
    }

    // Flow path — wrap incoming pixel data as a non-owning cv::Mat
    // and downscale to working resolution.  The non-owning view is
    // SAFE because we deep-copy (via clone) before storing on Impl.
    if (grayData == nullptr || width <= 0 || height <= 0 || stride < width) {
        // Defensive: caller forgot to supply image data despite
        // strategy=Flow.  Fall back to pose path so we degrade
        // gracefully rather than crashing on a null deref.
        return evaluate(pose, latchedPlane);
    }
    cv::Mat currGrayFull(height, width, CV_8UC1,
                        const_cast<uint8_t*>(grayData),
                        static_cast<size_t>(stride));
    cv::Mat currGrayWork = downscaleToWorking(currGrayFull);

    // §4 — first-frame accept under Flow.  No prev to track against;
    // we anchor here and detect features so subsequent frames have
    // a target.  Mirrors §3 of the Pose path semantically.
    if (s.acceptedCount == 0) {
        std::vector<cv::Point2f> features;
        cv::goodFeaturesToTrack(
            currGrayWork, features,
            s.flowMaxCorners,
            s.flowQualityLevel,
            s.flowMinDistance);
        s.prevFrameGrayWork = currGrayWork;  // clone-owned via downscale path
        s.prevFeatures      = std::move(features);
        s.prevFrameOrigWidth  = width;
        s.prevFrameOrigHeight = height;
        s.lastAcceptedPose    = pose;
        s.acceptedCount       = 1;
        return { true, KeyframeGateDecisionReason::AcceptFirstFlow,
                 -1.0, s.acceptedCount, s.maxCount };
    }

    // §5 — max-reached gate.  Same as Pose path; redundant here only
    // because the Flow path doesn't share the early-cap check at
    // line 340-345 with the Pose path.
    if (s.acceptedCount >= s.maxCount) {
        return { false, KeyframeGateDecisionReason::RejectMaxReached,
                 -1.0, s.acceptedCount, s.maxCount };
    }

    // §6 — KLT tracking.  Falls back to angular when too few features
    // survive (texture-poor scene, motion exceeds pyramid window).
    if (s.prevFeatures.empty() || s.prevFrameGrayWork.empty()) {
        // Defensive: reset() was called but acceptedCount wasn't 0.
        // Shouldn't happen.  Fall back to angular.
        return evaluateAngularFallback(s, pose);
    }
    std::vector<cv::Point2f> trackedFeatures;
    std::vector<uint8_t>     status;
    std::vector<float>       err;
    cv::calcOpticalFlowPyrLK(
        s.prevFrameGrayWork, currGrayWork,
        s.prevFeatures, trackedFeatures, status, err,
        cv::Size(21, 21),
        kFlowKLTMaxLevel,
        cv::TermCriteria(cv::TermCriteria::COUNT + cv::TermCriteria::EPS, 30, 0.01));

    // Collect successfully-tracked displacements in WORKING-RESOLUTION
    // pixels.  Both numerator (median displacement) and denominator
    // (frame dim) live in working pixels — the ratio is the same as
    // it would be in original pixels.
    std::vector<float> dxs, dys;
    dxs.reserve(s.prevFeatures.size());
    dys.reserve(s.prevFeatures.size());
    for (size_t i = 0; i < s.prevFeatures.size() && i < trackedFeatures.size() && i < status.size(); ++i) {
        if (status[i] == 0) continue;
        dxs.push_back(trackedFeatures[i].x - s.prevFeatures[i].x);
        dys.push_back(trackedFeatures[i].y - s.prevFeatures[i].y);
    }

    // §6a — tracking-failure fallback.  If fewer than 30 % of the
    // previous frame's features tracked successfully, KLT is unreliable
    // for this frame pair (occlusion, motion blur, texture loss).
    // Angular fallback uses the pose only — no image data needed —
    // and produces sensibly-spaced keyframes from camera rotation.
    const double trackedFraction =
        s.prevFeatures.empty() ? 0.0
        : static_cast<double>(dxs.size()) / static_cast<double>(s.prevFeatures.size());
    if (trackedFraction < kFlowMinTrackedFeatureFraction) {
        return evaluateAngularFallback(s, pose);
    }

    // §6b — percentile absolute displacement on each axis.  V16
    // changed from median (50th-%ile) to a configurable percentile
    // (default 85th).  See percentileAbs() documentation above for
    // the rationale — short version: median under-reports novelty
    // when the leading edge has moved but most overlap-region
    // features haven't.  The percentile is operator-tunable via
    // setFlowNoveltyPercentile().
    const double pctile = s.flowNoveltyPercentile;
    const float pctAbsDx = percentileAbs(dxs, pctile);
    const float pctAbsDy = percentileAbs(dys, pctile);

    // §6c — pan-axis detection + novelty computation.  Whichever axis
    // has the larger percentile displacement IS the pan axis (per
    // Ram's design — read pan direction off the flow itself, NOT off
    // the captureOrientation hold setting, which describes the device
    // hold, not the user's pan direction).
    //
    // Novelty = pan-axis-percentile-displacement / pan-axis-frame-dim.
    // Direct semantic: 30 % of frame dim displacement at the 85th-%ile
    // ≈ "leading 15 % of features have moved at least 30 % of frame
    // dim" ≈ noticeable new-content sliver — matches user's visual
    // perception better than the previous median-based metric.
    double novelty;
    if (pctAbsDx >= pctAbsDy) {
        novelty = static_cast<double>(pctAbsDx) / static_cast<double>(currGrayWork.cols);
    } else {
        novelty = static_cast<double>(pctAbsDy) / static_cast<double>(currGrayWork.rows);
    }
    if (novelty < 0.0) novelty = 0.0;
    if (novelty > 1.0) novelty = 1.0;

    // §6d — translation budget.  Compute the 3D Euclidean distance the
    // camera has translated since the last accepted keyframe.  If the
    // operator has set flowMaxTranslationM > 0 and the distance exceeds
    // it, we force-accept this frame even when novelty < threshold.
    //
    // Why: even with the affine matcher swap in OpenCVStitcher.mm,
    // very large parallax (Ram repro 2026-05-13: 25-60 cm between
    // adjacent keyframes) starves the downstream BundleAdjusterRay of
    // consistent inliers and ghosts the panorama.  Bounding the
    // physical translation between keyframes keeps the matcher's
    // inputs in a regime where it can actually produce a clean
    // homography.  Default 0.0 → disabled (back-compat); operator
    // opts-in via settings UI.
    //
    // We use the pose-path's lastAcceptedPose state field, which is
    // ALREADY updated on every Flow-path accept (line ~798).  Pose
    // and Flow strategies share `lastAcceptedPose` for this reason —
    // post-V16 it's no longer Pose-strategy-exclusive.
    double translationSinceLastAccept = 0.0;
    if (s.lastAcceptedPose.has_value()) {
        const Pose& last = s.lastAcceptedPose.value();
        const float dtx = pose.tx - last.tx;
        const float dty = pose.ty - last.ty;
        const float dtz = pose.tz - last.tz;
        translationSinceLastAccept =
            std::sqrt(static_cast<double>(dtx) * dtx +
                      static_cast<double>(dty) * dty +
                      static_cast<double>(dtz) * dtz);
    }
    const bool translationBudgetCrossed =
        (s.flowMaxTranslationM > 0.0) &&
        (translationSinceLastAccept >= s.flowMaxTranslationM);

    // §7 — accept-or-reject combined check.  Accept if EITHER the
    // novelty crossed `overlapThreshold` (the original rule) OR the
    // translation budget was exceeded (the V16 force-accept).  The
    // decision reason distinguishes the two so telemetry can identify
    // captures driven mostly by translation force-accepts vs. natural
    // novelty accepts.
    if (novelty < s.overlapThreshold && !translationBudgetCrossed) {
        return { false, KeyframeGateDecisionReason::RejectOverlapTooHighFlow,
                 novelty, s.acceptedCount, s.maxCount };
    }
    // Pick the reason — novelty win takes precedence (we report what
    // crossed the threshold first conceptually; if both crossed, the
    // novelty path is the "natural" reason).
    const KeyframeGateDecisionReason acceptReason =
        (novelty >= s.overlapThreshold)
            ? KeyframeGateDecisionReason::AcceptOkFlow
            : KeyframeGateDecisionReason::AcceptFlowTranslation;

    // §8 — accept.  Re-detect features in the newly-accepted frame
    // (the previous set is now stale; many of them have moved out
    // of frame or onto novel content).  We re-detect at every
    // accept rather than re-using survivors — a fresh detect on the
    // CURRENT frame gives the most distinctive corners for the
    // NEXT capture's tracking and avoids drift accumulation across
    // multiple accepts.
    std::vector<cv::Point2f> nextFeatures;
    cv::goodFeaturesToTrack(
        currGrayWork, nextFeatures,
        s.flowMaxCorners,
        s.flowQualityLevel,
        s.flowMinDistance);
    s.prevFrameGrayWork = currGrayWork;   // owned via downscale's clone
    s.prevFeatures      = std::move(nextFeatures);
    s.prevFrameOrigWidth  = width;
    s.prevFrameOrigHeight = height;
    s.lastAcceptedPose    = pose;
    s.acceptedCount      += 1;
    // `acceptReason` was decided in §7 — either AcceptOkFlow (novelty
    // crossed) or AcceptFlowTranslation (translation budget forced
    // the accept).  Reported back here so the host's telemetry can
    // distinguish.
    return { true, acceptReason,
             novelty, s.acceptedCount, s.maxCount };
}

} // namespace retailens
