// SPDX-License-Identifier: Apache-2.0
/**
 * RectCropPreview — item-7 of the first-time-user guidance flow: the
 * post-capture crop editor.
 *
 * Shows the full stitched result image (contain-fit, letterboxed) with a
 * 4-corner quad overlay.  Each corner is INDEPENDENTLY draggable in
 * on-screen coords via RN-core `PanResponder` (deliberately NO
 * react-native-gesture-handler dependency — this library ships zero extra
 * native deps for guidance).  Corner positions are mapped to image-pixel
 * space through the pure `cropGeometry` letterbox transform.
 *
 * ## What it surfaces (and what it does NOT do)
 *
 * This component is presentation + gesture only.  On confirm it computes
 * the 4 image-pixel corners and hands them to `onConfirm` — it does NOT
 * call any native crop.  The PARENT decides between the cheap axis-aligned
 * `cropToRect` (when the quad is ~rectangular) and the perspective
 * `cropToQuad`, using the `perspective` flag in the result:
 *
 *   onConfirm({ quad, perspective: perspectiveCorrect && !isAxisAligned })
 *
 * Promoted + extended from `example/InscribedRectDebug.tsx`, which already
 * did the image-px ↔ on-screen contain-fit mapping, a rect overlay, and
 * the in-place native crop.  This version replaces the single computed
 * inscribed rect with a user-draggable free quad and the perspective
 * decision; the letterbox math now lives in the shared `cropGeometry`
 * module.  Styling is carried over from InscribedRectDebug.
 *
 * ## Seeding
 *
 * The initial quad comes from `initialRect` (image-pixel coords) when the
 * host passes one — `<Camera>` passes the panorama's MAX-INSCRIBED rectangle
 * (the tightest clean rectangle with no black corners; item 2) so the editor
 * opens on a sensible crop the user drags to taste.  With no `initialRect`
 * (native inscribed-rect unavailable) it falls back to an 8 %-inset
 * rectangle.  "Reset" returns to whichever seed was used.
 */

import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PanResponderGestureState,
  type ViewStyle,
} from 'react-native';

import {
  type GuidanceCopy,
  mergeGuidanceCopy,
} from './cameraGuidanceCopy';
import {
  containFit,
  imageToScreen,
  isAxisAlignedRect,
  isQuadValid,
  orderQuadCorners,
  screenToImage,
  type ContainLayout,
  type Point,
  type Quad,
} from './cropGeometry';
import { GUIDANCE_TOKENS } from './guidanceTokens';
import { CaptureMemoryPill } from './CaptureMemoryPill';
import { CaptureRotationPill } from './CaptureRotationPill';


/** Image-pixel rectangle, used for the optional `initialRect` seed. */
export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the host receives when the user taps Crop. */
export interface RectCropResult {
  /**
   * The 4 chosen corners in IMAGE-PIXEL space, canonically ordered
   * [TL, TR, BR, BL].  The host feeds these to the native crop.
   */
  quad: Quad;
  /**
   * `true` → the host should perspective-rectify (`cropToQuad`): the user
   * picked a non-rectangular quad and `perspectiveCorrect` is enabled.
   * `false` → the host can use the cheap axis-aligned `cropToRect` (the
   * quad is ~rectangular, or perspective correction is disabled).
   */
  perspective: boolean;
}


export interface RectCropPreviewProps {
  /** file:// URI of the full result image to crop. */
  imageUri: string;
  /** Intrinsic pixel width of `imageUri`. */
  imageWidth: number;
  /** Intrinsic pixel height of `imageUri`. */
  imageHeight: number;
  /**
   * 2026-06-15 — DEV 3-tab projection comparison.  The PRIMARY image
   * (`imageUri`) is Tab 1 "Spherical" (manual + spherical, the finalize output).
   *
   * `onRequestAlt` → Tab 3 "High-level": re-stitches the SAME captured keyframes
   * via stock cv::Stitcher, ON-DEMAND (only the first time the tab is tapped).
   * `onRequestPlaneProjection` → Tab 2 "Plane": re-stitches via the manual
   * pipeline + plane warper, EAGERLY (kicked off on mount so it's ready to
   * compare).  Each resolves with the output's file:// `uri` AND its OWN
   * DEV-overlay `debugInfo` recipe (so the params pill matches the shown tab),
   * or `null` on failure.  The tab bar appears when either is provided.
   */
  onRequestAlt?: () => Promise<{ uri: string; debugInfo: string } | null>;
  onRequestPlaneProjection?: () => Promise<{ uri: string; debugInfo: string } | null>;
  /**
   * 2026-06-15 (DEV) — gyro rotation magnitude of the capture, in radians.
   * When set, a small pill shows it (rad + degrees) so the dev can read the
   * rotation per capture and tune the panorama-vs-SCANS threshold.
   */
  rRadians?: number;
  /** Show / hide the editor. */
  visible: boolean;
  /**
   * Tapped on "Crop".  Receives the ordered image-pixel quad + the
   * perspective decision; the host performs the actual native crop.
   */
  onConfirm: (result: RectCropResult) => void;
  /**
   * Tapped on "Use original" (or hardware back / dismiss) — emit the stitch
   * un-cropped.  Also called when the user collapses the quad to something
   * un-warpable, so a degenerate quad never reaches the native crop.
   */
  onUseOriginal: (uri?: string) => void;
  /**
   * Tapped on "Retake" — discard this capture entirely and return to the
   * camera.  No result is emitted (the host clears the editor + lets the
   * user capture again).
   */
  onRetake: () => void;
  /**
   * Optional non-fatal warning messages (e.g. "<70 % of frames used") shown
   * as a banner across the top of the editor so the user sees them before
   * accepting a crop.  Empty / undefined → no banner.
   */
  warnings?: string[];
  /**
   * Crop mode vs preview-only mode.  `true` (default) shows the draggable
   * quad + corner handles + the [Retake][Use original][Crop] bar — the full
   * crop editor.  `false` hides the quad and all crop affordances, showing
   * just the stitched image with a [Retake][Confirm] bar — a plain preview
   * (`<Camera showPreview>` without `rectCrop`).  Confirm emits the image
   * un-cropped (same as "Use original").
   */
  showCropControls?: boolean;
  /**
   * Optional image-pixel seed rect for the draggable quad.  Defaults to
   * an 8 %-inset rectangle of the full image.  Ignored in preview-only mode.
   */
  initialRect?: ImageRect;
  /** Copy overrides (cropConfirm / cropReset). Falls back to defaults. */
  copy?: Partial<GuidanceCopy>;
  /**
   * Safe-area insets (px).  The editor is a full-screen Modal, so the host
   * passes `insets.top`/`insets.bottom` to keep the top toolbar (A/B toggle,
   * warnings) clear of the notch/Dynamic Island and the bottom button bar
   * clear of the home indicator.  Default 0.
   */
  topInset?: number;
  bottomInset?: number;
  /**
   * 2026-06-14 (DEV overlay) — optional multi-line debug text describing how
   * this output was stitched (pipeline / warper / route / seam / blend / score
   * / frames / size).  When non-empty, rendered as a small monospace pill in
   * the top-right corner.  The host gates this on `__DEV__`; this component
   * just renders whatever non-empty string it's given.
   */
  debugInfo?: string;
  /**
   * 2026-06-15 — show the live memory-footprint pill (polled native RSS,
   * green/amber/red) on the preview too, so the operator can watch the spike
   * when the on-demand high-level re-stitch fires.  Host gates on settings.debug.
   */
  showMemoryPill?: boolean;
}


/** The three projection-comparison tabs.  'spherical' is the finalize primary
 *  (croppable); 'plane' + 'highlevel' are re-stitched alternates (compare-only). */
type TabMode = 'spherical' | 'plane' | 'highlevel';

/** Per-alt-tab state: the re-stitched output uri + its DEV recipe + image size
 *  (for contain-fit) + loading/failed flags. */
interface AltTab {
  uri: string | null;
  debugInfo: string | null;
  size: { w: number; h: number } | null;
  loading: boolean;
  failed: boolean;
}
const EMPTY_ALT_TAB: AltTab = {
  uri: null,
  debugInfo: null,
  size: null,
  loading: false,
  failed: false,
};

/** Default inset (fraction of each dimension) for the seed quad. */
const DEFAULT_INSET_FRACTION = 0.08;
/** On-screen radius of each draggable corner handle. */
const HANDLE_RADIUS = 16;
/** Enlarged hit-slop radius so the small handle is easy to grab. */
const HANDLE_HIT_RADIUS = 28;


/**
 * Build the seed quad in IMAGE-PIXEL coords: the host's `initialRect` if
 * given, else an inset rectangle of the full image.  Always returned in
 * [TL, TR, BR, BL] order.
 */
function seedImageQuad(
  imageWidth: number,
  imageHeight: number,
  initialRect?: ImageRect,
): Quad {
  if (initialRect) {
    const { x, y, width, height } = initialRect;
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }
  const ix = imageWidth * DEFAULT_INSET_FRACTION;
  const iy = imageHeight * DEFAULT_INSET_FRACTION;
  return [
    { x: ix, y: iy },
    { x: imageWidth - ix, y: iy },
    { x: imageWidth - ix, y: imageHeight - iy },
    { x: ix, y: imageHeight - iy },
  ];
}


export function RectCropPreview(
  props: RectCropPreviewProps,
): React.JSX.Element {
  const {
    imageUri,
    imageWidth,
    imageHeight,
    visible,
    onConfirm,
    onUseOriginal,
    onRetake,
    warnings,
    showCropControls = true,
    initialRect,
    copy,
    topInset = 0,
    bottomInset = 0,
    debugInfo,
    onRequestAlt,
    onRequestPlaneProjection,
    rRadians,
    showMemoryPill,
  } = props;

  const resolvedCopy = useMemo(() => mergeGuidanceCopy(copy), [copy]);

  // ── 3-tab projection comparison ─────────────────────────────────────
  // Tab 1 "Spherical" = the PRIMARY (imageUri), the manual+spherical finalize
  // output (croppable). Tab 2 "Plane" = manual+plane, computed EAGERLY on mount.
  // Tab 3 "High-level" = stock cv::Stitcher, computed ON-DEMAND on first tap.
  // Each alt tab tracks its uri + DEV recipe + image size + loading/failed.
  const [activeTab, setActiveTab] = useState<TabMode>('spherical');
  const [planeTab, setPlaneTab] = useState<AltTab>(EMPTY_ALT_TAB);
  const [highTab, setHighTab] = useState<AltTab>(EMPTY_ALT_TAB);
  const tabsOffered = !!onRequestPlaneProjection || !!onRequestAlt;

  // EAGER: kick off the Plane re-stitch once on mount (sequential after the
  // finalize primary — peak stays ~1 stitch).  Cancel-guarded against unmount.
  React.useEffect(() => {
    if (!onRequestPlaneProjection) return undefined;
    let cancelled = false;
    setPlaneTab((s) => ({ ...s, loading: true, failed: false }));
    onRequestPlaneProjection()
      .then((r) => {
        if (cancelled) return;
        setPlaneTab((s) =>
          r ? { ...s, uri: r.uri, debugInfo: r.debugInfo } : { ...s, failed: true });
      })
      .catch(() => { if (!cancelled) setPlaneTab((s) => ({ ...s, failed: true })); })
      .finally(() => { if (!cancelled) setPlaneTab((s) => ({ ...s, loading: false })); });
    return () => { cancelled = true; };
  }, [onRequestPlaneProjection]);

  // ON-DEMAND: compute the High-level tab on first tap (ref-guard prevents
  // double-stitch); switch to it immediately (it shows a spinner while running).
  const highStartedRef = useRef(false);
  const showHighLevel = React.useCallback(() => {
    setActiveTab('highlevel');
    if (highStartedRef.current || !onRequestAlt) return;
    highStartedRef.current = true;
    setHighTab((s) => ({ ...s, loading: true, failed: false }));
    onRequestAlt()
      .then((r) =>
        setHighTab((s) =>
          r ? { ...s, uri: r.uri, debugInfo: r.debugInfo } : { ...s, failed: true }))
      .catch(() => setHighTab((s) => ({ ...s, failed: true })))
      .finally(() => setHighTab((s) => ({ ...s, loading: false })));
  }, [onRequestAlt]);

  // Fetch each alt tab's image size once its uri arrives (for the contain-fit).
  React.useEffect(() => {
    if (!planeTab.uri) return;
    Image.getSize(planeTab.uri, (w, h) => setPlaneTab((s) => ({ ...s, size: { w, h } })), () => {});
  }, [planeTab.uri]);
  React.useEffect(() => {
    if (!highTab.uri) return;
    Image.getSize(highTab.uri, (w, h) => setHighTab((s) => ({ ...s, size: { w, h } })), () => {});
  }, [highTab.uri]);

  const activeAlt: AltTab | null =
    activeTab === 'plane' ? planeTab : activeTab === 'highlevel' ? highTab : null;
  // Only the Spherical primary is croppable; the alt tabs are compare-only.
  const isCroppable = activeTab === 'spherical';
  // showAlt: an alt tab is selected AND its image is loaded (uri + size).  Until
  // then we keep showing the spherical primary (so a tab tap never blanks).
  const showAlt = activeAlt != null && !!activeAlt.uri && !!activeAlt.size;
  const activeUri = showAlt ? (activeAlt!.uri as string) : imageUri;
  const activeW = showAlt ? (activeAlt!.size as { w: number }).w : imageWidth;
  const activeH = showAlt ? (activeAlt!.size as { h: number }).h : imageHeight;

  // The 4 corners live in IMAGE-PIXEL space (the source of truth) so they
  // survive layout-box changes (rotation, keyboard) without drift.  We map
  // to screen for rendering and back on every drag via cropGeometry.
  const [imageQuad, setImageQuad] = useState<Quad>(() =>
    seedImageQuad(imageWidth, imageHeight, initialRect),
  );

  const [box, setBox] = useState<ContainLayout | null>(null);

  // Drag bookkeeping kept in refs so the per-move handler doesn't churn
  // state identity / re-create PanResponders mid-gesture.
  const boxRef = useRef<ContainLayout | null>(null);
  const dragCornerRef = useRef<number | null>(null);
  // Screen-space corner positions at gesture start, so dx/dy from the
  // gesture state apply to a stable origin (PanResponder reports
  // cumulative deltas from touch-down, not per-frame).
  const dragStartScreenRef = useRef<Point | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const next = { width, height };
    boxRef.current = next;
    setBox(next);
  }, []);

  const handleConfirm = useCallback(() => {
    const ordered = orderQuadCorners(imageQuad);
    // Guard: if the user collapsed the quad to something un-warpable, emit
    // the original un-cropped panorama rather than hand native a degenerate
    // quad.
    if (!isQuadValid(ordered)) {
      onUseOriginal();
      return;
    }
    const axisAligned = isAxisAlignedRect(ordered);
    // A skewed quad is perspective-rectified; a ~rectangular drag is a plain
    // axis-aligned crop.  (The former `perspectiveCorrect` opt-out was removed
    // in v0.16 — the SDK always honours a skewed quad with a warp.)
    onConfirm({
      quad: ordered,
      perspective: !axisAligned,
    });
  }, [imageQuad, onConfirm, onUseOriginal]);

  // One PanResponder per corner.  Built once (the corner index is the
  // closure key); the move handler reads live box/quad via refs + setState
  // updater so the responders never need to be rebuilt on drag.
  const responders = useMemo(
    () =>
      [0, 1, 2, 3].map((corner) =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderGrant: () => {
            dragCornerRef.current = corner;
            const layout = boxRef.current;
            if (!layout) return;
            // Capture this corner's screen position at touch-down.
            setImageQuad((q) => {
              dragStartScreenRef.current = imageToScreen(
                q[corner],
                layout,
                imageWidth,
                imageHeight,
              );
              return q;
            });
          },
          onPanResponderMove: (
            _e: GestureResponderEvent,
            gesture: PanResponderGestureState,
          ) => {
            const layout = boxRef.current;
            const start = dragStartScreenRef.current;
            if (!layout || !start) return;
            const screenPt: Point = {
              x: start.x + gesture.dx,
              y: start.y + gesture.dy,
            };
            const imgPt = screenToImage(
              screenPt,
              layout,
              imageWidth,
              imageHeight,
            );
            setImageQuad((q) => {
              const next = [...q] as Quad;
              next[corner] = imgPt;
              return next;
            });
          },
          onPanResponderRelease: () => {
            dragCornerRef.current = null;
            dragStartScreenRef.current = null;
          },
          onPanResponderTerminate: () => {
            dragCornerRef.current = null;
            dragStartScreenRef.current = null;
          },
        }),
      ),
    [imageWidth, imageHeight],
  );

  // ── Derived screen geometry (recomputed each render from the box) ──
  // The display box (letterboxed image rect) and the 4 corners projected
  // into screen space for the overlay + handles.
  let imageBox: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null = null;
  let screenCorners: Point[] | null = null;

  if (box) {
    const fit = containFit(box, activeW, activeH);
    if (fit) {
      imageBox = {
        left: fit.offX,
        top: fit.offY,
        width: activeW * fit.scale,
        height: activeH * fit.scale,
      };
      // Quad corners only apply to the Spherical primary (the croppable tab) —
      // hidden on the Plane / High-level compare-only tabs.
      screenCorners = isCroppable
        ? imageQuad.map((p) => imageToScreen(p, box, imageWidth, imageHeight))
        : null;
    }
  }

  // Outline path (a <View> per edge — RN core has no <Polygon>; this
  // mirrors InscribedRectDebug's single-rect border treatment, generalised
  // to 4 free edges).
  const edges = screenCorners
    ? screenCorners.map((from, i) => {
        const to = screenCorners![(i + 1) % screenCorners!.length];
        return edgeStyle(from, to);
      })
    : [];

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={() => onUseOriginal()}
      accessibilityLabel={
        showCropControls
          ? 'Crop the captured panorama'
          : 'Review the captured panorama'
      }
      // Mirror OrientationDriftModal: declare all 4 orientations so iOS
      // doesn't force-rotate the window when this opens mid-rotation.
      supportedOrientations={[
        'portrait',
        'portrait-upside-down',
        'landscape-left',
        'landscape-right',
      ]}
    >
      <View style={[styles.root, { paddingTop: topInset }]}>
        {/* Live memory-footprint pill (host gates on settings.debug).  Top-LEFT
            so it clears the top-right stitch-params pill; watch it spike when
            the high-level re-stitch fires. */}
        {showMemoryPill ? (
          <CaptureMemoryPill
            style={{
              position: 'absolute',
              top: topInset + (tabsOffered ? 76 : 8),
              left: 12,
              zIndex: 21,
            }}
          />
        ) : null}

        {/* Gyro rotation readout (host gates on __DEV__) — read it per capture
            to tune the panorama-vs-SCANS threshold.  Top-LEFT, stacked below the
            memory pill when both show. */}
        {rRadians != null ? (
          <CaptureRotationPill
            rRadians={rRadians}
            style={{
              position: 'absolute',
              top: topInset + (tabsOffered ? 76 : 8) + (showMemoryPill ? 34 : 0),
              left: 12,
              zIndex: 21,
            }}
          />
        ) : null}

        {/* DEV stitch-params overlay (host gates on __DEV__).  Top-right pill;
            pushed below the A/B bar when that's present so they don't overlap.
            A/B-AWARE: while the user is viewing the on-demand high-level tab and
            its recipe is known, show the HIGH-LEVEL recipe (pipe=highlevel;…)
            instead of the manual primary's `debugInfo` — otherwise the pill
            would misleadingly claim the manual recipe for a high-level output. */}
        {(() => {
          const pillText =
            activeTab === 'plane' ? planeTab.debugInfo
            : activeTab === 'highlevel' ? highTab.debugInfo
            : debugInfo;
          return pillText ? (
            <View
              style={[
                styles.debugPill,
                { top: topInset + (tabsOffered ? 76 : 8) },
              ]}
              pointerEvents="none"
              accessibilityRole="text"
            >
              <Text style={styles.debugPillText}>{pillText}</Text>
            </View>
          ) : null;
        })()}

        {/* Non-fatal warning banner (e.g. "<70 % of frames used"), shown
            ABOVE the image so the user sees it before accepting a crop. */}
        {warnings && warnings.length > 0 && (
          <View style={styles.warningBanner} accessibilityRole="alert">
            {warnings.map((w, i) => (
              <Text key={`warn-${i}`} style={styles.warningText}>
                {w}
              </Text>
            ))}
          </View>
        )}

        {/* 3-tab projection comparison.  Spherical = manual+spherical finalize
            primary (croppable); Plane = manual+plane (eager); High-level = stock
            cv::Stitcher (on-demand).  The active tab spins while it stitches. */}
        {tabsOffered && (
          <View style={styles.abBar}>
            <Text style={styles.abBarLabel}>
              {activeTab === 'plane' && planeTab.loading
                ? 'Computing plane projection…'
                : activeTab === 'highlevel' && highTab.loading
                  ? 'Stitching high-level…'
                  : activeTab === 'plane' && planeTab.failed
                    ? 'Plane stitch failed — showing spherical'
                    : activeTab === 'highlevel' && highTab.failed
                      ? 'High-level stitch failed — showing spherical'
                      : 'Tap a projection to compare:'}
            </Text>
            <View style={styles.abSegments}>
              <Pressable
                style={[styles.abSeg, activeTab === 'spherical' && styles.abSegActive]}
                onPress={() => setActiveTab('spherical')}
                accessibilityRole="button"
                accessibilityState={{ selected: activeTab === 'spherical' }}
                accessibilityLabel="View spherical projection (manual, croppable)"
              >
                <Text
                  style={[styles.abSegText, activeTab === 'spherical' && styles.abSegTextActive]}
                >
                  Spherical
                </Text>
              </Pressable>
              {onRequestPlaneProjection ? (
                <Pressable
                  style={[styles.abSeg, activeTab === 'plane' && styles.abSegActive]}
                  onPress={() => setActiveTab('plane')}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeTab === 'plane', busy: planeTab.loading }}
                  accessibilityLabel="View plane projection (manual)"
                >
                  {planeTab.loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text
                      style={[styles.abSegText, activeTab === 'plane' && styles.abSegTextActive]}
                    >
                      Plane
                    </Text>
                  )}
                </Pressable>
              ) : null}
              {onRequestAlt ? (
                <Pressable
                  style={[styles.abSeg, activeTab === 'highlevel' && styles.abSegActive]}
                  onPress={showHighLevel}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeTab === 'highlevel', busy: highTab.loading }}
                  accessibilityLabel="View high-level pipeline (computed on demand)"
                >
                  {highTab.loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text
                      style={[styles.abSegText, activeTab === 'highlevel' && styles.abSegTextActive]}
                    >
                      High-level
                    </Text>
                  )}
                </Pressable>
              ) : null}
            </View>
          </View>
        )}

        <View style={styles.canvas} onLayout={onLayout}>
          {imageBox && (
            <Image
              source={{ uri: activeUri }}
              style={[styles.image, imageBox]}
              resizeMode="stretch"
            />
          )}

          {/* Crop affordances — quad edges + draggable handles — only in crop
              mode on the Spherical primary (hidden on the compare-only tabs). */}
          {showCropControls && isCroppable && (
            <>
              {/* Quad edges (non-interactive). */}
              {edges.map((e, i) => (
                <View key={`edge-${i}`} style={[styles.edge, e]} pointerEvents="none" />
              ))}

              {/* Draggable corner handles. */}
              {screenCorners
                && screenCorners.map((c, i) => (
                  <View
                    key={`handle-${i}`}
                    {...responders[i].panHandlers}
                    hitSlop={{
                      top: HANDLE_HIT_RADIUS,
                      bottom: HANDLE_HIT_RADIUS,
                      left: HANDLE_HIT_RADIUS,
                      right: HANDLE_HIT_RADIUS,
                    }}
                    accessibilityRole="adjustable"
                    accessibilityLabel={`Crop corner ${i + 1}`}
                    style={[
                      styles.handle,
                      {
                        left: c.x - HANDLE_RADIUS,
                        top: c.y - HANDLE_RADIUS,
                      },
                    ]}
                  >
                    <View style={styles.handleDot} pointerEvents="none" />
                  </View>
                ))}
            </>
          )}
        </View>

        <View style={[styles.bar, { paddingBottom: 16 + bottomInset }]}>
          <View style={styles.buttons}>
            {/* "Retake" — discard this capture, back to the camera. */}
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
              onPress={onRetake}
              accessibilityRole="button"
              accessibilityLabel={resolvedCopy.cropRetake}
            >
              <Text style={styles.btnText}>{resolvedCopy.cropRetake}</Text>
            </Pressable>
            {/* Crop mode only — "Use original" emits the stitch un-cropped.
                Hidden in preview-only mode and on the compare-only tabs (the
                primary button below is the accept action there). */}
            {showCropControls && isCroppable && (
              <Pressable
                style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
                onPress={() => onUseOriginal()}
                accessibilityRole="button"
                accessibilityLabel={resolvedCopy.cropUseOriginal}
              >
                <Text style={styles.btnText}>{resolvedCopy.cropUseOriginal}</Text>
              </Pressable>
            )}
            {/* Primary action — on a compare-only tab "Use this" emits the SHOWN
                projection's output; on the Spherical primary "Crop" applies the
                quad (crop mode) or "Confirm" accepts as-is (preview-only mode). */}
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.primary,
                pressed && styles.btnPressed,
              ]}
              onPress={
                !isCroppable
                  ? () => onUseOriginal(activeUri)
                  : showCropControls
                    ? handleConfirm
                    : () => onUseOriginal()
              }
              accessibilityRole="button"
              accessibilityLabel={
                !isCroppable
                  ? 'Use this output'
                  : showCropControls
                    ? resolvedCopy.cropConfirm
                    : resolvedCopy.previewConfirm
              }
            >
              <Text style={styles.btnText}>
                {!isCroppable
                  ? 'Use this'
                  : showCropControls
                    ? resolvedCopy.cropConfirm
                    : resolvedCopy.previewConfirm}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}


/**
 * Absolute-positioned style for a 1-px-thick edge line between two
 * screen points (origin → length + rotation).  RN core has no line
 * primitive, so we render a thin rotated <View> per quad edge.
 */
function edgeStyle(
  from: Point,
  to: Point,
): {
  left: number;
  top: number;
  width: number;
  transform: ViewStyle['transform'];
} {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  return {
    left: from.x,
    top: from.y,
    width: length,
    // Rotate about the line's start point (RN rotates about centre, so
    // translate the midpoint back onto the start first).
    transform: [
      { translateX: -length / 2 },
      { rotate: `${angle}rad` },
      { translateX: length / 2 },
    ],
  };
}


const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  debugPill: {
    position: 'absolute',
    right: 8,
    zIndex: 20,
    maxWidth: '60%',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.66)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(120,220,160,0.5)',
  },
  debugPillText: {
    color: '#7fe3a8',
    fontSize: 10,
    lineHeight: 14,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  warningBanner: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(255,196,98,0.16)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: GUIDANCE_TOKENS.amber,
    gap: 4,
  },
  warningText: {
    color: GUIDANCE_TOKENS.amber,
    fontSize: 13,
    fontWeight: '600',
  },
  abBar: {
    backgroundColor: '#1a1a1a',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  abBarLabel: {
    color: '#aaa',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  abSegments: {
    flexDirection: 'row',
    alignSelf: 'center',
    backgroundColor: '#000',
    borderRadius: 9,
    padding: 3,
  },
  abSeg: {
    paddingVertical: 7,
    paddingHorizontal: 22,
    borderRadius: 7,
  },
  abSegActive: {
    backgroundColor: '#0A84FF',
  },
  abSegText: {
    color: '#9aa',
    fontSize: 14,
    fontWeight: '700',
  },
  abSegTextActive: {
    color: '#fff',
  },
  canvas: { flex: 1 },
  image: { position: 'absolute' },
  edge: {
    position: 'absolute',
    height: 2,
    backgroundColor: GUIDANCE_TOKENS.amber,
  },
  handle: {
    position: 'absolute',
    width: HANDLE_RADIUS * 2,
    height: HANDLE_RADIUS * 2,
    borderRadius: HANDLE_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 2,
    borderColor: GUIDANCE_TOKENS.white,
  },
  handleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: GUIDANCE_TOKENS.amber,
  },
  bar: { padding: 16, backgroundColor: '#111', gap: 12 },
  buttons: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: '#333',
  },
  primary: { backgroundColor: '#0A84FF' },
  btnPressed: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
