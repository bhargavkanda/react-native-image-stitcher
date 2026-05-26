// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';

import {
  subscribeIncrementalState,
  type AcceptedKeyframe,
  type IncrementalState,
} from './incremental';

/**
 * v0.7.0 — Tier 1: subscribe to accepted-keyframe events while a
 * panorama is in progress.
 *
 * Fires once per keyframe accepted by the stitching engine — typically
 * 4-6 times per panorama, NOT per camera frame.  Use for low-frequency
 * per-keyframe host work such as OCR on the saved JPEG, packet
 * detection, server-side analysis, or analytics.
 *
 * For mid-frequency frame access (sampled stream), see `useFrameStream`
 * (v0.9.0+).  For per-frame worklet access (~30 Hz), see
 * `useFrameProcessor` (v0.8.0+).
 *
 * ## Engine-mode caveat (v0.7.0)
 *
 * Only the `batch-keyframe` engine emits these events.  Live engines
 * (`firstwins-rectilinear`, `hybrid`, `slitscan-*`) paint into a live
 * canvas instead of saving per-accept JPEGs, and do not surface accept
 * events through this channel — the hook silently does not fire when
 * such an engine is active.  A v0.7.1 follow-up may add live-engine
 * accept emit if a real consumer needs it.
 *
 * ## Payload
 *
 * The handler receives an {@link AcceptedKeyframe}:
 *
 *   - `jpegPath`: absolute filesystem path, no `file://` prefix.  The
 *     JPEG is the engine's own copy under the active capture's session
 *     directory.  It persists for the lifetime of the panorama and is
 *     cleaned up automatically when the panorama finalises or is
 *     abandoned (or via explicit `cleanupOldKeyframes`).  Copy
 *     synchronously inside the handler if long-term retention is
 *     needed.
 *   - `pose`: rotation quaternion (always present) + optional
 *     translation vector (populated in AR mode; undefined in non-AR).
 *   - `timestamp`: milliseconds since the Unix epoch.
 *   - `index`: zero-based keyframe position in the current panorama.
 *
 * ## Lifecycle
 *
 * Re-subscribes on `handler` identity changes.  Wrap the handler in
 * `useCallback` if it closes over state or props you don't want to
 * trigger re-subscription on every render.
 *
 * Async handlers are fire-and-forget.  Rejected promises are caught
 * and logged via `console.error`; no backpressure on the native side.
 * Host code wanting to serialise work across keyframes should manage
 * that itself (e.g., push into a queue + worker).
 *
 * ## Example
 *
 * ```tsx
 * import { useCallback } from 'react';
 * import { useKeyframeStream } from 'react-native-image-stitcher';
 *
 * function OcrPlugin() {
 *   useKeyframeStream(
 *     useCallback(async (kf) => {
 *       const text = await runOCR(kf.jpegPath);
 *       console.log(`Keyframe ${kf.index} pose=${kf.pose.rotation}:`, text);
 *     }, []),
 *   );
 *   return null;
 * }
 * ```
 */
export function useKeyframeStream(
  handler: (keyframe: AcceptedKeyframe) => void | Promise<void>,
): void {
  useEffect(() => {
    const sub = subscribeIncrementalState((state: IncrementalState) => {
      // The `batch-keyframe` engine emits four optional fields together
      // on accept events.  Non-accept emits (snapshot updates,
      // refinement progress, live-engine state ticks, etc.) leave
      // `batchKeyframeThumbnailPath` undefined — that's our
      // accept-event sentinel.
      const jpegPath = state.batchKeyframeThumbnailPath;
      const index = state.batchKeyframeIndex;
      if (jpegPath === undefined || index === undefined) {
        return;
      }

      // `batchKeyframePose` + `batchKeyframeAcceptedAtMs` are
      // populated alongside the path + index by the post-v0.7.0
      // native emit.  Defensive defaults guard against a host
      // running on a slightly-older native binary (e.g., during a
      // partial upgrade) — identity quaternion + `Date.now()`.
      // Published v0.7.0 native always populates both.
      const pose = state.batchKeyframePose ?? {
        rotation: [0, 0, 0, 1] as [number, number, number, number],
      };
      const timestamp = state.batchKeyframeAcceptedAtMs ?? Date.now();

      const keyframe: AcceptedKeyframe = {
        jpegPath,
        pose,
        timestamp,
        index,
      };

      // Fire-and-forget.  Async handler rejections are surfaced via
      // console.error so they don't disappear into the void.
      const result = handler(keyframe);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[useKeyframeStream] handler threw:', err);
        });
      }
    });
    // `subscribeIncrementalState` returns null when the native module
    // isn't linked (Expo Go, unit tests without the bridge, etc.).
    // In that case we have nothing to clean up.
    if (sub === null) return;
    return () => sub.remove();
  }, [handler]);
}
