// SPDX-License-Identifier: Apache-2.0
/**
 * sweepMemoryReader — the per-call probe for the memory read the sweep's
 * timeline samples (`readSweepMemoryMB` in `panoPlusNative`).
 *
 * ⚠ NOT RE-EXPORTED FROM THE PACKAGE ROOT, DELIBERATELY. `panoPlusNative` is
 * (`export *` in `src/index.ts`), so anything it exports is public API for
 * good. The read and the label of what it measures are public, beside the
 * other sweep bridge calls; which method answered is the recorder's own
 * business, so the probe lives here, where only the engine hook and
 * `panoPlusNative` import it.
 *
 * Resolution is per-CALL, not per-import, like every probe in `panoPlusNative`:
 * a test that assigns `NativeModules.IncrementalStitcher` after import behaves
 * like a real registry.
 */
import { NativeModules } from 'react-native';

/** The module and method the sweep's memory samples come from. */
const MEMORY_MODULE_NAME = 'IncrementalStitcher';

/** The memory method, when this binary links it; null otherwise. */
export function memoryReaderOf(): { getMemoryFootprintMB: () => Promise<unknown> } | null {
  const m = (NativeModules as Record<string, unknown>)[MEMORY_MODULE_NAME] as
    | { getMemoryFootprintMB?: unknown }
    | undefined;
  return m != null && typeof m.getMemoryFootprintMB === 'function'
    ? (m as { getMemoryFootprintMB: () => Promise<unknown> })
    : null;
}

/**
 * THE READER THIS BINARY CARRIES, by name, or null.
 *
 * ⚠ ITS OWN PROBE, NOT `getIncrementalNativeModule`. That resolver answers
 * null unless EVERY method the keyframe engine needs is linked, so an
 * unrelated missing method would read here as "no memory reader". One method
 * is asked for, and only its presence is tested.
 */
export function sweepMemoryReader(): string | null {
  return memoryReaderOf() == null ? null : `${MEMORY_MODULE_NAME}.getMemoryFootprintMB`;
}
