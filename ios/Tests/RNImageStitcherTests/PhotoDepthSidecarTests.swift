// SPDX-License-Identifier: Apache-2.0
// PhotoDepthSidecarTests.swift
//
// Container-codec tests for the `<photo>.depth.bin` sidecar
// (PhotoDepthSidecar.swift).  The container is a CROSS-REPO CONTRACT —
// downstream consumers (e.g. the RetaiLens camera-sdk planarity bridge)
// parse these exact bytes — so the framing is pinned here byte-by-byte,
// not just via encode→decode symmetry.
//
// The device-only half (CGImageSource → AVDepthData extraction) can't run
// under SwiftPM on macOS (needs a real dual-camera/LiDAR capture); it is
// covered by the example-app Test Plan instead.

import Foundation
import XCTest
@testable import RNImageStitcher

final class PhotoDepthSidecarTests: XCTestCase {

  private func makeHeader(width: Int, height: Int) -> [String: Any] {
    return [
      "version": 1,
      "width": width,
      "height": height,
      "unit": "m",
      "byteOrder": "LE",
      "rowMajor": true,
      "source": "disparity",
      "accuracy": "absolute",
      "quality": "high",
      "filtered": true,
      "orientation": 6,
      "photoWidth": width * 8,
      "photoHeight": height * 8,
      "intrinsics": [
        "fx": 3021.5, "fy": 3021.5,
        "cx": 2011.0, "cy": 1507.5,
        "refWidth": 4032.0, "refHeight": 3024.0,
      ],
    ]
  }

  func testRoundTripPreservesHeaderAndPayloadBitExactly() throws {
    let width = 8
    let height = 6
    // A tilted plane plus one NaN hole and one zero hole — the two invalid
    // encodings readers must treat as "no depth here".
    var depth = [Float32](repeating: 0, count: width * height)
    for y in 0..<height {
      for x in 0..<width {
        depth[y * width + x] = 0.8 + Float32(x) * 0.01 + Float32(y) * 0.02
      }
    }
    depth[5] = Float32.nan
    depth[17] = 0

    let data = try PhotoDepthSidecar.encodeContainer(
      header: makeHeader(width: width, height: height), depthMetres: depth)
    let (header, decoded) = try PhotoDepthSidecar.decodeContainer(data)

    XCTAssertEqual(header["width"] as? Int, width)
    XCTAssertEqual(header["height"] as? Int, height)
    XCTAssertEqual(header["unit"] as? String, "m")
    XCTAssertEqual(header["source"] as? String, "disparity")
    XCTAssertEqual(header["orientation"] as? Int, 6)
    let intrinsics = header["intrinsics"] as? [String: Any]
    XCTAssertEqual(intrinsics?["fx"] as? Double, 3021.5)
    XCTAssertEqual(intrinsics?["refWidth"] as? Double, 4032.0)

    XCTAssertEqual(decoded.count, depth.count)
    for i in 0..<depth.count {
      // Bit-pattern equality so the NaN hole survives too.
      XCTAssertEqual(
        decoded[i].bitPattern, depth[i].bitPattern,
        "payload float \(i) must survive bit-exactly")
    }
  }

  func testContainerFramingIsPinned() throws {
    let width = 3
    let height = 2
    let depth: [Float32] = [1, 2, 3, 4, 5, 6]
    let data = try PhotoDepthSidecar.encodeContainer(
      header: makeHeader(width: width, height: height), depthMetres: depth)

    // Magic: ASCII "RNISDEP1" at offset 0.
    XCTAssertEqual(Array(data.prefix(8)), Array("RNISDEP1".utf8))

    // Header length: UInt32 LE at offset 8, matching the JSON slice.
    let lenBytes = [UInt8](data.subdata(in: 8..<12))
    let headerLen = Int(lenBytes[0]) | Int(lenBytes[1]) << 8
      | Int(lenBytes[2]) << 16 | Int(lenBytes[3]) << 24
    XCTAssertEqual(data.count, 12 + headerLen + depth.count * 4)

    // The header slice parses as JSON with the declared dims.
    let headerObj = try JSONSerialization.jsonObject(
      with: data.subdata(in: 12..<(12 + headerLen))) as? [String: Any]
    XCTAssertEqual(headerObj?["width"] as? Int, width)

    // Payload: float32 LITTLE-ENDIAN row-major — pin the first float's
    // exact bytes (1.0f == 00 00 80 3F in LE).
    let payload = [UInt8](data.suffix(depth.count * 4))
    XCTAssertEqual(Array(payload.prefix(4)), [0x00, 0x00, 0x80, 0x3F])
  }

  func testEncodeRejectsDimensionMismatch() {
    XCTAssertThrowsError(
      try PhotoDepthSidecar.encodeContainer(
        header: makeHeader(width: 4, height: 4),
        depthMetres: [Float32](repeating: 1, count: 15)))
  }

  func testDecodeRejectsForeignData() {
    XCTAssertThrowsError(
      try PhotoDepthSidecar.decodeContainer(Data("not a sidecar".utf8)))
    // Right magic, absurd header length → must throw, not crash.
    var truncated = Data("RNISDEP1".utf8)
    truncated.append(contentsOf: [0xFF, 0xFF, 0xFF, 0x7F])
    XCTAssertThrowsError(try PhotoDepthSidecar.decodeContainer(truncated))
  }
}
