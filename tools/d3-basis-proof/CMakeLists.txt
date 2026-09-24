# SPDX-License-Identifier: Apache-2.0
#
# tools/d3-basis-proof — the two D3 offline proofs, built against the SAME
# shared C++ the production targets compile (cpp/panoplus/*.cpp, in place —
# nothing copied, nothing re-implemented) and the host OpenCV the C++ test
# suite uses (build/opencv-host/install, see scripts/run-cpp-tests.sh).
#
#   cmake -S tools/d3-basis-proof -B tools/d3-basis-proof/build \
#         -DOpenCV_DIR=$PWD/build/opencv-host/install/lib/cmake/opencv4
#   cmake --build tools/d3-basis-proof/build -j
#
# No build type is set, matching build/cpp-tests-panoplus (the replay test's
# own build), so the engine runs under the same flags the host replay does.

cmake_minimum_required(VERSION 3.20)
project(d3_basis_proof CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(D3_PKG_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../..)
set(D3_PANO_DIR ${D3_PKG_DIR}/cpp/panoplus)
if(NOT EXISTS "${D3_PANO_DIR}/rnis_pano_attitude.cpp")
  message(FATAL_ERROR "cpp/panoplus not found at ${D3_PANO_DIR}")
endif()

find_package(OpenCV REQUIRED)

# STL-only half: the attitude seam, the calibration grader, the derivation.
add_library(d3_attitude STATIC
  ${D3_PANO_DIR}/rnis_pano_attitude.cpp
  ${D3_PANO_DIR}/rnis_pano_calib.cpp
  ${D3_PANO_DIR}/rnis_pano_android_basis.cpp
)
target_include_directories(d3_attitude PUBLIC ${D3_PANO_DIR})

# The engine + the pack replay driver.
add_library(d3_engine STATIC
  ${D3_PANO_DIR}/rnis_pano.cpp
  ${D3_PANO_DIR}/rnis_pano_replay.cpp
)
target_include_directories(d3_engine PUBLIC ${D3_PANO_DIR} ${D3_PKG_DIR}/cpp ${OpenCV_INCLUDE_DIRS})
target_link_libraries(d3_engine PUBLIC ${OpenCV_LIBS})

# (1) selectBasis over the packs + deriveBasis(90, Back, Raw).
#     Links the engine only for replay::parseTrackRow (the replay's own
#     track.jsonl parser), so the reference series is read exactly as a
#     replay reads it.
add_executable(d3_select_basis ${CMAKE_CURRENT_SOURCE_DIR}/d3_select_basis.cpp)
target_link_libraries(d3_select_basis d3_attitude d3_engine)

# (2) the wrong-basis negative control.
add_executable(d3_basis_replay ${CMAKE_CURRENT_SOURCE_DIR}/d3_basis_replay.cpp)
target_link_libraries(d3_basis_replay d3_attitude d3_engine)
