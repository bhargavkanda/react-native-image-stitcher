#!/usr/bin/env bash
#
# build-opencv-android.sh — fetch OpenCV's official prebuilt Android
# SDK and repackage as our `RNImageStitcher-android.zip` release asset.
#
# Why use the prebuilt instead of building from source?
#   1. Reliability — the OpenCV team builds + signs this release with
#      every OpenCV tag.  Our own build invocations against
#      `build_sdk.py` are fragile across OpenCV versions (the flag
#      syntax has shifted multiple times).
#   2. Time — the prebuilt download is ~200 MB and completes in <30 s.
#      Building 4-ABI from source takes 60-90 min on a GH runner.
#   3. Module set — the prebuilt's `libopencv_java4.so` is built with
#      the full feature set, including the static archives for
#      `stitching` that our JNI shim links in.
#
# Trade-off: the .so is larger than a custom-trimmed build (~30 MB per
# ABI for the full vs ~10 MB for a slim build).  We can swap to a
# slim build in a future release once the slim recipe stabilises.
#
# Output layout matches what `image_stitcher_jni.cpp`'s CMakeLists
# expects (`OpenCV-android-sdk/sdk/native/{libs,staticlibs,jni/include}`).
#
# Inputs (env):
#   OPENCV_VERSION — pinned in scripts/opencv-version.txt
#   OUTPUT_DIR     — defaults to ./dist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OPENCV_VERSION="${OPENCV_VERSION:-$(cat "${SCRIPT_DIR}/opencv-version.txt")}"
OUTPUT_DIR="${OUTPUT_DIR:-${SDK_ROOT}/dist}"

echo "[build-opencv-android] OpenCV ${OPENCV_VERSION} → ${OUTPUT_DIR}/OpenCV-android-sdk/"

mkdir -p "${OUTPUT_DIR}"

# ── 1. Download OpenCV's prebuilt Android SDK ────────────────────────
URL="https://github.com/opencv/opencv/releases/download/${OPENCV_VERSION}/opencv-${OPENCV_VERSION}-android-sdk.zip"
ZIP_PATH="${OUTPUT_DIR}/opencv-android-source.zip"

echo "[build-opencv-android] Fetching ${URL}"
curl -fsSL --retry 3 "${URL}" -o "${ZIP_PATH}"

# ── 2. Extract ───────────────────────────────────────────────────────
cd "${OUTPUT_DIR}"
rm -rf OpenCV-android-sdk
unzip -q "${ZIP_PATH}"
rm "${ZIP_PATH}"

# ── 3. Verify expected layout ────────────────────────────────────────
for ABI in arm64-v8a armeabi-v7a x86 x86_64; do
    SO_PATH="${OUTPUT_DIR}/OpenCV-android-sdk/sdk/native/libs/${ABI}/libopencv_java4.so"
    STITCHING_A="${OUTPUT_DIR}/OpenCV-android-sdk/sdk/native/staticlibs/${ABI}/libopencv_stitching.a"
    if [ ! -f "${SO_PATH}" ]; then
        echo "[build-opencv-android] FATAL: ${SO_PATH} not in extracted SDK" >&2
        exit 1
    fi
    if [ ! -f "${STITCHING_A}" ]; then
        echo "[build-opencv-android] FATAL: ${STITCHING_A} not in extracted SDK" >&2
        exit 1
    fi
done
echo "[build-opencv-android] Per-ABI libopencv_java4.so + libopencv_stitching.a all present."

# ── 4. Zip for release upload ────────────────────────────────────────
zip -ry "RNImageStitcher-android.zip" "OpenCV-android-sdk"

echo "[build-opencv-android] Done."
echo "[build-opencv-android] Output: ${OUTPUT_DIR}/OpenCV-android-sdk/"
echo "[build-opencv-android] Archive: ${OUTPUT_DIR}/RNImageStitcher-android.zip"
du -sh "${OUTPUT_DIR}/OpenCV-android-sdk/" "${OUTPUT_DIR}/RNImageStitcher-android.zip"
