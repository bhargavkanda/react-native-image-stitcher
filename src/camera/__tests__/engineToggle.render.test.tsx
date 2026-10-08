// SPDX-License-Identifier: Apache-2.0
/**
 * `showEngineToggle` — the V1/V2 pill that switches pano engines at runtime.
 *
 * `engine` has always selected the engine ('keyframe' = V1, 'sweep' = V2); what
 * this adds is a CONTROL, so one operator can shoot the same scene both ways
 * without a rebuild between arms. The pill is off unless asked for, so its
 * existence cannot move a shipped host.
 *
 * Three properties carry the feature, and each one is a way it could be
 * silently useless:
 *
 *  1. It renders on BOTH trees. A pill drawn only by the keyframe tree is a
 *     one-way door — switch to V2 and the control that switches back went with
 *     the tree that drew it.
 *  2. The switch reaches the ENGINE, not just the pill's own label. `engine`
 *     is read ~50 times in `<Camera>`; the override works by shadowing that
 *     one local, and this asserts the shadow took.
 *  3. The `engine` PROP still wins. An override that outranked the host
 *     forever would make the prop dead for any host that also enabled the pill.
 *
 * ⚑ NEGATIVE CONTROL: the default mount renders no pill at all, so every
 * assertion below is a property of the flag rather than of the harness.
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
import { Camera, EngineToggle } from '../Camera';

const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown; useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const AR = (NativeModules as Record<string, any>).RNSARSession;
const realIsSupported = AR.isSupported;
const proxy = VisionCameraProxy as unknown as { initFrameProcessorPlugin: unknown };
const realInit = proxy.initFrameProcessorPlugin;

const WIDE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};

const mounted: ReactTestRenderer[] = [];
beforeEach(() => {
  jest.useFakeTimers();
  vc.useCameraDevice = () => WIDE;
  vc.useCameraDevices = () => [WIDE];
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

async function mount(props: Record<string, unknown>): Promise<{
  t: ReactTestRenderer; ref: React.RefObject<any>;
  rerender: (next: Record<string, unknown>) => Promise<void>;
}> {
  const ref = React.createRef<any>();
  let t!: ReactTestRenderer;
  const tree = (p: Record<string, unknown>) => (
    <Camera ref={ref} rectCrop={false} {...(p as object)} />
  );
  act(() => { t = create(tree(props)); });
  mounted.push(t);
  await settle();
  const rerender = async (next: Record<string, unknown>) => {
    act(() => { t.update(tree(next)); });
    await settle();
  };
  return { t, ref, rerender };
}

const pills = (t: ReactTestRenderer) => t.root.findAllByType(EngineToggle);
const press = async (t: ReactTestRenderer) => {
  act(() => { (pills(t)[0].props.onToggle as () => void)(); });
  await settle();
};

describe('showEngineToggle — the pill itself', () => {
  it('renders NOTHING unless asked for (the negative control)', async () => {
    const m = await mount({});
    expect(pills(m.t)).toHaveLength(0);
  });

  it('renders once when enabled, reading the engine that will run', async () => {
    const m = await mount({ showEngineToggle: true });
    expect(pills(m.t)).toHaveLength(1);
    expect(pills(m.t)[0].props.sweepEnabled).toBe(false);   // 'keyframe' default
  });

  it('reads V2 when the host starts on the sweep engine', async () => {
    const m = await mount({ showEngineToggle: true, engine: 'sweep' });
    expect(pills(m.t)[0].props.sweepEnabled).toBe(true);
  });
});

describe('the switch reaches the engine, and comes back', () => {
  it('V1 → V2 → V1: the pill survives its own switch, so the door opens both ways', async () => {
    const m = await mount({ showEngineToggle: true });
    expect(pills(m.t)[0].props.sweepEnabled).toBe(false);

    await press(m.t);
    // Still exactly one pill AFTER moving to the sweep tree — the property
    // that makes this a switch rather than a one-way door.
    expect(pills(m.t)).toHaveLength(1);
    expect(pills(m.t)[0].props.sweepEnabled).toBe(true);

    await press(m.t);
    expect(pills(m.t)).toHaveLength(1);
    expect(pills(m.t)[0].props.sweepEnabled).toBe(false);
  });

  it('the imperative handle moves it too, for hosts drawing their own chrome', async () => {
    const m = await mount({ showEngineToggle: true });
    act(() => { m.ref.current.setEngine('sweep'); });
    await settle();
    expect(pills(m.t)[0].props.sweepEnabled).toBe(true);
  });
});

describe('the engine PROP keeps the wheel', () => {
  it('a host changing `engine` drops a stale override', async () => {
    const m = await mount({ showEngineToggle: true });
    await press(m.t);                                   // override → sweep
    expect(pills(m.t)[0].props.sweepEnabled).toBe(true);

    await m.rerender({ showEngineToggle: true, engine: 'sweep' });
    // Host now ASKS for sweep; the override is cleared but the answer is the
    // same, so this alone proves nothing — the next step is what does.
    await m.rerender({ showEngineToggle: true, engine: 'keyframe' });
    expect(pills(m.t)[0].props.sweepEnabled).toBe(false);
  });
});
