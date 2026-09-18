// SPDX-License-Identifier: Apache-2.0
// THE HARD FAULTS MUST REACH THE SCREEN DURING THE SWEEP.
//
// ── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
// The surface's policy comment says "WHILE SWEEPING the HUD carries the
// headline AND HARD FAULTS, and nothing else". The code shipped
// `{!sweeping && <hud/>}`, which is only the first half — and because a status
// with `painted > 0` exists ONLY while sweeping, the HUD was mounted exactly
// when it had nothing to say and unmounted exactly when it did.
//
// That took down four warnings at once, three of which predate the shear rung:
// v5 CUTS, v6/v8 BAND, the drops line, and SHEAR. Every one of them exists
// because of a field incident, and every one is only actionable DURING the
// sweep it was supposed to save.
//
// The bug was invisible to the whole suite because `panoPlusHudLine` was
// tested directly and always returned the right STRING. Nothing asserted that
// the string reached a rendered surface in the phase where it matters. That is
// the gap this file closes: it tests the model's fault selection, and the
// render test beside it asserts the mount.

import {
  panoPlusSweepFaults,
  PANOPLUS_BAND_DIVERGENCE_NORM_BAR,
  PANOPLUS_PHOTO_DRIFT_LOCAL_BAR,
} from '../panoPlusModel';
import type { PanoPlusStatus } from '../panoPlusTypes';

const clean = {
  painted: 40,
  crossBandDivergenceNormPx: 4.0,
  integrityFailed: false,
  seamWorstBandP95Px: 0.42,
  maxAreaScale: 2.6,
  photoDriftLocalPct: 3.0,
  photoDriftBoundaries: 0,
  photoDriftOverBar: 0,
} as unknown as PanoPlusStatus;

describe('panoPlusSweepFaults — bars only, silent when healthy', () => {
  it('IS NULL ON A HEALTHY SWEEP — the operator asked for a quiet screen', () => {
    // This is what makes the fix compatible with his complaint rather than a
    // revert of it: "There is still some text shown in the pano+ screen - no
    // point of it!" was about a HEALTHY sweep.
    expect(panoPlusSweepFaults(clean)).toBeNull();
  });

  it('IS NULL BEFORE ANYTHING IS PAINTED, and on a null status', () => {
    expect(panoPlusSweepFaults(null)).toBeNull();
    expect(panoPlusSweepFaults({ ...clean, painted: 0 } as PanoPlusStatus)).toBeNull();
  });

  it('NAMES THE SHEAR AND THE CURE — the real 22-56-36 value', () => {
    // 28.41 px/√n against a 6.0 bar, the worst of the five Test-14 packs, and
    // the one that printed a healthy-looking CUTS p95 0.42 beside it.
    const s = { ...clean, crossBandDivergenceNormPx: 28.41 } as PanoPlusStatus;
    const out = panoPlusSweepFaults(s);
    expect(out).toContain('SHEAR 28.4');
    // ⚠️ AND NO GESTURE. The first cut said "PIVOT, don't walk"; this field
    // cannot see walking (v8 header correction), and walking is a SUPPORTED
    // regime with its own fixture at rotationFraction 0.00. Prescribing a cure
    // the metric cannot justify would push the operator off a gesture the
    // engine handles — the v5-v7 mislabel, repeated.
    expect(out).not.toContain('PIVOT');
    expect(out).not.toContain('walk');
    // …and nothing else: the seam and band readings on that pack are healthy,
    // so they must not ride along.
    expect(out).not.toContain('CUTS');
    expect(out).not.toContain('BAND');
  });

  it('SITS ON THE BAR, NOT NEAR IT — strictly greater, both metrics', () => {
    // Exactly at the bar is not a breach. A test that used > vs >= loosely
    // here would let the bar drift by one tick without anything noticing.
    expect(panoPlusSweepFaults({
      ...clean, crossBandDivergenceNormPx: PANOPLUS_BAND_DIVERGENCE_NORM_BAR,
    } as PanoPlusStatus)).toBeNull();
    expect(panoPlusSweepFaults({
      ...clean, photoDriftLocalPct: PANOPLUS_PHOTO_DRIFT_LOCAL_BAR,
    } as PanoPlusStatus)).toBeNull();
    expect(panoPlusSweepFaults({
      ...clean,
      crossBandDivergenceNormPx: PANOPLUS_BAND_DIVERGENCE_NORM_BAR + 0.01,
    } as PanoPlusStatus)).toContain('SHEAR');
  });

  it('CARRIES EVERY BREACHED BAR, GEOMETRY BEFORE PHOTOMETRY', () => {
    // Order is deliberate: the geometric faults are the ones a gesture can
    // still fix, so they read first.
    const out = panoPlusSweepFaults({
      ...clean,
      crossBandDivergenceNormPx: 12.0,
      integrityFailed: true,
      maxAreaScale: 6.4,
      photoDriftLocalPct: 20,
    } as PanoPlusStatus)!;
    expect(out.indexOf('SHEAR')).toBeLessThan(out.indexOf('CUTS'));
    expect(out.indexOf('WARP')).toBeLessThan(out.indexOf('BAND'));
    expect(out).toContain('WARP 6.4×');
  });
});
