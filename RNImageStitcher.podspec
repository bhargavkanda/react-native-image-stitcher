#
# RNImageStitcher.podspec
#
# CocoaPods spec consumed by host RN apps via React Native's
# autolinking.  The host app's package.json depends on
# `react-native-image-stitcher`, autolinking discovers this podspec
# at the package root, and `pod install` links the OpenCV xcframework
# that the `postinstall-fetch-binaries.js` script downloaded into
# `ios/Frameworks/` at npm-install time.
#

require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'RNImageStitcher'
  s.version      = package['version']
  s.summary      = 'Pose-aware panorama capture + stitching for React Native'
  s.description  = package['description']
  s.homepage     = 'https://github.com/bhargavkanda/react-native-image-stitcher'
  s.license      = { :type => 'Apache-2.0', :file => 'LICENSE' }
  s.authors      = { 'Tiger Analytics' => 'opensource@tigeranalytics.com' }
  s.source       = {
    :git => 'https://github.com/bhargavkanda/react-native-image-stitcher.git',
    :tag => "v#{s.version}"
  }

  # iOS 14 floor matches the React Native ecosystem's current standard
  # deployment target.  Lowering would require conditionalising the
  # @available checks in the AR session bridges — not worth the
  # maintenance overhead.
  s.platforms     = { :ios => '14.0' }
  s.swift_version = '5.0'

  # Sources: iOS-specific Swift/Obj-C/Obj-C++ AND the shared C++ port
  # (cpp/) that both iOS and Android compile from a single source.
  # cpp/ glob is NON-RECURSIVE on purpose: it picks up the shared C++
  # port (all top-level cpp/*.cpp) but skips the maintainer-only
  # GoogleTest harnesses under cpp/tests/ (which would otherwise fail
  # the pod with `'gtest/gtest.h' file not found`). NOTE: using
  # `cpp/**` + `s.exclude_files = ['cpp/tests/**/*']` instead broke the
  # vendored opencv2.xcframework header integration for the remaining
  # cpp/ files — keep this as a single non-recursive glob.
  s.source_files = ['ios/Sources/**/*.{swift,h,m,mm}',
                    'cpp/*.{h,hpp,cpp}']
  # Restrict the umbrella header to ONLY the iOS-side Obj-C `.h`
  # files.  Without this, CocoaPods defaults every header in
  # `source_files` (including the C++ `.hpp` files under cpp/) to
  # public — which is fine for non-modular builds, but breaks any
  # host app using `use_frameworks!` (as RetaiLens does): the
  # umbrella module is compiled in pure Obj-C context and chokes on
  # `#import "keyframe_gate.hpp"` with `'cstdint' file not found`.
  # The .mm files still find the C++ headers via HEADER_SEARCH_PATHS
  # below; they just don't get pulled into the umbrella.
  s.public_header_files = ['ios/Sources/**/*.h']

  # Frameworks shipped with iOS itself — no binary cost.  AVFoundation +
  # ImageIO back the captureDepthData sidecar extraction (AVDepthData from
  # the photo's auxiliary image).
  s.frameworks = ['Accelerate', 'CoreImage', 'UIKit', 'ARKit',
                  'AVFoundation', 'ImageIO']

  s.dependency 'React-Core'

  # react-native-worklets-core — provides the `RNWorklet::WorkletInvoker`
  # + `JsiWorkletContext` primitives the AR-mode JSI fan-out is built on
  # (StitcherJsiInstaller.mm / RNSARWorkletRuntime.mm + the shared
  # cpp/stitcher_worklet_{registry,dispatch}.cpp).  In practice this pod
  # is already in every host's graph (vision-camera depends on it), but
  # declaring it here makes the dependency explicit and guarantees its
  # headers are present even for a host that uses AR mode without
  # vision-camera.  The bare `WKTJsiWorklet.h` includes in the .mm files
  # resolve via the HEADER_SEARCH_PATHS entry below (the package's own
  # node_modules copy of the worklets-core cpp/ dir).
  s.dependency 'react-native-worklets-core'

  # ─────────────────────────────────────────────────────────────────────
  # OpenCV — pre-built custom xcframework fetched by postinstall
  # ─────────────────────────────────────────────────────────────────────
  #
  # The npm `postinstall` script (`scripts/postinstall-fetch-binaries.js`)
  # downloads `opencv2.xcframework` from the matching GitHub
  # Release into `ios/Frameworks/`.  This podspec just declares the
  # vendored framework so the linker picks it up at `pod install` time.
  #
  # Pre-built means: no source build at pod-install time (the old
  # opencv-mobile flow took 20+ minutes); no architecture quirks on
  # Apple Silicon Macs (the xcframework ships device-arm64 +
  # simulator-arm64+x86_64 slices); reproducible across CI runs.
  #
  # If the xcframework isn't on disk when `pod install` runs, the user
  # forgot to `npm install` (or set SKIP_OPENCV_FETCH=1).  pod install
  # will fail with "framework not found" — the JS postinstall script
  # emits a clear error message in that case pointing users to re-run.
  s.vendored_frameworks = 'ios/Frameworks/opencv2.xcframework'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'OTHER_CPLUSPLUSFLAGS' => '$(inherited) -std=c++17',
    # HEADER_SEARCH_PATHS:
    #   - "${PODS_TARGET_SRCROOT}/cpp" — the shared C++ port's own
    #     headers (keyframe_gate.hpp, camera_frame_jsi.hpp, …).
    #   - the worklets-core cpp/ dir — so the bare `#include
    #     "WKTJsiWorklet.h"` / "WKTJsiWorkletContext.h" lines in
    #     StitcherJsiInstaller.mm + RNSARWorkletRuntime.mm resolve.
    #     PODS_ROOT is `<host>/ios/Pods`; the package's worklets-core
    #     copy lives at `<host>/node_modules/react-native-worklets-core/
    #     cpp`, i.e. `${PODS_ROOT}/../node_modules/...`.  (The shared
    #     cpp/*.cpp files instead use the namespace-prefixed
    #     `<react-native-worklets-core/WKTJsiWorklet.h>` form, which
    #     resolves against `${PODS_ROOT}/Headers/Public` — already on
    #     the inherited path — and works on Android's prefab too.)
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/cpp" "${PODS_ROOT}/../node_modules/react-native-worklets-core/cpp"',
  }
end
