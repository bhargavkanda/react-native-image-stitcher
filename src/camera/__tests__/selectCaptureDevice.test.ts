// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `selectCaptureDevice` + `zoomForLens` — the pure
 * capability-aware back-camera selection (v0.13.2).
 *
 * Covers the device matrix from the plan
 * (docs/plans/2026-06-01-v0.13.2-multilens-device-selection.md),
 * including the critical edge cases:
 *   - ultra-wide ONLY inside a multi-cam device (Symptom 1 fix)
 *   - ultra-wide ONLY as a standalone device (Android; must NOT regress)
 *   - ultra-wide present BOTH ways (prefer multicam)
 *
 * Pure — no mocks needed; we build synthetic DeviceLike lists.
 */

import {
  selectCaptureDevice,
  zoomForLens,
  type DeviceLike,
} from '../selectCaptureDevice';

// ── Synthetic device builders ───────────────────────────────────────
let idCounter = 0;
function dev(partial: Partial<DeviceLike>): DeviceLike {
  idCounter += 1;
  return {
    id: `dev-${idCounter}`,
    position: 'back',
    physicalDevices: ['wide-angle-camera'],
    isMultiCam: false,
    hasTorch: true,
    minZoom: 1,
    neutralZoom: 1,
    maxZoom: 10,
    ...partial,
  };
}

const tripleCam = (p: Partial<DeviceLike> = {}) =>
  dev({
    physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera', 'telephoto-camera'],
    isMultiCam: true,
    hasTorch: true,
    minZoom: 0.5,
    neutralZoom: 1,
    maxZoom: 30,
    ...p,
  });
const dualWide = (p: Partial<DeviceLike> = {}) =>
  dev({
    physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera'],
    isMultiCam: true,
    hasTorch: true,
    minZoom: 0.5,
    neutralZoom: 1,
    maxZoom: 6,
    ...p,
  });
const standaloneWide = (p: Partial<DeviceLike> = {}) =>
  dev({ physicalDevices: ['wide-angle-camera'], isMultiCam: false, hasTorch: true, ...p });
const standaloneUltraWide = (p: Partial<DeviceLike> = {}) =>
  dev({ physicalDevices: ['ultra-wide-angle-camera'], isMultiCam: false, hasTorch: false, ...p });

describe('selectCaptureDevice', () => {
  it('picks the MULTICAM device when one spans wide + ultra-wide (triple cam)', () => {
    const triple = tripleCam();
    const sel = selectCaptureDevice([triple, standaloneWide(), standaloneUltraWide()]);
    expect(sel.mode).toBe('multicam');
    expect(sel.device).toBe(triple);
    expect(sel.ultraWideDevice).toBeNull();
    expect(sel.has0_5x).toBe(true);
    expect(sel.hasTorch).toBe(true);
  });

  it('picks the MULTICAM device for a dual-wide grouping', () => {
    const dual = dualWide();
    const sel = selectCaptureDevice([dual, standaloneWide()]);
    expect(sel.mode).toBe('multicam');
    expect(sel.device).toBe(dual);
    expect(sel.has0_5x).toBe(true);
  });

  it('SYMPTOM 1 FIX: ultra-wide ONLY in a multi-cam device → multicam (not wide fallback)', () => {
    // The exact bug: a phone where ultra-wide is bundled in a multicam
    // device and there is NO standalone ultra-wide.  Old single-lens
    // filter fell back to wide-angle; we must pick the multicam.
    const dual = dualWide();
    const wide = standaloneWide();
    const sel = selectCaptureDevice([wide, dual]);
    expect(sel.mode).toBe('multicam');
    expect(sel.device).toBe(dual);
    expect(sel.has0_5x).toBe(true);
  });

  it('EDGE: ultra-wide ONLY as a standalone device (Android) → standalone-uw (no regression)', () => {
    // No multicam grouping at all.  Must still expose 0.5× via the
    // standalone ultra-wide, mounting the wide-angle as primary.
    const wide = standaloneWide();
    const uw = standaloneUltraWide();
    const sel = selectCaptureDevice([wide, uw]);
    expect(sel.mode).toBe('standalone-uw');
    expect(sel.device).toBe(wide); // primary = torch-bearing wide
    expect(sel.ultraWideDevice).toBe(uw);
    expect(sel.has0_5x).toBe(true);
    expect(sel.hasTorch).toBe(true); // the 1× mount has a torch
  });

  it('EDGE: ultra-wide present BOTH standalone AND in multicam → prefer multicam', () => {
    const dual = dualWide();
    const wide = standaloneWide();
    const uw = standaloneUltraWide();
    const sel = selectCaptureDevice([uw, wide, dual]);
    expect(sel.mode).toBe('multicam');
    expect(sel.device).toBe(dual);
  });

  it('wide-angle ONLY (no ultra-wide anywhere) → wide-only, no 0.5×', () => {
    const wide = standaloneWide();
    const sel = selectCaptureDevice([wide]);
    expect(sel.mode).toBe('wide-only');
    expect(sel.device).toBe(wide);
    expect(sel.has0_5x).toBe(false);
    expect(sel.ultraWideDevice).toBeNull();
  });

  it('prefers a TORCH-bearing multicam device over a torchless one', () => {
    const noTorch = dualWide({ hasTorch: false });
    const withTorch = tripleCam({ hasTorch: true });
    const sel = selectCaptureDevice([noTorch, withTorch]);
    expect(sel.mode).toBe('multicam');
    expect(sel.device).toBe(withTorch);
    expect(sel.hasTorch).toBe(true);
  });

  it('ignores front-facing devices', () => {
    const front = dev({ position: 'front', physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera'], isMultiCam: true });
    const backWide = standaloneWide();
    const sel = selectCaptureDevice([front, backWide]);
    expect(sel.mode).toBe('wide-only'); // front multicam doesn't count
    expect(sel.device).toBe(backWide);
  });

  it('empty device list → null device, wide-only, no 0.5×', () => {
    const sel = selectCaptureDevice([]);
    expect(sel.device).toBeNull();
    expect(sel.mode).toBe('wide-only');
    expect(sel.has0_5x).toBe(false);
    expect(sel.hasTorch).toBe(false);
  });

  it('standalone-uw: primary prefers a torch-bearing wide when multiple wides exist', () => {
    const wideNoTorch = standaloneWide({ hasTorch: false });
    const wideTorch = standaloneWide({ hasTorch: true });
    const uw = standaloneUltraWide();
    const sel = selectCaptureDevice([wideNoTorch, uw, wideTorch]);
    expect(sel.mode).toBe('standalone-uw');
    expect(sel.device).toBe(wideTorch);
    expect(sel.hasTorch).toBe(true);
  });

  it('S24: multicam LISTS ultra-wide but zoom cannot reach it (minZoom~1) + standalone uw swaps', () => {
    // Samsung/Camera2: the logical device lists the ultra-wide but its zoom
    // range starts at 1.0, so zoom cannot reach it.  A separate ultra-wide id
    // exists -> keep the multicam for 1x (torch) and swap to the standalone
    // ultra-wide on 0.5x.
    const multicamNoReach = dualWide({ minZoom: 1, hasTorch: true });
    const uw = standaloneUltraWide();
    const sel = selectCaptureDevice([multicamNoReach, uw]);
    expect(sel.mode).toBe('standalone-uw');
    expect(sel.device).toBe(multicamNoReach); // 1x primary keeps the torch
    expect(sel.ultraWideDevice).toBe(uw); // 0.5x swaps to the real ultra-wide
    expect(sel.has0_5x).toBe(true);
    expect(sel.hasTorch).toBe(true);
  });

  it('multicam lists ultra-wide, zoom cannot reach (minZoom~1), NO standalone uw -> hide', () => {
    // The ultra-wide exists ONLY inside a non-zoomable logical device with no
    // separate id to swap to -> undeliverable -> hide the chooser.
    const multicamNoReach = dualWide({ minZoom: 1 });
    const sel = selectCaptureDevice([multicamNoReach]);
    expect(sel.mode).toBe('wide-only');
    expect(sel.has0_5x).toBe(false);
    expect(sel.ultraWideDevice).toBeNull();
  });

  it('minZoom threshold: <=0.7 zoom-switches, >0.7 falls through to swap', () => {
    const atThreshold = dualWide({ minZoom: 0.7 });
    expect(selectCaptureDevice([atThreshold]).mode).toBe('multicam');
    const aboveThreshold = dualWide({ minZoom: 0.71 });
    const uw = standaloneUltraWide();
    expect(selectCaptureDevice([aboveThreshold, uw]).mode).toBe('standalone-uw');
  });
});

describe('selectCaptureDevice preferDepth (captureDepthData device pick)', () => {
  // iPhone-like enumeration: iOS virtual devices report factor-style
  // zoom (minZoom 1.0 even when they contain the ultra-wide), so the
  // multicam branch never matches and the pick lands in standalone-uw
  // via the standalone ultra-wide.  Builders mirror the real lineup.
  const dualWideTele = (p: Partial<DeviceLike> = {}) =>
    dev({
      physicalDevices: ['wide-angle-camera', 'telephoto-camera'],
      isMultiCam: true,
      hasTorch: true,
      minZoom: 1,
      neutralZoom: 1,
      maxZoom: 15,
      ...p,
    });
  // 'Back LiDAR Depth Camera': virtual, single wide constituent.
  const lidarDepthCam = (p: Partial<DeviceLike> = {}) =>
    dev({
      physicalDevices: ['wide-angle-camera'],
      isMultiCam: true,
      hasTorch: true,
      minZoom: 1,
      neutralZoom: 1,
      maxZoom: 6,
      ...p,
    });

  it('16-Pro-like lineup: LiDAR virtual wins (full wide FOV + sensor depth)', () => {
    const plainWide = standaloneWide();
    const uw = standaloneUltraWide();
    const dualTele = dualWideTele();
    const dualUwWide = dualWide({ minZoom: 1 }); // factor-style zoom → not multicam-reachable
    const triple = tripleCam({ minZoom: 1 });
    const lidar = lidarDepthCam();
    // Apple enumerates Dual (w+tele) BEFORE the full-FOV mounts — order
    // must not decide.
    const sel = selectCaptureDevice(
      [plainWide, uw, dualTele, dualUwWide, triple, lidar],
      { preferDepth: true },
    );
    expect(sel.mode).toBe('standalone-uw');
    expect(sel.device).toBe(lidar);
    expect(sel.ultraWideDevice).toBe(uw); // 0.5× swap unchanged
    expect(sel.has0_5x).toBe(true);
  });

  it('no LiDAR: ultra-wide-containing virtual (uw+wide overlap = wide FOV) beats wide+tele', () => {
    const plainWide = standaloneWide();
    const uw = standaloneUltraWide();
    const dualTele = dualWideTele(); // enumerated first — must still lose
    const dualUwWide = dualWide({ minZoom: 1 });
    const sel = selectCaptureDevice([plainWide, uw, dualTele, dualUwWide], {
      preferDepth: true,
    });
    expect(sel.device).toBe(dualUwWide);
  });

  it('within the uw rank, fewer lenses win (Dual Wide over Triple)', () => {
    const uw = standaloneUltraWide();
    const triple = tripleCam({ minZoom: 1 });
    const dualUwWide = dualWide({ minZoom: 1 });
    const sel = selectCaptureDevice([uw, triple, dualUwWide], {
      preferDepth: true,
    });
    expect(sel.device).toBe(dualUwWide);
  });

  it('wide+tele is the LAST RESORT: picked only when no full-FOV depth mount exists', () => {
    const plainWide = standaloneWide();
    const uw = standaloneUltraWide();
    const dualTele = dualWideTele();
    const sel = selectCaptureDevice([plainWide, uw, dualTele], {
      preferDepth: true,
    });
    expect(sel.device).toBe(dualTele); // documented tele-FOV trade
  });

  it('rank DOMINATES torch: torchless LiDAR beats a torch-bearing wide+tele', () => {
    const uw = standaloneUltraWide();
    const dualTeleTorch = dualWideTele({ hasTorch: true });
    const lidarNoTorch = lidarDepthCam({ hasTorch: false });
    const sel = selectCaptureDevice([uw, dualTeleTorch, lidarNoTorch], {
      preferDepth: true,
    });
    expect(sel.device).toBe(lidarNoTorch);
    expect(sel.hasTorch).toBe(false); // honest: this mount can't flash
  });

  it('depth DOMINATES torch: torchless virtual beats a torch-bearing plain wide', () => {
    const plainWideTorch = standaloneWide({ hasTorch: true });
    const uw = standaloneUltraWide();
    const dualNoTorch = dualWideTele({ hasTorch: false });
    const sel = selectCaptureDevice([plainWideTorch, uw, dualNoTorch], {
      preferDepth: true,
    });
    expect(sel.device).toBe(dualNoTorch);
  });

  it('torch tiebreaks WITHIN a rank (torch-bearing triple over torchless dual-wide)', () => {
    const uw = standaloneUltraWide();
    const dualUwWideNoTorch = dualWide({ minZoom: 1, hasTorch: false });
    const tripleTorch = tripleCam({ minZoom: 1, hasTorch: true });
    const sel = selectCaptureDevice([uw, dualUwWideNoTorch, tripleTorch], {
      preferDepth: true,
    });
    expect(sel.device).toBe(tripleTorch);
  });

  it('no depth-capable virtual → plain-wide pick unchanged', () => {
    const plainWide = standaloneWide();
    const uw = standaloneUltraWide();
    const sel = selectCaptureDevice([plainWide, uw], { preferDepth: true });
    expect(sel.mode).toBe('standalone-uw');
    expect(sel.device).toBe(plainWide);
  });

  it('multicam mode is UNAFFECTED (wide+uw virtual already depth-capable)', () => {
    const wideUwVirtual = dualWide();
    const plain = selectCaptureDevice([wideUwVirtual]);
    const depth = selectCaptureDevice([wideUwVirtual], { preferDepth: true });
    expect(depth.mode).toBe('multicam');
    expect(depth.device).toBe(plain.device);
  });

  it('wide-only: virtual wins under preferDepth, plain wide without', () => {
    const plainWide = standaloneWide();
    const dual = dualWideTele();
    const base = selectCaptureDevice([plainWide, dual]);
    expect(base.mode).toBe('wide-only');
    expect(base.device).toBe(plainWide); // simplest-wide regression guard
    const depth = selectCaptureDevice([plainWide, dual], { preferDepth: true });
    expect(depth.mode).toBe('wide-only');
    expect(depth.device).toBe(dual);
  });

  it('DEFAULT (no opts) keeps the simplest-wide pick — 09d41e7 regression guard', () => {
    const plainWide = standaloneWide();
    const uw = standaloneUltraWide();
    const dual = dualWideTele();
    const lidar = lidarDepthCam();
    const sel = selectCaptureDevice([dual, lidar, plainWide, uw]);
    expect(sel.device).toBe(plainWide);
  });
});

describe('zoomForLens (multicam lens→zoom mapping)', () => {
  const d = { minZoom: 0.5, neutralZoom: 1 };

  it('maps 0.5× to the device minZoom (ultra-wide end)', () => {
    expect(zoomForLens(d, '0.5x')).toBe(0.5);
  });

  it('maps 1× to the device neutralZoom (wide-angle baseline)', () => {
    expect(zoomForLens(d, '1x')).toBe(1);
  });

  it('handles a device whose neutralZoom differs from 1', () => {
    expect(zoomForLens({ minZoom: 0.6, neutralZoom: 2 }, '1x')).toBe(2);
    expect(zoomForLens({ minZoom: 0.6, neutralZoom: 2 }, '0.5x')).toBe(0.6);
  });
});
