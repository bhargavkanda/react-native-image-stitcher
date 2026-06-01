// SPDX-License-Identifier: Apache-2.0
/**
 * selectCaptureDevice — capability-aware back-camera selection.
 *
 * Replaces the single-physical-device request that caused two
 * user-visible bugs (see docs/plans/2026-06-01-v0.13.2-multilens-
 * device-selection.md):
 *
 *   1. 0.5× silently showed the wide-angle FOV on phones where the
 *      ultra-wide is only exposed inside a multi-cam logical device —
 *      vision-camera's single-lens filter mis-scored and fell back to
 *      a plain wide-angle device.
 *   2. flash threw `flash-not-available` on 0.5× because the standalone
 *      ultra-wide device has no torch unit.
 *
 * Both stem from mounting ONE standalone physical device per lens.  The
 * fix: prefer a MULTI-CAM device that carries the ultra-wide (so a
 * single mounted device spans both FOVs via zoom AND carries the torch
 * through its wide-angle member).  Fall back to standalone devices for
 * phones — common on Android — where the ultra-wide has no multi-cam
 * grouping, so we don't regress those.
 *
 * Pure + synchronous: takes a plain device list (the structural subset
 * of vision-camera's `CameraDevice` we need) and returns the choice.
 * No React, no vision-camera hooks — unit-tested directly.
 */

export type LensType = 'ultra-wide-angle-camera' | 'wide-angle-camera' | 'telephoto-camera';

/**
 * The structural subset of vision-camera's `CameraDevice` this selector
 * reads.  Declared locally (not imported) so tests can build synthetic
 * devices without the full vision-camera type, and so the SDK doesn't
 * couple its selection logic to vision-camera's evolving shape.
 */
export interface DeviceLike {
  id: string;
  position: 'front' | 'back' | 'external';
  physicalDevices: LensType[];
  isMultiCam: boolean;
  hasTorch: boolean;
  minZoom: number;
  neutralZoom: number;
  maxZoom: number;
}

export type CaptureDeviceMode =
  /** One multi-cam device spans wide + ultra-wide; switch lenses via zoom. */
  | 'multicam'
  /** Separate standalone wide + ultra-wide devices; switch by remounting. */
  | 'standalone-uw'
  /** No ultra-wide anywhere; wide-angle only (no 0.5× chip). */
  | 'wide-only';

export interface CaptureDeviceSelection<D extends DeviceLike = DeviceLike> {
  /** The device to mount for the `1×` lens (and for `multicam`, all lenses). */
  device: D | null;
  /**
   * The device to mount when the user picks `0.5×` in `standalone-uw`
   * mode (a separate physical ultra-wide).  Null in `multicam` (same
   * device, zoom instead) and `wide-only` (no ultra-wide).
   */
  ultraWideDevice: D | null;
  mode: CaptureDeviceMode;
  /** Whether a 0.5× chooser should be offered at all. */
  has0_5x: boolean;
  /** Whether the `1×`/primary mounted device can flash (drives flash UI). */
  hasTorch: boolean;
}

const hasLens = (d: DeviceLike, lens: LensType) =>
  d.physicalDevices.includes(lens);

/**
 * Choose the back-camera device(s) for capture.
 *
 * Priority:
 *   1. multicam — a multi-cam device containing BOTH wide + ultra-wide
 *      (best: one device, zoom-switch, torch via the wide member).
 *   2. standalone-uw — a standalone wide AND a standalone ultra-wide
 *      exist as separate devices (device-swap on lens change; flash
 *      hidden on the torchless ultra-wide).
 *   3. wide-only — no ultra-wide reachable; wide-angle only.
 *
 * @param devices  All enumerated camera devices (any position).
 */
export function selectCaptureDevice<D extends DeviceLike>(
  devices: readonly D[],
): CaptureDeviceSelection<D> {
  const back = devices.filter((d) => d.position === 'back');

  if (back.length === 0) {
    return {
      device: null,
      ultraWideDevice: null,
      mode: 'wide-only',
      has0_5x: false,
      hasTorch: false,
    };
  }

  // ── 1. Prefer a multi-cam device that carries BOTH wide + ultra-wide.
  // Among candidates, prefer the one that ALSO has a torch (so flash
  // works on every lens), then the one spanning the widest zoom range
  // (more lenses → more reach), as a stable tiebreak.
  const multicamCandidates = back.filter(
    (d) =>
      d.isMultiCam &&
      hasLens(d, 'wide-angle-camera') &&
      hasLens(d, 'ultra-wide-angle-camera'),
  );
  if (multicamCandidates.length > 0) {
    const device = multicamCandidates.reduce((best, d) => {
      // torch-bearing wins; then wider zoom span; then more lenses.
      if (d.hasTorch !== best.hasTorch) return d.hasTorch ? d : best;
      const span = d.maxZoom - d.minZoom;
      const bestSpan = best.maxZoom - best.minZoom;
      if (span !== bestSpan) return span > bestSpan ? d : best;
      return d.physicalDevices.length > best.physicalDevices.length ? d : best;
    });
    return {
      device,
      ultraWideDevice: null,
      mode: 'multicam',
      has0_5x: true,
      hasTorch: device.hasTorch,
    };
  }

  // ── 2. Standalone ultra-wide + standalone wide as separate devices.
  // CRITICAL: this fallback is what keeps phones (esp. Android) where
  // the ultra-wide has NO multi-cam grouping working — without it,
  // restricting to multicam would REINTRODUCE the "0.5× shows wide" bug
  // for that device population.
  //
  // Prefer a torch-bearing wide-angle device as the `1×`/primary mount.
  const wideDevices = back.filter((d) => hasLens(d, 'wide-angle-camera'));
  const ultraWide =
    back.find((d) => !d.isMultiCam && hasLens(d, 'ultra-wide-angle-camera')) ??
    back.find((d) => hasLens(d, 'ultra-wide-angle-camera')) ??
    null;

  if (wideDevices.length > 0 && ultraWide != null) {
    // Prefer the simplest wide device (fewest extra lenses) with a torch
    // as the 1× mount, so 1× flash works.  Falls back to any wide device.
    const primary =
      wideDevices.find((d) => d.hasTorch) ?? wideDevices[0];
    return {
      device: primary,
      ultraWideDevice: ultraWide,
      mode: 'standalone-uw',
      has0_5x: true,
      hasTorch: primary.hasTorch,
    };
  }

  // ── 3. Wide-angle only (no ultra-wide reachable on this device).
  const wideOnly =
    wideDevices.find((d) => d.hasTorch) ?? wideDevices[0] ?? back[0];
  return {
    device: wideOnly,
    ultraWideDevice: null,
    mode: 'wide-only',
    has0_5x: false,
    hasTorch: wideOnly.hasTorch,
  };
}

/**
 * Map a UI lens label to a vision-camera `zoom` value for the
 * `multicam` mode (where lens switching is zoom, not device swap).
 *
 * - `1×`   → the device's `neutralZoom` (wide-angle baseline; vision-
 *   camera docs: "where the camera is in wide-angle mode and hasn't
 *   switched to ultra-wide or telephoto yet").
 * - `0.5×` → `minZoom` (the ultra-wide end of the zoom range).
 *
 * Returns `neutralZoom` for any non-0.5× label as a safe default.
 * Only meaningful in `multicam` mode; the standalone path swaps devices
 * and ignores this.
 */
export function zoomForLens(
  device: Pick<DeviceLike, 'minZoom' | 'neutralZoom'>,
  lens: '1x' | '0.5x',
): number {
  return lens === '0.5x' ? device.minZoom : device.neutralZoom;
}
