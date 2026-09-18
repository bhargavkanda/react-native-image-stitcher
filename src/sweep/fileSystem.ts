// SPDX-License-Identifier: Apache-2.0
/**
 * fileSystem.ts — lazy-resolved `expo-file-system/legacy` slice for the
 * Video-mode capture (DT artifact dirs, twin.json/planogram.json writes,
 * mapping/packshot-index reads, keyframe reclaim).
 *
 * Mirrors audit-sdk's `captureFile.ts` precedent exactly: expo-file-system
 * is native-linked in the HOST app but is NOT a dependency of this SDK, so
 * it resolves at call time inside a try/catch. When absent (node-env jest,
 * or a host without the dep) `loadVideoFileSystem()` returns null and the
 * Video surface renders its degraded "unavailable" state — never a crash
 * (the liveness degradation contract, spec Phase A1 item 4).
 */

/** Minimal slice of the `expo-file-system/legacy` surface Video mode uses.
 *  Declared locally so we take no type-level dependency on the (unlisted)
 *  module. */
export interface VideoFileSystem {
  /** `file://…/Documents/` (trailing slash), or null on exotic platforms. */
  documentDirectory: string | null;
  makeDirectoryAsync(
    uri: string,
    options?: { intermediates?: boolean },
  ): Promise<void>;
  readAsStringAsync(
    uri: string,
    options?: { encoding?: string },
  ): Promise<string>;
  writeAsStringAsync(uri: string, contents: string): Promise<void>;
  deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void>;
  getInfoAsync(uri: string): Promise<{
    exists: boolean;
    /** Last modification time in SECONDS since the epoch (expo-file-system
     *  legacy semantics). Optional: absent on some platforms/entries —
     *  consumers must treat a missing value as UNKNOWN, never as old. */
    modificationTime?: number;
  }>;
  readDirectoryAsync(uri: string): Promise<string[]>;
}

/**
 * Lazy-resolve `expo-file-system/legacy`. Returns the module when the host
 * has it native-linked, else null. Never throws.
 */
export function loadVideoFileSystem(): VideoFileSystem | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-file-system/legacy');
    if (
      mod
      && typeof mod.writeAsStringAsync === 'function'
      && typeof mod.readAsStringAsync === 'function'
      && typeof mod.makeDirectoryAsync === 'function'
    ) {
      return mod as VideoFileSystem;
    }
  } catch {
    // peer dep absent — caller degrades gracefully.
  }
  return null;
}
