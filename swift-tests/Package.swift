// swift-tools-version:5.9
// SPDX-License-Identifier: Apache-2.0
//
// Package.swift — SwiftPM manifest used ONLY for command-line testing of the
// pure-Swift rules under the package's iOS source directory.  Production
// builds never go through SwiftPM; a host pulls those files through the
// podspec, whose non-recursive glob deliberately does not see this
// directory.
//
// WHY A SEPARATE DIRECTORY, AND A SYMLINK.  The podspec compiles every
// `ios/*.swift` into the pod, so a `Package.swift` placed in `ios/` would be
// compiled as pod source and break the build.  The package therefore lives
// here and reaches the files under test through symlinks in
// `Sources/RNISPanoPure/` — ONE copy of each rule, tested from where it ships.
// Only files with no AVFoundation / React / RNImageStitcher import can be
// linked in; the tests run on macOS, which has no `builtInUltraWideCamera`.
//
// Why SwiftPM at all: `swift test` runs on a Mac in seconds, while XCTest
// through CocoaPods needs a simulator boot.
//
// Run from this directory:
//
//   swift test

import PackageDescription

let package = Package(
  name: "RNISPanoPure",
  platforms: [
    .iOS(.v14),
    .macOS(.v12),
  ],
  products: [
    .library(name: "RNISPanoPure", targets: ["RNISPanoPure"]),
  ],
  dependencies: [],
  targets: [
    .target(
      name: "RNISPanoPure",
      path: "Sources/RNISPanoPure"
    ),
    .testTarget(
      name: "RNISPanoPureTests",
      dependencies: ["RNISPanoPure"],
      path: "Tests/RNISPanoPureTests"
    ),
  ]
)
