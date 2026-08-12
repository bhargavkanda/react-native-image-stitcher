// SPDX-License-Identifier: Apache-2.0
/**
 * useFrameProcessorDriver — vision-camera Frame Processor + gyro
 * driver for the incremental panorama engine.  Sole non-AR driver
 * from v0.6 onward (replaced the deprecated `useIncrementalJSDriver`
 * hook, which was removed in v0.6).
 *
 * v0.11.0 — refactored to a thin wrapper around `useStitcherWorklet`.
 * The plugin acquisition + shared-value declarations + gyro
 * subscription + worklet body all live in `useStitcherWorklet` now;
 * this hook just binds the returned worklet via vision-camera's
 * `useFrameProcessor` and exposes the legacy `start` / `stop` /
 * `isRunning` API for backwards compatibility with v0.10.x.
 *
 * ## Why the v0.11.0 split
 *
 * vision-camera v4 allows ONE frame processor per `<Camera>` mount.
 * Pre-v0.11.0, hosts that wanted to compose their own worklet with
 * the lib's first-party stitching couldn't — passing a host
 * `frameProcessor` REPLACED the lib's processor.  v0.11.0 closes
 * this gap by exposing the worklet body via `useStitcherWorklet`
 * so hosts can write:
 *
 *   const stitcher = useStitcherWorklet();
 *   const fp = useFrameProcessor((frame) => {
 *     'worklet';
 *     hostPreLogic(frame);
 *     stitcher.call(frame);   // ← first-party stitching
 *     hostPostLogic(frame);
 *   }, [stitcher.call]);
 *
 * `useFrameProcessorDriver` keeps the legacy default-integration
 * shape (start / stop / isRunning) for the `<Camera>` component's
 * built-in non-AR path and for any host still using the v0.10.x API
 * directly.  No behavioural change for those callers.
 *
 * ## start / stop behaviour
 *
 *   - `start()` calls `stitcher.reset()` to zero the accumulated
 *     pose (preserves the pre-v0.11.0 "each capture starts with
 *     pose = (0, 0, 0)" contract).
 *   - `stop()` also resets the pose (idempotent; matches the
 *     pre-v0.11.0 stop() side effect of zeroing yaw / pitch / roll).
 *   - The gyro subscription itself is owned by `useStitcherWorklet`
 *     and runs for the lifetime of the hook.  In the default
 *     `<Camera>` integration this means gyro is on while the camera
 *     screen is mounted — same practical scope as pre-v0.11.0 in
 *     all observed host integrations (capture screens mount
 *     `<Camera>` for the duration of capture; idle screens don't).
 *
 * ## Pose synthesis / intrinsics / throttling
 *
 * Owned by `useStitcherWorklet`.  See that file's header for the
 * quaternion math, FoV-to-intrinsics derivation, throttle gate, and
 * pairing-with-IncrementalStitcher.start docs.
 */

import { useCallback, useMemo, useRef } from 'react';
import {
  useFrameProcessor,
} from 'react-native-vision-camera';
import type {
  ReadonlyFrameProcessor,
} from 'react-native-vision-camera';

import { useStitcherWorklet } from './useStitcherWorklet';


export interface UseFrameProcessorDriverOptions {
  /**
   * Gyro sample interval in ms (~30 Hz default).  Drives the JS-
   * thread pose integration loop; not the producer-thread plugin
   * call rate (the plugin runs at vision-camera's frame rate,
   * usually 30 fps).
   */
  gyroIntervalMs?: number;

  /**
   * Approximate horizontal FoV of the device camera, used to
   * synthesise `fx` from frame width.  Default 65° matches a typical
   * mid-tier smartphone main camera.  Host apps that know the actual
   * FoV (e.g. via `Camera.getCameraFormat`) should pass it here —
   * the engine's overlap gate gets a slightly better estimate.
   */
  fovHorizDegrees?: number;

  /**
   * Approximate vertical FoV of the device camera, used to
   * synthesise `fy` from frame height.  Default 50° matches a
   * typical 4:3 phone camera in landscape; for 16:9 portrait you
   * probably want ~75°.
   */
  fovVertDegrees?: number;

  /**
   * Evaluate the plugin every Nth producer-thread frame.  Default 1
   * (every frame).  Higher values reduce the producer-thread cost
   * linearly at the price of acceptance latency — N=3 with 30 fps
   * source = up to 100 ms before a key moment is evaluated.
   */
  evalEveryNFrames?: number;
}


export interface FrameProcessorDriverHandle {
  /** Reset pose accumulators + mark the driver as running.  Idempotent. */
  start: () => void;
  /** Reset pose + mark the driver as stopped.  Idempotent. */
  stop: () => void;
  /**
   * perf-3a change 2 — re-anchor the decimation grid (zero the frame
   * counter only, not pose). Call right AFTER the native `start()` await
   * resolves so the every-Nth grid anchors at native-ingest-enable, keeping
   * frame-identical decimation even though `start()` opened the gate before
   * the await. No-op in AR mode (the driver is never started).
   */
  resetCadence: () => void;
  /**
   * Pass this to `<Camera frameProcessor={...} />`.  `null` until
   * the JSI plugin is loaded (typically resolves within ~1 frame of
   * mount); the consumer should fall back to undefined / a no-op
   * processor in that window.
   */
  frameProcessor: ReadonlyFrameProcessor | null;

  /**
   * v0.24.3 — mirrors `useStitcherWorklet().acquisitionFailed`: `true`
   * when the frame-processor plugin can never be acquired in this build
   * (permanent), as opposed to `frameProcessor` merely being null during
   * the normal ~1-frame acquisition window.
   */
  acquisitionFailed: boolean;
  /** Whether `start()` has been called and `stop()` hasn't. */
  isRunning: boolean;
}


export function useFrameProcessorDriver(
  options: UseFrameProcessorDriverOptions = {},
): FrameProcessorDriverHandle {
  // v0.11.0 — delegate plugin / shared values / gyro / worklet body
  // to `useStitcherWorklet`.  This hook is now a thin wrapper that
  // binds the returned worklet via `useFrameProcessor` and exposes
  // the legacy lifecycle API.
  // perf-3a change 1 — the driver MANAGES the ingest gate: construct the
  // worklet gate-CLOSED, and open/close it from start()/stop(). While the
  // driver is stopped (idle preview between captures, and the stitch phase
  // after the host calls stop()), the worklet skips pose synthesis + the
  // JSI→JNI plugin dispatch entirely — the native AtomicBoolean would drop
  // those calls anyway, so this is pure per-frame savings on the producer
  // thread (the RN-0.79 cost). Bare `useStitcherWorklet()` users are
  // unaffected (they default gate-open).
  const stitcher = useStitcherWorklet({ ...options, initialIngestActive: false });

  const isRunningRef = useRef(false);

  const start = useCallback(() => {
    if (isRunningRef.current) return;
    stitcher.reset();
    stitcher.setActive(true);
    isRunningRef.current = true;
  }, [stitcher]);

  const stop = useCallback(() => {
    if (!isRunningRef.current) return;
    stitcher.setActive(false);
    stitcher.reset();
    isRunningRef.current = false;
  }, [stitcher]);

  // perf-3a change 2 — re-anchor the decimation grid at native-ingest-enable
  // (called by the host right after the native start() await). See the handle.
  const resetCadence = useCallback(() => {
    stitcher.resetCadence();
  }, [stitcher]);

  // ── Worklet binding ─────────────────────────────────────────────
  //
  // `stitcher.call` is itself a worklet (see `useStitcherWorklet`),
  // so we just forward each frame to it.  Memoised on
  // [stitcher.call] so the host's `<Camera>` doesn't see frame-
  // processor identity churn on every render — only when the
  // underlying plugin acquires (null → non-null).
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    stitcher.call(frame);
  }, [stitcher.call]);

  // Match pre-v0.11.0 contract: return `null` for `frameProcessor`
  // until the underlying JSI plugin has resolved.  `<Camera>` falls
  // back to `undefined` in the null window so vision-camera doesn't
  // try to bind an unready worklet.
  return useMemo<FrameProcessorDriverHandle>(() => ({
    start,
    stop,
    resetCadence,
    frameProcessor: stitcher.isReady ? frameProcessor : null,
    acquisitionFailed: stitcher.acquisitionFailed,
    get isRunning() { return isRunningRef.current; },
  }), [start, stop, resetCadence, frameProcessor, stitcher.isReady,
    stitcher.acquisitionFailed]);
}
