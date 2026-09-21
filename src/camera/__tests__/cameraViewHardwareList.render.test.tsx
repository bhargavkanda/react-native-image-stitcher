// SPDX-License-Identifier: Apache-2.0
/**
 * `<CameraView>` + the hardware-list hook, on the path the PHONE takes.
 *
 * The keyframe/photo tree renders `renderHostPreview()` unconditionally, so
 * on a real device `<CameraView>` mounts with `device` UNDEFINED and gets it
 * on a later render. The sweep tree gates the same element behind the device
 * id, so a test on that tree can never enter this path — which is how a
 * false "inert floor" warning reached the A35's log 83 ms before its
 * 1440x1080 session with every sweep-tree case green.
 */
import React from 'react';
import { NativeModules, Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Camera as VisionCamera } from 'react-native-vision-camera';

import { CameraView } from '../CameraView';
import { __resetHardwareVideoSizesCache } from '../androidHardwareVideoSizes';

const VC_FORMATS = ([[720, 480], [640, 480], [1280, 720], [1920, 1080], [3840, 2160]] as const)
  .flatMap(([vw, vh]) => ([[4080, 3060], [1920, 1440], [1440, 1080]] as const)
    .map(([pw, ph]) => ({
      photoWidth: pw, photoHeight: ph, videoWidth: vw, videoHeight: vh,
      minFps: 1, maxFps: 30, minISO: 50, maxISO: 3200, fieldOfView: 70,
      supportsVideoHdr: false, supportsPhotoHdr: false, supportsDepthCapture: false,
      autoFocusSystem: 'contrast-detection', videoStabilizationModes: ['off'],
    })));
const DEVICE = {
  id: '0', position: 'back', physicalDevices: ['wide-angle-camera'], hasTorch: true,
  minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: VC_FORMATS, isMultiCam: false,
  supportsFocus: true, name: '0',
};
const HW_REPORT = { cameras: { cameras: [{ id: '0', streamConfig: { yuv420Sizes: [
  { width: 1920, height: 1440, maxFps: 30 }, { width: 1440, height: 1080, maxFps: 30 },
  { width: 960, height: 720, maxFps: 30 }, { width: 640, height: 480, maxFps: 30 },
] } }] } };

const inner = (t: ReactTestRenderer) => t.root.findAllByType(VisionCamera);
const innerFormat = (t: ReactTestRenderer) => {
  const el = inner(t);
  if (el.length !== 1) throw new Error(`expected one vision-camera <Camera>, found ${el.length}`);
  return el[0].props.format as { videoWidth: number; videoHeight: number };
};

let warn: jest.SpyInstance;
const floorWarnings = () =>
  warn.mock.calls.filter((c) => String(c[0]).includes('video floor')).length;

beforeEach(() => {
  (Platform as { OS: string }).OS = 'android';
  __resetHardwareVideoSizesCache();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  delete (NativeModules as Record<string, unknown>).RNSSweepProbe;
  __resetHardwareVideoSizesCache();
  warn.mockRestore();
});

describe('<CameraView> mounted before its device arrives (the keyframe tree, the phone)', () => {
  it('FAILS BEFORE: holds the session and stays silent on the render the device arrives', async () => {
    let resolveProbe!: (r: unknown) => void;
    (NativeModules as Record<string, unknown>).RNSSweepProbe = {
      probeCapabilities: () => new Promise((res) => { resolveProbe = res; }),
    };
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CameraView device={undefined} keyframeQualityCapture />); });
    expect(inner(tree)).toHaveLength(0); // placeholder: no device yet

    // THE RENDER THE DEVICE ARRIVES ON. The probe has not answered, so the
    // list is still vision-camera's: this render must neither open a
    // session on it nor call the floor inert.
    act(() => { tree.update(<CameraView device={DEVICE as never} keyframeQualityCapture />); });
    expect(inner(tree)).toHaveLength(0);
    expect(floorWarnings()).toBe(0);

    await act(async () => { resolveProbe(HW_REPORT); await Promise.resolve(); await Promise.resolve(); });
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([1440, 1080]);
    expect(floorWarnings()).toBe(0);
    act(() => { tree.unmount(); });
  });

  it('CHARACTERIZATION: with no probe module the device-arrival render mounts 640x480 and warns', () => {
    // Fail-open: no probe, no hold, the old pick, and the (true) warning.
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CameraView device={undefined} keyframeQualityCapture />); });
    act(() => { tree.update(<CameraView device={DEVICE as never} keyframeQualityCapture />); });
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([640, 480]);
    expect(floorWarnings()).toBe(1);
    act(() => { tree.unmount(); });
  });
});
