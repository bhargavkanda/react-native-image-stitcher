// SPDX-License-Identifier: Apache-2.0
/**
 * InscribedRectDebug — a gated dev tool (v0.15) for visually validating
 * the max-inscribed-rectangle crop.
 *
 * Flow:
 *   1. The host captures a panorama with `maxInscribedRectCrop={false}`
 *      so the FULL bounding-rect image (black corners visible) lands.
 *   2. This overlay calls native `BatchStitcher.computeInscribedRect`
 *      (which reuses the exact production algorithm) and draws the
 *      returned rectangle over the full image.
 *   3. On "Crop to rectangle", it calls native `BatchStitcher.cropToRect`
 *      to crop in place — proving the rect was correct.
 *
 * The native methods live in the library (BatchStitcher); these thin JS
 * wrappers stay here so the library's public JS API isn't widened with
 * debug-only surface.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  NativeModules,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

interface InscribedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
}

interface BatchStitcherDebug {
  computeInscribedRect?: (o: { imagePath: string }) => Promise<InscribedRect>;
  cropToRect?: (o: {
    imagePath: string;
    x: number;
    y: number;
    width: number;
    height: number;
    quality: number;
  }) => Promise<{ width: number; height: number }>;
  debugMaskOverlay?: (o: { imagePath: string; threshold?: number }) => Promise<{
    maskPath: string;
    width: number;
    height: number;
    excludedPercent: number;
  }>;
}

const Batch = (NativeModules as { BatchStitcher?: BatchStitcherDebug })
  .BatchStitcher;

export function inscribedRectDebugAvailable(): boolean {
  return (
    typeof Batch?.computeInscribedRect === 'function'
    && typeof Batch?.cropToRect === 'function'
  );
}

interface Props {
  /** file:// URI of the full (uncropped) panorama to inspect. */
  uri: string;
  onClose: () => void;
}

export function InscribedRectDebugOverlay({
  uri,
  onClose,
}: Props): React.JSX.Element {
  const [rect, setRect] = useState<InscribedRect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [cropped, setCropped] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  // Bumped after an in-place crop to force <Image> to re-read the file
  // (RN caches by URI; overwriting the file alone won't refresh it).
  const [reloadKey, setReloadKey] = useState(0);
  // v0.15 — "show mask": tints the dropped (sub-threshold) pixels red so
  // it's visible WHY the inscribed rect lands where it does.
  const [showMask, setShowMask] = useState(false);
  const [maskUri, setMaskUri] = useState<string | null>(null);
  const [excludedPct, setExcludedPct] = useState<number | null>(null);
  const [maskBusy, setMaskBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setRect(null);
    setError(null);
    setCropped(null);
    setShowMask(false);
    setMaskUri(null);
    setExcludedPct(null);
    if (!Batch?.computeInscribedRect) {
      setError('Native computeInscribedRect unavailable (rebuild the app).');
      return;
    }
    Batch.computeInscribedRect({ imagePath: uri })
      .then((r) => {
        if (alive) setRect(r);
      })
      .catch((e: unknown) => {
        if (alive) setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      alive = false;
    };
  }, [uri]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox({ w: width, h: height });
  }, []);

  const handleCrop = useCallback(async () => {
    if (!rect || !Batch?.cropToRect || cropped) return;
    setBusy(true);
    try {
      const dims = await Batch.cropToRect({
        imagePath: uri,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        quality: 90,
      });
      setCropped(dims);
      setReloadKey((k) => k + 1);
      // The image changed on disk — invalidate the cached mask overlay.
      setShowMask(false);
      setMaskUri(null);
      setExcludedPct(null);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [rect, uri, cropped]);

  const toggleMask = useCallback(async () => {
    if (showMask) {
      setShowMask(false);
      return;
    }
    if (maskUri) {
      setShowMask(true);
      return;
    }
    if (!Batch?.debugMaskOverlay) {
      setError('Native debugMaskOverlay unavailable (rebuild the app).');
      return;
    }
    setMaskBusy(true);
    try {
      const m = await Batch.debugMaskOverlay({ imagePath: uri, threshold: 1 });
      setMaskUri(
        m.maskPath.startsWith('file://') ? m.maskPath : `file://${m.maskPath}`,
      );
      setExcludedPct(m.excludedPercent);
      setShowMask(true);
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setMaskBusy(false);
    }
  }, [showMask, maskUri, uri]);

  // Contain-fit transform: map image pixel space → on-screen letterbox.
  let imageBox: { left: number; top: number; width: number; height: number } | null =
    null;
  let overlayRect:
    | { left: number; top: number; width: number; height: number }
    | null = null;
  // After an in-place crop the file on disk is now cropped.width ×
  // cropped.height — size the display box to THAT (not the original) so
  // the cropped preview keeps its aspect ratio instead of stretching.
  const dispW0 = cropped ? cropped.width : rect?.imageWidth ?? 0;
  const dispH0 = cropped ? cropped.height : rect?.imageHeight ?? 0;
  if (rect && box && dispW0 > 0 && dispH0 > 0) {
    const scale = Math.min(box.w / dispW0, box.h / dispH0);
    const dispW = dispW0 * scale;
    const dispH = dispH0 * scale;
    const offX = (box.w - dispW) / 2;
    const offY = (box.h - dispH) / 2;
    imageBox = { left: offX, top: offY, width: dispW, height: dispH };
    if (!cropped) {
      overlayRect = {
        left: offX + rect.x * scale,
        top: offY + rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
      };
    }
  }

  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.canvas} onLayout={onLayout}>
          {imageBox && (
            <Image
              key={`${reloadKey}-${showMask ? 'mask' : 'orig'}`}
              // Cache-bust the panorama URI with reloadKey: cropToRect
              // overwrites the file IN PLACE, and Android's Fresco bitmap
              // cache keys by URI — without a changing query it re-serves
              // the stale pre-crop bitmap (the React `key` remount alone
              // does not evict Fresco's cache).  Fresco reads the file via
              // the URI path and ignores the query, so it still loads.  The
              // mask uses a distinct write-once path (<img>.mask.jpg), so it
              // needs no bust.  (iOS reloads on the key change alone.)
              source={{
                uri: showMask && maskUri ? maskUri : `${uri}?v=${reloadKey}`,
              }}
              style={[styles.image, imageBox]}
              resizeMode="stretch"
            />
          )}
          {overlayRect && <View style={[styles.rect, overlayRect]} pointerEvents="none" />}
          {!rect && !error && (
            <View style={styles.center}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.dim}>Computing inscribed rectangle…</Text>
            </View>
          )}
        </View>

        <View style={styles.bar}>
          {error ? (
            <Text style={styles.err}>{error}</Text>
          ) : cropped ? (
            <Text style={styles.ok}>
              ✓ Cropped to {cropped.width}×{cropped.height}
            </Text>
          ) : rect ? (
            <Text style={styles.dim}>
              Image {rect.imageWidth}×{rect.imageHeight} → rect {rect.width}×
              {rect.height} @ ({rect.x}, {rect.y})
              {showMask && excludedPct !== null
                ? `\n${excludedPct}% dropped by the mask (red)`
                : ''}
            </Text>
          ) : null}

          <View style={styles.buttons}>
            {rect && (
              <Pressable
                style={[styles.btn, maskBusy && styles.btnDisabled]}
                onPress={toggleMask}
                disabled={maskBusy}
              >
                <Text style={styles.btnText}>
                  {maskBusy ? 'Masking…' : showMask ? 'Hide mask' : 'Show mask'}
                </Text>
              </Pressable>
            )}
            {rect && !cropped && (
              <Pressable
                style={[styles.btn, styles.primary, busy && styles.btnDisabled]}
                onPress={handleCrop}
                disabled={busy}
              >
                <Text style={styles.btnText}>
                  {busy ? 'Cropping…' : 'Crop to rectangle'}
                </Text>
              </Pressable>
            )}
            <Pressable style={styles.btn} onPress={onClose}>
              <Text style={styles.btnText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  canvas: { flex: 1 },
  image: { position: 'absolute' },
  rect: {
    position: 'absolute',
    borderColor: '#00E5FF',
    borderWidth: 2,
    backgroundColor: 'rgba(0, 229, 255, 0.18)',
  },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  bar: { padding: 16, backgroundColor: '#111', gap: 12 },
  dim: { color: '#bbb', fontSize: 13, textAlign: 'center' },
  ok: { color: '#4CD964', fontSize: 14, textAlign: 'center', fontWeight: '600' },
  err: { color: '#FF6B6B', fontSize: 13, textAlign: 'center' },
  buttons: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  btn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, backgroundColor: '#333' },
  primary: { backgroundColor: '#0A84FF' },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
