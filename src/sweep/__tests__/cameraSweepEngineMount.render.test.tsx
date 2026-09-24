// SPDX-License-Identifier: Apache-2.0
/**
 * M8 — `<Camera>` mounts the sweep engine on EVERY engine.
 *
 * The engine used to live inside the sweep surface, so on the keyframe engine
 * it did not exist at all. Now `<Camera>` calls `useSweepEngine` itself and
 * selects it with `enabled`. What that must not change: a keyframe `<Camera>`
 * touches nothing in the sweep's native modules. The pair below differs ONLY
 * in `engine`, and the sweep side is the configuration that reads the most at
 * idle (the DR-1a own-camera hatch reads the calibration store before any hold).
 */
import React from 'react';
import { NativeModules } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Camera } from '../../camera/Camera';

const NM = NativeModules as Record<string, unknown>;
const calls: string[] = [];

function install(): void {
  calls.length = 0;
  const rec = (name: string, value: unknown) => () => {
    calls.push(name);
    return Promise.resolve(value);
  };
  NM.RNSSweepSession = {
    start: rec('start', {}),
    stop: rec('stop', {}),
    cancel: rec('cancel', { cancelled: true }),
    getStatus: rec('getStatus', { running: false }),
    setIdlePreview: rec('setIdlePreview', { on: true }),
    getConstants: () => ({ documentDirectory: 'file:///docs/', vcArmSupported: true }),
    documentDirectory: 'file:///docs/',
    vcArmSupported: true,
  };
  NM.RNSSweepCalibration = {
    plannedCaptureFormat: rec('plannedCaptureFormat', { ok: false }),
    getCalibration: rec('getCalibration', {}),
    startBasisCalibration: rec('startBasisCalibration', undefined),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  install();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

async function mountFor(engine: 'keyframe' | 'sweep'): Promise<ReactTestRenderer> {
  let t!: ReactTestRenderer;
  act(() => {
    t = create(
      <Camera
        engine={engine}
        enablePanoramaMode
        sweep={{ frameSourceOverride: 'own', poseSource: 'imu' } as never}
      />,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  return t;
}

describe('<Camera> mounts the sweep engine on every engine (M8)', () => {
  it('the KEYFRAME engine makes no call into the sweep\'s native modules', async () => {
    const t = await mountFor('keyframe');
    expect(calls).toEqual([]);
    act(() => { t.unmount(); });
    expect(calls).toEqual([]);
  });

  it('⚑ NEGATIVE CONTROL: the same mount on the SWEEP engine does reach them', async () => {
    const t = await mountFor('sweep');
    expect(calls.length).toBeGreaterThan(0);
    act(() => { t.unmount(); });
  });
});
