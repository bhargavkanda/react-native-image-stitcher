// SPDX-License-Identifier: Apache-2.0
//
// THE BASIS LADDER'S EFFECT ON THE RUNNING ARM — WITH NO GESTURE TO OFFER.
//
// ── What this file was, and what is left of it (M10) ──────────────────────
//
// It was the first-run basis ACQUISITION suite: the card that came up by
// itself on an uncalibrated iPhone, armed the recorder against a live ARKit
// session, coached the gesture, solved, saved, re-read the store and got out
// of the way — and the chrome that had to stand aside while it did. M10
// deleted that card (`PanoPlusBasisOverlay`, decision D3(a)) together with the
// sweep's own screen, and with it every case here that measured the card.
//
// The LADDER is unchanged (`resolvePanoPlusBasis`: stored ▸ derived ▸ gesture
// ▸ blocked), and it still decides which arm a sweep runs on. What this file
// pins now is that effect, rung by rung, on each arm contract — mounted
// through `SweepEngineHarness` (the real `useSweepEngine`, drawn by the DR-1a
// hatch view) and driven the way `<Camera>` drives it: a hold through the
// handle, the shutter's state through `onControlsState`, an arm change as a
// re-render.
//
//   · iOS, own camera, no basis on file → the `gesture` rung, which nothing
//     mounts any more: the arm FALLS BACK to ARKit and the arm notice says so.
//   · Android → the `derived` rung: no store read, no gesture, the IMU arm runs.
//   · iOS on `<Camera>`'s vision-camera (the vc host arm) → no ladder at all:
//     no store read, τ = 0, the basis derived natively at the hold.
//
// ⚠ THIS FILE MUST LIVE IN `__tests__/`. The BUILD tsconfig excludes
// `**/*.test.ts` and `**/__tests__/**` — note the FIRST pattern does not match
// `.tsx`, so a `.render.test.tsx` sitting beside its component is compiled into
// `dist/` and fails the build on `react-test-renderer`, which ships no
// declarations.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

// The pack's arm notice is OBSERVABLE here — `host_notice.json` is the record
// of which arm ran and why, and "says so" has to hold in the pack as well as
// on the screen.
jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///var/mobile/Documents/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: (uri: string, body: string) => {
      (globalThis as unknown as { __ppBasisWritten: Array<unknown> })
        .__ppBasisWritten.push({ uri, body });
      return Promise.resolve();
    },
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);
const written: Array<{ uri: string; body: string }> = [];
(globalThis as unknown as { __ppBasisWritten: unknown[] }).__ppBasisWritten = written;

import { SweepEngineHarness } from './sweepEngineHarness';
import { ARCameraView } from '../../camera/ARCameraView';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';
import type { SweepEngineProps } from '../sweepEngineProps';
import type {
  PanoPlusFailure,
  SweepSurfaceHandle,
  SweepSurfaceState,
} from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** Every CALIBRATION call the engine made, in order. */
let calibCalls: string[] = [];
/** The store snapshot. */
let snapshot: Record<string, unknown> = {
  haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis',
};
/** The options bag the last `start()` received. */
let startedWith: Record<string, unknown> | null = null;
/** Extra keys native answers `start()` with — the vc host arm's echo. */
let startAnswers: Record<string, unknown> = {};

function installNative(): void {
  calibCalls = [];
  startedWith = null;
  startAnswers = {};
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      return Promise.resolve({
        sessionDir: '/d/pp_1', startedAtMs: 1, pluginAvailable: true,
        ...startAnswers,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: false }),
  };
  NM.RNSSweepCalibration = {
    plannedCaptureFormat: () => {
      calibCalls.push('plannedCaptureFormat');
      return Promise.resolve({
        ok: true,
        lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
        width: 1920, height: 1440, fps: 60,
        tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
        basisKey: 'iPhone17,1',
      });
    },
    getCalibration: () => {
      calibCalls.push('getCalibration');
      return Promise.resolve({ resolved: snapshot });
    },
    startBasisCalibration: () => {
      calibCalls.push('startBasisCalibration');
      return Promise.resolve({ started: true });
    },
    basisCalibrationStatus: () => Promise.resolve({}),
    stopBasisCalibration: () => Promise.resolve({}),
    resolveBasisCalibration: () => Promise.resolve({}),
    discardBasisCalibration: () => Promise.resolve({ discarded: true }),
    saveBasisCalibration: () => Promise.resolve({ saved: true }),
    saveTauCalibration: () => Promise.resolve({}),
    combineTauRuns: () => Promise.resolve({}),
    clearCalibration: () => Promise.resolve({}),
  };
}

type Props = Partial<SweepEngineProps>;

interface Rig {
  shows: (needle: string) => boolean;
  has: (testID: string) => boolean;
  /** Is `<ARCameraView>` mounted — is this engine starting ARKit? By
   *  component as well as by the render seam's `ar-camera` testID:
   *  `SweepHatchScreen` imports the view directly, so the REAL one mounts
   *  under the harness. */
  arView: () => boolean;
  /** What `<Camera>`'s shutter calls on a hold past the threshold. */
  hold: () => void;
  /** The LAST `onControlsState` report — what the host's shutter paints. */
  controls: () => SweepSurfaceState | undefined;
  failures: PanoPlusFailure[];
  rerender: (props: Props) => void;
  unmount: () => void;
}

function mount(props: Props): Rig {
  const handle = React.createRef<SweepSurfaceHandle>();
  const reports: SweepSurfaceState[] = [];
  const failures: PanoPlusFailure[] = [];
  const element = (p: Props): React.JSX.Element => (
    <SweepEngineHarness
      ref={handle}
      onComplete={() => undefined}
      onCancel={() => undefined}
      onControlsState={(s) => { reports.push(s); }}
      onFailure={(f) => { failures.push(f); }}
      {...p}
    />
  );
  let renderer!: ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(element(props)); });
  act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
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
    arView: () => renderer.root.findAll(
      (n) => n.type === ARCameraView || n.props?.testID === 'ar-camera',
    ).length > 0,
    hold: () => { act(() => { handle.current?.holdStart?.(); }); },
    controls: () => reports[reports.length - 1],
    failures,
    rerender: (p) => { act(() => { renderer.update(element(p)); }); },
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

/**
 * LET THE AR SESSION COME UP — the swap grace, advanced AFTER the arm settles.
 *
 * ⚠ NEEDED SINCE 2026-09-03 AND THAT IS THE FIX, NOT A TEST WORKAROUND. The
 * grace used to be a one-shot timer keyed on the mount, so it had always
 * elapsed by the time the precondition read landed and `arArmed` turned true.
 * It is now keyed on `arArmed`, so the sequence is the one the constant was
 * written for: the arm resolves, then one grace passes, then ARKit is started.
 * A test that skips this is asserting about a session that has not been
 * started yet.
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

beforeEach(() => {
  jest.useFakeTimers();
  installNative();
  snapshot = {
    haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis',
  };
  written.length = 0;
  // The engine asks `Platform.OS` ONCE, at mount, through
  // `panoPlusArmContract` — flipping the shared mock before mounting is
  // enough, and no module has to be re-required.
  (Platform as { OS: string }).OS = 'ios';
});
afterEach(() => {
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

// ── Deleted in M10 — the basis card and its gesture flow ───────────────────
// Mounting by itself and arming the recorder; staying off the AR arm and off a
// phone with a basis on file; the coaching (pan-only, no-reference, the
// reference grace); the shutter disabled under the card; a sufficient gesture
// solving, saving and RE-READING the store; refusals never persisted and the
// retry re-recording; SKIP; the no-ultra-wide phone never offered it; the
// recorder discarded on unmount; the four properties of the operator's gate
// (a)–(d), including the 0.5× and AR-pill doors onto it; the card hidden again
// when the arm moves back to ARKit; and the Android `armCanAcquireBasis`
// guard, reached through a forced `gesture` route. All of it was the card
// (`PanoPlusBasisOverlay`), deleted in M10 per D3(a).
//
// ── Deleted in M10 — the clone chrome standing aside for the card ──────────
// The AR pill and lens chip hidden while the gesture was live, and "a tap on
// every control the surface still offers" leaving the recorder alone. The pill
// and chip (`PanoArToggle`, `PanoLensChip`) are deleted in M10.
//
// ── Deleted in M10 — onEffectiveArmChange / chromeSuppressed ──────────────
// `basisRoute: 'not-asked'` on the AR arm vs `'blocked'` on a rejecting
// module, and `chromeSuppressed` while the card was up. The effective-arm
// report is deleted in M10; on iOS nothing else reads the route (the arm
// notice reads only `needsGesture`, and not at all on the AR arm).
//
// Pinned elsewhere, not here: the AR arm makes no calibration call
// (`panoPlusPoseSource.render`, "makes NO calibration call at all"); the
// no-ultra-wide HARDWARE refusal (same file, "the HARDWARE refusal is not the
// calibration refusal").

describe('iOS, own camera, NO basis on file — the gesture rung falls back', () => {
  it.each([
    // [label, tauUncorrected, what the headline must name]
    ['a τ = 0 sweep', true, 'BASIS'],
    ['an ordinary IMU sweep', false, 'missing tau+basis'],
  ] as const)(
    '%s falls back to ARKit, SAYS so on the arm notice and in the pack, and captures',
    async (_label, tauUncorrected, needle) => {
      // THE RUNG WITH NOTHING BEHIND IT. `resolvePanoPlusBasis` still answers
      // `gesture` for this phone — iOS cannot derive C — and nothing mounts a
      // gesture any more. The arm must still do what it did when the operator
      // SKIPPED the card: run on ARKit, and say so.
      //
      const r = mount({ poseSource: 'imu', tauUncorrected });
      await flush();
      expect(r.has('panoplus-arm-headline')).toBe(true);
      expect(r.shows(needle)).toBe(true);
      // ⚠ AND IT PROMISES NO GESTURE (M10 review). The engine used to pass the
      // ladder's `needsGesture` to the notice as `basisGestureOffered`, so
      // with the card deleted it still read "MEASURING THE BASIS … move the
      // phone on TWO axes" — guidance nothing draws.
      expect(r.shows('MEASURING THE BASIS')).toBe(false);
      expect(r.shows('TWO axes')).toBe(false);

      // M10 — converted from "the shutter is DISABLED while the basis is being
      // measured" and "SKIP gives the shutter back": there is no card to hold
      // the shutter, so the fallback is capturable the moment the read lands.
      expect(r.controls()?.canCapture).toBe(true);

      // The fallback runs on ARKit, so it needs its AR session — one grace
      // after the arm resolved.
      await arGrace();
      expect(r.arView()).toBe(true);

      r.hold();
      await flush();
      expect(startedWith?.poseSource).toBe('ar');
      // An ARKit sweep is a corrected one whatever was declared, and ARKit
      // runs the wide whatever lens was asked for.
      expect('tauUncorrected' in (startedWith ?? {})).toBe(false);
      expect('lens' in (startedWith ?? {})).toBe(false);

      // …and the PACK records the downgrade as a downgrade.
      const notice = written.find((w) => w.uri.endsWith('host_notice.json'));
      expect(notice).toBeDefined();
      const body = JSON.parse(notice!.body) as Record<string, unknown>;
      expect(body.poseSourceRequested).toBe('imu');
      expect(body.poseSourceEffective).toBe('ar');
      expect(body.fallbackToAr).toBe(true);
      r.unmount();
    },
  );

  it('an arm moved onto the IMU arm under a mounted engine restarts ARKit only after a fresh grace', async () => {
    // M10 — converted from "re-arms the swap grace when <ARCameraView>
    // REMOUNTS on the 0.5× door". The door (the sweep screen's lens chip / AR
    // pill) is deleted; what it did to the engine was write `poseSource:
    // 'imu'`, and that is what the re-render does here. The engine behaviour
    // it pinned is the engine's own and still load-bearing: mounting
    // `<ARCameraView>` IS `RNSARSession.shared.start()`, so a session torn
    // down on one commit and stood back up on the next — with the grace
    // already spent — races the engine's own `stop()`. (The card that read
    // `arLive` is gone; the race is not.)
    const r = mount({ poseSource: 'ar' });
    await flush();
    await arGrace();
    expect(r.arView()).toBe(true);

    r.rerender({ poseSource: 'imu' });
    // The commit the change produced, BEFORE the read lands: the session is
    // down. This is `RNSARSession.shared.stop()` having been called.
    expect(r.arView()).toBe(false);

    // The read lands and the notice falls back, so the engine wants ARKit
    // again — but it must NOT stand it back up on the same commit it tore it
    // down.
    await flush();
    expect(calibCalls).toContain('getCalibration');
    expect(r.has('panoplus-arm-headline')).toBe(true);
    expect(r.arView()).toBe(false);

    // One grace later the session is up.
    await arGrace();
    expect(r.arView()).toBe(true);
    r.unmount();
  });
});

describe('Android DERIVES C — the IMU arm runs with no gesture and no store read', () => {
  it('reads no store, says the basis is derived, and sends the IMU arm', async () => {
    // `panoPlusBasisCapability('android')`: SENSOR_ORIENTATION pins the camera
    // raster to a documented sensor frame, so C is the product of two
    // documented rotations and no hands are needed. The pack says `derived`.
    (Platform as { OS: string }).OS = 'android';
    const r = mount({ poseSource: 'imu' });
    await flush();
    // The Android contract asks the iOS calibration module NOTHING — a read
    // there resolves `calib-unavailable` and would have fallen back to AR
    // with a banner blaming a pod Android does not use.
    expect(calibCalls).toEqual([]);
    // The `derived` rung, on screen in the pack's own word.
    expect(r.shows('BASIS DERIVED')).toBe(true);
    expect(r.controls()?.canCapture).toBe(true);
    r.hold();
    await flush();
    expect(startedWith?.poseSource).toBe('imu');
    r.unmount();
  });
});

describe('the vc host arm (iOS on <Camera>\'s camera) needs no ladder at all', () => {
  it('reads no store, draws no notice, and sends the IMU arm at τ = 0', async () => {
    // M5: τ is 0 by default on this arm (D2) and the basis is DERIVED natively
    // from the open camera when the hold starts (D3) — so there is no rung to
    // climb, no fallback to take and nothing to measure before the shutter.
    // The deep coverage of this arm is `panoPlusIosVcHostArm.render`; this is
    // the ladder's side of it.
    //
    // Native CONFIRMS the arm it ran (the M5 fail-closed echo), so a clean
    // start here reports no failure at all.
    startAnswers = { poseSource: 'imu', frameSource: 'vc-plugin', opensAvCaptureSession: false };
    const r = mount({
      frameSource: 'host',
      poseSource: 'imu',
      vcPluginArm: true,
      vcCameraId: 'com.apple.avfoundation.avcapturedevice.built-in_video:0',
    });
    await flush();
    expect(calibCalls).toEqual([]);
    // The notice is a statement for the pack, not a precondition on screen.
    expect(r.has('panoplus-arm-headline')).toBe(false);
    expect(r.controls()?.canCapture).toBe(true);
    r.hold();
    await flush();
    expect(r.failures).toEqual([]);
    expect(startedWith?.poseSource).toBe('imu');
    expect(startedWith?.tauUncorrected).toBe(true);
    r.unmount();
  });
});
