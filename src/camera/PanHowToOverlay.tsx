// SPDX-License-Identifier: Apache-2.0
/**
 * PanHowToOverlay — the "how to pan" coach-mark (guidance item 3).
 *
 * Shown briefly at the START of a capture to teach the panning
 * gesture before the live pan-speed pill (`PanoramaGuidance`) takes
 * over.  It pairs the code-drawn `PanPhoneGraphic` (white phone +
 * sweeping amber band) with a code-built bouncing arrow so the
 * direction reads instantly without any copy.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                                                          │
 *   │                  ┌───────────────┐                       │
 *   │                  │  PanPhone     │   (240px graphic, the │
 *   │                  │  Graphic      │    white phone +      │
 *   │                  └───────────────┘    amber sweep)       │
 *   │                         ▼  ← amber triangle              │
 *   │                         ▼     bouncing ~12px along the   │
 *   │                              pan axis, back and forth    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Direction follows the capture mode (derived from the physical
 * device orientation, sensor-based — works under portrait-lock):
 *
 *   Mode A — LANDSCAPE  → pan TOP → BOTTOM → arrow points DOWN.
 *   Mode B — PORTRAIT   → pan LEFT → RIGHT → arrow points RIGHT.
 *
 * Both `landscape-left` and `landscape-right` are valid Mode A.
 *
 * ## Visibility & timing
 *
 * This component is intentionally pure-presentational: the PARENT
 * owns `visible` and the brief auto-fade lifecycle (mount → show →
 * dismiss once recording is under way).  We never self-time;
 * `visible === false` renders `null` so the host can mount us
 * unconditionally without layout shift.
 *
 * ## Upright under portrait-lock
 *
 * The app layout is typically portrait-locked, so when the user
 * holds the device in landscape (Mode A) the JS framebuffer is NOT
 * rotated.  We counter-rotate the whole coach-mark with
 * `useContentRotation()` (same hook the bottom controls use) so the
 * graphic and arrow read upright relative to gravity.  The arrow's
 * bounce axis and triangle point are expressed in that upright frame
 * — i.e. the user's view — so "down" / "right" mean what the user
 * sees, not the layout's raw axes.
 *
 * ## No SVG / no extra deps
 *
 * The arrow is a pure CSS border-width triangle (a zero-size View
 * whose thick coloured border on one edge + transparent borders on
 * the adjacent edges read as a filled triangle).  Bounce is a single
 * `Animated.loop` on the native driver — cheap, and only running
 * while `visible`.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { PanPhoneGraphic } from './guidanceGraphics';
import { GUIDANCE_TOKENS } from './guidanceTokens';
import { useContentRotation } from './useContentRotation';
import { type DeviceOrientation } from './useDeviceOrientation';


/** Distance (px) the arrow travels along the pan axis each bounce. */
const BOUNCE_DISTANCE = 12;
/** Half-period of the bounce (out, then back) — ~700 ms each leg. */
const BOUNCE_DURATION_MS = 700;
/** Visual size of the CSS-triangle arrow (base width / height in px). */
const ARROW_SIZE = 18;


export interface PanHowToOverlayProps {
  /**
   * Show / hide.  `false` renders `null`.  The host owns the brief
   * auto-fade lifecycle — this component never self-times.
   */
  visible: boolean;
  /**
   * Physical device orientation (sensor-based, from
   * `useDeviceOrientation`).  Selects the pan mode → arrow
   * direction: landscape-* → DOWN (Mode A), portrait-* → RIGHT
   * (Mode B).
   */
  orientation: DeviceOrientation;
  /** Outer style passthrough (positioning / opacity from the host). */
  style?: StyleProp<ViewStyle>;
}


type PanDirection = 'down' | 'right';


/**
 * Map a physical orientation to the pan direction the user should
 * sweep.  Mode A (either landscape) pans top→bottom (DOWN); Mode B
 * (either portrait variant) pans left→right (RIGHT).  Directions are
 * in the user's upright view — the content wrapper is counter-rotated
 * so these read correctly under portrait-lock.
 */
function directionForOrientation(orientation: DeviceOrientation): PanDirection {
  switch (orientation) {
    case 'landscape-left':
    case 'landscape-right':
      return 'down';
    case 'portrait':
    case 'portrait-upside-down':
    default:
      return 'right';
  }
}


export function PanHowToOverlay({
  visible,
  orientation,
  style,
}: PanHowToOverlayProps): React.JSX.Element | null {
  // Counter-rotation so the GIF + arrow read upright relative to
  // gravity even when the app is portrait-locked and the device is
  // held in landscape (Mode A).  Always called so hook order is
  // stable across the `visible` toggle.
  const contentRotation = useContentRotation();

  // Single Animated value driving the bounce, 0 → 1 → 0.  Native
  // driver (transform-only), so the loop runs off the JS thread.
  const bounce = useRef(new Animated.Value(0)).current;

  const direction = directionForOrientation(orientation);

  useEffect(() => {
    if (!visible) {
      bounce.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, {
          toValue: 1,
          duration: BOUNCE_DURATION_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(bounce, {
          toValue: 0,
          duration: BOUNCE_DURATION_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, bounce]);

  // Translate 0→BOUNCE_DISTANCE along the pan axis.  In the upright
  // (counter-rotated) frame, "down" moves +Y and "right" moves +X.
  const travel = bounce.interpolate({
    inputRange: [0, 1],
    outputRange: [0, BOUNCE_DISTANCE],
  });
  const arrowTransform = useMemo<ViewStyle['transform']>(
    () =>
      direction === 'down'
        ? [{ translateY: travel }]
        : [{ translateX: travel }],
    [direction, travel],
  );

  if (!visible) return null;

  return (
    <View
      // box-none on the root: never intercept taps anywhere on the
      // full-screen layer.  The inner content is also non-interactive.
      pointerEvents="none"
      style={[styles.root, style]}
    >
      <View style={[styles.content, contentRotation]}>
        {/* Code-drawn phone + sweeping band (decorative — the bouncing
            arrow + parent copy convey the gesture for assistive tech). */}
        <PanPhoneGraphic direction={direction} playing={visible} />
        <Animated.View
          style={[
            styles.arrow,
            direction === 'down' ? styles.arrowDown : styles.arrowRight,
            { transform: arrowTransform },
          ]}
        />
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // CSS-triangle base: a zero-size box whose borders are coloured on
  // one edge and transparent on the two adjacent edges, producing a
  // filled triangle pointing away from the coloured edge.  The
  // direction-specific styles below set which edge is amber.
  arrow: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    marginTop: 8,
  },
  // Triangle pointing DOWN (Mode A): left + right borders transparent,
  // TOP border amber → apex at the bottom.
  arrowDown: {
    borderLeftWidth: ARROW_SIZE / 2,
    borderRightWidth: ARROW_SIZE / 2,
    borderTopWidth: ARROW_SIZE,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: GUIDANCE_TOKENS.amber,
  },
  // Triangle pointing RIGHT (Mode B): top + bottom borders
  // transparent, LEFT border amber → apex on the right.
  arrowRight: {
    borderTopWidth: ARROW_SIZE / 2,
    borderBottomWidth: ARROW_SIZE / 2,
    borderLeftWidth: ARROW_SIZE,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: GUIDANCE_TOKENS.amber,
  },
});
