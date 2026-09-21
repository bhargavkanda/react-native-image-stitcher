// SPDX-License-Identifier: Apache-2.0
/**
 * The list completion, against the REAL A35 lists — vision-camera's (from
 * CameraX's `Quality.typicalSizes`) and the hardware's (from
 * `android.scaler.availableStreamConfigurations`, YUV_420_888 OUTPUT),
 * both read on the device on 2026-09-21.
 */
import {
  augmentFormatsWithHardwareSizes,
  hardwareVideoSizesFromProbe,
  HARDWARE_VIDEO_LONG_EDGE_CAP,
  type HardwareVideoSize,
} from '../androidHardwareVideoSizes';
import { pickCaptureFormatDetailed, type FormatLike } from '../pickCaptureFormat';
import { A35_PHOTO, A35_VC_VIDEO } from './pickCaptureFormat.test';

const f = (pw: number, ph: number, vw: number, vh: number, maxFps = 30): FormatLike => ({
  photoWidth: pw, photoHeight: ph, videoWidth: vw, videoHeight: vh,
  maxFps, supportsVideoHdr: false,
});
const VC_LIST: FormatLike[] = A35_VC_VIDEO.flatMap(([vw, vh]) =>
  A35_PHOTO.map(([pw, ph]) => f(pw, ph, vw, vh)));

/** The A35's YUV_420_888 output sizes, all 30 fps.  4:3 rungs marked. */
const A35_HARDWARE: HardwareVideoSize[] = [
  [4080, 3060], [4080, 2296], [3056, 3056], [3840, 2160], [4080, 1884],
  [2560, 1440], [1920, 1440] /* 4:3 */, [2336, 1080], [1920, 1080], [1920, 886],
  [1440, 1080] /* 4:3 */, [1088, 1088], [1280, 720], [960, 720] /* 4:3 */,
  [720, 480], [640, 480] /* 4:3 */, [640, 360], [352, 288], [320, 240] /* 4:3 */,
  [256, 144], [176, 144],
].map(([width, height]) => ({ width, height, maxFps: 30 }));

const SHARED = { maxPhotoLongEdge: 4032, aspect: 4 / 3, preferHighFps: true, fpsTarget: 60 } as const;

describe('augmentFormatsWithHardwareSizes', () => {
  it('FAILS BEFORE: with the hardware list, the A35 picks 1440x1080 at 4:3 — same session', () => {
    const list = augmentFormatsWithHardwareSizes(VC_LIST, A35_HARDWARE);
    const r = pickCaptureFormatDetailed(list, { ...SHARED, minVideoLongEdge: 1280 });
    expect([r.format!.videoWidth, r.format!.videoHeight]).toEqual([1440, 1080]);
    expect(r.videoAspectMatched).toBe(true);
    expect(r.floorCleared).toBe(true); // the floor finally has something to clear
    // and the still is untouched
    expect(r.format!.photoWidth / r.format!.photoHeight).toBeCloseTo(4 / 3, 2);
  });

  it('FAILS BEFORE: the DEFAULT path (no floor) also lands on 1440x1080 — a bare <Camera> gets it', () => {
    const list = augmentFormatsWithHardwareSizes(VC_LIST, A35_HARDWARE);
    const r = pickCaptureFormatDetailed(list, { ...SHARED, minVideoLongEdge: 0 });
    expect([r.format!.videoWidth, r.format!.videoHeight]).toEqual([1440, 1080]);
  });

  it('CHARACTERIZATION: the same two picks are 640x480 on the list as vision-camera gives it', () => {
    for (const floor of [0, 1280]) {
      const r = pickCaptureFormatDetailed(VC_LIST, { ...SHARED, minVideoLongEdge: floor });
      expect([r.format!.videoWidth, r.format!.videoHeight]).toEqual([640, 480]);
    }
  });

  it('GUARD: honours the long-edge cap — 1920x1440 is not added at 1440, is at 1920', () => {
    const at1440 = augmentFormatsWithHardwareSizes(VC_LIST, A35_HARDWARE, 1440);
    expect(at1440.some((x) => x.videoWidth === 1920 && x.videoHeight === 1440)).toBe(false);
    const at1920 = augmentFormatsWithHardwareSizes(VC_LIST, A35_HARDWARE, 1920);
    expect(at1920.some((x) => x.videoWidth === 1920 && x.videoHeight === 1440)).toBe(true);
    expect(HARDWARE_VIDEO_LONG_EDGE_CAP).toBe(1440);
  });

  it('never duplicates a size the list already carries', () => {
    const list = augmentFormatsWithHardwareSizes(VC_LIST, A35_HARDWARE);
    const keys = list.map((x) => `${x.photoWidth}x${x.photoHeight}|${x.videoWidth}x${x.videoHeight}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 1920x1080 and 1280x720 were already there: still exactly one per photo size.
    expect(list.filter((x) => x.videoWidth === 1920 && x.videoHeight === 1080)).toHaveLength(A35_PHOTO.length);
  });

  it('clones every non-size field from the sibling with the same photo size', () => {
    const list = augmentFormatsWithHardwareSizes(
      [{ ...f(4080, 3060, 640, 480, 30), supportsVideoHdr: true, supportsDepthCapture: false }],
      [{ width: 1440, height: 1080, maxFps: null }],
    );
    const added = list.find((x) => x.videoWidth === 1440)!;
    expect(added.photoWidth).toBe(4080);
    expect(added.supportsVideoHdr).toBe(true);
    expect(added.maxFps).toBe(30); // null from the HAL -> the sibling's
  });

  it('takes the HAL rate for the size when it publishes one', () => {
    const list = augmentFormatsWithHardwareSizes(
      [f(4080, 3060, 640, 480, 60)],
      [{ width: 1440, height: 1080, maxFps: 30 }],
    );
    expect(list.find((x) => x.videoWidth === 1440)!.maxFps).toBe(30);
  });

  it('is the identity with no hardware sizes, and on a list that already has them (iOS)', () => {
    expect(augmentFormatsWithHardwareSizes(VC_LIST, [])).toEqual(VC_LIST);
    const ios = [f(4032, 3024, 1920, 1440, 60), f(4032, 3024, 1440, 1080, 60)];
    expect(augmentFormatsWithHardwareSizes(ios, [
      { width: 1920, height: 1440, maxFps: 60 }, { width: 1440, height: 1080, maxFps: 60 },
    ])).toEqual(ios);
  });
});

describe('hardwareVideoSizesFromProbe', () => {
  const report = {
    cameras: { cameras: [
      { id: '0', streamConfig: { yuv420Sizes: [
        { width: 1440, height: 1080, maxFps: 30, minFrameDurationNs: 33333333, aspect: '4:3' },
        { width: 640, height: 480, maxFps: null, minFrameDurationNs: null, aspect: '4:3' },
        { width: 'x', height: 1 },
      ] } },
      { id: '1', streamConfig: { yuv420Sizes: [{ width: 320, height: 240, maxFps: 30 }] } },
    ] },
  };
  it('walks the report to the named camera and drops malformed rows', () => {
    expect(hardwareVideoSizesFromProbe(report, '0')).toEqual([
      { width: 1440, height: 1080, maxFps: 30 },
      { width: 640, height: 480, maxFps: null },
    ]);
    expect(hardwareVideoSizesFromProbe(report, '1')).toEqual([{ width: 320, height: 240, maxFps: 30 }]);
  });
  it('answers [] for an unknown camera or a report of the wrong shape', () => {
    expect(hardwareVideoSizesFromProbe(report, '9')).toEqual([]);
    expect(hardwareVideoSizesFromProbe(null, '0')).toEqual([]);
    expect(hardwareVideoSizesFromProbe({ cameras: 'nope' }, '0')).toEqual([]);
  });
});
