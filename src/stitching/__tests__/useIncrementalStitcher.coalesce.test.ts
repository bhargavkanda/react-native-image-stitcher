// SPDX-License-Identifier: Apache-2.0
/**
 * perf-3a change 4 — unit coverage for the coalescer's pure logic:
 * `stickyMergeIncremental` (keep last-good snapshot between accepts) and
 * `isImmediateIncrementalEvent` (accept / refine-stage → immediate flush;
 * everything else coalesces). The rAF orchestration inside the hook needs
 * a rendered hook (no test infra here — node env, no testing-library) and
 * is covered by the on-device verify + adversarial review; this pins the
 * classification + merge contract those depend on so a future edit can't
 * silently reclassify accepts as coalesced (which would drop keyframe
 * thumbnails / lag the strip).
 */

import {
  stickyMergeIncremental,
  isImmediateIncrementalEvent,
} from '../useIncrementalStitcher';
import { IncrementalOutcome, type IncrementalState } from '../incremental';

function mk(o: Partial<IncrementalState>): IncrementalState {
  return {
    panoramaPath: null,
    width: 0,
    height: 0,
    acceptedCount: 0,
    outcome: IncrementalOutcome.SkippedTooClose,
    confidence: 0,
    overlapPercent: -1,
    ...o,
  } as IncrementalState;
}

describe('stickyMergeIncremental', () => {
  it('keeps the previous snapshot when the next event has none', () => {
    const prev = mk({ panoramaPath: '/pano-1.jpg', width: 800, height: 600, acceptedCount: 2 });
    const next = mk({ panoramaPath: null, acceptedCount: 2, outcome: IncrementalOutcome.RejectedTooFar });
    const merged = stickyMergeIncremental(prev, next);
    expect(merged.panoramaPath).toBe('/pano-1.jpg');
    expect(merged.width).toBe(800);
    expect(merged.height).toBe(600);
    // Non-snapshot fields come from `next`.
    expect(merged.outcome).toBe(IncrementalOutcome.RejectedTooFar);
  });

  it('replaces the snapshot when the next event carries one', () => {
    const prev = mk({ panoramaPath: '/pano-1.jpg', width: 800, height: 600 });
    const next = mk({ panoramaPath: '/pano-2.jpg', width: 900, height: 650, acceptedCount: 3 });
    const merged = stickyMergeIncremental(prev, next);
    expect(merged.panoramaPath).toBe('/pano-2.jpg');
    expect(merged.width).toBe(900);
  });

  it('passes through when there is no previous snapshot', () => {
    const next = mk({ panoramaPath: null, outcome: IncrementalOutcome.RejectedTooFar });
    expect(stickyMergeIncremental(null, next)).toBe(next);
  });
});

describe('isImmediateIncrementalEvent', () => {
  it('is immediate when a keyframe thumbnail is present', () => {
    const e = mk({ batchKeyframeThumbnailPath: '/keyframe-0.jpg', acceptedCount: 1 });
    expect(isImmediateIncrementalEvent(e, 0, undefined)).toBe(true);
  });

  it('is immediate when the accepted count increases', () => {
    const e = mk({ acceptedCount: 3, outcome: IncrementalOutcome.SkippedTooClose });
    expect(isImmediateIncrementalEvent(e, 2, undefined)).toBe(true);
  });

  it('is immediate on an Accepted* outcome', () => {
    expect(isImmediateIncrementalEvent(mk({ outcome: IncrementalOutcome.AcceptedHigh }), 5, undefined)).toBe(true);
    expect(isImmediateIncrementalEvent(mk({ outcome: IncrementalOutcome.AcceptedMedium }), 5, undefined)).toBe(true);
  });

  it('is immediate on a refine-stage transition (incl. terminal done/error)', () => {
    expect(isImmediateIncrementalEvent(mk({ refineStage: 'stitching' }), 0, 'validating')).toBe(true);
    expect(isImmediateIncrementalEvent(mk({ refineStage: 'done' }), 0, 'writing')).toBe(true);
    expect(isImmediateIncrementalEvent(mk({ refineStage: 'error' }), 0, 'validating')).toBe(true);
  });

  it('is NOT immediate for the same refine stage repeating', () => {
    expect(isImmediateIncrementalEvent(mk({ refineStage: 'stitching' }), 0, 'stitching')).toBe(false);
  });

  it('COALESCES a reject/skip tick (no thumbnail, no count change, non-accept)', () => {
    const reject = mk({ acceptedCount: 2, outcome: IncrementalOutcome.RejectedTooFar });
    expect(isImmediateIncrementalEvent(reject, 2, undefined)).toBe(false);
    const skip = mk({ acceptedCount: 2, outcome: IncrementalOutcome.SkippedTooClose });
    expect(isImmediateIncrementalEvent(skip, 2, undefined)).toBe(false);
    const overlap = mk({ acceptedCount: 2, outcome: IncrementalOutcome.SkippedKeyframeOverlap, overlapPercent: 88 });
    expect(isImmediateIncrementalEvent(overlap, 2, undefined)).toBe(false);
  });
});
