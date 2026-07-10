// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `homeIndicatorEdge` + `isSideEdge` — the pure functions
 * that produce the `vertical` flag driving PanoramaBandOverlay and
 * CaptureThumbnailStrip layout under non-locked hosts.
 *
 *   vertical = isSideEdge(homeIndicatorEdge(jsLandscape, deviceOrient))
 *
 * Contract (v0.12 orientation-aware Camera):
 *   - Portrait JS layout (jsLandscape=false) → 'bottom' edge → NOT a
 *     side edge → vertical=false (horizontal strip, the portrait-locked
 *     case that's the recommended config).
 *   - Landscape JS layout → 'right'/'left' edge → side edge →
 *     vertical=true (the strip/band stack along the home-indicator edge).
 *
 * Pure-TS test per jest.config.js (no component mount).  The functions
 * are imported via Camera.tsx's `_*ForTests` handles; react-native and
 * the heavy native deps are mocked so the import resolves in node env.
 */

// The SUT lives in Camera.tsx, which transitively imports the entire
// camera surface (vision-camera, worklets, sensors, native modules).
// We only call two pure functions, so stub the whole dependency tree.
jest.mock('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: (s: Record<string, unknown>) => s, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
  Image: 'Image',
  ScrollView: 'ScrollView',
  Animated: { View: 'Animated.View', Value: class {}, timing: () => ({ start: () => undefined }) },
  Modal: 'Modal',
  ActivityIndicator: 'ActivityIndicator',
  useWindowDimensions: () => ({ width: 0, height: 0 }),
  requireNativeComponent: () => 'NativeComponent',
  UIManager: { getViewManagerConfig: () => ({}) },
  findNodeHandle: () => 1,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-sensors', () => ({
  accelerometer: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { accelerometer: 'accelerometer' },
}));
jest.mock('react-native-worklets-core', () => ({ Worklets: {} }));
jest.mock('react-native-vision-camera', () => ({
  Camera: 'Camera',
  useCameraDevice: jest.fn(),
  useCameraPermission: jest.fn(),
}));

import {
  _homeIndicatorEdgeForTests as homeIndicatorEdge,
  _isSideEdgeForTests as isSideEdge,
} from '../Camera';
import type { DeviceOrientation } from '../useDeviceOrientation';

const PORTRAIT: DeviceOrientation = 'portrait';
const UPSIDE: DeviceOrientation = 'portrait-upside-down';
const LEFT: DeviceOrientation = 'landscape-left';
const RIGHT: DeviceOrientation = 'landscape-right';

// The composed signal the band/strip actually consume.
const vertical = (jsLandscape: boolean, o: DeviceOrientation) =>
  isSideEdge(homeIndicatorEdge(jsLandscape, o));

describe('homeIndicatorEdge', () => {
  it('returns bottom for any portrait JS layout (jsLandscape=false)', () => {
    // Portrait JS layout always anchors bottom regardless of the sensor
    // value — this is the portrait-locked case (the recommended config).
    for (const o of [PORTRAIT, UPSIDE, LEFT, RIGHT]) {
      expect(homeIndicatorEdge(false, o)).toBe('bottom');
    }
  });

  it('anchors RIGHT for landscape-left device in landscape JS layout', () => {
    expect(homeIndicatorEdge(true, LEFT)).toBe('right');
  });

  it('anchors LEFT for landscape-right device in landscape JS layout', () => {
    expect(homeIndicatorEdge(true, RIGHT)).toBe('left');
  });

  it('falls through to right for non-landscape sensor + landscape JS (transient)', () => {
    // jsLandscape=true with a portrait sensor reading only happens
    // mid-rotation; defensive default is 'right'.
    expect(homeIndicatorEdge(true, PORTRAIT)).toBe('right');
    expect(homeIndicatorEdge(true, UPSIDE)).toBe('right');
  });
});

describe('isSideEdge', () => {
  it('is true only for left/right edges', () => {
    expect(isSideEdge('left')).toBe(true);
    expect(isSideEdge('right')).toBe(true);
    expect(isSideEdge('bottom')).toBe(false);
    expect(isSideEdge('top')).toBe(false);
  });
});

describe('vertical flag (composed) — what the strip/band consume', () => {
  it('is FALSE for portrait-locked layout (horizontal strip, recommended)', () => {
    for (const o of [PORTRAIT, UPSIDE, LEFT, RIGHT]) {
      expect(vertical(false, o)).toBe(false);
    }
  });

  it('is TRUE for both landscape orientations under a non-locked host', () => {
    expect(vertical(true, LEFT)).toBe(true);
    expect(vertical(true, RIGHT)).toBe(true);
  });
});
