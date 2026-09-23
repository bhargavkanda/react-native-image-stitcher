// SPDX-License-Identifier: Apache-2.0
/**
 * `rectCrop` defaults ON (operator decision, 2026-09-23) — and every place
 * that reads it must read it the SAME way.  `<Camera>` and
 * `extractPanoramaOverrides` both go through `resolveRectCrop` (omitted → the
 * default, anything else → its truthiness), so `null` and `undefined` can no
 * longer mean different things in the two.  `stitcherForNative` is the
 * native-boundary half: with the editor on, the auto-crop is forced off
 * whichever spelling set it (its call site is covered by
 * keyframeLateralStop.render.test.tsx).
 *
 * Pure-TS test: the SUTs are reached through Camera.tsx's
 * `_extractPanoramaOverridesForTests` / `_stitcherForNativeForTests` handles;
 * native deps are stubbed as in cameraUnmountGate.test.ts.
 */

// Camera.tsx transitively imports the entire camera surface (vision-camera,
// worklets, sensors, native modules); we only call one pure function, so
// stub the whole dependency tree (mirrors homeIndicatorEdge.test.ts).
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
  _extractPanoramaOverridesForTests as extract,
  _stitcherForNativeForTests as stitcherForNative,
} from '../Camera';

describe('rectCrop default reaches the native auto-crop decision', () => {
  it('an omitted rectCrop is ON, so the native auto-crop is forced off', () => {
    expect(extract({ maxInscribedRectCrop: true } as never).maxInscribedRectCrop)
      .toBe(false);
  });

  it('rectCrop={false} hands the native auto-crop back to maxInscribedRectCrop', () => {
    expect(extract({ rectCrop: false, maxInscribedRectCrop: true } as never)
      .maxInscribedRectCrop).toBe(true);
    expect(extract({ rectCrop: false, maxInscribedRectCrop: false } as never)
      .maxInscribedRectCrop).toBe(false);
  });

  it('rectCrop={true} forces it off whatever maxInscribedRectCrop says', () => {
    expect(extract({ rectCrop: true, maxInscribedRectCrop: true } as never)
      .maxInscribedRectCrop).toBe(false);
  });
});

describe('one reading of rectCrop', () => {
  it('rectCrop={null} is OFF here, as it is in the component destructure', () => {
    // An untyped JS host. `??` would have read null as the default (ON) while
    // the component read it as falsy — the split `resolveRectCrop` removes.
    expect(extract({ rectCrop: null, maxInscribedRectCrop: true } as never)
      .maxInscribedRectCrop).toBe(true);
  });
});

describe('the native boundary forces the auto-crop off whatever spelled it on', () => {
  it('the stitcher recipe / settings-modal spelling is overridden when the editor is on', () => {
    const recipe = { enableMaxInscribedRectCrop: true, blenderType: 'feather' };
    expect(stitcherForNative(recipe, true)).toEqual({
      enableMaxInscribedRectCrop: false, blenderType: 'feather',
    });
    expect(recipe.enableMaxInscribedRectCrop).toBe(true); // not mutated
  });

  it('with the editor off the settings pass through untouched', () => {
    const recipe = { enableMaxInscribedRectCrop: true };
    expect(stitcherForNative(recipe, false)).toBe(recipe);
  });
});
