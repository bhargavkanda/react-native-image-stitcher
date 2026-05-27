// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the v0.9.0 Layer 2 `useThrottledFrameProcessor` hook.
 *
 * The worklet runtime can't run in jest (no JSI, no worklets-core).
 * What we CAN test:
 *
 *   - The `sampleHz` clamping (`[0.5, 30]`)
 *   - `minIntervalMs` math (1000 / sampleHz)
 *   - The deps propagation (host's deps → useFrameProcessor's deps)
 *   - The throttle gate logic (extracted as a pure function for
 *     isolated verification — see `_throttleGateForTests`).
 *
 * The hook itself is tested via a thin React-renderer-free harness:
 * we mock `useFrameProcessor` + `useSharedValue` so we can verify
 * the call shape without booting the worklet runtime.
 */

import { useThrottledFrameProcessor } from '../useThrottledFrameProcessor';

// ─── Mock vision-camera + worklets-core ─────────────────────────────
// These are minimal-shim mocks — enough surface for the hook to call
// `useFrameProcessor(workletBody, deps)` and `useSharedValue(0)`.

const useFrameProcessorMock = jest.fn();
const useSharedValueMock = jest.fn();

jest.mock('../useFrameProcessor', () => ({
  useFrameProcessor: (...args: unknown[]) => useFrameProcessorMock(...args),
}));

jest.mock('react-native-worklets-core', () => ({
  useSharedValue: (initial: number) => useSharedValueMock(initial),
}));

describe('useThrottledFrameProcessor', () => {
  beforeEach(() => {
    useFrameProcessorMock.mockReset();
    useSharedValueMock.mockReset();
    // Default behaviour for useSharedValue: return an object with a
    // mutable `.value` field (mirrors worklets-core's API).
    useSharedValueMock.mockImplementation((initial: number) => ({
      value: initial,
    }));
  });

  describe('sampleHz clamping', () => {
    it('clamps below 0.5 to 0.5', () => {
      const noop = (() => {}) as unknown as Parameters<typeof useThrottledFrameProcessor>[0];
      useThrottledFrameProcessor(noop, { sampleHz: 0.1 }, []);
      // useFrameProcessor receives the wrapped worklet; the deps
      // array's first entry is `minIntervalMs`.  For sampleHz=0.5,
      // minIntervalMs = 2000.
      const [, deps] = useFrameProcessorMock.mock.calls[0]!;
      expect(deps[0]).toBeCloseTo(2000);
    });

    it('clamps above 30 to 30', () => {
      const noop = (() => {}) as unknown as Parameters<typeof useThrottledFrameProcessor>[0];
      useThrottledFrameProcessor(noop, { sampleHz: 999 }, []);
      const [, deps] = useFrameProcessorMock.mock.calls[0]!;
      // sampleHz=30 → minIntervalMs = 33.333...
      expect(deps[0]).toBeCloseTo(1000 / 30);
    });

    it('passes through in-range sampleHz unchanged', () => {
      const noop = (() => {}) as unknown as Parameters<typeof useThrottledFrameProcessor>[0];
      useThrottledFrameProcessor(noop, { sampleHz: 2 }, []);
      const [, deps] = useFrameProcessorMock.mock.calls[0]!;
      expect(deps[0]).toBeCloseTo(500);
    });

    it('accepts boundary values exactly', () => {
      const noop = (() => {}) as unknown as Parameters<typeof useThrottledFrameProcessor>[0];
      useThrottledFrameProcessor(noop, { sampleHz: 0.5 }, []);
      let deps = useFrameProcessorMock.mock.calls[0]![1];
      expect(deps[0]).toBeCloseTo(2000);

      useFrameProcessorMock.mockClear();
      useThrottledFrameProcessor(noop, { sampleHz: 30 }, []);
      deps = useFrameProcessorMock.mock.calls[0]![1];
      expect(deps[0]).toBeCloseTo(1000 / 30);
    });
  });

  describe('deps propagation', () => {
    it('appends host deps after the internal interval + worklet deps', () => {
      const noop = (() => {}) as unknown as Parameters<typeof useThrottledFrameProcessor>[0];
      const hostDep1 = { id: 'a' };
      const hostDep2 = 42;
      useThrottledFrameProcessor(noop, { sampleHz: 2 }, [hostDep1, hostDep2]);
      const [, deps] = useFrameProcessorMock.mock.calls[0]!;
      // Expected shape: [minIntervalMs, worklet, ...hostDeps]
      expect(deps).toHaveLength(4);
      expect(deps[0]).toBeCloseTo(500);
      expect(deps[1]).toBe(noop);
      expect(deps[2]).toBe(hostDep1);
      expect(deps[3]).toBe(hostDep2);
    });

    it('with empty host deps: deps = [minIntervalMs, worklet]', () => {
      const noop = (() => {}) as unknown as Parameters<typeof useThrottledFrameProcessor>[0];
      useThrottledFrameProcessor(noop, { sampleHz: 2 }, []);
      const [, deps] = useFrameProcessorMock.mock.calls[0]!;
      expect(deps).toHaveLength(2);
      expect(deps[0]).toBeCloseTo(500);
      expect(deps[1]).toBe(noop);
    });
  });

  describe('throttle gate', () => {
    // The throttle logic lives INSIDE the wrapped worklet body, which
    // jest can't execute directly (it's a `'worklet'`-prefixed
    // function).  But the wrapped function IS just a plain JS
    // function until the worklets-core babel plugin transforms it,
    // so we can call it manually with mock frames + a mock
    // shared-value gate.
    //
    // The body's logic:
    //   if (frame.timestamp - lastSampleMs.value < minIntervalMs) return;
    //   lastSampleMs.value = frame.timestamp;
    //   worklet(frame);

    it('fires the worklet on the first frame regardless of timestamp', () => {
      const hostWorklet = jest.fn();
      useThrottledFrameProcessor(hostWorklet, { sampleHz: 2 }, []);
      const [wrappedBody] = useFrameProcessorMock.mock.calls[0]!;

      const frame = { timestamp: 12345 } as Parameters<typeof hostWorklet>[0];
      wrappedBody(frame);

      expect(hostWorklet).toHaveBeenCalledTimes(1);
      expect(hostWorklet).toHaveBeenCalledWith(frame);
    });

    it('skips a frame too close to the previous sample', () => {
      const hostWorklet = jest.fn();
      useThrottledFrameProcessor(hostWorklet, { sampleHz: 2 }, []); // 500ms interval
      const [wrappedBody] = useFrameProcessorMock.mock.calls[0]!;

      wrappedBody({ timestamp: 1000 } as never);
      wrappedBody({ timestamp: 1100 } as never); // 100ms after — too soon
      wrappedBody({ timestamp: 1200 } as never); // 200ms after — too soon

      expect(hostWorklet).toHaveBeenCalledTimes(1);
    });

    it('fires again exactly at the interval boundary', () => {
      const hostWorklet = jest.fn();
      useThrottledFrameProcessor(hostWorklet, { sampleHz: 2 }, []); // 500ms
      const [wrappedBody] = useFrameProcessorMock.mock.calls[0]!;

      wrappedBody({ timestamp: 1000 } as never);
      wrappedBody({ timestamp: 1500 } as never); // exactly at boundary

      expect(hostWorklet).toHaveBeenCalledTimes(2);
    });

    it('fires again past the interval boundary', () => {
      const hostWorklet = jest.fn();
      useThrottledFrameProcessor(hostWorklet, { sampleHz: 2 }, []); // 500ms
      const [wrappedBody] = useFrameProcessorMock.mock.calls[0]!;

      wrappedBody({ timestamp: 1000 } as never);
      wrappedBody({ timestamp: 1600 } as never); // 600ms after

      expect(hostWorklet).toHaveBeenCalledTimes(2);
    });
  });

  describe('shared value lifecycle', () => {
    it('initializes lastSampleMs to 0', () => {
      const noop = (() => {}) as unknown as Parameters<typeof useThrottledFrameProcessor>[0];
      useThrottledFrameProcessor(noop, { sampleHz: 2 }, []);
      expect(useSharedValueMock).toHaveBeenCalledWith(0);
    });
  });
});
