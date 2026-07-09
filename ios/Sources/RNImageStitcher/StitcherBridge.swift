// SPDX-License-Identifier: Apache-2.0
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

@objc(BatchStitcher)
public class StitcherBridge: NSObject {

  // Stitching is a CPU-bound background operation; let RN drop the
  // module setup to a background queue too so the main thread isn't
  // blocked during initialisation.
  @objc public static func requiresMainQueueSetup() -> Bool { return false }

  /// Constants exposed to JS at module load time.  Read via
  /// `NativeModules.BatchStitcher.physicalMemoryBytes`.
  ///
  /// Used by the SDK's `DEFAULT_PANORAMA_SETTINGS` to pick
  /// memory-appropriate defaults: high-quality MultiBand+GraphCut
  /// on devices with ≥2 GB physical RAM, low-memory Feather+skip
  /// on devices with <2 GB.  The user can still override either
  /// way via the panorama settings modal.
  ///
  /// CRITICAL: this MUST be a class method (`static`), not an
  /// instance method.  React Native's bridge gathers constants by
  /// trying `[ModuleClass respondsToSelector:@selector(constants
  /// ToExport)]` first; only the class-method form satisfies that
  /// without forcing module instantiation.  When this was an
  /// instance method, the module was lazily created on the first
  /// `stitchVideo` call — so by then JS had already read empty
  /// constants and our `_isLowMem` check fell back incorrectly.
  ///
  /// Reading `ProcessInfo.processInfo.physicalMemory` is thread-
  /// safe (no UIKit dependency), so the constants gathering can
  /// happen off main thread; `requiresMainQueueSetup = false`
  /// stays correct.
  ///
  /// Returning `[String: Any]` (not `[AnyHashable: Any]`) so the
  /// Swift→ObjC bridge produces an `NSDictionary<NSString *, id> *`
  /// which is exactly what RN's `constantsToExport` declares.
  @objc public static func constantsToExport() -> [String: Any] {
    let bytes = ProcessInfo.processInfo.physicalMemory
    NSLog("[BatchStitcher] constantsToExport: physicalMemoryBytes=%llu",
          bytes)
    return [
      "physicalMemoryBytes": NSNumber(value: bytes),
    ]
  }

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
    let warperType = (options["warperType"] as? String) ?? "plane"
    let blenderType = (options["blenderType"] as? String) ?? "multiband"
    let seamFinderType = (options["seamFinderType"] as? String) ?? "graphcut"

    let stitchOpts = StitchVideoOptions(
      videoPath: videoPath,
      outputPath: outputPath,
      maxFrames: maxFrames,
      jpegQuality: jpegQuality,
      warperType: warperType,
      blenderType: blenderType,
      seamFinderType: seamFinderType
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

  /// Extract the auxiliary depth map embedded in the photo at
  /// `options.imagePath` (captured with vision-camera `enableDepthData`)
  /// into a sidecar container at `options.outputPath` — see
  /// `PhotoDepthSidecar.swift` for the format.
  ///
  /// ORDER MATTERS: must be called BEFORE `normaliseOrientation` on the
  /// same file — the OpenCV re-encode strips auxiliary images, after which
  /// this resolves `{ found: false }` forever.
  ///
  /// Resolves `{ found: false, reason }` when the file simply carries no
  /// depth (single-lens device, depth-less format, flag off) — that is an
  /// expected outcome, not a rejection.  Rejects only on real I/O errors.
  @objc(extractPhotoDepth:resolver:rejecter:)
  public func extractPhotoDepth(
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let imagePath = options["imagePath"] as? String else {
      rejecter("invalid-options", "imagePath must be a string", nil)
      return
    }
    guard let outputPath = options["outputPath"] as? String else {
      rejecter("invalid-options", "outputPath must be a string", nil)
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        resolver(try PhotoDepthSidecar.extract(
          fromImageAtPath: imagePath,
          toSidecarPath: outputPath))
      } catch let err as PhotoDepthSidecarError {
        switch err {
        case .readFailed(let path):
          rejecter("read-failed", "Could not read image: \(path)", err)
        case .writeFailed(let path):
          rejecter("write-failed", "Could not write depth sidecar: \(path)", err)
        case .malformed(let message):
          rejecter("malformed-depth", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected extractPhotoDepth failure: \(error)", error)
      }
    }
  }

  /// v0.15 debug — compute the max-inscribed rectangle of `imagePath`
  /// without modifying it.  Resolves
  /// `{ x, y, width, height, imageWidth, imageHeight }`.
  @objc(computeInscribedRect:resolver:rejecter:)
  public func computeInscribedRect(
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
        let r = try Stitcher.computeInscribedRect(imagePath: imagePath)
        resolver([
          "x": r.x,
          "y": r.y,
          "width": r.width,
          "height": r.height,
          "imageWidth": r.imageWidth,
          "imageHeight": r.imageHeight,
        ])
      } catch let err as StitcherError {
        switch err {
        case .insufficientFrames(let count):
          rejecter("insufficient-frames", "(unexpected for computeInscribedRect) frames=\(count)", err)
        case .readFailed(let path):
          rejecter("read-failed", "Could not read image: \(path)", err)
        case .writeFailed(let path):
          rejecter("write-failed", "Could not write image: \(path)", err)
        case .opencvFailed(let code, let message):
          rejecter("opencv-failed-\(code)", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected computeInscribedRect failure: \(error)", error)
      }
    }
  }

  /// v0.15 debug — crop `imagePath` to the rectangle in `options`
  /// (`x`, `y`, `width`, `height`) at `quality` (default 90), overwriting
  /// in place.  Resolves the final `{ width, height }`.
  @objc(cropToRect:resolver:rejecter:)
  public func cropToRect(
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let imagePath = options["imagePath"] as? String else {
      rejecter("invalid-options", "imagePath must be a string", nil)
      return
    }
    let x = (options["x"] as? NSNumber)?.intValue ?? 0
    let y = (options["y"] as? NSNumber)?.intValue ?? 0
    let width = (options["width"] as? NSNumber)?.intValue ?? 0
    let height = (options["height"] as? NSNumber)?.intValue ?? 0
    let quality = (options["quality"] as? NSNumber)?.intValue ?? 90
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let dims = try Stitcher.cropToRect(
          imagePath: imagePath,
          x: x,
          y: y,
          width: width,
          height: height,
          quality: quality
        )
        resolver([
          "width": dims.width,
          "height": dims.height,
        ])
      } catch let err as StitcherError {
        switch err {
        case .insufficientFrames(let count):
          rejecter("insufficient-frames", "(unexpected for cropToRect) frames=\(count)", err)
        case .readFailed(let path):
          rejecter("read-failed", "Could not read image: \(path)", err)
        case .writeFailed(let path):
          rejecter("write-failed", "Could not write image: \(path)", err)
        case .opencvFailed(let code, let message):
          rejecter("opencv-failed-\(code)", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected cropToRect failure: \(error)", error)
      }
    }
  }

  /// item-7 — perspective-rectify a user-dragged quad.  `options` carries
  /// `imagePath` + the 4 IMAGE-PIXEL corners as a flat `quad` array of 8
  /// numbers `[tlX, tlY, trX, trY, brX, brY, blX, blY]` (ordered
  /// TL→TR→BR→BL by the JS editor) + optional `quality` (default 90).
  /// Resolves the rectified `{ width, height }`.
  @objc(cropToQuad:resolver:rejecter:)
  public func cropToQuad(
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let imagePath = options["imagePath"] as? String else {
      rejecter("invalid-options", "imagePath must be a string", nil)
      return
    }
    guard let quad = options["quad"] as? [NSNumber], quad.count == 8 else {
      rejecter(
        "invalid-options",
        "quad must be an array of 8 numbers [tlX,tlY,trX,trY,brX,brY,blX,blY]",
        nil
      )
      return
    }
    let p = quad.map { $0.doubleValue }
    let quality = (options["quality"] as? NSNumber)?.intValue ?? 90
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let dims = try Stitcher.cropToQuad(
          imagePath: imagePath,
          tlX: p[0], tlY: p[1],
          trX: p[2], trY: p[3],
          brX: p[4], brY: p[5],
          blX: p[6], blY: p[7],
          quality: quality
        )
        resolver([
          "width": dims.width,
          "height": dims.height,
        ])
      } catch let err as StitcherError {
        switch err {
        case .insufficientFrames(let count):
          rejecter("insufficient-frames", "(unexpected for cropToQuad) frames=\(count)", err)
        case .readFailed(let path):
          rejecter("read-failed", "Could not read image: \(path)", err)
        case .writeFailed(let path):
          rejecter("write-failed", "Could not write image: \(path)", err)
        case .opencvFailed(let code, let message):
          rejecter("opencv-failed-\(code)", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected cropToQuad failure: \(error)", error)
      }
    }
  }

  /// v0.15 debug — write a red-tinted mask overlay for `imagePath`
  /// (excluded pixels red). `threshold` optional (default 1, matching the
  /// inscribed-rect mask). Resolves
  /// `{ maskPath, width, height, excludedPercent }`.
  @objc(debugMaskOverlay:resolver:rejecter:)
  public func debugMaskOverlay(
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let imagePath = options["imagePath"] as? String else {
      rejecter("invalid-options", "imagePath must be a string", nil)
      return
    }
    let threshold = (options["threshold"] as? NSNumber)?.intValue ?? 1
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let r = try Stitcher.debugMaskOverlay(imagePath: imagePath, threshold: threshold)
        resolver([
          "maskPath": r.maskPath,
          "width": r.width,
          "height": r.height,
          "excludedPercent": r.excludedPercent,
        ])
      } catch let err as StitcherError {
        switch err {
        case .insufficientFrames(let count):
          rejecter("insufficient-frames", "(unexpected for debugMaskOverlay) frames=\(count)", err)
        case .readFailed(let path):
          rejecter("read-failed", "Could not read image: \(path)", err)
        case .writeFailed(let path):
          rejecter("write-failed", "Could not write image: \(path)", err)
        case .opencvFailed(let code, let message):
          rejecter("opencv-failed-\(code)", message, err)
        }
      } catch {
        rejecter("unknown", "Unexpected debugMaskOverlay failure: \(error)", error)
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
