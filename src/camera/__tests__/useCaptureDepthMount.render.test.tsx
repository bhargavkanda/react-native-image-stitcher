// SPDX-License-Identifier: Apache-2.0
/**
 * `useCapture({ captureDepthData })` — the EFFECTIVE depth, end to end
 * through the hook: device pick → `depthMount` → `effectiveCaptureDepthData`
 * → whether the extractor runs → the photo result's `depthUnavailableReason`.
 *
 * "Photo depth on LiDAR iPhones only, so every iPhone keeps the 1× non-AR
 * sweep" is `captureDepthData: 'lidar-only'`. On a phone with no
 * LiDAR mount it must mount the plain wide, never run the extractor, and
 * NAME the absence (`no-lidar-mount`) — and `true` must behave exactly as it
 * did before the union existed.
 *
 * ⚠ NO NON-LiDAR iPHONE HAS RUN THIS. The lineups below are enumeration
 * fixtures shaped like vision-camera's report (the LiDAR constituent arrives
 * as a second `wide-angle-camera`); the device proof waits for a borrowed
 * phone.
 */
jest.mock('../../quality/extractPhotoDepth', () => ({
  extractPhotoDepth: jest.fn(),
}));
jest.mock('../../quality/normaliseOrientation', () => ({
  normaliseOrientation: jest.fn(async (_p: string, d: { width: number; height: number }) => d),
}));
jest.mock('../../quality/runQualityCheck', () => ({
  runQualityCheck: jest.fn(),
}));
jest.mock('../../utils/files', () => ({
  moveFile: jest.fn(async (_from: string, to: string) => to),
  getDefaultCaptureDir: jest.fn(async () => '/tmp/rnis-captures'),
  defaultPhotoFilename: jest.fn(() => 'photo-1.jpg'),
}));

import React from 'react';
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  useCapture,
  type UseCaptureReturn,
} from '../useCapture';
import { extractPhotoDepth } from '../../quality/extractPhotoDepth';
import { moveFile } from '../../utils/files';

const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown;
  useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const extract = extractPhotoDepth as jest.Mock;
const move = moveFile as jest.Mock;

function back(id: string, p: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    position: 'back',
    physicalDevices: ['wide-angle-camera'],
    isMultiCam: false,
    hasTorch: true,
    minZoom: 1,
    neutralZoom: 1,
    maxZoom: 10,
    formats: [],
    ...p,
  };
}
const PLAIN_WIDE = back('plain-wide');
const UW = back('uw', { physicalDevices: ['ultra-wide-angle-camera'], hasTorch: false });
const DUAL = back('dual', { physicalDevices: ['wide-angle-camera', 'telephoto-camera'], isMultiCam: true });
const DUAL_WIDE = back('dual-wide', {
  physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera'], isMultiCam: true,
});
const LIDAR = back('lidar', {
  physicalDevices: ['wide-angle-camera', 'wide-angle-camera'], isMultiCam: true,
});
/** A dual-camera iPhone without LiDAR (the population 'lidar-only' exists for). */
const NON_LIDAR = [PLAIN_WIDE, UW, DUAL, DUAL_WIDE];
/** A Pro: same lineup plus the LiDAR Depth Camera. */
const WITH_LIDAR = [...NON_LIDAR, LIDAR];

let out!: UseCaptureReturn;
function Harness(props: Parameters<typeof useCapture>[0]) {
  out = useCapture(props);
  return null;
}

function mount(props: Parameters<typeof useCapture>[0]): ReactTestRenderer {
  let t!: ReactTestRenderer;
  act(() => { t = create(<Harness {...props} />); });
  (out.cameraRef as { current: unknown }).current = {
    takePhoto: async () => ({ path: '/tmp/vc/shot.jpg', width: 4032, height: 3024 }),
  };
  return t;
}

async function shoot() {
  let r!: Awaited<ReturnType<UseCaptureReturn['takePhoto']>>;
  await act(async () => { r = await out.takePhoto(); });
  return r;
}

beforeEach(() => {
  (Platform as { OS: string }).OS = 'ios';
  extract.mockReset();
  extract.mockResolvedValue({ found: true, sidecarPath: '/tmp/vc/shot.jpg.depth.bin' });
  move.mockClear();
  vc.useCameraDevice = () => null;
});
afterEach(() => {
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
});

describe("useCapture captureDepthData: 'lidar-only'", () => {
  it('⚑ non-LiDAR iPhone: plain wide mounted, depth OFF, zero extractor calls, reason no-lidar-mount', async () => {
    vc.useCameraDevices = () => NON_LIDAR;
    const t = mount({ lens: '1x', captureDepthData: 'lidar-only' });
    expect(out.device?.id).toBe('plain-wide');
    expect(out.depthMount).toBe('none');
    expect(out.effectiveCaptureDepthData).toBe(false);
    const r = await shoot();
    expect(extract).toHaveBeenCalledTimes(0);
    expect(r.depthUnavailableReason).toBe('no-lidar-mount');
    expect(r.depthPath).toBeUndefined();
    // Only the photo moved — no sidecar.
    expect(move).toHaveBeenCalledTimes(1);
    act(() => { t.unmount(); });
  });

  it('LiDAR iPhone: the LiDAR virtual mounted, depth ON, the sidecar is extracted and lands next to the photo', async () => {
    vc.useCameraDevices = () => WITH_LIDAR;
    const t = mount({ lens: '1x', captureDepthData: 'lidar-only' });
    expect(out.device?.id).toBe('lidar');
    expect(out.depthMount).toBe('lidar');
    expect(out.effectiveCaptureDepthData).toBe(true);
    const r = await shoot();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(r.depthPath).toBe('/tmp/rnis-captures/photo-1.jpg.depth.bin');
    expect(r.depthUnavailableReason).toBeUndefined();
    act(() => { t.unmount(); });
  });

  it('LiDAR iPhone at 0.5×: the extractor runs and the existing ultra-wide slug is kept', async () => {
    vc.useCameraDevices = () => WITH_LIDAR;
    extract.mockResolvedValue({ found: false, reason: 'no-depth-aux' });
    const t = mount({ lens: '0.5x', captureDepthData: 'lidar-only' });
    expect(out.device?.id).toBe('uw');
    expect(out.depthMount).toBe('lidar'); // the 1× primary's source
    const r = await shoot();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(r.depthUnavailableReason).toBe('ultra-wide-no-depth');
    act(() => { t.unmount(); });
  });

  it('Android: no depth, no extractor, no reason — as with true', async () => {
    (Platform as { OS: string }).OS = 'android';
    vc.useCameraDevices = () => WITH_LIDAR;
    const t = mount({ lens: '1x', captureDepthData: 'lidar-only' });
    expect(out.device?.id).toBe('plain-wide');
    expect(out.depthMount).toBe('none');
    expect(out.effectiveCaptureDepthData).toBe(false);
    const r = await shoot();
    expect(extract).toHaveBeenCalledTimes(0);
    expect(r.depthUnavailableReason).toBeUndefined();
    act(() => { t.unmount(); });
  });

  it('legacy path (no lens): the MOUNTED device is classified — a plain wide is no-lidar-mount', async () => {
    vc.useCameraDevices = () => WITH_LIDAR;
    vc.useCameraDevice = () => PLAIN_WIDE;
    const t = mount({ captureDepthData: 'lidar-only' });
    expect(out.device?.id).toBe('plain-wide');
    expect(out.depthMount).toBe('none');
    expect(out.effectiveCaptureDepthData).toBe(false);
    const r = await shoot();
    expect(extract).toHaveBeenCalledTimes(0);
    expect(r.depthUnavailableReason).toBe('no-lidar-mount');
    act(() => { t.unmount(); });
  });
});

describe('useCapture captureDepthData: true / false — UNCHANGED (regression pins)', () => {
  it('true on a non-LiDAR iPhone: Dual Wide, stereo, the extractor runs', async () => {
    vc.useCameraDevices = () => NON_LIDAR;
    const t = mount({ lens: '1x', captureDepthData: true });
    expect(out.device?.id).toBe('dual-wide');
    expect(out.depthMount).toBe('stereo');
    expect(out.effectiveCaptureDepthData).toBe(true);
    await shoot();
    expect(extract).toHaveBeenCalledTimes(1);
    act(() => { t.unmount(); });
  });

  it('true with NO depth-capable mount: still passed through and still extracted (the old slug, not no-lidar-mount)', async () => {
    vc.useCameraDevices = () => [PLAIN_WIDE, UW];
    extract.mockResolvedValue({ found: false, reason: 'no-depth-aux' });
    const t = mount({ lens: '1x', captureDepthData: true });
    expect(out.depthMount).toBe('none');
    expect(out.effectiveCaptureDepthData).toBe(true);
    const r = await shoot();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(r.depthUnavailableReason).toBe('no-depth-aux');
    act(() => { t.unmount(); });
  });

  it('false: plain wide, no depth, no extractor, no reason', async () => {
    vc.useCameraDevices = () => WITH_LIDAR;
    const t = mount({ lens: '1x', captureDepthData: false });
    expect(out.device?.id).toBe('plain-wide');
    expect(out.depthMount).toBe('none');
    expect(out.effectiveCaptureDepthData).toBe(false);
    const r = await shoot();
    expect(extract).toHaveBeenCalledTimes(0);
    expect(r.depthUnavailableReason).toBeUndefined();
    act(() => { t.unmount(); });
  });
});
