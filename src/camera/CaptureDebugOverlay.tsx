// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureDebugOverlay — diagnostic overlay for capture sessions.
 *
 * Shows the live engine state in a floating pill at the top of the
 * capture screen so operators can see:
 *
 *   - which frame outcome the engine just emitted (accept/skip/reject)
 *   - keyframe count vs. cap (e.g. "3 / 6")
 *   - per-frame newContent fraction + overlap percent
 *   - latest processingMs (how long the gate eval took)
 *   - JS-side IMU translation accumulator (when non-AR)
 *   - JS heap usage estimate (rough — RN doesn't expose Native heap)
 *
 * The overlay is gated by `<Camera>`'s `settings.debug` flag.  When
 * `debug = false` the component renders null and consumes no CPU.
 *
 * Why a separate component (not inline in Camera.tsx)?
 *
 *   Camera.tsx is already a 1200-line beast and the debug pill needs
 *   its own styling/layout that would distract from the main capture
 *   UX.  Splitting it out keeps Camera.tsx focused and the debug
 *   surface easy to evolve independently (future F9 work — port the
 *   richer memory bubble + stitch toast from the RetaiLens host).
 *
 *   This component is intentionally PRESENTATIONAL — all data is
 *   pushed in as props.  The host (Camera.tsx) owns the
 *   subscriptions / refs / state and decides when to mount the
 *   overlay.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { IncrementalState } from '../stitching/incremental';

export interface CaptureDebugOverlayProps {
  /** Latest engine state (null = no capture in progress). */
  incrementalState: IncrementalState | null;
  /** JS-side IMU translation accumulator in metres (non-AR mode). */
  imuTranslationMetres?: number | null;
  /** Capture-source label so the operator knows which gate path is live. */
  captureSource: 'ar' | 'non-ar';
  /** Effective frame selection mode that's running right now. */
  frameSelectionMode: 'time-based' | 'pose-based' | 'flow-based';
  /** Effective stitchMode setting (operator-set, before auto-resolution). */
  stitchMode: 'auto' | 'panorama' | 'scans';
}

/**
 * Map the numeric `outcome` enum to a short human label.  Mirrors
 * the iOS/Android C++ enum.  Hidden in production builds — only
 * surfaced via this debug overlay.
 */
function outcomeLabel(outcome: number | undefined): string {
  switch (outcome) {
    case 1: return 'accept';
    case 2: return 'reject';
    case 3: return 'cap-hit';
    default: return outcome == null ? '—' : String(outcome);
  }
}


export function CaptureDebugOverlay({
  incrementalState,
  imuTranslationMetres,
  captureSource,
  frameSelectionMode,
  stitchMode,
}: CaptureDebugOverlayProps): React.JSX.Element {
  const accepted = incrementalState?.acceptedCount ?? 0;
  const cap = incrementalState?.keyframeMax ?? 0;
  const overlap = incrementalState?.overlapPercent;
  const proc = incrementalState?.processingMs;
  const outcome = outcomeLabel(incrementalState?.outcome);
  const isLandscape = incrementalState?.isLandscape;
  const painted = incrementalState?.paintedExtent ?? 0;
  const panTotal = incrementalState?.panExtent ?? 0;
  const fillPct = panTotal > 0 ? Math.round((painted / panTotal) * 100) : 0;

  // Translation pill is only meaningful in non-AR mode (in AR the
  // engine's own pose is the source of truth; we don't surface the
  // tx/ty/tz separately because the operator can't act on them).
  const showImu = captureSource === 'non-ar' && imuTranslationMetres != null;
  const imuCm = showImu ? (imuTranslationMetres! * 100).toFixed(1) : null;

  return (
    <View pointerEvents="none" style={styles.container}>
      {/* Top row: mode summary */}
      <View style={styles.row}>
        <Text style={styles.label}>
          {captureSource}/{frameSelectionMode}/{stitchMode}
        </Text>
      </View>
      {/* Keyframes pill */}
      <View style={styles.row}>
        <Text style={styles.metricKey}>frames</Text>
        <Text style={styles.metricVal}>
          {accepted}{cap > 0 ? ` / ${cap}` : ''}
        </Text>
      </View>
      {/* Outcome */}
      <View style={styles.row}>
        <Text style={styles.metricKey}>last</Text>
        <Text style={styles.metricVal}>{outcome}</Text>
      </View>
      {/* Overlap + processing */}
      {(overlap != null && overlap >= 0) && (
        <View style={styles.row}>
          <Text style={styles.metricKey}>overlap</Text>
          <Text style={styles.metricVal}>{overlap.toFixed(0)}%</Text>
        </View>
      )}
      {(proc != null && proc > 0) && (
        <View style={styles.row}>
          <Text style={styles.metricKey}>proc</Text>
          <Text style={styles.metricVal}>{proc.toFixed(0)}ms</Text>
        </View>
      )}
      {/* Pan progress (band overlay metric) */}
      {panTotal > 0 && (
        <View style={styles.row}>
          <Text style={styles.metricKey}>pan</Text>
          <Text style={styles.metricVal}>
            {fillPct}% ({isLandscape ? 'L' : 'P'})
          </Text>
        </View>
      )}
      {/* IMU translation — only in non-AR mode */}
      {showImu && (
        <View style={styles.row}>
          <Text style={styles.metricKey}>imuΔ</Text>
          <Text style={styles.metricVal}>{imuCm}cm</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 110,
    left: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    minWidth: 130,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 1,
  },
  label: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Menlo',
  },
  metricKey: {
    color: '#9aa',
    fontSize: 10,
    fontFamily: 'Menlo',
    marginRight: 8,
  },
  metricVal: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Menlo',
  },
});
