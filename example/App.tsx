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
  useStitcherWorklet,
  type AcceptedKeyframe,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type CaptureThumbnailItem,
  type CapturePreviewAction,
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
  const stitcher = useStitcherWorklet();
  const exampleFrameProcessor = useFrameProcessor(
    (frame: StitcherFrame) => {
      'worklet';
      // First-party stitching (v0.11.0 composition).  Safe to call
      // in BOTH modes — the hook internally no-ops on AR-source
      // frames (v0.11.1 fix) because AR stitching runs natively
      // via the AR-side dispatcher, not via the vc plugin.  See
      // `useStitcherWorklet` module header.
      stitcher.call(frame);
      // Example app's tick log.  `source`/`pose` may be undefined
      // for vc-source frames (Phase 4a cross-boundary wrapping
      // deferral); guard for that.
      fireFrameProcessorLog(frame.timestamp ?? 0, frame.source ?? 'vc');
    },
    [stitcher.call, fireFrameProcessorLog],
  );

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
    // v0.13.0 — append to the host-owned thumbnails list so the
    // built-in CaptureThumbnailStrip shows the capture history.
    // The SDK's strip is purely presentational — it never mutates
    // the array; the host is the canonical source.  Using
    // `result.uri` as the id is fine here because URIs are
    // unique per capture (timestamped filenames); a real consumer
    // would use a DB primary key.
    setThumbnails((prev) => [
      ...prev,
      {
        id: result.uri,
        uri: result.uri,
        width: result.width,
        height: result.height,
      },
    ]);
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

  // v0.13.0 — derive the built-in CapturePreview's payload from
  // `preview`.  Single source of truth: `preview` is set in
  // `onCapture` and cleared via `closePreview`; the SDK's modal
  // tracks visibility off whether `capturePreview` is defined.
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
    // v0.10.0 — reset keyframe collection on close so the next
    // capture starts clean.
    collectedKeyframesRef.current = [];
    setPreview(null);
  }, []);

  // v0.13.0 — capture-preview action buttons.  Always include
  // Close; conditionally include Re-refine when we have a panorama
  // with enough collected keyframes to drive `refinePanorama(...)`.
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
          // Fire-and-forget — keep the modal open while the refine
          // runs.  The outer floating refinePill will show progress
          // (the in-modal pill from the pre-v0.13 hand-rolled Modal
          // is gone; the SDK's CapturePreview doesn't accept
          // arbitrary children).
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
    // Re-evaluate when preview type/uri changes; the keyframe ref
    // is read at action-press time, so we don't need it in deps.
  }, [preview, closePreview, handleReRefine]);

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
          // Internal-tester mode: gear icon opens PanoramaSettingsModal.
          // With `headerTitle` set below, the gear is absorbed into
          // the built-in CaptureHeader's right slot (no duplicate gear).
          // Defaults to false for public consumers; flip on for development.
          showSettingsButton={__DEV__}
          // v0.13.0 — built-in CaptureHeader (opt-in: only when
          // `headerTitle` is set).  Renders a top-of-screen header
          // with title + guidance subtitle + absorbed settings gear.
          headerTitle="Image Stitcher Demo"
          headerGuidance="Tap shutter for a photo. Hold + pan + release for a panorama."
          // v0.13.0 — controlled flash demo.  Uncontrolled mode (omit
          // `flash`) lets <Camera> own the state; we wire it up here
          // both to exercise the controlled path and so a future
          // host-driven flash chrome (gestures, voice, hardware key)
          // can flip the same source of truth.  AR mode auto-disables
          // the built-in button — no host work required.
          flash={flash}
          onFlashChange={setFlash}
          // v0.13.0 — built-in capture-history strip.  Host owns the
          // array; the strip is purely presentational and shows each
          // capture's aspect-ratio thumbnail.  We deliberately do NOT
          // pass `thumbnailsMin` / `thumbnailsMax` here — the count
          // line they trigger ("N / min · max") is an audit-app UX
          // convention, not a generic camera feature, so the example
          // omits it.  The props remain on the SDK for hosts (like
          // RetaiLens) that want quota-style guidance.
          thumbnails={thumbnails}
          // v0.13.0 — built-in CapturePreview modal (replaces the
          // pre-v0.13 hand-rolled <Modal>).  Driven by the same
          // `preview` state as before via `capturePreviewPayload`.
          // Action buttons include Re-refine (when a panorama with
          // collected keyframes) and Close.
          capturePreview={capturePreviewPayload}
          capturePreviewActions={capturePreviewActions}
          onCapturePreviewClose={closePreview}
          // v0.11.0 — composed processor: lib's first-party stitching
          // via `stitcher.call(frame)` + example tick log per frame.
          // No-op in AR mode (vc's `<Camera>` isn't mounted in that
          // path; AR worklets fire via `__stitcherProxy` auto-
          // registration).
          frameProcessor={exampleFrameProcessor}
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
          v0.13.0 — the pre-v0.13 hand-rolled <Modal>...</Modal> block
          that lived here has been replaced by `<Camera>`'s built-in
          `CapturePreview` (wired via the `capturePreview` /
          `capturePreviewActions` / `onCapturePreviewClose` props
          above).  Same UX: fullscreen preview, dimensions in the
          title, Re-refine button for panorama with collected
          keyframes, Close to dismiss.  Drives off the same `preview`
          state so the example's existing onCapture / closePreview
          flow continues to work.

          The refinePill rendered above (outside the modal) still
          shows progress when Re-refine fires — the modal sits on
          top of the camera but the pill is rendered as part of the
          outer screen, so RN's pre-v0.12 caveat about Modal stealing
          focus from sibling elements doesn't apply to the toast-
          shaped pill behind it (the user sees it in the gap between
          the modal close and the next capture start).
        */}
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
  // v0.13.0 — removed `previewSafe`, `previewMeta`, `previewTitle`,
  // `previewSub`, `previewImage`, `previewCloseButton(Pressed)?`,
  // `previewCloseLabel`, `previewRefineButton(Pressed)?`,
  // `previewRefineLabel`, and `refinePillModal` along with the
  // hand-rolled <Modal> they styled.  The SDK's built-in
  // `CapturePreview` modal (wired via the `capturePreview` /
  // `capturePreviewActions` props on `<Camera>`) replaces this UI
  // entirely.
  refinePill: {
    position: 'absolute',
    top: 56,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0, 122, 255, 0.92)',  // iOS systemBlue
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
