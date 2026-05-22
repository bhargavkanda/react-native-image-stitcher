// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureOrientationPill — diagnostic pill showing the operator's
 * current hold orientation as detected by the pose-derived hook.
 *
 * Useful for diagnosing rotation issues — if the pill says
 * `landscape-left` but the band overlay is rendering as if it's
 * `portrait`, there's a mismatch between the JS orientation hook
 * and the engine's pose-derived isLandscape signal.
 *
 * Pinned top-left below the status bar.  Layer-2 hosts can mount
 * this directly; Layer-1 `<Camera>` mounts it automatically when
 * `settings.debug = true`.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

export interface CaptureOrientationPillProps {
  /** Current device orientation (typically from useDeviceOrientation). */
  orientation: string;
  /** Top inset for safe-area placement.  Pill pinned `topInset + 56`. */
  topInset?: number;
}

export function CaptureOrientationPill({
  orientation,
  topInset = 0,
}: CaptureOrientationPillProps): React.JSX.Element {
  return (
    <View
      pointerEvents="none"
      style={[styles.container, { top: topInset + 56 }]}
      accessibilityRole="alert"
    >
      <Text style={styles.text}>{`orient: ${orientation}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(99, 102, 241, 0.92)',
    zIndex: 100,
  },
  text: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Menlo',
  },
});
