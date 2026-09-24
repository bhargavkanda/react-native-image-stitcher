#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# tools/d3-basis-proof/run_all.sh — build both proofs and run them over the
# packs in packs.txt.  Everything it writes lands under tools/d3-basis-proof/
# (build/ and out/, both gitignored).
#
#   tools/d3-basis-proof/run_all.sh                 # all packs, default arms
#   ARMS="ar 8 0 9" tools/d3-basis-proof/run_all.sh
#   NODE=/path/to/node22 tools/d3-basis-proof/run_all.sh
#
# ARMS: "ar" = the pack's own ARKit track.jsonl; "arq" = ARKit's q in the
# vision-camera arm's row shape (t = 0, no ARKit exposure); an integer = the
# CoreMotion sidecar through that basis index.  Defaults: the truth (#8), two wrong bases
# the plan names (#0 quarter turn, #9 sign flip), a single-axis flip (#10), and
# the two wrong bases that COMMUTE with the sweep axis (#11, #13 — the
# degeneracy the image check is predicted to be blind to).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "${HERE}/../.." && pwd)"
BUILD="${HERE}/build"
OUT="${HERE}/out"
ARMS="${ARMS:-ar arq 8 0 9 10 11 13}"

OPENCV_DIR_DEFAULT="${PKG}/build/opencv-host/install/lib/cmake/opencv4"
OpenCV_DIR="${OpenCV_DIR:-${OPENCV_DIR_DEFAULT}}"

cmake -S "${HERE}" -B "${BUILD}" -DOpenCV_DIR="${OpenCV_DIR}" >/dev/null
cmake --build "${BUILD}" -j8 >/dev/null

mkdir -p "${OUT}"

# (1a) the derivation the iOS arm now runs.
"${BUILD}/d3_select_basis" --derive > "${OUT}/derive.jsonl"

# (1b) selectBasis per pack, and (2) the negative control.
: > "${OUT}/select.jsonl"
: > "${OUT}/replay.jsonl"
grep -v '^#' "${HERE}/packs.txt" | while IFS=$'\t' read -r tag dir; do
  [[ -z "${tag}" ]] && continue
  "${BUILD}/d3_select_basis" "${dir}" >> "${OUT}/select.jsonl" || true
  # shellcheck disable=SC2086
  "${BUILD}/d3_basis_replay" "${dir}" "${OUT}" "${tag}" ${ARMS} >> "${OUT}/replay.jsonl" || true
done

# Tables, with the verdict from the SHIPPED JS function.
NODE="${NODE:-node}"
"${NODE}" --experimental-strip-types --no-warnings "${HERE}/tables.mjs" "${OUT}"
