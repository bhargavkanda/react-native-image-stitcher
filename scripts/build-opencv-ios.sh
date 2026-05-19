#!/usr/bin/env bash
#
# build-opencv-ios.sh — produce RNImageStitcher.xcframework with the
# OpenCV modules this library actually needs.
#
# Invoked by `.github/workflows/release-binaries.yml` on a tag push;
# also runnable locally for development verification (slow — first
# build is 20-40 min on an M-series Mac).
#
# Modules built:
#   core imgproc features2d calib3d flann stitching video photo
#
# Modules SKIPPED (saves ~50 % of the binary size):
#   dnn ml objdetect gapi videoio_ffmpeg
#
# Output: dist/RNImageStitcher.xcframework (arm64 device +
#   arm64+x86_64 simulator slices).  Approx. 55-75 MB stripped.
#
# Inputs (env):
#   OPENCV_VERSION  — pinned in scripts/opencv-version.txt; allow
#                     override for one-off builds against a newer
#                     OpenCV release.
#   OUTPUT_DIR      — defaults to ./dist
#
# Pre-reqs:
#   Xcode (any current version), python3, git.  No CocoaPods needed
#   — we build the xcframework directly from OpenCV's CMake project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OPENCV_VERSION="${OPENCV_VERSION:-$(cat "${SCRIPT_DIR}/opencv-version.txt")}"
OUTPUT_DIR="${OUTPUT_DIR:-${SDK_ROOT}/dist}"
BUILD_DIR="$(mktemp -d -t opencv-ios-build-XXXX)"

echo "[build-opencv-ios] OpenCV ${OPENCV_VERSION} → ${OUTPUT_DIR}/RNImageStitcher.xcframework"
echo "[build-opencv-ios] Build dir: ${BUILD_DIR}"

mkdir -p "${OUTPUT_DIR}"

# ── 1. Fetch OpenCV source ────────────────────────────────────────────
OPENCV_SRC="${BUILD_DIR}/opencv-${OPENCV_VERSION}"
if [ ! -d "${OPENCV_SRC}" ]; then
    curl -fsSL --retry 3 "https://github.com/opencv/opencv/archive/refs/tags/${OPENCV_VERSION}.tar.gz" \
        -o "${BUILD_DIR}/opencv-src.tgz"
    tar -xzf "${BUILD_DIR}/opencv-src.tgz" -C "${BUILD_DIR}"
fi

# ── 2. Build the xcframework via OpenCV's own build_xcframework.py ───
#
# Module filtering is done via --without — we exclude what we don't
# use, the rest builds.  --build_only_specified_archs and --iphoneos
# are the standard set for shipping to App Store (iOS 13+, arm64
# device + simulator).
PY_CMD="python3 ${OPENCV_SRC}/platforms/apple/build_xcframework.py"
${PY_CMD} \
    --out "${OUTPUT_DIR}/xcframework-build" \
    --iphoneos_archs arm64 \
    --iphonesimulator_archs arm64,x86_64 \
    --build_only_specified_archs \
    --without dnn \
    --without ml \
    --without objdetect \
    --without gapi \
    --without videoio \
    --without highgui \
    --framework_name RNImageStitcher

# ── 3. Move + clean ──────────────────────────────────────────────────
mv "${OUTPUT_DIR}/xcframework-build/RNImageStitcher.xcframework" \
   "${OUTPUT_DIR}/RNImageStitcher.xcframework"
rm -rf "${OUTPUT_DIR}/xcframework-build"
rm -rf "${BUILD_DIR}"

# ── 4. Zip for release upload ────────────────────────────────────────
cd "${OUTPUT_DIR}"
zip -ry "RNImageStitcher-ios.zip" "RNImageStitcher.xcframework"

echo "[build-opencv-ios] Done."
echo "[build-opencv-ios] Output: ${OUTPUT_DIR}/RNImageStitcher.xcframework"
echo "[build-opencv-ios] Archive: ${OUTPUT_DIR}/RNImageStitcher-ios.zip"
du -sh "${OUTPUT_DIR}/RNImageStitcher.xcframework" "${OUTPUT_DIR}/RNImageStitcher-ios.zip"
