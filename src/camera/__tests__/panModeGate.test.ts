// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `shouldGateForPanMode` — the pure predicate behind the
 * rotate-to-landscape gate (guidance item 1).  True ⇒ the host blocks
 * capture-start and shows the rotate prompt.
 *
 * The gate fires only for `'mode-a'` (landscape-only) + a portrait hold.
 * In `'both'` mode the gate never fires; in `'mode-a'` both landscape
 * holds pass.  The table below exercises all 4 orientations × both modes.
 *
 * Pure-TS test per jest.config.js — `panModeGate.ts` only imports the
 * `DeviceOrientation` *type* (erased at compile time), so it has no runtime
 * react-native-sensors dependency and needs no module stubbing.
 */

import { shouldGateForPanMode } from '../panModeGate';
import type { DeviceOrientation } from '../useDeviceOrientation';

const ALL_ORIENTATIONS: DeviceOrientation[] = [
  'portrait',
  'portrait-upside-down',
  'landscape-left',
  'landscape-right',
];

const PORTRAIT_ORIENTATIONS: DeviceOrientation[] = [
  'portrait',
  'portrait-upside-down',
];

const LANDSCAPE_ORIENTATIONS: DeviceOrientation[] = [
  'landscape-left',
  'landscape-right',
];

describe('shouldGateForPanMode', () => {
  describe("mode 'mode-a' (landscape-only)", () => {
    it.each(PORTRAIT_ORIENTATIONS)(
      'GATES (shows rotate prompt) in portrait hold: %s',
      (orientation) => {
        expect(shouldGateForPanMode('mode-a', orientation)).toBe(true);
      },
    );

    it.each(LANDSCAPE_ORIENTATIONS)(
      'does NOT gate in landscape hold: %s',
      (orientation) => {
        expect(shouldGateForPanMode('mode-a', orientation)).toBe(false);
      },
    );
  });

  describe("mode 'both' (landscape or portrait)", () => {
    it.each(ALL_ORIENTATIONS)(
      'never gates — any orientation is acceptable: %s',
      (orientation) => {
        expect(shouldGateForPanMode('both', orientation)).toBe(false);
      },
    );
  });

  it('full table: gate ⇔ (mode-a AND portrait)', () => {
    const modes = ['mode-a', 'both'] as const;
    for (const mode of modes) {
      for (const orientation of ALL_ORIENTATIONS) {
        const isPortrait =
          orientation === 'portrait'
          || orientation === 'portrait-upside-down';
        const expected = mode === 'mode-a' && isPortrait;
        expect(shouldGateForPanMode(mode, orientation)).toBe(expected);
      }
    }
  });
});
