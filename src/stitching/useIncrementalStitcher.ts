/**
 * useIncrementalStitcher — React hook driving the live panorama
 * engine.
 *
 * Lifecycle:
 *   1. Host calls `useARSession().start()` to put the AR session in
 *      tracking mode.  (Works for AR-supported devices only — non-AR
 *      fallback comes in a later phase.)
 *   2. Host calls `start()` from this hook.  The native engine
 *      registers itself as the AR session's frame consumer.
 *   3. Native emits a state event for every ARFrame the engine
 *      processes (~60 Hz, mostly trivially-skipped).  The hook
 *      mirrors this into React state so a `<IncrementalStitcherView>`
 *      or any other consumer can render the live panorama + UX hints.
 *   4. Host calls `finalize(outputPath)` when the user releases the
 *      shutter; resolves with the final panorama path + stats.
 *   5. Host calls `cancel()` if the user dismisses the capture.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getIncrementalNativeModule,
  incrementalStitcherIsAvailable,
  subscribeIncrementalState,
  IncrementalOutcome,
  type IncrementalState,
  type IncrementalStartOptions,
  type IncrementalFinalizeResult,
} from './incremental';


export type IncrementalHint =
  | 'slow-down'
  | 'scene-uniform'
  | 'alignment-lost'
  | 'tracking-poor'
  | null;


export interface UseIncrementalStitcherReturn {
  /** Whether the native engine is registered.  False = no fallback wiring. */
  isAvailable: boolean;
  /** True between successful `start()` and `finalize()`/`cancel()`. */
  isRunning: boolean;
  /** Latest state pushed by the native engine, or null pre-start. */
  state: IncrementalState | null;
  /**
   * Convenience: which UX hint to show, derived from the latest
   * state.outcome.  null when nothing should be shown (silent
   * accepts, skips inside the overlap window).
   */
  hint: IncrementalHint;
  /**
   * Convenience: 'high' | 'medium' | null based on the last accept.
   * Drives confidence-ring rendering in the live preview.
   */
  confidenceLevel: 'high' | 'medium' | null;
  /** Begin a new capture.  Throws if the AR session isn't running. */
  start: (options?: IncrementalStartOptions) => Promise<void>;
  /**
   * End the capture and write the final panorama.  When `outputPath`
   * is omitted or empty, the native side picks a path under the
   * app's tmp directory and returns it in the result.
   */
  finalize: (outputPath?: string, quality?: number) => Promise<IncrementalFinalizeResult>;
  /** Abort the capture without producing output. */
  cancel: () => Promise<void>;
}


/**
 * Map raw outcome → user-facing hint string.  null = no banner.
 */
function outcomeToHint(outcome: IncrementalOutcome): IncrementalHint {
  switch (outcome) {
    case IncrementalOutcome.RejectedTooFar:
      return 'slow-down';
    case IncrementalOutcome.RejectedSceneUniform:
      return 'scene-uniform';
    case IncrementalOutcome.RejectedAlignmentLost:
      return 'alignment-lost';
    case IncrementalOutcome.SkippedTrackingPoor:
      return 'tracking-poor';
    case IncrementalOutcome.AcceptedHigh:
    case IncrementalOutcome.AcceptedMedium:
    case IncrementalOutcome.SkippedTooClose:
    default:
      return null;
  }
}


function outcomeToConfidence(
  outcome: IncrementalOutcome,
): 'high' | 'medium' | null {
  if (outcome === IncrementalOutcome.AcceptedHigh) return 'high';
  if (outcome === IncrementalOutcome.AcceptedMedium) return 'medium';
  return null;
}


export function useIncrementalStitcher(): UseIncrementalStitcherReturn {
  const native = getIncrementalNativeModule();
  const isAvailable = incrementalStitcherIsAvailable();
  const [isRunning, setIsRunning] = useState(false);
  const [state, setState] = useState<IncrementalState | null>(null);

  // Keep the latest hint/confidence sticky for a few frames after a
  // skip — otherwise the UI flickers since SkippedTooClose returns
  // a "silent" outcome between every accept.  We collapse this by
  // only updating hint when the new outcome is itself a hint or an
  // accept, leaving non-hint skips alone.
  const lastHintRef = useRef<IncrementalHint>(null);

  // Subscribe to native events on mount.  The subscription itself
  // is cheap; the native side gates `hasListeners` so events are
  // only emitted when JS is listening.
  useEffect(() => {
    if (!native) return undefined;
    const sub = subscribeIncrementalState((nextState) => {
      // Sticky-snapshot merge: the native side emits a state event
      // for EVERY ARFrame the engine processes (~60 Hz), most of
      // which are SkippedTooClose with NO snapshot path.  A naive
      // `setState(nextState)` would wipe the panoramaPath to null
      // 60 times per second, blanking the live preview between
      // accepts.  Keep the last-good snapshot fields so the PiP
      // shows the most recent panorama continuously between accepts;
      // other fields (outcome, confidence, hint) update normally.
      setState((prev) => {
        if (!nextState.panoramaPath && prev?.panoramaPath) {
          return {
            ...nextState,
            panoramaPath: prev.panoramaPath,
            width: prev.width,
            height: prev.height,
          };
        }
        return nextState;
      });
      const newHint = outcomeToHint(nextState.outcome);
      if (newHint !== null) {
        lastHintRef.current = newHint;
      } else if (
        nextState.outcome === IncrementalOutcome.AcceptedHigh ||
        nextState.outcome === IncrementalOutcome.AcceptedMedium
      ) {
        // An accept clears any prior hint — operator's back on track.
        lastHintRef.current = null;
      }
      // Else: SkippedTooClose etc. — leave the hint alone.
    });
    return () => sub?.remove();
  }, [native]);

  const start = useCallback(
    async (options: IncrementalStartOptions = {}) => {
      if (!native) {
        throw new Error(
          'useIncrementalStitcher: RetaiLensIncrementalStitcher native '
          + 'module is not registered.  Ensure the SDK pod has been '
          + 'rebuilt against the host app.',
        );
      }
      await native.start(options);
      setIsRunning(true);
      setState(null);
      lastHintRef.current = null;
    },
    [native],
  );

  const finalize = useCallback(
    async (
      outputPath?: string,
      quality = 90,
    ): Promise<IncrementalFinalizeResult> => {
      if (!native) {
        throw new Error('useIncrementalStitcher: native module unavailable');
      }
      const result = await native.finalize({
        outputPath: outputPath ?? '',
        quality,
      });
      setIsRunning(false);
      // Clear React state on finalize so the next start doesn't
      // briefly show stale frame counts / hint banners from the
      // previous capture.  Without this, the IncrementalStitcherView
      // displayed acceptedCount from the prior pan if a late event
      // had already updated state.
      setState(null);
      lastHintRef.current = null;
      return result;
    },
    [native],
  );

  const cancel = useCallback(async () => {
    if (!native) return;
    await native.cancel();
    setIsRunning(false);
    setState(null);
    lastHintRef.current = null;
  }, [native]);

  // Cleanup-on-unmount that actually works.  The previous version
  // captured `isRunning` from the initial render (false), so the
  // cancel never fired.  Reading from a ref keeps the latest
  // value visible at unmount time.
  const isRunningRef = useRef(false);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);
  useEffect(() => {
    return () => {
      if (native && isRunningRef.current) {
        native.cancel().catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confidenceLevel = state ? outcomeToConfidence(state.outcome) : null;

  return {
    isAvailable,
    isRunning,
    state,
    hint: lastHintRef.current,
    confidenceLevel,
    start,
    finalize,
    cancel,
  };
}
