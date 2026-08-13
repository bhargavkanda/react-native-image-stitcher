#!/usr/bin/env bash
#
# build-opencv-ios.sh — produce opencv2.xcframework with the
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
# Output: dist/opencv2.xcframework (arm64 device +
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

echo "[build-opencv-ios] OpenCV ${OPENCV_VERSION} → ${OUTPUT_DIR}/opencv2.xcframework"
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
    --framework_name opencv2

# ── 3. Move + clean ──────────────────────────────────────────────────
mv "${OUTPUT_DIR}/xcframework-build/opencv2.xcframework" \
   "${OUTPUT_DIR}/opencv2.xcframework"
rm -rf "${OUTPUT_DIR}/xcframework-build"
rm -rf "${BUILD_DIR}"

# ── 3.5. Simulator slice: SHIPPED by default (v0.24.4) ───────────────
#
# v0.7.1 stripped the simulator slice unconditionally to save ~17 MB,
# reasoning that "consumers never run the lib in the simulator
# (vision-camera + ARKit don't work there)."  That reasoning was about
# the CAMERA — and it's wrong about the BUILD.  A host app links this
# framework into its binary, so a missing simulator slice doesn't
# degrade the panorama feature in the simulator: it makes the ENTIRE
# HOST APP fail to build for the simulator, with
#
#     building for iOS Simulator, but linking in object file built for
#     iOS ... in opencv2.framework/opencv2
#
# Every developer on an integrating team runs the app in a simulator
# constantly, on screens that have nothing to do with panoramas.  The
# 17 MB was being paid for with "nobody on the team can use a
# simulator any more" — a bad trade we made silently, and one that our
# own `example/ios` inherited (its simulator builds have been broken
# since v0.7.1).
#
# So: KEEP the simulator slice.  The strip is still available for
# size-constrained distributions, opt-in via
# `RNIS_STRIP_SIM_SLICE=1`.  Zip size: ~26 MB stripped, ~43 MB with
# the slice.
#
# When stripping, remove both (a) the slice directory and (b) the
# corresponding AvailableLibraries entry in the xcframework's
# Info.plist.  The entry's array index isn't fixed (OpenCV's build
# orders entries arbitrarily), so we auto-detect by scanning for the
# "simulator" platform variant.  Manual `AvailableLibraries.1`
# hardcoding would have shipped the wrong slice if the order changed
# (which happened between v0.5.0 and v0.6.0 — burned a session pre-CI).
SIM_DIR="${OUTPUT_DIR}/opencv2.xcframework/ios-arm64_x86_64-simulator"
INFO_PLIST="${OUTPUT_DIR}/opencv2.xcframework/Info.plist"
if [ "${RNIS_STRIP_SIM_SLICE:-0}" = "1" ]; then
    if [ -d "${SIM_DIR}" ]; then
        echo "[build-opencv-ios] RNIS_STRIP_SIM_SLICE=1 — stripping simulator slice..."
        rm -rf "${SIM_DIR}"
    fi
    if [ -f "${INFO_PLIST}" ]; then
        # Auto-detect the simulator entry's index in AvailableLibraries.
        SIM_IDX=$(plutil -convert json -o - "${INFO_PLIST}" \
            | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((i for i,e in enumerate(d.get('AvailableLibraries', [])) if 'simulator' in e.get('LibraryIdentifier', '')), -1))")
        if [ "${SIM_IDX}" = "-1" ] || [ -z "${SIM_IDX}" ]; then
            echo "[build-opencv-ios] No simulator entry found in Info.plist (already stripped or unexpected layout); continuing."
        else
            echo "[build-opencv-ios] Removing Info.plist AvailableLibraries.${SIM_IDX} (the simulator entry)..."
            plutil -remove "AvailableLibraries.${SIM_IDX}" "${INFO_PLIST}"
        fi
    fi
else
    # Sentinel: the simulator slice MUST be present in the default
    # (shipping) configuration.  If OpenCV's builder ever stops
    # emitting it, fail the release build LOUDLY rather than
    # publishing an asset that breaks every consumer's simulator.
    if [ ! -d "${SIM_DIR}" ]; then
        echo "[build-opencv-ios] FATAL: simulator slice missing at ${SIM_DIR}." >&2
        echo "[build-opencv-ios]   Expected build_xcframework.py to emit it (--iphonesimulator_archs arm64,x86_64)." >&2
        echo "[build-opencv-ios]   Set RNIS_STRIP_SIM_SLICE=1 only if you deliberately want a device-only build." >&2
        exit 1
    fi
    echo "[build-opencv-ios] Simulator slice retained (host apps need it to build for the simulator)."
fi

# Sentinel: the device slice MUST still be intact after the strip.
if [ ! -d "${OUTPUT_DIR}/opencv2.xcframework/ios-arm64" ]; then
    echo "[build-opencv-ios] FATAL: device slice missing after simulator strip: ${OUTPUT_DIR}/opencv2.xcframework/ios-arm64" >&2
    exit 1
fi

# ── 4. Zip for release upload ────────────────────────────────────────
# `-y` / `--symlinks` is essential: the xcframework's
# Versions/A/{Headers,Resources,Modules} subdirs are accessed via
# top-level symlinks; without `-y`, zip dereferences them and
# duplicates every file (3x bloat).  See feedback_binary_release_packaging.md.
cd "${OUTPUT_DIR}"
zip -ry "RNImageStitcher-ios.zip" "opencv2.xcframework"

echo "[build-opencv-ios] Done."
echo "[build-opencv-ios] Output: ${OUTPUT_DIR}/opencv2.xcframework"
echo "[build-opencv-ios] Archive: ${OUTPUT_DIR}/RNImageStitcher-ios.zip"
du -sh "${OUTPUT_DIR}/opencv2.xcframework" "${OUTPUT_DIR}/RNImageStitcher-ios.zip"
