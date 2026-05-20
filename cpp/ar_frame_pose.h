// SPDX-License-Identifier: Apache-2.0
//
// ar_frame_pose.h — POD struct shared between iOS and Android for AR
// frame pose data crossing the C++ boundary.
//
// Both platforms marshal their native pose representation into this
// flat struct:
//   - iOS:    RNSARFramePose (Swift) → KeyframeGateBridge.mm
//             unmarshals Swift Doubles → C++ floats.
//   - Android: RNSARFramePose (Kotlin data class) → JNI
//             unmarshals JVM doubles → C++ floats.
//
// Layout MUST stay stable across both platforms.  Field order /
// padding / size is checked by static_assert in keyframe_gate.cpp.
//
// Convention notes:
//   - tx, ty, tz: camera origin in world coordinates (metres)
//   - qx, qy, qz, qw: orientation as a unit quaternion in JPL convention
//     (last-real-part, matching both ARKit's simd_quatf and ARCore's
//     Pose.getRotationQuaternion())
//   - fx, fy, cx, cy: pinhole intrinsics (pixels)
//   - imageWidth, imageHeight: pixel dimensions of the captured frame

#pragma once
#include <cstdint>

namespace retailens {

struct Pose {
    // Translation in metres (world frame).
    float tx;
    float ty;
    float tz;
    // Rotation quaternion (JPL convention: last component is real).
    float qx;
    float qy;
    float qz;
    float qw;
    // Pinhole camera intrinsics (pixels).
    float fx;
    float fy;
    float cx;
    float cy;
    // Image dimensions (pixels).
    int32_t imageWidth;
    int32_t imageHeight;
};

// 4×4 column-major rotation+translation matrix.  Matches both
// simd_float4x4 (iOS) and the array returned by ARCore Pose.toMatrix(...)
// layout: columns laid out contiguously, so columns.0 is m[0..3],
// columns.1 is m[4..7], etc.  Translation is the last column (m[12..15]).
//
// ARKit ARPlaneAnchor convention:
//   column 0 = plane tangent X (in-plane "right")
//   column 1 = plane surface normal
//   column 2 = plane tangent Z (in-plane "up")
//   column 3 = plane origin
struct PlaneTransform {
    float m[16];
};

} // namespace retailens
