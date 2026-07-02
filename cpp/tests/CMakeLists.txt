# SPDX-License-Identifier: Apache-2.0
#
# cpp/tests/CMakeLists.txt — v0.10.0 audit #9A
#
# Standalone Google Test runner for the shared C++ port under `cpp/`.
# Build + run via:
#
#     cmake -S cpp/tests -B build/cpp-tests
#     cmake --build build/cpp-tests
#     (cd build/cpp-tests && ctest --output-on-failure)
#
# Or, from the repo root: `scripts/run-cpp-tests.sh`.
#
# What this DOES test:
#   - Pure-C++ types in cpp/: `Pose`, `PlaneTransform`,
#     `CameraFrameData`, `PixelBufferReader` interface contract.
#   - `timeBudgetCrossed` — the keyframe gate's OpenCV-free time-budget
#     force-accept predicate (keyframe_timebudget_test.cpp).
#   - `warpRoiExceedsGuard` — the OpenCV-free warp-canvas size guard that
#     triggers the cylindrical-fallback pre-pass (warp_guard_test.cpp).
#   - `quadDstRect` / `isQuadAcceptable` — the OpenCV-free free-quad crop
#     geometry behind item-7's perspective crop (crop_quad_test.cpp).
#   (The StitcherWorkletRegistry test was removed when that source was
#    archived in the Phase-3 cleanup — its CMake entries had gone stale
#    and broke the whole suite's configure step.)
#
# What this tests WHEN A HOST OpenCV IS AVAILABLE (find_package below):
#   - `varianceOfLaplacian` / `sharpnessScore` — the shared sharpness
#     metric behind the pick-sharpest-in-window anti-blur keyframe
#     selection (sharpness_test.cpp + cpp/sharpness.cpp).  These need
#     cv::Laplacian / cv::meanStdDev, so they are compiled into a
#     SECOND test binary that links OpenCV, added only when
#     find_package(OpenCV) succeeds.  Provide OpenCV either via a
#     system install or by pointing OpenCV_DIR at a local build —
#     scripts/run-cpp-tests.sh auto-detects a minimal host build under
#     build/opencv-host/install (core+imgproc static is enough).
#
# What this DOES NOT test yet (deferred to v0.11.0+):
#   - `KeyframeGate` (the full gate) — depends on OpenCV.  Will need an
#     OpenCV-aware CMake config (link the same opencv_world the prod
#     build uses).  NOTE: the OpenCV-free `timeBudgetCrossed` predicate
#     (the time-budget force-accept boundary logic) IS covered, via
#     keyframe_timebudget_test.cpp — it's an inline header-only function.
#   - JSI host-object dispatch — needs a real Hermes runtime.
#   - Anything in `stitcher.cpp` (uses OpenCV stitching pipeline).

cmake_minimum_required(VERSION 3.20)
project(stitcher_cpp_tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Must precede `gtest_discover_tests` — without this the discovered
# cases aren't registered into a CTestTestfile.cmake at this directory
# level, and `ctest` reports "No tests were found".
enable_testing()

# Fetch GoogleTest pinned to v1.14.0.  Pin matches what the AOSP /
# Android NDK test ecosystem uses today; bumps should be deliberate.
include(FetchContent)
FetchContent_Declare(
  googletest
  GIT_REPOSITORY https://github.com/google/googletest.git
  GIT_TAG        v1.14.0
)
# Prevent GoogleTest from overriding our compiler/linker options
# (Windows-only quirk; harmless on macOS/Linux).
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

# ─────────────────────────────────────────────────────────────────────
# Include paths
# ─────────────────────────────────────────────────────────────────────
# Order matters: stubs/ comes FIRST so `#include <jsi/jsi.h>` and
# `#include <react-native-worklets-core/WKTJsiWorklet.h>` resolve to
# the test-only stubs before any system header.  The production cpp/
# directory comes after so retailens:: headers (e.g. ar_frame_pose.h,
# camera_frame_data.hpp) are found as the production code expects.
include_directories(
  ${CMAKE_CURRENT_SOURCE_DIR}/stubs
  ${CMAKE_CURRENT_SOURCE_DIR}/..
)

# ─────────────────────────────────────────────────────────────────────
# Test executable
# ─────────────────────────────────────────────────────────────────────
add_executable(stitcher_cpp_tests
  # Test sources.  All subjects are header-only (Pose / PlaneTransform,
  # CameraFrameData, and the gate's inline `timeBudgetCrossed`
  # predicate), so no production .cpp needs linking here.
  ${CMAKE_CURRENT_SOURCE_DIR}/pose_test.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/camera_frame_data_test.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/keyframe_timebudget_test.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/warp_guard_test.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/crop_quad_test.cpp
)

target_link_libraries(stitcher_cpp_tests
  PRIVATE
    GTest::gtest_main
)

# Treat warnings as errors in the test build to catch the kind of
# silent regressions (unused variables, signed/unsigned comparisons,
# narrowing conversions) that production cross-compilation flags would
# otherwise suppress.
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(stitcher_cpp_tests PRIVATE
    -Wall -Wextra -Wpedantic -Werror
  )
endif()

# Register with CTest so `ctest --output-on-failure` picks up the
# individual TEST() cases (gtest_discover_tests scans the binary at
# build time, no manual ADD_TEST per case).
include(GoogleTest)
gtest_discover_tests(stitcher_cpp_tests)

# ─────────────────────────────────────────────────────────────────────
# OpenCV-dependent tests (separate binary, added only when OpenCV is
# findable).  Kept OUT of stitcher_cpp_tests so the OpenCV-free suite
# above stays runnable on any machine with zero native dependencies.
# ─────────────────────────────────────────────────────────────────────
find_package(OpenCV QUIET COMPONENTS core imgproc)
if(OpenCV_FOUND)
  message(STATUS "OpenCV ${OpenCV_VERSION} found — building sharpness tests")
  add_executable(stitcher_cpp_opencv_tests
    ${CMAKE_CURRENT_SOURCE_DIR}/sharpness_test.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../sharpness.cpp
  )
  target_include_directories(stitcher_cpp_opencv_tests PRIVATE
    ${OpenCV_INCLUDE_DIRS}
  )
  target_link_libraries(stitcher_cpp_opencv_tests
    PRIVATE
      GTest::gtest_main
      ${OpenCV_LIBS}
  )
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(stitcher_cpp_opencv_tests PRIVATE
      -Wall -Wextra -Wpedantic -Werror
    )
  endif()
  gtest_discover_tests(stitcher_cpp_opencv_tests)
else()
  message(WARNING
    "OpenCV not found — sharpness_test.cpp SKIPPED.  Provide OpenCV via "
    "a system install or set OpenCV_DIR (scripts/run-cpp-tests.sh "
    "auto-detects build/opencv-host/install).")
endif()
