// SPDX-License-Identifier: Apache-2.0
//
// PANO'S LENS RULE, ADOPTED — THE CHIP IS ALWAYS UP AND 0.5× MOVES THE ARM.
//
// ── The decision this pins ────────────────────────────────────────────────
//
// The owner was shown, on 2026-09-03, that pano+ and Pano disagreed about which
// of the two controls hides. pano+ hid the CHIP under AR ("show the lens
// switcher if AR is off"); Pano hides the AR TOGGLE at 0.5× — `LensChip`
// renders whenever `!arOnly` (`Camera.tsx:3336`, with the shell passing
// `captureSources="both"`), while `ARToggle` carries `lens === '1x'` in its
// gate (`:3382`). Asked to choose, he took Pano's:
//
//   the lens chip is ALWAYS VISIBLE on BOTH arms, and the AR pill is gated on
//   `lens === '1x'` — so tapping 0.5× moves pano+ to the non-AR (decoupled)
//   arm automatically, exactly as picking 0.5× in Pano drops you out of AR.
//
// ── Why this file exists rather than more cases in the arm suite ──────────
//
// Every property below is about TWO HOST FLAGS MOVING TOGETHER, and the suites
// next door mount the surface with FIXED props — they cannot see a write come
// back as a re-render, which is the whole subject here. This one mounts a
// STATEFUL host, so `onLensChange` / `onPoseSourceChange` really round-trip and
// a tap is observable as the next frame.
//
// The load-bearing property, and the one the old rule got wrong:
//
//   THE CHIP NEVER CLAIMS A LENS THE RUNNING ARM CANNOT DELIVER.
//
// That is not automatic and it is not only about taps. `panoPlusLens` defaults
// to `'ultraWide'` and `panoPlusPoseSource` to `'ar'`
// (`captureFlagsStore.ts:1910`, `:1919`), so a FRESH DEVICE lands in
// (0.5×, AR) — a combination ARCore cannot honour (it forces camera 0) and
// ARKit cannot honour (no ultra-wide format, 0 of 22 on iPhone17,1), and one
// `start()` deletes the `lens` key for outright. A chip painting the flag would
// have shown `0.5×` selected, on the very first launch, over a viewfinder
// running 1×. The surface paints `effectiveLens` instead.
//
// ⚠ WHAT THIS SUITE CANNOT PROVE. It is JS. That camera 0 vs camera 2 really
// opens is native's, and on 2026-09-03 no Android device was attached — every
// pixel claim about the A35 is unverified.

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

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
import { holdShutter, releaseShutter } from './shutterGestures';
import { PANO_PLUS_SWAP_GRACE_MS } from '../panoPlusModel';
import type { PanoPlusPoseSource } from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** The options bag the last `start()` received — how the PACK's provenance is
 *  checked without a device. */
let startedWith: Record<string, unknown> | null = null;

type HostLens = 'ultraWide' | 'wide';
/** What the chip has painted as SELECTED, in Pano's vocabulary. */
type Painted = '1x' | '0.5x';

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
 * ⚠ MISSING τ, WITH THE BASIS ON FILE — and that pairing is deliberate rather
 * than incidental (2026-09-03). It is what the operator's own iPhone reports:
 * every pano+ pack from it carries `attitudeBasisIndex: 8`, `basisSource:
 * 'store'`, and no τ, because τ "measured 8 of 12 times and scattered 5.03 ms,
 * so nothing was persisted" — `panoPlusModel`'s own words for the normal state.
 *
 * It used to be `missing: 'tau+basis'`, which since the first-run gate was
 * fixed is no longer a chrome state at all: a phone with NO basis now gets the
 * one-time acquisition card, and the chip and pill are deliberately suppressed
 * underneath it (see `lensChipVisible`) so a stray tap cannot discard a gesture
 * in progress. Testing the LENS RULE through that state would have been
 * testing it through a modal — and the carve-out is pinned on its own, below
 * and in `panoPlusBasisFirstRun.render`, rather than by accident here.
 */
const UNCALIBRATED = () => Promise.resolve({
  resolved: {
    haveTau: false, haveBasis: true, complete: false, missing: 'tau',
    basisIndex: 8, basisLabel: '-y+x+z',
  },
});
let snapshotImpl: () => Promise<unknown> = CALIBRATED;
/**
 * Whether the PLANNER will open the wide — `panoPlusLensAvailability` asks it
 * once per lens and reports a refusal as that lens being unavailable
 * (`panoPlusCalibration.ts`). `false` is the body that strands the chip: see
 * section 9. iOS-only, because the probe returns `null` anywhere else.
 */
let wideOk = true;

function installNative(): void {
  startedWith = null;
  NM.RNISPanoPlus = {
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
  NM.RNISPanoCalib = {
    startBasisCalibration: () => Promise.resolve({}),
    basisCalibrationStatus: () => Promise.resolve({}),
    stopBasisCalibration: () => Promise.resolve({}),
    resolveBasisCalibration: () => Promise.resolve({}),
    discardBasisCalibration: () => Promise.resolve({}),
    combineTauRuns: () => Promise.resolve({}),
    saveTauCalibration: () => Promise.resolve({}),
    saveBasisCalibration: () => Promise.resolve({}),
    clearCalibration: () => Promise.resolve({}),
    plannedCaptureFormat: (k: { lens?: string } = {}) =>
      (k.lens === 'wide' && !wideOk
        ? Promise.resolve({ ok: false, reason: 'panoplus-no-60fps-format' })
        : Promise.resolve({
            ok: true,
            lens: 'AVCaptureDeviceTypeBuiltInUltraWideCamera',
            width: 1920, height: 1440, fps: 60,
            tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
            basisKey: 'iPhone17,1',
          })),
    getCalibration: () => snapshotImpl(),
  };
}

/** Every `(lens, poseSource)` the host has rendered the surface with, in order.
 *  This is how the ONE-COMMIT property is checked: the forbidden pair simply
 *  must never appear. */
let frames: Array<{ lens: HostLens; pose: PanoPlusPoseSource }> = [];

/**
 * The host the real app is — `DebugCameraScreen` owning both flags and handing
 * them down — reduced to the two pieces that matter. A fixed-prop mount cannot
 * express any property in this file: it would show the tap being REQUESTED and
 * never the frame that comes back.
 */
function Host(props: { lens0: HostLens; pose0: PanoPlusPoseSource }): React.JSX.Element {
  const [lens, setLens] = useState<HostLens>(props.lens0);
  const [pose, setPose] = useState<PanoPlusPoseSource>(props.pose0);
  frames.push({ lens, pose });
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

interface Rig {
  has: (testID: string) => boolean;
  /** The AR pill's props, or null when the pill is not on screen. */
  pill: () => Record<string, unknown> | null;
  /** Which pill the chip has selected — or the label, when it has collapsed. */
  painted: () => Painted;
  tapPill: () => void;
  tapLens: (which: Painted) => void;
  /** Press any control by testID — for the ones outside this file's subject,
   *  such as the basis card's SKIP. */
  tap: (testID: string) => void;
  /** Every string the surface actually rendered, joined. */
  text: () => string;
  /** Pano's shutter held past the threshold and released — one whole sweep. */
  sweep: () => void;
  /**
   * Every `pointerEvents` on the ANCESTOR CHAIN of `testID`, root-first.
   *
   * ⚠ THIS EXISTS BECAUSE `tapLens` CANNOT SEE THE BUG IT IS NAMED FOR. The
   * taps here reach into `props.onPress` and call it, bypassing touch dispatch
   * entirely — so they pass happily on a control sealed under
   * `pointerEvents="none"`, which no finger can ever reach. Not hypothetical:
   * `panoplus-lens-chip` shipped in exactly that state and was dead on both
   * platforms until 2026-09-02, verified on the A35 by tapping its centre and
   * watching the lens not change. uiautomator could not see it either —
   * `pointerEvents` is not an accessibility property.
   */
  blockers: (testID: string) => string[];
  /**
   * Every control on the WHOLE surface that can write one of the two flags —
   * the AR pill and the chip's two pills, and nothing else.
   *
   * ⚠ THIS IS THE INVARIANT SECTION 9 ASSERTS, AND IT IS NOT `has()`. A chip
   * can be MOUNTED and still write nothing: `PanoLensChip`'s single-lens
   * branch renders a static `Text` with no `Pressable`. Counting rendered
   * nodes said "chip: yes" on a screen whose only pressable was the arm
   * notice's expand/collapse — which moves no flag at all.
   */
  writers: () => string[];
  unmount: () => void;
}

function mount(lens0: HostLens, pose0: PanoPlusPoseSource): Rig {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<Host lens0={lens0} pose0={pose0} />); });
  act(() => { jest.advanceTimersByTime(PANO_PLUS_SWAP_GRACE_MS + 1); });
  const find = (testID: string): ReactTestInstance[] =>
    renderer.root.findAllByProps({ testID });
  const press = (testID: string): void => {
    const node = find(testID).find((n) => n.props.onPress != null);
    if (node == null) throw new Error(`no pressable ${testID}`);
    act(() => { (node.props.onPress as () => void)(); });
  };
  return {
    has: (testID) => find(testID).length > 0,
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
    pill: () => {
      // The host `Pressable` (it carries the a11y props), not the
      // `PanoArToggle` composite that also matches the testID.
      const node = find('panoplus-ar-pill').find((n) => n.props.accessibilityRole != null);
      return node == null ? null : (node.props as Record<string, unknown>);
    },
    painted: () => {
      const uw = find('panoplus-lens-chip-0_5x')[0];
      const wide = find('panoplus-lens-chip-1x')[0];
      if (uw != null && wide != null) {
        const sel = (n: ReactTestInstance): boolean =>
          (n.props.accessibilityState as { selected: boolean }).selected;
        if (sel(uw) === sel(wide)) throw new Error('chip selected neither or both');
        return sel(uw) ? '0.5x' : '1x';
      }
      // Pano's single-lens branch — a static label, no pressable.
      const strings: string[] = [];
      const walk = (n: ReactTestInstance | string | null): void => {
        if (n == null) return;
        if (typeof n === 'string') { strings.push(n); return; }
        for (const c of n.children ?? []) walk(c as ReactTestInstance | string);
      };
      walk(find('panoplus-lens-chip')[0] ?? null);
      if (strings.some((s) => s.includes('0.5'))) return '0.5x';
      if (strings.some((s) => s.includes('1×'))) return '1x';
      throw new Error(`chip painted nothing: ${JSON.stringify(strings)}`);
    },
    writers: () =>
      (['panoplus-ar-pill', 'panoplus-lens-chip-0_5x', 'panoplus-lens-chip-1x'] as const)
        .filter((t) => find(t).some((n) => n.props.onPress != null)),
    tapPill: () => press('panoplus-ar-pill'),
    tap: (testID) => press(testID),
    tapLens: (which) =>
      press(which === '0.5x' ? 'panoplus-lens-chip-0_5x' : 'panoplus-lens-chip-1x'),
    sweep: () => { holdShutter(renderer.root); releaseShutter(renderer.root); },
    blockers: (testID) => {
      const node = find(testID)[0];
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
  wideOk = true;
  frames = [];
});
afterEach(() => {
  jest.useRealTimers();
  delete NM.RNISPanoPlus;
  delete NM.RNISPanoCalib;
});

// ═══════════════════════════════════════════════════════════════════════════
//  1.  THE CHIP IS MOUNTED ON BOTH ARMS
// ═══════════════════════════════════════════════════════════════════════════

describe('the lens chip is on screen whichever arm is selected', () => {
  it.each([
    ['ar' as const],
    ['imu' as const],
  ])('is mounted on the %s arm', async (pose) => {
    const r = mount('wide', pose);
    await settle();
    expect(r.has('panoplus-lens-chip')).toBe(true);
    r.unmount();
  });

  it('is mounted at 0.5× on the decoupled arm, where the AR pill is not', async () => {
    const r = mount('ultraWide', 'imu');
    await settle();
    expect(r.has('panoplus-lens-chip')).toBe(true);
    expect(r.pill()).toBeNull();
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2.  THE AR PILL IS GATED ON 1× — PANO'S OWN CONDITION
// ═══════════════════════════════════════════════════════════════════════════

describe('the AR pill follows Pano’s `lens === \'1x\'` gate', () => {
  it('is present at 1× and absent at 0.5× on the decoupled arm', async () => {
    const wide = mount('wide', 'imu');
    await settle();
    expect(wide.pill()).not.toBeNull();
    expect(wide.painted()).toBe('1x');
    wide.unmount();

    const uw = mount('ultraWide', 'imu');
    await settle();
    expect(uw.pill()).toBeNull();
    // …and the whole stack goes with it, not just the pill inside it.
    expect(uw.has('panoplus-pill-stack')).toBe(false);
    expect(uw.painted()).toBe('0.5x');
    uw.unmount();
  });

  it('is present on the AR arm even with the flag on 0.5× — the arm runs 1×',
    async () => {
      // THE FRESH-DEVICE STATE (`panoPlusLens: 'ultraWide'` +
      // `panoPlusPoseSource: 'ar'`). The gate reads the lens that will RUN, so
      // the pill is up and the chip says 1×; reading the raw flag would have
      // hidden the only control that can leave this arm, on first launch.
      const r = mount('ultraWide', 'ar');
      await settle();
      expect(r.pill()).not.toBeNull();
      expect(r.painted()).toBe('1x');
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  3.  TAPPING 0.5× MOVES THE ARM — BOTH FLAGS, ONE COMMIT
// ═══════════════════════════════════════════════════════════════════════════

describe('choosing 0.5× chooses the decoupled arm with it', () => {
  it('writes BOTH flags, and no rendered frame ever pairs 0.5× with the AR arm',
    async () => {
      const r = mount('wide', 'ar');
      await settle();
      expect(r.painted()).toBe('1x');
      expect(r.pill()).not.toBeNull();

      const before = frames.length;
      r.tapLens('0.5x');
      await settle();

      // The flags moved together…
      expect(frames[frames.length - 1]).toEqual({ lens: 'ultraWide', pose: 'imu' });
      // …and the FORBIDDEN PAIR was never rendered. Both writes are issued
      // from one synchronous handler, so React batches them into a single
      // commit; this asserts the OUTCOME rather than the mechanism, so it
      // still holds if the host ever renders them apart (`effectiveLens`
      // paints `1x` in that torn state — stale, never false).
      expect(frames.slice(before)).not.toContainEqual({ lens: 'ultraWide', pose: 'ar' });
      // On screen: 0.5× selected, and Pano's AR toggle gone with it.
      expect(r.painted()).toBe('0.5x');
      expect(r.pill()).toBeNull();
      r.unmount();
    });

  it('is a no-op that stays honest when the arm is already decoupled', async () => {
    const r = mount('wide', 'imu');
    await settle();
    r.tapLens('0.5x');
    await settle();
    expect(frames[frames.length - 1]).toEqual({ lens: 'ultraWide', pose: 'imu' });
    expect(r.painted()).toBe('0.5x');
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  4.  COMING BACK TO 1× RESTORES THE PILL AND RE-ARMS NOTHING
// ═══════════════════════════════════════════════════════════════════════════

describe('choosing 1× restores the pill without re-arming AR', () => {
  it('brings the pill back OFF, leaving the arm where the operator put it',
    async () => {
      // The asymmetry is deliberate and the owner asked for it: 0.5× moves the
      // arm because 0.5× is unreachable without moving it; 1× moves nothing
      // because 1× runs on either arm. Re-arming here would make one tap on a
      // LENS control silently change which engine records the sweep — and
      // `panoPlusPoseSource` is persisted, so a phone put on the decoupled arm
      // on purpose would quietly come back ARKit.
      const r = mount('ultraWide', 'imu');
      await settle();
      expect(r.pill()).toBeNull();

      r.tapLens('1x');
      await settle();

      expect(frames[frames.length - 1]).toEqual({ lens: 'wide', pose: 'imu' });
      const pill = r.pill();
      expect(pill).not.toBeNull();
      // Restored, and restored OFF: the arm is still the decoupled one.
      expect((pill?.accessibilityState as { checked: boolean }).checked).toBe(false);
      expect(pill?.accessibilityLabel).toBe('AR mode off');
      // No frame anywhere in the round trip re-armed AR.
      expect(frames.map((f) => f.pose)).not.toContain('ar');
      r.unmount();
    });

  it('and AR comes back only on a deliberate tap of the restored pill', async () => {
    const r = mount('ultraWide', 'imu');
    await settle();
    r.tapLens('1x');
    await settle();
    r.tapPill();
    await settle();
    expect(frames[frames.length - 1]).toEqual({ lens: 'wide', pose: 'ar' });
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5.  THE CHIP NEVER CLAIMS A LENS THE RUNNING ARM CANNOT DELIVER
// ═══════════════════════════════════════════════════════════════════════════
//
// The expectations below are GROUND TRUTH about the arms, not a restatement of
// the surface's derivation: on the AR arm the running lens is structurally the
// wide camera (ARKit publishes no ultra-wide format; ARCore forces camera 0)
// and `start` deletes the `lens` key there, so the answer is `1x` whatever the
// flag says. On the decoupled arm native's `pickCameraForLens` honours the
// request, so the answer is the flag.

describe('every reachable (lens, arm) combination paints the lens that runs', () => {
  it.each([
    ['wide' as const, 'ar' as const, '1x' as const],
    // The fresh-device default, and the pair that used to lie.
    ['ultraWide' as const, 'ar' as const, '1x' as const],
    ['wide' as const, 'imu' as const, '1x' as const],
    ['ultraWide' as const, 'imu' as const, '0.5x' as const],
  ])('lens=%s arm=%s paints %s', async (lens, pose, want) => {
    const r = mount(lens, pose);
    await settle();
    expect(r.painted()).toBe(want);
    // And the pill's gate agrees with the chip on every one of the four.
    expect(r.pill() != null).toBe(want === '1x');
    r.unmount();
  });

  it('holds on the FALLBACK rung too, where the request and the arm differ',
    async () => {
      // An uncalibrated phone with the decoupled arm requested: the flags say
      // (0.5×, imu) and ARKit is what will run. This is the state the old
      // flag-painting chip got most wrong — it showed `0.5×` selected while
      // ARKit ran the wide camera, with nothing on screen to contradict it.
      snapshotImpl = UNCALIBRATED;
      const r = mount('ultraWide', 'imu');
      await settle();
      expect(r.painted()).toBe('1x');
      expect(r.pill()).not.toBeNull();
      // The pill draws the arm that will RUN, and the notice says why.
      expect((r.pill()?.accessibilityState as { checked: boolean }).checked).toBe(true);
      expect(r.has('panoplus-arm-headline')).toBe(true);
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  6.  AND THE PACK TELLS THE SAME STORY THE CHIP DOES
// ═══════════════════════════════════════════════════════════════════════════
//
// The chrome being honest is worth nothing if the PACK is not, and the pack's
// lens provenance starts here: `lensRequested` is whatever `start()` was given.
// Native derives the rest from the camera it actually opened — `lensRan` by FOV
// band, `lensHonoured = lensRequested != null && ran == lensRequested`, and
// `lensNote` saying which rule fired (`PanoPlusAndroidRecorder.kt:2584-2611`).
// So the SDK's whole duty is to send the key on the arm that can honour it and
// send NOTHING on the arm that cannot — a stale `'ultraWide'` riding an ARCore
// sweep would come back `lensHonoured: false` on a lens the operator never
// chose for that sweep.

describe('what crosses the bridge matches which arm is running', () => {
  it('sends no lens at all on the AR arm, even with the flag on 0.5×', async () => {
    // The fresh-device pair again. `lensRequested` must be null here, so the
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

  it('a 0.5× tap on the AR arm produces a sweep that is decoupled AND 0.5×',
    async () => {
      // The end-to-end of the whole rule: one tap, two flags, and the bag that
      // crosses the bridge agrees with the two pills on screen.
      const r = mount('wide', 'ar');
      await settle();
      r.tapLens('0.5x');
      await settle();
      expect(r.painted()).toBe('0.5x');
      r.sweep();
      await settle();
      expect(startedWith?.poseSource).toBe('imu');
      expect(startedWith?.lens).toBe('ultraWide');
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  7.  RENDERED IS NOT THE SAME AS TAPPABLE
// ═══════════════════════════════════════════════════════════════════════════

describe('the controls this rule adds are reachable by a finger', () => {
  it('neither pill nor chip sits under a pointerEvents="none" ancestor', async () => {
    const r = mount('wide', 'ar');
    await settle();
    expect(r.blockers('panoplus-ar-pill')).not.toContain('none');
    expect(r.blockers('panoplus-lens-chip-0_5x')).not.toContain('none');
    expect(r.blockers('panoplus-lens-chip-1x')).not.toContain('none');
    r.unmount();
  });

  it('the chip stays reachable at 0.5×, where it is the only control left',
    async () => {
      // With the AR pill gone this chip is the ONLY way back to the other arm.
      // Sealing it would strand the operator on the decoupled arm with no
      // on-screen way off — the 2026-09-02 defect, with higher stakes.
      const r = mount('ultraWide', 'imu');
      await settle();
      expect(r.pill()).toBeNull();
      expect(r.blockers('panoplus-lens-chip-1x')).not.toContain('none');
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  8.  THE AR PILL IS AN ARM CONTROL AND MOVES NO LENS THE OPERATOR CAN SEE
// ═══════════════════════════════════════════════════════════════════════════
//
// Gating the pill on the lens made the two controls interact, and the FIRST
// interaction was a defect this suite could not see because no case above ever
// taps the pill from the shipped default.
//
// `panoPlusLens` defaults to `'ultraWide'` while `effectiveLens` paints `1×`
// over it on the AR arm — so the flag is not merely stale, it is INVISIBLE. A
// pill that wrote only the arm unmasked it: one tap on a control that says
// nothing about lenses, and the chip jumped to `0.5×` and the pill deleted
// itself. Pano cannot reach this — its `lens` defaults to `'1x'` and its
// `handleARToggle` (`Camera.tsx:2952`) has nothing hidden to reveal.

describe('leaving AR keeps the lens the operator was looking at', () => {
  it('the pill tap from the SHIPPED DEFAULT changes the arm and nothing else',
    async () => {
      // (ultraWide, ar) — `captureFlagsStore.ts:1910`/`:1919`, a fresh device.
      const r = mount('ultraWide', 'ar');
      await settle();
      expect(r.painted()).toBe('1x');

      r.tapPill();
      await settle();

      // The arm moved; the lens the chip was PAINTING became the lens the flag
      // holds, rather than the hidden one surfacing.
      expect(frames[frames.length - 1]).toEqual({ lens: 'wide', pose: 'imu' });
      expect(r.painted()).toBe('1x');
      // …and the control the finger just landed on is still under it.
      expect(r.pill()).not.toBeNull();
      expect((r.pill()?.accessibilityState as { checked: boolean }).checked).toBe(false);
      r.unmount();
    });

  it('and the sweep that follows records the wide, not the unmasked flag',
    async () => {
      // The pack consequence, which is why this is not cosmetic: the pill tap
      // used to leave `panoPlusLens: 'ultraWide'` live on the decoupled arm,
      // so `start()` sent it and the pack recorded `lensRequested: 'ultraWide'`
      // — a 1.85× different field of view, attributed to a choice nobody made.
      const r = mount('ultraWide', 'ar');
      await settle();
      r.tapPill();
      await settle();
      r.sweep();
      await settle();
      expect(startedWith?.poseSource).toBe('imu');
      expect(startedWith?.lens).toBe('wide');
      r.unmount();
    });

  it('0.5× is still one deliberate tap away afterwards', async () => {
    // The fix commits what was painted; it does not take the ultra-wide away.
    const r = mount('ultraWide', 'ar');
    await settle();
    r.tapPill();
    await settle();
    r.tapLens('0.5x');
    await settle();
    expect(frames[frames.length - 1]).toEqual({ lens: 'ultraWide', pose: 'imu' });
    expect(r.painted()).toBe('0.5x');
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  9.  SOMETHING THAT WRITES A FLAG IS ALWAYS ON SCREEN
// ═══════════════════════════════════════════════════════════════════════════
//
// The rule hides ONE of the two controls; `PanoLensChip` can independently
// collapse the OTHER to a static label. Nothing connected the two, so they
// could both go at once — and did.
//
// ⚠ MEASURED, NOT ARGUED. With the planner refusing the wide, one tap of 0.5×
// from (wide, AR) left the entire surface with exactly one pressable:
// `panoplus-arm-notice`, the expand/collapse affordance, which writes no flag —
// under a headline reading `IMU ARM — CALIBRATED`. Both flags persist, so a
// relaunch landed straight back in it. The only escape was the debug gear.
//
// The refusal is iOS-only (`panoPlusLensAvailability` answers `null` elsewhere)
// and its causes are real: `panoplus-no-60fps-format` for a body with no 4:3
// 60 fps wide format, or `panoplus-io` from ANY throw on the wide probe —
// latched for the life of the mount by `lensAvailAskedRef`. NOT DEVICE-
// VERIFIED: no iPhone was attached on 2026-09-03.

describe('no reachable state leaves the operator with no control', () => {
  beforeEach(() => { Platform.OS = 'ios'; });
  afterEach(() => { Platform.OS = 'ios'; });

  it.each([
    ['wide' as const, 'ar' as const],
    ['wide' as const, 'imu' as const],
    ['ultraWide' as const, 'ar' as const],
    ['ultraWide' as const, 'imu' as const],
  ])('at least one writer is mounted at (%s, %s) with the wide refused',
    async (lens, pose) => {
      wideOk = false;
      const r = mount(lens, pose);
      await settle();
      expect(r.writers().length).toBeGreaterThan(0);
      r.unmount();
    });

  it('the 0.5× tap that used to strand the operator now leaves the pill up',
    async () => {
      wideOk = false;
      const r = mount('wide', 'ar');
      await settle();
      // The AR arm asks the planner nothing (the deliberate no-calibration-call
      // invariant), so both pills stand here — the documented bounded gap.
      r.tapLens('0.5x');
      await settle();
      // The chip collapses, exactly as Pano's does for a body with one lens…
      expect(r.writers()).not.toContain('panoplus-lens-chip-1x');
      // …and THIS is the new term: the pill survives its own `lens === '1x'`
      // gate because nothing else on screen can write anything.
      expect(r.pill()).not.toBeNull();
      r.unmount();
    });

  it('and that pill really is the way out — one tap restores both pills',
    async () => {
      // Rendered is not the same as effective: assert the escape by TAKING it.
      wideOk = false;
      const r = mount('ultraWide', 'imu');
      await settle();
      expect(r.writers()).toEqual(['panoplus-ar-pill']);

      r.tapPill();
      await settle();

      expect(frames[frames.length - 1]).toEqual({ lens: 'ultraWide', pose: 'ar' });
      expect(r.painted()).toBe('1x');
      expect(r.writers()).toContain('panoplus-lens-chip-1x');
      expect(r.writers()).toContain('panoplus-lens-chip-0_5x');
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10.  THE FALLBACK RUNG SAYS SO INSTEAD OF PRETENDING
// ═══════════════════════════════════════════════════════════════════════════
//
// On an uncalibrated iPhone — which `panoPlusModel`'s own copy calls the normal
// state, τ "measured 8 of 12 times and scattered 5.03 ms, so nothing was
// persisted" — a decoupled request FALLS BACK to ARKit. The arm cannot move, so
// 0.5× cannot be delivered, so offering it was `ultraWideOfferable` asking the
// wrong question: it checked that a WRITER existed, never that the write could
// take effect. Tapping 0.5× there left the screen byte-identical (chip `1×`,
// pill `AR mode on`) while both persisted flags moved.
//
// ⚠ WHAT THIS DOES AND DOES NOT CLOSE. The pill cannot be withheld BEFORE the
// tap: `reportedArm.fallbackToAr` is false on the AR arm because the AR arm
// makes no calibration call at all, so from there the fallback is genuinely
// unknown — the same bounded gap as `lensAvail`. What changes is that the
// refusal is now VISIBLE (the chip collapses to a static `1×` rather than
// snapping back with no explanation) and CLEARABLE (the pill writes the painted
// lens, so one tap removes the stale `ultraWide`).

describe('an arm that cannot move does not offer a lens it cannot reach', () => {
  it('collapses the chip on the fallback rung rather than offering 0.5×',
    async () => {
      snapshotImpl = UNCALIBRATED;
      const r = mount('ultraWide', 'imu');
      await settle();
      expect(r.painted()).toBe('1x');
      expect(r.pill()).not.toBeNull();
      // Pano's single-lens branch: no 0.5× pill to press.
      expect(r.writers()).toEqual(['panoplus-ar-pill']);
      expect(r.has('panoplus-arm-headline')).toBe(true);
      r.unmount();
    });

  it('and the restored pill clears the lens the refused tap left behind',
    async () => {
      snapshotImpl = UNCALIBRATED;
      const r = mount('wide', 'ar');
      await settle();
      r.tapLens('0.5x');          // requested; the arm falls back to ARKit
      await settle();
      expect(frames[frames.length - 1]).toEqual({ lens: 'ultraWide', pose: 'imu' });
      // The chip visibly answers — two pills became a static 1×.
      expect(r.writers()).toEqual(['panoplus-ar-pill']);

      r.tapPill();
      await settle();
      // The stale preference is gone, and it took one discoverable tap.
      expect(frames[frames.length - 1]).toEqual({ lens: 'wide', pose: 'imu' });
      r.unmount();
    });

  it('a CALIBRATED phone is untouched — 0.5× is offered and honoured',
    async () => {
      // The guard must not cost the working case anything.
      const r = mount('wide', 'ar');
      await settle();
      expect(r.writers()).toContain('panoplus-lens-chip-0_5x');
      r.tapLens('0.5x');
      await settle();
      expect(r.painted()).toBe('0.5x');
      expect(frames[frames.length - 1]).toEqual({ lens: 'ultraWide', pose: 'imu' });
      r.unmount();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE ONE CARVE-OUT FROM "THE CHIP IS ALWAYS UP"
// ═══════════════════════════════════════════════════════════════════════════
//
// Stated HERE, in the suite that owns the rule, rather than only where it is
// implemented — a rule with an exception recorded somewhere else is a rule
// somebody will restore by hand.
//
// The rule (2026-09-03, Pano's): the chip is always visible, the AR pill only
// at 1×. The exception: neither is drawn while the ONE-TIME BASIS ACQUISITION
// card is on screen. Both controls write host flags the card's own precondition
// read is keyed on, so a tap unmounts the card mid-recording and its teardown
// discards the log — measured, with no message to the operator. The card is
// idle-only and once per phone model, it carries its own SKIP, and both flags
// stay reachable from the gear panel, so the cost of the exception is bounded
// to a screen the operator sees once.

describe('the chip yields to the one-time basis card, and only to that', () => {
  it('draws neither control while the acquisition is up', async () => {
    // A phone with NO basis at all — the first-run state, which is what
    // `UNCALIBRATED` above used to be.
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis',
      },
    });
    const r = mount('ultraWide', 'imu');
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(true);
    expect(r.has('panoplus-lens-chip')).toBe(false);
    expect(r.has('panoplus-ar-pill')).toBe(false);
    // ⚠ THE PILL IS THE ONE THAT HAD TO BE SPELLED OUT. `chipCanMoveLens`
    // contains `lensChipVisible`, so suppressing the chip alone makes the
    // "one control is always left on screen" hatch fire and summon the pill —
    // the more damaging of the two, and on this route it paints `AR mode ON`,
    // the arm the operator is trying to leave.
    expect(r.writers()).toEqual([]);
    r.unmount();
  });

  it('gives both back the moment the card is gone', async () => {
    snapshotImpl = () => Promise.resolve({
      resolved: {
        haveTau: false, haveBasis: false, complete: false, missing: 'tau+basis',
      },
    });
    const r = mount('ultraWide', 'imu');
    await settle();
    r.tap('panoplus-basis-skip');
    await settle();
    expect(r.has('panoplus-basis-overlay')).toBe(false);
    // The rule resumes exactly as written: chip up, and on the fallback rung it
    // is the collapsed single-lens branch with the pill as the writer.
    expect(r.has('panoplus-lens-chip')).toBe(true);
    expect(r.painted()).toBe('1x');
    expect(r.pill()).not.toBeNull();
    r.unmount();
  });
});

// ── THE DROPPED LENS REACHES THE SCREEN ────────────────────────────────────
//
// ⚠ THIS EXISTS BECAUSE THE WIRE HAD NO TEST AND THE MUTATION PROVED IT.
// `panoPlusArmNotice` learned to name a lens the arm declined, and its own
// suite covers that. But the SURFACE has to hand it the lens — one argument,
// in one call — and with that argument deleted the entire 787-case sweep
// suite stayed green. A pure function nobody feeds correctly is the
// vacuous-pass family this package keeps finding in itself.
describe('the surface tells the notice which lens was asked for', () => {
  beforeEach(() => { Platform.OS = 'ios'; });
  afterEach(() => { Platform.OS = 'ios'; });

  it('⚑ 0.5× + a declined IMU arm says so ON SCREEN', () => {
    // The shipped iPhone state, and the one the operator reported: he asked
    // for the ultra-wide, the arm fell back to ARKit, and nothing said the
    // lens had gone with it.
    const rig = mount('ultraWide', 'imu');
    expect(rig.text()).toContain('0.5× UNAVAILABLE');
  });

  it('⚑ NEGATIVE CONTROL: the same declined arm at 1× says nothing about lenses', () => {
    // Without this the case above passes for a surface that shouts about the
    // ultra-wide on every fallback, including ones nobody asked a lens for.
    const rig = mount('wide', 'imu');
    expect(rig.text()).not.toContain('0.5× UNAVAILABLE');
  });
});
