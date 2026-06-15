// SPDX-License-Identifier: Apache-2.0
/**
 * guidanceTokens — the single source of truth for the panorama capture
 * GUIDANCE visual language (rotate prompt, pan how-to, countdown, too-fast
 * pill, lateral popup).  Values are taken verbatim from the design handoff
 * ("Camera Capture Guides") so every guidance surface shares exact styling
 * instead of re-declaring colors per component.
 *
 * The two looping device-motion graphics are drawn programmatically (see
 * ./guidanceGraphics — pure RN View + Animated, no image assets); these
 * tokens cover both those graphics and the code-built chrome around them.
 */

export const GUIDANCE_TOKENS = {
  /** Device outline, caption text, countdown number. */
  white: '#FFFFFF',
  /** Rotation ring/arrow, pan guide line, dots, glow — the one accent. */
  amber: '#FFC462',
  /** Caption-pill / popup background scrim. */
  scrim: 'rgba(0,0,0,0.42)',
  /** Pill hairline border. */
  hairline: 'rgba(255,255,255,0.16)',
  /** On-screen size (px square) of the rotate / pan guidance graphics. */
  graphicSize: 240,
} as const;

/**
 * Caption-pill spec (item 2 "Rotate to landscape" + reused by the too-fast
 * pill): full pill, scrim bg, hairline border, amber leading dot, white
 * 13px/600 text.
 */
export const GUIDANCE_PILL = {
  paddingVertical: 8,
  paddingHorizontal: 15,
  borderRadius: 999,
  dotSize: 6,
  dotGap: 7,
  fontSize: 13,
  fontWeight: '600' as const,
} as const;

/**
 * Countdown spec (item 5): amber dot + glow, white 30px/700 tabular-nums
 * number, whole timer blinks opacity 0.18↔1 over a 1s ease-in-out cycle.
 */
export const GUIDANCE_COUNTDOWN = {
  dotSize: 9,
  dotGap: 8,
  dotGlow: 'rgba(255,196,98,0.85)',
  fontSize: 30,
  fontWeight: '700' as const,
  blinkMinOpacity: 0.18,
  blinkMaxOpacity: 1,
  blinkPeriodMs: 1000,
  /** top/left inset from the (user-perceived) corner. */
  inset: 16,
} as const;
