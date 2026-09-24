#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# scripts/run-cpp-tests.sh — the shared-C++ Google Test runner.
#
# Configures, builds and runs EVERY C++ test project in the repo.  Invoked by
# developers locally and by the `native-cpp` job in .github/workflows/ci.yml.
#
# Usage:
#   scripts/run-cpp-tests.sh                    # build + run every project
#   scripts/run-cpp-tests.sh --clean            # nuke the build dirs first
#   scripts/run-cpp-tests.sh --allow-no-opencv  # tolerate a missing host OpenCV
#
# Build artefacts land under `build/cpp-tests*/` (gitignored).
#
# ── ONE BUILD DIR PER PROJECT, ALWAYS ────────────────────────────────────
# Pointing an existing CMake build directory at a different source directory
# makes CMake refuse outright, so each project gets its own.  They also must
# NOT share FETCHCONTENT_BASE_DIR: with a shared one both configures exit 0
# and then the FIRST-configured project dies at link time on a missing
# `lib/libgtest_main.a`.  Each project fetches its own googletest.
#
# ── WHY THERE IS A MINIMUM CASE COUNT ────────────────────────────────────
# Every project here declares its OpenCV-dependent cases inside an
# `if(OpenCV_FOUND)` branch.  With no host OpenCV, CMake configures those out,
# the build succeeds, and `ctest` prints
#
#     100% tests passed, 0 tests failed out of 138
#
# and exits 0 — versus 147 with OpenCV present.  Nine cases vanish behind a
# green run, and nothing in the output says so.  (115/124 before 0.25 added
# 23 OpenCV-free cases: stitcher_ladder_test 17, keyframe_timebudget_test 6.)  The host OpenCV lives under
# `build/opencv-host/install`, and `/build/` is gitignored, so SKIPPING IS THE
# DEFAULT STATE OF EVERY FRESH CLONE AND EVERY CI RUNNER.  The floors below
# make that impossible to miss.  Raise a floor when you add cases; never lower
# one to make a run go green.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CLEAN=0
ALLOW_NO_OPENCV=0
for arg in "$@"; do
  case "$arg" in
    --clean)            CLEAN=1 ;;
    --allow-no-opencv)  ALLOW_NO_OPENCV=1 ;;
    *) echo "[run-cpp-tests] unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ── The projects, and the case count each must reach ─────────────────────
# name|source dir|minimum cases with a host OpenCV|minimum cases without
#
# ⚠ `panoplus` uses `find_package(OpenCV REQUIRED)` with no COMPONENTS list,
# so with no host OpenCV it FAILS TO CONFIGURE rather than quietly dropping
# its OpenCV cases. Its two floors are therefore equal: there is no
# reduced-coverage mode to have a lower number for.
PROJECTS=(
  "core|cpp/tests|147|138"
  "panoplus|cpp/tests/panoplus|560|560"
)

# ── Host OpenCV ──────────────────────────────────────────────────────────
# Honour an explicit OpenCV_DIR; otherwise auto-detect the local minimal host
# build.  A static core+imgproc build is enough for `cpp/tests`; other
# projects need the full set (imgcodecs for imread/imwrite), so prefer a
# complete build when you have the disk.
if [[ -z "${OpenCV_DIR:-}" ]]; then
  LOCAL_OPENCV="${REPO_ROOT}/build/opencv-host/install/lib/cmake/opencv4"
  if [[ -d "${LOCAL_OPENCV}" ]]; then
    export OpenCV_DIR="${LOCAL_OPENCV}"
    echo "[run-cpp-tests] using local host OpenCV at ${LOCAL_OPENCV}"
  fi
fi

HAVE_OPENCV=0
if [[ -n "${OpenCV_DIR:-}" ]] || pkg-config --exists opencv4 2>/dev/null; then
  HAVE_OPENCV=1
fi

if [[ "${HAVE_OPENCV}" -eq 0 ]]; then
  if [[ "${ALLOW_NO_OPENCV}" -eq 1 ]]; then
    cat >&2 <<'BANNER'
################################################################################
#  NO HOST OpenCV FOUND — THE OpenCV-DEPENDENT CASES WILL NOT BE BUILT OR RUN.
#  This run is NOT full coverage. It is being allowed only because
#  --allow-no-opencv was passed. Do not read the green result as a pass.
#  Install one:  apt-get install libopencv-dev   (or set OpenCV_DIR)
################################################################################
BANNER
  else
    echo "[run-cpp-tests] FATAL: no host OpenCV found." >&2
    echo "  Without it the OpenCV-dependent cases are configured out and ctest" >&2
    echo "  still exits 0 — a green run that covers less than it claims." >&2
    echo "  Install one (apt-get install libopencv-dev), set OpenCV_DIR, or" >&2
    echo "  pass --allow-no-opencv to accept the reduced coverage explicitly." >&2
    exit 1
  fi
fi

FAILED=()

for spec in "${PROJECTS[@]}"; do
  IFS='|' read -r NAME SRC MIN_WITH MIN_WITHOUT <<< "$spec"
  BUILD_DIR="${REPO_ROOT}/build/cpp-tests-${NAME}"
  # Keep the historical path for the core project so existing local build
  # dirs and docs keep working.
  [[ "${NAME}" == "core" ]] && BUILD_DIR="${REPO_ROOT}/build/cpp-tests"

  if [[ "${CLEAN}" -eq 1 ]]; then
    echo "[run-cpp-tests] cleaning ${BUILD_DIR}"
    rm -rf "${BUILD_DIR}"
  fi

  echo "── ${NAME} (${SRC}) ───────────────────────────────────────────────"
  cmake -S "${REPO_ROOT}/${SRC}" -B "${BUILD_DIR}"
  cmake --build "${BUILD_DIR}" -j"$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu)"

  # Count the discovered cases BEFORE running them: `ctest -N` lists without
  # executing, so a project that fails to discover anything is caught here
  # rather than reported as "0 tests failed".
  DISCOVERED="$(cd "${BUILD_DIR}" && ctest -N | sed -n 's/^Total Tests: \([0-9]*\)$/\1/p')"
  FLOOR="${MIN_WITH}"
  [[ "${HAVE_OPENCV}" -eq 0 ]] && FLOOR="${MIN_WITHOUT}"
  echo "[run-cpp-tests] ${NAME}: discovered ${DISCOVERED} cases (floor ${FLOOR})"
  if [[ -z "${DISCOVERED}" || "${DISCOVERED}" -lt "${FLOOR}" ]]; then
    echo "[run-cpp-tests] FAIL: ${NAME} discovered ${DISCOVERED:-0} cases, expected >= ${FLOOR}." >&2
    echo "  Cases went missing silently. Find out which before touching this floor." >&2
    FAILED+=("${NAME} (case count)")
    continue
  fi

  # `--output-on-failure` prints stdout/stderr for failing cases only, which
  # keeps a green run readable.  Collect failures instead of exiting: with
  # `set -e` and a serial loop, the first failing project would take every
  # later project dark on a run that has already gone red anyway.
  if ! (cd "${BUILD_DIR}" && ctest --output-on-failure -j"$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu)"); then
    FAILED+=("${NAME} (case failures)")
  fi
done

if [[ "${#FAILED[@]}" -gt 0 ]]; then
  echo "[run-cpp-tests] FAILED: ${FAILED[*]}" >&2
  exit 1
fi
echo "[run-cpp-tests] all projects passed"
