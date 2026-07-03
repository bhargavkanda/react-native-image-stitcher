// SPDX-License-Identifier: Apache-2.0
/**
 * arOverlayLifecycle — pure decision helpers for ARCameraView's declarative
 * `overlays` prop lifecycle.
 *
 * The native JS-overlay collection (`RNSARSession.setOverlays`) is a
 * PROCESS-WIDE singleton: it outlives any single `ARCameraView` instance AND
 * AR-session restarts. So a component that drives it declaratively must clean
 * up after itself, or its last set of shapes leaks into whatever AR view
 * mounts next (observed: digital-twin detection quads persisting into an
 * unrelated photo-mode view after a mode swap).
 *
 * Two decisions govern that cleanup; both are pure so they unit-test in the
 * library's node-env jest without mounting the component (matching the repo's
 * "logic in pure functions, components typecheck-only" convention):
 *
 *   - {@link resolveOverlayPush}    — every render with the `overlays` prop.
 *   - {@link resolveOverlayUnmount} — the component's unmount cleanup.
 *
 * The `hasDriven` bit (held by the component in a ref) is the ownership token:
 * an instance that never drove declaratively (imperative-only host) NEVER
 * clears the singleton, so it keeps full control across remounts.
 */

import type { AROverlay } from '../stitching/AROverlay';

export interface OverlayPushDecision {
  /** Overlays to dispatch to the native collection; `null` = don't touch it. */
  dispatch: AROverlay[] | null;
  /** Whether this instance now owns the declarative collection (next
   *  `hasDriven`). */
  hasDriven: boolean;
}

/**
 * Decide the native dispatch for one declarative-`overlays` render.
 *
 *   - array present            → push it wholesale, take ownership.
 *   - `null`/undefined & drove  → clear ONCE, release ownership (closes the
 *                                 array→undefined mid-life stale-overlay hole).
 *   - `null`/undefined & never  → don't touch (imperative-only host keeps it).
 */
export function resolveOverlayPush(
  overlays: readonly AROverlay[] | null | undefined,
  hasDriven: boolean,
): OverlayPushDecision {
  if (overlays == null) {
    return hasDriven
      ? { dispatch: [], hasDriven: false }
      : { dispatch: null, hasDriven: false };
  }
  return { dispatch: [...overlays], hasDriven: true };
}

/**
 * Decide the unmount clear: clear the singleton to `[]` iff this instance
 * drove it declaratively; otherwise leave it untouched.
 */
export function resolveOverlayUnmount(
  hasDriven: boolean,
): AROverlay[] | null {
  return hasDriven ? [] : null;
}
