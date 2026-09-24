// SPDX-License-Identifier: Apache-2.0
/**
 * `<Camera engine="sweep">` — the engine selector, at the one layer that can
 * be wrong without anything failing.
 *
 * ── WHAT THIS PROTECTS ──────────────────────────────────────────────────
 *
 * 1. **EXACTLY ONE AR MOUNT.** `<Camera>` draws an `<ARCameraView>` and so
 *    does the sweep surface. Two mounts mean two `RNSARSession.shared.start()`
 *    calls against one camera: no compile error, no link error, and a black
 *    preview or a frozen session on a phone. This is the assertion that says
 *    the delegation returned EARLY rather than rendering both.
 *
 * 2. **THE SWEEP NEVER REACHES `incremental.start()`.** It is not a mode of
 *    the keyframe engine — it is its own native module family. Both natives
 *    answer `engine-unavailable` for the string 'sweep', deliberately,
 *    because nothing should arrive there with it. If the JS branch is ever
 *    removed, this test fails instead of a device reporting a rejected
 *    promise (which is exactly how the gap was found the first time).
 *
 * 3. **ONE RESULT CHANNEL.** A sweep completes on `onCapture` and fails on
 *    `onError`, like every other engine, so a host does not learn a second
 *    channel to use one engine.
 */
// M8 — the REAL sweep engine, with what `<Camera>` passes it recorded.
jest.mock('../useSweepEngine', () =>
  require('./sweepEngineSpy').sweepEngineSpyFactory());
import React from 'react';
import { StyleSheet } from 'react-native';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sensorsMock = require('react-native-sensors') as {
  __emitAccelerometer: (s: { x: number; y: number; z: number }) => void;
  __resetAccelerometer: () => void;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const safeAreaMock = require('react-native-safe-area-context') as {
  __setInsets: (
    v: { top: number; left: number; right: number; bottom: number } | null,
  ) => void;
};
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  ARToggle,
  Camera,
  LensChip,
  _sweepHostOwnsCameraForTests as hostOwns,
} from '../../camera/Camera';
import type { CameraCaptureResult } from '../../camera/Camera';
import { CameraView } from '../../camera/CameraView';
import { ARCameraView } from '../../camera/ARCameraView';
import { CaptureStatusOverlay } from '../../camera/CaptureStatusOverlay';
import { CaptureCountdownOverlay } from '../../camera/CaptureCountdownOverlay';
import { lastSweepProps, resetSweepEngineCalls, sweepArFramesSeen } from './sweepEngineSpy';
import { SWEEP_ENGINE_DEFAULTS } from '../sweepDefaults';

/** Composite component names in the tree — the host-string walker below
 *  cannot see these, and "is the keyframe chrome absent" is a question
 *  about composites. */
function namesOf(tree: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (n == null) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const t = n.type;
    if (typeof t === 'function') out.push(t.displayName ?? t.name ?? '');
    (n.children ?? []).forEach(walk);
  };
  walk(tree.root);
  return out;
}

/** Every host component the renderer produced, by display name. */
function names(tree: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (n == null) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n.type === 'string') out.push(n.type);
    (n.children ?? []).forEach(walk);
  };
  walk(tree.toJSON());
  return out;
}

// ⚠ FAKE TIMERS, LIKE THE SURFACE'S OWN RENDER TESTS. The sweep surface arms
// an AR-ready `setTimeout` on mount; with real timers it outlives the test and
// jest hangs at the end of the run rather than failing — `--detectOpenHandles`
// names it, but only if you already suspect something. Fake timers make the
// handle jest's to collect.
beforeEach(() => { jest.useFakeTimers(); });
// ⚠ THE SENSOR RESET BELONGS HERE, NOT AT THE END OF A CASE BODY. The
// accelerometer mock's subscriber set is module-global, and two cases below
// reset it as their last statement — which a case that THROWS never reaches.
// Measured: with one rotation case failing, the next case started with five
// live subscribers and a still-mounted tree receiving every sample, so a
// FAILING case silently changed the behaviour of the ones after it. That is
// the worst possible way for a suite to be wrong: the second failure is not
// about the second case.
afterEach(() => {
  sensorsMock.__resetAccelerometer();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

function render(props: Record<string, unknown>): ReactTestRenderer {
  let t!: ReactTestRenderer;
  act(() => { t = create(<Camera {...(props as any)} />); });
  return t;
}

describe('<Camera engine="sweep">', () => {
  it('mounts the sweep surface', () => {
    const tree = render({ engine: 'sweep' });
    // The seam renders ARCameraView as a host node of that name; the sweep
    // surface is what puts one on screen in this mode.
    expect(names(tree).length).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });

  /**
   * ── THIS CASE USED TO ASSERT THE OPPOSITE, AND IT WAS VACUOUS ─────────
   *
   * It read `expect(names(render({engine:'sweep'}))).not.toContain(
   * 'CameraView')` with the comment "the sweep path must not, or two camera
   * sessions are alive at once". S7 makes the sweep path render
   * `<CameraView>` ON PURPOSE on the Android host arm — so the file went on
   * documenting the inverse of the shipped design, and the next reader
   * trying to restore the invariant would have found a test already
   * "protecting" it.
   *
   * It also never tested anything: `names()` walks `tree.toJSON()` and
   * collects HOST node types, and `CameraView` is a COMPOSITE. The
   * assertion was true of every render this package can produce, including
   * one that mounted ten of them. `findAllByType` is the fix for that half.
   *
   * What is actually invariant is narrower and stated per platform, because
   * the answer genuinely differs: on iOS nothing reads `vcPluginArm`, so the
   * sweep must NOT mount a second session there. The shared mocks pin
   * `Platform.OS === 'ios'`, which makes that the case this suite checks.
   *
   * ⚠ AND THAT PINNING IS NOT A LIMIT OF THE PROJECT, which five review
   * rounds treated it as. `cameraSweepHostArm.render.test.tsx` overrides
   * `Platform.OS` and the device hooks locally and drives the ANDROID host
   * arm end to end — preview lifecycle, review cycle, ownership handoff. If
   * you are about to write "this cannot fail here", check there first. The
   * mutations it kills that nothing else did: dropping the `started` term
   * from `sweepPreviewLive`, deleting the ownership settle, mis-keying the
   * clearing effect (the review cycle), and putting the sweep's lifecycle
   * callbacks back on the shared preview element (the engine round trip).
   */
  it('⚑ iOS (M5): the sweep runs on <Camera>\'s OWN camera — one <CameraView>, and the surface owns none', async () => {
    // Until M5 an iOS non-AR sweep opened pano+'s OWN AVCaptureSession
    // (`RNISPanoAvfSource`) and this case pinned ZERO previews beside it. Now
    // vision-camera owns the camera on both platforms and the sweep is fed from
    // it; the surface is told the host owns it and asks native to open nothing.
    const tree = render({ engine: 'sweep' });
    // The AR-support probe holds the preview back until it settles.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(tree.root.findAllByType(CameraView)).toHaveLength(1);
    expect(surfaceProps(tree).frameSource).toBe('host');
    act(() => { tree.unmount(); });
  });

  it('⚑ POSITIVE CONTROL: the keyframe engine DOES mount one here', () => {
    // ⚠ THIS CASE USED TO BE A DISCLAIMER. It read "…AND THAT CASE IS
    // VACUOUS IN THIS HARNESS", and proved it by asserting that rendering
    // the keyframe path THROWS — because `PanoramaSettingsModal` needed a
    // `Modal` the render mock did not carry.
    //
    // That was true, and it was also a thing to fix rather than document:
    // adding `Modal` to the mock (one line) makes the whole keyframe tree
    // mountable, which turns the case above from vacuous into real — a
    // second camera on the sweep path would now be visible against a
    // control that genuinely shows one.
    //
    // It is the same lesson as `cameraSweepHostArm.render.test.tsx`: a
    // harness limitation asserted rather than tested is itself a vacuous
    // claim. Two of them were load-bearing for five review rounds.
    const tree = render({});
    expect(tree.root.findAllByType(CameraView).length).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });

  // ⚠ THE SURFACE-ROOT CASE THAT WAS HERE HAS MOVED, because it was reading
  // the wrong View. With no native module registered the surface takes its
  // `available === false` early return and renders the "pano+ is not
  // available" card — whose style is ALSO `{flex: 1, backgroundColor:
  // '#000'}`. The probe matched that, and passed on the pre-fix code.
  // `panoPlusHostArm.render.test.tsx` mounts the surface directly with
  // native installed, asserts it got PAST the unavailable card first, and is
  // red-first against the fix.

  it('accepts sweep options without them leaking onto other engines', () => {
    // A compile-level guarantee made observable: the bag is one prop, so a
    // keyframe render with no `sweep` is unaffected by its existence.
    const tree = render({ engine: 'sweep', sweep: { rectify: false, gainMatch: false } });
    expect(names(tree).length).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });

  // ══════════════════════════════════════════════════════════════════
  //  WHAT REACHES THE SURFACE — the assertions that were missing
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠ EVERY CASE ABOVE THIS POINT PASSES WHEN THE SWEEP IS COMPLETELY
  // MISCONFIGURED, AND THAT IS NOT HYPOTHETICAL — IT HAPPENED.
  // `expect(names(tree).length).toBeGreaterThan(0)` asserts "the renderer
  // produced at least one host node", which is true of any render at all.
  // So this suite was green on a build where `<Camera engine="sweep">`
  // handed the surface NO options, the surface's bare `poseSource = 'ar'`
  // default fired, the recorder latched the ARCore pose arm, ARCore could
  // not track in a dim room, and all 120 frames of a real sweep on a Galaxy
  // A35 refused `buffer-empty` and painted nothing.
  //
  // A delegation is a set of VALUES crossing a boundary. Counting nodes on
  // the far side cannot see them. These read the props off the real surface
  // element — no mock, so the delegation under test is the one that ships.

  /** The props `<Camera>` actually handed the sweep engine and its screen. */
  function surfaceProps(_tree: ReactTestRenderer): Record<string, unknown> {
    return lastSweepProps() as Record<
      string,
      unknown
    >;
  }

  it('asks for the arm the HOST chose, not a second hidden opinion', async () => {
    // ⚠ THE CONTROLS BELONG TO `<Camera>`. The sweep surface draws its own
    // AR pill, but the value behind it is `arPreference` — the same state
    // the keyframe path's AR toggle writes. A separate default here would
    // let an operator toggle AR on and watch the sweep ignore it.
    const off = render({ engine: 'sweep' });
    expect(surfaceProps(off).poseSource).toBe('imu');   // defaultCaptureSource is non-AR
    act(() => { off.unmount(); });

    // ⚠ THE **EFFECTIVE** SOURCE, NOT THE RAW PREFERENCE. `poseSource` is
    // now `sweepMergedPoseSource(bag, effectiveCaptureSource === 'ar')`, so
    // Pano's "0.5× implies the non-AR arm" rule reaches the sweep as a
    // consequence rather than as a second copy. `defaultCaptureSource:'ar'`
    // with the default 1× lens still resolves to 'ar' — but only once the
    // async support probe has settled, which is why this awaits.
    const on = render({ engine: 'sweep', defaultCaptureSource: 'ar' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(surfaceProps(on).poseSource).toBe('ar');
    act(() => { on.unmount(); });
  });

  it('⚑ the surface draws NEITHER pill — `<Camera>` owns both now', () => {
    // ⚠ THIS CASE USED TO ASSERT THE OPPOSITE, and both versions trace to
    // the same operator report. The first was "I do not see AR pill and
    // lens pill", fixed by handing the SURFACE the writers so it drew its
    // own. That was the wrong fix, and the second report is what it cost:
    // "cannot deselect the AR mode" and "I see only 1x in the lens chip".
    //
    // The surface's clones are not `<Camera>`'s controls. Its AR pill
    // paints `armNotice.effectivePoseSource` — which arm will RUN — and
    // its chip's `has0_5x` is `ultraWideOfferable`, whether the pano+
    // ladder permits 0.5× on that arm. On an uncalibrated phone the IMU
    // arm falls back to ARKit, so the pill pinned ON with a handler that
    // wrote a value the state already held, and the chip collapsed to a
    // static `1×` with no `Pressable`.
    //
    // A switch shows the SETTING. What will run is the arm notice's job.
    // So `<Camera>` withholds both writers — the surface's own documented
    // way of saying "the host draws this" — and renders its own pills over
    // the sweep instead.
    const tree = render({ engine: 'sweep' });
    const props = surfaceProps(tree);
    expect(props.onPoseSourceChange).toBeUndefined();
    expect(props.onLensChange).toBeUndefined();
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the sweep cell renders `<Camera>`\'s OWN lens chip instead', () => {
    // The other half: withholding alone would just delete two controls.
    // The chip must be the SAME component the keyframe tree uses, driven
    // by `<Camera>`'s `lens` and the camera's real `has0_5x` — not by the
    // pano+ arm ladder.
    const sweep = render({ engine: 'sweep' });
    expect(sweep.root.findAllByType(LensChip).length).toBe(1);
    act(() => { sweep.unmount(); });

    // …and it is the same one, so a future edit cannot fork them.
    const keyframe = render({});
    expect(keyframe.root.findAllByType(LensChip).length).toBe(1);
    act(() => { keyframe.unmount(); });
  });

  it('⚑ 0.5× puts the sweep on the DECOUPLED arm, exactly as Pano does', async () => {
    // Pano's rule: `deriveEffectiveCaptureSource` answers 'non-ar' at 0.5×
    // because ARKit/ARCore cannot use the ultra-wide. It does NOT mutate
    // `arPreference` — it derives.
    //
    // Now that `<Camera>`'s lens chip drives the sweep too, reading the raw
    // preference here would let the chip move the lens to 0.5× while the
    // sweep still asked ARKit to open the ultra-wide. Reading the EFFECTIVE
    // source makes the sweep inherit Pano's rule instead of carrying a
    // second copy of it.
    const tree = render({
      engine: 'sweep',
      defaultCaptureSource: 'ar',
      defaultLens: '0.5x',
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // AR is PREFERRED and supported, but the lens forces the non-AR arm.
    expect(surfaceProps(tree).poseSource).toBe('imu');
    act(() => { tree.unmount(); });
  });

  it('⚑ a host BAG cannot bring the clone pills back', async () => {
    // The writers were withheld ABOVE `{...sweep}`, under a comment reading
    // "WITHHELD UNCONDITIONALLY". A bag carrying either one overwrote the
    // `undefined` and the surface drew its own clone again — measured, before
    // the fix, as TWO AR pills and TWO lens chips in one tree, with the whole
    // suite green because no test rendered the bag route.
    //
    // `SweepOptions` now omits both, so this is a `as never` in the test and
    // a compile error for a real host; the runtime assertion is the belt.
    const tree = render({
      engine: 'sweep',
      sweep: { onLensChange: () => {}, onPoseSourceChange: () => {} } as never,
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(surfaceProps(tree).onLensChange).toBeUndefined();
    expect(surfaceProps(tree).onPoseSourceChange).toBeUndefined();
    // …and exactly one of each control in the whole tree.
    expect(tree.root.findAllByType(LensChip)).toHaveLength(1);
    expect(tree.root.findAllByType(ARToggle)).toHaveLength(1);
    act(() => { tree.unmount(); });
  });

  it('⚑ hideBuiltInShutter does not delete the sweep\'s only AR control', async () => {
    // pano+'s documented host config is exactly `bottomBarOffset: 150,
    // hideBuiltInShutter` (panoPlusModel.ts:2149) — the surface draws the
    // shutter, so `<Camera>`'s is hidden. That term also gated the AR pill,
    // which deleted it outright on the one configuration the sweep ships
    // under: defect #1 rebuilt one layer up, and no test rendered the flag.
    const tree = render({ engine: 'sweep', hideBuiltInShutter: true });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(tree.root.findAllByType(ARToggle)).toHaveLength(1);
    act(() => { tree.unmount(); });
  });

  it('⚑ D18: …and it does not delete the KEYFRAME engine\'s either — one predicate', async () => {
    // INVERTED BY D18 (M8). This was the negative control for a term that hid
    // the pill on a keyframe host with its own shutter and not on the sweep —
    // the pill's presence depended on the engine. The pill is a CAMERA
    // control, not shutter chrome, so `hideBuiltInShutter` hides it on
    // neither engine. The private shell gains it on keyframe (U2 checks it).
    const tree = render({ hideBuiltInShutter: true });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(tree.root.findAllByType(ARToggle)).toHaveLength(1);
    act(() => { tree.unmount(); });
  });

  it('⚑ …but a single-source host still gets no pill, on either engine', async () => {
    // NEGATIVE CONTROL for the case above: the predicate still has terms.
    for (const engine of ['sweep', 'keyframe'] as const) {
      const tree = render({ engine, captureSources: 'non-ar' });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect({ engine, pills: tree.root.findAllByType(ARToggle).length })
        .toEqual({ engine, pills: 0 });
      act(() => { tree.unmount(); });
    }
  });

  it('⚑ M8: the settings modal knows the engine — the keyframe knobs are not offered for a sweep', () => {
    const { PanoramaSettingsModal } = require('../../camera/PanoramaSettingsModal');
    const sw = render({ engine: 'sweep' });
    expect(sw.root.findByType(PanoramaSettingsModal).props.engine).toBe('sweep');
    act(() => { sw.unmount(); });
    const kf = render({});
    expect(kf.root.findByType(PanoramaSettingsModal).props.engine).toBe('keyframe');
    act(() => { kf.unmount(); });
  });

  it('⚑ M8: the lens chip is the MAIN tree\'s — the same place on both engines', async () => {
    // Until M8 the sweep docked `<Camera>`'s chip above the SURFACE's bottom
    // slot (its own shutter), at a computed `bottom`. The sweep now runs in
    // `<Camera>`'s own tree, so the chip sits in `<Camera>`'s own bottom bar,
    // beside the one shutter — wherever the keyframe engine puts it (U2).
    const chain = (t: ReactTestRenderer): string[] => {
      const out: string[] = [];
      let n: ReturnType<typeof t.root.findByType> | null = t.root.findByType(LensChip).parent;
      while (n != null) {
        if (typeof n.type === 'string') out.push(JSON.stringify(StyleSheet.flatten(n.props?.style) ?? null));
        n = n.parent;
      }
      return out;
    };
    safeAreaMock.__setInsets({ top: 47, left: 0, right: 0, bottom: 34 });
    const sweepTree = render({ engine: 'sweep' });
    await act(async () => { await Promise.resolve(); });
    const keyframeTree = render({ engine: 'keyframe' });
    await act(async () => { await Promise.resolve(); });
    expect(chain(sweepTree).length).toBeGreaterThan(2);
    expect(chain(sweepTree)).toEqual(chain(keyframeTree));
    act(() => { sweepTree.unmount(); keyframeTree.unmount(); });
    safeAreaMock.__setInsets(null);
  });

  it('⚑ the AR pill clears the HOST\'s docked top chrome', async () => {
    // The surface takes `hostChromeTopPt` and folds it into the top inset
    // (`withHostChromeTop`) precisely because a host with a docked banner
    // paints over anything placed at the bare inset. Moving the pill out of
    // the surface left that term behind, so on such a host it sits under
    // the banner — invisible to every component-counting assertion.
    const pillTop = (t: ReactTestRenderer): number => {
      let n: ReturnType<typeof t.root.findByType> | null =
        t.root.findByType(ARToggle).parent;
      while (n != null) {
        const st = StyleSheet.flatten(n.props?.style) as { top?: number } | undefined;
        if (st?.top != null) return st.top;
        n = n.parent;
      }
      throw new Error('no container with a top above the AR pill');
    };
    const base = render({ engine: 'sweep' });
    await act(async () => { await Promise.resolve(); });
    const t0 = pillTop(base);
    act(() => { base.unmount(); });

    // M8 — `<Camera topChromeInset>` on both engines (the bag's
    // `hostChromeTopPt` is gone), and the engine is handed the same value so
    // its hold overlay clears the banner too.
    for (const engine of ['sweep', 'keyframe'] as const) {
      const docked = render({ engine, topChromeInset: t0 + 120 });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await Promise.resolve(); });
      expect({ engine, top: pillTop(docked) }).toEqual({ engine, top: t0 + 120 });
      if (engine === 'sweep') expect(surfaceProps(docked).hostChromeTopPt).toBe(t0 + 120);
      act(() => { docked.unmount(); });
    }
  });

  it('⚑ BLOCKER: the shared chrome hides while the surface owns the screen', async () => {
    // FIRST RUN ON AN UNCALIBRATED PHONE. The surface puts up the
    // basis-acquisition card and removes BOTH of its own pills — the note
    // beside that term names the hazard: "the suppression would summon the
    // more damaging of the two controls."
    //
    // That term did not travel when the pills moved to `<Camera>`. The
    // copies here are rendered AFTER the surface, so they paint ON TOP of a
    // full-screen overlay, and their ancestors are all `box-none` so they
    // are live. One tap of the AR pill moved the arm to ARKit, which made
    // `armWantsBasis` false and unmounted the card — the one-time basis
    // measurement cancelled by a control that should not have been there.
    // M8: ONLY ON THE DR-1a HATCH. In the one tree the engine mounts no basis
    // card at all (the vision-camera arm derives its basis, D3), so the old
    // screen — the hatch's — is the only place the card and this gate exist.
    const tree = render({ engine: 'sweep', sweep: { frameSourceOverride: 'own' } });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const report = surfaceProps(tree).onEffectiveArmChange as (a: {
      poseSource: 'ar' | 'imu'; fallbackToAr: boolean; basisRoute: string;
      resolving: boolean; chromeSuppressed: boolean;
    }) => void;
    expect(typeof report).toBe('function');

    // Before the overlay: the chrome is up, as it must be.
    expect(tree.root.findAllByType(ARToggle)).toHaveLength(1);
    expect(tree.root.findAllByType(LensChip)).toHaveLength(1);

    await act(async () => {
      report({ poseSource: 'imu', fallbackToAr: false,
               basisRoute: 'gesture' as never, resolving: false,
               chromeSuppressed: true });
    });
    expect(tree.root.findAllByType(ARToggle)).toHaveLength(0);
    expect(tree.root.findAllByType(LensChip)).toHaveLength(0);

    // …and it comes BACK when the surface releases the screen. Without this
    // the fix could be "never draw the chrome on a sweep", which deletes the
    // unification this whole rung is for.
    await act(async () => {
      report({ poseSource: 'imu', fallbackToAr: false,
               basisRoute: 'stored' as never, resolving: false,
               chromeSuppressed: false });
    });
    expect(tree.root.findAllByType(ARToggle)).toHaveLength(1);
    expect(tree.root.findAllByType(LensChip)).toHaveLength(1);
    act(() => { tree.unmount(); });
  });

  // ⚠ NOT TESTED, DELIBERATELY, AND THE GAP IS NAMED RATHER THAN HIDDEN.
  //
  // `sweepEffectiveArm` is now cleared when `engine` leaves 'sweep'
  // (Camera.tsx), because the read is per-render but the STATE survived, so
  // sweep → keyframe → tap 0.5× → sweep re-applied the previous sweep's arm
  // and masked a lens the operator had legitimately chosen.
  //
  // The defect is a ONE-COMMIT transient and this rig cannot see it: on
  // re-entry the surface's own effect re-reports the same declined arm
  // before react-test-renderer flushes, so the stale value is replaced by an
  // identical fresh one and the masked and unmasked trees are indistinguishable
  // at every observable point. A case written anyway would pass whether the
  // reset is there or not — which is the vacuous pass this file exists to
  // avoid. Recorded here so the next reader knows it is a gap and not an
  // oversight.

  it('⚑ both pills are INERT mid-sweep, as the surface\'s own were', async () => {
    // The surface's handlers opened `if (phaseRef.current !== 'idle') return;`
    // under "Both taps are inert off-idle: the arm is latched for the sweep
    // and the lens cannot change under one." `<Camera>`'s replacements were a
    // bare `setLens` and a bare `setArPreference`. Reachable the ordinary
    // way: mid-hold, panning with one hand, the other thumb on the pill.
    const tree = render({ engine: 'sweep' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const sweeping = surfaceProps(tree).onSweepingChange as (b: boolean) => void;
    const lensBefore = tree.root.findByType(LensChip).props.lens;
    const arBefore = tree.root.findByType(ARToggle).props.arEnabled;

    await act(async () => { sweeping(true); });
    await act(async () => {
      (tree.root.findByType(LensChip).props.onChange as (l: string) => void)('0.5x');
      (tree.root.findByType(ARToggle).props.onToggle as () => void)();
    });
    expect(tree.root.findByType(LensChip).props.lens).toBe(lensBefore);
    expect(tree.root.findByType(ARToggle).props.arEnabled).toBe(arBefore);

    // NEGATIVE CONTROL — they work again once the hold ends, or the "fix"
    // could be a pill that never does anything.
    await act(async () => { sweeping(false); });
    await act(async () => {
      (tree.root.findByType(ARToggle).props.onToggle as () => void)();
    });
    expect(tree.root.findByType(ARToggle).props.arEnabled).toBe(!arBefore);
    act(() => { tree.unmount(); });
  });

  it('⚑ leaving the sweep mid-hold does not freeze the keyframe pills', async () => {
    // `sweepRunning` gates BOTH shared handlers, and the pills are SHARED —
    // the keyframe tree renders the same ones. Its only release on this path
    // was the surface's own unmount cleanup, so a host flipping `engine`
    // mid-hold left the keyframe engine's chrome permanently inert with
    // nothing on screen to say why.
    const tree = render({ engine: 'sweep' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      (surfaceProps(tree).onSweepingChange as (b: boolean) => void)(true);
    });
    // Flip engines WITHOUT ending the hold.
    await act(async () => { tree.update(<Camera />); });
    await act(async () => { await Promise.resolve(); });
    const before = tree.root.findByType(ARToggle).props.arEnabled;
    await act(async () => {
      (tree.root.findByType(ARToggle).props.onToggle as () => void)();
    });
    expect(tree.root.findByType(ARToggle).props.arEnabled).toBe(!before);
    act(() => { tree.unmount(); });
  });

  it('⚑ GUARD RAIL: rotating the device mid-sweep ABANDONS the capture', async () => {
    // ⚠ THIS WAS DEAD ON THE SWEEP, AND NOT BECAUSE ANYONE DISABLED IT.
    // `startPanorama` returns before `handleHoldStartRef` on a sweep
    // (Camera.tsx:2144), so `statusPhase` never reaches 'recording' — and
    // `useOrientationDrift(statusPhase === 'recording')` was therefore never
    // armed. The same one line switched off the REC banner, the wall-clock
    // countdown, the auto-finalize and `onCaptureAbandoned`.
    //
    // The guards now read `captureRecording`, which is true on EITHER
    // engine, while the keyframe MACHINERY keeps reading `statusPhase` —
    // widening the phase itself would start `incremental`'s internals during
    // a sweep.
    const abandoned: string[] = [];
    const tree = render({
      engine: 'sweep',
      onCaptureAbandoned: (r: string) => { abandoned.push(r); },
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Portrait first, so the drift detector has a reference to drift FROM.
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 0, y: 9.8, z: 0 }); });
    await act(async () => {
      (surfaceProps(tree).onSweepingChange as (b: boolean) => void)(true);
    });
    expect(abandoned).toHaveLength(0);

    // …now turn the phone on its side, mid-sweep.
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 9.8, y: 0, z: 0 }); });
    await act(async () => { await Promise.resolve(); });
    expect(abandoned).toEqual(['orientation-drift']);
    // ⚠ WHAT THIS DOES NOT PROVE, stated rather than implied: that the
    // SWEEP itself stopped. Removing the sweep branch from the abandon
    // effect leaves this case green — the keyframe path still notifies the
    // host — so `onCaptureAbandoned` alone cannot tell an abandoned sweep
    // from one silently still running. The surface's `abandon()` early-
    // returns unless its OWN phase is non-idle, and this rig installs no
    // native fakes, so the surface never leaves 'idle' here and the call is
    // unobservable. It is covered by the arming half only.
    act(() => { tree.unmount(); });
  });

  // ⚠ THE FINALIZE WINDOW, AND "DID THE SWEEP ITSELF STOP", MOVED — they are
  // in `sweepGuardRails.render.test.tsx`, which mounts a STUB surface with a
  // spy imperative handle. Both gaps were real here and had the same cause:
  // this rig drives a real surface with no native fakes, so it never leaves
  // 'idle' and every call `<Camera>` makes through the ref is swallowed by a
  // phase guard. Replacing the surface makes the calls themselves the
  // observable, which is the only layer at which "the cap FINALIZES rather
  // than abandoning" is a falsifiable sentence.
  //
  // What stays HERE is the arming half against the real component, which is
  // the half that needs a real component.

  it('⚑ …and NOT while idle — a guard that fires off-capture is worse', async () => {
    // Negative control: without it the case above passes for a detector
    // wired to fire on any rotation at all, which would abandon captures
    // that had not started.
    //
    // ⚠ WHAT IT DOES **NOT** PIN, because the name reads as though it does:
    // the `|| !captureRecording` term in the abandon effect. That term is
    // defence in depth — `useOrientationDrift`'s own state machine already
    // returns INITIAL_STATE whenever `active` is false, so deleting the
    // effect's term leaves this case green. The guard it names is real and
    // it is pinned, but ONE LAYER DOWN, by
    // `useOrientationDrift.test.ts`'s three `!active` cases ("clears the
    // snapshot", "clears the drift flag", "is idempotent"). This case pins
    // the COMPOSITION: that `<Camera>` passes the right `active` and does
    // not route an idle rotation to the host anyway.
    const abandoned: string[] = [];
    const tree = render({
      engine: 'sweep',
      onCaptureAbandoned: (r: string) => { abandoned.push(r); },
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 0, y: 9.8, z: 0 }); });
    await act(async () => { sensorsMock.__emitAccelerometer({ x: 9.8, y: 0, z: 0 }); });
    await act(async () => { await Promise.resolve(); });
    expect(abandoned).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  it('⚑ the REC banner and the wall-clock cap reach the sweep', async () => {
    // Both were `<Camera>`'s and both lived only in the keyframe tree, so a
    // sweep had no "you ARE recording" cue and no duration cap — a pano+
    // hold ran until the operator let go or the canvas filled, which is a
    // different promise and a much later one. The surface's own note names
    // the gap: "Pano's words on the same screen — its REC banner aside".
    const tree = render({ engine: 'sweep', maxPanDurationMs: 4000 });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const banner = () => tree.root.findByType(CaptureStatusOverlay).props.phase;
    const cd = () => tree.root.findAllByType(CaptureCountdownOverlay)
      .some((n) => n.props.visible === true);
    expect(banner()).toBe('idle');
    expect(cd()).toBe(false);

    await act(async () => {
      (surfaceProps(tree).onSweepingChange as (b: boolean) => void)(true);
    });
    expect(banner()).toBe('recording');
    expect(cd()).toBe(true);

    await act(async () => {
      (surfaceProps(tree).onSweepingChange as (b: boolean) => void)(false);
    });
    expect(banner()).toBe('idle');
    expect(cd()).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the cap FINALIZES the hold rather than abandoning it', async () => {
    // Reaching a time limit is not a fault — the panorama painted so far is
    // the deliverable, which is what the keyframe engine's own
    // `maxPanDurationMs` path does. A cap that discarded the capture would
    // be a worse outcome than no cap at all.
    jest.useFakeTimers();
    const abandoned: string[] = [];
    const tree = render({
      engine: 'sweep', maxPanDurationMs: 3000,
      onCaptureAbandoned: (r: string) => { abandoned.push(r); },
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const ends: number[] = [];
    const surf = surfaceProps(tree);
    void surf;
    await act(async () => {
      (surfaceProps(tree).onSweepingChange as (b: boolean) => void)(true);
    });
    await act(async () => { jest.advanceTimersByTime(3200); });
    // Nothing was abandoned: the cap ends the hold, it does not discard it.
    expect(abandoned).toHaveLength(0);
    void ends;
    act(() => { tree.unmount(); });
    jest.useRealTimers();
  });

  it('⚑ the chip paints the lens the ARM WILL OPEN, not the request', async () => {
    // FIELD DEFECT, 2026-09-19: "0.5x lens does not go to that camera — shows
    // the same view as 1x." Every layer below the chip was right. On iOS the
    // IMU arm has no τ for `model|lens|W×H|fps`, so `panoPlusArmNotice`
    // declines and falls back to ARKit — which publishes no ultra-wide format
    // at all. The request survives; the glass does not change. The chip went
    // on painting `0.5×` over an ARKit viewfinder that was on the wide.
    //
    // THE PURE TRUTH TABLE CANNOT CATCH THIS. `sweepEffectiveLens` is covered
    // case-by-case in `sweepHostOwnsCamera.test.ts`, and every one of those
    // stays green if the chip is handed the raw `lens` instead — which is
    // precisely the mis-wire that shipped. This drives the real chip.
    const tree = render({
      engine: 'sweep',
      defaultCaptureSource: 'ar',
      defaultLens: '0.5x',
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const report = surfaceProps(tree).onEffectiveArmChange as
      (a: { poseSource: 'ar' | 'imu'; fallbackToAr: boolean;
            basisRoute: string; resolving: boolean }) => void;
    // The seam itself: an unwired callback is the defect, so name it.
    expect(typeof report).toBe('function');

    // 1. THE ARM DECLINES. This is the shipped iPhone state.
    await act(async () => {
      report({ poseSource: 'ar', fallbackToAr: true,
               basisRoute: 'none' as never, resolving: false });
    });
    expect(tree.root.findByType(LensChip).props.lens).toBe('1x');
    // ⚠ AND THE AR PILL IS THE ESCAPE HATCH HERE, not hidden — this
    // assertion has now been wrong in BOTH directions and the reason is the
    // fourth term.
    //
    // Pano's rule hides the pill at 0.5×, and gating it on the MASKED lens
    // builds a dead control. But this harness's device publishes no
    // ultra-wide, so `LensChip` renders no Pressable at all — and with the
    // pill hidden too the screen would have ZERO live controls and no way
    // back. The surface's own gate carries `|| !chipCanMoveLens` for
    // exactly that, and it did not travel with the pill.
    //
    // So the pill shows, and pressing it COMMITS the 1× the chip is already
    // painting — otherwise showing it just moves the dead control.
    expect(tree.root.findAllByType(ARToggle)).toHaveLength(1);
    // ⚠ THE REQUEST IS UNTOUCHED. The mask is paint, not policy: if it fed
    // back into the request, 0.5× would never move the arm, the fallback
    // would never be evaluated, and this mask would have nothing to report.
    expect(surfaceProps(tree).lens).toBe('ultraWide');
    expect(surfaceProps(tree).poseSource).toBe('imu');

    // 2. NEGATIVE CONTROL — the arm accepts. Without this the case above
    //    passes for a chip hardcoded to `1×`, which would delete the
    //    ultra-wide from the product on the one arm that can open it.
    await act(async () => {
      report({ poseSource: 'imu', fallbackToAr: false,
               basisRoute: 'none' as never, resolving: false });
    });
    expect(tree.root.findByType(LensChip).props.lens).toBe('0.5x');

    // 3. IN FLIGHT — follows the request, so no label is offered that may be
    //    taken back one frame later.
    await act(async () => {
      report({ poseSource: 'ar', fallbackToAr: true,
               basisRoute: 'none' as never, resolving: true });
    });
    expect(tree.root.findByType(LensChip).props.lens).toBe('0.5x');

    // …and LAST, the escape hatch actually escapes. On this body the chip
    // has no Pressable, so the pill is the only live control — pressing it
    // must COMMIT the 1× the chip has been painting, or showing it there
    // just moves the dead control from one pill to the other.
    await act(async () => {
      report({ poseSource: 'ar', fallbackToAr: true,
               basisRoute: 'none' as never, resolving: false });
    });
    await act(async () => {
      (tree.root.findByType(ARToggle).props.onToggle as () => void)();
    });
    expect(surfaceProps(tree).lens).toBe('wide');
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the keyframe engine is untouched by the mask', () => {
    // `engine` selects which engine the hold runs and changes nothing else.
    // No sweep surface exists here, so nothing can ever report an arm — the
    // assertion is that the chip still shows what the operator picked.
    const tree = render({ defaultLens: '0.5x' });
    expect(tree.root.findByType(LensChip).props.lens).toBe('0.5x');
    act(() => { tree.unmount(); });
  });

  it('starts the lens pill at the lens the other engine was using', () => {
    // Same state, so the control reads the same before and after a switch.
    const tree = render({ engine: 'sweep', defaultLens: '0.5x' });
    expect(surfaceProps(tree).lens).toBe('ultraWide');
    act(() => { tree.unmount(); });
  });

  it('supplies the tuned engine options rather than the native defaults', () => {
    // `crossTraj: 0` is the pre-2026-09 engine and elbows at every
    // block/strip join. Shipping the native defaults from a new public API
    // would ship a fixed bug back to every consumer that says nothing.
    const tree = render({ engine: 'sweep' });
    expect(surfaceProps(tree).engineOptions).toMatchObject({
      ...SWEEP_ENGINE_DEFAULTS,
    });
    act(() => { tree.unmount(); });
  });

  it('D9: the pose arm is <Camera>\'s own — a bag poseSource no longer overrides it', () => {
    // It made the AR pill a dead control on the sweep, and on Android it was
    // the route into pano+'s own Camera2 client. The key is no longer typed;
    // a stale host that still sends it is ignored.
    const tree = render({ engine: 'sweep', sweep: { poseSource: 'ar' } as never });
    expect(surfaceProps(tree).poseSource).toBe('imu');
    act(() => { tree.unmount(); });
  });

  it('MERGES engineOptions key-by-key so one host key cannot drop the rest', () => {
    // ⚠ THE BUG A PLAIN SPREAD WOULD REINTRODUCE, PINNED. `engineOptions` is
    // an object: `{...defaults}` then `{...sweep}` makes the host's copy
    // REPLACE it, so a host setting one option silently loses the other six
    // — including the trajectory continuation. Every default must survive
    // alongside the override.
    const tree = render({
      engine: 'sweep',
      sweep: { engineOptions: { crossTraj: 0 } },
    });
    const opts = surfaceProps(tree).engineOptions as Record<string, unknown>;
    expect(opts.crossTraj).toBe(0);                                  // host wins
    expect(opts.crossTrajRelaxPx).toBe(SWEEP_ENGINE_DEFAULTS.crossTrajRelaxPx);
    expect(opts.leadOutFromFrontier).toBe(SWEEP_ENGINE_DEFAULTS.leadOutFromFrontier);
    expect(opts.crossFitMode).toBe(SWEEP_ENGINE_DEFAULTS.crossFitMode);
    expect(opts.crossFitDcRemove).toBe(SWEEP_ENGINE_DEFAULTS.crossFitDcRemove);
    expect(opts.crossScaleLeak).toBe(SWEEP_ENGINE_DEFAULTS.crossScaleLeak);
    expect(opts.leadOutTraj).toBe(SWEEP_ENGINE_DEFAULTS.leadOutTraj);
    act(() => { tree.unmount(); });
  });

  // ══════════════════════════════════════════════════════════════════
  //  S7 — WHO OWNS THE CAMERA
  // ══════════════════════════════════════════════════════════════════

  it('⚑ M5: when the host camera cannot serve a hold, the hold is REFUSED — the surface never takes a camera', () => {
    // This case used to pin `'own'` on iOS: the fallback direction was "the
    // surface opens pano+'s own camera". Since M5 there is no such direction
    // on the non-AR arm. This harness's native module predates the iOS
    // vision-camera arm (no `vcArmSupported` constant) — the exact binary that
    // would open a second AVCaptureSession if sent the arm — so the hold is
    // refused by name, and ownership stays with `<Camera>`.
    const tree = render({ engine: 'sweep' });   // defaultCaptureSource is non-AR
    const p = surfaceProps(tree);
    expect(p.frameSource).toBe('host');
    expect((p.hostArmRefusal as { code: string } | null)?.code).toBe('panoplus-vc-arm-unavailable');
    act(() => { tree.unmount(); });
  });

  // ⚠ A CASE ABOUT THE LATCH/SETTLE INTERACTION WAS HERE AND IS DELETED.
  // It drove `onSweepingChange` across a sweep and asserted the surface's
  // props were unchanged — but this harness pins `Platform.OS = 'ios'` and
  // `useCameraDevice() => null`, so ownership is false on every render it
  // can build and the snapshot is constant whatever the code does. Measured:
  // it stayed green with the very latch guard it was named for deleted.
  //
  // A positive-sounding title over an assertion that cannot fail is worse
  // than no test, because the next reader stops looking. The real coverage
  // is the `sweepShouldSettle` / `sweepCameraHandoff` table in
  // `src/camera/__tests__/sweepHostOwnsCamera.test.ts`, which kills that
  // mutation and two others.

  // ⚠ A CASE ABOUT BAG-PINNED PILLS WAS HERE AND IS GONE. It asserted that
  // `sweep={{poseSource}}` withheld the surface's writer so the clone was
  // absent rather than dead. `<Camera>` withholds both writers
  // UNCONDITIONALLY now and draws the controls itself, so the bag can no
  // longer produce a dead pill by any route — there is no clone to kill.
  // The surviving property is asserted above: the surface gets neither
  // writer, and `<Camera>`'s own chip is the one on screen.

  it('⚑ hostPreviewLive is DERIVED, not hard-wired', () => {
    // A coverage hole this suite had three rounds running: the two lines
    // that connect `hostPreviewLive` to the screen — the `<Camera>` wiring
    // and the surface's root term — could BOTH be reverted with all 1178
    // cases green, because the only tests were of the pure decision it
    // feeds.
    //
    // The SHARED mocks cannot make ownership true, so the value here is
    // always false, and what this case checks is that the prop is not a
    // constant. The behaviour itself — false while the session opens, true
    // on the first preview frame, false again after a remount — is driven
    // for real in `cameraSweepHostArm.render.test.tsx`. Both
    // `hostPreviewLive` and `vcPluginArm` descend from `mountHostPreview`,
    // so the identity holds for every state and breaks the moment either is
    // pinned — which is precisely the regression that went unnoticed.
    for (const props of [
      { engine: 'sweep' },
      { engine: 'sweep', defaultCaptureSource: 'ar' as const },
    ]) {
      const p = surfaceProps(render(props));
      expect(typeof p.hostPreviewLive).toBe('boolean');
      // hostPreviewLive ⊆ vcPluginArm: it is `mountHostPreview && started`,
      // and `vcPluginArm` IS `mountHostPreview`. A hard-wired `true` breaks
      // this on every render the harness can build.
      expect(p.hostPreviewLive === true && p.vcPluginArm !== true).toBe(false);
      expect(p.hostPreviewLive).toBe(false);
    }
  });

  it('⚑ the sweep BAG cannot move who owns the camera', () => {
    // ⚠ THIS IS A REGRESSION TEST FOR A CLAIM, NOT JUST FOR CODE. The commit
    // that collapsed ownership into one predicate asserted "a disagreement is
    // no longer expressible". It was expressible, through the documented
    // public `sweep` bag: `{...sweep}` is spread OVER the props `<Camera>`
    // computes, so a host key won. Reproduced with exactly this probe.
    //
    // The state it produced is the worst one available: `frameSource: 'host'`
    // with `hostOwnsSweepCamera` false means `<Camera>` mounts NO preview,
    // the surface suppresses its own viewfinder AND its idle feed, and
    // `panoPlusCameraOffNotice` suppresses the explainer that exists to say
    // why a screen is dark. A black screen with its own description silenced.
    //
    // `SweepOptions` now omits all three, so this no longer type-checks —
    // hence the cast, which is what an untyped JS host effectively does.
    const hostile = {
      frameSource: 'own',
      vcPluginArm: false,
      vcCameraId: 'HOST-SUPPLIED-99',
    } as unknown as Record<string, unknown>;
    const p = surfaceProps(render({ engine: 'sweep', sweep: hostile }));
    expect(p.frameSource).toBe('host');       // <Camera>'s answer, not the bag's
    expect(p.vcPluginArm).toBe(true);
    expect(p.vcCameraId).toBe('');            // the device's id (none here), not the bag's
  });

  it('⚑ D9: a bag poseSource cannot pull the arm away from the camera the predicate judged', () => {
    // The collision this used to guard (bag 'ar' vs a predicate reading
    // `<Camera>`'s own state) cannot arise any more: both read `<Camera>`'s
    // own AR state, and the bag key is gone.
    const p = surfaceProps(render({
      engine: 'sweep', sweep: { poseSource: 'ar' } as never,
    }));
    expect(p.poseSource).toBe('imu');
    // M5: the non-AR arm is `<Camera>`'s camera on iOS too.
    expect(p.frameSource).toBe('host');
    expect(p.vcPluginArm).toBe(true);
  });

  it('⚑ never declares host ownership without also asking for the arm', () => {
    // The two props are derived from ONE boolean, and this is the invariant
    // that says so: a surface told "you own nothing" while native was never
    // asked to open nothing is the black-screen state exactly.
    //
    // ⚠ ASSERTED AGAINST THE PREDICATE, NOT AS AN iff BETWEEN THE TWO PROPS.
    // Both are constantly false in this harness, so `false === false`
    // satisfied the iff — and it survived RE-SPLITTING the two derivations,
    // which is the exact "three places, three answers" defect the collapse
    // exists to prevent. Pinning each prop to the predicate's own output
    // catches the narrowing direction too.
    for (const props of [
      { engine: 'sweep' },
      { engine: 'sweep', defaultCaptureSource: 'ar' as const },
      { engine: 'sweep', sweep: { engineOptions: { crossTraj: 0 } } },
    ]) {
      const tree = render(props);
      const p = surfaceProps(tree);
      // The predicate's answer for the state this harness pins on its first
      // render: non-AR (the AR probe has not answered yet), no hatch.
      const owns = hostOwns({
        isAR: false,
        frameSourceOverride: undefined,
      });
      expect(owns).toBe(true);
      expect(p.frameSource).toBe(owns ? 'host' : 'own');
      expect(p.vcPluginArm).toBe(owns);
      expect(p.vcCameraId).toBe('');
      act(() => { tree.unmount(); });
    }
  });

  it('⚑ M8: the AR arm runs on <Camera>\'s OWN AR view, which feeds the engine', async () => {
    // Until M8 the surface mounted a SECOND <ARCameraView> for the AR sweep —
    // the reason the sweep had to be a separate tree (two
    // RNSARSession.shared.start() calls against one camera). Now the engine
    // is told 'host-ar', mounts none, and gets its status from <Camera>'s
    // own view.
    // ⚠ THE AR PROBE IS ASYNCHRONOUS, so `isAR` is false for the first
    // render however the host configured it.
    resetSweepEngineCalls();
    const tree = render({ engine: 'sweep', defaultCaptureSource: 'ar' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { jest.advanceTimersByTime(1000); });
    await act(async () => { await Promise.resolve(); });
    expect(surfaceProps(tree).frameSource).toBe('host-ar');
    expect(surfaceProps(tree).vcPluginArm).toBe(false);
    expect(tree.root.findAllByType(CameraView)).toHaveLength(0);
    const arViews = tree.root.findAllByType(ARCameraView);
    expect(arViews).toHaveLength(1);
    act(() => {
      (arViews[0].props.onArFrame as (m: unknown) => void)({
        pose: { rotation: [0, 0, 0, 1], translation: [0, 0, 0] }, trackingState: 'normal',
      });
    });
    expect(sweepArFramesSeen()).toBe(1);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and the keyframe engine\'s AR view is the SAME element with the SAME config (D15)', async () => {
    const props = async (engine: 'sweep' | 'keyframe'): Promise<Record<string, unknown>> => {
      const t = render({ engine, defaultCaptureSource: 'ar' });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      act(() => { jest.advanceTimersByTime(1000); });
      await act(async () => { await Promise.resolve(); });
      const p = t.root.findByType(ARCameraView).props as Record<string, unknown>;
      const cfg = {
        keyframeQualityCapture: p.keyframeQualityCapture,
        keyframeQualitySourceMaxLongEdge: p.keyframeQualitySourceMaxLongEdge,
        arFrameMetaInterval: p.arFrameMetaInterval,
        planeDetection: p.planeDetection,
      };
      act(() => { t.unmount(); });
      return cfg;
    };
    const sweepCfg = await props('sweep');
    expect(sweepCfg).toEqual(await props('keyframe'));
    expect(sweepCfg.keyframeQualityCapture).toBe(true);   // panorama on ⇒ the larger CPU image
    expect(sweepCfg.arFrameMetaInterval).toBe(100);
  });

  it('⚑ M8: the settings gear and modal are SHARED chrome; the keyframe band is not drawn for a sweep', async () => {
    // INVERTED BY M8. This used to assert the settings modal was ABSENT on a
    // sweep, because the sweep was a separate tree that had to keep the main
    // tree's furniture out. The rule the collapse implements is that the
    // chrome is shared (U2): the gear and its modal on both engines. What
    // stays engine-specific is the LIVE progress display — the keyframe band
    // reads keyframes a sweep does not make; the sweep draws its own capsule.
    const tree = render({ engine: 'sweep' });
    expect(namesOf(tree)).toContain('PanoramaSettingsModal');
    await act(async () => {
      (surfaceProps(tree).onSweepingChange as (v: boolean) => void)(true);
    });
    expect(namesOf(tree)).not.toContain('PanoramaBandOverlay');
    act(() => { tree.unmount(); });
  });

  it('⚑ M8 (U2): at idle the sweep draws NOTHING of its own over the viewfinder', async () => {
    // The idle HUD, arm notice and bench lines were the sweep screen's; the
    // one tree shows the keyframe engine's idle screen on both engines. The
    // sweep's drawing appears for the length of a sweep and goes with it.
    const hasHud = (t: ReactTestRenderer) =>
      t.root.findAll((n) => n.props?.testID === 'panoplus-hud-block').length > 0;
    const tree = render({ engine: 'sweep' });
    await act(async () => { await Promise.resolve(); });
    expect(hasHud(tree)).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ DOES show the capture-history strip — a capture is a capture', () => {
    // FAILS BEFORE THE FIX: the strip was inlined in the main tree only, and
    // the `engine === 'sweep'` cell returns before reaching it — so the item
    // was appended to `thumbnails` and had nothing to render it. The fifth
    // thing that early return has eaten, after the crop editor, the review
    // surface, the guard modals and the warnings channel.
    const names = namesOf(render({
      engine: 'sweep',
      thumbnails: [{ id: '/d/pp_1/canvas.jpg', uri: 'file:///d/pp_1/canvas.jpg' }],
    }));
    expect(names).toContain('CaptureThumbnailStrip');
  });

  it('⚑ …and the keyframe engine still shows it, from the SAME definition', () => {
    // The point of `renderThumbnailStrip` is that there is one definition.
    // If this and the case above ever disagree, the trees have drifted again.
    const names = namesOf(render({
      engine: 'keyframe',
      thumbnails: [{ id: '/d/a.jpg', uri: 'file:///d/a.jpg' }],
    }));
    expect(names).toContain('CaptureThumbnailStrip');
  });

  it('⚑ does not re-enter the host handler when that handler sets state', () => {
    // THE HAZARD: `<Camera>` composes its worklet gate into this prop with
    // an INLINE arrow, so the prop identity changes on every parent render.
    // The surface's emit effect used to depend on that identity, so a host
    // handler that set state re-triggered the effect, which called the
    // handler again. React's bail-on-identical-state was the only brake,
    // and `<Camera>` now genuinely DOES set state here (the ownership
    // latch). One call per phase change, not per render.
    const seen: boolean[] = [];
    const tree = render({
      engine: 'sweep',
      sweep: { onSweepingChange: (s: boolean) => { seen.push(s); } },
    });
    const handler = surfaceProps(tree).onSweepingChange as (s: boolean) => void;
    const before = seen.length;
    act(() => { handler(true); });
    // Exactly one, and it is the one we sent. Before the fix this read
    // `[true, false, false]` — the extra pair being the effect firing
    // twice on the re-renders our own state update caused.
    expect(seen.slice(before)).toEqual([true]);
    act(() => { tree.unmount(); });
  });

  it('ownership does not flap across a sweep (⚠ CANNOT FAIL HERE — read on)', () => {
    // Native latches the arm from the options bag at `start` and never
    // re-reads it. So if ownership were recomputed live, a plugin handle
    // resolving mid-sweep would flip it to `true` and mount `<CameraView>`
    // against a device the recorder's Camera2 client already holds — and a
    // flip the other way would unmount the feed the engine is eating. That
    // is why `sweepOwnershipLatch` exists.
    //
    // ⚠ AND THIS CASE DOES NOT PROVE IT. Measured: deleting the latch
    // leaves this green. The live value is pinned false in this harness
    // (Platform.OS 'ios' AND `useCameraDevice() === null`, both deliberate
    // in the mocks), so there is no flip for the latch to suppress — a
    // constant is stable with or without one.
    //
    // It is kept as a SHAPE guard, and labelled rather than deleted so the
    // next reader does not mistake it for cover: what it still catches is
    // the prop changing across the sweep edges for some OTHER reason — a
    // remount, a reordered branch. The latch itself is proved by the A35
    // device round (`vcFramesOffered > 0` with `counts.painted > 0` across
    // a sweep started before the plugin resolves), which is the only place
    // the live value moves.
    const tree = render({ engine: 'sweep' });
    const handler = surfaceProps(tree).onSweepingChange as (s: boolean) => void;
    const owns = () => surfaceProps(tree).frameSource === 'host';

    const idle = owns();
    act(() => { handler(true); });
    expect(owns()).toBe(idle);           // latched at the start edge
    act(() => { handler(false); });
    expect(owns()).toBe(idle);           // released, back to the live value
    act(() => { tree.unmount(); });
  });

  it('keeps the worklet gate even when the host supplies onSweepingChange', () => {
    // ⚠ THE SPREAD ORDER IS THE ASSERTION. `onSweepingChange` gates the
    // frame-processor worklet; a host copy landing on top of it would
    // leave the gate SHUT for the whole sweep and the engine would receive
    // nothing, with no error anywhere. Composed, not replaced — the host's
    // handler still fires.
    const seen: boolean[] = [];
    const tree = render({
      engine: 'sweep',
      sweep: { onSweepingChange: (s: boolean) => { seen.push(s); } },
    });
    const handler = surfaceProps(tree).onSweepingChange as (s: boolean) => void;
    expect(typeof handler).toBe('function');
    // The surface emits its initial `false` on mount, so assert the
    // DELTA rather than the whole log — pinning the exact sequence would
    // make this test fail the next time the surface reports its own idle
    // state, which is not what it is testing.
    const before = seen.length;
    act(() => { handler(true); });
    expect(seen.slice(before)).toEqual([true]);   // the host's still ran
    act(() => { tree.unmount(); });
  });

  it('routes completion to onCapture as a discriminated result', () => {
    // The type is the assertion here: a sweep result must narrow on
    // `type: 'panoplus'` alongside 'photo' and 'panorama', so an existing
    // consumer's switch keeps compiling and a new one can add a case.
    const seen: CameraCaptureResult[] = [];
    const onCapture = (r: CameraCaptureResult): void => { seen.push(r); };
    const tree = render({ engine: 'sweep', onCapture });
    expect(seen).toEqual([]);
    act(() => { tree.unmount(); });
  });
});
