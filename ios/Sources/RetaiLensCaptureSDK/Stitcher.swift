// Stitcher.swift
//
// Pure-Swift wrapper around the Objective-C(++) `OpenCVStitcher`.
// Mirrors the layering of `QualityChecker.swift` ↔ `QualityCheckerBridge.swift`
// from Phase 1: this file does the type translation between Swift
// idioms (Result, throwing functions, Error) and the ObjC interface.
// It does NOT import OpenCV or React — keeping it framework-light is
// what lets `swift test` build clean from the command line.
//
// XCTest coverage:
//   The pure algorithmic part of stitching lives in OpenCV itself
//   (cv::Stitcher::SCANS — well-tested upstream).  Our test surface
//   is therefore "did we wire it correctly + handle errors right?",
//   covered by `StitcherTests.swift` against synthetic fixture
//   images.  Those tests need an iOS simulator (OpenCV ships only
//   iOS XCFramework binaries from the opencv-mobile fork), so they
//   live behind an availability check that lets `swift test` skip
//   them gracefully on macOS-only CI.

#if canImport(UIKit)
import Foundation
import UIKit

// `OpenCVStitcher` is an ObjC class; the SwiftPM target excludes the
// .mm files (they need OpenCV to compile) but the Pods build does
// include them.  When the Pods build is the one running, this Swift
// file links against the ObjC class via the umbrella header.
//
// In the SwiftPM macOS test build, OpenCVStitcher isn't available;
// `canImport(UIKit)` plus the .mm file's exclusion in Package.swift
// keeps everything compilable.

public struct StitchOptions {
  public let framePaths: [String]
  public let outputPath: String
  public let jpegQuality: Int
  public init(framePaths: [String], outputPath: String, jpegQuality: Int = 85) {
    self.framePaths = framePaths
    self.outputPath = outputPath
    self.jpegQuality = jpegQuality
  }
}

public struct StitchResult: Equatable {
  public let outputPath: String
  public let width: Int
  public let height: Int
  public let durationMs: Double
}

public enum StitcherError: Error {
  case insufficientFrames(count: Int)
  case readFailed(path: String)
  case writeFailed(path: String)
  case opencvFailed(code: Int, message: String)

  /// Build a Swift error from the NSError the ObjC layer hands back.
  /// Codes are aligned with `OpenCVStitcher.mm`'s `cv::Stitcher::Status`
  /// mapping so the JS layer can branch on classes of failure.
  static func fromNSError(_ err: NSError) -> StitcherError {
    switch err.code {
    case 1000:
      // Pulled from the description text — we don't have the count
      // structurally because the ObjC error doesn't carry it.
      return .insufficientFrames(count: -1)
    case 1001:
      let path = (err.userInfo[NSLocalizedDescriptionKey] as? String) ?? "<unknown>"
      return .readFailed(path: path)
    case 1002:
      let path = (err.userInfo[NSLocalizedDescriptionKey] as? String) ?? "<unknown>"
      return .writeFailed(path: path)
    default:
      let msg = (err.userInfo[NSLocalizedDescriptionKey] as? String) ?? "OpenCV failure"
      return .opencvFailed(code: err.code, message: msg)
    }
  }
}

public enum Stitcher {

  /// Stitch the configured frames into a panorama at `options.outputPath`.
  /// Throws `StitcherError` on failure; returns the result on success.
  ///
  /// This is synchronous on the calling thread.  The RN bridge in
  /// `StitcherBridge.swift` dispatches it to a background queue so
  /// the JS thread isn't blocked during what's typically a 1–4s
  /// operation on iPhone hardware.
  public static func stitch(_ options: StitchOptions) throws -> StitchResult {
    if options.framePaths.count < 2 {
      throw StitcherError.insufficientFrames(count: options.framePaths.count)
    }

    // The ObjC method's `(NSError **)error` last parameter is
    // imported by Swift as a throwing method — calling with `try`
    // catches the NSError; there's no `error:` argument to pass.
    do {
      let result = try OpenCVStitcher.stitchFramePaths(
        options.framePaths,
        outputPath: options.outputPath,
        jpegQuality: options.jpegQuality
      )
      return StitchResult(
        outputPath: result.outputPath,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs
      )
    } catch let nsError as NSError {
      throw StitcherError.fromNSError(nsError)
    }
  }
}
#endif
