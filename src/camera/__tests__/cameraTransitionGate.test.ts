// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `cameraTransitionAction` — the v0.25.1 fix for the camera
 * handoff flag that could LATCH TRUE FOREVER and kill the shutter.
 *
 * ## The failure this encodes
 *
 * `<Camera>` holds the AR ↔ non-AR / 1x ↔ 0.5x handoff gate closed with two
 * pieces of state: refs holding the last SETTLED identity, and a
 * `cameraTransitioning` flag covering the async settle.  The old effect
 * early-returned whenever the refs already matched — and a flip-BACK inside
 * the 250 ms grace makes "refs match" stop implying "nothing in flight":
 *
 *   1. Lens 1x -> 0.5x.  Gate closes (flag = true), settle scheduled at
 *      +250 ms.  The refs are updated only inside that callback.
 *   2. Inside the window the lens goes BACK 0.5x -> 1x.  The cleanup sets
 *      `cancelled = true`, so the pending settle no-ops and never reaches its
 *      `setCameraTransitioning(false)`.
 *   3. The effect re-runs; the never-updated refs now MATCH, so the old code
 *      early-returned — leaving the flag set with nothing able to clear it.
 *      `setCameraTransitioning(false)` exists at exactly ONE site, the one
 *      step 2 just cancelled.
 *
 * `inFlightTransition` is then permanently true, so `cameraShouldUnmount()`
 * never remounts the live camera (stuck on "Switching camera…") and
 * `holdShouldDeferForCamera()` defers every hold into `pendingPanStart`, which
 * `handleHoldEnd` cancels on release: a permanently dead shutter.
 *
 * ## FOUND BY INSPECTION — NOT FIELD-REPRODUCED
 *
 * This came out of reading the effect, not from a device.  The operator tried
 * to wedge it by hand and could not: the flip-back has to land inside a
 * ~250 ms window, which is hard to hit deliberately on a lens chip.  These
 * tests are therefore the primary evidence the path is real — `LEGACY_DECIDE`
 * below reproduces the OLD early-return and shows the harness wedging, so the
 * bug and its fix are both demonstrated rather than asserted.
 *
 * Pure-TS test per jest.config.js — `cameraTransitionGate.ts` imports nothing
 * at all (no React, no react-native, no native module), so no stubbing is
 * needed and the sequence runs deterministically with no timers.
 */

import {
  cameraTransitionAction,
  type CameraTransitionAction,
} from '../cameraTransitionGate';

type Lens = '1x' | '0.5x';

/** Every action, for exhaustiveness checks. */
const ALL_ACTIONS: CameraTransitionAction[] = [
  'start-transition',
  'clear-stuck-flag',
  'noop',
];

/**
 * The PRE-FIX decision, kept so the wedge itself is executable.  Identical to
 * the shipped one except the already-settled path always says "do nothing" —
 * i.e. the early return that could never clear a latched flag.
 */
function LEGACY_DECIDE<L>(
  settledIsAR: boolean,
  settledLens: L,
  isAR: boolean,
  lens: L,
  _cameraTransitioning: boolean,
): CameraTransitionAction {
  if (settledIsAR !== isAR || settledLens !== lens) return 'start-transition';
  return 'noop';
}

/**
 * A faithful, timer-free model of the real effect: the settled refs, the flag,
 * the `cancelled` closure, the cleanup, and React's "deps are [isAR, lens]"
 * re-run rule.  Everything the effect does EXCEPT the decision is hard-coded
 * here, so swapping `decide` swaps exactly one thing — which is what makes the
 * legacy-vs-fixed comparison below a real A/B and not two different harnesses.
 */
function createHandoffHarness(
  initialIsAR: boolean,
  initialLens: Lens,
  decide: typeof cameraTransitionAction = cameraTransitionAction,
) {
  // Mirrors settledIsARRef / settledLensRef / cameraTransitioning.
  let settledIsAR = initialIsAR;
  let settledLens: Lens = initialLens;
  let cameraTransitioning = false;
  // Mirrors the props/derived values the effect closes over.
  let isAR = initialIsAR;
  let lens: Lens = initialLens;

  let cleanup: (() => void) | null = null;
  let pendingSettle: (() => void) | null = null;
  let arStopCalls = 0;
  let flagWrites = 0;

  const runEffect = () => {
    const action = decide(settledIsAR, settledLens, isAR, lens, cameraTransitioning);
    if (action !== 'start-transition') {
      if (action === 'clear-stuck-flag') {
        cameraTransitioning = false;
        flagWrites += 1;
      }
      cleanup = null;
      return;
    }
    cameraTransitioning = true;
    flagWrites += 1;
    let cancelled = false;
    // The effect closes over THIS run's isAR/lens for the settle.
    const targetIsAR = isAR;
    const targetLens = lens;
    // `wasAR` is read before the refs move — this is what gates the AR stop.
    if (settledIsAR) arStopCalls += 1;
    pendingSettle = () => {
      if (cancelled) return;
      settledIsAR = targetIsAR;
      settledLens = targetLens;
      cameraTransitioning = false;
      flagWrites += 1;
    };
    cleanup = () => { cancelled = true; };
  };

  return {
    /** Initial mount — the effect always runs once. */
    mount() { runEffect(); },
    /**
     * The host changes isAR/lens.  React runs the previous cleanup and re-runs
     * the effect, but ONLY if a dep actually changed — deps are [isAR, lens].
     */
    setIdentity(nextIsAR: boolean, nextLens: Lens) {
      if (nextIsAR === isAR && nextLens === lens) return;
      isAR = nextIsAR;
      lens = nextLens;
      cleanup?.();
      cleanup = null;
      runEffect();
    },
    /** The 250 ms grace elapses and the scheduled settle fires (or no-ops). */
    elapseGrace() {
      const settle = pendingSettle;
      pendingSettle = null;
      settle?.();
    },
    /** Exactly the expression in Camera.tsx. */
    get inFlightTransition() {
      return settledIsAR !== isAR || settledLens !== lens || cameraTransitioning;
    },
    get cameraTransitioning() { return cameraTransitioning; },
    get settled() { return { isAR: settledIsAR, lens: settledLens }; },
    get arStopCalls() { return arStopCalls; },
    /** How many times the flag was written — the convergence measure. */
    get flagWrites() { return flagWrites; },
  };
}

describe('cameraTransitionAction — the decision', () => {
  it('starts a transition when the lens differs from the settled lens', () => {
    expect(cameraTransitionAction(false, '1x', false, '0.5x', false))
      .toBe('start-transition');
  });

  it('starts a transition when the AR mode differs', () => {
    expect(cameraTransitionAction(false, '1x', true, '1x', false))
      .toBe('start-transition');
  });

  it('noops when settled and the flag is clear — writes NOTHING', () => {
    expect(cameraTransitionAction(false, '1x', false, '1x', false)).toBe('noop');
  });

  it('clears the flag when settled but the flag is still set (THE FIX)', () => {
    expect(cameraTransitionAction(false, '1x', false, '1x', true))
      .toBe('clear-stuck-flag');
  });

  describe('an identity change DOMINATES the flag', () => {
    it.each([false, true])(
      'still starts a transition with cameraTransitioning=%s',
      (flag) => {
        // A transition already in flight must still be restarted for the NEW
        // target — the previous run's cleanup cancels its pending settle, so
        // returning anything else here would strand the new identity.
        expect(cameraTransitionAction(false, '1x', false, '0.5x', flag))
          .toBe('start-transition');
        expect(cameraTransitionAction(true, '1x', false, '0.5x', flag))
          .toBe('start-transition');
      },
    );
  });

  describe('total — every input triple maps to exactly one known action', () => {
    it('covers the full 2x2x2x2x2 space with no undefined result', () => {
      const lenses: Lens[] = ['1x', '0.5x'];
      for (const settledIsAR of [true, false]) {
        for (const settledLens of lenses) {
          for (const isAR of [true, false]) {
            for (const lens of lenses) {
              for (const flag of [true, false]) {
                const action = cameraTransitionAction(
                  settledIsAR, settledLens, isAR, lens, flag,
                );
                expect(ALL_ACTIONS).toContain(action);
              }
            }
          }
        }
      }
    });

    it('only ever writes state when there is something to do', () => {
      // The settled+clear case is the one that must NOT write, or the effect
      // re-triggers itself off its own state write.
      expect(cameraTransitionAction(true, '0.5x', true, '0.5x', false))
        .toBe('noop');
    });
  });
});

describe('the ordinary settle — unchanged behaviour', () => {
  it('closes the gate, stops AR, then opens it when the grace elapses', () => {
    const h = createHandoffHarness(true, '1x');
    h.mount();
    expect(h.inFlightTransition).toBe(false);

    h.setIdentity(true, '0.5x');
    // Gate closed for the whole grace: camera unmounted, holds deferred.
    expect(h.cameraTransitioning).toBe(true);
    expect(h.inFlightTransition).toBe(true);
    // We were in AR, so the session was explicitly stopped exactly once.
    expect(h.arStopCalls).toBe(1);

    h.elapseGrace();
    // Refs and flag move together, so the gate opens on one commit.
    expect(h.settled).toEqual({ isAR: true, lens: '0.5x' });
    expect(h.cameraTransitioning).toBe(false);
    expect(h.inFlightTransition).toBe(false);
  });

  it('does not stop the AR session when the settled mode was non-AR', () => {
    const h = createHandoffHarness(false, '1x');
    h.mount();
    h.setIdentity(false, '0.5x');
    expect(h.arStopCalls).toBe(0);
    h.elapseGrace();
    expect(h.inFlightTransition).toBe(false);
  });

  it('an AR-mode flip settles the same way', () => {
    const h = createHandoffHarness(false, '1x');
    h.mount();
    h.setIdentity(true, '1x');
    expect(h.inFlightTransition).toBe(true);
    h.elapseGrace();
    expect(h.settled).toEqual({ isAR: true, lens: '1x' });
    expect(h.inFlightTransition).toBe(false);
  });
});

describe('THE LATCH — flip back inside the 250 ms grace', () => {
  it('WEDGES FOREVER under the pre-fix early return (the bug, executed)', () => {
    const h = createHandoffHarness(false, '1x', LEGACY_DECIDE);
    h.mount();

    // 1. 1x -> 0.5x: gate closes, settle scheduled.
    h.setIdentity(false, '0.5x');
    expect(h.cameraTransitioning).toBe(true);

    // 2. back to 1x INSIDE the window: cleanup cancels the pending settle,
    //    and the re-run finds the refs already equal -> early return.
    h.setIdentity(false, '1x');

    // 3. the grace elapses — the cancelled callback no-ops.
    h.elapseGrace();

    // The flag is stuck true with nothing left to clear it.
    expect(h.cameraTransitioning).toBe(true);
    expect(h.inFlightTransition).toBe(true);

    // And it NEVER recovers: further grace ticks, and even settling on the
    // same identity again, cannot reach the one setCameraTransitioning(false).
    h.elapseGrace();
    h.elapseGrace();
    expect(h.inFlightTransition).toBe(true);
    // => cameraShouldUnmount() stays true (stuck on "Switching camera…") and
    //    holdShouldDeferForCamera() stays true (dead shutter).
  });

  it('RECOVERS with the fix — same sequence, gate reopens', () => {
    const h = createHandoffHarness(false, '1x');
    h.mount();

    h.setIdentity(false, '0.5x');
    expect(h.cameraTransitioning).toBe(true);
    expect(h.inFlightTransition).toBe(true);

    // The flip-back re-runs the effect (lens is a dep), and the fix clears the
    // flag on that very run — no timer needed, so recovery is synchronous.
    h.setIdentity(false, '1x');
    expect(h.cameraTransitioning).toBe(false);
    expect(h.inFlightTransition).toBe(false);

    // The stale settle still fires later; it is cancelled and must stay inert.
    h.elapseGrace();
    expect(h.cameraTransitioning).toBe(false);
    expect(h.inFlightTransition).toBe(false);
    expect(h.settled).toEqual({ isAR: false, lens: '1x' });
  });

  it('converges in ONE extra flag write and then stops', () => {
    const h = createHandoffHarness(false, '1x');
    h.mount();
    h.setIdentity(false, '0.5x');   // write 1: flag -> true
    const beforeRecovery = h.flagWrites;
    h.setIdentity(false, '1x');     // write 2: flag -> false (the fix)
    expect(h.flagWrites).toBe(beforeRecovery + 1);

    // Now settled and clear.  The next decision is 'noop', so the effect
    // writes no state — which is why clearing cannot re-trigger itself even
    // if `cameraTransitioning` were ever added to the dep array.
    expect(cameraTransitionAction(false, '1x', false, '1x', false)).toBe('noop');
    h.elapseGrace();
    expect(h.flagWrites).toBe(beforeRecovery + 1);
  });

  it('recovers from an AR-mode flip-back too, not just a lens flip-back', () => {
    const h = createHandoffHarness(true, '1x');
    h.mount();
    h.setIdentity(false, '1x');   // AR -> non-AR, gate closes
    expect(h.inFlightTransition).toBe(true);
    h.setIdentity(true, '1x');    // straight back inside the grace
    expect(h.cameraTransitioning).toBe(false);
    expect(h.inFlightTransition).toBe(false);
    h.elapseGrace();
    expect(h.inFlightTransition).toBe(false);
  });

  it('a flip to a THIRD identity still settles normally, not via the fix', () => {
    const h = createHandoffHarness(false, '1x');
    h.mount();
    h.setIdentity(false, '0.5x');
    // Not a flip-BACK: the new target differs from the settled refs, so this
    // must take the start-transition path and wait out its own grace.
    h.setIdentity(true, '0.5x');
    expect(h.cameraTransitioning).toBe(true);
    expect(h.inFlightTransition).toBe(true);
    h.elapseGrace();
    expect(h.settled).toEqual({ isAR: true, lens: '0.5x' });
    expect(h.inFlightTransition).toBe(false);
  });

  it('survives repeated flip-flapping without latching', () => {
    const h = createHandoffHarness(false, '1x');
    h.mount();
    for (let i = 0; i < 10; i += 1) {
      h.setIdentity(false, '0.5x');
      h.setIdentity(false, '1x');
    }
    // Every flip-back cleared the flag it set, so the shutter is alive.
    expect(h.cameraTransitioning).toBe(false);
    expect(h.inFlightTransition).toBe(false);
    h.elapseGrace();
    expect(h.inFlightTransition).toBe(false);
  });
});
