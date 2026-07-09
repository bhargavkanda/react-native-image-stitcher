// SPDX-License-Identifier: Apache-2.0
// PhotoDepthSidecar.swift
//
// Extracts the auxiliary depth map that AVFoundation embeds in a captured
// photo (vision-camera `enableDepthData` → `AVCapturePhotoSettings.
// isDepthDataDeliveryEnabled` → `photo.fileDataRepresentation` writes the
// AVDepthData as an auxiliary image inside the JPEG/HEIC) and writes it to a
// small self-describing sidecar file next to the photo.
//
// WHY A SIDECAR: the SDK's `normaliseOrientation` step round-trips every
// non-AR photo through `cv::imread` + `cv::imwrite` (OpenCVStitcher.mm),
// which re-encodes the raster and DROPS every auxiliary image — so embedded
// depth can never survive to consumers.  Extraction MUST therefore run
// BEFORE `normaliseOrientation`; `useCapture.takePhoto` enforces that order.
//
// ── Sidecar container format (`<photo>.depth.bin`, version 1) ─────────────
//
//   bytes 0–7    ASCII magic "RNISDEP1"
//   bytes 8–11   UInt32 little-endian: byte length N of the JSON header
//   bytes 12–..  N bytes of UTF-8 JSON (fields below)
//   remainder    width × height × 4 bytes: Float32 little-endian depth in
//                METRES, row-major, top-left origin, in the SENSOR
//                orientation of the photo as captured (i.e. BEFORE
//                normaliseOrientation bakes the EXIF rotation into pixels).
//                Non-finite or ≤ 0 values are holes ("no depth here").
//
// JSON header fields (all always present; `intrinsics` may be null):
//   version      1
//   width/height depth-map dimensions in pixels
//   unit         "m"
//   byteOrder    "LE"
//   rowMajor     true
//   source       "disparity" | "depth" — which auxiliary image the photo
//                carried (stereo/Portrait pipelines embed disparity, LiDAR
//                pipelines depth); the payload is ALWAYS converted to
//                depth-in-metres regardless.
//   accuracy     "absolute" | "relative" (AVDepthData.depthDataAccuracy)
//   quality      "high" | "low"          (AVDepthData.depthDataQuality)
//   filtered     bool (AVDepthData.isDepthDataFiltered — holes interpolated)
//   orientation  EXIF orientation 1–8 of the photo file (0 = unknown).  The
//                depth raster shares the photo's pre-bake sensor
//                orientation; plane-fit consumers can ignore this (3-D
//                planarity is rotation-invariant when back-projecting with
//                the matching intrinsics).
//   photoWidth/  pixel dimensions of the photo raster as stored (sensor
//   photoHeight  orientation, pre-normalise) — map depth pixels to photo
//                pixels by scaling width/photoWidth etc.
//   intrinsics   { fx, fy, cx, cy, refWidth, refHeight } | null.  Pinhole
//                intrinsics from AVCameraCalibrationData, expressed at
//                `refWidth`×`refHeight` (the intrinsicMatrixReferenceDimensions
//                — the FULL sensor raster, NOT the depth map).  Scale to the
//                depth map with s = width / refWidth before back-projecting.
//                null when the capture carried no calibration data;
//                consumers should fall back to a nominal FOV.
//
// This file is deliberately React- and UIKit-free so it compiles under the
// SwiftPM macOS test target (`cd ios && swift test`) — the container
// round-trip is unit-tested there.  The RN entry point is
// `StitcherBridge.extractPhotoDepth`.

import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

enum PhotoDepthSidecarError: Error {
  /// The photo at the given path could not be opened as an image.
  case readFailed(String)
  /// The sidecar could not be written to the given path.
  case writeFailed(String)
  /// Container encode/decode invariant violated (bad header/dims/magic).
  case malformed(String)
}

enum PhotoDepthSidecar {

  /// 8-byte container magic, version-suffixed ("…1").
  static let magic: [UInt8] = Array("RNISDEP1".utf8)

  // ── Pure container codec (unit-tested on macOS) ─────────────────────────

  /// Encode header + depth payload into the sidecar container.  `header`
  /// must be JSON-encodable and carry integer `width`/`height` matching
  /// `depthMetres.count` — the one invariant every reader depends on.
  static func encodeContainer(
    header: [String: Any],
    depthMetres: [Float32]
  ) throws -> Data {
    guard
      let w = header["width"] as? Int,
      let h = header["height"] as? Int,
      w > 0, h > 0, w * h == depthMetres.count
    else {
      throw PhotoDepthSidecarError.malformed(
        "header width×height must match depth sample count")
    }
    guard JSONSerialization.isValidJSONObject(header) else {
      throw PhotoDepthSidecarError.malformed("header is not JSON-encodable")
    }
    // .sortedKeys → deterministic bytes for a given header (stable tests,
    // stable checksums for anyone deduplicating sidecars).
    let json = try JSONSerialization.data(
      withJSONObject: header, options: [.sortedKeys])
    var data = Data(capacity: 12 + json.count + depthMetres.count * 4)
    data.append(contentsOf: magic)
    let len = UInt32(json.count)
    data.append(contentsOf: [
      UInt8(truncatingIfNeeded: len),
      UInt8(truncatingIfNeeded: len >> 8),
      UInt8(truncatingIfNeeded: len >> 16),
      UInt8(truncatingIfNeeded: len >> 24),
    ])
    data.append(json)
    // Float32 memory layout is little-endian on every Apple platform, so a
    // raw copy IS the declared "LE" payload.
    depthMetres.withUnsafeBufferPointer { data.append($0) }
    return data
  }

  /// Decode a sidecar container.  Reference implementation for readers in
  /// other codebases (and the round-trip unit test).
  static func decodeContainer(
    _ data: Data
  ) throws -> (header: [String: Any], depth: [Float32]) {
    guard data.count >= 12, Array(data.prefix(8)) == magic else {
      throw PhotoDepthSidecarError.malformed("bad magic / truncated container")
    }
    let lenBytes = [UInt8](data.subdata(in: 8..<12))
    let headerLen = Int(lenBytes[0])
      | Int(lenBytes[1]) << 8
      | Int(lenBytes[2]) << 16
      | Int(lenBytes[3]) << 24
    let payloadStart = 12 + headerLen
    guard headerLen > 0, payloadStart <= data.count else {
      throw PhotoDepthSidecarError.malformed("header length out of range")
    }
    let headerData = data.subdata(in: 12..<payloadStart)
    guard
      let headerAny = try? JSONSerialization.jsonObject(with: headerData),
      let header = headerAny as? [String: Any]
    else {
      throw PhotoDepthSidecarError.malformed("header is not a JSON object")
    }
    let payload = data.subdata(in: payloadStart..<data.count)
    guard payload.count % 4 == 0 else {
      throw PhotoDepthSidecarError.malformed("payload is not float32-aligned")
    }
    var depth = [Float32](repeating: 0, count: payload.count / 4)
    depth.withUnsafeMutableBytes { _ = payload.copyBytes(to: $0) }
    guard
      let w = header["width"] as? Int,
      let h = header["height"] as? Int,
      w * h == depth.count
    else {
      throw PhotoDepthSidecarError.malformed(
        "payload size does not match header width×height")
    }
    return (header, depth)
  }

  // ── Extraction (device path; needs a real captured photo) ──────────────

  /// Extract the auxiliary depth of the photo at `imagePath` into a sidecar
  /// at `outputPath`.
  ///
  /// Returns a JS-shaped dictionary:
  ///   no depth in the file (single-lens device, depth-less format, flag
  ///   off, already re-encoded, …) → `{ found: false, reason }` — a benign,
  ///   expected outcome, NOT an error;
  ///   success → `{ found: true, sidecarPath, width, height, source,
  ///   accuracy, quality, hasIntrinsics, validRatio, bytes }`.
  /// Throws `PhotoDepthSidecarError` only for real I/O failures.
  static func extract(
    fromImageAtPath imagePath: String,
    toSidecarPath outputPath: String
  ) throws -> [String: Any] {
    let url = URL(fileURLWithPath: imagePath)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else {
      throw PhotoDepthSidecarError.readFailed(imagePath)
    }

    // Stereo/Portrait pipelines embed DISPARITY; LiDAR pipelines DEPTH.
    // Probe disparity first, then depth.  Either way the payload is
    // converted to metres below.
    var sourceKind = "disparity"
    var auxInfo = CGImageSourceCopyAuxiliaryDataInfoAtIndex(
      src, 0, kCGImageAuxiliaryDataTypeDisparity) as? [AnyHashable: Any]
    if auxInfo == nil {
      auxInfo = CGImageSourceCopyAuxiliaryDataInfoAtIndex(
        src, 0, kCGImageAuxiliaryDataTypeDepth) as? [AnyHashable: Any]
      sourceKind = "depth"
    }
    guard let aux = auxInfo else {
      return ["found": false, "reason": "no-depth-aux"]
    }

    let rawDepth: AVDepthData
    do {
      rawDepth = try AVDepthData(fromDictionaryRepresentation: aux)
    } catch {
      return ["found": false, "reason": "undecodable-depth-aux"]
    }

    // Normalise to Float32 METRES whatever the embedded representation
    // (float16/32 disparity or depth) — AVDepthData converts between all
    // four types.
    let depth32 = rawDepth.depthDataType == kCVPixelFormatType_DepthFloat32
      ? rawDepth
      : rawDepth.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)

    let map = depth32.depthDataMap
    CVPixelBufferLockBaseAddress(map, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
    let width = CVPixelBufferGetWidth(map)
    let height = CVPixelBufferGetHeight(map)
    guard width > 0, height > 0,
          let base = CVPixelBufferGetBaseAddress(map) else {
      return ["found": false, "reason": "empty-depth-map"]
    }
    let stride = CVPixelBufferGetBytesPerRow(map)
    var depth = [Float32](repeating: 0, count: width * height)
    var validCount = 0
    depth.withUnsafeMutableBytes { dst in
      let dstBase = dst.baseAddress!
      for row in 0..<height {
        memcpy(
          dstBase.advanced(by: row * width * 4),
          base.advanced(by: row * stride),
          width * 4)
      }
    }
    for v in depth where v.isFinite && v > 0 { validCount += 1 }

    // Photo-file properties for the header (orientation + raster dims — the
    // consumer's bridge from depth pixels to photo pixels).
    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil)
      as? [AnyHashable: Any]
    let orientation =
      (props?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 0
    let photoWidth =
      (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
    let photoHeight =
      (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0

    let accuracy =
      rawDepth.depthDataAccuracy == .absolute ? "absolute" : "relative"
    let quality = rawDepth.depthDataQuality == .high ? "high" : "low"

    var header: [String: Any] = [
      "version": 1,
      "width": width,
      "height": height,
      "unit": "m",
      "byteOrder": "LE",
      "rowMajor": true,
      "source": sourceKind,
      "accuracy": accuracy,
      "quality": quality,
      "filtered": rawDepth.isDepthDataFiltered,
      "orientation": orientation,
      "photoWidth": photoWidth,
      "photoHeight": photoHeight,
      "intrinsics": NSNull(),
    ]
    if let calib = rawDepth.cameraCalibrationData {
      // simd_float3x3 columns: c0=(fx,0,0) c1=(0,fy,0) c2=(cx,cy,1),
      // expressed at intrinsicMatrixReferenceDimensions (full sensor
      // raster, NOT the depth map) — readers scale by width/refWidth.
      let m = calib.intrinsicMatrix
      let ref = calib.intrinsicMatrixReferenceDimensions
      header["intrinsics"] = [
        "fx": Double(m.columns.0.x),
        "fy": Double(m.columns.1.y),
        "cx": Double(m.columns.2.x),
        "cy": Double(m.columns.2.y),
        "refWidth": Double(ref.width),
        "refHeight": Double(ref.height),
      ]
    }

    let container = try encodeContainer(header: header, depthMetres: depth)
    do {
      try container.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    } catch {
      throw PhotoDepthSidecarError.writeFailed(outputPath)
    }

    return [
      "found": true,
      "sidecarPath": outputPath,
      "width": width,
      "height": height,
      "source": sourceKind,
      "accuracy": accuracy,
      "quality": quality,
      "hasIntrinsics": !(header["intrinsics"] is NSNull),
      "validRatio": depth.isEmpty
        ? 0.0
        : Double(validCount) / Double(depth.count),
      "bytes": container.count,
    ]
  }
}
