# CMakeLists.txt — builds `libretailens_stitcher.so`, the JNI shim that
# exposes our custom-built OpenCV's `cv::Stitcher` to the Kotlin SDK.
#
# Architecture
# ────────────
# OpenCV's official prebuilt Android `libopencv_java4.so` strips the
# stitching module entirely.  When we rebuild OpenCV with
# BUILD_opencv_stitching=ON the stitching module is COMPILED (yields a
# static archive `libopencv_stitching.a`) but it's NOT included in the
# fat `libopencv_java4.so` either — the fat lib only bundles modules
# that have Java auto-bindings, and the stitching module declares only
# `WRAP python` upstream.
#
# Our shim closes that gap:
#   - libopencv_stitching.a is STATICALLY linked into our shim, so
#     `cv::Stitcher::create()` and related code lives inside
#     `libretailens_stitcher.so`.
#   - libopencv_java4.so is DYNAMICALLY linked, providing cv::Mat,
#     cv::imread/imwrite, cv::features2d, cv::calib3d, cv::flann, etc.
#     at runtime — the fat lib already exports all the C++ symbols
#     stitching depends on.
#
# Net result: a ~5-10 MB self-contained JNI shim that uses the
# already-bundled fat .so for core OpenCV.

cmake_minimum_required(VERSION 3.18)
project(retailens_stitcher CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Gradle passes OPENCV_ANDROID_SDK as a CMake -D arg.  Points to the
# directory holding `sdk/native/jni/include/`,
# `sdk/native/libs/<ABI>/libopencv_java4.so` and
# `sdk/native/staticlibs/<ABI>/libopencv_stitching.a`.
if(NOT DEFINED OPENCV_ANDROID_SDK)
    message(FATAL_ERROR
        "OPENCV_ANDROID_SDK must be passed in by the Gradle "
        "externalNativeBuild block.  Check the SDK's android/build.gradle.")
endif()

set(OPENCV_INCLUDE_DIR  "${OPENCV_ANDROID_SDK}/sdk/native/jni/include")
set(OPENCV_FAT_SO       "${OPENCV_ANDROID_SDK}/sdk/native/libs/${ANDROID_ABI}/libopencv_java4.so")
set(OPENCV_STITCHING_A  "${OPENCV_ANDROID_SDK}/sdk/native/staticlibs/${ANDROID_ABI}/libopencv_stitching.a")

if(NOT EXISTS "${OPENCV_FAT_SO}")
    message(FATAL_ERROR
        "OpenCV fat shared lib not found at:\n  ${OPENCV_FAT_SO}\n"
        "Run the OpenCV custom build (see docs/scripts/build-opencv-android.sh) "
        "and copy artifacts into vendor/OpenCV-android-sdk/.")
endif()
if(NOT EXISTS "${OPENCV_STITCHING_A}")
    message(FATAL_ERROR
        "OpenCV stitching static archive not found at:\n  ${OPENCV_STITCHING_A}\n"
        "Was the OpenCV build compiled with BUILD_opencv_stitching=ON?")
endif()

# Import the prebuilt OpenCV fat .so (dynamic link target).
add_library(opencv_java SHARED IMPORTED)
set_target_properties(opencv_java PROPERTIES
    IMPORTED_LOCATION "${OPENCV_FAT_SO}")

# Import the static archive for the stitching module (static link target).
add_library(opencv_stitching STATIC IMPORTED)
set_target_properties(opencv_stitching PROPERTIES
    IMPORTED_LOCATION "${OPENCV_STITCHING_A}")

# ── Shared C++ port (KeyframeGate) ────────────────────────────────
#
# `cpp/` at the SDK root holds C++ that's compiled into BOTH the iOS
# pod (via the podspec source globs + HEADER_SEARCH_PATHS) and the
# Android JNI shim (here).  Same source, same algorithm, same
# panorama output — closes the iOS↔Android parity gap that the V16
# Phase 1 frame-counter MVP placeholder left open.
set(SHARED_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../cpp")
if(NOT EXISTS "${SHARED_CPP_DIR}/keyframe_gate.hpp")
    message(FATAL_ERROR
        "Shared C++ port missing at:\n  ${SHARED_CPP_DIR}\n"
        "Expected retailens-capture-sdk/cpp/ — was it moved or deleted?")
endif()

# ── Our shim ───────────────────────────────────────────────────────
add_library(retailens_stitcher SHARED
    retailens_stitcher.cpp
    keyframe_gate_jni.cpp
    "${SHARED_CPP_DIR}/keyframe_gate.cpp"
    # 2026-05-15 — shared stitcher.cpp, used by BOTH platforms.
    # Owns the cv::Stitcher orchestration + C+D progressive-confidence
    # retry + dimension/memory instrumentation.  Used to live in this
    # file (retailens_stitcher.cpp).  See cpp/stitcher.hpp for design
    # rationale.
    "${SHARED_CPP_DIR}/stitcher.cpp")

target_include_directories(retailens_stitcher PRIVATE
    "${OPENCV_INCLUDE_DIR}"
    # cpp/ holds keyframe_gate.hpp + ar_frame_pose.h that the JNI
    # bindings include without relative-path spelunking.
    "${SHARED_CPP_DIR}")

# Link order matters:
#   1. opencv_stitching (static .a) — pulls in cv::Stitcher code
#   2. opencv_java (dynamic .so)    — resolves cv::Mat, cv::imread,
#                                     cv::features2d, cv::calib3d,
#                                     cv::flann, cv::imgproc, etc. at
#                                     runtime via the host app's
#                                     already-loaded libopencv_java4.so
#   3. log                          — for __android_log_print
#
# `-Wl,--whole-archive` around the static lib forces the linker to
# pull in every .o file even if it can't statically prove they're
# needed.  Without it, cv::Stitcher::create() may be eliminated as
# dead code (it's called via the JNI dispatch which the linker can't
# trace at static-link time).
target_link_libraries(retailens_stitcher
    -Wl,--whole-archive
    opencv_stitching
    -Wl,--no-whole-archive
    opencv_java
    log)

target_compile_options(retailens_stitcher PRIVATE
    -fvisibility=hidden
    -Wno-deprecated-declarations)
