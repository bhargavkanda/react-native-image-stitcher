#!/usr/bin/env bash
#
# build-opencv-android.sh — slim custom OpenCV Android SDK build via
# OpenCV's official `platforms/android/build_sdk.py`.  Matches the
# design doc's "Custom build" approach (NF1: ~10-15 MB per ABI,
# ~40-55 MB total Android).
#
# build_sdk.py is OpenCV's own scripted Android build:
#   - Reads `--ndk_path` for the toolchain.
#   - Builds the ABIs listed in the --config file.  We build arm64-v8a
#     ONLY (see the generated config below): the release zip has never
#     shipped any other ABI (the v0.7.1 strip step deleted them), and
#     the 32-bit x86 build actively BREAKS under NDK r27+ — Intel's
#     prebuilt ia32 libippicv.a carries a malformed .note.gnu.property
#     section that r27's stricter lld rejects ("data is too short").
#     Building only what we ship sidesteps that and is ~4x faster.
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

# ── 16 KB page-size alignment (Android 15+) ──────────────────────────
# Devices with 16 KB kernel pages refuse ELF libs whose LOAD segments
# are only 4096-aligned, and Android 15+ shows a compatibility warning
# for the whole APK if ANY bundled 64-bit .so is misaligned.
#
# Mechanism: the NDK toolchain variable ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES
# (r27+; older toolchains silently IGNORE it — the alignment gate below
# exists precisely to catch that).  This is the same switch upstream
# OpenCV turned on by default in 4.11.0 (opencv/opencv#26680); we inject
# it into 4.10.0 via a generated build config.  An env-LDFLAGS approach
# was tried first and does NOT survive build_sdk.py's cmake setup
# (verified: the output stayed 4096-aligned), hence the config route.
#
# build_sdk.py exec()s the config file as Python.  The arm64-v8a ABI
# line is grepped out of the stock config so the ABI() signature always
# matches this OpenCV revision; the flag loop is appended after it.
PAGE_CFG="${BUILD_DIR}/ndk-16kb.config.py"
{
    echo "ABIs = ["
    grep "arm64-v8a" "${OPENCV_SRC}/platforms/android/ndk-18.config.py"
    echo "]"
    echo ""
    echo "# 16 KB page-size (Android 15+): NDK r27+ toolchain flag, per ABI."
    echo "for abi in ABIs:"
    echo "    abi.cmake_vars['ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES'] = 'ON'"
} > "${PAGE_CFG}"

python3 build_sdk.py \
    --config "${PAGE_CFG}" \
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
for ABI in arm64-v8a; do
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

# 16 KB page-size gate: every LOAD segment of the produced .so must be
# >= 16384-aligned (see the ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES
# injection above; the requirement covers 64-bit ABIs, and arm64-v8a is
# the only ABI we build).  Pure-python ELF parse so the check works on
# both Linux CI and macOS dev machines (no readelf dependency).
for ABI in arm64-v8a; do
    SO_PATH="${SDK_OUT}/sdk/native/libs/${ABI}/libopencv_java4.so"
    python3 - "$SO_PATH" <<'PYEOF'
import struct, sys
p = sys.argv[1]
d = open(p, "rb").read()
assert d[:4] == b"\x7fELF", f"{p}: not an ELF"
is64 = d[4] == 2
phoff, phentsize, phnum = (
    (struct.unpack("<Q", d[0x20:0x28])[0], struct.unpack("<H", d[0x36:0x38])[0], struct.unpack("<H", d[0x38:0x3A])[0])
    if is64 else
    (struct.unpack("<I", d[0x1C:0x20])[0], struct.unpack("<H", d[0x2A:0x2C])[0], struct.unpack("<H", d[0x2C:0x2E])[0]))
aligns = []
for i in range(phnum):
    ph = d[phoff + i * phentsize: phoff + (i + 1) * phentsize]
    if struct.unpack("<I", ph[0:4])[0] == 1:  # PT_LOAD
        aligns.append(struct.unpack("<Q", ph[48:56])[0] if is64 else struct.unpack("<I", ph[28:32])[0])
bad = [a for a in aligns if a < 16384]
if bad:
    print(f"[build-opencv-android] FATAL: {p} has LOAD align {min(bad)} < 16384 "
          "(16 KB page-size flag did not reach the link).", file=sys.stderr)
    sys.exit(1)
print(f"[build-opencv-android] 16 KB alignment OK: {p} (min LOAD align {min(aligns)})")
PYEOF
done

# ── 4.5. Strip unused subdirs (v0.7.1, updated for arm64-only) ───────
#
# The build is arm64-v8a-only now (see the generated config above), so
# the non-arm64 rm -rf lines below are defensive no-ops kept as a
# safety net against a future config regression.  samples/ and apk/
# removal still applies.  See `feedback_binary_release_packaging.md`
# for the original 4-ABI rationale (pre-strip ~165 MB → ~42 MB).
echo "[build-opencv-android] Stripping non-arm64 ABIs + samples + apk..."
echo "[build-opencv-android] Pre-strip size: $(du -sh "${SDK_OUT}" | cut -f1)"
for abi in armeabi-v7a x86 x86_64; do
    rm -rf "${SDK_OUT}/sdk/native/libs/${abi}"
    rm -rf "${SDK_OUT}/sdk/native/staticlibs/${abi}"
    rm -rf "${SDK_OUT}/sdk/native/3rdparty/libs/${abi}"
done
rm -rf "${SDK_OUT}/samples"
rm -rf "${SDK_OUT}/apk"
echo "[build-opencv-android] Post-strip size: $(du -sh "${SDK_OUT}" | cut -f1)"

# Sentinel check: the arm64-v8a binaries we just promised to keep
# MUST still be there.  If somehow a future refactor deletes the
# wrong dir, fail loudly here rather than ship a broken zip.
for required in \
    "${SDK_OUT}/sdk/native/libs/arm64-v8a/libopencv_java4.so" \
    "${SDK_OUT}/sdk/native/staticlibs/arm64-v8a/libopencv_stitching.a"; do
    if [ ! -f "${required}" ]; then
        echo "[build-opencv-android] FATAL: strip removed a required arm64-v8a artifact: ${required}" >&2
        exit 1
    fi
done

# ── 5. Zip for release upload ────────────────────────────────────────
cd "${OUTPUT_DIR}"
zip -ry "RNImageStitcher-android.zip" "OpenCV-android-sdk"

echo "[build-opencv-android] Done."
echo "[build-opencv-android] Output: ${SDK_OUT}/"
echo "[build-opencv-android] Archive: ${OUTPUT_DIR}/RNImageStitcher-android.zip"
du -sh "${SDK_OUT}" "${OUTPUT_DIR}/RNImageStitcher-android.zip"
