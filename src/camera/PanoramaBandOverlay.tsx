// SPDX-License-Identifier: Apache-2.0
/**
 * PanoramaBandOverlay — V16 Phase 2 (merged band + strip).
 *
 * SINGLE source of truth for the live "progress strip" that sits on
 * top of the camera preview during a panorama hold.  Replaces what
 * was previously TWO components rendered side-by-side:
 *
 *   1. live per-keyframe thumbnail strip — fed by accepted-frame URIs
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
 * Why this component is in react-native-image-stitcher (not host):
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
   * v0.12.0 — `true` when the band should render as a vertical
   * column in JS (anchor edge is JS-left or JS-right, i.e.
   * non-locked host with device-landscape).  `false` (default)
   * renders the legacy horizontal strip — covers portrait-locked
   * hosts in any device orientation AND non-locked hosts in
   * portrait.  The flagship `<Camera>` derives this from
   * `useWindowDimensions()` + `useDeviceOrientation()` (see
   * `homeIndicatorEdge` in `Camera.tsx`); Layer-2 hosts pass it
   * directly.
   */
  vertical?: boolean;
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
  /**
   * Direction used by both the outer band AND the scroll content.
   * row/row-reverse for horizontal bands; column/column-reverse for
   * vertical bands (non-locked host in landscape, jsLandscape=true).
   */
  flexDirection: 'row' | 'row-reverse' | 'column' | 'column-reverse';
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
function layoutFor(
  orientation: BandCaptureOrientation,
  vertical: boolean,
): Layout {
  const commonInner: ViewStyle = {
    alignItems: 'center',
    paddingHorizontal: BAND_PADDING,
    paddingVertical: BAND_PADDING,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  };
  // v0.12.0 — band structural orientation tracks the host's
  // `vertical` flag (which the host derives from JS layout
  // orientation):
  //
  //   vertical=false  Horizontal strip in JS coords.  Under
  //                   portrait-lock + device-landscape this appears
  //                   as a vertical column on user-right via the
  //                   un-rotated framebuffer.
  //   vertical=true   Vertical column in JS coords.  Non-locked
  //                   + device-landscape — band lives along the
  //                   JS-side strip where the home indicator is.
  //
  // What still varies by physical orientation regardless: the
  // thumbnail flow direction so newest sits at the user-perceived
  // pan-leading edge (flexDirection + arrowGlyph).
  if (vertical) {
    // Vertical band in JS coords (non-locked landscape).  The OS
    // rotated the framebuffer so user-top = JS-top, user-bottom =
    // JS-bottom — same scroll direction regardless of whether the
    // device is landscape-left or landscape-right.  Latest grows
    // toward user-bottom (= JS-bottom).  flexDirection 'column'
    // puts array[0]/oldest at JS-top.
    return {
      kind: 'landscape',
      band: {
        marginHorizontal: 8,
        marginVertical: 16,
        width: BAND_THICKNESS,
        flexDirection: 'column',
        ...commonInner,
      },
      flexDirection: 'column',
      arrowGlyph: '↓',
    };
  }
  // vertical=false branch: pre-v0.12 horizontal-strip behavior
  // keyed on device-physical orientation for thumbnail direction.
  if (orientation === 'landscape-left') {
    // Phone rotated 90° CCW from portrait (home indicator on the
    // user's RIGHT).  With UI orientation-locked to portrait:
    //   JS-left  (band horizontal start) = user-BOTTOM
    //   JS-right (band horizontal end)   = user-TOP
    // For the canonical "oldest at user-TOP, growth toward user-
    // BOTTOM" reading direction the monorepo established, we want:
    //   array[0] (oldest) at user-TOP = JS-rightmost
    //   newest        at user-BOTTOM = JS-leftmost
    //   → flexDirection: 'row-reverse'  (array[0] at JS-rightmost)
    return {
      kind: 'landscape',
      band: {
        marginHorizontal: 16,
        marginVertical: 8,
        height: BAND_THICKNESS,
        flexDirection: 'row-reverse',
        ...commonInner,
      },
      flexDirection: 'row-reverse',
      arrowGlyph: '←',
    };
  }
  if (orientation === 'landscape-right') {
    // Phone rotated 90° CW from portrait (home indicator on the
    // user's LEFT).  Mirror of landscape-left:
    //   JS-left  = user-TOP
    //   JS-right = user-BOTTOM
    // For "oldest at user-TOP, newest at user-BOTTOM":
    //   array[0] (oldest) at user-TOP = JS-leftmost
    //   → flexDirection: 'row'  (array[0] at JS-leftmost)
    return {
      kind: 'landscape',
      band: {
        marginHorizontal: 16,
        marginVertical: 8,
        height: BAND_THICKNESS,
        flexDirection: 'row',
        ...commonInner,
      },
      flexDirection: 'row',
      arrowGlyph: '→',
    };
  }
  // portrait / portrait-upside-down / default.  Held portrait, pan
  // is horizontal left→right (or right→left for left-handed scans;
  // the band doesn't enforce a direction).  newest at JS-rightmost.
  return {
    kind: 'portrait',
    band: {
      marginHorizontal: 16,
      marginVertical: 8,
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
  vertical = false,
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
    () => layoutFor(resolvedOrientation, vertical),
    [resolvedOrientation, vertical],
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

  // Auto-scroll on content-size change.  `*-reverse` puts latest at
  // scroll origin (scrollTo {0,0}); normal `row`/`column` puts
  // latest at scroll end (scrollToEnd).
  const isReverse =
    layout.flexDirection === 'row-reverse' ||
    layout.flexDirection === 'column-reverse';
  const onContentSizeChange = useCallback(() => {
    const sv = scrollRef.current;
    if (!sv) return;
    if (isReverse) {
      sv.scrollTo({ x: 0, y: 0, animated: false });
    } else {
      sv.scrollToEnd({ animated: false });
    }
  }, [isReverse]);

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

  // Image rotation transform for thumbnails.  Captured frames are in
  // user-perspective orientation (the capture pipeline rotates the
  // sensor-native bytes via `outputOrientation="device"` + EXIF
  // baking in `normaliseOrientation`).  The thumbnail BOX is in
  // JS coords.  When JS coords are device-aligned (portrait-lock,
  // i.e. vertical=false here) and the device is in landscape, the
  // image content is rotated 90° from the box's axes → appears
  // sideways without compensation.  Apply a counter-rotation to
  // line content up with the box's perceived "top".
  //
  // When vertical=true (non-locked + device-landscape; JS coords
  // rotated with screen), the box IS user-aligned already.  No
  // rotation needed — the image is already correctly oriented for
  // direct display.
  //
  // V12.14.9 → v0.12.0 — extended from single-thumb (cumulative
  // panorama image fallback) to the multi-thumb path too.  Pre-
  // v0.12 the multi-thumb keyframe thumbnails had no rotation
  // transform, so they appeared sideways in portrait-locked
  // landscape captures (the case the example app's batch-keyframe
  // engine hits).
  const thumbRotationTransform = useMemo<
    Array<{ rotate: string }> | undefined
  >(() => {
    if (vertical) return undefined;
    if (resolvedOrientation === 'landscape-left') return [{ rotate: '90deg' }];
    if (resolvedOrientation === 'landscape-right') return [{ rotate: '-90deg' }];
    return undefined;
  }, [resolvedOrientation, vertical]);

  const singleImageStyle = useMemo(
    () =>
      thumbRotationTransform
        ? [StyleSheet.absoluteFill, { transform: thumbRotationTransform }]
        : StyleSheet.absoluteFill,
    [thumbRotationTransform],
  );

  // Same rotation applied to the per-keyframe (multi-thumb) tiles.
  const multiThumbStyle = useMemo(
    () =>
      thumbRotationTransform
        ? [styles.multiThumb, { transform: thumbRotationTransform }]
        : styles.multiThumb,
    [thumbRotationTransform],
  );

  return (
    <View pointerEvents="none" style={[styles.bandBase, layout.band]}>
      {hasMultiThumb ? (
        // Multi-thumb path: one image per accepted keyframe, scrolling
        // horizontally (in JS-coords) within the band.  Content
        // flex-direction matches the outer band so OLDEST is at the
        // pan-start side and LATEST sits next to the arrow.
        //
        // 2026-05-18 (Issue A — arrow placement) — the arrow is the
        // LAST child of contentContainer (after the thumbnail map)
        // so it flows with the scroll content and always sits
        // adjacent to the newest thumbnail.  Previously it was a
        // sibling of the ScrollView at the band's far end, which
        // looked detached when there were only a few thumbnails.
        <ScrollView
          ref={scrollRef}
          // Horizontal scroll in JS-portrait bands; vertical scroll
          // in JS-landscape (non-locked host) bands.
          horizontal={layout.kind === 'portrait'}
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
              style={multiThumbStyle}
              resizeMode="cover"
              fadeDuration={0}
            />
          ))}
          <View style={styles.arrowTrack}>
            <Text style={styles.arrowGlyph}>{layout.arrowGlyph}</Text>
          </View>
        </ScrollView>
      ) : (
        <>
          {/* Single-thumb path: cumulative panorama image, width
           *  grows with the pan extent.  Visually identical to
           *  pre-V16 PanoramaBandOverlay so live-engine UX is
           *  unchanged.  Arrow stays a sibling here so it sits at
           *  the band's end (the single-thumb View is fixed-width
           *  so the layout is naturally "thumb + arrow"). */}
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
          <View style={styles.arrowTrack}>
            <Text style={styles.arrowGlyph}>{layout.arrowGlyph}</Text>
          </View>
        </>
      )}
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
    // 2026-05-18 (Issue #4 fix-a): contentContainer must FILL the
    // ScrollView width so flexDirection aligns items at the correct
    // end of the viewport.  Without flexGrow, contentContainer
    // takes the natural width of its items (e.g. 150 px for 3
    // thumbs) and anchors at JS-leftmost of the ScrollView, leaving
    // a big empty gap on JS-right.  In landscape-left that gap is
    // on user-TOP — exactly what the operator reports as "thumbs
    // clump at the bottom".  flexGrow:1 makes the contentContainer
    // span the viewport so items align at the END of the row-
    // direction (JS-right for `row`, JS-left for `row-reverse`).
    flexGrow: 1,
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
