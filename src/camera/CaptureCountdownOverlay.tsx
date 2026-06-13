// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureCountdownOverlay — the blinking auto-stop countdown shown at the
 * user-perceived TOP-LEFT during an in-progress panorama capture (item 5
 * of the first-time-user GUIDANCE flow).
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  ● 9                                              │ ← top-left, blinks
 *   │                                                   │
 *   │            (camera preview / pan in progress)     │
 *   │                                                   │
 *   └──────────────────────────────────────────────────┘
 *
 * Why this exists
 *   The capture auto-finalizes after a fixed window (the parent owns the
 *   real timer — see Camera's `countdownSecondsFrom`).  Without a visible
 *   counter the auto-stop feels abrupt ("why did it stop?").  A calm
 *   blinking "● N" tells the user how many seconds of pan they have left.
 *
 * What it does
 *   - Renders an amber glow dot + a white tabular-nums integer
 *     (`secondsRemaining`, computed by the parent) using the shared
 *     {@link GUIDANCE_COUNTDOWN} design tokens.
 *   - Pins itself to the user-perceived top-left corner across all four
 *     device orientations.  The app layout is portrait-locked, so — like
 *     {@link CaptureStatusOverlay} / {@link PanoramaGuidance} — we anchor
 *     to the matching layout corner and apply a rotation transform so the
 *     number reads upright in the user's hold.
 *   - Blinks the WHOLE timer (dot + number) between
 *     `GUIDANCE_COUNTDOWN.blinkMinOpacity` and `blinkMaxOpacity` over
 *     `blinkPeriodMs` with an ease-in-out loop on the native driver.
 *
 * The displayed number is COSMETIC only — the parent owns the auth­oritative
 * auto-stop timer and computes `secondsRemaining`.  This component never
 * fires a stop; it purely visualises the remaining time, so a dropped frame
 * or a re-render hiccup can never desync from (or pre-empt) the real timer.
 *
 * Pure-presentational and `pointerEvents="none"`: it never steals taps from
 * the camera / shutter beneath it, and renders nothing when `!visible` so
 * the host can mount it unconditionally without layout shifts.
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { GUIDANCE_COUNTDOWN, GUIDANCE_TOKENS } from './guidanceTokens';
import { type DeviceOrientation } from './useDeviceOrientation';


export interface CaptureCountdownOverlayProps {
  /**
   * Show / hide.  Driven by the host while a capture is in progress
   * (typically `statusPhase === 'recording'`).  Renders nothing when
   * false so the host can mount it unconditionally.
   */
  visible: boolean;
  /**
   * Whole seconds of capture remaining, as computed by the parent's
   * authoritative timer (Camera's `countdownSecondsFrom`).  Displayed
   * verbatim via `Math.max(0, Math.round(...))` so a fractional or
   * transiently-negative value never renders as "-0" or "3.0".
   *
   * COSMETIC ONLY — this component does not own the auto-stop.
   */
  secondsRemaining: number;
  /**
   * Physical device orientation (typically from `useDeviceOrientation`).
   * Drives the corner anchoring + rotation so the number sits at the
   * user-perceived top-left and reads upright.
   */
  orientation: DeviceOrientation;
  /** Outer style passthrough. */
  style?: StyleProp<ViewStyle>;
}


export function CaptureCountdownOverlay({
  visible,
  secondsRemaining,
  orientation,
  style,
}: CaptureCountdownOverlayProps): React.JSX.Element | null {
  // Single Animated.Value looping min→max→min drives the whole-timer
  // blink.  Cheap (no JS listeners, native driver) and only spins up
  // while visible; torn down on hide so the loop isn't running the
  // rest of the time the screen is up.
  const blink = useRef(
    new Animated.Value(GUIDANCE_COUNTDOWN.blinkMaxOpacity),
  ).current;

  useEffect(() => {
    if (!visible) {
      // Reset to fully-opaque so the next show starts bright rather
      // than mid-fade.
      blink.setValue(GUIDANCE_COUNTDOWN.blinkMaxOpacity);
      return;
    }
    // Symmetric fade down + back up, so a full min→max→min cycle takes
    // `blinkPeriodMs` (each half-leg is half the period).
    const halfPeriod = GUIDANCE_COUNTDOWN.blinkPeriodMs / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, {
          toValue: GUIDANCE_COUNTDOWN.blinkMinOpacity,
          duration: halfPeriod,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(blink, {
          toValue: GUIDANCE_COUNTDOWN.blinkMaxOpacity,
          duration: halfPeriod,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, blink]);

  if (!visible) return null;

  // Clamp to a non-negative integer.  The parent's timer may briefly
  // report a fractional or sub-zero value at the auto-stop boundary;
  // we never want to render "-1" or "2.4".
  const displaySeconds = Math.max(0, Math.round(secondsRemaining));

  const cornerStyle = countdownStyleForOrientation(orientation);

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.root, cornerStyle, { opacity: blink }, style]}
      accessibilityRole="timer"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${displaySeconds} seconds remaining`}
    >
      <View style={styles.dot} />
      <Text style={styles.number} numberOfLines={1} allowFontScaling={false}>
        {displaySeconds}
      </Text>
    </Animated.View>
  );
}


/**
 * Style placing the countdown at the user-perceived TOP-LEFT corner with
 * the number reading upright in the user's hold, inset by
 * `GUIDANCE_COUNTDOWN.inset` from that corner.
 *
 * Mirrors the corner-anchor + percentage-translate self-centering of
 * {@link CaptureStatusOverlay}'s `bannerStyleForOrientation`, but anchored
 * to the user's top-LEFT instead of top-center.  For each orientation we
 * anchor the row to the layout corner that maps to the user's top-left,
 * then rotate the row about its center so it reads upright:
 *
 *   portrait              → layout top-left,     0°
 *   landscape-left        → layout bottom-left, +90°
 *   landscape-right       → layout top-right,   -90°
 *   portrait-upside-down  → layout bottom-right, 180°
 *
 * The `translate('±50%')` pair pins the row's CENTER a fixed `inset`
 * from the chosen corner so the post-rotation top-left edge lands at
 * `inset` regardless of the row's own width/height — the same trick the
 * banner uses to stay corner-aligned without measuring its content.
 */
function countdownStyleForOrientation(
  orientation: DeviceOrientation,
): ViewStyle {
  const { inset } = GUIDANCE_COUNTDOWN;
  switch (orientation) {
    case 'landscape-left':
      // Device held so user-top runs along the layout LEFT edge; the
      // user's top-left maps to the layout BOTTOM-left.  +90° makes the
      // row read upright.
      return {
        position: 'absolute',
        bottom: inset,
        left: inset,
        transform: [
          { translateX: '50%' },
          { translateY: '-50%' },
          { rotate: '90deg' },
        ],
      };
    case 'landscape-right':
      // User-top runs along the layout RIGHT edge; user's top-left maps
      // to the layout TOP-right.  -90° makes the row read upright.
      return {
        position: 'absolute',
        top: inset,
        right: inset,
        transform: [
          { translateX: '-50%' },
          { translateY: '50%' },
          { rotate: '-90deg' },
        ],
      };
    case 'portrait-upside-down':
      // User-top-left maps to the layout BOTTOM-right; 180° flips the row.
      return {
        position: 'absolute',
        bottom: inset,
        right: inset,
        transform: [
          { translateX: '-50%' },
          { translateY: '-50%' },
          { rotate: '180deg' },
        ],
      };
    case 'portrait':
    default:
      return {
        position: 'absolute',
        top: inset,
        left: inset,
        transform: [
          { translateX: '50%' },
          { translateY: '50%' },
        ],
      };
  }
}


const styles = StyleSheet.create({
  root: {
    // position: 'absolute' is re-applied by countdownStyleForOrientation
    // alongside the corner offsets + transform; kept here too so the row
    // lays out as a self-sized box even before the orientation style
    // merges in.
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: GUIDANCE_COUNTDOWN.dotSize,
    height: GUIDANCE_COUNTDOWN.dotSize,
    borderRadius: GUIDANCE_COUNTDOWN.dotSize / 2,
    backgroundColor: GUIDANCE_TOKENS.amber,
    marginRight: GUIDANCE_COUNTDOWN.dotGap,
    // Amber glow around the dot.  iOS honours all four shadow props;
    // Android renders the glow via `elevation` (set below) since RN
    // ignores view shadowColor there.
    shadowColor: GUIDANCE_COUNTDOWN.dotGlow,
    shadowOpacity: 1,
    shadowRadius: GUIDANCE_COUNTDOWN.dotSize,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  number: {
    color: GUIDANCE_TOKENS.white,
    fontSize: GUIDANCE_COUNTDOWN.fontSize,
    fontWeight: GUIDANCE_COUNTDOWN.fontWeight,
    // Tabular figures keep the glyph box a fixed width so the number
    // doesn't jitter horizontally as it ticks 9→8→…→0.
    fontVariant: ['tabular-nums'],
    // Drop shadow for legibility over a bright/busy preview.
    textShadowColor: GUIDANCE_TOKENS.scrim,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
