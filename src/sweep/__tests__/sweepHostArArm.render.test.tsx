// SPDX-License-Identifier: Apache-2.0
/**
 * M8 — the sweep on `<Camera>`'s OWN AR view (`frameSource: 'host-ar'`).
 *
 * The AR session on screen is the camera. The only arm that may run is the
 * one that reads that session's frames (iOS: the ARKit arm on the stitcher's
 * session; Android: `PanoStartMode.AR_PLUGIN`). Anything else opened a camera
 * of its own behind the AR view, so:
 *
 *   · a hold that resolves to the non-AR arm never starts — refused by name
 *     (`panoplus-refused-wrong-arm`), not handed to a second camera;
 *   · a start native answers with any arm but 'ar' — including NO answer — is
 *     cancelled at once and refused (`panoplus-vc-arm-unavailable`, which
 *     `<Camera>` reports as ENGINE_UNAVAILABLE). Fail closed on an absent echo.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

import { useSweepEngine } from '../useSweepEngine';
import type { SweepSurfaceHandle } from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;
const calls: string[] = [];
let startedWith: Record<string, unknown> | null = null;
let echo: Record<string, unknown> = {};

function install(): void {
  calls.length = 0;
  startedWith = null;
  echo = { poseSource: 'ar' };
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      calls.push('start');
      startedWith = o;
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true, ...echo,
      });
    },
    stop: () => { calls.push('stop'); return Promise.resolve({}); },
    cancel: () => { calls.push('cancel'); return Promise.resolve({ cancelled: true }); },
    getStatus: () => Promise.resolve({ running: true }),
    setIdlePreview: () => Promise.resolve({ on: false }),
    getConstants: () => ({ documentDirectory: 'file:///docs/', vcArmSupported: true }),
    documentDirectory: 'file:///docs/',
    vcArmSupported: true,
  };
  NM.RNSSweepCalibration = {
    plannedCaptureFormat: () => Promise.resolve({ ok: false }),
    getCalibration: () => Promise.resolve({}),
    startBasisCalibration: () => undefined,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  install();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

function Probe(props: {
  surface: Record<string, unknown>;
  handle: React.RefObject<SweepSurfaceHandle | null>;
}): null {
  useSweepEngine(props.surface as never, props.handle as never, { enabled: true });
  return null;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function holdOn(
  os: string, poseSource: 'ar' | 'imu',
): Promise<{ t: ReactTestRenderer; failures: string[] }> {
  (Platform as { OS: string }).OS = os;
  const failures: string[] = [];
  const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
  let t!: ReactTestRenderer;
  act(() => {
    t = create(
      <Probe
        handle={handle}
        surface={{
          frameSource: 'host-ar',
          poseSource,
          onFailure: (f: { code: string }) => { failures.push(f.code); },
        }}
      />,
    );
  });
  await flush(1500);
  await act(async () => { (handle.current as unknown as { holdStart: () => void }).holdStart(); });
  await flush(300);
  return { t, failures };
}

describe.each(['ios', 'android'])('%s — the sweep on <Camera>\'s own AR view', (os) => {
  it('⚑ NEGATIVE CONTROL: native answers the AR arm → the sweep runs', async () => {
    const { t, failures } = await holdOn(os, 'ar');
    expect(calls).toEqual(['start']);
    expect(failures).toEqual([]);
    expect(startedWith?.poseSource).toBe('ar');
    act(() => { t.unmount(); });
  });

  it('native answers the IMU arm → cancelled at once and refused by name', async () => {
    echo = { poseSource: 'imu' };
    const { t, failures } = await holdOn(os, 'ar');
    expect(calls).toEqual(['start', 'cancel']);
    expect(failures).toEqual(['panoplus-vc-arm-unavailable']);
    act(() => { t.unmount(); });
  });

  it('⚑ M8 review: native answers NO arm → fail closed, cancelled and refused', async () => {
    echo = {};
    const { t, failures } = await holdOn(os, 'ar');
    expect(calls).toEqual(['start', 'cancel']);
    expect(failures).toEqual(['panoplus-vc-arm-unavailable']);
    act(() => { t.unmount(); });
  });

  it('a hold asking for the non-AR arm never STARTS it: refused by name, or run on the AR arm', async () => {
    const { t, failures } = await holdOn(os, 'imu');
    // Whatever happens, no start ever carries a non-AR arm under 'host-ar'.
    if (calls.includes('start')) expect(startedWith?.poseSource).toBe('ar');
    if (os === 'android') {
      expect(calls).not.toContain('start');
      expect(failures).toEqual(['panoplus-refused-wrong-arm']);
    } else {
      // iOS resolves the arm through its calibration ladder first, and with
      // no calibration on file the ladder falls back to ARKit — which on
      // 'host-ar' IS the session on screen. The guard is the backstop for an
      // arm that stays non-AR after the ladder (Android's has no fallback).
      expect(calls).toEqual(['start']);
      expect(startedWith?.poseSource).toBe('ar');
      expect(failures).toEqual([]);
    }
    act(() => { t.unmount(); });
  });
});
