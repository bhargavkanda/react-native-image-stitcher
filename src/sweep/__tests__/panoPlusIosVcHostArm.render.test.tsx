// SPDX-License-Identifier: Apache-2.0
/**
 * M5 — the iOS sweep on `<Camera>`'s own camera, driven through the surface.
 *
 * Until M5 an iOS non-AR sweep opened pano+'s OWN AVCaptureSession, read a
 * calibration store for τ and the basis, and fell back to ARKit when either
 * was missing. On the host arm none of that may happen:
 *
 *   · no calibration read, and no ARKit fallback — τ is 0 by default (D2) and
 *     the basis is derived natively at the hold (D3);
 *   · the bag carries the plugin arm, the camera id and `tauUncorrected`;
 *   · native must CONFIRM it ran on vision-camera's camera, or the sweep is
 *     cancelled and refused by name (an old binary would have opened its own);
 *   · a device-level refusal the frame processor reports mid-sweep ends the
 *     sweep by name, finalized (the pack is evidence), not left to paint
 *     nothing.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';

const NM = NativeModules as Record<string, unknown>;

let startedWith: Record<string, unknown> | null = null;
let startAnswer: (o: Record<string, unknown>) => Record<string, unknown>;
let statusAnswer: () => Record<string, unknown>;
const calls: string[] = [];
const plannedCaptureFormat = jest.fn(() => Promise.resolve({ ok: false }));

function installNative(): void {
  startedWith = null;
  calls.length = 0;
  plannedCaptureFormat.mockClear();
  startAnswer = (o) => ({
    sessionDir: o.sessionDir,
    startedAtMs: 1,
    pluginAvailable: true,
    poseSource: 'imu',
    frameSource: 'vc-plugin',
    opensAvCaptureSession: false,
  });
  statusAnswer = () => ({ running: false });
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      calls.push('start');
      return Promise.resolve(startAnswer(o));
    },
    stop: () => { calls.push('stop'); return Promise.resolve({}); },
    cancel: () => { calls.push('cancel'); return Promise.resolve({ cancelled: true }); },
    getStatus: () => Promise.resolve(statusAnswer()),
    setIdlePreview: (on: boolean) => Promise.resolve({ on, reason: '' }),
    getConstants: () => ({ documentDirectory: 'file:///var/mobile/Documents/', vcArmSupported: true }),
    documentDirectory: 'file:///var/mobile/Documents/',
    vcArmSupported: true,
  };
  NM.RNSSweepCalibration = {
    plannedCaptureFormat,
    getCalibration: plannedCaptureFormat,
    startBasisCalibration: jest.fn(),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'ios';
  installNative();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

interface Handle { holdStart: () => void; holdEnd: () => void }

function mount(
  props: Record<string, unknown>,
): { tree: ReactTestRenderer; handle: React.RefObject<Handle | null> } {
  const handle = React.createRef<Handle | null>() as React.RefObject<Handle | null>;
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<PanoPlusCaptureSurface ref={handle as never} {...(props as any)} />);
  });
  return { tree, handle };
}

const HOST_ARM = {
  frameSource: 'host',
  poseSource: 'imu',
  vcPluginArm: true,
  vcCameraId: 'com.apple.avfoundation.avcapturedevice.built-in_video:0',
};

async function hold(handle: React.RefObject<Handle | null>): Promise<void> {
  act(() => { handle.current?.holdStart(); });
  await act(async () => { jest.advanceTimersByTime(1500); await Promise.resolve(); await Promise.resolve(); });
}

describe('M5 — the iOS host arm', () => {
  it('reads NO calibration store, and sends the plugin arm with τ = 0', async () => {
    const { tree, handle } = mount(HOST_ARM);
    await act(async () => { await Promise.resolve(); });
    expect(plannedCaptureFormat).not.toHaveBeenCalled();
    await hold(handle);
    expect(startedWith).not.toBeNull();
    const bag = startedWith as Record<string, unknown>;
    expect(bag.poseSource).toBe('imu');
    expect(bag.vcPluginArm).toBe(true);
    expect(bag.vcCameraId).toBe(HOST_ARM.vcCameraId);
    expect(bag.tauUncorrected).toBe(true);
    expect('allowOwnCamera' in bag).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: the own-camera iOS arm still reads the store (the hatch)', async () => {
    const { tree } = mount({ frameSource: 'own', poseSource: 'imu' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(plannedCaptureFormat).toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  it('⚑ a start native does not confirm ran on vision-camera is cancelled and refused by name', async () => {
    startAnswer = (o) => ({ sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true, poseSource: 'imu' });
    const failures: Array<{ code: string }> = [];
    const { tree, handle } = mount({ ...HOST_ARM, onFailure: (f: { code: string }) => failures.push(f) });
    await hold(handle);
    expect(calls).toContain('cancel');
    expect(failures.map((f) => f.code)).toEqual(['panoplus-vc-arm-unavailable']);
    act(() => { tree.unmount(); });
  });

  it('⚑ a device-level refusal mid-sweep ends the sweep BY NAME — finalized, not cancelled', async () => {
    const failures: Array<{ code: string; sessionDir: string | null }> = [];
    const { tree, handle } = mount({
      ...HOST_ARM,
      onFailure: (f: { code: string; sessionDir: string | null }) => failures.push(f),
    });
    await hold(handle);
    expect(calls).toEqual(['start']);
    const dir = (startedWith as Record<string, unknown>).sessionDir as string;
    let seq = 0;
    statusAnswer = () => {
      seq += 1;
      return { running: true, sessionDir: dir, seq, vcDeviceRefusal: 'rotated-buffer' };
    };
    await act(async () => { jest.advanceTimersByTime(400); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).toContain('stop');
    expect(calls).not.toContain('cancel');
    expect(failures.map((f) => f.code)).toEqual(['panoplus-vc-device-unsupported']);
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a status with no refusal leaves the sweep running', async () => {
    const failures: unknown[] = [];
    const { tree, handle } = mount({ ...HOST_ARM, onFailure: (f: unknown) => failures.push(f) });
    await hold(handle);
    const dir = (startedWith as Record<string, unknown>).sessionDir as string;
    let seq = 0;
    statusAnswer = () => { seq += 1; return { running: true, sessionDir: dir, seq }; };
    await act(async () => { jest.advanceTimersByTime(400); await Promise.resolve(); await Promise.resolve(); });
    expect(calls).not.toContain('stop');
    expect(failures).toEqual([]);
    act(() => { tree.unmount(); });
  });
});
