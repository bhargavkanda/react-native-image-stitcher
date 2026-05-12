/**
 * LiveFrameStrip — mini strip of live preview snapshots captured
 * during a panorama hold.
 *
 * @deprecated V16 Phase 2 — folded into `<PanoramaBandOverlay />`,
 *   which now renders BOTH the cumulative-panorama thumbnail AND the
 *   scrolling per-keyframe strip in one cohesive band (single
 *   component, iOS + Android parity).  New host code should mount
 *   `<PanoramaBandOverlay state={...} frameUris={...} />` and skip
 *   `<LiveFrameStrip />` entirely.  This file is kept exported so
 *   external consumers of @retailens/capture-sdk don't break on
 *   upgrade; it will be deleted in a future major version.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ [f1][f2][f3][f4]…                                        │ ← portrait (top, L→R)
 *   │                                                          │
 *   │       (camera preview underneath)                        │
 *   └──────────────────────────────────────────────────────────┘
 *
 *   ┌────┐
 *   │ f1 │
 *   ├────┤        (camera preview to the right)
 *   │ f2 │                                                    ← landscape (left, T→B)
 *   ├────┤
 *   │ f3 │
 *   └────┘
 *
 * Why this exists
 *   The user releases the shutter not knowing whether their pan
 *   actually captured anything useful — the only feedback is the
 *   eventual stitch result a few seconds later.  Showing each frame
 *   as it's snapshotted closes that loop in real time, just like
 *   the iOS native panorama UX.
 *
 * Frame source
 *   `cameraRef.current.takeSnapshot()` runs on a setInterval while
 *   `active` is true.  vision-camera's takeSnapshot is designed to
 *   produce low-latency preview frames in parallel with an active
 *   video recording — exactly the situation here (the host calls
 *   `useVideoCapture.startRecording` for the actual stitching
 *   source, while we sample lighter previews for the UI).
 *
 * Orientation
 *   Auto-detect via `useWindowDimensions`.  Portrait → strip is a
 *   horizontal row pinned to the top, frames append to the right.
 *   Landscape → strip is a vertical column pinned to the left,
 *   frames append downward.  Matches the natural pan direction the
 *   user will use in each orientation (left→right in portrait,
 *   top→bottom in landscape).
 *
 * Performance
 *   - Snapshot interval is 500 ms by default (configurable).  Each
 *     snapshot is a few hundred KB, written to a tmp directory the
 *     OS reclaims at app launch — no manual cleanup needed.
 *   - When `active` flips false, the interval stops AND the frame
 *     list clears.  Keeps mid-pan state from leaking into the next
 *     panorama.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { Camera } from 'react-native-vision-camera';

import { useDeviceOrientation } from './useDeviceOrientation';


/// How often to grab a preview snapshot during recording.
/// 500 ms = ~6 frames per typical 3 s pan → enough to feel "live"
/// without flooding the JS thread with image decodes.
const DEFAULT_SAMPLE_INTERVAL_MS = 500;

/// Strip height (portrait) / width (landscape) in pixels.
const STRIP_BREADTH = 56;
/// Per-frame size along the strip's primary axis.
const FRAME_LEN = 56;


export interface LiveFrameStripProps {
  /**
   * Ref to the underlying vision-camera `<Camera>` (forwarded by
   * `<CameraView>`).  Used to call `takeSnapshot` periodically when
   * `frameUris` is NOT provided (the legacy AR-OFF / batch path).
   *
   * In the V16 AR + batch-keyframe path, vision-camera doesn't own
   * the camera (ARKit does), so `takeSnapshot` would fail.  Pass
   * `frameUris` instead and leave `cameraRef` undefined — the strip
   * skips the snapshot polling entirely.
   */
  cameraRef?: React.RefObject<Camera | null>;
  /**
   * V16 Phase 1 — externally-provided thumbnail URIs.  When set,
   * the strip renders these directly and ignores `cameraRef`.  Used
   * by AR-mode batch-keyframe: each frame the KeyframeGate accepts
   * is saved by the native `OpenCVKeyframeCollector` and its path
   * is pushed into this array via the host's IncrementalState
   * subscription.
   *
   * Pass `undefined` (or omit) to keep the legacy
   * `cameraRef.takeSnapshot()` polling behaviour.
   */
  frameUris?: string[];
  /**
   * Sample frames only while this is true.  Wire to the recording
   * phase of your capture flow — typically `statusPhase === 'recording'`.
   */
  active: boolean;
  /**
   * Interval between snapshots in milliseconds.  Default 500 ms.
   * Only relevant when `cameraRef`-driven (legacy mode).  Don't go
   * below 200 ms; vision-camera's snapshot pipeline can't keep up.
   */
  sampleIntervalMs?: number;
  /**
   * Force the strip orientation instead of auto-detecting.  Useful
   * for hosts that always want the same axis.
   */
  orientation?: 'horizontal' | 'vertical';
  /** Strip background colour.  Defaults to translucent black. */
  backgroundColor?: string;
  /** Outer style passthrough. */
  style?: StyleProp<ViewStyle>;
}


export function LiveFrameStrip({
  cameraRef,
  frameUris: externalFrameUris,
  active,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  orientation,
  backgroundColor = 'rgba(0,0,0,0.55)',
  style,
}: LiveFrameStripProps): React.JSX.Element | null {
  // Use the accelerometer-based hook so we detect device rotation
  // even when the host app is portrait-locked at the OS level.
  const deviceOrientation = useDeviceOrientation();
  const isPortrait =
    deviceOrientation === 'portrait'
    || deviceOrientation === 'portrait-upside-down';
  const resolvedOrientation =
    orientation ?? (isPortrait ? 'horizontal' : 'vertical');

  // Two source modes:
  //   1. external (V16 batch-keyframe): the host pushes URIs into
  //      the `externalFrameUris` prop on each keyframe-accepted
  //      event.  We render those directly.
  //   2. legacy (vision-camera batch path): we poll `cameraRef`
  //      via takeSnapshot every `sampleIntervalMs` and accumulate
  //      results in this internal state.
  const [internalFrameUris, setInternalFrameUris] = useState<string[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Imperative handle on the ScrollView so we can scroll to the
  // latest frame each time one's added.  Without this, frames
  // accumulate beyond the visible area and the operator can't see
  // the most recent ones — defeats the purpose of a live preview.
  const scrollRef = useRef<ScrollView | null>(null);

  const externalMode = externalFrameUris !== undefined;

  const captureOne = useCallback(async () => {
    const cam = cameraRef?.current;
    if (!cam) return;
    try {
      const snap = await cam.takeSnapshot({ quality: 50 });
      if (!snap?.path) return;
      const uri = snap.path.startsWith('file://')
        ? snap.path
        : `file://${snap.path}`;
      setInternalFrameUris((prev) => {
        const next = [...prev, uri];
        return next.length > 24 ? next.slice(next.length - 24) : next;
      });
    } catch (err) {
      // Swallow per-frame errors so a transient takeSnapshot failure
      // doesn't tear down the whole interval.  vision-camera throws
      // here if the camera session is paused mid-snapshot, etc.
      // eslint-disable-next-line no-console
      console.warn('[LiveFrameStrip] takeSnapshot failed', err);
    }
  }, [cameraRef]);

  useEffect(() => {
    if (!active) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setInternalFrameUris([]);
      return;
    }
    // External mode: host pushes URIs via the prop, no polling.
    // takeSnapshot would fail anyway (ARKit owns the camera).
    if (externalMode) {
      return;
    }
    captureOne();
    intervalRef.current = setInterval(captureOne, sampleIntervalMs);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, sampleIntervalMs, captureOne, externalMode]);

  if (!active) return null;
  const stripFrameUris = externalMode
    ? (externalFrameUris ?? [])
    : internalFrameUris;
  if (stripFrameUris.length === 0) return null;

  // Layout swaps between row / column based on the resolved
  // orientation.  In both axes the natural pan-start is the
  // beginning of the array, so the array order maps directly to
  // visual order without reversing.
  const isHorizontal = resolvedOrientation === 'horizontal';

  // Anchor at user-perceived top in portrait, user-perceived left
  // (which corresponds to the natural pan-start) in landscape.
  // landscape-left rotates the strip 90° CW; landscape-right CCW.
  const rootStyle = stripStyleForOrientation(deviceOrientation);

  return (
    <View
      pointerEvents="none"
      style={[
        styles.root,
        rootStyle,
        { backgroundColor },
        style,
      ]}
      accessibilityLabel={`Live preview, ${stripFrameUris.length} frames captured`}
    >
      <ScrollView
        ref={scrollRef}
        horizontal={isHorizontal}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.list,
          isHorizontal ? styles.listRow : styles.listColumn,
        ]}
        // Auto-scroll to end whenever the content size changes
        // (i.e., a new frame was just appended).  No animation —
        // the snap-to-end feel is instant and matches the "frames
        // are streaming in" mental model.
        onContentSizeChange={() => {
          scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        {stripFrameUris.map((uri, idx) => (
          <Image
            key={`${uri}-${idx}`}
            source={{ uri }}
            style={styles.frame}
            resizeMode="cover"
          />
        ))}
      </ScrollView>
    </View>
  );
}


/**
 * Position + rotation for the strip per device orientation.
 * Always anchored at user-perceived top (portrait) or
 * user-perceived left (landscape) so the strip is visible without
 * obscuring the camera preview.
 */
function stripStyleForOrientation(
  orientation:
    | 'portrait'
    | 'portrait-upside-down'
    | 'landscape-left'
    | 'landscape-right',
): {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  width?: number;
  height?: number;
  flexDirection?: 'row' | 'column';
} {
  // Mapping from device orientation to layout-edge → user-edge:
  //   landscape-left  (CCW): layout-top    = user-left
  //   landscape-right (CW):  layout-bottom = user-left
  //   portrait:              layout-top    = user-top
  //   portrait-upside-down:  layout-bottom = user-top
  // We always want the strip on the user's perceived "natural pan
  // start" side — top in portrait, left in landscape — so the
  // first captured frame is at user-top.
  switch (orientation) {
    case 'landscape-left':
      return {
        top: 0,
        left: 0,
        right: 0,
        height: STRIP_BREADTH + 8,
        flexDirection: 'row',
      };
    case 'landscape-right':
      return {
        bottom: 0,
        left: 0,
        right: 0,
        height: STRIP_BREADTH + 8,
        flexDirection: 'row',
      };
    case 'portrait-upside-down':
      return {
        bottom: 0,
        left: 0,
        right: 0,
        height: STRIP_BREADTH + 8,
        flexDirection: 'row',
      };
    case 'portrait':
    default:
      return {
        top: 0,
        left: 0,
        right: 0,
        height: STRIP_BREADTH + 8,
        flexDirection: 'row',
      };
  }
}


const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    overflow: 'hidden',
  },
  rootPortrait: {
    top: 0,
    left: 0,
    right: 0,
    height: STRIP_BREADTH + 8,
    flexDirection: 'row',
  },
  rootLandscape: {
    top: 0,
    bottom: 0,
    left: 0,
    width: STRIP_BREADTH + 8,
    flexDirection: 'column',
  },
  list: {
    padding: 4,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  listColumn: {
    flexDirection: 'column',
    alignItems: 'center',
  },
  frame: {
    width: FRAME_LEN,
    height: FRAME_LEN,
    borderRadius: 4,
    marginRight: 4,
    marginBottom: 4,
    backgroundColor: '#222',
  },
});
