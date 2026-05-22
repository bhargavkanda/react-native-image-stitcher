// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureKeyframePill — top-center "Keyframes: N/M" diagnostic pill.
 *
 * Renders while a capture is in flight AND the engine is running
 * the pose-driven / flow-driven keyframe gate (keyframeMax > 0).
 * Hidden when the gate is disabled (time-based frame selection) or
 * when no capture is active.
 *
 * Color-coded by closeness to the cap:
 *
 *   - green  N < M − 1   (plenty of budget remaining)
 *   - amber  N ≥ M − 1   (last frame, or cap already hit — next
 *                        accept will be rejected)
 *
 * Layer-2 hosts that compose their own capture UI can mount this
 * pill directly; Layer-1 `<Camera>` mounts it automatically when
 * `settings.debug = true`.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { IncrementalState } from '../stitching/incremental';

export interface CaptureKeyframePillProps {
  /** Latest engine state.  Null = capture not running. */
  state: IncrementalState | null;
  /** Top inset for safe-area placement.  Pill pinned `topInset + 56`. */
  topInset?: number;
}

export function CaptureKeyframePill({
  state,
  topInset = 0,
}: CaptureKeyframePillProps): React.JSX.Element | null {
  const accepted = state?.acceptedCount ?? 0;
  const max = state?.keyframeMax ?? 0;
  if (max <= 0) return null;

  const isAmber = accepted >= max - 1;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.container,
        {
          top: topInset + 56,
          backgroundColor: isAmber
            ? 'rgba(245, 158, 11, 0.95)'
            : 'rgba(34, 197, 94, 0.95)',
        },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.text}>{`Keyframes: ${accepted}/${max}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    zIndex: 100,
  },
  text: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
