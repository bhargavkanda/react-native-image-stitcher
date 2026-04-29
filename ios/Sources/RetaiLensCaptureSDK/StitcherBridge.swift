// StitcherBridge.swift
//
// React Native bridge for the SDK's image stitcher.  Mirrors the
// QualityCheckerBridge pattern: the algorithm lives in
// `Stitcher.swift` (which depends only on UIKit + the ObjC
// `OpenCVStitcher`); this file is the translation between RN's
// promise-based bridge and the throwing-Swift API.
//
// Threading:
//   `Stitcher.stitch(...)` is synchronous and CPU-heavy (1–4 seconds
//   for typical 4-frame panoramas on an A17 phone).  Running it on
//   the JS-thread-owned bridge queue would freeze the UI.  We
//   dispatch onto a global utility queue so the user sees their
//   spinner animate while the panorama assembles.

#if canImport(React)
import Foundation
import React
import UIKit

@objc(RetaiLensStitcher)
public class RetaiLensStitcherBridge: NSObject {

  // Stitching is a CPU-bound background operation; let RN drop the
  // module setup to a background queue too so the main thread isn't
  // blocked during initialisation.
  @objc public static func requiresMainQueueSetup() -> Bool { return false }

  /// Bridged entry: stitch the frames at `options.framePaths` into a
  /// panorama at `options.outputPath`.  Resolves with
  /// `{ outputPath, width, height, durationMs }` to match the JS
  /// `StitchFramesResult` type.  Reject codes correspond to the
  /// `StitcherError` cases so the JS host can branch on
  /// "need more frames" vs. "decode failed" etc.
  /// Bridged entry: end-to-end video → panorama pipeline.  Resolves
  /// with the same `{ outputPath, width, height, durationMs }` shape
  /// as `stitch` so the JS layer can swap between "stitch from
  /// pre-captured photos" and "stitch from a tap-hold video" without
  /// branching on result type.
  ///
  /// Expected `options` keys: `videoPath`, `outputPath`, `maxFrames`
  /// (default 10), `quality` (default 85).
  @objc(stitchVideo:resolver:rejecter:)
  public func stitchVideo(
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let videoPath = options["videoPath"] as? String else {
      rejecter("invalid-options", "videoPath must be a string", nil)
      return
    }
    guard let outputPath = options["outputPath"] as? String else {
      rejecter("invalid-options", "outputPath must be a string", nil)
      return
    }
    let maxFrames = (options["maxFrames"] as? Int) ?? 10
    let jpegQuality = (options["quality"] as? Int) ?? 85

    let stitchOpts = StitchVideoOptions(
      videoPath: videoPath,
      outputPath: outputPath,
      maxFrames: maxFrames,
      jpegQuality: jpegQuality
    )

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let result = try Stitcher.stitchVideo(stitchOpts)
        resolver([
          "outputPath": result.outputPath,
          "width": result.width,
          "height": result.height,
          "durationMs": result.durationMs,
        ])
      } catch let err as StitcherError {
        switch err {
        case .insufficientFrames(let count):
          rejecter(
            "insufficient-frames",
            "Need at least 2 frames to stitch (got \(count))",
            err
          )
        case .readFailed(let path):
          rejecter("read-failed", "Could not read input: \(path)", err)
        case .writeFailed(let path):
          rejecter("write-failed", "Could not write panorama: \(path)", err)
        case .opencvFailed(let code, let message):
          rejecter("opencv-failed-\(code)", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected stitcher failure: \(error)", error)
      }
    }
  }

  /// Bake EXIF orientation into the pixels of the image at the
  /// given path.  Resolves with the post-rotation `{ width, height }`
  /// so the JS layer can update its own metadata.
  ///
  /// Expected `options` keys: `imagePath`.
  @objc(normaliseOrientation:resolver:rejecter:)
  public func normaliseOrientation(
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let imagePath = options["imagePath"] as? String else {
      rejecter("invalid-options", "imagePath must be a string", nil)
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let dims = try Stitcher.normaliseOrientation(imagePath: imagePath)
        resolver([
          "width": dims.width,
          "height": dims.height,
        ])
      } catch let err as StitcherError {
        switch err {
        case .insufficientFrames(let count):
          rejecter("insufficient-frames", "(unexpected for normalise) frames=\(count)", err)
        case .readFailed(let path):
          rejecter("read-failed", "Could not read image: \(path)", err)
        case .writeFailed(let path):
          rejecter("write-failed", "Could not write image: \(path)", err)
        case .opencvFailed(let code, let message):
          rejecter("opencv-failed-\(code)", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected normaliseOrientation failure: \(error)", error)
      }
    }
  }

  @objc(stitch:resolver:rejecter:)
  public func stitch(
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    // Translate the dictionary the JS layer hands us into the typed
    // StitchOptions struct.  Defensive: missing / wrong-typed fields
    // raise a recognisable bridge-side error instead of throwing
    // deep inside ObjC.
    guard let framePaths = options["framePaths"] as? [String] else {
      rejecter("invalid-options", "framePaths must be an array of strings", nil)
      return
    }
    guard let outputPath = options["outputPath"] as? String else {
      rejecter("invalid-options", "outputPath must be a string", nil)
      return
    }
    let jpegQuality = (options["quality"] as? Int) ?? 85

    let stitchOpts = StitchOptions(
      framePaths: framePaths,
      outputPath: outputPath,
      jpegQuality: jpegQuality
    )

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let result = try Stitcher.stitch(stitchOpts)
        resolver([
          "outputPath": result.outputPath,
          "width": result.width,
          "height": result.height,
          "durationMs": result.durationMs,
        ])
      } catch let err as StitcherError {
        switch err {
        case .insufficientFrames(let count):
          rejecter(
            "insufficient-frames",
            "Need at least 2 frames to stitch (got \(count))",
            err
          )
        case .readFailed(let path):
          rejecter(
            "read-failed",
            "Could not read input image: \(path)",
            err
          )
        case .writeFailed(let path):
          rejecter(
            "write-failed",
            "Could not write stitched panorama: \(path)",
            err
          )
        case .opencvFailed(let code, let message):
          rejecter("opencv-failed-\(code)", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected stitcher failure: \(error)", error)
      }
    }
  }
}
#endif
