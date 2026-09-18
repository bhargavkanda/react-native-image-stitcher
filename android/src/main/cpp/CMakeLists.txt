# CMakeLists.txt — builds `libimage_stitcher.so`, the JNI shim that
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
#     `libimage_stitcher.so`.
#   - libopencv_java4.so is DYNAMICALLY linked, providing cv::Mat,
#     cv::imread/imwrite, cv::features2d, cv::calib3d, cv::flann, etc.
#     at runtime — the fat lib already exports all the C++ symbols
#     stitching depends on.
#
# Net result: a ~5-10 MB self-contained JNI shim that uses the
# already-bundled fat .so for core OpenCV.

cmake_minimum_required(VERSION 3.18)
project(image_stitcher CXX)

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
        "Run the OpenCV custom build (see scripts/build-opencv-android.sh) "
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

# ── React Native + worklets-core prefabs (v0.8.0 Phase 4b.ii/iii) ──
#
# The AR frame-processor's JSI fan-out (stitcher_jsi_install_jni.cpp +
# the shared cpp/stitcher_*_jsi.cpp) needs RN's JSI runtime, fbjni, and
# react-native-worklets-core's `RNWorklet::JsiWorkletContext` /
# `WorkletInvoker`.  RN 0.71+ ships jsi + the native-modules umbrella as
# prefab packages; worklets-core ships a `rnworklets` prefab module.
# `buildFeatures.prefab true` (android/build.gradle) makes these
# discoverable.  We mirror react-native-vision-camera's consumption of
# the SAME prefabs in this example app (verified working on RN 0.84.1).
find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)
find_package(react-native-worklets-core REQUIRED CONFIG)

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
        "Expected react-native-image-stitcher/cpp/ — was the package layout broken?")
endif()


# ── Our shim ───────────────────────────────────────────────────────
add_library(image_stitcher SHARED
    image_stitcher_jni.cpp
    keyframe_gate_jni.cpp
    "${SHARED_CPP_DIR}/keyframe_gate.cpp"
    # Veiling-glare detector (dark-channel prior) shared with iOS.
    # glare_jni.cpp bridges QualityChecker.nativeComputeGlareScore to
    # the shared rnis::computeGlareScore free function in
    # cpp/glare.cpp.  See cpp/glare.hpp for the algorithm rationale.
    glare_jni.cpp
    "${SHARED_CPP_DIR}/glare.cpp"
    # v0.21 — variance-of-Laplacian sharpness metric shared with iOS.
    # sharpness_jni.cpp bridges IncrementalStitcher.nativeSharpnessScore
    # to the shared rnis::sharpnessScore free function in
    # cpp/sharpness.cpp (the pick-sharpest-in-window anti-blur keyframe
    # selection).  See cpp/sharpness.hpp for the algorithm rationale.
    sharpness_jni.cpp
    "${SHARED_CPP_DIR}/sharpness.cpp"
    # v0.21.1 — shared pick-sharpest-in-window DECISION machine.
    # sharpness_window_jni.cpp bridges the Kotlin SharpnessWindow
    # facade to rnis::SharpnessWindowMachine — the SAME class the
    # iOS engine consults (SharpnessWindowBridge.mm), so window
    # open/replace/close decisions (incl. the overlap-drift guard)
    # cannot drift across platforms.  OpenCV-free; gtest-covered in
    # cpp/tests/sharpness_window_test.cpp.
    sharpness_window_jni.cpp
    "${SHARED_CPP_DIR}/sharpness_window.cpp"
    # v0.23 — shared anti-blur ADMISSION policy.  blur_policy_jni.cpp
    # bridges the Kotlin BlurPolicy facade to rnis::admitKeyframe
    # + rnis::RunningScoreMedian — the motion gate and relative
    # sharpness floor the window machine structurally cannot apply
    # (it only ranks candidates against each other).  Same C++ the iOS
    # bridge consults, so the verdicts cannot drift.  OpenCV-free;
    # gtest-covered in cpp/tests/blur_policy_test.cpp.
    blur_policy_jni.cpp
    "${SHARED_CPP_DIR}/blur_policy.cpp"
    # 2026-05-15 — shared stitcher.cpp, used by BOTH platforms.
    # Owns the cv::Stitcher orchestration + C+D progressive-confidence
    # retry + dimension/memory instrumentation.  Used to live in this
    # file (image_stitcher_jni.cpp).  See cpp/stitcher.hpp for design
    # rationale.
    "${SHARED_CPP_DIR}/stitcher.cpp"
    # v0.8.0 Phase 4b.ii/iii — AR frame-processor JSI fan-out.  The JNI
    # binding (stitcher_jsi_install_jni.cpp) installs
    # `globalThis.__stitcherProxy` and fans each AR frame out to the
    # registered host worklets.  The 4 shared cpp/ JSI files below are
    # the SAME source the iOS pod compiles — one cross-platform JSI
    # surface (proxy host object + native worklet registry + per-frame
    # dispatch helper + CameraFrame JSI host object).
    stitcher_jsi_install_jni.cpp
    "${SHARED_CPP_DIR}/stitcher_proxy_jsi.cpp"
    "${SHARED_CPP_DIR}/stitcher_worklet_registry.cpp"
    "${SHARED_CPP_DIR}/stitcher_worklet_dispatch.cpp"
    "${SHARED_CPP_DIR}/camera_frame_jsi.cpp")

target_include_directories(image_stitcher PRIVATE
    "${OPENCV_INCLUDE_DIR}"
    # cpp/ holds keyframe_gate.hpp + ar_frame_pose.h that the JNI
    # bindings include without relative-path spelunking.  Also the
    # shared JSI sources (stitcher_proxy_jsi.hpp, camera_frame_data.hpp,
    # stitcher_worklet_*.hpp, camera_frame_jsi.hpp).
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
target_link_libraries(image_stitcher
    -Wl,--whole-archive
    opencv_stitching
    -Wl,--no-whole-archive
    opencv_java
    log
    # v0.8.0 Phase 4b.ii/iii — JSI fan-out deps.  Mirrors
    # react-native-vision-camera's link set on RN 0.84.1:
    #   ReactAndroid::jsi         — facebook::jsi::Runtime / Value / Object
    #   ReactAndroid::reactnative — RN's native-modules umbrella prefab
    #                               (RN >= 0.76; CallInvoker + friends that
    #                               worklets-core's context depends on)
    #   fbjni::fbjni              — JNI helpers worklets-core links against
    #   react-native-worklets-core::rnworklets — JsiWorkletContext +
    #                               WorkletInvoker.  Carries its own
    #                               include dir so <react-native-worklets-core/
    #                               WKTJsiWorkletContext.h> resolves.
    ReactAndroid::jsi
    ReactAndroid::reactnative
    fbjni::fbjni
    react-native-worklets-core::rnworklets)

target_compile_options(image_stitcher PRIVATE
    -fvisibility=hidden
    -Wno-deprecated-declarations)

# 16 KB page-size compatibility (Android 15+ flags misaligned ELF LOAD
# segments; 16 KB-kernel devices won't load them).  NDK r27 (the default
# pin) still defaults p_align to 4096 — r28+ makes 16384 the default, at
# which point this line becomes a no-op and can stay.  The vendored
# libopencv_java4.so needs the same treatment at its own build time
# (scripts/build-opencv-android.sh) — a link flag here cannot fix an
# already-linked prebuilt.
target_link_options(image_stitcher PRIVATE "-Wl,-z,max-page-size=16384")

# ══════════════════════════════════════════════════════════════════════════
# image_stitcher_panoplus — the pano+ sweep engine
# ══════════════════════════════════════════════════════════════════════════
#
# A SECOND shared library in this same CMake project, deliberately: pano+ is
# an optional engine, and keeping it out of libimage_stitcher.so means a host
# that never sweeps does not pay for it at load time, and a pano+ link break
# can never be confused with a break in the stitcher.
#
# ⚠ A SECOND `add_library` INHERITS NOTHING. Every per-target setting on
# image_stitcher above — visibility, page size, warning flags — is scoped to
# that target and has to be repeated here. The ones below are not copied for
# symmetry; each is load-bearing and says why.
set(PANOPLUS_CPP_DIR "${SHARED_CPP_DIR}/panoplus")
if(NOT EXISTS "${PANOPLUS_CPP_DIR}/rnis_pano.hpp")
    message(FATAL_ERROR
        "pano+ engine sources missing at:\n  ${PANOPLUS_CPP_DIR}\n"
        "Expected react-native-image-stitcher/cpp/panoplus/ — was the package "
        "layout broken?")
endif()

add_library(image_stitcher_panoplus SHARED
    panoplus_jni.cpp
    # The JNI modified-UTF-8 guard. It lives under cpp/panoplus/jni/ rather
    # than beside the engine so the iOS podspec's non-recursive
    # cpp/panoplus/* glob cannot reach it — it needs <jni.h> and would be a
    # dead translation unit in the pod.
    "${PANOPLUS_CPP_DIR}/jni/rnis_jni_utf8.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_replay.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_live.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_attitude.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_calib.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_android_basis.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_android_report.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_android_s1.cpp"
    "${PANOPLUS_CPP_DIR}/rnis_pano_android_preview.cpp")

target_include_directories(image_stitcher_panoplus PRIVATE
    "${OPENCV_INCLUDE_DIR}"
    # SHARED_CPP_DIR for warp_guard.hpp, which rnis_pano.cpp includes by bare
    # name and which lives at the package's cpp/ root, one level ABOVE the
    # engine.
    "${SHARED_CPP_DIR}"
    "${PANOPLUS_CPP_DIR}"
    "${PANOPLUS_CPP_DIR}/jni")

# opencv_java and log ONLY.
#   · NOT opencv_stitching: image_stitcher wraps it in --whole-archive to stop
#     the linker dead-stripping cv::Stitcher, and pano+ must not inherit a
#     whole-archive of a library it does not call.
#   · NOT the RN prefabs (jsi / reactnative / fbjni / rnworklets): pano+'s JNI
#     is plain JNI with no JSI surface, and linking them would make this .so
#     fail to load on any host whose RN version ships different prefabs.
target_link_libraries(image_stitcher_panoplus
    opencv_java
    log)

# ⚠ -O2 GOES HERE, PER TARGET — NOT IN android/build.gradle's `cppFlags`.
# `cppFlags` maps to CMAKE_CXX_FLAGS, which is project-wide: putting -O2
# there would silently re-optimise libimage_stitcher.so for every existing
# consumer's Debug build. `target_compile_options` is emitted AFTER
# CMAKE_CXX_FLAGS_DEBUG and the last -O wins in clang, so this is also the
# only placement that actually beats the Debug default.
#
# And it is not a tuning preference. Measured on a Galaxy A35 with the NDK
# Debug default (-O0): the engine cost 44.9 ms/frame and dropped 49% of
# frames. The pack's own backpressure note blamed the encoder and was wrong.
# A Debug build of this library is a FIELD build — do not remove this.
#
# -fvisibility=hidden keeps every rnis:: symbol out of the dynamic table; the
# 15 JNI entries are JNIEXPORT and unaffected. ⚠ It also means `nm -D` on the
# shipped .so reports ZERO rnis symbols, which is the intent and not a
# defect — verify against the pre-strip object under intermediates/cxx/.
target_compile_options(image_stitcher_panoplus PRIVATE
    -O2
    -fvisibility=hidden
    -Wall
    -Wno-deprecated-declarations)

# 16 KB page-size compatibility, same reason as image_stitcher above.
# --exclude-libs,ALL additionally stops the static archives this target links
# from re-exporting their own symbols through it.
target_link_options(image_stitcher_panoplus PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,--exclude-libs,ALL")

