/**
 * IncrementalStitcherView — live preview component for the panorama
 * engine.  Renders the latest snapshot JPEG written by the native
 * side, with confidence + hint overlays.
 *
 * Why <Image> + cache-bust query string instead of a custom native
 * view: per the design doc's open question, the JPEG-write approach
 * is V1; if perf measurements show we're hitting RN's image cache
 * too hard, swap in an `Animated.Image` or a native UIView with
 * an in-memory bitmap.  Until then, the simple path keeps the
 * cross-platform surface tiny.
 */

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import type { IncrementalState } from './incremental';
import type { IncrementalHint } from './useIncrementalStitcher';


export interface IncrementalStitcherViewProps {
  /** Latest engine state — typically `useIncrementalStitcher().state`. */
  state: IncrementalState | null;
  /**
   * Active hint to surface as a banner overlay.  Pass
   * `useIncrementalStitcher().hint` directly; the view picks the
   * right wording.
   */
  hint: IncrementalHint;
  /**
   * Confidence ring colour driver — typically
   * `useIncrementalStitcher().confidenceLevel`.
   */
  confidenceLevel?: 'high' | 'medium' | null;
  /** Outer container style (size, position).  Required: the view
   *  has no intrinsic size since the panorama dimensions vary. */
  style?: ViewStyle;
  /**
   * Optional override for the spinner shown before the first frame
   * is accepted.  Default is a subtle "Pan to begin" caption.
   */
  emptyText?: string;
}


function hintMessage(hint: IncrementalHint): string | null {
  switch (hint) {
    case 'slow-down':         return 'Slow down — alignment lost';
    case 'scene-uniform':     return 'Pan to a textured area';
    case 'alignment-lost':    return 'Slow down — re-acquiring alignment';
    case 'tracking-poor':     return 'Hold steady — AR re-acquiring';
    default:                  return null;
  }
}


export function IncrementalStitcherView({
  state,
  hint,
  confidenceLevel,
  style,
  emptyText = 'Pan to begin capturing',
}: IncrementalStitcherViewProps): React.JSX.Element {
  // Cache-bust the panorama URI.  The native side rotates through
  // 4 filenames so the path itself changes between snapshots, plus
  // we tag with acceptedCount as belt-and-suspenders since RN's
  // image cache on iOS sometimes ignores file:// query strings.
  const imageUri = useMemo(() => {
    if (!state?.panoramaPath) return null;
    return `file://${state.panoramaPath}?v=${state.acceptedCount}`;
  }, [state?.panoramaPath, state?.acceptedCount]);

  // Use the panorama's NATURAL aspect ratio so the strip widens as
  // the user pans across.  Falls back to 4:3 (a single frame's
  // shape) before any snapshot has been written.  Without this the
  // PiP was forced into a 3:1 letterbox, cropping the actual
  // panorama to a thin slice across the middle.
  const naturalAspect = state?.width && state?.height && state.height > 0
    ? state.width / state.height
    : 4 / 3;

  const ringColor = confidenceLevel === 'high'
    ? '#1aaf5d'
    : confidenceLevel === 'medium'
      ? '#e6b800'
      : 'rgba(255,255,255,0.35)';

  const message = hintMessage(hint);

  return (
    <View style={[styles.container, { aspectRatio: naturalAspect }, style]}>
      {imageUri ? (
        // `contain` so the FULL panorama is visible inside the
        // strip, not cropped to a slice.  Background fills the
        // letterbox edges.  Key={acceptedCount} forces RN to
        // remount the Image component each accept — the surest
        // way to defeat the native image cache on file:// URIs.
        <Image
          key={state?.acceptedCount ?? 0}
          source={{ uri: imageUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          fadeDuration={0}
        />
      ) : (
        <View style={styles.empty}>
          <ActivityIndicator color="#fff" />
          <Text style={styles.emptyText}>{emptyText}</Text>
        </View>
      )}

      {/* Confidence ring — subtle border that picks up colour for
          medium-confidence accepts.  Always visible (white-translucent
          when no confidence signal) so the operator can see exactly
          where the live preview is on screen. */}
      <View
        pointerEvents="none"
        style={[styles.ring, { borderColor: ringColor }]}
      />

      {message ? (
        <View pointerEvents="none" style={styles.hintBanner}>
          <Text style={styles.hintText}>{message}</Text>
        </View>
      ) : null}

      {state ? (
        <View pointerEvents="none" style={styles.counterPill}>
          <Text style={styles.counterText}>
            {state.acceptedCount} frame{state.acceptedCount === 1 ? '' : 's'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}


const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    overflow: 'hidden',
    borderRadius: 8,
  },
  empty: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  emptyText: {
    color: '#fff',
    fontSize: 12,
    opacity: 0.85,
  },
  ring: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    borderWidth: 2,
  },
  hintBanner: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(220, 53, 69, 0.92)',
    borderRadius: 6,
  },
  hintText: {
    color: '#fff',
    fontSize: 11,
    textAlign: 'center',
    fontWeight: '500',
  },
  counterPill: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 10,
  },
  counterText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '500',
  },
});
