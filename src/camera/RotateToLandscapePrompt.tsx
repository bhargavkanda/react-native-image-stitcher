// SPDX-License-Identifier: Apache-2.0
/**
 * RotateToLandscapePrompt — full-screen, non-interactive overlay shown
 * while a Mode-A (landscape, top→bottom pan) capture is waiting for the
 * user to physically rotate the device to landscape.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                  (faint scrim over preview)               │
 *   │                                                           │
 *   │                    ┌───────────────┐                      │
 *   │                    │   ⟳  phone    │  ← code-drawn        │
 *   │                    │   line-art    │     (240px square)   │
 *   │                    └───────────────┘                      │
 *   │                                                           │
 *   │             ●  Rotate to landscape   ← caption pill       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Item 2 of the first-time-user guidance set.  It is the first thing a
 * user sees after starting a landscape-only capture in portrait — the
 * GIF demonstrates the rotation gesture and the pill names the goal.
 *
 * ## Pure-presentational
 *
 * The component owns no orientation/eligibility logic: the host
 * (`<Camera>`) decides *when* a Mode-A capture is blocked on rotation
 * and drives `visible`.  When `visible` is false we render `null` so
 * the host can mount us unconditionally without layout churn — mirrors
 * `CaptureStatusOverlay`'s `idle` → `null` contract.
 *
 * ## Why the WHOLE prompt counter-rotates
 *
 * The host app is typically portrait-locked, so when the user tilts to
 * landscape the OS does NOT rotate the framebuffer and JS-"up" stays at
 * the device's side edge.  We counter-rotate the entire prompt (graphic
 * + caption) via `useContentRotation()` — the same hook the bottom
 * controls use — so it reads upright relative to actual gravity.
 *
 * This matters for BOTH children, not just the text:
 *   - the **caption** is text and must read left-to-right;
 *   - the **graphic is now directional** — its camera dot starts on one
 *     edge and rotates to another to demonstrate the gesture, so an
 *     un-rotated graphic in a landscape hold reads 90° off (the dot
 *     appears to start "down" and travel "left" instead of "left" →
 *     "top").  It is therefore counter-rotated with the caption.
 *   - the column **layout** (caption below the graphic) also only reads
 *     as a physical column once the wrapper is upright — otherwise
 *     "below" lands at the physical side edge.
 *
 * (An earlier version rotated only the caption, back when the graphic
 * was a symmetric spinner with no start/end direction.)  In a portrait
 * hold the hook returns 0° so this is a no-op; once the device reaches
 * the target orientation the host flips `visible` to false anyway, but
 * the counter-rotation keeps everything legible during the in-between
 * tilt.
 *
 * ## Accessibility
 *
 * `accessibilityRole='alert'` + `accessibilityLiveRegion='polite'` so
 * VoiceOver / TalkBack announce the rotation instruction when the
 * prompt appears (and re-announce if the copy changes), matching the
 * pattern in `PanoramaGuidance`.
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { DEFAULT_GUIDANCE_COPY } from './cameraGuidanceCopy';
import { RotatePhoneGraphic } from './guidanceGraphics';
import { GUIDANCE_PILL, GUIDANCE_TOKENS } from './guidanceTokens';
import { useContentRotation } from './useContentRotation';


export interface RotateToLandscapePromptProps {
  /**
   * Show / hide.  Driven by the host while a Mode-A capture is blocked
   * on the user rotating to landscape.  `false` renders nothing.
   */
  visible: boolean;
  /**
   * Caption copy.  Defaults to `DEFAULT_GUIDANCE_COPY.rotateToLandscape`
   * ("Rotate to landscape").  Hosts localise via the `guidanceCopy`
   * `<Camera>` prop and pass the resolved string here.  When `target` is
   * `'portrait'`, pass the rotate-to-portrait copy.
   */
  copy?: string;
  /**
   * Orientation to rotate TO: `'landscape'` (default, panMode `'vertical'`)
   * or `'portrait'` (panMode `'horizontal'`).  Drives the rotating-phone
   * graphic's direction.
   */
  target?: 'landscape' | 'portrait';
  /** Outer style passthrough (applied to the absolute-fill root). */
  style?: StyleProp<ViewStyle>;
}


export function RotateToLandscapePrompt({
  visible,
  copy = DEFAULT_GUIDANCE_COPY.rotateToLandscape,
  target = 'landscape',
  style,
}: RotateToLandscapePromptProps): React.JSX.Element | null {
  // Counter-rotate the WHOLE prompt so it reads upright relative to
  // gravity while the device is mid-tilt (locked-portrait hosts) — see
  // the file header.  Called before the early return so the hook order
  // stays stable across visible toggles.
  const contentRotation = useContentRotation();

  if (!visible) return null;

  return (
    <View
      // pointerEvents=none — the prompt is read-only and must never
      // steal taps from the camera / shutter beneath it.
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.root, style]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      {/* Graphic + caption share ONE counter-rotated column so both the
          directional graphic and the "caption below" layout stay correct
          relative to gravity (see header).  In portrait the rotation is a
          no-op. */}
      <View style={[styles.content, contentRotation]}>
        {/* Code-drawn rotating-phone graphic (decorative — the caption
            carries the instruction for assistive tech). */}
        <RotatePhoneGraphic playing={visible} target={target} />

        <View style={styles.pill}>
          <View style={styles.dot} />
          <Text style={styles.caption} numberOfLines={1}>
            {copy}
          </Text>
        </View>
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  root: {
    // Faint scrim over the live preview so the white line-art graphic and
    // caption read against bright scenes, while the preview stays
    // visible underneath (the user is framing a rotation, not a shot).
    backgroundColor: GUIDANCE_TOKENS.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Counter-rotated column holding the graphic + caption.  Rotating this
  // wrapper (not the children individually) keeps the "caption below the
  // graphic" relationship intact while orienting the pair to gravity.
  content: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    // Caption pill directly below the rotating-phone graphic (both are
    // centred in the column by the root's center alignment).
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: GUIDANCE_PILL.paddingVertical,
    paddingHorizontal: GUIDANCE_PILL.paddingHorizontal,
    borderRadius: GUIDANCE_PILL.borderRadius,
    backgroundColor: GUIDANCE_TOKENS.scrim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: GUIDANCE_TOKENS.hairline,
  },
  dot: {
    width: GUIDANCE_PILL.dotSize,
    height: GUIDANCE_PILL.dotSize,
    borderRadius: GUIDANCE_PILL.dotSize / 2,
    backgroundColor: GUIDANCE_TOKENS.amber,
    marginRight: GUIDANCE_PILL.dotGap,
  },
  caption: {
    color: GUIDANCE_TOKENS.white,
    fontSize: GUIDANCE_PILL.fontSize,
    fontWeight: GUIDANCE_PILL.fontWeight,
  },
});
