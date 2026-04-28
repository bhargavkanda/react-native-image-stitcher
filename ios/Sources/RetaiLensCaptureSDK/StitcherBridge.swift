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
