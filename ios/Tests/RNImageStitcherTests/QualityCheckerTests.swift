// SPDX-License-Identifier: Apache-2.0
// QualityCheckerTests.swift
//
// Unit tests for the pure-Swift `QualityChecker` algorithm layer.
// Run from the command line:
//
//   cd retailens-capture-sdk/ios
//   swift test --filter RNImageStitcherTests
//
// Why synthesised fixtures instead of checked-in JPEGs?
//   * Binary fixtures bloat the git history and make diffs noisy.
//   * Synthetic images give us mathematically known properties:
//     a checkerboard has predictable Laplacian variance, a uniform
//     grey field has a predictable mean luminance.  No subjective
//     "this looks blurry" judgement enters the test data.
//   * If the algorithm regresses, the assertions tell us by how
//     much, against ground truth — not by how much against an
//     ad-hoc reference image of unknown provenance.

import XCTest
@testable import RNImageStitcher
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

final class QualityCheckerTests: XCTestCase {

  // MARK: - Brightness

  func testBrightnessOfPureBlackImageIsZero() throws {
    let url = try writePNG(makeUniformGrayImage(width: 64, height: 64, gray: 0))
    let scores = try QualityChecker.measure(imagePath: url.path)
    // Exact-zero allowed because a uniform 0-luma source has no
    // floating-point round-off in the mean computation.
    XCTAssertEqual(scores.brightnessScore, 0.0, accuracy: 0.5)
  }

  func testBrightnessOfPureWhiteImageIsNear255() throws {
    let url = try writePNG(makeUniformGrayImage(width: 64, height: 64, gray: 255))
    let scores = try QualityChecker.measure(imagePath: url.path)
    XCTAssertEqual(scores.brightnessScore, 255.0, accuracy: 0.5)
  }

  func testBrightnessOfMidGrayImageIsHalfRange() throws {
    let url = try writePNG(makeUniformGrayImage(width: 64, height: 64, gray: 128))
    let scores = try QualityChecker.measure(imagePath: url.path)
    XCTAssertEqual(scores.brightnessScore, 128.0, accuracy: 1.0)
  }

  // MARK: - Blur

  func testBlurScoreOfUniformImageIsNearZero() throws {
    // A uniform field has zero edges, so a Laplacian sees nothing.
    // Variance should be tiny (numerical noise only).
    let url = try writePNG(makeUniformGrayImage(width: 128, height: 128, gray: 128))
    let scores = try QualityChecker.measure(imagePath: url.path)
    XCTAssertLessThan(
      scores.blurScore, 5.0,
      "uniform field should have near-zero Laplacian variance"
    )
  }

  func testBlurScoreOfHighContrastCheckerboardIsLarge() throws {
    // 8×8 checker → many sharp edges → high Laplacian variance.
    let url = try writePNG(makeCheckerboardImage(width: 128, height: 128, cellSize: 8))
    let scores = try QualityChecker.measure(imagePath: url.path)
    XCTAssertGreaterThan(
      scores.blurScore, 1000.0,
      "high-contrast checkerboard should produce high Laplacian variance"
    )
  }

  func testCheckerboardIsSharperThanGradient() throws {
    // Regression guard: relative ordering matters more than absolute
    // numbers.  A gradient has SOME edges (one direction) but a
    // checkerboard has more (alternating both directions).  If the
    // gradient ever scored higher than the checkerboard the algorithm
    // is wrong.
    let checker = try writePNG(makeCheckerboardImage(width: 128, height: 128, cellSize: 8))
    let gradient = try writePNG(makeHorizontalGradientImage(width: 128, height: 128))
    let checkerBlur = try QualityChecker.measureBlurScore(imagePath: checker.path)
    let gradientBlur = try QualityChecker.measureBlurScore(imagePath: gradient.path)
    XCTAssertGreaterThan(checkerBlur, gradientBlur)
  }

  // MARK: - Errors

  func testMissingFileRaisesFileNotFound() {
    let url = URL(fileURLWithPath: "/tmp/no-such-file-\(UUID().uuidString).png")
    XCTAssertThrowsError(
      try QualityChecker.measure(imagePath: url.path)
    ) { err in
      guard case QualityCheckError.fileNotFound = err else {
        return XCTFail("Expected fileNotFound, got \(err)")
      }
    }
  }

  func testFilePrefixedWithFileSchemeIsAccepted() throws {
    // The bridge passes through whatever the JS layer hands it; tolerate
    // both `path` and `file://path` so callers don't have to remember
    // which the SDK wants.
    let url = try writePNG(makeUniformGrayImage(width: 32, height: 32, gray: 200))
    let withScheme = "file://" + url.path
    let scores = try QualityChecker.measure(imagePath: withScheme)
    XCTAssertEqual(scores.brightnessScore, 200.0, accuracy: 1.0)
  }
}

// MARK: - Synthetic fixture helpers

extension QualityCheckerTests {

  /// Build a grayscale CGImage where every pixel == `gray`.
  func makeUniformGrayImage(width: Int, height: Int, gray: UInt8) -> CGImage {
    let cs = CGColorSpaceCreateDeviceGray()
    let ctx = CGContext(
      data: nil,
      width: width, height: height,
      bitsPerComponent: 8,
      bytesPerRow: width,
      space: cs,
      bitmapInfo: CGImageAlphaInfo.none.rawValue
    )!
    let buf = ctx.data!.assumingMemoryBound(to: UInt8.self)
    for i in 0..<(width * height) {
      buf[i] = gray
    }
    return ctx.makeImage()!
  }

  /// Build an 8-cell-per-row checkerboard between black (0) and white (255).
  func makeCheckerboardImage(width: Int, height: Int, cellSize: Int) -> CGImage {
    let cs = CGColorSpaceCreateDeviceGray()
    let ctx = CGContext(
      data: nil,
      width: width, height: height,
      bitsPerComponent: 8,
      bytesPerRow: width,
      space: cs,
      bitmapInfo: CGImageAlphaInfo.none.rawValue
    )!
    let buf = ctx.data!.assumingMemoryBound(to: UInt8.self)
    for y in 0..<height {
      for x in 0..<width {
        let cellX = x / cellSize
        let cellY = y / cellSize
        let isWhite = (cellX + cellY) % 2 == 0
        buf[y * width + x] = isWhite ? 255 : 0
      }
    }
    return ctx.makeImage()!
  }

  /// Black-on-the-left → white-on-the-right linear ramp.  Has edges
  /// in only one direction (horizontal); used to validate that a
  /// checkerboard scores higher than a gradient (regression guard).
  func makeHorizontalGradientImage(width: Int, height: Int) -> CGImage {
    let cs = CGColorSpaceCreateDeviceGray()
    let ctx = CGContext(
      data: nil,
      width: width, height: height,
      bitsPerComponent: 8,
      bytesPerRow: width,
      space: cs,
      bitmapInfo: CGImageAlphaInfo.none.rawValue
    )!
    let buf = ctx.data!.assumingMemoryBound(to: UInt8.self)
    for y in 0..<height {
      for x in 0..<width {
        // Linear ramp, [0, 255] across the width.
        let v = UInt8((x * 255) / max(1, width - 1))
        buf[y * width + x] = v
      }
    }
    return ctx.makeImage()!
  }

  /// Encode a CGImage to PNG and write to a temporary file.  Returns
  /// the URL of the file (cleaned up on test-target teardown).
  func writePNG(_ image: CGImage) throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("qc-test-\(UUID().uuidString).png")
    let dest = CGImageDestinationCreateWithURL(
      url as CFURL,
      UTType.png.identifier as CFString,
      1, nil
    )!
    CGImageDestinationAddImage(dest, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(dest), "PNG encode failed for fixture")
    addTeardownBlock {
      try? FileManager.default.removeItem(at: url)
    }
    return url
  }
}
