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

/**
 * M9 review — T9: a DESELECT inside the start window is an unmount without the
 * unmount, not a release.
 *
 * `<Camera>` deselects the engine when the host switches `engine`, and when a
 * review opens. If that lands while native is still opening the camera, the
 * hook used to latch it as the OPERATOR'S RELEASE (`stopOnStartRef`), so the
 * start resolved into `finish()` and REPORTED a near-empty pack — `onComplete`,
 * or `onFailure` on an empty one — to a host that had already left the sweep.
 * It now stops the session silently (the pack kept, never cancelled), as a
 * deselect mid-sweep and an unmount mid-start already did.
 */
describe('M9 review T9 — a deselect while native is STARTING is silent', () => {
  let resolveStart: (() => void) | null = null;
  let rejectStart: ((e: unknown) => void) | null = null;
  function holdNativeStart(): void {
    resolveStart = null;
    rejectStart = null;
    (NM.RNSSweepSession as Record<string, unknown>).start = (o: Record<string, unknown>) => {
      calls.push('start');
      startedWith = o;
      return new Promise((res, rej) => {
        resolveStart = () => res({
          sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
          poseSource: 'imu', frameSource: 'vc-plugin',
        });
        rejectStart = rej;
      });
    };
  }
  function surfaceWith(log: string[]): Record<string, unknown> {
    return {
      frameSource: 'host', poseSource: 'imu', vcPluginArm: true, vcCameraId: 'cam-1',
      onSweepingChange: (v: boolean) => { log.push(`sweeping:${v}`); },
      onComplete: () => { log.push('complete'); },
      onFailure: (f: { code: string }) => { log.push(`failure:${f.code}`); },
    };
  }
  /** Mount enabled, press, and leave native's start UNANSWERED. */
  async function pressIntoStartWindow(log: string[]) {
    holdNativeStart();
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    const surface = surfaceWith(log);
    let t!: ReactTestRenderer;
    act(() => { t = create(<Probe enabled handle={handle} surface={surface} />); });
    await flush();
    act(() => { handle.current?.holdStart?.(); });
    await flush(1500);
    // PRECONDITION: native was asked, and has not answered — the window.
    expect(calls).toContain('start');
    expect(resolveStart).not.toBeNull();
    expect(log).toContain('sweeping:true');
    calls.length = 0;
    log.length = 0;
    return { t, handle, surface };
  }

  it('the start resolves into a SILENT stop: stopped (pack kept), never cancelled, no report but sweeping:false', async () => {
    // Pins `deselectOnStartRef` in the enabled-falling effect and its branch
    // in the start's resolution.
    // MUTATION: the effect sets `stopOnStartRef` again (the old code) → the
    // start resolves into `finish()` and `onComplete` fires. Killed.
    const log: string[] = [];
    const { t, handle, surface } = await pressIntoStartWindow(log);
    act(() => { t.update(<Probe enabled={false} handle={handle} surface={surface} />); });
    await flush();
    await act(async () => { resolveStart?.(); });
    await flush(1500);
    expect(calls).toContain('stop');
    expect(calls).not.toContain('cancel');
    expect(log).not.toContain('complete');
    expect(log.filter((l) => l.startsWith('failure:'))).toEqual([]);
    expect(log).toContain('sweeping:false');
    expect(log[log.length - 1]).toBe('sweeping:false');
    act(() => { t.unmount(); });
  });

  it('a start that REJECTS after the deselect reports no failure', async () => {
    // Pins `if (deselected) return;` in the start's rejection handler.
    // MUTATION: delete it → `onFailure` fires for a sweep the host has left.
    // Killed.
    const log: string[] = [];
    const { t, handle, surface } = await pressIntoStartWindow(log);
    act(() => { t.update(<Probe enabled={false} handle={handle} surface={surface} />); });
    await flush();
    await act(async () => {
      rejectStart?.({ code: 'panoplus-camera-failed', message: 'camera open failed' });
    });
    await flush(1500);
    expect(log.filter((l) => l.startsWith('failure:'))).toEqual([]);
    expect(log).not.toContain('complete');
    expect(calls).not.toContain('cancel');
    expect(log).toContain('sweeping:false');
    act(() => { t.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a RELEASE in the same window still finishes AND reports', async () => {
    // The operator's release is not a deselect: it keeps what was painted and
    // the host hears about it. Without this the two cases above pass for a
    // start window that swallows EVERY outcome.
    const log: string[] = [];
    const { t, handle } = await pressIntoStartWindow(log);
    act(() => { handle.current?.holdEnd?.(); });
    await flush();
    await act(async () => { resolveStart?.(); });
    await flush(1500);
    expect(calls).toContain('stop');
    expect(log.some((l) => l === 'complete' || l.startsWith('failure:'))).toBe(true);
    act(() => { t.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a start that rejects with the engine STILL selected is reported', async () => {
    const log: string[] = [];
    const { t } = await pressIntoStartWindow(log);
    await act(async () => {
      rejectStart?.({ code: 'panoplus-camera-failed', message: 'camera open failed' });
    });
    await flush(1500);
    expect(log).toContain('failure:panoplus-camera-failed');
    act(() => { t.unmount(); });
  });
});

/**
 * M9 review — T10, the hook half: a rejected native STOP is reported with
 * `stage: 'finish'`, the one field that lets `<Camera>` say
 * PANORAMA_FINALIZE_FAILED for a sweep that started, ran, and failed to write
 * rather than PANORAMA_START_FAILED. The `<Camera>` half, through the real
 * engine, is in cameraSweepM9Review.render.test.tsx.
 */
describe('M9 review T10 — the finish stage, from the real hook', () => {
  it('native stop rejects panoplus-io → onFailure receives stage "finish"', async () => {
    // MUTATION: drop `stage: 'finish'` from `finish()`'s onFailure. Killed.
    const failures: Array<Record<string, unknown>> = [];
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    const surface = {
      frameSource: 'host', poseSource: 'imu', vcPluginArm: true, vcCameraId: 'cam-1',
      onFailure: (f: Record<string, unknown>) => { failures.push(f); },
    };
    (NM.RNSSweepSession as Record<string, unknown>).stop = () => {
      calls.push('stop');
      return Promise.reject({ code: 'panoplus-io', message: 'canvas write failed' });
    };
    let t!: ReactTestRenderer;
    act(() => { t = create(<Probe enabled handle={handle} surface={surface} />); });
    await flush();
    act(() => { handle.current?.holdStart?.(); });
    await flush(1500);
    expect(failures).toEqual([]);             // the start was clean
    act(() => { handle.current?.holdEnd?.(); });
    await flush(100);
    expect(calls).toContain('stop');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual(expect.objectContaining({
      code: 'panoplus-io', stage: 'finish',
    }));
    // A failed write that is not `not-running` keeps the pack.
    expect(calls).not.toContain('cancel');
    act(() => { t.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a START failure carries no finish stage', async () => {
    // Without this the case above passes for a stage stamped on every failure,
    // which would turn every refused start into a "finalize" failure.
    const failures: Array<Record<string, unknown>> = [];
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    const surface = {
      frameSource: 'host', poseSource: 'imu', vcPluginArm: true, vcCameraId: 'cam-1',
      onFailure: (f: Record<string, unknown>) => { failures.push(f); },
    };
    (NM.RNSSweepSession as Record<string, unknown>).start = () =>
      Promise.reject({ code: 'panoplus-io', message: 'could not create the pack' });
    let t!: ReactTestRenderer;
    act(() => { t = create(<Probe enabled handle={handle} surface={surface} />); });
    await flush();
    act(() => { handle.current?.holdStart?.(); });
    await flush(1500);
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe('panoplus-io');
    expect(failures[0].stage).not.toBe('finish');
    act(() => { t.unmount(); });
  });
});

describe('useSweepEngine — the host hears from the SELECTED engine only (M8)', () => {
  function surfaceWith(log: string[]): Record<string, unknown> {
    return {
      frameSource: 'own', poseSource: 'imu',
      onSweepingChange: (v: boolean) => { log.push(`sweeping:${v}`); },
      onPaintedChange: (n: number) => { log.push(`painted:${n}`); },
      onEffectiveArmChange: () => { log.push('arm'); },
      onControlsState: () => { log.push('controls'); },
    };
  }

  it('not selected: no report at all, however often the caller re-renders', async () => {
    const log: string[] = [];
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    let t!: ReactTestRenderer;
    act(() => { t = create(<Probe enabled={false} handle={handle} surface={surfaceWith(log)} />); });
    await flush(500);
    // A fresh props object with fresh callbacks — what `<Camera>` passes on
    // every render.
    act(() => { t.update(<Probe enabled={false} handle={handle} surface={surfaceWith(log)} />); });
    await flush(500);
    expect(log).toEqual([]);
    act(() => { t.unmount(); });
  });

  it('the rising edge reports every channel once, and a same-valued re-render reports none', async () => {
    const log: string[] = [];
    const handle = React.createRef<SweepSurfaceHandle | null>() as React.RefObject<SweepSurfaceHandle | null>;
    let t!: ReactTestRenderer;
    act(() => { t = create(<Probe enabled={false} handle={handle} surface={surfaceWith(log)} />); });
    await flush(500);
    act(() => { t.update(<Probe enabled handle={handle} surface={surfaceWith(log)} />); });
    await flush(500);
    expect(log).toEqual(expect.arrayContaining(['sweeping:false', 'painted:0', 'arm', 'controls']));
    log.length = 0;
    act(() => { t.update(<Probe enabled handle={handle} surface={surfaceWith(log)} />); });
    await flush(500);
    expect(log).toEqual([]);
    act(() => { t.unmount(); });
  });
});
