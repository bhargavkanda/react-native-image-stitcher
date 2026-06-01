// SPDX-License-Identifier: Apache-2.0
/**
 * CaptureThumbnailStrip — horizontal thumbnail strip with built-in
 * tap-to-preview modal, designed for the audit capture surface.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  [thumb 4:3]  [thumb 9:16]  [thumb pano]  …             │
 *   │  3 / 5 min · 10 max                                     │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Two reasons this lives in the SDK rather than the host:
 *   1. The thumbnail UX is camera-shaped — tightly coupled to the
 *      `CaptureResult` dimension fields the SDK introduced for
 *      aspect-ratio rendering.  Any host that uses `useCapture`
 *      benefits from the same display logic, so the SDK is the
 *      right home.
 *   2. The preview modal is a non-trivial chunk of UI (full-screen
 *      Image with close affordance + safe-area handling).  Hosts
 *      were inevitably going to re-implement it with subtly
 *      different gesture handling; centralising avoids drift.
 *
 * The strip is intentionally headless about persistence: it knows
 * nothing about WatermelonDB, the host's DB schema, or sync state.
 * Callers pass an array of plain objects with `id`, `uri`, and
 * optional `width`/`height` and the strip handles the rest.
 *
 * Aspect-ratio rendering:
 *   - Thumbnails are anchored at a fixed height (default 60 px)
 *     and width is computed from `width / height` * height.
 *   - Width is clamped to [40, 180] so a tall portrait doesn't
 *     squish to a sliver and a 5000 px panorama doesn't push
 *     siblings off-screen.
 *   - Items missing dimensions (legacy captures saved before the
 *     SDK exposed them) fall back to square — matches prior
 *     behaviour and avoids visual jumps when scrolling mixed
 *     histories.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { CapturePreview } from './CapturePreview';


export interface CaptureThumbnailItem {
  /** Stable id for FlatList keying. */
  id: string;
  /** `file://` or remote URI of the captured image. */
  uri: string;
  /** Image width in pixels.  Optional; falls back to square. */
  width?: number;
  /** Image height in pixels.  Optional; falls back to square. */
  height?: number;
}


export interface CaptureThumbnailStripProps {
  /** Captures to render, in the order they should appear. */
  items: CaptureThumbnailItem[];
  /**
   * Optional minimum-photos hint for the count line.  When `count >=
   * minPhotos` the count text uses the success colour, otherwise it
   * uses the warning colour.  Pass undefined to suppress the hint.
   */
  minPhotos?: number;
  /** Optional maximum-photos hint for the count line. */
  maxPhotos?: number;
  /** Strip background colour (defaults to translucent black). */
  backgroundColor?: string;
  /** Text colour applied to the count line and "No photos" placeholder. */
  textColor?: string;
  /** Colour used when count meets `minPhotos`. */
  successColor?: string;
  /** Colour used when count is below `minPhotos`. */
  warningColor?: string;
  /**
   * Disable tap-to-preview.  When true, thumbnails are still rendered
   * but tapping them is a no-op.  Default false (preview enabled).
   */
  disablePreview?: boolean;
  /**
   * Custom tap handler.  When provided, tapping a thumbnail calls
   * this instead of opening the strip's built-in preview modal.
   * Use this when the host wants to show its own preview UI (e.g.
   * with delete / recapture buttons gated on capture sync state).
   */
  onItemPress?: (item: CaptureThumbnailItem) => void;
  /**
   * Optional outer style.  Layout-related props (height, padding)
   * stay under the strip's control to keep the count line consistent.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * v0.13.1 — when `true`, the strip stacks thumbnails VERTICALLY
   * (column, scrolls up/down) instead of the default horizontal row.
   * `<Camera>` sets this from the same `isSideEdge(homeIndicatorEdge)`
   * signal that drives PanoramaBandOverlay's `vertical`, so under a
   * non-locked host in landscape the idle capture strip stacks along
   * the home-indicator edge like the live band does (rather than
   * running horizontally across the middle of the rotated screen).
   * Default `false` (legacy horizontal strip) — unchanged for
   * portrait-locked hosts.
   */
  vertical?: boolean;
}


/// Fixed thumbnail height — width varies with aspect ratio.
const THUMB_HEIGHT = 60;
/// Width clamps protect the strip from extreme aspect ratios (very
/// tall portraits squishing to a sliver, very wide panoramas pushing
/// siblings off-screen).
const THUMB_MIN_WIDTH = 40;
const THUMB_MAX_WIDTH = 180;


function thumbWidth(item: CaptureThumbnailItem): number {
  const { width, height } = item;
  if (!width || !height || width <= 0 || height <= 0) {
    // Legacy capture without dimensions — fall back to square.
    return THUMB_HEIGHT;
  }
  const ratio = width / height;
  const computed = Math.round(THUMB_HEIGHT * ratio);
  return Math.max(THUMB_MIN_WIDTH, Math.min(THUMB_MAX_WIDTH, computed));
}


export function CaptureThumbnailStrip({
  items,
  minPhotos,
  maxPhotos,
  backgroundColor = 'rgba(0,0,0,0.85)',
  textColor = '#ffffff',
  successColor = '#34C759',
  warningColor = '#FF9F0A',
  disablePreview = false,
  onItemPress,
  style,
  vertical = false,
}: CaptureThumbnailStripProps): React.JSX.Element {
  // Built-in preview state — only used when the host hasn't
  // provided its own onItemPress handler.  Letting the host pass a
  // handler is how the AuditCaptureScreen unifies thumbnail
  // preview with post-stitch confirmation.
  const [previewItem, setPreviewItem] =
    useState<CaptureThumbnailItem | null>(null);

  // Memoise so FlatList doesn't see a fresh callback identity every
  // render and re-render every row.
  const handleItemPress = useCallback(
    (item: CaptureThumbnailItem) => {
      if (disablePreview) return;
      if (onItemPress) {
        onItemPress(item);
        return;
      }
      setPreviewItem(item);
    },
    [disablePreview, onItemPress],
  );

  const closePreview = useCallback(() => setPreviewItem(null), []);

  const countLine = useMemo(() => {
    if (minPhotos === undefined && maxPhotos === undefined) return null;
    const meetsMin =
      minPhotos === undefined ? true : items.length >= minPhotos;
    const text =
      minPhotos !== undefined && maxPhotos !== undefined
        ? `${items.length} / ${minPhotos} min · ${maxPhotos} max`
        : minPhotos !== undefined
          ? `${items.length} / ${minPhotos} min`
          : `${items.length} / ${maxPhotos} max`;
    return (
      <Text
        style={[
          styles.count,
          { color: meetsMin ? successColor : warningColor },
        ]}
        accessibilityLabel={`Captured ${items.length} photos`}
      >
        {text}
      </Text>
    );
  }, [items.length, minPhotos, maxPhotos, successColor, warningColor]);

  return (
    <View style={[styles.root, { backgroundColor }, style]}>
      <FlatList
        data={items}
        horizontal={!vertical}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        contentContainerStyle={
          vertical ? styles.listContentVertical : styles.listContent
        }
        ListEmptyComponent={
          <View
            style={[styles.placeholder, { borderColor: textColor }]}
            accessibilityLabel="No photos captured"
          >
            <Text style={[styles.placeholderText, { color: textColor }]}>
              No photos
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => handleItemPress(item)}
            disabled={disablePreview}
            accessibilityRole="imagebutton"
            accessibilityLabel="Open preview"
            // Resolve the width per-item — done at render rather than
            // inside renderItem's style prop so the function isn't
            // re-created on every parent render.
            style={[
              styles.thumbWrapper,
              // Spacing runs along the scroll axis: marginRight for the
              // horizontal strip, marginBottom for the vertical column.
              vertical ? styles.thumbWrapperVertical : styles.thumbWrapperHorizontal,
              { width: thumbWidth(item), height: THUMB_HEIGHT },
            ]}
          >
            <Image
              source={{ uri: item.uri }}
              style={styles.thumbImage}
              resizeMode="cover"
            />
          </Pressable>
        )}
      />
      {countLine}

      {/* Built-in preview — only shown when host didn't pass
       *  onItemPress.  When the host owns the preview, the strip's
       *  job is just to surface taps via the callback. */}
      <CapturePreview
        visible={previewItem !== null}
        imageUri={previewItem?.uri ?? ''}
        imageWidth={previewItem?.width}
        imageHeight={previewItem?.height}
        onClose={closePreview}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  root: {
    paddingVertical: 8,
  },
  listContent: {
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  listContentVertical: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  thumbWrapper: {
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#222',
  },
  // Spacing applied along the scroll axis (see render site).
  thumbWrapperHorizontal: {
    marginRight: 8,
  },
  thumbWrapperVertical: {
    marginBottom: 8,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    height: THUMB_HEIGHT,
    paddingHorizontal: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    fontSize: 12,
    opacity: 0.6,
  },
  count: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
});
