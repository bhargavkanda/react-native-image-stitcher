// SPDX-License-Identifier: Apache-2.0
/**
 * M5 — `<Camera>` holds the camera's configuration for the life of a capture,
 * and discards a capture the camera stopped under.
 *
 *   · vision-camera rebuilds its session — and resets AE and focus to
 *     continuous — on a format, fps or orientation change, and rebinds its
 *     outputs on a new frame processor. So while a capture records, what
 *     vision-camera is handed is HELD (`CameraView latched`).
 *   · a backgrounded app stops the camera (`isActive`); a capture recording
 *     then is discarded by name (`CAPTURE_INTERRUPTED`), not finished on a
 *     camera that stopped.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';
import { VisionCameraProxy } from 'react-native-vision-camera';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///var/mobile/Documents/',
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: () => Promise.resolve(''),
  writeAsStringAsync: () => Promise.resolve(),
  deleteAsync: () => Promise.resolve(),
  getInfoAsync: () => Promise.resolve({ exists: false }),
  readDirectoryAsync: () => Promise.resolve([]),
}), { virtual: true });

import { Camera } from '../../camera/Camera';
import { useLatchedWhile } from '../../camera/CameraView';
import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';

const RN = require('react-native') as { __emitAppState: (s: string) => void };
const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown;
  useCameraDevices: unknown;
  Camera: unknown;
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

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  (NativeModules as Record<string, unknown>).BatchStitcher = {};
});
afterEach(() => {
  act(() => { RN.__emitAppState('active'); });
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  proxy.initFrameProcessorPlugin = realInit;
});

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const vcCamera = (t: ReactTestRenderer) =>
  t.root.findAll((n) => n.type === vc.Camera)[0]!;
const surface = (t: ReactTestRenderer) => t.root.findByType(PanoPlusCaptureSurface);

describe('useLatchedWhile', () => {
  function Probe({ latched, value, out }: { latched: boolean; value: number; out: number[] }) {
    out.push(useLatchedWhile(latched, value));
    return null;
  }
  it('passes the value through, holds it while latched, and releases it', () => {
    const out: number[] = [];
    let t!: ReactTestRenderer;
    act(() => { t = create(<Probe latched={false} value={1} out={out} />); });
    act(() => { t.update(<Probe latched value={2} out={out} />); });
    act(() => { t.update(<Probe latched value={3} out={out} />); });
    act(() => { t.update(<Probe latched={false} value={4} out={out} />); });
    expect(out).toEqual([1, 2, 2, 4]);
    act(() => { t.unmount(); });
  });
});

describe('<Camera> holds the camera configuration while a capture records', () => {
  it('a torch change mid-sweep does not reach vision-camera until the sweep ends', async () => {
    let t!: ReactTestRenderer;
    act(() => { t = create(<Camera engine="sweep" defaultCaptureSource="non-ar" flash="off" />); });
    await flush();
    await act(async () => { jest.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(vcCamera(t).props.torch).toBe('off');
    act(() => { (surface(t).props.onSweepingChange as (v: boolean) => void)(true); });
    act(() => { t.update(<Camera engine="sweep" defaultCaptureSource="non-ar" flash="on" />); });
    expect(vcCamera(t).props.torch).toBe('off');          // held
    act(() => { (surface(t).props.onSweepingChange as (v: boolean) => void)(false); });
    expect(vcCamera(t).props.torch).toBe('on');           // released
    act(() => { t.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: at idle the same change reaches vision-camera at once', async () => {
    let t!: ReactTestRenderer;
    act(() => { t = create(<Camera engine="sweep" defaultCaptureSource="non-ar" flash="off" />); });
    await flush();
    await act(async () => { jest.advanceTimersByTime(1000); await Promise.resolve(); });
    act(() => { t.update(<Camera engine="sweep" defaultCaptureSource="non-ar" flash="on" />); });
    expect(vcCamera(t).props.torch).toBe('on');
    act(() => { t.unmount(); });
  });
});

describe('<Camera> discards a capture the camera stopped under', () => {
  it('backgrounding mid-sweep reports CAPTURE_INTERRUPTED', async () => {
    const errors: Array<{ code: string }> = [];
    let t!: ReactTestRenderer;
    act(() => {
      t = create(
        <Camera
          engine="sweep"
          defaultCaptureSource="non-ar"
          onError={(e: unknown) => { errors.push(e as { code: string }); }}
        />,
      );
    });
    await flush();
    act(() => { (surface(t).props.onSweepingChange as (v: boolean) => void)(true); });
    act(() => { RN.__emitAppState('background'); });
    expect(errors.map((e) => e.code)).toEqual(['CAPTURE_INTERRUPTED']);
    act(() => { t.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: backgrounding at idle reports nothing', async () => {
    const errors: unknown[] = [];
    let t!: ReactTestRenderer;
    act(() => {
      t = create(
        <Camera engine="sweep" defaultCaptureSource="non-ar" onError={(e: unknown) => { errors.push(e); }} />,
      );
    });
    await flush();
    act(() => { RN.__emitAppState('background'); });
    expect(errors).toEqual([]);
    act(() => { t.unmount(); });
  });
});

describe('<Camera> refuses an iOS multi-lens mount before the hold (M5 review)', () => {
  const mountOn = async (physicalDevices: string[], depth: boolean) => {
    (Platform as { OS: string }).OS = 'ios';
    const dev = { ...DEVICE, id: 'virtual-0', physicalDevices, isMultiCam: physicalDevices.length > 1 };
    vc.useCameraDevice = () => dev;
    vc.useCameraDevices = () => [dev];
    let t!: ReactTestRenderer;
    act(() => {
      t = create(<Camera engine="sweep" defaultCaptureSource="non-ar" captureDepthData={depth} />);
    });
    await flush();
    await act(async () => { jest.advanceTimersByTime(1000); await Promise.resolve(); });
    return t;
  };

  it('photo depth on a Dual Wide mount: the hold is refused by name, and the message says why', async () => {
    const t = await mountOn(['ultra-wide-angle-camera', 'wide-angle-camera'], true);
    const refusal = surface(t).props.hostArmRefusal as { code: string; message: string } | null;
    expect(refusal?.code).toBe('panoplus-vc-device-unsupported');
    expect(refusal?.message).toMatch(/photo depth/);
    act(() => { t.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: the LiDAR depth mount (its sensor reported as a second wide) is not refused for it', async () => {
    const t = await mountOn(['wide-angle-camera', 'wide-angle-camera'], true);
    const refusal = surface(t).props.hostArmRefusal as { code: string } | null;
    expect(refusal?.code).not.toBe('panoplus-vc-device-unsupported');
    act(() => { t.unmount(); });
  });
});
