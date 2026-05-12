#!/usr/bin/env bash
# build-opencv-android.sh
#
# Rebuild OpenCV 4.5.5 for Android arm64-v8a from source with
# BUILD_opencv_stitching=ON, then copy the artifacts into
# android/vendor/OpenCV-android-sdk/ so the JNI shim
# (src/main/cpp/retailens_stitcher.cpp) can link against it.
#
# Why we need this
# ────────────────
# OpenCV's official prebuilt Android distribution (downloaded by the
# Gradle script in build.gradle when vendor/OpenCV-android-sdk/ is
# absent) ships with the `stitching` module stripped from the binary.
# Any Kotlin code that wants to call cv::Stitcher::create() — which
# the iOS side does via OpenCVStitcher.stitchFramePaths — hits an
# UnsatisfiedLinkError at runtime.
#
# This script rebuilds OpenCV ourselves with stitching included,
# then drops the resulting libopencv_java4.so + libopencv_stitching.a
# (and all module static archives) into the vendor SDK so the rest
# of the SDK's Gradle setup is unchanged.
#
# Prerequisites
# ─────────────
#   - macOS or Linux
#   - Android NDK r27 or r23 installed (paths checked below)
#   - JDK 17 (for the OpenCV Java binding generator, even though we
#     don't enable Java wrappers for stitching — generator still runs)
#   - Apache Ant 1.10+ (the OpenCV Java binding generator's helper)
#   - CMake 3.18+ + Ninja
#   - ~15 GB free disk
#   - ~30-60 min wall-clock time on Apple Silicon
#
# Usage
# ─────
#   cd retailens-capture-sdk/android
#   ./scripts/build-opencv-android.sh
#
# Output goes to ~/Projects/opencv-android-build/ (intermediate) and
# android/vendor/OpenCV-android-sdk/ (final artifacts).  Both are
# .gitignored.
#
# Idempotent: skips clone if opencv/ already present; --clean flag
# to force.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────
OPENCV_VERSION=4.5.5
WORK_DIR="${HOME}/Projects/opencv-android-build"
NDK_PATH="${ANDROID_NDK_HOME:-${HOME}/Library/Android/sdk/ndk/27.1.12297006}"
SDK_PATH="${ANDROID_SDK_ROOT:-${HOME}/Library/Android/sdk}"
JAVA_BIN="${JAVA_HOME:-/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
ANT_BIN=$(command -v ant || echo "")
ABI=arm64-v8a
API_LEVEL=24

# ── Sanity checks ─────────────────────────────────────────────────
[ -d "${NDK_PATH}" ]              || { echo "ERROR: NDK not at ${NDK_PATH}"; exit 1; }
[ -f "${NDK_PATH}/build/cmake/android.toolchain.cmake" ] || { echo "ERROR: NDK toolchain missing"; exit 1; }
[ -d "${JAVA_BIN}" ]              || { echo "ERROR: JDK 17 not at ${JAVA_BIN}"; exit 1; }
[ -n "${ANT_BIN}" ]               || { echo "ERROR: ant not on PATH (brew install ant)"; exit 1; }
command -v cmake >/dev/null        || { echo "ERROR: cmake missing"; exit 1; }
command -v ninja >/dev/null        || { echo "ERROR: ninja missing"; exit 1; }
command -v python3 >/dev/null      || { echo "ERROR: python3 missing"; exit 1; }

export ANDROID_NDK_HOME="${NDK_PATH}"
export ANDROID_SDK_ROOT="${SDK_PATH}"
export JAVA_HOME="${JAVA_BIN}"
export PATH="${JAVA_BIN}/bin:/usr/local/bin:${PATH}"

# ── Workspace ─────────────────────────────────────────────────────
mkdir -p "${WORK_DIR}"
cd "${WORK_DIR}"

if [ "${1:-}" = "--clean" ] || [ ! -d opencv/.git ]; then
    echo "→ Fetching OpenCV ${OPENCV_VERSION} (shallow)…"
    rm -rf opencv
    git clone --depth=1 -b "${OPENCV_VERSION}" \
        https://github.com/opencv/opencv.git
fi

# ── ABI-only config for build_sdk.py ──────────────────────────────
cat > /tmp/ndk-build-arm64-only.config.py <<EOF
ABIs = [
    ABI("3", "${ABI}", None, ${API_LEVEL}),
]
EOF

# ── Build (uses OpenCV's official build_sdk.py — handles the fat-Java-lib link correctly) ──
rm -rf sdk-work
mkdir sdk-work

echo "→ Building OpenCV ${OPENCV_VERSION} for ${ABI}…"
echo "  NDK:  ${NDK_PATH}"
echo "  JDK:  ${JAVA_BIN}"
echo "  Start: $(date '+%H:%M:%S')"

python3 opencv/platforms/android/build_sdk.py \
    --config /tmp/ndk-build-arm64-only.config.py \
    --ndk_path "${NDK_PATH}" \
    --sdk_path "${SDK_PATH}" \
    --no_samples_build \
    --no_kotlin \
    "${WORK_DIR}/sdk-work" \
    "${WORK_DIR}/opencv" || true
# build_sdk.py's last step (Gradle-based SDK packaging) fails on Java
# 17 due to a Groovy version mismatch.  We don't need the packaged
# SDK; we just need the per-ABI shared lib + static archives, which
# are produced BEFORE the packaging step.  Ignore the exit code and
# verify outputs directly.

# ── Verify outputs ────────────────────────────────────────────────
SO_OUT="${WORK_DIR}/sdk-work/o4a/jni/${ABI}/libopencv_java4.so"
STITCHING_A="${WORK_DIR}/sdk-work/o4a/lib/${ABI}/libopencv_stitching.a"
if [ ! -f "${SO_OUT}" ] || [ ! -f "${STITCHING_A}" ]; then
    echo "ERROR: expected build outputs missing.  Check build_sdk.py log."
    exit 1
fi
echo "→ Build done: $(date '+%H:%M:%S')"
echo "  libopencv_java4.so:    $(ls -lh "${SO_OUT}" | awk '{print $5}')"
echo "  libopencv_stitching.a: $(ls -lh "${STITCHING_A}" | awk '{print $5}')"

# ── Copy artifacts into vendor SDK ────────────────────────────────
SDK_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENDOR_BASE="${SDK_REPO_ROOT}/android/vendor/OpenCV-android-sdk/sdk/native"
mkdir -p "${VENDOR_BASE}/libs/${ABI}"
mkdir -p "${VENDOR_BASE}/staticlibs/${ABI}"

cp "${SO_OUT}" "${VENDOR_BASE}/libs/${ABI}/"
cp "${WORK_DIR}/sdk-work/o4a/lib/${ABI}"/*.a "${VENDOR_BASE}/staticlibs/${ABI}/"

# Headers come from the OpenCV release zip (downloaded by build.gradle
# on first SDK build).  If they're not yet present, the JNI shim build
# will fail with "stitching.hpp not found"; tell the user how to fix.
if [ ! -f "${VENDOR_BASE}/jni/include/opencv2/stitching.hpp" ]; then
    cat <<MSG
WARNING: OpenCV headers missing at:
  ${VENDOR_BASE}/jni/include/opencv2/
This usually means build.gradle hasn't run its first SDK download.
Run \`./gradlew :retailens_capture-sdk:assembleDebug\` once to trigger
the download, then re-run this script.
MSG
fi

echo "→ Artifacts copied into vendor/OpenCV-android-sdk/."
echo "→ Done.  Next step: \`./gradlew :retailens_capture-sdk:assembleDebug\`"
echo "  should now build the JNI shim (libretailens_stitcher.so) successfully."
