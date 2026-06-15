// SPDX-License-Identifier: Apache-2.0
/**
 * panModeGate — pure decision helper for the first-time-user "rotate the
 * device" gate (guidance item 1).
 *
 * The non-AR panorama flow has two pan directions:
 *
 *   - **vertical** — the user holds the phone LANDSCAPE and pans the camera
 *     TOP → BOTTOM down a tall fixture.  Both `landscape-left` and
 *     `landscape-right` are valid holds.
 *   - **horizontal** — the user holds the phone PORTRAIT and pans LEFT →
 *     RIGHT across a wide scene.  Both portrait holds are valid.
 *
 * A host restricts capture via the `panMode` flag:
 *   - `'vertical'`   → landscape-only; a PORTRAIT hold is gated (rotate to
 *                      landscape).
 *   - `'horizontal'` → portrait-only; a LANDSCAPE hold is gated (rotate to
 *                      portrait).
 *   - `'both'`       → either; the gate never fires.
 *
 * When the gate fires the host must NOT start the capture — it shows the
 * rotate prompt (guidance item 2, pointing at the target orientation) and
 * waits for the user to rotate.
 *
 * This module is the single pure predicate for that decision: no React, no
 * sensors, no side effects, so the gate logic is unit-testable in the node
 * jest env without booting a render or mocking the accelerometer.
 */

import type { DeviceOrientation } from './useDeviceOrientation';


/**
 * Which device holds the panorama capture accepts.
 *
 *   - `'vertical'`   — LANDSCAPE only (top→bottom pan; the product default).
 *     Portrait holds are gated behind the rotate-to-landscape prompt.
 *   - `'horizontal'` — PORTRAIT only (left→right pan).  Landscape holds are
 *     gated behind the rotate-to-portrait prompt.
 *   - `'both'`       — LANDSCAPE or PORTRAIT; the gate never fires, the user
 *     captures in whichever hold they're already in.
 */
export type PanMode = 'vertical' | 'horizontal' | 'both';


function isPortrait(orientation: DeviceOrientation): boolean {
  return (
    orientation === 'portrait' || orientation === 'portrait-upside-down'
  );
}


/**
 * True when the caller must BLOCK capture-start and show the rotate prompt
 * for the current device hold:
 *   - `'vertical'`   gates a PORTRAIT hold (needs landscape).
 *   - `'horizontal'` gates a LANDSCAPE hold (needs portrait).
 *   - `'both'`       never gates.
 */
export function shouldGateForPanMode(
  panMode: PanMode,
  orientation: DeviceOrientation,
): boolean {
  if (panMode === 'vertical') return isPortrait(orientation);
  if (panMode === 'horizontal') return !isPortrait(orientation);
  return false; // 'both'
}


/**
 * The orientation the user must rotate TO when a hold is gated, used to pick
 * the rotate prompt's copy + graphic.  `'vertical'` wants landscape,
 * `'horizontal'` wants portrait; `'both'` never gates so returns `null`.
 */
export function gateTargetOrientation(
  panMode: PanMode,
): 'landscape' | 'portrait' | null {
  if (panMode === 'vertical') return 'landscape';
  if (panMode === 'horizontal') return 'portrait';
  return null;
}
