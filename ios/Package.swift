// swift-tools-version:5.9
//
// Package.swift — SwiftPM manifest used **only for command-line testing**
// of the algorithm layer (QualityChecker.swift).  Production builds
// don't go through SwiftPM; the host iOS app pulls these same source
// files via the `RetaiLensCaptureSDK.podspec` at the SDK package
// root.
//
// Why bother with SwiftPM at all when production uses CocoaPods?
//   * `swift test` runs from the command line, in CI, in 2 seconds.
//   * XCTest in CocoaPods needs an Xcode workspace and an iOS
//     simulator boot — slow, flaky, and ergonomically bad.
//   * The bridge layer (QualityCheckerBridge.swift) deliberately
//     guards its React import behind `#if canImport(React)` so SwiftPM
//     can compile the package WITHOUT React being available.
//
// Run from this directory:
//
//   cd retailens-capture-sdk/ios
//   swift test

import PackageDescription

let package = Package(
  name: "RetaiLensCaptureSDK",
  platforms: [
    .iOS(.v14),
    // macOS target needed so `swift test` can run on a Mac without
    // an iOS simulator.  The algorithm layer uses Accelerate + Core
    // Image — both of which are available on macOS too.
    .macOS(.v12),
  ],
  products: [
    .library(name: "RetaiLensCaptureSDK", targets: ["RetaiLensCaptureSDK"]),
  ],
  dependencies: [],
  targets: [
    .target(
      name: "RetaiLensCaptureSDK",
      path: "Sources/RetaiLensCaptureSDK",
      // Excluded from `swift test` because they depend on either
      // React (which isn't a SwiftPM dep) or OpenCV (which only
      // ships as an iOS XCFramework via the podspec — no macOS
      // build).  The host app's CocoaPods workspace picks them up.
      exclude: [
        // React-dependent
        "QualityCheckerBridge.swift",
        "QualityCheckerBridge.m",
        "StitcherBridge.swift",
        "StitcherBridge.m",
        // OpenCV-dependent (Phase 2 stitcher)
        "OpenCVStitcher.h",
        "OpenCVStitcher.mm",
        // Stitcher.swift is `#if canImport(UIKit)`-gated so it
        // compiles to nothing on macOS; including it keeps the
        // file available to the Pods build without breaking
        // `swift test`.
      ]
    ),
    .testTarget(
      name: "RetaiLensCaptureSDKTests",
      dependencies: ["RetaiLensCaptureSDK"],
      path: "Tests/RetaiLensCaptureSDKTests",
      resources: [
        .copy("Fixtures"),
      ]
    ),
  ]
)
