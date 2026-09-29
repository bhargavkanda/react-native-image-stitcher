// SPDX-License-Identifier: Apache-2.0
/**
 * M8 review — a sweep hold in a build WITHOUT the sweep's session module is
 * refused BY NAME, and leaves the camera usable.
 *
 * The standalone sweep surface used to draw an "unavailable" card and grey its
 * own Start. Inside `<Camera>` neither exists: the shutter is `<Camera>`'s, and
 * the engine declined the hold with a bare `return`. The operator pressed,
 * nothing happened, and nothing said why. Worse, the dispatcher had already
 * raised the D7 capture latch for a capture that never began, so a
 * `takePhoto()` right after was refused as "a panorama is recording".
 *
 * Driven through the REAL engine (no hook stub), from the handle and from the
 * built-in shutter, on both platforms.
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
import { CameraShutter } from '../../camera/CameraShutter';

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

const starts: unknown[] = [];

function installSession(): void {
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      starts.push(o);
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: 'imu', frameSource: 'vc-plugin', opensAvCaptureSession: false,
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
}

beforeEach(() => {
  jest.useFakeTimers();
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  starts.length = 0;
  delete NM.RNSSweepSession;
  delete NM.RNISPanoPlus;
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

async function holdOnce(
  os: 'ios' | 'android', via: 'handle' | 'shutter',
): Promise<{ errors: Array<{ code: string; message: string }>; tree: ReactTestRenderer;
    ref: React.RefObject<any> }> {
  (Platform as { OS: string }).OS = os;
  const errors: Array<{ code: string; message: string }> = [];
  const ref = React.createRef<any>();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <Camera
        ref={ref}
        engine="sweep"
        defaultCaptureSource="non-ar"
        panMode="both"
        hideBuiltInShutter={via === 'handle'}
        onError={(e: { code: string; message: string }) => { errors.push(e); }}
      />,
    );
  });
  await tick(200);
  if (via === 'handle') {
    await act(async () => { ref.current.startPanorama(); });
  } else {
    const shutter = tree.root.findAllByType(CameraShutter)[0];
    await act(async () => { (shutter.props as { onHoldStart: () => void }).onHoldStart(); });
  }
  await tick(100);
  return { errors, tree, ref };
}

describe('M8 review — a sweep hold in a build without the sweep module', () => {
  it.each([
    ['android', 'handle'],
    ['android', 'shutter'],
    ['ios', 'handle'],
    ['ios', 'shutter'],
  ] as const)('%s, via the %s: refused BY NAME as a build fault, once', async (os, via) => {
    const { errors, tree } = await holdOnce(os, via);
    expect(errors.map((e) => e.code)).toEqual(['ENGINE_UNAVAILABLE']);
    // The sentence names the module, not "try again".
    expect(errors[0].message).toMatch(/not (available )?in this build|RNSSweepSession/);
    act(() => { tree.unmount(); });
  });

  it('⚑ the refusal leaves the camera usable: takePhoto() right after is NOT refused as busy', async () => {
    const { errors, tree, ref } = await holdOnce('android', 'handle');
    await act(async () => { await ref.current.takePhoto(); });
    expect(errors.map((e) => e.code)).not.toContain('CAPTURE_IN_PROGRESS');
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: with the module present the same hold starts and says nothing', async () => {
    installSession();
    const { errors, tree } = await holdOnce('android', 'handle');
    await tick(1500);
    expect(errors).toEqual([]);
    expect(starts).toHaveLength(1);
    act(() => { tree.unmount(); });
  });
});
