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
#   * RetaiLensStitcher — opencv-mobile pod for OpenCV's cv::Stitcher.
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

  s.source_files = 'ios/Sources/**/*.{swift,h,m}'

  # Frameworks shipped with iOS itself — no binary cost.
  #   * Accelerate — vImage (image convolution) + vDSP (variance / mean).
  #   * CoreImage — fallback path / future quality filters.
  #   * UIKit — UIImage interop in unit-test fixtures.
  s.frameworks = ['Accelerate', 'CoreImage', 'UIKit']

  s.dependency 'React-Core'
end
