// SPDX-License-Identifier: Apache-2.0
//
// THE SWEEP ENGINE — the WIRING, mounted for real.
//
// M10: this suite was `PanoPlusCaptureSurface.render.test.tsx`, and it drove
// the sweep's OWN screen — its shutter, its pills, its prompts. That screen is
// gone: a sweep runs inside `<Camera>`, on `<Camera>`'s shutter and chrome,
// and the engine (`useSweepEngine`) draws only its hold overlay. So this now
// mounts the real hook through `SweepEngineHarness` (the hatch view: the
// viewfinder / explainer / fallback `<ARCameraView>` and `SweepHoldOverlay`)
// and presses the shutter through the handle — `holdStart` / `holdEnd` — which
// is exactly how `<Camera>`'s shutter reaches the engine. The engine also
// reports `onControlsState`; `<Camera>` reads only its `busy` (the shutter's
// busy ring while a sweep finishes). `canCapture` paints nothing: a hold the
// engine cannot take is refused by name on `onFailure`.
//
// WHY THIS FILE EXISTS AT ALL, and why the pure suite is not enough. The
// 2026-07-22 field bugs (enforce-1D gating the box but not the shutter; the
// green pill reading the wrong number) both lived in the HUD layer, and the
// maths under both was tested and correct. What was untested was which number
// the pill reads and whether the button consults the lock. pano+ has exactly
// the same shape of risk: `panoPlusModel` is unit-tested to death, and none of
// that proves the engine FEEDS it the right thing, mounts the AR view, or
// stops the native session on the paths that must never leak it.
//
// This drives the real hook through react-test-renderer: mount it, let the
// AR-session swap grace elapse, hold the shutter, feed AR frames the way ARKit
// does (through the mounted `<ARCameraView>`'s `onArFrame` prop), read what
// the HUD actually renders, and release.
//
// Native is a fake `NativeModules.RNSSweepSession` whose call log the test
// asserts on — because the leak that matters most (a sweep that keeps running
// after the engine is gone) is invisible in the rendered tree and visible only
// as a missing `stop`.

// ⚠️ THIS FILE MUST LIVE IN A `__tests__/` DIRECTORY. The BUILD config
// (tsconfig.json) excludes `**/*.test.ts` and `**/__tests__/**` — note the
// FIRST pattern does not match `.tsx`. A `.render.test.tsx` sitting beside its
// component would therefore be compiled into `dist/`, and would fail the build
// on `react-test-renderer` (which ships no declarations; the ambient shim is
// itself inside a `__tests__/` dir and so is excluded from that program too).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NativeModules } from 'react-native';

// `expo-file-system/legacy` is a HOST dependency, not the SDK's — `loadVideoFileSystem`
// resolves it at call time inside a try/catch. Without this virtual mock it
// throws, `documentDirectory` is null, and the surface renders its (correct, but
// uninteresting) "no writable document directory" card instead of a camera.
//
// `written` is a module-level sink so the sidecars this surface writes are
// OBSERVABLE. Added 2026-09-03 with the sweep-HUD sidecar: the engine and
// drops readouts left the capture screen that day, and a test that only
// asserted their ABSENCE would pass just as well if they had been deleted
// outright. The pack is where they went, so the pack is what has to be
// asserted.
const written: Array<{ uri: string; body: string }> = [];
jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///var/mobile/Documents/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: (uri: string, body: string) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (globalThis as unknown as { __ppWritten: Array<unknown> }).__ppWritten
        .push({ uri, body });
      return Promise.resolve();
    },
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);
(globalThis as unknown as { __ppWritten: unknown[] }).__ppWritten = written;

import { SweepEngineHarness } from './sweepEngineHarness';
import type { SweepEngineProps } from '../sweepEngineProps';
import { panoBottomChromePt } from '../sweepLayout';
import { panoPlusUnavailableDetail } from '../panoPlusAndroidArm';
// The REAL `<ARCameraView>` — the hatch view imports it by module path and the
// render project stands nothing in for it. A test drives `onArFrame` off the
// mounted element's props, as `<Camera>`'s own suites do.
import { ARCameraView } from '../../camera/ARCameraView';
import {
  PANO_PLUS_PLUGIN_KEY,
  PANO_PLUS_STATUS_POLL_MS,
  PANO_PLUS_SWAP_GRACE_MS,
  panoPlusPreviewWindowMultiple,
} from '../panoPlusModel';
import type {
  PanoPlusCaptureResult,
  PanoPlusFailure,
  SweepSurfaceHandle as SurfaceControlHandle,
  SweepSurfaceState as SurfaceControlState,
} from '../panoPlusTypes';

// TEST-ONLY export of the render project's orientation seam (jest maps the
// bare package specifier to it); the real package's types do not carry it, so
// reach it through a require-cast. `__setOrientation` is what the engine's
// `useDeviceOrientation` reports (the render project forwards that hook to the
// seam).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stitcherMock = require('react-native-image-stitcher') as {
  __setOrientation: (o: string) => void;
};

const NM = NativeModules as Record<string, unknown>;

// The render project's `react-native` mock, reached the same way as the
// stitcher's: the real package's types carry no test hooks.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rnMock = require('react-native') as {
  __setWindowDimensions: (w: number, h: number) => void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const safeAreaMock = require('react-native-safe-area-context') as {
  __setInsets: (
    v: { top: number; left: number; right: number; bottom: number } | null,
  ) => void;
};

/** Every native call the surface made, in order — the leak detector. */
let calls: string[] = [];
/** What the fake `stop()` does. Swapped per-case. */
let stopImpl: () => Promise<unknown> = () => Promise.resolve({});
let startImpl: (o: Record<string, unknown>) => Promise<unknown> = () =>
  Promise.resolve({ sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true });
/** What the fake `getStatus()` (the POLL fallback) answers. Default is what
 *  the real bridge resolves when no session is live. */
let getStatusImpl: () => Promise<unknown> = () => Promise.resolve({ running: false });
/** The options bag the last `start()` received. */
let startedWith: Record<string, unknown> | null = null;

function installNative(): void {
  calls = [];
  startedWith = null;
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      calls.push('start');
      startedWith = o;
      return startImpl(o);
    },
    stop: () => {
      calls.push('stop');
      return stopImpl();
    },
    cancel: () => {
      calls.push('cancel');
      return Promise.resolve({ cancelled: true });
    },
    // NOT logged in `calls`: the poll fires on a timer, so logging it would
    // make every unrelated `expect(calls).toEqual([...])` depend on how far
    // the fake clock happened to be advanced.
    getStatus: () => getStatusImpl(),
  };
}

/** A healthy mid-sweep status dict, exactly as native emits it. */
function statusDict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    running: true,
    sessionDir: '/d/pp_1',
    seq: 42,
    framesSeen: 42,
    painted: 40,
    heldBacktrack: 0,
    heldFrontier: 0,
    skippedNoAdvance: 1,
    rejectedLowResponse: 1,
    rejectedOutOfCage: 0,
    rejectedPoseSpeed: 0,
    rejectedRectify: 0,
    gapExtended: 0,
    gapBreak: 0,
    paintedWidthPx: 1234,
    canvasWidthPx: 2048,
    advancePx: 9.9,
    stripPx: 12.4,
    outcome: 'painted',
    speed: 'ok',
    tracking: 2,
    stalled: false,
    axisLatched: true,
    axis: 0,
    sweepSign: 1,
    maxRectifyDeg: 3.5,
    previewPath: '/d/pp_1/preview.jpg',
    previewSeq: 7,
    previewW: 1400,
    previewH: 328,
    droppedQueue: 0,
    droppedPack: 0,
    engineMs: 1.2,
    abort: null,
    ...over,
  };
}

interface Rig {
  renderer: ReactTestRenderer;
  /** The engine's handle — what `<Camera>`'s shutter calls. */
  ref: React.RefObject<SurfaceControlHandle | null>;
  texts: () => string[];
  shows: (needle: string) => boolean;
  /** The shutter held past the threshold — `holdStart`, the sweep STARTS.
   *  There is no Start button, and since M10 no shutter of the engine's own:
   *  this is the handle `<Camera>`'s shutter calls. */
  hold: () => void;
  /** …and released — `holdEnd`, the sweep FINISHES, pack kept. */
  release: () => void;
  /** The engine's last `onControlsState` report. `<Camera>`'s shutter
   *  paints its `busy` only; `canCapture` is the engine's statement of
   *  whether a hold would be taken. */
  controls: () => SurfaceControlState | undefined;
  has: (testID: string) => boolean;
  frame: (status: Record<string, unknown> | null) => void;
  unmount: () => void;
}

function mount(props: Partial<SweepEngineProps> = {}): Rig {
  let renderer!: ReactTestRenderer;
  const ref = React.createRef<SurfaceControlHandle>();
  const states: SurfaceControlState[] = [];
  act(() => {
    renderer = TestRenderer.create(
      <SweepEngineHarness
        ref={ref}
        onComplete={props.onComplete ?? (() => undefined)}
        onCancel={props.onCancel ?? (() => undefined)}
        onFailure={props.onFailure}
        onControlsState={(st) => { states.push(st); }}
        rectify={props.rectify}
        gainMatch={props.gainMatch}
        packFrames={props.packFrames}
        engineOptions={props.engineOptions}
        packOptions={props.packOptions}
        poseSource={props.poseSource}
      />,
    );
  });
  // Let the AR-session swap grace elapse so <ARCameraView> mounts.
  act(() => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
  });

  const collect = (): string[] => {
    const out: string[] = [];
    const walk = (n: ReactTestInstance | string | null): void => {
      if (n == null) return;
      if (typeof n === 'string') {
        out.push(n);
        return;
      }
      for (const c of n.children ?? []) walk(c as ReactTestInstance | string);
    };
    walk(renderer.root as unknown as ReactTestInstance);
    return out;
  };

  return {
    renderer,
    ref,
    texts: collect,
    shows: (needle) => collect().some((t) => t.includes(needle)),
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    hold: () => { act(() => { ref.current!.holdStart!(); }); },
    release: () => { act(() => { ref.current!.holdEnd!(); }); },
    controls: () => states[states.length - 1],
    frame: (status) => {
      const view = renderer.root.findAllByType(ARCameraView)[0];
      const onArFrame = view?.props.onArFrame as
        | ((m: unknown) => void)
        | undefined;
      if (onArFrame == null) throw new Error('ARCameraView never mounted');
      act(() => {
        onArFrame(
          status == null
            ? { plugins: {} }
            : { plugins: { [PANO_PLUS_PLUGIN_KEY]: status } },
        );
      });
    },
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

/** Flush the microtask queue so a native promise's `.then` has run. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  stitcherMock.__setOrientation('landscape-left');
  stopImpl = () => Promise.resolve({});
  startImpl = () =>
    Promise.resolve({ sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true });
  getStatusImpl = () => Promise.resolve({ running: false });
  // The REAL window on this host: portrait-locked, so RN reports portrait dims
  // however the phone is held. `__setOrientation('landscape-left')` above is
  // the physical hold, and the two together are the operator's actual state.
  rnMock.__setWindowDimensions(390, 844);
  // No provider by default — the surface must survive a host without one.
  safeAreaMock.__setInsets(null);
  installNative();
});

afterEach(() => {
  jest.useRealTimers();
  delete NM.RNSSweepSession;
});

describe('mount + the AR-session swap grace', () => {
  it('holds <ARCameraView> down for one grace, then mounts it', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SweepEngineHarness onComplete={() => undefined} onCancel={() => undefined} />,
      );
    });
    // There is ONE ARKit session: mounting before the outgoing surface's
    // unmount has called RNSARSession.stop() races two arSession.run calls.
    expect(renderer.root.findAllByType(ARCameraView).length).toBe(0);

    act(() => {
      jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
    });
    expect(renderer.root.findAllByType(ARCameraView).length).toBe(1);
    act(() => {
      renderer.unmount();
    });
  });

  // ⚠ THE UNAVAILABLE CARD (testID panoplus-unavailable) — deleted in M10
  // with the screen that drew it. What it pinned still exists in another
  // form: a hold on a build without the module is REFUSED BY NAME through
  // `onFailure`, and the engine reports it cannot take one (`<Camera>`'s
  // shutter does not grey on that report; the refusal is the contract).
  it('refuses a hold BY NAME — not a crash, not silence — with no native module', async () => {
    const { Platform } = require('react-native') as { Platform: { OS: string } };
    const seen: Record<string, string> = {};
    try {
      for (const os of ['ios', 'android'] as const) {
        Platform.OS = os;
        delete NM.RNSSweepSession;
        const failures: PanoPlusFailure[] = [];
        const r = mount({ onFailure: (f) => { failures.push(f); } });
        await settle();
        // The engine's report: not a capture it can take.
        expect(r.controls()).toEqual({ canCapture: false, canFinalize: false, busy: false });
        r.hold();
        await settle();
        expect(failures.map((f) => f.code)).toEqual(['panoplus-unavailable']);
        // The refusal must NAME the cause, per platform; "unavailable" alone
        // turns a five-minute config fix into a field trip.
        expect(failures[0]!.message).toBe(panoPlusUnavailableDetail(os));
        expect(failures[0]!.message)
          .toContain('RNSSweepSession native module is not registered');
        expect(failures[0]!.sessionDir).toBeNull();
        seen[os] = failures[0]!.message;
        // …and a release after the refusal ends nothing.
        r.release();
        await settle();
        r.unmount();
        expect(calls).toEqual([]);
      }
    } finally {
      Platform.OS = 'ios';
    }
    // Two platforms, two sentences: the Android one names the Gradle module,
    // the iOS one the pod.
    expect(seen.ios).not.toBe(seen.android);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PRE-SWEEP COACHING PARAGRAPH IS OFF THE SCREEN (2026-09-07)
//
// The operator: "Why is the text on the screen needed - regarding the panning?
// pano works the same way already right?" It does — Pano ships no coaching —
// and unlike the engine/drops lines this paragraph was never evidence: the HUD
// sidecar records the guidance line at STOP, which is a sweeping line. So this
// is a DELETION on the screen and in the model, and the tests below are the
// ones that were green on the coaching and are now red on it.
// ═══════════════════════════════════════════════════════════════════════════
describe('the idle screen coaches NOTHING — the overlays stay, the prose goes', () => {
  /** Every string that left the pano+ capture screen on 2026-09-07. */
  const STRIPPED = [
    'Hold portrait — sweep left to right',
    'Hold landscape — sweep top to bottom',
    '0.5–0.8 m',
    'Either hold works',
    'ONE direction',
    '⚗︎ τ=0 UNCORRECTED — EXPERIMENT, NOT A CALIBRATED RUN',
    'IMU ARM — EXPERIMENT: τ = 0, NO TIMING CORRECTION',
  ];

  it('renders NONE of the stripped strings, in ANY phase', async () => {
    for (const o of ['portrait', 'landscape-left'] as const) {
      stitcherMock.__setOrientation(o);
      const r = mount();
      await settle();
      const none = (): void => {
        for (const bad of STRIPPED) expect(r.shows(bad)).toBe(false);
      };
      none();                       // idle
      r.hold();                     // → starting/sweeping
      await settle();
      r.frame(statusDict());
      none();                       // sweeping
      r.release();                  // → finishing
      none();
      await settle();
      r.unmount();
    }
  });

  it('the guidance headline is EMPTY at idle, so no line is drawn', () => {
    stitcherMock.__setOrientation('portrait');
    const p = mount();
    expect(p.has('panoplus-guidance')).toBe(false);
    expect(p.has('panoplus-guidance-detail')).toBe(false);
    p.unmount();
  });
});

// ⚠ THE OLD SCREEN'S ROTATE PROMPT AND PAN HOW-TO COACH MARK (testIDs
// rotate-prompt, pan-howto; the upside-down "turn the right way up" prompt) —
// deleted in M10 with the screen that drew them.
describe('the engine takes EITHER hold', () => {
  // The engine never asked for landscape: `axisOverride` is 0 on all three
  // 2026-08-29 field packs and the axis latch votes on measured translation,
  // so a portrait left-to-right sweep is the SAME engine case as a landscape
  // top-to-bottom one — and no hold is reported uncapturable.
  it('reports capturable and idle in every hold', async () => {
    for (const o of [
      'portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right',
    ]) {
      stitcherMock.__setOrientation(o);
      const r = mount();
      await settle();
      expect({ o, controls: r.controls() }).toEqual({
        o, controls: { canCapture: true, canFinalize: false, busy: false },
      });
      r.unmount();
    }
  });
});

describe('the cross-axis ceiling reaches the screen', () => {
  // The one real risk portrait capture carries. All three field packs report
  // `clipping.canvasH` 1216 against a 2048 cap and ZERO growths — the ceiling
  // has never been exercised, because a landscape hold puts the cross axis on
  // the world horizontal. Portrait puts it on the world vertical.
  it('warns BEFORE truncating, and stops AT the ceiling', async () => {
    stitcherMock.__setOrientation('portrait');
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ canvasHeightPx: 1216 }));
    expect(r.shows('Running out of room')).toBe(false);

    r.frame(statusDict({ canvasHeightPx: 1848 }));
    expect(r.shows('Running out of room up or down')).toBe(true);
    // ...and the DETAIL is still on screen, because this is a `warn` and the
    // detail is what the operator can act on: "Recentre the shelf and keep
    // the phone level". The detail is scoped by TONE, not by phase — see the
    // HUD block in `SweepHoldOverlay`.
    expect(r.shows('Recentre the shelf')).toBe(true);
    // The ENGINE READOUT's `cross 1848/2048` is idle-only since 2026-09-03 (a
    // second copy of the same fact, in the dense line the operator asked off
    // the screen). It reaches the pack in the sweep-HUD sidecar.
    expect(r.shows('cross 1848/2048')).toBe(false);

    r.frame(statusDict({ canvasHeightPx: 2048 }));
    expect(r.shows('Canvas is at its cross-axis ceiling')).toBe(true);
    expect(r.shows('CROSS FULL 2048/2048')).toBe(false);
    r.unmount();
  });

  it('follows a host that raised the engine cap rather than a hardcoded 2048', async () => {
    stitcherMock.__setOrientation('portrait');
    const r = mount({ engineOptions: { canvasMaxHeightPx: 3072 } });
    r.hold();
    await settle();
    r.frame(statusDict({ canvasHeightPx: 2048 }));
    expect(r.shows('Canvas is at its cross-axis ceiling')).toBe(false);
    r.unmount();
  });

  it('follows the AREA budget too, which bites first on a long sweep', async () => {
    // `canvasMaxHeightPx` is not the only bound and on the portrait aisle walk
    // it is not the first: `ensureCanvasBand` checks `areaWithinBudget` after
    // the height cap, so an 12 000 px-wide canvas is refused at 1500 rows.
    stitcherMock.__setOrientation('portrait');
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ canvasHeightPx: 1450, canvasWidthPx: 12000 }));
    expect(r.shows('Canvas is at its cross-axis ceiling')).toBe(true);
    expect(r.shows('memory budget allows at this width')).toBe(true);
    r.unmount();
  });

  it('warns immediately when the host froze vertical growth', async () => {
    stitcherMock.__setOrientation('portrait');
    const r = mount({ engineOptions: { canvasGrowVertical: false } });
    r.hold();
    await settle();
    r.frame(statusDict({ canvasHeightPx: 1216 }));
    expect(r.shows('Canvas is at its cross-axis ceiling')).toBe(true);
    expect(r.shows('vertical growth is turned off')).toBe(true);
    r.unmount();
  });

  // The rung order, on the real surface: a speculative ceiling warning must
  // never take the headline away from a hole that already exists.
  it('lets a REALISED hole keep the headline, and still says the ceiling', async () => {
    stitcherMock.__setOrientation('portrait');
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ canvasHeightPx: 2048, gapBreak: 5 }));
    expect(r.shows('Break in the panorama')).toBe(true);
    expect(r.shows('Canvas is at its cross-axis ceiling')).toBe(false);
    expect(r.shows('Also: the canvas is at 2048/2048 px across')).toBe(true);
    r.unmount();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE HOLD IS RECORDED INTO THE PACK — the last inference in the chain.
// ════════════════════════════════════════════════════════════════════════════
//
// The three field packs carry `axis`, `sweepSign` and `axisOverride` but say
// NOTHING about how the phone was held, so establishing that they were
// landscape-left meant deriving it from `referenceQuat`. Sound, and still a
// derivation — and portrait is exactly the case the rotation chain has never
// been checked against. Native stores this string and writes it to meta.json;
// nothing reads it back, so it cannot change what the engine does.

describe('the physical hold reaches the pack', () => {
  it('sends the MEASURED hold at start, in every orientation', async () => {
    for (const [orientation, hold] of [
      ['portrait', 'portrait'],
      ['portrait-upside-down', 'portrait-upside-down'],
      ['landscape-left', 'landscape'],
      ['landscape-right', 'landscape'],
    ] as const) {
      stitcherMock.__setOrientation(orientation);
      const r = mount();
      r.hold();
      await settle();
      expect(startedWith).toMatchObject({ hold });
      r.unmount();
    }
  });

  it('is a FACT, so a host cannot override it with its own packOptions', async () => {
    stitcherMock.__setOrientation('portrait');
    // `hold` is applied AFTER the spread of engineOptions/packOptions.
    const r = mount({ packOptions: { hold: 'landscape' } as never });
    r.hold();
    await settle();
    expect(startedWith).toMatchObject({ hold: 'portrait' });
    r.unmount();
  });

  // v14 — and the SECOND thing the hold decides, which unlike `hold` itself
  // DOES reach a transform: the upright bake native puts into `canvas.jpg`.
  // Operator, 2026-09-02: "the output image is sideways" — his portrait sweep
  // that day came out a quarter turn over because nothing sent this.
  it('sends the UPRIGHT BAKE, and it separates the two landscape holds', async () => {
    for (const [orientation, outputRotationCwDeg] of [
      ['portrait', 90],
      ['landscape-left', 0],
      ['landscape-right', 180],
      ['portrait-upside-down', 270],
    ] as const) {
      stitcherMock.__setOrientation(orientation);
      const r = mount();
      r.hold();
      await settle();
      // `hold` collapses the two landscape holds into one name; the bake must
      // NOT, or one of them ships upside down.
      expect(startedWith).toMatchObject({ outputRotationCwDeg });
      r.unmount();
    }
  });

  it('is a FACT too — a host cannot send its own bake', async () => {
    stitcherMock.__setOrientation('portrait');
    const r = mount({
      packOptions: { outputRotationCwDeg: 270 } as never,
    });
    r.hold();
    await settle();
    expect(startedWith).toMatchObject({ outputRotationCwDeg: 90 });
    r.unmount();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE ELBOW FIX REACHES NATIVE — four engine knobs, by their C++ names.
// ════════════════════════════════════════════════════════════════════════════
//
// The bend in the 09-05 packs is a HINGE where the flat seed/tail blocks meet
// the tilted pose-chain strips. The fix is four `rnis::pano::Config` fields
// (`crossTraj`, `crossTrajRelaxPx`, `leadOutFromFrontier`, `leadOutTraj`), and
// the whole point of wiring them is that the operator flips them on the phone
// without a rebuild. iOS reads them off the flat start dictionary by these
// exact names and Android's `engineKnobKeys` filter forwards the same names as
// `configOverrides` — so a key that leaves this surface under a different
// spelling is a knob that silently did not apply. Pinned here, by name.

describe('the elbow-fix knobs reach the native start bag', () => {
  it('carries all four, verbatim, under their C++ field names', async () => {
    stitcherMock.__setOrientation('landscape-left');
    const r = mount({
      engineOptions: {
        crossTraj: 2,
        crossTrajRelaxPx: 100,
        leadOutFromFrontier: true,
        leadOutTraj: false,
      },
    });
    r.hold();
    await settle();
    expect(startedWith).toMatchObject({
      crossTraj: 2,
      crossTrajRelaxPx: 100,
      leadOutFromFrontier: true,
      leadOutTraj: false,
    });
    r.unmount();
  });

  it("sends the 'off' arm as explicit zeros, not as absence — the pack must SAY off", async () => {
    // `startPanoPlus` strips only `undefined`; a host that chose `off` sends
    // 0 / 0 / false, and native's `numOr`/`boolOr` read them as set. A pack
    // recorded at the shipped default and a pack recorded at an explicit off
    // are the same pixels, but only one of them is a stated A/B arm.
    stitcherMock.__setOrientation('landscape-left');
    const r = mount({
      engineOptions: {
        crossTraj: 0,
        crossTrajRelaxPx: 0,
        leadOutFromFrontier: false,
        leadOutTraj: true,
      },
    });
    r.hold();
    await settle();
    expect(startedWith).toMatchObject({
      crossTraj: 0,
      crossTrajRelaxPx: 0,
      leadOutFromFrontier: false,
      leadOutTraj: true,
    });
    r.unmount();
  });
});

describe('start → sweep → done, the whole wire', () => {
  it('sends the ARMS it was given and latches them onto the result', async () => {
    const done: PanoPlusCaptureResult[] = [];
    stopImpl = () =>
      Promise.resolve({
        sessionDir: '/d/pp_1',
        canvasPath: '/d/pp_1/canvas.jpg',
        width: 5000,
        height: 600,
        counts: { seen: 300, painted: 290 },
        unpaintedRuns: [],
        unpaintedColumns: 0,
      });
    const r = mount({
      rectify: false,
      gainMatch: true,
      packFrames: 'painted',
      onComplete: (x) => done.push(x),
    });

    r.hold();
    await settle();
    expect(calls).toEqual(['start']);
    // The three arms must reach native EXACTLY as the host set them — this is
    // the A/B the whole feature exists to make possible, and a surface that
    // dropped `rectify: false` would silently run the hypothesis arm and label
    // the pack "control".
    expect(startedWith).toMatchObject({
      rectify: false,
      gainMatch: true,
      packFrames: 'painted',
      sessionDir: expect.stringMatching(/^\/var\/mobile\/Documents\/panoplus\/pp_\d+$/),
    });
    // …and as a PLAIN PATH. `createDirectoryAtPath:` would make a literal
    // `file:` directory out of a URI and report success.
    expect(String(startedWith!.sessionDir).startsWith('file://')).toBe(false);

    r.frame(statusDict());
    // ⚠ The engine readout (`40/42 painted · 1234px · …`) is IDLE-ONLY since
    // 2026-09-03 — see the drops test below, which pins both where it went
    // from and where it went to. What stays over a live pan is the one
    // governor line.
    expect(r.shows('40/42 painted')).toBe(false);
    // The governor NAMES the direction the engine latched, as a FRAMEBUFFER
    // glyph (2026-09-03 — the chrome no longer turns, so neither does the
    // arrow's frame): axis 0 / sign +1 is the sensor's +X, and the constant
    // sensor→framebuffer quarter turn puts it on framebuffer +Y, `↓`. Held
    // landscape-left the framebuffer's +Y is the world's RIGHT, which is where
    // the sweep is going.
    expect(r.shows('Panning ↓ — keep it steady')).toBe(true);
    // The growing panorama, cache-busted on the preview sequence.
    const img = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    expect((img!.props.source as { uri: string }).uri).toBe(
      'file:///d/pp_1/preview.jpg?v=7',
    );

    r.release();
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    expect(done).toHaveLength(1);
    expect(done[0]!.kind).toBe('panoplus');
    expect(done[0]!.width).toBe(5000);
    // Latched at START — a host pill flipped mid-sweep must not be able to
    // relabel the pack.
    //
    // `poseSource` joined this bag on 2026-08-31 and is asserted EXACTLY here
    // rather than loosened to `objectContaining`: the arm a sweep ran on is the
    // one property of a pano+ pack that leaves no trace in the pixels, so a
    // future field appearing (or this one going missing) must fail the suite
    // rather than pass it quietly. This mount passes no `poseSource`, so it is
    // the default — which is also what the fake bridge answers.
    expect(done[0]!.arms).toEqual({
      rectify: false, gainMatch: true, packFrames: 'painted', poseSource: 'ar',
    });
    r.unmount();
    // Already finalized: the unmount must NOT issue a second stop (which would
    // reject not-running, cancel, and delete the pack it just wrote).
    expect(calls).toEqual(['start', 'stop']);
  });

  it('keeps the last status on a frame that carried nothing', async () => {
    const r = mount();
    r.hold();
    await settle();
    // Read through the governor line, which is what a live sweep still shows.
    r.frame(statusDict());
    expect(r.shows('Panning ↓ — keep it steady')).toBe(true);
    // The plugin returns nil while registered-but-idle and onArFrame ticks
    // independently of the frame rate; blanking here would make a healthy sweep
    // flicker between "panning" and "waiting for frames".
    r.frame(null);
    expect(r.shows('Panning ↓ — keep it steady')).toBe(true);
    r.unmount();
  });

  it('shows the governor, in precedence order, off the live status', async () => {
    const r = mount();
    r.hold();
    await settle();

    r.frame(statusDict({ speed: 'fast' }));
    expect(r.shows('Too fast — slow down')).toBe(true);

    r.frame(statusDict({ stalled: true, speed: 'fast' }));
    // A stall must say SLOW DOWN, not the opposite — and must not be masked by
    // the speed line it outranks.
    expect(r.shows('Lost the chain — slow down and re-approach')).toBe(true);

    r.frame(statusDict({ outcome: 'held-backtrack' }));
    expect(r.shows('Going backwards — nothing lost')).toBe(true);
    r.unmount();
  });

  it('keeps the ring live after an engine abort, and the release keeps what was painted', async () => {
    // Pano's shutter has no "Finish (stopped)" — the ring stays red until the
    // finger lifts, the HUD says the engine stopped, and the release
    // finalizes exactly as it would a healthy sweep. No auto-finalize: that
    // would be a `maxHoldMs` timer, which Pano does not pass either.
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ abort: 'session-restart', running: false }));
    expect(r.shows('Sweep stopped — session-restart')).toBe(true);
    expect(r.shows('Finish (stopped)')).toBe(false);
    expect(r.shows('Discard')).toBe(false);
    // The engine still reports capturable and NOT busy — the finger is down
    // on a red ring, and `busy` would paint `<Camera>`'s grey one, which
    // refuses the release's twin.
    expect(r.controls()).toEqual({ canCapture: true, canFinalize: false, busy: false });
    r.release();
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    r.unmount();
  });

  // A DROP IS DATA, AND SILENCE ABOUT IT IS THE FAILURE — the original claim,
  // unchanged. What changed on 2026-09-03 is WHERE it is said: not over the
  // operator's live pan, where it is four words he cannot act on and part of
  // the prose he asked to have removed, but in the pack, where the RCA that
  // needs it will actually look. So this asserts both halves — off the screen
  // during the sweep, and in the sidecar afterwards. Asserting only the first
  // would pass equally well if the line had simply been deleted.
  it('moves drops off the live screen and INTO the pack — never silence', async () => {
    written.length = 0;
    // A stop that reports its session dir — the sidecar is addressed off
    // `summary.sessionDir`, which is the directory NATIVE actually used.
    stopImpl = () =>
      Promise.resolve({
        sessionDir: '/d/pp_1',
        canvasPath: '/d/pp_1/canvas.jpg',
        width: 5000, height: 600,
        counts: { seen: 300, painted: 290 },
        unpaintedRuns: [],
      });
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ droppedQueue: 4, droppedPack: 2 }));
    expect(r.shows('4 frame(s) dropped')).toBe(false);
    expect(r.shows('2 pack write(s) dropped')).toBe(false);

    r.release();
    await settle();
    const hudFile = written.find((w) => w.uri.endsWith('host_sweep_hud.json'));
    expect(hudFile).toBeDefined();
    const body = JSON.parse(hudFile!.body) as Record<string, unknown>;
    expect(body.schema).toBe('panoplus-host-sweep-hud/1');
    expect(body.drops).toContain('4 frame(s) dropped');
    expect(body.drops).toContain('2 pack write(s) dropped');
    // ...and the engine readout with it, whole.
    expect(body.hud).toContain('40/42 painted');
    expect(body.guidanceHeadline).toContain('Panning');
    r.unmount();
  });
});

describe('failure paths keep the pack and clear the native latch', () => {
  it('surfaces panoplus-empty with the pack location, and does NOT cancel it', async () => {
    const failures: PanoPlusFailure[] = [];
    stopImpl = () =>
      Promise.reject(
        Object.assign(new Error('The sweep produced no panorama (chain-lost).'), {
          code: 'panoplus-empty',
          userInfo: { sessionDir: '/d/pp_9', abort: 'chain-lost', counts: { seen: 90 } },
        }),
      );
    const r = mount({ onFailure: (f) => failures.push(f) });
    r.hold();
    await settle();
    r.release();
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]!.sessionDir).toBe('/d/pp_9');
    // NO cancel: finalize already tore the session down and WROTE the pack.
    // Cancelling here would delete the one artifact that explains the failure.
    expect(calls).toEqual(['start', 'stop']);
    expect(r.shows('worth keeping')).toBe(true);
    r.unmount();
  });

  it('cancels after a not-running stop — the ONE path that latches the session', async () => {
    stopImpl = () =>
      Promise.reject(
        Object.assign(new Error('No pano+ sweep is running.'), {
          code: 'panoplus-not-running',
        }),
      );
    const r = mount();
    r.hold();
    await settle();
    r.release();
    await settle();
    // Without the cancel, gSession stays set and EVERY later start rejects
    // `panoplus-busy` for the life of the process.
    expect(calls).toEqual(['start', 'stop', 'cancel']);
    r.unmount();
  });

  it('a start failure returns to idle and says why, without a phantom session', async () => {
    startImpl = () =>
      Promise.reject(
        Object.assign(new Error('nope'), { code: 'panoplus-busy' }),
      );
    const r = mount();
    r.hold();
    await settle();
    expect(r.shows('A pano+ sweep is already running')).toBe(true);
    // Back to idle: capturable, not busy.
    expect(r.controls()).toEqual({ canCapture: true, canFinalize: false, busy: false });
    r.unmount();
    expect(calls).toEqual(['start']); // nothing to stop
  });
});

describe('the session must never outlive the surface', () => {
  it('stops (never cancels) a sweep abandoned by an unmount', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict());
    r.unmount();
    await settle();
    // STOP, not cancel: an abandoned sweep's pack is still evidence, and
    // deleting it is the one irreversible thing this surface could do by
    // accident. The native session is torn down either way.
    expect(calls).toEqual(['start', 'stop']);
  });

  it('has NO discard, and a tap is inert — Pano\'s gesture vocabulary, exactly', async () => {
    // Pano has no mid-hold discard (release ALWAYS finalizes) and pano+ has
    // no photo, so a TAP (`capture`) does nothing and `onCancel` is never
    // reached by a gesture. (The Discard/Close/Done buttons this case also
    // checked the absence of went with the screen that drew them — deleted
    // in M10.)
    let cancelled = 0;
    const r = mount({ onCancel: () => (cancelled += 1) });
    act(() => { r.ref.current!.capture(); });
    await settle();
    expect(calls).toEqual([]);
    r.hold();
    await settle();
    act(() => { r.ref.current!.capture(); });
    await settle();
    expect(calls).toEqual(['start']);
    expect(cancelled).toBe(0);
    r.unmount();
    // Abandoned by the unmount: stop, never cancel.
    expect(calls).toEqual(['start', 'stop']);
  });

  it('finishes at once when the release lands while native is still starting', async () => {
    // Pano's `statusPhase` is `recording` before its native start is awaited,
    // so a release in that window finalizes. pano+'s start is a bridge
    // round-trip; the release is latched and the sweep finished the moment
    // the start resolves — a near-empty pack, reported like any other.
    let deferredStart!: (v: unknown) => void;
    startImpl = () => new Promise((resolve) => { deferredStart = resolve; });
    const r = mount();
    r.hold();
    expect(calls).toEqual(['start']);
    r.release();                       // still `starting`: nothing to stop yet
    expect(calls).toEqual(['start']);
    act(() => {
      deferredStart({ sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true });
    });
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    r.unmount();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('ends nothing on a release after a start FAILURE', async () => {
    // Pano's `handleHoldEnd` early-returns when nothing is recording; a
    // `stop()` here would reject `not-running` and CANCEL — deleting nothing
    // today, but latching the next start behind a phantom cancel.
    startImpl = () =>
      Promise.reject(Object.assign(new Error('busy'), { code: 'panoplus-busy' }));
    const r = mount();
    r.hold();
    await settle();
    expect(r.has('panoplus-error')).toBe(true);
    r.release();
    await settle();
    expect(calls).toEqual(['start']);
    r.unmount();
    expect(calls).toEqual(['start']);
  });
});

// ── `<Camera>`'S CONFIGURATION: ITS SHUTTER, DRIVEN THROUGH THE REF ────────
//
// Every case in this file drives the engine through its handle now (M10: the
// engine has no shutter of its own). These cases mount it the way `<Camera>`
// configures it — `hideBuiltInControls` and a `bottomBarOffset`, both layout
// inputs only — and pin the handle contract itself: that the ref exposes the
// hold pair and `abandon`, reads the LIVE phase rather than a stale closure,
// and what the controls report says (`<Camera>` reads its `busy` only).
describe('<Camera> drives the sweep through the ref', () => {
  // The SHELL's types, not a local restatement: the point is that the shell's
  // contract is what the engine honours.
  type Handle = SurfaceControlHandle;
  type Controls = SurfaceControlState;
  const last = (states: Controls[]): Controls | undefined => states[states.length - 1];

  function mountUnified(extra: {
    onFailure?: (f: PanoPlusFailure) => void;
  } = {}): {
    ref: React.RefObject<Handle | null>;
    states: Controls[];
    unmount: () => void;
  } {
    const ref = React.createRef<Handle>();
    const states: Controls[] = [];
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SweepEngineHarness
          ref={ref}
          onComplete={() => undefined}
          onFailure={extra.onFailure}
          hideBuiltInControls
          onControlsState={(s) => { states.push(s); }}
          bottomBarOffset={150}
        />,
      );
    });
    act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
    return {
      ref,
      states,
      unmount: () => { act(() => { renderer.unmount(); }); },
    };
  }

  // ⚠ "DRAWS NO SHUTTER OF ITS OWN" (testIDs camera-shutter, panoplus-shutter,
  // panoplus-bottom-bar) — the engine's own shutter and bottom bar were
  // deleted in M10, so there is no second shutter left to forbid.
  //
  // What that case's comment also claimed survives, as LAYOUT: the engine
  // keeps its preview and HUD above `<Camera>`'s bottom chrome, and
  // `hideBuiltInControls` / `bottomBarOffset` are how it knows where that is.
  it('reserves <Camera>\'s bottom chrome: hideBuiltInControls and bottomBarOffset reach the start bag', async () => {
    // A SHORT window, so the capsule's knee is set by the height left above
    // the bottom chrome (on the 390x844 window the width binds first and the
    // reservation cannot show in the number).
    rnMock.__setWindowDimensions(390, 500);
    const knee = (offset: number, hide: boolean): number =>
      panoPlusPreviewWindowMultiple(
        { width: 390, height: 500, bottomChromePt: panoBottomChromePt(0, offset, hide) },
        'landscape-left',
      );
    // Each input moves the answer on this window — so the match below is
    // discriminating, not a number every configuration would produce.
    expect(knee(150, true)).not.toBeCloseTo(knee(150, false), 2);
    expect(knee(150, true)).not.toBeCloseTo(knee(0, true), 2);
    const u = mountUnified();
    act(() => { u.ref.current!.holdStart!(); });
    await settle();
    // The knee native sizes the preview against, computed from THIS
    // configuration's reservation: no built-in shutter, a 150 pt bar lift.
    expect((startedWith as Record<string, unknown>).previewWindowCrossMult as number)
      .toBeCloseTo(knee(150, true), 6);
    act(() => { u.ref.current!.holdEnd!(); });
    await settle();
    u.unmount();
  });

  it('reports capturable at idle and busy ONLY while finishing — busy is what the shell paints', async () => {
    let finishStop!: (v: unknown) => void;
    stopImpl = () => new Promise((resolve) => { finishStop = resolve; });
    const u = mountUnified();
    expect(last(u.states)).toEqual({ canCapture: true, canFinalize: false, busy: false });

    act(() => { u.ref.current!.holdStart!(); });
    await settle();
    expect(calls).toEqual(['start']);
    // Sweeping is NOT busy: `CameraShutter` would paint its grey ring over
    // the red one and refuse the press-in it is already inside.
    expect(last(u.states)).toEqual({ canCapture: true, canFinalize: false, busy: false });

    act(() => { u.ref.current!.holdEnd!(); });
    expect(calls).toEqual(['start', 'stop']);
    // The pack write is the one window the shutter is genuinely unavailable.
    expect(last(u.states)).toEqual({ canCapture: true, canFinalize: false, busy: true });

    act(() => { finishStop({}); });
    await settle();
    expect(last(u.states)).toEqual({ canCapture: true, canFinalize: false, busy: false });
    // `canFinalize` is NEVER true: the release is what finishes a sweep, so
    // the shell never shows a Done button over this mode.
    expect(u.states.every((s) => s.canFinalize === false)).toBe(true);
    u.unmount();
  });

  it('a tap (`capture`) and `finalize` are inert through the ref too', async () => {
    const u = mountUnified();
    act(() => { u.ref.current!.capture(); });
    act(() => { u.ref.current!.finalize(); });
    await settle();
    expect(calls).toEqual([]);
    // And the hold pair is exposed at all — a handle without it would leave
    // the shell's shutter red over a sweep that never started.
    expect(typeof u.ref.current!.holdStart).toBe('function');
    expect(typeof u.ref.current!.holdEnd).toBe('function');
    u.unmount();
  });

  it('the ref reads the LIVE phase — a hold during a sweep starts nothing twice', async () => {
    const u = mountUnified();
    act(() => { u.ref.current!.holdStart!(); });
    await settle();
    act(() => { u.ref.current!.holdStart!(); });
    await settle();
    expect(calls).toEqual(['start']);
    act(() => { u.ref.current!.holdEnd!(); });
    await settle();
    // A second release after the finish ends nothing — no `not-running` stop,
    // no cancel, no deleted pack.
    act(() => { u.ref.current!.holdEnd!(); });
    await settle();
    expect(calls).toEqual(['start', 'stop']);
    u.unmount();
  });

  // ── `abandon()` — THE GUARD RAILS' PATH, WHICH HAD NO COVERAGE AT ALL ──
  //
  // `<Camera>`'s rotation guard reaches the sweep through this method and
  // nothing else. Gutting it to `(reason: string) => { void reason; }` left
  // the ENTIRE suite green while the host was told the capture was abandoned
  // and the native sweep kept running and kept painting — which is the exact
  // defect the method was added to prevent, rebuilt by deleting its body.
  //
  // It is DISCARD, not finalize: a guard rail has decided the capture is not
  // worth keeping. That is `cancel`, never `stop`, and the difference is a
  // pack on disk.
  it('⚑ abandon() CANCELS the live sweep — discard, not finalize', async () => {
    const failures: PanoPlusFailure[] = [];
    const u = mountUnified({ onFailure: (f) => { failures.push(f); } });
    act(() => { u.ref.current!.holdStart!(); });
    await settle();
    expect(calls).toEqual(['start']);

    act(() => { u.ref.current!.abandon!('orientation-drift'); });
    await settle();
    expect(calls).toEqual(['start', 'cancel']);
    expect(calls).not.toContain('stop');
    expect(failures.map((f) => f.code)).toEqual(['panoplus-abandoned']);
    expect(failures[0]!.message).toContain('orientation-drift');

    // ⚠ AND THE OPERATOR IS STILL HOLDING THE SHUTTER. A sweep is a HOLD, so
    // his release lands one moment after the guard fired — and `holdEnd`
    // early-returns only on `!sweepLiveRef.current`. With that flag left
    // raised, `finish()` ran on a session that had just been cancelled:
    // `stop()` against nothing, a `not-running` rejection, and a SECOND
    // cancel, which on a build where cancel deletes by path puts the next
    // sweep's directory at risk. The abandon must release the claim, not
    // just the phase.
    act(() => { u.ref.current!.holdEnd!(); });
    await settle();
    expect(calls).toEqual(['start', 'cancel']);
    u.unmount();
  });

  it('⚑ …and is INERT at idle — nothing to abandon, nothing to delete', async () => {
    // Negative control. `cancelPanoPlus()` against no session rejects
    // `panoplus-not-running`, which is swallowed — so without the phase guard
    // this reads as harmless and is not: on a build where cancel deletes by
    // path it is the previous sweep's pack.
    const failures: PanoPlusFailure[] = [];
    const u = mountUnified({ onFailure: (f) => { failures.push(f); } });
    act(() => { u.ref.current!.abandon!('orientation-drift'); });
    await settle();
    expect(calls).toEqual([]);
    expect(failures).toHaveLength(0);
    u.unmount();
  });

  it('⚑ …and is INERT once finish() has taken ownership — a FINISHED pano is kept', async () => {
    // `busyRef` is the latch `finish` sets before awaiting native `stop()`.
    // Firing `cancel()` against a session with `stop()` in flight leaves the
    // pending continuation untouched, so the surface still resolves
    // `onComplete` afterwards: the host would be told the capture was
    // abandoned AND THEN handed that same capture.
    let finishStop!: (v: unknown) => void;
    stopImpl = () => new Promise((resolve) => { finishStop = resolve; });
    const failures: PanoPlusFailure[] = [];
    const u = mountUnified({ onFailure: (f) => { failures.push(f); } });
    act(() => { u.ref.current!.holdStart!(); });
    await settle();
    act(() => { u.ref.current!.holdEnd!(); });
    expect(calls).toEqual(['start', 'stop']);

    // The phone turns while the pack is being written.
    act(() => { u.ref.current!.abandon!('orientation-drift'); });
    await settle();
    expect(calls).toEqual(['start', 'stop']);   // no cancel raced the stop
    expect(failures).toHaveLength(0);
    act(() => { finishStop({}); });
    await settle();
    u.unmount();
  });

  it('⚑ …and a guard rail in the START WINDOW discards rather than resurrecting', async () => {
    // ⚠ THE START WINDOW IS NOT A LIVE SWEEP. `phase` is 'starting' — which
    // `sweepRunning` already reports as recording — and `cancelPanoPlus()`
    // there rejects `panoplus-not-running` and is swallowed. The in-flight
    // `start()` then resolved, raised `sweepLiveRef` and set the phase to
    // 'sweeping': the guard rail reported the capture abandoned to the host
    // and the sweep carried on painting behind it, with nothing left that
    // would ever stop it.
    let resolveStart!: (v: unknown) => void;
    startImpl = () => new Promise((resolve) => { resolveStart = resolve; });
    const failures: PanoPlusFailure[] = [];
    const u = mountUnified({ onFailure: (f) => { failures.push(f); } });
    act(() => { u.ref.current!.holdStart!(); });
    await settle();
    expect(calls).toEqual(['start']);           // …and it has not resolved

    // The operator turns the phone while the camera is still opening.
    act(() => { u.ref.current!.abandon!('orientation-drift'); });
    await settle();
    // Nothing to cancel YET — the latch carries the discard into the
    // resolution, which is the only place a session exists to cancel.
    expect(calls).toEqual(['start']);

    act(() => { resolveStart({ sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true }); });
    await settle();
    expect(calls).toEqual(['start', 'cancel']);
    expect(failures.map((f) => f.code)).toEqual(['panoplus-abandoned']);
    // AND THE SWEEP IS NOT LIVE: a release now ends nothing, because there is
    // nothing to end. This is the assertion that separates "discarded" from
    // "discarded and then resurrected".
    act(() => { u.ref.current!.holdEnd!(); });
    await settle();
    expect(calls).toEqual(['start', 'cancel']);
    u.unmount();
  });
});

// ── THE LIVE PREVIEW, WHICH THE OPERATOR COULD NOT SEE ─────────────────────
//
// 2026-08-23, verbatim: "I do not see a live preview of the image growing as I
// take the capture". Native was rendering one every 250 ms throughout (four
// packs, previewMs n=83–138). Two stacked landscape assumptions hid it: native
// fitted a VERTICAL panorama into a 1400x220 oriented box (→ 201x220), and the
// surface drew that `contain` into a fixed 120 pt strip (→ 108x120 pt), which
// got SMALLER as the sweep got longer.
//
// The model suite pins the geometry maths. These pin the WIRING — that the
// component actually feeds it the status, renders the frame it computes, and
// still shows something when the AR metadata channel says nothing at all.
describe('the live preview', () => {
  /** The operator's own gesture: landscape phone, panned top to bottom. */
  const verticalSweep = (over: Record<string, unknown> = {}) =>
    statusDict({
      axis: 1,
      axisLatched: true,
      paintedWidthPx: 1471,
      canvasHeightPx: 1344,
      previewW: 360,
      previewH: 394,
      ...over,
    });

  function frameStyle(r: Rig): Record<string, number> {
    const node = r.renderer.root.findAllByProps({
      testID: 'panoplus-preview-frame',
    })[0];
    const style = node!.props.style as Array<Record<string, number>>;
    return Object.assign({}, ...(Array.isArray(style) ? style : [style]));
  }

  /** The rotation container's style — the box that carries the quarter turn
   *  since 2026-09-03. The `<Image>` inside it no longer carries a transform:
   *  it is `contain`-fitted and start-anchored INSIDE this box. */
  function innerStyle(r: Rig): Record<string, unknown> {
    const node = r.renderer.root.findAllByProps({
      testID: 'panoplus-preview-inner',
    })[0];
    const style = node!.props.style as Record<string, unknown>;
    return style;
  }
  function imageStyle(r: Rig): Record<string, number> {
    const img = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    return Object.assign(
      {}, ...(img!.props.style as Array<Record<string, number>>),
    ) as Record<string, number>;
  }

  it('draws the operator’s TALL panorama in a FIXED capsule that never moves', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(verticalSweep());

    const f = frameStyle(r);
    // The slit-scan band's thickness, on the real surface with Pano's chrome.
    // `PanoramaBandOverlay.tsx:139` BAND_THICKNESS = 64.
    expect(f.height).toBe(64);
    expect(f.width).toBeGreaterThan(f.height);
    // THE QUARTER TURN MOVED TO THE CONTAINER. The panorama is
    // sensor-referenced and still reads upright to the operator; what changed
    // is that the turn is now on a box of FIXED size, so the image is free to
    // grow inside it.
    const inner = innerStyle(r);
    expect((inner.transform as Array<{ rotate: string }>)[0]!.rotate)
      .toBe('90deg');
    expect(imageStyle(r).transform).toBeUndefined();

    // ── THE FRAME DOES NOT MOVE AS THE PANORAMA GROWS. Defect #3, on the
    //    real surface rather than in the model. ──────────────────────────────
    const seen: Array<Record<string, number>> = [];
    for (const previewH of [394, 800, 1600, 3200]) {
      r.frame(verticalSweep({ previewH, previewSeq: 8 + previewH }));
      seen.push(frameStyle(r));
    }
    for (const g of seen) {
      expect({ left: g.left, top: g.top, width: g.width, height: g.height })
        .toEqual({ left: f.left, top: f.top, width: f.width, height: f.height });
    }

    // On screen, in the 390x844 portrait-locked window the mock reports.
    expect(f.left).toBeGreaterThanOrEqual(0);
    expect(f.top).toBeGreaterThanOrEqual(0);
    expect(f.left + f.width).toBeLessThanOrEqual(390);
    expect(f.top + f.height).toBeLessThanOrEqual(844);
    r.frame(verticalSweep());
    // The image itself is still cache-busted on the PUBLISHED preview seq.
    const img = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    expect((img!.props.source as { uri: string }).uri).toBe(
      'file:///d/pp_1/preview.jpg?v=7',
    );
    r.unmount();
  });

  // ── #5, ON THE REAL SURFACE ────────────────────────────────────────────────
  // "There are 2 changing boundaries in the preview - which I do not
  // understand what they are. One is a blue line..."
  it('draws no frontier line, no captions and no border on the capsule', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(verticalSweep({ previewFrontierFrac: 0.42 }));
    expect(r.has('panoplus-preview-marker')).toBe(false);
    expect(r.has('panoplus-preview-marker-inner')).toBe(false);
    expect(r.has('panoplus-frontier-caption')).toBe(false);
    expect(r.has('panoplus-preview-window')).toBe(false);
    expect(r.shows('blue line')).toBe(false);
    // The hairline that sat ON the canvas extent and moved with it.
    const f = frameStyle(r);
    expect(f.borderWidth).toBeUndefined();
    r.unmount();
  });

  function hudStyle(r: Rig): Record<string, number> {
    const node = r.renderer.root.findAllByProps({
      testID: 'panoplus-hud-block',
    })[0];
    return Object.assign(
      {},
      ...(node!.props.style as Array<Record<string, number>>),
    ) as Record<string, number>;
  }

  it('keeps the HUD out from under the panel, and never turns it', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(verticalSweep());
    const f = frameStyle(r);
    // The HUD block is a COMPUTED rect now, derived from the same layout the
    // panel is — the test is that the two rectangles cannot intersect, which
    // is the property that actually matters and does not depend on which edge
    // the layout happened to choose.
    const h = hudStyle(r);
    const overlaps =
      f.left < h.left + h.width && h.left < f.left + f.width
      && f.top < h.top + h.height && h.top < f.top + f.height;
    expect(overlaps).toBe(false);
    expect(h.width).toBeGreaterThan(60);
    // ...and the HUD is NOT turned (2026-09-03): Pano's chrome stays in the
    // portrait framebuffer whichever way the phone is held, and pano+ now does
    // exactly the same. The panorama inside the frame still is — that is the
    // sensor-referenced quarter turn, which is Pano's viewfinder behaviour.
    expect(r.has('panoplus-hud-inner')).toBe(false);
    expect(h.transform).toBeUndefined();

    // ...and a band still leaves it a usable slab.
    r.frame(statusDict());
    const bandHud = hudStyle(r);
    expect(bandHud.width).toBeGreaterThan(60);
    expect(bandHud.height).toBeGreaterThan(40);
    r.unmount();
  });

  it('stands the capsule on end for a LEFT-TO-RIGHT sweep', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict());   // axis 0, 1400x328 preview
    // axis 0 under the locked host's quarter turn is TALL on the framebuffer,
    // so the capsule is the column — the same 64 pt strip stood on end, which
    // in the operator's landscape hold is the band across the top of his view.
    const f = frameStyle(r);
    expect(f.width).toBe(64);
    expect(f.height).toBeGreaterThan(f.width);
    // Wide TO THE OPERATOR: the image inside the rotation container is the
    // wide one, and it spans the strip's full thickness.
    const imgStyle = imageStyle(r);
    expect(imgStyle.width).toBeGreaterThan(imgStyle.height);
    r.unmount();
  });

  // A BLANK SCREEN IS THE BUG. If nothing has arrived, the frame says so —
  // and names the case where the engine is painting but no preview reaches the
  // app, which is precisely the silence that cost a field trip.
  it('draws a frame that SAYS why it is empty', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ painted: 0, previewSeq: 0 }));
    expect(r.shows('will appear here')).toBe(true);

    r.frame(statusDict({ painted: 240, previewSeq: 0 }));
    expect(r.shows('240 strips painted')).toBe(true);
    expect(
      r.renderer.root.findAllByProps({ testID: 'panoplus-preview' }).length,
    ).toBe(0);
    r.unmount();
  });

  // THE BELT AND BRACES. The status normally rides the throttled `onArFrame`
  // meta under `plugins.sweep` — one native read, no round trip.
  // But that channel is gated on `setArFrameMetaEnabled`, on the plugin being
  // in the AR registry, and on both sides spelling the meta key the same way,
  // and if any of those is wrong on device the HUD and the preview are simply
  // blank — indistinguishable from a sweep that never started. This test drives
  // the surface with the AR channel COMPLETELY SILENT.
  it('still shows the panorama when the AR meta channel never delivers', async () => {
    // ⚠ THIS USED TO ASSERT ON THE HUD'S `88/42 painted` COUNT, and could not
    // after 2026-09-03: the engine readout is idle-only now, because it was
    // part of the prose the operator asked to have off the capture screen.
    // The claim is unchanged and so is the wire it exercises — only the
    // observable moved to something that IS on screen during a sweep, the
    // preview's own cache-busted uri. That is the same status object reaching
    // the same component through the same fallback poll.
    getStatusImpl = () =>
      Promise.resolve(verticalSweep({ painted: 88, previewSeq: 33 }));
    const r = mount();
    r.hold();
    await settle();
    // Not one `onArFrame` call — the channel is dead.
    expect(
      r.renderer.root.findAllByProps({ testID: 'panoplus-preview' }).length,
    ).toBe(0);

    act(() => {
      jest.advanceTimersByTime(PANO_PLUS_STATUS_POLL_MS + 1);
    });
    await settle();

    const img = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    expect(img).toBeDefined();
    expect((img!.props.source as { uri: string }).uri).toBe(
      'file:///d/pp_1/preview.jpg?v=33',
    );
    r.unmount();
  });

  // THE ONE LINK NO TEST ON THIS MACHINE CAN EXERCISE is whether iOS's image
  // loader reads `file://…/preview.jpg?v=7`. It is the same mechanism the
  // library's PanoramaBandOverlay ships and RN's file handler reads
  // `URL.path`, so the query is ignored for the read — but the last blank
  // preview also "should have worked", so a load failure is CAPTIONED.
  // A FROZEN PANEL LOOKS EXACTLY LIKE A STALLED SWEEP. Once anything has
  // published, the placeholder goes quiet (it would otherwise HIDE the real
  // panorama), so a publisher that works and then fails used to leave a
  // motionless image with nothing on it saying why. This notice rides OVER the
  // pixels — the panorama stays visible, with the reason written across it.
  it('captions a preview that has stopped advancing, without hiding it', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(verticalSweep({ previewSeq: 7, previewRenders: 7, previewFails: 0 }));
    expect(
      r.renderer.root.findAllByProps({ testID: 'panoplus-preview-stale' }).length,
    ).toBe(0);

    r.frame(verticalSweep({ previewSeq: 7, previewRenders: 19, previewFails: 12 }));
    const node = r.renderer.root.findAllByProps({
      testID: 'panoplus-preview-stale',
    })[0];
    expect(node).toBeDefined();
    expect(r.shows('FROZEN at preview #7')).toBe(true);
    // The real pixels are STILL THERE — the notice is an overlay, not a
    // replacement, and the placeholder must stay out of the way.
    expect(
      r.renderer.root.findAllByProps({ testID: 'panoplus-preview' }).length,
    ).toBeGreaterThan(0);
    expect(
      r.renderer.root.findAllByProps({
        testID: 'panoplus-preview-placeholder',
      }).length,
    ).toBe(0);
    r.unmount();
  });

  // THE NOTICE IS CHROME, AND CHROME DOES NOT TURN (2026-09-03) — the frozen
  // caption is laid out in the frame like every other word on this screen.
  it('does not turn the frozen caption — chrome stays in the framebuffer', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(verticalSweep({ previewSeq: 7, previewRenders: 19, previewFails: 12 }));
    const node = r.renderer.root.findAllByProps({
      testID: 'panoplus-preview-stale-inner',
    })[0];
    expect(node).toBeDefined();
    const style = Object.assign(
      {},
      ...(node!.props.style as Array<Record<string, unknown>>),
    ) as Record<string, unknown>;
    expect(style.transform).toBeUndefined();
    r.unmount();
  });

  it('says so out loud when the preview file cannot be read', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(verticalSweep());
    expect(
      r.renderer.root.findAllByProps({ testID: 'panoplus-preview-error' }).length,
    ).toBe(0);

    const img = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    act(() => {
      (img!.props.onError as () => void)();
    });
    expect(r.shows('cannot read')).toBe(true);

    // ...and clears itself the moment one loads, so a single transient miss
    // (the very first tick can race the pack queue's write) does not leave a
    // permanent red caption over a working preview.
    const img2 = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    act(() => {
      (img2!.props.onLoad as () => void)();
    });
    expect(r.shows('cannot read')).toBe(false);
    r.unmount();
  });

  // The WIRING half of the safe-area work: the model knows how to dodge the
  // sensor housing, and this pins that the surface actually hands it the
  // insets rather than computing a panel against the raw window.
  it('reads the safe-area insets so the panel dodges the sensor housing', async () => {
    safeAreaMock.__setInsets({ top: 0, left: 0, right: 59, bottom: 21 });
    const r = mount();
    r.hold();
    await settle();
    r.frame(verticalSweep());
    const f = frameStyle(r);
    expect(f.left + f.width).toBeLessThanOrEqual(844 - 59);
    expect(f.width).toBeGreaterThan(120);
    r.unmount();
  });

  it('never lets a late poll roll the HUD backwards', async () => {
    // A poll that resolves after a NEWER AR frame has landed must not undo it:
    // both channels read the same native snapshot, and the preview's cache-bust
    // rides on the same status.
    // Read through the preview's cache-bust rather than the HUD's count: the
    // engine readout is idle-only since 2026-09-03 (see the AR-silent test
    // above). Both numbers ride the SAME status object, so the guard under
    // test — `seq` monotonicity — is exercised identically.
    getStatusImpl = () =>
      Promise.resolve(statusDict({ seq: 10, painted: 5, previewSeq: 2 }));
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ seq: 400, painted: 380, previewSeq: 99 }));
    const uri = (r: Rig) => (
      r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0]!
        .props.source as { uri: string }
    ).uri;
    expect(uri(r)).toBe('file:///d/pp_1/preview.jpg?v=99');

    act(() => {
      jest.advanceTimersByTime(PANO_PLUS_STATUS_POLL_MS + 1);
    });
    await settle();
    expect(uri(r)).toBe('file:///d/pp_1/preview.jpg?v=99');
    r.unmount();
  });

  it('stops polling when the sweep ends', async () => {
    let polls = 0;
    getStatusImpl = () => {
      polls += 1;
      return Promise.resolve(statusDict());
    };
    const r = mount();
    r.hold();
    await settle();
    act(() => {
      jest.advanceTimersByTime(PANO_PLUS_STATUS_POLL_MS * 2 + 1);
    });
    await settle();
    const during = polls;
    expect(during).toBeGreaterThan(0);

    r.release();
    await settle();
    act(() => {
      jest.advanceTimersByTime(PANO_PLUS_STATUS_POLL_MS * 4);
    });
    await settle();
    // A poll outliving its session would keep a dead sweep's HUD alive and
    // hold a bridge call open every half second for the life of the screen.
    expect(polls).toBe(during);
    r.unmount();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE FAILURE STATE HAS TO BE READABLE — break 2 of the 2026-08-29 RCA.
// ════════════════════════════════════════════════════════════════════════════
//
// The placeholder is the loudest string this product has, and it works: it is
// how the empty-preview bug was found. But it was rendered with NO chrome
// rotation while the HUD eight points away carried one, so on the
// portrait-locked app held in landscape — the operator's only hold — the bug
// report read bottom-to-top beside a HUD that read upright. He photographed it
// sideways. A diagnostic you have to tilt your head to read is half a
// diagnostic.

describe('the empty-preview notice fills the frame, unturned', () => {
  function innerStyle(r: Rig, testID: string): Record<string, unknown> {
    const node = r.renderer.root.findAllByProps({ testID })[0];
    expect(node).toBeDefined();
    const style = node!.props.style as
      | Record<string, unknown>
      | Array<Record<string, unknown>>;
    return Object.assign(
      {},
      ...(Array.isArray(style) ? style : [style]),
    ) as Record<string, unknown>;
  }

  it('lays the placeholder out in the frame itself', async () => {
    const r = mount();
    r.hold();
    await settle();
    // THE 2026-08-29 STATE, verbatim: strips painted, previews rendered, none
    // published, and the writer counted its own failures.
    r.frame(statusDict({
      painted: 326,
      previewSeq: 0,
      previewRenders: 31,
      previewFails: 31,
    }));

    // It says WHICH half of the seam broke, not merely that something did.
    expect(r.shows('326 strips painted')).toBe(true);
    expect(r.shows('31 previews RENDERED')).toBe(true);
    expect(r.shows('could not be written to disk')).toBe(true);
    // ⚠ THE DROP LINE IS IDLE-ONLY SINCE 2026-09-03, so this no longer asserts
    // it mid-sweep — the engine and drops readouts were part of the prose the
    // operator asked off the capture screen, and they are written into the
    // pack at stop instead (`PANO_PLUS_SWEEP_NOTICE_FILE`). What must survive
    // ON SCREEN is the in-frame placeholder above, which is the report that
    // actually answers "why is this box empty", and it does.
    expect(r.shows('31 PREVIEW WRITE(S) FAILED')).toBe(false);

    // AND IT IS NOT TURNED (2026-09-03). It carried the HUD's quarter turn
    // and a transposed box for four days; Pano's chrome stays in the portrait
    // framebuffer in every hold, so this fills the frame and turns with
    // nothing. The HUD block it used to match has no inner box any more.
    const notice = innerStyle(r, 'panoplus-preview-placeholder-inner');
    expect(notice.transform).toBeUndefined();
    expect(notice.position).toBe('absolute');
    expect(notice.left).toBe(0);
    expect(notice.right).toBe(0);
    expect(notice.top).toBe(0);
    expect(notice.bottom).toBe(0);
    expect(r.has('panoplus-hud-inner')).toBe(false);
    r.unmount();
  });

  it('is laid out the same way in a portrait hold — there is nothing to turn', async () => {
    stitcherMock.__setOrientation('portrait');
    try {
      const r = mount();
      r.hold();
      await settle();
      r.frame(statusDict({ painted: 326, previewSeq: 0 }));
      const notice = innerStyle(r, 'panoplus-preview-placeholder-inner');
      expect(notice.transform).toBeUndefined();
      r.unmount();
    } finally {
      stitcherMock.__setOrientation('landscape-left');
    }
  });
});

// ── THE FRONTIER MARKER AND THE WINDOWED PANEL ──────────────────────────────
//
// Measured on the operator's three 2026-08-29 packs
// (`results/2026-08-30-panoplus-portrait/preview/`): the painted band's outer
// extent does not move for the first 2.94 / 2.39 / 2.62 s of each sweep —
// 40% / 30% / 33% of it — because `bootstrap` paints a whole 718 px frame
// footprint and the strip commit then starts half a footprint behind it. The
// commit frontier moves the whole time; nothing on screen was showing it.

describe('the frontier marker is OFF the capture screen', () => {
  // ⚠ THIS BLOCK USED TO PIN THE MARKER'S MOTION — that it travelled the panel
  // across three frames of an unchanging panorama, that its box was unpadded,
  // that it ran along the operator's horizontal in a portrait hold. Every one
  // of those claims was true and the feature is still correct;
  // `panoPlusPreviewMarker` is exported and its geometry is pinned in the
  // model suite. It is the CAPTURE SCREEN that no longer draws it, on the
  // operator's instruction (2026-09-03):
  //
  //   "There are 2 changing boundaries in the preview - which I do not
  //    understand what they are. One is a blue line - do not understand why
  //    this is needed because the image grows beyond that point... Make it
  //    like how iOS pano shows the preview! Just the preview of what output
  //    looks like - the exact image you are going to get as the result."
  //
  // His reasoning is also sound: the pixels past the line ARE the output —
  // the preview's provisional lead-out warps the same frame through the same
  // homography the tail flush commits at stop. So this is the inverse guard:
  // the line must not come back by accident.
  const sweeping = (over: Record<string, unknown> = {}) =>
    statusDict({
      axis: 1, axisLatched: true, sweepSign: 1,
      paintedWidthPx: 718, canvasHeightPx: 1216,
      previewW: 800, previewH: 472, previewSeq: 7,
      ...over,
    });

  // ── THE HARD FAULTS REACH THE SCREEN DURING THE SWEEP ────────────────────
  //
  // The bug this pins: `{!sweeping && <hud/>}` mounted the HUD line exactly
  // when it had nothing to say. A status with `painted > 0` exists ONLY while
  // sweeping, so every warning on that line — v5 CUTS, v6/v8 BAND, the drops
  // line and SHEAR — was unreachable in the phase where it could still save
  // the sweep. Four warnings, each with its own field incident behind it.
  //
  // The whole suite missed it because `panoPlusHudLine` was tested directly
  // and always returned the correct STRING. Nothing asserted the string
  // reached a rendered surface. That is what these two tests do.

  it('SHOWS A BREACHED BAR MID-SWEEP — 28.41 px/√n, the real 22-56-36 value', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweeping({ painted: 40, crossBandDivergenceNormPx: 28.41 }));
    expect(r.has('panoplus-sweep-faults')).toBe(true);
    expect(r.shows('SHEAR 28.4')).toBe(true);
    // The fault is named; no gesture is prescribed — see panoPlusSweepFaults.
    expect(r.shows('strips drifting apart')).toBe(true);
    r.unmount();
  });

  it('STAYS QUIET ON A HEALTHY SWEEP — the operator asked for that', async () => {
    // The anti-clutter rule is not being reverted. "There is still some text
    // shown in the pano+ screen - no point of it!" was about a HEALTHY sweep,
    // and a healthy sweep still shows nothing but the headline.
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweeping({ painted: 40, crossBandDivergenceNormPx: 4.0 }));
    expect(r.has('panoplus-sweep-faults')).toBe(false);
    // …and the full idle readout stays off during the sweep, as before.
    expect(r.has('panoplus-hud')).toBe(false);
    r.unmount();
  });

  it('draws no marker at any frontier fraction, in either hold', async () => {
    for (const o of ['landscape-left', 'portrait'] as const) {
      stitcherMock.__setOrientation(o);
      try {
        const r = mount();
        r.hold();
        await settle();
        for (const frac of [0, 0.05, 0.5, 0.9, 1]) {
          r.frame(sweeping({ previewFrontierFrac: frac }));
          expect(r.has('panoplus-preview-marker')).toBe(false);
          expect(r.has('panoplus-preview-marker-inner')).toBe(false);
          expect(r.has('panoplus-frontier-caption')).toBe(false);
        }
        r.unmount();
      } finally {
        stitcherMock.__setOrientation('landscape-left');
      }
    }
  });

  // The engine still PUBLISHES the frontier — it is pack evidence, and the
  // residual analysis reads it. Only the screen stopped drawing it.
  it('still carries the frontier on the status channel', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweeping({ previewFrontierFrac: 0.42 }));
    // The preview renders from the same status the frontier rode in on, so a
    // frame carrying a frontier is still a frame that draws a panorama.
    expect(
      r.renderer.root.findAllByProps({ testID: 'panoplus-preview' }).length,
    ).toBe(1);
    r.unmount();
  });
});

describe('a windowed panel no longer captions itself on screen', () => {
  // ⚠ THE CAPTION IS GONE FROM THE CAPTURE SCREEN (2026-09-03). It read
  // "showing the last 29% — the panel holds its scale instead of shrinking",
  // and it was correct: once the frontier window engages the strip IS a slice.
  // It is also prose over a live pan, which is what the operator asked to have
  // removed, and the removal is not silent — `panoPlusPreviewWindowCaption` is
  // still exported and still tested, and the surface now writes its output
  // into the pack at stop (`PANO_PLUS_SWEEP_NOTICE_FILE`, `previewWindow`).
  //
  // The window ENGAGING is also no longer an oddity to disclose: with a fixed
  // capsule it is the mechanism that stops the panorama shrinking, and it is
  // what Pano does — older content slides off, the scale holds.
  it('draws no window caption whether the window is engaged or not', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({ previewSeq: 7, previewViewPx: 1464,
                         previewBandPx: 1464, previewWindowed: false }));
    expect(r.has('panoplus-preview-window')).toBe(false);

    r.frame(statusDict({
      previewSeq: 7, previewWindowed: true,
      previewViewPx: 1757, previewBandPx: 6000,
    }));
    expect(r.has('panoplus-preview-window')).toBe(false);
    expect(r.shows('showing the last')).toBe(false);
    r.unmount();
  });

  // The FROZEN notice is a fault and stays: it is the difference between a
  // stalled sweep and a publisher that died, and the two have opposite
  // responses. It is the only in-frame text left on a live preview.
  it('still shows the FROZEN notice over a stale panel', async () => {
    const r = mount();
    r.hold();
    await settle();
    r.frame(statusDict({
      previewSeq: 7, previewFails: 4, previewWindowed: true,
      previewViewPx: 1757, previewBandPx: 6000,
    }));
    expect(r.has('panoplus-preview-stale')).toBe(true);
    r.unmount();
  });
});

describe('the frontier window’s one number reaches native', () => {
  it('is sent at start(), derived from THIS phone’s chrome', async () => {
    const r = mount();
    r.hold();
    await settle();
    const opts = startedWith as Record<string, unknown>;
    // Asserted against the FUNCTION rather than a copied number: what this
    // test owns is the WIRING (that the surface computes it from the window,
    // the insets AND the bottom chrome it is actually rendering into and puts
    // it on the options bag). The knee's own value is pinned in
    // panoPlusModel's tests. No safe-area insets here, no `bottomBarOffset`,
    // and the built-in shutter drawn (this rig hides nothing).
    expect(opts.previewWindowCrossMult as number).toBeCloseTo(
      panoPlusPreviewWindowMultiple(
        { width: 390, height: 844, bottomChromePt: panoBottomChromePt(0, 0, false) },
        'landscape-left',
      ),
      6,
    );
    // 6.346 = the fixed capsule's own along ÷ cross, (342 − 12) / (64 − 12).
    // It was 1.558 while the band was FITTED to the panorama; see
    // `panoPlusPreviewWindowMultiple`'s header for why the knee moved.
    expect(opts.previewWindowCrossMult as number).toBeCloseTo(6.346, 2);
    r.unmount();
  });

  it('follows the safe-area insets rather than a hardcoded phone', async () => {
    safeAreaMock.__setInsets({ top: 0, left: 0, right: 59, bottom: 21 });
    try {
      const r = mount();
      r.hold();
      await settle();
      const opts = startedWith as Record<string, unknown>;
      expect(opts.previewWindowCrossMult as number).toBeCloseTo(
        panoPlusPreviewWindowMultiple(
          { width: 390, height: 844,
            insets: { top: 0, left: 0, right: 59, bottom: 21 },
            bottomChromePt: panoBottomChromePt(21, 0, false) },
          'landscape-left',
        ),
        6,
      );
      r.unmount();
    } finally {
      safeAreaMock.__setInsets(null);
    }
  });

  it('is overridable by a host that has measured its own chrome', async () => {
    const r = mount({ packOptions: { previewWindowCrossMult: 2.5 } });
    r.hold();
    await settle();
    expect((startedWith as Record<string, unknown>).previewWindowCrossMult)
      .toBe(2.5);
    r.unmount();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  THE PANEL BELONGS TO ONE SWEEP — the 2026-09-07 field defect
// ════════════════════════════════════════════════════════════════════════════
//
// OPERATOR, iPhone17,1, field build, ARKit arm: "After I take the first capture,
// the preview just shows the previous output from the next capture onwards. It
// does not show any growing canvas as expected of the current capture."
//
// WHAT THE TWO PACKS PROVE. Capture 2 published 23 previews natively into ITS
// OWN session dir (0 failed, 0 skipped, `finalRepublished` true) and its
// `canvas.jpg` is its own scene — so the engine and the preview writer were
// both correct and the defect was entirely in what this surface CHOSE TO
// DISPLAY. The HUD text latched into capture 2's pack read "260/295 painted",
// capture 2's own numbers, and capture 2 ran 295 frames against capture 1's
// 276: the panel only became capture 2's in the last ~19 frames, exactly when
// its frame counter overtook capture 1's final one.
//
// THE GUARD THAT DID IT. `applyStatus` kept the newer `seq` — and `seq` is the
// PER-SWEEP frame counter, which restarts at 0 on every capture. Session-blind,
// so one held status from a finished sweep swallowed every frame of the next
// one until the counter caught up, which on a shorter second sweep never
// happens at all.
//
// WHY THE ARKIT ARM ONLY, and why these cases drive `onArFrame` rather than the
// poll. `<ARCameraView onArFrame={handleArFrame}>` is mounted for the WHOLE
// surface lifetime and is NOT gated on a sweep being live, so a meta tick
// carrying a finished session's status can be delivered to JS after the next
// start has already cleared the panel. On the decoupled/IMU arm that view is
// deliberately never mounted and the only channel is the poll effect, which is
// gated on `phase === 'sweeping'` — which is why the operator saw this on ARKit
// and not on IMU.
describe('the live panel is scoped to the sweep the surface owns', () => {
  /** Native answers a NEW session dir per start, the way it does on the phone. */
  function startsPerSweep(): void {
    let n = 0;
    startImpl = () => {
      n += 1;
      return Promise.resolve({
        sessionDir: `/d/pp_${n}`, startedAtMs: n, pluginAvailable: true,
      });
    };
  }
  /** One sweep's status — its dir, its preview, its own restarting `seq`. */
  function sweep(n: number, over: Record<string, unknown> = {}) {
    return statusDict({
      sessionDir: `/d/pp_${n}`,
      previewPath: `/d/pp_${n}/preview.jpg`,
      ...over,
    });
  }
  const previewUri = (r: Rig): string | null => {
    const img = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    return img == null ? null : (img.props.source as { uri: string }).uri;
  };

  /**
   * The uri sitting in the HIDDEN slot — the one that has been accepted and is
   * decoding but has not been promoted yet.
   *
   * The panel is a two-slot ping-pong (see useSweepEngine's
   * [previewSlots]): a new publish is assigned to the hidden slot and only
   * becomes visible when its own `onLoad` fires, because on Android changing a
   * mounted <Image>'s source blanks it synchronously. So "was this publish
   * accepted" and "is this publish on screen" are now two different questions
   * and the tests have to be able to ask both.
   */
  const stagedUri = (r: Rig): string | null => {
    const imgs = r.renderer.root.findAllByProps({ testID: /panoplus-preview-hidden/ as unknown as string });
    for (const w of ['a', 'b']) {
      const img = r.renderer.root.findAllByProps({
        testID: `panoplus-preview-hidden-${w}`,
      })[0];
      const uri = img == null ? null : (img.props.source as { uri: string }).uri;
      if (uri != null && uri !== '') return uri;
    }
    return imgs.length === 0 ? null : null;
  };

  /** Fire the hidden slot's onLoad, as a real decode would. */
  const settlePreview = (r: Rig): void => {
    for (const w of ['a', 'b']) {
      const img = r.renderer.root.findAllByProps({
        testID: `panoplus-preview-hidden-${w}`,
      })[0];
      if (img?.props?.onLoad != null) {
        act(() => { (img.props.onLoad as () => void)(); });
        return;
      }
    }
  };

  it('discards a status from ANOTHER session however new its seq is', async () => {
    startsPerSweep();
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweep(1, { seq: 40, previewSeq: 4 }));
    expect(previewUri(r)).toBe('file:///d/pp_1/preview.jpg?v=4');
    // A foreign session's status, newer on every counter this surface has. It
    // is not ours, so its `seq` is not a fact about our sweep at all.
    r.frame(sweep(9, { seq: 9999, previewSeq: 9999 }));
    expect(previewUri(r)).toBe('file:///d/pp_1/preview.jpg?v=4');
    r.unmount();
  });

  it('shows the NEW sweep from its first frame, seq restarted at 0', async () => {
    // ⚠ THIS IS THE OPERATOR'S BUG. Sweep 1 ends at seq 276; a late meta tick
    // carrying sweep 1's status is delivered after sweep 2 has started; sweep
    // 2's own frames then arrive at seq 0, 1, 2… and the session-blind guard
    // refused every one of them as "older".
    startsPerSweep();
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweep(1, { seq: 276, previewSeq: 276 }));
    expect(previewUri(r)).toBe('file:///d/pp_1/preview.jpg?v=276');
    r.release();
    await settle();
    r.hold();
    await settle();
    // The straggler: ARKit's throttled push, queued before the boundary and
    // delivered after it. The panel already belongs to sweep 2.
    r.frame(sweep(1, { seq: 276, previewSeq: 276 }));
    r.frame(sweep(2, { seq: 0, previewSeq: 1 }));
    expect(previewUri(r)).toBe('file:///d/pp_2/preview.jpg?v=1');
    // …and it keeps growing, rather than waiting to overtake 276. Since the
    // panel became a two-slot ping-pong the newest publish is STAGED first and
    // promoted on its own decode, so both halves are asserted: it was accepted,
    // and it reaches the screen. What must never happen — sweep 1's frame
    // coming back — is covered by the uri prefix on both.
    r.frame(sweep(2, { seq: 1, previewSeq: 2 }));
    expect(stagedUri(r)).toBe('file:///d/pp_2/preview.jpg?v=2');
    settlePreview(r);
    expect(previewUri(r)).toBe('file:///d/pp_2/preview.jpg?v=2');
    r.unmount();
  });

  it('never changes the VISIBLE slot\'s source — that is the whole flicker fix', async () => {
    // ⚠ THE INVARIANT, and it is the mechanism rather than a symptom. On
    // Android, assigning a new source to a MOUNTED <Image> runs
    // AbstractDraweeController.init() -> hierarchy.reset(), which replaces the
    // drawn bitmap with a transparent ColorDrawable SYNCHRONOUSLY, before the
    // replacement is even requested. RN installs no placeholder. So any publish
    // that re-sources the visible view blanks the panel for one disk read plus
    // one JPEG decode, and the operator sees the dark scrim and the live
    // viewfinder through it. iOS cannot do this — RCTImageComponentView only
    // assigns _imageView.image inside didReceiveImage: — which is why he saw it
    // on one platform only.
    //
    // Therefore: while a sweep is running, the source of whichever slot is
    // VISIBLE must be byte-identical across publishes. If this test ever fails,
    // the flicker is back, whatever the screen appears to show on a fast phone.
    startsPerSweep();
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweep(1, { seq: 0, previewSeq: 1 }));
    const first = previewUri(r);
    expect(first).toBe('file:///d/pp_1/preview.jpg?v=1');

    // Four more publishes, none of which may touch the visible slot.
    for (const v of [2, 3, 4, 5]) {
      r.frame(sweep(1, { seq: v, previewSeq: v }));
      expect(previewUri(r)).toBe(first);
      expect(stagedUri(r)).toBe(`file:///d/pp_1/preview.jpg?v=${v}`);
    }

    // The swap happens on the decode, not on the publish, and it lands on the
    // newest staged frame rather than replaying the ones it skipped.
    settlePreview(r);
    expect(previewUri(r)).toBe('file:///d/pp_1/preview.jpg?v=5');
    r.unmount();
  });

  it('still refuses an out-of-order tick WITHIN the sweep it owns', async () => {
    // The monotonic guard is not deleted, it is scoped. Both channels read the
    // same native snapshot, so a slow tick must not roll the panel backwards.
    startsPerSweep();
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweep(1, { seq: 400, previewSeq: 99 }));
    r.frame(sweep(1, { seq: 10, previewSeq: 2 }));
    expect(previewUri(r)).toBe('file:///d/pp_1/preview.jpg?v=99');
    r.unmount();
  });

  it('discards a status that arrives when no sweep is live', async () => {
    // The finished sweep's own last tick, landing back on an idle screen. It
    // was applied before this change, which is the literal "the preview shows
    // the previous output" the operator reported — with no capture running.
    startsPerSweep();
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweep(1, { seq: 276, previewSeq: 276 }));
    r.release();
    await settle();
    expect(previewUri(r)).toBeNull();
    r.frame(sweep(1, { seq: 276, previewSeq: 276 }));
    expect(previewUri(r)).toBeNull();
    r.unmount();
  });

  it('renders sweep 2 out of sweep 2 DIRECTORY, not sweep 1\'s pack', async () => {
    // The pixels the operator was looking at came from a file in the PREVIOUS
    // pack. Assert the directory, not just the cache-bust.
    startsPerSweep();
    const r = mount();
    r.hold();
    await settle();
    r.frame(sweep(1, { seq: 200, previewSeq: 60 }));
    r.release();
    await settle();
    r.hold();
    await settle();
    r.frame(sweep(1, { seq: 200, previewSeq: 60 }));   // the straggler again
    r.frame(sweep(2, { seq: 3, previewSeq: 2 }));
    const uri = previewUri(r) ?? '';
    expect(uri.startsWith('file:///d/pp_2/')).toBe(true);
    expect(uri.includes('/pp_1/')).toBe(false);
    r.unmount();
  });
});


// ════════════════════════════════════════════════════════════════════════════
//  THE SAME SCOPING, WITH A NESTED PACK DIR — the shape Android answers
// ════════════════════════════════════════════════════════════════════════════
//
// The block above drives the iOS spelling ONLY (`/d/pp_<n>`), which is the one
// spelling in which the session id happens to be the last path component. The
// Android recorder appends a second literal component — `openPack()` does
// `packDir = File(base, "panoplus")` on the `<Documents>/panoplus/pp_<ms>` this
// SDK sends — opens the engine on THAT (`PanoPlusLiveNative.start(sessionDir =
// packDir.absolutePath)`), stamps it into every status (shared C++
// `kvStr(s, "sessionDir", S.sessionDir)`), and answers the start with the same
// string (`optStr(m, "packDir", sessionDir)`). Read as "last component", every
// sweep is then the constant "panoplus" and the session test is a tautology.
//
// SHAPE COVERAGE, NOT A CHANNEL CLAIM: these cases drive `onArFrame`, the only
// status channel this rig has, exactly as the block above does. They assert
// that the surface scopes correctly when native answers a NESTED dir — not that
// Android mounts <ARCameraView> (it does not: `arArmed` is false for the
// 'android-sensor' arm contract).
describe('the live panel is scoped when native answers a nested pack dir', () => {
  /** Native answers `<session>/panoplus` per start — the Android spelling. */
  function startsPerSweepNested(): void {
    let n = 0;
    startImpl = () => {
      n += 1;
      return Promise.resolve({
        sessionDir: `/d/pp_${n}/panoplus`, startedAtMs: n, pluginAvailable: true,
      });
    };
  }
  /** One sweep's status, spelled the way the shared C++ stamps it. */
  function nested(n: number, over: Record<string, unknown> = {}) {
    return statusDict({
      sessionDir: `/d/pp_${n}/panoplus`,
      previewPath: `/d/pp_${n}/panoplus/preview.jpg`,
      ...over,
    });
  }
  const previewUri = (r: Rig): string | null => {
    const img = r.renderer.root.findAllByProps({ testID: 'panoplus-preview' })[0];
    return img == null ? null : (img.props.source as { uri: string }).uri;
  };

  it('discards another session however new its seq, nested dirs and all',
    async () => {
      startsPerSweepNested();
      const r = mount();
      r.hold();
      await settle();
      r.frame(nested(1, { seq: 40, previewSeq: 4 }));
      expect(previewUri(r)).toBe('file:///d/pp_1/panoplus/preview.jpg?v=4');
      r.frame(nested(9, { seq: 9999, previewSeq: 9999 }));
      expect(previewUri(r)).toBe('file:///d/pp_1/panoplus/preview.jpg?v=4');
      r.unmount();
    });

  it('shows the new sweep from its first frame, nested dirs and all', async () => {
    startsPerSweepNested();
    const r = mount();
    r.hold();
    await settle();
    r.frame(nested(1, { seq: 276, previewSeq: 276 }));
    r.release();
    await settle();
    r.hold();
    await settle();
    // The straggler from the finished sweep, then sweep 2's own seq-0 frames.
    r.frame(nested(1, { seq: 276, previewSeq: 276 }));
    r.frame(nested(2, { seq: 0, previewSeq: 1 }));
    const uri = previewUri(r) ?? '';
    expect(uri).toBe('file:///d/pp_2/panoplus/preview.jpg?v=1');
    expect(uri.includes('/pp_1/')).toBe(false);
    r.unmount();
  });
});
