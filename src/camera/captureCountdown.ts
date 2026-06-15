// SPDX-License-Identifier: Apache-2.0
/**
 * captureCountdown — pure timing helpers for the recording-time countdown
 * and auto-finalize (guidance item 5).
 *
 * The non-AR panorama hold-and-pan has a hard recording ceiling (`maxMs`).
 * As the user pans, a blinking countdown shows the whole seconds remaining;
 * when it hits 0 the host auto-finalizes (stops recording and stitches what
 * was captured — the FINALIZE-on-zero decision is handled by `<Camera>`,
 * not here).
 *
 * Both functions are pure (no React, no timers, no `Date.now()` baked in —
 * the caller threads `now` from its own animation frame / interval) so the
 * boundary behaviour is unit-testable in the node jest env.  Mirrors the
 * pure-helper + `__tests__` pattern of `contentRotationDeg`.
 *
 * `maxMs <= 0` DISABLES the feature: `shouldAutoStop` never returns true
 * (recording is unbounded) and the countdown is meant to be hidden by the
 * caller.  `countdownSecondsFrom` still returns a clamped, non-negative
 * number in that case (0) so a caller that renders it regardless won't show
 * a negative value.
 */


/**
 * Whole seconds remaining in the recording window, for the countdown UI.
 *
 *   - While recording (`recordingStartedAt` non-null):
 *       `ceil((maxMs - elapsed) / 1000)`, where `elapsed = now - start`,
 *       clamped to `[0, round(maxMs / 1000)]`.  `ceil` means the displayed
 *       number ticks to N only once strictly fewer than N seconds remain
 *       (e.g. at exactly 1 ms before the 1s boundary it still reads the
 *       higher value), and it reaches 0 exactly at `elapsed === maxMs`.
 *   - Before recording (`recordingStartedAt === null`): the full window,
 *       `round(maxMs / 1000)` — the at-rest value shown before the user
 *       starts the hold.
 *   - `maxMs <= 0` (feature disabled): returns 0.
 *
 * The result is always a whole, non-negative number.
 */
export function countdownSecondsFrom(
  recordingStartedAt: number | null,
  now: number,
  maxMs: number,
): number {
  if (maxMs <= 0) return 0;

  const maxSeconds = Math.round(maxMs / 1000);

  // Not recording yet — show the full window at rest.
  if (recordingStartedAt === null) return maxSeconds;

  const elapsed = now - recordingStartedAt;
  const remainingSeconds = Math.ceil((maxMs - elapsed) / 1000);

  // Clamp into [0, maxSeconds]: guards a clock that ran past the ceiling
  // (negative remaining → 0) and a `now` before the start (`elapsed < 0`,
  // remaining > maxSeconds → maxSeconds).
  return Math.min(maxSeconds, Math.max(0, remainingSeconds));
}


/**
 * True when the host should auto-finalize the recording NOW.
 *
 * Fires only when ALL of:
 *   1. recording (`recordingStartedAt` non-null),
 *   2. the window is enabled (`maxMs > 0`), AND
 *   3. elapsed (`now - start`) has reached or passed the ceiling
 *      (`>= maxMs`).
 *
 * `maxMs <= 0` disables auto-stop entirely (unbounded recording), so this
 * returns false regardless of how long the user has been recording.
 */
export function shouldAutoStop(
  recordingStartedAt: number | null,
  now: number,
  maxMs: number,
): boolean {
  if (recordingStartedAt === null) return false;
  if (maxMs <= 0) return false;
  return now - recordingStartedAt >= maxMs;
}
