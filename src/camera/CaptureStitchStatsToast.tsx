// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureStitchStatsToast — auto-dismissing toast that shows the
 * batch-stitcher's leaveBiggestComponent telemetry + the resolved
 * cv::Stitcher mode after every successful finalize.
 *
 * Pattern: top-center capsule, dark translucent background, dismisses
 * itself after `dismissAfterMs` (default 4500).  Replaces the
 * Alert.alert blocking modal that used to interrupt the next
 * capture.  See `useStitchStatsToast` hook for the matching
 * imperative API.
 *
 * Layer-2 hosts can mount this directly + pass their own message;
 * Layer-1 `<Camera>` mounts it under `settings.debug` and feeds
 * the formatted message from the finalize result automatically.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { IncrementalFinalizeResult } from '../stitching/incremental';

export interface CaptureStitchStatsToastProps {
  /** Toast message to show.  Pass null to hide. */
  message: string | null;
  /** Top inset for safe-area placement.  Toast pinned `topInset + 12`. */
  topInset?: number;
}

export function CaptureStitchStatsToast({
  message,
  topInset = 0,
}: CaptureStitchStatsToastProps): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.wrap,
        { top: topInset + 12 },
      ]}
    >
      <View
        style={styles.capsule}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <Text style={styles.text} numberOfLines={3}>
          {message}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 24,
    right: 24,
    alignItems: 'center',
    zIndex: 110,
  },
  capsule: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    maxWidth: '100%',
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});


/**
 * Imperative API for showing transient stitch-stats toasts.
 *
 * Returns `{ message, showFor, showResult }`:
 *   - `message`     — current toast text (pass to CaptureStitchStatsToast)
 *   - `showFor`     — show an arbitrary string, auto-dismiss
 *   - `showResult`  — format an `IncrementalFinalizeResult` into the
 *                     standard "Stitch: N/M frames • thresh X.XX •
 *                     N attempt(s) • mode" line and show it.  Convenience
 *                     for hosts that just want the canonical format.
 *
 * Auto-clears its setTimeout on unmount so callers don't have to
 * worry about setState-on-unmounted warnings.
 */
export interface UseStitchStatsToastReturn {
  message: string | null;
  showFor: (msg: string, ms?: number) => void;
  showResult: (result: IncrementalFinalizeResult, ms?: number) => void;
}

const DEFAULT_DISMISS_MS = 4500;

export function useStitchStatsToast(): UseStitchStatsToastReturn {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFor = useCallback((msg: string, ms = DEFAULT_DISMISS_MS) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => {
      setMessage(null);
      timerRef.current = null;
    }, ms);
  }, []);

  const showResult = useCallback(
    (result: IncrementalFinalizeResult, ms = DEFAULT_DISMISS_MS) => {
      // Format mirrors the RetaiLens debug toast that operators
      // already recognise.  Includes the new (audit F2g) resolved
      // stitchMode as a fourth segment when present.
      const requested = result.framesRequested;
      const included = result.framesIncluded;
      const thresh = result.finalConfidenceThresh;
      const mode = result.stitchModeResolved;
      // The retry-attempt count is derived deterministically from
      // the threshold used on the successful attempt (1.0→1, 0.5→2,
      // 0.3→3) per cpp/stitcher.cpp's retry loop.
      const attempts =
        typeof thresh === 'number'
          ? thresh >= 0.99 ? 1
          : thresh >= 0.49 ? 2
          : thresh >= 0.29 ? 3
          : null
        : null;
      const reqStr = typeof requested === 'number' ? requested : '?';
      const incStr = typeof included === 'number' ? included : '?';
      const threshStr =
        typeof thresh === 'number' && thresh >= 0
          ? thresh.toFixed(2)
          : 'n/a';
      const attStr = attempts !== null ? `${attempts} attempt${attempts > 1 ? 's' : ''}` : '? attempts';
      const modeStr = mode ? ` • ${mode}` : '';
      showFor(
        `Stitch: ${incStr}/${reqStr} frames • thresh ${threshStr} • ${attStr}${modeStr}`,
        ms,
      );
    },
    [showFor],
  );

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { message, showFor, showResult };
}
