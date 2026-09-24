// SPDX-License-Identifier: Apache-2.0
/**
 * M9 REVIEW — the sweep's OUTPUT, driven through the REAL engine.
 *
 * `<Camera engine="sweep">` on the Android host arm, with NO engine mock and
 * NO spy: the hold goes through `<Camera>`'s dispatcher into `useSweepEngine`,
 * which calls the (faked) native session module, and the finish resolves or
 * rejects exactly as `RNSSweepSession.stop()` would. Everything between the
 * native answer and the host's two callbacks is production code — the
 * summary coercion, `panoPlusResultOf`, `<Camera>`'s `onComplete` /
 * `onFailure`, the output copy, the crop seed and the review stash.
 *
 * ⚠ WHY NOT `cameraSweepHostArm`. That suite hands a hand-built result
 * straight to `onComplete` off the spy's recorded props, which skips the
 * engine's own finish — and the finish is where two of these fixes live
 * (`stage: 'finish'` on a rejected stop, and the engine going idle BEFORE
 * `onComplete` has written the output, which is the window the output-pending
 * latch exists for). A case pinned there could not see either.
 *
 * Each case names the production line it pins. Every one was proved by
 * mutating that line in a scratch copy and watching the case fail; the
 * mutation is written beside the case.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';
import { VisionCameraProxy } from 'react-native-vision-camera';

const g = globalThis as any;
g.__m9 = { written: [] as Array<{ uri: string; body: string }>, bucket: 'good' };

// The verdict sidecar goes through `expo-file-system/legacy` (a host dep
// resolved at call time). `written` makes that write OBSERVABLE — without it
// the sidecar silently no-ops and a case about it passes on a deleted call.
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: () => Promise.resolve(''),
  writeAsStringAsync: (uri: string, body: string) => {
    (globalThis as any).__m9.written.push({ uri, body });
    return Promise.resolve();
  },
  deleteAsync: () => Promise.resolve(),
  getInfoAsync: () => Promise.resolve({ exists: false }),
  readDirectoryAsync: () => Promise.resolve([]),
  copyAsync: () => Promise.resolve(),
}), { virtual: true });

// ⚠ THE FAST-PAN CUE ON DEMAND. `usePanMotion` is the REAL hook (its IMU
// subscription, its lateral guard) with only its speed BUCKET overridden —
// the one input `<Camera>`'s HIGH_PAN_SPEED latch reads. Driving the real
// gyro off-device is not possible; overriding the bucket is the narrowest
// substitution that still runs `<Camera>`'s own latch effect
// (`captureRecording && recordingTooFast` → `fastPanRef`), unchanged.
jest.mock('../../camera/usePanMotion', () => {
  const actual = jest.requireActual('../../camera/usePanMotion');
  return {
    ...actual,
    usePanMotion: (o: unknown) => ({
      ...actual.usePanMotion(o),
      panSpeedBucket: (globalThis as any).__m9.bucket,
    }),
  };
});

// eslint-disable-next-line import/first
import {
  Camera,
  sweepFramesIncluded,
  sweepPanoramaResult,
} from '../../camera/Camera';
// eslint-disable-next-line import/first
import { CameraShutter } from '../../camera/CameraShutter';
// eslint-disable-next-line import/first
import { CaptureStatusOverlay } from '../../camera/CaptureStatusOverlay';

const overlayPhase = (t: ReactTestRenderer): string | undefined =>
  t.root.findAllByType(CaptureStatusOverlay)[0]?.props.phase as string | undefined;
// eslint-disable-next-line import/first
import { coercePanoPlusSummary, panoPlusResultOf } from '../panoPlusModel';

const NM = NativeModules as Record<string, any>;
const vc = require('react-native-vision-camera') as {
  useCameraDevice: unknown;
  useCameraDevices: unknown;
};
const realDevice = vc.useCameraDevice;
const realDevices = vc.useCameraDevices;
const proxy = VisionCameraProxy as unknown as { initFrameProcessorPlugin: unknown };
const realInit = proxy.initFrameProcessorPlugin;
const realCopy = NM.RNImageStitcherFileUtils.copyFile;

/** A plausible Android back camera: wide-only, so the multicam term is off. */
const DEVICE = {
  id: 'back-0', position: 'back', physicalDevices: ['wide-angle-camera'],
  hasTorch: true, minZoom: 1, maxZoom: 8, neutralZoom: 1, formats: [],
  isMultiCam: false, supportsFocus: true, name: 'back-0',
};

/** The host's output directory, so every copy destination is predictable. */
const OUT = '/host/out';
const COPY_RE = /^\/host\/out\/panorama-\d+\.jpg$/;

/** Every native `start()`: one entry per sweep native was asked to begin. */
let startedDirs: string[] = [];
/** The session the last start was handed; the pack every summary names. */
let sessionDir = '';
/** What native `stop()` does — set per case. */
let stopImpl: () => Promise<unknown> = () => Promise.resolve({});
let cancels = 0;
/** Every `copyFile(from, to)`, bare paths, in call order. */
let copyCalls: Array<[string, string]> = [];
let copyImpl: (from: string, to: string) => Promise<string> = (_f, to) => Promise.resolve(to);
/** Every path the crop seed was measured on. */
let inscribedCalls: string[] = [];

/**
 * ⚠ A DISTINCT RECT PER PATH. The seed must be measured on the PACK's canvas,
 * whose `.coverage.png` the engine writes; a regression to the output copy
 * must change what the editor OPENS on, not only which path was asked — so
 * the copy answers a different, obviously wrong rectangle.
 */
const PACK_RECT = { x: 12, y: 8, width: 3600, height: 1100 };
const COPY_RECT = { x: 400, y: 300, width: 100, height: 50 };

const canvasPath = (): string => `${sessionDir}/canvas.jpg`;

/** A finished sweep's native summary, in `sessionDir`. */
function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionDir,
    canvasPath: canvasPath(),
    width: 4000,
    height: 1200,
    counts: { seen: 120, painted: 96 },
    sweepMs: 1000,
    abort: null,
    ...over,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  vc.useCameraDevice = () => DEVICE;
  vc.useCameraDevices = () => [DEVICE];
  proxy.initFrameProcessorPlugin = () => ({ call: () => undefined });
  g.__m9.written = [];
  g.__m9.bucket = 'good';
  startedDirs = [];
  sessionDir = '';
  cancels = 0;
  copyCalls = [];
  inscribedCalls = [];
  stopImpl = () => Promise.resolve(summary());
  copyImpl = (_f, to) => Promise.resolve(to);
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      sessionDir = String(o.sessionDir);
      startedDirs.push(sessionDir);
      return Promise.resolve({
        sessionDir: o.sessionDir, startedAtMs: 1, pluginAvailable: true,
        poseSource: 'imu', frameSource: 'vc-plugin',
      });
    },
    stop: () => stopImpl(),
    cancel: () => { cancels += 1; return Promise.resolve({ cancelled: true }); },
    getStatus: () => Promise.resolve({ running: true, sessionDir, seq: 1, painted: 5 }),
    setIdlePreview: () => Promise.resolve({ on: false }),
    getConstants: () => ({ documentDirectory: 'file:///data/files/', vcArmSupported: true }),
    documentDirectory: 'file:///data/files/',
    vcArmSupported: true,
  };
  NM.RNImageStitcherFileUtils.copyFile = (from: string, to: string) => {
    copyCalls.push([from, to]);
    return copyImpl(from, to);
  };
  NM.BatchStitcher = {
    computeInscribedRect: (o: { imagePath: string }) => {
      inscribedCalls.push(o.imagePath);
      const r = o.imagePath === canvasPath() ? PACK_RECT : COPY_RECT;
      return Promise.resolve({ ...r, imageWidth: 4000, imageHeight: 1200 });
    },
  };
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  vc.useCameraDevice = realDevice;
  vc.useCameraDevices = realDevices;
  proxy.initFrameProcessorPlugin = realInit;
  NM.RNImageStitcherFileUtils.copyFile = realCopy;
  delete NM.RNSSweepSession;
  delete NM.BatchStitcher;
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** `onComplete` awaits the copy, the sidecar copy and the crop seed. */
async function drain(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  });
}

interface Host {
  tree: ReactTestRenderer;
  ref: React.RefObject<any>;
  seen: Array<Record<string, any>>;
  errs: Array<{ code: string; message: string; cause?: any }>;
  dropped: unknown[];
  rerender: (p?: Record<string, unknown>) => Promise<void>;
}

async function mount(props: Record<string, unknown> = {}): Promise<Host> {
  const ref = React.createRef<any>();
  const seen: Array<Record<string, any>> = [];
  const errs: Array<{ code: string; message: string; cause?: any }> = [];
  const dropped: unknown[] = [];
  let current: Record<string, unknown> = { ...props };
  const el = () => (
    <Camera
      ref={ref} engine="sweep" defaultCaptureSource="non-ar" panMode="both"
      outputDir={OUT}
      onCapture={(r: Record<string, any>) => { seen.push(r); }}
      onError={(e: any) => { errs.push(e); }}
      onFramesDropped={(d: unknown) => { dropped.push(d); }}
      {...(current as any)}
    />
  );
  let tree!: ReactTestRenderer;
  act(() => { tree = create(el()); });
  await tick(0);
  return {
    tree, ref, seen, errs, dropped,
    rerender: async (p = {}) => {
      current = { ...current, ...p };
      act(() => { tree.update(el()); });
      await tick(0);
    },
  };
}

/** Hold, let native start, release: the finish then resolves or rejects. */
async function sweep(h: Host): Promise<void> {
  await act(async () => { h.ref.current.startPanorama(); });
  await tick(300);
  await act(async () => { await h.ref.current.stopPanorama(); });
  await drain();
}

/**
 * ⚠ `visible === true`, NOT JUST "a node with an onRetake" — the review
 * surfaces are mounted for the life of the screen and hidden by a prop
 * (see `cameraSweepHostArm`'s note on the same predicate).
 */
const review = (t: ReactTestRenderer) => t.root.findAll(
  (n) => typeof n.props?.onRetake === 'function' && n.props?.visible === true,
  { deep: true },
);
const shutter = (t: ReactTestRenderer) => {
  const s = t.root.findAllByType(CameraShutter);
  if (s.length !== 1) throw new Error(`expected one CameraShutter, found ${s.length}`);
  return s[0].props as { isProcessing?: boolean; disabled?: boolean };
};
const codes = (warnings: Array<{ code: string }> | undefined) =>
  (warnings ?? []).map((w) => w.code);
const takePhotoRefusals = (h: Host) =>
  h.errs.filter((e) => e.code === 'CAPTURE_IN_PROGRESS'
    && e.message.startsWith('takePhoto() was refused')).length;

describe('⚑ THE PRECONDITION — this suite runs the REAL engine end to end', () => {
  it('a hold reaches native start, a release native stop, and the capture lands', async () => {
    // Without this every case below could be passing on a hold that never
    // reached the engine at all.
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(startedDirs).toHaveLength(1);
    expect(h.errs).toEqual([]);
    expect(h.seen).toHaveLength(1);
    expect([h.seen[0].ok, h.seen[0].type, h.seen[0].engine]).toEqual([true, 'panorama', 'sweep']);
    expect(h.seen[0].sessionDir).toBe(sessionDir);
    act(() => { h.tree.unmount(); });
  });
});

// ── T1 ──────────────────────────────────────────────────────────────────────
describe('M9 review T1 — the crop seed is measured on the PACK\'s canvas, and the coverage sidecar travels', () => {
  it('computeInscribedRect is asked for the pack canvas (summary.canvasPath), and the editor opens on ITS rect', async () => {
    // Pins `computeInscribedRect(result.uri)` in `deliverSweep`. The pack's
    // canvas is the image whose `<canvas>.coverage.png` the ENGINE writes;
    // the copy's sidecar is best-effort, and without one native falls back
    // to a brightness threshold that reads dark CONTENT as unpainted (24.3%
    // of the canvas against a true 68.4% on the operator's pack).
    // MUTATION: `computeInscribedRect(outputUri)` → the copy is measured,
    // the editor opens on COPY_RECT. Killed.
    const h = await mount({ rectCrop: true });
    await sweep(h);
    expect(inscribedCalls).toEqual([canvasPath()]);
    expect(review(h.tree)).toHaveLength(1);
    expect(review(h.tree)[0].props.initialRect).toEqual(PACK_RECT);
    // …while the review SHOWS the copy, which is the output.
    expect(String(review(h.tree)[0].props.imageUri).replace('file://', '')).toMatch(COPY_RE);
    act(() => { h.tree.unmount(); });
  });

  it('after the output copy, <canvas>.coverage.png is copied to <copy>.coverage.png', async () => {
    // Pins the best-effort sidecar `copyFile` after a successful output copy:
    // a host tool running `computeInscribedRect` / `cropToInscribedRect` on
    // the OUTPUT reads the sidecar beside it.
    // MUTATION: delete the sidecar `copyFile` call. Killed (one call only).
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(copyCalls).toHaveLength(2);
    const [[from, to], [sideFrom, sideTo]] = copyCalls;
    expect(from).toBe(canvasPath());
    expect(to).toMatch(COPY_RE);
    expect(sideFrom).toBe(`${canvasPath()}.coverage.png`);
    expect(sideTo).toBe(`${to}.coverage.png`);
    act(() => { h.tree.unmount(); });
  });

  it('⚑ a failing sidecar copy does NOT fail the capture', async () => {
    // An older engine writes no sidecar, so its copy rejects on every sweep.
    // MUTATION: drop the try/catch around the sidecar copy → the rejection
    // escapes `deliverSweep`, nothing is emitted. Killed.
    copyImpl = (f, to) => (f.endsWith('.coverage.png')
      ? Promise.reject(new Error('no such file'))
      : Promise.resolve(to));
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(copyCalls.map(([f]) => f)).toEqual([canvasPath(), `${canvasPath()}.coverage.png`]);
    expect(h.errs).toEqual([]);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].ok).toBe(true);
    expect(String(h.seen[0].uri).replace('file://', '')).toMatch(COPY_RE);
    act(() => { h.tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: with the crop editor off the seed is not measured at all', async () => {
    // Without this the first case passes for a seed measured unconditionally
    // (a decode spent on nothing in preview-only mode).
    const h = await mount({ rectCrop: false, showPreview: true });
    await sweep(h);
    expect(review(h.tree)).toHaveLength(1);
    expect(inscribedCalls).toEqual([]);
    act(() => { h.tree.unmount(); });
  });
});

// ── T2 ──────────────────────────────────────────────────────────────────────
describe('M9 review T2 — one frame count, one refusal count, everywhere they are reported', () => {
  /**
   * EVERY TERM ACTIVE, and powers of two, so any dropped or double-counted
   * term lands on a number no other formula produces: the six `rejected*`
   * sum to 63, less 5 benign duplicates = 58; `painted` + the latch seed = 97
   * (the tail flush REPAINTS one of those and must not add a 98th).
   */
  const P = 96;
  const S = 240;
  const COUNTS = {
    seen: S, painted: P,
    rejectedLowResponse: 1, rejectedOutOfCage: 2, rejectedPoseSpeed: 4,
    rejectedTracking: 8, rejectedRectify: 16, rejectedInput: 32,
    skippedNonmonotonicTs: 5,
  };
  const OVER = {
    counts: COUNTS, latch: { latched: true }, tailFlushed: true,
    tailFlushAttempted: true, sweepMs: 4321,
  };

  it('the result, onFramesDropped and CAPTURE_TOO_SHORT carry the SAME numbers', async () => {
    // Pins `sweepFramesIncluded` (painted + latch seed; the tail flush is NOT
    // counted), the `− skippedNonmonotonicTs` in `sweepPanoramaResult`, and
    // `onFramesDropped({ included: framesIncluded })`.
    // MUTATIONS, each killed:
    //   · `+ (tailFlushed ? 1 : 0)` restored in sweepFramesIncluded → 98;
    //   · the latch term removed → 96;
    //   · `− c.skippedNonmonotonicTs` removed → 63;
    //   · onFramesDropped `included: requested − dropped` restored → 182.
    stopImpl = () => Promise.resolve(summary(OVER));
    const h = await mount({
      rectCrop: false, showPreview: false, minPanoramaKeyframes: 1000,
    });
    await sweep(h);
    expect(h.seen).toHaveLength(1);
    const r = h.seen[0];
    expect(r.ok).toBe(true);
    expect(r.framesRequested).toBe(S);
    expect(r.framesIncluded).toBe(P + 1);
    expect(r.framesDropped).toBe(58);
    expect(r.durationMs).toBe(4321);
    expect(h.dropped).toEqual([{ requested: S, included: P + 1, dropped: 58 }]);
    // CAPTURE_TOO_SHORT is judged on the SAME included count (the warning
    // carries it), so "Only {n} frame(s)" can never disagree with the result.
    const tooShort = (r.warnings as Array<Record<string, unknown>>)
      .find((w) => w.code === 'CAPTURE_TOO_SHORT');
    expect(tooShort).toBeDefined();
    expect(tooShort!.framesIncluded).toBe(P + 1);
    expect(tooShort!.framesRequested).toBe(P + 1);
    expect(String(tooShort!.message)).toContain(String(P + 1));
    act(() => { h.tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: the default minPanoramaKeyframes raises no CAPTURE_TOO_SHORT', async () => {
    // Without it the case above passes for a warning emitted unconditionally.
    stopImpl = () => Promise.resolve(summary(OVER));
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(codes(h.seen[0].warnings)).not.toContain('CAPTURE_TOO_SHORT');
    act(() => { h.tree.unmount(); });
  });

  describe('the exported formulas, directly', () => {
    const resultOf = (over: Record<string, unknown>) => panoPlusResultOf(
      coercePanoPlusSummary({
        sessionDir: '/p/pp_1', canvasPath: '/p/pp_1/canvas.jpg', width: 10, height: 5,
        ...over,
      }),
      { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'imu' },
      '2026-09-24T00:00:00.000Z',
    );

    it('sweepFramesIncluded = painted + latch seed, and the tail flush adds nothing', () => {
      expect(sweepFramesIncluded(resultOf(OVER).summary)).toBe(P + 1);
      // The tail flush alone changes nothing…
      expect(sweepFramesIncluded(resultOf({ ...OVER, tailFlushed: false }).summary)).toBe(P + 1);
      // …the latch does.
      expect(sweepFramesIncluded(resultOf({ ...OVER, latch: { latched: false } }).summary)).toBe(P);
    });

    it('sweepPanoramaResult: every count, and the benign duplicates subtracted', () => {
      const r = sweepPanoramaResult(resultOf(OVER), [], 'file:///o.jpg');
      expect([r.framesRequested, r.framesIncluded, r.framesDropped, r.durationMs])
        .toEqual([S, P + 1, 58, 4321]);
      expect([r.ok, r.type, r.engine, r.uri]).toEqual([true, 'panorama', 'sweep', 'file:///o.jpg']);
    });

    it('⚑ framesDropped is clamped at 0 — an odd binary cannot report a negative drop', () => {
      // MUTATION: drop the `Math.max(0, …)` → −3. Killed.
      const r = sweepPanoramaResult(
        resultOf({ counts: { seen: 10, painted: 4, skippedNonmonotonicTs: 3 } }), [], 'u',
      );
      expect(r.framesDropped).toBe(0);
    });
  });
});

// ── T3 ──────────────────────────────────────────────────────────────────────
describe('M9 review T3 — an output that cannot be written still carries its PACK', () => {
  it('OUTPUT_WRITE_FAILED on both channels, cause is PanoPlusFailure-shaped, warnings kept, verdict written once', async () => {
    // Pins `packFailure('panoplus-output-write', …)` as the CameraError cause
    // (it used to be the raw copy error, which carries no pack), and the
    // `warnings: sweepWarnings` / `writeSweepVerdictSidecar` on that exit.
    // MUTATIONS, each killed:
    //   · cause back to `err` (the raw Error) → cause.code undefined;
    //   · `sessionDir: result.sessionDir` dropped from packFailure;
    //   · `warnings: []` on the OUTPUT_WRITE_FAILED `onCapture`;
    //   · the verdict write removed from the catch.
    copyImpl = () => Promise.reject(new Error('disk full'));
    // A WARNING TO CARRY: the operator panned too fast during this sweep.
    g.__m9.bucket = 'bad';
    const h = await mount({ rectCrop: false, showPreview: true });
    await sweep(h);
    expect(h.errs.map((e) => e.code)).toEqual(['OUTPUT_WRITE_FAILED']);
    expect(h.seen).toHaveLength(1);
    const r = h.seen[0];
    expect([r.ok, r.type, r.engine, r.error.code])
      .toEqual([false, 'panorama', 'sweep', 'OUTPUT_WRITE_FAILED']);
    expect(r.error).toBe(h.errs[0]);
    const cause = r.error.cause;
    expect(cause.code).toBe('panoplus-output-write');
    expect(cause.sessionDir).toBe(sessionDir);
    expect(cause.sessionDir).not.toBe('');
    expect(cause.stage).toBe('finish');
    expect(cause.counts).toEqual(expect.objectContaining({ seen: 120, painted: 96 }));
    expect(String(cause.message)).toContain('disk full');
    expect(codes(r.warnings)).toContain('HIGH_PAN_SPEED');
    expect(review(h.tree)).toHaveLength(0);        // nothing to review
    expect(g.__m9.written.filter((w: { uri: string }) => w.uri.endsWith('/host_verdict.json')))
      .toHaveLength(1);
    act(() => { h.tree.unmount(); });
  });
});

// ── T4 ──────────────────────────────────────────────────────────────────────
describe('M9 review T4 — a canvas with no FILE is a finalize failure, not an output one', () => {
  it('width/height > 0 and an empty canvasPath: PANORAMA_FINALIZE_FAILED, panoplus-io, no copy attempted', async () => {
    // Android can render the canvas and then fail to publish its JPEG. That
    // used to reach the copy, fail THERE, and blame the host's outputDir.
    // MUTATION: delete the `sweepHasCanvas && result.uri === ''` block →
    // copyFile('', …) runs (and here "succeeds"). Killed.
    stopImpl = () => Promise.resolve(summary({ canvasPath: '' }));
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(copyCalls).toEqual([]);
    expect(h.errs.map((e) => e.code)).toEqual(['PANORAMA_FINALIZE_FAILED']);
    expect(h.seen).toHaveLength(1);
    const r = h.seen[0];
    expect([r.ok, r.type, r.engine, r.error.code])
      .toEqual([false, 'panorama', 'sweep', 'PANORAMA_FINALIZE_FAILED']);
    expect(r.error.cause.code).toBe('panoplus-io');
    expect(r.error.cause.sessionDir).toBe(sessionDir);
    expect(r.error.cause.stage).toBe('finish');
    act(() => { h.tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: no canvas at all (0×0) is not this failure', async () => {
    // An empty sweep has no canvas to lose; it must not be reported as a
    // canvas whose file went missing.
    stopImpl = () => Promise.resolve(summary({ canvasPath: '', width: 0, height: 0 }));
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(h.errs.map((e) => e.code)).not.toContain('PANORAMA_FINALIZE_FAILED');
    act(() => { h.tree.unmount(); });
  });
});

// ── T5 ──────────────────────────────────────────────────────────────────────
describe('M9 review T5 — the screen is NOT free while the sweep\'s output is being written', () => {
  it('while the copy is pending: no second native sweep, takePhoto refused, the shutter processing — then the review opens on sweep 1', async () => {
    // `finish()` goes idle BEFORE `onComplete`, and `onComplete` then awaits
    // the output copy. Pins the output-pending latch:
    //   · `sweepRunning || sweepOutputPendingRef.current` in the dispatcher
    //     (MUTATION: drop the ref → a 2nd native start, which the stash then
    //     deselects silently. Killed);
    //   · `|| sweepOutputPendingRef.current` in `captureBusyRef` (MUTATION:
    //     drop it → takePhoto accepted mid-write. Killed);
    //   · `sweepOutputPending` in the shutter's isProcessing/disabled
    //     (MUTATION: drop it from both → a live-looking shutter. Killed).
    let release!: () => void;
    copyImpl = (f, to) => (f.endsWith('.coverage.png')
      ? Promise.resolve(to)
      : new Promise<string>((res) => { release = () => res(to); }));
    const h = await mount({ rectCrop: false, showPreview: true });
    await sweep(h);
    await tick(100);
    // PRECONDITION: the engine has gone idle — the window this latch exists
    // for is real, and nothing else is holding the screen.
    expect(startedDirs).toHaveLength(1);
    expect(typeof release).toBe('function');
    expect(review(h.tree)).toHaveLength(0);
    // The shutter says so.
    expect(shutter(h.tree).isProcessing).toBe(true);
    expect(shutter(h.tree).disabled).toBe(true);
    // A hold does not start a second sweep…
    await act(async () => { h.ref.current.startPanorama(); });
    await tick(300);
    expect(startedDirs).toHaveLength(1);
    // …and a photo is refused by name.
    await act(async () => { await h.ref.current.takePhoto(); });
    expect(takePhotoRefusals(h)).toBe(1);

    // The copy lands: the review opens on the FIRST sweep's output.
    await act(async () => { release(); });
    await drain();
    expect(review(h.tree)).toHaveLength(1);
    expect(String(review(h.tree)[0].props.imageUri))
      .toBe(`file://${copyCalls[0][1]}`);
    expect(copyCalls[0][0]).toBe(`${startedDirs[0]}/canvas.jpg`);
    expect(shutter(h.tree).isProcessing).toBe(false);
    // …and a photo is no longer refused as busy.
    await act(async () => { await h.ref.current.takePhoto(); });
    expect(takePhotoRefusals(h)).toBe(1);
    act(() => { h.tree.unmount(); });
  });

  it('⚑ and a hold on the OTHER engine waits too: switching to keyframe mid-write starts nothing', async () => {
    // The busy latch and the shutter ignore the engine; the dispatcher's
    // pending check must too, or a keyframe `startPanorama()` is accepted
    // mid-write while `takePhoto()` is refused, and its capture runs under the
    // review that is about to open. Pins `if (sweepOutputPendingRef.current)
    // return;` ahead of the engine branch.
    // MUTATION: scope it to `engine === 'sweep'` → the keyframe hold goes
    // through (a start, or a named start refusal). Killed.
    let release!: () => void;
    copyImpl = (f, to) => (f.endsWith('.coverage.png')
      ? Promise.resolve(to)
      : new Promise<string>((res) => { release = () => res(to); }));
    const h = await mount({ rectCrop: false, showPreview: true });
    await sweep(h);
    await tick(100);
    expect(typeof release).toBe('function');
    await h.rerender({ engine: 'keyframe' });
    await tick(100);
    const before = { errs: h.errs.length, seen: h.seen.length };
    await act(async () => { h.ref.current.startPanorama(); });
    await tick(300);
    expect(h.errs.length).toBe(before.errs);
    expect(h.seen.length).toBe(before.seen);
    expect(overlayPhase(h.tree)).not.toBe('recording');
    await act(async () => { release(); });
    await drain();
    expect(review(h.tree)).toHaveLength(1);
    act(() => { h.tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: with the copy resolved at once, none of it — the next hold starts, takePhoto is taken', async () => {
    // Without this the case above passes for a screen that is refused for
    // some OTHER reason after every sweep (a stuck engine phase, a stale
    // `sweepRunning`), which would make the pending latch look load-bearing
    // when it is not. No review, so nothing else holds the screen either.
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    await tick(100);
    expect(h.seen).toHaveLength(1);
    expect(shutter(h.tree).isProcessing).toBe(false);
    expect(shutter(h.tree).disabled).toBe(false);
    await act(async () => { await h.ref.current.takePhoto(); });
    expect(takePhotoRefusals(h)).toBe(0);
    await act(async () => { h.ref.current.startPanorama(); });
    await tick(300);
    expect(startedDirs).toHaveLength(2);
    act(() => { h.tree.unmount(); });
  });
});

// ── T6 ──────────────────────────────────────────────────────────────────────
describe('M9 review T6 — a FAILED sweep keeps its capture-time warnings, and they do not leak', () => {
  /** A finish native refuses, with the pack in `userInfo`, as it really does. */
  const rejectEmpty = () => Promise.reject(Object.assign(new Error('nothing was painted'), {
    code: 'panoplus-empty',
    userInfo: { sessionDir, counts: { seen: 30, painted: 0 }, abort: null },
  }));

  it('the ok:false result carries HIGH_PAN_SPEED; the NEXT (clean) sweep carries none', async () => {
    // Pins `onSweepFailure` consuming `fastPanRef` into `failureWarnings`
    // (it used to emit `warnings: []` and leave the flag set).
    // MUTATIONS:
    //   · `highPanSpeed: false` in failureWarnings → the first assertion
    //     fails. Killed;
    //   · the consume (`fastPanRef.current = false`) in onSweepFailure removed
    //     → SURVIVES here, by design: the reset at the next sweep's start
    //     (`onSweepingChange(true)`) also clears it. That reset is pinned
    //     alone by the deselect case below; removing BOTH kills this one.
    stopImpl = rejectEmpty;
    g.__m9.bucket = 'bad';
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(h.errs.map((e) => e.code)).toEqual(['PANORAMA_FINALIZE_FAILED']);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].ok).toBe(false);
    expect(h.seen[0].engine).toBe('sweep');
    expect(codes(h.seen[0].warnings)).toContain('HIGH_PAN_SPEED');

    g.__m9.bucket = 'good';
    stopImpl = () => Promise.resolve(summary());
    await sweep(h);
    expect(h.seen).toHaveLength(2);
    expect(h.seen[1].ok).toBe(true);
    expect(codes(h.seen[1].warnings)).not.toContain('HIGH_PAN_SPEED');
    act(() => { h.tree.unmount(); });
  });

  it('⚑ a sweep that ends with NO report (deselected mid-sweep) leaves no flag for the next one', async () => {
    // An abandon or a deselect ends the sweep with NO report, so nothing
    // consumes `fastPanRef`; only the reset at the next sweep's start stands
    // between the flag and the next result. Pins `fastPanRef.current = false`
    // in `onSweepingChange(true)`.
    // MUTATION: remove that reset → the clean sweep reports HIGH_PAN_SPEED.
    // Killed.
    g.__m9.bucket = 'bad';
    const h = await mount({ rectCrop: false, showPreview: false });
    await act(async () => { h.ref.current.startPanorama(); });
    await tick(300);
    expect(startedDirs).toHaveLength(1);
    // The host switches engine mid-sweep: stopped silently, pack kept.
    await h.rerender({ engine: 'keyframe' });
    await drain();
    expect(h.seen).toEqual([]);
    expect(h.errs).toEqual([]);
    g.__m9.bucket = 'good';
    await h.rerender({ engine: 'sweep' });
    await tick(300);
    await sweep(h);
    expect(startedDirs).toHaveLength(2);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].ok).toBe(true);
    expect(codes(h.seen[0].warnings)).not.toContain('HIGH_PAN_SPEED');
    act(() => { h.tree.unmount(); });
  });

  it('⚑ a hold REFUSED from idle neither carries nor consumes a stale flag', async () => {
    // The leak the T6 fix first shipped with (found by this suite's author):
    // a fast sweep ended with NO report (deselected mid-sweep) leaves
    // `fastPanRef` set, and a hold then refused by name from idle — which
    // never swept — carried HIGH_PAN_SPEED on its ok:false. Pins the
    // `ran = sweepPhaseRef.current !== 'idle'` gate in `onSweepFailure`.
    // MUTATION: `const ran = true` → the refusal carries HIGH_PAN_SPEED.
    g.__m9.bucket = 'bad';
    const h = await mount({ rectCrop: false, showPreview: false });
    await act(async () => { h.ref.current.startPanorama(); });
    await tick(300);
    expect(startedDirs).toHaveLength(1);
    await h.rerender({ engine: 'keyframe' });
    await drain();
    expect(h.seen).toEqual([]);
    g.__m9.bucket = 'good';
    // Back on the sweep, with panorama OFF: the hold is refused by name.
    await h.rerender({ engine: 'sweep', enablePanoramaMode: false });
    await tick(300);
    await act(async () => { h.ref.current.startPanorama(); });
    await drain();
    expect(startedDirs).toHaveLength(1);
    const refused = h.seen.filter((r) => r.ok === false);
    expect(refused).toHaveLength(1);
    expect(codes(refused[0].warnings)).not.toContain('HIGH_PAN_SPEED');
    act(() => { h.tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: a failed sweep with NO fast pan carries no HIGH_PAN_SPEED', async () => {
    // Without it the first case passes for a failure that always warns.
    stopImpl = rejectEmpty;
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(h.seen[0].ok).toBe(false);
    expect(codes(h.seen[0].warnings)).not.toContain('HIGH_PAN_SPEED');
    act(() => { h.tree.unmount(); });
  });
});

// ── T8 ──────────────────────────────────────────────────────────────────────
describe('M9 review T8 — a sweep hold behind an open review is refused BY NAME', () => {
  it('CAPTURE_IN_PROGRESS on onError AND onCapture, no native start, and takePhoto right after is not refused as busy', async () => {
    // The review DESELECTS the engine, so a hold used to raise the capture
    // latch into an engine that refused silently — and takePhoto() stayed
    // refused as "a panorama is recording" until the review closed.
    // Pins the `engine === 'sweep' && cropPending != null` refusal.
    // MUTATION: delete it → no panorama ok:false on onCapture, and the raised
    // latch refuses the takePhoto. Killed.
    //
    // The KEYFRAME engine is deliberately NOT refused here: a host-driven
    // keyframe capture may start behind a pending review, which waits — that
    // is pinned in keyframeLateralStop.render.test.tsx, "a review pending
    // from the last capture waits behind a drift explainer, then shows".
    const h = await mount({ rectCrop: false, showPreview: true });
    await sweep(h);
    expect(review(h.tree)).toHaveLength(1);
    expect(h.seen).toEqual([]);
    await act(async () => {
      h.ref.current.startPanorama();
      void h.ref.current.takePhoto();   // same tick: no render in between
      await Promise.resolve();
    });
    await tick(300);
    expect(startedDirs).toHaveLength(1);
    const holdRefusals = h.errs.filter((e) => e.code === 'CAPTURE_IN_PROGRESS');
    expect(holdRefusals).toHaveLength(1);
    expect(holdRefusals[0].message).toContain('still in review');
    expect(takePhotoRefusals(h)).toBe(0);
    const panoramas = h.seen.filter((r) => r.type === 'panorama');
    expect(panoramas.map((r) => [r.ok, r.engine, r.error?.code]))
      .toEqual([[false, 'sweep', 'CAPTURE_IN_PROGRESS']]);
    expect(panoramas[0].error).toBe(holdRefusals[0]);
    // …and the review is still the one on screen.
    expect(review(h.tree)).toHaveLength(1);
    act(() => { h.tree.unmount(); });
  });
});

// ── T10 (the <Camera> half) ────────────────────────────────────────────────
describe('M9 review T10 — a rejected native stop is a FINALIZE failure, through the real engine', () => {
  it('stop rejects panoplus-io: onError AND onCapture carry PANORAMA_FINALIZE_FAILED', async () => {
    // Pins `onFailure?.({ ...info, stage: 'finish' })` in the engine's
    // `finish()` as `<Camera>` sees it. The hook half is pinned in
    // useSweepEngineEnabled.render.test.tsx.
    // MUTATION: drop `stage: 'finish'` → PANORAMA_START_FAILED for a sweep
    // that started, ran and failed to finish. Killed.
    stopImpl = () => Promise.reject(Object.assign(new Error('write failed'), { code: 'panoplus-io' }));
    const h = await mount({ rectCrop: false, showPreview: false });
    await sweep(h);
    expect(h.errs.map((e) => e.code)).toEqual(['PANORAMA_FINALIZE_FAILED']);
    expect(h.seen.map((r) => [r.ok, r.type, r.engine, r.error?.code]))
      .toEqual([[false, 'panorama', 'sweep', 'PANORAMA_FINALIZE_FAILED']]);
    expect(h.seen[0].error.cause).toEqual(expect.objectContaining({
      code: 'panoplus-io', stage: 'finish',
    }));
    // A rejected stop that is NOT `not-running` keeps the pack: no cancel.
    expect(cancels).toBe(0);
    act(() => { h.tree.unmount(); });
  });
});
