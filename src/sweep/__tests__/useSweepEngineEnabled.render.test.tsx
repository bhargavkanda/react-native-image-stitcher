// SPDX-License-Identifier: Apache-2.0
/**
 * M8a — `useSweepEngine(props, ref, { enabled })`.
 *
 * `<Camera>` mounts the sweep engine on every engine, so a hook that is not
 * selected must touch nothing native: no calibration or lens read, no ARCore
 * probe, no idle viewfinder, no start. And a host that deselects it mid-sweep
 * ends the sweep the way an unmount does — STOPPED (the pack is finalized and
 * kept), never cancelled — with `onSweepingChange(false)` reported.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

import { useSweepEngine } from '../useSweepEngine';
import type { SweepSurfaceHandle } from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;
const calls: string[] = [];
let startedWith: Record<string, unknown> | null = null;

function install(): void {
  calls.length = 0;
  startedWith = null;
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      calls.push('start');
      startedWith = o;
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: 'imu', frameSource: 'vc-plugin',
      });
    },
    stop: () => { calls.push('stop'); return Promise.resolve({}); },
    cancel: () => { calls.push('cancel'); return Promise.resolve({ cancelled: true }); },
    getStatus: () => Promise.resolve({ running: false }),
    setIdlePreview: () => { calls.push('setIdlePreview'); return Promise.resolve({ on: true }); },
    getConstants: () => ({ documentDirectory: 'file:///docs/', vcArmSupported: true }),
    documentDirectory: 'file:///docs/',
    vcArmSupported: true,
  };
  NM.RNSSweepCalibration = {
    plannedCaptureFormat: () => { calls.push('plannedCaptureFormat'); return Promise.resolve({ ok: false }); },
    getCalibration: () => { calls.push('getCalibration'); return Promise.resolve({}); },
    startBasisCalibration: () => undefined,
  };
  (NM.RNSARSession as Record<string, unknown>).isSupported = () => {
    calls.push('isSupported');
    return Promise.resolve(true);
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
  enabled: boolean;
  surface: Record<string, unknown>;
  handle: React.RefObject<SweepSurfaceHandle | null>;
}): null {
  useSweepEngine(props.surface as never, props.handle as never, { enabled: props.enabled });
  return null;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useSweepEngine — enabled: false touches nothing native', () => {
  it.each(['ios', 'android'])('%s: no calibration read, no probe, no idle viewfinder, no start', async (os) => {
    (Platform as { OS: string }).OS = os;
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    let t!: ReactTestRenderer;
    act(() => {
      t = create(<Probe enabled={false} handle={handle} surface={{ frameSource: 'own', poseSource: 'imu' }} />);
    });
    await flush(2000);
    act(() => { handle.current?.holdStart?.(); });
    await flush(1500);
    expect(calls).toEqual([]);
    act(() => { t.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: the same mount ENABLED does reach native', async () => {
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    let t!: ReactTestRenderer;
    act(() => {
      t = create(<Probe enabled handle={handle} surface={{ frameSource: 'own', poseSource: 'imu' }} />);
    });
    await flush(2000);
    expect(calls.length).toBeGreaterThan(0);
    act(() => { t.unmount(); });
  });
});

describe('useSweepEngine — enabled falling mid-sweep is an unmount, without the unmount', () => {
  it('the live sweep is STOPPED (pack kept), never cancelled, and the shell is told', async () => {
    const sweeping: boolean[] = [];
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    const surface = {
      frameSource: 'host', poseSource: 'imu', vcPluginArm: true, vcCameraId: 'cam-1',
      onSweepingChange: (v: boolean) => { sweeping.push(v); },
    };
    let t!: ReactTestRenderer;
    act(() => { t = create(<Probe enabled handle={handle} surface={surface} />); });
    await flush();
    act(() => { handle.current?.holdStart?.(); });
    await flush(1500);
    expect(startedWith).not.toBeNull();
    calls.length = 0;
    sweeping.length = 0;
    act(() => { t.update(<Probe enabled={false} handle={handle} surface={surface} />); });
    await flush();
    expect(calls).toContain('stop');
    expect(calls).not.toContain('cancel');
    expect(sweeping[sweeping.length - 1]).toBe(false);
    act(() => { t.unmount(); });
  });
});
