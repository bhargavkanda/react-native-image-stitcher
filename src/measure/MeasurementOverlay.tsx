/**
 * MeasurementOverlay — Phase 6 SDK component.
 *
 * Tap-to-pin gesture surface over a saved panorama.  Two modes:
 *
 *   - 'distance' — tap two points; live label shows centimetres
 *     between them.
 *   - 'region'   — tap top-left then bottom-right; live label
 *     shows width × height.
 *
 * Pin positions are anchored in IMAGE pixel coordinates (not screen
 * pixels) so pinch/zoom would translate them naturally if/when the
 * host adds gesture-based zoom — Phase 6.5 territory.  For now the
 * image is laid out at `style`-defined size with `resizeMode='contain'`
 * and pin coordinates are converted on tap.
 *
 * Confidence is surfaced as a coloured chip in the label so the
 * operator knows when to trust the number.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  LayoutChangeEvent,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  type ViewStyle,
} from 'react-native';

import {
  type FramePose,
  type MeasureDistanceResult,
  type MeasureRegionResult,
  measureDistance,
  measureRegion,
} from './measure';


export type MeasurementMode = 'distance' | 'region';


export interface MeasurementOverlayProps {
  /** `file://` URI to the saved panorama JPEG. */
  panoramaUri: string;
  /** Pixel width of the panorama (from the saved file metadata). */
  panoramaWidth: number;
  /** Pixel height of the panorama. */
  panoramaHeight: number;
  /** ARKit poses captured alongside the panorama. */
  framePoses: FramePose[];
  /** Distance between two pinned points OR a rectangular region. */
  mode: MeasurementMode;
  /** Optional override for assumed scene depth (m).  Defaults to native default. */
  sceneDepthMeters?: number;
  /** Called whenever a complete measurement updates. */
  onMeasurement?: (
    result: MeasureDistanceResult | MeasureRegionResult,
  ) => void;
  /** Style override for the outer container. */
  style?: ViewStyle;
}


type Pin = { x: number; y: number };


export function MeasurementOverlay({
  panoramaUri,
  panoramaWidth,
  panoramaHeight,
  framePoses,
  mode,
  sceneDepthMeters,
  onMeasurement,
  style,
}: MeasurementOverlayProps): React.JSX.Element {
  const [layout, setLayout] = useState<{ width: number; height: number } | null>(null);
  const [pinA, setPinA] = useState<Pin | null>(null);
  const [pinB, setPinB] = useState<Pin | null>(null);
  const [result, setResult] = useState<
    MeasureDistanceResult | MeasureRegionResult | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  // Compute the on-screen rectangle the panorama occupies given
  // resizeMode='contain' — we need this to convert tap coordinates
  // (in screen px) back to panorama pixel coordinates.
  const fitRect = useMemo(() => {
    if (!layout || panoramaWidth <= 0 || panoramaHeight <= 0) return null;
    const scale = Math.min(
      layout.width / panoramaWidth,
      layout.height / panoramaHeight,
    );
    const w = panoramaWidth * scale;
    const h = panoramaHeight * scale;
    const x = (layout.width - w) / 2;
    const y = (layout.height - h) / 2;
    return { x, y, w, h, scale };
  }, [layout, panoramaWidth, panoramaHeight]);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    setLayout({
      width: e.nativeEvent.layout.width,
      height: e.nativeEvent.layout.height,
    });
  }, []);

  const handleTap = useCallback(
    (event: { nativeEvent: { locationX: number; locationY: number } }) => {
      if (!fitRect) return;
      const sx = event.nativeEvent.locationX;
      const sy = event.nativeEvent.locationY;
      // Discard taps outside the displayed image.
      if (sx < fitRect.x || sx > fitRect.x + fitRect.w
          || sy < fitRect.y || sy > fitRect.y + fitRect.h) {
        return;
      }
      const px = (sx - fitRect.x) / fitRect.scale;
      const py = (sy - fitRect.y) / fitRect.scale;
      const pin: Pin = { x: px, y: py };
      // Cycle pins: A → B → A → B (replacing latest).
      if (!pinA || (pinA && pinB)) {
        setPinA(pin);
        setPinB(null);
        setResult(null);
      } else {
        setPinB(pin);
      }
    },
    [fitRect, pinA, pinB],
  );

  // Run measurement whenever both pins are set.
  useEffect(() => {
    if (!pinA || !pinB) return;
    let cancelled = false;
    (async () => {
      try {
        if (mode === 'distance') {
          const res = await measureDistance({
            panoramaWidth,
            panoramaHeight,
            framePoses,
            pointA: pinA,
            pointB: pinB,
            sceneDepthMeters,
          });
          if (!cancelled) {
            setResult(res);
            setError(null);
            onMeasurement?.(res);
          }
        } else {
          // Region mode — order pins so first is top-left.
          const tl = {
            x: Math.min(pinA.x, pinB.x),
            y: Math.min(pinA.y, pinB.y),
          };
          const br = {
            x: Math.max(pinA.x, pinB.x),
            y: Math.max(pinA.y, pinB.y),
          };
          const res = await measureRegion({
            panoramaWidth,
            panoramaHeight,
            framePoses,
            topLeft: tl,
            bottomRight: br,
            sceneDepthMeters,
          });
          if (!cancelled) {
            setResult(res);
            setError(null);
            onMeasurement?.(res);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setResult(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pinA, pinB, mode, panoramaWidth, panoramaHeight, framePoses,
      sceneDepthMeters, onMeasurement]);

  // Convert image-pixel pin coords back to screen for rendering.
  const pinToScreen = useCallback((p: Pin | null) => {
    if (!p || !fitRect) return null;
    return {
      left: fitRect.x + p.x * fitRect.scale - PIN_RADIUS,
      top: fitRect.y + p.y * fitRect.scale - PIN_RADIUS,
    };
  }, [fitRect]);

  const screenA = pinToScreen(pinA);
  const screenB = pinToScreen(pinB);

  return (
    <View style={[styles.root, style]} onLayout={onContainerLayout}>
      <TouchableWithoutFeedback onPress={handleTap}>
        <View style={StyleSheet.absoluteFill}>
          <Image
            source={{ uri: panoramaUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            accessibilityLabel="Saved panorama for measurement"
          />
          {/* Connecting line between A and B (distance mode), or
           *  rectangle outline (region mode). */}
          {pinA && pinB && fitRect ? (
            mode === 'distance' ? (
              <ConnectorLine
                a={{
                  x: fitRect.x + pinA.x * fitRect.scale,
                  y: fitRect.y + pinA.y * fitRect.scale,
                }}
                b={{
                  x: fitRect.x + pinB.x * fitRect.scale,
                  y: fitRect.y + pinB.y * fitRect.scale,
                }}
              />
            ) : (
              <View
                style={[styles.regionRect, {
                  left: fitRect.x + Math.min(pinA.x, pinB.x) * fitRect.scale,
                  top: fitRect.y + Math.min(pinA.y, pinB.y) * fitRect.scale,
                  width: Math.abs(pinB.x - pinA.x) * fitRect.scale,
                  height: Math.abs(pinB.y - pinA.y) * fitRect.scale,
                }]}
                pointerEvents="none"
              />
            )
          ) : null}
          {screenA ? <View style={[styles.pin, screenA]} pointerEvents="none" /> : null}
          {screenB ? <View style={[styles.pin, screenB]} pointerEvents="none" /> : null}
        </View>
      </TouchableWithoutFeedback>

      {/* Measurement label */}
      <View style={styles.labelOuter} pointerEvents="none">
        {error ? (
          <Text style={styles.errorLabel} numberOfLines={2}>{error}</Text>
        ) : result ? (
          <View style={styles.labelInner}>
            <Text style={styles.labelText}>
              {'distanceCm' in result
                ? `${result.distanceCm.toFixed(1)} cm`
                : `${result.widthCm.toFixed(1)} × ${result.heightCm.toFixed(1)} cm`}
            </Text>
            <View style={[
              styles.confidenceChip,
              result.confidence === 'high' ? styles.confHigh
                : result.confidence === 'medium' ? styles.confMed
                : styles.confLow,
            ]}>
              <Text style={styles.confidenceChipText}>
                {result.confidence}
              </Text>
            </View>
          </View>
        ) : (
          <Text style={styles.hintLabel}>
            {mode === 'distance'
              ? 'Tap two points to measure distance'
              : 'Tap top-left then bottom-right to measure a region'}
          </Text>
        )}
      </View>
    </View>
  );
}


function ConnectorLine({ a, b }: { a: { x: number; y: number }; b: { x: number; y: number } }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: a.x,
        top: a.y - 1,
        width: length,
        height: 2,
        backgroundColor: '#ffd84a',
        transform: [{ rotateZ: `${angle}rad` }],
        transformOrigin: '0% 50%',
      }}
    />
  );
}


const PIN_RADIUS = 8;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  pin: {
    position: 'absolute',
    width: PIN_RADIUS * 2,
    height: PIN_RADIUS * 2,
    borderRadius: PIN_RADIUS,
    backgroundColor: '#ffd84a',
    borderWidth: 2,
    borderColor: '#000',
  },
  regionRect: {
    position: 'absolute',
    borderColor: '#ffd84a',
    borderWidth: 2,
    backgroundColor: 'rgba(255, 216, 74, 0.12)',
  },
  labelOuter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  labelText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
    marginRight: 10,
  },
  errorLabel: {
    color: '#ff8a8a',
    fontSize: 13,
    textAlign: 'center',
  },
  hintLabel: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 13,
    textAlign: 'center',
  },
  confidenceChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  confidenceChipText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  confHigh: { backgroundColor: '#7be07b' },
  confMed:  { backgroundColor: '#ffd84a' },
  confLow:  { backgroundColor: '#ff8a8a' },
});
