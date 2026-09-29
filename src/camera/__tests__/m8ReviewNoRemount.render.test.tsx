// SPDX-License-Identifier: Apache-2.0
/**
 * M8 review (11) — an ENGINE SWITCH IS NOT A CAMERA SWITCH. The camera
 * component `<Camera>` draws never unmounts when `engine` flips.
 *
 * Since M8 both engines run on `<Camera>`'s own camera: `<CameraView>` on the
 * non-AR kind, `<ARCameraView>` on the AR kind. Before M8 a sweep → keyframe
 * switch handed the camera back through a 600 ms settle
 * (`sweepHandoffPending`) with both cameras unmounted. That settle now exists
 * only for the DR-1a hatch (`sweepOnOwnCameraRef`). On every other cell a
 * remount rebuilds vision-camera's session, which resets AE and focus and on
 * Android races the old session's teardown ("Maximum cameras in use"). On the
 * AR kind it stops and restarts the shared ARCore / ARKit session.
 *
 * THE PROBE. Both camera components are wrapped, through `jest.mock` of their
 * modules, in a forwardRef shell that logs MOUNT/UNMOUNT from a layout effect
 * with no dependencies. So a remount shows in the log however it happens: a
 * `key` change, a changed element type, a `cameraKind` of 'none' for a frame,
 * or the legacy tree. Instance identity (`findByType` returning the SAME test
 * instance) is checked as well, since it cannot survive a remount either.
 *
 *   kind   | flips                                   | camera mounts | unmounts
 *   -------+-----------------------------------------+---------------+---------
 *   non-AR | sweep→keyframe→sweep→keyframe→sweep     | 1 (initial)   | 0
 *   non-AR | keyframe→sweep→keyframe→sweep→keyframe  | 1 (initial)   | 0
 *   AR     | sweep→keyframe→sweep→keyframe→sweep     | 1 (initial)   | 0
 *   AR     | keyframe→sweep→keyframe→sweep→keyframe  | 1 (initial)   | 0
 *
 * ⚑ NEGATIVE CONTROLS prove the probe sees a remount when there is one: a
 * new React `key` on `<Camera>`, and a real kind swap (AR → non-AR through
 * `setCaptureSource`), which legitimately unmounts one camera and mounts the
 * other.
 *
 * Each flip is also checked to have TAKEN EFFECT: the sweep engine's
 * `enabled` option (read through the spy seam over the real hook) follows
 * `engine`. Without that check, a flip that never reached `<Camera>` would
 * pass this table vacuously.
 */
jest.mock('../../sweep/useSweepEngine', () =>
  require('../../sweep/__tests__/sweepEngineSpy').sweepEngineSpyFactory());

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
  copyAsync: () => Promise.resolve(),
}), { virtual: true });

// The probe. `globalThis`, not a module-scope variable: `jest.mock` factories
// are hoisted above every declaration in this file.
(globalThis as { __m8Remount?: string[] }).__m8Remount = [];
function probeFactory(modulePath: string, exportName: string, tag: string) {
  const actual = jest.requireActual(modulePath);
  const R = require('react');
  const Wrapped = R.forwardRef((props: object, ref: unknown) => {
    R.useLayoutEffect(() => {
      const log = (globalThis as { __m8Remount?: string[] }).__m8Remount!;
      log.push(`${tag}-MOUNT`);
      return () => { log.push(`${tag}-UNMOUNT`); };
    }, []);
    return R.createElement(actual[exportName], { ...props, ref });
  });
  Wrapped.displayName = `${exportName}Probe`;
  return { ...actual, [exportName]: Wrapped };
}
jest.mock('../CameraView', () => probeFactory('../CameraView', 'CameraView', 'CV'));
jest.mock('../ARCameraView', () => probeFactory('../ARCameraView', 'ARCameraView', 'AR'));

// eslint-disable-next-line import/first
import { Camera } from '../Camera';
// eslint-disable-next-line import/first
import { CameraView } from '../CameraView';
// eslint-disable-next-line import/first
import { ARCameraView } from '../ARCameraView';
// eslint-disable-next-line import/first
import {
  lastSweepEngineCall,
  resetSweepEngineCalls,
} from '../../sweep/__tests__/sweepEngineSpy';

type Engine = 'keyframe' | 'sweep';
type Source = 'ar' | 'non-ar';

const log = (globalThis as { __m8Remount?: string[] }).__m8Remount!;
const NM = NativeModules as Record<string, unknown>;
const vc = require('react-native-vision-camera') as {
  Camera: unknown;
  useCameraDevice: unknown;
  useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const proxy = VisionCameraProxy as unknown as { initFrameProcessorPlugin: unknown };
const realInit = proxy.initFrameProcessorPlugin;

const WIDE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};

beforeEach(() => {
  jest.useFakeTimers();
  log.length = 0;
  resetSweepEngineCalls();
  // The non-AR sweep's cell: Android, a back camera, and the sweep's
  // `panoplus_sweep_ingest` frame-processor plugin present.
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => WIDE;
  vc.useCameraDevices = () => [WIDE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  NM.RNSSweepSession = {
    start: () => Promise.resolve({}),
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

/** Longer than every settle in play: the AR probe, the 250 ms transition and
 *  the 600 ms sweep→keyframe handoff a remount would come from. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

const el = (engine: Engine, source: Source, ref?: React.Ref<unknown>, key?: string) => (
  <Camera
    key={key}
    ref={ref as never}
    engine={engine}
    defaultCaptureSource={source}
    captureSources="both"
    enablePanoramaMode
    panMode="both"
    rectCrop={false}
  />
);

const cameraTypeFor = (source: Source) => (source === 'ar' ? ARCameraView : CameraView);
const tagFor = (source: Source) => (source === 'ar' ? 'AR' : 'CV');
const events = (tag: string) => log.filter((e) => e.startsWith(`${tag}-`));

const TABLE: Array<{ source: Source; flips: Engine[] }> = [
  { source: 'non-ar', flips: ['sweep', 'keyframe', 'sweep', 'keyframe', 'sweep'] },
  { source: 'non-ar', flips: ['keyframe', 'sweep', 'keyframe', 'sweep', 'keyframe'] },
  { source: 'ar', flips: ['sweep', 'keyframe', 'sweep', 'keyframe', 'sweep'] },
  { source: 'ar', flips: ['keyframe', 'sweep', 'keyframe', 'sweep', 'keyframe'] },
];

describe('M8 review (11) — an engine flip never remounts <Camera>\'s camera', () => {
  for (const { source, flips } of TABLE) {
    it(`${source}: ${flips.join('→')} — one mount, no unmount, same instance`, async () => {
      const [first, ...rest] = flips;
      const Type = cameraTypeFor(source);
      const tag = tagFor(source);
      let t!: ReactTestRenderer;
      act(() => { t = create(el(first, source)); });
      await settle();
      expect(t.root.findAllByType(Type)).toHaveLength(1);
      expect(lastSweepEngineCall().enabled).toBe(first === 'sweep');
      const instance = t.root.findByType(Type);
      // Non-AR: vision-camera's own <Camera> inside <CameraView> must survive
      // too. A remount there is the session rebuild this rule exists to stop.
      const inner = source === 'non-ar'
        ? t.root.findByType(vc.Camera as React.ComponentType)
        : null;
      expect(events(tag)).toEqual([`${tag}-MOUNT`]);

      for (const engine of rest) {
        // eslint-disable-next-line no-await-in-loop
        act(() => { t.update(el(engine, source)); });
        // Before any timer runs: the flip commit itself unmounted nothing.
        expect(t.root.findAllByType(Type)).toHaveLength(1);
        // eslint-disable-next-line no-await-in-loop
        await settle();
        // The flip took effect (the engine is selected or deselected)…
        expect(lastSweepEngineCall().enabled).toBe(engine === 'sweep');
        // …and the camera is the one that was there before it.
        expect(t.root.findByType(Type)).toBe(instance);
        if (inner != null) {
          expect(t.root.findByType(vc.Camera as React.ComponentType)).toBe(inner);
        }
      }
      expect(events(tag)).toEqual([`${tag}-MOUNT`]);
      // The other kind never appeared, even for one commit.
      expect(events(source === 'ar' ? 'CV' : 'AR')).toEqual([]);
      act(() => { t.unmount(); });
      expect(events(tag)).toEqual([`${tag}-MOUNT`, `${tag}-UNMOUNT`]);
    });
  }

  describe('⚑ NEGATIVE CONTROLS — the probe sees a remount when one happens', () => {
    for (const source of ['non-ar', 'ar'] as const) {
      it(`${source}: a new React key on <Camera> remounts the camera, and the probe logs it`, async () => {
        const Type = cameraTypeFor(source);
        const tag = tagFor(source);
        let t!: ReactTestRenderer;
        act(() => { t = create(el('keyframe', source, undefined, 'a')); });
        await settle();
        const instance = t.root.findByType(Type);
        act(() => { t.update(el('sweep', source, undefined, 'b')); });
        await settle();
        expect(events(tag)).toEqual([`${tag}-MOUNT`, `${tag}-UNMOUNT`, `${tag}-MOUNT`]);
        expect(t.root.findByType(Type)).not.toBe(instance);
        act(() => { t.unmount(); });
      });
    }

    it('AR → non-AR through setCaptureSource swaps the camera kind, and the probe logs both', async () => {
      const ref = React.createRef<{ setCaptureSource: (s: Source) => void }>();
      let t!: ReactTestRenderer;
      act(() => { t = create(el('sweep', 'ar', ref)); });
      await settle();
      expect(t.root.findAllByType(ARCameraView)).toHaveLength(1);
      act(() => { ref.current!.setCaptureSource('non-ar'); });
      await settle();
      expect(t.root.findAllByType(ARCameraView)).toHaveLength(0);
      expect(t.root.findAllByType(CameraView)).toHaveLength(1);
      expect(events('AR')).toEqual(['AR-MOUNT', 'AR-UNMOUNT']);
      expect(events('CV')).toEqual(['CV-MOUNT']);
      // The unmount came first: never two cameras at once.
      expect(log.indexOf('AR-UNMOUNT')).toBeLessThan(log.indexOf('CV-MOUNT'));
      act(() => { t.unmount(); });
    });
  });
});
