// SPDX-License-Identifier: Apache-2.0
//
// THE iOS LENS CHOICE REACHES NATIVE — for the IDLE VIEWFINDER and for the
// ARM PRECONDITION READ — mounted for real.
//
// pano+ ⇄ Pano parity (2026-09-03): Pano's lens chip writes the host flag
// `panoPlusLens`, the host hands it to this surface as `lens`, and on the
// decoupled iOS arm two native calls must carry it in the flag's own spelling:
//
//   * `RNISPanoPlus.setIdlePreview(true, { lens, poseSource })` — the
//     viewfinder must show the camera the sweep will open, and a flip at idle
//     must be a clean off→on on the new lens (never two requests live at once);
//   * `RNISPanoCalib.plannedCaptureFormat({ lens })` — τ is keyed per
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

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
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
 * Lenses the planner REFUSES, and with which code — a body that publishes no
 * ultra-wide, or one whose lens has no 4:3 format at 60 fps. Empty by default:
 * both lenses open, which is every phone this arm has run on.
 */
let planRefuse: Partial<Record<Lens, string>> = {};
/** The options bag the last `start()` received. */
let startedWith: Record<string, unknown> | null = null;

const DEVICE_TYPE: Record<Lens, string> = {
  ultraWide: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
  wide: 'AVCaptureDeviceTypeBuiltInWideAngleCamera',
};

function installNative(): void {
  idleCalls = [];
  planKeys = [];
  planRefuse = {};
  startedWith = null;
  NM.RNISPanoPlus = {
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
    // The planner answers FOR THE LENS ASKED, as native does: the device
    // type follows the request, and the τ key follows the device type.
    plannedCaptureFormat: (o: Record<string, unknown>) => {
      planKeys.push(o);
      const lens: Lens = o.lens === 'wide' ? 'wide' : 'ultraWide';
      const refused = planRefuse[lens];
      if (refused != null) {
        // Native's refusal shape: no format, the code, and the REQUEST kept
        // beside it so the caller never has to match a bare reason back to
        // its own question.
        return Promise.resolve({
          ok: false, reason: refused, detail: `${refused} on this body`,
          lens: null, lensRequested: lens,
          width: null, height: null, fps: 60,
          tauKey: null, basisKey: 'iPhone17,1',
        });
      }
      return Promise.resolve({
        ok: true,
        lens: DEVICE_TYPE[lens],
        lensRequested: lens,
        width: 1920, height: 1440, fps: 60,
        tauKey: `iPhone17,1|${DEVICE_TYPE[lens]}|1920x1440|60`,
        basisKey: 'iPhone17,1',
      });
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
  has: (testID: string) => boolean;
  /** Re-render with a new `lens` prop — what the host does when the chip
   *  writes `panoPlusLens`. */
  setLens: (lens: Lens) => void;
  unmount: () => void;
}

function element(lens: Lens, onLensChange: (l: Lens) => void): React.ReactElement {
  return (
    <PanoPlusCaptureSurface
      onComplete={() => undefined}
      onCancel={() => undefined}
      poseSource="imu"
      lens={lens}
      onLensChange={onLensChange}
    />
  );
}

function mount(lens: Lens): Rig {
  let renderer!: ReactTestRenderer;
  const onLensChange = (): void => undefined;
  act(() => {
    renderer = TestRenderer.create(element(lens, onLensChange));
  });
  act(() => {
    jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1);
  });
  return {
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    setLens: (next) => {
      act(() => { renderer.update(element(next, onLensChange)); });
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
  delete NM.RNISPanoPlus;
  delete NM.RNISPanoCalib;
});

describe('the idle viewfinder frames with the lens the flag named (iOS, decoupled arm)', () => {
  it('asks for the WIDE when the flag says wide, and says which arm', async () => {
    const r = mount('wide');
    await settle();
    // The IMU arm is confirmed usable (calibrated), so ARKit is not mounted
    // and the arm's own viewfinder is what the operator frames through.
    expect(r.has('ar-camera')).toBe(false);
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
    // ⚠ THE FIRST CALL, NOT THE LAST, AND THE ORDER IS THE POINT. The lens
    // AVAILABILITY probe (`panoPlusLensAvailability`, the chip's `has0_5x`)
    // asks this same planner once per lens at mount — so a "last call" here
    // would be satisfied by a probe that asks for BOTH lenses regardless of
    // the flag. The arm read's effect is declared first and therefore runs
    // first, so `planKeys[0]` is it.
    expect(planKeys[0]?.lens).toBe('wide');
    const before = planKeys.length;
    r.setLens('ultraWide');
    await settle();
    expect(planKeys.length).toBeGreaterThan(before);
    expect(planKeys[planKeys.length - 1]?.lens).toBe('ultraWide');
    r.unmount();
  });

  it('the availability probe asks BOTH lenses, in the flag spelling', async () => {
    // The chip's `has0_5x`. It is a hardware question, so it is asked once at
    // mount and not re-asked on a flip — and it is asked with the flag's
    // words, because native refuses '0.5x' / '1x' by design.
    const r = mount('wide');
    await settle();
    const spellings = planKeys.map((k) => k.lens);
    expect(spellings).toContain('ultraWide');
    expect(spellings).toContain('wide');
    expect(spellings.every((s) => s === 'ultraWide' || s === 'wide')).toBe(true);
    const before = planKeys.length;
    r.setLens('ultraWide');
    await settle();
    // Exactly ONE new call — the arm read. The hardware did not change.
    expect(planKeys.length).toBe(before + 1);
    r.unmount();
  });

  it('nothing here touched start(): no sweep was begun by mounting or flipping', async () => {
    const r = mount('wide');
    await settle();
    r.setLens('ultraWide');
    await settle();
    expect(startedWith).toBeNull();
    r.unmount();
  });
});

describe('the chip offers only lenses this body can open', () => {
  it('shows both pills on a body that publishes both — the phones this arm runs on', async () => {
    const r = mount('wide');
    await settle();
    expect(r.has('panoplus-lens-chip-0_5x')).toBe(true);
    expect(r.has('panoplus-lens-chip-1x')).toBe(true);
    r.unmount();
  });

  it('collapses to Pano’s static 1× when the planner refuses the ultra-wide', async () => {
    // An iPhone with no `builtInUltraWideCamera` (or one with no 4:3 format
    // at 60 fps on it). A `0.5×` pill there is a control that moves the flag
    // into a sweep the planner will refuse — Pano hides it, and so does this.
    planRefuse.ultraWide = 'panoplus-no-ultrawide';
    const r = mount('wide');
    await settle();
    expect(r.has('panoplus-lens-chip')).toBe(true);
    expect(r.has('panoplus-lens-chip-0_5x')).toBe(false);
    expect(r.has('panoplus-lens-chip-1x')).toBe(false);
    r.unmount();
  });

  it('still shows both pills on ANDROID, where the recorder resolves the camera', async () => {
    // `panoPlusLensAvailability` answers null off iOS, and null means "not
    // measured" — never "no 0.5×". The Android recorder picks the lens by
    // facing/FOV, so the chip must not make a hardware claim for it.
    Platform.OS = 'android';
    planRefuse.ultraWide = 'panoplus-no-ultrawide';
    const r = mount('ultraWide');
    await settle();
    expect(r.has('panoplus-lens-chip-0_5x')).toBe(true);
    expect(r.has('panoplus-lens-chip-1x')).toBe(true);
    r.unmount();
  });
});

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
