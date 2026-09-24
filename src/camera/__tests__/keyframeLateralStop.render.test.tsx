// SPDX-License-Identifier: Apache-2.0
/**
 * The KEYFRAME engine's lateral-drift stop, and the config that reaches
 * native — driven through the real `<Camera>` with a controllable incremental
 * engine and pan-motion latch.
 *
 * ⚠ WHY THIS EXISTS. The lateral popup used to be raised AT the stop, and
 * ~550 ms later the finished stitch mounted `RectCropPreview` on top of it:
 * two RN `<Modal>`s at once, which on iOS leaves an invisible window that
 * swallows every touch — a dead shutter (28d11df). With `rectCrop` ON by
 * default since 2026-09-23, every default host reaches that path.
 * `modalPresentation.ts` now decides the popup up front — a finalized stop
 * that opens a review shows none — and `lateralStopPolicy.ts` decides whether
 * the stop keeps anything (default floor: 5 keyframes). Every sweep-engine
 * guard-rail test mounts `engine="sweep"`, so this file is what covers the
 * keyframe branch through the real `<Camera>`.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const g = globalThis as any;
g.__kf = {
  state: { acceptedCount: 0 },
  finalizeImpl: null as null | (() => Promise<any>),
  calls: [] as string[],
  startArgs: [] as any[],
};
g.__pm = { lateralExceeded: false, opts: [] as any[] };
g.__drift = { on: false };

jest.mock('../../stitching/useIncrementalStitcher', () => {
  const obj: any = {
    isAvailable: true,
    isRunning: false,
    hint: null,
    confidenceLevel: null,
    keyframeThumbnails: [],
    start: async (args: unknown) => {
      (globalThis as any).__kf.calls.push('start');
      (globalThis as any).__kf.startArgs.push(args);
      // M9 review T11 — a native start refusal on demand.
      if ((globalThis as any).__kf.startFails) throw new Error('native start refused');
      return { ok: true };
    },
    finalize: () => {
      (globalThis as any).__kf.calls.push('finalize');
      return (globalThis as any).__kf.finalizeImpl!();
    },
    cancel: () => {
      (globalThis as any).__kf.calls.push('cancel');
      return Promise.resolve();
    },
  };
  return {
    useIncrementalStitcher: () => {
      obj.state = (globalThis as any).__kf.state;
      return obj;
    },
  };
});
jest.mock('../../stitching/incremental', () => ({
  ...jest.requireActual('../../stitching/incremental'),
  incrementalStitcherIsAvailable: () => true,
  incrementalMissingMethods: () => null,
}));
jest.mock('../usePanMotion', () => {
  const actual = jest.requireActual('../usePanMotion');
  return {
    ...actual,
    usePanMotion: (o: any) => {
      (globalThis as any).__pm.opts.push(o);
      return {
        ...actual.usePanMotion(o),
        lateralExceeded: (globalThis as any).__pm.lateralExceeded,
      };
    },
  };
});
// Orientation drift on demand, only while the hook is active — as the real
// hook reports it.
jest.mock('../useOrientationDrift', () => {
  const actual = jest.requireActual('../useOrientationDrift');
  return {
    ...actual,
    useOrientationDrift: (active: boolean) => {
      const r = actual.useOrientationDrift(active);
      return (globalThis as any).__drift.on && active
        ? {
            ...r, drifted: true,
            captureOrientation: 'landscape-left', currentOrientation: 'portrait',
          }
        : r;
    },
  };
});
jest.mock('../../stitching/computeInscribedRect', () => ({
  computeInscribedRect: async () => ({ x: 1, y: 1, width: 10, height: 10 }),
}));

// eslint-disable-next-line import/first
import { Camera } from '../Camera';
// eslint-disable-next-line import/first
import { RectCropPreview } from '../RectCropPreview';
// eslint-disable-next-line import/first
import { LateralMotionModal } from '../LateralMotionModal';
// eslint-disable-next-line import/first
import { OrientationDriftModal } from '../OrientationDriftModal';
// eslint-disable-next-line import/first
import { DEFAULT_GUIDANCE_COPY } from '../cameraGuidanceCopy';

const OK_RESULT = {
  panoramaPath: '/d/p.jpg', width: 400, height: 100,
  framesRequested: 3, framesIncluded: 3,
};

function el(props: any, ref: any) {
  return (
    <Camera ref={ref} enablePanoramaMode panMode="both" lateralBudgetCm={1}
      outputDir="/tmp/out" {...props} />
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(props: any) {
  const ref = React.createRef<any>();
  let t!: ReactTestRenderer;
  await act(async () => { t = create(el(props, ref)); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => {
    ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
  });
  return {
    t, ref,
    rerender: async () => { await act(async () => { t.update(el(props, ref)); }); },
  };
}

/** Trip the lateral latch with `keyframes` accepted, then let finalize land. */
async function tripLateral(rerender: () => Promise<void>, keyframes: number) {
  g.__kf.state = { acceptedCount: keyframes };
  await rerender();
  g.__pm.lateralExceeded = true;
  await rerender();
}

beforeEach(() => {
  g.__kf.state = { acceptedCount: 0 };
  g.__kf.calls = [];
  g.__kf.startArgs = [];
  g.__kf.finalizeImpl = async () => OK_RESULT;
  g.__kf.startFails = false;
  g.__pm.lateralExceeded = false;
  g.__pm.opts = [];
  g.__drift.on = false;
});

const vis = (t: ReactTestRenderer, T: any) => t.root.findByType(T).props.visible;

describe('keyframe lateral stop — never two modals at once', () => {
  it('with the crop editor (the default): no popup, ever — the review banner carries the reason', async () => {
    const seen: any[] = [];
    const { t, rerender } = await setup({ onCapture: (r: any) => seen.push(r) });
    await tripLateral(rerender, 5);
    // The instant of the stop is where the old code raised it.
    expect(vis(t, LateralMotionModal)).toBe(false);
    await act(async () => { await sleep(120); });
    await act(async () => { await Promise.resolve(); });
    expect(g.__kf.calls).toContain('finalize');
    expect(vis(t, RectCropPreview)).toBe(true);
    expect(vis(t, LateralMotionModal)).toBe(false);
    expect(t.root.findByType(RectCropPreview).props.warnings.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(0); // deferred behind the review
    act(() => t.unmount());
  });

  it('with no review surface: the popup is the fallback, and onCapture says why', async () => {
    const seen: any[] = [];
    const { t, rerender } = await setup({ rectCrop: false, onCapture: (r: any) => seen.push(r) });
    await tripLateral(rerender, 5);
    await act(async () => { await sleep(120); });
    expect(vis(t, LateralMotionModal)).toBe(true);
    expect(vis(t, RectCropPreview)).toBe(false);
    expect(seen[0].warnings.map((w: any) => w.code)).toContain('LATERAL_DRIFT_FINALIZE');
    // M9 review T11 — the result NAMES its engine, as a sweep's does.
    // MUTATION: drop `engine` from the success result. Killed.
    expect(seen[0].ok).toBe(true);
    expect(seen[0].engine).toBe('keyframe');
    act(() => t.unmount());
  });

  it('when the stitch fails with a review configured: no popup, and BOTH callbacks say why', async () => {
    // `lateralPopupShouldShow`'s documented edge case: the popup is decided up
    // front from the host's configuration, so a finalized stop on a host with
    // a review surface shows none even when the stitch then fails. Biasing
    // the other way would reinstate the two-modal clash for every normal
    // capture. The failure reaches the host on `onError` AND `onCapture`, and
    // the latter still carries the cause.
    g.__kf.finalizeImpl = async () => { throw new Error('boom'); };
    const seen: any[] = [];
    const errors: unknown[] = [];
    const { t, rerender } = await setup({
      onCapture: (r: any) => seen.push(r), onError: (e: unknown) => errors.push(e),
    });
    await tripLateral(rerender, 5);
    await act(async () => { await sleep(120); });
    expect(vis(t, LateralMotionModal)).toBe(false);
    expect(vis(t, RectCropPreview)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(seen[0].ok).toBe(false);
    expect(seen[0].warnings.map((w: any) => w.code)).toContain('LATERAL_DRIFT_FINALIZE');
    // M9 review T11 — ok:false names its engine too.
    // MUTATION: drop `engine` from the stitch-failure onCapture. Killed.
    expect(seen[0].engine).toBe('keyframe');
    expect(seen[0].type).toBe('panorama');
    act(() => t.unmount());
  });

  it('2 to 4 keyframes under the default floor of 5: DISCARDED — abandon, the discard copy, no finalize', async () => {
    const ab: string[] = [];
    const { t, rerender } = await setup({ onCaptureAbandoned: (r: string) => ab.push(r) });
    await tripLateral(rerender, 3);
    await act(async () => { await sleep(120); });
    expect(vis(t, LateralMotionModal)).toBe(true);
    expect(t.root.findByType(LateralMotionModal).props.title)
      .toBe(DEFAULT_GUIDANCE_COPY.lateralStopDiscardedTitle);
    expect(g.__kf.calls).not.toContain('finalize');
    expect(g.__kf.calls).toContain('cancel');
    expect(ab).toEqual(['lateral-drift']);
    act(() => t.unmount());
  });

  it('under 2 keyframes: abandon with the wrong-direction popup, no finalize (unchanged)', async () => {
    const ab: string[] = [];
    const { t, rerender } = await setup({ onCaptureAbandoned: (r: string) => ab.push(r) });
    await tripLateral(rerender, 1);
    await act(async () => { await sleep(120); });
    expect(vis(t, LateralMotionModal)).toBe(true);
    expect(g.__kf.calls).not.toContain('finalize');
    expect(g.__kf.calls).toContain('cancel');
    expect(ab).toEqual(['lateral-drift']);
    act(() => t.unmount());
  });

  it('the next capture carries no stale lateral state', async () => {
    const seen: any[] = [];
    const { t, rerender, ref } = await setup({ rectCrop: false, onCapture: (r: any) => seen.push(r) });
    await tripLateral(rerender, 5);
    await act(async () => { await sleep(120); });
    g.__pm.lateralExceeded = false;
    g.__kf.state = { acceptedCount: 0 };
    await rerender();
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    expect(vis(t, LateralMotionModal)).toBe(false);
    g.__kf.state = { acceptedCount: 3 };
    await rerender();
    await act(async () => { ref.current.stopPanorama(); });
    await act(async () => { await sleep(120); });
    expect(seen).toHaveLength(2);
    expect(seen[1].warnings.map((w: any) => w.code)).not.toContain('LATERAL_DRIFT_FINALIZE');
    act(() => t.unmount());
  });
});

describe('the keyframe engine arms the IMU lateral guard only once it has something to protect', () => {
  const lastOpts = () => g.__pm.opts[g.__pm.opts.length - 1];
  it('non-AR: the budget is 0 at 0-1 keyframes and the host value from 2', async () => {
    const { t, rerender } = await setup({ lateralBudgetCm: 7 });
    expect(lastOpts().active).toBe(true);
    expect(lastOpts().lateralBudgetCm).toBe(0);
    g.__kf.state = { acceptedCount: 1 };
    await rerender();
    expect(lastOpts().lateralBudgetCm).toBe(0);
    g.__kf.state = { acceptedCount: 2 };
    await rerender();
    expect(lastOpts().lateralBudgetCm).toBe(7);
    act(() => t.unmount());
  });
  it('is inactive, and unarmed, when no capture is recording', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => { t = create(el({ lateralBudgetCm: 7 }, ref)); });
    expect(lastOpts().active).toBe(false);
    act(() => t.unmount());
  });
});

describe('orientation drift outranks the lateral stop, and its opt-out opts out', () => {
  it('drift and lateral in the same render: the capture is ABANDONED for drift, never finalized', async () => {
    const ab: string[] = [];
    const { t, rerender } = await setup({ onCaptureAbandoned: (r: string) => ab.push(r) });
    g.__kf.state = { acceptedCount: 5 };
    await rerender();
    g.__drift.on = true;
    g.__pm.lateralExceeded = true;
    await rerender();
    await act(async () => { await sleep(120); });
    expect(g.__kf.calls).not.toContain('finalize');
    expect(ab).toEqual(['orientation-drift']);
    expect(vis(t, OrientationDriftModal)).toBe(true);
    expect(vis(t, LateralMotionModal)).toBe(false);
    act(() => t.unmount());
  });

  it('orientationDriftAbandon={false}: no abandon, no explainer — and the lateral stop still works', async () => {
    const ab: string[] = [];
    const { t, rerender } = await setup({
      rectCrop: false, orientationDriftAbandon: false,
      onCaptureAbandoned: (r: string) => ab.push(r),
    });
    g.__kf.state = { acceptedCount: 5 };
    await rerender();
    g.__drift.on = true;
    await rerender();
    await act(async () => { await sleep(50); });
    expect(ab).toEqual([]);
    expect(vis(t, OrientationDriftModal)).toBe(false);
    g.__pm.lateralExceeded = true;
    await rerender();
    await act(async () => { await sleep(120); });
    expect(g.__kf.calls).toContain('finalize');
    act(() => t.unmount());
  });
});

describe('<Camera> holds the modal invariant: never two capture modals at once', () => {
  it('a review pending from the last capture waits behind a drift explainer, then shows', async () => {
    const { t, rerender, ref } = await setup({});
    // Capture 1 finalizes into a review (rectCrop is on by default).
    g.__kf.state = { acceptedCount: 3 };
    await rerender();
    await act(async () => { ref.current.stopPanorama(); });
    await act(async () => { await sleep(120); });
    expect(vis(t, RectCropPreview)).toBe(true);
    // A host-driven capture 2 starts under it and trips orientation drift.
    g.__kf.state = { acceptedCount: 0 };
    await rerender();
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    g.__drift.on = true;
    await rerender();
    await act(async () => { await sleep(120); });
    expect(vis(t, OrientationDriftModal)).toBe(true);
    expect(vis(t, RectCropPreview)).toBe(false);
    // Acknowledged: the review is back.
    g.__drift.on = false;
    await act(async () => { t.root.findByType(OrientationDriftModal).props.onAcknowledge(); });
    expect(vis(t, OrientationDriftModal)).toBe(false);
    expect(vis(t, RectCropPreview)).toBe(true);
    act(() => t.unmount());
  });

  it('an unacknowledged drift explainer is cleared when the next capture starts', async () => {
    const { t, rerender, ref } = await setup({ rectCrop: false });
    g.__drift.on = true;
    await rerender();
    await act(async () => { await sleep(120); });
    expect(vis(t, OrientationDriftModal)).toBe(true);
    g.__drift.on = false;
    await rerender();
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    expect(vis(t, OrientationDriftModal)).toBe(false);
    act(() => t.unmount());
  });
});

describe('the crop editor owns cropping at the native boundary', () => {
  const nativeAutoCrop = () => g.__kf.startArgs[0]?.config?.enableMaxInscribedRectCrop;

  it('with the editor on (the default), the recipe spelling of the auto-crop does not reach native', async () => {
    const { t } = await setup({ stitcher: { enableMaxInscribedRectCrop: true } });
    expect(g.__kf.calls).toContain('start');
    expect(nativeAutoCrop()).toBe(false);
    act(() => t.unmount());
  });

  it('with rectCrop={false}, the recipe reaches native untouched', async () => {
    const { t } = await setup({ rectCrop: false, stitcher: { enableMaxInscribedRectCrop: true } });
    expect(nativeAutoCrop()).toBe(true);
    act(() => t.unmount());
  });
});

/**
 * M9 review T11 — `engine="batch-keyframe"`, the DEPRECATED synonym, names
 * ITSELF on every result: a host that asked for `'batch-keyframe'` and
 * branches on `result.engine` must not be handed `'keyframe'` on one exit and
 * `'batch-keyframe'` on another. (It is `'batch-keyframe'` on the wire either
 * way — the synonym changes nothing native does.)
 */
describe('M9 review T11 — engine="batch-keyframe" is named on success AND on failure', () => {
  it('success: engine "batch-keyframe"', async () => {
    // MUTATION: `engine: 'keyframe'` literal on the success result. Killed.
    const seen: any[] = [];
    const { t, rerender, ref } = await setup({
      engine: 'batch-keyframe', rectCrop: false, onCapture: (r: any) => seen.push(r),
    });
    expect(g.__kf.calls).toContain('start');
    g.__kf.state = { acceptedCount: 3 };
    await rerender();
    await act(async () => { ref.current.stopPanorama(); });
    await act(async () => { await sleep(120); });
    expect(seen.map((r) => [r.ok, r.type, r.engine])).toEqual([[true, 'panorama', 'batch-keyframe']]);
    act(() => t.unmount());
  });

  it('a stitch failure: ok:false, engine "batch-keyframe"', async () => {
    // MUTATION: `engine: 'keyframe'` literal on the stitch-failure onCapture.
    // Killed.
    g.__kf.finalizeImpl = async () => { throw new Error('boom'); };
    const seen: any[] = [];
    const { t, rerender, ref } = await setup({
      engine: 'batch-keyframe', rectCrop: false, onCapture: (r: any) => seen.push(r),
      onError: () => undefined,
    });
    g.__kf.state = { acceptedCount: 3 };
    await rerender();
    await act(async () => { ref.current.stopPanorama(); });
    await act(async () => { await sleep(120); });
    expect(seen.map((r) => [r.ok, r.type, r.engine])).toEqual([[false, 'panorama', 'batch-keyframe']]);
    act(() => t.unmount());
  });

  it('a START failure: ok:false, engine "batch-keyframe", on both channels', async () => {
    // MUTATION: `engine: 'keyframe'` literal on the start-failure onCapture.
    // Killed.
    g.__kf.startFails = true;
    const seen: any[] = [];
    const errors: Array<{ code: string }> = [];
    const { t } = await setup({
      engine: 'batch-keyframe', rectCrop: false,
      onCapture: (r: any) => seen.push(r), onError: (e: { code: string }) => errors.push(e),
    });
    await act(async () => { await sleep(20); });
    expect(g.__kf.calls).toContain('start');
    expect(errors.map((e) => e.code)).toEqual(['PANORAMA_START_FAILED']);
    expect(seen.map((r) => [r.ok, r.type, r.engine, r.error?.code]))
      .toEqual([[false, 'panorama', 'batch-keyframe', 'PANORAMA_START_FAILED']]);
    act(() => t.unmount());
  });

  it('⚑ NEGATIVE CONTROL: the default engine is named "keyframe", not the synonym', async () => {
    // Without it the three cases above pass for a result that always says
    // 'batch-keyframe' (the WIRE value) whatever the host asked for.
    const seen: any[] = [];
    const { t, rerender, ref } = await setup({ rectCrop: false, onCapture: (r: any) => seen.push(r) });
    g.__kf.state = { acceptedCount: 3 };
    await rerender();
    await act(async () => { ref.current.stopPanorama(); });
    await act(async () => { await sleep(120); });
    expect(seen.map((r) => [r.ok, r.engine])).toEqual([[true, 'keyframe']]);
    act(() => t.unmount());
  });
});
