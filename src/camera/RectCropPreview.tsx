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
  Image,
  Modal,
  PanResponder,
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
  onUseOriginal: () => void;
  /**
   * Optional non-fatal warning messages (e.g. "<70 % of frames used") shown
   * as a banner across the top of the editor so the user sees them before
   * accepting a crop.  Empty / undefined → no banner.
   */
  warnings?: string[];
  /**
   * Whether to allow perspective rectify when the user picks a
   * non-rectangular quad.  When `false`, the result's `perspective` is
   * always `false` (host always uses axis-aligned crop).  Default `true`.
   */
  perspectiveCorrect?: boolean;
  /**
   * Optional image-pixel seed rect for the draggable quad.  Defaults to
   * an 8 %-inset rectangle of the full image.
   */
  initialRect?: ImageRect;
  /** Copy overrides (cropConfirm / cropReset). Falls back to defaults. */
  copy?: Partial<GuidanceCopy>;
}


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
    warnings,
    perspectiveCorrect = true,
    initialRect,
    copy,
  } = props;

  const resolvedCopy = useMemo(() => mergeGuidanceCopy(copy), [copy]);

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

  const handleReset = useCallback(() => {
    setImageQuad(seedImageQuad(imageWidth, imageHeight, initialRect));
  }, [imageWidth, imageHeight, initialRect]);

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
    onConfirm({
      quad: ordered,
      perspective: perspectiveCorrect && !axisAligned,
    });
  }, [imageQuad, perspectiveCorrect, onConfirm, onUseOriginal]);

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
    const fit = containFit(box, imageWidth, imageHeight);
    if (fit) {
      imageBox = {
        left: fit.offX,
        top: fit.offY,
        width: imageWidth * fit.scale,
        height: imageHeight * fit.scale,
      };
      screenCorners = imageQuad.map((p) =>
        imageToScreen(p, box, imageWidth, imageHeight),
      );
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
      onRequestClose={onUseOriginal}
      accessibilityLabel="Crop the captured panorama"
      // Mirror OrientationDriftModal: declare all 4 orientations so iOS
      // doesn't force-rotate the window when this opens mid-rotation.
      supportedOrientations={[
        'portrait',
        'portrait-upside-down',
        'landscape-left',
        'landscape-right',
      ]}
    >
      <View style={styles.root}>
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

        <View style={styles.canvas} onLayout={onLayout}>
          {imageBox && (
            <Image
              source={{ uri: imageUri }}
              style={[styles.image, imageBox]}
              resizeMode="stretch"
            />
          )}

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
        </View>

        <View style={styles.bar}>
          <View style={styles.buttons}>
            {/* "Use original" — emit the stitch un-cropped. */}
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
              onPress={onUseOriginal}
              accessibilityRole="button"
              accessibilityLabel={resolvedCopy.cropUseOriginal}
            >
              <Text style={styles.btnText}>{resolvedCopy.cropUseOriginal}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
              onPress={handleReset}
              accessibilityRole="button"
              accessibilityLabel={resolvedCopy.cropReset}
            >
              <Text style={styles.btnText}>{resolvedCopy.cropReset}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.btn,
                styles.primary,
                pressed && styles.btnPressed,
              ]}
              onPress={handleConfirm}
              accessibilityRole="button"
              accessibilityLabel={resolvedCopy.cropConfirm}
            >
              <Text style={styles.btnText}>{resolvedCopy.cropConfirm}</Text>
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
