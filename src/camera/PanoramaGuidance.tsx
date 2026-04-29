/**
 * PanoramaGuidance — gyroscope-driven pan-speed indicator for the
 * tap-and-hold panorama flow.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │            (camera preview)                              │
 *   │                                                          │
 *   │            ↓                                             │ ← portrait + landscape pan
 *   │           green / yellow / red                           │
 *   │                                                          │
 *   │           "Pan slowly" / "Slow down" / "Too fast"        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Why this exists
 *   The SCANS-mode stitcher needs ~30–50 % overlap between
 *   consecutive frames.  At 30 fps, frames are ~33 ms apart, so
 *   pan rates above roughly 30°/s (≈ 0.5 rad/s) produce frames
 *   the stitcher can't align — and the user finds out only after
 *   the post-release "Stitching failed" alert.  Real-time feedback
 *   prevents that failure mode.
 *
 * What it does
 *   - Subscribes to the device gyroscope (react-native-sensors)
 *     ONLY while `active` is true; tears down on inactive so the
 *     sensor isn't running the rest of the time the screen is up.
 *   - Detects portrait vs landscape from window dimensions; the
 *     dominant pan axis changes accordingly:
 *       portrait  → user pans horizontally → we track gyro Y.
 *       landscape → user pans vertically → we track gyro X.
 *   - Maps the dominant axis's |rad/s| onto a colour scale and a
 *     human-readable hint.  Defaults are tuned for SCANS but
 *     overrideable.
 *
 * Performance
 *   The gyroscope fires ~30 Hz.  We update an Animated.Value (which
 *   updates the colour interpolation on the native driver) and only
 *   call setState when the qualitative bucket (good/warn/bad)
 *   changes — keeps re-render volume low.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  gyroscope,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';

import { useDeviceOrientation } from './useDeviceOrientation';


export type PanoramaSpeedBucket = 'good' | 'warn' | 'bad';

type PanAxis = 'horizontal' | 'vertical';


export interface PanoramaGuidanceProps {
  /**
   * Subscribe to the gyroscope only while this is true.  Typically
   * driven by the host's `statusPhase === 'recording'`.
   */
  active: boolean;
  /**
   * Force the pan axis instead of auto-detecting from window
   * orientation.  Useful for hosts that lock orientation but want
   * the user to pan the orthogonal axis.
   *
   * Default: undefined → auto-detect ("horizontal" in portrait,
   * "vertical" in landscape — matches the user's described
   * "pan top-to-bottom in landscape, left-to-right in portrait").
   */
  axis?: PanAxis;
  /**
   * Rotation rates in rad/s defining the speed buckets.  Defaults
   * tuned for cv::Stitcher::SCANS at 30 fps with iPhone FOV ≈ 70°:
   *   |rate| ≤ goodMax → green ("good")
   *   |rate| ≤ warnMax → amber ("slow down a bit")
   *   else            → red   ("too fast")
   */
  goodMaxRadPerSec?: number;
  warnMaxRadPerSec?: number;
  /** Optional hint message overrides. */
  messages?: {
    good?: string;
    warn?: string;
    bad?: string;
  };
  style?: StyleProp<ViewStyle>;
}


const DEFAULT_GOOD = 0.5;
const DEFAULT_WARN = 1.0;

const COLOR_GOOD = '#34C759';
const COLOR_WARN = '#FFCC00';
const COLOR_BAD = '#FF3B30';

const DEFAULT_MESSAGES = {
  good: 'Good pace — keep going',
  warn: 'Slow down a bit',
  bad: 'Too fast — slow down',
};


function bucketFor(
  rate: number,
  good: number,
  warn: number,
): PanoramaSpeedBucket {
  const abs = Math.abs(rate);
  if (abs <= good) return 'good';
  if (abs <= warn) return 'warn';
  return 'bad';
}


function colorFor(bucket: PanoramaSpeedBucket): string {
  switch (bucket) {
    case 'good':
      return COLOR_GOOD;
    case 'warn':
      return COLOR_WARN;
    case 'bad':
      return COLOR_BAD;
  }
}


export function PanoramaGuidance({
  active,
  axis,
  goodMaxRadPerSec = DEFAULT_GOOD,
  warnMaxRadPerSec = DEFAULT_WARN,
  messages,
  style,
}: PanoramaGuidanceProps): React.JSX.Element | null {
  // Use the accelerometer-based hook (NOT useWindowDimensions) so
  // we detect physical orientation even though the app is
  // portrait-locked at the OS level.
  const deviceOrientation = useDeviceOrientation();
  const isPortrait =
    deviceOrientation === 'portrait'
    || deviceOrientation === 'portrait-upside-down';

  // Auto-detect: in portrait the user pans horizontally
  // (left↔right across the rack) → gyro Y axis dominates.
  // In landscape the user pans vertically (up↕down a tall fixture)
  // → gyro X axis dominates.
  const resolvedAxis: PanAxis =
    axis ?? (isPortrait ? 'horizontal' : 'vertical');

  // Qualitative bucket — drives both the message and (via colour)
  // the arrow tint.  Stored in state so a *change* in bucket
  // re-renders, but per-sample updates do NOT.
  const [bucket, setBucket] = useState<PanoramaSpeedBucket>('good');

  // Last known rotation rate for the dominant axis, kept in a ref
  // to avoid re-rendering every sample.  Read by the bucket logic
  // and (indirectly, via colour interpolation) the animated tint.
  const lastBucketRef = useRef<PanoramaSpeedBucket>('good');

  useEffect(() => {
    if (!active) {
      lastBucketRef.current = 'good';
      setBucket('good');
      return;
    }

    // Sample at 33 ms (~30 Hz) — matches the typical recording
    // frame rate so each gyro sample maps to one frame's pan.
    setUpdateIntervalForType(SensorTypes.gyroscope, 33);

    let subscription: Subscription | null = gyroscope.subscribe({
      next: ({ x, y }) => {
        const rate = resolvedAxis === 'horizontal' ? y : x;
        const next = bucketFor(rate, goodMaxRadPerSec, warnMaxRadPerSec);
        if (next !== lastBucketRef.current) {
          lastBucketRef.current = next;
          setBucket(next);
        }
      },
      error: (err) => {
        // eslint-disable-next-line no-console
        console.warn('[PanoramaGuidance] gyroscope error', err);
      },
    });

    return () => {
      subscription?.unsubscribe();
      subscription = null;
    };
  }, [active, resolvedAxis, goodMaxRadPerSec, warnMaxRadPerSec]);

  const resolvedMessages = useMemo(
    () => ({
      good: messages?.good ?? DEFAULT_MESSAGES.good,
      warn: messages?.warn ?? DEFAULT_MESSAGES.warn,
      bad: messages?.bad ?? DEFAULT_MESSAGES.bad,
    }),
    [messages],
  );

  if (!active) return null;

  const tint = colorFor(bucket);
  const message = resolvedMessages[bucket];
  // Arrow glyph for the dominant axis.  The arrow renders a
  // pannable direction hint — landscape gets a vertical arrow
  // (the user's panning that way), portrait gets a horizontal
  // arrow.
  const arrow = resolvedAxis === 'horizontal' ? '↔' : '↕';

  // Place the pill at user-perceived bottom across all four
  // orientations.  Same pattern as <CaptureStatusOverlay> — the
  // app layout is portrait-locked so we re-position via absolute
  // coords + apply a rotation transform.
  const pillOrientationStyle =
    pillStyleForOrientation(deviceOrientation);

  return (
    <View
      pointerEvents="none"
      style={[styles.root, pillOrientationStyle, style]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.pill, { borderColor: tint }]}>
        <Text style={[styles.arrow, { color: tint }]}>{arrow}</Text>
        <Text style={[styles.message, { color: tint }]} numberOfLines={1}>
          {message}
        </Text>
      </View>
    </View>
  );
}


/**
 * Mirror of bannerStyleForOrientation in CaptureStatusOverlay,
 * but anchored at user-perceived BOTTOM instead of TOP.
 */
function pillStyleForOrientation(
  orientation:
    | 'portrait'
    | 'portrait-upside-down'
    | 'landscape-left'
    | 'landscape-right',
): {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  alignItems?: 'center' | 'flex-start' | 'flex-end';
  justifyContent?: 'center' | 'flex-start' | 'flex-end';
  transform?: { rotate: string }[];
} {
  switch (orientation) {
    case 'landscape-left':
      return {
        top: 0,
        bottom: 0,
        left: 8,
        alignItems: 'flex-start',
        justifyContent: 'center',
        transform: [{ rotate: '90deg' }],
      };
    case 'landscape-right':
      return {
        top: 0,
        bottom: 0,
        right: 8,
        alignItems: 'flex-end',
        justifyContent: 'center',
        transform: [{ rotate: '-90deg' }],
      };
    case 'portrait-upside-down':
      return {
        top: 24,
        left: 0,
        right: 0,
        alignItems: 'center',
        transform: [{ rotate: '180deg' }],
      };
    case 'portrait':
    default:
      return {
        bottom: 24,
        left: 0,
        right: 0,
        alignItems: 'center',
      };
  }
}


const styles = StyleSheet.create({
  root: {
    position: 'absolute',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 24,
    borderWidth: 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  arrow: {
    fontSize: 22,
    fontWeight: '700',
    marginRight: 8,
  },
  message: {
    fontSize: 14,
    fontWeight: '600',
  },
});
