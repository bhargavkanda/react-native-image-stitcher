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
// the mount and the reported arm, not the source — the mount is the side effect.

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

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
import { holdShutter, releaseShutter, shutterState } from './shutterGestures';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';
import type { PanoPlusPoseSource } from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** The bag the last `start()` received — the arm that actually crossed. */
let startedWith: Record<string, unknown> | null = null;
/** Every `onEffectiveArmChange` payload, in order. The LAST one is what the
 *  host's AR pill is drawing at that moment. */
let armReports: {
  poseSource: PanoPlusPoseSource;
  fallbackToAr: boolean;
  resolving: boolean;
}[] = [];

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
  armReports = [];
  NM.RNISPanoPlus = {
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
  NM.RNISPanoCalib = {
    startBasisCalibration: () => Promise.resolve({}),
    basisCalibrationStatus: () => Promise.resolve({}),
    stopBasisCalibration: () => Promise.resolve({}),
    resolveBasisCalibration: () => Promise.resolve({}),
    discardBasisCalibration: () => Promise.resolve({}),
    combineTauRuns: () => Promise.resolve({}),
    calibrationPolicy: () => Promise.resolve({}),
    saveTauCalibration: () => Promise.resolve({}),
    saveBasisCalibration: () => Promise.resolve({}),
    clearCalibration: () => Promise.resolve({}),
    plannedCaptureFormat: () => Promise.resolve(CALIBRATED_PLAN),
    getCalibration: () => Promise.resolve(CALIBRATED_SNAPSHOT),
  };
}

interface Rig {
  has: (testID: string) => boolean;
  tap: (testID: string) => void;
  /** Pano's shutter held past the threshold — the sweep starts (2026-09-03). */
  hold: () => void;
  /** …and released — the sweep finishes, pack kept. */
  release: () => void;
  /** What Pano's shutter would paint. */
  shutter: () => { disabled: boolean; busy: boolean };
  /** Re-render with a different arm — what the host's AR pill does. */
  setArm: (poseSource: PanoPlusPoseSource) => void;
  unmount: () => void;
}

function mount(poseSource: PanoPlusPoseSource): Rig {
  let renderer!: ReactTestRenderer;
  const render = (arm: PanoPlusPoseSource): React.JSX.Element => (
    <PanoPlusCaptureSurface
      onComplete={() => undefined}
      onCancel={() => undefined}
      poseSource={arm}
      onEffectiveArmChange={(a) => {
        armReports.push({
          poseSource: a.poseSource,
          fallbackToAr: a.fallbackToAr,
          resolving: a.resolving,
        });
      }}
    />
  );
  act(() => {
    renderer = TestRenderer.create(render(poseSource));
  });
  act(() => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
  });
  return {
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    tap: (testID) => {
      const node = renderer.root.findAllByProps({ testID })[0];
      const onPress = node?.props?.onPress as (() => void) | undefined;
      if (onPress == null) throw new Error(`no onPress on ${testID}`);
      act(() => { onPress(); });
    },
    hold: () => holdShutter(renderer.root),
    release: () => releaseShutter(renderer.root),
    shutter: () => shutterState(renderer.root),
    setArm: (arm) => { act(() => { renderer.update(render(arm)); }); },
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

const lastArm = (): (typeof armReports)[number] => {
  const last = armReports[armReports.length - 1];
  if (last == null) throw new Error('the surface never reported an arm');
  return last;
};

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
});
afterEach(() => {
  jest.useRealTimers();
  delete NM.RNISPanoPlus;
  delete NM.RNISPanoCalib;
});

describe('the arm is latched for the duration of a sweep', () => {
  it('keeps ARKit mounted when the pill is flipped to IMU mid-sweep', async () => {
    const r = mount('ar');
    await settle();
    expect(r.has('ar-camera')).toBe(true);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('ar');

    // THE PILL, TAPPED DURING THE SWEEP. Without the latch `arArmed` re-derives
    // to false here and React unmounts <ARCameraView> — which is
    // `RNSARSession.shared.stop()` under a sweep whose frames come from it.
    r.setArm('imu');
    await settle();
    expect(r.has('ar-camera')).toBe(true);
    r.unmount();
  });

  it('does not start ARKit under a live decoupled sweep', async () => {
    const r = mount('imu');
    await settle();
    // The decoupled arm is usable on this fixture, so ARKit is deliberately DOWN.
    expect(r.has('ar-camera')).toBe(false);
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');

    // Flipping back mid-sweep would mount <ARCameraView> on top of the arm's
    // own AVCaptureSession — one body, two clients.
    r.setArm('ar');
    await settle();
    expect(r.has('ar-camera')).toBe(false);
    r.unmount();
  });

  it('reports the RUNNING arm, never the newly requested one', async () => {
    const r = mount('ar');
    await settle();
    expect(lastArm()).toEqual({ poseSource: 'ar', fallbackToAr: false, resolving: false });
    r.hold();
    await settle();

    r.setArm('imu');
    await settle();
    // The pack will say `ar` (the arm latched at Start). The pill must say the
    // same thing, or the operator is told he swept decoupled when he did not.
    expect(lastArm().poseSource).toBe('ar');
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
      expect(lastArm().poseSource).toBe('ar');

      r.release();
      await settle();
      // Idle again: the requested arm is the effective arm, ARKit is down, and
      // a second sweep would cross the bridge on 'imu'.
      expect(lastArm().poseSource).toBe('imu');
      expect(r.has('ar-camera')).toBe(false);
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  AND AN UNRESOLVED READ IS NOT A REFUSAL
//
//  Selecting the IMU arm RESETS the precondition read (`calibRead=false`,
//  `plan=null`), and with no plan `panoPlusArmNotice` correctly answers "this
//  build cannot answer" — a FALLBACK. A host pill drawing that would flash
//  `AR ⟵ IMU n/a` at the exact moment the operator tapped "turn AR off", on a
//  phone where the arm is perfectly usable, and read as a refusal of the thing
//  he had just asked for. The Start button has always refused to offer a label
//  it may take back one frame later; `resolving` is that same fact, reported.
// ═══════════════════════════════════════════════════════════════════════════

describe('the reported arm says when nothing is settled yet', () => {
  it('marks the IMU selection RESOLVING until the precondition read lands', async () => {
    const r = mount('imu');
    // Before the read resolves: the notice is a fallback, and it must not be
    // presented as one.
    expect(armReports[0]).toMatchObject({ resolving: true });
    await settle();
    // After: a settled, usable IMU arm — no fallback anywhere in sight.
    expect(lastArm()).toMatchObject({ poseSource: 'imu', fallbackToAr: false });
    r.unmount();
  });

  it('never marks the ARKit arm resolving — it has nothing to wait for', async () => {
    const r = mount('ar');
    await settle();
    for (const a of armReports) expect(a).toMatchObject({ resolving: false });
    r.unmount();
  });

  it('is never resolving mid-sweep — a running sweep is on a settled arm', async () => {
    const r = mount('ar');
    await settle();
    r.hold();
    await settle();
    r.setArm('imu');
    await settle();
    expect(lastArm()).toMatchObject({ poseSource: 'ar', resolving: false });
    r.unmount();
  });
});
