// SPDX-License-Identifier: Apache-2.0
/**
 * M8 — the sweep's hold-only READINESS defer, through the one dispatcher.
 *
 * On the vision-camera kind a sweep needs its frame-processor plugin
 * (`panoplus_sweep_ingest`). Until M8 a hold before the lookup landed was
 * refused at once as "still loading". The dispatcher now DEFERS it, as it
 * defers a hold inside a camera transition, and resumes the moment the plugin
 * lands. The deferral is bounded: the lookup gives up at 1.5 s, and the
 * resumed hold is then refused BY NAME as a build fault (ENGINE_UNAVAILABLE).
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
}), { virtual: true });

import { Camera } from '../../camera/Camera';

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

let pluginLanded = false;
const starts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  pluginLanded = false;
  starts.length = 0;
  proxy.initFrameProcessorPlugin = (name: string) => (
    name === 'panoplus_sweep_ingest' && !pluginLanded ? null : { call: () => undefined }
  );
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      starts.push(o);
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: 'imu', frameSource: 'vc-plugin',
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: false }),
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

async function mount(errors: string[]): Promise<{
  tree: ReactTestRenderer; ref: React.RefObject<any>;
}> {
  const ref = React.createRef<any>();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <Camera
        ref={ref}
        engine="sweep"
        defaultCaptureSource="non-ar"
        panMode="both"
        onError={(e: { code: string }) => { errors.push(e.code); }}
      />,
    );
  });
  await tick(0);
  return { tree, ref };
}

describe('M8 — a sweep hold before its plugin lands is DEFERRED, not refused', () => {
  it('resumes the moment the plugin lands, and the sweep starts on the vision-camera arm', async () => {
    const errors: string[] = [];
    const { tree, ref } = await mount(errors);
    await act(async () => { ref.current.startPanorama(); });
    await tick(100);
    expect(starts).toHaveLength(0);          // deferred…
    expect(errors).toEqual([]);              // …not refused
    pluginLanded = true;
    await tick(200);
    await tick(1500);
    expect(starts).toHaveLength(1);
    expect(starts[0].vcPluginArm).toBe(true);
    expect(errors).toEqual([]);
    act(() => { tree.unmount(); });
  });

  it('⚑ BOUNDED: a plugin that never lands ends in a NAMED build refusal, never a start', async () => {
    const errors: string[] = [];
    const { tree, ref } = await mount(errors);
    await act(async () => { ref.current.startPanorama(); });
    await tick(2000);
    await tick(1500);
    expect(starts).toHaveLength(0);
    expect(errors).toEqual(['ENGINE_UNAVAILABLE']);
    act(() => { tree.unmount(); });
  });

  it('⚑ a release before the plugin lands abandons the hold', async () => {
    const errors: string[] = [];
    const { tree, ref } = await mount(errors);
    await act(async () => { ref.current.startPanorama(); });
    await act(async () => { await ref.current.stopPanorama(); });
    pluginLanded = true;
    await tick(200);
    await tick(1500);
    expect(starts).toHaveLength(0);
    act(() => { tree.unmount(); });
  });
});
