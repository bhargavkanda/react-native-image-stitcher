// SPDX-License-Identifier: Apache-2.0
//
// v0.9.0 Layer 2 — throttle gate over v0.8.0's `useFrameProcessor`.
//
// ## What this is
//
// A thin wrapper around `useFrameProcessor` that enforces a maximum
// invocation rate (`sampleHz`) at the worklet layer.  The host's
// worklet fires up to `sampleHz` times per second; ticks too close
// together are dropped via a `useSharedValue<number>` monotonic-time
// gate inside the worklet body.
//
// ## When to use this (vs alternatives)
//
//   - **`useFrameProcessor` directly** — every camera frame (~30-60 Hz).
//     Use for true-realtime processing that wants to see every frame.
//   - **`useThrottledFrameProcessor`** (this hook) — sub-frame-rate
//     worklet-native processing.  The worklet runtime has direct
//     access to `frame.toArrayBuffer()`, `frame.arDepth`,
//     `frame.arAnchors`, and can call other vc Frame Processor plugins
//     (native OCR libraries, TFLite ML inference, etc.).  Results
//     bridged to JS via `runOnJS`.
//   - **`useFrameStream`** (Layer 3, also in this directory) —
//     sub-frame-rate JS-thread consumer.  The lib JPEG-encodes each
//     sample on the producer thread and delivers a `SampledFrame`
//     (file path + pose + dims) to a JS-thread callback.  Use for
//     file-path OCR libraries (RN modules wrapping ML Kit etc.),
//     cloud upload, thumbnail UI.
//
// ## Use-case mapping (canonical)
//
// | Use case                              | Layer | Why                              |
// |---------------------------------------|-------|----------------------------------|
// | OCR via Vision.framework / ML Kit     | **2** | native libs, bbox in frame coords|
// | TFLite ML detection (via vc plugin)   | **2** | same shape as OCR                |
// | LiDAR depth → 3D reconstruction       | **2** | depth too large to bridge        |
// | Pose-only telemetry                   | **2** | tiny payload, no encoding needed |
// | File-path OCR (RN module)             |   3   | host wants a JPEG, not pixels    |
// | Cloud upload (sampled JPEG feed)      |   3   | JPEG IS the payload              |
// | Live thumbnail preview UI             |   3   | `<Image source={{uri: ...}}>`    |
//
// See `docs/host-app-integration.md` § "Tier 2 + 3" for recipes.
//
// ## Threading
//
// The wrapped worklet fires on whatever runtime `useFrameProcessor`
// dispatches on:
//   - **Non-AR mode**: vision-camera's Frame Processor runtime
//     (producer thread).
//   - **AR mode**: the lib's `RNSARWorkletRuntime` (iOS) /
//     worklets-core default context (Android) — fired by the AR
//     session's per-frame dispatch.  See v0.8.0 Phase 4b.i / 4b.iii.
//
// Either way, the worklet MUST NOT block — the next frame's
// processing is gated on this one returning.  Long work belongs
// behind `runOnJS` / a separate worklet runtime.
//
// ## Behaviour at the throttle boundary
//
// The hook tracks a monotonic-time shared value of "last sample time".
// Each tick checks if `frame.timestamp - lastSampleMs.value >=
// (1000 / sampleHz)`.  If yes, the worklet body runs and the value
// updates; if no, the worklet returns silently.
//
// Edge cases:
//   - First-ever tick: `lastSampleMs.value` starts at 0; first frame's
//     timestamp will be >> 0 → first tick always fires.  Subsequent
//     ticks throttle as expected.
//   - vc v4 timestamp semantics: per the project's worklet-throttle
//     gotcha note, `frame.timestamp` is NOT reliably nanoseconds in
//     vc v4.  The hook treats `frame.timestamp` as ALREADY in
//     milliseconds (which is what vc v4 actually delivers; the
//     v0.8.0 StitcherFrame contract documents this).  If a future
//     vc version changes the unit, the throttle math here needs
//     re-checking.

import type { DependencyList } from 'react';
import { useSharedValue } from 'react-native-worklets-core';

import { useFrameProcessor } from './useFrameProcessor';
import type {
  StitcherFrame,
  StitcherFrameProcessor,
} from './StitcherFrame';
import type { ThrottledFrameProcessorOptions } from '../types';

/**
 * Throttled variant of `useFrameProcessor`.  See the module
 * docstring for the full use-case mapping; quick version:
 *
 * ```tsx
 * const fp = useThrottledFrameProcessor(
 *   (frame) => {
 *     'worklet';
 *     // worklet-native OCR / ML / depth processing here
 *   },
 *   { sampleHz: 2 },
 *   [],
 * );
 * return <Camera frameProcessor={fp} ... />;
 * ```
 *
 * @param worklet  Host's frame-processor worklet.  Must be
 *                 `'worklet'`-prefixed.  Runs at most `sampleHz`
 *                 times per second.
 * @param options  `{ sampleHz }` — clamped to `[0.5, 30]`.
 * @param deps     Standard React deps array.  Treated the same as
 *                 `useFrameProcessor`'s deps — when they change the
 *                 inner worklet is re-bound.
 *
 * @returns A `useFrameProcessor`-shaped processor object, pass it
 *          to `<Camera frameProcessor={...}>`.
 */
export function useThrottledFrameProcessor(
  worklet: StitcherFrameProcessor,
  options: ThrottledFrameProcessorOptions,
  deps: DependencyList,
): ReturnType<typeof useFrameProcessor> {
  // Clamp + derive interval.  Done outside the worklet so the
  // useSharedValue / useFrameProcessor hooks see stable values.
  const sampleHz = Math.max(0.5, Math.min(30, options.sampleHz));
  const minIntervalMs = 1000 / sampleHz;

  // Monotonic-time gate.  Initialised to 0 → first tick always
  // fires (frame.timestamp >> 0).
  const lastSampleMs = useSharedValue(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useFrameProcessor(
    (frame: StitcherFrame) => {
      'worklet';
      const now = frame.timestamp;
      if (now - lastSampleMs.value < minIntervalMs) {
        return;
      }
      lastSampleMs.value = now;
      worklet(frame);
    },
    // The throttle interval is captured in the worklet closure; if
    // it changes we need to re-bind the worklet so the new
    // `minIntervalMs` takes effect.  Same for the host's worklet
    // identity (so deps changes on the host side re-bind too).
    [minIntervalMs, worklet, ...deps],
  );
}
