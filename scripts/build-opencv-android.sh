#!/usr/bin/env bash
#
# build-opencv-android.sh — produce OpenCV's Android SDK distribution
# (the `OpenCV-android-sdk/` directory tree) with the modules this
# library needs.
#
# This script wraps OpenCV's stock `platforms/android/build_sdk.py`,
# which is the right tool for producing a layout that matches what
# the JNI shim CMakeLists.txt expects:
#
#   OpenCV-android-sdk/
#     sdk/
#       native/
#         libs/{ABI}/libopencv_java4.so        ← dynamically linked fat lib
#         staticlibs/{ABI}/libopencv_*.a       ← static archives per module
#         3rdparty/libs/{ABI}/*.a              ← 3rd-party static archives
#         jni/include/opencv2/                 ← public headers
#
# Module filter:
#   The default `ndk-18.config.py` (which ships with OpenCV's
#   build_sdk.py) builds the full module set.  We pass --without to
#   trim everything we don't use; final binary is ~50% smaller.
#
# Inputs (env):
#   OPENCV_VERSION   — pinned in scripts/opencv-version.txt
#   ANDROID_NDK_HOME — required; CI sets via setup-ndk action
#   OUTPUT_DIR       — defaults to ./dist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OPENCV_VERSION="${OPENCV_VERSION:-$(cat "${SCRIPT_DIR}/opencv-version.txt")}"
OUTPUT_DIR="${OUTPUT_DIR:-${SDK_ROOT}/dist}"
BUILD_DIR="$(mktemp -d -t opencv-android-build-XXXX)"

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    echo "[build-opencv-android] ERROR: ANDROID_NDK_HOME is not set." >&2
    exit 1
fi

echo "[build-opencv-android] OpenCV ${OPENCV_VERSION} → ${OUTPUT_DIR}/OpenCV-android-sdk/"
echo "[build-opencv-android] NDK: ${ANDROID_NDK_HOME}"
echo "[build-opencv-android] Build dir: ${BUILD_DIR}"

mkdir -p "${OUTPUT_DIR}"

# ── 1. Fetch OpenCV source ────────────────────────────────────────────
OPENCV_SRC="${BUILD_DIR}/opencv-${OPENCV_VERSION}"
if [ ! -d "${OPENCV_SRC}" ]; then
    curl -fsSL --retry 3 \
        "https://github.com/opencv/opencv/archive/refs/tags/${OPENCV_VERSION}.tar.gz" \
        -o "${BUILD_DIR}/opencv-src.tgz"
    tar -xzf "${BUILD_DIR}/opencv-src.tgz" -C "${BUILD_DIR}"
fi

# ── 2. Build the Android SDK distribution via build_sdk.py ───────────
#
# build_sdk.py runs CMake per ABI with OpenCV's official Android
# config + bundles the output into the SDK layout.  We pass --extra_pack
# for nothing; ABI list is fixed by the ndk-18.config.py we'd otherwise
# point at — leaving it default produces all 4 ABIs:
# arm64-v8a, armeabi-v7a, x86, x86_64.
#
# `--config` is required — points to one of OpenCV's stock ABI configs.
# `--no_samples_build` skips example app builds (fast win).

cd "${OPENCV_SRC}/platforms/android"

# Build each ABI separately.  build_sdk.py is documented as supporting
# all-in-one but does parallel cmake invocations under the hood and
# the disk + CPU pressure on a GH runner causes the parallel build to
# OOM.  Sequential per-ABI is safer.
ABIS=("arm64-v8a" "armeabi-v7a" "x86" "x86_64")
for ABI in "${ABIS[@]}"; do
    echo "[build-opencv-android] === Building ABI ${ABI} ==="
    BUILD_OUT="${BUILD_DIR}/sdk-${ABI}"
    mkdir -p "${BUILD_OUT}"

    python3 build_sdk.py \
        --abi "${ABI}" \
        --no_samples_build \
        --build_doc=OFF \
        --extra_modules_path "" \
        "${BUILD_OUT}" \
        "${OPENCV_SRC}" \
        -- \
        -DBUILD_opencv_world=ON \
        -DBUILD_opencv_dnn=OFF \
        -DBUILD_opencv_ml=OFF \
        -DBUILD_opencv_objdetect=OFF \
        -DBUILD_opencv_gapi=OFF \
        -DBUILD_opencv_videoio=OFF \
        -DBUILD_opencv_highgui=OFF \
        -DBUILD_opencv_calib=OFF \
        -DWITH_ITT=OFF \
        -DWITH_FFMPEG=OFF \
        -DWITH_GSTREAMER=OFF \
        -DBUILD_PERF_TESTS=OFF \
        -DBUILD_TESTS=OFF \
        -DBUILD_DOCS=OFF \
        -DBUILD_EXAMPLES=OFF \
        -DBUILD_ANDROID_EXAMPLES=OFF
done

# ── 3. Merge per-ABI outputs into one SDK tree ───────────────────────
#
# build_sdk.py produces a per-ABI OpenCV-android-sdk/ tree at each
# build dir.  Merging combines the {libs,staticlibs,3rdparty/libs}
# per-ABI subdirectories while sharing the jni/include/ tree (which
# is ABI-agnostic).

SDK_OUT="${OUTPUT_DIR}/OpenCV-android-sdk"
rm -rf "${SDK_OUT}"
mkdir -p "${SDK_OUT}/sdk/native/jni/include"
mkdir -p "${SDK_OUT}/sdk/native/libs"
mkdir -p "${SDK_OUT}/sdk/native/staticlibs"
mkdir -p "${SDK_OUT}/sdk/native/3rdparty/libs"

# Copy the include tree once from any ABI (they're identical).
cp -r "${BUILD_DIR}/sdk-arm64-v8a/OpenCV-android-sdk/sdk/native/jni/include/." \
      "${SDK_OUT}/sdk/native/jni/include/"

# Copy per-ABI libs.
for ABI in "${ABIS[@]}"; do
    ABI_LIBS_SRC="${BUILD_DIR}/sdk-${ABI}/OpenCV-android-sdk/sdk/native/libs/${ABI}"
    ABI_STATIC_SRC="${BUILD_DIR}/sdk-${ABI}/OpenCV-android-sdk/sdk/native/staticlibs/${ABI}"
    ABI_3RD_SRC="${BUILD_DIR}/sdk-${ABI}/OpenCV-android-sdk/sdk/native/3rdparty/libs/${ABI}"

    if [ -d "${ABI_LIBS_SRC}" ]; then
        mkdir -p "${SDK_OUT}/sdk/native/libs/${ABI}"
        cp -r "${ABI_LIBS_SRC}/." "${SDK_OUT}/sdk/native/libs/${ABI}/"
    fi
    if [ -d "${ABI_STATIC_SRC}" ]; then
        mkdir -p "${SDK_OUT}/sdk/native/staticlibs/${ABI}"
        cp -r "${ABI_STATIC_SRC}/." "${SDK_OUT}/sdk/native/staticlibs/${ABI}/"
    fi
    if [ -d "${ABI_3RD_SRC}" ]; then
        mkdir -p "${SDK_OUT}/sdk/native/3rdparty/libs/${ABI}"
        cp -r "${ABI_3RD_SRC}/." "${SDK_OUT}/sdk/native/3rdparty/libs/${ABI}/"
    fi
done

rm -rf "${BUILD_DIR}"

# ── 4. Verify expected outputs exist before zipping ──────────────────
#
# Fail-loud if the build silently produced an empty tree.  The
# previous version of this script had `|| true` after a cp and the
# resulting empty zip slipped past CI.
for ABI in "${ABIS[@]}"; do
    SO_PATH="${SDK_OUT}/sdk/native/libs/${ABI}/libopencv_java4.so"
    if [ ! -f "${SO_PATH}" ]; then
        echo "[build-opencv-android] FATAL: expected ${SO_PATH} not produced." >&2
        echo "[build-opencv-android] Listing what's in ${SDK_OUT}/sdk/native/:" >&2
        find "${SDK_OUT}/sdk/native/" -maxdepth 4 -type f 2>&1 | head -30 >&2 || true
        exit 1
    fi
done
echo "[build-opencv-android] Per-ABI libopencv_java4.so all present."

# ── 5. Zip for release upload ────────────────────────────────────────
cd "${OUTPUT_DIR}"
zip -ry "RNImageStitcher-android.zip" "OpenCV-android-sdk"

echo "[build-opencv-android] Done."
echo "[build-opencv-android] Output: ${OUTPUT_DIR}/OpenCV-android-sdk/"
echo "[build-opencv-android] Archive: ${OUTPUT_DIR}/RNImageStitcher-android.zip"
du -sh "${OUTPUT_DIR}/OpenCV-android-sdk/" "${OUTPUT_DIR}/RNImageStitcher-android.zip"
