// SPDX-License-Identifier: Apache-2.0
/**
 * guidanceGraphics — code-drawn replacements for the two authored guidance
 * GIFs (rotate-to-landscape, pan-capture).  Built from pure React-Native
 * core `View` + `Animated` primitives — NO `react-native-svg`, NO bundled
 * image assets — so the library keeps its "zero extra native deps for
 * guidance" contract (see `RectCropPreview`) AND no longer needs the host
 * to add Fresco's `animated-gif` module on Android just to make the
 * coach-marks move.
 *
 * Why not GIFs:  the authored GIFs were 280 px sources shown at 240 dp;
 * on a ~2.6×-density phone that 240 dp is ~630 physical px, so the 280 px
 * source was up-scaled ~2.25× → visibly pixelated.  A 256-colour GIF also
 * bands.  These vector-ish primitives are resolution-independent (they're
 * just borders + transforms the GPU rasterises at native density) and fully
 * themeable via `GUIDANCE_TOKENS`.
 *
 * Both graphics:
 *   • run a single `Animated.loop` on the NATIVE driver (transform/opacity
 *     only) so the loop is off the JS thread;
 *   • take a `playing` flag — the host renders them only while `visible`,
 *     but we still gate the loop so a mounted-but-paused graphic costs
 *     nothing;
 *   • scale every dimension off a single `size` (defaults to the shared
 *     `GUIDANCE_TOKENS.graphicSize`) so callers can resize without restyle.
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { GUIDANCE_TOKENS } from './guidanceTokens';


const DEFAULT_SIZE = GUIDANCE_TOKENS.graphicSize;


/** Pan direction the pan-graphic should animate (mirrors PanHowToOverlay). */
export type PanGraphicDirection = 'down' | 'right';


export interface GuidanceGraphicProps {
  /** Canvas square size in px.  Defaults to `GUIDANCE_TOKENS.graphicSize`. */
  size?: number;
  /** Run the animation loop.  `false` parks the value at rest. */
  playing?: boolean;
  /** Outer style passthrough. */
  style?: StyleProp<ViewStyle>;
}


/**
 * A white rounded-rectangle "phone" outline with a small camera dot on its
 * top short edge.  The dot makes the device's up-axis legible, so when the
 * rotate graphic turns the body the rotation reads unambiguously.  Children
 * (e.g. the pan sweep band) render over the screen area.
 */
function PhoneBody({
  width,
  height,
  children,
  style,
}: {
  width: number;
  height: number;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const radius = Math.min(width, height) * 0.16;
  return (
    <View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          borderWidth: Math.max(2, width * 0.03),
          borderColor: GUIDANCE_TOKENS.white,
        },
        styles.phoneBody,
        style,
      ]}
    >
      {/* Camera dot on the top short edge → marks "up". */}
      <View
        style={[
          styles.cameraDot,
          {
            width: Math.max(4, width * 0.06),
            height: Math.max(4, width * 0.06),
            borderRadius: Math.max(2, width * 0.03),
            top: Math.max(5, height * 0.05),
          },
        ]}
      />
      {children}
    </View>
  );
}


/**
 * RotatePhoneGraphic — a portrait phone outline that rotates 0°→90°→0°
 * (portrait → landscape → portrait) on a loop, riding a faint amber guide
 * ring with a clockwise arrowhead, demonstrating the "rotate to landscape"
 * gesture.  Replaces `rotate-to-landscape.gif`.
 */
export function RotatePhoneGraphic({
  size = DEFAULT_SIZE,
  playing = true,
  style,
}: GuidanceGraphicProps): React.JSX.Element {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!playing) {
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(350),
        Animated.timing(spin, {
          toValue: 1,
          duration: 850,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.delay(650), // dwell at landscape so the goal state reads
        Animated.timing(spin, {
          toValue: 0,
          duration: 850,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [playing, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'], // clockwise to landscape
  });

  const ring = size * 0.78;
  const phoneW = size * 0.3;
  const phoneH = size * 0.56;

  return (
    <View
      style={[{ width: size, height: size }, styles.center, style]}
      pointerEvents="none"
    >
      {/* Faint full guide ring — the rotation "path". */}
      <View
        style={[
          styles.ring,
          {
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            borderColor: GUIDANCE_TOKENS.amber,
          },
        ]}
      />
      {/* Clockwise arrowhead sitting on the ring at top-center (points
          right = clockwise tangent). */}
      <View
        style={[
          styles.arrowHead,
          { top: (size - ring) / 2 - 4 },
        ]}
      />

      <Animated.View style={{ transform: [{ rotate }] }}>
        <PhoneBody width={phoneW} height={phoneH} />
      </Animated.View>
    </View>
  );
}


/**
 * PanPhoneGraphic — a phone outline (landscape for Mode-A `down`, portrait
 * for Mode-B `right`) with an amber sweep band that travels across the pan
 * axis on a loop, demonstrating the camera sweep.  The band fades in/out at
 * the travel ends so the loop reset is invisible.  Replaces
 * `pan-capture.gif`.  The bouncing direction arrow stays in PanHowToOverlay.
 */
export function PanPhoneGraphic({
  direction,
  size = DEFAULT_SIZE,
  playing = true,
  style,
}: GuidanceGraphicProps & { direction: PanGraphicDirection }): React.JSX.Element {
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!playing) {
      sweep.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1600,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [playing, sweep, direction]);

  const down = direction === 'down';
  const phoneW = down ? size * 0.6 : size * 0.4;
  const phoneH = down ? size * 0.4 : size * 0.6;

  // Travel amplitude along the pan axis, ±A from the phone centre, kept
  // inside the screen with a small margin.
  const amplitude = (down ? phoneH : phoneW) * 0.5 - size * 0.06;
  const translate = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-amplitude, amplitude],
  });
  // Fade the band at both ends so the loop's jump-back is hidden.
  const opacity = sweep.interpolate({
    inputRange: [0, 0.12, 0.88, 1],
    outputRange: [0, 1, 1, 0],
  });

  const bandLong = (down ? phoneW : phoneH) * 0.8;
  const bandTransform = down
    ? [{ translateY: translate }]
    : [{ translateX: translate }];

  // Core bright band + a taller, fainter "glow" band behind it (RN core
  // has no blur, so a low-opacity wider bar approximates the glow).
  const coreBand: ViewStyle = down
    ? { width: bandLong, height: 4 }
    : { width: 4, height: bandLong };
  const glowBand: ViewStyle = down
    ? { width: bandLong, height: 14 }
    : { width: 14, height: bandLong };

  return (
    <View
      style={[{ width: size, height: size }, styles.center, style]}
      pointerEvents="none"
    >
      <PhoneBody width={phoneW} height={phoneH}>
        <View style={styles.sweepCenter} pointerEvents="none">
          <Animated.View
            style={[
              styles.glowBand,
              glowBand,
              { opacity, transform: bandTransform },
            ]}
          />
          <Animated.View
            style={[
              styles.coreBand,
              coreBand,
              { opacity, transform: bandTransform },
            ]}
          />
        </View>
      </PhoneBody>
    </View>
  );
}


const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  phoneBody: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  cameraDot: {
    position: 'absolute',
    backgroundColor: GUIDANCE_TOKENS.white,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
    opacity: 0.28,
    backgroundColor: 'transparent',
  },
  // Amber CSS-triangle arrowhead pointing RIGHT (clockwise tangent at the
  // top of the ring): top+bottom borders transparent, LEFT border amber.
  arrowHead: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderLeftWidth: 10,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: GUIDANCE_TOKENS.amber,
  },
  // Fills the phone body; the bands are centred here and translate from it.
  sweepCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coreBand: {
    position: 'absolute',
    borderRadius: 2,
    backgroundColor: GUIDANCE_TOKENS.amber,
  },
  glowBand: {
    position: 'absolute',
    borderRadius: 7,
    backgroundColor: GUIDANCE_TOKENS.amber,
    opacity: 0.25,
  },
});
