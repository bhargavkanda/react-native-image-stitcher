// SPDX-License-Identifier: Apache-2.0

import { useEffect, type DependencyList } from 'react';
import {
  useFrameProcessor as visionCameraUseFrameProcessor,
  type DrawableFrameProcessor,
  type Frame,
  type ReadonlyFrameProcessor,
} from 'react-native-vision-camera';

import { ensureStitcherProxyInstalled } from './ensureStitcherProxyInstalled';
import { StitcherWorkletRegistry } from './StitcherWorkletRegistry';
import type { StitcherFrameProcessor } from './StitcherFrame';

/**
 * Shape of the native-installed `globalThis.__stitcherProxy` host
 * object (iOS Phase 4b.i; Android Phase 4b.ii).  When present, the
 * hook prefers the native registry over the JS-side mirror — the
 * native AR worklet runtime reads from the native side directly.
 */
interface StitcherProxy {
  install(workletFn: StitcherFrameProcessor): string;
  uninstall(id: string): void;
  count(): number;
}

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
 * **AR mode — iOS Phase 4b.i (this release):** the worklet is
 * installed into the native registry via
 * `globalThis.__stitcherProxy.install(workletFn)`, where
 * `__stitcherProxy` is a JSI host object installed at lib
 * bootstrap by the native `StitcherJsiInstaller` module.  The
 * AR worklet runtime (`RNSARWorkletRuntime`) reads from the
 * native registry on each `dispatchFrame:pose:` call and fans
 * out invocations — your worklet fires alongside the lib's
 * first-party stitching path.
 *
 * **AR mode — Android Phase 4b.ii (deferred):** the native
 * installer + JNI bridge from `StitcherWorkletRuntime.kt`'s
 * `runFirstParty {...}` path to a parallel C++ registry land in
 * a follow-up release.  Until then, on Android the hook falls
 * back to the JS-side `StitcherWorkletRegistry`; AR-mode host
 * worklets register but do not invoke.  No regression vs.
 * Phase 4a; iOS gets the API first.
 *
 * ### When Phase 4b.ii lands (Android)
 *
 * The hook's call signature does NOT change.  Android hosts that
 * write code today against this API will see their worklets
 * start firing in AR mode automatically when Phase 4b.ii is
 * merged.  No migration required.
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

  // AR path: install into the native registry if available (iOS
  // Phase 4b.i — and Android Phase 4b.ii once it lands).  Falls
  // back to the JS-side `StitcherWorkletRegistry` when the native
  // installer isn't present (Android in 4b.i; remote debug mode;
  // unit tests).  The fallback path matches Phase 4a's
  // register-but-not-invoke semantics.
  //
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const nativeReady = ensureStitcherProxyInstalled();
    if (
      nativeReady &&
      typeof (globalThis as { __stitcherProxy?: StitcherProxy }).__stitcherProxy !== 'undefined'
    ) {
      // Native path — install through the JSI proxy.  Errors here
      // most commonly mean the worklet doesn't have the
      // `'worklet'` directive at the call site (the worklets-core
      // babel plugin didn't transform it).  Surface them via the
      // proxy's own throw with a host-side log so the failure is
      // obvious.
      let id: string | undefined;
      try {
        id = (globalThis as unknown as { __stitcherProxy: StitcherProxy }).__stitcherProxy.install(
          worklet,
        );
      } catch (err) {
        // Guard `__DEV__` read so the hook works in any environment
        // that imports it without defining the flag (jest, SSR,
        // custom tooling).
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.error(
            '[react-native-image-stitcher] __stitcherProxy.install ' +
              'threw — is the worklet function decorated with ' +
              "`'worklet';` and processed by react-native-worklets-core's " +
              'babel plugin?  Original error: ' +
              String(err),
          );
        }
        return; // No cleanup needed — nothing was installed.
      }
      return () => {
        try {
          (globalThis as unknown as { __stitcherProxy: StitcherProxy }).__stitcherProxy.uninstall(id!);
        } catch {
          // Uninstall is best-effort; an exception here means the
          // proxy was already gone (e.g., app reload mid-cleanup).
        }
      };
    }

    // Fallback — JS-side registry.  Same as Phase 4a.
    const jsId = StitcherWorkletRegistry.register({
      worklet,
      isFirstParty: false,
    });
    return () => StitcherWorkletRegistry.unregister(jsId);
  }, deps);

  return vcProcessor;
}
