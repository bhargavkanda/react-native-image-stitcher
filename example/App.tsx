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
 *
 * The component is the only thing exported by the library that you
 * actually need to render — everything else (preview, shutter, lens
 * chip, AR toggle, settings modal) is owned by `<Camera>`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
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
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import {
  Camera,
  getIncrementalNativeModule,
  subscribeIncrementalState,
  useFrameProcessor,
  useKeyframeStream,
  type AcceptedKeyframe,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type FramesDroppedInfo,
  type IncrementalState,
  type StitcherFrame,
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
  const [preview, setPreview] = useState<CameraCaptureResult | null>(null);

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

  // v0.8.0 — demonstrate `useFrameProcessor` end-to-end.  The
  // worklet fires:
  //
  //   - **AR mode**: on every AR frame at the camera's native rate
  //     (30–60 fps depending on device).  Auto-registered into the
  //     native `__stitcherProxy` registry on mount; the AR-session
  //     dispatch path fans out to it alongside the lib's first-party
  //     stitching.  Per-worklet failure isolation — a throw here
  //     won't break stitching.
  //   - **Non-AR mode**: hostile — vc's `<Camera>` accepts ONE
  //     processor; passing this hook's return through
  //     `<Camera frameProcessor={...}>` would displace the lib's
  //     internal stitching driver.  THIS DEMO does NOT wire it
  //     through (the panorama capture demo above takes priority).
  //     Hosts that want a worklet on non-AR mode pay the tradeoff
  //     explicitly (see CameraProps.frameProcessor docstring).
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _exampleFrameProcessor = useFrameProcessor(
    (frame: StitcherFrame) => {
      'worklet';
      // Non-AR mode: vc's Frame doesn't set `source`/`pose` (Phase
      // 4a cross-boundary wrapping deferral).  Guard for undefined
      // per the hook's docstring.
      fireFrameProcessorLog(frame.timestamp ?? 0, frame.source ?? 'vc');
    },
    [fireFrameProcessorLog],
  );
  // Note: `_exampleFrameProcessor` is intentionally unused — we
  // don't pass it to `<Camera frameProcessor={...}>` because
  // doing so would disable the lib's first-party stitching in
  // non-AR mode (see comment above).  In AR mode the hook's
  // auto-registration via `__stitcherProxy` is what fires the
  // worklet; the returned processor object is only relevant for
  // non-AR mode wiring (which this demo skips).

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
      // v0.10.0 PR B diag: log EVERY state event with the refine
      // field shape so we can see iOS vs Android delivery.  Temporary
      // — remove once the pill is confirmed visible on both platforms.
      // eslint-disable-next-line no-console
      console.log('[example] state event', {
        refineStage: s.refineStage,
        refineProgress: s.refineProgress,
        refineFrames: s.refineFrames,
        refineError: s.refineError,
        // First few base fields too, to confirm the event got through
        // at all:
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

  // v0.9.0 NOTE — `useFrameStream` (Tier 2 Layer 3) is exported by
  // the lib but the example demo was removed because the current
  // implementation has two known limitations that block a clean
  // visual demo:
  //
  //   1. AR mode: Layer 1's `save_frame_as_jpeg` vc plugin doesn't
  //      yet handle `StitcherFrameHostObject` (it expects vc's
  //      Frame with `.buffer = CMSampleBufferRef`).  Worklet body
  //      runs but `plugin.call(frame, ...)` throws silently.
  //      Tracked as v0.9.1 — needs AR-frame buffer-pass-via-args
  //      bridge (vc's `SharedArray` JSI↔native path).
  //
  //   2. Non-AR mode: wiring the host's frameProcessor through
  //      `<Camera>` displaces the lib's first-party stitching
  //      driver (Phase 5 either-or constraint).  Tracked as
  //      v0.11.0 (`useStitcherWorklet` composition).
  //
  // For hosts whose use case fits Layer 2 (worklet-native processing
  // via vc plugins — Vision.framework / ML Kit / TFLite / LiDAR
  // depth), `useThrottledFrameProcessor` works in BOTH modes today
  // without these limitations.  See `docs/frame-access-tiers.md`.

  const handleCapture = (result: CameraCaptureResult): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onCapture', result);
    setPreview(result);
  };

  // v0.10.0 — manually trigger `module.refinePanorama(...)` against
  // the keyframes collected from `useKeyframeStream` during the
  // capture.  Demonstrates the v0.10.0 #15A refineProgress events
  // end-to-end (the auto-refine path from hybrid finalize is a no-op
  // today because the hybrid engine doesn't persist per-frame JPEGs).
  //
  // Only meaningful for the batch-keyframe engine — that's the only
  // mode `useKeyframeStream` populates.  Other engines (hybrid /
  // slit-scan / firstwins) leave `collectedKeyframesRef` empty and
  // the button stays hidden.
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
    // eslint-disable-next-line no-console
    console.warn(
      '[example] onFramesDropped',
      `${info.included}/${info.requested}`,
    );
  };

  const handleError = (err: CameraError): void => {
    // eslint-disable-next-line no-console
    console.error('[example] onError', err.code, err.message);
    Alert.alert(`Camera error (${err.code})`, err.message);
  };

  // Permission gate — show grant overlay until camera access is OK.
  // This is the kind of UX the host app owns; the SDK only renders
  // <Camera> when permission is in hand.
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

  // F8.3 — the SDK's <Camera> now owns the Frame Processor worklet
  // internally via `useFrameProcessorDriver`.  The F8.0.c/F8.1
  // hand-rolled diagnostic worklet that lived here is gone; the
  // SDK's driver supplies real gyro-integrated pose to the plugin
  // and pipes frames straight into the incremental stitcher.

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safe}>
        <Camera
          defaultCaptureSource="ar"
          defaultLens="1x"
          enablePhotoMode
          enablePanoramaMode
          // Internal-tester mode: gear icon at top-right opens
          // PanoramaSettingsModal.  Defaults to false for public
          // consumers; flip on for development.
          showSettingsButton={__DEV__}
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


        {/*
          Capture preview modal.  Renders fullscreen above the camera
          when a capture lands so the user can visually verify the
          result before resuming.  Tapping Close clears the result
          and returns to the camera.
        */}
        <Modal
          visible={preview !== null}
          animationType="fade"
          transparent={false}
          onRequestClose={() => setPreview(null)}
        >
          {preview && (
            <SafeAreaView style={styles.previewSafe}>
              <View style={styles.previewMeta}>
                <Text style={styles.previewTitle}>
                  {preview.type === 'photo' ? 'Photo' : 'Panorama'}
                </Text>
                <Text style={styles.previewSub}>
                  {preview.width}×{preview.height}
                  {preview.type === 'panorama'
                    ? `  •  ${preview.framesIncluded}/${preview.framesRequested} frames  •  ${preview.durationMs} ms${preview.stitchModeResolved ? `  •  ${preview.stitchModeResolved}` : ''}`
                    : ''}
                </Text>
              </View>

              <Image
                source={{ uri: preview.uri }}
                style={styles.previewImage}
                resizeMode="contain"
              />

              {preview.type === 'panorama'
                && collectedKeyframesRef.current.length >= 2 && (
                <Pressable
                  style={({ pressed }) => [
                    styles.previewRefineButton,
                    pressed && styles.previewRefineButtonPressed,
                  ]}
                  onPress={handleReRefine}
                  accessibilityRole="button"
                  accessibilityLabel="Re-refine this panorama"
                >
                  <Text style={styles.previewRefineLabel}>
                    Re-refine ({collectedKeyframesRef.current.length} keyframes)
                  </Text>
                </Pressable>
              )}

              {/*
                Mirror the refine-progress pill INSIDE the modal so
                the user sees the validating → stitching → writing →
                done stages while the preview is visible.  The
                outer-screen instance below also stays (for the
                hybrid auto-refine path when keyframes ARE persisted
                in a future version).
              */}
              {refine !== null && (
                <View
                  style={[
                    styles.refinePillModal,
                    refine.stage === 'error' && styles.refinePillError,
                    refine.stage === 'done' && styles.refinePillDone,
                  ]}
                  pointerEvents="none"
                  accessibilityRole="text"
                >
                  <Text style={styles.refinePillLabel}>
                    {refine.stage === 'error'
                      ? `Refine error: ${refine.error ?? 'unknown'}`
                      : `Refine: ${refine.stage}${
                          refine.frames !== undefined
                            ? ` (${refine.frames} frames)`
                            : ''
                        }  •  ${Math.round(refine.progress * 100)}%`}
                  </Text>
                </View>
              )}

              <Pressable
                style={({ pressed }) => [
                  styles.previewCloseButton,
                  pressed && styles.previewCloseButtonPressed,
                ]}
                onPress={() => {
                  // v0.10.0 — reset keyframe collection on close so
                  // the next capture starts clean.
                  collectedKeyframesRef.current = [];
                  setPreview(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Close preview"
              >
                <Text style={styles.previewCloseLabel}>Close</Text>
              </Pressable>
            </SafeAreaView>
          )}
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}


const styles = StyleSheet.create({
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
  previewSafe: {
    flex: 1,
    backgroundColor: '#000',
  },
  previewMeta: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  previewTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '600',
  },
  previewSub: {
    color: '#bbb',
    fontSize: 13,
    marginTop: 2,
  },
  previewImage: {
    flex: 1,
    width: '100%',
    backgroundColor: '#000',
  },
  previewCloseButton: {
    margin: 16,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  previewCloseButtonPressed: {
    backgroundColor: '#ddd',
  },
  previewCloseLabel: {
    color: '#000',
    fontSize: 17,
    fontWeight: '600',
  },
  previewRefineButton: {
    marginHorizontal: 16,
    marginTop: 16,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#007aff',
    alignItems: 'center',
  },
  previewRefineButtonPressed: {
    backgroundColor: '#0058b3',
  },
  previewRefineLabel: {
    color: '#fff',
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
    backgroundColor: 'rgba(0, 122, 255, 0.92)',  // iOS systemBlue
  },
  refinePillModal: {
    // Same visual treatment as `refinePill` but positioned as a
    // regular block inside the modal so it shows above the preview
    // image without absolute-positioning math against the modal's
    // SafeAreaView.
    alignSelf: 'center',
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 122, 255, 0.92)',
  },
  refinePillDone: {
    backgroundColor: 'rgba(52, 199, 89, 0.92)',  // iOS systemGreen
  },
  refinePillError: {
    backgroundColor: 'rgba(255, 59, 48, 0.92)',  // iOS systemRed
  },
  refinePillLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },

});


export default App;
