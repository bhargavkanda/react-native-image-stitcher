// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `cameraShouldUnmount` — the pure predicate behind the
 * OOM render gate.  When true, <Camera> renders the placeholder INSTEAD of
 * the live <CameraView>/<ARCameraView>, so vision-camera tears down the
 * AVCaptureSession + preview buffers (~150-250 MB).
 *
 * The load-bearing case is statusPhase==='stitching' → true: that's the
 * V12.14.8 fix that stops the live-camera footprint and the stitch peak
 * from coexisting and jetsam/lmkd OOM-killing the app.  The inverse is
 * just as important — during 'recording' (the live hold-pan) the camera
 * must STAY mounted, so the gate must be false there.
 *
 * Pure-TS test (jest.config.js can't mount <Camera>): the SUT is imported
 * via Camera.tsx's `_cameraShouldUnmountForTests` handle; the heavy native
 * dep tree is stubbed so the import resolves in node env.
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
jest.mock('react-native-worklets-core', () => ({
  // Camera.tsx's import chain evaluates Worklets.createSharedValue at
  // MODULE SCOPE (exposureBurst.ts armed flag) — must be callable.
  Worklets: { createSharedValue: (v: unknown) => ({ value: v }) },
  useSharedValue: (v: unknown) => ({ value: v }),
}));
jest.mock('react-native-vision-camera', () => ({
  Camera: 'Camera',
  useCameraDevice: jest.fn(),
  useCameraPermission: jest.fn(),
}));

import { _cameraShouldUnmountForTests as cameraShouldUnmount } from '../Camera';
import type { CaptureStatusPhase } from '../CaptureStatusOverlay';

const IDLE: CaptureStatusPhase = 'idle';
const RECORDING: CaptureStatusPhase = 'recording';
const STITCHING: CaptureStatusPhase = 'stitching';

describe('cameraShouldUnmount', () => {
  it('UNMOUNTS during the stitch (the V12.14.8 OOM fix)', () => {
    expect(cameraShouldUnmount(false, false, STITCHING)).toBe(true);
  });

  it('keeps the camera MOUNTED while recording (live hold-pan)', () => {
    // Unmounting here would kill the capture in progress.
    expect(cameraShouldUnmount(false, false, RECORDING)).toBe(false);
  });

  it('keeps the camera MOUNTED when idle', () => {
    expect(cameraShouldUnmount(false, false, IDLE)).toBe(false);
  });

  it('unmounts during a camera-switch transition (any phase)', () => {
    expect(cameraShouldUnmount(true, false, IDLE)).toBe(true);
    expect(cameraShouldUnmount(true, false, RECORDING)).toBe(true);
  });

  it('unmounts while the AR-support probe is pending (any phase)', () => {
    expect(cameraShouldUnmount(false, true, IDLE)).toBe(true);
    expect(cameraShouldUnmount(false, true, RECORDING)).toBe(true);
  });

  it('is the OR of all three conditions', () => {
    // Exhaustive truth table over (transition, arPending) × phase.
    for (const transition of [false, true]) {
      for (const arPending of [false, true]) {
        for (const phase of [IDLE, RECORDING, STITCHING]) {
          const expected = transition || arPending || phase === 'stitching';
          expect(cameraShouldUnmount(transition, arPending, phase)).toBe(expected);
        }
      }
    }
  });
});
