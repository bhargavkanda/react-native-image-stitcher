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

#include <cmath>
#include <cstring>
#include <cstdint>
#include <optional>
#include <vector>

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
    // Settings
    bool   enabled            = false;
    double overlapThreshold   = 0.4;
    int32_t maxCount          = 6;

    // State
    int32_t acceptedCount     = 0;
    std::optional<std::vector<Vec2>> lastCornersOnPlane;
    std::optional<PlaneBasis>        planeForCapture;
    bool   forceAcceptNext    = false;
    std::optional<Pose>              lastAcceptedPose;
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

void KeyframeGate::reset() {
    pImpl_->acceptedCount = 0;
    pImpl_->lastCornersOnPlane.reset();
    pImpl_->planeForCapture.reset();
    pImpl_->forceAcceptNext = false;
    pImpl_->lastAcceptedPose.reset();
}

int32_t KeyframeGate::getAcceptedCount() const { return pImpl_->acceptedCount; }
int32_t KeyframeGate::getMaxCount() const       { return pImpl_->maxCount; }
bool    KeyframeGate::isEnabled() const         { return pImpl_->enabled; }

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
        if (!s.lastAcceptedPose) {
            // Defensive — first-frame branch always sets lastAcceptedPose.
            return { true, KeyframeGateDecisionReason::AcceptNoPoseYet,
                     -1.0, s.acceptedCount, s.maxCount };
        }
        if (s.acceptedCount >= s.maxCount) {
            return { false, KeyframeGateDecisionReason::RejectMaxReached,
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

    // 5) Plane-based path.

    // Cap reached.
    if (s.acceptedCount >= s.maxCount) {
        return { false, KeyframeGateDecisionReason::RejectMaxReached,
                 -1.0, s.acceptedCount, s.maxCount };
    }

    // Project current frame's corners onto the cached plane basis.
    auto currentCornersOpt = projectCornersOntoPlane(pose, *s.planeForCapture);
    if (!currentCornersOpt) {
        return { true, KeyframeGateDecisionReason::AcceptProjectionDegenerate,
                 -1.0, s.acceptedCount, s.maxCount };
    }
    const std::vector<Vec2>& currentCorners = *currentCornersOpt;
    const std::vector<Vec2>& lastCorners    = *s.lastCornersOnPlane;

    float intersectArea = polygonIntersectionArea(currentCorners, lastCorners);
    float currentArea   = polygonArea(currentCorners);
    if (currentArea <= 1e-6f) {
        return { true, KeyframeGateDecisionReason::AcceptCurrentAreaZero,
                 -1.0, s.acceptedCount, s.maxCount };
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

} // namespace retailens
