// SPDX-License-Identifier: Apache-2.0
/**
 * M8 — the finish ORDERING table: the camera is released by native BEFORE
 * `<Camera>` unmounts it.
 *
 * A stop tears the sweep's arm down (plugin disarmed, camera lock released)
 * and only then writes the canvas and the pack. `<Camera>` must keep its
 * camera mounted until native says the release point has passed
 * (`status.cameraReleased`), then unmount it for the rest of the finish — the
 * keyframe engine's stitching rule — and mount it again when the finish ends.
 *
 *   phase                      | camera mounted | status overlay
 *   ---------------------------+----------------+---------------
 *   sweeping                   | yes            | recording
 *   finishing, not released    | yes            | idle
 *   finishing, released        | NO             | stitching
 *   finish resolved            | yes            | idle
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';
import { VisionCameraProxy } from 'react-native-vision-camera';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: () => Promise.resolve(''),
  writeAsStringAsync: () => Promise.resolve(),
  deleteAsync: () => Promise.resolve(),
  getInfoAsync: () => Promise.resolve({ exists: false }),
  readDirectoryAsync: () => Promise.resolve([]),
  copyAsync: () => Promise.resolve(),
}), { virtual: true });

import { Camera } from '../../camera/Camera';
import { CameraView } from '../../camera/CameraView';
import { CaptureStatusOverlay } from '../../camera/CaptureStatusOverlay';

const NM = NativeModules as Record<string, unknown>;
const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown;
  useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const proxy = VisionCameraProxy as unknown as { initFrameProcessorPlugin: unknown };
const realInit = proxy.initFrameProcessorPlugin;

const DEVICE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};

let released = false;
let resolveStop: ((v: unknown) => void) | null = null;
let sessionDir = '';

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  released = false;
  resolveStop = null;
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      sessionDir = String(o.sessionDir);
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: 'imu', frameSource: 'vc-plugin',
      });
    },
    stop: () => new Promise((res) => { resolveStop = res; }),
    cancel: () => Promise.resolve({ cancelled: true }),
    // Once the sweep is stopping the core answers `running: false` — which is
    // exactly why `cameraReleased` has to be read regardless of it.
    getStatus: () => Promise.resolve(
      resolveStop == null
        ? { running: true, sessionDir, seq: 1, painted: 5 }
        : { running: false, cameraReleased: released },
    ),
    setIdlePreview: () => Promise.resolve({ on: false }),
    getConstants: () => ({ documentDirectory: 'file:///data/files/', vcArmSupported: true }),
    documentDirectory: 'file:///data/files/',
    vcArmSupported: true,
  };
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  proxy.initFrameProcessorPlugin = realInit;
  delete NM.RNSSweepSession;
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const cameraMounted = (t: ReactTestRenderer) => t.root.findAllByType(CameraView).length === 1;
const overlayPhase = (t: ReactTestRenderer) =>
  t.root.findAllByType(CaptureStatusOverlay)[0]?.props.phase as string;

describe('M8 — a sweep\'s finish releases the camera natively BEFORE <Camera> unmounts it', () => {
  it('walks the table', async () => {
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview={false} />,
      );
    });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    // sweeping
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('recording');

    // finishing, not yet released: the camera STAYS
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(300);
    expect(resolveStop).not.toBeNull();
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('idle');

    // native passes the release point: now, and only now, it unmounts
    released = true;
    await tick(300);
    expect(cameraMounted(tree)).toBe(false);
    expect(overlayPhase(tree)).toBe('stitching');

    // the finish resolves: the camera comes back
    await act(async () => {
      resolveStop?.({ width: 100, height: 50, sessionDir, counts: {}, abort: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    await tick(100);
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('idle');
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a finish native never reports released keeps the camera up throughout', async () => {
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview={false} />,
      );
    });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(2000);
    expect(cameraMounted(tree)).toBe(true);
    act(() => { tree.unmount(); });
  });
});
