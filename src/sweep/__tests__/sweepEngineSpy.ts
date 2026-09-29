// SPDX-License-Identifier: Apache-2.0
/**
 * M8 — what `<Camera>` hands its sweep engine, observed WITHOUT replacing it.
 *
 * Since the collapse `<Camera>` calls `useSweepEngine` itself, and on every
 * cell but the DR-1a hatch there is no sweep element in its tree to read props
 * off. A render suite that mocks the hook with {@link sweepEngineSpyFactory}
 * runs the REAL engine and records what each render passed it:
 *
 *   jest.mock('../useSweepEngine', () =>
 *     require('./sweepEngineSpy').sweepEngineSpyFactory());
 *
 * Not a test file (no `.test.` in the name), so neither jest project collects
 * it.
 */
export interface SweepEngineCall {
  props: Record<string, unknown>;
  /** The `enabled` option `<Camera>` passed: is the engine SELECTED? */
  enabled: boolean;
}

const store = globalThis as {
  __sweepEngineCalls?: SweepEngineCall[];
  __sweepArFrames?: number;
};

/** The `jest.mock` factory: the real module, with the hook wrapped. */
export function sweepEngineSpyFactory(): Record<string, unknown> {
  const actual = jest.requireActual('../useSweepEngine') as {
    useSweepEngine: (p: unknown, r: unknown, o?: { enabled?: boolean }) => unknown;
  };
  return {
    ...actual,
    useSweepEngine: (
      props: Record<string, unknown>,
      ref: unknown,
      options: { enabled?: boolean } = {},
    ) => {
      const calls = (store.__sweepEngineCalls ??= []);
      calls.push({ props, enabled: options.enabled ?? true });
      // Bounded: only the most recent renders are ever read.
      if (calls.length > 50) calls.splice(0, calls.length - 50);
      const engine = actual.useSweepEngine(props, ref, options) as {
        handleArFrame: (m: unknown) => void;
      };
      // Counts the AR frames that reach the engine, then hands them on.
      return {
        ...engine,
        handleArFrame: (m: unknown) => {
          store.__sweepArFrames = (store.__sweepArFrames ?? 0) + 1;
          engine.handleArFrame(m);
        },
      };
    },
  };
}

/** The most recent call. Throws when `<Camera>` never called the hook. */
export function lastSweepEngineCall(): SweepEngineCall {
  const calls = store.__sweepEngineCalls ?? [];
  const last = calls[calls.length - 1];
  if (last == null) throw new Error('useSweepEngine was never called');
  return last;
}

/** The props `<Camera>` passed its sweep engine on the latest render. */
export function lastSweepProps(): Record<string, unknown> {
  return lastSweepEngineCall().props;
}

/** How many AR frames reached the engine's `handleArFrame`. */
export function sweepArFramesSeen(): number {
  return store.__sweepArFrames ?? 0;
}

export function resetSweepEngineCalls(): void {
  store.__sweepEngineCalls = [];
  store.__sweepArFrames = 0;
}
