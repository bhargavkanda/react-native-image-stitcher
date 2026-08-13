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

# ── v0.24.4 — bring-your-own-OpenCV (host-supplied) ───────────────────
#
# By DEFAULT this pod vendors its own `opencv2.xcframework` (fetched by
# postinstall).  That is wrong for a host that ALREADY ships OpenCV —
# an app must contain exactly ONE OpenCV (see
# website/docs/sharing-opencv.md); two means duplicate symbols and ~54 MB
# of dead weight.  Such hosts previously had to hand-patch this podspec
# with `sed` (deleting `vendored_frameworks`, injecting their own pod
# dependency, deleting the downloaded framework).  That patch broke
# silently whenever this file's layout changed.
#
# Opt in EXPLICITLY, either from the host Podfile:
#
#     $RNISHostOpenCV    = true
#     $RNISHostOpenCVPod = 'opencv2'   # optional; defaults to 'opencv2'
#
# or via the environment (also honoured by the npm postinstall, so the
# ~27 MB download is skipped entirely):
#
#     RNIS_HOST_OPENCV=1 npm install && cd ios && RNIS_HOST_OPENCV=1 pod install
#
# The host's OpenCV MUST include the modules this SDK links against —
# core, imgproc, features2d, calib3d and **stitching** (the usual
# omission; a trimmed build surfaces as cryptic link errors).
#
# Detection is opt-in ONLY.  A missing framework is deliberately NOT
# treated as host mode: that is the signature of a failed download, and
# silently reinterpreting it as "the host will provide one" is exactly
# the silent failure this release exists to remove.
# Locate a sibling package by walking up from this podspec, so the check
# works for a flat `node_modules`, a hoisted monorepo, and pnpm/Yarn
# layouts alike.  Plain Ruby on purpose: `Pod::Executable` is not defined
# in every podspec-evaluation context (cocoapods-core alone raises
# `uninitialized constant`), and shelling out to node would fail the same
# way in a sandboxed evaluation.
rnis_find_node_module = lambda do |name, from_dir|
  dir = from_dir
  found = nil
  loop do
    candidate = File.join(dir, 'node_modules', name, 'package.json')
    if File.file?(candidate)
      found = File.dirname(candidate)
      break
    end
    parent = File.dirname(dir)
    break if parent == dir
    dir = parent
  end
  found
end

rnis_has_vision_camera =
  !rnis_find_node_module.call('react-native-vision-camera', __dir__).nil?

rnis_host_opencv =
  (defined?($RNISHostOpenCV) && $RNISHostOpenCV) ||
  ENV['RNIS_HOST_OPENCV'] == '1'
rnis_host_opencv_pod =
  (defined?($RNISHostOpenCVPod) && $RNISHostOpenCVPod) ||
  ENV['RNIS_HOST_OPENCV_POD'] ||
  'opencv2'

# ── Preflight: fail LOUDLY at `pod install`, not cryptically at compile ─
#
# In vendored mode the xcframework must be on disk.  When it is absent
# (postinstall never ran — `--ignore-scripts`, a CI cache that restored
# node_modules without running scripts, an offline/proxied install, or a
# failed download, which exits 0 by design) CocoaPods silently drops the
# `vendored_frameworks` glob and the build dies hundreds of lines later
# with `'opencv2/core.hpp' file not found`.  Name the real cause here.
unless rnis_host_opencv
  rnis_xcframework = File.join(__dir__, 'ios', 'Frameworks', 'opencv2.xcframework')
  unless File.directory?(rnis_xcframework)
    raise <<~MSG
      [RNImageStitcher] opencv2.xcframework is missing.

        expected: #{rnis_xcframework}

      It is downloaded at npm-install time by
      scripts/postinstall-fetch-binaries.js, and is NOT in the npm
      tarball (it is ~27 MB).  Most likely one of:

        * install ran with --ignore-scripts (or a CI cache restored
          node_modules without running postinstall)
        * the download was blocked (offline / proxy / firewall)
        * SKIP_OPENCV_FETCH=1 was set without staging the binaries

      Fix — re-run the fetch, then `pod install` again:

        node node_modules/react-native-image-stitcher/scripts/postinstall-fetch-binaries.js

      Or, if this app ALREADY ships its own OpenCV, use the supported
      host-supplied mode instead of patching this podspec:

        # ios/Podfile
        $RNISHostOpenCV = true

      See website/docs/sharing-opencv.md and
      website/docs/bring-your-own-opencv.md.
    MSG
  end
end

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

  s.default_subspecs = 'Core'

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
    if rnis_host_opencv
      # HOST-SUPPLIED (v0.24.4).  Depend on the host's OpenCV pod instead
      # of vendoring ours; the host owns the single copy in the app.  The
      # subspec still exists so `Core`'s dependency edge (and any pod that
      # depends on `RNImageStitcher/OpenCV` to share our OpenCV) keeps
      # resolving — it simply forwards to the host's pod now.
      cv.dependency rnis_host_opencv_pod
    else
      cv.vendored_frameworks = 'ios/Frameworks/opencv2.xcframework'
    end
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

    # v0.24.4 — react-native-vision-camera, when the host has it.
    #
    # KeyframeGateFrameProcessor.mm — which registers the
    # `cv_flow_gate_process_frame` frame-processor plugin that NON-AR
    # panorama capture ingests every frame through — wraps its entire
    # body (including its `+load` registrar) in
    # `#if __has_include(<VisionCamera/FrameProcessorPlugin.h>)`.
    #
    # Without an explicit dependency that header is visible ONLY in the
    # default CocoaPods layout, where every pod's public headers are
    # flattened into `Pods/Headers/Public` and land on every pod's
    # inherited HEADER_SEARCH_PATHS.  Under `use_frameworks!` (static or
    # dynamic) module visibility requires a declared dependency — so the
    # guard evaluated FALSE, the plugin compiled to an EMPTY translation
    # unit, the plugin never registered, and non-AR capture ingested ZERO
    # frames, failing at finalize with the misleading "0 keyframes saved".
    # No build error, no warning.  A field integrator lost days to this
    # and shipped a `sed` patch for it; this dependency is that fix.
    #
    # Declared CONDITIONALLY so the "AR-only host without vision-camera"
    # configuration keeps working: RN autolinking already installs the
    # VisionCamera pod whenever the package is present, so when it IS
    # present this pulls in nothing new — it only makes the header
    # visibility explicit so `__has_include` tells the truth.  Depend on
    # the umbrella `VisionCamera` (not `VisionCamera/FrameProcessors`,
    # which only exists when frame processors are enabled).
    core.dependency 'VisionCamera' if rnis_has_vision_camera

    # The vendored OpenCV rides in via the sibling subspec, exactly as it
    # did when `vendored_frameworks` sat on the root spec.
    core.dependency 'RNImageStitcher/OpenCV'

    # v0.24.4 — keep the frame-processor registrar out of the linker's
    # dead-strip path.
    #
    # `KeyframeGateFrameProcessor` registers `cv_flow_gate_process_frame`
    # from `+ (void)load`.  Nothing in the app REFERENCES that class by
    # symbol — the registry discovers it at load time — so when this pod
    # is linked as a static archive (the default, and `use_frameworks!
    # :linkage => :static`), the linker is free to drop the whole object
    # file and the plugin silently never registers.  Same observable
    # failure as the missing-header case: non-AR capture ingests ZERO
    # frames and dies with "0 keyframes saved", with nothing in the build
    # log to suggest why.
    #
    # `-ObjC` forces every Obj-C class + category from our static archive
    # to be loaded.  It is set on the CONSUMING target (`user_target_
    # xcconfig`) because that is where the link happens; RN app templates
    # already ship it, so for most hosts this is a no-op that simply
    # guarantees the invariant instead of relying on it.
    core.user_target_xcconfig = {
      'OTHER_LDFLAGS' => '$(inherited) -ObjC',
    }

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
end
