// SPDX-License-Identifier: Apache-2.0
/**
 * M3 review regressions — `<Camera engine="sweep">` on the Android host arm.
 *
 * Each case is a finding the M3 adversarial review confirmed against a live
 * render trace and that 78 suites did not notice:
 *
 *   1. the sweep's `<CameraView>` mounted through camera TRANSITIONS (the AR
 *      pill turning off, the AR-support probe, a lens switch) — the windows
 *      in which vision-camera v4 on Android races a new session's open
 *      against the old one's teardown;
 *   2. the composed frame processor followed `enablePanoramaMode`, so a
 *      Photo↔Pano flip toggled vision-camera's `enableFrameProcessor`
 *      (a rebind), and a sweep with panorama off was "still loading" forever;
 *   3. a keyframe capture recording across a keyframe→sweep switch kept
 *      ingesting on the sweep screen;
 *   4. a missing sweep plugin reached the host as PANORAMA_START_FAILED.
 *
 * Every case asserts that the surface is never told `'own'` on a non-AR
 * sweep: holding the preview back must not hand the sweep a camera of its
 * own.
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

/** Ordered log of `<CameraView>` mounts/unmounts and AR-session stops. */
const ev: string[] = [];
(globalThis as unknown as { __m3ev: string[] }).__m3ev = ev;
jest.mock('../../camera/CameraView', () => {
  const actual = jest.requireActual('../../camera/CameraView');
  const R = require('react');
  const Wrapped = R.forwardRef((props: { device?: { id?: string } }, ref: unknown) => {
    R.useLayoutEffect(() => {
      const log = (globalThis as unknown as { __m3ev: string[] }).__m3ev;
      log.push(`CV-MOUNT ${props.device?.id ?? '?'}`);
      return () => { log.push('CV-UNMOUNT'); };
    }, []);
    return R.createElement(actual.CameraView, { ...props, ref });
  });
  return { ...actual, CameraView: Wrapped };
});

import { ARToggle, Camera } from '../../camera/Camera';
import { CameraView } from '../../camera/CameraView';
import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';

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
const AR = (NativeModules as Record<string, Record<string, unknown>>).RNSARSession;
const realStop = AR.stop;
const realIsSupported = AR.isSupported;

const WIDE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};

beforeEach(() => {
  jest.useFakeTimers();
  ev.length = 0;
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => WIDE;
  vc.useCameraDevices = () => [WIDE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  (NativeModules as Record<string, unknown>).BatchStitcher = {};
  AR.stop = () => { ev.push('AR-STOP'); return Promise.resolve(); };
  // Memoised by deps, as the real hook is — identity is observable.
  vc.useFrameProcessor = (fn: unknown, deps: unknown[]) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps
    React.useMemo(() => ({ frameProcessor: fn, type: 'readonly' }), deps);
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  vc.useFrameProcessor = realUseFP;
  proxy.initFrameProcessorPlugin = realInit;
  AR.stop = realStop;
  AR.isSupported = realIsSupported;
});

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function advance(ms: number, steps = 1): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    act(() => { jest.advanceTimersByTime(ms); });
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
}
const surface = (t: ReactTestRenderer): Record<string, unknown> =>
  t.root.findByType(PanoPlusCaptureSurface).props as Record<string, unknown>;
const cameraViews = (t: ReactTestRenderer) => t.root.findAllByType(CameraView);
const fpOf = (t: ReactTestRenderer): unknown =>
  t.root.findAll((n) => n.type === vc.Camera)[0]?.props.frameProcessor;

describe('1 — the host preview is held back through a camera transition', () => {
  it('AR pill OFF: no <CameraView> mounts before the AR session has been stopped', async () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<Camera engine="sweep" defaultCaptureSource="ar" />); });
    await flush();
    await advance(500, 6);
    expect(cameraViews(tree)).toHaveLength(0);   // AR: the stitcher's session
    ev.length = 0;
    const pill = tree.root.findAllByType(ARToggle);
    expect(pill).toHaveLength(1);
    act(() => { (pill[0].props.onToggle as () => void)(); });
    await advance(100, 12);
    const stop = ev.indexOf('AR-STOP');
    const mount = ev.findIndex((e) => e.startsWith('CV-MOUNT'));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(mount).toBeGreaterThan(stop);
    // …and exactly one mount: no flap.
    expect(ev.filter((e) => e.startsWith('CV-MOUNT'))).toHaveLength(1);
    expect(surface(tree).frameSource).toBe('host');
    act(() => { tree.unmount(); });
  });

  it('AR preferred at mount: no <CameraView> while the AR-support probe is pending', async () => {
    let resolveProbe!: (v: boolean) => void;
    AR.isSupported = () => new Promise<boolean>((res) => { resolveProbe = res; });
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<Camera engine="sweep" defaultCaptureSource="ar" />); });
    await advance(50, 6);
    expect(ev.filter((e) => e.startsWith('CV-MOUNT'))).toHaveLength(0);
    expect(surface(tree).frameSource).not.toBe('own');
    await act(async () => { resolveProbe(true); await Promise.resolve(); });
    await advance(300, 4);
    // AR won: the preview never mounted at all.
    expect(ev.filter((e) => e.startsWith('CV-MOUNT'))).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  it('1× → 0.5×: the preview goes and comes back — the device is never swapped in place', async () => {
    const UW = { ...WIDE, id: 'back-2', name: 'back-2', physicalDevices: ['ultra-wide-angle-camera'] };
    vc.useCameraDevice = (_p: string, o?: { physicalDevices?: string[] }) =>
      (o?.physicalDevices?.[0] === 'ultra-wide-angle-camera' ? UW : WIDE);
    vc.useCameraDevices = () => [WIDE, UW];
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<Camera engine="sweep" defaultCaptureSource="non-ar" />); });
    await flush();
    await advance(300, 4);
    expect(cameraViews(tree)).toHaveLength(1);
    const chips = tree.root.findAll((n) => n.props != null
      && typeof n.props.onChange === 'function' && 'has0_5x' in n.props);
    expect(chips.length).toBeGreaterThan(0);
    ev.length = 0;
    act(() => { (chips[0].props.onChange as (l: string) => void)('0.5x'); });
    await flush();
    // The same commit that changed the lens must not show the NEW device on
    // the OLD mount.
    const now = cameraViews(tree);
    if (now.length === 1) {
      expect((now[0].props.device as { id: string }).id).not.toBe('back-2');
    }
    await advance(100, 10);
    expect(ev[0]).toBe('CV-UNMOUNT');
    expect(ev).toContain('CV-MOUNT back-2');
    expect(surface(tree).frameSource).toBe('host');
    act(() => { tree.unmount(); });
  });
});

describe('2 — the frame processor does not follow enablePanoramaMode', () => {
  it('a warm Photo↔Pano flip leaves vision-camera\'s processor attached', async () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<Camera engine="keyframe" defaultCaptureSource="non-ar" enablePanoramaMode />); });
    await flush();
    const a = fpOf(tree);
    act(() => { tree.update(<Camera engine="keyframe" defaultCaptureSource="non-ar" enablePanoramaMode={false} />); });
    await flush();
    const b = fpOf(tree);
    act(() => { tree.update(<Camera engine="keyframe" defaultCaptureSource="non-ar" enablePanoramaMode />); });
    await flush();
    const c = fpOf(tree);
    expect(a).not.toBeUndefined();
    expect(b).not.toBeUndefined();
    expect(c).not.toBeUndefined();
    act(() => { tree.unmount(); });
  });

  it('a sweep with panorama OFF is refused by name — not "still loading" forever', async () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<Camera engine="sweep" defaultCaptureSource="non-ar" enablePanoramaMode={false} />); });
    await flush();
    await advance(500, 6);
    const r = surface(tree).hostArmRefusal as { code: string } | null;
    expect(r?.code).toBe('panoplus-panorama-disabled');
    act(() => { tree.unmount(); });
  });

  it('…and on the AR arm too', async () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<Camera engine="sweep" defaultCaptureSource="ar" enablePanoramaMode={false} />); });
    await flush();
    await advance(500, 6);
    expect((surface(tree).hostArmRefusal as { code: string } | null)?.code)
      .toBe('panoplus-panorama-disabled');
    act(() => { tree.unmount(); });
  });
});

describe('4 — a missing sweep plugin is a BUILD failure to the host', () => {
  it('reaches onError as ENGINE_UNAVAILABLE, with the sweep\'s own code on cause', async () => {
    proxy.initFrameProcessorPlugin = () => undefined;   // never registers
    const errors: Array<{ code: string; cause?: { code?: string } }> = [];
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <Camera
          engine="sweep"
          defaultCaptureSource="non-ar"
          onError={(e: unknown) => { errors.push(e as never); }}
        />,
      );
    });
    await flush();
    await advance(500, 6);   // past the plugin's 1.5 s acquire budget
    const refusal = surface(tree).hostArmRefusal as { code: string } | null;
    expect(refusal?.code).toBe('panoplus-plugin-unavailable');
    const onFailure = surface(tree).onFailure as (f: unknown) => void;
    act(() => {
      onFailure({ code: refusal!.code, message: 'x', sessionDir: null, counts: null, abort: null });
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('ENGINE_UNAVAILABLE');
    expect(errors[0].cause?.code).toBe('panoplus-plugin-unavailable');
    act(() => { tree.unmount(); });
  });
});
