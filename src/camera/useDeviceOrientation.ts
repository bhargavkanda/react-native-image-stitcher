/**
 * useDeviceOrientation — physical device orientation hook.
 *
 * The host app is portrait-locked at the iOS app level (so the
 * camera preview, header, controls, and thumbnails stay in their
 * portrait positions even when the user holds the phone sideways
 * for a vertical pan).  But text overlays — the REC banner, the
 * pan-speed pill, the live frame strip — need to follow the
 * physical device orientation so they stay readable in the user's
 * hands.  RN's `useWindowDimensions` can't help with this when
 * the app is orientation-locked: window dimensions don't change
 * when only the device rotates.
 *
 * This hook subscribes to the accelerometer and classifies the
 * gravity vector into one of four states.  Lightweight enough to
 * leave running for the screen lifetime; the accelerometer is
 * already on for inertial-aware features in modern iPhones.
 */

import { useEffect, useState } from 'react';
import {
  accelerometer,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';


export type DeviceOrientation =
  | 'portrait'
  | 'portrait-upside-down'
  | 'landscape-left'
  | 'landscape-right';


/// Threshold above which gravity dominance is considered conclusive.
/// 5 m/s² out of ~9.8 means the phone is at least ~30° tilted toward
/// that axis — comfortable for stable orientation classification
/// without flipping on minor wobbles.
const DOMINANT_AXIS_THRESHOLD = 5.0;

/// Sample at ~10 Hz — plenty for orientation detection (phones
/// don't physically flip faster than this) and an order of magnitude
/// less data than the 60 Hz gyro stream the pan-speed indicator uses.
const SAMPLE_INTERVAL_MS = 100;


function classify(x: number, y: number): DeviceOrientation | null {
  // y > threshold: phone upright (top-of-screen UP) → portrait.
  // y < -threshold: top-of-screen DOWN → upside-down portrait.
  // x > threshold: right edge of screen UP → landscape-LEFT
  //   (phone rotated 90° CCW from portrait; the camera/lens is
  //    on the user's right; status bar appears on the left edge).
  // x < -threshold: left edge UP → landscape-RIGHT.
  // Below threshold on both: phone is face-up or face-down — keep
  // the previous orientation rather than flicker.
  if (Math.abs(y) > Math.abs(x)) {
    if (y > DOMINANT_AXIS_THRESHOLD) return 'portrait';
    if (y < -DOMINANT_AXIS_THRESHOLD) return 'portrait-upside-down';
  } else {
    if (x > DOMINANT_AXIS_THRESHOLD) return 'landscape-left';
    if (x < -DOMINANT_AXIS_THRESHOLD) return 'landscape-right';
  }
  return null;
}


export function useDeviceOrientation(): DeviceOrientation {
  const [orientation, setOrientation] = useState<DeviceOrientation>('portrait');

  useEffect(() => {
    setUpdateIntervalForType(SensorTypes.accelerometer, SAMPLE_INTERVAL_MS);

    let last: DeviceOrientation = 'portrait';
    const sub: Subscription = accelerometer.subscribe({
      next: ({ x, y }) => {
        const next = classify(x, y);
        if (next && next !== last) {
          last = next;
          setOrientation(next);
        }
      },
      error: (err) => {
        // eslint-disable-next-line no-console
        console.warn('[useDeviceOrientation] accelerometer error', err);
      },
    });

    return () => sub.unsubscribe();
  }, []);

  return orientation;
}
