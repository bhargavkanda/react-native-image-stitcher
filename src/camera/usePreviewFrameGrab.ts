// SPDX-License-Identifier: Apache-2.0
/**
 * usePreviewFrameGrab — JS half of the preview-frame grab primitive
 * behind `CameraHandle.captureTorchPair()` (torch-differential probe
 * v3).  The hook + native accessor are internal; the two option/result
 * types at the top are the PUBLIC `captureTorchPair` surface
 * (re-exported from `src/index.ts`), mirroring how `exposureBurst.ts`
 * hosts `ExposureBurstOptions` / `ExposureBurstResult`.
 *
 * Two cooperating pieces:
 *
 *   1. `getPreviewFrameGrabberModule()` — the
 *      `NativeModules.RNISPreviewFrameGrabber` accessor.  Its `grab()`
 *      arms a ONE-SHOT native request (with its own native timeout)
 *      and resolves with the JPEG path once a preview frame services
 *      it.
 *   2. `usePreviewFrameGrab()` — acquires the `grab_preview_frame`
 *      vc Frame Processor plugin and binds the minimal worklet that
 *      drives it.  `<Camera>` attaches this worklet IN PLACE OF the
 *      regular non-AR processor only while a torch-pair capture is in
 *      flight (~600 ms), then restores.  The worklet closes over
 *      nothing but the plugin handle — no shared values, no runOnJS —
 *      so each producer-thread call is a single native armed-check
 *      when no grab is pending.
 *
 * Plugin acquisition mirrors `useStitcherWorklet`'s 16 ms retry loop
 * (the registry can lag `initFrameProcessorPlugin` at cold start), but
 * CAPS retries at ~5 s: if the plugin never appears (host binary
 * predates it, or vision-camera is absent), `isReady` stays false and
 * `captureTorchPair()` rejects with TORCH_PAIR_UNAVAILABLE instead of
 * retrying forever — consumers are expected to fall back (e.g. to a
 * still-photo torch pair).
 */

import { useEffect, useState } from 'react';
import { NativeModules } from 'react-native';
import {
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import type {
  FrameProcessorPlugin,
  ReadonlyFrameProcessor,
} from 'react-native-vision-camera';


/** Options for {@link CameraHandle.captureTorchPair}. */
export interface CaptureTorchPairOptions {
  /**
   * How long to hold the torch ON before grabbing the second frame,
   * in ms.  Default 250, clamped to [80, 2000].  Measured from the
   * torch REQUEST (React commit + LED ramp eat ~50-150 ms of it), so
   * the actual lit window is shorter — the whole point is staying
   * well inside auto-exposure's convergence time, unlike a still-photo
   * pair whose ~1 s inter-shot gap lets AE partially compensate.
   */
  settleMs?: number;
  /**
   * Long-edge downscale budget (px) for the two saved JPEGs.  Default
   * 1280; `0` saves at source video-stream resolution.  The torch-pair
   * scorer reads 256×256 luma grids, so 1280 is already generous.
   */
  maxLongEdge?: number;
  /** JPEG quality 1-100 for both frames.  Default 80. */
  quality?: number;
}


/** Result of {@link CameraHandle.captureTorchPair}. */
export interface TorchPairResult {
  /** `file://` URI of the torch-OFF preview frame (grabbed first). */
  offUri: string;
  /** `file://` URI of the torch-ON preview frame. */
  onUri: string;
  /**
   * SOURCE video-stream dimensions in px (pre-downscale, sensor
   * orientation) — both frames come from the same running stream, so
   * one pair of dims describes both files' aspect.
   */
  width: number;
  height: number;
  /**
   * Wall-clock ms between the two grabs resolving (off-frame →
   * on-frame).  ≈ torch actuation + `settleMs` + one frame interval;
   * consumers can sanity-check the pair really was captured fast.
   */
  gapMs: number;
}


/** Native result of one armed grab (bare path, source-stream dims). */
export interface PreviewFrameGrabResult {
  path: string;
  width: number;
  height: number;
}

export interface PreviewFrameGrabOptions {
  /** Long-edge downscale budget for the saved JPEG.  0 = source res. */
  maxLongEdge?: number;
  /** JPEG quality 1-100. */
  quality?: number;
  /** Native reject window if no frame services the request. */
  timeoutMs?: number;
}

interface PreviewFrameGrabberModule {
  grab(options: PreviewFrameGrabOptions): Promise<PreviewFrameGrabResult>;
}


/**
 * Resolve the native grabber module, or `null` when it isn't
 * registered (host binary predates v0.22.0).  Same defensive shape as
 * the other `NativeModules` accessors in this lib.
 */
export function getPreviewFrameGrabberModule(): PreviewFrameGrabberModule | null {
  const m = (NativeModules as Record<string, unknown>).RNISPreviewFrameGrabber;
  if (m == null || typeof (m as { grab?: unknown }).grab !== 'function') {
    return null;
  }
  return m as PreviewFrameGrabberModule;
}


const PLUGIN_RETRY_MS = 16;
const PLUGIN_RETRY_DEADLINE_MS = 5000;


export interface PreviewFrameGrabHandle {
  /**
   * The worklet to attach to vision-camera while a grab sequence is in
   * flight.  `null` until the JSI plugin acquires (or never, if it
   * can't — see `isReady`).
   */
  frameProcessor: ReadonlyFrameProcessor | null;
  /** True once the `grab_preview_frame` plugin has resolved. */
  isReady: boolean;
}


export function usePreviewFrameGrab(): PreviewFrameGrabHandle {
  const [plugin, setPlugin] = useState<FrameProcessorPlugin | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + PLUGIN_RETRY_DEADLINE_MS;
    const tryAcquire = () => {
      if (cancelled) return;
      let p: FrameProcessorPlugin | undefined;
      try {
        p = VisionCameraProxy.initFrameProcessorPlugin(
          'grab_preview_frame',
          {},
        );
      } catch {
        // Registry not ready / vc missing — treat like "not yet".
        p = undefined;
      }
      if (p != null) {
        setPlugin(p);
        return;
      }
      if (Date.now() >= deadline) return; // give up; isReady stays false
      timerId = setTimeout(tryAcquire, PLUGIN_RETRY_MS);
    };
    tryAcquire();
    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
  }, []);

  // Minimal worklet: forward every frame to the plugin, which no-ops
  // (one atomic read) unless a grab is armed.  Captures ONLY `plugin`.
  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      if (plugin == null) return;
      plugin.call(frame);
    },
    [plugin],
  );

  return {
    frameProcessor: plugin != null ? frameProcessor : null,
    isReady: plugin != null,
  };
}
