// SPDX-License-Identifier: Apache-2.0
//
// Tests for RNSPhotoCapturePayload.merge — the ONE rule deciding how
// photo-capture-plugin payloads fold into a takePhoto result.
//
// The contract under test (see RNSPhotoCapturePayload.swift):
//   1. no payloads ⇒ the result comes back IDENTICAL — the plugin MERGE is
//      the identity (the hook adds/removes/changes nothing),
//   2. plugin fields merge in,
//   3. the library's own keys always win a collision,
//   4. between plugins, the FIRST to claim a key wins.
//
// SCOPE: clause 1 is a statement about the HOOK, not about the whole
// takePhoto payload.  The `pose` field is an ADDITIVE takePhoto feature
// stamped upstream of the merge (RNSARSession.encodeArPhoto), present
// whether or not any plugin is registered.  The merge neither invents nor
// strips it — the pose-additivity tests below pin that split explicitly.

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

    func testNoPayloadsMergeIsTheIdentity() {
        let merged = RNSPhotoCapturePayload.merge(result: core, payloads: [])
        XCTAssertEqual(
            NSDictionary(dictionary: merged),
            NSDictionary(dictionary: core),
            "zero plugins ⇒ the MERGE must be the identity — the hook " +
            "adds, removes, and changes nothing in the result it was given"
        )
    }

    func testEmptyPayloadMergeIsTheIdentity() {
        let merged = RNSPhotoCapturePayload.merge(result: core, payloads: [[:]])
        XCTAssertEqual(
            NSDictionary(dictionary: merged),
            NSDictionary(dictionary: core)
        )
    }

    // MARK: Pose additivity vs merge identity — the two are SEPARATE.
    //
    // `pose` is stamped by takePhoto itself (an additive result field new
    // relative to earlier releases), upstream of this merge and regardless
    // of plugin registration.  These tests pin the split: the identity
    // guarantee is about the hook, and the merge neither invents a `pose`
    // that takePhoto did not stamp nor strips the one it did.

    func testMergeIdentityDoesNotInventPose() {
        // A result WITHOUT a pose (e.g. the native pose read failed) passes
        // through the empty-registry merge with no pose materialised.
        var poseless = core
        poseless.removeValue(forKey: "pose")
        let merged = RNSPhotoCapturePayload.merge(result: poseless, payloads: [])
        XCTAssertNil(merged["pose"],
                     "the merge must not invent a pose — pose presence is " +
                     "decided by takePhoto's own stamp, not by the hook")
        XCTAssertEqual(
            NSDictionary(dictionary: merged),
            NSDictionary(dictionary: poseless)
        )
    }

    func testPoseRidesThroughTheIdentityUntouched() {
        // A result WITH the (unconditionally stamped) pose keeps it —
        // byte-for-byte — through the empty-registry merge.
        let merged = RNSPhotoCapturePayload.merge(result: core, payloads: [])
        XCTAssertEqual(
            NSDictionary(dictionary: merged["pose"] as? [String: Any] ?? [:]),
            NSDictionary(dictionary: core["pose"] as? [String: Any] ?? [:]),
            "the additive pose stamp must survive the no-plugin merge " +
            "untouched — it is present with or without plugins"
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
