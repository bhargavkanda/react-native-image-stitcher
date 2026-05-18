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
  // 2026-05-18 (Issue #3 round 2) — re-derived sign convention.
  //
  // Through expo-sensors, BOTH platforms normalize to the iOS
  // CoreMotion gravity-vector convention: stationary phone reports
  // the gravity vector itself in the device frame.  Device axes:
  // +X points from phone-left to phone-right; +Y from phone-bottom
  // to phone-top; +Z out of the screen toward the viewer.
  //
  // Per-orientation gravity-vector signs in the device frame:
  //
  //   portrait (upright)      → y ≈ -9.8
  //     Phone-Y points up in world; gravity is along device -Y.
  //
  //   portrait-upside-down    → y ≈ +9.8
  //     Phone-Y points down in world; gravity is along device +Y.
  //
  //   landscape-left  (Apple: home indicator on user's RIGHT;
  //                    phone rotated 90° CCW from portrait):
  //     phone-X axis points from user-bottom to user-top in this
  //     orientation, so gravity (world-down) is along device -X.
  //     → x ≈ -9.8
  //
  //   landscape-right (Apple: home indicator on user's LEFT;
  //                    phone rotated 90° CW from portrait):
  //     phone-X axis points from user-top to user-bottom, so
  //     gravity is along device +X.
  //     → x ≈ +9.8
  //
  // The earlier implementation had an Android-specific axis flip
  // baked in.  Removed — expo-sensors normalizes Android signs to
  // match iOS, and the platform branch was producing wrong values
  // (Android portrait → reported as portrait-upside-down; iOS
  // landscape-left → reported as landscape-right).
  if (Math.abs(y) > Math.abs(x)) {
    if (y < -DOMINANT_AXIS_THRESHOLD) return 'portrait';
    if (y > DOMINANT_AXIS_THRESHOLD) return 'portrait-upside-down';
  } else {
    if (x < -DOMINANT_AXIS_THRESHOLD) return 'landscape-left';
    if (x > DOMINANT_AXIS_THRESHOLD) return 'landscape-right';
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
