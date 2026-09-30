// SPDX-License-Identifier: Apache-2.0
/**
 * M8 — the finish ORDERING table: the camera is released by native BEFORE
 * `<Camera>` unmounts it.
 *
 * A stop tears the sweep's arm down (plugin disarmed, camera lock released)
 * and only then writes the canvas and the pack. `<Camera>` must keep its
 * camera mounted until native says the release point has passed
 * (`status.cameraReleased`), then unmount it for the rest of the finish — the
 * keyframe engine's stitching rule — and mount it again when the finish ends.
 *
 *   phase                      | camera mounted | status overlay
 *   ---------------------------+----------------+---------------
 *   sweeping                   | yes            | recording
 *   finishing, not released    | yes            | idle
 *   finishing, released        | NO             | stitching
 *   finish resolved            | yes            | idle
 *
 * M8 review — the rows the table left out:
 *
 *   engine deselected while stitching | yes, at once | idle, and the capture
 *                                     |              | still reaches the host
 *   finish resolves into the review   | yes, behind  | idle, same tick
 *   native never names the field      | yes          | idle (older binary)
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';
import { VisionCameraProxy } from 'react-native-vision-camera';

// `writeAsStringAsync` is a SINK so the sweep's timeline sidecar — the one
// place the finish's ORDER is recorded rather than only rendered — can be read
// back. A module-level global, because a `jest.mock` factory cannot close
// over this file's own bindings.
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: () => Promise.resolve(''),
  writeAsStringAsync: (uri: string, body: string) => {
    (globalThis as unknown as { __finishOrderWritten: Array<unknown> }).__finishOrderWritten
      .push({ uri, body });
    return Promise.resolve();
  },
  deleteAsync: () => Promise.resolve(),
  getInfoAsync: () => Promise.resolve({ exists: false }),
  readDirectoryAsync: () => Promise.resolve([]),
  copyAsync: () => Promise.resolve(),
}), { virtual: true });
const written: Array<{ uri: string; body: string }> = [];
(globalThis as unknown as { __finishOrderWritten: unknown[] }).__finishOrderWritten = written;

import { Camera } from '../../camera/Camera';
import { CameraView } from '../../camera/CameraView';
import { CaptureStatusOverlay } from '../../camera/CaptureStatusOverlay';

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

let released: boolean | undefined = false;
/** Native's release STAMP — taken the first time a status reports the
 *  release, and answered from then on, as the bridge's static is. */
let releasedAtMs: number | null = null;
let resolveStop: ((v: unknown) => void) | null = null;
let sessionDir = '';

/** What a finishing status answers about the release. An OLDER binary
 *  (`released === undefined`) names neither key. */
function releaseKeys(): Record<string, unknown> {
  if (released === undefined) return {};
  if (released && releasedAtMs == null) releasedAtMs = Date.now();
  return { cameraReleased: released, cameraReleasedAtMs: released ? releasedAtMs : 0 };
}

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  released = false;
  releasedAtMs = null;
  written.length = 0;
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
    // Once the sweep is stopping the core answers `running: false` — which is
    // exactly why `cameraReleased` has to be read regardless of it.
    getStatus: () => Promise.resolve(
      resolveStop == null
        ? { running: true, sessionDir, seq: 1, painted: 5 }
        : { running: false, ...releaseKeys() },
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

const cameraMounted = (t: ReactTestRenderer) => t.root.findAllByType(CameraView).length === 1;

/** Start a sweep, stop it, and let native pass the release point. */
async function toStitching(ref: React.RefObject<any>): Promise<void> {
  await act(async () => { ref.current.startPanorama(); });
  await tick(300);
  await act(async () => { await ref.current.stopPanorama(); });
  await tick(300);
  released = true;
  await tick(300);
}

async function resolveFinish(): Promise<void> {
  await act(async () => {
    resolveStop?.({
      width: 100, height: 50, sessionDir, canvasPath: `${sessionDir}/canvas.jpg`,
      counts: {}, abort: null,
    });
    await Promise.resolve();
    await Promise.resolve();
  });
}
const overlayPhase = (t: ReactTestRenderer) =>
  t.root.findAllByType(CaptureStatusOverlay)[0]?.props.phase as string;

/** The sweep's `host_sweep_timeline.json`, parsed — exactly one, in the
 *  sweep's own session directory. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function timeline(): Record<string, any> {
  const files = written.filter((w) => w.uri.endsWith('/host_sweep_timeline.json'));
  expect(files.map((w) => w.uri)).toEqual([`file://${sessionDir}/host_sweep_timeline.json`]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse(files[0]!.body) as Record<string, any>;
}

describe('M8 — a sweep\'s finish releases the camera natively BEFORE <Camera> unmounts it', () => {
  it('walks the table', async () => {
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview={false} />,
      );
    });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    // sweeping
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('recording');

    // finishing, not yet released: the camera STAYS
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(300);
    expect(resolveStop).not.toBeNull();
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('idle');

    // native passes the release point: now, and only now, it unmounts
    released = true;
    await tick(300);
    expect(cameraMounted(tree)).toBe(false);
    expect(overlayPhase(tree)).toBe('stitching');

    // the finish resolves: the camera comes back
    await act(async () => {
      resolveStop?.({
      width: 100, height: 50, sessionDir, canvasPath: `${sessionDir}/canvas.jpg`,
      counts: {}, abort: null,
    });
      await Promise.resolve();
      await Promise.resolve();
    });
    await tick(100);
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('idle');
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a finish native never reports released keeps the camera up throughout', async () => {
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview={false} />,
      );
    });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(2000);
    expect(cameraMounted(tree)).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ M8 review: the release poll keeps ONE read in flight — a native answer that never comes does not pile reads up', async () => {
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview={false} />,
      );
    });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    // From the stop on, native's status queue is wedged (the Android shape
    // before the lock-free read: a status call queued behind the finalize).
    const session = NM.RNSSweepSession as Record<string, unknown>;
    let reads = 0;
    session.getStatus = () => { reads += 1; return new Promise(() => undefined); };
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(2000);   // twenty poll intervals
    expect(reads).toBe(1);
    expect(cameraMounted(tree)).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ an OLDER binary that never names `cameraReleased` keeps the camera up throughout', async () => {
    released = undefined;   // the status answer carries no such field
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview={false} />,
      );
    });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(2000);
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('idle');
    // …and its timeline records exactly that: polls answered, no release
    // seen, no stitching, no stamp — and an order with nothing broken in it.
    await resolveFinish();
    await tick(100);
    const f = timeline().finish;
    expect(f.releasePoll.answered).toBeGreaterThan(0);
    expect(f.cameraReleasedSeenAtMs).toBeNull();
    expect(f.stitchingReportedAtMs).toBeNull();
    expect(f.nativeCameraReleasedAtMs).toBeNull();
    expect(f.releasedBySettle).toBe(false);
    expect(f.derived.cameraUnmountedDuringFinish).toBe(false);
    expect(f.derived.orderOk).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ the finish is WRITTEN in the order it happened — finishing, release seen, stitching, settled', async () => {
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview={false} />,
      );
    });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(300);
    // ⚠ ONE MORE SWEEPING TICK BEFORE THE STOP, and it is about the fake
    // clock, not the engine. `tick` fires every interval inside one
    // synchronous advance, so the polls it issues are ANSWERED at the
    // advance's end — the same instant a stop called straight after stamps
    // the finish, which the window (half-open) rightly counts as after it.
    await tick(300);
    await act(async () => { await ref.current.stopPanorama(); });
    await tick(300);
    released = true;
    await tick(300);
    expect(overlayPhase(tree)).toBe('stitching');
    await resolveFinish();
    await tick(100);
    const t = timeline();
    const f = t.finish;
    expect(t.outcome).toBe('resolved');
    expect(f.finishingAtMs).not.toBeNull();
    expect(f.cameraReleasedSeenAtMs).not.toBeNull();
    expect(f.stitchingReportedAtMs).not.toBeNull();
    expect(f.finishingAtMs).toBeLessThanOrEqual(f.cameraReleasedSeenAtMs);
    expect(f.cameraReleasedSeenAtMs).toBeLessThanOrEqual(f.stitchingReportedAtMs);
    expect(f.stitchingReportedAtMs).toBeLessThanOrEqual(f.stopSettledAtMs);
    // Native's own stamp, no later than the poll that saw it.
    expect(f.nativeCameraReleasedAtMs).toBe(releasedAtMs);
    expect(f.nativeCameraReleasedAtMs).toBeLessThanOrEqual(f.cameraReleasedSeenAtMs);
    expect(f.releasedBySettle).toBe(true);
    expect(f.finishingHeadline).toBe('Finishing the panorama…');
    expect(f.derived.cameraUnmountedDuringFinish).toBe(true);
    expect(f.derived.orderOk).toBe(true);
    expect(f.derived.orderViolations).toEqual([]);
    // THE STATUS RATE ON ANDROID'S VISION-CAMERA ARM: there is no push channel —
    // the status reaches JS by the fast poll alone, and the file says which.
    expect(t.platform).toBe('android');
    expect(t.context.frameSource).toBe('host');
    expect(t.context.statusPollMs).toBe(125);
    expect(t.statusRate.push.ticks).toBe(0);
    expect(t.statusRate.push.empty).toBe(0);
    expect(t.statusRate.poll.ticks).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });

  it('⚑ M8 review: the engine deselected WHILE STITCHING brings the camera back at once, and the capture still lands', async () => {
    const captures: Array<{ ok?: boolean }> = [];
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    const el = (engine: 'sweep' | 'keyframe') => (
      <Camera ref={ref} engine={engine} defaultCaptureSource="non-ar" panMode="both"
        rectCrop={false} showPreview={false}
        onCapture={(r: { ok?: boolean }) => { captures.push(r); }} />
    );
    act(() => { tree = create(el('sweep')); });
    await tick(0);
    await toStitching(ref);
    expect(cameraMounted(tree)).toBe(false);
    expect(overlayPhase(tree)).toBe('stitching');

    act(() => { tree.update(el('keyframe')); });
    await tick(0);
    // The keyframe screen is not left without a camera, or stuck on
    // "stitching", for a finish that belongs to another engine.
    expect(cameraMounted(tree)).toBe(true);
    expect(overlayPhase(tree)).toBe('idle');

    // …and the sweep the operator made is not lost: the finish still reports.
    await resolveFinish();
    await tick(100);
    expect(captures.filter((c) => c.ok !== false)).toHaveLength(1);
    expect(cameraMounted(tree)).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ M8 review: a finish that opens the review brings the camera back in the SAME tick, behind it', async () => {
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
          rectCrop={false} showPreview />,
      );
    });
    await tick(0);
    await toStitching(ref);
    expect(cameraMounted(tree)).toBe(false);
    // No timer advance: the resolution alone must end "stitching".
    await resolveFinish();
    expect(overlayPhase(tree)).not.toBe('stitching');
    expect(cameraMounted(tree)).toBe(true);
    act(() => { tree.unmount(); });
  });
});
