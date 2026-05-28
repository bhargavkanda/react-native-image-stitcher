// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `useOrientationDrift` — exercises the pure
 * state-transition function `_computeDriftStateForTests` directly.
 *
 * Why not test the hook end-to-end via render: the lib's jest
 * config is `preset: 'ts-jest'` + `testEnvironment: 'node'` — no
 * React Native preset, no `@testing-library/react-native`.  See the
 * jest.config.js header comment: "If we ever add component-render
 * tests we'd flip to the RN preset then."  The component-render
 * tests for `<OrientationDriftModal>`, `<PanoramaBandOverlay>`,
 * `<ViewportCropOverlay>`, and `<Camera>` composition (all called
 * out in the v0.12 plan) will all need that flip.  Setting it up
 * is grouped in Phase 5 of the plan (Tests) rather than scattered
 * across each PR.  For PR-1, the pure state-transition function
 * carries the full behavioural contract — same approach
 * `useThrottledFrameProcessor.test.ts` uses for its throttle gate.
 *
 * The 5 cases below cover the full state machine per the plan
 * (lines 119, 277):
 *
 *   (a) no change → not drifted
 *   (b) orientation changes during active=true → drifted
 *   (c) drift state survives further changes (latching)
 *   (d) inactive → captureOrientation undefined
 *   (e) active resets snapshot (false → true → false → true cycle)
 */

// Mock `react-native-sensors` BEFORE importing the SUT.  The hook
// itself transitively pulls in `useDeviceOrientation` which imports
// `accelerometer` from `react-native-sensors` — an ES module that
// jest can't parse without the RN preset (which jest.config.js
// intentionally avoids; see config header comment).  We're only
// testing the pure transition function below, but TS imports are
// transitive so we still need to silence the chain.
jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: 'accelerometer' },
}));

// eslint-disable-next-line import/first
import { _computeDriftStateForTests } from '../useOrientationDrift';

const INITIAL = { captureOrientation: undefined, drifted: false };

describe('_computeDriftStateForTests (useOrientationDrift core logic)', () => {
  describe('(a) no change → not drifted', () => {
    it('stays in initial state when active is false from the start', () => {
      const next = _computeDriftStateForTests(INITIAL, false, 'portrait');
      expect(next).toEqual({ captureOrientation: undefined, drifted: false });
    });

    it('snapshots orientation when active flips true, drifted starts false', () => {
      const next = _computeDriftStateForTests(INITIAL, true, 'portrait');
      expect(next).toEqual({ captureOrientation: 'portrait', drifted: false });
    });

    it('stays clean when active=true and orientation does not change', () => {
      const after1 = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const after2 = _computeDriftStateForTests(after1, true, 'portrait');
      const after3 = _computeDriftStateForTests(after2, true, 'portrait');
      expect(after3).toEqual({ captureOrientation: 'portrait', drifted: false });
      // Reference equality: once steady, returns the prev ref so
      // React's setState becomes a no-op (no re-render).
      expect(after2).toBe(after1);
      expect(after3).toBe(after2);
    });
  });

  describe('(b) orientation changes during active=true → drifted', () => {
    it('latches drifted=true when orientation changes mid-active', () => {
      const after1 = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const after2 = _computeDriftStateForTests(after1, true, 'landscape-left');
      expect(after2).toEqual({ captureOrientation: 'portrait', drifted: true });
    });

    it('captures the ORIGINAL orientation in captureOrientation, not the new one', () => {
      const after1 = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const after2 = _computeDriftStateForTests(after1, true, 'landscape-right');
      // captureOrientation MUST remain the snapshot (portrait), not
      // the current rotation — that's how the drift modal copy
      // ("captured in PORTRAIT, now LANDSCAPE-RIGHT") works.
      expect(after2.captureOrientation).toBe('portrait');
    });

    it('detects drift to any of the 3 other orientations', () => {
      const cases: Array<['portrait', 'portrait-upside-down' | 'landscape-left' | 'landscape-right']> = [
        ['portrait', 'portrait-upside-down'],
        ['portrait', 'landscape-left'],
        ['portrait', 'landscape-right'],
      ];
      for (const [captured, drifted] of cases) {
        const after1 = _computeDriftStateForTests(INITIAL, true, captured);
        const after2 = _computeDriftStateForTests(after1, true, drifted);
        expect(after2.drifted).toBe(true);
      }
    });
  });

  describe('(c) drift state survives further changes (latching)', () => {
    it('stays drifted even if the user rotates back to the captured orientation', () => {
      // User rotates portrait → landscape (drift triggers) → portrait
      // (back to original).  The flag MUST stay latched.  Rationale:
      // the engine docstring says cross-mode capture is "best-effort,
      // not supported" — a brief rotation pollutes the buffer even
      // if the user rotates back, so the safe action is decisive
      // abandonment regardless of post-detection orientation.
      const after1 = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const after2 = _computeDriftStateForTests(after1, true, 'landscape-left');
      const after3 = _computeDriftStateForTests(after2, true, 'portrait');
      expect(after3).toEqual({ captureOrientation: 'portrait', drifted: true });
    });

    it('stays drifted across multiple subsequent orientation changes', () => {
      const after1 = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const after2 = _computeDriftStateForTests(after1, true, 'landscape-left');
      const after3 = _computeDriftStateForTests(after2, true, 'landscape-right');
      const after4 = _computeDriftStateForTests(after3, true, 'portrait-upside-down');
      expect(after4.drifted).toBe(true);
      expect(after4.captureOrientation).toBe('portrait');
    });
  });

  describe('(d) inactive → captureOrientation undefined', () => {
    it('clears the snapshot when active flips back to false', () => {
      const after1 = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const after2 = _computeDriftStateForTests(after1, false, 'portrait');
      expect(after2).toEqual({ captureOrientation: undefined, drifted: false });
    });

    it('clears the drift flag when active flips back to false', () => {
      const after1 = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const after2 = _computeDriftStateForTests(after1, true, 'landscape-left');
      expect(after2.drifted).toBe(true);
      const after3 = _computeDriftStateForTests(after2, false, 'landscape-left');
      expect(after3).toEqual({ captureOrientation: undefined, drifted: false });
    });

    it('is idempotent — no state change when inactive and already clear', () => {
      const after1 = _computeDriftStateForTests(INITIAL, false, 'portrait');
      const after2 = _computeDriftStateForTests(after1, false, 'landscape-left');
      // Same ref → setState becomes a no-op.
      expect(after2).toBe(after1);
    });
  });

  describe('(e) active resets snapshot', () => {
    it('re-snapshots on a fresh active cycle (false → true → false → true)', () => {
      // Cycle 1: capture in portrait, drift.
      const c1a = _computeDriftStateForTests(INITIAL, true, 'portrait');
      const c1b = _computeDriftStateForTests(c1a, true, 'landscape-left');
      expect(c1b).toEqual({ captureOrientation: 'portrait', drifted: true });

      // Stop the capture.
      const cleared = _computeDriftStateForTests(c1b, false, 'landscape-left');
      expect(cleared).toEqual({ captureOrientation: undefined, drifted: false });

      // Cycle 2: re-capture, now in landscape-left.  Snapshot
      // should be landscape-left, NOT carry over the old portrait.
      const c2a = _computeDriftStateForTests(cleared, true, 'landscape-left');
      expect(c2a).toEqual({ captureOrientation: 'landscape-left', drifted: false });

      // And staying in landscape-left should not drift.
      const c2b = _computeDriftStateForTests(c2a, true, 'landscape-left');
      expect(c2b.drifted).toBe(false);
    });
  });
});
