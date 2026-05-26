// SPDX-License-Identifier: Apache-2.0

import { useEffect, type DependencyList } from 'react';
import {
  useFrameProcessor as visionCameraUseFrameProcessor,
  type DrawableFrameProcessor,
  type Frame,
  type ReadonlyFrameProcessor,
} from 'react-native-vision-camera';

import { StitcherWorkletRegistry } from './StitcherWorkletRegistry';
import type { StitcherFrameProcessor } from './StitcherFrame';

/**
 * v0.8.0 Phase 4a — public hook for hosts to attach a per-frame
 * worklet that runs in BOTH AR and non-AR capture modes.
 *
 * ## Quick start
 *
 * ```tsx
 * import { useFrameProcessor, type StitcherFrame } from 'react-native-image-stitcher';
 *
 * function MyOcrOverlay() {
 *   const processor = useFrameProcessor((frame: StitcherFrame) => {
 *     'worklet';
 *     // Pixel data is in `frame.toArrayBuffer()`.
 *     // AR-only fields: `frame.arDepth`, `frame.arAnchors`, `frame.arTrackingState`.
 *     // Discriminate via `frame.source === 'ar'` / `'vc'`.
 *   }, []);
 *   return <Camera frameProcessor={processor} ... />;
 * }
 * ```
 *
 * ## Two behaviours, depending on mode
 *
 * **Non-AR mode (today, fully working):** the worklet runs on
 * vision-camera's Frame Processor runtime.  Same thread + same
 * cost envelope as a plain `useFrameProcessor` from
 * `react-native-vision-camera`.  The lib's own first-party
 * stitching plugin runs alongside on the same producer-thread
 * runtime (composition is handled by vision-camera's own dispatch
 * order).
 *
 * Your worklet receives whatever vision-camera delivers — vc's raw
 * `Frame`.  This is a structural subset of `StitcherFrame`: the
 * vc-shaped fields (`width`, `height`, `pixelFormat`, `orientation`,
 * `timestamp`, `toArrayBuffer`) are guaranteed; the
 * `StitcherFrame`-only fields (`source`, `pose`, `arDepth`,
 * `arAnchors`, `arTrackingState`) are **undefined** at runtime
 * because the lib does NOT wrap or augment vc's `Frame` in Phase 4a
 * (cross-worklet-boundary field injection is Phase 4b work).
 * Worklets that need to read `source` / `pose` MUST guard for
 * `undefined`:
 *
 * ```ts
 * if (frame.source === 'ar') { ... }   // false in non-AR mode
 * if (frame.pose) { ... }              // skipped in non-AR mode
 * ```
 *
 * **AR mode (Phase 4a — REGISTERED BUT NOT YET INVOKED):** the
 * worklet is recorded in the `StitcherWorkletRegistry` singleton.
 * The v0.8.0 `RNSARWorkletRuntime` / `StitcherWorkletRuntime`
 * (Phase 3b/3c) dispatch infrastructure exists, but the
 * cross-runtime handoff (JS-side registry → native runtime
 * iteration → `WorkletInvoker::call`) is Phase 4b work.  Until
 * Phase 4b ships, an AR-mode capture will NOT invoke
 * host-supplied worklets — only the lib's first-party stitching
 * runs.
 *
 * ### When Phase 4b lands
 *
 * The hook's call signature does NOT change.  Hosts that write
 * code today against this Phase-4a API will see their worklets
 * start firing in AR mode automatically when Phase 4b is merged.
 * No migration required.
 *
 * ## Frame contract
 *
 * The worklet receives a {@link StitcherFrame} (see
 * `src/stitching/StitcherFrame.ts` for the full contract +
 * lifecycle).  Highlights:
 *
 *   - **`source`** discriminator: `'vc'` or `'ar'`.  Branch on this
 *     before reading `arDepth` / `arAnchors` / `arTrackingState`
 *     so non-AR captures don't break.
 *   - **`pose`** always present.  `pose.translation` is `undefined`
 *     in non-AR mode (gyro provides only rotation; no spatial
 *     anchor).
 *   - **Buffer lifetime**: pixel data is valid only for the
 *     duration of the worklet call.  Worklets that need to retain
 *     data must `toArrayBuffer()` synchronously inside the
 *     worklet body — returning a reference and reading it later
 *     reads freed memory.
 *
 * ## Threading
 *
 * The worklet runs on the producer thread (vision-camera's
 * runtime in non-AR mode; the AR-session callback thread under
 * Phase 4b).  Worklets MUST NOT block the producer thread for
 * more than a few ms — the next frame's processing is gated on
 * the previous frame returning.  Long work belongs on a queue
 * crossed via Reanimated / worklets-core's `runOnJS`.
 *
 * @param worklet  The host's frame processor function.  Must be
 *                 `'worklet'`-prefixed at the call site.  TS
 *                 cannot enforce the prefix; the runtime will
 *                 throw at attempt to invoke a non-worklet
 *                 function.
 * @param deps     Standard React deps array.  When `deps` change,
 *                 the previous registration is removed and the
 *                 new worklet is registered.  Same semantics as
 *                 vision-camera's `useFrameProcessor`.
 *
 * @returns A vision-camera frame-processor object that
 *          `<Camera frameProcessor={...}>` accepts.  In non-AR
 *          mode this is what drives the per-frame worklet
 *          invocation; in AR mode it's currently a no-op (vc
 *          isn't mounted in AR mode anyway).
 */
export function useFrameProcessor(
  worklet: StitcherFrameProcessor,
  deps: DependencyList,
): ReadonlyFrameProcessor | DrawableFrameProcessor {
  // Non-AR path: delegate to vision-camera's hook.  The returned
  // processor object is what `<Camera>` hands to vc.  Worklet
  // fires on vc's producer-thread runtime.
  //
  // Cast rationale: vc's hook expects `(frame: Frame) => void`.
  // Our worklet is typed `(frame: StitcherFrame) => void`.
  // `StitcherFrame` is a structural superset of `Frame` (it adds
  // required `source` + `pose` and the optional AR fields), so
  // assigning a function that consumes `StitcherFrame` to a
  // `Frame`-consuming slot is unsound at the type level — TS is
  // right to reject the direct assignment.  At RUNTIME the worklet
  // will see vc's raw `Frame`; the `source` / `pose` / AR fields
  // are undefined (the hook's docstring above documents this and
  // tells hosts to guard).  We double-cast through `unknown` to
  // suppress, accepting the explicit type-system gap as the price
  // of Phase 4a's pre-Phase-4b deferral on cross-runtime frame
  // wrapping.
  const vcProcessor = visionCameraUseFrameProcessor(
    worklet as unknown as (frame: Frame) => void,
    deps,
  );

  // AR path: register the same worklet in our singleton registry.
  // Phase 4a stops here — the registry knows about the worklet
  // but the native AR runtime doesn't iterate it yet.  Phase 4b
  // will wire the cross-runtime handoff.
  //
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = StitcherWorkletRegistry.register({
      worklet,
      isFirstParty: false,
    });
    return () => StitcherWorkletRegistry.unregister(id);
  }, deps);

  return vcProcessor;
}
