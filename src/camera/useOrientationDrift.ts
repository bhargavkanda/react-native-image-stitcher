// SPDX-License-Identifier: Apache-2.0
/**
 * useOrientationDrift — detects mid-capture device rotation.
 *
 * Pairs with `useDeviceOrientation()` to surface the case where the
 * user rotates the device *during* an active capture.  The
 * incremental stitching engine supports both portrait (Mode B,
 * horizontal pan) and landscape (Mode A, vertical pan) capture
 * modes as first-class — but mixing them mid-capture produces
 * malformed output ("cross-mode capture is best-effort," per
 * `incremental.ts:373-403`).  Hosts that want to protect against
 * this use this hook + `OrientationDriftModal` together: the
 * `<Camera>` flagship component auto-abandons capture the instant
 * `drifted === true` (PR-2 wiring); the modal surfaces an
 * explanatory popup to the user.
 *
 * ## API contract
 *
 * Pass `active` true while a capture is in flight, false otherwise.
 * Returns:
 *
 *   - `captureOrientation` — the orientation snapshotted at the
 *     moment `active` transitioned false → true.  `undefined` when
 *     `active` is false.
 *   - `currentOrientation` — live orientation from
 *     `useDeviceOrientation()`.  Always defined (defaults to
 *     `'portrait'` until the accelerometer's first sample).
 *   - `drifted` — `true` IFF `active` is currently true AND
 *     `currentOrientation !== captureOrientation` at some point
 *     since the snapshot.  **Latching** — once true, stays true
 *     until `active` flips back to false.  This is intentional:
 *     after detection, callers should auto-abandon the capture
 *     (engine `stop()`); allowing the flag to clear before then
 *     would mask the drift if the user rotated back to the
 *     original orientation between the detection tick and the
 *     callers' abandonment effect.
 *
 * ## Semantics by transition
 *
 *   - `active` false → true:  snapshot `currentOrientation`;
 *     reset `drifted` to false.
 *   - `active` true (steady):  if `currentOrientation !==
 *     captureOrientation` at any point, latch `drifted = true`.
 *   - `active` true → false:  clear snapshot; reset `drifted`.
 *
 * ## Why a separate hook (rather than inlining in `<Camera>`)
 *
 * Hosts using the Layer-2 building blocks (`CameraView` directly,
 * custom capture UX) can reuse this hook without mounting the
 * full `<Camera>` flagship.  Same composition pattern as
 * `useIMUTranslationGate` and `useKeyframeStream`.
 *
 * ## Testing
 *
 * The pure state-transition function `_computeDriftStateForTests`
 * is exported separately so jest can exercise all 5 transition
 * cases without booting a React render.  The hook itself is a
 * thin wrapper around it (verified via on-device manual flow in
 * the v0.12 verification checklist).
 */

import { useEffect, useState } from 'react';

import {
  useDeviceOrientation,
  type DeviceOrientation,
} from './useDeviceOrientation';


export interface UseOrientationDriftReturn {
  /**
   * `true` IFF a capture is active and the device has rotated since
   * the snapshot taken at capture start.  Latching: once true, stays
   * true until `active` flips false.
   */
  drifted: boolean;

  /**
   * Snapshot of `currentOrientation` at the moment `active`
   * transitioned false → true.  `undefined` when `active` is false.
   */
  captureOrientation: DeviceOrientation | undefined;

  /**
   * Live device orientation from `useDeviceOrientation()`.  Always
   * defined.  Exposed so callers (e.g. the drift modal) can show
   * "captured in PORTRAIT, now LANDSCAPE-LEFT" copy without
   * mounting `useDeviceOrientation()` themselves.
   */
  currentOrientation: DeviceOrientation;
}


/**
 * Internal state of the drift detector.  Two scalar pieces: the
 * snapshotted capture orientation (undefined when inactive) + the
 * latched drift flag.
 */
interface DriftState {
  captureOrientation: DeviceOrientation | undefined;
  drifted: boolean;
}


const INITIAL_STATE: DriftState = {
  captureOrientation: undefined,
  drifted: false,
};


/**
 * Pure state-transition function for the drift detector.  Exported
 * with a `_` prefix to signal "internal — not part of the public
 * API."  Jest uses this directly so tests don't need a React
 * renderer (the lib's jest config is pure-data / no RN preset).
 *
 * Given the previous state + the current `active` flag + the
 * current device orientation, returns the new state.  Idempotent
 * when nothing changed (returns the same object reference) so
 * downstream `useState(setState)` calls become no-ops.
 */
export function _computeDriftStateForTests(
  prev: DriftState,
  active: boolean,
  currentOrientation: DeviceOrientation,
): DriftState {
  if (!active) {
    // active is false (or just transitioned to false).  Clear the
    // snapshot + drift flag.  Idempotent when already cleared.
    if (prev.captureOrientation === undefined && !prev.drifted) {
      return prev;
    }
    return INITIAL_STATE;
  }

  // active is true.
  if (prev.captureOrientation === undefined) {
    // false → true transition.  Snapshot the current orientation.
    // drifted starts false because, by definition, the current
    // orientation matches itself.
    return { captureOrientation: currentOrientation, drifted: false };
  }

  // active is steady true.  Check for drift.  Latching: once
  // drifted is true, never set it back to false until active
  // flips (handled above).
  if (!prev.drifted && currentOrientation !== prev.captureOrientation) {
    return { captureOrientation: prev.captureOrientation, drifted: true };
  }

  // No transition + no new drift.  Return prev to avoid an
  // unnecessary state update + re-render.
  return prev;
}


export function useOrientationDrift(
  active: boolean,
): UseOrientationDriftReturn {
  const currentOrientation = useDeviceOrientation();
  const [state, setState] = useState<DriftState>(INITIAL_STATE);

  useEffect(() => {
    setState((prev) => _computeDriftStateForTests(prev, active, currentOrientation));
  }, [active, currentOrientation]);

  return {
    drifted: state.drifted,
    captureOrientation: state.captureOrientation,
    currentOrientation,
  };
}
