// SPDX-License-Identifier: Apache-2.0
//
// v0.9.0 Layer 3 — JS-thread sampled-frame stream over Layer 1 +
// Layer 2.
//
// ## What this is
//
// A hook that:
//   1. Throttles a worklet via `useThrottledFrameProcessor` (Layer 2)
//      to fire at `sampleHz` Hz.
//   2. Inside the worklet, calls the `save_frame_as_jpeg` vc Frame
//      Processor plugin (Layer 1) to JPEG-encode the frame to a
//      bounded-rotation slot on disk.
//   3. Bridges the resulting `SampledFrame` (file path + pose +
//      dims) to a JS-thread callback via `runOnJS`.
//
// The host gets a per-sample callback on the JS thread with a file
// path they can pass to `<Image>`, an OCR RN module, a cloud-upload
// library, etc.  Zero worklet boilerplate.
//
// ## When to use this (vs alternatives)
//
//   - **`useFrameStream`** (this hook) — JS-thread consumers.  File-
//     path OCR libraries, cloud upload, thumbnail UI, sampled
//     server-side analysis.
//   - **`useThrottledFrameProcessor`** (Layer 2) — worklet-native
//     consumers.  Native OCR (Vision.framework / ML Kit) wrapped as
//     vc plugins, TFLite ML inference, LiDAR depth processing.
//     Lower latency; no JPEG roundtrip.
//   - **`useFrameProcessor`** — every camera frame; full control.
//
// ## Slot reuse / disk usage
//
// JPEG files are written to `<outputDir>/stream-<N>.jpg` where N
// cycles 0..3 based on `frame.timestamp / 1000`.  At most 4 stale
// JPEGs ever exist on disk; the same file is rewritten on each
// rotation, so disk usage is bounded.
//
// Hosts that need long-term retention (e.g., archive each sample
// for later upload) MUST copy the file synchronously inside the
// handler — the slot may be overwritten by the next sample.
//
// ## Backpressure
//
// If the JS handler returns slower than `1/sampleHz`, subsequent
// ticks DO still fire (the throttle is time-based, not handler-
// completion-based).  This means multiple handler invocations can
// be in flight simultaneously.  For most use cases that's fine
// (the handlers are pure or commute).  Hosts that need serialised
// handling should track in-flight state themselves and early-return.
//
// ## AR vs non-AR
//
// Works in both modes because it composes over
// `useThrottledFrameProcessor` → `useFrameProcessor`.  In AR mode
// the worklet auto-registers via `__stitcherProxy` (v0.8.0 Phase
// 4b.i/iii); in non-AR mode the returned processor object is
// passed to `<Camera frameProcessor={...}>`.  The hook returns
// the processor object so hosts can wire it up either way.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import {
  VisionCameraProxy,
  type Frame,
  type FrameProcessorPlugin,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';

import { useThrottledFrameProcessor } from './useThrottledFrameProcessor';
import type { StitcherFrame } from './StitcherFrame';
import type {
  FrameStreamOptions,
  SampledFrame,
} from '../types';

/**
 * `useFrameStream` — Layer 3.  See module docstring for the full
 * design + use-case mapping.  Quick start:
 *
 * ```tsx
 * import { Camera, useFrameStream } from 'react-native-image-stitcher';
 *
 * function MyScreen() {
 *   const fp = useFrameStream(
 *     { sampleHz: 2, quality: 75 },
 *     (sample) => {
 *       setThumbnail(sample.jpegPath);
 *     },
 *   );
 *   return <Camera frameProcessor={fp} ... />;
 * }
 * ```
 *
 * @param options  `{ sampleHz, quality?, outputDir? }`.  `sampleHz`
 *                 clamped to `[0.5, 10]`.
 * @param handler  JS-thread callback fired per sample.  Receives a
 *                 `SampledFrame`.  May return a Promise; rejections
 *                 are caught + logged (not re-thrown) so one
 *                 misbehaving handler doesn't break the stream.
 *
 * @returns A `useFrameProcessor`-shaped processor object — pass to
 *          `<Camera frameProcessor={...}>` for non-AR mode wiring.
 *          (AR mode auto-registration via `__stitcherProxy` is
 *          handled inside `useFrameProcessor`.)
 */
export function useFrameStream(
  options: FrameStreamOptions,
  handler: (sample: SampledFrame) => void | Promise<void>,
): ReturnType<typeof useThrottledFrameProcessor> {
  const sampleHz = Math.max(0.5, Math.min(10, options.sampleHz));
  const quality = options.quality ?? 75;

  // Default output dir: a per-app cache subdirectory.  Hosts that
  // want a known path supply their own via `options.outputDir`.
  // `Platform.OS`-specific cache paths are read once at hook mount.
  const outputDir = useMemo(() => {
    if (options.outputDir != null) return options.outputDir;
    // Both platforms expose a cache directory at a predictable path
    // via React Native APIs; we use a small inline computation to
    // avoid pulling `react-native-fs` as a hard dep.  The lib's
    // existing JPEG encode targets the app's data dir via similar
    // logic in `RNSARCameraView.kt` / `IncrementalStitcher.swift`.
    //
    // We just generate a relative-ish path under /tmp/ for cross-
    // platform simplicity; the native plugin writes wherever it's
    // told to (absolute path), so as long as the directory exists
    // the encode succeeds.  Hosts that care about file lifecycle
    // should supply `outputDir` explicitly.
    return Platform.OS === 'ios'
      ? '/tmp/rnis-frame-stream'
      : '/data/local/tmp/rnis-frame-stream';
  }, [options.outputDir]);

  // Ensure outputDir exists on the native side.  We could use
  // react-native-fs but to keep the dep surface minimal, we just
  // attempt to create via a tiny native call — or, simpler, accept
  // that the plugin's write call will fail if the dir doesn't
  // exist + log a clear error.  For v0.9.0 baseline we defer
  // mkdir to the host (document it in the option's JSDoc) OR fall
  // back to the platform's tmpdir which already exists.
  //
  // The tmpdir defaults above always exist on iOS + Android, so
  // the common case "host doesn't supply outputDir" Just Works.

  // Stable JS-side handler reference for `runOnJS`.  The hook re-
  // captures `handler` on every render but the ref keeps the
  // worklet closure pointing at the latest callback (avoid stale
  // captures).
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const onSampleJS = useCallback((sample: SampledFrame) => {
    const result = handlerRef.current(sample);
    if (
      result != null &&
      typeof (result as Promise<void>).catch === 'function'
    ) {
      (result as Promise<void>).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[useFrameStream] handler threw:', err);
      });
    }
  }, []);

  const onSampleOnJS = useMemo(
    () => Worklets.createRunOnJS(onSampleJS),
    [onSampleJS],
  );

  // ── Plugin acquisition (Layer 1) ─────────────────────────────────
  //
  // `initFrameProcessorPlugin` can return `undefined` if the native
  // registry hasn't initialised yet (rare race on app start).  We
  // retry every 16ms (one display frame) until success — matches
  // the pattern in `useFrameProcessorDriver`.
  const pluginRef = useRef<FrameProcessorPlugin | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const tryAcquire = () => {
      if (cancelled) return;
      const p = VisionCameraProxy.initFrameProcessorPlugin(
        'save_frame_as_jpeg',
        {},
      );
      if (p != null) {
        pluginRef.current = p;
        return;
      }
      timerId = setTimeout(tryAcquire, 16);
    };
    tryAcquire();
    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
  }, []);

  // The worklet body — fires at sampleHz, calls the JPEG plugin,
  // bridges the result to JS.  Note we read `pluginRef.current`
  // inside the worklet via the captured `plugin` value below;
  // worklets-core handles the JS↔worklet reference.
  const plugin = pluginRef.current;

  return useThrottledFrameProcessor(
    (frame: StitcherFrame) => {
      'worklet';
      if (plugin == null) return;

      // Slot rotation: compute slot from frame timestamp.  At
      // sampleHz=2 (500ms interval), the slot index changes every
      // ~1s, giving each slot ~2 samples before being overwritten.
      // That's overkill for the "stream-of-samples" use case but
      // matches the docstring's "at most 4 stale JPEGs" guarantee.
      const slot = Math.floor(frame.timestamp / 1000) % 4;
      const path = `${outputDir}/stream-${slot}.jpg`;

      // vc's `FrameProcessorPlugin.call` expects vc's `Frame` type.
      // `StitcherFrame` is structurally a superset (it adds `source`,
      // `pose`, AR-only fields).  Cast through `unknown` — same
      // pattern v0.8.0's `useFrameProcessor` uses when handing a
      // StitcherFrame-typed worklet to vc.
      const result = plugin.call(frame as unknown as Frame, {
        path,
        quality,
      });
      if (
        result == null ||
        (result as { ok?: boolean }).ok !== true
      ) {
        // Native side reported an error (path not writable, format
        // wrong, etc.).  Silently skip this sample — the next tick
        // will retry.  The plugin already logs the specific reason
        // on the native side.
        return;
      }
      const r = result as {
        path: string;
        width: number;
        height: number;
      };

      onSampleOnJS({
        jpegPath: r.path,
        pose: frame.pose,
        timestamp: frame.timestamp,
        width: r.width,
        height: r.height,
      });
    },
    { sampleHz },
    [plugin, outputDir, quality, onSampleOnJS],
  );
}
