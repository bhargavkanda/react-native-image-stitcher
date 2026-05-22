// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureMemoryPill — top-right diagnostic pill showing native
 * process memory footprint in MB, polled at 500 ms.
 *
 * Color-coded against the iPhone 16 Pro per-process jetsam limit:
 *
 *   - green  <1500 MB   (comfortable)
 *   - amber  1500–2200  (approaching pressure)
 *   - red    >2200      (close to limit — capture may be killed)
 *
 * Backed by the existing `getMemoryFootprintMB()` native module
 * (iOS: `task_info phys_footprint`, Android: `Debug.MemoryInfo
 * getTotalPss * 1024`).  Returns -1 if the native call fails.
 *
 * Mount this pill inside a `settings.debug`-gated branch — it
 * polls native every 500 ms and is unwanted in production builds.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getIncrementalNativeModule } from '../stitching/incremental';

export interface CaptureMemoryPillProps {
  /** Top inset (status bar / notch).  Pill pinned `topInset + 56`. */
  topInset?: number;
  /** Polling interval in ms.  Default 500.  Lower wastes battery
   *  for no visible benefit; higher loses correlation with capture
   *  activity. */
  pollIntervalMs?: number;
}

export function CaptureMemoryPill({
  topInset = 0,
  pollIntervalMs = 500,
}: CaptureMemoryPillProps): React.JSX.Element | null {
  const [memMB, setMemMB] = useState<number | null>(null);

  useEffect(() => {
    const native = getIncrementalNativeModule();
    if (!native?.getMemoryFootprintMB) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const mb = await native.getMemoryFootprintMB();
        if (!cancelled) setMemMB(mb);
      } catch {
        // Bridge error — leave the previous reading visible.
      }
    };
    tick();
    const id = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollIntervalMs]);

  if (memMB === null || memMB < 0) return null;

  const bg =
    memMB > 2200 ? 'rgba(239, 68, 68, 0.92)'    // red
    : memMB > 1500 ? 'rgba(245, 158, 11, 0.92)' // amber
    : 'rgba(34, 197, 94, 0.92)';                // green

  return (
    <View
      pointerEvents="none"
      style={[
        styles.container,
        { top: topInset + 56, backgroundColor: bg },
      ]}
      accessibilityRole="alert"
    >
      <Text style={styles.text}>{`${Math.round(memMB)} MB`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    zIndex: 100,
  },
  text: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Menlo',
  },
});
