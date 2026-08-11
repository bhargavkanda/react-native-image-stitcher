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
 * On-screen dev controls are deliberately minimal: a ⚙️ gear opens a
 * small settings modal (rect-crop / preview / keyframe quality), and a
 * short chip stack exposes panMode + the anti-blur A/B toggles — the
 * knobs you actually flip while testing captures on-device.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Switch,
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
} from 'react-native-image-stitcher';


/** One labelled on/off row inside the dev settings modal. */
function DevSettingRow({
  label,
  help,
  value,
  onValueChange,
}: {
  label: string;
  help?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingRowText}>
        <Text style={styles.settingLabel}>{label}</Text>
        {help ? <Text style={styles.settingHelp}>{help}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} />
    </View>
  );
}


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

  // Example dev-settings modal (⚙️ gear).  Holds the post-capture review
  // surface toggles + keyframe quality — knobs you set once and leave, kept
  // off the camera view so it stays uncluttered.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // v0.16 — post-capture review surface toggles (in the ⚙️ settings modal).
  // `rectCrop` shows the draggable-quad crop editor; `showPreview` shows a
  // plain image preview with Retake/Confirm; both off → onCapture fires
  // immediately with no review screen.  showPreview defaults ON so the
  // post-capture preview (rRadians readout + projection comparison) mounts.
  const [rectCrop, setRectCrop] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  // panMode flag (guidance item 1).  'vertical' (default) = landscape-only
  // (top→bottom): a portrait hold shows the rotate-to-landscape prompt.
  // 'horizontal' = portrait-only (left→right): a landscape hold shows the
  // rotate-to-portrait prompt.  'both' = either, no prompt.  Toggle cycles
  // all three to verify the gates on-device.
  const [panMode, setPanMode] = useState<PanMode>('vertical');
  // Keyframe-resolution QUALITY toggle (v0.22): ON lifts the keyframe
  // long-edge budget (Android 640→1280; iOS is 1280 either way) + floors
  // the picked video format ≥1280.  The capture format is chosen at mount,
  // so we key the <Camera> on this to force a clean re-pick when flipped.
  const [kfQuality, setKfQuality] = useState(true);
  // v0.23 anti-blur — one toggle per change so each can be A/B'd on-device.
  // All default ON (the branch's showcase); flip OFF to compare against
  // today's behaviour. Exposure cap is a capture-FORMAT change, so it's in
  // the <Camera> key (clean re-pick on flip); the other three are read at the
  // start of each capture, so they take effect on the NEXT pano after a flip.
  const [abExposureCap, setAbExposureCap] = useState(true); // 8 ms ↔ off
  const [abMotionGate, setAbMotionGate] = useState(true);   // 1.0 rad/s ↔ off
  const [abSharpFloor, setAbSharpFloor] = useState(true);   // 0.6× median ↔ off
  const [abHighFps, setAbHighFps] = useState(true);         // ≥60 fps AR format

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
          // Re-pick the capture format when the KF-quality toggle OR the
          // anti-blur exposure cap flips (both change which format
          // vision-camera picks).
          key={`cam-kfq-${kfQuality ? 'hi' : 'lo'}-exp${abExposureCap ? 1 : 0}`}
          defaultLens="1x"
          enablePhotoMode
          enablePanoramaMode
          keyframeQualityCapture={kfQuality}
          // v0.23 anti-blur — driven by the four dev toggles below so each
          // change can be A/B'd on-device. A value of 0 / false disables that
          // control (today's behaviour). (Local test enablement — not committed.)
          frameSelection={{
            antiBlur: {
              maxExposureMs: abExposureCap ? 8 : 0,
              maxCommitPanRateRadPerSec: abMotionGate ? 1.0 : 0,
              minScoreFractionOfMedian: abSharpFloor ? 0.6 : 0,
              preferHighFpsFormat: abHighFps,
            },
          }}
          panMode={panMode}
          rectCrop={rectCrop}
          showPreview={showPreview}
          // Time-budget force-accept ON at 1.5 s — a keyframe is accepted on
          // that interval even if the novelty gate hasn't tripped, so slow/
          // static pans don't leave gaps.  Adjust via the ⚙️ Keyframe interval.
          defaultMaxKeyframeIntervalMs={1500}
          showSettingsButton
          headerTitle="Image Stitcher Demo"
          headerGuidance="Tap shutter for a photo. Hold + pan + release for a panorama."
          flash={flash}
          onFlashChange={setFlash}
          thumbnails={thumbnails}
          capturePreview={capturePreviewPayload}
          capturePreviewActions={capturePreviewActions}
          onCapturePreviewClose={closePreview}
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

        {/* Dev controls — rendered UNCONDITIONALLY (this example's "debug"
            APK builds non-debuggable, so __DEV__ is false and a __DEV__ gate
            would hide them).  A ⚙️ gear opens the settings modal; the chips
            below are the pano + anti-blur A/B knobs flipped most on-device. */}
        <Pressable
          style={[styles.devToggle, { top: 110 }]}
          onPress={() => setSettingsOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Open dev settings"
        >
          <Text style={styles.devToggleText}>⚙️ Dev settings</Text>
        </Pressable>

        <Pressable
          style={[styles.devToggle, { top: 150 }]}
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

        {/* v0.23 anti-blur A/B toggles — one per change. Flip OFF, capture a
            pano, flip ON, capture again, and compare the results. Exposure
            cap re-picks the format immediately (camera key); the other three
            apply on the NEXT capture after a flip. */}
        <Pressable
          style={[styles.devToggle, { top: 190 }]}
          onPress={() => setAbExposureCap((v) => !v)}
          accessibilityRole="button"
        >
          <Text style={styles.devToggleText}>
            ⚡ exposure cap: {abExposureCap ? 'ON (8 ms)' : 'OFF'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.devToggle, { top: 230 }]}
          onPress={() => setAbMotionGate((v) => !v)}
          accessibilityRole="button"
        >
          <Text style={styles.devToggleText}>
            🎯 motion gate: {abMotionGate ? 'ON (1.0 rad/s)' : 'OFF'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.devToggle, { top: 270 }]}
          onPress={() => setAbSharpFloor((v) => !v)}
          accessibilityRole="button"
        >
          <Text style={styles.devToggleText}>
            🔬 sharp floor: {abSharpFloor ? 'ON (0.6×)' : 'OFF'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.devToggle, { top: 310 }]}
          onPress={() => setAbHighFps((v) => !v)}
          accessibilityRole="button"
        >
          <Text style={styles.devToggleText}>
            🎞️ high-fps AR: {abHighFps ? 'ON' : 'OFF'}
          </Text>
        </Pressable>

        {/* ⚙️ Dev settings — the set-once knobs, kept off the camera view. */}
        <Modal
          visible={settingsOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setSettingsOpen(false)}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setSettingsOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close dev settings"
          >
            {/* Stop taps inside the card from closing the modal. */}
            <Pressable style={styles.modalCard} onPress={() => undefined}>
              <Text style={styles.modalTitle}>Dev settings</Text>
              <DevSettingRow
                label="Rect crop editor"
                help="Draggable-quad crop after capture"
                value={rectCrop}
                onValueChange={setRectCrop}
              />
              <DevSettingRow
                label="Show preview"
                help={
                  rectCrop
                    ? 'Overridden by rect crop'
                    : 'Plain preview with Retake / Confirm'
                }
                value={showPreview}
                onValueChange={setShowPreview}
              />
              <DevSettingRow
                label="Keyframe quality (1280)"
                help="OFF = 640 tiles · remounts the camera to re-pick the format"
                value={kfQuality}
                onValueChange={setKfQuality}
              />
              <Pressable
                style={styles.modalDoneBtn}
                onPress={() => setSettingsOpen(false)}
                accessibilityRole="button"
              >
                <Text style={styles.modalDoneText}>Done</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
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
  // ⚙️ Dev settings modal.
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 34,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#3a3a3c',
  },
  settingRowText: {
    flex: 1,
    paddingRight: 12,
  },
  settingLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  settingHelp: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  modalDoneBtn: {
    marginTop: 18,
    backgroundColor: '#0A84FF',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalDoneText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
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
