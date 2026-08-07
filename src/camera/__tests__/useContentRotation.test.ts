// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `contentRotationDeg` — the pure rotation computation
 * behind `useContentRotation`, which keeps control content (AR toggle,
 * lens/zoom pill, flash, thumbnails) upright relative to gravity
 * regardless of host portrait-lock state.
 *
 * Covers the full truth table from the hook's docstring plus the
 * mid-rotation transients (jsLandscape=true with a non-landscape device
 * reading, which can briefly happen while the OS catches up).
 *
 * Pure-TS test per jest.config.js.  `useContentRotation` transitively
 * imports `useDeviceOrientation` → `react-native-sensors` (an ES module
 * the no-RN-preset jest infra can't parse), so stub it before importing
 * the SUT.  We only call the pure `contentRotationDeg` export.
 */

// Minimal react-native stub so CaptureStatusOverlay's module-level
// StyleSheet.create (+ Animated/Easing references) load in the pure-TS env.
// Only bannerStyleForOrientation (a pure function) is exercised.
jest.mock('react-native', () => ({
  StyleSheet: {
    create: (s: unknown) => s,
    hairlineWidth: 1,
    absoluteFill: {},
    absoluteFillObject: {},
  },
  Animated: { View: 'Animated.View', Value: class {}, timing: () => ({ start: () => undefined }), loop: (x: unknown) => x, sequence: (x: unknown) => x },
  Easing: { inOut: () => () => 0, out: () => () => 0, ease: () => 0, linear: () => 0 },
  Platform: { OS: 'ios', select: (o: { ios?: unknown; default?: unknown }) => o.ios ?? o.default },
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: 'accelerometer', gyroscope: 'gyroscope' },
}));

import {
  contentRotationDeg,
  framebufferEdge,
  placeAtUserEdge,
} from '../useContentRotation';
import { bannerStyleForOrientation } from '../CaptureStatusOverlay';

describe('contentRotationDeg', () => {
  // Locked-portrait host: jsLandscape is ALWAYS false (window dims stay
  // portrait regardless of device tilt).  The OS doesn't rotate the
  // framebuffer, so content rotation must match device-physical for
  // labels to read upright.  THIS is the case task #5b targets.

  it('locked-portrait + device-portrait → 0° (no-op)', () => {
    expect(contentRotationDeg(false, 'portrait')).toBe(0);
  });

  it('locked-portrait + device-landscape-left → 90° (CW)', () => {
    expect(contentRotationDeg(false, 'landscape-left')).toBe(90);
  });

  it('locked-portrait + device-landscape-right → -90° (CCW)', () => {
    expect(contentRotationDeg(false, 'landscape-right')).toBe(-90);
  });

  it('locked-portrait + device-upside-down → 180°', () => {
    expect(contentRotationDeg(false, 'portrait-upside-down')).toBe(180);
  });

  // Non-locked host + device-landscape: OS rotated the framebuffer for
  // us; we must NOT double-rotate.  Net rotation must be 0.

  it('non-locked + device-landscape-left (jsLandscape=true) → 0°', () => {
    expect(contentRotationDeg(true, 'landscape-left')).toBe(0);
  });

  it('non-locked + device-landscape-right (jsLandscape=true) → 0°', () => {
    expect(contentRotationDeg(true, 'landscape-right')).toBe(0);
  });

  it('non-locked + device-portrait (jsLandscape=false) → 0°', () => {
    expect(contentRotationDeg(false, 'portrait')).toBe(0);
  });

  // Mid-rotation transients: jsLandscape=true with a non-landscape
  // device reading.  Falls through to 0 framebuffer rotation and
  // applies device rotation directly; settles once the transient clears.

  it('jsLandscape=true mid-rotation with device-portrait → 0°', () => {
    expect(contentRotationDeg(true, 'portrait')).toBe(0);
  });

  it('jsLandscape=true mid-rotation with device-upside-down → 180°', () => {
    expect(contentRotationDeg(true, 'portrait-upside-down')).toBe(180);
  });

  it('all returned values are in {0, 90, -90, 180} (no off-by-360°)', () => {
    const orientations = [
      'portrait',
      'portrait-upside-down',
      'landscape-left',
      'landscape-right',
    ] as const;
    for (const o of orientations) {
      for (const jsl of [true, false]) {
        expect([0, 90, -90, 180]).toContain(contentRotationDeg(jsl, o));
      }
    }
  });
});


describe('placeAtUserEdge', () => {
  // Reference cases calibrated against the shipped per-orientation placement:
  // each asserts the framebuffer flex anchor + rotation for a target USER edge.
  // Bottom-anchored (the k/n counter) and top-anchored (the status pill) both
  // come from ONE derivation, correct on locked + non-locked hosts.

  const INSET = 16;

  describe("bottom-anchored (counter) — always user's bottom", () => {
    it('locked-portrait + device-portrait → framebuffer bottom, 0°', () => {
      const p = placeAtUserEdge('portrait', false, 'bottom', INSET);
      expect(p.rotate).toBe('0deg');
      expect(p.container.justifyContent).toBe('flex-end');
      expect(p.container.alignItems).toBe('center');
      expect(p.container.paddingBottom).toBe(INSET);
    });

    it('locked-portrait + landscape-left → framebuffer LEFT + 90° (matches old topCenterForOrientation)', () => {
      const p = placeAtUserEdge('landscape-left', false, 'bottom', INSET);
      expect(p.rotate).toBe('90deg');
      expect(p.container.justifyContent).toBe('center');
      expect(p.container.alignItems).toBe('flex-start');
      expect(p.container.paddingLeft).toBe(INSET);
    });

    it('locked-portrait + landscape-right → framebuffer RIGHT + -90°', () => {
      const p = placeAtUserEdge('landscape-right', false, 'bottom', INSET);
      expect(p.rotate).toBe('-90deg');
      expect(p.container.alignItems).toBe('flex-end');
      expect(p.container.paddingRight).toBe(INSET);
    });

    it('NON-locked + landscape → framebuffer bottom, 0° (the fix: no double-rotation, correct edge)', () => {
      for (const o of ['landscape-left', 'landscape-right'] as const) {
        const p = placeAtUserEdge(o, true, 'bottom', INSET);
        expect(p.rotate).toBe('0deg');
        expect(p.container.justifyContent).toBe('flex-end');
        expect(p.container.alignItems).toBe('center');
      }
    });
  });

  describe("top-anchored (status pill) — always user's top", () => {
    it('locked-portrait + landscape-left → framebuffer RIGHT + 90°', () => {
      const p = placeAtUserEdge('landscape-left', false, 'top', INSET);
      expect(p.rotate).toBe('90deg');
      expect(p.container.alignItems).toBe('flex-end');
    });

    it('NON-locked + landscape → framebuffer top, 0°', () => {
      const p = placeAtUserEdge('landscape-left', true, 'top', INSET);
      expect(p.rotate).toBe('0deg');
      expect(p.container.justifyContent).toBe('flex-start');
      expect(p.container.alignItems).toBe('center');
    });
  });

  it('top and bottom land on OPPOSITE framebuffer edges in every state', () => {
    const OPP: Record<string, string> = {
      'flex-start': 'flex-end',
      'flex-end': 'flex-start',
      center: 'center',
    };
    for (const jsl of [false, true]) {
      for (const o of ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'] as const) {
        const top = placeAtUserEdge(o, jsl, 'top', 0).container;
        const bot = placeAtUserEdge(o, jsl, 'bottom', 0).container;
        expect(bot.justifyContent).toBe(OPP[String(top.justifyContent)]);
        expect(bot.alignItems).toBe(OPP[String(top.alignItems)]);
      }
    }
  });
});


describe('bannerStyleForOrientation (status pill) — shares the model, keeps absolute self-centering', () => {
  const T = 20; // topInset

  // Behavior-preservation: locked-host output is byte-identical to the tuned
  // per-orientation styles that shipped (the wide-banner self-centering math).
  it('locked-portrait + landscape-left → right:34 + 90°', () => {
    expect(bannerStyleForOrientation('landscape-left', T, false)).toEqual({
      position: 'absolute',
      right: 34,
      top: '50%',
      transform: [{ translateY: '-50%' }, { translateX: '50%' }, { rotate: '90deg' }],
    });
  });

  it('locked-portrait + landscape-right → left:34 + -90°', () => {
    expect(bannerStyleForOrientation('landscape-right', T, false)).toEqual({
      position: 'absolute',
      left: 34,
      top: '50%',
      transform: [{ translateY: '-50%' }, { translateX: '-50%' }, { rotate: '-90deg' }],
    });
  });

  it('locked-portrait + upside-down → bottom + 180°', () => {
    expect(bannerStyleForOrientation('portrait-upside-down', T, false)).toEqual({
      position: 'absolute',
      bottom: T + 8,
      left: '50%',
      transform: [{ translateX: '-50%' }, { rotate: '180deg' }],
    });
  });

  it('NON-locked landscape → top-centre, 0° (fix: no double-rotation, correct edge)', () => {
    for (const o of ['landscape-left', 'landscape-right'] as const) {
      expect(bannerStyleForOrientation(o, T, true)).toEqual({
        position: 'absolute',
        top: T + 8,
        left: '50%',
        transform: [{ translateX: '-50%' }, { rotate: '0deg' }],
      });
    }
  });

  it('pill (top) and counter (bottom) never share a framebuffer edge', () => {
    for (const jsl of [false, true]) {
      for (const o of ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'] as const) {
        const net = contentRotationDeg(jsl, o);
        expect(framebufferEdge('top', net)).not.toBe(framebufferEdge('bottom', net));
      }
    }
  });
});
