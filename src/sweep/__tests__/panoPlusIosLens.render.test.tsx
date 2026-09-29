// SPDX-License-Identifier: Apache-2.0
//
// THE iOS LENS CHOICE REACHES NATIVE — for the IDLE VIEWFINDER and for the
// ARM PRECONDITION READ — mounted for real.
//
// pano+ ⇄ Pano parity (2026-09-03): Pano's lens chip writes the host flag
// `panoPlusLens`, the host hands it to this surface as `lens`, and on the
// decoupled iOS arm two native calls must carry it in the flag's own spelling:
//
//   * `RNSSweepSession.setIdlePreview(true, { lens, poseSource })` — the
//     viewfinder must show the camera the sweep will open, and a flip at idle
//     must be a clean off→on on the new lens (never two requests live at once);
//   * `RNSSweepCalibration.plannedCaptureFormat({ lens })` — τ is keyed per
//     lens, so the precondition that gates the arm must be read for the camera
//     the sweep will actually open, and re-read when the lens changes.
//
// The sweep's own `start({ lens })` is the same ownership rule one function
// down and is pinned for the Android arm in `panoPlusAndroidSurface.render`
// ("sends the arm the button named, and the lens with it"); its iOS trigger is
// the shell's hold gesture after parity, so that assertion lives with the
// shutter wiring rather than here.
//
// The property under test: WHAT CROSSES THE BRIDGE IS THE LENS THE FLAG NAMED.
// A viewfinder framing through the ultra-wide for a sweep recorded on the wide
// is 1.85× of picture the operator will not get.
//
// M10 — the sweep's own screen and its lens chip are deleted, and with the
// chip the lens-AVAILABILITY probe that fed it (`panoPlusLensAvailability`).
// The engine is mounted through `SweepEngineHarness`; the lens arrives as the
// host's `lens` prop, exactly as before — only the chip that wrote it is gone.

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
import { ARCameraView } from '../../camera/ARCameraView';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';

const NM = NativeModules as Record<string, unknown>;

type Lens = 'ultraWide' | 'wide';

/** Every `setIdlePreview` call, in order — the thing under test. */
let idleCalls: Array<{ on: boolean; options: Record<string, unknown> }> = [];
/**
 * iOS's own answer for "did the viewfinder get the sweep's format AND rate" —
 * `previewFormatApplied` (`RNISPanoAvfSource.swift:407`). `null` is the
 * pre-2026-09-07 answer, which said nothing. Spliced into the reply below so a
 * test can put native on the branch its `do`/`catch` actually has.
 */
let idleFormatApplied: boolean | null = null;
/** Every `plannedCaptureFormat` key, in order. */
let planKeys: Array<Record<string, unknown>> = [];
/**
 * HOLD THE PLANNER OPEN, so the window the calibration cache exists to close
 * can actually be looked into.
 *
 * `plannedCaptureFormat` resolves synchronously in this rig, which collapses
 * the exact interval under test: on a device that call is the first link of a
 * serial native chain and the operator experiences it as "the camera has not
 * opened yet" for SECONDS on every AR→0.5× flip. When this is set, the next
 * planner calls hang and their resolvers land here for the test to fire by
 * hand.
 */
let planPending: Array<() => void> = [];
let planHangs = false;
/** The options bag the last `start()` received. */
let startedWith: Record<string, unknown> | null = null;

const DEVICE_TYPE: Record<Lens, string> = {
  ultraWide: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
  wide: 'AVCaptureDeviceTypeBuiltInWideAngleCamera',
};

function installNative(): void {
  idleCalls = [];
  planKeys = [];
  planPending = [];
  planHangs = false;
  startedWith = null;
  NM.RNSSweepSession = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      return Promise.resolve({
        sessionDir: '/var/mobile/Documents/pano_1',
        startedAtMs: 1,
        pluginAvailable: true,
        poseSource: o.poseSource,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: false }),
    // Registered so the idle path is reachable at all — without it the SDK
    // short-circuits to "this build carries no idle-viewfinder method".
    setIdlePreview: (on: boolean, o: Record<string, unknown>) => {
      idleCalls.push({ on, options: o });
      // Native's parity-era answer: the lens that is live, in both spellings.
      const lens = typeof o.lens === 'string' ? (o.lens as Lens) : 'ultraWide';
      // ⚠ `on: true` EVEN WHEN THE FORMAT DID NOT TAKE. A lock failure at idle
      // is deliberately non-fatal in native — the session still starts and the
      // feed is still worth showing; what must not happen is showing it while
      // CLAIMING it matches (`RNISPanoAvfSource.swift:376-380`, `:394-410`).
      return Promise.resolve(on
        ? {
          on: true,
          reason: `idle viewfinder LIVE on the ${lens} (${DEVICE_TYPE[lens]})`
            + (idleFormatApplied === false
              ? ', PREVIEW FORMAT NOT APPLIED (locked) — this viewfinder does '
                + 'NOT match what the sweep will record'
              : ''),
          lens: DEVICE_TYPE[lens],
          lensRequested: lens,
          ...(idleFormatApplied == null
            ? {}
            : { previewFormatApplied: idleFormatApplied }),
        }
        : { on: false });
    },
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
    // The planner answers FOR THE LENS ASKED, as native does: the device
    // type follows the request, and the τ key follows the device type.
    plannedCaptureFormat: (o: Record<string, unknown>) => {
      planKeys.push(o);
      const lens: Lens = o.lens === 'wide' ? 'wide' : 'ultraWide';
      const answer = {
        ok: true,
        lens: DEVICE_TYPE[lens],
        lensRequested: lens,
        width: 1920, height: 1440, fps: 60,
        tauKey: `iPhone17,1|${DEVICE_TYPE[lens]}|1920x1440|60`,
        basisKey: 'iPhone17,1',
      };
      if (planHangs) {
        return new Promise((resolve) => {
          planPending.push(() => { resolve(answer); });
        });
      }
      return Promise.resolve(answer);
    },
    // Calibrated for BOTH lenses, so the arm is usable on either and the idle
    // viewfinder is wanted on either.
    getCalibration: () => Promise.resolve({
      resolved: {
        haveTau: true, haveBasis: true, complete: true, missing: null,
        tauS: -0.0042, tauStdErrMs: 0.31, basisIndex: 5, basisLabel: '+y+z+x',
      },
    }),
  };
}

interface Rig {
  /** Is the stitcher's `<ARCameraView>` mounted? Found by TYPE — the harness
   *  draws the real component. */
  hasArView: () => boolean;
  has: (testID: string) => boolean;
  /** Re-render with a new `lens` prop — what the host does when ITS chip
   *  writes `panoPlusLens`. */
  setLens: (lens: Lens) => void;
  unmount: () => void;
}

function element(lens: Lens): React.ReactElement {
  return (
    <SweepEngineHarness
      onComplete={() => undefined}
      onCancel={() => undefined}
      poseSource="imu"
      lens={lens}
    />
  );
}

function mount(lens: Lens): Rig {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element(lens));
  });
  act(() => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
  });
  return {
    hasArView: () => renderer.root.findAllByType(ARCameraView).length > 0,
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    setLens: (next) => {
      act(() => { renderer.update(element(next)); });
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

const onCalls = (): Array<Record<string, unknown>> =>
  idleCalls.filter((c) => c.on).map((c) => c.options);

beforeEach(() => {
  jest.useFakeTimers();
  Platform.OS = 'ios';
  idleFormatApplied = null;
  installNative();
});
afterEach(() => {
  jest.useRealTimers();
  Platform.OS = 'ios';
  delete NM.RNSSweepSession;
  delete NM.RNSSweepCalibration;
});

describe('the idle viewfinder frames with the lens the flag named (iOS, decoupled arm)', () => {
  it('asks for the WIDE when the flag says wide, and says which arm', async () => {
    const r = mount('wide');
    await settle();
    // The IMU arm is confirmed usable (calibrated), so ARKit is not mounted
    // and the arm's own viewfinder is what the operator frames through.
    expect(r.hasArView()).toBe(false);
    const asked = onCalls();
    expect(asked.length).toBeGreaterThan(0);
    const last = asked[asked.length - 1]!;
    expect(last.lens).toBe('wide');
    expect(last.poseSource).toBe('imu');
    r.unmount();
  });

  it('asks for the ULTRA-WIDE when the flag says so — the flag spelling, never a chip label', async () => {
    const r = mount('ultraWide');
    await settle();
    const asked = onCalls();
    const last = asked[asked.length - 1]!;
    expect(last.lens).toBe('ultraWide');
    // Native refuses '0.5x' / '1x' by design (`panoplus-bad-lens`): the host
    // maps Pano's chip onto the flag, and only the flag crosses the bridge.
    expect(last.lens).not.toMatch(/x$/);
    r.unmount();
  });

  it('a flip at idle is OFF on the old lens then ON on the new one, in that order', async () => {
    const r = mount('ultraWide');
    await settle();
    const before = idleCalls.length;
    r.setLens('wide');
    await settle();
    const after = idleCalls.slice(before);
    // The effect's cleanup releases the old request BEFORE the new one is
    // made: one owner at a time, so native never sees two live requests
    // and can do its clean close→open on the new camera.
    const firstOn = after.findIndex((c) => c.on);
    const firstOff = after.findIndex((c) => !c.on);
    expect(firstOff).toBeGreaterThanOrEqual(0);
    expect(firstOn).toBeGreaterThan(firstOff);
    expect(after[firstOn]!.options.lens).toBe('wide');
    expect(after[firstOn]!.options.poseSource).toBe('imu');
    r.unmount();
  });

  it('⚑ a flip BACK to a lens already read keeps the viewfinder up — no black screen', async () => {
    // ⚠ THE GAP IS THE TIMING, AND THE TIMING IS OBSERVABLE. This fix was
    // shipped with "no falsifiable test" written against it; that was wrong.
    //
    // `armPendingForIdle` is `!calibRead` and `avfIdleWanted` ANDs
    // `!armPendingForIdle`, so clearing the snapshot on every flip took the
    // idle viewfinder DOWN and did not even ASK for the camera again until
    // the native round trip returned. On the device that chain is seconds,
    // which is the operator's own report — "I saw the camera has not opened
    // yet for ~5 sec going from AR to 0.5×; it is almost instant in pano".
    //
    // The snapshot is keyed by lens and nothing on this screen writes the
    // store (M10 removed the in-camera gesture, and with it `calibEpoch`), so
    // a flip BACK to a lens already read can reuse its answer, keep the
    // viewfinder up, and still re-read in the background.
    const r = mount('wide');
    await settle();
    r.setLens('ultraWide');
    await settle();          // both lenses are now in the cache

    // Now make the native round trip take real time, as it does on a phone.
    planHangs = true;
    const before = idleCalls.length;
    r.setLens('wide');
    await settle();
    const after = idleCalls.slice(before);

    // WITH THE CACHE: the viewfinder is asked for immediately, on the new
    // lens, while the planner is still out.
    expect(planPending).toHaveLength(1);          // …and it genuinely IS out
    const on = after.filter((c) => c.on);
    expect(on).toHaveLength(1);
    expect(on[0]!.options.lens).toBe('wide');
    // …and the last thing native was told is not "off".
    expect(after[after.length - 1]!.on).toBe(true);

    // The background re-read still lands, and changes nothing the operator
    // can see — the cache is a head start, not a replacement.
    act(() => { planPending.forEach((f) => { f(); }); });
    await settle();
    expect(idleCalls.filter((c) => c.on).slice(-1)[0]!.options.lens).toBe('wide');
    r.unmount();
  });

  it('⚑ …but a lens NEVER read still waits — the cache is not a guess', async () => {
    // Negative control. Without it the case above passes for a build that
    // simply stopped clearing the snapshot at all, which would show the idle
    // viewfinder on an arm whose precondition has never been answered.
    planHangs = true;
    const r = mount('wide');
    await settle();
    expect(planPending).toHaveLength(1);
    expect(idleCalls.filter((c) => c.on)).toHaveLength(0);
    act(() => { planPending.forEach((f) => { f(); }); });
    await settle();
    expect(idleCalls.filter((c) => c.on)).toHaveLength(1);
    r.unmount();
  });

  it('releases the viewfinder on unmount', async () => {
    const r = mount('wide');
    await settle();
    const before = idleCalls.length;
    r.unmount();
    const after = idleCalls.slice(before);
    expect(after.some((c) => !c.on)).toBe(true);
    expect(after.some((c) => c.on)).toBe(false);
  });
});

describe('the arm precondition is read for the lens the sweep will open', () => {
  it('asks the planner with the flag lens, and re-asks on a flip', async () => {
    const r = mount('wide');
    await settle();
    // τ is keyed `model|lens|WxH|fps`. Reading it for the ultra-wide while the
    // sweep opens the wide would gate this arm on a calibration for a camera
    // it is not about to use.
    //
    // ⚠ EVERY CALL, NOT JUST THE FIRST (M10). This used to read `planKeys[0]`
    // because the lens-AVAILABILITY probe (the chip's `has0_5x`) asked the
    // same planner for BOTH lenses at mount. The probe is deleted with the
    // chip, so the arm read is the only thing that asks — and every question
    // it asks is about the lens the flag names.
    expect(planKeys.length).toBeGreaterThan(0);
    expect(planKeys.map((k) => k.lens)).toEqual(planKeys.map(() => 'wide'));
    const before = planKeys.length;
    r.setLens('ultraWide');
    await settle();
    // Exactly ONE new question, about the new lens.
    expect(planKeys.slice(before).map((k) => k.lens)).toEqual(['ultraWide']);
    r.unmount();
  });

  // ⚠ THE CALIBRATION-CACHE GAP IS CLOSED — see the two ⚑ cases in the
  // block above. It was recorded here as untestable ("the gap is the
  // TIMING, and the rig has no clock the surface is racing against"), and
  // that was wrong: the rig had no clock because its planner resolved
  // SYNCHRONOUSLY, which collapsed the whole interval under test. Giving the
  // planner fake a `planHangs` switch — one that makes it behave like the
  // device, where it is the first link of a serial native chain — makes the
  // window a test can look into, and both directions of the fix now die
  // under mutation. A rig limitation is worth naming; it is not worth
  // believing without trying to remove it.

  // The lens-availability probe (`panoPlusLensAvailability`, the chip's `has0_5x`) — deleted in M10.

  it('nothing here touched start(): no sweep was begun by mounting or flipping', async () => {
    const r = mount('wide');
    await settle();
    r.setLens('ultraWide');
    await settle();
    expect(startedWith).toBeNull();
    r.unmount();
  });
});

// The clone lens chip's offer (both pills / static 1× / Android both pills) — deleted in M10.

describe('iOS says on SCREEN when the viewfinder does not match the sweep', () => {
  // ── THE FAULT THAT REACHED NATIVE AND STOPPED THERE ──────────────────────
  //
  // `startIdlePreviewOnSessionQ` takes the device lock inside a `do`/`catch`
  // (`RNISPanoAvfSource.swift:382-392`) and sets `activeFormat` plus both frame
  // durations inside it. A throw — another client holding the config lock, a
  // transient — leaves `formatApplied` false, and the catch is deliberately NOT
  // fatal: the session still starts and native returns `on: true` with
  // "PREVIEW FORMAT NOT APPLIED (…) — this viewfinder does NOT match what the
  // sweep will record" inside `reason` (`:400-410`).
  //
  // Three layers then swallowed it. `setPanoPlusIdlePreview` never coerced
  // `previewFormatApplied`, so the flag died at the bridge;
  // `setIdleReason(res.on ? '' : res.reason)` clears the sentence precisely
  // BECAUSE `on` is true; and `panoPlusCameraOffNotice` returns null while the
  // feed is live. Net, before this test: the operator framed a 16:9 viewfinder
  // for a 4:3 sweep — the field incident recorded at
  // `RNISPanoAvfSource.swift:331-345`, "a band above and below what he had
  // framed" — and NOTHING on the panel said so.
  //
  // ⚠ WHAT THIS CANNOT PROVE: how often that lock actually throws on the
  // operator's iPhone. No device is reachable from here. The branch is
  // explicitly authored for in native, with its own operator-facing sentence;
  // that is why it is wired, not because a frequency was measured.

  it('shows the mismatch when native declined the format', async () => {
    idleFormatApplied = false;
    const r = mount('wide');
    await settle();
    expect(r.has('panoplus-preview-pin')).toBe(true);
    r.unmount();
  });

  it('says nothing when the format APPLIED — a matching viewfinder explains itself', async () => {
    idleFormatApplied = true;
    const r = mount('wide');
    await settle();
    expect(r.has('panoplus-preview-pin')).toBe(false);
    r.unmount();
  });

  it('says nothing on a build that does not report it — silence is not evidence', async () => {
    idleFormatApplied = null;
    const r = mount('wide');
    await settle();
    expect(r.has('panoplus-preview-pin')).toBe(false);
    r.unmount();
  });
});
