// SPDX-License-Identifier: Apache-2.0
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
 * 2026-05-21 (v0.2 — Expo modules removal) — rewritten back onto
 * `react-native-sensors` accelerometer.  `expo-sensors`'
 * `DeviceMotion` was used previously (Issue #3 / 2026-05-18) because
 * it normalised Android signs to iOS convention for us, but that
 * pulled the entire Expo modules runtime into every consuming
 * host app — a heavy tax for one orientation hook (see
 * `docs/host-app-integration.md`).  We now do the same sign
 * normalisation explicitly in JS and stay on `react-native-sensors`
 * (already a peer dep for the pan-guide gyroscope).
 *
 * Sign conventions used here (per platform docs):
 *
 *   iOS (CMAccelerometerData, reported in G's; react-native-sensors
 *   passes through, in m/s²-ish G-multiples):
 *     portrait              → y ≈ -1   (gravity along device -Y)
 *     portrait-upside-down  → y ≈ +1
 *     landscape-left  (home indicator on user's RIGHT) → x ≈ +1
 *     landscape-right (home indicator on user's LEFT)  → x ≈ -1
 *
 *   Android (Sensor.TYPE_ACCELEROMETER, reaction-force convention,
 *   m/s²):
 *     portrait              → y ≈ +9.8  ← OPPOSITE SIGN vs iOS
 *     portrait-upside-down  → y ≈ -9.8
 *     landscape-left        → x ≈ -9.8
 *     landscape-right       → x ≈ +9.8
 *
 *   We flip the Android x/y signs to match the iOS convention
 *   before classification, so the classifier stays platform-
 *   agnostic and operates entirely in iOS-convention values.
 *   (Previous react-native-sensors implementation, pre-Issue-#3,
 *   forgot this — Apple's CoreMotion convention is `y < 0` ⇒
 *   portrait, but the old code used `y > 0` ⇒ portrait, so iOS
 *   was stuck at the initial value regardless of rotation.  Don't
 *   regress.)
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import {
  accelerometer,
  setUpdateIntervalForType,
  SensorTypes,
} from 'react-native-sensors';


export type DeviceOrientation =
  | 'portrait'
  | 'portrait-upside-down'
  | 'landscape-left'
  | 'landscape-right';


/// Threshold above which a single axis is considered to dominate.
/// Phone-at-rest under gravity reads ~1 G on whichever axis is
/// aligned with vertical; the off-axis reading is ~0.  Anything
/// more than half a G (~5 m/s² on Android, ~0.5 on iOS in G's) is
/// safely in "dominant" territory without flipping on small wobbles.
/// We compare against the magnitude after sign-normalisation, so
/// the threshold is platform-dependent: iOS reports in G's,
/// Android in m/s².
const DOMINANT_AXIS_THRESHOLD_IOS = 0.5;        // G's
const DOMINANT_AXIS_THRESHOLD_ANDROID = 5.0;    // m/s²

/// Sample at ~10 Hz — plenty for orientation detection (phones
/// don't physically flip faster than this).
const SAMPLE_INTERVAL_MS = 100;


function classify(
  x: number,
  y: number,
  threshold: number,
): DeviceOrientation | null {
  // Inputs are in iOS-convention gravity-vector signs:
  //   +X points from phone-left to phone-right; +Y from phone-
  //   bottom to phone-top; +Z out of the screen toward the viewer.
  //   At rest under gravity:
  //     portrait (upright)   → y ≈ -g  (phone-Y points up; gravity is -Y)
  //     portrait-upside-down → y ≈ +g
  //     landscape-left       → x ≈ -g  (phone-X points up; gravity is -X)
  //     landscape-right      → x ≈ +g
  if (Math.abs(y) > Math.abs(x)) {
    if (y < -threshold) return 'portrait';
    if (y > threshold) return 'portrait-upside-down';
  } else {
    if (x < -threshold) return 'landscape-left';
    if (x > threshold) return 'landscape-right';
  }
  // Phone face-up or face-down (z dominates) — keep the previous
  // orientation rather than flicker.
  return null;
}


export function useDeviceOrientation(): DeviceOrientation {
  const [orientation, setOrientation] = useState<DeviceOrientation>('portrait');

  useEffect(() => {
    setUpdateIntervalForType(SensorTypes.accelerometer, SAMPLE_INTERVAL_MS);

    const isAndroid = Platform.OS === 'android';
    const threshold = isAndroid
      ? DOMINANT_AXIS_THRESHOLD_ANDROID
      : DOMINANT_AXIS_THRESHOLD_IOS;

    let last: DeviceOrientation = 'portrait';
    const sub = accelerometer.subscribe(({ x, y }) => {
      // Normalise Android reaction-force convention to iOS gravity
      // convention by flipping signs.  No-op on iOS.
      const gx = isAndroid ? -x : x;
      const gy = isAndroid ? -y : y;
      const next = classify(gx, gy, threshold);
      if (next && next !== last) {
        last = next;
        setOrientation(next);
      }
    });
    return () => sub.unsubscribe();
  }, []);

  return orientation;
}
