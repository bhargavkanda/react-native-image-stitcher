// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoVcRules — the iOS vision-camera sweep arm's start rules (M5), as
// pure functions of plain values.
//
// Foundation-only ON PURPOSE: `swift-tests/` links this file by symlink and
// runs it on the Mac, where there is no `AVCaptureDevice`. The caller
// (`RNISPanoVcArm`) reads the device and hands the rules strings and numbers.
//
// Each refusal is a NAMED rejection code the JS layer maps to a `<Camera>`
// error (`SWEEP_DEVICE_UNSUPPORTED` / `SWEEP_FORMAT_BELOW_30FPS` /
// `SWEEP_ZOOM_NOT_1`). None of them falls back to another camera: before M5 an
// unusable IMU state sent the sweep to ARKit, a different camera behind the
// one on screen.

import Foundation

public struct RNISPanoVcRefusal: Equatable {
    public let code: String
    public let detail: String
}

public enum RNISPanoVcRules {

    /// The basis measured on iPhone17,1 (iPhone 16 Pro): `-y+x+z`. A derived
    /// basis other than this is refused until that kind of device has been
    /// measured (D3).
    public static let confirmedBasisIndex = 8

    /// The colour lenses a constituent can be. LiDAR / TrueDepth / infrared
    /// constituents carry no colour image and do not count.
    public static let colourLensTypes: Set<String> = [
        "AVCaptureDeviceTypeBuiltInWideAngleCamera",
        "AVCaptureDeviceTypeBuiltInUltraWideCamera",
        "AVCaptureDeviceTypeBuiltInTelephotoCamera",
    ]

    /// D5 — which device may the sweep run on?
    ///
    ///   · a BACK camera only (a front camera's mounting and mirroring are a
    ///     different basis; refused rather than guessed);
    ///   · a physical device, or a virtual device with EXACTLY ONE colour
    ///     constituent (e.g. the LiDAR depth camera the field build
    ///     mounts at 1×). A multi-lens virtual device switches its active
    ///     constituent under zoom with no notice, and the focal length would
    ///     come from the wrong lens while the canvas reports success.
    public static func deviceRefusal(
        position: String,
        isVirtual: Bool,
        constituentTypes: [String]
    ) -> RNISPanoVcRefusal? {
        if position != "back" {
            return RNISPanoVcRefusal(
                code: "panoplus-vc-device-unsupported",
                detail: "The sweep runs on a BACK camera only; this one is '\(position)'. "
                      + "A front camera's mounting and mirroring are a different "
                      + "device-to-camera basis, which nothing here has measured.")
        }
        if isVirtual {
            let colour = constituentTypes.filter { colourLensTypes.contains($0) }
            if colour.count != 1 {
                return RNISPanoVcRefusal(
                    code: "panoplus-vc-device-unsupported",
                    detail: "This camera combines \(colour.count) colour lenses "
                          + "(\(colour.joined(separator: ", "))). It switches between "
                          + "them under zoom without notice, so the sweep's focal length "
                          + "would silently come from the wrong lens. Use a single-lens "
                          + "camera for the sweep.")
            }
        }
        return nil
    }

    /// The colour lens a device's frames come from: itself when physical, its
    /// only colour constituent when virtual. Nil when there is no single one.
    public static func colourLens(
        deviceType: String,
        isVirtual: Bool,
        constituentTypes: [String]
    ) -> String? {
        if !isVirtual { return deviceType }
        let colour = constituentTypes.filter { colourLensTypes.contains($0) }
        return colour.count == 1 ? colour[0] : nil
    }

    /// D16 — accept the format vision-camera ACTUALLY has active when it runs
    /// at 30 fps or more; below that the sweep smears and is refused by name.
    /// Never the AVF arm's 60 fps planning rule, and never a format chosen for
    /// the sweep: that would change the viewfinder and the tap photo by engine.
    public static func fpsRefusal(activeFps: Double) -> RNISPanoVcRefusal? {
        guard activeFps.isFinite, activeFps >= 29.5 else {
            return RNISPanoVcRefusal(
                code: "panoplus-vc-format-below-30fps",
                detail: "The camera is running at \(activeFps.isFinite ? String(format: "%.1f", activeFps) : "an unknown rate") fps. "
                      + "A sweep needs at least 30 fps — below that every strip is "
                      + "motion-blurred — and it does not change the camera's format "
                      + "for itself, because the viewfinder and the photo would change "
                      + "with it.")
        }
        return nil
    }

    /// The zoom factor must be the device's 1× (`videoZoomFactor == 1`): the
    /// focal length is derived from the unzoomed field of view.
    public static func zoomRefusal(zoomFactor: Double) -> RNISPanoVcRefusal? {
        guard zoomFactor.isFinite, abs(zoomFactor - 1.0) <= 1e-3 else {
            return RNISPanoVcRefusal(
                code: "panoplus-vc-zoom-not-1",
                detail: "The camera is zoomed (\(zoomFactor.isFinite ? String(format: "%.2f", zoomFactor) : "?")×). "
                      + "The sweep derives its focal length from the unzoomed lens, so "
                      + "it refuses rather than paint at the wrong scale. Pinch back "
                      + "to 1× and start again.")
        }
        return nil
    }

    /// Does gravity (CoreMotion, device frame, in g) say the phone is held
    /// PORTRAIT and upright? `RotationCoordinator`'s horizon angle equals the
    /// camera's portrait mounting angle only in that hold.
    public static func portraitHoldConfirmed(gx: Double, gy: Double, gz: Double) -> Bool {
        guard gx.isFinite, gy.isFinite, gz.isFinite else { return false }
        return gy < -0.5 && abs(gy) > abs(gx)
    }

    /// A rotation angle in degrees as the exact multiple of 90 it names, in
    /// 0..<360 — or nil when it is not within 1° of one.
    public static func quarterTurn(_ deg: Double) -> Int? {
        guard deg.isFinite else { return nil }
        var d = deg.truncatingRemainder(dividingBy: 360)
        if d < 0 { d += 360 }
        let q = (d / 90).rounded()
        guard abs(d - q * 90) <= 1.0 else { return nil }
        return Int(q * 90) % 360
    }

    /// D3 — the derived basis must be the one that has been measured.
    public static func basisRefusal(
        derivedIndex: Int,
        mountingAngleDeg: Int?,
        method: String,
        refusal: String?
    ) -> RNISPanoVcRefusal? {
        if derivedIndex == confirmedBasisIndex { return nil }
        let angle = mountingAngleDeg.map { "\($0)°" } ?? "unknown"
        let why = (refusal ?? "").isEmpty ? "" : " (\(refusal!))"
        return RNISPanoVcRefusal(
            code: "panoplus-vc-basis-unverified",
            detail: "This camera's mounting (\(angle), read by \(method)) gives device-to-"
                  + "camera basis #\(derivedIndex)\(why). Only basis #8 has been measured "
                  + "(iPhone 16 Pro), so the sweep refuses rather than paint on a basis "
                  + "nobody has checked. Measure this kind of device with the basis "
                  + "calibration tool first.")
    }
}
