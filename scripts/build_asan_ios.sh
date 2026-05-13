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
echo "[2/4] Locating built .app …"
APP_PATH=$(ls -td ~/Library/Developer/Xcode/DerivedData/RetaiLens-*/Build/Products/Debug-iphoneos/RetaiLens.app | head -1)
if [[ ! -d "$APP_PATH" ]]; then
    echo "ERROR: No RetaiLens.app found in DerivedData" >&2
    exit 1
fi
echo "  $APP_PATH"
echo "  built: $(stat -f '%Sm' "$APP_PATH")"

echo
echo "[3/4] Embedding + re-signing ASan runtime …"
#
# Why this step exists:
#   Toggling ASan via Xcode's GUI scheme editor causes Xcode to add a
#   hidden "embed-runtime" build phase that copies
#   libclang_rt.asan_ios_dynamic.dylib into the .app's Frameworks/
#   directory.  When we enable ASan from the CLI via
#   CLANG_ADDRESS_SANITIZER=YES alone, the LINKER sets up
#   @rpath/libclang_rt.asan_ios_dynamic.dylib as a runtime dep on the
#   main dylib (RetaiLens.debug.dylib), but no build phase copies the
#   dylib into the bundle.  Result: dyld fails at launch with
#   "Library not loaded: @rpath/libclang_rt.asan_ios_dynamic.dylib"
#   (confirmed via .ips RetaiLens-2026-05-13-165011/165012).
#
#   This block bridges the gap: locate the dylib in Xcode's
#   toolchain, copy it into .app/Frameworks/, sign it with the same
#   Apple Development identity the .app uses, then re-seal the .app
#   so devicectl install accepts the modified bundle.
#
ASAN_DYLIB=$(find /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang \
             -name "libclang_rt.asan_ios_dynamic.dylib" -print -quit 2>/dev/null)
if [[ -z "$ASAN_DYLIB" || ! -f "$ASAN_DYLIB" ]]; then
    echo "ERROR: ASan iOS runtime dylib not found in Xcode toolchain." >&2
    echo "       Looked under: /Applications/Xcode.app/.../usr/lib/clang/" >&2
    echo "       Are you on a non-default Xcode location?  Set" >&2
    echo "       DEVELOPER_DIR before re-running." >&2
    exit 1
fi
echo "  source dylib: $ASAN_DYLIB"

# Extract the signing identity from the .app's existing binary.  The
# identity must match what Xcode used so the resealed bundle is
# accepted by devicectl install.  Format: "Apple Development:
# Created via API (XXXXXXXXXX)".
IDENTITY=$(codesign -dvvv "$APP_PATH/RetaiLens" 2>&1 \
           | grep "Authority=Apple Development" | head -1 \
           | sed -E 's/^Authority=//')
if [[ -z "$IDENTITY" ]]; then
    echo "ERROR: could not detect Apple Development identity from existing .app signature." >&2
    echo "       Output of 'codesign -dvvv \$APP/RetaiLens':" >&2
    codesign -dvvv "$APP_PATH/RetaiLens" 2>&1 | sed 's/^/         /' >&2
    exit 1
fi
echo "  identity:     $IDENTITY"

mkdir -p "$APP_PATH/Frameworks"
cp "$ASAN_DYLIB" "$APP_PATH/Frameworks/"
echo "  copied to:    $APP_PATH/Frameworks/libclang_rt.asan_ios_dynamic.dylib"

# Sign the dylib itself first — must be signed before it can be a
# valid component of the .app bundle.  --force lets us overwrite any
# stale signature from a prior run.
codesign --force --sign "$IDENTITY" \
    "$APP_PATH/Frameworks/libclang_rt.asan_ios_dynamic.dylib" 2>&1 \
    | sed 's/^/  /' || true

# Re-seal the .app.  --preserve-metadata keeps the entitlements,
# identifier, team, and runtime flags from the original signing pass
# (these were set up by Xcode based on the project's signing config);
# only the seal hashes need to change because we added a file to
# Frameworks/.  Without this, devicectl rejects the install with a
# "package validation failed" error.
codesign --force --sign "$IDENTITY" \
    --preserve-metadata=identifier,entitlements,flags,runtime \
    "$APP_PATH" 2>&1 | sed 's/^/  /' || true
echo "  resigned:     $(codesign -dv "$APP_PATH" 2>&1 | head -1)"

echo
echo "[4/4] Installing to device …"
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
