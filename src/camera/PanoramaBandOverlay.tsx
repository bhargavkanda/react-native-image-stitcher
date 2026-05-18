/**
 * PanoramaBandOverlay — V16 Phase 2 (merged band + strip).
 *
 * SINGLE source of truth for the live "progress strip" that sits on
 * top of the camera preview during a panorama hold.  Replaces what
 * was previously TWO components rendered side-by-side:
 *
 *   1. <LiveFrameStrip />        — fed by per-keyframe thumbnail URIs
 *                                  (batch-keyframe engine) OR by
 *                                  periodic vision-camera snapshots.
 *   2. <PanoramaBandOverlay />   — a single cumulative-panorama
 *                                  thumbnail with a "fill ratio"
 *                                  bar growing with the pan.
 *
 * The split made the UI visually noisy AND made it differ between
 * platforms when one side emitted keyframe events and the other
 * didn't.  V16 Phase 2 collapses them into ONE component that:
 *
 *   • Renders a horizontally-scrolling list of per-keyframe
 *     thumbnails when `frameUris` is non-empty (batch-keyframe
 *     mode).  Each frame the KeyframeGate accepts shows up as a
 *     mini-thumb.
 *
 *   • Falls back to a SINGLE cumulative-panorama thumbnail (the
 *     V12.14.9 fill-ratio behaviour) when `frameUris` is empty —
 *     i.e. the live-stitching engines that don't surface
 *     per-keyframe paths.  This preserves the existing visual for
 *     hybrid / firstwins / firstwins-rectilinear engines.
 *
 *   • Edge-pinned to the BOTTOM of the camera area in portrait, and
 *     to the user's RIGHT in landscape (which corresponds to
 *     JS-bottom under the app's portrait-lock).  Both anchors keep
 *     the band out of the centre of the scene the operator is
 *     framing.
 *
 *   • Trailing arrow points along the pan axis (→ in portrait, ← in
 *     landscape-left's user perception).  Arrow always sits at the
 *     pan-END side, so the LATEST keyframe abuts the arrow.
 *
 *   • Auto-scrolls a `<ScrollView>` so the latest keyframe stays
 *     visible regardless of how many frames have been accumulated.
 *
 * Empty-state intentional non-design:
 *   The KeyframeGate force-accepts the FIRST frame of every capture
 *   (see C++ `AcceptFirstAnchoredOnPlane` / `AcceptFirstNoPlane` in
 *   keyframe_gate.cpp).  By the time the operator's perceived "the
 *   band appeared", we already have at least one thumb/snapshot in
 *   flight.  We therefore don't render any "no frames yet"
 *   placeholder — the empty period is sub-perceptual.
 *
 * Why this component is in @retailens/capture-sdk (not host):
 *   It's the same JSX shipped to iOS and Android.  Differences in
 *   what shows up come only from native-emitted data
 *   (`state.batchKeyframeThumbnailPath` / `state.panoramaPath`),
 *   not from per-platform component code.  That's exactly the parity
 *   property the user wants: "the UI should not differ between iOS
 *   and Android — it's the same UI reused".
 */

import React, { useCallback, useMemo, useRef } from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import type { IncrementalState } from '../stitching/incremental';


/**
 * 2026-05-18 (Issue #3 fix) — 4-way capture orientation classifier.
 * Replaces the 2-way `state.isLandscape` boolean which couldn't
 * distinguish landscape-LEFT (home button on user's right) from
 * landscape-RIGHT (home button on user's left).  Required because
 * the JS-coordinate mapping to user-perceived directions inverts
 * between the two landscape rotations — `flexDirection: 'row'`
 * gives oldest-at-user-top in landscape-LEFT but oldest-at-user-
 * bottom in landscape-RIGHT, so we need to branch the layout.
 */
export type BandCaptureOrientation =
  | 'portrait'
  | 'portrait-upside-down'
  | 'landscape-left'
  | 'landscape-right';

export interface PanoramaBandOverlayProps {
  /**
   * Latest engine state.  Pass `useIncrementalStitcher().state`.
   * Used for single-thumb fallback URI and fill-ratio when no
   * per-keyframe URIs are provided.  `state.isLandscape` is now
   * superseded by `captureOrientation` below for layout selection.
   */
  state: IncrementalState | null;
  /**
   * Optional list of per-keyframe thumbnail URIs accumulated by the
   * host as the native batch-keyframe engine emits
   * `batchKeyframeThumbnailPath` events.  When non-empty, the band
   * renders these as a scrolling mini-thumb strip.  When empty or
   * undefined, the band falls back to the single cumulative-panorama
   * thumbnail (legacy live-engine visual).
   *
   * Caller should cap the list length itself if needed (e.g. the
   * AuditCaptureScreen already trims at 24 entries).  This component
   * applies an internal hard cap as a safety net so a runaway
   * emission doesn't blow up the scroll view.
   */
  frameUris?: string[];
  /**
   * 2026-05-18 (Issue #3) — capture orientation passed from the host.
   * Drives a 4-way layout switch so the band reads correctly in
   * either landscape rotation (the 2-way `state.isLandscape` boolean
   * collapses landscape-LEFT and landscape-RIGHT to the same render
   * path, which inverts the user's perceived "oldest-top, grows
   * down" intent in one of them).  Pass
   * `panoramaSettings.captureOrientation` from the host.  Defaults
   * to `'portrait'` when omitted (back-compat).
   */
  captureOrientation?: BandCaptureOrientation;
}


// ── Layout constants — tuned to read clearly at arm's length ────────
const BAND_PADDING = 6;
const BAND_THICKNESS = 64;
const ARROW_TRACK_LEN = 44;          // fixed slot for the arrow glyph
const SINGLE_THUMB_INNER = BAND_THICKNESS - BAND_PADDING * 2;
const SINGLE_THUMB_MAX_PAN_LEN = 240;
const MULTI_THUMB_LEN = 48;
const MULTI_THUMB_GAP = 4;
const MULTI_THUMB_HARD_CAP = 32;     // safety net; host typically caps at 24


type LayoutKind = 'portrait' | 'landscape';
interface Layout {
  kind: LayoutKind;
  /** Outer container style — positioning + flexDirection. */
  band: ViewStyle;
  /** Direction used by both the outer band AND the scroll content. */
  flexDirection: 'row' | 'row-reverse';
  /** Unicode arrow pointing along the user-perceived pan axis. */
  arrowGlyph: string;
}


/**
 * Resolve band layout from capture orientation.  2026-05-18 (Issue #3)
 * — uses the 4-way `BandCaptureOrientation` instead of the 2-way
 * `state.isLandscape` so we can pick the right flex direction +
 * arrow glyph in EACH landscape rotation.
 *
 * The two landscape rotations require different JS-coordinate setups
 * because the phone tilts the JS coordinate system relative to the
 * user differently:
 *
 *   LANDSCAPE-LEFT  (Apple: home indicator on user's RIGHT; phone
 *                    rotated 90° CCW from portrait).
 *     JS-left  = user-top
 *     JS-right = user-bottom
 *     Band at JS-bottom edge appears on user's RIGHT edge.
 *     For "oldest at user-top, newest at user-bottom":
 *       flexDirection = 'row' (array[0] at JS-left = user-top).
 *     For arrow appearing as user-DOWN-arrow:
 *       glyph `←` (rotated 90° CCW = points user-down).
 *
 *   LANDSCAPE-RIGHT (Apple: home indicator on user's LEFT; phone
 *                    rotated 90° CW from portrait).
 *     JS-left  = user-bottom
 *     JS-right = user-top
 *     Band at JS-TOP edge appears on user's RIGHT edge (so we move
 *     the band to JS-top here, not JS-bottom).
 *     For "oldest at user-top, newest at user-bottom":
 *       flexDirection = 'row-reverse' (array[0] at JS-right = user-top).
 *     For arrow appearing as user-DOWN-arrow:
 *       glyph `→` (rotated 90° CW = points user-down).
 *
 *   PORTRAIT (and portrait-upside-down — collapsed because the band's
 *             bottom-anchored position remains sensible either way):
 *     Band at JS-bottom = user-bottom.  Row left-to-right.  Arrow `→`
 *     reads as user-right-arrow (pointing along the horizontal pan
 *     direction).
 */
function layoutFor(orientation: BandCaptureOrientation): Layout {
  const commonInner: ViewStyle = {
    alignItems: 'center',
    paddingHorizontal: BAND_PADDING,
    paddingVertical: BAND_PADDING,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  };
  if (orientation === 'landscape-left') {
    // 2026-05-18 (Issue #3 round 2) re-derived from scratch:
    // Phone rotated 90° CCW from portrait.  JS-coord mapping to
    // user view:
    //   JS-bottom = phone-bottom = user-RIGHT  → band sits here
    //   JS-left   = phone-left   = user-BOTTOM
    //   JS-right  = phone-right  = user-TOP
    // For "oldest at user-TOP, growth toward user-BOTTOM":
    //   array[0] needs to land at user-TOP = JS-right
    //   → flexDirection: 'row-reverse' (array[0] at JS-rightmost).
    // For arrow appearing as user-DOWN:
    //   `←` glyph (JS-direction -X) after 90° CCW rotation maps to
    //   user-down direction.
    return {
      kind: 'landscape',
      band: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 12,
        height: BAND_THICKNESS,
        flexDirection: 'row-reverse',
        ...commonInner,
      },
      flexDirection: 'row-reverse',
      arrowGlyph: '←',
    };
  }
  if (orientation === 'landscape-right') {
    // Phone rotated 90° CW from portrait.  JS-coord mapping:
    //   JS-top    = phone-top    = user-RIGHT  → band sits here
    //   JS-left   = phone-left   = user-TOP
    //   JS-right  = phone-right  = user-BOTTOM
    // For "oldest at user-TOP, growth toward user-BOTTOM":
    //   array[0] needs to land at user-TOP = JS-left
    //   → flexDirection: 'row' (array[0] at JS-leftmost).
    // For arrow appearing as user-DOWN:
    //   `→` glyph (JS-direction +X) after 90° CW rotation maps to
    //   user-down direction.
    return {
      kind: 'landscape',
      band: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 12,
        height: BAND_THICKNESS,
        flexDirection: 'row',
        ...commonInner,
      },
      flexDirection: 'row',
      arrowGlyph: '→',
    };
  }
  // portrait / portrait-upside-down / default.
  return {
    kind: 'portrait',
    band: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: 16,
      height: BAND_THICKNESS,
      flexDirection: 'row',
      ...commonInner,
    },
    flexDirection: 'row',
    arrowGlyph: '→',
  };
}


export function PanoramaBandOverlay({
  state,
  frameUris,
  captureOrientation,
}: PanoramaBandOverlayProps): React.JSX.Element | null {
  // 2026-05-18 (Issue #3 fix) — orientation source priority:
  //   1. `captureOrientation` prop from the host (4-way; correct
  //      for landscape-left vs landscape-right disambiguation).
  //   2. Fallback to `state.isLandscape` (2-way; collapses both
  //      landscape rotations to landscape-left semantics).
  //   3. Default `portrait` (the band's bottom-anchor still reads
  //      sensibly before any orientation info is available).
  const resolvedOrientation: BandCaptureOrientation =
    captureOrientation
    ?? (state?.isLandscape ? 'landscape-left' : 'portrait');
  const layout = useMemo(
    () => layoutFor(resolvedOrientation),
    [resolvedOrientation],
  );

  const scrollRef = useRef<ScrollView | null>(null);

  // Trim incoming URIs to a hard cap.  The host already caps at 24
  // (AuditCaptureScreen) but defence-in-depth keeps the ScrollView
  // bounded if a different host forgets to.  Slice from the END so
  // we keep the MOST RECENT N — older frames slide off the start.
  const cappedFrameUris = useMemo(() => {
    if (!frameUris || frameUris.length === 0) return [];
    return frameUris.length > MULTI_THUMB_HARD_CAP
      ? frameUris.slice(frameUris.length - MULTI_THUMB_HARD_CAP)
      : frameUris;
  }, [frameUris]);

  const hasMultiThumb = cappedFrameUris.length > 0;

  // Auto-scroll on content-size change.  Both portrait and landscape
  // now use `row` flex direction (post Issue 3 fix), so the latest
  // item is always at JS-rightmost → scrollToEnd in both cases.
  const onContentSizeChange = useCallback(() => {
    const sv = scrollRef.current;
    if (!sv) return;
    sv.scrollToEnd({ animated: false });
  }, []);

  // ── Single cumulative thumbnail (live-engine fallback) ──────────
  //
  // Same fill-ratio math as V12.14.9.  Kept so live-stitching engines
  // (hybrid / firstwins / firstwins-rectilinear / firstwins-zoomed)
  // that don't emit per-keyframe URIs still get a useful
  // progress-thumbnail UX — the thumb widens proportionally as the
  // operator pans further.
  const cumulativeUri = useMemo(() => {
    if (!state?.panoramaPath) return null;
    return `file://${state.panoramaPath}?v=${state.acceptedCount}`;
  }, [state?.panoramaPath, state?.acceptedCount]);

  const fillRatio = useMemo(() => {
    if (!state?.paintedExtent || !state?.panExtent) return 0;
    return Math.max(0, Math.min(1, state.paintedExtent / state.panExtent));
  }, [state?.paintedExtent, state?.panExtent]);

  const singleThumbPanLen = useMemo(() => {
    return Math.max(SINGLE_THUMB_INNER, SINGLE_THUMB_MAX_PAN_LEN * fillRatio);
  }, [fillRatio]);

  // V12.14.9 — rotate the panorama image 90° in landscape mode so
  // the captured scene reads UPRIGHT to the user in landscape head-up
  // view.  See original comment in the pre-V16 PanoramaBandOverlay for
  // the full reasoning.  Portrait+horizontal-pan mode (the other
  // supported mode) doesn't need rotation.
  //
  // 2026-05-18 (Issue #3) — derive from `resolvedOrientation` instead
  // of the deprecated 2-way `isLandscape`.  In landscape-RIGHT we
  // rotate −90° so the captured scene still reads upright (the
  // opposite sense from landscape-LEFT).
  const singleImageStyle = useMemo(
    () => {
      if (resolvedOrientation === 'landscape-left') {
        return [StyleSheet.absoluteFill, { transform: [{ rotate: '90deg' }] }];
      }
      if (resolvedOrientation === 'landscape-right') {
        return [StyleSheet.absoluteFill, { transform: [{ rotate: '-90deg' }] }];
      }
      return StyleSheet.absoluteFill;
    },
    [resolvedOrientation],
  );

  return (
    <View pointerEvents="none" style={[styles.bandBase, layout.band]}>
      {hasMultiThumb ? (
        // Multi-thumb path: one image per accepted keyframe, scrolling
        // horizontally (in JS-coords) within the band.  Content
        // flex-direction matches the outer band so OLDEST is at the
        // pan-start side and LATEST sits next to the arrow.
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          style={styles.thumbScroll}
          contentContainerStyle={[
            styles.thumbScrollContent,
            { flexDirection: layout.flexDirection },
          ]}
          onContentSizeChange={onContentSizeChange}
        >
          {cappedFrameUris.map((uri, idx) => (
            <Image
              // Composite key: idx prevents collisions if the same path
              // ever gets re-emitted (shouldn't happen but cheap to be
              // defensive).  URI segment helps RN's image cache key.
              key={`${idx}-${uri}`}
              source={{ uri }}
              style={styles.multiThumb}
              resizeMode="cover"
              fadeDuration={0}
            />
          ))}
        </ScrollView>
      ) : (
        // Single-thumb path: cumulative panorama image, width grows
        // with the pan extent.  Visually identical to pre-V16
        // PanoramaBandOverlay so live-engine UX is unchanged.
        <View
          style={[
            styles.thumbBox,
            { width: singleThumbPanLen, height: SINGLE_THUMB_INNER },
          ]}
        >
          {cumulativeUri ? (
            <Image
              key={state?.acceptedCount ?? 0}
              source={{ uri: cumulativeUri }}
              style={singleImageStyle}
              resizeMode="cover"
              fadeDuration={0}
            />
          ) : null}
        </View>
      )}

      {/* Arrow trailing the latest thumbnail along the pan axis.  Fixed
       *  slot width so it doesn't get squeezed when the scroll view's
       *  content grows.  The outer band's flex direction puts this on
       *  the JS-end-side of the row regardless of orientation. */}
      <View style={styles.arrowTrack}>
        <Text style={styles.arrowGlyph}>{layout.arrowGlyph}</Text>
      </View>
    </View>
  );
}


const styles = StyleSheet.create({
  // Properties common to every layout — uniform border-radius so the
  // band reads as a single capsule regardless of which edge it's
  // anchored to.  Orientation-specific values (position, flexDirection,
  // sizing) come from `layoutFor()`.
  bandBase: {
    borderRadius: 12,
  },
  thumbScroll: {
    flex: 1,
  },
  thumbScrollContent: {
    alignItems: 'center',
    paddingHorizontal: BAND_PADDING,
  },
  multiThumb: {
    width: MULTI_THUMB_LEN,
    height: MULTI_THUMB_LEN,
    borderRadius: 4,
    // marginHorizontal so the gap applies in both `row` and
    // `row-reverse` directions identically; flex layout collapses
    // adjacent margins, giving us a single inter-thumb gap.
    marginHorizontal: MULTI_THUMB_GAP / 2,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.55)',
  },
  thumbBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.55)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  arrowTrack: {
    width: ARROW_TRACK_LEN,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: BAND_PADDING,
  },
  arrowGlyph: {
    color: 'rgba(255, 255, 255, 0.9)',
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '600',
  },
});
