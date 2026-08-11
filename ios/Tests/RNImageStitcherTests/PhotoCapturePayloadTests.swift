// SPDX-License-Identifier: Apache-2.0
//
// Tests for RNSPhotoCapturePayload.merge — the ONE rule deciding how
// photo-capture-plugin payloads fold into a takePhoto result.
//
// The contract under test (see RNSPhotoCapturePayload.swift):
//   1. no payloads ⇒ the result comes back IDENTICAL (the no-plugin path
//      adds/removes/changes nothing),
//   2. plugin fields merge in,
//   3. the library's own keys always win a collision,
//   4. between plugins, the FIRST to claim a key wins.

import XCTest
@testable import RNImageStitcher

final class PhotoCapturePayloadTests: XCTestCase {

    /// A representative takePhoto core result (the shape encodeArPhoto
    /// builds before any plugin runs).
    private let core: [String: Any] = [
        "path": "/tmp/photo.jpg",
        "width": 4032,
        "height": 3024,
        "isMirrored": false,
        "isRawPhoto": false,
        "pose": ["tx": 0.1, "ty": 0.2],
    ]

    func testNoPayloadsIsIdentity() {
        let merged = RNSPhotoCapturePayload.merge(result: core, payloads: [])
        XCTAssertEqual(
            NSDictionary(dictionary: merged),
            NSDictionary(dictionary: core),
            "zero plugins must leave the result byte-identical"
        )
    }

    func testEmptyPayloadIsIdentity() {
        let merged = RNSPhotoCapturePayload.merge(result: core, payloads: [[:]])
        XCTAssertEqual(
            NSDictionary(dictionary: merged),
            NSDictionary(dictionary: core)
        )
    }

    func testPluginFieldsMergeIn() {
        let payload: [String: Any] = [
            "sidecarPath": "/tmp/photo.extra",
            "sidecarBytes": 1234,
        ]
        let merged = RNSPhotoCapturePayload.merge(
            result: core, payloads: [payload])
        XCTAssertEqual(merged["sidecarPath"] as? String, "/tmp/photo.extra")
        XCTAssertEqual(merged["sidecarBytes"] as? Int, 1234)
        // Core fields untouched.
        XCTAssertEqual(merged["path"] as? String, "/tmp/photo.jpg")
        XCTAssertEqual(merged.count, core.count + 2)
    }

    func testLibraryKeysWinCollisions() {
        let hostile: [String: Any] = [
            "path": "/somewhere/else.jpg",
            "width": 1,
            "pose": "clobbered",
            "extra": true,
        ]
        let merged = RNSPhotoCapturePayload.merge(
            result: core, payloads: [hostile])
        XCTAssertEqual(merged["path"] as? String, "/tmp/photo.jpg",
                       "a plugin must never clobber a library field")
        XCTAssertEqual(merged["width"] as? Int, 4032)
        XCTAssertNotNil(merged["pose"] as? [String: Any])
        XCTAssertEqual(merged["extra"] as? Bool, true)
    }

    func testFirstPluginWinsBetweenPlugins() {
        let first: [String: Any] = ["shared": "first", "onlyFirst": 1]
        let second: [String: Any] = ["shared": "second", "onlySecond": 2]
        let merged = RNSPhotoCapturePayload.merge(
            result: core, payloads: [first, second])
        XCTAssertEqual(merged["shared"] as? String, "first",
                       "registration order decides key ownership")
        XCTAssertEqual(merged["onlyFirst"] as? Int, 1)
        XCTAssertEqual(merged["onlySecond"] as? Int, 2)
    }
}
