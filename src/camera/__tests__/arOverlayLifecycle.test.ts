// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the ARCameraView declarative-overlay lifecycle decisions
 * (arOverlayLifecycle.ts) — the process-wide native overlay collection must
 * be cleared by the instance that drove it, and only that instance, so stale
 * shapes never leak across mounts or into a mid-life prop-drop.
 */

import type { AROverlay } from '../../stitching/AROverlay';
import {
  resolveOverlayPush,
  resolveOverlayUnmount,
} from '../arOverlayLifecycle';

const quad = (id: string): AROverlay =>
  ({
    id,
    kind: 'quad',
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  }) as unknown as AROverlay;

describe('resolveOverlayPush', () => {
  it('pushes a present array wholesale and takes ownership', () => {
    const overlays = [quad('a'), quad('b')];
    const d = resolveOverlayPush(overlays, false);
    expect(d.dispatch).toEqual(overlays);
    expect(d.hasDriven).toBe(true);
  });

  it('copies the array (no shared reference with the prop)', () => {
    const overlays = [quad('a')];
    const d = resolveOverlayPush(overlays, false);
    expect(d.dispatch).not.toBe(overlays);
    expect(d.dispatch).toEqual(overlays);
  });

  it('an empty array is still a declarative drive (dispatches [], owns)', () => {
    const d = resolveOverlayPush([], false);
    expect(d.dispatch).toEqual([]);
    expect(d.hasDriven).toBe(true);
  });

  it('undefined + never-drove → no dispatch, no ownership (imperative-only host)', () => {
    for (const v of [undefined, null] as const) {
      const d = resolveOverlayPush(v, false);
      expect(d.dispatch).toBeNull();
      expect(d.hasDriven).toBe(false);
    }
  });

  it('array → undefined AFTER driving → clears once and releases ownership', () => {
    // First render drove declaratively...
    expect(resolveOverlayPush([quad('a')], false).hasDriven).toBe(true);
    // ...then the host drops the prop on the SAME live mount.
    const d = resolveOverlayPush(undefined, true);
    expect(d.dispatch).toEqual([]); // one-shot clear
    expect(d.hasDriven).toBe(false); // ownership released
  });

  it('undefined stays a no-op once ownership was released (no repeat clears)', () => {
    // After the array→undefined clear above, hasDriven is false; a subsequent
    // undefined render must NOT dispatch again.
    const d = resolveOverlayPush(undefined, false);
    expect(d.dispatch).toBeNull();
    expect(d.hasDriven).toBe(false);
  });
});

describe('resolveOverlayUnmount', () => {
  it('clears the singleton on unmount when this instance drove it', () => {
    expect(resolveOverlayUnmount(true)).toEqual([]);
  });

  it('leaves the singleton untouched when this instance never drove it', () => {
    expect(resolveOverlayUnmount(false)).toBeNull();
  });
});

describe('lifecycle sequences (the bug scenarios)', () => {
  it('mount → drive → unmount clears (cross-mount leak fix)', () => {
    let hasDriven = false;
    const push = resolveOverlayPush([quad('dt')], hasDriven);
    hasDriven = push.hasDriven;
    expect(push.dispatch).toEqual([quad('dt')]);
    // ...component unmounts (strict swap into another AR view)
    expect(resolveOverlayUnmount(hasDriven)).toEqual([]);
  });

  it('imperative-only mount → unmount does NOT clobber the singleton', () => {
    let hasDriven = false;
    const push = resolveOverlayPush(undefined, hasDriven); // prop never set
    hasDriven = push.hasDriven;
    expect(push.dispatch).toBeNull();
    expect(resolveOverlayUnmount(hasDriven)).toBeNull();
  });

  it('drive → drop prop mid-life → later unmount does NOT double-clear', () => {
    let hasDriven = resolveOverlayPush([quad('a')], false).hasDriven; // drove
    const drop = resolveOverlayPush(undefined, hasDriven);
    hasDriven = drop.hasDriven;
    expect(drop.dispatch).toEqual([]); // cleared mid-life
    expect(hasDriven).toBe(false);
    // Unmount now finds no ownership → no redundant clear.
    expect(resolveOverlayUnmount(hasDriven)).toBeNull();
  });
});
