// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoLensRequest — WHICH BACK LENS THE DECOUPLED ARM WAS ASKED FOR,
// parsed once, strictly, in a file with no AVFoundation in it.
//
// ── Why this is its own file ─────────────────────────────────────────────
//
// pano+ ⇄ Pano parity (2026-09-03): the on-screen lens switcher is now Pano's
// own `LensChip` (0.5× / 1×), the host writes the choice into the ONE flag
// `panoPlusLens` ('ultraWide' | 'wide'), and the decoupled AVFoundation arm
// must open — for the SWEEP and for the IDLE VIEWFINDER alike — the camera
// that flag names.  Two things went wrong with the parse that used to sit
// inline in `RNISPanoAvfSource.planFormat`:
//
//  1. It was `!= "wide"`.  Every unknown spelling — a chip label ('1x') that
//     skipped the host's mapping, a typo, a boolean — silently opened the
//     ULTRA-WIDE.  A wrong camera opened on a guessed default is the exact
//     defect class this arm's τ/basis gates exist to refuse, committed on the
//     lens instead.
//  2. When the requested lens was WIDE and no wide device was published, the
//     selector quietly fell back to the first device found and recorded
//     nothing about it.  Every iPhone publishes a wide, so the branch was
//     unreachable in practice — but a fallback that cannot happen is still a
//     fallback nobody would see if it did.
//
// Both policies now live here, in pure Swift the Mac can run under XCTest
// (the `swift-tests` SwiftPM package), so the rule is TESTED rather than
// asserted: absent ⇒ ultra-wide (the documented default), the two flag
// spellings and the two `AVCaptureDevice.DeviceType` raw values (the
// calibration store keys on those, and `PanoPlusCalibBridge` forwards a
// stored key's lens verbatim) are accepted, and everything else is a REFUSAL
// with a name.  A requested lens that the body does not publish is likewise
// a refusal — `panoplus-no-ultrawide` / `panoplus-no-wide` — never a swap.
//
// Nothing in here touches a device.  `RNISPanoAvfSource` maps the parsed
// request onto `AVCaptureDevice.DeviceType` and does the discovery; this file
// only answers "what was asked for, and what do we call the answer".

import Foundation

/// The two physical back lenses the decoupled arm can open.  Raw values are
/// the `panoPlusLens` flag's own spellings.
public enum RNISPanoLens: String, CaseIterable {
    case ultraWide = "ultraWide"
    case wide = "wide"

    /// `AVCaptureDevice.DeviceType.rawValue` for this lens — the spelling the
    /// pack's `lens` field, the τ store key and `lens.deviceLens` all use.
    /// Spelled out rather than imported so this file stays AVFoundation-free
    /// (macOS has no `builtInUltraWideCamera`, and the tests run there).
    public var deviceTypeRawValue: String {
        switch self {
        case .ultraWide: return "AVCaptureDeviceTypeBuiltInUltraWideCamera"
        case .wide: return "AVCaptureDeviceTypeBuiltInWideAngleCamera"
        }
    }

    /// The operator-facing name — what Pano's chip calls it.
    public var label: String {
        switch self {
        case .ultraWide: return "0.5× ultra-wide"
        case .wide: return "1× wide"
        }
    }

    /// The `StartFailure` code when THIS lens was requested and the body does
    /// not publish it.  Two codes, not one: a phone with no ultra-wide and a
    /// phone with no wide are different findings and the screen must not
    /// merge them.
    public var absentCode: String {
        switch self {
        case .ultraWide: return "panoplus-no-ultrawide"
        case .wide: return "panoplus-no-wide"
        }
    }

    /// The sentence that rides the refusal.
    public var absentDetail: String {
        switch self {
        case .ultraWide:
            return "This device publishes no builtInUltraWideCamera. That is a "
                 + "finding about the hardware, not a reason to sweep on the "
                 + "wide lens with an ultra-wide τ — switch the lens to 1×."
        case .wide:
            return "This device publishes no builtInWideAngleCamera, which no "
                 + "iPhone this arm targets should be able to say. The 1× "
                 + "request is refused rather than quietly served by the "
                 + "ultra-wide, because a pack that ran on a lens it did not "
                 + "ask for is unusable evidence."
        }
    }

    /// Parse ONE spelling.  `nil` means "not a lens this arm knows".
    static func fromSpelling(_ s: String) -> RNISPanoLens? {
        for lens in RNISPanoLens.allCases
        where s == lens.rawValue || s == lens.deviceTypeRawValue {
            return lens
        }
        return nil
    }
}

/// What the caller asked for, and how.
public struct RNISPanoLensRequest: Equatable {
    /// The lens to open.
    public let lens: RNISPanoLens
    /// The spelling that arrived, verbatim — `nil` when nothing did and the
    /// default applied.  Kept so the pack can show the request beside the
    /// device that ran, in the caller's own words.
    public let spelling: String?

    /// True when no lens was named and the ultra-wide default applied.
    public var defaulted: Bool { return spelling == nil }

    /// The `StartFailure` code for a spelling this arm refuses.
    public static let badLensCode = "panoplus-bad-lens"

    /// The default when nothing is named — the arm's whole reason for
    /// existing (ARKit cannot reach 0.5×), and every pre-P5 caller's
    /// behaviour.
    public static let defaultLens: RNISPanoLens = .ultraWide

    public struct BadSpelling: Error, Equatable {
        public let spelling: String
        public var code: String { return RNISPanoLensRequest.badLensCode }
        public var detail: String {
            return "'\(spelling)' is not a lens this arm knows. The pano+ lens "
                 + "flag (panoPlusLens) speaks 'ultraWide' (0.5×) or 'wide' (1×); "
                 + "the AVCaptureDevice.DeviceType raw values are accepted too "
                 + "because the calibration store keys on them. Pano's chip labels "
                 + "('0.5x' / '1x') are NOT — the host maps the chip onto the flag, "
                 + "and a label reaching this far means that mapping was skipped. "
                 + "Refused rather than opened on a guessed camera."
        }
    }

    /// Parse the `lens` option as it arrives off the RN bridge.
    ///
    /// Accepts `nil`, `NSNull` and a blank string as ABSENT (⇒ ultra-wide);
    /// the two flag spellings; the two device-type raw values.  Everything
    /// else — another string, a number, a bool — throws `BadSpelling`.
    public static func parse(_ raw: Any?) throws -> RNISPanoLensRequest {
        guard let raw = raw, !(raw is NSNull) else {
            return RNISPanoLensRequest(lens: defaultLens, spelling: nil)
        }
        guard let s = raw as? String else {
            throw BadSpelling(spelling: "\(raw)")
        }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return RNISPanoLensRequest(lens: defaultLens, spelling: nil)
        }
        guard let lens = RNISPanoLens.fromSpelling(trimmed) else {
            throw BadSpelling(spelling: trimmed)
        }
        return RNISPanoLensRequest(lens: lens, spelling: trimmed)
    }

    // MARK: - The idle viewfinder's re-open rule

    /// What `startIdlePreview` should do to the session it finds.
    public enum IdleAction: Equatable {
        /// The planned camera is already live in idle mode: leave it alone.
        /// A close→open for a request that changes nothing is a black flash
        /// the operator would read as the camera being taken away.
        case keep
        /// A DIFFERENT camera is live (the operator flipped 0.5× ⇄ 1×): close
        /// it fully first, then open the planned one — clean close→open, one
        /// owner at a time, never two inputs on the session.
        case reopen
        /// Nothing of ours is live: open the planned camera.
        case open
    }

    /// The rule, pure so the Mac can test it.
    ///
    /// - idleActive: `RNISPanoAvfSource.idlePreviewActive` — true between a
    ///   successful idle open and its stop.
    /// - sessionRunning: `AVCaptureSession.isRunning` — an interruption can
    ///   leave `idleActive` true with the session stopped; that is an OPEN,
    ///   not a keep, because there is nothing live to keep.
    /// - liveUniqueId: the `uniqueID` of the device the idle input was built
    ///   on, `nil` when none is recorded.
    /// - plannedUniqueId: the `uniqueID` `planFormat` resolved for this
    ///   request.
    public static func idleAction(idleActive: Bool,
                                  sessionRunning: Bool,
                                  liveUniqueId: String?,
                                  plannedUniqueId: String) -> IdleAction {
        guard idleActive, sessionRunning else { return .open }
        if let live = liveUniqueId, live == plannedUniqueId { return .keep }
        return .reopen
    }
}
