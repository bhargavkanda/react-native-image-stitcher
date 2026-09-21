// SPDX-License-Identifier: Apache-2.0
/**
 * androidHardwareVideoSizes — complete vision-camera's Android format list
 * with the video sizes the HARDWARE actually offers.
 *
 * ⚠ WHY THIS FILE EXISTS, MEASURED ON A GALAXY A35 (2026-09-21).
 *
 * vision-camera builds an Android device's `formats` as the cross product of
 * the JPEG photo sizes with `qualities.flatMap { it.typicalSizes }` over
 * CameraX's quality ladder (`CameraDeviceDetails.kt:123`), and
 * `androidx.camera.video.Quality` hard-codes those lists:
 *
 *     SD  = [720x480, 640x480]     HD  = [1280x720]
 *     FHD = [1920x1080]            UHD = [3840x2160]
 *
 * So the ONLY 4:3 video size the list can ever carry is 640x480 — on every
 * Android device, because the constant is in the library.  Every consumer of
 * the 4:3 preview/frame-processor stream (the tap photo's WYSIWYG preview,
 * the keyframe pano, the sweep) has therefore been fed VGA, and the
 * `keyframeQualityCapture` floor at 1280 had nothing to clear and did
 * nothing.  The phone's own hardware advertises 4:3 YUV at 1920x1440,
 * 1440x1080 and 960x720.
 *
 * The limit is ONLY in the list.  The native side takes whatever
 * `videoWidth`/`videoHeight` JS hands it (`CameraDeviceFormat.fromJSValue`
 * reads the map, no cross-check) and asks CameraX for exactly that size
 * (`ResolutionSelector.forSize`, which ranks the hardware's real sizes by
 * aspect-then-size distance).  So a format entry synthesised from the
 * hardware list runs on the SAME vision-camera session as everything else —
 * one camera, tap-photo and hold-sweep alike, nothing changes shape.
 *
 * The hardware list comes from the stitcher's own `RNSSweepProbe`
 * (`probeCapabilities` → `cameras.cameras[].streamConfig.yuv420Sizes`),
 * which reads `CameraCharacteristics` only — it opens no camera, so it is
 * safe to call while vision-camera holds the device.
 *
 * ⚠ FAILS OPEN.  No probe module, a probe that rejects, a camera id the
 * probe does not know: the list is returned as vision-camera gave it, and
 * the picker behaves exactly as before.  `CameraView` then also does not
 * hold its mount.  The only thing that changes the pick is a hardware size
 * the probe actually reported.
 */

import { useEffect, useState } from 'react';
import { NativeModules, Platform } from 'react-native';

import type { FormatLike } from './pickCaptureFormat';

/**
 * Long-edge cap on the sizes ADDED from the hardware list, in px.
 *
 * The hardware list runs to the full 4:3 sensor (4080x3060 on the A35) and
 * nobody wants a 12 MP frame-processor stream; a cap is inherent.  1440 is
 * the size the sweep engine's own defaults were written against ("0.5 keeps
 * a 1440x1080 AR frame's strip warp sub-millisecond", rnis_pano.hpp) and the
 * size the A35's Camera2 arm has already run at on device.  It is a first
 * cut in the engine header's sense — the pack's `deliveredFrameWidth` and
 * `ingestMs` are the measurement that moves it.
 */
export const HARDWARE_VIDEO_LONG_EDGE_CAP = 1440;

/** One hardware YUV output size, as the probe reports it. */
export interface HardwareVideoSize {
  width: number;
  height: number;
  /** null when the HAL publishes no minimum frame duration for the size. */
  maxFps: number | null;
}

/**
 * Add one format per (hardware video size x photo size) that the list does
 * not already carry, cloning every non-size field from a sibling entry with
 * the same photo size.  Pure; the picker decides what to do with the result.
 *
 * Sizes above `cap` (long edge) are not added.  Existing entries are never
 * touched, so on a platform whose list is already the hardware's (iOS) this
 * is the identity even with a non-empty `hwSizes`.
 */
export function augmentFormatsWithHardwareSizes<F extends FormatLike>(
  formats: readonly F[],
  hwSizes: readonly HardwareVideoSize[],
  cap: number = HARDWARE_VIDEO_LONG_EDGE_CAP,
): F[] {
  if (formats.length === 0 || hwSizes.length === 0) return formats.slice();

  const present = new Set(formats.map((f) => `${f.videoWidth}x${f.videoHeight}`));
  // One sibling per photo size — the entry whose non-size fields we copy.
  const siblingByPhoto = new Map<string, F>();
  for (const f of formats) {
    const k = `${f.photoWidth}x${f.photoHeight}`;
    if (!siblingByPhoto.has(k)) siblingByPhoto.set(k, f);
  }

  const out: F[] = formats.slice();
  const added = new Set<string>();
  for (const hw of hwSizes) {
    if (hw.width <= 0 || hw.height <= 0) continue;
    if (Math.max(hw.width, hw.height) > cap) continue;
    const key = `${hw.width}x${hw.height}`;
    if (present.has(key) || added.has(key)) continue;
    added.add(key);
    for (const sibling of siblingByPhoto.values()) {
      out.push({
        ...sibling,
        videoWidth: hw.width,
        videoHeight: hw.height,
        // The HAL's own rate for THIS size when it publishes one; the
        // sibling's (the device max) otherwise.  vision-camera asserts the
        // pinned fps against `maxFps`, so it must be a real number.
        maxFps: hw.maxFps != null && Number.isFinite(hw.maxFps) && hw.maxFps > 0
          ? hw.maxFps
          : sibling.maxFps,
      });
    }
  }
  return out;
}

// ── the probe ──────────────────────────────────────────────────────────────

type ProbeModule = {
  probeCapabilities?: () => Promise<unknown>;
};

/** The probe module, or null when this build does not carry it. */
function probeModule(): ProbeModule | null {
  if (Platform.OS !== 'android') return null;
  const m = (NativeModules as Record<string, unknown>).RNSSweepProbe as ProbeModule | undefined;
  return typeof m?.probeCapabilities === 'function' ? m : null;
}

/** Walk the probe report to one camera's YUV sizes.  [] when absent. */
export function hardwareVideoSizesFromProbe(
  report: unknown,
  cameraId: string,
): HardwareVideoSize[] {
  const cams = (report as { cameras?: { cameras?: unknown[] } })?.cameras?.cameras;
  if (!Array.isArray(cams)) return [];
  const cam = cams.find((c) => (c as { id?: unknown })?.id === cameraId) as
    | { streamConfig?: { yuv420Sizes?: unknown[] } }
    | undefined;
  const sizes = cam?.streamConfig?.yuv420Sizes;
  if (!Array.isArray(sizes)) return [];
  const out: HardwareVideoSize[] = [];
  for (const s of sizes) {
    const e = s as { width?: unknown; height?: unknown; maxFps?: unknown };
    if (typeof e.width !== 'number' || typeof e.height !== 'number') continue;
    out.push({
      width: e.width,
      height: e.height,
      maxFps: typeof e.maxFps === 'number' ? e.maxFps : null,
    });
  }
  return out;
}

/**
 * Per-process cache.  The hardware list cannot change for a camera id, and
 * the first `getCameraCharacteristics` on some OEM HALs blocks for tens of
 * milliseconds — once is enough, and a re-mount must not re-pay it or
 * re-pick (a format change mid-life restarts the session).
 */
const cache = new Map<string, HardwareVideoSize[] | Promise<HardwareVideoSize[]>>();
let warnedProbe = false;

function readHardwareVideoSizes(cameraId: string): HardwareVideoSize[] | Promise<HardwareVideoSize[]> {
  const hit = cache.get(cameraId);
  if (hit != null) return hit;
  const mod = probeModule();
  if (mod == null) {
    cache.set(cameraId, []);
    return [];
  }
  const p = mod.probeCapabilities!()
    .then((report) => hardwareVideoSizesFromProbe(report, cameraId))
    .catch((err: unknown) => {
      if (!warnedProbe) {
        warnedProbe = true;
        console.warn(
          '[CameraView] RNSSweepProbe.probeCapabilities failed — the format list '
          + `stays as vision-camera enumerated it: ${String(err)}`,
        );
      }
      return [] as HardwareVideoSize[];
    })
    .then((sizes) => {
      cache.set(cameraId, sizes);
      return sizes;
    });
  cache.set(cameraId, p);
  return p;
}

/** Test seam: forget everything read so far. */
export function __resetHardwareVideoSizesCache(): void {
  cache.clear();
  warnedProbe = false;
}

/** Synchronous view of the cache: the sizes if resolved, else null. */
function peekHardwareVideoSizes(cameraId: string): HardwareVideoSize[] | null {
  const hit = cache.get(cameraId);
  return Array.isArray(hit) ? hit : null;
}

/**
 * The hardware video sizes for `cameraId`, and whether they are still on
 * their way.  `pending` is true ONLY while a real probe is in flight — never
 * on iOS, never without the module, never after the first answer — so a
 * caller that holds its mount on it holds exactly once per camera, and only
 * on a build that can answer.
 *
 * ⚠ `pending` IS DERIVED, NOT STORED.  vision-camera hands `<CameraView>` an
 * undefined device on its first render and the real one later.  If `pending`
 * lived in state it would still read the previous camera's answer on the very
 * render the device arrives — false — and every consumer keyed on it (the
 * mount hold, the inert-floor warning) would act on the incomplete list for
 * one render before the effect below could correct it.  Seen on the A35:
 * a false "inert floor" warning 300 ms before the 1440x1080 session.  So it
 * is computed from the cache on every render, for the id THIS render has.
 */
export function useAndroidHardwareVideoSizes(
  cameraId: string | null | undefined,
): { sizes: HardwareVideoSize[]; pending: boolean } {
  const resolved = cameraId != null ? peekHardwareVideoSizes(cameraId) : [];
  const pending = cameraId != null && resolved == null && probeModule() != null;
  // Re-render when a read lands; the value itself is always read from the cache.
  const [, bump] = useState(0);

  useEffect(() => {
    if (cameraId == null) return;
    const r = readHardwareVideoSizes(cameraId);
    if (Array.isArray(r)) return;
    let live = true;
    void r.then(() => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
  }, [cameraId]);

  return { sizes: resolved ?? [], pending };
}
