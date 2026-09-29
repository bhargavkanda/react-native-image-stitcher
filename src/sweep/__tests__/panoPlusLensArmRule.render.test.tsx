// SPDX-License-Identifier: Apache-2.0
//
// PANO'S LENS RULE — WHAT THE ENGINE SENDS FOR EACH (lens, arm).
//
// ── The decision this pinned ──────────────────────────────────────────────
//
// The owner was shown, on 2026-09-03, that pano+ and Pano disagreed about which
// of the two controls hides. He took Pano's rule: the lens chip is ALWAYS
// visible on BOTH arms, the AR pill is gated on `lens === '1x'`, and tapping
// 0.5× moves pano+ to the non-AR (decoupled) arm automatically, exactly as
// picking 0.5× in Pano drops you out of AR.
//
// ── M10 ────────────────────────────────────────────────────────────────────
//
// The sweep's own chip (`PanoLensChip`) and pill (`PanoArToggle`) are deleted
// with the screen that drew them; the rule is `<Camera>`'s to draw now, with
// `<Camera>`'s own lens chip and AR toggle. What stays HERE is the half of the
// rule that was always the engine's and that the chrome could never make true
// on its own:
//
//   THE BAG NEVER CLAIMS A LENS THE RUNNING ARM CANNOT DELIVER.
//
// `panoPlusLens` defaults to `'ultraWide'` and `panoPlusPoseSource` to `'ar'`,
// so a FRESH DEVICE lands in (0.5×, AR) — a combination ARCore cannot honour
// (it forces camera 0) and ARKit cannot honour (no ultra-wide format, 0 of 22
// on iPhone17,1). The engine therefore sends `lens` ONLY on the decoupled arm
// and DELETES it everywhere else, and the arm notice names a lens the arm
// dropped.
//
// A tap on the deleted chip or pill is re-routed here as what it always was
// underneath: the host writing new `lens` / `poseSource` props, i.e. a
// re-render.
//
// ⚠ WHAT THIS SUITE CANNOT PROVE. It is JS. That camera 0 vs camera 2 really
// opens is native's, and on 2026-09-03 no Android device was attached — every
// pixel claim about the A35 is unverified.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
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

import { SweepEngineHarness } from './sweepEngineHarness';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';
import type {
  PanoPlusPoseSource,
  SweepSurfaceHandle,
} from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** The options bag the last `start()` received — how the PACK's provenance is
 *  checked without a device. */
let startedWith: Record<string, unknown> | null = null;

type HostLens = 'ultraWide' | 'wide';

/** A phone that HAS been calibrated, so a requested IMU arm really resolves to
 *  the IMU arm. Without this every `'imu'` mount falls back to ARKit and the
 *  0.5× half of the rule is unreachable. */
const CALIBRATED = () => Promise.resolve({
  resolved: {
    haveTau: true, haveBasis: true, complete: true, missing: null,
    tauS: -0.01142, tauStdErrMs: 0.61, basisIndex: 9, basisLabel: '+y+z+x',
  },
});
/**
 * …and one that has not, which is the FALLBACK rung: the operator asked for the
 * decoupled arm and ARKit is what will actually run.
 *
 * ⚠ MISSING τ, WITH THE BASIS ON FILE — deliberate (2026-09-03). It is what
 * the operator's own iPhone reports: every pano+ pack from it carries
 * `attitudeBasisIndex: 8`, `basisSource: 'store'`, and no τ, because τ
 * "measured 8 of 12 times and scattered 5.03 ms, so nothing was persisted" —
 * `panoPlusModel`'s own words for the normal state.
 */
const UNCALIBRATED = () => Promise.resolve({
  resolved: {
    haveTau: false, haveBasis: true, complete: false, missing: 'tau',
    basisIndex: 8, basisLabel: '-y+x+z',
  },
});
let snapshotImpl: () => Promise<unknown> = CALIBRATED;

function installNative(): void {
  startedWith = null;
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      return Promise.resolve({
        sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: false }),
  };
  // ⚠ THE WHOLE SURFACE OF THE CALIBRATION MODULE, not just the two methods
  // this file reads. `panoPlusCalibration`'s availability probe checks for the
  // methods it needs before it will answer anything, so a partial mock reports
  // "this build carries no calibration module" — which resolves EVERY decoupled
  // request to the ARKit fallback, and every 0.5× case in this file would then
  // be testing the fallback rung by accident.
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
    plannedCaptureFormat: () => Promise.resolve({
      ok: true,
      lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
      width: 1920, height: 1440, fps: 60,
      tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
      basisKey: 'iPhone17,1',
    }),
    getCalibration: () => snapshotImpl(),
  };
}

interface Rig {
  /** Every string the engine's view actually rendered, joined. */
  text: () => string;
  /** What `<Camera>`'s shutter calls on a hold, then on the release — one
   *  whole sweep. */
  sweep: () => void;
  /** The host writing new flags — what the deleted chip / pill did on a tap. */
  rerender: (lens: HostLens, pose: PanoPlusPoseSource) => void;
  unmount: () => void;
}

function mount(lens0: HostLens, pose0: PanoPlusPoseSource): Rig {
  const handle = React.createRef<SweepSurfaceHandle>();
  const element = (lens: HostLens, pose: PanoPlusPoseSource): React.JSX.Element => (
    <SweepEngineHarness
      ref={handle}
      onComplete={() => undefined}
      onCancel={() => undefined}
      lens={lens}
      poseSource={pose}
    />
  );
  let renderer!: ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(element(lens0, pose0)); });
  act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
  return {
    text: () => {
      const out: string[] = [];
      const walk = (n: unknown): void => {
        if (typeof n === 'string') { out.push(n); return; }
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n != null && typeof n === 'object' && 'children' in n) {
          walk((n as { children: unknown }).children);
        }
      };
      walk(renderer.toJSON());
      return out.join(' ');
    },
    sweep: () => {
      act(() => { handle.current?.holdStart?.(); });
      act(() => { handle.current?.holdEnd?.(); });
    },
    rerender: (lens, pose) => {
      act(() => { renderer.update(element(lens, pose)); });
    },
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

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
  snapshotImpl = CALIBRATED;
});
afterEach(() => {
  jest.useRealTimers();
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

// ── 1-5, 7-10 and the basis-card carve-out — deleted in M10 ────────────────
// The sections that sat here pinned the sweep screen's own lens chip and AR
// pill: the chip mounted on both arms (1), the pill gated on 1× (2), a 0.5×
// tap writing BOTH flags in one commit (3), 1× restoring the pill OFF (4),
// the chip painting `effectiveLens` for every (lens, arm) (5), both controls'
// pointerEvents reachability (7), the pill committing the painted lens (8),
// "a flag writer is always on screen" under the lens-availability probe's
// refusal (9), the chip collapsing on the fallback rung (10), and both yielding
// to the basis card. The chip, the pill, `effectiveLens`, the probe
// (`panoPlusLensAvailability`) and the card are all deleted in M10; the lens
// rule's chrome is `<Camera>`'s. What those cases also claimed about the BAG
// is kept below — including the fallback rung's, converted from (5).

// ═══════════════════════════════════════════════════════════════════════════
//  WHAT CROSSES THE BRIDGE MATCHES WHICH ARM IS RUNNING
// ═══════════════════════════════════════════════════════════════════════════
//
// The pack's lens provenance starts here: `lensRequested` is whatever `start()`
// was given. Native derives the rest from the camera it actually opened —
// `lensRan` by FOV band, `lensHonoured = lensRequested != null && ran ==
// lensRequested`, and `lensNote` saying which rule fired
// (`PanoPlusAndroidRecorder.kt:2584-2611`). So the SDK's whole duty is to send
// the key on the arm that can honour it and send NOTHING on the arm that
// cannot — a stale `'ultraWide'` riding an ARCore sweep would come back
// `lensHonoured: false` on a lens the operator never chose for that sweep.

describe('what crosses the bridge matches which arm is running', () => {
  it('sends no lens at all on the AR arm, even with the flag on 0.5×', async () => {
    // The fresh-device pair. `lensRequested` must be null here, so the
    // recorder reports `lensRan` (camera 0, by band) with `lensHonoured: false`
    // and a note saying no lens was requested — rather than a claim that
    // somebody asked for the ultra-wide and ARCore refused.
    const r = mount('ultraWide', 'ar');
    await settle();
    r.sweep();
    await settle();
    expect(startedWith).not.toBeNull();
    expect(startedWith?.poseSource).toBe('ar');
    expect(startedWith).not.toHaveProperty('lens');
    r.unmount();
  });

  it('sends the chosen lens on the decoupled arm', async () => {
    const r = mount('ultraWide', 'imu');
    await settle();
    r.sweep();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');
    expect(startedWith?.lens).toBe('ultraWide');
    r.unmount();
  });

  it('a 0.5× choice made on the AR arm produces a sweep that is decoupled AND 0.5×',
    async () => {
      // M10 — converted from "a 0.5× TAP on the AR arm". The chip that wrote
      // both flags is deleted; what it wrote is re-rendered here, which is all
      // the engine ever saw of the tap. The end-to-end half survives: the bag
      // that crosses the bridge agrees with the (lens, arm) the host now holds,
      // after the engine has re-read the store for the new arm and lens.
      const r = mount('wide', 'ar');
      await settle();
      r.rerender('ultraWide', 'imu');
      await settle();
      r.sweep();
      await settle();
      expect(startedWith?.poseSource).toBe('imu');
      expect(startedWith?.lens).toBe('ultraWide');
      r.unmount();
    });

  it('the FALLBACK rung sends no lens — the arm that runs cannot honour it',
    async () => {
      // M10 — converted from section 5's "holds on the FALLBACK rung too",
      // which pinned the CHIP painting `1×` there. The chip is gone; the claim
      // under it was always about the arm: an uncalibrated phone with the
      // decoupled arm requested at 0.5× runs ARKit, and ARKit runs the wide.
      // The flag-painting chip once showed `0.5×` in exactly this state; a bag
      // that sent `lens: 'ultraWide'` here would write the same lie into the
      // pack.
      snapshotImpl = UNCALIBRATED;
      const r = mount('ultraWide', 'imu');
      await settle();
      r.sweep();
      await settle();
      expect(startedWith?.poseSource).toBe('ar');
      expect(startedWith).not.toHaveProperty('lens');
      r.unmount();
    });
});

// ── THE DROPPED LENS REACHES THE SCREEN ────────────────────────────────────
//
// ⚠ THIS EXISTS BECAUSE THE WIRE HAD NO TEST AND THE MUTATION PROVED IT.
// `panoPlusArmNotice` learned to name a lens the arm declined, and its own
// suite covers that. But the ENGINE has to hand it the lens — one argument,
// in one call — and with that argument deleted the entire 787-case sweep
// suite stayed green. A pure function nobody feeds correctly is the
// vacuous-pass family this package keeps finding in itself.
describe('the engine tells the notice which lens was asked for', () => {
  beforeEach(() => { Platform.OS = 'ios'; });
  afterEach(() => { Platform.OS = 'ios'; });

  it('⚑ 0.5× + a declined IMU arm says so ON SCREEN', async () => {
    // The shipped iPhone state, and the one the operator reported: he asked
    // for the ultra-wide, the arm fell back to ARKit, and nothing said the
    // lens had gone with it.
    //
    // M10 — now asserted on the SETTLED decline (`UNCALIBRATED`, read
    // landed). It used to be read before the store answered, i.e. on the
    // "this build cannot answer" rung the in-flight frame happens to render —
    // which passed for a reason other than the one this case is named for.
    snapshotImpl = UNCALIBRATED;
    const rig = mount('ultraWide', 'imu');
    await settle();
    expect(rig.text()).toContain('0.5× UNAVAILABLE');
    rig.unmount();
  });

  it('⚑ NEGATIVE CONTROL: the same declined arm at 1× says nothing about lenses', async () => {
    // Without this the case above passes for an engine that shouts about the
    // ultra-wide on every fallback, including ones nobody asked a lens for.
    snapshotImpl = UNCALIBRATED;
    const rig = mount('wide', 'imu');
    await settle();
    // …and the notice IS up — otherwise "says nothing" is vacuous.
    expect(rig.text()).toContain('IMU ARM —');
    expect(rig.text()).not.toContain('0.5× UNAVAILABLE');
    rig.unmount();
  });
});
