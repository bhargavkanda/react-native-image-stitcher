// SPDX-License-Identifier: Apache-2.0
//
// THE ARM A LIVE SWEEP IS RUNNING ON CANNOT BE CHANGED UNDER IT.
//
// ── The gap this closes ───────────────────────────────────────────────────
//
// Until the 2026-09-01 consolidation the pose-arm flag could only be moved
// from a gear panel, and reaching that panel meant leaving pano+ — so the prop
// only ever changed while this surface was unmounted, and deriving
// `arArmed` straight from it was safe by construction.
//
// The consolidation put an AR pill on the capture screen, live in pano+ mode.
// The prop can now change WHILE A SWEEP IS RUNNING, and two things then follow
// from a derivation with no phase term:
//
//   · `<ARCameraView>` unmounts mid-sweep on a calibrated phone (that unmount
//     IS `RNSARSession.shared.stop()`), or mounts on top of the decoupled arm's
//     live AVCaptureSession. One physical camera, two clients — the P0 this
//     component already carried once.
//   · the surface reports an EFFECTIVE ARM the running sweep is not on, and the
//     host's pill draws exactly that. A pill reading IMU over a sweep ARKit
//     recorded is the one failure that leaves no trace in the pixels.
//
// So the arm is LATCHED at Start, exactly as `armsRef` (which stamps the pack)
// already was, and released when the phase returns to idle. These tests assert
// the mount and the arm the result carries, not the source — the mount is the
// side effect.
//
// M10 — the sweep's own screen and its arm report (`onEffectiveArmChange`)
// are deleted; the engine is mounted through `SweepEngineHarness` and the
// shutter pressed through its handle. The two surviving forms of "the arm the
// host sees" are the arm the RESULT carries (`result.arms.poseSource`, from
// `armsRef`) and the engine's `canCapture` report (`onControlsState`), which
// is where the old report's `resolving` term now lands. `<Camera>`'s shutter
// does not paint that report; what a host sees of it is the named refusal
// (`panoplus-not-ready`) of a hold made while it is false.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NativeModules } from 'react-native';

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

import { SweepEngineHarness } from './sweepEngineHarness';
import { ARCameraView } from '../../camera/ARCameraView';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';
import type {
  PanoPlusCaptureResult,
  PanoPlusFailure,
  PanoPlusPoseSource,
  SweepSurfaceHandle,
  SweepSurfaceState,
} from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** The bag the last `start()` received — the arm that actually crossed. */
let startedWith: Record<string, unknown> | null = null;
/** Forget the last start bag, so a SECOND hold's bag is what gets read. (A
 *  function rather than an inline `= null`, which would narrow the variable
 *  to `null` for the rest of the case.) */
const clearStart = (): void => { startedWith = null; };
/** Every `onControlsState` payload, in order — the engine's own report.
 *  `canCapture: false` on a live module is the arm read still resolving.
 *  (`<Camera>` reads only `busy` from it; its shutter does not grey here.) */
let controls: SweepSurfaceState[] = [];
/** Every `onFailure`, in order — a hold the engine declines is named here. */
let failures: PanoPlusFailure[] = [];
/** Every `onComplete` result — the arm a finished sweep says it ran on. */
let results: PanoPlusCaptureResult[] = [];

/** A phone that HAS both halves of the calibration — the only device on which
 *  the decoupled arm is selectable at all, and therefore the only one on which
 *  a mid-sweep flip can move `arArmed`. On an uncalibrated phone the notice
 *  falls back to ARKit and the bug is invisible, which is why the fixture is
 *  the calibrated one. */
const CALIBRATED_PLAN = {
  ok: true,
  lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
  width: 1920,
  height: 1440,
  fps: 60,
  tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
  basisKey: 'iPhone17,1',
};
const CALIBRATED_SNAPSHOT = {
  resolved: {
    haveTau: true,
    haveBasis: true,
    complete: true,
    missing: null,
    tauS: -0.0042,
    tauStdErrMs: 0.31,
    basisIndex: 5,
    basisLabel: '+y+z+x',
  },
};

function installNative(): void {
  startedWith = null;
  controls = [];
  failures = [];
  results = [];
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      return Promise.resolve({
        sessionDir: '/d/pp_1',
        startedAtMs: 1,
        pluginAvailable: true,
        poseSource: o.poseSource,
      });
    },
    stop: () => Promise.resolve({
      sessionDir: '/d/pp_1',
      width: 4000,
      height: 1000,
      uri: '/d/pp_1/pano.jpg',
      counts: { seen: 90, painted: 88, rejectedOutOfCage: 0, rejectedLowResponse: 0, rejectedPoseSpeed: 2 },
      unpaintedRuns: [],
    }),
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
    plannedCaptureFormat: () => Promise.resolve(CALIBRATED_PLAN),
    getCalibration: () => Promise.resolve(CALIBRATED_SNAPSHOT),
  };
}

interface Rig {
  /** Is the stitcher's `<ARCameraView>` mounted? Found by TYPE — the harness
   *  draws the real component. */
  hasArView: () => boolean;
  /** The shutter held past the threshold — the engine's `holdStart`. */
  hold: () => void;
  /** …and released — the engine's `holdEnd`: the sweep finishes, pack kept. */
  release: () => void;
  /** Re-render with a different arm — what the host's AR pill does. */
  setArm: (poseSource: PanoPlusPoseSource) => void;
  unmount: () => void;
}

function mount(poseSource: PanoPlusPoseSource): Rig {
  let renderer!: ReactTestRenderer;
  const handle = React.createRef<SweepSurfaceHandle>();
  const render = (arm: PanoPlusPoseSource): React.JSX.Element => (
    <SweepEngineHarness
      ref={handle}
      onComplete={(r) => { results.push(r); }}
      onCancel={() => undefined}
      onFailure={(f) => { failures.push(f); }}
      onControlsState={(c) => { controls.push(c); }}
      poseSource={arm}
    />
  );
  act(() => {
    renderer = TestRenderer.create(render(poseSource));
  });
  act(() => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
  });
  const press = (which: 'holdStart' | 'holdEnd'): void => {
    const fn = handle.current?.[which];
    if (fn == null) throw new Error(`the engine handle has no ${which}`);
    act(() => { fn(); });
  };
  return {
    hasArView: () => renderer.root.findAllByType(ARCameraView).length > 0,
    hold: () => press('holdStart'),
    release: () => press('holdEnd'),
    setArm: (arm) => { act(() => { renderer.update(render(arm)); }); },
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
});
afterEach(() => {
  jest.useRealTimers();
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

describe('the arm is latched for the duration of a sweep', () => {
  it('keeps ARKit mounted when the pill is flipped to IMU mid-sweep', async () => {
    const r = mount('ar');
    await settle();
    expect(r.hasArView()).toBe(true);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');

    // THE PILL, TAPPED DURING THE SWEEP. Without the latch `arArmed` re-derives
    // to false here and React unmounts <ARCameraView> — which is
    // `RNSARSession.shared.stop()` under a sweep whose frames come from it.
    r.setArm('imu');
    await settle();
    expect(r.hasArView()).toBe(true);
    r.unmount();
  });

  it('does not start ARKit under a live decoupled sweep', async () => {
    const r = mount('imu');
    await settle();
    // The decoupled arm is usable on this fixture, so ARKit is deliberately DOWN.
    expect(r.hasArView()).toBe(false);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');

    // Flipping back mid-sweep would mount <ARCameraView> on top of the arm's
    // own AVCaptureSession — one body, two clients. Checked PAST the swap
    // grace: an arm change re-arms it, so inside it the view is down whatever
    // the latch does and the check could not fail.
    r.setArm('ar');
    await settle();
    act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
    expect(r.hasArView()).toBe(false);
    r.unmount();
  });

  // The arm REPORT (`onEffectiveArmChange`, the host pill's feed) — deleted
  // in M10. The latch it reported survives on the RESULT, which is what the
  // pack is stamped with.
  it('the result names the RUNNING arm, never the newly requested one', async () => {
    const r = mount('ar');
    await settle();
    r.hold();
    await settle();

    r.setArm('imu');
    await settle();
    r.release();
    await settle();
    // The pack says `ar` (the arm latched at Start). What the host is handed
    // must say the same thing, or the operator is told he swept decoupled
    // when he did not.
    expect(results).toHaveLength(1);
    expect(results[0]!.arms.poseSource).toBe('ar');
    r.unmount();
  });

  it('releases the latch once the sweep lands, so the next one honours the flip',
    async () => {
      const r = mount('ar');
      await settle();
      r.hold();
      await settle();
      r.setArm('imu');
      await settle();
      expect(r.hasArView()).toBe(true);   // still latched mid-sweep

      r.release();
      await settle();
      // Idle again: the requested arm is the effective arm, ARKit is down…
      expect(r.hasArView()).toBe(false);
      // …and a second sweep crosses the bridge on 'imu'.
      clearStart();
      r.hold();
      await settle();
      expect(failures).toEqual([]);
      expect(startedWith?.poseSource).toBe('imu');
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  AND AN UNRESOLVED READ IS NOT A SETTLED ARM
//
//  Selecting the IMU arm RESETS the precondition read (`calibRead=false`,
//  `plan=null`), and with no plan `panoPlusArmNotice` correctly answers "this
//  build cannot answer" — a FALLBACK. A hold in that window must not start a
//  sweep on an arm that may be taken back one frame later.
//
//  M10 — this used to be pinned on the arm REPORT's `resolving` flag
//  (`onEffectiveArmChange`, deleted). The same fact (`armResolving`) now
//  gates the engine's `canCapture` report, which `<Camera>`'s shutter does
//  NOT paint, so the contract a host sees is the refusal: a hold in that
//  window is refused by name, `panoplus-not-ready`.
// ═══════════════════════════════════════════════════════════════════════════

describe('the engine says when nothing is settled yet', () => {
  it('holds the IMU selection NOT READY until the precondition read lands', async () => {
    const r = mount('imu');
    // Before the read resolves: the engine reports it cannot take a hold, and
    // a hold is refused by name rather than started on an unsettled arm.
    expect(controls[0]).toMatchObject({ canCapture: false });
    r.hold();
    expect(failures.map((f) => f.code)).toEqual(['panoplus-not-ready']);
    expect(startedWith).toBeNull();
    await settle();
    // After: a settled, usable IMU arm — the report is capturable and a hold
    // starts.
    expect(controls[controls.length - 1]).toMatchObject({ canCapture: true });
    r.hold();
    await settle();
    expect(failures).toHaveLength(1);
    expect(startedWith?.poseSource).toBe('imu');
    r.unmount();
  });

  it('never holds the ARKit arm not-ready — it has nothing to wait for', async () => {
    const r = mount('ar');
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c).toMatchObject({ canCapture: true });
    // A hold before any promise has settled still starts.
    r.hold();
    await settle();
    expect(failures).toEqual([]);
    expect(startedWith?.poseSource).toBe('ar');
    r.unmount();
  });

  it('is never not-ready mid-sweep — a running sweep is on a settled arm', async () => {
    const r = mount('ar');
    await settle();
    r.hold();
    await settle();
    const before = controls.length;
    // The flip RESETS the read (this lens was never read on the IMU arm), so
    // `armPending` goes true for the width of the round trip; the latched arm
    // is what keeps the report capturable under the finger.
    r.setArm('imu');
    await settle();
    const after = controls.slice(before);
    for (const c of after) expect(c).toMatchObject({ canCapture: true });
    expect(failures).toEqual([]);
    r.unmount();
  });
});
