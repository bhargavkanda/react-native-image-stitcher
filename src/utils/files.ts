// SPDX-License-Identifier: Apache-2.0
/**
 * Thin JS wrapper around the `RNImageStitcherFileUtils` native
 * module (defined in `ios/Sources/RNImageStitcher/FileBridge.{swift,m}`
 * and `android/src/main/.../FileBridge.kt`).  Internal — not
 * re-exported from `src/index.ts`.
 *
 * Two operations:
 *   - `moveFile(from, to)` — move a file, creating the destination's
 *     parent directory tree on demand.  Used to relocate
 *     vision-camera's auto-named tmp output into the lib's canonical
 *     capture dir.
 *   - `getDefaultCaptureDir()` — resolve (and create on first call)
 *     the canonical default capture directory:
 *
 *       iOS:     `<NSCachesDirectory>/react-native-image-stitcher/`
 *       Android: `<context.cacheDir>/react-native-image-stitcher/`
 *
 *     Predictable, evictable-by-OS, NOT backed up.  Captures live
 *     here until the host moves them somewhere durable (which is
 *     intentional — the lib doesn't promise persistence beyond the
 *     immediate capture flow).
 */

import { NativeModules } from 'react-native';


interface FileUtilsBridge {
  moveFile(from: string, to: string): Promise<string>;
  copyFile(from: string, to: string): Promise<string>;
  defaultCaptureDir(): Promise<string>;
}


function bridge(): FileUtilsBridge | null {
  const m = (NativeModules as Record<string, unknown>).RNImageStitcherFileUtils;
  if (!m || typeof m !== 'object') return null;
  return m as FileUtilsBridge;
}


/**
 * Move a file via the native bridge.  Both paths accepted in bare
 * or `file://`-prefixed form.  Resolves to the bare destination
 * path on success.  Throws on disk failure.
 */
export async function moveFile(from: string, to: string): Promise<string> {
  const b = bridge();
  if (!b) {
    throw new Error(
      'react-native-image-stitcher: RNImageStitcherFileUtils native '
      + 'module is not registered.  Check that the host app has '
      + 'rebuilt against the latest pod/Gradle install.',
    );
  }
  return b.moveFile(from, to);
}


/**
 * Copy a file via the native bridge, leaving the source in place.  Both paths
 * accepted in bare or `file://`-prefixed form.  Resolves to the bare
 * destination path on success.  Throws on disk failure.  Useful when a host
 * needs a distinct output path for an in-place native op (e.g. perspective-
 * cropping a copy of a captured photo so the original survives and the result
 * lands on a fresh URI, avoiding image-cache collisions).
 */
export async function copyFile(from: string, to: string): Promise<string> {
  const b = bridge();
  if (!b) {
    throw new Error(
      'react-native-image-stitcher: RNImageStitcherFileUtils native '
      + 'module is not registered.  Check that the host app has '
      + 'rebuilt against the latest pod/Gradle install.',
    );
  }
  return b.copyFile(from, to);
}


// Cached after the first resolve — the dir doesn't move during the
// lifetime of the app, and the on-first-call mkdir is idempotent.
let cachedDefaultDir: string | null = null;

/**
 * Resolve the canonical default capture directory.  Lazy +
 * memoised — the native side creates the dir on first call, JS
 * caches the result for the rest of the app session.
 */
export async function getDefaultCaptureDir(): Promise<string> {
  if (cachedDefaultDir !== null) return cachedDefaultDir;
  const b = bridge();
  if (!b) {
    throw new Error(
      'react-native-image-stitcher: RNImageStitcherFileUtils native '
      + 'module is not registered.  Check that the host app has '
      + 'rebuilt against the latest pod/Gradle install.',
    );
  }
  cachedDefaultDir = await b.defaultCaptureDir();
  return cachedDefaultDir;
}


/**
 * Compose a default filename for a tap-photo capture, using a
 * millisecond Unix timestamp for ordering.  Pure helper; no I/O.
 */
export function defaultPhotoFilename(): string {
  return `photo-${Date.now()}.jpg`;
}


/**
 * Same as `defaultPhotoFilename` but for panoramas.
 */
export function defaultPanoramaFilename(): string {
  return `panorama-${Date.now()}.jpg`;
}
