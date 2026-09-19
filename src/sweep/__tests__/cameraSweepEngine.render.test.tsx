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
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Camera, _sweepHostOwnsCameraForTests as hostOwns } from '../../camera/Camera';
import type { CameraCaptureResult } from '../../camera/Camera';
import { CameraView } from '../../camera/CameraView';
import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';
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
afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

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
   * sweep must NOT mount a second session there. The render mock pins
   * `Platform.OS === 'ios'`, which makes that the case this suite can check;
   * the Android rows live in `sweepHostOwnsCamera.test.ts`, where the
   * platform is an argument rather than a global.
   */
  it('⚑ renders NO second camera on the sweep path', () => {
    const tree = render({ engine: 'sweep' });
    expect(tree.root.findAllByType(CameraView)).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  it('⚑ …AND THAT CASE IS VACUOUS IN THIS HARNESS. Here is the proof.', () => {
    // Read this before trusting the line above.
    //
    // `toHaveLength(0)` is the shape that passes when the probe is broken,
    // so it needs a positive control — and there ISN'T one here.
    //
    // ⚠ AND THE REASON IS NOT THE ONE THIS COMMENT FIRST GAVE. It said the
    // mount is gated on the device being non-null. It is not: the mount is
    // gated on `hostOwnsSweepCamera`, and a null device only changes what
    // `<CameraView>` renders internally. The device matters because it is
    // one of that predicate's TERMS (`jest.mocks/vision-camera.render.js`
    // pins `useCameraDevice: () => null` deliberately — "a mock that
    // invented a device would make every no-device path untested"), and so
    // is `Platform.OS`, pinned to 'ios'. Two independent terms are false in
    // every render this suite can build.
    //
    // Two consequences, and the second is the point:
    //
    //  1. The case above passes for a reason that has nothing to do with
    //     the sweep. Left unlabelled it would join this repo's long list of
    //     assertions that were green before the code they "protect"
    //     existed — the exact family the header of this file already warns
    //     about twice.
    //  2. The real question — WHICH platform and WHICH state may mount a
    //     second camera — cannot be asked here at all, because the render
    //     mock also pins `Platform.OS = 'ios'`. It is asked instead in
    //     `src/camera/__tests__/sweepHostOwnsCamera.test.ts`, where the
    //     platform is an argument and every term has a red-first mutation
    //     row.
    // The mock's own answer, asserted rather than described:
    expect((require('react-native-vision-camera') as {
      useCameraDevice: () => unknown;
    }).useCameraDevice()).toBeNull();
    // And the positive control cannot even be BUILT here: rendering the
    // keyframe path throws before it reaches a camera, because
    // `PanoramaSettingsModal` needs host components this project's
    // react-native mock does not carry.
    //
    // What the case DOES still catch, and the reason it is kept rather than
    // deleted: a predicate that becomes PERMISSIVE. Restoring the bare
    // `!isAR` reddens it, because `isAR` is false on this default render.
    expect(() => render({})).toThrow(/Element type is invalid/);
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

  /** The props `<Camera>` actually handed `PanoPlusCaptureSurface`. */
  function surfaceProps(tree: ReactTestRenderer): Record<string, unknown> {
    return tree.root.findByType(PanoPlusCaptureSurface).props as Record<
      string,
      unknown
    >;
  }

  it('asks for the arm the HOST chose, not a second hidden opinion', () => {
    // ⚠ THE CONTROLS BELONG TO `<Camera>`. The sweep surface draws its own
    // AR pill, but the value behind it is `arPreference` — the same state
    // the keyframe path's AR toggle writes. A separate default here would
    // let an operator toggle AR on and watch the sweep ignore it.
    const off = render({ engine: 'sweep' });
    expect(surfaceProps(off).poseSource).toBe('imu');   // defaultCaptureSource is non-AR
    act(() => { off.unmount(); });

    const on = render({ engine: 'sweep', defaultCaptureSource: 'ar' });
    expect(surfaceProps(on).poseSource).toBe('ar');
    act(() => { on.unmount(); });
  });

  it('gives the sweep somewhere to write BOTH pills', () => {
    // THE REGRESSION AN OPERATOR REPORTED: "I do not see AR pill and lens
    // pill". The surface gates each control on being handed a writer —
    // `onPoseSourceChange != null` and `onLensChange != null` are the
    // literal conditions — so a host that passes neither gets NO pills, and
    // the UI silently loses two controls the other engine has.
    const tree = render({ engine: 'sweep' });
    const props = surfaceProps(tree);
    expect(typeof props.onPoseSourceChange).toBe('function');
    expect(typeof props.onLensChange).toBe('function');
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

  it('lets the host override a default rather than being overridden by it', () => {
    const tree = render({ engine: 'sweep', sweep: { poseSource: 'ar' } });
    expect(surfaceProps(tree).poseSource).toBe('ar');
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

  it('⚑ keeps the surface OWNING the camera when the host cannot serve it', () => {
    // ⚠ THIS CASE ASSERTED `'host'` WHEN S7 SHIPPED, AND THAT WAS THE BUG.
    //
    // `frameSource` is not "is this the non-AR arm?" — it is "will the
    // native recorder open NOTHING?", and on the non-AR arm those are
    // different questions. Two independent reasons make the answer `'own'`
    // in this harness, and each one is a real device state:
    //
    //   * `Platform.OS === 'ios'` (pinned by the render mock). Nothing under
    //     `ios/` reads `vcPluginArm`; `poseSource: 'imu'` starts
    //     `RNISPanoAvfSource`, which opens its OWN AVCaptureSession. Saying
    //     `'host'` there mounts `<CameraView>` beside that session, and
    //     because `canAddInput` tests configuration compatibility rather
    //     than runtime exclusivity the second open usually SUCCEEDS — no
    //     error, just one of the two interrupted moments later.
    //   * `useCameraDevice()` returns null (also pinned, also deliberate),
    //     so there is no device id for the recorder to read intrinsics from.
    //
    // The failure the original comment described is real and still guarded —
    // a surface that opens its AVF idle viewfinder while `<CameraView>` holds
    // the back camera takes ERROR_CAMERA_IN_USE at MOUNT, before any hold.
    // It is guarded by the predicate, whose rows are in
    // `sweepHostOwnsCamera.test.ts`; what this case pins is that the fallback
    // direction is the SAFE one. Both arms owning nothing is a black screen;
    // both arms owning their own camera is merely the pre-S7 behaviour.
    const tree = render({ engine: 'sweep' });   // defaultCaptureSource is non-AR
    expect(surfaceProps(tree).frameSource).toBe('own');
    expect(surfaceProps(tree).vcPluginArm).toBe(false);
    act(() => { tree.unmount(); });
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
      frameSource: 'host',
      vcPluginArm: true,
      vcCameraId: 'HOST-SUPPLIED-99',
    } as unknown as Record<string, unknown>;
    const p = surfaceProps(render({ engine: 'sweep', sweep: hostile }));
    expect(p.frameSource).toBe('own');        // <Camera>'s answer, not the bag's
    expect(p.vcPluginArm).toBe(false);
    expect(p.vcCameraId).toBe('');
  });

  it('⚑ a bag-supplied poseSource reaches the OWNERSHIP predicate, not just the surface', () => {
    // The other half. `poseSource` IS legitimately host-settable — it is the
    // operator's arm — but the surface forwards `vcPluginArm` only on the IMU
    // arm, so a bag that sets `'ar'` while the predicate reads `<Camera>`'s
    // own `arPreference` produces the collision one layer down: host owns the
    // camera, arm flag dropped on the way out, recorder opens its own.
    // `<Camera>` therefore MERGES first and derives ownership from the merged
    // value, so these two can never disagree.
    const p = surfaceProps(render({
      engine: 'sweep', sweep: { poseSource: 'ar' as const },
    }));
    expect(p.poseSource).toBe('ar');          // the host's choice is honoured
    expect(p.frameSource).toBe('own');        // …and ownership followed it
    expect(p.vcPluginArm).toBe(false);
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
      // The predicate's answer for the state this harness pins: iOS, no
      // device, no plugin — three independent falses.
      const owns = hostOwns({
        isAR: false,
        sweepPoseSource: 'imu',
        platformOS: 'ios',
        cameraUnmounting: false,
        pluginReady: false,
        deviceId: '',
        captureMode: 'wide-only',
        lens: '1x',
      });
      expect(owns).toBe(false);
      expect(p.frameSource).toBe(owns ? 'host' : 'own');
      expect(p.vcPluginArm).toBe(owns);
      expect(p.vcCameraId).toBe('');
      act(() => { tree.unmount(); });
    }
  });

  it('leaves the AR arm owning its own camera', async () => {
    // The AR arm is the opposite: the surface mounts the ONE
    // <ARCameraView>, and <Camera> must not mount a second — two
    // RNSARSession.shared.start() calls against one camera, no compile
    // error, black preview on a phone.
    // ⚠ THE AR PROBE IS ASYNCHRONOUS, so `isAR` is false for the first
    // render however the host configured it — `RNSARSession.isSupported()`
    // returns a Promise and `arSupportPending` is true until it settles.
    // A synchronous assertion here would read the PENDING state and pass
    // for the wrong reason on the non-AR arm.
    const tree = render({ engine: 'sweep', defaultCaptureSource: 'ar' });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(surfaceProps(tree).frameSource).toBe('own');
    act(() => { tree.unmount(); });
  });

  it('does not put the keyframe engine\'s chrome under a sweep', () => {
    // Falling through to the main tree would bring the settings modal, the
    // thumbnail strip and the band overlay with it — keyframe furniture
    // over a sweep, which is the "why does the UI change?" complaint in
    // the other direction.
    const names = namesOf(render({ engine: 'sweep' }));
    expect(names).not.toContain('CaptureThumbnailStrip');
    expect(names).not.toContain('PanoramaSettingsModal');
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
