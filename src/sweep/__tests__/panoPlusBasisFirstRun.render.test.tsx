// SPDX-License-Identifier: Apache-2.0
//
// FIRST-RUN BASIS ACQUISITION — THE WIRING, MOUNTED FOR REAL.
//
// ── The gap this closes ───────────────────────────────────────────────────
//
// `panoPlusBasisAcquisition` is unit-tested next door and none of that proves
// the SURFACE mounts the overlay, that the overlay starts the recorder, that a
// sufficient gesture SOLVES without a button, that a refusal is never
// persisted, or — the one that would cost a field trip — that the surface
// RE-READS the store afterwards so the arm it had already fallen back to
// recovers. That last one is the whole point: a basis measured and saved and
// then not noticed leaves the operator on ARKit on the very phone he just
// calibrated, with no affordance but leaving the mode and coming back.
//
// The gesture itself cannot be exercised here — it needs the operator's hands
// and a live ARKit session. What CAN be exercised is everything around it, and
// this file draws that line explicitly rather than implying coverage it has not
// got: the native calls are a FAKE whose call log is asserted, and the
// excitation verdict is fed in as data the way the real recorder would report
// it.
//
// ⚠️ THIS FILE MUST LIVE IN `__tests__/`. The BUILD tsconfig excludes
// `**/*.test.ts` and `**/__tests__/**` — note the FIRST pattern does not match
// `.tsx`, so a `.render.test.tsx` sitting beside its component is compiled into
// `dist/` and fails the build on `react-test-renderer`, which ships no
// declarations (its ambient shim is itself inside a `__tests__/` dir and is
// therefore excluded from that program too). Written after making exactly that
// mistake: `npx tsc --noEmit` caught it, which is the whole reason the SDK's
// verify step is two commands and not one.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import { useState } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///var/mobile/Documents/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: () => Promise.resolve(),
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);

/**
 * FORCE THE LADDER TO SAY "GESTURE REQUIRED" — the ONLY way to reach the
 * `armCanAcquireBasis` guard, and the reason that guard is written down.
 *
 * The no-dead-overlay rule on Android is currently EMERGENT rather than
 * asserted: `panoPlusBasisCapability('android')` derives `C` analytically, so
 * `resolvePanoPlusBasis` answers `needsGesture: false` there and the surface is
 * never asked the question. That makes the property untestable through the real
 * ladder — and untestable is exactly how it would be lost. One widening of
 * `panoPlusBasisAcquisition` (a device whose derivation is distrusted, a
 * falsification run that refuses) flips that input, and with no guard in the
 * surface the overlay would mount on a platform where `arArmed` is hard-`false`
 * and sit on `arming` behind a spinner for the life of the surface.
 *
 * So the input is forced here, at the seam, and the surface's own refusal is
 * what is measured. Passthrough by default — every other test in this file runs
 * the real ladder.
 *
 * ⚠ THE NAME MUST START WITH `mock`. `jest.mock` is hoisted above the imports
 * and its factory may not close over an ordinary outer binding.
 */
let mockForceGestureRoute = false;
jest.mock('../panoPlusBasisAcquisition', () => {
  const actual = jest.requireActual('../panoPlusBasisAcquisition');
  return {
    ...actual,
    resolvePanoPlusBasis: (i: unknown) => (mockForceGestureRoute
      ? {
          route: 'gesture',
          needsGesture: true,
          basisIndex: null,
          basisLabel: null,
          provenance: 'none',
          reason: 'gesture-required',
          detail: 'forced by the test — see `armCanAcquireBasis`.',
        }
      : (actual as {
          resolvePanoPlusBasis: (x: unknown) => unknown;
        }).resolvePanoPlusBasis(i)),
  };
});

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
import { holdShutter, releaseShutter, shutterState } from './shutterGestures';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';
import type { PanoPlusPoseSource } from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** Every CALIBRATION call the surface + overlay made, in order. */
let calibCalls: string[] = [];
/** What the fake recorder reports on the next status poll. */
let liveStatus: Record<string, unknown> = {};
/** What `stopBasisCalibration` resolves — the solve. */
let solveImpl: () => Promise<unknown> = () => Promise.resolve({});
/** What `saveBasisCalibration` does. Rejecting is the "the store refused what
 *  the mirror accepted" case, which must never be reported as success. */
let saveImpl: () => Promise<unknown> = () => Promise.resolve({ saved: true });
/** The store snapshot. Mutated by the tests to simulate the write landing. */
let snapshot: Record<string, unknown> = {
  haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis',
};

/** A gesture that has cleared the C++ bars — what the recorder reports when the
 *  operator has actually tilted AND panned. */
const SUFFICIENT = {
  recording: true, ok: true, steps: 400, sweptDeg: 180, spanDeg: 90,
  perAxisDeg: { tilt: 40, pan: 60, roll: 30 },
  eig: [200, 90, 40], rank2: 0.67, rank3: 0.45,
  sufficient: true, reason: 'ok',
  needMore: { tilt: false, pan: false, roll: false },
  exercisedAxes: 3, progress: 1, imuSamples: 2000, refSamples: 600,
};

/** A pan-only gesture — the motion every other capture in this app trains. */
const PAN_ONLY = {
  recording: true, ok: true, steps: 200, sweptDeg: 70, spanDeg: 60,
  perAxisDeg: { tilt: 1, pan: 68, roll: 1 },
  eig: [300, 0.3, 0.1], rank2: 0.03, rank3: 0.02,
  sufficient: false, reason: 'single-axis',
  needMore: { tilt: true, pan: false, roll: true },
  exercisedAxes: 1, progress: 0.33, imuSamples: 1200, refSamples: 400,
};

/** A solve that passed BOTH gates — the fit and the ±10 ms stability sweep. */
const GOOD_SOLVE = {
  ran: true,
  basis: {
    ok: true, reason: 'ok', index: 8, label: '+y+z+x', pairs: 777,
    rmsDeg: 0.234, maxDeg: 0.9, marginDeg: 12.4, unique: true,
    runnerUpIndex: 3, runnerUpLabel: '+x+z+y', runnerUpRmsDeg: 12.6,
  },
  stability: {
    ok: true, reason: 'ok', winnerStable: true, winnerIndex: 8,
    triedOffsets: 5, agreeingOffsets: 5, minMarginDeg: 11.9,
    offsetsS: [-0.01, -0.005, 0, 0.005, 0.01],
  },
};

/** A solve whose WINNER MOVED under the clock sweep. The fit itself says `ok`,
 *  which is exactly why the second gate exists — and why this shape is the one
 *  worth pinning. */
const UNSTABLE_SOLVE = {
  ran: true,
  basis: { ...GOOD_SOLVE.basis },
  stability: {
    ok: true, reason: 'winner-changed', winnerStable: false, winnerIndex: -1,
    triedOffsets: 5, agreeingOffsets: 2, minMarginDeg: 0.01,
    offsetsS: [-0.01, -0.005, 0, 0.005, 0.01],
  },
};

let startCalls = 0;
function installNative(): void {
  calibCalls = [];
  startCalls = 0;
  NM.RNISPanoPlus = {
    start: () => {
      startCalls += 1;
      return Promise.resolve({
        sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: false }),
  };
  NM.RNISPanoCalib = {
    plannedCaptureFormat: () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    }),
    getCalibration: () => {
      calibCalls.push('getCalibration');
      return Promise.resolve({ resolved: snapshot });
    },
    startBasisCalibration: () => {
      calibCalls.push('startBasisCalibration');
      return Promise.resolve({ started: true });
    },
    basisCalibrationStatus: () => {
      calibCalls.push('status');
      return Promise.resolve(liveStatus);
    },
    stopBasisCalibration: () => {
      calibCalls.push('stopBasisCalibration');
      return solveImpl();
    },
    resolveBasisCalibration: () => Promise.resolve({}),
    discardBasisCalibration: () => {
      calibCalls.push('discardBasisCalibration');
      return Promise.resolve({ discarded: true });
    },
    saveBasisCalibration: () => {
      calibCalls.push('saveBasisCalibration');
      return saveImpl();
    },
    saveTauCalibration: () => Promise.resolve({}),
    combineTauRuns: () => Promise.resolve({}),
    calibrationPolicy: () => Promise.resolve({}),
    clearCalibration: () => Promise.resolve({}),
  };
}

interface Rig {
  shows: (needle: string) => boolean;
  has: (testID: string) => boolean;
  tap: (testID: string) => void;
  /**
   * Every `pointerEvents` on the ANCESTOR CHAIN of `testID`, root-first.
   *
   * ⚠ `has()` AND `tap()` CANNOT SEE THE BUG THIS IS NAMED FOR. `tap` reaches
   * into `props.onPress` and calls it, bypassing touch dispatch entirely — so
   * both pass happily on a control sealed under `pointerEvents="none"`, which
   * no finger can ever reach. Not hypothetical: `panoplus-lens-chip` shipped in
   * exactly that state and was dead on both platforms until 2026-09-02,
   * verified on the A35 by tapping its centre and watching nothing happen.
   * uiautomator could not see it either — `pointerEvents` is not an
   * accessibility property. An overlay that is "shown" but sealed is the same
   * defect wearing the gate's clothes, so a SHOWN assertion in this file is
   * paired with this one.
   */
  blockers: (testID: string) => string[];
  /**
   * Every `panoplus-*` control on screen a finger could press, by testID.
   *
   * Lets a test assert about the WHOLE surface rather than about the two
   * controls someone happened to think of — which is how the AR pill survived
   * over the basis card in the first place: the overlay was reviewed, the
   * chrome around it was not.
   */
  pressables: () => string[];
  /** Pano's shutter held past the threshold — the sweep starts (2026-09-03). */
  hold: () => void;
  /** …and released — the sweep finishes, pack kept. */
  release: () => void;
  /** What Pano's shutter would paint. */
  shutter: () => { disabled: boolean; busy: boolean };
  unmount: () => void;
}

/** The rig over an already-mounted tree, so the fixed-prop mount and the
 *  STATEFUL host below share one set of eyes. */
function makeRig(renderer: ReactTestRenderer): Rig {
  const collect = (): string[] => {
    const out: string[] = [];
    const walk = (n: ReactTestInstance | string | null): void => {
      if (n == null) return;
      if (typeof n === 'string') { out.push(n); return; }
      for (const c of n.children ?? []) walk(c as ReactTestInstance | string);
    };
    walk(renderer.root as unknown as ReactTestInstance);
    return out;
  };
  return {
    shows: (needle) => collect().some((t) => t.includes(needle)),
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    tap: (testID) => {
      const node = renderer.root
        .findAllByProps({ testID })
        .find((n) => n.props.onPress != null);
      if (node == null) throw new Error(`no pressable ${testID}`);
      act(() => { (node.props.onPress as () => void)(); });
    },
    blockers: (testID) => {
      const node = renderer.root.findAllByProps({ testID })[0];
      if (node == null) throw new Error(`no node with testID ${testID}`);
      interface Walkable { props: { pointerEvents?: string }; parent: Walkable | null }
      const out: string[] = [];
      let cur = (node as unknown as Walkable).parent;
      while (cur != null) {
        const pe = cur.props?.pointerEvents;
        if (typeof pe === 'string') out.unshift(pe);
        cur = cur.parent;
      }
      return out;
    },
    pressables: () => {
      const out = new Set<string>();
      for (const n of renderer.root.findAll(
        (x) => x.props?.onPress != null && typeof x.props?.testID === 'string',
      )) {
        const id = n.props.testID as string;
        if (id.startsWith('panoplus-')) out.add(id);
      }
      return [...out].sort();
    },
    hold: () => holdShutter(renderer.root),
    release: () => releaseShutter(renderer.root),
    shutter: () => shutterState(renderer.root),
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

function mount(): Rig {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PanoPlusCaptureSurface
        onComplete={() => undefined}
        onCancel={() => undefined}
        poseSource="imu"
        tauUncorrected
      />,
    );
  });
  act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
  return makeRig(renderer);
}

type HostLens = 'ultraWide' | 'wide';

/**
 * The host the real app is — `DebugCameraScreen` owning both flags and handing
 * them down — reduced to the two that decide whether a basis is wanted.
 *
 * A fixed-prop mount cannot express the 0.5× property at all: it would show the
 * tap being REQUESTED and never the frame that comes back, and the frame that
 * comes back is the whole subject. Same shape as the arm-rule suite's host, so
 * the two files agree on what "the host" means.
 */
function Host(props: { lens0: HostLens; pose0: PanoPlusPoseSource }): React.JSX.Element {
  const [lens, setLens] = useState<HostLens>(props.lens0);
  const [pose, setPose] = useState<PanoPlusPoseSource>(props.pose0);
  return (
    <PanoPlusCaptureSurface
      onComplete={() => undefined}
      onCancel={() => undefined}
      lens={lens}
      poseSource={pose}
      onLensChange={setLens}
      onPoseSourceChange={setPose}
    />
  );
}

function mountHost(lens0: HostLens, pose0: PanoPlusPoseSource): Rig {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<Host lens0={lens0} pose0={pose0} />); });
  act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
  return makeRig(renderer);
}

/** A bare mount with whatever props a case needs — used for the arm and
 *  platform cases, where no flag has to round-trip. */
function mountWith(
  props: Partial<React.ComponentProps<typeof PanoPlusCaptureSurface>>,
): Rig {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PanoPlusCaptureSurface
        onComplete={() => undefined}
        onCancel={() => undefined}
        poseSource="imu"
        {...props}
      />,
    );
  });
  act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
  return makeRig(renderer);
}

/**
 * LET THE AR SESSION COME UP — the swap grace, advanced AFTER the arm settles.
 *
 * ⚠ NEEDED SINCE 2026-09-03 AND THAT IS THE FIX, NOT A TEST WORKAROUND. The
 * grace used to be a one-shot timer keyed on the SURFACE's mount, so it had
 * always elapsed by the time the precondition read landed and `arArmed` turned
 * true — `<ARCameraView>` mounted on that same commit and `arLive` with it. It
 * is now keyed on `arArmed`, so the sequence is the one the constant was
 * written for: the arm resolves, then one grace passes, then ARKit is started,
 * then the recorder may arm against it. A test that skips this is asserting
 * about a session that has not been started yet.
 */
async function arGrace(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** Drain microtasks WITHOUT touching the clock — the only way to observe the
 *  commit between "the arm resolved" and "the grace elapsed". */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** Advance the overlay's 250 ms coaching poll and let its promise land. */
async function poll(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(300);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
  liveStatus = {};
  solveImpl = () => Promise.resolve(GOOD_SOLVE);
  saveImpl = () => Promise.resolve({ saved: true });
  snapshot = {
    haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis',
  };
  mockForceGestureRoute = false;
  // The surface asks `Platform.OS` ONCE, at render, through
  // `panoPlusArmContract` — flipping the shared mock before mounting is enough,
  // and no module has to be re-required.
  (Platform as { OS: string }).OS = 'ios';
});
afterEach(() => {
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  delete NM.RNISPanoPlus;
  delete NM.RNISPanoCalib;
});

describe('it comes up BY ITSELF, on the phone that needs it', () => {
  it('mounts the overlay and ARMS the recorder with no tap', async () => {
    // The operator's rule: "it should come up automatically and guide the user
    // to get the basis before they take their first pano+". Not a button, not
    // a menu — the first thing on screen.
    const r = mount();
    await settle();
    // The CARD is up the moment the read lands — nothing waits on ARKit to
    // tell the operator what is about to be asked of him.
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    // The RECORDER waits for the session it measures against. See `arGrace`.
    await arGrace();
    expect(calibCalls).toContain('startBasisCalibration');
    r.unmount();
  });

  it('does NOT come up on the AR arm — that arm reads no basis at all', async () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <PanoPlusCaptureSurface
          onComplete={() => undefined}
          onCancel={() => undefined}
          poseSource="ar"
        />,
      );
    });
    act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
    await settle();
    expect(renderer.root.findAllByProps({ testID: 'panoplus-basis-overlay' }))
      .toHaveLength(0);
    // The strongest form: the default arm does not even ASK the store.
    expect(calibCalls).toEqual([]);
    act(() => { renderer.unmount(); });
  });

  it('does NOT come up when a basis is already on file — "persist forever"', async () => {
    snapshot = {
      haveTau: false, haveBasis: true, complete: false, missing: 'tau',
      basisIndex: 8, basisLabel: '+y+z+x',
    };
    const r = mount();
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(calibCalls).not.toContain('startBasisCalibration');
    r.unmount();
  });

  it('SUPPRESSES the pan coach mark, which teaches the wrong motion', async () => {
    // `PanHowToOverlay` teaches a smooth one-axis sweep. A one-axis log leaves
    // FOUR mountings matching to floating-point dust, so showing both at once
    // would have the screen coaching the motion that guarantees the refusal.
    const r = mount();
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(r.has('pan-howto-overlay')).toBe(false);
    r.unmount();
  });
});

describe('the coaching, while the phone is moving', () => {
  it('a PAN-ONLY gesture is pushed toward the axis that breaks the tie', async () => {
    liveStatus = PAN_ONLY;
    const r = mount();
    await settle();
    await poll();
    expect(r.shows('NOD it up and down')).toBe(true);
    // And the meter for the axis that IS done reads done, so he can see the
    // one he has already satisfied and stop repeating it.
    expect(r.has('panoplus-basis-axis-pan')).toBe(true);
    expect(r.has('panoplus-basis-axis-tilt')).toBe(true);
    r.unmount();
  });

  it('a gesture with NO reference blames the AR session, not the hands', async () => {
    liveStatus = { ...PAN_ONLY, refSamples: 0, elapsedS: 5 };
    const r = mount();
    await settle();
    await poll();
    expect(r.shows('AR camera is not feeding')).toBe(true);
    r.unmount();
  });

  it('but NOT in the first seconds — a healthy session is not accused', async () => {
    // ARKit takes a beat to deliver its first `normal` pose and the coaching
    // poll lands 250 ms in. Without the grace, every operator who did nothing
    // wrong sees a hardware accusation on the one screen whose job is telling
    // him what IS wrong.
    liveStatus = { ...PAN_ONLY, refSamples: 0, elapsedS: 0.25 };
    const r = mount();
    await settle();
    await poll();
    expect(r.shows('AR camera is not feeding')).toBe(false);
    r.unmount();
  });
});

describe('the shutter does not sit live under the overlay', () => {
  it('is DISABLED while the basis is being measured, and a hold starts nothing', async () => {
    // The overlay's root is `box-none` and its scrim `pointerEvents="none"`, so
    // a live shutter underneath would still take the hold — and the sweep
    // would run while the basis recorder held an AR-thread plugin and a 200 Hz
    // CoreMotion stream, fitting C from a log recorded during a pan. Pano's
    // shutter has no "not rendered"; it has `disabled`, and `holdStart` refuses
    // on its own as well, because `CameraShutter` fires the RELEASE regardless
    // of `disabled` and the surface must not trust the button's gate alone.
    liveStatus = PAN_ONLY;
    const r = mount();
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(r.shutter().disabled).toBe(true);
    r.hold();
    await settle();
    expect(startCalls).toBe(0);
    // Skipping is the deliberate way out, and it gives the shutter back.
    r.tap('panoplus-basis-skip');
    await settle();
    expect(r.shutter().disabled).toBe(false);
    r.unmount();
  });
});

describe('a SUFFICIENT gesture solves, saves and gets out of the way', () => {
  it('solves with no button press — the METER is the trigger', async () => {
    // There is no Finish control on purpose: a button lets him press it early
    // and be refused for a gesture the screen had already called incomplete.
    liveStatus = SUFFICIENT;
    const r = mount();
    await settle();
    await poll();
    await settle();
    expect(calibCalls).toContain('stopBasisCalibration');
    expect(calibCalls).toContain('saveBasisCalibration');
    r.unmount();
  });

  it('RE-READS the store, so the arm recovers on the phone just calibrated', async () => {
    // THE DEFECT THIS PINS. The overlay writes through native; this component's
    // snapshot is a frozen copy of the moment before. Without the re-read the
    // arm stays fallen back to ARKit on the device that has just been
    // calibrated, and the only way out is leaving the mode and returning.
    // START PAN-ONLY. The arm effect polls ONCE immediately (blank meters read
    // as broken), so a rig that begins sufficient completes the whole
    // acquisition inside the first settle and leaves nothing for the poll below
    // to trigger — the gesture has to become sufficient while we are watching.
    liveStatus = PAN_ONLY;
    const r = mount();
    await settle();
    const before = calibCalls.filter((c) => c === 'getCalibration').length;
    liveStatus = SUFFICIENT;
    // The write lands: the store now answers with the basis.
    saveImpl = () => {
      snapshot = {
        haveTau: false, haveBasis: true, complete: false, missing: 'tau',
        basisIndex: 8, basisLabel: '+y+z+x',
      };
      return Promise.resolve({ saved: true });
    };
    await poll();
    // The chain is long and every link is a real promise: status → solve →
    // persistable gate → save → onAcquired → epoch → plannedCaptureFormat →
    // getCalibration. Settling once only reaches the middle of it.
    await settle();
    await settle();
    await settle();
    const after = calibCalls.filter((c) => c === 'getCalibration').length;
    expect(after).toBeGreaterThan(before);
    // …and the overlay is gone, because the route is now `stored`.
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    r.unmount();
  });
});

describe('a REFUSAL is never a measurement, and never persisted', () => {
  it('an UNSTABLE winner is refused and SAVES NOTHING', async () => {
    // `basis.ok` is true here — the fit passed. The winner moved under the
    // ±10 ms sweep, which is direct evidence the permutation is not identified
    // and which a single-τ margin structurally cannot see.
    liveStatus = SUFFICIENT;
    solveImpl = () => Promise.resolve(UNSTABLE_SOLVE);
    const r = mount();
    await settle();
    await poll();
    await settle();
    expect(calibCalls).toContain('stopBasisCalibration');
    expect(calibCalls).not.toContain('saveBasisCalibration');
    expect(r.shows('NOT GOOD ENOUGH')).toBe(true);
    // And the coaching NAMES the motion that fixes it rather than "try again".
    expect(r.shows('off-axis')).toBe(true);
    r.unmount();
  });

  it('keeps coaching — the overlay stays up and offers another go', async () => {
    liveStatus = SUFFICIENT;
    solveImpl = () => Promise.resolve(UNSTABLE_SOLVE);
    const r = mount();
    await settle();
    await poll();
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(r.has('panoplus-basis-retry')).toBe(true);
    const armsBefore = calibCalls.filter((c) => c === 'startBasisCalibration').length;
    r.tap('panoplus-basis-retry');
    await settle();
    // GOING AGAIN RE-RECORDS. `beginRecording` clears both buffers, so a fresh
    // start frees the refused log implicitly — and it must NOT be preceded by a
    // fire-and-forget `discard()`, whose `endRecording()` would land after the
    // new `start()` and empty the buffers of the gesture the operator is about
    // to perform. He would then be refused `too-few-samples` for a motion the
    // screen never recorded.
    const armsAfter = calibCalls.filter((c) => c === 'startBasisCalibration').length;
    expect(armsAfter).toBe(armsBefore + 1);
    const retryIdx = calibCalls.lastIndexOf('startBasisCalibration');
    expect(calibCalls.slice(retryIdx)).not.toContain('discardBasisCalibration');
    r.unmount();
  });

  it('a NATIVE store refusal is reported as a refusal, never as success', async () => {
    // The mirror (`basisIsPersistable`) accepted and the store said no. Native
    // wins; the mirror is then the bug, and the screen must say so rather than
    // claiming a basis nothing wrote.
    liveStatus = SUFFICIENT;
    saveImpl = () => Promise.reject(new Error('calibration-not-persistable'));
    const r = mount();
    await settle();
    await poll();
    await settle();
    expect(r.shows('NOT GOOD ENOUGH')).toBe(true);
    expect(r.shows('store refused it')).toBe(true);
    r.unmount();
  });
});

describe('the dead end still leaves him able to capture', () => {
  it('SKIP drops the overlay and leaves the ARKit fallback standing', async () => {
    const r = mount();
    await settle();
    r.tap('panoplus-basis-skip');
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    // The arm notice still names the state that makes the sweep run on ARKit,
    // which is the whole no-silent-degradation rule — and the AR pill (see the
    // poseSource suite) draws ON for the same reason.
    expect(r.shows('THE τ = 0 EXPERIMENT STILL NEEDS THE BASIS')).toBe(true);
    expect(r.shutter().disabled).toBe(false);
    r.unmount();
  });

  it('a phone with NO ULTRA-WIDE is never offered the gesture at all', async () => {
    (NM.RNISPanoCalib as Record<string, unknown>).plannedCaptureFormat =
      () => Promise.resolve({
        ok: false,
        reason: 'panoplus-no-ultrawide',
        detail: 'This body publishes no physical ultra-wide camera.',
      });
    const r = mount();
    await settle();
    // Sending him to perform a calibration that cannot fix a hardware fault is
    // work with no possible outcome.
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(calibCalls).not.toContain('startBasisCalibration');
    expect(r.shows('NO PHYSICAL ULTRA-WIDE')).toBe(true);
    r.unmount();
  });
});

describe('the recorder never outlives the overlay', () => {
  it('unmounting mid-gesture DISCARDS — no plugin left on the AR thread', async () => {
    // `startBasisCalibration` registers a plugin on the ARKit delegate thread
    // AND starts a 200 Hz CoreMotion stream. A surface torn down mid-gesture
    // (a mode switch, a host navigation) that left either running would cost
    // the rest of the process, on a device nobody can attach a debugger to.
    liveStatus = PAN_ONLY;
    const r = mount();
    await settle();
    await poll();
    expect(calibCalls).toContain('startBasisCalibration');
    r.unmount();
    await settle();
    expect(calibCalls).toContain('discardBasisCalibration');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE GATE ITSELF — the four properties the operator's rule reduces to
// ═══════════════════════════════════════════════════════════════════════════
//
// His rule, in his words: "it should come up automatically and guide the user
// to get the basis before they take their first pano+, and if it is not needed,
// it is not needed anyway" — plus "save this basis and persist forever".
//
// That is four claims, and until 2026-09-03 exactly one of them was pinned
// here. The sections below pin all four, and add the one the gate could not
// have satisfied by accident: that the overlay is never shown where it could
// not COMPLETE.
//
// ⚠ WHAT NONE OF THIS PROVES. Every assertion is JS. The gesture needs the
// operator's hands and a live ARKit session; no device has ever completed the
// in-camera acquisition (no pack in the corpus carries `acquiredVia:
// 'in-camera-first-run'`), and nothing below changes that.

describe('(a) fresh device, basis genuinely needed — it is there FIRST', () => {
  it('is up, REACHABLE, and standing between him and the shutter', async () => {
    // "before they take their first pano+" is not satisfied by a visible
    // overlay: the shutter underneath must also refuse, and the overlay must be
    // touchable. `has()` proves neither — see `blockers`.
    const r = mount();
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    // A finger can reach it. The scrim is `pointerEvents="none"` on purpose;
    // an ancestor `none` over the SKIP control would be a dead end with no way
    // out but killing the app.
    expect(r.blockers('panoplus-basis-skip')).not.toContain('none');
    // …and nothing has been captured, nor can be.
    expect(startCalls).toBe(0);
    expect(r.shutter().disabled).toBe(true);
    r.unmount();
  });
});

describe('(b) acquired once — never asked again, ACROSS A REMOUNT', () => {
  it('the STORE carries the answer, not this component’s latch', async () => {
    // "save this basis and persist forever". `basisAcquired` is per-mount React
    // state and would be lost the moment he leaves pano+ and comes back — so a
    // test that only re-checks the live surface proves the latch, not the
    // persistence. This one throws the component away and mounts a fresh one
    // against the store the acquisition wrote.
    liveStatus = PAN_ONLY;
    const r = mount();
    await settle();
    liveStatus = SUFFICIENT;
    saveImpl = () => {
      snapshot = {
        haveTau: false, haveBasis: true, complete: false, missing: 'tau',
        basisIndex: 8, basisLabel: '+y+z+x',
      };
      return Promise.resolve({ saved: true });
    };
    await poll();
    await settle();
    await settle();
    await settle();
    expect(calibCalls).toContain('saveBasisCalibration');
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    r.unmount();
    await settle();

    // A COMPLETELY FRESH SURFACE, the way re-entering the mode gives him one.
    const armsBefore = calibCalls.filter((c) => c === 'startBasisCalibration').length;
    const r2 = mount();
    await settle();
    expect(r2.has('panoplus-basis-overlay')).toBe(false);
    const armsAfter = calibCalls.filter((c) => c === 'startBasisCalibration').length;
    expect(armsAfter).toBe(armsBefore);
    // And he can capture immediately — the point of never asking again.
    expect(r2.shutter().disabled).toBe(false);
    r2.unmount();
  });
});

describe('(c) a basis that is NOT needed is never asked for', () => {
  it('ARKit arm: no overlay, and the store is not even consulted', async () => {
    // C maps the CoreMotion frame onto the camera raster. An arm whose pose
    // already arrives in the camera frame has nothing to map, so this is the
    // requirement being absent — not the arm standing in as a proxy for it.
    const r = mountWith({ poseSource: 'ar' });
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(calibCalls).toEqual([]);
    expect(r.shutter().disabled).toBe(false);
    r.unmount();
  });

  it('ANDROID derives C analytically — the gesture would be busywork', async () => {
    // `panoPlusBasisCapability('android')`: SENSOR_ORIENTATION pins the camera
    // raster to a documented sensor frame, so C is the product of two
    // documented rotations and no hands are needed. The pack says `derived`.
    (Platform as { OS: string }).OS = 'android';
    const r = mountWith({ poseSource: 'imu' });
    await settle();
    // The surface is LIVE, not sitting behind the unavailable card — otherwise
    // "no overlay" would be true for the wrong reason.
    expect(r.has('panoplus-unavailable')).toBe(false);
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(calibCalls).not.toContain('startBasisCalibration');
    r.unmount();
  });

  it('and even if the LADDER demanded one there, Android REFUSES to show it', async () => {
    // THE GUARD, AND THE ONLY WAY TO REACH IT. `arArmed` is hard-`false` on the
    // Android contract by construction — mounting a second ARCore client would
    // take the one back camera from the arm that needs it — so `arLive` can
    // never be true and the overlay's arm effect would never run: a spinner on
    // `arming`, for the life of the surface, coaching nothing. `panoCalibNative`
    // is null there too, so even a forced start rejects `calib-unavailable`.
    //
    // Today the real ladder never asks. This forces it to, which is exactly the
    // future edit the guard exists for.
    mockForceGestureRoute = true;
    (Platform as { OS: string }).OS = 'android';
    const r = mountWith({ poseSource: 'imu' });
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    // …and the shutter is NOT taken away by an overlay that cannot help him.
    expect(r.shutter().disabled).toBe(false);
    r.unmount();
  });

  it('the guard is SCOPED — the same forced route still shows on iOS', async () => {
    // Without this, `armCanAcquireBasis` could be silently inverted (or the
    // contract string mistyped) and the Android case above would still pass
    // while the feature was dead on the one platform that has it.
    mockForceGestureRoute = true;
    const r = mountWith({ poseSource: 'imu' });
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    r.unmount();
  });
});

describe('(d) tapping 0.5× moves him to the decoupled arm — and lands here', () => {
  it('reaches the overlay, before any capture, on a phone that needs a basis', async () => {
    // The rule landed 2026-09-03: the lens chip is always up and picking 0.5×
    // drops out of AR, exactly as in Pano. That makes the chip a SECOND door
    // onto the arm that consumes C — and on a phone with none on file it is the
    // first time the operator ever meets this overlay. The route is one day old
    // and nothing covered it.
    const r = mountHost('wide', 'ar');
    await settle();
    // Starting state: AR arm, so no overlay and the store untouched.
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(calibCalls).toEqual([]);

    r.tap('panoplus-lens-chip-0_5x');
    await settle();

    // The tap moved the arm, the arm asked the store, the store had nothing.
    expect(calibCalls).toContain('getCalibration');
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(r.blockers('panoplus-basis-skip')).not.toContain('none');
    // BEFORE any capture — the whole point of "before their first pano+".
    expect(startCalls).toBe(0);
    // …and the overlay it lands on is a LIVE one, not a spinner: once the AR
    // session it measures against is up, the recorder arms. A gate that reached
    // a permanently-arming overlay would be a worse bug than the closed door.
    //
    // ⚠ THIS ROUTE RESTARTS ARKit, AND THAT USED TO BE INVISIBLE HERE. The tap
    // dips `arArmed` — `poseSource` flips to `'imu'` while `calibRead` is still
    // true, the read effect then clears `calibRead`, and the arm notice's
    // fallback brings it back — so `<ARCameraView>` UNMOUNTS and REMOUNTS, and
    // remounting it IS `RNSARSession.shared.start()`. While `arReady` was a
    // one-shot latch keyed on SURFACE mount it did not re-arm for that new
    // session, so `arLive` stayed true across the restart and the recorder
    // armed against a session microseconds old — the state `arLive`'s own doc
    // comment forbids. It is keyed on `arArmed` now, and the grace below is
    // what proves it: without the fix this arms one commit earlier, which is
    // what the sibling test in "the ARKit session … is actually UP" pins.
    await arGrace();
    expect(calibCalls).toContain('startBasisCalibration');
    expect(r.shutter().disabled).toBe(true);
    r.unmount();
  });

  it('so does turning the AR pill OFF — the other door onto the same arm', async () => {
    const r = mountHost('wide', 'ar');
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    r.tap('panoplus-ar-pill');
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(startCalls).toBe(0);
    r.unmount();
  });

  it('but a CALIBRATED phone taking the same tap is never interrupted', async () => {
    // The mirror of (b) on this route: the door is new, the persistence rule is
    // not, and a phone with C on file must cross it without seeing anything.
    snapshot = {
      haveTau: false, haveBasis: true, complete: false, missing: 'tau',
      basisIndex: 8, basisLabel: '+y+z+x',
    };
    const r = mountHost('wide', 'ar');
    await settle();
    r.tap('panoplus-lens-chip-0_5x');
    await settle();
    expect(calibCalls).toContain('getCalibration');
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(calibCalls).not.toContain('startBasisCalibration');
    expect(r.shutter().disabled).toBe(false);
    r.unmount();
  });
});

// ════════════════════════════════════════════════════════════════════════
//  THE GATE IS NOT THE WHOLE FEATURE — three defects BEHIND it
// ════════════════════════════════════════════════════════════════════════
//
// Everything above proves the overlay APPEARS when it should. These prove it
// can still be reached, and still complete, once it has. Each was written to
// FAIL against the code as it stood on 2026-09-03 and is quoted with the
// failure it produced, so a later reader can tell a regression test from a
// tautology.

describe('the ARKit session the measurement reads is actually UP', () => {
  it('re-arms the swap grace when <ARCameraView> REMOUNTS on the 0.5× door', async () => {
    // ⚠ THIS IS THE CASE THE (d) TEST ABOVE DECLARED UNTESTABLE. It is not:
    // the mount/unmount of `<ARCameraView>` is a React fact and the jest mock
    // renders it as `ar-camera`, so the session restart is visible from here.
    // Only the native warm-up time is unobservable, and that is not what is
    // being asserted.
    //
    // The mechanism: the tap flips `poseSource` to `'imu'` while `calibRead`
    // is still true, so `arArmed` goes false and React unmounts the AR view —
    // and unmounting it IS `RNSARSession.shared.stop()`. The read then lands,
    // the notice falls back to ARKit, and the view remounts, which IS
    // `start()`. `arReady` used to be a one-shot timer keyed on the SURFACE's
    // mount, so it stayed true across that restart and `arLive` claimed a live
    // reference for a session that was microseconds old — the exact state
    // `PanoPlusBasisOverlayProps.arLive` forbids in its own doc comment.
    const r = mountHost('wide', 'ar');
    await settle();
    await arGrace();
    expect(r.has('ar-camera')).toBe(true);

    r.tap('panoplus-lens-chip-0_5x');
    // The commit the tap produced, BEFORE the read lands: the session is down.
    // This is `RNSARSession.shared.stop()` having been called.
    expect(r.has('ar-camera')).toBe(false);

    // The read lands and the notice falls back, so the surface wants ARKit
    // again — but it must NOT be standing it back up on the same commit it
    // tore it down, and the recorder must not be armed against a session that
    // does not exist. Both of these FAILED before the grace was re-keyed.
    await flush();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(r.has('ar-camera')).toBe(false);
    expect(calibCalls).not.toContain('startBasisCalibration');

    // One grace later the session is up, and only then does the recorder arm.
    await arGrace();
    expect(r.has('ar-camera')).toBe(true);
    expect(calibCalls).toContain('startBasisCalibration');
    r.unmount();
  });
});

describe('nothing on screen can destroy the measurement in progress', () => {
  it('hides the AR pill and the lens chip while the gesture is live', async () => {
    // Both write host flags that feed the precondition read, and the overlay is
    // mounted on that read's result — so either tap unmounts the overlay
    // mid-recording and its teardown discards the log, with no message. The AR
    // pill was the worse of the two: reached through the 0.5× door it paints
    // `AR mode ON` (the notice has fallen back), i.e. it is LABELLED with the
    // arm the operator is trying to leave, and one tap on it reset his gesture.
    const r = mountHost('wide', 'ar');
    await settle();
    // Both controls are up on the AR arm, per the 2026-09-03 chrome rule.
    expect(r.has('panoplus-ar-pill')).toBe(true);
    expect(r.has('panoplus-lens-chip')).toBe(true);

    r.tap('panoplus-lens-chip-0_5x');
    await settle();
    await arGrace();
    expect(r.has('panoplus-basis-overlay')).toBe(true);

    // Neither flag-writer is on screen while the measurement is.
    expect(r.has('panoplus-ar-pill')).toBe(false);
    expect(r.has('panoplus-lens-chip')).toBe(false);
    // The way out is the overlay's OWN control, which is still reachable.
    expect(r.blockers('panoplus-basis-skip')).not.toContain('none');

    // …and taking it gives both controls straight back — nothing is lost, the
    // suppression lasts exactly as long as the card does.
    r.tap('panoplus-basis-skip');
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(r.has('panoplus-lens-chip')).toBe(true);
    r.unmount();
  });

  it('survives a tap on EVERY control the surface still offers', async () => {
    // The end-to-end statement of the defect, and deliberately not a list of
    // the two controls that were wrong: it presses whatever is on screen. That
    // is the version that would have caught this originally — the overlay was
    // reviewed and the chrome around it was not, so an assertion naming the
    // chrome could only have been written by someone who already knew.
    //
    // Measured before the fix, on a gesture already coaching "MOVE IT ON MORE
    // THAN ONE AXIS": one tap on `panoplus-ar-pill` → `discardBasisCalibration`
    // 0→1, `startBasisCalibration` 1→2, headline reset. The operator's partial
    // gesture, thrown away with no message.
    liveStatus = PAN_ONLY;
    const r = mountHost('wide', 'ar');
    await settle();
    r.tap('panoplus-lens-chip-0_5x');
    await settle();
    await arGrace();
    await poll();
    expect(calibCalls.filter((c) => c === 'startBasisCalibration')).toHaveLength(1);
    // It IS coaching — a recorder that never armed would pass the rest of this
    // test vacuously.
    expect(r.shows('MORE THAN ONE AXIS')).toBe(true);

    // Everything a finger can reach, pressed. The overlay's own controls are
    // excluded: SKIP is SUPPOSED to end the measurement, and asserting it does
    // not would be pinning the opposite of the feature.
    const reachable = r.pressables()
      .filter((id) => !id.startsWith('panoplus-basis-'));
    for (const id of reachable) {
      r.tap(id);
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }

    // Same recorder, never discarded, still coaching the same gesture.
    expect(calibCalls).not.toContain('discardBasisCalibration');
    expect(calibCalls.filter((c) => c === 'startBasisCalibration')).toHaveLength(1);
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    r.unmount();
  });
});

describe('the arm the surface never asked is not reported as a broken build', () => {
  it('reports no basis route at all on the AR arm, rather than a missing pod', async () => {
    // On `poseSource: 'ar'` the precondition effect early-returns, so `plan`
    // stays null for the life of the mount — and a null plan takes the
    // ladder's BUILD rung, which answers `no-calibration-module`: "This binary
    // carries no calibration module." On a build carrying the pod perfectly
    // well. Nothing consumes `basisRoute` outside tests today, which is the
    // only reason this has cost nothing yet; the failure mode when something
    // does is a diagnostic sending its reader to rebuild the wrong artefact.
    const seen: string[] = [];
    act(() => {
      TestRenderer.create(
        <PanoPlusCaptureSurface
          onComplete={() => undefined}
          onCancel={() => undefined}
          poseSource="ar"
          onEffectiveArmChange={(a) => { seen.push(a.basisRoute); }}
        />,
      );
    });
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('blocked');
    expect(seen.every((r) => r === 'not-asked')).toBe(true);
  });

  it('still reports the REAL build fault on the arm that does ask', async () => {
    // The scoping assertion: `not-asked` must not become a way to stop
    // reporting a genuinely missing pod. On the IMU arm the read runs, and a
    // rejecting module is still `blocked`.
    (NM.RNISPanoCalib as { plannedCaptureFormat: () => Promise<unknown> })
      .plannedCaptureFormat = () => Promise.reject(new Error('no module'));
    const seen: string[] = [];
    act(() => {
      TestRenderer.create(
        <PanoPlusCaptureSurface
          onComplete={() => undefined}
          onCancel={() => undefined}
          poseSource="imu"
          onEffectiveArmChange={(a) => { seen.push(a.basisRoute); }}
        />,
      );
    });
    await settle();
    expect(seen).toContain('blocked');
  });
});

describe('the arm term is load-bearing, and this is what breaks if it goes', () => {
  it('hides the overlay again when the host moves the arm BACK to ARKit', async () => {
    // ⚠ WRITTEN AGAINST A MUTANT. Replacing `armWantsBasis = poseSource ===
    // 'imu'` with `true` — the exact edit the brief forbids — passed all 4094
    // other tests in this SDK. The term is genuinely load-bearing and was
    // pinned by nothing, so `(c)` above was passing for the wrong reason: it
    // only ever mounted AT `'ar'`, where the read never runs and the ladder
    // answers from a null plan.
    //
    // The return leg is what separates them: the read effect early-returns on
    // `poseSource !== 'imu'` WITHOUT clearing `calibRead`, so on the way back
    // every other term in the gate is still satisfied and only this one says
    // no.
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <PanoPlusCaptureSurface
          onComplete={() => undefined}
          onCancel={() => undefined}
          poseSource="imu"
        />,
      );
    });
    act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
    await settle();
    const r = makeRig(renderer);
    expect(r.has('panoplus-basis-overlay')).toBe(true);

    act(() => {
      renderer.update(
        <PanoPlusCaptureSurface
          onComplete={() => undefined}
          onCancel={() => undefined}
          poseSource="ar"
        />,
      );
    });
    await settle();
    // An arm whose pose arrives in the camera frame has nothing to map, so
    // there is nothing to measure and the card must go.
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    r.unmount();
  });
});

// ── THE HOST MUST BE TOLD TO GET ITS CHROME OFF THIS SCREEN ────────────────
//
// ⚠ THE BLOCKER'S PRODUCER LINE HAD NO TEST. `<Camera>`'s shared AR pill and
// lens chip are rendered AFTER the surface — on top of it — with `box-none`
// ancestors, so while this overlay is up they sat LIVE over the calibration
// card, and one tap of the AR pill moved the arm to ARKit, made
// `armWantsBasis` false and unmounted the card. The measurement is once per
// phone.
//
// 7252d78 fixed it by REPORTING `chromeSuppressed` and gating the host chrome
// on it. The case that shipped with that fix hand-calls
// `onEffectiveArmChange` from the `<Camera>` harness, so it pins the CONSUMER
// and says nothing about this surface ever setting the flag: hard-coding
// `chromeSuppressed: false` left 64 suites / 1267 cases green.
//
// This file is where the real ladder reaches the overlay — the `<Camera>`
// harness installs no native fakes, so the surface early-returns its
// `panoplus-unavailable` card there and `basisGestureVisible` is
// structurally false. The producer belongs here.
describe('the surface reports chromeSuppressed while it owns the screen', () => {
  it('⚑ true while the basis card is up, false once it is gone', async () => {
    liveStatus = PAN_ONLY;
    const reports: boolean[] = [];
    const r = mountWith({
      onEffectiveArmChange: (arm) => { reports.push(arm.chromeSuppressed); },
    });
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(reports[reports.length - 1]).toBe(true);

    // SKIP is the documented way out, and the host's chrome must come back
    // with it — a flag that only ever latches ON is the mirror defect and
    // would be just as invisible.
    r.tap('panoplus-basis-skip');
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    expect(reports[reports.length - 1]).toBe(false);
    r.unmount();
  });
});

