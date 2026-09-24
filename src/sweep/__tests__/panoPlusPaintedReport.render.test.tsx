// SPDX-License-Identifier: Apache-2.0
//
// THE SURFACE REPORTS ITS PROGRESS — `onPaintedChange`, mounted for real.
//
// `<Camera>`'s lateral-stop policy counts the engine's own progress: keyframes
// on one engine, strips painted on this one. Everything it knows about the
// sweep's progress arrives through this one callback, and the guard-rail suite
// drives `<Camera>` through a STUB that reports it by hand. A stub is a
// contract, so the real surface is held to the same one here: the live
// status's `painted` on every change, and 0 whenever no sweep is live —
// after a finish AND after an abandon.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///var/mobile/Documents/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: () => Promise.resolve(),
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
import type { SweepSurfaceHandle } from '../panoPlusTypes';
import { holdShutter, releaseShutter } from './shutterGestures';
import { PANO_PLUS_STATUS_POLL_MS, PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';

const NM = NativeModules as Record<string, unknown>;
let statusReply: Record<string, unknown> = { running: false };

function installNative(): void {
  statusReply = { running: false };
  NM.RNISPanoPlus = {
    start: () => Promise.resolve({
      sessionDir: '/var/mobile/Documents/pano_1', startedAtMs: 1, pluginAvailable: true,
    }),
    stop: () => Promise.resolve({ sessionDir: '/var/mobile/Documents/pano_1' }),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve(statusReply),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}
async function poll(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(PANO_PLUS_STATUS_POLL_MS + 1);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

function mount(reported: number[]): {
  renderer: ReactTestRenderer; ref: React.RefObject<SweepSurfaceHandle | null>;
} {
  const ref = React.createRef<SweepSurfaceHandle>();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PanoPlusCaptureSurface
        ref={ref}
        onComplete={() => undefined}
        onCancel={() => undefined}
        onPaintedChange={(n: number) => { reported.push(n); }}
      />,
    );
  });
  act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
  return { renderer, ref };
}

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
});
afterEach(() => {
  jest.useRealTimers();
  Platform.OS = 'ios';
  delete NM.RNISPanoPlus;
});

const last = (xs: number[]): number | undefined => xs[xs.length - 1];

it('reports the live status\'s painted count, and 0 after the sweep finishes', async () => {
  const reported: number[] = [];
  const { renderer } = mount(reported);
  await settle();
  expect(last(reported)).toBe(0);
  holdShutter(renderer.root);
  await settle();
  statusReply = { running: true, seq: 3, painted: 7, framesSeen: 20 };
  await poll();
  expect(last(reported)).toBe(7);
  statusReply = { running: true, seq: 4, painted: 12, framesSeen: 30 };
  await poll();
  expect(last(reported)).toBe(12);
  releaseShutter(renderer.root);
  await settle();
  await poll();
  expect(last(reported)).toBe(0);
  act(() => { renderer.unmount(); });
});

it('reports 0 when a live sweep is ABANDONED — a guard rail must not see stale progress', async () => {
  const reported: number[] = [];
  const { renderer, ref } = mount(reported);
  await settle();
  holdShutter(renderer.root);
  await settle();
  statusReply = { running: true, seq: 5, painted: 9, framesSeen: 25 };
  await poll();
  expect(last(reported)).toBe(9);
  act(() => { ref.current?.abandon?.('lateral-drift'); });
  await settle();
  expect(last(reported)).toBe(0);
  act(() => { renderer.unmount(); });
});
