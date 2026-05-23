// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure `isBelowMemThreshold` classifier.
 *
 * The other two exports (`getPhysicalMemoryBytes` and `isLowMemDevice`)
 * read the React Native bridge and can only be exercised on a real
 * device.  This file covers the threshold logic exhaustively so the
 * classification rule is unit-tested without needing the RN runtime.
 */

import {
  LOW_MEM_THRESHOLD_BYTES,
  isBelowMemThreshold,
} from '../lowMemDevice';


describe('isBelowMemThreshold', () => {
  it('returns true for positive byte counts below the threshold', () => {
    expect(isBelowMemThreshold(1)).toBe(true);
    expect(isBelowMemThreshold(1024)).toBe(true);
    expect(isBelowMemThreshold(LOW_MEM_THRESHOLD_BYTES - 1)).toBe(true);
  });

  it('returns false at exactly the threshold (strict < comparison)', () => {
    expect(isBelowMemThreshold(LOW_MEM_THRESHOLD_BYTES)).toBe(false);
  });

  it('returns false for byte counts above the threshold', () => {
    expect(isBelowMemThreshold(LOW_MEM_THRESHOLD_BYTES + 1)).toBe(false);
    expect(isBelowMemThreshold(4 * 1024 * 1024 * 1024)).toBe(false);
    expect(isBelowMemThreshold(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('returns false for zero (unknown — safe default to high-quality combo)', () => {
    expect(isBelowMemThreshold(0)).toBe(false);
  });

  it('returns false for negative values (defensive)', () => {
    expect(isBelowMemThreshold(-1)).toBe(false);
    expect(isBelowMemThreshold(-LOW_MEM_THRESHOLD_BYTES)).toBe(false);
  });

  it('returns false for non-finite values (NaN / Infinity)', () => {
    expect(isBelowMemThreshold(Number.NaN)).toBe(false);
    expect(isBelowMemThreshold(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isBelowMemThreshold(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('threshold is exactly 2 GB', () => {
    expect(LOW_MEM_THRESHOLD_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});
