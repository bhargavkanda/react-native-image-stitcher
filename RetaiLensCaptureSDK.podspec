#
# RetaiLensCaptureSDK.podspec
#
# CocoaPods spec consumed by the host mobile app via React Native's
# autolinking.  Autolinking finds this file because the host app's
# package.json declares `@retailens/capture-sdk` as a dependency,
# the SDK's own package.json sits at the package root, and this
# podspec also sits at the package root with the canonical name
# `<package_root>/RetaiLensCaptureSDK.podspec`.
#
# Phase 1 surface (this iteration):
#   * RetaiLensQualityChecker — blur + brightness via Accelerate's
#     vImage convolution + vDSP variance.  No OpenCV dependency yet;
#     Apple's frameworks ship with the OS so we pay zero IPA bytes
#     for this layer.
#
# Phase 2 (next, sibling commit) adds:
#   * BatchStitcher — opencv-mobile pod for OpenCV's cv::Stitcher.
#     Will add ~10 MB to the IPA, paid for by the cloud-sync
#     stitched-image requirement (single panoramic JPEG per audit).
#

require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'RetaiLensCaptureSDK'
  s.version      = package['version']
  s.summary      = 'RetaiLens Capture SDK — native quality checks + image stitching'
  s.description  = package['description']
  s.homepage     = 'https://github.com/tigeranalytics/retailens'
  s.license      = { :type => 'UNLICENSED' }
  s.authors      = { 'Tiger Analytics' => 'engineering@tigeranalytics.com' }
  # Required by CocoaPods schema.  We don't actually publish the SDK
  # to a public git host yet — autolinking pulls the source from the
  # local directory, not from this URL.
  s.source       = { :git => 'https://github.com/tigeranalytics/retailens.git', :tag => "v#{s.version}" }

  # iOS 14 floor matches the host mobile app (Vision framework + the
  # host's own deployment target are both 14+).  Lowering this would
  # mean conditionalising the @available checks throughout the
  # native code — not worth the maintenance overhead.
  s.platforms    = { :ios => '14.0' }
  s.swift_version = '5.0'

  # Sources: iOS-specific Swift/Obj-C/Obj-C++ AND the shared C++ port
  # (cpp/) that both iOS and Android compile from a single source.
  # See cpp/keyframe_gate.hpp for the design rationale on shared-C++.
  s.source_files = ['ios/Sources/**/*.{swift,h,m,mm}',
                    'cpp/**/*.{h,hpp,cpp}']
  # Add cpp/ to header search path so the .mm bridges can use
  # `#include "keyframe_gate.hpp"` without going up the relative path.
  s.public_header_files = ['ios/Sources/**/*.h']

  # Frameworks shipped with iOS itself — no binary cost.
  #   * Accelerate — vImage (image convolution) + vDSP (variance / mean).
  #   * CoreImage — fallback path / future quality filters.
  #   * UIKit — UIImage interop in unit-test fixtures + stitcher I/O.
  s.frameworks = ['Accelerate', 'CoreImage', 'UIKit']

  s.dependency 'React-Core'

  # ─────────────────────────────────────────────────────────────────────
  # OpenCV (Phase 2 — image stitching)
  # ─────────────────────────────────────────────────────────────────────
  #
  # We use upstream OpenCV's official iOS framework rather than the
  # `opencv-mobile` slim fork because the slim fork strips the
  # `stitching`, `imgcodecs`, and `calib3d` modules — exactly the
  # modules our stitcher depends on.  Trade: binary size — upstream
  # is ~88 MB compressed (≈220 MB extracted) vs. opencv-mobile's
  # ~14 MB.  App Store thinning + the EXCLUDED_ARCHS below keep the
  # final IPA reasonable on real devices.
  #
  # The framework is downloaded on `pod install` (idempotent — skipped
  # when already extracted) and vendored from `ios/Vendor/`.  This
  # avoids committing ~220 MB of binary to git while keeping the
  # build fully offline once the first install completes.
  #
  # Architecture caveat:
  #   The upstream framework ships armv7 + armv7s + i386 + x86_64 +
  #   arm64 slices in a single fat binary — pre-XCFramework era.
  #   That arm64 slice is iOS-DEVICE only, NOT arm64-simulator.
  #   Apple-Silicon Macs running an iOS simulator natively need an
  #   arm64-simulator slice; without one, simulator builds fail to
  #   link.  EXCLUDED_ARCHS below skips arm64 for simulator targets,
  #   leaving x86_64 (which Rosetta runs on Apple Silicon).
  #   Phase 4 of #8 swaps this for a properly-built XCFramework so
  #   simulator builds run natively without Rosetta.
  #
  # Mirror override: set OPENCV_IOS_URL to an internal artefact store
  # if GitHub bandwidth is unreliable in CI.
  opencv_version = '4.13.0'
  opencv_url     = "https://github.com/opencv/opencv/releases/download/#{opencv_version}/opencv-#{opencv_version}-ios-framework.zip"

  s.prepare_command = <<~SH
    set -e
    OPENCV_DIR="ios/Vendor/opencv2.framework"
    if [ -d "$OPENCV_DIR" ]; then
      echo "[RetaiLensCaptureSDK] OpenCV framework already present — skipping download."
      exit 0
    fi
    URL="${OPENCV_IOS_URL:-#{opencv_url}}"
    TMPD="$(mktemp -d)"
    echo "[RetaiLensCaptureSDK] Downloading OpenCV ${URL} (≈88 MB) ..."
    curl -fSL "$URL" -o "$TMPD/opencv-ios.zip"
    mkdir -p ios/Vendor
    unzip -q "$TMPD/opencv-ios.zip" -d ios/Vendor
    rm -rf "$TMPD"
    echo "[RetaiLensCaptureSDK] OpenCV ready at $OPENCV_DIR"
  SH

  s.vendored_frameworks = 'ios/Vendor/opencv2.framework'

  # See arch caveat above — exclude arm64 from simulator builds so the
  # linker doesn't fail to find iOS-device-arm64 symbols on Apple
  # Silicon Mac iOS simulator runs.  Apple Silicon devs build via
  # Rosetta (Xcode → Run → Destination → "Any iOS Simulator" → x86_64)
  # or against a connected device until the XCFramework switch lands.
  s.user_target_xcconfig = {
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'arm64',
  }
  s.pod_target_xcconfig = {
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'arm64',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -std=c++17',
    # Add the shared cpp/ dir to the header search path so the
    # KeyframeGateBridge.mm can `#include "keyframe_gate.hpp"`
    # without going up the relative path.  ${PODS_TARGET_SRCROOT}
    # is the pod's package root (one level above ios/Sources/).
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/cpp"',
  }

end
