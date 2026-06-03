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
  s.source_files = ['ios/Sources/**/*.{swift,h,m,mm}',
                    'cpp/**/*.{h,hpp,cpp}']
  # Exclude the shared C++ unit tests (cpp/tests/) — GoogleTest + JSI-stub
  # harnesses for maintainers (pose_test.cpp etc.), NOT part of the shipped
  # SDK.  The `cpp/**` glob above would otherwise slurp them into every host
  # pod build and fail with `'gtest/gtest.h' file not found` (consumer apps
  # don't vendor gtest).  Tests build only in the lib's CI / example app.
  s.exclude_files = ['cpp/tests/**/*']
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

  # Frameworks shipped with iOS itself — no binary cost.
  s.frameworks = ['Accelerate', 'CoreImage', 'UIKit', 'ARKit']

  s.dependency 'React-Core'

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
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/cpp"',
  }
end
