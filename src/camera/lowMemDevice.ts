// SPDX-License-Identifier: Apache-2.0
/**
 * lowMemDevice — shared helpers around the iOS BatchStitcher
 * `physicalMemoryBytes` constant.
 *
 * Two consumers (Camera.tsx's `useState` initialiser + the modal's
 * device-mem debug line) had near-identical implementations of the
 * same "read physical memory from NativeModules, classify as
 * low-mem" logic.  The F10 Phase 2 review (N2) flagged this as a
 * drift hazard — exactly the kind of subtle duplication that audit
 * fix F1 chased on the native side.
 *
 * Layered for testability:
 *
 *   - `isBelowMemThreshold(bytes)` is pure (in: number, out:
 *     boolean) — unit-testable.
 *   - `getPhysicalMemoryBytes()` reads the RN bridge module — must
 *     run on a real device.
 *   - `isLowMemDevice()` composes the two for the common case.
 *
 * The 2 GB threshold corresponds to iPhone X / 8 Plus / iPhone 6s
 * era devices; below that, multiband blend + graphcut seam-finder
 * peak memory risks the jetsam threshold mid-stitch.  Static value
 * (no runtime config); revisit if the SDK ever targets a wider
 * device range.
 */
import { NativeModules } from 'react-native';


/** 2 GB in bytes — the cutoff below which `<Camera>` falls back
 *  to the feather+skip blender/seam combo for safer peak memory. */
export const LOW_MEM_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;


/**
 * Pure classifier.  Returns `true` when `bytes` is a positive
 * number strictly below the threshold.  Zero / NaN / undefined-shaped
 * inputs return `false` — the safe choice when the native bridge
 * hasn't surfaced the value (assume the device has enough memory
 * for the higher-quality combo; the operator can still flip
 * blender / seamFinder in the modal).
 */
export function isBelowMemThreshold(bytes: number): boolean {
  return Number.isFinite(bytes)
    && bytes > 0
    && bytes < LOW_MEM_THRESHOLD_BYTES;
}


/**
 * Read the device's physical memory from the native bridge.
 * Returns 0 when the bridge isn't loaded or the constant is missing
 * — caller should treat 0 as "unknown".
 */
export function getPhysicalMemoryBytes(): number {
  const m = (NativeModules as Record<string, unknown>).BatchStitcher;
  const bytes =
    m && typeof m === 'object'
      ? (m as { physicalMemoryBytes?: number }).physicalMemoryBytes
      : undefined;
  return typeof bytes === 'number' ? bytes : 0;
}


/**
 * Composed `getPhysicalMemoryBytes()` + `isBelowMemThreshold()`.
 * Convenience for the common consumer pattern.
 */
export function isLowMemDevice(): boolean {
  return isBelowMemThreshold(getPhysicalMemoryBytes());
}
