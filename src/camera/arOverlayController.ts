// SPDX-License-Identifier: Apache-2.0

/**
 * v0.20.0 — shared JS→native plumbing for the AR overlay renderer.
 *
 * `<ARCameraView>` and `<Camera>` expose an IDENTICAL imperative overlay API
 * (`setOverlays` / `addOverlay` / `updateOverlay` / `removeOverlay` /
 * `clearOverlays`) plus a declarative `overlays` prop.  Rather than duplicate
 * the diff + native-dispatch logic in each component, both build their handle
 * from {@link createAROverlayController} — DRY, single source of truth for the
 * wire format and the merge-by-id semantics.
 *
 * ## Native mechanism (agreed cross-platform contract)
 *
 * Every AR-session setting in this SDK already flows through the
 * `RNSARSession` native-module singleton (`setPlaneDetection`,
 * `setArFrameMetaEnabled`, `setSceneReconstructionEnabled`) because
 * `RNSARSession.shared` drives the single mounted `RNSARCameraView`.  Overlays
 * follow the same pattern: a single `setOverlays(overlays)` method on
 * `RNSARSession` carries the FULL current JS-set overlay array each time it
 * changes.  Native replaces its JS-set overlay collection wholesale (the merge
 * with the namespaced native-plugin set happens on the native side) and the
 * overlay layer redraws every AR frame.
 *
 * The declarative `overlays` prop and the imperative methods both ultimately
 * call this same `setOverlays` with the resolved array, so the two APIs are
 * interchangeable and can't diverge.
 *
 * Why a module method (not a UIManager view command)?  It matches every other
 * AR setting in this codebase and there is only ever ONE `RNSARCameraView`
 * mounted (ARKit/ARCore can't share the camera), so there's nothing to key by
 * view tag.  The equivalent UIManager view-command name, for native sides that
 * prefer per-view dispatch, is documented as `RNSARCameraViewOverlays`.
 */

import { NativeModules } from 'react-native';

import type { AROverlay } from '../stitching/AROverlay';

/**
 * The imperative overlay methods exposed on both `<ARCameraView>` and
 * `<Camera>` refs.  Identical shape on both so a host can swap components
 * without rewriting overlay code.
 */
export interface AROverlayMethods {
  /** Replace the entire JS-set overlay collection. */
  setOverlays: (overlays: AROverlay[]) => void;
  /** Add one overlay (replaces any existing overlay with the same `id`). */
  addOverlay: (overlay: AROverlay) => void;
  /**
   * Shallow-merge a patch into the overlay with `id`.  No-op if no overlay
   * with that `id` is currently set.
   */
  updateOverlay: (id: string, patch: Partial<AROverlay>) => void;
  /** Remove the overlay with `id` (no-op if absent). */
  removeOverlay: (id: string) => void;
  /** Remove all JS-set overlays. */
  clearOverlays: () => void;
  /**
   * Raycast from the screen centre (the crosshair) to the first real-world
   * surface and resolve its world position `[x, y, z]` in metres (ARKit/ARCore
   * world frame), or `null` when nothing is hit (e.g. a featureless wall before
   * any plane is detected).  Use it to place an overlay ON the aimed surface at
   * the real distance — pass the result as a `worldPosition` to
   * {@link setOverlays} / {@link addOverlay} — instead of guessing a distance.
   * Resolves `null` (never throws) when the native module / method is absent.
   */
  raycast: () => Promise<[number, number, number] | null>;
}

interface RNSARSessionOverlayModule {
  // On iOS the native `setOverlays` is a Promise method (resolver/rejecter
  // RN-injected); on Android it's `void`.  We call it fire-and-forget but
  // type it as possibly-thenable so the defensive `.catch` below compiles.
  setOverlays?: (overlays: AROverlay[]) => void | Promise<unknown>;
  // Raycast resolves `{ worldPosition: [x,y,z] }` on a hit, or `null`.
  raycast?: () => Promise<{ worldPosition?: number[] } | null>;
}

/** The `RNSARSession` native-module method name overlays dispatch through. */
export const AR_OVERLAY_SET_METHOD = 'setOverlays' as const;

/**
 * The agreed UIManager view-command name for native sides that drive overlays
 * via per-view command dispatch instead of the module method.  The JS layer
 * dispatches through the module method (there's only one AR view), but the
 * name is pinned here so the native side can match if it chooses commands.
 */
export const AR_OVERLAY_VIEW_COMMAND = 'RNSARCameraViewOverlays' as const;

/**
 * Build an overlay controller backed by an in-memory ordered set keyed by
 * `id`.  Every mutating call resolves the new full array and pushes it to
 * native via `RNSARSession.setOverlays`.  The controller is the single source
 * of truth for BOTH the imperative ref methods and the declarative `overlays`
 * prop (the prop's effect calls `setOverlays` with the prop value).
 */
export function createAROverlayController(): AROverlayMethods & {
  /** Current JS-set overlays in insertion order (used by tests / diffing). */
  getOverlays: () => AROverlay[];
} {
  // Insertion-ordered map: preserves the order overlays were added so the
  // native render order is stable + predictable.
  const overlaysById = new Map<string, AROverlay>();

  const flush = (): void => {
    const native = (NativeModules as Record<string, unknown>)
      .RNSARSession as RNSARSessionOverlayModule | undefined;
    // Native module / method unavailable (web, or a native build predating the
    // overlay channel): no-op, no crash — mirrors the other AR setters.
    const ret = native?.setOverlays?.(Array.from(overlaysById.values()));
    // iOS returns a Promise (the native method is Promise-typed); swallow any
    // rejection so a transient native error never surfaces as an unhandled
    // rejection.  Android returns void — the optional chain skips the catch.
    (ret as Promise<unknown> | undefined)?.catch?.(() => undefined);
  };

  return {
    getOverlays: () => Array.from(overlaysById.values()),

    setOverlays: (overlays: AROverlay[]) => {
      overlaysById.clear();
      for (const o of overlays) {
        // Last-writer-wins on duplicate ids in the incoming array.
        overlaysById.set(o.id, o);
      }
      flush();
    },

    addOverlay: (overlay: AROverlay) => {
      // Re-set to move an existing id to the end? No — preserve original slot
      // by deleting first only when absent.  Map#set keeps the existing slot
      // when the key already exists, so a plain set is the right "replace in
      // place" behaviour.
      overlaysById.set(overlay.id, overlay);
      flush();
    },

    updateOverlay: (id: string, patch: Partial<AROverlay>) => {
      const existing = overlaysById.get(id);
      if (existing == null) {
        return;
      }
      // Shallow-merge; `id` is preserved from the existing overlay regardless
      // of what the patch carries (the map key must stay consistent).
      overlaysById.set(id, { ...existing, ...patch, id });
      flush();
    },

    removeOverlay: (id: string) => {
      if (overlaysById.delete(id)) {
        flush();
      }
    },

    clearOverlays: () => {
      if (overlaysById.size > 0) {
        overlaysById.clear();
        flush();
      }
    },

    raycast: async (): Promise<[number, number, number] | null> => {
      const native = (NativeModules as Record<string, unknown>)
        .RNSARSession as RNSARSessionOverlayModule | undefined;
      const fn = native?.raycast;
      // Native module / method unavailable (web, or a native build predating
      // the raycast channel): resolve null — the caller falls back.
      if (typeof fn !== 'function') {
        return null;
      }
      try {
        const res = await fn();
        const wp = res?.worldPosition;
        if (Array.isArray(wp) && wp.length >= 3) {
          return [Number(wp[0]), Number(wp[1]), Number(wp[2])];
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
