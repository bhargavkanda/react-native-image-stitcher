// SPDX-License-Identifier: Apache-2.0
/**
 * Regressions found by the adversarial review of the main→unify-camera merge,
 * each driven through the real `<Camera>` with the sweep surface stubbed at
 * its imperative handle (the same contract `sweepGuardRails` uses).
 *
 * 1. A stale AR pose-drift latch. Main's pose guard (`arDriftExceeded`)
 *    outlives the capture that set it, and its clearing effect runs in the
 *    same commit as the lateral stop — one render too late — and not at all
 *    with AR off. After an AR keyframe capture stopped for pose drift, the
 *    next SWEEP was abandoned the moment it started ("follow the arrow", 0
 *    strips), and with AR off every sweep after it.
 * 2. `setCaptureSource` mid-sweep. Main added the handle as a way for host
 *    chrome to drive the built-in AR pill's preference, but it skipped the
 *    pill's "not while a sweep runs" guard, so a host could stop the shared AR
 *    session under a live AR sweep.
 * 3. A hold inside the sweep→keyframe camera handoff. The render gate
 *    unmounts the camera for 600 ms (`sweepHandoffPending`); the hold gate
 *    did not know, so a hold there started a keyframe capture against no
 *    camera. (M8: the handoff now exists only for the DR-1a hatch; on every
 *    other cell the sweep runs on `<Camera>`'s own camera and an engine
 *    switch unmounts nothing.)
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, StyleSheet } from 'react-native';

const g = globalThis as any;
g.__kf = { state: { acceptedCount: 0 }, calls: [] as string[] };
g.__sw = { calls: [] as string[], props: {} as any };
g.__ar = { props: {} as any, exceed: false };
g.__fp = { failed: false };

jest.mock('../../stitching/useIncrementalStitcher', () => {
  const obj: any = {
    isAvailable: true, isRunning: false, hint: null, confidenceLevel: null,
    keyframeThumbnails: [],
    start: async () => {
      (globalThis as any).__kf.calls.push('start');
      if ((globalThis as any).__kf.startFails) throw new Error('native start refused');
      return { ok: true };
    },
    finalize: async () => {
      (globalThis as any).__kf.calls.push('finalize');
      return {
        panoramaPath: '/d/p.jpg', width: 400, height: 100,
        framesRequested: 3, framesIncluded: 3,
      };
    },
    cancel: () => { (globalThis as any).__kf.calls.push('cancel'); return Promise.resolve(); },
  };
  return {
    useIncrementalStitcher: () => { obj.state = (globalThis as any).__kf.state; return obj; },
  };
});
// `__kf.moduleMissing` stands in for a build whose incremental stitcher module
// is not registered at all (M9 review T7b); every other case sees it linked.
jest.mock('../../stitching/incremental', () => ({
  ...jest.requireActual('../../stitching/incremental'),
  incrementalStitcherIsAvailable: () => !(globalThis as any).__kf.moduleMissing,
  incrementalMissingMethods: () => null,
}));
// The REAL frame-processor driver, with `acquisitionFailed` forced when
// `__fp.failed` is set: a build without the `cv_flow_gate_process_frame`
// vision-camera plugin (M9 review T7a). Every other case sees the real value.
jest.mock('../../stitching/useFrameProcessorDriver', () => {
  const actual = jest.requireActual('../../stitching/useFrameProcessorDriver');
  return {
    ...actual,
    useFrameProcessorDriver: (o: unknown) => {
      const d = actual.useFrameProcessorDriver(o);
      return (globalThis as any).__fp.failed ? { ...d, acquisitionFailed: true } : d;
    },
  };
});
// The pose guard latches on the first armed frame whenever `__ar.exceed` is set.
jest.mock('../arLateralDrift', () => {
  const actual = jest.requireActual('../arLateralDrift');
  return {
    ...actual,
    _advanceArDrift: (...a: unknown[]) => ((globalThis as any).__ar.exceed
      ? {
          exceeded: true, driftM: 0.2, peakM: 0.2, longM: 0, allowanceM: 0.08,
          rotRad: 0, peakRotRad: 0, latchedBy: 'distance', untrackedCount: 0,
          degenerateCount: 0,
        }
      : (actual._advanceArDrift as (...x: unknown[]) => unknown)(...a)),
  };
});
jest.mock('../ARCameraView', () => {
  const R = require('react');
  const ARCameraView = R.forwardRef((props: any, _ref: any) => {
    (globalThis as any).__ar.props = props;
    return R.createElement('ARCameraViewStub', null);
  });
  return { __esModule: true, ARCameraView };
});
// M8 — the engine is a hook `<Camera>` calls on every engine; the stub is the
// hook, inert and unrecorded while not selected, as the unmounted surface was.
jest.mock('../../sweep/useSweepEngine', () => {
  const R = require('react');
  function useSweepEngine(props: any, ref: any, options: { enabled?: boolean } = {}) {
    const enabled = options.enabled !== false;
    if (enabled) (globalThis as any).__sw.props = props;
    const inert = () => undefined;
    // Is a sweep live? The real engine's `holdEnd` ends nothing without one.
    const live = R.useRef(false);
    R.useImperativeHandle(ref, () => (!enabled ? {
      capture: inert, finalize: inert, holdStart: inert, holdEnd: inert, abandon: inert,
    } : {
      capture: () => undefined,
      finalize: () => undefined,
      holdStart: () => {
        (globalThis as any).__sw.calls.push('holdStart');
        // The real engine's ORDER — `useSweepEngine`'s `holdStart`, then its
        // `start()` — which `hatchSettleHold.render.test.tsx` pins on the real
        // hook. Each refusal goes to `onFailure`, and nothing starts:
        //   1. the host's panorama-off refusal (`hostArmRefusal` with code
        //      `panoplus-panorama-disabled`), before the engine's readiness;
        //   2. the engine's readiness (`canCapture`): `__sw.notReady` stands in
        //      for the iOS arm whose calibration read is still in flight;
        //   3. any other named host refusal (`hostArmRefusal`), in `start()`.
        // Every other case here runs with no refusal and a ready engine.
        const refuse = (r: { code: string; message: string }) => {
          props.onFailure?.({
            code: r.code, message: r.message,
            sessionDir: null, counts: null, abort: null,
          });
        };
        const refusal = props.hostArmRefusal;
        if (refusal?.code === 'panoplus-panorama-disabled') { refuse(refusal); return; }
        if ((globalThis as any).__sw.notReady) {
          refuse({
            code: 'panoplus-not-ready',
            message: 'This sweep cannot start yet: it is still loading. Try again in a moment.',
          });
          return;
        }
        if (refusal != null) { refuse(refusal); return; }
        live.current = true;
        props.onSweepingChange?.(true);
      },
      holdEnd: () => {
        (globalThis as any).__sw.calls.push('holdEnd');
        // Faithful to the real engine: a release with no live sweep (a
        // refused start) ends nothing and reports nothing.
        if (!live.current) return;
        props.onControlsState?.({ canCapture: true, canFinalize: false, busy: true });
      },
      // Faithful to the real surface: an abandon ends the sweep (phase idle)
      // and its live status, so progress reads 0 again.
      abandon: (reason: string) => {
        (globalThis as any).__sw.calls.push(`abandon:${reason}`);
        live.current = false;
        props.onPaintedChange?.(0);
        props.onSweepingChange?.(false);
      },
    }), [props, enabled]);
    const wasEnabled = R.useRef(enabled);
    R.useEffect(() => {
      const was = wasEnabled.current;
      wasEnabled.current = enabled;
      if (was && !enabled) props.onSweepingChange?.(false);
    }, [enabled]);
    // The fields `<Camera>`'s own tree reads off the engine.
    return { phase: 'idle', setSurfaceBox: () => undefined, handleArFrame: () => undefined };
  }
  return { __esModule: true, useSweepEngine };
});
jest.mock('../../sweep/SweepHatchScreen', () => ({
  __esModule: true, SweepHatchScreen: () => null,
}));

// eslint-disable-next-line import/first
import { Camera, LensChip, SWEEP_PANORAMA_DISABLED } from '../Camera';
// eslint-disable-next-line import/first
import { LateralMotionModal } from '../LateralMotionModal';
// eslint-disable-next-line import/first
import { RotateToLandscapePrompt } from '../RotateToLandscapePrompt';
// eslint-disable-next-line import/first
import { CameraShutter } from '../CameraShutter';
// eslint-disable-next-line import/first
import { PANO_BOTTOM_BAR_INSET } from '../../sweep/sweepLayout';
// eslint-disable-next-line import/first
import { coercePanoPlusSummary, panoPlusResultOf } from '../../sweep/panoPlusModel';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function el(props: any, ref: any) {
  return (
    <Camera
      ref={ref} enablePanoramaMode panMode="both" outputDir="/tmp/out"
      captureSources="both" {...props}
    />
  );
}

beforeEach(() => {
  g.__kf.state = { acceptedCount: 0 };
  g.__kf.calls = [];
  g.__kf.startFails = false;
  g.__kf.moduleMissing = false;
  g.__fp.failed = false;
  g.__sw.calls = [];
  g.__sw.props = {};
  g.__sw.notReady = false;
  g.__ar.props = {};
  g.__ar.exceed = false;
});

async function arKeyframeCaptureStoppedByPoseDrift(abandoned: string[]) {
  const ref = React.createRef<any>();
  let t!: ReactTestRenderer;
  let props: any = {
    engine: 'keyframe', defaultCaptureSource: 'ar',
    onCaptureAbandoned: (r: string) => abandoned.push(r),
  };
  await act(async () => { t = create(el(props, ref)); });
  await act(async () => { await sleep(400); }); // AR probe + 250 ms transition settle
  expect(typeof g.__ar.props.onArFrame).toBe('function');
  await act(async () => {
    ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
  });
  expect(g.__kf.calls).toContain('start');
  g.__kf.state = { acceptedCount: 1 };
  await act(async () => { t.update(el(props, ref)); });
  g.__ar.exceed = true;
  await act(async () => {
    g.__ar.props.onArFrame({
      pose: { rotation: [0, 0, 0, 1], translation: [0, 0, 0] }, trackingState: 'normal',
    });
  });
  await act(async () => { await sleep(50); });
  const rerender = async (p: any) => {
    props = { ...props, ...p };
    await act(async () => { t.update(el(props, ref)); });
  };
  return { t, ref, rerender };
}

describe('a stale AR pose-drift latch never reaches the next sweep', () => {
  it('control: the keyframe capture WAS stopped by the AR pose guard', async () => {
    const abandoned: string[] = [];
    const { t } = await arKeyframeCaptureStoppedByPoseDrift(abandoned);
    expect(g.__kf.calls).toContain('cancel');
    expect(abandoned).toEqual(['lateral-drift']);
    act(() => t.unmount());
  });

  it('AR on: the first sweep after the engine switch is not killed on arrival', async () => {
    const abandoned: string[] = [];
    const { t, rerender } = await arKeyframeCaptureStoppedByPoseDrift(abandoned);
    abandoned.length = 0;
    await act(async () => { t.root.findByType(LateralMotionModal).props.onDismiss(); });
    await rerender({ engine: 'sweep' });
    await act(async () => { await sleep(50); });
    await act(async () => { g.__sw.props.onSweepingChange(true); });
    await act(async () => { await sleep(20); });
    expect(g.__sw.calls).not.toContain('abandon:lateral-drift');
    expect(abandoned).toEqual([]);
    expect(t.root.findByType(LateralMotionModal).props.visible).toBe(false);
    act(() => t.unmount());
  });

  it('AR off: no sweep after the switch is killed — three holds in a row', async () => {
    const abandoned: string[] = [];
    const { t, ref, rerender } = await arKeyframeCaptureStoppedByPoseDrift(abandoned);
    abandoned.length = 0;
    await act(async () => { t.root.findByType(LateralMotionModal).props.onDismiss(); });
    await act(async () => { ref.current.setCaptureSource('non-ar'); });
    await act(async () => { await sleep(400); });
    await rerender({ engine: 'sweep' });
    await act(async () => { await sleep(50); });
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { g.__sw.props.onSweepingChange(true); });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await sleep(20); });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { g.__sw.props.onSweepingChange(false); });
    }
    expect(g.__sw.calls.filter((c: string) => c === 'abandon:lateral-drift')).toHaveLength(0);
    expect(abandoned).toEqual([]);
    act(() => t.unmount());
  });
});

describe('setCaptureSource follows the built-in pill, including its guard', () => {
  it('is refused while an AR sweep runs — no AR session stop, pose source unchanged', async () => {
    const mod = (NativeModules as any).RNSARSession;
    const orig = mod.stop;
    let stops = 0;
    mod.stop = () => { stops += 1; return Promise.resolve(); };
    try {
      const ref = React.createRef<any>();
      let t!: ReactTestRenderer;
      await act(async () => {
        t = create(el({ engine: 'sweep', defaultCaptureSource: 'ar' }, ref));
      });
      await act(async () => { await sleep(400); });
      const poseBefore = g.__sw.props.poseSource;
      const stopsBefore = stops;
      await act(async () => { g.__sw.props.onSweepingChange(true); });
      await act(async () => { await sleep(20); });
      await act(async () => { ref.current.setCaptureSource('non-ar'); });
      await act(async () => { await sleep(400); });
      expect(stops - stopsBefore).toBe(0);
      expect(g.__sw.props.poseSource).toBe(poseBefore);
      // …and honoured once the sweep has ended.
      await act(async () => { g.__sw.props.onSweepingChange(false); });
      await act(async () => { ref.current.setCaptureSource('non-ar'); });
      await act(async () => { await sleep(400); });
      expect(g.__sw.props.poseSource).not.toBe(poseBefore);
      act(() => t.unmount());
    } finally {
      mod.stop = orig;
    }
  });
});

describe('a hold during the sweep→keyframe camera handoff waits for the camera', () => {
  const placeholder = (t: ReactTestRenderer) => t.root.findAll(
    (n: any) => n.props && n.props.children === 'Switching camera…',
  ).length > 0;

  // M8 — the handoff exists only where the sweep had a camera of its OWN to
  // hand back: the DR-1a reference hatch (non-AR).
  it('the DR-1a hatch: deferred while the camera is unmounted, then resumed', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    const base: any = { defaultCaptureSource: 'non-ar', rectCrop: false };
    const hatch = { frameSourceOverride: 'own' };
    await act(async () => { t = create(el({ ...base, engine: 'sweep', sweep: hatch }, ref)); });
    await act(async () => { await sleep(900); });
    await act(async () => { t.update(el({ ...base, engine: 'keyframe', sweep: hatch }, ref)); });
    await act(async () => { await Promise.resolve(); });
    expect(placeholder(t)).toBe(true);   // the handoff window is real
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    expect(g.__kf.calls).not.toContain('start');
    // Waiting for a CAMERA is not the pan-mode gate: no rotate prompt
    // (panMode 'both' never gates). M8 review — it used to show here.
    expect(t.root.findAllByType(RotateToLandscapePrompt)
      .some((p: any) => p.props.visible === true)).toBe(false);
    await act(async () => { await sleep(900); });
    expect(placeholder(t)).toBe(false);
    expect(g.__kf.calls).toContain('start');
    act(() => t.unmount());
  });

  for (const src of ['ar', 'non-ar'] as const) {
    it(`⚑ M8, ${src}: no hatch, no handoff — the camera stays up and the hold starts at once`, async () => {
      const ref = React.createRef<any>();
      let t!: ReactTestRenderer;
      const base: any = { defaultCaptureSource: src, rectCrop: false };
      await act(async () => { t = create(el({ ...base, engine: 'sweep' }, ref)); });
      await act(async () => { await sleep(400); });
      await act(async () => { t.update(el({ ...base, engine: 'keyframe' }, ref)); });
      await act(async () => { await Promise.resolve(); });
      expect(placeholder(t)).toBe(false);   // an engine switch is not a camera switch
      await act(async () => {
        ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
      });
      expect(g.__kf.calls).toContain('start');
      act(() => t.unmount());
    });
  }
});

describe('M8 — an AR SWEEP is pose-guarded through <Camera>\'s own AR view', () => {
  it('pose drift on a sweep that has painted finalizes it through its handle', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    const abandoned: string[] = [];
    await act(async () => {
      // A KNOWN axis: 'horizontal' is the portrait hold. Under 'both' the
      // pose guard stands down on a sweep (see the case below).
      t = create(el({
        engine: 'sweep', defaultCaptureSource: 'ar', rectCrop: false, panMode: 'horizontal',
        onCaptureAbandoned: (r: string) => abandoned.push(r),
      }, ref));
    });
    await act(async () => { await sleep(400); });
    // `<Camera>`'s AR view is the sweep's camera, and it is fed its frames.
    expect(typeof g.__ar.props.onArFrame).toBe('function');
    expect(g.__sw.props.frameSource).toBe('host-ar');
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    expect(g.__sw.calls).toContain('holdStart');
    await act(async () => { g.__sw.props.onPaintedChange(30); });
    g.__ar.exceed = true;
    await act(async () => {
      g.__ar.props.onArFrame({
        pose: { rotation: [0, 0, 0, 1], translation: [0, 0, 0] }, trackingState: 'normal',
      });
    });
    await act(async () => { await sleep(50); });
    expect(g.__sw.calls).toContain('holdEnd');           // finalized: 30 strips ≥ 5
    expect(abandoned).toEqual([]);
    act(() => t.unmount());
  });

  it('⚑ M8 review: under panMode "both" the axis is unknown, so the pose guard stands down on a sweep', async () => {
    // It would measure a portrait sweep on the landscape axis: no guard when
    // level, a false stop part-way through a yaw sweep when tilted. The IMU
    // guard keeps the sweep instead, as through M0–M7.
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({ engine: 'sweep', defaultCaptureSource: 'ar', rectCrop: false }, ref));
    });
    await act(async () => { await sleep(400); });
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { g.__sw.props.onPaintedChange(30); });
    g.__ar.exceed = true;
    await act(async () => {
      g.__ar.props.onArFrame({
        pose: { rotation: [0, 0, 0, 1], translation: [0, 0, 0] }, trackingState: 'normal',
      });
    });
    await act(async () => { await sleep(50); });
    expect(g.__sw.calls).not.toContain('holdEnd');
    act(() => t.unmount());
  });

  it('⚑ NEGATIVE CONTROL: no drift, no stop', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({ engine: 'sweep', defaultCaptureSource: 'ar', rectCrop: false, panMode: 'horizontal' }, ref));
    });
    await act(async () => { await sleep(400); });
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { g.__sw.props.onPaintedChange(30); });
    await act(async () => {
      g.__ar.props.onArFrame({
        pose: { rotation: [0, 0, 0, 1], translation: [0, 0, 0] }, trackingState: 'normal',
      });
    });
    await act(async () => { await sleep(50); });
    expect(g.__sw.calls).not.toContain('holdEnd');
    act(() => t.unmount());
  });
});

describe('M8 review — the DR-1a hatch keeps its old, UNGATED shutter', () => {
  // The hatch renders pano+'s old screen, which has no rotate prompt and whose
  // own Start never had the pan-mode gate. Routing its hold through the one
  // dispatcher must not add one: a portrait-gated hold there would latch a
  // prompt that screen cannot show, and the operator would hold a dead button.
  const prompt = (t: ReactTestRenderer) =>
    t.root.findAllByType(RotateToLandscapePrompt).some((p: any) => p.props.visible === true);

  it('a hatch hold under a pan mode that gates this orientation starts at once', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'sweep', defaultCaptureSource: 'non-ar', rectCrop: false,
        panMode: 'vertical', sweep: { frameSourceOverride: 'own' },
      }, ref));
    });
    await act(async () => { await sleep(900); });
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { await sleep(50); });
    // Mutation-proven (2026-09-24): with the gate applied to the hatch in the
    // dispatcher AND in the resume effect, the hold latches and never starts
    // — and the old screen renders no prompt to say why.
    expect(g.__sw.calls).toContain('holdStart');
    expect(prompt(t)).toBe(false);
    act(() => t.unmount());
  });

  it('⚑ NEGATIVE CONTROL: the same hold on <Camera>\'s own camera IS gated', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'sweep', defaultCaptureSource: 'non-ar', rectCrop: false, panMode: 'vertical',
      }, ref));
    });
    await act(async () => { await sleep(400); });
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    expect(g.__sw.calls).not.toContain('holdStart');
    expect(prompt(t)).toBe(true);
    act(() => t.unmount());
  });
});

describe('M8 review — the host\'s sweep callbacks are composed, never replaced', () => {
  it('sweep.onPaintedChange hears every count <Camera> hears', async () => {
    const painted: number[] = [];
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'sweep', defaultCaptureSource: 'non-ar', rectCrop: false,
        sweep: { onPaintedChange: (n: number) => painted.push(n) },
      }, ref));
    });
    await act(async () => { await sleep(400); });
    await act(async () => { g.__sw.props.onPaintedChange(7); });
    await act(async () => { g.__sw.props.onPaintedChange(30); });
    expect(painted).toEqual([7, 30]);
    act(() => t.unmount());
  });
});

describe('D7 — takePhoto() in the SAME tick as startPanorama() is refused, on both engines', () => {
  // The sweep row is on AR: on the vision-camera kind a hold first waits for
  // the frame-processor plugin (cameraSweepHoldDefer), and a hold that is only
  // WAITING has not begun a capture.
  for (const [engine, src] of [['keyframe', 'non-ar'], ['sweep', 'ar']] as const) {
    it(`${engine} (${src}): the latch is raised before any state lands`, async () => {
      const errors: string[] = [];
      const ref = React.createRef<any>();
      let t!: ReactTestRenderer;
      await act(async () => {
        t = create(el({
          engine, defaultCaptureSource: src, rectCrop: false,
          onError: (e: { code: string }) => errors.push(e.code),
        }, ref));
      });
      await act(async () => { await sleep(400); });
      await act(async () => {
        ref.current.startPanorama();
        void ref.current.takePhoto();   // same tick: no render in between
        await Promise.resolve();
      });
      expect(errors).toContain('CAPTURE_IN_PROGRESS');
      act(() => t.unmount());
    });
  }

  it('⚑ NEGATIVE CONTROL: takePhoto() alone is not refused as busy', async () => {
    const errors: string[] = [];
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'keyframe', defaultCaptureSource: 'non-ar', rectCrop: false,
        onError: (e: { code: string }) => errors.push(e.code),
      }, ref));
    });
    await act(async () => { await sleep(400); });
    await act(async () => { void ref.current.takePhoto(); await Promise.resolve(); });
    expect(errors).not.toContain('CAPTURE_IN_PROGRESS');
    act(() => t.unmount());
  });
});

describe('M9 — ONE failure contract: a keyframe START failure reaches onCapture too', () => {
  it('onError AND onCapture({ ok: false, type: "panorama", engine: "keyframe" })', async () => {
    g.__kf.startFails = true;
    const ref = React.createRef<any>();
    const errs: Array<{ code: string }> = [];
    const seen: Array<Record<string, any>> = [];
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'keyframe', defaultCaptureSource: 'non-ar',
        onError: (e: { code: string }) => { errs.push(e); },
        onCapture: (r: Record<string, any>) => { seen.push(r); },
      }, ref));
    });
    await act(async () => { await sleep(400); });
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { await sleep(20); });
    expect(errs.map((e) => e.code)).toEqual(['PANORAMA_START_FAILED']);
    expect(seen.map((r) => [r.ok, r.type, r.engine, r.error?.code])).toEqual([
      [false, 'panorama', 'keyframe', 'PANORAMA_START_FAILED'],
    ]);
    act(() => t.unmount());
  });
});

/**
 * M9 review T7 — the two keyframe START refusals that returned before the
 * shared catch, and so reached `onError` ONLY: a host on the one-channel
 * contract (`onCapture({ ok: false })`) heard nothing, and one of them also
 * left the D7 capture latch raised behind it.
 */
describe('M9 review T7 — every keyframe start failure reaches BOTH channels', () => {
  async function mountKeyframe(errs: Array<{ code: string; message: string }>,
    seen: Array<Record<string, any>>) {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'keyframe', defaultCaptureSource: 'non-ar', rectCrop: false,
        onError: (e: { code: string; message: string }) => { errs.push(e); },
        onCapture: (r: Record<string, any>) => { seen.push(r); },
      }, ref));
    });
    await act(async () => { await sleep(400); });
    return { t, ref };
  }

  it('(a) the frame-processor plugin missing: both channels, and takePhoto() right after is NOT refused as busy', async () => {
    // Pins, in `startCapture`'s `fpDriver.acquisitionFailed` branch:
    //   · `onCapture({ ok: false, type: 'panorama', engine, … })` (MUTATION:
    //     delete it → onError only. Killed);
    //   · `captureBusyRef.current = false` (MUTATION: delete it → the
    //     dispatcher's D7 latch stays up — this refusal changes no state, so
    //     no render recomputes it — and the takePhoto() below is refused as
    //     "a panorama is recording". Killed).
    g.__fp.failed = true;
    const errs: Array<{ code: string; message: string }> = [];
    const seen: Array<Record<string, any>> = [];
    const { t, ref } = await mountKeyframe(errs, seen);
    await act(async () => {
      ref.current.startPanorama();
      // SAME TICK: no render in between that could recompute the latch and
      // hide a leaked one.
      void ref.current.takePhoto();
      await Promise.resolve();
    });
    await act(async () => { await sleep(20); });
    expect(g.__kf.calls).not.toContain('start');
    expect(errs.filter((e) => e.code === 'PANORAMA_START_FAILED')).toHaveLength(1);
    expect(errs.find((e) => e.code === 'PANORAMA_START_FAILED')!.message)
      .toContain('frame-processor');
    const panoramas = seen.filter((r) => r.type === 'panorama');
    expect(panoramas.map((r) => [r.ok, r.type, r.engine, r.error?.code])).toEqual([
      [false, 'panorama', 'keyframe', 'PANORAMA_START_FAILED'],
    ]);
    expect(panoramas[0].warnings).toEqual([]);
    expect(errs.map((e) => e.code)).not.toContain('CAPTURE_IN_PROGRESS');
    act(() => t.unmount());
  });

  it('⚑ NEGATIVE CONTROL (a): with the plugin present the same hold starts the engine', async () => {
    // Without it case (a) passes for a hold that never reached `startCapture`.
    const errs: Array<{ code: string; message: string }> = [];
    const seen: Array<Record<string, any>> = [];
    const { t, ref } = await mountKeyframe(errs, seen);
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    expect(g.__kf.calls).toContain('start');
    expect(errs.map((e) => e.code)).not.toContain('PANORAMA_START_FAILED');
    act(() => t.unmount());
  });

  it('(b) the native incremental module missing: onError AND onCapture({ ok: false, engine: "keyframe" })', async () => {
    // Pins the `!incrementalStitcherIsAvailable()` refusal in the dispatcher.
    // MUTATION: delete its `onCapture` → onError only. Killed.
    g.__kf.moduleMissing = true;
    const errs: Array<{ code: string; message: string }> = [];
    const seen: Array<Record<string, any>> = [];
    const { t, ref } = await mountKeyframe(errs, seen);
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { await sleep(20); });
    expect(g.__kf.calls).not.toContain('start');
    expect(errs.map((e) => e.code)).toEqual(['PANORAMA_START_FAILED']);
    expect(errs[0].message).toContain('not registered');
    expect(seen.map((r) => [r.ok, r.type, r.engine, r.error?.code])).toEqual([
      [false, 'panorama', 'keyframe', 'PANORAMA_START_FAILED'],
    ]);
    expect(seen[0].error).toBe(errs[0]);
    // …and it raised no latch: a photo right after is taken, not refused.
    await act(async () => { void ref.current.takePhoto(); await Promise.resolve(); });
    expect(errs.map((e) => e.code)).not.toContain('CAPTURE_IN_PROGRESS');
    act(() => t.unmount());
  });
});

describe('M10 — the DR-1a hatch has <Camera>\'s shutter (its own screen\'s is gone)', () => {
  // The old screen's shutter was pinned on press, release, tap, busy,
  // reachability and placement. M10 moved those cases onto the harness's
  // `holdStart`/`holdEnd` handle, which skips this shutter entirely, so each
  // is pinned again here, on the button a finger actually presses.
  const hatchShutter = (t: ReactTestRenderer) => t.root.findAll(
    (n: any) => n.props?.testID === 'camera-hatch-shutter',
  );
  /** What the hatch shutter paints: greyed out, and the busy ring. */
  const hatchState = (t: ReactTestRenderer) => {
    const p = hatchShutter(t)[0].findByType(CameraShutter).props as {
      disabled?: boolean; isProcessing?: boolean;
    };
    return { disabled: p.disabled === true, busy: p.isProcessing === true };
  };
  /** The REAL `Pressable` inside it — re-read on every use, because a press
   *  re-renders it with fresh handlers. */
  const hatchPressable = (t: ReactTestRenderer) => hatchShutter(t)[0]
    .findByType(CameraShutter)
    .findAll((n: any) => typeof n.props?.onPressIn === 'function')[0];
  /** A finger on the real button: down, `ms` later up. Past the shutter's
   *  250 ms threshold that is a hold and a release; under it, a tap. */
  async function press(t: ReactTestRenderer, ms: number): Promise<void> {
    await act(async () => { hatchPressable(t).props.onPressIn(); });
    await act(async () => { await sleep(ms); });
    await act(async () => { hatchPressable(t).props.onPressOut(); });
    await act(async () => { await sleep(20); });
  }
  // A case that fails mid-way never reaches its own unmount, and its stub
  // would keep overwriting `g.__sw.props` into the NEXT case — so every tree
  // mounted here is also unmounted here.
  const mounted: ReactTestRenderer[] = [];
  afterEach(() => {
    for (const m of mounted.splice(0)) {
      try { act(() => m.unmount()); } catch { /* already unmounted */ }
    }
  });
  async function mountHatch(props: Record<string, unknown> = {}) {
    const ref = React.createRef<any>();
    const errs: Array<{ code: string; message: string }> = [];
    const caps: Array<Record<string, any>> = [];
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'sweep', defaultCaptureSource: 'non-ar', rectCrop: false,
        showPreview: false, sweep: { frameSourceOverride: 'own' },
        onError: (e: { code: string; message: string }) => { errs.push(e); },
        onCapture: (r: Record<string, any>) => { caps.push(r); },
        ...props,
      }, ref));
    });
    mounted.push(t);
    await act(async () => { await sleep(900); });
    expect(hatchShutter(t).length).toBeGreaterThan(0);
    return { t, errs, caps };
  }

  it('a press on it runs the sweep, through the one dispatcher', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'sweep', defaultCaptureSource: 'non-ar', rectCrop: false,
        sweep: { frameSourceOverride: 'own' },
      }, ref));
    });
    await act(async () => { await sleep(900); });
    expect(hatchShutter(t).length).toBeGreaterThan(0);
    const shutter = hatchShutter(t)[0].findByType(CameraShutter);
    await act(async () => { (shutter.props as { onHoldStart: () => void }).onHoldStart(); });
    expect(g.__sw.calls).toContain('holdStart');
    act(() => t.unmount());
  });

  it('hold and RELEASE on the real button: the release finishes the sweep, and the shutter is busy while it does', async () => {
    // Pins the hatch `CameraShutter`'s `onHoldComplete={holdEndDispatch}` and
    // its `disabled` / `isProcessing` terms.
    // MUTATIONS: `onHoldComplete={noop}` and `onHoldComplete=
    // {holdStartDispatch}` → the engine hears `holdStart` only, and a real
    // sweep would record until the pan cap. `disabled={false}` and
    // `isProcessing={false}` → a finishing sweep leaves a live-looking
    // shutter. All killed.
    const { t } = await mountHatch();
    expect(hatchState(t)).toEqual({ disabled: false, busy: false });
    await press(t, 400);
    expect(g.__sw.calls).toEqual(['holdStart', 'holdEnd']);
    // The engine reported `busy` on the release (a finish in flight).
    expect(hatchState(t)).toEqual({ disabled: true, busy: true });
    act(() => t.unmount());
  });

  it('⚑ the shutter is busy while a finished sweep\'s OUTPUT is still being written', async () => {
    // The output-pending latch (M9 review): the engine is already idle — so
    // `sweepFinalizing` is down — while `<Camera>` copies the canvas to the
    // output directory. A hold in that window would start a sweep under the
    // review that is about to open.
    // MUTATIONS: drop `sweepOutputPending` from the hatch shutter's
    // `disabled` and `isProcessing` → both read false mid-copy; never lower
    // the latch → the shutter stays dead after the copy. Both killed.
    const fu = (NativeModules as any).RNImageStitcherFileUtils;
    const realCopy = fu.copyFile;
    const copy: { from: string | null; release: (() => void) | null } = {
      from: null, release: null,
    };
    // The FIRST copy waits for the test; any after it (the coverage sidecar)
    // lands at once.
    fu.copyFile = (from: string, to: string) => (copy.release == null
      ? new Promise<string>((r) => { copy.from = from; copy.release = () => r(to); })
      : Promise.resolve(to));
    try {
      const { t } = await mountHatch();
      const result = panoPlusResultOf(
        coercePanoPlusSummary({
          canvasPath: '/data/pp_1/canvas.jpg', sessionDir: '/data/pp_1',
          width: 4000, height: 1200, counts: { seen: 120, painted: 96 },
        }),
        { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'imu' },
        '2026-09-24T00:00:00.000Z',
      );
      const pending: { done: Promise<void> | void } = { done: undefined };
      await act(async () => {
        pending.done = (g.__sw.props.onComplete as (r: unknown) => Promise<void> | void)(result);
        await Promise.resolve();
      });
      // The canvas's copy to the output directory is the one in flight.
      expect(copy.from).toBe('/data/pp_1/canvas.jpg');
      expect(hatchState(t)).toEqual({ disabled: true, busy: true });
      await act(async () => { copy.release?.(); await pending.done; });
      // …and down again once the output is written.
      expect(hatchState(t)).toEqual({ disabled: false, busy: false });
      act(() => t.unmount());
    } finally {
      fu.copyFile = realCopy;
    }
  });

  it('a TAP is inert: nothing dispatched, no photo attempted, nothing reported', async () => {
    // The hatch's camera is pano+'s own; `<Camera>` has no photo path here.
    // MUTATIONS: `onTap={handleTap}` → a photo is attempted on a camera that
    // is not mounted and fails on `onError`; `onTap={holdStartDispatch}` →
    // a tap starts a sweep. Both killed.
    const { t, errs, caps } = await mountHatch();
    await press(t, 30);
    expect({ engine: g.__sw.calls, errs, caps }).toEqual({ engine: [], errs: [], caps: [] });
    act(() => t.unmount());
  });

  it('⚑ a finger can REACH it: no ancestor refuses touches', async () => {
    // Replaces 'the shutter is reachable on both arms' (deleted with the old
    // screen in M10): the hatch still has a shutter a finger must reach.
    // MUTATION: the dock's `pointerEvents="box-none"` → "none". Killed.
    const { t } = await mountHatch();
    const blocked: string[] = [];
    for (let n: any = hatchPressable(t).parent; n != null; n = n.parent) {
      const pe = n.props?.pointerEvents;
      if (pe === 'none' || pe === 'box-only') {
        blocked.push(`${String(n.props?.testID ?? n.type?.displayName ?? n.type)}: ${pe}`);
      }
    }
    expect(blocked).toEqual([]);
    act(() => t.unmount());
  });

  it('⚑ it sits at the bar\'s bottom inset plus bottomBarOffset, BELOW the lens chip', async () => {
    // Pins the dock's `bottom` and its relation to the chip's dock
    // (`panoLensChipBottomPt`, which counts the shutter when it is drawn).
    // MUTATIONS: the shutter dock's `bottom: 0` → the equality fails; the
    // chip dock computed as if the shutter were hidden → the chip lands ON
    // the shutter. Both killed.
    const sac = require('react-native-safe-area-context') as {
      __setInsets: (v: unknown) => void;
    };
    sac.__setInsets({ top: 0, left: 0, right: 0, bottom: 34 });
    try {
      const { t } = await mountHatch({ bottomBarOffset: 50 });
      const shutterBottom = StyleSheet.flatten(hatchShutter(t)[0].props.style).bottom;
      expect(shutterBottom).toBe(34 + PANO_BOTTOM_BAR_INSET + 50);
      // The chip's dock: the lens chip's nearest ancestor with a `bottom`.
      let dock: any = t.root.findAllByType(LensChip)[0].parent;
      while (dock != null && StyleSheet.flatten(dock.props?.style)?.bottom == null) {
        dock = dock.parent;
      }
      const chipBottom = StyleSheet.flatten(dock.props.style).bottom as number;
      // The shutter's own rendered height — a zero would make the check
      // below vacuous.
      const shutterHeight = StyleSheet.flatten(hatchPressable(t).props.style).height as number;
      expect(shutterHeight).toBeGreaterThan(0);
      expect(chipBottom - (shutterBottom as number)).toBeGreaterThanOrEqual(shutterHeight);
      act(() => t.unmount());
    } finally {
      sac.__setInsets(null);
    }
  });

  for (const resolving of [false, true]) {
    it(`⚑ panorama OFF: a hold is refused BY NAME — onError and onCapture({ ok: false }), no sweep${resolving ? ' — with the engine\'s arm still resolving too' : ''}`, async () => {
      // The main tree gates the hold on `enablePanoramaMode` (there a hold
      // would otherwise be a photo); the hatch has no photo, and the same gate
      // made its hold SILENT — no sweep, no photo, no report. The hold now
      // reaches the dispatcher, whose `!enablePanoramaMode` branch has the
      // engine refuse it with `SWEEP_PANORAMA_DISABLED`.
      // The engine answers that BEFORE its own readiness (M10 re-review,
      // round 3). The stub models that order, and the second run of this case
      // puts the stub where the real engine was when it said "still loading"
      // instead; `hatchSettleHold.render.test.tsx` pins the order on the real
      // hook. This file pins the dispatcher and the two channels.
      // MUTATIONS: restore `holdEnabled={enablePanoramaMode}` with
      // `onHoldStart={enablePanoramaMode ? holdStartDispatch : noop}` → nothing
      // reaches the engine and both channels stay empty. In `onSweepFailure`,
      // drop `onError`, drop `onCapture`, or hand `onCapture` a copy of the
      // error → the matching line below fails. All killed.
      g.__sw.notReady = resolving;
      const { t, errs, caps } = await mountHatch({ enablePanoramaMode: false });
      expect(g.__sw.props.hostArmRefusal).toEqual(SWEEP_PANORAMA_DISABLED);
      await press(t, 400);
      // Asked, refused; the release then ends nothing (no sweep is live).
      expect(g.__sw.calls).toEqual(['holdStart', 'holdEnd']);
      expect(errs.map((e) => [e.code, e.message])).toEqual([
        ['PANORAMA_START_FAILED', SWEEP_PANORAMA_DISABLED.message],
      ]);
      expect(caps.map((r) => [r.ok, r.type, r.engine, r.error?.code])).toEqual([
        [false, 'panorama', 'sweep', 'PANORAMA_START_FAILED'],
      ]);
      expect(caps[0].error).toBe(errs[0]);
      act(() => t.unmount());
    });
  }

  it('⚑ NEGATIVE CONTROL: hideBuiltInShutter hides it, as it hides the main tree\'s', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    await act(async () => {
      t = create(el({
        engine: 'sweep', defaultCaptureSource: 'non-ar', rectCrop: false,
        hideBuiltInShutter: true, sweep: { frameSourceOverride: 'own' },
      }, ref));
    });
    await act(async () => { await sleep(900); });
    expect(hatchShutter(t)).toHaveLength(0);
    act(() => t.unmount());
  });
});
