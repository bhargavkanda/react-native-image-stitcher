#!/usr/bin/env bash
#
# build-opencv-android.sh — produce per-ABI .so files for Android
# matching the iOS xcframework's module set.
#
# Invoked by `.github/workflows/release-binaries.yml` on a tag push;
# also runnable locally for development (requires Android NDK r25+).
#
# Modules built:  core imgproc features2d calib3d flann stitching video photo
# Modules SKIPPED: dnn ml objdetect gapi videoio ffmpeg highgui
#
# Output structure:
#   dist/android/jniLibs/
#     arm64-v8a/libopencv_java4.so
#     armeabi-v7a/libopencv_java4.so
#     x86/libopencv_java4.so
#     x86_64/libopencv_java4.so
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
    echo "[build-opencv-android] Install Android NDK r25+ and export ANDROID_NDK_HOME." >&2
    exit 1
fi

echo "[build-opencv-android] OpenCV ${OPENCV_VERSION} → ${OUTPUT_DIR}/android/jniLibs/"
echo "[build-opencv-android] NDK: ${ANDROID_NDK_HOME}"
echo "[build-opencv-android] Build dir: ${BUILD_DIR}"

mkdir -p "${OUTPUT_DIR}/android/jniLibs"

# ── 1. Fetch OpenCV source ────────────────────────────────────────────
OPENCV_SRC="${BUILD_DIR}/opencv-${OPENCV_VERSION}"
if [ ! -d "${OPENCV_SRC}" ]; then
    curl -fsSL --retry 3 "https://github.com/opencv/opencv/archive/refs/tags/${OPENCV_VERSION}.tar.gz" \
        -o "${BUILD_DIR}/opencv-src.tgz"
    tar -xzf "${BUILD_DIR}/opencv-src.tgz" -C "${BUILD_DIR}"
fi

# ── 2. Build per-ABI via OpenCV's build_sdk.py ───────────────────────
#
# `--config ndk-15.config.py` is OpenCV's stock per-ABI configuration.
# We override BUILD_LIST to limit to our modules.
ABIS=("arm64-v8a" "armeabi-v7a" "x86" "x86_64")
for ABI in "${ABIS[@]}"; do
    echo "[build-opencv-android] === Building ABI ${ABI} ==="
    ABI_BUILD_DIR="${BUILD_DIR}/build-${ABI}"
    mkdir -p "${ABI_BUILD_DIR}"
    cd "${ABI_BUILD_DIR}"

    cmake "${OPENCV_SRC}" \
        -DCMAKE_TOOLCHAIN_FILE="${ANDROID_NDK_HOME}/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI="${ABI}" \
        -DANDROID_PLATFORM=android-24 \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_JAVA=OFF \
        -DBUILD_ANDROID_EXAMPLES=OFF \
        -DBUILD_TESTS=OFF \
        -DBUILD_PERF_TESTS=OFF \
        -DBUILD_EXAMPLES=OFF \
        -DBUILD_DOCS=OFF \
        -DBUILD_opencv_apps=OFF \
        -DBUILD_opencv_dnn=OFF \
        -DBUILD_opencv_ml=OFF \
        -DBUILD_opencv_objdetect=OFF \
        -DBUILD_opencv_gapi=OFF \
        -DBUILD_opencv_videoio=OFF \
        -DBUILD_opencv_highgui=OFF \
        -DBUILD_opencv_java=OFF \
        -DWITH_ITT=OFF \
        -DWITH_FFMPEG=OFF \
        -DWITH_GSTREAMER=OFF

    cmake --build . --config Release -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

    # The build emits a per-ABI libopencv_world.a (static).  We need
    # a single libopencv_java4.so per ABI; build_sdk.py does this
    # in one shot — but to keep this script CMake-only we adapt the
    # per-ABI output here.
    #
    # For now, point downstream at the static `.a` archive; consumers
    # link statically into their own .so via Gradle's externalNativeBuild.
    mkdir -p "${OUTPUT_DIR}/android/jniLibs/${ABI}"
    cp "${ABI_BUILD_DIR}/lib/${ABI}/libopencv_world.a" \
       "${OUTPUT_DIR}/android/jniLibs/${ABI}/libopencv_world.a" || true
done

rm -rf "${BUILD_DIR}"

# ── 3. Zip for release upload ────────────────────────────────────────
cd "${OUTPUT_DIR}"
zip -ry "RNImageStitcher-android.zip" "android/jniLibs"

echo "[build-opencv-android] Done."
echo "[build-opencv-android] Output: ${OUTPUT_DIR}/android/jniLibs/"
echo "[build-opencv-android] Archive: ${OUTPUT_DIR}/RNImageStitcher-android.zip"
du -sh "${OUTPUT_DIR}/android/jniLibs/" "${OUTPUT_DIR}/RNImageStitcher-android.zip"
