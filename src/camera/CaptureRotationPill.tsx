// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureRotationPill — diagnostic pill showing the capture's gyro rotation
 * magnitude (`rRadians`) in radians + degrees, e.g. `rot 0.524 rad (30.0°)`.
 *
 * Dev tuning aid: read the rotation per capture to pick the panorama-vs-SCANS
 * threshold. The value comes from the finalize result (`rRadians`), the angle
 * between the first and last accepted keyframe camera-forward vectors.
 *
 * NOTE: `0` means "no pose-derived rotation signal" (non-AR with no poses), NOT
 * necessarily "no rotation" — so the pill shows 0.000 rather than hiding, and
 * adds a `(no pose)` hint at exactly 0 to avoid misreading it as a still frame.
 *
 * Mount inside a `__DEV__`/`settings.debug`-gated branch — it's dev tooling.
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export interface CaptureRotationPillProps {
  /** Gyro rotation magnitude in radians. Renders nothing when null/undefined. */
  rRadians?: number | null;
  /**
   * 2026-06-16 — translation magnitude (metres) and the auto decision ratio
   * (`>=0.55` → SCANS) that drove panorama-vs-SCANS for this capture. When
   * either is set, a second line shows `tr <m> · ratio <r> → SCANS|PANO`, so the
   * dev reads the FULL decision inputs (not just rotation) per capture.
   */
  tMeters?: number | null;
  decisionRatio?: number | null;
  /** Top inset (status bar / notch). Pill pinned `topInset + 12` (top-left). */
  topInset?: number;
  /** Optional absolute-position override (replaces the default top-left anchor). */
  style?: StyleProp<ViewStyle>;
}

export function CaptureRotationPill({
  rRadians,
  tMeters,
  decisionRatio,
  topInset = 0,
  style,
}: CaptureRotationPillProps): React.JSX.Element | null {
  if (rRadians == null) return null;

  const degrees = (rRadians * 180) / Math.PI;
  const noPose = rRadians === 0;
  const rotLine = noPose
    ? 'rot 0.000 rad (no pose)'
    : `rot ${rRadians.toFixed(3)} rad (${degrees.toFixed(1)}°)`;

  // Second line: translation + the decision ratio + the mode it implies.
  // 0.55 is the SCANS threshold (mirrors resolveStitchModeAuto on both natives).
  const hasDecision = tMeters != null || decisionRatio != null;
  const ratio = decisionRatio ?? 0;
  const decisionLine = hasDecision
    ? `tr ${(tMeters ?? 0).toFixed(3)} m · ratio ${ratio.toFixed(2)} → ${
        ratio >= 0.55 ? 'SCANS' : 'PANO'
      }`
    : null;

  return (
    <View
      pointerEvents="none"
      style={[styles.container, style ?? { top: topInset + 12, left: 12 }]}
      accessibilityRole="alert"
    >
      <Text style={styles.text}>{rotLine}</Text>
      {decisionLine != null ? (
        <Text style={styles.text}>{decisionLine}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(10, 132, 255, 0.92)', // blue — neutral diagnostic
    zIndex: 100,
  },
  text: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Menlo',
  },
});
