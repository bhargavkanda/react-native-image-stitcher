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

import { NativeModules } from 'react-native';

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
 * The base directory a sweep records into, from THIS PACKAGE'S own native
 * module — no Expo, no peer dependency, no host cooperation.
 *
 * ⚠ THIS IS NOT A FILESYSTEM AND MUST NOT BE DRESSED UP AS ONE. It answers
 * exactly one question — "where may a sweep write?" — because that is the
 * only filesystem fact a sweep needs before it starts: native creates the
 * session directory itself.
 *
 * The tempting move is to return a partial `VideoFileSystem` here with the
 * other six members missing. That would hand callers an object that satisfies
 * the type and throws `undefined is not a function` the first time anyone
 * calls `writeAsStringAsync` on it — the same shape of defect as the
 * displaced `@ReactMethod` that took `IncrementalStitcher.start` off the
 * bridge. A capability you cannot provide is reported as absent, never as a
 * stub.
 *
 * Returns null on a binary that predates the constant.
 */
export function nativeDocumentDirectory(): string | null {
  // Both spellings, for the same reason `panoPlusNative.ts` accepts both:
  // this package and its hosts do not release atomically.
  const mods = NativeModules as Record<string, unknown>;
  for (const name of ['RNSSweepSession', 'RNISPanoPlus']) {
    const m = mods[name] as
      | { documentDirectory?: unknown; getConstants?: () => unknown }
      | undefined;
    if (m == null) continue;
    // ⚠ TWO READS, AND THE SECOND ONE IS NOT BELT-AND-BRACES.
    // On the old architecture a module's constants are merged onto the JS
    // object, so `m.documentDirectory` is the natural read. Under bridgeless
    // the module arrives through the legacy interop layer, which exposes
    // them only behind `getConstants()` — the property read comes back
    // `undefined` on a binary that definitely exports the constant.
    // MEASURED on a Galaxy A35 running the New Architecture: the string is
    // in classes2.dex, the module resolves, and the direct read is still
    // undefined. Supporting one spelling would have meant supporting one
    // architecture, silently, with a null that reads like "old binary".
    const direct = m.documentDirectory;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    if (typeof m.getConstants === 'function') {
      let consts: unknown;
      try {
        consts = m.getConstants();
      } catch {
        // A module that throws from getConstants has nothing to tell us;
        // keep looking rather than taking the whole surface down.
        continue;
      }
      const viaConsts = (consts as { documentDirectory?: unknown } | null)
        ?.documentDirectory;
      if (typeof viaConsts === 'string' && viaConsts.length > 0) {
        return viaConsts;
      }
    }
  }
  return null;
}

/**
 * Lazy-resolve `expo-file-system/legacy`. Returns the module when the host
 * has it native-linked, else null. Never throws.
 *
 * ⚠ A NULL RETURN NO LONGER MEANS A SWEEP CANNOT RUN. It did once, and that
 * was a bug that reached a device: the surface gated on
 * `fs?.documentDirectory`, so a host without Expo — including this repo's own
 * example app — was told "pano+ is not available", which reads as a claim
 * about the BUILD and sent the reader to the native side. The build was fine.
 * The package had a hidden dependency on Expo that nothing declared.
 *
 * The base directory now comes from {@link nativeDocumentDirectory} when this
 * returns null. Hosts that DO have `expo-file-system` keep using it, so they
 * keep writing to precisely the directory they always did; what they gain is
 * the verdict sidecar, which is the only thing the full interface is used for
 * and which degrades to a warning when it is absent.
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
