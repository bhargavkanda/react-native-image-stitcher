/**
 * IncrementalPanGuide — V12.11 Step 2 (item 2 of the four-step
 * preview-UX overhaul).
 *
 * Apple-pano-style "keep the arrow on the line" pan guide for the
 * incremental capture flow.
 *
 *                  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
 *                                  ▲
 *                                  ●     ← marker drifts perpendicular
 *                  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ← guide line
 *                                                                (along pan axis)
 *                  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
 *
 * The user is told (via the band overlay's caption) to pan along
 * one axis.  This guide gives them live feedback on how WELL they
 * are obeying that instruction:
 *
 *   • A solid GUIDE LINE runs along the intended pan axis (the
 *     "ideal" pan path) across the centre of the screen.
 *   • A circular MARKER sits on the line.  As the user tilts the
 *     device perpendicular to the pan axis, the marker drifts
 *     OFF the line by an amount proportional to the integrated
 *     perpendicular rotation since capture started.
 *   • The marker's COLOUR signals how far off they've drifted —
 *     green (on track), amber (slight drift), red (significant
 *     drift).  Same colour scale as PanoramaGuidance for
 *     consistency.
 *
 * Why integrate perpendicular rotation rather than absolute device
 * angle?  We don't care about the user's starting orientation (they
 * may begin a horizontal pan with the phone tilted slightly down
 * — that's fine).  We care about CHANGE during the pan.  So we
 * reset the integral to 0 at `active=true` and accumulate the
 * perpendicular gyro rate from there.  Drift over a typical 5–10 s
 * capture is well within tolerance (a few degrees max).
 *
 * Why not consume ARKit pose?  Two reasons:
 *   1. The vision-camera (non-AR) capture path doesn't have ARKit
 *      pose at all — gyro is the only common signal.
 *   2. We want this guide to work the SAME way regardless of
 *      whether AR mode is on or off — gyro keeps the UX
 *      consistent.
 *
 * Performance: gyro at 30 Hz, integration is two multiplies per
 * sample, marker position update via setState.  Negligible.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
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

import { useDeviceOrientation, type DeviceOrientation } from './useDeviceOrientation';


export interface IncrementalPanGuideProps {
  /**
   * Subscribe to the gyroscope only while this is true.  Typically
   * driven by the host's `statusPhase === 'recording' &&
   * useIncrementalPath`.  When this flips false the integral
   * resets so the next capture starts from a known zero.
   */
  active: boolean;
  /**
   * Pixels per radian of perpendicular drift.  Higher = more
   * sensitive (small drifts move the marker more visibly).
   * Default 600 px/rad gives ~10 px of marker travel for ~1° of
   * tilt — visible without feeling twitchy.
   */
  pixelsPerRad?: number;
  /**
   * Maximum marker travel from the line, in pixels.  Beyond this
   * the marker pins to the edge of its track.  Default 80 px.
   */
  maxTravelPx?: number;
  /**
   * Drift thresholds for the colour scale, in radians.  Tuned so
   * "green" covers ±1° (no human-perceptible misalignment),
   * "amber" up to ±3°, "red" beyond.  Same defaults as
   * PanoramaGuidance's pan-speed pill for visual consistency.
   */
  warnRad?: number;
  badRad?: number;
  style?: StyleProp<ViewStyle>;
}


type DriftBucket = 'good' | 'warn' | 'bad';

const COLOR_GOOD = '#34C759';
const COLOR_WARN = '#FFCC00';
const COLOR_BAD = '#FF3B30';


function bucketFor(absRad: number, warn: number, bad: number): DriftBucket {
  if (absRad <= warn) return 'good';
  if (absRad <= bad) return 'warn';
  return 'bad';
}


function colorFor(bucket: DriftBucket): string {
  switch (bucket) {
    case 'good': return COLOR_GOOD;
    case 'warn': return COLOR_WARN;
    case 'bad':  return COLOR_BAD;
  }
}


/**
 * Pan axis vs orientation — same convention as
 * PanoramaBandOverlay (and PanoramaGuidance):
 *   • portrait   → pan horizontal → guide line is HORIZONTAL across
 *                  the screen, marker drifts vertically.
 *   • landscape  → pan vertical → guide line is VERTICAL down the
 *                  screen, marker drifts horizontally.
 */
function panAxis(orientation: DeviceOrientation): 'horizontal' | 'vertical' {
  return orientation === 'landscape-left' || orientation === 'landscape-right'
    ? 'vertical'
    : 'horizontal';
}


export function IncrementalPanGuide({
  active,
  pixelsPerRad = 600,
  maxTravelPx = 80,
  warnRad = 0.05, // ≈ 2.9°
  badRad = 0.10,  // ≈ 5.7°
  style,
}: IncrementalPanGuideProps): React.JSX.Element | null {
  const orientation = useDeviceOrientation();
  const axis = panAxis(orientation);

  // Integrated PERPENDICULAR rotation since `active` flipped true.
  // Held in a ref so per-sample updates don't re-render.  We re-
  // render only when the displayed marker offset (rounded to int
  // px) or colour bucket changes.
  const perpIntegralRef = useRef(0);
  const lastSampleTsRef = useRef<number | null>(null);

  // Displayed marker offset in px (signed; sign tells us which
  // side of the line the user has drifted to).  Capped to
  // ±maxTravelPx.  Rounded to int to keep React reconciliation
  // cheap (one re-render per integer pixel of travel).
  const [markerOffsetPx, setMarkerOffsetPx] = useState(0);
  const [bucket, setBucket] = useState<DriftBucket>('good');
  const lastBucketRef = useRef<DriftBucket>('good');
  const lastOffsetRef = useRef(0);

  useEffect(() => {
    // Inactive: reset integral and on-screen state so the next
    // capture starts at a clean zero.
    if (!active) {
      perpIntegralRef.current = 0;
      lastSampleTsRef.current = null;
      lastBucketRef.current = 'good';
      lastOffsetRef.current = 0;
      setMarkerOffsetPx(0);
      setBucket('good');
      return;
    }

    setUpdateIntervalForType(SensorTypes.gyroscope, 33);

    let subscription: Subscription | null = gyroscope.subscribe({
      next: ({ x, y }) => {
        // The PERPENDICULAR axis is the orthogonal one to the pan:
        //   portrait  pans horizontally → pan axis = gyro Y →
        //               perp axis = gyro X (pitch — head up/down).
        //   landscape pans vertically   → pan axis = gyro X →
        //               perp axis = gyro Y (yaw — head left/right).
        const perpRate = axis === 'horizontal' ? x : y;

        // Δt in seconds since the previous sample.  Use Date.now()
        // rather than the upstream's `timestamp` field because
        // react-native-sensors emits seconds on iOS and ms on
        // Android — Date.now() is unambiguous and reliable enough
        // at 30 Hz integration.
        const nowMs = Date.now();
        const last = lastSampleTsRef.current ?? nowMs;
        const dt = Math.min(0.1, Math.max(0, (nowMs - last) / 1000));
        lastSampleTsRef.current = nowMs;

        perpIntegralRef.current += perpRate * dt;

        // Convert integral (radians) → px offset, clamp.
        const rawPx = perpIntegralRef.current * pixelsPerRad;
        const clampedPx = Math.max(
          -maxTravelPx,
          Math.min(maxTravelPx, rawPx),
        );
        const roundedPx = Math.round(clampedPx);

        // setState only when the rounded px changed — keeps the
        // re-render rate to ~max(60, gyro rate) fps and usually
        // far less since drift is gradual.
        if (roundedPx !== lastOffsetRef.current) {
          lastOffsetRef.current = roundedPx;
          setMarkerOffsetPx(roundedPx);
        }

        const nextBucket = bucketFor(
          Math.abs(perpIntegralRef.current),
          warnRad,
          badRad,
        );
        if (nextBucket !== lastBucketRef.current) {
          lastBucketRef.current = nextBucket;
          setBucket(nextBucket);
        }
      },
      error: (err) => {
        // eslint-disable-next-line no-console
        console.warn('[IncrementalPanGuide] gyroscope error', err);
      },
    });

    return () => {
      subscription?.unsubscribe();
      subscription = null;
    };
  }, [active, axis, pixelsPerRad, maxTravelPx, warnRad, badRad]);

  if (!active) return null;

  const markerColor = colorFor(bucket);

  if (axis === 'horizontal') {
    // Portrait: guide line spans horizontally across the centre,
    // marker drifts vertically.  Marker is a small circle outlined
    // in the bucket colour.
    return (
      <View
        pointerEvents="none"
        style={[styles.rootCentered, style]}
      >
        <View style={styles.lineHorizontal} />
        <View
          style={[
            styles.marker,
            { borderColor: markerColor },
            // Vertical translation from the line.  Negative px =
            // device tilted UP from start → marker UP.
            { transform: [{ translateY: markerOffsetPx }] },
          ]}
        />
      </View>
    );
  }

  // Landscape: guide line is VERTICAL down the centre, marker
  // drifts horizontally.
  return (
    <View
      pointerEvents="none"
      style={[styles.rootCentered, style]}
    >
      <View style={styles.lineVertical} />
      <View
        style={[
          styles.marker,
          { borderColor: markerColor },
          { transform: [{ translateX: markerOffsetPx }] },
        ]}
      />
    </View>
  );
}


// Layout: position the entire guide as an absolute, full-screen
// overlay so the line spans the camera viewport edge-to-edge.
// The marker is rendered absolutely at the centre and translated
// by markerOffsetPx (signed) along the perpendicular axis.
const styles = StyleSheet.create({
  rootCentered: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Horizontal line across the screen, centred vertically.  Thin
  // (1.5 px), white-translucent, dashed via repeating segments
  // would be nicer but a flat translucent rectangle is sufficient
  // for V12.11 Step 2 — leaves room for a polish pass later.
  lineHorizontal: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1.5,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  // Vertical line down the screen, centred horizontally.
  lineVertical: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1.5,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
  },
  // Marker — a 22 px ringed circle.  Filled with a translucent
  // dark so the bucket-coloured ring reads cleanly against any
  // camera-feed background.
  marker: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 3,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
});
