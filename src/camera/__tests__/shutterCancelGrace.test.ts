// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `_decidePressOutForTests` — the shutter's
 * "commit this press-out, or wait for the gesture to come back?"
 * decision (v0.25 `cancelGraceMs`).
 *
 * WHY THIS EXISTS
 *
 * React Native's `Pressable` folds two different events into a single
 * `onPressOut`: the user lifting their finger, and the system
 * TERMINATING the touch (interface rotation, an ancestor scrollable
 * claiming the drag, a Modal mounting, or the Pressable being
 * remounted by a re-render — and this button's own visuals change the
 * instant a hold begins).  Treating a termination as a release ends
 * the panorama and finalizes whatever was captured; for a capture that
 * had just started that is ONE keyframe.  That is the shape of the
 * v0.24.x field reports: capture self-ends in under a second, the user
 * gets frame #1 as the "panorama", landscape only.
 *
 * As with `_computeDriftStateForTests`, the decision lives in a pure
 * function so jest can exercise it without a React renderer — this
 * package's jest config is `testEnvironment: 'node'` with no RN preset.
 */

jest.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  StyleSheet: { create: (s: unknown) => s },
}));

// eslint-disable-next-line import/first
import { _decidePressOutForTests as decide } from '../CameraShutter';

describe('_decidePressOutForTests', () => {
  describe('default (cancelGraceMs = 0) — byte-identical to pre-v0.25', () => {
    it('a clean release while holding ends the hold', () => {
      expect(decide(true, false, 0)).toEqual({
        action: 'commit-hold-end',
        deferMs: 0,
      });
    });

    it('a CANCELLED touch while holding still ends the hold', () => {
      // This is the pre-v0.25 behaviour, and the bug.  It stays the
      // default deliberately: the flag exists so the fix can be
      // validated on a device that reproduces the failure before it
      // becomes the default for everyone.
      expect(decide(true, true, 0)).toEqual({
        action: 'commit-hold-end',
        deferMs: 0,
      });
    });

    it('a clean release before the threshold is a tap', () => {
      expect(decide(false, false, 0)).toEqual({ action: 'tap', deferMs: 0 });
    });
  });

  describe('with a grace window', () => {
    it('THE FIELD BUG: a cancelled hold is deferred, not committed', () => {
      expect(decide(true, true, 400)).toEqual({
        action: 'defer-hold-end',
        deferMs: 400,
      });
    });

    it('a genuine release is NEVER delayed, however large the window', () => {
      // The single most important property: turning this flag on must
      // not add latency to the normal path.  A user lifting their
      // finger expects the capture to finalize immediately.
      expect(decide(true, false, 5000)).toEqual({
        action: 'commit-hold-end',
        deferMs: 0,
      });
    });

    it('propagates the configured window verbatim', () => {
      for (const ms of [1, 250, 400, 1000]) {
        expect(decide(true, true, ms)).toEqual({
          action: 'defer-hold-end',
          deferMs: ms,
        });
      }
    });

    it('a negative or zero window never defers', () => {
      expect(decide(true, true, 0).action).toBe('commit-hold-end');
      expect(decide(true, true, -1).action).toBe('commit-hold-end');
    });
  });

  describe('sub-threshold presses', () => {
    it('a CANCELLED sub-threshold press does nothing — it is not a tap', () => {
      // Firing a photo because the system stole the gesture is worse
      // than ignoring it: the user never completed a press, and the
      // photo lands in their capture history unasked for.
      expect(decide(false, true, 0)).toEqual({ action: 'none', deferMs: 0 });
      expect(decide(false, true, 400)).toEqual({ action: 'none', deferMs: 0 });
    });

    it('a clean sub-threshold press is a tap regardless of the window', () => {
      expect(decide(false, false, 400)).toEqual({ action: 'tap', deferMs: 0 });
    });
  });

  describe('exhaustive matrix', () => {
    it('never returns defer without a positive window', () => {
      for (const wasHolding of [true, false]) {
        for (const cancelled of [true, false]) {
          const r = decide(wasHolding, cancelled, 0);
          expect(r.action).not.toBe('defer-hold-end');
          expect(r.deferMs).toBe(0);
        }
      }
    });

    it('only ever defers for a cancelled HOLD', () => {
      for (const wasHolding of [true, false]) {
        for (const cancelled of [true, false]) {
          const r = decide(wasHolding, cancelled, 400);
          if (r.action === 'defer-hold-end') {
            expect(wasHolding).toBe(true);
            expect(cancelled).toBe(true);
          }
        }
      }
    });
  });
});
