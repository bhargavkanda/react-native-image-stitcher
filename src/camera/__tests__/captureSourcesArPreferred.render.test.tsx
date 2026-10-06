// SPDX-License-Identifier: Apache-2.0
/**
 * `captureSources="ar-preferred"` — AR wherever the device supports it.
 *
 * The three older modes cannot express "AR at 1×, and the 0.5× lens still
 * offered": `'ar'` also hides the lens chooser (ARKit/ARCore cannot drive the
 * ultra-wide), and `'both'` lets the user pick non-AR at 1×. Under
 * `'ar-preferred'` the user never picks the source — the device and the lens
 * do:
 *
 *   AR-capable device, 1×      → AR; the AR pill is hidden
 *   AR-capable device, 0.5×    → non-AR; the lens chip stays
 *   no AR support (probe false) → non-AR
 *   AR-support probe failed     → non-AR
 *
 * and `setCaptureSource('non-ar')` is refused. The one pill left on screen is
 * the library's escape hatch: a raw 0.5× the chip cannot move off (no
 * enumerable ultra-wide), where pressing the pill returns to AR at 1×.
 *
 * What took effect is read off `onCaptureSourceChange` — the public channel a
 * host sees — and the controls off the rendered `<ARToggle>` / `<LensChip>`.
 *
 * ⚑ NEGATIVE CONTROLS: the same harness under `'both'` shows the pill, honours
 * `defaultCaptureSource`, and obeys `setCaptureSource('non-ar')`; under `'ar'`
 * the lens chip is gone. So each assertion below is a property of the new
 * mode, not of the harness.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules } from 'react-native';
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

// eslint-disable-next-line import/first
import { ARToggle, Camera, LensChip } from '../Camera';

const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown; useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const AR = (NativeModules as Record<string, any>).RNSARSession;
const realIsSupported = AR.isSupported;
// The non-AR frame-processor plugin, present (as in a correctly built host),
// so the non-AR cells do not log its build-integration error.
const proxy = VisionCameraProxy as unknown as { initFrameProcessorPlugin: unknown };
const realInit = proxy.initFrameProcessorPlugin;

const WIDE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};
const WIDE_AND_UW = {
  ...WIDE,
  physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera'],
  isMultiCam: true, minZoom: 0.5,
};

function useDevice(dev: object): void {
  vc.useCameraDevice = () => dev;
  vc.useCameraDevices = () => [dev];
}

const mounted: ReactTestRenderer[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  useDevice(WIDE_AND_UW);
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
});
afterEach(() => {
  while (mounted.length > 0) {
    const t = mounted.pop()!;
    try { act(() => { t.unmount(); }); } catch { /* already unmounted */ }
  }
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  AR.isSupported = realIsSupported;
  proxy.initFrameProcessorPlugin = realInit;
});

/** Let the support probe resolve and the camera transition run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

interface Mounted {
  t: ReactTestRenderer;
  ref: React.RefObject<any>;
  /** Every source `onCaptureSourceChange` reported, in order. */
  sources: string[];
  lenses: string[];
}

async function mount(props: Record<string, unknown>): Promise<Mounted> {
  const sources: string[] = [];
  const lenses: string[] = [];
  const ref = React.createRef<any>();
  let t!: ReactTestRenderer;
  act(() => {
    t = create(
      <Camera
        ref={ref}
        rectCrop={false}
        onCaptureSourceChange={(s: string) => { sources.push(s); }}
        onLensChange={(l: string) => { lenses.push(l); }}
        {...(props as object)}
      />,
    );
  });
  mounted.push(t);
  await settle();
  return { t, ref, sources, lenses };
}

const pills = (t: ReactTestRenderer) => t.root.findAllByType(ARToggle);
const chips = (t: ReactTestRenderer) => t.root.findAllByType(LensChip);
const last = (a: string[]) => a[a.length - 1];

async function pickLens(t: ReactTestRenderer, lens: '1x' | '0.5x'): Promise<void> {
  act(() => { (chips(t)[0].props.onChange as (l: string) => void)(lens); });
  await settle();
}

describe("captureSources 'ar-preferred' — an AR-capable device", () => {
  it('1×: the source is AR, the AR pill is hidden, the lens chip offers 0.5×', async () => {
    const m = await mount({ captureSources: 'ar-preferred' });
    expect(last(m.sources)).toBe('ar');
    expect(pills(m.t)).toHaveLength(0);
    expect(chips(m.t)).toHaveLength(1);
    expect(chips(m.t)[0].props.has0_5x).toBe(true);
    expect(chips(m.t)[0].props.lens).toBe('1x');
  });

  it("ignores defaultCaptureSource 'non-ar': the policy, not the default, picks AR", async () => {
    const m = await mount({ captureSources: 'ar-preferred', defaultCaptureSource: 'non-ar' });
    expect(last(m.sources)).toBe('ar');
    expect(pills(m.t)).toHaveLength(0);
  });

  it('0.5× runs non-AR with the lens chip still on screen; back to 1× is AR again', async () => {
    const m = await mount({ captureSources: 'ar-preferred' });
    await pickLens(m.t, '0.5x');
    expect(last(m.sources)).toBe('non-ar');
    expect(chips(m.t)).toHaveLength(1);
    expect(chips(m.t)[0].props.lens).toBe('0.5x');
    expect(pills(m.t)).toHaveLength(0);
    await pickLens(m.t, '1x');
    expect(last(m.sources)).toBe('ar');
    expect(pills(m.t)).toHaveLength(0);
  });

  it("setCaptureSource('non-ar') is refused at 1×: nothing changes, no lens is committed", async () => {
    const m = await mount({ captureSources: 'ar-preferred' });
    const before = m.sources.length;
    act(() => { m.ref.current.setCaptureSource('non-ar'); });
    await settle();
    expect(m.sources.slice(before)).toEqual([]);
    expect(last(m.sources)).toBe('ar');
    expect(m.lenses).toEqual([]);
    // 'ar' is accepted and moves nothing (the preference is already AR).
    act(() => { m.ref.current.setCaptureSource('ar'); });
    await settle();
    expect(m.sources.slice(before)).toEqual([]);
  });

  it('the escape hatch: a raw 0.5× the chip cannot move shows the pill, and pressing it returns to AR at 1×', async () => {
    useDevice(WIDE); // no enumerable ultra-wide → the chip has no handler
    const m = await mount({ captureSources: 'ar-preferred', defaultLens: '0.5x' });
    expect(last(m.sources)).toBe('non-ar');
    expect(chips(m.t)[0].props.has0_5x).toBe(false);
    expect(pills(m.t)).toHaveLength(1);
    act(() => { (pills(m.t)[0].props.onToggle as () => void)(); });
    await settle();
    expect(m.lenses).toEqual(['1x']);
    expect(last(m.sources)).toBe('ar');
    // At 1× the pill is the policy's again: hidden.
    expect(pills(m.t)).toHaveLength(0);
  });
});

describe("captureSources 'ar-preferred' — a device that cannot run AR", () => {
  it('no AR support (probe answers false): non-AR, no pill, the lens chip stays', async () => {
    AR.isSupported = () => Promise.resolve(false);
    const m = await mount({ captureSources: 'ar-preferred' });
    expect(m.sources).not.toContain('ar');
    expect(last(m.sources)).toBe('non-ar');
    expect(pills(m.t)).toHaveLength(0);
    expect(chips(m.t)).toHaveLength(1);
    expect(chips(m.t)[0].props.has0_5x).toBe(true);
  });

  it('the AR-support probe fails: non-AR, exactly as for an unsupported device', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    AR.isSupported = () => Promise.reject(new Error('probe failed'));
    try {
      const m = await mount({ captureSources: 'ar-preferred' });
      expect(m.sources).not.toContain('ar');
      expect(last(m.sources)).toBe('non-ar');
      expect(pills(m.t)).toHaveLength(0);
      expect(chips(m.t)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('⚑ NEGATIVE CONTROLS — the older modes are unchanged on the same harness', () => {
  it("'both': the pill shows, defaultCaptureSource 'non-ar' holds, and setCaptureSource('non-ar') obeys", async () => {
    const m = await mount({ captureSources: 'both', defaultCaptureSource: 'non-ar' });
    expect(last(m.sources)).toBe('non-ar');
    expect(pills(m.t)).toHaveLength(1);
    act(() => { m.ref.current.setCaptureSource('ar'); });
    await settle();
    expect(last(m.sources)).toBe('ar');
    act(() => { m.ref.current.setCaptureSource('non-ar'); });
    await settle();
    expect(last(m.sources)).toBe('non-ar');
  });

  it("'ar': AR at 1×, and the lens chip is hidden", async () => {
    const m = await mount({ captureSources: 'ar' });
    expect(last(m.sources)).toBe('ar');
    expect(pills(m.t)).toHaveLength(0);
    expect(chips(m.t)).toHaveLength(0);
  });

  it("'non-ar': non-AR on an AR-capable device, no pill, the lens chip stays", async () => {
    const m = await mount({ captureSources: 'non-ar', defaultCaptureSource: 'ar' });
    expect(m.sources).not.toContain('ar');
    expect(pills(m.t)).toHaveLength(0);
    expect(chips(m.t)).toHaveLength(1);
  });
});
