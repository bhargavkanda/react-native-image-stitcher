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
jest.mock('react-native-worklets-core', () => ({ Worklets: {} }));
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
    expect(cameraShouldUnmount(false, false, STITCHING, false)).toBe(true);
  });

  it('keeps the camera MOUNTED while recording (live hold-pan)', () => {
    // Unmounting here would kill the capture in progress.
    expect(cameraShouldUnmount(false, false, RECORDING, false)).toBe(false);
  });

  it('keeps the camera MOUNTED when idle', () => {
    expect(cameraShouldUnmount(false, false, IDLE, false)).toBe(false);
  });

  it('unmounts during a camera-switch transition (any phase)', () => {
    expect(cameraShouldUnmount(true, false, IDLE, false)).toBe(true);
    expect(cameraShouldUnmount(true, false, RECORDING, false)).toBe(true);
  });

  it('unmounts while the AR-support probe is pending (any phase)', () => {
    expect(cameraShouldUnmount(false, true, IDLE, false)).toBe(true);
    expect(cameraShouldUnmount(false, true, RECORDING, false)).toBe(true);
  });

  // ── THE SWEEP HANDOFF ───────────────────────────────────────────────
  //
  // The sweep does not share vision-camera's session: its recorder OWNS the
  // Camera2 device. The release is ASYNC — the recorder's own retry measured
  // "attempt 2 after 479ms" on a Galaxy A35 — and vision-camera does not
  // retry, it reports `system/max-cameras-in-use` and the preview is dead.
  // An operator hit exactly that switching sweep → keyframe.

  it('unmounts while the sweep is still releasing the camera (any phase)', () => {
    expect(cameraShouldUnmount(false, false, IDLE, true)).toBe(true);
    expect(cameraShouldUnmount(false, false, RECORDING, true)).toBe(true);
  });

  it('remounts once the handoff window has elapsed', () => {
    // The whole point: this is a WINDOW, not a latch. If it never cleared,
    // the keyframe engine would have no preview at all after one sweep.
    expect(cameraShouldUnmount(false, false, IDLE, false)).toBe(false);
  });

  it('is the OR of all four conditions', () => {
    // Exhaustive truth table over (transition, arPending, handoff) × phase.
    // 24 combinations, all asserted — a gate that grows a term and keeps a
    // table written for the old arity is how a term stops being checked.
    let checked = 0;
    for (const transition of [false, true]) {
      for (const arPending of [false, true]) {
        for (const handoff of [false, true]) {
          for (const phase of [IDLE, RECORDING, STITCHING]) {
            const expected =
              transition || arPending || phase === 'stitching' || handoff;
            expect(
              cameraShouldUnmount(transition, arPending, phase, handoff),
            ).toBe(expected);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(2 * 2 * 2 * 3);
  });
});
