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
 * ## Why the caption counter-rotates but the graphic does not
 *
 * The host app is typically portrait-locked, so when the user tilts to
 * landscape the OS does NOT rotate the framebuffer and JS-"up" stays at
 * the device's side edge.  The graphic is gravity-agnostic line art (a
 * rotating phone, drawn in code) so it reads correctly at any angle and
 * is left un-rotated.  The caption is *text*, so we counter-rotate it via
 * `useContentRotation()` — the same hook the bottom controls use — so
 * the words stay upright in the user's view as they rotate.  Once the
 * device reaches landscape the host flips `visible` to false and the
 * prompt disappears anyway, but the counter-rotation keeps the text
 * legible during the in-between tilt.
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
  // Counter-rotate the caption so the text stays upright relative to
  // gravity while the device is mid-tilt.  Called before the early
  // return so the hook order stays stable across visible toggles.
  const captionRotation = useContentRotation();

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
      {/* Code-drawn rotating-phone graphic (decorative — the caption
          carries the instruction for assistive tech). */}
      <RotatePhoneGraphic
        playing={visible}
        target={target}
        // Gravity-agnostic line art: read correctly at any tilt, so it is
        // intentionally NOT counter-rotated (unlike the text caption).
      />

      <View style={[styles.pill, captionRotation]}>
        <View style={styles.dot} />
        <Text style={styles.caption} numberOfLines={1}>
          {copy}
        </Text>
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
