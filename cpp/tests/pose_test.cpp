// SPDX-License-Identifier: Apache-2.0
//
// pose_test.cpp — v0.10.0 audit #9A
//
// Layout / size invariants for the cross-platform POD structs that
// marshal AR-frame pose data between Swift/Kotlin and shared C++.
// The Pose / PlaneTransform structs MUST stay binary-compatible
// across iOS (Swift → C++) and Android (Kotlin → JNI → C++) — any
// silent field reorder, padding shift, or size change would diverge
// gate decisions between platforms.
//
// These are pinned to the contract in `cpp/ar_frame_pose.h`'s
// docstring; if the struct shape evolves intentionally, update both
// the docstring and these tests in the same commit.

#include "ar_frame_pose.h"

#include <gtest/gtest.h>

#include <cstddef>
#include <type_traits>

using retailens::Pose;
using retailens::PlaneTransform;

TEST(PoseLayoutTest, IsStandardLayoutPod) {
  // Required for `memcpy` marshalling and for the iOS Obj-C++ /
  // Android JNI bridges to write into the struct directly.
  EXPECT_TRUE(std::is_standard_layout<Pose>::value);
  EXPECT_TRUE(std::is_trivially_copyable<Pose>::value);
}

TEST(PoseLayoutTest, SizeMatchesExpectedFields) {
  // 11 floats (tx, ty, tz, qx, qy, qz, qw, fx, fy, cx, cy) + 2 int32_t
  // (imageWidth, imageHeight) = 11*4 + 2*4 = 52 bytes.  No padding
  // expected: every field is 4-byte aligned and the struct contains
  // only 4-byte primitives.
  EXPECT_EQ(sizeof(Pose), static_cast<std::size_t>(11 * 4 + 2 * 4));
}

TEST(PoseLayoutTest, FieldOrderMatchesContract) {
  // Translation comes before rotation; rotation before intrinsics;
  // intrinsics before image dimensions.  Swift / Kotlin marshallers
  // assume this order — flipping any pair silently breaks the
  // memcpy-based bridge.
  EXPECT_EQ(offsetof(Pose, tx), 0u);
  EXPECT_EQ(offsetof(Pose, ty), sizeof(float) * 1);
  EXPECT_EQ(offsetof(Pose, tz), sizeof(float) * 2);
  EXPECT_EQ(offsetof(Pose, qx), sizeof(float) * 3);
  EXPECT_EQ(offsetof(Pose, qy), sizeof(float) * 4);
  EXPECT_EQ(offsetof(Pose, qz), sizeof(float) * 5);
  EXPECT_EQ(offsetof(Pose, qw), sizeof(float) * 6);
  EXPECT_EQ(offsetof(Pose, fx), sizeof(float) * 7);
  EXPECT_EQ(offsetof(Pose, fy), sizeof(float) * 8);
  EXPECT_EQ(offsetof(Pose, cx), sizeof(float) * 9);
  EXPECT_EQ(offsetof(Pose, cy), sizeof(float) * 10);
  EXPECT_EQ(offsetof(Pose, imageWidth), sizeof(float) * 11);
  EXPECT_EQ(offsetof(Pose, imageHeight),
            sizeof(float) * 11 + sizeof(int32_t));
}

TEST(PlaneTransformLayoutTest, IsStandardLayoutPod) {
  EXPECT_TRUE(std::is_standard_layout<PlaneTransform>::value);
  EXPECT_TRUE(std::is_trivially_copyable<PlaneTransform>::value);
}

TEST(PlaneTransformLayoutTest, SixteenFloatsContiguous) {
  // The `m[16]` array MUST be a contiguous 64-byte block — both
  // bridges call `memcpy(planeTransform.m, source, 64)`.  No leading
  // padding, no field reorder (there's only one field, but pinning the
  // size catches any accidental wrapper/struct change).
  EXPECT_EQ(sizeof(PlaneTransform), static_cast<std::size_t>(16 * 4));
  EXPECT_EQ(offsetof(PlaneTransform, m), 0u);
}
