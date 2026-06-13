// SPDX-License-Identifier: Apache-2.0
/**
 * panModeGate — pure decision helper for the first-time-user "rotate to
 * landscape" gate (guidance item 1).
 *
 * The non-AR panorama flow has two pan modes:
 *
 *   - **Mode A (landscape)** — the user holds the phone LANDSCAPE and pans
 *     the camera TOP → BOTTOM down a tall fixture.  Both `landscape-left`
 *     and `landscape-right` are valid holds.
 *   - **Mode B (portrait)** — the user holds the phone PORTRAIT and pans
 *     LEFT → RIGHT across a wide scene.
 *
 * A host can restrict capture to landscape-only via the `panMode` flag
 * (the product default — see `<Camera>`'s mode gate).  When it does, and
 * the device is currently held in portrait (either way up), the host must
 * NOT start the capture — instead it shows the rotate-to-landscape prompt
 * (guidance item 2) and waits for the user to rotate.
 *
 * This module is the single pure predicate that decision: it has no React,
 * no sensors, no side effects, so the gate logic is unit-testable in the
 * node jest env without booting a render or mocking the accelerometer.
 *
 * Mirrors the pure-helper + `__tests__` pattern of `contentRotationDeg`
 * (see `useContentRotation.ts`).
 */

import type { DeviceOrientation } from './useDeviceOrientation';


/**
 * Which device holds the panorama capture accepts.
 *
 *   - `'mode-a'` — LANDSCAPE only (the product default).  Portrait holds
 *     are gated behind the rotate prompt.
 *   - `'both'`  — LANDSCAPE or PORTRAIT; the gate never fires, the user
 *     captures in whichever hold they're already in.
 */
export type PanMode = 'mode-a' | 'both';


/**
 * True when the caller must BLOCK capture-start and show the
 * rotate-to-landscape prompt for the current device hold.
 *
 * Fires only when BOTH:
 *   1. `panMode === 'mode-a'` (host restricted capture to landscape), AND
 *   2. the device is held in portrait — `'portrait'` OR
 *      `'portrait-upside-down'` (i.e. NOT one of the two landscape holds).
 *
 * In `'both'` mode the gate never fires (any orientation is acceptable),
 * and in `'mode-a'` mode a landscape hold (either `landscape-left` or
 * `landscape-right`) passes the gate.
 */
export function shouldGateForPanMode(
  panMode: PanMode,
  orientation: DeviceOrientation,
): boolean {
  if (panMode !== 'mode-a') return false;
  return (
    orientation === 'portrait' || orientation === 'portrait-upside-down'
  );
}
