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
  /**
   * Ultra-wide reached by remounting a dedicated ultra-wide device on 0.5x
   * (the 1x primary may be a multi-cam *or* a standalone wide).  Used when
   * no multi-cam device can reach the ultra-wide by zoom.
   */
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
  /**
   * The device's REAL ultra-wide zoom factor, for the lens chip's LABEL only
   * (the `CameraLens` identifier stays `'0.5x'` — it is also the stitcher's
   * warper-tree zoom signal, so it must not become device-dependent).
   * `0.6` on a Galaxy S24 Ultra, `0.5` on a typical iPhone.
   *
   * `null` when no back device advertises a sub-1× zoom range, i.e. the
   * factor is genuinely unknowable from what the platform reports — the UI
   * falls back to its historical `0.5×` label rather than inventing a number.
   *
   * See {@link ultraWideFactorOf} for why this is NOT read off the mounted
   * device.
   */
  ultraWideFactor: number | null;
}

const hasLens = (d: DeviceLike, lens: LensType) =>
  d.physicalDevices.includes(lens);

/**
 * The OEM-declared ultra-wide zoom factor across the WHOLE back-camera set.
 *
 * Deliberately not read off the mounted device: in `standalone-uw` mode the
 * 0.5× mount IS the ultra-wide, so it reports its own native range
 * (`minZoom: 1`) and would render a nonsensical "1×" label.  The real factor
 * is declared by the sibling LOGICAL device that spans wide→ultra-wide — on a
 * Galaxy S24 Ultra that is `minZoom: 0.6`, matching what Samsung's own camera
 * app shows.  So: scan every back device that carries an ultra-wide and take
 * the smallest sub-1× `minZoom` any of them advertises.
 *
 * Returns null when nothing advertises a sub-1× range (a pure standalone-UW
 * phone where no logical device declares the crossover) — the caller must then
 * fall back rather than guess.  Non-finite / non-positive values are ignored.
 */
function ultraWideFactorOf(back: readonly DeviceLike[]): number | null {
  let best: number | null = null;
  for (const d of back) {
    if (!hasLens(d, 'ultra-wide-angle-camera')) continue;
    const z = d.minZoom;
    // `< 1` is the whole point: a device merely LISTING the ultra-wide reports
    // 1.0 and tells us nothing about where the ultra-wide sits.
    if (!Number.isFinite(z) || z <= 0 || z >= 1) continue;
    if (best == null || z < best) best = z;
  }
  // Round to 1dp: vision-camera surfaces float32 (the S24 Ultra reports
  // 0.6000000238418579), which would otherwise render verbatim in the chip.
  return best == null ? null : Math.round(best * 10) / 10;
}

/**
 * Max `minZoom` a multi-cam device may report and still count as able to
 * reach the ultra-wide *by zoom*.  Real ultra-wides sit at ~0.5-0.65x, so a
 * logical device whose zoom range genuinely extends to the ultra-wide reports
 * `minZoom <= ~0.65`.  A device that only *lists* the ultra-wide (a separate
 * physical camera on Android/Camera2, not a zoom target) reports
 * `minZoom = 1.0`.  0.7 cleanly separates the two.
 */
const UW_ZOOM_REACH_MAX = 0.7;

/** Options for {@link selectCaptureDevice}. */
export interface SelectCaptureDeviceOptions {
  /**
   * `captureDepthData` (iOS): prefer a DEPTH-CAPABLE 1× mount.  AVDepthData
   * only flows from a virtual multi-lens device (or LiDAR) — a plain
   * physical wide-angle never delivers it.  Effect on the pick:
   *   - multicam mode (virtual wide+ultra-wide) already qualifies — depth
   *     comes from the wide+uw overlap at FULL wide FOV.  Unchanged.
   *   - standalone-uw / wide-only: the 1× primary becomes the best
   *     depth-capable VIRTUAL device, ranked by the FOV its depth (and
   *     depth-biased formats) actually cover — see `depthMountRank`:
   *       1. wide-only virtual (`Back LiDAR Depth Camera`) — sensor depth
   *          at the full wide FOV; nothing visible changes at 1×.
   *       2. ultra-wide-containing virtual (Dual Wide / Triple) — the
   *          stereo pair is uw+wide, whose overlap IS the wide FOV; 1×
   *          still looks normal.
   *       3. wide+tele virtual (`Back Dual Camera`) — LAST RESORT: the
   *          overlap is the TELE FOV, so 1× reads ~2× tighter (field
   *          finding 2026-07-10).  Only phones with no better depth
   *          source pay this, knowingly.
   * Falls through to the normal pick when no depth-capable device exists.
   */
  preferDepth?: boolean;
  /**
   * `Platform.OS` at the call site.  Threaded in (not read directly) so
   * this module stays pure/synchronous and unit-testable without a
   * react-native mock — see the file header.
   *
   * ANDROID FIELD FINDING (Galaxy S24 Ultra / SCG26, 2026-07-27): the
   * logical multi-cam device reported `minZoom: 0.6` — inside
   * `UW_ZOOM_REACH_MAX`, so the multicam branch trusted it — but the
   * Samsung camera HAL never actually crossed physical sensors: a captured
   * `adb logcat` showed the identical vendor stream id
   * (`MultiCameraRealtime1_IFE0_cam0`) at both 1× and the "0.5×"-zoomed
   * request, and the captured frame's FOV visibly did not widen. Android's
   * Camera2 `CONTROL_ZOOM_RATIO` cross-physical-camera switch is
   * documented as OEM-inconsistent for non-first-party apps, so on
   * `'android'` we do NOT trust the zoom-reach claim when a genuine
   * standalone ultra-wide id exists to swap to instead — see the multicam
   * qualification check below.
   *
   * iOS is UNCHANGED: AVFoundation's virtual multi-cam devices are the
   * OS-native mechanism this file's original fix relies on (multicam
   * keeps flash working on 0.5× — see the SYMPTOM 1/2 tests), so iOS keeps
   * preferring multicam whenever it qualifies, even when a standalone
   * ultra-wide ALSO happens to be enumerated (real iPhones enumerate
   * both simultaneously).
   *
   * Omitted / any value other than `'android'` → today's behaviour
   * (prefer multicam), so an untested platform can't silently regress.
   */
  platform?: string;
}

/**
 * Choose the back-camera device(s) for capture.
 *
 * Priority:
 *   1. multicam — a multi-cam device containing BOTH wide + ultra-wide
 *      (best: one device, zoom-switch, torch via the wide member).
 *      SKIPPED on `platform: 'android'` when a standalone ultra-wide is
 *      ALSO enumerated — the zoom-reach claim is not trustworthy there
 *      (see {@link SelectCaptureDeviceOptions.platform}).
 *   2. standalone-uw — a standalone wide AND a standalone ultra-wide
 *      exist as separate devices (device-swap on lens change; flash
 *      hidden on the torchless ultra-wide).
 *   3. wide-only — no ultra-wide reachable; wide-angle only.
 *
 * @param devices  All enumerated camera devices (any position).
 * @param opts     See {@link SelectCaptureDeviceOptions}.
 */
export function selectCaptureDevice<D extends DeviceLike>(
  devices: readonly D[],
  opts: SelectCaptureDeviceOptions = {},
): CaptureDeviceSelection<D> {
  const back = devices.filter((d) => d.position === 'back');

  if (back.length === 0) {
    return {
      device: null,
      ultraWideDevice: null,
      mode: 'wide-only',
      has0_5x: false,
      hasTorch: false,
      ultraWideFactor: null,
    };
  }

  // Label-only; computed once over the whole back set (see ultraWideFactorOf).
  const ultraWideFactor = ultraWideFactorOf(back);

  // ── 1. Prefer a multi-cam device that carries BOTH wide + ultra-wide.
  // Among candidates, prefer the one that ALSO has a torch (so flash
  // works on every lens), then the one spanning the widest zoom range
  // (more lenses → more reach), as a stable tiebreak.
  const multicamCandidates = back.filter(
    (d) =>
      d.isMultiCam &&
      hasLens(d, 'wide-angle-camera') &&
      hasLens(d, 'ultra-wide-angle-camera') &&
      // Must reach the ultra-wide by zoom.  On iOS the virtual device's zoom
      // range spans it (minZoom ~0.5); on Android a logical device often
      // *lists* the ultra-wide while its zoom range starts at 1.0 (separate
      // physical camera, not a zoom target).  If it can't zoom there, it
      // does NOT qualify -- we fall through to the device-swap path below.
      d.minZoom <= UW_ZOOM_REACH_MAX,
  );
  // ANDROID ONLY: even a "qualifying" multicam claim (minZoom <=
  // UW_ZOOM_REACH_MAX) is not trustworthy -- see the field finding on
  // SelectCaptureDeviceOptions.platform.  When a genuine standalone
  // ultra-wide id is ALSO enumerated, skip the multicam early-return here
  // and let it fall through to the standalone-uw branch below, which
  // device-swaps onto hardware that actually delivers the ultra-wide.  1×
  // is unaffected either way (see the branch below -- `pickPrimary` still
  // mounts this same multicam device as the 1× primary, so torch/format
  // continuity at 1× does not change; only the 0.5× target does). iOS is
  // untouched: this whole gate is a no-op unless platform === 'android'.
  const androidDistrustsMulticamUw =
    opts.platform === 'android'
    && back.some((d) => !d.isMultiCam && hasLens(d, 'ultra-wide-angle-camera'));
  if (multicamCandidates.length > 0 && !androidDistrustsMulticamUw) {
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
      ultraWideFactor,
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
  // A *true* standalone ultra-wide (its own id, NOT a multi-cam grouping).
  // We deliberately do NOT fall back to a multi-cam device: mounting a
  // logical multi-cam yields its WIDE member, not the ultra-wide, so a
  // "swap" to it would silently show the wrong FOV.  If the only ultra-wide
  // lives inside a non-zoomable multi-cam device, it is undeliverable and we
  // hide the chooser (wide-only) below.
  const ultraWide =
    back.find((d) => !d.isMultiCam && hasLens(d, 'ultra-wide-angle-camera')) ??
    null;

  // "Simplest wide" order — fewest physical lenses first — so a PLAIN
  // physical wide-angle beats a virtual multi-lens device (Back Dual
  // Camera etc.) as the 1× mount. The preference below always PROMISED
  // this; the code took the first torch-bearer in enumeration order,
  // which could mount a VIRTUAL device: custom exposure was rejected
  // there, and depth-biased formats shift the 1× FOV (field finding
  // 2026-07-09: an iPhone mounted 'Back Dual Camera' — "1x appearing a
  // lot more zoomed in").
  //
  // preferDepth INVERTS this for the primary only: AVDepthData needs a
  // virtual (multi-cam) mount, so the best depth-capable virtual wins
  // instead. Rank = the FOV the depth actually covers (NOT lens count —
  // lens count picked 'Back Dual Camera' over the full-FOV mounts and
  // zoomed 1× to the tele overlap, field 2026-07-10):
  //   0 — wide-only virtual (LiDAR Depth Camera): full wide FOV,
  //       sensor depth.  A plain physical wide is isMultiCam=false, so
  //       this cannot capture it.
  //   1 — ultra-wide-containing virtual (Dual Wide / Triple): the depth
  //       pair is uw+wide, overlap = the wide FOV.  Fewer lenses first
  //       within the rank (Dual Wide over Triple — smaller session).
  //   2 — wide+tele virtual: overlap = TELE FOV, the documented
  //       last-resort trade.
  // Rank DOMINATES torch (a torch-bearing worse-rank mount must not
  // steal the pick); torch tiebreaks within the winning rank only.
  // No virtual at all → plain pick as usual.
  // PLAIN (non-virtual) before virtual, then fewest lenses: a wide-only
  // VIRTUAL (LiDAR Depth Camera) ties a plain wide on lens count, and
  // enumeration order must not hand the default 1× to a virtual mount.
  const simplestWideFirst = [...wideDevices].sort(
    (a, b) =>
      (a.isMultiCam === b.isMultiCam ? 0 : a.isMultiCam ? 1 : -1)
      || a.physicalDevices.length - b.physicalDevices.length,
  );
  const depthMountRank = (d: DeviceLike): number => {
    if (!hasLens(d, 'ultra-wide-angle-camera') && !hasLens(d, 'telephoto-camera')) {
      return 0; // wide-only virtual = LiDAR-style
    }
    return hasLens(d, 'ultra-wide-angle-camera') ? 1 : 2;
  };
  const pickPrimary = (): D | undefined => {
    if (opts.preferDepth) {
      // Stable sort over the fewest-lens order keeps "fewer lenses
      // first" as the within-rank tiebreak.
      const virtuals = simplestWideFirst
        .filter((d) => d.isMultiCam)
        .sort((a, b) => depthMountRank(a) - depthMountRank(b));
      if (virtuals.length > 0) {
        const bestRank = depthMountRank(virtuals[0]);
        const cohort = virtuals.filter((d) => depthMountRank(d) === bestRank);
        return cohort.find((d) => d.hasTorch) ?? cohort[0];
      }
    }
    return simplestWideFirst.find((d) => d.hasTorch) ?? simplestWideFirst[0];
  };

  if (wideDevices.length > 0 && ultraWide != null) {
    // Prefer the simplest wide device (fewest extra lenses) with a torch
    // as the 1× mount, so 1× flash works.  Falls back to any wide device.
    // (preferDepth picks the simplest depth-capable virtual instead.)
    const primary = pickPrimary() as D;
    return {
      device: primary,
      ultraWideDevice: ultraWide,
      mode: 'standalone-uw',
      has0_5x: true,
      hasTorch: primary.hasTorch,
      ultraWideFactor,
    };
  }

  // ── 3. Wide-angle only (no ultra-wide reachable on this device).
  const wideOnly = pickPrimary() ?? back[0];
  return {
    device: wideOnly,
    ultraWideDevice: null,
    mode: 'wide-only',
    has0_5x: false,
    hasTorch: wideOnly.hasTorch,
    // Reported even here (has0_5x is false so no chip consumes it today), so
    // the field never lies about the hardware just because the chooser is off.
    ultraWideFactor,
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
