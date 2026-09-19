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
  s.authors      = 'Bhargava Ram Kanda'
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

  # ─────────────────────────────────────────────────────────────────────
  # Subspec layout: Core (the library) + OpenCV (the vendored framework)
  # ─────────────────────────────────────────────────────────────────────
  #
  # WHY SUBSPECS: the vendored `opencv2.xcframework` is a linkable
  # artifact other pods legitimately want (a host's own private native
  # pod compiling against the SAME OpenCV — the "exactly one OpenCV per
  # app" rule in website/docs/sharing-opencv.md).  A dependent pod
  # declares:
  #
  #     s.dependency 'RNImageStitcher/OpenCV'
  #
  # and CocoaPods propagates the vendored framework's
  # FRAMEWORK_SEARCH_PATHS + `-framework "opencv2"` into that pod's
  # xcconfig, so `#import <opencv2/opencv2.h>` compiles and the symbols
  # link — WITHOUT the dependent pod vendoring a second copy (which
  # would be an ODR violation / duplicate-symbol link error).
  #
  # Attribute placement matters: root-level attributes are INHERITED by
  # every subspec, so the buildable attributes (sources, deps, xcconfig)
  # must live in Core — otherwise `RNImageStitcher/OpenCV` would drag
  # the whole library (and its React dependency) into a consumer that
  # only wants headers + linkage.  `default_subspecs = 'Core'` keeps the
  # plain `pod 'RNImageStitcher'` (RN autolinking) EXACTLY as before:
  # Core depends on OpenCV, so the same single `RNImageStitcher` pod
  # target builds the same file set with the same settings.

  # ⚠ PanoPlus IS ON BY DEFAULT, AND THE ASYMMETRY IS THE REASON.
  # React Native autolinking emits a bare `pod 'RNImageStitcher'` with no
  # subspec, and a host that wants pano+ has no place to say so. Default-OFF
  # therefore fails SILENTLY: the app builds, installs, launches, and reports
  # that pano+ is not in this build. Default-ON fails VISIBLY and
  # measurably — every consumer compiles ~20k lines of C++ and ~10k lines of
  # iOS source it may not want, and links four more system frameworks.
  # A consumer who wants Core alone disables autolinking for this package and
  # writes `pod 'RNImageStitcher/Core'`.
  s.default_subspecs = ['Core', 'PanoPlus']

  # ── OpenCV — pre-built custom xcframework fetched by postinstall ────
  #
  # The npm `postinstall` script (`scripts/postinstall-fetch-binaries.js`)
  # downloads `opencv2.xcframework` from the matching GitHub
  # Release into `ios/Frameworks/`.  This subspec just declares the
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
  s.subspec 'OpenCV' do |cv|
    cv.vendored_frameworks = 'ios/Frameworks/opencv2.xcframework'
  end

  # ── Core — the library itself ───────────────────────────────────────
  s.subspec 'Core' do |core|
    # Sources: iOS-specific Swift/Obj-C/Obj-C++ AND the shared C++ port
    # (cpp/) that both iOS and Android compile from a single source.
    # cpp/ glob is NON-RECURSIVE on purpose: it picks up the shared C++
    # port (all top-level cpp/*.cpp) but skips the maintainer-only
    # GoogleTest harnesses under cpp/tests/ (which would otherwise fail
    # the pod with `'gtest/gtest.h' file not found`). NOTE: using
    # `cpp/**` + `exclude_files = ['cpp/tests/**/*']` instead broke the
    # vendored opencv2.xcframework header integration for the remaining
    # cpp/ files — keep this as a single non-recursive glob.
    core.source_files = ['ios/Sources/**/*.{swift,h,m,mm}',
                         'cpp/*.{h,hpp,cpp}']
    # Restrict the umbrella header to ONLY the iOS-side Obj-C `.h`
    # files.  Without this, CocoaPods defaults every header in
    # `source_files` (including the C++ `.hpp` files under cpp/) to
    # public — which is fine for non-modular builds, but breaks any
    # host app using `use_frameworks!`: the umbrella module is compiled
    # in pure Obj-C context and chokes on `#import "keyframe_gate.hpp"`
    # with `'cstdint' file not found`.  The .mm files still find the C++
    # headers via HEADER_SEARCH_PATHS below; they just don't get pulled
    # into the umbrella.
    core.public_header_files = ['ios/Sources/**/*.h']

    # Frameworks shipped with iOS itself — no binary cost.  AVFoundation +
    # ImageIO back the captureDepthData sidecar extraction (AVDepthData from
    # the photo's auxiliary image).
    core.frameworks = ['Accelerate', 'CoreImage', 'UIKit', 'ARKit',
                       'AVFoundation', 'ImageIO']

    core.dependency 'React-Core'

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
    core.dependency 'react-native-worklets-core'

    # The vendored OpenCV rides in via the sibling subspec, exactly as it
    # did when `vendored_frameworks` sat on the root spec.
    core.dependency 'RNImageStitcher/OpenCV'

    core.pod_target_xcconfig = {
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

  # ── pano+ — the sweep engine ─────────────────────────────────────────────
  #
  # A slit-scan panorama engine with per-frame attitude rectification, driven
  # by an AR session's pose rather than by image registration alone. It is a
  # SUBSPEC rather than part of Core because it is large and not every
  # consumer wants it: ~20k lines of C++ and ~10k lines of iOS source.
  s.subspec 'PanoPlus' do |pp|
    # ⚠ AN EXPLICIT LIST, NOT A GLOB. A glob over ios/PanoPlus would silently
    # pick up anything dropped in that directory later, including a file
    # meant for a test target or a private overlay. Each of the 21 appears
    # exactly once — and the count is part of the guard, so it moves with
    # the list. A stale count is the one thing a hand-audited list must not
    # carry: it tells the next reader the audit was done when it was not.
    #
    # `cpp/panoplus/*` is NON-RECURSIVE on purpose, exactly as Core's `cpp/*`
    # is: it must not reach cpp/panoplus/jni/, which holds an Android-only
    # translation unit the pod would otherwise compile as dead weight.
    pp.source_files = [
                          'ios/PanoPlus/PanoPlusBridge.m',
                          'ios/PanoPlus/PanoPlusBridge.swift',
                          'ios/PanoPlus/PanoPlusCalibBridge.m',
                          'ios/PanoPlus/PanoPlusCalibBridge.swift',
                          'ios/PanoPlus/RNISArExposureProbe.swift',
                          'ios/PanoPlus/RNISPanoAttitude.h',
                          'ios/PanoPlus/RNISPanoAttitude.mm',
                          'ios/PanoPlus/RNISPanoAvfSource.swift',
                          'ios/PanoPlus/RNISPanoBasisCalibration.swift',
                          'ios/PanoPlus/RNISPanoCalibCore.h',
                          'ios/PanoPlus/RNISPanoCalibCore.mm',
                          'ios/PanoPlus/RNISPanoCalibStore.swift',
                          'ios/PanoPlus/RNISPanoCameraLock.swift',
                          'ios/PanoPlus/RNISPanoCore.h',
                          'ios/PanoPlus/RNISPanoCore.mm',
                          'ios/PanoPlus/RNISPanoImuSidecar.swift',
                          'ios/PanoPlus/RNISPanoLensRequest.swift',
                          'ios/PanoPlus/RNISPanoPlusPlugin.swift',
                          'ios/PanoPlus/RNISPanoSourceView.swift',
                          'ios/PanoPlus/RNISPanoSourceViewManager.m',
                          'ios/PanoPlus/RNISPanoSweepFrameProcessor.mm',
                          'cpp/panoplus/*.{hpp,cpp}']

    # Only the three Obj-C headers, and only because each imports nothing but
    # Foundation/CoreVideo. The C++ headers must stay OUT of the umbrella:
    # it is compiled in Obj-C context, and a `use_frameworks!` host chokes on
    # the first `#include <cstdint>` reached through it. The .mm files find
    # them via HEADER_SEARCH_PATHS instead.
    pp.public_header_files = ['ios/PanoPlus/RNISPanoAttitude.h',
                              'ios/PanoPlus/RNISPanoCalibCore.h',
                              'ios/PanoPlus/RNISPanoCore.h']

    # AVFoundation, ARKit and UIKit already arrive from Core.
    pp.frameworks = 'CoreMedia', 'CoreMotion', 'CoreVideo', 'QuartzCore'

    # ⚠ A REAL SYMBOL DEPENDENCY, not an ordering hint. The pano+ Swift
    # conforms to `RNISARFramePlugin` and calls `RNISARPluginRegistry`, both
    # declared in Core.
    pp.dependency 'RNImageStitcher/Core'

    # Core already puts ${PODS_TARGET_SRCROOT}/cpp on the search path, which
    # is what resolves the engine's `#include "warp_guard.hpp"`. This adds
    # the engine's own directory so the iOS sources can `#include
    # "rnis_pano.hpp"` without relative-path spelunking.
    pp.pod_target_xcconfig = {
      'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/cpp/panoplus"',
    }
  end
end
