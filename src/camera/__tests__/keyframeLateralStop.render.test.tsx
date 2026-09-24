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
g.__pm = { lateralExceeded: false };

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
    usePanMotion: (o: any) => ({
      ...actual.usePanMotion(o),
      lateralExceeded: (globalThis as any).__pm.lateralExceeded,
    }),
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
  g.__pm.lateralExceeded = false;
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
