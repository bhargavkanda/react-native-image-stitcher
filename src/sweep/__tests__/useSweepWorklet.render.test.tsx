// SPDX-License-Identifier: Apache-2.0
/**
 * `useSweepWorklet` — when the plugin handle resolves, and what it costs
 * when it never does.
 *
 * ── WHY THIS MATTERS BEYOND THE HOOK ────────────────────────────────────
 *
 * `isReady` is a TERM of `sweepHostOwnsCamera`. A render on which it reads
 * false when the plugin is in fact available is a render on which `<Camera>`
 * says the SURFACE owns the camera — and the next render says the host does.
 * That flap is two camera opens back to back against one device on Android.
 *
 * So "resolves on the first render it could have" is a camera-correctness
 * property, not a micro-optimisation, and it has two entry points: the first
 * mount, and the first render after `engine` switches INTO the sweep. The
 * second one is easy to miss, because a `useState` initializer covers only
 * the first.
 */
import React from 'react';
import { act, create } from 'react-test-renderer';
import { VisionCameraProxy } from 'react-native-vision-camera';

import { useSweepWorklet } from '../useSweepWorklet';

const proxy = VisionCameraProxy as unknown as {
  initFrameProcessorPlugin: (n: string, o: unknown) => unknown;
};
const realInit = proxy.initFrameProcessorPlugin;

let acquireCalls = 0;
let pluginAvailable = true;

beforeEach(() => {
  jest.useFakeTimers();
  acquireCalls = 0;
  pluginAvailable = true;
  proxy.initFrameProcessorPlugin = () => {
    acquireCalls += 1;
    return pluginAvailable ? { call: () => undefined } : null;
  };
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  proxy.initFrameProcessorPlugin = realInit;
});

/** Renders the hook and records `isReady` for every render, in order. */
function renderHook(initialEnabled: boolean) {
  const seen: boolean[] = [];
  function Probe({ enabled }: { enabled: boolean }): null {
    seen.push(useSweepWorklet(enabled).isReady);
    return null;
  }
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<Probe enabled={initialEnabled} />); });
  return {
    seen,
    setEnabled: (e: boolean) => {
      act(() => { tree.update(<Probe enabled={e} />); });
    },
    unmount: () => { act(() => { tree.unmount(); }); },
  };
}

describe('useSweepWorklet — readiness on the render that needs it', () => {
  it('is ready on the FIRST render when the registry is already up', () => {
    const h = renderHook(true);
    expect(h.seen[0]).toBe(true);
    h.unmount();
  });

  it('⚑ …and on the first render after the ENGINE switches in', () => {
    // The gap a `useState` initializer leaves: it ran once, with `enabled`
    // false, and `<Camera>` is not remounted when `engine` changes. Before
    // the ref-during-render fix this render read false and the next read
    // true — one frame of "the surface owns the camera" on a screen where
    // the host does.
    const h = renderHook(false);
    expect(h.seen[0]).toBe(false);          // correctly idle: never asked
    const before = h.seen.length;
    h.setEnabled(true);
    expect(h.seen[before]).toBe(true);      // the VERY first enabled render
    h.unmount();
  });

  it('asks the registry NOTHING while disabled', () => {
    // The other half of the gate: four modes that will never call the
    // plugin must not poll for it.
    renderHook(false).unmount();
    expect(acquireCalls).toBe(0);
  });
});

describe('useSweepWorklet — a build without the plugin gives up', () => {
  it('⚑ stops retrying, rather than polling at ~62 Hz forever', () => {
    pluginAvailable = false;
    const h = renderHook(true);
    act(() => { jest.advanceTimersByTime(5000); });
    const settled = acquireCalls;
    act(() => { jest.advanceTimersByTime(60_000); });
    // A whole extra minute buys no further attempts. Before the budget this
    // ran for the life of every camera screen, in every mode.
    expect(acquireCalls).toBe(settled);
    // …and it really did try — a zero here would satisfy the line above for
    // the wrong reason.
    expect(settled).toBeGreaterThan(10);
    h.unmount();
  });

  it('⚑ …INCLUDING across re-renders — the render-phase acquire is bounded too', () => {
    // The bound lived in the effect only, and the render-phase acquire added
    // to fix the engine-switch flap consulted neither it nor the effect's
    // exhausted state. So every render of the sweep screen issued another
    // JSI call, forever — the same unbounded poll, reintroduced beside its
    // own fix. The original test could not see it because it never
    // re-rendered after the budget expired.
    pluginAvailable = false;
    const h = renderHook(true);
    act(() => { jest.advanceTimersByTime(5000); });
    const settled = acquireCalls;
    expect(settled).toBeGreaterThan(10);
    for (let i = 0; i < 20; i += 1) h.setEnabled(true);
    expect(acquireCalls).toBe(settled);
    h.unmount();
  });

  it('⚑ …but a switch back INTO the sweep re-opens the question once', () => {
    // Giving up must not be permanent for the life of the screen: the
    // registry can come up between one engine and the next.
    pluginAvailable = false;
    const h = renderHook(true);
    act(() => { jest.advanceTimersByTime(5000); });
    const exhausted = acquireCalls;
    h.setEnabled(false);
    pluginAvailable = true;
    h.setEnabled(true);
    expect(acquireCalls).toBeGreaterThan(exhausted);
    expect(h.seen[h.seen.length - 1]).toBe(true);
    h.unmount();
  });

  it('reports NOT ready, which is what the ownership predicate needs', () => {
    pluginAvailable = false;
    const h = renderHook(true);
    act(() => { jest.advanceTimersByTime(5000); });
    expect(h.seen[h.seen.length - 1]).toBe(false);
    h.unmount();
  });
});
