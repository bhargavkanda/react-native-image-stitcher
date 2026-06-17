# CMakeLists.txt — HOST (example app) consumer that reuses the OpenCV
# bundled by react-native-image-stitcher.  Proof-of-concept for the
# "host reuses the library's OpenCV, no second copy" feature.
#
# Mechanism: the library publishes the location of its vendored OpenCV
# Android SDK via a rootProject ext property (rnisOpenCVDir), which the
# app/build.gradle forwards as -DOpenCV_DIR=...  We then use OpenCV's OWN
# first-class CMake package (find_package(OpenCV)) — the idiomatic Android
# way — to obtain every module, including cv::Stitcher (static archive).

cmake_minimum_required(VERSION 3.18)
project(opencv_self_test CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# OpenCV_DIR is injected by app/build.gradle from the library's
# rootProject.ext.rnisOpenCVDir (…/android/vendor/OpenCV-android-sdk/sdk/native/jni).
if(NOT DEFINED OpenCV_DIR)
    message(FATAL_ERROR
        "OpenCV_DIR not set.  The react-native-image-stitcher library must be "
        "on the build (it sets rootProject.ext.rnisOpenCVDir, forwarded here "
        "as -DOpenCV_DIR).  Check app/build.gradle's externalNativeBuild args.")
endif()

# Pulls in every OpenCV module the bundled SDK ships, as IMPORTED targets:
#   - opencv_java        : SHARED  → libopencv_java4.so (the SAME .so the
#                          library's AAR already packages into the APK; we
#                          link against it, we do NOT re-package it).
#   - opencv_stitching   : STATIC  → libopencv_stitching.a (cv::Stitcher;
#                          NOT in the fat .so).
#   - opencv_core/imgproc/features2d/calib3d/flann/photo/video/… : STATIC.
find_package(OpenCV REQUIRED)

add_library(opencv_self_test SHARED opencv_self_test.cpp)

target_include_directories(opencv_self_test PRIVATE ${OpenCV_INCLUDE_DIRS})

# Link to mirror the library's own shim exactly (no second OpenCV copy):
#
#   1. opencv_stitching (STATIC .a, whole-archived) — cv::Stitcher::create()
#      and the rest of the stitching pipeline.  whole-archive so it survives
#      dead-code elimination (it's reached only via JNI dispatch, which the
#      linker can't trace statically).  This module is genuinely a private
#      static copy in the consumer .so because it is NOT in the fat .so.
#
#   2. opencv_java (SHARED .so) — resolves cv::Mat, imgproc, features2d,
#      calib3d, flann, photo, video, … AT RUNTIME from the SAME
#      libopencv_java4.so the library's AAR already ships in the APK.  We
#      link against it (it becomes a DT_NEEDED) but do NOT re-package it.
#
# NOTE: we deliberately do NOT link the full ${OpenCV_LIBS} — that would pull
# in the STATIC opencv_core/imgproc/… archives and bake a SECOND copy of core
# OpenCV into this .so, defeating the "reuse the bundled .so" goal.
target_link_libraries(opencv_self_test
    -Wl,--whole-archive
    opencv_stitching
    -Wl,--no-whole-archive
    opencv_java
    log)
