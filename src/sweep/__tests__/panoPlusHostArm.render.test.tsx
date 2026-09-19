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

/** The resolved `backgroundColor` of the surface's outermost View. */
function rootBackground(tree: ReactTestRenderer): unknown {
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

/** True when the surface fell back to the "pano+ is not available" card —
 *  the state that silently invalidated the previous version of this test. */
function isUnavailableCard(tree: ReactTestRenderer): boolean {
  return tree.root.findAll(
    (n) => n.props?.testID === 'panoplus-unavailable', { deep: true },
  ).length > 0;
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
