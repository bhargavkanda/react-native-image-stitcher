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
 * 2026-05-18 (Issue #3) — rewritten on top of `expo-sensors`
 * `DeviceMotion` (CoreMotion-fused on iOS, SensorManager on
 * Android).  The previous implementation used
 * `react-native-sensors` raw accelerometer with an Android-only
 * sign convention (`y > 0` ⇒ portrait), which silently failed on
 * iOS — Apple's CoreMotion convention is `y < 0` ⇒ portrait
 * because device-Y points from the phone's bottom to the top,
 * and gravity in that frame is `-Y`.  Users on iOS saw the hook
 * stuck at its initial value ('portrait') regardless of physical
 * rotation, which cascaded into wrong panorama bake-rotation and
 * a broken landscape band layout.
 *
 * Sign conventions used here (per platform docs):
 *
 *   iOS (CMDeviceMotion.accelerationIncludingGravity, reported in
 *   m/s² in the device reference frame):
 *     portrait              → y ≈ -9.8
 *     portrait-upside-down  → y ≈ +9.8
 *     landscape-left  (home indicator on user's RIGHT) → x ≈ +9.8
 *     landscape-right (home indicator on user's LEFT)  → x ≈ -9.8
 *
 *   Android (Sensor.TYPE_ACCELEROMETER, reaction-force convention):
 *     portrait              → y ≈ +9.8   ← opposite sign vs iOS
 *     portrait-upside-down  → y ≈ -9.8
 *     landscape-left        → x ≈ -9.8
 *     landscape-right       → x ≈ +9.8
 *
 *   We flip the Android x/y to match the iOS convention before
 *   classification so the rest of the logic stays platform-
 *   independent.  The classification then unambiguously maps to
 *   the user-visible `DeviceOrientation` enum.
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { DeviceMotion } from 'expo-sensors';
import type { DeviceMotionMeasurement } from 'expo-sensors';


export type DeviceOrientation =
  | 'portrait'
  | 'portrait-upside-down'
  | 'landscape-left'
  | 'landscape-right';


/// Threshold (m/s²) above which gravity dominance is considered
/// conclusive.  5 m/s² out of ~9.8 means the phone is at least ~30°
/// tilted toward that axis — comfortable for stable orientation
/// classification without flipping on minor wobbles.
const DOMINANT_AXIS_THRESHOLD = 5.0;

/// Sample at ~10 Hz — plenty for orientation detection (phones
/// don't physically flip faster than this).
const SAMPLE_INTERVAL_MS = 100;


function classify(x: number, y: number): DeviceOrientation | null {
  // Normalize Android's reaction-force convention to iOS's
  // gravity-vector convention by flipping the sign.  After this,
  // `ax` and `ay` always satisfy the iOS rule "+/- 9.8 means
  // gravity is pointing along that axis".
  const ax = Platform.OS === 'ios' ? x : -x;
  const ay = Platform.OS === 'ios' ? y : -y;

  // Pick the dominant axis: whichever component of gravity has
  // larger magnitude wins.  Avoids ambiguity when the phone is
  // tilted between two cardinal orientations.
  if (Math.abs(ay) > Math.abs(ax)) {
    if (ay < -DOMINANT_AXIS_THRESHOLD) return 'portrait';
    if (ay > DOMINANT_AXIS_THRESHOLD) return 'portrait-upside-down';
  } else {
    // landscape-left = home indicator on user's right
    //                = device rotated 90° CCW from portrait
    //                = phone's bottom edge on user's right
    //                = in iOS gravity-vector frame, gravity along +X
    if (ax > DOMINANT_AXIS_THRESHOLD) return 'landscape-left';
    if (ax < -DOMINANT_AXIS_THRESHOLD) return 'landscape-right';
  }
  // Phone face-up or face-down (z dominates): keep the previous
  // orientation rather than flicker.
  return null;
}


export function useDeviceOrientation(): DeviceOrientation {
  const [orientation, setOrientation] = useState<DeviceOrientation>('portrait');

  useEffect(() => {
    DeviceMotion.setUpdateInterval(SAMPLE_INTERVAL_MS);

    let last: DeviceOrientation = 'portrait';
    const sub = DeviceMotion.addListener((m: DeviceMotionMeasurement) => {
      const g = m.accelerationIncludingGravity;
      // First emissions can be null on cold start while CoreMotion
      // warms up; skip until data arrives.
      if (!g) return;
      const next = classify(g.x, g.y);
      if (next && next !== last) {
        last = next;
        setOrientation(next);
      }
    });
    return () => sub.remove();
  }, []);

  return orientation;
}
