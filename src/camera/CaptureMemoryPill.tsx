// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureMemoryPill — top-right diagnostic pill showing native
 * process memory footprint in MB, polled at 500 ms.
 *
 * Color-coded against the device's per-process memory budget, which is read
 * once at mount via `getDeviceTotalRamMB()` (RAM-aware):
 *
 *   budget = max(RAM × 0.42, 900 MB)   (mirrors warp_guard.hpp
 *                                        perProcessMemoryBudgetMB)
 *   - green  < 55 % of budget   (comfortable)
 *   - amber  55–70 % of budget   (approaching pressure)
 *   - red    > 70 % of budget    (close to limit — capture may be killed)
 *
 * Why RAM-aware: the old fixed 1500/2200 MB thresholds were tuned for the
 * iPhone 16 Pro and NEVER tripped on a 4 GB Android phone that jetsams ~1.3 GB
 * (false comfort exactly where OOM happens).  Falls back to 1500/2200 if the
 * RAM read is unavailable.
 *
 * Backed by the `getMemoryFootprintMB()` native module (iOS: `task_info`
 * `phys_footprint`; Android: `/proc/self/statm` RSS — the SAME number the C++
 * `[memstat]` logs report).  Returns -1 if the native call fails.
 *
 * Mount this pill inside a `settings.debug`-gated branch — it
 * polls native every 500 ms and is unwanted in production builds.
 */

import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { getIncrementalNativeModule } from '../stitching/incremental';

export interface CaptureMemoryPillProps {
  /** Top inset (status bar / notch).  Pill pinned `topInset + 56`. */
  topInset?: number;
  /** Polling interval in ms.  Default 500.  Lower wastes battery
   *  for no visible benefit; higher loses correlation with capture
   *  activity. */
  pollIntervalMs?: number;
  /**
   * Optional position override.  When supplied it REPLACES the default
   * top-right anchor (`top: topInset + 56, right: 12`), so the pill can be
   * reused on other screens (e.g. the crop/preview surface) without colliding
   * with their own corner UI.  Pass the full absolute position you want.
   */
  style?: StyleProp<ViewStyle>;
}

export function CaptureMemoryPill({
  topInset = 0,
  pollIntervalMs = 500,
  style,
}: CaptureMemoryPillProps): React.JSX.Element | null {
  const [memMB, setMemMB] = useState<number | null>(null);
  // Device total RAM (MB), read once — drives the RAM-aware pressure bands.
  const [ramMB, setRamMB] = useState<number | null>(null);

  useEffect(() => {
    const native = getIncrementalNativeModule();
    if (!native?.getMemoryFootprintMB) return undefined;
    let cancelled = false;
    // One-time RAM read for the bands (optional native method — older bridges
    // without it just keep the fixed-threshold fallback).
    native
      .getDeviceTotalRamMB?.()
      .then((r) => {
        if (!cancelled && r > 0) setRamMB(r);
      })
      .catch(() => {});
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

  // RAM-aware bands: budget = max(RAM × 0.42, 900) (mirrors warp_guard.hpp
  // perProcessMemoryBudgetMB); amber at 55 %, red at 70 %.  Fall back to the
  // iPhone-tuned fixed thresholds when RAM is unknown.
  const budget = ramMB != null ? Math.max(ramMB * 0.42, 900) : null;
  const redAt = budget != null ? budget * 0.7 : 2200;
  const amberAt = budget != null ? budget * 0.55 : 1500;
  const bg =
    memMB > redAt ? 'rgba(239, 68, 68, 0.92)'    // red
    : memMB > amberAt ? 'rgba(245, 158, 11, 0.92)' // amber
    : 'rgba(34, 197, 94, 0.92)';                // green

  return (
    <View
      pointerEvents="none"
      style={[
        styles.container,
        { backgroundColor: bg },
        style ?? { top: topInset + 56, right: 12 },
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
