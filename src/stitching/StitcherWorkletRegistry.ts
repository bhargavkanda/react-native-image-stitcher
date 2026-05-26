// SPDX-License-Identifier: Apache-2.0

import type { StitcherFrameProcessor } from './StitcherFrame';

/**
 * v0.8.0 Phase 4a — process-scope registry of host-supplied worklets
 * that the v0.8.0 `useFrameProcessor` hook registers into.
 *
 * ## What this is (Phase 4a)
 *
 * A plain JS singleton holding an ordered list of registered
 * worklets.  Hosts mount the `useFrameProcessor` hook (in this
 * directory); the hook registers its worklet into this singleton
 * on mount and unregisters on unmount.  Each entry carries:
 *
 *   - `id`: stable identifier issued by `register`; passed to
 *     `unregister`.
 *   - `worklet`: the host's `StitcherFrameProcessor` function.
 *     MUST be `'worklet'`-prefixed at the call site (TS can't
 *     enforce that — convention).
 *   - `isFirstParty`: `false` for host-supplied worklets;
 *     reserved for the lib's own first-party stitching path which
 *     today is wired natively (not through this registry).
 *
 * Order is stable: first-party entries (none in Phase 4a) come
 * first, then host entries by registration order.  Re-registration
 * of the same worklet by identity yields a new entry — hosts that
 * re-render and call `register` again ARE responsible for calling
 * `unregister` first.  The `useFrameProcessor` hook handles this
 * via its `deps` dependency array.
 *
 * ## What this is NOT (Phase 4b)
 *
 * **The native AR worklet runtime does NOT yet read this registry.**
 * Worklets registered here for AR-mode captures will not fire
 * until Phase 4b lands the cross-runtime handoff (a
 * worklets-core `SharedValue` mirror that `RNSARWorkletRuntime`
 * reads on each `dispatchFrame:pose:` call; the runtime then
 * constructs a `StitcherFrameHostObject` + invokes each
 * registered worklet via `RNWorklet::WorkletInvoker::call`).
 *
 * In non-AR mode the host-supplied worklet IS invoked, but via
 * vision-camera's Frame Processor runtime directly (the
 * `useFrameProcessor` hook returns vc's processor object which
 * `<Camera>` passes to vision-camera).  So Phase 4a's public API
 * is fully functional for non-AR; AR is API-stable but
 * runtime-deferred.
 *
 * ## Singleton lifetime
 *
 * The registry is a module-level instance.  It lives for the
 * lifetime of the JS runtime (= until app reload).  Entries
 * accumulate only via `register` and shed only via `unregister`
 * — no GC / weak-ref logic.  Hosts that mount `useFrameProcessor`
 * inside React components MUST rely on the hook's effect cleanup
 * to unregister on unmount, or they'll leak entries until
 * reload.  The hook handles this correctly today.
 *
 * ## Why a singleton (vs context provider)
 *
 * The native AR worklet runtime is itself a process-scope
 * singleton (`RNSARWorkletRuntime`, `StitcherWorkletRuntime`).
 * The Phase 4b handoff between TS and native is necessarily
 * process-scope.  Wrapping the registry in a React context
 * would force every consumer to be in the same provider tree
 * which is friction for layer-2 hosts that compose
 * `<ARCameraView>` / `useIncrementalStitcher` themselves.  The
 * singleton is the right shape; the React-level ergonomics are
 * provided by the `useFrameProcessor` hook.
 */
export interface StitcherWorkletEntry {
  readonly id: string;
  readonly worklet: StitcherFrameProcessor;
  readonly isFirstParty: boolean;
}

class Registry {
  private entries: StitcherWorkletEntry[] = [];
  private nextHostCounter = 0;

  /**
   * Register a worklet.  Returns a stable ID for `unregister`.
   *
   * Entries are appended in registration order; first-party
   * entries (if any are added in future) sort to the front.
   */
  register(opts: {
    worklet: StitcherFrameProcessor;
    isFirstParty?: boolean;
  }): string {
    const isFirstParty = opts.isFirstParty ?? false;
    const id = isFirstParty
      ? `fp-${this.nextHostCounter++}`
      : `host-${this.nextHostCounter++}`;
    const entry: StitcherWorkletEntry = {
      id,
      worklet: opts.worklet,
      isFirstParty,
    };
    this.entries.push(entry);
    // Re-sort so first-party always runs before host entries.
    // Stable sort: registration order is preserved within each
    // partition.  Single-pass O(n log n) is fine — registration
    // is rare (per-`<Camera>`-mount, not per-frame).
    this.entries.sort((a, b) => {
      if (a.isFirstParty !== b.isFirstParty) {
        return a.isFirstParty ? -1 : 1;
      }
      return 0;
    });
    return id;
  }

  /**
   * Remove a previously-registered worklet by ID.  No-op if the ID
   * isn't found.  Hosts call this in their effect's cleanup.
   */
  unregister(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /**
   * Snapshot the current entries.  Returned array is a copy —
   * mutations don't affect the registry.  Phase 4b's native
   * handoff will read a `SharedValue` mirror of this list so the
   * AR runtime doesn't need a JS-thread hop on the hot per-frame
   * path; for Phase 4a this method is the JS-side accessor.
   */
  getEntries(): readonly StitcherWorkletEntry[] {
    return [...this.entries];
  }

  /**
   * Total number of registered worklets (first-party + host).
   * Useful for diagnostics + tests.
   */
  get count(): number {
    return this.entries.length;
  }

  /**
   * Test-only — clear all entries.  NOT exported from
   * `src/index.ts`.  Used in unit tests to reset state between
   * cases.
   */
  _resetForTests(): void {
    this.entries = [];
    this.nextHostCounter = 0;
  }
}

/**
 * Process-scope singleton.  Imported by `useFrameProcessor` (in
 * this directory) + by the Phase 4b native-handoff code (TBD).
 */
export const StitcherWorkletRegistry = new Registry();
