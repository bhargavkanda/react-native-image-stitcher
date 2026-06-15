// SPDX-License-Identifier: Apache-2.0
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

public struct StitchVideoOptions {
  /// Path to the recorded mp4 (with or without `file://` prefix).
  public let videoPath: String
  /// Where the resulting panoramic JPEG should be written.
  public let outputPath: String
  /// How many frames to sample from the video for stitching.
  /// 10 is the empirical sweet spot — enough overlap to keep
  /// homography solid, few enough that stitching stays under 4
  /// seconds on iPhone 14+ for a typical ~3s pan.
  public let maxFrames: Int
  /// JPEG quality [0..100] applied to BOTH the intermediate
  /// frames AND the final panorama.
  public let jpegQuality: Int
  /// "plane" / "cylindrical" / "spherical".  See OpenCVStitcher.h
  /// for guidance.  Default "plane".
  public let warperType: String
  /// "multiband" / "feather".  Default "multiband".
  public let blenderType: String
  /// "graphcut" / "skip".  Default "graphcut".
  /// "graphcut" runs cv::detail::GraphCutSeamFinder for clean
  /// seams (more memory).  "skip" streams warp+feed for low peak
  /// memory at the cost of less optimal seams.
  public let seamFinderType: String
  public init(
    videoPath: String,
    outputPath: String,
    maxFrames: Int = 10,
    jpegQuality: Int = 85,
    warperType: String = "plane",
    blenderType: String = "multiband",
    seamFinderType: String = "graphcut"
  ) {
    self.videoPath = videoPath
    self.outputPath = outputPath
    self.maxFrames = maxFrames
    self.jpegQuality = jpegQuality
    self.warperType = warperType
    self.blenderType = blenderType
    self.seamFinderType = seamFinderType
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
        jpegQuality: options.jpegQuality,
        warperType: "plane",
        blenderType: "multiband",
        seamFinderType: "graphcut",
        // AR-STITCHING-TWO-MODES — see memory/ar-stitching-two-modes.md
        // Generic Stitcher API doesn't carry capture orientation;
        // pass nil → .mm treats as "portrait" → no bake-rotation.
        // Callers that care about output orientation (e.g.
        // IncrementalStitcher) hit the method directly with
        // the right value.
        captureOrientation: nil,
        // V16 Phase 1b.fix5c — generic Stitcher API keeps the crop
        // strategy at bbox-only (conservative; the panorama-capture
        // path now defaults to inscribed-rect via the settings).
        // Callers that want inscribed-rect can use IncrementalStitcher
        // with the toggle on.
        useInscribedRectCrop: false,
        // 2026-05-22 (audit F2) — legacy video-stitch API doesn't
        // expose stitchMode in its options dict yet.  nil falls
        // through to Panorama in OpenCVStitcher.mm (preserves
        // historical behaviour).
        stitchMode: nil,
        // Generic one-shot API keeps the high-level cv::Stitcher pipeline
        // (its historical behaviour); the batch capture is what defaults to
        // manual.  warperType "plane" above only matters on the manual path.
        useManualPipeline: false
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

  /// Bake EXIF rotation into pixels for the image at `imagePath`.
  /// Returns the post-rotation dimensions so the host can keep its
  /// width/height fields aligned with what's now on disk.
  ///
  /// Idempotent on already-normalised files.  Errors mirror the
  /// existing StitcherError shape so JS can switch on `.code`.
  public static func normaliseOrientation(
    imagePath: String
  ) throws -> (width: Int, height: Int) {
    do {
      let dict = try OpenCVStitcher.normaliseImage(atPath: imagePath)
      let width = dict["width"]?.intValue ?? 0
      let height = dict["height"]?.intValue ?? 0
      return (width: width, height: height)
    } catch let nsError as NSError {
      throw StitcherError.fromNSError(nsError)
    }
  }

  /// v0.15 debug — compute the max-inscribed rectangle of the image
  /// (no file change), for the example app's crop-visualisation harness.
  public static func computeInscribedRect(
    imagePath: String
  ) throws -> (x: Int, y: Int, width: Int, height: Int, imageWidth: Int, imageHeight: Int) {
    do {
      let d = try OpenCVStitcher.computeInscribedRect(atPath: imagePath)
      return (
        x: d["x"]?.intValue ?? 0,
        y: d["y"]?.intValue ?? 0,
        width: d["width"]?.intValue ?? 0,
        height: d["height"]?.intValue ?? 0,
        imageWidth: d["imageWidth"]?.intValue ?? 0,
        imageHeight: d["imageHeight"]?.intValue ?? 0
      )
    } catch let nsError as NSError {
      throw StitcherError.fromNSError(nsError)
    }
  }

  /// v0.15 debug — crop the image to an explicit rectangle (overwrite
  /// in place) and re-encode at `quality`.  Pairs with the
  /// computeInscribedRect debug harness.
  public static func cropToRect(
    imagePath: String,
    x: Int,
    y: Int,
    width: Int,
    height: Int,
    quality: Int
  ) throws -> (width: Int, height: Int) {
    do {
      let d = try OpenCVStitcher.cropToRect(
        atPath: imagePath,
        x: x,
        y: y,
        width: width,
        height: height,
        quality: quality
      )
      return (width: d["width"]?.intValue ?? 0, height: d["height"]?.intValue ?? 0)
    } catch let nsError as NSError {
      throw StitcherError.fromNSError(nsError)
    }
  }

  /// item-7 — perspective-rectify the quadrilateral with corners
  /// `(tlX,tlY) (trX,trY) (brX,brY) (blX,blY)` (IMAGE-PIXEL space, ordered
  /// TL→TR→BR→BL) out of `imagePath` into an upright rectangle, overwrite
  /// in place, re-encode at `quality`.  Pairs with the axis-aligned
  /// `cropToRect`; the JS editor picks this when the dragged quad isn't
  /// ~rectangular.  Returns the rectified `{ width, height }`.
  public static func cropToQuad(
    imagePath: String,
    tlX: Double, tlY: Double,
    trX: Double, trY: Double,
    brX: Double, brY: Double,
    blX: Double, blY: Double,
    quality: Int
  ) throws -> (width: Int, height: Int) {
    do {
      let d = try OpenCVStitcher.cropToQuad(
        atPath: imagePath,
        tlX: tlX, tlY: tlY,
        trX: trX, trY: trY,
        brX: brX, brY: brY,
        blX: blX, blY: blY,
        quality: quality
      )
      return (width: d["width"]?.intValue ?? 0, height: d["height"]?.intValue ?? 0)
    } catch let nsError as NSError {
      throw StitcherError.fromNSError(nsError)
    }
  }

  /// v0.15 debug — write a red-tinted mask overlay (excluded pixels =
  /// red) next to the image and report what fraction the brightness mask
  /// drops. Pairs with the inscribed-rect debug harness.
  public static func debugMaskOverlay(
    imagePath: String,
    threshold: Int
  ) throws -> (maskPath: String, width: Int, height: Int, excludedPercent: Int) {
    do {
      let d = try OpenCVStitcher.debugMaskOverlay(atPath: imagePath, threshold: threshold)
      return (
        maskPath: d["maskPath"] as? String ?? "",
        width: (d["width"] as? NSNumber)?.intValue ?? 0,
        height: (d["height"] as? NSNumber)?.intValue ?? 0,
        excludedPercent: (d["excludedPercent"] as? NSNumber)?.intValue ?? 0
      )
    } catch let nsError as NSError {
      throw StitcherError.fromNSError(nsError)
    }
  }

  /// Combined pipeline: extract frames from a recorded video,
  /// stitch them into a panorama, write the result to
  /// `options.outputPath`.  Used by the host app's tap-and-hold
  /// shutter — the JS side records video while the user holds the
  /// button and calls this on release.
  ///
  /// All temp frame extraction lives in /tmp and is torn down by
  /// the ObjC layer regardless of success or failure.
  public static func stitchVideo(
    _ options: StitchVideoOptions
  ) throws -> StitchResult {
    do {
      // The pose-driven video stitch (the old native `withPoses:`
      // path) was archived in the 2026-06 batch-keyframe cleanup;
      // this now always runs the feature-matched compose.
      let result = try OpenCVStitcher.stitchVideo(
        atPath: options.videoPath,
        outputPath: options.outputPath,
        maxFrames: options.maxFrames,
        jpegQuality: options.jpegQuality,
        warperType: options.warperType,
        blenderType: options.blenderType,
        seamFinderType: options.seamFinderType
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
