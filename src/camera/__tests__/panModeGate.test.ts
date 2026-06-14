// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `shouldGateForPanMode` + `gateTargetOrientation` — the pure
 * predicates behind the rotate gate (guidance item 1).  `shouldGate` true ⇒
 * the host blocks capture-start and shows the rotate prompt.
 *
 *   - `'vertical'`   gates a PORTRAIT hold (needs landscape).
 *   - `'horizontal'` gates a LANDSCAPE hold (needs portrait).
 *   - `'both'`       never gates.
 *
 * Pure-TS test per jest.config.js — `panModeGate.ts` only imports the
 * `DeviceOrientation` *type* (erased at compile time), so it has no runtime
 * react-native-sensors dependency and needs no module stubbing.
 */

import {
  shouldGateForPanMode,
  gateTargetOrientation,
  type PanMode,
} from '../panModeGate';
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
  describe("mode 'vertical' (landscape-only)", () => {
    it.each(PORTRAIT_ORIENTATIONS)(
      'GATES (shows rotate-to-landscape) in portrait hold: %s',
      (orientation) => {
        expect(shouldGateForPanMode('vertical', orientation)).toBe(true);
      },
    );
    it.each(LANDSCAPE_ORIENTATIONS)(
      'does NOT gate in landscape hold: %s',
      (orientation) => {
        expect(shouldGateForPanMode('vertical', orientation)).toBe(false);
      },
    );
  });

  describe("mode 'horizontal' (portrait-only)", () => {
    it.each(LANDSCAPE_ORIENTATIONS)(
      'GATES (shows rotate-to-portrait) in landscape hold: %s',
      (orientation) => {
        expect(shouldGateForPanMode('horizontal', orientation)).toBe(true);
      },
    );
    it.each(PORTRAIT_ORIENTATIONS)(
      'does NOT gate in portrait hold: %s',
      (orientation) => {
        expect(shouldGateForPanMode('horizontal', orientation)).toBe(false);
      },
    );
  });

  describe("mode 'both'", () => {
    it.each(ALL_ORIENTATIONS)(
      'never gates — any orientation is acceptable: %s',
      (orientation) => {
        expect(shouldGateForPanMode('both', orientation)).toBe(false);
      },
    );
  });

  it('full table: vertical⇔portrait, horizontal⇔landscape, both⇔never', () => {
    const modes: PanMode[] = ['vertical', 'horizontal', 'both'];
    for (const mode of modes) {
      for (const orientation of ALL_ORIENTATIONS) {
        const isPortrait =
          orientation === 'portrait'
          || orientation === 'portrait-upside-down';
        const expected =
          mode === 'vertical'
            ? isPortrait
            : mode === 'horizontal'
              ? !isPortrait
              : false;
        expect(shouldGateForPanMode(mode, orientation)).toBe(expected);
      }
    }
  });
});

describe('gateTargetOrientation', () => {
  it("'vertical' → 'landscape'", () => {
    expect(gateTargetOrientation('vertical')).toBe('landscape');
  });
  it("'horizontal' → 'portrait'", () => {
    expect(gateTargetOrientation('horizontal')).toBe('portrait');
  });
  it("'both' → null (never gates)", () => {
    expect(gateTargetOrientation('both')).toBeNull();
  });
});
