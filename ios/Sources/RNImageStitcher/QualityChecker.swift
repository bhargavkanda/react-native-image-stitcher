// SPDX-License-Identifier: Apache-2.0
// QualityChecker.swift
//
// Pure-Swift implementations of the on-device quality scores the SDK
// surfaces to the JS layer.  No React Native dependency in this file —
// the bridge wrapper lives in `QualityCheckerBridge.swift` and only
// translates promise resolves into the same numeric scores this file
// produces.  Keeping the bridge thin means XCTest hits the algorithms
// directly (via SwiftPM `swift test`) instead of needing an iOS
// simulator + RN runtime to validate a Laplacian variance.
//
// Why this layer at all (instead of OpenCV)?
//   Phase-1 quality checks (blur + brightness) are a tiny slice of
//   what OpenCV does and Apple already ships the primitives in the OS
//   (Accelerate's vImage convolutions, CoreImage's CIAreaAverage).
//   Pulling in opencv-mobile only for two filters would add ~10 MB to
//   the IPA for no functional gain — opencv-mobile gets paid for in
//   Phase 2 when stitching arrives, where Apple has no equivalent.
//
// Algorithm references:
//   * Blur: variance-of-Laplacian.  Pech-Pacheco et al. 2000,
//     "Diatom autofocusing in brightfield microscopy: a comparative
//     study."  Threshold ~50–100 separates "soft" from "blurry" for
//     mobile shelf imagery in our pilot data.
//   * Brightness: mean luminance.  Underexposed = mean < 60,
//     overexposed = mean > 200, both unusable for downstream OCR.

import Accelerate
import CoreGraphics
import CoreImage
import Foundation

/// Errors the quality check can surface to the bridge.  Each maps to a
/// dedicated reject-code on the JS side so the host app can branch on
/// "missing file" vs. "couldn't decode" vs. "internal".
public enum QualityCheckError: Error {
  case fileNotFound(path: String)
  case imageDecodeFailed(path: String)
  case bufferAllocationFailed
  case convolutionFailed(vImageError: vImage_Error)
}

/// Numeric quality measurements; mirrors the QualityReport TS shape.
public struct QualityScores: Equatable {
  /// Variance of the Laplacian.  Higher = sharper.  Implementation
  /// returns a non-negative Double; +∞ is reserved for the JS shim
  /// fallback so production code can distinguish "we measured this
  /// and it's astonishingly sharp" from "we never measured it."
  public let blurScore: Double

  /// Mean luminance in [0, 255].  255 = pure white, 0 = pure black.
  /// We use the standard ITU-R BT.601 luma weights (0.299 R + 0.587 G +
  /// 0.114 B) — vImage's RGB-to-Y conversion uses the same weights so
  /// keeping them here means the mean we compute matches the mean
  /// vImage would produce had we asked it directly.
  public let brightnessScore: Double

  /// Veiling-glare score in [0, 255] from the shared C++ dark-channel
  /// detector (`retailens::computeGlareScore`, via GlareBridge).
  /// Higher = more specular-veiling reflection (e.g. a glass cooler
  /// door reflecting the bright outdoor scene over the products).
  /// The pass/fail `maxGlare` cutoff (≈33) lives on the JS side so
  /// there is a single source of truth; this struct only carries the
  /// raw measurement.  0.0 means the glare path could not score the
  /// frame (e.g. native decode failed) — distinct from a measured
  /// clean frame, which still floors well above 0.
  public let glareScore: Double

  public init(blurScore: Double, brightnessScore: Double, glareScore: Double) {
    self.blurScore = blurScore
    self.brightnessScore = brightnessScore
    self.glareScore = glareScore
  }
}

public enum QualityChecker {

  /// Measure both blur and brightness in one decode pass.
  ///
  /// Call sites that only need one score (rare — both are cheap once
  /// the image is decoded) can ignore the unused field.  Bundling the
  /// API means we decode + convert-to-grayscale exactly once per call,
  /// which is the bulk of the work; reading the grayscale buffer twice
  /// to extract the two stats is essentially free.
  public static func measure(imagePath: String) throws -> QualityScores {
    let cgImage = try decodeImage(at: imagePath)
    let grayBuffer = try makeGrayscaleBuffer(from: cgImage)
    defer { grayBuffer.free() }

    let brightness = grayBuffer.mean()
    let blur = try grayBuffer.varianceOfLaplacian()
    // Glare is measured by the shared C++ dark-channel detector via the
    // Obj-C++ GlareBridge (it re-decodes the file as a BGR cv::Mat — the
    // vImage grayscale buffer above can't feed the per-channel-min the
    // glare score needs).  Returns 0.0 on its own decode failure rather
    // than throwing, so a glare-path hiccup never masks a usable
    // blur/brightness result.  The original `imagePath` (file:// scheme
    // intact) is passed through; GlareBridge strips it internally.
    let glare: Double
#if SWIFT_PACKAGE
    // GlareBridge is an Obj-C++ (.mm) symbol absent from the SwiftPM
    // macOS test target (Package.swift compiles QualityChecker.swift
    // standalone). Under CocoaPods/Xcode SWIFT_PACKAGE is undefined and
    // the real bridge runs.
    glare = 0.0
#else
    glare = GlareBridge.glareScore(forImageAtPath: imagePath)
#endif
    return QualityScores(blurScore: blur, brightnessScore: brightness, glareScore: glare)
  }

  /// Convenience: measure blur only.  Provided so unit tests can call
  /// the algorithm in isolation without invoking the brightness path.
  public static func measureBlurScore(imagePath: String) throws -> Double {
    return try measure(imagePath: imagePath).blurScore
  }

  /// Convenience: measure brightness only.
  public static func measureBrightness(imagePath: String) throws -> Double {
    return try measure(imagePath: imagePath).brightnessScore
  }

  // MARK: - Internal helpers

  /// Decode the file at `imagePath` into a CGImage.  Strips any
  /// `file://` prefix the bridge may have passed through unchanged so
  /// callers don't have to remember whether the SDK wants a URL or a
  /// path.
  private static func decodeImage(at imagePath: String) throws -> CGImage {
    let cleaned = imagePath.hasPrefix("file://")
      ? String(imagePath.dropFirst("file://".count))
      : imagePath
    guard FileManager.default.fileExists(atPath: cleaned) else {
      throw QualityCheckError.fileNotFound(path: imagePath)
    }
    let url = URL(fileURLWithPath: cleaned)
    guard
      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
      throw QualityCheckError.imageDecodeFailed(path: imagePath)
    }
    return cgImage
  }

  /// Convert a CGImage to an 8-bit single-channel grayscale buffer.
  ///
  /// Why vImage instead of CoreImage's CIPhotoEffectMono filter?
  ///   CIFilter chains are deferred and lazy — we'd have to render
  ///   anyway to read the pixels back out.  vImage gives us an actual
  ///   contiguous Y' buffer in one shot, which is exactly what the
  ///   blur/brightness stats want.
  private static func makeGrayscaleBuffer(from cgImage: CGImage) throws -> GrayscaleBuffer {
    var format = vImage_CGImageFormat(
      bitsPerComponent: 8,
      bitsPerPixel: 8,
      colorSpace: Unmanaged.passRetained(CGColorSpaceCreateDeviceGray()),
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
      version: 0,
      decode: nil,
      renderingIntent: .defaultIntent
    )
    var buffer = vImage_Buffer()
    let createErr = vImageBuffer_InitWithCGImage(
      &buffer, &format, nil, cgImage, vImage_Flags(kvImageNoFlags)
    )
    guard createErr == kvImageNoError else {
      throw QualityCheckError.bufferAllocationFailed
    }
    return GrayscaleBuffer(buffer: buffer)
  }
}

/// RAII wrapper around vImage_Buffer + the algorithms that read it.
/// Owns the underlying pixel memory so callers `defer { buf.free() }`
/// after construction.
struct GrayscaleBuffer {
  var buffer: vImage_Buffer

  func free() {
    if buffer.data != nil { Foundation.free(buffer.data) }
  }

  /// Mean pixel value across the buffer, [0, 255].  vImage doesn't
  /// expose a direct mean function for Planar8 so we walk the rows
  /// manually with vDSP_meanv on each row's bytes-as-floats.
  func mean() -> Double {
    let width = Int(buffer.width)
    let height = Int(buffer.height)
    let rowBytes = buffer.rowBytes
    let basePtr = buffer.data.assumingMemoryBound(to: UInt8.self)

    var total: Double = 0
    var count: Double = 0
    var rowAccumulator = [Float](repeating: 0, count: width)
    for y in 0..<height {
      let rowPtr = basePtr.advanced(by: y * rowBytes)
      // vImageConvert_Planar8toPlanarF would do the type conversion in
      // bulk; for the per-row mean the manual loop is faster than
      // setting up a vImage call per row.
      for x in 0..<width {
        rowAccumulator[x] = Float(rowPtr[x])
      }
      var rowMean: Float = 0
      vDSP_meanv(rowAccumulator, 1, &rowMean, vDSP_Length(width))
      total += Double(rowMean)
      count += 1
    }
    return count > 0 ? total / count : 0
  }

  /// Variance-of-Laplacian — the canonical "how blurry is this" score.
  ///
  /// Steps:
  ///   1. Convolve the grayscale buffer with the discrete Laplacian
  ///      kernel.  Output = high-frequency / edge response.
  ///   2. Compute the variance of the convolved buffer.  Sharp images
  ///      have lots of edges with widely varying magnitudes; blurry
  ///      images have weak, similar values throughout.
  func varianceOfLaplacian() throws -> Double {
    let width = buffer.width
    let height = buffer.height

    // Allocate the output buffer.  vImageConvolve_Planar8 writes the
    // convolved bytes into a new buffer of the same dimensions.
    var output = vImage_Buffer()
    let outputBytes = Int(height) * Int(width)
    output.data = malloc(outputBytes)
    output.width = width
    output.height = height
    output.rowBytes = Int(width)
    guard output.data != nil else {
      throw QualityCheckError.bufferAllocationFailed
    }
    defer { Foundation.free(output.data) }

    // Discrete Laplacian.  Sums to zero so the convolved buffer's
    // mean is ~0 except where edges live; variance then quantifies
    // edge response — exactly the "is this image sharp" question.
    //   0  -1   0
    //  -1   4  -1
    //   0  -1   0
    let kernel: [Int16] = [0, -1, 0, -1, 4, -1, 0, -1, 0]
    let divisor: Int32 = 1

    // vImageConvolve_Planar8 takes mutable buffer pointers; copy into
    // local vars so we can hand it inout refs without violating Swift's
    // exclusive-access rules on `self.buffer`.
    var input = buffer
    let convErr = kernel.withUnsafeBufferPointer { kernelPtr -> vImage_Error in
      // backgroundColor is unused with kvImageEdgeExtend (we extend
      // edge pixels rather than padding) — pass 0 as a placeholder.
      vImageConvolve_Planar8(
        &input, &output, nil, 0, 0,
        kernelPtr.baseAddress, 3, 3,
        divisor, 0,
        vImage_Flags(kvImageEdgeExtend)
      )
    }
    guard convErr == kvImageNoError else {
      throw QualityCheckError.convolutionFailed(vImageError: convErr)
    }

    // Compute variance over the output pixels.  vImage gives us the
    // bytes; vDSP gives us the stats.  Convert U8 → F32 in one bulk op
    // so vDSP_normalize / vDSP_measqv can run native.
    let count = Int(width) * Int(height)
    var floatBuffer = [Float](repeating: 0, count: count)
    let outBytes = output.data.assumingMemoryBound(to: UInt8.self)
    for i in 0..<count {
      floatBuffer[i] = Float(outBytes[i])
    }

    var mean: Float = 0
    var meanSquare: Float = 0
    vDSP_meanv(floatBuffer, 1, &mean, vDSP_Length(count))
    vDSP_measqv(floatBuffer, 1, &meanSquare, vDSP_Length(count))
    let variance = Double(meanSquare) - Double(mean) * Double(mean)
    return max(0, variance)
  }
}
