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
import { NativeModules, Platform, StyleSheet } from 'react-native';
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
const previewBox = (t: ReactTestRenderer) => {
  const el = t.root.findAll((n) => n.props.testID === 'camera-preview-box' && typeof n.type !== 'function');
  if (el.length !== 1) throw new Error(`expected one camera-preview-box host View, found ${el.length}`);
  return el[0];
};
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

  it('FAILS BEFORE: a layout measured WHILE the probe is pending still letterboxes to 4:3', async () => {
    // On a phone the root is laid out once, during the wait, and never again
    // at the same size. If the placeholder is a different root View, that
    // layout is lost and the camera stays at the absoluteFill fallback —
    // the full-screen sweep viewfinder the operator reported.
    let resolveProbe!: (r: unknown) => void;
    (NativeModules as Record<string, unknown>).RNSSweepProbe = {
      probeCapabilities: () => new Promise((res) => { resolveProbe = res; }),
    };
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CameraView device={DEVICE as never} keyframeQualityCapture />); });
    expect(inner(tree)).toHaveLength(0); // held
    const root = tree.root.children[0] as { props: { onLayout?: (e: unknown) => void } };
    expect(typeof root.props.onLayout).toBe('function'); // the root is the measured one, even now
    act(() => { root.props.onLayout!({ nativeEvent: { layout: { width: 1080, height: 2254 } } }); });
    await act(async () => { resolveProbe(HW_REPORT); await Promise.resolve(); await Promise.resolve(); });
    // portrait container, 4:3 sensor → the largest 3:4 box: 1080 x 1440, not the full 2254.
    // The box is on the RN wrapper, not on vision-camera's own frame — see the next case.
    const style = previewBox(tree).props.style as { width?: number; height?: number };
    expect(style.width).toBe(1080);
    expect(style.height).toBe(1440);
    act(() => { tree.unmount(); });
  });

  it('FAILS BEFORE: the letterbox box is an unflattenable RN wrapper; vision-camera only fills it', async () => {
    // On Android vision-camera lays its OWN native view out at (0,0) when its
    // PreviewView is added (installHierarchyFitter), discarding the offset
    // Fabric gave it; Fabric does not re-send an unchanged frame.  With the
    // box on the <Camera> itself, every first mount per camera id (the one
    // held for the probe, so created at its final centred frame) stayed
    // pinned to the top of the screen — A35: [0,0][1080,1440] instead of
    // [0,450][1080,1890].  react-test-renderer cannot see native positions,
    // so this pins the CONTRACT that makes the position immune to the
    // fitter; the device gate proves the pixels.  Both mount paths:
    const check = (t: ReactTestRenderer, box: { width?: number; height?: number } | 'fill') => {
      const wrapper = previewBox(t);
      expect(wrapper.props.collapsable).toBe(false); // a flattened wrapper folds its offset back into the camera
      if (box === 'fill') expect(wrapper.props.style).toEqual(StyleSheet.absoluteFillObject);
      else expect(wrapper.props.style).toEqual(box);
      // vision-camera's element: fills the wrapper, carries no size and no offset of its own
      expect(StyleSheet.flatten(inner(t)[0].props.style)).toEqual(StyleSheet.flatten(StyleSheet.absoluteFill));
      expect(inner(t)[0].parent).toBe(wrapper);
    };

    // (1) HELD for the probe: `size` is known before the camera exists.
    let resolveProbe!: (r: unknown) => void;
    (NativeModules as Record<string, unknown>).RNSSweepProbe = {
      probeCapabilities: () => new Promise((res) => { resolveProbe = res; }),
    };
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CameraView device={DEVICE as never} keyframeQualityCapture />); });
    expect(inner(tree)).toHaveLength(0); // held: no camera exists until the probe answers
    const root = tree.root.children[0] as { props: { onLayout?: (e: unknown) => void } };
    act(() => { root.props.onLayout!({ nativeEvent: { layout: { width: 1080, height: 2340 } } }); });
    await act(async () => { resolveProbe(HW_REPORT); await Promise.resolve(); await Promise.resolve(); });
    check(tree, { width: 1080, height: 1440 });
    act(() => { tree.unmount(); });

    // (2) CACHE HIT (the probe answered for this id already): the camera is
    // created while `size` is still null, then the box arrives on onLayout.
    act(() => { tree = create(<CameraView device={DEVICE as never} keyframeQualityCapture />); });
    check(tree, 'fill');
    const root2 = tree.root.children[0] as { props: { onLayout?: (e: unknown) => void } };
    act(() => { root2.props.onLayout!({ nativeEvent: { layout: { width: 1080, height: 2340 } } }); });
    check(tree, { width: 1080, height: 1440 });
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

describe('<CameraView latched> — the hold starts on a render that mounts the camera (M5 review)', () => {
  it('FAILS BEFORE: a latch raised while the probe is pending holds the POST-probe format', async () => {
    let resolveProbe!: (r: unknown) => void;
    (NativeModules as Record<string, unknown>).RNSSweepProbe = {
      probeCapabilities: () => new Promise((res) => { resolveProbe = res; }),
    };
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CameraView device={DEVICE as never} keyframeQualityCapture />); });
    expect(inner(tree)).toHaveLength(0);                 // held for the probe
    // A capture starts in the probe window: the latch rises on a placeholder.
    act(() => { tree.update(<CameraView device={DEVICE as never} keyframeQualityCapture latched />); });
    await act(async () => { resolveProbe(HW_REPORT); await Promise.resolve(); await Promise.resolve(); });
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([1440, 1080]);
    // …and the fall is not a format change mid-drain.
    act(() => { tree.update(<CameraView device={DEVICE as never} keyframeQualityCapture latched={false} />); });
    expect([innerFormat(tree).videoWidth, innerFormat(tree).videoHeight]).toEqual([1440, 1080]);
    act(() => { tree.unmount(); });
  });

  it('a new frame-processor identity reaches vision-camera while latched — it is a JSI swap, not a rebind', () => {
    const a = { frameProcessor: () => undefined, type: 'readonly' };
    const b = { frameProcessor: () => undefined, type: 'readonly' };
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CameraView device={DEVICE as never} latched cameraProps={{ frameProcessor: a } as never} />); });
    expect(inner(tree)[0].props.frameProcessor).toBe(a);
    act(() => { tree.update(<CameraView device={DEVICE as never} latched cameraProps={{ frameProcessor: b } as never} />); });
    expect(inner(tree)[0].props.frameProcessor).toBe(b);
    act(() => { tree.unmount(); });
  });

  it('⚑ POSITIVE CONTROL: a zoom change while latched on a READY camera is still held', () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<CameraView device={DEVICE as never} zoom={1} />); });
    expect(inner(tree)[0].props.zoom).toBe(1);
    act(() => { tree.update(<CameraView device={DEVICE as never} zoom={1} latched />); });
    act(() => { tree.update(<CameraView device={DEVICE as never} zoom={2} latched />); });
    expect(inner(tree)[0].props.zoom).toBe(1);           // held
    act(() => { tree.update(<CameraView device={DEVICE as never} zoom={2} latched={false} />); });
    expect(inner(tree)[0].props.zoom).toBe(2);           // released
    act(() => { tree.unmount(); });
  });

});
