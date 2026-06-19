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
  Platform,
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
  type AROverlay,
  type CameraCaptureResult,
  type CameraError,
  type CameraHandle,
  type CaptureSource,
  type CameraLens,
  type CaptureThumbnailItem,
  type CapturePreviewAction,
  type FramesDroppedInfo,
  type IncrementalState,
  type PanMode,
  type CameraFrame,
  type ARFrameMeta,
  type ARPluginResult,
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
  // v0.18.0 — AR depth/anchor/mesh/intrinsics readout, driven by the
  // worklet-FREE `onArFrame` callback (see `handleArFrame` below).
  //
  // Previously this rode a worklets-core SHARED VALUE written from inside
  // the AR worklet: capturing a `createRunOnJS` callback in an AR worklet
  // makes worklets-core's closure-wrap recurse without termination →
  // SIGBUS the instant AR mode mounts, so a shared value (a host object the
  // wrapper references rather than deep-copies) was the only safe channel.
  // `onArFrame` removes that hazard entirely: native builds the metadata
  // and emits a device event, and the handler runs on the JS MAIN thread
  // with a plain `setState`.  THIS is the pattern AR-metadata consumers
  // should use — no worklet, no shared value, no polling.
  const [arMetaText, setArMetaText] = useState('AR: (idle)');

  // v0.19.0 — AR PLUGIN FRAMEWORK readout.  The example registers a tiny
  // native `FrameBrightnessPlugin` (iOS RNISARPluginRegistry / Android
  // RNSARPluginRegistry, wired in AppDelegate / MainApplication) that
  // computes the mean luma of each AR frame and returns `{ brightness: 0..1 }`
  // SYNCHRONOUSLY — so its result rides the throttled `onArFrame` event on
  // `meta.plugins.brightness` (read in `handleArFrame`).  This proves the
  // generic plugin framework end-to-end without shipping any OCR (OCR is
  // private to RetaiLens, written against this same framework).
  const [pluginText, setPluginText] = useState('plugins: (none)');

  // v0.20.0 — AR OVERLAY renderer demo.  We drive a single overlay imperatively
  // through the `<Camera>` ref so it tracks a detected plane WITHOUT a React
  // re-render per frame.  When `onArFrame` reports a plane anchor we derive its
  // world position from the anchor→world transform (translation = elements
  // [12],[13],[14] of the row-major 4×4) and pin an outline marker there; the
  // native overlay layer reprojects it to screen every AR frame so it stays
  // glued to the plane as the camera moves.  A small text readout mirrors the
  // overlay state so it's verifiable even before pointing at a plane.
  const cameraRef = useRef<CameraHandle | null>(null);
  const overlayPinnedRef = useRef(false);
  const [overlayText, setOverlayText] = useState('overlay: (no plane yet)');

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

  // NOTE: this example intentionally does NOT pass an `arFrameProcessor`.
  // All AR data reaches JS through the worklet-free `onArFrame` callback
  // (see `handleArFrame` below), which is the recommended path.  Mounting
  // an `arFrameProcessor` (even a no-op) turns on the heavy worklet
  // extraction path; with `enableMesh` that path marshals the LiDAR
  // ARMeshAnchor each frame and currently faults on mesh warmup — onArFrame
  // avoids it entirely (it reports mesh as light counts, no buffer copy).

  // v0.18.0 — the worklet-free AR metadata handler.  Runs on the JS MAIN
  // thread (NOT a worklet), so capturing `setArMetaText` is perfectly safe.
  // Formats the light `ARFrameMeta` (pose / tracking / intrinsics / depth
  // dims / anchor + mesh counts) into the green on-screen readout.
  const arFrameCountRef = useRef(0);
  const handleArFrame = useCallback((m: ARFrameMeta) => {
    arFrameCountRef.current += 1;
    let vPlanes = 0;
    let hPlanes = 0;
    for (const a of m.anchors) {
      if (a.type === 'plane') {
        if (a.alignment === 'vertical') vPlanes += 1;
        else if (a.alignment === 'horizontal') hPlanes += 1;
      }
    }
    const depthStr = m.depth
      ? `${m.depth.width}x${m.depth.height}${m.depth.hasConfidence ? '+conf' : ''}`
      : 'none';
    const intrStr = m.intrinsics
      ? `fx${Math.round(m.intrinsics.fx)} ${m.intrinsics.imageWidth}x${m.intrinsics.imageHeight}`
      : 'none';
    const meshStr = m.mesh
      ? `${m.mesh.anchorCount}/${m.mesh.vertexCount}v/${m.mesh.faceCount}f`
      : 'none';
    setArMetaText(
      `AR#${arFrameCountRef.current} track=${m.trackingState} ` +
        `depth=${depthStr} anchors=${m.anchors.length} ` +
        `planes[v:${vPlanes} h:${hPlanes}] mesh=${meshStr} ` +
        `intr=${intrStr}`,
    );

    // v0.20.0 — pin a demo overlay to the FIRST detected plane anchor.  The
    // anchor's `transform` is a row-major 4×4 anchor→world matrix; its
    // translation (the anchor's world origin) lives at indices [12],[13],[14].
    // We update the overlay's world position every frame the anchor is visible
    // so it tracks if the plane re-centres; the native layer handles the
    // per-frame screen reprojection.  Imperative (via the ref) so there's no
    // React re-render on the AR frame cadence.
    const plane = m.anchors.find((a) => a.type === 'plane');
    if (plane && plane.transform.length >= 16) {
      const worldPosition: [number, number, number] = [
        plane.transform[12],
        plane.transform[13],
        plane.transform[14],
      ];
      const overlay: AROverlay = {
        id: 'demo',
        worldPosition,
        sizeMeters: [0.2, 0.2],
        shape: 'outline',
        label: 'AR',
        color: '#00E5FF',
      };
      // setOverlays replaces the whole JS-set; with one overlay that's the same
      // as add/update but keeps the demo trivially simple.
      cameraRef.current?.setOverlays([overlay]);
      overlayPinnedRef.current = true;
      setOverlayText(
        `overlay: demo @ [${worldPosition
          .map((v) => v.toFixed(2))
          .join(', ')}]`,
      );
    } else if (overlayPinnedRef.current && m.anchors.length === 0) {
      // No anchors tracked anymore — clear so the overlay doesn't linger at a
      // stale world point.
      cameraRef.current?.clearOverlays();
      overlayPinnedRef.current = false;
      setOverlayText('overlay: (cleared — no plane)');
    }

    // v0.19.0 — surface the sample plugin's SYNC result.  The native
    // FrameBrightnessPlugin (name() === 'frameBrightness') returns
    // `{ brightness: 0..1 }` each frame; the SDK folds it into `meta.plugins`
    // KEYED BY PLUGIN NAME, so the result lives at
    // `meta.plugins.frameBrightness.brightness`.  Values are typed `unknown`
    // (each plugin defines its own shape), so narrow per-key.
    const frameBrightness = m.plugins?.frameBrightness as
      | { brightness?: number }
      | undefined;
    const brightness =
      typeof frameBrightness?.brightness === 'number'
        ? frameBrightness.brightness
        : undefined;
    if (brightness !== undefined) {
      // 12-cell bar so the live luma is readable at a glance on-device.
      const cells = Math.max(0, Math.min(12, Math.round(brightness * 12)));
      const bar = '█'.repeat(cells) + '░'.repeat(12 - cells);
      setPluginText(
        `plugins: brightness=${brightness.toFixed(2)} ${bar}`,
      );
    } else if (m.plugins == null) {
      // Registry empty (no native plugin registered on this build) — keep the
      // idle copy so the overlay still proves the field is plumbed.
      setPluginText('plugins: (none)');
    }
  }, []);

  // v0.19.0 — the ASYNC plugin-result channel.  Fires when a registered
  // plugin offloads heavy work and later calls `registry.emit(name, result)`
  // (worklet-free, JS MAIN thread).  The sample FrameBrightnessPlugin reports
  // SYNCHRONOUSLY (via `meta.plugins` above), so this handler is wired purely
  // to verify the out-of-band channel — and so a host with an async plugin
  // (e.g. RetaiLens's OCR) has a worked example to copy.
  const handleArPluginResult = useCallback((e: ARPluginResult) => {
    setPluginText(`plugin[${e.plugin}]: ${JSON.stringify(e.result)}`);
  }, []);

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
          ref={cameraRef}
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
          onArFrame={handleArFrame}
          onArPluginResult={handleArPluginResult}
          enableDepth
          enableAnchors
          planeDetection="both"
          onCapture={handleCapture}
          onCaptureSourceChange={handleCaptureSourceChange}
          onLensChange={handleLensChange}
          onFramesDropped={handleFramesDropped}
          onError={handleError}
        />

        {/* Always rendered (not __DEV__-gated) so it's visible in the
            Release build used to verify AR metadata without the Debug
            inspector's Hermes allocation tracker. */}
        <View style={styles.arMetaOverlay} pointerEvents="none">
          <Text style={styles.arMetaText} numberOfLines={3}>
            {arMetaText}
          </Text>
          {/* v0.19.0 — AR plugin framework readout (sample FrameBrightnessPlugin). */}
          <Text style={styles.arPluginText} numberOfLines={1}>
            {pluginText}
          </Text>
          {/* v0.20.0 — AR overlay renderer readout (demo plane-pinned marker). */}
          <Text style={styles.arOverlayText} numberOfLines={1}>
            {overlayText}
          </Text>
        </View>

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
  // AR metadata readout — fed from the worklet-free `onArFrame` callback
  // (see `handleArFrame`).  Bottom strip so it doesn't collide with the
  // top-left dev toggles or the guidance banner.
  arMetaOverlay: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 96,
    backgroundColor: 'rgba(0, 0, 0, 0.62)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  arMetaText: {
    color: '#7CFC9A',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // v0.19.0 — AR plugin framework readout, distinct amber tint so the plugin
  // result is visually separable from the green AR-metadata line above.
  arPluginText: {
    color: '#FFD34D',
    fontSize: 11,
    marginTop: 3,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // v0.20.0 — AR overlay renderer readout, cyan to match the demo overlay's
  // colour (#00E5FF) so the on-screen text and the drawn marker read as a set.
  arOverlayText: {
    color: '#00E5FF',
    fontSize: 11,
    marginTop: 3,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
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
