// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `holdShouldDeferForCamera` — the v0.25 fix that stops a
 * panorama hold starting a capture against a camera that is not mounted.
 *
 * ## The failure this encodes
 *
 * With AR capture, a hold could end itself in under a second and deliver
 * a single keyframe as the "panorama". One confirmed contributor was a
 * DEFERRAL HOLE, not a gate-tuning problem:
 *
 *   1. A hold arrives while the AR capability probe is still resolving.
 *      v0.24.3 correctly defers it on `arSupportPending`.
 *   2. The probe resolves. In that SAME render `arSupportPending` goes
 *      false AND the effective capture source flips to 'ar', so `isAR`
 *      flips false -> true.
 *   3. `isAR` flipping makes `inFlightTransition` true, which makes the
 *      render gate (`cameraShouldUnmount`) unmount the camera and render
 *      the "Switching camera…" placeholder. On iOS the AR session is
 *      stopped with a 250 ms grace before the AR view may mount again.
 *   4. But the resume effect keyed only on `!arSupportPending` — so it
 *      fired at exactly the moment the transition BEGAN, starting a
 *      capture against no frame source.
 *
 * The fix is not a new heuristic: the hold gate now reads the same
 * condition the RENDER gate already read. If the renderer has decided
 * there is no camera, a hold must not start a capture.
 *
 * These tests pin the sequence above so a future change to either gate
 * that reintroduces the asymmetry fails here.
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
  _holdShouldDeferForCameraForTests as shouldDefer,
  _cameraShouldUnmountForTests as shouldUnmount,
} from '../Camera';

describe('holdShouldDeferForCamera', () => {
  it('does not defer when the camera is settled and mounted', () => {
    expect(shouldDefer(false, false)).toBe(false);
  });

  it('defers while the AR capability probe is unresolved (the v0.24.3 case)', () => {
    expect(shouldDefer(false, true)).toBe(true);
  });

  it('defers while a camera transition is in flight (the v0.25 fix)', () => {
    expect(shouldDefer(true, false)).toBe(true);
  });

  it('defers when both are true', () => {
    expect(shouldDefer(true, true)).toBe(true);
  });

  describe('THE HOLE IT CLOSES — probe resolving flips straight into a transition', () => {
    it('stays deferred across the render where arSupportPending clears but isAR flips', () => {
      // Render N: probe unresolved, no transition yet.
      expect(shouldDefer(false, true)).toBe(true);

      // Render N+1: probe resolved (arSupportPending false) AND isAR
      // flipped in the same render, so a transition is now in flight.
      // Pre-v0.25 the resume effect saw only `!arSupportPending` and
      // started the capture HERE — against an unmounted camera.
      expect(shouldDefer(true, false)).toBe(true);

      // Render N+2: transition settled, camera mounted -> now it may start.
      expect(shouldDefer(false, false)).toBe(false);
    });
  });

  describe('agrees with the render gate — the invariant that was violated', () => {
    it('never allows a hold to start while the renderer has the camera unmounted', () => {
      for (const inFlight of [true, false]) {
        for (const probePending of [true, false]) {
          // 'idle' and 'recording' are the phases a hold can begin from;
          // 'stitching' is rejected outright by handleHoldStart before
          // this predicate is consulted, so it is excluded here.
          for (const phase of ['idle', 'recording'] as const) {
            if (shouldUnmount(inFlight, probePending, phase)) {
              expect(shouldDefer(inFlight, probePending)).toBe(true);
            }
          }
        }
      }
    });

    it('is exactly the render gate minus its stitching term', () => {
      for (const inFlight of [true, false]) {
        for (const probePending of [true, false]) {
          expect(shouldDefer(inFlight, probePending)).toBe(
            shouldUnmount(inFlight, probePending, 'idle'),
          );
        }
      }
    });
  });
});
