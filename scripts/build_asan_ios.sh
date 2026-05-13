#!/usr/bin/env bash
#
# build_asan_ios.sh — build + install an AddressSanitizer-instrumented
# RetaiLens.app to the development iPhone, for diagnosing heap-
# corruption crashes (finalize objc_retain family, see
# docs/site-content/design/2026-05-12-finalize-crash-investigation.md).
#
# Why a wrapper script:
#   The Xcode scheme attribute `enableAddressSanitizer="YES"` only
#   propagates to IDE Run actions, NOT to `xcodebuild build` from the
#   command line.  For CLI builds you must override the build setting
#   `CLANG_ADDRESS_SANITIZER=YES` directly.  This script bundles the
#   build + install + a clear capture-instructions banner so the
#   diagnostic workflow is one command.
#
# Cost vs the normal build:
#   ~2-3× slower runtime; ~3× larger binary; first build is ~5-10 min
#   because ASan instrumentation invalidates the incremental cache.
#
# Usage:
#   bash retailens-capture-sdk/scripts/build_asan_ios.sh
#
# After install:
#   1. Unlock iPhone (devicectl install needs an unlocked device).
#   2. Open Console.app, filter process == "RetaiLens".
#   3. Launch the app on the phone, reproduce the crash.
#   4. ASan prints a report to stderr/Console prefixed with
#      "==NNN==ERROR: AddressSanitizer: ...".  Look for the WRITE
#      stack trace — that's the corruption source.

set -euo pipefail

DEVICE_UDID="${RETAILENS_IOS_UDID:-00008140-001E092208A2201C}"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../retailens-mobile/ios" && pwd)"

echo "──────────────────────────────────────────────────────────────"
echo "RetaiLens ASan build → iPhone $DEVICE_UDID"
echo "──────────────────────────────────────────────────────────────"
echo

cd "$IOS_DIR"

echo "[1/3] xcodebuild (CLANG_ADDRESS_SANITIZER=YES) …"
xcodebuild \
    -workspace RetaiLens.xcworkspace \
    -configuration Debug \
    -scheme RetaiLens \
    -destination "id=$DEVICE_UDID" \
    CLANG_ADDRESS_SANITIZER=YES \
    CLANG_ADDRESS_SANITIZER_USE_AFTER_RETURN=YES \
    build 2>&1 | tail -10

echo
echo "[2/3] Locating built .app …"
APP_PATH=$(ls -td ~/Library/Developer/Xcode/DerivedData/RetaiLens-*/Build/Products/Debug-iphoneos/RetaiLens.app | head -1)
if [[ ! -d "$APP_PATH" ]]; then
    echo "ERROR: No RetaiLens.app found in DerivedData" >&2
    exit 1
fi
echo "  $APP_PATH"
echo "  built: $(stat -f '%Sm' "$APP_PATH")"

echo
echo "[3/3] Installing to device …"
xcrun devicectl device install app \
    --device "$DEVICE_UDID" \
    "$APP_PATH" 2>&1 | grep -E "App installed|bundleID|Failed" | head -5

echo
echo "──────────────────────────────────────────────────────────────"
echo "✓ ASan build installed.  Next steps:"
echo
echo "  1. Open Console.app.  In the filter bar, type:"
echo "       process:RetaiLens"
echo
echo "  2. Launch the app on the iPhone.  Reproduce the finalize"
echo "     crash (start a capture, deliberate translation, release"
echo "     shutter)."
echo
echo "  3. Watch Console for lines starting with:"
echo "       ==NNN==ERROR: AddressSanitizer:"
echo "     Copy ~100 lines spanning the report (between"
echo "     'AddressSanitizer:' and 'SUMMARY:' inclusive)."
echo
echo "  4. Share the ASan report — it'll point at the WRITE site"
echo "     that's corrupting memory, which is the actual bug (vs."
echo "     the eventual READ site where the .ips signals crash)."
echo "──────────────────────────────────────────────────────────────"
