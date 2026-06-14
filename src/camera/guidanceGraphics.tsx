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
  target = 'landscape',
}: GuidanceGraphicProps & {
  /** Orientation to rotate TO: 'landscape' (default) or 'portrait'. */
  target?: 'landscape' | 'portrait';
}): React.JSX.Element {
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

  // To-landscape: start portrait (tall), rotate anticlockwise to landscape.
  // To-portrait: start landscape (wide), rotate clockwise to stand upright.
  const toLandscape = target === 'landscape';
  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: toLandscape ? ['0deg', '-90deg'] : ['0deg', '90deg'],
  });

  const ring = size * 0.78;
  const ringInset = (size - ring) / 2;
  const phoneW = toLandscape ? size * 0.3 : size * 0.56;
  const phoneH = toLandscape ? size * 0.56 : size * 0.3;

  return (
    <View
      style={[{ width: size, height: size }, styles.center, style]}
      pointerEvents="none"
    >
      {/* Faint full guide ring — the rotation "path" (centred behind the
          phone via explicit insets; absolute views don't honour the
          parent's center alignment). */}
      <View
        style={[
          styles.ring,
          {
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            top: ringInset,
            left: ringInset,
            borderColor: GUIDANCE_TOKENS.amber,
          },
        ]}
      />
      {/* Arrowhead on the ring at top-centre, pointing along the rotation's
          tangent: LEFT for anticlockwise (to-landscape), RIGHT for clockwise
          (to-portrait). */}
      <View
        style={[
          styles.arrowHead,
          toLandscape ? styles.arrowHeadLeft : styles.arrowHeadRight,
          { top: ringInset - 5, left: size / 2 - 5 },
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
  // One value loops 0→1; drives the phone's travel + perspective tilt
  // together so the device reads as ROTATING as it sweeps along the arrow.
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!playing) {
      t.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: 1900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [playing, t, direction]);

  const down = direction === 'down';
  // Mode A (down) holds the phone LANDSCAPE; Mode B (right) PORTRAIT.
  const phoneW = down ? size * 0.5 : size * 0.34;
  const phoneH = down ? size * 0.34 : size * 0.5;

  // Travel ± along the pan axis (down → +Y, right → +X), kept in-canvas.
  const amp = size * 0.2;
  const translate = t.interpolate({
    inputRange: [0, 1],
    outputRange: [-amp, amp],
  });
  // The device TILTS through the sweep — rotating about the cross-pan axis
  // as it pans — which is the 3D "the phone is turning" read the flat
  // band lacked.  rotateX for a vertical (down) pan, rotateY for horizontal.
  // The horizontal (right) tilt is INVERTED vs the vertical one so the edge
  // on the side the phone is currently on reads LONGER (convex toward the
  // viewer) — matched to on-device feedback for the portrait Mode-B pan.
  const tilt = t.interpolate({
    inputRange: [0, 1],
    outputRange: down ? ['-24deg', '24deg'] : ['24deg', '-24deg'],
  });
  // Fade at the travel ends so the loop's restart is invisible.
  const opacity = t.interpolate({
    inputRange: [0, 0.15, 0.85, 1],
    outputRange: [0, 1, 1, 0],
  });

  // `perspective` makes the rotateX/rotateY read as depth (a turning
  // device), not a flat vertical squash.
  const transform = down
    ? [{ perspective: 800 }, { translateY: translate }, { rotateX: tilt }]
    : [{ perspective: 800 }, { translateX: translate }, { rotateY: tilt }];

  return (
    <View
      style={[{ width: size, height: size }, styles.center, style]}
      pointerEvents="none"
    >
      <Animated.View style={{ opacity, transform }}>
        <PhoneBody width={phoneW} height={phoneH}>
          {/* Faint amber "screen" so the turning glass catches the light. */}
          <View style={styles.screenGlow} pointerEvents="none" />
        </PhoneBody>
      </Animated.View>
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
  // Amber CSS-triangle arrowhead at the top of the ring.  The base props are
  // shared; the direction-specific style colours the trailing border so the
  // apex points along the rotation tangent.
  arrowHead: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  // Points LEFT (anticlockwise / to-landscape): RIGHT border amber.
  arrowHeadLeft: {
    borderRightWidth: 10,
    borderRightColor: GUIDANCE_TOKENS.amber,
  },
  // Points RIGHT (clockwise / to-portrait): LEFT border amber.
  arrowHeadRight: {
    borderLeftWidth: 10,
    borderLeftColor: GUIDANCE_TOKENS.amber,
  },
  // Faint amber fill inside the phone outline — a hint of the live
  // preview so the turning device reads as a screen, not an empty frame.
  screenGlow: {
    width: '78%',
    height: '70%',
    borderRadius: 6,
    backgroundColor: GUIDANCE_TOKENS.amber,
    opacity: 0.14,
  },
});
