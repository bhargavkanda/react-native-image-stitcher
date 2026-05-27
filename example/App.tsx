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
  useFrameProcessor,
  useFrameStream,
  useKeyframeStream,
  type AcceptedKeyframe,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type FramesDroppedInfo,
  type SampledFrame,
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
  useKeyframeStream(
    useCallback((kf: AcceptedKeyframe) => {
      // eslint-disable-next-line no-console
      console.log('[example] useKeyframeStream', {
        index: kf.index,
        jpegPath: kf.jpegPath,
        rotation: kf.pose.rotation,
        translation: kf.pose.translation,
        timestamp: kf.timestamp,
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

  // v0.9.0 Layer 3 — demonstrate `useFrameStream` end-to-end.  Fires
  // at 2 Hz; encodes each sample to JPEG on the producer thread via
  // the `save_frame_as_jpeg` vc plugin (Layer 1); delivers the
  // `SampledFrame` (file path + pose + dims) to this JS-thread
  // handler.  The thumbnail at the bottom-right of the screen
  // updates ~twice per second, visually confirming the entire
  // Layer 1 + 2 + 3 pipeline works.
  //
  // Use cases this demo stands in for: live thumbnail preview,
  // sampled cloud upload, file-path OCR libraries (RN modules).
  // For worklet-native consumers (Vision/ML Kit as vc plugins,
  // TFLite ML, LiDAR depth) prefer `useThrottledFrameProcessor`
  // (Layer 2) — no JPEG roundtrip cost.
  const [latestSample, setLatestSample] = useState<SampledFrame | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _exampleFrameStream = useFrameStream(
    { sampleHz: 2, quality: 75 },
    useCallback((sample: SampledFrame) => {
      setLatestSample(sample);
      setSampleCount((c) => c + 1);
    }, []),
  );
  // Same AR-mode auto-registration pattern as `_exampleFrameProcessor`
  // above — the returned processor isn't wired through
  // `<Camera frameProcessor={...}>` because that would displace the
  // lib's first-party stitching in non-AR mode.  In AR mode the
  // worklet auto-registers via `__stitcherProxy` and fires at 2 Hz
  // via the Layer 2 throttle gate.

  const handleCapture = (result: CameraCaptureResult): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onCapture', result);
    setPreview(result);
  };

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

        {/*
          v0.9.0 Layer 3 demo overlay — live thumbnail at 2 Hz.
          Visible only when at least one sample has fired.  Bottom-
          right corner; non-interactive (`pointerEvents="none"`) so
          it doesn't intercept Camera component gestures.
        */}
        {latestSample != null && (
          <View style={styles.streamOverlay} pointerEvents="none">
            <Image
              source={{ uri: `file://${latestSample.jpegPath}` }}
              style={styles.streamThumb}
              resizeMode="cover"
              // Force RN's <Image> to re-read the file each frame —
              // the slot path is reused across rotations, so without
              // a cache-buster the image would stay stale.
              key={`${latestSample.jpegPath}-${latestSample.timestamp}`}
            />
            <Text style={styles.streamLabel}>
              useFrameStream • {sampleCount} samples
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

              <Pressable
                style={({ pressed }) => [
                  styles.previewCloseButton,
                  pressed && styles.previewCloseButtonPressed,
                ]}
                onPress={() => setPreview(null)}
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

  // ── v0.9.0 Layer 3 demo overlay ─────────────────────────────────
  streamOverlay: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    alignItems: 'flex-end',
    gap: 4,
  },
  streamThumb: {
    width: 96,
    height: 72,
    borderColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    backgroundColor: '#000',
  },
  streamLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
});


export default App;
