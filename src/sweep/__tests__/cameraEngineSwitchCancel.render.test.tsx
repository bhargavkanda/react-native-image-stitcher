// SPDX-License-Identifier: Apache-2.0
/**
 * M3 review — an in-flight keyframe capture ends when the host switches the
 * engine to the sweep.
 *
 * The composed frame processor feeds the keyframe engine whenever ITS gate is
 * open, whatever `engine` says, and nothing closed that gate on a
 * keyframe→sweep switch: the abandoned capture went on ingesting on the sweep
 * screen, and a sweep started in that window fed every frame into BOTH
 * engines. Reproduced by the review with this exact arrangement.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { VisionCameraProxy } from 'react-native-vision-camera';

const g = globalThis as unknown as { __kfSwitch: { calls: string[] } };
g.__kfSwitch = { calls: [] };

jest.mock('../../stitching/useIncrementalStitcher', () => {
  const obj: Record<string, unknown> = {
    isAvailable: true,
    isRunning: false,
    hint: null,
    confidenceLevel: null,
    keyframeThumbnails: [],
    state: { acceptedCount: 0 },
    start: async () => {
      (globalThis as unknown as { __kfSwitch: { calls: string[] } }).__kfSwitch.calls.push('start');
      return { ok: true };
    },
    finalize: () => {
      (globalThis as unknown as { __kfSwitch: { calls: string[] } }).__kfSwitch.calls.push('finalize');
      return Promise.resolve({
        panoramaPath: '/d/p.jpg', width: 400, height: 100, framesRequested: 6, framesIncluded: 6,
      });
    },
    cancel: () => {
      (globalThis as unknown as { __kfSwitch: { calls: string[] } }).__kfSwitch.calls.push('cancel');
      return Promise.resolve();
    },
  };
  return { useIncrementalStitcher: () => obj };
});
jest.mock('../../stitching/incremental', () => ({
  ...jest.requireActual('../../stitching/incremental'),
  incrementalStitcherIsAvailable: () => true,
  incrementalMissingMethods: () => null,
}));

// eslint-disable-next-line import/first
import { Camera } from '../../camera/Camera';

const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown;
  useCameraDevices: unknown;
  useFrameProcessor: unknown;
  Camera: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const realUseFP = vc.useFrameProcessor;
const proxy = VisionCameraProxy as unknown as { initFrameProcessorPlugin: unknown };
const realInit = proxy.initFrameProcessorPlugin;

const DEVICE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};

const pluginCalls: string[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  vc.useFrameProcessor = (fn: unknown, deps: unknown[]) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps
    React.useMemo(() => ({ frameProcessor: fn, type: 'readonly' }), deps);
  proxy.initFrameProcessorPlugin = (name: string) => ({
    call: () => { pluginCalls.push(name); },
  });
  pluginCalls.length = 0;
  g.__kfSwitch.calls.length = 0;
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  vc.useFrameProcessor = realUseFP;
  proxy.initFrameProcessorPlugin = realInit;
});

const el = (engine: string, ref: React.RefObject<unknown>) => (
  <Camera
    ref={ref as never}
    engine={engine as never}
    enablePanoramaMode
    panMode="both"
    defaultCaptureSource="non-ar"
    outputDir="/tmp/out"
  />
);
const fpOf = (t: ReactTestRenderer): { frameProcessor: (f: unknown) => void } =>
  t.root.findAll((n) => n.type === vc.Camera)[0]!.props.frameProcessor;

it('a keyframe capture recording across a keyframe→sweep switch is cancelled and stops ingesting', async () => {
  const ref = React.createRef<{ startPanorama: () => void }>();
  let t!: ReactTestRenderer;
  await act(async () => { t = create(el('keyframe', ref)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(100); await Promise.resolve(); });

  await act(async () => {
    ref.current!.startPanorama(); await Promise.resolve(); await Promise.resolve();
  });
  expect(g.__kfSwitch.calls).toContain('start');
  pluginCalls.length = 0;
  for (let i = 0; i < 5; i += 1) fpOf(t).frameProcessor({ width: 1440, height: 1080 });
  // PRECONDITION: the capture really was ingesting before the switch.
  expect(pluginCalls).toContain('cv_flow_gate_process_frame');

  await act(async () => { t.update(el('sweep', ref)); });
  await act(async () => {
    jest.advanceTimersByTime(700); await Promise.resolve(); await Promise.resolve();
  });
  expect(g.__kfSwitch.calls).toContain('cancel');
  expect(g.__kfSwitch.calls).not.toContain('finalize');

  pluginCalls.length = 0;
  for (let i = 0; i < 5; i += 1) fpOf(t).frameProcessor({ width: 1440, height: 1080 });
  expect(pluginCalls).not.toContain('cv_flow_gate_process_frame');
  act(() => { t.unmount(); });
});
