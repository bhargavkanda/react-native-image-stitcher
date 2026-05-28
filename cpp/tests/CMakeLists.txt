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
# What this DOES test (v0.10.0 scope):
#   - Pure-C++ types in cpp/: `Pose`, `PlaneTransform`,
#     `StitcherFrameData`, `PixelBufferReader` interface contract.
#   - `StitcherWorkletRegistry` lifecycle (count, snapshot, uninstall,
#     thread-safety) — compiled against JSI/worklets-core stubs under
#     `cpp/tests/stubs/`.  See `stubs/jsi/jsi.h` for the strategy.
#
# What this DOES NOT test yet (deferred to v0.11.0+):
#   - `KeyframeGate` — depends on OpenCV.  Will need an OpenCV-aware
#     CMake config (link the same opencv_world the prod build uses).
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
# stitcher_frame_data.hpp) are found as the production code expects.
include_directories(
  ${CMAKE_CURRENT_SOURCE_DIR}/stubs
  ${CMAKE_CURRENT_SOURCE_DIR}/..
)

# ─────────────────────────────────────────────────────────────────────
# Test executable
# ─────────────────────────────────────────────────────────────────────
add_executable(stitcher_cpp_tests
  # Production sources under test (only those whose deps we can satisfy
  # without OpenCV / a real JSI runtime).
  ${CMAKE_CURRENT_SOURCE_DIR}/../stitcher_worklet_registry.cpp

  # Test sources.
  ${CMAKE_CURRENT_SOURCE_DIR}/pose_test.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/stitcher_frame_data_test.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/stitcher_worklet_registry_test.cpp
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
