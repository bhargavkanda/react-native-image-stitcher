// SPDX-License-Identifier: Apache-2.0
/**
 * M8 review (14) — D15: ONE AR VIEW, ONE SESSION CONFIG, BOTH ENGINES.
 *
 * `<Camera>` feeds its `<ARCameraView>` three props that configure the AR
 * session itself:
 *
 *   keyframeQualityCapture            = keyframeQualityCapture ?? enablePanoramaMode
 *   keyframeQualitySourceMaxLongEdge  = arSourceMaxLongEdge
 *   arFrameMetaInterval               = enablePanoramaMode
 *                                         ? min(arFrameMetaInterval ?? 100, 100)
 *                                         : arFrameMetaInterval
 *
 * (100 is `SWEEP_AR_META_INTERVAL_MS`, which Camera.tsx does not export. The
 * value is read from its declaration, `const SWEEP_AR_META_INTERVAL_MS = 100`.)
 *
 * Any change to one of them pauses ARCore, re-selects its camera config and
 * resumes it (RNSARSession.kt). The Android AR tap photo IS the CPU image from
 * that config. So the three must NOT depend on `engine`: an engine switch that
 * changed them would reconfigure a live AR session under the operator, and a
 * tap photo would come off a different image stream on each engine. They are
 * also HELD (`useLatchedWhile(captureRecording, …)`) while a capture records,
 * so a host re-render mid-capture cannot reconfigure the session a capture is
 * reading.
 *
 * The TABLE crosses every host input (2 × 3 × 2 × 3 = 36 rows). For each row it
 * reads the props `<ARCameraView>` received on a fresh keyframe mount, after
 * that mount flips to the sweep, and on a fresh sweep mount. All three must be
 * equal, and equal to the row's EXPECTED values. Those are written out by
 * hand, not recomputed with the production formula.
 *
 * The LATCH cases start a capture on each engine, change the host props
 * mid-recording, and assert that no `<ARCameraView>` render saw the new
 * values until the capture had stopped, and that the next one did.
 *
 * ⚑ NEGATIVE CONTROL: the same host prop change with NO capture recording
 * reaches `<ARCameraView>` on the next render. The latch is what holds it, not
 * a stale stub.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const g = globalThis as any;
g.__d15 = {
  arRenders: [] as Array<Record<string, unknown>>,
  kf: { state: { acceptedCount: 0 }, calls: [] as string[] },
  sw: { calls: [] as string[], props: {} as any },
};

jest.mock('../../stitching/useIncrementalStitcher', () => {
  const obj: any = {
    isAvailable: true, isRunning: false, hint: null, confidenceLevel: null,
    keyframeThumbnails: [],
    start: async () => { (globalThis as any).__d15.kf.calls.push('start'); return { ok: true }; },
    finalize: async () => {
      (globalThis as any).__d15.kf.calls.push('finalize');
      return {
        panoramaPath: '/d/p.jpg', width: 400, height: 100,
        framesRequested: 3, framesIncluded: 3,
      };
    },
    cancel: () => { (globalThis as any).__d15.kf.calls.push('cancel'); return Promise.resolve(); },
  };
  return {
    useIncrementalStitcher: () => { obj.state = (globalThis as any).__d15.kf.state; return obj; },
  };
});
jest.mock('../../stitching/incremental', () => ({
  ...jest.requireActual('../../stitching/incremental'),
  incrementalStitcherIsAvailable: () => true,
  incrementalMissingMethods: () => null,
}));
// Records EVERY render's props, in order, so a latch can be checked over a
// window of renders and not only at its ends.
jest.mock('../ARCameraView', () => {
  const R = require('react');
  const ARCameraView = R.forwardRef((props: any, _ref: any) => {
    (globalThis as any).__d15.arRenders.push(props);
    return R.createElement('ARCameraViewStub', null);
  });
  return { __esModule: true, ARCameraView };
});
// The engine hook, stubbed as in mergeGuardRegressions: inert while not
// selected, and a hold that reports the sweep running, as the real one does.
jest.mock('../../sweep/useSweepEngine', () => {
  const R = require('react');
  function useSweepEngine(props: any, ref: any, options: { enabled?: boolean } = {}) {
    const enabled = options.enabled !== false;
    if (enabled) (globalThis as any).__d15.sw.props = props;
    const inert = () => undefined;
    R.useImperativeHandle(ref, () => (!enabled ? {
      capture: inert, finalize: inert, holdStart: inert, holdEnd: inert, abandon: inert,
    } : {
      capture: inert,
      finalize: inert,
      holdStart: () => {
        (globalThis as any).__d15.sw.calls.push('holdStart');
        props.onSweepingChange?.(true);
      },
      holdEnd: () => {
        (globalThis as any).__d15.sw.calls.push('holdEnd');
        props.onSweepingChange?.(false);
      },
      abandon: (reason: string) => {
        (globalThis as any).__d15.sw.calls.push(`abandon:${reason}`);
        props.onSweepingChange?.(false);
      },
    }), [props, enabled]);
    const wasEnabled = R.useRef(enabled);
    R.useEffect(() => {
      const was = wasEnabled.current;
      wasEnabled.current = enabled;
      if (was && !enabled) props.onSweepingChange?.(false);
    }, [enabled]);
    return { phase: 'idle', setSurfaceBox: () => undefined, handleArFrame: () => undefined };
  }
  return { __esModule: true, useSweepEngine };
});

// eslint-disable-next-line import/first
import { Camera } from '../Camera';

type Engine = 'keyframe' | 'sweep';
interface HostInputs {
  enablePanoramaMode: boolean;
  keyframeQualityCapture: boolean | undefined;
  arSourceMaxLongEdge: number | undefined;
  arFrameMetaInterval: number | undefined;
}
interface ArConfig {
  keyframeQualityCapture: unknown;
  keyframeQualitySourceMaxLongEdge: unknown;
  arFrameMetaInterval: unknown;
}

const d15 = g.__d15;

beforeEach(() => {
  jest.useFakeTimers();
  d15.arRenders = [];
  d15.kf.state = { acceptedCount: 0 };
  d15.kf.calls = [];
  d15.sw.calls = [];
  d15.sw.props = {};
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
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

const el = (engine: Engine, host: HostInputs, ref?: React.Ref<unknown>) => (
  <Camera
    ref={ref as never}
    engine={engine}
    defaultCaptureSource="ar"
    captureSources="both"
    panMode="both"
    rectCrop={false}
    outputDir="/tmp/out"
    enablePanoramaMode={host.enablePanoramaMode}
    keyframeQualityCapture={host.keyframeQualityCapture}
    arSourceMaxLongEdge={host.arSourceMaxLongEdge}
    arFrameMetaInterval={host.arFrameMetaInterval}
  />
);

const configOf = (p: Record<string, unknown>): ArConfig => ({
  keyframeQualityCapture: p.keyframeQualityCapture,
  keyframeQualitySourceMaxLongEdge: p.keyframeQualitySourceMaxLongEdge,
  arFrameMetaInterval: p.arFrameMetaInterval,
});
function lastArConfig(): ArConfig {
  const last = d15.arRenders[d15.arRenders.length - 1];
  if (last == null) throw new Error('<ARCameraView> never rendered');
  return configOf(last);
}

// ── The expected values, by hand ────────────────────────────────────────────
// keyframeQualityCapture: the host's value, else `enablePanoramaMode`.
const EXPECT_KQC: Record<string, Record<string, boolean>> = {
  pano: { undefined: true, true: true, false: false },
  photo: { undefined: false, true: true, false: false },
};
// arFrameMetaInterval: under panorama mode capped at 100 ms (and 100 when the
// host sets none); otherwise the host's value untouched.
const EXPECT_INTERVAL: Record<string, Record<string, number | undefined>> = {
  pano: { undefined: 100, 50: 50, 500: 100 },
  photo: { undefined: undefined, 50: 50, 500: 500 },
};

const ROWS: Array<{ host: HostInputs; expected: ArConfig }> = [];
for (const enablePanoramaMode of [true, false]) {
  for (const keyframeQualityCapture of [undefined, true, false]) {
    for (const arSourceMaxLongEdge of [undefined, 1280]) {
      for (const arFrameMetaInterval of [undefined, 50, 500]) {
        const mode = enablePanoramaMode ? 'pano' : 'photo';
        ROWS.push({
          host: { enablePanoramaMode, keyframeQualityCapture, arSourceMaxLongEdge, arFrameMetaInterval },
          expected: {
            keyframeQualityCapture: EXPECT_KQC[mode][String(keyframeQualityCapture)],
            keyframeQualitySourceMaxLongEdge: arSourceMaxLongEdge,
            arFrameMetaInterval: EXPECT_INTERVAL[mode][String(arFrameMetaInterval)],
          },
        });
      }
    }
  }
}

const fmt = (c: ArConfig) =>
  `kqc=${String(c.keyframeQualityCapture)} maxLE=${String(c.keyframeQualitySourceMaxLongEdge)} `
  + `meta=${String(c.arFrameMetaInterval)}`;
const label = (h: HostInputs) =>
  `pano=${h.enablePanoramaMode} kqc=${h.keyframeQualityCapture} `
  + `maxLE=${h.arSourceMaxLongEdge} meta=${h.arFrameMetaInterval}`;

describe('M8 review (14) — D15: <ARCameraView>\'s session config is the same on both engines', () => {
  it('the table has every combination (36 rows)', () => {
    expect(ROWS).toHaveLength(36);
    expect(new Set(ROWS.map((r) => label(r.host))).size).toBe(36);
  });

  for (const { host, expected } of ROWS) {
    it(`${label(host)} → ${fmt(expected)}`, async () => {
      // A fresh KEYFRAME mount…
      let t!: ReactTestRenderer;
      act(() => { t = create(el('keyframe', host)); });
      await settle();
      const keyframe = lastArConfig();
      // …flipped to the SWEEP on the same mount…
      const rendersBeforeFlip = d15.arRenders.length;
      act(() => { t.update(el('sweep', host)); });
      await settle();
      expect(d15.arRenders.length).toBeGreaterThan(rendersBeforeFlip);   // it re-rendered
      const flipped = lastArConfig();
      act(() => { t.unmount(); });
      // …and a fresh SWEEP mount.
      d15.arRenders = [];
      act(() => { t = create(el('sweep', host)); });
      await settle();
      const sweep = lastArConfig();
      act(() => { t.unmount(); });

      expect(keyframe).toStrictEqual(expected);
      expect(flipped).toStrictEqual(expected);
      expect(sweep).toStrictEqual(expected);
    });
  }
});

describe('M8 review (14) — D15: the config is HELD while a capture records', () => {
  const OLD: HostInputs = {
    enablePanoramaMode: true, keyframeQualityCapture: false,
    arSourceMaxLongEdge: 1280, arFrameMetaInterval: 50,
  };
  const NEW: HostInputs = {
    enablePanoramaMode: true, keyframeQualityCapture: true,
    arSourceMaxLongEdge: 1920, arFrameMetaInterval: 80,
  };
  const OLD_CONFIG: ArConfig = {
    keyframeQualityCapture: false, keyframeQualitySourceMaxLongEdge: 1280, arFrameMetaInterval: 50,
  };
  const NEW_CONFIG: ArConfig = {
    keyframeQualityCapture: true, keyframeQualitySourceMaxLongEdge: 1920, arFrameMetaInterval: 80,
  };

  it('keyframe: a mid-recording prop change is held until the capture stops', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    act(() => { t = create(el('keyframe', OLD, ref)); });
    await settle();
    expect(lastArConfig()).toStrictEqual(OLD_CONFIG);
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    await settle();
    expect(d15.kf.calls).toContain('start');
    d15.kf.state = { acceptedCount: 3 };

    const windowStart = d15.arRenders.length;
    act(() => { t.update(el('keyframe', NEW, ref)); });
    await settle();
    // The host re-render DID reach the AR view…
    expect(d15.arRenders.length).toBeGreaterThan(windowStart);
    // …and not one render during the recording carried the new config.
    for (const p of d15.arRenders.slice(windowStart)) expect(configOf(p)).toStrictEqual(OLD_CONFIG);

    await act(async () => { await ref.current.stopPanorama(); });
    await settle();
    await settle();
    expect(d15.kf.calls).toContain('finalize');
    // Stopped: the AR view (remounted after the stitch) has the new config.
    expect(lastArConfig()).toStrictEqual(NEW_CONFIG);
    act(() => { t.unmount(); });
  });

  it('sweep: a mid-sweep prop change is held until the sweep ends', async () => {
    const ref = React.createRef<any>();
    let t!: ReactTestRenderer;
    act(() => { t = create(el('sweep', OLD, ref)); });
    await settle();
    expect(lastArConfig()).toStrictEqual(OLD_CONFIG);
    await act(async () => {
      ref.current.startPanorama(); await Promise.resolve(); await Promise.resolve();
    });
    await settle();
    expect(d15.sw.calls).toContain('holdStart');

    const windowStart = d15.arRenders.length;
    act(() => { t.update(el('sweep', NEW, ref)); });
    await settle();
    expect(d15.arRenders.length).toBeGreaterThan(windowStart);
    for (const p of d15.arRenders.slice(windowStart)) expect(configOf(p)).toStrictEqual(OLD_CONFIG);

    // The sweep ends (the engine reports it, as the real one does on stop).
    await act(async () => { d15.sw.props.onSweepingChange(false); });
    await settle();
    expect(lastArConfig()).toStrictEqual(NEW_CONFIG);
    act(() => { t.unmount(); });
  });

  for (const engine of ['keyframe', 'sweep'] as const) {
    it(`⚑ NEGATIVE CONTROL, ${engine}: with nothing recording the change lands on the next render`, async () => {
      let t!: ReactTestRenderer;
      act(() => { t = create(el(engine, OLD)); });
      await settle();
      expect(lastArConfig()).toStrictEqual(OLD_CONFIG);
      act(() => { t.update(el(engine, NEW)); });
      expect(lastArConfig()).toStrictEqual(NEW_CONFIG);
      act(() => { t.unmount(); });
    });
  }
});
