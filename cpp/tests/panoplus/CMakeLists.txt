# SPDX-License-Identifier: Apache-2.0
#
# cpp/tests/panoplus/CMakeLists.txt — standalone Google Test runner for the
# pano+ half of the C++ (cpp/rnis_pano*.cpp).  The engine is testable in
# ISOLATION — no React Native, no JNI, no ObjC — just the sources + OpenCV.
#
# The engine IS an OpenCV consumer, so the host build links a host OpenCV via
# find_package(OpenCV).  Pin 4.10.0 to match CI; a newer host OpenCV is
# API-compatible for the surface used here but is NOT byte-parity evidence
# against the device's vendored build.
#
# Build + run (from the package root):
#
#     cmake -S cpp/tests/panoplus -B build/cpp-tests-panoplus
#     cmake --build build/cpp-tests-panoplus -j"$(nproc)"
#     (cd build/cpp-tests-panoplus && ctest --output-on-failure)
#
#   ⚠ ONE BUILD DIRECTORY PER TEST PROJECT. A build directory is bound to the
#   source directory it was configured against; pointing an existing one
#   elsewhere makes CMake refuse outright. Every sibling project here is built
#   the same way, into its own directory.
#
# warp_guard.hpp comes from the stitcher package IN PLACE (the same linkage
# the pod/AAR builds use); the default path assumes a sibling
# app checkout's node_modules — override with
# -DHOST_STITCHER_CPP_DIR=… when building elsewhere.

cmake_minimum_required(VERSION 3.20)
project(rnis_panoplus_cpp_tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

enable_testing()

find_package(OpenCV REQUIRED)

# On a migrated Apple Silicon Mac the Homebrew prefix can be the INTEL one
# (/usr/local, x86_64 dylibs) while cmake defaults the build to arm64 — the
# link then fails with "symbol(s) not found for architecture arm64".  Detect
# the found OpenCV's architecture with lipo and match the test build to it
# (Rosetta runs the x86_64 binary transparently).
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
  list(GET OpenCV_LIBS 0 _rnis_probe_target)
  if(TARGET ${_rnis_probe_target})
    get_target_property(_rnis_probe_lib ${_rnis_probe_target} LOCATION)
  else()
    set(_rnis_probe_lib ${_rnis_probe_target})
  endif()
  if(EXISTS "${_rnis_probe_lib}")
    execute_process(COMMAND lipo -info "${_rnis_probe_lib}"
                    OUTPUT_VARIABLE _rnis_lipo OUTPUT_STRIP_TRAILING_WHITESPACE
                    ERROR_QUIET)
    if(_rnis_lipo MATCHES "x86_64" AND NOT _rnis_lipo MATCHES "arm64")
      message(STATUS "Host OpenCV is x86_64-only — building tests x86_64 (Rosetta)")
      set(CMAKE_OSX_ARCHITECTURES "x86_64" CACHE STRING "" FORCE)
    endif()
  endif()
endif()

# Fetch GoogleTest pinned to v1.14.0 (same pin the stitcher + the host's other C++ packages
# cpp/tests use).
include(FetchContent)
# ⚠ DO NOT GIVE THE TWO HALVES A SHARED FETCHCONTENT_BASE_DIR. Each project
# fetches its own googletest, and that duplication is deliberate. Sharing the
# base dir to avoid the second clone MEASURABLY BREAKS THE BUILD, and not in
# the way you would guess:
#
#   · both configures exit 0 — nothing warns
#   · the shared googletest-build tree ends up with CMAKE_BINARY_DIR pointing
#     at whichever project configured SECOND
#   · both projects' CTestTestfile.cmake subdirs() into that same overwritten
#     tree
#   · a full build of the FIRST-configured project then dies with
#     `No rule to make target 'lib/libgtest_main.a', needed by ...`
#
# Measured both orders; the failure follows the FIRST-configured project, not
# the second. A partial build (one --target) can still succeed and hide it.
#
# If the second clone genuinely matters, share the SOURCE and not the build:
#   -DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=<one checkout>
# which is verified to work for both halves.
FetchContent_Declare(
  googletest
  GIT_REPOSITORY https://github.com/google/googletest.git
  GIT_TAG        v1.14.0
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

# ⚠ ONE MORE ../ THAN THE ORIGINAL. This file moved down a directory when
# ── Paths, all relative to this file ─────────────────────────────────────
#
#   <pkg>/cpp/tests/panoplus/   this file AND every pano test .cpp
#   <pkg>/cpp/panoplus/         the engine
#   <pkg>/cpp/panoplus/jni/     the JNI UTF-8 guard (out of the podspec's
#                               non-recursive cpp/*.{h,hpp,cpp} glob on
#                               purpose, so the pod never compiles it as a
#                               dead translation unit)
#   <pkg>/cpp/                  warp_guard.hpp, shared with the rest of the
#                               package
#   <pkg>/ios/PanoPlus/         the iOS sources three tests read as TEXT
#
# ⚠ There is no longer an out-of-package include path. The engine's
# `#include "warp_guard.hpp"` used to reach a sibling checkout's node_modules;
# it now resolves inside this package, which is the whole point of the move.
set(RNIS_TESTS_DIR      ${CMAKE_CURRENT_SOURCE_DIR})
set(RNIS_CPP_DIR        ${CMAKE_CURRENT_SOURCE_DIR}/../../panoplus)
set(RNIS_ENGINE_SRC_DIR ${RNIS_CPP_DIR})
set(RNIS_JNI_DIR        ${RNIS_CPP_DIR}/jni)
set(RNIS_SHARED_CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../..)

# Configure-time existence checks. Every one of these paths is consumed by a
# `target_include_directories` or a `target_compile_definitions`, where a
# wrong path produces either a confusing compile error much later or — for
# the definitions — a test that reads an empty file and quietly asserts
# nothing.
foreach(_d RNIS_CPP_DIR RNIS_JNI_DIR RNIS_SHARED_CPP_DIR)
  if(NOT EXISTS "${${_d}}")
    message(FATAL_ERROR "${_d} does not exist: ${${_d}}")
  endif()
endforeach()
if(NOT EXISTS "${RNIS_SHARED_CPP_DIR}/warp_guard.hpp")
  message(FATAL_ERROR "warp_guard.hpp not found at ${RNIS_SHARED_CPP_DIR}")
endif()

# ══════════════════════════════════════════════════════════════════════════
# pano+ HOST TESTS — the half bound for the public package
# ══════════════════════════════════════════════════════════════════════════
#
# ⚠ THIS IS ONE OF TWO INDEPENDENT CMAKE PROJECTS, AND THERE IS DELIBERATELY NO
# AGGREGATOR. cpp/tests/CMakeLists.txt was deleted rather than turned into an
# add_subdirectory parent: a parent would make these one CMake project again
# and hide exactly the coupling the package split exists to expose. Each half
# configures, builds and runs on its own, and CI drives both.
#
# The preamble above is DUPLICATED from the original, not shared. Sharing it
# through an include() would reintroduce the single point the split removes.

# ── rnis_jni_utf8 — owned by NEITHER half ───────────────────────────────────
#
# The JNI modified-UTF-8 guard. It sits above the other targets deliberately:
# more than one JSON return path reaches it, and before it was extracted one of
# those calls ran INTO a pano translation unit — the one edge that made
# separating the two a link-graph problem rather than a text edit.
#
# ⚠ IT LINKS NO OpenCV, which is why it is one of the few targets that builds
# and runs on a developer Mac with no arm64 OpenCV. Keep it that way: the guard
# prevents a CheckJNI ABORT (an app kill), so the cheapest possible path to
# running its tests is a feature, not an accident.
#
# When this package is split, this target is DUPLICATED into both halves' test
# files, not assigned to one.
add_library(rnis_jni_utf8 STATIC
  ${RNIS_JNI_DIR}/rnis_jni_utf8.cpp
)
target_include_directories(rnis_jni_utf8 PUBLIC
  # Its own directory: the guard sits under cpp/panoplus/jni/ so the pod's
  # non-recursive cpp/panoplus/* glob cannot reach it.
  ${RNIS_JNI_DIR}
)

add_executable(rnis_jni_utf8_tests
  ${RNIS_TESTS_DIR}/rnis_jni_utf8_test.cpp
)
target_link_libraries(rnis_jni_utf8_tests PRIVATE rnis_jni_utf8 GTest::gtest_main)

# ── pano+ engine (slit-scan revival, 2026-08-19) ───────────────────────────
# A SEPARATE library + runner, so a pano+ compile break can never be
# confused with a break in any other part of the estate.
add_library(rnis_pano STATIC
  ${RNIS_CPP_DIR}/rnis_pano.cpp
)
target_include_directories(rnis_pano PUBLIC
  ${RNIS_CPP_DIR}
  ${RNIS_SHARED_CPP_DIR}
)
target_link_libraries(rnis_pano PUBLIC ${OpenCV_LIBS})
target_include_directories(rnis_pano PUBLIC ${OpenCV_INCLUDE_DIRS})

add_executable(rnis_pano_tests
  ${RNIS_TESTS_DIR}/rnis_pano_test.cpp
)
target_link_libraries(rnis_pano_tests rnis_pano GTest::gtest_main)
# The iOS bridge SOURCE, so a test can assert the safety gate is not
# bypassable from JS (PanoLens.TheOverrideIsNotReachableFromTheHostOptions-
# Dictionary).  A grep-in-a-test is a poor substitute for a type system, but
# the alternative — trusting that nobody re-adds three `numOr(options, …)`
# lines — is what let the hole in.
target_compile_definitions(rnis_pano_tests PRIVATE
  RNIS_IOS_SRC_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../../ios/PanoPlus"
  # rnis_pano_test.cpp reads the ENGINE as text too (the lens-override bypass
  # gate). It used to spell that as RNIS_IOS_SRC_DIR + "/../cpp/rnis_pano.cpp",
  # which resolved only while ios/ and cpp/ were siblings. They are not any
  # more, so the engine gets its own definition rather than a relative walk
  # out of an unrelated one.
  RNIS_ENGINE_SRC_DIR="${RNIS_ENGINE_SRC_DIR}")

# ── the pack REPLAY DRIVER (Android port, 2026-08-31) ──────────────────────
# cpp/rnis_pano_replay.{hpp,cpp} drives the engine over a pack directory with
# no platform dependency, so the SAME translation unit answers "does it run,
# how fast, and does it decide what iOS decided" on this host today and under
# the NDK tomorrow.  A driver written twice would diverge on exactly the thing
# it exists to measure.
#
# It links `rnis_pano` (it consumes Engine/Config/FrameInput and the engine's
# own publishJpegAtomically) and therefore OpenCV, unlike the attitude/calib
# targets below.  Its only other dependencies are C++17 STL and POSIX
# <sys/stat.h>/realpath — deliberately NOT <filesystem>, whose libc++ archive
# availability has moved across NDK releases and minSdk levels.
add_library(rnis_pano_replay STATIC
  ${RNIS_CPP_DIR}/rnis_pano_replay.cpp
)
target_include_directories(rnis_pano_replay PUBLIC
  ${RNIS_CPP_DIR}
  ${RNIS_SHARED_CPP_DIR}
)
target_link_libraries(rnis_pano_replay PUBLIC rnis_pano)

add_executable(rnis_pano_replay_tests
  ${RNIS_TESTS_DIR}/rnis_pano_replay_test.cpp
)
target_link_libraries(rnis_pano_replay_tests rnis_pano_replay GTest::gtest_main)

# ── decoupled-capture attitude seam (S2, 2026-08-30) ───────────────────────
# A FOURTH separate library + runner.  cpp/rnis_pano_attitude.{hpp,cpp} is the
# time-alignment policy the decoupled capture path rests on — tau application,
# bracket-or-refuse, SLERP, the 24 basis candidates, and the derived tracking
# state.  It lands BEFORE either platform has a frame source calling it, which
# is the design's single anti-duplication measure: this is the exact piece an
# iOS and an Android implementation would silently diverge on.
#
# ⚠ NO OpenCV, NO warp_guard.hpp, NO platform header — STL only.  That is not
# tidiness: the Android leg compiles this same translation unit, and the target
# below deliberately does NOT link ${OpenCV_LIBS} so a stray OpenCV include
# fails the HOST build rather than surfacing as an NDK link error months later.
add_library(rnis_pano_attitude STATIC
  ${RNIS_CPP_DIR}/rnis_pano_attitude.cpp
)
target_include_directories(rnis_pano_attitude PUBLIC
  ${RNIS_CPP_DIR}
)

add_executable(rnis_pano_attitude_tests
  ${RNIS_TESTS_DIR}/rnis_pano_attitude_test.cpp
)
target_link_libraries(rnis_pano_attitude_tests rnis_pano_attitude GTest::gtest_main)

# ── the CALIBRATION step (JOB 1, 2026-08-31) ───────────────────────────────
# cpp/rnis_pano_calib.{hpp,cpp} is the other half of the attitude seam: the
# seam REFUSES without a measured tau and a validated basis, and this is the
# arithmetic that earns both — gesture excitation (the degeneracy the prototype
# run discovered, measured from the motion alone so it can be COACHED), the
# repeat-combine that gives tau a stated uncertainty, and the persist gates.
#
# It links `rnis_pano_attitude` because it consumes AttitudeSample /
# selectBasis / detail:: directly.  Same rule as its dependency: STL ONLY, NO
# OpenCV — the target deliberately does not link ${OpenCV_LIBS} so a stray
# OpenCV include fails the HOST build rather than surfacing as an NDK link
# error on the Android leg months later.
add_library(rnis_pano_calib STATIC
  ${RNIS_CPP_DIR}/rnis_pano_calib.cpp
)
target_include_directories(rnis_pano_calib PUBLIC
  ${RNIS_CPP_DIR}
)
target_link_libraries(rnis_pano_calib PUBLIC rnis_pano_attitude)

add_executable(rnis_pano_calib_tests
  ${RNIS_TESTS_DIR}/rnis_pano_calib_test.cpp
)
target_link_libraries(rnis_pano_calib_tests rnis_pano_calib GTest::gtest_main)

# ── the ANDROID basis derivation (pano+ Android port, 2026-08-31) ──────────
# cpp/rnis_pano_android_basis.{hpp,cpp} replaces `selectBasis()`'s 24-candidate
# SEARCH with arithmetic on two frames Android actually documents (the
# SensorManager device frame, and SENSOR_ORIENTATION's clockwise-to-upright
# angle).  iOS could not do this — CoreMotion does not document its frame
# against the camera's — so the basis there was measured against ARKit.
#
# It lands with NO ANDROID DEVICE ATTACHED, which is the whole reason it is
# host-tested here rather than written inside the JNI shim: the test file
# checks the derivation against the ENGINE's own enumeration (searched, never
# mirrored) and against the FIELD-MEASURED iOS answer (basis 8 on iPhone17,1),
# both of which are available on this Mac.
#
# It links `rnis_pano_attitude` for the 24-candidate table and the quaternion
# helpers.  Same rule as its dependency, and the same reason: STL ONLY, NO
# OpenCV — this target deliberately does not link ${OpenCV_LIBS} so a stray
# OpenCV include fails the HOST build rather than surfacing as an NDK link
# error on the Android leg months later.
add_library(rnis_pano_android_basis STATIC
  ${RNIS_CPP_DIR}/rnis_pano_android_basis.cpp
)
target_include_directories(rnis_pano_android_basis PUBLIC
  ${RNIS_CPP_DIR}
)
target_link_libraries(rnis_pano_android_basis PUBLIC rnis_pano_attitude)

add_executable(rnis_pano_android_basis_tests
  ${RNIS_TESTS_DIR}/rnis_pano_android_basis_test.cpp
)
target_link_libraries(rnis_pano_android_basis_tests
  rnis_pano_android_basis GTest::gtest_main)

# ── the basis REPORT (pano+ Android port, 2026-09-01) ──────────────────────
# cpp/rnis_pano_android_report.{hpp,cpp} is the marshalling the JNI entry would
# otherwise have contained: the derivation as JSON, plus the derived-vs-measured
# comparison the basis header's FALSIFICATION section asks for.
#
# It is a separate translation unit precisely so it can be tested HERE.  Inside
# the JNI translation unit it would need <jni.h>, compile only under the NDK, and
# its characteristic failures (a bare `nan` that makes JSON.parse throw in JS, a
# dropped checklist field) would surface on a phone in an aisle.
#
# Same STL-ONLY rule as its dependency, and the same reason: no OpenCV is linked
# here, so a stray include fails on this host rather than as an NDK link error
# on the Android leg.
add_library(rnis_pano_android_report STATIC
  ${RNIS_CPP_DIR}/rnis_pano_android_report.cpp
)
target_include_directories(rnis_pano_android_report PUBLIC
  ${RNIS_CPP_DIR}
)
target_link_libraries(rnis_pano_android_report PUBLIC rnis_pano_android_basis)

add_executable(rnis_pano_android_report_tests
  ${RNIS_TESTS_DIR}/rnis_pano_android_report_test.cpp
)
# ⚠ rnis_jni_utf8 IS NOT OPTIONAL HERE. This suite keeps ONE assertion on the
# half-neutral sanitiser — the integration one, that a real generated report
# passes through untouched — because it needs pano types and cannot move to the
# neutral suite. Omitting this library does not fail that one test: it fails to
# LINK THE WHOLE BINARY, taking all 25 unrelated AndroidReport /
# AndroidReportAgreement / AndroidReportJson assertions dark with it, including
# the non-finite-to-null JSON guards. Building only the new target still shows
# green, which is exactly how this shipped broken once.
target_link_libraries(rnis_pano_android_report_tests
  rnis_pano_android_report rnis_jni_utf8 GTest::gtest_main)

# ── the S1 BASIS RUN over a recorded pack (pano+ Android port, 2026-09-01) ─
# cpp/rnis_pano_android_s1.{hpp,cpp} is the FALSIFICATION half of the basis
# story.  `rnis_pano_android_basis` DERIVES C from SENSOR_ORIENTATION; this one
# MEASURES it, by reading the recorder's own `sensors.jsonl` and the ARCore
# reference sidecar `attitude_arcore.jsonl` and running `selectBasis()` /
# `excitation()` / `gradeBasis()` / `basisStability()` over them.
#
# It is host-tested for the same reason its two siblings are, and for one more:
# it contains a JSON READER, and a reader that mis-parses a quaternion produces
# a plausible basis rather than an error.  Every branch of that reader — the
# out-of-order row, the non-unit quaternion, the truncated last line, the key
# name that also appears inside a string VALUE — is reachable here and on no
# phone.
#
# It links `rnis_pano_android_report` (for compareDerivedWithReference) and
# `rnis_pano_calib` (for excitation/gradeBasis/basisStability), which between
# them already pull in `rnis_pano_attitude`.  Same STL-ONLY rule as all three:
# no OpenCV is linked, so a stray include fails on this host rather than as an
# NDK link error on the Android leg.
add_library(rnis_pano_android_s1 STATIC
  ${RNIS_CPP_DIR}/rnis_pano_android_s1.cpp
)
target_include_directories(rnis_pano_android_s1 PUBLIC
  ${RNIS_CPP_DIR}
)
target_link_libraries(rnis_pano_android_s1 PUBLIC
  rnis_pano_android_report rnis_pano_calib)

add_executable(rnis_pano_android_s1_tests
  ${RNIS_TESTS_DIR}/rnis_pano_android_s1_test.cpp
)
target_link_libraries(rnis_pano_android_s1_tests
  rnis_pano_android_s1 GTest::gtest_main)

# ── the ANDROID LIVE PREVIEW pump (pano+ Android live arm, 2026-09-02) ─────
# cpp/rnis_pano_android_preview.{hpp,cpp} is the growing canvas the operator
# watches: refresh throttle, `Engine::previewIntoFit` render, coalesced atomic
# publish, and the counters that make all three falsifiable from a pack.
#
# A SEPARATE library for the reason its header states: on iOS the same policy
# lives inline in RNISPanoCore.mm and has been wrong twice — a publish that
# swallowed every cv::Exception for eleven days, and a refresh clock that did
# not advance on refused renders — and BOTH are pure policy defects that no
# suite could reach because the policy was in the platform seam.  Here the host
# gtest reaches them.
#
# It links `rnis_pano` (Engine + publishJpegAtomically) and therefore OpenCV,
# and pulls in <thread>/<condition_variable> for its publish worker, which is
# why it is not in the OpenCV-free attitude/calib group.
add_library(rnis_pano_android_preview STATIC
  ${RNIS_CPP_DIR}/rnis_pano_android_preview.cpp
)
target_include_directories(rnis_pano_android_preview PUBLIC
  ${RNIS_CPP_DIR}
  ${RNIS_SHARED_CPP_DIR}
)
target_link_libraries(rnis_pano_android_preview PUBLIC rnis_pano)
find_package(Threads REQUIRED)
target_link_libraries(rnis_pano_android_preview PUBLIC Threads::Threads)

# ── the LIVE SESSION (Android live arm, 2026-09-02) ────────────────────────
# cpp/rnis_pano_live.{hpp,cpp} is everything RNISPanoCore.mm does that is NOT
# Objective-C: engine lifecycle, pixel conversion, per-frame ingest, the ledger,
# canvas.jpg, meta.json, the status snapshot and the finalize summary.  It holds
# NO threads (the caller owns those, and the preview pump owns its own), which
# is exactly what makes it runnable here with no camera and no JNI.
#
# That is the point of the split.  On iOS the same logic needs a device, an
# ARKit session and a camera to execute one line of, and the defects it has
# shipped — a publish that swallowed every exception for eleven days, a refresh
# clock that did not advance on refused renders — all lived in that
# untestability.  The Android twin of that seam is asserted before the phone is
# plugged in.
#
# It links `rnis_pano_replay` (it writes the ledger through the replay driver's
# OWN row writer, and its meta.json config block through the same knob table
# replay reads back) and `rnis_pano_android_preview` (the growing canvas).
add_library(rnis_pano_live STATIC
  ${RNIS_CPP_DIR}/rnis_pano_live.cpp
)
target_include_directories(rnis_pano_live PUBLIC
  ${RNIS_CPP_DIR}
  ${RNIS_SHARED_CPP_DIR}
)
target_link_libraries(rnis_pano_live PUBLIC rnis_pano_replay rnis_pano_android_preview)

add_executable(rnis_pano_live_tests
  ${RNIS_TESTS_DIR}/rnis_pano_live_test.cpp
)
target_link_libraries(rnis_pano_live_tests rnis_pano_live GTest::gtest_main)

add_executable(rnis_pano_android_preview_tests
  ${RNIS_TESTS_DIR}/rnis_pano_android_preview_test.cpp
)
target_link_libraries(rnis_pano_android_preview_tests
  rnis_pano_android_preview GTest::gtest_main)

include(GoogleTest)

# ── OPTIMIZATION SCOPE — RESOLVED 2026-08-23, was a FIXTURE bug ────────────
#
# These tests are configured with no CMAKE_BUILD_TYPE, i.e. -O0.  That used to
# matter: at -O2/-Os, PanoGate.TheDivergenceBarIsNormalisedNotAbsolute failed
# deterministically and PanoDeterminism failed when run alone, with the
# geometry identical between builds and only the PHOTOMETRIC block moving
# (seam DC step 1.0 -> 56-101 DN, drift 3.5% -> 420-900%).  That was written up
# here as an OPEN question about the engine on optimized builds, since the
# Release pod builds at -Os.
#
# IT WAS NOT THE ENGINE.  runProjectedSweep's synthetic per-frame noise called
#
#     rng.fill(noise, cv::RNG::NORMAL, 0.0, s.noiseDN);
#
# on a CV_16SC3 destination.  RNG::fill takes its parameters as InputArray; a
# bare double is a 1x1 array against a 3-channel destination, which is simply
# undefined — and it does not misbehave the same way twice.  Re-measured
# 2026-08-23 in one -O0 binary: the noise buffer came back all-zero for frame 0
# and carrying -32768 for frames 1-2; in a standalone probe it came back
# all-zero at every size tried; and adding one unrelated 9 MB allocate/free
# beside the call was enough to turn a build that FAILED PanoDeterminism into
# one that passed, with no change to any line the engine runs.  So resist
# giving it a tidier mechanism than that: the effect that matters is that the
# frames handed to ingest() stopped being a function of the spec (first
# differing frame index 9; the sweep's first differing output row is 9 too).
# Fixed by passing cv::Scalar::all for both parameters; see the comment at the
# call site and PanoDeterminism.EveryRunInAProcessIsBitIdenticalIncludingTheFirst.
#
# The ENGINE's own purity is now pinned separately and unambiguously by
# PanoDeterminism.TheEngineIsAPureFunctionOfItsInputs (frames rendered once,
# four fresh engines over the SAME buffers).  That test stays green even on a
# build with the broken fill still in it, which is precisely the discrimination
# two earlier investigations lacked when they indicted the engine.
#
# Verified after the fix, same host OpenCV, whole suite via ctest:
#
#     -O0   112/112        -O2   112/112        -Os   112/112
#
# so the level is no longer a caveat on these results.  What is still NOT
# covered is the device: it links a vendored OpenCV 4.10 (arm64, no IPP), and
# nothing here speaks for that build — the offline twin is graded against a
# shipped device ledger for exactly that reason.
#
# Treat warnings as errors in the test build, matching the public stitcher's
# cpp/tests project.  Without this the two estates are on different tiers and
# a warning-clean move stops being checkable: the kind of defect this catches
# (unused variable, signed/unsigned compare, narrowing conversion) is exactly
# what a cross-compilation flag set suppresses on the device.
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  foreach(_rnis_tgt
      rnis_jni_utf8_tests
      rnis_pano_tests
      rnis_pano_replay_tests
      rnis_pano_attitude_tests
      rnis_pano_calib_tests
      rnis_pano_android_basis_tests
      rnis_pano_android_report_tests
      rnis_pano_android_s1_tests
      rnis_pano_android_preview_tests
      rnis_pano_live_tests
  )
    target_compile_options(${_rnis_tgt} PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endforeach()
endif()

# Generous discovery timeout: under Rosetta (see the arch detection above)
# the first run of the freshly linked binary pays the x86_64 translation
# cost, which can exceed the 5 s default.
gtest_discover_tests(rnis_jni_utf8_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_replay_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_attitude_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_calib_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_android_basis_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_android_report_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_android_s1_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_android_preview_tests DISCOVERY_TIMEOUT 120)
gtest_discover_tests(rnis_pano_live_tests DISCOVERY_TIMEOUT 120)
