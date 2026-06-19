/**
 * RNImageStitcherExample — minimal host that demonstrates the public
 * `<Camera>` component end-to-end.
 *
 *   - Tap shutter → photo captured.
 *   - Hold + pan + release → panorama stitched.
 *   - On capture, a fullscreen preview modal appears showing the
 *     resulting image with a Close button so the operator can
 *     visually verify the output before dismissing.
 *   - Camera permission is requested up-front and a "Grant Access"
 *     overlay is shown if denied.  The SDK assumes the host has
 *     resolved permission BEFORE mounting `<Camera>` (the SDK
 *     itself does not call `requestPermission`).
 *   - All callback props are wired to console.log so the event flow
 *     is observable on-device.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useCameraPermission,
  // v0.15 — the SDK's `useFrameProcessor` host-worklet hook was archived in
  // the batch-keyframe cleanup.  Compose first-party stitching directly on
  // vision-camera's own `useFrameProcessor` + `useStitcherWorklet().call`,
  // exactly as the `useStitcherWorklet` docblock prescribes.
  useFrameProcessor,
  type Frame,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import {
  Camera,
  getIncrementalNativeModule,
  subscribeIncrementalState,
  useKeyframeStream,
  useStitcherWorklet,
  userFacingStitchError,
  type AcceptedKeyframe,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type CaptureThumbnailItem,
  type CapturePreviewAction,
  type FramesDroppedInfo,
  type IncrementalState,
  type PanMode,
  type CameraFrame,
} from 'react-native-image-stitcher';


function App(): React.JSX.Element {
  // Camera permission is a HOST concern — the SDK does not request
  // it.  iOS auto-prompts on first AVCaptureSession use; Android
  // REQUIRES an explicit requestPermission() call (Android treats
  // unrequested permissions as auto-denied even when declared in the
  // manifest).  We resolve permission BEFORE mounting <Camera>.
  const { hasPermission, requestPermission } = useCameraPermission();
  useEffect(() => {
    if (!hasPermission) {
      requestPermission().catch(() => undefined);
    }
  }, [hasPermission, requestPermission]);

  // Last capture (photo or panorama).  Set in onCapture, cleared on
  // preview modal dismiss.  Drives the visibility of the modal.
  // Only SUCCESSFUL captures are previewed; failures (ok:false) go to the
  // error handler.  Narrowing the state to the ok:true variants keeps the
  // preview reads (uri/width/height/...) type-safe.
  const [preview, setPreview] = useState<
    Extract<CameraCaptureResult, { ok: true }> | null
  >(null);

  // v0.16 — post-capture review surface toggles (dev tools, exposed as
  // on-screen toggles below).  `rectCrop` shows the draggable-quad crop
  // editor; `showPreview` shows a plain image preview with Retake/Confirm;
  // both off → onCapture fires immediately with no review screen.
  // NOTE: showPreview defaults ON here (the SDK prop default is still OFF) so
  // the post-capture preview mounts — that's where the rRadians readout and the
  // 3-tab Spherical/Plane/High-level projection comparison live.  Flip it off
  // via the on-screen toggle for the immediate-onCapture flow.
  const [rectCrop, setRectCrop] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  // panMode flag (guidance item 1).  'vertical' (default) = landscape-only
  // (top→bottom): a portrait hold shows the rotate-to-landscape prompt.
  // 'horizontal' = portrait-only (left→right): a landscape hold shows the
  // rotate-to-portrait prompt.  'both' = either, no prompt.  Toggle cycles
  // all three to verify the gates on-device.
  const [panMode, setPanMode] = useState<PanMode>('vertical');

  // v0.13.0 — controlled flash state demo.  The host owns the
  // `'on' | 'off'` value; the built-in flash button drives the
  // `onFlashChange` callback and we mirror it back via the
  // controlled `flash` prop.  AR mode auto-disables the button
  // (greyed + a11y "Flash unavailable in AR mode"); no host work
  // required for that.
  const [flash, setFlash] = useState<'on' | 'off'>('off');

  // v0.13.0 — capture-history thumbnails.  Appended on every
  // successful onCapture; rendered by `<Camera>`'s built-in
  // `CaptureThumbnailStrip` between the preview and the bottom
  // bar (hidden during recording so it doesn't overlap the band).
  // Tapping a thumbnail opens the SDK's built-in CapturePreview
  // modal (via the strip's internal handler — we don't wire
  // `onThumbnailPress` here).
  const [thumbnails, setThumbnails] = useState<CaptureThumbnailItem[]>([]);

  // v0.7.0 — demonstrate `useKeyframeStream` end-to-end.  This
  // example app's role is to show ALL the lib's public hooks
  // wired into a minimal host; we log accepted keyframes (one per
  // accepted frame, typically 4-6 per panorama) so a developer
  // cloning the repo can see the payload shape in the logs.
  //
  // No visible UI for the events — that's deliberately the host's
  // job to design.  See the hook's docstring at
  // `src/stitching/useKeyframeStream.ts` for the AcceptedKeyframe
  // contract + an OCR-plugin example.
  // v0.10.0 — also collect each keyframe path into a ref so the
  // Re-refine button below can pass them straight to
  // `module.refinePanorama(...)`.  Cleared whenever a new panorama
  // capture starts (onCaptureSourceChange to panorama mode) or when
  // the preview is dismissed (effectively a fresh session).
  const collectedKeyframesRef = useRef<string[]>([]);
  useKeyframeStream(
    useCallback((kf: AcceptedKeyframe) => {
      collectedKeyframesRef.current.push(kf.jpegPath);
      // eslint-disable-next-line no-console
      console.log('[example] useKeyframeStream', {
        index: kf.index,
        jpegPath: kf.jpegPath,
        rotation: kf.pose.rotation,
        translation: kf.pose.translation,
        timestamp: kf.timestamp,
        cumulative: collectedKeyframesRef.current.length,
      });
    }, []),
  );

  // v0.8.0 + v0.11.0 — demonstrate `useFrameProcessor` end-to-end
  // in BOTH capture modes.  The worklet fires:
  //
  //   - **AR mode**: on every AR frame at the camera's native rate
  //     (30–60 fps).  Auto-registered into the native
  //     `__stitcherProxy` registry on mount; the AR-session
  //     dispatch path fans out to it alongside the lib's
  //     first-party stitching.  Per-worklet failure isolation — a
  //     throw here won't break stitching.
  //   - **Non-AR mode** (v0.11.0 composition): we use
  //     `useStitcherWorklet` to get the lib's first-party
  //     stitching as a callable worklet, then call it INSIDE the
  //     host worklet body so both stitching AND the host tick log
  //     fire per frame.  Before v0.11.0 this was an either-or
  //     (vc's `<Camera>` accepts one processor; supplying ours
  //     displaced the lib's).
  //
  // The runOnJS callback is rate-limited to ~1 Hz so the example
  // app's logs stay readable; per the worklet-throttle note
  // (`feedback_worklet_throttle.md`), throttling is JS-side because
  // vc v4 `frame.timestamp` semantics aren't reliably nanoseconds.
  const lastFpLogRef = useRef(0);
  const cumulativeFpCountsRef = useRef<{ ar: number; vc: number }>({ ar: 0, vc: 0 });
  const fireFrameProcessorLog = useMemo(
    () =>
      Worklets.createRunOnJS((timestamp: number, source: string) => {
        const counts = cumulativeFpCountsRef.current;
        if (source === 'ar') counts.ar++;
        else counts.vc++;
        const now = Date.now();
        if (now - lastFpLogRef.current >= 1000) {
          lastFpLogRef.current = now;
          // eslint-disable-next-line no-console
          console.log(
            `[example] useFrameProcessor tick — source=${source} ` +
              `ts=${timestamp} cumulative: ar=${counts.ar} vc=${counts.vc}`,
          );
        }
      }),
    [],
  );
  // v0.11.0 — compose first-party stitching with the example tick
  // log.  `stitcher.call(frame)` runs the lib's throttle + pose
  // synthesis + native plugin call (i.e. exactly what
  // `useFrameProcessorDriver`'s built-in processor does); we add
  // the host tick log alongside it.  Both fire per frame in
  // non-AR mode; in AR mode the auto-registration via
  // `__stitcherProxy` is what fires the worklet (the
  // `frameProcessor` prop has no effect on AR mode because vc's
  // `<Camera>` isn't mounted in that path).
  // AR depth/anchors readout — proves `arDepth` / `arAnchors` are actually
  // populated (not undefined).  Called ~1/sec from the AR worklet (the read
  // is throttled there because reading `arDepth` allocates a depth buffer;
  // real consumers should likewise read it only when needed).
  const fireArMetaLog = useMemo(
    () =>
      Worklets.createRunOnJS(
        (depthW: number, depthH: number, hasConf: number, anchors: number) => {
          // eslint-disable-next-line no-console
          console.log(
            `[example] arFrame meta — arDepth=${depthW}x${depthH} ` +
              `confidenceMap=${hasConf ? 'yes' : 'no'} arAnchors=${anchors}`,
          );
        },
      ),
    [],
  );

  const stitcher = useStitcherWorklet();
  const exampleFrameProcessor = useFrameProcessor(
    (frame: Frame) => {
      'worklet';
      // First-party stitching (v0.11.0 composition).  `stitcher.call`
      // takes a raw vision-camera `Frame` directly (its input type is
      // `Frame | CameraFrame`) and no-ops on AR-source frames because
      // AR stitching runs natively via the AR-side dispatcher, not the
      // vc plugin.  See the `useStitcherWorklet` module header.
      stitcher.call(frame);
      // Example app's tick log.  This processor only fires for vc-source
      // frames (vc's `<Camera>` isn't mounted in AR mode), so the source
      // is always 'vc'.
      fireFrameProcessorLog(frame.timestamp ?? 0, 'vc');
    },
    [stitcher.call, fireFrameProcessorLog],
  );

  // AR-mode host worklet (the `arFrameProcessor` prop).  Unlike
  // `frameProcessor` above (vision-camera, non-AR only), this fires once
  // per ARKit / ARCore frame while in AR capture, dispatched natively via
  // `__stitcherProxy` ALONGSIDE first-party stitching.  Here it just feeds
  // the SAME tick log with source `'ar'`, so the per-second log line's
  // `cumulative: ar=N` climbing is direct proof the AR fan-out is live.
  // Must be a `'worklet'`; kept stable via useMemo so it isn't
  // re-registered on every render.
  const demoArFrameProcessor = useMemo(() => {
    const fp = (frame: CameraFrame) => {
      'worklet';
      fireFrameProcessorLog(frame.timestamp ?? 0, frame.source ?? 'ar');
      // Read arDepth/arAnchors ~once/sec (a worklet-runtime-global tick
      // counter), since accessing `arDepth` allocates a depth buffer —
      // don't do it every frame.
      const g = globalThis as { __exArMetaTick?: number };
      g.__exArMetaTick = ((g.__exArMetaTick ?? 0) + 1) % 60;
      if (g.__exArMetaTick === 0 && frame.source === 'ar') {
        const d = frame.arDepth;
        const anchors = frame.arAnchors;
        fireArMetaLog(
          d ? d.width : 0,
          d ? d.height : 0,
          d && d.confidenceMap ? 1 : 0,
          anchors ? anchors.length : 0,
        );
      }
    };
    return fp;
  }, [fireFrameProcessorLog, fireArMetaLog]);

  // v0.10.0 (PR B) — visible pill that surfaces refinePanorama
  // progress events.  Subscribes to the IncrementalStateUpdate
  // channel; renders only when `refineStage` is present.  Auto-
  // dismisses 3 s after `done` / `error` so the next refine cycle
  // gets a clean slate.  Useful for verifying the v0.10.0 #15A
  // wiring end-to-end without grepping metro logs.
  const [refine, setRefine] = useState<{
    stage: NonNullable<IncrementalState['refineStage']>;
    progress: number;
    frames?: number;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const sub = subscribeIncrementalState((s) => {
      // eslint-disable-next-line no-console
      console.log('[example] state event', {
        refineStage: s.refineStage,
        refineProgress: s.refineProgress,
        refineFrames: s.refineFrames,
        refineError: s.refineError,
        outcome: s.outcome,
        isRefining: s.isRefining,
      });
      if (s.refineStage === undefined) return;
      setRefine({
        stage: s.refineStage,
        progress: s.refineProgress ?? 0,
        frames: s.refineFrames,
        error: s.refineError,
      });
    });
    return () => {
      sub?.remove();
    };
  }, []);
  useEffect(() => {
    if (refine === null) return;
    if (refine.stage !== 'done' && refine.stage !== 'error') return;
    const id = setTimeout(() => setRefine(null), 3000);
    return () => clearTimeout(id);
  }, [refine]);

  const handleCapture = (result: CameraCaptureResult): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onCapture', result);
    // v0.16 — onCapture now fires on failure too (ok:false), mirroring
    // onError.  The error handler already surfaces it, so just bail here.
    if (!result.ok) return;
    if (result.warnings.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[example] capture warnings',
        result.warnings.map((w) => `${w.code}: ${w.message}`),
      );
    }
    // Panoramas are reviewed IN the SDK's crop/preview surface (rectCrop or
    // showPreview) — that screen IS the preview, so don't pop a second
    // preview modal for them.  Photos (no review step) still get the modal.
    if (result.type === 'photo') setPreview(result);
    // Dedup by uri — a capture-history strip should never show the same
    // capture twice, and a duplicate `id` (uri) throws React's "two children
    // with the same key".  Robust against any double onCapture delivery.
    setThumbnails((prev) =>
      prev.some((t) => t.id === result.uri)
        ? prev
        : [
            ...prev,
            {
              id: result.uri,
              uri: result.uri,
              width: result.width,
              height: result.height,
            },
          ],
    );
  };

  const handleReRefine = useCallback(async () => {
    const native = getIncrementalNativeModule();
    if (!native?.refinePanorama || preview?.type !== 'panorama') return;
    const framePaths = [...collectedKeyframesRef.current];
    if (framePaths.length < 2) return;
    const outputPath = preview.uri.replace(/\.jpe?g$/i, '-refined.jpg')
      .replace(/^file:\/\//, '');
    try {
      const r = await native.refinePanorama({
        framePaths,
        outputPath,
        config: { warperType: 'spherical', blenderType: 'multiband',
                  seamFinderType: 'graphcut', jpegQuality: 90 },
      });
      // eslint-disable-next-line no-console
      console.log('[example] refinePanorama OK', r);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[example] refinePanorama FAILED', err);
    }
  }, [preview]);

  const handleCaptureSourceChange = (source: CaptureSource): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onCaptureSourceChange', source);
  };

  const handleLensChange = (lens: CameraLens): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onLensChange', lens);
  };

  const handleFramesDropped = (info: FramesDroppedInfo): void => {
    const missing = info.requested - info.included;
    // The low-frame-utilization warning is now surfaced on the crop editor
    // (and in onCapture.warnings), so we no longer pop a separate toast for
    // it — just log here.
    // eslint-disable-next-line no-console
    console.warn(
      '[example] onFramesDropped',
      `${info.included}/${info.requested} (missing ${missing})`,
    );
  };

  const handleError = (err: CameraError): void => {
    const guidance = userFacingStitchError(err.code);
    if (guidance) {
      // eslint-disable-next-line no-console
      console.warn('[example] onError (recoverable)', err.code, err.message);
      Alert.alert(guidance.title, guidance.message);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[example] onError', err.code, err.message);
    Alert.alert(`Camera error (${err.code})`, err.message);
  };

  const capturePreviewPayload = useMemo(() => {
    if (preview === null) return undefined;
    return {
      imageUri: preview.uri,
      imageWidth: preview.width,
      imageHeight: preview.height,
      title:
        preview.type === 'photo'
          ? `Photo · ${preview.width}×${preview.height}`
          : `Panorama · ${preview.framesIncluded}/${preview.framesRequested} frames`
            + (preview.stitchModeResolved
              ? ` · ${preview.stitchModeResolved}`
              : ''),
    };
  }, [preview]);

  const closePreview = useCallback(() => {
    collectedKeyframesRef.current = [];
    setPreview(null);
  }, []);

  const capturePreviewActions = useMemo<CapturePreviewAction[] | undefined>(() => {
    if (preview === null) return undefined;
    const actions: CapturePreviewAction[] = [];
    if (
      preview.type === 'panorama'
      && collectedKeyframesRef.current.length >= 2
    ) {
      actions.push({
        label: `Re-refine (${collectedKeyframesRef.current.length} keyframes)`,
        variant: 'neutral',
        onPress: () => {
          void handleReRefine();
        },
      });
    }
    actions.push({
      label: 'Close',
      variant: 'primary',
      onPress: closePreview,
    });
    return actions;
  }, [preview, closePreview, handleReRefine]);

  if (!hasPermission) {
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.safe, styles.permissionOverlay]}>
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionBody}>
            This example uses the camera to demonstrate panorama
            capture.  Tap below to grant access — or open Settings if
            the prompt doesn&apos;t appear.
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.permissionButton,
              pressed && styles.permissionButtonPressed,
            ]}
            onPress={() => {
              requestPermission().catch(() => undefined);
            }}
            accessibilityRole="button"
            accessibilityLabel="Grant camera access"
          >
            <Text style={styles.permissionButtonLabel}>Grant Access</Text>
          </Pressable>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safe}>
        <Camera
          defaultLens="1x"
          enablePhotoMode
          enablePanoramaMode
          panMode={panMode}
          rectCrop={rectCrop}
          showPreview={showPreview}
          // Time-budget force-accept ON at 1 s (the SDK default) — a keyframe is
          // accepted every second even if the 15 % novelty gate hasn't tripped,
          // so slow/static pans don't leave gaps.  (Was previously disabled to
          // test novelty in isolation.)  Adjust via the ⚙️ Keyframe interval.
          defaultMaxKeyframeIntervalMs={1500}
          showSettingsButton={__DEV__}
          headerTitle="Image Stitcher Demo"
          headerGuidance="Tap shutter for a photo. Hold + pan + release for a panorama."
          flash={flash}
          onFlashChange={setFlash}
          thumbnails={thumbnails}
          capturePreview={capturePreviewPayload}
          capturePreviewActions={capturePreviewActions}
          onCapturePreviewClose={closePreview}
          frameProcessor={exampleFrameProcessor}
          arFrameProcessor={demoArFrameProcessor}
          onCapture={handleCapture}
          onCaptureSourceChange={handleCaptureSourceChange}
          onLensChange={handleLensChange}
          onFramesDropped={handleFramesDropped}
          onError={handleError}
        />

        {refine !== null && (
          <View
            style={[
              styles.refinePill,
              refine.stage === 'error' && styles.refinePillError,
              refine.stage === 'done' && styles.refinePillDone,
            ]}
            pointerEvents="none"
            accessibilityRole="text"
            accessibilityLabel={`Refine ${refine.stage} ${Math.round(refine.progress * 100)} percent`}
          >
            <Text style={styles.refinePillLabel}>
              {refine.stage === 'error'
                ? `Refine error: ${refine.error ?? 'unknown'}`
                : `Refine: ${refine.stage}${
                    refine.frames !== undefined ? ` (${refine.frames} frames)` : ''
                  }  •  ${Math.round(refine.progress * 100)}%`}
            </Text>
          </View>
        )}

        {__DEV__ && (
          <>
            <Pressable
              style={[styles.devToggle, { top: 110 }]}
              onPress={() =>
                setPanMode((m) =>
                  m === 'vertical' ? 'horizontal' : m === 'horizontal' ? 'both' : 'vertical',
                )
              }
              accessibilityRole="button"
            >
              <Text style={styles.devToggleText}>
                🧭 panMode: {panMode === 'vertical'
                  ? 'vertical (landscape)'
                  : panMode === 'horizontal'
                    ? 'horizontal (portrait)'
                    : 'both'}
              </Text>
            </Pressable>

            {/* v0.16 — review-surface toggles. rectCrop wins over showPreview;
                both off → onCapture fires immediately (no review screen). */}
            <Pressable
              style={[styles.devToggle, { top: 150 }]}
              onPress={() => setRectCrop((v) => !v)}
              accessibilityRole="button"
            >
              <Text style={styles.devToggleText}>
                ✂️ rectCrop: {rectCrop ? 'ON' : 'OFF'}
              </Text>
            </Pressable>

            <Pressable
              style={[styles.devToggle, { top: 190 }]}
              onPress={() => setShowPreview((v) => !v)}
              accessibilityRole="button"
            >
              <Text style={styles.devToggleText}>
                🖼️ showPreview: {showPreview ? 'ON' : 'OFF'}
                {rectCrop ? ' (overridden by rectCrop)' : ''}
              </Text>
            </Pressable>
          </>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}


const styles = StyleSheet.create({
  // Shared dev toggle chip (top-left stack); `top` set per-instance.
  devToggle: {
    position: 'absolute',
    left: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  devToggleText: {
    color: '#00E5FF',
    fontSize: 13,
    fontWeight: '600',
  },
  safe: {
    flex: 1,
    backgroundColor: '#000',
  },
  permissionOverlay: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  permissionTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 12,
  },
  permissionBody: {
    color: '#bbb',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
  },
  permissionButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  permissionButtonPressed: {
    backgroundColor: '#ddd',
  },
  permissionButtonLabel: {
    color: '#000',
    fontSize: 17,
    fontWeight: '600',
  },
  refinePill: {
    position: 'absolute',
    top: 56,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 122, 255, 0.92)',
  },
  refinePillDone: {
    backgroundColor: 'rgba(52, 199, 89, 0.92)',
  },
  refinePillError: {
    backgroundColor: 'rgba(255, 59, 48, 0.92)',
  },
  refinePillLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});


export default App;
