// SPDX-License-Identifier: Apache-2.0
//
// THE pano+ SURFACE, MOUNTED AS ANDROID.
//
// ── The gap this closes ───────────────────────────────────────────────────
//
// The operator's report was one sentence: "Is the live camera and the preview
// not done? They SHOULD BE DONE!!!" — and what he was looking at was this
// surface's `pano+ is not available … iOS-only` card, on a phone whose engine
// had already replayed one of his own sweeps into a clean panorama. The card
// was not a bug in the engine, the recorder, or the pack. It was WIRING: the
// module the surface probes for was not registered under the name the probe
// uses, and the copy that explained the absence had gone stale into a lie.
//
// `panoPlusAndroidArm` is unit-tested next door and none of that proves the
// SURFACE picks the Android table, skips the iOS calibration module, mounts the
// Android viewfinder, or puts the Android memory caps in the bag that crosses
// the bridge. That is the exact class of bug this project keeps paying for: on
// 2026-07-22 the maths under two HUD failures was correct and the wiring was
// not, and the suite that could have caught it said "the surface glue is
// exercised on-device". On-device meant in a store, by the operator.
//
// ⚠ WHAT THIS SUITE CANNOT PROVE. Every assertion here is about JS. Whether the
// native module answers, whether Camera2 hands the recorder a surface, whether
// a frame reaches the engine and a pixel reaches the screen — none of that is
// reachable from this machine and none of it is claimed below.
//
// M10 — the sweep's own screen (`PanoPlusCaptureSurface`, its unavailable
// card, its clone AR pill / lens chip / shutter) is deleted. This suite now
// mounts the ENGINE (`useSweepEngine`) through `SweepEngineHarness`, presses
// the shutter through the engine's handle (`holdStart` / `holdEnd`), and
// reads what the host's shutter would paint from `onControlsState`.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import * as RN from 'react-native';
import { NativeModules, Platform } from 'react-native';

/** The render mock's AppState driver — see jest.mocks/react-native.render.js. */
const emitAppState = (next: string): void => {
  (RN as unknown as { __emitAppState: (s: string) => void }).__emitAppState(next);
};

/** Every `writeAsStringAsync` this surface performs, in order. The pack's
 *  host-notice sidecar is the only one today, and asserting on the BYTES is
 *  the only way to prove the collapsed paragraph survived the collapse. */
const writes: Array<{ uri: string; body: string }> = [];

jest.mock(
  'expo-file-system/legacy',
  () => ({
    documentDirectory: 'file:///data/user/0/com.example.app/files/',
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: () => Promise.resolve(''),
    writeAsStringAsync: (uri: string, body: string) => {
      writes.push({ uri, body });
      return Promise.resolve();
    },
    deleteAsync: () => Promise.resolve(),
    getInfoAsync: () => Promise.resolve({ exists: false }),
    readDirectoryAsync: () => Promise.resolve([]),
  }),
  { virtual: true },
);

import { SweepEngineHarness } from './sweepEngineHarness';
import { ARCameraView } from '../../camera/ARCameraView';
import {
  PANO_PLUS_IDLE_HEARTBEAT_MS,
  PANO_PLUS_SWAP_GRACE_MS,
} from '../panoPlusModel';
import {
  PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS,
  PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG,
  PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS,
} from '../panoPlusAndroidArm';
import type {
  PanoPlusFailure,
  PanoPlusPoseSource,
  SweepSurfaceHandle,
  SweepSurfaceState,
} from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

/** The options bag the last `start()` received — the thing that matters. */
let startedWith: Record<string, unknown> | null = null;
/** Forget the last start bag, so a SECOND hold's bag is what gets read. (A
 *  function rather than an inline `= null`, which would narrow the variable
 *  to `null` for the rest of the case.) */
const clearStart = (): void => { startedWith = null; };
/** Calls to the iOS CALIBRATION module, so "Android asks it nothing" is a
 *  CHECKED fact rather than an inspection of the source. Registering it here at
 *  all is deliberate: the strong form of the property is that the surface does
 *  not call it even when it IS present. */
let calibCalls: string[] = [];
/** Every `setIdlePreview` the surface issued, in order — the re-arm is only
 *  provable as a SECOND `{on:true}` after the feed was reported down. */
let idleCalls: Array<{ on: boolean; options: Record<string, unknown> }> = [];
/** Every `onFailure` the engine reported — a declined hold is named here. */
let failures: PanoPlusFailure[] = [];
/** Every `onControlsState` report — what the HOST's shutter paints. */
let controls: SweepSurfaceState[] = [];
/** What native answers a `setIdlePreview(true)` with. */
let idleAnswersOn = true;
let idleReason = 'idle viewfinder LIVE on camera 2 at 1440x1080';
/**
 * WHAT NATIVE SAYS HAPPENED TO THE FRAME RATE, spread into the idle answer.
 *
 * Null is the OLDER BINARY: `PanoPlusLiveModule` has answered
 * `previewFpsApplied` / `previewFpsRange` / `previewFpsNote` on every path
 * since 2026-09-07, and every build before it — and every iOS build — answers
 * `{on, reason}` and nothing about the rate. Both shapes have to reach this
 * surface without it inventing a fault out of the silence.
 */
let idleFpsReply: Record<string, unknown> | null = null;
/** What `getStatus()` answers on the next tick. Mutated per test. */
let statusReply: Record<string, unknown> = { running: false };

function installNative(withLiveModule = true): void {
  startedWith = null;
  calibCalls = [];
  idleCalls = [];
  idleAnswersOn = true;
  idleReason = 'idle viewfinder LIVE on camera 2 at 1440x1080';
  idleFpsReply = null;
  statusReply = { running: false };
  if (withLiveModule) {
    // The interface the Android live module must answer, verbatim from
    // `panoPlusNative.ts`: the availability probe is
    // `typeof start/stop/cancel === 'function'` and all three must exist or a
    // hold is refused `panoplus-unavailable`.
    NM.RNISPanoPlus = {
      start: (o: Record<string, unknown>) => {
        startedWith = o;
        return Promise.resolve({
          sessionDir: '/data/user/0/com.example.app/files/panoplus/pp_1',
          startedAtMs: 1,
          pluginAvailable: true,
          poseSource: o.poseSource,
        });
      },
      stop: () => Promise.resolve({}),
      cancel: () => Promise.resolve({ cancelled: true }),
      getStatus: () => Promise.resolve(statusReply),
      // ⚠ REGISTERED SO THE IDLE PATH IS REACHABLE AT ALL. Without this key
      // `setPanoPlusIdlePreview` short-circuits to the "this build carries no
      // idle-viewfinder method" refusal and every assertion below tests the
      // absence of a feature rather than the feature.
      setIdlePreview: (on: boolean, o: Record<string, unknown>) => {
        idleCalls.push({ on, options: o });
        return Promise.resolve({
          on: on && idleAnswersOn,
          reason: idleReason,
          ...(idleFpsReply ?? {}),
        });
      },
    };
  }
  NM.RNISPanoCalib = {
    plannedCaptureFormat: () => {
      calibCalls.push('plannedCaptureFormat');
      return Promise.resolve({ ok: true, lens: 'x', width: 1, height: 1, fps: 60 });
    },
    getCalibration: () => {
      calibCalls.push('getCalibration');
      return Promise.resolve({ resolved: { complete: true } });
    },
  };
}

interface Rig {
  texts: () => string[];
  shows: (needle: string) => boolean;
  tap: (testID: string) => void;
  /** The shutter held past the threshold — the engine's `holdStart`. */
  hold: () => void;
  /** …and released — the engine's `holdEnd`. */
  release: () => void;
  /** What the host's shutter would paint — the last `onControlsState`. */
  shutter: () => { disabled: boolean; busy: boolean };
  has: (testID: string) => boolean;
  /** Is the stitcher's `<ARCameraView>` mounted? (The harness draws the real
   *  component, so this finds it by TYPE rather than by the seam's testID.) */
  hasArView: () => boolean;
  /**
   * Every `pointerEvents` value on the ANCESTOR CHAIN of `testID`, root-first.
   *
   * ⚠ THIS EXISTS BECAUSE `tap()` CANNOT SEE THE BUG IT IS NAMED FOR. `tap`
   * reaches into `props.onPress` and calls it, which bypasses touch dispatch
   * entirely — so it passes happily on a control wrapped in
   * `pointerEvents="none"`, which is a control no finger can ever reach. That
   * is not hypothetical: `panoplus-lens-chip` shipped inside exactly such a
   * wrapper and was dead on both platforms until 2026-09-02, verified on the
   * Galaxy A35 by tapping its centre and watching the lens not change.
   * uiautomator could not see it either — it reads the accessibility tree,
   * and `pointerEvents` is not an accessibility property.
   */
  blockers: (testID: string) => string[];
  /** Re-render with a new `lens` — what the host does when ITS chip writes. */
  setLens: (lens: 'ultraWide' | 'wide') => void;
  unmount: () => void;
}

function mount(
  poseSource?: PanoPlusPoseSource,
  opts: {
    pinPreviewFps?: boolean;
    imuSidecar?: boolean;
    lens?: 'ultraWide' | 'wide';
  } = {},
): Rig {
  let renderer!: ReactTestRenderer;
  const handle = React.createRef<SweepSurfaceHandle>();
  const element = (lens: 'ultraWide' | 'wide' | undefined): React.JSX.Element => (
    <SweepEngineHarness
      ref={handle}
      onComplete={() => undefined}
      onCancel={() => undefined}
      onFailure={(f) => { failures.push(f); }}
      onControlsState={(c) => { controls.push(c); }}
      poseSource={poseSource}
      pinPreviewFps={opts.pinPreviewFps}
      imuSidecar={opts.imuSidecar}
      lens={lens}
    />
  );
  act(() => {
    renderer = TestRenderer.create(element(opts.lens));
  });
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
  const press = (which: 'holdStart' | 'holdEnd'): void => {
    const fn = handle.current?.[which];
    if (fn == null) throw new Error(`the engine handle has no ${which}`);
    act(() => { fn(); });
  };
  return {
    texts: collect,
    shows: (needle) => collect().some((t) => t.includes(needle)),
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    hasArView: () => renderer.root.findAllByType(ARCameraView).length > 0,
    blockers: (testID) => {
      const node = renderer.root.findAllByProps({ testID })[0];
      if (node == null) throw new Error(`no node with testID ${testID}`);
      const out: string[] = [];
      // `parent` is on the runtime object but is absent from the
      // `ReactTestInstance` typing this repo's react-test-renderer ships, so
      // the walk is typed locally rather than by casting at each hop.
      interface Walkable { props: { pointerEvents?: string }; parent: Walkable | null }
      let cur = (node as unknown as Walkable).parent;
      while (cur != null) {
        const pe = cur.props?.pointerEvents;
        if (typeof pe === 'string') out.unshift(pe);
        cur = cur.parent;
      }
      return out;
    },
    tap: (testID) => {
      const node = renderer.root.findAllByProps({ testID })[0];
      const onPress = node?.props?.onPress as (() => void) | undefined;
      if (onPress == null) throw new Error(`no onPress on ${testID}`);
      act(() => { onPress(); });
    },
    hold: () => press('holdStart'),
    release: () => press('holdEnd'),
    shutter: () => {
      const last = controls[controls.length - 1];
      if (last == null) throw new Error('the engine never reported its controls');
      return { disabled: !last.canCapture, busy: last.busy };
    },
    setLens: (lens) => { act(() => { renderer.update(element(lens)); }); },
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
  failures = [];
  controls = [];
  // The surface asks `Platform.OS` ONCE, at render, through
  // `panoPlusArmContract` — so flipping the shared mock before mounting is
  // enough, and no module has to be re-required.
  (Platform as { OS: string }).OS = 'android';
  installNative();
  writes.length = 0;
});
afterEach(() => {
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  delete NM.RNISPanoPlus;
  delete NM.RNISPanoCalib;
});

// ═══════════════════════════════════════════════════════════════════════════
//  1.  THE SENTENCE THE OPERATOR READ
// ═══════════════════════════════════════════════════════════════════════════

// M10 — THE CARD IS DELETED, THE SENTENCE IS NOT. The standalone screen drew
// "pano+ is not available" over everything; inside `<Camera>` there is no
// such card, so the engine refuses a declined hold BY NAME through
// `onFailure` (`panoplus-unavailable`) carrying the same per-platform copy
// (`panoPlusUnavailableDetail`). These three cases were the card's; they now
// pin the refusal that replaced it.
describe('a hold on a build without the live module is refused by name', () => {
  it('is NOT refused on Android once the live module is registered', async () => {
    const r = mount();
    await settle();
    expect(r.shutter().disabled).toBe(false);
    r.hold();
    await settle();
    expect(failures.map((f) => f.code)).not.toContain('panoplus-unavailable');
    expect(startedWith).not.toBeNull();
    r.unmount();
  });

  it('IS refused, TRUTHFULLY, when the module is absent', async () => {
    // The whole point of correcting the copy was that it keeps working as a
    // refusal. A hold that stopped being refused would trade one wrong screen
    // for another — an Android build with no live arm looking like a working
    // one, whose shutter does nothing and says nothing.
    delete NM.RNISPanoPlus;
    const r = mount();
    await settle();
    // The host's shutter greys…
    expect(r.shutter().disabled).toBe(true);
    // …and a hold anyway is refused, once, by name.
    r.hold();
    await settle();
    expect(failures.map((f) => f.code)).toEqual(['panoplus-unavailable']);
    expect(failures[0]!.message).toContain('not registered');
    r.unmount();
  });

  it('never says iOS-only on an Android build', async () => {
    delete NM.RNISPanoPlus;
    const r = mount();
    await settle();
    r.hold();
    await settle();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).not.toMatch(/iOS-only/i);
    expect(failures[0]!.message).toContain('Gradle module');
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  2.  THE ARM — Android asks a DIFFERENT precondition, and asks it of nobody
// ═══════════════════════════════════════════════════════════════════════════

describe('the IMU arm on Android', () => {
  it('makes NO call to the iOS calibration module, even though it is present', async () => {
    // The strongest form of "the Android contract does not go through the pod".
    // Before this wiring the surface called `plannedCaptureFormat`, got
    // `calib-unavailable` (there is no such module on Android), and fell back
    // to the AR arm with a banner blaming a missing pod install — a build fault
    // that does not exist on this platform.
    const r = mount('imu');
    await settle();
    expect(calibCalls).toEqual([]);
    r.unmount();
  });

  it('resolves to the IMU arm with no fallback, and the shutter is live', async () => {
    // (The basis-overlay and lens-chip assertions that were here went with
    // those mechanisms — deleted in M10.) What is left is the engine's own
    // answer: the arm settles synchronously on Android, so the shutter the
    // host draws is live, not greyed on a read that was never going to run.
    const r = mount('imu');
    await settle();
    expect(r.shutter()).toEqual({ disabled: false, busy: false });
    r.hold();
    await settle();
    expect(failures).toEqual([]);
    expect(startedWith?.poseSource).toBe('imu');
    r.unmount();
  });

  it('says the basis is DERIVED, and says τ = 0 without any flag being set', async () => {
    const r = mount('imu');
    await settle();
    expect(r.shows('BASIS DERIVED, NEVER MEASURED')).toBe(true);
    // `tauUncorrected` is NOT passed by this test's host. On iOS that would
    // leave the chip dark; on Android the statement is unconditional, so the
    // notice owns it.
    expect(r.has('panoplus-tau-uncorrected')).toBe(true);
    expect(r.shows('NO CAMERA↔IMU TIMING CORRECTION')).toBe(true);
    r.unmount();
  });

  it('does NOT mount the AR view — ARCore and Camera2 cannot share the body', async () => {
    const r = mount('imu');
    await settle();
    // PAST the Android swap grace (600 ms, the measured Camera2 release) —
    // the rig only advances iOS's 250 ms, and inside the grace no arm mounts
    // the view, so a check there cannot fail.
    act(() => { jest.advanceTimersByTime(700); });
    expect(r.hasArView()).toBe(false);
    r.unmount();
  });

  it('never names ARKit in the no-preview explainer', async () => {
    // The Android viewfinder is a native component the render env does not
    // carry, so this is the explainer branch — which is exactly the branch
    // whose wording was iOS's.
    //
    // ⚠ THIS ASSERTED `'ARCore is DOWN by design'` UNTIL 2026-09-03. Keeping
    // iOS's words off an Android screen is still the property worth pinning;
    // asserting what a session is DOING is not, and is what let the AR arm
    // ship "ARCore is UP" at idle with the camera closed. The notice no longer
    // makes a claim about any session's state — it reports whether there is a
    // viewfinder and what native said about it.
    const r = mount('imu');
    await settle();
    expect(r.shows('No viewfinder in this build')).toBe(true);
    expect(r.texts().some((t) => t.includes('ARKit'))).toBe(false);
    r.unmount();
  });
});

// ⚠ THIS BLOCK ASSERTED THE OPPOSITE UNTIL 2026-09-02, and both assertions
// were green while being false about the build. There is no ARCore-fed engine
// path on Android (`PanoPlusLiveModule.StartShim` answers `poseSource: "imu"`
// unconditionally; the recorder feeds the engine from TYPE_ROTATION_VECTOR
// through `C`, and its only ARCore code is the optional reference LOG channel).
// Mounting `<ARCameraView>` for that request was not merely cosmetic: ARCore
// then owns the back camera, and `PanoPlusAndroidRecorder` needs the same one.
describe('the AR arm on Android runs the sweep on the STITCHER\u2019s ARCore session (M2)',
  () => {
    it('mounts the stitcher\u2019s <ARCameraView> on the AR arm, and never on the IMU arm',
      async () => {
        // ⚠ THIS ASSERTED THE OPPOSITE UNTIL M2, AND FOR A REASON THAT NO
        // LONGER HOLDS. The AR arm used to be pano+'s OWN shared-camera ARCore
        // session inside the recorder, so a surface AR view would have been a
        // second ARCore client. Since M2 a live AR sweep runs on the
        // stitcher's session through PanoPlusArFramePlugin and the recorder
        // opens no ARCore and no camera — so the AR view IS the camera and the
        // viewfinder, one client, the arrangement iOS has always had.
        const ar = mount('ar');
        await settle();
        // Not before ARCore has said it can run (the one-shot isSupported
        // probe, M2) — and then after the Android camera-release grace
        // (600 ms, the measured Camera2 release), as any arm change.
        await settle();
        act(() => { jest.advanceTimersByTime(250); });
        expect(ar.hasArView()).toBe(false);   // still inside the release
        act(() => { jest.advanceTimersByTime(400); });
        expect(ar.hasArView()).toBe(true);
        ar.unmount();
        // The IMU arm still leaves it unmounted: there is one back camera.
        // Checked past the same grace the AR arm waited out above — before
        // it, no arm mounts the view and the check could not fail.
        const imu = mount('imu');
        await settle();
        act(() => { jest.advanceTimersByTime(700); });
        expect(imu.hasArView()).toBe(false);
        imu.unmount();
      });

    it('⚑ where ARCore cannot run: no AR view, and the arm REFUSES by name (no silent loss)', async () => {
      const ar = NM.RNSARSession as { isSupported: () => Promise<boolean> };
      const real = ar.isSupported;
      ar.isSupported = () => Promise.resolve(false);
      try {
        const r = mount('ar');
        await settle();
        await settle();
        act(() => { jest.advanceTimersByTime(700); });
        expect(r.hasArView()).toBe(false);
        expect(r.shows('ARCore CANNOT RUN')).toBe(true);
        r.unmount();
      } finally {
        ar.isSupported = real;
      }
    });

    it('⚑ not before ARCore has ANSWERED: a probe still pending past the grace mounts no AR view', async () => {
      // The gate is the probe's answer, not the grace alone. Every other case
      // resolves `isSupported` before a single timer advances, so a gate that
      // ignored the probe and waited only the 600 ms passed them all.
      const ar = NM.RNSARSession as { isSupported: () => Promise<boolean> };
      const real = ar.isSupported;
      let answer: ((v: boolean) => void) | null = null;
      ar.isSupported = () => new Promise<boolean>((res) => { answer = res; });
      try {
        const r = mount('ar');
        await settle();
        act(() => { jest.advanceTimersByTime(1500); });
        expect(r.hasArView()).toBe(false);   // unanswered: nothing mounts
        await act(async () => { answer?.(true); await Promise.resolve(); });
        await settle();
        act(() => { jest.advanceTimersByTime(700); });
        expect(r.hasArView()).toBe(true);    // …and the answer is what lets it
        r.unmount();
      } finally {
        ar.isSupported = real;
      }
    });

    it('claims nothing about ARCore\u2019s state at idle — on either arm', async () => {
      // ⚠ THIS TEST ASSERTED `shows('ARCore is UP')` UNTIL 2026-09-03, AND IT
      // WAS GREEN WHILE THE SCREEN WAS LYING TO THE OPERATOR. Neither arm
      // narrates a session at idle; they differ in the start label and the arm
      // headline (pinned below), not in a status claim.
      for (const arm of ['ar', 'imu'] as const) {
        const r = mount(arm);
        await settle();
        expect(r.shows('ARCore is UP')).toBe(false);
        expect(r.shows('is DOWN by design')).toBe(false);
        r.unmount();
      }
      // The IMU arm's Camera2 viewfinder is null under Jest, so the surface
      // falls back to its explainer — the reassurance the operator needs.
      const imu = mount('imu');
      await settle();
      expect(imu.has('panoplus-camera-off')).toBe(true);
      expect(imu.shows('No viewfinder in this build')).toBe(true);
      imu.unmount();
    });

    it('names the arm and its price instead of ignoring the request', async () => {
      const r = mount('ar');
      await settle();
      expect(r.has('panoplus-arm-headline')).toBe(true);
      // The copy this replaced said "AR PILL IGNORED — NO ARCore ARM IN THIS
      // BUILD", which was true until the arm was wired and is now the lie.
      expect(r.shows('AR PILL IGNORED')).toBe(false);
      expect(r.shows('AR ARM')).toBe(true);
      expect(r.shows('ULTRA-WIDE')).toBe(true);
      r.unmount();
    });

    // The lens chip's AR-arm offer (`effectiveLens`, the withheld 0.5× pill) — deleted in M10.
  });

// ═══════════════════════════════════════════════════════════════════════════
//  3.  WHAT CROSSES THE BRIDGE
// ═══════════════════════════════════════════════════════════════════════════

describe('the start bag', () => {
  it('carries the Android memory caps', async () => {
    const r = mount('imu');
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.previewMaxAlong).toBe(PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG);
    expect(startedWith?.previewMaxCross).toBe(PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS);
    expect(startedWith?.canvasMaxPixels).toBe(PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS);
    r.unmount();
  });

  it('sends the arm the button named, and the lens with it', async () => {
    const r = mount('imu');
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.poseSource).toBe('imu');
    // The lens is a real choice on Android's IMU arm — the A35 publishes a
    // 96.2° ultra-wide that ARCore cannot reach.
    expect(startedWith?.lens).toBe('ultraWide');
    r.unmount();
  });

  it('writes the pack under the app documents dir, as a BARE path', async () => {
    // Native creates the directory with a filesystem call, so a `file://` URI
    // would produce a literal `file:` folder and report success. The offline
    // tools and the replay twin read this directory by name.
    const r = mount('imu');
    await settle();
    r.hold();
    await settle();
    const dir = String(startedWith?.sessionDir ?? '');
    expect(dir.startsWith('file://')).toBe(false);
    expect(dir).toMatch(
      /^\/data\/user\/0\/com\.example\.app\/files\/panoplus\/pp_\d+$/,
    );
    r.unmount();
  });

  it('sends ar when the AR pill was tapped, and does NOT send a lens', async () => {
    // ⚠ INVERTED TWICE, AND THE HISTORY IS THE POINT. It first required
    // `poseSource: 'ar'` for an arm that did not exist; on 2026-09-02 morning it
    // was corrected to `'imu'` because native answered `imu` unconditionally;
    // this is the third state, in which the arm is actually wired and the bag
    // may honestly ask for it. `poseSource` is what native reads to decide
    // whether to open the shared-camera ARCore channel at all.
    //
    // NO `lens` KEY: ARCore selects the camera from its own CameraConfig list,
    // so a lens request would be a preference the arm structurally cannot
    // honour — and a bag that asks for something native must discard is how the
    // pack ends up recording a substitution instead of a choice.
    const r = mount('ar');
    await settle();
    r.hold();
    await settle();
    expect(startedWith).not.toBeNull();
    expect(startedWith?.poseSource).toBe('ar');
    expect('lens' in (startedWith as Record<string, unknown>)).toBe(false);
    r.unmount();
  });

  it('never sends imuSidecar on Android — the instrument is CoreMotion', async () => {
    // The field build ships `panoPlusImuSidecar: true`, and the surface's own
    // rule is that a key rides the bag only where the arm can honour it. The
    // sidecar is a second CoreMotion plugin on the ARKit delegate thread; there
    // is nothing for it to reach on ARCore, and a pack echoing a declaration
    // nothing implemented would claim a pose-arm comparison it does not carry.
    const r = mount('ar', { imuSidecar: true });
    await settle();
    r.hold();
    await settle();
    expect(startedWith).not.toBeNull();
    expect('imuSidecar' in (startedWith as Record<string, unknown>)).toBe(false);
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  5.  THE CONTROLS ARE REACHABLE, AND THE DIAGNOSTIC STILL REACHES THE PACK
//      (2026-09-02)
// ═══════════════════════════════════════════════════════════════════════════
//
// The operator's pano+ screen on the A35 was 58.5% prose over a live camera —
// the HUD's text ran y=169..1539 of a 2,340 px display on the IMU arm, printed
// through the host's own banner so neither could be read — and the one control
// inside it could not be tapped at all. Both halves are asserted here.
//
// ⚠ WHAT THIS SUITE STILL CANNOT PROVE. `blockers()` reads the rendered
// `pointerEvents` chain; it does not run Android's touch dispatcher. It fails
// on the defect that shipped, which is the property that was missing, but a
// control can also be unreachable for reasons this cannot see — off-screen,
// under a sibling, behind a native view. Those need the phone.

describe('the controls inside the HUD are reachable', () => {
  // The lens chip as a CONTROL (its taps writing `onLensChange`) — deleted in
  // M10; the lens chip is `<Camera>`'s. What survives is the SDK half the
  // chip's case pinned: the lens the HOST names reaches native through `lens`.
  it('the lens the host names reaches native — in both directions', async () => {
    // ⚠ WHAT THE CHIP'S CASE WAS FOR. On 2026-09-03 the owner's parity
    // requirement made native's `pickCamera` honour the requested lens on the
    // sweep and the idle viewfinder, so the lens control is honest only if
    // the request actually crosses. The host now owns the control; this pins
    // that its flag, re-rendered in, is what the next hold sends.
    const r = mount('imu', { lens: 'ultraWide' });
    await settle();
    r.setLens('wide');
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.lens).toBe('wide');
    r.release();
    await settle();
    clearStart();
    r.setLens('ultraWide');
    await settle();
    r.hold();
    await settle();
    expect(startedWith?.lens).toBe('ultraWide');
    // …and still not one word of prose about lenses on the screen.
    expect(r.shows('always opens the widest back lens')).toBe(false);
    r.unmount();
  });

  it('the arm-notice expander has no pointerEvents="none" ancestor', async () => {
    const r = mount('imu');
    await settle();
    expect(r.has('panoplus-arm-notice')).toBe(true);
    expect(r.blockers('panoplus-arm-notice')).not.toContain('none');
    r.unmount();
  });

  // The clone shutter's and lens pills' reachability (`panoplus-shutter`, `-lens-chip-*`) — deleted in M10.

  it('fences the read-only HUD text off from touch rather than by inspection',
    async () => {
      // The other half of the `box-none` change. Making the HUD block
      // touchable would be a regression of its own if the prose came with it:
      // RN picks the DEEPEST view under the finger and then looks for a JS
      // responder, so a bare <Text> over something tappable swallows the touch
      // instead of passing it down. Every read-only line therefore sits inside
      // its own `pointerEvents="none"` box, and that is checked, not asserted
      // in a comment.
      const r = mount('imu');
      await settle();
      expect(r.blockers('panoplus-hud')).toContain('none');
      // ⚠ THE GUIDANCE LINE IS CHECKED IN A PHASE THAT HAS ONE (2026-09-07).
      // The idle branch of `panoPlusGuidance` returns empty strings since the
      // pre-sweep coaching was stripped, and the surface drops the NODE with
      // the text rather than leaving an empty line box in the column — so at
      // idle there is nothing to fence. `'starting'` still prints
      // "Metering — hold still", and the fence is what is under test, not the
      // phase.
      r.hold();
      await settle();
      expect(r.blockers('panoplus-guidance')).toContain('none');
      r.unmount();
    });
});

describe('the arm notice collapses without losing its text', () => {
  it('shows the headline, hides the detail, and opens on one tap', async () => {
    const r = mount('imu');
    await settle();
    // The headline is the summary and it NEVER moves — it names the arm and
    // what is wrong with it, which is the whole of what has to be legible with
    // the phone up at a shelf.
    expect(r.has('panoplus-arm-headline')).toBe(true);
    expect(r.shows('BASIS DERIVED, NEVER MEASURED')).toBe(true);
    // The paragraph is not on screen…
    expect(r.has('panoplus-arm-detail')).toBe(false);
    expect(r.shows('SENSOR_ORIENTATION')).toBe(false);
    // …and there is a visible handle saying so, because a collapsed
    // diagnostic with no handle is indistinguishable from a deleted one.
    expect(r.shows('tap for why')).toBe(true);
    r.tap('panoplus-arm-notice');
    expect(r.has('panoplus-arm-detail')).toBe(true);
    expect(r.shows('SENSOR_ORIENTATION')).toBe(true);
    r.tap('panoplus-arm-notice');
    expect(r.has('panoplus-arm-detail')).toBe(false);
    r.unmount();
  });

  it('writes the FULL detail into the pack even when it was never opened',
    async () => {
      const r = mount('imu');
      await settle();
      expect(r.has('panoplus-arm-detail')).toBe(false);   // collapsed
      r.hold();
      await settle();
      const notice = writes.find((w) => w.uri.endsWith('/host_notice.json'));
      expect(notice).toBeDefined();
      // Into the SESSION DIRECTORY native answered with, so `debugPack.ts`'s
      // whole-directory copy carries it without being taught anything.
      expect(notice!.uri).toBe(
        'file:///data/user/0/com.example.app/files/panoplus/pp_1'
        + '/host_notice.json',
      );
      const body = JSON.parse(notice!.body) as Record<string, unknown>;
      expect(body.schema).toBe('panoplus-host-notice/1');
      expect(body.headline).toBe('IMU ARM — BASIS DERIVED, NEVER MEASURED');
      // WHOLE, not truncated: a clipped diagnostic is worse than none because
      // it reads as complete.
      expect(String(body.detail)).toContain('SENSOR_ORIENTATION');
      expect(String(body.detail)).toContain('LENS_FACING');
      expect(String(body.detail).length).toBeGreaterThan(200);
      // And it records whether he could have READ it, which is the question a
      // field disagreement actually turns on.
      expect(body.shownExpanded).toBe(false);
      expect(body.poseSourceRequested).toBe('imu');
      expect(body.poseSourceEffective).toBe('imu');
      expect(body.armContract).toBe('android-sensor');
      r.unmount();
    });

  it('records shownExpanded when the operator DID open it', async () => {
    const r = mount('imu');
    await settle();
    r.tap('panoplus-arm-notice');
    r.hold();
    await settle();
    const notice = writes.find((w) => w.uri.endsWith('/host_notice.json'));
    const body = JSON.parse(notice!.body) as Record<string, unknown>;
    expect(body.shownExpanded).toBe(true);
    r.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE IDLE VIEWFINDER: THE ARM IT FRAMES FOR, AND THE FEED IT NOTICES DYING
// ═══════════════════════════════════════════════════════════════════════════

describe('the idle viewfinder is asked for the arm the sweep will run', () => {
  it('sends poseSource with the request on the IMU arm — and the AR arm asks for none', async () => {
    // ⚠ THE 1.60× FRAMING BUG, AS ONE ASSERTION. `setIdlePreview` carried only
    // `{lens}`, which the Android sweep ignores — so the idle session ran the
    // recorder's widest-FOV rule and opened the ULTRA-WIDE (camera 2, 96.2°)
    // while an AR sweep records through ARCore's CameraConfig camera (camera 0,
    // 69.7°). Measured on the A35 from an untouched phone pose: zero SIFT
    // matches between the two frames. The arm has to cross the bridge or the
    // viewfinder is a picture of a shot the operator will not get.
    const r = mount('imu');
    await settle();
    const asked = idleCalls.filter((c) => c.on);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[asked.length - 1]!.options.poseSource).toBe('imu');
    r.unmount();
    idleCalls = [];
    // M2: on the AR arm the stitcher's AR view is the viewfinder, so the
    // Camera2 idle viewfinder — a second camera owner — is never opened.
    const ar = mount('ar');
    await settle();
    expect(idleCalls.filter((c) => c.on)).toEqual([]);
    ar.unmount();
    idleCalls = [];
  });
});

describe('the idle viewfinder is asked to match the rate the sweep will pin', () => {
  it('sends pinPreviewFps with every open — the native default is OFF', async () => {
    // ⚠ THE KNOB WAS BUILT, WIRED AND UNREACHABLE. `PanoPlusIdlePreview` has
    // pinned CONTROL_AE_TARGET_FPS_RANGE through the recorder's own selector
    // since 2026-09-07 (`PanoPlusIdlePreview.kt:691`,
    // `PanoPlusAndroidProbe.kt:1841`), behind `pinPreviewFps`, which
    // `PanoPlusLiveModule.kt:985` defaults to FALSE. This effect never sent
    // the key, so the only reachable state was the unpinned one: the operator
    // framed through a HAL-default VARIABLE range that dims and stutters in a
    // dim aisle, and recorded through a pinned one.
    // The IMU arm only — the AR arm opens no idle viewfinder (M2).
    const r = mount('imu');
    await settle();
    const asked = idleCalls.filter((c) => c.on);
    expect(asked.length).toBeGreaterThan(0);
    for (const call of asked) {
      expect(call.options.pinPreviewFps).toBe(true);
    }
    r.unmount();
    idleCalls = [];
  });

  it('says so on screen when the camera REFUSED the pin', async () => {
    // A viewfinder that is up and does not match is worse than a black one,
    // because it looks right. iOS names the same case in its own reason
    // string; Android answers it as a flag so the panel can branch.
    idleFpsReply = {
      previewFpsApplied: false,
      previewFpsRange: '[60, 60]',
      previewFpsNote: 'camera 0 REFUSED CONTROL_AE_TARGET_FPS_RANGE [60, 60] '
        + 'even though it advertises it; the viewfinder is up at the HAL\'s '
        + 'own rate and does NOT match what the sweep will record',
    };
    const r = mount('imu');
    await settle();
    expect(r.has('panoplus-preview-pin')).toBe(true);
    expect(r.shows('does NOT match what the sweep will record')).toBe(true);
    r.unmount();
  });

  it('says nothing when the pin APPLIED', async () => {
    idleFpsReply = {
      previewFpsApplied: true,
      previewFpsRange: '[60, 60]',
      previewFpsNote: 'the viewfinder is pinned to [60, 60] — the same range '
        + 'the sweep will request, chosen by the same selector',
    };
    const r = mount('imu');
    await settle();
    expect(r.has('panoplus-preview-pin')).toBe(false);
    r.unmount();
  });

  it('says nothing on a binary that does not report the pin', async () => {
    // `idleFpsReply` stays null: the pre-2026-09-07 answer, `{on, reason}`.
    // Silence about the rate is not evidence of a wrong rate.
    const r = mount('imu');
    await settle();
    expect(r.has('panoplus-preview-pin')).toBe(false);
    r.unmount();
  });

  // ── THE PIN IS THE HOST'S CHOICE, NOT THIS FILE'S ────────────────────────
  //
  // The Kotlin says so four times over — `PanoPlusLiveModule.kt:974-985` ("THE
  // RATE PIN IS A KNOB AND IT DEFAULTS OFF … The default is the OPERATOR'S to
  // flip, after he has seen both pictures"), `PanoPlusIdlePreview.kt:94`,
  // `:301-313` ("it is his call, not this file's"),
  // `PanoPlusAndroidRecorder.kt:961-964`. This surface used to send a hardcoded
  // `true`, which made every one of those sentences false: the only host that
  // exists always overrode the knob, and the operator had no row anywhere to
  // put the unpinned picture back. A pinned 60 means shorter exposures, so the
  // aisle viewfinder is DARKER — that is a field-visible change with no A/B.
  //
  // So it is a PROP, fed by `panoPlusPinPreviewFps`, which ships ON in
  // FIELD_BASELINE per D-004 (a feature shipped off in the field build has not
  // been tested) and is reachable in the gear for the other arm.

  it('sends the pin the HOST asked for, in both directions', async () => {
    for (const want of [true, false]) {
      const r = mount('imu', { pinPreviewFps: want });
      await settle();
      const asked = idleCalls.filter((c) => c.on);
      expect(asked.length).toBeGreaterThan(0);
      for (const call of asked) {
        expect(call.options.pinPreviewFps).toBe(want);
      }
      r.unmount();
      idleCalls = [];
    }
  });
});

describe('the idle viewfinder notices when it loses the camera', () => {
  it('re-asks for the feed when native reports the viewfinder detached', async () => {
    // ⚠ THE FROZEN-FRAME INCIDENT. A TextureView keeps its last frame after
    // the producer goes away, so an evicted camera leaves a full, sharp,
    // STALE picture on screen — measured on the A35 as three screenshots two
    // seconds apart with identical md5 and `Active Camera Clients: []`. The
    // idle effect's deps (`avfIdleWanted`, `lens`) cannot change when native
    // loses the camera, so nothing ever re-asked and nothing ever said so.
    const r = mount('imu');
    await settle();
    const before = idleCalls.filter((c) => c.on).length;
    expect(before).toBeGreaterThan(0);

    statusReply = {
      running: false,
      viewfinderAttached: false,
      viewfinderNote: 'another camera client took camera 2',
    };
    await act(async () => {
      jest.advanceTimersByTime(PANO_PLUS_IDLE_HEARTBEAT_MS + 1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(idleCalls.filter((c) => c.on).length).toBeGreaterThan(before);
    r.unmount();
  });

  it('stops probing once the feed is known to be down', async () => {
    // The heartbeat is a LIVENESS probe, not a retry loop: re-asking on a
    // timer would fight the other app the operator deliberately opened. One
    // re-ask per loss, then silence until something changes.
    idleAnswersOn = false;
    idleReason = 'ERROR_CAMERA_IN_USE';
    const r = mount('imu');
    await settle();
    const after = idleCalls.filter((c) => c.on).length;

    statusReply = { running: false, viewfinderAttached: false, viewfinderNote: 'gone' };
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(PANO_PLUS_IDLE_HEARTBEAT_MS + 1);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(idleCalls.filter((c) => c.on).length).toBe(after);
    r.unmount();
  });

  it('re-asks when the app comes back to the foreground', async () => {
    // `PanoPlusAndroidRecorder.onHostPause` now releases the idle camera when
    // the Activity pauses (it held camera 2 for ~3 s with the app off screen,
    // measured), so SOMETHING has to ask for it back. This is that something;
    // the heartbeat above is the belt to its braces.
    const r = mount('imu');
    await settle();
    const before = idleCalls.filter((c) => c.on).length;
    await act(async () => {
      emitAppState('active');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(idleCalls.filter((c) => c.on).length).toBeGreaterThan(before);
    r.unmount();
  });
});

// The clone lens switcher (always on screen, painting `effectiveLens`, Pano's labels) — deleted in M10.
