// SPDX-License-Identifier: Apache-2.0
/**
 * Unit + integration coverage for the v0.10.0 PR B refine-progress
 * lifecycle on the `IncrementalStateUpdate` channel.
 *
 * What this test is for:
 *
 *   - Contract: native emits a 4-stage sequence
 *     `validating → stitching → writing → done` (and the failure
 *     variant `validating → error`) with `refineStage` /
 *     `refineProgress` / `refineFrames` / `refineError` keys.
 *   - Regression: catches a future renamer of any of those keys
 *     (subscribeIncrementalState would silently deliver `undefined`
 *     for the missing fields, and the host's progress pill would
 *     stop rendering — exactly the bug class we hit on iOS in PR B
 *     before the bridgeless-interop fix).
 *
 * What this test is NOT for:
 *
 *   - Exercising the real native bridge — RCTEventEmitter under RN
 *     bridgeless interop can only be tested on-device.  The bug we
 *     fixed in PR B (sendEvent silently no-ops for certain body
 *     shapes) is verified via the manual smoke test recorded in
 *     CHANGELOG.md "Fixed — v0.10.0 PR B (iOS)".  This file pins
 *     the JS-side contract that bridge fix has to satisfy.
 *
 * Mock surface: per-test `jest.mock('react-native', ...)` so the
 * shared `jest.mocks/react-native.js` stays minimal (per the comment
 * in that file).  We stub `NativeModules.IncrementalStitcher` and
 * `NativeEventEmitter` together because `subscribeIncrementalState`
 * wires them together internally.
 */

import type { IncrementalState } from '../incremental';

// Hand-rolled event-emitter fake we can drive synchronously from
// tests.  Modelled on RN's NativeEventEmitter shape: addListener
// returns an object with a `.remove()` method.
type Listener = (state: IncrementalState) => void;

class FakeNativeEventEmitter {
  private listeners: Map<string, Set<Listener>> = new Map();

  constructor(_nativeModule: unknown) {
    // No-op: real RN reads addListener/removeListeners off the
    // native module for the listener-count contract; we don't.
  }

  addListener(eventType: string, listener: Listener) {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(listener);
    return {
      remove: () => {
        set!.delete(listener);
      },
    };
  }

  // Test-only helper: drive an event into all subscribers.
  _emit(eventType: string, state: IncrementalState) {
    const set = this.listeners.get(eventType);
    if (!set) return;
    for (const listener of set) {
      listener(state);
    }
  }
}

// Shared emitter handle the per-test setup writes its asserts
// against.  The mock factory below has to construct via `new`, so we
// stash the latest instance here for the test to drive.
let lastEmitter: FakeNativeEventEmitter | null = null;

jest.mock('react-native', () => ({
  NativeModules: {
    IncrementalStitcher: {
      // RCTEventEmitter / NativeEventEmitter contract — RN's runtime
      // calls these when JS subscribes / unsubscribes so the native
      // side can track listener count.  We just stub them.
      addListener: jest.fn(),
      removeListeners: jest.fn(),
    },
  },
  NativeEventEmitter: jest.fn().mockImplementation((nativeModule: unknown) => {
    lastEmitter = new FakeNativeEventEmitter(nativeModule);
    return lastEmitter;
  }),
  Platform: { OS: 'ios', select: (spec: { ios?: unknown; default?: unknown }) => spec.ios ?? spec.default },
}));

// Import AFTER jest.mock so the SUT picks up the mocked module.
import { subscribeIncrementalState } from '../incremental';

// Build the base state shape the native side emits — matches the
// fields IncrementalStateObject.asDictionary() includes on iOS and
// Arguments.createMap() includes on Android.
function makeBaseState(): IncrementalState {
  return {
    width: 1920,
    height: 1080,
    acceptedCount: 3,
    outcome: 8, // acceptedHigh
    confidence: 0.92,
    overlapPercent: 18.5,
    processingMs: 0,
    isLandscape: false,
    paintedExtent: 1920,
    panExtent: 1920,
    keyframeMax: 0,
  } as IncrementalState;
}

describe('subscribeIncrementalState — refine progress lifecycle (v0.10.0 PR B)', () => {
  beforeEach(() => {
    lastEmitter = null;
    jest.clearAllMocks();
  });

  it('returns null when the native IncrementalStitcher module is missing', () => {
    // Temporarily blank the module.
    const RN = jest.requireMock('react-native') as { NativeModules: Record<string, unknown> };
    const saved = RN.NativeModules.IncrementalStitcher;
    RN.NativeModules.IncrementalStitcher = undefined;
    try {
      expect(subscribeIncrementalState(() => {})).toBeNull();
    } finally {
      RN.NativeModules.IncrementalStitcher = saved;
    }
  });

  it('returns an EmitterSubscription when subscribed; remove() stops delivery', () => {
    const events: IncrementalState[] = [];
    const sub = subscribeIncrementalState((s) => events.push(s));
    expect(sub).not.toBeNull();
    expect(lastEmitter).not.toBeNull();

    lastEmitter!._emit('IncrementalStateUpdate', {
      ...makeBaseState(),
      refineStage: 'validating',
      refineProgress: 0.05,
      refineFrames: 3,
    } as IncrementalState);
    expect(events).toHaveLength(1);

    sub!.remove();
    lastEmitter!._emit('IncrementalStateUpdate', {
      ...makeBaseState(),
      refineStage: 'done',
      refineProgress: 1.0,
      refineFrames: 3,
    } as IncrementalState);
    expect(events).toHaveLength(1); // unchanged after remove()
  });

  it('happy-path: delivers validating → stitching → writing → done in order with correct refineStage', () => {
    const stages: Array<{ stage: string | undefined; progress: number | undefined }> = [];
    subscribeIncrementalState((s) => {
      stages.push({ stage: s.refineStage, progress: s.refineProgress });
    });

    const sequence: Array<Pick<IncrementalState, 'refineStage' | 'refineProgress' | 'refineFrames'>> = [
      { refineStage: 'validating', refineProgress: 0.05, refineFrames: 3 },
      { refineStage: 'stitching',  refineProgress: 0.10, refineFrames: 3 },
      { refineStage: 'writing',    refineProgress: 0.90, refineFrames: 3 },
      { refineStage: 'done',       refineProgress: 1.00, refineFrames: 3 },
    ];
    for (const ev of sequence) {
      lastEmitter!._emit('IncrementalStateUpdate', { ...makeBaseState(), ...ev } as IncrementalState);
    }

    expect(stages).toEqual([
      { stage: 'validating', progress: 0.05 },
      { stage: 'stitching',  progress: 0.10 },
      { stage: 'writing',    progress: 0.90 },
      { stage: 'done',       progress: 1.00 },
    ]);
  });

  it('refineProgress is non-decreasing across the happy-path sequence (monotonicity contract)', () => {
    const progresses: number[] = [];
    subscribeIncrementalState((s) => {
      if (s.refineProgress !== undefined) progresses.push(s.refineProgress);
    });

    for (const p of [0.05, 0.10, 0.90, 1.00]) {
      lastEmitter!._emit('IncrementalStateUpdate', {
        ...makeBaseState(),
        refineStage: 'stitching', // stage is irrelevant for this assertion
        refineProgress: p,
        refineFrames: 3,
      } as IncrementalState);
    }

    expect(progresses).toEqual([0.05, 0.10, 0.90, 1.00]);
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]).toBeGreaterThanOrEqual(progresses[i - 1]);
    }
  });

  it('failure-path: validating → error carries refineError; no further stages emitted', () => {
    const events: IncrementalState[] = [];
    subscribeIncrementalState((s) => events.push(s));

    lastEmitter!._emit('IncrementalStateUpdate', {
      ...makeBaseState(),
      refineStage: 'validating',
      refineProgress: 0.05,
      refineFrames: 3,
    } as IncrementalState);
    lastEmitter!._emit('IncrementalStateUpdate', {
      ...makeBaseState(),
      refineStage: 'error',
      refineProgress: 1.0,
      refineFrames: 3,
      refineError: 'INVALID_FRAMES: missing JPEG at index 1',
    } as IncrementalState);

    expect(events).toHaveLength(2);
    expect(events[0].refineStage).toBe('validating');
    expect(events[1].refineStage).toBe('error');
    expect(events[1].refineError).toBe('INVALID_FRAMES: missing JPEG at index 1');
    // refineError is absent on the validating event.
    expect(events[0].refineError).toBeUndefined();
  });

  it('refineFrames passes through unchanged (regression guard for key rename)', () => {
    const seen: Array<number | undefined> = [];
    subscribeIncrementalState((s) => seen.push(s.refineFrames));

    for (const n of [3, 5, 8]) {
      lastEmitter!._emit('IncrementalStateUpdate', {
        ...makeBaseState(),
        refineStage: 'stitching',
        refineProgress: 0.5,
        refineFrames: n,
      } as IncrementalState);
    }
    expect(seen).toEqual([3, 5, 8]);
  });

  it('live (non-refine) state events leave refine fields undefined', () => {
    // Asserts that the contract is "refine fields are only populated
    // during a refine call" — so the example app's `if
    // (s.refineStage === undefined) return;` short-circuit is sound.
    const events: IncrementalState[] = [];
    subscribeIncrementalState((s) => events.push(s));

    lastEmitter!._emit('IncrementalStateUpdate', makeBaseState());
    expect(events).toHaveLength(1);
    expect(events[0].refineStage).toBeUndefined();
    expect(events[0].refineProgress).toBeUndefined();
    expect(events[0].refineFrames).toBeUndefined();
    expect(events[0].refineError).toBeUndefined();
  });

  it('subscribes on the correct channel name "IncrementalStateUpdate" (cross-platform contract)', () => {
    // If anyone renames the event constant on either side, the
    // subscriber stops receiving events.  Pin the literal here.
    let receivedOnRight = false;
    let receivedOnWrong = false;
    subscribeIncrementalState(() => {
      receivedOnRight = true;
    });
    // Fire on a deliberately-wrong channel — should NOT deliver.
    lastEmitter!._emit('SomeOtherChannel', makeBaseState());
    expect(receivedOnRight).toBe(false);
    expect(receivedOnWrong).toBe(false);
    // Fire on the right channel — should deliver.
    lastEmitter!._emit('IncrementalStateUpdate', makeBaseState());
    expect(receivedOnRight).toBe(true);
  });
});
