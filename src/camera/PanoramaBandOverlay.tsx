/**
 * PanoramaBandOverlay — V12.11 Step 1 (item 1 of the four-step
 * preview-UX overhaul).
 *
 * Replaces the older full-width PiP for the live incremental
 * panorama with a compact "band" matching the V3 mockups:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │ ┌───┐                                               │
 *   │ │THM│ →  →  →  →  →                                 │   ← portrait band
 *   │ └───┘                                               │     (horizontal)
 *   └─────────────────────────────────────────────────────┘
 *           ↑        ↑                ↑
 *           │        │                pan-direction arrow
 *           │        thumbnail extends along pan axis as
 *           │        the user pans (cumulative panorama view)
 *           leading-edge thumbnail
 *
 *   ┌────┐
 *   │THM │   ← landscape band (vertical, sits on the LEFT)
 *   │ ↓  │
 *   │ ↓  │
 *   │ ↓  │
 *   └────┘
 *
 * Behaviours per the mockup spec the user validated:
 *   • Portrait device → horizontal band, vertically centred.
 *   • Landscape device → vertical band, anchored to the LEFT
 *     edge, vertically centred.
 *   • Inside: a small thumbnail of the cumulative-stitched panorama
 *     (extends along the pan axis as the user pans — the pano's
 *     natural aspect drives the thumbnail's growth) plus a
 *     pan-direction arrow filling the remaining space.
 *   • Caption "Move iPhone continuously…" sits OUTSIDE the band as
 *     a separate element (not implemented here — caller can add it).
 *
 * Why this is a different component from `IncrementalStitcherView`:
 * the StitcherView surfaces hint banners, frame counts, and a
 * confidence ring — useful for engineering builds but not in the
 * field-rep UX the mockups describe.  The band is intentionally
 * minimal: thumbnail + arrow.  Hints surface separately if needed.
 */

import React, { useMemo } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { IncrementalState } from '../stitching/incremental';
import type { DeviceOrientation } from './useDeviceOrientation';


export interface PanoramaBandOverlayProps {
  /** Latest engine state.  Pass `useIncrementalStitcher().state`. */
  state: IncrementalState | null;
  /** Live device orientation.  Pass `useDeviceOrientation()`. */
  orientation: DeviceOrientation;
}


/**
 * Pan axis vs orientation:
 *   - portrait / portrait-upside-down → pan is HORIZONTAL → band
 *     is horizontal (row layout), thumbnail at the LEFT, arrow
 *     pointing RIGHT.
 *   - landscape-left / landscape-right → pan is VERTICAL → band
 *     is vertical (column layout), thumbnail at the TOP, arrow
 *     pointing DOWN.
 *
 * Note that the LIVE physical device orientation (from
 * `useDeviceOrientation`) is what matters here — NOT the JS
 * frameRotationDegrees passed to the engine.  Under iOS interface-
 * orientation lock the latter is unreliable; the accelerometer hook
 * is the source of truth for "which way is the user holding the
 * phone right now".
 */
function bandAxis(orientation: DeviceOrientation): 'horizontal' | 'vertical' {
  return orientation === 'landscape-left' || orientation === 'landscape-right'
    ? 'vertical'
    : 'horizontal';
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

  const axis = bandAxis(orientation);

  // The natural aspect of the pano drives the thumbnail's growth
  // along the pan axis.  Falls back to a single-frame aspect (4:3)
  // before the engine has emitted any snapshot.  This is what
  // makes the thumbnail visually "grow" as the user pans — a
  // wider pano means a wider thumbnail which means LESS room
  // for the arrow.  Mimics Apple's pano UI cue.
  const naturalAspect = state?.width && state?.height && state.height > 0
    ? state.width / state.height
    : 4 / 3;

  if (axis === 'horizontal') {
    // Cap the thumbnail's width at 60 % of the band so the arrow
    // always has a visible run.  Within that cap the thumbnail
    // grows from a square (one-frame start) to a wider rectangle
    // as the pano widens.
    const thumbHeight = HORIZONTAL_BAND_HEIGHT - BAND_PADDING * 2;
    const idealWidth = thumbHeight * naturalAspect;
    const maxThumbWidth = HORIZONTAL_BAND_MAX_WIDTH * 0.6;
    const thumbWidth = Math.min(idealWidth, maxThumbWidth);
    return (
      <View
        pointerEvents="none"
        style={[styles.bandHorizontal, { height: HORIZONTAL_BAND_HEIGHT }]}
      >
        <View
          style={[
            styles.thumbBox,
            { width: thumbWidth, height: thumbHeight },
          ]}
        >
          {imageUri ? (
            <Image
              key={state?.acceptedCount ?? 0}
              source={{ uri: imageUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              fadeDuration={0}
            />
          ) : null}
        </View>
        {/* Arrow track: centred horizontal arrow filling whatever
            space remains between the thumbnail and the band's
            trailing edge. */}
        <View style={styles.arrowTrackHorizontal}>
          <Text style={styles.arrowGlyph}>→</Text>
        </View>
      </View>
    );
  }

  // axis === 'vertical' — landscape device, vertical pan.
  const thumbWidth = VERTICAL_BAND_WIDTH - BAND_PADDING * 2;
  // The pano grows vertically when the device is landscape: the
  // pan axis is the panorama's HEIGHT.  So thumbnail height grows
  // proportional to the pano's natural aspect (width / height).
  // For a 1920×1080 frame that became 1920×3000 after panning
  // down: aspect 1920/3000 = 0.64 → thumbHeight = thumbWidth /
  // 0.64 ≈ 1.56× the thumbWidth.  Cap at 60 % of band height for
  // arrow visibility.
  const idealHeight = thumbWidth / naturalAspect;
  const maxThumbHeight = VERTICAL_BAND_MAX_HEIGHT * 0.6;
  const thumbHeight = Math.min(idealHeight, maxThumbHeight);
  return (
    <View
      pointerEvents="none"
      style={[styles.bandVertical, { width: VERTICAL_BAND_WIDTH }]}
    >
      <View
        style={[
          styles.thumbBox,
          { width: thumbWidth, height: thumbHeight },
        ]}
      >
        {imageUri ? (
          <Image
            key={state?.acceptedCount ?? 0}
            source={{ uri: imageUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            fadeDuration={0}
          />
        ) : null}
      </View>
      <View style={styles.arrowTrackVertical}>
        <Text style={styles.arrowGlyph}>↓</Text>
      </View>
    </View>
  );
}


// Layout constants.  Kept private to this module — the band is
// not configurable from the host app per the mockup spec (the
// whole point is a consistent UX across audits).
const BAND_PADDING = 6;
const HORIZONTAL_BAND_HEIGHT = 64;
const HORIZONTAL_BAND_MAX_WIDTH = 320;
const VERTICAL_BAND_WIDTH = 64;
const VERTICAL_BAND_MAX_HEIGHT = 320;


const styles = StyleSheet.create({
  // Horizontal band: portrait device, pan = horizontal.
  // Anchors to vertical centre of the camera viewport, horizontally
  // centred.  Caller positions the band by wrapping in a container
  // — but for safety we set our own absolute position so it always
  // ends up roughly where the mockup shows.
  bandHorizontal: {
    position: 'absolute',
    alignSelf: 'center',
    top: '40%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: BAND_PADDING,
    paddingVertical: BAND_PADDING,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 12,
    maxWidth: HORIZONTAL_BAND_MAX_WIDTH,
  },
  // Vertical band: landscape device, pan = vertical.
  // Anchored to the LEFT edge per the V3 landscape mockup, vertical
  // centre.  Same translucent rounded-rect aesthetic.
  bandVertical: {
    position: 'absolute',
    left: 12,
    top: '50%',
    transform: [{ translateY: -VERTICAL_BAND_MAX_HEIGHT / 2 }],
    flexDirection: 'column',
    alignItems: 'center',
    paddingHorizontal: BAND_PADDING,
    paddingVertical: BAND_PADDING,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 12,
    maxHeight: VERTICAL_BAND_MAX_HEIGHT,
  },
  // The thumbnail container has a thin white border so it reads
  // as "the panorama so far" against the dark band background.
  // Without the border the thumbnail blends into the band when
  // the pano hasn't started yet (image source is null).
  thumbBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.55)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  // Arrow tracks fill the remaining space inside the band along
  // the pan axis.  They're centred so the arrow glyph sits in the
  // middle of the available run regardless of how wide the
  // thumbnail has grown.
  arrowTrackHorizontal: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: BAND_PADDING,
  },
  arrowTrackVertical: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: BAND_PADDING,
  },
  // Arrow glyph itself — a simple Unicode character keeps the
  // implementation cross-platform without dragging in an SVG lib.
  // Sized to read clearly at arm's length on a phone screen.
  arrowGlyph: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '600',
  },
});
