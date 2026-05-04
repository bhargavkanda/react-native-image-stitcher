/**
 * ViewportCropOverlay — V12.11 step B.
 *
 * Translucent dim bars on the camera preview's "long sides"
 * showing where the panorama engine's source-crop is.  Replaces
 * the V12.7-Step-B `previewZoomStyle` (a CSS scaleX/scaleY
 * transform), which Ram correctly identified as STRETCHING the
 * camera buffer rather than CROPPING it.
 *
 * Why dim bars and not actually crop the camera buffer:
 *
 *   AVFoundation / vision-camera doesn't expose an asymmetric
 *   crop API.  `zoom` is uniform on both axes — using it to
 *   match the engine's perpendicular-only crop (1/0.70 ≈ 1.43×
 *   for rectilinear) would also crop the pan axis, losing FOV
 *   the engine actually captures.  CSS asymmetric scale
 *   stretches the buffer (ugly).  Dim bars are the honest answer:
 *   keep the full FOV visible (so the user has spatial context),
 *   just signal the capture region with a visual overlay.
 *
 *   Apple's camera pano does the exact same thing — translucent
 *   bars on the long sides indicate the capture band.
 *
 * Layout: The bars sit at JS-top and JS-bottom of the camera
 * viewport container.  This is correct for ALL physical
 * orientations because:
 *
 *   • Portrait device: user perceives JS-top/bottom as their
 *     top/bottom — the "long sides" of the camera view.
 *   • Landscape device: the app is portrait-locked so JS coords
 *     don't rotate; the camera view box in JS stays portrait
 *     (e.g., 393 × 852).  User perceives the JS-top edge as
 *     their RIGHT (or LEFT depending on landscape direction) —
 *     which is one of the "long sides" of their landscape view.
 *
 *   Either way, JS-top and JS-bottom are the long sides as the
 *   user sees them.
 *
 * Bar height: `(1 - perpFraction) / 2` of the camera view's
 * JS-height.  For rectilinear (perpFraction = 0.70), each bar
 * is 15 % of the camera view height — visibly substantial,
 * matching what the engine clips out per frame.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';


export interface ViewportCropOverlayProps {
  /**
   * Fraction of the LONG (perpendicular-to-pan) side the engine
   * keeps per frame, in (0, 1].  e.g. 0.70 for the V12.11
   * rectilinear engine.  Values ≥ 1 hide the overlay (no clip).
   */
  perpFraction: number;
  /**
   * Optional fraction along the PAN axis.  Defaults to 1
   * (no pan-axis crop).  Set < 1 only if the engine ALSO
   * clips along the pan axis (e.g., firstwins-zoomed at 0.70
   * pan × 0.85 perp).  When < 1, additional dim bars are
   * rendered at JS-left and JS-right margins.
   */
  panFraction?: number;
}


export function ViewportCropOverlay({
  perpFraction,
  panFraction = 1,
}: ViewportCropOverlayProps): React.JSX.Element | null {
  // No-op when neither axis clips.  Lets callers pass through
  // engine config without checking themselves.
  if (perpFraction >= 1 && panFraction >= 1) return null;

  // Long-side (perpendicular) clip — bars at JS-top and JS-bottom.
  const perpBarPercent = perpFraction < 1
    ? `${((1 - perpFraction) / 2) * 100}%` as const
    : null;

  // Pan-axis clip — bars at JS-left and JS-right.  Only relevant
  // for engines that ALSO clip along the pan axis (zoomed).
  const panBarPercent = panFraction < 1
    ? `${((1 - panFraction) / 2) * 100}%` as const
    : null;

  return (
    <View pointerEvents="none" style={styles.root}>
      {perpBarPercent ? (
        <>
          <View style={[styles.bar, { top: 0, left: 0, right: 0, height: perpBarPercent }]} />
          <View style={[styles.bar, { bottom: 0, left: 0, right: 0, height: perpBarPercent }]} />
        </>
      ) : null}
      {panBarPercent ? (
        <>
          <View style={[styles.bar, { left: 0, top: 0, bottom: 0, width: panBarPercent }]} />
          <View style={[styles.bar, { right: 0, top: 0, bottom: 0, width: panBarPercent }]} />
        </>
      ) : null}
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
