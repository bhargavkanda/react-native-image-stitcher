// SPDX-License-Identifier: Apache-2.0
/**
 * `PanoPlusCaptureSurface` with `frameSource="host"` — the arm S7 exists for,
 * mounted DIRECTLY.
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
import { NativeModules, Platform } from 'react-native';

import { PanoPlusCaptureSurface } from '../PanoPlusCaptureSurface';

const NM = NativeModules as Record<string, unknown>;

let startedWith: Record<string, unknown> | null = null;

function installNative(): void {
  startedWith = null;
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

/** The surface's imperative handle — `holdStart` is what a shutter press
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
      <PanoPlusCaptureSurface ref={handle as never} {...(props as any)} />,
    );
  });
  return { tree, handle };
}

/** True when the surface fell back to the "pano+ is not available" card —
 *  the state that silently invalidated the previous version of this test. */
function isUnavailableCard(tree: ReactTestRenderer): boolean {
  return tree.root.findAll(
    (n) => n.props?.testID === 'panoplus-unavailable', { deep: true },
  ).length > 0;
}

/**
 * The resolved `backgroundColor` of the surface's outermost View.
 *
 * ⚠ THE UNAVAILABLE-CARD CHECK IS INSIDE THIS HELPER, not in a separate
 * precondition case. That card's style is `{flex: 1, backgroundColor:
 * '#000'}` — byte-identical in the property read here to `styles.fill` — so
 * a probe that lands on it silently reports the own-arm answer whatever the
 * surface actually did. A precondition case guarding only ONE of the two
 * mounts is how this file's predecessor passed on the pre-fix code.
 */
function rootBackground(tree: ReactTestRenderer): unknown {
  if (isUnavailableCard(tree)) {
    throw new Error(
      'the surface fell back to the "pano+ is not available" card, so this '
      + 'probe is reading that card\'s #000 and not the sweep root',
    );
  }
  const root = tree.root.findAll(
    (n) => (n.type as unknown) === 'View', { deep: true },
  )[0];
  const flat = ([] as unknown[])
    .concat(root.props.style as unknown[])
    .filter(Boolean) as Array<Record<string, unknown>>;
  return flat.reduce<unknown>(
    (acc, s) => (s.backgroundColor !== undefined ? s.backgroundColor : acc),
    undefined,
  );
}

describe('the surface root does not paint over the host preview', () => {
  it('⚑ PRECONDITION: the arrangement gets past the unavailable card', () => {
    // Without this the two cases below assert the style of a completely
    // different View and pass on the pre-fix code — measured, that is exactly
    // what the previous version of this test did.
    const { tree } = mount({ frameSource: 'host' });
    expect(isUnavailableCard(tree)).toBe(false);
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
    act(() => { tree.unmount(); });
  });
});
