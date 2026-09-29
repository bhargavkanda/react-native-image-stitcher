// SPDX-License-Identifier: Apache-2.0
//
// THE POSE-SOURCE WIRING, MOUNTED FOR REAL.
//
// ── The gap this closes ───────────────────────────────────────────────────
//
// `panoPlusArmNotice` is unit-tested to death next door, and none of that
// proves the ENGINE asks the store, feeds the notice the answer, or — the one
// that actually costs a field trip — puts the right `poseSource` in the bag
// that crosses the bridge. That is exactly the class of bug this project
// exists for: on 2026-07-22 the maths under two HUD failures was correct and
// the WIRING was not, and the suite that could have caught it said "the
// surface glue is exercised on-device". On-device meant in a store, by the
// operator.
//
// The property under test throughout is: WHAT CROSSES THE BRIDGE MATCHES WHAT
// THE SCREEN SAID. A silent downgrade here would hand back an ordinary-looking
// pack the operator believes came off the decoupled arm, and nothing in the
// pixels would contradict him.
//
// ── M10 ────────────────────────────────────────────────────────────────────
//
// The sweep's own screen (`PanoPlusCaptureSurface`) is deleted, and with it
// its shutter, its AR pill and its lens chip. The engine is mounted here
// through `SweepEngineHarness` — the real `useSweepEngine`, drawn by the DR-1a
// hatch view — and driven the way `<Camera>` drives it:
//
//   · a HOLD is the handle's `holdStart` / `holdEnd` (what `<Camera>`'s
//     shutter calls);
//   · what the old shutter PAINTED (`disabled` / busy) is now only what the
//     engine REPORTS through `onControlsState`. `<Camera>` reads `busy` from
//     that report and nothing else: its shutter does not grey on
//     `canCapture`, so a hold the engine cannot take is refused by name
//     (`panoplus-not-ready` / `panoplus-unavailable`) on `onFailure`;
//   · an arm or lens change is a re-render with new props — what the deleted
//     pill and chip used to write through their host (see the lens-rule and
//     basis-ladder suites; nothing in this file needs one).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NativeModules } from 'react-native';

// The sidecars this engine writes are OBSERVABLE here, because since
// 2026-09-07 the τ = 0 banner is written to the pack and NOT drawn on screen —
// and a test that only asserted its absence from the tree would pass just as
// well if the fact had been deleted outright.
const written: Array<{ uri: string; body: string }> = [];
jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///var/mobile/Documents/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: (uri: string, body: string) => {
      (globalThis as unknown as { __ppPoseWritten: Array<unknown> })
        .__ppPoseWritten.push({ uri, body });
      return Promise.resolve();
    },
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);
(globalThis as unknown as { __ppPoseWritten: unknown[] }).__ppPoseWritten = written;

import { SweepEngineHarness } from './sweepEngineHarness';
import { ARCameraView } from '../../camera/ARCameraView';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';
import type { SweepEngineProps } from '../sweepEngineProps';
import type {
  PanoPlusEngineOptions,
  PanoPlusFailure,
  PanoPlusPoseSource,
  SweepSurfaceHandle,
  SweepSurfaceState,
} from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** The options bag the last `start()` received — the thing that matters. */
let startedWith: Record<string, unknown> | null = null;
/** How many times native `start()` was called at all. */
let startCalls = 0;
/** What the fake bridge answers for `poseSource`, so the "native disagrees with
 *  the request" case is reachable. */
let startAnswers: Record<string, unknown> = {};
/** Calls to the CALIBRATION module, so "the ARKit arm asks nothing" is a
 *  checked fact and not an inspection of the source. */
let calibCalls: string[] = [];
/** The DEFAULTS, restored in `beforeEach`. They were module-level `let`s that
 *  nothing reset, so a test that reassigned one leaked it into every test that
 *  ran after it — order-dependence in a suite whose whole subject is which arm
 *  a sweep ends up on. */
const DEFAULT_PLANNED: () => Promise<unknown> = () => Promise.resolve({
  ok: true,
  lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
  width: 1920,
  height: 1440,
  fps: 60,
  tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
  basisKey: 'iPhone17,1',
});
const DEFAULT_SNAPSHOT: () => Promise<unknown> = () => Promise.resolve({
  resolved: { haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis' },
});
let plannedImpl: () => Promise<unknown> = DEFAULT_PLANNED;
let snapshotImpl: () => Promise<unknown> = DEFAULT_SNAPSHOT;

function installNative(): void {
  startedWith = null;
  startCalls = 0;
  calibCalls = [];
  startAnswers = {};
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      startCalls += 1;
      return Promise.resolve({
        sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true, ...startAnswers,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: false }),
  };
  NM.RNSSweepCalibration = {
    startBasisCalibration: () => Promise.resolve({}),
    basisCalibrationStatus: () => Promise.resolve({}),
    stopBasisCalibration: () => Promise.resolve({}),
    resolveBasisCalibration: () => Promise.resolve({}),
    discardBasisCalibration: () => Promise.resolve({}),
    combineTauRuns: () => Promise.resolve({}),
    saveTauCalibration: () => Promise.resolve({}),
    saveBasisCalibration: () => Promise.resolve({}),
    clearCalibration: () => Promise.resolve({}),
    plannedCaptureFormat: () => {
      calibCalls.push('plannedCaptureFormat');
      return plannedImpl();
    },
    getCalibration: (o: Record<string, unknown>) => {
      calibCalls.push(`getCalibration:${JSON.stringify(o)}`);
      return snapshotImpl();
    },
  };
}

type Props = Partial<SweepEngineProps>;

interface Rig {
  texts: () => string[];
  shows: (needle: string) => boolean;
  tap: (testID: string) => void;
  has: (testID: string) => boolean;
  count: (testID: string) => number;
  root: () => ReactTestInstance;
  /**
   * Is `<ARCameraView>` mounted — i.e. is this engine starting ARKit?
   *
   * BY COMPONENT: `SweepHatchScreen` imports `../camera/ARCameraView` by
   * module path and the render project stands nothing in for it, so the REAL
   * view mounts under the harness. The mount is the side effect.
   */
  arView: () => boolean;
  /** What `<Camera>`'s shutter calls on a hold past the threshold. */
  hold: () => void;
  /** …and on the release that follows — the sweep finishes, pack kept. */
  release: () => void;
  /** The LAST `onControlsState` report — the engine's own statement of
   *  whether it can take a hold (`canCapture`) and whether it is finishing
   *  (`busy`). `<Camera>`'s shutter paints `busy` only. */
  controls: () => SweepSurfaceState | undefined;
  /** Every `onFailure` the engine raised, in order. */
  failures: PanoPlusFailure[];
  unmount: () => void;
}

const BASE: SweepEngineProps = {
  onComplete: () => undefined,
  onCancel: () => undefined,
};

function mount(props: Props = {}): Rig {
  const handle = React.createRef<SweepSurfaceHandle>();
  const reports: SweepSurfaceState[] = [];
  const failures: PanoPlusFailure[] = [];
  const element = (p: Props): React.JSX.Element => (
    <SweepEngineHarness
      ref={handle}
      {...BASE}
      onControlsState={(s) => { reports.push(s); }}
      onFailure={(f) => { failures.push(f); }}
      {...p}
    />
  );
  let renderer!: ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(element(props)); });
  act(() => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
  });
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
    texts: collect,
    shows: (needle) => collect().some((t) => t.includes(needle)),
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    count: (testID) => renderer.root.findAllByProps({ testID }).length,
    root: () => renderer.root,
    arView: () => renderer.root.findAll(
      (n) => n.type === ARCameraView,
    ).length > 0,
    tap: (testID) => {
      const node = renderer.root.findAllByProps({ testID })[0];
      const onPress = node?.props?.onPress as (() => void) | undefined;
      if (onPress == null) throw new Error(`no onPress on ${testID}`);
      act(() => { onPress(); });
    },
    hold: () => { act(() => { handle.current?.holdStart?.(); }); },
    release: () => { act(() => { handle.current?.holdEnd?.(); }); },
    controls: () => reports[reports.length - 1],
    failures,
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The report of an engine that can take a hold and is not finishing (the
 *  old screen painted it as `{ disabled: false, busy: false }`). */
const READY: SweepSurfaceState = { canCapture: true, canFinalize: false, busy: false };

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
  plannedImpl = DEFAULT_PLANNED;
  snapshotImpl = DEFAULT_SNAPSHOT;
  written.length = 0;
});
afterEach(() => {
  jest.useRealTimers();
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

describe('the ARKit arm is the default and is UNTOUCHED', () => {
  it('makes NO calibration call at all', async () => {
    const r = mount();
    await settle();
    // The strongest form of "the default path is unchanged": not "it renders
    // the same", but "it does not even ask". A native call on the default arm
    // is a per-mount cost and a new failure mode for the path that carries the
    // entire programme.
    expect(calibCalls).toEqual([]);
    expect(r.has('panoplus-arm-headline')).toBe(false);
    // The engine reports it can take a hold.
    expect(r.controls()).toEqual(READY);
    r.unmount();
  });

  it('sends poseSource: "ar" and never blocks on a precondition read', async () => {
    const r = mount({ poseSource: 'ar' });
    // M10 — converted from "no `panoplus-arm-checking` spinner", a testID the
    // screen had already stopped rendering (so the line could not fail). The
    // same claim, reported: the ARKit arm has nothing to wait for, so it is
    // capturable on the FIRST commit, before any read could have landed.
    expect(r.controls()?.canCapture).toBe(true);
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE HANDOFF — the P0 the adversarial review found (2026-08-31)
//
//  Mounting `<ARCameraView>` IS what starts ARKit
//  (`RNSARCameraView.didMoveToWindow` → `RNSARSession.shared.start()`), and it
//  was rendered in the single main return on EVERY phase and on BOTH arms:
//  `arReady` was a bare swap-grace timer with no dependency on `poseSource`.
//  So a decoupled sweep mounted ARKit, waited 250 ms for it to take the camera,
//  and then asked AVFoundation for the same body — which ARKit and an
//  AVCaptureSession cannot share.
//
//  This is asserted on the MOUNT, not on the source, because the mount is the
//  side effect. `arView()` (see the rig): present ⇒ ARKit is being
//  started.
// ═══════════════════════════════════════════════════════════════════════════

describe('ARKit and the decoupled arm never hold the camera at once', () => {
  it('mounts the AR view on the DEFAULT arm, exactly as it shipped', async () => {
    const r = mount();
    await settle();
    expect(r.arView()).toBe(true);
    expect(r.has('panoplus-camera-off')).toBe(false);
    r.unmount();
  });

  it('does NOT mount the AR view once the IMU arm is confirmed usable', async () => {
    plannedImpl = () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: -0.0042, tauStdErrMs: 0.31, basisIndex: 5, basisLabel: '+y+z+x',
      },
    });
    const r = mount({ poseSource: 'imu' });
    await settle();
    expect(r.arView()).toBe(false);
    // …and it SAYS why, rather than leaving a black screen that reads as a
    // broken camera. The operator aims by the panorama band on this arm.
    expect(r.has('panoplus-camera-off')).toBe(true);
    // ⚠ THIS ASSERTED `'ARKit is DOWN by design'` UNTIL 2026-09-03, AND THE
    // SENTENCE IT PINNED IS THE ONE THAT LATER SHIPPED A LIE ON ANDROID.
    // The old copy explained a black screen by asserting what an AR SESSION
    // was doing, chosen from the ARM the surface believed it was on. Its
    // Android sibling said "ARCore is UP, inside the sweep's own camera
    // session" — at idle, on a phone where ARCore was down and nothing held
    // the camera at all. An arm is not a state.
    //
    // The notice is now derived from who owns the camera in THIS phase and
    // prefers native's own reason (`panoPlusCameraOffNotice`). Under Jest
    // neither platform's viewfinder component resolves, so the true answer
    // here is that this build has none — and the reassurance the operator
    // actually needs, that the sweep still records, survives.
    expect(r.shows('No viewfinder in this build')).toBe(true);
    expect(r.shows('still records')).toBe(true);
    // No claim about ARKit's state, in either direction.
    expect(r.texts().some((t) => t.includes('ARKit'))).toBe(false);
    r.unmount();
  });

  it('does not start ARKit while the precondition read is still in flight', () => {
    // A read that resolves to "calibrated" would have to tear ARKit straight
    // back down; a read that resolves to a fallback mounts it the moment the
    // answer lands. Starting it speculatively costs an `arSession.run`
    // teardown for nothing.
    plannedImpl = () => new Promise(() => undefined);   // never settles
    snapshotImpl = () => new Promise(() => undefined);
    const r = mount({ poseSource: 'imu' });
    expect(r.arView()).toBe(false);
    r.unmount();
  });

  it('DOES mount the AR view when the IMU arm falls back to ARKit', async () => {
    // The fallback sweep really does run on ARKit, so it really does need the
    // AR view. Gating the mount on the REQUEST rather than on the effective arm
    // would have produced a fallback that could never see a frame.
    plannedImpl = () => Promise.resolve({
      ok: false, reason: 'panoplus-no-ultrawide',
      detail: 'This device publishes no builtInUltraWideCamera.',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: { haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis' },
    });
    const r = mount({ poseSource: 'imu' });
    await settle();
    // ⚠ THE GRACE IS ADVANCED AFTER THE ARM RESOLVES, NOT BEFORE (2026-09-03).
    // `arReady` used to be a one-shot timer keyed on the mount, so it had
    // always elapsed by the time the fallback turned `arArmed` true and the
    // view appeared on that same commit. It is keyed on `arArmed` now —
    // because that flag moves under a mounted engine (an arm or lens change
    // from the host), and remounting `<ARCameraView>` IS
    // `RNSARSession.shared.start()`, so a restart with the grace already spent
    // raced the engine's own `stop()`. The view still mounts on the fallback,
    // which is what this test is about; it mounts one grace later.
    await act(async () => {
      jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(r.arView()).toBe(true);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE ACCELERATION CAGE IS REACHABLE, AND UNCAGED IS THE DEFAULT
// ═══════════════════════════════════════════════════════════════════════════

describe('the lurch cage knob', () => {
  const calibrated = (): void => {
    plannedImpl = () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: -0.0042, tauStdErrMs: 0.31, basisIndex: 5, basisLabel: '+y+z+x',
      },
    });
  };

  it('sends NO threshold by default, so the pack records an UNCAGED sweep', async () => {
    calibrated();
    const r = mount({ poseSource: 'imu' });
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');
    // Absent, not zero. Native reads a missing key and a 0 identically, but the
    // absence is what says "no host asked for a cage" rather than "a host asked
    // for a cage of zero".
    expect('lurchAccelMps2' in (startedWith ?? {})).toBe(false);
    r.unmount();
  });

  it('crosses the bridge when a host asks for one', async () => {
    calibrated();
    const r = mount({ poseSource: 'imu', lurchAccelMps2: 25 });
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.lurchAccelMps2).toBe(25);
    r.unmount();
  });

  it('is NOT sent on a sweep that fell back to ARKit', async () => {
    // The cage only exists on the arm whose pose-side cage is inert. Sending it
    // on the ARKit arm would put a knob in the pack that describes nothing.
    plannedImpl = () => Promise.resolve({
      ok: false, reason: 'panoplus-no-ultrawide', detail: 'no ultra-wide',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: { haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis' },
    });
    const r = mount({ poseSource: 'imu', lurchAccelMps2: 25 });
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');
    expect('lurchAccelMps2' in (startedWith ?? {})).toBe(false);
    r.unmount();
  });
});

describe('the IMU arm reads the store BEFORE it can capture', () => {
  it('looks the calibration up under the PLANNED FORMAT, not a default key', async () => {
    // THE DEFECT THIS PINS. tau is keyed `model|lens|WxH|fps` because the
    // rolling-shutter constant is part of it, and the format is chosen by the
    // AVF source — not by the host. A lookup at the host's own `0x0` default
    // finds nothing while the store holds the record, and the arm then refuses
    // for a calibration that is sitting on disk.
    const r = mount({ poseSource: 'imu' });
    await settle();
    expect(calibCalls[0]).toBe('plannedCaptureFormat');
    expect(calibCalls[1]).toContain('1920');
    expect(calibCalls[1]).toContain('1440');
    expect(calibCalls[1]).toContain('AVCaptureDeviceTypeBuiltInUltraWideCamera');
    r.unmount();
  });

  it('reports the shutter NOT capturable, and refuses a hold BY NAME, while the read is in flight', () => {
    // M10 — converted from "greys the shutter out". The deleted screen's
    // shutter painted `disabled`; the engine now only REPORTS it
    // (`onControlsState.canCapture`), and `<Camera>`'s shutter does not read
    // that field, so on `<Camera>` the shutter stays live through this
    // window. A hold that started a sweep now would start it on whichever arm
    // the read happened to land on.
    //
    // So the contract is the refusal: the hold that arrives is refused BY
    // NAME. Inside `<Camera>` there is no card and the shutter is not the
    // engine's, so a hold the engine declined used to do nothing and say
    // nothing.
    //
    // No `settle()` here on purpose — this is the in-flight frame.
    const r = mount({ poseSource: 'imu' });
    expect(r.controls()?.canCapture).toBe(false);
    r.hold();
    expect(startCalls).toBe(0);
    expect(r.failures.map((f) => f.code)).toEqual(['panoplus-not-ready']);
    r.unmount();
  });
});

describe('an UNCALIBRATED IMU selection is self-explaining, never opaque', () => {
  it('states the precondition on screen, with the fix one tap away', async () => {
    // M10 — this used to assert the first-run basis card (`panoplus-basis-
    // overlay`, `MEASURING THE BASIS`). The card is deleted; what is left on
    // screen is the arm notice, and THAT is what must state the precondition.
    //
    // ⚠ THE HEADLINE IS NOT PINNED WORD FOR WORD HERE, ON PURPOSE. Its
    // wording has moved with the basis card before: until M10 deleted the
    // card, the engine could tell the notice a gesture was on offer, and it
    // read "MEASURING THE BASIS … by the guidance on screen". The engine now
    // says no gesture is offered, so the notice sends him to the gear. What
    // is pinned is what is true either way: the notice is up, it names what
    // is missing, and the paragraph naming the fix is collapsed and one tap
    // away.
    const r = mount({ poseSource: 'imu' });
    await settle();
    expect(r.has('panoplus-arm-headline')).toBe(true);
    expect(r.shows('missing tau+basis')).toBe(true);
    // ⚠ THE SENTENCE MOVED BEHIND A TAP ON 2026-09-02 and that is the change
    // under test here. On the A35 this paragraph was 685 px of prose over the
    // live camera; it is now one tap from the headline, which is what the two
    // assertions below pin — collapsed, then reachable. It is ALSO written
    // into the pack in full on every sweep (`panoPlusNoticeSidecar`), so the
    // collapse cannot lose it even for an operator who never taps.
    expect(r.shows('IMU cal')).toBe(false);
    r.tap('panoplus-arm-notice');
    expect(r.shows('IMU cal')).toBe(true);
    r.unmount();
  });

  it('the screen SAYS the arm fell back and the bridge RECEIVES ar — no silent downgrade', async () => {
    // M10 — there is no SKIP to press first: no card owns the screen any more,
    // so the fallback is capturable the moment the read lands. That is the
    // converted half of "SKIP gives the shutter back".
    const r = mount({ poseSource: 'imu' });
    await settle();
    // What says ARKit now is the arm notice's headline (kept, collapsed). Not
    // pinned word for word — see the case above.
    expect(r.shows('IMU ARM —')).toBe(true);
    expect(r.shows('missing tau+basis')).toBe(true);
    expect(r.controls()).toEqual(READY);
    r.hold();
    await settle();
    // The half that makes the screen honest. If this ever sent 'imu', the
    // sweep would reject `panoplus-alignment-unconfigured` and the operator
    // would be looking at a notice that had just said the arm fell back.
    expect(startedWith?.poseSource).toBe('ar');
    r.unmount();
  });
});

describe('a CALIBRATED IMU selection actually reaches the decoupled arm', () => {
  beforeEach(() => {
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: -0.01142, tauStdErrMs: 0.61, basisIndex: 9, basisLabel: '+y+z+x',
      },
    });
  });

  it('says CALIBRATED, is capturable, and sends poseSource: "imu"', async () => {
    const r = mount({ poseSource: 'imu' });
    await settle();
    expect(r.shows('IMU ARM — CALIBRATED')).toBe(true);
    // (The lens-chip line that sat here is deleted in M10 — the chip is.)
    expect(r.controls()).toEqual(READY);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');
    r.unmount();
  });

  it('quotes the numbers the first field pack has to be read against', async () => {
    const r = mount({ poseSource: 'imu' });
    await settle();
    // The numbers live in the notice DETAIL, collapsed since 2026-09-02 — so
    // this is now also the test that one tap on the headline still produces
    // them. The headline itself never moved.
    expect(r.shows('IMU ARM — CALIBRATED')).toBe(true);
    expect(r.shows('-11.42 ms')).toBe(false);
    r.tap('panoplus-arm-notice');
    expect(r.shows('-11.42 ms')).toBe(true);
    expect(r.shows('#9')).toBe(true);
    r.unmount();
  });
});

describe('the HARDWARE refusal is not the calibration refusal', () => {
  it('a body with no ultra-wide is told so, and is NOT sent to calibrate', async () => {
    plannedImpl = () => Promise.resolve({
      ok: false,
      reason: 'panoplus-no-ultrawide',
      detail: 'This device publishes no builtInUltraWideCamera.',
    });
    const r = mount({ poseSource: 'imu' });
    await settle();
    expect(r.shows('NO PHYSICAL ULTRA-WIDE')).toBe(true);
    expect(r.shows('NEEDS CALIBRATION')).toBe(false);
    // And the store is never even read: there is no format for a tau to be
    // keyed by, so a lookup would be asking a meaningless question.
    expect(calibCalls.filter((c) => c.startsWith('getCalibration'))).toEqual([]);
    r.unmount();
  });
});

describe('a build with no calibration module blames the BUILD', () => {
  it('does not present as a phone problem, and still sweeps on ARKit', async () => {
    delete NM.RNSSweepCalibration;
    const r = mount({ poseSource: 'imu' });
    await settle();
    expect(r.shows('THIS BUILD CANNOT ANSWER')).toBe(true);
    // Behind the tap since 2026-09-02 — and it must STILL be one tap away,
    // because "which pod is missing" is the only actionable half of this
    // refusal and it is not a thing the headline can carry.
    r.tap('panoplus-arm-notice');
    expect(r.shows('pod install')).toBe(true);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');
    r.unmount();
  });
});

describe('the RESULT records the arm NATIVE reported, not the one requested', () => {
  it('takes native\'s answer over the request', async () => {
    // The only failure mode here that would leave no trace in the pixels: a
    // sweep believed to be decoupled that ran on ARKit. Native answers
    // `poseSource` on both branches; the engine must prefer it.
    snapshotImpl = () => Promise.resolve({
      resolved: { complete: true, missing: null, haveTau: true, haveBasis: true, basisIndex: 3 },
    });
    startAnswers = { poseSource: 'ar' }; // native says it took the ARKit branch
    let seen: string | null = null;
    const r = mount({
      poseSource: 'imu',
      onComplete: (res) => { seen = res.arms.poseSource; },
    });
    await settle();
    r.hold();
    await settle();
    // The request really was the decoupled arm — otherwise "native's answer
    // wins" would be passing on a request that already said 'ar'.
    expect(startedWith?.poseSource).toBe('imu');
    r.release();
    await settle();
    expect(seen).toBe('ar');
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE τ = 0 EXPERIMENT — the bag that crosses, and the screen that says so
//
// The device calibrated its BASIS (C #8, 0.234° over 777 pairs, stable under
// ±10 ms) and NOT its τ (8 of 12 runs resolved, 5.03 ms spread against a
// 3.08 ms budget, so the persist gate wrote nothing — correctly). This arm is
// how the operator sweeps anyway, and the two things that must be true are:
// the right key crosses the bridge, and the screen cannot be mistaken for a
// calibrated run.
// ═══════════════════════════════════════════════════════════════════════════
describe('the τ = 0 experiment', () => {
  /** The operator's phone as of 2026-08-31: a basis, and no τ. */
  const basisOnly = (): void => {
    plannedImpl = () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: false, haveBasis: true, complete: false, missing: 'tau',
        tauS: null, tauStdErrMs: null, basisIndex: 8, basisLabel: '-y+x+z',
      },
    });
  };

  const mountUncorrected = (
    uncorrected: boolean,
    pose: PanoPlusPoseSource = 'imu',
    extra: Props = {},
  ): Rig => mount({ poseSource: pose, tauUncorrected: uncorrected, ...extra });

  it('WITHOUT the flag this phone cannot run the arm at all', async () => {
    // The state the deliverable exists for: the engine honestly falls back to
    // ARKit because the sweep would otherwise claim a τ nobody measured.
    basisOnly();
    const r = mountUncorrected(false);
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');
    r.unmount();
  });

  it('WITH the flag it starts, and sends tauUncorrected — never a fake τ', async () => {
    basisOnly();
    const r = mountUncorrected(true);
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');
    expect(startedWith?.tauUncorrected).toBe(true);
    // ⚠ THE FORBIDDEN SHAPE, ASSERTED ABSENT. `{tauS: 0, tauMeasured: true}`
    // would have run this experiment today and would have written a
    // measurement claim into a pack that measured nothing. The engine must
    // never send either key.
    expect('tauMeasured' in (startedWith ?? {})).toBe(false);
    expect('tauS' in (startedWith ?? {})).toBe(false);
    r.unmount();
  });

  // ⚠ THIS TEST INVERTED ON 2026-09-07, AND THE INVERSION IS THE CHANGE.
  // It used to require the word EXPERIMENT on screen at idle. The operator:
  // "what do you mean by tau=0 experiment? Why should the user know this and
  // what do they have to do about it?" — nothing; he declared it himself in
  // the gear. So the SCREEN keeps only the four-character FACT (`⚗︎ τ=0`, in
  // the same loud non-palette colour, in every phase) and the PACK keeps the
  // whole sentence. Both halves are asserted below; asserting only the first
  // would pass equally if the fact had simply been deleted.
  it('the SCREEN carries only ⚗︎ τ=0 — and the PACK carries the sentence', async () => {
    basisOnly();
    const r = mountUncorrected(true);
    await settle();
    const chip = (): string[] => r.root()
      .findAllByProps({ testID: 'panoplus-tau-uncorrected' })
      .map((n) => String((n.props as { children?: unknown }).children));

    // IDLE: no banner, no prose — the chip and nothing else.
    expect(r.texts().some((t) => t.includes('EXPERIMENT'))).toBe(false);
    expect(r.texts().some((t) => t.includes('UNCORRECTED — EXPERIMENT'))).toBe(false);
    expect(r.count('panoplus-arm-headline')).toBe(0);
    expect(chip()).toContain('⚗︎ τ=0');

    // MID-SWEEP: unchanged — the chip stays up for the whole sweep, which is
    // what stops an uncorrected pack being remembered as a calibrated one.
    r.hold();
    await settle();
    expect(r.count('panoplus-arm-headline')).toBe(0);
    expect(chip()).toContain('⚗︎ τ=0');
    expect(r.texts().some((t) => t.includes('EXPERIMENT'))).toBe(false);

    // THE PACK. `host_notice.json` is written when start resolves, and it is
    // the only place the arm, the τ provenance and the calibration state are
    // now stated in words.
    const notice = written.find((w) => w.uri.endsWith('host_notice.json'));
    expect(notice).toBeDefined();
    const body = JSON.parse(notice!.body) as Record<string, unknown>;
    expect(body.schema).toBe('panoplus-host-notice/1');
    expect(body.poseSourceEffective).toBe('imu');
    expect(body.startLabel).toBe('Start τ=0 EXPERIMENT');
    expect(body.headline)
      .toBe('IMU ARM — EXPERIMENT: τ = 0, NO TIMING CORRECTION');
    expect(String(body.detail)).toContain('tauProvenance: uncorrected');
    expect(String(body.detail)).toContain('C #8');
    // …and that the operator was never shown it, so `shownExpanded: false`
    // cannot be misread as "he chose not to open it".
    expect(body.packOnly).toBe(true);
    r.unmount();
  });

  // ⚠ THE PACK'S PROSE MUST SURVIVE A HOST THAT WALKS AWAY MID-START.
  //
  // Native's `start()` does not resolve until the camera is open and
  // ingesting, and the host unmounts the engine on a mode switch. So a sweep
  // can be started, finalized into a REAL pack on disk, and never once have a
  // mounted engine to draw on — the branch the engine itself models at
  // `started after unmount — finalized`.
  //
  // Since 2026-09-07 that costs something it did not cost before: the τ = 0
  // arm notice is `packOnly`, so `host_notice.json` is the ONLY place the arm,
  // `tauProvenance` and the basis history are stated in words. The sibling
  // sweep-HUD sidecar is deliberately written ABOVE its own `mountedRef`
  // check for exactly this reason; this one must be too.
  it('writes the pack notice even when the host unmounts mid-start', async () => {
    basisOnly();
    let resolveStart: ((v: Record<string, unknown>) => void) | null = null;
    let stopCalls = 0;
    NM.RNSSweepSession = {
      start: (o: Record<string, unknown>) => {
        startedWith = o;
        return new Promise<Record<string, unknown>>((res) => { resolveStart = res; });
      },
      stop: () => { stopCalls += 1; return Promise.resolve({ sessionDir: '/d/pp_1' }); },
      cancel: () => Promise.resolve({ cancelled: true }),
      getStatus: () => Promise.resolve({ running: false }),
    };
    const r = mountUncorrected(true);
    await settle();
    r.hold();                     // start dispatched; native is still opening
    await settle();
    r.unmount();                  // the host switched modes
    expect(resolveStart).not.toBeNull();
    act(() => {
      resolveStart?.({ sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true });
    });
    await settle();
    // The session IS live and this handler owns finalizing it — that part
    // already worked.
    expect(stopCalls).toBe(1);
    // …and the pack it finalized carries the sentence.
    const notice = written.find((w) => w.uri.endsWith('host_notice.json'));
    expect(notice).toBeDefined();
    const body = JSON.parse(notice!.body) as Record<string, unknown>;
    expect(body.poseSourceEffective).toBe('imu');
    expect(body.headline)
      .toBe('IMU ARM — EXPERIMENT: τ = 0, NO TIMING CORRECTION');
    expect(body.packOnly).toBe(true);
  });

  it('a REAL refusal still reaches the screen', async () => {
    // The half that must NOT be hidden: no basis ⇒ the arm cannot run, the
    // operator has something to do about it, and an unexplained fallback is
    // how UNCONFIGURED gets reported as BROKEN.
    const r = mountUncorrected(true);
    await settle();
    expect(r.count('panoplus-arm-headline')).toBeGreaterThan(0);
    r.unmount();
  });

  it('is NEVER sent, and never shown, on a sweep that runs on ARKit', async () => {
    // Two ways to reach ARKit: the flag on the ARKit arm, and an IMU selection
    // that fell back. Both must leave the bag and the screen alone — a chip
    // claiming an uncorrected sweep on a corrected one is the same lie
    // pointing the other way.
    const r1 = mountUncorrected(true, 'ar');
    await settle();
    expect(r1.count('panoplus-tau-uncorrected')).toBe(0);
    r1.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');
    expect('tauUncorrected' in (startedWith ?? {})).toBe(false);
    r1.unmount();

    plannedImpl = () => Promise.resolve({
      ok: false, reason: 'panoplus-no-ultrawide', detail: 'no ultra-wide',
    });
    const r2 = mountUncorrected(true);
    await settle();
    expect(r2.count('panoplus-tau-uncorrected')).toBe(0);
    r2.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');
    expect('tauUncorrected' in (startedWith ?? {})).toBe(false);
    r2.unmount();
  });

  it('CANNOT be turned on behind the chrome by an escape hatch', async () => {
    // ── THE SCREEN AND THE PACK MUST AGREE, AND ONE OF THEM WAS SPREADABLE ──
    //
    // `engineOptions` / `packOptions` are spread into the start bag BEFORE the
    // three arms are assigned, and a conditional spread can only ever ADD a
    // key — it cannot delete one an escape hatch already put there. So a host
    // that pushed `tauUncorrected` through `engineOptions` while the prop was
    // false would have run an UNCORRECTED sweep behind chrome that says
    // CALIBRATED: no purple chip, no amber headline. The pack would have been
    // honest and the screen a lie, which is the half of this deliverable the
    // operator reads first.
    //
    // Cast because TypeScript already refuses it (`tauUncorrected` is on
    // `PanoPlusStartOptions`, not `PanoPlusEngineOptions`) — this is the
    // untyped host, which is the only one that could have reached it.
    basisOnly();
    const r = mountUncorrected(false, 'imu', {
      engineOptions: { tauUncorrected: true } as PanoPlusEngineOptions,
    });
    await settle();
    // The screen says calibrated — so the bag must not say otherwise.
    expect(r.count('panoplus-tau-uncorrected')).toBe(0);
    r.hold();
    await settle();
    expect('tauUncorrected' in (startedWith ?? {})).toBe(false);
    // And this phone has no τ, so with the declaration correctly refused the
    // honest outcome is the ARKit fallback — never a silent uncorrected sweep.
    expect(startedWith?.poseSource).toBe('ar');
    r.unmount();
  });

  it('is not DISABLED by an escape hatch either — the prop owns the key', async () => {
    // The mirror image: the prop declares the experiment, and a stale
    // `tauUncorrected: false` in a host's `engineOptions` must not quietly
    // demote it to an ordinary sweep whose chip still says EXPERIMENT.
    basisOnly();
    const r = mountUncorrected(true, 'imu', {
      engineOptions: { tauUncorrected: false } as PanoPlusEngineOptions,
    });
    await settle();
    expect(r.count('panoplus-tau-uncorrected')).toBeGreaterThan(0);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');
    expect(startedWith?.tauUncorrected).toBe(true);
    r.unmount();
  });

  it('OUTRANKS a stored τ — a calibrated phone still runs the experiment', async () => {
    // The store-override rule, at the layer that decides what crosses the
    // bridge. Native enforces it again below (an explicit request wins over
    // `RNISPanoCalibStore`), and this is the half that makes the request in
    // the first place: if the engine treated a calibrated phone as an
    // ordinary sweep, no `tauUncorrected` would be sent and the store would
    // fill τ in — the experiment silently never running.
    plannedImpl = () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: 0.00289, tauStdErrMs: 0.57, basisIndex: 8, basisLabel: '-y+x+z',
      },
    });
    const r = mountUncorrected(true);
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');
    expect(startedWith?.tauUncorrected).toBe(true);
    expect('tauS' in (startedWith ?? {})).toBe(false);
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SECOND ATTITUDE CHANNEL (2026-09-01) — the same-pixels pose-arm A/B
//
// The whole instrument is worthless if the key lands on the wrong arm, and
// "the wrong arm" here has TWO shapes that a source reading would not tell
// apart:
//
//  · Sent on the DECOUPLED arm, where ARKit has been torn down before the
//    camera opens. `track.jsonl` and `attitude_imu.jsonl` would then carry
//    the SAME CoreMotion channel — a pack that looks like an A/B and is not,
//    which is worse than no pack at all.
//  · NOT sent on a sweep the operator selected as `'imu'` and that the
//    engine honestly DOWNGRADED to ARKit. That downgraded sweep runs on
//    ARKit, so it is precisely a sweep this instrument can record — and a gate
//    written against the raw prop rather than `armNotice.effectivePoseSource`
//    would silently refuse it. On the operator's phone (a basis, no τ) that
//    downgrade is the COMMON case, so the wrong gate would have produced zero
//    recordings and no error.
// ═══════════════════════════════════════════════════════════════════════════
describe('the IMU sidecar rides the ARKit arm and only the ARKit arm', () => {
  const mountSidecar = (
    pose: PanoPlusPoseSource,
    sidecar: boolean,
    extra: Props = {},
  ): Rig => mount({ poseSource: pose, imuSidecar: sidecar, ...extra });

  const press = async (r: Rig): Promise<void> => {
    await settle();
    r.hold();
    await settle();
  };

  it('sends it on the ARKit arm', async () => {
    const r = mountSidecar('ar', true);
    await press(r);
    expect(startedWith?.poseSource).toBe('ar');
    expect(startedWith?.imuSidecar).toBe(true);
    r.unmount();
  });

  it('OMITS the key entirely when off — never sends a false', async () => {
    // ABSENT, not `false`. Native reads absence as "the sweep that shipped"
    // and emits no `meta.json` key at all; a `false` would be a declaration
    // nobody made, in the pack of a sweep that recorded nothing.
    const r = mountSidecar('ar', false);
    await press(r);
    expect(startedWith).not.toBeNull();
    expect('imuSidecar' in (startedWith ?? {})).toBe(false);
    r.unmount();
  });

  it('DELETES it on a decoupled sweep — the comparison cannot exist there', async () => {
    plannedImpl = () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: -0.0042, tauStdErrMs: 0.31, basisIndex: 8, basisLabel: '-y+x+z',
      },
    });
    const r = mountSidecar('imu', true);
    await press(r);
    expect(startedWith?.poseSource).toBe('imu');
    expect('imuSidecar' in (startedWith ?? {})).toBe(false);
    r.unmount();
  });

  it('SENDS it on a sweep DOWNGRADED from imu to ARKit', async () => {
    // The operator's phone as of 2026-08-31: a basis, no τ. The sweep runs on
    // ARKit — and ARKit is the arm this instrument records. A gate on the raw
    // `poseSource` prop would have refused every sweep this phone can
    // actually take.
    plannedImpl = () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    });
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: false, haveBasis: true, complete: false, missing: 'tau',
        tauS: null, tauStdErrMs: null, basisIndex: 8, basisLabel: '-y+x+z',
      },
    });
    const r = mountSidecar('imu', true);
    await press(r);
    expect(startedWith?.poseSource).toBe('ar');
    expect(startedWith?.imuSidecar).toBe(true);
    r.unmount();
  });

  it('the PROP owns it over engineOptions, in BOTH directions', async () => {
    // The `tauUncorrected` lesson, applied before it can bite: a conditional
    // spread can only ever ADD, so a host that pushed `imuSidecar` through the
    // escape hatch would have armed a channel the prop said was off — and on
    // the decoupled arm would have armed one native refuses, putting a refusal
    // nobody asked for into the pack. Cast because TypeScript already refuses
    // the shape; the runtime rule is what is under test.
    const r1 = mountSidecar('ar', false, {
      engineOptions: { imuSidecar: true } as PanoPlusEngineOptions,
    });
    await press(r1);
    expect(startedWith).not.toBeNull();
    expect('imuSidecar' in (startedWith ?? {})).toBe(false);
    r1.unmount();

    const r2 = mountSidecar('ar', true, {
      engineOptions: { imuSidecar: false } as PanoPlusEngineOptions,
    });
    await press(r2);
    expect(startedWith?.imuSidecar).toBe(true);
    r2.unmount();
  });
});

// ── PANO'S AR PILL — deleted in M10 ────────────────────────────────────────
// The seven cases that sat here pinned the sweep screen's own AR pill
// (`PanoArToggle`): its switch role and label, ON/OFF per arm, its absence at
// 0.5×, what a tap wrote through `onPoseSourceChange`, following the request
// while the read is in flight, and its pointerEvents reachability. The pill,
// the chip it sat beside and `onPoseSourceChange` are all deleted in M10;
// `<Camera>`'s own AR toggle is the only one left. The ENGINE facts the pill
// used to paint are pinned where they now live: the arm latch mid-sweep in
// `panoPlusArmLatch.render`, the AR view held down while the read is in
// flight in "ARKit and the decoupled arm never hold the camera at once" above.
