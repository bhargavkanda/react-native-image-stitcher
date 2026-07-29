// SPDX-License-Identifier: Apache-2.0
//
// ExposureCap.swift — v0.23 anti-blur (1): shutter ceiling for the
// iOS capture device.
//
// ⚠️  DELIBERATELY UNWIRED.  Nothing in this library calls it.  Read
//     "Why this is not wired" before changing that.
//
// What it does when called
// ------------------------
// Caps the AUTO-exposure algorithm's shutter time via
// `AVCaptureDevice.activeMaxExposureDuration`, and restores the
// previous value on stop.  That property — not
// `setExposureModeCustom(duration:ISO:)` — is the correct knob for
// this feature: it leaves AE in charge and lets it compensate with
// GAIN, which is the whole trade the feature wants (sensor noise is
// recoverable — denoise, and multi-band blending averages the overlap
// across frames — while motion blur is not, and smeared frames corrupt
// feature matching, i.e. the stitch GEOMETRY, not just the look).
// `setExposureModeCustom` would pin ISO as well and simply deliver
// darker frames, which score WORSE on variance-of-Laplacian and would
// make the anti-blur feature actively counter-productive.
//
// Why this is not wired
// ---------------------
// On iOS this library never owns an AVCaptureSession:
//
//   • AR path — ARKit owns the capture device outright and publishes no
//     exposure API at all.  The only lever there is the frame interval,
//     which is why anti-blur (5) `preferHighFpsFormat` exists
//     (RNSARSession.pickVideoFormat).
//   • Non-AR path — react-native-vision-camera owns the session, the
//     `AVCaptureDeviceInput`, and the device configuration lock.  This
//     library only receives frames through the frame-processor plugin.
//
// Three concrete blockers, in order of severity:
//
//   1. WE CANNOT IDENTIFY THE DEVICE.  `AVCaptureDevice` instances are
//      process-wide singletons, so IF we knew the unique ID we would be
//      configuring the very object vision-camera is streaming.  But the
//      capture's `configOverrides` carry no device identity, and
//      vision-camera's device comes from the JS `device` prop — it can
//      be the wide, the ultra-wide (every 0.5× capture), or a VIRTUAL
//      multi-camera device.  Falling back to
//      `AVCaptureDevice.default(...)` would, on exactly those captures,
//      silently configure an idle device: a feature that looks wired,
//      logs success, and does nothing.  That is worse than no feature.
//
//   2. THE CAP IS NOT DURABLE.  `activeMaxExposureDuration` is defined
//      against the ACTIVE FORMAT and resets when the format changes.
//      vision-camera re-runs its device configuration on any prop
//      change (format, fps, zoom, torch, low-light-boost) and
//      unconditionally rewrites `activeVideoMin/MaxFrameDuration` while
//      it is in there — and the frame duration is the other half of the
//      bound AE respects.  Holding a cap across that would mean
//      observing the session owner's writes and racing to re-apply
//      them: fighting vision-camera for device config, which is exactly
//      the hack this file refuses to be.
//
//   3. THE CONFIG LOCK IS EXCLUSIVE.  `lockForConfiguration()` throws
//      while vision-camera holds it on its own session queue, so even
//      the apply is best-effort.  (Handled below — it degrades to a
//      no-op — but it means "cap applied" can never be an invariant.)
//
// What the host can do instead
// ----------------------------
//   • vision-camera's own `exposure` prop does NOT do this: it maps to
//     `setExposureTargetBias` (EV bias), which changes AE's TARGET, not
//     its shutter ceiling.  Verified against vision-camera 4.7.3
//     (`CameraSession+Configuration.swift.configureExposure`).
//   • The reachable approximation is the `minFps` prop (plus a
//     high-frame-rate `format`): vision-camera turns it into
//     `activeVideoMaxFrameDuration = 1 / minFps`, and AE cannot expose
//     longer than one frame interval.  `minFps: 60` on a 60 fps format
//     therefore bounds exposure at ~1/60 s — the same construction
//     anti-blur (5) uses on the ARKit side.
//   • If a host genuinely needs the hard cap, it must hand this library
//     the active device's `uniqueID` (vision-camera's JS `device.id` IS
//     the `AVCaptureDevice.uniqueID`) and accept re-applying after every
//     reconfigure.  With that ID this helper works as written.

import AVFoundation
import Foundation
import os.log

/// Best-effort AE shutter ceiling on a named capture device.  See the
/// file header — currently unused by this library.
///
/// Thread-safe: all state is behind `lock`.  Every failure mode is a
/// silent no-op returning `false`; capping exposure must never be able
/// to break a capture that would otherwise have worked.
@objc(RNISExposureCap)
public final class RNISExposureCap: NSObject {

    @objc public static let shared = RNISExposureCap()

    private static let log = OSLog(subsystem: "io.imagestitcher",
                                   category: "exposure-cap")

    private let lock = NSLock()
    /// The device we capped, held so `restore()` targets the same one
    /// even if the host's active device changed underneath us.
    private var cappedDevice: AVCaptureDevice? = nil
    /// Its `activeMaxExposureDuration` from BEFORE we touched it.  We
    /// restore the exact previous value rather than the format default:
    /// the session owner may itself have set a ceiling, and clobbering
    /// it would be a second bug on top of the first.
    private var previousMaxExposureDuration: CMTime? = nil

    /// Cap AE's shutter at `maxExposureMs` on the device with
    /// `deviceUniqueID` (vision-camera's JS `device.id`).
    ///
    /// - Parameter deviceUniqueID: pass the ACTIVE device's unique ID.
    ///   `nil` falls back to the system default video device, which is
    ///   a GUESS and wrong for every ultra-wide / virtual-device
    ///   capture — see blocker 1 in the file header.
    /// - Returns: true only when a cap was actually installed.
    ///   `maxExposureMs <= 0`, an unknown device, a device already
    ///   locked by its owner, or a format that cannot go that fast all
    ///   return false and change nothing.
    @discardableResult
    @objc public func apply(maxExposureMs: Double,
                            deviceUniqueID: String?) -> Bool {
        guard maxExposureMs > 0, maxExposureMs.isFinite else { return false }
        guard let device = Self.resolveDevice(uniqueID: deviceUniqueID) else {
            os_log(.info, log: Self.log,
                   "[antiblur-exposure] no device for id=%{public}@ — skipping",
                   deviceUniqueID ?? "<default>")
            return false
        }

        lock.lock()
        defer { lock.unlock() }
        // Re-applying over our own cap would save OUR value as the
        // "previous" one and leak it past restore().
        if cappedDevice != nil { return false }

        // Clamp into what this format can actually do.  Requesting
        // shorter than `minExposureDuration` is rejected by AVFoundation
        // (an exception, not an error return), so the clamp is load-
        // bearing, not cosmetic.
        let format = device.activeFormat
        let requestedSec = maxExposureMs / 1000.0
        let minSec = CMTimeGetSeconds(format.minExposureDuration)
        let maxSec = CMTimeGetSeconds(format.maxExposureDuration)
        guard minSec.isFinite, maxSec.isFinite, maxSec > 0 else { return false }
        let clampedSec = min(max(requestedSec, minSec), maxSec)
        let duration = CMTime(seconds: clampedSec, preferredTimescale: 1_000_000)

        do {
            try device.lockForConfiguration()
        } catch {
            // The session owner holds the lock — best-effort by design.
            os_log(.info, log: Self.log,
                   "[antiblur-exposure] device busy (%{public}@) — skipping",
                   error.localizedDescription)
            return false
        }
        previousMaxExposureDuration = device.activeMaxExposureDuration
        device.activeMaxExposureDuration = duration
        device.unlockForConfiguration()
        cappedDevice = device
        os_log(.info, log: Self.log,
               "[antiblur-exposure] capped %{public}@ at %.2f ms (asked %.2f)",
               device.uniqueID, clampedSec * 1000.0, maxExposureMs)
        return true
    }

    /// Undo a previous `apply`.  Idempotent and safe to call when no cap
    /// is installed.
    @objc public func restore() {
        lock.lock()
        defer { lock.unlock() }
        guard let device = cappedDevice else { return }
        // Clear our state FIRST: if the device refuses the lock we still
        // must not believe we own a cap on it forever (the value is
        // reset by the next format change anyway).
        let previous = previousMaxExposureDuration
        cappedDevice = nil
        previousMaxExposureDuration = nil
        do {
            try device.lockForConfiguration()
        } catch {
            os_log(.info, log: Self.log,
                   "[antiblur-exposure] restore skipped, device busy (%{public}@)",
                   error.localizedDescription)
            return
        }
        if let previous = previous, previous.isValid {
            device.activeMaxExposureDuration = previous
        } else {
            // `.invalid` is AVFoundation's documented "back to the
            // format default" sentinel.
            device.activeMaxExposureDuration = .invalid
        }
        device.unlockForConfiguration()
    }

    /// Look up a capture device by unique ID; `nil` id falls back to the
    /// system default video device (see the caveat on `apply`).
    private static func resolveDevice(uniqueID: String?) -> AVCaptureDevice? {
        if let uniqueID = uniqueID, !uniqueID.isEmpty {
            return AVCaptureDevice(uniqueID: uniqueID)
        }
        return AVCaptureDevice.default(for: .video)
    }
}
