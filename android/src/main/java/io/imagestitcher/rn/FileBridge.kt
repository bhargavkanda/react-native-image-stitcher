// SPDX-License-Identifier: Apache-2.0
//
// FileBridge.kt
//
// Android side of the same small file-utility module exposed on
// iOS by FileBridge.swift / FileBridge.m.  See the Swift file for
// the architectural rationale on why this exists.

package io.imagestitcher.rn

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class FileBridge(reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "RNImageStitcherFileUtils"

  /**
   * Move (with copy+delete fallback) a file from `from` to `to`.
   * Both paths can be bare or `file://`-prefixed.  Creates the
   * destination's parent dir tree on demand.  Resolves to the bare
   * destination path.
   */
  @ReactMethod
  fun moveFile(from: String, to: String, promise: Promise) {
    try {
      val cleanFrom = if (from.startsWith("file://")) from.substring(7) else from
      val cleanTo = if (to.startsWith("file://")) to.substring(7) else to
      val src = File(cleanFrom)
      val dst = File(cleanTo)
      dst.parentFile?.mkdirs()
      if (dst.exists()) {
        dst.delete()
      }
      // Cheap rename first (same volume); copyTo + delete fallback
      // handles the theoretical cross-volume case.
      if (!src.renameTo(dst)) {
        src.copyTo(dst, overwrite = true)
        src.delete()
      }
      promise.resolve(cleanTo)
    } catch (e: Exception) {
      promise.reject(
        "FILE_MOVE_FAILED",
        "Failed to move $from → $to: ${e.message}",
        e,
      )
    }
  }

  /**
   * Copy a file from `from` to `to`, leaving the source in place.
   * Both paths can be bare or `file://`-prefixed.  Creates the
   * destination's parent dir tree on demand; overwrites an existing
   * destination.  Resolves to the bare destination path.  Used when a
   * host needs a distinct output path for an in-place native op (e.g.
   * cropping a copy of a captured photo so the original survives and the
   * result lands on a fresh URI, avoiding image-cache collisions).
   */
  @ReactMethod
  fun copyFile(from: String, to: String, promise: Promise) {
    try {
      val cleanFrom = if (from.startsWith("file://")) from.substring(7) else from
      val cleanTo = if (to.startsWith("file://")) to.substring(7) else to
      val src = File(cleanFrom)
      val dst = File(cleanTo)
      dst.parentFile?.mkdirs()
      src.copyTo(dst, overwrite = true)
      promise.resolve(cleanTo)
    } catch (e: Exception) {
      promise.reject(
        "FILE_COPY_FAILED",
        "Failed to copy $from → $to: ${e.message}",
        e,
      )
    }
  }

  /**
   * Resolve the lib's canonical default capture dir, creating it on
   * demand.  Returns a bare absolute path.
   *
   * Lives under `context.cacheDir` because that's the Android
   * equivalent of iOS's `NSCachesDirectory`: persists across
   * restarts, evictable by the OS under pressure, not backed up.
   */
  @ReactMethod
  fun defaultCaptureDir(promise: Promise) {
    try {
      val dir = File(reactApplicationContext.cacheDir, "react-native-image-stitcher")
      if (!dir.exists()) {
        dir.mkdirs()
      }
      promise.resolve(dir.absolutePath)
    } catch (e: Exception) {
      promise.reject(
        "DIR_CREATE_FAILED",
        "Failed to create canonical capture dir: ${e.message}",
        e,
      )
    }
  }
}
