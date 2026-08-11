// SPDX-License-Identifier: Apache-2.0
/**
 * AR overlay contract EXTENSION — type + dispatch tests for the fields added
 * on top of the v0.20.0 overlay model:
 *
 *   fillAlpha?: number;        // 0..1 box-fill opacity; absent = native ~22%
 *   strokeAlpha?: number;      // 0..1 outline opacity; absent = opaque; 0 = fill-only
 *   imageUri?: string;         // image badge drawn inside a 'box'
 *   orient?: 'plane'|'camera'; // 'camera' = gravity-upright billboard box (iOS)
 *
 * Two properties are pinned:
 *
 *   1. The TS contract compiles the new fields (and rejects wrong types) —
 *      the same runtime-assertion + `@ts-expect-error` style as
 *      `AROverlay.types.test.ts`.
 *   2. The controller forwards the new fields to native UNTOUCHED and, just
 *      as importantly, does NOT materialise them when the caller omits them
 *      — the native defaults (22% fill, opaque stroke, plane orientation)
 *      only apply to ABSENT keys, so a JS layer that invented values would
 *      silently change rendering for every pre-existing consumer.
 */

import type { AROverlay } from '../AROverlay';
import { createAROverlayController } from '../../camera/arOverlayController';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NativeModules } = require('react-native') as {
  NativeModules: Record<string, unknown>;
};

const setOverlaysSpy = jest.fn();

beforeEach(() => {
  setOverlaysSpy.mockClear();
  (NativeModules as Record<string, unknown>).RNSARSession = {
    setOverlays: (...args: unknown[]) => setOverlaysSpy(...args),
  };
});

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).RNSARSession;
});

describe('AROverlay contract extension — types', () => {
  it('models a fill-only tiled quad (strokeAlpha 0)', () => {
    const tile: AROverlay = {
      id: 'tile-3',
      worldQuad: [
        [0, 0, 0],
        [0.1, 0, 0],
        [0.1, 0.1, 0],
        [0, 0.1, 0],
      ],
      shape: 'box',
      fillAlpha: 0.5,
      strokeAlpha: 0,
    };
    expect(tile.fillAlpha).toBe(0.5);
    expect(tile.strokeAlpha).toBe(0);
  });

  it('models a camera-oriented box with an image badge', () => {
    const box: AROverlay = {
      id: 'det-1',
      worldQuad: [
        [0, 0, 0],
        [0.2, 0, 0],
        [0.2, 0.3, 0],
        [0, 0.3, 0],
      ],
      shape: 'box',
      orient: 'camera',
      imageUri: 'file:///tmp/badge.png',
      label: 'fallback label',
    };
    expect(box.orient).toBe('camera');
    expect(box.imageUri).toBe('file:///tmp/badge.png');
  });

  it('keeps every new field optional (back-compat: the minimal overlay still compiles)', () => {
    const minimal: AROverlay = { id: 'm1' };
    expect(minimal.fillAlpha).toBeUndefined();
    expect(minimal.strokeAlpha).toBeUndefined();
    expect(minimal.imageUri).toBeUndefined();
    expect(minimal.orient).toBeUndefined();
  });

  it('rejects wrong types on the new fields', () => {
    const bad1: AROverlay = {
      id: 'x',
      // @ts-expect-error — fillAlpha is a number, not a string.
      fillAlpha: '0.5',
    };
    const bad2: AROverlay = {
      id: 'y',
      // @ts-expect-error — orient is a closed union.
      orient: 'billboard',
    };
    const bad3: AROverlay = {
      id: 'z',
      // @ts-expect-error — imageUri is a string path, not a require() number.
      imageUri: 42,
    };
    expect([bad1.id, bad2.id, bad3.id]).toEqual(['x', 'y', 'z']);
  });
});

describe('AROverlay contract extension — controller dispatch', () => {
  it('forwards the new fields to native untouched', () => {
    const c = createAROverlayController();
    const overlay: AROverlay = {
      id: 'a',
      worldQuad: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      shape: 'box',
      fillAlpha: 0.35,
      strokeAlpha: 0.8,
      imageUri: 'file:///tmp/badge.png',
      orient: 'camera',
    };
    c.setOverlays([overlay]);
    expect(setOverlaysSpy).toHaveBeenCalledTimes(1);
    const sent = setOverlaysSpy.mock.calls[0][0] as AROverlay[];
    expect(sent).toHaveLength(1);
    expect(sent[0].fillAlpha).toBe(0.35);
    expect(sent[0].strokeAlpha).toBe(0.8);
    expect(sent[0].imageUri).toBe('file:///tmp/badge.png');
    expect(sent[0].orient).toBe('camera');
  });

  it('does NOT materialise absent fields (absent = native default is the contract)', () => {
    const c = createAROverlayController();
    c.setOverlays([{ id: 'plain', worldPosition: [0, 0, 0], shape: 'box' }]);
    const sent = setOverlaysSpy.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect('fillAlpha' in sent[0]).toBe(false);
    expect('strokeAlpha' in sent[0]).toBe(false);
    expect('imageUri' in sent[0]).toBe(false);
    expect('orient' in sent[0]).toBe(false);
  });
});
