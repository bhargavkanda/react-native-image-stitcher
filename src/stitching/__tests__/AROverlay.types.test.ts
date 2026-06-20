// SPDX-License-Identifier: Apache-2.0
/**
 * v0.20.0 — type-contract + controller-behaviour tests for the AR OVERLAY /
 * ANNOTATION renderer.
 *
 * Two surfaces are pinned here:
 *
 *   1. The public **TS contract** consumers compile against — the
 *      {@link AROverlay} shape and the {@link AROverlayMethods} the `<Camera>`
 *      / `<ARCameraView>` ref handles expose.  Modelled the same two ways as
 *      `CameraFrame.types.test.ts` / `ARPlugin.types.test.ts`: runtime
 *      assertions over realistic mock values, plus `@ts-expect-error` negative
 *      checks validated by `npm run typecheck`.
 *   2. The **controller behaviour** — `createAROverlayController` has real JS
 *      logic (merge-by-id, insertion order, shallow update, native dispatch),
 *      so unlike the pure-types tests it gets concrete behavioural coverage
 *      against a mocked `RNSARSession.setOverlays`.
 */

import type { AROverlay } from '../AROverlay';
// Type-only imports — erased at runtime, so importing the components' prop /
// handle types never pulls react-native into the pure-TS jest env.  Their
// presence still makes `tsc` check the `overlays` prop + handle typing.
import type { ARCameraViewProps, ARCameraViewHandle } from '../../camera/ARCameraView';
import type { CameraProps, CameraHandle } from '../../camera/Camera';
import type { AROverlayMethods } from '../../camera/arOverlayController';
import {
  createAROverlayController,
  AR_OVERLAY_SET_METHOD,
  AR_OVERLAY_VIEW_COMMAND,
} from '../../camera/arOverlayController';
// The shared jest react-native mock (jest.config's moduleNameMapper) exposes an
// empty `NativeModules`; `createAROverlayController` reads
// `NativeModules.RNSARSession` lazily at dispatch time, so we inject a spy onto
// that object for the controller tests and remove it afterward (so the empty-
// NativeModules contract other tests rely on is restored).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NativeModules } = require('react-native') as {
  NativeModules: Record<string, unknown>;
};

const setOverlaysSpy = jest.fn();
const raycastSpy = jest.fn();

beforeEach(() => {
  setOverlaysSpy.mockClear();
  raycastSpy.mockReset();
  (NativeModules as Record<string, unknown>).RNSARSession = {
    setOverlays: (...args: unknown[]) => setOverlaysSpy(...args),
    raycast: (...args: unknown[]) => raycastSpy(...args),
  };
});

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).RNSARSession;
});

describe('AROverlay v0.20.0 type contract', () => {
  it('models a single-world-point billboard overlay', () => {
    const marker: AROverlay = {
      id: 'demo',
      worldPosition: [0.1, 0.2, -0.5],
      sizeMeters: [0.2, 0.2],
      shape: 'outline',
      label: 'AR',
      color: '#00E5FF',
      mode: '2d',
    };
    expect(marker.worldPosition).toEqual([0.1, 0.2, -0.5]);
    expect(marker.sizeMeters).toEqual([0.2, 0.2]);
    expect(marker.shape).toBe('outline');
  });

  it('models an explicit-world-quad outline overlay', () => {
    const quad: AROverlay = {
      id: 'shelf-face',
      worldQuad: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      shape: 'box',
      color: '#FFD34D',
    };
    expect(quad.worldQuad).toHaveLength(4);
    // worldPosition is optional — quads anchor on their corners.
    expect(quad.worldPosition).toBeUndefined();
  });

  it('allows the minimal overlay (id only)', () => {
    const minimal: AROverlay = { id: 'm1' };
    expect(minimal.id).toBe('m1');
  });
});

describe('createAROverlayController behaviour', () => {
  it('dispatches the full set to native on setOverlays', () => {
    const c = createAROverlayController();
    const a: AROverlay = { id: 'a', worldPosition: [0, 0, 0] };
    const b: AROverlay = { id: 'b', worldPosition: [1, 1, 1] };
    c.setOverlays([a, b]);
    expect(setOverlaysSpy).toHaveBeenCalledTimes(1);
    expect(setOverlaysSpy).toHaveBeenLastCalledWith([a, b]);
    expect(c.getOverlays()).toEqual([a, b]);
  });

  it('addOverlay appends, replacing same id in place (insertion order kept)', () => {
    const c = createAROverlayController();
    c.setOverlays([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
    setOverlaysSpy.mockClear();
    // Replace 'a' in place — order stays [a, b], not [b, a].
    c.addOverlay({ id: 'a', label: 'A2' });
    expect(c.getOverlays()).toEqual([
      { id: 'a', label: 'A2' },
      { id: 'b', label: 'B' },
    ]);
    // Append a brand-new overlay.
    c.addOverlay({ id: 'c', label: 'C' });
    expect(c.getOverlays().map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(setOverlaysSpy).toHaveBeenCalledTimes(2);
  });

  it('updateOverlay shallow-merges and preserves id; no-op for unknown id', () => {
    const c = createAROverlayController();
    c.setOverlays([{ id: 'a', label: 'A', color: '#fff' }]);
    setOverlaysSpy.mockClear();
    c.updateOverlay('a', { color: '#000', label: 'A-renamed' });
    expect(c.getOverlays()).toEqual([
      { id: 'a', label: 'A-renamed', color: '#000' },
    ]);
    expect(setOverlaysSpy).toHaveBeenCalledTimes(1);
    // The id can't be hijacked by the patch — the map key must stay stable.
    c.updateOverlay('a', { id: 'hijack' } as Partial<AROverlay>);
    expect(c.getOverlays()[0].id).toBe('a');
    // Unknown id: no mutation, no dispatch.
    setOverlaysSpy.mockClear();
    c.updateOverlay('missing', { label: 'x' });
    expect(setOverlaysSpy).not.toHaveBeenCalled();
  });

  it('removeOverlay deletes by id and only dispatches when something changed', () => {
    const c = createAROverlayController();
    c.setOverlays([{ id: 'a' }, { id: 'b' }]);
    setOverlaysSpy.mockClear();
    c.removeOverlay('a');
    expect(c.getOverlays().map((o) => o.id)).toEqual(['b']);
    expect(setOverlaysSpy).toHaveBeenCalledTimes(1);
    // Removing an absent id is a no-op (no redundant native dispatch).
    c.removeOverlay('a');
    expect(setOverlaysSpy).toHaveBeenCalledTimes(1);
  });

  it('clearOverlays empties the set (and skips dispatch when already empty)', () => {
    const c = createAROverlayController();
    c.setOverlays([{ id: 'a' }]);
    setOverlaysSpy.mockClear();
    c.clearOverlays();
    expect(c.getOverlays()).toEqual([]);
    expect(setOverlaysSpy).toHaveBeenLastCalledWith([]);
    expect(setOverlaysSpy).toHaveBeenCalledTimes(1);
    // Already empty → no redundant dispatch.
    c.clearOverlays();
    expect(setOverlaysSpy).toHaveBeenCalledTimes(1);
  });

  it('last-writer-wins on duplicate ids within a single setOverlays call', () => {
    const c = createAROverlayController();
    c.setOverlays([
      { id: 'dup', label: 'first' },
      { id: 'dup', label: 'second' },
    ]);
    expect(c.getOverlays()).toEqual([{ id: 'dup', label: 'second' }]);
  });

  it('exposes the agreed native channel names', () => {
    expect(AR_OVERLAY_SET_METHOD).toBe('setOverlays');
    expect(AR_OVERLAY_VIEW_COMMAND).toBe('RNSARCameraViewOverlays');
  });
});

describe('createAROverlayController.raycast', () => {
  it('resolves the [x,y,z] tuple when native returns a hit', async () => {
    raycastSpy.mockResolvedValue({ worldPosition: [1, 2, 3] });
    const c = createAROverlayController();
    await expect(c.raycast()).resolves.toEqual([1, 2, 3]);
    expect(raycastSpy).toHaveBeenCalledTimes(1);
  });

  it('coerces numeric strings/values to numbers', async () => {
    // The native bridge may marshal as NSNumber → JS number, but guard anyway.
    raycastSpy.mockResolvedValue({ worldPosition: ['1.5', 2, 3] as unknown[] });
    const c = createAROverlayController();
    await expect(c.raycast()).resolves.toEqual([1.5, 2, 3]);
  });

  it('resolves null when native reports no hit', async () => {
    raycastSpy.mockResolvedValue(null);
    const c = createAROverlayController();
    await expect(c.raycast()).resolves.toBeNull();
  });

  it('resolves null on a malformed/short worldPosition', async () => {
    raycastSpy.mockResolvedValue({ worldPosition: [1, 2] });
    const c = createAROverlayController();
    await expect(c.raycast()).resolves.toBeNull();
  });

  it('resolves null (never throws) when native rejects', async () => {
    raycastSpy.mockRejectedValue(new Error('session not running'));
    const c = createAROverlayController();
    await expect(c.raycast()).resolves.toBeNull();
  });

  it('resolves null when the native raycast method is absent', async () => {
    (NativeModules as Record<string, unknown>).RNSARSession = {
      setOverlays: setOverlaysSpy,
    };
    const c = createAROverlayController();
    await expect(c.raycast()).resolves.toBeNull();
  });
});

describe('public ref-handle + prop type wiring', () => {
  it('both component handles expose the same overlay methods', () => {
    // A value typed as the shared method set is assignable to either handle's
    // overlay subset — so `<Camera>` can forward to `<ARCameraView>` and a host
    // can use either with the same code.
    const methods: AROverlayMethods = {
      setOverlays: () => undefined,
      addOverlay: () => undefined,
      updateOverlay: () => undefined,
      removeOverlay: () => undefined,
      clearOverlays: () => undefined,
      raycast: () => Promise.resolve(null),
    };
    const cam: Pick<CameraHandle, keyof AROverlayMethods> = methods;
    const arView: Pick<ARCameraViewHandle, keyof AROverlayMethods> = methods;
    expect(typeof cam.setOverlays).toBe('function');
    expect(typeof arView.clearOverlays).toBe('function');
  });

  it('the overlays prop is the same shape on both components', () => {
    const overlays: AROverlay[] = [{ id: 'x', worldPosition: [0, 0, 0] }];
    const camProp: CameraProps['overlays'] = overlays;
    const arProp: ARCameraViewProps['overlays'] = camProp;
    expect(arProp).toHaveLength(1);
  });
});

// ── Compile-time negative assertions (validated by `npm run typecheck`) ──

// `worldPosition` is a fixed 3-tuple, not an arbitrary array.
// @ts-expect-error — a 2-element tuple is not assignable to [x, y, z].
const _badWorldPos: NonNullable<AROverlay['worldPosition']> = [1, 2];

// `sizeMeters` is a fixed 2-tuple.
// @ts-expect-error — a 3-element tuple is not assignable to [w, h].
const _badSize: NonNullable<AROverlay['sizeMeters']> = [1, 2, 3];

// `shape` is exactly 'box' | 'outline'.
// @ts-expect-error — 'circle' is not a valid overlay shape.
const _badShape: AROverlay['shape'] = 'circle';

// `mode` is exactly '2d' | '3d'.
// @ts-expect-error — '4d' is not a valid overlay mode.
const _badMode: AROverlay['mode'] = '4d';

// `id` is required.
// @ts-expect-error — an overlay must have an id.
const _noId: AROverlay = { worldPosition: [0, 0, 0] };

// The overlays prop is `AROverlay[]`, not a single overlay.
// @ts-expect-error — a bare overlay object is not an AROverlay[].
const _badProp: CameraProps['overlays'] = { id: 'x' };

// Reference the guards so "unused const" lint/TS doesn't strip them before the
// `@ts-expect-error` is evaluated.
void _badWorldPos;
void _badSize;
void _badShape;
void _badMode;
void _noId;
void _badProp;
