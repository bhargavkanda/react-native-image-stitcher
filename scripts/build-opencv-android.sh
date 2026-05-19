#!/usr/bin/env bash
#
# build-opencv-android.sh — slim custom OpenCV Android SDK build via
# OpenCV's official `platforms/android/build_sdk.py`.  Matches the
# design doc's "Custom build" approach (NF1: ~10-15 MB per ABI,
# ~40-55 MB total Android).
#
# build_sdk.py is OpenCV's own scripted Android build:
#   - Reads `--ndk_path` for the toolchain.
#   - Builds all 4 ABIs (arm64-v8a, armeabi-v7a, x86, x86_64) in one
#     invocation.
#   - Output: <work_dir>/OpenCV-android-sdk/ with
#     `sdk/native/{libs,staticlibs,jni/include}/` layout that our JNI
#     shim's CMakeLists expects.
#
# Module filter:
#   --modules_list passes a comma-separated allow-list to the build.
#   We list only modules the stitcher needs.  Everything else is
#   skipped — saves ~50 % vs the full prebuilt SDK.
#
# Flag caveats (the v0.0.2 trip-ups):
#   - `--build_doc` / `--no_samples_build` etc are STORE-TRUE flags;
#     pass them WITHOUT `=value`.  Passing `=OFF` errors with
#     "ignored explicit argument 'OFF'".
#   - `--abi` is NOT a valid argument.  build_sdk.py builds all ABIs
#     defined in the config file in a single invocation.
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

# build_sdk.py needs the Android SDK path too (for build tools that
# integrate with the SDK).  GitHub Actions ubuntu-22.04 runners have
# it preinstalled at $ANDROID_HOME / $ANDROID_SDK_ROOT.  Allow either.
ANDROID_SDK_PATH="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "${ANDROID_SDK_PATH}" ]; then
    echo "[build-opencv-android] ERROR: ANDROID_HOME / ANDROID_SDK_ROOT not set." >&2
    exit 1
fi
echo "[build-opencv-android] Android SDK: ${ANDROID_SDK_PATH}"

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

# ── 2. Build via build_sdk.py (single invocation, all 4 ABIs) ─────────
cd "${OPENCV_SRC}/platforms/android"

SDK_BUILD_OUT="${BUILD_DIR}/sdk-output"
mkdir -p "${SDK_BUILD_OUT}"

# Notes on flags:
#   --ndk_path "${ANDROID_NDK_HOME}"  — explicit NDK location
#   --no_samples_build                — skip example app builds (faster)
#   --no_kotlin                       — skip the Kotlin SDK wrappers
#                                        (we use Java API via JNI directly)
#   --no_media_ndk                    — skip media NDK (we don't decode video)
#   --modules_list                    — allow-list; everything else is
#                                        excluded from the build
#
# Positional args: <work_dir> <opencv_dir>

python3 build_sdk.py \
    --ndk_path "${ANDROID_NDK_HOME}" \
    --sdk_path "${ANDROID_SDK_PATH}" \
    --no_samples_build \
    --no_kotlin \
    --no_media_ndk \
    --modules_list "core,imgproc,imgcodecs,features2d,calib3d,flann,stitching,video,videoio,photo,java" \
    "${SDK_BUILD_OUT}" \
    "${OPENCV_SRC}"

# ── 3. Move output into the final location ───────────────────────────
SDK_OUT="${OUTPUT_DIR}/OpenCV-android-sdk"
rm -rf "${SDK_OUT}"

# build_sdk.py writes the SDK tree at SDK_BUILD_OUT/OpenCV-android-sdk/
if [ -d "${SDK_BUILD_OUT}/OpenCV-android-sdk" ]; then
    mv "${SDK_BUILD_OUT}/OpenCV-android-sdk" "${SDK_OUT}"
else
    echo "[build-opencv-android] FATAL: build_sdk.py did not produce OpenCV-android-sdk dir" >&2
    echo "[build-opencv-android] Looked for: ${SDK_BUILD_OUT}/OpenCV-android-sdk" >&2
    echo "[build-opencv-android] Contents of ${SDK_BUILD_OUT}:" >&2
    ls -la "${SDK_BUILD_OUT}" 2>&1 >&2 | head -20 || true
    exit 1
fi

rm -rf "${BUILD_DIR}"

# ── 4. Verify expected layout (fail loud, no `|| true`) ──────────────
for ABI in arm64-v8a armeabi-v7a x86 x86_64; do
    SO_PATH="${SDK_OUT}/sdk/native/libs/${ABI}/libopencv_java4.so"
    STITCHING_A="${SDK_OUT}/sdk/native/staticlibs/${ABI}/libopencv_stitching.a"
    if [ ! -f "${SO_PATH}" ]; then
        echo "[build-opencv-android] FATAL: ${SO_PATH} not produced." >&2
        echo "[build-opencv-android] Listing ${SDK_OUT}/sdk/native/:" >&2
        find "${SDK_OUT}/sdk/native/" -maxdepth 4 -type f 2>&1 >&2 | head -40 || true
        exit 1
    fi
    if [ ! -f "${STITCHING_A}" ]; then
        echo "[build-opencv-android] FATAL: ${STITCHING_A} not produced (stitching staticlib missing)." >&2
        exit 1
    fi
done
echo "[build-opencv-android] All ABIs produced libopencv_java4.so + libopencv_stitching.a."

# ── 5. Zip for release upload ────────────────────────────────────────
cd "${OUTPUT_DIR}"
zip -ry "RNImageStitcher-android.zip" "OpenCV-android-sdk"

echo "[build-opencv-android] Done."
echo "[build-opencv-android] Output: ${SDK_OUT}/"
echo "[build-opencv-android] Archive: ${OUTPUT_DIR}/RNImageStitcher-android.zip"
du -sh "${SDK_OUT}" "${OUTPUT_DIR}/RNImageStitcher-android.zip"
