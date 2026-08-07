// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureFrameCounterOverlay — a live "k / n" keyframe counter shown at the
 * user-perceived BOTTOM-CENTRE during a panorama capture.
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │            (camera preview / pan in progress)     │
 *   │                                                   │
 *   │                     ● 3 / 6                       │ ← bottom-centre
 *   └──────────────────────────────────────────────────┘
 *
 * Replaces the time countdown (item 5) as the primary capture HUD: instead
 * of "seconds left" it shows how many keyframes have been captured out of
 * the configured maximum, so the user can see the capture filling up and
 * understand WHY it auto-finalizes at the cap (the parent stops + stitches
 * when `framesCaptured` reaches `framesMax`).
 *
 * Pure-presentational + `pointerEvents="none"` (never steals taps); renders
 * nothing when `!visible` so the host can mount it unconditionally.  Pins
 * itself to the user-perceived BOTTOM-CENTRE across all four orientations AND
 * both host configs, via the shared {@link placeAtUserEdge} model: it combines
 * the physical device orientation with the measured `jsLandscape` (whether the
 * OS already rotated the framebuffer) so a portrait-LOCKED host (device tilted)
 * and a NON-locked host (framebuffer rotated) both render identically — upright
 * at the user's bottom-centre.  The status pill ({@link CaptureStatusOverlay})
 * anchors to the top-centre by the same model, so the two never collide.
 */

import React, { useContext } from 'react';
import {
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { GUIDANCE_COUNTDOWN, GUIDANCE_PILL, GUIDANCE_TOKENS } from './guidanceTokens';
import { type DeviceOrientation } from './useDeviceOrientation';
import { HostJsLandscapeContext, placeAtUserEdge } from './useContentRotation';


export interface CaptureFrameCounterOverlayProps {
  /** Show / hide.  Driven by the host while a capture is recording. */
  visible: boolean;
  /** Keyframes accepted so far this capture (the engine's live count). */
  framesCaptured: number;
  /** Configured keyframe cap — the capture auto-finalizes when reached. */
  framesMax: number;
  /** Physical device orientation (from `useDeviceOrientation`). */
  orientation: DeviceOrientation;
  /** Outer style passthrough. */
  style?: StyleProp<ViewStyle>;
}


export function CaptureFrameCounterOverlay({
  visible,
  framesCaptured,
  framesMax,
  orientation,
  style,
}: CaptureFrameCounterOverlayProps): React.JSX.Element | null {
  // Rules of hooks: read the orientation signals every render, BEFORE the
  // early return below.  `jsLandscape` = whether the OS already rotated the
  // framebuffer (measured by <Camera> via context; window dims fall back
  // outside it).  The accelerometer subscription is cheap.
  const { width, height } = useWindowDimensions();
  const measuredLandscape = useContext(HostJsLandscapeContext);
  const jsLandscape = measuredLandscape ?? width > height;

  if (!visible || framesMax <= 0) return null;

  // Clamp the displayed numerator into [0, framesMax] — the engine can
  // briefly report the cap-th accept before the parent finalizes.
  const k = Math.max(0, Math.min(framesCaptured, framesMax));

  // Pin to the user-perceived BOTTOM-CENTRE, upright, on every host config.
  // `orientation` is the physical hold (from the host).  The shared
  // `placeAtUserEdge` model subtracts the framebuffer rotation, so a
  // portrait-locked host (device tilted) and a non-locked host (framebuffer
  // rotated) render identically — no double-rotation, correct edge.
  const { container, rotate } = placeAtUserEdge(
    orientation,
    jsLandscape,
    'bottom',
    GUIDANCE_COUNTDOWN.inset,
  );

  return (
    <View
      pointerEvents="none"
      style={[styles.layer, container, style]}
    >
      <View style={[styles.pill, { transform: [{ rotate }] }]}>
        <View style={styles.dot} />
        <Text style={styles.text} allowFontScaling={false} numberOfLines={1}>
          <Text style={styles.count}>{k}</Text>
          <Text style={styles.slash}> / {framesMax}</Text>
        </Text>
      </View>
    </View>
  );
}


/**
 * Flex alignment that pins content to the user-perceived TOP-CENTRE for a
 * given device hold, plus the rotation that makes it read upright:
 *
 *   portrait              → layout top edge,    centred, 0°
 *   landscape-left        → layout left edge,   centred, +90°
 *   landscape-right       → layout right edge,  centred, -90°
 *   portrait-upside-down  → layout bottom edge, centred, 180°
 *
 * `inset` is the distance from the user's top edge (larger values push the
 * content further down the screen) — exported so other top-anchored overlays
 * (e.g. the too-fast pill) can stack BELOW the counter by passing a bigger
 * inset, and stay correctly placed + upright in every orientation.
 */
export function topCenterForOrientation(
  orientation: DeviceOrientation,
  inset: number,
): { container: ViewStyle; rotate: string } {
  switch (orientation) {
    case 'landscape-left':
      return {
        container: {
          justifyContent: 'center',
          alignItems: 'flex-start',
          paddingLeft: inset,
        },
        rotate: '90deg',
      };
    case 'landscape-right':
      return {
        container: {
          justifyContent: 'center',
          alignItems: 'flex-end',
          paddingRight: inset,
        },
        rotate: '-90deg',
      };
    case 'portrait-upside-down':
      return {
        container: {
          justifyContent: 'flex-end',
          alignItems: 'center',
          paddingBottom: inset,
        },
        rotate: '180deg',
      };
    case 'portrait':
    default:
      return {
        container: {
          justifyContent: 'flex-start',
          alignItems: 'center',
          paddingTop: inset,
        },
        rotate: '0deg',
      };
  }
}


const styles = StyleSheet.create({
  // Full-screen, non-interactive layer; the per-orientation flex alignment
  // places the pill on the correct edge, centred along it.
  layer: { ...StyleSheet.absoluteFillObject },
  pill: {
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
  text: {
    // Tabular figures keep the counter from jittering as k ticks up.
    fontVariant: ['tabular-nums'],
  },
  count: {
    color: GUIDANCE_TOKENS.white,
    fontSize: 17,
    fontWeight: '700',
  },
  slash: {
    color: GUIDANCE_TOKENS.amber,
    fontSize: 15,
    fontWeight: '600',
  },
});
