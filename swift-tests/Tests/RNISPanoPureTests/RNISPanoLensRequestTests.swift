// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoLensRequestTests — the lens the decoupled arm opens is the lens the
// flag named, and nothing else.
//
// pano+ ⇄ Pano parity (2026-09-03): Pano's chip writes `panoPlusLens`, the
// surface forwards it as `lens` to `start()` AND `setIdlePreview()`, and
// `RNISPanoAvfSource.planFormat` resolves the device through this rule.  The
// property under test: WHAT THE FLAG SAID IS WHAT GETS OPENED, and every other
// input is a named refusal — never a guessed camera.
//
// Runs on the Mac (no device, no AVFoundation):
//   swift test, from the swift-tests package root

import XCTest
@testable import RNISPanoPure

final class RNISPanoLensRequestTests: XCTestCase {

    // MARK: - The two spellings the flag speaks

    func testWideOpensTheWide() throws {
        let r = try RNISPanoLensRequest.parse("wide")
        XCTAssertEqual(r.lens, .wide)
        XCTAssertEqual(r.spelling, "wide")
        XCTAssertFalse(r.defaulted)
        XCTAssertEqual(r.lens.deviceTypeRawValue, "AVCaptureDeviceTypeBuiltInWideAngleCamera")
        XCTAssertEqual(r.lens.label, "1× wide")
    }

    func testUltraWideOpensTheUltraWide() throws {
        let r = try RNISPanoLensRequest.parse("ultraWide")
        XCTAssertEqual(r.lens, .ultraWide)
        XCTAssertFalse(r.defaulted)
        XCTAssertEqual(r.lens.deviceTypeRawValue, "AVCaptureDeviceTypeBuiltInUltraWideCamera")
        XCTAssertEqual(r.lens.label, "0.5× ultra-wide")
    }

    // MARK: - Absent ⇒ the documented default, and the pack knows it defaulted

    func testAbsentDefaultsToUltraWideAndSaysSo() throws {
        for raw in [nil, NSNull(), "", "   "] as [Any?] {
            let r = try RNISPanoLensRequest.parse(raw)
            XCTAssertEqual(r.lens, .ultraWide, "absent lens must default to ultra-wide: \(String(describing: raw))")
            XCTAssertTrue(r.defaulted, "a default must be reported as one: \(String(describing: raw))")
            XCTAssertNil(r.spelling)
        }
    }

    // MARK: - The calibration store's spelling is accepted verbatim

    func testDeviceTypeRawValuesAreAccepted() throws {
        // `PanoPlusCalibBridge.formatKeyParts` forwards a stored key's lens —
        // the AVCaptureDevice.DeviceType raw value — straight into planFormat.
        // Before this rule existed, the WIDE raw value was `!= "wide"` and
        // therefore planned the ULTRA-WIDE.
        let wide = try RNISPanoLensRequest.parse("AVCaptureDeviceTypeBuiltInWideAngleCamera")
        XCTAssertEqual(wide.lens, .wide)
        XCTAssertFalse(wide.defaulted)
        let uw = try RNISPanoLensRequest.parse("AVCaptureDeviceTypeBuiltInUltraWideCamera")
        XCTAssertEqual(uw.lens, .ultraWide)
    }

    // MARK: - Everything else is a refusal with a name, never a guessed camera

    func testPanoChipLabelsAreRefusedNotGuessed() {
        // THE MAPPING SLIP THIS RULE EXISTS FOR.  Pano's chip speaks '0.5x' /
        // '1x'; the host maps those onto the flag.  A label reaching native
        // means the mapping was skipped, and `!= "wide"` used to open the
        // ULTRA-WIDE for '1x' — the operator asking for 1× and getting 0.5×.
        for label in ["1x", "0.5x", "1×", "0.5×"] {
            XCTAssertThrowsError(try RNISPanoLensRequest.parse(label), label) { e in
                guard let bad = e as? RNISPanoLensRequest.BadSpelling else {
                    return XCTFail("expected BadSpelling for \(label), got \(e)")
                }
                XCTAssertEqual(bad.code, "panoplus-bad-lens")
                XCTAssertEqual(bad.spelling, label)
                XCTAssertTrue(bad.detail.contains("panoPlusLens"), bad.detail)
                XCTAssertTrue(bad.detail.contains("mapping was skipped"), bad.detail)
            }
        }
    }

    func testCaseAndTyposAreRefused() {
        for s in ["Wide", "WIDE", "ultrawide", "UltraWide", "ultra-wide", "tele", "auto"] {
            XCTAssertThrowsError(try RNISPanoLensRequest.parse(s), s)
        }
    }

    func testNonStringsAreRefused() {
        XCTAssertThrowsError(try RNISPanoLensRequest.parse(1))
        XCTAssertThrowsError(try RNISPanoLensRequest.parse(true))
        XCTAssertThrowsError(try RNISPanoLensRequest.parse(0.5))
        XCTAssertThrowsError(try RNISPanoLensRequest.parse(["lens": "wide"]))
    }

    func testWhitespaceAroundAValidSpellingIsTolerated() throws {
        // A trimmed spelling is still the flag's word; the verbatim field
        // keeps the trimmed form so the pack does not carry stray spaces.
        let r = try RNISPanoLensRequest.parse(" wide\n")
        XCTAssertEqual(r.lens, .wide)
        XCTAssertEqual(r.spelling, "wide")
    }

    // MARK: - A requested lens the body does not publish: two codes, not one

    func testAbsentLensCodesAreDistinct() {
        XCTAssertEqual(RNISPanoLens.ultraWide.absentCode, "panoplus-no-ultrawide")
        XCTAssertEqual(RNISPanoLens.wide.absentCode, "panoplus-no-wide")
        XCTAssertNotEqual(RNISPanoLens.ultraWide.absentDetail, RNISPanoLens.wide.absentDetail)
        // The ultra-wide refusal must point the operator at the switch that
        // fixes it; the wide refusal must say it was not silently served.
        XCTAssertTrue(RNISPanoLens.ultraWide.absentDetail.contains("1×"))
        XCTAssertTrue(RNISPanoLens.wide.absentDetail.contains("refused"))
    }

    // MARK: - The idle viewfinder's re-open rule

    func testSameLensAlreadyLiveIsKept() {
        // The operator taps the chip position that is already selected, or the
        // surface re-asks for the same lens: no close→open, no black blink.
        XCTAssertEqual(
            RNISPanoLensRequest.idleAction(idleActive: true, sessionRunning: true,
                                           liveUniqueId: "cam-uw", plannedUniqueId: "cam-uw"),
            .keep)
    }

    func testOtherLensLiveIsAFullReopen() {
        // 0.5× ⇄ 1× at idle: the live camera is closed FIRST, then the new one
        // opened — one owner at a time, never two inputs on the session.
        XCTAssertEqual(
            RNISPanoLensRequest.idleAction(idleActive: true, sessionRunning: true,
                                           liveUniqueId: "cam-uw", plannedUniqueId: "cam-wide"),
            .reopen)
    }

    func testNothingLiveIsAPlainOpen() {
        XCTAssertEqual(
            RNISPanoLensRequest.idleAction(idleActive: false, sessionRunning: false,
                                           liveUniqueId: nil, plannedUniqueId: "cam-uw"),
            .open)
        // A sweep just ended: the session is stopped and idle was never
        // re-armed — still a plain open even if a stale id lingered.
        XCTAssertEqual(
            RNISPanoLensRequest.idleAction(idleActive: false, sessionRunning: true,
                                           liveUniqueId: "cam-uw", plannedUniqueId: "cam-uw"),
            .open)
    }

    func testIdleActiveButSessionStoppedIsAnOpenNotAKeep() {
        // An interruption can stop the session under a still-armed idle flag.
        // There is nothing live to keep; a `.keep` here would answer `on: true`
        // over a dead feed — the frozen-frame incident, on iOS.
        XCTAssertEqual(
            RNISPanoLensRequest.idleAction(idleActive: true, sessionRunning: false,
                                           liveUniqueId: "cam-uw", plannedUniqueId: "cam-uw"),
            .open)
    }

    func testUnknownLiveIdIsAReopenNotAKeep() {
        // Active and running but nobody recorded which device: we cannot claim
        // it is the planned one, so close and open rather than guess.
        XCTAssertEqual(
            RNISPanoLensRequest.idleAction(idleActive: true, sessionRunning: true,
                                           liveUniqueId: nil, plannedUniqueId: "cam-uw"),
            .reopen)
    }
}
