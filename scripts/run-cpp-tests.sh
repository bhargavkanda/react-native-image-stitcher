#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# scripts/run-cpp-tests.sh — v0.10.0 audit #9A
#
# Configures + builds + runs the shared-C++ Google Test suite under
# `cpp/tests/`.  Used by developers locally and (in a follow-up PR) by
# the CI workflow.
#
# Usage:
#   scripts/run-cpp-tests.sh           # build + run
#   scripts/run-cpp-tests.sh --clean   # nuke build dir first
#
# Build artefacts land under `build/cpp-tests/` (gitignored).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build/cpp-tests"

if [[ "${1:-}" == "--clean" ]]; then
  echo "[run-cpp-tests] cleaning ${BUILD_DIR}"
  rm -rf "${BUILD_DIR}"
fi

# OpenCV-dependent tests (cpp/tests/sharpness_test.cpp) need a host
# OpenCV (core+imgproc).  Honour an explicit OpenCV_DIR from the
# environment; otherwise auto-detect the local minimal host build under
# build/opencv-host/install (a static core+imgproc build is enough --
# cmake -DBUILD_LIST=core,imgproc -DBUILD_SHARED_LIBS=OFF against the
# OpenCV 4.x source tree, installed to that prefix).  When neither is
# present the OpenCV-dependent tests are skipped with a CMake warning;
# everything else still runs.
if [[ -z "${OpenCV_DIR:-}" ]]; then
  LOCAL_OPENCV="${REPO_ROOT}/build/opencv-host/install/lib/cmake/opencv4"
  if [[ -d "${LOCAL_OPENCV}" ]]; then
    export OpenCV_DIR="${LOCAL_OPENCV}"
    echo "[run-cpp-tests] using local host OpenCV at ${LOCAL_OPENCV}"
  fi
fi

cmake -S "${REPO_ROOT}/cpp/tests" -B "${BUILD_DIR}"
cmake --build "${BUILD_DIR}"

# `ctest --output-on-failure` prints stdout/stderr for failing cases only;
# passing cases stay quiet (which keeps a green run readable in CI logs).
(cd "${BUILD_DIR}" && ctest --output-on-failure)
