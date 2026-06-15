// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `countdownSecondsFrom` + `shouldAutoStop` — the pure
 * timing helpers behind the recording countdown + auto-finalize (guidance
 * item 5).
 *
 * Boundary focus: the auto-stop must fire at EXACTLY `maxMs` (not a frame
 * late), the displayed seconds must `ceil` (tick down only once strictly
 * fewer than N seconds remain), and both ends clamp.  `maxMs <= 0` disables
 * the feature entirely.
 *
 * Pure-TS test per jest.config.js — `captureCountdown.ts` has no imports,
 * so no module stubbing is needed.
 */

import {
  countdownSecondsFrom,
  shouldAutoStop,
} from '../captureCountdown';

const MAX = 9_000; // 9s window (the product default for item 5).
const START = 1_000_000; // arbitrary epoch-ish start instant.

describe('countdownSecondsFrom', () => {
  it('shows the full window before recording (start = null)', () => {
    expect(countdownSecondsFrom(null, START, MAX)).toBe(9);
  });

  it('shows the full window at the instant recording starts (elapsed 0)', () => {
    expect(countdownSecondsFrom(START, START, MAX)).toBe(9);
  });

  it('ceil: still reads 9 with 1ms elapsed (8.999s remain)', () => {
    expect(countdownSecondsFrom(START, START + 1, MAX)).toBe(9);
  });

  it('ceil: reads 8 only once strictly under 8s remain', () => {
    // Exactly 8s remain (1s elapsed) → ceil(8) = 8.
    expect(countdownSecondsFrom(START, START + 1_000, MAX)).toBe(8);
    // 1ms past that → 7.999s remain → ceil = 8 (not yet 7).
    expect(countdownSecondsFrom(START, START + 1_001, MAX)).toBe(8);
  });

  it('mid-window: ~4.5s elapsed → 5 remaining (ceil of 4.5)', () => {
    expect(countdownSecondsFrom(START, START + 4_500, MAX)).toBe(5);
  });

  it('reads 1 in the final second (8.5s elapsed)', () => {
    expect(countdownSecondsFrom(START, START + 8_500, MAX)).toBe(1);
  });

  it('reaches 0 exactly at elapsed === maxMs', () => {
    expect(countdownSecondsFrom(START, START + MAX, MAX)).toBe(0);
  });

  it('clamps at 0 when the clock runs past the ceiling', () => {
    expect(countdownSecondsFrom(START, START + MAX + 5_000, MAX)).toBe(0);
  });

  it('clamps at the full window if now precedes start (negative elapsed)', () => {
    expect(countdownSecondsFrom(START, START - 5_000, MAX)).toBe(9);
  });

  it('rounds a non-1000-multiple window for the at-rest value', () => {
    // 9500ms → round(9.5) = 10 (round-half-up).
    expect(countdownSecondsFrom(null, START, 9_500)).toBe(10);
  });

  it('returns 0 when the feature is disabled (maxMs = 0)', () => {
    expect(countdownSecondsFrom(null, START, 0)).toBe(0);
    expect(countdownSecondsFrom(START, START + 1_000, 0)).toBe(0);
  });

  it('returns 0 when maxMs is negative (disabled)', () => {
    expect(countdownSecondsFrom(START, START + 1_000, -1)).toBe(0);
  });
});

describe('shouldAutoStop', () => {
  it('does NOT stop before recording starts (start = null)', () => {
    expect(shouldAutoStop(null, START + MAX + 1_000, MAX)).toBe(false);
  });

  it('does NOT stop mid-window (elapsed < maxMs)', () => {
    expect(shouldAutoStop(START, START + MAX - 1, MAX)).toBe(false);
  });

  it('STOPS at exactly the boundary (elapsed === maxMs)', () => {
    expect(shouldAutoStop(START, START + MAX, MAX)).toBe(true);
  });

  it('STOPS past the boundary (elapsed > maxMs)', () => {
    expect(shouldAutoStop(START, START + MAX + 5_000, MAX)).toBe(true);
  });

  it('never stops when the feature is disabled (maxMs = 0)', () => {
    expect(shouldAutoStop(START, START + 100_000, 0)).toBe(false);
  });

  it('never stops when maxMs is negative (disabled)', () => {
    expect(shouldAutoStop(START, START + 100_000, -1)).toBe(false);
  });
});
