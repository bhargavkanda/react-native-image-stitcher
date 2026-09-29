// SPDX-License-Identifier: Apache-2.0
/**
 * M8 review (19) — the capture-history strip is on screen at idle on the
 * sweep engine, HIDDEN while a sweep records, and back once it has finished.
 *
 * `renderThumbnailStrip()` draws `<CaptureThumbnailStrip>` when the host passes
 * `thumbnails` and `!captureRecording`, where
 *
 *   captureRecording = statusPhase === 'recording' || (sweepRunning && !sweepFinalizing)
 *
 * The keyframe engine hides the strip so its live band has room. A sweep must
 * hide it too: its hold overlay draws the growing panorama in the same place.
 * The sweep's half of that expression (`sweepRunning`) arrives from the
 * engine's `onSweepingChange`, and no suite drove it through the REAL engine.
 * A hide that keyed on `statusPhase` alone, which is the keyframe engine's
 * phase and never moves on a sweep, would have left the strip over a live
 * sweep with every existing test green. So this suite runs the real sweep
 * engine through `<Camera>` (the cameraSweepFinishOrder harness):
 *
 *   step                                   | strip
 *   ---------------------------------------+---------------------------
 *   mounted, engine="sweep", no hold       | present, the host's items
 *   startPanorama(), native start resolved | ABSENT
 *   native stop resolved                   | present, the host's items
 *
 * (The 'finishing' window between the last two rows is not pinned here.
 * `captureRecording` is false there by construction, as it is while the
 * keyframe engine stitches.)
 *
 * ⚑ NEGATIVE CONTROLS: no `thumbnails` prop means no strip at idle, so the
 * idle row is not vacuous. The keyframe engine shows the same strip at idle,
 * since `engine` is a prop and not a screen.
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
import {
  CaptureThumbnailStrip,
  type CaptureThumbnailItem,
} from '../CaptureThumbnailStrip';

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

const ITEMS: CaptureThumbnailItem[] = [
  { id: 'cap-1', uri: 'file:///data/files/cap-1.jpg', width: 400, height: 100 },
  { id: 'cap-2', uri: 'file:///data/files/cap-2.jpg', width: 300, height: 300 },
];

let resolveStop: ((v: unknown) => void) | null = null;
let sessionDir = '';

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
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

const strips = (t: ReactTestRenderer) => t.root.findAllByType(CaptureThumbnailStrip);

async function mount(engine: 'keyframe' | 'sweep', thumbnails?: CaptureThumbnailItem[]) {
  const ref = React.createRef<any>();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <Camera ref={ref} engine={engine} defaultCaptureSource="non-ar" panMode="both"
        rectCrop={false} showPreview={false} thumbnails={thumbnails} />,
    );
  });
  await tick(0);
  await tick(500);
  return { tree, ref };
}

describe('M8 review (19) — the thumbnail strip is hidden while a sweep records', () => {
  it('walks the table: present at idle → ABSENT sweeping → present after the finish', async () => {
    const { tree, ref } = await mount('sweep', ITEMS);

    // idle: the host's history is on screen
    expect(strips(tree)).toHaveLength(1);
    expect(strips(tree)[0].props.items).toBe(ITEMS);

    // sweeping: out of the way of the live panorama
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    expect(strips(tree)).toHaveLength(0);
    // Still hidden a while into the sweep, not just on the first commit.
    await tick(1000);
    expect(strips(tree)).toHaveLength(0);

    // the finish resolves: it comes back, with the same items
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(300);
    await act(async () => {
      resolveStop?.({ width: 100, height: 50, sessionDir, counts: {}, abort: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    await tick(300);
    expect(strips(tree)).toHaveLength(1);
    expect(strips(tree)[0].props.items).toBe(ITEMS);
    act(() => { tree.unmount(); });
  });

  describe('⚑ NEGATIVE CONTROLS', () => {
    it('no `thumbnails` prop → no strip at idle on the sweep engine', async () => {
      const { tree } = await mount('sweep');
      expect(strips(tree)).toHaveLength(0);
      act(() => { tree.unmount(); });
    });

    it('the keyframe engine shows the same strip at idle', async () => {
      const { tree } = await mount('keyframe', ITEMS);
      expect(strips(tree)).toHaveLength(1);
      expect(strips(tree)[0].props.items).toBe(ITEMS);
      act(() => { tree.unmount(); });
    });
  });
});
