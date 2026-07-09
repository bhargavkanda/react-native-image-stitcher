// swift-tools-version:5.10
//
// Package.swift — SwiftPM manifest used **only for command-line testing**
// of the algorithm layer (QualityChecker.swift).  Production builds
// don't go through SwiftPM; the host iOS app pulls these same source
// files via the `RNImageStitcher.podspec` at the SDK package
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
//   cd react-native-image-stitcher/ios
//   swift test

import PackageDescription

let package = Package(
  name: "RNImageStitcher",
  platforms: [
    .iOS(.v14),
    // macOS target needed so `swift test` can run on a Mac without
    // an iOS simulator.  The algorithm layer uses Accelerate + Core
    // Image — both of which are available on macOS too.
    .macOS(.v12),
  ],
  products: [
    .library(name: "RNImageStitcher", targets: ["RNImageStitcher"]),
  ],
  dependencies: [],
  targets: [
    .target(
      name: "RNImageStitcher",
      path: "Sources/RNImageStitcher",
      // F8.3.H2-target — instead of an `exclude` list (which broke
      // every time a new .mm landed, e.g.
      // `KeyframeGateFrameProcessor.mm` in F8.1, because SwiftPM
      // still scans the directory and rejects "mixed language
      // source files" if it sees both .swift and .mm), we use an
      // explicit `sources` allowlist of files that compile cleanly
      // on macOS (where `swift test` runs).
      //
      // What's in the allowlist:
      //   * QualityChecker.swift — Accelerate / CoreImage; macOS-OK.
      //   * KeyframeGate.swift — Foundation + simd; macOS-OK.
      //
      // What's NOT (intentionally):
      //   * Anything with `import UIKit` / `import ARKit` — iOS only.
      //     CocoaPods compiles them for the host app via the podspec
      //     source_files glob; SwiftPM macOS doesn't need them.
      //   * .mm / .m / .h files — same.  Picked up by CocoaPods.
      //   * RN-bridge Swift files (`*Bridge.swift`) — `import React`,
      //     not a SwiftPM dep.
      //
      // The Frame Processor plugin's Swift⇄ObjC selector pin
      // (formerly relied on by `FrameProcessorPluginSelectorTests`)
      // is enforced as a compile-time `#selector(...)` reference
      // inside `IncrementalStitcher.swift` itself — see the
      // `_consumeFrameFromPluginSelectorPin` static.  Drift breaks
      // the SDK build, which is a stronger guarantee than a test
      // that needs iOS-Simulator infrastructure to run.
      sources: [
        "QualityChecker.swift",
        // PhotoDepthSidecar.swift — AVFoundation/ImageIO/CoreVideo only
        // (no UIKit/React), so the sidecar container codec round-trips
        // under `swift test` on macOS.
        "PhotoDepthSidecar.swift",
        // KeyframeGate.swift depends on `KeyframeGateBridge` (ObjC
        // class in .mm) and `RNSARFramePose` (from a UIKit-using
        // Swift file), so it doesn't compile standalone under
        // SwiftPM on macOS — only the CocoaPods build sees the
        // full type graph.
      ]
    ),
    .testTarget(
      name: "RNImageStitcherTests",
      dependencies: ["RNImageStitcher"],
      path: "Tests/RNImageStitcherTests",
      resources: [
        .copy("Fixtures"),
      ]
    ),
  ]
)
