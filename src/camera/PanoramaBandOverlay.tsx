/**
 * PanoramaBandOverlay — V12.12 (re-arch).
 *
 * Floating "band" overlay for the live incremental panorama,
 * matching the V3 mockups the user validated:
 *
 *   • Portrait device  → horizontal band, vertically centred,
 *                        thumbnail at LEFT, arrow pointing RIGHT.
 *   • Landscape device → vertical band on user's LEFT (full
 *                        screen height), thumbnail at user's TOP,
 *                        arrow pointing DOWN.
 *
 * Why this is V12.12:
 *
 *   The earlier band took its orientation from `useDeviceOrientation`
 *   (a JS accelerometer hook).  That hook is unreliable when iOS
 *   interface-orientation lock is on — exactly the case here.  The
 *   engine ALREADY detects orientation correctly from `R_panToCam`
 *   at first frame (V12.6 fix).  V12.12 plumbs that detection into
 *   `IncrementalState.isLandscape` and the band reads it from there.
 *
 *   This means: the band is right whenever the engine is right.  No
 *   second source of truth.
 *
 * Layout choices:
 *
 *   • Landscape: ONE default = landscape-left positioning (per user
 *     instruction "one default").  The band sits at JS-bottom (full
 *     JS-width × BAND_THICKNESS), which appears as a vertical strip
 *     on the user's LEFT when they hold the phone landscape-left
 *     (camera lens pointing to their right).  Users holding the
 *     phone landscape-right (rotated 180° from this) will see the
 *     band on their right edge instead — accepted as the cost of
 *     a single default.  Most field reps hold landscape-left so
 *     this is the right default.
 *
 *   • Pre-first-frame: `state` is null, so we render the portrait
 *     layout as a safe initial guess.  Once the engine emits its
 *     first state event with `isLandscape`, the band re-renders
 *     in the correct layout.
 *
 * Arrow glyphs picked per orientation rather than rotated:
 *
 *   • portrait  → "→" (points JS-right == user-right)
 *   • landscape → "←" (points JS-left  == user-bottom in landscape-left
 *                       — that's the user's "down the pan axis"
 *                       direction)
 */

import React, { useMemo } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import type { IncrementalState } from '../stitching/incremental';


export interface PanoramaBandOverlayProps {
  /** Latest engine state.  Pass `useIncrementalStitcher().state`. */
  state: IncrementalState | null;
}


// Layout constants — picked to read clearly at arm's length.
const BAND_PADDING = 6;
const BAND_THICKNESS = 64;        // user-perceived "thinness" of the band
const PORTRAIT_BAND_MAX_LEN = 320; // cap on the band's pan-axis length in portrait
const THUMB_INNER = BAND_THICKNESS - BAND_PADDING * 2;
// V12.13 — cap on how big the thumb can grow along the pan axis
// before the arrow gets squeezed.  ~60 % of a typical phone's
// short JS dim leaves clearly visible arrow track on either side.
const THUMB_MAX_PAN_LEN = 240;


type Layout = {
  band: ViewStyle;
  // V12.13: thumb dims are no longer in Layout — they're computed
  // separately from the pano natural aspect so the thumb can grow
  // along the band's pan axis as the user pans.  See `thumbPanLen`
  // in the component body.
  arrowTrack: ViewStyle;
  arrowGlyph: string;
};


/**
 * Resolve the JS-coord layout for the band given the engine-detected
 * orientation.  Two cases:
 *
 *   • isLandscape == true (engine sees landscape capture) → vertical
 *     band on user's LEFT.  In the portrait-locked JS coord system
 *     when device is held landscape-left, user's LEFT = JS-BOTTOM,
 *     so we anchor the band there.  Inside (row-reverse): thumbnail
 *     at JS-RIGHT (= user-top), arrow at JS-LEFT (= user-bottom).
 *
 *   • isLandscape == false (engine sees portrait capture, OR no
 *     state yet) → horizontal band, vertically centred at top:40%.
 *     Inside (row): thumbnail at JS-LEFT (= user-left, start of
 *     horizontal pan), arrow at JS-RIGHT (= user-right).
 */
function layoutForOrientation(isLandscape: boolean): Layout {
  if (isLandscape) {
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
      arrowTrack: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: BAND_PADDING,
      },
      arrowGlyph: '←', // user perceives JS-left as their "down" in landscape-left
    };
  }
  // Portrait.
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
    arrowTrack: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: BAND_PADDING,
    },
    arrowGlyph: '→',
  };
}


export function PanoramaBandOverlay({
  state,
}: PanoramaBandOverlayProps): React.JSX.Element | null {
  // Cache-bust the panorama URI.  Same pattern as
  // IncrementalStitcherView — the native side rotates filenames
  // and we tag with acceptedCount as belt-and-suspenders since
  // RN's iOS image cache sometimes ignores file:// query strings.
  const imageUri = useMemo(() => {
    if (!state?.panoramaPath) return null;
    return `file://${state.panoramaPath}?v=${state.acceptedCount}`;
  }, [state?.panoramaPath, state?.acceptedCount]);

  // Read orientation from engine state.  Defaults to false
  // (portrait layout) before first frame is captured.
  const isLandscape = state?.isLandscape ?? false;

  const layout = useMemo(
    () => layoutForOrientation(isLandscape),
    [isLandscape],
  );

  // V12.13 — thumb pan-axis dim grows as the pano grows.
  //
  // Both portrait and landscape bands are JS-horizontal strips
  // (full JS-width × BAND_THICKNESS tall).  In both cases the
  // thumb sits at one JS-horizontal end and the arrow track
  // fills the other end.  As the pano elongates along its pan
  // axis (state.width grows in portrait, state.height grows in
  // landscape), we want the thumb's JS-WIDTH to grow so the user
  // visually sees the thumb extending toward the arrow — matching
  // their pan direction.
  //
  // panAxisRatio: how much longer the pano is along its pan axis
  // vs its perpendicular axis.  At first frame both axes are the
  // sensor compose dim, so the ratio is < 1; we floor to 1.0 so
  // the initial thumb is square.  As the user pans, the ratio
  // climbs above 1 and the thumb elongates.  Capped at
  // THUMB_MAX_PAN_LEN so the arrow always has a visible run.
  const thumbPanLen = useMemo(() => {
    if (!state?.width || !state?.height) return THUMB_INNER;
    const panAxisRatio = isLandscape
      ? state.height / state.width   // landscape: pano grows in height
      : state.width / state.height;  // portrait : pano grows in width
    const naturalLen = THUMB_INNER * Math.max(1, panAxisRatio);
    return Math.min(THUMB_MAX_PAN_LEN, naturalLen);
  }, [state?.width, state?.height, isLandscape]);

  // Thumb dimensions: pan-axis dim grows with the pano, perp-axis
  // dim stays at THUMB_INNER (matches band thickness).
  const thumbStyle: ViewStyle = {
    width: thumbPanLen,
    height: THUMB_INNER,
  };

  return (
    <View pointerEvents="none" style={[styles.bandBase, layout.band]}>
      <View style={[styles.thumbBox, thumbStyle]}>
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
        <Text style={styles.arrowGlyph}>{layout.arrowGlyph}</Text>
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  // Properties common to every layout — borderRadius is applied
  // uniformly so the band reads as a single capsule no matter
  // which edge it's anchored to.  The orientation-specific layout
  // (positioning, flex direction, dimensions) is supplied by
  // `layoutForOrientation`.
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
