// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoVcRulesTests — M5: the iOS vision-camera sweep arm refuses by NAME
// every device state it cannot run on (D3, D5, D16, the zoom guard), and
// accepts the ones it can. Nothing here falls back to another camera.
//
// Runs on the Mac (no device, no AVFoundation):
//   swift test, from the swift-tests package root

import XCTest
@testable import RNISPanoPure

final class RNISPanoVcRulesTests: XCTestCase {
    let wide = "AVCaptureDeviceTypeBuiltInWideAngleCamera"
    let ultra = "AVCaptureDeviceTypeBuiltInUltraWideCamera"
    let tele = "AVCaptureDeviceTypeBuiltInTelephotoCamera"
    let lidar = "AVCaptureDeviceTypeBuiltInLiDARDepthCamera"

    // MARK: - D5 — which device

    func testAPhysicalBackCameraRuns() {
        XCTAssertNil(RNISPanoVcRules.deviceRefusal(position: "back", isVirtual: false, constituentTypes: []))
        XCTAssertEqual(RNISPanoVcRules.colourLens(deviceType: wide, isVirtual: false, constituentTypes: []), wide)
    }

    func testTheFrontCameraIsRefusedByName() {
        XCTAssertEqual(RNISPanoVcRules.deviceRefusal(position: "front", isVirtual: false, constituentTypes: [])?.code,
                       "panoplus-vc-device-unsupported")
    }

    func testASingleColourLensVirtualDeviceRuns_theLiDARDepthMount() {
        XCTAssertNil(RNISPanoVcRules.deviceRefusal(position: "back", isVirtual: true, constituentTypes: [wide, lidar]))
        XCTAssertEqual(RNISPanoVcRules.colourLens(deviceType: "AVCaptureDeviceTypeBuiltInLiDARDepthCamera",
                                                  isVirtual: true, constituentTypes: [wide, lidar]), wide)
    }

    func testAMultiLensVirtualDeviceIsRefusedByName() {
        let r = RNISPanoVcRules.deviceRefusal(position: "back", isVirtual: true, constituentTypes: [ultra, wide, tele])
        XCTAssertEqual(r?.code, "panoplus-vc-device-unsupported")
        XCTAssertTrue(r?.detail.contains("3 colour lenses") ?? false)
        XCTAssertNil(RNISPanoVcRules.colourLens(deviceType: "x", isVirtual: true, constituentTypes: [ultra, wide]))
    }

    // MARK: - D16 — the active rate

    func testThirtyAndSixtyRun_belowThirtyIsRefused() {
        XCTAssertNil(RNISPanoVcRules.fpsRefusal(activeFps: 30))
        XCTAssertNil(RNISPanoVcRules.fpsRefusal(activeFps: 29.97))
        XCTAssertNil(RNISPanoVcRules.fpsRefusal(activeFps: 60))
        XCTAssertEqual(RNISPanoVcRules.fpsRefusal(activeFps: 24)?.code, "panoplus-vc-format-below-30fps")
        XCTAssertEqual(RNISPanoVcRules.fpsRefusal(activeFps: .nan)?.code, "panoplus-vc-format-below-30fps")
    }

    // MARK: - the zoom guard

    func testOnlyTheUnzoomedLensRuns() {
        XCTAssertNil(RNISPanoVcRules.zoomRefusal(zoomFactor: 1.0))
        XCTAssertEqual(RNISPanoVcRules.zoomRefusal(zoomFactor: 2.0)?.code, "panoplus-vc-zoom-not-1")
        XCTAssertEqual(RNISPanoVcRules.zoomRefusal(zoomFactor: 1.01)?.code, "panoplus-vc-zoom-not-1")
    }

    // MARK: - D3 — the basis

    func testGravityConfirmsAnUprightPortraitHoldOnly() {
        XCTAssertTrue(RNISPanoVcRules.portraitHoldConfirmed(gx: 0.02, gy: -0.98, gz: -0.1))
        XCTAssertTrue(RNISPanoVcRules.portraitHoldConfirmed(gx: 0.1, gy: -0.7, gz: -0.6))   // tilted at a low shelf
        XCTAssertFalse(RNISPanoVcRules.portraitHoldConfirmed(gx: -0.98, gy: 0.05, gz: 0))   // landscape
        XCTAssertFalse(RNISPanoVcRules.portraitHoldConfirmed(gx: 0, gy: 0.98, gz: 0))       // upside down
        XCTAssertFalse(RNISPanoVcRules.portraitHoldConfirmed(gx: 0, gy: -0.2, gz: -0.97))   // flat
    }

    func testQuarterTurnsAreExactOrNothing() {
        XCTAssertEqual(RNISPanoVcRules.quarterTurn(90), 90)
        XCTAssertEqual(RNISPanoVcRules.quarterTurn(90.4), 90)
        XCTAssertEqual(RNISPanoVcRules.quarterTurn(-90), 270)
        XCTAssertEqual(RNISPanoVcRules.quarterTurn(360), 0)
        XCTAssertNil(RNISPanoVcRules.quarterTurn(45))
        XCTAssertNil(RNISPanoVcRules.quarterTurn(.nan))
    }

    func testAHoldDisagreementIsRetryableAndNeverSendsTheOperatorToCalibrate() {
        let r = RNISPanoVcRules.holdRefusal()
        XCTAssertEqual(r.code, "panoplus-vc-hold-not-portrait")
        XCTAssertTrue(r.detail.contains("portrait"))
        XCTAssertFalse(r.detail.lowercased().contains("calibrat"))
        XCTAssertFalse(RNISPanoVcRules.basisRefusal(derivedIndex: 9, mountingAngleDeg: 270, method: "m",
                                                     refusal: nil)!.detail.contains("calibration tool"))
    }

    func testOnlyTheMeasuredBasisRuns() {
        XCTAssertNil(RNISPanoVcRules.basisRefusal(derivedIndex: 8, mountingAngleDeg: 90, method: "m", refusal: nil))
        let r = RNISPanoVcRules.basisRefusal(derivedIndex: 9, mountingAngleDeg: 270, method: "m", refusal: nil)
        XCTAssertEqual(r?.code, "panoplus-vc-basis-unverified")
        XCTAssertTrue(r?.detail.contains("#9") ?? false)
        XCTAssertEqual(RNISPanoVcRules.basisRefusal(derivedIndex: -1, mountingAngleDeg: nil, method: "m",
                                                    refusal: "mounting-angle-not-a-quarter-turn")?.code,
                       "panoplus-vc-basis-unverified")
    }
}
