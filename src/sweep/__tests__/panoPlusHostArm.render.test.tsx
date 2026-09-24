// SPDX-License-Identifier: Apache-2.0
/**
 * The sweep engine with `frameSource="host"` — the arm S7 exists for, mounted
 * DIRECTLY.
 *
 * M10 — `PanoPlusCaptureSurface` (and its "pano+ is not available" card) is
 * deleted. The engine is mounted through `SweepEngineHarness`: the real
 * `useSweepEngine`, drawn by the view that is left of its screen
 * (`SweepHatchScreen`). The root under test is that view's root.
 *
 * ── WHY A SEPARATE FILE ─────────────────────────────────────────────────
 *
 * Two of S7's headline fixes had no coverage at all, and one had coverage
 * that was worse than none.
 *
 * The black-screen fix (the surface root must be transparent when something
 * else is drawing behind it) was "tested" through `<Camera engine="sweep">`.
 * An adversarial review measured that case and found it never reached the
 * root at all: with no native module registered, the surface takes its
 * `available === false` early return and renders the "pano+ is not available"
 * card — whose own style is also `{flex: 1, backgroundColor: '#000'}`. The
 * probe read THAT, matched `'#000'`, and passed on the pre-fix code.
 *
 * The fail-closed guard in `start()` had nothing whatsoever: no test in the
 * package passed `frameSource: 'host'` into the surface.
 *
 * Both need the same arrangement — Android, native installed, the surface
 * mounted directly — so they live here rather than being bolted onto a suite
 * about `<Camera>`'s delegation. Mounting the surface directly is also the
 * honest shape for these two: they are properties of the SURFACE's contract,
 * and a third-party host can reach them with no `<Camera>` in between.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, Platform, StyleSheet } from 'react-native';

import { SweepEngineHarness } from './sweepEngineHarness';
import type { PanoPlusFailure, SweepSurfaceState } from '../panoPlusTypes';

const NM = NativeModules as Record<string, unknown>;

let startedWith: Record<string, unknown> | null = null;
/** Every `onControlsState` report, and every `onFailure`, the engine made. */
let controls: SweepSurfaceState[] = [];
let failures: PanoPlusFailure[] = [];

function installNative(): void {
  startedWith = null;
  controls = [];
  failures = [];
  NM.RNISPanoPlus = {
    start: (o: Record<string, unknown>) => {
      startedWith = o;
      return Promise.resolve({
        sessionDir: '/data/user/0/x/files/panoplus/pp_1',
        startedAtMs: 1,
        pluginAvailable: true,
        poseSource: o.poseSource,
      });
    },
    stop: () => Promise.resolve({}),
    cancel: () => Promise.resolve({ cancelled: true }),
    getStatus: () => Promise.resolve({ running: false }),
    setIdlePreview: (on: boolean) => Promise.resolve({ on, reason: '' }),
    // The native documentDirectory constant the surface needs before it will
    // start at all (see `src/sweep/fileSystem.ts`).
    getConstants: () => ({ documentDirectory: '/data/user/0/x/files/' }),
    documentDirectory: '/data/user/0/x/files/',
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  (Platform as { OS: string }).OS = 'android';
  installNative();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  (Platform as { OS: string }).OS = 'ios';
  delete NM.RNISPanoPlus;
});

/** The engine's imperative handle — `holdStart` is what a shutter press
 *  calls, and it is the only route into `start()` from outside. */
interface Handle { holdStart: () => void; holdEnd: () => void }

function mount(
  props: Record<string, unknown>,
): { tree: ReactTestRenderer; handle: React.RefObject<Handle | null> } {
  const handle = React.createRef<Handle | null>() as
    React.RefObject<Handle | null>;
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <SweepEngineHarness
        ref={handle as never}
        onComplete={() => undefined}
        onControlsState={(c) => { controls.push(c); }}
        onFailure={(f) => { failures.push(f); }}
        {...(props as any)}
      />,
    );
  });
  return { tree, handle };
}

/**
 * The resolved `backgroundColor` of the sweep's outermost View.
 *
 * ⚠ IT MUST BE THE SWEEP ROOT — the View that measures itself (`onLayout`).
 * The first version of this probe read the "pano+ is not available" card,
 * whose style was byte-identical in this property to the root's, and passed
 * on the pre-fix code. The card is gone (M10), but "the first View is the
 * root" is still an assumption, so it is checked rather than trusted.
 */
function rootBackground(tree: ReactTestRenderer): unknown {
  const root = tree.root.findAll(
    (n) => (n.type as unknown) === 'View', { deep: true },
  )[0];
  if (typeof root?.props?.onLayout !== 'function') {
    throw new Error('the first View is not the sweep root (no onLayout)');
  }
  const flat = ([] as unknown[])
    .concat(root.props.style as unknown[])
    .filter(Boolean) as Array<Record<string, unknown>>;
  return flat.reduce<unknown>(
    (acc, s) => (s.backgroundColor !== undefined ? s.backgroundColor : acc),
    undefined,
  );
}

describe('the surface root does not paint over the host preview', () => {
  // M10 — the precondition used to be "the arrangement gets past the
  // unavailable card"; the card is deleted. Its fact survives as the engine's
  // availability, which reaches the host as `canCapture`: this rig must be a
  // LIVE sweep, or the cases below are about an engine that would refuse
  // every hold `panoplus-unavailable`.
  it('⚑ PRECONDITION: the arrangement is an AVAILABLE sweep', () => {
    const { tree } = mount({ frameSource: 'host' });
    expect(controls[controls.length - 1]).toMatchObject({ canCapture: true });
    act(() => { tree.unmount(); });
  });

  it('is TRANSPARENT on the host arm — something else is drawing behind it', () => {
    const { tree } = mount({ frameSource: 'host' });
    expect(rootBackground(tree)).toBe('transparent');
    act(() => { tree.unmount(); });
  });

  it('stays BLACK on its own arm — it is the only thing on screen', () => {
    const { tree } = mount({ frameSource: 'own' });
    expect(rootBackground(tree)).toBe('#000');
    act(() => { tree.unmount(); });
  });

  it('⚑ stays BLACK in the HANDOFF window — nothing is drawing behind us', () => {
    // The third state, and the one the first version of this fix missed:
    // `frameSource: 'host'` with no preview mounted. A transparent root
    // there is not a viewfinder, it is a window onto whatever the platform
    // leaves behind. Reverting the `hostPreviewLive` term in the root style
    // leaves every OTHER case in the package green — measured — so this row
    // is the only thing standing between that term and a silent deletion.
    const { tree } = mount({ frameSource: 'host', hostPreviewLive: false });
    expect(rootBackground(tree)).toBe('#000');
    act(() => { tree.unmount(); });
  });

  it('⚑ …and SAYS SO, rather than showing a black screen with no caption', () => {
    // The other half of the same state. The explainer is suppressed on the
    // host arm because there are normally pixels behind it; in the handoff
    // there are none, and silence there is the exact defect this rung is
    // named after.
    const { tree } = mount({ frameSource: 'host', hostPreviewLive: false });
    const caption = tree.root.findAll(
      (n) => n.props?.testID === 'panoplus-camera-off', { deep: true },
    );
    expect(caption).toHaveLength(1);
    expect(caption[0].props.children).toContain('Handing the camera over');
    act(() => { tree.unmount(); });
  });

  it('⚑ NEGATIVE CONTROL: with the preview live it says nothing at all', () => {
    const { tree } = mount({ frameSource: 'host', hostPreviewLive: true });
    expect(tree.root.findAll(
      (n) => n.props?.testID === 'panoplus-camera-off', { deep: true },
    )).toHaveLength(0);
    act(() => { tree.unmount(); });
  });
});

describe('start() fails closed rather than opening a camera the host holds', () => {
  it('⚑ refuses when the host owns the camera and the arm resolved to AR', () => {
    // The state with no correct action: this surface has no viewfinder and no
    // session, and the only thing that tells the recorder to open nothing is
    // `vcPluginArm` — which is sent only on the IMU arm, because the
    // recorder's gate is `vcPluginArm && livePoseSource == "imu"`. Starting
    // anyway opens a second client against a device vision-camera holds.
    const { tree, handle } = mount({ frameSource: 'host', poseSource: 'ar' });
    // ⚠ THROUGH THE REAL HANDLE. A first draft of this case reached for
    // `findByType(...).instance`, which is null on a function component, so
    // `start()` never ran and the case passed with the guard DELETED. The
    // shutter's own route is `holdStart`.
    expect(typeof handle.current?.holdStart).toBe('function');
    act(() => { handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    // Nothing reached native. That is the assertion — a refusal that still
    // called `start` would be a comment, not a guard.
    expect(startedWith).toBeNull();
    act(() => { tree.unmount(); });
  });

  it('⚑ refuses when told the host owns the camera but not given the arm', () => {
    // The SAME failure by a different route, and the reason the guard tests
    // "will the arm actually be sent" rather than one named cause. Here the
    // pose arm is fine; what is missing is `vcPluginArm`/`vcCameraId`, so
    // the start bag would carry no instruction to open nothing — and the
    // recorder would open its own client while this surface, told the host
    // owns the camera, draws no viewfinder at all.
    //
    // `<Camera>` produces exactly this pairing for 600 ms on every ownership
    // flip, by design: during the handoff neither side may hold a camera.
    const { tree, handle } = mount({ frameSource: 'host', poseSource: 'imu' });
    act(() => { handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    expect(startedWith).toBeNull();
    // M10 review — and BY NAME, on `onFailure`, like its sibling guards: it
    // used to set the on-screen line only, so `<Camera>`'s `onError` heard
    // nothing.
    expect(failures.map((f) => f.code)).toEqual(['panoplus-camera-not-ready']);
    act(() => { tree.unmount(); });
  });

  it('⚑ M10 review: the genuine wrong-arm refusal reaches onFailure by name too', () => {
    const { tree, handle } = mount({
      frameSource: 'host', poseSource: 'ar', vcPluginArm: true, vcCameraId: '2',
    });
    act(() => { handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    expect(startedWith).toBeNull();
    expect(failures.map((f) => f.code)).toEqual(['panoplus-refused-wrong-arm']);
    act(() => { tree.unmount(); });
  });

  it('⚑ the two refusals say DIFFERENT things, and neither misdirects', () => {
    // The guard's condition was widened to "will the arm actually be sent"
    // while its message selector still keyed on the single original cause —
    // so a HANDOFF refusal told the operator to turn off the AR they had
    // just turned on, for a state that clears itself in 600 ms. Every test
    // of the guard asserted only that native was not called, so the selector
    // itself was asserted by nothing.
    const textOf = (props: Record<string, unknown>): string => {
      const { tree, handle } = mount(props);
      act(() => { handle.current?.holdStart(); });
      act(() => { jest.advanceTimersByTime(1500); });
      const node = tree.root.findAll(
        (n) => typeof n.props?.children === 'string'
          && String(n.props.children).includes('cannot start'),
        { deep: true },
      )[0];
      const text = String(node?.props?.children ?? '');
      act(() => { tree.unmount(); });
      return text;
    };

    // ARMED but resolved to AR — the genuine "wrong arm", and the only case
    // in which turning AR off is something the operator can actually do.
    const wrongArm = textOf({
      frameSource: 'host', poseSource: 'ar', vcPluginArm: true, vcCameraId: '2',
    });
    expect(wrongArm).toContain('Turn AR off');

    // NOT armed — the handoff window. Transient, and there is nothing to do.
    const handoff = textOf({ frameSource: 'host', poseSource: 'imu' });
    expect(handoff).toContain('handed over');
    expect(handoff).not.toContain('Turn AR off');

    // And the AR copy must not be the answer to a handoff on the AR arm
    // either — which is the exact pairing that misdirected.
    const handoffOnAr = textOf({ frameSource: 'host', poseSource: 'ar' });
    expect(handoffOnAr).not.toContain('Turn AR off');
  });

  it('⚑ NEGATIVE CONTROL: a COMPLETE host arm DOES start, and carries the arm', () => {
    // Without this the two cases above pass for any reason a hold might not
    // start — a missing document directory, an unarmed surface, a handle
    // that does nothing. It has to be the GUARD that refused.
    const { tree, handle } = mount({
      frameSource: 'host',
      poseSource: 'imu',
      vcPluginArm: true,
      vcCameraId: '2',
    });
    act(() => { handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    expect(startedWith).not.toBeNull();
    const bag = startedWith as Record<string, unknown>;
    expect(bag.poseSource).toBe('imu');
    // …and the bag told native to open NOTHING, which is the whole point of
    // the arm. A start that reached native without these two keys is the
    // collision the guard exists to prevent, arriving through the front door.
    expect(bag.vcPluginArm).toBe(true);
    expect(bag.vcCameraId).toBe('2');
    // M3 review — the host arm never asks native for a camera of its own.
    expect('allowOwnCamera' in bag).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ M3 review: only a surface that OWNS its camera sends allowOwnCamera', () => {
    // The native backstop refuses a live sweep with no arm unless this is
    // set; dropping it refuses every standalone hold, and sending it
    // unconditionally switches the backstop off. Both used to pass CI.
    const { tree, handle } = mount({ frameSource: 'own', poseSource: 'imu' });
    act(() => { handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    expect(startedWith).not.toBeNull();
    const bag = startedWith as Record<string, unknown>;
    expect(bag.allowOwnCamera).toBe(true);
    expect('vcPluginArm' in bag).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('⚑ M3 review: a host key in engineOptions cannot claim ownership either way', () => {
    const { tree, handle } = mount({
      frameSource: 'host', poseSource: 'imu', vcPluginArm: true, vcCameraId: '2',
      engineOptions: { allowOwnCamera: true, vcCameraId: 'spoofed' },
    });
    act(() => { handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    const bag = startedWith as Record<string, unknown>;
    expect('allowOwnCamera' in bag).toBe(false);
    expect(bag.vcCameraId).toBe('2');
    act(() => { tree.unmount(); });
  });
});

/**
 * ── THE LIVE PREVIEW IS PLACED AGAINST THE SURFACE'S OWN BOX ────────────
 *
 * The growing-canvas capsule was laid out against `useWindowDimensions()`
 * while this surface lives INSIDE `<Camera>` — which hosts commonly wrap in
 * a `<SafeAreaView>`. The box is then shorter than the window, the capsule
 * is pushed down by the difference, and its lower half lands under the
 * surface's own shutter row. On screen, behind the chrome: the operator
 * reported it as "I do not see the preview with the expanding canvas".
 */
describe('the live preview is laid out against the surface, not the window', () => {
  /** Fire the root's onLayout with a box SHORTER than the window. */
  function layout(tree: ReactTestRenderer, width: number, height: number): void {
    const root = tree.root.findAll(
      (n) => (n.type as unknown) === 'View'
        && typeof n.props?.onLayout === 'function',
      { deep: true },
    )[0];
    act(() => {
      (root.props.onLayout as (e: unknown) => void)({
        nativeEvent: { layout: { x: 0, y: 0, width, height } },
      });
    });
  }

  it('⚑ the root reports its measured box', () => {
    // The seam itself: without an onLayout on the root there is nothing to
    // measure against and the surface can only use the window.
    const { tree } = mount({ frameSource: 'own' });
    const withLayout = tree.root.findAll(
      (n) => (n.type as unknown) === 'View'
        && typeof n.props?.onLayout === 'function',
      { deep: true },
    );
    expect(withLayout.length).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });

  it('⚑ measuring a shorter box does not throw and re-renders once', () => {
    // The mock window is 390x844; a SafeAreaView host gives ~781.
    const { tree } = mount({ frameSource: 'own' });
    expect(() => layout(tree, 390, 781)).not.toThrow();
    // Idempotent: the same box must not loop (the setter bails on equal).
    expect(() => layout(tree, 390, 781)).not.toThrow();
    act(() => { tree.unmount(); });
  });

  /**
   * ⚠ THE TWO CASES ABOVE ASSERT THE SEAM, NOT THE FIX.
   *
   * An adversarial round measured it: keep the `onLayout`, the `surfaceBox`
   * state and the `box` fallback exactly as shipped and revert only the
   * three CONSUMERS back to the window — `previewWindowCrossMult`'s
   * width/height, `panoPlusPreviewLayout`'s width/height and the effect
   * deps. That is a complete revert of the defect fix, and the suite stayed
   * green. The pair was wired to the prop's EXISTENCE and to nothing else,
   * which is a test for an attribute rather than for a behaviour.
   *
   * These assert the OUTCOME, on both consumers.
   */
  it('⚑ the measured box moves what is DRAWN — by exactly the delta', () => {
    // The real case from the field: a `<SafeAreaView>` host gives a box
    // shorter than the window by the safe-area total, and everything laid
    // out against the window is pushed down by that difference.
    const { tree } = mount({ frameSource: 'own' });
    const hud = (t: ReactTestRenderer): number => {
      const n = t.root.findAll(
        (x) => x.props?.testID === 'panoplus-hud-block', { deep: true },
      )[0];
      return (StyleSheet.flatten(n.props.style) as { height: number }).height;
    };
    const onWindow = hud(tree);        // mock window 390x844
    layout(tree, 390, 781);
    expect(onWindow - hud(tree)).toBe(63);   // 844 − 781, exactly
    act(() => { tree.unmount(); });
  });

  it('⚑ …and it reaches NATIVE — previewWindowCrossMult follows the box', () => {
    // ⚠ A SHORTER BOX THAN THE CASE ABOVE, DELIBERATELY. The knee is
    // `min(band, column)` over a usable area, and between 844 and 781 the
    // WIDTH is what binds — the multiple is 6.346 for both, so the field
    // geometry cannot witness this half. It moves once the box is short
    // enough for the height to bind (split screen, or a host with heavy
    // chrome), which is the regime this asserts.
    const { tree, handle } = mount({
      frameSource: 'host', poseSource: 'imu', vcPluginArm: true, vcCameraId: '2',
    });
    act(() => { handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    const onWindow = (startedWith as Record<string, unknown>)
      .previewWindowCrossMult as number;
    act(() => { tree.unmount(); });

    startedWith = null;
    const second = mount({
      frameSource: 'host', poseSource: 'imu', vcPluginArm: true, vcCameraId: '2',
    });
    layout(second.tree, 390, 560);
    act(() => { second.handle.current?.holdStart(); });
    act(() => { jest.advanceTimersByTime(1500); });
    const onBox = (startedWith as unknown as Record<string, unknown>)
      .previewWindowCrossMult as number;
    expect(typeof onBox).toBe('number');
    expect(onBox).toBeLessThan(onWindow);
    act(() => { second.tree.unmount(); });
  });

});
