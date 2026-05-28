// SPDX-License-Identifier: Apache-2.0
/**
 * ViewportCropOverlay — V12.12 + v0.12.0 orientation-aware (R2-lite).
 *
 * Translucent dim bars on the camera preview's PAN-AXIS edges
 * showing where the panorama engine's source-crop is.  The engine
 * clips ALONG the pan axis:
 *
 *   • Portrait capture (horizontal pan / Mode B):
 *     clip = sensor X (cols).  User perceives this as LEFT and RIGHT
 *     of their portrait view.
 *
 *   • Landscape capture (vertical pan / Mode A):
 *     clip = sensor Y (rows).  User perceives this as TOP and BOTTOM
 *     of their landscape view.
 *
 * ## v0.12.0 update (R2-lite)
 *
 * Pre-v0.12 this component assumed the host app was orientation-
 * locked to portrait, in which case ALL device orientations mapped
 * to JS-left + JS-right for the bars (because the user's vertical
 * mapped to JS-horizontal under portrait-lock).  Under R2-lite the
 * SDK no longer holds the UI in portrait, so JS coordinates align
 * with the physical device orientation reported by
 * `useDeviceOrientation()`.  The bars now live at:
 *
 *   portrait, portrait-upside-down → JS-left + JS-right  (horizontal pan)
 *   landscape-left, landscape-right → JS-top  + JS-bottom (vertical pan)
 *
 * Mounting: the flagship `<Camera>` component mounts this overlay
 * by default in v0.12.0 (PR-3 wiring); Layer-2 hosts can mount it
 * themselves via the public export.
 *
 * ## Bar dimensions
 *
 * Bar `(1 - panFraction) / 2` of the pan-axis extent.  For the
 * default engine constant `kPanAxisFractionRect = 0.70`, each bar
 * is 15 % of the pan-axis extent — visibly substantial, matching
 * what the engine clips out per frame.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useDeviceOrientation } from './useDeviceOrientation';


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
  const orientation = useDeviceOrientation();

  if (panFraction >= 1) return null;

  // (1 - panFraction) / 2 of the pan-axis extent on each side.
  const barPercent = `${((1 - panFraction) / 2) * 100}%` as const;

  const isLandscape =
    orientation === 'landscape-left' || orientation === 'landscape-right';

  return (
    <View pointerEvents="none" style={styles.root}>
      {isLandscape ? (
        <>
          {/* Vertical-pan capture: bars at JS-top + JS-bottom. */}
          <View style={[styles.bar, { left: 0, right: 0, top: 0, height: barPercent }]} />
          <View style={[styles.bar, { left: 0, right: 0, bottom: 0, height: barPercent }]} />
        </>
      ) : (
        <>
          {/* Horizontal-pan capture: bars at JS-left + JS-right. */}
          <View style={[styles.bar, { left: 0, top: 0, bottom: 0, width: barPercent }]} />
          <View style={[styles.bar, { right: 0, top: 0, bottom: 0, width: barPercent }]} />
        </>
      )}
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
