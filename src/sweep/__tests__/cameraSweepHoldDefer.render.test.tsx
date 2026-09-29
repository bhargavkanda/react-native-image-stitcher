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
 *
 * M8 review — what the wait must NOT be:
 *
 *   · the ROTATE PROMPT. It has its own state; it used to share the rotate
 *     gate's, and told the operator to rotate a phone that needed nothing;
 *   · UNBOUNDED. Only the plugin lookup is waited on. A camera with no device
 *     id used to be waited on too, forever and silently; the hold now goes
 *     through and is refused by name;
 *   · a shortcut past the other gates. It resumes through the whole
 *     dispatcher, so a gate that closed during the wait still applies;
 *   · a wait that outlives its engine.
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

// Every render's `visible`, so a prompt shown for a single commit — which a
// Modal still starts animating in — is caught, not just the settled state.
jest.mock('../../camera/RotateToLandscapePrompt', () => {
  const actual = jest.requireActual('../../camera/RotateToLandscapePrompt');
  const R = require('react');
  function RotateToLandscapePrompt(props: { visible: boolean }) {
    ((globalThis as any).__promptVisible ??= []).push(props.visible);
    return R.createElement(actual.RotateToLandscapePrompt, props);
  }
  return { ...actual, RotateToLandscapePrompt };
});

import { Camera } from '../../camera/Camera';
import { RotateToLandscapePrompt } from '../../camera/RotateToLandscapePrompt';

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
let device: typeof DEVICE | undefined = DEVICE;
const starts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  device = DEVICE;
  vc.useCameraDevice = () => device;
  vc.useCameraDevices = () => (device == null ? [] : [device]);
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

function el(
  ref: React.RefObject<any>, errors: string[], extra: Record<string, unknown> = {},
): React.JSX.Element {
  return (
    <Camera
      ref={ref}
      engine="sweep"
      defaultCaptureSource="non-ar"
      panMode="both"
      onError={(e: { code: string }) => { errors.push(e.code); }}
      {...(extra as object)}
    />
  );
}

async function mount(errors: string[]): Promise<{
  tree: ReactTestRenderer; ref: React.RefObject<any>;
}> {
  const ref = React.createRef<any>();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(el(ref, errors));
  });
  await tick(0);
  return { tree, ref };
}

const promptVisible = (t: ReactTestRenderer) =>
  t.root.findAllByType(RotateToLandscapePrompt).some((p) => p.props.visible === true);

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

  it('⚑ M8 review: the wait is NOT the rotate prompt — not even for one commit', async () => {
    const errors: string[] = [];
    const { tree, ref } = await mount(errors);
    (globalThis as any).__promptVisible = [];
    await act(async () => { ref.current.startPanorama(); });
    await tick(100);
    expect(starts).toHaveLength(0);            // it IS waiting…
    expect(promptVisible(tree)).toBe(false);   // …and asks for no rotation…
    pluginLanded = true;
    await tick(200);
    await tick(1500);
    expect(starts).toHaveLength(1);
    // …at any render along the way.
    expect((globalThis as any).__promptVisible).not.toContain(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ M8 review: a camera with no device is refused BY NAME at once, never waited on', async () => {
    device = undefined;
    pluginLanded = true;
    const errors: string[] = [];
    const { tree, ref } = await mount(errors);
    await tick(100);
    await act(async () => { ref.current.startPanorama(); });
    await tick(100);
    expect(starts).toHaveLength(0);
    // `panoplus-camera-not-ready` — this attempt failing, not a build fault.
    expect(errors).toEqual(['PANORAMA_START_FAILED']);
    act(() => { tree.unmount(); });
  });

  it('⚑ M8 review: the wait resumes through the WHOLE dispatcher — a gate that closed meanwhile still applies', async () => {
    const errors: string[] = [];
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => { tree = create(el(ref, errors)); });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(100);
    expect(starts).toHaveLength(0);
    // The host narrows the pan mode during the wait; the phone is portrait,
    // so 'vertical' now needs a rotation to landscape.
    act(() => { tree.update(el(ref, errors, { panMode: 'vertical' })); });
    pluginLanded = true;
    await tick(200);
    await tick(1500);
    expect(starts).toHaveLength(0);
    expect(promptVisible(tree)).toBe(true);
    act(() => { tree.unmount(); });
  });

  it('⚑ M8 review: the wait dies with its engine', async () => {
    const errors: string[] = [];
    const ref = React.createRef<any>();
    let tree!: ReactTestRenderer;
    act(() => { tree = create(el(ref, errors)); });
    await tick(0);
    await act(async () => { ref.current.startPanorama(); });
    await tick(100);
    act(() => { tree.update(el(ref, errors, { engine: 'keyframe' })); });
    await tick(100);
    act(() => { tree.update(el(ref, errors)); });
    pluginLanded = true;
    await tick(200);
    await tick(1500);
    expect(starts).toHaveLength(0);
    act(() => { tree.unmount(); });
  });
});
