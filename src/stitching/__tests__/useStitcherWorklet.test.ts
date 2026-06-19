// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `useStitcherWorklet`.
 *
 * Coverage focus (v0.11.1):
 *
 *   - **AR-source short-circuit.**  The hook's docstring promises
 *     that AR-mode hosts can call `stitcher.call(frame)` from a
 *     single composed worklet body without per-mode branching; AR
 *     stitching runs natively via the AR-side dispatcher.  Pre-
 *     v0.11.1 the code didn't enforce that — `stitcher.call` would
 *     invoke the vc Frame Processor plugin even on AR-source
 *     frames, which throws `getPropertyAsObject: property '__frame'
 *     is undefined` because AR frames are `CameraFrameHostObject`
 *     instances and don't carry vc's JSI `Frame` proxy marker.  The
 *     throw was caught silently by the per-worklet error handler in
 *     `RNSARWorkletRuntime.mm`, surfacing only as an `os_log` entry
 *     — invisible to JS, which is why composed hosts saw their
 *     post-`stitcher.call` lines (`fireFrameProcessorLog`,
 *     `runOnJS` callbacks) silently never execute in AR mode.  Test
 *     2 of `docs/v0.11.0-manual-verification-checklist.md`
 *     reproduced this on Ram's iPhone.  This test pins the fix.
 *
 *   - **vc-source happy path.**  vc-source frames (and frames whose
 *     `source` is `undefined` — which is what vc's raw `Frame`
 *     looks like; the lib doesn't wrap vc frames in Phase 4a) MUST
 *     still invoke the plugin.
 *
 * ## Why mock React's hooks directly
 *
 * The hook owns state via `useState` (the JSI plugin handle) and
 * side effects via `useEffect` (plugin acquisition retry loop + gyro
 * subscription).  The existing test pattern in this directory (see
 * `useThrottledFrameProcessor.test.ts`) doesn't use a React renderer
 * — instead it mocks the hooks the SUT calls so the SUT can be
 * executed as a plain function.  Same approach here: we mock
 * `useState` to return a pre-resolved plugin, `useCallback` to
 * return the function as-is, `useEffect` as a no-op (we don't need
 * the plugin-acquisition retry or gyro for the call-routing test).
 */

import type { CameraFrame } from '../CameraFrame';

// ─── Mock vision-camera ──────────────────────────────────────────
const pluginCallSpy = jest.fn();
const fakePlugin = { call: pluginCallSpy } as unknown as object;

jest.mock('react-native-vision-camera', () => ({
  VisionCameraProxy: {
    initFrameProcessorPlugin: jest.fn(() => fakePlugin),
  },
}));

// ─── Mock react-native-worklets-core ─────────────────────────────
jest.mock('react-native-worklets-core', () => ({
  useSharedValue: (initial: number) => ({ value: initial }),
}));

// ─── Mock react-native-sensors ───────────────────────────────────
jest.mock('react-native-sensors', () => ({
  gyroscope: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { gyroscope: 'gyroscope' },
}));

// ─── Mock React's hooks so the SUT runs as a plain function ──────
//
// `useState` returns the plugin pre-resolved.  `useCallback` returns
// the function identity (deps array ignored — we're not testing
// re-render semantics).  `useEffect` is a no-op (no plugin retry,
// no gyro subscription).  This lets us call the hook synchronously
// and exercise the worklet body via the returned `call` function.
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useState: <T,>(initial: T): [T, (next: T) => void] => {
      // For the [plugin, setPlugin] tuple: return the fake plugin
      // immediately rather than starting at `null`.  This skips the
      // plugin-acquisition retry path and lets `call` actually
      // invoke `plugin.call(...)`.
      const resolved = (initial === null ? fakePlugin : initial) as T;
      return [resolved, () => {}];
    },
    useEffect: () => {},
    useCallback: <T,>(fn: T): T => fn,
  };
});

// SUT — imported AFTER mocks so the hook sees them.
// eslint-disable-next-line import/first
import { useStitcherWorklet } from '../useStitcherWorklet';

describe('useStitcherWorklet', () => {
  beforeEach(() => {
    pluginCallSpy.mockReset();
  });

  describe('AR-source short-circuit (v0.11.1 fix)', () => {
    it('does NOT invoke the vc plugin for AR-source frames', () => {
      const { call } = useStitcherWorklet();
      const arFrame: CameraFrame = {
        width: 1920,
        height: 1080,
        pixelFormat: 'yuv',
        orientation: 'landscape-right',
        timestamp: 0,
        toArrayBuffer: () => new ArrayBuffer(0),
        source: 'ar',
        pose: { rotation: [0, 0, 0, 1] },
      };
      call(arFrame);
      expect(pluginCallSpy).not.toHaveBeenCalled();
    });

    it('does NOT invoke the vc plugin for AR-source frames even when called repeatedly', () => {
      const { call } = useStitcherWorklet();
      const arFrame: CameraFrame = {
        width: 1920,
        height: 1080,
        pixelFormat: 'yuv',
        orientation: 'landscape-right',
        timestamp: 0,
        toArrayBuffer: () => new ArrayBuffer(0),
        source: 'ar',
        pose: { rotation: [0, 0, 0, 1] },
      };
      for (let i = 0; i < 30; i++) call(arFrame);
      expect(pluginCallSpy).not.toHaveBeenCalled();
    });
  });

  describe('vc-source happy path', () => {
    it('invokes the vc plugin for vc-source frames', () => {
      const { call } = useStitcherWorklet();
      const vcFrame: CameraFrame = {
        width: 1920,
        height: 1080,
        pixelFormat: 'yuv',
        orientation: 'landscape-right',
        timestamp: 0,
        toArrayBuffer: () => new ArrayBuffer(0),
        source: 'vc',
        pose: { rotation: [0, 0, 0, 1] },
      };
      call(vcFrame);
      expect(pluginCallSpy).toHaveBeenCalledTimes(1);
    });

    it('invokes the vc plugin for frames with undefined source (raw vc Frame)', () => {
      // vc's raw `Frame` doesn't carry the `source` field — the lib's
      // Phase 4a deferral means we don't wrap vc frames into
      // `CameraFrame`.  The AR-source check must treat undefined
      // as "not AR" to preserve the non-AR worklet path.
      const { call } = useStitcherWorklet();
      const rawVcFrame = {
        width: 1920,
        height: 1080,
        pixelFormat: 'yuv',
        orientation: 'landscape-right',
        timestamp: 0,
        toArrayBuffer: () => new ArrayBuffer(0),
        // `source` intentionally absent
      } as unknown as CameraFrame;
      call(rawVcFrame);
      expect(pluginCallSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('plugin.call payload shape', () => {
    it('passes the frame + a numeric-intrinsics params object', () => {
      const { call } = useStitcherWorklet();
      const vcFrame: CameraFrame = {
        width: 1920,
        height: 1080,
        pixelFormat: 'yuv',
        orientation: 'landscape-right',
        timestamp: 0,
        toArrayBuffer: () => new ArrayBuffer(0),
        source: 'vc',
        pose: { rotation: [0, 0, 0, 1] },
      };
      call(vcFrame);
      expect(pluginCallSpy).toHaveBeenCalledWith(
        vcFrame,
        expect.objectContaining({
          tx: 0, ty: 0, tz: 0,
          qx: expect.any(Number),
          qy: expect.any(Number),
          qz: expect.any(Number),
          qw: expect.any(Number),
          fx: expect.any(Number),
          fy: expect.any(Number),
          cx: 960,
          cy: 540,
          imageWidth: 1920,
          imageHeight: 1080,
        }),
      );
    });
  });
});
