// SPDX-License-Identifier: Apache-2.0
/**
 * useDeviceOrientation — physical device orientation hook.
 *
 * Hooks into the accelerometer to report the device's physical
 * orientation as a 4-way `DeviceOrientation` value.  Works
 * identically regardless of host configuration:
 *
 *   - Portrait-locked host (Info.plist UISupportedInterfaceOrientations
 *     restricted to Portrait):  RN's `useWindowDimensions` returns
 *     portrait dims regardless of physical tilt.  This hook reads
 *     the sensor directly, so text overlays (REC banner, pan-speed
 *     pill, live frame strip) can still follow the user's hold.
 *   - Non-locked host (Info.plist supports all 4):  the OS rotates
 *     the framebuffer with the device; `useWindowDimensions` reflects
 *     the rotated JS layout.  This hook still reports physical tilt
 *     — useful in combination with window dims to detect whether
 *     the screen rotated to match the device (`<Camera>`'s v0.12
 *     `homeIndicatorEdge` logic uses both signals together).
 *
 * Either way the sensor is the single source of truth for "where
 * the user's hands actually are."
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


/**
 * v0.25 — orientation WITH a measurement-status flag.
 *
 * `orientation` initialises to `'portrait'` before any accelerometer
 * sample arrives — a FABRICATED default, indistinguishable from a real
 * portrait reading to callers of the scalar hook.  That mattered in the
 * field: on a host whose react-native-sensors event delivery was broken
 * or laggy (bridgeless RN; "…no listeners registered" warnings), a
 * landscape capture started while the hook still reported the
 * fabricated `'portrait'`; the first REAL sample then flipped it
 * mid-capture, which `useOrientationDrift` read as the user rotating
 * the device and auto-abandoned the capture — every time, but only in
 * landscape (a portrait hold can never disagree with a portrait
 * default).
 *
 * `settled` is `false` until the first accelerometer sample that
 * yields a classification (face-up/face-down samples keep it false —
 * they carry no orientation information).  Consumers making
 * IRREVERSIBLE decisions (abandoning a capture, gating a hold) must
 * treat `settled === false` as "unknown", never as "portrait".
 */
export interface DeviceOrientationStatus {
  orientation: DeviceOrientation;
  /** True once at least one REAL classified sample has arrived. */
  settled: boolean;
}

export function useDeviceOrientationStatus(): DeviceOrientationStatus {
  const [status, setStatus] = useState<DeviceOrientationStatus>({
    orientation: 'portrait',
    settled: false,
  });

  useEffect(() => {
    setUpdateIntervalForType(SensorTypes.accelerometer, SAMPLE_INTERVAL_MS);

    const isAndroid = Platform.OS === 'android';
    const threshold = isAndroid
      ? DOMINANT_AXIS_THRESHOLD_ANDROID
      : DOMINANT_AXIS_THRESHOLD_IOS;

    let last: DeviceOrientation | null = null;
    const sub = accelerometer.subscribe(({ x, y }) => {
      // Normalise Android reaction-force convention to iOS gravity
      // convention by flipping signs.  No-op on iOS.
      const gx = isAndroid ? -x : x;
      const gy = isAndroid ? -y : y;
      const next = classify(gx, gy, threshold);
      if (next && next !== last) {
        last = next;
        setStatus({ orientation: next, settled: true });
      }
    });
    return () => sub.unsubscribe();
  }, []);

  return status;
}

export function useDeviceOrientation(): DeviceOrientation {
  // Scalar back-compat wrapper.  Existing display-oriented consumers
  // (overlay placement, bake rotation) are fine with the portrait
  // default — a mis-rotated first frame of UI is recoverable.  Only
  // irreversible-decision consumers need the `settled` flag above.
  return useDeviceOrientationStatus().orientation;
}
