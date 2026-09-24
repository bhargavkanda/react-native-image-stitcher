// SPDX-License-Identifier: Apache-2.0
/**
 * M8 review (12) — the POSITIVE CONTROL for `<SweepHoldOverlay>`: the sweep's
 * live drawing IS on screen while a sweep is live.
 *
 * `<Camera>` draws the overlay over its own camera only while
 * `engine === 'sweep' && cropPending == null && sweepEngine.phase !== 'idle'`
 * (Camera.tsx, "THE SWEEP'S HOLD-TIME DRAWING"). The existing suites assert
 * only that it is ABSENT at idle (DR-2 U2: the idle screen is the keyframe
 * engine's). An overlay that never rendered at all would pass every one of
 * them, and the operator would sweep with no panorama growing, no headline
 * and no fault chip. This suite drives the REAL sweep engine through
 * `<Camera>` (a mocked `RNSSweepSession`, as in cameraSweepFinishOrder) and
 * walks the whole life of one sweep:
 *
 *   step                                  | engine phase | overlay
 *   --------------------------------------+--------------+---------------------
 *   mounted, engine="sweep", no hold      | idle         | absent
 *   startPanorama(), native start resolved| sweeping     | PRESENT, phase prop
 *   stopPanorama(), native stop pending   | finishing    | PRESENT ("Finishing…")
 *   native stop resolved                  | idle         | absent
 *
 * ⚑ NEGATIVE CONTROLS: the keyframe engine never draws it, even after a
 * start; and a start native REFUSES leaves nothing drawn once the engine is
 * back at idle. The overlay follows a live sweep, not an attempt at one.
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

import { Camera } from '../Camera';
import { SweepHoldOverlay } from '../../sweep/SweepHoldOverlay';

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

let resolveStop: ((v: unknown) => void) | null = null;
let startRefusal: Error | null = null;
let starts = 0;
let sessionDir = '';

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  resolveStop = null;
  startRefusal = null;
  starts = 0;
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      starts += 1;
      sessionDir = String(o.sessionDir);
      if (startRefusal != null) return Promise.reject(startRefusal);
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: 'imu', frameSource: 'vc-plugin',
      });
    },
    stop: () => new Promise((res) => { resolveStop = res; }),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve(
      resolveStop == null
        ? { running: true, sessionDir, seq: 1, painted: 5 }
        : { running: false, cameraReleased: false },
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

const overlays = (t: ReactTestRenderer) => t.root.findAllByType(SweepHoldOverlay);

async function mount(engine: 'keyframe' | 'sweep') {
  const ref = React.createRef<any>();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <Camera ref={ref} engine={engine} defaultCaptureSource="non-ar" panMode="both"
        rectCrop={false} showPreview={false} />,
    );
  });
  await tick(0);
  await tick(500);
  return { tree, ref };
}

describe('M8 review (12) — <SweepHoldOverlay> is drawn while a sweep is live, and only then', () => {
  it('walks the table: absent at idle → PRESENT sweeping → PRESENT finishing → absent', async () => {
    const { tree, ref } = await mount('sweep');

    // idle: nothing over the viewfinder
    expect(overlays(tree)).toHaveLength(0);

    // sweeping: the overlay is up, and it is told the engine's phase
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    expect(starts).toBe(1);
    expect(overlays(tree)).toHaveLength(1);
    expect(overlays(tree)[0].props.phase).toBe('sweeping');
    expect(overlays(tree)[0].props.sweeping).toBe(true);

    // finishing (native stop still pending): it stays up — its guidance is
    // the "Finishing…" copy
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(300);
    expect(resolveStop).not.toBeNull();
    expect(overlays(tree)).toHaveLength(1);
    expect(overlays(tree)[0].props.phase).toBe('finishing');

    // the finish resolves: gone again
    await act(async () => {
      resolveStop?.({ width: 100, height: 50, sessionDir, counts: {}, abort: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    await tick(300);
    expect(overlays(tree)).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  it('a second sweep draws it again (the overlay is not a one-shot)', async () => {
    const { tree, ref } = await mount('sweep');
    for (let i = 0; i < 2; i += 1) {
      resolveStop = null;
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { ref.current.startPanorama(); });
      // eslint-disable-next-line no-await-in-loop
      await tick(300);
      expect(overlays(tree)).toHaveLength(1);
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await ref.current.stopPanorama(); });
      // eslint-disable-next-line no-await-in-loop
      await tick(300);
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        resolveStop?.({ width: 100, height: 50, sessionDir, counts: {}, abort: null });
        await Promise.resolve();
        await Promise.resolve();
      });
      // eslint-disable-next-line no-await-in-loop
      await tick(1000);
      expect(overlays(tree)).toHaveLength(0);
    }
    expect(starts).toBe(2);
    act(() => { tree.unmount(); });
  });

  describe('⚑ NEGATIVE CONTROLS', () => {
    it('the keyframe engine never draws it, idle or after a start', async () => {
      const { tree, ref } = await mount('keyframe');
      expect(overlays(tree)).toHaveLength(0);
      await act(async () => { ref.current.startPanorama(); });
      await tick(300);
      expect(starts).toBe(0);            // the sweep engine was never asked
      expect(overlays(tree)).toHaveLength(0);
      act(() => { tree.unmount(); });
    });

    it('a start native refuses leaves nothing drawn once the engine is idle again', async () => {
      startRefusal = Object.assign(new Error('refused'), { code: 'panoplus-start-failed' });
      const { tree, ref } = await mount('sweep');
      await act(async () => { ref.current.startPanorama(); });
      await tick(300);
      expect(starts).toBe(1);            // the start was attempted…
      expect(overlays(tree)).toHaveLength(0);   // …and did not become a sweep
      act(() => { tree.unmount(); });
    });
  });
});
