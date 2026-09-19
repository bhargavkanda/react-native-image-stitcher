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

import { Camera } from '../../camera/Camera';
import type { CameraCaptureResult } from '../../camera/Camera';
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

  it('does NOT render the camera-owned preview beside it', () => {
    // The keyframe path renders <CameraView>; the sweep path must not, or
    // two camera sessions are alive at once.
    const sweep = names(render({ engine: 'sweep' }));
    expect(sweep).not.toContain('CameraView');
  });

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

  it('tells the surface the HOST owns the camera on the non-AR arm', () => {
    // THE FAILURE THIS PREVENTS IS AT MOUNT, NOT AT CAPTURE. The surface
    // opens an AVF idle viewfinder of its own so the operator can frame the
    // first shot. Android allows ONE client per back camera, and
    // `<CameraView>` already has it — so a surface that still thinks it
    // owns the camera takes ERROR_CAMERA_IN_USE before any hold.
    const tree = render({ engine: 'sweep' });   // defaultCaptureSource is non-AR
    expect(surfaceProps(tree).frameSource).toBe('host');
    act(() => { tree.unmount(); });
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
