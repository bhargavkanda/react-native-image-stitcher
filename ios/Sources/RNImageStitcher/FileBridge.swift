// SPDX-License-Identifier: Apache-2.0
//
// FileBridge.swift
//
// Small native module exposing two file operations the JS layer
// needs in order to:
//
//   1. Move vision-camera's auto-named tmp photo into our canonical
//      default capture dir, so JS-level paths returned to the host
//      are predictable (vs. opaque `<uuid>.jpg` paths in
//      `NSTemporaryDirectory()`).
//   2. Resolve the canonical default capture dir itself, so the JS
//      layer can compose `<defaultDir>/photo-<ms>.jpg` filenames
//      consistently across both platforms.
//
// Kept narrow on purpose — this isn't a general-purpose fs API.  If
// host apps want to read/write arbitrary files they can pull in
// `expo-file-system` themselves; the lib only exposes what it needs
// for its own capture flow.
//
// Canonical capture dir lives under `NSCachesDirectory` (`Library/
// Caches/`) because:
//   * It persists across app restarts (unlike `NSTemporaryDirectory()`).
//   * iOS may evict cache files under memory pressure, which matches
//     the lib's contract: "capture file lives until host moves it
//     somewhere durable."
//   * Not backed up to iCloud, so the user doesn't pay for the
//     ephemeral capture files.

import Foundation
import React

@objc(RNImageStitcherFileUtils)
public class FileBridge: NSObject {

  @objc public static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /// Move (or copy+delete fallback for cross-volume moves) a file
  /// from `from` to `to`.  Both paths can be bare or `file://`-prefixed
  /// — bridge normalises internally.  Creates the destination's
  /// parent directory tree if missing.  Resolves to the bare
  /// destination path.
  @objc(moveFile:to:resolver:rejecter:)
  public func moveFile(_ from: String,
                       to dst: String,
                       resolver: @escaping RCTPromiseResolveBlock,
                       rejecter: @escaping RCTPromiseRejectBlock) {
    let fm = FileManager.default
    let cleanFrom = from.hasPrefix("file://") ? String(from.dropFirst(7)) : from
    let cleanTo = dst.hasPrefix("file://") ? String(dst.dropFirst(7)) : dst
    do {
      let dstDir = (cleanTo as NSString).deletingLastPathComponent
      if !fm.fileExists(atPath: dstDir) {
        try fm.createDirectory(
          atPath: dstDir,
          withIntermediateDirectories: true,
          attributes: nil,
        )
      }
      if fm.fileExists(atPath: cleanTo) {
        try fm.removeItem(atPath: cleanTo)
      }
      // Cheap rename first (same volume).  iOS caches + tmp are on the
      // same APFS volume so this is fast; the catch is for the
      // theoretical cross-volume move that copyItem can still handle.
      do {
        try fm.moveItem(atPath: cleanFrom, toPath: cleanTo)
      } catch {
        try fm.copyItem(atPath: cleanFrom, toPath: cleanTo)
        try? fm.removeItem(atPath: cleanFrom)
      }
      resolver(cleanTo)
    } catch {
      rejecter(
        "FILE_MOVE_FAILED",
        "Failed to move \(cleanFrom) → \(cleanTo): \(error.localizedDescription)",
        error,
      )
    }
  }

  /// Copy a file from `from` to `to`, leaving the source in place.  Both
  /// paths can be bare or `file://`-prefixed.  Creates the destination's
  /// parent directory tree if missing; overwrites an existing destination.
  /// Resolves to the bare destination path.  Used by hosts that need a
  /// distinct output path for an in-place native op (e.g. cropping a copy of
  /// a captured photo so the original survives and the new bytes land on a
  /// fresh URI — avoiding image-cache collisions).
  @objc(copyFile:to:resolver:rejecter:)
  public func copyFile(_ from: String,
                       to dst: String,
                       resolver: @escaping RCTPromiseResolveBlock,
                       rejecter: @escaping RCTPromiseRejectBlock) {
    let fm = FileManager.default
    let cleanFrom = from.hasPrefix("file://") ? String(from.dropFirst(7)) : from
    let cleanTo = dst.hasPrefix("file://") ? String(dst.dropFirst(7)) : dst
    do {
      let dstDir = (cleanTo as NSString).deletingLastPathComponent
      if !fm.fileExists(atPath: dstDir) {
        try fm.createDirectory(
          atPath: dstDir,
          withIntermediateDirectories: true,
          attributes: nil,
        )
      }
      if fm.fileExists(atPath: cleanTo) {
        try fm.removeItem(atPath: cleanTo)
      }
      try fm.copyItem(atPath: cleanFrom, toPath: cleanTo)
      resolver(cleanTo)
    } catch {
      rejecter(
        "FILE_COPY_FAILED",
        "Failed to copy \(cleanFrom) → \(cleanTo): \(error.localizedDescription)",
        error,
      )
    }
  }

  /// Resolve the lib's canonical default capture dir, creating it on
  /// demand.  Returns a bare absolute path.
  @objc(defaultCaptureDir:rejecter:)
  public func defaultCaptureDir(_ resolver: @escaping RCTPromiseResolveBlock,
                                rejecter: @escaping RCTPromiseRejectBlock) {
    let caches = NSSearchPathForDirectoriesInDomains(
      .cachesDirectory, .userDomainMask, true,
    ).first ?? NSTemporaryDirectory()
    let dir = (caches as NSString).appendingPathComponent("react-native-image-stitcher")
    do {
      if !FileManager.default.fileExists(atPath: dir) {
        try FileManager.default.createDirectory(
          atPath: dir,
          withIntermediateDirectories: true,
          attributes: nil,
        )
      }
      resolver(dir)
    } catch {
      rejecter(
        "DIR_CREATE_FAILED",
        "Failed to create canonical capture dir \(dir): \(error.localizedDescription)",
        error,
      )
    }
  }
}
