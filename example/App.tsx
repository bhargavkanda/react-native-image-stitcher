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

import React, { useEffect, useState } from 'react';
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
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type FramesDroppedInfo,
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

  // F8.0.c — hello-world frame processor smoke test.  Confirms the
  // vision-camera v4 + react-native-worklets-core + RN 0.84 bridgeless
  // stack actually dispatches worklets onto the camera producer
  // thread.  Logs one line per frame (`[fp-smoke] WxH px=<fmt>`),
  // visible in Metro stdout.  Only fires in non-AR mode (the SDK
  // attaches frameProcessor only to the vision-camera <Camera>; AR
  // mode uses ARCameraView which has no worklet seam).  Toggle the
  // on-screen AR switch off (or pick the 0.5x lens) to exercise.
  // Will be removed/replaced when F8.3 lands the in-SDK driver.
  // JS-side throttle.  We don't trust worklet-local timestamp math
  // (vision-camera's `frame.timestamp` unit/origin varies between
  // versions, which caused the throttle to silently never fire).
  // Cheaper than runOnJS-on-every-frame because the round-trip is
  // gated here, not on the producer thread.
  const lastLogAtRef = React.useRef(0);
  const logFrameToJS = React.useMemo(
    () => Worklets.createRunOnJS((w: number, h: number, fmt: string) => {
      const now = Date.now();
      if (now - lastLogAtRef.current < 1000) return;
      lastLogAtRef.current = now;
      // eslint-disable-next-line no-console
      console.log(`[fp-smoke] ${w}x${h} px=${fmt}`);
    }),
    [],
  );
  // F8.1.a — wire up the native Frame Processor Plugin (defined in
  // ios/Sources/RNImageStitcher/KeyframeGateFrameProcessor.mm).  The
  // plugin is registered at +load time under the name below.
  //
  // RACE-AVOIDANCE NOTE: `initFrameProcessorPlugin` can return
  // `undefined` if called before vision-camera's plugin registry has
  // finished initializing.  A naive `useMemo(..., [])` then caches
  // the undefined forever.  We retry on every render until we get a
  // non-null plugin, then freeze.
  const [cvFlowGatePlugin, setCvFlowGatePlugin] = useState<
    ReturnType<typeof VisionCameraProxy.initFrameProcessorPlugin> | null
  >(null);
  useEffect(() => {
    if (cvFlowGatePlugin != null) return;
    const p = VisionCameraProxy.initFrameProcessorPlugin(
      'cv_flow_gate_process_frame',
      {},
    );
    if (p != null) {
      // eslint-disable-next-line no-console
      console.log('[fp-plugin-init] plugin acquired');
      setCvFlowGatePlugin(p);
    }
  });
  // Separate JS-side throttle for the plugin-result log so its
  // ~30 Hz rate doesn't flood DevTools.
  const lastPluginLogAtRef = React.useRef(0);
  const logPluginResult = React.useMemo(
    () => Worklets.createRunOnJS(
      (result: Record<string, unknown> | null | undefined) => {
        const now = Date.now();
        if (now - lastPluginLogAtRef.current < 1000) return;
        lastPluginLogAtRef.current = now;
        // eslint-disable-next-line no-console
        console.log('[fp-plugin]', result);
      },
    ),
    [],
  );

  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    // No worklet-side throttle — `frame.timestamp` unit/origin
    // varies between vision-camera versions, so we rely on the
    // JS-side `lastLogAtRef` / `lastPluginLogAtRef` throttles
    // inside the runOnJS callbacks.  Cheap because the runOnJS
    // round-trip is the only cost we add per frame.
    logFrameToJS(frame.width, frame.height, String(frame.pixelFormat));
    if (cvFlowGatePlugin != null) {
      const result = cvFlowGatePlugin.call(frame, {
        yaw: 0,
        pitch: 0,
        marker: 'F8.1.a',
      });
      logPluginResult(result as Record<string, unknown> | null | undefined);
    }
  }, [logFrameToJS, cvFlowGatePlugin, logPluginResult]);

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
          frameProcessor={frameProcessor}
        />

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
});


export default App;
