// SPDX-License-Identifier: Apache-2.0
//
// ExposureBurst.swift — v0.22.0 NATIVE side of
// `CameraHandle.captureExposureBurst`: N consecutive video-stream
// frames at a FIXED SHORT exposure, JPEG-encoded, auto-exposure
// restored after.  The capture primitive for display-refresh /
// PWM rolling-shutter banding probes (anti-screen-spoof); the banding
// ANALYSIS is deliberately out of scope (it lives in the consumer).
//
// ## How it drives vision-camera's session WITHOUT touching it
//
// vision-camera's JS `device.id` IS `AVCaptureDevice.uniqueID`
// (vc `AVCaptureDevice+toDictionary.swift` line 16), and
// `AVCaptureDevice(uniqueID:)` returns the process-wide SHARED device
// object vc's `AVCaptureDeviceInput` wraps.  Exposure state is
// device-global, so `setExposureModeCustom(duration:iso:)` here takes
// effect on vc's live stream — 100% public AVFoundation, no vc
// internals.  vc 4.7.3 never observes or corrects exposure (verified:
// no KVO on exposure state; its only `exposureMode` writes fire on
// format/fps/cameraId prop changes and `focus()` calls, none of which
// happen mid-burst in this SDK).
//
// ## Frame source
//
// Frames arrive through the `rnis_exposure_burst_sink` vc Frame
// Processor plugin (`ExposureBurstSinkPlugin.mm`), which the lib's
// stitcher worklet calls for every producer-thread frame while the JS
// side has armed the burst.  Video-stream frames are single-integration
// (still-photo pipelines run multi-frame fusion — Smart HDR / Deep
// Fusion — that would average the banding phases away, which is why
// this does NOT use takePhoto).
//
// ## Per-frame gating
//
// `setExposureModeCustom`'s completion hands back the timestamp of the
// FIRST frame the settings are fully applied to (`syncTime`); the
// collector only keeps sample buffers whose presentation timestamp is
// ≥ that, so every saved frame is guaranteed to carry the manual
// exposure — no "skip a few frames and hope" heuristics.
//
// ## Output orientation
//
// Saved JPEGs are the raw video-stream pixels: SENSOR-NATIVE landscape
// orientation, no rotation, no EXIF orientation tag.  Image rows ==
// sensor rows == the axis rolling-shutter banding runs along.  This is
// a deliberate contract (documented on the JS types): a banding
// consumer must know the row axis, and "always sensor rows" is the one
// choice that never lies.

import AVFoundation
import CoreImage
import Foundation
import React

// ─── Controller ──────────────────────────────────────────────────────

/// Singleton state machine shared by the RCT module (begin/timeout)
/// and the Frame Processor sink plugin (per-frame ingest).  All state
/// transitions are guarded by `lock`; the JPEG encode runs on a
/// background queue after collection completes.
@objc(RNISExposureBurstController)
public final class ExposureBurstController: NSObject {

  @objc public static let shared = ExposureBurstController()
  private override init() { super.init() }

  // ── State (all guarded by `lock`) ─────────────────────────────────
  private enum State {
    case idle
    /// Exposure requested; waiting for the `setExposureModeCustom`
    /// completion to tell us the first-applied frame timestamp.
    case waitingForApply
    /// Keeping frames with PTS ≥ `collectFrom`.
    case collecting
    /// Got all frames; encoding on the background queue.  Ingest
    /// calls are ignored (burst already restored auto-exposure).
    case encoding
  }

  private let lock = NSLock()
  private var state: State = .idle
  /// Generation token: bumps on every begin/finish so a stale timeout
  /// (or a stale exposure-apply completion) can't touch a later burst.
  private var generation: UInt64 = 0

  private var device: AVCaptureDevice?
  private var frameCount = 3
  private var quality = 85.0
  private var outputDir = ""
  private var appliedDurationMs = 0.0
  private var appliedIso: Float = 0
  private var collectFrom = CMTime.invalid
  private var copies: [(buffer: CVPixelBuffer, timestampNs: Int64)] = []
  private var resolver: RCTPromiseResolveBlock?
  private var rejecter: RCTPromiseRejectBlock?

  private let encodeQueue = DispatchQueue(
    label: "io.imagestitcher.exposure-burst.encode",
    qos: .userInitiated,
  )

  // ── Begin ─────────────────────────────────────────────────────────

  /// Kick off a burst.  Called by the RCT module on an arbitrary
  /// bridge queue.  Rejects immediately if a burst is already running
  /// or the device can't do custom exposure; otherwise locks the
  /// manual exposure and waits for frames from the sink plugin.
  func begin(deviceId: String,
             frameCount: Int,
             exposureDurationMs: Double,
             iso: Double,
             quality: Double,
             outputDir: String,
             timeoutMs: Double,
             resolver: @escaping RCTPromiseResolveBlock,
             rejecter: @escaping RCTPromiseRejectBlock) {
    lock.lock()
    guard state == .idle else {
      lock.unlock()
      rejecter(
        "EXPOSURE_BURST_IN_FLIGHT",
        "captureExposureBurst: a burst is already in flight.",
        nil,
      )
      return
    }

    guard let device = AVCaptureDevice(uniqueID: deviceId) else {
      lock.unlock()
      rejecter(
        "EXPOSURE_BURST_DEVICE_NOT_FOUND",
        "captureExposureBurst: no AVCaptureDevice with uniqueID '\(deviceId)'.",
        nil,
      )
      return
    }
    guard device.isExposureModeSupported(.custom) else {
      lock.unlock()
      rejecter(
        "EXPOSURE_BURST_UNSUPPORTED",
        "captureExposureBurst: device '\(device.localizedName)' does not "
        + "support custom exposure.",
        nil,
      )
      return
    }

    // Clamp the requested duration to the active format's range.  2 ms
    // is comfortably inside every modern iPhone's video-format range
    // (min is tens of µs), but a defensive clamp costs nothing.
    let format = device.activeFormat
    let requested = CMTime(
      seconds: max(0.05, exposureDurationMs) / 1000.0,
      preferredTimescale: 1_000_000_000,
    )
    var duration = requested
    if CMTimeCompare(duration, format.minExposureDuration) < 0 {
      duration = format.minExposureDuration
    }
    if CMTimeCompare(duration, format.maxExposureDuration) > 0 {
      duration = format.maxExposureDuration
    }

    // ISO: explicit value, or compensate the shorter integration by
    // scaling the CURRENT auto-exposure operating point (the shared
    // device exposes live AE actuals) so the frame stays usable.
    let currentIso = device.iso
    let currentDurationSec = device.exposureDuration.seconds
    let durationSec = duration.seconds
    var targetIso: Float
    if iso > 0 {
      targetIso = Float(iso)
    } else if currentDurationSec > 0, durationSec > 0 {
      targetIso = currentIso * Float(currentDurationSec / durationSec)
    } else {
      targetIso = format.maxISO
    }
    targetIso = min(max(targetIso, format.minISO), format.maxISO)

    do {
      try device.lockForConfiguration()
    } catch {
      lock.unlock()
      rejecter(
        "EXPOSURE_BURST_LOCK_FAILED",
        "captureExposureBurst: lockForConfiguration failed: "
        + error.localizedDescription,
        error,
      )
      return
    }

    // Commit state BEFORE issuing the async exposure change so the
    // completion (camera queue) finds a consistent controller.
    generation &+= 1
    let gen = generation
    self.state = .waitingForApply
    self.device = device
    self.frameCount = max(1, min(frameCount, 10))
    self.quality = min(max(quality, 1), 100)
    self.outputDir = outputDir
    self.appliedDurationMs = durationSec * 1000.0
    self.appliedIso = targetIso
    self.collectFrom = .invalid
    self.copies = []
    self.resolver = resolver
    self.rejecter = rejecter
    lock.unlock()

    device.setExposureModeCustom(duration: duration, iso: targetIso) { [weak self] syncTime in
      // `syncTime` is the PTS of the FIRST frame fully exposed with
      // the custom settings — the precise gate for the collector.
      guard let self else { return }
      self.lock.lock()
      guard self.generation == gen, self.state == .waitingForApply else {
        self.lock.unlock()
        return
      }
      self.collectFrom = syncTime
      self.state = .collecting
      self.lock.unlock()
    }
    device.unlockForConfiguration()

    // Watchdog: reject + restore if frames never arrive (frame
    // processor not mounted, camera unmounted mid-burst, …).
    encodeQueue.asyncAfter(deadline: .now() + max(0.5, timeoutMs / 1000.0)) { [weak self] in
      self?.timeout(generation: gen)
    }
  }

  // ── Per-frame ingest (vc video queue, via the sink plugin) ───────

  /// Called for every producer-thread frame while the JS side has the
  /// burst armed.  Cheap no-op outside the collecting window.
  @objc public func ingestSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
    lock.lock()
    guard state == .collecting else {
      lock.unlock()
      return
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard collectFrom.isValid, CMTimeCompare(pts, collectFrom) >= 0 else {
      lock.unlock()
      return
    }
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      lock.unlock()
      return
    }
    // Deep-copy: the camera reuses its buffer pool the moment this
    // callback returns, and holding pool buffers across the burst
    // would starve the preview.  ~1–3 ms memcpy per frame, inside the
    // 33 ms frame budget, so consecutive frames stay consecutive.
    guard let copy = ExposureBurstController.deepCopy(pixelBuffer) else {
      lock.unlock()
      return
    }
    copies.append((copy, Int64(pts.seconds * 1_000_000_000.0)))
    let done = copies.count >= frameCount
    if done { state = .encoding }
    let gen = generation
    let deviceToRestore = done ? device : nil
    lock.unlock()

    if done {
      // Restore auto-exposure FIRST (shortens the dark-preview
      // window), then encode off the camera thread.  The transition
      // to .encoding above (same lock hold as the final append) is
      // what fences the timeout watchdog out — its claim guard
      // excludes .encoding atomically.
      restoreAutoExposure(on: deviceToRestore)
      encodeQueue.async { [weak self] in
        self?.encodeAndResolve(generation: gen)
      }
    }
  }

  // ── Completion paths ──────────────────────────────────────────────

  private func encodeAndResolve(generation gen: UInt64) {
    lock.lock()
    guard generation == gen, state == .encoding,
          let resolve = resolver else {
      lock.unlock()
      return
    }
    let toEncode = copies
    let dir = outputDir
    let q = quality
    let durationMs = appliedDurationMs
    let isoUsed = appliedIso
    lock.unlock()

    do {
      try FileManager.default.createDirectory(
        atPath: dir,
        withIntermediateDirectories: true,
        attributes: nil,
      )
      let ciContext = CIContext()
      let colorSpace = CGColorSpaceCreateDeviceRGB()
      var paths: [String] = []
      var timestamps: [Int64] = []
      for (i, entry) in toEncode.enumerated() {
        let path = (dir as NSString).appendingPathComponent("frame-\(i).jpg")
        let image = CIImage(cvPixelBuffer: entry.buffer)
        try ciContext.writeJPEGRepresentation(
          of: image,
          to: URL(fileURLWithPath: path),
          colorSpace: image.colorSpace ?? colorSpace,
          options: [
            kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:
              q / 100.0,
          ],
        )
        paths.append(path)
        timestamps.append(entry.timestampNs)
      }
      let width = toEncode.first.map { CVPixelBufferGetWidth($0.buffer) } ?? 0
      let height = toEncode.first.map { CVPixelBufferGetHeight($0.buffer) } ?? 0
      finish(generation: gen) {
        resolve([
          "frames": paths,
          "width": width,
          "height": height,
          "exposureDurationMs": durationMs,
          "iso": Double(isoUsed),
          "timestampsNs": timestamps.map { NSNumber(value: $0) },
        ])
      }
    } catch {
      let reject = rejecterSnapshot()
      finish(generation: gen) {
        reject?(
          "EXPOSURE_BURST_ENCODE_FAILED",
          "captureExposureBurst: JPEG encode/write failed: "
          + error.localizedDescription,
          error,
        )
      }
    }
  }

  private func timeout(generation gen: UInt64) {
    lock.lock()
    guard generation == gen, state != .idle, state != .encoding else {
      lock.unlock()
      return
    }
    // Claim the burst terminally UNDER THE SAME LOCK HOLD as the state
    // check.  The previous check-unlock-then-finish shape was a TOCTOU:
    // the final frame could land between the unlock and finish(), flip
    // the state to .encoding, and this watchdog would then reject a
    // burst that actually completed (while the encode's own guard made
    // it silently drop the resolve).  Tearing down inline while locked
    // means a racing ingest/encode finds .idle and no-ops instead.
    let collected = copies.count
    let wanted = frameCount
    let reject = rejecter
    let deviceToRestore = device
    state = .idle
    device = nil
    copies = []
    resolver = nil
    rejecter = nil
    lock.unlock()

    restoreAutoExposure(on: deviceToRestore)
    reject?(
      "EXPOSURE_BURST_TIMEOUT",
      "captureExposureBurst: timed out with \(collected)/\(wanted) frames "
      + "collected.  Is the lib's non-AR frame processor mounted?  "
      + "(Hosts that replace it must compose `useStitcherWorklet`.)",
      nil,
    )
  }

  /// Tear down burst state (idempotent per generation) and run the
  /// settle callback exactly once.
  private func finish(generation gen: UInt64, settle: () -> Void) {
    lock.lock()
    guard generation == gen, state != .idle else {
      lock.unlock()
      return
    }
    state = .idle
    device = nil
    copies = []
    resolver = nil
    rejecter = nil
    lock.unlock()
    settle()
  }

  private func rejecterSnapshot() -> RCTPromiseRejectBlock? {
    lock.lock()
    defer { lock.unlock() }
    return rejecter
  }

  /// Put the device back on continuous auto-exposure (vision-camera's
  /// steady-state, see vc `CameraSession+Configuration.swift:288`).
  /// Takes the device as a parameter because the terminal paths
  /// (timeout claim, collection-complete) snapshot it under the lock
  /// while tearing down / transitioning state; no-op on nil.
  private func restoreAutoExposure(on device: AVCaptureDevice?) {
    guard let device else { return }
    do {
      try device.lockForConfiguration()
      if device.isExposureModeSupported(.continuousAutoExposure) {
        device.exposureMode = .continuousAutoExposure
      } else if device.isExposureModeSupported(.autoExpose) {
        device.exposureMode = .autoExpose
      }
      device.unlockForConfiguration()
    } catch {
      NSLog(
        "[RNISExposureBurst] failed to restore auto exposure: %@",
        error.localizedDescription,
      )
    }
  }

  // ── Pixel-buffer deep copy ────────────────────────────────────────

  private static func deepCopy(_ src: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(src)
    let height = CVPixelBufferGetHeight(src)
    let format = CVPixelBufferGetPixelFormatType(src)
    var dstOut: CVPixelBuffer?
    // No IOSurface/attributes needed — the copy only feeds CIImage.
    guard CVPixelBufferCreate(nil, width, height, format, nil, &dstOut) == kCVReturnSuccess,
          let dst = dstOut else {
      return nil
    }
    CVPixelBufferLockBaseAddress(src, .readOnly)
    CVPixelBufferLockBaseAddress(dst, [])
    defer {
      CVPixelBufferUnlockBaseAddress(dst, [])
      CVPixelBufferUnlockBaseAddress(src, .readOnly)
    }
    if CVPixelBufferIsPlanar(src) {
      for plane in 0..<CVPixelBufferGetPlaneCount(src) {
        guard let s = CVPixelBufferGetBaseAddressOfPlane(src, plane),
              let d = CVPixelBufferGetBaseAddressOfPlane(dst, plane) else {
          return nil
        }
        let sStride = CVPixelBufferGetBytesPerRowOfPlane(src, plane)
        let dStride = CVPixelBufferGetBytesPerRowOfPlane(dst, plane)
        let rows = CVPixelBufferGetHeightOfPlane(src, plane)
        if sStride == dStride {
          memcpy(d, s, sStride * rows)
        } else {
          let rowBytes = min(sStride, dStride)
          for r in 0..<rows {
            memcpy(d + r * dStride, s + r * sStride, rowBytes)
          }
        }
      }
    } else {
      guard let s = CVPixelBufferGetBaseAddress(src),
            let d = CVPixelBufferGetBaseAddress(dst) else {
        return nil
      }
      let sStride = CVPixelBufferGetBytesPerRow(src)
      let dStride = CVPixelBufferGetBytesPerRow(dst)
      if sStride == dStride {
        memcpy(d, s, sStride * height)
      } else {
        let rowBytes = min(sStride, dStride)
        for r in 0..<height {
          memcpy(d + r * dStride, s + r * sStride, rowBytes)
        }
      }
    }
    return dst
  }
}


// ─── RCT module ──────────────────────────────────────────────────────

/// The `NativeModules.RNISExposureBurst` surface.  One method: run the
/// whole lock-exposure → collect → encode → restore sequence and
/// resolve with the frame paths.  See `src/camera/exposureBurst.ts`
/// for the JS contract.
@objc(RNISExposureBurst)
public class ExposureBurst: NSObject {

  @objc public static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(capture:resolver:rejecter:)
  public func capture(_ options: NSDictionary,
                      resolver: @escaping RCTPromiseResolveBlock,
                      rejecter: @escaping RCTPromiseRejectBlock) {
    guard let deviceId = options["deviceId"] as? String,
          let outputDir = options["outputDir"] as? String else {
      rejecter(
        "EXPOSURE_BURST_BAD_ARGS",
        "captureExposureBurst: `deviceId` and `outputDir` are required.",
        nil,
      )
      return
    }
    let frameCount = (options["frameCount"] as? NSNumber)?.intValue ?? 3
    let exposureDurationMs = (options["exposureDurationMs"] as? NSNumber)?.doubleValue ?? 2.0
    let iso = (options["iso"] as? NSNumber)?.doubleValue ?? -1.0
    let quality = (options["quality"] as? NSNumber)?.doubleValue ?? 85.0
    let timeoutMs = (options["timeoutMs"] as? NSNumber)?.doubleValue ?? 5000.0

    ExposureBurstController.shared.begin(
      deviceId: deviceId,
      frameCount: frameCount,
      exposureDurationMs: exposureDurationMs,
      iso: iso,
      quality: quality,
      outputDir: outputDir.hasPrefix("file://")
        ? String(outputDir.dropFirst(7))
        : outputDir,
      timeoutMs: timeoutMs,
      resolver: resolver,
      rejecter: rejecter,
    )
  }
}
