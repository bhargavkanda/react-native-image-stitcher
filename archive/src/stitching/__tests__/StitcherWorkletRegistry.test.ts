// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the v0.8.0 Phase 4a `StitcherWorkletRegistry` singleton.
 *
 * The registry is the JS-side staging area for host worklets — the
 * Phase 4b native handoff will read from it to fan out invocations on
 * the AR runtime.  These tests pin the invariants the native handoff
 * is going to rely on:
 *
 *   - Stable, unique IDs out of `register`.
 *   - Registration order preserved within the host-entry partition.
 *   - First-party entries always sort to the front of `getEntries`.
 *   - `unregister` is a no-op for unknown IDs (no throw — the native
 *     handoff may race a JS-side unregister with a frame in flight).
 *   - `getEntries` returns a snapshot — mutating the returned array
 *     can't corrupt registry state.
 *   - `_resetForTests` returns the registry to a pristine state
 *     (used by these tests; documented as test-only in the source).
 */

import { StitcherWorkletRegistry } from '../StitcherWorkletRegistry';
import type { StitcherFrameProcessor } from '../StitcherFrame';

// Fresh no-op worklet stubs.  These are NOT real worklets — they have
// no `'worklet'` directive — but the registry doesn't care about
// invocation, only about identity + ordering.
const makeWorklet = (label: string): StitcherFrameProcessor => {
  const fn = (_frame: unknown) => {
    void label;
  };
  return fn as unknown as StitcherFrameProcessor;
};

describe('StitcherWorkletRegistry', () => {
  beforeEach(() => {
    StitcherWorkletRegistry._resetForTests();
  });

  describe('register', () => {
    it('returns a non-empty string ID', () => {
      const id = StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('issues distinct IDs across calls', () => {
      const id1 = StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      const id2 = StitcherWorkletRegistry.register({ worklet: makeWorklet('b') });
      expect(id1).not.toBe(id2);
    });

    it('issues distinct IDs even for the same worklet identity', () => {
      // Hosts that re-render and re-register without unregistering get
      // a fresh slot — the hook itself handles cleanup via deps, but
      // the registry treats each `register` as independent.
      const w = makeWorklet('shared');
      const id1 = StitcherWorkletRegistry.register({ worklet: w });
      const id2 = StitcherWorkletRegistry.register({ worklet: w });
      expect(id1).not.toBe(id2);
      expect(StitcherWorkletRegistry.count).toBe(2);
    });

    it('host entries default to isFirstParty=false', () => {
      StitcherWorkletRegistry.register({ worklet: makeWorklet('host') });
      const [entry] = StitcherWorkletRegistry.getEntries();
      expect(entry.isFirstParty).toBe(false);
    });

    it('first-party flag passes through to the entry', () => {
      StitcherWorkletRegistry.register({
        worklet: makeWorklet('fp'),
        isFirstParty: true,
      });
      const [entry] = StitcherWorkletRegistry.getEntries();
      expect(entry.isFirstParty).toBe(true);
    });
  });

  describe('getEntries ordering', () => {
    it('preserves host registration order when no first-party entries', () => {
      const wa = makeWorklet('a');
      const wb = makeWorklet('b');
      const wc = makeWorklet('c');
      StitcherWorkletRegistry.register({ worklet: wa });
      StitcherWorkletRegistry.register({ worklet: wb });
      StitcherWorkletRegistry.register({ worklet: wc });
      const entries = StitcherWorkletRegistry.getEntries();
      expect(entries.map((e) => e.worklet)).toEqual([wa, wb, wc]);
    });

    it('sorts first-party entries before host entries regardless of registration order', () => {
      const host1 = makeWorklet('host1');
      const fp1 = makeWorklet('fp1');
      const host2 = makeWorklet('host2');
      const fp2 = makeWorklet('fp2');
      // Interleave registrations.
      StitcherWorkletRegistry.register({ worklet: host1 });
      StitcherWorkletRegistry.register({ worklet: fp1, isFirstParty: true });
      StitcherWorkletRegistry.register({ worklet: host2 });
      StitcherWorkletRegistry.register({ worklet: fp2, isFirstParty: true });
      const entries = StitcherWorkletRegistry.getEntries();
      // First-party block first (in registration order),
      // then host block (in registration order).
      expect(entries.map((e) => e.worklet)).toEqual([fp1, fp2, host1, host2]);
    });

    it('returns a snapshot — mutating the returned array does not affect the registry', () => {
      StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      const entries = StitcherWorkletRegistry.getEntries();
      // Cast away readonly so we can attempt a mutation.
      (entries as unknown as unknown[]).push({} as never);
      // Registry's own count is unchanged.
      expect(StitcherWorkletRegistry.count).toBe(1);
      expect(StitcherWorkletRegistry.getEntries()).toHaveLength(1);
    });
  });

  describe('unregister', () => {
    it('removes a previously-registered entry by ID', () => {
      const id = StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      expect(StitcherWorkletRegistry.count).toBe(1);
      StitcherWorkletRegistry.unregister(id);
      expect(StitcherWorkletRegistry.count).toBe(0);
    });

    it('is a no-op for an unknown ID (no throw)', () => {
      StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      expect(() => StitcherWorkletRegistry.unregister('host-9999')).not.toThrow();
      expect(StitcherWorkletRegistry.count).toBe(1);
    });

    it('removes the right entry when multiple are registered', () => {
      const id1 = StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      const id2 = StitcherWorkletRegistry.register({ worklet: makeWorklet('b') });
      const id3 = StitcherWorkletRegistry.register({ worklet: makeWorklet('c') });
      StitcherWorkletRegistry.unregister(id2);
      const remainingIds = StitcherWorkletRegistry.getEntries().map((e) => e.id);
      expect(remainingIds).toEqual([id1, id3]);
    });

    it('survives double-unregister of the same ID', () => {
      const id = StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      StitcherWorkletRegistry.unregister(id);
      expect(() => StitcherWorkletRegistry.unregister(id)).not.toThrow();
      expect(StitcherWorkletRegistry.count).toBe(0);
    });
  });

  describe('count', () => {
    it('starts at 0 after reset', () => {
      expect(StitcherWorkletRegistry.count).toBe(0);
    });

    it('reflects register/unregister deltas', () => {
      expect(StitcherWorkletRegistry.count).toBe(0);
      const id1 = StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      expect(StitcherWorkletRegistry.count).toBe(1);
      StitcherWorkletRegistry.register({ worklet: makeWorklet('b') });
      expect(StitcherWorkletRegistry.count).toBe(2);
      StitcherWorkletRegistry.unregister(id1);
      expect(StitcherWorkletRegistry.count).toBe(1);
    });
  });

  describe('_resetForTests', () => {
    it('clears all entries', () => {
      StitcherWorkletRegistry.register({ worklet: makeWorklet('a') });
      StitcherWorkletRegistry.register({ worklet: makeWorklet('b'), isFirstParty: true });
      StitcherWorkletRegistry.register({ worklet: makeWorklet('c') });
      expect(StitcherWorkletRegistry.count).toBe(3);
      StitcherWorkletRegistry._resetForTests();
      expect(StitcherWorkletRegistry.count).toBe(0);
      expect(StitcherWorkletRegistry.getEntries()).toEqual([]);
    });
  });
});
