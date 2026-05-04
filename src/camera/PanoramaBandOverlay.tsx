/**
 * PanoramaBandOverlay — V12.11 step A (re-rev of step 1).
 *
 * Floating "band" overlay for the live incremental panorama,
 * matching the V3 mockups the user validated:
 *
 *   • Portrait device → horizontal band, vertically centred,
 *     thumbnail at LEFT, arrow pointing RIGHT.
 *   • Landscape device → vertical band on user's LEFT (full
 *     screen height), thumbnail at user's TOP, arrow pointing
 *     DOWN.
 *
 * Why this is a re-rev of the original step 1:
 *
 * The first cut positioned the landscape band with naive JS
 * coordinates (`left: 12, top: 50%`) and a max-height cap.
 * That ignored two facts the operator (Ram) caught immediately:
 *
 *   1. The host app is portrait-LOCKED at the iOS level.  JS
 *      layout coords don't rotate with the device.  In landscape
 *      orientation the screen's true edges are mapped to JS
 *      coords as:
 *
 *         landscape-left  (right edge of phone UP):
 *           user's TOP    = JS-RIGHT
 *           user's BOTTOM = JS-LEFT
 *           user's LEFT   = JS-BOTTOM
 *           user's RIGHT  = JS-TOP
 *
 *         landscape-right (right edge of phone DOWN):
 *           user's TOP    = JS-LEFT
 *           user's BOTTOM = JS-RIGHT
 *           user's LEFT   = JS-TOP
 *           user's RIGHT  = JS-BOTTOM
 *
 *      So a "vertical strip on the user's LEFT" needs to be
 *      positioned at JS-BOTTOM in landscape-left, JS-TOP in
 *      landscape-right.  Same pattern PanoramaGuidance and
 *      CaptureStatusOverlay use for their bottom-anchored pills.
 *
 *   2. The mockup wants the landscape band to span the FULL user
 *      height, not be capped at 320 px.  In JS coords that's
 *      "spans full JS-width" (since user's vertical = JS's
 *      horizontal in landscape).
 *
 * Arrow glyphs are picked per-orientation rather than rotated:
 *
 *   • portrait                 → "→" (points JS-right == user-right)
 *   • portrait-upside-down     → "←" (points JS-left  == user-right after 180° flip)
 *   • landscape-left           → "←" (points JS-left  == user-down)
 *   • landscape-right          → "→" (points JS-right == user-down)
 *
 * Thumbnail placement inside the band:
 *
 *   • portrait                 → JS-left  (= user-left, START of pan)
 *   • portrait-upside-down     → JS-right (= user-left after flip)
 *   • landscape-left           → JS-right (= user-top)
 *   • landscape-right          → JS-left  (= user-top)
 *
 * Behind first-painted-wins, the pano image asset itself is
 * stored in sensor-native landscape pixel order regardless of
 * device orientation.  We render it with no rotation transform —
 * the natural-aspect math drives the thumbnail box dimensions so
 * the image fits proportionally.  This intentionally accepts a
 * small visual quirk in landscape mode (the pano image's pixel-
 * aspect tilts visually compared to the user's perception) in
 * exchange for keeping the rendering pipeline trivial.  We can
 * revisit if it reads poorly in field testing.
 */

import React, { useMemo } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import type { IncrementalState } from '../stitching/incremental';
import type { DeviceOrientation } from './useDeviceOrientation';


export interface PanoramaBandOverlayProps {
  /** Latest engine state.  Pass `useIncrementalStitcher().state`. */
  state: IncrementalState | null;
  /** Live device orientation.  Pass `useDeviceOrientation()`. */
  orientation: DeviceOrientation;
}


// Layout constants — picked to read clearly at arm's length.
const BAND_PADDING = 6;
const BAND_THICKNESS = 64;        // user-perceived "thinness" of the band
const PORTRAIT_BAND_MAX_LEN = 320; // cap on the band's pan-axis length in portrait
const THUMB_INNER = BAND_THICKNESS - BAND_PADDING * 2;


type Layout = {
  band: ViewStyle;
  thumb: ViewStyle;
  arrowTrack: ViewStyle;
  arrowGlyph: string;
  arrowStyle: TextStyle;
};


/**
 * Resolve the JS-coord layout for the band given the current
 * physical device orientation.  The host app is portrait-locked so
 * JS-axes do NOT rotate with the device — we have to map user-
 * perceived edges to JS edges manually (see header comment).
 */
function layoutForOrientation(orientation: DeviceOrientation): Layout {
  switch (orientation) {
    case 'landscape-left':
      // landscape-left: user-LEFT == JS-BOTTOM.  Band spans full
      // JS-width (= full user-height) anchored at JS-bottom, with
      // BAND_THICKNESS in JS-vertical direction.
      // Inside (row layout): thumbnail at JS-RIGHT (= user-top),
      // arrow track filling toward JS-LEFT (= user-bottom).
      return {
        band: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 12,
          height: BAND_THICKNESS,
          flexDirection: 'row-reverse',
          alignItems: 'center',
          paddingHorizontal: BAND_PADDING,
          paddingVertical: BAND_PADDING,
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
        },
        thumb: { width: THUMB_INNER, height: THUMB_INNER },
        arrowTrack: {
          flex: 1, alignItems: 'center', justifyContent: 'center',
          paddingHorizontal: BAND_PADDING,
        },
        arrowGlyph: '←', // user perceives JS-left as their "down"
        arrowStyle: {},
      };

    case 'landscape-right':
      // landscape-right: user-LEFT == JS-TOP.  Symmetric mirror
      // of landscape-left.  flexDirection: 'row' puts thumbnail
      // at JS-LEFT (= user-top), arrow track to JS-RIGHT
      // (= user-bottom).
      return {
        band: {
          position: 'absolute',
          left: 0,
          right: 0,
          top: 12,
          height: BAND_THICKNESS,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: BAND_PADDING,
          paddingVertical: BAND_PADDING,
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
        },
        thumb: { width: THUMB_INNER, height: THUMB_INNER },
        arrowTrack: {
          flex: 1, alignItems: 'center', justifyContent: 'center',
          paddingHorizontal: BAND_PADDING,
        },
        arrowGlyph: '→', // user perceives JS-right as their "down"
        arrowStyle: {},
      };

    case 'portrait-upside-down':
      // Symmetric flip of portrait — band horizontal, but anchored
      // at the BOTTOM of JS so it appears at the TOP to the user
      // (who has the phone upside-down).  Thumbnail at JS-RIGHT.
      return {
        band: {
          position: 'absolute',
          alignSelf: 'center',
          bottom: '40%',
          flexDirection: 'row-reverse',
          alignItems: 'center',
          paddingHorizontal: BAND_PADDING,
          paddingVertical: BAND_PADDING,
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
          maxWidth: PORTRAIT_BAND_MAX_LEN,
          height: BAND_THICKNESS,
        },
        thumb: { width: THUMB_INNER, height: THUMB_INNER },
        arrowTrack: {
          flex: 1, alignItems: 'center', justifyContent: 'center',
          paddingHorizontal: BAND_PADDING,
        },
        arrowGlyph: '←',
        arrowStyle: {},
      };

    case 'portrait':
    default:
      // Portrait, the canonical case.  Band horizontal, vertically
      // centred, thumbnail at JS-LEFT (= user-left), arrow points
      // JS-right (= user-right).  Capped width so it doesn't
      // dominate the camera viewport.
      return {
        band: {
          position: 'absolute',
          alignSelf: 'center',
          top: '40%',
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: BAND_PADDING,
          paddingVertical: BAND_PADDING,
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
          maxWidth: PORTRAIT_BAND_MAX_LEN,
          height: BAND_THICKNESS,
        },
        thumb: { width: THUMB_INNER, height: THUMB_INNER },
        arrowTrack: {
          flex: 1, alignItems: 'center', justifyContent: 'center',
          paddingHorizontal: BAND_PADDING,
        },
        arrowGlyph: '→',
        arrowStyle: {},
      };
  }
}


export function PanoramaBandOverlay({
  state,
  orientation,
}: PanoramaBandOverlayProps): React.JSX.Element | null {
  // Cache-bust the panorama URI.  Same pattern as
  // IncrementalStitcherView — the native side rotates filenames
  // and we tag with acceptedCount as belt-and-suspenders since
  // RN's iOS image cache sometimes ignores file:// query strings.
  const imageUri = useMemo(() => {
    if (!state?.panoramaPath) return null;
    return `file://${state.panoramaPath}?v=${state.acceptedCount}`;
  }, [state?.panoramaPath, state?.acceptedCount]);

  const layout = useMemo(
    () => layoutForOrientation(orientation),
    [orientation],
  );

  return (
    <View pointerEvents="none" style={[styles.bandBase, layout.band]}>
      <View style={[styles.thumbBox, layout.thumb]}>
        {imageUri ? (
          <Image
            key={state?.acceptedCount ?? 0}
            source={{ uri: imageUri }}
            style={StyleSheet.absoluteFill}
            // `cover` so the thumbnail box always reads as a
            // panorama-preview rather than a letterboxed strip
            // — the operator wants spatial intuition, not pixel
            // accuracy at this scale.
            resizeMode="cover"
            fadeDuration={0}
          />
        ) : null}
      </View>
      <View style={layout.arrowTrack}>
        <Text style={[styles.arrowGlyph, layout.arrowStyle]}>
          {layout.arrowGlyph}
        </Text>
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  // Properties common to every orientation — borderRadius is
  // applied uniformly so the band reads as a single capsule no
  // matter which edge it's anchored to.  The orientation-specific
  // layout (positioning, flex direction, dimensions) is supplied
  // by `layoutForOrientation`.
  bandBase: {
    borderRadius: 12,
  },
  // The thumbnail container has a thin white border so it reads as
  // "the panorama so far" against the dark band background.  Without
  // the border the thumbnail blends into the band when the pano
  // hasn't started yet (image source is null).
  thumbBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.55)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  // Arrow glyph — Unicode character keeps the implementation
  // cross-platform without an SVG library.  Sized to read at
  // arm's length on a phone screen.
  arrowGlyph: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '600',
  },
});
