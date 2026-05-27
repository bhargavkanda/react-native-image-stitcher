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

cmake -S "${REPO_ROOT}/cpp/tests" -B "${BUILD_DIR}"
cmake --build "${BUILD_DIR}"

# `ctest --output-on-failure` prints stdout/stderr for failing cases only;
# passing cases stay quiet (which keeps a green run readable in CI logs).
(cd "${BUILD_DIR}" && ctest --output-on-failure)
