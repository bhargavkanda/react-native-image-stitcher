// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoCameraLock — AE / AWB / AF lock and per-frame exposure read-out for
// a pano+ sweep.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// The operator rejected v5's output twice.  The offline owner-map measurement
// settled the mechanism: auto-exposure runs UNLOCKED for the whole sweep and
// the camera brightens by 50-79% end to end (measured on registered
// low-gradient overlap across his four packs), while the engine's chained
// overlap-gain compensator removes only 24-29% of it AND injects its own
// random walk on top.  Locking exposure for the duration of a sweep is
// standard panorama practice — it is what the operator's own iPhone Camera
// does when you start a pano — and it removes the forcing function rather
// than chasing it.
//
// ── Why this is NOT in the public stitcher ───────────────────────────────
//
// The public package ships `RNISExposureCap`, which is deliberately UNWIRED,
// and its header states the three blockers.  Two of them are about the
// vision-camera path and do not apply here:
//
//   1. "WE CANNOT IDENTIFY THE DEVICE."  True for vision-camera, whose device
//      comes from a JS prop and can be the ultra-wide or a virtual
//      multi-camera device.  On the ARKit path there is no ambiguity:
//      ARWorldTrackingConfiguration streams the BACK BUILT-IN WIDE ANGLE
//      camera, so `AVCaptureDevice.default(.builtInWideAngleCamera, .video,
//      .back)` is the device ARKit is using.  We record its `uniqueID` and
//      `localizedName` in the pack anyway, so a wrong guess is visible rather
//      than silent.
//   2. "THE CAP IS NOT DURABLE" — it resets on a format change.  The format
//      change WE make (`setHighFpsFormatEnabled`) happens BEFORE the lock, by
//      construction.  But a format change is not the only way the lock dies:
//      `RNSARSession.makeBaseConfiguration()` re-runs `arSession.run` with
//      `isAutoFocusEnabled = true` for EVERY `<Camera>` prop change (plane
//      detection, scene reconstruction, high-res capture), and an ARKit
//      session interruption does the same on resume.  So durability is not
//      claimed: `currentExposure()` reads the exposure MODE back on every
//      frame and a lock that has been taken away is RE-ASSERTED, rate-limited,
//      off the AR thread.  Every re-assert is counted into the pack.
//   3. "THE CONFIG LOCK IS EXCLUSIVE" — still true, and still handled the
//      same way: every failure degrades to a no-op and is REPORTED, never
//      asserted.  "Locked" is never an invariant here; it is a measurement.
//
// ── What this claims, and what it does not ───────────────────────────────
//
// It does NOT claim ARKit honours the lock.  ARKit owns the capture session
// and publishes no exposure API, and whether it re-arms continuous AE
// underneath us cannot be established from this file.  So the pack carries
// the EVIDENCE instead of the claim: every frame's `exposureDuration` and
// `ISO` are recorded, and `SessionStats::exposureRangeRatio` is 1.00 if and
// only if the exposure really did not move.  A lock that reports success and
// then drifts is therefore a VISIBLE failure in the next pack, not a silent
// one.  (Measured on the v5 packs, which had no lock: the camera's exposure
// swept by 1.50-1.79×.)
//
// ── Threading contract (rewritten after review) ──────────────────────────
//
// TWO locks, and the split is the whole safety argument:
//
//   * `state`  — an NSLock guarding the fields below.  Held for FIELD ACCESS
//     ONLY, never across an AVFoundation call.  `currentExposure()` takes it
//     once per ARFrame on the ARKit delegate thread, so anything that could
//     block while holding it would stall tracking for every sibling plugin.
//   * `config` — an NSLock serialising the lock/unlock/re-assert SEQUENCES.
//     These call `lockForConfiguration()`, which can block on whoever owns the
//     capture session.  The AR thread never takes this lock.
//
// Nothing takes `config` while holding `state`.

#if canImport(AVFoundation)

import AVFoundation
import Foundation
import QuartzCore
import os.log

@objc(RNISPanoCameraLock)
public final class RNISPanoCameraLock: NSObject {

    @objc public static let shared = RNISPanoCameraLock()

    private static let log = OSLog(subsystem: "io.imagestitcher.rn.panoplus",
                                   category: "camera-lock")

    /// Guards the fields below.  FIELD ACCESS ONLY — see the header.
    private let state = NSLock()
    /// Serialises AVFoundation configuration sequences.  Never taken by the
    /// AR thread, and never taken while `state` is held.
    private let config = NSLock()

    /// The device we locked, held so `unlock()` targets the same object even
    /// if the system default changed underneath us.
    private var lockedDevice: AVCaptureDevice?
    /// The device to READ exposure from.  Set even when the lock itself
    /// failed — the metadata is useful precisely then, because that is the
    /// case where the frames really are drifting.
    private var readDevice: AVCaptureDevice?
    private var previousExposureMode: AVCaptureDevice.ExposureMode?
    private var previousWhiteBalanceMode: AVCaptureDevice.WhiteBalanceMode?
    private var previousFocusMode: AVCaptureDevice.FocusMode?

    /// A restore that the device refused.  The camera is still pinned, and it
    /// is pinned for every OTHER capture surface in the app — so this is not
    /// dropped on the floor.  It is retried at the next `attach()` and it is
    /// reported into the pack.
    private var pendingRestore: PendingRestore?
    private var lastRestoreOutcome: String = ""

    /// Re-assert bookkeeping (see blocker 2 in the header).  Read once per
    /// frame on the AR thread; written by the async re-assert.
    private var reassertInFlight = false
    private var reassertLastAtUptime: CFTimeInterval = 0
    private var observedUnlockedFrames: Int = 0
    private var reassertAttempts: Int = 0
    private var reassertSucceeded: Int = 0

    /// Minimum gap between two re-assert attempts.  A device that is refusing
    /// the configuration lock must not be hammered once per frame.
    private static let reassertMinGapS: CFTimeInterval = 0.5

    private struct PendingRestore {
        let device: AVCaptureDevice
        let exposure: AVCaptureDevice.ExposureMode?
        let whiteBalance: AVCaptureDevice.WhiteBalanceMode?
        let focus: AVCaptureDevice.FocusMode?
    }

    // MARK: - Lifecycle

    /// Attach to the ARKit capture device WITHOUT locking anything.  Called
    /// even when `lockCamera` is off, so the per-frame exposure metadata (and
    /// therefore the engine's exact radiometric normalisation) is available in
    /// both arms of the A/B.
    ///
    /// Also the retry point for a restore the device previously refused — see
    /// `pendingRestore`.  A camera left pinned by sweep N must not still be
    /// pinned when sweep N+1 starts, because sweep N+1 would then record
    /// `.locked` as the mode to "restore" to and pin it for the life of the
    /// process.
    ///
    /// Returns the device report; `available: false` when no back wide-angle
    /// camera could be resolved.
    @objc @discardableResult
    public func attach() -> [String: Any] {
        retryPendingRestore()
        let device = AVCaptureDevice.default(.builtInWideAngleCamera,
                                             for: .video, position: .back)
        guard let device = device else {
            state.lock()
            readDevice = nil
            observedUnlockedFrames = 0
            reassertAttempts = 0
            reassertSucceeded = 0
            state.unlock()
            // ONE literal: os_log takes a StaticString, so a concatenated
            // String does not compile here.
            os_log(.info, log: Self.log,
                   "[panoplus-lock] no back wide-angle device — exposure metadata and the AE lock are both unavailable")
            return ["available": false]
        }
        return attachResolved(device)
    }

    /// v12 — the decoupled arm's entry.  The AVFoundation source OPENED its
    /// own device (the ultra-wide by default), so the wide-angle resolution
    /// above would attach — and lock — a camera whose frames never reach the
    /// engine.  Same store, same counters, same restore machinery; the only
    /// difference is which device is stored, and that difference is the whole
    /// point.
    @objc @discardableResult
    public func attach(device: AVCaptureDevice) -> [String: Any] {
        retryPendingRestore()
        return attachResolved(device)
    }

    private func attachResolved(_ device: AVCaptureDevice) -> [String: Any] {
        state.lock()
        readDevice = device
        observedUnlockedFrames = 0
        reassertAttempts = 0
        reassertSucceeded = 0
        state.unlock()
        return [
            "available": true,
            "deviceId": device.uniqueID,
            "deviceName": device.localizedName,
            // v10 — the lens the undistortion gate was told about.  Advisory;
            // see `lensType()` for exactly what it does and does not mean.
            "lensType": device.deviceType.rawValue,
        ]
    }

    /// Lock exposure, white balance and focus for the sweep.
    ///
    /// ⚠️ BLOCKS for up to `settleCeilingMs` — MUST NOT be called on the main
    /// queue.  The wait is not a cargo-cult sleep and it is not a fixed sleep
    /// either: `PanoPlusBridge` has just re-run `arSession.run` with a
    /// different video format, and AE/AWB/AF re-converge over the following
    /// few hundred milliseconds.  Locking into the middle of that convergence
    /// would pin the whole sweep to a half-metered exposure.
    ///
    /// So this POLLS the device's own convergence flags —
    /// `isAdjustingExposure` / `isAdjustingWhiteBalance` / `isAdjustingFocus`
    /// — and locks when they go quiet, with `settleCeilingMs` as a CEILING
    /// rather than a duration.  The elapsed settle and the terminal flag
    /// states go into the report, so "we waited and hoped" becomes a
    /// measurement like everything else here.
    ///
    /// (An earlier revision slept `min(5.0, settleMs) / 1000.0`, which with
    /// the default `settleMs = 600` is FIVE MILLISECONDS — the 5.0 was meant
    /// as a five-SECOND ceiling on a millisecond argument.  That shipped a
    /// lock taken mid-convergence, i.e. exactly the failure this paragraph
    /// describes.  Caught in review; the poll replaces the arithmetic that
    /// made it possible.)
    ///
    /// Returns the report written into the pack's meta.json.  Every field is a
    /// MEASUREMENT taken after the write, never the value we asked for.
    @objc public func lockForSweep(settleCeilingMs: Double) -> [String: Any] {
        return lockAttached(attach(), settleCeilingMs: settleCeilingMs)
    }

    /// v12 — decoupled-arm overload: lock the device the AVF source actually
    /// streams.  Identical body via `lockAttached`; only the `attach` differs,
    /// because the wide-angle default on that arm would settle-poll and pin a
    /// device the sweep is not even reading.
    @objc public func lockForSweep(device: AVCaptureDevice,
                                   settleCeilingMs: Double) -> [String: Any] {
        return lockAttached(attach(device: device), settleCeilingMs: settleCeilingMs)
    }

    private func lockAttached(_ attached: [String: Any],
                              settleCeilingMs: Double) -> [String: Any] {
        var report = attached
        report["requested"] = true
        report["settleCeilingMs"] = settleCeilingMs
        state.lock()
        let resolved = readDevice
        state.unlock()
        guard let device = resolved else {
            report["locked"] = false
            report["reason"] = "no-device"
            return report
        }

        // ── THE SETTLE.  Poll, do not sleep. ─────────────────────────────
        let settle = waitForMetering(device, ceilingMs: settleCeilingMs)
        report["settleMs"] = settle.elapsedMs
        report["settleConverged"] = settle.converged
        report["adjustingExposureAtLock"] = settle.adjustingExposure
        report["adjustingWhiteBalanceAtLock"] = settle.adjustingWhiteBalance
        report["adjustingFocusAtLock"] = settle.adjustingFocus

        config.lock()
        defer { config.unlock() }

        // Re-locking over our own lock would save OUR modes as the "previous"
        // ones and leak them past unlock().  READ THE DEVICE BACK ANYWAY: this
        // path is reached exactly in the states where the lock is most likely
        // to have been taken away underneath us (a mid-sweep `arSession.run`,
        // an RN reload that skipped teardown), so reporting an unmeasured
        // `locked: true` here would be a lie in the one case that matters.
        state.lock()
        let alreadyLocked = (lockedDevice != nil)
        state.unlock()
        if alreadyLocked {
            report["reason"] = "already-locked"
            applyReadBack(device, to: &report)
            return report
        }

        do {
            try device.lockForConfiguration()
        } catch {
            // The session owner holds the configuration lock.  Best-effort by
            // design — see blocker 3 in the file header.
            report["locked"] = false
            report["reason"] = "device-busy: \(error.localizedDescription)"
            os_log(.info, log: Self.log,
                   "[panoplus-lock] device busy (%{public}@) — sweep runs unlocked",
                   error.localizedDescription)
            return report
        }
        // PAIRED.  One early return between the two calls would leak the
        // device configuration lock process-wide, and that failure is
        // invisible from the outside.
        defer { device.unlockForConfiguration() }

        // NEVER PERSIST `.locked` AS "PREVIOUS".  If a previous restore was
        // refused the device is still pinned, and saving what we find would
        // make "restore" mean "re-pin" — forever, for every capture surface in
        // the app, with every later restore reporting success.  Coerce to the
        // continuous mode the app actually wants.
        let prevExposure = continuousEquivalent(device.exposureMode, device)
        let prevWB = continuousEquivalent(device.whiteBalanceMode, device)
        let prevFocus = continuousEquivalent(device.focusMode, device)

        // Each mode is INDEPENDENTLY supported-checked: setting an unsupported
        // mode is an exception, not an error return, and a device that cannot
        // lock focus must still get its exposure locked.
        if device.isExposureModeSupported(.locked) {
            device.exposureMode = .locked
        }
        if device.isWhiteBalanceModeSupported(.locked) {
            device.whiteBalanceMode = .locked
        }
        // FOCUS IS CONDITIONAL, and this is the one place we decline to lock.
        // Pinning a lens that never converged would trade the banding defect
        // for a defocused sweep — a NEW defect, and a worse one, because no
        // amount of downstream photometry can recover detail that was never
        // resolved.  A lens that is still hunting stays on continuous AF and
        // the pack says so.
        let focusEligible = device.isFocusModeSupported(.locked)
            && !device.isAdjustingFocus
        if focusEligible {
            device.focusMode = .locked
        }
        report["focusLockDeclined"] = !focusEligible
            && device.isFocusModeSupported(.locked)

        state.lock()
        lockedDevice = device
        previousExposureMode = prevExposure
        previousWhiteBalanceMode = prevWB
        previousFocusMode = prevFocus
        state.unlock()

        applyReadBack(device, to: &report)

        os_log(.info, log: Self.log,
               "[panoplus-lock] %{public}@ AE=%d AWB=%d AF=%d settle=%.0fms conv=%d dur=%.4fs iso=%.0f",
               device.uniqueID,
               device.exposureMode == .locked ? 1 : 0,
               device.whiteBalanceMode == .locked ? 1 : 0,
               device.focusMode == .locked ? 1 : 0,
               settle.elapsedMs, settle.converged ? 1 : 0,
               CMTimeGetSeconds(device.exposureDuration), Double(device.iso))
        return report
    }

    /// Restore whatever modes we found.  Idempotent; safe when no lock is
    /// installed.  Called from finalize AND cancel AND the start error path
    /// AND the bridge's `invalidate()` — a sweep that ends, is cancelled,
    /// fails after locking, or is torn down by an RN bundle reload must not
    /// leave the camera pinned for every other capture surface in the app.
    ///
    /// A refused restore is NOT swallowed: it is parked in `pendingRestore`,
    /// retried at the next `attach()`, and reported into the pack.  The camera
    /// staying pinned is the single most consequential thing that can happen
    /// in this file and it used to be an `os_log` line nobody would ever read.
    @objc public func unlock() {
        // NOTE: `readDevice` is deliberately NOT cleared here.  The frame
        // plugin is unregistered before this runs, but the registry does not
        // drain an in-flight `process()`, so a frame can still be inside
        // `currentExposure()`.  Nilling the device under it would hand that
        // frame "no metadata" while its neighbours carry a scale factor —
        // planting a photometric step at the very tail, which is 29-48% of the
        // deliverable.  Nothing reads `readDevice` once the plugin is gone,
        // and the next `attach()` overwrites it.
        config.lock()
        defer { config.unlock() }

        state.lock()
        guard let device = lockedDevice else { state.unlock(); return }
        let prevExposure = previousExposureMode
        let prevWB = previousWhiteBalanceMode
        let prevFocus = previousFocusMode
        // Clear our state FIRST: if the device refuses the configuration lock
        // we must not go on believing we own it (the same discipline
        // RNISExposureCap.restore() uses).
        lockedDevice = nil
        previousExposureMode = nil
        previousWhiteBalanceMode = nil
        previousFocusMode = nil
        state.unlock()

        let pending = PendingRestore(device: device, exposure: prevExposure,
                                     whiteBalance: prevWB, focus: prevFocus)
        if applyRestore(pending) {
            state.lock(); lastRestoreOutcome = "restored"; state.unlock()
        } else {
            state.lock()
            pendingRestore = pending
            lastRestoreOutcome = "refused-camera-still-locked"
            state.unlock()
            os_log(.error, log: Self.log,
                   "[panoplus-lock] RESTORE REFUSED — the camera is still locked for every other surface; will retry at the next sweep")
        }
    }

    /// The accumulated evidence, merged into the pack at teardown: what the
    /// initial lock reported PLUS what happened over the sweep.
    @objc public func sweepReport() -> [String: Any] {
        state.lock()
        defer { state.unlock() }
        return [
            "observedUnlockedFrames": observedUnlockedFrames,
            "reassertAttempts": reassertAttempts,
            "reassertSucceeded": reassertSucceeded,
            "restoreOutcome": lastRestoreOutcome,
            "restorePending": pendingRestore != nil,
        ]
    }

    // MARK: - Per-frame read-out (AR thread)

    /// The device's CURRENT exposure, as `[durationSeconds, ISO]`.
    ///
    /// Called once per ARFrame from `RNISPanoPlusPlugin.process(_:)`, which
    /// runs on the ARKit delegate thread with every other plugin serialised
    /// behind it — so this is three property reads and an uncontended lock,
    /// and nothing else.  `nil` when no device is attached, which the caller
    /// forwards as "no metadata" rather than as a dark frame.
    ///
    /// It also DETECTS A LOCK THAT WAS TAKEN AWAY.  Any `<Camera>` prop change
    /// re-runs `arSession.run` with `isAutoFocusEnabled = true`, and so does an
    /// interruption resume; either silently returns the sweep to the unlocked
    /// behaviour the operator rejected.  Reading `exposureMode` back costs one
    /// more property read, and the re-assert itself is dispatched OFF this
    /// thread and rate-limited, so the AR thread never touches
    /// `lockForConfiguration()`.
    ///
    /// v10 — THE ACTIVE LENS, BY NAME, for the undistortion gate.
    ///
    /// SCOPE, and it is narrow: this is the `deviceType` of the back
    /// wide-angle `AVCaptureDevice` this class resolves, i.e. evidence that
    /// such a device OBJECT exists on this body — NOT a measurement of which
    /// lens ARKit is streaming (ARKit does not expose that, which is the same
    /// limitation the exposure sampling above states).  It is therefore
    /// ADVISORY in the gate: it can REFUSE a session whose host names a
    /// different lens, and it can never be the reason one is accepted.  What
    /// accepts a session is the FOCAL check, which reads ARKit's own per-frame
    /// intrinsics.  Returns nil when no back wide-angle camera resolves.
    ///
    /// Does not attach, lock, or mutate anything — a pure query, safe to call
    /// before `attach()` (which is exactly when the engine is configured).
    @objc public func lensType() -> String? {
        if let d = AVCaptureDevice.default(.builtInWideAngleCamera,
                                           for: .video, position: .back) {
            return d.deviceType.rawValue
        }
        return nil
    }

    /// SCOPE, STATED PLAINLY.  This is the device's exposure sampled at
    /// callback time, not a value carried by the frame.  ARKit hands plugins a
    /// `CVPixelBuffer` with no exposure attachment and does not expose the
    /// `ARFrame`, and this pod must not modify the public stitcher to add one
    /// — so a per-frame sample off the shared `AVCaptureDevice` singleton is
    /// the honest best available.  Under a successful lock the value is
    /// CONSTANT and the sampling phase is irrelevant; with the lock refused it
    /// carries up to a frame or two of pipeline lag, which is why the engine
    /// keeps a bounded residual corrector instead of trusting it outright.
    @objc public func currentExposure() -> [NSNumber]? {
        state.lock()
        let device = readDevice
        let weOwnALock = (lockedDevice != nil)
        state.unlock()
        guard let device = device else { return nil }
        if weOwnALock && device.exposureMode != .locked {
            noteLockLost(device)
        }
        let seconds = CMTimeGetSeconds(device.exposureDuration)
        let iso = Double(device.iso)
        guard seconds.isFinite, seconds > 0, iso.isFinite, iso > 0 else {
            return nil
        }
        return [NSNumber(value: seconds), NSNumber(value: iso)]
    }

    // MARK: - Internals

    private struct SettleResult {
        var elapsedMs: Double = 0
        var converged = false
        var adjustingExposure = false
        var adjustingWhiteBalance = false
        var adjustingFocus = false
    }

    /// Poll the device's convergence flags until they go quiet, or until the
    /// ceiling.  20 ms cadence: fine enough that the measured settle is a real
    /// number, coarse enough that it is ~30 wake-ups in the worst case.
    private func waitForMetering(_ device: AVCaptureDevice,
                                 ceilingMs: Double) -> SettleResult {
        var out = SettleResult()
        guard ceilingMs > 0 else {
            out.adjustingExposure = device.isAdjustingExposure
            out.adjustingWhiteBalance = device.isAdjustingWhiteBalance
            out.adjustingFocus = device.isAdjustingFocus
            out.converged = !(out.adjustingExposure || out.adjustingWhiteBalance
                              || out.adjustingFocus)
            return out
        }
        let ceiling = min(5_000.0, ceilingMs) / 1000.0
        let started = CACurrentMediaTime()
        // A FLOOR before the first read.  `arSession.run` was issued moments
        // ago on another thread; the device has not necessarily STARTED
        // adjusting yet, and sampling "not adjusting" before it begins would
        // make the poll return instantly with a stale converged=true.
        let floorS = min(0.120, ceiling)
        while true {
            let elapsed = CACurrentMediaTime() - started
            let adjE = device.isAdjustingExposure
            let adjW = device.isAdjustingWhiteBalance
            let adjF = device.isAdjustingFocus
            if elapsed >= floorS && !adjE && !adjW && !adjF {
                out.converged = true
                out.elapsedMs = elapsed * 1000.0
                return out
            }
            if elapsed >= ceiling {
                out.converged = false
                out.elapsedMs = elapsed * 1000.0
                out.adjustingExposure = adjE
                out.adjustingWhiteBalance = adjW
                out.adjustingFocus = adjF
                return out
            }
            Thread.sleep(forTimeInterval: 0.020)
        }
    }

    /// Everything the DEVICE says after the write.  One shape on every path,
    /// so `meta.json → exposure.lock` is never conditionally missing fields.
    private func applyReadBack(_ device: AVCaptureDevice,
                               to report: inout [String: Any]) {
        let exposureLocked = (device.exposureMode == .locked)
        report["locked"] = exposureLocked
        report["exposureLocked"] = exposureLocked
        report["whiteBalanceLocked"] = (device.whiteBalanceMode == .locked)
        report["focusLocked"] = (device.focusMode == .locked)
        report["exposureModeSupported"] = device.isExposureModeSupported(.locked)
        report["whiteBalanceModeSupported"] =
            device.isWhiteBalanceModeSupported(.locked)
        report["focusModeSupported"] = device.isFocusModeSupported(.locked)
        report["exposureDurationS"] = CMTimeGetSeconds(device.exposureDuration)
        report["iso"] = Double(device.iso)
        report["lensPosition"] = Double(device.lensPosition)
        if report["reason"] == nil {
            report["reason"] = exposureLocked ? "" : "exposure-lock-not-supported"
        }
    }

    /// `.locked` is never a mode to restore TO.  Anything else is returned
    /// unchanged; `.locked` becomes the continuous equivalent when the device
    /// supports it, so a refused restore cannot latch into the next sweep.
    private func continuousEquivalent(_ mode: AVCaptureDevice.ExposureMode,
                                      _ d: AVCaptureDevice)
        -> AVCaptureDevice.ExposureMode {
        guard mode == .locked else { return mode }
        if d.isExposureModeSupported(.continuousAutoExposure) {
            return .continuousAutoExposure
        }
        return d.isExposureModeSupported(.autoExpose) ? .autoExpose : mode
    }

    private func continuousEquivalent(_ mode: AVCaptureDevice.WhiteBalanceMode,
                                      _ d: AVCaptureDevice)
        -> AVCaptureDevice.WhiteBalanceMode {
        guard mode == .locked else { return mode }
        if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            return .continuousAutoWhiteBalance
        }
        return d.isWhiteBalanceModeSupported(.autoWhiteBalance)
            ? .autoWhiteBalance : mode
    }

    private func continuousEquivalent(_ mode: AVCaptureDevice.FocusMode,
                                      _ d: AVCaptureDevice)
        -> AVCaptureDevice.FocusMode {
        guard mode == .locked else { return mode }
        if d.isFocusModeSupported(.continuousAutoFocus) {
            return .continuousAutoFocus
        }
        return d.isFocusModeSupported(.autoFocus) ? .autoFocus : mode
    }

    /// One restore attempt.  Returns false when the device refused the
    /// configuration lock, in which case the camera is STILL PINNED.
    /// Caller holds `config`.
    private func applyRestore(_ p: PendingRestore) -> Bool {
        do {
            try p.device.lockForConfiguration()
        } catch {
            return false
        }
        defer { p.device.unlockForConfiguration() }
        if let m = p.exposure, p.device.isExposureModeSupported(m) {
            p.device.exposureMode = m
        }
        if let m = p.whiteBalance, p.device.isWhiteBalanceModeSupported(m) {
            p.device.whiteBalanceMode = m
        }
        if let m = p.focus, p.device.isFocusModeSupported(m) {
            p.device.focusMode = m
        }
        return true
    }

    /// Retry a restore the device refused last time.  Called from `attach()`,
    /// i.e. before the next sweep saves its own "previous" modes — which is
    /// the exact ordering that stops a single refusal from pinning the camera
    /// for the life of the process.
    private func retryPendingRestore() {
        config.lock()
        defer { config.unlock() }
        state.lock()
        let pending = pendingRestore
        state.unlock()
        guard let p = pending else { return }
        if applyRestore(p) {
            state.lock()
            pendingRestore = nil
            lastRestoreOutcome = "restored-on-retry"
            state.unlock()
            os_log(.info, log: Self.log,
                   "[panoplus-lock] pending restore succeeded on retry")
        }
    }

    /// The lock is gone and we still think we own it.  Count it, and schedule
    /// ONE rate-limited re-assert off this thread.  Never blocks the caller.
    private func noteLockLost(_ device: AVCaptureDevice) {
        let now = CACurrentMediaTime()
        state.lock()
        observedUnlockedFrames += 1
        let busy = reassertInFlight
        let tooSoon = (now - reassertLastAtUptime) < Self.reassertMinGapS
        if busy || tooSoon { state.unlock(); return }
        reassertInFlight = true
        reassertLastAtUptime = now
        reassertAttempts += 1
        state.unlock()

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            self.config.lock()
            var ok = false
            // Only re-assert if we still believe we own a lock — a stop that
            // raced us has already restored the camera and must not be undone.
            self.state.lock()
            let stillOurs = (self.lockedDevice === device)
            self.state.unlock()
            if stillOurs, (try? device.lockForConfiguration()) != nil {
                if device.isExposureModeSupported(.locked) {
                    device.exposureMode = .locked
                }
                if device.isWhiteBalanceModeSupported(.locked) {
                    device.whiteBalanceMode = .locked
                }
                device.unlockForConfiguration()
                ok = (device.exposureMode == .locked)
            }
            self.config.unlock()
            self.state.lock()
            self.reassertInFlight = false
            if ok { self.reassertSucceeded += 1 }
            self.state.unlock()
        }
    }
}

#endif
