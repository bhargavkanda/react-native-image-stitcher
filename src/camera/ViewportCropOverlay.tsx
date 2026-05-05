/**
 * ViewportCropOverlay — V12.12.
 *
 * Translucent dim bars on the camera preview's PAN-AXIS edges
 * showing where the panorama engine's source-crop is.  Earlier
 * versions (V12.11 Step B) put the bars on JS-top/bottom because
 * the engine clipped the long sensor axis (perpendicular to pan
 * in landscape, along pan in portrait) — that produced visible
 * bars on the user-LEFT/RIGHT in landscape, which is the WRONG
 * place: those edges aren't what the engine clips.
 *
 * V12.12: engine now clips ALONG the pan axis.  In sensor-native
 * coords:
 *   • landscape capture (vertical pan): clip = sensor Y (rows).
 *     User perceives this as TOP and BOTTOM of their landscape view.
 *   • portrait capture (horizontal pan): clip = sensor X (cols).
 *     User perceives this as LEFT and RIGHT of their portrait view.
 *
 * In JS coords (the host app is portrait-locked):
 *   • portrait device: user-left/right == JS-left/right.  Bars on
 *                       JS-left/right.
 *   • landscape device: user-top/bottom == JS-left/right (because
 *                       the user's vertical maps to JS-horizontal
 *                       under portrait-lock).  Bars on JS-left/right.
 *
 * So in BOTH device orientations the bars sit at JS-left and JS-right.
 * **No orientation detection needed in this component.**  The
 * engine has already arranged for the clip to manifest at the same
 * JS edges regardless of physical device orientation.
 *
 * Bar width = `(1 - panFraction) / 2` of the JS-horizontal extent.
 * For the default `kPanAxisFractionRect = 0.70` engine constant,
 * each bar is 15 % wide — visibly substantial, matching what the
 * engine clips out per frame.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';


export interface ViewportCropOverlayProps {
  /**
   * Fraction of the PAN axis the engine keeps per frame, in (0, 1].
   * E.g. 0.70 for the V12.12 rectilinear engine's
   * `kPanAxisFractionRect`.  Values ≥ 1 hide the overlay (no clip).
   */
  panFraction: number;
}


export function ViewportCropOverlay({
  panFraction,
}: ViewportCropOverlayProps): React.JSX.Element | null {
  if (panFraction >= 1) return null;

  // (1 - panFraction) / 2 of the JS-horizontal extent on each side.
  const barPercent = `${((1 - panFraction) / 2) * 100}%` as const;

  return (
    <View pointerEvents="none" style={styles.root}>
      <View style={[styles.bar, { left: 0, top: 0, bottom: 0, width: barPercent }]} />
      <View style={[styles.bar, { right: 0, top: 0, bottom: 0, width: barPercent }]} />
    </View>
  );
}


const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
  },
  // Dim bars: translucent black overlay so the underlying camera
  // preview is still visible (the user gets spatial context for
  // what's about to leave the frame), but darkened enough to read
  // as "this is OUTSIDE the capture region."
  bar: {
    position: 'absolute',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
});
