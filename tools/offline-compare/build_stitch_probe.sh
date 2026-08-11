#!/usr/bin/env bash
# Cross-compile stitch_probe (arm64 Android) linking the REAL cpp/stitcher.cpp
# against the vendored OpenCV android static libs. Produces ./stitch_probe, to be
# adb-pushed to a device and driven by offline_compare.py.
#
# Env overrides: ANDROID_NDK (default 27.1.x under ~/Library/Android/sdk).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NDK="${ANDROID_NDK:-$HOME/Library/Android/sdk/ndk/27.1.12297006}"
HOSTTAG="$(uname | tr '[:upper:]' '[:lower:]')-x86_64"   # darwin-x86_64 / linux-x86_64
CLANG="$NDK/toolchains/llvm/prebuilt/$HOSTTAG/bin/clang++"
V="$REPO/android/vendor/OpenCV-android-sdk/sdk/native"
API=24

[ -x "$CLANG" ] || { echo "NDK clang++ not found: $CLANG (set ANDROID_NDK)"; exit 1; }
[ -d "$V" ] || { echo "vendored OpenCV not found: $V (run the repo's OpenCV fetch/postinstall)"; exit 1; }

# One --start-group so link order never bites. Exclude gapi (references TBB
# symbols that aren't vendored; stitchFramePaths never touches G-API).
STATIC=$(ls "$V"/staticlibs/arm64-v8a/*.a | grep -v 'libopencv_gapi.a')
THIRD=$(ls "$V"/3rdparty/libs/arm64-v8a/*.a)

"$CLANG" \
  --target=aarch64-linux-android$API \
  -std=c++17 -O2 -fPIE -pie -DNDEBUG \
  -I"$REPO/cpp" -I"$V/jni/include" \
  "$HERE/stitch_probe.cpp" "$REPO/cpp/stitcher.cpp" \
  -Wl,--start-group $STATIC $THIRD -Wl,--end-group \
  -llog -lz -landroid -lcamera2ndk -lmediandk \
  -o "$HERE/stitch_probe"

echo "built: $HERE/stitch_probe"
file "$HERE/stitch_probe"
