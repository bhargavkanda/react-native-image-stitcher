// SPDX-License-Identifier: Apache-2.0
// QualityCheckerBridge.swift
//
// React Native bridge for `QualityChecker`.  This file does NOT contain
// algorithm code — it converts JS-side promise calls into the pure
// Swift API in `QualityChecker.swift` and converts the resulting
// scores or errors back into a shape the JS layer can consume.
//
// Pairing pattern:
//   * QualityChecker.swift    — pure Swift, XCTest-able, no RN.
//   * QualityCheckerBridge.swift (this file) — RN-aware, registered
//     via `@objc(RNImageStitcherQualityChecker)` so the JS shim can find it
//     at NativeModules.RNImageStitcherQualityChecker.
//
// Why two files instead of one?
//   The bridge depends on React (RCTPromiseResolveBlock,
//   RCTBridgeModule).  XCTest in SwiftPM mode can't resolve those
//   without an Xcode workspace.  Splitting means the algorithm tests
//   build clean from the command line, and only the bridge requires
//   a host-app context to compile (which it already has, via the
//   mobile app's Pods workspace).

#if canImport(React)
import Foundation
import React

@objc(RNImageStitcherQualityChecker)
public class QualityCheckerBridge: NSObject {

  // RCT_EXPORT_MODULE — the Obj-C bridge file picks up this name and
  // registers it with the JS module map.  Returning false here means
  // the module's queue methods aren't required to run on the main
  // thread, which we want — image decode is CPU work.
  @objc public static func requiresMainQueueSetup() -> Bool { return false }

  /// Bridged entry: measure both blur + brightness and resolve with
  /// `{ blurScore, brightnessScore }`.  Reject with a stable code so
  /// the JS layer can branch (e.g. "missing-file" can fall back to a
  /// retry, "decode-failed" usually can't).
  @objc(measure:resolver:rejecter:)
  public func measure(
    imagePath: NSString,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let scores = try QualityChecker.measure(imagePath: imagePath as String)
      resolver([
        "blurScore": scores.blurScore,
        "brightnessScore": scores.brightnessScore,
        "glareScore": scores.glareScore,
      ])
    } catch let err as QualityCheckError {
      switch err {
      case .fileNotFound(let path):
        rejecter("file-not-found", "File not found at path: \(path)", err)
      case .imageDecodeFailed(let path):
        rejecter("decode-failed", "Could not decode image at \(path)", err)
      case .bufferAllocationFailed:
        rejecter("buffer-alloc-failed", "Failed to allocate pixel buffer", err)
      case .convolutionFailed(let vImageError):
        rejecter(
          "convolution-failed",
          "vImage convolution failed (error \(vImageError))",
          err
        )
      }
    } catch {
      rejecter("unknown", "Unexpected error: \(error)", error)
    }
  }
}
#endif
